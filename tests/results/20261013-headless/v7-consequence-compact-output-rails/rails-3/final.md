I ran `rails` 7.0.8.7 → 8.1.0 in throwaway copies. Once the required changes below were applied, the upgrade booted and the whole suite passed (46 runs, 0 failures). Unchanged, it does not boot. Some changes don't show up as test failures at all: one silently saves part of a failed CSV import, and one changes which day the digest email covers.

## Where things stand

Testing was done on 8.1.0 directly; I did not boot 7.1, 7.2 or 8.0 on their own. The steps between releases come from the changelogs. The working repository was not touched (`git status` is clean).

| Variant | Directory | Result |
|---|---|---|
| Current 7.0.8.7 | `/tmp/up/app` | 46 runs, 0 failures (`/tmp/up/base-test.log`) |
| 8.1.0, `load_defaults 7.0`, code unchanged | `/tmp/up/app81` | does not boot: `NoMethodError` in `config/initializers/action_text.rb` (`/tmp/up/81-db.log`) |
| 8.1.0 with each fix applied in turn | `/tmp/up/app81` | 0 failures (`/tmp/up/81-test6.log`); full diff in `/tmp/up/variant-81.diff` |
| 7.0.8.7 with the fixes that also work on 7.0 | `/tmp/up/prep70` | 0 failures, 0 deprecations (`/tmp/up/prep70-test.log`) |
| 8.1.0 fixed, then `load_defaults 8.1` | `/tmp/up/app81d` | 3 errors (`/tmp/up/81d-test2.log`; diff in `/tmp/up/variant-81d.diff`) |

- **Isolation:** each copy used its own Postgres 15 cluster (socket `/tmp/up/pg`, port 55432, separate `margin_notes_exp*` databases), its own Redis (port 56379, separate db numbers), and the copy's own `tmp/storage`. Settings are in `/tmp/up/env.sh`. Both services are stopped now.
- **Resolved gems on 8.1:** `bundle update rails --conservative` (`/tmp/up/81-bundle.log`; lock diff in `/tmp/up/81-lockdiff.txt`). It kept rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9 and minitest 5.27.0, and added `action_text-trix` 2.1.19.
- **Behaviour probes:** `/tmp/up/scripts/probe.rb`, output in `/tmp/up/probe-7.0.log`, `probe-8.1.log`, `probe-8.1-fixed.log`, `probe-prep70.log` and `probe-81d.log`.
- **Job payloads across versions:** `/tmp/up/scripts/ser.rb` and `deser.rb`, with payloads in `/tmp/up/jobs-70.json` and `/tmp/up/jobs-81.json`.
- **Other checks on 8.1:** `zeitwerk:check` passed. The production environment eager-loaded (`/tmp/up/81-prod-boot.log`; the database query then failed only because the `margin_notes` role doesn't exist in my cluster). `assets:precompile` passed. A Puma 5 dev server returned 200 on `/session/new` and redirected `/journal` (`/tmp/up/81-server.log`).

## A. Required changes (under `load_defaults 7.0`)

Each item says whether the fix also works on 7.0.8.7, so it can ship before the version bump. "Confirmed" means I saw it in a run.

1. **Gem resolution: `json` 3.1.0.** Rails 8.1 resolved `json` 3.1.0. Its `JSON.parse` no longer accepts the options hash that `ActiveSupport::JSON.decode` passes, so every read of `notes.settings` (the jsonb column) raised `ArgumentError`. Confirmed.
   - Fix: add `gem "json", "~> 2.7"` to the Gemfile (resolved to 2.21.2), unless a later Rails 8.1.x patch fixes this. I didn't check later patches.

2. **Action Text initializer** (`config/initializers/action_text.rb:3`). From 7.1, `ActionText::ContentHelper.allowed_tags` is `nil` until the app sets it, so `allowed_tags += …` stops the app from booting. Confirmed.
   - Fix: in `after_initialize`, set `allowed_tags` to the existing value or the computed default, plus `details` and `summary`. It works on 7.0.
   - Check: the existing "collapsible excerpts" test passed on 8.1 with both the HTML4 and HTML5 sanitizer.

3. **`Rails.application.secrets` is removed in 7.2.** `Citation::Provider#initialize` (`app/models/citation/provider.rb:13`) and `test/controllers/citation_enrichments_controller_test.rb:45,117-122` use it.
   - Fix: move the settings to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider`. It works on 7.0, and the tests passed with it. Production keeps reading the same environment variables.
   - Then delete `config/secrets.yml`. On 7.0 that file can also hold `secret_key_base`; this one doesn't.

4. **`enum` with keyword arguments is removed in 8.0** (`note.rb:10`). The `Note` model fails to load, and all 46 tests errored. Confirmed.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. It works on 7.0 and keeps the same method names.

5. **`serialize :tags, JSON` is removed in 7.2** (`note.rb:12`). Confirmed `ArgumentError`.
   - Fix: `serialize :tags, coder: JSON`. This does **not** work on 7.0 (the `coder:` keyword arrived in 7.1), so it lands with the 7.1 step.
   - Stored data is unchanged: both versions store and read `["a","b"]`.

6. **`alias_attribute :highlight_color, :color` is removed in 7.2** (`note.rb:14`). `color` comes from `store_accessor`, so it isn't an attribute. Confirmed `ArgumentError`.
   - Fix: `alias_method :highlight_color, :color` plus the matching setter. It works on 7.0.
   - Used by the note form, the note list, the note page and the permitted parameters.

7. **Multiple paths in one route are removed in 8.1** (`routes.rb:18`, `get "/notes", "/journal", …`). Routes fail to load. Confirmed.
   - Fix: two `get` lines with `as: :notes` and `as: :journal`. It works on 7.0, and the route names are identical (checked with `bin/rails routes`).

8. **`form_with(model: nil, …)` raises from 8.0** (`app/views/notes/index.html.erb:12`). The notes list returned 500. Confirmed.
   - Fix: drop `model: nil`. It works on 7.0.

9. **`set(wait_until: <Integer>)`** (`note.rb:61`). From 7.1, `scheduled_at` must be a Time, and scheduling a reminder failed with `undefined method 'utc' for Integer` (500). Confirmed.
   - Fix: `wait_until: Time.at(reminder_epoch)`. It works on 7.0.

10. **`where(notebooks: @notebook)`** (`notes_controller.rb:12`). From 7.2 the table-name key is read as a column, giving `PG::UndefinedColumn` when filtering by notebook. Confirmed.
    - Fix: `where(notebook: @notebook)`. It works on 7.0.

11. **`fragments.sum` on strings** (`export.rb:42`). Active Support's override was removed in 7.1, so Ruby's own `sum` raises `TypeError` and every export job fails. Confirmed.
    - Fix: `fragments.join`. It works on 7.0, and the 7.0 deprecation warning goes away.

12. **`return` inside `transaction`** in `Import#apply` (`import.rb:53-58`). This is silent data corruption. On 8.x, leaving the block with `return` commits instead of rolling back. With an invalid second row, 7.0 saved nothing (delta `[0,0]`); 8.1 saved the import and the first note (delta `[1,1]`, test said `[1,4,2,2]`). Confirmed.
    - Fix: `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }` and return a local `saved` flag.
    - Don't use `return true` inside the block: that rolls back on 7.0. The flag version passed on both versions.
    - Rails 7.1 under the 7.0 defaults still rolls back with a deprecation warning, so the change first bites at 7.2/8.0.

13. **`citation[:id]` in `Import#receipt`** (`import.rb:66`). Citations use `doi` as the primary key, and from 7.2 `[:id]` returns nil, so receipts have an empty doi column. Confirmed: `"Good,"` instead of `"Good,10.1234/xyz"`.
    - Fix: `citation&.id`. It works on 7.0.

14. **`@import.annotations.stringify_keys`** (`app/views/imports/preview.html.erb:22`). From 7.1 this returns an indifferent hash with string keys, so `annotations[row.line]` (an Integer) misses and annotations disappear from the preview. Confirmed.
    - Fix: drop `.stringify_keys`. It works on 7.0.

15. **`show_exceptions = false`** (`config/environments/test.rb:31`). Boolean values are removed in 7.2. On 8.1, tests expecting `RecordNotFound` got rendered error pages instead (5 failures). Confirmed.
    - Fix: `:none`. This does **not** work on 7.0, where a symbol counts as true. Change it at the 7.1 step.

16. **`retry_on wait: :exponentially_longer`** (`citation_enrichment_job.rb:7`). Removed in 7.2, so enqueueing raises "Couldn't determine a delay". Confirmed.
    - Fix: `:polynomially_longer`, the same formula. Not available on 7.0, so it lands with the 7.1 step.

17. **Digest day changes** (`DigestMailer#daily_digest`). From 7.1, Active Job keeps the `TimeWithZone` time zone, so a job's `requested_at` arrives in the reader's zone instead of UTC. The digest then covers the reader's local day ("October 04" instead of "October 05"), while the one-per-day reservation key is still the UTC day. Confirmed in a probe and a test.
    - Fix: `requested_at = requested_at.utc` in the mailer. It works on 7.0 and handles both the old and the new payload shape.
    - Or deliberately switch to local days, but then the reservation key must change too. That's a product decision.

18. **Postponed-reminder display across a DST change** (`Note#next_day_reminder_at`). In 8.1, `to_time` keeps the zone no matter what `load_defaults` says (the setting is deprecated). The time shown for "next day" moves by an hour across a DST change. The stored epoch is the same instant either way. Confirmed: one reminders test failed.
    - Fix (keeps the documented behaviour): `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. It works on 7.0.
    - Or accept the new local-clock display and update the comment and test.

19. **Built-in Sidekiq adapter is deprecated in 8.1 and removed in 8.2.** I saw the deprecation warning. Sidekiq 6.5.12 works on 8.1, so this isn't blocking yet.
    - A later move to Sidekiq ≥ 7.3.3 changes the Redis client. `Sidekiq.redis { |r| r.sadd(...) }` in `user.rb:38` would then return an Integer, and `0` is truthy in Ruby, so the one-digest-per-day guard would let repeats through. `rescue Redis::BaseError` in `notebook.rb` would also need checking. Not tested; plan it as its own task.

## B. New defaults, release by release

The app calls `load_defaults 7.0` and sets none of these explicitly, so it keeps the old value for every one.

| Release | Setting | If adopted, for this app |
|---|---|---|
| 7.1 | `default_column_serializer = nil` | `serialize :preferences` (`notebook.rb:7`) raises "missing keyword :coder" (confirmed). Use `coder: YAML`; existing YAML rows still read (confirmed `"Legacy"`). |
| 7.1 | `raise_on_assign_to_attr_readonly` | Every notebook settings save fails with `ReadonlyAttributeError: slug`, because the form posts a hidden `slug` and the controller permits it (confirmed). Today a changed slug is silently ignored. Remove the hidden field and `:slug` from the permitted parameters first; that works on 7.0. |
| 7.1 | `raise_on_invalid_cache_expiration_time` | The exports page raises for an expired export: `expires_in: export.expires_at - Time.current` goes negative (confirmed, `_export.html.erb:26`). Clamp it or skip the cache once expired. |
| 7.1 | `use_big_decimal_serializer` | Already in effect on 8.1 even under 7.0 defaults (confirmed). See section C. |
| 7.1 | `allow_deprecated_parameters_hash_equality = false` | Already in effect on 8.1. I found no code comparing parameters to a Hash. |
| 7.1 | `commit_transaction_on_non_local_return` | Forced on in 8.x. See item 12. |
| 7.1 | `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records` | The app defines no `after_commit` callbacks. Affects Active Storage and Action Text internals only. Low risk. |
| 7.1 | `belongs_to_required_validates_foreign_key = false` | Skips the parent lookup query when only the foreign key is present. No behaviour change expected (the full suite passed). |
| 7.1 | `generate_secure_token_on`, `encryption.*`, `sqlite3_*`, `allow_deprecated_singular_associations_name` | Not used: no `has_secure_token`, no encryption, PostgreSQL only. |
| 7.1 | `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata` | Changes cookie, session and signed-message format. Mixed-version risk: old servers can't read new messages during a rolling deploy. Adopt in a separate deploy after 8.1 is fully rolled out. |
| 7.1 | `marshalling_format_version = 7.1` | Affects cache entries of records. Adopt after a full rollout. Test uses `:null_store`; production cache store isn't configured (default file store). |
| 7.1 | `sanitizer_vendor` (HTML5) for Action View and Action Text, `dom_testing_default_html_version` | The suite passed with `load_defaults 8.1`. Rendering of stored rich text could change subtly. Compare rendered output of real notes. Not verified on real data. |
| 7.1 | `precompile_filter_parameters`, `debug_exception_log_level`, `query_log_tags_format`, `log_file_size` | Cosmetic or logging only. |
| 7.2 | `enqueue_after_transaction_commit` | The 8.0 framework defaults set this to false in my run, and the 8.1 setting is gone. Under `with_lock`, a failed enqueue still raises and rolls back (confirmed). Never enable it per job for `Citation#request_enrichment` or `Note#schedule_reminder`: their "failed enqueue rolls back" behaviour depends on it being off. |
| 7.2 | `postgresql_adapter_decode_dates` | `Notebook#daily_note_counts` raises `TypeError` because `Date.iso8601` is given a Date (confirmed). Use `Date.iso8601(day.to_s)`, or accept the Date directly. |
| 7.2 | `validate_migration_timestamps` | Migrations dated 2026-10-11 are valid. No impact. |
| 7.2 | `web_image_content_types` adds webp | No image processor or variants are installed. No impact. |
| 7.2 | `yjit` | Ruby 3.3.6 is fine. Watch memory. |
| 8.0 | `to_time_preserves_timezone = :zone` | Already forced in 8.1. See item 18. |
| 8.0 | `strict_freshness` | `ExportDownloadsController#show` sends both ETag and Last-Modified. Only `If-None-Match` would be checked. The ETag is the blob checksum, so no effective change. Source-based. |
| 8.1 | Tool listed none | My recollection of 8.1's new defaults (JSON escaping, `raise_on_missing_required_finder_order_columns`, hidden-field autocomplete, path-relative redirects) is not verified. Run `bin/rails app:update` in the copy and read `new_framework_defaults_8_1.rb` before adopting. |

With `load_defaults 8.1` and the required fixes plus `coder: YAML`, only three things failed: the slug, cache-expiry and date-decoding items above (`/tmp/up/81d-test2.log`). It also logs redis-rb 5 deprecations for `sadd` and `srem`.

## C. Rollout risks while old and new versions run side by side

- **DigestJob payloads.** Jobs enqueued on 8.1 carry a `BigDecimalSerializer` argument and a `time_zone` key. A 7.0 worker raises `DeserializationError` on them (confirmed). `DigestJob` has no `discard_on`, so Sidekiq retries them.
  - Deploy the workers before the web servers, or drain the queues. A rollback to 7.0 must drain or discard queued DigestJobs.
  - The reverse works: 8.1 reads 7.0 payloads, with the completion arriving as the string `"0.5"`, and `BigDecimal()` in the mailer handles both.
- **Scheduled reminders.** They can sit in Sidekiq's scheduled set for weeks. Payloads made by 7.0 deserialize on 8.1, and 7.0 reads 8.1's ISO `scheduled_at`. `NoteReminderJob` already discards on deserialization errors. The Sidekiq wrapper class name is unchanged.
- **Stored data.** No schema migration is needed. `tags` (JSON) and `preferences` (YAML) keep their stored format. The schema header stays `Schema[7.0]` until the next dump.
- **Messages and cache.** Hold back the message-serializer and marshalling-format defaults until no 7.0 process is left.
- **Order of work:**
  1. Ship the 7.0-compatible fixes first: items 2, 3, 4, 6–14, 17, 18, plus the slug-permit removal.
  2. Then do the 7.1, 7.2 and 8.0 steps (items 5, 15, 16 belong at 7.1), then 8.1.
  3. Adopt new defaults one release at a time after each rollout.

## D. Not verified, and open questions

- The browser test suite needs a display; I didn't run it. Trix 1.3.5 is still loaded as a classic script, and the precompiled assets now also include the `action_text-trix` gem's assets, which nothing references. That combination is unchecked in a browser, especially editing saved links and attachments.
- I did not boot 7.1, 7.2 or 8.0 individually. The release for each item comes from the changelogs.
- Whether the digest should cover the UTC day or the reader's local day, and how a postponed reminder should be displayed, are product decisions (items 17 and 18).
- Production details I couldn't see: the cache store, Sidekiq deployment order, and whether any stored `preferences` YAML contains non-basic types (`coder: YAML` uses safe loading).
- Whether a later Rails 8.1.x patch fixes the `json` 3.x problem.

---

That's the plan from the upgrade planner. Nothing in your repository has changed; all the testing happened in copies under `/tmp/up`.

Before implementing, I need two decisions from you:
1. **Item 17 (digest day):** should the digest cover the UTC day (current behaviour) or the reader's local day?
2. **Item 18 (postponed reminder):** keep the current display across daylight-saving changes, or accept Rails 8.1's local-clock display?

After that, I'd start with the fixes that already work on 7.0.8.7, shipped as their own change. Item 12 should be first: on 8.1 a failed CSV import partly saves, and no test catches it.