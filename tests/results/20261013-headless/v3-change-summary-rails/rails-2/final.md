# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

This is a plan only. I changed nothing in `/home/user/workspace/repo`; `git status` is still clean. I ran no experiments: I set up no isolated copy with its own Postgres, Redis, cache and storage, so nothing here has been tested by running the app or its tests.

The planner tool's full output is in `/tmp/gc.txt`. I also downloaded and unpacked the Rails gem sources into `/tmp/gemsrc/<gem>-<version>` (activerecord 7.1.6 and 7.2.4; activejob 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0; actiontext 7.1.6 and 8.1.0; activesupport 8.0.5.1 and 8.1.0; railties 8.1.0; actionpack 8.0.5.1 and 8.1.0). Each finding is labelled:
- **[src]**: checked against those gem sources.
- **[cl]**: based only on the changelog or upgrade guide.
- **[test]**: an existing test would catch the problem.
- **[hidden]**: no existing test would catch it.

**The planner tool missed some defaults.** It listed no 8.1 defaults and left `Regexp.timeout` out of the 8.0 list. Both are covered below from `railties-8.1.0/lib/rails/application/configuration.rb`.

## Recommended order

Go one minor version at a time: 7.0, then 7.1, 7.2, 8.0 and 8.1. Deploy each step to the whole fleet, both Puma and Sidekiq processes, before starting the next. Keep `load_defaults 7.0` throughout, and adopt new defaults later through `config/initializers/new_framework_defaults_*.rb`. Two parts of the rollout depend on this order: the job payload format (R7) and messages and cookies (D1).

## A. Changes to make on 7.0.8.7 now (they also work on 7.0)

| # | Affected code | What breaks and when | Fix (works on 7.0) | How to check it |
|---|---|---|---|---|
| R1 | `app/models/import.rb` `apply`: `return false unless row.note.save` inside `transaction` | 7.0 rolls back on a `return` out of a transaction. 7.1 does the same with a deprecation warning. 7.2 removes that and **commits**, so the import and any notes before the failing row are saved **[cl][test]**. This breaks the promise "saves all or nothing". | Set a flag and `raise ActiveRecord::Rollback`, then return false after the block. | The `imports_controller_test` "invalid rows … saves nothing" test. Also add a model test where row 2 fails `save` but passed preview. |
| R2 | `app/models/note.rb` `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`, not a column) | Deprecated in 7.1. In 7.2 it raises `ArgumentError: …is not an attribute` when attribute methods are generated **[src: activerecord-7.2.4 attribute_methods.rb:90]**. | Define `highlight_color` and `highlight_color=` by hand, delegating to `color`. | Notes controller tests, plus a grep for the deprecation in 7.1 logs. |
| R3 | `app/models/note.rb` `enum status: {...}, _prefix: true` | The keyword form is deprecated in 7.2 and removed in 8.0 **[cl]**. | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Check that `status_ready` and `Note.statuses` still work. |
| R4 | `app/jobs/citation_enrichment_job.rb` `wait: :exponentially_longer` | Removed in 7.2. Retry then raises `"Couldn't determine a delay"`, the `retry_on` block never runs, and Sidekiq's own retries take over **[src: activejob-7.2.4 exceptions.rb]**. | Use a Proc, `->(executions) { executions**4 + 2 }`, now. Optionally switch to `:polynomially_longer` once on 7.1 or later. | `citation_enrichments_controller_test` (expects 6 requests). |
| R5 | `app/models/note.rb` `set(wait_until: reminder_epoch)`, which passes an Integer | 7.1 deprecates numeric `scheduled_at`. In 7.2 it is assigned as-is and `serialize` calls `.utc` on an Integer, so reminders can no longer be scheduled **[src: activejob-7.2.4 core.rb:120,167]**. | `wait_until: Time.at(reminder_epoch)` | Reminders controller test, and look at the Sidekiq scheduled set in a disposable environment. |
| R6 | `app/models/citation/provider.rb` uses `Rails.application.secrets.citation_provider` (`config/secrets.yml`) | Deprecated in 7.1 and removed in 7.2 **[cl]**. In production, enrichment would fail to load the provider. | Rename the file to `config/citation_provider.yml` (keep the ERB and env vars) and use `Rails.application.config_for(:citation_provider)`, whose keys are already symbols. Update the comment and docs. | Enrichment test, plus a production-mode boot with `CITATION_PROVIDER_*` set. |
| R7 | `app/views/notes/index.html.erb:12` `form_with(model: nil, …)` | Deprecated in 7.2 and removed in 8.0 **[cl]**. | Drop `model: nil`. | Notes index test (the search form). |
| R8 | `config/routes.rb` `get "/notes", "/journal", to:` | Deprecated in 8.0 and removed in 8.1 **[cl]**. | Two separate `get` lines; keep `/notes` as the route named `notes`. | Compare `bin/rails routes` before and after; request `/journal`. |
| R9 | `app/models/import.rb` receipt uses `citation[:id]` (the primary key is `doi`) | 7.2 removes `read_attribute(:id)` returning a custom primary key, so the DOI column in the receipt CSV goes blank **[cl][test]**. | `citation&.doi` | Receipt assertion in `imports_controller_test`. |
| R10 | `app/views/imports/preview.html.erb` `@import.annotations.stringify_keys` then `annotations[row.line]` (Integer) | In 8.0 `HashWithIndifferentAccess#stringify_keys` turns Integer keys into strings, so annotations disappear from the preview **[cl][test]**. | Drop `.stringify_keys`, or look up with `row.line.to_s`. | `assert_select "#line_2 dd"` in the imports test. |
| R11 | `config/initializers/cache…` none; `app/views/exports/_export.html.erb` `cache …, expires_in: export.expires_at - Time.current` | The value goes negative once an export has expired. From 7.1 a negative value is reported (logged); with `raise_on_invalid_cache_expiration_time = true` (7.1 default) the exports page raises `ArgumentError` and returns a 500. Production only, because caching is off in tests **[cl][hidden]**. | Cache only while `downloadable?`, or clamp to a minimum of 1 second. | In a disposable copy, render exports with caching on (`rails dev:cache`) and an expired export. |
| R12 | `app/models/note.rb` `next_day_reminder_at` (`reminder_at.to_time + 86_400`) | 8.1 removes the setting and always preserves the zone **[src: activesupport-8.1.0]**. The displayed offset after a DST change becomes, for example, `-05:00` instead of the documented `-04:00`. The scheduled epoch is unchanged. **[test]** (`reminders_controller_test.rb:21`) | Decide what the product should show. To keep current behavior: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Otherwise update the comment and test. | The reminders test. |

## B. Changes tied to a specific version (not possible on 7.0)

- **7.1 step: `serialize`.**
  - `serialize :tags, JSON` must become `serialize :tags, coder: JSON`. The positional form is deprecated in 7.1 and raises in 7.2 **[cl]**.
  - `serialize :preferences` should become `serialize :preferences, coder: YAML`. Stored notebook preferences are YAML, and the 7.1 default `default_column_serializer = nil` would otherwise raise.
  - The `coder:` keyword does not exist on 7.0, so make this change in the same commit that moves to 7.1.
- **7.1 step: Action Text allowlist.** `config/initializers/action_text.rb` does `ActionText::ContentHelper.allowed_tags += …`. In 7.1 `allowed_tags` starts as `nil` and is resolved lazily (`allowed_tags || sanitizer.class.allowed_tags + [...]`), so `nil + Array` raises `NoMethodError` at boot **[src: actiontext-7.1.6 content_helper.rb:8,67]**. Assign the full list explicitly: the sanitizer's allowed tags, plus `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details` and `summary`. Check that a stored note containing `<details>` still renders it, and that attachments still render.
- **7.1 step: test exceptions setting.** In `config/environments/test.rb`, `show_exceptions = false` becomes `:none`. Booleans are deprecated in 7.1 and removed in 7.2.
- **7.1 step: dependency pin.** You can remove the `concurrent-ruby 1.3.4` pin, which only exists because of a Rails 7.0 problem. Keep the `minitest ~> 5.25` pin until a Rails 8.1 patch release that supports minitest 6 has been confirmed.
- **Trix and Action Text JavaScript.** The layout loads the vendored `trix-1.3.5.js`, which works around Trix 1.3.4 bundled with 7.0. Action Text 7.1+ ships Trix 2. In 8.1, Trix moves to the `action_text-trix` dependency **[src: actiontext-8.1.0 gem metadata]**. Loading Trix 1 and Trix 2 together is probably a conflict (I have not verified this). Remove the vendored script and pin Trix from the gem. Run the browser suite (`bin/rails test:system`) and edit a note that has a link and an attachment.

## C. Rollout risks: stored data and queued jobs

- **R7-queue: decimal job arguments.** `DigestJob` receives a decimal value (the `completion` argument).
  - On 7.0 it is queued as a plain string. From 7.2 it is always wrapped by Rails' decimal serializer **[cl]**.
  - A 7.0 worker cannot read that wrapped form, and `DigestJob` has no `discard_on`, so Sidekiq keeps retrying it.
  - So: upgrade every process to 7.1 with `use_big_decimal_serializer` left off; let the queue drain past the rollback window; turn it on; only then go to 7.2.
  - After 7.2 you cannot roll back to 7.0 while digest jobs are still queued.
  - `BigDecimal(params[:completion])` in the mailer handles both forms.
- **Time zone of the digest request time.** From 7.1, a time with zone in a job argument keeps its zone **[src: activejob-7.1.6 time_with_zone_serializer.rb]**.
  - `DigestMailer` then computes `requested_at.to_date` and `all_day` in the **reader's** zone, not UTC. That changes which notes a digest covers and the date in its subject near midnight, and contradicts the comments in `user.rb` and `digest_mailer.rb` **[hidden]**.
  - 7.0 and 7.1 payloads can be read by either version.
  - Decide what is intended. To keep the UTC day, call `requested_at.utc` in the mailer; that also works on 7.0.
  - Validation to add: a reader in a non-UTC zone requests a digest near midnight UTC; assert the digest's date and which notes it includes.
- **Reminder jobs scheduled far in the future** sit in Sidekiq's schedule across every deploy.
  - Payloads from 7.1+ carry a `scheduled_at` string. 7.0 ignores it, so it is readable both ways.
  - The wrapper class name `ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper` stays the same with the built-in adapter.
  - Before any Sidekiq major upgrade, confirm that the alias for that wrapper exists.
- **Enqueue after commit (7.2 default `:default`; removed in 8.1).** In 8.1 it becomes a per-class attribute that defaults to `false` **[src: activejob-8.1.0 enqueuing.rb:53]**.
  - `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue inside the row lock, so a failed enqueue rolls back.
  - Do **not** adopt this on 7.2. Leave it unset in 8.x.
- **Sidekiq 6.5.12 / redis 4.8.1.**
  - In 8.1 the built-in adapter only warns that it is deprecated and will be removed in 8.2 **[src]**. Upgrading Sidekiq is optional for 8.1.
  - If you do move to Sidekiq 7.3+ later:
    - `redis.sadd` returns an Integer, and `0` is truthy in Ruby, so `User#request_digest` would always queue a digest.
    - `rescue Redis::BaseError` in `Notebook#request_export` would no longer catch Redis errors.
    - Strict argument checking rejects `{ format: "markdown" }` because it has symbol keys.
  - Plan that as a separate change.
  - Sidekiq 6.5.12 working with Rails 7.1+ logging and connection_pool is **unverified**. Check that the Sidekiq server boots and processes a job on each step.
- **Messages, cookies and cache (7.1 defaults).**
  - Turn on `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata` only after the whole fleet is on 7.1.
  - Action Text bodies store signed global IDs in the database. If `signed_global_ids` picks up the JSON serializer, which I think is likely but have not verified, then attachments in notes saved after you adopt it will not resolve after a rollback to 7.0.
  - The `cache_format_version 7.1` and `marshalling_format_version` caches can be thrown away; clear them on rollback.
  - The dev/test `secret_key_base` file moves to `tmp/local_secret.txt`, so local sessions and signed IDs in dev data change.
- **No database migrations are needed.** `schema.rb`'s `ActiveRecord::Schema[7.0]` header will be rewritten on the next schema dump.

## D. New framework defaults: the app keeps the old value for all of these (`load_defaults 7.0`; none are set explicitly)

**7.1**
- `raise_on_assign_to_attr_readonly`: **breaks notebook settings.** The form resubmits `slug` and the controller permits it. The error is raised on any assignment to a saved record, even with the same value **[src: readonly_attributes.rb:48-62][test]**. Before adopting it, stop permitting `:slug` on update and drop the hidden field.
- `default_column_serializer=nil`: see section B.
- `raise_on_invalid_cache_expiration_time`: see R11.
- `message_serializer`, `use_message_serializer_for_metadata`, `cache_format_version`, `marshalling_format_version`: see section C (adopt only after the whole fleet is on 7.1).
- `action_view` and `action_text` `sanitizer_vendor` HTML5: stored note HTML may come out slightly differently. Compare rendered output for notes in a disposable copy.
- `dom_testing_default_html_version :html5`: `assert_select` parsing may change. Run the suite.
- `belongs_to_required_validates_foreign_key=false`: saves one query. Safe.
- `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction=false`: the app defines no commit callbacks of its own; only Active Storage and Action Text do. Low risk.
- `generate_secure_token_on`, `sqlite3_*`, `encryption.*`: not used here.
- `query_log_tags_format`: query log tags are off.
- `precompile_filter_parameters`, `debug_exception_log_level :error`: harmless.
- `add_autoload_paths_to_load_path=false`: check `require` calls in `lib/`.
- `log_file_size`: dev and test only.
- `default_headers`: drops `X-Download-Options`.
- `use_big_decimal_serializer` (7.1, the tool lists it): see section C.
- `allow_deprecated_parameters_hash_equality`: no usage found. Safe.

**7.2**
- `postgresql_adapter_decode_dates`: **breaks the activity report** **[hidden; test may catch]**. `Notebook#daily_note_counts` does `Date.iso8601(day)`, and `select_rows` would now return a `Date`, so this raises `TypeError`. Use `day.to_date`, which works on both versions.
- `enqueue_after_transaction_commit`: do not adopt (section C).
- `validate_migration_timestamps`: existing timestamps are fine.
- `web_image_content_types` adds WebP: no variants are processed. No effect.
- `yjit=true`: optional; watch memory.

**8.0**
- `to_time_preserves_timezone=:zone`: forced in 8.1 anyway (R12).
- `strict_freshness`: `ExportDownloadsController` sends both ETag and Last-Modified. With this on, only `If-None-Match` is checked. The checksum ETag is enough, so behavior is the same.
- `Regexp.timeout ||= 1`: the CSV and DOI regexes are simple.

**8.1** (missed by the tool)
- `action_controller.escape_json_responses=false` and `active_support.escape_js_separators_in_json=false`: there are no JSON responses, so no effect.
- `action_on_path_relative_redirect=:raise`: every redirect uses a path helper. Run the suite.
- `raise_on_missing_required_finder_order_columns`: every model has a primary key. Safe.
- `action_view.render_tracker=:ruby`: fragment cache digests change once.
- `remove_hidden_field_autocomplete`: cosmetic.
- `yjit = !local`.

## E. False positives from the tool, checked against the code

`DIGEST_RESERVATIONS_KEPT_FOR` (Time addition), the `preferences.merge` match (`rewhere`), the `add_foreign_key` match (`deferrable`), the `blob.purge` match (association purge), `job.arguments.first` (finder order), the `uri.host` match (`ActiveStorage::Current#host`), `Note.connection` (a soft deprecation only), and `JSON::ParserError` (cookies). None needs action.

## F. Checks still to run (none executed)

1. Make a disposable copy with its own database (for example `margin_notes_upg_test`), a separate Redis database or port via `REDIS_URL`, its own `tmp/cache` and `tmp/storage`, and its own `CITATION_PROVIDER_URL`.
2. At each step record the resolved `Gemfile.lock`, the command, and logs under a per-variant path, for example `/tmp/upg/<version>/{Gemfile.lock,test.log,system.log,sidekiq.log}`.
3. At each step run `bundle exec rails zeitwerk:check`, `bin/rails test`, `bin/rails test:system`, and a production-mode boot with `RAILS_ENV=production SECRET_KEY_BASE=…`.
4. Run a Sidekiq process and push one `DigestJob`, one scheduled `NoteReminderJob` and one `ExportJob` through it.
5. Mixed-version check: enqueue with N+1 and perform with N (and the reverse) for `DigestJob` and `NoteReminderJob`, at 7.0↔7.1 and 7.1↔7.2.
6. Load a 7.0 database copy containing notes with attachments and `<details>`, and compare rendered note HTML before and after the 7.1 sanitizer and Trix changes.

## Questions to answer before or during the upgrade

- Which digest day is intended, UTC or the reader's day?
- Which offset should the "24 hours later" preview show?
- Does `signed_global_ids` actually switch to the JSON serializer?
- Does Sidekiq 6.5.12 work with Rails 7.1 through 8.1?
- What does Trix 2 do with HTML saved by Trix 1.3.5?
- Do the production deploy topology and the length of the rollback window allow the staged rollout in section C?

---

**Note:** The upgrade skill only plans, so Rails is still at 7.0.8.7 and the repository is unchanged. Nothing in the plan has been run or tested. Two section labels in the plan are wrong: where it refers to "R7" for job payloads it means the "R7-queue" item in section C, and "D1" means the messages and cookies item in section C.

If you want me to start implementing, I'd begin with section A. Those fixes work on 7.0, so they can land and deploy before the gem version changes. Two decisions affect them: whether the digest should cover the UTC day or the reader's own day, and which time-zone offset the "24 hours later" reminder preview should show.