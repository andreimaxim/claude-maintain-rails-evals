# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

Bumping only the Rails gem breaks the app. On 8.1.0 it fails to boot (`config/initializers/action_text.rb:3`), `app/models/note.rb` fails to load, and the test run then aborts with "Test runner exited with status 1". I worked through the failures one at a time in the disposable workspace and applied 20 repairs. After that, the suite passed on 8.1.0 with `load_defaults 7.0` (46 runs, 340 assertions, 0 failures) and with `load_defaults 8.1` (46 runs, 340 assertions, 0 failures).

All repairs except three also passed on 7.0.8.7 (46 runs, 325 assertions, 0 failures), so they can ship before the bump. The three that cannot are `serialize ... coder:`, `show_exceptions = :none` and the Notebook `coder: YAML`. They have to go in the same commit as the version bump.

The workspace has been cleaned up and `git status` in `/home/user/workspace/repo` is clean.

**Dependency changes (resolved `Gemfile.lock`):**
- **Moved:** all Rails components 7.0.8.7 → 8.1.0, net-imap 0.6.7 → 0.6.8.
- **Added:** action_text-trix 2.1.19, bigdecimal 4.1.3, drb, json 3.1.0, rack-session 1.0.2, rackup 1.0.1, securerandom, uri, useragent, webrick.
- **Removed:** method_source. The app does not use it.
- **Rack stays at 2.2.24.** `puma ~> 5.0` keeps it there, so the Rack 3 items that `gem-changes` listed do not apply to this bump. The only custom Rack app is the test lambda in `test/controllers/citation_enrichments_controller_test.rb:107-110`, which returns a mixed-case header hash. That needs revisiting only if Puma moves to 6 or later.
- **Not a problem:** net-smtp, net-pop and mini_mime stay locked through the mail gem.

---

## 1. Required changes for the upgrade

In every R item below, "repair" names the single fix I recommend, and that fix was applied and verified in `upgraded`. In each item, "repair proven by" also covers the control check unless one is named separately.

**R1. json 3.1.0 breaks every JSON-serialized column**
- **Affected code:** `Gemfile`. The failure surfaces in `app/models/note.rb:12` (`serialize :tags`) and every `ActiveSupport::JSON.decode`.
- **What breaks:** the resolver picks json 3.1.0. ActiveSupport 8.1.0's `ActiveSupport::JSON.decode` calls `::JSON.parse(json, options)` with a positional options hash, which json 3 rejects. `notebook.notes.create!(title: "Adam", created_at: Time.utc(2026,9,5))` raised `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291`. That took down sign-in and every Note load.
- **Applicability:** immediate on the bump. The pin is harmless on 7.0, which already uses json 2.7.2. No stored data is affected.
- **Repair:** in `Gemfile`, add `gem "json", "~> 2.7"`. It resolved to 2.7.2. Drop the pin once a Rails or json release fixes the incompatibility.
- **Validation:** the probe above fails without the pin and returns OK with it. A Note with `tags '["Victorian","marriage"]'` round-trips.

**R2. `ActionText::ContentHelper.allowed_tags` is nil**
- **Affected code:** `config/initializers/action_text.rb:3`.
- **What breaks:** boot fails with `NoMethodError: undefined method '+' for nil`. Since 7.1, `allowed_tags` has no default value and the helper falls back to the defaults at render time.
- **Applicability:** immediate on the bump. The repair passes on 7.0.
- **Repair:**
  ```ruby
  Rails.application.config.after_initialize do
    helper = ActionText::ContentHelper
    defaults = helper.allowed_tags || (helper.sanitizer.class.allowed_tags.to_a + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])
    helper.allowed_tags = defaults.to_a | %w[ details summary ]
  end
  ```
- **Validation:** `NotesControllerTest#test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes on 8.1 under both defaults and on 7.0. The test confirms that `<details>` is kept and unsafe markup is dropped.

**R3. Keyword `enum` signature removed**
- **Affected code:** `app/models/note.rb:10`.
- **What breaks:** loading the class raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Validation:** a probe gave `{"draft"=>0,"ready"=>1}` and `status_ready? == true` on both versions. The notes status-filter tests also pass.

**R4. `serialize :tags, JSON` positional coder removed**
- **Affected code:** `app/models/note.rb:12`.
- **What breaks:** loading the class raises `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Applicability:** immediate on the bump. The repair does **not** work on 7.0. On 7.0, `serialize :tags, coder: JSON` silently gives `ActiveRecord::Coders::YAMLColumn` (probed). It would write YAML into a column holding `'["Victorian","marriage"]'`, which 8.1 then cannot parse. Ship it only together with the bump. The stored JSON format is identical on both versions, so mixed-version reads are fine.
- **Repair:** `serialize :tags, coder: JSON`
- **Validation:** on 8.1, a probe shows the coder is `ActiveRecord::Coders::JSON`. The fixture tag list `Victorian, marriage` renders and edits ("edits a note's rich body, tags…" test passes).

**R5. `alias_attribute` to a `store_accessor` key now raises**
- **Affected code:** `app/models/note.rb:14`. Used by `app/views/notes/_form.html.erb:31-37`, `notes/index.html.erb:44`, `notes/show.html.erb:3` and the `notes_controller.rb:68` permit list.
- **What breaks:** the first Note instantiation raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.`
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Validation:** `create!(highlight_color: "pink")` then `reload` gave `["pink", "{\"color\": \"pink\"}"]` on both versions. The notes update test (green, then blue on invalid) passes.

**R6. Multiple paths in one route removed**
- **Affected code:** `config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`.
- **What breaks:** route drawing fails with `ArgumentError: Wrong number of arguments (expect 1, got 2)`. With no routes drawn, every request fails.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Validation:** "lists the reader's notes newest first at both list paths" passes on both versions.

**R7. `Rails.application.secrets` removed (7.2)**
- **Affected code:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **What breaks:** every citation lookup raises `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. That error is not `Provider::Error` or `Unavailable`, so `CitationEnrichmentJob` crashes and the enrichment stays `pending` permanently. Re-requesting is then blocked by `Citation#request_enrichment:16`.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:**
  - Rename `config/secrets.yml` to `config/citation_provider.yml` and flatten it to per-environment `url`/`user`/`password` keys.
  - Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  - Change the provider default to `Rails.configuration.x.citation_provider.to_h`.
  - Make the same replacement in the test.
- **Validation:** "provider credentials from the environment reach the server unchanged" passes on both versions. It boots a fresh `bin/rails runner` with user `00123` and password `sample: value # keep`, and asserts the exact Basic auth header.

**R8. `retry_on wait: :exponentially_longer` removed**
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** the class loads, but the first `Unavailable` raises `RuntimeError: Couldn't determine a delay based on :exponentially_longer` (probed). The `fail_enrichment` block never runs, the error goes to Sidekiq's own retries, and the citation stays `pending`. No test covers this.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `wait: ->(executions) { executions**4 + 2 }`. Use `:polynomially_longer` once only 8.1 is running; it does not exist on 7.0.
- **Validation:** the delay for executions=2 was `18` on both versions with the repair. The original value gave `18.0` on 7.0 and the RuntimeError on 8.1. "a provider that stays unavailable…" passes.

**R9. `form_with(model: nil)` now raises**
- **Affected code:** `app/views/notes/index.html.erb:12`.
- **What breaks:** the note list fails with `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. Sign-in redirects to this page, so the app is unusable.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `form_with(url: notes_path, method: :get, class: "search", html: { role: "search" })`
- **Validation:** "renders an unbound search form" passes, and so does the sign-in test.

**R10. `where(notebooks: record)` no longer resolves to the joined table**
- **Affected code:** `app/controllers/notes_controller.rb:12`.
- **What breaks:** `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist` whenever `?notebook_id=` is used.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `@notes = @notes.where(notebook: @notebook)`
- **Validation:** "filters by notebook, status, and title" and "pages through filtered notes…" pass. The second covers two notebooks with different notes.

**R11. `wait_until:` with an Integer epoch**
- **Affected code:** `app/models/note.rb:61`.
- **What breaks:** scheduling a reminder raises `NoMethodError: undefined method 'utc' for an instance of Integer`.
- **Applicability:** immediate on the bump. The repair works on 7.0. Probed: `scheduled_at` is `1793451600.0` on 7.0 and `2026-10-31 13:00:00 +0000` on 8.1.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`
- **Validation:** both reminder tests pass, covering an America/New_York reader and an imported epoch of `1767225600`.

**R12. `TimeWithZone#to_time` always keeps the zone (8.0; the setting is deprecated in 8.1)**
- **Affected code:** `app/models/note.rb:44` (`next_day_reminder_at`).
- **What breaks:** for an America/New_York reminder at `2026-10-31T09:00`, the "next day" time was `2026-11-01T09:00:00-04:00` on 7.0 and became `2026-11-01T08:00:00-05:00` on 8.1. The documented contract is "keeps the reminder's UTC offset". The test failed at `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]`. The epoch is the same in both cases, so the scheduled postponement time does not change.
- **Applicability:** immediate on the bump. 8.1 also prints "`config.active_support.to_time_preserves_timezone` is deprecated and will be removed in Rails 8.2". The repair works on 7.0.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`
- **Validation:** the probe gave `2026-11-01T09:00:00-04:00` on both versions. The reminder controller test passes.

**R13. Active Support no longer sums strings**
- **Affected code:** `app/models/export.rb:42`, `finish(fragments.sum)`.
- **What breaks:** every export job raises `TypeError: String can't be coerced into Integer`. The export stays `working` and no file is written. On 7.0 this already prints a deprecation warning.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `finish(fragments.join)`
- **Validation:** the export tests pass. They check the exact Markdown for the two notes and download it until expiry.

**R14. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys**
- **Affected code:** `app/views/imports/preview.html.erb:22`.
- **What breaks:** `annotations[row.line]` returns nil, so the import preview silently drops every annotation. The test got `"10.1000/Essays.1"` where it expected `"Read <b>twice</b> & reflect"`. Probed: `h[2]="Read"; h.stringify_keys[2]` returns `"Read"` on 7.0 and `nil` on 8.1.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `<% annotations = @import.annotations %>`
- **Validation:** the preview test passes for line 2 and line 4.

**R15. `record[:id]` no longer returns a custom primary key**
- **Affected code:** `app/models/import.rb:67-68` (`receipt`).
- **What breaks:** the CSV receipt loses every DOI. The test got `"On idleness,\nOf experience,\n"` where it expected `10.1000/Essays.1`. Probed: `Citation.new(doi: "10.1000/x.1")[:id]` returns `"10.1000/x.1"` on 7.0 and `nil` on 8.1.
- **Applicability:** immediate on the bump. The repair works on 7.0.
- **Repair:** `csv << [ note.title, note.citation&.doi ]`
- **Validation:** with one cited and one uncited row, the receipt was `"title,doi\nOn idleness,10.1000/Ess.2\nOf experience,\n"` on both versions.

**R16. A non-local `return` inside `transaction` now commits**
- **Affected code:** `app/models/import.rb:53-57` (`apply`).
- **What breaks:** applying a CSV whose second row is invalid now persists the Import, the first Note and its Citation, even though "applying saves nothing". `record_counts` went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`.
- **Applicability:** 7.1 deprecated the behavior under old defaults, and from 7.2 it commits always. The repair works on 7.0. Any partial imports created during rollout would remain as data.
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
- **Validation:**
  - Rows `Adam Bede/10.1000/bede` and a blank title with `not-a-doi` returned `[false, 0, 0, 0]` on both versions (imports, notes, citations).
  - **Control:** a two-row valid CSV returned `true` with both notes saved.

**R17. Active Job keeps the TimeWithZone zone (shows up in the digest)**
- **Affected code:** `app/mailers/digest_mailer.rb:7-8`, together with `app/models/user.rb:35,41`.
- **What breaks:** the job now deserializes `requested_at` in the reader's zone, so the digest covers the reader's local day instead of the worker's UTC day. The test got "Your reading digest for October 04, 2026" where it expected "October 05, 2026". The probed payload gains `"time_zone"=>"Pacific/Auckland"`.
- **Applicability:** immediate on the bump. The repair works on 7.0, where it has no effect.
- **Repair:** `@reader, requested_at = params[:reader], params[:requested_at].in_time_zone`
- **Validation:** an Auckland reader at `2026-10-05T08:30+13:00` gets "October 04, 2026" on both versions. **Control:** UTC `2026-10-05 12:00` gives "October 05, 2026".

**R18. BigDecimal job argument payload is not readable by 7.0 workers**
- **Affected code:** `app/models/user.rb:41`.
- **What breaks:** 8.1 serializes `BigDecimal` as `{"_aj_serialized"=>"ActiveJob::Serializers::BigDecimalSerializer"}`, even under `load_defaults 7.0`. A 7.0 worker raises `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`, and the digest is lost while its Redis reservation keeps the reader blocked for the day.
- **Applicability:** only when 7.0 and 8.1 processes run together (rollout or rollback). Deploy the repair on 7.0 first.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already does `BigDecimal(params[:completion])`.
- **Validation:** the payload is the plain string `["0.0"]` on both versions. The digest test asserts the percentage line.

**R19. `show_exceptions = false` is no longer recognised**
- **Affected code:** `config/environments/test.rb:31`.
- **What breaks:** in 8.1, `ExceptionWrapper#show?` treats anything other than `:none` or `:rescuable` as "show". Tests that `assert_raises ActiveRecord::RecordNotFound` (another reader's notebook or note) would get rendered 404 pages instead.
- **Applicability:** immediate on the bump, test environment only. **Do not** ship it on 7.0: there `:none` is truthy and would turn on exception pages.
- **Repair:** `config.action_dispatch.show_exceptions = :none`
- **Validation:** the env value probed as `:none`. The "another reader's … cannot be reached" tests pass.

**R20. Sidekiq Active Job adapter (deprecation, not blocking)**
- **Affected code:** `config/application.rb:24` with `sidekiq 6.5.12`.
- **What changes:** 8.1 warns "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2". I read this in the source; tests use the `:test` adapter.
- **Repair:** none needed for 8.1. Plan Sidekiq ≥ 7.3.3 before Rails 8.2.
- **Validation:** `ActiveJob::QueueAdapters.lookup(:sidekiq)` resolves on 8.1.

**Also checked and not affected:**
- **Things the app does not use:** `has_secure_token`, Active Record encryption, `render json:`, custom middleware, path-relative redirects, after_commit callbacks, and models without a primary key.
- **`Relation#transaction` default-scope fix:** `import.rb:53` calls `transaction` on the record, not on a relation, so it is unaffected.
- **Test adapter config:** `config.active_job.queue_adapter = :test` in `config/environments/test.rb` is now respected consistently. The tests already expect that.

---

## 2. New configuration defaults across intermediate releases

The app sets `config.load_defaults 7.0` in `config/application.rb:11` and sets none of these explicitly. Every default below therefore keeps its old value until `load_defaults` is raised. With R1–R19 plus D1–D4 applied, the full suite passes under `load_defaults 8.1`.

**7.0.10:** no new defaults.

**7.1 defaults that affect this app:**

**D1. `active_record.default_column_serializer = nil`**
- **Code:** `app/models/notebook.rb:7`, `serialize :preferences`.
- **Effect:** loading the class raises `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'`.
- **Repair:** `serialize :preferences, coder: YAML`. Ship it with the bump; on 7.0 the keyword is ignored.
- **Data:** the stored YAML is unchanged.
- **Validation:** the notebook tests pass under 8.1 defaults.

**D2. `active_record.raise_on_assign_to_attr_readonly = true`**
- **Code:** `app/controllers/notebooks_controller.rb:39-40` permits `:slug`. The form resubmits it as a hidden field (`notebooks/_form.html.erb:11`).
- **Effect:** saving notebook settings raises `ActiveRecord::ReadonlyAttributeError: slug`.
- **Repair:** `params.require(:notebook).permit(:name, :export_heading)`. Create is unaffected because `assign_slug` overrides the value anyway. Works on 7.0.
- **Validation:** "settings update the name and export heading but keep the slug" passes. So do the create control ("Novels" gets slug `novels`) and the blank-name check.

**D3. `active_support.raise_on_invalid_cache_expiration_time = true`**
- **Code:** `app/views/exports/_export.html.erb:26`.
- **Effect:** an expired completed export makes the exports page raise `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0`.
- **Repair:** `expires_in: (export.expires_at - Time.current if export.downloadable?)`. The expired state is cached without expiry. Works on 7.0.
- **Validation:** "the cached availability indicator does not authorize a download" passes. It covers both the available and the expired render.

**D4. `active_record.postgresql_adapter_decode_dates = true` (a 7.2 default)**
- **Code:** `app/models/notebook.rb:40`.
- **Effect:** the activity report raises `TypeError: no implicit conversion of Date into String`. The probed `select_rows` DATE value changes from `"String"` to `"Date"`.
- **Repair:** `[day.to_date, count]`. Works on 7.0 and on both value types.
- **Validation:** "a notebook's notes are counted by UTC creation date, newest first" passes.

**D5. `active_support.cache_format_version = 7.1`**
- **Effect:** probed format 7.0 → 7.1. 7.0 processes cannot read 7.1 entries. The production cache is the default per-host file store, so the impact is limited to the `[export, "availability"]` fragments.
- **What to do:** adopt it only after no 7.0 process remains.

**D6. `active_support.message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true`**
- **Effect:** probed nil/nil → `:json_allow_marshal`/`true`. These change the session cookie format (`session[:user_id]` in `application_controller.rb:17`). 7.0 cannot read cookies written with metadata, so a rollback signs users out.
- **What to do:** adopt `use_message_serializer_for_metadata` only after rollback to 7.0 is no longer possible.

**D7. `action_text.sanitizer_vendor` and `action_view.sanitizer_vendor` = HTML5**
- **Effect:** the details/summary test passes under it.
- **What to do:** adopt.

**D8. `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `before_committed_on_all_records = true`, `run_after_transaction_callbacks_in_order_defined = true`**
- **Effect:** the app has no transaction callbacks, so nothing changes.

**D9. `belongs_to_required_validates_foreign_key = false`**
- **Effect:** skips the extra query on unchanged `notebook_id`. No behavior change seen.

**D10. Other 7.1 defaults with no effect here**
- **No effect on this app:**
  - `generate_secure_token_on = :initialize`: no `has_secure_token`.
  - `encryption.hash_digest_class = SHA256`: not used.
  - `marshalling_format_version = 7.1`: no records are Marshal-cached.
  - `sqlite3_adapter_strict_strings_by_default`: the app runs on PostgreSQL.
- **Cosmetic:** `query_log_tags_format`, `debug_exception_log_level`, `log_file_size`, and `default_headers` (drops `X-Download-Options`).
- **Checked:** `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters` and `dom_testing_default_html_version = :html5` were all checked, and all tests pass.

**7.2:**
- `postgresql_adapter_decode_dates`: covered in D4.
- `validate_migration_timestamps`: the migrations dated 2026-10-11 are not in the future.
- `active_storage.web_image_content_types` adds webp.
- `yjit`.
- No action needed beyond D4.

**8.0:**

**D11. `action_dispatch.strict_freshness = true`**
- **Code:** `app/controllers/export_downloads_controller.rb:11`.
- **Effect:** when the ETag matches but `If-Modified-Since` is older, the response is now 304. Probed `fresh?` changes from `false` to `true`. This is correct for a blob checksum ETag.
- **What to do:** adopt.

**D12. `Regexp.timeout = 1`**
- **Effect:** only simple regexes in the app (`citation.rb:9`). Low risk.

**8.1:**
- **`action_controller.action_on_path_relative_redirect = :raise`:** every redirect uses route helpers, so nothing changes.
- **`escape_json_responses = false`, `escape_js_separators_in_json = false`:** no `render json:`.
- **`raise_on_missing_required_finder_order_columns`:** every model has a primary key. Citation's is `doi`.
- **`action_view.render_tracker = :ruby`:** template digests may change once, which invalidates the export fragments one time.
- **`remove_hidden_field_autocomplete = true`:** hidden inputs lose `autocomplete="off"` (probed). Affected markup: slug and csv fields only.
- **Settings deprecated or removed within the range:**
  - `to_time_preserves_timezone`: deprecated in 8.1, so do not set it (R12).
  - Cache format 6.1: removed, but not used here.
  - `show_exceptions` booleans: no longer recognized (R19).

**Recommended sequence:** ship 8.1 with `load_defaults 7.0`. Then switch to `load_defaults 8.1`, but keep `config.active_support.cache_format_version = 7.0` and `use_message_serializer_for_metadata = false` until rollback to 7.0 is no longer possible, and drop those overrides afterwards.

---

## 3. Rollout, rollback and mixed-version risks

- **Database records:**
  - `notes.tags` stays JSON text and `notebooks.preferences` stays YAML, so both versions read them.
  - Any import applied on unrepaired 8.1 could leave partial rows. R16 prevents this; ship it first.
- **`db/schema.rb`:** the first dump on 8.1 changes the header to `ActiveRecord::Schema[8.1]` and sorts columns alphabetically. The probed `notes` columns become `annotation,citation_doi,created_at,import_id,…`. This is a cosmetic diff, but commit it with the bump so later migrations do not produce noisy diffs.
- **Redis cache and digest reservations:**
  - Under `load_defaults 7.0` the cache format stays 7.0 (probed), so both versions share fragments.
  - Adopting format 7.1 makes 7.0 readers miss. Defer it (D5).
  - The `digest_requests:*` sets are unchanged.
- **Cookies and sessions:** under `load_defaults 7.0` both versions write the same JSON encrypted cookies (probed: 176 bytes, the same format). Defer D6 until rollback to 7.0 is no longer possible.
- **Queued jobs:**
  - **DigestJob:** 8.1 payloads with BigDecimal break 7.0 workers. Deploy R18 on 7.0 first. The 8.1 TimeWithZone payload carries an extra `time_zone` key. A 7.0 worker reads it as UTC, and 8.1 with R17 does the same.
  - **NoteReminderJob:** jobs already scheduled keep their epoch-based timestamp.
  - **CitationEnrichmentJob:** the retry delay is computed when the job is retried, so any retry on 8.1 without R8 fails.
  - **ExportJob:** a native Sidekiq job, unaffected by Rails.
- **Ship on 7.0.8.7 first:** R2, R3, R5–R18, D2, D3 and D4. All of them passed the baseline suite.
- **Ship with the bump:** R1, R4, R19 and D1.

---

## 4. Verification log and open questions

**Executed in `upgrade-workspace`.** The setup run used the 7.0.8.7 baseline and 8.1.0 upgraded copies with isolated PostgreSQL databases (`up_167147_b_test`, `up_167147_u_test`) and Redis databases 4 and 5.

**Initial results:**
- **Baseline:** boot OK, 67 routes, 46 runs, 325 assertions, 0 failures.
- **Upgraded:** boot failed at `action_text.rb:3`, and the test runner exited with status 1.

**Iterative `upgrade-workspace test` runs on upgraded:**

| Step | Result |
|---|---|
| After R2 | 46 errors (`note.rb:10`, `note.rb:12`) |
| After R3, R4 | 11 failures, 35 errors (alias_attribute, routes, secrets) |
| After R5–R8, R19 | 4 failures, 40 errors (json) |
| After R1 | 3 failures, 12 errors |
| After R9–R15, R17 | 3 failures (import rollback, receipt, reminder offset) |
| After R12, R15, R16 | 0 failures, 340 assertions |
| `--defaults 8.1` | first 46 errors (D1), then 3 errors (D2, D3, D4), then 0 failures, 340 assertions |
| After R18 | 0 failures on both default sets |

**Repairs on baseline:** `test --target baseline` with every cross-version repair passed (46 runs, 325 assertions, 0 failures).

**Probes:**
- Three batched probe scripts: `/tmp/probes/p1.rb`, and `p2.rb` run with and without `--defaults 8.1`.
- `/tmp/probes/p3.rb` covers the import rollback with unequal rows, the receipt, the Auckland and UTC digest subjects, the schema column order, and the custom getter against the raw value.
- The observed values are quoted in each finding above.

**Resolved versions:** rails 8.1.0, json 2.7.2 (after the pin), rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.x.

**Logs:** these were under `/tmp/upgrade-rails-8.1.0/logs/` (`bundle-update.log`, `diag-*.log`, `schema-load-*.log`, `tests-baseline.log`, `tests-upgraded.log`, `tests-upgraded-defaults-8.1.log`). The cleanup step deleted them along with the workspace.

**Based on reading source, not executed:**
- `show?` handling of `false` (R19).
- The Sidekiq adapter deprecation (R20).
- 7.0's inability to read cache format 7.1 or cookies written with message metadata (D5, D6).
- The render-tracker digest change.

**Open questions:**
1. Is pinning json acceptable, or should we wait for a Rails 8.1.x patch that is compatible with json 3?
2. Production cache store: is it really the default file store, or does the deploy environment override it with Redis? That changes how much D5 matters.
3. Does the product want the digest on the reader's local day? 8.1 makes that the natural behavior. R17 keeps the documented UTC day.
4. Puma 5 is what holds Rack at 2.x. A Puma 6 or Rack 3 upgrade is a separate step and needs another look at the lowercase-header requirement in the test lambda.

---

**Where this stands:** this is a plan only. Nothing in your repo has changed and the working tree is still clean. The planner tried each fix in a separate throwaway copy, then deleted that copy and its logs.

To move ahead, first decide the open questions, especially the json pin (1) and whether the digest should use the reader's local day (3). Then I'd do it in two commits, as section 3 describes:
1. The fixes that work on both versions, deployed on 7.0.8.7.
2. The version bump, together with R1, R4, R19 and D1.

Should I start on the first commit?