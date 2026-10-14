The upgrade from 1.3.4 to 1.3.8 needs one code change. Bumping concurrent-ruby alone stops the app from booting. Adding `require "logger"` to `config/boot.rb` fixes it, and that line works on 1.3.4 as well. I tested both in a disposable copy.

## Context
- **Versions:** Ruby 3.3.6, Rails 7.0.8.7 (exact pin), Sidekiq 6.5.12. Gemfile line 8 has `gem "concurrent-ruby", "1.3.4"`, an exact pin. It is probably there because of the logger problem below.
- **Code that uses it directly:** none. Nothing in app, lib, config or test references `Concurrent::`. The gem is only pulled in through Active Support, Action Cable, i18n, sprockets and tzinfo.
- **Change summary** (`/tmp/cr/summary.txt`): no changelog entry matched application code. The only removal it flagged is the one from 1.3.5, "(#1062) Remove dependency on logger." It listed that entry twice and only read the 1.3.8 changelog.

## Finding 1 (required): the app fails to boot from 1.3.5 onward
- **Cause.** Up to 1.3.4, concurrent-ruby loaded `logger` as a side effect. Active Support 7.0 depends on that: `active_support/logger_thread_safe_level.rb:12` uses `Logger::Severity` before anything else has loaded `logger`. `rails/all` (`config/application.rb:3`) loads before `Bundler.require`, so Sidekiq's own `require "logger"` comes too late to help.
- **What I observed.** With only the gem bumped to 1.3.8, `bin/rails runner -e test` exited with code 1 (log: `/tmp/cr/boot_upgraded.log`):
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  This happens in every process that loads Rails: the server, console, rake, the test suite and Sidekiq workers. Nothing runs, so data cannot be affected.
- **When it applies.** Any concurrent-ruby version from 1.3.5 up, while the app stays on Rails 7.0. Rails 7.1 and later require `logger` themselves.
- **Repair.** In `config/boot.rb`, add `require "logger"` right after `require "bundler/setup"` and before `bootsnap/setup`. This loads the locked logger 1.7.0 gem; I confirmed it through `Logger#add`'s source location.
- **Alternatives.**
  - Keep the 1.3.4 pin. That avoids the error but means not doing the upgrade.
  - Upgrade Rails to 7.1. That is out of scope and changes framework defaults.
  - Put the require in `config/application.rb` before `rails/all`. That also works, but `boot.rb` is better because it covers every entry point that loads boot first.
- **Validation (executed, all in `/tmp/cr/app`):**
  - **Fails without the repair:** the 1.3.8 boot above exits 1 with the NameError.
  - **Passes with the repair:** boot exits 0 and prints `1.3.8` and `ActiveSupport::Logger` (`/tmp/cr/boot_fixed.log`). `zeitwerk:check` reports "All is good!" (`/tmp/cr/zw.log`).
  - **Test suite** against an isolated, throwaway Postgres database (`cr_upgrade_test_isolated`, dropped afterwards): 46 runs, 325 assertions, 0 failures and 0 errors (`/tmp/cr/test_fixed.log`).
  - **Controls:** the unmodified repo on 1.3.4 boots (`/tmp/cr/boot_control.log`). A second copy with the repair but still on 1.3.4 also boots (`/tmp/cr/boot_134_fixed.log`), so the preparatory change is safe on the current version.

## Gemfile and lockfile changes
- Change the Gemfile pin to `"1.3.8"`, then run `bundle lock --update concurrent-ruby`.
- In my experiment the only lockfile changes were `concurrent-ruby (1.3.8)` and the matching DEPENDENCIES line (`/tmp/cr/lock.log`, `/tmp/cr/install.log`).
- No other gem's version constraint blocks 1.3.8.

## New configuration defaults
None. concurrent-ruby has no framework defaults, and nothing in 1.3.5 through 1.3.8 adds settings this app would have to choose.

## Rollout and rollback
1. Ship the `boot.rb` require first, on 1.3.4. It is verified safe there.
2. Then ship the version bump.

There are no data or serialization format changes, so Sidekiq jobs already in the queue (Redis) are unaffected. During a mixed-version rollout only boot behaviour differs. A host running the bump without the require cannot start at all, so it fails loudly rather than corrupting anything. Rolling back is just reverting the lockfile.

## Not verified / open questions
- **Changelogs for 1.3.6 and 1.3.7.** The tool only read the 1.3.8 changelog, and I did not fetch the others. Before the bump, check them for changes to `Concurrent::Map`, timers and thread pools. Rails and Action Cable use those internally, but this app doesn't call them directly.
- **System tests not run.** I did not run `bin/rails test:system`.
- **Workers and cable not exercised.** I did not start a Sidekiq worker or the Redis-backed Action Cable path under 1.3.8. The proposed check: run a Sidekiq worker against an isolated Redis database index and perform one enqueued job, asserting it boots and completes. As a control, run the same job on 1.3.4 with the repair.
- **Production entry points.** Confirm that every production entry point (Puma, Sidekiq, rake) loads `config/boot.rb`. The standard `bin/` stubs do.

The experiment copies are `/tmp/cr/app` (1.3.8 with the repair) and `/tmp/cr/app134` (1.3.4 with the repair). I did not change the working repo.

---

**My notes:** The upgrade skill only plans upgrades, so nothing in your repo has changed yet. The main point is that bumping the version alone breaks the app on boot. The `require "logger"` line in `config/boot.rb` has to go in first or in the same change. If you want, I can make both changes (the boot require plus the Gemfile/lockfile bump) and run the test suite. Before merging, I'd still check the 1.3.6 and 1.3.7 changelogs and run the system tests, since neither has been done yet.