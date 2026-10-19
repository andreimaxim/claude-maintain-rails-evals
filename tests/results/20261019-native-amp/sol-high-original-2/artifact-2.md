# Experiment attribution and commands

All commands ran on 2026-10-19 in the local sandbox, approximately 07:41–08:02 UTC. No command booted or tested the working application. Its tracked snapshot was archived into disposable directories first.

## Resources and runtime

- Original repository: `/home/user/workspace/repo`.
- Scratch prefix (removed after evidence retention): `/home/user/workspace/repo/.amp/in/rails-upgrade` (`$P` below).
- Evidence prefix (retained): `/home/user/workspace/repo/.amp/in/artifacts/rails-upgrade` (`$A`).
- Ruby executable path used for copy commands: `/home/user/.local/share/mise/installs/ruby/3.3.6/bin`; Ruby 3.3.6p108, Bundler 2.5.22.
- PostgreSQL: 15.19, **new trust-authenticated private cluster** in `$P/pgdata`, bound port 55483, socket `$P/pgsocket`. Database per application copy: `rails_upgrade_baseline`, `rails_upgrade_target`, `rails_upgrade_prepared70`. Tests use one worker (`PARALLEL_WORKERS=1`). Existing development/test/production databases were not read or changed.
- Redis: **new private Redis server** on `127.0.0.1:6393/0`, persistence disabled, `$P/redis`. Baseline/target experiments ran serially when using it. This is not the app's default port 6379. Exact Redis binary version is retained in `redis-version.txt`.
- Cache: copy-local test environment NullStore except explicit per-process MemoryStore probes/tests. No application Redis cache configured.
- Disk storage: `test` root `$P/<variant>/tmp/storage`, `local` root `$P/<variant>/storage`. No working-app files/storage copied. Cable test adapter; no real pub/sub.
- Mail: ActionMailer `:test`; synthetic addresses only. Citation HTTP: scripted loopback Puma provider in existing tests; default probe URL is a refused loopback port. No external provider called.
- The environment wrapper unsets `DATABASE_URL`, `RAILS_MASTER_KEY`, `BUNDLE_GEMFILE`; sets `RAILS_ENV=test`, private Redis URL, one worker, synthetic `SECRET_KEY_BASE`, and local-only provider fixture credentials. **Rails 7.0 test mode ignores the SECRET_KEY_BASE environment variable in favor of its local secret file.** Therefore the final signature-format probe uses an explicitly identical synthetic verifier key/digest, not the copies' independently generated local keys. No real key or credential was read/decrypted for the experiment.

Copies' configuration, Gemfiles and complete lockfiles are under `variants/`. Final source-only deltas are `variants/{prepared70,target}/application.diff`. Those deltas include an experiment-only `PROBE_DEFAULTS` switch; they are not delivered application changes or a patch to apply blindly.

## Setup actually performed

From repository root:

```sh
# Existing excludes were preserved; the rooted scratch rule was appended.
printf '\n/.amp/in/\n' >> .git/info/exclude
mkdir -p "$P"/{baseline,target,pgdata,pgsocket,redis,sources} "$A"
git archive HEAD | tar -x -C "$P/baseline"
git archive HEAD | tar -x -C "$P/target"
/usr/lib/postgresql/15/bin/initdb -D "$P/pgdata" -A trust > "$A/initdb.log" 2>&1
amp orb service start rails-upgrade-postgres --command '/usr/lib/postgresql/15/bin/postgres -D /home/user/workspace/repo/.amp/in/rails-upgrade/pgdata -p 55483 -k /home/user/workspace/repo/.amp/in/rails-upgrade/pgsocket'
amp orb service start rails-upgrade-redis --command 'redis-server --bind 127.0.0.1 --port 6393 --save "" --appendonly no --dir /home/user/workspace/repo/.amp/in/rails-upgrade/redis'
sed -i 's/gem "rails", "7.0.8.7"/gem "rails", "8.1.0"/' "$P/target/Gemfile"
bash "$A/isolate.sh"
psql -h 127.0.0.1 -p 55483 -d postgres -Atc 'select version()'
redis-cli -p 6393 ping
```

`isolate.sh` retains the exact overwritten database/storage/cable configs and generated environment wrapper. PostgreSQL printed version 15.19; Redis printed PONG. The service CLI reported auxiliary managed-service ports as well; actual services were explicitly configured and verified on 55483/6393 above.

## Dependency resolution

In `$P/target`, with the pinned Ruby path first in PATH:

```sh
bundle update rails > "$A/target-bundle-update.log" 2>&1
# Later, after observing JSON.parse's runtime error:
printf '\ngem "json", "< 3"\n' >> Gemfile
bundle update json > "$A/target-json-pin-bundle-update.log" 2>&1
```

Resolution kept Sidekiq 6.5.12, redis 4.8.1, Puma 5.6.9, Rack 2.2.24, pg 1.6.0, concurrent-ruby 1.3.4, Pagy 8.6.3, Faraday 1.10.4, Sprockets 4.4.1 / sprockets-rails 3.5.2, Minitest 5.27.0. New target dependencies included `rack-session 1.0.2`, `rackup 1.0.1`, `action_text-trix 2.1.19`, and JSON 3.1.0 initially / JSON 2.21.2 after the constraint. Full graph in lockfiles; runtime-loaded versions also appear in boundaries logs.

The first bundle invocation used a mise shim and failed before resolution because the copy's mise.toml was untrusted. Subsequent commands selected the absolute installed Ruby path. Bundler postinstall output still printed a mise trust warning, but bundle commands completed and the pinned-runtime app commands ran successfully. This is not attributed to Rails.

The original pre-pin target lock was reconstructed afterward in a **Gemfile-only scratch directory**, using `bundle lock --update json` and the final target lock without the JSON constraint. `variants/target-raw/` records that reconstruction; it differs from final target lock only in JSON 3.1.0 vs 2.21.2 and the direct JSON constraint. The first `--local` attempt could not resolve pg's non-installed foreign platforms; its failure is retained in `raw-lock-reconstruction.log`. The successful network resolution is in `raw-lock-reconstruction-network.log`. Neither invoked application code/services.

## Application command pattern

For every application command, the workdir was the corresponding disposable copy:

```sh
export PATH=/home/user/.local/share/mise/installs/ruby/3.3.6/bin:$PATH
./probe-env.sh bundle exec rails <command> > "$A/<output>.log" 2>&1
```

### Original baseline

```sh
# workdir $P/baseline
./probe-env.sh bundle exec rails db:create db:schema:load > "$A/baseline-db.log" 2>&1
./probe-env.sh bundle exec rails test > "$A/baseline-test.log" 2>&1
```

### Target experiment order

All patch scripts below edit only `$P/target`. Initial tag is 8.1.0 and defaults remain 7.0 until an explicit `PROBE_DEFAULTS=8.1` command.

1. `./probe-env.sh bundle exec rails runner 'puts Rails.version'` → `target-raw-boot.log` (fails at nil allowed_tags).
2. `bash "$A/boot-patches.sh"` (allowlist + split routes), then `rails db:create db:schema:load` → `target-db.log`; `rails test` → `target-boot-fixed-test.log` (enum failures).
3. `bash "$A/model-patches.sh"` (enum + keyword JSON/YAML), then `rails test` → `target-model-syntax-fixed-test.log` (alias and JSON decoding failures).
4. `bash "$A/boundary-patches.sh"` (method aliases + :none exceptions). Diagnostic:
   ```sh
   ./probe-env.sh bundle exec rails runner 'begin; ActiveStorage::Blob.create_and_upload!(io: StringIO.new("hi"), filename: "hi.txt"); rescue => e; puts e.full_message(highlight: false); end' > "$A/target-upload-diagnostic.log" 2>&1
   ```
5. Constrain JSON <3 as above; `rails test` → `target-json-pinned-test.log` (3 failures, 15 errors: remaining API/behavior issues).
6. `bash "$A/compatibility-patches.sh"` (forms, association filter, sum, annotations, custom PK read, schedule Time, DST preview, retry symbol, UTC digest consumption, owned citation config/tests). `rails test` → `target-compatibility-test.log` (1 failure: actual partial import commit).
7. `bash "$A/transaction-patch.sh"`; `rails test` → `target-compatibility-all-test.log` (46/340 all pass).
8. Change copy's load_defaults line to `ENV.fetch('PROBE_DEFAULTS', '7.0').to_f` (experiment-only). `PROBE_DEFAULTS=8.1 ./probe-env.sh bundle exec rails test` → `target-defaults81-test.log` (three errors: readonly/date/cache).
9. `bash "$A/queue-preparation.sh"` (decimal string, both prepared70 and target). `rails test` → `target-queue-prepared-test.log` (46/340 all pass).
10. `./probe-env.sh bundle exec rails zeitwerk:check` → `target-zeitwerk.log`; `./probe-env.sh bundle exec rails assets:precompile` → `target-assets-test-env.log`. Both pass **in test environment**, defaults 7.0, after queue prep. Assets built only in copy-local public/assets.

### Current-version compatible preparation

A third copy was archived from the starting revision into `$P/prepared70`; `isolate-prepared70.sh` selected its dedicated DB and storage paths. It retained Rails 7.0.8.7 and original lock/defaults. Its scripts are the target boot, boundary, compatibility, and transaction scripts redirected to that path, **omitting** :none exception config and the polynomial retry rename. A positional enum edit was added. Tags stayed positional JSON and preferences stayed their original YAML declaration. Thus this was not the incompatible keyword-coder edit.

`prepared70-{boot-patches,boundary-patches,compatibility-patches,transaction-patch}.sh` retain the corrected scripts; final application.diff also records the positional enum edit.

```sh
# workdir $P/prepared70
./probe-env.sh bundle exec rails db:create db:schema:load > "$A/prepared70-db.log" 2>&1
./probe-env.sh bundle exec rails test > "$A/prepared70-test.log" 2>&1
# After queue-preparation.sh:
./probe-env.sh bundle exec rails test > "$A/prepared70-queue-prepared-test.log" 2>&1
```

Both 46/325 all pass. An earlier script-generation error did not apply the intended prep; its green suite (`prepared70-invalid-setup-test.log`) is not evidence for compatibility and was superseded. The final snapshots and corrected scripts correspond to the actual prepared tests.

## Targeted boundaries

The final `boundaries.rb` is retained. It runs after a normal boot, logs Rails/defaults, loaded dependencies and isolated resources, and probes scalar behavior. It writes two-argument JSON payloads (zoned time and decimal) **without GlobalIDs** so serializer compatibility can be checked without mixing databases. It also writes/verifies signatures using an explicit common synthetic key and SHA256 digest, inheriting each version's configured serializer/metadata settings.

```sh
# workdir $P/baseline
PROBE_VARIANT=baseline ./probe-env.sh bundle exec rails runner "$A/boundaries.rb" > "$A/baseline-boundaries.log" 2>&1
# workdir $P/target, after all compatibility patches, before decimal-string application prep
PROBE_VARIANT=target70 ./probe-env.sh bundle exec rails runner "$A/boundaries.rb" > "$A/target70-boundaries.log" 2>&1
PROBE_VARIANT=target81 PROBE_DEFAULTS=8.1 ./probe-env.sh bundle exec rails runner "$A/boundaries.rb" > "$A/target81-boundaries.log" 2>&1
# workdir $P/baseline again, after new payloads/signatures exist
PROBE_VARIANT=baseline ./probe-env.sh bundle exec rails runner "$A/boundaries.rb" > "$A/baseline-reread-boundaries.log" 2>&1
```

The target70 boundaries log was written before the target81 signature existed; baseline-reread and target81 logs contain the decisive backward/forward signature checks. Initial copies used independently generated local keys and their first-run signature comparison was invalid: `*first-uncontrolled-signing-key.log` are retained but not used as serialization evidence. Scalar/date/coder results therein are consistent, but the corrected common-key logs are the final evidence.

## Actual Redis JSON path

`real-queue.rb` is retained. In each isolated copy it creates a synthetic Eastern-zone reader with two ready notes and one draft. It explicitly sets timestamps **after** create-time Action Text touches, to put the ready notes on opposite sides of UTC midnight. It releases only that synthetic reader's dated reservation before making a request at 03:30 UTC. It calls the application domain API twice, requires the actual job to exist in the private Redis list, saves its raw Sidekiq JSON, removes only that job, and calls Active Job's worker entrypoint on that JSON. Assertions check subject, included/excluded titles, and rounded percentage. It never calls perform_enqueued_jobs or loads Sidekiq testing mode.

```sh
# workdir $P/baseline
PROBE_VARIANT=baseline ./probe-env.sh bundle exec rails runner "$A/real-queue.rb" > "$A/baseline-real-queue.log" 2>&1
# workdir $P/target, consumer fix but still BigDecimal producer
PROBE_VARIANT=target70 ./probe-env.sh bundle exec rails runner "$A/real-queue.rb" > "$A/target70-real-queue.log" 2>&1
# after queue-preparation.sh, respective prepared70 / target workdirs
PROBE_VARIANT=prepared70-prepared ./probe-env.sh bundle exec rails runner "$A/real-queue.rb" > "$A/prepared70-queue-prepared-real-queue.log" 2>&1
PROBE_VARIANT=target-prepared ./probe-env.sh bundle exec rails runner "$A/real-queue.rb" > "$A/target-queue-prepared-real-queue.log" 2>&1
```

Final logs all show `reserved=true duplicate=false`, correct UTC Oct 5 digest, only the UTC-day candidate, and 67%. Before queue prep, payloads differ (old string vs new BigDecimal serializer). After prep, both decimal arguments are strings. Full worker daemon, scheduler polling, retries over elapsed time, and cross-process locking were not exercised by this probe.

The initial probe failed its selection assertion because create-time callbacks touched the supplied updated_at; corrected to post-create update_columns. A second baseline attempt encountered a reservation left from earlier synthetic ID reuse; corrected to release only its own synthetic reservation first. Initial failed logs are labelled and retained. These were setup issues, not evidence of an upgrade regression. The corrected target70 run preceded adding the reservation release (its ID was fresh); the final script includes the release for reproducibility.

## Source provenance

Downloaded `https://codeload.github.com/rails/rails/tar.gz/refs/tags/v8.1.0`; SHA256 `e3f97438a5cc66a297effcf70bb05e7989f595ab975e9bc83535466d0abc3414`. Selected exact sources/guides retained under `upstream/v8.1.0/`; original installed 7.0.8.7 sources under `upstream/v7.0.8.7/`. Small intervening source files fetched with `curl -fsSL https://raw.githubusercontent.com/rails/rails/v<VERSION>/<PATH>` are retained directly under `upstream/`, with version in filenames. Full source URLs and versioned guides are cited in PLAN.md. No code from a floating Rails branch was used as evidence for exact 8.1.0 behavior.

## Cleanup and final state

The owned services were stopped after their logs were captured. The entire scratch prefix (copies, generated assets, temporary database cluster, storage, caches, downloaded tar/extraction) was removed; retained review/evidence files are under `$A`. No existing default-port service was stopped and no existing application database was dropped/reset. Toolchain gems installed to test the resolved target remain in the Ruby gem installation, but the working Gemfile/lock were not changed.

The root repository's final `git diff --quiet` and `git diff --cached --quiet` succeed. The pre-existing untracked `.amp/` plugin directory remains. This plan and evidence are local ignored artifacts, not committed, pushed, merged, or deployed.
