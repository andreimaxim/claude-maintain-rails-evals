## Plan: concurrent-ruby 1.3.4 to 1.3.8 for Margin Notes

**Verdict:** the upgrade needs one change before it can ship. With only the version bump, the app fails to boot. One added line (`require "logger"`) fixes it, and that line works on the current 1.3.4 as well, so it can go in first.

### Context (from the source)
- The Gemfile pins `rails "7.0.8.7"` and `concurrent-ruby "1.3.4"`. Ruby is 3.3.6. `logger (1.7.0)` is already in Gemfile.lock as a dependency of other gems.
- The application's own code never uses `Concurrent::` (grep of app/, lib/ and config/ found nothing). The gem is only used through Rails: Active Support, Action View/Cable, Active Job, Puma and i18n.
- The changelog summary is at `/tmp/cr-changes.txt`. The only relevant entry is 1.3.5 "(#1062) Remove dependency on logger". concurrent-ruby has no framework defaults, so there is no new config value to adopt or keep.

### Finding 1 (required): the app does not boot after the bump
- **Affected code:** `config/boot.rb` and how Rails loads. Active Support 7.0's `active_support/logger_thread_safe_level.rb` uses `::Logger` without requiring it. Rails 7.0 relied on concurrent-ruby 1.3.4 and earlier to load `logger` for it, and 1.3.5 stopped doing that.
- **What happens if nothing is done (executed):** every boot fails, including the server, console, runner, rake tasks, tests and jobs:
  `activesupport-7.0.8.7/lib/active_support/logger_thread_safe_level.rb:12:in '<module:LoggerThreadSafeLevel>': uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger (NameError)`
  Log: `/tmp/cr-boot.log`.
- **When it applies:** any Rails 7.0.x with concurrent-ruby 1.3.5 or later. Rails 7.1 and later require `logger` themselves.
- **Fix (recommended):** in `config/boot.rb`, add `require "logger"` right after `require "bundler/setup"` and before bootsnap and Rails load. Then change the Gemfile to `"1.3.8"` and run `bundle update concurrent-ruby --conservative`.
  - **Alternative 1:** keep concurrent-ruby at 1.3.4. This avoids the error but does not upgrade.
  - **Alternative 2:** upgrade to Rails 7.1 or later. That also fixes it, but it is a much bigger change and needs separate authorisation under CLAUDE.md.
  - **Not enough on its own:** adding `gem "logger"` to the Gemfile. Bundler then requires gems in Gemfile order, so it only works if it comes before rails. The explicit require in boot.rb is the reliable fix.
- **Works on the current version:** yes. I ran the suite on 1.3.4 with the boot.rb change: 46 runs, 0 failures (`/tmp/cr-ctl-test.log`). So the boot.rb change can be merged and deployed first, on its own.

### Validation
Run each with `DISABLE_BOOTSNAP=1 RAILS_ENV=test`. These are already done in the copy and should be repeated in CI.
1. **Check that discriminates:** 1.3.8 without the fix, `bin/rails runner 'p Concurrent::VERSION'`, exits 1 with the NameError above. 1.3.8 with the fix exits 0 and prints `"1.3.8"` (`/tmp/cr-boot2.log`).
2. **Control:** the full suite passes with the fix on both 1.3.8 (`/tmp/cr-test.log`, 46 runs, 325 assertions, 0 failures) and 1.3.4 (`/tmp/cr-ctl-test.log`, same counts).
3. **Still proposed, not run:**
   - The system tests (`bin/rails test:system`).
   - Start `bin/rails server` in the development environment, sign in, create and edit a note, and use search. Confirm the rich-text note saves and renders, and that request logging works, since that path goes through `LoggerThreadSafeLevel`.
   - Boot the production environment (for example `RAILS_ENV=production bin/rails runner 1` with dummy secrets) to cover eager loading. Also run `bin/rails zeitwerk:check`.

### Optional default adoption
None. concurrent-ruby adds no framework defaults, and 1.3.4 to 1.3.8 has no Rails `new_framework_defaults`.

### Rollout and rollback
- concurrent-ruby does not change stored data or serialised formats here. Active Job's test adapter and the app's own code do not touch concurrent-ruby state, so jobs already in the queue are not affected.
- The risk during a mixed-version rollout is entirely at boot. Any process that gets 1.3.8 without the boot.rb line will crash on start. So ship the boot.rb change first (or in the same commit as the lock change), then the version bump.
- Rollback means restoring the Gemfile and lock to 1.3.4. The `require "logger"` line can stay, since it is harmless.

### Unverified and open questions
- I only read the 1.3.5 changelog entry. The other four entries for 1.3.5 to 1.3.8 were not matched to any app code, and I did not review them one by one. They appear to be internal fixes, and the app does not use the gem directly.
- System tests, the production environment and the dev server were not run.
- Running with bootsnap enabled was not tested.
- Ruby printed a warning about `mutex_m` on 3.3. It is unrelated to this upgrade and becomes an error on Ruby 3.4.

### Experiment record
- **Copy:** `/tmp/cr-exp` (the 1.3.8 variant; `.git` removed). Test database `margin_notes_crexp_test`, storage at `/tmp/cr-exp/tmp/storage`. The test environment uses the `:null_store` cache and the `:test` job adapter, so no shared services were touched.
- **Control copy:** `/tmp/cr-ctl` (1.3.4 plus the fix, using the same isolated test database).
- **Command:** `bundle update concurrent-ruby --conservative`. Only concurrent-ruby moved, to 1.3.8; logger stayed at 1.7.0. Log: `/tmp/cr-bundle.log`.
- The working repo was not changed.

---

**Note:** The upgrade skill only plans, so I haven't changed your repository yet. The main point: if you only bump the version, the app won't boot. You also need to add `require "logger"` to `config/boot.rb`. Do you want me to make both changes and run the tests?