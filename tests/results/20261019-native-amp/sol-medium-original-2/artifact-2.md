# Experiment provenance and replay

Application source: [reviewed checkout](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). At assessment start/end the working application had no tracked changes; existing untracked `.amp/` plugin content was left alone. Read-only upstream archives were under `/tmp/rails-upgrade-eval-sources`. The report/evidence are ignored review artifacts, not application edits.

## Isolation and initial copies

From `/home/user/workspace/repo`:

```sh
mkdir -p /tmp/margin-rails-eval/{baseline,target,evidence}
tar --exclude=.git --exclude=.amp --exclude=storage --exclude=tmp --exclude=log \
  --exclude=config/master.key --exclude=config/credentials.yml.enc -cf - . |
  tar -xf - -C /tmp/margin-rails-eval/baseline
cp -a /tmp/margin-rails-eval/baseline/. /tmp/margin-rails-eval/target/
createdb margin_eval_6dd6_baseline
createdb margin_eval_6dd6_target
amp orb service start rails-eval-6dd6-redis --command \
  'redis-server --bind 127.0.0.1 --port 16438 --save "" --appendonly no --dir /tmp/margin-rails-eval'
```

The Redis command's explicit listener was 16438 (the service tool also reported its own managed port). It held only experiment data, and no workers were left running. Each copy's test configuration is the checked-in `config/environments/test.rb`; target changes are specified below. Disk storage resolves under the copy's root. Production/development databases or directories were not copied or touched. No inherited DATABASE_URL/REDIS_URL was used for app commands.

For all application commands, run from the selected copy, prefixed as follows:

```sh
# Baseline prefix:
env RAILS_ENV=test DATABASE_URL=postgresql:///margin_eval_6dd6_baseline \
  REDIS_URL=redis://127.0.0.1:16438/0 PARALLEL_WORKERS=1 mise exec -- COMMAND
# Target prefix:
env RAILS_ENV=test DATABASE_URL=postgresql:///margin_eval_6dd6_target \
  REDIS_URL=redis://127.0.0.1:16438/1 PARALLEL_WORKERS=1 mise exec -- COMMAND
```

The gem resolution commands use the copy's Gemfile/lockfile and do not boot the app or connect to services. Ruby 3.3.6, Bundler 2.5.22. Full resolved specs are the three retained lockfiles; no claim that a future unconstrained resolution reproduces these versions. To replay exactly, install with the appropriate saved lockfile.

## Cumulative variants / commands

1. **Baseline:** `bin/rails db:schema:load > baseline-schema.log 2>&1`, then `bin/rails test > baseline-test.log 2>&1`. Unmodified Gemfile/lockfile/config. Exit successful; 46/325, no failures/errors/skips.
2. **Target pin only:** substitute Rails `7.0.8.7` → `8.1.0` in copied Gemfile. `mise exec -- bundle update rails --conservative > target-bundle.log 2>&1`. Resolved state is `target-initial.Gemfile.lock` (reconstructed losslessly from the original lockfile + retained `dependency.diff`). `bin/rails zeitwerk:check > target-unmodified-boot.log 2>&1` failed at initializer; no eager-load success claimed.
3. **Allowlist unblocking only:** replace copied initializer content with:

   ```ruby
   ActionText::ContentHelper.allowed_tags = (ActionText::ContentHelper.allowed_tags ||
     (ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])) + %w[details summary]
   ```

   `bin/rails db:schema:load > target-schema.log 2>&1`, then `bin/rails test > target-allowlist-only-test.log 2>&1`. All 46 errors. This workaround uses the configured HTML4 vendor with 7.0 defaults; it is not a completed HTML5 adoption.
4. **Model compatibility unblocking:** in copied Note use positional enum with `prefix: true`, `serialize :tags, coder: JSON`, and explicit highlight getter/setter delegating to `color`. `bin/rails test > target-model-compat-test.log 2>&1`. Other app code unchanged; 14 failures/32 errors.
5. **Routes/test mode unblocking:** split GET routes and change test `show_exceptions` false → `:none`. `bin/rails test > target-routes-test.log 2>&1`. 4 failures/41 errors. To diagnose JSON: `bin/rails runner 'begin; p User.first; rescue => e; warn e.full_message; end' > target-query-trace.log 2>&1` (success reading just User does not exercise Note JSONB), then `bin/rails test test/controllers/reminders_controller_test.rb:38 -b > target-test-trace.log 2>&1` (JSON wrong-arity backtrace).
6. **JSON compatibility unblocking:** append `gem "json", "2.7.2"` to copied Gemfile. `mise exec -- bundle update json --conservative > target-json-bundle.log 2>&1`, then `bin/rails test > target-json2-test.log 2>&1`. 3 failures/15 errors. Final complete cumulative diff excluding generated schema/log/tmp changes is `experimental-variant.diff`; lockfile is `target-json2.Gemfile.lock`. This is intentionally not a fully repaired upgrade.
7. **Behavior probes:** retained script `probes.rb` executed first in baseline, then target with the same env above, but Redis database 2, and respectively `PAYLOAD_PATH=/tmp/margin-rails-eval/evidence/baseline-payload.json` and `.../target-payload.json`:

   ```sh
   bin/rails runner /tmp/margin-rails-eval/evidence/probes.rb > VARIANT-probes.log 2>&1
   ```

   Restore the retained probe scripts into `/tmp/margin-rails-eval/evidence/` for replay. These create synthetic probe User/Notebook/Import/Citation records only in their disposable databases, outside fixture transactions. The rescue wrapper intentionally prints exceptions and continues; a zero script exit is not a passing-test assertion. Read the actual observed outputs. `settings alias` in the main target probe uses the explicit unblocking methods, not the original alias.
8. **Additional probes:** `bin/rails runner /tmp/margin-rails-eval/evidence/extra-probes.rb > VARIANT-extra-probes.log 2>&1`, using Redis database 2. In each fresh process, creates a separate alias with the original `alias_attribute` behavior. Baseline then reads target payload to test reverse compatibility. Target individually enables readonly assignment behavior before loading Notebook, and date decoding before reconnecting. Those opt-ins do not persist or affect earlier test runs. Date decoding probe's printed TypeError occurs inside `Date.iso8601(Date)`; it deliberately demonstrates the app's incompatible assumption.
9. **Sidekiq initialization only:** target env, Redis database 3, runner command below. No worker execution was performed:

   ```sh
   bin/rails runner 'begin; ActiveJob::Base.queue_adapter = :sidekiq; puts ActiveJob::Base.queue_adapter.class; rescue => e; warn e.full_message; end' > target-sidekiq-adapter.log 2>&1
   ```

Rails logs for baseline and the cumulative target were copied as `baseline-rails-test.log` and `target-rails-test.log`. Variant-specific stdout/stderr is separate for each invocation. Probes use `JSON.generate`/`JSON.parse` to simulate the queue's JSON round trip; these must not be mistaken for actual worker/Redis execution checks.

## Cleanup

After retaining evidence, stop only the experiment Redis service and drop only the two named disposable databases. Copies and downloaded upstream sources may be removed; report, lockfiles, scripts, diff and logs are the retained review/replay evidence. Application working tree must remain unchanged. Production rollout commands in PLAN.md are recommendations, not executed actions.

Cleanup executed: experiment Redis service stopped; both named disposable databases dropped; /tmp experiment copies and upstream downloads removed. Retained evidence remains beside this file.
