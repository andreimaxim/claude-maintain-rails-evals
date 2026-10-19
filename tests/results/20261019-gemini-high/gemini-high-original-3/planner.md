Upgrading **Margin Notes** from `rails` **`7.0.8.7`** to **`8.1.0`** (spanning Rails 7.1, 7.2, 8.0, and 8.1) is feasible on the current Ruby `3.3.6` runtime without upgrading `pg`, `puma`, `sidekiq`, `redis`, `pagy`, or `faraday`, provided `json` is constrained to `< 3` and **14 application-specific code/configuration incompatibilities** (plus **3 `load_defaults` interactions** and **3 rollout/rollback data-format transitions**) are addressed.

The working repository, `margin_notes_development`, `margin_notes_test`, and default Redis databases were left untouched; all experiments ran in isolated copies under `.amp/in/experiments/`.

---

## 1. Dependency Resolution (`Gemfile` / `Gemfile.lock`)

| Gem | Current (`7.0.8.7`) | Resolved (`8.1.0`) | Status & Notes |
| --- | --- | --- | --- |
| `rails` (and all 11 component gems) | `7.0.8.7` | `8.1.0` | Target upgrade |
| `action_text-trix` | *(bundled in `actiontext`)* | `2.1.19` | Extracted gem in Rails 7.1+/8.x; ships Trix 2.1.19 JS/CSS |
| `json` | *(stdlib `2.7.2`)* | `3.1.0` → **must pin `< 3` (`2.21.2`)** | **Blocker if unconstrained** (Finding R1 below) |
| `bigdecimal`, `drb`, `securerandom`, `uri` | *(stdlib)* | `4.1.3`, `2.2.3`, `0.4.1`, `1.1.2` | Added as explicit dependencies of `activesupport 8.1.0`; silences Ruby 3.3.6 `bigdecimal`/`drb` stdlib warnings (`csv` and `mutex_m` warnings remain unless `gem "csv"` is added) |
| `rack` / `rack-session` / `rackup` / `webrick` | `2.2.24` | `2.2.24` / `1.0.2` / `1.0.1` / `1.9.2` | Held on Rack 2.x by `sidekiq 6.5.12` (`rack ~> 2.0`), which keeps [bin/citation-provider](file:///home/user/workspace/repo/bin/citation-provider#L21-L53)'s `Rack::Handler::Puma` working |
| `useragent`, `net-imap` | *(none)*, `0.6.7` | `0.16.11`, `0.6.8` | Added by `actionpack 8.1.0` (`browser` support); patch bump |

---

## 2. Required Changes (Even with `config.load_defaults 7.0`)

These changes are required for the application to boot, load classes, and preserve existing domain behavior on Rails `8.1.0` even before bumping `config.load_defaults`.

### R1. Pin `gem "json", "< 3"` in `Gemfile`
- **Affected code:** [Gemfile](file:///home/user/workspace/repo/Gemfile#L7), affecting [Note](file:///home/user/workspace/repo/app/models/note.rb#L12) (`serialize :tags`) and `ActiveStorage::Blob#custom_metadata`.
- **Applicability:** Always when resolving `rails 8.1.0` against RubyGems today. `activesupport 8.1.0` adds an unbounded runtime dependency on `json` and calls `::JSON.parse(json, options)` with a positional `options = {}` Hash (`ActiveSupport::JSON.decode` in `active_support/json/decoding.rb:25`). `json 3.0+` (`3.1.0`) changed `JSON.parse` to keyword-only options (`def parse(source, on_load: nil, ..., **options)`), raising `ArgumentError: wrong number of arguments (given 2, expected 1)` on every `ActiveSupport::JSON.decode` call.
- **Recommendation:** Add `gem "json", "< 3"` to [Gemfile](file:///home/user/workspace/repo/Gemfile#L7) (resolves to `json 2.21.2`).
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails test test/models/note_test.rb:20` (exercises `ActiveStorage::Blob.create_and_upload!` and JSON metadata decoding).

### R2. Initialize `ActionText::ContentHelper.allowed_tags` before `+=`
- **Affected code:** [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3).
- **Applicability:** Always on boot (`zeitwerk:check`, `server`, `test`, `console`). In Rails 7.1+ / 8.1.0 (`action_text/content_helper.rb:10,68-70`), `ActionText::ContentHelper.allowed_tags` defaults to `nil` (falling back lazily in `#sanitizer_allowed_tags`), so `ActionText::ContentHelper.allowed_tags += %w[ details summary ]` raises `NoMethodError: undefined method '+' for nil` at boot.
- **Recommendation:**
  ```ruby
  ActionText::ContentHelper.allowed_tags ||=
    ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  ActionText::ContentHelper.allowed_tags += %w[ details summary ]
  ```
  *(Do not set `allowed_tags = %w[ details summary ]` alone, which would strip default HTML tags and `<action-text-attachment>`/`<figure>`/`<figcaption>`.)*
- **Works on `7.0.8.7`?** Yes (executed: `allowed_tags` is already non-nil on 7.0.8.7, so `||=` is a no-op).
- **Discriminating validation:** `bin/rails zeitwerk:check` and `bin/rails test test/controllers/notes_controller_test.rb:137` (`rich text keeps collapsible excerpts and drops unsafe markup`) + `test/controllers/notes_controller_test.rb:107` (verifies `<figure class="attachment">` is still allowed alongside `<details><summary>`).

### R3. Convert `Note` `enum` from Rails 7.0 keyword syntax to positional syntax
- **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10).
- **Applicability:** Whenever `Note` is loaded. Rails 7.2 deprecated and Rails 8.0 removed `enum status: {...}, _prefix: true`; `ActiveRecord::Enum#enum(name, values = nil, **options)` in 8.1.0 raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. ([Citation](file:///home/user/workspace/repo/app/models/citation.rb#L7) and [Export](file:///home/user/workspace/repo/app/models/export.rb#L10) already use positional syntax.)
- **Recommendation:** Change line 10 of [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) to:
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  ```
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails zeitwerk:check` and `bin/rails test test/controllers/notes_controller_test.rb:98` (checks `note.status_ready?` and `Note.statuses`).

### R4. Pass `coder:` keyword to `serialize` on `Note` and `Notebook`
- **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) (`serialize :tags, JSON`) and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) (`serialize :preferences`).
- **Applicability:** Always on Rails 8.1.0 for `Note` (`serialize(attr_name, coder: nil, ...)` removed the second positional argument in Rails 7.2+, raising `ArgumentError: wrong number of arguments (given 2, expected 1)`), and for `Notebook` when `config.active_record.default_column_serializer = nil` is enabled by `load_defaults 7.1+` (raising `ArgumentError: missing keyword: :coder`).
- **Recommendation:**
  - In [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12): `serialize :tags, coder: JSON`
  - In [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7): `serialize :preferences, coder: YAML`
- **Works on `7.0.8.7`?** **No** (source-verified in `activerecord-7.0.8.7/lib/active_record/attribute_methods/serialization.rb:103`: `coder:` is forwarded as an unknown keyword to `attribute`). Must land with the Rails gem upgrade (or be guarded on `ActiveRecord.version`).
- **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:107` and `bin/rails test test/controllers/notebooks_controller_test.rb:22`.

### R5. Replace `alias_attribute :highlight_color, :color` on `Note` with `alias_method`
- **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L13-L14).
- **Applicability:** Whenever `Note` attribute methods are defined (first `Note` instantiation or query). `:color` is defined by `store_accessor :settings, :color`, not as a schema/ActiveModel attribute. Rails 7.2 deprecated and Rails 8.0+ raises `ArgumentError: Note model aliases color, but color is not an attribute. Use alias_method :highlight_color, :color or define the method manually.`
- **Recommendation:** Replace `alias_attribute :highlight_color, :color` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L14) with:
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:107` and `test/controllers/notes_controller_test.rb:151` (tests both form rendering via `#highlight_color` and mass-assignment via `#highlight_color=`).

### R6. Split multi-path `get "/notes", "/journal", to: "notes#index"` in `config/routes.rb`
- **Affected code:** [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18).
- **Applicability:** Always when loading routes. Rails 8.0 deprecated and Rails 8.1 (`action_dispatch/routing/mapper.rb:1854`) raises `ArgumentError: Wrong number of arguments (expect 1, got 2)` when multiple paths are passed to `match`/`get`.
- **Recommendation:** Split into two route declarations in [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18):
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Works on `7.0.8.7`?** Yes (executed; generates identical `notes_path` and `journal_path` helpers).
- **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:6` (`lists the reader's notes newest first at both list paths`).

### R7. Replace `Rails.application.secrets` with `config_for(:secrets)` / `config.x.citation_provider`
- **Affected code:** [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18), [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13), and [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45-L122).
- **Applicability:** Whenever `Citation::Provider.new` is called with default arguments or in citation enrichment tests. `Rails.application.secrets` was deprecated in Rails 7.1 and removed in Rails 7.2 (`NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`).
- **Recommendation:** In [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), set `config.x.citation_provider = config_for(:secrets).citation_provider`, and read/stub `Rails.application.config.x.citation_provider` in [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13) and [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45-L122).
- **Works on `7.0.8.7`?** Yes (executed; `config_for(:secrets)` parses [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml) with ERB and returns `ActiveSupport::OrderedOptions` on both 7.0.8.7 and 8.1.0).
- **Discriminating validation:** `bin/rails test test/controllers/citation_enrichments_controller_test.rb` (including line 40's subprocess test verifying `CITATION_PROVIDER_*` env vars on fresh boot).

### R8. Update `config.action_dispatch.show_exceptions = :none` in `config/environments/test.rb`
- **Affected code:** [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31).
- **Applicability:** In `RAILS_ENV=test` whenever a request raises an exception (such as `assert_raises(ActiveRecord::RecordNotFound)` across 7 controller test files). Rails 7.1 deprecated boolean values for `show_exceptions` in favor of `:all`, `:rescuable`, `:none`, and Rails 7.2+/8.1 (`action_dispatch/middleware/exception_wrapper.rb:190-197`) treats `false` as the `else` branch (`true` / `:all`), catching all exceptions and rendering 404/500 pages instead of raising.
- **Recommendation:** Change `config.action_dispatch.show_exceptions = false` to `config.action_dispatch.show_exceptions = :none` in [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31). *(Use `:none`, not `:rescuable`, because Margin Notes tests assert `assert_raises(ActiveRecord::RecordNotFound)` rather than `assert_response :not_found`.)*
- **Works on `7.0.8.7`?** **No** unless conditional (`Rails.gem_version >= Gem::Version.new("7.1") ? :none : false`), because Rails 7.0.8.7 checks `get_header("action_dispatch.show_exceptions") == false` and treats `:none` as truthy (`show_exceptions = true`).
- **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:174` (`another reader's notes and notebooks cannot be reached`).

### R9. Pass a `Time` (`reminder_at`), not an `Integer` (`reminder_epoch`), to `NoteReminderJob.set(wait_until:)`
- **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61).
- **Applicability:** Whenever a reader schedules or postpones a reminder (`Note#schedule_reminder`). In Rails 7.0, `ActiveJob::Core#set` immediately converted `options[:wait_until].to_f`. In Rails 7.1+/8.1.0 (`active_job/core.rb:130,177`), `set` stores `options[:wait_until]` directly in `scheduled_at` and `#serialize` calls `scheduled_at.utc.iso8601(9)`, raising `NoMethodError: undefined method 'utc' for an instance of Integer` when `reminder_epoch` (`Integer`) is passed.
- **Recommendation:** Change line 61 of [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61) from `NoteReminderJob.set(wait_until: reminder_epoch).perform_later(self)` to:
  ```ruby
  job = NoteReminderJob.set(wait_until: reminder_at).perform_later(self)
  ```
- **Works on `7.0.8.7`?** Yes (executed: `reminder_at.to_f == reminder_epoch.to_f`).
- **Discriminating validation:** `bin/rails test test/controllers/reminders_controller_test.rb`.

### R10. Replace `wait: :exponentially_longer` with `wait: :polynomially_longer` in `CitationEnrichmentJob`
- **Affected code:** [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7).
- **Applicability:** Whenever `CitationEnrichmentJob` rescues `Citation::Provider::Unavailable` and computes retry backoff. Rails 7.1 deprecated `:exponentially_longer` and Rails 7.2+/8.1.0 (`active_job/exceptions.rb`) removed it, raising `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
- **Recommendation:** Change `wait: :exponentially_longer` to `wait: :polynomially_longer` in [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7).
- **Works on `7.0.8.7`?** **No** (`:polynomially_longer` was added in Rails 7.1; on 7.0.8.7 only `:exponentially_longer` or a proc `->(executions) { (executions**4) + 2 }` is accepted). Must land with the Rails upgrade (unless written as a proc).
- **Discriminating validation:** `bin/rails test test/controllers/citation_enrichments_controller_test.rb:60` (`a provider that stays unavailable or refuses the request leaves a visible failure`).

### R11. Remove `model: nil` from unbound `form_with` in `app/views/notes/index.html.erb`
- **Affected code:** [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12).
- **Applicability:** Whenever `/notes` or `/journal` renders. Rails 8.1.0 (`action_view/helpers/form_helper.rb:755-756`) defaults `model: false` and explicitly raises `ArgumentError: Passed nil to the :model argument, expect an object or false` when `model: nil` is passed.
- **Recommendation:** Remove `model: nil,` from [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12) (or pass `model: false`):
  ```erb
  <%= form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>
  ```
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:17` (`renders an unbound search form`).

### R12. Replace `.where(notebooks: @notebook)` with `.where(notebook: @notebook)` in `NotesController#index`
- **Affected code:** [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12).
- **Applicability:** Whenever `/notes?notebook_id=...` is requested. `Note` defines `belongs_to :notebook` (singular), not `:notebooks`. Rails 7.1 deprecated and Rails 7.2+/8.1.0 removed support for passing an ActiveRecord instance to a plural table-name key in `where(notebooks: @notebook)`, generating `WHERE "notes"."notebooks" = $1` and raising `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`.
- **Recommendation:** Change line 12 of [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) to:
  ```ruby
  @notes = @notes.where(notebook: @notebook)
  ```
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:27` and `test/controllers/notes_controller_test.rb:48`.

### R13. Replace `fragments.sum` with `fragments.join` in `Export#generate`
- **Affected code:** [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42).
- **Applicability:** Whenever `Export#generate` runs (`ExportJob`). Rails 7.0 deprecated `Enumerable#sum` without an initial value `""` on non-numeric arrays (`fragments` is an `Array<String>`), and Rails 7.1+/8.1.0 delegates to Ruby's `Array#sum(0)`, which raises `TypeError: String can't be coerced into Integer`.
- **Recommendation:** Change `finish(fragments.sum)` to `finish(fragments.join)` (or `fragments.sum("")`) in [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42).
- **Works on `7.0.8.7`?** Yes (executed; also eliminates the Rails 7.0 deprecation warning during export tests).
- **Discriminating validation:** `bin/rails test test/controllers/exports_controller_test.rb:9`.

### R14. Behavioral & Data-Integrity Changes in `Import`, `DigestMailer`, and `Note`
These four changes stem from upstream semantic shifts in Rails 7.1–8.1 where code does not crash at boot, but **silently corrupts data or changes domain output**:

1. **Non-local `return false` inside `Import#apply` `transaction` block now commits partial imports ([app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61)):**
   - **Cause:** In Rails 7.0, `return false unless row.note.save` inside `transaction do ... end` rolled back the transaction with a deprecation warning. In Rails 7.1 (`load_defaults 7.1`) and unconditionally in Rails 7.2+/8.1.0, a non-local `return` from `transaction` **commits** the transaction, leaving the `Import` record and any preceding valid rows saved in PostgreSQL when a later row fails validation.
   - **Recommendation:** Raise `ActiveRecord::Rollback` inside the transaction and return `false` outside:
     ```ruby
     def apply
       return false if invalid?

       applied = false
       transaction do
         save!
         rows.each do |row|
           raise ActiveRecord::Rollback unless row.note.save
         end
         applied = true
       end

       applied
     end
     ```
   - **Works on `7.0.8.7`?** Yes (executed).
   - **Discriminating validation:** `bin/rails test test/controllers/imports_controller_test.rb:48` (row 1 is valid, row 2 is invalid; verifies `record_counts` do not change).

2. **`citation[:id]` on custom primary key `Citation` (`primary_key = "doi"`) now returns `nil` in `Import#receipt` ([app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68)):**
   - **Cause:** In Rails 7.0 (`active_record/attribute_methods/read.rb:31`), `read_attribute(:id)` (`record[:id]`) aliased `@primary_key` (`"doi"`). Rails 7.1 deprecated and Rails 7.2+/8.1.0 removed that alias from `read_attribute`, so `citation[:id]` looks up a nonexistent `"id"` column and returns `nil`, producing blank DOIs in downloaded receipt CSVs (`"On idleness,\n"`).
   - **Recommendation:** Change `citation && citation[:id]` in [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68) to `citation&.doi` (or `note.citation_doi`).
   - **Works on `7.0.8.7`?** Yes (executed).
   - **Discriminating validation:** `bin/rails test test/controllers/imports_controller_test.rb:6` (line 45 checks the CSV receipt body for `10.1000/Essays.1`).

3. **`HashWithIndifferentAccess#stringify_keys` now stringifies `Integer` line-number keys in `imports/preview.html.erb` ([app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22), [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L38-L42)):**
   - **Cause:** `Import#annotations` keys its `HashWithIndifferentAccess` by `row.line` (`Integer`). In Rails 7.0, `HashWithIndifferentAccess#stringify_keys` was a no-op (`dup`), leaving keys as `Integer`s (`2`, `4`). Rails 7.1+/8.1.0 removed that no-op override, so `annotations = @import.annotations.stringify_keys` converts keys to `"2"`, `"4"`, and `annotations[row.line]` (with `Integer` `row.line` on lines 41–42) returns `nil`, silently omitting all annotations from the import preview page.
   - **Recommendation:** Change `<% annotations = @import.annotations.stringify_keys %>` in [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) to `<% annotations = @import.annotations %>`.
   - **Works on `7.0.8.7`?** Yes (executed).
   - **Discriminating validation:** `bin/rails test test/controllers/imports_controller_test.rb:6` (lines 22 and 24 assert annotation `<dd>` elements on lines 2 and 4).

4. **`ActiveJob::Serializers::TimeWithZoneSerializer` now preserves `time_zone`, changing `DigestMailer#daily_digest` from UTC day to local day ([app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L9)):**
   - **Cause:** In Rails 7.0, `TimeWithZoneSerializer` only serialized `"value"` and deserialized via `Time.iso8601(hash["value"]).in_time_zone` (the worker's `Time.zone`, `UTC`). In Rails 8.0/8.1 (`active_job/serializers/time_with_zone_serializer.rb:8-17`), it also serializes `"time_zone"` and deserializes in that zone (`"Eastern Time (US & Canada)"`). Consequently, when a reader in Eastern Time requests a digest at `2026-10-05 03:30 UTC` (`2026-10-04 23:30 EDT`), `User#request_digest` reserves `digest_requests:2026-10-05` in Redis, but `DigestMailer#daily_digest` receives `requested_at` in EDT and queries `2026-10-04` (`requested_at.to_date` and `requested_at.all_day`), mismatching the reservation's UTC day.
   - **Recommendation:** Convert `requested_at` to UTC in [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7):
     ```ruby
     @reader, requested_at = params[:reader], params[:requested_at].in_time_zone("UTC")
     ```
   - **Works on `7.0.8.7`?** Yes (executed).
   - **Discriminating validation:** `bin/rails test test/controllers/digests_controller_test.rb:5` (tests a request at `03:30 UTC` / `23:30-04:00` across the UTC midnight boundary).

5. **`ActiveSupport::TimeWithZone#to_time` now attaches the `TimeZone` object instead of a fixed numeric `utc_offset` ([app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L43-L45)):**
   - **Cause:** In Rails 7.0, `TimeWithZone#to_time` called `getlocal(utc_offset)` (fixed offset `-04:00`), so `reminder_at.to_time + 86_400` across the Nov 1, 2026 DST boundary returned `2026-11-01 09:00:00 -04:00`. In Rails 8.0/8.1 (`active_support/time_with_zone.rb:497-499`), `to_time` calls `getlocal(time_zone)`, so `+ 86_400` transitions to EST (`2026-11-01 08:00:00 -05:00`).
   - **Recommendation:** Either:
     - **Preserve exact current contract & test:** Use `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44) (works on both `7.0.8.7` and `8.1.0`), **or**
     - **Accept the DST-aware `Time` behavior:** Keep `reminder_at.to_time + 86_400` and update [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L20-L21), the comment on [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L40-L42), and [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156) to expect `"2026-11-01T08:00:00-05:00"`.
   - **Discriminating validation:** `bin/rails test test/controllers/reminders_controller_test.rb:6`.

---

## 3. Optional Framework Default Adoption (`config.load_defaults 7.0` → `8.1`)

When advancing [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12) from `config.load_defaults 7.0` to `config.load_defaults 8.1`, three new defaults directly affect Margin Notes (executed in `.amp/in/experiments/upgrade-8.1/log/step7_test_with_8.1_defaults.log`):

### D1. `config.active_record.postgresql_adapter_decode_dates = true` (Rails 7.2 default)
- **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L41) (`Notebook#daily_note_counts`).
- **Effect:** `Note.connection.select_rows(days)` now decodes PostgreSQL `DATE(notes.created_at)` (OID 1082) directly into a Ruby `Date` object instead of an ISO 8601 `String`, causing `Date.iso8601(day)` to raise `TypeError: no implicit conversion of Date into String`.
- **Recommendation:** Update [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40) to handle both `Date` and `String`:
  ```ruby
  Note.connection.select_rows(days).map { |day, count| [day.is_a?(Date) ? day : Date.iso8601(day), count] }
  ```
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails test test/controllers/activity_reports_controller_test.rb:8`.

### D2. `config.active_support.raise_on_invalid_cache_expiration_time = true` (Rails 7.1 default)
- **Affected code:** [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26).
- **Effect:** `cache [export, "availability"], expires_in: export.expires_at - Time.current` passes a negative `expires_in` whenever a completed export is viewed after `export.expires_at`. Under `load_defaults 7.0` on Rails 8.1.0, `ActiveSupport::Cache::Store#merged_options` logs `ArgumentError: Cache expiration time is invalid, cannot be negative` to `Rails.logger.error` and reports it to `ActiveSupport.error_reporter`; under `load_defaults 7.1+`/`8.1`, it raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0` (even on a cache hit).
- **Recommendation:** Guard `expires_in` in [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26):
  ```erb
  <% cache [export, "availability"], expires_in: (export.expires_at - Time.current if export.expires_at.future?) do %>
  ```
- **Works on `7.0.8.7`?** Yes (executed).
- **Discriminating validation:** `bin/rails test test/controllers/exports_controller_test.rb:59`.

### D3. `config.active_record.raise_on_assign_to_attr_readonly = true` (Rails 7.1 default)
- **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L8) (`attr_readonly :slug`), [app/views/notebooks/_form.html.erb](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L13) (`<%= form.hidden_field :slug %>`), and [app/controllers/notebooks_controller.rb](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L40) (`params.require(:notebook).permit(:name, :slug, :export_heading)`).
- **Effect:** `ActiveRecord::ReadonlyAttributes::HasReadonlyAttributes` in Rails 8.1.0 (`active_record/readonly_attributes.rb:49-60`) raises `ActiveRecord::ReadonlyAttributeError: slug` on **any** `write_attribute` / `_write_attribute` call on a persisted record—**even when the submitted `slug` is identical to the current value**. Because the notebook settings form resubmits `<%= form.hidden_field :slug %>` and [test/controllers/notebooks_controller_test.rb](file:///home/user/workspace/repo/test/controllers/notebooks_controller_test.rb#L29-L38) and [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L40-L43) explicitly contract that resubmitting `:slug` on `PATCH /notebooks/:id` succeeds while keeping the original slug, enabling this default breaks `NotebooksController#update`.
- **Recommendation:** Either:
  - Keep `config.active_record.raise_on_assign_to_attr_readonly = false` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb) to preserve the documented contract, **or**
  - Stop permitting `:slug` on `update` (only on `create`, though `before_validation :assign_slug, on: :create` overwrites it anyway) if the application intentionally changes that contract.
- **Discriminating validation:** `bin/rails test test/controllers/notebooks_controller_test.rb:22`.

### D4. Other Notable Defaults in `7.1`–`8.1` and Optional Config Tidy-ups
- **`config.active_storage.variant_processor = :disabled` (recommended in [config/application.rb](file:///home/user/workspace/repo/config/application.rb)):** Under `load_defaults 7.0+`, `variant_processor` defaults to `:vips`. In Rails 7.1+/8.1.0, `ActiveStorage::Engine` eagerly resolves `ActiveStorage.variant_transformer` on boot and logs `Generating image variants require the image_processing gem. Please add gem "image_processing", "~> 1.2" to your Gemfile or set config.active_storage.variant_processor = :disabled.` Setting `:disabled` matches [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L28) (note: `:disabled` is only recognized on Rails 7.1+, not 7.0.8.7).
- **Built-in `SidekiqAdapter` deprecation warning (Rails 8.1):** When `ActiveJob::Base` loads with `queue_adapter = :sidekiq` and `sidekiq 6.5.12`, `ActiveJob::QueueAdapters::SidekiqAdapter#check_adapter` emits:
  `DEPRECATION WARNING: The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2. Please upgrade sidekiq gem to version 7.3.3 or later to use the sidekiq gem's adapter.`
  This does not break Rails 8.1.0 (since `config.active_support.disallowed_deprecation_warnings = []`), but upgrading `sidekiq` to `>= 7.3.3` (and `redis >= 5`) will be required before Rails 8.2.
- **Do NOT enable `ApplicationJob.enqueue_after_transaction_commit = true`:** In Rails 8.1.0, `SidekiqAdapter` defaults `enqueue_after_transaction_commit` to `false`. Keeping it `false` is essential for [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) and [Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb#L14-L24), which intentionally enqueue jobs inside `with_lock` so a Redis connection error rolls back the database transaction.
- **Action Text / Trix assets:** `actiontext 8.1.0` pulls in `action_text-trix 2.1.19` (Trix 2.1.19). Keeping the classic script `<%= javascript_include_tag "trix-1.3.5.js" %>` in [app/views/layouts/application.html.erb](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L13) and `pin "@rails/actiontext", to: "actiontext.js"` in [config/importmap.rb](file:///home/user/workspace/repo/config/importmap.rb#L8) continues to compile and work under Sprockets, though `trix.css` (via `*= require trix` in [app/assets/stylesheets/actiontext.css](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L6)) now comes from `action_text-trix 2.1.19`. Optionally, once on 8.1.0, the vendored `trix-1.3.5.js` workaround for Trix 1.3.4 can be retired in favor of `pin "trix"` and `pin "@rails/actiontext", to: "actiontext.esm.js"`.
- **Other `7.1`–`8.1` defaults verified compatible:**
  - `action_dispatch.strict_freshness = true` (8.0): Compatible with `stale?(etag: blob.checksum, last_modified: blob.created_at)` in [ExportDownloadsController#show](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11).
  - `action_view.sanitizer_vendor` / `action_text.sanitizer_vendor = Rails::HTML5::Sanitizer` (7.1) and `dom_testing_default_html_version = :html5` (7.1): Active because `nokogiri 1.19.4` supports HTML5; verified against all view and sanitization tests.
  - `action_view.remove_hidden_field_autocomplete = true` (8.1), `action_controller.action_on_path_relative_redirect = :raise` (8.1), `active_record.raise_on_missing_required_finder_order_columns = true` (8.1), `yjit = !Rails.env.local?` (8.1): Verified compatible.

---

## 4. Mixed-Version Rollout, Stored Data, and Rollback Risks

Executed cross-version tests between `7.0.8.7` and `8.1.0` (`.amp/in/experiments/upgrade-8.1/log/payloads_from_8.1.json` and `log/rollback_8.1_to_7.0.json`) revealed three concrete rollout/rollback hazards:

```diagram
┌───────────────────────────┐    7.0 -> 8.1: OK (reads Marshal + "_rails.message")     ┌───────────────────────────┐
│      Rails 7.0.8.7        │ ───────────────────────────────────────────────────────▶ │        Rails 8.1.0        │
│                           │                                                          │                           │
│  • MessageVerifier:       │    8.1 -> 7.0: FAILS with load_defaults 7.1+             │  • load_defaults 7.1+:    │
│    Marshal + "message"    │ ◀ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │    JSON + "_rails.data"   │
│  • ActiveJob BigDecimal:  │    - attachable_sgid in DB & blob signed_id raise        │  • ActiveJob BigDecimal:  │
│    PERMITTED_TYPES (raw)  │      NoMethodError: undefined method `unpack1` for nil   │    BigDecimalSerializer   │
│  • Dev secret file:       │    - Queued DigestJob raises ActiveJob::Deserialization  │  • Dev/test secret file:  │
│    tmp/development_secret │      Error (unknown BigDecimalSerializer)                │    tmp/local_secret.txt   │
└───────────────────────────┘                                                          └───────────────────────────┘
```

### M1. Stored Action Text `attachable_sgid`s and Active Storage `signed_id`s break on rollback if `7.1` message serializer defaults are enabled immediately
- **Mechanism:** `load_defaults 7.1` sets `config.active_support.message_serializer = :json_allow_marshal` and `config.active_support.use_message_serializer_for_metadata = true`. Under these settings, `SignedGlobalID.verifier` (`blob.attachable_sgid`, **which is persisted inside `action_text_rich_texts.body` in PostgreSQL whenever a note with an attachment is saved**) and `ActiveStorage.verifier` (`blob.signed_id`) emit `{"_rails":{"data":...,"pur":...}}` instead of `{"_rails":{"message":...,"pur":...}}`.
- **Executed result:** Rails 8.1.0 reads 7.0.8.7 `signed_id` and `attachable_sgid` tokens (`true`), but Rails 7.0.8.7 crashes when reading 8.1.0-generated tokens with **`NoMethodError: undefined method 'unpack1' for nil`** (because 7.0.8.7's `ActiveSupport::Messages::Metadata` calls `Base64.strict_decode64(data["_rails"]["message"])`). Any note with an attachment saved under 8.1.0 with `load_defaults 8.1` will 500 on 7.0.8.7 after a rollback or during a rolling deploy.
- **Recommendation:** During rollout (until rollback to `7.0.8.7` is no longer needed), pin in [config/application.rb](file:///home/user/workspace/repo/config/application.rb):
  ```ruby
  config.active_support.message_serializer = :marshal
  config.active_support.use_message_serializer_for_metadata = false
  ```
  *(Note: `_margin_notes_session` cookies are unaffected and returned HTTP 200 in both directions because `ActionDispatch::Cookies` already uses `cookies_serializer = :json` with `use_message_serializer_for_metadata: false`.)*

### M2. Queued `DigestJob` arguments in Sidekiq/Redis fail to deserialize on `7.0.8.7` workers
- **Mechanism:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L41) passes `reading_completion` as a `BigDecimal` to `DigestJob.perform_later`. In Rails 7.0.8.7, `BigDecimal` was in `ActiveJob::Arguments::PERMITTED_TYPES` and Sidekiq serialized it to a JSON string `"0.5"`. In Rails 7.1+/8.1.0, `ActiveJob` wraps `BigDecimal` in `{"_aj_serialized" => "ActiveJob::Serializers::BigDecimalSerializer", "value" => "0.5"}` (which also stops Sidekiq from warning about non-native JSON args on `DigestJob`).
- **Executed result:**
  - `7.0.8.7` producer → `8.1.0` worker: **Succeeds** (`"0.5"` arrives as `String`, converted by `BigDecimal(params[:completion])` in [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10)).
  - `8.1.0` producer → `7.0.8.7` worker: **Fails** with `ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- **Recommendation:** Either upgrade Sidekiq workers to Rails 8.1.0 before web processes (and drain the `default` queue before rolling back), or pass `reading_completion.to_s` in [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L41) if zero-downtime mixed-version queue rollback is required (`CitationEnrichmentJob`, `NoteReminderJob`, and `ExportJob` were verified compatible in both directions).

### M3. Development `secret_key_base` file moved from `tmp/development_secret.txt` to `tmp/local_secret.txt`
- **Mechanism:** When `SECRET_KEY_BASE` and `config/master.key` are absent in `development`, Rails 7.0.8.7 stores the generated secret in `tmp/development_secret.txt`, whereas Rails 7.1+/8.1.0 uses `tmp/local_secret.txt`.
- **Effect:** After upgrading a development checkout that has existing attachments in `margin_notes_development`, generating a new secret in `tmp/local_secret.txt` invalidates existing `attachable_sgid`s stored in `action_text_rich_texts.body` (rendering them as missing attachments).
- **Recommendation:** In local development environments with existing rich-text attachments, copy `tmp/development_secret.txt` to `tmp/local_secret.txt` during the upgrade.

### M4. Database Schema Dump (`db/schema.rb`) and Cache Format
- Running `bin/rails db:schema:dump` on 8.1.0 writes `ActiveRecord::Schema[8.1].define`, `enable_extension "pg_catalog.plpgsql"`, and alphabetically sorted columns. Rails 7.0.8.7 cannot run `db:schema:load` on a `Schema[8.1]` file (`Unknown migration version "8.1"`). All 12 existing migrations in `db/migrate/` were executed with `db:migrate:reset` and `db:rollback` on 8.1.0 and require no changes.
- `load_defaults 7.1` bumps `config.active_support.cache_format_version = 7.1` and `config.active_record.marshalling_format_version = 7.1`. Margin Notes uses process-local `:memory_store` / `:null_store` (or local `tmp/cache/`), not a shared Redis cache; if a shared cache is used in deployment, keep `cache_format_version = 7.0` until all 7.0 nodes are retired.

---

## 5. Summary of Phased Upgrade Plan

1. **Phase 1 — Preparatory changes on Rails `7.0.8.7` (all verified passing on `7.0.8.7`):**
   - Pin `gem "json", "< 3"` in [Gemfile](file:///home/user/workspace/repo/Gemfile#L7).
   - Apply **R2** ([config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3)), **R3** (`enum :status` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10)), **R5** (`alias_method :highlight_color` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L14)), **R6** (split `get "/notes"` and `get "/journal"` in [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18)), **R7** (`config_for(:secrets)` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13), [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45-L122)), **R9** (`wait_until: reminder_at` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61)), **R11** (remove `model: nil` in [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12)), **R12** (`where(notebook: @notebook)` in [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12)), **R13** (`fragments.join` in [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42)), **R14** ([app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L70), [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22), [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7), [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44)), **D1** ([app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40)), and **D2** ([app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26)).
2. **Phase 2 — Gem bump to `rails 8.1.0` (changes that require Rails 7.1+/8.1.0):**
   - Bump `gem "rails", "8.1.0"` in [Gemfile](file:///home/user/workspace/repo/Gemfile#L7) and run `bundle lock --update rails json`.
   - Apply **R4** (`serialize :tags, coder: JSON` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) and `serialize :preferences, coder: YAML` in [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7)), **R8** (`config.action_dispatch.show_exceptions = :none` in [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31)), and **R10** (`wait: :polynomially_longer` in [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7)).
   - Copy `tmp/development_secret.txt` to `tmp/local_secret.txt` if present (**M3**).
   - Deploy Sidekiq workers before web processes (**M2**).
3. **Phase 3 — Adopt `config.load_defaults 8.1`:**
   - Set `config.load_defaults 8.1` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12) with `config.active_record.raise_on_assign_to_attr_readonly = false` (**D3**) and `config.active_storage.variant_processor = :disabled` (**D4**).
   - Keep `message_serializer = :marshal` and `use_message_serializer_for_metadata = false` until rollback to `7.0.8.7` is no longer needed (**M1**).

---

## 6. Executed Evidence, Retained Artifacts, and Remaining Questions

All executed checks ran in isolated copies with dedicated `BUNDLE_PATH`, `BOOTSNAP_CACHE_DIR`, `tmp/storage`, PostgreSQL databases (`margin_notes_exp70_test`, `margin_notes_exp81_test`, since dropped), and Redis databases (`14` and `15`, since flushed):

| Variant & Check | Command | Result | Retained Artifact / Log Path |
| --- | --- | --- | --- |
| Baseline `7.0.8.7` (`zeitwerk:check` + `test`) | `REDIS_URL=redis://localhost:6379/14 BOOTSNAP_CACHE_DIR=... RAILS_ENV=test bin/rails db:test:prepare zeitwerk:check test` | `All is good!`, `46 runs, 325 assertions, 0 failures, 0 errors` (emits `Enumerable.sum` deprecation) | `.amp/in/experiments/baseline-7.0/log/baseline_test.log` |
| Preparatory changes on `7.0.8.7` | `REDIS_URL=redis://localhost:6379/14 BOOTSNAP_CACHE_DIR=... RAILS_ENV=test bin/rails zeitwerk:check test` | `All is good!`, `46 runs, 325 assertions, 0 failures, 0 errors` (0 Rails deprecations) | `.amp/in/experiments/baseline-7.0/log/preparatory_changes_on_7.0_test.log`, `log/variant_preparatory_7.0.patch` |
| Dependency resolution for `rails 8.1.0` | `BUNDLE_PATH=.../vendor/bundle bundle lock --update rails` (and `--update json` with `json < 3`) | Resolved 106 gems (`rails 8.1.0`, `action_text-trix 2.1.19`, `json 2.21.2`) | `.amp/in/experiments/upgrade-8.1/Gemfile.lock`, `log/gemfile_lock.diff`, `log/bundle_install.log` |
| Unmodified app on `8.1.0` (`zeitwerk:check` / progressive boot & test runs) | `BUNDLE_PATH=... REDIS_URL=redis://localhost:6379/15 RAILS_ENV=test bin/rails zeitwerk:check` & `bin/rails test` | Captured exact stack traces for R1–R14 | `.amp/in/experiments/upgrade-8.1/log/unmodified_8.1_zeitwerk.log`, `log/step1_zeitwerk.log`..`log/step5_test_with_7.0_defaults.log` |
| `8.1.0` with R1–R14 fixed (`load_defaults 7.0`) | `BUNDLE_PATH=... REDIS_URL=redis://localhost:6379/15 RAILS_ENV=test bin/rails test` | `46 runs, 340 assertions, 0 failures, 0 errors` | `.amp/in/experiments/upgrade-8.1/log/step6_test_with_7.0_defaults.log` |
| `8.1.0` switching to `load_defaults 8.1` (before D1–D3) | `BUNDLE_PATH=... REDIS_URL=redis://localhost:6379/15 RAILS_ENV=test bin/rails test` | `46 runs, 325 assertions, 0 failures, 3 errors` (D1 `Date.iso8601`, D2 negative `expires_in`, D3 `ReadonlyAttributeError: slug`) | `.amp/in/experiments/upgrade-8.1/log/step7_test_with_8.1_defaults.log` |
| `8.1.0` with `load_defaults 8.1` + D1–D3 fixed | `BUNDLE_PATH=... REDIS_URL=redis://localhost:6379/15 RAILS_ENV=test bin/rails test` | `46 runs, 340 assertions, 0 failures, 0 errors` | `.amp/in/experiments/upgrade-8.1/log/step8_test_with_8.1_defaults_fixed.log`, `log/variant_upgrade_8.1.patch` |
| `development` & `production` boot, `assets:precompile`, migrations, `citation-provider` | `bin/rails runner ...`, `bin/rails assets:precompile`, `bin/rails db:migrate:reset db:migrate:redo STEP=10` | Booted cleanly; captured `variant_processor` and `SidekiqAdapter` warnings, schema diff, and asset manifest | `.amp/in/experiments/upgrade-8.1/log/dev_boot.log`, `log/prod_boot.log`, `log/development.log`, `log/assets_precompile.log`, `log/migrations_check.log`, `log/schema_rb.diff` |
| Cross-version `7.0 ↔ 8.1` compatibility | Bidirectional `bin/rails runner` scripts testing `signed_id`, `attachable_sgid`, `_margin_notes_session`, YAML/JSON columns, and Sidekiq payloads | Verified `7.0 → 8.1` compatibility and reproduced `8.1 → 7.0` rollback failures (M1, M2) | `.amp/in/experiments/upgrade-8.1/log/payloads_from_7.0.json`, `log/payloads_from_8.1.json`, `log/rollback_8.1_to_7.0.json` |

### Remaining Questions & Proposed Post-Upgrade Checks
1. **DST postpone preview contract (R14.5):** Confirm whether product behavior prefers preserving the fixed-offset preview (`2026-11-01T09:00:00-04:00` via `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`) or adopting Rails 8.0/8.1's DST-aware `TimeWithZone#to_time` (`2026-11-01T08:00:00-05:00`).
2. **Notebook `slug` resubmission contract (D3):** Confirm whether `NotebooksController#update` should continue silently ignoring resubmitted `slug` parameters (`config.active_record.raise_on_assign_to_attr_readonly = false`) or stop submitting/permitting `:slug` on persisted notebooks.
3. **Browser system tests (`bin/rails test:system`):** No system test files currently exist in `test/system/`, and [test/application_system_test_case.rb](file:///home/user/workspace/repo/test/application_system_test_case.rb#L4) configures non-headless `:chrome`. If browser tests are added or Trix 1.3.5 is replaced with `action_text-trix` 2.1.19, propose validating rich-text editing and direct attachment upload in a headless Chrome system test.