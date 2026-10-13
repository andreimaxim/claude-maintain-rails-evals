I prepared the plan without changing the working repository: `/home/user/workspace/repo` still has a clean git status. The 8.1.0 upgrade needs about 15 code changes that existing tests miss or only partly catch. Some failures happen at boot or on every page; others silently change stored data or job behaviour. About two thirds of the fixes also work on 7.0.8.7, so they can ship before the version change.

## How I tested
- **Copies:** experiments ran only in disposable copies.
  - `/tmp/upg/base`: unchanged 7.0.8.7.
  - `/tmp/upg/v81`: upgraded to 8.1.0, gems in its own `vendor/bundle`.
  - `/tmp/upg/prep`: 7.0.8.7 plus only the fixes I believe also work on 7.0.
- **Isolated services:** a separate Redis on port 6390 (databases 1 to 4) and Postgres databases `upg_base_test`, `upg_v81_test`, `upg_prep_test` and `upg_shared_dev`. Storage and mail went to each copy's own `tmp`. I removed the Redis instance, servers, worker and databases afterwards.
- **Copy-only edits:**
  - Removed `username: margin_notes` from the production database config so production-mode probes could connect locally.
  - Made `load_defaults` read `PROBE_DEFAULTS` (default `"7.0"`) so the same copy could run under 7.1, 7.2 and 8.1 defaults.
- **Dependencies:** `bundle lock --update rails` gave Rails 8.1.0 with rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, pagy 8.6.3, turbo-rails 2.0.12, importmap-rails 2.2.3, sprockets-rails 3.5.2, minitest 5.27.0, concurrent-ruby 1.3.4, and new dependencies action_text-trix 2.1.19, json 3.1.0 (later pinned to 2.21.2), bigdecimal 4.1.3 and rackup.
- **Logs** are in `/tmp/upg/`:
  - Test runs: `base-test.log`, `v81-test-1.log` to `v81-test-9.log`, `v81-test-defaults81.log`, `v81-test-9-defaults81.log`, `prep-test.log`.
  - Servers and worker: `server70.log`, `server81.log`, `sidekiq81.log`.
  - Job payloads: `payload-70.json`, `payload-81.json`.
  - Scripts: `/tmp/upg/scripts/` (`probe.rb`, `enqueue.rb`, `perform.rb`, `session.rb`, `crawl.sh`, `flows.sh`).
  - The 7.0-compatible patch: `/tmp/upg/prep.patch`.
- **Results:**
  - Baseline 7.0: 46 runs, 0 failures.
  - First 8.1 run: boot failure, then 20 failures and 3 errors.
  - 8.1 with all fixes: 46/0, under both 7.0 and 8.1 defaults.
  - `/tmp/upg/prep` on 7.0: 46/0.
  - Dev servers on both versions: signed in and loaded every page (all 200). On 8.1 I also created a note, updated a notebook, ran an export to completion with download, requested a digest, scheduled a reminder and requested a citation lookup, with a real Sidekiq worker.

## A. Required changes (8.1 breaks without them)
"Works on 7.0" means I applied it in `/tmp/upg/prep` and the suite passed on 7.0.8.7.

1. **Action Text tag allow-list stops the app booting** (`config/initializers/action_text.rb`). Since 7.1, `ActionText::ContentHelper.allowed_tags` starts as nil, so `+=` raises at boot. Fix: set it inside `after_initialize`, starting from `allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]`. Works on 7.0. Check: boot, and the test "rich text keeps collapsible excerpts and drops unsafe markup".
2. **Keyword-style enum** (`app/models/note.rb:10`): `enum status: {...}, _prefix: true` raises an ArgumentError at load in 8.0+. Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0.
3. **`serialize` arguments** (`note.rb` `serialize :tags, JSON`; `notebook.rb` `serialize :preferences`).
   - The positional coder raises in 8.1. Fix: `coder: JSON`.
   - `:preferences` without a coder raises once 7.1 defaults are loaded (`default_column_serializer = nil`). Fix: `coder: YAML` explicitly.
   - The `coder:` keyword does **not** exist in 7.0, so this has to ship with the version change.
   - Stored data format is unchanged (JSON text and YAML text).
4. **`alias_attribute :highlight_color, :color`** (`note.rb:14`): `color` is a `store_accessor`, not a real column, and 8.1 raises at first use. Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0.
5. **`Rails.application.secrets` is gone** (`app/models/citation/provider.rb:13`, `config/secrets.yml`, and the citation enrichment controller test). Fix: move the settings to `config/citation_provider.yml` and load them with `config.x.citation_provider = config_for(:citation_provider)`. Works on 7.0. Production must still supply the same `CITATION_PROVIDER_*` variables.
6. **One route with two paths** (`config/routes.rb:18`, `get "/notes", "/journal"`): raises in 8.1. Fix: two `get` lines. Works on 7.0; I checked `/journal` returns 200.
7. **`form_with(model: nil)`** (`app/views/notes/index.html.erb:12`): raises in 8.0+, so the note list returns 500. Fix: remove `model: nil`. Works on 7.0.
8. **`where(notebooks: @notebook)`** (`app/controllers/notes_controller.rb:12`): the plural association name stopped being accepted in 7.2, so filtering by notebook causes a database error. Fix: `where(notebook: @notebook)`. Works on 7.0.
9. **Integer `wait_until`** (`note.rb` `schedule_reminder`): 8.1 calls `.utc` on it, so scheduling a reminder returns 500. Fix: `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
10. **`fragments.sum` on strings** (`app/models/export.rb:42`): raises a TypeError in 8.1, so every export job fails. Fix: `fragments.join`. Works on 7.0.
11. **`retry_on ... wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`): removed in 7.2. On the first retry it raises "Couldn't determine a delay", the failure block never runs, and the citation stays "pending".
    - Fix: `wait: ->(executions) { executions**4 + 2 }`, the same formula. This works on both versions (tested); `:polynomially_longer` is 7.1+ only.
    - Ship it **before** the upgrade so retries already in flight don't hit the error.
12. **`return` inside a transaction now commits** (`app/models/import.rb` `apply`). From 7.1 on (always in 8.1), the `return false` inside `transaction` commits the import and every note saved before the bad row. The test caught it: record counts went `[0,3,0,1]` to `[1,4,1,2]`.
    - Fix: use `transaction(requires_new: true)`, `raise ActiveRecord::Rollback unless rows.all?(&:save)`, and return a flag. Works on 7.0.
    - Afterwards, audit production for partial imports if any 7.1+ build ever ran.
13. **Import preview annotations disappear** (`app/views/imports/preview.html.erb:22`, `.stringify_keys`). In 8.0 this turns the integer line-number keys into strings, so `annotations[row.line]` finds nothing. Fix: drop `.stringify_keys`. Works on 7.0.
14. **Import receipt loses its DOI column** (`import.rb#receipt`, `citation[:id]`). Since 7.1, `[:id]` reads a real `id` column, and `citations` has none (its key is `doi`), so the receipt CSV column comes out empty. Fix: `citation&.doi`. Works on 7.0.
15. **Test-only setting** (`config/environments/test.rb`): `show_exceptions = false` no longer means "raise" in 8.1. Ownership tests that expect `RecordNotFound` started getting 404 pages instead. Fix: `:none`, which is only valid on 7.1+, so it ships with the upgrade.
16. **json 3.1.0 gets resolved, and Active Support 8.1.0 fails with it.** Every JSON-serialized column (`tags`, Active Storage metadata) raised "wrong number of arguments". Fix: add `gem "json", "< 3"` (resolved to 2.21.2), or use whichever 8.1.x patch fixes it (not verified).

## B. Behaviour changes no test fails on (verified)
- **Digest date moves to the reader's time zone** (`DigestJob`, `app/mailers/digest_mailer.rb`).
  - From 7.1, a time passed to a job comes back in its original zone, not UTC.
  - The subject and the "today" window then follow the reader's zone: Oct 04 instead of Oct 05 in the test.
  - Fix: `requested_at = requested_at.utc` in the mailer, which keeps the "UTC day" the app promises. Works on 7.0.
- **"24 hours later" reminder preview shows a different offset across a DST change** (`note.rb#next_day_reminder_at`).
  - 8.1 removed the option to keep a fixed offset in `to_time`, so `2026-11-01T09:00-04:00` became `08:00-05:00`.
  - It is the same moment, so the epoch and the scheduled job are unchanged.
  - To keep the old display: `(reminder_at + 86_400.seconds).to_time.getlocal(reminder_at.utc_offset)`. Works on 7.0. Whether to keep the old display is a product decision.
- **Sidekiq adapter is deprecated.** Rails' built-in `:sidekiq` adapter still works in 8.1 but logs a warning on every job and is removed in 8.2. `ExportJob`'s symbol-key arguments already trigger a Sidekiq 7 strict-arguments warning. Plan Sidekiq 7.3.3+ with redis-client as a separate follow-up.
- **Rich-text editor CSS changes.** `*= require trix` now resolves to the trix.css shipped in the action_text-trix 2.1.19 gem (Trix 2 styles), while the editor script is still the vendored `trix-1.3.5.js`. The compiled CSS differs: 563 vs 658 lines. Check it in a browser.
- **Schema dump format.** `db:schema:dump` on 8.1 writes `Schema[8.1]`, `pg_catalog.plpgsql` and alphabetical column order. These are cosmetic, but 7.0 cannot load a `Schema[8.1]` file, so roll back `db/schema.rb` together with the code.
- **No visible change for this app (source reading):**
  - `to_time` addition semantics.
  - after_commit ordering: the app has no multiple after_commit callbacks.
  - `has_secure_token`: not used.
  - Removal of the `X-Download-Options` header.
  - Partial-update key in `send_data`.
  - The 8.1 removal of `autocomplete="off"` on hidden fields only applies with 8.1 defaults.

## C. Rollout, rollback and stored data (verified)
- **BigDecimal job argument breaks mixed versions.** 8.1 always writes BigDecimal job arguments with `BigDecimalSerializer`. A 7.0 worker raises `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` on `DigestJob`. The Redis reservation `digest_requests:<date>` then blocks the reader from asking again that day.
  - Prep (works on 7.0): pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`.
  - Deploy this first. During rollback, drain any 8.1-written `DigestJob`s.
- **Other job payloads are compatible both ways** (enrichment, reminder, time arguments). 8.1 adds a `scheduled_at` field and a `time_zone` key, and 7.0 ignores both. Long-delayed `NoteReminderJob`s written by 7.0 run fine on 8.1.
- **Session cookies** work between 7.0 and 8.1 in both directions under 7.0, 7.1 and 8.1 defaults, with the same `SECRET_KEY_BASE` in production mode. Development secrets move to `tmp/local_secret.txt` and 8.1 ignores the `SECRET_KEY_BASE` variable in development, so dev sessions reset.
- **Caches:** the format stays 7.0 while `load_defaults 7.0` remains, so it is shared safely. Moving to 7.1 defaults changes cache format, message serializer and metadata; adopt those only after every server runs 8.1, in a separate deploy.
- **Suggested order:**
  1. Deploy the 7.0-compatible patch: fixes 1, 2, 4 to 14, the digest mailer fix, the BigDecimal string, and the retry proc.
  2. Drain the old retry jobs.
  3. Deploy Rails 8.1 together with the `coder:` changes, `show_exceptions :none`, the json pin, and schema.rb.
  4. Adopt new defaults one release at a time.

## D. New framework defaults (all off today because of `load_defaults 7.0`)
**7.1**
- Not applicable here: `allow_deprecated_parameters_hash_equality`, encryption hash digest and SHA1 support (no encrypted attributes), sqlite strict strings, singular association names, `run_commit_callbacks_on_first_saved_instances`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `generate_secure_token_on`.
- Needs app changes first:
  - `raise_on_assign_to_attr_readonly`: verified it raises `ReadonlyAttributeError` on notebook update even when the slug is unchanged, because the form posts a hidden slug. Fix: stop permitting `:slug` (keeping the hidden field passes the test).
  - `default_column_serializer = nil`: see item 3.
  - `raise_on_invalid_cache_expiration_time`: verified. The availability fragment in `exports/_export.html.erb:26` gets a negative `expires_in` for expired exports and raises. Fix: `[export.expires_at - Time.current, 1.second].max`.
- Other changes:
  - `active_job.use_big_decimal_serializer`: moot, 7.2+ always uses it.
  - `belongs_to_required_validates_foreign_key`: one less query per save.
  - `marshalling_format_version`, `cache_format_version 7.1`, `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`: do these last, after the rollout.
  - `query_log_tags_format`: not enabled.
  - `log_file_size`: dev/test only.
  - `precompile_filter_parameters`.
  - Sanitizers switch to HTML5: re-run the rich-text sanitization test (it passed under 8.1 defaults).
  - `debug_exception_log_level :error`.
  - `dom_testing_default_html_version :html5`.
  - `add_autoload_paths_to_load_path false`.
  - Default headers drop `X-Download-Options`.

**7.2**
- `postgresql_adapter_decode_dates`: verified. `Notebook#daily_note_counts` then gets `Date` objects and `Date.iso8601` raises a TypeError, which breaks the activity report. Fix: accept a Date or a string.
- `web_image_content_types` gains webp: no variants are used.
- `validate_migration_timestamps`: existing timestamps are valid.
- `yjit`: watch memory.
- `enqueue_after_transaction_commit` is gone from 8.1's defaults; it reads `false` even with 8.1 defaults (verified).

**8.0**
- `to_time_preserves_timezone :zone`: already forced in 8.1, see B.
- `strict_freshness`: export download `stale?` will then use only the ETag; the blob checksum is used as the ETag, so this is low risk.
- `Regexp.timeout = 1`: the CSV import parsing should be checked with a 100 KB file.

**8.1**
- `escape_json_responses = false` and `escape_js_separators_in_json = false`: the app has no JSON views.
- `action_on_path_relative_redirect :raise`: redirects all use path helpers.
- `raise_on_missing_required_finder_order_columns`: no `first`/`last` calls on unordered `Citation` queries in app code.
- `render_tracker :ruby`.
- `remove_hidden_field_autocomplete`.
- `yjit` off in local environments.

With all fixes in place, the whole suite passes under 8.1 defaults.

## E. Still unverified
- Browser check of Trix 1.3.5 with the Action Text 8.1 script and Trix 2 CSS: editing, attachment upload, `<details>`. There are no system tests and I ran no browser.
- Whether later 8.1.x patches fix the json 3 problem.
- Production `secret_key_base` source: I could not decrypt the credentials without the master key.
- The actual production queue backlog and any partial imports.
- Two existing tests assert old details (the hidden slug field, the job's time payload); my final fixes keep both passing.
- Sidekiq 7 migration is out of scope for this plan.
- `bin/rails app:update` and its diff were not run.

---

This is a plan only. Your repo is still on Rails 7.0.8.7 and its working tree is unchanged. This is a jump across four minor versions (7.0 → 7.1 → 7.2 → 8.0 → 8.1). The safest route is the two-step rollout in section C: first ship the fixes that also work on 7.0, then change the version. A patch with those 7.0-compatible fixes is at `/tmp/upg/prep.patch`. Should I apply step 1 on a branch?