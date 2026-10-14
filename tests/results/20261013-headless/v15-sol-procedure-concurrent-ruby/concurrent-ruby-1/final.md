## Upgrade plan: concurrent-ruby 1.3.4 → 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

**Verdict:** The upgrade is safe with one required one-line repair. With only the version bump, the app does not boot in any environment. With the repair, every lab check passes: bundle, boot, eager-load, routes, database and tests. No stored data or queued formats change. The real checkout is unchanged: `git status` is clean and HEAD is still `ab732f5`.

### Required repairs
1. **Gemfile:** change `gem "concurrent-ruby", "1.3.4"` to `"1.3.8"`, then run `bundle update concurrent-ruby --conservative`. In the lab, only `concurrent-ruby` moved in Gemfile.lock.
2. **F1, `config/boot.rb`:** add `require "logger"` right after `require "bundler/setup"`. This is the one recommended repair.
   - **Cause:** concurrent-ruby 1.3.5 (upstream commit `d7ce956`, changelog #1062) removed `require 'logger'` from `concurrent/concern/logging.rb`. Rails 7.0.8.7 uses `::Logger` at `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12` without requiring it, and was relying on concurrent-ruby to load it.
   - **Observed failure:** `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`, from `bin/rails:4`. Log: `/tmp/gem-upgrade-20261014-8256-m0wbil/runs/20261014T154117-be9462-unmodified-boot/output.log`. The eager-load, routes, database and tests checks failed with the same error.
   - **No new gem needed:** `logger 1.7.0` is already in the lock (through `mail`).
   - **Works on the current version:** the require is harmless on 1.3.4, so it can ship before the bump.
   - **Data and rollback:** nothing stored changes. To roll back, revert the Gemfile and lock; the require line can stay.

### Optional defaults
None. `defaults.json` is empty, and this gem has no Rails framework defaults. `load_defaults 7.0` stays as it is.

### Rollout order
1. Deploy the `require "logger"` change while still on 1.3.4.
2. Deploy the version bump.
3. Watch Puma and Sidekiq boot logs and thread counts.

Rollback is just reverting the lock; there are no data steps.

### Per-finding evidence and validation
- **F1 (required): executed.** I wrote a boot probe outside the app (`/home/user/planner-run/probes/logger_boot_probe.rb`). It boots the app, checks that the logger filters by level (info hidden, warn shown), and reads `User.count`. I ran it in both test and production mode:

  | Lab | Result |
  |---|---|
  | Baseline (1.3.4) | `BOOT_OK` |
  | Upgraded, without the repair | `BOOT_FAIL NameError … logger_thread_safe_level.rb:12` |
  | Upgraded, with the repair | `BOOT_OK concurrent=1.3.8` |

  - In production mode, `Logger::Formatter` resolves.
  - Control: `users=2` and the same log output on every run.
  - The full `repaired` check passes; its runs are under `/tmp/gem-upgrade-20261014-8256-m0wbil/runs/20261014T1541{50,52,54,55}-*`.
- **F2 (rollout note, nothing to fix): executed.** Since 1.3.6 (#1082), idle thread-pool workers shut down after their idle time on their own. Before, they were only cleaned up when new work arrived.
  - Probe `pool_prune_probe.rb`: on 1.3.4, `min0_after_idle=2`; on 1.3.8, `min0_after_idle=0`. The control pool with a minimum of 2 threads kept 2 on both.
  - Where it matters here: the Action Cable worker pool and timer tasks in production (Turbo streams). The Active Job async adapter is unused (the app uses Sidekiq), and the Active Record async executor is not configured.
  - Expect fewer idle threads, with threads recreated on the next burst of work.
  - **Proposed, not run:** a production smoke test for this.
    - Setup: open two Turbo-stream sessions on one note.
    - Action: leave them idle for more than 60 seconds, then update the note.
    - Assertion: both sessions receive the broadcast.
    - Control: the same steps against the current release.
- **Excluded, based on upstream source only (not run):**
  - `ReadWriteLock` now raises an error when releasing a lock the thread doesn't hold. Nothing in the app or Rails 7.0 uses it.
  - `ReentrantReadWriteLock` only gains an overflow guard (Rails' ActionView cache expiry uses it).
  - The TimerTask restart fix and `TimerSet` kill/shutdown changes are fixes only.
  - `prune_pool` becomes a deprecated no-op, and nothing calls it.
  - Smaller fixes (`NULL` frozen, struct ancestor fix, NaN livelock, Ractor support for `Map#compute_if_absent`) have no caller here that depends on the old behaviour.
  - C extension, JRuby, edge and CI changes don't apply to this app.

### Lab environment changes
I changed lab configuration only. In the lab copies, I set the Action Cable test adapter back to `test`, because the harness had switched it to Redis. Sidekiq used the lab's own Redis databases (15 and 14). Tests use a local citation-provider stand-in, so there were no external HTTP calls. These overrides are recorded in each lab's `isolation.md`.

### Limits
- I didn't read the GitHub release notes for 1.3.6–1.3.8 because the changelog only links to them. I reviewed all 46 commits from v1.3.4 to v1.3.8 instead, including the `lib/` diff.
- Browser (system) tests were not run.
- Production mode was only checked by booting the app in the lab. I did not start Puma or a Sidekiq server under load. Sidekiq loads `config/boot.rb`, so I expect the repair to cover it, but that wasn't run.
- I didn't install 1.3.5–1.3.7 one at a time to confirm where the failure starts. Upstream source places it in 1.3.5.

### Files
- Evidence: `/home/user/planner-run/evidence-concurrent-ruby/` (`review.json` passed `gem-upgrade-review check`; also `coverage.json`, `dependencies.tsv`, `upstream/`)
- Probes: `/home/user/planner-run/probes/logger_boot_probe.rb`, `/home/user/planner-run/probes/pool_prune_probe.rb`
- Labs (services cleaned up, files kept): baseline `/tmp/gem-upgrade-20261014-7058-hkpnlh`, upgraded `/tmp/gem-upgrade-20261014-8256-m0wbil`

---

This is a plan only. The upgrade skill doesn't make changes, so your working tree is untouched. Bumping only the version breaks app boot, so the `require "logger"` line in `config/boot.rb` is required. Browser tests and a real Puma/Sidekiq run weren't covered. If you want, I can make the two changes (the boot repair and the Gemfile/lock bump) on a branch and run `bin/rails test` and `bin/rails test:system`.