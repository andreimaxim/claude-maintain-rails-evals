# concurrent-ruby 1.3.4 to 1.3.8: upgrade plan for Margin Notes

On its own, the bump stops the app from booting. One line added to `config/boot.rb` fixes that. With the fix in place on 1.3.8, boot, `db:prepare`, eager loading, routes and the full non-browser suite all pass (46 runs, 325 assertions, 0 failures). I did not change anything in `/home/user/workspace/repo`; all work ran in a separate copy, and the source hashes were confirmed unchanged afterwards.

Ruby 3.3.6 is a prerequisite here: the default `ruby` command had no version set, so I ran every step with `mise exec ruby@3.3.6`. concurrent-ruby 1.3.8 needs Ruby 2.3 or later, so the app's Ruby is fine. Only concurrent-ruby changes in `Gemfile.lock`, and no new framework defaults were collected.

## Required change

**F1. The app fails to boot because concurrent-ruby no longer loads Logger.**
- **Cause:** from 1.3.5 (changelog #1062, commit d7ce956dacd0), concurrent-ruby stops requiring `logger`. Rails 7.0.8.7's Active Support uses `::Logger` while loading and relied on concurrent-ruby to load it.
- **Error on the unchanged upgrade:** `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`. This affects every process that loads the app: web server, Sidekiq workers, `bin/rails` tasks and tests.
- **Fix:** in `config/boot.rb`, add `require "logger"` on the line directly after `require "bundler/setup"`. Then pin concurrent-ruby to "1.3.8" in the Gemfile and run `bundle update concurrent-ruby --conservative`.
  - Putting it after Bundler means the locked logger 1.7.0 is used.
  - I also tested putting it before Bundler (copy `v1_3_8_logger`). That passed too, but I don't recommend it: where logger 1.7.0 isn't installed system-wide, it could load Ruby's built-in 1.6.0 instead.
- **What ran:**
  - Unchanged 1.3.8: the boot stage exited 1 with the error above. The boot probe hit the same NameError.
  - Fixed 1.3.8: every stage passed. The probe found `Logger` defined after `boot.rb`, the Active Support logger at `:warn` printed only `"w-msg"`, and logger 1.7.0 was loaded.
  - The same `boot.rb` change on the current 1.3.4 also passes every stage and the probe, so it is safe to ship first.
- **Rollout:** ship the `boot.rb` line first, then the Gemfile and lockfile bump. To roll back, revert only the Gemfile and lockfile and keep the line. No stored data, cache entries or job payloads change format.
- **Unaffected:** `bin/citation-provider` doesn't load Active Support.

## Rollout risk (nothing to change)

**F2. Stricter locks and timers in 1.3.7–1.3.8 (commits 3fd493283ca5, 7e4d711bacf7, 4dc8de3f57d8).**
- **Changes:**
  - A `ReadWriteLock` released when it isn't held, or from the wrong thread, now raises `Concurrent::IllegalOperationError`. Before, it returned `true`.
  - A `TimerTask` restarted after shutdown no longer also runs the timer scheduled before shutdown.
- **What I saw:**
  - 1.3.4: stray release returned `true`; wrong-thread release returned `[true, false]`; the restarted timer ran 4 times.
  - 1.3.8: both releases raised `IllegalOperationError`; the timer ran 3 times.
  - A balanced lock/unlock, as Rails' view-cache code does, behaved the same on both versions (`[true,true]`).
- **Where it could matter:** the app itself never uses these. Rails uses them indirectly in its view template cache and in Action Cable's heartbeat for the production Redis connection.
- **Recommendation:** watch error tracking for `Concurrent::IllegalOperationError` after deploy. If it appears, revert the gem bump.
- One probe assertion (B) failed on 1.3.4 because the probe itself was wrong (`StringIO` not loaded). It is kept in `runs/baseline/007-probe.log`, and `boot_logger_probe.rb` replaces it.

I also checked these and found no application impact:
- Exception backtraces in concurrent-ruby's promises (changes only apply on Ruby 3.4+).
- A fix for loading the cached thread pool file twice.
- No longer creating a Fiber while loading the gem.
- Background pruning of idle threads in the thread pool. I didn't trace which locked gems use it.
- A guard against too many nested read locks on one thread (only reachable at 2^15 holds).

## Limits and checks not run
- The GitHub release notes for 1.3.6, 1.3.7 and 1.3.8 weren't collected. I read all 46 commits instead and opened the patches that change library code.
- Browser tests (Selenium/Chrome) weren't run.
- Sidekiq worker and production Puma boot weren't started separately. Both load `config/boot.rb`.
- Action Cable over production Redis wasn't run.
- Passing the existing tests alone doesn't prove the upgrade is safe.

## Files
Everything is under `/tmp/gem-upgrade-20261014-71555-l6fy4u`:
- Plan: `plan.json`
- Sources: `sources/index.md`, `sources/pages/`, and commit patches in `sources/repositories/b553fa513ad8/`
- Lockfile comparison: `dependencies-target/`
- Probes: `probes/boot_logger_probe.rb` and `probes/concurrent_probe.rb`
- Run records:
  - `runs/v1_3_8/003-boot.json` and `.log` (the boot failure)
  - `runs/v1_3_8_logger_after_bundler/` (`002-boot`, `006-tests`, `007-probe`, `008-probe`)
  - `runs/baseline_logger_prep/007-probe.json` (fix on 1.3.4)
  - `runs/baseline/007-probe.json` and `runs/baseline/008-probe.json`
- Copies: `variants/` (baseline, v1_3_8, v1_3_8_logger, v1_3_8_logger_after_bundler, baseline_logger_prep)

The lab's own databases were removed; copies and logs remain.

---

The upgrade skill only produces a plan, so I haven't changed your repository yet. The main point is that bumping concurrent-ruby alone stops the app from booting, and adding `require "logger"` to `config/boot.rb` fixes it. Should I make that change and pin concurrent-ruby to 1.3.8 on a new branch?