The upgrade from Rails 7.0.8.7 to 8.1.0 is workable, but the app will not boot without changes. It needs 13 code fixes, two test-helper updates and a `json` pin. Five of the changes don't break boot or tests, and two of those silently damage data: a failed import would leave partial records, and a version rollback would break queued digest jobs.

In a disposable copy, all 46 tests pass on 8.1.0 with these fixes, and with no deprecation warnings. The fixes that also work on 7.0 pass there too. The real repository was not changed (`git status` is clean).

## Required changes

**A. Changes that work on 7.0 too and can ship first** (all tests passed on 7.0 with A1–A11 applied, `/tmp/exp/logs/test70prep.log`):

| # | Where | What breaks on 8.1 | Fix | Caught by tests? |
|---|---|---|---|---|
| A1 | `config/initializers/action_text.rb` | `allowed_tags` starts as nil, so `+=` crashes at boot | Set the full list inside `config.after_initialize`: sanitizer tags + attachment tag, `figure`, `figcaption`, `details`, `summary` | Yes, boot fails |
| A2 | `app/models/citation/provider.rb`; test helper `with_provider` and line 45 of `test/controllers/citation_enrichments_controller_test.rb` | `Rails.application.secrets` was removed (7.2) | Use `config_for` with the same ERB `.to_json` quoting (keeps values like `"00123"` and `"sample: value # keep"` as strings); tests stub the provider instead of changing secrets | Yes |
| A3 | `app/models/note.rb:10` | Keyword-style `enum status:` is gone | `enum :status, {...}, prefix: true` (same method names) | Yes |
| A4 | `app/models/note.rb:14` | `alias_attribute` pointing at the `color` store accessor (not a column) raises | Two `alias_method` lines (reader and writer) | Yes |
| A5 | `app/models/note.rb:61` | An integer `wait_until` can't be serialized (`Integer#utc`) | `wait_until: Time.at(reminder_epoch)` | Source only |
| A6 | `app/models/export.rb` (`fragments.sum`) | Rails no longer sums strings, so it raises `TypeError` | `fragments.join` | Source only |
| A7 | `config/routes.rb:18` | `get "/notes", "/journal"` (two paths in one route) raises | Two routes with `as: :notes` and `as: :journal`; names checked against 7.0 `rails routes` | Yes |
| A8 | `app/views/notes/index.html.erb:12` | `form_with(model: nil, …)` raises | Drop `model: nil` | Yes |
| A9 | `app/controllers/notes_controller.rb:12` | `where(notebooks: @notebook)` now produces SQL for a nonexistent column `notes.notebooks` | `where(notebook: @notebook)` | Yes |
| A10 | `app/views/imports/preview.html.erb` | `stringify_keys` on the annotations hash now turns line numbers into strings, so annotations disappear from the preview | Remove `.stringify_keys` | Yes |
| A11 | `app/models/import.rb` `#receipt` | `citation[:id]` returns nil because the primary key is `doi`, so the receipt's DOI column is blank | `citation&.doi` | Probe confirmed; probably not by tests |
| A12 | `app/models/import.rb` `#apply` | `return false` inside `transaction` now commits, so the import and earlier rows are saved when a later row fails | `saved = rows.all? { ... }; raise ActiveRecord::Rollback unless saved`, then return `saved`. Don't use `return true` inside the block, which rolls back on 7.0 | Yes (counts went from `[0,3,0,1]` to `[1,4,1,2]`). A12 was confirmed only on 8.1; the 7.0 run had the earlier version that would roll back there. |

**B. Changes only possible once on 7.1 or later** (they would break 7.0):
- `serialize :tags, JSON` becomes `serialize :tags, coder: JSON`. The old form raises an argument error.
- In `config/environments/test.rb`, `show_exceptions = false` becomes `:none`. On 8.1, `false` silently means "show all", so the existing `assert_raises(ActiveRecord::RecordNotFound)` tests would get error pages instead of exceptions.
- In `app/jobs/citation_enrichment_job.rb`, `wait: :exponentially_longer` becomes `:polynomially_longer`. It's the same formula under a new name; source shows the old name is gone. Not run on 7.1.

**C. Dependency resolution.** An unconstrained `bundle lock --update rails` pulled in `json` 3.1.0. Rails 8.1.0 passes JSON options positionally, so every read of `Note#tags` failed with an argument error. Constraining to `json < 3` (resolved to 2.21.2) fixed it. Keep that pin until a Rails 8.1.x release supports json 3; I haven't checked which one does.

## Behavior and data changes the tests would mostly miss

1. **Queued digest jobs (rollout and rollback).** On 8.1, `DigestJob`'s `BigDecimal` argument is stored in a format 7.0 can't read. Loading an 8.1 payload on 7.0 fails with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`/tmp/exp/logs/payload81.json`). During a mixed-version deploy or a rollback, those jobs keep failing in Sidekiq. Meanwhile the reader's Redis reservation for the day stays held, so they can't request the digest again. Fix: pass `reading_completion.to_s` from `User#request_digest` and deploy that on 7.0 first. Payloads from 7.0 load fine on 8.1.
2. **Digest day becomes the reader's local day.** 8.1 restores the reader's time zone when the job runs; 7.0 restored UTC. The subject date and `all_day` window would move to the local day, while the reservation key stays on the UTC day. The test caught this ("October 04" instead of "05"). Fix: add `requested_at = requested_at.utc` in `DigestMailer#daily_digest`. This works on both versions and leaves the job arguments as the test expects. Jobs queued under 7.0 already arrive in UTC.
3. **"24 hours later" display.** With A5 and A6 applied, `next_day_reminder_at` shows `2026-11-01T08:00-05:00` instead of the documented `09:00-04:00`. The stored time is the same instant, so postponing is unaffected. Caught by the reminders test. Fix: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`, which works on both versions.
4. **Sidekiq 6.5.12.** It still works on 8.1 through Rails' own adapter, which is deprecated and will be removed in 8.2. This only matters once you move to Sidekiq 7.3.3 or later, not now. Then:
   - `redis.sadd` in `User#request_digest` returns an integer, and `0` is truthy in Ruby, so the once-per-day guard stops working. Use `sadd?`. The deprecation warning about this already appears on redis 4.8.
   - Sidekiq 7's strict arguments reject the symbol-keyed `{ format: "markdown" }` in `Notebook#request_export`.
   - `rescue Redis::BaseError` and the test stubs that raise `Redis::CannotConnectError` need the redis-client error classes.
5. **Stored data.** Existing YAML `preferences` and JSON `tags` read back the same on both versions (probe). Running `db:schema:dump` on 8.1 rewrites `ActiveRecord::Schema[7.0]` as `[8.1]`, which 7.0 can't load. Don't commit that until rollback is no longer an option.

## Optional framework defaults (keep `load_defaults 7.0` during the upgrade)

Adopt these one at a time afterwards:
- **7.1** sets `default_column_serializer = nil`. `serialize :preferences` would then need `coder: YAML`.
- **7.2** sets `postgresql_adapter_decode_dates = true` (from source). `select_rows` would then return `Date` objects, and `Date.iso8601(day)` in `Notebook#daily_note_counts` would raise. With 7.0 defaults it still returns a String (probe).
- Cache, message and cookie format defaults should only change once rollback is no longer needed.

## Experiments

Everything ran in copies under `/tmp/exp`, with its own PostgreSQL 15 on a socket at port 5440 (databases `margin_notes_exp70_test` and `margin_notes_exp81_test`) and its own Redis on 127.0.0.1:6390. 8.1 gems went to `BUNDLE_PATH=/tmp/exp/bundle`. Both services are stopped.

The 8.1 copy (`/tmp/exp/app81`) resolved rails 8.1.0, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, concurrent-ruby 1.3.8 (its 1.3.4 pin was removed in the experiment), minitest 5.27.0, json 2.21.2 and action_text-trix 2.1.19. `bundle install` ended with a Bundler `ENOENT mise` error after installing every gem; `bundle check` then passed.

| Run | Result | Log in `/tmp/exp/logs/` |
|---|---|---|
| 7.0 baseline | 46 passed | `baseline70.log` |
| 8.1, unmodified | Boot fails (A1) | `test81_unmodified.log` |
| 8.1, fixes added step by step | Failures as listed above | `test81_step1.log` … `test81_step6.log` |
| 8.1, all fixes | 46 passed, 0 deprecations | `test81_step7.log` |
| 7.0 with A1–A11 and the A12 variant that rolls back on 7.0 | 46 passed | `test70prep.log` |
| Version probes | Time zones, BigDecimal, `[:id]`, hash keys, dates, serializers; payloads exchanged in both directions | `probe70.log`, `probe81.log`, `payload70.json`, `payload81.json` |
| Action Text and loading | `details`/`summary` kept and `<script>` stripped on both versions; `zeitwerk:check` passed on both | `probe2.log` |

The probe scripts are in `/tmp/exp/scripts`. Findings marked "source only" come from the upstream 8.1.0 code (unpacked under `/tmp/gemsrc/x`) and were not hit by a test.

## Proposed sequence
1. On 7.0, ship A1–A12 together with the digest fixes (`.to_s` and `.utc`) and the "24 hours later" fix. Let any queued digest jobs drain afterwards.
2. Go 7.1, then 7.2, 8.0 and 8.1, keeping `load_defaults 7.0` throughout. At 7.1, apply the three B changes. Pin `json < 3` when resolving 8.x.
3. After each step, run a Sidekiq 6.5 worker against isolated Redis and process real `DigestJob`, `NoteReminderJob` (scheduled), `CitationEnrichmentJob` (forced 503 to exercise retries) and `ExportJob` jobs. Also enqueue jobs on the old version and process them on the new one, and the reverse.
4. Then adopt newer defaults one at a time, and plan the Sidekiq 7.3 move (item 4 above) before Rails 8.2.

## Not yet verified
- Nothing ran on intermediate 7.1/7.2/8.0 versions, in a production-like boot (asset precompile, puma 5 with 8.1, Sidekiq server), or in a browser. `test/system` is empty, and the Trix editor is not pinned in `config/importmap.rb` on either version.
- I didn't check whether a later 8.1.x release fixes json 3 compatibility, or the minitest 6 status.
- The `:polynomially_longer` rename was not run.
- I haven't checked whether any production `preferences` YAML rows contain non-string types that safe loading would reject.

---

**My notes:** This is a plan only. Your repository is unchanged, and Rails is still 7.0.8.7 in `Gemfile` and `Gemfile.lock`. The upgrade skill only plans, so I haven't changed any code yet.

A few things to decide before I implement it:
- **One jump or several steps:** the plan recommends going through 7.1, 7.2 and 8.0 rather than straight to 8.1.0.
- **Ship the 7.0-compatible fixes first?** These are A1–A12 plus the digest and reminder fixes.
- **The `json < 3` pin:** the plan needs it, and your project rules say not to change dependency constraints unless the task authorizes it.