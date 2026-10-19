### Executive Summary

Upgrading Margin Notes from `rails` **7.0.8.7** to **8.1.0** on Ruby `3.3.6` is feasible without upgrading locked application gems (`pg 1.6.0`, `puma 5.6.9`, `sidekiq 6.5.12`, `redis 4.8.1`, `pagy 8.6.3`, `faraday 1.10.4`), **provided `json` is constrained to `< 3.0`** in [Gemfile](file:///home/user/workspace/repo/Gemfile#L7-L8) and **15 required code/configuration changes** (spanning Rails 7.1, 7.2, 8.0, and 8.1 breaking changes) are applied.

- **12 of the 15 required changes** (plus 2 framework-default compatibility changes) are **backward-compatible with Rails 7.0.8.7** and were verified to pass on `7.0.8.7` as a preparatory commit (`variant-0-prep-on-7.0`).
- **3 required changes** (`serialize ..., coder:`, `retry_on ..., wait: :polynomially_longer`, and `config.action_dispatch.show_exceptions = :none`) use APIs introduced in Rails 7.1 whose 7.0 counterparts were removed in 7.2; they **do not work unguarded on Rails 7.0.8.7** and must be applied in lockstep with the `rails` gem bump (`variant-2-probe`).
- **Framework defaults (`config.load_defaults 8.1`)** should be adopted in a **separate post-upgrade phase** (`variant-3-defaults-8.1`), both because 4 defaults (`default_column_serializer = nil`, `raise_on_assign_to_attr_readonly = true`, `raise_on_invalid_cache_expiration_time = true`, `postgresql_adapter_decode_dates = true`) alter runtime behavior in this codebase and because 7.1+ messageverifier/cache/marshalling format defaults (`message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true`, `cache_format_version = 7.1`, `marshalling_format_version = 7.1`) produce tokens and persisted `<action-text-attachment sgid="...">` payloads that Rails 7.0.8.7 cannot read on rollback.

---

### Part 1: Required Changes for Rails 8.1.0 (Even with `config.load_defaults 7.0`)

#### 1. Unbounded `activesupport` dependency on `json` resolves `json 3.1.0`, breaking `ActiveSupport::JSON.decode`
- **Affected code**: [Gemfile](file:///home/user/workspace/repo/Gemfile#L7-L8), [Gemfile.lock](file:///home/user/workspace/repo/Gemfile.lock#L64-L68), and all callers of `ActiveSupport::JSON.decode` ([Note#tags](file:///home/user/workspace/repo/app/models/note.rb#L12), `ActiveStorage::Blob#metadata`, and `:json` session cookies in [ApplicationController](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18)).
- **Applicability & upstream cause**: `activesupport 7.0.8.7` did not declare `json` in its gemspec, so `Gemfile.lock` omitted `json` and Ruby 3.3.6 used its default `json 2.7.2`. `activesupport 8.1.0` adds an unbounded runtime dependency on `json`. Even `bundle update --conservative rails` resolves this newly added dependency to `json 3.1.0`. In `json >= 3.0.0`, `JSON.parse(source, **options)` accepts only keyword options, whereas `ActiveSupport::JSON.decode(json, options = {})` in `activesupport 8.1.0` calls `::JSON.parse(json, options)` with a positional Hash, raising `ArgumentError: wrong number of arguments (given 2, expected 1)` on every JSON column read, blob upload, and session cookie decode (silently dropping sessions in `ActionDispatch::Cookies`).
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: Pin `gem "json", "~> 2.7"` in [Gemfile](file:///home/user/workspace/repo/Gemfile#L8).
- **Discriminating validation**:
  - *Executed*: Without pinning `json`, `bin/rails test test/models/note_test.rb` in `variant-2-probe` failed with `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291:in 'parse'` (`log/note_test_backtrace.log`), and controller tests failed authentication with 302 redirects to `/session/new` (`log/step4_test_defaults_7_0.log`). Pinning `gem "json", "~> 2.7"` resolved `json 2.21.2` and eliminated all JSON decoding errors (`log/step5_test_defaults_7_0.log`).

#### 2. `ActionText::ContentHelper.allowed_tags` defaults to `nil` at boot (Rails 7.1+)
- **Affected code**: [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3).
- **Applicability & upstream cause**: Always executes at boot. In Rails 7.0, `mattr_accessor(:allowed_tags)` had a default block returning `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]`. In Rails 7.1+, `ActionText::ContentHelper.allowed_tags` defaults to `nil` (falling back lazily inside instance method `sanitizer_allowed_tags`), so `ActionText::ContentHelper.allowed_tags += %w[ details summary ]` raises `NoMethodError: undefined method '+' for nil` during initialization.
- **Works on 7.0.8.7?**: **Yes** (with the fallback expression below).
- **Recommendation**: Replace [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) with:
  ```ruby
  ActionText::ContentHelper.allowed_tags = (
    ActionText::ContentHelper.allowed_tags ||
      ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  ) + %w[ details summary ]
  ```
- **Discriminating validation**:
  - *Executed*: Unmodified boot in `variant-1-conservative` failed at `config/initializers/action_text.rb:3` (`log/zeitwerk_check.log`). With the fix above, both `bin/rails zeitwerk:check` and [NotesControllerTest#test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup](file:///home/user/workspace/repo/test/controllers/notes_controller_test.rb#L137-L149) passed on 7.0.8.7 (`variant-0-prep-on-7.0`) and 8.1.0 (`variant-2-probe`, `variant-3-defaults-8.1`).

#### 3. Keyword-argument `enum status: {...}, _prefix: true` removed (Rails 8.0)
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10).
- **Applicability & upstream cause**: Always executes when `Note` is loaded. Keyword-style `enum` definition and underscore-prefixed options (`_prefix`) were deprecated in Rails 7.2 and removed in Rails 8.0 (`ArgumentError: wrong number of arguments (given 0, expected 1..2)`). ([Citation](file:///home/user/workspace/repo/app/models/citation.rb#L7) and [Export](file:///home/user/workspace/repo/app/models/export.rb#L10) already use positional syntax.)
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) to:
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  ```
- **Discriminating validation**:
  - *Executed*: `bin/rails zeitwerk:check` in `variant-2-probe` failed at `app/models/note.rb:10` (`log/step1_zeitwerk.log`) until updated; passed on both 7.0.8.7 and 8.1.0.

#### 4. Positional coder in `serialize :tags, JSON` removed (Rails 7.2)
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) (and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7); see Part 2 #16).
- **Applicability & upstream cause**: Always executes when `Note` is loaded. Rails 7.1 introduced keyword `coder:` and deprecated positional `class_name_or_coder`; Rails 7.2 removed the second positional parameter (`def serialize(attr_name, coder: nil, type: Object, comparable: false, yaml: {}, **options)`), raising `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Works on 7.0.8.7?**: **No** (unless guarded by `Rails.gem_version >= Gem::Version.new("7.1")`). On Rails 7.0.8.7, `serialize` forwards `**options` to `attribute(:tags, **options)`, raising `ArgumentError: Unknown key: :coder`.
- **Stored data impact**: None. Both `serialize :tags, JSON` on 7.0 and `serialize :tags, coder: JSON` on 8.1 use `ActiveRecord::Coders::JSON` and store JSON arrays (e.g. `'["Victorian", "marriage"]'`) in `notes.tags`.
- **Recommendation**: In the Rails 8.1 upgrade commit, change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) to `serialize :tags, coder: JSON` (and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) to `serialize :preferences, coder: YAML`).
- **Discriminating validation**:
  - *Executed*: `bin/rails zeitwerk:check` in `variant-2-probe` failed at `app/models/note.rb:12` (`log/step2_zeitwerk.log`) and passed after switching to `coder: JSON`, with tag round-tripping verified in [NotesControllerTest](file:///home/user/workspace/repo/test/controllers/notes_controller_test.rb#L107-L135).

#### 5. `alias_attribute` on `store_accessor` raises `ArgumentError` (Rails 7.2)
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L13-L14).
- **Applicability & upstream cause**: Executes whenever attribute methods on `Note` are generated. `color` is defined via `store_accessor :settings, :color`, not as a schema column or `ActiveModel::Attributes` attribute. Rails 7.1 deprecated `alias_attribute` targeting non-attributes, and Rails 7.2+ raises `ArgumentError: Note model aliases color, but color is not an attribute. Use alias_method :highlight_color, :color or define the method manually.`
- **Works on 7.0.8.7?**: **Yes.** `store_accessor` eagerly defines `color` and `color=` at class definition time in both 7.0 and 8.1.
- **Recommendation**: In [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L13-L14), replace `alias_attribute :highlight_color, :color` with:
  ```ruby
  store_accessor :settings, :color
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Discriminating validation**:
  - *Executed*: `bin/rails db:prepare` (when `db/seeds.rb` touched `Note`) failed with `ArgumentError: Note model aliases color, but color is not an attribute` (`log/step3_db_prepare.log`). Replacing with `alias_method` passed `db:prepare` and [NotesControllerTest](file:///home/user/workspace/repo/test/controllers/notes_controller_test.rb#L107-L164) on both 7.0.8.7 and 8.1.0.

#### 6. Multiple paths in a single route helper (`get "/notes", "/journal", ...`) removed (Rails 8.1)
- **Affected code**: [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18).
- **Applicability & upstream cause**: Executes when routes are loaded. Passing multiple path arguments to `get`/`match` was deprecated in Rails 8.0 and removed in Rails 8.1 (`actionpack/CHANGELOG.md`: *"Remove deprecated support to a route to multiple paths"*), raising `ArgumentError: Wrong number of arguments (expect 1, got 2)`.
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: Split [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) into two declarations:
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Discriminating validation**:
  - *Executed*: `bin/rails test` failed at `config/routes.rb:18` (`log/step4_test_defaults_7_0.log`); splitting the route restored both `notes_path` and `journal_path` in [NotesControllerTest#test_lists_the_reader's_notes_newest_first_at_both_list_paths](file:///home/user/workspace/repo/test/controllers/notes_controller_test.rb#L6-L15) on 7.0.8.7 and 8.1.0.

#### 7. `config.action_dispatch.show_exceptions = false` in `test.rb` silently behaves as `:all` (`true`) (Rails 7.2+)
- **Affected code**: [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31).
- **Applicability & upstream cause**: Applies in `RAILS_ENV=test`. Rails 7.1 replaced boolean `show_exceptions` (`true`/`false`) with symbols (`:all`, `:rescuable`, `:none`). In Rails 7.2+, `ActionDispatch::ExceptionWrapper#show?` uses `case config when :none then false when :rescuable then rescue_response? else true end`. Because boolean `false` hits the `else` branch, `show_exceptions = false` silently enables exception rendering (`:all`), turning unhandled exceptions and `ActiveRecord::RecordNotFound` into rendered 404/500 responses instead of raising in tests.
- **Works on 7.0.8.7?**: **No.** In Rails 7.0.8.7, `:none` is truthy (`!= false`).
- **Recommendation**: In the Rails 8.1 upgrade commit, change [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31) to:
  ```ruby
  config.action_dispatch.show_exceptions = :none
  ```
  *(Note: `:none`, not `:rescuable`, is required because the test suite and [TESTING.md](file:///home/user/workspace/repo/TESTING.md#L60-L63) contractually assert `assert_raises(ActiveRecord::RecordNotFound)` across controller tests.)*
- **Discriminating validation**:
  - *Executed*: With `show_exceptions = false`, all `assert_raises(ActiveRecord::RecordNotFound)` assertions failed with `ActiveRecord::RecordNotFound expected but nothing was raised` (`log/step5_test_defaults_7_0.log`). Setting `:none` restored exception raising across all 46 tests (`log/step6_test_show_exceptions_none.log`).

#### 8. `Array#sum` without an initial value (`fragments.sum`) on `String` elements raises `TypeError` (Rails 8.0+)
- **Affected code**: [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L36-L42).
- **Applicability & upstream cause**: Executes whenever `Export#generate` completes a notebook export. Rails 7.0's `ActiveSupport` monkey-patched `Enumerable#sum` to use the first element as the default accumulator when summing non-numeric elements; Rails 8.0 removed that override for `Array#sum`, deferring to Ruby's native `Array#sum(init = 0)`, which attempts `0 + "# ..."` and raises `TypeError: String can't be coerced into Integer`.
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: In [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42), change `finish(fragments.sum)` to `finish(fragments.join)` (or `fragments.sum("")`).
- **Discriminating validation**:
  - *Executed*: [ExportsControllerTest](file:///home/user/workspace/repo/test/controllers/exports_controller_test.rb#L9-L57) failed with `TypeError: String can't be coerced into Integer` at `app/models/export.rb:42` (`log/step4_test_defaults_7_0.log`) and passed with `fragments.join` on both 7.0.8.7 and 8.1.0.

#### 9. `NoteReminderJob.set(wait_until: reminder_epoch)` with an `Integer` epoch raises `NoMethodError` (Rails 7.1+)
- **Affected code**: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61).
- **Applicability & upstream cause**: Executes when scheduling or postponing a reminder (`Note#schedule_reminder`). In Rails 7.0, `ActiveJob::Core#set` immediately coerced `options[:wait_until].to_f` and did not include `scheduled_at` in `Job#serialize`. In Rails 7.1+, `set` stores `self.scheduled_at = options[:wait_until]` and `serialize` calls `scheduled_at.utc.iso8601(9)`, raising `NoMethodError: undefined method 'utc' for an instance of Integer`.
- **Works on 7.0.8.7?**: **Yes.** `reminder_at` returns an `ActiveSupport::TimeWithZone` for `reminder_epoch` that responds to `.to_f` on 7.0 and `.utc` + `.to_f` on 7.1–8.1.
- **Queued work impact**: In Rails 8.1, `job.serialize` adds `"scheduled_at" => "YYYY-MM-DDTHH:MM:SS.NNNNNNNNNZ"`. Rails 7.0 workers ignore unknown keys in `job_data`, and Rails 8.1 workers handle `job_data["scheduled_at"] == nil` from 7.0 jobs.
- **Recommendation**: In [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61), change `wait_until: reminder_epoch` to `wait_until: reminder_at`:
  ```ruby
  job = NoteReminderJob.set(wait_until: reminder_at).perform_later(self)
  ```
- **Discriminating validation**:
  - *Executed*: [RemindersControllerTest](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L6-L58) failed with `NoMethodError: undefined method 'utc' for an instance of Integer` (`log/step6_test_show_exceptions_none.log`) and passed on both 7.0.8.7 and 8.1.0 (and through real Redis Sidekiq `JobWrapper` in `log/sidekiq_roundtrip_test.log`) after changing to `wait_until: reminder_at`.

#### 10. `ActiveJob` `TimeWithZoneSerializer` preserves the reader's time zone, shifting `DigestMailer` off the UTC day (Rails 7.1+)
- **Affected code**: [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12), [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L34-L41), [app/jobs/digest_job.rb](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L6-L8).
- **Applicability & upstream cause**: Executes whenever a reader in a non-UTC time zone requests a daily digest at a time whose local date differs from the UTC date. In Rails 7.0, `TimeWithZoneSerializer` serialized only `"value"` (ISO 8601 with offset) and deserialized via `Time.iso8601(hash["value"]).in_time_zone`, which converted `requested_at` to the worker's `Time.zone` (`UTC`). In Rails 7.1+, `TimeWithZoneSerializer` also serializes `"time_zone"` and deserializes `requested_at` in that zone (e.g. `America/New_York`). Consequently, `requested_at.to_date` and `requested_at.all_day` in [DigestMailer#daily_digest](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L8-L9) compute the reader's local day (`October 04, 2026`) instead of the promised UTC day (`October 05, 2026`) used by the Redis reservation key `digest_requests:2026-10-05` in [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L36).
- **Works on 7.0.8.7?**: **Yes.**
- **Queued work impact**: `TimeWithZoneSerializer` in 8.1 adds `"time_zone"` to the serialized hash. A 7.0 worker ignores `"time_zone"` and deserializes in UTC; an 8.1 worker reading a 7.0 payload (`hash["time_zone"] == nil`) falls back to `Time.zone` (`UTC`). Calling `requested_at = requested_at.utc` in `DigestMailer#daily_digest` makes both 7.0 and 8.1 workers behave identically for both 7.0 and 8.1 payloads (while preserving `requested_at` in the reader's zone in the enqueued job arguments as asserted by [DigestsControllerTest](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L29)).
- **Recommendation**: Convert `requested_at` to UTC in [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L9):
  ```ruby
  @reader, requested_at = params.values_at(:reader, :requested_at)
  requested_at = requested_at.utc
  @date = requested_at.to_date
  @notes = @reader.notes.status_ready.where(updated_at: requested_at.all_day).includes(:notebook).order(:updated_at, :id)
  ```
- **Discriminating validation**:
  - *Executed*: [DigestsControllerTest](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L43) failed on 8.1 with `Expected: "Your reading digest for October 05, 2026", Actual: "Your reading digest for October 04, 2026"` (`log/step6_test_show_exceptions_none.log`), and passed on both 7.0.8.7 and 8.1.0 (including 7.0-to-8.1 Sidekiq JSON round-trip in `log/sidekiq_roundtrip_test.log`) with `requested_at = requested_at.utc`.

#### 11. `HashWithIndifferentAccess#stringify_keys` now stringifies `Integer` keys, dropping import preview annotations (Rails 7.1+)
- **Affected code**: [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) and [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L38-L42).
- **Applicability & upstream cause**: Executes when rendering CSV import previews. `Import#annotations` builds an `ActiveSupport::HashWithIndifferentAccess` keyed by integer line numbers (`row.line`, e.g. `2`). In Rails 7.0, `HashWithIndifferentAccess#stringify_keys` was a no-op (`dup`), so integer keys remained `Integer`s (`{2 => "..."}`) and `annotations[row.line]` matched. In Rails 7.1+, those no-op overrides were removed from `HashWithIndifferentAccess`, so `.stringify_keys` calls `transform_keys(&:to_s)`, turning key `2` into `"2"`. Because `HashWithIndifferentAccess#convert_key` only converts `Symbol` to `String` (not `Integer` to `String`), `annotations[row.line]` (`annotations[2]`) returns `nil` and annotations disappear from the preview page.
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: In [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22), remove `.stringify_keys`:
  ```erb
  <% annotations = @import.annotations %>
  ```
- **Discriminating validation**:
  - *Executed*: [ImportsControllerTest](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L22) failed on 8.1 because `<dd>` for the annotation was omitted (`log/step6_test_show_exceptions_none.log`); removing `.stringify_keys` passed on both 7.0.8.7 and 8.1.0.

#### 12. `form_with(model: nil, ...)` raises `ArgumentError` (Rails 8.0+)
- **Affected code**: [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12).
- **Applicability & upstream cause**: Executes whenever `/notes` or `/journal` is rendered. Passing `model: nil` to `form_with` was deprecated in Rails 7.2 and raises `ArgumentError: Passed nil to the :model argument, expect an object or false` in Rails 8.0+.
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: Omit `model: nil` in [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12):
  ```erb
  <%= form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>
  ```
- **Discriminating validation**:
  - *Executed*: Rendering `/notes` raised `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false` (`log/step6_test_show_exceptions_none.log`) and passed on both 7.0.8.7 and 8.1.0 once `model: nil` was removed.

#### 13. `@notes.where(notebooks: @notebook)` plural association key raises `PG::UndefinedColumn` (Rails 8.0+)
- **Affected code**: [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12).
- **Applicability & upstream cause**: Executes when filtering notes by `notebook_id` on `/notes`. `Note` defines `belongs_to :notebook` (singular). In Rails 7.0, `TableMetadata#associated_with?` fell back to `klass._reflect_on_association(table_name.singularize)` when given a non-Hash value. Rails 7.2 deprecated this singularization fallback and Rails 8.0 removed it (`TableMetadata#associated_with` only checks `klass._reflect_on_association(table_name)`), causing `where(notebooks: @notebook)` to generate `WHERE "notes"."notebooks" = $1` and fail with `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`.
- **Works on 7.0.8.7?**: **Yes.**
- **Recommendation**: In [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12), use the singular association name:
  ```ruby
  @notes = @notes.where(notebook: @notebook)
  ```
- **Discriminating validation**:
  - *Executed*: [NotesControllerTest#test_filters_by_notebook,_status,_and_title](file:///home/user/workspace/repo/test/controllers/notes_controller_test.rb#L27-L39) failed with `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist` (`log/step6_test_show_exceptions_none.log`) and passed on both 7.0.8.7 and 8.1.0 with `where(notebook: @notebook)`.

#### 14. Removal of `Rails.application.secrets` (Rails 7.2)
- **Affected code**: [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18), [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15), [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45-L123).
- **Applicability & upstream cause**: Executes whenever `Citation::Provider.new` is called without arguments or when `CitationEnrichmentsControllerTest` configures provider settings. `Rails.application.secrets` was deprecated in Rails 7.1 and removed in Rails 7.2 (`NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`).
- **Works on 7.0.8.7?**: **Yes.** `config_for` and `config.x` exist in Rails 7.0.8.7.
- **Recommendation**: Load `config/secrets.yml` via `config_for(:secrets)[:citation_provider]` into `config.x.citation_provider` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24):
  ```ruby
  config.x.citation_provider = config_for(:secrets)[:citation_provider]
  ```
  and reference `Rails.application.config.x.citation_provider` in [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13) and [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45-L123) (and update the references in [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L79-L80) and [CONTRIBUTING.md](file:///home/user/workspace/repo/CONTRIBUTING.md#L38)).
- **Discriminating validation**:
  - *Executed*: [CitationEnrichmentsControllerTest](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L7-L88) (including the subprocess `bin/rails runner` environment-credential test at line 40) failed with `NoMethodError: undefined method 'secrets'` (`log/step6_test_show_exceptions_none.log`) and passed on both 7.0.8.7 and 8.1.0 with `config.x.citation_provider`.

#### 15. Four deeper behavioral / runtime changes surfaced in domain operations (`Import#apply`, `Import#receipt`, `CitationEnrichmentJob`, `Note#next_day_reminder_at`)
1. **Non-local `return false` inside `Import#apply` `transaction` block now COMMITS partial imports instead of rolling back (Rails 7.2+)**:
   - *Affected code*: [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61).
   - *Cause*: In Rails 7.0, exiting a `transaction` block via `return` rolled back uncommitted writes (`!completed && transaction.written`). Rails 7.1 deprecated this behavior and Rails 7.2+ commits the transaction in `ensure` when exiting via `return`. When row 2 of a CSV fails validation in `Import#apply`, `return false unless row.note.save` commits the `Import` record and row 1's `Note`, `Citation`, and `ActionText::RichText`!
   - *Works on 7.0.8.7?*: **Yes.**
   - *Recommendation*: Raise `ActiveRecord::Rollback` inside `transaction` in [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L61):
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
   - *Validation*: Caught by [ImportsControllerTest#test_invalid_rows_are_shown_with_their_errors,_and_applying_them_saves_nothing](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L65) (`record_counts` changed from `[0, 3, 0, 1]` to `[1, 4, 1, 2]` in `log/step7_test_defaults_7_0.log`); passed on 7.0.8.7 and 8.1.0 after using `raise ActiveRecord::Rollback`.
2. **`citation[:id]` in `Import#receipt` returns `nil` for custom primary key `doi` (Rails 7.2+)**:
   - *Affected code*: [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68).
   - *Cause*: `Citation` has `primary_key: "doi"` and no `id` column. In Rails 7.0, `read_attribute(:id)` (`citation[:id]`) mapped `"id"` to `@primary_key` (`"doi"`). Rails 7.2+ removed `name = @primary_key if name == "id"` from `read_attribute`, so `citation[:id]` returns `nil` and exported receipt CSVs omit all DOIs.
   - *Works on 7.0.8.7?*: **Yes.**
   - *Recommendation*: Change `citation && citation[:id]` to `citation&.doi` in [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L68).
   - *Validation*: Caught by [ImportsControllerTest](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L45) (`On idleness,` with blank DOI in `log/step7_test_defaults_7_0.log`); passed on 7.0.8.7 and 8.1.0 with `citation&.doi`.
3. **`retry_on ..., wait: :exponentially_longer` removed in `CitationEnrichmentJob` (Rails 7.2+)**:
   - *Affected code*: [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7).
   - *Cause*: `:exponentially_longer` was deprecated in Rails 7.1 in favor of `:polynomially_longer` and removed in Rails 7.2, raising `RuntimeError: Couldn't determine a delay based on :exponentially_longer` only when `Citation::Provider::Unavailable` is actually rescued.
   - *Works on 7.0.8.7?*: **No** (`:polynomially_longer` raises `RuntimeError` on 7.0.8.7). Apply in lockstep with the Rails gem bump.
   - *Recommendation*: Change `wait: :exponentially_longer` to `wait: :polynomially_longer` in [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7).
   - *Validation*: Caught by [CitationEnrichmentsControllerTest](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L60-L71) (`log/step7_test_defaults_7_0.log`); passed with `:polynomially_longer`.
4. **`ActiveSupport::TimeWithZone#to_time` preserves timezone object instead of fixed `utc_offset` across DST in `Note#next_day_reminder_at` (Rails 7.2+/8.1)**:
   - *Affected code*: [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L43-L45).
   - *Cause*: In Rails 7.0, `TimeWithZone#to_time` called `getlocal(utc_offset)` (fixed numeric offset `-04:00`), so `reminder_at.to_time + 86_400` across the Nov 1, 2026 DST boundary returned `2026-11-01T09:00:00-04:00`. In Rails 7.2+/8.1, `TimeWithZone#to_time` calls `getlocal(time_zone)` (preserving the `ActiveSupport::TimeZone`), so `+ 86_400` shifts the offset to EST (`2026-11-01T08:00:00-05:00`, the same instant `1793538000`).
   - *Works on 7.0.8.7?*: **Yes.**
   - *Recommendation*: To preserve the documented fixed-offset contract ([ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156) and [RemindersControllerTest](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L20-L21)), change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44) to `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` (or, if adopting timezone-aware `to_time`, update the test assertion and architecture note to `2026-11-01T08:00:00-05:00`).

---

### Part 2: Optional Framework Defaults Adoption (`config.load_defaults 8.1`)

Keep `config.load_defaults 7.0` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12) during the initial Rails 8.1.0 rollout, then address these 4 application-impacting defaults when switching to `config.load_defaults 8.1`:

1. **`config.active_record.default_column_serializer = nil` (7.1 default)**:
   - *Affected code*: [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) (`serialize :preferences`).
   - *Impact*: Raises `ArgumentError: missing keyword: :coder` at boot when `default_column_serializer` is `nil`.
   - *Recommendation*: Change to `serialize :preferences, coder: YAML` in the 8.1 upgrade commit (uses the identical `Coders::YAMLColumn` format).
2. **`config.active_record.raise_on_assign_to_attr_readonly = true` (7.1 default)**:
   - *Affected code*: [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L8) (`attr_readonly :slug`), [app/controllers/notebooks_controller.rb](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L39-L41), [app/views/notebooks/_form.html.erb](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L13).
   - *Impact*: The notebook settings form submits `notebook[slug]` in a hidden field and `NotebooksController#notebook_params` permits `:slug`. With `raise_on_assign_to_attr_readonly = true`, `@notebook.update(notebook_params)` raises `ActiveRecord::ReadonlyAttributeError: slug` even when `slug` is unchanged (`log/step1_test_defaults_8_1.log`).
   - *Recommendation*: Either explicitly set `config.active_record.raise_on_assign_to_attr_readonly = false` in `config/application.rb` to preserve the documented contract ([ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L40-L42) & [NotebooksControllerTest](file:///home/user/workspace/repo/test/controllers/notebooks_controller_test.rb#L22-L39)), or stop permitting `:slug` on `update` if changing that contract.
3. **`config.active_support.raise_on_invalid_cache_expiration_time = true` (7.1 default)**:
   - *Affected code*: [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26) (`<% cache [export, "availability"], expires_in: export.expires_at - Time.current do %>`).
   - *Impact*: Whenever a completed export is expired (`export.expires_at < Time.current`), `export.expires_at - Time.current` is negative. With `load_defaults 7.0`, Rails 8.1 logs `ArgumentError: Cache expiration time is invalid, cannot be negative`; with `load_defaults 7.1+`, it raises `ActionView::Template::Error` on `/notebooks/:id/exports` whenever caching is enabled (`log/step1_test_defaults_8_1.log`).
   - *Works on 7.0.8.7?*: **Yes.**
   - *Recommendation*: Change [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26) to:
     ```erb
     <% cache [export, "availability"], expires_in: (export.expires_at - Time.current if export.downloadable?) do %>
     ```
4. **`config.active_record.postgresql_adapter_decode_dates = true` (7.2 default)**:
   - *Affected code*: [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L41) (`Notebook#daily_note_counts`).
   - *Impact*: `Note.connection.select_rows(days)` returns `day` as a `Date` object instead of an ISO 8601 `String`, causing `Date.iso8601(day)` to raise `TypeError: no implicit conversion of Date into String` (`log/step1_test_defaults_8_1.log`).
   - *Works on 7.0.8.7?*: **Yes.**
   - *Recommendation*: In [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40), use `day.is_a?(Date) ? day : Date.iso8601(day)` (compatible with both settings and with 7.0.8.7).
5. **Other 7.1–8.1 defaults with benign or observable behavior changes not covered by existing tests**:
   - `config.action_dispatch.strict_freshness = true` (8.0): In [ExportDownloadsController#show](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11), `stale?(etag: blob.checksum, last_modified: blob.created_at)` now prioritizes `If-None-Match` over `If-Modified-Since` per RFC 7232 when both headers are sent.
   - `config.action_view.remove_hidden_field_autocomplete = true` (8.1): Omits `autocomplete="off"` on hidden inputs (`_method`, `authenticity_token`).
   - `config.action_text.sanitizer_vendor` / `config.action_view.sanitizer_vendor = Rails::HTML5::Sanitizer` (7.1) and `config.dom_testing_default_html_version = :html5` (7.1): Uses Nokogiri's HTML5 parser/sanitizer instead of HTML4.
   - `config.action_controller.action_on_path_relative_redirect = :raise` (8.1): All `redirect_to` calls in Margin Notes use route helpers (`/...`), so none are affected.

---

### Part 3: Stored Data, Queued Work, Mixed-Version Rollout, and Rollback Risks

1. **Queued `DigestJob` `BigDecimal` arguments (8.1 web -> 7.0 Sidekiq worker incompatibility)**:
   - *Finding*: [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L41) passes `reading_completion` (a `BigDecimal`) to `DigestJob.perform_later`. In Rails 7.0.8.7, `BigDecimal` was in `ActiveJob::Arguments::PERMITTED_TYPES` and serialized by Sidekiq as a plain JSON string (e.g. `"0.5"`), and `ActiveJob::Serializers::BigDecimalSerializer` did not exist. In Rails 7.1–8.1, `BigDecimal` is serialized as `{"_aj_serialized" => "ActiveJob::Serializers::BigDecimalSerializer", "value" => "0.5"}`.
   - *Rollout/Rollback risk*: An 8.1 worker can deserialize both 7.0 payloads (plain string `"0.5"`, converted by `BigDecimal(params[:completion])` in [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10)) and 8.1 payloads. However, a **7.0.8.7 Sidekiq worker cannot deserialize a `DigestJob` enqueued by 8.1** (`ActiveJob::DeserializationError` wrapping `NameError: uninitialized constant ActiveJob::Serializers::BigDecimalSerializer`).
   - *Mitigation*: Upgrade Sidekiq workers to 8.1 before web processes during rollout, and either drain the `default` queue before rolling back or pass `reading_completion.to_s` in [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L41) (which works on both 7.0 and 8.1 and makes job payloads identical across versions).
2. **Persisted Action Text `<action-text-attachment sgid="...">` and Active Storage `signed_id`s under `load_defaults 7.1+`**:
   - *Finding*: Executed verification (`log/sgid_signed_id_compat.log`) confirmed that enabling `config.load_defaults 7.1+` (`config.active_support.message_serializer = :json_allow_marshal` and `config.active_support.use_message_serializer_for_metadata = true`) switches `SignedGlobalID.verifier` (`blob.attachable_sgid`, persisted inside `action_text_rich_texts.body` in PostgreSQL) and `ActiveStorage.verifier` (`blob.signed_id`) from Base64-encoded `Marshal` inside `{"_rails":{"message":...}}` to JSON inside `{"_rails":{"data":...}}`.
   - *Rollout/Rollback risk*: Rails 8.1 can verify 7.0 tokens, but **Rails 7.0.8.7 fails with `TypeError: incompatible marshal file format (can't be read)` (`format version 4.8 required; 123.34 given`)** on any `attachable_sgid` or `signed_id` generated with `load_defaults 7.1+`. Any note attachment saved while `load_defaults 7.1+` is active will render as a missing attachment if rolled back to 7.0.8.7.
   - *Mitigation*: Keep `config.load_defaults 7.0` (or keep `config.active_support.message_serializer = :marshal` and `config.active_support.use_message_serializer_for_metadata = false`) until the Rails 8.1.0 deployment is permanent and rollback to 7.0.8.7 is no longer required.
3. **Cache format (`cache_format_version = 7.1`) and Active Record marshalling (`marshalling_format_version = 7.1`)**:
   - Keep both at `7.0` / `6.1` (by keeping `config.load_defaults 7.0`) during mixed-version rollout if a shared cache is used.
4. **Database schema (`db/schema.rb`) and migrations**:
   - No new migrations are required for Rails 8.1.0 (`active_storage_variant_records` and `service_name` on `active_storage_blobs` are already present in [db/schema.rb](file:///home/user/workspace/repo/db/schema.rb#L37-L53), and `checksum` is already nullable).
   - Running `bin/rails db:prepare` / `db:schema:dump` on 8.1 updates `ActiveRecord::Schema[7.0]` to `ActiveRecord::Schema[8.1]`, changes `enable_extension "plpgsql"` to `"pg_catalog.plpgsql"`, and sorts table columns alphabetically. Rails 7.0.8.7 cannot run `db:schema:load` on a `Schema[8.1]` file, though existing databases remain schema-compatible for runtime queries and rollbacks.
5. **Deprecations targeting Rails 8.2 (non-blocking in 8.1.0)**:
   - `ActiveJob::QueueAdapters::SidekiqAdapter` in `activejob 8.1.0` warns that the built-in `sidekiq` adapter will be removed in Rails 8.2 in favor of `sidekiq >= 7.3.3`. Note that if `sidekiq` is later upgraded, [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) and [Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb#L14-L24) rely on synchronous enqueueing inside `with_lock` (`ApplicationJob.enqueue_after_transaction_commit = false`, which is still the default in `activejob 8.1.0`).
   - `config.cache_classes = ...` in `config/environments/*.rb` works in 8.1.0 but can be replaced with `config.enable_reloading = true` (development) / `false` (test, production).
   - [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L1) (`require "csv"`) emits Ruby 3.3.6's bundled-gem warning for Ruby 3.4+; adding `gem "csv"` to `Gemfile` silences it.

---

### Part 4: Executed Experiments and Retained Artifacts

All experiments ran in isolated disposable checkouts under `/tmp/rails-8.1-eval/` (using isolated `GEM_HOME=/tmp/rails-8.1-eval/gem_home`, isolated PostgreSQL databases `margin_notes_exp{0..3}_{dev,test}` which were dropped after use, isolated Redis databases `10`–`13` which were flushed after use, and isolated `BOOTSNAP_CACHE_DIR` and Active Storage paths). Retained logs, `Gemfile`s, and resolved `Gemfile.lock`s are stored in both `/tmp/rails-8.1-eval/` and `/home/user/workspace/repo/.amp/in/artifacts/rails-8.1-upgrade/`:

| Variant | Configuration & Purpose | Executed Commands | Result & Retained Artifacts |
| --- | --- | --- | --- |
| `variant-0-prep-on-7.0` | Rails `7.0.8.7` + 12 backward-compatible preparatory fixes, isolated DB `margin_notes_exp0_test`, Redis `/10` | `bin/rails zeitwerk:check`, `bin/rails db:prepare`, `bin/rails test` | **Passed**: `zeitwerk:check` ("All is good!"), `46 runs, 325 assertions, 0 failures, 0 errors, 0 skips`. Logs & lockfile: `.amp/in/artifacts/rails-8.1-upgrade/variant-0-prep-on-7.0/` |
| `variant-1-conservative` | Unmodified app + `gem "rails", "8.1.0"` via `bundle update --conservative rails`, Redis `/11` | `bundle update --conservative rails`, `bin/rails zeitwerk:check` | Reproduced initial boot failure (`NoMethodError` in `config/initializers/action_text.rb:3`) and `json 3.1.0` resolution. Logs & lockfile: `.amp/in/artifacts/rails-8.1-upgrade/variant-1-conservative/` |
| `variant-2-probe` | Rails `8.1.0` + `gem "json", "~> 2.7"` (`json 2.21.2`) + `config.load_defaults 7.0` + all 15 required fixes, isolated DB `margin_notes_exp2_test`, Redis `/12` | `bin/rails zeitwerk:check`, `bin/rails db:prepare`, `bin/rails test`, Sidekiq JSON round-trip runner | Stepwise failure logs (`step1`–`step7`) + final **Pass**: `46 runs, 340 assertions, 0 failures, 0 errors, 0 skips` (`final_test_defaults_7_0.log`, `sidekiq_roundtrip_test.log`). Artifacts: `.amp/in/artifacts/rails-8.1-upgrade/variant-2-probe/` |
| `variant-3-defaults-8.1` | Rails `8.1.0` + `config.load_defaults 8.1` + framework-default fixes, isolated DB `margin_notes_exp3_test`, Redis `/13` | `bin/rails test`, `RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile`, `MessageVerifier` cross-version runner | Reproduced the 3 `load_defaults 8.1` errors (`step1_test_defaults_8_1.log`), verified 7.0<->8.1 `sgid`/`signed_id` incompatibility (`sgid_signed_id_compat.log`), and passed all tests (`46 runs, 340 assertions, 0 failures, 0 errors`, `final_test_defaults_8_1.log`) and asset precompilation (`assets_precompile.log`). Artifacts: `.amp/in/artifacts/rails-8.1-upgrade/variant-3-defaults-8.1/` |
| `variant-4-non-conservative` | `bundle lock --update rails` comparison | `bundle lock --update rails`, `diff -u` vs conservative lockfile | Confirmed identical dependency resolution to `--conservative`. Artifacts: `.amp/in/artifacts/rails-8.1-upgrade/variant-4-non-conservative/` |

---

### Unverified Claims and Remaining Questions

1. **Browser / System Test Execution (`bin/rails test:system`)**: There are currently no test files under `test/system/`, and [test/application_system_test_case.rb](file:///home/user/workspace/repo/test/application_system_test_case.rb#L3-L5) is configured for non-headless Chrome (`using: :chrome`). While `bin/rails assets:precompile` and importmap resolution were verified by execution, interactive Trix 1.3.5 direct-upload progress events in a live browser against `@rails/actiontext` 8.1.0 (`actiontext.js`) remain a proposed manual/browser check.
2. **Production `SECRET_KEY_BASE` provisioning**: Rails 7.1+ validates `secret_key_base` during production boot (`ArgumentError: Missing 'secret_key_base' for 'production' environment`). Production deployments must ensure `SECRET_KEY_BASE` or `RAILS_MASTER_KEY` is present in the environment (and `SECRET_KEY_BASE_DUMMY=1` during image-build asset precompilation).
3. **Desired contract for `NotebooksController#update` `:slug` and `Note#next_day_reminder_at`**: Confirm whether to keep `config.active_record.raise_on_assign_to_attr_readonly = false` and fixed-offset `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` (preserving current tests and documented behavior) or adopt the Rails 7.1+/8.1 defaults and update those two contracts.