# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

**Bottom line:** the upgrade needs 13 code and configuration changes, and without them the app fails at boot. Several further changes alter behaviour or stored data without any error. Most of the required fixes can ship ahead of time on Rails 7.0; all 46 tests passed on 7.0 with them applied. Rolling back has one real risk: digest jobs queued by 8.1 crash on 7.0 workers.

The working repo was not changed and `git status` is clean. The experiments' databases and Redis instance were removed afterwards.

The plan below is the `maintain-rails:gem-upgrade-planner` agent's output, reproduced verbatim. I dropped only its opening line, which wrongly said it could not delegate to itself, and its own summary paragraph, which I rewrote above with the counts corrected. The rest of my notes follow the plan.

## How the experiments were isolated
- **Disposable copy:** `/tmp/mn-upg/app`, a copy of the repo without `.git`, with `Gemfile` changed to `gem "rails", "8.1.0"`. Bundler config was kept separate (`BUNDLE_APP_CONFIG=/tmp/mn-upg/bundlecfg`).
- **Databases:** renamed to `mn_upg_*`. A second copy at `/tmp/mn-upg/prep70` (still Rails 7.0) used `mn_prep_*`. Both test databases were dropped afterwards.
- **Redis:** a separate instance on port 6391, with `REDIS_URL=redis://127.0.0.1:6391/0`. It was shut down afterwards. Storage and cache were local to each copy.
- **Dependencies:** `bundle lock --update rails` (`/tmp/mn-upg/logs/bundle-lock.log`; changes in `/tmp/mn-upg/logs/lock-diff.txt`) resolved:
  - All Rails components at 8.1.0, plus action_text-trix 2.1.19.
  - rack stays at 2.2.24 because puma 5 and sidekiq 6.5 hold it back.
  - sidekiq 6.5.12, redis 4.8.1 and puma 5.6.9 are unchanged.
  - The resolver also pulled in json 3.0.2, which had to be pinned back (finding 1).
- **Test runs:** each run was `PARALLEL_WORKERS=1 bin/rails test`. Logs are in `/tmp/mn-upg/logs/`, `test-8.1.log` through `test-8.1-h.log` in order.
  - On 8.1 the first runs had all 46 tests erroring.
  - After the changes below were applied in the copy: `test-8.1-h.log` shows 46 runs, 0 failures. `zeitwerk:check` passes (`zeitwerk.log`). A production boot and `assets:precompile` both succeed (`boot-prod.log`, `assets.log`).
  - On 7.0 with only the 7.0-compatible changes: `test-7.0-prep.log` shows 46 runs, 0 failures. The diff is in `/tmp/mn-upg/logs/prep70.diff`.
- **Job payload checks across versions:** scripts `/tmp/mn-upg/ser.rb` and `/tmp/mn-upg/sched.rb`; output in `/tmp/mn-upg/logs/mixed-version-args.log` and `mixed-version-job-payload.log`.

## A. Required changes

Each finding lists what breaks, the fix, whether the fix also works on 7.0, and how it was found: **executed** (reproduced in the copy) or **source** (read in the 8.1.0 gems).

1. **Gemfile: json 3.0.2 breaks Active Support 8.1.0.** The resolver pulled in json 3.0.2. `ActiveSupport::JSON.decode` then raises `ArgumentError (given 2, expected 1)`, which breaks every `serialize :tags, coder: JSON` read and rollback.
   - Fix: add `gem "json", "< 3"` (resolved 2.21.2), or target a later 8.1.x patch and re-check. Rails 8.1.4 exists on rubygems; it was not tested.
   - On 7.0: not needed. Executed.
2. **`/home/user/workspace/repo/config/initializers/action_text.rb`: boot crash.** `allowed_tags` now defaults to nil, so `+=` raises `NoMethodError` and the app does not boot.
   - Fix: inside `config.after_initialize`, set `allowed_tags` to the sanitizer's allowed tags plus the attachment tag, `figure`, `figcaption`, `details` and `summary`.
   - On 7.0: works. Executed.
3. **`app/models/note.rb:10`: old enum syntax removed.** Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. On 7.0: works. Executed.
4. **`app/models/note.rb:12`: positional `serialize :tags, JSON` raises.** Fix: `serialize :tags, coder: JSON`. This is **7.1+ only**, so it ships with the bump. Executed.
5. **`app/models/note.rb:14`: `alias_attribute` to a `store_accessor` key raises.** Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. On 7.0: works. Executed.
6. **`config/secrets.yml` and `app/models/citation/provider.rb:13`: `Rails.application.secrets` no longer exists.** Two tests also use it (`test/controllers/citation_enrichments_controller_test.rb:45,117-122`).
   - Fix: rename the file to `config/citation_provider.yml` and set `config.x.citation_provider = config_for(:citation_provider)`.
   - On 7.0: works. The experiment used `config_for(:secrets)` as a stand-in. Executed.
7. **`config/routes.rb:18`: a route with two paths now raises `ArgumentError`, so the `notes_path` helper disappears.** Fix: `get "/notes", to: "notes#index", as: :notes` and a separate `get "/journal", to: "notes#index"`. On 7.0: works. Executed.
8. **`config/environments/test.rb`: `show_exceptions = false` no longer means "raise".** Tests that expect `RecordNotFound` fail. Fix: `:none`. This is **7.1+ only**. Executed.
9. **`app/jobs/citation_enrichment_job.rb:7`: `:exponentially_longer` raises at retry time.** Fix: `:polynomially_longer` (7.1+ only). On 7.0 you can use an equivalent lambda instead. Executed.
10. **`app/models/note.rb:61`: `set(wait_until: <Integer>)` raises.** Fix: `wait_until: Time.at(reminder_epoch)`. On 7.0: works. Executed.
11. **`app/models/export.rb:42`: `fragments.sum` over strings raises `TypeError`** (Active Support's string `sum` was removed). Fix: `fragments.join`. On 7.0: works. Executed.
12. **`app/views/notes/index.html.erb:12`: `form_with(model: nil, ...)` raises.** Fix: `model: false`. On 7.0: works. Executed.
13. **`app/controllers/notes_controller.rb:12`: `where(notebooks: @notebook)` now builds SQL on a non-existent `notes.notebooks` column.** Fix: `where(notebook: @notebook)`. On 7.0: works. Executed.

## B. Silent behavior and data changes

Tests caught 14 to 18 only after 1 to 13 were fixed. Several would never show up as a crash in production.

14. **Partial imports get saved (data integrity).** `Import#apply` (`app/models/import.rb:53-57`) does `return false` inside `transaction`. From 7.1 that commits instead of rolling back, so an invalid CSV saves an import row and some notes (test showed counts `[1,4,1,2]` instead of `[0,3,0,1]`).
    - Fix: `raise ActiveRecord::Rollback unless rows.all?(&:save)` style, returning false.
    - On 7.0: works. Executed. **Ship this before the bump.**
15. **Import receipts lose their DOIs.** `Import#receipt` uses `citation[:id]`, but `citations` has primary key `doi` and no `id` column. Since 7.1 this returns nil, so the CSV DOI column comes out blank.
    - Fix: `citation&.doi`. On 7.0: works. Executed.
16. **Annotations disappear from the import preview.** `app/views/imports/preview.html.erb` calls `annotations.stringify_keys`. On HashWithIndifferentAccess, 7.0 keeps integer keys and 8.1 turns them into strings, so `annotations[row.line]` stops matching.
    - Fix: drop `.stringify_keys`. On 7.0: works. Executed (both versions compared directly).
17. **Digests can cover the wrong day.** Since 7.1, Active Job brings a `TimeWithZone` argument back in its original zone instead of UTC. `DigestMailer` would then use the reader's local day, which contradicts ARCHITECTURE.md and the UTC reservation key (test: Oct 04 vs Oct 05).
    - Fix: `requested_at = requested_at.utc` in the mailer, or enqueue `requested_at.utc`. On 7.0: works. Executed.
18. **The postpone preview shows a different offset across a DST change.** `Note#next_day_reminder_at` relies on `to_time` keeping the UTC offset. In 8.1 `to_time` always keeps the full zone, and the setting is deprecated and ignored.
    - Stored `reminder_epoch` and scheduled jobs are unaffected; only the displayed offset changes.
    - Fix, if you want the documented behavior: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. The alternative is to accept the new behavior and update ARCHITECTURE.md and the test.
    - On 7.0: works. Executed (source: `time_with_zone.rb` `to_time`).
19. **Sidekiq.**
    - The built-in `:sidekiq` adapter logs a deprecation in 8.1 and is removed in 8.2 (source: `sidekiq_adapter.rb#check_adapter`). Only an 8.2 upgrade forces moving to sidekiq 7.3.3 or later.
    - That move means `redis-client`, which breaks `Sidekiq.redis { |r| r.sadd/expire/srem }` in `app/models/user.rb:38-43` and the test at `digests_controller_test.rb:65`.
    - `ExportJob`'s symbol-key hash already triggers Sidekiq's "not native JSON" warning, which becomes an error under Sidekiq 7's strict args.
    - Not required for 8.1.
20. **`enqueue_after_transaction_commit` defaults to false in 8.1** (source: `enqueuing.rb:53`), so the "enqueue inside the row lock; failed enqueue rolls back" design in `Note`, `Citation` and `User` keeps working. Do not turn it on: it would break those rollback guarantees.

## C. Optional new defaults (keep `load_defaults 7.0` for the bump; adopt one at a time)

- **7.1 `default_column_serializer = nil`:** `Notebook` `serialize :preferences` (`app/models/notebook.rb:7`) would raise. Add `coder: YAML` first (7.1+ syntax).
- **7.1 `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`:** risky for rollback. Action Text bodies store signed IDs (sgids) in the database. Ones signed after adoption may not verify on 7.0. Not verified; adopt only after the rollback window closes.
- **7.1 `cache_format_version = 7.1`:** 7.0 cannot read the new cache entries. This affects the export fragment cache (the default file store in production). Adopt after rollback is ruled out, or clear the cache on rollback.
- **7.1 `raise_on_invalid_cache_expiration_time`:** `app/views/exports/_export.html.erb:26` uses `expires_in: export.expires_at - Time.current`, which goes negative for expired exports. Clamp it with `[..., 0].max` or skip caching when expired. Not executed.
- **7.1 `sanitizer_vendor` HTML5:** may change the rich-text HTML that gets rendered. Re-run the "keeps collapsible excerpts" test with this setting.
- **7.2 `postgresql_adapter_decode_dates = true`:** `Notebook#daily_note_counts` calls `Date.iso8601(day)`, which would get a `Date` and raise `TypeError`. Not executed; inferred from source. Make it tolerant (`day.is_a?(Date) ? day : Date.iso8601(day)`) before adopting.
- **7.2 `validate_migration_timestamps`:** current migration timestamps (2026-10-11) are fine.
- **8.0 `strict_freshness`:** check that `ExportDownloadsController#stale?` handles both etag and last_modified.
- **8.1 `action_on_path_relative_redirect = :raise`:** no relative redirects found. `raise_on_missing_required_finder_order_columns`: no unordered `first`/`last` found, not verified.
- **Cookies:** `load_defaults 7.0` already sets `cookies_serializer :json` (source: `configuration.rb:231`), so sessions are not affected. There are no `encrypts` declarations, so Active Record encryption defaults do not apply.

## D. Rollout and rollback

- **Digest jobs crash on 7.0 workers (executed).** 8.1 serializes the `BigDecimal` completion with a `BigDecimalSerializer` that 7.0 does not know. A 7.0 worker raises `ActiveJob::DeserializationError`, and Sidekiq then retries it.
  - This hits any mixed deploy (8.1 web, 7.0 workers) and any rollback with `DigestJob`s still queued.
  - Preparatory fix on 7.0: enqueue `reading_completion.to_s`; the mailer already calls `BigDecimal(...)`.
  - The time-zone key that 8.1 adds is ignored by 7.0. A 7.0 payload loads fine on 8.1.
- **The job envelope is compatible both ways (executed).** 8.1 adds `scheduled_at` as an ISO string; 7.0 ignores it. `executions` and `exception_executions` survive. Already-scheduled `NoteReminderJob`s in Sidekiq's schedule are not affected. GlobalID arguments were not tested across versions.
- **Schema file.** The next schema dump writes `ActiveRecord::Schema[8.1]`, which 7.0 cannot load. Commit it together with the Gemfile bump. There are no data migrations.
- **Deploy order:**
  1. Ship the 7.0-compatible fixes: 2, 3, 5, 6, 7, 10–18 and the `.to_s` change.
  2. Bump Rails with 1, 4, 8 and 9, keeping `load_defaults 7.0`. Deploy workers and web together, or drain the `DigestJob` and `CitationEnrichmentJob` queues first.
  3. Adopt new defaults one at a time, each after rollback is no longer possible.
  - Going through 7.1, 7.2 and 8.0 is optional. The run jumped straight to 8.1, and every error was a hard failure with a clear message.

## E. Proposed checks not yet run
- A browser check of Action Text. The layout still loads vendored Trix 1.3.5 alongside `@rails/actiontext` 8.1, and the 8.1 bundle also ships Trix 2. Check editing and loading saved links and attachments, and `test:system` (currently empty).
- Real Sidekiq workers in the copy: enqueue on one version and process on the other for `DigestJob`, `NoteReminderJob` and `CitationEnrichmentJob` retries.
- Development-mode deprecation log under 8.1 (the Sidekiq adapter warning).
- Sanitizer and decode-dates behavior with each new default enabled in the copy.
- Whether Rails 8.1.x later than 8.1.0 removes the need for the json pin.

## Open questions
- Should the postpone preview keep the old fixed-offset display (finding 18)?
- Do you want to stay at exactly 8.1.0 rather than the latest 8.1.x patch?
- Can workers and web be deployed atomically?

The disposable copies are `/tmp/mn-upg/app` (Rails 8.1 with all changes applied) and `/tmp/mn-upg/prep70` (Rails 7.0 with the compatible ones). All logs are in `/tmp/mn-upg/logs/`.

---

**My notes on the plan:**
- **Counts:** the summary I replaced said 11 of the 13 required fixes can ship on Rails 7.0. Section A actually marks 9 as working on 7.0 (2, 3, 5–7 and 10–13). Fix 9 can also ship early if you use the equivalent lambda instead of `:polynomially_longer`. That leaves 4 that go in with the gem bump (1, 4, 8, 9), and fix 1 (the json pin) is simply unnecessary on 7.0 rather than incompatible.
- **Evidence:** I did not re-run any experiment. Everything marked "executed" is the planner's own report, so check the matching logs in `/tmp/mn-upg/logs/` before relying on a result.
