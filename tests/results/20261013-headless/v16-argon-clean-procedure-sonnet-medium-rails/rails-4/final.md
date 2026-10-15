# Upgrade plan: rails 7.0.8.7 to 8.1.0 (Margin Notes, `load_defaults 7.0`)

Nothing was changed in `/home/user/workspace/repo`. Cleanup ran and `git status` there is clean. All repairs below were applied only in the disposable `upgraded` copy and, for the compatible ones, the `baseline` copy.

**Test results**
- Baseline 7.0.8.7: 46 runs, 325 assertions, 0 failures.
- Raw 8.1.0: boot fails on `config/initializers/action_text.rb:3`.
- Repaired 8.1.0 under `load_defaults 7.0`: 46 runs, 340 assertions, 0 failures.
- Repaired 8.1.0 under `load_defaults 8.1`: 46 runs, 340 assertions, 0 failures (this includes the default-adoption repairs in section 2).
- Baseline with every compatible repair applied (Findings 1-2, 4-18, none of the 8.1-only ones) passes the same 46-run suite, 325 assertions.

**Locked versions after the bump**
- All Rails components go from 7.0.8.7 to 8.1.0.
- `rack` stays at 2.2.24. `sidekiq 6.5.12` requires `rack ~> 2.0`, so `gem-changes`' Rack 3 findings do not apply.
- `rack-session` is added at 1.0.2, `json` at 3.1.0 (see Finding 2), and `action_text-trix` at 2.1.19.
- Also added: `bigdecimal 4.1.3`, `drb`, `securerandom`, `uri`, `useragent`, `rackup`, `webrick`.
- `method_source` is removed.
- `net-imap` moves from 0.6.7 to 0.6.8.

**Route diff:** the 63 application routes are identical to baseline, including the `notes` and `journal` names. Only the dev-only ActionMailbox conductor routes differ (67 versus 63).

**Schema:** no `db/schema.rb` or data-format differences were observed. A raw read of the `preferences`, `tags`, and `settings` columns gave identical text on both versions.

## 1. Required changes for the upgrade

Each of these takes effect on the bump. Unless stated otherwise, each failed on `upgraded` without the repair and passed with it.

### Finding 1: Action Text allowlist initializer fails at boot
- **Affected code:** `config/initializers/action_text.rb:3`.
- **What breaks:** boot and every test fail with `NoMethodError: undefined method '+' for nil`. `ActionText::ContentHelper.allowed_tags` is nil by default in 8.x, and the sanitizer computes the default list lazily.
- **Applicability:** immediately on the bump. The repair also works on 7.0.8.7.
- **Repair:** replace line 3 with the following. Do not assign only `%w[details summary]`, because that would drop every default safe tag.
  ```ruby
  helper = ActionText::ContentHelper
  helper.allowed_tags = helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  ```
- **Validation:** `NotesControllerTest` "rich text keeps collapsible excerpts and drops unsafe markup" passes and asserts `.trix-content details summary`. The control is that the same test still drops unsafe markup, so the defaults remain in effect.

### Finding 2: `json 3.1.0` is incompatible with `activesupport 8.1.0`
- **Affected code:** `Gemfile` and `Gemfile.lock`. It surfaces at `app/models/note.rb:12` (`serialize :tags`) and in every `ActiveSupport::JSON.decode` call.
- **What breaks:** the resolver adds `json 3.1.0`. `ActiveSupport::JSON.decode('{"a":1}')` then raises `ArgumentError: wrong number of arguments (given 2, expected 1)`. Baseline uses default json 2.7.2 and returns `{"a"=>1}`. Reading any `Note` raised the same error from `ActiveRecord::Coders::JSON.load`.
- **Applicability:** immediately on the bump. Rolling back needs no data change.
- **Repair:** add `gem "json", "~> 2.7.2"` to `Gemfile`. In the workspace, `bundle lock --local` then resolved `json 2.7.2` with no other changes. Do not use json 3.x with Rails 8.1.0. This may be fixed in a later 8.1.x release, which I did not check.
- **Validation:** the probe above on `upgraded` shows the error without the pin and `{"a"=>1}` with it. The control is that `JSON.parse` called directly worked on both.

### Finding 3: `enum` keyword form was removed
- **Affected code:** `app/models/note.rb:10`, `enum status: { draft: 0, ready: 1 }, _prefix: true`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when `Note` loads.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7.
- **Repair:** use `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Validation:** the `NotesControllerTest` filter-by-status test passes. `Note.status_ready` is still used by the `User` model, and the digest test covers it.

### Finding 4: `serialize :tags, JSON` signature changed
- **Affected code:** `app/models/note.rb:12`. `app/models/notebook.rb:7` (`serialize :preferences`) is not required for the bump.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` when `Note` loads.
- **Applicability:** immediately on the bump. `coder:` is not accepted on 7.0.8.7, so this repair cannot ship before the bump. Stored data is identical on both versions: the raw `tags` value is `["a","b"]` and the raw `preferences` value is `---\nexport_heading: Reading notes\n`. A YAML row written by 7.0 reads back correctly on 8.1.
- **Repair:** use `serialize :tags, coder: JSON`. Also use `serialize :preferences, coder: YAML`. That second change is optional under `load_defaults 7.0`, but under `load_defaults 7.1` or later it fails with `ArgumentError: missing keyword: :coder`.
- **Validation:** create a `Note` with `tag_list: "a, b"` and reload it. `tags` must equal `["a","b"]`. The control is that a notebook with `export_heading: "Reading notes"` reads back through the existing YAML.

### Finding 5: `alias_attribute :highlight_color, :color`
- **Affected code:** `app/models/note.rb:14`. It is used in `NotesController#note_params` (line 68) and in `notes/_form`, `notes/show` and `notes/index`.
- **What breaks:** `color` comes from `store_accessor`, not a column. Instantiating `Note` raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` The 7.2 change to `alias_attribute` bypassing custom methods is the cause.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Validation:** the `NotesControllerTest` tests that create and edit with `highlight_color: "green"` and `"blue"` pass and check the checked radio button. The control is that a blank colour is still allowed. The `alias_attribute` query helpers such as `highlight_color?` are not used anywhere in the app.

### Finding 6: `get "/notes", "/journal", to:` is rejected
- **Affected code:** `config/routes.rb:18`.
- **What breaks:** route drawing raises `ArgumentError: Wrong number of arguments (expect 1, got 2)`, so `routes=0` and `notes_path` is undefined.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7.
- **Repair:** use two lines, `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. The route names `notes` and `journal` are preserved, as the probe confirmed.
- **Validation:** `NotesControllerTest` "lists the reader's notes newest first at both list paths" requests `notes_path` and `journal_path`.

### Finding 7: `config/secrets.yml` and `Rails.application.secrets` are gone
- **Affected code:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117-122`, plus `ARCHITECTURE.md:79-80`, `CONTRIBUTING.md:38` and the header comment in `provider.rb`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Citation enrichment would have no provider settings.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7: with it applied, baseline passes all 46 runs.
- **Repair:**
  - Create `config/citation_provider.yml`. Use the same `ENV.fetch(...).to_json` ERB lines as `secrets.yml`, so values like `00123` and `sample: value # keep` stay quoted. Define `development`/`test` through a shared anchor, and `production` with `ENV[...]`.
  - Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  - Change the default argument in `Provider#initialize` to `Rails.configuration.x.citation_provider.to_h`.
  - Point the test at `Rails.configuration.x.citation_provider`.
  - Delete `config/secrets.yml` and update the three docs.
- **Validation:** the three `CitationEnrichmentsControllerTest` tests that call `with_provider` pass, including the one that boots a fresh `bin/rails runner` with `CITATION_PROVIDER_USER=00123` and `CITATION_PROVIDER_PASSWORD="sample: value # keep"`. The control is the unchanged production behaviour: a blank `CITATION_PROVIDER_URL` still raises `Error`.

### Finding 8: `where(notebooks: @notebook)` on `current_user.notes`
- **Affected code:** `app/controllers/notes_controller.rb:12`.
- **What breaks:** `ActiveRecord::StatementInvalid: PG::UndefinedColumn: column notes.notebooks does not exist`. The notebook filter on the notes list returns a 500.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7.
- **Repair:** use `@notes.where(notebook_id: @notebook.id)`.
- **Validation:** `NotesControllerTest` "filters by notebook, status, and title" and "pages through filtered notes newest first" pass. The control is an unfiltered request, which still returns every note.

### Finding 9: `Array#sum` no longer concatenates strings
- **Affected code:** `app/models/export.rb:42`, `finish(fragments.sum)`.
- **What breaks:** `TypeError: String can't be coerced into Integer`, so every export job fails. The baseline log shows the matching 7.0 deprecation: "Enumerable.sum ... Sum of non-numeric elements requires an initial argument".
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7, and the output is the same string.
- **Repair:** use `finish(fragments.join)`.
- **Validation:** `ExportsControllerTest` "a reader exports a notebook as Markdown and downloads it until it expires" compares the downloaded body. The control is the cancelled export, which still writes no file.

### Finding 10: `form_with(model: nil)`
- **Affected code:** `app/views/notes/index.html.erb:12`.
- **What breaks:** `ArgumentError: Passed nil to the :model argument, expect an object or false`, so `GET /notes` returns a 500.
- **Applicability:** immediately on the bump. `model: false` also works on 7.0.8.7.
- **Repair:** use `form_with(model: false, url: notes_path, method: :get, ...)`.
- **Validation:** `NotesControllerTest` "renders an unbound search form" asserts `form[role=search][action="/notes"][method=get]`. Control: the form still sends no `note[...]` parameters.

### Finding 11: `show_exceptions = false` in the test environment
- **Affected code:** `config/environments/test.rb:31`.
- **What breaks:** exceptions are rendered as 500 pages instead of raised. Five tests fail with "ActiveRecord::RecordNotFound expected but nothing was raised".
- **Applicability:** immediately on the bump. `:none` is not valid on 7.0.8.7, so this cannot ship early.
- **Repair:** use `config.action_dispatch.show_exceptions = :none`.
- **Validation:** `NotesControllerTest` "another reader's notes and notebooks cannot be reached" asserts `ActiveRecord::RecordNotFound`. Control: the unauthorised tests in `ImportsControllerTest` and `RemindersControllerTest` raise the same way.

### Finding 12: `Import#apply` returns from inside `transaction`
- **Affected code:** `app/models/import.rb:50-61` (the `return false` is at line 56).
- **What breaks:** a non-local return from `transaction` now commits. Applying a CSV with an invalid row leaves a saved `Import` and a saved good note. `record_counts` went from the expected `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. The test "invalid rows are shown with their errors, and applying them saves nothing" fails.
- **Applicability:** immediately on the bump (7.1 behaviour, kept in 7.2 and later). The repair works on 7.0.8.7. `Export#generate` also uses `return`, but not inside a transaction or lock, so it is unaffected.
- **Repair:**
  ```ruby
  saved = false
  transaction do
    save!
    saved = rows.all? { |row| row.note.save }
    raise ActiveRecord::Rollback unless saved
  end
  saved
  ```
- **Validation:** the CSV with `Adam Bede` as a good row and a blank-title, `not-a-doi` row must leave `record_counts` unchanged. Control: the valid two-row CSV still creates 2 notes, 1 citation and 1 import.

### Finding 13: `retry_on ... wait: :exponentially_longer` was removed
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised from `Citation#request_enrichment` (`citation.rb:20`).
- **Applicability:** immediately on the bump. The lambda below also works on 7.0.8.7.
- **Repair:** use `wait: ->(executions) { executions**4 + 2 }`, which matches the old delays. `:polynomially_longer` is the alternative, but it needs 7.1 or later.
- **Validation:** `CitationEnrichmentsControllerTest` "a provider that stays unavailable or refuses the request leaves a visible failure" passes. Control: the retry-once-on-503 test passes.

### Finding 14: `set(wait_until:)` requires a `Time`
- **Affected code:** `app/models/note.rb:61`.
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. No reminder can be scheduled, which also breaks postponing.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7.
- **Repair:** use `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`.
- **Validation:** the reminder test asserts the job's `:at` equals `Time.utc(2026, 10, 31, 13).to_i`. Control: the imported-reminder epoch `1_793_451_617` is scheduled at that exact second.

### Finding 15: `HashWithIndifferentAccess#stringify_keys` now converts Integer keys
- **Affected code:** `app/views/imports/preview.html.erb:22`, `app/models/import.rb:39-41`.
- **What breaks:** the keys become `"2"` and `"4"`, but `annotations[row.line]` looks them up by Integer. The Annotation row silently disappears from the preview. The `assert_select "#line_2 dd"` test failed with "Expected: 'Read <b>twice</b> & reflect' Actual: '10.1000/Essays.1'". I confirmed in the rendered HTML that the Annotation `<dt>` and `<dd>` were missing.
- **Applicability:** immediately on the bump (7.1 change). The repair works on 7.0.8.7.
- **Repair:** use `<% annotations = @import.annotations %>`, with no `stringify_keys`.
- **Validation:** the preview must show the annotation `Read <b>twice</b> & reflect` on line 2 and `Compare with Bacon` on line 4. Control: a row without an annotation shows no Annotation `<dd>`.

### Finding 16: `citation[:id]` no longer returns the DOI primary key
- **Affected code:** `app/models/import.rb:68`, in `Import#receipt`.
- **What breaks:** the receipt CSV has blank DOIs. The test expects `On idleness,10.1000/Essays.1` and gets `On idleness,`.
- **Applicability:** immediately on the bump. `citation&.doi` works on 7.0.8.7.
- **Repair:** use `citation&.doi`.
- **Validation:** `ImportsControllerTest` compares the full receipt body. Control: a note with no citation still gets a blank DOI column.

### Finding 17: Active Job now keeps the reader's time zone
- **Affected code:** `app/mailers/digest_mailer.rb:8-9`, `app/jobs/digest_job.rb`, and `User#request_digest` at `app/models/user.rb:41`.
- **What breaks:** from 7.2 the `TimeWithZone` payload carries `"time_zone": "America/New_York"`. The worker now sees the reader's local time, where 7.0 produced UTC. A reader in Eastern time who requests at `2026-10-05 03:30 UTC` gets the subject "October 04, 2026" instead of "October 05, 2026", and the digest covers the wrong day. This contradicts the app's documented UTC-day rule. The digest test failed with this exact difference.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7, where `.utc` changes nothing.
- **Repair:** add `requested_at = requested_at.utc` before `@date = requested_at.to_date` in `DigestMailer#daily_digest`.
- **Validation:** a reader in "Eastern Time (US & Canada)" with a note updated at `Time.utc(2026,10,5,3,0)`, requested at `Time.utc(2026,10,5,3,30)`. The subject must read "October 05, 2026" and the body must list that note. Control: a reader in UTC is unchanged.

### Finding 18: `BigDecimal` job arguments use a new serializer (rollback hazard)
- **Affected code:** `app/models/user.rb:41` and `app/jobs/digest_job.rb`.
- **What changes:** 7.0 puts `"0.5"` (a string) in the queue. 8.1 puts `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. I fed that 8.1 payload to the baseline: `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. A job queued by 8.1 therefore fails on a 7.0 worker, during a rolling deploy or a rollback. The 7.0 payload deserializes fine on 8.1.
- **Applicability:** from the first process running 8.1. The repair is safe on 7.0.8.7, because it keeps the payload shape unchanged.
- **Repair:** in `User#request_digest`, pass `reading_completion.to_s` to `DigestJob.perform_later`. `BigDecimal(params[:completion])` in the mailer already accepts a string.
- **Validation:** a Sidekiq-adapter probe on both versions produced the identical third argument `"0.0"`, with no `BigDecimalSerializer` in the payload. Control: the digest test still shows "50% of your notes were ready".

### Finding 19: `Note#next_day_reminder_at` display changes
- **Affected code:** `app/models/note.rb:44`, shown in `app/views/notes/_reminder.html.erb:19`.
- **What changes:** `TimeWithZone#to_time` is now DST-aware (`ActiveSupport.to_time_preserves_timezone` is nil on 8.1). For a reminder at `2026-10-31 09:00 -04:00`, the preview shows `2026-11-01T08:00:00-05:00`, where baseline shows `2026-11-01T09:00:00-04:00`. It is the same instant, so `postpone_reminder`'s `.to_i` is unaffected. The reminder test asserts the old value and failed.
- **Applicability:** immediately on the bump. The repair works on 7.0.8.7.
- **Repair:**
  ```ruby
  reminder = reminder_at
  Time.at(reminder.to_i + 86_400).localtime(reminder.utc_offset)
  ```
- **Validation:** `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]` for that reminder. Control: `postpone_reminder` still enqueues exactly 24 hours later.

### Finding 20: Built-in Sidekiq adapter is deprecated
- **Affected code:** `config/application.rb:24`, `config.active_job.queue_adapter = :sidekiq`, and `Gemfile` (`sidekiq 6.5.12`, `redis 4.8.1`).
- **What changes:** boot prints "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later". It works on 8.1.0. The adapter is still present and loaded.
- **Applicability:** a warning on the bump. Staying on 8.1 is fine, but 8.2 will need Sidekiq 7.3.3 or later. That upgrade also involves `redis-client` and the `Redis::BaseError` and `redis.sadd` calls in `Notebook#request_export` and `User#request_digest`.
- **Repair:** none for this bump. Plan a separate Sidekiq 7 upgrade.

### Other changes
- **Rails 7.1 `cache_classes` rename:** the Rails 7.1 guide recommends `enable_reloading`. `config.cache_classes` still boots and tests with no warning on 8.1, so this is optional cleanup.
- **Warnings seen after repairs:**
  - `csv` will leave the default gems in Ruby 3.4. `app/models/import.rb:1` requires it, so add it to the `Gemfile` when moving to Ruby 3.4.
  - Sidekiq prints "Job arguments to ExportJob do not serialize to JSON safely".
  - Redis 5 `sadd` and `srem` warnings.
  - All three already appear on baseline. No Rails deprecations remain under `load_defaults 7.0`.

## 2. New configuration defaults across intermediate releases

`config/application.rb:12` sets `load_defaults 7.0`, so none of the defaults below are active. The only explicit settings in `config/` are `cache_classes`, `eager_load`, `show_exceptions`, `cache_store`, `queue_adapter` and `report_deprecations`. The app does not use `encrypts`, `has_secure_token`, `render json:`, `after_commit`, or custom cookies. I ran `--defaults` for 7.1, 7.2, 8.0 and 8.1 on the repaired app, and with the Section 1 repairs only the first three rows below failed.

| Release | Default | Effect on this app if adopted | What to configure |
|---|---|---|---|
| 7.1 | `active_record.raise_on_assign_to_attr_readonly = true` | `ActiveRecord::ReadonlyAttributeError: slug` at `NotebooksController#update`, because the settings form resubmits `slug` (`app/controllers/notebooks_controller.rb:40`). | Remove `:slug` from the `permit` list. The hidden field in the view can stay. |
| 7.1 | `active_record.default_column_serializer = nil` | `serialize :preferences` fails with "missing keyword: :coder". | `coder: YAML`, as in Finding 4. |
| 7.1 | `active_support.raise_on_invalid_cache_expiration_time = true` | `Cache expiration time is invalid, cannot be negative: -60.0`, raised from `app/views/exports/_export.html.erb:26` for an expired export. | Use `expires_in: [export.expires_at - Time.current, 0].max`. |
| 7.2 | `active_record.postgresql_adapter_decode_dates = true` | `TypeError: no implicit conversion of Date into String` at `Notebook#daily_note_counts` (`notebook.rb:40`), because `DATE(...)` now returns a `Date`. | Use `Date.iso8601(day.to_s)`. It works on both versions. |
| 7.1 | `active_support.message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true`, and `cache_format_version = 7.1` | Signed and encrypted payloads and cache entries change format. Active Storage blob and signed-id URLs also use the message verifier. | Adopt only after every process is on 8.1, through the two-step rotation. A 7.0 process cannot read the new format, so rollback would invalidate sessions and Active Storage URLs. |
| 7.1 | `marshalling_format_version = 7.1`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `generate_secure_token_on`, `belongs_to_required_validates_foreign_key`, `encryption.*` | No effect found. The app has no `after_commit`, `has_secure_token` or `encrypts`, and it caches strings rather than Active Record objects. | No change needed. |
| 7.1 | `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `dom_testing_default_html_version = :html5`, `sanitizer_vendor` HTML5, `default_headers` (drops `X-Download-Options`), `log_file_size`, `debug_exception_log_level` | The suite passed under 7.1 defaults. Rich-text sanitising and assertions are unchanged. | `sanitizer_vendor` and the new header set are optional. |
| 7.2 | `yjit = true` | Enables YJIT on Ruby 3.3.6 if built with it. Not tested. | Optional. |
| 7.2 | `active_storage.web_image_content_types`, `validate_migration_timestamps` | No effect. The migration timestamps are in the past. | None. |
| 8.0 | `action_dispatch.strict_freshness = true` | Affects `stale?(etag:, last_modified:)` in `ExportDownloadsController`. The suite passed. A client sending only `If-Modified-Since` is the case to try. | None. |
| 8.0 | `Regexp.timeout ||= 1` | The DOI regex is linear, so no effect. | None. |
| 8.1 | `escape_json_responses = false`, `action_on_path_relative_redirect = :raise`, `raise_on_missing_required_finder_order_columns`, `escape_js_separators_in_json`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete`, `yjit` (non-local only) | No `render json:`, no relative redirects, and no keyless-table `first` or `last` calls. `render_tracker` can change fragment digests, so the export fragment cache would be recomputed once. The suite passed. | None required. |

No setting in this app is deprecated or removed by a later release in the range, except as listed in section 1: `config.cache_classes` (7.1 rename, optional) and `show_exceptions = false` (Finding 11).

## 3. Rollout, rollback, and mixed-version risks

- **Database and `db/schema.rb`:** no migration is needed, and stored rows are byte-identical on both versions. One run of `db:schema:dump` on 8.1 would sort columns alphabetically only under `load_defaults 8.1`. Every `ActiveRecord::Schema[7.0]` header still loads.
- **Redis fragment cache:** I wrote entries on each version with `FileStore`, and each read the other's entries correctly. 8.1 keeps format 7.0 under `load_defaults 7.0`. That test used a string and a hash, not the app's view-digest keys, so I cannot say whether the Rails 8.1 template digest would force a one-time recompute.
- **Sidekiq and Active Job payloads:**
  - 8.1 adds `scheduled_at` and `time_zone` to the payload. 7.0 ignores both and keeps UTC, which is its existing behaviour.
  - 7.0 payloads deserialize correctly on 8.1.
  - The only breaking shape is the `BigDecimalSerializer` one (Finding 18). The repair avoids it.
  - Queued `ExportJob` is a native Sidekiq job, not an Active Job, so it is unaffected.
- **Signed and encrypted cookies and tokens:** under `load_defaults 7.0` the serializer settings remain at Marshal, with `cookies_serializer = :json`. In theory they stay compatible both ways. I could not verify this: my cookie probe failed even within one version (the `encrypted` read returned nil on both), so treat it as unverified. Do not adopt the 7.1 message-serializer defaults on the same release.
- **Gems that move at the same time:** `rack` stays on 2.2.24. `json` must be pinned (Finding 2).
- **What can ship on 7.0.8.7 before the bump (verified: 46 runs, 0 failures on baseline):**
  - Findings 1, 3, 5-10, and 12-19.
  - These Section 2 repairs: the `slug` permit, `Date.iso8601(day.to_s)`, and the cache-expiry clamp.
- **What must wait for the bump:**
  - `coder:` on `serialize`.
  - `show_exceptions = :none`.
  - `json` pin (not needed on 7.0).

## 4. Verification log and open questions

**Executed in `upgrade-workspace`** (`/tmp/upgrade-rails-8.1.0`, deleted at cleanup). The setup logs were in `/tmp/upgrade-rails-8.1.0/logs`: `bundle-update.log`, `diag-*.log`, `schema-load-*.log`, `tests-baseline.log`, `tests-upgraded.log`, `tests-upgraded-defaults-8.1.log`.
- `gem-changes rails 7.0.8.7 8.1.0` and `upgrade-workspace setup`. The raw 8.1.0 run failed boot and the whole suite (see the top of this plan).
- Repairs applied one at a time with `upgrade-workspace test`, each time reading the next failure. A temporary debug test confirmed the missing Annotation `<dd>` in Finding 15 (removed afterwards).
- `bundle lock --local` with the `json ~> 2.7.2` pin resolved `json 2.7.2`.
- Probes run on both versions: route names, JSON decode, `serialize`/`enum`/`alias_attribute` declarations, YAML and JSON raw column text, Active Job argument round trips, Sidekiq payloads, FileStore cross-reads, and `to_time` DST offsets.
- Test runs: baseline 46 runs, 325 assertions, 0 failures; baseline with the compatible repairs, 46 runs, 325 assertions, 0 failures; repaired upgraded, 340 assertions, 0 failures under `load_defaults 7.0` and `8.1`; `--defaults 7.1/7.2/8.0` only showed the three default-adoption failures in section 2.

**Based on reading source only**
- The `ActionText::ContentHelper` behaviour in `actiontext-8.1.0`.
- The load_defaults table in `railties-8.1.0/lib/rails/application/configuration.rb`.
- Which defaults have no effect on this app.

**Not verified**
- Cookie and session compatibility across versions (probe failed).
- Fragment-cache digest keys across versions.
- Browser behaviour: `bin/rails test:system` was not run. `config/importmap.rb` pins `@rails/actiontext` but no `trix`, and Rails 8.1 uses the `action_text-trix 2.1.19` gem. Check the rich-text editor in a browser.
- The `strict_freshness` default with a client sending only `If-Modified-Since`.
- `yjit = true` on this Ruby build.
- Whether json 3.x is fixed in a later 8.1.x release.

**Open questions**
- Should the Sidekiq 7 upgrade (needed before Rails 8.2) be planned in the same window?
- Should the `config.cache_classes` rename to `enable_reloading` be done now?

---

I haven't implemented anything. The working tree is unchanged, and the skill only covers planning. Tell me if you want me to apply it. I'd suggest two steps:

1. First ship the changes that also work on 7.0.8.7: Findings 1, 3, 5–10 and 12–19.
2. Then do the bump itself, which covers the `json` pin, `coder:` on `serialize`, and `show_exceptions = :none`.