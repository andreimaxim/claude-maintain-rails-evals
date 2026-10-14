# concurrent-ruby 1.3.4 → 1.3.8 upgrade plan

Summary: This cannot go in as a plain bump. With only the version changed, the app fails to boot on the upgraded copy. One repair is needed: add `require "logger"` to `config/boot.rb`. No default-related repairs are needed because this release has no new framework defaults. With the repair, `upgraded` passes every step (boot, db:prepare, eager load, production boot, 65 routes, assets) and the tests give 46 runs, 325 assertions, 0 failures, 0 errors, 0 skips. `base` gives the same result.

## Setup and evidence
- Lab: `/tmp/upgrade-lab-concurrent-ruby`
  - `copies/base` is concurrent-ruby 1.3.4.
  - `copies/upgraded` is concurrent-ruby 1.3.8 plus repair R1.
- Lock diff (`/tmp/upgrade-lab-concurrent-ruby/lock-diff.md`): only concurrent-ruby changes, 1.3.4 → 1.3.8. The Gemfile pin `gem "concurrent-ruby", "1.3.4"` (Gemfile:8) becomes `"1.3.8"`.
- Check logs:
  - `checks/base/01/`
  - `checks/upgraded/01/` (boot fails)
  - `checks/upgraded/02/` (all ok)
  - `checks/backport/01/`
- Other files: changes in `changes.md`, notes in `notes.md`, gem source diff in `gem-source.diff` / `gem-diff.log`, patch in `/tmp/upgrade-lab-concurrent-ruby/repairs.patch`.

## Required changes
**R1. Load Logger before Rails** (`config/boot.rb:5`)
- **Observed error** (`/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/01/boot.log`):
  ```
  activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>': uninitialized con[stant]
      Logger::Severity.constants.each do |severity|
  ```
- **Cause:** concurrent-ruby 1.3.5 (#1062, "Remove dependency on logger") no longer runs `require "logger"`. Rails 7.0.8.7's ActiveSupport refers to `Logger` without loading it itself; it relied on concurrent-ruby to do that.
- **Consequence if nothing is done:** the app does not start in any environment. The server, console, tests and production boot all fail.
- **Repair:**
  ```diff
   require "bundler/setup" # Set up gems listed in the Gemfile.
   require "bootsnap/setup" # Speed up boot time by caching expensive operations.
  +require "logger" # concurrent-ruby >= 1.3.5 no longer loads Logger; Rails 7.0 needs it before rails/all.
  ```
- **Alternative not chosen:** keeping concurrent-ruby below 1.3.5 would mean not doing this upgrade at all. Upgrading Rails is out of scope.
- **Works on the current version:** yes. `backport.log` says "all repairs from upgraded work on concurrent-ruby 1.3.4". The repair can ship before the bump.
- **Validation:**
  - Fails without the repair: boot check 01 on `upgraded`.
  - Passes with the repair: check 02 is all ok (46 runs, 325 assertions, 0 failures).
  - Control: `base` is unchanged (46/325/0/0) and backport check 01 is also all ok.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 was skipped.

## Other gems that move
None. The lock diff shows no gem besides concurrent-ruby, and no MAJOR or new gems.

## Rollout and rollback
- **Matrix (step 8) not run:** no note concerns serialization, cookies, sessions, cache entries, signed messages or job arguments, so there was nothing to write and read across versions.
- **Order:** R1 works on 1.3.4, so ship it first or in the same commit as the Gemfile/Gemfile.lock change.
- **Rollback:** going back to 1.3.4 with R1 kept is safe, as the backport check shows.
- No stored data or queued work is affected in either direction.

## Not verified
- **Behaviour changes in the gem:** the gem diff covers about 966 lines under `lib/`. It touches the RubyThreadPoolExecutor (asynchronous pruning), TimerTask/TimerSet shutdown, the ReadWriteLock/ReentrantReadWriteLock fixes, the AtomicReference#update NaN livelock fix, `concern/logging.rb`, and `Concurrent::Map#compute_if_absent` (now usable in a Ractor). The app never calls `Concurrent::` directly; Gemfile:8 is its only reference. So none of these was probed on its own. They are exercised only indirectly through Rails (for example the Action Cable and ActiveSupport thread pools) and the full test suite, which passes.
- **Concurrency under load:** the effect of asynchronous pool pruning on long-running production processes (Puma or Action Cable) was not reached by any check.

---

I've only planned this upgrade so far. Nothing in the repo has changed. The plan was tested on copies in `/tmp/upgrade-lab-concurrent-ruby`.

To do the upgrade:
1. Add `require "logger"` to `config/boot.rb`.
2. Change the pin in the Gemfile to `"1.3.8"` and run `bundle update concurrent-ruby --conservative`.
3. Run `bin/rails test` and `bin/rails test:system`.

Should I go ahead and make these changes?