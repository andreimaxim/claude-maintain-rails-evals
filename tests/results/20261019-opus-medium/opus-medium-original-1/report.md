Below is the upgrade planner's full plan, unchanged. I haven't made the upgrade or changed your repository.

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

## 1. Summary

- **Upgrading only the Rails pin does not boot on any version from 7.1 onward.** The Action Text initializer crashes during startup.
- **Once that is fixed, the existing tests find 8 more breakages.** They are listed in R2–R9 below.
- **Six further changes are needed that the tests would not catch.** Each was shown by a targeted experiment or by reading the Rails source:
  - Digest emails would silently cover a different day (R10).
  - Import CSV receipts would lose their DOI column (R7).
  - A failed import could commit partly (R6).
  - Jobs queued during the rollout could fail to load on older workers (R10).
  - Rich text saved with one optional setting turned on breaks note pages after a rollback (§5).
  - The schema file stops loading on 7.0 once it has been regenerated (§5).
- **Rails 8.1.0 also needs a pin on the `json` gem.** With nothing pinned, Bundler picks `json 3.1.0`, which Rails 8.1.0 cannot use. Every signed-in request fails.
- **Most fixes can ship on 7.0.8.7 first.** With them applied, the full suite passes on 7.0.8.7, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0 (46 runs, 0 failures each).
- **Keep `config.load_defaults 7.0` during the upgrade.** Turning on newer defaults is a separate, later step, and some of them need code changes first (§4).
- **Sidekiq 6.5.12, Puma 5, Rack 2.2, Redis 4.8, Pagy and Faraday can stay as they are for 8.1.** Rails 8.1 warns that its built-in Sidekiq adapter will be removed in 8.2.

**Suggested order:**
1. Ship the 7.0-compatible fixes (R1–R11) on 7.0.8.7.
2. Move through 7.1.6, 7.2.4 and 8.0.5.1, then 8.1.0, with the small per-version edits (V1–V4).
3. Consider newer defaults only after 8.1 is stable and rollback is no longer needed.

## 2. How the experiments were run

- **Copies:** fresh `git clone`s of the repo at `/tmp/upgrade-exp/{base,bridge-7.0.8.7,v7.1.6,v7.2.4,v8.0.5.1,v8.1.0,v8.1.0-ld81}`.
- **Isolated services:**
  - Postgres 15 cluster at `/tmp/upgrade-exp/pgdata`, port 55432, socket in `/tmp/upgrade-exp/pgsock`.
  - Redis on port 56379, no persistence, data dir `/tmp/upgrade-exp/redis`.
  - The shared services on 5432 and 6379 were never used.
- **Storage:** Active Storage used each copy's own `storage/` and `tmp/storage`.
- **Caches:** the shared-cache test used `/tmp/upgrade-exp/shared-cache`.
- **Mail:** delivered to each copy's `tmp/mails`.
- **Gems:** installed into `/tmp/upgrade-exp/bundle` through each copy's local `bundle config path`. The base copy used the gems already installed.
- **Ruby:** 3.3.6, called by direct path rather than through mise, so no mise trust settings were changed.
- **Environment files:**
  - `/tmp/upgrade-exp/env.sh` sets PGHOST, PGPORT, REDIS_URL and PATH.
  - `/tmp/upgrade-exp/mixed-env.sh` sets production mode, a `DATABASE_URL` for the `margin_notes_mixed` database, a fixed SECRET_KEY_BASE, and Redis database 2.
- **Lockfiles:** produced with `bundle lock --update rails` after changing only the `rails` line.
  - Every variant kept rack 2.2.24, rackup 1.0.1, sidekiq 6.5.12, concurrent-ruby 1.3.4 and minitest 5.27.0.
  - 8.1.0 added `action_text-trix 2.1.19` and `json 3.1.0`; the second run pinned json to `~> 2.7`, which resolved to 2.21.2.
  - Logs are in `/tmp/upgrade-exp/logs/v*-lock.log` and `v*-install.log`.
- **Test command:** `RAILS_ENV=test bin/rails db:drop db:create db:schema:load && bin/rails test`.
- **Logs and patches:** `/tmp/upgrade-exp/logs/*-test*.log`. The changes applied are in `/tmp/upgrade-exp/patches/` (`prep-7.0-compatible.diff`, `final-<variant>.diff`, `citation_provider.yml`, `action_text.rb`). The script used is `/tmp/upgrade-exp/scripts/prep_patch.rb`; the `Import#apply` and view edits were applied afterwards and are captured in the `final-*.diff` files.
  - Note that `final-v8.1.0.diff` also contains an experiment-only `EXP_71_MESSAGES` block in `config/application.rb` and the `json` pin.

**Test results by run:**

| Variant | Result | Log |
|---|---|---|
| 7.0.8.7 baseline (unchanged) | 46 runs, 325 assertions, 0 failures | `base-7.0.8.7-test.log` |
| 7.1.6, Rails pin only | crashes at boot (`NoMethodError` from the Action Text initializer) | `v7.1.6-test.log` |
| 7.1.6, Action Text fix only | 1 failure, 3 errors | `v7.1.6-test-r2.log` |
| 7.2.4 / 8.0.5.1 / 8.1.0, Action Text fix only | 46 errors each | `*-test-r2.log` |
| All variants with all fixes | 46 runs, 0 failures each | `*-test-final.log` |
| 8.1.0 with `load_defaults 8.1` | 2 errors after adding `coder: YAML` | `v8.1.0-ld81-test-r2.log` |

- In the final runs 7.0 reports 325 assertions and 7.1 onward report 340. I did not find out why.
- System tests (`bin/rails test:system`) were not run because Chrome is not installed.

## 3. Required changes

Each item lists where it applies, what to change, whether the change also works on 7.0.8.7, and how it was checked: **[EXEC]** means run in an experiment, **[SRC]** means read in the Rails source, **[PROPOSED]** means not yet run.

### R1. Action Text allowed tags crashes at boot (breaks from 7.1)
- **Where:** `/home/user/workspace/repo/config/initializers/action_text.rb:3`, `ActionText::ContentHelper.allowed_tags += %w[ details summary ]`.
- **Why:** from 7.1, `allowed_tags` starts as `nil` and is worked out later. `nil + [...]` raises `NoMethodError` and the app does not boot.
- **Fix:** move the change into `Rails.application.config.after_initialize`:
  - Start from `helper.allowed_tags`.
  - If that is nil, use `helper.sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"]`.
  - Add `details` and `summary`, then assign the result.
  - The exact text is in `/tmp/upgrade-exp/patches/action_text.rb`.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** boot failure seen in `v7.1.6-test.log`. With the fix, the existing notes test that checks `<details>`/`<summary>` survive and `<script>`/`javascript:` are stripped passes on every variant.
- **Caveat:** the list is now fixed at startup. If you later switch to the 7.1 HTML5 sanitizer, it picks up the HTML5 list, because the engine sets the sanitizer before `after_initialize` runs.

### R2. `Rails.application.secrets` removed (7.2)
- **Where:**
  - `/home/user/workspace/repo/app/models/citation/provider.rb:13` (and the comment on line 3).
  - `/home/user/workspace/repo/config/secrets.yml`.
  - `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`.
  - Documentation: `/home/user/workspace/repo/ARCHITECTURE.md:79-80` and `/home/user/workspace/repo/CONTRIBUTING.md:38`.
- **Fix:**
  - Move the settings to `config/citation_provider.yml` with the same ERB and `.to_json` quoting, at top level per environment.
  - Load it in `config/application.rb` with `config.x.citation_provider = config_for(:citation_provider)`.
  - Read `Rails.configuration.x.citation_provider.to_h` in the provider.
  - Update the test to use the same setting.
  - Update the two docs, as CLAUDE.md asks.
- **Works on 7.0:** yes (`config_for` returns symbol keys there too).
- **Validation [EXEC]:** passes on every variant, including the test that boots a fresh `bin/rails runner` to read credentials such as `"00123"` and `"sample: value # keep"` from the environment.
- **Still to check [PROPOSED]:** production must have the same `CITATION_PROVIDER_*` variables set. If they are missing, the value is `nil` as before.
- **Not affected:** `secret_key_base` is not in `secrets.yml`, so production still takes it from credentials or `SECRET_KEY_BASE`.

### R3. `Enumerable#sum` on strings removed (7.1)
- **Where:** `/home/user/workspace/repo/app/models/export.rb:42`, `finish(fragments.sum)`.
- **What happens:** `TypeError: String can't be coerced into Integer` from 7.1. On 7.0 this already prints a deprecation warning.
- **Fix:** `fragments.join`.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** 3 export test errors on 7.1.6 (`v7.1.6-test-r2.log`); all pass with the fix.
- **Rollout:** any `ExportJob` that runs on a 7.1+ worker before this fix fails and is retried by Sidekiq. Ship it first.

### R4. Keyword-style `enum` removed (8.0)
- **Where:** `/home/user/workspace/repo/app/models/note.rb:10`.
- **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** raises `ArgumentError` from 7.2 (`v7.2.4-test-r2.log`); passes with the fix.

### R5. `alias_attribute` pointing at a store accessor (breaks from 7.2)
- **Where:** `/home/user/workspace/repo/app/models/note.rb:14`. The target is `color`, a `store_accessor` on `settings`, not a database column.
- **Fix:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** deprecated on 7.1 and breaks on 7.2. With the fix, the existing form tests (radio button checked, update to "blue") pass on every variant.

### R6. A failed import can commit partly (7.2, silent)
- **Where:** `/home/user/workspace/repo/app/models/import.rb:53-58`, `return false unless row.note.save` inside `transaction do`.
- **What happens:** on 7.0 and 7.1, `return` rolls the transaction back. From 7.2 it **commits**: the `Import` and every note saved before the failing row are kept, while the user is told nothing was saved.
- **Why tests miss it:** the controller re-validates before applying, so the tests never reach a save failure inside the transaction.
- **Fix:** set `saved = rows.all? { |row| row.note.save }`, then `raise ActiveRecord::Rollback unless saved` inside the transaction, and return `saved`.
  - Do not use `return true` inside the block: on 7.0 that also rolls back.
- **Works on 7.0:** yes.
- **Validation:** 7.1 prints "A transaction is being rolled back…" for this line [EXEC, `v7.1.6-test-r2.log`]. The 7.2 commit behaviour is from the deprecation text and source [SRC].
- **Still to check [PROPOSED]:** a model test that makes the second row's `save` return false (for example a stubbed validation or a database error) and asserts no import and no notes exist afterwards. Run it on 7.2 with and without the fix.

### R7. Import receipt loses its DOI column (7.2, silent)
- **Where:** `/home/user/workspace/repo/app/models/import.rb:68`, `citation[:id]`. `Citation`'s primary key is `doi` and the table has no `id` column (`db/schema.rb`, `create_table "citations", primary_key: "doi"`).
- **What happens:** on 7.0, `[:id]` returns the primary key. 7.1 deprecates this. From 7.2 it reads a column named `id`, so the receipt's DOI column would come out empty.
- **Fix:** `citation&.doi`.
- **Works on 7.0:** yes.
- **Validation:** 7.1 deprecation seen [EXEC]. The existing receipt test checks the CSV body and passes with the fix on every variant [EXEC]. I did not run the original code on 7.2 to see the empty column.

### R8. Multiple paths in one route (deprecated 8.0, error in 8.1)
- **Where:** `/home/user/workspace/repo/config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`.
- **Fix:** two separate `get` lines. The `notes_path` and `journal_path` helpers keep the same names.
- **Works on 7.0:** yes.
- **Validation:** the 8.1 source raises "Wrong number of arguments (expect 1, got 2)" [SRC]. The existing test that loads both paths passes with the fix [EXEC].

### R9. `form_with(model: nil)` (deprecated 7.2, error in 8.0)
- **Where:** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`.
- **Fix:** remove `model: nil`.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** 7 errors on 8.0 (`v8.0.5.1-test-r3.log`), 16 deprecations on 7.2; all pass with the fix, including "renders an unbound search form".

### R10. Job argument formats: digest day and BigDecimal (7.1, mixed-version risk)

**(a) The digest would cover a different day.**
- **Where:** `/home/user/workspace/repo/app/models/user.rb:41` and `/home/user/workspace/repo/app/mailers/digest_mailer.rb:7-9`.
- **What happens:** from 7.1, Active Job keeps the time zone of a time argument. The mailer would then use the reader's local day instead of the UTC day the UI promises. The subject changed from "October 05" to "October 04" [EXEC, `v7.1.6-test-r2.log`].
- **Fix:** in the mailer, `requested_at = requested_at.in_time_zone("UTC")`.

**(b) BigDecimal arguments break older workers.**
- **What happens:** from 7.2, BigDecimal arguments are always written in a new format that 7.0 and 7.1 cannot read.
- **Fix:** enqueue `reading_completion.to_s`. The mailer already calls `BigDecimal(params[:completion])`.

**Both fixes:** work on 7.0.

**Validation [EXEC], `/tmp/upgrade-exp/logs/cross-queue.log`:**
- A 7.0 reader fails on an 8.1-enqueued BigDecimal argument: `ActiveJob::DeserializationError … BigDecimalSerializer is not known`.
- The patched string argument loads on both versions.
- Times enqueued on 7.0 load in UTC on 8.1; times enqueued on 8.1 load in America/New_York. With the mailer fix both give the UTC day.

### R11. `to_time` keeps the full time zone (8.1, silent display change)
- **Where:** `/home/user/workspace/repo/app/models/note.rb:44`, `reminder_at.to_time + 86_400`.
- **What happens:** from 8.1, `to_time` always returns a time in the reader's zone and the old setting has no effect. The "24 hours later" preview then shows 08:00 -05:00 across a daylight-saving change, instead of the documented 09:00 -04:00. The stored epoch is the same either way.
- **Fix:** `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** reminders test failure on 8.1 (`v8.1.0-test-r4.log`); passes with the fix on all variants.

### R12. Import preview loses annotations (8.0)
- **Where:** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22`, `@import.annotations.stringify_keys`.
- **What happens:** from 8.0 this turns the integer line-number keys into strings, so `annotations[row.line]` finds nothing.
- **Fix:** use `@import.annotations` directly.
- **Works on 7.0:** yes.
- **Validation [EXEC]:** 2 import test failures on 8.0 (`v8.0.5.1-test-r3.log`); pass with the fix.

### R13. Smaller compatible clean-ups
- **Where:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12`, `where(notebooks: @notebook)`.
  - **Fix:** `where(notebook: @notebook)` (7.1 deprecates using the plural name).
- **Where:** `/home/user/workspace/repo/app/models/note.rb:61`, `set(wait_until: reminder_epoch)`.
  - **Fix:** `Time.at(reminder_epoch)` (7.1 deprecates passing a number).
- **Where:** `/home/user/workspace/repo/app/models/notebook.rb:40`.
  - **Fix:** `Date.iso8601(day.to_s)`. This guards against the 7.1 date-decoding default; the original code raises `TypeError` with that default on [EXEC, `v8.1.0-ld81-activity-original.log`].
- **All work on 7.0.**

### Per-version edits (do not work on 7.0; make them in the bump commit)
- **V1 (7.1+):** `/home/user/workspace/repo/app/models/note.rb:12`, change to `serialize :tags, coder: JSON`. Old form deprecated in 7.1, removed in 7.2.
  - **Do not do this on 7.0.** On 7.0 the `coder:` keyword is silently ignored and tags are written as YAML (`"---\n- a\n"`) [EXEC, runner in the bridge copy].
- **V2 (7.1+):** `/home/user/workspace/repo/config/environments/test.rb:31`, change to `show_exceptions = :none`.
  - From 7.2, `false` means "show exceptions" [SRC, `actionpack-7.2.4 exception_wrapper.rb:182-190`]. The `assert_raises(ActiveRecord::RecordNotFound)` tests would then fail.
  - On 7.0, `:none` would be treated as true.
- **V3 (7.1+):** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`, change `:exponentially_longer` to `:polynomially_longer`. Removed in 7.2 [SRC]; the new name does not exist in 7.0.
- **V4 (8.1.0 only):** add `gem "json", "~> 2.7"` to the Gemfile.
  - Rails 8.1.0's JSON decoding passes options in a way `json 3.x` rejects. Every request with a session cookie raised `ArgumentError` (40 errors) [EXEC, `v8.1.0-test-r3.log`].
  - **Alternative:** Rails 8.1.4 fixes this [SRC, `activesupport-8.1.4/lib/active_support/json/decoding.rb:24-27`] and includes later security patches. I did not test 8.1.4 [PROPOSED].
- **8.0 deprecation:** with `load_defaults 7.0`, 8.0 warns about `to_time_preserves_timezone` at boot. After R11 it is safe to set `config.active_support.to_time_preserves_timezone = :zone` in the 8.0 step, then remove it in the 8.1 step (the setting is deprecated in 8.1).

## 4. Optional new defaults (keep `load_defaults 7.0` during the upgrade)

**What happens with `load_defaults 8.1` [EXEC, `v8.1.0-ld81-test*.log`]:**
- With all fixes applied, every test errors: `serialize :preferences` (`/home/user/workspace/repo/app/models/notebook.rb:7`) raises "missing keyword: :coder".
- After adding `coder: YAML`, two errors remain:
  - `ActiveRecord::ReadonlyAttributeError: slug`. The settings form posts `slug` back (`/home/user/workspace/repo/app/controllers/notebooks_controller.rb:40`, `/home/user/workspace/repo/app/views/notebooks/_form.html.erb:13`), and `raise_on_assign_to_attr_readonly` raises even when the value is unchanged.
    - **Before adopting:** stop permitting or posting `slug` on update.
  - `Cache expiration time is invalid, cannot be negative` from `/home/user/workspace/repo/app/views/exports/_export.html.erb:26` (`raise_on_invalid_cache_expiration_time`). That is a 500 on the exports page for any expired export.
    - **Before adopting:** skip the cache block for expired exports, or never pass a negative `expires_in`.
- **This already affects 7.1+ under `load_defaults 7.0`.** A negative `expires_in` is logged as an error and the entry is stored **with no expiry** [EXEC, `cross-cache.log`]. The content shown ("Expired") is still correct, but every expired export logs an error, and the error reporter receives it if one is configured.

**Defaults that change stored data and must wait until rollback is no longer possible:**
- **`cache_format_version = 7.1`:** 7.0 reading a 7.1-format entry raises `TypeError: incompatible marshal file format` instead of treating it as a miss [EXEC, `cross-cache.log`].
  - Production uses the default file cache under each host's `tmp/cache`, because no `cache_store` is set in `production.rb`. On rollback, clear `tmp/cache` (`Rails.cache.clear`).
- **`message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata = true`:**
  - 8.1 then writes rich-text attachment signatures in a format 7.0 cannot read. 7.0 returned **HTTP 500** on the note page (`undefined method 'unpack1' for nil`) [EXEC, `cross-sgid-render-r2.log`, `mixed-server-70.log`].
  - With `load_defaults 7.0`, 8.1 writes the old format and 7.0 renders the page [EXEC, note 6].
  - Treat these two settings as one-way: adopt them only once 7.0/7.1 rollback is ruled out.
- **`postgresql_adapter_decode_dates`:** safe after the `day.to_s` fix (R13) [EXEC].
- **`action_text.sanitizer_vendor` (HTML5):** tests pass with it [EXEC]. Still check stored rich text renders the same [PROPOSED]: render a sample of existing `action_text_rich_texts.body` rows with both sanitizers and diff the output.
- **`enqueue_after_transaction_commit`:** keep it **off**. It is `:never` in 7.2 and `false` in 8.x under `load_defaults 7.0` [SRC].
  - Turning it on for the Sidekiq adapter would defer jobs until commit. That breaks the documented "failed enqueue rolls back" behaviour in `/home/user/workspace/repo/app/models/citation.rb:14-23` and `/home/user/workspace/repo/app/models/note.rb:56-69`.
- **Image variant warning:** 8.x warns at boot that the `image_processing` gem is missing, because the vips variant processor is selected and no variants are used [EXEC, `sidekiq-81-worker.log`]. Optionally set `config.active_storage.variant_processor = :disabled`.

## 5. Mixed versions during rollout, and rollback

**Checked in production mode: 7.0 with fixes and 8.1 with fixes, sharing one database and one Redis [EXEC]:**
- **Sessions and flash:** a session cookie created on 7.0 works on 8.1 and the reverse; sign-in, page view, notebook update and flash messages all worked (`cross-70-to-81.log`, `cross-81-to-70.log`). Cookies are already JSON (`load_defaults 7.0` sets `cookies_serializer = :json`).
- **Notebook preferences:** written as YAML, readable by both versions.
- **Queued jobs:** jobs enqueued by either version load on the other, except the unpatched BigDecimal case (R10).
  - An 8.1 worker using Sidekiq 6.5.12 processed jobs enqueued by 7.0: digest and reminder emails were delivered, the export completed, and the citation job retried (`sidekiq-81-worker.log`).
  - Native `ExportJob` payloads are plain Sidekiq jobs and do not change with Rails.
- **Already-stored data:** rich text, Active Storage blobs and attachment links written by 7.0 render on 8.1.

**Rollback hazards:**
- **Schema file:** running migrations on 7.1+ rewrites `db/schema.rb` as `ActiveRecord::Schema[7.x/8.x]`. 8.0 also writes `pg_catalog.plpgsql`, and 8.1 sorts columns alphabetically (`logs/schema-dump-*.diff`). 7.0 fails to load a `[8.1]` schema with "Unknown migration version" [EXEC].
  - No migration is needed for this upgrade. If one is generated, keep the 7.0 schema around for rollback.
- **Unpatched code:** if any of R3, R6, R10 or R11 is missing when 7.1+ workers start, jobs already in Sidekiq's retry and scheduled sets can fail or behave differently. Reminders are scheduled up to years ahead.
  - Ship R1–R13 on 7.0 first, drain or check `queue:default`, `retry` and `schedule`, then upgrade.
- **Development secret file:** the development secret moves from `tmp/development_secret.txt` to `tmp/local_secret.txt` in 7.1+, which resets local sessions [SRC]. Production is not affected.

## 6. Order of steps

1. On 7.0.8.7, ship R1–R13 and the doc updates. Bridge result: 46 runs, 0 failures, 0 deprecations.
2. On 7.1.6, add V1, V2 and V3. Optionally remove the `concurrent-ruby` pin, which was only there for a 7.0 Logger bug.
3. On 7.2.4, run the full suite and check for deprecation warnings (none in my run). Do not add the `enqueue_after_transaction_commit` setting.
4. On 8.0.5.1, set `to_time_preserves_timezone = :zone` after R11.
5. On 8.1.0, add V4 (or choose 8.1.4) and remove the `to_time_preserves_timezone` setting. The Sidekiq adapter deprecation remains (§7).
6. At each step, run `bin/rails zeitwerk:check` (passes on 8.1 [EXEC]), `bin/rails test`, and `bin/rails test:system` [PROPOSED].

## 7. Not verified and open questions

- **Trix in the browser:**
  - The layout loads the vendored `trix-1.3.5.js` (`/home/user/workspace/repo/app/views/layouts/application.html.erb:13`) alongside the gem's `actiontext.js`.
  - In 8.1, the new `action_text-trix 2.1.19` gem only adds `trix.js` to asset precompilation; neither the gem's `actiontext.js` nor the app imports it, so it should not load.
  - Not checked in a browser [PROPOSED]: editing, attachments and saving existing bodies in a system test. Also make sure Trix 2 is not loaded alongside 1.3.5.
- **Sidekiq:** Rails 8.1 warns its built-in adapter goes away in 8.2 [EXEC]. Moving to Sidekiq 7.3.3 or later is a separate upgrade with its own risks:
  - The Redis client changes, so the `Redis::BaseError` rescue in `/home/user/workspace/repo/app/models/notebook.rb:28` would no longer catch its errors.
  - `sadd` returns an integer, so the duplicate check in `/home/user/workspace/repo/app/models/user.rb:38` would always pass.
  - Strict argument checking would reject the symbol key in `/home/user/workspace/repo/app/models/notebook.rb:26`.
  - Rack 3 would break `bin/citation-provider`, which uses `rack/handler/puma`. That script works on 8.1 with Rack 2 [EXEC].
- **Production setup I did not test:** the real cache store, how many hosts run, the real secrets and credentials, and the deployment order of web servers and Sidekiq workers.
- **Ruby 3.4:** `require "csv"` will need `gem "csv"` in the Gemfile. That is not part of the Rails upgrade.
- **Untested items:** R6's partial commit on 7.2 and R7's empty receipt column are from the source and deprecation messages, not from running the original code on 7.2. Also unexplained: why 7.0 reports 325 assertions and 7.1+ report 340.

**Where things are:**
- Patches: `/tmp/upgrade-exp/patches/`
- Logs: `/tmp/upgrade-exp/logs/`
- Scripts: `/tmp/upgrade-exp/scripts/`
- Disposable copies: `/tmp/upgrade-exp/{bridge-7.0.8.7,v7.1.6,v7.2.4,v8.0.5.1,v8.1.0,v8.1.0-ld81}`

The servers, Sidekiq, Postgres and Redis used for the experiments have all been stopped; their data stays in `/tmp/upgrade-exp/pgdata` and `/tmp/upgrade-exp/redis`.

---

**Notes on the plan:**

- **Repo unchanged:** `git status` on `/home/user/workspace/repo` shows no changes, and it is still on commit `ab732f5`. The log and patch folders under `/tmp/upgrade-exp/` exist as the plan describes. All experiments ran in copies under `/tmp/upgrade-exp`, using their own Postgres (port 55432) and Redis (port 56379).
- **Small inconsistency in the plan:** step 1 of the suggested order in §1 says to ship R1–R11 on 7.0, but §5 and §6 say R1–R13. R12 and R13 also work on 7.0, so ship all of R1–R13 first.
- **`json` pin vs. Rails 8.1.4:** the `json ~> 2.7` pin (V4) is only needed because the target is exactly 8.1.0. If you can choose a later 8.1 patch release, 8.1.4 is worth testing instead. The source suggests it fixes the problem and it includes later security fixes, but it was not tested.
- **Still not run:** the browser tests (Chrome is not installed), the direct test of the partial import commit on 7.2 (R6), and a check that existing rich text renders the same under the new sanitizer.

---

**My notes:**

- **Repository still unchanged:** I checked myself. The working tree is clean, you're still on `ab732f5` on `main`, and `/tmp/upgrade-exp/` holds the patches and 61 log files.
- **Decisions for you:**
  - **8.1.0 or 8.1.4:** you asked for exactly 8.1.0, which also needs the `json` pin (V4). The planner thinks 8.1.4 avoids that pin and has later security fixes, but it wasn't tested.
  - **One step or several:** the plan suggests first shipping the fixes that work on 7.0.8.7 (R1–R13), then going through each version in turn. You could also jump straight to 8.1.0 in one branch, but the queued-job and rollback problems in §5 are why it recommends staging.

If you want, I can start by applying R1–R13 on a branch from `main` and running the test suite.
