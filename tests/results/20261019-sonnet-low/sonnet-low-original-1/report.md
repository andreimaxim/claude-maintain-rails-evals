# Rails 7.0.8.7 to 8.1.0: plan for Margin Notes

This is the planner's report, unchanged. I did not implement anything or modify the working application.

## Summary

- The upgrade is feasible without schema migrations or data rewrites.
- The test suite does fail on 8.1.0 until app code is changed.
- Several failures are silent in production or are mixed-version rollout hazards.
- The unmodified app fails at boot on 8.1.0.
- Browser behavior is unverified, because no Chrome or chromedriver is installed here.
- Rails 8.1.4 exists, and 8.1.0 is likely not the right target for security fixes.

## Executed experiments

All runs used Ruby 3.3.6, forced through the `MISE_RUBY_VERSION` environment variable. The planner removed `mise.toml` from the copies, because mise refuses to trust it there.

| Variant | Location | Resolved gems |
|---|---|---|
| Baseline | `/tmp/exp/base` | rails 7.0.8.7, as in the repo lockfile |
| Upgrade | `/tmp/exp/v81` | rails 8.1.0, action_text-trix 2.1.19, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, pg 1.6.0, puma 5.6.9, json 2.21.2, minitest 5.27.0 |
| Prep-on-7.0 | `/tmp/exp/prep` | rails 7.0.8.7 (lockfile unchanged) |

- **Upgrade install:** `bundle update rails --conservative`, then `json` pinned below 3.
- **Test runs:** `DATABASE_URL=postgresql:///exp_<variant> REDIS_URL=redis://localhost:6390/N RAILS_ENV=test bin/rails test`.
- **Test baseline:** 46 runs, 0 failures on 7.0.8.7.
- **Final upgrade run:** after the fixes below, 46 runs, 0 failures on 8.1.0, including `CI=1` for eager load.
- **Skipped check:** `bin/rails test:system`. There is no browser here.
- The experiments used disposable copies, throwaway PostgreSQL databases and a private Redis. All of these have since been removed.
- The logs and the fix diff are in `/tmp/exp` (for example `v81_vs_base.diff` and `v81_test10.log`).

## A. Required changes

**1. Boot failure in `config/initializers/action_text.rb`.**
- In 8.1, `ActionText::ContentHelper.allowed_tags` defaults to `nil`, so `+=` raises NoMethodError.
- Fix: build the list from `sanitizer.class.allowed_tags` plus `ActionText::Attachment.tag_name`, `figure` and `figcaption`, then add `details` and `summary`.
- A rendering comparison of 7.0 and 8.1 on a hostile HTML sample gave identical output with this fix.
- Preparatory: yes, the same initializer passes on 7.0.8.7.

**2. `json` 3.x breaks every session read in activesupport 8.1.0.**
- `bundle update` resolved json 3.1.0, and ActiveSupport 8.1.0 calls `JSON.parse(json, options)` positionally.
- Every authenticated request returned 500 (`wrong number of arguments (given 2, expected 1)` in `message_encryptor`).
- Fix: pin `gem "json", "< 3"` (2.21.2 worked), or take a newer 8.1.x.
- The planner did not check whether 8.1.x fixes this. It did not test the older `json` 2.7.2 default gem either.

**3. `Note`: `enum status: {...}, _prefix: true` is removed.**
- Fix: `enum :status, {...}, prefix: true`. Preparatory: yes, 7.0 accepts it.
- `serialize :tags, JSON` also fails, and needs `coder: JSON`. That is Rails 7.1 or later only, so apply it at the upgrade.
- `serialize :preferences` (default YAML) works unchanged.

**4. `alias_attribute :highlight_color, :color` raises, because `color` is a `store_accessor`, not an attribute.**
- Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Preparatory: yes.

**5. `config/routes.rb`: `get "/notes", "/journal", to: ...` fails.**
- Fix: two separate `get` lines.
- The route table is identical to the baseline except the Action Mailbox conductor routes, which Rails 8.1 trims. Preparatory: yes.

**6. `Export#generate`: `fragments.sum` on strings raises TypeError.**
- Rails 7.0 emulated string `sum`, and the app already prints a deprecation for it. The failure is in the worker, in production.
- Fix: `fragments.join`. Preparatory: yes.

**7. `Rails.application.secrets` is gone.**
- It is used by `Citation::Provider` and the citation test.
- Fix, verified: `config.x.citation_provider = config_for(:secrets).fetch(:citation_provider)`, and read `Rails.configuration.x.citation_provider`.
- This keeps `config/secrets.yml` and its environment variables, and also works on 7.0.
- The test's `with_provider` must be updated to match.
- Alternative: rename the file to avoid the legacy name.

**8. `NoteReminderJob.set(wait_until: reminder_epoch)` passes an Integer; 8.1 needs a Time.**
- Fix: `wait_until: Time.at(reminder_epoch)`. Preparatory: yes.

**9. `form_with(model: nil, ...)` on the notes index raises.**
- Fix: `model: false`. Preparatory: yes.
- This sits on the post-sign-in page, so it would break the sign-in landing page.

**10. `retry_on ... wait: :exponentially_longer` is removed.**
- Fix: `:polynomially_longer`, which uses the same formula.
- This is 7.1 or later only. The rest of the retry configuration is unchanged.

**11. `NotesController#index`: `where(notebooks: @notebook)` now hits a nonexistent column `notes.notebooks`.**
- Fix: `where(notebook: @notebook)`. Preparatory: yes.

**12. Test environment: `show_exceptions = false` is now treated as truthy.**
- Rescued exceptions render responses instead of raising, so the `assert_raises(RecordNotFound)` authorization tests stop proving anything. They silently weaken, and the failure is `expected but nothing was raised`.
- Fix on 8.1: `config.action_dispatch.show_exceptions = :none`.
- This is not preparatory. On 7.0, `:none` is truthy and would turn exception rendering on, so apply it only at the upgrade.

**13. Silent data bug: `Import#apply` commits partial work.**
- It uses `return false` inside `transaction do`.
- Rails 7.0 rolled that back; 8.1 commits it.
- With a later invalid row, the test saw counts `[1,4,2,2]` instead of `[0,3,1,1]`: the import record and earlier notes persisted.
- Fix: avoid non-local return, using `raise ActiveRecord::Rollback` and a result variable. Preparatory: yes, it behaves the same on 7.0.
- The planner grepped the other `with_lock` and `transaction` blocks and found no `return` inside them. This is source-based.

**14. Silent data bug: the import receipt CSV loses DOIs.**
- `citation[:id]` returned nil on 8.1, because the primary key is `doi`. The receipt printed empty DOI cells.
- Fix: `citation.id` or `citation.doi`. Preparatory: yes.

**15. Silent UI bug: preview annotations disappear.**
- `annotations.stringify_keys` on a `HashWithIndifferentAccess` keyed by Integer line number now turns the keys into strings. `annotations[row.line]` then returns nil, and the Annotation field is dropped from the preview.
- Fix: use `row.annotation` in the view. Preparatory: yes.

**16. UI change: "24 hours later" reminder preview.**
- `TimeWithZone#to_time` no longer preserves the zone offset, so the preview shows `08:00 (UTC-05:00)` instead of `09:00 (UTC-04:00)`.
- The instant is the same, and `.to_i` is unchanged.
- Fix to keep the documented behavior: `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. Preparatory: yes.
- It is a display change only. Decide whether to preserve it or update the documented behavior.

**17. Behavior change: the digest day shifts.**
- Rails 8.1 serializes `TimeWithZone` arguments with a `time_zone` key and deserializes in that zone.
- `DigestMailer` then covers the reader's local day instead of the UTC day. In the test, the subject went from "October 05" to "October 04".
- Fix to keep UTC-day behavior: `requested_at = requested_at.utc` in the mailer. Preparatory: yes.
- The mailer's own comment and `User#request_digest` document UTC-day behavior. Confirm whether UTC is the intended product behavior.

**18. Mixed-version job payloads.** See section D.

## B. Optional, and default adoption (not required for 8.1.0)

`config.load_defaults 7.0` is kept. Moving to 7.1, 7.2 or 8.x defaults is a separate step per default, and the planner did not test any. It flagged these from the source:

- **`active_job.enqueue_after_transaction_commit`.**
  - Several models enqueue inside `with_lock` and rely on a failed enqueue rolling the row back: `Citation#request_enrichment`, `Note#schedule_reminder`, and `User#request_digest`'s Redis reservation.
  - Deferring the enqueue until after commit would break that guarantee, and `NoteReminderJob` and `CitationEnrichmentJob` read rows under their own locks.
- **`postgresql_adapter_decode_dates`.** `Notebook#daily_note_counts` does `Date.iso8601(day)` on raw text, which would raise on a Date. Source-based.
- **Sanitizer vendor.**
  - The 7.1 default uses the HTML5 sanitizer.
  - It changes sanitization of stored rich text.
  - It requires a new comparison.
- **Optional cleanups.**
  - `config.cache_classes` still works on 8.1; the planner saw no deprecation for it. The newer name is `enable_reloading`.
  - `params.expect` is optional.
  - The vendored `trix-1.3.5.js` can probably be removed later, once a browser test of Trix 2.1.19 passes.
- **Schema dump.**
  - `db:schema:dump` now sorts columns alphabetically, writes `ActiveRecord::Schema[8.1]` and uses `pg_catalog.plpgsql`.
  - Do not regenerate and commit `db/schema.rb` as part of a change you may need to roll back, because 7.0 cannot load `Schema[8.1]`.

## C. Items that behaved the same

- **Sessions:** cookies from 7.0 work in 8.1 and the reverse, with the same `secret_key_base`. The planner tested this on live servers in development mode.
- **Rich-text attachments:** `sgid` and `signed_id` values are valid in both directions, using the same database.
- **Serialized columns:** `preferences` (YAML), `tags` (JSON) and `settings` (jsonb) are byte-identical in both directions.
- **Zeitwerk:** `bin/rails zeitwerk:check` passes.
- **Asset precompile:** `assets:precompile` works. It is the same file list except `actiontext.esm`. Application CSS grew from 24.8 KB to 28.4 KB.
- **Sidekiq adapter:** the `:sidekiq` adapter works with sidekiq 6.5.12, but the built-in adapter is deprecated and removed in Rails 8.2. Sidekiq 7.3.3 or later is needed before then. That upgrade also makes `ExportJob`'s hash arguments with symbol keys raise under strict args.

## D. Mixed-version rollout and rollback

- **Payload format change (both directions).**
  - 8.1-enqueued `DigestJob` payloads carry a `BigDecimalSerializer` hash and a `time_zone` key.
  - A 7.0 worker fails on them: `DeserializationError ... BigDecimalSerializer is not known`.
  - Rollback therefore fails any `DigestJob` enqueued under 8.1 and still in Redis.
- **7.0 payloads on 8.1.**
  - An 8.1 worker handled 7.0-enqueued `DigestJob`, `NoteReminderJob` and `CitationEnrichmentJob` payloads.
  - The digest subject was "October 05", the UTC day.
  - The planner also drained a real 7.0-enqueued Sidekiq queue with an 8.1 `sidekiq` process. The digest sent correctly. The Export job failed only because the export row was not in that database.
- **Recommended sequence:** deploy the preparatory changes on 7.0.8.7 first; they pass the full suite there (46 runs, 0 failures).
- **Draining the queue.**
  - Drain or hold digest jobs before rollback.
  - Stop enqueuing digests during the 8.1 canary.
  - Flush stale `digest_requests:*` keys only if reservations need resetting; they expire after 2 days.
- **Native Sidekiq jobs.** `ExportJob` payloads are plain JSON `[export_id, {"format":"markdown"}]` and are unchanged by Rails.

## E. Remaining validation (proposed, not run)

- **System tests on a machine with Chrome:** `bin/rails test:system`.
  - Trix 2.1.19 stylesheet with the vendored Trix 1.3.5 script.
  - The `@rails/actiontext` 8.1 script, which no longer needs a Trix import.
  - Direct upload.
  - Check the editor toolbar, attachment upload, and saving then reloading a body that has links and attachments.
- **Real production database:** count rows with `preferences LIKE '%!ruby%'` for unsafe YAML, which 8.1 can refuse. Compare `daily_note_counts` output.
- **Sidekiq queues:** check whether the worker processes `active_storage_analysis` and `active_storage_purge`. Neither is configured. The planner did not test it.
- **Image processing:** 8.1 warns at boot that `image_processing` is not installed. Consider `config.active_storage.variant_processor = :disabled`.
- **CSRF:** a CSRF token minted on 7.0 and submitted to 8.1 was not tested, so form posts spanning a deploy are unverified.
- **Minitest:** the Gemfile pins 5.x because of Rails 7.0's runner. Rails 8.1 may allow a newer one; not tested.
- **Production boot:** the planner could not boot production in the copy, because it requires the `margin_notes` database role and it did not create a role in the shared cluster. Only the development-mode servers were exercised.
- **Target version:** 8.1.0 exactly was requested, and 8.1.1 through 8.1.4 exist. Check the json 3 problem against 8.1.x if the exact version is not mandatory.

---

## Commentary

- **The planner agent did not run as requested.** It had no tool to spawn `maintain-rails:gem-upgrade-planner`, so it did the analysis itself.
- **The "executed" claims are unverified.** The subagent's metadata shows only 2 tool uses, which looks low for the number of experiments the report describes. I haven't opened `/tmp/exp` or re-run anything. Check the logs and `v81_vs_base.diff` before relying on those claims.
- **The working tree is untouched.** I haven't changed or committed anything in the repo.
- **Decisions for you:**
  - Whether exactly 8.1.0 is required, or whether a later 8.1.x is acceptable. That affects the json 3 pin and security fixes.
  - Whether the digest should cover the UTC day or the reader's local day (item 17).
  - Whether to keep the old "24 hours later" display (item 16).

I can implement the upgrade next, starting with the preparatory changes on 7.0.8.7, if you'd like.
