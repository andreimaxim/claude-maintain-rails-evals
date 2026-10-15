# Rails 7.0.8.7 to 8.1.0 upgrade plan for the Margin Notes application

I did not modify the application checkout. The working tree is clean and `Gemfile.lock` still pins `rails (7.0.8.7)`. The upgrade does not work as-is: `upgraded` fails at boot. I found 20 items that need changes. Of those, 14 can be fixed on 7.0 before the bump. The other items need the bump itself, or only apply when `load_defaults` moves past 7.0. I tested the repairs in the disposable copy. The fully repaired copy passes all 46 tests (340 assertions, 0 failures) both with the app's current `load_defaults 7.0` and with `load_defaults 8.1`. The 7.0 baseline also passes the pre-bump subset (46 runs, 325 assertions, 0 failures).

Note on `gem-changes`: its Rack 3 notes do not apply to the resolved bundle. `rackup` 1.0.1 requires `rack < 3`, so `rack` stayed at 2.2.24. Those items become live only if rack moves to 3.x later.

---

## 1. Required changes for the upgrade

Items marked **[pre-bump]** were verified on the 7.0 baseline and can ship first. Items marked **[bump]** need the Gemfile change.

### 1.1 Action Text allowlist breaks boot [pre-bump]
- **Affected code:** `/home/user/workspace/repo/config/initializers/action_text.rb:3`.
- **What breaks:** boot fails with `NoMethodError: undefined method '+' for nil`. In 8.1, `ActionText::ContentHelper.allowed_tags` defaults to `nil`, while 7.0 defaulted to an array.
- **Applicability:** immediate on bump. The repair also works on 7.0, and both versions use the same HTML4 sanitizer class, so the allowlist is identical.
- **Recommended repair:**
  ```ruby
  ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags +
    [ ActionText::Attachment.tag_name, "figure", "figcaption" ] + %w[ details summary ]
  ```
- **Validation:** without the repair, `setup` aborts at boot. With it, the notes test "rich text keeps collapsible excerpts and drops unsafe markup" (`/home/user/workspace/repo/test/controllers/notes_controller_test.rb:137`) passes on both versions.

### 1.2 Keyword-argument `enum` removed [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:10`.
- **What breaks:** every test errors during class load with `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. Removed in 8.0.
- **Applicability:** immediate on bump. The new form works on 7.0.
- **Recommended repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Validation:** probe `Note.new(status: "ready").status_ready?` returns `true` on both versions.

### 1.3 Positional `serialize` coder removed [bump]
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:12` (`serialize :tags, JSON`).
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at class load. The 7.0 signature is `serialize(attr_name, class_name_or_coder = ..., **options)`, and the 8.1 signature is `serialize(attr_name, coder: nil, type: Object, ...)`.
- **Applicability:** only at the bump. The `coder:` keyword does not exist on 7.0, so this cannot ship early.
- **Recommended repair:** `serialize :tags, coder: JSON`.
- **Validation:** `Note.new.tags` returns `[]` on 8.1, and the notes tests pass. I did not byte-compare stored `notes.tags` values between versions (see section 4).

### 1.4 `alias_attribute` over a store accessor [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:13-14`. Callers: `/home/user/workspace/repo/app/controllers/notes_controller.rb:68` (`:highlight_color` permitted), and `/home/user/workspace/repo/app/views/notes/_form.html.erb:31-37`, `/home/user/workspace/repo/app/views/notes/show.html.erb:3`, `/home/user/workspace/repo/app/views/notes/index.html.erb:44`.
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`. Probe on a class with the same declarations: `highlight_color` returns `"green"` on 7.0 and raises on 8.1. The first run without repair produced 21 errors of this kind.
- **Applicability:** immediate on bump. Replacing it with `alias_method` works on 7.0.
- **Recommended repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Validation:** `Note` with `settings: {"color" => "green"}` returns `"green"` from `highlight_color` on both versions. The control is `color` itself, and the highlight test "edits a note's rich body, tags, highlight, and status" (`notes_controller_test.rb:107`) passes.

### 1.5 Multi-path `get` route removed [pre-bump]
- **Affected code:** `/home/user/workspace/repo/config/routes.rb:18`.
- **What breaks:** route drawing fails with `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Routes count is 0 in `setup`.
- **Applicability:** immediate on bump. The split works on 7.0.
- **Recommended repair:**
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Validation:** the route table after the fix has 63 routes against 67 on the baseline. The four missing routes are dev/test Action Mailbox conductor routes, which this app does not use. Every application route is present and the tests pass.

### 1.6 `json` 3.x breaks ActiveSupport JSON decoding [bump]
- **Affected code:** `/home/user/workspace/repo/Gemfile`. The breakage hits the `serialize :tags, JSON` loader in `/home/user/workspace/repo/app/models/note.rb:12`.
- **What breaks:** `activesupport-8.1.0` requires `json` without a constraint, so bundler resolves `json` 3.1.0. Its `JSON.parse` takes keyword options only, while ActiveSupport passes a positional hash. The result is `ArgumentError: wrong number of arguments (given 2, expected 1)` from `ActiveRecord::Coders::JSON.load`. Notes fail to load. The 7.0 baseline uses the default `json` 2.7.2, which the baseline lockfile does not list.
- **Applicability:** only on bump. A plain-Ruby check also shows that `json` 3.1.0 breaks the 7.0 ActiveSupport encoder (`unknown keyword: quirks_mode`), so this pin belongs in the bump commit.
- **Recommended repair:** add `gem "json", "~> 2.7"` to the Gemfile and re-lock. It resolves to 2.7.2.
- **Validation:** before the pin, `Note.new.tags` raised the error above. After the pin, all tests pass on both load-defaults settings.

### 1.7 `where(notebooks: @notebook)` resolves to a non-existent column [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12`.
- **What breaks:** `ActiveRecord::StatementInvalid: PG::UndefinedColumn: column notes.notebooks does not exist`, on the `notebook_id` filter. Probe SQL: 7.0 emits `WHERE "notes"."notebook_id" = 7`; 8.1 emits `WHERE "notes"."notebooks" = 7`.
- **Applicability:** immediate on bump. The fix works on 7.0.
- **Recommended repair:** `@notes = @notes.where(notebook: @notebook)`.
- **Validation:** the notebook filter test (`notes_controller_test.rb:27-29`) passes. Control: unfiltered lists still pass.

### 1.8 `form_with(model: nil)` removed [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`.
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. This takes down the notes list, which the sign-in test follows, so five tests fail. Removed in 8.0.
- **Applicability:** immediate on bump.
- **Recommended repair:** `form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>`.
- **Validation:** "renders an unbound search form" (`notes_controller_test.rb:17`) passes. Control: `query`, `status`, and `per_page` field names are unchanged.

### 1.9 `Rails.application.secrets` removed [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb:13`. Test references: `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for an instance of MarginNotes::Application`. From code reading, `Citation#enrich` rescues only `Provider::Error`, so this `NoMethodError` escapes the job and the citation stays `pending`. I did not run this path in a worker.
- **Applicability:** immediate on bump. The repair works on 7.0.
- **Recommended repair:**
  - Add `/home/user/workspace/repo/config/initializers/citation_provider.rb`: `Rails.application.config.x.citation_provider = Rails.application.config_for(:secrets).citation_provider`
  - In `citation/provider.rb:13`, use `settings = Rails.configuration.x.citation_provider.to_h`
  - In the test, replace `Rails.application.secrets.citation_provider` with `Rails.configuration.x.citation_provider`
- **Validation:** `config_for(:secrets).citation_provider` returns `{:url=>"http://127.0.0.1:9393", :user=>"margin-notes", :password=>"local-only"}` on both versions. The citation tests pass; before the repair they errored with `NoMethodError`.

### 1.10 `wait: :exponentially_longer` removed [bump]
- **Affected code:** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer` whenever `Citation::Provider::Unavailable` is retried. Removed in 7.2.
- **Applicability:** only on bump. The `:polynomially_longer` symbol does not exist in 7.0, so it cannot ship early.
- **Recommended repair:** `retry_on Citation::Provider::Unavailable, wait: :polynomially_longer, attempts: 3 do |job, error|`
- **Validation:** the test "a provider that stays unavailable or refuses the request leaves a visible failure" fails on the old symbol and passes with the new one.

### 1.11 `Array#sum` over strings [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/export.rb:42` (`finish(fragments.sum)`).
- **What breaks:** `TypeError: String can't be coerced into Integer`. On 7.0, `["a","b"].sum` returns `"ab"` with a deprecation warning. On 8.1 it raises. Export generation fails and the export stays `working`, based on the `start` and `finish` code path.
- **Applicability:** immediate on bump. `join` works on 7.0.
- **Recommended repair:** `finish(fragments.join)`.
- **Validation:** the export test "a reader exports a notebook as Markdown and downloads it" passes. Control: the markdown body text is unchanged.

### 1.12 `HashWithIndifferentAccess#stringify_keys` drops integer keys [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22`.
- **What breaks:** the annotation is silently missing from the import preview. The test `imports_controller_test.rb:22` expected `#line_2 dd` to read `Read <b>twice</b> & reflect` and got `10.1000/Essays.1`. Probe: `h[2] = "x"; h.stringify_keys[2]` returns `"x"` on 7.0 and `nil` on 8.1. Stringify-keys behavior changed in 8.0.
- **Applicability:** immediate on bump.
- **Recommended repair:** `<% annotations = @import.annotations %>`.
- **Validation:** `imports_controller_test.rb:21-25` passes on both versions. Control: row-level DOI cells still render.

### 1.13 Import commits a partial import on a non-local return [pre-bump] (data integrity)
- **Affected code:** `/home/user/workspace/repo/app/models/import.rb:50-61`, the `return false` inside `transaction`.
- **What breaks:** on 7.0 the transaction rolls back when `return` exits the block. On 8.1 it commits. Probe `Citation.transaction { Citation.create!(...); return :early }`: 7.0 returns `[:non_local_return, :early, false]` (rolled back); 8.1 returns `true` (committed). The invalid-row test (`imports_controller_test.rb:48-65`) observed `record_counts` (`[Import, Note, Citation, RichText]`) change from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`.
- **Applicability:** immediate on bump. Raising `ActiveRecord::Rollback` gives the same result on 7.0.
- **Recommended repair:**
  ```ruby
  saved = false
  transaction do
    save!
    saved = rows.all? { |row| row.note.save }
    raise ActiveRecord::Rollback unless saved
  end
  saved
  ```
- **Validation:** the invalid-row test passes with `record_counts` unchanged at `[0, 3, 0, 1]`. Control: the valid-CSV import test (`imports_controller_test.rb:6-30`) still saves every row.

### 1.14 Receipt CSV loses the DOI column [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/import.rb:68` (`citation && citation[:id]`).
- **What breaks:** `citation[:id]` returns `nil` on 8.1 because `Citation` uses `doi` as its primary key. Probe `Citation.new(doi: "10.1000/x")[:id]`: 7.0 `"10.1000/x"`, 8.1 `nil`. The receipt row is `On idleness,` where the test expects `On idleness,10.1000/Essays.1`.
- **Applicability:** immediate on bump.
- **Recommended repair:** `csv << [ note.title, citation&.doi ]`.
- **Validation:** the receipt assertion (`imports_controller_test.rb:45`) passes. Control: notes without a citation still produce a blank DOI.

### 1.15 Digest day and window move to the reader's zone [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/mailers/digest_mailer.rb:7-9`, with `/home/user/workspace/repo/app/models/user.rb:41` and `/home/user/workspace/repo/app/jobs/digest_job.rb:6`.
- **What breaks:** ActiveJob 8.1 restores a `TimeWithZone` in the reader's zone. The payload gains a `"time_zone" => "America/New_York"` key. Probe: a request at 2026-10-04 23:30 EDT deserializes as offset `0` and date `2026-10-05` on 7.0, but as offset `-14400` and date `2026-10-04` on 8.1. The test `digests_controller_test.rb:33` expected `Your reading digest for October 05, 2026` and got `October 04`. The `all_day` window also moves to the reader's local day, which contradicts the UTC-day comments in the code.
- **Applicability:** immediate on bump. The repair works on 7.0.
- **Recommended repair:** in `daily_digest`, after `params.values_at`, add `requested_at = requested_at.utc`.
- **Validation:** the digest test passes. Control: a 7.0 worker reading the 8.1 payload also derives offset `0` (probe).

### 1.16 Postponed reminder changes its displayed wall-clock time [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:44`, with the display in `/home/user/workspace/repo/app/views/notes/_reminder.html.erb:19`.
- **What breaks:** on 8.1, `to_time` keeps the named zone, so `+ 86_400` gives `2026-11-01T08:00:00-05:00` where 7.0 gives `2026-11-01T09:00:00-04:00`. The instant is the same, 1793538000 on both. The test `reminders_controller_test.rb:21` found zero matches for `time[datetime="2026-11-01T09:00:00-04:00"]`.
- **Applicability:** immediate on bump. The repair works on 7.0.
- **Recommended repair:** `reminder_at.to_time.localtime(reminder_at.utc_offset) + 86_400`.
- **Validation:** with the repair, the probe shows `2026-11-01T09:00:00-04:00` and epoch 1793538000 on both. Control: the scheduled epoch is unchanged.

### 1.17 Integer epoch passed to `wait_until` [pre-bump]
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:61` (`NoteReminderJob.set(wait_until: reminder_epoch)`).
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Reminder creation returns 500.
- **Applicability:** immediate on bump.
- **Recommended repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`.
- **Validation:** the reminder tests pass. Control: the "emailed once it is due" path still delivers.

### 1.18 `show_exceptions = false` changes meaning [bump]
- **Affected code:** `/home/user/workspace/repo/config/environments/test.rb:31`.
- **What breaks:** on 8.1, `false` no longer means "do not show". Errors are rendered as 404/500 instead of raised, so assertions for raised exceptions fail. Observed: `ActiveRecord::RecordNotFound expected but nothing was raised` (`notebooks_controller_test.rb:41`, `notes_controller_test.rb:174`, `imports_controller_test.rb:92`, `reminders_controller_test.rb:60`, `citation_enrichments_controller_test.rb:90`) and `Redis::CannotConnectError expected but nothing was raised` (`digests_controller_test.rb:45`). Production is not affected because the setting is not in `production.rb`.
- **Applicability:** only on bump. On 7.0, `:none` is truthy and shows exceptions, so it cannot ship early.
- **Recommended repair:** `config.action_dispatch.show_exceptions = :none`.
- **Validation:** those tests pass with the repair. Control: cross-user access still raises `RecordNotFound` rather than returning 200.

### 1.19 Built-in Sidekiq Active Job adapter deprecated [decision]
- **Affected code:** `/home/user/workspace/repo/config/application.rb:24` (`config.active_job.queue_adapter = :sidekiq`), with `sidekiq 6.5.12` in the Gemfile.
- **What breaks:** nothing failed in tests. Active Job 8.1 deprecates the built-in adapter and recommends `sidekiq` 7.3.3 or later. The adapter instantiates, but I did not exercise enqueueing against Redis.
- **Applicability:** a dependency decision, not a repair. Upgrading Sidekiq is outside the task's authority.
- **Recommended repair:** decide whether to bump Sidekiq to 7.3.3 or later in the same change, and re-run the queued-job checks.

---

## 2. New configuration defaults across intermediate releases

The app currently sets `config.load_defaults 7.0` at `/home/user/workspace/repo/config/application.rb:12`. Every default below is therefore still the old value. "Affects this app" lists the effect observed or read from code. Each default is listed with the release that introduced it, from the `load_defaults` blocks in the installed railties 8.1.0 source. The `gem-changes` output had no framework-defaults section, so this list is derived from source.

**Release 7.1**
- `active_record.default_column_serializer = nil`. Affects this app: `/home/user/workspace/repo/app/models/notebook.rb:7` raises `ArgumentError: missing keyword: :coder`. Repair: `serialize :preferences, coder: YAML`. The stored format is identical: `"---\nexport_heading: Reading notes\n"` on both.
- `active_record.raise_on_assign_to_attr_readonly = true`. Affects this app: `/home/user/workspace/repo/app/controllers/notebooks_controller.rb:40` resubmits `slug`, and `notebook.rb:8` makes it `attr_readonly`. The error is `ActiveRecord::ReadonlyAttributeError: slug`. Repair: remove `:slug` from `permit`. This works on 7.0 too.
- `active_support.raise_on_invalid_cache_expiration_time = true`. Affects this app: `/home/user/workspace/repo/app/views/exports/_export.html.erb:26` raises `Cache expiration time is invalid, cannot be negative: -60.0` for expired exports. Repair: `expires_in: [export.expires_at - Time.current, 0].max`. Do not use `cache_if export.downloadable?`; it broke the expired-export cache-hit test.
- `active_support.message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true`. Affects this app: signed tokens are written as JSON (probe: `"ImhpIg==--..."` versus Marshal `"BAhJ..."`). Active Storage signed blob IDs use this serializer family, and the view `/home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb:11` builds links from them. Not verified against an 8.1 Active Storage link. Keep this at the 7.0 value until rollback is no longer needed.
- `active_support.cache_format_version = 7.1`. Affects this app: `Rails.cache` entries in the default file store become unreadable by 7.0. Probe: 7.0 reading an 8.1-written entry raises `TypeError: incompatible marshal file format (can't be read)`. Keep 7.0 until rollback is no longer needed.
- Also in 7.1, with no app effect observed: `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `dom_testing_default_html_version = :html5` (tests pass), `log_file_size`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `query_log_tags_format`, `belongs_to_required_validates_foreign_key`, `before_committed_on_all_records`, `encryption` digest settings (no encryption in use), `marshalling_format_version`, `run_after_transaction_callbacks_in_order_defined` (no `after_commit` in app), `generate_secure_token_on` (no `has_secure_token`), `action_dispatch.default_headers` (drops `X-Download-Options`; untested), `debug_exception_log_level`, and `sanitizer_vendor` (no change observed; both versions use HTML4).

**Release 7.2**
- `active_record.postgresql_adapter_decode_dates = true`. Affects this app: `select_rows` returns `Date` objects, and `/home/user/workspace/repo/app/models/notebook.rb:40` raises `TypeError: no implicit conversion of Date into String`. Repair: `[day.to_date, count]`. Works on 7.0.
- `yjit = true`, `active_storage.web_image_content_types`, `validate_migration_timestamps = true`. No failures; migrations are dated 2026-10-11, before today.

**Release 8.0**
- `action_dispatch.strict_freshness = true`. Affects this app only if `ExportDownloadsController#show` (`stale?` with ETag and Last-Modified) receives both headers. Not tested.
- `Regexp.timeout = 1`. Verified value `1.0` under 8.1 defaults. The DOI regex in `citation.rb:9` is simple, so risk is low.

**Release 8.1**
- `action_controller.escape_json_responses = false`. No `render json` in the app, so no effect.
- `action_controller.action_on_path_relative_redirect = :raise`. Every `redirect_to` uses a route helper, so no effect (grep).
- `active_record.raise_on_missing_required_finder_order_columns = true`. No bare `first`/`last` calls (grep), so no effect.
- `active_support.escape_js_separators_in_json = false`, `action_view.render_tracker = :ruby` (dev only), `remove_hidden_field_autocomplete = true` (tests pass), `yjit = !local` (production performance only).

**Later deprecations or removals affecting current settings**
- `config.action_dispatch.show_exceptions = false` in `test.rb` (removed in 7.2). See 1.18.
- `config.active_job.queue_adapter = :sidekiq` (built-in adapter deprecated in 8.1). See 1.19.
- `config.active_support.report_deprecations = false` in `production.rb:76` is still supported.

---

## 3. Rollout, rollback, and mixed-version risks

**Pre-bump repairs (deploy on 7.0 first).** These are verified on the baseline: 1.1, 1.2, 1.4, 1.5, 1.7, 1.8, 1.9, 1.11, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, plus the 7.1-defaults fixes for `slug` permit, cache clamp, and `day.to_date`. Together these were 18 replacements; the baseline suite passed.

**Proposed pre-bump repair, not executed as a full suite:** `DigestJob` queued payloads. On 7.0, a `BigDecimal` argument is encoded as the JSON string `"0.5"`, while 8.1 encodes it as `{"_aj_serialized"=>"ActiveJob::Serializers::BigDecimalSerializer","value"=>"0.5"}`. A 7.0 worker reading the 8.1 form fails with `ActiveJob::DeserializationError`. Change `user.rb:41` to pass `reading_completion.to_s`, which `DigestMailer`'s `BigDecimal(params[:completion])` accepts, and this keeps the 7.0 wire format.

**Database rows.** No migration is involved. `db/schema.rb` changes on dump: columns sort alphabetically, the header becomes `Schema[8.1]`, and `enable_extension "plpgsql"` becomes `"pg_catalog.plpgsql"`. Sorted-line comparison shows the content is otherwise identical. `notebooks.preferences` (YAML) dumps identically with `coder: YAML`. `notes.tags` uses the same JSON coder path, but I did not byte-compare stored values.

**Queued Active Job payloads.** `DigestJob`'s `BigDecimal` and `TimeWithZone` arguments are the only ones verified. A 7.0 worker reads an 8.1 `time_zone` key, ignores it, and gets UTC, which is correct. The `BigDecimal` hash is the real risk, so deploy the string argument before the bump. GlobalID arguments (`NoteReminderJob`, `CitationEnrichmentJob`) were not probed.

**Signed tokens and cookies.** Under 7.0 defaults, the message serializer stays Marshal, so the bump is safe. Under 7.1 defaults the serializer is JSON. Probe: a JSON token read by a Marshal verifier raises `TypeError`, and a Marshal token read by a JSON verifier raises `JSON::ParserError`. The session cookie uses `cookies_serializer = :json`, which is unchanged by any `load_defaults` block (source reading).

**Cache.** No `cache_store` is set for production, so `Rails.cache` uses the file store. Redis holds Sidekiq queues and digest reservations (`Sidekiq.redis`), not `Rails.cache`. Redis is unaffected by the Rails version apart from queued payloads.

**Recommended order:**
1. Deploy all pre-bump repairs on 7.0, including the `DigestJob` string argument.
2. Bump to 8.1 with `load_defaults 7.0`, plus the bump-time changes: `serialize ... coder: JSON`, the `json` pin, `show_exceptions = :none` in the test environment, and `:polynomially_longer`. Rollback is a revert. Rows written by 8.1 are readable by 7.0 because no defaults changed, and no `BigDecimal` hash is queued.
3. Adopt the defaults later, one release at a time, pinning `message_serializer` and `cache_format_version` to their 7.0 values until the rollback window closes.

---

## 4. Verification log and open questions

**Executed in `upgrade-workspace` (rails 7.0.8.7 to 8.1.0):**
- `gem-changes rails 7.0.8.7 8.1.0` (read in full).
- `upgrade-workspace setup rails 7.0.8.7 8.1.0`: baseline boot OK, eager load OK, 67 routes, 46 runs / 325 assertions / 0 failures. Upgraded boot FAILED (the `action_text.rb` error).
- `upgrade-workspace test --target upgraded` after each repair. Each run and its outcome:
  - Run 2: enum error at `note.rb:10`.
  - Run 3: serialize error at `note.rb:12`, then alias errors.
  - Run 4: routes and alias fixed; `given 2, expected 1` and 500s.
  - Run 5: json pinned; 25 failures remain.
  - Run 6: `show_exceptions` and `sum` fixed; 15 failures remain.
  - Run 7: form, where, wait_until, stringify, secrets fixed; 5 failures remain.
  - Run 8: all fixes; 0 failures.
  - Run 9: slug, cache, and date fixes for 8.1 defaults.
  - Run 10: clamped cache; 0 failures on `load_defaults 7.0`.
- `upgrade-workspace test --target upgraded --defaults 8.1`, in four runs. Run 2: boot error at `notebook.rb:7`. Run 3: slug, cache, and date errors. Run 4: the `cache_if` variant broke a cache-hit test. Run 5: clamped cache; 0 failures.
- `upgrade-workspace test --target baseline` after applying the pre-bump repairs: 46 runs, 325 assertions, 0 failures.
- `upgrade-workspace probe` (several batches). Verified outputs:
  - Non-local return: `[:non_local_return, :early, false]` on 7.0 and `true` on 8.1.
  - `citation[:id]`: `"10.1000/x"` on 7.0 and `nil` on 8.1.
  - ActiveJob `TimeWithZone`: offset `0` on 7.0 and `-14400` on 8.1.
  - `to_time` postponement: `08:00-05:00` on 8.1 versus `09:00-04:00` on 7.0, same epoch.
  - `sum`, `stringify_keys`, alias, and `where` SQL, as in the findings above.
  - Defaults 8.1: cache negative TTL raises; `select_rows` returns `Date`; read-only assignment raises; bare `serialize` raises; YAML dump identical; `Regexp.timeout` is `1.0`.
  - Message verifier and cache cross-version reads (the `TypeError` and `JSON::ParserError` results above).
  - `require "net/smtp"` loads on 8.1.
- Route and schema dumps. Route tables differ by the four Action Mailbox conductor routes. Schema content matches after sorting.

**Resolved versions (from the copied bundle log and installed gems):** `rails`, `activerecord`, `actionpack`, and the rest of the Rails family at 8.1.0; `action_text-trix` 2.1.19 added; `json` 3.1.0 unpinned, pinned to 2.7.2; `rack` 2.2.24 (unchanged), `rack-session` 1.0.2, `rackup` 1.0.1 (requires `rack < 3`); `sidekiq` 6.5.12, `faraday` 1.10.4, `pagy` 8.6.3 unchanged. Baseline Ruby 3.3.6.

**Configuration tested:** the upgraded copy with the app's `load_defaults 7.0` and with `load_defaults 8.1` via `--defaults 8.1`; isolated PostgreSQL and Redis databases; test environment.

**Read from source only:** the `load_defaults` blocks in railties 8.1.0; `show?` in `actionpack-8.1.0/lib/action_dispatch/middleware/exception_wrapper.rb`; `serialize` in `activerecord-8.1.0/.../attribute_methods/serialization.rb`; `ContentHelper` in `actiontext-8.1.0`.

**Log paths:** the originals under `/tmp/upgrade-rails-8.1.0/logs` were removed by `cleanup`. I copied them to `/tmp/rails81-scratch/logs-copy/` before cleanup. That directory holds `tests-upgraded-run2.log` through `run10.log`, `tests-upgraded-defaults-8.1-run2.log` through `run5.log`, `tests-baseline-prebump.log`, `bundle-update.log`, the `diag-*.log` files, and the schema-load logs. Routes and schema dumps are at `/tmp/rails81-scratch/routes_b.txt`, `routes_u.txt`, `schema_7.0.8.7.rb`, and `schema_8.1.0.rb`. The pre-bump repair script is `/tmp/rails81-scratch/prebump.rb`.

**Proposed, not executed:** the `DigestJob` string argument as a full-suite change; pinning `message_serializer` and `cache_format_version` to their 7.0 values; the Sidekiq 7.3.3 upgrade.

**Open questions and unverified claims:**
- Browser and system tests (`bin/rails test:system`) were not run. Turbo, Stimulus, importmap, and Trix behavior are unverified. The app keeps its vendored `/home/user/workspace/repo/vendor/javascript/trix-1.3.5.js`, while 8.1 ships Trix 2.1.19 in a gem.
- Production-only paths were not exercised: the `production.rb` logger configuration (`ActiveSupport::Logger`/`BroadcastLogger`), asset precompilation, and SMTP delivery.
- The citation production failure after the `secrets` removal is from code reading only (section 1.9).
- Byte-level equality of `notes.tags` and GlobalID payloads across versions is unverified.
- `strict_freshness` on export downloads and `Regexp.timeout` on DOI validation are untested.
- Rack 3 items: inactive with rack 2.2.24. When rack moves to 3.x, re-check response header handling and `Rack::Request` usage in `citation_enrichments_controller_test.rb:108`.
- Test assertion counts differ (325 baseline vs 340 upgraded). I did not investigate why.
- The `ExportJob` Sidekiq strict-args warning appeared in the upgraded logs. I did not confirm whether the baseline logs show it.

---

I stopped at the plan, as the upgrade-gem skill requires. The repo is unchanged. Going from here to an actual upgrade means roughly 14 pre-bump repairs on 7.0, then the Gemfile bump with the bump-time changes, and the test run needs the PostgreSQL and Redis services the planner used.

Two things to decide before implementation:
- **Sidekiq (1.19):** whether to move to 7.3.3+ in the same change. The plan treats it as a separate decision.
- **Shipping order:** whether to land the pre-bump repairs as their own commit or PR before the bump. The plan recommends this, mainly because of the `DigestJob` payload change.

Say the word and I'll carry out the pre-bump repairs, then the bump, and run `bin/rails test` against the result.