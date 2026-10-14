# Upgrade plan: rails 7.0.8.7 → 8.1.0

## Summary
Eighteen required changes: 17 code edits, plus pinning `json "< 3"`. Gems that move with it: json (pinned to 2.21.2), bigdecimal 4.1.3, securerandom 0.4.1, uri 1.1.2, drb 2.2.3 and net-imap 0.6.8. New in the bundle: action_text-trix, rack-session, rackup, useragent, webrick. method_source leaves the bundle. Optional defaults: 31 settings (5 of them have nothing to adopt).

Biggest risk: `serialize :tags, coder: JSON` must ship with the upgrade itself. If it ships first, Rails 7.0 silently ignores `coder:` and writes YAML into `notes.tags` (observed).

Once all changes were applied to the after copy (observed): boot, eager load, routes, schema and the 10 GET routes were all ok. Tests: 46 runs, 340 assertions, 0 failures, 0 errors. No new deprecation warnings or logged exceptions.

## Required changes
Each change was validated with `upgrade-copy validate "TITLE" --file W/check-N.rb`. Results read before / after without the change / after with every change. CONTROL lines matched in every run (observed).

"Ship before" means the change passed on 7.0 with all repairs applied (`backport`).

### 1. Action Text `allowed_tags` is nil, so the app does not boot
- **Affected code:** `config/initializers/action_text.rb:3`.
- **If nothing is done:** boot fails with `undefined method '+' for nil (NoMethodError)` (observed).
- **Applies because:** since 7.1, Action Text leaves `allowed_tags` nil and works out the default only when it sanitizes (from source: actiontext `content_helper.rb`).
- **Repair:** inside `config.after_initialize`, build the list as `allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]` and add `details summary`.
- **Validation:** check-1: PASS / boot error / PASS. CONTROL: `script` is still stripped.
- **Rollout:** ship before.

### 2. `enum` with keyword arguments was removed
- **Affected code:** `app/models/note.rb:10`.
- **If nothing is done:** eager load fails with `wrong number of arguments (given 0, expected 1..2)` (observed).
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Validation:** check-2: PASS / boot error / PASS.
- **Rollout:** ship before.

### 3. `serialize` no longer takes a positional coder
- **Affected code:** `app/models/note.rb:12`.
- **If nothing is done:** `serialize: wrong number of arguments (given 2, expected 1)` (observed).
- **Repair:** `serialize :tags, coder: JSON`.
- **Validation:** check-3: PASS / boot error / PASS. Raw value stored on after is `["a","b é"]`.
- **Rollout:** **ship with the upgrade only.** On 7.0 this line stores `"---\n- a\n- b é\n"` (YAML). The backport tests also failed with "Foreign key violations found in your fixture data" (observed); I did not confirm which repair causes it.
  - If YAML rows were ever written, 8.1 raises `JSON::ParserError` when reading them (observed in probe-2).

### 4. A route can no longer have more than one path
- **Affected code:** `config/routes.rb:18`, `get "/notes", "/journal"`.
- **If nothing is done:** `Wrong number of arguments (expect 1, got 2)` (observed).
- **Repair:** two `get` lines, with `as: :notes` and `as: :journal`. Route names stay the same as before.
- **Validation:** check-4: PASS / route error / PASS.
- **Rollout:** ship before.

### 5. `alias_attribute` can't point at a `store_accessor`
- **Affected code:** `app/models/note.rb:14`. `highlight_color` is used in `notes/index.html.erb:44`, `_form.html.erb:31-37`, `show.html.erb:3`, `notes_controller.rb:68` and the tests.
- **If nothing is done:** `Note model aliases 'color', but 'color' is not an attribute` (observed).
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Validation:** check-5: PASS / boot error / PASS. Raw value stored: `{"color": "green"}`.
- **Rollout:** ship before.

### 6. Pin json below 3
- **Affected code:** every JSON decode. json 3.1.0 is a new major version pulled in by the upgrade.
- **If nothing is done:** `json-3.1.0/lib/json/common.rb:291:in 'parse': wrong number of arguments (given 2, expected 1)`, called from `active_support/json/decoding.rb:25`. This caused 30 test errors and 500 responses (observed).
- **Repair:** add `gem "json", "< 3", require: false` to the Gemfile; it resolves to 2.21.2.
- **Validation:** check-6: PASS / ArgumentError / PASS.
- **Rollout:** ship before; it resolves and installs at 7.0.8.7 (observed).

### 7. `Enumerable#sum` on strings
- **Affected code:** `app/models/export.rb:42`.
- **If nothing is done:** `String can't be coerced into Integer` (observed). 7.0 already shows a deprecation warning for this line.
- **Repair:** `fragments.sum("")`.
- **Validation:** check-7: PASS / TypeError / PASS.
- **Rollout:** ship before.

### 8. `Rails.application.secrets` was removed
- **Affected code:** `app/models/citation/provider.rb:13`; `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`; comment in `config/secrets.yml`.
- **If nothing is done:** `undefined method 'secrets'` (observed).
- **Repair:**
  - In `config/application.rb`: `config.x.citation_provider = config_for(:secrets)[:citation_provider].to_h`.
  - Read it through `Rails.configuration.x.citation_provider` in the provider and the test.
- **Validation:** check-8: PASS / NoMethodError / PASS.
- **Rollout:** ship before.

### 9. `show_exceptions = false` no longer means "raise" in tests
- **Affected code:** `config/environments/test.rb:31`.
- **If nothing is done:** 8 tests fail with `ActiveRecord::RecordNotFound expected but nothing was raised` (observed).
- **Repair:** `config.action_dispatch.show_exceptions = :none`.
- **Validation:** check-9: PASS / FAIL (404) / PASS.
- **Rollout:** with the upgrade; 7.0 treats `:none` as true and shows the exception page.

### 10. `retry_on wait: :exponentially_longer` was removed
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`.
- **If nothing is done:** `Couldn't determine a delay based on :exponentially_longer` (observed).
- **Repair:** `wait: :polynomially_longer`.
- **Validation:** check-10: PASS / FAIL / PASS.
- **Rollout:** with the upgrade; 7.0 does not know this value (observed). Jobs already queued are not affected.

### 11. `form_with(model: nil)` now raises
- **Affected code:** `app/views/notes/index.html.erb:12`.
- **If nothing is done:** `Passed nil to the :model argument` and a 500 on `/notes` (observed).
- **Repair:** remove `model: nil`.
- **Validation:** check-11: PASS / error / PASS.
- **Rollout:** with the upgrade. It returned 500 on 7.0 with the repairs applied. The cause is hidden, because `:none` counts as true on 7.0 and the exception page is shown.

### 12. Plural association name in `where`
- **Affected code:** `app/controllers/notes_controller.rb:12`.
- **If nothing is done:** `PG::UndefinedColumn: column notes.notebooks does not exist` (observed).
- **Repair:** `where(notebook: @notebook)`.
- **Validation:** check-12: PASS / FAIL / PASS.
- **Rollout:** with the upgrade. It returned 500 on 7.0 with the repairs applied, cause hidden as in change 11.

### 13. Numeric `wait_until`
- **Affected code:** `app/models/note.rb:62`.
- **If nothing is done:** `undefined method 'utc' for an instance of Integer`, and a 500 when creating a reminder (observed).
- **Repair:** `wait_until: Time.at(reminder_epoch)`.
- **Validation:** check-13: PASS / FAIL / PASS.
- **Rollout:** ship before. The job payload now carries `scheduled_at` (observed).

### 14. `to_time` now keeps the time zone, which changes the postponed reminder time
- **Affected code:** `app/models/note.rb:45`; used by `_reminder.html.erb:19` and the postponement at `note.rb:73`.
- **If nothing is done:** the "24 hours later" time becomes `2026-11-01T08:00:00-05:00` instead of `09:00-04:00`. The test fails and the postponed reminder time changes (observed).
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.
- **Validation:** check-14: PASS / FAIL / PASS.
- **Rollout:** ship before.

### 15. Active Job keeps a TimeWithZone's zone, so the digest uses the wrong day
- **Affected code:** `app/mailers/digest_mailer.rb:7-9`.
- **If nothing is done:** the subject reads "October 04" instead of "October 05", and the note selection uses the reader's local day (observed).
- **Repair:** `requested_at = requested_at.utc`.
- **Validation:** check-15: PASS / FAIL / PASS.
- **Rollout:** ship before.
  - The 8.1 payload adds `"time_zone"` (observed). A payload written by 7.0 deserializes to UTC on 8.1 (observed).
  - With the repair, both servers give the same day while old and new run together.

### 16. `HashWithIndifferentAccess#stringify_keys` now turns integer keys into strings
- **Affected code:** `app/views/imports/preview.html.erb:22`.
- **If nothing is done:** the import preview stops showing annotations (observed).
- **Repair:** drop `.stringify_keys`.
- **Validation:** check-16: PASS / FAIL / PASS.
- **Rollout:** ship before.

### 17. `return` inside a transaction now commits
- **Affected code:** `app/models/import.rb:53-57`.
- **If nothing is done:** an import with invalid rows saves part of its rows. Counts went from [0,3] to [1,4] (observed).
- **Repair:** set `saved = rows.all? { |row| row.note.save }`, then `raise ActiveRecord::Rollback unless saved`, then return `saved`.
- **Validation:** check-17: PASS / FAIL / PASS. CONTROL: a valid import still saves.
- **Rollout:** ship before.

### 18. `citation[:id]` no longer returns the `doi` primary key
- **Affected code:** `app/models/import.rb:68`.
- **If nothing is done:** the receipt CSV has an empty DOI column (`Cited,`) (observed).
- **Repair:** `citation&.doi`.
- **Validation:** check-18: PASS / FAIL / PASS.
- **Rollout:** ship before.

## Risks without a code change
- **Schema dump:** `db/schema.rb` will change on the next dump. Columns are sorted alphabetically, the header becomes `Schema[8.1]`, and the extension line becomes `enable_extension "pg_catalog.plpgsql"` (observed). The behaviour is the same; commit the regenerated file.
- **Response header:** the `Link` header name is now lowercase `link` (Rack 3, observed). Header names are case-insensitive, so only a client that compares them with exact case would notice.
- **Store change tracking:** `saved_change_to_color?` changed from false to true. The changelog calls this a fix, and the app never calls it (observed in probe-1).

## Gems that move with this upgrade
- **json:** 2.7.2 → 2.21.2, pinned below 3. This is required change 6.
- **Major versions:** bigdecimal 4.1.3, securerandom 0.4.1, uri 1.1.2. The only textual matches were to other objects: core `BigDecimal()` and `::Logger::Formatter`. The digest and citation tests pass.
- **Minor and new:** drb 2.2.3 and net-imap 0.6.8; action_text-trix, rack-session, rackup, useragent and webrick are new. method_source leaves the bundle.
- **No other gem bumps were needed.**

## Optional: framework defaults
The app stays on `load_defaults 7.0`. Values below come from the after copy (observed). Recommendations are proposed, not run.

**Adopt now (no effect found in this app):**
- `precompile_filter_parameters` (nil)
- `log_file_size` (nil)
- `debug_exception_log_level` (:fatal)
- `query_log_tags_format` (:legacy)
- `validate_migration_timestamps` (nil)
- `yjit` (false); adopt now unless memory is tight
- `sqlite3_adapter_strict_strings_by_default`; nothing to change, the app runs on PostgreSQL

**Adopt later:**
- `default_column_serializer` (YAMLColumn). Before setting it to nil, give `notebook.rb:7 serialize :preferences` an explicit `coder: YAML`.
- `message_serializer` and `use_message_serializer_for_metadata` (nil). Do this in a second deploy, after old servers are gone, because they affect cookies.
- `marshalling_format_version` (6.1). Second deploy.
- `raise_on_assign_to_attr_readonly` (false). The Notebook settings form resends `slug`, which is `attr_readonly` (`notebook.rb:8`). Strip the param before turning this on.
- `belongs_to_required_validates_foreign_key` (true → false)
- `generate_secure_token_on`: no `has_secure_token` in the app
- `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`: no `after_commit` callbacks in the app
- `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` (HTML4 → HTML5). Rerun check-1 first.
- `dom_testing_default_html_version` (:html4)
- `web_image_content_types`: adds webp
- `to_time_preserves_timezone`: change 14 already makes the reminder code independent of it
- `strict_freshness` (false). Affects `export_downloads_controller.rb:11 stale?(etag:, last_modified:)`.
- `raise_on_invalid_cache_expiration_time`. `exports/_export.html.erb:26` can pass a negative `expires_in` (the probe returned the value today). Clamp it first.
- `encryption.hash_digest_class` and `support_sha1_for_non_deterministic_encryption`: no encrypted attributes in the app

**Never, unless the code changes first:**
- `enqueue_after_transaction_commit`. `Note#schedule_reminder` relies on enqueuing while it holds the row lock.
- `postgresql_adapter_decode_dates`. `notebook.rb:40` calls `Date.iso8601(day)` on the raw string, so it would raise.

**Nothing to adopt (removed in 8.1):** `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `use_big_decimal_serializer`, `commit_transaction_on_non_local_return`.

## Checked, not applicable
The full list of 51 lines is in `/tmp/gem-upgrade/repo-rails-8.1.0/candidates.md`. Main points:
- **Probe-1, same output on both sides:**
  - serialized notebook preferences: YAML is still the default
  - rich-text sanitizing
  - `filter_attributes` in `inspect`
  - negative and zero cache `expires_in`
  - `autocomplete="off"` on hidden fields and `button_to`
  - `file_field` accept
  - `JSON.parse`
  - `Note.connection`
- **Removed names that belong to other objects:** `purge` (Blob), `Current#host` (URI), cookies `ParserError`, `Relation#transaction` (the app's call is class-level), `ConnectionPool#connection`.
- **Additive or generator-only:** allow_browser, markdown renderer, transaction objects, deprecated associations, routes `--grep`, system test generator, `public_file_server` generator changes.
- **Route change:** the Action Mailbox conductor edit/update/destroy routes are gone; they are framework routes the app does not use.

## Not verified
- **Production-only paths:** BroadcastLogger with the logger at `production.rb:86`, and the production `secrets.yml` values loaded through `config_for` (proposed; only test and default values were run).
- **Citation provider service:** the URL default `http://127.0.0.1:9393` in `config/secrets.yml` was not isolated by the tool. It was only reached through the test's own Puma stand-in.
- **7.0 payloads already queued in Sidekiq:** only `ActiveJob::Arguments` round-trips were run.
- **Shipping changes 11 and 12 early:** on 7.0 with the repairs they returned 500, but the cause was hidden.
- **Backport test errors:** the "Foreign key violations" errors on 7.0 with the repairs were not traced to a specific repair. Rerun the tests after shipping the "ship before" set without changes 3 and 9–12.
- **Browser suite:** `bin/rails test:system` was not run.
- **Commits:** the 13,954 commits were not reviewed one by one ("All commits listed: no").

## Evidence
- **Workspace:** `/tmp/gem-upgrade/repo-rails-8.1.0`. The copies were removed by `cleanup`; notes and logs remain.
- **Notes:** `findings.md` (F1–F18, validation, rollout) and `candidates.md`.
- **Scripts:** `check-1.rb` … `check-18.rb`, `probe-1.rb`, `probe-2.rb`.
- **Output:** `validate-all.txt`, `backport.txt`, `backport.patch`, `final.diff` (the full diff of every change), and `logs/` (check, minitest, routes, schema and runner logs).
- **Versions:** before is rails 7.0.8.7 with json 2.7.2; after is rails 8.1.0 with json 2.21.2.
- **Commands run:** `upgrade-copy setup`, `gem-changes`, `check`, `check --side after` (15 rounds), `keep`, `bump json "< 3"`, `runner` (probe-1, probe-2, defaults-probe), `validate` ×19, `backport`, `backport --hold`, `reset --side before`, `diff --all`, `cleanup`.

---

I haven't changed anything in your repository; this is a plan only. Rails is currently at 7.0.8.7, so this jump crosses three minor versions. All 18 changes were tested on a throwaway copy of the app, and the full diff is in `/tmp/gem-upgrade/repo-rails-8.1.0/final.diff`. With every change applied, the regular test suite passed. The browser tests (`bin/rails test:system`) were not run.

Before starting, decide two things:
- **Change 3 has to go out with the upgrade, not before it.** Shipped early, Rails 7.0 would quietly save note tags as YAML, and 8.1 then fails to read them.
- **One problem is still unexplained.** When the "ship before" changes were applied on 7.0, the tests failed with foreign-key errors in the test data. The cause wasn't found, so rerun the tests before shipping that set.

Say if you want me to apply the changes.