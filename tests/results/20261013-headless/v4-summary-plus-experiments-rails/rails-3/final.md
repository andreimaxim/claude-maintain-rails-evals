# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** Do not bump the gem on its own. Under 8.1.0 the app first fails to boot, and once it boots it fails 15 distinct ways. Three of these change behaviour or data without the test suite noticing:
- **Partial CSV imports:** a failed row now leaves the earlier rows saved.
- **Missing annotations:** reader annotations disappear from the import preview.
- **Receipt DOIs blank:** the import receipt CSV no longer shows DOIs.

Two more change what users see whatever the config says: digests cover a different day, and the "24 hours later" preview time changes. About a dozen fixes also work on 7.0 and can ship first. I tested a set of them on 7.0 and all 46 tests pass.

The working repo was not modified (`git status` is clean). All experiments ran in `/tmp/mn-exp` with their own Postgres (port 55432, socket in `/tmp/mn-exp`), Redis (port 56379), bundle paths and storage. Both services are now stopped.

## What I ran

| Copy | What it is | Result | Log |
|---|---|---|---|
| `base` | Unmodified, Rails 7.0.8.7 | 46 runs, 0 failures | `logs/base-test.log` |
| `up` | Rails 8.1.0, `load_defaults 7.0`, fixes added one at a time | Fails to boot at first. With fixes, 2 failures left, both behaviour changes | `logs/up-boot*.log`, `logs/up-test1..8.log`, `logs/up-zeitwerk.log` |
| `upd` | `up` plus `load_defaults 8.1` | 3 more errors from new defaults | `logs/upd-test1..2.log` |
| `prep` | 7.0 plus the fixes that work on both versions | 46 runs, 0 failures, `zeitwerk:check` OK | `logs/prep-test.log` |
| Cross-version | Production env, shared DB `mn_exp_prod`, fixed `SECRET_KEY_BASE`, Redis db 3. Scripts in `/tmp/mn-exp/scripts` | See rollout section | `logs/xv-*`, `logs/old-*` |

- **Gem versions in `up`** (from `bundle update rails concurrent-ruby`, `logs/up-bundle.log`): rails 8.1.0, concurrent-ruby 1.3.8, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, turbo-rails 2.0.12, importmap-rails 2.2.3, pagy 8.6.3, json first resolved to 3.1.0 then pinned to 2.21.2.
- **Run command:** `VARIANT=<v>; . /tmp/mn-exp/env.sh` sets `DATABASE_URL`, `REDIS_URL`, `BUNDLE_PATH` and `PARALLEL_WORKERS=1`. Then `bundle exec rails db:schema:load test`.
- **Patch labels:** each fix in the copies is marked `EXPERIMENT PATCH n` or `PREP`.
- **No browser tests:** `test/system` is empty, so nothing was tested in a browser.
- **The `gem-changes` summary has gaps.** It lists no defaults for 8.1. Several of its 7.1 and 7.2 entries no longer exist in 8.1. It missed six of the breakages below (the `fragments.sum`, `stringify_keys`, `citation[:id]`, `where(notebooks:)`, `return` in transaction and json 3 failures).

## Required changes

"Works on 7.0?" says whether the fix can ship before the upgrade. "Verified" means I ran it.

1. **Action Text initializer crashes at boot** (`config/initializers/action_text.rb`). Since 7.1, `ActionText::ContentHelper.allowed_tags` starts as `nil`, so `+=` raises NoMethodError. Fix: inside `after_initialize`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags.to_a + [Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. Works on 7.0: yes, verified.
2. **Old `enum` syntax removed** (`app/models/note.rb:10`). Change to `enum :status, {...}, prefix: true`. Works on 7.0: yes, verified.
3. **Old `serialize` syntax removed** (`note.rb:12`, `serialize :tags, JSON` now raises ArgumentError). `attribute :tags, :json` works on both versions (verified). It writes the same JSON text, and 7.0 read rows written by 8.1. `serialize :tags, coder: JSON` works only on 7.1 and later.
4. **`alias_attribute` to a store accessor raises** (`note.rb:14`, `color` comes from `store_accessor`). Replace with `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. Works on 7.0: yes, verified.
5. **Route with two paths raises** (`config/routes.rb:18`, `get "/notes", "/journal", to:`). Split into two `get` lines. Works on 7.0: yes, verified.
6. **`form_with(model: nil)` raises** (`app/views/notes/index.html.erb:12`). Use `model: false`. Works on 7.0: yes, verified.
7. **Integer `wait_until` breaks reminders** (`note.rb` `schedule_reminder`, `set(wait_until: reminder_epoch)`). On 8.1 this raises `undefined method 'utc' for Integer` and reminders cannot be scheduled. Use `Time.at(reminder_epoch)`. Works on 7.0: yes, verified.
8. **`Rails.application.secrets` removed in 7.2** (`app/models/citation/provider.rb:13` and `test/controllers/citation_enrichments_controller_test.rb`). Citation lookup breaks. Move the settings to `config/citation_provider.yml` and load them with `config.x.citation_provider = config_for(:citation_provider)`. Works on 7.0: yes, verified. Deploy needs: the production ENV variable names stay the same. Remaining question: whether anything outside the repo reads `secrets.yml`.
9. **`retry_on wait: :exponentially_longer` raises** (`app/jobs/citation_enrichment_job.rb`, "Couldn't determine a delay"). `:polynomially_longer` works only on 7.1 and later. A lambda `->(executions) { executions**4 + 2 }` works on both (verified), but the jitter differs slightly.
10. **`Array#sum` of strings removed** (`app/models/export.rb:42`, `fragments.sum`). Exports fail with TypeError. Use `fragments.join`. Works on 7.0: yes, verified.
11. **Import preview loses reader annotations, with no error** (`app/views/imports/preview.html.erb`, `@import.annotations.stringify_keys`). `stringify_keys` now really turns the integer line keys into strings, so lookups by `row.line` find nothing. Remove `.stringify_keys`. Works on 7.0: yes, verified.
12. **Import receipt shows blank DOIs** (`app/models/import.rb` `receipt`, `citation[:id]`). `citations` has `doi` as its primary key and no `id` column, and `[:id]` no longer maps to the primary key. Use `citation&.doi`. Works on 7.0: yes, verified.
13. **Filtering notes by notebook fails** (`app/controllers/notes_controller.rb:11`, `where(notebooks: @notebook)`). Rails no longer accepts the plural name for a `belongs_to` association, so the query errors with `PG::UndefinedColumn`. Use `where(notebook: @notebook)`. Works on 7.0: yes, verified.
14. **Partial imports — a data-integrity problem** (`app/models/import.rb` `apply`). The code uses `return false` inside `transaction`. On 7.0 that rolls back. On 8.x it commits, and the config switch to keep the old behaviour no longer exists. A row that fails validation now leaves the import and earlier rows saved; the test's record counts confirmed this. Fix: call `raise ActiveRecord::Rollback` and return a flag. Works on 7.0: yes, verified.
15. **Test config: exceptions no longer raise** (`config/environments/test.rb:31`, `show_exceptions = false`). In 8.1 `false` means "show everything", so tests get 500 pages instead of exceptions. Set it to `:none` as part of the upgrade itself. On 7.0, `:none` is a truthy value and would turn exception pages on.
16. **json 3.x breaks Rails 8.1.0** (dependency). `ActiveSupport::JSON.decode` passes options as a positional hash, which json 3.1.0 rejects. Every JSON-serialized column fails. Either pin `gem "json", "< 3"`, or target 8.1.4: I read its source and it passes keywords. Other changes in 8.1.4 are unverified.

## Behaviour changes with no setting to turn them off

These are the 2 tests still failing in `up`. Each needs a product decision plus an updated test or code change.

- **Digest covers a different day** (`DigestJob` / `DigestMailer`). Since 7.1, a TimeWithZone job argument keeps its time zone. The digest's `requested_at.to_date` and `all_day` now use the reader's day instead of the UTC day. The test saw Oct 04 instead of Oct 05 for a Tokyo-zone reader. This contradicts the UI text "today (UTC)" and the once-per-UTC-day check in Redis. To keep the documented behaviour, use `requested_at.utc` in the mailer, which also works on 7.0. Jobs already queued by 7.0 have no zone field and still run with UTC (verified, `logs/old-to-new.log`).
- **"24 hours later" preview time** (`Note#next_day_reminder_at`). In 8.1, `to_time` always keeps the zone, and the setting is deprecated with no effect. The stored epoch is the same, because the code adds 86,400 seconds and then calls `to_i`. Only the display changes: 08:00 −05:00 instead of 09:00 −04:00 across a DST change. To keep the documented offset behaviour, use something like `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` (not verified). Otherwise update the comment and the test.

## New framework defaults, by release

The app stays on the old value for all of these until `load_defaults` is raised. The list comes from railties 8.1.0, `configuration.rb` lines 269–375. Items marked **(tested)** were run in `upd`.

**7.1**
- **Defaults that would break something here:**
  - `default_column_serializer = nil` **(tested)**: the bare `serialize :preferences` in `notebook.rb:7` raises at load. Add `coder: YAML`, which needs 7.1 or later. The YAML that 8.1 writes is still readable by 7.0 (verified).
  - `raise_on_assign_to_attr_readonly` **(tested)**: the notebook settings form posts a hidden `slug` field (`notebooks/_form.html.erb:13`), and `notebook_params` permits it, so updating a notebook raises ReadonlyAttributeError. Remove `:slug` from the permitted params and drop the hidden field.
  - `raise_on_invalid_cache_expiration_time` **(tested)**: `exports/_export.html.erb:26` uses `expires_in: export.expires_at - Time.current`, which goes negative once an export expires, so the page raises. Clamp it to a minimum, or skip caching for expired exports.
- **Rollout-sensitive defaults (see the rollout section):** `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata` and `cache_format_version 7.1` / `marshalling_format_version`.
- **Probably harmless here:**
  - Sanitizer becomes HTML5 for Action View and Action Text. Rich-text output may differ slightly; the tests passed.
  - `dom_testing_default_html_version :html5`; the tests passed.
  - `belongs_to_required_validates_foreign_key = false` and `before_committed_on_all_records`.
  - `run_after_transaction_callbacks_in_order_defined`: the app has no `after_commit`.
  - `generate_secure_token_on`: not used.
  - `precompile_filter_parameters`.
  - `add_autoload_paths_to_load_path = false`: `lib` is not autoloaded.
  - `default_headers`: drops `X-Download-Options`.
  - `query_log_tags_format`: query log tags are off.
  - `sqlite3_*` and `encryption.*`: the app uses neither.
  - `log_file_size`: development and test only.
  - `debug_exception_log_level`.
- **7.1 settings from the summary that no longer exist in 8.1** (so there is nothing to adopt):
  - `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`: now always strict (see item 13).
  - `commit_transaction_on_non_local_return`: now always commits (see item 14).
  - `use_big_decimal_serializer`: now always on (see the rollout section).

**7.2**
- `postgresql_adapter_decode_dates` **(tested)**: `Notebook#daily_note_counts` gets a `Date` instead of a string, and `Date.iso8601(Date)` raises TypeError. Accept either type; that fix works on 7.0 (verified in `prep`).
- `validate_migration_timestamps`: no effect.
- `web_image_content_types` adds WebP: no effect, since no image processor is installed.
- `yjit = true`: affects memory use.
- `enqueue_after_transaction_commit`: no longer set by any `load_defaults` in 8.1, and the class default is `false`. If someone enables it, `Citation#request_enrichment` and `Note#schedule_reminder` stop rolling back when an enqueue fails, which breaks their documented guarantees. Keep it off.

**8.0**
- `strict_freshness`: the app does no conditional GET handling. Low risk.
- `Regexp.timeout = 1`: check the DOI regex and CSV parsing under load (not tested).
- `to_time_preserves_timezone`: no longer a real setting (see the behaviour changes above).

**8.1** (the summary listed none)
- `escape_json_responses = false`: affects only `render json:`. The app has no jbuilder views; I did not grep every controller.
- `action_on_path_relative_redirect = :raise`: every redirect uses route helpers. Low risk.
- `raise_on_missing_required_finder_order_columns`: watch `first`/`last` on tables without an ordering column (`citations` uses `doi`).
- `escape_js_separators_in_json = false`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete`, `yjit = !local`: low impact.

**Recommendation:** go to 8.1.0 while staying on `load_defaults 7.0`. Then raise the version one release at a time (7.1, 7.2, 8.0, 8.1), using a `new_framework_defaults_*.rb` file per step, after the fixes listed under that release are in.

## Rollout and rollback: queued jobs and stored data

These are verified cross-version results (`logs/xv-read-*.log`, `logs/old-to-new.log`).

- **Jobs queued by 7.0, run by 8.1:** NoteReminderJob, CitationEnrichmentJob and DigestJob all deserialize, including scheduled reminders sitting in the Sidekiq `schedule` set.
- **8.1 enqueues, 7.0 runs — fails even under `load_defaults 7.0`.** DigestJob now carries a `BigDecimalSerializer` argument, and 7.0 fails with `DeserializationError: Serializer ... BigDecimalSerializer is not known`. During a mixed deploy, and after a rollback, those digest jobs fail. Fix either way:
  - Before upgrading, pass `reading_completion.to_s`. This works on both versions, and the mailer already calls `BigDecimal(...)`.
  - Or upgrade the Sidekiq workers before the web servers.

  Any digest jobs left in the queue at rollback need to be drained or re-enqueued.
- **Data 8.1 writes to the database is readable by 7.0:** notebook `preferences` (YAML), note `tags` (JSON) and `settings`.
- **Signed IDs written with `load_defaults 8.1` cannot be read by 7.0.** Signed global IDs (stored inside Action Text bodies as `sgid`) and `Blob#signed_id` fail with `NoMethodError unpack1` because of `use_message_serializer_for_metadata`. Under `load_defaults 7.0` they still work. A rich-text attachment saved after turning on 7.1 defaults would break if you rolled back. Set `use_message_serializer_for_metadata = false` (and keep the message serializer at its old value) for one deploy, and only switch it on once rollback is no longer an option.
- **Cookies:** a signed cookie written by both 8.1 variants was readable by 7.0. My encrypted-cookie probe returned nil even within one version, so it tells us nothing; session-cookie compatibility is still unverified.
- **Cache:** production uses the default file store. Keep `cache_format_version` at 7.0 until no 7.0 servers remain, or clear `tmp/cache` (not tested).

## Not required for 8.1.0, but needed soon

- **Sidekiq's built-in Rails adapter is deprecated and removed in 8.2** (it needs sidekiq 7.3.3 or later). Moving to Sidekiq 7 brings redis-client, which affects three places:
  - `User#request_digest` relies on `sadd` returning true/false. Redis 4.8 already warns about this in the logs. With redis-client it returns an Integer, and `0` is truthy in Ruby, so the once-per-day check stops working. Use `sadd?`.
  - `rescue Redis::BaseError` in `Notebook#request_export` would no longer catch connection errors.
  - The symbol-keyed arguments `ExportJob.perform_async(..., { format: })` are already warned about and would raise under Sidekiq 7's strict argument check.
- puma 5 works because rack stayed at 2.2. Moving to rack 3 would need puma 6.
- Unpin `concurrent-ruby` (I tested with 1.3.8).

## Suggested order

1. **On 7.0, ship the fixes that work on both versions:**
   - Required-change items 1–14, using the dual-version options for items 3 and 9.
   - The `daily_note_counts` fix.
   - Passing `reading_completion.to_s` to DigestJob.
   - A decision on the digest day and the reminder preview.
   - Removing `slug` from the notebook form and params.
   - Clamping the cache `expires_in`.
2. **Upgrade the gem:**
   - Rails 8.1.0, plus either the json pin or a move to 8.1.4.
   - `show_exceptions :none`.
   - Optionally `serialize ..., coder:`.
   - Stay on `load_defaults 7.0`.
   - Deploy workers first, then web.
3. **Raise the defaults one release at a time**, with the message-serializer metadata flag turned on last.

## Checks still to do

- **Browser behaviour:** Turbo, Trix and the HTML5 sanitizer output for `details`/`summary` in a browser. There are no system tests.
- **Real Sidekiq run:** run a worker on 8.1 and process a CitationEnrichmentJob to exhaustion, to confirm the retry block marks the citation failed.
- **Session cookies:** confirm a real session cookie survives in both directions across the mixed-version window.
- **`Regexp.timeout`:** test with a large CSV.
- **Remaining question:** whether secrets or credentials outside the repo still feed `secrets.yml` in production.

---

I haven't upgraded anything yet: the upgrade skill only produces a plan, and the repo is unchanged. The app is on Rails 7.0.8.7 today, so 8.1.0 is a jump across four releases, and a plain gem bump won't boot.

Three choices are yours before I start:
- **How the digest day and the reminder preview should behave:** keep the current UTC day and offset, or accept the new times.
- **The json problem:** pin `json < 3`, or target Rails 8.1.4 instead of 8.1.0.
- **How to stage it:** I'd start with step 1, shipping the fixes that also work on 7.0. All 46 tests passed with a set of them applied.