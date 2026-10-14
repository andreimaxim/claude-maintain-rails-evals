# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes)

The upgrade needs one code change. If you only bump the version, the app won't start at all: the web server, Sidekiq workers, `rails runner`, rake/db tasks and the tests all crash while loading. Adding one line fixes it. With that line, the app starts, `db:prepare`, eager loading and routes all succeed, and the test suite passes (46 runs, 325 assertions, 0 failures). Nothing in the original checkout was changed.

## Required change: Rails 7.0 needs `logger` loaded explicitly

- **Cause:** concurrent-ruby 1.3.5 stopped loading Ruby's `logger` library (changelog entry #1062, commit d7ce956dacd0). Rails 7.0.8.7 uses `Logger` without loading it itself and relied on concurrent-ruby to do it.
- **Error seen in the lab copy:** `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`.
- **Fix:** make this the first `require` in `config/boot.rb`, above `require "bundler/setup"`:
  ```ruby
  require "logger"
  ```
  This doesn't change the Rails version or add a gem. The `logger` default gem is 1.7.0 both before and after the bump.
- **What I ran:** a small script that loads `config/environment`, on all three copies:
  - **Current version (1.3.4):** loads; reports concurrent-ruby 1.3.4. Full suite passes (46 runs).
  - **1.3.8, no fix:** crashes with the NameError above. The run record lists this as "passed, exit 0" because the script catches and prints the error. The printed result in the log is the failure.
  - **1.3.8 with the fix:** loads; reports concurrent-ruby 1.3.8, `ActiveSupport::Logger` as the logger, and `ExportJob` still includes `Sidekiq::Job`. Every check stage passes.
- **Rollout:**
  1. Ship the `require "logger"` line on 1.3.4 first. I expect it to have no effect there, since 1.3.4 already loads `logger`, but I did not run it on 1.3.4.
  2. Then ship the Gemfile pin to 1.3.8 with a lockfile update. Only concurrent-ruby changes in `Gemfile.lock`.
- **Rollback:** revert only the Gemfile and lockfile change. Keep the `require` line, and never remove it while 1.3.8 is locked.

## Other changes reviewed (no action needed)

I read all 46 commits between the two release tags and opened every patch that changes library code. The app has no direct uses of `Concurrent::`, `ReadWriteLock` or `TimerTask`. These changes reach it only through Rails, Sidekiq and Puma internals, which the passing suite exercised:

- **ReadWriteLock:** releasing a lock the thread doesn't hold now raises an error instead of returning true.
- **ReentrantReadWriteLock:** now raises an error when one thread takes the read lock too many times.
- **TimerTask:** can be restarted safely after shutdown without running the task twice.
- **Thread pools:** idle threads are now pruned in the background.
- **Promises backtraces:** only change on Ruby 3.4 or later; the app is on Ruby 3.3.6.
- **Load-order fixes:** a fix for structs whose member names exist on an ancestor class, and a fix for a duplicate `require` inside the library.

No framework defaults change and no stored data formats (cookies, cache, jobs, database values) are affected. The Ruby requirement is 2.3 or later, so 3.3.6 is fine.

## Gaps and checks not run

- The changelog entries for 1.3.6–1.3.8 only link to GitHub release notes, which weren't collected. I read the commits instead.
- The browser tests (`bin/rails test:system`) were not run.
- I did not start a real Sidekiq worker process, Puma with production settings, or a `RAILS_ENV=production` boot.
- The thread-pool and lock changes were not tested under load. Their effect through Rails and Sidekiq beyond the passing suite is unknown.

## Files
- Plan data: /tmp/gem-upgrade-20261014-71526-x6wwpx/plan.json
- Lab: /tmp/gem-upgrade-20261014-71526-x6wwpx
  - Fixed copy: variants/v1_3_8_logger/app
  - Failing copy, kept: variants/v1_3_8/app
- Test script: /tmp/gem-upgrade-20261014-71526-x6wwpx/probes/boot_probe.rb
- Failing start log: /tmp/gem-upgrade-20261014-71526-x6wwpx/runs/v1_3_8/003-boot.log
- Script results: /tmp/gem-upgrade-20261014-71526-x6wwpx/runs/{baseline/007-probe,v1_3_8/004-probe,v1_3_8_logger/007-probe}.log
- Sources: /tmp/gem-upgrade-20261014-71526-x6wwpx/sources/index.md

The lab's databases have been removed; the copies and logs remain. The final status check reported your original checkout unchanged.

---

The plan above was written by a planning agent working in disposable copies of the app. I haven't changed your repository yet. If you want me to do the upgrade, I'll add `require "logger"` to the top of `config/boot.rb`, update concurrent-ruby to 1.3.8 in the Gemfile and lockfile, and run `bin/rails test` and `bin/rails test:system`. I can put the two changes in separate commits so they can be shipped in the order the plan describes.