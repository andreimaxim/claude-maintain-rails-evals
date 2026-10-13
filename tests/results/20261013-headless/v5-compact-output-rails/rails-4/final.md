# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible. On 8.1.0 the app first failed to boot, then failed 45 of 46 tests. After about 15 small code changes, all 46 tests pass and a real Sidekiq worker processes jobs. Most of these changes can ship first, on 7.0. One test-config change and one model change only work on 7.1+ and must ship with the upgrade.

Three problems would have reached production without anything crashing:
- **Partial imports.** A failed CSV import now saves some of its rows.
- **Blank receipts.** The import receipt CSV loses its DOI column.
- **Digest date.** Digest emails cover a different day than before.

I did not change the working repo; `git status` is still clean.

## How I tested
- **Copy:** `/tmp/up/app`, a clone of the repo. It used its own databases (`margin_notes_upg_*`, dropped afterwards), its own Redis on port 6390 (`REDIS_URL=redis://127.0.0.1:6390/0`, shut down), and its own storage directory (`tmp/upg_storage`). Ruby 3.3.6.
- **Branches in the copy:**
  - `prep70`: the preparatory changes on Rails 7.0.8.7 (lockfile unchanged).
  - `upg81`: Rails 8.1.0 plus the preparatory changes and the 7.1+-only changes. The lock resolved json 2.21.2, sidekiq 6.5.12, puma 5.6.9, rack 2.2.24, bigdecimal 4.1.3.
- **Logs in `/tmp/up/`:**
  - Change summary: `changes.txt`
  - Baseline on 7.0: `test70.log` (46 runs, 0 failures)
  - 8.1 iterations: `test81.log`; final run `test81-final.log` (46/0)
  - Prep changes on 7.0: `test-prep70.log` (46/0)
  - Default-adoption runs: `test81-defaults-{7.1,7.2,8.0,8.1}.log`
  - Jobs: `enqueue81.log`, `cross70.log`, `sidekiq-worker81.log`
  - Diffs: `prep70.diff`, `upg81.diff`
- **Command used:** `CI=1 bin/rails test`, which eager-loads. System tests were not run.

## A. Required changes (each one failed on 8.1 in testing)

"Works on 7.0" means I ran the 7.0 test suite with the change applied.

1. **Missing gem pin: `json`.** Rails 8.1.0's Active Support calls `JSON.parse(json, options)`. The json 3.1.0 gem that resolves today rejects that. Every request reading the session cookie fails with `ArgumentError (given 2, expected 1)`. Add `gem "json", "< 3"`, or move to a later 8.1.x that fixes this (not checked).

2. **`config/initializers/action_text.rb`.** Since 7.1, `ActionText::ContentHelper.allowed_tags` starts as `nil`, so `+=` crashes at boot. Fallback version I used (works on 7.0):
   ```ruby
   ActionText::ContentHelper.allowed_tags = (ActionText::ContentHelper.allowed_tags || Rails::HTML::SafeListSanitizer.allowed_tags + ["action-text-attachment","figure","figcaption"]) + %w[details summary]
   ```
   The `<details>` and `<summary>` tags must still survive sanitizing; check that with a test.

3. **`Note`: `enum status: {...}, _prefix: true`.** Removed in 8.0. Use `enum :status, {...}, prefix: true`. Works on 7.0.

4. **`Note`: `serialize :tags, JSON`.** Removed in 7.2. Use `coder: JSON`. **This one is 7.1+ only.** On 7.0, `coder: JSON` is quietly ignored and the column is read and written as YAML, so 4 tests failed. Ship it with the Rails bump, never before it.

5. **`Note`: `alias_attribute :highlight_color, :color`.** `color` comes from `store_accessor`, so it isn't a real attribute, and 8.1 raises. Use `alias_method` for both `highlight_color` and `highlight_color=`. Works on 7.0.

6. **`config/routes.rb:18`: `get "/notes", "/journal", to:`.** Several paths in one call was removed in 8.1. Split it into two `get` lines. The `notes_path` helper name stays the same. Works on 7.0.

7. **`Rails.application.secrets` was removed in 7.2.** It is used in `Citation::Provider#initialize` and `test/controllers/citation_enrichments_controller_test.rb`. I moved `config/secrets.yml` to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider`. Works on 7.0. Production still reads the same three `CITATION_PROVIDER_*` environment variables. The test that re-boots the app with those variables passed.

8. **`NotesController#index`: `where(notebooks: @notebook)`.** This used the plural name of a singular association, which is removed. It now raises `PG::UndefinedColumn notes.notebooks`. Use `where(notebook: @notebook)`. Works on 7.0.

9. **`notes/index.html.erb:12`: `form_with(model: nil, ...)`.** 8.1 raises on `model: nil`. Drop the `model:` option. Works on 7.0.

10. **`Export#generate`: `fragments.sum`.** Active Support no longer lets `sum` add up strings, so it raises `TypeError` and every export fails. Use `sum("")` or `join`. Works on 7.0.

11. **`Note#schedule_reminder`: `set(wait_until: reminder_epoch)` with an integer.** 8.1 calls `.utc` on it and raises `NoMethodError`. Use `wait_until: Time.at(reminder_epoch)`. Works on 7.0.

12. **`CitationEnrichmentJob`: `wait: :exponentially_longer`.** Removed. Its replacement, `:polynomially_longer`, only exists from 7.1. A lambda works on both versions: `wait: ->(executions) { executions**4 + 2 }`. The jitter differs slightly from the built-in option.

13. **`imports/preview.html.erb`: `@import.annotations.stringify_keys`.** In 8.1 this turns the integer line keys into strings, so `annotations[row.line]` misses and annotations quietly disappear from the preview. Drop `.stringify_keys`. Works on 7.0.

14. **Silent data bug, `Import#apply`: `return false` inside `transaction`.** In 8.1, leaving a transaction block with `return` commits instead of rolling back. A file with some invalid rows then saves the import and the rows before the bad one. In the test, the record counts went from `[0,3,0,1]` to `[1,4,1,2]`. Fix: set a failure flag and `raise ActiveRecord::Rollback`. Works on 7.0. Before deploying, look for partial imports created while any 8.x code was running.

15. **Silent output bug, `Import#receipt`: `citation[:id]`.** `citations` uses `doi` as its primary key. On 7.0, `[:id]` returned the DOI. From 7.2 it returns `nil`, so the receipt CSV's DOI column is blank. Use `citation&.doi`. Works on 7.0.

16. **`config/environments/test.rb`: `show_exceptions = false`.** On 8.1, `false` no longer means "raise", so tests expecting `RecordNotFound` failed. Use `:none`. **7.1+ only:** on 7.0, `:none` counts as true, so error pages are shown instead of raising, and 23 tests failed. Change it together with the Rails bump.

17. **Behavior change, digest day (`DigestJob`, `DigestMailer`).** Since 7.1, a time-with-zone job argument keeps its zone (`"time_zone":"America/New_York"`). So `requested_at.to_date` becomes the reader's local date, not the UTC date that the code comments, the UI text ("today (UTC)") and the test promise. The test showed October 04 instead of October 05.
   - What I tested: `requested_at = requested_at.utc` in the mailer.
   - This works whichever Rails version enqueued the job, so it is safe while old and new servers run side by side.
   - If local days are actually wanted, that is a product decision, and the UI text and Redis reservation key need changing too.

18. **Display change, `Note#next_day_reminder_at`.** On 8.1, `to_time` keeps the zone instead of the fixed offset, whatever `load_defaults` says, and the old setting is deprecated. The postponed time is the same instant, but it now shows as 08:00 -05:00 instead of 09:00 -04:00 across a daylight-saving change.
   - What I tested, which keeps the old display: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Works on 7.0.
   - Otherwise, accept the new display and update the test.

19. **Rollout and rollback risk: job payloads stored in Redis.** Rails 8.1 always writes `BigDecimal` arguments in a new format.
   - I confirmed this: a `DigestJob` enqueued on 8.1 and run on 7.0 fails with `DeserializationError: BigDecimalSerializer is not known` (`cross70.log`).
   - That breaks a mixed-version rollout and any rollback while such jobs are queued, retrying or scheduled.
   - Fix: pass `reading_completion.to_s` in `User#request_digest`. The mailer already calls `BigDecimal(...)`. Ship this before the upgrade.
   - Other job arguments (time-with-zone, GlobalID records) read fine on both versions.

## B. Ship-on-7.0-first set

Items 2, 3, 5–15, 17, 18 and 19 together are verified green on 7.0.8.7 (`prep70`, 46/0). Items 1 (json pin), 4 and 16 go in with the Rails bump.

Deploy order:
1. Deploy the preparatory set.
2. Drain or check the Sidekiq queues, including scheduled `NoteReminderJob`s, which can sit there for months.
3. Upgrade Rails.

For rollback, keep the `.to_s` change (item 19) so that jobs enqueued on 8.1 stay readable on 7.0.

## C. New framework defaults

The app is on `load_defaults 7.0` and does not opt into any later default. Item 16's `show_exceptions = :none` is a required fix, not a new default. "Breaks" below means it failed in testing when that version's defaults were loaded.

**7.1**
- `raise_on_invalid_cache_expiration_time` — **breaks.** `exports/_export.html.erb:26` passes `expires_at - Time.current`, which is negative once an export expires. Clamp it to a minimum, or skip caching when expired.
- `default_column_serializer = nil` — **breaks at boot** (`Notebook` `serialize :preferences`). Add `coder: YAML` (7.1+ only). The stored YAML stays compatible.
- `raise_on_assign_to_attr_readonly` — **breaks.** The settings form resubmits `slug` and `NotebooksController#notebook_params` permits it. Stop permitting `slug` on update.
- `allow_deprecated_parameters_hash_equality = false`, `belongs_to_required_validates_foreign_key`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `generate_secure_token_on`, `commit_transaction_on_non_local_return` — no effect found: no `after_commit` callbacks, no `has_secure_token`, no params-vs-hash comparisons. The non-local-return case is already handled by item 14.
- Settings that need a staged rollout:
  - `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata` change the format of signed messages, including Active Storage signed IDs and Action Text attachment IDs. Servers still on the old Rails can't read the new format, so enable these one deploy after the upgrade.
  - `marshalling_format_version 7.1` and `cache_format_version 7.1` change the cache format. Production uses the default file store, so turn them on after the old servers are gone.
- `sanitizer_vendor` (HTML5) for Action View and Action Text, and `dom_testing_default_html_version :html5` — these could change how rich-text output is sanitized and which test selectors match. The suite passed; check that `<details>` and `<summary>` are still kept.
- No effect here: `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`, `query_log_tags_format` (unused), `add_autoload_paths_to_load_path=false` (nothing loaded from `lib`), the encryption hash settings (no encrypted attributes), SQLite strict strings (the app uses PostgreSQL).
- Not settings you choose any more on 8.1: `active_job.use_big_decimal_serializer` (the new format is always on; see item 19) and the old `X-XSS-Protection` header setting.

**7.2**
- `postgresql_adapter_decode_dates` — **breaks.** In `Notebook#daily_note_counts`, `select_rows` now returns `Date` objects, so `Date.iso8601(day)` raises `TypeError`. Accept both types, for example `day.is_a?(Date) ? day : Date.iso8601(day)`, or cast in SQL.
- `enqueue_after_transaction_commit`: the change summary lists it, but 8.1 no longer sets it through `load_defaults` (the class default is `false`).
  - Keep it off.
  - `Citation#request_enrichment` and `Note#schedule_reminder` count on enqueueing inside the lock. Turning it on would leave a citation stuck as pending, or a reminder lost, whenever an enqueue fails.
- `validate_migration_timestamps` — fine; all migration timestamps are valid.
- `web_image_content_types` adds WebP — no image variants are used.
- `yjit` — 8.1 limits it to non-local environments. This is a memory and performance decision.

**8.0**
- `strict_freshness` — when both headers are sent, `ExportDownloadsController#show` would answer from `If-None-Match` (the blob checksum) alone. Harmless, but it needs a request test.
- `to_time_preserves_timezone = :zone` — already the effective behavior; see item 18.
- `Regexp.timeout = 1` — check that the DOI regex and CSV parsing are well under that limit.

**8.1** (missing from the change summary)
- `escape_json_responses = false` and `escape_js_separators_in_json = false` — no `.jbuilder` views exist.
- `action_on_path_relative_redirect = :raise` — all redirects use route helpers or absolute paths. Adopting it is low risk; not tested.
- `raise_on_missing_required_finder_order_columns`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete` (changes hidden-field markup) — no effect found.

The 7.1, 7.2, 8.0 and 8.1 default sets each fail exactly the tests noted above, and nothing else.

## D. Dependencies
- **Sidekiq.** Sidekiq 6.5.12 with Rails 8.1's built-in adapter works end to end: a real worker completed `ExportJob` and `DigestJob` and the mail was delivered. 8.1 deprecates the built-in adapter (moving to sidekiq ≥ 7.3.3) as a separate follow-up. That move would break `User#request_digest`: it relies on redis-rb's `sadd` returning true/false, and Sidekiq 7's Redis client returns integers.
- Puma 5 and Rack 2.2 resolved fine. Ruby 3.3.6 is supported.

## Not verified
- System tests (`test:system`), and a production-mode server with real Action Text or Active Storage signed URLs read across versions.
- Whether a later 8.1.x patch removes the need for the json pin.
- Whether `<details>` and `<summary>` survive the HTML5 sanitizer once adopted.
- Release notes for the bare `rails` gem; none are packaged.
- Whether any partial imports exist in real data.
- The real production cache store.
- Whether there are scheduled reminder jobs in the production Redis.

---

This is only a plan. The upgrade skill plans the work but doesn't carry it out, so your repo is unchanged. The planner tested everything in a throwaway copy at `/tmp/up/app`. The diffs there (`prep70.diff`, `upg81.diff`) can serve as a starting point. If you want me to implement it, I'd start with section B, the changes that ship first on 7.0, as a separate change.