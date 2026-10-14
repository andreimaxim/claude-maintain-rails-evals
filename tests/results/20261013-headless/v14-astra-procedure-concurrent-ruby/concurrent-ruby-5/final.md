# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes)

The bump alone stops the app from starting. Adding one line to `config/boot.rb` fixes it. With that line, boot, database preparation, eager loading, routes and `bin/rails test` (46 runs, 325 assertions, 0 failures) pass on both 1.3.4 and 1.3.8. Only concurrent-ruby moves in the lockfile; no other gem changes version. All work ran in lab copies, and the source hashes of `/home/user/workspace/repo` are unchanged.

## Required change (F1): Rails 7.0 crashes at startup

- **Cause:** concurrent-ruby 1.3.5 stopped loading Ruby's `logger` library (changelog #1062, commit d7ce956dacd0). Rails 7.0.8.7 uses `Logger` before loading it, and relied on concurrent-ruby to do so.
- **What happens:** every Rails entry point fails before the app starts. That includes `bin/rails`, `rails runner`, Puma through `config.ru`, and the tests. The error observed in the lab:
  `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
- **Repair:** in `config/boot.rb`, add this line right after `require "bundler/setup"` and before `require "bootsnap/setup"`:
  ```ruby
  require "logger"
  ```
  Then change the Gemfile pin to `gem "concurrent-ruby", "1.3.8"`.
- **Other paths:**
  - Starting Sidekiq loads `sidekiq` before the Rails environment, which loads `logger` itself. That path boots on 1.3.8 even without the repair.
  - `bin/citation-provider` does not load Rails, so it is unaffected.
- **Works on the current version:** the same line on 1.3.4 passes the full check and all three boot probes.
- **Rollout:** ship the `boot.rb` line first while still on 1.3.4, then ship the gem bump.
- **Rollback:** revert only the Gemfile and Gemfile.lock change and keep the `require`. No stored data, cookies or queued jobs are involved.

I ran the same probe (`/tmp/gem-upgrade-20261014-71517-bkwdyx/probes/boot_probe.sh`) on four lab copies. A1 loads `config.ru` (the Puma path), A2 loads Sidekiq and then the app, and A3 uses `rails runner`.

| Copy | A1 (config.ru) | A2 (Sidekiq first) | A3 (rails runner) |
| --- | --- | --- | --- |
| 1.3.4, unchanged | passes | passes | passes |
| 1.3.8, no repair | fails with the NameError | passes | fails with the NameError |
| 1.3.8 with the `require` line | passes | passes | passes |
| 1.3.4 with the `require` line | passes | passes | passes |

## Source review

- All 46 commits between the v1.3.4 and v1.3.8 tags were read. Apart from the logger removal, the changes cover:
  - thread pools (background pruning)
  - restarting a `TimerTask`
  - `ReadWriteLock` (releasing a lock from the wrong thread now raises `IllegalOperationError`)
  - a `ReentrantReadWriteLock` overflow fix
  - an `AtomicReference` fix for `Float::NAN`
  - exception backtraces on Ruby 3.4
  - Ractor support for `Concurrent::Map`
- A search of `app`, `lib` and `config` found no direct use of `Concurrent`, the read/write locks or `TimerTask`. Rails, Sidekiq and Puma still use the gem internally, and that is covered only by the existing test suite.
- concurrent-ruby 1.3.8 needs Ruby 2.3 or later; the app uses 3.3.6.
- No framework defaults were collected for this upgrade.
- There were no gaps in source collection. However, the changelog entries for 1.3.6–1.3.8 only point to GitHub release notes, which I did not fetch; I read the commits instead.

## Not checked

- `bin/rails test:system` (the browser suite) was not run on any copy.
- I did not boot the production environment or run a long-lived Puma or Sidekiq worker. Thread-pool, timer and lock behavior inside Rails, Sidekiq and Puma under real load is backed only by the source review and the existing tests.

Lab databases were removed at cleanup.

## Files

- Plan JSON: `/tmp/gem-upgrade-20261014-71517-bkwdyx/plan.json`
- Lab: `/tmp/gem-upgrade-20261014-71517-bkwdyx`; run records are in `runs/`, and the copies `baseline`, `v1_3_8`, `v1_3_8_logger` and `baseline_logger` are in `variants/`.
- Key run records, under `/tmp/gem-upgrade-20261014-71517-bkwdyx/runs/`:
  - `v1_3_8/003-boot.json` (boot failure)
  - `v1_3_8/004-probe.json`
  - `v1_3_8_logger/006-tests.json`
  - `v1_3_8_logger/007-probe.json`
  - `baseline/007-probe.json`
  - `baseline_logger/007-probe.json`
- Sources: `/tmp/gem-upgrade-20261014-71517-bkwdyx/sources/index.md`

---

The upgrade isn't applied yet, and your repo is unchanged; the planner worked only in throwaway copies. To apply it, two edits are needed: add `require "logger"` to `config/boot.rb`, and change the Gemfile pin to 1.3.8 and update the lockfile. Without the first edit, the app won't start on 1.3.8. The browser tests (`bin/rails test:system`) weren't run. Let me know if you want me to make the change.