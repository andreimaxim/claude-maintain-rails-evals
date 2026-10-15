# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

Nothing was implemented. The planner's disposable workspace was cleaned up, and `git status` in `/home/user/workspace/repo` is clean.

## Summary

- **State at setup:** The unmodified bump does not boot. After the boot error is fixed, 20 more test failures and errors appear. The baseline suite is 46 runs, 325 assertions, 0 failures.
- **State after repairs:** With every repair below applied in the disposable `upgraded` copy, the suite passes (46 runs, 0 failures, 0 errors) under `load_defaults 7.0` and under `load_defaults 8.1`.
- **Lockfile:** The lockfile move to 8.1.0 also adds `json 3.1.0`, `bigdecimal 4.1.3`, `drb`, `rack-session`, `rackup` and others. `method_source` is removed.
- **Rack stays on 2.2.24.** Rails 8.1.0 only requires `rack >= 2.2.4`, so Rack 3 findings only apply if you bump Rack separately. `gem-changes` predicted 3.2.7, but the resolver kept 2.2.24.
- **Repairs that can ship first:** Repairs 3 to 10, 12 and 14 to 16 below passed the baseline suite (46 runs, 324 assertions, 0 failures) on 7.0.8.7. Repairs 1, 2, 11 and 13 need the bump. Repair 14 is a clamp that is a no-op on 7.0.
- **Not verified by running:** The 8.1.0 behavior behind repairs 1 and 11 was run, but `coder:` and `config.x` are not meaningful on 7.0. Their old-version behavior is covered by the `serialize :tags, coder: JSON` probe and by the 7.0 source reading, not by a baseline test run.

## 1. Required changes (effective on the bump)

### 1. `serialize` needs `coder:` (the `coder:` repair must ship with the bump)
- **Affected code:** `app/models/note.rb:12` (`serialize :tags, JSON`) and `app/models/notebook.rb:7` (`serialize :preferences`).
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` on `serialize :tags, JSON`. `serialize :preferences` fails with `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to serialize`. Both are raised while the model class loads, so nearly every test failed.
- **Applicability:**
  - It takes effect on the bump, under the current `load_defaults 7.0`.
  - The repair cannot ship on 7.0. A probe on 7.0 showed `serialize :tags, coder: JSON` silently uses `YAMLColumn` and writes `"---\n- a\n- b\n"` into the `tags` column. That would corrupt data if deployed early.
  - Stored data is unchanged. On both versions the probe gave the same strings for asymmetric values: `["é","a<b>&","日本 "]` serializes identically, `{"export_heading"=>"Reading <notes> & é"}` dumps identically, and legacy YAML including `:sym` reads back.
- **Repair:** In `app/models/note.rb`, use `serialize :tags, coder: JSON`. In `app/models/notebook.rb`, use `serialize :preferences, coder: YAML`.
- **Validation:** The notes and notebooks controller tests failed with the errors above and pass after the repair. Control: the probe shows the same serialized and deserialized values for `"[\"x\"]"`, `"[]"`, nil preferences and `"--- {}\n"` on both versions.

### 2. `enum` keyword-hash form removed
- **Affected code:** `app/models/note.rb:10`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at class load.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. This keeps the `status_draft` and `status_ready` method names.
- **Validation:** The baseline suite passed with the repair, including `status_ready` in `DigestMailer`. Control: `Note.statuses.key?` in the notes controller still works.

### 3. `alias_attribute` on a non-attribute
- **Affected code:** `app/models/note.rb:13-14`, where `store_accessor :settings, :color` is followed by `alias_attribute :highlight_color, :color`. It is used in `app/controllers/notes_controller.rb:68` and in `notes/_form`, `notes/show` and `notes/index`.
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` This is raised the first time a `Note` is instantiated.
- **Applicability:** On the bump (7.2 behavior). The repair works on 7.0.
- **Repair:** Replace the line with `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Validation:** The `highlight_color: "green"` create and `"blue"` update tests pass, including the checked radio button. Control: the blank value still renders as "None".

### 4. Multi-path `get` removed
- **Affected code:** `config/routes.rb:18` (`get "/notes", "/journal", to: "notes#index"`).
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2)` when routes are drawn. The result was 0 routes and a failed boot.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Validation:** Route names and verbs match the baseline: `notes` for `/notes` and `journal` for `/journal`. Adding `as: nil` would have dropped the `journal` name. Control: the test "lists the reader's notes newest first at both list paths" passes.
- **Framework routes:** The route count is 67 on the baseline and 63 on upgraded. The four missing routes are all `rails/conductor/action_mailbox/inbound_emails` edit, update and destroy routes. They are framework routes, not the app's.

### 5. Action Text `allowed_tags` is now nil
- **Affected code:** `config/initializers/action_text.rb:3` (`ActionText::ContentHelper.allowed_tags += %w[ details summary ]`).
- **What breaks:** `NoMethodError: undefined method '+' for nil` at boot.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:**
  ```ruby
  helper = ActionText::ContentHelper
  base = helper.allowed_tags ||
    (helper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])
  helper.allowed_tags = base + %w[ details summary ]
  ```
- **Validation:** The test "rich text keeps collapsible excerpts and drops unsafe markup" passes under both default sets. It keeps `<details><summary>` and drops `<script>`, `javascript:` hrefs and `onclick`.

### 6. `Rails.application.secrets` removed
- **Affected code:** `app/models/citation/provider.rb:13`, and `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`. The settings file is `config/secrets.yml`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** In `config/application.rb`, add `config.x.citation_provider = config_for(:secrets).citation_provider`. In `provider.rb`, read `Rails.configuration.x.citation_provider.to_h`. In the test, read and write `Rails.configuration.x.citation_provider`.
- **Validation:** The test "provider credentials from the environment reach the server unchanged" passes. It boots a fresh `rails runner` with the password `sample: value # keep`. A password containing `&`, `<`, `>` and U+2028 round-trips unchanged through `config_for(:secrets)` on both versions. Control: the other three tests in that file pass.

### 7. `show_exceptions = false`
- **Affected code:** `config/environments/test.rb:31`.
- **What breaks:** `ActiveRecord::RecordNotFound expected but nothing was raised`, because the exception is now rendered as a 404. Six tests failed, for example `NotebooksControllerTest` line 44 and `RemindersControllerTest` line 69.
- **Applicability:** On the bump. `:none` works on 7.0, though the baseline was not run with it.
- **Repair:** `config.action_dispatch.show_exceptions = :none`.
- **Validation:** All six tests pass again.

### 8. `Array#sum` of strings
- **Affected code:** `app/models/export.rb:42` (`finish(fragments.sum)`).
- **What breaks:** `TypeError: String can't be coerced into Integer` at `export.rb:42`, so every export fails.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `finish(fragments.join)`.
- **Validation:** The three exports controller tests pass. Control: the downloaded body is unchanged.

### 9. `form_with(model: nil)`
- **Affected code:** `app/views/notes/index.html.erb:12`.
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. The notes list renders a 500, and so does the redirect after sign-in.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `form_with(model: false, ...)`.
- **Validation:** The form test `form[role=search][action="/notes"][method=get]` passes. Control: the `scope`-less field names (`query`, `notebook_id`) are unchanged.

### 10. `where(notebooks: record)`
- **Affected code:** `app/controllers/notes_controller.rb:12`.
- **What breaks:** `PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering the list by notebook fails.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `@notes = @notes.where(notebook: @notebook)`.
- **Validation:** The filter test passes. It uses two notebooks with different notes and checks that the other reader's notebook still raises `RecordNotFound`.

### 11. `retry_on ... wait: :exponentially_longer` removed
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised from `Citation#request_enrichment` in `app/models/citation.rb:20` once the first retry is scheduled.
- **Applicability:**
  - It takes effect at the bump.
  - `:polynomially_longer` does not exist on 7.0, so it cannot ship early.
  - Both use the formula `executions**4 + jitter + 2`, so the delay schedule does not change.
- **Repair:** `wait: :polynomially_longer`.
- **Validation:** The citation enrichments test file passes: 4 runs, 29 assertions. It asserts three job attempts, each retrying one 503 (6 provider requests in total). Control: the permanent-refusal path still marks the citation failed without retrying.

### 12. `ActiveJob` `wait_until` needs a time
- **Affected code:** `app/models/note.rb:61` (`NoteReminderJob.set(wait_until: reminder_epoch)`).
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Scheduling a reminder fails.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `wait_until: Time.at(reminder_epoch)`.
- **Validation:** The enqueued job still has `at` equal to `Time.utc(2026,10,31,13).to_i` for a reminder entered as 09:00 in Eastern time. The imported-reminder test with epoch `1_793_451_617` also passes. A probe confirmed the Sidekiq scheduled-set score is `1793451617` on both versions.

### 13. `json 3.1.0` breaks `ActiveSupport::JSON.decode` (Rails 8.1.0 plus the resolved gem)
- **Affected code:** Every read of `notes.settings` (jsonb), through `store_accessor :settings, :color` at `app/models/note.rb:13`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291` (`parse`), called from `activesupport-8.1.0/.../json/decoding.rb:25` through `ActiveRecord::Type::Json#deserialize`. Creating any `Note` fails.
- **Applicability:**
  - The Gemfile does not pin `json`, so bundler resolves 3.1.0. The baseline uses the default gem 2.7.2.
  - Pinning works before the bump too, since 2.7.2 is the baseline's version.
  - The planner could not verify whether a Rails patch release fixes this.
- **Repair:** Add `gem "json", "< 3.1"` to `Gemfile`. This resolved to `json 2.7.2`.
- **Validation:** Without the pin, note creation fails. With it, all 46 tests pass. Control: `JSON.load` and `JSON.parse` called directly (as `Citation::Provider` does) work on both versions.

### 14. Non-local `return` inside `transaction` now commits (data-integrity bug)
- **Affected code:** `app/models/import.rb:53-58` (`Import#apply`).
- **What breaks:** An import with one valid row and one invalid row saves the import and the valid note. The test "invalid rows are shown with their errors, and applying them saves nothing" observed `record_counts` change from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. A partial import is committed instead of being rolled back.
- **Applicability:** On the bump (7.1 behavior). The repair works on 7.0. No other `transaction` or `with_lock` block in `app/` returns from inside the block.
- **Repair:**
  ```ruby
  saved = transaction do
    save!
    rows.all? { |row| row.note.save } || raise(ActiveRecord::Rollback)
  end
  saved ? true : false
  ```
- **Validation:** The invalid-rows test passes with counts unchanged. Control: the valid-CSV import test creates 2 notes, 1 citation and 1 import.

### 15. `HashWithIndifferentAccess#stringify_keys` now converts integer keys
- **Affected code:** `app/views/imports/preview.html.erb:22` (`@import.annotations.stringify_keys`). `Import#annotations` is at `app/models/import.rb:38`.
- **What breaks:** On 8.1 the probe gave `{"2"=>"x"}` and `nil` for `[2]`. On 7.0 it gave `{2=>"x"}` and `"x"`. So no annotation `<dd>` renders in the preview, and the test saw `10.1000/Essays.1` instead of `Read <b>twice</b> & reflect`.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** Use `@import.annotations` without `stringify_keys`.
- **Validation:** Both import preview tests pass. They use asymmetric rows: line 2 has an annotation containing HTML, and line 4 has a different annotation.

### 16. Import receipt uses `citation[:id]`
- **Affected code:** `app/models/import.rb:68`.
- **What breaks:** `Citation` has primary key `doi`. `citation[:id]` is `nil` on 8.1, and `"10.1000/x"` on 7.0. The CSV receipt came out as `On idleness,` and `Of experience,` with empty DOIs.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `citation&.doi`.
- **Validation:** The receipt test expects `"title,doi\nOn idleness,10.1000/Essays.1\nOf experience,10.1000/Essays.1\n"` and passes. Control: a note with no citation still gives an empty DOI.

### 17. `TimeWithZone#to_time` and `next_day_reminder_at`
- **Affected code:** `app/models/note.rb:44`, used in `app/views/notes/_reminder.html.erb` and `Note#postpone_reminder`.
- **What breaks:**
  - The "24 hours later" preview changes from `2026-11-01T09:00:00-04:00` to `2026-11-01T08:00:00-05:00`. The instant is the same, and so is the epoch saved by `postpone_reminder`. Only the displayed wall-clock time and offset change.
  - The test `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]` failed.
  - `ActiveSupport.to_time_preserves_timezone` is `true` on 7.0 and `nil` on 8.1, and the config is deprecated.
- **Applicability:** On the bump. The repair works on 7.0.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`. This keeps the documented behavior in the code comment, "keeps the reminder's UTC offset".
- **Validation:** The reminder test uses an Eastern-time reader and a 31 Oct reminder that crosses the 1 Nov DST change. It now asserts the original `-04:00` value. Control: the stored `reminder_epoch` after postponing is unchanged.

### 18. Digest date now follows the reader's zone, and `BigDecimal` payload format
- **Affected code:** `app/mailers/digest_mailer.rb:7-9` and `app/models/user.rb:41`.
- **What breaks:**
  - **Time zone:** Active Job now keeps the time zone when it deserializes a `TimeWithZone`. For a request at `2026-10-04T23:30-04:00`, the 8.1 worker sees `2026-10-04 23:30 EDT`, and `to_date` is `Oct 04`. The 7.0 worker saw UTC `Oct 05`. The test subject was `"Your reading digest for October 04, 2026"` instead of `"October 05, 2026"`, so the digest would cover the wrong UTC day for readers east of or behind UTC near midnight.
  - **Payload:** `BigDecimal` is serialized by `BigDecimalSerializer` unconditionally, so the argument becomes a hash instead of the string `"0.5"`.
- **Applicability:** On the bump, under `load_defaults 7.0`. Both repairs work on 7.0.
- **Repair:**
  - In `digest_mailer.rb`, add `requested_at = requested_at.utc` before `to_date` and `all_day`.
  - In `user.rb:41`, pass `reading_completion.to_s("F")`.
- **Validation:** The digest test uses an Eastern reader whose request time is `Time.utc(2026,10,5,3,30)`. It passes, with the subject `October 05` and `50% of your notes were ready`. Controls: the DigestMailer `BigDecimal(params[:completion])` still accepts the string, and the control test with a note from `2026-10-04T16:00Z` is excluded.

### 19. Built-in Sidekiq adapter deprecated
- **Affected code:** `config/application.rb:24` (`config.active_job.queue_adapter = :sidekiq`) and `Gemfile:35` (`sidekiq 6.5.12`).
- **What happens:** `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2... upgrade sidekiq gem to version 7.3.3 or later`. It works on 8.1.0, with Sidekiq 6.5.12 and redis 4.8.1.
- **Plan:** The Sidekiq 7.3.3 or later bump (and its `redis` requirement) is separate work. Whether Sidekiq 7's own adapter processes `JobWrapper` jobs already queued by 7.0 is not verified.

### 20. Dependency changes
- `method_source` is removed from the lockfile and the app does not reference it.
- `drb`, `bigdecimal 4.1.3`, `uri`, `securerandom`, `useragent`, `rack-session`, `rackup`, `webrick`, `action_text-trix` and `net-imap 0.6.7 to 0.6.8` are added or moved.
- `(BigDecimal(a)/b).round(4)` gave identical results on 3.1.5 and 4.1.3 for 1/3, 2/3, 1/7, 5/6 and 0/4.
- `config/environments/*.rb` use `config.cache_classes`. It still works on 8.1.0.
- Rack 2.2.24, Puma 5.6.9 and `rack/handler/puma` load fine. This was not exercised with a real HTTP request.
- The only Rack 3 candidates (`Rack::Request#values_at`, custom middleware) do not apply: the app has no custom middleware, and `values_at` is `params.values_at` on Active Job params in `DigestMailer`.

### 21. Schema dump
- The 8.1 dump differs from the committed schema: header `ActiveRecord::Schema[8.1]`, `enable_extension "pg_catalog.plpgsql"`, and alphabetically sorted columns.
- Do not commit the 8.1 dump to the shared `db/schema.rb` until every environment runs 8.1.
- A 7.0 process loading that file would run `enable_extension "pg_catalog.plpgsql"`. This has not been tested.

## 2. New configuration defaults (the app uses `load_defaults 7.0`, with nothing set explicitly in `config/` for any of these)

Results below are from `upgrade-workspace test --defaults 8.1` and probes.

**7.1 defaults**

| Default | Impact on this app | Repair |
|---|---|---|
| `raise_on_assign_to_attr_readonly = true` | Failure: `ActiveRecord::ReadonlyAttributeError: slug` from `app/controllers/notebooks_controller.rb:26`. The settings form resubmits `slug` (`app/views/notebooks/_form.html.erb:13`, `app/controllers/notebooks_controller.rb:40`). | Remove `:slug` from the permit list, delete the hidden field, and update `test/controllers/notebooks_controller_test.rb:22-39`: assert no `notebook[slug]` input and `slug: "hacked"` is ignored. This works on 7.0. |
| `raise_on_invalid_cache_expiration_time = true` | Failure: `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0` at `app/views/exports/_export.html.erb:26`. It happens on cache reads of an expired export. | Use `expires_in: [export.expires_at - Time.current, 0].max`. This keeps the stale-indicator test passing and is a no-op on 7.0. |
| `cache_format_version = 7.1` | A 7.1-format entry written by 8.1 raises `TypeError: incompatible marshal file format (can't be read)` when 7.0 reads it. Production defaults to the file store, and fragments are cached only for `exports/_export` (digest `e47332fd...` is identical on all three configurations). Entries expire within 24 hours. | Adopt only after rollback is no longer needed. |
| `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata` | Verifiers and SGIDs are written as JSON, which 7.0 cannot read. 7.0 `verified` returned `nil` and `SignedGlobalID.parse` returned `nil`. SGIDs are stored inside Action Text bodies in the database. | Adopt only after rollback is no longer needed. |
| `default_column_serializer = nil` | Already forced by repair 1. | None. |
| `add_autoload_paths_to_load_path = false` | No impact. The app has no `require` of autoloaded files. | None. |
| `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined` | No impact. There are no `after_commit` or `before_commit` callbacks in `app/`. | None. |
| `generate_secure_token_on = :initialize` | No impact. There is no `has_secure_token`. | None. |
| `belongs_to_required_validates_foreign_key = false` | Validation only; no test difference. | None. |
| `query_log_tags_format`, `encryption.*`, `marshalling_format_version` | No impact. These features are not used. | None. |
| `dom_testing_default_html_version = :html5` | No test difference. | None. |
| `default_headers` | Drops `X-Download-Options: noopen`; the other headers are unchanged. | None. |
| `sanitizer_vendor` | No test difference. | None. |
| `sqlite3_adapter_strict_strings_by_default`, `log_file_size` | No impact. The app uses PostgreSQL. | None. |

**7.2 defaults**

| Default | Impact on this app | Repair |
|---|---|---|
| `postgresql_adapter_decode_dates = true` | Failure: `TypeError: no implicit conversion of Date into String` at `app/models/notebook.rb:40` (`Date.iso8601(day)`), reached from `ActivityReportsController#show`. | Use `Date.iso8601(day.to_s)`. This works on 7.0. |
| `yjit = true` | Runtime only, outside local environments. | Opt out with `config.yjit = false` if wanted. |
| `validate_migration_timestamps` | No impact. The newest migration (`20261011190000`) is before today. | None. |
| `web_image_content_types` | No impact. The app does not use variants. | None. |

**8.0 defaults**

| Default | Impact on this app | Repair |
|---|---|---|
| `strict_freshness = true` | `app/controllers/export_downloads_controller.rb:11` uses `stale?(etag:, last_modified:)`. A probe with a matching ETag and a stale `If-Modified-Since` gave `false` on all three configurations, so no difference was observed. | Unverified beyond that probe. |
| `Regexp.timeout = 1` | Observed `Regexp.timeout=1.0`. The app's only regex (`Citation` DOI format `%r{\A10\.\d{4,9}/\S+\z}`) is linear. | None. |

**8.1 defaults**

| Default | Impact on this app | Repair |
|---|---|---|
| `escape_json_responses`, `escape_js_separators_in_json`, `action_on_path_relative_redirect = :raise`, `raise_on_missing_required_finder_order_columns` | No impact found by reading the code. The app has no `render json:` and no path-relative redirects. `redirect_to` is always given a named path helper. All models have primary keys, including `Citation` with `doi`. | None. |
| `render_tracker = :ruby` | Digests of the cached `exports/_export` fragment are identical on all three. The `notes/index` digest differs between 7.0.8.7 and 8.1.0 under both default sets (`f2bc0086...` to `dd45462b...`), but that template is not cached. | None. |
| `remove_hidden_field_autocomplete` | Affects only `hidden_field_tag` output. | None. |
| `yjit` | Runtime only; see 7.2. | None. |
| Alphabetical `schema.rb` columns | Not a `load_defaults` setting. See required change 21. | None. |

## 3. Rollout, rollback and mixed-version risks

**Probes run:** `upgraded` (8.1.0) was tested with and without `load_defaults 8.1`, against `baseline` (7.0.8.7).

- **Sessions and cookies:** With the same `secret_key_base`, session cookies written by 7.0 and 8.1, with or without the 8.1 defaults, were all accepted by every other configuration (`GET /notes` returned 200). Dev and test generate different secrets, so this was only valid after setting the same secret in both workspaces. Production must share its secret across versions.
- **Cache entries:** 7.0 entries are readable by 8.1. 8.1 entries written under `load_defaults 7.0` are readable by 7.0. 8.1 entries with the 8.1 defaults are not (see section 2).
- **Queued Active Job payloads:**
  - 7.0 jobs read by 8.1: `TimeWithZoneSerializer` payloads without `time_zone` decode as UTC, and `"0.5"` strings stay strings. Already-queued `DigestJob`s work, and the existing `DigestMailer` accepts a string completion.
  - 8.1 jobs read by 7.0: any 8.1-written `DigestJob` with a `BigDecimal` argument fails on 7.0 with `ActiveJob::DeserializationError ... Serializer ActiveJob::Serializers::BigDecimalSerializer`. The extra `time_zone` key is ignored by 7.0, and an 8.1-format payload deserialized to UTC on baseline in a probe. Repair 18 (a string completion) makes new payloads identical in shape, so deploy it on 7.0 first.
  - `NoteReminderJob` and `CitationEnrichmentJob` carry only GlobalIDs. 8.1 adds a `scheduled_at` key that 7.0 ignores. Scheduled reminders already in Redis from 7.0 are readable by 8.1 (`JobWrapper` is still present).
  - `ExportJob` is a native Sidekiq job and does not involve Active Job.
- **Database records:** Stored `tags` and `preferences` are unchanged by repair 1, but the repair itself must not run on 7.0 (it silently stores YAML). `notes.settings` is jsonb and is unchanged.
- **Signed IDs and SGIDs:** The `signed_global_ids` verifier and SGID format change only when `message_serializer` is adopted (section 2). Do not adopt it until rollback to 7.0 is no longer needed.
- **Schema:** See required change 21.

**Preparatory repairs that can ship on 7.0.8.7 first** (the baseline suite passed with all of these: 46 runs, 324 assertions):
- Repair 2 (`enum`), 3 (`alias_method`), 4 (routes), 5 (Action Text initializer), 6 (`config.x.citation_provider`), 7 (`show_exceptions = :none`), 8, 9, 10, 12, 14, 15, 16, 17 and 18.
- The json pin in 13.
- From section 2: remove the `slug` permit and hidden field, the `Date.iso8601(day.to_s)` change, and the cache `expires_in` clamp.

**Must wait for the bump:** `coder:` (1) and `:polynomially_longer` (11).

## 4. Verification log and open questions

Resolved lockfile versions in the `upgraded` copy: `rails`, `actionpack`, `activesupport`, `activerecord` and the other Rails components at 8.1.0, `json 3.1.0` (changed to 2.7.2 by repair 13), `bigdecimal 4.1.3`, `rack 2.2.24`, `rack-session 1.0.2`, `rackup 1.0.1`, `net-imap 0.6.8`, `puma 5.6.9`, `sidekiq 6.5.12`, `redis 4.8.1`, `faraday 1.10.4`, `pagy 8.6.3`. The baseline is `rails 7.0.8.7`.

**Executed with `upgrade-workspace`** (the logs and workspace were deleted afterwards):
- `setup rails 7.0.8.7 8.1.0`:
  - Baseline: boot OK, eager load OK, 67 routes, tests 46 runs, 325 assertions, 0 failures.
  - Upgraded: boot failed with `NoMethodError: undefined method '+' for nil (config/initializers/action_text.rb:3)`, and the test runner exited with status 1.
- After the initializer fix, the upgraded suite had 3 errors in the first run and, after the other repairs, failures progressed from 20 failures and 3 errors, to 3 failures and 10 errors, to 3 failures, to 0.
- Final runs in `upgraded` with every repair applied: `upgrade-workspace test` gave 46 runs, 339 assertions, 0 failures, 0 errors under `load_defaults 7.0`. `upgrade-workspace test --defaults 8.1` gave the same with 339 assertions.
- Baseline with the compatible repairs: 46 runs, 324 assertions, 0 failures.
- Probes run: serializer round-trips, the `coder: JSON` behavior on 7.0, `ActiveJob::Arguments` round-trips, the Sidekiq enqueue payloads, session cookies, the cache entry, verifier and SGID cross-reads, schema dumps, route diffs, `BigDecimal` rounding, `HashWithIndifferentAccess#stringify_keys`, `to_time` behavior, `default_headers`, `Regexp.timeout`, and fragment digests.

**Based on reading source only (not run):**
- 7.0 `exponentially_longer` and 8.1 `polynomially_longer` use the same formula.
- `action_on_path_relative_redirect`, `escape_json_responses` and `raise_on_missing_required_finder_order_columns` have no impact, based on grepping `app/`.
- The production cache store and `config.cache_classes` handling.

**Not verified:**
- `strict_freshness` shows no difference in the one probe that was run.
- The migrations (`db/migrate/*`, all `ActiveRecord::Migration[7.0]`) were not run on 8.1 from an empty database.
- A real Puma server under Rack 2.2.24 on Rails 8.1.0 was not exercised.
- Whether a Rails 8.1.x patch release fixes the `json 3.1.0` incompatibility (13).
- Whether Sidekiq 7.3.3 or later still processes `JobWrapper` payloads queued by the built-in adapter (19).

**Open questions:** Does production have a single shared `secret_key_base` across rollout? What is production's cache store (it defaults to the file store when unset)?

---

## Additional commentary

- The plan covers a jump from Rails 7.0 to 8.1, so it is large. I have not changed anything in the repo. The planner worked in a disposable copy.
- Per the plan, 7.0-compatible repairs (everything except 1, 2, 11 and 13's pin-and-bump parts) can land first as separate commits on 7.0.8.7. That keeps the bump commit small and the rollback path open.
- Repair 14 (partial imports committed after the bump) is the one with real data-integrity risk. Repairs 1 and 18 also have rollout-order constraints.
- Two decisions are yours: whether to move Sidekiq to 7.3.3 or later (item 19), and when to adopt `load_defaults 8.1`.

Do you want me to implement it? If so, I'd suggest starting with the 7.0-compatible repairs first and then the bump.