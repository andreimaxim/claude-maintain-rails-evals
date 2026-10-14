## Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Ruby 3.3.6, Rails 7.0.8.7)

**Verdict:** The upgrade is safe only with one required change. Without it the app does not boot at all. With it, every lab check passes.

### Required repair (F1: Logger is no longer loaded)
- **Cause (from source):** concurrent-ruby 1.3.5 dropped its `require 'logger'` (commit d7ce956, #1062, in `lib/concurrent-ruby/concurrent/concern/logging.rb`). Active Support 7.0.8.7 uses `Logger` in `active_support/logger_thread_safe_level.rb:12` without loading it, so it had been relying on concurrent-ruby to do that.
- **Observed failure (I ran it):** in the unmodified upgrade, the boot, eager-load, routes, database and tests checks all failed with:
  `logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  Log: `/tmp/gem-upgrade-20261014-8279-bp4s0u/runs/20261014T154115-d46990-unmodified-boot/output.log`
- **Repair:** in `config/boot.rb`, add `require "logger"` straight after `require "bundler/setup"`. That position makes Ruby load the locked logger 1.7.0 gem. No Gemfile change is needed, because mail, sprockets, rbs and selenium-webdriver already keep logger 1.7.0 in the lock.
- **Works on the current version (reasoned, not run on the baseline):** the line is harmless if Logger is already loaded, and logger 1.7.0 is already active on 1.3.4. You can merge it before the bump.
- **Stored data and rollback:** no stored or queued formats change. To roll back, revert the lockfile; the boot line can stay.

### Validation I ran
- **Full checks:** the original app on 1.3.4 passed all checks. The upgraded copy with the repair also passed all of them (`.../runs/20261014T154139-22602d-repaired-tests`).
- **Probe:** `/home/user/planner-run/probes/logger_boot_probe.rb`
  - **Setup:** boot `config/environment`.
  - **Assertions:** Rails logger filtering with different messages per level (debug hidden, warn shown, and `silence` blocks output); concurrent-ruby's own simple logger filtering; and the error from a rejected `Promises` future.
  - **Results:**
    - Original app on 1.3.4: PASS (`/tmp/gem-upgrade-20261014-7052-hq2e77/runs/20261014T154208-3ab780-probe-base`)
    - Upgrade without the repair: FAIL with `BOOT_FAIL NameError: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger` (`/tmp/gem-upgrade-20261014-8279-bp4s0u/runs/20261014T154210-c0979e-probe-norepair`)
    - Upgrade with the repair: PASS, with the same logger behaviour as 1.3.4 (`.../runs/20261014T154209-324042-probe-repaired`)

### Other upstream changes that don't affect this app (from reading the source)
I read all 46 commits and the full library diff:
- **`ReadWriteLock` release methods now raise if the caller doesn't hold the lock:** nothing in the app or its locked gems uses `Concurrent::ReadWriteLock`.
- **`ReentrantReadWriteLock` now raises if one thread re-takes the read lock more than 32,768 times:** ActionView's template-reload check uses this lock, but always takes and releases it in pairs.
- **Thread pools now remove idle threads in the background; `TimerTask` can be restarted; single-thread executors are marked as serial:** these are internal to Active Record, Action Cable and the async job adapter. The app runs jobs on Sidekiq, tests use the test adapter, and the suite passes.
- **Error backtraces from rejected futures now keep location objects:** this only applies on Ruby 3.4 or later, and the app is on 3.3.6. The probe confirmed rejected futures behave the same.
- **Also checked:** the `Float::NAN` fix in `AtomicReference`, `Concurrent::NULL` now being frozen, the struct-member fix, not creating a Fiber at load, and C-extension changes (that gem isn't locked).
- **Dependencies:** only concurrent-ruby moved, from the same rubygems source. No gems were added or removed.

### Optional settings
concurrent-ruby has no configuration defaults to adopt.

### Rollout order
1. Merge the `require "logger"` line in `config/boot.rb` on 1.3.4.
2. Update concurrent-ruby to 1.3.8 (`bundle update --conservative concurrent-ruby`).
3. Run the tests, system tests and a production boot.
4. Deploy web and Sidekiq together. Both boot through `config/environment` and `config/boot.rb`.

### Not run (proposed checks)
- **System tests and production-mode boot:** not run in the lab. Proposed check: boot with `RAILS_ENV=production` and start `bundle exec sidekiq` in staging with the repaired `boot.rb`. Expect no NameError, and compare against the same startup on 1.3.4.
- **Development-mode template reloading:** the excluded read-lock change is based on reading the code; I didn't exercise it.
- **Thread-pool changes:** not load-tested.
- **Release notes:** the GitHub release notes for 1.3.6–1.3.8 weren't fetched; I used the commit history instead. I also didn't bump to each in-between version separately, because the logger commit shows the break starts at 1.3.5.

### Files
- Evidence: `/home/user/planner-run/evidence-concurrent-ruby/` (`review.json`, `coverage.json`, `entries.tsv`, `dependencies.tsv`, `upstream/`). `gem-upgrade-review check` passes, but that only confirms the file is complete, not that the conclusions are right.
- Probe: `/home/user/planner-run/probes/logger_boot_probe.rb`
- Labs (services cleaned up, logs kept): `/tmp/gem-upgrade-20261014-7052-hq2e77` (original app) and `/tmp/gem-upgrade-20261014-8279-bp4s0u` (upgraded copy with the repair).

The real checkout at `/home/user/workspace/repo` is unchanged: `git status` is clean and HEAD is still ab732f5.

---

The plan above came from the planning agent. I haven't re-run its checks myself. Your repo is still on concurrent-ruby 1.3.4.

**The upgrade isn't done yet.** The upgrade skill only produces a plan. The key finding: bumping to 1.3.8 by itself makes the app fail to boot. Adding one line, `require "logger"` in `config/boot.rb`, fixes that. Should I make that change, bump the gem, and run `bin/rails test` and `bin/rails test:system`?