# Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

**Verdict:** The upgrade needs one required change. On 1.3.8 the app does not boot unless `require "logger"` is added before Rails loads. I reproduced the failure and tested the fix in a disposable copy. There is nothing to adopt for new defaults and no stored-data concern.

## Releases checked
The changelog covers 1.3.5, 1.3.6, 1.3.7 and 1.3.8, with 5 entries in range. The `gem-changes` index found no entries that match app code. It flagged only the removal in 1.3.5: "(#1062) Remove dependency on logger". The app has no direct `Concurrent::` usage in `app/`, `lib/` or `config/`. It gets concurrent-ruby through activesupport, i18n, sprockets and tzinfo.

- **1.3.5:** Removes the logger dependency. This is the breaking change (finding 1 below).
- **1.3.6, 1.3.7, 1.3.8:** Maintenance fixes. Nothing in these matched the app, and the upgraded copy passed every check after the repair. Beyond what the index summarised, I did not read these entries line by line.
- **New configuration defaults:** None. concurrent-ruby has no framework defaults, so nothing changes with `config.load_defaults 7.0`.

## Finding 1 (required): Rails 7.0 crashes at boot without logger
- **Affected code:** Everything that boots through `config/boot.rb` → `config/application.rb`. That includes `bin/rails server`, `runner`, `console`, `db:*` and the `bin/rails test` and `test:system` suites.
- **What happens if nothing is done (executed):** In the upgraded copy, `bin/rails runner` and `bin/rails test` both fail at load time with this error:
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  ActiveSupport 7.0 relies on something else having already loaded `Logger`. Up to 1.3.4, concurrent-ruby did that.
- **Sidekiq is not affected:** `bundle exec sidekiq -e test` booted fine without the repair ("Booted Rails 7.0.8.7 application in test environment"), because Sidekiq loads logger itself first. So in production the web processes fail while the workers keep running. This is a deploy-ordering hazard: workers may come up healthy while web does not.
- **When it applies:** Rails below 7.1 (here 7.0.8.7) together with concurrent-ruby 1.3.5 or later. The `logger` gem (1.7.0) is already in the lock as a transitive dependency, so no new gem is needed.
- **Recommended repair:** In `config/boot.rb`, add `require "logger"` on line 2, before `require "bundler/setup"` and `bootsnap/setup`. This also works on the current version: on 1.3.4 with the current bundle, `require "logger"` loads cleanly. That means the line can be shipped first as a separate, no-op preparatory change.
- **Alternatives:**
  - Keep concurrent-ruby pinned at 1.3.4. This is the current state and doesn't upgrade anything.
  - Upgrade Rails to 7.1 or later. That fixes the problem at its source but is out of scope.
  - Add `require "logger"` only in `config/application.rb`. This works for the same entry points, but boot.rb is the earliest shared point.

  I recommend the boot.rb line.

## Validation
Executed in `/tmp/cr/app`, a copy of the repo:
- **Setup:** Gemfile changed to `"1.3.8"`, then `bundle lock --update concurrent-ruby`. The lock now resolves concurrent-ruby to 1.3.8 and nothing else changed. The lockfile is saved at `/tmp/cr/Gemfile.lock.138`.
- **Isolation:** Commands ran with `RAILS_ENV=test DATABASE_URL=postgres:///cr_upgrade_test REDIS_URL=redis://localhost:6379/13`. I dropped the throwaway database afterwards.
- **Discriminating check:** `bin/rails runner 'puts ActiveSupport::VERSION::STRING, Concurrent::VERSION'`
  - Without the repair it fails with the NameError above (`/tmp/cr/boot.log`, `/tmp/cr/test_unfixed.log`).
  - With the repair it boots and prints `7.0.8.7` and `1.3.8` (`/tmp/cr/boot2.log`).
- **With the repair:**
  - `bin/rails zeitwerk:check` reported "All is good!" (`/tmp/cr/zw.log`).
  - `bin/rails test` ran 46 tests with 325 assertions and 0 failures (`/tmp/cr/test_fixed.log`).
  - Sidekiq booted (`/tmp/cr/sidekiq.log`).
- **Control:** Sidekiq boots both with and without the repair (`/tmp/cr/sidekiq_unfixed.log`).
- **Still to do:**
  - Run `bin/rails test:system`. I did not run it.
  - Run a production-mode boot (`RAILS_ENV=production bin/rails runner 1` with dummy secrets), plus `bin/rails server` and a request to the notes list.
  - Enqueue one real job through Sidekiq against an isolated Redis.

## Rollout and rollback
- **Order:** Deploy the `require "logger"` line on 1.3.4 first, then bump the gem. Each step can be rolled back on its own.
- **Data and queues:** concurrent-ruby doesn't serialise anything into the database, cache or Sidekiq payloads, so mixed versions and queued jobs carry no data-format risk.
- **Rollback risk:** If you roll back the boot.rb line while keeping 1.3.8, web processes crash at boot. Roll back the gem before the line.

## Unrelated observations (not caused by this upgrade)
Ruby 3.3 warns that `bigdecimal` and `mutex_m` leave the default gems in Ruby 3.4. This only matters for a future Ruby upgrade.

## Still unverified
- I did not read the 1.3.6–1.3.8 entries in detail beyond the tool's index.
- Not checked: whether production or Puma configs boot through some path that skips `config/boot.rb`. Standard `config.ru` and `bin/*` go through boot.rb.

The working repository was not modified (`git status` is clean). The change index is at `/tmp/cr/changes.txt`.

---

This is a plan only. I haven't changed your repository. The upgrade itself is small: add `require "logger"` to `config/boot.rb` and change the Gemfile pin from `1.3.4` to `1.3.8`. If you want, I can make those two changes and then run the browser tests (`bin/rails test:system`), which the planner didn't run.