# Upgrade plan: rails 7.0.8.7 to 8.1.0 (Margin Notes)

Bumping Rails to 8.1.0 without other changes breaks the app at boot. After that is fixed, several more problems surface. I built a disposable workspace, applied the 20 repairs below, and both suites passed: 46 runs and 0 failures on 8.1.0 with `load_defaults 7.0`, and the same with `load_defaults 8.1`. 16 of the repairs also pass the full suite on 7.0.8.7, so they can ship before the bump. The working checkout was not changed; `cleanup` reported `git status` clean.

A gap in the tooling: `gem-changes` could not unpack any of the cached `.gem` files (`"…" is not an octal string`). Because of that, its new-framework-defaults section was empty. Section 2 is therefore built from the release notes I know plus the `--defaults 8.1` test run, not from the script.

Gems that change in `Gemfile.lock`:
- rails and all its components: 7.0.8.7 to 8.1.0
- added: action_text-trix 2.1.19, json 3.1.0, rack-session 1.0.2, rackup 1.0.1, bigdecimal 4.1.3, drb, securerandom, uri, useragent, webrick
- removed: method_source
- **rack stays at 2.2.24**, so the Rack 3 middleware and header rules do not apply, and Puma `~> 5.0` keeps working.

---

## 1. Required changes for the upgrade

Each finding has five parts: affected code, what breaks, applicability, the repair, and validation. "Ships on 7.0" means the repair passed the full 7.0.8.7 suite.

**F1. Rails 8.1 crashes with the json 3.1.0 that the bundle resolves**
- **Affected code:** `Gemfile`. The new lock adds json 3.1.0. activesupport-8.1.0 `json/decoding.rb:25` calls `::JSON.parse(json, options)`.
- **What breaks:** Every request that reads the session cookie fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` (raised from `json-3.1.0/lib/json/common.rb:291:in 'parse'`). Sign-in, sign-out and the note list all return 500.
- **Applicability:** Immediately on the bump. Ships on 7.0, which already runs json 2.7.2.
- **Repair:** Add `gem "json", "~> 2.7"` to `Gemfile`. The workspace then locked json 2.7.2.
- **Validation:** `SessionsControllerTest` failed 3 of 4 tests before the pin and passes after it.

**F2. `config/initializers/action_text.rb:3` fails at boot**
- **What breaks:** `NoMethodError: undefined method '+' for nil`. Boot and eager loading fail, and the test runner exits with status 1 before running anything. Since 7.1, `ActionText::ContentHelper.allowed_tags` starts as `nil` and is computed lazily from the sanitizer.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** Replace the file body with:
  ```ruby
  Rails.application.config.after_initialize do
    ActiveSupport.on_load(:action_view) do
      helper = ActionText::ContentHelper
      helper.allowed_tags = (helper.allowed_tags ||
        helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]) + %w[ details summary ]
    end
  end
  ```
  Running it after initialization means it extends whichever sanitizer `config.action_text.sanitizer_vendor` selects (HTML4 now, HTML5 under 7.1+ defaults).
- **Validation:**
  - Boot fails without the repair and passes with it.
  - Probe on both versions: `ActionText::Content.new("<details><summary>s</summary>x</details>").to_rendered_html_with_layout` keeps `<details><summary>`.
  - Still to add: a control asserting that `<script>` is stripped.

**F3. `enum status: {…}, _prefix: true` (`app/models/note.rb:10`)**
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when the class loads. Every test touching `Note` errors.
- **Applicability:** The keyword form was removed in 8.0. Ships on 7.0.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Validation:** The full suite passes on both versions, including the status filter and `status_ready` scope tests.

**F4. `serialize :tags, JSON` (`app/models/note.rb:12`)**
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at `note.rb:12`.
- **Applicability:** The positional coder was removed after its 7.1 deprecation. The repair needs 7.1 or later, so it ships with the bump. The stored JSON format is unchanged.
- **Repair:** `serialize :tags, coder: JSON`
- **Validation:** `notes_controller_test.rb:127` asserts `["provincial life", "Victorian", "reform"]` round-trips.

**F5. `alias_attribute :highlight_color, :color` on a `store_accessor` (`app/models/note.rb:14`)**
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.`
- **Applicability:** Raises from 7.2 (deprecated in 7.1). Ships on 7.0.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Validation (probe, both versions):**
  - `n.update!(highlight_color: "blue")`, reloaded, gives `["blue", {"color"=>"blue"}]`.
  - Control: `highlight_color = "red"` gives `valid? == false` with `["is not included in the list"]`.

**F6. `Rails.application.secrets` was removed (`app/models/citation/provider.rb:13`)**
- **Test helper also affected:** `test/controllers/citation_enrichments_controller_test.rb:116-121`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Citation enrichment cannot build a provider.
- **Applicability:** Deprecated in 7.1, removed in 7.2. Ships on 7.0.
- **Repair:**
  - In `config/application.rb`: `config.x.citation_provider = config_for(:secrets)[:citation_provider]`
  - In the provider default: `settings = Rails.configuration.x.citation_provider.to_h`
  - In the test helper: read and assign `Rails.configuration.x.citation_provider`.
  - Optionally rename the file to `config/citation_provider.yml` and update the comment in `config/secrets.yml` that names `Rails.application.secrets`.
- **Validation:**
  - Probe on both versions: provider ivars are `@url "http://127.0.0.1:9393", @user "margin-notes", @password "local-only"`.
  - The credentials test (`citation_enrichments_controller_test.rb:40`) passes on both.

**F7. One route with two paths (`config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`)**
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2)` when routes are drawn (routes=0). Every `*_path` helper is then undefined, for example `NameError: undefined local variable or method 'notes_path'`.
- **Applicability:** Removed in 8.1. Ships on 7.0.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index", as: :notes
  get "/journal", to: "notes#index", as: :journal
  ```
- **Validation:** Probe on both versions shows the same routes: `["notes", "/notes(.:format)", notes#index]` and `["journal", "/journal(.:format)", notes#index]`. The "both list paths" test passes.

**F8. `show_exceptions = false` (`config/environments/test.rb:31`)**
- **What breaks:** `false` is no longer honored. Exceptions are rescued into 404/500 pages, so 6 tests that use `assert_raises ActiveRecord::RecordNotFound` fail with "nothing was raised", and real errors are hidden behind 500s.
- **Applicability:** Booleans were deprecated in 7.1 and dropped by 8.1. The repair needs 7.1 or later; on 7.0 the symbol `:none` would be truthy. Ships with the bump.
- **Repair:** `config.action_dispatch.show_exceptions = :none`
- **Validation:** The 6 cross-reader `RecordNotFound` tests pass.

**F9. `fragments.sum` (`app/models/export.rb:42`)**
- **What breaks:** `TypeError: String can't be coerced into Integer`. Every Markdown export job fails, and its export record is left in the `working` state.
- **Applicability:** Rails' `Enumerable#sum` override was removed in 7.1. On 7.0 it already prints a deprecation warning. Ships on 7.0.
- **Repair:** `finish(fragments.join)`
- **Validation:** The exports tests pass on both versions, including the exact Markdown body.

**F10. `@notes.where(notebooks: @notebook)` (`app/controllers/notes_controller.rb:12`)**
- **What breaks:** `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`. Filtering the note list by notebook fails.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** `@notes = @notes.where(notebook: @notebook)`
- **Validation:** `notes_controller_test.rb:27` (filter) and `:58` (pagination) pass on both versions.

**F11. `form_with(model: nil, …)` (`app/views/notes/index.html.erb:12`)**
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. The note list, the main page after sign-in, returns 500.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** `form_with(url: notes_path, method: :get, class: "search", html: { role: "search" })`
- **Validation:** `notes_controller_test.rb:17` asserts `form[role=search][action="/notes"][method=get]`.

**F12. `retry_on … wait: :exponentially_longer` (`app/jobs/citation_enrichment_job.rb:7`)**
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. On an unavailable provider the job raises instead of retrying 3 times, so a "fetching" citation never records its failure. The test saw `Expected: 6, Actual: 2` provider requests.
- **Applicability:** Removed after its 7.1 deprecation. The repair needs 7.1 or later. Ships with the bump.
- **Repair:** `wait: :polynomially_longer` (the same formula).
- **Validation:** `citation_enrichments_controller_test.rb:60` passes.

**F13. `set(wait_until: reminder_epoch)` with an Integer (`app/models/note.rb:61`)**
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer` when enqueuing. Scheduling a reminder returns 500.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch)).perform_later(self)`
- **Validation:** `reminders_controller_test.rb:6` asserts `job.values_at(:job, :at) == [NoteReminderJob, Time.utc(2026,10,31,13).to_i]`. Probe: `schedule_reminder` returns true on both versions.

**F14. `reminder_at.to_time + 86_400` (`app/models/note.rb:44`)**
- **What changes:** 8.1 ignores the old `to_time_preserves_timezone` setting (probe value `nil`, with a deprecation warning). `to_time` now keeps the zone, so for a 09:00 Eastern reminder on 2026-10-31 the value changes:
  - 7.0: `"2026-11-01T09:00:00-04:00"`
  - 8.1: `"2026-11-01T08:00:00-05:00"`

  The "Remind me a day later" preview changes, and so does `postpone_reminder`'s documented offset-keeping behavior.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`
- **Validation (both versions):**
  - Across the DST change: `"2026-11-01T09:00:00-04:00"`.
  - Control with no DST change (reminder at 2026-10-10 13:00 UTC): `"2026-10-11T09:00:00-04:00"`.

**F15. `citation[:id]` in `Import#receipt` (`app/models/import.rb:68`)**
- **What breaks:** `citations` uses `doi` as its primary key. `[:id]` now returns `nil` instead of the DOI, so receipt CSVs come out as `"title,doi\nOn idleness,\nOf experience,\n"` with the DOIs missing.
- **Applicability:** 7.2 or later. Ships on 7.0.
- **Repair:** `csv << [ note.title, citation&.doi ]`
- **Validation:** Probe gives `"title,doi\nFirst,10.1000/z9\nSecond,10.1000/b2\n"` on both versions. Probe on 8.1 without the repair: `Citation.new(doi: "10.1000/x")[:id]` returns `nil` (7.0 returns `"10.1000/x"`).

**F16. `@import.annotations.stringify_keys` (`app/views/imports/preview.html.erb:22`)**
- **What breaks:** `HashWithIndifferentAccess#stringify_keys` now really turns keys into strings, so `annotations[row.line]` (an Integer) returns `nil`. The annotation disappears from the import preview. The test saw `Expected: "Read <b>twice</b> & reflect", Actual: "10.1000/Essays.1"`.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** `<% annotations = @import.annotations %>`
- **Validation:** Probe `annotations[2]` gives `"ann one"` on both versions. `imports_controller_test.rb:6` passes.

**F17. Non-local `return` inside `transaction` in `Import#apply` (`app/models/import.rb:53-58`)**
- **What changes:** On 7.2 and later, `return false` commits the transaction. A failed import keeps the import record and the notes and citations saved before the failure, while the reader is told nothing was saved. The test saw `record_counts` change from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`.
- **Applicability:** Immediately on 7.2+. Ships on 7.0.
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
- **Validation (probe on both versions, no outer transaction):**
  - Second row's `save` forced to return false: `apply` gives `false`, count delta `[0,0,0]`, and `persisted? == false`.
  - Control with two valid rows: `true`, delta `[1,2,2]`.

**F18. Digest day changes because Active Job now keeps the time zone (`app/mailers/digest_mailer.rb:7-9`)**
- **What changes:** The TimeWithZone argument now deserializes in the reader's zone instead of UTC. A request at 2026-10-05 03:30 UTC from an Eastern reader produces "Your reading digest for October 04, 2026" instead of October 05, and it queries the wrong day's notes.
- **Applicability:** Immediately. Ships on 7.0.
- **Repair:** Keep the job payload unchanged (the test asserts the job carries local time) and normalize in the mailer:
  ```ruby
  requested_at = requested_at.in_time_zone("UTC")
  ```
- **Validation:**
  - `digests_controller_test.rb:5` passes on both versions: the subject says October 05, and Montaigne (updated 10-04 16:00 UTC) is excluded.
  - Probe: an 8.1 payload deserialized gives date `"2026-10-05"` on both versions.

**F19. BigDecimal job argument breaks mixed-version workers (`app/models/user.rb:41`)**
- **What changes:** 8.1 always serializes `reading_completion` as `{"_aj_serialized"=>"ActiveJob::Serializers::BigDecimalSerializer","value"=>"0.5"}`. A 7.0 worker raises `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (probe).
- **Applicability:** Affects rollout and rollback. Deploy on 7.0 first.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already calls `BigDecimal(params[:completion])`.
- **Validation:** Probe payload is `["0.0"]` on both versions. The digest test still asserts "50% of your notes were ready".

**F20. Sidekiq 6.5.12 adapter deprecation (`config/application.rb:24`)**
- **What changes:** Nothing breaks yet. Enqueueing works, but logs `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later`.
- **Repair:** None needed for 8.1. Plan a separate Sidekiq 7.3+ and redis-client upgrade before Rails 8.2.
- **Validation:** Real-adapter probe on both versions: one job was added to `Sidekiq::ScheduledSet`.

**Checked and found unaffected:** custom Rack middleware (none; Rack stays 2.x), `render json:` (not used), `ActionController::Parameters == Hash` (not used), path-relative `redirect_to` (not used), `has_secure_token` (not used), and models without a primary key (none). The `ExportJob` Sidekiq warning about symbol keys was already present before the upgrade.

---

## 2. New configuration defaults across intermediate releases

The app uses `config.load_defaults 7.0` and sets none of the settings below explicitly. It keeps every old value until `load_defaults` is raised. None of the code issues come from adopting new defaults except D1 to D4, all of which failed or were checked in the `--defaults 8.1` run. Recommended path: bump with `load_defaults 7.0`, then raise one version at a time through `new_framework_defaults_*.rb`.

**D1. `active_record.default_column_serializer = nil` (7.1)**
- **Affects:** `app/models/notebook.rb:7`, `serialize :preferences`.
- **What breaks:** `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'`.
- **Repair:** `serialize :preferences, coder: YAML` (7.1+). The stored YAML stays readable.

**D2. `active_record.raise_on_assign_to_attr_readonly = true` (7.1)**
- **Affects:** `notebook.rb:8` (`attr_readonly :slug`) together with `notebooks_controller.rb:40`, which permits `:slug` from the hidden field.
- **What breaks:** Saving notebook settings raises `ActiveRecord::ReadonlyAttributeError: slug`.
- **Repair:** `params.require(:notebook).permit(:name, :export_heading)`. Ships on 7.0. On create the slug is assigned by `assign_slug` anyway.
- **Validation:** The probe renamed a notebook and the slug stayed `"probe-book"`. `notebooks_controller_test.rb:22` passes under both defaults.

**D3. `active_support.raise_on_invalid_cache_expiration_time = true` (7.1)**
- **Affects:** `app/views/exports/_export.html.erb:26`.
- **What breaks:** An expired export renders `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0`.
- **Repair:** `expires_in: [export.expires_at - Time.current, 1].max`. Ships on 7.0.
- **Why not `cache_if export.downloadable?`:** I tried it first. It broke `exports_controller_test.rb:59`, which expects the cached link to persist until the original deadline.

**D4. `active_record.postgresql_adapter_decode_dates = true` (7.2)**
- **Affects:** `app/models/notebook.rb:40`.
- **What breaks:** `select_rows` now returns `Date`, so `Date.iso8601(day)` raises `TypeError: no implicit conversion of Date into String` on the activity report.
- **Repair:** `[day.to_date, count]`. Ships on 7.0.
- **Validation:** Probe gives the same `[[Mon, 05 Oct 2026, 1], [Sun, 04 Oct 2026, 1]]` on both versions.

**Other 7.1 defaults**
- `active_support.cache_format_version = 7.1`. 7.0 processes cannot read 7.1-format cache entries.
- `active_support.message_serializer = :json_allow_marshal`. Cookies are already `:json`.
- `active_support.use_message_serializer_for_metadata`.
- `active_record.encryption.hash_digest_class = SHA256` (probe currently shows SHA1). The app does not use `encrypts`.
- `active_job.use_big_decimal_serializer`. Removed later; 8.1 always does this (see F19).
- `active_record.run_after_transaction_callbacks_in_order_defined`. No model defines multiple after_commit callbacks.
- `active_record.commit_transaction_on_non_local_return`. Deprecated in 7.2 and removed after; the behavior applies regardless (F17).
- `action_text.sanitizer_vendor` and `action_view.sanitizer_vendor = HTML5`. Covered by F2.
- `active_support.raise_on_invalid_cache_expiration_time`. See D3.
- Others with no effect on this app: `precompile_filter_parameters`, `log_file_size`, `before_committed_on_all_records`, `marshalling_format_version`, `dom_testing_default_html_version`, `action_dispatch.debug_exception_log_level`, `generate_secure_token_on = :initialize` (no `has_secure_token`), `sqlite3_adapter_strict_strings_by_default`, and `active_record.query_log_tags_format`.

**Other 7.2 defaults**
- `active_job.enqueue_after_transaction_commit`. The setting was removed in 8.1 and the per-job default is `false` (probe). `Citation#request_enrichment` and `Note#schedule_reminder` enqueue under `with_lock` on purpose, and that still works.
- `active_storage.web_image_content_types` and `yjit`: no effect on this app.

**8.0 defaults**
- `active_support.to_time_preserves_timezone = :zone`. Deprecated in 8.1 and already effectively in force (F14).
- `action_dispatch.strict_freshness`. `ExportDownloadsController` `stale?` with ETag plus Last-Modified: when both are sent, only the ETag is compared. The ETag is the blob checksum, so behavior is equivalent. Not verified by a request with mismatched headers.
- `Regexp.timeout = 1`: no effect on this app.

**8.1 defaults**
- `active_record.schema_dump_sorted_columns` (alphabetical columns in `db/schema.rb`).
- `action_view.render_tracker = :ruby`, `action_view.remove_hidden_field_autocomplete`, `active_support.escape_js_separators_in_json = false`, `action_controller.action_on_path_relative_redirect = :raise` (no path-relative redirects in the app), and `active_job` and `yjit` tweaks. No test changed.

---

## 3. Rollout, rollback, and mixed-version risks

- **Order of deploys:**
  1. Deploy on 7.0.8.7 first: the json pin (F1) and the 7.0-compatible repairs F2, F3, F5–F7, F9–F11, F13–F19 and D2–D4. With these, all 46 tests pass on 7.0.8.7.
  2. Then bump Rails together with F4, F8 and F12, which need 7.1 or later.
- **Active Job payloads (Sidekiq/Redis):**
  - Old to new: 7.0 TimeWithZone payloads deserialize fine on 8.1 (as UTC).
  - New to old: 8.1 TimeWithZone payloads include `time_zone`, which 7.0 ignores (probe: date `2026-10-05` on both).
  - BigDecimal arguments enqueued by 8.1 fail on 7.0 workers during rollback. F19 removes this risk if it ships first.
  - Scheduled `NoteReminderJob`s are stored by Sidekiq as epochs and are not affected.
- **Database records:** No migrations are needed.
  - `notes.tags` stays JSON and `notebooks.preferences` stays YAML.
  - F17 changes what is stored for failed imports on 7.2 and later. Without the repair, the import row and part of its notes are left behind.
- **`db/schema.rb`:** Running migrations on 8.1 rewrites the header to `Schema[8.1]` and `enable_extension "pg_catalog.plpgsql"`, and sorts columns alphabetically (dump diffed in the workspace). This is diff noise only, but it should be committed in one change so 7.0 and 8.1 developers do not keep rewriting it during rollout.
- **Cache:** Production sets no `cache_store`, so the default file store under `tmp/cache` is used, not Redis. The cache format stays 7.0 with `load_defaults 7.0`. When `cache_format_version 7.1` is adopted, a rollback to 7.0 sees those entries as misses. Only the export availability fragment is cached.
- **Cookies and tokens:** The `:json` cookie serializer and SHA256 key generator are the same on both versions (probe), so sessions survive rollout and rollback. Do not adopt `message_serializer` or `use_message_serializer_for_metadata` until rollback to 7.0 is no longer possible.

---

## 4. Verification log and open questions

**Executed in the workspace** (`/tmp/upgrade-rails-8.1.0`, now deleted; logs were at `/tmp/upgrade-rails-8.1.0/logs/` as `bundle-update.log`, `diag-*.log`, `tests-*.log`, `schema-load-*.log`)

- `gem-changes rails 7.0.8.7 8.1.0` (all `.gem` unpacks failed, as noted above).
- `upgrade-workspace setup rails 7.0.8.7 8.1.0`. Baseline passed (46 runs, 325 assertions, 0 failures). Upgraded failed to boot on F2.
- Repeated `upgrade-workspace test` runs on upgraded, revealing in turn: F3, F4, F5/F7/F6, F1, F9, F8, F10–F18.
- After the json pin I re-locked by hand with `BUNDLE_GEMFILE=…/upgraded/Gemfile bundle lock --local`, which gave json 2.7.2.
- `test --defaults 8.1` revealed D1, D2, D3 and D4.
- Final results:

| Run | Result |
|---|---|
| upgraded 8.1.0, `load_defaults 7.0` | 46 runs, 340 assertions, 0 failures |
| upgraded 8.1.0, `load_defaults 8.1` | 46 runs, 340 assertions, 0 failures |
| baseline 7.0.8.7 with the 7.0-compatible repairs | 46 runs, 325 assertions, 0 failures |

- Three `probe` batches compared routes, `to_time`, `[:id]`, HashWithIndifferentAccess keys, Active Job serialization in both directions, cookie, cache and digest config, rollback of `Import#apply`, next-day reminders, daily counts and highlight colors. Their outputs are quoted in the findings above.
- A real Sidekiq adapter enqueue, and a schema dump diff between the two versions.
- `cleanup`: databases dropped, and `git status` clean.

**Based on reading code only**
- The strict-freshness note in section 2 and the "no effect on this app" judgements there.
- The Sidekiq 8.2 removal timeline.

**Still proposed**
- A control test that `<script>` is still stripped after F2.
- A request test with a matching ETag but a changed Last-Modified under 8.0 defaults.
- A staging rollback drill: enqueue `DigestJob` on 8.1 and run it on a 7.0 worker after F19.
- Update `config/secrets.yml` comments and `docs/` mentions of `Rails.application.secrets`.

**Open questions**
- Is json 3.1.0 incompatible with every Rails 8.1.x patch, or only 8.1.0? Check before removing the pin.
- The browser test suite (`bin/rails test:system`) was not run. Action Text 8.1 adds the `action_text-trix` 2.x gem, while the layout loads a vendored `trix-1.3.5.js` (`app/views/layouts/application.html.erb:13`). Two Trix versions may conflict in the editor, so that needs manual and system-test checking.

---

**My notes:** I haven't upgraded anything yet. This is the plan only, and your checkout is unchanged. Before you approve the work, here are the main points:

- **Rails 8.1.0 won't work on its own.** You also need to pin `json` to `~> 2.7` (F1).
- **Ship in two steps.** First, deploy the 16 fixes that also work on 7.0. Then bump Rails along with F4, F8 and F12. Doing it in this order lets you roll back to 7.0 safely.
- **Run the browser tests before shipping.** They weren't run, and the rich-text editor may break because two versions of Trix (the editor library) get loaded together.

Should I start with the fixes that work on 7.0?