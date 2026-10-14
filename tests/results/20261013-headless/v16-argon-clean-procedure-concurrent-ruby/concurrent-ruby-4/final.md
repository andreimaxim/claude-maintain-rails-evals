# concurrent-ruby 1.3.4 to 1.3.8 upgrade plan for Margin Notes

**Summary:** If you only change the pin, the app will not boot. Concurrent-ruby 1.3.5 stopped loading Ruby's `logger` library, and Rails 7.0.8.7 depends on it being loaded. A one-line `require "logger"` at the top of `config/boot.rb` fixes it. I tested that line on both 1.3.4 and 1.3.8, so it can ship before the bump. After that, nothing else in the app is affected. The working checkout was not modified (`git status` is clean).

## 1. Required changes for the upgrade

### Finding 1: Rails 7.0 fails to boot because `logger` is no longer loaded for it

- **Affected code:**
  - `/home/user/workspace/repo/config/boot.rb`, lines 1–4. It runs `bundler/setup` and `bootsnap/setup` but never loads `logger`.
  - `/home/user/workspace/repo/config/application.rb`, the `require "rails/all"` line, which loads ActiveSupport 7.0.8.7.
  - `/home/user/workspace/repo/Gemfile`, line 8: `gem "concurrent-ruby", "1.3.4"`. The lockfile records this as `concurrent-ruby (= 1.3.4)` under DEPENDENCIES.
- **What breaks:** On 1.3.8, every process that boots Rails (server, runner, console, tests, rake, job workers) fails before any app code loads:
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  On 1.3.4 the same command boots and prints `"1.3.4"`.
- **Applicability:**
  - Introduced in 1.3.5 (#1062, "Remove dependency on logger"). It removed `require 'logger'` from `concurrent/concern/logging.rb`, so 1.3.5, 1.3.6, 1.3.7 and 1.3.8 all fail the same way.
  - It hits as soon as the gem is bumped, whatever the `load_defaults` setting. Rails 7.1 and later load `logger` themselves, so the extra line becomes redundant (but harmless) after a later Rails upgrade.
  - The repair works on 1.3.4. No stored data or queued jobs are involved.
- **Recommended repair:** Add this as the first line of `config/boot.rb`:
  ```ruby
  require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 needs it
  ```
  Then change `Gemfile` line 8 to `gem "concurrent-ruby", "1.3.8"` and run `bundle update concurrent-ruby`. Only `concurrent-ruby` changes in the lockfile, and `logger (1.7.0)` is already locked.
  - Alternative 1: putting `-rlogger` in `RUBYOPT` only works in environments where that variable is set, so it can silently miss production, CI or job workers.
  - Alternative 2: staying below 1.3.5 (`< 1.3.5`) avoids the error but gives up the requested version.
- **Validation (run in the workspace):**
  - Failing check: `RAILS_ENV=test bin/rails runner 'p Concurrent::VERSION'` on `upgraded` without the line raises the `NameError` above.
  - Passing check: with the line, `bin/rails runner 'p [Concurrent::VERSION, Rails.logger.class]'` prints `["1.3.8", ActiveSupport::Logger]`.
  - Control on 1.3.4: `baseline` with the same line prints `["1.3.4", ActiveSupport::Logger]`.
  - Full suite with the repair (`upgrade-workspace test`): boot OK, eager load OK, 67 routes, 46 runs, 325 assertions, 0 failures, 0 errors.

### Other changes in the range that do not affect this app

- **No direct use of concurrent-ruby:** nothing under `app/`, `lib/` or `config/` references `Concurrent` or `TimerTask`. It is only reached through Rails (ActiveSupport, ActionCable and others).
- **TimerTask match is a false positive:** `gem-changes` flagged it because of the word `execute` in `db/migrate/20261011150300_move_note_bodies_to_rich_text.rb`, lines 19 and 22. Those are SQL `execute` calls and have nothing to do with TimerTask.
- **Other upstream changes:** async pruning in `RubyThreadPoolExecutor`, the `TimerTask` restart fix, lock fixes in `ReadWriteLock` and `ReentrantReadWriteLock`, the `AtomicReference#update` NaN livelock fix, Ractor support for `Map#compute_if_absent`, typed data in the C extension, and `backtrace_location` changes. These are internal fixes; the identical test results and route list are consistent with no effect here.
- **Existing deprecation, unrelated to this upgrade:** an `Enumerable.sum` warning from `app/models/export.rb:42` (`finish(fragments.sum)`) shows up in the logs for both versions.

## 2. New configuration defaults across intermediate releases

None. concurrent-ruby is not a Rails framework gem, so 1.3.5, 1.3.6, 1.3.7 and 1.3.8 add no `load_defaults` or `config/` settings. The app stays on `config.load_defaults 7.0`, which is unchanged.

## 3. Rollout, rollback, and mixed-version risks

- **Data:** none of the following are affected:
  - database records and `db/schema.rb` (routes and schema load were identical);
  - Redis cache entries;
  - signed or encrypted cookies and tokens;
  - Active Job payloads.

  This gem has no serialization or format changes in the range, so 1.3.4 and 1.3.8 processes can run side by side safely.
- **The real risk is boot:** any process that gets the new lockfile without the boot fix will not start, including job workers and one-off tasks. Ship the `config/boot.rb` line on 1.3.4 first, then bump the gem in a separate deploy.
- **Rollback:** go back to the 1.3.4 lockfile. The extra `require "logger"` can stay in place.

## 4. Verification log and open questions

**Executed in `upgrade-workspace`:**
- **`setup`:** resolved versions `concurrent-ruby` 1.3.4 to 1.3.8, with only that gem changing. The baseline booted; the upgraded copy initially failed with the `NameError` above. Routes were 67 on both, and both suites passed 46/325/0/0 under `load_defaults 7.0`.
- **`probe`:** reported `Concurrent::VERSION` and showed `Logger` defined on both copies. That is likely because the harness adds `-rlogger`, so it does not tell you anything about the boot failure. I ran `bin/rails runner` directly instead, as recorded under Validation above.
- **Repair test:** the boot-line check on both copies, then `upgrade-workspace test` with the repair. Results are under Validation above.
- **Log paths** (deleted by `cleanup`): `/tmp/upgrade-concurrent-ruby-1.3.8/logs/{bundle-update,diag-baseline,diag-upgraded,schema-load-*,tests-baseline,tests-upgraded}.log`
- **`cleanup`:** finished, and the working checkout's `git status` is clean.

**Based on reading code only:**
- Whether the internal fixes listed in section 1 affect this app. The app does not call them directly; only the boot, eager-load, route and test checks above were run.
- The `gem-changes` script could not unpack the 1.3.8 `.gem` file ("is not an octal string"), so its comparison of release files came from the GitHub tag diff rather than the packaged gem.

**Still proposed:**
- After deploy, check that a production-mode boot (`RAILS_ENV=production bin/rails runner 'p Rails.logger.class'`) and the job worker process both start with the boot fix in place.

---

I've only planned the upgrade so far. The upgrade skill doesn't make changes, so your repo is untouched. To apply it, I'd add the `require "logger"` line to `config/boot.rb`, change the Gemfile pin to `1.3.8`, run `bundle update concurrent-ruby`, and run the test suites. Should I go ahead? Do you also want the boot fix and the version bump as separate commits, so they can be deployed separately as the plan recommends?