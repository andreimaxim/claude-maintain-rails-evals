# Rationale for the mechanical gem upgrade planner

The replacement keeps the `maintain-rails` plugin and `gem-upgrade-planner` agent
names. The planner still returns a plan and never applies an upgrade to the
working application. Its numbered procedure tells the model which command to run,
which evidence to read, what to record, and when to stop.

Scripts perform source collection, copy preparation, dependency comparison,
standard application checks, and investigation bookkeeping. The model still has
to identify application consequences and propose repairs. Automating those
judgments from textual matches would repeat a failure shown in the evidence.

## Evidence and measurement limits

Evidence references below are relative to the supplied bundle, whose SHA-256 is
`100ca49b3be6504261f743a6d6a9f034379176c4d2cb4b7956665d0932cd32d2`.
`README.md` gives means from five Rails runs per variant. Individual `meta.json`
files describe selected runs, not five-run averages.

The summary-only v3 averaged 11.2 of 23. Its low run scored 7, cost $0.77, and ran
no experiments. v8, which required an observed consequence, averaged 20.0. v9,
which required one repair preserving other paths, averaged 20.8. v10, which added
discriminating checks and controls, averaged 21.4. v12 averaged 21.0 with a median
cost of $2.97. Its selected high run scored 22, cost $2.55, and made 61 planner
tool calls, including 42 experiment commands.

Those results support retaining experiments, observed consequences, complete
repairs, and controls. They do not establish the replacement's cost or score.
No model evaluation or hidden-answer-key reconstruction was performed. Expected
effects below are hypotheses. Script verification is reported separately.

## Each procedure step has a concrete output

### 1. Collect the locked version and source evidence

Evidence comes from `runs/rails-v3-low/meta.json` and its trace, where a short
summary and no experiments produced the lowest v3 score. The current skill reads
the version manually, and every current trace starts by collecting changes and
examining the lock.

`gem-upgrade-lab inspect` reads the lock without booting. `gem-changes --output`
writes full entries with stable identifiers, complete reference lists, and source
coverage. Expected savings come from replacing repeated shell searches and
output manipulation with one collection command. Full entries should reduce
omissions caused by the original summary's shortened text and limited references.
The risk is treating collection or a textual match as an applicability verdict.
The prompt explicitly requires application inspection and records missing sources.

### 2. Read each release, component, guide, and commit interval

The author requested changelogs first, then commits, with separate coverage for
gems released together. `README.md` reports the gain from v2's intermediate-release
coverage and v12's external release notes. The original `current-plugin/bin/gem-changes`
does not collect repository guides or commits. `runs/rails-v10-high/trace.md`,
steps 33 and 50 to 55, shows later searches for release boundaries and defaults.

The collector now retains versioned guides, full commit indexes, endpoint changes,
and directory indexes. For at most 80 commits it retains every patch in order.
Above that threshold, the model follows component indexes and retrieves relevant
patches from the recorded repository. The threshold is a reading-cost policy,
not a rule about relevance. Expected savings come from avoiding repeated upstream
discovery and downloads. Quality should improve when guides explain consequences
that bullet changelogs omit. Risks include unusual tag names, unsupported hosts,
unusually named guides, divergent release branches, and excessive source volume.
Exact tags, hashes, explicit gaps, and endpoint diffs make those limits visible.

### 3. Prepare and check a baseline

`runs/rails-v12-high/trace.md`, steps 6 to 8, repeatedly prepares services and
copies, then encounters a Ruby toolchain trust failure. Similar retries appear in
`runs/rails-v10-high/trace.md`, steps 5 to 8, and the small-gem traces.

`create`, isolation review, `seal`, `run`, and `check` replace that repeated setup.
The copy contains current file contents rather than only committed HEAD. The
selected Ruby precedes toolchain shims, and child commands receive a reviewed
environment. A baseline separates existing or environment failures from upgrade
failures. Savings should come from fewer setup commands and retries. The main
risk is a custom service bypassing generated configuration. The harness audits
possible connections but is not a network sandbox. The planner must isolate
those connections before sealing, or report that execution is blocked.

### 4. Bump an independent copy and retain every check

`runs/rails-v12-high/trace.md`, steps 9 to 11, resolves the target and inspects its
lock and boot failures. `runs/rails-v10-high/trace.md`, steps 9 to 15, does the same
before repairs. v4's return to experiments raised the mean from v3's 11.2 to 18.4.

`fork` gives the target its own database, Redis database, and storage.
`bump` edits a static declaration only in that copy, resolves conservatively, and
checks the actual locked version. `check` attempts bundle, boot, eager loading,
routes, database preparation, and tests independently. Expected savings come
from fixed commands and shared disposable gem downloads. Keeping failed outputs
should preserve evidence that chained commands could hide. Dynamic declarations
and non-registry sources need manual edits in the copy. System tests, other test
frameworks, production behavior, and assets need explicit additional commands.

### 5. Include dependencies that actually moved

`runs/rails-v12-high/trace.md`, steps 10 and 11, compares resolved dependencies.
`runs/faraday-v12-low/trace.md`, steps 8 to 12, investigates an additional dependency
change and introduces a compatibility pin during diagnosis. The upgrade involves
the resolved bundle, not only the requested gem.

The lock comparison records versions, platforms, source revisions, additions,
removals, and reverse dependencies. The collector gathers separate evidence for
other upgraded registry gems. Added Ruby default gems receive candidate baseline
versions, not invented proof that the baseline loaded them. Expected savings come
from removing manual lock-diff parsing and repeated source collection. Quality
should improve by exposing indirect changes. Risks are longer collection time and
mistaking an installed default gem for the application's runtime dependency.
Unsupported intervals remain explicit gaps requiring direct inspection.

### 6. Map source changes to application behavior and effective defaults

The bundle's v6 and v8 gains support describing what callers observe rather than
listing removed APIs. `prompts/v8/gem-upgrade-planner.md` requires exact failures.
`runs/rails-v10-high/trace.md`, steps 50 to 55, tests defaults and their gating.

`gem-upgrade-review init` creates release/component groups, default candidates,
and dependency candidates. The model reads every group index and follows relevant
entries into callers, configuration, data, and tests. Recording one disposition
per group avoids copying every changelog row into another checklist. Every entry
remains available. Expected savings are bookkeeping and fewer repeated searches,
while required/default categories preserve applicability. Risks include vague
group reasons, missed changes without textual matches, and defaults whose runtime
value differs from explicit configuration. The prompt requires concrete reasons
and checking each default's effective value and gating.

### 7. Remove blockers individually and locate release boundaries when needed

`runs/rails-v10-high/trace.md`, steps 11 to 38, repeatedly fixes the first blocking
error and reruns checks. The bundle's v11 batching variant fell from v10's 21.4
to 18.8. `runs/concurrent-ruby-v12-only/trace.md` also shows toolchain failures
interfering with boot experiments.

The new procedure records an error before one repair, reruns that command, then
checks again. Intermediate versions are tested only when the first affected
release is unclear. Expected savings come from reusable copies and commands,
not from combining semantic experiments into an opaque script. Keeping repairs
separate should improve causal attribution. A later failure can still depend on
earlier repairs, and a temporary pin can conceal another finding. The planner
must explain those dependencies and cannot treat an unexplained pin or an
environment failure as an upgrade finding.

### 8. Validate consequences, repairs, controls, and stored formats

v9's repair requirement and v10's controls improved the means reported in
`README.md`. `runs/rails-v10-high/trace.md`, steps 40 to 43, tests both directions
of stored-data compatibility. Steps 60 to 65 test other paths and current-version
compatibility. `runs/pagy-v12-low/trace.md` deliberately uses unequal data in its
probe, rather than data that could pass with the wrong ordering.

The procedure specifies the same probe on baseline, target without the repair,
and target with the repair. Each finding needs setup, action, assertions, and an
unchanged control. Changed stored or queued formats use the application's actual
format in both writer/reader directions. Optional defaults use separate forks.
Expected savings come from the `run` harness and preserved variants. Quality
should improve because a passing check must distinguish the proposed behavior
from a plausible wrong implementation. Probe design remains model work, and
isolated fakes may differ from production adapters. Unexecuted checks must remain
proposed rather than being reported as passing.

### 9. Check completeness, return the plan, and clean disposable services

`prompts/v10/gem-upgrade-planner.md` specifies repairs and validation, but
`README.md` says validation is rarely complete. The final trace step in
`runs/rails-v10-high/trace.md` saves evidence and tears down services. The baseline
variant recursively delegated to itself, which the later variants forbid.

The review checker requires impact, applicability, evidence, one repair,
validation, controls, current-version compatibility, and rollback handling.
It rejects missing candidates and dangling finding links. Honest unresolved work
is allowed only with stated limits. The skill delegates once and returns the full
plan; the agent cannot delegate again. Expected savings come from less final
formatting and recursive work. Required fields should reduce incomplete findings,
but the checker cannot judge truth or a repair's correctness. `cleanup` uses
recorded ownership before touching disposable resources and retains evidence.

## Script responsibilities and their limits

`bin/gem-changes` extends the original collector, including recursive component
discovery, component-specific coverage, defaults, full entries, repository sources,
and actual dependency movement. It removes the original exclusion that missed
application source when the copy itself lived under `/tmp`. Its supporting
evidence and expected effects are described in steps 1, 2, 5, and 6. Source
parsing remains heuristic, and summaries remain indexes rather than conclusions.

`bin/upgrade-support.rb` holds standard-library HTTP, bounded subprocesses, lock
identity comparison, exact tag collection, and source indexing shared by the
commands. It replaces repeated upstream and lock-inspection work visible in the
Rails and Faraday traces. A single implementation reduces repeated model-written
parsers. Risks include network failures, stale mutable release notes, incomplete
tag naming support, and source volume. Cached tags are checked rather than
silently replaced, and failures are retained as gaps.

`bin/gem-upgrade-lab` owns the disposable experiment workflow described in steps
3, 4, 7, 8, and 9. It refuses Redis database 0 and occupied databases, atomically
claims an empty database, and creates a random PostgreSQL database. It preserves
added and deleted experiment files across forks. It records full output, command,
exit status, timeouts, configuration, hashes, and both lockfiles. Standardizing
setup should reduce model-written scripts and toolchain retries. Automatic setup
supports local PostgreSQL and unauthenticated local Redis only. Custom resources
and other database adapters require reviewed manual isolation, not execution on
the original services. Sharing gem downloads saves time but forbids concurrent
bundle installation into the same disposable bundle.

`bin/gem-upgrade-review` performs the bookkeeping described in steps 6 and 9.
Release/component groups reduce recording cost without deleting entry evidence.
The permanent contract tests cover lost candidates, incomplete findings, source
gaps, and refusal to overwrite decisions. The checker accepts nonempty evidence
strings but cannot establish that those strings are correct. It is not a grader.

All scripts use only Ruby's standard library, including RubyGems. Git, Bundler,
`psql`, PostgreSQL, and Redis are existing external tools or services, not new
Ruby dependencies. Application commands use the application's own bundle.

## Executed verification

Verification used Ruby 3.3.6, PostgreSQL 15, and local Redis in the supplied orb.
Application commands ran only in disposable copies with separate PostgreSQL and
Redis databases. The original checkout's `git status --short` remained empty.

`ruby maintain-rails/test/tools_test.rb` passed its lock identity, reverse
dependency, missing source, complete group index, non-overwrite, removed candidate,
pending review, incomplete finding, and honest-limit controls. `ruby -c` passed
for all four files under `bin/` and the retained contract test.

The baseline's six independent checks passed. Its decisive test output was
`46 runs, 325 assertions, 0 failures, 0 errors, 0 skips`. A concurrent-ruby bump
to 1.3.8 resolved, then failed boot and subsequent application checks. A repair
only in the copy restored all six checks and the same 46 tests and 325 assertions.
A preserved baseline was checked again after the other experiments and passed.

The harness also resolved the exact Rails 8.1.0, Faraday 2.12.2, and Pagy 9.3.5
targets. It recorded application failures for each, while still attempting every
check. The intermediate Rails targets 7.0.10, 7.1.6, 7.2.4, and 8.0.5.1 resolved.
Rails 7.0.10 passed five checks but its tests reported 46 runs, 316 assertions,
and one failure. Later intermediate versions passed bundle resolution and failed
application checks. Those results validate failure recording, not successful
application upgrades or a complete repair plan.

Source collection against the disposable application produced:

| Upgrade | Collected evidence |
| --- | --- |
| Rails 7.0.8.7 to 8.1.0 | 13 components, 5 sampled releases, 13,954 commits, 280 versioned document records, 41 default candidates, and 25 lock-delta rows. |
| Faraday 1.10.4 to 2.12.2 | 251 commits and versioned documents, plus source collection for other changed dependencies. |
| Pagy 8.6.3 to 9.3.5 | 175 commits and versioned documents. |
| concurrent-ruby 1.3.4 to 1.3.8 | 46 commits, with every patch retained, and versioned documents. |

The Rails review contained 153 candidate groups and correctly rejected pending
review. A separate review against actual collected application evidence accepted
one unverified group with an explicit limit and recorded check paths. No finding
was invented to make the checker pass.

Safety experiments verified refusal of an occupied Redis database, refusal of
database 0, and refusal to execute a command before sealing. A synthetic parent
application environment variable was absent from a child command. A timed command
returned a timeout and termination signal. Forks retained an added file and a
deleted file while using distinct service resources. Cleanup removed all eight
active labs' databases and Redis claims. Final queries showed zero
`gem_upgrade_*` PostgreSQL databases and zero Redis ownership markers.

The logs remain in the orb's temporary lab directories. Their filenames and
observed outputs informed the results above. Temporary application copies and
their installed bundles were removed after verification. Logs are not part of
the replacement plugin. No services were started by the harness.

## Cost and quality still need a model evaluation

The agent inherits its caller's model rather than naming an expensive model.
Choosing a smaller model does not establish that it follows the procedure or
writes plans of comparable quality.

A proposed first evaluation uses fresh isolated sessions through Claude Code
with the actual plugin and tools. Run v12 and the replacement on Claude Opus 5.5
at low effort, with two sessions per prompt for the Rails case and one per prompt
for concurrent-ruby and Faraday. That is eight sessions. Compare grader score,
cost, wall time, executed experiments, missing controls, and false findings.
The small cases are controls against turning every upgrade into an unnecessarily
long framework investigation. If quality holds, a separate evaluation can run
the replacement on a cheaper model with the same cases. Neither evaluation was
run. The proposed first evaluation does not measure smaller-model performance,
all database adapters, other source hosts, or upgrades absent from the bundle.
