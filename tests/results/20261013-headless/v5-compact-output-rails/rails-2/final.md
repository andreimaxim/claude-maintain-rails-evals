Here's the upgrade plan from the planner agent, unedited. I didn't change your working repository.

---

I've finished the evaluation. Rails 7.0.8.7 → 8.1.0 is feasible for this app, but it needs about 15 code changes. Several of them fail silently with existing data rather than at boot, and four would be unsafe if shipped while Rails 7.0 is still running. I upgraded a disposable copy to 8.1.0 with `load_defaults 7.0` kept, fixed what broke, and got the suite to green (46 runs, 0 failures, both normal and eager-loaded). I also ran Sidekiq jobs across the 7.0/8.1 boundary in both directions. The working repo was not modified.

## How the evidence was gathered

**Isolation:**
- **Database:** separate Postgres databases `margin_notes_upg_dev`, `margin_notes_upg_test` and `margin_notes_upg_test70`.
- **Redis:** `REDIS_URL=redis://localhost:6379/13`.
- **Gems:** installed into `/tmp/up/bundle`.
- **Storage and mail:** a shared temp directory `/tmp/up/shared-storage`, with each copy writing mail to its own `tmp/mails`.

**Copies:**
- `/tmp/up/app` is the 8.1.0 copy.
- `/tmp/up/app70` is a 7.0.8.7 copy used to test which fixes also work on the current version.

**What got installed:** `bundle update rails --conservative` (log `/tmp/up/bundle-8.1.log`, lock diff `/tmp/up/lock-diff-8.1.txt`) gave rails 8.1.0, sidekiq 6.5.12, redis 4.8.1, pg 1.6.0, puma 5.6.9, minitest 5.27.0 and rack 2.x. It also pulled in **json 3.1.0**, which breaks at runtime (see R0). The lock with json 2.21.2 is saved at `/tmp/up/Gemfile.lock.8.1-json2`.

**Logs:**
- 7.0 baseline: `/tmp/up/baseline-7.0.log` (46 runs, green; one Rails 7.0 deprecation for `Enumerable#sum` at `export.rb:42`).
- 8.1 with no changes: boot fails (`/tmp/up/boot-8.1.log`), then eager load fails (`/tmp/up/eager-8.1.log`).
- 8.1 test runs as fixes were added: `/tmp/up/test-8.1.log` (11 failures, 35 errors) → `test-8.1b.log` → `test-8.1c.log` → `test-8.1d.log` → `test-8.1e.log` (green). Eager-loaded run: `test-8.1e-eager.log`. `zeitwerk:check` passes.
- Experimental code diff: `/tmp/up/portable.diff`.
- Fixes run on 7.0: `/tmp/up/test-7.0-portable.log` (green, normal and `CI=1`, after removing the three changes that don't work on 7.0).
- 8.1 with `load_defaults 8.1`: `/tmp/up/test-8.1-defaults81.log`.
- Jobs across versions: `/tmp/up/sidekiq-81-consumes-70.log` and `/tmp/up/sidekiq-70-consumes-81.log`, with Redis payloads in `/tmp/up/payloads-70.txt` and `/tmp/up/payloads-81.txt`, and argument serialization in `/tmp/up/args-81.json`.
- Change summary from the gem-changes tool: `/tmp/up/changes.txt`.

**Mistake on my part:** I accidentally ran two read-only commands (`bin/rails routes` and a `rails runner`) against the working repo. That may have written bootsnap's cache under `tmp/`; `git status` is still clean.

## Required changes

"Works on 7.0" means I applied the change in `/tmp/up/app70` and the suite stayed green (executed), unless marked otherwise.

| # | Affected code | What breaks on 8.1 (how found) | Fix | Works on 7.0? |
|---|---|---|---|---|
| R0 | `Gemfile` / `Gemfile.lock` | activesupport 8.1.0 adds a `json >= 0` dependency, so the resolver picked json 3.1.0. `ActiveSupport::JSON.decode` then raises "wrong number of arguments", breaking JSON columns and Active Storage blob metadata (executed). | Pin `gem "json", "< 3"`; this resolved to 2.21.2 and fixed it. Recheck once a later 8.1.x supports json 3 (not verified). | Not applicable |
| R1 | `config/initializers/action_text.rb` | Boot crash: `ActionText::ContentHelper.allowed_tags` starts as `nil` from 7.1 on, so `nil += [...]` fails (executed). | Use an `after_initialize` block: start from the existing allowlist, or the sanitizer's default tags plus attachment, `figure` and `figcaption`, then add `details` and `summary`. Verified on the HTML4 and HTML5 sanitizers. | Yes |
| R2 | `note.rb:10` `enum status: {...}, _prefix: true` | ArgumentError when the class loads (executed). | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes |
| R3 | `note.rb:13` `serialize :tags, JSON` | The positional coder argument was removed in 7.2. | `serialize :tags, coder: JSON` | **No.** On 7.0 `coder:` is silently ignored and the column falls back to YAML (executed: views raised "undefined method any? for String"). Deploying it on 7.0 would write YAML into `tags`. Ship it in the 7.1 step. |
| R4 | `note.rb:14` `alias_attribute :highlight_color, :color` (`color` is a `store_accessor` key) | "color is not an attribute" ArgumentError, 22 test errors (executed). | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes |
| R5 | `citation/provider.rb:13`, `config/secrets.yml`, `citation_enrichments_controller_test.rb:117-122` | `Rails.application.secrets` was removed in 7.2 (executed). | Move the values to `config/citation_provider.yml`, load them with `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.application.config.x.citation_provider` in the provider and the test helper. Deploy environments must still set `CITATION_PROVIDER_*`. | Yes |
| R6 | `config/routes.rb:18` `get "/notes", "/journal", to:` | Defining several paths in one call was removed in 8.1; `notes_path` stops existing (executed). | Two lines: `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. This keeps the 7.0 route names `notes` and `journal`. | Yes |
| R7 | `notes/index.html.erb:12` `form_with(model: nil, …)` | "Passed nil to the :model argument" (executed). | Remove `model: nil`. | Yes |
| R8 | `notes_controller.rb:18` `where(notebooks: @notebook)` | PG error: column `notes.notebooks` does not exist (executed). | `where(notebook: @notebook)` | Yes |
| R9 | `note.rb:62` `set(wait_until: reminder_epoch)` with an Integer | `undefined method utc for Integer`, so reminders can't be scheduled (executed). | `set(wait_until: Time.at(reminder_epoch))` | Yes |
| R10 | `export.rb:42` `fragments.sum` | Rails' `Enumerable#sum` for strings, deprecated in 7.0, is gone in 7.1. | `fragments.join` | Yes (also removes the 7.0 deprecation) |
| R11 | `citation_enrichment_job.rb:7` `wait: :exponentially_longer` | Removed in 7.2. | `:polynomially_longer` (same delay formula) | **No.** On 7.0 it raises "Couldn't determine a delay" (executed). Ship it in the 7.1 step. |
| R12 | `config/environments/test.rb:31` `show_exceptions = false` | Boolean values were removed in 7.2. | `:none` | **No.** On 7.0 the symbol is truthy and exceptions get rendered (executed: 23 failures). Ship it in the 7.1 step. |

### Silent data and behavior changes

The suite caught some of these. Production would see only the bad results.

**R13. Import apply now commits partial imports** (`import.rb#apply`).
- **Cause:** it uses `return false` inside `transaction`. Up to 7.0 that rolls back; in 7.1 it rolls back with a deprecation warning; from 7.2 it always commits.
- **Effect:** an invalid row leaves the `Import` row plus the earlier notes and citations saved (executed: `record_counts` went from `[0,3,0,1]` to `[1,4,1,2]`).
- **Fix:** `rows.all? { |row| row.note.save } or raise ActiveRecord::Rollback` inside the block, returning the transaction's result. Works on 7.0.
- **Check afterwards:** look for any partial imports created while 7.2 or later code was running before this fix.

**R14. The import receipt's DOI column comes back blank** (`import.rb#receipt`).
- **Cause:** `citation[:id]`. `Citation` uses `doi` as its primary key, and from 7.2 `[:id]` no longer maps to the primary key, so it returns nil.
- **Effect:** downloaded receipt CSVs lose every DOI (executed).
- **Fix:** `citation&.doi`. Works on 7.0.

**R15. Import preview stops showing annotations** (`imports/preview.html.erb:22`).
- **Cause:** `annotations.stringify_keys`. From 7.1 this really converts the integer line-number keys to strings, so `annotations[row.line]` finds nothing (executed).
- **Fix:** drop `.stringify_keys`. Works on 7.0.

**R16. Digest emails can cover the wrong day** (`digest_mailer.rb` and `User#request_digest`).
- **Cause:** from 7.1 Active Job keeps the time zone of `TimeWithZone` arguments. `requested_at.to_date` and `.all_day` now use the reader's local day, not the UTC day the product promises (executed: "October 04" instead of "October 05").
- **Fix:** add `requested_at = requested_at.utc` in the mailer. That also handles jobs already queued by 7.0 (their argument has no zone and deserializes as UTC). Works on 7.0.

**R17. Rollback breaks queued digest jobs** (`User#request_digest`).
- **Cause:** from 7.2 a `BigDecimal` argument always uses `BigDecimalSerializer`, and Rails 7.0 can't read it (executed: `ActiveJob::DeserializationError: Serializer ... BigDecimalSerializer is not known`).
- **Effect:** digests queued by 8.1 fail on 7.0 workers during a rolling deploy or rollback.
- **Fix:** pass `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`. Works on 7.0. With this change, 8.1-enqueued Digest, Export and Reminder jobs ran on 7.0 Sidekiq, and 7.0-enqueued jobs ran on 8.1 (executed).

**R18. The "24 hours later" reminder preview shows a different wall-clock time** (`Note#next_day_reminder_at`).
- **Cause:** 8.1 forces `to_time` to keep the zone (the `to_time_preserves_timezone` setting is deprecated and warns at boot under `load_defaults 7.0`).
- **Effect:** across a daylight-saving change the preview shows 08:00-05:00 instead of 09:00-04:00. The scheduled epoch, and so the actual send time, is unchanged (executed).
- **Fix to keep the current documented behavior:** `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. Works on 7.0. Alternatively, accept the new display as a product decision and update the test and the model comment.

## New framework defaults, release by release

The app calls `load_defaults 7.0`. None of the settings below is set explicitly, so the app keeps every old value. I ran the full suite under `load_defaults 8.1` (after adding `serialize :preferences, coder: YAML`).

### 7.1 (all kept at the old value)

**Need code changes before adopting:**
- **`default_column_serializer = nil`:** `Notebook` fails to load with "missing keyword :coder" (executed). Before adopting, add `serialize :preferences, coder: YAML`. It must stay YAML because stored rows are YAML.
- **`raise_on_assign_to_attr_readonly`:** notebook settings updates raise `ReadonlyAttributeError` on `slug` (executed), because `notebooks/_form` re-submits the hidden slug and the controller permits it. Remove both; that works on 7.0.

**Rollout risk (adopt only after every server and worker runs 8.1, in a separate deploy):**
- **`message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`:** these change the format of new signed messages. The important case is the Action Text attachment `sgid`s stored inside `action_text_rich_texts.body`: rich text written after adoption may not resolve on 7.0 after a rollback. Session cookies are already JSON. This is source-based; I did not test it.
- **`cache_format_version = 7.1`** and **`marshalling_format_version`:** 7.0 can't read the new entries. The app only caches fragments in `exports/_export`, so on rollback, clear the cache.
- **`run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`:** the app defines no commit callbacks, so no effect expected.

**Little or no effect here:**
- **`action_view` and `action_text` `sanitizer_vendor` → HTML5:** with the R1 initializer, `details` and `summary` survive (executed). Already-stored rich text gets sanitized differently when rendered.
- **`dom_testing_default_html_version = :html5`:** passed.
- **Encryption settings:** the app doesn't use Active Record encryption.
- **`belongs_to_required_validates_foreign_key = false`:** removes the extra parent lookup query.
- **`precompile_filter_parameters`, `query_log_tags_format`, `debug_exception_log_level`, `log_file_size`, `default_headers`:** no effect expected.
- **`add_autoload_paths_to_load_path = false`:** `zeitwerk:check` passes. The tool's list missed this one, `default_headers` and `cache_format_version`.
- **`sqlite3_adapter_strict_strings_by_default`:** not applicable (the app uses Postgres).
- **`generate_secure_token_on`:** the app has no `has_secure_token`.
- **`allow_deprecated_parameters_hash_equality`:** no Parameters-to-Hash comparisons found.
- **`raise_on_invalid_cache_expiration_time`:**
  - **Current problem:** `exports/_export.html.erb:26` passes a negative `expires_in` for an expired export.
  - **If the default is adopted:** this raises an error (executed).
  - **With the default kept:** 8.1 instead reports a handled error on every such render.
  - **Fix:** only cache when `export.expires_at.future?`.
- **`use_big_decimal_serializer`:** this setting no longer exists; the new serializer is always on from 7.2 (see R17).

### 7.2 (all kept at the old value)
- **`postgresql_adapter_decode_dates`:** `Notebook#daily_note_counts` raises TypeError because `select_rows` now returns a `Date` and the code calls `Date.iso8601(Date)` (executed). Fix by accepting either type: `day.is_a?(Date) ? day : Date.iso8601(day)`.
- **`enqueue_after_transaction_commit`:** in 8.1 this config is removed and each job's default is false, so enqueueing inside `with_lock` still rolls back on failure, as the comments in `Citation` and `Note` rely on (source). Do not turn it on: those failure semantics would change.
- **`validate_migration_timestamps`:** all migration timestamps are well-formed.
- **`web_image_content_types` (adds webp):** the app generates no image variants.
- **`yjit = true`:** check memory on the hosts.

### 8.0 (kept at the old value)
- **`strict_freshness`:** `ExportDownloadsController` uses `stale?(etag:, last_modified:)`. With it on, only `If-None-Match` decides; the etag is the blob checksum, so the effect is negligible (source; not exercised).
- **`Regexp.timeout = 1`:** the app has no heavy regexes, though DOI validation is worth a glance.
- **`to_time_preserves_timezone = :zone`:** forced anyway in 8.1 (see R18).

### 8.1 (kept at the old value)
- **`action_on_path_relative_redirect = :raise`:** no `redirect_to` uses a relative string.
- **`escape_json_responses = false`, `escape_js_separators_in_json = false`:** the app renders no JSON.
- **`raise_on_missing_required_finder_order_columns`:** no `first` or `last` calls on unordered relations found.
- **`render_tracker = :ruby`, `remove_hidden_field_autocomplete`:** cosmetic.
- **`yjit = !Rails.env.local?`:** affects production only.

## Order of rollout
1. **Changes that also work on 7.0:** R1, R2, R4–R10, R13–R18, plus the slug-form and export cache-expiry changes from the defaults list. All were executed green on 7.0. Deploy and drain first; they also make jobs safe in both directions.
2. **7.1 step:** R3, R11, R12 together with the Rails bump (all three forms are accepted on 7.1). Run the suite with deprecations made fatal.
3. **Then 7.2, 8.0, 8.1 in turn,** with R0 at whichever step brings in json 3. Keep `load_defaults 7.0` and confirm no deprecations remain before each bump. I tested only the 7.0 and 8.1 endpoints, not the intermediate versions.
4. **Adopt new defaults one release at a time,** in deploys separate from the version bumps. The message and cache serializer settings go last.

**Before you start:**
- **Data:** confirm no stored `tags` contain YAML, check whether `notebooks.preferences` contains anything other than plain Hash or String values, and look for partial imports.
- **Queues:** drain or inspect the Sidekiq `schedule` and `retry` sets before rolling back. Reminders can be scheduled days ahead, and payloads written by 8.1 carry `scheduled_at` as a Time (7.0 read one successfully, executed).

## Still unverified
- The 7.1, 7.2 and 8.0 intermediate versions were not run.
- No browser system tests or production-mode boot were run.
- `strict_freshness` and the message-serializer rollback effect on Action Text `sgid`s were not tested.
- Sidekiq 6.5.12 works on 8.1 but warns that the built-in adapter is deprecated (removed in 8.2). Moving to Sidekiq 7.3.3+ is a separate change: under its strict argument rules, `ExportJob`'s symbol-key options (`{ format: "markdown" }`) would be rejected.
- I haven't confirmed whether a later 8.1.x is compatible with json 3.
- Boot also logs an image_processing warning; `variant_processor = :disabled` would silence it.
- `bin/rails app:update` was not run. In development, the secret file moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`, which will reset local sessions.

The temporary databases `margin_notes_upg_*` still exist; Redis db 13 holds the test jobs and can be flushed.

---

**My notes:**
- This is a plan only, so the Gemfile still pins `rails` at 7.0.8.7. The 8.1.0 bump and its fixes were tried only in throwaway copies under `/tmp/up`.
- The agent accidentally ran two read-only Rails commands in your repo. Git still shows no changes, though they may have left a bootsnap cache under the ignored `tmp/` folder.
- The test databases `margin_notes_upg_*` and Redis db 13 are still there. I can delete them if you'd like.
- To implement the plan, I'd start with step 1 of the rollout: the fixes that also work on Rails 7.0, in their own commit.