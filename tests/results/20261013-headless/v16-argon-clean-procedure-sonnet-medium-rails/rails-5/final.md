# Upgrade plan: rails 7.0.8.7 to 8.1.0, Margin Notes

Nothing was implemented, and the working tree is clean. The planner's full plan follows, unedited.

**Summary.** The bump breaks boot and 13 further code paths. Six of those are silent behaviour or data errors that the test suite would not have caught without the repairs below. All repairs together bring `upgraded` to 46 runs, 340 assertions, 0 failures, with `load_defaults 7.0` and with 7.1, 7.2, 8.0 and 8.1. Three more repairs are needed only when `load_defaults` is raised.

Notation: "WS" means observed in `upgrade-workspace`. "Source" means concluded from reading code. Test and probe results are WS unless marked otherwise.

## 1. Required changes for the upgrade

Resolved versions from the `Gemfile.lock` diff:
- Rails components and railties go 7.0.8.7 to 8.1.0.
- `net-imap` goes 0.6.7 to 0.6.8, and `method_source` is removed.
- Added: `action_text-trix 2.1.19`, `bigdecimal 4.1.3`, `drb 2.2.3`, `json 3.1.0`, `rack-session 1.0.2`, `rackup 1.0.1`, `securerandom 0.4.1`, `uri 1.1.2`, `useragent 0.16.11`, `webrick 1.9.2`.

**Dependency findings**
- **Rack stays at 2.2.24.** `sidekiq 6.5.12` requires `rack ~> 2.0`, and `rack-session` and `rackup` are `< 3`.
  - The Rack 3 items from `gem-changes` (lowercase headers, mutable arrays, `Rack::Request#values_at`, the CVE notes) do not apply while Sidekiq 6.5 is pinned.
  - The app has no custom middleware. `rack`, `puma 5.6.9`, `sidekiq 6.5.12`, `redis 4.8.1` and `faraday 1.10.4` are unchanged in the lock.
- `method_source`, `mini_mime` and the `net-*` gems are no longer Rails runtime dependencies. The app does not reference them directly, and nothing broke.

### R1. `json 3.1.0` breaks every JSON column read
- **Affected code:** `Gemfile`, where no `json` constraint exists. `activesupport-8.1.0` has an unbounded `json` dependency, so Bundler resolved `json 3.1.0`. The failing path includes `app/models/note.rb:12` (`tags`) and the `settings` jsonb column.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291`, called from `ActiveSupport::JSON.decode` (activesupport 8.1.0 passes an options hash positionally). It surfaced as 46 test errors.
- **Applicability:** Immediately on the bump, whenever the resolver picks json 3.x. A pre-bump pin works on 7.0.8.7.
- **Repair:** Add `gem "json", "< 3"` to `Gemfile`. It resolved to `json 2.7.2`. Drop the pin once an activesupport release that supports json 3 is adopted.
- **Validation:** Before the pin, `Note.find(...).tags` raises on `upgraded`. After it, the suite runs to completion. Control: baseline is unchanged.

### R2. `config/initializers/action_text.rb:3`
- **What breaks:** `NoMethodError: undefined method '+' for nil`. `ActionText::ContentHelper.allowed_tags` is nil by default in 8.1, so the app does not boot.
- **Applicability:** Immediately on the bump. The repair also works on 7.0.8.7, where it passes the full suite.
- **Repair:**
```ruby
ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a +
  [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
```
- **Validation:** A probe sanitized `<details><summary>…`, an `onclick` handler, `<script>` and a `javascript:` link, and `<action-text-attachment>`. Baseline and upgraded gave identical output:
  - `details`, `summary`, `figure`, `figcaption` and the attachment tag are kept.
  - `onclick` and the `javascript:` href are stripped.
  - `<script>` is removed (its text stays).
  - The allowed-tag count is 48 on both versions.

### R3. `app/models/note.rb:10`, `enum status: {...}, _prefix: true`
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when `Note` loads.
- **Applicability:** Removed in 8.0. The repair works on 7.0.8.7.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Validation:** `status_ready` scopes and `Note.statuses` work. The notes index filter and digest tests pass.

### R4. `app/models/note.rb:12`, `serialize :tags, JSON`
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Applicability:** Removed in 7.2. This repair does not work on 7.0.8.7: `coder: JSON` caused `undefined method 'any?' for an instance of String` in `notes/_tags.html.erb:1`. Apply it in the bump commit.
- **Repair:** `serialize :tags, coder: JSON`
- **Validation:** The raw column is `["b","a","é"]` on both versions. Reading `'["b","a","é"]'` and the default `'[]'` returns the same arrays.

### R5. `app/models/note.rb:14`, `alias_attribute :highlight_color, :color`
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` It was raised from `Import#build_row` (`app/models/import.rb:105`). `color` is a `store_accessor`, not a column.
- **Applicability:** Removed in 7.2. The repair works on 7.0.8.7.
- **Repair:**
```ruby
alias_method :highlight_color, :color
alias_method :highlight_color=, :color=
```
- **Behaviour change:** Dirty-tracking helpers such as `highlight_color_changed?` no longer exist. Nothing in the app calls them.
- **Validation:** The note create and update tests pass: `highlight_color: "green"`, the `"blue"` update, and the radio buttons in `notes/_form.html.erb:31-37`. `Note.new(highlight_color: "pink")` stores `{"color": "pink"}` raw.

### R6. `config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2)`, so no routes draw.
- **Applicability:** Works on 7.0.8.7.
- **Repair:**
```ruby
get "/notes", to: "notes#index"
get "/journal", to: "notes#index"
```
- **Validation:** A probe showed the same route names on both versions: `notes` for `/notes(.:format)` and `journal` for `/journal(.:format)`.
  - App routes are identical: 67 on baseline versus 63 on upgraded.
  - The four routes only in baseline are framework `rails/conductor/action_mailbox/inbound_emails` routes (edit, update, destroy).

### R7. `Rails.application.secrets` removed
- **Affected code:** `app/models/citation/provider.rb:13`, and `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Citation enrichment has no provider settings.
- **Applicability:** Works on 7.0.8.7.
- **Repair:**
  - In `config/application.rb`, add `config.x.citation_provider = config_for(:secrets).citation_provider`.
  - In `Provider#initialize` and the tests, use `Rails.configuration.x.citation_provider` in place of `Rails.application.secrets.citation_provider`.
- **Validation:** The credentials-reach-server test and the retry test pass.

### R8. `app/jobs/citation_enrichment_job.rb:7`, `wait: :exponentially_longer`
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised from `Citation#request_enrichment` (`app/models/citation.rb:20`) when the provider is unavailable.
- **Applicability:** Removed in 8.0. `:polynomially_longer` does not exist on 7.0.8.7, so this repair cannot ship before the bump.
- **Repair:** `wait: :polynomially_longer`
- **Validation:** The unavailable-provider test passes.

### R9. `app/models/note.rb:61`, `wait_until: reminder_epoch`
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. No reminder can be scheduled or postponed.
- **Applicability:** Works on 7.0.8.7.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch)).perform_later(self)`
- **Validation:** The reminder test asserts the job's `:at` equals `Time.utc(2026,10,31,13).to_i`.

### R10. `app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)`
- **What breaks:** `ArgumentError: Passed nil to the :model argument, expect an object or false`. The main notes index returns 500.
- **Applicability:** Works on 7.0.8.7.
- **Repair:** `model: false`
- **Validation:** The test for `form[role=search][action="/notes"][method=get]` passes.

### R11. `app/controllers/notes_controller.rb:12`, `where(notebooks: @notebook)`
- **What breaks:** `PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering by notebook fails.
- **Applicability:** Works on 7.0.8.7.
- **Repair:** `where(notebook: @notebook)`
- **Validation:** Filtering by notebook, status and title returns the expected rows. Paging newest first returns Reading 08 down to 04.

### R12. `app/models/export.rb:42`, `fragments.sum`
- **What breaks:** `TypeError: String can't be coerced into Integer` in `Export#generate`. Every export job fails.
- **Applicability:** Works on 7.0.8.7.
- **Repair:** `finish(fragments.join)`
- **Validation:** Export and download tests pass. The array always starts with the heading string, so `join` equals the old `sum`.

### R13. `app/views/imports/preview.html.erb:22` (silent)
- **Cause:** `@import.annotations.stringify_keys`, where `Import#annotations` is a `HashWithIndifferentAccess` with Integer line keys (`app/models/import.rb:39-40`).
- **What changes:** Probe with `h[2] = "x"`:
  - baseline `h.stringify_keys[2]` returns `"x"` and keys stay `[2, "3"]`.
  - upgraded returns `nil` and keys become `["2","3"]`.
  - The preview page loses every Annotation `<dd>`. The test saw the DOI instead of "Read <b>twice</b> & reflect".
- **Applicability:** Immediately. The repair works on 7.0.8.7.
- **Repair:** `<% annotations = @import.annotations %>`. `h[2]` works on both versions.
- **Validation:** The `#line_2 dd` and `#line_3 dd` assertions pass.

### R14. `app/models/import.rb:68`, `citation && citation[:id]` (silent)
- **What changes:** `citation[:id]` returns nil for a model whose primary key is `doi`. The receipt CSV is `On idleness,` instead of `On idleness,10.1000/Essays.1`.
- **Applicability:** Immediately. The repair works on 7.0.8.7.
- **Repair:** `citation&.doi`
- **Validation:** The receipt body equals `"title,doi\nOn idleness,10.1000/Essays.1\nOf experience,10.1000/Essays.1\n"`.

### R15. `app/models/import.rb:53-57`, `return false` inside `transaction` (silent data corruption)
- **What changes:** Applying the invalid-row CSV (valid row 2, invalid row 3) committed. `record_counts` went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. The test expects no change, so the Import, the first Note and a Citation persisted on 8.1.0. A non-local return now commits.
- **Applicability:** Changed in 7.1 and takes effect immediately. The repair works on 7.0.8.7.
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
- **Validation:** Before, the counts change. After, they stay `[0,3,0,1]` and the response is 422. Control: the valid two-row import still commits, creating 2 Notes, 1 Citation and 1 Import. The other `with_lock` blocks (`export.rb`, `note.rb`, `citation.rb`) contain no `return`.

### R16. `app/models/note.rb:44`, `reminder_at.to_time + 86_400` (silent)
- **What changes:** `to_time` now keeps the zone instead of a fixed offset. For an Eastern reminder at 2026-10-31T09:00-04:00 the next-day preview is `2026-11-01T08:00:00-05:00` rather than `2026-11-01T09:00:00-04:00`. The instant is the same; the displayed offset and the `l ... :reminder` text change. This is the `to_time_preserves_timezone` change, which also prints a deprecation warning under `load_defaults 7.0`.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`. It works on 7.0.8.7.
- **Validation (probe):** Before, upgraded gives 08:00-05:00. After, upgraded and baseline both give 09:00-04:00. Controls on both versions: July 2026 Eastern gives 09:00-04:00 and Kolkata gives 18:30+05:30, with no change.

### R17. `app/mailers/digest_mailer.rb:7-9`, digest day (silent)
- **What changes:** The `TimeWithZone` job argument is now deserialized in its original zone, so `requested_at` stays Eastern.
  - The subject became "Your reading digest for October 04, 2026" instead of "October 05, 2026".
  - `all_day` selected the Eastern day rather than the UTC day the code documents.
- **Applicability:** Immediately. The repair works on 7.0.8.7.
- **Repair:** Add `requested_at = requested_at.in_time_zone(Time.zone)` before `@date = requested_at.to_date`.
- **Validation:** The digest test (Eastern reader, request at 03:30 UTC on 5 Oct) expects October 05 and "Bacon on studies" only. Montaigne, updated 16:00 UTC on 4 Oct, is excluded. The test passes with the repair.

### R18. `app/models/user.rb:41`, BigDecimal job argument (rollback hazard)
- **What changes:** `reading_completion` (BigDecimal) is now serialized as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. On 7.0.8.7 it was the plain string `"0.5"`.
- **Applicability:** A 7.0.8.7 worker given this payload raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. A pre-bump repair is safe.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. `BigDecimal#to_s` gives "0.5", "0.3333" and "0.0" on both versions, and `BigDecimal("0.5") == BigDecimal(str)`.
- **Validation:** With `ActiveJob` on the Sidekiq adapter, `request_digest` queues `"0.5"` on both versions. Old-format and new-format payloads then execute on both versions.

### R19. `config/environments/test.rb:31`, `show_exceptions = false`
- **What breaks:** Tests only. In 8.1 `false` no longer re-raises. Four tests failed with "ActiveRecord::RecordNotFound expected but nothing was raised".
- **Applicability:** `:none` is truthy on 7.0.8.7, so this repair cannot ship before the bump.
- **Repair:** `config.action_dispatch.show_exceptions = :none`

## 2. New configuration defaults across intermediate releases

The app sets `load_defaults 7.0` in `config/application.rb:12`, so none of the defaults below are active. Explicit settings in `config/`:
- `cache_classes`, `eager_load`, `cache_store` (test only, `:null_store`), `show_exceptions` (test only), and `i18n.fallbacks`.
- `report_deprecations = false` and `log_formatter` (production), and the Active Job queue adapter (`:sidekiq`, and `:test` in the test env).
- None of these set any default listed below.

WS result: with `load_defaults` 7.1, 7.2, 8.0 and 8.1, boot, eager load and routes are OK and all 46 tests pass, but only after the repairs in R1 to R19 and D1 to D3. Before D1 to D3, 8.1 gave 3 errors.

Every default below is "not adopted; old value kept".

**7.1 defaults**

| Setting | App impact if adopted | What to configure |
|---|---|---|
| `active_record.raise_on_assign_to_attr_readonly = true` | **D1.** `ActiveRecord::ReadonlyAttributeError: slug` at `notebooks_controller.rb:26`, because `notebook_params` (line 40) permits `:slug` and the edit form resubmits it. | Change to `permit(:name, :export_heading)`. This also works on 7.0.8.7. Test: patching `slug: "renamed"` leaves `slug == "novels"`, and `name` and `export_heading` still update. |
| `active_support.raise_on_invalid_cache_expiration_time = true` | **D2.** `ArgumentError: Cache expiration time is invalid, cannot be negative: -60.0` in `exports/_export.html.erb:26`. A negative TTL occurs after an export expires. | `expires_in: [export.expires_at - Time.current, 0].max`. It passes on both versions and keeps the "cached indicator does not authorize a download" test green. |
| `active_record.default_column_serializer = nil` | **D4.** `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'` at `notebook.rb:7`. Without 7.1 defaults, `serialize :preferences` still works. | `serialize :preferences, coder: YAML`. Raw YAML is identical and the legacy rows read. |
| `cache_format_version = 7.1` | Baseline got `TypeError` reading an entry written with this default. | Adopt after rollout is complete. |
| `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | A signed or encrypted message written under 8.1 defaults failed to verify on 7.0.8.7 (`NoMethodError`). Cookies, `signed_id` and Active Storage URLs are affected. | Adopt after rollout is complete. |
| `active_record.encryption.hash_digest_class`, `support_sha1_for_non_deterministic_encryption` | No effect (source). The app has no `encrypts`. | None. |
| `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `generate_secure_token_on` | No effect. There are no commit callbacks and no `has_secure_token`. | None. |
| `belongs_to_required_validates_foreign_key = false` | Skips a validation query. No test failed. | None. |
| `action_dispatch.default_headers`, `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `dom_testing_default_html_version = :html5` | No effect, and the suite passes. | None. |
| `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` | Rich-text whitespace differs. `<div>\n<details>` becomes `<div><details>`. The allowed tags and attributes were identical. | None. |
| `active_record.query_log_tags_format`, `marshalling_format_version = 7.1` | Source only. | None. |

**7.2 defaults**

| Setting | App impact if adopted | What to configure |
|---|---|---|
| `postgresql_adapter_decode_dates = true` | **D3.** `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`, because `select_rows` now returns `Date`. | `Date.iso8601(day.to_s)`. It works on both versions. Test: `daily_note_counts` returns Dates in UTC, newest first. |
| `validate_migration_timestamps`, `yjit`, `active_storage.web_image_content_types` | No effect (source). Migration timestamps are 2026-10-11. | None. |

**8.0 defaults**

| Setting | App impact if adopted | What to configure |
|---|---|---|
| `action_dispatch.strict_freshness = true` | No effect (source). `ExportDownloadsController#show` uses `stale?` with an etag and last-modified. | None. |
| `Regexp.timeout = 1` | No effect (source). | None. |

**8.1 defaults**

| Setting | App impact if adopted | What to configure |
|---|---|---|
| `action_controller.escape_json_responses = false`, `action_on_path_relative_redirect = :raise` | None. The app has no `render json:`, and every `redirect_to` uses a named path or a `/notes` absolute path. | None. |
| `active_record.raise_on_missing_required_finder_order_columns` | None. Every model has a primary key. | None. |
| `active_support.escape_js_separators_in_json`, `action_view.render_tracker = :ruby`, `remove_hidden_field_autocomplete` | None. | None. |

**Deprecated in range.** `config.active_support.to_time_preserves_timezone` (set by `load_defaults 7.0`) is deprecated. WS output: "will be removed in Rails 8.2". R16 removes the dependency on it. Other items:
- `show_exceptions = true/false` was deprecated in 7.1; see R19.
- Positional `serialize` and the `enum` keyword syntax were removed in 8.0.
- `ActiveSupport::Deprecation` as a singleton: no app use (source).

## 3. Rollout, rollback and mixed-version risks

- **`db/schema.rb`:** The workspace dump differs only cosmetically. The header changes `Schema[7.0]` to `Schema[8.1]`, `plpgsql` becomes `pg_catalog.plpgsql`, and columns are sorted alphabetically.
  - All 12 migrations replayed on an empty 8.1.0 database produced a schema identical to the workspace dump.
  - There are no schema changes. Production sets `dump_schema_after_migration = false`.
- **Stored records:** Raw `preferences` (YAML), `tags` (JSON text) and `settings` (jsonb) text is identical on both versions, and legacy rows read. This holds only with the preferences coder left as-is (see D4).
  - The Action Text and Active Storage tables are unchanged.
  - Rows are readable both ways, so rollback needs no data fix.
- **Redis cache:** Production uses the default `FileStore` (`tmp/cache`); this is not set in config.
  - Under `load_defaults 7.0`, entries written by 7.0.8.7 are read by 8.1.0 and vice versa. Hash, Time, BigDecimal and SafeBuffer entries round-tripped.
  - Under 8.1 defaults, baseline raised `TypeError` on an 8.1-written entry. Adopt `cache_format_version 7.1` only after the rollout is finished.
- **Cookies and tokens:** Under 7.0 defaults, signed and encrypted cookies and message-verifier payloads round-tripped both ways with a shared `secret_key_base`.
  - Under 8.1 defaults the cookies still round-trip, but a message-verifier payload from 8.1 failed on 7.0.8.7.
  - Dev and test secret files differ in 7.1+: `tmp/development_secret.txt` became `tmp/local_secret.txt`. Production should use `SECRET_KEY_BASE` or credentials, unaffected.
- **Active Job and Sidekiq:** Payloads from 7.0.8.7 run on 8.1.0 and the reverse works, with two exceptions: R18 (BigDecimal) and R17 (digest day; the 8.1 `time_zone` key is ignored by 7.0.8.7, which uses UTC). With R17 and R18 applied, DigestJob payloads from both versions executed correctly on both.
  - The new payload adds `time_zone`, `scheduled_at` and fractional-second `enqueued_at` keys. These are harmless to 7.0.8.7.
  - Native `ExportJob` is a plain Sidekiq job and is unaffected.
- **Safe to ship on 7.0.8.7 before the bump:** R2, R3, R5, R6, R7, R9 to R18, and D1 to D3. The 7.0.8.7 suite passes (46 runs, 325 assertions, 0 failures) with them applied.
  - R1 is a harmless pin on either version.
  - R4, R8, R19 and D4 are bump-commit changes. D4's `coder: YAML` was not run on 7.0.8.7 and is expected to fail there.

## 4. Verification log and open questions

**Executed in `upgrade-workspace` (WS)**

Commands run:
- `gem-changes rails 7.0.8.7 8.1.0`
- `upgrade-workspace setup rails 7.0.8.7 8.1.0`
- `upgrade-workspace test` (default, `--defaults 7.1|7.2|8.0|8.1`, `--target both`)
- ~12 `upgrade-workspace probe` runs, including `--defaults 8.1`
- `upgrade-workspace cleanup rails 8.1.0`

Results:
- **Setup baseline:** 46 runs, 325 assertions, 0 failures.
- **Setup upgraded:** boot failed, with `config/initializers/action_text.rb` raising `NoMethodError` (R2).
- **After R1 to R19 and D1 to D3:** 46 runs, 340 assertions, 0 failures on upgraded under defaults 7.0, 7.1, 7.2, 8.0 and 8.1.
- **Baseline with compatible repairs:** 46 runs, 325 assertions, 0 failures.
- **Config tested:** `load_defaults 7.0` (current), plus 7.1, 7.2, 8.0, 8.1.
- **Other checks:**
  - Production boot with `eager_load` true succeeded on both copies.
  - The migration chain ran on a scratch database, since dropped.
  - Cookie, cache and verifier round-trips used a shared secret file.

Logs:
- Files under `/tmp/upgrade-rails-8.1.0/logs` are deleted by cleanup.
- Setup-time logs: `bundle-update.log`, `schema-load-*.log`, `diag-*.log`, `tests-*.log`.
- The per-defaults logs from my `test` runs are likewise deleted.

**Source only**
- The effect of each 7.1 to 8.1 default that I did not run on app code (D5 to D13 in Section 2). Only D1 to D3 and D4 were demonstrated by an error.
- Rack 3 items. They do not apply while `sidekiq 6.5.12` is pinned.
- No `render json:`, path-relative redirect, `ActionController::Parameters` versus `Hash` comparison, or models without a primary key exist in the app.

**Not verified or still open**
- `bin/rails test:system` (browser suite) was not run.
- `bin/rails zeitwerk:check` was not run. The per-file eager load of `config/`, `app/` and `lib/` passed.
- The Dev environment was not booted. Production boot used a dummy secret.
- Upgrading Sidekiq to 7 would allow Rack 3. That was not evaluated, and Puma 5.6.9 with Rack 3 is untested.
- The json pin (R1) depends on the resolver choosing json 3.x. Confirm the app's real `bundle lock` result. The R1 fix is in the Gemfile; the data-format claims in Section 3 were verified only with it applied.
- Whether `ActiveRecord::Coders::YAMLColumn` safe-loading matters for legacy YAML with other classes. A `HashWithIndifferentAccess` YAML row raised `Psych::DisallowedClass` on both versions, so it is not a regression. Whether any such rows exist in production is unknown.

**Questions for the maintainers**
- Is a shared filesystem cache or a Redis cache used in production, and do web and Sidekiq workers run mixed versions at once?
- Can you query production for `notebooks.preferences` rows containing `!ruby/` tags?

---

**Additional commentary**
- The plan is a plan only. I changed nothing in the repo.
- The plan has some internal slips. Section 2 calls the 7.1 defaults "D1 to D3 and D4" and refers to "D5 to D13", but the table doesn't number those rows. It also says production uses a "Redis cache" and then describes the default `FileStore`. Treat the `FileStore` description as the accurate one.
- Suggested order: ship the changes marked "safe on 7.0.8.7" first. Then make the bump commit with R1, R4, R8, R19 and D4, and the `Gemfile` and `Gemfile.lock` changes.
- Tell me if you want me to implement it.