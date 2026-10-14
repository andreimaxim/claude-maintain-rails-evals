# concurrent-ruby 1.3.4 → 1.3.8 upgrade plan

Summary: This can't go in as a plain bump. With only the version changed, the application doesn't boot. One required repair is needed: add one line to `config/boot.rb`. That line also works on 1.3.4. There are no default-related repairs, and the upgrade introduces no new framework defaults. Final checks:
- `upgraded` (check 02): every step ok, 46 runs, 325 assertions, 0 failures, 0 errors, 0 skips.
- `base` (check 01): every step ok, 46 runs, 325 assertions, 0 failures, 0 errors, 0 skips.

## Setup and evidence
- **Lab directory:** `/tmp/upgrade-lab-concurrent-ruby`
- **Copies:**
  - `copies/base` is the application as it is, on concurrent-ruby 1.3.4.
  - `copies/upgraded` is on 1.3.8, with the Gemfile pin changed and the R1 repair applied.
- **Lock diff** (`/tmp/upgrade-lab-concurrent-ruby/lock-diff.md`): only concurrent-ruby changes, 1.3.4 → 1.3.8.
- **Check logs:** `checks/base/01/`, `checks/upgraded/01/` (boot fails), `checks/upgraded/02/` (all ok), `checks/backport/01/`.
- **Other files:** `changes.md`, `notes.md`, `backport.log`, `gem-diff.log`, `gem-source.diff`.
- **Patch:** `/tmp/upgrade-lab-concurrent-ruby/repairs.patch`. It contains the Gemfile pin change `"1.3.4"` → `"1.3.8"` and the boot.rb line below.

## Required changes
**R1. Load `logger` before Rails 7.0 loads ActiveSupport** (`config/boot.rb:4`)
- **Observed error** (`/tmp/upgrade-lab-concurrent-ruby/checks/upgraded/01/boot.log`):
  ```
  activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>': uninitialized con…
      Logger::Severity.constants.each do |severity|
  ```
  Every later step was skipped. If nothing is done, the app doesn't boot in any environment: no server, console, jobs or tests.
- **Cause:** concurrent-ruby 1.3.5 changelog entry "(#1062) Remove dependency on logger." concurrent-ruby used to load Ruby's `logger` library, and Rails 7.0.8.7 relied on that. ActiveSupport now refers to `Logger` before anything has loaded it.
- **Repair:**
  ```diff
   require "bundler/setup" # Set up gems listed in the Gemfile.
  +require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 needs Logger before ActiveSupport.
   require "bootsnap/setup"
  ```
  - **Alternative not chosen:** keep concurrent-ruby below 1.3.5. That would defeat the upgrade.
  - **Longer-term fix:** move to Rails 7.1 or later, which loads `logger` itself.
- **Works on the current version:** yes. `backport.log` reports "all repairs from upgraded work on concurrent-ruby 1.3.4"; the backport check passed all steps, 46 runs, 0 failures. This line can ship before the bump, in its own commit.
- **Validation:**
  - Fails without the repair: boot in `checks/upgraded/01` fails with the error above.
  - Passes with it: `checks/upgraded/02` is ok for boot, eager-load, production-boot, routes, assets and tests (46/46).
  - Control: `base` and `backport` checks behave the same as before.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 did not apply.

## Other gems that move
None. The lock diff changes concurrent-ruby only, and no gem is MAJOR or new.

## Rollout and rollback
- **Stored data:** no notes entry concerns serialization, cookies, sessions, cache entries, signed messages or job arguments, so the step 8 matrix was not needed. No stored data or queued work is affected in either direction.
- **Deploy order:** R1 works on 1.3.4, so deploy it first (or together with the bump).
- **Rollback:** rolling back the Gemfile bump alone is safe as long as the `require "logger"` line stays.

## Not verified
- **Behavioral fixes in 1.3.6–1.3.8 inside the gem's own internals:**
  - `RubyThreadPoolExecutor` now prunes asynchronously.
  - `TimerTask` can be restarted after shutdown.
  - `ReadWriteLock` / `ReentrantReadWriteLock` fixes.
  - `AtomicReference#update` livelock fix for `Float::NAN`.
  - `Concurrent::Map#compute_if_absent` can be used in a Ractor.

  Grepping `app`, `lib` and `config` found no direct `Concurrent::` use, so none of these was probed. The application reaches them only through Rails (executors, thread pools). The full test suite (46 runs) passed on `upgraded`, but it does not stress concurrency under load.
- **Browser tests:** `bin/rails test:system` is not part of the lab check and was not run.

---

This is a plan only. Your repository hasn't been changed; the upgrade was tested in copies under `/tmp/upgrade-lab-concurrent-ruby`. To apply it, I'd change the pin in the Gemfile, run `bundle update concurrent-ruby --conservative`, add the `require "logger"` line to `config/boot.rb`, and then run both `bin/rails test` and `bin/rails test:system`. Do you want me to go ahead?