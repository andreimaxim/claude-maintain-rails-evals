Moving to concurrent-ruby 1.3.8 needs one code change, or the app won't start. The jump only changes the Gemfile pin and one lockfile line, and adds no new framework defaults. But this app is on Rails 7.0.8.7, and that version's ActiveSupport fails to load once concurrent-ruby is 1.3.5 or later unless `logger` is loaded first. I confirmed this by booting a disposable copy at `/tmp/cr/app`. The working repository was not changed (`git status` is clean).

## Required change: the app won't boot without it

**Cause.** concurrent-ruby 1.3.5 (#1062) stopped loading Ruby's `logger` library. ActiveSupport 7.0.8.7 refers to `Logger` in `active_support/logger_thread_safe_level.rb` without loading it itself; it had relied on concurrent-ruby doing so. The change tool listed this entry as having "no textual match" in the app's code, but it breaks every Rails entry point: server, console, runner, tests, migrations and jobs.

**What I ran.** In the copy (Ruby 3.3.6) I changed `Gemfile:8` to `"1.3.8"` and ran `bundle update concurrent-ruby --conservative`. The lockfile changed only `concurrent-ruby (1.3.4)` to `(1.3.8)` plus the matching pinned-dependency entry; `logger (1.7.0)` was already in the lockfile. I set `DATABASE_URL` to an invalid address and used a separate bootsnap cache directory, so nothing could reach real services.
- `bin/rails runner 'puts Concurrent::VERSION'` exited 1 with:
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)` (log: `/tmp/cr/boot_nofix.log`)

**Recommended fix.** Add `require "logger"` in `config/boot.rb`, right after `require "bundler/setup"`. With that line, the same runner exited 0 and printed `1.3.8` and `ActiveSupport::Logger` (`/tmp/cr/boot_fix.log`). `bin/rails zeitwerk:check` printed "All is good!" (`/tmp/cr/zw.log`).
- **Safe to ship first:** the line also works on 1.3.4, because `logger` is part of Ruby. It can go out ahead of the version bump, and rollback is safe in either order.
- **Alternatives:**
  - Pinning `concurrent-ruby` at 1.3.4 just avoids the upgrade.
  - Upgrading Rails to 7.1 or later also fixes it, but changes framework defaults without authorisation.
  - Adding `logger` to the Gemfile alone does not fix it, because Bundler does not load it before Rails.

**Validation.**
- **Fails without the fix, passes with it:** on the upgraded copy, `bin/rails runner 'puts Rails.logger.class'` exits 1 without the line and 0 with it.
- **Control:** on the current 1.3.4 lockfile with the line added, the app still boots and logs the same way. Check that `log/test.log` still gets written during a request test.

## Not yet checked
- **Database-backed checks:** I did not run `bin/rails test`, `test:system` or `db:prepare`, because that needs an isolated PostgreSQL database (for example a throwaway database name via `DATABASE_URL`) and the boot check didn't need one.
- **Live behaviour:** I did not exercise these against the upgraded copy:
  - Sign-in plus creating and updating a note.
  - Jobs on the `:test` queue adapter.
  - Action Cable on the `async` adapter (which runs on concurrent-ruby thread pools).
  - The development `:memory_store` cache.
- **Other changelog entries:** the tool reported 5 entries in range but showed only the logger one (twice). I did not read the 1.3.6 to 1.3.8 entries one by one. Going by what I recall of the upstream changelog (not checked here), they are bug fixes, and the app makes no direct `Concurrent::` calls in `app`, `config` or `lib`. Reading `/tmp/cr/summary.txt` and the upstream CHANGELOG would close this.
- **Other gems:** the warnings that `bigdecimal` and `mutex_m` will leave Ruby's default gems in Ruby 3.4 come from Rails 7.0 itself. They don't block this upgrade, only a future Ruby upgrade.

## Optional defaults and rollout risk
- **New defaults:** none. concurrent-ruby has no Rails configuration defaults, so there is nothing to adopt.
- **Stored data and queued work:** no change to stored data or the queued-job format.
- **Mixed-version deploys:** the only hazard is shipping the version bump without the `boot.rb` line. Ship the line first or in the same deploy.

Everything is in `/tmp/cr/`: the change summary, `bundle.log`, both boot logs, `zw.log`, and the copy with its diff in `/tmp/cr/app`.

---

**My notes:** I haven't applied the upgrade to your repository yet. The upgrade skill only produces a plan, so the working tree is unchanged. If you want me to go ahead, I'll:
1. Change `Gemfile:8` to `"1.3.8"`.
2. Add `require "logger"` to `config/boot.rb`.
3. Run `bundle update concurrent-ruby --conservative`.
4. Run `bin/rails test` and `bin/rails test:system` against an isolated test database.