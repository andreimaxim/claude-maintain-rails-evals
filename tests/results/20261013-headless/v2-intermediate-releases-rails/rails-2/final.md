# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Conclusion:** With the 7.0 defaults kept, the app can run on 8.1.0 after about 14 code and config changes. The test suite catches most breakages, but several do not show up in tests and only affect queued jobs or stored data. The highest risks are:
- **Tags column (`Note`):** the 8.1 form `serialize :tags, coder: JSON`, if deployed on 7.0, silently writes YAML into the tags column.
- **Digest jobs:** jobs queued under 8.1 cannot be read by 7.0 workers.
- **Signed IDs:** adopting the 7.1 message defaults makes Action Text attachment IDs stored in note bodies unreadable after a rollback to 7.0.
- **Browser-side Trix:** the vendored Trix 1.3.5 is untested against 8.1, and `test/system` is empty.

I did not change the working repository; `git status` is clean.

## How this was checked
- **Disposable copies** in `/tmp/upg/`:
  - `app70`: the unmodified baseline.
  - `app81`: 8.1.0 with `load_defaults 7.0`.
  - `app81d`: 8.1.0 with `load_defaults 8.1`.
  - `app70p`: the portable fixes, run on 7.0.
- **Isolated services:** its own PostgreSQL 15 cluster on port 55432, Redis on 56379 with nothing saved to disk, and a separate bundle path (`/tmp/upg/bundle`). Storage was each copy's own `tmp/storage`. I had to run `mise trust` on each copy's `mise.toml`. Both services are now stopped.
- **Dependencies resolved** with `bundle lock --update rails`. Only the Rails gems moved: rack stays 2.2.24, sidekiq 6.5.12, redis 4.8.1, minitest 5.27.0. It also pulled in `json 3.1.0`, which breaks things (finding 1).
- **Logs** are in `/tmp/upg/logs/`, scripts in `/tmp/upg/scripts/`, and the verified portable patch in `/tmp/upg/portable-verified-on-70.patch`.

| Variant | Result | Log |
|---|---|---|
| 7.0 baseline | 46 runs, 0 failures | `70-test.log` |
| 8.1, no fixes | won't boot | `81-prepare.log` |
| 8.1 + fixes, old defaults | 46 runs, 0 failures; eager load and zeitwerk pass | `81-test5.log`, `81-test5-eager.log` |
| 7.0 + portable subset | 46 runs, 0 failures | `70p-test3.log` |
| 8.1 + fixes, `load_defaults 8.1` | 3 errors | `81d-test2.log` |

**Limits of what I ran:** I only installed 8.1.0, not 7.1, 7.2 or 8.0. Which release introduced each change below comes from my knowledge of the upgrade guides and changelogs, checked against the 8.1.0 source. I did not run any browser or system tests.

## A. Required changes for 8.1

"7.0-safe" means the change also works on 7.0 and can ship first. "Suite catches" means the existing tests fail without it.

1. **`json` gem (Gemfile):** activesupport 8.1.0 passes options to `JSON.parse` in a way json 3.x no longer accepts. Every JSON column read fails. Add `gem "json", "< 3"`, or use a later 8.1.x patch if one fixes it (I didn't check). Not applicable to 7.0. Suite catches it.
2. **`config/initializers/action_text.rb`:** from 7.1, `allowed_tags` starts as nil, so `+=` crashes at boot. Replace it with the portable form from `/tmp/upg/app81/config/initializers/action_text.rb`. 7.0-safe. Boot fails without it.
3. **`app/models/note.rb`:**
   - `enum status:, _prefix:` must become `enum :status, {...}, prefix: true` (keyword form removed in 8.0). 7.0-safe; models won't load without it.
   - `alias_attribute :highlight_color, :color` must become `alias_method` for both the reader and the `=` writer. `color` is a store accessor, not a real attribute, so 7.2+ raises. 7.0-safe.
   - `serialize :tags, JSON` must become `serialize :tags, coder: JSON` (positional form removed in 7.2). **This is not 7.0-safe.** On 7.0 the `coder:` keyword is silently ignored and the column is treated as YAML. In a rolled-back transaction it read JSON tags as a raw string and wrote `"---\n- x\n- \"y\"\n"` to the column. Ship this only in the same deploy as the Rails bump.
4. **`config/secrets.yml` / `Citation::Provider`:** `Rails.application.secrets` was removed in 7.2. Move the settings to `config/citation_provider.yml`, load them with `config.x.citation_provider = config_for(:citation_provider)`, and update the test helper at `citation_enrichments_controller_test.rb:117-122`. 7.0-safe. Suite catches it. Production keeps reading the same `CITATION_PROVIDER_*` environment variables.
5. **`config/routes.rb`:** `get "/notes", "/journal", to:` (several paths in one call) no longer works. Split it into two `get` lines; `notes_path` and `journal_path` stay the same. 7.0-safe. Suite catches it.
6. **`app/views/notes/index.html.erb`:** `form_with(model: nil, ...)` now raises; drop `model: nil`. 7.0-safe. Suite catches it.
7. **`NotesController#index`:** `where(notebooks: @notebook)` is now read as a column named `notes.notebooks`. Change it to `where(notebook: @notebook)`. 7.0-safe. Suite catches it.
8. **`Export#generate`:** `fragments.sum` on strings is gone (removed in 7.1). Use `fragments.join`. 7.0-safe. Suite catches it.
9. **`Import#receipt`:** `citation[:id]` no longer returns the DOI primary key. It now raises a missing-attribute error, so the CSV receipt returns a 500. Use `citation&.doi`. 7.0-safe. Suite catches it.
10. **`Import#apply`:** `return false` inside `transaction` used to roll back; from 8.0 it commits. An invalid row would then leave the import and earlier notes saved. Measured counts went from `[0,3,0,1]` to `[1,4,1,2]`. Use `raise ActiveRecord::Rollback` and return the transaction's value. 7.0-safe. Suite catches it (`81-import-early-return.log`).
11. **`imports/preview.html.erb`:** `annotations.stringify_keys` now really turns the integer line numbers into strings, so annotations silently disappear from the preview. Remove `.stringify_keys`. 7.0-safe. Suite catches it.
12. **`Note#schedule_reminder`:** passing an integer to `set(wait_until:)` now fails with `undefined method utc for Integer`. Use `Time.at(reminder_epoch)`. 7.0-safe. Suite catches it.
13. **`CitationEnrichmentJob`:** `wait: :exponentially_longer` raises "Couldn't determine a delay" when a retry happens. Use `:polynomially_longer`, which is the same formula. Not available on 7.0, so it goes in the bump deploy. Suite catches it.
14. **`config/environments/test.rb`:** `show_exceptions = false` is now treated as "show exceptions", which hides the real errors behind 500 pages. Use `:none`. Not available on 7.0 (there it means "show"), so it goes in the bump deploy.

## B. Behavior changes tests miss, plus mixed-version and rollback risks

- **B1. Digest date (`DigestMailer` / `DigestJob`).**
  - What changes: from 7.1, a time-with-zone job argument keeps the reader's zone. The digest then covers the reader's local day instead of the UTC day the app documents.
  - Fix: `requested_at = requested_at.utc` in the mailer. 7.0-safe; ship it before the bump.
  - Coverage: the suite catches the subject line, but not the mixed fleet. A 7.0 worker ignores the zone field, so during rollout the same request gives different days depending on which worker runs it. The fix removes that difference.
- **B2. Digest payload rejected by 7.0 workers.**
  - What I saw: 8.1 now always encodes decimal job arguments in a format 7.0 doesn't know. A 7.0 worker failed with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`cross-81to70.log`).
  - Why it matters: `DigestJob` has no `discard_on`, so it retries until it lands in the dead set. The user's Redis reservation for that day stays held, so they cannot re-request the digest.
  - Fix: in `User#request_digest`, pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)` on it, and 7.0 already sends a string. 7.0-safe; ship it first.
  - Rollout: drain the queue, or deploy web and workers together. The reverse direction (7.0 payload read by an 8.1 worker) worked.
- **B3. Next-day reminder time.**
  - What changes: in 8.1 `to_time` always keeps the zone (the setting is deprecated). `next_day_reminder_at` used to keep the UTC offset across a daylight-saving change; now it shows 08:00 -05:00 instead of 09:00 -04:00.
  - What doesn't change: the stored epoch. The difference is display only, and the suite catches it.
  - Options: keep the documented behavior with `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400` (7.0-safe), or accept the new behavior and update the test and comment. This is a product decision.
- **B4. Trix and Action Text JavaScript (needs a browser test).**
  - The layout loads the vendored `trix-1.3.5.js`, and `@rails/actiontext` is pinned to `actiontext.js`.
  - On 8.1 that file is a different bundle format, and `actiontext.css` `require trix` now pulls in the gem's Trix 2.1.19 CSS. That puts Trix 1 JavaScript next to Trix 2 CSS.
  - Recommendation: on 8.1, drop the vendored file. Pin `trix` and `@rails/actiontext` (to `actiontext.esm.js`) from the gems, import `trix`, and update the layout comment. Assets resolve on 8.1, but whether the editor works is unverified.
- **B5. Export availability cache (production only).**
  - In `exports/_export.html.erb`, `expires_in: export.expires_at - Time.current` is negative once an export has expired.
  - With the 7.0 defaults, 8.1 drops the expiry and logs an `ArgumentError` on each write. The cached "Expired" text is still correct.
  - With the 7.1 `raise_on_invalid_cache_expiration_time` default, the exports page returns a 500. Tests turn caching on and do catch this.
  - Fix: pass an expiry only while `export.downloadable?`, and add that to the cache key. Moving to `expires_at:` doesn't help, because 8.1 converts it to the same negative value. 7.0-safe.
- **B6. Signed IDs and the rollback window.**
  - Tested (`msg-matrix*.log`): Action Text attachment SGIDs and Active Storage signed IDs written by 8.1 with 8.1 defaults could not be read by 7.0 (`NoMethodError ... unpack`). All other combinations worked, and session cookies were readable in every direction.
  - Why it matters: SGIDs are saved inside `action_text_rich_texts.body`. After rolling back to 7.0, attachments created after the flip would break.
  - Recommendation: keep `use_message_serializer_for_metadata` and `message_serializer` at their old values until a rollback to 7.0 is ruled out. I tested the full 8.1 default set; attributing it to these two flags is from the source.
- **B7. Sidekiq.**
  - On 8.1, the built-in Sidekiq adapter logs a deprecation warning and is removed in 8.2. It needs sidekiq 7.3.3 or later.
  - That later upgrade is not needed for 8.1, but it has its own risks. `redis.sadd` in `User#request_digest` would return an integer, and `0` counts as true in Ruby, which would allow duplicate digests. `Notebook#request_export` passes symbol keys, which Sidekiq 7's strict argument checking rejects.
- **B8. Minor.**
  - Add `gem "csv"` before moving to Ruby 3.4.
  - The `concurrent-ruby 1.3.4` pin and the Gemfile and TESTING.md minitest notes refer to 7.0; revisit them afterwards.
  - Remove `config/secrets.yml` once nothing reads it.

## C. New configuration defaults, release by release
Margin Notes keeps all of these at the old value today (`load_defaults 7.0`).

**7.1**
- Settings that need nothing from this app:
  - `add_autoload_paths_to_load_path=false`, `precompile_filter_parameters`, `log_file_size`.
  - `sqlite3_adapter_strict_strings_by_default`, `query_log_tags_format`, `encryption.*`, `generate_secure_token_on`, `debug_exception_log_level`.
  - `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`: no transaction callbacks here.
  - `belongs_to_required_validates_foreign_key=false`: `Note` reassigns its notebook on every update.
- Settings with an effect here:
  - `dom_testing_default_html_version :html5`: tests parse HTML differently. The suite passed under 8.1 defaults.
  - `raise_on_assign_to_attr_readonly`: `NotebooksController#update` raises `ReadonlyAttributeError`, because the settings form resubmits `slug` and `notebook_params` permits it. Fix: stop permitting `:slug` on update (7.0-safe). Suite catches it.
  - `default_column_serializer=nil`: `serialize :preferences` fails at boot. Add `coder: YAML`; the stored data format doesn't change.
  - `marshalling_format_version 7.1`: no marshalled records are cached here.
  - `default_headers`: drops the X-Download-Options header (cosmetic).
  - `cache_format_version 7.1`: 7.0 cannot read the new fragment-cache format. Production uses the local FileStore, so keep 7.0 until the rollback window closes.
  - `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: see B6.
  - `raise_on_invalid_cache_expiration_time`: see B5.
  - `sanitizer_vendor` HTML5 (Action View and Action Text): rich-text sanitizing changes. The test that keeps `details`/`summary` passed under 8.1 defaults.

**7.2**
- `yjit=true`: uses more memory.
- `web_image_content_types` adds webp: no variant processor is installed, so little effect.
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` passes a Date to `Date.iso8601` and raises TypeError. Fix: accept either a Date or a string (7.0-safe). Suite catches it.
- `validate_migration_timestamps`: existing migrations are fine.

**8.0**
- `strict_freshness`: on `ExportDownloadsController`, an ETag match alone is enough when both headers are sent. The blob checksum is still MD5 and immutable, so harmless.
- `Regexp.timeout=1`: affects the DOI and CSV-parsing regexes only under pathological input.

**8.1**
- `yjit` turns off in development and test.
- `escape_json_responses=false` and `escape_js_separators_in_json=false`: no JSON views or inline JSON found.
- `action_on_path_relative_redirect :raise`: all redirects are absolute paths.
- `raise_on_missing_required_finder_order_columns`: all models have primary keys.
- `render_tracker :ruby`: may change template digests, causing one round of fragment-cache misses.
- `remove_hidden_field_autocomplete`: hidden slug and CSV fields lose `autocomplete="off"`.

## D. Suggested rollout
1. **Deploy on 7.0 first:** the 7.0-safe changes from A2 and A4–A12, plus B1, B2, B3 (if keeping the old behavior), B5, and the slug and date fixes. The verified patch is `/tmp/upg/portable-verified-on-70.patch`.
2. **Bump deploy:** the Rails bump, the json pin, A3 serialize, A13, A14 and B4, still with `load_defaults 7.0`.
   - Drain the DigestJob, NoteReminderJob and CitationEnrichmentJob queues, or deploy web and workers together.
   - `ExportJob` is a plain Sidekiq job and is unaffected.
   - Scheduled reminders queued under 7.0 deserialize fine on 8.1 (tested).
3. **After rollback to 7.0 is ruled out:** adopt the new defaults in stages, the message-format and cache-format flags last. Rolling back the bump deploy itself is safe for the tags column (it stays JSON) and for cookies.

## Still unverified / open questions
- Browser behavior of the Action Text editor on 8.1 (B4). There are no system tests; one should be added and run with Chrome.
- Running the suite on 7.1, 7.2 and 8.0 as intermediate steps.
- Whether a later 8.1.x patch makes the json pin unnecessary.
- Whether production uses a shared cache directory or multiple hosts.
- The product decision on B3.
- Whether Puma 5 works under 8.1 in production. Only boot and the runner were checked.
- A Sidekiq 7.3.3+ migration plan before 8.2.

---

This is a plan only; I haven't upgraded anything, and your repository is unchanged on `main`.

Two things need your input before implementation:
- **B3:** keep the old next-day reminder time, or accept the new one and update the test.
- **Rollout:** ship the 7.0-safe fixes in their own deploy first, as section D recommends, or do everything at once.