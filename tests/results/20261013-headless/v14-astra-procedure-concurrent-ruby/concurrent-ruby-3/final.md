# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8

If you bump concurrent-ruby on its own, every Rails process in the app fails to start. One line in `config/boot.rb` fixes it. With that line, a copy of the app on 1.3.8 boots, prepares the database, eager-loads, loads routes and passes the full test suite (46 runs, 325 assertions, 0 failures). Your checkout at `/home/user/workspace/repo` was not changed; all work ran in throwaway copies.

## Required change: Rails 7.0 can't load Logger after the bump

- **Cause:** concurrent-ruby 1.3.5 stopped loading the `logger` library (changelog #1062, commit d7ce956dacd0). Rails 7.0.8.7 uses `Logger` without loading it first; it had been relying on concurrent-ruby to do that.
- **What happens:** every Rails entry point fails before the app loads: web server, Sidekiq, `bin/rails`, `bin/rake` and tests. The error in the 1.3.8 copy was:
  `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
- **Fix:** in `config/boot.rb`, add one line directly after `require "bundler/setup"`, before bootsnap and Rails load:
  ```ruby
  require "logger"
  ```
  Then change the pin on `Gemfile:8` to `"1.3.8"`. `logger` 1.7.0 is already in `Gemfile.lock` through other gems, so the lockfile diff only changes concurrent-ruby.
- **Other entry points:** `config.ru`, `bin/rails`, `bin/rake` and Sidekiq all go through `config/boot.rb`, so the fix covers them. `bin/citation-provider` doesn't load Rails, so it isn't affected.
- **Rollout:** deploy the `boot.rb` line first. On 1.3.4 it changes nothing (tested). Then deploy the Gemfile and lockfile bump.
- **Rollback:** revert only the lockfile bump and keep the `require`.

**What I ran:** a small script (`bin/rails runner probes/logger_probe.rb`) on four copies of the app:

| Copy | Result |
|---|---|
| 1.3.4, unchanged | Exit 0; Logger 1.7.0; Rails logger works, including `silence` |
| 1.3.4 with the new line | Same output as unchanged 1.3.4 |
| 1.3.8, unchanged | Exit 1 with the `NameError` above |
| 1.3.8 with the new line | Exit 0; same output as 1.3.4 |

## Other changes reviewed

- **Ruby version:** 1.3.8 needs Ruby 2.3 or later; the app uses 3.3.6.
- **Other dependencies:** concurrent-ruby is the only gem whose locked version changes.
- **All 46 upstream commits:** besides the logger change, there are fixes to read/write locks, thread-pool cleanup now running in the background, TimerTask restart, promise error backtraces and an infinite-retry bug in AtomicReference with NaN values. The rest is CI, docs, JRuby and C-extension work.
- **Direct use in the app:** a search for `Concurrent::`, `ReadWriteLock`, `Promises`, `TimerTask` and `ThreadPool` in `app/`, `lib/` and `config/` found nothing. The app only reaches concurrent-ruby through Rails, Sidekiq 6.5 and Puma.
- **Defaults and stored data:** there are no configuration defaults to adopt and no cookies, cache entries, database values or queued jobs affected.

## Not checked

- I didn't run the browser tests (`bin/rails test:system`).
- I didn't start Sidekiq or Puma as separate processes. They were covered only through the shared boot path.
- The upstream changelog entries for 1.3.6–1.3.8 only point to GitHub release notes, so I used the commit list instead of those notes.
- The thread-pool and lock changes weren't tested under production-like load. Their effect on concurrency is unknown, not shown to be safe.

## Files

All under `/tmp/gem-upgrade-20261014-71583-fjj77o/`:
- Plan data: `plan.json`
- Source research: `sources/`
- App copies: `variants/` (`baseline`, `baseline_logger`, `v1_3_8`, `v1_3_8_logger`)
- Run records and logs: `runs/`
- Probe script: `probes/logger_probe.rb`

The lab's databases were removed at the end. The cleanup step confirmed your original files were not modified.

---

This is a plan only. I haven't changed anything in your checkout. The upgrade is two edits: add `require "logger"` to `config/boot.rb`, and change the pin in `Gemfile` to 1.3.8 and run `bundle update concurrent-ruby`. Should I make them and run the test suite and browser tests?