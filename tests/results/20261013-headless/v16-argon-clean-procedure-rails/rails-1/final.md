# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

Rails 8.1.0 does not work for this app as it stands. The app cannot boot on 8.1 because of the Action Text initializer. Once that is fixed, the first test run had 28 failures and 17 errors. After 21 small repairs, the full suite passed on 8.1.0, both with the current `load_defaults 7.0` (46 runs, 340 assertions, 0 failures) and with `load_defaults 8.1`. 16 of the 21 repairs also passed the suite on 7.0.8.7, so they can ship before the gem bump. I worked only in `/tmp/upgrade-rails-8.1.0`, which I cleaned up afterwards. `git status` in the working checkout is clean.

`gem-changes` had no "framework defaults" section, so I took the defaults list from `railties-8.1.0/lib/rails/application/configuration.rb`. It also skipped the 7.0.10, 7.1.6 and later gem archives as corrupt cache files.

## 1. Required changes for the upgrade

**"Before bump: yes"** means the repair passed the full suite on 7.0.8.7, so it can ship first. Unless noted otherwise, **Validation** names the test in this app that fails on 8.1 without the repair and passes with it.

**R1. Boot failure in the Action Text initializer**
- **Affected code:** `config/initializers/action_text.rb:3`, `ActionText::ContentHelper.allowed_tags += %w[ details summary ]`
- **What breaks:** `NoMethodError: undefined method '+' for nil`. Boot, eager load and every test fail. Since 7.1, `allowed_tags` is nil until something sets it.
- **Applicability:** Introduced in 7.1. Breaks immediately on the bump. Before bump: yes.
- **Recommended repair:** Replace the file with:
  ```ruby
  Rails.application.config.after_initialize do
    ActiveSupport.on_load(:action_view) do
      helper = ActionText::ContentHelper
      defaults = helper.allowed_tags ||
        helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
      helper.allowed_tags = defaults + %w[ details summary ]
    end
  end
  ```
- **Validation:** Probe rendering `<details><summary>Book I</summary>Prelude <script>x()</script><b>bold</b></details>` gave the same output on 7.0, on 8.1, and on 8.1 with `load_defaults 8.1` (which uses the HTML5 sanitizer): `<details><summary>Book I</summary>Prelude x()<b>bold</b></details>`. So `details` is kept and `script` is still stripped.

**R2. `json` 3.1.0 is pulled in and breaks every JSON column read**
- **Affected code:** `Gemfile`. Activesupport 8.1 depends on `json >= 0`, and the bundle resolved `json 3.1.0`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291:in 'parse'`, called by `ActiveSupport::JSON.decode`. Every read of `notes.tags` or `notes.settings` fails, causing most of the 500s in the first test run.
- **Applicability:** Immediately on the bump. Before bump: yes (baseline locked `json 2.21.2` and passed).
- **Recommended repair:** Add `gem "json", "~> 2.7"` to `Gemfile`.
- **Validation:** The suite went from 28 failures and 17 errors to 19 failures and 6 errors once this pin was added.

**R3. Model declarations that raise when the class loads**
- **Affected code:**
  - `app/models/note.rb:10` `enum status: {...}, _prefix: true`
  - `app/models/note.rb:12` `serialize :tags, JSON`
  - `app/models/note.rb:14` `alias_attribute :highlight_color, :color`
- **What breaks:**
  - `enum`: `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at note.rb:10.
  - `serialize`: the positional coder was removed in 7.2.
  - `alias_attribute`: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'`. `color` comes from `store_accessor`, not a column.
- **Applicability:** Immediately on the bump.
- **Recommended repair:**
  - `enum :status, { draft: 0, ready: 1 }, prefix: true` (before bump: yes)
  - `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=` (before bump: yes)
  - `serialize :tags, coder: JSON` (7.1+ only, so ship it with the bump)
- **Validation:** `notes_controller_test.rb:114,154-160` (the radio buttons `highlight_color=yellow` and `blue` are checked after save) and the status filters pass.

**R4. A route with two paths is rejected**
- **Affected code:** `config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2)` when routes are drawn (removed in 8.1).
- **Recommended repair:** Use two lines, `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. Before bump: yes.
- **Validation:** The route list on 8.1 contains both `GET /notes` and `GET /journal`, and the test "lists the reader's notes newest first at both list paths" passes.

**R5. `Rails.application.secrets` was removed (7.2)**
- **Affected code:**
  - `app/models/citation/provider.rb:13`
  - `config/secrets.yml`
  - `test/controllers/citation_enrichments_controller_test.rb:45,117-122`
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Every citation lookup fails.
- **Recommended repair:**
  - Move `config/secrets.yml` to `config/citation_provider.yml`, with the `url`, `user` and `password` keys directly under each environment.
  - Add `config.x.citation_provider = config_for(:citation_provider)` in `config/application.rb`.
  - In the provider, use `settings = Rails.configuration.x.citation_provider.to_h`.
  - In the test, use `Rails.configuration.x.citation_provider` in both places.
  - Update `ARCHITECTURE.md:79-80` and `CONTRIBUTING.md:38`.
  - Before bump: yes.
- **Validation:** All 4 citation tests pass, including the fresh `bin/rails runner` boot with `CITATION_PROVIDER_USER=00123` and password `"sample: value # keep"`, which arrive unchanged.

**R6. Markdown exports crash on `Enumerable#sum` of strings**
- **Affected code:** `app/models/export.rb:42` `finish(fragments.sum)`
- **What breaks:** `TypeError: String can't be coerced into Integer`. Every export job fails. Rails 7.1 removed the `Enumerable#sum` override; 7.0 already printed a deprecation warning for this line.
- **Recommended repair:** `finish(fragments.join)`. Before bump: yes.
- **Validation:** The export tests download the Markdown file; previously 3 of them raised this error.

**R7. Scheduling a reminder with an Integer `wait_until`**
- **Affected code:** `app/models/note.rb:61` `NoteReminderJob.set(wait_until: reminder_epoch)`
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Both `RemindersController#create` paths return 500.
- **Recommended repair:** `set(wait_until: Time.at(reminder_epoch))`. Before bump: yes.
- **Validation:** Probe with the real Sidekiq adapter and epoch 1793451600:
  - 8.1 with an Integer raised the error above.
  - With `Time.at`, both versions scheduled the job at `2026-10-31 13:00:00 UTC` in `Sidekiq::ScheduledSet`.

**R8. `retry_on ... wait: :exponentially_longer` was removed**
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. This is raised at enqueue time, inside `Citation#request_enrichment`'s lock, so the request returns 500.
- **Recommended repair:** `wait: :polynomially_longer`. This needs 7.1+, so ship it with the bump. (A lambda `->(n) { n**4 + 2 }` would work on both versions but changes the jitter.)
- **Validation:** citation_enrichments_controller_test.rb:60 passes.

**R9. `Import#apply` now commits partial imports (behaviour change, silent)**
- **Affected code:** `app/models/import.rb:53-60`, `return false unless row.note.save` inside `transaction`
- **What breaks:** On 7.0, an early `return` rolled the transaction back. On 7.2+, it commits. With one valid row and one invalid row, the import and the valid note are saved: `record_counts` changed from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`.
- **Recommended repair:** Before bump: yes.
  ```ruby
  transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end || false
  ```
- **Validation:**
  - Failing case: imports_controller_test.rb:48, with "Adam Bede" valid and line 3 invalid; no records may change.
  - Control: imports_controller_test.rb:6, where 2 valid rows create 2 notes, 1 citation and 1 import.

**R10. The import receipt CSV loses its DOIs**
- **Affected code:** `app/models/import.rb:68`, `citation && citation[:id]`. Citation's primary key is `doi`.
- **What breaks:** The receipt changes from `On idleness,10.1000/Essays.1` to `On idleness,`.
- **Recommended repair:** `citation&.doi`. Before bump: yes.
- **Validation:** The exact receipt body in imports_controller_test.rb:45.

**R11. Import preview hides annotations**
- **Affected code:** `app/views/imports/preview.html.erb:22`, `@import.annotations.stringify_keys`
- **What breaks:** On 8.1, `stringify_keys` turns the Integer line keys into `"2"`, so `annotations[2]` is nil. Probe: keys `[2]` → `["2"]`. Annotations disappear from the preview.
- **Recommended repair:** `<% annotations = @import.annotations %>`. Before bump: yes.
- **Validation:** Assertions `#line_2 dd` = "Read <b>twice</b> & reflect" and `#line_3 dd` = "Second reading".

**R12. The notes index raises on `form_with(model: nil)`**
- **Affected code:** `app/views/notes/index.html.erb:12`
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. Every note list and the post-sign-in page return 500.
- **Recommended repair:** Drop `model: nil`. Before bump: yes.

**R13. The notebook filter generates invalid SQL**
- **Affected code:** `app/controllers/notes_controller.rb:12`, `@notes.where(notebooks: @notebook)`
- **What breaks:** `PG::UndefinedColumn: column notes.notebooks does not exist`.
- **Recommended repair:** `where(notebook: @notebook)`. Before bump: yes.

**R14. Next-day reminder time shifts across the end of daylight saving time**
- **Affected code:** `app/models/note.rb:44`, `reminder_at.to_time + 86_400`
- **What breaks:** In 8.x, `to_time` keeps the zone (and warns that `to_time_preserves_timezone` is deprecated). Probe for a 2026-10-31 09:00 Eastern reminder:
  - 7.0 gives `2026-11-01 09:00:00 -0400`.
  - 8.1 gives `2026-11-01 08:00:00 -0500`.
- **Recommended repair:** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. This gave `-0400` on both versions. Before bump: yes.
- **Validation:** reminders_controller_test.rb:21 expects `datetime="2026-11-01T09:00:00-04:00"`.

**R15. The daily digest covers the wrong day (Active Job TimeWithZone serializer, 7.1)**
- **Affected code:**
  - `app/models/user.rb:41`
  - `app/mailers/digest_mailer.rb:7-9`
- **What breaks:** Jobs now keep the reader's zone, so for a reader in Eastern time the subject changes from "Your reading digest for October 05, 2026" to "...October 04, 2026", and the note window shifts.
- **Recommended repair:** Before bump: yes.
  - In the mailer, add `requested_at = requested_at.in_time_zone("UTC")` after reading params.
  - In `user.rb`, enqueue `reading_completion.to_s` (see section 3).
- **Validation:**
  - Failing case: digests_controller_test.rb:5.
  - Control: the 7.0-format payload (no `time_zone` key) still deserializes to `2026-10-05 03:30 UTC`.

**R16. Test environment: `show_exceptions = false` no longer raises**
- **Affected code:** `config/environments/test.rb:31`
- **What breaks:** On 8.1 the exceptions are rescued and rendered instead of raised. Six "RecordNotFound expected but nothing was raised" assertions and the `Redis::CannotConnectError` assertion fail.
- **Recommended repair:** `config.action_dispatch.show_exceptions = :none`. This is 7.1+ only, so ship it with the bump: on 7.0 the symbol counts as true and the error pages would be rendered.

## 2. New configuration defaults (7.1 to 8.1)

The app keeps every default below at its old value through `load_defaults 7.0`; it sets none of them explicitly in `config/`. I ran the suite with all repairs above plus `load_defaults 8.1`: three more failures appeared, which D1 to D3 fix. Afterwards: 46 runs, 0 failures.

**Defaults that need repairs**

- **D1. `active_record.default_column_serializer = nil` (7.1)**
  - What changes: `app/models/notebook.rb:7` `serialize :preferences` raises `ArgumentError: missing keyword: :coder`.
  - Repair: `serialize :preferences, coder: YAML` (7.1+, ship with the bump). The stored YAML stays readable.
- **D2. `active_record.raise_on_assign_to_attr_readonly = true` (7.1)**
  - What changes: `NotebooksController#update` (line 26, with params from line 40 `permit(:name, :slug, :export_heading)`) raises `ActiveRecord::ReadonlyAttributeError: slug`.
  - Repair: `permit(:name, :export_heading)`. Before bump: yes. The slug always comes from `assign_slug` anyway.
  - Validation: notebooks_controller_test.rb:22 (slug stays "novels" while the name changes); the create test is the control.
- **D3. `active_support.raise_on_invalid_cache_expiration_time = true` (7.1)**
  - What changes: `app/views/exports/_export.html.erb:26` raises `Cache expiration time is invalid, cannot be negative: -60.0` for an expired export.
  - Repair: `expires_in: (export.expires_at - Time.current if export.downloadable?)`. Before bump: yes.
  - Validation: exports_controller_test.rb:59 (uses MemoryStore and a deadline 1 minute in the past).
- **D4. `active_record.postgresql_adapter_decode_dates = true` (7.2)**
  - What changes: `app/models/notebook.rb:40` `Date.iso8601(day)` raises `TypeError: no implicit conversion of Date into String`.
  - Repair: `[day.to_date, count]`. Before bump: yes.

**Defaults that change behaviour but need no code change**

- **`active_support.cache_format_version = 7.1` (7.1)**
  - In production the cache is the default file store. Rails 7.0 cannot read 7.1-format entries; see section 3.
  - Adopt it only after the rollout is complete.
- **`active_support.message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true` (7.1)**
  - These change the envelope for the session cookie, Active Storage signed ids and other MessageVerifier output.
  - Per the upgrade guide, enable them only once no 7.0 process remains. I did not verify this (my cookie probe could not read cookies back).
- **`action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` set to HTML5 (7.1)**
  - Verified with R1's fix: the output is identical.
- **`run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false` (7.1)**
  - The app has no commit callbacks, so nothing changes.
- **`belongs_to_required_validates_foreign_key = false` (7.1)**
  - No effect, because the notebook is reassigned on every save.
- **Other 7.1 defaults with no effect here:**
  - `generate_secure_token_on`
  - the encryption digest settings
  - `marshalling_format_version`
  - `query_log_tags_format`
  - `sqlite3` strict strings
- **`action_dispatch.default_headers` (7.1)**
  - Drops `X-Download-Options`.
- **Test and load-path defaults (7.1)**
  - `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `dom_testing_default_html_version = :html5`, `log_file_size`: tests pass.
- **`yjit` (7.2, changed again in 8.1 to off in dev/test)**
  - No code impact.
- **`active_storage.web_image_content_types` adds webp (7.2)**
  - Uploaded webp images become variable/inline.
- **`active_record.validate_migration_timestamps` (7.2)**
  - Existing migrations are dated 2026-10-11, so they are fine.
- **`action_dispatch.strict_freshness = true` (8.0)**
  - `ExportDownloadsController#show` calls `stale?(etag:, last_modified:)`. With this default, a matching `If-None-Match` returns 304 even if `If-Modified-Since` is older.
  - This is harmless because the blob checksum is the ETag. Based on source reading, not probed.
- **`Regexp.timeout = 1` (8.0)**
  - The CSV and DOI regexes are simple.
- **8.1 defaults:**
  - `escape_json_responses = false`: the app has no `render json:` and no Jbuilder views.
  - `action_on_path_relative_redirect = :raise`: all redirects use route helpers or `"/notes"`.
  - `raise_on_missing_required_finder_order_columns`: every model has a primary key.
  - `escape_js_separators_in_json = false`.
  - `render_tracker = :ruby`: may change template digests, which causes one round of fragment cache misses.
  - `remove_hidden_field_autocomplete`: affects the hidden `import[csv]` field.
- **`active_support.to_time_preserves_timezone` (deprecated in 8.0, setting deprecated in 8.1)**
  - `load_defaults 7.0` sets it, which prints a deprecation warning on 8.1. R14 makes the code independent of it.
  - Moving to `load_defaults 8.0` or later removes the warning.

## 3. Rollout, rollback and mixed-version risks

- **Queued Active Job payloads (Sidekiq 6.5.12 in Redis)**
  - An 8.1 process serializes BigDecimal as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`, even with `load_defaults 7.0`.
  - A 7.0 worker given that payload raises `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`, which loses the `DigestJob`.
  - Fix: deploy `DigestJob.perform_later(self, requested_at, reading_completion.to_s)` on 7.0 first. `DigestMailer` already calls `BigDecimal(...)`.
  - TimeWithZone payloads from 8.1 carry an extra `time_zone` key, which 7.0 ignores and deserializes in UTC. Payloads from 7.0 deserialize in UTC on 8.1. With R15, both produce the same digest.
  - `ExportJob` is a native Sidekiq job and `NoteReminderJob` and `CitationEnrichmentJob` use GlobalID, so neither is affected.
  - Rails 8.1 warns that the built-in `sidekiq` adapter is deprecated, to be removed in 8.2, and asks for sidekiq 7.3.3 or later. That is a follow-up, not a blocker.
- **Cache entries (file store `tmp/cache` in production; Memory or Null store elsewhere)**
  - With 7.0 format on both sides, entries are readable in both directions.
  - Entries written in 7.1 format make 7.0 raise `TypeError: incompatible marshal file format (can't be read) format version 4.8 required; 17.1 given`.
  - Keep `load_defaults 7.0` (or set `config.active_support.cache_format_version = 7.0`) until no rollback is possible.
- **Cookies and session**
  - With 7.0 defaults, the cookie serializer stays `:json` and the key derivation stays SHA256, so I expect no change. This is not proven by a probe.
  - Do not adopt the 7.1 message serializer defaults until rollback to 7.0 is no longer needed.
- **`db/schema.rb`**
  - The next dump on 8.1 rewrites the header to `ActiveRecord::Schema[8.1]`, turns `plpgsql` into `pg_catalog.plpgsql`, and sorts columns alphabetically. The table structure is the same.
  - A 7.0 rollback cannot load a `Schema[8.1]` file. Keep the 7.0 dump until the upgrade is final.
- **Stored records**
  - YAML `preferences`, JSON `tags` and the `settings` jsonb are read unchanged; the notebook and note tests pass.
  - R9 matters for data integrity. While a 7.2+ process runs without the fix, a mixed-validity import leaves orphan imports and notes.
- **Can ship on 7.0.8.7 first**
  - R1, the R2 json pin, R3 (`enum` and `alias_method`), R4, R5, R6, R7, R9 to R15, D2, D3, D4, and `reading_completion.to_s`.
  - The full suite passed on 7.0.8.7 with all of these applied (46 runs, 325 assertions, 0 failures).
- **Must ship with the bump**
  - `serialize ... coder:` (R3, D1), `:polynomially_longer` (R8), `show_exceptions = :none` (R16).

## 4. Verification log and open questions

**Workspace**
- Databases: `up_200374_b_test` and `up_200374_u_test`. Redis: databases 4 and 5.
- Logs were in `/tmp/upgrade-rails-8.1.0/logs/`: `bundle-update.log`, `diag-*.log`, `tests-baseline.log`, `tests-upgraded.log`, `tests-upgraded-defaults-8.1.log`. They were deleted by `cleanup`.

**Resolved upgraded lockfile**
- Upgraded to rails/railties/all components 8.1.0.
- Unchanged: rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, faraday 1.10.4, pagy 8.6.3, pg 1.6.0, turbo-rails 2.0.12, importmap-rails 2.2.3, jbuilder 2.15.1, minitest 5.27.0.
- Added: rack-session 1.0.2, rackup 1.0.1, bigdecimal 4.1.3, json 3.1.0 (pinned down to 2.21.2 by R2).
- Removed: method_source.
- Rack stays on 2.x, so the Rack 3 items in `gem-changes` do not apply.

**Executed in the workspace**

| Run | Result |
|---|---|
| `setup`, baseline 7.0 | boot OK, 46 runs, 0 failures |
| `setup`, upgraded 8.1 | boot failed (R1) |
| `test` after each fix round | 28F/17E → 19F/6E → 3F/11E → 3F/0E → 0/0 |
| `test --defaults 8.1` | 46 errors (D1) → 0F/3E (D2 to D4) → 0/0 |
| `test --target baseline` with the fixes that work on 7.0 | 0/0 |

Probes:
- `to_time` across the end of daylight saving time
- HashWithIndifferentAccess `stringify_keys`
- job serialization, including deserializing payloads from the other version
- the Sidekiq scheduled set
- the cache file store in both directions
- Action Text sanitizing
- schema dump diff

**Based on reading source or docs only**
- The strict-freshness edge case.
- The cookie and message-serializer compatibility (my cookie probe could not read cookies back, so it is inconclusive).
- That none of the 8.1 defaults (JSON escaping, path-relative redirects, finder order columns) apply here.

**Still proposed, not run**
- A browser system test of the `details` and `summary` editing round-trip.
- A staging rollout check that a 7.0 worker drains an 8.1-enqueued `DigestJob` after the `.to_s` change.
- Moving to sidekiq 7.3.3 or later before Rails 8.2.

**Open questions**
- Is production configured with a Redis cache store outside this repo? If so, the cache-format advice applies to Redis too.
- Should the next-day reminder (R14) keep the fixed-offset behaviour or change to the reader's wall-clock time? I kept the current documented behaviour.

---

**Note:** The plan above came from a planning agent that tested everything in a throwaway copy of the repo. I haven't changed anything in your working copy yet, and `main` is still clean.

Rails is currently locked at **7.0.8.7**, so this is a jump across four minor versions, not a small patch. My suggestion is to do it in two steps:
1. **On Rails 7.0, in one commit:** the 16 fixes that also work on 7.0, plus the `json` pin and enqueuing `reading_completion.to_s`.
2. **A second commit:** the gem bump, together with the fixes that only work on 7.1 and later (`serialize ... coder:`, `:polynomially_longer`, `show_exceptions = :none`). Keep `load_defaults 7.0` until there's no chance of rolling back.

Two questions before I start:
- **Two steps or one?** Should I go ahead with the two-step approach, or would you rather have it all in one change?
- **Reminder timing (R14):** Across a daylight-saving change, should the next-day reminder keep its current fixed-offset time, or follow the reader's local clock time?