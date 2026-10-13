# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The working repo at `/home/user/workspace/repo` was not changed. All experiments ran in disposable copies with their own database, Redis and storage.

**Outcome:** Bumping to 8.1.0 with nothing else changed crashes at boot. The app also needs about 18 code and config changes. One of them fixes a data-integrity problem in imports. I ran the suite at three points:

| Variant | Result |
|---|---|
| Current app on 7.0 | 46 runs, 0 failures |
| 8.1.0, before fixes | crashes at boot |
| 8.1.0 with all fixes, `load_defaults 7.0` | 46 runs, 0 failures |

I also applied the fixes to a 7.0 copy, using 7.0-compatible syntax for the three items marked "8.1 only" in section A. The 7.0 suite still passed with 0 failures, so most of the fixes can ship on 7.0 before the version bump.

## How the experiments were isolated

- **Copies:** `/tmp/rup/app` (upgraded to 8.1) and `/tmp/rup/app70` (stayed on 7.0, with the fixes applied).
- **Services:**
  - A separate PostgreSQL 15 cluster: `/tmp/rup/pg`, socket `/tmp/rup`, port 55432.
  - A separate Redis on port 56379, with saving to disk turned off.
  - Both are stopped now.
  - Active Storage wrote to each copy's own `tmp/storage`, and the test cache is the null store.
- **Environment:** `/tmp/rup/env.sh` sets `DATABASE_URL`, `REDIS_URL`, `RAILS_ENV=test`, `PARALLEL_WORKERS=1` and `BUNDLE_PATH=/tmp/rup/bundle`. The 8.1 gems went into that private directory. A no-op `mise` stub in `/tmp/rup/bin` was needed because the Ruby install's rubygems plugin calls `mise`.
- **Dependencies resolved:** I ran `bundle update rails concurrent-ruby --conservative`, then updated `json`. The lockfiles are `/tmp/rup/Gemfile.lock.81` and `/tmp/rup/Gemfile.lock.81b`.
  - rails 8.1.0, concurrent-ruby 1.3.8
  - json 3.1.0 at first, then pinned to 2.21.2 (see A1)
  - rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, minitest 5.27.0, pg 1.6.0, action_text-trix 2.1.19
- **Logs:**
  - Baseline: `/tmp/rup/base-test.log`
  - Each round of fixes: `/tmp/rup/t81-a.log` to `/tmp/rup/t81-h.log` (`t81-h` is the final passing run)
  - 7.0 with fixes: `/tmp/rup/t70-compat.log`
  - 8.1 with `load_defaults 8.1`: `/tmp/rup/t81-defaults81.log`
  - Sidekiq: `/tmp/rup/x/enqueue81.log`, `/tmp/rup/x/sidekiq81.log`
  - Cross-version payloads: `/tmp/rup/x/p70.json`, `/tmp/rup/x/p81.json`, `/tmp/rup/x/p81meta.json`
- **Scripts:** `/tmp/rup/x/{produce,consume,defaults,enqueue}.rb` and `/tmp/rup/totime.rb`
- **Diff:** `/tmp/rup/x/compat-81-final.patch` holds the changes. It also adds a block to the copy's `config/application.rb` marked "EXPERIMENT ONLY", driven by `EXP_LOAD_DEFAULTS` and `EXP_MSG_META`. Leave that block out of any real change.

## A. Required changes (each confirmed by a failing run on 8.1.0)

Each item lists where it breaks, the fix, and whether the fix also works on 7.0.8.7.

1. **The `json` gem resolves to 3.1.0 and breaks JSON columns.**
   - Where: `serialize :tags` in `app/models/note.rb`. Active Support 8.1.0 calls `JSON.parse(json, options)`. json 3.x no longer accepts that form, so you get "ArgumentError: wrong number of arguments".
   - Fix: pin `gem "json", "< 3"` (2.21.2 worked). A later Rails 8.1.x patch may support json 3, but I didn't check.
   - Check: the `ExportTest` failure in `t81-d` went away after the pin.
2. **`config/initializers/action_text.rb` crashes at boot.**
   - Why: since 7.1, `ActionText::ContentHelper.allowed_tags` defaults to `nil`, so `+=` raises NoMethodError.
   - Fix: inside `after_initialize { ActiveSupport.on_load(:action_view) { ... } }`, set it to `(allowed_tags || sanitizer.class.allowed_tags.to_a + [Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`.
   - Works on 7.0. The test that checks `details` passes on 7.0, on 8.1, and with 8.1 defaults (HTML5 sanitizer).
3. **The old `enum` keyword syntax is gone** (`note.rb:10`).
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`.
   - Works on 7.0. The generated `status_ready` scope and methods keep their names.
4. **`serialize :tags, JSON` no longer accepts the coder as a positional argument** (removed in 7.2).
   - Fix: `serialize :tags, coder: JSON`.
   - 8.1 only, because `coder:` doesn't exist on 7.0. Make this change in the same deploy as the bump, or at a 7.1 step.
   - Also change `notebook.rb` to `serialize :preferences, coder: YAML` at the same time. It isn't needed while `load_defaults` stays at 7.0, but it is under 7.1+ defaults: my runs showed "missing keyword: :coder" at 7.1, 7.2 and 8.1. The stored YAML format doesn't change.
5. **`alias_attribute :highlight_color, :color` now raises,** because `color` comes from `store_accessor` and is not a real attribute.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
   - Works on 7.0.
6. **`config/routes.rb:18`: `get "/notes", "/journal", ...` raises "Wrong number of arguments" in 8.1.**
   - Fix: split it into two routes, `as: :notes` and `as: :journal`.
   - Helper names match 7.0, confirmed by `bin/rails routes` on both versions. Works on 7.0.
7. **`Rails.application.secrets` and `config/secrets.yml` are removed** (since 7.2).
   - Where: `app/models/citation/provider.rb:13`, and `test/controllers/citation_enrichments_controller_test.rb` lines 45 and 117–122.
   - Fix:
     - Move the file to `config/citation_provider.yml`, without the `citation_provider:` nesting.
     - Load it with `config.x.citation_provider = config_for(:citation_provider)`.
     - Change the default to `Rails.configuration.x.citation_provider.to_h`.
   - Works on 7.0.
   - Deploy check: production must still read the `CITATION_PROVIDER_*` environment variables. `secret_key_base` must come from credentials or `ENV`; I confirmed `secrets.yml` holds no `secret_key_base`.
8. **`Export#generate`: `fragments.sum` on strings raises TypeError.**
   - Why: 7.0 overrode `Enumerable#sum` for strings with a deprecation warning, and 7.1 removed that override.
   - Fix: `fragments.join`. Works on 7.0.
9. **`retry_on ... wait: :exponentially_longer` raises "Couldn't determine a delay"** (`citation_enrichment_job.rb`).
   - Fix on 8.1: `:polynomially_longer`, which uses the same formula.
   - Fix that also works on 7.0: `wait: ->(executions) { executions**4 + 2 }`. This drops the jitter.
   - Rollout note: unless this is fixed first, 8.1 workers will raise this error for any retry still queued from 7.0.
10. **`Note#schedule_reminder`: `set(wait_until: reminder_epoch)` with an Integer raises "undefined method `utc`".**
    - Fix: `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
11. **`app/views/notes/index.html.erb:12`: `form_with(model: nil, ...)` raises.**
    - Fix: drop `model: nil`. Field names stay unscoped. Works on 7.0.
12. **`NotesController#index`: `where(notebooks: @notebook)` now queries a missing column `notes.notebooks`.**
    - Fix: `where(notebook: @notebook)`. Works on 7.0.
13. **`Import#receipt`: `citation[:id]` returns nil.**
    - Why: the citations table's primary key is `doi`, and 8.1 no longer maps `[:id]` to the primary key.
    - Effect: the receipt CSV silently loses its DOIs.
    - Fix: `citation&.doi`. Works on 7.0.
14. **`imports/preview.html.erb:22`: `annotations.stringify_keys` now turns the integer line keys into strings.**
    - Effect: annotations quietly disappear from the preview.
    - Fix: remove `.stringify_keys`. Works on 7.0.
15. **Data integrity: `Import#apply` uses `return false` inside `transaction`.**
    - 7.0 rolled back on that `return`; 8.1 commits.
    - Effect: an import with a bad row leaves the import record and the rows before it saved. Confirmed: `record_counts` went from `[0,3,0,1]` to `[1,4,1,2]`.
    - Fix: `raise ActiveRecord::Rollback`, and return a flag that is set only after all rows save. Works on 7.0.
    - Side effect: `rows.all?` stops at the first bad row. That's fine, because the controller calls `@import.preview` afterwards, which fills in every row's errors.
16. **`DigestMailer` changes which day a digest covers.**
    - Why: since 7.1, Active Job keeps the zone of a `TimeWithZone` argument when it serializes it. `requested_at` now arrives in the reader's zone instead of UTC, so the digest covers the reader's local day.
    - Effect: the subject date changes (Oct 05 became Oct 04 in the test).
    - Fix: use `params[:requested_at].utc` in the mailer. Works on 7.0, and also handles jobs queued by 7.0 that carry no zone.
17. **`Note#next_day_reminder_at`: `to_time` now keeps the zone, not just the offset.**
    - Effect: across a daylight-saving change, the "24 hours later" display shows -05:00 instead of -04:00. The epoch (`to_i`) doesn't change, so scheduling is not affected.
    - It happens even with `load_defaults 7.0`: `to_time_preserves_timezone` reads as `nil`, and the setting is deprecated. Confirmed with `/tmp/rup/totime.rb`.
    - Fix: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Works on 7.0.
18. **`config/environments/test.rb`: `show_exceptions = false` now renders 404/500 pages instead of raising.**
    - Effect: several authorization tests stopped detecting missing records.
    - Fix: `:none`. 8.1 only, because on 7.0 that symbol would turn exception pages on. Change it with the bump.

## B. Behavior changes the current tests would not catch

- **Rolling back after the deploy breaks queued digests.**
  - Why: 8.1 always serializes BigDecimal with a `BigDecimalSerializer` tag, and no setting changes that. A `DigestJob` queued on 8.1 makes a 7.0 worker raise "ActiveJob::DeserializationError: Serializer ...BigDecimalSerializer is not known" (`p81.json` read on 7.0).
  - The other direction is fine: 7.0 payloads run on 8.1, and the zone-less time is read as UTC.
  - Do now, works on 7.0: pass `reading_completion.to_s` in `User#request_digest`. The mailer already calls `BigDecimal(...)` on it.
- **Signed IDs written with the 7.1 message settings can't be read by 7.0.**
  - With `use_message_serializer_for_metadata = true`, everything 8.1 generates fails on 7.0 (`p81meta.json`): `attachable_sgid`, blob `signed_id`, and message-verifier output.
  - Action Text stores attachment `sgid` values in `action_text_rich_texts.body`. Attachments added after turning this on would break on rollback.
  - With `load_defaults 7.0`, values pass in both directions (`p70`/`p81`).
  - Recommendation: turn this on only after rollback to 7.x is ruled out.
- **Expired exports would crash the exports page if the 7.1 cache defaults are adopted.**
  - Where: `_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export expires.
  - With the 7.1 default `raise_on_invalid_cache_expiration_time`, that raises (seen in `t81-defaults81`). Production has `perform_caching = true`, while the test suite uses a null store, so tests won't show it.
  - Fix: clamp the value (for example `[.., 1.minute].max`), or skip caching when the export can't be downloaded. Works on 7.0.
- **`Notebook#daily_note_counts` breaks under the 7.2 defaults.**
  - Why: with `postgresql_adapter_decode_dates`, `select_rows` returns `Date` objects, and `Date.iso8601(day)` raises TypeError.
  - Fix: `day.to_date`, which handles both strings and dates on both versions.
- **`NotebooksController` permits `:slug`, which raises under the 7.1 defaults** (`raise_on_assign_to_attr_readonly` raises ReadonlyAttributeError).
  - Fix: stop permitting `:slug`. Works on 7.0.
- **Sidekiq 6.5.12 works on 8.1 but is deprecated.**
  - Enqueuing and a real Sidekiq process both worked: Digest, Reminder and Export jobs all completed. Logs: `enqueue81.log`, `sidekiq81.log`.
  - It warns "built-in sidekiq adapter ... removed in Rails 8.2".
  - Moving to sidekiq 7.3.3+ is optional for 8.1. Plan it as a separate upgrade, because it has two hazards:
    - `Sidekiq.redis { sadd }` returns an Integer through redis-client. `0` is truthy in Ruby, so digest de-duplication would stop working. Use `sadd?` or `== 1`.
    - `ExportJob.perform_async(id, { format: ... })` uses symbol keys and already triggers strict-argument warnings. Use string keys.

## C. Optional new framework defaults

Keep `load_defaults 7.0` for the bump, then adopt new defaults one at a time through `new_framework_defaults_*` files. My run with `load_defaults 8.1` gave 3 errors (the cache, date and slug items in section B) plus the `:coder` error from A4.

- **7.1:**
  - `default_column_serializer = nil`: needs the coders from A4.
  - `message_serializer` and `use_message_serializer_for_metadata`: rollback risk, see section B.
  - `cache_format_version 7.1`: 7.0 can't read the new cache entries, so clear the cache on rollback. The default production store is FileStore in `tmp/cache`, and only fragments are cached.
  - `raise_on_invalid_cache_expiration_time` and `raise_on_assign_to_attr_readonly`: see section B.
  - `sanitizer_vendor` HTML5: passed.
  - `run_after_transaction_callbacks_in_order_defined` and `before_committed_on_all_records`: low risk, because the app has no transaction callbacks.
- **7.2:**
  - `postgresql_adapter_decode_dates`: see section B.
  - `yjit`
  - `validate_migration_timestamps`
- **8.0:** `strict_freshness`. This affects the `stale?` call in `ExportDownloadsController`; check ETag and Last-Modified behavior.
- **8.1:**
  - `escape_json_responses = false` and `escape_js_separators_in_json = false`
  - `action_on_path_relative_redirect = :raise`
  - `raise_on_missing_required_finder_order_columns`
  - `remove_hidden_field_autocomplete` and `render_tracker`
- **Changes that are not new defaults:**
  - `enqueue_after_transaction_commit` stays `false` per job class in 8.1. Citation and Note keep enqueuing inside the row lock, and the transaction rolls back if the enqueue fails. Don't turn it on: `job.job_id` is saved inside the transaction, and a failed enqueue after commit wouldn't roll anything back.
  - Development and test secrets move from `tmp/development_secret.txt` to `tmp/local_secret.txt`. This only affects local sessions.

## D. Rollout order

1. **Ship these on 7.0 first:**
   - Section A: A2, A3, A5–A8, A9 (lambda form), and A10–A17.
   - Section B: the `to_s` completion change, the cache clamp, `day.to_date`, and dropping `:slug`.
   - The 7.0 suite passed with all of these.
2. **The bump release:**
   - Gemfile: rails 8.1.0, `json < 3`, and remove the concurrent-ruby pin. Keep the minitest ~> 5 pin and puma 5; the tests use `Puma::Events.strings`, which puma 6 removed.
   - Code and config: the A4 coders, A18, `:polynomially_longer`, and `schema.rb` regenerated with the 8.1 header.
   - Deploy workers and web together, or workers first. 8.1 workers handle 7.0 payloads, including scheduled reminder jobs already waiting in Redis.
3. **Rollback:**
   - Job payloads are safe to roll back only if the completion `to_s` change shipped first.
   - If any 7.1 message settings were adopted, Action Text and signed-ID data written after that point can't be read on 7.0.
   - Clear the cache if the cache format changed.

The Rails guides recommend going through 7.1, 7.2 and 8.0 before 8.1, so each deprecation shows up as it appears. I didn't run the intermediate versions.

## E. Not verified yet

- I didn't run the browser suite (`bin/rails test:system`) because this machine has no Chrome or chromedriver.
- I didn't run Rails 7.1, 7.2 or 8.0 to collect deprecation output at each step.
- I didn't test Rack 3; it stayed at 2.2 because of `--conservative`. Under Rack 3.1+, the 22 uses of `:unprocessable_entity` would warn, so switch them to `:unprocessable_content`.
- I didn't check whether a later 8.1.x patch supports json 3.
- I didn't read the upgrade guides and changelogs. The conclusions come from the 8.1.0 gem source (`configuration.rb` defaults, the Active Job serializers and Sidekiq adapter, the Active Record transaction code) and from the runs above.

## Questions for you

- Do production `notebooks.preferences` rows hold YAML types other than plain string hashes? Safe YAML loading would reject them. You can check with `SELECT id FROM notebooks WHERE preferences LIKE '%!ruby%'`.
- Do you need to be able to roll back to 7.x after the 7.1 message settings are adopted? If so, don't adopt them yet.

---

I checked a few of the plan's claims myself:

- **Test results match.** The final lines of the three logs agree with the table at the top:
  - `/tmp/rup/base-test.log`: 46 runs, 325 assertions, 0 failures
  - `/tmp/rup/t81-h.log`: 46 runs, 340 assertions, 0 failures
  - `/tmp/rup/t70-compat.log`: 46 runs, 325 assertions, 0 failures
- **The other files it cites exist.** That includes the lockfiles, the final patch, the payload files and the Sidekiq logs. One path was wrong in the original report: `totime.rb` is at `/tmp/rup/totime.rb`, not under `/tmp/rup/x/`. I corrected it above.
- **The working repo is unchanged.** `git status` in `/home/user/workspace/repo` is clean.
- **Not re-checked:** I did not re-run any experiments or confirm the individual fixes against the code. The planner also never read the official upgrade guides or changelogs; its conclusions come from the gem source and its own runs.

---

That's the plan only: the upgrade skill doesn't make changes, so Rails is still at 7.0.8.7 and your repo is untouched. The "I checked" notes above came from the planning agent; I didn't re-run any of its experiments.

Once you've answered the two questions above, I can start on step D1: the fixes that work on 7.0, which can ship before the version bump. If you'd rather, I can do the bump release in one go instead.