# Rationale for the replacement planner

The replacement moves source collection, experiment setup, execution records and
report checks into Ruby scripts. The agent follows ten numbered steps and still
has to determine application impact and choose a repair. The plugin remains
`maintain-rails`, its agent remains `gem-upgrade-planner`, and neither the skill
nor the agent pins a model or effort level.

The scripts were exercised against the supplied application in disposable
copies. No model evaluation or hidden-grader run was performed. Lower cost and
equal or better plan quality are intended effects, not measured results.

## Evidence and its limits

Evidence references below identify files in the supplied input bundle. The
bundle's verified SHA-256 is
`100ca49b3be6504261f743a6d6a9f034379176c4d2cb4b7956665d0932cd32d2`.
The application-specific findings were not turned into prompt instructions,
source filters or expected answers.

- **E1:** [The bundle overview](file:///home/user/bundle/README.md) reports five-run
  Rails means. The checklist variant v3 scored 11.2, v4 with experiments scored
  18.4, v6 with application consequences scored 19.2, and v8 with exact
  observations scored 20.0. Coherent repairs in v9 scored 20.8, and discriminating
  validation in v10 scored 21.4. Batching in v11 scored 18.8. External release
  notes in v12 scored 21.0.
- **E2:** [The v3 low-score metadata](file:///home/user/bundle/runs/rails-v3-low/meta.json)
  records 7/23, $0.77, 3.3 minutes, eight tool calls and no experiments.
  [Its trace](file:///home/user/bundle/runs/rails-v3-low/trace.md) mostly reads
  summaries and source before returning a plan.
- **E3:** [The v10 high-score trace](file:///home/user/bundle/runs/rails-v10-high/trace.md)
  repeats copy, service, version-manager and dependency setup in steps 5 to 10.
  Steps 11 to 38 repeatedly expose and repair blockers. Steps 39 to 43 test
  producer/consumer compatibility in both directions. Steps 51 to 55 correct
  experiments whose settings were applied too late or whose inputs did not
  distinguish behavior. Steps 61 to 65 test preparation on the current version,
  and step 66 saves evidence and cleans up.
- **E4:** [The Pagy trace](file:///home/user/bundle/runs/pagy-v12-high/trace.md) and
  [the Faraday trace](file:///home/user/bundle/runs/faraday-v12-high/trace.md) also
  repeat copying, version-manager setup and dependency resolution. Setup work is
  not peculiar to a large framework upgrade.
- **E5:** The v12 [high-score metadata](file:///home/user/bundle/runs/rails-v12-high/meta.json)
  records 22/23, $2.55, 13.4 minutes, 61 tool calls and 42 experiment commands.
  The [low-score metadata](file:///home/user/bundle/runs/rails-v12-low/meta.json)
  records 20/23, $4.45, 17.9 minutes, 82 calls and 46 experiment commands.
  The labels describe score extremes, not different reasoning effort settings.
- **E6:** [The current collector](file:///home/user/bundle/current-plugin/bin/gem-changes)
  already downloads packaged and external notes, discovers lockstep components,
  extracts defaults and matches identifiers. Its `series_versions` function
  selects the latest stable patch of each intermediate minor series, plus the
  exact target. It does not actually download every patch release.
- **E7:** [The current prompt](file:///home/user/bundle/current-plugin/agents/gem-upgrade-planner.md)
  contains the useful application consequence, repair, validation and isolation
  requirements. [The prompt history](file:///home/user/bundle/prompts/v10/gem-upgrade-planner.md)
  shows the same requirements expressed as principles rather than commands and
  records to complete.

The historical runs are observations, not controlled proof that a single wording
change caused a score change. The low and high traces are selected extremes, so
their cost difference is not an estimate of potential savings. They do identify
repeated mechanical work and checks that should remain explicit.

## Why the numbered procedure has these steps

### 1. Make the copy and review service isolation

E3 and E4 show the same copy and setup work across unrelated gems. The lab
creates the copy, records the Ruby executable and prepares separate resource
names. A review command must precede execution, because copied application code
can still contact services outside the copy.

Expected cost falls through fewer setup commands and fewer repeated environment
failures. Quality should improve because the baseline includes local edits and
the experiment records its actual source. The risk is treating generated
configuration as complete isolation. The prompt requires reviewing other
effects and allows a source-only plan when execution cannot be isolated.

### 2. Collect sources and check runtime requirements

E6 supports retaining the existing collector rather than replacing source
research with remembered release details. The new command writes a manifest,
requirements and an index, with complete evidence in separate files. Component
discovery follows exact runtime dependencies recursively across sampled releases.

Expected cost falls through cached downloads and one source inventory. Quality
should improve through explicit missing sources and runtime prerequisites. The
sampling rule is a risk when upstream replaces rather than accumulates patch
notes. The index states the sampled versions, and the instructions require
commit review and manual research of gaps rather than claiming complete coverage.

### 3. Read changelogs and test applicability

E1 and E2 argue against turning text matches into findings. The procedure reads
removals, deprecations and behavior changes before matched fixes. It asks for
callers, configuration and stored values, with a concrete reason for dismissing
a candidate. The author requested changelogs first, and the procedure keeps that
order for each component.

Expected cost falls through an ordered reading list and direct links to complete
entries. Quality depends on retaining unmatched breaking changes. Identifier
matching and keyword classification can miss behavior changes, so they only
order work and never establish safety. Full lower-priority entries remain on disk.

### 4. Inspect commits and versioned guides

The author explicitly requested commit review, which E6 does not provide. E7
asks for versioned upstream guidance without providing a retrieval method. The
collector now resolves release tags, records both endpoint commits and saves the
endpoint diff. Small ranges include every patch. Large ranges include every
commit message and changed path, with a priority index and on-demand patches.

Expected cost falls by removing repeated repository discovery and Git commands.
Quality should improve when release notes omit changes or a guide disappears
before the target release. Eighty commits is a chosen, configurable threshold,
not a value learned from the grader. Large-range priorities, guide filenames and
headings remain heuristics. Missing tags and divergent release ancestry require
explicit limits and manual review. The script never silently uses HEAD.

### 5. Sweep versions and repair blockers in separate forks

E2 shows why source-only analysis is insufficient, and E3 shows repeated setup
around boot and test failures. The sweep runs bundle verification, boot, database
preparation, eager loading, routes and tests in a fixed order. It stops at the
first failed stage for a variant but continues the other sampled versions.
Repairs belong in forks, leaving the failing variant available for comparison.

Expected cost falls through one command for the repeated stages. Unlike the
batching experiment in E1, each subprocess retains its status and full log.
Quality should improve through a baseline and preserved failing states. Existing
tests may miss behavior changes, and the independent version copies do not
simulate sequential deployments. A blocker is reported as a blocker, not as
successful validation of later stages.

### 6. Research dependencies that actually moved

E3 includes a lockfile comparison in step 10 and a later dependency investigation
in steps 25 to 27. E6 does not cover other gems changed by resolution. The new
comparison uses before and resolved after lockfiles, records dependency parents,
and distinguishes additions, removals and source or platform changes.

Expected cost falls through generated ranges rather than manual lockfile reading.
Quality should improve by examining the dependency set actually tested. A
successful baseline boot also records loaded default libraries absent from the
lockfile. An installed but unloaded library is not evidence of prior use. Exact
lockstep ranges already covered by the primary collection are marked as covered.
Git/path sources, downgrades and ambiguous versions require manual research.
Overlapping but different ranges can still produce repeated reading.

### 7. Run discriminating probes and an unchanged control

E1 associates explicit validation with the highest reported mean, and E3 contains
an experiment that initially gave the same answer in every variant. The recipe
requires identical inputs and assertions on baseline, upgraded and repaired
copies. Inputs must distinguish the competing behaviors, with an unaffected path
as a control.

Expected cost falls through reusable execution and evidence capture, not fewer
semantic checks. Quality should improve because a passing suite or a raised
exception is no longer the entire validation. The model still has to design the
right input and expected value. The report checker can require an assertion but
cannot determine whether the assertion would detect the claimed regression.

### 8. Separate default adoption, stored data and preparation

E3 steps 51 to 55 show why defaults must sometimes be applied before boot.
Steps 39 to 43 and 61 to 65 support checking both payload directions and current
version compatibility. Every collected default needs a disposition, and the
procedure distinguishes retained behavior after the bump from adopting a default.

Expected cost falls through a seeded default inventory and reusable forks.
Quality should improve through explicit preparation, rollout and rollback checks.
The risk is comparing different payloads, keys or settings and attributing the
difference to a version. Forks deliberately do not share service data, so the
planner must export synthetic payloads and supply equal test settings. Checks
that were not executed remain proposed.

### 9. Fill and check the report

E1 and E7 support preserving application consequences, a single recommended
repair, other affected paths and discriminating validation. A generated JSON
shape gives a smaller model named fields rather than asking it to remember all
the prose requirements. Source coverage and default decisions start incomplete.

Expected cost falls through less report construction and fewer forgotten fields.
Quality should improve when omissions are caught before rendering. Honest
unknowns are allowed and remain visible. The checker validates structure and the
existence of evidence files, not whether the evidence supports the conclusion.
Large source inventories can increase the model's reading and reporting cost.

### 10. Verify the source, clean owned resources and return the full plan

E3 ends by retaining diffs and cleaning isolated resources. E7 requires evidence
attribution and plan-only behavior. The lab checks source hashes, drops only its
recorded databases and retains copies and logs. The report renderer includes
collection gaps even if the agent removes them from its free-form limitations.

Expected cost falls through a fixed completion command and no second parent
analysis. Quality should improve through an inspectable full plan with failures
and unknowns preserved. Abrupt process termination can leave owned resources
needing manual cleanup. Cleanup does not delete evidence or change the original
application, and closed labs reject further execution.

## Why each script exists

### Source collection

[`bin/gem-changes`](maintain-rails/bin/gem-changes) provides the collect and show
commands. [`bin/lib/gem_sources.rb`](maintain-rails/bin/lib/gem_sources.rb) contains
the downloaded-source, repository, guide and dependency logic. The split keeps
the command parsing separate from source collection. E6 supplies the retained
behavior, E3 supports resolved dependency research, and the author's procedure
supplies commit review. Both scripts reduce repeated retrieval work without
inventing application findings.

Full notes and patches stay available while the index is read in sections.
Content-sensitive page IDs prevent a changed page with the same title from
disappearing when several manifests are merged. Guide sections are deduplicated
by content, while changed and deleted intermediate sections remain available.
The risks are network failures, parsing heuristics and large repository sizes.
The cache is intended for serial collection, not simultaneous cold writers.

### Experiment setup and execution

[`bin/gem-upgrade-lab`](maintain-rails/bin/gem-upgrade-lab) supplies init, review,
bump, fork, check, exec, sweep, status and clean. E3 and E4 repeatedly implement
those operations in shell. The script uses the chosen Ruby executable directly,
pins only a literal gem declaration and resolves conservatively. It saves both
lockfile endpoints so a resolution record refers to the newly resolved versions.
Some successful Bundler runs still printed version-manager warnings, so complete
elimination of such warnings is not claimed.

Conventional PostgreSQL or SQLite configurations and Disk storage are rewritten
only in copies. Each executed application command uses a private foreground
Redis server with persistent data for that variant. Its process ID is checked
before use, and it is stopped after success or failure. Separate servers make
database 0 independent across variants. Expected savings come from replacing
setup and repeated stage orchestration, while explicit records preserve quality.
Custom integrations still need review, and the lab is not a network sandbox.

[`bin/lib/runtime_snapshot.rb`](maintain-rails/bin/lib/runtime_snapshot.rb) records
the libraries loaded by the copied application before loading its own helper
libraries. It supplements activated gem versions with Ruby's default-library
file inventory. The dependency investigation in E3 supports observing the
runtime instead of assuming the old lockfile names everything used. The expected
benefit is avoiding incorrect old-version endpoints. The inventory is tied to
the selected Ruby, and a failed boot cannot provide a completed runtime snapshot.

[`bin/lib/upgrade_support.rb`](maintain-rails/bin/lib/upgrade_support.rb) provides
the shared lockfile parser, path guards, file hashes and subprocess records.
E3 contains repeated redirection, tails and command chains whose final shell
status can conceal an earlier failure. The shared runner preserves nonzero exits
and timeouts as evidence. The lockfile parser avoids evaluating application code
during source research. Unknown source layouts still need manual interpretation,
and file hashes are not a complete replay of a database or external effects.

### Report generation and checking

[`bin/gem-upgrade-report`](maintain-rails/bin/gem-upgrade-report) seeds the plan,
checks it and renders Markdown. E1 and E7 provide the required fields. Executed
claims need existing run records, logs, source hashes and diffs. Omitted default
decisions, missing controls and unresolved coverage rows fail validation.
Unknown coverage is accepted and displayed, rather than replaced with guesses.
The expected savings are mechanical report work. A syntactically complete but
incorrect explanation can still pass, so semantic review remains necessary.

### Usage and regression checks

[`bin/README.md`](maintain-rails/bin/README.md) holds command contracts and failure
recovery details outside the short agent prompt. E3 and E4 justify documenting
how to recover from resolution or setup failures without recreating the lab or
changing the requested target. Keeping details out of the main prompt reduces
routine reading, but the agent must consult the reference for custom probes.

[`test/contract_test.rb`](maintain-rails/test/contract_test.rb) checks public
commands with unrelated synthetic gems and Git repositories. It covers missing
tags, complete small ranges, lazy large-range patches, intermediate guides,
dependency additions and removals, copied local edits, isolation guards and
report omissions. [`test/application_smoke.rb`](maintain-rails/test/application_smoke.rb)
checks actual PostgreSQL connections, separate Redis data and recorded outcomes
in a reviewed application lab. The tests address the failure modes in E2 to E4
without encoding the application's upgrade findings. They use Ruby's bundled
libraries rather than installing a test framework. Neither measures model quality.

The [invoking skill](maintain-rails/skills/upgrade-gem/SKILL.md) reads the exact
current version without executing the Gemfile and delegates once. The overview's
baseline recursive delegation supports keeping one owner for the investigation.
The full result is returned without a second summary that might omit conditions.
The [agent prompt](maintain-rails/agents/gem-upgrade-planner.md) contains the recipe;
the skill does not duplicate it.

## What was tested

All application execution occurred in disposable labs outside the supplied
checkout, using Ruby 3.3.6, Bundler 2.5.22, PostgreSQL 15 and Redis 7. No helper
gem was added. Git, Bundler, PostgreSQL client commands and Redis are existing
external executables used by the Ruby scripts.

The final syntax command was `ruby -c` on all three commands, all three library
files and both test scripts. Every result was `Syntax OK`.
`ruby test/contract_test.rb` reported
`72 command-contract assertions passed.`

The application smoke command, `ruby test/application_smoke.rb LAB MANIFEST...`,
passed 35 assertions against the five-version sweep. A final fresh lab with one
target resolution passed 27 assertions. The different counts reflect two
lockfile assertions per successful resolution, not omitted service checks.
Both runs checked private PostgreSQL connections, Redis separation and
persistence, environment filtering, an intentional exit 17, a timeout, report
unknowns and rejection of an invented run record.

Baseline and unchanged-fork Rails suites reported
`46 runs, 325 assertions, 0 failures, 0 errors, 0 skips`.
The version sweep resolved 7.0.10, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0.
The 7.0.10 copy passed boot, database preparation, eager loading and routes, then
reported `46 runs, 316 assertions, 1 failures, 0 errors, 0 skips`.
The four later copies stopped at boot with exit 1. The small-gem experiment
resolved concurrent-ruby 1.3.4 to 1.3.8 and also recorded a boot failure.
Application failures were retained and later stages were not claimed as tested.
Repairing those failures was outside the helper test scope.

Source collection for Rails 7.0.8.7 to 8.1.0 produced 109 review pages, 2,113 full
entries, 13 components, 36 default assignments and a 13,954-commit index. The
latest cached run took 10.938 seconds. The 583,821 bytes of review pages remain
on disk rather than appearing in one tool response. The collector reported one
release-ancestry warning. Retrieving an indexed patch through `show` succeeded.

The resolved target dependency comparison recorded 25 changes, including four
prior runtime versions absent from the old lockfile. It produced 102 pages,
317 entries and 1,544 commits, with one ancestry warning. The smaller
concurrent-ruby collection produced three pages, five entries and 46 commits
with no collection gaps. All 46 saved commit patches were checked for existence
and the recorded commit ID. The offline fixtures exercised the missing-tag and
deleted-intermediate-guide cases without relying on current upstream contents.

Cleanup removed the owned databases from all four created labs. A PostgreSQL
query returned zero remaining databases for their generated prefixes. Only the
original Redis process remained, and its database 0 still had zero keys. The
application's Git status remained clean, and its tracked-file checksum matched
the value captured before testing:

```text
361aaf874d1a151efaa8cb9aea946793e6c9717d5e137a273192c2245f6f9eca
```

The retained lab records are at
[the sweep lab](file:///home/user/optimizer-lab-final),
[the final smoke lab](file:///home/user/optimizer-lab-verify) and
[the small-gem lab](file:///home/user/optimizer-lab-small) in the implementation
orb. They contain copied application data and are not included in the plugin
archive. The packaged tests and command reference allow a fresh reproduction.

## Remaining limits and cost expectations

No dollar savings, latency improvement for the complete planner, or score
improvement has been demonstrated. The measured collection time is a cached
script run, not a model benchmark. Expected savings are fewer setup commands,
less repeated source discovery and less report construction. The source coverage
work, particularly large commit histories and many default decisions, could
increase model reading cost. The recipe deliberately preserves experiments
instead of reproducing v3's cheap but incomplete approach.

The live application test covered PostgreSQL and Rails tests. SQLite behavior,
RSpec execution, production and browser/system suites, and arbitrary custom
service layouts were not integration-tested. Private registries, Git/path gems,
unusual release tags and unsupported database adapters require manual source or
isolation work. The planner must report such limits rather than pretending that
automatic coverage is universal.

The next evaluation should compare v12 with this plugin in fresh Claude Code
sessions under the existing Opus 5.5 low-effort setup before choosing a smaller
model. Keep both a large framework upgrade and a smaller gem as cases, and add
an application not used to build these helpers. Compare application consequences,
repair correctness, discriminating validation, cost, elapsed time and tool calls.
Fewer tool calls alone do not establish a better planner.
