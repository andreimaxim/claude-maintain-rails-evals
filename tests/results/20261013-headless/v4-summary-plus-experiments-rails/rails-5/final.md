# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but **the app does not boot on 7.1 or later without code changes**, and several changes alter behaviour silently. The worst one saves partial CSV imports to the database while the tests still pass at the 7.1 step.

I tested this in disposable copies only: one per release (7.1.6, 7.2.4, 8.0.5.1, 8.1.0), each with its own Postgres cluster on port 55432 and Redis on port 56379. Storage and cache stayed inside each copy. `/home/user/workspace/repo` was not modified (`git status` is clean), and both services are now stopped.

With the changes listed below, the test suite passes on every version (46 runs, 0 failures). It also passes on 8.1 with `load_defaults 8.1`. I didn't run the browser tests (`bin/rails test:system`), because they need a display.

## Evidence
- **Tool output:** `/home/user/planner-run/claude-config/projects/-home-user-workspace-repo/3db0db0d-9612-40f7-9d86-198b4320e5bc/tool-results/b4gkoyx31.txt`
- **Copies and logs:** `/tmp/upg/app-{orig,7.0.8.7,7.1.6,7.2.4,8.0.5.1,8.1.0,8.1.0-defaults}`, logs in `/tmp/upg/logs/`.
- **Test runs:** `PARALLEL_WORKERS=1 /tmp/upg/runv.sh <ver> bin/rails test`. The runner and environment settings are in `/tmp/upg/runv.sh` and `/tmp/upg/env.sh`.
  - Logs: `test-*.log` through `test9-*.log`, plus `test-8.1.0-defaults81*.log`.
- **Proposed diff for 8.1:** `/tmp/upg/logs/proposed-8.1.diff`; lockfile diff in `/tmp/upg/logs/gemfile-lock-8.1.diff`.
- **Resolved gems for 8.1:** all Rails components 8.1.0, json 2.21.2 (after pinning), sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, concurrent-ruby 1.3.4, minitest 5.27.0, puma 5.6.9.
- **Queued-job compatibility:** `/tmp/upg/interop.sh` with scripts in `/tmp/upg/scripts/`; logs `interop-*.log`.
- **Session cookie compatibility:** `/tmp/upg/cookie.sh`.
- **Real worker:** Sidekiq 6.5.12 processing jobs on Rails 8.1; log `sidekiq-8.1.log`.

## A. Required changes, by the release that breaks them
"Works on 7.0" means I tested the change on 7.0 and the suite stayed green, so it can ship before the upgrade.

| # | Breaks in | Where | What happens | Fix | Works on 7.0? |
|---|---|---|---|---|---|
| 1 | 7.1 | `config/initializers/action_text.rb` | Boot fails: `undefined method '+' for nil`, because `allowed_tags` now defaults to nil. | In an `after_initialize` block, start from `allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]`, then add `details` and `summary`. | Yes (tested). The details/summary sanitizer test passes on HTML4 and HTML5. |
| 2 | 7.1 | `Export#generate`, `fragments.sum` | `TypeError`, so every export fails. Already deprecated on 7.0. | `fragments.join` | Yes |
| 3 | 7.1 | `config/environments/test.rb` `show_exceptions = false` | Deprecated in 7.1. On 7.2 it is treated as "rescue", so authorization and "raises" tests turn into false 404s and 500s. | `:none` | **No.** On 7.0 `:none` is truthy. Ship it with the 7.1 bump. |
| 4 | 7.1 | `DigestMailer#daily_digest` | Active Job now restores a time argument in the reader's time zone, so a digest covers the reader's local day instead of the documented UTC day. The test fails: "October 04" instead of "October 05". | `requested_at = requested_at.utc` | Yes |
| 5 | 7.2 | `Note`: `serialize :tags, JSON` | `ArgumentError` when the model loads. | `serialize :tags, coder: JSON` | **No.** On 7.0 the `coder:` keyword is ignored, tags load as a String, and the views crash. Writes would also use the wrong format. Ship with the 7.1 bump (7.1 accepts both forms). |
| 6 | 7.2 (deprecated 7.1) | `Note`: `alias_attribute :highlight_color, :color` (`color` comes from `store_accessor`) | `ArgumentError` when the model loads. | `alias_method` for both `highlight_color` and `highlight_color=` | Yes |
| 7 | 7.2 | `Note`: `enum status: …, _prefix: true` | Enum definition conflict when the model loads. | `enum :status, {…}, prefix: true` | Yes |
| 8 | 7.2 | `Rails.application.secrets` in `Citation::Provider` and `citation_enrichments_controller_test.rb` | `NoMethodError`. | Move `config/secrets.yml` to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider)`, and read that instead. The leading-zero user and special-character password test passes. | Yes |
| 9 | 7.2 | `CitationEnrichmentJob`: `wait: :exponentially_longer` | `RuntimeError` when it schedules a retry. | `:polynomially_longer` | **No.** Ship with 7.1+. |
| 10 | 7.2 | `Note#schedule_reminder`: `wait_until:` given an Integer epoch | `undefined method 'utc' for Integer`. | `wait_until: Time.at(reminder_epoch)` | Yes |
| 11 | 7.2 | `NotesController#index`: `where(notebooks: @notebook)` | `PG::UndefinedColumn notes.notebooks`. | `where(notebook: @notebook)` | Yes |
| 12 | 7.2 | `Import#receipt`: `citation[:id]` (the Citation primary key is `doi`) | Returns nil. **The receipt CSV silently loses every DOI.** | `note.citation_doi` | Yes |
| 13 | **7.2 (silent data risk)** | `Import#apply`: `return false` inside `transaction` | From 7.2, an early return **commits** the transaction. An invalid import then leaves the import record, earlier notes and citations in the database. Measured: counts went from [0,3,0,1] to [1,4,1,2]. On 7.1 it still rolls back, so the 7.1 test run did not catch it. | Compute `saved = rows.all?(&:save)`, `raise ActiveRecord::Rollback unless saved`, return `saved`. | Yes |
| 14 | 8.0 | `notes/index.html.erb`: `form_with(model: nil, …)` | `ArgumentError`, so the note list returns 500. | Drop `model: nil`. | Yes |
| 15 | 8.0 | `imports/preview.html.erb`: `annotations.stringify_keys`, then a lookup by Integer line number | Hash-with-indifferent-access now stringifies keys, so preview annotations silently disappear. | Drop `.stringify_keys`. | Yes |
| 16 | 8.0 (deprecated) / 8.1 (removed) | `Note#next_day_reminder_at`: `reminder_at.to_time + 86_400` | The comment documents that the result keeps the UTC offset. 8.1 always keeps the time zone instead, so the preview across a DST change shows -05:00 rather than -04:00. The scheduled epoch is unchanged, so only the display moves. 8.0 also prints deprecation warnings at boot. | `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` | Yes |
| 17 | 8.1 | `routes.rb`: `get "/notes", "/journal", …` | Boot fails ("Wrong number of arguments"). | Two routes: `as: :notes` and `as: :journal`. Route names are unchanged. | Yes |
| 18 | 8.1.0 dependency | json gem | Resolves to json 3.1.0, which rejects the positional `JSON.parse(src, opts)` call that activesupport 8.1.0 makes. The result is `ArgumentError` when decoding every cookie, so nobody can sign in. | `gem "json", "< 3"` (resolves to 2.21.2). I didn't check whether a later 8.1.x patch drops the need. | Yes (only 8.1 resolves json) |

**Rollout:** ship items 1, 2, 4, 6, 7, 8, 10–17 first on 7.0. Then upgrade one minor version per deploy (7.1 → 7.2 → 8.0 → 8.1), carrying items 3, 5 and 9 in the 7.1 commit and item 18 in the 8.1 commit.

## B. Data, queued jobs, and mixed-version risks

**Executed checks.** Jobs went through the real Sidekiq adapter into the isolated Redis and were then executed by the other version.
- **Jobs queued on 7.0, run on 8.1:** all four job types succeed. The BigDecimal argument arrives as the string "1.0", and the mailer's `BigDecimal(...)` handles it.
- **Jobs queued on 7.1, run on 7.0:** succeed. 7.0 ignores the new `time_zone` key in time arguments.
- **Jobs queued on 7.2, run on 7.1:** the jobs that ran succeeded. The citation enrichment job was skipped in that run because the citation was still marked pending from an earlier run, so that direction is untested for it.
- **Jobs queued on 8.1, run on 7.0:** **`DigestJob` fails** with `DeserializationError: BigDecimalSerializer is not known`. From 7.2 a BigDecimal argument always uses the new serializer, and 7.1 already logs a deprecation for it.
  - Effect: rolling back from 7.2+ to 7.0, or running 7.0 workers alongside 7.2+ web servers, leaves digest jobs failing and retrying.
  - Recommendation: pass `reading_completion.to_s` from `User#request_digest`. The mailer already parses it, and it works on every version. Otherwise make sure workers never run older than 7.1 during the rollout. This fix is proposed but untested.
- **Scheduled reminders** survive in both directions (7.0 ↔ 8.1). Export payloads are unchanged.
- **Session cookies** are readable in both directions: 7.0 ↔ 8.1 with `load_defaults 7.0`, and with `load_defaults 8.1`, given the same secret.
  - Development only: 7.1+ reads `tmp/local_secret.txt` instead of `tmp/development_secret.txt`, and honours `SECRET_KEY_BASE`, so local sessions will reset.
- **Stored data formats** are unchanged: tags are still JSON text and preferences are still YAML. A notebook written on 7.0 exported correctly on 8.1.
- **Real worker:** Sidekiq 6.5.12 boots on Rails 8.1 and processes jobs, including a retry.
  - It logs that the built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Plan a move to Sidekiq 7.3.3+ separately.
  - Under Sidekiq 7's strict arguments, `ExportJob.perform_async(id, { format: "markdown" })` with a symbol key would raise. Use string keys before that move.
- **Jobs enqueued under row locks** (`Citation#request_enrichment`, `Note#schedule_reminder`): with `load_defaults 7.0`, no version defers enqueues to after commit (checked in the 7.2, 8.0 and 8.1 source). The "a failed enqueue rolls back" guarantee therefore still holds.

## C. New framework defaults

The app keeps `load_defaults 7.0` and sets none of the settings below, so it keeps every old value. All of this is optional.

**The tool's list is incomplete.** It omits all 8.1 defaults and several 7.1 ones. I read these from railties 8.1.0, `configuration.rb`.

### 7.1
- **`raise_on_assign_to_attr_readonly`:** breaks notebook settings (`ReadonlyAttributeError: slug`), because the form resubmits the slug. Fix: stop permitting `:slug` and remove the hidden field (item 13 in the experiment diff, safe on 7.0).
- **`raise_on_invalid_cache_expiration_time`:** the export availability fragment uses a negative `expires_in` once an export expires, so the exports page returns 500. Fix: `[expires_at - Time.current, 1.second].max` (tested).
- **`default_column_serializer = nil`:** `serialize :preferences` with no coder would raise. Fixed by `coder: YAML`, which keeps the stored data.
- **`message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`:** cookie compatibility tested OK in both directions. Still enable them in a later deploy than the version bump, as the Rails guide says. I didn't test other signed messages.
- **`cache_format_version 7.1`:** production uses a per-host file store under `tmp/cache`. 7.0 hosts cannot read the new format, so enable it only after every host runs 7.1+. Source-based, not tested.
- **`marshalling_format_version 7.1`:** the app caches no Active Record objects. No impact found.
- **`run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances…`, `before_committed_on_all_records`:** the app defines no commit callbacks. No impact.
- **`belongs_to_required_validates_foreign_key = false`:** fewer queries. For `Note.belongs_to :citation, validate: true` it should be harmless; the tests pass.
- **`generate_secure_token_on`, encryption digest settings, `sqlite3_adapter_strict_strings`:** not used here (no secure tokens, no encryption, Postgres).
- **`query_log_tags_format`:** query log tags aren't enabled.
- **`sanitizer_vendor` HTML5 for Action View and Action Text:** the rich-text and XSS tests pass. The rendered HTML whitespace changes slightly.
- **`dom_testing_default_html_version :html5`:** the tests pass.
- **`precompile_filter_parameters`, `debug_exception_log_level`:** no impact.
- **`add_autoload_paths_to_load_path = false`:** nothing requires files from `app/` by path. The Zeitwerk check passes.
- **`log_file_size`** (development/test only): no impact.
- **`allow_deprecated_parameters_hash_equality = false`:** no Parameters-to-Hash comparisons found.
- **`use_big_decimal_serializer`:** see section B; it is mandatory from 7.2.
- **`action_dispatch.default_headers`:** same values as 7.0.

### 7.2
- **`postgresql_adapter_decode_dates`:** `Notebook#daily_note_counts` then gets a `Date`, and `Date.iso8601(Date)` raises `TypeError`, so the activity report returns 500. Fix: `day.to_date` (works either way, tested).
- **`enqueue_after_transaction_commit = :default`:** only exists in 7.2 and 8.0, and was removed in 8.1. With the Sidekiq adapter it would defer enqueues, weakening the guarantees described in the comments in `Citation` and `Note`. Recommendation: do not adopt.
- **`validate_migration_timestamps`:** all migration timestamps are valid.
- **`web_image_content_types` + webp:** no variant processing, so no impact.
- **`yjit`:** memory consideration only.

### 8.0
- **`to_time_preserves_timezone = :zone`:** handled by item 16.
- **`strict_freshness`:** `ExportDownloadsController` sends both an ETag (the blob checksum) and Last-Modified. Only `If-None-Match` would be checked, which is fine because the checksum is stable.
- **`Regexp.timeout = 1`:** CSV parsing is capped at 100 KB. Low risk, not load-tested.

### 8.1
- **`escape_json_responses = false`:** the app has no JSON views.
- **`action_on_path_relative_redirect = :raise`:** no relative redirects found.
- **`raise_on_missing_required_finder_order_columns`:** no impact found.
- **`escape_js_separators_in_json = false`:** no impact found.
- **`render_tracker = :ruby`:** no impact found.
- **`remove_hidden_field_autocomplete`:** affects the hidden `import[csv]` and slug fields. Low risk.
- **`yjit` only outside development/test:** memory consideration only.
- With every fix above, `load_defaults 8.1` passed the full suite, Zeitwerk check, production boot and asset precompile.

## D. Tool output that was noise or wrong
- **Irrelevant matches:** `Request#content_type`, `rewhere` on `merge` (the app calls `Hash#merge`), `include_time_with_zone`, `to_s` formats, `InternalMetadata`, `deferrable`, `simple_format`, and the `select` helper.
- **Wrong or missing entries:** it lists `to_time_preserves_timezone` under 8.0. In 8.1 the setting is deprecated and 8.1 always preserves the zone. It also missed the json 3 incompatibility and the 8.0 `form_with`/`stringify_keys` breaks.

## E. Not verified yet
- Browser tests (`bin/rails test:system`).
- Production cache-format mixing and other signed or encrypted messages beyond the session cookie.
- Whether a later 8.1.x patch removes the need for the json pin.
- The proposed `DigestJob` string-argument change.
- Behaviour on a real multi-host deployment.
- Assumption: a CI or production Postgres other than version 15 behaves the same.
- Schema dump on 8.1 reorders columns alphabetically and writes `pg_catalog.plpgsql`. That is a cosmetic diff on the next migration.

---

This is a plan only; I haven't changed your repository. The upgrade goes from Rails 7.0.8.7 to 8.1.0, which is several releases, not a single bump. The biggest risk is item A13: from 7.2 on, an invalid CSV import silently saves partial data. Ship that fix before anything else.

The working diff for 8.1 is in `/tmp/upg/logs/proposed-8.1.diff`. Do you want me to implement it, starting with the changes that already work on 7.0?