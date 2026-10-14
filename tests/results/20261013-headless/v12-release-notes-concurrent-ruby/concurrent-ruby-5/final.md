I made a plan for this upgrade but haven't changed anything yet, because the upgrade skill only plans. Here is the planner's full report:

---

The upgrade needs one code change before it will work. With concurrent-ruby 1.3.8 and the current Rails 7.0.8.7, the app does not boot. Adding `require "logger"` as the first line of `config/boot.rb` fixes it. That repair is probably why `Gemfile` line 8 pins 1.3.4 exactly.

## What I ran
I used a throwaway copy at `/tmp/exp`. I changed `Gemfile` to `"1.3.8"` and ran `bundle update concurrent-ruby --conservative` (log: `/tmp/exp-bundle.log`). Only concurrent-ruby changed in `Gemfile.lock`, to 1.3.8. Ruby is 3.3.6, Rails and activesupport stay at 7.0.8.7, and logger 1.7.0 was already in the lock through other gems. The working repo is unchanged (`git status` is clean).

## Finding 1 (required): the app fails to boot
- **Cause:** concurrent-ruby 1.3.5 stopped loading Ruby's `logger` library (#1062). ActiveSupport 7.0 used to get `Logger` loaded indirectly through it, and does not load it itself.
- **Where it breaks:** `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12`. This happens before any app code runs, so every process fails: server, console, runner, rake tasks, tests and jobs.
- **Error seen:** `bin/rails zeitwerk:check` on 1.3.8 failed with:
  `uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)` (`/tmp/exp-boot.log`).
- **When it applies:** activesupport below 7.1 with concurrent-ruby 1.3.5 or later. That is true here.
- **Repair:** add `require "logger"` as the first line of `config/boot.rb`, before `bundler/setup`. Then change the pin to `"1.3.8"`.
  - It works on the current version too. On 1.3.4 the copy at `/tmp/ctl` booted and printed `1.3.4` (`/tmp/ctl-run.log`). So it can ship first as a separate change that does nothing visible.
  - **Alternatives:**
    - Upgrade Rails to 7.1 or later: also fixes it, but it is a much bigger change outside this request.
    - Keep the 1.3.4 pin: the status quo, no upgrade.
    - Require `logger` later, for example in `config/application.rb`: not recommended. It is too late if anything loads ActiveSupport earlier, and it won't help other entry points such as `bootsnap/setup`, which `boot.rb` loads on its third line.
- **Results with the repair:**
  - `zeitwerk:check` printed "All is good!" (`/tmp/exp-boot2.log`).
  - `bin/rails runner` printed `1.3.8`, wrote with `Rails.logger.info`, and showed the logger class as `ActiveSupport::Logger` (`/tmp/exp-run.log`).
  - `bin/rails test` against a separate database (`margin_notes_exp_cr138`, deleted afterwards) gave 46 runs, 325 assertions, 0 failures (`/tmp/exp-test.log`).
- **Check to repeat on the real change:**
  - On 1.3.8 without the line, `RAILS_ENV=test bin/rails runner 'puts Concurrent::VERSION'` must fail with the NameError above. With the line it must print `1.3.8`.
  - Controls:
    - The same command still prints `1.3.4` on the current pin with the line added.
    - With the repair, `Rails.logger` is still `ActiveSupport::Logger`.
    - In production, request logs still reach STDOUT through `TaggedLogging`, as set up in `config/environments/production.rb` lines 86–88. Still to check: I did not run it.
  - Also run `bin/rails test:system`, which I did not run.

## Other changelog entries (unverified)
- The `gem-changes` summary covered only the 1.3.8 changelog ("Releases read: 1.3.8"). It listed 5 entries but none matched code in this app. The only removal it flagged was the logger change, which it reported twice.
- I did not read the 1.3.6, 1.3.7 and 1.3.8 notes one by one. Read them on GitHub before merging.
- The app doesn't use `Concurrent::` directly in `app`, `lib` or `config`. It reaches the gem only through Rails internals: ActiveSupport, the Active Record connection pool, and executors. That makes app-specific risk from those entries low. This is based on reading the code, not on running anything.

## Configuration defaults
concurrent-ruby has no framework defaults or `load_defaults` settings, so there are none to adopt or keep.

## Rollout and rollback
- No stored data, cache formats or queued job payloads change. Queues and caches look like the stock settings: the queue adapter is the default, and the production cache store is commented out. Mixing 1.3.4 and 1.3.8 processes during a deploy is safe.
- **Order:**
  1. Deploy the `boot.rb` line.
  2. Bump the pin and lock.
- **Rollback:** revert only the pin and keep the `require` line.

## Remaining questions
- Do any boot paths skip `config/boot.rb`, such as a custom `bin/*` script or a Procfile command? Each one would need the same require.
- The boot output also shows a separate Ruby 3.4 warning about `mutex_m`. It is unrelated to this upgrade.

---

**What this means:** just changing the version would break the app: it fails to start, including tests and every other process. The fix is one line, `require "logger"`, at the top of `config/boot.rb`. In a throwaway copy with that line added, all 46 tests passed on 1.3.8. The browser tests and production logging were not checked.

Decision for you: should I make the change in your repo? That means adding the `boot.rb` line, changing the pin in `Gemfile` to `"1.3.8"`, updating the lock file with `bundle update concurrent-ruby --conservative`, and running the tests and browser tests. I can also put the `boot.rb` line in a separate commit first, as the plan suggests.