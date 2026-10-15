The planner's full plan is below, unchanged. I have not modified the working application.

# Rails 7.0.8.7 to 8.1.0: application-specific upgrade plan

I did not modify `/home/user/workspace/repo`. All experiments ran in disposable copies under `/tmp/exp`, with their own Postgres databases (`mn_exp_*`), a private Redis on port 6391, and per-copy `storage` and `tmp`.

## Verdict

The upgrade is feasible but not drop-in. The baseline suite passes on 7.0.8.7 (46 runs, 325 assertions). On 8.1.0 with no code changes the app does not boot. After the repairs below, all 46 runs pass on 8.1.0, `zeitwerk:check` is clean, production eager-load boots and `assets:precompile` succeeds. Real Sidekiq workers also process jobs across 7.0 and 8.1.

- **Several required changes pass the suite but still change behavior.** These are findings 6, 7, 9 and 12, plus the `.sum` and ActiveRecord-association items in the "tests also catch" list. The `.sum` fix and the `where(notebook: …)` fix break tests only in a few places; the others change what users see or what is saved.
- **System tests were not run.** `test/system` is empty and there is no browser here.

## Evidence

- Change index: `/tmp/out/changes.txt`.
- Baseline 7.0 run: `/tmp/out/base_test.log`.
- Upgraded copy: `/tmp/exp/up`, with the full repair diff at `/tmp/out/proposed_changes.diff`.
  - Ignore `config/initializers/zz_exp_secret.rb`; it is an experiment artifact in the base copy.
  - Ignore the `Gemfile.lock` hunks except the json pin.
- Final green run: `/tmp/out/up_final_test.log`.
- Resolved dependencies: rails 8.1.0 and all components at 8.1.0, `json` pinned to 2.21.2, `rack` 2.2.24, `sidekiq` 6.5.12, `redis` 4.8.1, `puma` 5.6.9, `minitest` 5.27.0, `concurrent-ruby` 1.3.4.
- Per-step logs: `/tmp/out/up_test1.log` to `up_test9.log`.
- Experiment scripts: `/tmp/exp/probe1.rb` to `probe9.rb`, `/tmp/exp/enqueue.rb`.

Commands used:
- `bin/rails test` with `DATABASE_URL=postgres:///mn_exp_up_test`.
- `CI=1 bin/rails test`, to force eager loading.
- Real `bundle exec sidekiq -e development` in both copies.

Source-based findings are marked "(source)". Everything else was executed.

## Required changes

### 1. Boot failure: `ActionText::ContentHelper.allowed_tags +=` (executed)
- **Affected code:** `config/initializers/action_text.rb`.
- **If nothing is done:** every environment fails to boot with `NoMethodError: undefined method '+' for nil`. In 8.1 `allowed_tags` is nil until set, whereas on 7.0 it is a 48-element Set.
- **Repair:** seed the list from the sanitizer, then add `details` and `summary`:
  ```ruby
  helper = ActionText::ContentHelper
  tags = helper.allowed_tags || (helper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])
  helper.allowed_tags = tags + %w[details summary]
  ```
- **Works on 7.0:** yes. It is a no-op there because `allowed_tags` is already set.
- **Validation:** `ActionText::RichText.new(body: '<details><summary>S</summary><p>b</p><script>x</script></details>').to_s` keeps `<details><summary>` and drops the script tag. Identical output on 7.0, on 8.1 with 7.0 defaults, and on 8.1 with 8.1 defaults, and `allowed_tags.size` is 48 throughout (probe6).
- **Control:** `onclick` and `<script>` are still stripped.
- **Existing behavior to know about:** the `open` attribute on `<details>` is stripped on both versions, so it is not new.

### 2. Boot failure: keyword `enum` and `serialize … JSON` (executed)
- **Affected code:** `app/models/note.rb` lines 10 and 12.
- **If nothing is done:**
  - `enum status: {...}, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
  - `serialize :tags, JSON` raises `wrong number of arguments (given 2, expected 1)`.
  - `bin/rails zeitwerk:check` and eager-load fail.
- **Repair:**
  - `enum :status, { draft: 0, ready: 1 }, prefix: true`
  - `serialize :tags, coder: JSON`
- **Works on 7.0:**
  - The `enum` form works on 7.0.
  - `coder:` is 7.1 or later only, so keep `serialize :tags, JSON` until the gem bump.
- **Validation:** `Note.statuses`, `status_ready?` and `Note.status_ready` still work. A note saved with `tag_list: "a, b"` round-trips `["a","b"]`, and an existing row with `tags = '[]'` loads as `[]`.

### 3. Boot failure: multi-path `get` in routes (executed)
- **Affected code:** `config/routes.rb`, `get "/notes", "/journal", to: "notes#index"`.
- **If nothing is done:** the first request or `bin/rails routes` raises `Wrong number of arguments (expect 1, got 2)`. `zeitwerk:check` does not catch it.
- **Repair:** two `get` lines, one for `/notes` and one for `/journal`.
- **Works on 7.0:** yes.
- **Validation:** `bin/rails routes` before and after is identical for `notes` and `journal`, including helper names. The only diff is Action Mailbox conductor routes, which come from the framework. The existing test that requests both paths covers it.

### 4. `Rails.application.secrets` was removed (executed)
- **Affected code:** `app/models/citation/provider.rb` and `config/secrets.yml`; the tests in `test/controllers/citation_enrichments_controller_test.rb` also mutate it.
- **If nothing is done:** `NoMethodError: undefined method 'secrets' for MarginNotes::Application`. Every citation enrichment fails, and a missing provider surfaces as a job error rather than the intended "No citation provider is configured" message.
- **Repair (what I tested):**
  - Replace `config/secrets.yml` with `config/citation_provider.yml`, flat per environment.
  - Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  - Have `Provider#initialize` default to `Rails.configuration.x.citation_provider.to_h`.
  - The test helper reassigns `Rails.configuration.x.citation_provider` instead of the secrets hash.
- **Works on 7.0:** yes. `config_for` and `config.x` exist there, and the prep copy passed 46 runs on 7.0.
- **Validation:** the existing provider tests cover 200, 401, 404, 429, 503 and the retry, basic-auth header and URL override. Add one test that production-style blank values still raise `Provider::Error` ("No citation provider is configured").
- **Caveat:** `config_for(:citation_provider)` reads ENV at boot, as the old secrets file did.

### 5. `json` 3.x breaks Active Support 8.1.0 (executed)
- **Cause:** Rails 8.1.0 allows any `json` 2.7 or later. `bundle update rails` picked `json 3.1.0`.
- **If nothing is done:** `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)`, which fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`. This surfaced when reading encrypted session cookies, so `current_user` returns 500 on every request.
- **Repair:** add `gem "json", "< 3"` to the Gemfile. Resolved to 2.21.2, and tests then went from many failures to the app-code failures below.
- **Not verified:** whether a later 8.1.x patch fixes this. Check the 8.1.x changelogs before dropping the pin.
- **Validation:** sign in and `GET /notes` returns 200, and `SessionsControllerTest` passes.

### 6. `form_with(model: nil)` raises (executed)
- **Affected code:** `app/views/notes/index.html.erb:12`.
- **If nothing is done:** `ArgumentError: Passed nil to the :model argument, expect an object or false`, so `/notes` and `/journal` return 500.
- **Repair:** `form_with(model: false, …)`.
- **Works on 7.0:** yes.
- **Validation:** `NotesControllerTest#test_renders_an_unbound_search_form` finds `form[role=search][action="/notes"][method=get]`.

### 7. Notes filter by notebook silently changes (executed)
- **Affected code:** `app/controllers/notes_controller.rb:18`, `@notes.where(notebooks: @notebook)`.
- **If nothing is done:** 7.1 and later treat the key as a column of `notes`, giving `PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering the list by notebook returns 500.
- **Repair:** `where(notebook: @notebook)`.
- **Works on 7.0:** yes.
- **Validation:** `NotesControllerTest#test_filters_by_notebook,_status,_and_title` and the paging test pass. The control is the unfiltered list, which still shows all of the reader's notes.

### 8. `retry_on wait: :exponentially_longer` removed (executed)
- **Affected code:** `app/jobs/citation_enrichment_job.rb`.
- **If nothing is done:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised while the retry is scheduled. A provider outage turns into an unhandled job error and the citation is never marked failed.
- **Repair:** `wait: :polynomially_longer`. It is the same formula and exists from 7.1.
- **Works on 7.0:** no. Apply it with the gem bump or on 7.1 and later.
- **Validation:** the existing test "a provider that stays unavailable … leaves a visible failure" ends with `enrichment_status` failed after three attempts.

### 9. `alias_attribute :highlight_color, :color` on a store accessor (executed)
- **Affected code:** `app/models/note.rb:14`.
- **If nothing is done:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use alias_method…`. The error fires on every note load and save.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
  placed after `store_accessor`.
- **Works on 7.0:** yes.
- **Validation:** create with `highlight_color: "green"` and update to `"blue"`, as the existing controller tests do, then assert `note.settings["color"]` and the checked radio button. Also confirm an invalid colour is still rejected.
- **Trade-off:** `alias_method` does not alias the dirty-tracking helpers such as `highlight_color_changed?`. A grep shows the app does not use them.

### 10. `Export#generate` uses `fragments.sum` on strings (executed)
- **Affected code:** `app/models/export.rb:42`.
- **If nothing is done:** `TypeError: String can't be coerced into Integer`, so every export job fails.
- **Cause:** Rails 7.1 dropped its `Enumerable#sum` override. It already warns on 7.0.
- **Repair:** `fragments.join`.
- **Works on 7.0:** yes.
- **Validation:** `ExportsControllerTest` downloads a Markdown export whose bytes match the 7.0 output. This also covers the cancelled-export and cached-availability paths.

### 11. `HashWithIndifferentAccess#stringify_keys` now stringifies integer keys (executed, silent)
- **Affected code:** `app/views/imports/preview.html.erb:22` and `Import#annotations`.
- **If nothing is done:** annotations disappear from the import preview with no error. 7.0 returns keys `[2]`. 8.1 returns `["2"]`, so `annotations[row.line]` with an Integer returns nil. Existing tests caught it only through an `assert_select` mismatch.
- **Repair:** use `@import.annotations` directly, without `.stringify_keys`.
- **Works on 7.0:** yes.
- **Validation:** `ImportsControllerTest` previews a CSV with annotations in `#line_2 dd`. Control: rows without an annotation show no `Annotation` label.

### 12. Import apply: `return` inside `transaction` now commits (executed, data integrity)
- **Affected code:** `Import#apply`, `return false unless row.note.save` inside `transaction do … end`.
- **If nothing is done:** the existing test "applying them saves nothing" fails with `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]`. An import with one invalid row leaves the Import row, valid notes and citations committed, contradicting the model's contract ("saves nothing").
- **Repair:**
  ```ruby
  transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end || false
  ```
- **Works on 7.0:** yes. It uses an explicit rollback, which is correct on both versions.
- **Validation:** the existing test, plus a case where the second of three rows is invalid. It asserts no Import, Note, Citation or attachment exists afterwards, and `import.errors` and `row.note.errors` remain populated for re-rendering. Control: all-valid CSV creates everything.

### 13. `citation[:id]` returns nil for a custom primary key (executed, silent)
- **Affected code:** `Import#receipt`, `citation && citation[:id]`. `Citation` has primary key `doi`.
- **If nothing is done:** the receipt CSV has blank DOIs: expected `On idleness,10.1000/Essays.1`, got `On idleness,`. The data itself is saved correctly.
- **Repair:** `citation&.id`.
- **Works on 7.0:** yes.
- **Validation:** the existing receipt assertion. A saved note still reads `citation_doi` and `citation.doi` correctly.

### 14. Reminder, 7.1 and later: Integer `wait_until` and `to_time` semantics (executed)
- **Integer `wait_until`:**
  - Affected code: `Note#schedule_reminder`, `NoteReminderJob.set(wait_until: reminder_epoch)`.
  - If nothing is done: `NoMethodError: undefined method 'utc' for an instance of Integer`, so every reminder (and postponement) returns 500.
  - Repair: `wait_until: Time.at(reminder_epoch)`.
  - Works on 7.0: yes. The scheduled timestamp (the Sidekiq `at`) is unchanged.
- **Reminder display across daylight saving:**
  - Affected code: `Note#next_day_reminder_at`, `reminder_at.to_time + 86_400`.
  - 8.1 ignores `to_time_preserves_timezone`. It now emits a deprecation warning and always uses the receiver's zone.
  - Observed: 7.0 gives `2026-11-01T09:00:00-04:00`. 8.1 gives `2026-11-01T08:00:00-05:00`.
  - The instant and scheduling are identical; only the displayed wall-clock text and offset change, so the existing assertion fails.
  - Repair to keep the documented behavior: `Time.at(reminder_at.to_i + 86_400).localtime(reminder_at.utc_offset)`.
  - Works on 7.0: yes. The reminders tests pass there (3 runs, 34 assertions in my prep run).
  - Alternative: `reminder_at + 86_400` shows the true local time. I recommend keeping the documented offset-preserving display. The alternative changes visible text and the existing test and comment. Product can choose it later, as a separate change.
- **Validation:** `RemindersControllerTest` asserts `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]` and the enqueued `at` of 2026-10-31T13:00Z. Control: a summer date with no daylight-saving change gives the same string on both versions.

### 15. Digest jobs: time zone and BigDecimal serialization (executed, mixed-version)
- **Time zone:**
  - Affected code: `DigestMailer#daily_digest`, `DigestJob`, `User#request_digest`.
  - 8.1 serializes `time_zone` and deserializes a `TimeWithZone` in the reader's zone. 7.0 deserialized in the worker's zone (UTC).
  - Observed: the digest test expected "October 05, 2026" and got "October 04, 2026". The digest silently covers the reader's local day while the page text and comments say UTC day.
  - Repair: in the mailer, `requested_at = requested_at.in_time_zone("UTC")`.
  - Works on 7.0: yes. It is a no-op there.
- **BigDecimal:**
  - 8.1 always serializes a BigDecimal argument as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",…}`. 7.0 wrote the plain string `"0.4167"`, and `use_big_decimal_serializer` no longer applies.
  - Executed rollback hazard: an 8.1-enqueued DigestJob deserialized by 7.0 raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The payload is `/tmp/exp/digest_payload_81.json`.
  - Repair: enqueue `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`.
  - Works on 7.0: yes, and it produces the same payload 7.0 already produced.
- **Rollout, executed with real Sidekiq (`/tmp/out/sidekiq_up_drain70.log`, `/tmp/out/sidekiq_base_drain81.log`):**
  - 7.0-queued Digest, Export, CitationEnrichment and scheduled NoteReminder jobs all ran to "done" on 8.1 (the CitationEnrichment job was retried, as expected, because no provider was running).
  - With `.to_s` in place, a DigestJob enqueued by 8.1 also completes on a 7.0 worker. Without it, 7.0 workers cannot read it.
- **Validation:** an in-process test enqueues a digest at `2026-10-04 23:30 -04:00` for an Eastern reader. It performs the job and asserts the mail subject says "October 05, 2026" (the UTC day) and lists notes updated on 2026-10-05 UTC. The payload test asserts that `arguments.last` is a String.
- **Control:** a UTC reader's digest is unchanged.

### 16. Test environment `show_exceptions = false` (executed)
- **Affected code:** `config/environments/test.rb`.
- **If nothing is done:** `false` is no longer treated as "raise". `RecordNotFound` becomes a 404 response, so every "ActiveRecord::RecordNotFound expected but nothing was raised" test fails. These are the cross-reader authorization tests, so the suite loses its isolation checks without erroring.
- **Repair:** `config.action_dispatch.show_exceptions = :none`.
- **Works on 7.0:** no. Apply it after the bump, on 7.1 or later.
- **Validation:** `NotesControllerTest#test_another_reader's_notes_and_notebooks_cannot_be_reached` raises `ActiveRecord::RecordNotFound` again. The same applies to the notebook, report, import, export and reminder isolation tests.

### 17. Fragment cache with a negative `expires_in` (executed)
- **Affected code:** `app/views/exports/_export.html.erb:26`, `expires_in: export.expires_at - Time.current`. This is negative for an export first rendered after expiry.
- **If nothing is done:** it does not fail on 8.1 with 7.0 defaults, but behavior changes. 7.0 expires the entry immediately (read returns nil); 8.1 stores it with no expiry (read returns the value).
- **If `raise_on_invalid_cache_expiration_time` is adopted:** the exports index raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -86400.0`, a 500.
- **Repair:** `expires_in: [export.expires_at - Time.current, 1].max`.
- **Works on 7.0:** yes.
- **Validation:** an integration test with a memory store and `travel_to` an export first rendered two days after expiry returns 200 and "Expired". It also passes with `ActiveSupport::Cache::Store.raise_on_invalid_cache_expiration_time = true`. The existing cached-availability test (`ExportsControllerTest`) is the control.

### 18. `.first/.last` and other 8.1 items I checked without a finding
- No `encrypts`, `has_secure_token`, `after_commit`, `params ==`, or `to_time` use remains in `app/` beyond the items above.
- `serialize :preferences` (YAML Hash with string keys) round-trips unchanged on 8.1 with 7.0 defaults. `ActiveRecord.yaml_column_permitted_classes` is not needed, since only a Hash is stored.
- Sprockets, importmap, turbo-rails 2.0.12 and puma 5.6.9 boot on Rails 8.1.0, and assets precompile in production.
- Cookie sessions interoperate in both directions between the two versions:
  - Evidence: `RAILS_ENV=test`, same secret, two servers, `/tmp/exp/j70.txt` and `/tmp/exp/j81.txt`.
  - Result: all four combinations returned 200.
  - Caveat: my earlier development-mode attempt returned 302 for cross-version cookies. I did not isolate why, so treat it as inconclusive; the test-environment run is the attributed result.

## Tests also catch

Besides the numbered findings above, `bin/rails test` surfaced these (all covered by the repairs):
- `form_with` and notes list failures (item 6).
- Provider settings (item 4).

## Release-by-release and defaults

The app calls `config.load_defaults 7.0`. None of the new framework defaults below is set explicitly, so the app keeps the old value for all of them, and it will keep it after the bump unless it raises `load_defaults`. I ran the suite under `load_defaults` 7.1, 7.2, 8.0 and 8.1 separately (`/tmp/out/up_defaults_*.log`). To make 7.1 defaults boot I had to add `coder: YAML` to `serialize :preferences`.

### 7.1 defaults (optional adoption)
- Concrete failures on adoption:
  - `config.active_record.default_column_serializer = nil`: `ArgumentError: missing keyword: :coder` for `Notebook` until `serialize :preferences, coder: YAML` is added.
  - `raise_on_assign_to_attr_readonly = true`: `ActiveRecord::ReadonlyAttributeError: slug` on notebook update. `NotebooksController#notebook_params` permits `:slug`, and today it is silently ignored. Drop `:slug` from the permitted params first. The existing test "keep the slug" fails today under this default.
- Things not exercised by the suite, assessed from source:
  - `sanitizer_vendor` moving to HTML5 changes the rich-text output whitespace slightly. I saw no tag-level change in my probe.
  - `dom_testing_default_html_version = :html5` could change `assert_select` behavior. It passed under the 7.1 and later defaults.
  - `marshalling_format_version 7.1`, `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata` change cache and cookie formats. They are one-way for rollback and the docs prescribe a two-deploy sequence; defer them.
- Do not exercise these (no use in this app): active record encryption digests, `query_log_tags_format`, `run_after_transaction_callbacks_in_order_defined` (no `after_commit` callbacks), `belongs_to_required_validates_foreign_key`, `generate_secure_token_on`, `precompile_filter_parameters`, `allow_deprecated_singular_associations_name`, `log_file_size`.
- Other 7.1 defaults, no impact: `allow_deprecated_parameters_hash_equality` (the app never compares `params` with a Hash), `sqlite3_adapter_strict_strings_by_default` (the app uses Postgres), and `debug_exception_log_level` (log level only).

### 7.2 defaults
- **`postgresql_adapter_decode_dates = true` (executed):** `Notebook#daily_note_counts` fails with `TypeError: no implicit conversion of Date into String` at `Date.iso8601(day)`. `activity_reports#show` returns 500. The raw `select_rows` of `DATE(...)` now returns a Date.
- **`active_job.enqueue_after_transaction_commit` (the change summary lists this as a 7.2 default; it is a false positive).**
  - On 8.1 `load_defaults 7.2` and `8.1` do not set it. `ActiveJob::Base.enqueue_after_transaction_commit` is `false`.
  - Executed opt-in risk: with it set to `true` and the Sidekiq adapter raising `Redis::CannotConnectError`, `Citation#request_enrichment` leaves `enrichment_status` committed as `"pending"`. With the default (`false`) the status rolls back.
  - `Note#schedule_reminder` likewise commits a new `reminder_job_id` with no queued job.
  - Do not enable it; the app relies on enqueuing under the row lock for rollback.
- **Others, no impact:** `validate_migration_timestamps` (the migration timestamps are well-formed), `web_image_content_types` (no variants or `image_processing`), and `yjit = true` (a memory consideration at deploy).

### 8.0 defaults
- **`strict_freshness = true` (source, minimal):** `ExportDownloadsController` uses `stale?(etag:, last_modified:)`. With both conditional headers present only `If-None-Match` is then honored.
- **`Regexp.timeout = 1`:** the DOI regexp is linear. No change is expected.
- **`to_time_preserves_timezone`:** already behaves as the new default on 8.1 regardless of this setting (finding 14).

### 8.1 defaults (executed in the `load_defaults 8.1` run)
- The suite shows only the two 7.1 and 7.2 errors above.
- `action_on_path_relative_redirect = :raise`: all redirects in the app are absolute paths or helpers.
- `render_tracker = :ruby` changes fragment-cache digests, so caches are invalidated once after adoption. Harmless.
- `escape_json_responses = false`, `remove_hidden_field_autocomplete = true` and `raise_on_missing_required_finder_order_columns`: no found impact.

### Not defaults, but noticed
- **Sidekiq adapter deprecation (executed):** `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2 … upgrade 'sidekiq' to version 7.3.3 or later`. It does not block 8.1.0. Sidekiq 7 is a coupled follow-up:
  - `Sidekiq.redis { |r| r.sadd(...) }` returns an Integer through redis-client, and `if 0` is truthy, which would break `User#request_digest` deduplication.
  - The `rescue Redis::BaseError` clauses in `Notebook#request_export` and the test stubs need rework.
  - `ExportJob.perform_async(id, { format: "markdown" })` uses a symbol key, which Sidekiq 7 rejects.
  - Do this as its own plan with a rollout of its own.
- **`config.cache_classes`:** still accepted on 8.1 without a warning in my runs. `enable_reloading` is the 7.1 and later replacement, optional.
- **`bin/rails app:update --force`:** run in a copy (`/tmp/exp/upd`), it rewrites `config/application.rb` and drops the `config.active_job.queue_adapter = :sidekiq` and `config.x.citation_provider` lines, and it flips production to `force_ssl`/`assume_ssl`. Do not run it with `--force` against the real app. It also generates three Active Storage migrations that duplicate columns already in `db/schema.rb` (all guarded with `column_exists?`/`table_exists?`).
- **Gemfile pin comment:** "Rails 7.0's test runner is incompatible with Minitest 6". Rails 8.1 locks Minitest 5.27 here; whether Minitest 6 works with 8.1 is untested.

## Recommended sequence

1. **On 7.0.8.7 (preparatory; all verified there, 46 runs / 325 assertions in `/tmp/exp/prep`):**
   - Findings 1, 3, 4, 6, 7, 9, 10, 11, 12, 13, 15 (both `.to_s` and UTC mailer), 17, the Integer `wait_until`, the offset-preserving `next_day_reminder_at`, and `enum :status, …, prefix: true`.
   - Deploy and let it settle. This also empties the old payload-format risk, because new digest jobs then carry a String completion.
2. **Bump the gem to 8.1.0** with `gem "json", "< 3"`, and apply the version-bound items:
   - `serialize :tags, coder: JSON` (finding 2).
   - `wait: :polynomially_longer` (finding 8).
   - `show_exceptions = :none` (finding 16).
3. **Keep `load_defaults 7.0`.** Adopt newer defaults in later, separate changes, in this order:
   - Drop `:slug` from permitted params, then `raise_on_assign_to_attr_readonly`.
   - Switch `daily_note_counts` to handle `Date`, then `postgresql_adapter_decode_dates`.
   - Add `coder: YAML` for `preferences`, then `default_column_serializer`.
   - Hold the cache and message-format defaults for a two-step deploy.
4. **Sidekiq 7:** separate follow-up before Rails 8.2.

## Rollout and rollback notes

- **Queued work from 7.0:** all processed correctly by 8.1 workers (executed). Digest payloads queued by 7.0 hold a plain String completion and an offset-only time. 8.1 falls back to `Time.zone` (UTC) when `time_zone` is absent.
- **Rollback after 8.1 has enqueued work:** only the unrepaired BigDecimal payload fails. With finding 15's `.to_s`, 8.1-enqueued digests run on 7.0 workers (executed).
- **Native `ExportJob`:** unchanged payload format on both versions.
- **Stored data:** the schema is unchanged. `notes.tags` (JSON text) and `notebooks.preferences` (YAML Hash) read the same on both versions. No migrations are required.
- **Sessions:** interoperate (executed in the test environment).
- **Fragment cache:** with `load_defaults 7.0`, `cache_format_version` stays 7.0, so old and new processes can share a cache store.

## Validation to run per finding

For each repair, run the named test on 8.1 without the repair (it fails), then with it (it passes). Then run the control on both 7.0 and 8.1.

- **Existing tests that fail without the repair:** the notes list (6, 7), imports (11, 12, 13), reminders (14), digests (15), exports (10, 17 partly), citation enrichment (4, 8), and the cross-reader tests (16).
- **Tests I recommend adding, none of which exist today:**
  - A digest test across a UTC midnight boundary with a non-UTC reader (15).
  - An import test where a middle row is invalid and no records remain (12).
  - An exports-index test for an export first rendered after expiry, including with the invalid-expiry flag on (17).
  - A rendered-HTML check for `<details><summary>` in rich text (1).
  - A test that the receipt CSV contains the DOIs (13).
  - A job-payload test asserting a String `completion` (15).

## Still unverified

- System tests (no browser available).
- Whether an 8.1.x patch makes the `json` 3.x pin unnecessary.
- A real production Redis, cache store and storage service. I used a private Redis, the test cache and disk storage.
- Why my development-mode cross-version cookie attempt returned 302. The test-environment result was clean.
- Behavior of Minitest 6 with Rails 8.1.

---

**Commentary:** Per the skill, this is a plan only. If you want me to implement it, I'd start with step 1, the preparatory changes on 7.0.8.7, and then do the bump separately.