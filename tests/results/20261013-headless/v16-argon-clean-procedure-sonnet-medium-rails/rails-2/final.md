# Upgrade plan: rails 7.0.8.7 to 8.1.0 for Margin Notes

The bump cannot ship as-is: with only the Gemfile changed, the app fails to boot. The planner fixed it inside `/tmp/upgrade-rails-8.1.0/upgraded` until all 46 tests passed under both `load_defaults 7.0` and `load_defaults 8.1`. It then deleted the workspace and confirmed the working checkout is clean (git status clean). Line numbers below refer to the working checkout.

**Bottom line**
- Most breakages are caught by the existing tests, but three are not: the `serialize` coder change, the new `Time#to_time` behavior, and the rollout and rollback risks.
- Several repairs can ship on 7.0.8.7 before the bump. Four cannot: the `serialize` coder form, `show_exceptions = :none`, `polynomially_longer`, and the Gemfile bump itself.
- `Gemfile.lock` pins `rack` at 2.2.24 and `sidekiq` at 6.5.12. The Rack 3 findings from `gem-changes` do not apply to this bump.
- Resolved versions in the upgraded lock: `rails`, `activerecord` and the other Rails components 8.1.0; `json` 3.1.0 as resolved and 2.7.2 after the pin; `bigdecimal` 4.1.3; `rack` 2.2.24; `rack-session` 1.0.2 (needs `rack < 3`); `rackup` 1.0.1; `puma` 5.6.9; `sidekiq` 6.5.12; `redis` 4.8.1; `action_text-trix` 2.1.19 added; `method_source` removed.

## 1. Required changes for the upgrade

Baseline (7.0.8.7) ran 46 tests, 0 failures. The unmodified upgrade failed at boot, and the later runs hit the next failure each time one was fixed.

### 1.1 Boot failure in the Action Text initializer
- **Affected code:** `config/initializers/action_text.rb:3`.
- **What breaks:** `NoMethodError: undefined method '+' for nil`. `ActionText::ContentHelper.allowed_tags` is nil in 8.1 until first use, so boot, the schema load and the test suite all abort.
- **Applicability:** Immediately on the bump. The repair also works on 7.0.8.7, so it can ship first.
- **Repair:** Replace the file's body with the line below. It reproduces what 7.0 computed and adds the app's tags.
  ```ruby
  ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ] + %w[ details summary ]
  ```
- **Validation:** The tag set has 48 entries on both versions, and `details`, `summary` and `figure` are all present. Probe input `<div>a<details><summary>S</summary>b<script>alert(1)</script><a href="javascript:x" onclick="y">l</a></details>...</div>` renders the same output on both versions: the script tag is stripped, the `javascript:` href and `onclick` are dropped, and `details` and `summary` are kept. `NotesControllerTest` "rich text keeps collapsible excerpts and drops unsafe markup" passes under both default sets.

### 1.2 `json` 3.1.0 breaks Active Support's JSON decoding
- **Affected code:** every read of the `notes.settings` jsonb column, via `store_accessor :settings, :color` at `app/models/note.rb:13`.
- **What breaks:** The 8.1 resolution adds `json 3.1.0`. `ArgumentError: wrong number of arguments (given 2, expected 1)` is raised at `json-3.1.0/lib/json/common.rb:291`, called from `activesupport-8.1.0/.../json/decoding.rb:25`. It surfaces on `Note.create!(color: ...)` and on every notes page.
- **Applicability:** Immediately on the bump. It follows from the resolved `json` version; `activesupport` 8.1.0 passes `JSON.parse` a positional options hash that `json` 3.1.0 rejects.
- **Repair:** Add `gem "json", "2.7.2"` to the Gemfile and re-lock. This is the default gem for Ruby 3.3.6.
  - Only 2.7.2 and 3.1.0 were installed locally, so a wider range such as `"~> 2.7"` is unverified.
  - The pin can be added on 7.0.8.7 (not run on baseline), since 7.0 does not depend on `json`.
- **Validation:** Without the pin, `Note.create!(title:, color: "green")` raised the error above. With it, the test suite runs to completion.

### 1.3 `enum` keyword form removed
- **Affected code:** `app/models/note.rb:10`, `enum status: { draft: 0, ready: 1 }, _prefix: true`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at class load. All 46 tests errored.
- **Applicability:** Immediately on the bump. The positional form works on 7.0.8.7.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
  - `Note.statuses`, `status_draft?` and `status_ready` keep working.
  - The notes filter `Note.statuses.key?(params[:status])` and `User#reading_completion` use them.
- **Validation:** A probe on both versions returned `true` for `status_ready?`. The notes filter test passes.

### 1.4 `serialize` signature and YAML default
- **Affected code:** `app/models/note.rb:12`, `serialize :tags, JSON`, and `app/models/notebook.rb:7`, `serialize :preferences`.
- **What breaks:**
  - With the unchanged positional form, `serialize :tags, JSON` raises `ArgumentError: wrong number of arguments (given 2, expected 1)` at `activerecord-8.1.0/.../serialization.rb:193`.
  - `serialize :preferences` still works under `load_defaults 7.0`. Under 7.1 or later defaults (see 2.2) it raises `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'.`
- **Applicability:** Immediately for `tags`, and when adopting `load_defaults` for `preferences`. **Do not ship this repair before the bump.**
  - On 7.0.8.7, `serialize :tags, coder: JSON` silently ignores the keyword and stores YAML. The probe returned `"---\n- a\n"` instead of `"[\"a\"]"`, which corrupts the JSON data 8.1 expects.
  - 8.1 with `coder: JSON` stores the same JSON text as today, so existing rows stay readable in both directions.
- **Repair (in the bump commit):** `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
- **Validation:** On 8.1, `attribute_types["tags"].serialize(["a"])` returns `"[\"a\"]"`. A notebook with `export_heading` saves and reloads. The control is `NotebooksControllerTest` settings update.

### 1.5 `alias_attribute` to a `store_accessor` key
- **Affected code:** `app/models/note.rb:14`, `alias_attribute :highlight_color, :color`. The alias is used in the note form, the index and show views, and `NotesController#note_params`.
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` This is raised the first time any `Note` is instantiated.
- **Applicability:** Immediately on the bump. The repair works on 7.0.8.7.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
  Both lines are needed because the form assigns through `highlight_color=`.
- **Validation:** The notes create and edit tests assert `note[highlight_color]` radios with green and blue, and pass. The control is a note with no color.

### 1.6 `get` with several paths removed
- **Affected code:** `config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`.
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2)` while drawing routes. The baseline route names are `notes` and `journal`.
- **Applicability:** Immediately. The repair works on 7.0.8.7.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
  `notes_path` and `journal_path` keep their names.
- **Validation:** `NotesControllerTest` "lists the reader's notes newest first at both list paths" requests both paths and passes.
- **Routes diff:** After the repair, 63 routes against 67 on baseline. The four missing are Rails-internal `/rails/conductor/action_mailbox/inbound_emails` routes. No application route differs.

### 1.7 `Rails.application.secrets` removed
- **Affected code:** `app/models/citation/provider.rb:13` and `config/secrets.yml`. It is also referenced at `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`, `ARCHITECTURE.md:79`, `CONTRIBUTING.md:38` and `bin/citation-provider:15`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Every `Citation::Provider.new`, and so every enrichment lookup, fails.
- **Applicability:** Immediately. The repair works on 7.0.8.7 (checked on the baseline copy).
- **Repair:**
  1. Move the settings to `config/citation_provider.yml` with `default`, `development`, `test` and `production` keys, keeping the same `ENV` and `.to_json` lines.
  2. Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  3. Change `Provider#initialize` to use `Rails.application.config.x.citation_provider.to_h`.
  4. Change the test to read and write `Rails.application.config.x.citation_provider`.
  5. Delete `config/secrets.yml` and update the two docs and the `bin/citation-provider` comment.
- **Validation:** All four `CitationEnrichmentsControllerTest` cases pass. The "credentials reach the server unchanged" case boots a fresh process with `CITATION_PROVIDER_USER=00123` and the password `sample: value # keep`. The control is the test's local Puma stand-in server.

### 1.8 `config.action_dispatch.show_exceptions = false` no longer works
- **Affected code:** `config/environments/test.rb:31`.
- **What breaks:** Tests that expect exceptions see responses instead. Five tests failed with `ActiveRecord::RecordNotFound expected but nothing was raised.` and `Expected response to be a <422: unprocessable_entity>, but was a <302: Found>`.
- **Applicability:** Immediately, in tests only. **This cannot ship before the bump**, because `:none` is treated as true on 7.0 and would render error pages.
- **Repair (in the bump commit):** `config.action_dispatch.show_exceptions = :none`.
- **Validation:** The five tests pass. The control is `NotesControllerTest` "another reader's notes cannot be reached".

### 1.9 `Enumerable#sum` on strings
- **Affected code:** `app/models/export.rb:42`, `finish(fragments.sum)`.
- **What breaks:** `TypeError: String can't be coerced into Integer`. `Export#generate` and `ExportJob` fail, so no export completes.
- **Applicability:** Immediately. 7.0 returns `"ab"` with a deprecation warning, so the repair works on 7.0.8.7.
- **Repair:** `finish(fragments.join)`.
- **Validation:** The Markdown export-and-download test passes. The control is the cancelled-export test, which keeps no file.

### 1.10 Transactions commit on non-local `return`
- **Affected code:** `app/models/import.rb:51-61`, `Import#apply`, with `return false unless row.note.save` inside `transaction do`.
- **What breaks:** On 8.1 the `return` commits instead of rolling back. With a CSV whose second row is invalid, an import saves the import row and a partial note. Counts `[imports, notes, citations, ...]` went from the expected `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. This breaks the documented rule of saving all rows or nothing.
- **Applicability:** Immediately, even under `load_defaults 7.0`. The repair works on 7.0.8.7.
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
- **Validation:** The invalid-rows import test shows unchanged counts after repair. The control is the happy-path import, which saves two notes and one citation.
- **Other `return` sites:** The remaining `return` statements (`app/models/export.rb:34,39`, `app/models/import.rb:51,76`) were checked. None is inside a transaction or `with_lock` block.

### 1.11 `HashWithIndifferentAccess#stringify_keys` now converts integer keys
- **Affected code:** `app/views/imports/preview.html.erb:22` with `Import#annotations` at `app/models/import.rb:38-42`, which are keyed by integer line number.
- **What breaks:** On 8.1, `{2=>"x"}.stringify_keys` gives `{"2"=>"x"}`, while `h[2]` still looks up an integer. The Annotation row silently disappears from the preview. The test asserted `#line_2 dd` and saw only the DOI.
- **Applicability:** Immediately. Dropping `.stringify_keys` works on 7.0.8.7.
- **Repair:** `<% annotations = @import.annotations %>`.
- **Validation:** The preview test shows "Read <b>twice</b> & reflect" in `#line_2 dd`. The control is a line with no annotation.

### 1.12 Active Job `wait_until` needs a `Time`
- **Affected code:** `app/models/note.rb:61`, `NoteReminderJob.set(wait_until: reminder_epoch)`.
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Scheduling or postponing a reminder returns a 500.
- **Applicability:** Immediately. `Time.at(...)` works on 7.0.8.7.
- **Repair:** `wait_until: Time.at(reminder_epoch)`.
- **Validation:** The reminder tests assert the job's `:at` equals `Time.utc(2026,10,31,13).to_i`, and pass.

### 1.13 `retry_on wait: :exponentially_longer` removed
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised at the first retry.
- **Applicability:** Immediately. `:polynomially_longer` does not exist on 7.0.
- **Repair:** `wait: ->(executions) { executions**4 + 2 }`. It works on both versions, so it can ship first.
- **Validation:** The "retrying one unavailable response" test passes. It was failing before the repair.

### 1.14 Date, time and primary-key `[]` behavior
- **Reminder preview.**
  - **Affected code:** `app/models/note.rb:44`, `next_day_reminder_at`, used by `app/views/notes/_reminder.html.erb`.
  - **What changes:** `reminder_at.to_time` now keeps the zone object, so `+ 86_400` follows DST. The postpone preview shows `2026-11-01T08:00:00-05:00` where baseline shows `2026-11-01T09:00:00-04:00`. The instant is identical (`to_i` is 1793538000 on both), but the displayed text changes and the test fails.
  - **Applicability:** Immediately.
  - **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`.
  - **Validation:** An Eastern-time reader was probed with three epochs: `2026-10-31 13:00 UTC`, `2026-03-07 14:00 UTC` and `2026-06-01 12:00 UTC`. Both versions returned `2026-11-01T09:00:00-04:00`, `2026-03-08T09:00:00-05:00` and `2026-06-02T08:00:00-04:00`, with a delta of 86400 each time. The reminder test passes.
- **Import receipt.**
  - **Affected code:** `app/models/import.rb:68`, `citation && citation[:id]`.
  - **What changes:** `Citation` has the primary key `doi`. `citation[:id]` returns the DOI on 7.0 and nil on 8.1, so the receipt CSV shows empty DOI cells (`On idleness,` instead of `On idleness,10.1000/Essays.1`).
  - **Applicability:** Immediately.
  - **Repair:** `citation&.doi`, which works on 7.0.8.7.
  - **Validation:** The receipt assertion passes.
- **Digest date and completion.**
  - **Affected code:** `app/mailers/digest_mailer.rb:8` and `app/models/user.rb:41`.
  - **What changes:** Active Job now keeps the time zone, so the worker receives `2026-10-04 23:30 -0400` instead of UTC. The digest subject changed from "October 05, 2026" to "October 04, 2026", and the `all_day` window shifts to the reader's local day. This contradicts the documented UTC-day rule.
  - **Applicability:** Immediately. See section 3 for the mixed-version payload issue.
  - **Repairs:**
    - In the mailer: `requested_at = requested_at.in_time_zone("UTC")` before `@date = ...`.
    - In `User#request_digest`: `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. Both work on 7.0.8.7.
  - **Validation:** The digest test (reader in Eastern time, request at `2026-10-05 03:30 UTC`) asserts the subject "October 05, 2026" and "50% of your notes were ready". It failed before the repair and passes with it.

### 1.15 `where(notebooks: record)` and `form_with(model: nil)`
- **Affected code:** `app/controllers/notes_controller.rb:12` and `app/views/notes/index.html.erb:12`.
- **What breaks:**
  - `PG::UndefinedColumn: column notes.notebooks does not exist` when filtering by notebook.
  - `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. This is raised on every `/notes` render and is the root error behind the notes index failures.
- **Applicability:** Immediately. Both repairs work on 7.0.8.7.
- **Repairs:** `@notes.where(notebook: @notebook)` and `form_with(model: false, ...)`.
- **Validation:** The filter test and the unbound search form test pass. The control is the unfiltered index.

### 1.16 Dependency changes and deprecations
- `method_source` is removed from `Gemfile.lock`. Nothing in the app uses it.
- `net-smtp` and `mini_mime` leave Rails' dependencies, but `mail` 2.9.1 still locks them. Check that production SMTP still loads, which was not done.
- `config.active_job.queue_adapter = :sidekiq` (`config/application.rb:24`) now logs: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later."
  - It works on 8.1 with `sidekiq` 6.5.12.
  - A later Sidekiq 7 upgrade will also reject the symbol-keyed hash in `Notebook#request_export` (`app/models/notebook.rb`, `ExportJob.perform_async(export.id, { format: "markdown" })`) under strict args. Passing `"format"` as a string would avoid that.
- `Rack` stays 2.2.24 because `sidekiq 6.5.12` requires `rack ~> 2.0`. The Rack 3 items from `gem-changes` (such as `Rack::Request#values_at` and the status and header rules) do not apply now. `app/mailers/digest_mailer.rb:7` uses `params.values_at` on mailer params, not `Rack::Request`.
- `bin/citation-provider` requires `rack/handler/puma`. That is fine on Rack 2 but will break on Rack 3.
- `puma` 5.6.9 was not exercised under a real server. `rails test` boots Puma only for the citation stub.
- **Schema dump:** `db/schema.rb` currently says `ActiveRecord::Schema[7.0]`. 8.1 dumps these differences:
  - header `Schema[8.1]`;
  - `enable_extension "pg_catalog.plpgsql"`;
  - alphabetically sorted columns in every table (about 129 lines).

  No schema content changes, and `dump_schema_after_migration` is false in production. Commit the re-dumped file with the bump.
- **Action Text front end:** The layout loads a vendored `trix-1.3.5.js` (`app/views/layouts/application.html.erb:13`), and the importmap pins `@rails/actiontext`. The 8.1 `actiontext.js` has no Trix import, but the editor could not be tested in a browser. `test/system` is empty and was not run.

## 2. New configuration defaults across intermediate releases

**Starting state:** `config/application.rb:12` has `config.load_defaults 7.0`, so none of the defaults below apply. The only explicit settings in `config/` are `config.action_dispatch.show_exceptions` (test, covered in 1.8), `config.cache_store = :null_store` (test, and dev unless `tmp/caching-dev.txt` exists), `config.active_job.queue_adapter` and `config.active_support.report_deprecations = false` (production).

**How it was checked:** The `load_defaults` branches in `railties-8.1.0` were read and the suite was run under `load_defaults 8.1`. With the 1.x repairs applied, it reached 340 assertions with 3 failures, listed below.

### 2.1 Releases 7.0.10 through 7.0.x
No new `load_defaults` branch was added.

### 2.2 Release 7.1 defaults

| Default | Effect in this app | Configure |
|---|---|---|
| `active_record.default_column_serializer = nil` | `serialize :preferences` raises `missing keyword: :coder`. | `coder: YAML` (see 1.4). |
| `active_record.raise_on_assign_to_attr_readonly = true` | `ActiveRecord::ReadonlyAttributeError: slug` from `app/controllers/notebooks_controller.rb:26`. The settings form resubmits `slug`, and `notebook_params` permits it. | Drop `:slug` from `permit` at line 40. |
| `active_support.raise_on_invalid_cache_expiration_time = true` | `ArgumentError: Cache expiration time is invalid, cannot be negative: -60.0` from `app/views/exports/_export.html.erb:26`, when an export has expired. | `expires_in: [export.expires_at - Time.current, 0].max`. |
| `active_support.cache_format_version = 7.1` | New fragment-cache entries cannot be read by 7.0 (see section 3). | Hold the old format until rollback is no longer needed. |
| `active_support.message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | Session cookies stayed interoperable in the test (see section 3). | None needed. |
| `active_record.run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records` | No commit callbacks in the app. | None. |
| `active_record.marshalling_format_version = 7.1` | Not exercised. The app marshals no records. | None. |
| `active_record.belongs_to_required_validates_foreign_key = false` | The "note cannot be filed in another reader's notebook" test still gets 422. | None. |
| `action_dispatch.default_headers` | The `X-Download-Options` header is no longer sent. | None. |
| `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` = HTML5 | The sanitizer class changes to `Rails::HTML5::SafeListSanitizer`. The probe output was identical except for one whitespace difference. | None. |
| `add_autoload_paths_to_load_path = false` | `lib/` has no Ruby files and nothing requires an autoloaded path. | None. |
| `dom_testing_default_html_version = :html5` | The suite passes. | None. |
| `precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level`, `query_log_tags_format` | No visible effect found. | None. |
| `generate_secure_token_on = :initialize` | No `has_secure_token`. | None. |
| Encryption digests | The app uses no `encrypts`. | None. |

- `cookies_serializer` is already `:json` from 7.0 defaults.
- `config.active_support.to_time_preserves_timezone` was in 7.0 defaults and is deprecated in 8.1 ("will be removed in Rails 8.2"). It does not change the `to_time` behavior in 1.14, which comes from the Rails 8 release itself.

### 2.3 Release 7.2 defaults
- `postgresql_adapter_decode_dates = true`.
  - **Effect:** `Note.connection.select_rows(...)` returns `Date` objects instead of strings. `Date.iso8601(day)` at `app/models/notebook.rb:40` then raises `TypeError: no implicit conversion of Date into String`, breaking the activity report.
  - **Configure:** `day.to_date`, which works on both types and on 7.0.8.7.
- `validate_migration_timestamps = true`. The newest migration is `20261011160000`, which is not in the future, so there is no effect.
- `web_image_content_types` has no effect. `yjit = true` enables YJIT for non-test boots, which was not measured.

### 2.4 Release 8.0 defaults
- `action_dispatch.strict_freshness = true`. No conditional GET code in the app.
- `Regexp.timeout ||= 1`. A ReDoS safeguard only; no long-running regex was found.

### 2.5 Release 8.1 defaults
- `action_controller.action_on_path_relative_redirect = :raise`. Every `redirect_to` uses a path helper, and the root route uses `redirect("/notes")`.
- `action_controller.escape_json_responses = false` and `active_support.escape_js_separators_in_json = false`. The app has no `render json:` calls.
- `active_record.raise_on_missing_required_finder_order_columns = true`. No `first` or `last` on models without a primary key.
- `action_view.render_tracker = :ruby`. The cache digest for `exports/_export` may change, which means a one-time fragment-cache miss.
- `action_view.remove_hidden_field_autocomplete = true`. A cosmetic change to hidden form fields.
- `yjit = !Rails.env.local?` has no effect in tests.

**Later deprecations or removals in the range:** All of the above remain valid through 8.1. The settings 8.1 flags for removal in 8.2 are the built-in Sidekiq adapter and `to_time_preserves_timezone`.

**Recommendation:** Bump the gem with `load_defaults 7.0` kept, then step to 7.1, 7.2, 8.0 and 8.1 one at a time. Apply the slug, cache-expiry, `select_rows` and coder repairs first. They are verified, each fits in a separate commit, and the first three can ship on 7.0.8.7 beforehand.

## 3. Rollout, rollback and mixed-version risks

All of these checks ran against both versions' real code with the same fixed secret.

- **Session cookies:** Fully interoperable. A cookie from 7.0.8.7 was accepted by 8.1 (7.0 and 8.1 defaults), and the reverse. Each got HTTP 200 on `/notes`. Readers stay signed in across rollout and rollback. This needs the same `secret_key_base`, which the production credentials already provide. A probe showed the derived key is identical (`8c055b60`) on both versions.
- **Cache entries:** With 7.0 defaults retained, 8.1 writes identical bytes to 7.0 (`0004085b...`) and both can read each other's entries. With `load_defaults 8.1`, entries use format 7.1 (`0011018d...`). A 7.0 process reading one raises `TypeError: incompatible marshal file format (can't be read)`. Do not adopt the 7.1 cache format while a 7.0 process can still run. A cache flush or a rolling deploy with cache disabled avoids the problem. Production does not set `cache_store`, so the default store is used for fragment caching.
- **Queued Active Job payloads (Sidekiq):**
  - **`DigestJob`:** The 8.1 payload serializes `completion` as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",...}`. A 7.0 worker raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. This affects rollback and a rolling deploy.
  - **Repair:** Pass `reading_completion.to_s` (see 1.14), which works on 7.0. Payloads then stay `"0.5"` on both versions. A 7.0-enqueued job (completion as `"0.3333"`) is read correctly by 8.1.
  - **Time zone:** The 8.1 payload also adds `"time_zone":"America/New_York"` to the TimeWithZone value. A 7.0 worker ignores it and gets UTC; an 8.1 worker gets local time. The mailer repair with `in_time_zone("UTC")` makes both consistent.
  - **`ExportJob`:** The native Sidekiq payload is `[1, {"format":"markdown"}]` on both versions, so it is unaffected.
- **`ActiveRecord::Marshal`, encrypted attributes:** Not used in this app.
- **Database data:**
  - `notes.tags` is stored as JSON text by both (given the 1.4 repair).
  - `notebooks.preferences` is stored as YAML and read by both.
  - `db/schema.rb` changes only in order and header (section 1.16).
  - No migrations are needed.

**Repairs that can ship on 7.0.8.7 first (each verified on the baseline copy; 46 runs, 325 assertions, 0 failures):**
- 1.1 the Action Text initializer
- 1.2 the `json` pin (not run on baseline)
- 1.3 the positional `enum`
- 1.5 `alias_method`
- 1.6 split routes
- 1.7 `config.x` provider settings
- 1.9 `fragments.join`
- 1.10 Import transaction
- 1.11 `stringify_keys`
- 1.12 `wait_until: Time.at`
- 1.13 the lambda `wait:`
- 1.14 `doi`, digest string and UTC date
- 1.15 `where(notebook:)` and `model: false`
- 2.2 the `slug` permit and cache expiry
- 2.3 `to_date`

**Not shippable early:** `serialize ... coder:`, `show_exceptions = :none`, `polynomially_longer` (the lambda replaces it), and the Gemfile bump itself.

## 4. Verification log and open questions

**Executed in `upgrade-workspace`** (workspace `/tmp/upgrade-rails-8.1.0`, deleted in cleanup):
- Commands run:
  - `gem-changes rails 7.0.8.7 8.1.0`
  - `upgrade-workspace setup rails 7.0.8.7 8.1.0`
  - Repeated `upgrade-workspace test` and `test --defaults 8.1`, and `test --target baseline`
  - About ten `upgrade-workspace probe` runs (some with `--defaults 8.1`)
  - `upgrade-workspace cleanup rails 8.1.0`
- Logs were under `/tmp/upgrade-rails-8.1.0/logs` (`bundle-update.log`, `diag-*.log`, `schema-load-*.log`, `tests-*.log`). Cleanup removed them, and the later runs overwrote some of them.
- Setup results:
  - Baseline: boot OK, eager load OK, 67 routes, 46 runs, 325 assertions, 0 failures.
  - Upgraded, before any repair: boot failed, eager load failed, 0 routes, tests aborted.
- After the repairs, the final state was upgraded with `load_defaults 7.0` at 46 runs, 340 assertions, 0 failures, and upgraded with `load_defaults 8.1` at 46 runs, 340 assertions, 0 failures. Baseline with the pre-bump repairs applied was 46 runs, 325 assertions, 0 failures.
- Probes covered all of the following:
  - repair behavior on both versions;
  - a default-config dump across 7.0 and 8.1;
  - FileStore bytes and cross-version cache reads;
  - session cookie cross-reads;
  - Sidekiq payloads and Active Job (de)serialization both ways;
  - schema dump diff;
  - the sanitizer;
  - route comparison.
- The cache and cookie checks used a fixed `secret_key_base`.

**Read from source only, not executed:**
- Release-by-release `load_defaults` values for 7.1, 7.2, 8.0 and 8.1, read from `railties-8.1.0`. Not every one that the app does not touch was tested individually.
- The `gem-changes` Rack 3 findings. They do not apply because Rack stays 2.2.24.
- `net-smtp` or `mini_mime` use in production mail delivery.

**Not verified, still open:**
- The Trix 1.3.5 editor in a browser under 8.1. `bin/rails test:system` is empty and was not run.
- Running with real Puma, a real Sidekiq worker and real Redis. Tests use `sidekiq/testing` (in-memory) and the `:test` queue adapter.
- Whether a `json` release other than 2.7.2 is acceptable to Rails 8.1. The workspace had no other version.
- Whether the production cache store is a shared Redis or file store, which determines how much the cache-format risk matters.
- Whether production mail uses SMTP (`net-smtp`).
- `yjit = true` under `load_defaults 7.2`.
- Doc updates (`ARCHITECTURE.md:79-80`, `CONTRIBUTING.md:38`, `bin/citation-provider:15`) for the `secrets.yml` to `config/citation_provider.yml` move are needed to follow the CLAUDE.md rule on guidance.

**Question for you:** Do you plan a Sidekiq 7 upgrade soon? Rails 8.2 will drop the built-in Sidekiq adapter, and Sidekiq 7 requires `rack 3`, `redis-client` and string-keyed job args. That would change the `rack` and `redis` pins in the Gemfile.

---

**Additional commentary**
- This is a plan only. Nothing in the working checkout was changed, and `Gemfile` still locks rails 7.0.8.7.
- The planner found the upgrade is feasible but needs about 16 code and config repairs. Most can land on 7.0.8.7 first, which keeps the final bump commit small.
- Tell me if you want me to implement it. I'd suggest two stages: the safe pre-bump repairs first, then the bump commit. Your answer on Sidekiq 7 doesn't block this, since the plan keeps Rack 2 and Sidekiq 6.5.