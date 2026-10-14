# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

**Summary:** If you bump the gem as it stands, the app will not boot. Rails 7.0 needs Ruby's `logger` library, and concurrent-ruby stopped loading it in 1.3.5. A one-line `require "logger"` in `config/boot.rb` fixes it. That line also works on 1.3.4, so it can ship first. I found nothing else that changes for this app, and the bump is safe to run alongside 1.3.4 processes.

## 1. Required changes for the upgrade

### Finding 1: The app fails to boot because `Logger` is no longer loaded

- **Affected code:** `/home/user/workspace/repo/config/boot.rb`, lines 1–4. This file is the boot path for `bin/rails`, Puma, Sidekiq and the tests. The error is raised inside Rails' own code (activesupport 7.0.8.7, `active_support/logger_thread_safe_level.rb:12`), which uses `Logger::Severity` without loading `logger` itself.
- **What breaks:** Every process fails at boot with:
  `NameError: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger`
  That covers the web server, Sidekiq workers, console, migrations and tests.
- **Applicability:**
  - The change came in concurrent-ruby 1.3.5 ("Remove dependency on logger", #1062, commit `d7ce956`). 1.3.5 dropped `require 'logger'` from `concurrent/concern/logging.rb`, and every later release up to 1.3.8 inherits that.
  - It applies as soon as the gem is bumped, because Rails is still on 7.0. Rails 7.1 and later load `logger` themselves.
  - The repair also works on 1.3.4, so it can ship before the bump.
  - It does not affect stored data or queued jobs.
- **Recommended repair:** In `config/boot.rb`, add `require "logger"` directly after `require "bundler/setup"`:
  ```ruby
  require "bundler/setup" # Set up gems listed in the Gemfile.
  require "logger" # concurrent-ruby >= 1.3.5 no longer loads it; Rails 7.0 references ::Logger
  require "bootsnap/setup"
  ```
  - `logger` 1.7.0 is already in `Gemfile.lock`, so no new dependency is added.
  - Other options are worse:
    - Setting `RUBYOPT=-rlogger` has to be set in every deploy and process environment, and it is easy to miss one, such as Sidekiq or cron.
    - Pinning `concurrent-ruby` below 1.3.5 would block this upgrade altogether.
    - Requiring it in `config/application.rb` works but is less obvious than `boot.rb`.
- **Validation (run in the workspace):**
  - Run `bundle exec ruby -e 'require "./config/environment"; puts Concurrent::VERSION'` with `RUBYOPT` unset:

    | Copy | Without the line | With the line |
    |---|---|---|
    | upgraded (1.3.8) | `NameError` above | `booted 1.3.8` |
    | baseline (1.3.4) | `booted 1.3.4` | `booted 1.3.4` |

  - **Control:** with the repair, `upgrade-workspace test` on upgraded gives boot=OK, eager_load=OK, 67 routes, and 46 runs / 325 assertions / 0 failures / 0 errors. The baseline result is identical.

### Other gem changes I checked: nothing found for this app

- **Gemfile pin:** Change `Gemfile` line 8 to `gem "concurrent-ruby", "1.3.8"`. No other locked gem moves; the lockfile diff touches only concurrent-ruby.
- **TimerTask restart and duplicate-task changes (#1001):** These do not affect the app. The only match was the word `execute` in `db/migrate/20261011150300_move_note_bodies_to_rich_text.rb` lines 19 and 22, which are SQL calls in a migration, not concurrent-ruby. The app does not use `TimerTask` directly.
- **Other internal fixes:** These are thread-pool async pruning, `ReadWriteLock` and `ReentrantReadWriteLock` fixes, `AtomicReference` NaN livelock, `Concurrent::Map` in a Ractor, typed-data C extension, and the Fiber at load time. The app reaches them only through Rails and Sidekiq internals. A side-by-side probe showed identical results on both versions for the parts it exercises (details in section 4).
- **Unrelated warning:** `Enumerable.sum` deprecation at `app/models/export.rb:42` (`fragments.sum`). It appears on 1.3.4 as well, so it is not caused by this upgrade.

## 2. New configuration defaults across intermediate releases

None. Releases 1.3.5, 1.3.6, 1.3.7 and 1.3.8 add no framework configuration defaults, and `load_defaults 7.0` in `config/application.rb` is unaffected.

## 3. Rollout, rollback and mixed-version risks

- **Database records and `db/schema.rb`:** No change. Routes and the schema dump are identical on both versions.
- **Redis cache, cookies and tokens, Sidekiq/Active Job payloads:** concurrent-ruby does not define any of these formats. The probe showed byte-identical Active Job argument serialization and cache round-trips on both versions. Running 1.3.4 and 1.3.8 processes together, or rolling back, is safe.
- **Order:**
  1. Deploy the `config/boot.rb` line on 1.3.4. I verified it boots there.
  2. Then bump the Gemfile pin to 1.3.8.
- **Rollback:** Keep the `require "logger"` line when rolling back; it is harmless on 1.3.4.

## 4. Verification log and open questions

**Executed in the workspace:**
- `gem-changes concurrent-ruby 1.3.4 1.3.8`: it could not unpack the 1.3.8 gem file (`not an octal string`). It still analysed the changelog and the 46 commits between the git tags.
- `upgrade-workspace setup`:
  - The bundle resolved with only `concurrent-ruby 1.3.4 → 1.3.8` changing.
  - The upgraded copy's first boot failed with the `NameError` above.
  - The script then added `-rlogger` itself so the remaining checks could run; with that, both copies passed 46/325 tests with 0 failures.
- **Repair check:** I booted each copy with `RUBYOPT` unset, with and without the line, giving the results in the table above. I then ran `upgrade-workspace test` on upgraded with the repair and got 0 failures.
- **`upgrade-workspace probe`:** I compared a `MemoryStore` write/read of a UTC `Time`, `ActiveJob::Arguments.serialize`, `Rails.application.executor.wrap`, and `Concurrent::Map#compute_if_absent`. Output was identical on 1.3.4 and 1.3.8.
- **Logs:** `/tmp/upgrade-concurrent-ruby-1.3.8/logs/` (`bundle-update.log`, `diag-*.log`, `tests-*.log`, `schema-load-*.log`). They were deleted by cleanup.
- **Cleanup:** I ran `upgrade-workspace cleanup concurrent-ruby 1.3.8`. Your working checkout `git status` is clean.

**Based on reading code, not executed:** Puma and Sidekiq should pick up the fix because both boot through `config/environment.rb`, which loads `config/boot.rb`.

**Proposed checks:**
- Start `bundle exec sidekiq` and `bin/rails server` in staging with `RUBYOPT` unset, and confirm each boots and processes one job.
- Run `bin/rails test:system`; I did not run the browser suite.

**Open question:** Upgrading to Rails 7.1 or later would make the `require "logger"` line unnecessary, and it could be removed then.

---

This is a plan only; I haven't changed your checkout. Making the upgrade takes two edits: add `require "logger"` to `config/boot.rb`, and change the pin on `Gemfile` line 8 to `1.3.8` and run `bundle install`. Want me to make them?