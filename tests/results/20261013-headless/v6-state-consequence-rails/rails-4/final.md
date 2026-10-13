# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

## Summary

The upgrade can be done, but it will not boot or pass tests without code changes. Some of the breakage is silent and the test suite would not catch it:

- **Imports could save half a file.** `Import#apply` uses `return false` inside a `transaction`. On 7.2 and later that commits the rows already saved instead of rolling back.
- **The import receipt CSV would lose its DOI column.** `citation[:id]` returns `nil` on 7.2 and later.
- **The import preview would stop showing annotations.**
- **Digest emails would cover the reader's local day** instead of the UTC day the app promises.
- **Rolling back would break queued work.** A 7.0 worker cannot read the `DigestJob` jobs that 8.1 enqueues.

All of these were reproduced. Most fixes also work on 7.0, so they can ship before the version bump. I have not changed the working repository.

## What I ran

All experiments used a disposable copy:
- **Upgraded copy:** `/tmp/upg/app`, a git archive of `HEAD` with its own git history. Branch `master` has the minimum fixes; branch `defaults81` tries `load_defaults 8.1`.
- **7.0 copy:** `/tmp/upg/base`, a worktree at the original code. Branch `prep` checks which fixes also work on 7.0.
- **Isolation:** separate Postgres databases (`upg_mn_test` and `upg_mn_dev`, both dropped afterwards), a private Redis on port 6391 (shut down afterwards), and Disk storage inside the copy. Tests ran with `REDIS_URL=redis://127.0.0.1:6391/0 PARALLEL_WORKERS=1`.
- **Gems after `bundle update rails --conservative`:** rails 8.1.0. Unchanged: sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, rack 2.2.24, minitest 5.27.0, concurrent-ruby 1.3.4, turbo-rails 2.0.12. json 3.1.0 resolved first; I pinned it to 2.21.2 (see finding 1).
- **Logs** are in `/tmp/upg/logs/`:

| Run | Result | Log |
|---|---|---|
| 7.0 baseline | 46 runs, 0 failures | `baseline-7.0.log` |
| First boot on 8.1 | aborted | `zeitwerk-8.1.log` |
| 8.1 tests, fix iterations | progressively fewer failures | `test-8.1-a` … `test-8.1-e.log` |
| 8.1 with all fixes, defaults 7.0 | 46 runs, 1 failure (reminder display, finding 20) | `test-8.1-e.log` |
| 8.1 with `load_defaults 8.1` | 3 errors and the same 1 failure | `test-8.1-defaults81b.log` |
| Fixes on 7.0 | 46 runs, 0 failures | `test-7.0-prep2.log` |
| Jobs enqueued by 7.0, run on 8.1 | read correctly | `xver-old-on-8.1.log` |
| Jobs enqueued by 8.1, run on 7.0 | `DigestJob` fails | `xver-new-on-7.0.log` |
| Real Sidekiq 6.5.12 worker on 8.1 | export and digest completed | `sidekiq-8.1.log` |

The complete fix set is in `/tmp/upg/logs/prep.patch`.

## A. Required changes (the app breaks without them)

"Works on 7.0" means the change can ship before the bump. "Executed" means I reproduced the problem and confirmed the fix.

1. **json 3.x breaks Active Support 8.1.0.** Unless the lock is held, Bundler resolves json 3.1.0. Then every read of a JSON-serialized column (`Note#tags`) raises `ArgumentError` in `JSON.parse`. *Executed.*
   - Fix: pin `gem "json", "< 3"`, or move to a Rails patch release that supports json 3.
   - Check: `bundle exec ruby -e 'require "active_support/json"; ActiveSupport::JSON.decode("[1]")'`.

2. **`config/initializers/action_text.rb` stops boot.** On 7.1 and later `ActionText::ContentHelper.allowed_tags` starts as `nil`, so `+=` raises `NoMethodError`. *Executed.*
   - Fix: in `after_initialize`, set it to `(allowed_tags || sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. Works on 7.0.
   - Check: the "keeps collapsible excerpts" test in `notes_controller_test` passes on both versions.

3. **`app/models/note.rb` enum uses the removed keyword form** (`enum status: {...}, _prefix: true`), which raises at load on 8.0 and later. *Executed.*
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0.

4. **`app/models/note.rb` `serialize :tags, JSON`.** The positional coder was removed in 7.2. *Executed.*
   - Fix: change to `coder: JSON`, but only in the same commit as the bump. On 7.0 the `coder:` keyword is silently ignored and the column falls back to YAML: tags read back as a String and views crash. I executed this, and it would also write YAML into a JSON column.

5. **`alias_attribute :highlight_color, :color`** points at a `store_accessor`, which is not a real attribute. On 7.2 and later this raises `ArgumentError` whenever a note is built. *Executed.*
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0.

6. **`config/routes.rb` `get "/notes", "/journal", to:`.** Multiple paths in one call were removed in 8.1, so loading routes raises. *Executed.*
   - Fix: split into two `get` lines. Works on 7.0, and `notes_path` keeps its name.

7. **`Rails.application.secrets` was removed in 7.2.** It is used in `Citation::Provider#initialize` and `test/controllers/citation_enrichments_controller_test.rb`, and backed by `config/secrets.yml`. *Executed.*
   - Fix: add `config/citation_provider.yml` with the same ERB and `.to_json` quoting, set `config.x.citation_provider = config_for(:citation_provider)`, read `Rails.configuration.x.citation_provider.to_h`, and update the test. Works on 7.0.
   - Deployment: the same ENV variables must be set in production. The test that checks credentials survive a fresh boot ("credentials from the environment reach the server unchanged", using the values "00123" and "sample: value # keep") passed.

8. **`config.action_dispatch.show_exceptions = false` in the test environment.** The boolean is gone in 7.2. Exceptions are then rendered instead of raised, so every `assert_raises(ActiveRecord::RecordNotFound)` failed. *Executed.*
   - Fix: `:none`, in the bump commit only. On 7.0 a symbol counts as `true`.

9. **`retry_on ..., wait: :exponentially_longer`** in `app/jobs/citation_enrichment_job.rb` fails at retry time on 7.2 with `RuntimeError: Couldn't determine a delay`. *Executed.*
   - Fix: `:polynomially_longer`, which exists only from 7.1. If you need one change for both versions, use a lambda.
   - Retries already queued under 7.0 keep their scheduled time.

10. **`Note#schedule_reminder` passes an Integer epoch to `set(wait_until:)`.** On 7.1 and later this fails with `NoMethodError: undefined method 'utc' for Integer` and a 500 when scheduling or postponing. *Executed.*
    - Fix: `wait_until: Time.at(reminder_epoch)`. Works on 7.0.

11. **`app/views/notes/index.html.erb:12` uses `form_with(model: nil, ...)`.** Removed in 8.0, so the notes list returns 500. *Executed.*
    - Fix: `model: false`. Works on 7.0.

12. **`NotesController#index` uses `where(notebooks: @notebook)`.** On 8.1 this produces `PG::UndefinedColumn notes.notebooks`, so filtering by notebook breaks. *Executed.*
    - Fix: `where(notebook: @notebook)`. Works on 7.0.

13. **`Export#generate` joins with `fragments.sum`.** Rails 7.1 removed its override of `Enumerable#sum`, so Ruby's `sum` raises `TypeError` on Strings and Markdown export fails inside the Sidekiq job. The 7.0 test run already prints a deprecation warning for this. *Confirmed with a runner check.*
    - Fix: `fragments.join`. Works on 7.0.

14. **Silent: `Import#apply` has `return false` inside a `transaction`.** On 7.2 and later that commits. The invalid-rows test showed records saved: `[0,3,0,1]` became `[1,4,1,2]`. *Executed.*
    - Fix: `raise ActiveRecord::Rollback unless rows.all?(&:save)`, returning false when the transaction rolls back. Works on 7.0.
    - Before upgrading, check production for orphaned partial imports. There should be none on 7.0.

15. **Silent: `Import#receipt` uses `citation[:id]`.** `Citation`'s primary key is `doi`. Executed: 7.0 returns `"10.1000/x"` and 8.1 returns `nil`, so the receipt CSV's DOI column comes out empty.
    - Fix: `citation&.doi`. Works on 7.0.

16. **Silent: the import preview uses `@import.annotations.stringify_keys[row.line]`.** In 8.0, `HashWithIndifferentAccess#stringify_keys` also converts Integer keys, so the lookup misses and annotations disappear from the preview. *Executed.*
    - Fix: drop `.stringify_keys`. Works on 7.0.

17. **Silent: which day the digest covers.** From 7.1, Active Job keeps the time zone of a `TimeWithZone` argument. `DigestMailer` then uses the reader's local day, which contradicts the UTC wording in the mailer comment and on the notes index. The test showed October 4 instead of October 5. *Executed.*
    - Fix: `requested_at = requested_at.utc` in the mailer. Works on 7.0.
    - During the rollout, jobs enqueued by 7.0 carry no zone and are read as UTC. The fix makes both forms behave the same.

## B. Rollout, rollback, stored data and queued work

- **BigDecimal job argument (`DigestJob`).** `User#reading_completion` passes a BigDecimal. Rails 7.0 stores it as the string `"0.5"`; 8.1 uses `BigDecimalSerializer`, which 7.0 does not have. I executed both directions:
  - 7.0 payloads run fine on 8.1.
  - 8.1 payloads fail on 7.0 with `DeserializationError: BigDecimalSerializer is not known`. The day's digest reservation in Redis is already used, so that reader gets no digest that day.
  - Proposed fix: pass `reading_completion.to_s` before the bump. The mailer already calls `BigDecimal(...)`. This is a source-based conclusion; I did not run this fix.
- **Other payload changes.** 8.1 payloads add `time_zone` and `scheduled_at` keys. `NoteReminderJob` payloads ran correctly in both directions.
- **Stored data reads unchanged on 8.1** (executed): YAML in `notebooks.preferences`, JSON text in `notes.tags`, jsonb in `notes.settings`.
- **Native Sidekiq `ExportJob`.** Unaffected by Rails. Sidekiq warns that `{ format: "markdown" }` uses Symbol keys; this becomes an error in Sidekiq 7.
- **Sidekiq adapter.** Sidekiq 6.5.12 works with Rails 8.1.0. It was executed with a real worker, and the export and digest both completed. It logs: "built-in sidekiq adapter is deprecated and will be removed in Rails 8.2". That is a follow-up, not a blocker, and it brings its own problems:
  - Sidekiq 7.3.3 or later needs redis-client.
  - `User#request_digest` relies on `redis.sadd` returning true or false. With redis-client it returns an Integer, and `0` counts as true in Ruby, so duplicate digests would be sent. The Redis 4.8 warning about `sadd` already appears in the test log.
  - `Sidekiq.strict_args!` would reject the `ExportJob` arguments above.
- **Rollback windows.**
  - Do not adopt `message_serializer`, `use_message_serializer_for_metadata`, `marshalling_format_version`, or the 7.1 cache format until 7.0 servers are gone.
  - Cookies already use the `:json` serializer on both versions (executed check).
  - Recommended order: (1) deploy the 7.0-compatible fixes; (2) bump 7.0 → 7.1 → 7.2 → 8.0 → 8.1, one release at a time, keeping `load_defaults 7.0` and reading the deprecation output at each step (`config.active_support.deprecation = :stderr` in test); (3) adopt defaults afterwards in separate deploys.
  - I only executed the jump straight to 8.1, not each intermediate release.

## C. New framework defaults

The app calls `load_defaults 7.0` and sets none of these explicitly, so it keeps every old value. The table says what changes if you adopt each one.

### 7.1

| Setting | What changes for this app if adopted |
|---|---|
| `default_column_serializer = nil` | `serialize :preferences` raises at boot. Executed. Use `coder: YAML` first. |
| `raise_on_assign_to_attr_readonly` | `NotebooksController#notebook_params` permits `:slug`, which is `attr_readonly`. Settings updates raise `ReadonlyAttributeError`. Executed. Stop permitting `:slug`. |
| `raise_on_invalid_cache_expiration_time` | `exports/_export.html.erb:26` uses `expires_in: export.expires_at - Time.current`, which goes negative after expiry. Raises. Executed. Clamp it or skip the cache. |
| `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata` | Signed and encrypted messages stop being readable by 7.0. Adopt only after rollout. |
| `marshalling_format_version` | Record caches stop being readable by 7.0. Adopt only after rollout. |
| `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records` | No `after_commit` callbacks in the app. Effectively no change. |
| `commit_transaction_on_non_local_return` | Covered by finding 14. |
| `belongs_to_required_validates_foreign_key = false` | Removes a query per save for `Export`, `Import` and `Note`. Low risk. |
| `sanitizer_vendor` (Action View and Action Text), `dom_testing_default_html_version = :html5` | Rich-text HTML and test selectors are parsed as HTML5. Re-run the rich-text and `assert_select` tests. The tests passed under 8.1 defaults apart from the failures listed. |
| `use_big_decimal_serializer` | Moot from 7.2, where the old serializer is removed. See section B. |
| `allow_deprecated_parameters_hash_equality = false` | No `Parameters == Hash` comparisons found. Source check only. |
| `encryption.*` | The app does not use Active Record encryption. No change. |
| `sqlite3_adapter_strict_strings_by_default` | App uses Postgres. Not applicable. |
| `query_log_tags_format` | Query log tags are not enabled. No change. |
| `allow_deprecated_singular_associations_name` | Not applicable. |
| `generate_secure_token_on` | No `has_secure_token`. Not applicable. |
| `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size` | Logging only. |

### 7.2

| Setting | What changes for this app if adopted |
|---|---|
| `postgresql_adapter_decode_dates` | `Notebook#daily_note_counts` calls `Date.iso8601` on a value that is now already a Date. Raises `TypeError`. Executed. Handle values that are already Dates. |
| `validate_migration_timestamps` | All migration timestamps are valid. |
| `web_image_content_types` | Adds WebP. No variants or `image_processing` in use, so no change. |
| `yjit = true` | Ruby 3.3.6. Memory use goes up. |

The gem-changes summary lists `enqueue_after_transaction_commit` under 7.2, but the 8.1 framework defaults do not set it (source check). Not applicable.

### 8.0

| Setting | What changes for this app if adopted |
|---|---|
| `to_time_preserves_timezone = :zone` | Already removed in 8.1, so no choice. See finding 20. |
| `strict_freshness` | Affects conditional GETs only. No `fresh_when` or `stale?` found. Source check only. |
| `Regexp.timeout = 1` | Affects regexes such as the DOI validation and the CSV parsing. Low risk. |

### 8.1

| Setting | What changes for this app if adopted |
|---|---|
| `raise_on_missing_required_finder_order_columns` | Every model has a primary key, so no change. |
| `action_on_path_relative_redirect = :raise` | Redirects are built with `_path` helpers, so no change. Not executed. |
| `escape_json_responses = false`, `escape_js_separators_in_json = false` | JSON output only. |
| `render_tracker = :ruby` | Template dependency tracking for caching. Affects the `cache` call in `_export`. |
| `remove_hidden_field_autocomplete` | Markup only. |
| `yjit` | Disabled in local environments. |

## D. Other behavior changes the tests will not reveal

18. **Retry timing.** `:polynomially_longer` has no jitter, while 7.0's `:exponentially_longer` did. Retries line up more closely. Minor.

19. **`ActiveRecord::Base.connection`** in `Notebook#daily_note_counts` is soft-deprecated. Switching to `with_connection` is optional.

20. **Reminder display.** `Note#next_day_reminder_at` (`reminder_at.to_time + 86_400`): 8.1 always keeps the zone, so across the DST change on 1 Nov 2026 the "24 hours later" preview shows `08:00 -05:00` instead of `09:00 -04:00`. It is the same instant, so the scheduled epoch does not change. This is the one test still failing on 8.1. Product decision: update the test's expected value, or use `reminder_at + 1.day` if "same wall-clock time" is what you want. Executed.

## E. Not verified and open questions

- I did not run the browser suite (`bin/rails test:system`), test each intermediate release separately, or try Puma 6 or Rack 3 (not required: Puma 5 and Rack 2.2 resolved and the Sidekiq worker ran).
- I did not run production assets (sprockets-rails or importmap precompile).
- The `to_s` fix for the BigDecimal argument is source-based only.
- Questions for you:
  - Should the digest stay on UTC days?
  - Should the next-day reminder show the same wall-clock time or exactly 24 hours later?
  - How many `DigestJob` jobs are in Sidekiq's retry and scheduled sets at deploy time? Inspect them before allowing any rollback.
  - When should the Sidekiq 7.3.3+ migration happen? It is needed before Rails 8.2.

---

That's the plan from the upgrade planner. Nothing has been upgraded yet, and your repository is unchanged; all the testing ran in throwaway copies under `/tmp/upg`.

The main decision for you is order. I'd first ship the fixes that work on 7.0 (findings 2, 3, 5–7, 10–17 and the BigDecimal `to_s` change), then move up one Rails version at a time. To implement it, tell me which approach you want and answer the two product questions: whether digests stay on UTC days, and how the next-day reminder should be shown.