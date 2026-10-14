# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

Bumping the gem on its own makes the app fail to boot. Adding one line to `config/boot.rb` fixes it, and that line can ship on 1.3.4 first. Apart from the boot failure, nothing in the range changes how this app behaves.

The exact pin `gem "concurrent-ruby", "1.3.4"` at `/home/user/workspace/repo/Gemfile:8` is almost certainly there to work around this boot failure. Once the fix below is in place, the pin can be changed to `"1.3.8"` or loosened to `"~> 1.3"`.

## 1. Required changes for the upgrade

### Finding R1: the app does not boot because Logger is no longer loaded

- **Affected code:** `/home/user/workspace/repo/config/boot.rb` lines 3–4 (`require "bundler/setup"`, then `require "bootsnap/setup"`). `config/application.rb:3` then runs `require "rails/all"` without loading `logger` first. The error is raised inside the gem at `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12`.
- **What breaks:** In concurrent-ruby 1.3.5, upstream change #1062 (commit `d7ce956`) removed `require 'logger'` from `concurrent/concern/logging.rb`. ActiveSupport 7.0 refers to `Logger::Severity` without requiring `logger` itself. As a result, every boot path fails: server, console, runner, rake, tests, and job workers. They all stop with:
  `NameError: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger`
- **Applicability:** It starts with 1.3.5 and takes effect as soon as the gem is bumped, regardless of `load_defaults`. The repair also works on 1.3.4, so it can ship before the bump. No stored data or queued jobs are affected.
- **Recommended repair:** In `config/boot.rb`, add one line right after `require "bundler/setup"`:
  ```ruby
  require "bundler/setup" # Set up gems listed in the Gemfile.
  require "logger" # concurrent-ruby >= 1.3.5 no longer loads Logger; Rails 7.0 needs it
  require "bootsnap/setup"
  ```
  - **Why not the alternatives:**
    - Keeping the pin at 1.3.4 leaves the upgrade undone.
    - Putting the require in `config/application.rb` works for normal boot, but some entry points load `boot.rb` without `application.rb`, so they would not get the fix.
    - Upgrading to Rails 7.1+, which fixes this upstream, is outside the scope of this task.
  - `logger (1.7.0)` is already in `Gemfile.lock` through other gems, so no new dependency is needed.
- **Validation:** Each check was run with the `-rlogger` that the workspace scripts inject removed, by calling `bundle exec ruby -e 'require "./config/environment"; puts Concurrent::VERSION; puts Rails.logger.class; puts ActiveSupport::Logger.new(STDOUT).level'`.
  - **Discriminating check:** on upgraded without the fix, boot fails with the `NameError` above. With the fix it prints `1.3.8`, `ActiveSupport::Logger`, `0`.
  - **Control check:** baseline 1.3.4 prints `1.3.4`, `ActiveSupport::Logger`, `0` both with and without the fix, so the fix is safe to ship first.
  - **Full suite:** upgraded with the fix ran 46 runs, 325 assertions, 0 failures, 0 errors. That is identical to baseline.

### Other commits in the range: no impact found

I checked each of these against the app:
- **TimerTask restart fix (#1001):** the app does not use `TimerTask`. The `gem-changes` match on `execute` in `db/migrate/20261011150300_move_note_bodies_to_rich_text.rb:19,22` is a false positive; those lines call the migration's SQL `execute`.
- **Thread-pool changes:** asynchronous pruning in `RubyThreadPoolExecutor` and the `kill`/`wait_for_termination` change. These are used only indirectly through Rails internals, and the test suite and probe behaved the same on both versions.
- **Lock and atomic fixes:** `ReadWriteLock` and `ReentrantReadWriteLock` fixes, the `AtomicReference#update` livelock on NaN, and `Map#compute_if_absent` under Ractors. These are bug fixes only, and the app does not call these APIs directly.
- **No Fiber created at load time, and the `cached_thread_pool` multi-require fix:** both are harmless here.

## 2. New configuration defaults across intermediate releases

None. concurrent-ruby 1.3.5 through 1.3.8 add no Rails framework defaults. `load_defaults 7.0` is unaffected, and nothing needs to be configured.

## 3. Rollout, rollback, and mixed-version risks

- **Serialized data:** concurrent-ruby does not touch the database, `db/schema.rb`, the Redis cache format, cookies or tokens, or Active Job payloads, so 1.3.4 and 1.3.8 processes can run side by side safely.
- **Main risk:** deploying the bump without R1 crashes every process at boot. Ship the `boot.rb` line on 1.3.4 first, as its own deploy, then bump the gem.
- **Rollback:** rolling back to 1.3.4 with the `require "logger"` line still in place is safe; it was verified on baseline.

## 4. Verification log and open questions

**Executed in the workspace:**
- **`gem-changes concurrent-ruby 1.3.4 1.3.8`:** it could not unpack the 1.3.8 `.gem` file ("is not an octal string"), so it worked from the CHANGELOG, the release notes, and the git range v1.3.4...v1.3.8 (46 commits).
- **`upgrade-workspace setup`:** the only `Gemfile.lock` change was `concurrent-ruby: 1.3.4 → 1.3.8`.
  - Baseline booted and eager-loaded with 67 routes.
  - Upgraded initially failed to boot with the `NameError` above. Setup then added `-rlogger` automatically, after which boot and eager load were OK, routes were identical (67), and the suite ran 46/325/0/0 on both copies.
  - Logs: `/tmp/upgrade-concurrent-ruby-1.3.8/logs/{diag-baseline,diag-upgraded,tests-baseline,tests-upgraded,bundle-update}.log`. These have been deleted by cleanup.
- **Manual boot checks without the injected `-rlogger`:** baseline and upgraded, each with and without the fix. Results are recorded in R1.
- **`upgrade-workspace probe`:** with the fix applied, it exercised `Rails.cache` write/read, a `TimerTask` restart after shutdown, and `Concurrent::Map#compute_if_absent`. Output was the same on both versions: `nil` (the test-environment cache stores nothing), `true`, `2`.
- **`upgrade-workspace test`:** upgraded with the fix ran 46 runs, 325 assertions, 0 failures.
- **`upgrade-workspace cleanup`:** done, and the working checkout's `git status` is clean.

**Unrelated finding:** the deprecation warning `Enumerable.sum` for `app/models/export.rb:42` (`fragments.sum`) also appears on baseline, so the bump did not cause it. The fix would be `fragments.join`, but that belongs in a separate change.

**Open questions:**
- Production and job-worker entry points (for example a separate worker binstub) were not booted. Any of them that skips `config/boot.rb` would also need `require "logger"`.
- Whether the release workflow has a reason for the exact pin other than this boot failure.

---

That's the plan; I haven't changed anything yet. Bumping the gem by itself crashes the app at boot. To upgrade, add `require "logger"` to `config/boot.rb`, then change the pin in the `Gemfile` to 1.3.8 and run `bundle update concurrent-ruby`. Want me to make those changes?