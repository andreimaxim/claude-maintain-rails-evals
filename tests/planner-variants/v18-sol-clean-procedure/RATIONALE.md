# Why the planner follows this procedure

The replacement keeps application experiments and the v10 finding requirements.
Scripts now collect upstream evidence, prepare private services, pin copied
Gemfiles and run repeatable checks. The agent spends its work on applicability,
consequences and repairs. The planner has eight numbered steps and about 800
words. It inherits the caller's model instead of forcing an untested cheaper
model. The plugin and agent names remain unchanged.

No hidden evaluation application, answer key or final evaluation plans were
available or used. The observations below support the design, but do not measure
its new model cost or score. Script tests are not an agent evaluation.

## What the supplied runs support

The supplied README reports five Rails runs per variant. The available metadata
gives the following aggregates. Scores are findings out of 23, not percentages.

| Variant | Mean score | Median dollars | Median minutes | Median planner tool calls |
| --- | ---: | ---: | ---: | ---: |
| baseline | 16.6 | 2.90 | 13.0 | 54 |
| v3 | 11.2 | 1.71 | 5.6 | 37 |
| v8 | 20.0 | 2.48 | 11.0 | 58 |
| v9 | 20.8 | 2.86 | 12.1 | 64 |
| v10 | 21.4 | 2.96 | 13.2 | 66 |
| v12 | 21.0 | 2.97 | 15.0 | 61 |

Sources are `README.md`, `runs/rails-*/meta.json` and
`prompts/{baseline,v3,v8,v9,v10}/gem-upgrade-planner.md` in the supplied bundle.
The README also reports that correcting the summary's role in v4 recovered the
mean to 18.4, and that v11 command batching lowered the mean to 18.8. There are no
v11 run files in the bundle. Those are README observations, not reconstructed
traces. Five runs and changing prompts do not establish causality or significance.

The process outlines identify repeated work, though their command classification
is approximate. For example:

* `rails-base-1` has 14 database/Redis setup calls, six bundle calls and two copy
  calls. It took 23.3 minutes and $4.53.
* `rails-v10-1` has eight service setup calls, four bundle calls, 11 suite calls and
  26 runner probes. It took 18.9 minutes and $4.55.
* `rails-v12-1` still has nine service setup calls, five bundle calls and two copy
  calls. It also has 11 suite calls and nine runner probes.
* `faraday-v12-1` has five copy calls and six bundle calls. `pagy-v12-1` has five
  service setup calls. Repeated setup is not confined to Rails upgrades.

The replacement does not try to eliminate runner probes. The v8 to v10 results
support keeping observations, complete repairs and discriminating checks.

## Each numbered step has a specific purpose

| Step | Supporting evidence | Expected cost and quality effect | Risk and response |
| --- | --- | --- | --- |
| 1. Establish versions and collect evidence. | The current skill asks for an exact current version without explaining how to obtain it. Earlier outlines repeat file reads and searches. v3 establishes that a summary can reduce work, but not replace investigation. | Read the lockfile once. One collector invocation replaces repeated changelog, component and source discovery. Verify source identity so public metadata is not substituted for a private package. | Public RubyGems/GitHub coverage is incomplete for private and other-hosted gems. Use actual sources or report the gap. Do not guess versions from Gemfile constraints. |
| 2. Review the release/component index. | The v3 prompt called the summary a checklist and averaged 11.2; the README's v4 correction treated it as an index and retained experiments. | Scan short indexed entries, then expand possible impacts. Stable IDs and a disposition table reduce repeated reading and forgotten unmatched changes. Full text remains available. | Lexical matches, risk words and short titles can both miss changes and produce false positives. No match is never a reason for dismissal. Unknown rows must remain visible. |
| 3. Read commits, guides and defaults. | The author's requested method explicitly includes commits and split components. v2 and subsequent prompts require intermediate releases and defaults. The v12 external-note collection retains a mean of 21.0 versus v10's 21.4. | Mechanical tag resolution and guide extraction replace browsing and command construction. Small histories get every patch. Large histories have component/risk indexes and all commits retained. | Large-history ranking is a heuristic, not proof of completeness. Record unreviewed history. Check actual API implementations and upstream tests. Default templates are an index, not the effective runtime configuration. |
| 4. Establish an isolated baseline. | Every sampled process outline repeats copy/service setup. The existing prompt explicitly says a checkout copy does not isolate services. | One setup command creates the snapshot, inventory and review gate. One check call runs six separately recorded stages. Baseline failures are not blamed on the requested upgrade. | Scripts cannot prove arbitrary application code safe. Review connection code, seeds, migrations, install hooks and credential loaders first. Never execute when isolation is uncertain. |
| 5. Check each intermediate series and target. | The README says summary-only plans miss runtime failures. The current prompt and v2 history require intermediate-release coverage. Outlines repeatedly boot, eager-load, draw routes and run tests. | Standard commands and private resources avoid rebuilding these experiments. Keeping old defaults isolates the version bump from optional adoption. Separate stage records expose failures hidden by lazy loading or empty suites. | Running all representative series adds runtime, especially for a long library range. Do not interpret this as a benchmark speed guarantee. Preserve each failure and inspect results between versions. A failed resolver blocks attribution to that version. |
| 6. Inspect the resolved dependency movement. | The author identifies this as a missing capability; outlines repeatedly resolve bundles and read gem source. | Lockfile comparison is deterministic. Automatically collect moved public dependencies' changelogs, commits and guides, while avoiding duplicate lockstep-component work. Save added/removed public gem metadata too. | Bundler can expose unrelated old incompatibilities or select new dependencies. Preserve lockfiles and distinguish those failures. Private sources, Git/path revisions, downgrades and ambiguous platforms remain explicit manual review items. |
| 7. Prove consequences and repairs. | v8 added exact observed consequences and averaged 20.0. v9's complete repair reached 20.8. v10's failing/passing checks and controls reached 21.4. The README says validation with unequal inputs and controls is still often missing. | Use the same small probe across current, unrepaired and repaired variants. The helper supplies services, environment, time limits and evidence retention, leaving the agent to write assertions. | Data and expected results still require domain understanding. Test both paths through a repair and old/new readers. A suite pass alone does not validate a finding. Mark blocked probes as proposed. |
| 8. Assemble and audit the plan. | The v8 to v10 requirements improved the observed scores. The baseline and current prompts separate required changes, defaults, rollout and evidence status. | A fixed finding schema and review-table audit make omissions visible to a smaller model. One repair per finding avoids unresolved alternatives. | A complete table can still contain wrong reasoning. The schema is a review aid, not an answer key or proof of correctness. Preserve unknowns and the source/runtime distinction. |

## What the scripts own

### `bin/gem-changes`

The supplied collector remains the source of packaged changelog, split-component
and intermediate-series evidence. Its stdout still works as a quick summary.
New artifacts provide short entry indexes, full entries with citations and
references, a pending changelog/default review table, default metadata and
coverage gaps. An unmatched behavior change is no longer omitted merely because
it is neither a removal nor a deprecation.

The extension invokes `gem-history`, compares the two resolved lockfiles when
given `--locks`, and writes one report for each moved non-component public gem.
Added/removed gems get metadata rather than a fabricated version interval.
Git/path/private sources and source changes are retained as review items.
Recursive dependency reports do not receive `--locks`, so the collector does not
recursively resolve the dependency graph or invoke itself forever.

Tests also exposed inherited collection defects. The old source filter rejected
every application file when its absolute path contained `/tmp/`. The old defaults
parser recognized `Rails.application.config` but missed the newer
`Rails.configuration` spelling and direct constant assignments. The replacement
recognizes dotted constant assignments generally. It found all six assignments
in the tagged Rails 8.1 template, without encoding those setting names in code.
It also checks component coverage separately instead of letting one component's
changelog hide another missing component.

Expected savings come from one fetch/index operation and dependency-report
generation, not deleting evidence. Risks include unusual changelog formatting,
mutable upstream metadata, incomplete release-note pagination, template omissions
and rate/network limits. The inherited strategy reads the latest cumulative
package in each minor series plus the target, not every patch package. Tagged
guides and commits supplement it; the output is not a completeness certificate.

### `bin/gem-history`

This collector uses Git rather than a capped web compare response. It resolves
exact supported tag names, fetches all ancestry after the old tag, records both
commit IDs and preserves the full commit/path index. Each interval has its own
locked cache so later shallow fetches do not alter earlier intervals.

At 80 commits or fewer, every commit gets a patch. Above 80, component indexes
rank subjects mentioning removals, defaults, formats and similar changes. The
threshold is an unmeasured output-format choice, not a claim that 80 is optimal.
All commits remain accessible, and the prompt requires disclosure of unreviewed
history. Commits touching multiple components appear in multiple groups.

Guides, changelogs, release notes and defaults are copied from release tags, with
their endpoint diff. Deleted guides retain their old-tag contents. The planner
repeats collection for intermediate resolved variants, which also captures guides
that no longer exist at the final release. Unsupported tags/hosts produce an
explicit gap rather than silently comparing a branch.

The expected saving is fewer browsing and retrieval decisions. The risk is false
negatives in filename/subject heuristics. A large range still costs time to
review, and inspecting every risky patch may dominate a difficult upgrade.

### `bin/upgrade-lab`

`create`, `add` and `run` replace repeated copy, Gemfile editing, service setup
and check construction seen in the outlines. The source is read, not executed.
It copies local file contents without Git metadata, dotenv files, keys, symlinks,
vendor packages or stored data. It refuses to create a session inside the source.
Source code hashes are checked before and after execution.

Every variant has a private PostgreSQL cluster, private Redis persistence and
disk roots. Both services use private Unix sockets with TCP disabled, removing
port selection and collision risks. They start for an invocation and stop in
`ensure`. Data persists within a variant but is not shared with another variant.
The child environment is built from an allowlist instead of inheriting source
service URLs and secrets. Extra database roles and safe per-role options are
supported. This does not reproduce replication topology.

The review gate is necessary, not ceremonial. Static scans cannot discover every
literal network connection or filesystem side effect. The helper supports
PostgreSQL, not every database vendor. Unknown/different adapters block execution;
the planner must use a separately isolated original-vendor setup or label runtime
checks blocked. It must never change database vendors to obtain a green result.
Credential-dependent apps, non-Unix Redis clients, local path gems and complex
Gemfiles can also require setup in the copy. The procedure remains usable through
actual source review and explicit blockers, rather than pretending the helper
supports those environments automatically.

Each stage has its own argv, exit code, duration and full log. A failing resolver
stops later checks, and the requested exact version is verified in the resulting
lockfile. A successful zero-test process is retained as exit zero but marked
missing coverage, and the wrapper returns failure. A few error/summary lines
print immediately; full logs are never discarded. Arbitrary assertion probes use
the same wrapper through `exec --`.

Runs retain Ruby identity, configuration, environment, lockfile, source hashes,
changed file bytes and Ruby probe inputs. The evidence remains attributable after
the agent edits a variant or deletes its temporary probe. Logs are private and
can contain application data. A hard process kill can still require cleanup of
that session's services. Excluded source logs, storage and secrets are not hashed.

The v11 result cautions against hiding investigation inside one large script.
The helper batches only standard check construction. It preserves per-stage
results, supports running each stage separately, and does not decide findings or
batch all finding-specific probes into an opaque success result.

## Executed validation

The bundle archive matched the requested SHA-256 before extraction. I installed
Ruby 3.3.6, PostgreSQL 15 and Redis 7 in the orb. I generated a new Rails 7.0.8.7
application with PostgreSQL records, statuses, a job, Redis cache reads/writes and
a stubbed HTTP client. Its two tests use unequal record amounts (13 and 29),
creation and update paths, a preserved control and a validation rejection.
No test application identifiers, paths or repairs appear in the planner or tools.

All runtime upgrade checks used disposable variants, not the source application.
The main session was `/tmp/upgrade-validation-v2`. Reproduction uses the commands
documented in `maintain-rails/bin/README.md` with any reviewed PostgreSQL Rails
application. The fixture and full run directories remain in this orb, outside
the deliverable. The archive contains the plugin and this rationale, not service
data, gem caches, keys or test application code.

| Executed scenario | Decisive result |
| --- | --- |
| Baseline Rails 7.0.8.7, all six `check` stages. | All exit 0. `2 runs, 6 assertions, 0 failures, 0 errors, 0 skips`. |
| Untouched Rails 8.1.0 bump. | Resolver exit 0; boot and later checks expose an incompatible newly selected connection-pool dependency. The failure is retained, not treated as a collector finding without investigation. |
| Separate repair variant, dependency constraint only. | Boot/routes pass; eager loading fails with `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at the application's old API call. Tests report one error. |
| Rails 8.1.0 with the dependency constraint and API repair. | All six stages exit 0; `EAGER_LOAD_OK`; the same two tests and six assertions pass. Latest full run was `20261014T124035-repaired-3a9b43`. |
| The same preparatory changes on Rails 7.0.8.7. | All six stages exit 0, with the same two tests/six assertions. Latest full run was `20261014T123259-prepared-2d381f`. |
| Rails 7.1.6 intermediate variant. | Resolver succeeds and the newly selected dependency's boot incompatibility is recorded separately from baseline failures. |
| Faraday 1.10.4 to 2.12.3, leaving Rails 7.0.8.7 unchanged. | All six stages and both tests pass. The stubbed HTTP response control remains correct. This is a non-framework control, not proof of all Faraday API compatibility. |
| Cross-variant service isolation and persistence. | Write database value 101 and Redis value 17 in current; repaired sees neither; a later current invocation reads both. `SHOW listen_addresses` is empty. An inherited dummy secret and unsafe source URLs do not enter the child environment. |
| Multiple database roles, safe options, storage roots and URL substitution. | A separate audit database is queryable; primary pool and replica/task options survive; generated disk roots stay under the variant; queue Redis URL points to the private service. Assertion probe exits 0. |
| Empty suite, timeout, nonzero command and unsafe destination. | Zero-test process exit 0 is flagged and wrapper exits 1. A five-second sleep with a one-second limit records exit 124. Explicit command exit 23 is retained. A session inside the source is rejected, including through a symlinked parent. A normal outside destination still succeeds. Services stop afterward. |
| Session path containing spaces. | A new session runs all six stages successfully and reports the same passing tests. |
| Complete source file preservation. | SHA-256 lists for every source file, including files excluded from the helper's own hash list, compare equal after the final runtime checks. |

Initial fixture setup also caught two environment problems. PostgreSQL's
`--no-locale` default encoding was SQL_ASCII, which failed Rails test database
recreation. The helper now explicitly creates UTF8 clusters. A fresh Rails 7
bundle selected incompatible Minitest 6; the independently generated fixture was
completed with a Minitest 5 constraint before the final baseline. Neither repair
was added as application-specific advice to the plugin.

The evidence collectors were also executed against these disposable copies:

* Rails collection found 1,579 complete changelog entries, application references
  on 104 entries under `/tmp`, and 40 template assignments across 7.1, 7.2, 8.0
  and 8.1. All six Rails 8.1 template assignments appear. The previous parser's
  saved run had 33 assignments and no 8.1 section. The complete history has
  13,954 commits and 50 guide/default/changelog paths, including removed files.
* GitHub's independent compare response reports `ahead_by: 13954`, agreeing with
  the Rails Git interval. Its `total_commits` field is capped at 10,000, which is
  why the script does not use that field as complete history.
* The small concurrent-ruby 1.3.4 to 1.3.5 interval produces six patch files for
  six commits, matching the independent GitHub comparison. An absent old tag
  records a coverage gap and exits 2 without selecting another ref.
* Faraday collection reads its tagged `UPGRADING.md` and changelog and records 247
  commits. Resolved Rails lock comparison records 35 dependency movements,
  automatically collects Rack 2.2.24 to 3.2.7 evidence, and saves metadata for
  newly introduced public gems. Component reports are not duplicated as other
  dependencies.

Every delivered executable passed `ruby -c` and was exercised against a
disposable application copy. These checks establish script behavior on the
listed stack and scenarios. They do not establish plan recall, smaller-model
instruction following, production configuration compatibility or reduced model
cost. No actual Claude planning session or grader was run.

## What still needs measurement

Use the original held-out evaluation application and grader, not this fixture,
to compare v12 with the replacement on the same model/settings first. Then try
the smaller intended model with identical tasks. A useful initial budget is
three sessions for each of those three conditions, for nine sessions total.
Compare score, dollars, elapsed time, unknowns, unsupported repairs and controls
per finding. Include a small-gem case and a no-impact control before drawing a
general conclusion. Do not count lower cost achieved by returning more unknowns
or skipping probes as a quality-preserving saving.

The proposed savings are reduced repeated setup/retrieval and less planning of
routine commands. Extra commit/dependency coverage and intermediate executions
can increase wall time. The hidden-key evaluation must decide whether the net
cost/quality tradeoff meets the goal. No published price or score improvement is
claimed by this delivery.
