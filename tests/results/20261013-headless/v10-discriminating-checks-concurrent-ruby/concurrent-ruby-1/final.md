Upgrading concurrent-ruby from 1.3.4 to 1.3.8 needs one code change. With the gem bump alone, the app won't start: it crashes before Rails loads. Adding `require "logger"` as the first line of `config/boot.rb` fixes it, and with that line the upgraded copy boots and passes the test suite.

**What I ran.** All of this was in a disposable copy at `/tmp/cr`; the real repo was not touched.
- **Change summary:** `ruby .../bin/gem-changes concurrent-ruby 1.3.4 1.3.8`, output in `/tmp/gc.txt`. It found 5 changelog entries in the range. None mention code this app uses; the only removal it lists is "1.3.5: (#1062) Remove dependency on logger."
- **Gem bump:** I changed the Gemfile pin to `"1.3.8"` and ran `bundle lock --update concurrent-ruby` (log: `/tmp/cr-lock.log`). The only lockfile changes are `concurrent-ruby (1.3.4)` to `(1.3.8)` and the `= 1.3.4` pin to `= 1.3.8`. Rails stays at 7.0.8.7 and logger at 1.7.0, on Ruby 3.3.6. Install log: `/tmp/cr-install.log`.

## Required change: the app crashes at boot without a `require "logger"`

- **Affected code:** startup itself. `config/boot.rb` loads bundler and bootsnap, then `config/application.rb` loads `rails/all`. The app has no code of its own that uses concurrent-ruby.
- **What happens if nothing is done:** Rails 7.0's ActiveSupport counted on concurrent-ruby to load Ruby's `logger` library for it. Since 1.3.5, concurrent-ruby no longer does, so every process fails while loading Rails. That includes the server, `rails runner`, tests, rake tasks and job workers. Running `bin/rails runner` printed this (log: `/tmp/cr-boot.log`):
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
- **When it applies:** any concurrent-ruby version from 1.3.5 up, while Rails is still 7.0.x. Rails 7.1 and later load `logger` themselves, so the extra line would then be unnecessary but harmless.
- **Repair:** add `require "logger"` as the first line of `config/boot.rb`, before `bundler/setup` and `bootsnap/setup`.
  - This also works on 1.3.4, so it can ship as a separate commit before the bump.
  - It covers every entry point, because they all go through `boot.rb`.
  - Alternatives:
    - Moving to Rails 7.1+ fixes it at the source, but that is a much larger, separate upgrade.
    - Staying on 1.3.4 just leaves the pin in place.
  - Requiring `logger` only in `config/application.rb` would also work for the commands I tried, but the `boot.rb` placement is the one I tested.
- **Validation (run):**
  - **Without the repair:** the `rails runner` crash above. This is the check that fails.
  - **With the repair:** `bin/rails runner 'p Concurrent::VERSION'` prints `"1.3.8"` (log: `/tmp/cr-boot2.log`).
  - **Production mode:** `RAILS_ENV=production bin/rails runner` (throwaway `SECRET_KEY_BASE`) prints `["1.3.8", ActiveSupport::Logger]`. That covers the app's own logger use at `config/environments/production.rb:79` (`::Logger::Formatter.new`) and line 86 (`ActiveSupport::Logger.new(STDOUT)`).
  - **Tests:** I ran `db:create db:schema:load`, `zeitwerk:check` and `bin/rails test` against a throwaway database, `postgres:///cr_upgrade_test`, which I dropped afterwards. Result: 46 runs, 325 assertions, 0 failures and 0 errors (log: `/tmp/cr-test.log`).
  - **Control:** Rails is still using the same logger class after the change, `ActiveSupport::Logger`.

## New framework defaults
None. concurrent-ruby has no Rails configuration defaults, so there is nothing to adopt or keep at its old value.

## Other changes between 1.3.5 and 1.3.8
The change summary only read the 1.3.8 changelog (5 entries, none matching app code). The app doesn't use `Concurrent::` anywhere in `app`, `lib` or `config`; only Rails and its other gems use it. Any remaining behaviour changes would therefore show up inside Rails (thread pools, Action Cable, Active Record async/pool code), not in app code. I did not read each release's notes one by one, so that is still open.

## Rollout and rollback
- **Stored data and queued work:** I found nothing in the sources to suggest changes to stored data or to how queued jobs or cache entries are serialized, but I didn't run anything to confirm it. Old and new versions can run side by side as long as every deployed build includes the `require "logger"` line.
- **Order:**
  1. Ship the `boot.rb` line on 1.3.4.
  2. Then bump the pin in both the Gemfile and Gemfile.lock.
- **Rollback:** revert the pin and keep the `boot.rb` line.

## Not yet checked
- **Browser tests:** `bin/rails test:system` was not run.
- **Live services:** I didn't run the server, Action Cable or Active Storage under load.
- **Warning in the log:** the boot log says "You can add mutex_m to your Gemfile…". That is a separate warning, and I didn't check whether it already appears on 1.3.4.

---

That's the planner's report. I haven't changed your repository; the upgrade skill only produces a plan. The main point: on Rails 7.0, bumping only the gem stops every Rails process from starting. Add `require "logger"` to the top of `config/boot.rb` first, then bump the pin. If you want me to make both changes and run `bin/rails test:system`, say so.