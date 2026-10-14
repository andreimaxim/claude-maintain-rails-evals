Here is the upgrade plan for rails 7.0.8.7 → 8.1.0, as returned by the planning agent:

---

I've built an upgrade plan from 7.0.8.7 to 8.1.0, and it was tested in disposable copies. The working repo was not modified (`git status` is clean). After about 18 code and config changes the copy passes all 46 tests on 8.1.0 under both `load_defaults 7.0` and `load_defaults 8.1`. Without them the app doesn't boot. Two more changes are needed only when adopting the new defaults. Several changes here would silently change data or behaviour, and current tests would not catch them.

**Test setup:** the copy is `/tmp/up/app` (branch `up81`) and `/tmp/up/app70` (branches `prep70`, `try7.1.6`, `try7.2.4`, `try8.0.5.1`). Each used its own PostgreSQL databases (`mn_upgrade_*`, now dropped) and a private Redis on port 6390 (now shut down). Dev mail and storage stayed inside each copy. Env files are `/tmp/up/env.sh` and `/tmp/up/mixed.sh`, scripts are in `/tmp/up/scripts/`, and the change index is `/tmp/up/changes.txt`.

**What was run:**
- **Baseline:** 7.0.8.7 passed 46/46 (`/tmp/up/test70.log`).
- **Rails 8.1.0:** bumped with `bundle update rails --conservative` (`/tmp/up/bundle81.log`, `/tmp/up/lock81.diff`). It resolved rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, minitest 5.27.0 and json 3.1.0 (later pinned to 2.21.2).
- **Fix-by-fix test runs:** `/tmp/up/test81_a.log` through `test81_j.log`.
- **Each new default version:** `/tmp/up/test81_defaults_{7.1,7.2,8.0,8.1}.log`; after fixes, `test81_fixed_defaults_{7.0,8.1}.log`.
- **Intermediate releases:** 7.1.6, 7.2.4 and 8.0.5.1 each pass 46/46 (`/tmp/up/test_<ver>.log`).
- **Prep subset on 7.0.8.7:** 46/46 with no deprecations (`/tmp/up/test70_prep.log`).
- **Full diffs:** `/tmp/up/up81.diff` (8.1) and `/tmp/up/prep70.diff` (7.0-compatible subset).

## A. Required changes (break at boot, in tests, or in data on 8.1 with `load_defaults 7.0`)

"Works on 7.0" means the fix was applied on `prep70` and tests passed on 7.0.8.7.

| # | Code | What breaks on 8.1 | Fix | Works on 7.0? |
|---|---|---|---|---|
| 1 | `config/initializers/action_text.rb` | Boot fails: `allowed_tags` is now nil, so `+=` raises NoMethodError (7.1). | In `after_initialize`, set `allowed_tags = sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. | yes |
| 2 | `Gemfile` / json | json 3.1.0 resolves, and Rails 8.1.0 calls `JSON.parse(json, options)`, so every JSON column read raises ArgumentError. | Pin `gem "json", "< 3"` (resolved 2.21.2). I didn't check whether a later 8.1.x patch fixes this. | n/a |
| 3 | `app/models/note.rb:10` `enum status:, _prefix:` | Keyword enum syntax was removed in 8.0; the app doesn't load. | `enum :status, {...}, prefix: true` | yes |
| 4 | `note.rb:12` `serialize :tags, JSON` and `notebook.rb:7` `serialize :preferences` | Positional coder removed in 7.2; implicit YAML removed by the 7.1 default. | `coder: JSON` / `coder: YAML`. Existing YAML and JSON rows written by 7.0 read correctly on 8.1. | no (7.1+). Keep the old form on 7.0 and switch together with the Rails bump. |
| 5 | `note.rb:14` `alias_attribute :highlight_color, :color` (a `store_accessor`) | Aliasing a non-attribute was removed in 7.2. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | yes |
| 6 | `citation/provider.rb:13` and the test helper use `Rails.application.secrets` | Removed in 7.2. | Rename `config/secrets.yml` to `config/citation_provider.yml`, add `config.citation_provider = config_for(:citation_provider)` in `application.rb`, and read `Rails.configuration.citation_provider.to_h`. The tests mutate it the same way. The quoted-password test passed. | yes |
| 7 | `citation_enrichment_job.rb:7` `wait: :exponentially_longer` | Removed in 7.2; the class fails to load. | `:polynomially_longer` (7.1+). On 7.0, the equivalent proc `->(executions) { executions**4 + 2 }` works on both. | proc: yes |
| 8 | `config/routes.rb:18` `get "/notes", "/journal", ...` | Multiple paths per route removed in 8.1. | Two `get` lines. | yes |
| 9 | `export.rb:42` `fragments.sum` over strings | Rails' `Enumerable#sum` override was removed in 7.1, so string sum raises TypeError. | `fragments.join` | yes |
| 10 | `notes_controller.rb:18` `where(notebooks: @notebook)` on a `belongs_to :notebook` | Plural name for a singular association removed; PG error. | `where(notebook: @notebook)` | yes |
| 11 | `notes/index.html.erb:12` `form_with(model: nil, ...)` | Now raises. | Drop `model: nil`. | yes |
| 12 | `note.rb` `set(wait_until: reminder_epoch)` (an Integer) | 7.1 made `scheduled_at` a Time, so you get NoMethodError `utc` for Integer and reminders cannot be scheduled. | `wait_until: Time.at(reminder_epoch)` | yes |
| 13 | **Data integrity:** `import.rb#apply`, `return false` inside `transaction` | Since 7.2 a non-local return **commits**: a CSV with an invalid row saves the import and the earlier rows. Seen in the copy: `[0,3,0,1]` became `[1,4,1,2]`. | `raise ActiveRecord::Rollback unless rows.all? { ... save }` | yes |
| 14 | `import.rb#receipt` `citation[:id]` (primary key is `doi`) | Since 7.2, `[:id]` no longer returns a custom primary key, so receipt CSVs silently get blank DOIs. | `citation&.doi` | yes |
| 15 | `imports/preview.html.erb` `annotations.stringify_keys` then integer lookup | HashWithIndifferentAccess (HWIA) `stringify_keys` now really stringifies, so annotations silently disappear from the preview. | Drop `.stringify_keys`. | yes |
| 16 | `digest_mailer.rb` and `User#request_digest` | 7.1+ keeps the reader's time zone on time arguments to jobs. The digest then covers the reader's **local** day (subject went from "October 05" to "October 04"), which contradicts the UTC-day reservation and the hint text. | In the mailer, `requested_at = requested_at.utc`. The job payload still carries local time, which the test asserts. | yes |
| 17 | `note.rb#next_day_reminder_at` `reminder_at.to_time + 86_400` | `to_time` now keeps the zone (removed 8.0, deprecated 8.1). It's the same instant, but it now displays as `08:00 -05:00` instead of the documented `09:00 -04:00`. Reminder delivery time is unchanged. | `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` | yes |
| 18 | `config/environments/test.rb` `show_exceptions = false` | Tests that expect `RecordNotFound` get rendered 404s instead (10 tests). | `:none` | no (7.1+) |

## B. Rollout and rollback risks (executed with real Sidekiq against the private Redis)

- **Jobs queued by 7.0 and run by an 8.1 worker:** Digest, Reminder (scheduled), CitationEnrichment and Export all completed (`/tmp/up/mixed_worker81_A.log`). Queued work from before the upgrade is safe.
- **Rollback, jobs queued by 8.1 and run by a 7.0 worker:** DigestJob fails with `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. It goes to retries, and the reader's Redis reservation for that day blocks a re-request (`/tmp/up/mixed_worker70_B.log`).
  - Cause: `reading_completion` is a BigDecimal, and the BigDecimal argument serializer is always on in 8.x.
  - Fix: pass `reading_completion.to_s`; the mailer already calls `BigDecimal(...)`. This works on 7.0 (in `prep70`) and must ship before the Rails bump.
  - The other job types ran fine on 7.0.
- **Rollback with stored Action Text data:** a note with an attachment saved under 8.1 with `load_defaults` ≥ 7.1 (the `message_serializer` / `use_message_serializer_for_metadata` defaults) cannot be rendered by 7.0. You get `ActionView::Template::Error` from `SignedGlobalID` decoding, so the note page returns 500.
  - Same data with 8.1 and `load_defaults 7.0`: renders correctly.
  - Data written by 7.0 and read on 8.1 with 8.1 defaults: renders correctly.
  - Encrypted and signed cookies were readable in every direction.
  - Rule: don't adopt the 7.1 message defaults until rollback to Rails 7.0 is no longer an option.
- **`enqueue_after_transaction_commit`:**
  - On 7.2.4 with `load_defaults 7.2` and Redis down, enqueueing is deferred until after commit. `Citation#request_enrichment` then leaves the citation **pending forever**, so later requests say "already being fetched". `Note#schedule_reminder` stores a job ID that was never queued, so the old reminder is suppressed and the new one never sends.
  - On 8.1 the value is `false` under both 7.0 and 8.1 defaults, and the failure rolls back correctly.
  - If any deploy runs 7.2 with 7.2 defaults, set `config.active_job.enqueue_after_transaction_commit = :never` there (7.2 only; it's removed in 8.1).
  - On any version, never set it to `true` per job for these jobs.
- **Sidekiq:** Rails 8.1 warns that the built-in `sidekiq` adapter is deprecated and will be removed in 8.2; it needs sidekiq ≥ 7.3.3. That later upgrade, not tested here, will affect:
  - `User#request_digest`: redis-client returns `0`/`1` from `sadd`, and `0` is truthy, so de-duplication would break.
  - `Notebook#request_export`: rescues `Redis::BaseError`, which won't be what redis-client raises.
  - `ExportJob` arguments use symbol keys; Sidekiq 6.5 already warns that 7.0 will raise.

## C. New framework defaults (the app sets `load_defaults 7.0` and overrides none of these)

Running the tests per version (after the section A fixes, before the defaults fixes) gave these failures:
- `load_defaults 7.1`: slug and cache-expiry failures.
- `load_defaults 7.2` and later: the same two plus the date failure.

Two more fixes, both of which work on 7.0, cover them:
- `NotebooksController` stops permitting `:slug`.
- `exports/_export.html.erb` uses `expires_in: (export.expires_at - Time.current if export.downloadable?)`.

The `daily_note_counts` date failure (7.2) needs only the `day.to_date` change listed under 7.2 below.

**7.1**
- `raise_on_assign_to_attr_readonly`: the settings form resubmits `slug`, so updating notebook settings raises `ReadonlyAttributeError`. Fix above.
- `raise_on_invalid_cache_expiration_time`: an expired export's fragment gets a negative `expires_in`, so the exports page raises. Fix above.
- `message_serializer: :json_allow_marshal` and `use_message_serializer_for_metadata`: cause the rollback hazard in section B. Adopt last, in a separate deploy.
- `marshalling_format_version 7.1` and cache format 7.1: 7.0 can't read the new format, which only affects fragment cache during rollback (not tested).
- `sanitizer_vendor` HTML5 (Action Text and Action View): the sample body with details/summary, `<script>` and unclosed tags sanitized identically. Imported `body_html` with unusual markup may still differ (not tested broadly).
- `dom_testing_default_html_version :html5`: the suite still passed.
- `default_column_serializer nil`: covered by fix 4.
- `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`: the app defines no commit callbacks, only Active Storage's internal ones. Low impact.
- `belongs_to_required_validates_foreign_key`: the Note-to-notebook validation still rejects a missing notebook in tests.
- `commit_transaction_on_non_local_return`: superseded by fix 13.
- `allow_deprecated_singular_associations_name`: fixed by #10.
- `use_big_decimal_serializer`: section B.
- `generate_secure_token_on`, Active Record encryption hash settings, `sqlite3_adapter_strict_strings_by_default`: not used.
- `allow_deprecated_parameters_hash_equality`: no Parameters-to-Hash comparisons found.
- `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`: logging and performance only.

**7.2**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises TypeError because `Date.iso8601` now receives a Date. Fix: `day.to_date` (works on 7.0). The "ISO 8601 text" comment then needs updating.
- `enqueue_after_transaction_commit = :default`: harmful here; see section B.
- `web_image_content_types` adds webp: there's no variant processing (`image_processing` isn't installed), so minor.
- `validate_migration_timestamps`: existing timestamps are valid.
- `yjit = true` (Ruby 3.3.6): enables YJIT and uses more memory. Check worker and web memory budgets.

**8.0**
- `to_time_preserves_timezone = :zone`: after fix 17 the app no longer depends on it. On 8.0.5.1 the boot deprecation still fires until it's set; set `:zone` while on 8.0, then remove it at 8.1, where the setting is deprecated.
- `strict_freshness`: Rails' own `fresh?` check changes, verified in a runner. Over HTTP, the export download returned the same codes under both settings (`304` for matching ETag plus old If-Modified-Since, `200` for a wrong ETag). Because the ETag is the blob checksum, the impact is negligible. I haven't explained why the non-strict case also returned 304.

**8.1:** no new defaults listed beyond 8.0.

## D. Recommended order

1. **On 7.0, deploy the `prep70` changes** (`/tmp/up/prep70.diff`): items 1, 3, 5, 6, 7 (proc), 8–17, the BigDecimal `to_s`, the slug, cache-expiry and `to_date` fixes, and moving `secrets.yml` to `config_for`. Let queued DigestJobs drain or confirm they're string-valued.
2. **Bump to 8.1.0** (or step through 7.1, 7.2, 8.0; all pass) with the json pin, `coder:` keywords, `:polynomially_longer` and `show_exceptions :none`. Keep `load_defaults 7.0`, which keeps rollback safe for jobs and Action Text.
3. **Adopt the new defaults** one release at a time. Leave the message-serializer defaults for last, once rollback to 7.0 is off the table. Plan the Sidekiq 7.3.3+ migration before Rails 8.2.

## Still unverified
- System tests (no browser here).
- A production-environment boot and `assets:precompile`.
- A real cache-store rollback.
- Sidekiq 7 behaviour.
- Whether a later 8.1.x patch removes the need for the json pin.
- The strict-freshness 304 anomaly.
- YJIT memory use.
- HTML5 sanitizer differences on real imported content.

---

This is a plan only. The upgrade hasn't been applied, and your working tree on `main` is unchanged. The working diffs are in `/tmp/up/prep70.diff` (changes that also work on 7.0) and `/tmp/up/up81.diff` (the full 8.1 upgrade).

The biggest decision is whether to bump straight to 8.1.0 or ship the 7.0-compatible fixes first. I recommend shipping those fixes first, because of the rollback problems with DigestJob and Action Text. Also, pinning json below 3 changes a dependency beyond `rails` itself, so it needs your approval. If you want, I can apply step 1 on a branch.