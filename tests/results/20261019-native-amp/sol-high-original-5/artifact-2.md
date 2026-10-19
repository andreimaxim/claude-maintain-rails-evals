# Evidence attribution

Assessment date: 2026-10-19. See `manifest.txt` for exact source commit, toolchain/service versions and upstream archive SHA256s. The plan is `../rails-upgrade-plan.md`.

## Isolation

Disposable application roots were:

- `/home/user/workspace/repo/.amp/in/rails-upgrade/baseline`
- `/home/user/workspace/repo/.amp/in/rails-upgrade/target`

They were made with `git archive HEAD`, so no ignored secret keys, existing storage, application logs or cache were copied. Tracked code matches the unchanged worktree at inspection time. Storage paths from `config/storage.yml`, cache and mail paths remain checkout-local and therefore were isolated. Tests use file/test delivery, never external mail.

A separate PostgreSQL 15 cluster was initialized under `.amp/in/rails-upgrade/pgdata`, bound to 127.0.0.1:55481, with a private socket directory. Separate UTF-8 databases were created on it: `rails_upgrade_baseline` and `rails_upgrade_target`. Its template initially used SQL_ASCII because initdb used `--no-locale`; the first Rails database creation failed, so the databases were explicitly created from template0 with UTF8. That failure log is retained; it is not an application upgrade defect.

A separate Redis 7.0.15 process was bound to 127.0.0.1:6389, persistence disabled, its own directory. It did not share the application's Redis process. Baseline suite used DB 0, target suites DB 1, runner probes DB 2. The latter set the Redis URL but mostly exercised serialization directly, not worker execution. No application resources at ports 5432 / 6379 were used.

Both private services were managed with `amp orb service`, not detached shell processes. The experimental services and disposable files were stopped/removed after evidence capture. No user-facing web server was started. Installed target gems remain in the sandbox's Ruby gem installation; the working app's Gemfile/lock were not changed.

## Variants

1. **Baseline:** Rails 7.0.8.7; unchanged tracked Gemfile/lock/config/code. Ruby 3.3.6, Bundler 2.5.22, JSON default gem 2.7.2. `config-snapshots` holds original dependency/config files. `baseline-probes.log` also enumerates loaded gem versions.
2. **Target initial:** only Rails pin changed to 8.1.0, `bundle update rails --conservative`. Full resolved dependencies are `target-initial.Gemfile.lock`; initial Gemfile is adjacent. JSON resolved 3.1.0. `target-unmodified-boot.log` captures the actual initial boot error.
3. **Target partial probe with JSON 3:** initializer/routes and removed Note enum/serialize/alias APIs adapted by `target-probe-patches.sh` to get beyond blockers. No other application/test code changed. Defaults remain 7.0. `target-partial-suite.log`: 46 tests, 44 assertions, 28 failures, 17 errors.
4. **Target partial probe with JSON 2:** additionally constrain `gem "json", "< 3"` and run `bundle update json --conservative`. JSON resolves 2.21.2. Full retained dependency files: `target-probe.Gemfile` / `target-probe.Gemfile.lock`. Cumulative precise changes from baseline: `target-probe.diff`. Unchanged tests: `target-json2-partial-suite.log`: 46 tests, 161 assertions, 19 failures, 6 errors. This deliberately incomplete probe is not a proposed final implementation.
5. **Focused default checks:** run inside variant 4 without changing load_defaults: runtime-enable PostgreSQL decoding before a fresh pool, define a model under the strict readonly setting, and test a nil default column serializer. These are individual setting checks, **not** a whole-app `load_defaults 8.1` run. See `focused-probes.rb` and logs.

`target-argument-diagnostic.log` is the full causal stack for JSON 3.1.0. The installed JSON 3.1.0 source defined `parse(source, ..., **options)`, while Rails 8.1.0 called `JSON.parse(json, options)`. Its `CHANGES.md` says that JSON 3.0 removes positional method options and uses checked keyword options. The JSON 2 variant removes this mismatch without monkeypatching Rails.

## Commands actually executed

`setup.sh` records disposable checkout creation, private-service commands and initial pin change; `setup.log`, `initdb.log`, `postgres.log`, and `redis.log` retain output. The copied mise.toml files needed explicit trust:

```sh
# Run from the original repo, before any Ruby commands in disposable roots:
mise trust .amp/in/rails-upgrade/baseline/mise.toml
mise trust .amp/in/rails-upgrade/target/mise.toml
```

Initial trust failures are retained as `baseline-initial-environment-failure.log` and `target-initial-environment-failure.log`; these are environment setup failures, not app defects.

The following shell environment was set for every Rails/test command, with VARIANT baseline or target and DBINDEX 0 or 1 for its suite:

```sh
export RAILS_ENV=test
export DATABASE_URL=postgresql://user@127.0.0.1:55481/rails_upgrade_VARIANT
export REDIS_URL=redis://127.0.0.1:6389/DBINDEX
export PARALLEL_WORKERS=1
export SECRET_KEY_BASE=rails-upgrade-isolated-synthetic-key-not-a-real-secret
```

This signing key is synthetic, only for the disposable experiments; no real signing secret was read or logged.

Baseline (cwd baseline):

```sh
ruby -v
bundle check
# Failed initial attempt, retained in baseline-db-encoding-failure.log:
bin/rails db:create db:schema:load
# Focused environment fix:
createdb -h 127.0.0.1 -p 55481 -U user -T template0 -E UTF8 rails_upgrade_baseline
# Successful setup and complete ordinary suite:
bin/rails db:schema:load
bin/rails test
```

Output: `baseline-suite.log`; app log: `baseline-rails-test.log`. The fixture database was subsequently modified only by the explicitly separate runner probes.

Target (cwd target):

```sh
bundle update rails --conservative
bin/rails runner 'puts Rails.version' # fails before app boots
bash /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/target-probe-patches.sh
createdb -h 127.0.0.1 -p 55481 -U user -T template0 -E UTF8 rails_upgrade_target
bin/rails db:schema:load
bin/rails test # JSON 3 probe, fails
# Capture initial dependency files before adding the constraint:
cp Gemfile /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/target-initial.Gemfile
cp Gemfile.lock /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/target-initial.Gemfile.lock
printf '\n# Probe: Rails 8.1.0 still calls JSON.parse with a positional options hash.\ngem "json", "< 3"\n' >> Gemfile
bundle update json --conservative
bin/rails test # JSON 2 probe, still fails for the unaddressed behaviors
```

Dependency resolution logs: `target-bundle-update.log`, `target-json2-bundle-update.log`. Probe patch execution: `target-probe-patches.log`. Cumulative app log across runs/probes: `target-rails-test.log`; use per-command stdout logs to distinguish results. The `target-argument-diagnostic.log` command was:

```sh
bin/rails runner 'begin; p User.first; p Notebook.first.notes.create!(title: "Probe"); rescue => e; puts e.full_message; end'
```

Runner probes, in this order (each wrapper sets its isolated environment):

```sh
# cwd baseline
bash /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/run-probes.sh baseline
# cwd target
bash /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/run-probes.sh target
# cwd baseline: consume the saved target payload
export PAYLOAD_IN=/home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/target-payload.json
bin/rails runner 'require "active_job/arguments"; begin; ActiveJob::Base.execute(JSON.parse(File.read(ENV.fetch("PAYLOAD_IN")))); rescue => e; puts e.full_message; end'
# cwd baseline
bash /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/run-focused.sh baseline
# cwd target
bash /home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/run-focused.sh target
```

Output filenames: `baseline-probes.log`, `target-probes.log`, `baseline-reads-target-job.log`, `baseline-focused.log`, `target-focused.log`. Serialized full payloads are `baseline-payload.json` / `target-payload.json`; the user IDs refer only to synthetic test fixtures.

**Interpretation caveat:** the first target runner attempted enabling date decoding on an existing adapter with disconnect, which still returned Strings, and attempted the readonly setter on the wrong owner. Those preliminary results are preserved in `target-probes.log` rather than silently rewritten. The corrected checks in `focused-probes.rb` create a fresh connection pool and use `ActiveRecord.raise_on_assign_to_attr_readonly`, respectively. They establish the Date/TypeError and ReadonlyAttributeError results in `target-focused.log`. Do not cite the first attempt as evidence the new defaults are compatible.

Probe helpers catch and print errors to expose multiple independent observations; exit status 0 from a runner does **not** mean all observations passed. Likewise the cross-version old-worker failure is intentionally printed, not a passing compatibility test.

## Source acquisition

Exact release source archives were fetched, then inspected locally:

```sh
for version in 7.0.8.7 7.1.0 7.2.0 8.0.0 8.1.0; do
  curl -fLsS "https://codeload.github.com/rails/rails/tar.gz/refs/tags/v${version}" -o "rails-${version}.tar.gz"
  tar -xzf "rails-${version}.tar.gz"
done
```

Hashes retained in manifest; upstream links in the report pin versioned source. The versioned 8.1.0 upgrading guide and 7.1/7.2/8.0/8.1 release notes were read as well. Intermediate release code inspection does not imply intermediate app execution.

## Not run

No full upgrade implementation, no repaired target pass, no intermediate release suite, no production boot, no actual Sidekiq worker, no browser/system scenarios, no token signing interoperability test, no asset precompile, and no full defaults adoption were performed. Production/shared data and queue inventories were not queried. The plan's corresponding checks remain proposed.
