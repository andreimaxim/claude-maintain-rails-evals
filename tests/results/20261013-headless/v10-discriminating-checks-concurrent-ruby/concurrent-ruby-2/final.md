Here is the upgrade plan from the planner, unchanged:

---

Moving concurrent-ruby from 1.3.4 to 1.3.8 breaks this app at boot unless one line is added. With that line it boots and works on both versions.

**Experiment setup:** I ran everything in a disposable copy at `/tmp/cr/app`. It used its own Postgres 15 cluster (Unix socket `/tmp/cr`, port 55439, database `margin_notes_crtest`), its own bootsnap cache (`/tmp/cr/bs`), and Redis pointed at an unreachable port so nothing could touch a real queue. The working repository was not changed. In the copy, the Gemfile pin became `"1.3.8"` and I ran `bundle update concurrent-ruby --conservative`. In the lockfile only concurrent-ruby changed (1.3.4 to 1.3.8). Rails stays at 7.0.8.7, Ruby at 3.3.6, and the `logger` gem at 1.7.0, which is already in the lockfile through other gems.

## Releases checked: 1.3.5, 1.3.6, 1.3.7, 1.3.8
- The change summary (`/tmp/cr/summary.txt`) listed 5 changelog entries in the range. None matched this app's code by text. The only removal it flagged is in 1.3.5: "(#1062) Remove dependency on logger".
- The summary has no specific entries for 1.3.6–1.3.8. From the source, those releases contain only bug fixes and internal changes, with no API removals.
- concurrent-ruby has no framework defaults or `config.load_defaults` settings, so there are no new defaults to adopt or keep.
- The app never calls `Concurrent` directly in `app/`, `config/` or `lib/`. It uses the gem only through Active Support, Sidekiq and the other gems that depend on it.

## Finding 1 (required): the app crashes at boot on Rails 7.0
- **Affected code:** `config/boot.rb`, and through it every process that loads Rails: server, console, rake tasks, Sidekiq workers and tests. This is almost certainly why the Gemfile pins 1.3.4.
- **Cause:** from 1.3.5, concurrent-ruby no longer loads Ruby's `logger` library. Active Support 7.0.8.7 relied on it being loaded already.
- **What I saw with 1.3.8 and nothing else changed** (`/tmp/cr/boot.log`):
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
- **When it applies:** any concurrent-ruby version from 1.3.5 up, as long as the app runs Rails 7.0.x. Rails 7.1 and later load `logger` themselves.
- **Recommended repair:** in `config/boot.rb`, add `require "logger"` right after `require "bundler/setup"` (before bootsnap and Rails). This is the only repair I recommend. It is harmless on 1.3.4.
  - Upgrading to Rails 7.1 would also fix it, but CLAUDE.md says to keep framework versions unless the task authorizes changing them, so it is out of scope.
  - Keeping concurrent-ruby at or below 1.3.4 just means not doing this upgrade.
- **Results with the repair** (`/tmp/cr/boot2.log`, `/tmp/cr/zw.log`):
  - The app boots and prints `7.0.8.7 / 1.3.8 / ActiveSupport::Logger`.
  - A `Concurrent::Future` returns 2.
  - `zeitwerk:check` prints "All is good!".
  - Control: the same `boot.rb` with 1.3.4 also boots (`/tmp/cr/boot134.log`), so you can merge the repair before the version bump.
- **Validation:** in a clean copy with 1.3.8, `RAILS_ENV=test bin/rails runner 'p Rails.logger.class'` should fail with the NameError above without the repair and print `ActiveSupport::Logger` with it. Run the same command on 1.3.4 with the repair as the control. Also boot a Sidekiq worker against a non-production Redis, and in staging enqueue one digest job and confirm it runs, because Sidekiq workers go through `boot.rb` too.

## Test suite
`bin/rails test` gave the same result on 1.3.8 with the repair (`/tmp/cr/test.log`) and on the untouched 1.3.4 copy (`/tmp/cr/test134.log`): 46 runs, 304 assertions, 0 failures, 2 errors. Both errors are `Redis::CannotConnectError` in `test/controllers/digests_controller_test.rb:65`. That test needs a real Redis, which I blocked on purpose to keep the experiment isolated. The browser suite (`test:system`) was not run.

## Rollout and rollback
- Nothing is stored in a different format: concurrent-ruby changes no data, cache or job formats. Jobs already waiting in Sidekiq run the same on either version, so running old and new versions side by side is safe.
- Order: merge the `boot.rb` line first, which works on 1.3.4, then bump the pin to 1.3.8. Rolling back means reverting the Gemfile and Gemfile.lock; the `boot.rb` line can stay.
- Never deploy the version bump without the repair: every process would crash at boot.

## Not verified yet
- The two Redis-dependent digest tests should be rerun against an isolated real Redis.
- The browser suite still needs to be run.
- I did not check the 1.3.6–1.3.8 changelogs line by line beyond the summary, so their fix-only status comes from the source rather than a full read.
- Production uses Sidekiq, so a staging run of a real job is still recommended.

Logs and experiment files are in `/tmp/cr/`: `summary.txt`, `bundle.log`, `boot.log`, `boot2.log`, `boot134.log`, `zw.log`, `dbprep.log`, `test.log`, `test134.log`, `pg.log`. The disposable app with the repair applied is at `/tmp/cr/app`.

---

I haven't upgraded anything yet. The upgrade skill only plans, so your repository is unchanged. The key point: bumping the version by itself crashes the app at boot on Rails 7.0, so `require "logger"` has to go into `config/boot.rb` first. If you want, I can make both changes: add that line, then change the `Gemfile` pin to `"1.3.8"` and run `bundle update concurrent-ruby --conservative`.