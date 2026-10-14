# concurrent-ruby 1.3.4 → 1.3.8 upgrade plan

Summary: This cannot go in as a plain bump. With only the version changed, the application does not boot. One repair is needed (R1, one line in `config/boot.rb`), and it also works on the current version. No default-related repairs are needed because concurrent-ruby has no framework defaults. Final check of `upgraded` (check 02): every step ok, 46 runs, 325 assertions, 0 failures, 0 errors, 0 skips. `base` (check 01): every step ok, with the same 46 / 325 / 0 / 0 / 0.

## Setup and evidence
- Lab directory: `/tmp/upgrade-lab-concurrent-ruby`. Its PostgreSQL and Redis servers have been stopped; the files are kept.
- Copies:
  - `copies/base` is the application on 1.3.4.
  - `copies/upgraded` is on 1.3.8 with R1 applied.
  - A `backport` copy holds the repairs on 1.3.4.
- Lock diff (`/tmp/upgrade-lab-concurrent-ruby/lock-diff.md`): only `concurrent-ruby: 1.3.4 → 1.3.8` changes.
- Check logs:
  - `checks/base/01/`
  - `checks/upgraded/01/` (boot fails)
  - `checks/upgraded/02/` (all ok)
  - `checks/backport/01/`
- Other files: `start.log` is at `/tmp/upgrade-lab-concurrent-ruby-start.log`. Inside the lab directory are `changes.md`, `notes.md`, `backport.log`, `gem-diff.log`, `gem-source.diff` and the patch `/tmp/upgrade-lab-concurrent-ruby/repairs.patch`.

## Required changes

**R1. Load Logger before Rails** (`config/boot.rb:3`)
- **Observed error** (`checks/upgraded/01/boot.log`):
  ```
  activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>': uninitialized con[stant Logger]
      Logger::Severity.constants.each do |severity|
  ```
  There are no application frames. The failure happens while `rails/all` is loading from `config/application.rb`.
- **Cause:** concurrent-ruby 1.3.5 changelog entry "(#1062) Remove dependency on logger". concurrent-ruby used to `require "logger"` itself. Rails 7.0.8.7 relies on that side effect and never loads `logger` on its own.
- **Consequence if nothing is done:** every process that boots the application fails before any code runs. That covers the server, console, tests, migrations and production boot.
- **Repair:**
  ```diff
   require "bundler/setup" # Set up gems listed in the Gemfile.
  +require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 needs Logger before rails loads.
   require "bootsnap/setup" # Speed up boot time by caching expensive operations.
  ```
  An alternative is to pin `concurrent-ruby` below 1.3.5, but that defeats the upgrade. Moving to Rails 7.1 or later also fixes it, but that is outside this task's scope.
- **Works on the current version:** yes. `backport.log` says: "all repairs from upgraded work on concurrent-ruby 1.3.4". It can ship before or together with the Gemfile bump.
- **Validation:**
  - Fails without the repair: the boot step of `upgraded` check 01 fails with the error above.
  - Passes with it: check 02 boots and runs all 46 tests.
  - Control: `base` check 01 and backport check 01 are both all ok, with 46 runs and 325 assertions.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 does not apply.

## Other gems that move
None. The lock diff changes only concurrent-ruby. It is an indirect dependency of Rails (Active Support's thread pools, `Concurrent::Map` and so on), pinned explicitly at `Gemfile:8`.

## Rollout and rollback
- No matrix was run (step 8). The changelog has no entries about serialization, cache, cookies, messages or job arguments, and the application does not store concurrent-ruby objects.
- R1 works on both versions, so the order is:
  1. Deploy `config/boot.rb` first, or together with the bump.
  2. Then the Gemfile and Gemfile.lock bump.
- Rolling back the gem alone is safe while R1 stays in place.

## Not verified
- **Changes in the gem's own code** (step 10, `gem-diff.log`):
  - Files changed include `ruby_thread_pool_executor.rb` (asynchronous pruning), `timer_set.rb` and `TimerTask` (restart after shutdown), `read_write_lock.rb` / `reentrant_read_write_lock.rb` (lock fixes), `AtomicReference#update` (fix for `Float::NAN`), `concern/logging.rb`, and `Map#compute_if_absent` (Ractor support).
  - The application never calls `Concurrent::` directly; a grep of `app`, `lib` and `config` found nothing. It reaches these only through Rails, so I wrote no probes.
  - The test suite covers them only indirectly. Behavior under real thread-pool load, such as the Puma or Active Record connection pool, or `load_async` if it is used, was not exercised.
- **Browser suite:** `bin/rails test:system` is not part of the lab check and was not run.
- **Unrelated deprecation:** one deprecation warning ("Enumerable.sum") appears on both versions. It is not related to this upgrade.

---

I haven't upgraded anything yet. The upgrade workflow builds a plan first and leaves your repo unchanged, so `main` is still clean and on concurrent-ruby 1.3.4.

The plan shows the app won't start after a plain version bump, because Rails 7.0 depends on concurrent-ruby loading `logger` and 1.3.5 dropped that. One added line in `config/boot.rb` fixes it, and that line also works on 1.3.4. With it in place, all 46 tests passed on 1.3.8 in a separate test copy of the app. The browser tests were not run.

If you want, I can apply it: add the `require "logger"` line, change the version in `Gemfile` to 1.3.8, run `bundle update concurrent-ruby`, then run `bin/rails test` and `bin/rails test:system`.