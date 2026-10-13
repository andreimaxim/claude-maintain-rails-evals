I didn't upgrade Rails; this skill only plans. The plan below was written by the planning agent, which tried the upgrade in a separate copy under `/tmp/upg`. In short, 8.1.0 crashes at boot without changes, and the agent's fixes got the copy to a full passing test suite on 8.1.0.

# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The planning agent produced this plan. I made no changes to the working app, and `git status` in `/home/user/workspace/repo` is clean.

## Summary

- **8.1.0 does not work without changes.** Unmodified, the app crashes at boot. After the boot fix, 45 of 46 tests in `bin/rails test` fail. In a disposable copy, the fixes below brought it to 46 runs, 0 failures on 8.1.0.
- **Most fixes can ship first, on 7.0.** The 16 fixes in section A also pass the full suite on 7.0.8.7, so they can ship before the version bump. The four items in section B have to go in with the bump (B4 needs no change for the bump itself).
- **Several changes are silent.** No test fails for them, or they only fail at runtime: the digest date, the reminder preview offset, CSV import receipts, partial imports, and retry handling.
- **Rolling deploys and rollback.** Stored data written by either version reads back correctly in the other, except one case: a digest job queued by 8.1 fails on a 7.0 worker. Adopting some of the newer defaults would also make rollback unsafe.
- **All experiments ran under `/tmp/upg`.** That copy had its own Postgres on port 55432, its own Redis on port 56379, and separate storage and cache directories. During the run, `gem fetch` left a `rails-8.1.0.gem` file in the repo root; it was deleted.

## A. Fixes that also work on 7.0 (ship before the bump)

Each was applied in `/tmp/upg/prep70` on Rails 7.0.8.7, and the full suite passed: 46 runs, 0 failures (`/tmp/upg/logs/prep70_test.log`).

1. **Secrets: `app/models/citation/provider.rb:13`, `config/secrets.yml`, and the `with_provider` helper in `test/controllers/citation_enrichments_controller_test.rb`.**
   - Problem: `Rails.application.secrets` no longer exists in 8.1 (NoMethodError seen).
   - Fix:
     - Move the values to `config/citation_provider.yml`, keeping the same ERB and environment variables.
     - Set `config.x.citation_provider = config_for(:citation_provider)`.
     - Read `Rails.configuration.x.citation_provider.to_h` as the default, and update the test helper to match.
     - Delete `secrets.yml`.
   - Deployment: production must keep the same `CITATION_PROVIDER_*` environment variables.

2. **Action Text allowed tags: `config/initializers/action_text.rb`.**
   - Problem: `ActionText::ContentHelper.allowed_tags +=` crashes boot (`undefined method '+' for nil`), because from 7.1 `allowed_tags` starts as nil.
   - Fix: set the full list explicitly inside `config.after_initialize` plus `ActiveSupport.on_load(:action_view)`. Start from the existing list or the sanitizer's default, plus the attachment tag, `figure` and `figcaption`, then add `details` and `summary`.
   - Check: `notes_controller_test.rb:137` asserts that `details`/`summary` survive.

3. **Enum syntax: `app/models/note.rb:10`.**
   - Problem: `enum status: {...}, _prefix: true` raises ArgumentError in 8.1.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`.

4. **Highlight colour alias: `app/models/note.rb:14`.**
   - Problem: `alias_attribute` on `color`, which comes from `store_accessor`, raises "color is not an attribute".
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. The form, controller parameters and views only use the reader and writer.

5. **Reminder scheduling: `app/models/note.rb:61`.**
   - Problem: `set(wait_until: reminder_epoch)` gets an Integer and fails in 8.1 (`undefined method 'utc' for Integer`).
   - Fix: `wait_until: Time.at(reminder_epoch)`. The scheduled time is unchanged; the test asserts the exact time.

6. **Reminder preview offset (silent): `app/models/note.rb:44`.**
   - Problem: in 8.1, `reminder_at.to_time` keeps the full time zone instead of just the offset. Across a daylight-saving change, the "24 hours later" preview shows `-05:00` instead of the documented `-04:00`. The postponed epoch itself (`.to_i`) is unchanged.
   - Fix: `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)` keeps the documented display. Alternatively, accept the new display as a product decision and update the comment and `reminders_controller_test.rb:21`.

7. **Export assembly: `app/models/export.rb:42`.**
   - Problem: `fragments.sum` on strings fails in 8.1 (`String can't be coerced into Integer`), so every export would fail in the worker.
   - Fix: `fragments.join`.

8. **Partial imports (data integrity): `app/models/import.rb:54-63`.**
   - Problem: on 8.1, `return false` inside `transaction` commits instead of rolling back. An import with an invalid row saves the import and the rows before it. Observed: record counts went from `[0,3,0,1]` to `[1,4,1,2]`.
   - Fix: `raise ActiveRecord::Rollback` when any row fails, and return the transaction's value `|| false`.

9. **CSV receipts (silent data-format change): `app/models/import.rb:67`.**
   - Problem: `citation[:id]` returns nil in 8.1, because Citation's primary key is `doi`. Receipts would get an empty DOI column.
   - Fix: `citation&.doi`.

10. **Import preview: `app/views/imports/preview.html.erb:22`.**
    - Problem: `.stringify_keys` now really turns the integer line keys into strings, so annotations disappear from previews.
    - Fix: drop `.stringify_keys`.

11. **Search form: `app/views/notes/index.html.erb:12`.**
    - Problem: `form_with(model: nil, ...)` raises in 8.1.
    - Fix: drop `model: nil`.

12. **Notes query: `app/controllers/notes_controller.rb:18`.**
    - Problem: `where(notebooks: @notebook)` generates SQL for a `notes.notebooks` column that doesn't exist.
    - Fix: `where(notebook: @notebook)`.

13. **Routes: `config/routes.rb:18`.**
    - Problem: `get "/notes", "/journal", to:` (several paths in one call) raises in 8.1.
    - Fix: two `get` lines, which keeps the `notes` and `journal` route helpers.

14. **Retry delay (fails only at runtime): `app/jobs/citation_enrichment_job.rb:7`.**
    - Problem: `wait: :exponentially_longer` raises "Couldn't determine a delay" only when the citation provider is actually down. A failed lookup would then stay stuck in "pending".
    - Fix: `wait: ->(executions) { executions**4 + 2 }`, the same curve without jitter. The alternative, `:polynomially_longer`, only exists from 7.1.

15. **Digest date (silent): `app/mailers/digest_mailer.rb:7`.**
    - Problem: from 7.1, Active Job keeps a time's zone when queuing it. The digest then covers the reader's local day instead of the documented UTC day. Observed: October 04 instead of October 05.
    - Fix: call `requested_at = requested_at.utc` before `to_date` / `all_day`. This also handles jobs already queued by 7.0, which carry no zone.

16. **Digest job across versions (rolling deploy and rollback): `app/models/user.rb:41`.**
    - Problem: 8.1 always serializes BigDecimal with its own serializer. A DigestJob queued by 8.1 fails on a 7.0 worker with "Serializer ActiveJob::Serializers::BigDecimalSerializer is not known".
    - Fix: pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`.

## B. Changes that only work with the bump (same deploy as Rails 8.1)

1. **Tags column: `app/models/note.rb:12`, `serialize :tags, coder: JSON`.**
   - On 7.0 this keyword is mis-handled without an error: tags load as a String, giving 15 test errors (`/tmp/upg/logs/prep70_test_with_coder_kw.log`).
   - It must not ship before the bump. The stored format is unchanged (`["a","b"]`).

2. **Test exceptions: `config/environments/test.rb`, `show_exceptions = :none`.**
   - On 8.1, leaving it as `false` turns not-found errors into 404 pages, so tests expecting `RecordNotFound` fail.
   - On 7.0, `:none` counts as true and breaks the same tests the other way.

3. **json pin: Gemfile `gem "json", "< 3"`.**
   - Rails 8.1.0's `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)`, which json 3.1.0 rejects ("wrong number of arguments"). That breaks every JSON-serialized column.
   - The pin is harmless on 7.0.
   - Not checked: whether a later 8.1 patch (up to 8.1.4) removes the need for it.

4. **Notebook preferences: `Notebook` `serialize :preferences` (no coder).**
   - No change needed while `load_defaults 7.0` keeps YAML as the default.
   - It becomes required before adopting the 7.1 defaults (see C1).

## C. Optional new defaults (keep `config.load_defaults 7.0` for the bump)

Adopt these one at a time, only after 8.1 is stable and rolling back to 7.0 is no longer needed.

1. **`default_column_serializer = nil` (7.1).** Requires `serialize :preferences, coder: YAML` first.
2. **`raise_on_assign_to_attr_readonly = true` (7.1).** `NotebooksController` permits `:slug`, and `Notebook` has `attr_readonly :slug`, so updates that submit the hidden slug field would raise. Remove `:slug` from the update parameters first.
3. **`cache_format_version 7.1`.** 7.0 cannot read the new format.
   - Production uses the default per-host FileStore (the fragment cache in `exports/_export.html.erb`).
   - After a rollback this only causes cache misses or errors; clearing `tmp/cache` fixes it.
4. **Message serializer settings (`message_serializer`, `use_message_serializer_for_metadata`, 7.1).** These change the format of new signed IDs and SGIDs.
   - Action Text bodies store attachment SGIDs in the database, so after a rollback to 7.0, attachments created on 8.1 might not be found.
   - Adopt only after the rollback window closes. Under the 7.0 defaults, SGIDs were verified to work in both directions.
5. **`enqueue_after_transaction_commit`.** The 8.1 default is false (from reading the source). Do not enable it: `Citation#request_enrichment` and `Note#schedule_reminder` rely on queuing inside the transaction, so a failed queue rolls the change back.
6. **8.0/8.1 defaults.**
   - `to_time_preserves_timezone` is already in effect (see A6) and is deprecated for removal in 8.2.
   - The 8.1 defaults (`escape_json_responses` and others) need a review before adoption.
7. **Active Storage variants.**
   - 8.1 logs a warning that image variants need `image_processing`.
   - Setting `variant_processor = :disabled` silences it but only works on 8.x. The app shows original-size images by design.

## D. Sidekiq and Redis (not required for 8.1.0)

- **Sidekiq 6.5.12 works with 8.1.0.** But Rails' built-in `sidekiq` adapter is deprecated in 8.1 and will be removed in 8.2, which needs Sidekiq 7.3.3 or later. Plan that move before Rails 8.2. It needs two changes:
  - **`Notebook#request_export`:** use string keys in the `{ format: "markdown" }` argument. Sidekiq 6.5 already warns about it, and Sidekiq 7's strict arguments would raise. This change also works on 7.0.
  - **`User#request_digest`:** the `sadd` result becomes an Integer, so `0` would count as true and allow duplicate digests. Compare with `== 1`.
- **Queued and scheduled work was checked in both directions** with the real Sidekiq adapter and Redis. CitationEnrichmentJob, NoteReminderJob (scheduled set) and ExportJob run on both versions. The only failure is DigestJob queued by 8.1 and run by 7.0 (A16).
- **Before the bump,** deploy A16 first or drain the default queue. Reminders queued by 7.0 can sit in the scheduled set for a long time.

## E. Rollout order

1. **Deploy group A on 7.0** and watch it in production: CSV receipts, imports, reminders and digests.
2. **Deploy the bump:** Rails 8.1.x, the json pin and group B together. Upgrade web and workers together, unless A16 is already live.
3. **Rollback to 7.0 is data-safe under the 7.0 defaults.** This was verified in both directions for:
   - Notebook YAML preferences and the JSON tags column;
   - Action Text bodies with SGIDs;
   - blob signed IDs and downloads;
   - message verifier and encryptor output;
   - FileStore cache entries.

   A rollback must also revert group B in code. `db/schema.rb` will be regenerated as `Schema[8.1]`, so don't run migrations that need 8.1 until the rollback window ends.
4. **Adopt group C** one setting at a time after things are stable.

## Executed checks

All runs used Ruby 3.3.6 and Bundler 2.5.22, with logs in `/tmp/upg/logs/`.

- **Environment files:** `/tmp/upg/env.sh` (test) and `/tmp/upg/xenv.sh` (development, database `margin_notes_xver`, Redis db 3).
- **Isolated services:** Postgres cluster `/tmp/upg/pgdata` on port 55432 and Redis on port 56379. Both are now stopped.
- **Full experimental patch:** `/tmp/upg/logs/r81_vs_base.diff`.

| Check | Copy and dependencies | Result | Log |
|---|---|---|---|
| Baseline `bin/rails test` | `/tmp/upg/base`, rails 7.0.8.7 | 46 runs, 0 failures | `base_test.log` |
| `bundle update rails --conservative` | `/tmp/upg/r81`: rails 8.1.0, json 3.1.0 (2.21.2 after the pin), rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9 | lock diff recorded | `r81_bundle.log`, `r81_bundle_json.log` |
| `zeitwerk:check` on unmodified 8.1 | r81 | boot crash in `action_text.rb` | `r81_zeitwerk.log` |
| Repeated test runs with fixes | r81 | ends at 46 runs, 0 failures, no deprecations | `r81_test1.log` to `r81_test7.log` |
| Group A on 7.0 | `/tmp/upg/prep70` | passes; the `coder:` variant fails | `prep70_test.log`, `prep70_test_with_coder_kw.log` |
| Data and jobs across versions | `/tmp/upg/scripts/write.rb`, `read.rb` | all readable except DigestJob 8.1 to 7.0 | `xver_*.log` |
| Action Text rendering and export Markdown | `scripts/render.rb` | identical on 7.0 and 8.1 | `render70.log`, `render81.log` |
| Production `assets:precompile` and boot | r81 | succeeds, with the image_processing warning | `r81_precompile.log`, `r81_prod_runner.log` |

These points come from reading the 8.1.0 gem sources, not from running anything:
- the sidekiq adapter deprecation;
- the `enqueue_after_transaction_commit` default;
- the BigDecimal and TimeWithZone job serializers;
- the `polynomially_longer` retry algorithm;
- the `to_time_preserves_timezone` deprecation;
- `default_column_serializer`;
- the list of 7.1 defaults.

## Proposed checks (not yet run)

- **Browser suite on 8.1:** run `bin/rails test:system`; Chrome isn't installed here. Check that the Trix editor loads (importmap pins only `@rails/actiontext`) and that attachments upload and render.
- **Latest patch:** repeat everything on 8.1.4 and check whether the json pin is still needed.
- **Real Sidekiq workers across versions:** run actual `sidekiq` processes against queues filled by the other version, in both directions. Include CitationEnrichmentJob retries with the new delay.
- **Sessions:** confirm a sign-in survives the 7.0 to 8.1 deploy and the rollback. Only the verifier and encryptor were tested, not the session cookie itself.
- **Remaining deprecations:** run under production with deprecations reported to list what 8.2 will remove.

## Unverified claims and open questions

- **Which release introduced each change.** The 7.1, 7.2 or 8.0 attribution comes from reading changelogs; behavior was only tested at 7.0 and 8.1.
- **Long passwords.** From 7.1, `has_secure_password` rejects new passwords over 72 bytes. This was not tested against sign-up or password changes.
- **Product decisions:**
  - Should the digest stay on the UTC day (A15 keeps that) or move to the reader's local day?
  - Should the 24-hour preview keep the old offset (A6)?
- **Deployment setup.**
  - Is production a single host? The FileStore cache is per host.
  - Are web and workers deployed together? That decides how much the A16 ordering matters.
- **Exact version.** Should you target a later 8.1.x patch instead of 8.1.0, given the security releases since then?

---

**My checks on the plan:** the agent's tool count looked low for this much work, so I checked its logs.
- All the logs in `/tmp/upg/logs/` exist, including the 245-line `r81_vs_base.diff`.
- The test results match the plan: 46 runs, 0 failures for the 7.0 baseline (`base_test.log`), group A on 7.0 (`prep70_test.log`) and the final 8.1 run (`r81_test7.log`).
- `xver_read81_by70.log` shows the `BigDecimalSerializer is not known` error for the digest job, which is fix A16.
- Your repo is still clean, and the stray `rails-8.1.0.gem` is gone.

**Decisions for you:**
- **Version:** stay on exactly 8.1.0 or target the latest 8.1.x patch.
- **Product:** whether the digest stays on the UTC day (A15), and whether the 24-hour reminder preview keeps the old offset (A6).
- **Next step:** if you want, I can implement group A as a first change on 7.0.