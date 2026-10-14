## Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

**Verdict:** The upgrade works, but needs one required one-line repair. Without it the app can't boot at all. With it, every check I ran passes. Nothing is stored or queued in a new format, and there are no defaults to adopt.

### Required repair (F1, tested in a lab)
- **Failure seen with 1.3.8 and the original code.** Boot, eager load, routes, database and tests all failed with the same error:
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  Log: `/tmp/gem-upgrade-20261014-8232-4zk15i/runs/20261014T154109-974a44-unmodified-boot/output.log`
- **Cause (from upstream source).** In 1.3.5, upstream commit d7ce956 ("Remove dependency on logger", #1062) dropped `require 'logger'` from `concurrent/concern/logging.rb`. Active Support 7.0 uses `::Logger` without requiring it, so it had only worked because concurrent-ruby loaded it first.
- **First affected release:** 1.3.5. A separate copy bumped only to 1.3.5 fails boot the same way (`/tmp/gem-upgrade-20261014-8626-kvwn9z/runs/20261014T154155-0553db-v135-boot`).
- **Repair.** In `config/boot.rb`, add this line directly after `require "bundler/setup"`:
  ```ruby
  require "logger"
  ```
  It covers every way the app starts: `bin/rails`, rake, Puma through `config.ru`, Sidekiq and the tests. No pin or Gemfile entry is needed, because logger 1.7.0 is already installed through mail, sprockets, rbs and selenium-webdriver.
- **Works on the current version:** yes. The line has no effect under 1.3.4, so it can ship first.
- **Stored data and rollback:** nothing stored changes. To roll back, revert the Gemfile and lockfile. The boot line is harmless to leave in place.

### What was run
- **Full check on the repaired upgrade copy:** all steps pass, including 46 runs, 325 assertions, 0 failures. That is the same count as the baseline. Log: `/tmp/gem-upgrade-20261014-8232-4zk15i/runs/20261014T154142-9bf9ff-repaired-tests`
- **Probe:** `/home/user/planner-run/probes/logger_probe.rb`. It checks that:
  - an Active Support logger at info level keeps the "kept-2" line and drops the "dropped-3" debug line;
  - concurrent-ruby's own logger keeps an ERROR message and drops an INFO one;
  - `Sidekiq.logger` is a `::Logger`.

  The unchanged control is `Concurrent::Map#compute_if_absent`, which must keep the first value (41, not 99).

  | Copy | Result | Run |
  |---|---|---|
  | Baseline, 1.3.4 | PASS | `...7019-2osolt/runs/*probe-logger` |
  | 1.3.8 without the repair | FAIL, same NameError | `...8232-4zk15i/runs/20261014T154211-0daa9c-probe-logger-norepair` |
  | 1.3.8 with the repair | PASS (`concurrent-ruby=1.3.8 logger=1.7.0`) | `...8232-4zk15i/runs/20261014T154212-b67845-probe-logger-repair` |

- **Production-environment eager load** on the repaired copy: PASS (`.../runs/20261014T154213-030264-prod-eager`).

### Upstream changes ruled out (from reading the code, not tested)
I read all 46 upstream commits between v1.3.4 and v1.3.8 and the full `lib/` diff. None of these affect the app, which never calls `Concurrent::` itself:
- **Thread pool cleanup:** idle threads are now removed in the background, and `prune_pool` is deprecated. Neither the app nor its gems call `prune_pool`.
- **TimerTask restart guard:** Action Cable's `stream_event_loop` creates timer tasks but never restarts them.
- **Read/write locks:** `ReadWriteLock` now raises if released while not held, and `ReentrantReadWriteLock` got an overflow fix. Action View's `cache_expiry` uses only the paired lock helpers.
- **Other changes:** the AtomicReference NaN fix, the Promises backtrace change (Ruby 3.4 and later only), the Map Ractor fix, the Struct ancestor fix, and `executors.rb` no longer loading `cached_thread_pool`. Nothing in the bundle uses these.
- **Dependencies:** only concurrent-ruby moves. Nothing is added, removed or switched to a different source.

### Optional defaults
None. `defaults.json` is empty.

### Rollout order
1. Ship the `config/boot.rb` line on 1.3.4. This is safe and matches the baseline.
2. In a second change, edit the exact pin in the Gemfile (`gem "concurrent-ruby", "1.3.4"` to `"1.3.8"`) and run `bundle update concurrent-ruby --conservative`.
3. Deploy the web and Sidekiq processes together. No data migration is needed.

### Proposed checks (not run)
- **Browser tests (`bin/rails test:system`).** Setup: the repaired upgrade copy. Action: run the suite. Assertion: same results as on the baseline. Control: the baseline run.
- **Real Sidekiq and Puma processes in production mode.** Setup: start both. Action: queue `CitationEnrichmentJob`. Assertion: the job completes and both logs show the info line. Control: the same flow on 1.3.4.

### Limits
- GitHub release notes for 1.3.6 to 1.3.8 were not fetched; I read the commits instead.
- The C and Java extension changes were not reviewed. They don't apply here (MRI, no `concurrent-ruby-ext`).
- The thread-pool timing changes were not tested under load.

### Files
- Evidence directory: `/home/user/planner-run/evidence-concurrent-ruby/`. The review record, `review.json`, passes the structural check.
- Lab copies: baseline `/tmp/gem-upgrade-20261014-7019-2osolt`, upgrade `/tmp/gem-upgrade-20261014-8232-4zk15i`, 1.3.5 copy `/tmp/gem-upgrade-20261014-8626-kvwn9z`. Their services are cleaned up and their logs kept.
- The real checkout is unchanged: `git status` is clean at ab732f5.

---

The upgrade isn't applied yet. The upgrade skill only writes a plan and tests it in copies of the app, so your repo is unchanged. The main point: going to 1.3.8 on its own stops the app from booting with a `NameError`. Adding `require "logger"` to `config/boot.rb` fixes that, and with that line the copy passed the same tests as before the upgrade.

If you'd like me to apply it, I'll make the two changes in rollout order (the boot line first, then the Gemfile and lockfile bump) and run `bin/rails test` and `bin/rails test:system`.