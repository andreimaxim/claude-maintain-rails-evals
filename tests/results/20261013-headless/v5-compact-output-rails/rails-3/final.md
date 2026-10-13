# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

I upgraded a disposable copy to Rails 8.1.0. At first it would not boot, and once it did, all 46 tests errored. After 17 small fixes, all 46 tests pass with `load_defaults 7.0`. It also passes `zeitwerk:check`, asset precompilation and a production-mode server start.

Several fixes change behaviour the tests did not catch. The most serious: CSV imports could save partially, reminder times shift across daylight saving, and old servers cannot run some digest jobs queued by new ones. Nothing in `/home/user/workspace/repo` was modified.

## How I tested
- **Copies:** `/tmp/up/app` is the upgraded copy (Gemfile `rails "8.1.0"` plus `json "< 3"`). Its fixes are committed as one commit, so `git -C /tmp/up/app diff HEAD~1` shows them all. `/tmp/up/app70` is an unchanged 7.0.8.7 copy.
- **Isolation:** each copy used its own PostgreSQL databases (`mn_upg_test`, `mn_upg_dev`) through `DATABASE_URL`, and a private Redis on port 6390 (`REDIS_URL`), now shut down. Storage and cache stayed inside each copy's own `tmp/` and `storage/`. The two databases are still there to drop.
- **One slip:** early on I ran a single `bin/rails runner` probe in the real repo against the isolated database. It could only write to ignored `tmp/` and `log/`, and `git status` is still clean.
- **Logs** are in `/tmp/up/`:
  - Change index from the tool: `summary.txt`
  - Test runs: `test-base.log` (7.0, 46/46 pass), then `test-81.log` through `test-81i.log` (8.1, one per fix step, ending green)
  - Bundle output: `bundle-81.log`, `bundle-81-json.log`
  - Experiments: `probe-70.log` / `probe-81.log`, `enq-*.log` / `drain-*.log` (job payloads), `test-defaults-{7.1,7.2,8.0,8.1}.log`, `assets-81.log`, `server-81.log`

## A. Required changes (each one failed when run on 8.1)

| # | Where | What breaks on 8.1 | Fix | Works on 7.0 too? |
|---|---|---|---|---|
| 1 | Gemfile | Bundler picks `json 3.1.0`. Rails 8.1.0 calls `JSON.parse(json, options)`, which json 3 rejects, so every JSON column read raises `ArgumentError` | Pin `gem "json", "< 3"` (resolved to 2.21.2), or use a later 8.1.x patch | Yes |
| 2 | `config/initializers/action_text.rb` | `ActionText::ContentHelper.allowed_tags` starts as `nil` in 7.1+, so `+=` crashes at boot | Set it in `after_initialize`: take the existing list, or the sanitizer's default tags plus the attachment tag, `figure` and `figcaption`, then add `details` and `summary` | Probably (written to handle both, not run on 7.0) |
| 3 | `Note` | `enum status: {...}, _prefix: true` keyword form removed in 8.0 | `enum :status, { draft: 0, ready: 1 }, prefix: true` (`Citation` already uses this form) | Yes |
| 4 | `Note`, `Notebook` | Passing the coder as a second argument to `serialize` was removed in 7.2 | `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML` | No. Put it in the upgrade commit |
| 5 | `Note` | `alias_attribute :highlight_color, :color` points at a store accessor, not a column, and is now rejected | `alias_method` for both the reader and the writer | Yes |
| 6 | `config/routes.rb` | `get "/notes", "/journal", ...` (several paths in one route) removed in 8.1, so `notes_path` disappears | Two routes: `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index"` | Yes |
| 7 | `Citation::Provider` and its test | `Rails.application.secrets` removed in 7.2 | Load `config/citation_provider.yml` with `config.x.citation_provider = config_for(:citation_provider)`, then retire `config/secrets.yml`. Test rewritten to change `Rails.configuration.x.citation_provider` | Yes (`config_for` exists in 7.0). The environment variable names stay the same |
| 8 | `Export#generate` | `fragments.sum` on strings: Rails' override was removed in 7.1, so it raises `TypeError` and **every export fails** | `fragments.join` | Yes |
| 9 | `Note#schedule_reminder` | `set(wait_until: reminder_epoch)` with an Integer raises `undefined method 'utc'`, so reminders cannot be scheduled (500 error) | `wait_until: Time.at(reminder_epoch)` | Yes |
| 10 | `CitationEnrichmentJob` | `:exponentially_longer` removed in 7.2 | On 8.1: `:polynomially_longer`. To also work on 7.0: a lambda, e.g. `->(n) { n**4 + 2 }` | Lambda yes; the symbol no |
| 11 | `notes/index.html.erb` | `form_with(model: nil, ...)` now raises | Remove `model: nil` | Yes |
| 12 | `NotesController#index` | `where(notebooks: @notebook)` now becomes a nonexistent `notes.notebooks` column (SQL error) | `where(notebook: @notebook)` | Yes |
| 13 | `imports/preview.html.erb` | `HashWithIndifferentAccess#stringify_keys` now converts integer keys, so `annotations[row.line]` misses and **CSV preview silently drops annotations** | Remove `.stringify_keys` | Yes |
| 14 | `Import#receipt` | `citation[:id]` returns nil on 8.1 because the primary key is `doi`, so **receipt CSVs have empty DOIs** (both shown in `probe-*.log`) | `citation&.doi` | Yes |
| 15 | `Import#apply` | `return false` inside `transaction` rolls back on 7.0 but **commits** on 8.0+ (the old-behaviour setting was removed in 8.0). That means **partial imports would be saved**. Tests missed it because an earlier assertion failed first | Flag-based form: `raise ActiveRecord::Rollback unless rows.all? { _1.note.save }`, set `applied = true` inside, return `applied` after the block. Never use `return` inside the block | Yes |
| 16 | `Note#next_day_reminder_at` | `to_time` now always keeps the time zone (the setting is ignored in 8.1). Across a DST change, postponing gives 08:00 -05:00 where 7.0 gave 09:00 -04:00: same moment, different display and timezone offset (the test fails) | To keep the documented offset behaviour: `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. Or decide on the new behaviour and update the comment and test | Yes |
| 17 | `DigestMailer` | Time-with-zone job arguments now keep their zone, so the digest covers the **reader's local day, not the UTC day** (subject date changes and does not match the UTC Redis reservation key) | Convert in the mailer: `requested_at.in_time_zone("UTC")`. Or adopt local days and change the Redis key to match | Yes |
| 18 | `config/environments/test.rb` | `show_exceptions = false` no longer re-raises, so tests expecting `RecordNotFound` fail | `:none` | No (7.1+ only). Upgrade commit |

## B. Rollout and rollback risks (from the job payload experiment)
- **Digest jobs fail on old workers (shown).** On 8.1, Active Job always uses `BigDecimalSerializer`. A `DigestJob` queued by 8.1 fails on a 7.0 worker with `DeserializationError: BigDecimalSerializer is not known`. It would be retried and then dropped, and the reader's reservation for that day blocks asking again.
  - **Before the upgrade:** in `User#request_digest`, pass `reading_completion.to_s`. It works on both versions (`DigestMailer` already calls `BigDecimal(...)`).
  - **Order:** deploy all workers before any web process, and drain the `default` queue and the scheduled-jobs set before rolling back.
- **Other job payloads (shown).** Reminder and citation-enrichment jobs worked in both directions. A 7.0 digest job read on 8.1 arrives in UTC, which matches the old behaviour. The extra `scheduled_at` and `time_zone` fields from 8.1 are ignored by 7.0.
- **Stored data (shown).** `Notebook#preferences` written as YAML by 7.0 reads and writes correctly on 8.1 with `coder: YAML`, and back again. `tags` stays JSON.
- **Unchanged behaviour (shown).** `ActiveJob::Base.enqueue_after_transaction_commit` is `false` on 8.1, so jobs queued under row locks behave as on 7.0.
- **Sidekiq.** I kept Sidekiq 6.5.12 and redis 4.8.1; they work with the built-in adapter, and rack stays at 2.2. Rails 8.1 deprecates the built-in Sidekiq adapter. Moving to Sidekiq 7.3.3 or later is a separate change with its own breakage:
  - `Sidekiq.redis { sadd }` returns an Integer, and 0 is truthy in Ruby, so the digest de-duplication would stop working. The log already warns about `sadd`.
  - `rescue Redis::BaseError` in `Notebook#request_export` would no longer catch Redis errors.
  - Strict arguments would reject `ExportJob`'s `{ format: "markdown" }`; the warning already appears in the logs.

## C. Optional framework defaults (all currently on old values via `load_defaults 7.0`)
`test-defaults-*.log` shows what fails when each version's defaults are loaded. The same three errors appear by 7.2:
- **7.1**
  - `raise_on_assign_to_attr_readonly`: notebook settings update raises `ReadonlyAttributeError: slug`, because the form resubmits `slug`. Remove `:slug` from `notebook_params` first (works on both versions).
  - `raise_on_invalid_cache_expiration_time`: `exports/_export.html.erb:26` raises once an export has expired. Today that is only reported and logged, and expired exports already pass a negative `expires_in`. Guard it, e.g. skip the cache when expired, or `expires_in: [.., 0].max`.
  - `default_column_serializer = nil`: harmless once fix 4 sets the coders explicitly.
  - `cache_format_version 7.1`, `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`, `marshalling_format_version`: 7.0 cannot read what these write. Adopt them in a later deploy, after rollback to 7.0 is no longer possible.
  - Sanitizer HTML5 vendor (Action View and Action Text): check rendering of `<details>` and `<summary>` in rich text.
  - `dom_testing_default_html_version :html5`: may change `assert_select` results.
  - `belongs_to_required_validates_foreign_key = false`: the `Note`/`Citation` association uses `citation_doi`; check it.
  - Neutral for this app: `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `generate_secure_token_on`, `precompile_filter_parameters`, `add_autoload_paths_to_load_path=false`, `debug_exception_log_level`, `query_log_tags_format`, `log_file_size`. Encryption digest settings are not applicable because the app has no encrypted attributes.
- **7.2**
  - `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises `TypeError` in `Date.iso8601`. Handle both, e.g. `day.is_a?(Date) ? day : Date.iso8601(day)` (works on both versions).
  - `web_image_content_types` adds webp; `validate_migration_timestamps` (current migration names comply); `yjit`.
  - `enqueue_after_transaction_commit` is moot: it was removed in 8.1.
- **8.0**
  - `strict_freshness`: export downloads that send both `If-None-Match` and `If-Modified-Since` would rely on the ETag alone. Tests passed.
  - `to_time_preserves_timezone :zone` is already forced (fix 16).
- **8.1**
  - `escape_json_responses=false` and `escape_js_separators_in_json=false`: check Jbuilder output embedded in HTML.
  - `action_on_path_relative_redirect=:raise`, `raise_on_missing_required_finder_order_columns`, `render_tracker=:ruby`, `remove_hidden_field_autocomplete`, `yjit` outside local environments.
  - None of these failed in the tests.

## D. Not verified yet
- **Untested surfaces:** system and browser tests (the suite folder is empty), real Sidekiq worker execution (I only checked payload decoding), rich-text `<details>` rendering under HTML5 sanitizing, and DST end-to-end in the browser.
- **Fix compatibility on 7.0:** the "Works on 7.0 too?" column comes from reading the code. The fixes were not run as a patch on 7.0. Before splitting them into preparatory PRs, run them as one patch against `/tmp/up/app70`.
- **Possible noise:** a `Puma::Events.strings` call in the citation test helper could break later versions. Production logged a missing `image_processing` warning; harmless unless variants are used.
- **Product decisions needed:**
  - Should digests cover the reader's local day or the UTC day (fix 17)?
  - Should the postponed-reminder display keep the old timezone offset (fix 16)?
  - Was `Import#apply` ever deployed somewhere it partially committed? It rolls back on 7.0, so most likely not.

## Suggested order
1. **On 7.0, before the upgrade (each change works on both versions):** fixes 3, 5–9, 11–17 (with the lambda form of 10), and `.to_s` on the digest completion value. Optionally also the `slug` permit and `daily_note_counts` guards from section C.
2. **Upgrade commit:** Rails 8.1.0, the `json` pin, fixes 2, 4, 18, and `:polynomially_longer` if wanted. Keep `load_defaults 7.0`. Deploy workers before web processes and drain the queues before any rollback.
3. **Later:** adopt defaults one version at a time with the `new_framework_defaults` files. Turn on cache and message format settings only after rollback to 7.0 is ruled out. Plan the Sidekiq 7 move separately.

---

**Note:** You asked me to upgrade Rails, but the upgrade skill only produces a plan. So the repository is unchanged: `main` is clean and still on Rails 7.0.8.7.

The planner did make a slip: it ran one `bin/rails runner` command in your real repo. That command ran against the test database, which is isolated, and could only write to the ignored `tmp/` and `log/` folders. The test copies are in `/tmp/up/`. It also left two test databases, `mn_upg_test` and `mn_upg_dev`, which you can drop.

Before I make the changes, I need two decisions from you:
- **Digests:** should they cover the reader's local day or the UTC day? (fix 17)
- **Postponed reminders:** should they keep showing the old timezone offset? (fix 16)

Once you've decided, I can start with the preparatory changes on 7.0 (step 1) on a branch.