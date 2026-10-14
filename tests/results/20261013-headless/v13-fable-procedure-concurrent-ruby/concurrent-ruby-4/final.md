# concurrent-ruby 1.3.4 → 1.3.8 upgrade plan

Summary: This cannot go in as a plain bump. With only the version changed, the app does not boot. One repair is required, a one-line `require "logger"` in `config/boot.rb`, and it also works on the current version. No default-related repairs are needed because this gem has no framework defaults. After the repair, `upgraded` passes every check: boot, db:prepare, eager load, production boot, 65 routes, assets, and tests (46 runs, 325 assertions, 0 failures, 0 errors, 0 skips). `base` gives the same result.

## Setup and evidence
- Lab: `/tmp/upgrade-lab-concurrent-ruby`. The services are stopped and the files are kept.
- Copies:
  - `copies/base` is the app on 1.3.4.
  - `copies/upgraded` is the app on 1.3.8 plus the R1 repair.
  - `backport` is base plus the repairs, on 1.3.4.
- Lock diff (`/tmp/upgrade-lab-concurrent-ruby/lock-diff.md`): only concurrent-ruby changes, 1.3.4 → 1.3.8. Note that the Gemfile pins it exactly (`Gemfile:8 gem "concurrent-ruby", "1.3.4"`), so the Gemfile line has to change too.
- Check logs:
  - `/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/01` (fails without the repair)
  - `/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/02` (failed first attempt)
  - `/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/03` (green)
  - `/tmp/upgrade-lab-concurrent-ruby/checks/base/01`
  - `/tmp/upgrade-lab-concurrent-ruby/checks/backport/01`
- Other files:
  - changes: `/tmp/upgrade-lab-concurrent-ruby/changes.md`
  - notes: `/tmp/upgrade-lab-concurrent-ruby/notes.md`
  - backport log: `/tmp/upgrade-lab-concurrent-ruby/backport.log`
  - gem diff: `/tmp/upgrade-lab-concurrent-ruby/gem-diff.log` and `/tmp/upgrade-lab-concurrent-ruby/gem-source.diff`
  - patch: `/tmp/upgrade-lab-concurrent-ruby/repairs.patch`
- No probe logs: none were needed (see steps 6 and 10 below).

## Required changes

**R1. Load `logger` before Rails 7.0 boots** (`config/boot.rb:3`)
- **Observed error** (`/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/01/boot.log`):
  ```
  activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>': uninitialized con[stant]
      Logger::Severity.constants.each do |severity|
  ```
- **Consequence if nothing is done:** the app does not start at all. That covers `bin/rails server`, the console, tests and production boot, so every request and job fails.
- **Cause:** concurrent-ruby 1.3.5 (#1062) says "Remove dependency on logger". ActiveSupport 7.0.8.7 uses `Logger` without requiring it itself, and until now it relied on concurrent-ruby to load it.
- **Repair:** add the require to `config/boot.rb`.
  ```diff
   require "bundler/setup" # Set up gems listed in the Gemfile.
  +require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 needs Logger defined
   require "bootsnap/setup" # Speed up boot time by caching expensive operations.
  ```
  Ship it together with `Gemfile:8` changing to `gem "concurrent-ruby", "1.3.8"` and the regenerated `Gemfile.lock`.
- **Why not `config/application.rb`:** I tried adding the require there first, before `require "rails/all"`, and boot failed the same way (check 02). `bin/rails` loads `rails/commands`, which loads ActiveSupport, before `application.rb` runs. So `boot.rb` is the place that covers every entry point.
- **Works on the current version:** yes. `backport.log` says "all repairs from upgraded work on concurrent-ruby 1.3.4", and the backport copy is all `ok` with 46 runs and 0 failures.
- **Validation:**
  - Fails without the repair: the boot check (check 01 FAIL).
  - Passes with it: check 03 is `ok` at every step, with 46 runs, 325 assertions, 0 failures and 0 errors.
  - Control: `base` on 1.3.4 is unchanged (same counts), and the backport copy shows the line is harmless on 1.3.4.
- **Alternative not chosen:** upgrading Rails to 7.1 or later, which requires logger itself. That is out of scope and changes framework versions and defaults.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 did not apply.

## Other gems that move
None. The lock diff lists only concurrent-ruby, and no MAJOR or new gems come with the bump.

## Rollout and rollback
- **Matrix (step 8):** not run. `notes.md` has no entry about serialization, cookies, sessions, cache, messages or job arguments, and the changelog only covers thread-pool, lock and atomic internals.
- **R1 works on 1.3.4,** so it can ship before the bump or in the same commit.
- **Bump and lock must ship with or after R1.** Deploying the 1.3.8 Gemfile/lock without R1 stops the app from booting.
- **Rollback:** reverting only the Gemfile/lock is safe while R1 stays in place.
- No stored data or queued work is affected in either direction.

## Not verified
- **Gem internals the tests and probes don't reach.** The app never calls concurrent-ruby directly: its only use is the Gemfile pin, and `grep "Concurrent::"` on app, lib and config found no hits. So no probes were written for these changes:
  - `RubyThreadPoolExecutor` now prunes idle threads asynchronously (#1082).
  - `TimerTask` can now be restarted after shutdown.
  - `ReadWriteLock` and `ReentrantReadWriteLock` fixes.
  - `AtomicReference#update` no longer livelocks when the stored value is `Float::NAN`.
  - The `Concurrent::Map#compute_if_absent` Ractor change.
  - The `concern/logging.rb` rewrite.

  These only matter indirectly, through Rails' own thread pools (Active Record connection pool reaper, load interlock, Action Cable, async job adapter). The test suite and the boot checks passed, but behavior under production concurrency was not load-tested.
- **Rails deprecation warning:** "Rails 7.0 has deprecated Enumerable.sum…" appears 3 times on both `base` and `upgraded`. It is not related to this upgrade.

---

I only planned the upgrade; nothing in your repo has been changed. The planner did all its testing in throwaway copies under `/tmp/upgrade-lab-concurrent-ruby`. To apply it, three changes go together:
1. Add `require "logger"` to `config/boot.rb`.
2. Change the pin in `Gemfile:8` to `1.3.8`.
3. Run `bundle update concurrent-ruby --conservative`.

Want me to make those changes and run the test suite?