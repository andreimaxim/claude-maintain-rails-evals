# concurrent-ruby 1.3.4 → 1.3.8: upgrade plan for Margin Notes

**Verdict:** you can't make this upgrade by changing the version number alone. With 1.3.8 the app does not boot. It can upgrade safely with one extra line in `config/boot.rb`, and that line also works on 1.3.4, so it can ship first. I ran this in a disposable copy and the working repository is untouched.

## Finding 1 (required): the app does not boot on 1.3.5 or later

- **Cause:** concurrent-ruby 1.3.5 dropped its dependency on `logger` and stopped loading it (changelog entry #1062). Rails 7.0.8.7, which this app runs, relied on that side effect. Rails only fixed this in 7.1 and later; 7.0 is end-of-life and never got the fix. This is most likely why the Gemfile pins 1.3.4 exactly.
- **Affected code:** everything that boots Rails: `config/boot.rb`, `config/application.rb` (`require "rails/all"`), the Puma server, Sidekiq workers, `bin/rails` tasks and the test suite.
- **What happens if nothing is done:** every Rails process fails at boot with:
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  Nothing goes wrong at runtime short of that; it simply won't start.
- **When it applies:** concurrent-ruby 1.3.5 or later combined with Rails below 7.1. `logger` 1.7.0 is already in the lockfile through sprockets and selenium, but being installed doesn't load it before Active Support needs it. Bootsnap doesn't change this; I ran with `DISABLE_BOOTSNAP=1`.
- **Recommended repair:** add `require "logger"` to `config/boot.rb` just before `require "bundler/setup"`. Then change `Gemfile:8` to `"1.3.8"` and run `bundle lock --update concurrent-ruby --conservative`. Only concurrent-ruby changes in the lockfile.
- **Alternatives (not recommended):**
  - Putting the require in `config/application.rb` after `require "rails/all"` is too late. I tested it and got the same NameError.
  - Upgrading Rails to 7.1 or later removes the need for the line, but it's a much larger, separate upgrade that would need its own authorisation.
  - Keeping the pin is safe but leaves you on 1.3.4.

**Validation (all run, except the dev-server request noted below):**

| Variant | concurrent-ruby | `require "logger"` in boot.rb | Result |
|---|---|---|---|
| Upgrade, no repair | 1.3.8 | no | NameError at boot (fails as expected) |
| Upgrade with repair | 1.3.8 | yes | Boots; `Concurrent::VERSION` is 1.3.8; `Rails.logger` is `ActiveSupport::Logger`; `zeitwerk:check` passes; 46 runs, 325 assertions, 0 failures |
| Repair placed in application.rb | 1.3.8 | in application.rb instead | Same NameError |
| Control: current version with repair | 1.3.4 | yes | Boots; 46 runs, 325 assertions, 0 failures |

- The control shows the boot change also works on the current version, so it can ship first.
- In the development environment the server returned 301 for `/` and 404 for `/up`. I didn't check what those normally return on 1.3.4, so they only show that the server started and answered requests.

## What the changelogs contain

- The `gem-changes` tool read only the 1.3.8 changelog page, which lists entries from 1.3.5 onwards. It found no textual matches with this app's code; the logger removal is listed twice, both under 1.3.5.
- Apart from that, I'm going on memory for what 1.3.6, 1.3.7 and 1.3.8 contain (small fixes and Ruby compatibility work, nothing that changes behaviour). I did not check those release notes; read them on GitHub before merging.
- The app has no direct `Concurrent::` usage in `app/`, `config/`, `lib/` or `test/`. It only reaches concurrent-ruby through Rails, i18n, sprockets and tzinfo.
- **New configuration defaults: none.** concurrent-ruby has no framework defaults, and the Rails `load_defaults` setting is untouched.

## Rollout, rollback, stored data and queued work

- **Stored data and queues:** nothing in the database, Sidekiq/Redis payloads, the cache or Active Storage depends on concurrent-ruby's format. Queued jobs are unaffected in either direction.
- **Deploy order:**
  1. Ship the `boot.rb` line alone first. It's verified safe on 1.3.4.
  2. Then ship the Gemfile and lockfile bump.
- **Mixed-version risk:** any web or Sidekiq process that gets the new bundle without the boot line will crash at startup rather than misbehave. Deploying in that order removes the risk.
- **Rollback:** revert the Gemfile and lockfile only. Keep the boot line; it's harmless on 1.3.4.
- **Other entry points:** any script that loads Active Support without going through `config/boot.rb` would also need the require. I found none in `config/`, but I didn't audit `bin/` or deployment scripts.

## Experiment details

- **Copies:**
  - `/tmp/cr-exp/app`: 1.3.8 with the boot change applied; `config/application.rb` was restored after the placement test.
  - `/tmp/cr-exp/old`: 1.3.4 plus the boot change.
- **Isolation:**
  - **Database:** separate PostgreSQL databases `margin_notes_crexp_test` and `margin_notes_crexp_dev`, deleted afterwards.
  - **Queue and cache:** tests use the `:test` queue adapter and `:null_store` cache. For the development server, `REDIS_URL` pointed at Redis database 13. Development uses the async cable adapter and `:memory_store`.
  - **Storage:** not isolated separately; storage uses the copy's own `storage/` directory.
- **Commands:**
  - `bundle lock --update concurrent-ruby --conservative`, then `bundle install`
  - `bin/rails runner`, `db:create db:schema:load`, `zeitwerk:check`, `bin/rails test`
  - `bin/rails server -p 3999` (development)
- **Logs** in `/tmp/cr-exp/`:
  - Changelog summary: `/tmp/cr-changes.txt`
  - Lockfile and install: `lock.log`, `install.log`
  - Boot without the repair: `boot.log`; boot with it: `boot2.log`
  - Database setup: `db.log`, `devdb.log`
  - Zeitwerk check: `zw.log`
  - Test runs: `test.log` (1.3.8), `test-old.log` (1.3.4)
  - Dev server: `server.log`

## Not checked yet

- **System tests:** `bin/rails test:system` was not run.
- **Sidekiq:** I didn't start a real worker against an isolated Redis to process a job. A worker boots through the same `config/boot.rb`, so it should behave like the server.
- **Production:** I didn't check production boot with eager loading.
- **Changelogs:** the exact contents of the 1.3.6 to 1.3.8 changelogs need reading, as noted above.

---

The "I" in the plan above is the planning agent, which did its testing in copies under `/tmp`. Your repository hasn't been changed. This upgrade skill only produces a plan, so I haven't applied anything. If you want me to go ahead, I'd add `require "logger"` to `config/boot.rb`, change `Gemfile:8` to `"1.3.8"`, update the lockfile, and run the test suite and the browser tests.