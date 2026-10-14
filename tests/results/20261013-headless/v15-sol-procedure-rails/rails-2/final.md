# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is feasible, but 8.1.0 does not boot without changes. With the 21 repairs below, every check passes in an 8.1.0 lab: bundle, boot, eager-load, routes, `db:prepare` and the tests (46 runs, 340 assertions, 0 failures, no deprecation warnings). Run log: `/tmp/gem-upgrade-20261014-18558-2mtsy2/runs/*final-*`. Production boot and `assets:precompile` also pass. Six of the issues would not appear as boot or test failures: partial CSV imports, missing DOIs in import receipts, digests covering the wrong day, lost import annotations, a Trix stylesheet swap, and queued jobs that 7.0 workers can't read.

The real checkout is unchanged: `git status` is clean, and all 180 source files match their recorded hashes.

## Required repairs (full diff: `/home/user/planner-run/evidence-rails/repairs.diff`)
"7.0-safe" means the repair also passed on 7.0.8.7 in lab B3, so it can ship before the bump.

| ID | Where | Failure without the repair (observed) | Repair | 7.0-safe |
|---|---|---|---|---|
| F01 | `config/initializers/action_text.rb:3` | App won't boot: `undefined method '+' for nil` | Build `allowed_tags` from the active sanitizer in `after_initialize` + `on_load(:action_view)`, adding details/summary | yes |
| F02 | `note.rb:10` | `wrong number of arguments (given 0, expected 1..2)` | `enum :status, {...}, prefix: true` | yes |
| F03 | `routes.rb:18` | Routes fail: `Wrong number of arguments (expect 1, got 2)` | Two `get` routes `as: :notes` / `as: :journal` | yes |
| F04 | `note.rb:12` | `given 2, expected 1` | `serialize :tags, coder: JSON` | **no**: on 7.0 it silently writes YAML |
| F05 | `note.rb:14` | `` Note model aliases `color`, but `color` is not an attribute `` | `alias_method` for the reader and the writer | yes |
| F06 | `Gemfile` | Every request with a session cookie returns 500 `ArgumentError (given 2, expected 1)` (json 3.1.0 vs `active_support/json/decoding.rb:24`) | `gem "json", "~> 2.7"`, which resolves 2.21.2 | yes |
| F07 | `environments/test.rb:31` | Tests asserting `RecordNotFound` / `CannotConnectError` stop raising | `show_exceptions = :none` | **no** |
| F08 | `citation/provider.rb:13`, `secrets.yml`, enrichment test | `undefined method 'secrets'` | `config/citation_provider.yml` + `config.x.citation_provider = config_for(...)` | yes |
| F09 | `citation_enrichment_job.rb:7` | `Couldn't determine a delay based on :exponentially_longer`; the citation stays pending forever | `wait: :polynomially_longer` | **no** |
| F10 | `notes/index.html.erb:12` | `/notes` 500: `Passed nil to the :model argument` | Drop `model: nil` | yes |
| F11 | `notes_controller.rb:12` | `column notes.notebooks does not exist` | `where(notebook: @notebook)` | yes |
| F12 | `note.rb:62` | `undefined method 'utc' for an instance of Integer` | `wait_until: Time.at(reminder_epoch)` | yes |
| F13 | `note.rb:44` | "Remind me a day later" gives `08:00-05:00` instead of `09:00-04:00` across DST | `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` | yes |
| F14 | `export.rb:42` | Every export job fails: `String can't be coerced into Integer` | `fragments.join` | yes |
| F15 | `imports/preview.html.erb:22` | Preview silently drops all annotations | Drop `.stringify_keys` | yes |
| F16 | `import.rb` `apply` | A failing CSV now **commits** the import, one note and one citation (counts went `[0,7,0]` → `[1,8,1]`) | Explicit `raise ActiveRecord::Rollback` | yes |
| F17 | `import.rb:69` | Receipt CSV loses every DOI | `citation&.doi` | yes |
| F18 | `digest_mailer.rb` | 8.1-queued digests cover the reader's local day ("October 04") instead of the UTC day | `requested_at.in_time_zone("UTC")` | yes |
| F20 | `assets/stylesheets/actiontext.css:6` | Compiled CSS switches to Trix 2.1.19 while the editor JS stays on vendored Trix 1.3.5 | Vendor the 7.0 `trix.css` as `vendor/assets/stylesheets/trix-1.3.css` and `require trix-1.3`; compiled CSS then matches 7.0 byte for byte | yes |

Rollout-only repairs:
- **F19:** `DigestJob.perform_later(..., reading_completion.to_s)`. Without it, 7.0 workers fail on 8.1-written jobs with `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. 7.0-safe.
- **F21, F22, F23:** notes only, covered in the rollout steps below.

## Optional defaults (`load_defaults` stays at 7.0)
Each default was set alone in a separate fork and the full suite run. Most needed no code change. Four break the app if adopted; their repairs are in `/home/user/planner-run/evidence-rails/optional-default-repairs.diff`, and all four pass the suite with and without their setting.

| Default | Breaks | Repair (7.0-safe?) |
|---|---|---|
| D10 `raise_on_invalid_cache_expiration_time` | Exports page 500s for expired exports: `cannot be negative: -60.0` | `expires_in: [.., 0].max` (yes). My first try, `cache_if`, changed tested behaviour and was dropped. |
| D15 `raise_on_assign_to_attr_readonly` | Notebook settings save fails: `ReadonlyAttributeError: slug` | Stop permitting `:slug` (yes) |
| D19 `default_column_serializer = nil` | App won't load (`missing keyword: :coder`) | `serialize :preferences, coder: YAML` (ship with or after the bump; 7.0 ignores the keyword, so stored text is unchanged) |
| D31 `postgresql_adapter_decode_dates` | Activity report `TypeError` | `Date.iso8601(day.to_s)` (yes) |

The other defaults:
- **d12/d13 (message serializers):** session cookies stay compatible in both directions with each set alone. Enable them one per deploy, and only once rollback to 7.0 is no longer possible.
- **d28 (`enqueue_after_transaction_commit`):** do not enable. In 8.1 the config key is gone and the effective value is false. Turning it on would break the models' "failed enqueue rolls back" behaviour.
- **Settings Rails removed:** d02, d08, d09, d22 and d33 are now forced, and their effects are covered by F11, F19, F16 and F13.
- **Everything else:** suite passes with each setting.

## Rollout order
1. **Deploy on 7.0 first:** the 7.0-safe repairs (F01–F03, F05, F06, F08, F10–F18, F19, F20), plus D10/D15/D31 if wanted. All pass the checks and probes on 7.0.8.7.
2. **Bump deploy:** Rails 8.1.0 together with F04, F07 and F09. Session cookies and queued Sidekiq payloads work in both directions between 7.0 and 8.1, so a rolling deploy is safe once F19 is in.
3. **Separate follow-up commit:** `bin/rails db:schema:dump` (F22). It rewrites 72 lines of `schema.rb` (column sorting, `Schema[8.1]` header). Keep the 7.0 version while rollback is possible.
4. **Developers:** rename `tmp/development_secret.txt` to `tmp/local_secret.txt` (F23).
5. **Later, one deploy each:** D19, then d12, then d13.
6. **Before Rails 8.2:** move to Sidekiq 7.3.3 or later, and make the ExportJob arguments string-keyed (F21). The built-in Sidekiq adapter still works on 8.1 but logs a deprecation.

**Rolling back:** revert the Gemfile together with `note.rb` (F04), `test.rb` (F07) and the job (F09). Tags JSON, settings jsonb and preferences YAML are stored identically by both versions (checked at the raw-column level).

## How each claim was established
- **Executed:** every finding above except F23 and parts of F20. Each was probed on the 7.0 baseline, on 8.1 with the repair, and on 8.1 without it, using unequal data and an unchanged control. Probes are in `/home/user/planner-run/probes/` (`p_models.rb`, `p_requests.rb`, `p_queue.rb`, `p_cookie.rb`, `p_jobs.rb`, `p_defaults.rb`, `p_fresh.rb`).
- **Cross-version checks:** queued jobs and session cookies were exchanged between a 7.0 and an 8.1 lab, through real Sidekiq/Redis payloads and production-mode cookies.
- **Source-based:** F18 first appears in activejob 7.0.9; F21's removal is scheduled for 8.2; F23.
- **Proposed only:**
  - Browser check of the Trix editor and attachments (F20). There are no system tests and no Chrome in this environment.
  - Signed blob ids across versions with d12/d13 enabled.
  - Enqueue-failure rollback with d28 enabled.

## Limits and problems
- **My mistake with two labs:** an early probe ran `FLUSHDB` and deleted the Redis ownership tokens of the first two labs, so `cleanup` refused them. Their PostgreSQL databases `gem_upgrade_6359f5e5d9a3d9923e230a6c` and `gem_upgrade_36d1beae13e2a272abb13bb4`, and Redis DBs 15 and 14 (leftover probe keys), still need manual removal. I did not recreate the tokens by hand.
- **Coverage:** I read the upgrade guides and release notes, scanned all 1,579 changelog titles, and read versioned source for the APIs involved. I did not read all 13,954 commits.
- **Security note outside this upgrade:** the vendored Trix 1.3.5 predates the Trix CVE fixes (e.g. CVE-2024-34341). Moving to Trix 2 is a product decision.
- **json constraint:** only 8.1.0 was evaluated, so the F06 constraint may not be needed on later 8.1.x releases.

The other four labs were cleaned up; their copies and logs are kept for evidence.

Files are in `/home/user/planner-run/evidence-rails/`:
- `review.json` (29 findings, 153 candidates, 310 check runs; passes `gem-upgrade-review check`)
- `repairs.diff`
- `optional-default-repairs.diff`

Labs:
- B2 (7.0 baseline): `/tmp/gem-upgrade-20261014-17347-5x7bf8`
- U2 (8.1 repaired): `/tmp/gem-upgrade-20261014-18558-2mtsy2`
- B3 (7.0 with the 7.0-safe repairs): `/tmp/gem-upgrade-20261014-20166-huqkeh`
- D (defaults fork): `/tmp/gem-upgrade-20261014-20609-nwmlqi`
- First baseline and first upgrade, superseded: `/tmp/gem-upgrade-20261014-9599-2s0am9`, `/tmp/gem-upgrade-20261014-10860-pkk0mj`

---

**Notes:**

- **Nothing is upgraded yet.** This is only a plan. Your repository is unchanged and still on Rails 7.0.8.7.
- **Leftover planning data:** the planner left two lab databases in PostgreSQL (`gem_upgrade_6359f5e5d9a3d9923e230a6c` and `gem_upgrade_36d1beae13e2a272abb13bb4`) and some test keys in Redis DBs 14 and 15. Before anyone drops them, check that nothing else uses those Redis DBs.
- **Suggested next step:** apply the 7.0-safe repairs from `repairs.diff` as a separate change while still on 7.0, then do the version bump in a second change with F04, F07 and F09. I can implement either step, or clean up the leftover databases, if you'd like.