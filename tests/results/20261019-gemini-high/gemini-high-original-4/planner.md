### Executive Summary

Upgrading Margin Notes from `rails 7.0.8.7` to `rails 8.1.0` spans four release boundaries (`7.1`, `7.2`, `8.0`, `8.1`). Without code changes, the application fails to boot in [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3), fails `bin/rails zeitwerk:check` on [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10-L12), and fails 45 of 46 existing tests once booted.

Even after fixing all test failures under `config.load_defaults 7.0`, several behavior and data-format changes affect production/development runtime, mixed-version rollout, rollback, and `config.load_defaults 8.1` adoption:
- **Unpinned `json` gem resolution (`json 3.1.0`)**: `activesupport 8.1.0` adds `json (>= 0)` as a runtime dependency, which resolves `json 3.1.0` and breaks `ActiveSupport::JSON.decode` (`ArgumentError: wrong number of arguments (given 2, expected 1)`).
- **Transaction rollback semantics on non-local `return` in `Import#apply`**: Rails 8.0+ commits instead of rolling back when returning early from `transaction do ... end`, persisting partial CSV batches on row validation failure.
- **Active Job `TimeWithZoneSerializer` and `BigDecimalSerializer` changes**: `TimeWithZoneSerializer` now preserves the reader's time zone (`time_zone` key), shifting `DigestMailer` from UTC day to local day near midnight unless converted to `.utc`; `BigDecimalSerializer` writes a payload that Rails `7.0.8.7` Sidekiq workers cannot deserialize during rollback (`ActiveJob::DeserializationError`).
- **Active Storage `Blob` touching parent records on `AnalyzeJob`**: `ActiveStorage::Blob` now touches attachments (and transitively `ActionText::RichText` $\to$ `Note`, and `Export`) when asynchronous analysis completes, altering `Note#updated_at` (used by `DigestMailer`) and busting `Export` fragment cache keys.
- **`config.load_defaults 7.1`–`8.1` rollout/rollback hazards**: Enabling `load_defaults 7.1+` switches `MessageVerifier`/`MessageEncryptor` metadata to `use_message_serializer_for_metadata = true` (`"_rails":{"data":...}`), which causes `NoMethodError: undefined method 'unpack1' for nil` on Rails `7.0.8.7` for any `ActionText` attachment `sgid` persisted in `action_text_rich_texts.body`, `ActiveStorage` `signed_id`, or session cookie.

The working checkout and its development/test databases and Redis default DB were left unmodified. All experiments were executed in isolated copies under `.amp/in/experiments/` with dedicated PostgreSQL databases (`margin_notes_exp_*`), Redis databases (`10`–`14`), and storage directories.

---

### 1. Required Changes (With `config.load_defaults 7.0` Retained)

The following changes are required for Rails `8.1.0` even while keeping `config.load_defaults 7.0` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12).

#### 1.1 Dependency Resolution: Constrain `json` to `< 3` (`~> 2.7`)
- **Affected code**: [Gemfile](file:///home/user/workspace/repo/Gemfile#L7), [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12-L13) (`tags` serialized JSON and `settings` `jsonb`), `ActiveStorage::Blob#metadata`.
- **Applicability**: Always when resolving `rails 8.1.0` against rubygems.org (`activesupport 8.1.0` adds runtime dependency `json >= 0`; Bundler resolves `json 3.1.0`).
- **Upstream change & failure**: `ActiveSupport::JSON.decode(json, options = {})` calls `::JSON.parse(json, options)` with a positional Hash. In `json 3.0+`, `JSON.parse(source, ..., **options)` accepts only keyword arguments, raising `ArgumentError: wrong number of arguments (given 2, expected 1)` on every JSON column/attribute decode.
- **Recommendation**: Add `gem "json", "~> 2.7"` to `Gemfile` alongside `gem "rails", "8.1.0"` (resolves `json 2.21.2`).
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7` / compatible with Ruby 3.3.6).
- **Discriminating validation**: Load or create any `Note` (which decodes `tags` and `settings`) or `ActiveStorage::Blob` (`bin/rails test test/models/note_test.rb:4`).

#### 1.2 Boot Failure: `ActionText::ContentHelper.allowed_tags` is `nil` at Initializer Time
- **Affected code**: [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3).
- **Applicability**: Always on boot (`bin/rails server`, `zeitwerk:check`, `db:prepare`, `test`, `sidekiq`).
- **Upstream change & failure**: In Rails 7.1+, `ActionText::ContentHelper.allowed_tags` defaults to `nil` (falling back lazily in `ActionText::ContentHelper#sanitizer_allowed_tags` to `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]`). `ActionText::ContentHelper.allowed_tags += %w[ details summary ]` raises `NoMethodError: undefined method '+' for nil` at boot.
- **Recommendation**: Initialize `allowed_tags` from the default allowlist plus Action Text attachment tags before appending `details` and `summary`:
  ```ruby
  ActionText::ContentHelper.allowed_tags ||=
    ActionText::ContentHelper.sanitizer.class.allowed_tags +
    [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  ActionText::ContentHelper.allowed_tags += %w[ details summary ]
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`; on `7.0.8.7`, `allowed_tags` is already populated so `||=` is a no-op).
- **Discriminating validation**: Run `bin/rails test test/controllers/notes_controller_test.rb:107` and `test/controllers/notes_controller_test.rb:137` to verify both `<details><summary>` excerpts AND `<figure class="attachment">` rich-text embeds remain in sanitized output while `<script>`/`onclick` are stripped.

#### 1.3 Removed Keyword Syntax for `ActiveRecord::Enum`
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) (`enum status: { draft: 0, ready: 1 }, _prefix: true`). Note that [app/models/citation.rb](file:///home/user/workspace/repo/app/models/citation.rb#L7) and [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L10) already use the positional syntax.
- **Applicability**: Always when `Note` is loaded.
- **Upstream change & failure**: Keyword-argument `enum` definitions and `:_prefix` were deprecated in Rails 7.2 and removed in Rails 8.0, raising `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- **Recommendation**: Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) to:
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails zeitwerk:check` and `bin/rails test test/controllers/notes_controller_test.rb:27` (verifying `Note.statuses`, `status_ready`, and `status_ready?`).

#### 1.4 Removed Positional `coder` Argument in `ActiveRecord::AttributeMethods::Serialization#serialize`
- **Affected code**:
  - [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12): `serialize :tags, JSON`
  - [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7): `serialize :preferences`
- **Applicability**: `Note` fails unconditionally on Rails 7.2+/8.1.0 (`ArgumentError: wrong number of arguments (given 2, expected 1)`). `Notebook` works under `load_defaults 7.0` (where `default_column_serializer` is `Coders::YAMLColumn`) but fails under `load_defaults 7.1+` (`ArgumentError: missing keyword: :coder`).
- **Recommendation**:
  - In [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12): `serialize :tags, coder: JSON`
  - In [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7): `serialize :preferences, coder: YAML`
- **Works on current version (`7.0.8.7`)?**: **No** (`serialize` in `7.0.8.7` forwards `**options` to `attribute`, raising `ArgumentError: unknown keyword: :coder`). Apply in the Rails upgrade commit.
- **Discriminating validation**: `bin/rails zeitwerk:check`, `bin/rails test test/controllers/notes_controller_test.rb:107` (persisting and reloading `tags`), and `bin/rails test test/controllers/notebooks_controller_test.rb:22` (persisting and reloading `export_heading` in `preferences`).

#### 1.5 Disallowed `alias_attribute` Targeting Non-Column `store_accessor`
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) (`store_accessor :settings, :color` followed by `alias_attribute :highlight_color, :color`).
- **Applicability**: Always when `Note` attribute methods are generated (`Note.new`, `Note.create!`, fixture access).
- **Upstream change & failure**: Rails 7.1 deprecated and Rails 7.2+ removed `alias_attribute` pointing to an attribute not in `attribute_types` (`has_attribute?("color")` is `false` because `color` is a `store_accessor` key on `settings`), raising:
  `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.`
- **Recommendation**: Replace `alias_attribute :highlight_color, :color` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L14) with:
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/notes_controller_test.rb:107` and `test/controllers/notes_controller_test.rb:151` (verifying form binding, mass assignment of `highlight_color`, validation on `color`, and persistence in `settings["color"]`).

#### 1.6 Removed Multiple Path Arguments in Route Mapper `get`
- **Affected code**: [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) (`get "/notes", "/journal", to: "notes#index"`).
- **Applicability**: Always when routes are drawn.
- **Upstream change & failure**: Passing multiple path strings to `get`/`post`/etc. was deprecated in Rails 7.2 and removed in Rails 8.0, raising `ArgumentError: Wrong number of arguments (expect 1, got 2)` at [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) and preventing all subsequent routes (`notes`, `digest`, `root`) from being defined.
- **Recommendation**: Split into two route declarations (keeping `/notes` first or defining `/journal` then `/notes` with `as:` so `notes_path` resolves to `"/notes"` and `journal_path` to `"/journal"`):
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/notes_controller_test.rb:6` (requests both `notes_path` and `journal_path` and checks `next_url.path == notes_path` at line 63).

#### 1.7 Removed `Rails.application.secrets` and `config/secrets.yml` Autoloading
- **Affected code**:
  - [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13): `def initialize(settings = Rails.application.secrets.citation_provider.to_h)`
  - [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18)
  - [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45) and [lines 117–122](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122).
- **Applicability**: Any citation metadata lookup or test invoking `Citation::Provider`.
- **Upstream change & failure**: `Rails.application.secrets` was deprecated in Rails 7.1 and removed in Rails 7.2, raising `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application:...>`.
- **Recommendation**: Load the configuration via `config_for` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24):
  ```ruby
  config.citation_provider = config_for(:secrets)[:citation_provider]
  ```
  (or move `config/secrets.yml` to `config/citation_provider.yml` and call `config.citation_provider = config_for(:citation_provider)`), and update [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13) and [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45) to use `Rails.application.config.citation_provider`.
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/citation_enrichments_controller_test.rb` (including line 40, which spawns a fresh `bin/rails runner` subprocess with `CITATION_PROVIDER_*` env vars).

#### 1.8 Removed Boolean `false` Support in `config.action_dispatch.show_exceptions`
- **Affected code**: [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31) (`config.action_dispatch.show_exceptions = false`).
- **Applicability**: Test environment (`RAILS_ENV=test`).
- **Upstream change & failure**: Rails 7.1 replaced boolean `true`/`false` with `:all`, `:rescuable`, `:none`. In Rails 8.1.0 ([action_dispatch/middleware/exception_wrapper.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/actionpack-8.1.0/lib/action_dispatch/middleware/exception_wrapper.rb#L190-L197)), `case config when :none then false when :rescuable then rescue_response? else true end` treats `false` as `:all` (rendering 404/500 error pages instead of raising exceptions), breaking all `assert_raises(ActiveRecord::RecordNotFound)` assertions across 7 controller test files.
- **Recommendation**: Change [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31) to:
  ```ruby
  config.action_dispatch.show_exceptions = :none
  ```
  *(Note: Do not use `:rescuable`, as this application's tests and [TESTING.md](file:///home/user/workspace/repo/TESTING.md#L60-L61) contract that `ActiveRecord::RecordNotFound` is raised in integration tests rather than rendered as 404.)*
- **Works on current version (`7.0.8.7`)?**: **No** (on `7.0.8.7`, `:none` is truthy so `request.show_exceptions?` evaluates to `true`). Apply in the Rails upgrade commit.
- **Discriminating validation**: `bin/rails test test/controllers/notebooks_controller_test.rb:41` (`assert_raises(ActiveRecord::RecordNotFound)`).

#### 1.9 Removed `Enumerable#sum` Fallback on String Array in `Export#generate`
- **Affected code**: [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42) (`finish(fragments.sum)`).
- **Applicability**: Every Markdown export execution (`Export#generate` / `ExportJob`).
- **Upstream change & failure**: Active Support's `Enumerable#sum` override on `Array` without an initial accumulator was deprecated in Rails 7.0 and removed in Rails 7.1. Ruby's native `Array#sum` defaults the initial value to `0`, raising `TypeError: String can't be coerced into Integer`.
- **Recommendation**: Change `finish(fragments.sum)` to `finish(fragments.join)` (or `finish(fragments.sum(""))`) in [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42).
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`; also eliminates the Rails 7.0 deprecation warning).
- **Discriminating validation**: `bin/rails test test/controllers/exports_controller_test.rb:9`.

#### 1.10 Non-Local `return` Inside `transaction` Block Commits Instead of Rolling Back in `Import#apply`
- **Affected code**: [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61).
- **Applicability**: Whenever `Import#apply` encounters an invalid row after saving the `Import` and any preceding valid rows.
- **Upstream change & failure**: In Rails 7.0, `return false` inside `transaction do ... end` rolled back the transaction. In Rails 7.1 (`commit_transaction_on_non_local_return`) and unconditionally in Rails 8.0+, a non-local `return` out of `transaction` **commits** the transaction. In `Import#apply`, `save!` and earlier valid `row.note.save` calls are committed to PostgreSQL when a later row fails validation, violating [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L47-L49).
- **Recommendation**: Raise `ActiveRecord::Rollback` instead of returning from inside the `transaction` block in [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61):
  ```ruby
  def apply
    return false if invalid?

    saved = false
    transaction do
      save!
      rows.each do |row|
        raise ActiveRecord::Rollback unless row.note.save
      end
      saved = true
    end

    saved
  end
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/imports_controller_test.rb:48` (submits a 2-row CSV where row 1 is valid and row 2 is invalid, asserting `[Import.count, Note.count, Citation.count, ActionText::RichText.count]` does not change).

#### 1.11 Removed `[:id]` Implicit Primary-Key Lookup on Custom Primary Key (`Citation`) in `Import#receipt`
- **Affected code**: [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68) (`csv << [ note.title, citation && citation[:id] ]`).
- **Applicability**: Generating CSV import receipts (`ImportsController#show` with `format: :csv`) when imported notes have citations.
- **Upstream change & failure**: `Citation` has `primary_key = "doi"` and no `id` column ([db/schema.rb](file:///home/user/workspace/repo/db/schema.rb#L55)). In Rails 7.0, `read_attribute(:id)` (`citation[:id]`) mapped `"id"` to `@primary_key` (`"doi"`). Rails 7.1 deprecated and Rails 7.2 removed that fallback ([active_record/attribute_methods/read.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activerecord-8.1.0/lib/active_record/attribute_methods/read.rb#L29-L34)), so `citation[:id]` now returns `nil`, producing blank DOIs in the downloaded CSV receipt.
- **Recommendation**: Replace `citation && citation[:id]` with `citation&.doi` (or `citation&.id`) in [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68).
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/imports_controller_test.rb:6` (line 45 asserts the CSV body includes `"On idleness,10.1000/Essays.1"`).

#### 1.12 `HashWithIndifferentAccess#stringify_keys` Now Stringifies Integer Keys in `imports/preview.html.erb`
- **Affected code**: [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) and [lines 42–44](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L42-L44), interacting with [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L38-L42).
- **Applicability**: Previewing any CSV import that contains annotations (`ImportPreviewsController#create` and `ImportsController#create` error re-render).
- **Upstream change & failure**: `Import#annotations` builds an `ActiveSupport::HashWithIndifferentAccess` keyed by integer source line numbers (`row.line`, e.g., `2`). In Rails 7.0, `HashWithIndifferentAccess#stringify_keys` was a no-op (leaving integer key `2` as `2`). In Rails 7.1+, `stringify_keys` converts all keys via `to_s` (`2` $\to$ `"2"`), while `HashWithIndifferentAccess#[]` only converts `Symbol` keys to `String` (not `Integer` keys). Thus `annotations[row.line]` (`annotations[2]`) returns `nil` and annotations disappear from the preview page.
- **Recommendation**: Change [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) from `<% annotations = @import.annotations.stringify_keys %>` to `<% annotations = @import.annotations %>`.
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/imports_controller_test.rb:6` (asserts `#line_2 dd` and `#line_4 dd` render the row annotations in the preview).

#### 1.13 `where(notebooks: @notebook)` Plural Table Name With Model Instance in `NotesController#index`
- **Affected code**: [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) (`@notes = @notes.where(notebooks: @notebook)`).
- **Applicability**: Filtering `/notes` or `/journal` by `notebook_id`.
- **Upstream change & failure**: Passing a plural joined table key (`notebooks:`) mapped to an Active Record model instance (`@notebook`) instead of a column hash (`notebooks: { id: @notebook.id }`) or the singular `belongs_to` association name (`notebook: @notebook`) was deprecated in Rails 7.1 and removed in Rails 7.2+. Rails 8.1.0 treats `:notebooks` as a column on `notes`, raising `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`.
- **Recommendation**: Change [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) to `@notes = @notes.where(notebook: @notebook)`.
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/notes_controller_test.rb:27` and `test/controllers/notes_controller_test.rb:48`.

#### 1.14 `form_with(model: nil, ...)` Raises `ArgumentError` in `notes/index.html.erb`
- **Affected code**: [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12) (`<%= form_with(model: nil, url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>`).
- **Applicability**: Rendering `/notes` or `/journal`.
- **Upstream change & failure**: Passing `model: nil` explicitly to `form_with` raises `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false` in Rails 8.0+.
- **Recommendation**: Omit `model: nil` (`form_with(url: notes_path, method: :get, ...)`) or pass `model: false` in [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12).
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/notes_controller_test.rb:17`.

#### 1.15 `ActiveJob` `set(wait_until:)` Rejects Raw Integer Epoch in `Note#schedule_reminder`
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61) (`job = NoteReminderJob.set(wait_until: reminder_epoch).perform_later(self)`).
- **Applicability**: Scheduling or postponing any note reminder (`RemindersController#create`, `ReminderPostponementsController#create`).
- **Upstream change & failure**: In Rails 7.0, `set(wait_until:)` called `.to_f` on its argument. In Rails 7.1+/8.1.0, `ActiveJob::Core#scheduled_at=` calls `.utc` on `wait_until` to store a `Time` object, raising `NoMethodError: undefined method 'utc' for an instance of Integer` when given `reminder_epoch` (`Integer`).
- **Recommendation**: Pass `Time.at(reminder_epoch)` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61):
  ```ruby
  job = NoteReminderJob.set(wait_until: Time.at(reminder_epoch)).perform_later(self)
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`; `Time.at(reminder_epoch).to_f` produces the same `job[:at]` epoch integer/float).
- **Discriminating validation**: `bin/rails test test/controllers/reminders_controller_test.rb`.

#### 1.16 Removed `wait: :exponentially_longer` in `CitationEnrichmentJob`
- **Affected code**: [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) (`retry_on Citation::Provider::Unavailable, wait: :exponentially_longer, attempts: 3`).
- **Applicability**: Whenever `CitationEnrichmentJob` rescues `Citation::Provider::Unavailable` to schedule a retry.
- **Upstream change & failure**: `:exponentially_longer` was renamed to `:polynomially_longer` (deprecated in Rails 7.1, removed in Rails 7.2), raising `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
- **Recommendation**: Change `wait: :exponentially_longer` to `wait: :polynomially_longer` in [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7).
- **Works on current version (`7.0.8.7`)?**: **No** (`:polynomially_longer` was added in Rails 7.1; `activejob-7.0.8.7` only recognizes `:exponentially_longer`). Apply in the Rails upgrade commit.
- **Discriminating validation**: `bin/rails test test/controllers/citation_enrichments_controller_test.rb:60`.

#### 1.17 `ActiveJob::Serializers::TimeWithZoneSerializer` Now Preserves Time Zone in `DigestMailer`
- **Affected code**: [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L9) and [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L35-L41).
- **Applicability**: Sending a reading digest (`DigestJob` $\to$ `DigestMailer#daily_digest`) for any reader whose `User#time_zone` is not UTC when local time is on a different calendar date from UTC.
- **Upstream change & failure**: In Rails 7.0, `TimeWithZoneSerializer#deserialize` called `Time.iso8601(hash["value"]).in_time_zone`, deserializing `requested_at` into the worker's `Time.zone` (`UTC`). In Rails 8.0+/8.1.0 ([active_job/serializers/time_with_zone_serializer.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activejob-8.1.0/lib/active_job/serializers/time_with_zone_serializer.rb#L8-L17)), `TimeWithZoneSerializer` serializes `"time_zone"` and deserializes `requested_at` into the reader's zone (e.g., `America/New_York`). Because `DigestMailer#daily_digest` calls `requested_at.to_date` and `requested_at.all_day` without `.utc`, it queries and dates the digest by the reader's local date (`2026-10-04`) instead of the UTC date (`2026-10-05`) that `User#request_digest` reserved in Redis (`digest_requests:2026-10-05`).
- **Recommendation**: Convert `requested_at` to UTC in [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L9) (and update the comment):
  ```ruby
  @reader, requested_at = params.values_at(:reader, :requested_at)
  requested_at = requested_at.utc
  @date = requested_at.to_date
  @notes = @reader.notes.status_ready.where(updated_at: requested_at.all_day).includes(:notebook).order(:updated_at, :id)
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/digests_controller_test.rb:5` (tests a reader in `Eastern Time (US & Canada)` requesting a digest at `2026-10-05 03:30 UTC` / `2026-10-04 23:30 EDT`).

#### 1.18 `ActiveSupport::TimeWithZone#to_time` Now Preserves TimeZone Object Across DST in `Note#next_day_reminder_at`
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L43-L45) (`reminder_at.to_time + 86_400`) and [app/views/notes/_reminder.html.erb](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L19).
- **Applicability**: Displaying the "24 hours later" postponement preview on a scheduled reminder across a Daylight Saving Time transition.
- **Upstream change & failure**: In Rails 7.0 ([active_support/time_with_zone.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activesupport-7.0.8.7/lib/active_support/time_with_zone.rb#L495-L501)), `TimeWithZone#to_time` called `getlocal(utc_offset)` (a fixed integer UTC offset such as `-04:00`), so `+ 86_400` kept `-04:00` (`2026-11-01T09:00:00-04:00`). In Rails 8.1.0 ([active_support/time_with_zone.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activesupport-8.1.0/lib/active_support/time_with_zone.rb#L497-L499)), `TimeWithZone#to_time` unconditionally calls `getlocal(time_zone)` (attaching the `ActiveSupport::TimeZone` object), so `+ 86_400` transitions across DST to `2026-11-01T08:00:00-05:00`, failing [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21).
- **Recommendation**:
  - To preserve the current documented contract ([ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156) and [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21)), change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44) to:
    ```ruby
    reminder_at.getlocal(reminder_at.utc_offset) + 86_400
    ```
  - Alternatively, if the team prefers to adopt Rails 8.1's DST-aware `to_time` (so the preview shows `08:00 -05:00`, matching what postponing actually produces), keep `reminder_at.to_time + 86_400` and update [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156), the comment in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L40-L43), and [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21).
- **Works on current version (`7.0.8.7`)?**: **Yes** (`reminder_at.getlocal(reminder_at.utc_offset) + 86_400` works identically on `7.0.8.7`).
- **Discriminating validation**: `bin/rails test test/controllers/reminders_controller_test.rb:6`.

---

### 2. Behavior Changes Not Revealed by Existing Tests & Optional Default Adoption (`config.load_defaults 8.1`)

#### 2.1 Uncovered Behavior Change: `ActiveStorage::Blob` Touches Attachments (`Note` and `Export`) When `AnalyzeJob` Runs
- **Affected code**: `Note` (`has_rich_text :body` $\to$ `ActionText::RichText` $\to$ `has_many_attached :embeds`), [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L9) (`where(updated_at: requested_at.all_day).order(:updated_at, :id)`), and `Export` (`has_one_attached :file`, cached by `[export, "availability"]` in [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26)).
- **Applicability**: Occurs even under `config.load_defaults 7.0` whenever `ActiveStorage::AnalyzeJob` runs in Sidekiq after a blob is attached to a `Note` or `Export`. Existing tests do not reveal this because `notes_controller_test.rb` and `exports_controller_test.rb` do not run `perform_enqueued_jobs` for Active Job after attaching blobs (`ExportJob` is drained via Sidekiq's queue, not Active Job's queue).
- **Upstream change & effect**: In Rails 7.1+/8.1.0 ([active_storage/blob.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activestorage-8.1.0/app/models/active_storage/blob.rb#L44) and [active_storage/engine.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activestorage-8.1.0/lib/active_storage/engine.rb#L86)), `ActiveStorage.touch_attachment_records` defaults to `true` and `ActiveStorage::Blob` runs `after_update :touch_attachments`. When `ActiveStorage::AnalyzeJob` updates `blob.metadata` (`{"identified"=>true, "analyzed"=>true}`), it touches `ActiveStorage::Attachment` $\to$ `ActionText::RichText` $\to$ `Note#updated_at` (and `Export#updated_at`).
- **Recommendation**: If background blob analysis should not advance `Note#updated_at` (which determines UTC-day membership and ordering in `DigestMailer`) or bust `Export` fragment caches after `Export#finish`, set in [config/application.rb](file:///home/user/workspace/repo/config/application.rb):
  ```ruby
  config.active_storage.touch_attachment_records = false
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (`config.active_storage` is an `OrderedOptions` in `7.0.8.7`).
- **Discriminating validation**: Executed in `.amp/in/experiments/analyze-job-touch-check.out`: create a `Note` with an embedded blob, set `note.update_columns(updated_at: 2.days.ago)`, run `ActiveStorage::AnalyzeJob.perform_now(blob)`, and assert `note.reload.updated_at` does not advance to `Time.current`.

#### 2.2 Negative Cache `expires_in` in `exports/_export.html.erb`
- **Affected code**: [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26) (`<% cache [export, "availability"], expires_in: export.expires_at - Time.current do %>`).
- **Applicability**: Rendering `/notebooks/:notebook_id/exports` with caching enabled when any completed export has expired (`export.expires_at < Time.current`).
- **Upstream change & effect**:
  - Under `load_defaults 7.0` on Rails 8.1.0 ([active_support/cache.rb](file:///home/user/.local/share/mise/installs/ruby/3.3.6/lib/ruby/gems/3.3.0/gems/activesupport-8.1.0/lib/active_support/cache.rb#L922-L945)): `ActiveSupport::Cache::Store#merged_options` deletes negative `:expires_in`, reports `ArgumentError: Cache expiration time is invalid, cannot be negative` to `ActiveSupport.error_reporter`, and logs an error via `logger.error`.
  - Under `load_defaults 7.1`–`8.1` (`config.active_support.raise_on_invalid_cache_expiration_time = true`): raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative`.
- **Recommendation**: Guard `expires_in` so it is only passed while `export.expires_at.future?` in [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26):
  ```erb
  <% cache [export, "availability"], expires_in: (export.expires_at - Time.current if export.expires_at.future?) do %>
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7` and `defaults-8.1.0`).
- **Discriminating validation**: `bin/rails test test/controllers/exports_controller_test.rb:59` with `config.active_support.raise_on_invalid_cache_expiration_time = true`.

#### 2.3 `postgresql_adapter_decode_dates = true` (in `load_defaults 7.2+`) Breaks `Notebook#daily_note_counts`
- **Affected code**: [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L41) (`Note.connection.select_rows(days).map { |day, count| [Date.iso8601(day), count] }`).
- **Applicability**: Adopting `config.load_defaults 7.2`, `8.0`, or `8.1` (which sets `config.active_record.postgresql_adapter_decode_dates = true`).
- **Upstream change & failure**: With `postgresql_adapter_decode_dates = true`, PostgreSQL `date` columns returned by `select_rows` are already decoded to Ruby `Date` instances instead of ISO 8601 `String`s, so `Date.iso8601(day)` raises `TypeError: no implicit conversion of Date into String`.
- **Recommendation**: Support both `Date` and `String` in [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40):
  ```ruby
  Note.connection.select_rows(days).map { |day, count| [day.is_a?(Date) ? day : Date.iso8601(day), count] }
  ```
- **Works on current version (`7.0.8.7`)?**: **Yes** (executed in `prep-on-7.0.8.7` and `defaults-8.1.0`).
- **Discriminating validation**: `bin/rails test test/controllers/activity_reports_controller_test.rb:8` under `load_defaults 8.1`.

#### 2.4 `raise_on_assign_to_attr_readonly = true` (in `load_defaults 7.1+`) Breaks `NotebooksController#update`
- **Affected code**: [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L8) (`attr_readonly :slug`), [app/controllers/notebooks_controller.rb](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L26) and [line 40](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L40) (`params.require(:notebook).permit(:name, :slug, :export_heading)`), and [app/views/notebooks/_form.html.erb](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L13) (`<%= form.hidden_field :slug %>`).
- **Applicability**: Adopting `config.load_defaults 7.1`–`8.1` (which sets `config.active_record.raise_on_assign_to_attr_readonly = true`).
- **Upstream change & failure**: Under `raise_on_assign_to_attr_readonly = true`, assigning to `slug` on a persisted `Notebook`—even when resubmitting the unchanged `slug` from the settings form's hidden field—raises `ActiveRecord::ReadonlyAttributeError: slug`.
- **Recommendation**: Because [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L40-L42) and [test/controllers/notebooks_controller_test.rb](file:///home/user/workspace/repo/test/controllers/notebooks_controller_test.rb#L25-L38) explicitly contract that the settings form resubmits `slug` and `update` ignores changes to it via `attr_readonly`, explicitly set:
  ```ruby
  config.active_record.raise_on_assign_to_attr_readonly = false
  ```
  when adopting `config.load_defaults 7.1`–`8.1`.
- **Works on current version (`7.0.8.7`)?**: **No** (setting was added in Rails 7.1).
- **Discriminating validation**: `bin/rails test test/controllers/notebooks_controller_test.rb:22` under `load_defaults 8.1`.

#### 2.5 Schema Dumper Formatting in `db/schema.rb`
- **Affected code**: [db/schema.rb](file:///home/user/workspace/repo/db/schema.rb).
- **Applicability**: Running `bin/rails db:migrate` or `bin/rails db:schema:dump` on Rails 8.1.0.
- **Upstream change**: Rails 8.1 updates the header to `ActiveRecord::Schema[8.1].define(...)`, qualifies `enable_extension "pg_catalog.plpgsql"`, and sorts table columns alphabetically. No new tables or columns are required by Active Storage or Action Text in 8.1.0 (`active_storage_variant_records`, `service_name`, and nullable `checksum` are already present in `db/schema.rb`).

---

### 3. Mixed-Version Rollout, Stored Data, and Rollback Risks

| Surface | Stored / In-Flight Artifact | Rollout (`7.0.8.7` $\to$ `8.1.0`) | Rollback (`8.1.0` $\to$ `7.0.8.7`) / Mixed Fleet | Mitigation |
| --- | --- | --- | --- | --- |
| **Active Job in Redis (`DigestJob`)** | `BigDecimal` 3rd argument (`reading_completion`) in [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L41) | **Safe**: `7.0` writes JSON string `"0.6667"`, which `8.1` deserializes as `String` and `DigestMailer` parses via `BigDecimal(params[:completion])`. | **Breaks on `7.0` worker**: `8.1` serializes `BigDecimal` with `ActiveJob::Serializers::BigDecimalSerializer`; `7.0.8.7` raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. | Pass `reading_completion.to_s` in [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L41) (or drain Sidekiq queues before rollback). Passing `.to_s` works on both `7.0.8.7` and `8.1.0` and also silences Sidekiq's non-native JSON warning on `7.0.8.7`. |
| **Active Job in Redis (`DigestJob`)** | `TimeWithZone` 2nd argument (`requested_at`) | **Safe with fix 1.17**: `7.0` omits `"time_zone"` key; `8.1` falls back to `Time.zone` (`UTC`). | **Safe**: `8.1` adds `"time_zone" => "America/New_York"`; `7.0` ignores the extra key and parses `"value"` into `UTC`. | Apply fix **1.17** (`requested_at = requested_at.utc` in `DigestMailer`) before or during upgrade. |
| **Action Text `sgid` in PostgreSQL & Active Storage `signed_id` & Session Cookies** | `<action-text-attachment sgid="...">` persisted in `action_text_rich_texts.body`; `rails_blob_path` URLs; `_margin_notes_session` cookie | **Safe**: `8.1` verifies `7.0` tokens under both `load_defaults 7.0` and `load_defaults 8.1`. | **Safe under `load_defaults 7.0`**. **Breaks under `load_defaults 7.1`–`8.1`**: `use_message_serializer_for_metadata = true` writes `"_rails":{"data":...}`; `7.0.8.7` calls `Base64.strict_decode64(data["_rails"]["message"])` (`nil`) and raises unhandled `NoMethodError: undefined method 'unpack1' for nil`. | Keep `config.load_defaults 7.0` (or set `config.active_support.use_message_serializer_for_metadata = false` and `config.active_support.message_serializer = :marshal`) until the upgrade is permanent and rollback to `7.0.8.7` is no longer needed. |
| **Fragment Cache** | `[export, "availability"]` in `MemoryStore` / cache store | `load_defaults 7.0` uses `cache_format_version = 7.0` (compatible). `load_defaults 7.1+` uses `cache_format_version = 7.1`. | `7.0.8.7` cannot read `cache_format_version = 7.1` entries. | Cache is in-memory (`:memory_store` / `:null_store`); keep `cache_format_version = 7.0` if introducing a shared cache across mixed versions. |
| **Database Serialized Columns** | `notebooks.preferences` (YAML), `notes.tags` (JSON), `notes.settings` (`jsonb`), `ExportJob` Sidekiq payload | **Safe**: `YAML` and `JSON` column formats and native Sidekiq `ExportJob` JSON args are compatible in both directions. | **Safe** in both directions. | None required beyond `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`. |

---

### 4. Recommended Rollout Sequence

1. **Phase 1 — Preparatory Commit on Rails `7.0.8.7` (all backward-compatible)**:
   - Update [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) (`allowed_tags ||= ...`).
   - Update [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) (separate `get "/notes"` and `get "/journal"`).
   - Update [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10-L61) (positional `enum :status`, `alias_method :highlight_color`, `wait_until: Time.at(reminder_epoch)`, `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`).
   - Update [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) (`where(notebook: @notebook)`).
   - Update [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12) (`form_with(url: notes_path, ...)`).
   - Update [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42) (`fragments.join`).
   - Update [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L68) (`raise ActiveRecord::Rollback` in `apply`, `citation&.doi` in `receipt`) and [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) (`@import.annotations`).
   - Update [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L8) (`requested_at = requested_at.utc`) and optionally pass `reading_completion.to_s` in [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L41) for rollback-safe `DigestJob` arguments.
   - Replace `Rails.application.secrets.citation_provider` with `config.citation_provider = config_for(:secrets)[:citation_provider]` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13), and [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45).
   - Update [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26) (`expires_in: (export.expires_at - Time.current if export.expires_at.future?)`) and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40) (`day.is_a?(Date) ? day : Date.iso8601(day)`).

2. **Phase 2 — Upgrade Commit (`rails 7.0.8.7` $\to$ `8.1.0`, keeping `config.load_defaults 7.0`)**:
   - In [Gemfile](file:///home/user/workspace/repo/Gemfile#L7): set `gem "rails", "8.1.0"` and add `gem "json", "~> 2.7"`; run `bundle update rails`.
   - In [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7): switch `serialize` to `coder: JSON` and `coder: YAML`.
   - In [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7): switch `wait: :exponentially_longer` to `wait: :polynomially_longer`.
   - In [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31): switch `config.action_dispatch.show_exceptions = :none`.
   - Optionally set `config.active_storage.touch_attachment_records = false` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb) to preserve `7.0` attachment timestamp behavior.

3. **Phase 3 — Post-Rollout Framework Defaults Adoption (`config.load_defaults 8.1`)**:
   - Once rollback to `7.0.8.7` is no longer needed, set `config.load_defaults 8.1` and `config.active_record.raise_on_assign_to_attr_readonly = false` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12), and regenerate [db/schema.rb](file:///home/user/workspace/repo/db/schema.rb).

---

### 5. Executed Experiments and Retained Artifacts

All experiments were run in isolated copies under `.amp/in/experiments/` with `mise exec --`:

1. **`baseline-7.0.8.7`** (`.amp/in/experiments/baseline-7.0.8.7`):
   - **DB / Queue**: `margin_notes_exp_70_dev`, `margin_notes_exp_70_test`, `REDIS_URL=redis://localhost:6379/10` ([config/database.yml](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/config/database.yml), [Gemfile.lock](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/Gemfile.lock)).
   - **Commands & outputs**: `bin/rails db:prepare` ([db_prepare.out](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/db_prepare.out)), `bin/rails zeitwerk:check` ([zeitwerk.out](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/zeitwerk.out)), `bin/rails test` ([test.out](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/test.out), [log/test.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/log/test.log)) $\to$ `46 runs, 325 assertions, 0 failures, 0 errors`, emitting `Enumerable.sum` deprecation in `app/models/export.rb:42`.

2. **`raw-8.1.0`** (`.amp/in/experiments/raw-8.1.0`):
   - **DB / Queue**: `margin_notes_exp_81_raw_dev`, `margin_notes_exp_81_raw_test`, `REDIS_URL=redis://localhost:6379/11` ([config/database.yml](file:///home/user/workspace/repo/.amp/in/experiments/raw-8.1.0/config/database.yml), [Gemfile.lock](file:///home/user/workspace/repo/.amp/in/experiments/raw-8.1.0/Gemfile.lock)).
   - **Commands & outputs**: `bundle update rails` ([bundle_update.out](file:///home/user/workspace/repo/.amp/in/experiments/raw-8.1.0/bundle_update.out)), `bin/rails zeitwerk:check` ([zeitwerk.out](file:///home/user/workspace/repo/.amp/in/experiments/raw-8.1.0/zeitwerk.out)), `bin/rails db:prepare` ([db_prepare.out](file:///home/user/workspace/repo/.amp/in/experiments/raw-8.1.0/db_prepare.out)), `bin/rails test` ([test.out](file:///home/user/workspace/repo/.amp/in/experiments/raw-8.1.0/test.out)) $\to$ aborts on boot at `config/initializers/action_text.rb:3`.

3. **`probing-8.1.0`** (`.amp/in/experiments/probing-8.1.0`):
   - **DB / Queue**: `margin_notes_exp_81_probe_dev`, `margin_notes_exp_81_probe_test`, `REDIS_URL=redis://localhost:6379/12` ([config/database.yml](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/config/database.yml), [Gemfile](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/Gemfile), [Gemfile.lock](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/Gemfile.lock) with `rails 8.1.0` and `json 2.21.2`).
   - **Commands & outputs**: Iterative failure traces ([zeitwerk_step1.out](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/zeitwerk_step1.out) through [test_step8.out](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/test_step8.out), [log/test.log](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/log/test.log)), full migration rebuild `bin/rails db:drop db:create db:migrate` ([db_migrate_from_scratch.out](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/db_migrate_from_scratch.out)), and asset precompilation `bin/rails assets:precompile` ([assets_precompile.out](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/assets_precompile.out), [importmap_json.out](file:///home/user/workspace/repo/.amp/in/experiments/probing-8.1.0/importmap_json.out)) $\to$ `46 runs, 340 assertions, 0 failures, 0 errors`.

4. **`defaults-8.1.0`** (`.amp/in/experiments/defaults-8.1.0`):
   - **DB / Queue**: `margin_notes_exp_81_defaults_dev`, `margin_notes_exp_81_defaults_test`, `REDIS_URL=redis://localhost:6379/13` ([config/database.yml](file:///home/user/workspace/repo/.amp/in/experiments/defaults-8.1.0/config/database.yml), [config/application.rb](file:///home/user/workspace/repo/.amp/in/experiments/defaults-8.1.0/config/application.rb)).
   - **Commands & outputs**: `bin/rails test` before and after fixing `load_defaults 8.1` regressions ([test_defaults_81.out](file:///home/user/workspace/repo/.amp/in/experiments/defaults-8.1.0/test_defaults_81.out), [test_defaults_81_fixed.out](file:///home/user/workspace/repo/.amp/in/experiments/defaults-8.1.0/test_defaults_81_fixed.out), [log/test.log](file:///home/user/workspace/repo/.amp/in/experiments/defaults-8.1.0/log/test.log)) $\to$ `46 runs, 340 assertions, 0 failures, 0 errors`.

5. **`prep-on-7.0.8.7`** (`.amp/in/experiments/prep-on-7.0.8.7`):
   - **DB / Queue**: `margin_notes_exp_70_prep_dev`, `margin_notes_exp_70_prep_test`, `REDIS_URL=redis://localhost:6379/14` ([config/database.yml](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/config/database.yml), [Gemfile.lock](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/Gemfile.lock)).
   - **Commands & outputs**: Verified all Phase 1 preparatory edits on `rails 7.0.8.7` via `bin/rails zeitwerk:check` ([zeitwerk.out](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/zeitwerk.out)) and `bin/rails test` ([test.out](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/test.out)) $\to$ `46 runs, 325 assertions, 0 failures, 0 errors`.

6. **Cross-Version & Background Analysis Checks**:
   - Token (`sgid`, `signed_id`) and Active Job (`DigestJob`, `NoteReminderJob`, `CitationEnrichmentJob`) cross-version verification script ([run_cross_version_checks.sh](file:///home/user/workspace/repo/.amp/in/experiments/run_cross_version_checks.sh)) and output ([cross-version-checks.out](file:///home/user/workspace/repo/.amp/in/experiments/cross-version-checks.out)).
   - `ActiveStorage::AnalyzeJob` parent-record touching comparison ([analyze-job-touch-check.out](file:///home/user/workspace/repo/.amp/in/experiments/analyze-job-touch-check.out)).

---

### 6. Unverified Claims and Remaining Questions

- **Browser / System Tests (`bin/rails test:system`)**: `test/system/` currently contains no test files, and [test/application_system_test_case.rb](file:///home/user/workspace/repo/test/application_system_test_case.rb#L4) configures non-headless Chrome (`driven_by :selenium, using: :chrome`). While `bin/rails assets:precompile` and `bin/importmap json` were executed and verified, interactive Trix editing and direct-upload XHR flows in a live browser were not executed.
- **Postponement Preview Behavior Across DST (`Note#next_day_reminder_at`)**: Confirm whether Margin Notes wants to keep the existing fixed-offset preview (`reminder_at.getlocal(reminder_at.utc_offset) + 86_400`, matching [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156) and [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21)) or adopt Rails 8.1's timezone-preserving `TimeWithZone#to_time` (`2026-11-01T08:00:00-05:00`) and update the test and documentation accordingly.