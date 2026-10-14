# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

## Verdict
You can upgrade, but only together with one required repair. Bumping the gem alone breaks every Rails entry point. With a one-line change to `config/boot.rb`, all lab checks passed: boot, eager-load, routes, database, unit and integration tests, rake, a production-mode runner and asset precompilation. Only concurrent-ruby moves in the lock. Version 1.3.4 was confirmed in `Gemfile.lock`, and the Gemfile pins it exactly (`gem "concurrent-ruby", "1.3.4"`), so the Gemfile line has to change as well.

## Required repair (finding F1)
- **Cause (from upstream code):** release 1.3.5 (#1062, commit d7ce956) removed `require 'logger'` from `lib/concurrent-ruby/concurrent/concern/logging.rb`. Rails 7.0.8.7 was relying on that line to load `Logger` before its own code uses it.
- **Failure seen in the lab (U, unmodified):** `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`.
  - Boot, eager-load, routes, database and tests all failed. Logs are in `/tmp/gem-upgrade-20261014-8259-dz0p4a/runs/*-unmodified-*/output.log`.
  - A second unrepaired copy (U0, `/tmp/gem-upgrade-20261014-8699-g90pjj`) also failed `bin/rake about` and the production runner.
- **Fix:** in `config/boot.rb`, directly after `require "bundler/setup"`, add:
  ```ruby
  require "logger"
  ```
- **Works on the current version (reasoned from source, not run):** `logger` 1.7.0 is already in the lock and requiring it twice is harmless. The line can ship before the bump.
- **Stored data and rollback:** no stored or queued formats change. Rollback means reverting the Gemfile and lock; the `boot.rb` line can stay.
- **Rejected alternatives:** keeping the pin below 1.3.5 (that is the current state) and upgrading Rails (outside this task).

## Validation (run in the labs)
- **Probe:** `/home/user/planner-run/probes-concurrent/logger_probe.rb`, using unequal data: an info message should be hidden, an error shown, and a warning silenced inside `silence`.

| Copy | Result |
|---|---|
| Baseline (B, 1.3.4) | `AS_LOGGER_OK=true OUT="shown-error\n"` |
| U0 (1.3.8, no repair) | NameError (the one above) |
| U (1.3.8 with repair) | Same output as baseline |

- **Control:** running the probe without loading `config/boot.rb` still raises the NameError on U, which shows the new line is what fixes it. A `Concurrent::Map` check gave the same result (`CONTROL_MAP=1`) on 1.3.4 and 1.3.8.
- **Other checks on U with the repair:** the full repaired check passed, as did `bin/rake about`, the production runner with eager loading, and `assets:precompile` (43 assets, same as baseline).
- **Sidekiq:** it booted on all three copies, including U0, because Sidekiq loads `logger` itself. Those runs show `exit 124` only because I stopped them with `timeout 15`.

## Other upstream changes (read in source; none need app changes)
The changelogs for 1.3.6–1.3.8 only link to GitHub release notes, so I read all 46 commits and the `lib/` diff instead. The application code never calls concurrent-ruby directly; Rails, Sprockets and Sidekiq do.
- **Thread-pool pruning:** idle workers are now removed on their own timer, and `prune_pool` is deprecated and does nothing. This affects Rails' async query executor, the Action Cable worker pool and the Active Job async adapter. Nothing calls `prune_pool`. Expect idle thread counts to shrink sooner, which is harmless.
- **`ReadWriteLock`:** it now raises `IllegalOperationError` when the wrong thread releases a lock. Rails 7.0 doesn't use this class; it only uses `ReentrantReadWriteLock` (in Action View's cache expiry), which got only an overflow fix.
- **Other fixes:** shutdown changes in `TimerSet`/`TimerTask`, a fix for `AtomicReference` livelocking on `Float::NAN`, Ractor support for `Map#compute_if_absent`, and `Promises` backtrace changes that only apply on Ruby 3.4 or later.
- **Optional defaults:** there are none to adopt (`defaults.json` is empty).

## Rollout order
1. Ship the `require "logger"` line in `config/boot.rb` on 1.3.4.
2. Change the Gemfile to `gem "concurrent-ruby", "1.3.8"` and run `bundle update concurrent-ruby` (only that gem moves).
3. Run the full test suite and the system tests, and boot web, Sidekiq and rake in production mode.
4. Deploy web and workers together. Nothing needs migrating.

## Limits
- System tests were not run, and the development-mode server was not booted.
- The thread-pool pruning change was checked by reading the source and running the test suite only, not under load.
- The repair was not run against 1.3.4 itself.
- GitHub release notes for 1.3.6–1.3.8 were not fetched; the commits were read instead.

## Files
- Evidence and closed review: `/home/user/planner-run/evidence-concurrent/` (`review.json`; `gem-upgrade-review check` reports "Review closed: 2 candidates, 1 findings, 5 limits").
- Probe: `/home/user/planner-run/probes-concurrent/logger_probe.rb`
- Labs (services cleaned up, evidence kept): B `/tmp/gem-upgrade-20261014-7021-ka0hsq`, U `/tmp/gem-upgrade-20261014-8259-dz0p4a`, U0 `/tmp/gem-upgrade-20261014-8699-g90pjj`
- The real checkout `/home/user/workspace/repo` is unchanged: `git status` is clean at ab732f5.

---

This is a plan only. Nothing has been changed in your repository. The upgrade needs three changes: add `require "logger"` to `config/boot.rb`, change the Gemfile pin to 1.3.8, and run `bundle update concurrent-ruby`. Before merging, run the system tests (`bin/rails test:system`), which the plan didn't run. Want me to make the changes?