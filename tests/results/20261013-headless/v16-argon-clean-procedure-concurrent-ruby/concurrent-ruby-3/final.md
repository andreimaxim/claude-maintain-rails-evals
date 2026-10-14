# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

The bump needs one fix before it is safe. With 1.3.8 the app does not boot at all unless `logger` is loaded first. The fix is a single line, and it also works on 1.3.4, so it can ship before the bump. Nothing else in the range affects this app.

## 1. Required changes for the upgrade

### R1. The app fails to boot because concurrent-ruby stopped loading `logger` (introduced in 1.3.5, PR #1062, commit `d7ce956`)

- **Affected code:** `/home/user/workspace/repo/config/boot.rb`, lines 1–4. The app never loads `logger` itself. On Rails 7.0, `ActiveSupport::LoggerThreadSafeLevel` uses `Logger::Severity` but doesn't require `logger`. It only worked because concurrent-ruby used to require it in `concurrent/concern/logging.rb`. `config/environments/production.rb:79` (`::Logger::Formatter.new`) also depends on it.
- **What breaks:** Every process stops at boot (server, console, jobs, rake, tests). The upgraded copy failed with: `NameError: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger`. With 1.3.4 it booted fine.
- **Applicability:** Starts the moment the gem is bumped to 1.3.5 or later. It applies only while the app is on Rails below 7.1. The repair works on 1.3.4 and has no effect on stored data or queued jobs.
- **Recommended repair:** In `config/boot.rb`, after `require "bundler/setup"` and before `require "bootsnap/setup"`, add:
  ```ruby
  require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 needs it
  ```
  Then change the Gemfile pin to `gem "concurrent-ruby", "1.3.8"`. There are two other options, and I recommend against both:
  - Keeping concurrent-ruby at 1.3.4 or below blocks the upgrade.
  - Adding `-rlogger` to `RUBYOPT` depends on the environment and would be missed by some process launchers.

  Upgrading to Rails 7.1 or later also removes the problem, but that is out of scope here.
- **Validation:**
  - **Failing check:** in the upgraded copy without the line, `bin/rails runner 'p Rails.logger.class'` should raise the `NameError` above. Setup observed this failure.
  - **Passing check:** with the line, the same command should print `ActiveSupport::Logger`.
  - **Control:** `bin/rails test` should still give 46 runs, 325 assertions, 0 failures. `bin/rails zeitwerk:check` should pass. In production, `RAILS_ENV=production bin/rails runner 'p Rails.application.config.log_formatter.class'` should print `Logger::Formatter`.
  - **Also run on 1.3.4:** the same commands with the line added, to confirm it can ship early.

### Other changes in the range: no impact on this app

- `TimerTask` restart fixes, async pruning in `RubyThreadPoolExecutor`, `ReadWriteLock`, `ReentrantReadWriteLock` and `AtomicReference` fixes, typed-data C extension, and Ractor support for `Map#compute_if_absent`: the app never calls `Concurrent` directly. I grepped `app`, `lib` and `config`. These are only used inside Rails, and the fixes are internal and compatible.
- The `TimerTask` "match" against `db/migrate/20261011150300_move_note_bodies_to_rich_text.rb:19,22` is a false positive (SQL `execute`).
- The only other dependency change is `concurrent-ruby` itself. `logger 1.7.0` was already in the lockfile.

## 2. New configuration defaults across intermediate releases

None. concurrent-ruby 1.3.5 through 1.3.8 add no Rails configuration defaults. `config.load_defaults 7.0` is unaffected.

## 3. Rollout, rollback, and mixed-version risks

- **Data:** Database records, `db/schema.rb`, Redis cache entries, signed or encrypted cookies and tokens, and Active Job payloads are not serialized by concurrent-ruby. Routes (67) and the schema came out the same on both versions. Old and new processes can run side by side safely.
- **Order matters:**
  1. Deploy the `require "logger"` line on 1.3.4 first.
  2. Then bump the gem.

  If you bump without the line, no new process will boot, which is a hard failure at deploy rather than mixed behaviour. A rollback to 1.3.4 is safe with the line left in place.

## 4. Verification log and open questions

**Executed in the workspace (`/tmp/upgrade-concurrent-ruby-1.3.8`, now cleaned up):**
- `gem-changes concurrent-ruby 1.3.4 1.3.8`: it reported 46 commits and the removed `require 'logger'` in `concurrent/concern/logging.rb` and in edge.
  - It could not read the 1.3.8 `.gem` archive ("not an octal string"), so the lib diff came from git tags.
- `upgrade-workspace setup`: the lockfile diff was only `concurrent-ruby 1.3.4 → 1.3.8` and the bundle resolved.
  - **Baseline (1.3.4):** booted, eager-loaded, 67 routes, 46 runs / 325 assertions / 0 failures.
  - **Upgraded (1.3.8):** first boot failed with the `NameError` above. The tool then added `-rlogger` and the rest matched baseline: 67 routes and the same test results.
- **Logs:** `logs/diag-upgraded.log`, `logs/tests-upgraded.log` and `logs/bundle-update.log` under that directory. Grepping `diag-upgraded.log` found no `NameError`, so the failure is known only from the setup summary.
- `upgrade-workspace test` with the `boot.rb` line, then `reset` and `test` without it: both passed with the same results. Because the tool adds `-rlogger`, neither run tests the repair.
- `upgrade-workspace probe` printed `[VERSION, "constant", ActiveSupport::Logger, "ab"]` on both versions, also under `-rlogger`.
- **Not run:** my direct `bin/rails runner` attempts, with and without the `boot.rb` line on both copies, were blocked by a `mise trust` error. So the fix is shown by the observed failure plus reading the source, not by a clean before-and-after run.

**Still to do:** run the R1 validation in a shell without `-rlogger`, on both 1.3.4 and 1.3.8. Also confirm that no deploy wrapper sets `RUBYOPT` already.

**Unrelated note:** the existing deprecation warning at `/home/user/workspace/repo/app/models/export.rb:42` (`fragments.sum`, Rails 7.0 `Enumerable#sum`) appears on both versions. It isn't caused by this upgrade. The fix would be `fragments.sum("")` or `fragments.join`.

---

**My notes:** This is only a plan; nothing in the repo has changed. The `Gemfile` pins `concurrent-ruby` to exactly `1.3.4`, which is the version that loaded `logger`. The pin was most likely there to avoid this boot failure, so the `boot.rb` line has to land before the pin changes or at the same time.

The fix hasn't been checked with a clean run yet: the planner's direct `bin/rails runner` checks were blocked by a `mise trust` error, and its test runs added `-rlogger`, which hides the problem. Running the R1 checks in a plain shell is the remaining step.

Do you want me to make the change (the `boot.rb` line, then the Gemfile pin and `bundle update concurrent-ruby --conservative`) and run those checks?