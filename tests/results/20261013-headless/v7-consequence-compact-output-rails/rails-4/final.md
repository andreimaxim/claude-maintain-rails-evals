# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

On Rails 8.1.0 the app does not boot until about ten things are fixed. After those fixes all 46 tests pass, but four things still change silently, and the existing tests only caught some of them:

- **Imports save partial data.** A failed CSV import now keeps the import and the rows before the bad one.
- **Import receipts lose their DOIs.** The DOI column in the receipt CSV comes out blank.
- **Digests can cover the wrong day.** The email covers the reader's local day, but the "one per day" limit still uses the UTC day.
- **The postponed-reminder preview shows a different time.** It now follows daylight-saving changes instead of keeping the original UTC offset.

There is also one rollout risk: if you roll back to 7.0 after deploying, digest jobs queued by 8.1 fail on the 7.0 workers.

`/home/user/workspace/repo` was not modified. All experiments ran in disposable clones under `/tmp/up/` (details at the end).

## Evidence levels

- **Executed:** I ran it on 7.0.8.7 and/or 8.1.0 and have the log.
- **Source:** I read the gem source or changelog but did not run it.
- **Proposed:** not run yet.

## A. Required changes

| # | Affected code | What happens on 8.1 if nothing is done | Fix | Also works on 7.0? | Evidence |
|---|---|---|---|---|---|
| A1 | `Gemfile.lock` resolves `json 3.1.0` (new dependency via activesupport 8.1) | Every serialized-column read raises `ArgumentError` (`AS::JSON.decode` passes a positional options hash, which json 3 no longer accepts). 34 tests errored. | Add `gem "json", "< 3"` (resolved to 2.21.2), or use a later 8.1.x patch that fixes this (unchecked). | n/a (dependency) | Executed, `test81c.log`, `bt.log` |
| A2 | `config/initializers/action_text.rb` (`allowed_tags += …`) | App fails to boot: `allowed_tags` defaults to nil since 7.1. | In `after_initialize` + `on_load(:action_view)`: `(allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]) + %w[details summary]` | Yes, tests pass on 7.0 | Executed, `boot81.log`, `test70port2.log` |
| A3 | `app/models/note.rb:10` `enum status: {...}, _prefix: true` | `ArgumentError` when the class loads (keyword form removed in 8.0) | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes | Executed |
| A4 | `note.rb:12` `serialize :tags, JSON` | `ArgumentError` (positional coder removed in 7.2) | `serialize :tags, coder: JSON` | **No.** 7.0 has no `coder:`. Ship it with the bump, or in a 7.1 step. | Executed |
| A5 | `note.rb:14` `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`) | `ArgumentError: color is not an attribute` when the class loads | `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=` | Yes; read and write behaviour is identical on both versions | Executed |
| A6 | `config/routes.rb:18` `get "/notes", "/journal", to:` | Routes fail to load (multi-path routes removed in 8.1) | Two routes: `get "/notes", …, as: :notes` and `get "/journal", …, as: :journal`. This keeps both helper names the app has on 7.0. | Yes | Executed |
| A7 | `Citation::Provider#initialize` uses `Rails.application.secrets`; `config/secrets.yml`; test helper `with_provider` | `NoMethodError: secrets` (removed in 7.2) | Move the file to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider).fetch(:citation_provider)`, and update the test to use `Rails.configuration.x`. The env-var test (credentials passed to a fresh `bin/rails runner`) passes. | Yes | Executed |
| A8 | `config/environments/test.rb` `show_exceptions = false` | Setting removed in 7.2 | `:none` | **No.** On 7.0, `:none` is truthy and would show exceptions. Ship with the bump. | Executed |
| A9 | `app/views/notes/index.html.erb:12` `form_with(model: nil, …)` | `ArgumentError` on the notes list, which is the landing page | Drop `model: nil` | Yes | Executed |
| A10 | `notes_controller.rb` `where(notebooks: @notebook)` | `PG::UndefinedColumn notes.notebooks` (plural name for a singular association no longer resolves) | `where(notebook: @notebook)` | Yes | Executed |
| A11 | `Note#schedule_reminder` `set(wait_until: reminder_epoch)` (Integer) | `NoMethodError utc for Integer` (numeric `scheduled_at` removed in 7.2) | `wait_until: Time.at(reminder_epoch)`. Same scheduled epoch; tests assert the `:at`. | Yes | Executed |
| A12 | `CitationEnrichmentJob` `wait: :exponentially_longer` | `RuntimeError` the first time it retries (removed in 7.2) | `:polynomially_longer` (same `executions**4 + 2` curve). | **No**, only exists from 7.1. Ship with the bump. | Executed (error); timing equivalence is source-only |
| A13 | `Export#generate` `fragments.sum` (Strings) | `TypeError`: every export fails in the worker and Sidekiq retries it (the AS `Enumerable#sum` override is gone; 7.0 already warns) | `fragments.join` | Yes | Executed |
| A14 | `Notebook` `serialize :preferences` with no coder | Works under `load_defaults 7.0`. Fails to load once 7.1+ defaults are adopted ("missing keyword :coder"). | `serialize :preferences, coder: YAML` (existing YAML rows still load) | **No** on 7.0; use positional `YAML` there, or ship with the bump | Executed, `test81_defaults_7.1.log` |

## B. Silent behaviour and data changes (tests do not reliably catch these)

**B1. Partial imports get committed (data integrity).**
- **Where:** `Import#apply` uses `return false` inside `transaction`.
- **What changes:** 7.0 rolls back on a non-local return. 7.2+ always commits (`commit_transaction_on_non_local_return` was removed in 8.0). A CSV with a bad row would keep the import plus the earlier notes and citations.
- **Evidence (executed):** The test saw `record_counts` go from `[0,3,0,1]` to `[1,4,1,2]`.
- **Fix:** `raise ActiveRecord::Rollback unless row.note.save` and return `transaction { …; true } || false`. Works on 7.0 too (executed).
- **Before rollout:** Look in production for orphan imports, i.e. imports whose note count is lower than their CSV row count. On 7.0 there should be none.

**B2. Import receipt DOI column is blank.**
- **Where:** `Import#receipt` uses `citation[:id]`. Citations have `primary_key: "doi"` and no `id` column.
- **What changes:** 7.2 removed `read_attribute(:id)` returning a custom primary key, so the receipt CSV has empty DOIs.
- **Evidence (executed).** **Fix:** `citation&.doi`. Works on 7.0.

**B3. Import preview stops showing annotations.**
- **Where:** `preview.html.erb` calls `annotations.stringify_keys`, then looks up `annotations[row.line]` with an Integer.
- **What changes:** 8.0 stringifies Integer keys, so the lookup misses and annotations disappear from the preview.
- **Evidence (executed).** **Fix:** drop `.stringify_keys`. Works on 7.0.

**B4. Digest covers the wrong day.**
- **Where:** `DigestJob`, `DigestMailer#daily_digest`.
- **What changes:** 8.1 serializes the `TimeWithZone` time zone, so the worker gets the reader's zone. `to_date`/`all_day` become the reader's local day, while the Redis reservation key in `User#request_digest` stays the UTC day. Test result: "October 05" became "October 04".
- **Fix:** `requested_at = requested_at.utc` in the mailer. This handles jobs enqueued by either version. Works on 7.0.
- **Evidence (executed):** Test, plus cross-version serialization (`ser.rb`): 7.0 payloads load in UTC on 8.1, and 8.1 payloads load in Pacific on 8.1.

**B5. Postponed-reminder preview time changes.**
- **Where:** `Note#next_day_reminder_at` (`reminder_at.to_time + 86_400`).
- **What changes:** In 8.1, `to_time` always keeps the zone; `load_defaults 7.0` has no effect (the config is nil and deprecated). The preview changes from `2026-11-01T09:00-04:00` to `08:00-05:00`. The stored epoch is unchanged (both `1793538000`).
- **Evidence (executed):** `totime.rb`.
- **Fix:** If you want the current fixed-offset display: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Works on 7.0. Alternatively, accept the new wall-clock display, which is a product decision, and update the test and the model comment.

**B6. Possible Trix version mismatch (unverified, browser not available).**
- The layout loads vendored classic Trix 1.3.5 (`vendor/javascript/trix-1.3.5.js`).
- In 8.1, Trix comes from the new `action_text-trix 2.1.19` gem. `actiontext.css` (`*= require trix`) now resolves to Trix 2 CSS, which may not match the 1.3.5 JS.
- Assets precompile; `actiontext.js` is UMD and does not import trix.
- **Proposed checks:** run `bin/rails test:system` on a machine with Chrome. Then manually test: edit a note with a link and an attachment, check toolbar styling, upload, and the `details`/`summary` rendering. Then decide whether to move to Trix 2 via importmap.

**B7. Sidekiq.**
- **What changes:** Sidekiq 6.5.12 still works through Rails' built-in adapter, which is deprecated in 8.1 and removed in 8.2 (deprecation logged, executed). `ExportJob` (native) is unaffected.
- **Before 8.2:** upgrade to Sidekiq ≥ 7.3.3. That brings strict JSON args: `ExportJob.perform_async(id, {format: …})` already warns, and redis-client replaces `redis 4.8`. Treat it as a separate project.

## C. Rollout, mixed-version and rollback risks

**C1. Queue compatibility (executed, Redis db 12).**
- Jobs enqueued on 7.0 and run on 8.1: `NoteReminderJob` (scheduled) and `DigestJob` both succeed.
- Jobs enqueued on 8.1 and run on 7.0: `NoteReminderJob` succeeds. **`DigestJob` fails** with `DeserializationError: BigDecimalSerializer is not known`, because 8.x always serializes BigDecimal this way and the opt-out was removed in 8.0. It has no `discard_on`, so Sidekiq retries it and eventually moves it to the dead set.
- **Prep on 7.0 (works on both):** pass `reading_completion.to_s` in `User#request_digest`. The mailer already calls `BigDecimal(params[:completion])`.
- **Deploy order:** upgrade web and workers together, or drain the queue before rolling back.

**C2. Message serializer and Action Text attachments (executed).**
- **Background:** Rich-text bodies store attachment sgids.
- **Old defaults on 8.1:** An sgid written by 8.1 with old defaults is readable by 7.0, and 7.0 sgids are readable by 8.1.
- **Risk:** With `message_serializer = :json_allow_marshal` plus `use_message_serializer_for_metadata = true` (7.1 defaults), sgids written by 8.1 are unreadable on 7.0 (`NoMethodError` in `strict_decode64`).
- **Rule:** adopt those two settings only after rollback to 7.0 is no longer an option. Sessions and cookies follow the same pattern (source).

**C3. Development secret file changes.** The local secret moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`. Existing dev sessions and rich-text sgids in development databases stop resolving unless you copy the file. Seen while setting up the experiment.

**C4. Shipping order.** The 7.0-compatible changes (A2, A3, A5–A7, A9–A11, A13, B1–B5, C1 prep) can ship first, on 7.0. A4, A8, A12, A14 and the json pin must ship with the version bump. You can stage through 7.1 so the A4 and A12 forms can be prepared first.

## D. New framework defaults

The app stays on `load_defaults 7.0` and keeps every old value. I ran the test suite on 8.1 with `load_defaults` 7.1, 7.2, 8.0 and 8.1 (logs `test81_defaults_*.log`).

**7.1**

| Setting | Effect if adopted |
|---|---|
| `default_column_serializer = nil` | Boot error until A14 is done (executed). |
| `raise_on_assign_to_attr_readonly` | `ReadonlyAttributeError` on notebook settings update, because the form resubmits `slug` (executed). Stop permitting `:slug` in `notebook_params` before adopting. |
| `raise_on_invalid_cache_expiration_time` | `exports/_export.html.erb:26` passes a negative `expires_in` for expired exports and raises (executed). Today it is reported and logged. Use `cache_if export.downloadable?` or clamp the value. |
| `message_serializer`, `use_message_serializer_for_metadata` | See C2; adopt only after rollback is off the table. |
| `marshalling_format_version = 7.1` | Cache-format change; rolling-deploy caveat (source). |
| `sanitizer_vendor` HTML5 (Action View and Action Text) | Tests pass, including `details` and unsafe-markup stripping (executed). Re-check how stored rich text renders (proposed). |
| `dom_testing_default_html_version = :html5` | Tests pass. |
| `use_big_decimal_serializer` | Moot: removed in 8.0, always on (C1). |
| `commit_transaction_on_non_local_return` | Moot: removed in 8.0, always commits (B1). |
| `allow_deprecated_singular_associations_name` | Moot: removed (A10). |
| `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records` | No `after_commit` in the app, so no effect. |
| `belongs_to_required_validates_foreign_key` | Skips the parent-existence query on save. FK constraints exist (`notes`, `exports`, `imports`). Low risk. |
| `generate_secure_token_on`, encryption settings (`hash_digest_class`, `support_sha1_…`), `query_log_tags_format`, `sqlite3_adapter_strict_strings_by_default` | Not used by this app, so no effect. |
| `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`, `allow_deprecated_parameters_hash_equality` | Negligible. |

**7.2**

| Setting | Effect if adopted |
|---|---|
| `postgresql_adapter_decode_dates` | `Notebook#daily_note_counts` raises `TypeError` (`Date.iso8601(Date)`) on the activity report (executed). Accept a `Date` or `String`, e.g. `day.is_a?(Date) ? day : Date.iso8601(day)`. |
| `enqueue_after_transaction_commit` | In 8.1 this is no longer set by `load_defaults` (it stays false at 7.2 and 8.1, executed). The gem-changes summary is outdated on this point. Do not enable it: `Citation#request_enrichment` and `Note#schedule_reminder` rely on enqueueing inside the row-lock transaction, so a failed enqueue rolls back. |
| `validate_migration_timestamps` | Existing migrations are valid. |
| `web_image_content_types` adds webp | Webp images display as-is; there are no variants. |
| `yjit` | Memory trade-off in production. |

**8.0**

| Setting | Effect if adopted |
|---|---|
| `to_time_preserves_timezone = :zone` | Already effective regardless of config (B5). |
| `strict_freshness` | `ExportDownloadsController` ETag is the blob checksum, so outcomes are equivalent. The both-headers test passes. |

**8.1:** No new defaults beyond 8.0 reported by the tool.

## E. Not yet verified

- System and browser tests (no Chrome here), including Trix (B6).
- Production boot against a real database. Only precompile, eager load, and dev/test boots were run.
- A real Sidekiq worker process. The cross-version check called the job wrapper's `perform` directly.
- `Note.connection` (`Notebook#daily_note_counts`) gave no deprecation warning but is soft-deprecated; consider `with_connection`.
- Whether 8.1.x patch releases remove the need for the json pin.

## Experiment record

- **Working repo:** `/home/user/workspace/repo`, untouched (`git status` clean).
- **Clones:**
  - `/tmp/up/base`: pristine 7.0.
  - `/tmp/up/new`: 8.1 plus fixes. Diff in `/tmp/up/upgrade81_experiment.diff`, resolved gem changes in `/tmp/up/lock81.diff`.
  - `/tmp/up/port`: 7.0 plus the 7.0-compatible fixes.
- **Resolved versions on 8.1:** rails 8.1.0, json 2.21.2 (after the pin), rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, minitest 5.27.0, concurrent-ruby 1.3.4; Ruby 3.3.6.
- **Isolation:**
  - Databases (dropped afterwards): `mn_upg_base_test`, `mn_upg_new_test`, `mn_upg_port_test`, `mn_upg_cross_dev`, selected via `DATABASE_URL`.
  - Redis: dbs 12–15, empty at start and flushed afterwards. Note that the existing `ExportJob` tests push to real Redis via `REDIS_URL`.
  - Storage and secret files: under each clone.
  - mise config trusted only through the `MISE_TRUSTED_CONFIG_PATHS` environment variable.
- **Commands:** run from each clone root with `RAILS_ENV=test bin/rails db:create db:schema:load`, `bin/rails zeitwerk:check`, `bin/rails test`.

**Logs (all in `/tmp/up/`):**
- Baseline on 7.0: `base_test.log` (46 runs, 0 failures).
- 8.1 iterations: `boot81.log`, `test81a.log` through `test81f.log`. The final run, `test81f.log`, has 46 runs, 340 assertions, 0 failures.
- 7.0-compatible fixes on 7.0: `test70port2.log` (0 failures).
- Defaults matrix: `test81_defaults_{7.0,7.1,7.2,8.0,8.1}.log`.
- Cross-version queue: `cross_enq70.log`, `cross_run81.log`, `cross_enq81.log`, `cross_run70.log`.
- Message serializer / sgid: `sgid.log`.
- Assets and production eager load: `precompile81.log`.
- Change summary from gem-changes: `changes.txt`.
- Probe scripts: `totime.rb`, `ser.rb`, `enq.rb`, `run.rb`, `sgid.rb`.

---

**Next step:** This is a plan only. Your repo hasn't been changed, and nothing is committed. A full working version of the 8.1 changes is in `/tmp/up/upgrade81_experiment.diff`. The system tests and the Trix check (B6) haven't been run because there's no Chrome here.

I'd do it in two stages. First ship the changes that also work on 7.0, then do the version bump (see C4). If you want, I can start by applying those 7.0-compatible fixes on a branch.