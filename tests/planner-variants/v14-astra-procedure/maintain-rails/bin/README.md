# Planner commands

The scripts collect evidence and run experiments in disposable copies. They do
not decide application impact or certify upgrade safety. Read this file when a
command fails, when services need special handling, or before writing probes.

All implementation code uses Ruby's bundled libraries, including RubyGems. No
helper gem is installed. The commands invoke existing Git, the application's
Bundler, and, for experiments, local PostgreSQL client tools and `redis-server`.
The scripts were tested with Ruby 3.3.6, Bundler 2.5.22, PostgreSQL 15 and Redis 7.
Use a Ruby executable compatible with both application versions. A missing
runtime is a planning prerequisite, not a reason to change the requested target.

In the examples, set `BIN` to this directory and `LAB` to the returned lab path.
Shell assignments do not persist between tool calls, so use absolute quoted
paths in agent calls. Run `ruby "$BIN/<command>" --help` for syntax.

## Collect source evidence

```sh
ruby "$BIN/gem-changes" "$GEM" "$FROM" "$TO" "$LAB/snapshot" --out "$LAB/sources"
```

The application is read as text. Its Gemfile, gemspecs and initializers are not
evaluated. Output and cache paths must be outside the supplied application path.
The source cache defaults to `~/.cache/gem-changes-v2`; `GEM_CHANGES_CACHE` changes
it. It contains public downloads, extracted documentation and bare Git repositories.

Read `index.md` first. `manifest.json` lists all review pages and collection gaps.
Each page points to complete entries or tagged source, with code matches as
search hints. `entries.json` contains all parsed entries, including unmatched
fixes and features. `defaults.json` includes template assignments and their
original source paths. A missing text match does not establish irrelevance.

The release list uses the latest stable patch in each intervening minor series,
plus the exact target. It preserves the previous collector's sampling rule.
Cumulative changelogs normally include earlier patches. If a project replaces
rather than accumulates its notes, inspect the complete commit range and the
releases omitted by that sampling rule. The command does not claim to have
downloaded every patch release. Prerelease targets are accepted, but other
prereleases are not separately sampled.

Lockstep components are discovered recursively from exact runtime dependencies,
across both endpoints and sampled releases. Component changelogs are read even
when several components share a repository. A shared repository and tag range is
indexed once. If packaged notes cannot be parsed, metadata changelogs and GitHub
release notes are tried. Missing sources remain explicit gaps.

Commit records contain full messages, changed paths and commit URLs. Ranges of
at most 80 commits save every patch. Larger ranges keep every commit in the
index, list priority subjects by component, and save the endpoint diff. Priority
is a search heuristic, not a statement that omitted commits are harmless.
Ancestry warnings require reading the endpoint diff as well as the target-only
commit list, because maintenance releases often live on different branches.

```sh
ruby "$BIN/gem-changes" show "$COMMITS_JSON" "$SHA_OR_UNIQUE_PREFIX"
```

The prefix must contain at least eight hexadecimal characters and identify one
commit in that recorded range. The command returns a patch path. It will not
substitute HEAD. `--repository`, `--from-ref` and `--to-ref` allow explicit source
and exact tag overrides for the requested gem. Record why an override is valid.

Upgrade guides and release notes are read at sampled release tags. Both Markdown
heading forms are recognized. Identical sections are shown once, while changed
or deleted intermediate explanations remain available. Raw documents are kept
beside the review pages. Filename and heading recognition is heuristic; an
unusual guide location, HTML-only notes, or an unavailable tag needs manual
upstream research and a coverage note. Git/path dependencies and private
registries need their own source and revision evidence rather than a guessed
RubyGems release range.

After resolution, collect the dependencies that actually moved:

```sh
ruby "$BIN/gem-changes" "$GEM" "$FROM" "$TO" "$LAB/snapshot" \
  --out "$LAB/dependencies-target" --dependencies-only \
  --before "$LAB/snapshot/Gemfile.lock" --after "$TARGET/Gemfile.lock" \
  --runtime-before "$LAB/runtime-baseline.json"
```

Omit a runtime flag when the corresponding boot did not produce a snapshot.
Add `--runtime-after PATH` after a successful upgraded boot. The comparison lists
version, source, platform and requirement changes, including additions and
removals, and names the parent gems. A loaded default-library version can supply
the old endpoint when it was not in the old lockfile. An installed but unloaded
library does not qualify. Already covered lockstep ranges are marked rather
than researched twice. Downgrades and ambiguous or nonregistry sources become
explicit manual-review gaps.

The primary command exits 0 when collection completes, even with source gaps.
Read the gaps. Invalid inputs and fatal setup errors exit 2. HTTP failures have
timeouts; large repositories still require network transfer and disk space.
Avoid concurrent cold collections of the same gem into the shared cache.

## Prepare and run an experiment lab

```sh
ruby "$BIN/gem-upgrade-lab" init "$APP" "$GEM" "$FROM" "$TO"
```

The returned directory is outside the source checkout. It contains a snapshot
of the current tracked files, including local edits, and nonignored untracked
files. Git data, ignored local credentials, bundle configuration, storage,
temporary files and logs are not copied. External symlinks and submodules are
rejected. Every variant has its own application copy and resource directory.
The original source hashes are checked before and after executed commands.

Read `inventory.md`, the test instructions, and the listed service references
before enabling execution:

```sh
ruby "$BIN/gem-upgrade-lab" review "$LAB" "Describe the services checked and the isolation used."
```

Automatic isolation supports conventional PostgreSQL or SQLite database YAML.
Each environment and named database gets a separate generated name or file.
The PostgreSQL connection must be local and permit creation of databases. The
script creates databases only when execution needs them. It does not create a
cluster, run the source application's setup scripts, or reuse application data.
The application stages run with `RAILS_ENV=test` and one test worker.

For Redis, each command starts a private foreground server on a free loopback
port, verifies its process ID, and sets `REDIS_URL` to that server's database 0.
Different variants have different servers and persistence directories, so their
database 0 instances are independent. The server stops after the command,
including on errors. Its data persists in the variant for the next command.
Disk storage, cache files under the application, and temporary files stay in the
copy. Configured storage services are replaced with private Disk services.

Isolation is not an operating-system or network sandbox. The environment is
allowlisted, but Ruby code can still use credentials on disk, SDK defaults,
hard-coded service URLs, custom database connections or absolute file paths.
The inventory is a list of references to review, not a service detector that
proves safety. Inspect external HTTP clients and their test substitutes. Do not
exercise live mail, payment, object-store, queue or other external services.
Do not paste credentials into commands, because commands are recorded.

If the generated isolation is insufficient, do not run `sweep`. Create a fork
without execution, adapt only that copy's configuration, and review the changed
service boundaries before using `exec`. Use the same isolation on every variant
you execute. Unsupported adapters and dynamic database layouts fail closed.
Source collection can still run read-only on APP with an output directory outside
APP when lab preparation is blocked. Write the source-only plan and its limits
there, and do not claim runtime checks. Do not run cleanup on a lab that was never
created successfully.

```sh
ruby "$BIN/gem-upgrade-lab" check "$LAB" baseline
ruby "$BIN/gem-upgrade-lab" bump "$LAB" target "$TO"
ruby "$BIN/gem-upgrade-lab" check "$LAB" target
```

`bump` starts from the snapshot. It pins a literal gem declaration, then runs
`bundle update GEM --conservative`. A transitive gem gets a temporary direct
constraint. Dynamic Gemfiles or path/git declarations require an explicit edit
in a fork instead of an automatic rewrite. Keep the exact target. A failed
resolution remains a failed experiment, not permission to remove other pins.
For an existing variant after a resolution failure, use `exec ... -- bundle
update GEM --conservative` after a justified edit; do not call `bump` with the
same label again.

`check` runs bundle verification, boot, database preparation, eager loading,
routes and the detected test suite in order. It stops at the first failed stage.
It uses `bundle install --local` with frozen resolution, so a missing local gem
is reported rather than silently changing the lockfile. An explicit copied
`bundle install` can fetch missing dependencies. Tests use either Rails tests
or RSpec; if both or neither are detected, run the project's documented command
through `exec`. Rails system tests and other separate suites are not included
automatically. Use `check LAB LABEL STAGE` to rerun one stage.

```sh
ruby "$BIN/gem-upgrade-lab" sweep "$LAB" "$LAB/sources/manifest.json"
```

`sweep` is an alternative to the individual bump commands. It runs the baseline
and one independent copy per sampled release. A failed application stage stops
that variant, not the remaining versions. Variants are named `v` plus the version
with dots replaced by underscores. Use `status` to obtain paths and run records.
Do not rerun a sweep over existing labels. Check or fork its variants instead.
The independent copies retain original defaults; they are not a simulation of
sequential production deployments.

```sh
ruby "$BIN/gem-upgrade-lab" fork "$LAB" target target_repaired
ruby "$BIN/gem-upgrade-lab" exec "$LAB" target -- bin/rails runner "$LAB/probe.rb"
ruby "$BIN/gem-upgrade-lab" exec "$LAB" target_repaired -- bin/rails runner "$LAB/probe.rb"
```

A fork copies code, not database contents, Redis data or stored files. Prepare
its database before running data-dependent probes. Export a synthetic payload
to LAB when two versions must read identical bytes; never share an original
service to achieve that. Keep signing keys, codec settings and input data equal
when testing producer/consumer compatibility. Use throwaway test keys. For
default adoption, edit the copied configuration before boot, rather than
changing a setting after an object has cached it. Passing an enqueue assertion
does not prove that a worker can read and execute the serialized job.

Use the same assertion and inputs on the old, new and repaired variants. Include
a contrasting path whose behavior should remain unchanged. A probe that changes
several conditions at once does not attribute the difference to one cause. For
independent assertions, collect their results and exit nonzero if any failed.
Do not append a successful `tail` command that hides the probe's exit status.
The lab runs one command at a time and defaults to a 300-second timeout.
`GEM_UPGRADE_TIMEOUT` changes that limit for a deliberately slow command.

Every executed command stores its status, duration, log, source file hashes,
code/configuration diff, and both before and after lockfiles under `runs/`.
Resolution records identify the resulting lockfile, not just the old one.
Successful boot also writes `runtime-LABEL.json`. The `runtime_snapshot.rb`
helper maps both activated gems and actually loaded default libraries. It does
not treat every installed library as used. These are evidence artifacts, not a
complete filesystem or database replay. Do not commit inside the copies or edit
their Git indexes; those indexes define each variant's starting code for diffs.

`check`, `exec` and `sweep` exit 1 for failed or timed-out experiments, and 2 for
invalid usage or setup errors. Read the retained stage and log before proceeding.
The full output stays on disk; the command prints a short status and excerpt.

```sh
ruby "$BIN/gem-upgrade-lab" status "$LAB"
ruby "$BIN/gem-upgrade-lab" clean "$LAB"
```

Cleanup drops only the PostgreSQL databases recorded as created by that lab and
verifies their generated name prefix. It keeps copies, logs, SQLite files and
Redis data as evidence. The lab is then closed to execution. No Redis server
should remain between commands. Inspect recorded resource logs after an
interrupted process; do not kill or flush an unrelated server.

## Write and check the plan

```sh
ruby "$BIN/gem-upgrade-report" init "$LAB/plan.json" "$LAB/sources/manifest.json" "$LAB/dependencies-target/manifest.json"
ruby "$BIN/gem-upgrade-report" check "$LAB/plan.json"
ruby "$BIN/gem-upgrade-report" render "$LAB/plan.json"
```

Run `init` once after collecting the source manifests. It writes the plan shape
and `finding-template.json` beside it. Copy that finding object into `findings`
with a distinct ID for each application consequence. Keep candidates and source
dispositions in notes until all required manifests exist. If further research
adds a manifest, seed a different plan path with all manifests and carry over
the existing findings and reviewed dispositions, rather than overwriting evidence.

Each source page needs `reviewed`, `not_applicable` or `unknown`, an explanation
with code/search evidence, and the associated finding IDs. Review pages merge by
content-sensitive IDs; a revised page with the same title still needs review.
Every template assignment needs a default decision, including those that are
irrelevant or not yet verified. State retained behavior after the bump in
`current_value`, and the adoption effect in `impact`.

The checker rejects missing consequences, repair/control assertions, omitted
default decisions, open coverage rows and unsupported executed claims without
referenced run artifacts. It accepts honest unknowns and renders them as limits.
The checker validates structure and file existence, not semantic correctness.
It cannot prove that a cited log supports an assertion or that a repair is right.
For each executed claim, state which part was exercised and which repair or
rollout check remains proposed. Do not mark all findings executed because a test
suite passed. Source-based findings are valid when the applicability and repair
are supported by inspected versioned source and unexecuted checks are named.

`render` checks the report before printing Markdown. It does not edit the plan.
It includes findings, defaults, experiment results and unresolved checks. Full
coverage notes stay in the JSON to avoid repeating a long source inventory in
the final answer. A source gap cannot be erased by deleting it from the report's
limitations, because rendering also reads the original manifests.

## Test the helpers

`ruby test/contract_test.rb` runs offline, creates unrelated tiny gems and Git
repositories, and checks release bounds, commit patches, guide retention,
dependency comparisons, isolation guards and report omissions. It needs no test
framework or running services.

On a PostgreSQL application, prepare and review a fresh lab, run a bump or sweep,
and collect sources. Then run `ruby test/application_smoke.rb LAB MANIFEST.json
[MANIFEST.json...]`. Its baseline and fork must pass the existing suite. It
checks private connections, Redis persistence/separation, environment isolation,
failed/timeout results and report artifact validation. It intentionally creates
a source-unknown report rather than pretending to find application upgrade
issues. Clean the lab after inspecting the results. Never run either test in
place of a model evaluation of plan quality.
