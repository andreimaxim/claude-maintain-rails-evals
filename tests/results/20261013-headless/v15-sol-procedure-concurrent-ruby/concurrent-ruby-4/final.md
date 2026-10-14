## Verdict: safe to upgrade concurrent-ruby 1.3.4 to 1.3.8, but only with one required code change

On this app's Rails 7.0.8.7, bumping alone stops the app from booting. Adding one line to `config/boot.rb` fixes it, and with that line every lab check passes. The Gemfile pins `gem "concurrent-ruby", "1.3.4"` exactly, so the pin has to be edited as well. The real checkout was not modified (`git status` is clean, HEAD is still `ab732f5`).

## Required repair (finding `logger-require`, executed)
- **Cause (from source):** concurrent-ruby 1.3.5 stopped loading Ruby's `logger` library (commit d7ce956, `lib/concurrent-ruby/concurrent/concern/logging.rb`). Rails 7.0.8.7 uses `Logger` without loading it itself (`active_support/logger_thread_safe_level.rb:12`).
- **Observed failure:** after the bump, the boot, eager-load, routes, database and tests checks all failed with this error:
  `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  Log: `/tmp/gem-upgrade-20261014-8309-jxdbsj/runs/20261014T154202-d525ce-unmodified-boot/output.log`
- **Fix:**
  1. In `config/boot.rb`, add `require "logger"` straight after `require "bundler/setup"`.
  2. Change the Gemfile pin to `"1.3.8"` and run `bundle update concurrent-ruby --conservative`.

  Nothing else in the lock changes. The `logger` gem (1.7.0) is already locked.
- **Works on the current version:** the added line does nothing harmful on 1.3.4, so it can ship first.
- **Stored data and rollback:** no stored or queued data formats are involved. To roll back, revert the Gemfile and lock; the boot line can stay.
- **Longer term:** Rails 7.1 and later loads `logger` itself, so the line becomes unnecessary after a Rails upgrade.

## Validation (executed)
- **Probe:** `/home/user/planner-run/probes/logger_probe.rb`, run with `bin/rails runner`. It checks three things:
  - a logger at warn level keeps the warn message and drops the debug one;
  - a temporary level set in one thread only affects that thread;
  - concurrent-ruby's own simple logger filters by level.
- **Results:**
  - **Baseline (1.3.4):** passes, which also serves as the control.
  - **1.3.8 without the fix:** fails with the same NameError (`.../runs/20261014T154257-63d279-probe-logger-unrepaired/output.log`).
  - **1.3.8 with the fix:** passes.
- **Other entry points**, all passing on both copies:
  - `bin/rails -T` (rake);
  - a Sidekiq-style load of `config/environment`;
  - a production-mode `eager_load!` with a throwaway secret, which confirmed `Logger::Formatter` loads;
  - `bin/citation-provider`, which doesn't load Rails.
- **Full checks:** boot, eager-load, routes, database and tests all pass with the fix (`/tmp/gem-upgrade-20261014-8309-jxdbsj/runs/*repaired-*`).

## Behavior note (finding `pool-pruning-behavior`, from source only, nothing required)
In 1.3.6, idle thread-pool workers began shutting themselves down after their idle timeout (#1082), and `prune_pool` became a deprecated method that does nothing. The app never uses `Concurrent::` directly; it only reaches this through Rails, i18n, tzinfo and sprockets.

Proposed check (not run): run Puma and Sidekiq in staging on 1.3.8, send steady traffic, then leave it idle for over 60 seconds. Confirm there are no `prune_pool` deprecation warnings and latency is unchanged, compared against the same run on 1.3.4.

The other changes in 1.3.6–1.3.8 are ordinary bug fixes and were set aside, with no impact found for this app:
- TimerTask can restart safely.
- ReadWriteLock, ReentrantReadWriteLock and AtomicReference fixes.
- A fix for the duplicate `cached_thread_pool` require.
- No Fiber is created at load time.
- Changes to the C extension, which isn't bundled.
- Future backtraces now use backtrace locations, but only on Ruby 3.4+ (the app is on 3.3.6).

## Optional defaults
None; `defaults.json` is empty.

## Rollout order
1. Ship the `require "logger"` line on 1.3.4.
2. Bump the Gemfile pin and lock to 1.3.8.
3. Deploy Puma and Sidekiq together.
4. Watch boot and the logs.

## Limits
- System tests (`bin/rails test:system`) were not run.
- Puma and Sidekiq were never run under real load.
- The GitHub release notes for 1.3.6–1.3.8 were not fetched; the changelog only links to them. I read all 46 commits between v1.3.4 and v1.3.8, plus the full `lib` diff, instead.
- Testing intermediate versions wasn't needed, because the break was traced to 1.3.5 in source and reproduced.
- The isolation notes are in `/tmp/gem-upgrade-20261014-7052-4h3ark/isolation.md`. Test mode uses the local fake citation provider, the `:test` job queue, a null cache and disk storage inside the lab.

## Files
- Evidence and closed review: `/home/user/planner-run/evidence-concurrent/` (`review.json`, `coverage.json`, `dependencies.tsv`). The review check printed "Review closed: 2 candidates, 2 findings, 5 limits."
- Labs (services cleaned up, run logs kept):
  - baseline copy: `/tmp/gem-upgrade-20261014-7052-4h3ark`
  - upgraded copy: `/tmp/gem-upgrade-20261014-8309-jxdbsj`
- Probe and helper script: `/home/user/planner-run/probes/logger_probe.rb`, `/home/user/planner-run/scripts/fill_review.rb`

---

That's the plan. I haven't changed your repository. The upgrade is two edits: add `require "logger"` to `config/boot.rb`, and change the Gemfile pin to `1.3.8` and update the lockfile. Without the first edit, the app won't boot on Rails 7.0. Do you want me to make both changes and run the test suites?