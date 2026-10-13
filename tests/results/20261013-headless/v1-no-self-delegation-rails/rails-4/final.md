I haven't changed your repo. The upgrade skill only plans, so this is the planner's full report on moving from Rails 7.0.8.7 to 8.1.0, unedited:

---

I've written an upgrade plan for this app. Moving from Rails 7.0.8.7 to 8.1.0 needs about 16 code and config changes. In a disposable copy, the unit and integration suite passed on 8.1.0 once they were all applied. Without them the app doesn't even boot. Several of them change data or behaviour without any test failing, so passing tests are not the measure of done. I haven't changed the working repo. The browser tests and a real Sidekiq worker have not been run.

## What I ran
All experiments ran in copies under `/tmp/railsupg/exp`. Each used its own PostgreSQL 15 server (unix socket in `/tmp/railsupg/exp`, port 55432, user `exp`), its own Redis (port 56379, nothing saved to disk), a separate gem directory for the 8.1 copy (`/tmp/railsupg/exp/bundle81`), and the copy's own `tmp/storage`. Settings: `RAILS_ENV=test`, `PARALLEL_WORKERS=1`, `DATABASE_URL=postgres://exp@localhost:55432/<db>?host=/tmp/railsupg/exp`, `REDIS_URL=redis://127.0.0.1:56379/<n>`. Both servers are now stopped and the logs are kept in `/tmp/railsupg/exp/logs/`. I read the upstream code from Rails 7.0.8.7, 7.1.5.1, 7.2.2.1, 8.0.2 and 8.1.0, unpacked in `/tmp/railsupg/gems`.

| Run | Gems | Result | Log |
|---|---|---|---|
| Current app as-is | rails 7.0.8.7 | 46 runs, 0 failures | `baseline-7.0.log` |
| Rails 8.1.0, no code changes | rails 8.1.0, sidekiq 6.5.12, redis 4.8.1, concurrent-ruby 1.3.4, minitest 5.27.0, json 3.1.0 (`resolved-8.1.txt`) | Fails at boot | `test-8.1-unchanged.log`, then steps 2–6 |
| Rails 8.1.0 with all fixes, json pinned below 3 (2.21.2) | as above | 46 runs, 0 failures; `zeitwerk:check` passes | `test-8.1-step7.log`, diff in `variant-8.1.diff` |
| Rails 7.0.8.7 with the fixes that also work on 7.0 | 7.0 lock | 46 runs, 0 failures; `zeitwerk:check` passes | `test-7.0-prep.log`, `prep-on-7.0.diff` |
| What jobs look like in Redis, 7.0 vs 8.1 | real Sidekiq adapter | Format differs (see item 13) | `payload-app70prep.log`, `payload-app81.log` |

## Required changes that also work on 7.0 (do these first and deploy them on 7.0)
All confirmed in the 7.0 run above.

1. **Action Text boot crash** in `config/initializers/action_text.rb`. From 7.1 on, the allowed-tags list starts out empty (`nil`), so `allowed_tags += ...` crashes at boot. Build the list from the default when it's empty, inside `config.to_prepare`. Check: the existing `<details>` sanitising test in `test/controllers/notes_controller_test.rb` still passes.
2. **Enum syntax** in `app/models/note.rb`: change to `enum :status, {...}, prefix: true`. The old keyword style no longer works on 8.x.
3. **`alias_attribute :highlight_color, :color`** in `app/models/note.rb`. `color` is a store accessor, not a column, and from 7.2 this raises an error. Replace it with `alias_method` for the reader and the writer.
4. **Reminder scheduling** in `Note#schedule_reminder`. It passes a plain number to `wait_until:`; from 7.1 that breaks when the job is queued. Use `Time.at(reminder_epoch)`.
5. **Export assembly** in `Export#generate`. From 7.1, `fragments.sum` on strings raises an error; use `fragments.join`.
6. **Import receipt shows blank DOIs** in `Import#receipt`. Citations use `doi` as their primary key, and from 7.1 `citation[:id]` no longer reads it, so the receipt's DOI column comes out empty. Use `note.citation_doi`. The receipt assertion in `imports_controller_test.rb` caught this.
7. **Imports can partly save** in `Import#apply`. A `return false` inside `transaction` used to roll back; from 8.0 it commits. A bad row would leave a half-saved import. Use `raise ActiveRecord::Rollback`. The test "invalid rows ... saves nothing" caught this, but only at the very end.
8. **Citation provider settings** in `Citation::Provider` and `config/secrets.yml`. `Rails.application.secrets` is gone in 7.2. I moved the settings to `config_for(:citation_provider)`, read through `config.x.citation_provider`, and updated the three uses in `test/controllers/citation_enrichments_controller_test.rb`. `secrets.yml` holds no `secret_key_base`, so sessions and signed IDs are unaffected (from reading the file).
9. **Routes** in `config/routes.rb`. `get "/notes", "/journal"` (two paths in one call) is gone in 8.1, and that also removed the `notes_path` helper. Use two `get` lines, with `as: :notes` on the first. Check: compare `bin/rails routes` output on 7.0 before and after.
10. **Search form** in `app/views/notes/index.html.erb`: drop `model: nil` from `form_with`; 8.1 rejects it.
11. **Notebook filter** in `NotesController#index`: change `where(notebooks: @notebook)` to `where(notebook: @notebook)`. The old form produced invalid SQL on 8.1.
12. **Annotations missing from the import preview** in `app/views/imports/preview.html.erb`. `stringify_keys` now really turns the line-number keys into strings, so `annotations[row.line]` stops finding them. Remove the `.stringify_keys`.

## Changes that only work from 7.1 on (do them during the upgrade)
- `serialize :tags, JSON` must become `serialize :tags, coder: JSON`. Also make `serialize :preferences` explicit with `coder: YAML`; it's optional while defaults stay at 7.0, and required once 7.1 defaults are adopted. The stored format doesn't change.
- `retry_on ..., wait: :exponentially_longer` becomes `:polynomially_longer` in `app/jobs/citation_enrichment_job.rb`. Same retry timing.
- In `config/environments/test.rb`, change `show_exceptions = false` to `:none`. On 8.1, `false` is silently treated as "show error pages", so tests would get error pages instead of exceptions. Don't make this change on 7.0, where `:none` would also mean "show error pages".
- Pin `json` below 3 in the Gemfile, or find a Rails 8.1.x patch release that works with json 3 (I haven't checked whether one exists). With json 3.1.0, reading the `tags` column raised `ArgumentError`.

## Behaviour changes the tests only partly reveal
13. **Digest day and the queued-job format** (`DigestJob`, `DigestMailer`, `User#request_digest`):
    - From 7.1, a queued time keeps the reader's time zone (`"time_zone":"America/New_York"`). The digest would then cover the reader's local day, not the UTC day the UI promises. To keep today's behaviour, add `requested_at.in_time_zone(Time.zone)` in the mailer (tested). Changing to local days would be a product decision and needs the UI text updated too.
    - The completion number is now stored as a `BigDecimalSerializer` object instead of a plain string `"0.6667"`. Confirmed in the payload run.
14. **"24 hours later" display** in `Note#next_day_reminder_at`. `to_time` now keeps the time zone rather than the UTC offset, so across a daylight-saving change the hint shows a different time. The stored epoch from `.to_i` is unchanged. Use `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` (tested on both versions).
15. **Sidekiq adapter.** With Sidekiq 6.5.12, the built-in adapter still works on 8.1 but warns that it will be removed in 8.2. Moving to Sidekiq 7.3.3 or later is a separate decision with its own risks:
    - `Notebook#request_export` rescues `Redis::BaseError`, but Sidekiq 7 raises RedisClient errors instead.
    - `User#request_digest` relies on `sadd` returning true/false. A newer client returns 1 or 0, and 0 counts as true in Ruby, so every digest request would look like a fresh reservation. Use `sadd?`.

## Optional defaults (keep `load_defaults 7.0` for the upgrade itself; adopt these one at a time later)
- **`raise_on_assign_to_attr_readonly` (7.1).** The notebook form submits `slug` as a hidden field and the controller permits it, so every notebook update would raise. Remove `:slug` from the update permit first.
- **`default_column_serializer = nil` (7.1).** Needs the explicit `coder:` changes above.
- **`postgresql_adapter_decode_dates` (7.2).** `Notebook#daily_note_counts` calls `Date.iso8601` on raw values. Once dates come back as `Date` objects, that raises `TypeError`. Make it accept a `Date` before turning this on.
- **Action Text sanitizer and cookie/message serializer defaults.** Rich-text bodies contain stored signed IDs (`sgid`). Check that existing bodies still render before adopting these.

## Rollout and rollback with queued jobs
- **Rolling forward is safe in what I read.** 7.0-queued `DigestJob` jobs (completion as a string, time without a zone) and scheduled `NoteReminderJob` jobs (no `scheduled_at` key) load fine on 8.1.
- **Rolling back is not.** 7.0 workers can't load the new BigDecimal format, so 8.1-queued `DigestJob` jobs fail and retry, while that day's Redis reservation stays set and blocks the reader from asking again.
  - Run 8.1 web and workers on the same release, and drain the queues, or delay the cutover.
  - Or step through 7.1 with `use_big_decimal_serializer` off, then on.
  - Or pass completion as `.to_s` so it's never a BigDecimal. That works on both versions.
- **Old 7.0 workers ignore** the new `time_zone` and `scheduled_at` keys.
- **Stored data:** YAML `preferences`, JSON `tags`, the schema and Active Storage keys don't change unless the optional defaults above are adopted.
- **Partial imports:** if any 8.x code without fix 7 ever runs, it can commit partial imports. Rolling back won't undo them.

## Not yet checked
- **Browser tests** (`bin/rails test:system`), especially the vendored Trix 1.3.5 alongside Action Text 8.1's JavaScript. Whether 8.1 expects Trix 2 or a separate trix gem is unverified.
- **A real Sidekiq 6.5.12 worker on 8.1** running a reminder, an export, and a retried citation lookup against isolated Redis.
- Running the app with `config.active_support.report_deprecations = true` in a production-like environment.
- Whether the old payloads in the live Redis match what I captured.
- The suggested path is to go one minor version at a time (7.1, 7.2, 8.0, 8.1) with deprecation warnings turned into errors. I jumped straight to 8.1.0 in the experiment.

---

**My notes:**
- This is a three-version jump. I'd do items 1–12 first as their own change and deploy it on 7.0.
- Two decisions are yours before anyone implements this:
  - Whether to pin `json` below 3.
  - How to handle digest jobs already in the queue if you roll back. The simplest option is passing completion with `.to_s`.

Should I start with the changes that work on 7.0?