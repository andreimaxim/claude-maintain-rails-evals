I haven't upgraded Rails yet; the planning step only produces a plan. The repo is unchanged. Here is the planner's full plan for 7.0.8.7 → 8.1.0:

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but not as a bare Gemfile bump. With only the version changed, the app fails at boot. After 16 code and config changes, the full suite passes on 8.1.0 while keeping `load_defaults 7.0`. Three of those changes fix silent data or behavior changes that the tests did not catch:
- **Partial imports get committed.** An import with a bad row now saves the good rows.
- **Import receipts lose their DOI column.**
- **Digest emails cover the reader's local day instead of the UTC day.**

There is also a rollback hazard: digest jobs queued by Rails 7.2 or later crash on a 7.0 worker. A one-line change, safe on 7.0 today, removes it.

**What I ran.** All experiments were in throwaway copies (`/tmp/up/app` on 8.1.0, plus 7.0, 7.1.6, 7.2.4 and 8.0.5.1 copies). Each used its own Postgres databases (`upg_mn_*`, since dropped), a private Redis on port 6390 (since shut down) and its own `tmp/storage`. The repo at `/home/user/workspace/repo` is unchanged (`git status` clean).

**Evidence files.** Tool index: `/tmp/up/changes.txt`. Full 8.1 diff: `/tmp/up/upgrade-81.diff`. Lockfiles: `/tmp/up/Gemfile.lock.81` (first attempt, which pulled json 3.1.0) and `/tmp/up/Gemfile.lock.81-json2` (with json 2.21.2). Test logs: `/tmp/up/base-test.log`, `/tmp/up/test81-final.log`, `/tmp/up/test-{7.1,7.2,8.0}.log`, `/tmp/up/test81-defaults-{7.1,7.2,8.0,8.1}.log`, `/tmp/up/test70-portable.log`. Mixed-version job test: `/tmp/up/scripts/{enqueue,perform}.rb` with `/tmp/up/payloads-{70,81,81b}.json`.

## Executed results

| Variant | Result |
|---|---|
| Baseline 7.0.8.7 | 46 runs, 0 failures |
| 8.1.0, only the Gemfile changed | Boot fails (`action_text.rb`: `undefined method '+' for nil`); eager load fails (`enum`, then `serialize`) |
| 8.1.0 with the changes below, `load_defaults 7.0` | 46 runs, 0 failures (`test81-final.log`); `zeitwerk:check` OK; dev server on Puma 5.6.9 returns 200 and 302 |
| 7.1.6 / 7.2.4 / 8.0.5.1 with the same changes | All green |
| Portable subset applied to 7.0.8.7 | All green (`test70-portable.log`) |
| 8.1.0 with `load_defaults` 7.1, 7.2, 8.0 or 8.1 (env var `UPG_DEFAULTS`) | 2–3 errors each, see section C |
| 8.1 enqueues, 7.0 performs | DigestJob fails: `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`; passes once the completion is sent as a string |
| 7.0 enqueues, 8.1 performs | All three job types OK |

Resolved dependencies on 8.1: rails 8.1.0, rack 2.2.24 (sidekiq 6.5 keeps rack below 3), puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, minitest 5.27.0, json 2.21.2 after pinning.

## A. Required changes, in the order they would break

"Portable" means the change also works on 7.0.8.7 and can ship before the bump. Unless noted, each was verified on 7.0 and on 8.1.

1. **Action Text tag allowlist crashes boot (7.1+).** In `config/initializers/action_text.rb`, `ActionText::ContentHelper.allowed_tags` is now nil until first use, so `+=` raises at boot.
   - Fix: in `Rails.application.config.after_initialize`, set it to `sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - Portable. The "keeps collapsible excerpts and drops unsafe markup" test passes with both the HTML4 and HTML5 sanitizer.

2. **Keyword-style `enum` (deprecated 7.2, removed 8.0).** `app/models/note.rb:10`: `enum status: {...}, _prefix: true` raises `ArgumentError` at class load.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Portable.

3. **`serialize` with a positional coder (removed 7.2).** `note.rb:12` `serialize :tags, JSON` raises.
   - Fix: `serialize :tags, coder: JSON`.
   - Not portable: the `coder:` keyword only exists from 7.1, so ship it with the 7.1 bump.

4. **`alias_attribute` to a store accessor (removed 7.2).** `note.rb:14` makes every Note load raise "`color` is not an attribute" (22 test errors).
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Portable.

5. **One route with two paths (removed 8.1).** `config/routes.rb` `get "/notes", "/journal", ...` raises when routes load. This is lazy in test, so `zeitwerk:check` does not catch it.
   - Fix: two `get` lines. Portable.

6. **`form_with(model: nil)` (removed 8.0).** `app/views/notes/index.html.erb:12` turns the notes index into a 500. Sign-in lands there, so every user sees it.
   - Fix: drop `model: nil`. Portable.

7. **`where(notebooks: @notebook)` (7.1+).** The notebook filter in `app/controllers/notes_controller.rb:12` fails with `PG::UndefinedColumn notes.notebooks`.
   - Fix: `where(notebook: @notebook)`. Portable.

8. **`Rails.application.secrets` (removed 7.2).** Breaks `app/models/citation/provider.rb:13`, so every citation lookup raises `NoMethodError`. The test helper in `test/controllers/citation_enrichments_controller_test.rb` uses it too.
   - Fix (tested): add `config/citation_provider.yml` with the same ENV keys, `config.x.citation_provider = config_for(:citation_provider)`, and have the provider and test read `Rails.configuration.x.citation_provider`. Portable.
   - Production stays fed by the same `CITATION_PROVIDER_*` variables. Delete `config/secrets.yml` afterwards.

9. **`retry_on wait: :exponentially_longer` (removed 7.2).** Only fails at retry time, so the job raises "Couldn't determine a delay" instead of recording the failure.
   - Fix: `:polynomially_longer`. Same formula, but it only exists from 7.1, so ship it with the 7.1 bump.

10. **`set(wait_until: Integer)` (7.1+).** `note.rb:61` passes epoch seconds, and 7.1 serializes `scheduled_at` as a Time, so scheduling a reminder fails with `NoMethodError: undefined method 'utc' for Integer`.
    - Fix: `wait_until: Time.at(reminder_epoch)`. Portable.

11. **Summing strings (7.1+).** `app/models/export.rb:42` `fragments.sum` raises `TypeError`, so every export fails in the worker.
    - Fix: `fragments.join`. Portable.

12. **`show_exceptions = false` (removed 7.2).** In `config/environments/test.rb`, tests that expect `RecordNotFound` get a 404 page instead of an exception, which masks the authorization tests.
    - Fix: `:none`, from 7.1. Test-only.

13. **Bare `return` inside a transaction now commits (7.2+). Silent data loss.** In `app/models/import.rb` `#apply`, an import with one bad row now saves the import and the earlier rows. Measured: record counts `[0,3,0,1]` became `[1,4,1,2]`.
    - Fix: `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }` inside the transaction, then return whether it committed. Portable.

14. **Import receipt loses its DOI column (7.2+). Silent data change.** In `import.rb` `#receipt`, `citation[:id]` returns nil because Citation's primary key is `doi`. Receipts come out as `On idleness,` with no DOI.
    - Fix: `citation&.doi`. Portable.

15. **Import preview hides annotations (8.0+). Silent.** `HashWithIndifferentAccess#stringify_keys` now converts integer keys, so the `annotations[row.line]` lookup in `app/views/imports/preview.html.erb:22` finds nothing.
    - Fix: drop `.stringify_keys`. Portable.

16. **Pin json below 3.** `bundle update rails` resolved json 3.1.0, which breaks `ActiveSupport::JSON.decode` in 8.1.0 ("wrong number of arguments"), and with it every cookie session.
    - Fix: `gem "json", "~> 2.10"`, or confirm a later 8.1.x patch supports json 3. Unverified whether one does.

## B. Behavior changes that need a decision (tests caught these only because they assert on them)

- **Digest day (7.1+).** Active Job now keeps the time zone of `TimeWithZone` arguments. `DigestMailer#daily_digest` therefore uses the reader's local date, not UTC, which contradicts the UI text "today (UTC)" and the reservation key. An Eastern reader at 03:30 UTC got "October 04" instead of "October 05".
  - Tested fix that keeps current behavior: `requested_at = requested_at.utc` in the mailer. Portable; it is a no-op on 7.0. Mixed versions are fine either way: 7.0 ignores the extra `time_zone` key and 8.1 reads 7.0 payloads.
- **"Postpone a day" preview (8.0 warning, 8.1 forced).** `to_time` now keeps the zone rather than the offset, so `Note#next_day_reminder_at` across a daylight-saving change shows 08:00 −05:00 instead of 09:00 −04:00.
  - The stored epoch is identical (`1793538000` both ways), so only the preview display changes.
  - To keep the documented behavior: `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`. Portable, tested. Otherwise update the comment and test.
  - 8.0 also logs a boot-time deprecation until `config.active_support.to_time_preserves_timezone = :zone` is set. Set that on 8.0 only (7.0 accepts only booleans) and remove it on 8.1, where it is deprecated.
- **Digest jobs fail on rollback (7.2+ always uses the BigDecimal serializer).** `User#request_digest` passes a BigDecimal. Confirmed: an 8.1 payload fails on a 7.0 worker. 7.1 also warns "Primitive serialization of BigDecimal ... deprecated".
  - Fix: pass `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`. Portable; after it, the cross-version run passed.
  - Ship this before the bump so queued and retrying digests survive a rollback.

## C. Optional default adoption (stay on `load_defaults 7.0` for the bump)

Measured on 8.1 with each `load_defaults` level; the full list is in `/tmp/up/changes.txt` lines 11–50.

**7.1 defaults**
- `default_column_serializer = nil`: `notebook.rb:7` `serialize :preferences` raises at class load. Add `coder: YAML` first (7.1+). The data stays YAML, so no migration is needed.
- `raise_on_assign_to_attr_readonly`: the notebook settings update raises `ReadonlyAttributeError: slug`, because the form posts a hidden `slug` and `notebook_params` permits it. Fix (proposed, not run): stop permitting `:slug` and remove the hidden field.
- `raise_on_invalid_cache_expiration_time`: `app/views/exports/_export.html.erb:26` passes `expires_in: expires_at - Time.current`, which is negative once an export expires, so the exports page errors. Fix (proposed, not run): skip caching, or use `[export.expires_at - Time.current, 1.second].max`.
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: 7.0 servers cannot read JSON-serialized messages. Enable only after the 7.0 rollback window has closed.
- `use_big_decimal_serializer`: moot once the `.to_s` change ships.
- `cache_format_version 7.1`, `marshalling_format_version`: affect the production file cache. Enable only after the rollback window.
- `sanitizer_vendor` (HTML5) for Action View and Action Text, and `dom_testing_default_html_version :html5`: tests stay green. Also compare stored rich-text bodies (proposed).
- No visible effect on this app: `belongs_to_required_validates_foreign_key`, `run_after_transaction_callbacks_in_order_defined` (no `after_commit` callbacks), `generate_secure_token_on` (no `has_secure_token`), encryption settings (no `encrypts`), `commit_transaction_on_non_local_return` (made moot by A13), `precompile_filter_parameters`, `query_log_tags_format`, `log_file_size`, `add_autoload_paths_to_load_path`, the `default_headers` change (drops X-XSS-Protection), `debug_exception_log_level`, `allow_deprecated_parameters_hash_equality` (no params/Hash comparisons found), sqlite strict strings (Postgres app).

**7.2 defaults**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises `TypeError` (Date passed to `Date.iso8601`), which breaks the activity report. Fix: `Date.iso8601(day.to_s)`. Portable, tested.
- `enqueue_after_transaction_commit = :default` (7.2 only): if adopted on 7.2, `Citation#request_enrichment` and `Note#schedule_reminder` lose their "failed enqueue rolls back" guarantee. On 8.1 the value is `false` (checked), so current semantics hold.
- `validate_migration_timestamps`, `web_image_content_types` (no variants), `yjit` (memory): low impact.

**8.0 defaults**
- `strict_freshness`: export downloads always send an ETag, so only If-None-Match matters. Low risk.
- `Regexp.timeout = 1` (the tool missed this one): the regexes are bounded (DOI format, 100 KB CSV). Low risk.

**8.1 defaults** (none listed by the tool; read from railties source)
- `raise_on_missing_required_finder_order_columns`, `action_on_path_relative_redirect :raise`, `escape_json_responses false`, `escape_js_separators_in_json false`, `render_tracker :ruby`, `remove_hidden_field_autocomplete`, `yjit` outside local environments.
- The suite showed no new failures from these under `load_defaults 8.1`.

## D. Rollout and mixed-version risks

- **Order:**
  1. Ship the portable fixes on 7.0: A1, A2, A4–A8, A10, A11, A13–A15, the B fixes, and `day.to_s`.
  2. Bump to 7.1 together with A3, A9 and A12.
  3. Then 7.2, 8.0 and 8.1 in turn, keeping `load_defaults 7.0`.
  4. Adopt defaults afterwards, one step at a time.
- **Queued work:** web and Sidekiq workers must deploy together, or workers first. 7.0 payloads ran fine on 8.1. The only reverse failure was BigDecimal, which the B fix removes. Scheduled `NoteReminderJob`s in the Redis `schedule` set survived both directions.
- **ExportJob (native Sidekiq):** unaffected by Rails, but its payload carries a symbol-keyed hash, and Sidekiq warns this "will raise an error in Sidekiq 7.0".
- **Sidekiq 6.5.12 works on 8.1, but the built-in adapter is deprecated** ("will be removed in Rails 8.2"). Moving to Sidekiq 7.3.3 or later is a separate task with its own breakages, from source reading, not tested:
  - `User#request_digest` relies on `sadd` returning a boolean; with redis-client it returns 0 or 1, both truthy, so duplicate digests would be queued.
  - `Notebook#request_export` rescues `Redis::BaseError`.
  - Strict args would reject the symbol-keyed ExportJob hash.
- **Stored data:**
  - Note `tags` stay JSON and Notebook `preferences` stay YAML; no rewrite needed.
  - Session cookies stay `:json` under `load_defaults 7.0`.
  - Any new migration on 8.1 dumps `ActiveRecord::Schema[8.1]`, which 7.0 cannot load. Avoid migrations until the rollback window has closed.

## Still unverified (proposed checks)

- Session cookies and Action Text signed attachment ids (sgid) carried between 7.0 and 8.1 servers: sign in on one version, then request a note with an image attachment on the other.
- A real Sidekiq process with retries, for the `retry_on` attempts and its final block.
- Production boot with `eager_load` and the precompiled-assets path (Sprockets on 8.1).
- The system/browser suite (`bin/rails test:system`) was not run.
- A html4 vs html5 sanitizer comparison over production rich-text bodies.
- Whether a later 8.1.x patch makes the json pin unnecessary.
- A9 is untested on 7.0 because `:polynomially_longer` does not exist there.

---

**My notes:**
- A plain Gemfile bump stops the app from booting, so this needs the code changes above, not a one-line change.
- The planner tested everything in throwaway copies under `/tmp/up`. Your working tree is untouched.
- **Decisions needed from you:**
  - Should the digest stay on the UTC day, or switch to the reader's local day?
  - Should the "Postpone a day" preview keep its current time across daylight-saving changes?
  - Should the Rails bump ship first, or the portable fixes first on 7.0? The planner recommends the fixes first.

If you want, I can start by implementing the portable fixes on a branch, then do the Rails bump as a separate step.