Here is the application-specific evaluation and upgrade plan for upgrading **`rails` from `7.0.8.7` to `8.1.0`** in Margin Notes (Ruby `3.3.6`).

The working checkout, PostgreSQL databases (`margin_notes_development`, `margin_notes_test`), and default Redis database (`0`) were not modified. All experiments were executed in isolated checkouts under `.amp/in/experiments/` using dedicated gem home `.amp/in/gems`, isolated PostgreSQL databases (`margin_notes_exp_*`), isolated Redis DB indexes (`/14` and `/15`), and checkout-local `tmp/` and `storage/` directories.

---

## 1. Recommended Phased Upgrade Sequence

```diagram
┌────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Preparatory Changes on Rails 7.0.8.7 (Deployable Before Upgrade)  │
│ • Fix Note enum/alias_method/wait_until/next_day_reminder_at               │
│ • Fix Export#generate String#sum, Import#apply rollback, Import#receipt    │
│ • Fix NotesController#index where(notebook:), form_with(url:), routes.rb   │
│ • Fix preview.html.erb stringify_keys, _export.html.erb cache expires_in   │
│ • Normalize DigestMailer#daily_digest to UTC; pass completion as String    │
│   or register BigDecimalSerializer shim on 7.0.8.7                         │
│ • Migrate Rails.application.secrets to config_for(:secrets)                │
│ • Update config/initializers/action_text.rb to config.after_initialize     │
│ • Pin gem "json", "~> 2.0" in Gemfile                                      │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Atomic Gem Upgrade to Rails 8.1.0 (Keep config.load_defaults 7.0) │
│ • Bump gem "rails", "8.1.0" (resolves action_text-trix 2.1.19, etc.)       │
│ • Update Note serialize :tags, coder: JSON                                 │
│ • Update CitationEnrichmentJob wait: :polynomially_longer                  │
│ • Update config/environments/test.rb show_exceptions = :none               │
│ • Set config.active_storage.variant_processor = :disabled                  │
│ • Copy tmp/development_secret.txt -> tmp/local_secret.txt in dev checkouts │
│ (Preserves 7.0 wire formats for SGIDs, signed_ids, cookies, and cache)     │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Post-Stabilization Adoption of Rails 7.1–8.1 Framework Defaults   │
│ • Once rollback to 7.0.8.7 is no longer needed:                            │
│ • Add coder: YAML to Notebook serialize :preferences                       │
│ • Handle Notebook slug attr_readonly (stop permitting :slug on update)     │
│ • Handle PostgreSQL decoded Date in Notebook#daily_note_counts             │
│ • Switch config.load_defaults 8.1 & dump ActiveRecord::Schema[8.1]         │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Required Changes for Rails 8.1.0 (Even With `config.load_defaults 7.0`)

These changes are mandatory to boot and run Margin Notes on `rails 8.1.0` even before changing `config.load_defaults 7.0`.

### 2.1 Transitive `json 3.1.0` Incompatibility with `ActiveSupport::JSON.decode` / `ActiveRecord::Coders::JSON`
* **Affected code:** [Gemfile](file:///home/user/workspace/repo/Gemfile#L7-L8), [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) (`serialize :tags`), [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L67) (`ActiveStorage::Blob.create_and_upload!`, which uses `store :metadata, coder: ActiveRecord::Coders::JSON`).
* **Upstream change & condition:** `activesupport 8.1.0` adds an unconstrained dependency `s.add_dependency "json"` in its gemspec. Resolving `rails 8.1.0` today pulls in `json 3.1.0`, which changed `JSON.parse(source, on_load: nil, object_class: nil, array_class: nil, **options)` to accept keyword arguments instead of a positional options `Hash`. `ActiveRecord::Coders::JSON#load` calls `ActiveSupport::JSON.decode(json, @options)` with `@options = { escape: false }`, and `ActiveSupport::JSON.decode` calls `::JSON.parse(json, options)` with a positional `Hash`, raising `ArgumentError: wrong number of arguments (given 2, expected 1)` whenever `ActiveStorage::Blob` metadata or `Note#tags` is deserialized.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Add `gem "json", "~> 2.0"` to [Gemfile](file:///home/user/workspace/repo/Gemfile#L8) before locking `rails 8.1.0`.
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/run_after_serialize.log` (`NoteTest#test_rejects_rich_text_attachments_larger_than_one_megabyte` raised `ArgumentError` in `json-3.1.0/lib/json/common.rb:291:in 'parse'`); passed after pinning `gem "json", "~> 2.0"` (`json 2.19.4`).

### 2.2 Boot Failure in Action Text Sanitizer Initializer (`ActionText::ContentHelper.allowed_tags`)
* **Affected code:** [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) (`ActionText::ContentHelper.allowed_tags += %w[ details summary ]`), rendered via [app/views/notes/show.html.erb](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L31).
* **Upstream change & condition:** In Rails 7.0, `ActionText::ContentHelper.allowed_tags` had a default block computing `sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]`. In Rails 7.1+ (to support `config.action_text.sanitizer_vendor` configured in `after_initialize`), `ActionText::ContentHelper.allowed_tags` defaults to `nil` and falls back dynamically in `ActionText::ContentHelper#sanitizer_allowed_tags`. Calling `+=` on `nil` during initializer load aborts boot with `NoMethodError: undefined method '+' for nil`. Furthermore, setting `allowed_tags = %w[ details summary ]` would replace the entire default allowlist unless the base tags and attachment tags are included.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Replace [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) with:
  ```ruby
  Rails.application.config.after_initialize do
    ActionText::ContentHelper.allowed_tags =
      ActionText::ContentHelper.sanitizer.class.allowed_tags +
      [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  end
  ```
* **Validation:**
  * *Executed:* Verified in `.amp/in/experiments/prep-on-7.0.8.7/prep_test.log` (7.0.8.7) and `.amp/in/experiments/upgrade-8.1.0-load-defaults-8.1/test_81_passing.log` (8.1.0) via `NotesControllerTest#test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` and `bin/rails runner`.

### 2.3 `Note` Legacy `enum` Keyword Syntax Removed
* **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) (`enum status: { draft: 0, ready: 1 }, _prefix: true`). ([Citation](file:///home/user/workspace/repo/app/models/citation.rb#L7) and [Export](file:///home/user/workspace/repo/app/models/export.rb#L10) already use the positional syntax.)
* **Upstream change & condition:** Deprecated in Rails 7.2 and removed in Rails 8.0. `ActiveRecord::Enum#enum` now requires positional `name` (`def enum(name, values = nil, **options)`) and `prefix:` instead of `_prefix:`, raising `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when loading `Note`.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) to:
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/run.log`; passed on both 7.0.8.7 and 8.1.0 after change (`bin/rails zeitwerk:check` and `NotesControllerTest`).

### 2.4 `Note` Positional Coder Argument in `serialize :tags, JSON` Removed
* **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) (`serialize :tags, JSON`).
* **Upstream change & condition:** Passing `class_name_or_coder` as a second positional argument to `serialize` was deprecated in Rails 7.1 and removed in Rails 7.2 (`def serialize(attr_name, coder: nil, type: Object, comparable: false, yaml: {}, **options)`). Loading `Note` raises `ArgumentError: wrong number of arguments (given 2, expected 1)`.
* **Works on 7.0.8.7?** **No.** In Rails 7.0.8.7, `serialize` forwards `**options` to `attribute`, which rejects `:coder` with `ArgumentError: Unknown key: :coder. Valid keys are: :default`. Must be changed atomically with the Rails gem upgrade.
* **Recommendation:** Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) during the Phase 2 gem bump to:
  ```ruby
  serialize :tags, coder: JSON
  ```
  (Stored database format in `notes.tags` remains a JSON array string `["..."]`.)
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/zeitwerk_after_enum.log`; passed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test_all_passing.log` (`NotesControllerTest#test_edits_a_note's_rich_body,_tags,_highlight,_and_status`).

### 2.5 `Note` `alias_attribute :highlight_color, :color` on a `store_accessor` Target
* **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) (`store_accessor :settings, :color` followed by `alias_attribute :highlight_color, :color`).
* **Upstream change & condition:** Deprecated in Rails 7.1 and removed in Rails 7.2. `ActiveRecord::AttributeMethods#alias_attribute_method_definition` checks `has_attribute?(old_name)` when generating attribute methods and raises `ArgumentError: Note model aliases color, but color is not an attribute. Use alias_method :highlight_color, :color or define the method manually.` because `color` is a `store_accessor` on the `settings` `jsonb` column rather than a schema column.
* **Works on 7.0.8.7?** **Yes.** `store_accessor :settings, :color` defines `color` and `color=` immediately on `_stored_attributes_module` when line 13 executes, and validation on `:color` ([app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L17)) and form access via `:highlight_color` ([app/views/notes/_form.html.erb](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L31-L39)) only use the reader and writer.
* **Recommendation:** Replace `alias_attribute :highlight_color, :color` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L14) with:
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/run_after_serialize.log`; passed on both 7.0.8.7 and 8.1.0 (`NotesControllerTest#test_edits_a_note's_rich_body,_tags,_highlight,_and_status` and `test_a_blank_title_re-renders_the_form_with_the_submitted_values`).

### 2.6 Multi-Path `get "/notes", "/journal"` Route Definition Removed
* **Affected code:** [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) (`get "/notes", "/journal", to: "notes#index"`).
* **Upstream change & condition:** Passing multiple paths to `match`/`get`/`post`/`patch`/`put`/`delete` was deprecated in Rails 8.0 and removed in Rails 8.1 (`actionpack-8.1.0/lib/action_dispatch/routing/mapper.rb:1854`), raising `ArgumentError: Wrong number of arguments (expect 1, got 2)`.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Split [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) into two route declarations:
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/run_after_serialize.log`; verified both `notes_path` and `journal_path` on 7.0.8.7 and 8.1.0 via `NotesControllerTest#test_lists_the_reader's_notes_newest_first_at_both_list_paths`.

### 2.7 `Rails.application.secrets` Removed
* **Affected code:** [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18), [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13), [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45) and [lines 117–121](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L121).
* **Upstream change & condition:** `Rails.application.secrets` was deprecated in Rails 7.1 and removed in Rails 7.2, raising `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application:...>`.
* **Works on 7.0.8.7?** **Yes.** `Rails.application.config_for` uses the same `ActiveSupport::ConfigurationFile.parse` + `deep_symbolize_keys` + `ActiveSupport::OrderedOptions` pipeline in both 7.0.8.7 and 8.1.0, preserving the `.to_json` YAML-escaping in `config/secrets.yml` and allowing `CitationEnrichmentsControllerTest#with_provider` to temporarily reassign the configuration in memory.
* **Recommendation:**
  1. In [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), add `config.citation_provider = config_for(:secrets).citation_provider` (or move the mapping to `config/citation_provider.yml` and call `config_for(:citation_provider)`).
  2. In [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13), change the default argument to `def initialize(settings = Rails.configuration.citation_provider.to_h)`.
  3. In [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45) and [lines 117–121](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L121), replace `Rails.application.secrets.citation_provider` with `Rails.configuration.citation_provider`.
* **Validation:**
  * *Executed:* Verified on both 7.0.8.7 and 8.1.0 via `CitationEnrichmentsControllerTest` (including the subprocess `Open3.capture3` test for `"00123"` and `"sample: value # keep"`).

### 2.8 `config.action_dispatch.show_exceptions = false` No Longer Raises in `test` Environment
* **Affected code:** [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31) (`config.action_dispatch.show_exceptions = false`), affecting `assert_raises(ActiveRecord::RecordNotFound)` across 7 controller test files ([notebooks](file:///home/user/workspace/repo/test/controllers/notebooks_controller_test.rb#L44), [notes](file:///home/user/workspace/repo/test/controllers/notes_controller_test.rb#L177), [imports](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L98), [exports](file:///home/user/workspace/repo/test/controllers/exports_controller_test.rb#L123), [activity_reports](file:///home/user/workspace/repo/test/controllers/activity_reports_controller_test.rb#L35), [citation_enrichments](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L94), [reminders](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L69)).
* **Upstream change & condition:** Boolean values (`true`/`false`) for `config.action_dispatch.show_exceptions` were deprecated in Rails 7.1 in favor of `:all`, `:rescuable`, `:none`, and removed in Rails 7.2. In `ActionDispatch::ExceptionWrapper#show?` on Rails 8.1.0 (`case config when :none then false when :rescuable then rescue_response? else true end`), `false` falls into the `else` branch and evaluates to `true` (`:all`), swallowing all exceptions into 404/500 responses instead of raising them.
* **Works on 7.0.8.7?** **No.** In Rails 7.0.8.7, `:none` is truthy (`!= false`), which causes 7.0.8.7 to render exception templates instead of raising. Must be changed atomically with the Rails gem bump.
* **Recommendation:** Change [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31) during the Phase 2 gem bump to:
  ```ruby
  config.action_dispatch.show_exceptions = :none
  ```
  *(Note: If the team later wishes to adopt `:rescuable`, the 7 controller tests using `assert_raises(ActiveRecord::RecordNotFound)` and [TESTING.md](file:///home/user/workspace/repo/TESTING.md#L60-L61) must be updated to `assert_response :not_found`.)*
* **Validation:**
  * *Executed:* Verified by comparing `.amp/in/experiments/upgrade-8.1.0-step1/test_after_routes_alias_json.log` (`show_exceptions = false`) with `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log` (`show_exceptions = :none`).

### 2.9 `form_with(model: nil, ...)` Raises `ArgumentError`
* **Affected code:** [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12) (`<%= form_with(model: nil, url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>`).
* **Upstream change & condition:** In Rails 8.1 (`actionview-8.1.0/lib/action_view/helpers/form_helper.rb:756`), passing `model: nil` explicitly raises `ArgumentError: Passed nil to the :model argument, expect an object or false` to catch unintentionally nil model variables.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Omit `model: nil` (or pass `model: false`) in [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12):
  ```erb
  <%= form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log`; passed on both 7.0.8.7 and 8.1.0 via `NotesControllerTest#test_renders_an_unbound_search_form`.

### 2.10 `NotesController#index` Plural Table Name in `where(notebooks: @notebook)` Raises `PG::UndefinedColumn`
* **Affected code:** [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) (`@notes = @notes.where(notebooks: @notebook)`).
* **Upstream change & condition:** `Note` has `belongs_to :notebook` (singular), not `notebooks`. In Rails 7.1+, passing an Active Record instance under the plural table key `where(notebooks: @notebook)` instead of the association name `where(notebook: @notebook)` (or a nested hash `where(notebooks: { id: @notebook.id })`) treats `notebooks` as a column on `notes`, raising `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Change [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) to:
  ```ruby
  @notes = @notes.where(notebook: @notebook)
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log`; passed on both 7.0.8.7 and 8.1.0 via `NotesControllerTest#test_filters_by_notebook,_status,_and_title` and `test_pages_through_filtered_notes_newest_first,_keeping_the_filters_and_page_size`.

### 2.11 `Export#generate` Calling `Array#sum` Without Initial Value on Strings Raises `TypeError`
* **Affected code:** [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42) (`finish(fragments.sum)`).
* **Upstream change & condition:** Rails 7.0 deprecated Active Support's `Array#sum` fallback for non-numeric elements (`0 + String` rescuing `TypeError`). Rails 7.1 removed the patch so Ruby's native `Array#sum(init = 0)` runs directly, raising `TypeError: String can't be coerced into Integer`.
* **Works on 7.0.8.7?** **Yes** (and removes the 3 deprecation warnings emitted during baseline 7.0.8.7 test runs).
* **Recommendation:** Change [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42) to `finish(fragments.join)` (or `finish(fragments.sum(""))`).
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log`; passed with zero deprecation warnings on both 7.0.8.7 and 8.1.0 via `ExportsControllerTest`.

### 2.12 `ActiveSupport::HashWithIndifferentAccess#stringify_keys` Converts Integer Keys to Strings in Import Preview
* **Affected code:** [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) (`<% annotations = @import.annotations.stringify_keys %>`) and [lines 41–43](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L41-L43) (`annotations[row.line]`), alongside [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L38-L42).
* **Upstream change & condition:** `Import#annotations` builds an `ActiveSupport::HashWithIndifferentAccess` keyed by integer line numbers (`row.line`, e.g., `2`, `4`). In Rails 7.0, `HashWithIndifferentAccess#stringify_keys` was overridden as `dup`, leaving integer keys untouched. In Rails 7.1+, that no-op override was removed so `stringify_keys` calls `transform_keys(&:to_s)`, turning keys `2` and `4` into `"2"` and `"4"`. Because `HashWithIndifferentAccess#convert_key` only converts `Symbol` keys to `String` (`Symbol === key ? key.name : key`), looking up `annotations[row.line]` with an `Integer` returns `nil`, silently dropping all annotations from the import preview page.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Remove `.stringify_keys` in [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) (`<% annotations = @import.annotations %>`).
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log`; passed on both 7.0.8.7 and 8.1.0 via `ImportsControllerTest`.

### 2.13 `Import#apply` Non-Local `return false` Inside `transaction` Commits Instead of Rolling Back
* **Affected code:** [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61):
  ```ruby
  transaction do
    save!
    rows.each do |row|
      return false unless row.note.save
    end
  end
  ```
* **Upstream change & condition:** In Rails 7.0, exiting a `transaction` block via `return` rolled back the transaction. In Rails 7.1+, a non-local `return` (or `break`/`throw`) inside `transaction` **commits** the transaction; rollback only occurs when `ActiveRecord::Rollback` or another exception is raised. Consequently, if row 1 is valid and row 2 is invalid, `return false` commits the `Import` record and row 1's `Note` and `Citation` to PostgreSQL while returning `false`, violating the atomicity contract in [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L48-L49).
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Raise `ActiveRecord::Rollback` inside the `transaction` block in [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61):
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
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test.log` (`ImportsControllerTest#test_invalid_rows_are_shown_with_their_errors,_and_applying_them_saves_nothing`); passed on both 7.0.8.7 and 8.1.0 after change.

### 2.14 `Import#receipt` Reading `citation[:id]` on a Custom Primary Key (`primary_key: "doi"`) Returns `nil`
* **Affected code:** [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68) (`csv << [ note.title, citation && citation[:id] ]`).
* **Upstream change & condition:** `citations` uses `primary_key: "doi", id: :string` ([db/schema.rb](file:///home/user/workspace/repo/db/schema.rb#L55)). In Rails 7.0, `record[:id]` (`read_attribute(:id)`) mapped `:id` to `@primary_key` (`"doi"`). Deprecated in Rails 7.1 and changed in Rails 7.2, `record[:id]` now reads only a literal `"id"` column, returning `nil` on `Citation` and producing blank DOIs in downloaded receipt CSVs.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Change [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68) to `csv << [ note.title, citation&.doi ]` (or `citation&.id` / `note.citation_doi`).
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test.log` (`ImportsControllerTest#test_previews_a_CSV_without_saving,_then_imports_every_row_and_offers_a_receipt`); passed on both 7.0.8.7 and 8.1.0 after change.

### 2.15 `Note#schedule_reminder` Passing Integer Epoch to `NoteReminderJob.set(wait_until:)` Raises `NoMethodError`
* **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61) (`job = NoteReminderJob.set(wait_until: reminder_epoch).perform_later(self)`).
* **Upstream change & condition:** In Rails 7.0, `ActiveJob::Core#set` converted `options[:wait_until]` with `.to_f` and did not include `"scheduled_at"` in `Job#serialize`. In Rails 7.1+, `set(wait_until:)` stores `options[:wait_until]` directly in `scheduled_at` and `Job#serialize` calls `scheduled_at.utc.iso8601(9)`, raising `NoMethodError: undefined method 'utc' for an instance of Integer`.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Pass `reminder_at` (or `Time.at(reminder_epoch)`) in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61):
  ```ruby
  job = NoteReminderJob.set(wait_until: reminder_at).perform_later(self)
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log`; passed on both 7.0.8.7 and 8.1.0 via `RemindersControllerTest`.

### 2.16 `Note#next_day_reminder_at` Timezone-Preserving `ActiveSupport::TimeWithZone#to_time` Across DST
* **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L43-L45) (`reminder_at.to_time + 86_400`), [app/views/notes/_reminder.html.erb](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L19), [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L20-L21).
* **Upstream change & condition:** In Rails 7.0, `TimeWithZone#to_time` called `getlocal(utc_offset)`, returning a `Time` with a fixed numeric UTC offset (`-04:00`), so adding `86_400` seconds across the autumn DST transition kept `-04:00` (`2026-11-01T09:00:00-04:00`). In Rails 8.0/8.1, `TimeWithZone#to_time` calls `getlocal(time_zone)`, attaching the `ActiveSupport::TimeZone` object (`Eastern Time (US & Canada)`), so `+ 86_400` crosses the DST transition and returns `2026-11-01 08:00:00 -05:00` (`2026-11-01T08:00:00-05:00`). Note that `next_day_reminder_at.to_i` is identical (`1793538000`) in both versions, so scheduled epoch persistence is unaffected; only the displayed preview string/offset changes.
* **Works on 7.0.8.7?** **Yes** (if keeping fixed offset via `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`).
* **Recommendation:**
  * To preserve the existing test contract in [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21) and [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156), change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44) to `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`.
  * Alternatively, if adopting Rails 8.1's timezone-aware `to_time` is preferred, keep `reminder_at.to_time + 86_400` (or `reminder_at + 86_400`) and update [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21) to `"2026-11-01T08:00:00-05:00"` and update the comment in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L40-L42) and [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156).
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test.log`; passed on both 7.0.8.7 and 8.1.0 with `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`.

### 2.17 `CitationEnrichmentJob` `wait: :exponentially_longer` Removed
* **Affected code:** [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) (`retry_on Citation::Provider::Unavailable, wait: :exponentially_longer, attempts: 3`).
* **Upstream change & condition:** Deprecated in Rails 7.1 in favor of `:polynomially_longer` and removed in Rails 7.2 (`activejob-8.1.0/lib/active_job/exceptions.rb:175`), raising `RuntimeError: Couldn't determine a delay based on :exponentially_longer` on first retry.
* **Works on 7.0.8.7?** **No.** Rails 7.0.8.7 only accepts `:exponentially_longer` and raises `RuntimeError: Couldn't determine a delay based on :polynomially_longer`. Must be changed atomically with the Rails gem bump (or use a proc `wait: ->(executions) { (executions**4) + 2 }` if a single expression is desired before upgrading).
* **Recommendation:** Change `wait: :exponentially_longer` to `wait: :polynomially_longer` in [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) during the Phase 2 gem bump.
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test.log`; passed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test_all_passing.log` (`CitationEnrichmentsControllerTest#test_a_provider_that_stays_unavailable_or_refuses_the_request_leaves_a_visible_failure`).

### 2.18 `DigestMailer#daily_digest` Deserialized `ActiveSupport::TimeWithZone` Preserves Reader Time Zone Instead of UTC
* **Affected code:** [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L35-L41), [app/jobs/digest_job.rb](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L6-L8), [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12).
* **Upstream change & condition:** In Rails 7.0, `ActiveJob::Serializers::TimeWithZoneSerializer` serialized only `"value"` and deserialized with `Time.iso8601(hash["value"]).in_time_zone`, converting `requested_at` to the worker's `Time.zone` (`UTC`). In Rails 7.1+, `TimeWithZoneSerializer` also serializes `"time_zone" => time_with_zone.time_zone.tzinfo.name` and deserializes back into the original time zone. When a reader in `Eastern Time (US & Canada)` requests a digest at `2026-10-05 03:30 UTC` (`2026-10-04 23:30 EDT`), `User#request_digest` reserves `digest_requests:2026-10-05` (`requested_at.utc.to_date`), but in Rails 8.1 `DigestMailer#daily_digest` receives `requested_at` in `EDT`, so `requested_at.to_date` is `2026-10-04` and `requested_at.all_day` queries the EDT day instead of the UTC day!
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Explicitly convert `requested_at` to UTC in [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L9) (and update comments in `DigestJob`/`DigestMailer`/`ARCHITECTURE.md`):
  ```ruby
  @reader, requested_at = params.values_at(:reader, :requested_at)
  utc_requested_at = requested_at.utc
  @date = utc_requested_at.to_date
  @notes = @reader.notes.status_ready.where(updated_at: utc_requested_at.all_day).includes(:notebook).order(:updated_at, :id)
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-step1/test_with_show_exceptions_none.log` (`Expected: "Your reading digest for October 05, 2026", Actual: "Your reading digest for October 04, 2026"`); passed on both 7.0.8.7 and 8.1.0 after change via `DigestsControllerTest`.

---

## 3. Framework Defaults (`config.load_defaults 7.1` → `8.1`) & Optional Configuration

Adopting `config.load_defaults 8.1` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12) activates defaults from 7.1, 7.2, 8.0, and 8.1. Four defaults directly break application code unless addressed first:

### 3.1 `config.active_record.default_column_serializer = nil` (7.1 Default)
* **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) (`serialize :preferences`).
* **Condition & behavior:** Under `load_defaults 7.0`, `default_column_serializer` is `ActiveRecord::Coders::YAMLColumn`. Under `load_defaults 7.1`+, `default_column_serializer` is `nil`, so `serialize :preferences` without `coder:` raises `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to serialize.` on model load.
* **Works on 7.0.8.7?** **No** (`coder:` keyword is rejected on 7.0.8.7). Works on 8.1.0 under both `load_defaults 7.0` and `load_defaults 8.1`.
* **Recommendation:** Change [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) to `serialize :preferences, coder: YAML` when upgrading to 8.1.0. This preserves the existing YAML format stored in `notebooks.preferences`.
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-8.1/run_81_defaults.log`; passed in `test_81_passing.log`.

### 3.2 `config.active_record.raise_on_assign_to_attr_readonly = true` (7.1 Default)
* **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L8) (`attr_readonly :slug`), [app/views/notebooks/_form.html.erb](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L13) (`<%= form.hidden_field :slug %>`), [app/controllers/notebooks_controller.rb](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L40) (`params.require(:notebook).permit(:name, :slug, :export_heading)`), [test/controllers/notebooks_controller_test.rb](file:///home/user/workspace/repo/test/controllers/notebooks_controller_test.rb#L29-L38).
* **Condition & behavior:** Under `load_defaults 7.1`+, `HasReadonlyAttributes#_write_attribute` raises `ActiveRecord::ReadonlyAttributeError: slug` whenever `:slug` is assigned on a persisted `Notebook`—**even when the submitted value is unchanged** (`slug: "novels"`). Because the notebook settings form includes `<%= form.hidden_field :slug %>` and `NotebooksController#notebook_params` permits `:slug`, every `PATCH /notebooks/:id` request raises `ActiveRecord::ReadonlyAttributeError`.
* **Works on 7.0.8.7?** **Yes** (removing `:slug` from `notebook_params` works on 7.0.8.7 because `Notebook` always derives `slug` on create via `before_validation :assign_slug, on: :create`).
* **Recommendation:** Either:
  1. Remove `:slug` from `NotebooksController#notebook_params` (`params.require(:notebook).permit(:name, :export_heading)`) in [app/controllers/notebooks_controller.rb](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L40) (and update the comment/docs), OR
  2. Explicitly set `config.active_record.raise_on_assign_to_attr_readonly = false` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb) to retain silent ignoring of `attr_readonly` assignments.
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-8.1/run_after_notebook_serialize.log`; passed in `test_81_passing.log` and on 7.0.8.7 in `prep_test.log`.

### 3.3 `config.active_support.raise_on_invalid_cache_expiration_time = true` (7.1 Default)
* **Affected code:** [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26) (`<% cache [export, "availability"], expires_in: export.expires_at - Time.current do %>`).
* **Condition & behavior:** When a completed export is older than 24 hours (`export.expires_at < Time.current`) and fragment caching is enabled (`production`, or `development` with `tmp/caching-dev.txt`, or `ExportsControllerTest`), `export.expires_at - Time.current` is negative. Under `load_defaults 7.1`+, `ActiveSupport::Cache::Store` raises `ArgumentError: Cache expiration time is invalid, cannot be negative`, crashing `GET /notebooks/:notebook_id/exports` whenever a notebook has any expired export.
* **Works on 7.0.8.7?** **Yes.**
* **Recommendation:** Only pass `expires_in:` while `export.expires_at` is in the future in [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26):
  ```erb
  <% cache [export, "availability"], expires_in: (export.expires_at - Time.current if export.expires_at.future?) do %>
  ```
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-8.1/run_after_notebook_serialize.log` (`ExportsControllerTest#test_the_cached_availability_indicator_does_not_authorize_a_download`); passed in `test_81_passing.log` and on 7.0.8.7 in `prep_test.log`.

### 3.4 `config.active_record.postgresql_adapter_decode_dates = true` (7.2 Default)
* **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L39-L40) (`Note.connection.select_rows(days).map { |day, count| [Date.iso8601(day), count] }`).
* **Condition & behavior:** Under `load_defaults 7.2`+, the PostgreSQL adapter registers a native decoder for PostgreSQL `date` columns, so `select_rows` returns `DATE(notes.created_at)` as a `Date` instance instead of an ISO 8601 `String`. Calling `Date.iso8601(day)` with a `Date` raises `TypeError: no implicit conversion of Date into String` on `GET /notebooks/:notebook_id/activity_report`.
* **Works on 7.0.8.7?** **Yes** (using `day.is_a?(Date) ? day : Date.iso8601(day)`).
* **Recommendation:** Update [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40) to:
  ```ruby
  Note.connection.select_rows(days).map { |day, count| [day.is_a?(Date) ? day : Date.iso8601(day), count] }
  ```
  (Once `postgresql_adapter_decode_dates = true` is permanently adopted, this can be simplified to `Note.connection.select_rows(days)` and [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L128-L130) updated accordingly.)
* **Validation:**
  * *Executed:* Failed in `.amp/in/experiments/upgrade-8.1.0-load-defaults-8.1/run_after_notebook_serialize.log` (`ActivityReportsControllerTest`); passed in `test_81_passing.log` and on 7.0.8.7 in `prep_test.log`.

### 3.5 Other Behavioral Changes Under `load_defaults 7.1`–`8.1` and Optional Cleanups
* **`config.action_dispatch.strict_freshness = true` (8.0 default):** Affects [app/controllers/export_downloads_controller.rb](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11) (`stale?(etag: blob.checksum, last_modified: blob.created_at)`). Under RFC 7232 strict freshness, when a client sends both `If-None-Match` and `If-Modified-Since`, `If-None-Match` takes precedence and `If-Modified-Since` is ignored. Because `export.downloadable?` is checked before `stale?`, expiry enforcement is unaffected.
* **`config.active_record.belongs_to_required_validates_foreign_key = false` (7.1 default):** Required `belongs_to` associations (`Note#notebook`, `Notebook#user`, `Import#notebook`, `Export#notebook`) only validate presence of the association object, not whether a raw `notebook_id = <nonexistent>` points to an existing row (deferring that check to the database foreign key constraint if a raw ID were ever assigned directly). `NotesController` assigns `@note.notebook = owned_notebook` (an object or `nil`), so controller validation behavior (`"Notebook must exist"`) is unchanged.
* **`config.action_view.remove_hidden_field_autocomplete = true` (8.1 default):** Removes `autocomplete="off"` from hidden inputs generated by `form_with` and `button_to`.
* **`config.active_storage.variant_processor = :disabled` (Rails 7.1+ setting):** Because `image_processing` is not installed ([Gemfile](file:///home/user/workspace/repo/Gemfile#L57), [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L28)), Rails 8.1 logs `Generating image variants require the image_processing gem. Please add 'gem "image_processing", "~> 1.2"' to your Gemfile or set 'config.active_storage.variant_processor = :disabled'` when booting. Setting `config.active_storage.variant_processor = :disabled` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb) silences this warning (must be applied in Phase 2, as `:disabled` is not supported in 7.0.8.7).
* **Trix `2.1.19` (`action_text-trix` gem) vs Vendored `trix-1.3.5.js`:** `actiontext 8.1.0` depends on `action_text-trix (~> 2.1.15)` (resolved to `2.1.19`). Because [app/assets/stylesheets/actiontext.css](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L6) has `*= require trix`, upgrading to Rails 8.1.0 serves Trix `2.1.19` CSS while [app/views/layouts/application.html.erb](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L13) still loads `vendor/javascript/trix-1.3.5.js`. Since Trix `2.1.19` fixes the Trix `1.3.4` bug that motivated vendoring `1.3.5`, you can optionally replace `trix-1.3.5.js` with the gem-bundled `trix.js` and update [config/importmap.rb](file:///home/user/workspace/repo/config/importmap.rb#L8) to `pin "@rails/actiontext", to: "actiontext.esm.js"` (requires browser verification).
* **Environment config modernization (`config.enable_reloading`):** `config.cache_classes = false` ([config/environments/development.rb](file:///home/user/workspace/repo/config/environments/development.rb#L9)) and `config.cache_classes = true` ([test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L12), [production.rb](file:///home/user/workspace/repo/config/environments/production.rb#L7)) still work in Rails 8.1.0 as aliases for `config.enable_reloading = true` / `false`, and can be updated in Phase 2/3.

---

## 4. Mixed-Version Rollout, Rollback, Stored Data & Queued Work Risks

Existing tests run in a single version and process and **do not reveal** the following cross-version data and queue incompatibilities:

### 4.1 Persisted Action Text Attachment SGIDs (`action_text_rich_texts.body`) & `ActiveStorage::Blob#signed_id`
* **Mechanism:** When `config.active_support.use_message_serializer_for_metadata = true` (part of `load_defaults 7.1`–`8.1`) is enabled, `ActiveSupport::MessageVerifier` / `SignedGlobalID` serializes the outer metadata envelope using `{"_rails":{"data":...,"pur":"attachable"}}` instead of Rails 7.0's `{"_rails":{"message":"<base64>","exp":null,"pur":"attachable"}}`.
* **Stored-data & rollback impact:** Whenever a user creates or edits a `Note` with an attachment ([app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L8)), Action Text writes `<action-text-attachment sgid="...">` permanently into `action_text_rich_texts.body` in PostgreSQL. As verified in `.amp/in/experiments/upgrade-8.1.0-load-defaults-8.1/cross_version_compat.log`:
  * Rails 8.1.0 can verify 7.0.8.7 `attachable_sgid` and `signed_id` tokens.
  * **Rails 7.0.8.7 crashes with `NoMethodError: undefined method 'unpack1' for nil`** whenever it parses an `attachable_sgid` or `signed_id` generated under `use_message_serializer_for_metadata = true`!
  * During a mixed-version rolling deploy or after a rollback to 7.0.8.7, any note attachment saved under 8.1 defaults will cause `500 Internal Server Error` on `NotesController#show`, `NotesController#index` (`to_plain_text`), and `ExportJob` (`Export#generate`) on 7.0.8.7 nodes.
* **Mitigation:** Keep `config.load_defaults 7.0` (or explicitly set `config.active_support.use_message_serializer_for_metadata = false` and `config.active_support.message_serializer = :marshal`) during Phase 2 rollout until rollback to 7.0.8.7 is no longer needed. Under `load_defaults 7.0`, Rails 8.1.0 generates `attachable_sgid` and `signed_id` tokens byte-for-byte compatible with 7.0.8.7.

### 4.2 Encrypted Session Cookies (`_margin_notes_session`)
* **Mechanism:** [app/controllers/application_controller.rb](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L16-L18) stores `session[:user_id]` in the encrypted session cookie.
* **Rollout / rollback impact:** As verified in `cross_version_compat.log`, a session cookie written by Rails 8.1.0 with `use_message_serializer_for_metadata = true` returns `nil` when read by Rails 7.0.8.7, signing out users who hit a 7.0.8.7 web node during a rolling deploy or after a rollback. Keeping `load_defaults 7.0` during Phase 2 preserves bidirectional session cookie compatibility.

### 4.3 Queued `DigestJob` Arguments in Redis (`BigDecimalSerializer` & `TimeWithZoneSerializer`)
* **Mechanism:** [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L41) enqueues `DigestJob.perform_later(self, requested_at, reading_completion)` where `reading_completion` is a `BigDecimal`.
  * In Rails 7.0.8.7, `BigDecimal` was in `ActiveJob::Arguments::PERMITTED_TYPES` and passed raw to Sidekiq, which serialized it to JSON as a plain string `"0.6667"`.
  * In Rails 7.1+ / 8.1.0, `BigDecimal` is serialized via `ActiveJob::Serializers::BigDecimalSerializer` as `{"_aj_serialized" => "ActiveJob::Serializers::BigDecimalSerializer", "value" => "0.6667"}` (even with `config.load_defaults 7.0`!).
* **Rollout / rollback impact:** `ActiveJob::Serializers::BigDecimalSerializer` **does not exist in Rails 7.0.8.7**. As verified in `cross_version_compat.log`, if a Rails 8.1.0 web node enqueues `DigestJob` and a Rails 7.0.8.7 Sidekiq worker pops it (during a rolling deploy or rollback), the 7.0.8.7 worker fails with `ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
* **Mitigation (works on 7.0.8.7):** Either:
  1. Change [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L41) in Phase 1 to pass `reading_completion.to_s` (a plain `String`, which [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) `BigDecimal(params[:completion])` already accepts on both versions, and which also silences Sidekiq's non-native JSON argument warning on 7.0.8.7), OR
  2. Upgrade all Sidekiq workers to 8.1.0 before web nodes during rollout, and drain the `default` queue before any rollback to 7.0.8.7.

### 4.4 Development Local Secret File Renamed (`tmp/development_secret.txt` → `tmp/local_secret.txt`)
* **Mechanism:** In Rails 7.0.8.7 (`railties-7.0.8.7/lib/rails/application.rb:417`), development and test generated their fallback `secret_key_base` in `tmp/development_secret.txt`. In Rails 7.1+ / 8.1.0 (`railties-8.1.0/lib/rails/application/configuration.rb:657`), it was renamed to `tmp/local_secret.txt`.
* **Stored-data impact:** In any existing development environment with attachments in `margin_notes_development`, upgrading to 8.1.0 without copying `tmp/development_secret.txt` to `tmp/local_secret.txt` generates a new `secret_key_base`, invalidating all existing `<action-text-attachment sgid="...">` tags in `action_text_rich_texts.body` (rendering them as broken attachment placeholders) and invalidating existing development sessions.
* **Mitigation:** Copy `cp tmp/development_secret.txt tmp/local_secret.txt` in development checkouts when upgrading.

### 4.5 Built-in `SidekiqAdapter` Deprecation & Transaction Commit Timing (`with_lock`)
* **Mechanism & condition:**
  1. `activejob-8.1.0` deprecates its built-in `ActiveJob::QueueAdapters::SidekiqAdapter`: *"The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later to use the `sidekiq` gem's adapter."* Because [Gemfile](file:///home/user/workspace/repo/Gemfile#L35-L36) pins `sidekiq` `6.5.12` and `redis` `4.8.1`, the built-in adapter continues to work in Rails 8.1.0 (emitting a deprecation warning in `development`), but upgrading to Rails 8.2 will require upgrading `sidekiq` to `>= 7.3.3` (which in turn requires `redis >= 5.0`—where `user.rb`'s `redis.sadd`/`redis.srem` return Integers instead of Booleans and must become `sadd?`/`srem?`—and `rack >= 3.0`).
  2. Both [Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb#L14-L24) and [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) intentionally enqueue Active Jobs **inside `with_lock`** so that a Redis enqueue failure rolls back the database state (`enrichment_status: :pending` / `reminder_job_id`). In Rails 8.1.0, `ApplicationJob.enqueue_after_transaction_commit` defaults to `false` for `:sidekiq` and `:test`, preserving this synchronous-enqueue-inside-transaction behavior. Do **not** set `self.enqueue_after_transaction_commit = true` on `ApplicationJob` unless `Citation#request_enrichment` and `Note#schedule_reminder` are redesigned.

### 4.6 Cache Store Format (`cache_format_version`), Active Record Marshalling (`marshalling_format_version`), and `db/schema.rb`
* **`cache_format_version = 7.1` & `marshalling_format_version = 7.1` (in `load_defaults 7.1`+):** Rails 7.0.8.7 cannot read cache entries written in 7.1 format or `Marshal.dump` payloads of Active Record models (`TypeError: instance of User needs to have method 'marshal_load'`). Keep `load_defaults 7.0` until Phase 3.
* **`db/schema.rb` (`ActiveRecord::Schema[8.1]`):** Dumping the schema on Rails 8.1.0 writes `ActiveRecord::Schema[8.1].define`, changes `enable_extension "plpgsql"` to `enable_extension "pg_catalog.plpgsql"`, and sorts table columns alphabetically. Rails 7.0.8.7 raises `ArgumentError: Unknown migration version "8.1"` if `db:schema:load` or `db:prepare` is run against an 8.1 `db/schema.rb`.

---

## 5. Executed Experiments, Evidence Attribution & Unverified Claims

All experiments were run in isolated copies under `/home/user/workspace/repo/.amp/in/experiments/` with `GEM_HOME=/home/user/workspace/repo/.amp/in/gems`, isolated PostgreSQL databases (`margin_notes_exp_70_*`, `margin_notes_exp_81_*`, dropped after verification), and isolated Redis databases (`REDIS_URL=redis://localhost:6379/14` and `/15`, flushed after verification).

| Variant Directory | Configuration & Dependencies | Executed Command(s) | Result & Retained Log / Artifact Path |
| --- | --- | --- | --- |
| `baseline-7.0.8.7` | Unmodified app; `rails 7.0.8.7`, `load_defaults 7.0`, DB `margin_notes_exp_70_*`, Redis `/14` | `bin/rails db:prepare && bin/rails zeitwerk:check && bin/rails test` | 46 runs, 325 assertions, 0 failures, 0 errors; 3 `Enumerable.sum` deprecations (`.amp/in/experiments/baseline-7.0.8.7/baseline_test.log`) |
| `prep-on-7.0.8.7` | `rails 7.0.8.7` + all Phase 1 preparatory code changes applied | `bin/rails zeitwerk:check && bin/rails test` | 46 runs, 325 assertions, 0 failures, 0 errors, **0 Rails deprecations** (`.amp/in/experiments/prep-on-7.0.8.7/prep_test.log`) |
| `upgrade-8.1.0-raw` | Only `gem "rails", "8.1.0"` changed in `Gemfile`; resolved `rails 8.1.0`, `action_text-trix 2.1.19`, `json 3.1.0`, `rack 2.2.24` | `bundle lock --update rails && bundle install && bin/rails zeitwerk:check` | Aborted at boot with `NoMethodError: undefined method '+' for nil` in `config/initializers/action_text.rb:3` (`.amp/in/experiments/upgrade-8.1.0-raw/gemfile_lock.diff`, `zeitwerk_check.log`) |
| `upgrade-8.1.0-step1` | `rails 8.1.0` stepping through boot/model/route/test blockers (`action_text.rb`, `Note` `enum`, `serialize`, `json ~> 2.0`, `routes.rb`, `alias_method`, `show_exceptions = :none`) | `bin/rails zeitwerk:check && bin/rails test` | Revealed each sequential failure: `Note` `enum` (`run.log`), `Note` `serialize` (`zeitwerk_after_enum.log`), `json 3.1.0` & `routes.rb` & `alias_attribute` & `show_exceptions` (`run_after_serialize.log`, `test_after_routes_alias_json.log`), and controller/model/job/mailer failures (`test_with_show_exceptions_none.log`) |
| `upgrade-8.1.0-load-defaults-7.0` | `rails 8.1.0`, `json 2.19.4`, `config.load_defaults 7.0` + all Phase 1 & Phase 2 required fixes | `bin/rails zeitwerk:check && bin/rails test` | **46 runs, 340 assertions, 0 failures, 0 errors, 0 skips** (`.amp/in/experiments/upgrade-8.1.0-load-defaults-7.0/test_all_passing.log`) |
| `upgrade-8.1.0-load-defaults-8.1` | `rails 8.1.0`, `json 2.19.4`, `config.load_defaults 8.1` + Phase 1, Phase 2, and Phase 3 fixes (`Notebook` `coder: YAML`, `notebook_params` without `:slug`, `expires_in` guard, `daily_note_counts` `Date` handling) | `bin/rails zeitwerk:check`, `bin/rails test`, `bin/rails db:migrate:reset`, `bin/rails db:seed && bin/rails db:rollback STEP=7 && bin/rails db:migrate`, `RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile`, cross-version runner checks | Revealed the 4 `load_defaults 8.1` failures (`run_81_defaults.log`, `run_after_notebook_serialize.log`), then passed **46 runs, 340 assertions, 0 failures, 0 errors** (`test_81_passing.log`), migrations/rollback (`db_migrate_reset.log`, `db_seed_rollback.log`, `schema.diff`), asset precompile (`assets_precompile.log`), and cross-version compatibility checks (`cross_version_compat.log`) |

### Unverified Claims & Remaining Questions
1. **Browser / System Test Verification (`bin/rails test:system` and Trix editor interaction):** No Chrome, Chromium, or Firefox binary is installed in this sandbox (`which google-chrome chromium chromium-browser chromedriver firefox` returned none), and no system tests currently exist under `test/system/`. Browser-level interaction between Action Text `8.1.0` (`@rails/actiontext`), `action_text-trix` `2.1.19` (`trix.css`), and the vendored `vendor/javascript/trix-1.3.5.js` (or switching to `trix.js` `2.1.19` + `actiontext.esm.js`) has not been exercised in a real browser and should be verified manually or via `bin/rails test:system` on a machine with Chrome installed.
2. **Production Deployment Topology:** [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L178-L215) notes that production has no configured mailer delivery method, link host, or multi-node cache store. Confirm whether production deployments run rolling multi-container web/Sidekiq processes against shared Redis/PostgreSQL (where the Phase 1 → Phase 2 → Phase 3 rollout ordering is essential) or single-host downtime deployments.
3. **Desired `Note#next_day_reminder_at` DST Behavior:** Confirm whether the team prefers keeping the fixed-UTC-offset preview (`reminder_at.getlocal(reminder_at.utc_offset) + 86_400`) to match the current test at [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21) or adopting Rails 8.1's timezone-preserving `reminder_at.to_time + 86_400` (`2026-11-01T08:00:00-05:00`) and updating the test expectation and documentation.