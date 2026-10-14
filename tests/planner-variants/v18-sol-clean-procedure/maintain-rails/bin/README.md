# Upgrade tools

The scripts use Ruby's standard library and the RubyGems library shipped with Ruby.
They invoke `git`, Bundler, Rails, PostgreSQL executables and `redis-server` where
needed. Run with the application's Ruby on PATH. PostgreSQL cannot run as root.
No model API, extra Ruby gem, Docker or shell service setup is required by the tools.

## Collect changes

```
ruby /plugin/bin/gem-changes GEM FROM TO /application --output /work/changes
ruby /plugin/bin/gem-changes GEM FROM TO /application --output /work/resolved \
  --locks /lab/variants/current/Gemfile.lock,/lab/variants/target/Gemfile.lock
ruby /plugin/bin/gem-history GEM FROM TO /work/history
```

Redirect stdout to a summary file outside the application. Quote paths containing
spaces. FROM and TO are exact gem versions. `--locks` is one comma-separated pair.
Use a new output directory for each evidence variant. Network caches live under
`$XDG_CACHE_HOME/gem-changes` or `~/.cache/gem-changes`.

`gem-changes` retains the packaged changelog/default collection and code matching.
It writes `entry-index.tsv` for scanning and complete parsed entries/references in
`entries.md` and `entries.json`. The shortened stdout is not the only evidence.
`coverage.json` reports
missing sources. `defaults.json` lists template assignments with source paths,
explicit application assignments and the loaded defaults version. The review
table includes both changelog and default rows. Entries with no lexical match
still need application review.

`gem-history` also runs inside `gem-changes`. It resolves exact GitHub release
tags from RubyGems metadata, fetches the ancestry interval and records commit IDs,
subjects, changed paths, tagged upgrade guides and their diff. Up to 80 commits
gets a patch file per commit. Larger intervals get component groups and subject
keyword candidates, with the entire history retained. The cutoff chooses output
format, not which commits exist. Use `git --git-dir=PATH show SHA -- path` to read
additional patches. Unsupported repositories/tags and network failures produce
explicit gaps, not an invented comparison. Deleted guides are saved under
`guides-removed/` at the old tag. History exit 2 means a coverage gap.

With `--locks`, changes to versions, platforms and Git/path source identities are
listed in `dependencies.json`. Each moved non-component RubyGems upgrade gets its
own changelog/history report automatically. Added/removed gems have no common
version interval; public gem metadata is saved for them. Review their integration explicitly. Downgrades,
Git/path sources and differing platform versions require manual source review.
Look at child `coverage.json` files even when the parent command succeeds.

## Run disposable variants

```
ruby /plugin/bin/upgrade-lab create /application /work/lab
# Read /work/lab/inventory.md and connection code. Edit only snapshot/ and isolation.json.
ruby /plugin/bin/upgrade-lab add /work/lab current
ruby /plugin/bin/upgrade-lab run /work/lab current check
ruby /plugin/bin/upgrade-lab add /work/lab target GEM VERSION
ruby /plugin/bin/upgrade-lab run /work/lab target check
ruby /plugin/bin/upgrade-lab run /work/lab target exec -- bundle exec rails runner /work/probe.rb
```

The destination of `create` must not exist and its parent directory must exist.
The destination must be outside the source tree, including through symlinks.
The source must have a lockfile. Files are copied without Git metadata, local
Bundler settings, dotenv files, keys, symlinks, vendor packages, logs, temporary
files or stored data. The inventory lists connection references for review.
Missing local path gems or keys are setup blockers, not upgrade findings.

`isolation.json` starts with `reviewed: false`. Read the application code before
setting it to true. Configure `databases` with every database role (including
`primary`), `storage_services` with every disk service name, and `env` with the
application's required variables. Values can contain `{redis_url}`,
`{database_url}`, `{storage_root}` or `{variant_root}`. `test_command` is an argv
array, for example `["bundle", "exec", "rspec"]`. It defaults to RSpec when `spec/`
exists and to `rails test` otherwise. `timeout_seconds` applies to each stage.
Set `pg_bin` to the directory holding `initdb`, `pg_ctl`, `psql` and `createdb` if
they are not on PATH. Debian's installed server bin directory is detected.

The runner supports PostgreSQL applications. Confirm `database_adapter` against
the original configuration; an unknown or different adapter blocks execution.
Do not change database vendors to make a check run. Use an independently isolated
copy with the original vendor instead, or report runtime checks as blocked.
`database_options` can preserve per-role migration paths, schema paths, replica
flags, pool, encoding, collation, session variables and search paths. Its keys are
role names and its values are option objects. Connection addresses cannot be
overridden there. The lab does not reproduce an application's replication topology.

Each variant has its own PostgreSQL cluster (private Unix socket, no TCP), Redis
server (private Unix socket, no TCP, database 0 and private persistence directory), and
disk root. A clean child environment removes inherited service URLs and secrets.
The script supplies generated database/storage configuration for test, development
and production, with `RAILS_ENV=test`. `env` can map other cache/queue URLs to the
private Redis server. Extra database roles use separate private databases.
Services start for one invocation and stop in `ensure`; data persists per variant.
The session lock prevents concurrent runs. Remove the disposable session after
retaining the evidence you need. A forcibly killed process can require manual
cleanup of that session's services; never kill or drop the source app's services.

A copied application is not a security or network sandbox. Configuration can
contain literal addresses, custom credentials readers, shell commands or remote
storage clients. Redirect or disable those in the snapshot before executing any
variant, including Bundler install hooks. If you cannot establish isolation, keep
the check proposed. Test-only results do not prove production configuration.
The generated database/storage files are experimental changes, not recommended
application repairs. Record them with the findings.

`add` pins a simple single-line Gemfile declaration while preserving keyword
options. It adds a direct pin for a transitive gem. Nonstandard, multiline or
duplicate declarations stop with a diagnostic. In that case edit only the copied
Gemfile; the variant marker remains so `run ... resolve` can continue. Do not
change unrelated constraints without recording why. No Ruby runtime is installed
or selected automatically.

`check` records separate `resolve`, `prepare`, `boot`, `eager`, `routes`, and
`tests` results. Only a failed resolve stops later stages. `prepare` runs
`rails db:prepare`, so first review seeds and migrations too. The commands also
run separately, for example `run LAB target eager`. `exec --` takes an argv array,
not a shell string; use it for assertion probes and focused tests. A process
timeout is exit 124. A zero-test suite is recorded as missing coverage even if the
test process exits zero, and causes the wrapper to return failure.

Every run writes `runs/TIMESTAMP-VARIANT-ID/` with command argv, exit codes,
durations, Ruby version, environment, configuration, code hashes, Gemfile and
resolved lockfile. `changes-before.json` and `changes-after.json` retain changed
file bytes relative to the session snapshot as Base64. Ruby probe files passed
as argv are saved in `inputs-STAGE.json` too. Full output remains in
per-stage logs, with a few error/test-summary lines printed immediately. Treat environment files
and logs as private. The tool compares source file hashes before and after runs;
it never installs, resolves, boots, migrates or repairs in the original checkout.
Edits to the original source after `create` require a new session. It does not
hash excluded data such as source logs, secrets or storage.

Keep a failed upgraded variant unchanged. Add a new variant for repairs, apply
only the proposed repair there, and run the same probe on current, unrepaired and
repaired copies. Variants have separate service data. For format/rollout checks,
export only synthetic old-writer payloads to WORK and import them through the
other variant's reader. Never copy production databases, caches or queue payloads.
