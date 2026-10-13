# Rails upgrade plan for Margin Notes: 7.0.8.7 to 8.1.0

## Summary

Margin Notes does not run on Rails 8.1.0 as it is. In a disposable copy it failed at boot, and then 15 code changes were needed (including one gem pin) before all 46 tests passed on 8.1.0. All of them are listed below.

- **Most fixes can ship now, on 7.0.** Most of those changes also work on 7.0.8.7: that variant passed all 46 tests with zero deprecation warnings. Ship them on the current version first.
- **Three changes must wait for the 7.1 step.** The two `serialize` calls, the `show_exceptions` value in the test config and the `retry_on` wait option need Rails 7.1 or later. On 7.0, `coder: JSON` is silently ignored and 15 tests failed.
- **Two fixes are not portable at all.** `wait: :polynomially_longer` does not exist in 7.0, and `show_exceptions = :none` would act as "true" on 7.0.
- **Two problems lie outside the app code.** Rails 8.1's Active Support breaks with `json` 3.1.0, which Bundler picks unless pinned. And Sidekiq 6.5.12 runs on Rails' built-in adapter, which 8.1 deprecates; moving to Sidekiq 7.3.3 or later changes Redis return values the app relies on.
- **Rollout and rollback carry data risks.** Queued jobs and stored rich text can become unreadable to older servers.

The working tree at `/home/user/workspace/repo` was not changed (`git status` is clean).

## How this was checked

Every claim below is tagged:
- **[E]** executed in the disposable copy, with the log path given.
- **[S]** based on reading source or changelogs, not executed.
- **[P]** a check that is proposed and has not been run.

**Disposable setup**, all under `/tmp/mn-exp`:
- **Copies:**
  - `v70`: untouched 7.0.8.7.
  - `v81`: Rails 8.1.0 with the fixes.
  - `v70p`: the portable subset of fixes, on 7.0.8.7.
- **Database:** a private PostgreSQL 15 cluster (`pgdata`, port 55432, Unix socket in `/tmp/mn-exp`), with separate databases `mn70_test`, `mn81_test` and `mn70p_test`.
- **Redis:** a private Redis on port 56379 with persistence off, using db numbers 0, 1, 2 and 5.
- **Gems:** isolated in `BUNDLE_PATH=/tmp/mn-exp/bundle81`.
- **Storage:** each copy's own `tmp/storage` (the test service). Both services were stopped afterwards.
- **Resolved gems for 8.1** (from `bundle update rails --conservative`): `/tmp/mn-exp/logs/v81-Gemfile.lock` first, then `v81-Gemfile.lock.json2` after the json pin.
  - rails 8.1.0, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, concurrent-ruby 1.3.4, minitest 5.27.0.
  - json 3.1.0 at first, then 2.21.2 after adding `gem "json", "< 3"`.
- **Patches:** the full 8.1 diff is `/tmp/mn-exp/logs/v81-full.diff`; the portable 7.0 diff is `/tmp/mn-exp/logs/v70p-portable.diff`.
- **Command (per copy):** `DATABASE_URL=… REDIS_URL=… RAILS_ENV=test bin/rails db:prepare && bin/rails test`

**Test results** (logs in `/tmp/mn-exp/logs/`):

| Variant | Result | Log |
|---|---|---|
| 7.0.8.7, unmodified | 46 runs, 0 failures | `v70-test.log` |
| 8.1.0, unmodified | aborts at boot | `v81-test.log` |
| 8.1.0, fixes added one at a time | intermediate failures | `v81-test-2.log` to `v81-test-8.log` |
| 8.1.0, all fixes | 46 runs, 0 failures, 0 deprecations | `v81-test-9.log` |
| 7.0.8.7, portable fixes | 46 runs, 0 failures, 0 deprecations | `v70p-test-3.log` |
| 7.0.8.7, portable fixes plus `coder:` | 15 errors | `v70p-test-2.log` |

**Probe scripts** (in `/tmp/mn-exp/scripts/`, output in `/tmp/mn-exp/logs/`):
- `probe81.rb` → `probe81.log`
- `probe_readonly.rb` → `probe_readonly.log`
- `probe_sidekiq.rb` → `probe_sidekiq81.log`
- `emit_payloads.rb` and `read_payloads.rb` → `payload-70.json`, `payload-81.json`, `read-70-in-81.txt`, `read-81-in-81.txt`

## A. Required changes (breaking at some step in 7.1–8.1)

Each item lists the file, the step where it breaks, the fix, and whether the fix also works on 7.0.

1. **Action Text allowed tags: boot failure (7.1, `actiontext` 7.1 changelog).**
   - **Problem:** `config/initializers/action_text.rb` does `allowed_tags += …`. From 7.1 the value starts as `nil`, so boot fails with `NoMethodError: undefined method '+' for nil`. [E] `v81-test.log`
   - **Fix:** set the list inside `after_initialize`, starting from `ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. A tested copy is at `/tmp/mn-exp/scripts/action_text_portable.rb`.
   - **Does not work:** `sanitizer_allowed_tags` is an instance method, so calling it on the module fails [E].
   - **Works on 7.0:** yes [E].
   - **Check:** the existing "keeps collapsible excerpts and drops unsafe markup" test, run on both versions.

2. **`enum status: {...}, _prefix: true`: class load fails on 8.0 (`app/models/note.rb`).**
   - **Problem:** keyword-style `enum` is deprecated in 7.2 and removed in 8.0. [E]
   - **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
   - **Works on 7.0:** yes [E].

3. **Positional `serialize` coders (`app/models/note.rb`, `app/models/notebook.rb`).**
   - **Problem:** `serialize :tags, JSON` has to become `coder: JSON` on 7.2+. `serialize :preferences` without a coder raises once the 7.1 default `default_column_serializer = nil` is adopted.
   - **Fix:** `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
   - **Not portable:** 7.0 ignores `coder:`, and 15 tests failed with `undefined method 'any?' for String` [E] `v70p-test-2.log`. Ship this with the 7.1 bump; 7.1 accepts both forms [S].
   - **Stored data:** YAML that 7.0 wrote reads back unchanged on 8.1 with `coder: YAML` (`{"export_heading"=>"Old"}`) [E] `probe81.log`. JSON tags round-trip in the tests [E].
   - **Data check [P]:** 7.0 and 7.1+ both use safe YAML loading. Before deploying, run a query against production to confirm no `notebooks.preferences` value contains `!ruby/` tags.

4. **`alias_attribute :highlight_color, :color` on a `store_accessor` (`app/models/note.rb`).**
   - **Problem:** aliasing something that is not a real attribute is deprecated in 7.1 and removed in 7.2. It is used by `notes/_form.html.erb`, `notes/show.html.erb` and `NotesController#note_params`.
   - **Fix:** define plain `highlight_color` and `highlight_color=` methods.
   - **Works on 7.0:** yes [E]. The note edit test covers the round trip.

5. **`Rails.application.secrets`: removed in 7.2 (`app/models/citation/provider.rb`).**
   - **Problem:** used in the provider and in `test/controllers/citation_enrichments_controller_test.rb` (`with_provider`). [E]
   - **Fix:** in `config/application.rb`, set `config.x.citation_provider = config_for(:secrets)[:citation_provider]`; read and stub `Rails.configuration.x.citation_provider` instead.
   - **Works on 7.0:** yes [E]. Production boot on 8.1 printed `{:url=>nil, :user=>nil, :password=>nil}` with no environment variables set [E].
   - **Optional:** consider renaming `config/secrets.yml` (for example to `citation_provider.yml`) to avoid confusion.
   - **Check:** the "provider credentials from the environment reach the server unchanged" test.

6. **`get "/notes", "/journal", to: ...`: two paths in one route (`config/routes.rb:18`).**
   - **Problem:** deprecated in 8.0 and removed in 8.1, where routes fail to load. The gem-changes tool did not flag this. [E] `v81-test-5.log`
   - **Fix:** two separate `get` lines. Route names stay `notes` and `journal` (confirmed with `rails routes` on 7.0) [E].
   - **Works on 7.0:** yes [E].

7. **`where(notebooks: @notebook)` in `NotesController#index`.**
   - **Problem:** referring to a singular association by its plural name was removed in 7.2. The query fails with `PG::UndefinedColumn notes.notebooks` [E].
   - **Fix:** `where(notebook: @notebook)`.
   - **Works on 7.0:** yes [E].

8. **`form_with(model: nil, ...)` in `app/views/notes/index.html.erb`.**
   - **Problem:** removed in 8.0; every note list page raises [E].
   - **Fix:** drop `model: nil`.
   - **Works on 7.0:** yes [E].

9. **`fragments.sum` of strings in `Export#generate`.**
   - **Problem:** Rails' own `Enumerable#sum` override was removed in 7.1, giving `TypeError` [E]. It already prints deprecation warnings on 7.0 in `v70-test.log`.
   - **Fix:** `fragments.join`.
   - **Works on 7.0:** yes [E].
   - **Rollout:** an `ExportJob` that runs on a 7.1+ worker before this fix ships fails and gets retried by Sidekiq.

10. **`return false` inside `transaction` in `Import#apply`: silent partial import.**
    - **Problem:** 7.1 can commit on `return`; 8.0 removed the setting, so it always commits. On 8.1 the original code returned `false` but saved 1 import and 1 note [E] `probe81.log`.
    - **Fix:** `raise ActiveRecord::Rollback` inside the block, ending the block with `true` and returning `transaction { … } || false`. On 8.1 this gave `false` with nothing saved [E].
    - **Works on 7.0:** yes [E].
    - **Why tests miss it:** the "applying saves nothing" test passed only because the fix was in place before it ran. Add a model test that applies a CSV with one good and one bad row and asserts no records are created.

11. **`HashWithIndifferentAccess#stringify_keys` in `app/views/imports/preview.html.erb`.**
    - **Problem:** `@import.annotations.stringify_keys` is then looked up with integer `row.line`. 8.0 turns every key into a string, so annotations silently disappear from previews [E].
    - **Fix:** drop `.stringify_keys`.
    - **Works on 7.0:** yes [E].

12. **`citation[:id]` in `Import#receipt`.**
    - **Problem:** citations use `doi` as their primary key. 7.1 deprecates `read_attribute(:id)` returning a custom primary key, and 7.2 removes it, so the value is `nil` [E]. Receipt CSVs would have an empty DOI column.
    - **Fix:** `citation&.doi`.
    - **Works on 7.0:** yes [E].

13. **`retry_on ..., wait: :exponentially_longer` in `app/jobs/citation_enrichment_job.rb`.**
    - **Problem:** deprecated in 7.1 and removed in 7.2.
    - **Fix:** `:polynomially_longer` (same formula), but this needs 7.1+.
    - **On 7.0:** either change it in the 7.1 deploy, or use a lambda such as `->(executions) { executions**4 + 2 }`. The lambda drops the jitter [S].
    - **Rollout:** jobs already waiting to retry carry their wait time in Sidekiq, so they are not affected [S].

14. **`NoteReminderJob.set(wait_until: reminder_epoch)` with an Integer (`Note#schedule_reminder`).**
    - **Problem:** a numeric `scheduled_at` is deprecated in 7.1 and removed in 7.2.
    - **Fix:** `wait_until: Time.at(reminder_epoch)`.
    - **Works on 7.0:** yes [E].
    - **Check:** the reminder tests, plus a probe that a real Sidekiq enqueue goes into the scheduled set [E] `probe_sidekiq81.log`.

15. **`config.action_dispatch.show_exceptions = false` in `config/environments/test.rb`.**
    - **Problem:** booleans are removed in 7.2.
    - **Fix:** `:none`, but only from 7.1 on. On 7.0, `:none` counts as "true".
    - **Note:** 7.1 changed the test-environment default to `:rescuable`; keep `:none` so the current assertions keep working.

16. **Gem: `json` 3.1.0 is picked with Rails 8.1.0.**
    - **Problem:** Active Support 8.1.0's `JSON.decode` calls `::JSON.parse(json, options)` with two positional arguments, and json 3.1.0 rejects that. Every JSON-serialized column and JSON decode fails [E] `v81-test-6.log`.
    - **Fix:** pin `gem "json", "< 3"` (resolved to 2.21.2) until a Rails release fixes this.

## B. Behavior changes that tests caught on 8.1 (require a product decision)

17. **Digest day, `DigestJob` and `DigestMailer`: changes on 7.0.9 as well.**
    - **What changed:** 7.0.9 and 7.1+ keep the time zone of `TimeWithZone` job arguments. The mailer's `@date` and `all_day` now use the reader's zone instead of UTC. The test shows "October 04" where "October 05" is expected [E] `v81-test-8.log`.
    - **Queued payloads, cross-read:**
      - 7.0 payloads (no `time_zone` key) read on 8.1 still come back in UTC.
      - 8.1 payloads come back as `America/New_York` [E] `read-70-in-81.txt` / `read-81-in-81.txt`.
    - **Fix:** in the mailer, `requested_at = requested_at.in_time_zone("UTC")`. This keeps the documented "UTC day" behavior and makes old and new payloads agree. Works on 7.0 [E].
    - **Alternative:** if per-reader days are wanted instead, change the UI text and the Redis reservation key together.

18. **`Note#next_day_reminder_at` and `to_time`.**
    - **What changed:** 8.0 adds `:zone` and 8.1 removes the old offset-preserving behavior. The time shown for "next day" across a daylight saving change moves from `09:00-04:00` to `08:00-05:00` [E]. The stored epoch is unchanged because the code calls `.to_i` [S, consistent with tests passing].
    - **To keep current behavior:** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. Works on 7.0 [E].
    - **Alternative:** accept the new wall-clock display and update the comment and the test.

## C. Outside Rails but forced by it

19. **Sidekiq 6.5.12 and Rails' built-in adapter.**
    - **Status:** the built-in adapter still works on 8.1.0. A real enqueue and execute through isolated Redis succeeded, with a deprecation saying it is removed in 8.2 [E] `probe_sidekiq81.log`. Moving to Sidekiq ≥ 7.3.3 can be a separate step, but it brings these changes:
    - **(a) `User#request_digest` [S].** It relies on `redis.sadd` returning a boolean. Sidekiq 7 uses redis-client, where `sadd` returns `1` or `0`. In Ruby `0` counts as true, so the once-per-day limit would silently stop working. Fix: `redis.call("SADD", key, id) == 1` (or `.positive?`).
    - **(b) `Notebook#request_export` [S].** It rescues `Redis::BaseError`; with Sidekiq 7 this must become `RedisClient::Error`.
    - **(c) `ExportJob.perform_async(export.id, { format: "markdown" })` [E for the warning, S for the 7.0 behavior].** The symbol key triggers the strict-args warning today ("will raise an error in Sidekiq 7.0", seen in every test log). Use `{ "format" => "markdown" }` now; that works on the current version.
    - **(d) Job wrapper class [S, P].** Sidekiq's own adapter uses a different job wrapper class. Confirm that jobs already in Redis under `ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper` still run.

20. **Puma 5 and Rack 3 [S].**
    - **Status:** the resolution stayed on rack 2.2.24 because sidekiq 6.5 pins rack ~> 2.
    - **Risk:** after a Sidekiq 7 upgrade, Bundler may pick rack 3, which Puma 5 does not support. Move to Puma ≥ 6 in the same step.
    - **Test helper:** check that `test/controllers/citation_enrichments_controller_test.rb` (which uses `Puma::Server.new(app, Puma::Events.strings)`) still works, since that API changed in Puma 6 [P].

21. **Pins that can be revisited after 7.1:**
    - `concurrent-ruby 1.3.4` was pinned for a 7.0 logger bug.
    - `minitest ~> 5.25` still works (5.27 resolved).
    - `csv` needs to be added to the Gemfile before any Ruby 3.4 move (warning in the logs).

## D. Framework defaults by release

The app uses `load_defaults 7.0` and sets none of the settings below explicitly, so it keeps every old value until it raises `load_defaults` or sets one by hand.

### 7.1 (7.1.6)

| Setting | Effect if adopted |
|---|---|
| `allow_deprecated_parameters_hash_equality=false` | No `Parameters == Hash` comparisons found. No effect [S]. |
| encryption `hash_digest_class` / `support_sha1…` | No `encrypts` in the models. No effect [S]. |
| `run_commit_callbacks_on_first_saved_instances_in_transaction=false`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined` | No app `after_commit` callbacks; only Active Storage and Action Text internals. Low risk [S]. |
| `sqlite3_adapter_strict_strings_by_default` | The app uses PostgreSQL. No effect. |
| `allow_deprecated_singular_associations_name=false` | Breaks `NotesController#index`; fixed by item 7. Removed in 7.2 anyway. |
| `use_big_decimal_serializer=true` | `User#request_digest` passes a BigDecimal to `DigestJob`. Under 7.2+ this is always on (8.1 writes `BigDecimalSerializer`). 7.0 workers fail with `Serializer … BigDecimalSerializer is not known` [E]. Old string payloads still work on 8.1 because the mailer calls `BigDecimal(...)` [E]. |
| `raise_on_invalid_cache_expiration_time` | No app `Rails.cache` writes. No effect [S]. |
| `query_log_tags_format` | Query log tags are not enabled. No effect. |
| `message_serializer=:json_allow_marshal`, `use_message_serializer_for_metadata=true` | Affects message verifiers, which includes signed GlobalIDs stored inside Action Text bodies (attachment sgids) and Active Storage signed blob URLs [S]. New-format sgids written into rich text would not resolve on 7.0 after a rollback (not executed). Enable only once rolling back to 7.0 is ruled out. |
| `log_file_size` | Development and test only. |
| `raise_on_assign_to_attr_readonly=true` | **Breaks notebook settings.** `notebooks/_form.html.erb` resubmits a hidden `slug` and `NotebooksController` permits `:slug`. Even an unchanged value raises `ReadonlyAttributeError` [E] `probe_readonly.log`. Before adopting, remove the hidden field and drop `:slug` from `permit` (works on 7.0). |
| `belongs_to_required_validates_foreign_key=false` | Fewer queries. An invalid `notebook_id` would hit the foreign-key constraint instead of a validation error. Low risk [S]. |
| `precompile_filter_parameters` | Performance only. |
| `default_column_serializer=nil` | Breaks `Notebook` unless item 3 has shipped. |
| `marshalling_format_version=7.1` | No app caching of records found. Enable on a later deploy, as the upgrade guide advises for rolling deploys. |
| `commit_transaction_on_non_local_return` | Item 10. Mandatory from 8.0. |
| `generate_secure_token_on` | No `has_secure_token`. No effect. |
| `action_view` / `action_text` `sanitizer_vendor` HTML5 | Changes the sanitized HTML of stored rich text and `simple_format` output (`notes/show.html.erb`). Item 1's initializer follows whichever sanitizer class is active. [P]: rerun the unsafe-markup test and compare rendered output of a sample of production bodies. |
| `debug_exception_log_level=:error` | Log level only. |
| `dom_testing_default_html_version=:html5` | Can change `assert_select` text matching (for example the `<b>` and `&` annotations in the import tests). [P]: rerun the suite. |

### 7.2 (7.2.4)

| Setting | Effect if adopted |
|---|---|
| `enqueue_after_transaction_commit` | **Do not adopt.** `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue under the row lock so a failed enqueue rolls back. With deferral, a Redis failure would leave a citation stuck as `pending` with no job, and `request_enrichment` refuses while pending [S]. The setting is removed in 8.1 and per-job deferral defaults to off, so leave it unset. |
| `web_image_content_types` adds webp | Affects only how images are represented; no variants are used. Minor. |
| `validate_migration_timestamps` | Migrations are dated 2026-10-11, which is in the past as of today. OK [S]. |
| `postgresql_adapter_decode_dates=true` | **Breaks `Notebook#daily_note_counts`** (`TypeError: no implicit conversion of Date into String`) [E] `probe81.log`. Fix before adopting: `Date.iso8601(day.to_s)`, or accept Date values. Portable [S]; not run on 7.0. |
| `yjit=true` | Ruby 3.3.6. Uses more memory in production. |

### 8.0 (8.0.5.1)

| Setting | Effect if adopted |
|---|---|
| `to_time_preserves_timezone=:zone` | Item 18. Forced in 8.1 regardless of this setting. |
| `strict_freshness=true` | `ExportDownloadsController` uses `stale?(etag: blob.checksum, last_modified:)`. With both headers sent, only the ETag counts. The ETag is the content checksum, so this is safe to adopt [S]. |
| `Regexp.timeout = 1` (in `load_defaults "8.0"`; the tool did not list it) | DOI regex and CSV parsing on small inputs. Low risk [S]. |

### 8.1 (8.1.0)

The gem-changes tool listed no 8.1 defaults. These come from the railties source.

| Setting | Effect if adopted |
|---|---|
| `yjit = !Rails.env.local?` | Production only. |
| `action_controller.escape_json_responses=false` | Jbuilder or JSON output; low risk. [P]: check any JSON endpoints. |
| `action_on_path_relative_redirect=:raise` | Every `redirect_to` uses `_path` helpers, which give absolute paths. No effect [S]. |
| `raise_on_missing_required_finder_order_columns` | Only matters for models without an `id` ordering column, such as `Citation`, if `.first` or `.last` is used without an order. None found in `app/` [S]. |
| `escape_js_separators_in_json=false`, `render_tracker=:ruby`, `remove_hidden_field_autocomplete=true` | Minor. The last one changes the markup of `form.hidden_field :csv` and `:slug`. |

## E. Rollout sequence and mixed-version risks

1. **Deploy on 7.0.8.7: everything portable.**
   - Items 1, 2, 4–12, 14, 17 and 18, plus the string-keyed `ExportJob` arguments and the notebook slug form fix.
   - Verified diff: `/tmp/mn-exp/logs/v70p-portable.diff` (passes on 7.0, zero deprecations). It is safe to roll back.

2. **Deploy 7.1.6 with `load_defaults 7.0`.** Ship items 3, 13 and 15. The BigDecimal serializer stays off, so jobs remain readable by 7.0.
   - **Rollback hazard:** stored data written with `coder: YAML` / JSON keeps the same format, so it is readable on 7.0 [S].
   - **Next:** turn on the 7.1 defaults one at a time, using a `new_framework_defaults_7_1.rb` file. Enable `message_serializer`, `use_message_serializer_for_metadata` and `marshalling_format_version` last, and only after rolling back to 7.0 is ruled out.

3. **Deploy 7.2.4.** Rails now always writes `BigDecimalSerializer` payloads.
   - **Risks:** during a rolling deploy, 7.1 workers fail any `DigestJob` enqueued by 7.2 web servers. After rollback, queued digests fail in the same way. Mitigate by:
     - draining or pausing the `default` queue during the switch, or
     - passing `reading_completion.to_s` from `User#request_digest` before step 3 (works on all versions, because the mailer already calls `BigDecimal(...)`).
   - **Defaults:** keep `enqueue_after_transaction_commit` unset. Fix `daily_note_counts` before turning on `decode_dates`.

4. **Deploy 8.0.5.1.** Nothing new is required if steps 1–3 are done (`enum`, `form_with` nil and multi-path routes are already fixed).

5. **Deploy 8.1.0 with `json < 3`.** Then upgrade Sidekiq to ≥ 7.3.3 and Puma to ≥ 6 as a separate deploy, with item 19's code changes.
   - **Scheduled reminders:** already in Sidekiq's scheduled set, they deserialize fine on 8.1 [E for one payload]. The `scheduled_at` key that 8.1 adds is ignored by older readers [E: 7.0 read an 8.1 reminder payload successfully].

## F. Proposed checks not yet run

- Run the browser suite (`bin/rails test:system`) at each step. Not run.
- Apply each 7.1, 7.2 and 8.1 default on its own in the disposable copy and rerun the tests, especially the HTML5 sanitizer and dom-testing settings.
- Make the rollback check concrete: with `use_message_serializer_for_metadata` on, create a rich text note with an attachment, then read it on 7.0.
- Run the Sidekiq 7 / Puma 6 variant of the bundle, with probes for `sadd` return values and `RedisClient::Error`.
- Run the 7.1.6 and 7.2.4 intermediate bundles. Only the two endpoints (7.0.8.7 and 8.1.0) were run; findings about the intermediate releases come from changelogs and these two runs.
- Run a production `assets:precompile` on 8.1 (sprockets-rails 3.5.2, importmap 2.2.3, turbo-rails 2.0.12). Not run.
- Production boot on 8.1 logs that `image_processing` is missing. Consider `config.active_storage.variant_processor = :disabled`, since no variants are used.

## Open questions

- Should the "next day" reminder keep its fixed-offset display (item 18) or switch to wall-clock time?
- Should digests stay on the UTC day (item 17)? The UI says UTC, so the plan assumes yes.
- Do production `preferences` values contain only plain YAML hashes?
- What is the production cache store? `marshalling_format_version` only matters if records are cached.

---

**Note:** I only made a plan. Your repo is unchanged. The jump is from Rails 7.0.8.7 to 8.1.0. All fixes have been tested in throwaway copies under `/tmp/mn-exp`. My suggested first step is to apply `/tmp/mn-exp/logs/v70p-portable.diff` on the current 7.0.8.7, which passes all 46 tests there. Tell me if you want me to do that, or answer the open questions so I can start the full upgrade.