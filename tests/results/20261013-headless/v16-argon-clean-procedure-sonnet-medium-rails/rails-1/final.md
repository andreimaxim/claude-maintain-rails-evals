# Upgrade plan: Rails 7.0.8.7 to 8.1.0 (Margin Notes)

The checkout at `/home/user/workspace/repo` is untouched. `git status` was clean after cleanup, and the workspace and its databases are gone.

With all repairs below applied in the disposable `upgraded` copy, the suite passes with `load_defaults 7.0` and with `load_defaults 8.1`. Both runs show 46 runs, 340 assertions, 0 failures, 0 errors. Baseline originally showed 325 assertions; I don't know why the counts differ.

Without repairs, boot failed immediately. The logs are `diag-upgraded.log` and `tests-upgraded.log`.

Four environment points shape the plan:
- **Rack stays at 2.2.24.** `sidekiq 6.5.12` requires `rack ~> 2.0`, so the Rack 3 items from `gem-changes` (response headers, `Rack::Session`, mutable response arrays) do not apply until Sidekiq is upgraded.
- **Puma stays at 5.6.9.** I ran an in-process Puma server on both copies: `/session/new` returned 200, `/` returned 301, and `/assets/application.css` returned 200.
- **`json` resolves to 3.1.0 after `bundle update rails`.** This breaks `ActiveSupport::JSON.decode`; see Finding 1.
- **`load_defaults` stays at 7.0.** The suite also passes under 8.1 defaults once the Section 2 repairs are in. The new defaults are separate, optional adoption steps.

Resolved gems in `upgraded`: rails and all components 8.1.0, `action_text-trix` 2.1.19, `rack` 2.2.24, `rack-session` 1.0.2, `rackup` 1.0.1, `puma` 5.6.9, `sidekiq` 6.5.12, `redis` 4.8.1, `json` 2.21.2 after the pin. `method_source` is removed, and `drb`, `bigdecimal`, `securerandom`, `uri`, `useragent` and `webrick` are added.

## 1. Required changes for the upgrade

Each finding's applicability and repair status:

| # | Finding | Pre-ship on 7.0.8.7? |
|---|---|---|
| 1 | `json` 3.x breaks 8.1.0 | Pin only |
| 2 | Action Text initializer | Yes |
| 3 | `enum` keywords and `serialize` coders | No |
| 4 | `alias_attribute` on a store accessor | Yes |
| 5 | `Rails.application.secrets` removed | Yes |
| 6 | Multi-path `get` removed | Yes |
| 7 | `Array#sum` on strings | Yes |
| 8 | `Import#apply` partial commit | Yes |
| 9 | `[:id]` on a custom primary key | Yes |
| 10 | `form_with(model: nil)` | Yes |
| 11 | `where(notebooks: record)` | Yes |
| 12 | `wait_until:` with an Integer | Yes |
| 13 | `retry_on wait: :exponentially_longer` | Yes, via a lambda |
| 14 | Job serialization changes (BigDecimal, time zone) | Yes |
| 15 | `to_time` no longer preserves the offset | Yes |
| 16 | HTML5 parsing in Action Text | Not repairable |
| 17 | `show_exceptions = false` | No |
| 18 | Trix 1.3.5 vendored against Trix 2 CSS | Decision |
| 19 | Sidekiq adapter, `schema.rb`, `sprockets-rails` | Notes |

### 1. `json` 3.1.0 breaks Active Support 8.1.0 (immediately on bump)
- **Affected code:** `Gemfile`, via `Note.tags` at `app/models/note.rb:12`; any JSON-coded attribute is affected.
- **What breaks:** `bundle update rails` adds `json 3.1.0`. Loading `Note.new.tags` raises `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291`. Active Support 8.1.0 calls `JSON.parse(json, options)` with a positional hash.
- **Applicability:** immediate. The pin can be added on 7.0.8.7. Baseline used the `json` 2.7.2 default gem.
- **Repair:** add `gem "json", "< 3"` to `Gemfile`. I verified it resolves to 2.21.2 and the suite passes. The alternative is moving to a later 8.1.x patch, which I did not verify and which is not the requested version.
- **Validation:** without the pin, `Note.new.tags` raises. With it, `Note.type_for_attribute("tags").serialize(["a","b é"])` returns `"[\"a\",\"b é\"]"` and deserializing `'["x","y"]'` returns `["x","y"]`. Output is identical on baseline and upgraded. Control: the full suite passes.

### 2. `config/initializers/action_text.rb:3` crashes boot (immediate)
- **What breaks:** `NoMethodError: undefined method '+' for nil`. In 8.1, `ActionText::ContentHelper.allowed_tags` is `nil` unless set, and `sanitizer_allowed_tags` supplies the default.
- **Applicability:** immediate, and a boot failure. The repair works on 7.0.8.7, where `allowed_tags` is already set so `||=` does nothing.
- **Repair:** replace the file body with:
  ```ruby
  ActionText::ContentHelper.allowed_tags ||=
    ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  ActionText::ContentHelper.allowed_tags += %w[ details summary ]
  ```
  Do not use plain `allowed_tags = %w[details summary]`. That would drop every default tag.
- **Validation:** boot, eager load and the test "rich text keeps collapsible excerpts and drops unsafe markup" pass. Probe input `<details open><summary>S</summary><p>x</p><script>alert(1)</script><img onerror=...><a href="javascript:x()">l</a></details>` keeps `details` and `summary` and removes the `<script>` tag, `onerror` and `javascript:` on both versions. The HTML4 and HTML5 safelists are identical (`html4-only=[] html5-only=[]`), so the early lookup is safe under 7.1 defaults too.

### 3. `app/models/note.rb:10,12` and `app/models/notebook.rb:7` (immediate; not shippable before the bump)
- **What breaks:**
  - `enum status: {...}, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when `Note` loads.
  - `serialize :tags, JSON` (positional coder) is removed in 8.1. I did not run it unrepaired: the enum error stops class load first, and once the enum was fixed I changed `serialize :tags` in the same step.
  - Under `load_defaults 8.1`, `serialize :preferences` raises `ArgumentError: missing keyword: :coder If no default coder is configured...`, because `default_column_serializer` becomes nil.
- **Repair:**
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  serialize :tags, coder: JSON
  serialize :preferences, coder: YAML
  ```
  These keyword forms are not accepted by 7.0, so they cannot ship early.
- **Validation:** `Notebook.type_for_attribute("preferences").serialize({"export_heading"=>"Héllo: x"})` returns `"---\nexport_heading: 'Héllo: x'\n"` on baseline and upgraded, under 7.0 and 8.1 defaults. A legacy string deserializes to the same hash, and an `!ruby/object:OpenStruct` string raises `Psych::DisallowedClass` on both. `tags` serializes to the same JSON, so stored rows are interchangeable.

### 4. `app/models/note.rb:14` `alias_attribute :highlight_color, :color` (immediate)
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` `color` is a `store_accessor` on the `settings` jsonb column, not an attribute.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
  This works on 7.0.8.7 (baseline passes 325 assertions with it).
- **Validation:** `Note.new(title: "t", highlight_color: "blue")` gives `settings={"color"=>"blue"}`, `color=blue`, `highlight_color=blue`. This is identical on both versions. The notes controller tests assert the radio `highlight_color` value "green" on create and "blue" on edit. They also cover a note with no colour (the "None" radio), which keeps the old blank behaviour.

### 5. `app/models/citation/provider.rb:13` and `config/secrets.yml`: `Rails.application.secrets` removed (immediate)
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. The same call is used at `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`.
- **Repair:**
  - Move `config/secrets.yml` to `config/citation_provider.yml`, without the `citation_provider:` nesting. Keep the same ERB lines, with `test: *local`.
  - Add `config.x.citation_provider = config_for(:citation_provider)` in `config/application.rb`.
  - Read `Rails.configuration.x.citation_provider.to_h` in `Citation::Provider#initialize`.
  - Update the tests to set `Rails.configuration.x.citation_provider`.
  - Update the comment at `provider.rb:3` and the `bin/citation-provider:15` comment.
- This works on 7.0.8.7 (baseline passes).
- **Validation:** the test "provider credentials from the environment reach the server unchanged" asserts the exact Basic header. Control: the tests that fetch metadata and retry once on a 503 still pass.

### 6. `config/routes.rb:18` `get "/notes", "/journal", to: "notes#index"` (immediate)
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2)` at route draw.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
  This keeps the route names `notes` and `journal`, as baseline shows. Routes go from 0 on the failing boot to 63. Baseline has 67. The 4 missing routes are the Action Mailbox conductor inbound-email `edit`, `update` (PATCH and PUT) and `destroy` routes, which 8.1 no longer defines.
- **Validation:** the test "lists the reader's notes newest first at both list paths" covers `/notes` and `/journal`.

### 7. `app/models/export.rb:42` `finish(fragments.sum)` (immediate)
- **What breaks:** `TypeError: String can't be coerced into Integer`. Baseline logs show the deprecation "Rails 7.0 has deprecated Enumerable.sum ... Sum of non-numeric elements requires an initial argument".
- **Repair:** `finish(fragments.join)`. Works on 7.0.8.7.
- **Validation:** the export test asserts the Markdown body. Heading `# ...`, then `## title` sections.

### 8. `app/models/import.rb:50-60` `Import#apply`: `return false` inside `transaction` (immediate)
- **What breaks:** the class comment says "saves nothing", but with 8.1 a non-local `return` commits. Test "invalid rows are shown with their errors, and applying them saves nothing" fails with `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]`. One import and one valid note are left saved when a later row is invalid.
- **Repair:**
  ```ruby
  saved = false
  transaction do
    save!
    rows.each { |row| raise ActiveRecord::Rollback unless row.note.save }
    saved = true
  end
  saved
  ```
  This works on 7.0.8.7. Other `return`s sit outside any transaction (`Export#generate`, and `with_lock` blocks use values).
- **Validation:** the CSV from that test has a valid row followed by an invalid one, and expects `[0,3,0,1]` after apply. Control: the valid two-row import creates 2 notes and 1 citation, and `Import.count` goes up by 1.

### 9. `app/models/import.rb:68` `citation[:id]` (immediate, silent)
- **What breaks:** `citation[:id]` returns `nil` on 8.1. Baseline returns `"10.1000/x"` (the `doi` primary key). The receipt CSV loses its DOI column: `On idleness,` instead of `On idleness,10.1000/Essays.1`. No exception is raised.
- **Repair:** use `citation&.doi`. Works on 7.0.8.7.
- **Validation:** the receipt test (two notes sharing one DOI) now matches `"title,doi\nOn idleness,10.1000/Essays.1\nOf experience,10.1000/Essays.1\n"`.

### 10. `app/views/notes/index.html.erb:12` `form_with(model: nil, ...)` (immediate)
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. Every notes index, and sign-in, which redirects there, returns 500.
- **Repair:** remove `model: nil`. Works on 7.0.8.7.
- **Validation:** the test "renders an unbound search form" asserts `form[role=search][action="/notes"][method=get]`.

### 11. `app/controllers/notes_controller.rb:12` `@notes.where(notebooks: @notebook)` (immediate)
- **What breaks:** `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`. The notebook filter returns 500.
- **Repair:** `@notes.where(notebook: @notebook)`. Works on 7.0.8.7.
- **Validation:** the filter test uses notes in two notebooks and expects only the chosen notebook's notes.

### 12. `app/models/note.rb:61` `NoteReminderJob.set(wait_until: reminder_epoch)` (immediate)
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Scheduling a reminder fails.
- **Repair:** `set(wait_until: Time.at(reminder_epoch))`. Works on 7.0.8.7.
- **Validation:** the reminder test asserts the enqueued `at` equals `Time.utc(2026,10,31,13).to_i`. The imported-reminder test checks another epoch.

### 13. `app/jobs/citation_enrichment_job.rb:7` `retry_on ..., wait: :exponentially_longer` (immediate)
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer` when enqueueing the retry. `:polynomially_longer` does not exist on 7.0.
- **Repair:** `wait: ->(executions) { executions**4 + 2 }`. This is the old formula and works on both versions.
- **Validation:** the test "a provider that stays unavailable ... leaves a visible failure" expects 6 provider requests: 3 attempts, each retrying once on a 503.

### 14. Job serialization: BigDecimal and time zone (affects queued jobs, `DigestJob`)
- **Affected code:** `app/models/user.rb:41`, `app/mailers/digest_mailer.rb:7-9`.
- **What changes:**
  - **Wrong digest day.** The 8.1 `TimeWithZoneSerializer` now stores `"time_zone"=>"America/New_York"` and restores the job time in that zone. The digest test fails with the subject `"Your reading digest for October 04, 2026"` instead of `"October 05, 2026"`. The digest lists notes for the reader's local day, not the documented UTC day.
  - **Rollback break.** The new `BigDecimalSerializer` payload `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}` (7.0 queued the plain string `"0.5"`) cannot be run by 7.0.8.7. It raises `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- **Repair:**
  - `DigestJob.perform_later(self, requested_at, reading_completion.to_s("F"))`. The mailer already accepts a string via `BigDecimal(params[:completion])`.
  - In `DigestMailer`, add `requested_at = requested_at.utc` before `@date = requested_at.to_date`.
- **Validation (user 902, Eastern time, now = 2026-10-05 03:30 UTC):** note "a" updated 2026-10-05 12:00 UTC (ready), note "b" updated 2026-10-04 12:00 UTC (ready), note "c" draft.
  - Payload on both versions: `"0.6667"`.
  - 7.0 runs the 8.1 payload and 8.1 runs the 7.0 payload.
  - Subject is `"October 05, 2026"`, the body lists a but not b, and shows "67% of your notes".
  - The repaired code passes the full baseline suite.

### 15. `app/models/note.rb:44` `reminder_at.to_time + 86_400` (immediate, display change)
- **What changes:** `to_time` no longer preserves the UTC offset. For a reminder at 09:00 Eastern on 2026-10-31, baseline gives `2026-11-01T09:00:00-04:00`, 8.1 gives `2026-11-01T08:00:00-05:00`. Both are the same instant (`to_i` 1793538000 + 86400, so postponing is unchanged). The "24 hours later" label shown on a note changes. `ActiveSupport.to_time_preserves_timezone` itself is deprecated and removed in 8.2.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`. This keeps the documented "keeps the reminder's UTC offset" behaviour. Works on 7.0.8.7.
- **Validation:** the test asserts `time[datetime="2026-11-01T09:00:00-04:00"]` after a DST end. The postponement test checks the epoch.
- **Alternative:** accept the new display and update the test and the comment on `next_day_reminder_at`.

### 16. Action Text parses HTML with HTML5 immediately (even with `load_defaults 7.0`)
- **What changes:** `ActionText.html_document_class` is `Nokogiri::HTML5::Document`. `ActionText::Content#to_html` output differs on malformed stored bodies:
  - `<p>unclosed <b>bold <i>x</p><div><p>a</div>` gives `<div><p><b><i>a</i></b></p></div>` on 8.1 and `<div><p>a</p></div>` on 7.0.
  - `<table><tr><td>` gains a `<tbody>`.
  - `&nbsp;` is written as the entity, where 7.0 wrote the raw character.
- **Impact:** `to_plain_text` was identical in all my samples, so Markdown exports are unaffected. The new serialization appears only when a note is re-saved or edited.
- **Repair:** none needed. This is not preventable from the app.

### 17. `config/environments/test.rb:31` `show_exceptions = false`
- **What breaks:** the value `false` is no longer honoured, so tests stop seeing raised errors. Five "another reader cannot reach X" tests fail with `ActiveRecord::RecordNotFound expected but nothing was raised`.
- **Repair:** `config.action_dispatch.show_exceptions = :none`. It does not work on 7.0.8.7, so it must ship with the bump.

### 18. Trix: vendored 1.3.5 against Trix 2 (needs a decision and a browser check)
- **Affected code:** `app/views/layouts/application.html.erb:13`, `vendor/javascript/trix-1.3.5.js`, `config/importmap.rb:8`, `app/javascript/application.js`, `app/assets/stylesheets/actiontext.css:6` (`*= require trix`), `ARCHITECTURE.md:207-212`.
- **What changes:** Action Text 8.1 ships Trix 2.1.19 (`action_text-trix`). `application.css` (compiled in the probe) now includes the Trix 2 stylesheet. The layout still loads the vendored Trix 1.3.5 script. The original reason for vendoring (bug in Trix 1.3.4) no longer applies.
- **Recommended repair (one option):**
  - Remove the vendored file and its layout tag.
  - In `config/importmap.rb` add `pin "trix"` and change the actiontext pin to `to: "actiontext.esm.js"`.
  - Add `import "trix"` before `import "@rails/actiontext"` in `app/javascript/application.js`.
  - Update `ARCHITECTURE.md`.
  - I verified in the workspace that both assets resolve (`trix.js` shows "Trix 2.1.19") and the suite passes.
- **Alternative:** keep Trix 1.3.5 and vendor its matching stylesheet. That keeps old markup but leaves Rails' bundled Action Text JS (written for Trix 2) running against Trix 1.3.5.
- **Unverified:** no browser was available and `test/system` is empty. Editor toolbar, link and attachment round-trips and drag-and-drop uploads are unverified.

### 19. Other notes
- **Sidekiq adapter (not a failure yet):** `config.active_job.queue_adapter = :sidekiq` at `config/application.rb:24` logs `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later`. Tests use `:test`, so they do not exercise it. Moving to Sidekiq 7 later forces follow-up work:
  - Rack 3.
  - `redis-client` errors, so `rescue Redis::BaseError` in `Notebook#request_export` (`app/models/notebook.rb`) stops catching.
  - Strict args (`ExportJob.perform_async(export.id, { format: "markdown" })` has symbol keys).
- **`db/schema.rb`:** regenerating dumps `ActiveRecord::Schema[8.1]` and `enable_extension "pg_catalog.plpgsql"`. Columns are sorted alphabetically (a large diff). 7.0 cannot load that file. Commit the regenerated schema with the bump, not before.
- **`sprockets-rails` and `importmap-rails` 2.2.3:** assets compile on both versions.

## 2. New configuration defaults across intermediate releases

The app uses `config.load_defaults 7.0`, and no `config/` file sets any item below. Adopt them by stepping `load_defaults` (7.1, then 7.2, 8.0, 8.1) and re-running the suite at each step. At 8.1 the suite passed with the Section 1 repairs plus the four defaults repairs below.

### 7.1 defaults

- **`active_record.raise_on_assign_to_attr_readonly = true`.**
  - **Affected code:** `app/models/notebook.rb:8`, `app/controllers/notebooks_controller.rb:40`.
  - **What changes:** `ActiveRecord::ReadonlyAttributeError: slug` on notebook update, because the settings form resubmits `slug`.
  - **Not deprecated or removed later.**
  - **Repair:** `permit(:name, :export_heading)`. Create still works because `assign_slug` runs `before_validation on: :create`. Works on 7.0.8.7.
- **`active_support.raise_on_invalid_cache_expiration_time = true`.**
  - **Affected code:** `app/views/exports/_export.html.erb:26` (`cache ..., expires_in: export.expires_at - Time.current`).
  - **What changes:** for an expired export, `Cache expiration time is invalid, cannot be negative: -60.0` raises in the template. This is a 500 on the exports page wherever fragment caching is on (production sets `perform_caching = true`).
  - **Repair:** `expires_in: [export.expires_at - Time.current, 0].max`.
  - **Validation:** the test "the cached availability indicator does not authorize a download" travels past expiry and still expects the download refusal.
- **`active_record.default_column_serializer = nil`.**
  - Covered by `serialize :preferences, coder: YAML` in Finding 3.
- **`active_support.cache_format_version = 7.1`.**
  - **What changes:** entries are written in a new binary format. This matters only if the app uses a shared or persistent cache store. Production sets none, so Rails uses a per-host file store. Tests use `:null_store`.
  - **Rollout risk:** a 7.1-format entry read by 7.0.8.7 raises `TypeError: incompatible marshal file format (can't be read)`. This is a raised error, not a cache miss.
  - **Recommendation:** adopt it only after the rollout window.
- **`active_support.message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true`.**
  - **What changes:** signed messages (Active Storage signed blob IDs, Action Text attachment signed global IDs stored in `action_text_rich_texts.body`) are written in a new format.
  - **Rollout risk:** 7.0.8.7 cannot read the new format. It raises `NoMethodError: undefined method 'unpack1' for nil` for both `message_verifier` tokens and `ActiveStorage.verifier` IDs, not `InvalidSignature`. Newly written tokens in the database break on rollback.
  - **Cookies and sessions** are unaffected: `cookies_serializer` is `:json` already.
  - **Recommendation:** adopt only after rollback is no longer needed.
- **`action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` set to HTML5.**
  - **What changes:** with defaults 8.1 I saw `&nbsp;` preserved as `&nbsp;` where the old path emitted the raw character, and `<svg><title>t</title></svg>` text dropped. Other probe inputs matched. This is a rendering difference only.
- **Defaults checked with no application impact:**
  - `add_autoload_paths_to_load_path=false`: nothing requires app files by path.
  - `precompile_filter_parameters`: identical `[FILTERED]` output for `password`, `api_token`, `secret_key`, `passwd`, `ssn`, `otp_code` and a nested `salt`.
  - `dom_testing_default_html_version`: the suite passes.
  - `default_headers`: identical to the 7.0 values.
  - `before_committed_on_all_records` and `run_after_transaction_callbacks_in_order_defined`: the app has no transaction callbacks.
  - `generate_secure_token_on`: no `has_secure_token`.
  - `encryption.*`: no `encrypts`.
  - `marshalling_format_version`: no Marshal use.
  - `belongs_to_required_validates_foreign_key`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `debug_exception_log_level`: no effect found.

### 7.2 defaults

- **`active_record.postgresql_adapter_decode_dates = true`.**
  - **Affected code:** `app/models/notebook.rb:40` (`daily_note_counts`).
  - **What changes:** `select_rows` returns `Date` objects, so `Date.iso8601(day)` raises `TypeError: no implicit conversion of Date into String`. The activity report returns 500.
  - **Repair:** `Date.iso8601(day.to_s)`. Works on 7.0.8.7.
  - **Validation:** the test "a notebook's notes are counted by UTC creation date, newest first".
- **Defaults checked with no application impact:**
  - `validate_migration_timestamps`: existing migrations are 20261011xxxx, which is before today (2026-10-15). It only affects new migrations.
  - `yjit = true`: needs Ruby 3.3.6, which is fine. Watch memory in production.
  - `active_storage.web_image_content_types`: no variants used.

### 8.0 defaults

- **`action_dispatch.strict_freshness = true`.**
  - **Affected code:** `app/controllers/export_downloads_controller.rb` (`stale?(etag:, last_modified:)`).
  - **What changes:** one case flips. With a matching ETag and an older `If-Modified-Since`, `fresh?` goes from false to true, so the client gets a 304. Matching both, or a differing ETag, is unchanged.
  - **Probe values:** a differing ETag with a newer `If-Modified-Since` stays false.
  - **Impact:** none practical, because browsers echo the `Last-Modified` value back.
- **`Regexp.timeout = 1`.** The only regex is the linear DOI pattern at `app/models/citation.rb`.

### 8.1 defaults

- **`action_controller.escape_json_responses = false` and `active_support.escape_js_separators_in_json = false`.** The app has no `render json:`.
- **`action_controller.action_on_path_relative_redirect = :raise`.** Every `redirect_to` uses a path helper.
- **`active_record.raise_on_missing_required_finder_order_columns`.** No `first`/`last` on a model without a primary key.
- **`action_view.render_tracker = :ruby` and `remove_hidden_field_autocomplete`.** These change fragment cache digests and hidden-field markup only. Existing `cache` keys become misses.
- **`yjit = !Rails.env.local?`.**

### Settings that do not change on bump

- **`config.active_job.queue_adapter`** (`config/application.rb:24` `:sidekiq`, `config/environments/test.rb:37` `:test`). Rails 7.2 made tests respect the configured adapter. The app sets `:test` for tests, so nothing changes.
- **`config.active_job.enqueue_after_transaction_commit`.** Not set, and not a load_defaults item. In 8.x it is boolean (the 7.2 symbols `:default`/`:always`/`:never` are all truthy). Setting it to `true` is not safe here:
  - A failed enqueue inside `Citation#request_enrichment` (`app/models/citation.rb:15-20`) stays committed. Probe with a failing adapter: status `failed` stays `failed` with `false`, but becomes `pending` with `true`.
  - That contradicts the model's "a failed enqueue rolls back the pending state" comment and leaves the citation stuck on "already being fetched".
  - Leave it unset.

## 3. Rollout, rollback, and mixed-version risks

- **Database records.** `notes.tags` (JSON text), `notes.settings` (jsonb) and `notebooks.preferences` (YAML text) serialize identically on both versions. Probes covered unicode, nil, empty values and the legacy YAML format. No data migration is needed.
- **`db/schema.rb`.** Production does not load it, but a branch that regenerates it on 8.1 cannot be loaded by 7.0. See Finding 19.
- **Redis cache.** Production sets no cache store (default per-host file store). With `load_defaults 7.0` the 7.0.8.7 and 8.1 processes read each other's entries in both directions: a `Hash` and a string, both directions, gave identical values. The 7.1 cache format is the only hazard (Section 2).
- **Cookies and tokens.** I used the same `secret_key_base` for both copies. Encrypted and signed cookies, `message_verifier` tokens and `ActiveStorage.verifier` IDs interoperate between 7.0.8.7 and 8.1.0 with `load_defaults 7.0`. `cookies_serializer` is `:json` on both. The dev/test secret file name changes (`tmp/development_secret.txt` becomes `tmp/local_secret.txt`), which affects only local environments.
- **Queued Active Job payloads.**
  - The digest repair in Finding 14 removes the rollback failure for new jobs. Jobs already enqueued by 8.1 before the repair ships cannot run on 7.0.8.7. They fail with `ActiveJob::DeserializationError`.
  - `NoteReminderJob` and `CitationEnrichmentJob` ran on both versions in both directions. Payload keys grow (`scheduled_at`, nanosecond `enqueued_at`), and 7.0 ignores them.
  - The native `ExportJob` is unchanged.
- **Preparatory repairs that ship on 7.0.8.7** (all tested on the baseline copy: 46 runs, 325 assertions, 0 failures):
  - Findings 2, 4 to 15 (the Action Text initializer, `alias_method`, config_for settings, split routes, `join`, `Import#apply`, `citation&.doi`, the view fixes, `Time.at`, the retry lambda, the digest string, the `.utc` fix and the display offset).
  - The slug permit change, the cache expiry clamp and `Date.iso8601(day.to_s)`.
  - The `json < 3` pin is also safe to add.
- **Bump-time only:** `enum :status, ..., prefix: true`, `serialize ..., coder:`, `show_exceptions = :none`, and the Trix change.
- **Operational:** keep `load_defaults 7.0` through rollout. Adopt the 7.1 message and cache formats last.

## 4. Verification log and open questions

### Executed in the workspace

- **Setup:** `ruby /home/user/planner-run/maintain-rails/bin/upgrade-workspace setup rails 7.0.8.7 8.1.0`. Baseline: boot, eager load and 67 routes OK, 46 runs, 325 assertions, 0 failures. Upgraded: boot failed on `config/initializers/action_text.rb:3` and the test runner exited 1.
- **Logs** (all under `/tmp/upgrade-rails-8.1.0/logs`, since deleted by cleanup): `bundle-update.log`, `schema-load-baseline.log`, `schema-load-upgraded.log`, `diag-baseline.log`, `diag-upgraded.log`, `diag-upgraded-defaults-8.1.log`, `tests-baseline.log`, `tests-upgraded.log`, `tests-upgraded-defaults-8.1.log`.
- **Repair loop:**
  - I ran `upgrade-workspace test` and `upgrade-workspace test --defaults 8.1` repeatedly, fixing one failure at a time.
  - The `json < 3` pin was added with `bundle lock --update json` and `bundle install` run directly in `upgraded` (the `upgrade-workspace` script does not run Bundler itself).
  - Final result with repairs: 46 runs, 340 assertions, 0 failures, 0 errors, under both `load_defaults 7.0` and `8.1`, with no deprecation warnings.
  - The baseline copy with only the pre-ship repairs passed 325 assertions.
- **Probes** (`upgrade-workspace probe`, with `--defaults 8.1` where noted):
  - Route names.
  - Job payload shapes and cross-version execution, with a real Sidekiq adapter on the isolated Redis DBs.
  - Cache, cookie and token interoperability. The secret key was copied between the two workspace copies.
  - `schema.rb` dump diff.
  - `fresh?` conditions.
  - Sanitizer and `to_plain_text` output.
  - Default headers and `ParameterFilter`.
  - `enqueue_after_transaction_commit` behaviour with a failing adapter.
  - Serialization format round-trips.
  - Puma smoke requests.
  - Asset resolution for Trix 2.

### Reading only, no run
- The `gem-changes` Rack 3 items. Rack stays at 2.2.24, so they do not apply now.
- The Active Job source for the boolean `enqueue_after_transaction_commit`.

### Proposed, not run
- A browser pass for the Trix change, because `test/system` is empty and no browser was available.
- Staging with Sidekiq 7.3.3 or later.
- A real multi-host rollout check for cookies and tokens under 8.1 defaults.

### Open questions
1. Is `json` 3.1.0 incompatible with 8.1.0 in your environment too? I confirmed it only in the workspace resolution. A later 8.1.x patch may remove the need for the pin.
2. Should the "24 hours later" label keep the old offset (Finding 15 repair) or accept the new display?
3. Which Trix path (Finding 18)? This needs a browser test either way.
4. Production cache and queue topology. I assumed no shared cache store (none is configured).

Relevant files (all under `/home/user/workspace/repo`): `Gemfile`, `config/application.rb`, `config/routes.rb`, `config/secrets.yml`, `config/environments/test.rb`, `config/initializers/action_text.rb`, `config/importmap.rb`, `app/javascript/application.js`, `app/views/layouts/application.html.erb`, `app/models/note.rb`, `app/models/notebook.rb`, `app/models/import.rb`, `app/models/export.rb`, `app/models/user.rb`, `app/models/citation/provider.rb`, `app/mailers/digest_mailer.rb`, `app/jobs/citation_enrichment_job.rb`, `app/controllers/notes_controller.rb`, `app/controllers/notebooks_controller.rb`, `app/views/exports/_export.html.erb`, `app/views/imports/preview.html.erb`, `app/views/notes/index.html.erb`, `ARCHITECTURE.md`.

---

I haven't made any changes. The skill covers planning only, and the repo is still clean. The plan came from a disposable copy of the app, which has since been deleted.

Before implementing, I need your answers on three points:
- **Open question 2:** should the "24 hours later" label keep the old UTC offset, or switch to the new display?
- **Open question 3:** which Trix path do you want? Either one needs a browser check.
- **Staging:** the pre-ship fixes (findings 2 and 4–15, plus the three 7.1/7.2 fixes) can land on 7.0.8.7 before the bump. Do you want them as a separate change first, or all in one commit?