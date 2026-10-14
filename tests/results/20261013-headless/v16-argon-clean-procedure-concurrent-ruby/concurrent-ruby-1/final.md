# concurrent-ruby 1.3.4 to 1.3.8 upgrade plan for Margin Notes

The bump needs one code change before it can ship. With 1.3.8, the app (on Rails 7.0.8.7) does not boot at all. It fails with this error:

```
activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>':
uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)
```

The fix is to add `require "logger"` to `config/boot.rb`. I tested it on both versions and it works; it is the only finding. With it, the test suite matches the baseline (46 runs, 325 assertions, 0 failures, 0 errors on both). The working checkout was not modified; cleanup reported `git status` clean.

## 1. Required changes for the upgrade

### Finding A: Logger is no longer loaded, so the app fails to boot

- **Affected code:**
  - `/home/user/workspace/repo/config/boot.rb` lines 1–4. Nothing loads `logger` before `require "bundler/setup"`, `require "bootsnap/setup"` and, from `config/application.rb`, `require "rails/all"`.
  - The error is raised inside Active Support 7.0.8.7, at `ActiveSupport::LoggerThreadSafeLevel` line 12 (`Logger::Severity.constants`).
  - `config/environments/production.rb:79` (`::Logger::Formatter.new`) also depends on `Logger` being loaded.
- **What breaks:**
  - Every way of starting the app fails before Rails loads: `bin/rails`, `bin/rake`, `config.ru` (the web server), test runs and job processes.
  - The exact error is the `NameError` above. Baseline 1.3.4 boots normally.
- **Applicability:**
  - Introduced in concurrent-ruby 1.3.5 (#1062, "Remove dependency on logger", commit `d7ce956`). It removed `require 'logger'` from `lib/concurrent-ruby/concurrent/concern/logging.rb`.
  - Active Support 7.0 relied on concurrent-ruby loading `logger`. Rails 7.1 and later require it themselves.
  - It applies as soon as the gem is bumped, whatever the `load_defaults` setting.
  - The repair works on 1.3.4 too (verified), so it can ship before the bump.
  - It does not affect stored data or queued jobs.
- **Recommended repair:**
  1. Edit `/home/user/workspace/repo/config/boot.rb`:
     ```ruby
     ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

     require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Active Support 7.0 needs it
     require "bundler/setup" # Set up gems listed in the Gemfile.
     require "bootsnap/setup" # Speed up boot time by caching expensive operations.
     ```
  2. Then change the pin at `Gemfile:8` to `gem "concurrent-ruby", "1.3.8"` and run `bundle update concurrent-ruby`. This updates the lock entry at `Gemfile.lock:86` and the `DEPENDENCIES` pin at line 295. No other gem moves.
  - Alternatives and why I don't recommend them:
    - Putting the require at the top of `config/application.rb` covers the server, but not scripts that load only `boot.rb`.
    - Setting `RUBYOPT=-rlogger` only fixes the environments where someone remembers to set it.
    - Upgrading to Rails 7.1 removes the need for the fix but is out of scope.
    - `logger 1.7.0` is already in the lock as a transitive dependency, so the require works without adding a gem.
- **Validation:**
  - **Failing check:** in the upgraded copy, with `RUBYOPT` cleared, `require "config/application"` raised the `NameError` above. Baseline 1.3.4 loaded fine.
  - **After the repair:** on both copies, `require "config/environment"` then `Concurrent::VERSION` / `Rails.logger.class` / `Rails.logger.level = :warn; Rails.logger.level` / `Note.count` printed:
    - baseline: `1.3.4`, `ActiveSupport::Logger`, `2`, `0`
    - upgraded: `1.3.8`, `ActiveSupport::Logger`, `2`, `0`
  - **Control:** the full suite on upgraded passed with 46 runs, 325 assertions, 0 failures, 0 errors, and boot, eager load and all 67 routes OK.

### Other changes checked, no impact on this app

- **`timer_task.rb` match:** `gem-changes` linked the `timer_task.rb` change (#1001) to `execute` calls in `db/migrate/20261011150300_move_note_bodies_to_rich_text.rb:19,22`. That is a false match: those are SQL `execute` calls, and the app never uses `TimerTask`.
- **No direct concurrent-ruby use:** the app does not call concurrent-ruby anywhere in `app/`, `lib/` or `config/`. The remaining fixes only matter through Rails internals and are low risk:
  - ReadWriteLock and ReentrantReadWriteLock fixes
  - `AtomicReference#update` with NaN
  - asynchronous pruning in RubyThreadPoolExecutor
  - Ractor support for `Map#compute_if_absent`
  - no Fiber created at load time
- **Deprecation warning:** `Enumerable.sum` at `app/models/export.rb:42` (`fragments.sum`) appears on both versions, so the bump did not cause it. It is worth fixing separately with `fragments.join`.

## 2. New configuration defaults across intermediate releases

None. concurrent-ruby has no framework defaults, and none of 1.3.5, 1.3.6, 1.3.7 or 1.3.8 adds settings. `config.load_defaults 7.0` does not change.

## 3. Rollout, rollback and mixed-version risks

- **Data compatibility:** concurrent-ruby does not change any data or message formats. Database records, `db/schema.rb`, Redis cache entries, signed or encrypted cookies and Active Job payloads all stay the same, so 1.3.4 and 1.3.8 processes can run side by side safely.
- **Rollout order:**
  1. Deploy the `config/boot.rb` change on 1.3.4. It is verified there and does nothing on that version.
  2. Then deploy the Gemfile bump.
- **Rollback** is just reverting the Gemfile and lock. Keep the `boot.rb` line.
- **Main risk:** any process that boots without going through `config/boot.rb` would still crash at startup. I found no such entry point. `bin/citation-provider` is a standalone stub server that does not load Rails.

## 4. Verification log and open questions

**Executed (resolved lock: concurrent-ruby 1.3.4 to 1.3.8, rails/activesupport 7.0.8.7, logger 1.7.0, Ruby 3.3.6, `load_defaults 7.0`):**
- `gem-changes concurrent-ruby 1.3.4 1.3.8`. It skipped reading the 1.3.8 .gem file because of a tar read error. Its commit and changelog list came from the GitHub tags instead.
- `upgrade-workspace setup`:
  - The Gemfile.lock diff changed only concurrent-ruby.
  - The upgraded copy's first boot failed with the `NameError`. The workspace then added `-rlogger` automatically, so its later "boot OK" and test results in that run do not show the bug.
  - Tests were 46/325/0/0 on both copies.
  - Logs were `/tmp/upgrade-concurrent-ruby-1.3.8/logs/{bundle-update,diag-baseline,diag-upgraded,tests-baseline,tests-upgraded,schema-load-*}.log`. They were deleted by cleanup.
- **Manual checks:** I ran both copies directly with `RUBYOPT` cleared, before and after the `boot.rb` repair. Results are in section 1.
- **After the repair:** `upgrade-workspace test` gave 46/325/0/0.
- **`upgrade-workspace probe`:** checking `Concurrent::Map#compute_if_absent`, the cache store class and the Notifications fanout class gave the same output on both copies apart from the version.
- `upgrade-workspace cleanup` finished and reported the checkout clean.

**Based on reading code, not executed:**
- `timer_task` is unused.
- The lock and thread-pool fixes don't affect the app's behaviour.

**Still to do:**
- Boot the production environment (`RAILS_ENV=production bin/rails runner 'p Rails.logger.formatter'`) to cover `production.rb:79`.
- Start the Puma server and the job worker once on 1.3.8 in staging.

**Open question:** whether any deploy scripts or container entry points outside the repo boot Rails without `config/boot.rb`.

---

I haven't changed anything in your repo yet; the upgrade skill only produces a plan. There's one thing you need to know before bumping: on Rails 7.0, concurrent-ruby 1.3.8 stops the app from booting unless `require "logger"` is added to `config/boot.rb` first. If you want me to make the change, I'll add that line, update the Gemfile pin, run `bundle update concurrent-ruby` and run the test suite.