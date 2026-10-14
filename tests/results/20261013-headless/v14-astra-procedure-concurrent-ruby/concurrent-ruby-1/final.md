# concurrent-ruby 1.3.4 to 1.3.8 upgrade plan for Margin Notes

Changing only the version pin breaks the app. Every process that loads Rails through `config/boot.rb` stops at startup. One line in `config/boot.rb` fixes it. I tested that line on both 1.3.4 and 1.3.8, so it can ship before the version bump. I did not edit or run anything in `/home/user/workspace/repo`, and its file hashes were unchanged after the work.

## Required change (F1, tested)

**What breaks:** concurrent-ruby 1.3.5 stopped loading Ruby's `logger` library (changelog #1062, commit d7ce956dacd0). Rails 7.0.8.7 (Active Support) depended on that. With 1.3.8, startup fails with:

`activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`

The automated check stopped at boot, so database setup, eager loading, routes and tests never ran on the unchanged upgrade. My test script got the same error from `bin/rails runner`, from loading `config.ru`, and from a plain `require "active_support/logger"`. Loading the app the way Sidekiq does (`require "sidekiq/cli"`, then `config/environment`) still worked, because Sidekiq 6.5 loads `logger` itself.

**Fix:** in `config/boot.rb`, put this line right after `require "bundler/setup"` and before `require "bootsnap/setup"`:

```ruby
require "logger"
```

Then change `Gemfile:8` to `gem "concurrent-ruby", "1.3.8"` and run `bundle update concurrent-ruby --conservative`. No Rails 7.0 release fixes this on its side, and the plan leaves Rails at 7.0.8.7, so the line in `boot.rb` is the fix.

**Results:**

| Copy | Boot, db:prepare, eager load, routes | Tests | Entry-point checks |
| --- | --- | --- | --- |
| 1.3.4, unchanged | pass | 46 runs, 0 failures | all 5 exit 0 |
| 1.3.8, unchanged | boot fails (`NameError`) | not reached | A, C, D, E fail; B (Sidekiq-style) passes |
| 1.3.8 with the fix | pass | 46 runs, 325 assertions, 0 failures | A–D pass; prints `concurrent=1.3.8 logger="constant"`, `future=42` |
| 1.3.4 with the fix | pass | 46 runs, 0 failures | all 5 exit 0 |

Check E (loading Active Support without going through `boot.rb`) still fails on 1.3.8 even with the fix. Nothing in the app does that: `bin/citation-provider` loads only bundler and rack, and `bin/rails` goes through `boot.rb`.

**Rollout:**
1. Deploy the `boot.rb` line on 1.3.4. It is tested as harmless there.
2. In a separate deploy, bump the Gemfile and lockfile. Restart Puma, the Sidekiq workers and any one-off runners together.

**Rollback:** revert only the Gemfile and lockfile. Keep the `boot.rb` line. The bump changes no stored data, cookies, cache entries or job payloads.

## Rollout risk (F2, source review only)

The app's own code (`app/`, `lib/`, `config/`) never uses concurrent-ruby directly. Rails, Action Cable, Active Job, Active Record, sprockets, i18n and tzinfo do. Changes that reach those paths:
- Idle thread-pool workers now shut themselves down on a timer (572d44c4).
- A timer task restarted after shutdown no longer runs twice (4dc8de3f).
- Timer sets shut down more cleanly (048f5d05).
- Read/write locks now raise an error when released wrongly (3fd49328, 7e4d711b). No installed gem was found releasing them that way.
- The Promises backtrace change (cc5a32fe) only applies on Ruby 3.4 and later; the app runs 3.3.6.

No code change is needed. After deploy, watch Action Cable heartbeats, thread counts, and any `prune_pool has no effect` deprecation warnings. Only one check here actually ran: a Promises future returned 42 on all variants. I wrote out a staging check for Action Cable on Redis plus a Sidekiq worker, but did not run it.

## Defaults and dependencies

- **Lockfile:** only concurrent-ruby moves. `logger 1.7.0` is already locked through other gems. No other dependency changed, so I skipped the dependency research step.
- **Framework defaults:** there are none for this gem.
- **Ruby:** the app uses 3.3.6; 1.3.8 needs Ruby 2.3 or later.

## Limits and unexecuted checks

- **Release notes not read:** the changelogs for 1.3.6–1.3.8 only link to GitHub release notes, which I did not download. I read all 46 commits between the exact tags instead.
- **Not run:**
  - The browser (Chrome) tests.
  - A production-environment boot.
  - A real Puma server, a Sidekiq worker process, or Action Cable on Redis.
- **Test settings:** all lab stages ran with `RAILS_ENV=test` and one test worker.
- **Misleading "passed" lines:** the report shows each probe run as "passed, exit 0" because the wrapper script always exits 0. The per-check results above come from the probe logs.
- **Existing tests:** passing the current test suite does not on its own show the upgrade is safe.
- **Ruby setup:** the planner scripts needed `MISE_RUBY_VERSION=3.3.6` set to find Ruby, and mise printed "not trusted" warnings in the copies.

## Files

All paths are in `/tmp/gem-upgrade-20261014-71610-yke44q/`. Copies, logs and Redis data are kept; the lab-owned databases were removed.
- Plan: `plan.json`
- Sources: `sources/index.md`, `sources/manifest.json`, `sources/repositories/b553fa513ad8/` (commit patches)
- Probe script: `probes/entrypoints.sh`
- Run records:
  - `runs/baseline/006-tests.json`
  - `runs/v1_3_8/003-boot.json`
  - `runs/v1_3_8/004-probe.log`
  - `runs/v1_3_8_logger/006-tests.json`
  - `runs/v1_3_8_logger/007-probe.log`
  - `runs/baseline_logger/007-probe.log`
- Fixed copies: `variants/v1_3_8_logger/app/config/boot.rb`, `variants/baseline_logger/app/config/boot.rb`
- Unfixed copy, kept for comparison: `variants/v1_3_8/`

---

**My notes:** The plan above is the planner's report, so "I" in it means the planner. Nothing in your repo has changed yet. The upgrade skill only plans; it doesn't apply changes. The main point is that bumping the version alone would stop the app from booting, and adding `require "logger"` to `config/boot.rb` fixes it. Should I make the two changes in the order the plan gives? The browser tests and a production boot still haven't been run.