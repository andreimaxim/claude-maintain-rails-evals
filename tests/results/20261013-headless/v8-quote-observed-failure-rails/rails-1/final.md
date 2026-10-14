# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is doable, but not as a version bump alone. On a bare bump, the app does not boot. After the boot fixes, 25 of the 46 tests still fail. Four problems are silent: tests pass while behaviour is wrong (partial imports get saved, receipt DOIs are blank, import annotations disappear, and the digest covers a different day). One mixed-version risk can lose digest jobs during rollout.

With 18 required fixes, Rails 8.1.0 passes all 46 tests (340 assertions), eager-loads, and Puma 5.6.9 serves pages, all on `load_defaults 7.0`. Three of those fixes only work on 8.1. The rest also pass all 46 tests on 7.0, so they can ship first.

I did not modify the working application. One side effect: my comparison runs of the 7.0 copy in `/home/user/workspace/repo` appended to its gitignored `log/test.log`. They used only the isolated database and Redis described next.

**How I tested**
- **Where:** a clone at `/tmp/up/app`, with its own PostgreSQL 15 (socket `/tmp/up`, port 55432) and Redis (port 56379). Both services are now stopped. The suite uses the test queue adapter and test storage service.
- **Bundle:** I changed only `gem "rails", "8.1.0"` and ran `bundle update rails --conservative`. That resolved rails 8.1.0, json 3.1.0 (later pinned to 2.21.2), rack 2.2.24, minitest 5.27.0, sidekiq 6.5.12, turbo-rails 2.0.12 and pagy 8.6.3. Lockfile diff: `/tmp/up/lock81.diff`.
- **Logs:** baseline on 7.0 is `/tmp/up/test70.log` (46 runs, 0 failures). The 8.1 runs are `/tmp/up/test81a.log` through `test81g.log` (ending green), plus `test81_defaults81.log` and `test81_defaults81b.log` for `load_defaults 8.1`. The 7.0 check of the preparatory fixes is `/tmp/up/test70prep.log` (green).
- **Fixes as tested:** `/tmp/up/required-fixes-8.1.diff` (8.1) and `/tmp/up/prep-on-7.0.diff` (7.0).
- **Change index:** `/tmp/up/changes.txt`. Experiment scripts: `/tmp/up/apply_exp.rb` and `/tmp/up/sq_exp.rb`.

## A. Required changes (each one observed failing on 8.1 before the fix)

"Works on 7.0" means the fix also passed the full suite on 7.0 (`test70prep.log`), so it can ship before the bump.

| # | Code | What happens on 8.1 without the fix | Fix | Works on 7.0 |
|---|---|---|---|---|
| 1 | Gemfile resolution | Activesupport 8.1.0 now depends on `json`, and bundler resolved json 3.1.0. Every JSON column read and every Note save then raises `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291` (called at `activesupport-8.1.0/.../json/decoding.rb:25`). | Pin `gem "json", "~> 2.10"` (tested with 2.21.2), or check whether a later 8.1.x patch supports json 3. | n/a |
| 2 | `config/initializers/action_text.rb` | Boot fails: `undefined method '+' for nil (NoMethodError)` on `ActionText::ContentHelper.allowed_tags += ...`. Since 7.1 the allowlist is nil until it is resolved lazily. | In `after_initialize`, set `allowed_tags = sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. The test that keeps `details` and `summary` passes. | yes |
| 3 | `note.rb` `enum status: {...}, _prefix: true` | `ArgumentError: wrong number of arguments (given 0, expected 1..2)` from `enum.rb:217` while loading classes. | `enum :status, { draft: 0, ready: 1 }, prefix: true` | yes |
| 4 | `note.rb` `serialize :tags, JSON` | `wrong number of arguments (given 2, expected 1)` from `serialization.rb:193`. | `serialize :tags, coder: JSON` | **no** (keyword added in 7.1) |
| 5 | `config/routes.rb` `get "/notes", "/journal", ...` | `Wrong number of arguments (expect 1, got 2)` from `mapper.rb:1854`. | Two separate `get` lines. The route names `notes` and `journal` stay the same (checked with `bin/rails routes` on both versions). | yes |
| 6 | `note.rb` `alias_attribute :highlight_color, :color` | `color` is a `store_accessor`, not a column: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.` | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | yes |
| 7 | `export.rb` `finish(fragments.sum)` | Every export job fails with `TypeError: String can't be coerced into Integer`. Rails 7.0 already warns about this in the test log. | `fragments.join` | yes |
| 8 | `config/environments/test.rb` `show_exceptions = false` | Exceptions are turned into responses, so every `assert_raises ActiveRecord::RecordNotFound` ownership test fails ("nothing was raised"). | `:none` | **no** (7.0 would treat `:none` as true) |
| 9 | `notes_controller.rb` `where(notebooks: @notebook)` | `PG::UndefinedColumn: column notes.notebooks does not exist` when the list is filtered by notebook. | `where(notebook: @notebook)` | yes |
| 10 | `notes/index.html.erb` `form_with(model: nil, ...)` | The note list, which is also the page after sign-in, returns 500: `Passed nil to the :model argument, expect an object or false`. | Drop `model: nil`. | yes |
| 11 | `note.rb` `set(wait_until: reminder_epoch)` (an Integer) | Scheduling a reminder raises `undefined method 'utc' for an instance of Integer`. | `wait_until: Time.at(reminder_epoch)` | yes |
| 12 | `Rails.application.secrets` in `citation/provider.rb`, `config/secrets.yml`, and `citation_enrichments_controller_test.rb` | `undefined method 'secrets'`, because secrets were removed in 7.2. | Moved the settings to `config/citation_provider.yml` (same ERB with `.to_json` quoting) and `config.x.citation_provider = config_for(:citation_provider)`. The test that passes credentials through the environment, including values like `"00123"` and `"sample: value # keep"`, passes. Production must still provide the same `CITATION_PROVIDER_*` variables. | yes |
| 13 | `citation_enrichment_job.rb` `wait: :exponentially_longer` | When the provider is unavailable, the job raises `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. | `:polynomially_longer` (same `executions**4` curve, from source) | **no** |
| 14 | `import.rb` `apply`: `return false` inside `transaction` | **Silent, not caught by tests.** Experiment `/tmp/up/apply_exp.rb` (an import with one valid row and one blank-title row): 7.0 gives `apply=false imports=0 notes=0`; 8.1 gives `apply=false imports=1 notes=1`. The import and earlier rows are committed while the reader is told nothing was saved, so retrying creates duplicates. Transactional tests hide this. | `raise ActiveRecord::Rollback` and return the transaction's value (`... true end \|\| false`). Re-run of the experiment on 8.1: `imports=0 notes=0`. | yes |
| 15 | `import.rb` receipt `citation[:id]` | **Silent.** Citations use `doi` as the primary key. On 7.0, `Citation.new(doi: "10.1000/x")[:id]` returns `"10.1000/x"`; on 8.1 it returns `nil`, so the receipt CSV's doi column is blank. No test asserts it. | `citation&.doi` | yes |
| 16 | `imports/preview.html.erb` `@import.annotations.stringify_keys` | **Silent.** The keys become `"2"`, so the lookup by integer `row.line` returns nil and annotations vanish from the preview. Observed: `[HWIA, ["2"], nil]` on 8.1 versus `[HWIA, [2], "a"]` on 7.0. | Drop `.stringify_keys`. | yes |
| 17 | `digest_mailer.rb` `requested_at.to_date` | **Behaviour change.** Since 7.1, Active Job keeps a TimeWithZone's zone, so the digest covers the reader's local day instead of the UTC day the app promises. Test: expected "October 05, 2026", got "October 04, 2026". | `requested_at = requested_at.utc` before taking the date and the `all_day` range. This also makes jobs enqueued by 7.0 and 8.1 behave the same. | yes |
| 18 | `note.rb` `next_day_reminder_at` (`reminder_at.to_time + 86_400`) | On 8.1, `to_time` keeps the zone, so across the DST change the preview shows `2026-11-01 08:00 -0500` instead of `09:00 -0400`. The moment in time, and so the postponed reminder's epoch, is the same. Only the displayed preview and the documented "keeps the offset" contract change. | `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`, or accept the new display and update the test and comment. | yes |

**Rollout order:** ship fixes 2, 3, 5–7, 9–12 and 14–18 on 7.0 first. Then ship 1, 4, 8 and 13 together with the Rails bump. Fixes 14–17 fix silent data and behaviour problems, so each should get a regression test that does not depend on transactional fixtures; those tests are proposed, not written.

## B. Mixed-version rollout and rollback risks

1. **Digest jobs can be lost (observed).** On 8.1, a `BigDecimal` job argument is always written with `BigDecimalSerializer`, even on `load_defaults 7.0`. Rails 7.0 cannot read it: `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. This hits `User#request_digest`, which enqueues `DigestJob` with `reading_completion`.
   - **Deploy:** upgrade Sidekiq workers before or together with web servers.
   - **Rollback:** drain the default queue or the retry set first, or 7.0 workers will retry these digests and eventually send them to the dead set.
   - **Alternative that works on both versions:** pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)` on it.
2. **TimeWithZone jobs (observed):** 8.1 adds a `time_zone` key, which 7.0 ignores and deserializes as UTC. With fix 17 the result is the same in both directions.
3. **Scheduled reminders already in Redis:** 7.0-format GlobalID payloads deserialize normally on 8.1 (seen on enqueue; I did not run a 7.0→8.1 job end to end).
4. **Native `ExportJob`:** plain JSON arguments, so it is not affected.
5. **Built-in Sidekiq adapter (observed):** using it prints "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later". It works on 8.1, so leave Sidekiq at 6.5.12 for this upgrade. Moving to Sidekiq 7 later is not drop-in, based on reading the code:
   - `User#request_digest` uses `if redis.sadd(...)`. Under redis-client that returns an Integer, so `0` is truthy and the once-per-day limit breaks.
   - `rescue Redis::BaseError` in `Notebook#request_export`, and the tests that stub `Redis::CannotConnectError`, would no longer match the new error classes.
6. **`enqueue_after_transaction_commit` is not a risk:** on 8.1 it is `false` under both 7.0 and 8.1 defaults (observed), and 8.1 removed the 7.2 `:default` setting. The "enqueue under the row lock" design in `Note#schedule_reminder` and `Citation#request_enrichment` stays intact.
7. **Signed messages (observed):** see the `message_serializer` row in section C before adopting 7.1 defaults.

## C. Optional framework defaults

The app stays on `load_defaults 7.0`, and nothing is set explicitly, so every setting below keeps its old value. Running the suite on `load_defaults 8.1` first gave 46 errors because of `serialize :preferences` with no coder. Adding `coder: YAML` left 3 errors.

**Settings that change behaviour here**

| Release | Setting | What changes for this app |
|---|---|---|
| 7.1 | `default_column_serializer = nil` | **Breaks:** `ArgumentError: missing keyword: :coder` for `serialize :preferences` in `notebook.rb`. Use `serialize :preferences, coder: YAML` so existing YAML text stays readable; this keyword only works on 8.1. |
| 7.1 | `raise_on_assign_to_attr_readonly` | **Breaks:** `ActiveRecord::ReadonlyAttributeError: slug`. The settings form resubmits `slug`, and `notebook_params` permits it. Stop permitting `:slug` on update. |
| 7.1 | `raise_on_invalid_cache_expiration_time` | **Breaks:** `Cache expiration time is invalid, cannot be negative: -60.0` from `exports/_export.html.erb:26`, whose `expires_in: export.expires_at - Time.current` goes negative for expired exports. Clamp the value or skip caching expired exports. |
| 7.1 | `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata` | **Rollback hazard (observed):** with 8.1 defaults and a shared secret, a 7.0 process failed on 8.1-made Active Storage `attachable_sgid` and `signed_id` with `NoMethodError: undefined method 'unpack1' for nil`, and on a `message_verifier` message with `incompatible marshal file format`. Rich-text bodies store attachment sgids, so attachments added after enabling these would break after a rollback to 7.0. Enable them in a later deploy, once rollback to 7.0 is ruled out. |
| 7.1 | `marshalling_format_version = 7.1` | Production uses the default file store, so these are cache entries, not durable data. Enable in a follow-up deploy so 7.0 servers can still read the cache. |
| 7.1 | `sanitizer_vendor` (HTML5) for Action View and Action Text | Sanitized output of rich text and `simple_format` may change slightly. The test for collapsible excerpts and unsafe markup passed. |
| 7.1 | `dom_testing_default_html_version = :html5` | Test assertions parse with HTML5. The full suite passed. |
| 7.1 | `run_after_transaction_callbacks_in_order_defined` | Order of `after_commit` callbacks. No `after_commit` in `app/` was found. |
| 7.1 | `belongs_to_required_validates_foreign_key = false` | Removes a parent lookup query. `belongs_to :citation, validate: true` is optional and unaffected. |
| 7.1 | `commit_transaction_on_non_local_return` | Already forced on in 8.1. Fix A14 handles it. |
| 7.1 | `use_big_decimal_serializer` | Already always on in 8.1. See risk B1. |
| 7.1 | `allow_deprecated_parameters_hash_equality = false` | No `Parameters == Hash` comparisons were found. |
| 7.2 | `postgresql_adapter_decode_dates` | **Breaks:** `TypeError: no implicit conversion of Date into String` in `Notebook#daily_note_counts` (`Date.iso8601(day)`), because the raw select now returns a `Date`. Handle both: `day.is_a?(Date) ? day : Date.iso8601(day)`. |
| 7.2 | `enqueue_after_transaction_commit` | Removed in 8.1. See B6. |
| 7.2 | `web_image_content_types` adds WebP | WebP uploads stop being converted to PNG for variants. Image processing is not installed. |
| 7.2 | `validate_migration_timestamps` | Migration names like `20261011...` are valid. |
| 7.2 | `yjit` | Ruby 3.3.6 is in use, so YJIT turns on and uses more memory. Check memory headroom on the hosts. |
| 8.0 | `to_time_preserves_timezone = :zone` | Already the effective behaviour on 8.1 (see A18). On 8.1, the 7.0 defaults setting triggers "`config.active_support.to_time_preserves_timezone` is deprecated and will be removed in Rails 8.2" (seen when running `bin/rails runner`). |
| 8.0 | `action_dispatch.strict_freshness` | `ExportDownloadsController#show` sends both an ETag (blob checksum) and Last-Modified. With this on, only `If-None-Match` is considered when both are sent. The ownership and expiry checks still run first. Not tested. |

**Settings with no effect here**
- No Active Record encryption is used, so the `encryption.*` settings do not apply.
- `has_secure_token` is not used (`generate_secure_token_on`).
- SQLite is not used (`sqlite3_adapter_strict_strings_by_default`).
- No query-log tags are configured (`query_log_tags_format`).
- Logging only: `log_file_size` and `debug_exception_log_level`.
- `allow_deprecated_singular_associations_name`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records` and `precompile_filter_parameters`: no effect found.

**Suggested approach:** go through `new_framework_defaults_7_1` to `8_1` one setting at a time after the bump, with the three code fixes above. Turn on the message and marshalling settings last, once rollback to 7.0 is no longer possible.

## D. Not verified
- I ran only `bin/rails test`. The system suite (Chrome/Selenium) has no tests in this checkout.
- I did not boot development or production with real credentials.
- Running `bin/rails db:migrate` on 8.1 will reorder columns in `db/schema.rb` (source-based; expect a noisy diff).
- Dev and test `secret_key_base` moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`, so local sessions are reset (source-based).
- Whether Sidekiq ≥7.3's own adapter changes enqueue-after-commit behaviour.
- The strict_freshness response codes.
- An end-to-end run of a 7.0-enqueued reminder on an 8.1 worker.
- Whether a later 8.1.x patch makes the json pin unnecessary.
- Deprecation warnings to clean up later:
  - "Redis#sadd will always return an Integer in Redis 5.0.0" (from `user.rb:38`).
  - Ruby 3.4 warns that `csv` will no longer be bundled; add it to the Gemfile before moving to Ruby 3.4.

---

That's the plan; I haven't upgraded anything yet, and your working tree has no changes (only the ignored `log/test.log` got longer). The app is on Rails 7.0.8.7, so a version bump alone won't boot. It needs the 18 fixes in section A. Most of them can ship on 7.0 first, and four of them fix problems that pass the tests while behaving wrongly.

Do you want me to start implementing, beginning with the fixes that also work on 7.0?