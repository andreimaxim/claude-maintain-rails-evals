# Experiment record

Date: 2026-10-19 UTC. Repository source snapshot: [ab732f5](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7).

Working application root `/home/user/workspace/repo` was only read. The repository-local Git exclude was extended with `/.amp/in/` before artifact/scratch creation; existing ignore rules and pre-existing untracked `.amp/` content were preserved. Downloading/installing target dependencies added gems to the sandbox Ruby installation but did not change the working application's Gemfile or lockfile. Experiments never used the configured application PostgreSQL databases, default Redis, existing storage or cache roots.

## Isolation

Scratch root used: `/home/user/workspace/repo/.amp/in/rails-upgrade`.
Artifacts root: `/home/user/workspace/repo/.amp/in/artifacts/rails-upgrade`.

Each checkout was produced with `git archive HEAD | tar -x -C <variant>` (not by copying untracked files, credentials keys, databases, uploads or caches). `mise trust <variant>/mise.toml` was needed for the copied configuration. No setup/resume scripts were run.

Dedicated PostgreSQL 15.19 initialized and started:

```sh
mkdir -p .amp/in/rails-upgrade/services/{pg,socket,redis}
/usr/lib/postgresql/15/bin/initdb -D .amp/in/rails-upgrade/services/pg --auth=trust --no-locale
amp orb service start mn-upgrade-pg --command '/usr/lib/postgresql/15/bin/postgres -D /home/user/workspace/repo/.amp/in/rails-upgrade/services/pg -k /home/user/workspace/repo/.amp/in/rails-upgrade/services/socket -p 55439 -c listen_addresses= -c logging_collector=on -c log_directory=/home/user/workspace/repo/.amp/in/artifacts/rails-upgrade -c log_filename=postgres.log'
amp orb service start mn-upgrade-redis --command 'redis-server --port 0 --unixsocket /home/user/workspace/repo/.amp/in/rails-upgrade/services/redis/redis.sock --unixsocketperm 700 --dir /home/user/workspace/repo/.amp/in/rails-upgrade/services/redis --logfile /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/redis.log --save "" --appendonly no'
```

PostgreSQL listened on a dedicated Unix socket, not TCP. Dedicated Redis listened only on its Unix socket, not port 6379. Variants used distinct databases `mn_upgrade_baseline`, `mn_upgrade_target`, `mn_upgrade_defaults`. Redis DB 0 was shared **only among sequential experiments**, not with the working application. Digest reservation tests released their fixture/day keys; the direct queue probes used distinct `upgrade_probe_baseline` and `upgrade_probe_target` queues and deleted their own inspected items. No Sidekiq daemon processed queues during these checks. Separate-variant Redis isolation was not needed for concurrent consumers because there were none; do not run these scripts concurrently against one Redis database when testing different transport assumptions.

The no-locale initdb selected SQL_ASCII for template1. Initial Rails database creation/test purge failed because Rails requests UTF8. This was an **experiment setup failure**, not a Rails regression. Databases were explicitly created with `createdb -h <absolute-socket-dir> -p 55439 -T template0 -E UTF8 <variant-db>`, and copied database.yml files were set to `template: template0`, `encoding: unicode` so Rails could re-create them. Superseded errors are retained in `*-initial-environment-error.log` and `baseline-tests-template-error.log`.

All variants' database configurations required `ENV.fetch("DATABASE_URL")` for every Rails environment (no fallback to application databases). All Active Storage Disk roots were beneath their copied Rails.root (`tmp/storage` in test; production `storage`); FileStore/MemoryStore cache use was also variant-local. Copied storage roots contained only fixture/probe uploads. The original encrypted credentials file was copied as tracked source, **not decrypted**, and no master key was copied. Runtime mail was test deliveries; the production asset command sent no mail. The citation endpoint was forced to a loopback port that rejects connections outside the scripted loopback test server.

## Runtime/environment and commands

Ruby 3.3.6, Bundler 2.5.22, Linux x86_64. Exact helper in `reproduction/run-variant` records working directory, command and these non-sensitive endpoints per execution:

```text
RAILS_ENV=test
PARALLEL_WORKERS=1
DATABASE_URL=postgresql:///mn_upgrade_<variant>?host=/home/user/workspace/repo/.amp/in/rails-upgrade/services/socket&port=55439
REDIS_URL=unix:///home/user/workspace/repo/.amp/in/rails-upgrade/services/redis/redis.sock?db=0
SECRET_KEY_BASE=<fixed disposable string; see runner>
CITATION_PROVIDER_URL=http://127.0.0.1:1
CITATION_PROVIDER_USER=margin-notes
CITATION_PROVIDER_PASSWORD=local-only
RAILS_MASTER_KEY and MARGIN_NOTES_DATABASE_PASSWORD unset
```

The citation username/password here are repository test-fixture values, not real service credentials. One early baseline run used `disposable:disposable` instead and failed the test's exact expected Basic auth. It was corrected to fixture values, with the original log retained as `baseline-tests-credentials-error.log`. Baseline **final** suite result is `baseline-tests.log`.

Rails 7.0 ignores the SECRET_KEY_BASE env variable in test, reading `tmp/development_secret.txt` instead. For the final signature/cookie comparison, that disposable baseline file was explicitly set to the same synthetic value used by target/defaults. The earlier mismatched-secret signature logs are retained as `*-signatures-initial-secret-mismatch.log` and cannot be used to infer a format incompatibility. No key bytes from the working application were used.

Invocations, from the repository root, were of this form (their exact command lines also appear in logs):

```sh
.amp/in/rails-upgrade/run-variant baseline bin/rails db:prepare
.amp/in/rails-upgrade/run-variant baseline bin/rails test
.amp/in/rails-upgrade/run-variant target bin/rails zeitwerk:check
.amp/in/rails-upgrade/run-variant target bin/rails db:prepare
.amp/in/rails-upgrade/run-variant target bin/rails test
.amp/in/rails-upgrade/run-variant target bin/rails db:schema:load
.amp/in/rails-upgrade/run-variant defaults bin/rails zeitwerk:check
.amp/in/rails-upgrade/run-variant defaults bin/rails db:schema:load
.amp/in/rails-upgrade/run-variant defaults bin/rails test
.amp/in/rails-upgrade/run-variant target env RAILS_ENV=production bin/rails assets:precompile
# For each relevant baseline/target/defaults variant:
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../probe.rb
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../cross-read.rb
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../queue-probe.rb
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../signature-probe.rb
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../signature-read.rb
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../cookie-probe.rb
.amp/in/rails-upgrade/run-variant <variant> bin/rails runner ../defaults-probe.rb
```

The wrapper prints RAILS_ENV=test before executing the command; the explicit `env RAILS_ENV=production` subcommand overrides it for the production asset build. Its DB still points only at the dedicated target database.

`probe.rb` intentionally performs writes outside a test transaction to expose non-local-return commit behavior. It leaves synthetic import data in the disposable target database. A subsequent suite run therefore hit fixture foreign-key errors (fixtures clear some tables but the probe-created import remained). That run is `target-tests-runtime-fixed.log` (46 setup errors, zero assertions). The **diagnosed** remedy was `db:schema:load` on that dedicated disposable target database (`target-reset-after-probes.log`); final suite output is `target-tests-runtime-fixed-final.log`. Do not use the failed setup run as an application regression, and do not use this remedy on a non-disposable database.

## Dependency and configuration variants

- Baseline: original Gemfile/lock, only isolated database configuration. Full `baseline.Gemfile.lock`, `baseline-final.diff`, `baseline-config/`.
- Initial target: only Rails pin changed to 8.1.0 plus isolated database configuration. `bundle update rails` resolved JSON 3.1.0, Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, Puma 5.6.9, Sidekiq 6.5.12, redis-rb 4.8.1, pg 1.6.0 and BigDecimal 4.1.3. `target.Gemfile.lock` and `target-bundle.log` retain that resolution.
- Target with JSON2: appended `gem "json", "< 3"`; `bundle update json` resolved 2.21.2. Full `target-json2.Gemfile.lock`, `target-bundle-json2.log`. `target-config/` is the final config snapshot including this constraint.
- Experimental target final: old defaults (7.0); repaired sanitizer initializer, enum, tags coder, highlight getter/setter, route declarations, test exception mode, provider config/test helper, retry wait symbol, Time-valued reminder scheduling, joining export fragments, filter association, unbound form, preview annotation lookup, receipt DOI, explicit import rollback, UTC mailer date. Changed reminder calculation to named-zone elapsed arithmetic and one test's DST display expectation. The raw BigDecimal producer was **not** changed in the experiment; its incompatible payload is deliberately retained as evidence. Complete `target-final.diff` includes every experimental tracked-source/test/config change plus the new citation config initializer. No production-ready patch is implied.
- Defaults variant: copied experimental target final, changed `load_defaults 8.1`; initial boot failed at implicit preferences coder. Added `serialize :preferences, coder: YAML` only, then ran tests. It did **not** repair readonly/date/negative-expiry defaults failures. Full `defaults-final.diff`, `defaults-config/` and lock.

Final diffs are relative to the original source snapshot. `target-stage-compatibility.diff` is an intermediate diagnostic snapshot, not the final experimental state. Boot-stage log sequence: `target-initial-boot.log` (nil allowed_tags), `target-after-sanitizer-boot.log` (enum), `target-after-enum-boot.log` (positional serialize), `target-after-serialize-boot.log` (eager-load succeeds; lazy aliases/routes still need request execution). Request-stage failures are retained as `target-tests-minimal.log`, `target-tests-alias-routes.log`, `target-tests-json2.log`, `target-tests-exceptions.log`, `target-tests-compatibility.log`; later fixes are recorded in the final diff. These superseded runs must not be mistaken for results of the final repaired variant.

## Outputs and retained evidence

- Every `*-tests*.log` includes command, seed, output and exit status. Final suites: baseline 46/325 passing; repaired target 46/340 passing with the documented one-expectation change; defaults 46/325 with 3 errors after the explicit YAML coder.
- `target-session-backtrace.log` pinpoints JSON 3 failure in ActiveSupport cookie metadata decoding.
- `baseline-probes.log`, `target-probes.log`: Date/time formatting, integer key stringify, custom ID access, cache expiry, JSON arguments, import transaction and deferral setting.
- `*-cross-read.log` + `*-arguments.json`: argument transport matrix. The helper catches and prints deserialization errors, so **exit 0 is not a successful compatibility assertion**; inspect the printed outcome.
- `*-queue-probe.log` + `*-sidekiq-job.json`: real Redis enqueue/retrieve, manually execute actual JSON envelope, inspect email subject, delete that item. No separately running Sidekiq worker, retry loop or shutdown was exercised.
- `*-signatures-final-read.log` is the authoritative signed-ID/SGID reader matrix after all writers generated with the same synthetic key. Earlier `*-signatures.log` includes incremental writer availability; final-read logs test all three every time. Helpers catch/print errors, so exit code alone is not success.
- `*-cookies.log`: actual sign-in then notebook GET with each writer's cookie in a fresh integration session; all nine final combinations status 200. Tokens/payloads are synthetic fixture/probe artifacts only.
- `target-defaults-probe.log`, `defaults-defaults-probe.log`: readonly/YAML/raw-date and conflicting HTTP validators. The initial raw `freshness` probe was corrected to set an exact ETag header and inspect the actual class setting; the retained final logs show false/false vs true/true for strictness/freshness.
- `baseline-rails-test.log`, `target-rails-test.log`, `defaults-rails-test.log`: Rails application logs; suite logs carry the precise command and stage result.
- `initdb.log`, `postgres.log`, `redis.log`: dedicated service logs. Any apparent failed DB connection in these logs belongs to the isolated setup/probes, not the application services.
- `upstream/`: downloaded 8.1.0 tagged source archive, 7.1/7.2 changelogs and 8.0 relevant changelogs; links in PLAN.md specify the versioned sources. This archive is reference evidence, not a vendored dependency.

## Reproduction and cleanup

To repeat, reconstruct disposable checkouts from the linked source snapshot beneath the same scratch root, apply each `*-final.diff` only to its named copied checkout (strip the path prefix), restore the matching Gemfile.lock/config, copy `reproduction/*` scripts into the scratch root, initialize the dedicated services, and execute the listed commands. Restore the same synthetic local key for the baseline signature checks. Do not point the wrapper at shared services. Run tests before write-heavy probes, or reload only the disposable schema afterward. Bundle resolution against today's index can differ; use the retained lock when attributing a replay to a tested variant.

At the end of this evaluation the two dedicated orb services are stopped and the disposable checkouts, their synthetic databases/storage/cache and scratch helper files are removed. All commands/scripts, configs, diffs, resolved locks, versioned upstream references, payloads and output/logs remain in this ignored artifact directory. No working-application upgrade is left staged or unstaged. Pre-existing untracked `.amp/` content remains untouched.
