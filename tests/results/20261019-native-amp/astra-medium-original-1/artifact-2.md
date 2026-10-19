# Experiment evidence and reconstruction

All paths below originally lived beneath `/home/user/workspace/repo/.amp/in/rails-upgrade/`.
The disposable copies/resources were removed after evidence collection. Do not run these
commands in the working checkout or against its services. The application revision is
[ab732f5](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7).

## Resources and configuration

- Ruby 3.3.6, Bundler 2.5.22. Original and resolved lockfiles retained, with checksums.
- Two `git archive HEAD` copies, named `baseline` and `target`.
- `configure-isolation.sh` contains the exact database config creation commands.
  It created dedicated PostgreSQL databases `mn_rails_review_5586_baseline` and
  `mn_rails_review_5586_target` on local PostgreSQL 15.19, under role `user`.
- A **new Redis instance**, not merely a numbered DB on the app's Redis:
  `amp orb service start rails-upgrade-review-redis --command 'redis-server --bind 127.0.0.1 --port 16386 --save "" --appendonly no'`.
  Redis server version 7.0.15. Both sequential test variants used its DB 0.
- `configuration/*-env.sh` retains the environment exports and unset list.
  `RAILS_ENV=test`, `PARALLEL_WORKERS=1`, `REDIS_URL=redis://127.0.0.1:16386/0`.
  The SECRET_KEY_BASE value is intentionally disposable and is not a working-app secret.
- `configuration/*-database.yml` retains variant database names. All environment
  entries point to the same dedicated database per variant; DATABASE_URL was unset.
- Other config stayed at the checked-in revision except changes in `target-experiment.patch`.
  Cache NullStore; explicit MemoryStore probes; test Active Job adapter; Sidekiq fake
  adapter in tests; test mail delivery; test storage rooted in each copy's `tmp/storage`.
- Runtime Ruby scripts printed safe effective configuration and loaded gem versions.
  No production credentials or data were copied. No provider daemon or real mail delivery ran.

## Run sequence and attributable output

Commands were run from the specified copy directory with `source review-env.sh`,
unless noted. Mise trust was granted to the disposable copy config; an initial
untrusted-config bundle attempt did not execute Bundler and was corrected by trust.

1. Copy creation from repository root:
   `git archive HEAD | tar -x -C .amp/in/rails-upgrade/baseline` (and same for target).
   Only target's Rails Gemfile pin changed to 8.1.0 initially.
2. Target: `bundle lock --update rails --conservative`, then `bundle install`.
   `logs/target-bundle-lock.log`, `logs/target-bundle-install.log`,
   `logs/target-json3.Gemfile.lock`. The original resolution had json 3.1.0.
3. Root: `bash .amp/in/rails-upgrade/configure-isolation.sh` → `logs/isolation.log`.
4. Baseline: `ruby -v; bundle check; bin/rails db:schema:load; bin/rails test`
   → `logs/baseline-tests.log`: 46 runs, 325 assertions, all passing.
5. Target without application unlocks: `bin/rails runner 'puts Rails.version'`
   → `logs/target-unmodified-boot.log`: Action Text initializer crash.
6. Apply `unlock-target.sh` to the **copy only**. First trial had an invalid
   experimental `delegate ... to: :self` reader; this was later replaced with the
   explicit reader shown in the final patch/script. That temporary error is not
   classified as a Rails regression.
7. Target: `bin/rails db:schema:load; bin/rails test`
   → `logs/target-unlocked-tests.log`: 4 failures, 41 errors, mostly JSON signature failure.
   `BACKTRACE=1 bin/rails test test/models/note_test.rb:4`
   → `logs/target-unlocked-full-backtrace.log` identifies json 3.1.0 parse arity.
   A no-row query probe is retained in `target-unlocked-query-backtrace.log` (empty output).
8. Add `gem "json", "~> 2.0"` in target only; `bundle update json --conservative; bin/rails test`
   → `logs/target-json2-tests.log` and `logs/target-json2.Gemfile.lock`.
   Resolved json 2.21.2, removing the JSON failure. This run still included the
   temporary bad delegation reader: 3 failures, 20 errors.
9. Correct experimental reader to explicit `def highlight_color; color; end`.
   Baseline then target: `bin/rails runner ../probes.rb` → `logs/baseline-probes.log`,
   `logs/target-probes.log`. Runtime app version/defaults/dependencies are printed.
   Probes create synthetic records outside enclosing test transactions on purpose,
   so the import's real commit/rollback behavior is observable.
10. Baseline cross-read:
   `bin/rails runner 'require "active_job/arguments"; begin; p ActiveJob::Arguments.deserialize(JSON.parse(File.read("../logs/arguments-8.1.0.json"))); rescue => e; puts "#{e.class}: #{e.message}"; end'`
   → `logs/baseline-cross-read-target.log`.
   Both synthetic argument JSON files retained. Old reader rejects BigDecimalSerializer.
11. A suite run after the probes found fixture foreign-key violations: fixture
   replacement of notebooks left the deliberate probe imports referring to removed
   notebooks. Log retained as `target-probe-contaminated-tests.log`; **not** treated
   as an application upgrade failure. Recreated only the disposable target schema:
   `bin/rails db:schema:load; bin/rails test`
   → `logs/target-final-tests.log`: **46 runs, 174 assertions, 3 failures, 15 errors**.
   This remains an intentionally incomplete diagnostic target, not a repaired upgrade.
12. Copied the original baseline lock, both target locks, stdout/stderr logs,
   aggregate Rails test logs, scripts, environment/database configs, and final
   tracked-file patch here. A complete patch from original revision to the final
   diagnostic copy is `target-experiment.patch`, including its database isolation.

To reconstruct the final target, apply the retained patch to a **new disposable
copy**, install its retained lock, configure isolated resources anew, source its
retained environment, and run the command of interest. The hardcoded paths and
service names in the scripts are historical; choose unused resources for a new run.
For baseline use the original revision and only the isolation configuration.
Do not run schema load or the probe against valuable databases.

## Upstream source provenance

Downloaded and read via:

```sh
for v in 7.0.8.7 7.1.0 7.2.0 8.0.0 8.1.0; do
  curl -fsSL "https://codeload.github.com/rails/rails/tar.gz/refs/tags/v$v" |
    tar -xz -C .amp/in/rails-upgrade/sources
done
```

Versioned implementation/changelog URLs are in the assessment. No main-branch
behavior is presented as Rails 8.1.0 behavior. Relevant Rails source was inspected
in addition to the guide; specifically this prevented incorrectly claiming that
Rack 3 is required or that transactional enqueue deferral is always enabled.
The versioned Sidekiq 7 upgrade guide was read for conditional recommendations;
Sidekiq 7 was not installed/tested in a variant.

## Cleanup/delivery

The dedicated Redis service was stopped and both disposable databases dropped.
The scratch source archives/copies/scripts were removed after promoting the
retained evidence. Shared gems installed by Bundler remain available; the working
application's lockfile and all tracked files are unchanged. Only the permitted
local `/.amp/in/` exclude rule and ignored review artifacts were added. No commit,
push, deployment, existing queue mutation, or working-database preparation occurred.
