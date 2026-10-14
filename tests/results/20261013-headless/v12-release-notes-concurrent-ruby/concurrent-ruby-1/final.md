## Upgrade plan: concurrent-ruby 1.3.4 to 1.3.8 (Margin Notes, Rails 7.0.8.7, Ruby 3.3.6)

**Verdict:** The bump on its own breaks the app. Every Rails process (server, tests, rake, runner, Sidekiq) crashes at boot. One preparatory line, `require "logger"` in `config/boot.rb`, fixes this. I tested it on both 1.3.8 and 1.3.4.

### Finding 1 (required): the app won't boot because `Logger` is no longer loaded

- **Source:** In 1.3.5, concurrent-ruby stopped requiring `logger` (changelog entry "#1062 Remove dependency on logger"). Rails 7.0's `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb` uses `Logger::Severity` without requiring `logger` itself. It only worked because concurrent-ruby loaded it first. Rails 7.1 and later add the require; 7.0.8.7 does not.
- **Affected code:** Everything that loads `config/boot.rb`: `bin/rails`, `bin/rake`, `config.ru` (Puma), `test/test_helper.rb`, and Sidekiq, which boots through `config/environment`. The app has no direct `Concurrent::` usage, so this is the only path.
- **Observed** (disposable copy, with Gemfile at 1.3.8 and `bundle update concurrent-ruby --conservative`):
  ```
  activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in `<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)
  ```
  The test suite can't run at all, so CI would fail immediately. This one is not silent.
- **Applies when:** Rails is below 7.1 and concurrent-ruby is 1.3.5 or later. Both are true here.
- **Recommended repair:** Add `require "logger"` to `config/boot.rb` right after `require "bundler/setup"`. The `logger` gem (1.7.0) is already in the lockfile through other dependencies.
- **Alternatives:**
  - Upgrading Rails to 7.1 also fixes it, but `CLAUDE.md` says to keep dependency versions unless the task authorizes changing them, and this task doesn't.
  - Keeping concurrent-ruby at 1.3.4 means not doing the upgrade.
  - Putting the require in `config/application.rb` would also work for every entry point except code that runs between boot and application load. `boot.rb` is the safer place.
- **Works on the current version:** Yes. With the line added and concurrent-ruby still at 1.3.4, the app booted and printed `1.3.4`. So this can ship first as its own preparatory change.
- **Validation:**
  - *Discriminating check (executed):* With 1.3.8 locked, `RAILS_ENV=test bin/rails runner 'puts Concurrent::VERSION; puts Rails.logger.class'`. Without the repair it fails with the NameError above. With it, it prints `1.3.8` and `ActiveSupport::Logger`.
  - *Control (executed):* `bin/rails zeitwerk:check` passes on the repaired copy ("All is good!").
  - *Still to run (needs isolated Postgres and Redis):* the full `bin/rails test` and `bin/rails test:system` runs. Also start Sidekiq against a throwaway Redis database and run one Active Job job (for example, whatever triggers the citation lookup) to confirm the worker boots and logs. Check that the production log formatter (`config/environments/production.rb:79`, `::Logger::Formatter.new`) still works with `RAILS_ENV=production bin/rails runner 'Rails.logger.info "x"'` against isolated resources.

### Configuration defaults
concurrent-ruby has no framework defaults, and none of the releases from 1.3.5 to 1.3.8 add any. `config.load_defaults 7.0` stays as it is, and there is nothing optional to adopt.

### Other changes in 1.3.5 to 1.3.8 (not verified)
The summary tool read only the 1.3.8 changelog page. It found 5 entries in the range and flagged only the logger removal (it printed that entry twice). I did not read the other entries in full. As far as I recall they are small bug and compatibility fixes, but that is unconfirmed. Since this app doesn't use `Concurrent::` directly, any exposure would be through Rails, Sidekiq 6.5.12 or Puma 5. Before merging, someone should read the full CHANGELOG for 1.3.5, 1.3.6, 1.3.7 and 1.3.8.

### Rollout and rollback
- **Order:** deploy `require "logger"` first, on 1.3.4. Then deploy the Gemfile and lockfile bump to `"1.3.8"`; the lockfile diff is only the two concurrent-ruby lines.
- **Mixed versions:** web and Sidekiq processes on different concurrent-ruby versions share no stored data or job formats tied to concurrent-ruby. Jobs already queued in Redis are serialized by Active Job and Sidekiq and are not affected.
- **Rollback:** reverting the Gemfile is safe. Leave the `require "logger"` line in place.

### Experiment record
- **Copy:** `/tmp/cr-exp/app`, copied from the repo. I removed `tmp/cache` and ran `mise trust` there.
- **Resolved version:** concurrent-ruby 1.3.8; all other gems unchanged.
- **Isolation:** `DATABASE_URL=postgresql://invalid/none` and `REDIS_URL=redis://127.0.0.1:1/15`, so the copy could not reach the real Postgres or Redis. Nothing touched a database. The working repo was not modified.
- **Logs:**
  - `/tmp/cr-changes.txt` (gem-changes output)
  - `/tmp/cr-exp/bundle.log`
  - `/tmp/cr-exp/boot-nofix.log`
  - `/tmp/cr-exp/boot-fix.log`
  - `/tmp/cr-exp/zw.log`

### Open questions
- The full test, system test and Sidekiq runs haven't been done; they need isolated services.
- The non-logger changelog entries for 1.3.5 to 1.3.8 haven't been reviewed.
- The tool also printed deprecation warnings that bigdecimal and mutex_m will leave the default gems in Ruby 3.4. They are unrelated to this upgrade but matter for a future Ruby bump.

---

That's the plan. I haven't changed anything in your repo. The upgrade needs two changes. First, add `require "logger"` to `config/boot.rb`, which works on the current 1.3.4 too. Then change the Gemfile to `"1.3.8"` and run `bundle update concurrent-ruby --conservative`. Bumping the version without that line would stop the app from booting.

Before merging, two things still need doing: run the full test, system test and Sidekiq checks against isolated services, and read the 1.3.5 to 1.3.7 changelog entries. Want me to make both changes?