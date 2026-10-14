I haven't changed anything yet. The skill only produces a plan, so the repository is untouched and Rails is still pinned at 7.0.8.7. Here is the plan from the upgrade planner, word for word:

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

Rails 8.1.0 cannot be adopted without code changes. In a disposable copy, the bump alone first failed at boot, then failed all 46 tests. After 14 fixes the full suite passed on 8.1.0 (46 runs, 0 failures), both with lazy loading and with `CI=1` eager loading. Two problems would not show up in tests at all: a mixed-version job payload that old workers cannot read, and a job retry that only fails at runtime. The working repository is unchanged (`git status` clean).

## How I tested
- **Copy:** clones at `/tmp/up/app` (8.1.0) and `/tmp/up/app70` (7.0 with the proposed preparatory fixes).
- **Isolation:** a private Redis on port 6391 (databases 0, 2 and 3), and separate Postgres databases `mn_upg_test`, `mn_upg_test70` and `mn_upg_prod`. Both have since been dropped or shut down. Storage and cache used the copy's own `tmp/` folder.
- **Gems:** `bundle update rails` resolved Rails 8.1.0 and pulled in `action_text-trix 2.1.19` and `json 3.1.0`. Everything else stayed where it was (sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, puma 5.6.9, minitest 5.27.0).
- **Outputs:**
  - change summary: `/tmp/up/changes.txt`
  - bundle logs: `/tmp/up/bundle1.log`, `/tmp/up/bundle2.log`, lockfile diff `/tmp/up/lock.diff`
  - test logs, in order: `/tmp/up/base_test.log` (7.0 baseline, green), then `t1`–`t8.log`, then `t8_eager.log`
  - 8.1 with `load_defaults 8.1`: `t_defaults81.log`, `t_defaults81b.log`
  - 7.0 with the preparatory fixes: `t70_prep.log`
  - full diffs: `/tmp/up/app81.diff` (working 8.1 variant), `/tmp/up/app70_prep.diff` (fixes that also pass on 7.0: 46 runs, 0 failures)
  - production boot and `assets:precompile`: `/tmp/up/precompile.log` (exit 0)

## A. Required changes (each one observed failing on 8.1.0)

"Works on 7.0" means the fix passed the 7.0 suite in `/tmp/up/app70`, so it can ship before the upgrade.

1. **`json` gem 3.x breaks 8.1.0.** `activesupport-8.1.0/.../json/decoding.rb:25` calls `JSON.parse(json, options)`, which json 3.1.0 rejects. Every request that reads the session failed: `ArgumentError: wrong number of arguments (given 2, expected 1)` from `application_controller.rb:8`.
   - **Fix:** pin `gem "json", "< 3"` (resolved to 2.21.2), or target the latest 8.1.x patch instead of 8.1.0.
   - Not verified: whether 8.1.4 fixes this itself.

2. **`config/initializers/action_text.rb` stops boot.** In 7.1+ `allowed_tags` starts as `nil`, so the `+=` fails: `undefined method '+' for nil (NoMethodError)`.
   - **Fix:** in `after_initialize`, set it to `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - Works on 7.0. The rich-text sanitising test passes on both versions and with the HTML5 sanitizer.

3. **`app/models/note.rb:10`, old keyword `enum` form.** Fails at class load: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0.

4. **`note.rb:12`, `serialize :tags, JSON`.** Fails with `wrong number of arguments (given 2, expected 1)`.
   - **Fix:** `serialize :tags, coder: JSON`.
   - **This must ship in the upgrade commit itself.** On 7.0 the `coder:` keyword is silently ignored and YAML is used instead (observed: `tags` came back as the string `"[]"`). The stored data stays JSON either way.

5. **`note.rb:14`, `alias_attribute :highlight_color, :color`.** `color` is a store accessor, not a column: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
   - **Fix:** `alias_method` for both the reader and the writer (`highlight_color` and `highlight_color=`). Works on 7.0.

6. **`config/routes.rb:18`, one route with two paths (`get "/notes", "/journal"`).** Fails with `Wrong number of arguments (expect 1, got 2)`.
   - **Fix:** two `get` lines, `as: :notes` and `as: :journal`. Works on 7.0.

7. **`Rails.application.secrets` is gone.** It is used in `app/models/citation/provider.rb:13` and in `test/controllers/citation_enrichments_controller_test.rb`. Error: `undefined method 'secrets'`. If unfixed, citation enrichment fails in every environment.
   - **Fix:** `config.x.citation_provider = config_for(:secrets).fetch(:citation_provider)` (or move it to a new yml or credentials file), and update the tests. Works on 7.0.

8. **`config/environments/test.rb`, `show_exceptions = false`.** On 8.1 errors become 404/500 pages, so the `assert_raises(ActiveRecord::RecordNotFound)` tests fail.
   - **Fix:** `:none`. Upgrade commit only, because 7.0 treats a symbol as true.

9. **`app/models/export.rb:42`, `fragments.sum` on strings.** Rails no longer patches `sum` for strings: `TypeError: String can't be coerced into Integer`. Every export would fail in Sidekiq.
   - **Fix:** `fragments.join`. Works on 7.0.

10. **`note.rb` `schedule_reminder`, `set(wait_until: <Integer>)`.** Fails with `NoMethodError (undefined method 'utc' for an instance of Integer)`, so scheduling a reminder returns a 500.
    - **Fix:** `Time.at(reminder_epoch)`. Works on 7.0.

11. **`app/jobs/citation_enrichment_job.rb:7`, `wait: :exponentially_longer`.** This only fails when a retry actually happens: `RuntimeError (Couldn't determine a delay based on :exponentially_longer)`.
    - The `fail_enrichment` block is then skipped. Reading the code, the citation would stay `pending`, and `request_enrichment` refuses any new request while pending.
    - **Fix:** `:polynomially_longer` (7.1+ only), or `->(executions) { executions**4 + 2 }`, which works on 7.0 too.

12. **`app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)`.** Fails with `Passed nil to the :model argument, expect an object or false`.
    - **Fix:** remove `model: nil`. Works on 7.0.

13. **`app/controllers/notes_controller.rb`, `where(notebooks: @notebook)`.** Fails with `PG::UndefinedColumn: column notes.notebooks does not exist`, which breaks the notebook filter.
    - **Fix:** `where(notebook: @notebook)`. Works on 7.0.

14. **Silent data and behaviour changes. The suite catches these, but production would not raise anything:**
    - **`app/models/import.rb` `apply`, `return false` inside `transaction`.** On 8.1 this commits instead of rolling back. Observed record counts went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`: a partly invalid CSV saves the import, some notes and citations.
      - **Fix:** `raise ActiveRecord::Rollback` and return a flag. Works on 7.0.
    - **`import.rb` `receipt`, `citation[:id]`.** Citations use `doi` as the primary key and have no `id` column. On 8.1 this returns `nil`, so the receipt CSV has empty DOIs (`"On idleness,\n"`).
      - **Fix:** `citation&.doi`. Works on 7.0.
    - **`app/views/imports/preview.html.erb`, `annotations.stringify_keys`.** The keys now become strings, so `annotations[row.line]` (an integer) misses and annotations disappear from the preview.
      - **Fix:** drop `stringify_keys`. Works on 7.0.
    - **`DigestJob` / `app/mailers/digest_mailer.rb`.** Active Job now keeps the reader's time zone on `requested_at`, so the digest covers the reader's local day (observed `October 04` instead of `October 05`). The Redis reservation key is still per UTC day.
      - **Fix:** `requested_at = requested_at.utc` in the mailer. Works on 7.0.
    - **`note.rb` `next_day_reminder_at`.** On 8.1, `to_time` keeps the zone. The postponed epoch is the same (`1793538000` on both versions), but the preview shows `2026-11-01T08:00:00-05:00` instead of the `-04:00` value the code comment and test describe.
      - **Fix:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` to keep the current display, or accept the new wall-clock time and update the test and comment. That is a product decision. The `config.active_support.to_time_preserves_timezone` setting is deprecated in 8.1.

## B. Rollout risks across versions and stored data (tested)
- **`DigestJob` payloads.** Rails 8.1 always uses `BigDecimalSerializer`; the 7.1 opt-out was removed in 8.0. A job queued by 8.1 and run by a 7.0 worker failed with: `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. A 7.0 payload run by 8.1 worked.
  - **Fix:** enqueue `reading_completion.to_s`. That matches the existing string contract, is portable, and passed on both versions.
  - Without it, upgrade Sidekiq workers before web and do not roll back while 8.1-queued digest jobs are still in the queue or retry set.
- **Payload compatibility in both directions:**
  - 8.1 adds a `time_zone` key to `TimeWithZone` arguments, and 7.0 ignores it.
  - Scheduled `NoteReminderJob`s (global IDs) and `ExportJob` (native Sidekiq) payloads do not change shape.
  - Jobs already queued with `:exponentially_longer` are fine once item 11 is deployed, because the delay is computed by the running code.
- **Schema and migrations.** `db/schema.rb` will be re-dumped as `Schema[8.1]`. No migrations or data rewrites are needed: `tags` stays JSON text and `preferences` stays YAML.
- **Sidekiq adapter.** Rails 8.1 deprecates its built-in Sidekiq adapter. It still works with 6.5.12 (production boot confirmed it is used). Moving later to Sidekiq 7.3+ / redis-client is a separate project:
  - `sadd` would return an Integer, so `if 0` in `User#request_digest` is always true;
  - `Redis::BaseError` rescues would need changing;
  - the symbol-keyed hash in `ExportJob` arguments would be rejected under strict arguments.

## C. Optional new defaults (the app keeps `load_defaults 7.0`; tested with `load_defaults 8.1` in `t_defaults81*.log`)
Settings that break this app if adopted, each with its preparatory fix:

| Setting | What happened in the test run | Preparatory fix |
|---|---|---|
| 7.1 `default_column_serializer = nil` | `notebook.rb:7` fails: `missing keyword: :coder` | `serialize :preferences, coder: YAML`. Safe on 7.0, which ignores the keyword and uses YAML anyway. |
| 7.1 `raise_on_assign_to_attr_readonly` | `ActiveRecord::ReadonlyAttributeError: slug` on every notebook settings save, even when the slug is unchanged, because the form resubmits it | Remove `:slug` from `notebook_params` and the hidden field in `notebooks/_form.html.erb` |
| 7.1 `raise_on_invalid_cache_expiration_time` | `exports/_export.html.erb:26`: `Cache expiration time is invalid, cannot be negative: -60.0` for expired exports | Skip the cache when the export has expired, or clamp the value |
| 7.2 `postgresql_adapter_decode_dates` | `notebook.rb:40`: `TypeError: no implicit conversion of Date into String` (activity report) | Accept a Date, e.g. `day.is_a?(Date) ? day : Date.iso8601(day)` |

Other settings:

| Setting | Effect on this app |
|---|---|
| 7.1 `message_serializer` / `use_message_serializer_for_metadata` | Signed Active Storage URLs created by 8.1 can't be read by 7.0 servers during a rolling deploy. Enable after full rollout. |
| 7.1 `marshalling_format_version`, cache format 7.1 | Production file-store fragments can't be read after a rollback. Enable in a later deploy. |
| 7.1 `commit_transaction_on_non_local_return` | Already forced in 8.x. Covered by the item 14 import fix. |
| 7.1 sanitizer vendor and DOM-testing defaults (HTML5) | Tests passed. |
| 8.0 `strict_freshness` | `ExportDownloadsController` `stale?` would honour only `If-None-Match` when both headers are sent. Low risk, not tested. |
| 7.2 `validate_migration_timestamps` | Existing migrations comply. |
| 7.2 `yjit` | Memory impact on the host should be checked. |

No effect here: Active Record encryption, the SQLite setting, `has_secure_token`, the transaction-callback ordering settings (the app has no `after_commit` callbacks), `query_log_tags`, and `belongs_to_required_validates_foreign_key` (performance only).

The tool listed three settings that 8.1 no longer has: `use_big_decimal_serializer` (removed), `enqueue_after_transaction_commit` (8.1 removed the setting; observed `ActiveJob::Base.enqueue_after_transaction_commit == false`, so jobs queued under row locks still roll back with the transaction), and `to_time_preserves_timezone` (deprecated).

## D. Suggested order
1. Ship to 7.0 first, since these passed there: items 2, 3, 5, 6, 7, 9, 10, 11 (lambda form), 12, 13, all of item 14, `completion.to_s`, and the preparatory fixes in section C.
2. Upgrade commit: the Rails bump plus the `json` pin, `coder: JSON`, and `show_exceptions = :none`. Upgrade Sidekiq workers before web.
3. Adopt new defaults one release at a time using `new_framework_defaults_*` files, with the serializer and cache-format settings last.

## Not verified / still to do
- The browser suite (`bin/rails test:system`): no browser is installed here.
- A real Sidekiq process consuming jobs. I only ran `ActiveJob::Base.execute` on payloads read from Redis.
- `strict_freshness` with real HTTP headers, and whether 8.1.x patches drop the need for the json pin.
- Anything that depends on production data: existing `preferences` YAML containing unexpected classes (8.1 loads YAML in safe mode), and 7.0-format jobs still waiting in production Redis.

One existing problem I hit that is not caused by the upgrade: production has no mailer host set, so running a digest job in production config failed with `Missing host to link to!`.

---

**My notes:**
- This is a jump of three minor versions, from 7.0 to 8.1. A one-line Gemfile bump on its own would stop the app from booting.
- **Decision needed:** in `next_day_reminder_at` (item 14), should reminder previews keep showing the current offset, or switch to the new wall-clock time?
- **Decision needed:** stay on exactly 8.1.0 and pin `json < 3`, or move to the latest 8.1.x patch instead?
- If you want me to go ahead, I'd start with step D1: the fixes that already passed on 7.0. The Rails bump would follow as a separate commit.