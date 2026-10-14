I evaluated the Rails 7.0.8.7 to 8.1.0 upgrade for Margin Notes in a throwaway copy. **The upgrade is feasible, but 16 code or dependency changes are required, and several of the breaks are silent data or behaviour changes that tests and boot checks miss.** Even keeping `load_defaults 7.0`, the app fails to boot on 8.1.0 until these are fixed. The working repo was not modified (`git status` is clean).

With the changes applied in the copy on Rails 8.1.0, the suite gives 46 runs, 330 assertions, 1 failure. That failure is an expected display change (item 15).

## How I tested
- **Isolated services:** a private PostgreSQL 15 cluster (`/tmp/up/pg`, socket `/tmp/up/pgsock`, port 55432, databases `margin_up*`) and a private Redis on 127.0.0.1:56379. Storage and cache stayed inside the copies. All environment settings are in `/tmp/up/env.sh`.
- **Copies:** `/tmp/up/app` was upgraded; `/tmp/up/app70` is an unmodified 7.0 copy used for mixed-version checks.
- **Before upgrading:** 46 runs, 325 assertions, 0 failures (`/tmp/up/baseline.log`).
- **Upgrade:** I set `gem "rails", "8.1.0"` and ran `bundle update rails`. This resolved rails/railties 8.1.0, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, a new dependency `action_text-trix 2.1.19`, and initially json 3.1.0. Logs and diffs: `/tmp/up/bundle-8.1-a.log`, `/tmp/up/lock-8.1-a.diff`, `/tmp/up/lock-final.diff`.
- **Behaviour probe:** `/tmp/up/scripts/probe.rb` exercises the models, jobs and Redis payloads. Output: `/tmp/up/probe-7.0.log` and `/tmp/up/probe-8.1-fixed.log`.
- **Logs and diffs:** each fix-and-retest round is in `/tmp/up/test-8.1-{d..k}.log`. Each default level is in `/tmp/up/test-defaults-{7.0,7.1,7.2,8.0,8.1}.log` and `/tmp/up/probe-defaults-*.log`. The full upgraded diff is `/tmp/up/fixed-copy-8.1.diff`; the subset that runs on 7.0 is `/tmp/up/portable-on-7.0.diff`.
- **Change index:** `/tmp/up/summary.txt`. Its default lists were incomplete (see the defaults section).

## A. Required changes (needed even with `load_defaults 7.0`)
"Works on 7.0" means the fix passed the full suite on 7.0.8.7 (`/tmp/up/test-7.0-portable.log`: 46 runs, 0 failures).

1. **json gem incompatibility (dependency).**
   - **Observed:** unconstrained resolution picks json 3.1.0. Every JSON-serialized column then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`, raised from `ActiveSupport::JSON.decode` (activesupport-8.1.0 `json/decoding.rb:25`). This broke 35 tests.
   - **Fix:** add `gem "json", "< 3"` (resolved to 2.21.2), or check whether a later 8.1.x patch fixes it.
   - **Unverified:** I did not test whether json 3.x is fixed upstream.

2. **Action Text initializer crashes at boot** (`config/initializers/action_text.rb`).
   - **Observed:** `NoMethodError: undefined method '+' for nil`. Since 7.1, `ActionText::ContentHelper.allowed_tags` is nil until set.
   - **Fix:** inside `after_initialize`, start from `allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]` and add `details summary` (copy: `/tmp/up/scripts/action_text_init.rb`). **Works on 7.0.**
   - **Validation:** the existing test that collapsible excerpts are kept and unsafe markup dropped passes on 8.1.

3. **Old `enum` syntax** (`app/models/note.rb`).
   - **Observed:** `enum status: {...}, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. **Works on 7.0.**

4. **`serialize :tags, JSON`** (`note.rb`).
   - **Observed:** `ArgumentError: wrong number of arguments (given 2, expected 1)`.
   - **Fix:** `serialize :tags, coder: JSON`. **Does not work on 7.0**, so it ships with the upgrade.
   - **Stored data:** unchanged; raw `["a","b"]` round-trips identically in both versions (probe).

5. **`alias_attribute :highlight_color, :color`** (`color` comes from `store_accessor`).
   - **Observed at runtime, not at boot:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method ...'`.
   - **Fix:** `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. **Works on 7.0.**

6. **Route with two paths** (`config/routes.rb`, `get "/notes", "/journal"`).
   - **Observed:** `ArgumentError: Wrong number of arguments (expect 1, got 2)` at `routes.rb:18`.
   - **Fix:** split it into `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index"`. **Works on 7.0.**

7. **`Rails.application.secrets` was removed** (`app/models/citation/provider.rb`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb`, `ARCHITECTURE.md`, `CONTRIBUTING.md`).
   - **Observed:** `NoMethodError: undefined method 'secrets'`. Every citation enrichment job would fail.
   - **Fix:** move the file to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider).fetch(:citation_provider)`, and read `Rails.configuration.x.citation_provider`. Update the test stub and the docs. **Works on 7.0.**
   - **Validation:** the credentials test asserts the exact Basic auth header. A wrong nesting showed up as `"Basic Og=="`.

8. **`where(notebooks: @notebook)`** (`notes_controller.rb#index`).
   - **Observed:** `PG::UndefinedColumn: column notes.notebooks does not exist`. The notebook filter and pagination break.
   - **Fix:** `where(notebook: @notebook)`. **Works on 7.0.**

9. **`form_with(model: nil, ...)`** (`app/views/notes/index.html.erb:12`).
   - **Observed:** `Passed nil to the :model argument, expect an object or false`. The notes list returns 500.
   - **Fix:** drop `model: nil`. **Works on 7.0.**
   - **Check:** `grep -rn "model: nil" app/views` found only this one.

10. **`set(wait_until: Integer)`** (`Note#schedule_reminder`).
    - **Observed:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Scheduling and postponing reminders return 500.
    - **Fix:** `wait_until: Time.at(reminder_epoch)`. **Works on 7.0.**

11. **`wait: :exponentially_longer`** (`citation_enrichment_job.rb`).
    - **Observed:** only when a retry happens: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
    - **Fix:** `:polynomially_longer`, which does not exist on 7.0, or a lambda `->(n) { n**4 + 2 }`, which works on both.
    - **Queued work:** retries already in Redis compute their delay with the new code, so they are fine once deployed.

12. **`Array#sum` on strings** (`Export#generate`, `fragments.sum`).
    - **Observed:** `TypeError: String can't be coerced into Integer`. Every export job fails.
    - **Fix:** `fragments.join`. **Works on 7.0.**

13. **Import commits partial data (silent, important)** (`Import#apply`, `return false` inside `transaction`).
    - **Observed:** on 8.1 a failing row now commits the import and the earlier rows. The test's record counts went from expected `[0, 3, 0, 1]` to actual `[1, 4, 1, 2]`. Since 7.2 a non-local return always commits, regardless of `load_defaults`.
    - **Fix:** `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`, with a local success flag. **Works on 7.0.**
    - **Validation:** the imports test "applying them saves nothing".

14. **`citation[:id]` in `Import#receipt`** (the citations primary key is `doi`; there is no `id` column).
    - **Observed (silent):** the receipt CSV's doi column comes out empty on 8.1. It was `10.1000/Essays.1` on 7.0.
    - **Fix:** `citation&.doi`. **Works on 7.0.**

15. **`HashWithIndifferentAccess#stringify_keys` now stringifies integer keys** (`imports/preview.html.erb`).
    - **Observed (silent):** annotations vanish from the import preview.
    - **Fix:** use `@import.annotations` directly. **Works on 7.0.**

16. **`to_time` now always keeps the zone** (8.1 removed the option) (`Note#next_day_reminder_at`, `_reminder.html.erb`).
    - **Observed:** across a DST change the preview shows `2026-11-01T08:00:00-05:00` instead of `09:00:00-04:00`. The instant is the same (+86400 s), so the postponed `reminder_epoch` does not change.
    - **Fix:** a product decision. Accept the change and update the assertion at `reminders_controller_test.rb:21`, or change the "24 hours later" wording. This is the remaining test failure.

17. **Active Job keeps the time zone of `TimeWithZone` arguments** (`User#request_digest`, `DigestMailer`).
    - **Observed:** the digest subject changed from "October 05" to "October 04", and the covered day became the reader's local day. That contradicts the UI text "follow the UTC day".
    - **Fix:** `requested_at = params[:requested_at].utc` in the mailer. **Works on 7.0** and handles both payload formats.

18. **Test environment config:** `config.action_dispatch.show_exceptions = false` no longer raises in tests; tests got a 404 instead of `RecordNotFound`.
    - **Fix:** set it to `:none`. That value is only valid from 7.1, so it ships with the upgrade.

## B. Rollout, stored data and queued jobs
- **BigDecimal job arguments break rollback.** `DigestJob` receives a BigDecimal (`reading_completion`). Rails 8.1 always writes `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer"}`. When I gave those payloads to 7.0, it raised `ActiveJob::DeserializationError ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`/tmp/up/payloads-8.1.jsonl`).
  - **Consequences:** during a mixed fleet or after a rollback, 7.0 workers lose digest emails. The Redis reservation `digest_requests:<date>` still blocks a retry that day.
  - **Options:** upgrade all Sidekiq workers before web servers, or drain the default queue before rolling back. Better still, pass `completion` as a String (`.to_s`) now. That works on both versions because the mailer already calls `BigDecimal(...)`.
- **Jobs queued by 7.0 run correctly on 8.1.** I deserialized and executed the DigestJob, CitationEnrichmentJob and NoteReminderJob payloads (`/tmp/up/payloads-7.0.jsonl`). Digest jobs carry a String completion and a UTC time; `BigDecimal(String)` and `.utc` handle both.
- **Session cookies work in both directions.** Sign-in cookies were accepted from 7.0 to 8.1 and from 8.1 to 7.0, with defaults at both 7.0 and 8.1 (`/tmp/up/scripts/cookie.rb`, test environment).
- **Stored data formats are unchanged:** notebook preferences (YAML), note tags (JSON) and settings (jsonb) read and write the same raw values on 8.1 (probe).
- **Sidekiq stays at 6.5.12 with rack 2.2 and works on 8.1.** It is a separate upgrade, and moving to Sidekiq 7 would break more code:
  - `ExportJob.perform_async(id, { format: ... })` has symbol keys, which strict args reject; it already warns today.
  - With redis-client, `sadd` returns an Integer, so `0` is truthy and the one-digest-per-day check would stop working.
  - `rescue Redis::BaseError` in `Notebook#request_export` would no longer catch connection errors.

## C. New framework defaults, release by release
All of these keep the old value today: nothing is set explicitly and `load_defaults` stays at 7.0. Results for each level are in `/tmp/up/test-defaults-*.log` (run with fixes 1–18 applied and `serialize :preferences, coder: YAML`).

**7.1**
- **Needs a code change before adopting:**
  - `default_column_serializer = nil`: `Notebook` `serialize :preferences` fails at load with `missing keyword: :coder`. Add `coder: YAML` (7.1+ only); stored YAML stays readable.
  - `raise_on_assign_to_attr_readonly`: `NotebooksController#update` raises `ActiveRecord::ReadonlyAttributeError: slug`, because `notebook_params` permits `:slug`. Remove `:slug` from the permitted params. Today the slug change is silently ignored.
  - `raise_on_invalid_cache_expiration_time`: the export partial raises `Cache expiration time is invalid, cannot be negative: -60.0` for expired exports. Clamp `expires_in` or skip the cache when the export is not downloadable.
- **Behaviour changes to check:**
  - `action_view` and `action_text` `sanitizer_vendor` switch to HTML5: rendering of stored rich text changes; tests passed.
  - `default_headers` adds `X-XSS-Protection: 0` and drops `X-Download-Options`.
- **Rolling-deploy risk:**
  - `cache_format_version 7.1`: 7.0 cannot read it, so clear the production FileStore after any rollback.
  - `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: 7.0 servers cannot read the new messages. Enable them in a later deploy.
- **Low impact or not used:** `belongs_to_required_validates_foreign_key` (fewer queries), `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined` (no app `after_commit`), `marshalling_format_version`, `precompile_filter_parameters`, `dom_testing_default_html_version`, `debug_exception_log_level`, `add_autoload_paths_to_load_path`. Encryption, sqlite, query log tags and secure token are not used.

**7.2**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String`. Fix with `Date.iso8601(day.to_s)` or handle a Date, which works on both.
- `yjit = true`: adds memory use in production.
- `web_image_content_types` adds webp: no variants are used.
- `validate_migration_timestamps`: the existing timestamps are valid.
- The 7.2 config `enqueue_after_transaction_commit` is gone in 8.1, which defaults to false. Jobs are still enqueued inside `with_lock`, as today.

**8.0**
- `strict_freshness`: the export download checks only `If-None-Match` when both headers are sent; the existing test passes.
- `Regexp.timeout = 1`: negligible here.

**8.1** (the summary tool missed this whole release; taken from railties source)
- `escape_json_responses = false`, `escape_js_separators_in_json = false`, `action_on_path_relative_redirect = :raise` (all redirects use helpers), `raise_on_missing_required_finder_order_columns`, `render_tracker = :ruby` (cache digests change once), `remove_hidden_field_autocomplete`, and `yjit` off in development and test. No test failures were attributable to these.

**Already forced on 8.1.0 by removals:** the non-local return commit (item 13), BigDecimal serialization (section B), `to_time` zone handling (item 16), and the removals of `allow_deprecated_parameters_hash_equality` and singular association names (item 8).

## D. Not verified and open questions
- **Browser checks were not run:** there is no Chrome here and no system tests exist. Trix needs a browser check. The layout loads the vendored `trix-1.3.5.js`, but `actiontext.css`'s `require trix` now resolves to Trix **2.1.19** CSS from `action_text-trix` (it was 1.3.2). Both assets return 200, but I haven't checked the editor visually or functionally.
- **Production was not booted** (no master key). Not checked: `secret_key_base` from credentials, `RAILS_SERVE_STATIC_FILES`, and asset precompile.
- **Puma 5 with 8.1** only ran in development (the server answered 200).
- **Deprecations:** `Note.connection` is soft-deprecated; prefer `with_connection`. `config.cache_classes` should become `enable_reloading`.
- **Pins to revisit:** `concurrent-ruby 1.3.4` (only needed for the 7.0 Logger bug) and `minitest ~> 5.25`. Adding `csv`, `bigdecimal` and `mutex_m` to the Gemfile prepares for Ruby 3.4.
- **Product decisions needed:** the DST preview wording (item 16) and the digest's UTC-day contract (item 17).

## Suggested order
1. Ship the fixes that work on 7.0 now (items 2, 3, 5–10, 12–15, 17, and completion as a String), using `/tmp/up/portable-on-7.0.diff` as the reference.
2. Upgrade with items 1, 4, 11, 16 and 18. Deploy workers first or drain queues, and keep `load_defaults 7.0`.
3. Adopt defaults one release at a time, after the code changes listed in section C. The message and cache formats should go in a separate deploy from the version bump.

The disposable Postgres and Redis are stopped. To reproduce, restart them with the commands in `/tmp/up/env.sh` and the cluster at `/tmp/up/pg`.

---

**Notes:**

- **Nothing in your repo has changed.** I only planned the upgrade, as the upgrade skill requires. The Gemfile still pins `rails 7.0.8.7`.
- **Inconsistencies in the plan:**
  - It says 16 changes are required, but section A lists 18.
  - It says the one remaining test failure is item 15. Item 16 says that failure is its own (the DST assertion at `reminders_controller_test.rb:21`), so item 16 is probably correct.
- **Decisions needed from you before implementing:**
  - The DST reminder wording (item 16).
  - Whether the digest should cover the UTC day (item 17).
- **Next step:** if you want, I can start with step 1 of the suggested order. Those fixes work on both 7.0 and 8.1, so they can ship before the version bump.