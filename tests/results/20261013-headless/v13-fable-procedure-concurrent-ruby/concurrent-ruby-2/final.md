# concurrent-ruby 1.3.4 → 1.3.8 upgrade plan

Summary: This cannot go in as a plain bump. With only the version changed, the application fails to boot. One repair is required: add one line to `config/boot.rb`. No repairs are tied to new defaults, because this release has none. After the repair, the final check of `upgraded` passes every step: boot, db:prepare, eager-load, production-boot, routes (65), assets, and tests (46 runs, 325 assertions, 0 failures, 0 errors, 0 skips). `base` gives the same result. The repair also works on 1.3.4, so it can ship before the bump.

## Setup and evidence
- Lab directory: `/tmp/upgrade-lab-concurrent-ruby`. Services have been stopped and the files are kept.
- Copies:
  - `copies/base` is the application on 1.3.4.
  - `copies/upgraded` is the application on 1.3.8 plus R1.
  - The backport copy is `base` plus R1.
- Lock diff (`/tmp/upgrade-lab-concurrent-ruby/lock-diff.md`): only `concurrent-ruby: 1.3.4 → 1.3.8` changes. The Gemfile pin on line 8 is exact (`"1.3.4"`), so it must change to `"1.3.8"`.
- Check logs:
  - `checks/base/01/`
  - `checks/upgraded/01/` (boot fails)
  - `checks/upgraded/02/` (all ok)
  - `checks/backport/01/` (all ok)
- Other files: `changes.md`, `notes.md`, `backport.log`, `gem-diff.log`, `gem-source.diff`.
- Patch: `/tmp/upgrade-lab-concurrent-ruby/repairs.patch`. It contains the Gemfile bump and R1.

## Required changes

**R1. Load `logger` before Rails** (`config/boot.rb:3`)
- **Observed error** (`/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/01/boot.log`):
  ```
  activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>': uninitialized con[stant Logger]
      Logger::Severity.constants.each do |severity|
  ```
  No application frame appears. The failure happens while Rails itself is loading, so every process fails to start: the server, jobs, console, tests and production boot.
- **Cause:** concurrent-ruby 1.3.5 (#1062) "Remove dependency on logger." Rails 7.0.8.7's ActiveSupport relied on concurrent-ruby to `require "logger"` for it, and it no longer does.
- **Repair:**
  ```diff
   require "bundler/setup" # Set up gems listed in the Gemfile.
  +require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 expects it.
   require "bootsnap/setup"
  ```
  The other way to fix it is to keep concurrent-ruby below 1.3.5. That would block this upgrade, so it is not recommended. Upgrading to Rails 7.1 or later would also remove the need for the line, but that is outside the scope of this task.
- **Works on the current version:** yes. `backport.log` reports "all repairs from upgraded work on concurrent-ruby 1.3.4". It can be committed before the Gemfile bump.
- **Validation:**
  - Fails without the repair: `upgraded` check 01 fails at boot.
  - Passes with the repair: `upgraded` check 02 passes all steps, including the 46 tests and production boot.
  - Control: `base` and backport check 01 stay all ok with identical test counts.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 did not apply.

## Other gems that move
None. No other gem changed in the lock. `logger (1.7.0)` was already in the lock as a dependency of other gems.

## Rollout and rollback
- Step 8 was not run because no entry in `notes.md` concerns serialization, cookies, cache entries, messages or job arguments.
- R1 works on both versions. Deploy it first or in the same commit as the bump. Rollback to 1.3.4 is safe with R1 kept in place.

## Not verified
- The application code has no direct `Concurrent::` calls in `app/`, `lib/` or `config/`, so no probes were written.
- The internal changes from the gem diff were not exercised directly beyond the test suite:
  - asynchronous pruning in `RubyThreadPoolExecutor` (#1082)
  - `TimerTask` restart behaviour
  - fixes to `ReadWriteLock` and `ReentrantReadWriteLock`
  - the `AtomicReference#update` fix for `Float::NAN`
  - `Map#compute_if_absent` inside a Ractor

  They reach the application only through Rails internals (executors, Active Job async adapter, caches). The test suite passed, but load under concurrency was not tested.
- The pre-existing deprecation warning about `Enumerable.sum` (3 occurrences) appears on both versions and is unrelated to this upgrade.

---

I haven't upgraded anything yet; this is only the plan, and your repo is unchanged. The lab copies in `/tmp/upgrade-lab-concurrent-ruby` show that bumping the version by itself stops the app from booting. Changing the Gemfile pin to `"1.3.8"` and adding the `require "logger"` line to `config/boot.rb` fixes it, and all 46 tests pass. Both changes are in `/tmp/upgrade-lab-concurrent-ruby/repairs.patch`. Want me to apply it and run the tests here?