Here is the plan from the planner agent, returned verbatim as the skill requires. I haven't changed the app.

**Current version:** Rails 7.0.8.7 (pinned in `Gemfile` and `Gemfile.lock`). **Target:** 8.1.0.

---

# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

I did not write or check this plan myself, and I did not re-run any experiments. The `maintain-rails:gem-upgrade-planner` agent was not available to the subagent, so the subagent did the analysis itself. It reports that nothing in `/home/user/workspace/repo` was changed and that experiments ran in a disposable copy at `/tmp/rails81-exp`. All claims below are the subagent's, and I have not checked any of them against the repo. That applies to its statements about line numbers, file contents, and test results.

## Experiment setup (subagent-reported)

- **Isolation:** a dedicated Postgres 15 instance (port 55432), a dedicated Redis (port 56379), and copy-local `tmp/` and `storage/`. The machine's shared Postgres and Redis were not used. Both dedicated services are now shut down.
- **Copies:**
  - `/tmp/rails81-exp/app7` is the unchanged 7.0.8.7 baseline.
  - `/tmp/rails81-exp/app81` is Rails 8.1.0 with the fixes below.
  - `/tmp/rails81-exp/app7b` is 7.0.8.7 with only the 7.0-compatible preparatory fixes.
- **Environment:** `/tmp/rails81-exp/env.sh` sets `REDIS_URL` and `DATABASE_URL`.
- **Resolved dependencies:** `bundle update rails --conservative` gave Rails 8.1.0 with Rack 2.2.24, Puma 5.6.9, Sidekiq 6.5.12, Redis gem 4.8.1, pg 1.6.0, minitest 5.27.0, action_text-trix 2.1.19 and rails-html-sanitizer 1.7.1. It also resolved json 3.1.0, which had to be pinned to json 2.21.2 (item 13).
- **Lockfiles and diff:** `Gemfile.lock.conservative81` and `Gemfile.lock.app81` in `/tmp/rails81-exp/logs/`. The app81 diff is `/tmp/rails81-exp/logs/app81-experiment.diff`.
- **Test results:**

| Variant | Runs | Failures | Log |
|---|---|---|---|
| 7.0.8.7 baseline | 46 | 0 | `logs/baseline70.log` |
| 8.1.0 with fixes | 46 | 0 | `logs/run81-fix6.log` |
| 8.1.0 unfixed (after boot blockers) | not stated | 15 failures or errors | `logs/run81-fix4.log` |
| 7.0.8.7 with preparatory subset | 46 | 0 | `logs/run70-prepared.log` |

## Required changes

### Boot and load blockers (source-based and executed)

1. **`config/initializers/action_text.rb`**
   - **Failure:** `ContentHelper.allowed_tags += ...` raises `NoMethodError` on nil at boot, because `allowed_tags` now defaults to nil.
   - **Fix:** assign the full list: `ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - **Works on 7.0:** yes (passed on app7b).
   - **Validation:** `notes_controller_test.rb:141` checks that `details` and `summary` survive while script and onclick are stripped. An assignment of only the two extra tags would strip everything else, and that test would catch it.
2. **`app/models/note.rb`, `enum status: {...}, _prefix: true`**
   - **Failure:** the keyword form is removed and raises `ArgumentError`.
   - **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
   - **Works on 7.0:** yes. `citation.rb` already uses the positional form.
3. **`app/models/note.rb`, `serialize :tags, JSON`**
   - **Failure:** the positional coder is removed and raises `ArgumentError`.
   - **Fix:** `serialize :tags, coder: JSON`.
   - **Do not apply early.** On 7.0, `coder: JSON` silently selects the YAML coder. `serialize(%w[a b])` returned `"---\n- a\n- b\n"` (`probe3.rb`), which would write YAML into a JSON column. Make this change in the same release that moves to 7.1 or later.
   - **Rollout and rollback:** 8.1 keeps writing JSON, so the stored format does not change and rollback is safe.
4. **`config/routes.rb:18`, `get "/notes", "/journal", to:`**
   - **Failure:** multi-path `get` raises `ArgumentError`.
   - **Fix:** two separate `get` lines, `/notes` first, then `/journal`.
   - **Names:** both versions give the names `notes` and `journal` (checked on 7.0 with `bin/rails routes`).
   - **Works on 7.0:** yes.
5. **`app/models/note.rb`, `alias_attribute :highlight_color, :color`**
   - **Failure:** `color` is a `store_accessor`, not an attribute, so 8.1 raises `ArgumentError` at first use.
   - **Fix:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`, or define the methods by hand.
   - **Works on 7.0:** yes.
   - **Data:** the jsonb key stays `color`. Do not use `store_accessor :highlight_color`, which would store a new key.
6. **`app/models/export.rb:42`, `fragments.sum`**
   - **Failure:** `TypeError: String can't be coerced into Integer`. Rails 7.0 only worked here through a deprecated string-friendly `sum` override.
   - **Fix:** `fragments.join`.
   - **Works on 7.0:** yes, and it removes the deprecation warning seen in the baseline log.
7. **`app/models/citation/provider.rb`, `Rails.application.secrets`**
   - **Failure:** `NoMethodError`, because `secrets` is removed.
   - **Fix:**
     - Move `config/secrets.yml` to `config/citation_provider.yml` using the flat env-keyed shape.
     - In `config/application.rb`, set `config.x.citation_provider = config_for(:citation_provider)`.
     - Read `Rails.configuration.x.citation_provider.to_h` in `Citation::Provider`.
     - Update `with_provider` in `test/controllers/citation_enrichments_controller_test.rb`, which mutates `secrets` directly (about lines 114 to 120 and line 45).
   - **Works on 7.0:** yes.
   - **Validation:** the "credentials from the environment reach the server unchanged" test boots a fresh process. It checks that `to_json` quoting survives, for values like `00123` and `sample: value # keep`.
8. **`app/jobs/citation_enrichment_job.rb`, `wait: :exponentially_longer`**
   - **Failure:** `RuntimeError: Couldn't determine a delay`, surfaced in `request_enrichment`.
   - **Fix:** `:polynomially_longer`, which has the same formula.
   - **Not available on 7.0:** it raises there (`probe3.rb`). Change it with the upgrade, not before.
9. **`config/environments/test.rb`, `show_exceptions = false`**
   - **Effect:** 8.1 no longer raises. Tests that use `assert_raises(ActiveRecord::RecordNotFound)` fail with "nothing was raised" and the request returns 404. Six tests were affected.
   - **Fix:** `:none`.
   - **Not for 7.0:** 7.0 treats any non-`false` value as "show exceptions", so do this with the upgrade.
10. **`app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)`**
    - **Failure:** 8.1 raises "Passed nil to the :model argument".
    - **Fix:** `model: false`.
    - **Works on 7.0:** yes.
11. **`app/controllers/notes_controller.rb:12`, `where(notebooks: @notebook)`**
    - **Failure:** SQL error, `notes.notebooks does not exist`.
    - **Fix:** `where(notebook: @notebook)`.
    - **Works on 7.0:** yes.
12. **`app/models/note.rb:62`, `wait_until: reminder_epoch`**
    - **Failure:** 8.1 calls `.utc` on the value, so an Integer raises `NoMethodError`.
    - **Fix:** `wait_until: Time.at(reminder_epoch)`.
    - **Works on 7.0:** yes.
    - **Queued data:** the scheduled time is unchanged.
13. **Dependency pin**
    - **Problem:** with Rails 8.1.0, the resolver picked json 3.1.0. ActiveSupport 8.1.0's `JSON.parse(json, options)` then fails with "wrong number of arguments (given 2, expected 1)".
    - **Effect:** every encrypted-cookie decode fails, so every request returns a 500. That is how the first tests died.
    - **Fix:** pin `json ~> 2.21` for 8.1.0, or move to a later 8.1.x.
    - **Open question:** 8.1.4 exists. Is 8.1.0 required? 8.1.4 was not tested.

### Silent behavior changes that tests only partly expose

14. **`app/models/import.rb#apply`: partial import**
    - **Cause:** `return false` inside `transaction do` now commits. In 8.1 an invalid row leaves earlier rows and the Import record saved.
    - **Executed evidence:** the test "applying them saves nothing" failed with record counts `[1, 4, 1, 2]` against `[0, 3, 0, 1]`.
    - **Fix:** track a `saved` flag and `raise ActiveRecord::Rollback` unless every row saves.
    - **Works on 7.0:** yes.
    - **Data:** any user-visible partial imports after the upgrade would need cleanup.
15. **`app/models/import.rb#receipt`: blank DOI column**
    - **Cause:** `citation[:id]` returns nil on 8.1 because `doi` is the primary key. The 7.0 value was the DOI (`probe1.log`).
    - **Effect:** the receipt CSV silently has a blank DOI column.
    - **Fix:** `citation.doi`.
    - **Works on 7.0:** yes.
16. **`app/views/imports/preview.html.erb`: annotations vanish**
    - **Cause:** `@import.annotations.stringify_keys` now turns integer keys into strings, so `annotations[row.line]` misses.
    - **Effect:** annotations disappear from the preview.
    - **Fix:** drop `stringify_keys`.
    - **Works on 7.0:** yes.
17. **Digest day**
    - **Cause:** ActiveJob now serializes the `TimeWithZone` zone name. `DigestMailer` therefore sees the reader's local time instead of UTC, and the subject and note window shift a day. The test showed "October 04" where "October 05" was expected.
    - **Fix:** `requested_at = requested_at.utc` in `DigestMailer`.
    - **Works on 7.0:** yes.
    - **Mixed-version behavior (executed):** jobs queued by 7.0 carry no zone key and deserialize as UTC. Jobs queued by 8.1 carry the zone.
18. **Next-day reminder preview**
    - **Cause:** `reminder_at.to_time + 86_400` no longer keeps the original UTC offset. Across the DST end, `datetime` went from `-04:00` to `-05:00` and the wall-clock label changed.
    - **Fix to keep the documented offset behavior:** `Time.at(reminder_epoch + 86_400).localtime(reminder_at.utc_offset)`.
    - **Works on 7.0:** yes.
    - **Product question:** is the old offset-keeping display wanted? The new behavior is arguably more correct.
    - **Config:** `config.active_support.to_time_preserves_timezone` is deprecated and reads nil on 8.1, so config cannot restore the old behavior.

## Mixed-version rollout and rollback

- **Rollback hazard (executed, `logs/mixed-version.log`):**
  - **What happens:** a `DigestJob` queued by 8.1 contains a `BigDecimalSerializer` entry. A 7.0 worker fails it with `DeserializationError: Serializer ... BigDecimalSerializer is not known`, and the job sits in Sidekiq's retry set.
  - **Side effect:** the daily Redis reservation (`sadd`) is already consumed, so the reader cannot re-request that day.
  - **Preparatory fix (works on 7.0):** pass `reading_completion.to_s` from `User#request_digest`. `DigestMailer` already calls `BigDecimal(params[:completion])`, so a String works. 7.0 already sends it as a String.
  - **What passed:** 7.0-queued jobs ran on an 8.1 worker (reminder, export, digest). 8.1-queued reminder and export jobs ran on a 7.0 worker.
  - **Not tested:** the digest mail itself on the 8.1-to-7.0 path, since it fails on deserialization.
- **Other queued work:**
  - `ExportJob` is a native Sidekiq job and is unaffected.
  - `NoteReminderJob` payloads are compatible both ways.
  - `Time.at(...)` keeps the same scheduled timestamp.
- **Cookies and CSRF (executed, `logs/http-compat.log`):** sessions and per-form CSRF tokens work across a mixed 7.0 and 8.1 fleet in both directions, provided `secret_key_base` is identical and `load_defaults 7.0` is kept. Caveats:
  - 7.1 and later let `ENV["SECRET_KEY_BASE"]` override the local development secret. 7.0 in development ignores it.
  - The development secret file was renamed from `tmp/development_secret.txt` to `tmp/local_secret.txt`. This only matters in development.
- **Stored data:**
  - `notes.tags` stays JSON.
  - `notebooks.preferences` is YAML with string keys.
  - No new migrations are needed. The Active Storage and Action Text migration templates are unchanged between 7.0 and 8.1.
  - **Schema dump:** `db:schema:dump` under 8.1 writes `Schema[8.1]`, `pg_catalog.plpgsql`, and alphabetically sorted columns. A 7.0 rollback cannot load that file. Do not commit a regenerated `schema.rb` until the upgrade is final.
- **Data scan before deploy (proposed, not run):** check that `notebooks.preferences` has no YAML tags beyond plain hashes and strings. YAML loading is already safe-load on 7.0.8.7 and on 8.1, but real production data was not tested.

## Optional and default adoption (not required)

- **`config.load_defaults`:** keep 7.0 for the upgrade, and adopt later defaults one at a time.
- **`enqueue_after_transaction_commit`:** 8.1 with `load_defaults 7.0` gives `false` (`probe1.log`). Under `load_defaults 7.2` or later it becomes `:default`, which defers to the adapter. Reconsider before adopting it, because `Note#schedule_reminder` and `Citation#request_enrichment` depend on enqueueing inside the row lock and on the failure rolling the transaction back.
- **`image_processing` warning:** production boot now logs "Generating image variants require the image_processing gem". Add the gem or set `variant_processor = :disabled`.
- **Rack 3, Puma 6, Sidekiq 7:** none is required. 8.1.0 accepts Rack 2.2.24. Puma 5.6.9 served real requests, and a real Sidekiq 6.5.12 worker ran the jobs.
  - **If you upgrade Sidekiq or Redis later (source-based, unverified):** `Redis#sadd` returns an Integer, and `0` is truthy, so the digest reservation guard in `User#request_digest` would always pass. `Redis::BaseError` would also no longer be the error raised.
  - **Test hazard:** the test's `Puma::Events.strings` call is Puma-5-specific.
- **`Note.connection`:** soft-deprecated for later versions, with no warning in this setup.
- **Rack 3.1+ status names (unverified):** `:unprocessable_entity` is deprecated in favor of `:unprocessable_content`. It only matters after Rack 3.1.
- **Minitest:** keep the 5.x pin. Whether Rails 8.1.0 works with Minitest 6 was not tested.

## Checks that found no problem (executed)

- `Note.connection.select_rows` for `DATE(...)` still returns text, so `Date.iso8601` works (`probe1.log`).
- `ActionText::Content#to_plain_text` and sanitized rendering are identical on 7.0 and 8.1 for lists, quotes, pre, details, tables, entities and attachments (`probe2.log`). That settles the export Markdown output.
- Production boot with eager load, `zeitwerk:check` and `assets:precompile` pass on 8.1 (`logs/prod-boot81.log`).
  - The database role error in that log is only the sandbox.
  - Trix CSS resolves from the `action_text-trix` gem.

## Not verified

- **Browser behavior:** system tests need Chrome and a display, and none was run. Trix moved from the actiontext gem to the `action_text-trix` gem (2.1.19 here). `config/importmap.rb` does not pin `trix` on 7.0 either, so this is pre-existing. Whether the editor works in a browser on either version was not checked.
- **Intermediate versions:** only the 7.0.8.7 and 8.1.0 endpoints were run. The claim that most of these removals landed at 7.1, 7.2 or 8.0 is source-recall. A real upgrade should still hop 7.1, 7.2, 8.0, then 8.1, and use the deprecation warnings.
- **Production Redis and Sidekiq state:** the size of the existing retry set and scheduled queue in production is unknown.
- **Remaining behaviors:** Rails 8.1.0's behavior with real production cache stores and file-store fragment entries (`_export.html.erb` uses `cache`) was not tested. `cache_format_version` stays 7.0 under `load_defaults 7.0`, which was confirmed. Cache entries shared between versions were not tested.

## Recommended order

1. **On 7.0 now (all tested on `app7b`):** items 1, 4, 5, 6, 7, 10, 11, 12, 14, 15, 16, 17 and 18, plus the `to_s` change to `DigestJob`'s completion argument.
2. **In the upgrade release:** items 2, 3, 8 and 9, the json pin or a newer 8.1.x, and the Gemfile bump.
3. **Smoke test after deploy:** digest request, reminder scheduling and postponing, export and download, import preview and apply with an invalid row, and note list filtering.

## Key paths

- `/tmp/rails81-exp/logs/app81-experiment.diff`
- `/tmp/rails81-exp/logs/mixed-version.log`
- `/tmp/rails81-exp/logs/probe1.log`
- `/tmp/rails81-exp/logs/http-compat.log`
- `/home/user/workspace/repo/app/models/{note,import,export,user}.rb`
- `/home/user/workspace/repo/config/{routes,application}.rb`
- `/home/user/workspace/repo/config/initializers/action_text.rb`
- `/home/user/workspace/repo/config/secrets.yml`

---

## Commentary

- I haven't verified any of these findings against the repo. Treat the file and line references as unconfirmed until someone opens the files.
- The subagent says the `gem-upgrade-planner` agent wasn't available to it, so it did the analysis itself.
- Two decisions are open:
  - **Item 13:** whether 8.1.0 is required or a later 8.1.x is acceptable.
  - **Item 18:** whether the old offset-keeping reminder preview is wanted.
- I didn't implement anything. Tell me if you want me to start on the 7.0-compatible preparatory changes.
