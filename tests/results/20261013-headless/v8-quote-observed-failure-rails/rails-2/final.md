# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but plain `rails 8.1.0` breaks this app badly. With the gem bumped and the app still on `load_defaults 7.0`, the app would not boot. After fixing the boot and load errors I hit, the suite still ran with 0 failures and 35 errors out of 46 tests. Once I applied the fixes below, all 46 tests passed on 8.1.0, on each intermediate release (7.1.6, 7.2.4, 8.0.5.1), and under `load_defaults 8.1`.

Several breakages either pass the existing tests silently or only show up in jobs and mixed-version queues. Most fixes can ship on 7.0 first. Your working repository was not modified (`git status` is clean).

## How I tested
- **Copies:** `/tmp/up/base` (unchanged 7.0), `/tmp/up/prep70` (7.0 plus the preparatory fixes), `/tmp/up/r716`, `/tmp/up/r724`, `/tmp/up/r8051` (the intermediate releases), `/tmp/up/r81` (8.1.0, defaults 7.0), `/tmp/up/r81d` (8.1.0, `load_defaults 8.1`).
- **Isolation:** a private Postgres 15 cluster (socket `/tmp/up/svc`, port 55432), private Redis on port 56379, gems in `/tmp/up/gems81`, Active Storage and cache inside each copy. Environment is in `/tmp/up/env.sh`. Both services are stopped now.
- **Resolved versions (8.1.0):** rails 8.1.0, rack 2.2.24, sidekiq 6.5.12, puma 5.6.9, turbo-rails 2.0.12, sprockets-rails 3.5.2, plus the new action_text-trix 2.1.19 (the json pin is the first finding). Lockfile diff: `/tmp/up/lockdiff.txt`.
- **Logs:** change summary `/tmp/up/changes.txt`; tests `/tmp/up/{base,prep70,r81,r81d}-test.log` and `/tmp/up/test-{716,724,8051}.log`; queue checks `/tmp/up/enqueue*.log` and `/tmp/up/dequeue*.log`; full 8.1 code diff `/tmp/up/r81-full.diff`; scripts in `/tmp/up/scripts/`.

## A. Required changes (each one fails under `load_defaults 7.0`)
"Works on 7.0: yes" means the change passed the 7.0 suite in `/tmp/up/prep70` (46/46).

1. **json 3.x breaks all JSON column reads.** Bundler resolved json 3.1.0 for Rails 8.1.0. Any read of a JSON-coded column then raised `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291` via `ActiveSupport::JSON.decode`. That hit Active Storage blob metadata and `Note#tags`.
   - Fix: add `gem "json", "< 3"` (or a later Rails patch that supports json 3).
   - Works on 7.0: not tested.

2. **`config/initializers/action_text.rb:3` stops boot from 7.1 on.** The error is `undefined method '+' for nil (NoMethodError)` (`allowed_tags` now starts as nil).
   - Fix: set `ActionText::ContentHelper.allowed_tags = sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]` inside `after_initialize` / `on_load(:action_view)`.
   - Works on 7.0: yes. On 8.1 the `details`/`summary` test passes with both the HTML4 and HTML5 sanitizer.

3. **`app/models/note.rb:10` old enum keyword syntax (removed in 8.0).** Error: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Same method names.
   - Works on 7.0: yes.

4. **`note.rb:12` `serialize :tags, JSON` (removed in 7.2).** Error: `(given 2, expected 1)`.
   - Fix: `serialize :tags, coder: JSON`.
   - **Does not work on 7.0.** Rails 7.0 silently ignores `coder:`, so tags come back as a String (`undefined method 'any?' for an instance of String`, 15 tests failed). Ship it with the 7.1 bump.
   - Stored data is unchanged: 7.0-written `["a","b"]` read back correctly on 8.1.

5. **`note.rb:14` `alias_attribute` to a store accessor (removed in 7.2).** Error: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
   - Fix: `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. The form and strong params use the setter.
   - Works on 7.0: yes.

6. **`config/routes.rb:18` `get "/notes", "/journal", ...` (removed in 8.1).** Error: `ArgumentError: Wrong number of arguments (expect 1, got 2)`, so no routes load at all.
   - Fix: two lines, `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. The `notes` and `journal` route names stay the same (checked).
   - Works on 7.0: yes.

7. **`app/views/notes/index.html.erb:12` `form_with(model: nil, ...)` (removed in 8.0).** Error: `Passed nil to the :model argument, expect an object or false`. The note list returns 500, including right after sign-in.
   - Fix: drop `model: nil`.
   - Works on 7.0: yes.

8. **`app/controllers/notes_controller.rb:11` `where(notebooks: @notebook)`.** Error: `PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering the note list by notebook returns 500.
   - Fix: `where(notebook: @notebook)`.
   - Works on 7.0: yes.

9. **`Citation::Provider#initialize` uses `Rails.application.secrets` (removed in 7.2).** Error: `NoMethodError: undefined method 'secrets'`. This is not covered by `retry_on`, so enrichment jobs fail on Sidekiq retries.
   - Experiment fix: `config.x.citation_provider = config_for(:secrets).fetch(:citation_provider)`, with the provider and the test helper reading `Rails.configuration.x.citation_provider`. A dedicated `config/citation_provider.yml` would be cleaner.
   - `secrets.yml` holds no `secret_key_base` (checked), so sessions are unaffected.
   - Works on 7.0: yes. Update the docs that mention `secrets.yml`.

10. **`app/models/export.rb:42` `fragments.sum` over strings.** Error: `TypeError: String can't be coerced into Integer`. Every Markdown export job fails and the export stays "working".
    - Fix: `fragments.join`.
    - Works on 7.0: yes.

11. **`app/models/import.rb:56` `return false` inside `transaction`.** Since 8.0 this commits instead of rolling back. Observed counts: expected `[0, 3, 0, 1]`, got `[1, 4, 1, 2]`. **An invalid CSV import saves partially**, which is data corruption the user never sees.
    - Fix: `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`, returning whether it saved.
    - Works on 7.0: yes.

12. **`import.rb:68` `citation[:id]` (Citation's primary key is `doi`).** Since 7.2 this returns nil. The receipt CSV becomes `On idleness,` with no DOI, silently.
    - Fix: `citation&.doi`.
    - Works on 7.0: yes.

13. **`app/views/imports/preview.html.erb:22` `.stringify_keys` on the integer-keyed hash.** Since 8.0 it really stringifies, so `annotations[row.line]` misses and annotations vanish from the import preview.
    - Fix: drop `.stringify_keys`.
    - Works on 7.0: yes.

14. **`note.rb:61` `set(wait_until: <Integer>)`.** Error logged: `Failed enqueuing NoteReminderJob ... NoMethodError (undefined method 'utc' for an instance of Integer)`. Scheduling a reminder returns 500 (the row lock rolls back, so nothing is half-saved).
    - Fix: `wait_until: Time.at(reminder_epoch)`.
    - Works on 7.0: yes.

15. **`note.rb:44` `reminder_at.to_time + 86_400`.** Rails 8.1 removed the offset-preserving `to_time`. The test that expects `2026-11-01T09:00:00-04:00` (the documented "keeps the offset" preview) fails. I did not capture the new rendered value; from the source I expect `08:00-05:00`. The postponed instant is the same, so only the displayed text changes.
    - Fix (keeps current behavior): `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`.
    - Works on 7.0: yes.
    - At an 8.0 stop there is a boot-time warning: "`to_time` will always preserve the full timezone … set `to_time_preserves_timezone = :zone`" (called from `config/environment.rb:5`).

16. **`app/mailers/digest_mailer.rb` reads `requested_at` in the reader's zone.** Since 7.1 Active Job keeps the time zone of a `TimeWithZone` argument (the payload now carries `"time_zone"`). Observed subject: `"October 04, 2026"` where the test expects `"October 05"`. The digest would cover the reader's local day, while reservations and the UI say "UTC day".
    - Fix: `requested_at = requested_at.in_time_zone` (worker zone, as on 7.0).
    - Works on 7.0: yes. Also correct for 7.0-enqueued payloads, which have no zone.

17. **`app/jobs/citation_enrichment_job.rb:7` `wait: :exponentially_longer`.** Error: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, so the "record failure" block never runs.
    - Fix: `:polynomially_longer` (same formula).
    - **Does not exist on 7.0**, so ship it with the 7.1 bump.

18. **`config/environments/test.rb:31` `show_exceptions = false`.** On 8.1, five request tests that expect `ActiveRecord::RecordNotFound` to be raised failed ("nothing was raised"). Test environment only.
    - Fix: `:none`.
    - **7.1 or later only.**

## B. Mixed-version rollout, queued work and rollback
- **`DigestJob` BigDecimal argument (`app/models/user.rb:41`)** — this needs action before the first 7.2-or-later deploy.
  - Rails 7.0 enqueues it as `"0.5"`. From 7.2 on it is enqueued as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",...}`.
  - A 7.0 worker given an 8.1 payload failed with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The reverse direction is fine.
  - Rails 7.1 warns: "Primitive serialization of BigDecimal job arguments is deprecated".
  - Fix: pass `reading_completion.to_s`. The job comment already says it arrives as a decimal string. Verified that an 8.1 enqueue then deserializes on 7.0. Works on 7.0: yes.
  - Don't rely on `use_big_decimal_serializer`: from 7.2 the typed format is always used.
- **Queued `NoteReminderJob`, `ExportJob` and `TimeWithZone` payloads** deserialize in both directions (7.0 ↔ 8.1). Already-scheduled reminders keep working.
- **Sessions:** with defaults still at 7.0, a production-mode cookie worked in both directions (7.0 ↔ 8.1). Locally, development sessions reset because the dev secret moves from `tmp/development_secret.txt` to `tmp/local_secret.txt` (observed).
- **Stored YAML preferences and JSON tags** read correctly in both directions.
- **Rollback:** safe as long as the BigDecimal fix ships first and no new defaults are adopted. The message serializer, cache format and metadata defaults must each wait for their own deploy after the upgrade is fully rolled out.
- **Sidekiq built-in adapter:** 8.1 deprecates it ("will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later"). That's a separate follow-up. Unverified from the source: on Sidekiq 7, `redis.sadd` returns an Integer, which would break `User#request_digest`'s once-per-day guard (`if 1` is always true). `ExportJob`'s symbol keys would also raise under strict args (Sidekiq already warns: "Job arguments to ExportJob do not serialize to JSON safely").

## C. New defaults, release by release
Every value below keeps its old setting today (`load_defaults 7.0`, nothing set explicitly). "Measured" means tried in `/tmp/up/r81d`.

**7.1**
- `default_column_serializer = nil`: `Notebook` boot fails with "missing keyword: :coder" (measured). Requires `serialize :preferences, coder: YAML` at the 7.1 step; stored YAML is unchanged.
- `raise_on_assign_to_attr_readonly`: notebook update raises `ActiveRecord::ReadonlyAttributeError: slug` (measured), because `NotebooksController#notebook_params` permits `:slug`. Fix: stop permitting `:slug` (works on 7.0).
- `raise_on_invalid_cache_expiration_time`: `exports/_export.html.erb:26` raises "Cache expiration time is invalid, cannot be negative: -60.0" for expired exports (measured).
  - With the old value on 8.1 it is worse in a quiet way: a negative `expires_in` stores the fragment with **no expiry** (read back `"v"`), where 7.0 expired it immediately. The content is "Expired", which is harmless.
  - Fix: `expires_in: [export.expires_at - Time.current, 1.second].max`. Works on 7.0 and keeps the stale-indicator test intact.
- `commit_transaction_on_non_local_return`: irrelevant once finding 11 is fixed, and removed in 8.0 anyway.
- `sanitizer_vendor` HTML5 (Action View and Action Text): the rich-text tests pass. Output may differ subtly on malformed HTML; not checked further.
- `dom_testing_default_html_version :html5`: tests pass.
- `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`, `cache_format_version 7.1`, `marshalling_format_version`: these are rollout risks. Adopt them in a later deploy once no 7.0 servers remain.
- `belongs_to_required_validates_foreign_key`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`: no effect expected. There are no app `after_commit` callbacks, and the `belongs_to` parents are always assigned.
- `generate_secure_token_on`, the encryption digest settings, `sqlite3_adapter_strict_strings_by_default`, `allow_deprecated_singular_associations_name`, `allow_deprecated_parameters_hash_equality`: not used here.
- `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`, `add_autoload_paths_to_load_path = false`, new `default_headers`: logging, headers or load path only. Nothing in the app requires `lib/` files.
- `active_job.use_big_decimal_serializer`: moot once the `.to_s` fix ships.

**7.2**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String` (measured). Fix: `day.to_date` (works on 7.0).
- `enqueue_after_transaction_commit`: would defer the `perform_later` inside `with_lock` in `Citation#request_enrichment` and `Note#schedule_reminder`, which breaks their "a failed enqueue rolls back" design. It only applies when sitting on 7.2 with 7.2 defaults; 8.x defaults it to false (checked in the source). Don't enable it.
- `web_image_content_types` adds webp: there are no variants, so no effect.
- `validate_migration_timestamps`: the existing migrations are valid.
- `yjit`: needs a memory check.

**8.0**
- `to_time_preserves_timezone = :zone`: safe once finding 15 is fixed. Setting it is deprecated again in 8.1, so remove it when moving to 8.1.
- `strict_freshness`: `ExportDownloadsController#stale?(etag:, last_modified:)` would honour `If-None-Match` only. The blob never changes, so the effect is negligible.

**8.1**
- `escape_json_responses = false`, `escape_js_separators_in_json = false`: there are no JSON responses.
- `action_on_path_relative_redirect = :raise`: all redirects use route helpers.
- `raise_on_missing_required_finder_order_columns`: every table has a primary key.
- `remove_hidden_field_autocomplete`, `render_tracker = :ruby`, `yjit` outside dev/test: markup or performance only.

With all of the above plus the C fixes, `load_defaults 8.1` passed 46/46.

## D. Recommended sequence
1. **On 7.0 (one PR, rollback-safe):** findings 2, 3, 5–16, the `.to_s` BigDecimal fix, and the C-section fixes (stop permitting `:slug`, `day.to_date`, the cache-expiry clamp). Add the json pin too, but check that the 7.0 lockfile still resolves with it first. Deploy, then drain queues normally.
2. **7.0 → 7.1.6:** with findings 4 and 17, `serialize :preferences, coder: YAML`, and finding 18. Result: 46/46, with the remaining deprecations in `/tmp/up/test-716.log`.
3. **→ 7.2.4 → 8.0.5.1 → 8.1.0:** each passed 46/46 with these changes. Add `to_time_preserves_timezone = :zone` only for an 8.0 stay. Ship each version separately and keep the defaults at 7.0.
4. **Adopt new defaults afterwards,** release by release, with the serializer and cache-format settings in their own deploy.

## Not verified
- Browser/system tests: there is no Chrome in this environment. In particular, the vendored Trix 1.3.5 classic script working alongside Action Text 8.1's `actiontext.js` and the new action_text-trix gem. The page did serve `trix-1.3.5.js` and precompile succeeded.
- Real Sidekiq workers running jobs end to end. I only checked enqueue and deserialization.
- That the json pin resolves against the 7.0 lockfile.
- The exact rendered value for finding 15.
- How the HTML5 sanitizer handles malformed stored rich text.
- Production cache-store behaviour beyond FileStore and MemoryStore.

The change summary's matches on Action Cable callbacks, faraday `basic_auth`, `has_secure_password` additions, `button_to` and `file_field` entries, `config.assets` and `public_file_server` turned out to be unrelated after reading the code.

---

This is only a plan. The upgrade skill plans the work and doesn't apply it, so I haven't changed your repository. If you want me to go ahead, I'd start with step D1: the fixes that already work on 7.0, as one rollback-safe PR. Four items in the plan were never tested, and at least two need checking: browser tests, because no Chrome was available, and whether the json pin resolves with the 7.0 lockfile.