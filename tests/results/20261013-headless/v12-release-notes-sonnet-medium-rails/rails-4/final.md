Here is the plan from `maintain-rails:gem-upgrade-planner`, returned in full. I did not implement it or change the working application.

# Upgrade plan: Rails 7.0.8.7 to 8.1.0 (Margin Notes)

I ran all experiments in disposable copies under `/tmp/plan`, each with its own PostgreSQL databases and a separate Redis server on port 6390. The working application at `/home/user/workspace/repo` was not modified, and `git status` there is clean.

**Result.** The stock upgrade does not boot and needs 14 code changes plus a `json` pin. With those applied, all 46 tests pass on 8.1.0, and Zeitwerk, development boot and the Sidekiq rollout/rollback checks also pass. System tests and the JavaScript editor were not run (no Chrome in the environment).

**How to read this.** "Executed" means I ran it. "Source" means I read it in the gem code or changelog. "Proposed" means I did not run it.

## Experiment record

- **Baseline:** `/tmp/plan/base` runs Rails 7.0.8.7 on Ruby 3.3.6. All 46 tests pass (log `/tmp/plan/base_test.log`).
- **Upgraded copy:** `/tmp/plan/up` runs Rails 8.1.0, still under `load_defaults 7.0`.
  - **Resolved gems:** I ran `bundle update rails`. It resolved Rack 2.2.24, Sidekiq 6.5.12, redis 4.8.1, turbo-rails 2.0.12, pg 1.6.0 and action_text-trix 2.1.19. It newly added json, bigdecimal 4.1.3 and drb 2.2.3. Rack stays on 2.2.
  - **Test logs:** The iteration logs are `/tmp/plan/up1_test.log` through `/tmp/plan/up9_test.log`. The final one is green.
  - **Config:** `/tmp/plan/Gemfile.lock.json3` is the lock that resolved json 3.1.0. `/tmp/plan/changes.txt` is the gem-changes output.
- **`/tmp/plan/up_defaults`:** the same copy with `load_defaults 8.1` (logs `upd_test*.log`).
- **`/tmp/plan/base_prep`:** Rails 7.0 plus only the preparatory changes. All 46 tests pass (`prep_test.log`).
- **Helper scripts** are in `/tmp/plan/scripts`.
  - **`render.rb` and `render_notes.rb`:** render pages and notes.
  - **`enqueue.rb`:** queues jobs for the rollout check.
  - **`sgid.rb`:** the signed-token check.
  - **`sanitize.rb`:** the sanitizer comparison.
  - **`redis_down.rb`:** the Redis-down check.
- **Environment:** `MISE_RUBY_VERSION=3.3.6`, `RAILS_ENV=test`. Each copy had its own `DATABASE_URL`, and `REDIS_URL` pointed at port 6390 with a distinct DB number.

## Required changes

Each of these breaks the stock upgrade. "Works on 7.0?" says whether the change can ship before the upgrade.

| # | Finding | Evidence | Repair | Works on 7.0? |
|---|---|---|---|---|
| 1 | **json 3.1.0 breaks every JSON column read.** | Executed. Without a pin, Bundler picks json 3.1.0 for Rails 8.1.0. Reading `notes.tags` then raises `ArgumentError: wrong number of arguments (given 2, expected 1)` at json-3.1.0 `common.rb:291`, from `activesupport-8.1.0 decoding.rb:25` via `active_record/coders/json.rb:20`. This is `::JSON.parse(json, options)` with a positional hash. Source: the line is unchanged through 8.1.3. Rails 8.1.4's `decoding.rb` calls `JSON.parse(json, **options)`. | Add `gem "json", "~> 2.19"` (I resolved 2.21.2), or request a later 8.1.x. 8.1.0 is the requested version, so I recommend the pin. | Not needed on 7.0. |
| 2 | **`config/initializers/action_text.rb` crashes boot.** | Executed: `NoMethodError: undefined method '+' for nil` at `action_text.rb:3`. In 8.1 `ContentHelper.allowed_tags` is nil until used. | Set `allowed_tags` in `config.after_initialize` to `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"] + %w[details summary]`. I verified the up_defaults variant keeps `details` and `summary`. | Yes. |
| 3 | **`enum status: {...}, _prefix: true` in `Note`** is removed in 8.0. | Executed: `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at `note.rb:10`. | `enum :status, { draft: 0, ready: 1 }, prefix: true`. `Citation` already uses this form. | Yes. |
| 4 | **`serialize :tags, JSON`.** | Executed: `ArgumentError ... (given 2, expected 1)` at `note.rb:12`. | `serialize :tags, coder: JSON`. | **No**: 7.0 has no `coder:` keyword. Change it in the upgrade commit. |
| 5 | **`alias_attribute :highlight_color, :color`** aliases a store accessor. | Executed: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Callers only use the reader and writer (form, params, views). The rendered `edit` page matches 7.0, including the checked radio buttons. | Yes. |
| 6 | **`get "/notes", "/journal", to: "notes#index"`** no longer accepts two paths. | Executed: `ArgumentError: Wrong number of arguments (expect 1, got 2)` at `routes.rb:18`. | Two lines, one per path. `rails routes` shows the same `notes` and `journal` names as before. | Yes. |
| 7 | **`Rails.application.secrets` is gone.** | Executed: `NoMethodError: undefined method 'secrets'`. Affects `Citation::Provider`, the test helper, and `config/secrets.yml`. | Create `config/citation_provider.yml` with the same ERB (keep `.to_json`, so `"00123"` stays a string). Set `config.x.citation_provider = config_for(:citation_provider)` and read it in `Citation::Provider`. Delete `secrets.yml`. | Yes (`config_for` works on 7.0). |
| 8 | **`fragments.sum` over strings** in `Export#generate`. | Executed: `TypeError: String can't be coerced into Integer` at `export.rb:42`. 7.0 only logged a deprecation. | `fragments.join`. | Yes. |
| 9 | **`@notes.where(notebooks: @notebook)`** in `NotesController#index`. | Executed: `PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering the note list by notebook is broken. | `where(notebook: @notebook)`. | Yes. |
| 10 | **`form_with(model: nil, ...)`** in `notes/index.html.erb:12`. | Executed: `Passed nil to the :model argument`. The notes page returns 500. | Drop `model: nil`. | Yes. |
| 11 | **`NoteReminderJob.set(wait_until: <Integer>)`.** | Executed: `NoMethodError: undefined method 'utc' for an instance of Integer` at `note.rb:62`. Scheduling any reminder fails. | `wait_until: Time.at(reminder_epoch)`. The enqueued `at` is still the same epoch (the reminder test asserts it). | Yes. |
| 12 | **`retry_on ... wait: :exponentially_longer`** is removed. | Executed: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. | `:polynomially_longer`. It uses the same formula, but jitter was added in 7.1. | **No**: introduced in 7.1. Use it in the upgrade commit. |
| 13 | **`test.rb` has `show_exceptions = false`.** | Executed: it is treated as truthy. Tests expecting `RecordNotFound` saw 404 or 500 responses instead (~10 failures). | `= :none`. | **No**: on 7.0 `:none` is truthy and would show exceptions. Change it in the upgrade commit. |

## Silent behaviour changes (these have a test that fails, or a stored-data effect)

14. **Partial CSV import is committed.**
    - **What happens:** `Import#apply` uses `return false` inside `transaction do`. On 8.1 that commits instead of rolling back.
    - **Observed:** The existing test "applying them saves nothing" failed. Counts went from `[0,3,0,1]` to `[1,4,1,2]`. One valid row, its citation and its import were left behind after a later row failed.
    - **Repair:** Use `raise ActiveRecord::Rollback unless row.note.save`, set an `applied` flag after the loop, and return it.
    - **Why it holds:** Success and failure still return true or false, so the controller's `elsif @import.errors.any?` branches and the preview render are unchanged. This also protects against adopting `commit_transaction_on_non_local_return`.
    - **Works on 7.0:** yes.
15. **Import receipt loses its DOI column.**
    - **What happens:** `citation[:id]` returns nil on 8.1 because `Citation` has primary key `doi`.
    - **Observed:** The receipt CSV had `On idleness,` instead of `On idleness,10.1000/Essays.1`.
    - **Repair:** `citation&.doi`.
    - **Works on 7.0:** yes.
16. **Preview drops annotations.**
    - **What happens:** `@import.annotations.stringify_keys` now converts the integer line keys to strings. The lookup `annotations[row.line]` misses.
    - **Observed:** I confirmed it in a runner: 7.0 returns `[2]` and 8.1 returns `["2"]`.
    - **Repair:** Remove `.stringify_keys` in `imports/preview.html.erb`.
    - **Works on 7.0:** yes.
17. **Digest day shifts from the UTC day to the reader's local day.**
    - **What happens:** 8.1 deserializes `requested_at` in the reader's zone, so `.to_date` and `.all_day` now use local time. ARCHITECTURE.md documents the UTC behaviour.
    - **Observed:** The test failed. The subject said "October 04" where it should say "October 05". The ready-note window would shift too.
    - **Repair:** In `DigestMailer`, use `requested_at.utc.to_date` and `requested_at.utc.all_day`.
    - **Why it holds:** It matches the reservation key, which is a UTC date.
    - **Works on 7.0:** yes.
18. **"24 hours later" preview text changes.**
    - **What happens:** `reminder_at.to_time + 86_400` used to keep the UTC-4 offset. It now follows the zone.
    - **Observed:** the output changed from `2026-11-01T09:00:00-04:00` to `08:00:00-05:00`. The instant and the scheduled epoch are identical.
    - **Decision needed:** Either preserve the documented "keeps the offset" contract or accept the change and update the test.
    - **Recommendation:** Preserve it with `Time.at(reminder_at.to_i + 86_400, in: reminder_at.utc_offset)`. That passes the existing test on both versions.
19. **BigDecimal job argument format changes, with a rollback hazard.**
    - **Format:** 7.0 queues `"0.5"`, a string. 8.1 queues `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. This happens even without `load_defaults`.
    - **Forward direction:** 8.1 workers ran 7.0-queued Digest, Reminder, Enrichment and Export jobs fine.
    - **Reverse direction, executed:** a real 7.0 Sidekiq worker failed a job queued by 8.1: `DeserializationError ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The Reminder, Enrichment and Export jobs still worked in that direction.
    - **Rollback effect:** Each failed digest retries. Each reader's `digest_requests:` reservation stays for two days, so they cannot re-request.
    - **Preparatory repair:** In `User#request_digest`, pass `reading_completion.to_s` instead of the BigDecimal. `DigestMailer` already calls `BigDecimal(params[:completion])`. This is identical on both versions, and it also removes Sidekiq's "do not serialize to JSON safely" warning.
    - **Rollout order:** Deploy that change on 7.0 first. Let jobs with the old BigDecimal payload drain before upgrading.
    - **Also seen:** `requested_at` gains a `time_zone` key in the new format. The old worker ignored it, so the digest in this direction failed only on the BigDecimal.

## Not shown by the tests

20. **Time-zone list changes.** Tzinfo mappings changed for four zones (diff in `/tmp/plan/tz_base.txt` against `/tmp/plan/tz_up.txt`).
    - `Astana` moves from `Asia/Dhaka` to `Asia/Almaty` (UTC+6 to UTC+5).
    - `Greenland` moves from `Godthab` to `Nuuk`, and `Canberra` from `Melbourne` to `Canberra`.
    - `Asuncion` is added.
    - Readers whose stored `time_zone` is "Astana" will get reminder times an hour off. Check the data with `User.where(time_zone: "Astana")`.
    - No code change is needed. Treat it as an announcement or data check.
21. **Action Text now parses with the HTML5 parser regardless of defaults** (`action_text.rb:50` and `:56`).
    - Source and executed: malformed HTML normalises differently when stored, for example `<b>bold<p>` keeps the `b` open.
    - A rendered `noscript` edge case also differs, and both outputs are safe.
    - CSV `body_html` goes through this path.
    - Rendering of 10 sample bodies was otherwise identical between 7.0 and 8.1 (`/tmp/plan/rn_base.txt`, `/tmp/plan/rn_up.txt`).
22. **Trix/JavaScript — not verified in a browser.**
    - Action Text 8.1 bundles Trix 2.1.19 (`action_text-trix`), but the layout loads the vendored Trix 1.3.5 as a classic script.
    - The gem's `actiontext.js` has no references to `Trix`, so keeping the vendored copy looks workable. A development server returned 200 for every asset on the edit page.
    - Verify that file uploads, links and the toolbar work in a real browser. The system-test suite needs one, and none is installed.
    - ARCHITECTURE.md's comment that the gem "bundles Trix 1.3.4" becomes wrong.
23. **Sidekiq.** Rails 8.1's built-in Sidekiq adapter is deprecated and removed in 8.2: "upgrade sidekiq to version 7.3.3 or later".
    - Sidekiq 6.5.12 works for now in both directions (executed).
    - Plan a Sidekiq 7 upgrade next. It changes the payload format again. It also brings `enqueue_after_transaction_commit` deferral, which would change the `with_lock` blocks that enqueue (`Note#schedule_reminder`, `Citation#request_enrichment`).
    - I did not see deferral today: the setting was `false` with the built-in adapter, and the Redis-down behaviour matched 7.0 in all three variants (`/tmp/plan/rd_*.txt`).
24. **Other checks that found no change.**
    - **Boot and migrations:** Zeitwerk `check` passes. Development and production boot. All migrations run from scratch on 8.1; only `schema.rb` ordering would change (cosmetic).
    - **Sessions:** cookies and sessions work in both directions between 7.0 and 8.1 servers. The shared secret was copied manually because the dev and test secret file is renamed from `development_secret.txt` to `local_secret.txt`.
    - **Signed tokens:** with no defaults, attachment sgids and signed IDs are readable in both directions.
    - **Cache entries** written by 7.0 read fine on 8.1 and back.
    - **Rendered HTML:** 13 pages render identically between 7.0 and 8.1 except the time-zone list.
    - **Provider script:** `bin/citation-provider` still runs.

## New configuration defaults (the app stays on `load_defaults 7.0`)

For each default, the app currently keeps the old value. Adopting everything with `load_defaults 8.1` in `/tmp/plan/up_defaults` broke 3 of the 46 tests in `/tmp/plan/upd_test2.log` (after the `serialize :preferences` fix below). Every default listed here is optional; the app keeps working without adopting any of them.

**7.1**
- **`default_column_serializer = nil`.** `serialize :preferences` in `Notebook` then raises `missing keyword: :coder`. The fix is `serialize :preferences, coder: YAML`. Stored YAML rows are unaffected. This is not backward-compatible with 7.0, so do it together with adopting the default.
- **`raise_on_assign_to_attr_readonly = true`.** The notebook update raises `ReadonlyAttributeError: slug` because `slug` is in `permit` and in a hidden field. Fix: remove `:slug` from `notebook_params` and keep the hidden field's removal consistent with the test. The existing test posts `slug: "novels"`, so it needs adjusting.
- **`raise_on_invalid_cache_expiration_time = true`.** Expired exports on the index page raise `Cache expiration time is invalid, cannot be negative: -60.0` at `exports/_export.html.erb:26`. Fix: `expires_in: [export.expires_at - Time.current, 0].max`, which works on 7.0.
- **`message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`.**
  - Not adopted: tokens stored in rich-text bodies (attachment sgids) and Active Storage signed IDs are then written in a JSON format.
  - Executed: 8.1 reads 7.0 tokens, but a 7.0 worker given a token written under the new format raised `NoMethodError` for all four lookups.
  - So this blocks rollback. Adopt it only after rollback is no longer needed.
- **Sanitizer vendor (HTML5), `dom_testing_default_html_version = :html5`.** Cosmetic output differences: `&nbsp;` is kept as an entity, whitespace between tags is removed, and `<b>` nests differently. Tests still pass.
- **`commit_transaction_on_non_local_return`.** Already neutralised by finding 14.
- **Safe for this app (source only):** `run_commit_callbacks_on_first_saved_instances_in_transaction`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records` (no `after_commit` use), `belongs_to_required_validates_foreign_key`, `generate_secure_token_on`, `marshalling_format_version`, `cache_format_version`, `precompile_filter_parameters`, and `add_autoload_paths_to_load_path = false`.
- **Response headers.** `action_dispatch.default_headers` changes (adds `X-Permitted-Cross-Domain-Policies`, `Referrer-Policy`). Check with any proxy that sets its own.
- **`allow_deprecated_parameters_hash_equality = false`.** No params-to-Hash comparisons found by grep.

**7.2**
- **`postgresql_adapter_decode_dates = true`.** `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`. Fix: `day.to_date` instead of `Date.iso8601(day)`, which works on both versions.
- **`enqueue_after_transaction_commit`.** See finding 23.
- **`validate_migration_timestamps`.** The existing migrations are dated 2026-10-11, which is before today, so none are rejected.
- **`yjit = true`.** Memory trade-off only.
- **Active Storage webp types.** Not relevant: no image processing.

**8.0**
- **`to_time_preserves_timezone`.** Already in effect without adoption; see finding 18.
- **`strict_freshness = true`.** Affects `ExportDownloadsController`'s `stale?(etag:, last_modified:)`. When a client sends both conditional headers, only `If-None-Match` is then considered. Source only.
- **`Regexp.timeout = 1`.** The DOI regex is simple and safe.

**8.1**
- **`yjit`.** It is enabled in non-local environments.
- **Source only:** `escape_json_responses = false`, `action_on_path_relative_redirect = :raise` (all redirects use path helpers), `raise_on_missing_required_finder_order_columns`, `render_tracker = :ruby` (changes template digests, so fragment caches are invalidated once), `remove_hidden_field_autocomplete`, `escape_js_separators_in_json`.

## Mixed-version rollout and rollback

1. **Preparatory release on 7.0.** The base_prep copy ran green on 7.0.8.7 with all 46 tests (`/tmp/plan/prep_test.log`). Ship these first: findings 2, 3, 5 and 6; the `config_for` change (7); 8 through 11; 14 through 17; 18 if you take the recommendation; the digest `to_s` change from finding 19; and the cache fix. They need no data migration.
2. **Upgrade release.** Apply the 8.1-only changes: findings 1, 4, 12 and 13, the `Gemfile` pin and `Gemfile.lock`. Docs to update: README line 7, ARCHITECTURE (Rails 7.0 and Trix text; the Active Job 7.0 and `secrets.yml` descriptions), CONTRIBUTING line 38 and TESTING.md line 54.
3. **Drain.** Let old-format Sidekiq jobs and scheduled reminders drain, or run the upgraded workers first. In the forward direction every job type ran under 8.1.
4. **Rollback.** Sessions and attachment tokens survive a rollback while `load_defaults 7.0` is kept. Jobs queued by 8.1 for `DigestJob` fail under 7.0 until the preparatory `to_s` change is deployed, which prevents this entirely.
5. **Do not adopt `load_defaults` values together with the upgrade.** The message serializer in particular blocks rollback.

## Validation to attach to each repair

The existing tests already fail on 8.1 for items 3 to 13, 14, 15, 16 and 17. They are discriminating checks as they stand. Here are the checks that fail without the repair and pass with it:

- **1 (json pin):** `Note.first.tags` and `.settings` read in a runner. Without the pin, `ArgumentError`. Control: the same read on 7.0 works.
- **14:** `ImportsControllerTest` "invalid rows ... saves nothing", with fixtures `novels` and the CSV in that test. It asserts `[Import, Note, Citation, RichText]` counts are unchanged. Control: the valid import test still imports 2 notes and 1 citation.
- **15:** the receipt test asserts `On idleness,10.1000/Essays.1`. Control: a row with no DOI still renders an empty second column.
- **16:** the preview test asserts `#line_2 dd` contains the annotation text. Control: a row with no annotation shows no Annotation heading.
- **17 (digest day):** `DigestsControllerTest` with `time_zone: "Eastern Time (US & Canada)"` and a request at 23:30 local. It asserts "October 05" and the 24 hour ready-note window.
- **19 (proposed, not run):** a Rails runner that enqueues `request_digest` and asserts `arguments[2] == "0.5"`, run on both versions. Control: the mail body still says "50% of your notes were ready".
- **18:** a model test for `next_day_reminder_at` across the 2026-11-01 DST end, asserting the displayed offset and that `to_i` equals the scheduled epoch.
- **Proposed only:** a test that a notebook can be updated with a stray `slug` param if finding "readonly" is adopted; a test that an expired export index page renders (cache default); and a browser check of the Trix editor.

## Unverified and open questions

- **Trix and the JavaScript layer:** no browser was available. The system tests were not run. I judged compatibility from the gem's `actiontext.js` source only.
- **Production environment:** I only booted production with `SECRET_KEY_BASE=x`, not with a real queue, mail or cache backend. The production cache store is unset, so Rails chooses one automatically.
- **json pin:** the pin was tested with json 2.21.2 only, not as a permanent compatible range.
- **Is 8.1.0 required?** Moving to 8.1.4 would remove the json pin but I did not run it, so any other differences between 8.1.0 and 8.1.4 are untested.
- **Time zone:** are there readers with `time_zone` set to "Astana", "Greenland" or "Canberra"? This is a data question I cannot answer from here.
- **Reminder display contract (finding 18):** it is a product decision.

I stopped my servers, Sidekiq workers and the separate Redis server and dropped my databases. The copies and logs remain in `/tmp/plan` for you to inspect.

---

**Additional commentary**
- I ran `grep` on `Gemfile` and `Gemfile.lock` to find the current version, 7.0.8.7, and passed it to the planner.
- Two decisions are yours: whether to take 8.1.0 with the json pin or a later 8.1.x, and the finding 18 reminder-display contract.
- Say the word and I'll implement it, starting with the preparatory 7.0 release.