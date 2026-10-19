Here is the planner's plan, unedited. I did not re-run any of its experiments.

# Upgrade plan: rails 7.0.8.7 to 8.1.0, Margin Notes

The upgrade is feasible, but it is not a version bump. On 8.1.0 the app fails to boot until four things are fixed, and four more behaviors change without any error. Test coverage caught only part of them.

## How this was verified

- **Disposable setup:** copies are in `/tmp/exp/app70` (7.0.8.7 baseline), `/tmp/exp/app81` (8.1.0) and `/tmp/exp/app814` (8.1.4).
- **Isolated resources:** a private Postgres 15 cluster in `/tmp/exp/pg` (port 5544) and a private Redis on port 6390. Gems are installed under `/tmp/exp/bundle81` and `/tmp/exp/bundle814`.
- **Environment scripts:** `/tmp/exp/scripts/env70.sh` and `/tmp/exp/scripts/env81.sh`.
- **Commands:**
  - `bundle lock --update rails` and `bundle install` with `rails "8.1.0"` in the Gemfile.
  - `bin/rails test` (46 tests).
  - Side-by-side `bin/rails runner` scripts on both versions.
  - Dev servers on ports 3070 and 3081 against a shared database, plus real Sidekiq processes.
  - A Chromium check through agent-browser.
- **Resolved set for 8.1.0:** `rails 8.1.0`, `rack 2.2.24` (unchanged), `sidekiq 6.5.12`, `redis 4.8.1`, `puma 5.6.9`, `bigdecimal 4.1.3`, `json 3.0.2`, `minitest 5.27.0`, `action_text-trix 2.1.19`, plus new `rackup`, `rack-session`, `webrick`, `drb`, `securerandom`, `uri`, `useragent`.
- **7.0.8.7 results:** 46/46 pass, both for the untouched baseline and with the preparatory changes applied.
- **8.1.0 results:**
  - 46/46 pass once the full fix set below is applied, with no deprecation output. The same set also passed on 8.1.4.
  - Unfixed, the app does not boot. After the boot fixes, 45 of 46 tests errored or failed.

## Required changes

Each change lists where it breaks, the fix, and whether it also works on 7.0.8.7.

### A. Boot or load failures (confirmed by execution)

| # | Affected code | Failure on 8.1.0 | Recommendation | Works on 7.0? |
|---|---|---|---|---|
| A1 | `config/initializers/action_text.rb` | `allowed_tags` is `nil` by default, so `+=` raises `NoMethodError` and the app cannot boot. | Assign an explicit list. It must include `ActionText::Attachment.tag_name`, `figure` and `figcaption`, because an explicit list replaces the default: `allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]` | Yes. |
| A2 | `app/models/note.rb:10`, `enum status: {...}, _prefix: true` | `ArgumentError`. | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes. |
| A3 | `app/models/note.rb:12`, `serialize :tags, JSON` | `ArgumentError`. | `serialize :tags, coder: JSON` | **No, and it is dangerous.** On 7.0.8.7 the keyword form is silently accepted but the column falls back to the YAML coder. Land it with the framework bump, or at 7.1.x. Stored JSON text is unchanged across versions. |
| A4 | `config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"` | Multi-path `match` raises, so no routes load. | Split into two `get` lines. | Yes. `bin/rails routes` output is identical, including route names. |
| A5 | `Note` `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`) | `ArgumentError`: aliasing a non-attribute is rejected. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. | Yes. |
| A6 | `Rails.application.secrets` in `app/models/citation/provider.rb` and `test/controllers/citation_enrichments_controller_test.rb` (lines 45, 117-122) | `NoMethodError`: `config/secrets.yml` support was removed (deprecated in 7.1, removed in 7.2). | Move the data to `config/citation_provider.yml` (environment as top-level key, same ERB `.to_json` lines). Add `config.x.citation_provider = config_for(:citation_provider)` in `config/application.rb`. Read `Rails.configuration.x.citation_provider` in `Provider` and the tests. Delete `config/secrets.yml`. | Yes. |

For A6, check where `secret_key_base` comes from in production. The in-repo `secrets.yml` holds no `secret_key_base`, so it should come from credentials or `ENV`. That is unverified. If any environment relied on `secrets.yml` for it, sessions and signed ids would break.

Update these docs and comments:
- `ARCHITECTURE.md` (lines 79-80)
- `CONTRIBUTING.md` (38)
- the header comment in `app/models/citation/provider.rb`
- the comment in `bin/citation-provider`

### B. Silent behavior changes and data corruption (found by comparing versions)

**B1. `Import#apply` now commits a partial import. This is the most serious change.**
- **Affected code:** `app/models/import.rb`, `apply`, which does `return false unless row.note.save` inside `transaction do`.
- **What changes:** from Rails 8.0 onward, leaving a transaction with `return` commits instead of rolling back. 7.1 keeps the old behavior through `commit_transaction_on_non_local_return = false`. 7.2 deprecates that setting, and 8.0+ has none.
- **Consequence:** an import with one invalid row now saves the `Import` row and the valid notes before it, so "or saves nothing" no longer holds.
- **Evidence:** `ImportsControllerTest` "applying them saves nothing" went from counts `[0,3,0,1]` to `[1,4,1,2]`.
- **Recommendation:** use `raise ActiveRecord::Rollback unless row.note.save` inside the block, and `true` at the end with `|| false` after the block.
- **Works on 7.0:** yes, and the suite passes.

**B2. `Import#receipt` writes blank DOIs.**
- **Affected code:** `citation[:id]`.
- **What changes:** `citation` has primary key `doi`. On 7.0, `[:id]` returned the pk. On 8.1 it returns `nil`, so the receipt CSV has an empty `doi` column.
- **Evidence:** the output was `On idleness,` where `On idleness,10.1000/Essays.1` was expected.
- **Recommendation:** `citation&.doi`.
- **Works on 7.0:** yes.

**B3. The import preview silently drops annotations.**
- **Affected code:** `app/views/imports/preview.html.erb:22`, `@import.annotations.stringify_keys`.
- **What changes:** `HashWithIndifferentAccess#stringify_keys` now converts the Integer line keys to Strings, so the later `annotations[row.line]` lookup with an Integer misses.
- **Evidence:** confirmed directly in `/tmp/exp/scripts/hwia.rb`.
- **Recommendation:** drop `.stringify_keys`.
- **Works on 7.0:** yes.

**B4. The digest changes from the UTC day to the reader's local day.**
- **Affected code:** `DigestMailer`, `User#request_digest`, `DigestJob`.
- **What changes:** Active Job 7.1+ stores the `TimeWithZone` zone in the job payload and deserializes it with that zone. On 7.0 the job arrived in UTC.
- **Consequence:** `@date` and `all_day` become the reader's local day. This breaks the documented contract in `ARCHITECTURE.md:169-174` and the form hint "Daily digests follow the UTC day".
- **Evidence:** the digest test failed with "October 04" where "October 05" was expected.
- **Recommendation:** in the mailer, use `requested_at = params[:requested_at].utc`, then `to_date` and `all_day`. This does not depend on payload format, so it is safe for mixed fleets.
- **Works on 7.0:** yes.

**B4b. A `BigDecimal` job argument breaks rollback and mixed-version workers.**
- **Payloads:** the 7.0 payload carries completion as the plain string `"1.0"`. The 8.1 payload carries `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",...}`, plus `time_zone`, plus `scheduled_at`.
- **Cross-version result:** a 7.0.8.7 worker given the 8.1 payload raised `ActiveJob::DeserializationError: Serializer ...BigDecimalSerializer is not known`. That job would retry and then go dead.
- **Reverse direction:** an 8.1 worker handles 7.0 payloads, including a `NoteReminderJob` that was already scheduled.
- **Recommendation:** pass `reading_completion.to_s("F")`. The mailer already calls `BigDecimal(params[:completion])`. This gives the same `"1.0"` format on both versions and removes Sidekiq's "not native JSON" warning.
- **Evidence:** with this change, a real 7.0.8.7 Sidekiq process ran a digest job enqueued by 8.1. The digest value is the same under `bigdecimal` 3.1.5 and 4.1.3 for the ratios tried.
- **Works on 7.0:** yes.

**B5. The reminder preview's UTC offset changes.**
- **Affected code:** `Note#next_day_reminder_at`, `reminder_at.to_time + 86_400`.
- **What changes:** in 8.1, `TimeWithZone#to_time` always returns a time in the zone. The `to_time_preserves_timezone` config is deprecated and ignored.
- **Consequence:** the "24 hours later" preview shows `2026-11-01T08:00:00-05:00` where it used to show `09:00-04:00`. The instant, and so the scheduled epoch, is unchanged. The code comment and the test both promise the old offset.
- **Recommendation:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`.
- **Works on 7.0:** yes.

**B6. `Integer` passed to `wait_until`.**
- **Affected code:** `Note#schedule_reminder`, `NoteReminderJob.set(wait_until: reminder_epoch)`.
- **What changes:** 8.1 raises `undefined method 'utc' for Integer`, so reminders cannot be scheduled.
- **Recommendation:** `wait_until: Time.at(reminder_epoch)`.
- **Works on 7.0:** yes.

**B7. Latent failure on the first retry.**
- **Affected code:** `CitationEnrichmentJob`, `retry_on ... wait: :exponentially_longer`.
- **What changes:** the symbol was removed. Nothing fails at class load. It raises `RuntimeError: Couldn't determine a delay` when the provider is unavailable and the job first retries.
- **Recommendation on 8.1:** `:polynomially_longer`. The formula and jitter are identical.
- **On 7.0:** `:polynomially_longer` does not exist. A bridge that works on both is `wait: ->(executions) { executions**4 + 2 }`, which loses the jitter. I loaded this form on 7.0 and the suite passed, but I did not run a retry through it.

**B8. `Export#generate` crashes.**
- **Affected code:** `finish(fragments.sum)`.
- **What changes:** Active Support's string `sum` is gone, giving `TypeError: String can't be coerced into Integer`.
- **Recommendation:** `fragments.join`.
- **Works on 7.0:** yes.

**B9. A `where` key that was singularized now raises.**
- **Affected code:** `NotesController#index`, `@notes.where(notebooks: @notebook)`.
- **What changes:** 7.0 singularized the key to the `notebook` association. 8.1 raises `PG::UndefinedColumn: notes.notebooks`.
- **Recommendation:** `where(notebook: @notebook)`.
- **Works on 7.0:** yes.

**B10. `form_with(model: nil, ...)` raises.**
- **Affected code:** `app/views/notes/index.html.erb:12`. 8.1 raises "Passed nil to the :model argument".
- **Recommendation:** remove `model: nil`.
- **Works on 7.0:** yes.

**B11. A test-environment setting that fails silently.**
- **Affected code:** `config/environments/test.rb`, `show_exceptions = false`.
- **What changes:** 8.1 treats `false` as "show exceptions". The suite does not error. Request tests that assert `assert_raises(RecordNotFound)` stop raising and get a 404 or 500 instead.
- **Recommendation:** `config.action_dispatch.show_exceptions = :none`.
- **Works on 7.0:** no. 7.0 treats the truthy symbol as "show". `:none` is accepted from 7.1, where `false` is deprecated, so this belongs at 7.1 or later.

## Dependency and Gemfile findings

- **`json` pin needed for exactly 8.1.0.** The resolver picks `json 3.0.2`, which breaks `ActiveSupport::JSON.decode` in 8.1.0. Session decryption fails with `ArgumentError (given 2, expected 1)`. With `json "< 3"` (resolved 2.21.2) everything passed. Rails 8.1.4 with `json 3.0.2` also passed all 46 tests. If the version is flexible, I recommend the latest 8.1.x patch (8.1.4 exists) instead of pinning `json`.
- **Rack stays 2.2.24.** Rails 8.1 permits Rack 2.2.4+, so Sidekiq 6.5.12 (`rack ~> 2.0`) and `bin/citation-provider` (`Rack::Handler::Puma`) need no change. A Rack 3 move is a separate project that also needs a Sidekiq upgrade.
- **Sidekiq 6.5.12, Redis 4.8.1 and Puma 5.6.9 work with 8.1.0.** A real Sidekiq process on 8.1.0 handled Active Job, native `ExportJob` and Active Storage jobs. The ActionCable Redis adapter broadcast succeeded in production mode.
- **Optional pin cleanups.** The `concurrent-ruby 1.3.4` pin existed for 7.0 and can be dropped. The `minitest ~> 5.25` pin should stay, and its comment in `Gemfile` and `TESTING.md:54` needs rewording.
- **Doc and comment updates.** These state 7.0 facts:
  - `README.md:7`
  - `ARCHITECTURE.md:169-174`, `188`, `207-211`
  - `app/views/layouts/application.html.erb:10-11`
  - `docs/references/fizzy.md:20-26`
  - the Rails 7 guide links
  - `ARCHITECTURE.md:84` says "exponentially longer"

## Rollout and rollback risks

These are verified unless marked otherwise.

- **Sessions, CSRF tokens, signed ids, GlobalID/sgid and Action Text attachment sgids interoperate in both directions**, provided `secret_key_base` is identical and `load_defaults 7.0` is kept. I tested live cookies and CSRF tokens between ports 3070 and 3081, and sgids and `message_verifier` in production mode.
  - Dev and test secrets are not shared. 7.0 uses `tmp/development_secret.txt`. 7.1+ uses `tmp/local_secret.txt` and also honors `ENV["SECRET_KEY_BASE"]` in dev. This only affected my experiment setup.
- **Stored data formats are unchanged.** `tags` is JSON text, `preferences` is YAML, and `settings` is jsonb. Raw column values match across versions, and each version reads the other's rows.
- **Queued 7.0 jobs run on 8.1.** The queued digest, reminder and export jobs ran on an 8.1 worker, including the reminder scheduled for a future date.
- **Fix the `BigDecimal` argument before any mixed-fleet period.** Otherwise 8.1-enqueued digest jobs die on 7.0 workers (B4b).
- **Fix the digest day in the mailer first.** In a mixed fleet without it, the digest date depends on which worker picks up the job, so one user could get the local day on one and the UTC day on another.
- **New time zone name.** 8.1 adds the zone name `"Asuncion"`. A user who saves it on 8.1 would fail the `User` inclusion validation on 7.0, and `Time.find_zone!` would raise. This matters only on rollback or in a mixed fleet.
- **Schema churn.** `db:schema:dump` on 8.1 changes the header to `Schema[8.1]` and `enable_extension "pg_catalog.plpgsql"`, and sorts columns alphabetically. Defer committing the regenerated `db/schema.rb`, because rolling back with it risks failing to load on 7.0 (inferred from source, not run).
- **Stored rich text re-normalization.** In the 8.1 parser, `&nbsp;` is kept as an entity and `<table>` gets a `<tbody>`. Plain-text and rendered output were identical for my 12 samples. This only affects bodies re-saved after the upgrade.
- **Action Text sanitizer.** The allowed attribute list gains `content` on 8.1. Review that if you care about the exact allowlist.

## Optional default adoption (not required)

None of this needs to happen for the upgrade. Keep `config.load_defaults 7.0`, as CLAUDE.md requires. It preserves cookie and message serialization, the HTML4 sanitizer and JSON column serializers. Moving it to 7.1+ would change several behaviors together:

- **Job enqueue timing.** With 7.2+ defaults, `enqueue_after_transaction_commit` changes when jobs are queued. `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue under a row lock.
- **Serializer and sanitizer formats.** The message serializer, the HTML5 sanitizer and the cache format would all move.
- **Schema output.** `Schema[8.1]` output is already driven by the Rails version, not by `load_defaults`.

Adopt these one at a time, each with its own test.

## Recommended sequence

1. On 7.0.8.7, apply the preparatory set: A1, A2, A4, A5, A6, B1, B2, B3, B4 (mailer UTC), B4b (`to_s("F")`), B5, B6, B8, B9, B10. Each was verified against the 46-test suite on 7.0.8.7, but several need new tests (see below). Deploy it.
2. Bump to 8.1 in one step. The Gemfile edit is `rails "8.1.0"` plus `json "< 3"`, or a newer 8.1.x patch without the `json` pin. Apply A3, B7 (`:polynomially_longer`) and B11 (`:none`) in the same change, because they cannot run on 7.0.
3. Alternatively, step through 7.1, 7.2 and 8.0 to surface deprecation warnings. The 7.1 step flags secrets, `serialize`, `:exponentially_longer` and `show_exceptions = false`. The 7.2 step flags the transaction `return` behavior. I only read those deprecations in gem source for 7.1.6, 7.2.4 and 8.0.5.1. I did not run the intermediate versions.

## Tests to add

The suite did not catch these without a deliberate fixture.

- **Import:** a preview that asserts the annotation appears, and a receipt that asserts the DOI column. The existing import test caught B3 only because of an annotation text in the fixture.
- **Atomic import:** it already exists and caught B1.
- **Digest:** assert the job payload carries a plain string, and assert the digest date is the UTC day for a reader in a zone far from UTC.
- **Retry path:** drive the `retry_on` path in the citation job so B7 shows up in CI.
- **`show_exceptions`:** the existing `assert_raises` tests are enough to catch B11 once you look at why they fail.

## Not verified

- **No production-like deployment.** Production boot (eager load) and the production Redis ActionCable adapter worked in the disposable environment. Mail delivery and real hosting are not configured in the repo.
- **System tests.** `test/system/` is empty. The browser check on 8.1.0 covered only that vendored Trix 1.3.5 plus Action Text 8.1 JS initialises and a direct upload returns an sgid. The editor UI, attachment rendering in a browser and Turbo behavior were not tested.
- **`secret_key_base` source in production.** See A6.
- **Intermediate versions** (7.1, 7.2, 8.0) were read, not run.
- **Ruby 3.4 and CSV.** `require "csv"` in `app/models/import.rb` warns on Ruby 3.3 and will need the `csv` gem on 3.4. The same warning appears on 7.0.8.7, so it is not an upgrade regression.
- **`bin/citation-provider`** ran on 8.1 with Rack 2. It would break on Rack 3 (`Rack::Handler::Puma`).
- **Redis `sadd` return type.** `request_digest` depends on redis-rb 4.x returning a boolean. Nothing in this upgrade changes it, but a future Sidekiq 7 or redis 5 move would.
- **Sidekiq 6.5 strict args.** The symbol-keyed hash passed to `ExportJob.perform_async` triggers a Sidekiq 6.5 warning that becomes an error in Sidekiq 7. Out of scope here.

## Files and logs

- Repo under review: `/home/user/workspace/repo`. Key files:
  - `/home/user/workspace/repo/Gemfile`
  - `/home/user/workspace/repo/config/application.rb`
  - `/home/user/workspace/repo/config/environments/test.rb`
  - `/home/user/workspace/repo/config/routes.rb`
  - `/home/user/workspace/repo/config/initializers/action_text.rb`
  - `/home/user/workspace/repo/config/secrets.yml`
  - `/home/user/workspace/repo/app/models/note.rb`
  - `/home/user/workspace/repo/app/models/import.rb`
  - `/home/user/workspace/repo/app/models/export.rb`
  - `/home/user/workspace/repo/app/models/user.rb`
  - `/home/user/workspace/repo/app/models/citation/provider.rb`
  - `/home/user/workspace/repo/app/mailers/digest_mailer.rb`
  - `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb`
  - `/home/user/workspace/repo/app/controllers/notes_controller.rb`
  - `/home/user/workspace/repo/app/views/notes/index.html.erb`
  - `/home/user/workspace/repo/app/views/imports/preview.html.erb`
  - `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb`
- Experiment copies and fix scripts: `/tmp/exp/app70`, `/tmp/exp/app81`, `/tmp/exp/app814`, `/tmp/exp/scripts/apply_fixes.py`, `/tmp/exp/scripts/apply_fixes2.py`.
- Comparison outputs: `/tmp/exp/c1_70.json`, `/tmp/exp/c1_81.json`, `/tmp/exp/c2_70.json`, `/tmp/exp/c2_81.json`, `/tmp/exp/p70.json`, `/tmp/exp/p81.json`, `/tmp/exp/p81b.json`, `/tmp/exp/routes70.txt`, `/tmp/exp/routes81.txt`.
- Logs: `/tmp/exp/test81_full.log`, `/tmp/exp/sidekiq81.log`, `/tmp/exp/sidekiq70.log`, `/tmp/exp/server70.log`, `/tmp/exp/server81.log`, `/tmp/exp/provider81.log`.
- Gem sources read for intermediate versions: `/tmp/exp/gems/7.1.6`, `7.2.4`, `8.0.5.1`.

The experiment Postgres and Redis were shut down at the end. The `/tmp/exp` directories were left in place.

---

Commentary from me: the working application was not modified, and I did not implement anything. The subagent's usage line shows only 2 tool uses, which looks low for the experiments it describes. Treat the "executed" claims as the planner's own report and re-run a few of them before relying on them. B1, the silent partial import, is the one to check first.
