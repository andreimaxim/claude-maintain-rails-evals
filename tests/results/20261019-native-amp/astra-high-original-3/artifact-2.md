# Experiment record — 2026-10-19

All paths below are absolute after expanding these constants:

```sh
REPO=/home/user/workspace/repo
SCRATCH=$REPO/.amp/in/rails-upgrade-audit
OUT=$REPO/.amp/in/artifacts/rails-upgrade-audit
```

The repository-local `.git/info/exclude` was extended with only `/.amp/in/` before writing scratch/evidence. Existing untracked `.amp/plugins/maintain-rails/` files were left untouched. No tracked working-tree or staging changes were made. The source revision is linked in PLAN.md.

## Isolation and variant construction

From `$REPO`:

```sh
mkdir -p "$SCRATCH/variants/baseline" "$SCRATCH/variants/target" "$SCRATCH/redis" "$OUT"
git archive HEAD | tar -x -C "$SCRATCH/variants/baseline"
git archive HEAD | tar -x -C "$SCRATCH/variants/target"
# Only in disposable target:
sed -i 's/gem "rails", "7.0.8.7"/gem "rails", "8.1.0"/' "$SCRATCH/variants/target/Gemfile"
psql -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE rails_audit_7100_baseline' \
  -c 'CREATE DATABASE rails_audit_7100_target'
amp orb service start rails-audit-7100-redis --command \
  'redis-server --bind 127.0.0.1 --port 16391 --save "" --appendonly no --dir /home/user/workspace/repo/.amp/in/rails-upgrade-audit/redis'
```

- Each copy's database.yml was replaced with an explicit PostgreSQL database name (`rails_audit_7100_baseline` or `rails_audit_7100_target`) for **all three environments**, pool 5. Exact files retained. DATABASE_URL was unset for DB/app commands.
- Dedicated Redis **127.0.0.1:16391**: baseline DB 0, target DB 1. This was a separate process, not an arbitrarily selected database of the application Redis. Persistence disabled. The orb service command's advertised portal port is not the Redis connection endpoint; the server log and successful connections establish 16391.
- No existing DB, storage, cache, secrets, or log files were copied. `git archive` copied only tracked files. Storage and cache paths are rooted inside each disposable checkout (`storage`, `tmp/storage`, `tmp/cache`); no links to working application directories. The baseline used test mail delivery and test queue adapter; native Sidekiq jobs use its fake mode in the existing test helper. Digest reservation calls use the dedicated Redis.
- Test parallelism fixed to one worker to avoid implicit extra database clones.
- The target bundle installed to `$SCRATCH/bundle`; baseline used the already-installed gems from the original lockfile. Target variants shared that installation directory but selected versions through separate lockfiles. No source gems were modified.
- The `target-json2` copy was created with `cp -a target target-json2` after the initial target run, and added only `gem "json", "< 3"`. It reused the **disposable target database**, sequentially; no concurrent DB probes ran against that DB. Its application itself was not repaired/booted successfully.

## Source acquisition

From `$REPO`, for each version 7.0.8.7, 7.1.0, 7.2.0, 8.0.0, 8.1.0:

```sh
curl -fsSL "https://codeload.github.com/rails/rails/tar.gz/refs/tags/v${version}" \
  -o "$SCRATCH/upstream/rails-${version}.tar.gz"
tar -xzf "$SCRATCH/upstream/rails-${version}.tar.gz" -C "$SCRATCH/upstream"
```

Tags, URLs and checksums retained in report / `upstream-archive-sha256.txt`. Versioned release/upgrade guidance was also read via web tools. Source inspection was read-only. Archives were removed after retaining evidence; no Rails source checkout was patched.

## Application baseline

Working directory `$SCRATCH/variants/baseline`:

```sh
env -u DATABASE_URL RAILS_ENV=test REDIS_URL=redis://127.0.0.1:16391/0 PARALLEL_WORKERS=1 \
  mise exec -- bin/rails db:schema:load > "$OUT/baseline-schema.log" 2>&1
env -u DATABASE_URL RAILS_ENV=test REDIS_URL=redis://127.0.0.1:16391/0 PARALLEL_WORKERS=1 \
  mise exec -- bin/rails test > "$OUT/baseline-test.log" 2>&1
```

Both exit 0. 46 tests / 325 assertions / 0 failures/errors/skips. Full Rails log retained as `baseline-rails-test.log` (synthetic fixtures only). Initial attempts used an incorrect relative output path; shell redirection failed **before either command ran**. The above absolute-path commands are the executed baseline.

## Target dependency resolution / boot

Working directory `$SCRATCH/variants/target`:

```sh
mise exec -- bundle lock --update rails > "$OUT/target-resolve.log" 2>&1
mise exec -- bundle config set --local path "$SCRATCH/bundle"
mise exec -- bundle install > "$OUT/target-install.log" 2>&1
env -u DATABASE_URL RAILS_ENV=test REDIS_URL=redis://127.0.0.1:16391/1 PARALLEL_WORKERS=1 \
  mise exec -- bin/rails runner 'puts Rails.version' > "$OUT/target-boot.log" 2>&1
env -u DATABASE_URL RAILS_ENV=test REDIS_URL=redis://127.0.0.1:16391/1 \
  mise exec -- bundle exec ruby -e 'require "sidekiq"; require "active_job"; ActiveJob::Base.queue_adapter = :sidekiq; puts "adapter=#{ActiveJob::Base.queue_adapter.class}"' \
  > "$OUT/target-sidekiq-adapter.log" 2>&1
```

Resolution/install/adapter construction exit 0; boot exit 1 (`allowed_tags` nil). Target full tests were **not run**. An initial resolver attempt also failed only at the incorrect log redirection path before running Bundler; the retained resolve log is the successful execution.

## Framework probes

`probe.rb` is a standalone framework probe, not an application initializer or kept project test. It uses the selected variant's complete bundle, no app boot, Active Job test adapter, UTC worker zone, an isolated PostgreSQL connection, and creates only two synthetic audit tables in the disposable DB. It tests the exact risky framework operations and several recommended expression replacements. No external network requests or blob uploads occur.

Working directory `$SCRATCH/variants/baseline`:

```sh
env -u DATABASE_URL AUDIT_DB=rails_audit_7100_baseline AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/0 \
  mise exec -- bundle exec ruby ../../probe.rb > "$OUT/baseline-probe.log" 2>&1
```

Working directory `$SCRATCH/variants/target`:

```sh
env -u DATABASE_URL AUDIT_DB=rails_audit_7100_target AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/1 \
  mise exec -- bundle exec ruby ../../probe.rb > "$OUT/target-probe.log" 2>&1
```

The first script is retained as `probe-initial.rb`; outputs are retained as `baseline-probe-initial.log` / `target-probe-initial.log` as well as the original log names. Unexpected replacement failures were investigated, not called Rails API regressions: the script was augmented to print five backtrace frames on errors (`probe-diagnostic.rb`, also the final `probe.rb`) and target re-run as `target-probe-diagnostic.log`. The stack showed JSON 3 incompatibility. `json3-decoder-evidence.txt` retains both relevant installed method definitions.

Working directory `$SCRATCH/variants/target-json2`:

```sh
mise exec -- bundle lock --update json > "$OUT/target-json2-resolve.log" 2>&1
mise exec -- bundle install > "$OUT/target-json2-install.log" 2>&1
env -u DATABASE_URL AUDIT_DB=rails_audit_7100_target AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/1 \
  mise exec -- bundle exec ruby ../../probe.rb > "$OUT/target-json2-probe.log" 2>&1
```

JSON constraint resolved 2.21.2. Original target lockfile/logs were preserved. Every probe prints version and loaded dependencies; failures are printed as observed outcomes, not hidden by assertions. Script exit 0 means the probe finished collecting outcomes, **not** that all cases passed. The standalone script tests class defaults and explicitly toggles the named new default flags, not a complete initialized Rails application's `load_defaults` configuration. PLAN.md uses source tracing to establish which flags the real application would activate.

`7.0.8.7.arguments.json` is the baseline serialized argument fixture. `8.1.0.arguments.json` is the final JSON-2 target run's fixture (the same-shaped initial JSON-3 file was superseded). Complete original and prepared real-Sidekiq fixtures below are separately retained.

## Real Redis queue / cross-version wire experiment

`wire_probe.rb` defines a synthetic `AuditDigestJob` with the application's timestamp/completion argument shape and date-range/decimal interpretation, **without a User GlobalID, model lookup or actual mailer**. It uses the real Sidekiq adapter, writes to queue `audit` on the dedicated Redis, then retrieves each JSON job immediately with `LPOP`. No real worker daemon is launched. The consumer calls `ActiveJob::Base.execute` on the captured inner payload; this verifies Active Job deserialization/execution, not Sidekiq worker concurrency or the complete app mailer query.

First, in baseline and target-json2 respectively (independent Redis DBs):

```sh
env AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/0 \
  mise exec -- bundle exec ruby ../../wire_probe.rb emit > "$OUT/baseline-wire-emit.log" 2>&1
env AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/1 \
  mise exec -- bundle exec ruby ../../wire_probe.rb emit > "$OUT/target-json2-wire-emit.log" 2>&1
```

After both emitters finished, in those same directories:

```sh
env AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/0 \
  mise exec -- bundle exec ruby ../../wire_probe.rb read > "$OUT/baseline-wire-read.log" 2>&1
env AUDIT_OUT="$OUT" REDIS_URL=redis://127.0.0.1:16391/1 \
  mise exec -- bundle exec ruby ../../wire_probe.rb read > "$OUT/target-json2-wire-read.log" 2>&1
```

Results and payloads retained. Original 8.1→7.0 payload throws unknown BigDecimalSerializer; 8.1→8.1 original payload produces October 4 Eastern rather than October 5 UTC. Both prepared payloads produce October 5 UTC with decimal String on both readers. These are synthetic observations and do not establish app worker/mailer correctness.

## Configuration/dependency attribution

- `baseline.Gemfile` / `baseline.Gemfile.lock`: original project.
- `target.Gemfile` / `target.Gemfile.lock`: only Rails version changed.
- `target-json2.Gemfile` / `target-json2.Gemfile.lock`: Rails version plus JSON <3 constraint.
- `*.database.yml`: explicit experiment DB names; no credentials.
- `config-snapshot/`: application/defaults, three environments, storage and Cable configuration; tracked secrets/credentials not copied into evidence.
- `baseline-rails-test.log`: actual baseline Rails runtime log.
- `redis-service.log`: dedicated server's log; no application Redis used.

## Cleanup and delivery state

Executed after retaining evidence:

```sh
amp orb service logs rails-audit-7100-redis > "$OUT/redis-service.log" 2>&1
amp orb service stop rails-audit-7100-redis
psql -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE rails_audit_7100_baseline' \
  -c 'DROP DATABASE rails_audit_7100_target'
rm -rf "$SCRATCH"
```

Both disposable DBs were dropped and the dedicated Redis service stopped. Disposable app copies, installed experiment bundle, generated local secrets, storage/cache, upstream source archives and scratch probe files were removed. Deliberately retained evidence scripts in this artifact directory are review/reproduction artifacts, not application changes. No commit, push, merge or deployment was performed.
