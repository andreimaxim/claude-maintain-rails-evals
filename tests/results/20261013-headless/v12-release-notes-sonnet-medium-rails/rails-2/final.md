Here is the planner's full plan. I haven't changed anything in the repo.

# Upgrade plan: Rails 7.0.8.7 to 8.1.0 for Margin Notes

Rails 8.1.0 does not boot against this application as it stands. After the required changes below, the suite passes 46 of 46 on Rails 8.1.0, up from 0 booting and 23 failing. The changes also pass 46 of 46 on 7.0.8.7, except three that only work on the new version.

The planner did not modify the working repository, and `git status` there is clean. The Rails 8.1.0 run does not cover the browser editor (no Chrome/Chromium here), production mail or storage, or the Sidekiq 7 and redis 5 path.

## How this was tested

All experiments ran in disposable copies under `/tmp/plan/run`.

- **Resources.** Each copy had its own Postgres databases (`plan_test_70`, `plan_test_81`, `plan_test_81d`, `plan_dev`), now dropped. They shared a private Redis on port 6391, now stopped, and a stand-in citation provider on port 9394. Each copy also had its own `tmp` and `storage`.
- **Variants.**
  - `app7` is the untouched 7.0.8.7 baseline: 46 runs, 325 assertions, 0 failures.
  - `app81` is 8.1.0 with all required repairs. `app7prep` is 7.0.8.7 with the version-neutral repairs. `app81d` is 8.1.0 with `load_defaults 8.1` plus the adoption fixes.
- **Dependencies.**
  - Starting point was `bundle update rails`, then `gem "json", "< 3"` (see finding 1).
  - Rails gems 8.1.0. action_text-trix 2.1.19, bigdecimal 4.1.3, rack-session 1.0.2, rackup 1.0.1.
  - Unchanged: rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, pg 1.6.0, faraday 1.10.4, pagy 8.6.3. `Gemfile.lock` for the final state is `/tmp/plan/Gemfile.lock.8.1.0-json2`.
  - Rack stays on 2.x because sidekiq 6.5.12 requires `rack ~> 2.0` and `redis < 5`. Rack 3 behavior was therefore not exercised.
- **Evidence.**
  - Change index: `/tmp/plan/changes.txt`.
  - Test logs: `/tmp/plan/base_test.log`, `/tmp/plan/t81_*.log`, `/tmp/plan/t70_prep.log`.
  - Defaults runs: `/tmp/plan/t81_defaults_*.log`.
  - Sidekiq runs: `/tmp/plan/sidekiq_*.log`.
  - Repairs diff: `/tmp/plan/upgrade_experiment.diff`. It excludes the new `config/citation_provider.yml` and the lockfile.
  - Probe scripts: `/tmp/plan/scripts`.

## Required changes

Every item below was reproduced on 8.1.0. "7.0 ok" means the same edit passed 46/46 on 7.0.8.7, so it can ship ahead of the upgrade.

1. **json 3.x breaks `ActiveSupport::JSON.decode` (executed).**
   - What happens: a plain `bundle update rails` resolves json 3.1.0. Rails 8.1.0 then calls `JSON.parse(json, options)` positionally and fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`. It surfaced on the first `serialize ... coder: JSON` rollback and the first JSON column load.
   - Repair: pin `gem "json", "< 3"` (resolved 2.21.2), or target a later 8.1.x patch (unverified).

2. **`ActionText::ContentHelper.allowed_tags += ...` fails at boot (executed).**
   - Affected code: `config/initializers/action_text.rb`.
   - What happens: `allowed_tags` is now `nil` by default, so boot fails with `NoMethodError: undefined method '+' for nil`.
   - Repair: assign the full list explicitly:
     `ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`
   - 7.0 ok. It equals the 7.0 default plus `details` and `summary`.

3. **`enum status: {...}, _prefix: true` was removed.**
   - Affected code: `app/models/note.rb`.
   - What happens: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. 7.0 ok.

4. **`serialize :tags, JSON` was removed.**
   - Affected code: `app/models/note.rb`.
   - What happens: `ArgumentError: wrong number of arguments (given 2, expected 1)`.
   - Repair: `serialize :tags, coder: JSON`.
   - Not 7.0-safe. On 7.0 the keyword is silently ignored, the column is read as YAML, and the notes index crashes with `undefined method 'any?' for an instance of String`. This one must ship with the upgrade.
   - Stored data is unchanged. Rows written by 7.0 and by 8.1 are byte-identical (`["a","b \u0026 c"]`).

5. **`alias_attribute :highlight_color, :color` on a `store_accessor` key is rejected.**
   - What happens: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`.
   - Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. 7.0 ok.
   - Check that nothing needed `highlight_color_changed?` and similar methods. The app only uses read, write, strong params and form fields.

6. **`get "/notes", "/journal", to:` no longer accepts multiple paths.**
   - Affected code: `config/routes.rb`.
   - What happens: `ArgumentError: Wrong number of arguments (expect 1, got 2)`.
   - Repair: two `get` lines, one per path. The `notes` and `journal` route names and paths are identical to before (diffed `rails routes`). 7.0 ok.

7. **`fragments.sum` over strings fails.**
   - Affected code: `Export#generate`.
   - What happens: `TypeError: String can't be coerced into Integer`. This was already deprecated on 7.0 and showed up in the baseline logs.
   - Repair: `fragments.join`. 7.0 ok.

8. **`wait: :exponentially_longer` was removed.**
   - Affected code: `CitationEnrichmentJob`.
   - What happens: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised when `request_enrichment` queues the job.
   - Repair: `wait: :polynomially_longer`, which uses the same formula.
   - Not 7.0-safe. Use `->(executions) { executions**4 + 2 }` if it must ship earlier.
   - Retries already stored in Redis carry no wait symbol, so they are unaffected.

9. **`Rails.application.secrets` was removed (Rails 7.2).**
   - Affected code: `Citation::Provider` and `config/secrets.yml`. The provider test helper and its credentials test also use it. `secrets.yml` holds nothing else.
   - What happens: `NoMethodError: undefined method 'secrets'`.
   - Repair: move the settings to `config/citation_provider.yml`. Keep the ERB `.to_json` quoting, because it is what keeps `"00123"` and `"sample: value # keep"` intact. Expose them as `config.x.citation_provider = config_for(:citation_provider)` and read `Rails.configuration.x.citation_provider.to_h`. Update the test helper the same way. 7.0 ok, and the env-credentials test passes.
   - Production `secret_key_base` is unaffected. Both versions read `ENV["SECRET_KEY_BASE"]`, then credentials (source-checked). The repo has no `config/master.key`, so confirm production provides one of the two.

10. **`form_with model: nil` raises.**
    - Affected code: the search form in `app/views/notes/index.html.erb`.
    - What happens: `ActionView::Template::Error: Passed nil to the :model argument`. The notes list returns 500.
    - Repair: drop `model: nil`. Field names are unchanged. 7.0 ok.

11. **`where(notebooks: @notebook)` relied on a singular-association alias that no longer works.**
    - Affected code: `NotesController#index`.
    - What happens: `PG::UndefinedColumn: column notes.notebooks does not exist` when filtering by notebook.
    - Repair: `where(notebook: @notebook)`. The query is equivalent. 7.0 ok.

12. **`NoteReminderJob.set(wait_until: <Integer>)` fails.**
    - Affected code: `Note#schedule_reminder`.
    - What happens: `NoMethodError: undefined method 'utc' for an instance of Integer`.
    - Repair: `wait_until: Time.at(reminder_epoch)`. 7.0 ok.
    - A real Sidekiq run on 8.1 scheduled and delivered the reminder.

13. **`return` inside `transaction` now commits.** This is silent data corruption.
    - Affected code: `Import#apply`, which promises "saves nothing" if any row fails.
    - What happens: with one invalid row, the import and its valid rows are committed. The test shows `record_counts` going from `[0,3,0,1]` to `[1,4,1,2]`. On 7.0 it rolled back.
    - Repair:
      ```ruby
      transaction do
        save!
        rows.all? { |row| row.note.save } || raise(ActiveRecord::Rollback)
      end || false
      ```
    - 7.0 ok. Creation and update paths still work. No other `return` or `break` inside a transaction or `with_lock` block was found.

14. **`citation[:id]` returns nil for a string primary key.**
    - Affected code: `Import#receipt` on `Citation`, whose primary key is `doi`.
    - What happens: the receipt CSV silently loses its DOI column ("On idleness," instead of "On idleness,10.1000/Essays.1").
    - Repair: `citation.doi`. 7.0 ok.

15. **`HashWithIndifferentAccess#stringify_keys` now converts integer keys.**
    - Affected code: the preview view, `annotations = @import.annotations.stringify_keys`.
    - What happens: `annotations[row.line]` with an Integer key finds nothing, so the Annotation row disappears from the import preview with no error.
    - Repair: remove `.stringify_keys`. 7.0 ok.

16. **`to_time` now follows the zone's DST rules.**
    - Affected code: `Note#next_day_reminder_at`, which uses `reminder_at.to_time + 86_400`.
    - What happens: the "24 hours later" preview across the 1 Nov 2026 DST end shows `08:00 -05:00` instead of the documented `09:00 -04:00`. The instant is the same, and `postpone_reminder` stores the same epoch. Only the displayed offset changes. The reminders test caught it.
    - Repair: `reminder_at.utc.getlocal(reminder_at.utc_offset) + 86_400`. This keeps today's behavior on both versions. 7.0 ok.
    - Question for you: should the preview show true local time instead? If so, the test and the code comment should change.
    - `config.active_support.to_time_preserves_timezone` is also deprecated, and `load_defaults 7.0` now triggers that warning at boot.

17. **`DigestMailer` covers a different day.**
    - What happens: Active Job 8.1 keeps the reader's time zone on `TimeWithZone` arguments. The enqueued argument now carries `"time_zone":"America/New_York"`. The digest subject and `all_day` window move from the UTC day to the reader's local day. The test showed "October 04" where "October 05" was expected.
    - Repair: `requested_at = requested_at.utc` before `@date = requested_at.to_date` and `all_day`. This keeps the documented UTC-day behavior for both new and old payloads. 7.0 ok.

18. **Test environment: `show_exceptions = false` no longer means "raise".**
    - Affected code: `config/environments/test.rb`.
    - What happens: `RecordNotFound` is no longer raised, so several authorization tests fail.
    - Repair: `config.action_dispatch.show_exceptions = :none`.
    - Not 7.0-safe, because on 7.0 `:none` is truthy and exceptions would be rendered. Ship it with the upgrade.

19. **Mixed-version rollout: DigestJob.**
    - What happens: 8.1 serializes the BigDecimal completion as `ActiveJob::Serializers::BigDecimalSerializer`. A job enqueued by 8.1 and run by a 7.0 worker fails with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`, and goes to the retry set. Jobs queued by 7.0 run fine on 8.1.
    - Repair: in `User#request_digest`, pass `reading_completion.to_s("F")`. The payload is then the plain string `"1.0"`, as 7.0 produces. The mailer's `BigDecimal(params[:completion])` already accepts it.
    - Enqueuing from 8.1 with this change, a 7.0 Sidekiq worker processed it (`done`, retry set empty).
    - 7.0 ok, and it should ship before the upgrade. The `requested_at` payload only adds a key that 7.0 ignores.

## Executed runtime checks

- **Production-style boot.** `zeitwerk:check` passes. A production-mode boot with eager load works, and `assets:precompile` works.
- **Real jobs on 8.1.0 with Sidekiq 6.5.12 and redis 4.8.1.** The reminder, citation enrichment, digest and export jobs all ran. The same mix of jobs queued by 7.0 and run on 8.1 also ran, and the 8.1 to 7.0 direction works apart from finding 19.
- **Failed enqueue.** `Note#schedule_reminder` with a failing Redis push raises `Redis::CannotConnectError` and leaves `reminder_job_id` and `reminder_epoch` unchanged. This is the same on 7.0, 8.1, and 8.1 with `load_defaults 7.2`.
- **Stored data.** `serialize :preferences` YAML, the `tags` column and the `settings` jsonb all read and write unchanged.
- **Rendered output.** Note show, index and edit pages for a note with an image attachment, `details`, a table and an `<hr>` attachment render the same on both versions, apart from Trix serialization (`open=""`, `<tbody>`, quoting) and an added `content` attribute on the horizontal-rule attachment.
- **Dev and test secret file.** Rails 8.1 reads `tmp/local_secret.txt` instead of `tmp/development_secret.txt`. Without copying the file, all existing attachments render as the missing-attachment placeholder and signed GlobalIDs stop verifying. This is dev and test only. Production is unaffected.

## Source-based or unverified

- **Trix and the layout.**
  - The layout loads a vendored `trix-1.3.5.js`, with a comment saying it works around a 7.0 bug in the bundled Trix. 8.1 bundles Trix 2.1.19 through the action_text-trix gem.
  - `app/assets/stylesheets/actiontext.css` still does `require trix`. That now resolves to the Trix 2 stylesheet, while the JS stays 1.3.5.
  - Assets compile, but whether editing, attachments and the toolbar work with that mix is unverified. No browser was available.
  - Recommendation: drop the vendored 1.3.5 and load the gem's Trix. Then run `bin/rails test:system` and a manual attach, link and `details` round trip.
- **Sidekiq adapter deprecation.** The built-in Sidekiq adapter is deprecated and will be removed in Rails 8.2. The fix is Sidekiq 7.3.3 or later, which pulls in redis 5 and changes the Redis API. After that:
  - `Sidekiq.redis { |r| r.sadd(...) }` in `User#request_digest` returns an Integer, so `if sadd` becomes always true.
  - `Notebook#request_export` rescues `Redis::BaseError`, which Sidekiq 7 no longer raises.
  - Do not bundle this into the Rails upgrade.
- **Test deprecations.** `:unprocessable_entity` is fine on Rack 2.2.
- **Production.** Not run. The Postgres, file-store, and Redis setup was only exercised in a copy, and `cache_classes` and `to_time` behave the same there.
- **Rolling back.** The only rolling-deploy hazard found is finding 19. Retries stored in Redis do not depend on Rails version.
- **The pinned json 2.21.2.** Compatible with 8.1.0 here, but not checked against later 8.1.x patches.

## New defaults, by release (app keeps `load_defaults 7.0`, so all of these keep their old values)

The planner ran each cumulative `load_defaults` in the 8.1 copy after findings 4 and 5 (plus `coder: YAML` for `Notebook#preferences`). The Rails 8.1 source blocks are listed too, because the change index omitted the 8.1 defaults and a few others.

**7.1**
- `raise_on_assign_to_attr_readonly = true`: `NotebooksController#update` raises `ReadonlyAttributeError: slug`, because the form resubmits the slug. Remove `:slug` from the permit list (the hidden field then does nothing).
- `raise_on_invalid_cache_expiration_time = true`: the export availability fragment, `cache [export, "availability"], expires_in: export.expires_at - Time.current`, raises `Cache expiration time is invalid, cannot be negative: -60.0` once the export has expired. Use `expires_in: [export.expires_at - Time.current, 1].max`. Wrapping the fragment in `cache_if` instead breaks the existing stale-cache test.
- `default_column_serializer = nil`: `serialize :preferences` fails with `missing keyword: :coder`. Change it to `coder: YAML`, which is safe to do on 8.1 now.
- `commit_transaction_on_non_local_return = true`: harmless once finding 13 is done. 8.1 already commits regardless of the setting.
- `active_job.use_big_decimal_serializer = true`: 8.1 already applies it (finding 19).
- `action_dispatch.default_headers` and `Referrer-Policy`, `cache_format_version = 7.1`, `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` and `marshalling_format_version = 7.1`: each needs a two-step rolling deploy if sessions or caches are shared across versions.
- Also in the 7.1 block: sanitizer vendor changes to HTML5, `dom_testing_default_html_version = :html5`, `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `generate_secure_token_on`, `after_commit` callback order, `belongs_to_required_validates_foreign_key = false`, the encryption digest settings, `query_log_tags_format` and `run_commit_callbacks_on_first_saved_instances_in_transaction`.
  - No visible effect on this app. It uses no encryption, secure tokens, callbacks or SQLite.
  - The HTML5 sanitizer could change stored note HTML on render; this was not compared.
- `allow_deprecated_parameters_hash_equality` and `allow_deprecated_singular_associations_name`: adopting them would have turned finding 11 into an error even earlier.

**7.2**
- `postgresql_adapter_decode_dates = true`: `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String`. Use `Date.iso8601(day.to_s)`.
- `active_job.enqueue_after_transaction_commit`: no effect here. The built-in Sidekiq adapter does not support it.
- `yjit = true`, `web_image_content_types` (adds webp) and `validate_migration_timestamps`: no effect.

**8.0**
- `to_time_preserves_timezone = :zone` is effectively already the 8.1 runtime behavior (finding 16).
- `strict_freshness = true`: the export download uses `stale?(etag:, last_modified:)`. Clients sending both conditional headers would revalidate on the ETag only. The test passed with it on; no behavior test covers a client sending both.
- `Regexp.timeout = 1`: the only anchored DOI regex is not at risk.

**8.1**
- `escape_json_responses = false`, `action_on_path_relative_redirect = :raise` (this app redirects only to named paths), `raise_on_missing_required_finder_order_columns`, `escape_js_separators_in_json = false`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete` and `yjit` (non-local environments only): no effect found.

With `load_defaults 8.1` and the adoption edits above (slug removed from the permit list, cache `max`, `to_s`, `coder: YAML`), the suite passed 46 of 46 (`/tmp/plan/t81_defaults81_fixed.log`). Adoption is optional, and it should be a separate follow-up after the upgrade deploys.

## Validation for each change

The failure-then-pass pairs below are existing tests. Each fails on 8.1.0 before its repair, which the planner observed, and passes after.

- **Findings 2 to 12, 18.** The whole suite fails or errors to boot without them.
- **Finding 13.** `ImportsControllerTest` "invalid rows are shown ... applying them saves nothing" fails with the `record_counts` change. The control is the happy-path import in the same file.
- **Finding 14.** The receipt assertion in "previews a CSV ... offers a receipt" shows the blank DOI.
- **Finding 15.** Lines 22 and 62 of the imports tests fail when the annotation is missing. The control is the "Compare with Bacon" line.
- **Finding 16.** The reminders test checks `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]`.
- **Finding 17.** The digests test checks the subject "October 05, 2026" and the 04:00 payload.
- **Finding 19.** Enqueue `DigestJob` on 8.1 and run it on a 7.0 worker. It fails before the `to_s("F")` change and succeeds after, with the retry set empty. A job queued on 7.0 and processed on 8.1 is the control.

No test yet covers a `DigestJob` payload shape or the upgrade-time Trix behavior. The planner proposes adding a check that the enqueued completion argument is a plain string, and a browser test for the editor.

## Order of rollout

1. Ship the 7.0-safe repairs, plus finding 19, on 7.0.8.7 first. They passed 46/46 on 7.0.8.7.
2. Ship the 8.1.0 upgrade with the version-specific changes (findings 1, 4, 8, 18, the test-environment `show_exceptions`) and the json pin.
3. Copy `tmp/development_secret.txt` to `tmp/local_secret.txt` for every developer's local database.
4. Decide on the Trix and `actiontext.css` question, and the DST preview behavior, before release.

---

**Decisions for you:**
- Should the next-day reminder preview keep today's displayed offset (the planner's repair) or show true local time (finding 16)?
- What should happen with the vendored Trix 1.3.5 versus the gem's Trix 2 (not verified without a browser)?

Tell me if you want me to implement the plan, either all of it or just the 7.0-safe repairs first.