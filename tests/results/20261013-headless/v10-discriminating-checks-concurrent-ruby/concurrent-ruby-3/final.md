Here is the planner's full plan, unchanged:

---

I ran the upgrade in a disposable copy. On this app, moving concurrent-ruby from 1.3.4 to 1.3.8 breaks every boot unless you make a one-line change to `config/boot.rb` first. With that line added, the copy boots and passes `zeitwerk:check`. I have not run the test suites, the server, or Sidekiq against a database.

## Releases covered
The tool only read the 1.3.8 changelog (`/tmp/cr/summary.txt`), and its 5 entries in range matched none of the app's code. 1.3.5 is the release that matters here: it removed the internal `require "logger"` (#1062). From what I know of 1.3.6, 1.3.7 and 1.3.8, they contain small fixes with no API removals. I did not re-read those changelogs from source, so that part is unverified. concurrent-ruby has no upgrade guide and no configuration defaults, so for every release there is no new default to adopt. The app's own Rails default stays as it is (`load_defaults 7.0`).

## Finding 1 (required): the app fails to boot on Rails 7.0.8.7
- **Affected code:** the boot sequence. `config/boot.rb` runs `bundler/setup` and then `bootsnap/setup`, `config/application.rb` runs `require "rails/all"`, and that loads `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb`. Rails 7.0 relied on concurrent-ruby ≤1.3.4 to load `Logger` for it. This is why the Gemfile pins `gem "concurrent-ruby", "1.3.4"`.
- **What I observed** (copy at `/tmp/cr/app`, lock resolved to `concurrent-ruby (1.3.8)` with `logger (1.7.0)` already in the lock, log `/tmp/cr/boot.log`):
  `logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  This hits every process that loads Rails: web, the Sidekiq worker, `rails runner`, rake/db tasks and tests. Nothing about stored data changes.
- **When it applies:** any Rails below 7.0.x's later fix (7.1+ requires logger itself) combined with concurrent-ruby 1.3.5 or newer. Rails stays at 7.0.8.7 here.
- **Recommended repair:** in `config/boot.rb`, add `require "logger"` directly after `require "bundler/setup"` and before bootsnap and Rails load. Then change the Gemfile pin to `"1.3.8"` and run `bundle update concurrent-ruby --conservative`, which changed only that gem in the copy.
  - The extra require also works on the current version: with the require in place and the original 1.3.4 lock, the copy booted and printed `1.3.4`. You can ship it first as a separate preparatory change.
  - Alternatives:
    - Leaving the pin at 1.3.4 is not an upgrade.
    - Upgrading Rails to 7.1 is far beyond the scope of this task.
    - Requiring logger in `config/application.rb` would also work, because it runs before `rails/all`. It just doesn't protect tooling that loads only `boot.rb`, so I recommend `boot.rb`.
- **Validation (executed):**
  - Upgraded copy without the repair: `bin/rails runner 'puts Concurrent::VERSION'` fails with the NameError above.
  - With the repair it prints `1.3.8` and `ActiveSupport::Logger` (`/tmp/cr/boot2.log`), and `bin/rails zeitwerk:check` reports "All is good!" (`/tmp/cr/zw.log`).
  - Control: with the repair on 1.3.4 it boots unchanged.
  - Environment for these runs: Ruby 3.3.6 via mise, `DATABASE_URL`/`REDIS_URL` pointed at unreachable ports, so nothing touched real services.

## Still to check before merging
These need an isolated Postgres database and a separate Redis DB:
- `bin/rails db:prepare`, `bin/rails test` and `bin/rails test:system`.
- Start `bin/rails server`. Sign in, then create and update a note, and run a search on the notes list.
- Start Sidekiq (`config/application.rb` sets `queue_adapter = :sidekiq`) and process one enqueued job. Sidekiq and the other gems that depend on concurrent-ruby all accept `~> 1.0` or `~> 1.1`. I don't expect a behavior change, but I haven't watched it run.
- Check that log output looks the same in development and production, including the log level and the tagged request ID.

## Rollout and rollback
- Data and job payloads don't change, so jobs already in the queue are safe in both directions.
- During a rolling deploy, old and new processes can run side by side safely.
- The risk is shipping the version bump without the `boot.rb` line, which crashes on boot. Ship the line in the same commit as the bump or before it.
- To roll back, revert the Gemfile and lock. The logger require can stay in place without harm.

## Open questions
- I haven't confirmed whether any test helper or binstub loads ActiveSupport without going through `config/boot.rb`.
- The 1.3.6–1.3.8 changelog contents are from memory, not re-read (see above).

The disposable copy is at `/tmp/cr/app`. The bundle output is in `/tmp/cr/bundle.log`, and the variants of `boot.rb` I tested are `/tmp/cr/boot_orig.rb` and `/tmp/cr/boot_fixed.rb`.

---

**My notes:** This is a plan only. I haven't changed your repository, which is still clean on `main`. In the copy, the main finding was proven: going to 1.3.8 on Rails 7.0.8.7 crashes on boot with a `Logger` NameError unless `require "logger"` is added to `config/boot.rb`. Two things are still unverified: the test suites and the server/Sidekiq runs haven't happened, and the 1.3.6–1.3.8 changelog notes come from the planner's memory. If you want, I can apply the `boot.rb` line, the Gemfile pin and the conservative bundle update, then run `bin/rails test` and `bin/rails test:system`.