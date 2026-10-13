# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is not a lockfile bump. With only the version changed, the app fails to boot (dev runner and eager load), and once boot is fixed, all 46 tests error. It needed about 14 code changes before the suite ran. Six of the problems change behavior or data without an obvious error. The working repo was not modified (`git status` is clean). All experiments ran in disposable copies with their own PostgreSQL cluster (socket `/tmp/upg`, port 55432) and Redis (port 56379). Storage stayed in each copy's `tmp/`. Both services have been stopped.

## Evidence
- **Copies:** `/tmp/upg/app` (Rails 8.1.0; branch `upg` holds the required fixes, branch `defaults81` adds `load_defaults 8.1`) and `/tmp/upg/app70` (current 7.0.8.7 with the fixes that also work on 7.0).
- **Environment:** `/tmp/upg/env.sh`.
- **Lockfiles:**
  - `/tmp/upg/Gemfile.lock.8.1.0` is the plain `bundle lock --update rails`. It moved json to 3.1.0 and kept rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9 and concurrent-ruby 1.3.4. It added action_text-trix 2.1.19.
  - `/tmp/upg/Gemfile.lock.8.1.0-json2` pins json to 2.21.2.
- **Patches:** `/tmp/upg/upgrade-required.patch`, `/tmp/upg/prep.patch`, `/tmp/upg/defaults81.patch`.
- **Logs:**

| Run | Result | Log |
|---|---|---|
| Current app, 7.0 | 46 runs, 0 failures | `/tmp/upg/base-test.log` |
| 8.1, version change only | Boot fails | `/tmp/upg/boot-dev.log`, `/tmp/upg/zw.log` |
| 8.1, fixes added step by step | | `/tmp/upg/test81{,b..h}.log` |
| 8.1 with all required fixes, old defaults | 2 failures, both product decisions | `/tmp/upg/test81h.log` |
| Portable fixes on 7.0 | 46/46 pass | `/tmp/upg/test70-prep2.log` |
| `load_defaults 8.1` | 2 failures, 3 errors | `/tmp/upg/test81-defaults81b.log` |
| Jobs queued by 7.0, read by 8.1 | All read correctly | `/tmp/upg/x-enq70.log`, `/tmp/upg/x-perf81.log` |
| Jobs queued by 8.1, read by 7.0 | DigestJob fails | `/tmp/upg/x-enq81.log`, `/tmp/upg/x-perf70.log` |
| Production boot, eager load | Boots | `/tmp/upg/boot-prod81.log` |

## A. Required changes (they break under 8.1 with current defaults)
"Executed" means I reproduced it in a copy. "Works on 7.0" means the fix also passed the 7.0 suite, so it can ship before the upgrade.

1. **json 3.x conflict.** Not a Rails changelog item.
   - Breaks: `bundle lock` picked json 3.1.0, whose `JSON.parse` no longer takes a positional options hash. Active Support 8.1.0 passes one, so every JSON column read (`Note` tags) raised `ArgumentError`.
   - Fix: add `gem "json", "< 3"`, or check whether a later 8.1.x patch fixes it (not checked).
   - Executed.

2. **Action Text allowed tags.** `config/initializers/action_text.rb`
   - Breaks: `ActionText::ContentHelper.allowed_tags` is `nil` from 7.1, so the `+=` raises `NoMethodError` at boot.
   - Fix: inside `config.after_initialize`, set `allowed_tags = sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - Executed. Works on 7.0. The "keeps collapsible excerpts" test passes with both the HTML4 and HTML5 sanitizer.

3. **Citation provider settings.** `app/models/citation/provider.rb` and `test/controllers/citation_enrichments_controller_test.rb:45,117-123`
   - Breaks: `Rails.application.secrets` was removed in 7.2, so citation lookups raise `NoMethodError`. The test also changes `secrets` at runtime.
   - Fix: read `config_for(:secrets)` (ideally rename the file to `config/citation_provider.yml`) and give the test a settings hook to override.
   - Executed. Works on 7.0. Production must still provide the same `CITATION_PROVIDER_*` environment variables.

4. **`Note` enum syntax.** `app/models/note.rb:10`
   - Breaks: `enum status: {...}, _prefix: true` raises `ArgumentError` when the class loads (keyword form removed in 8.0).
   - Fix: `enum :status, {...}, prefix: true`.
   - Executed. Works on 7.0.

5. **`Note` serialize syntax.** `serialize :tags, JSON`
   - Breaks: raises `ArgumentError` when the class loads.
   - Fix: `serialize :tags, coder: JSON`. The stored format is unchanged.
   - **Does not work on 7.0.** Rails 7.0 silently ignores `coder:` and returns raw strings; 15 tests error. Ship it with the upgrade.

6. **`highlight_color` alias.** `app/models/note.rb` uses `alias_attribute :highlight_color, :color` on a `store_accessor`.
   - Breaks: in 8.x it raises "`color` is not an attribute" the first time it is used.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
   - Executed. Works on 7.0.

7. **`/journal` route.** `config/routes.rb:18`
   - Breaks: `get "/notes", "/journal", to:` (several paths in one call) raises in 8.1.
   - Fix: two routes, the first with `as: :notes` so `notes_path` survives.
   - Executed. Works on 7.0.

8. **Search form.** `app/views/notes/index.html.erb:12`
   - Breaks: `form_with(model: nil, ...)` raises in 8.1, which takes down the notes list and the redirect after sign-in.
   - Fix: drop `model: nil`.
   - Executed. Works on 7.0.

9. **Notebook filter.** `app/controllers/notes_controller.rb:18`
   - Breaks: `where(notebooks: @notebook)` (plural name for a singular association) produces `PG::UndefinedColumn`, so notebook filtering returns 500.
   - Fix: `where(notebook: @notebook)`.
   - Executed. Works on 7.0.

10. **Export generation.** `app/models/export.rb` `fragments.sum`
    - Breaks: summing strings raises `TypeError` (the Active Support override was removed in 7.2). Every export job fails.
    - Fix: `fragments.join`.
    - Executed. Works on 7.0.

11. **Reminder scheduling.** `Note#schedule_reminder` calls `set(wait_until: <Integer epoch>)`.
    - Breaks: `undefined method 'utc' for Integer`, so scheduling a reminder returns 500.
    - Fix: `wait_until: Time.at(reminder_epoch)`.
    - Executed. Works on 7.0.

12. **Citation retry.** `app/jobs/citation_enrichment_job.rb`
    - Breaks: `wait: :exponentially_longer` raises "Couldn't determine a delay" when a retry happens. This happens at retry time, not at boot.
    - Fix: `:polynomially_longer`. That option does not exist on 7.0, so ship it with the upgrade. The delay curve and jitter differ slightly.
    - Executed.

13. **Import rollback (silent data corruption).** `Import#apply` uses `return false` inside `transaction`.
    - Breaks: from 7.2 an early return commits instead of rolling back. An import with an invalid row saves the import, the earlier notes and their citations; the test saw counts `[1,4,1,2]` where `[0,3,0,1]` was expected.
    - Fix: `rows.all?(&:save) or raise ActiveRecord::Rollback`, then use the transaction's return value.
    - Executed. Works on 7.0.

14. **Import receipt (silent data change).** `Import#receipt` uses `citation[:id]`.
    - Breaks: Citation's primary key is `doi`. From 7.1, `[:id]` reads a column named `id`, so the receipt's doi column becomes blank.
    - Fix: `citation&.doi`.
    - Executed. Works on 7.0.

15. **Import preview annotations (silent display change).** `app/views/imports/preview.html.erb` uses `@import.annotations.stringify_keys`.
    - Breaks: `HashWithIndifferentAccess#stringify_keys` now converts the integer line keys to strings, so annotations disappear from the preview.
    - Fix: drop `.stringify_keys`.
    - Executed. Works on 7.0.

16. **Test config.** `config/environments/test.rb` `show_exceptions = false`
    - Breaks: on 8.1, `false` is no longer treated as `:none`. Errors render as 404/500 pages and the `assert_raises RecordNotFound` tests fail.
    - Fix: `:none`. Ship it with the upgrade; on 7.0, `:none` is truthy and would turn error pages on.
    - Executed.

## B. Behavior changes that need a product decision (tests still fail)
- **Digest day.** `DigestJob`'s `requested_at` now keeps the reader's time zone (7.1 serializer). `DigestMailer` then covers the reader's local day, not the UTC day documented in its comment. The test got Oct 04 where it expected Oct 05. Jobs queued by 7.0 still deserialize as UTC (executed). To keep current behavior, use `requested_at.utc` in the mailer. Otherwise update the comment and test. The Redis reservation key is still the UTC date, so the two would disagree.
- **"24 hours later" label.** 8.1 always keeps the zone in `TimeWithZone#to_time`, and the setting is deprecated. `Note#next_day_reminder_at` across a DST change now shows `2026-11-01T08:00-05:00` instead of `09:00-04:00`. It is the same moment and the stored epoch is unchanged; only the label differs. Accept the new label, or decide the rule should be "same local time tomorrow" (`reminder_at + 1.day`).

## C. Mixed-version rollout and rollback
- **DigestJob fails on 7.0 workers (executed).** 8.1 always uses `BigDecimalSerializer`; the `use_big_decimal_serializer` setting no longer exists. A DigestJob queued by 8.1 and run by a 7.0 worker fails with `ActiveJob::DeserializationError: Serializer ... BigDecimalSerializer is not known`. That happens during a rolling deploy or after a rollback.
  - DigestJob has no `discard_on`, so the job retries and then goes to the dead set. Because the Redis key `digest_requests:<date>` is already reserved, the reader can't request the digest again that day.
  - Fix before the upgrade: pass `reading_completion.to_s`. This works on 7.0; the mailer already calls `BigDecimal(...)` on it. Otherwise, drain the queues and retry set before deploying or rolling back.
- **Other jobs are compatible (executed).** CitationEnrichmentJob and NoteReminderJob, including jobs already scheduled in the Sidekiq set, read correctly in both directions. A 7.0 worker ignores the `time_zone` key that 8.1 adds to times.
- **ExportJob** is a native Sidekiq job and unaffected. Its symbol-key arguments already trigger the Sidekiq 7 strict-args warning; that predates this upgrade.
- **Stored data:** `notes.tags` stays in the same JSON format, `notebooks.preferences` stays YAML, and the schema needs no migration. `schema.rb` will be rewritten as `Schema[8.1]` on the next migration. The Active Storage service and blob layout are unchanged.

## D. New framework defaults (all still at the old value: the app calls `load_defaults 7.0` and sets none of them explicitly)
The gem-changes summary missed several of these; they come from railties 8.1.0 `configuration.rb`. Results come from the `load_defaults 8.1` test run unless marked otherwise.

**7.1**
- `default_column_serializer = nil` **breaks loading**: `Notebook`'s bare `serialize :preferences` raises. Fix: `coder: YAML` (executed), which keeps the existing YAML data.
- `raise_on_assign_to_attr_readonly` **breaks notebook settings**: `notebooks/_form` posts a hidden `slug`, which `NotebooksController` permits, so every settings save raises `ReadonlyAttributeError` (executed). Remove `:slug` from permitted params and the hidden field first.
- `raise_on_invalid_cache_expiration_time` **breaks the export list**: `exports/_export.html.erb:25` computes `expires_in: expires_at - Time.current`, which is negative for expired exports, so the page returns 500 (executed). On old defaults, the code (source only, not seen in logs) reports the error as handled instead of raising. Fix: clamp the value or skip caching expired exports.
- `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`: change the format of cookie and signed-ID metadata. Adopt in a separate deploy after 8.1 is stable; after that, rolling back to 7.0 would invalidate sessions and signed Active Storage URLs.
- `cache_format_version 7.1`, `marshalling_format_version 7.1`: affect the file or memory cache only. Clear the cache on rollback.
- `sanitizer_vendor` HTML5 (Action View and Action Text) and `dom_testing html5`: tests passed.
- `belongs_to_required_validates_foreign_key`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first...`, `generate_secure_token_on`, `commit_transaction_on_non_local_return` (the setting no longer exists; finding 13 applies regardless), encryption settings, `sqlite3_*`: little or no effect here. The app has no `after_commit`, secure tokens, encryption or SQLite. Source-based.
- `default_headers` (drops `X-Download-Options`), `query_log_tags_format`, `debug_exception_log_level`, `precompile_filter_parameters`, `add_autoload_paths_to_load_path=false`, `log_file_size`: low risk; not separately tested.
- `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`: the old values were removed upstream; finding 9 covers the second.

**7.2**
- `postgresql_adapter_decode_dates` **breaks the activity report**: `Notebook#daily_note_counts` calls `Date.iso8601(day)` on what is now a `Date`, raising `TypeError` (executed). Use `day.to_date` or `Date.parse(day.to_s)`.
- `yjit`: watch memory use.
- `validate_migration_timestamps`, `web_image_content_types` (+webp): no effect here; there is no image processing.
- `enqueue_after_transaction_commit`: 8.1 defaults it to false. If it is turned on, the jobs queued inside `with_lock` in `Citation#request_enrichment`, `Note#schedule_reminder` and `User#request_digest` would be deferred, and `schedule_reminder` relies on `job.job_id`. Leave it off.

**8.0**
- `strict_freshness`: `ExportDownloadsController#stale?` would check only `If-None-Match`. The blob is immutable, so impact is minimal.
- `Regexp.timeout = 1`: the DOI regex and CSV parsing are fine (source-based).
- `to_time_preserves_timezone :zone`: already effectively forced in 8.1; see section B.

**8.1**
- `escape_json_responses=false`, `escape_js_separators_in_json=false`: Jbuilder output would stop escaping `<>&` and U+2028.
- `action_on_path_relative_redirect=:raise`, `raise_on_missing_required_finder_order_columns`, `render_tracker=:ruby`, `remove_hidden_field_autocomplete`, `yjit` off in local environments.
- The test suite passed with these on, but none of them were exercised in a targeted way.

## E. Proposed sequence
1. **On 7.0:** ship findings 2, 3, 4, 6–11 and 13–15, plus the `completion.to_s` fix from section C. Verified 46/46 on 7.0. Fix the data already written by the import bug only if production ran on ≥7.2, which it hasn't.
2. **Upgrade deploy:** Rails 8.1.0 with the json pin and findings 5, 12 and 16. Drain the digest queue and retry set first. Settle the two section-B decisions.
3. **Afterwards, one release at a time:** adopt new defaults through `new_framework_defaults_*` files, starting with the four that break here, and do the message and cache format changes last.

## Still unverified / open questions
- Browser suite (`test:system`) and a real Sidekiq worker process: only deserialization and direct calls were tested.
- Production behavior with the real database credentials and `RAILS_LOG_TO_STDOUT`.
- Whether a later 8.1.x patch makes the json pin unnecessary.
- Changes to `to_plain_text` output in exports for complex rich text: the tests passed, but there's no corpus to compare against.
- Sidekiq 6.5 has no official support for Rails 8.1, although it worked here.
- Puma 5 with Rack 2: it resolved, but the server was not booted and loaded.
- Whether any existing import receipts or partially committed imports matter to users.

---

**Next steps:** This is a plan only. Your repo is unchanged and on `main`. Changing only the version would leave the app unable to boot. Before implementation, two things need a decision from you:
- the digest-day and DST-label questions in section B;
- whether to ship the 7.0-compatible fixes first, as section E recommends.

Once you've decided, I can start with step 1 on a new branch.