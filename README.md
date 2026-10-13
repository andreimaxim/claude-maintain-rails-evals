# Gem upgrade planner evaluations

This repository records evaluations of the `maintain-rails:gem-upgrade-planner`
Claude Code subagent. The goal is to assess the application-specific plan it
returns: affected code, recommended changes, and validation steps. Completing an
upgrade is a separate capability, not the result these tests measure.

## Repository boundaries

| Repository | Responsibility |
| --- | --- |
| [claude-maintain-rails-evals](https://github.com/andreimaxim/claude-maintain-rails-evals) | The evaluation entry point: test cases, expected findings, run records, and assessment |
| [claude-maintain-rails-sample](https://github.com/andreimaxim/claude-maintain-rails-sample) | Margin Notes, the Rails application being evaluated |
| [claude-plugins](https://github.com/andreimaxim/claude-plugins) | The general Claude Code plugin marketplace, including `maintain-rails`, its skill, and its planner prompt |

## Run evaluations from this repo; run each test in an app orb

**A thread in the evals project coordinates the evaluation.** This repository
owns the [frozen skill and subagent prompt](tests/planner-inputs/README.md), their
hashes, test cases, evidence and grading. A plugin checkout is no longer needed
to prepare worker inputs. The coordinator can retain an application checkout for
inspection; workers must not receive the answer keys.

**Each run happens in a dedicated app orb.** Workers use the
`andrei/claude-maintain-rails-sample` project with no additional repositories and
no pre-setup script. The app's setup prepares Ruby, PostgreSQL and Redis; it no
longer links a plugin. Sample commit
[`ab732f5`](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7)
made that change; its application files are identical to the frozen fixture
[`468e970`](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/468e97084e809f8613523d0ac1bee6bf69794b4a).

Each run loads the skill variant under test for one headless session with
`claude -p --plugin-dir`; see the [bundle instructions](tests/planner-inputs/README.md).
For each run:

1. `node scripts/prepare-run.ts <payload> --request "<request>" --model <model> --effort <effort> --run-id <id> [--plugin-dir <variant>]`
   writes a payload and prints the worker prompt, the upload path and the result path.
2. Create the worker thread in `andrei/claude-maintain-rails-sample` with
   `executor: orb`, `agent_mode: external-agent:claude-code` and a cheap worker
   model, such as features `model:claude-haiku-5-5` and `effort:low`. Send the
   printed prompt, then upload the payload to the printed path with `upload_thread_file`.
3. When the worker replies `STATUS done`, download the result archive with
   `download_thread_file` and check its SHA-256 against the reply.

The worker agent only checks the payload hash, starts the runner and waits. The
runner refuses a moved or dirty checkout, a changed plugin or missing services.
It runs the session with a private `CLAUDE_CONFIG_DIR`, so the worker's own session
and any installed plugins stay out of it. The archive holds the stream output,
the native main and subagent transcripts, and `receipt.json`: plugin hashes,
application state before and after, service checks, wall time, every result
record and the session's `total_cost_usd`. A background planner makes `claude -p`
emit two results; the last one carries the delivered plan and the session total.
Archives contain thinking blocks; keep them under `.amp/in/` and do not commit them.

Two Haiku/low no-op trials (`Upgrade the rack gem to 2.2.24`) completed through this
route with unchanged checkouts. The [first](https://ampcode.com/threads/T-01a13670-8a9b-7759-bb3d-0508cdbd0085),
with an earlier Python runner, invoked the skill and planner in 16 seconds for $0.006.
The [second](https://ampcode.com/threads/T-01a13681-c483-757c-b030-6a66eaed9413), with
the TypeScript runner, invoked the skill but answered without the planner, in 9 seconds
for $0.0015. Results from this route need their own baseline: earlier runs used Amp's
Claude Code mode with an installed plugin.

The coordinator selects cases, starts run threads, waits for their results,
collects the planner invocations and returned plans, and assesses them here. A
batch with ten concurrent runs uses ten separate app orbs, not ten agents sharing
the coordinator's application checkout.

The October 12 runs used the sample project with a `claude-plugins` checkout. The
October 13 supplement used a separate worker project whose pre-setup installed the
frozen bundle; that project is deleted, and its threads remain readable. Both
routes ran Claude Code through Amp's `external-agent:claude-code` mode.

The coordinator does not need the application's Ruby toolchain or database
services. This repo does not pin Ruby or provision Rails dependencies; the app's
setup prepares Ruby, Bundler, PostgreSQL, and Redis in each worker orb.

Worker orbs must not clone this evals repository. The coordinator can read the
answer key, but the model under test must not receive it. Keep expected findings,
repair recipes, and scoring criteria out of the worker prompt, plugin prompts,
and application guidance. Give each worker only its case's natural-language
upgrade request.

The [development answer key](tests/planner-development.md) consolidates the
23 Rails and two Sidekiq findings, applicability conditions, verified repairs,
and manual assessment criteria. The [smoke cases](tests/planner-smoke.md) cover
the plan-delivery workflow. There is no automated evaluation runner or scorer.
The original fixture research and verification evidence remain in the
[fixture-building thread](https://ampcode.com/threads/T-01a12a2a-b175-7704-8f32-3fdc646d0213).
Held-out feedback stays unopened until the development revision is frozen.

The [October 12 diagnostic assessment](tests/planner-development-diagnostic-20261012.md)
records two unchanged Rails runs and one Sidekiq run. The
[first development batch](tests/planner-development-batch1-20261012.md) is assessed:
three Rails final responses lose substantial details from their raw plans. A
delivery-only correction is published, and ten fresh development repetitions
were interrupted by Claude Code's session limit. None delivered a completed
plan. After the quota reset, all ten fresh replacements completed; their source
audit matches the intended candidate. The
[second-batch assessment](tests/planner-development-batch2-20261012.md) finds no
selected-family actionability loss during delivery, with remaining omissions
and unsafe claims. The user requested freezing that revision without more tuning.
The [evaluation-cycle record](tests/planner-suite-20261012.md) tracks the frozen
correctness/time comparison: Opus 5.5 low, Sonnet 5.5 medium, then Haiku 5.5 medium.
The original Opus-high batch was a development-only reference. Each new
configuration runs five repetitions of all four cases and assesses every plan;
Opus-high held-out coverage was added afterward without tuning. Opus-low Rails and
Sidekiq are assessed, with per-run timing, reported planner tokens and observed
variation recorded. The resumed Pagy/Faraday attempts are excluded because the
plugin remote no longer contains `maintain-rails`; all ten workers acknowledged
the stop. The user approved a temporary frozen-source pre-setup pin, and all ten
pinned Opus-low replacements are assessed. Pagy retains 5/10 actionable family
memberships and Faraday 4/10 per raw/final layer; workflow and safety failures
remain separate from recall. All twenty Sonnet-medium runs are assessed: final
Rails recall ranges from 14–18/23, Sidekiq retains 1/2 in every run, Pagy retains
6/10 family memberships and Faraday 3/10. These are selected-finding counts,
not overall correctness pass rates. All twenty Haiku-medium outcomes are assessed,
including missing plans, implementation instead of planning, lossy summaries and
late recovery. Seven have verified full designated-plan delivery. Native model
audits are unavailable for six Haiku runs after evidence-collection refusals.
The temporary project setting has been restored to its previous empty value;
no planner tuning followed held-out exposure.

The October 13 Opus-high supplement completes five Pagy and five Faraday results
using the eval-owned bundle in the isolated worker project. Pagy retains 10/10
actionable finding memberships and Faraday 9/10 in both raw and final plans;
none fully specifies the rubric's validation matrix. Seven quota-interrupted
attempts remain separate, with their recorded spend retained.

The [durable results](tests/results/20261012/README.md) retain 80 benchmark slots:
four configurations, four cases and five repetitions. They include visible
traces, raw/final finding assessments, wall times, available token footers,
descriptive variance, recovered native audits/reports and earlier failure evidence.
Nested experiment logs were not generally collected, and token footers are not
billed totals. Source and published-file hashes identify privacy transformations.

The [usage-accounting notes](tests/planner-inputs/README.md#costs-need-a-separate-source)
distinguish retained token totals, partial cache counters and the whole-tree SDK
usage needed for API-cost graphs. Recovered native usage provides 68 recorded-request
list-price estimates, five lower bounds and seven unavailable costs. These are
not invoices or complete bills; unlogged helpers and billing adjustments are excluded.

The [per-run failure ledger](tests/planner-failures-20261012.json) keeps workflow
failures and late recoveries separate from finding recall. It records quoted
evidence, thread links, export hashes and timing boundaries; a progress response
or fallback plan does not silently become a successful designated-planner run.

To retain a completed run's visible tool trace and planner response without
thinking blocks or account/environment metadata, keep the full export in a
private temporary directory:

```sh
private_dir=$(mktemp -d)
amp threads export <thread-id> > "$private_dir/thread.json"
node scripts/collect-trace.ts "$private_dir/thread.json" /tmp/planner-trace.json
rm -r "$private_dir"
```

Review tool output for secrets before sharing the trace. The collector requires
an idle thread, a completed planner invocation, and final assistant text. It
rejects recovered partial reports and parent API-error responses even when a
harness status says `done` or `success`. It does not grade the plan or collect
nested experiment logs. Keep the full export private and remove it after collection.

An async launch acknowledgment is not a completed planner report. If the planner
runs in the background, collect its completed native JSONL transcript privately
and pass `--background-transcript <path>` to the collector. It requires matching
agent identity, a completed final report, and a later parent response. The trace
retains the report and source hash, not the transcript's thinking blocks.

Export and collect the scored turn before sending evidence-recovery follow-ups.
Keep that trace unchanged: later collection messages are not benchmark input or
part of its elapsed time. `wall_time_ms` uses the initial request and recorded
idle-state timestamp, not the start timestamp of a streamed final message.

The evaluation scripts are TypeScript in `scripts/` and run directly on Node 26 or
later, with no build step. Run their tests with `npm test`. `npm install` adds the
TypeScript compiler for `npm run typecheck`; the scripts themselves need no packages.

## Hill climbing uses an automated grader and a headless baseline

The next goal is Opus-high Rails recall at much lower time and cost, for routine
maintenance. Cases are split by role: Pagy, Faraday, a patch bump and a no-op for
training; Rails for hill climbing; Sidekiq for testing. Every configuration runs
five repetitions.

**`scripts/grade-plan.ts` grades a plan against the answer key.** A headless Opus
5.5 session at high effort, with no tools, receives
[the grading instructions](tests/grader-instructions.md), the case's answer-key
section and the plan, and returns the four judgments for each selected finding.
The script counts actionable findings. A Rails plan costs about $0.20 to grade.

**The grader agrees with the hand grades about as well as with itself.**
`scripts/calibrate-grader.ts` graded the 79 hand-graded final plans. The first
instructions were stricter than the hand graders, by 1.8 findings per Rails run.
Two rules were revised using only the Opus-low and Sonnet runs: a concrete
failure in this application counts as impact without the key's full consequence
chain, and a repair is not marked down for omitting a prerequisite the key lists
separately. On the held-back Opus-high and Haiku runs, actionable agreement is
0.88 (kappa 0.74) and per-run counts differ by 0.69 on average. Re-grading the
same Rails plans agreed on 97% of findings, with per-run counts moving by 0 to 3.
Rails stays 1 to 2 findings per run stricter than the hand grades, concentrated
in R21 recommendations and R11, R14 and R19 impact. Compare variants under the
same grader version rather than against the October 12 hand-graded counts. The
[calibration record](tests/results/20261013-headless/grader-calibration.json)
keeps all four passes.

**The headless Opus-low Rails baseline scores a median of 16 of 23.** Five runs
of the frozen bundle through `claude -p --plugin-dir` scored 16, 16, 16, 18 and
17, with a median of 13.0 minutes and $2.90 per run. The October 12 Opus-low runs
score a median of 16 under the same grader, so the harness change did not shift
recall. Every run left the checkout unchanged. No plan fully specified any
finding's validation. R02 was never actionable, R25 never, R09, R14 and R19 in
one run each. Each run nested the planner three levels deep: the planner loads
`upgrade-gem`, which delegates to another planner. The October 12 runs show the
same pattern. The [baseline record](tests/results/20261013-headless/baseline-opus-low-rails/summary.json)
keeps each run's plan, receipt and grade; archives with thinking blocks are not
committed.

**Removing self-delegation made runs cheaper but lost about one finding.**
[Variant v1](tests/planner-variants/v1-no-self-delegation) gives the planner a tool
allowlist without `Skill` and `Agent`; nothing else changes. Its five Opus-low
Rails runs scored 15, 15, 15, 15 and 17, with a median of 11.1 minutes and $1.84
per run, against the baseline's 16, 16, 16, 18 and 17 at 13.0 minutes and $2.90.
R20 fell from 4/5 actionable to 0/5 and R09 went unmentioned in four runs, while
R02 rose from 0/5 to 4/5. The baseline's extra planner levels had passed the working
planner a 690 to 1,090 character handoff restating the planner instructions, with
intermediate versions and optional default adoption spelled out. Without them,
the main agent's handoff is 130 to 160 characters. The
[v1 record](tests/results/20261013-headless/v1-no-self-delegation-rails/summary.json)
keeps each run's plan, receipt and grade.

**Tracing intermediate releases recovered recall, and the cost came back too.**
[Variant v2](tests/planner-variants/v2-intermediate-releases) adds one instruction
to v1's planner: work through every release between the two versions and, for
each new configuration default, say whether the application keeps the old value
and what adopting it would change. Five runs scored 20, 17, 14, 17 and 17, a mean
of 17.0 against the baseline's 16.6 and v1's 15.4, which is within grader noise of
the baseline. R14 rose to 4/5 actionable, R09 to 3/5 and R23 to 4/5; R20 recovered
only to 2/5. The median run took 16.5 minutes and $3.10, slower and costlier than
the baseline's 13.0 minutes and $2.90. No plan fully specified any validation. The
[v2 record](tests/results/20261013-headless/v2-intermediate-releases-rails/summary.json)
keeps each run's plan, receipt and grade.

**A change summary made planners skip experiments, and recall fell.**
[Variant v3](tests/planner-variants/v3-change-summary) adds `bin/gem-changes` to v2.
The script reads the changelogs of every intermediate release of the gem and its
lockstep components, lists new framework defaults with the application's current
settings, and matches changelog entries to the application code that uses them.
The planner prompt says to run it first and use it as a checklist "rather than
rediscovering" changes. Five runs scored 13, 13, 10, 7 and 13 at a median of 5.6
minutes and $1.71. Three planners never upgraded a disposable copy; they made 8
to 37 tool calls, against 61 to 83 in v2. Their plans name removed APIs without
the application's observed failure (partial impact for R01, R02, R14, R16 and
R17) and omit findings that no changelog entry names (R04, R07, R08). Defaults
improved: R20 rose to 4/5 and R23 to 5/5. Gems without packaged changelogs (Pagy)
or with truncated ones (Faraday) get little from the script. The
[v3 record](tests/results/20261013-headless/v3-change-summary-rails/summary.json)
keeps each run's plan, receipt and grade; `scripts/record-batch.ts` now extracts,
grades and records a downloaded batch.

**The summary plus required experiments is the best variant so far.**
[Variant v4](tests/planner-variants/v4-summary-plus-experiments) rewords v3's one
instruction: treat the summary as an index of changes to check, not as the list
of findings, and still upgrade, boot and exercise a disposable copy. Five runs
scored 19, 20, 18, 18 and 17 (mean 18.4; baseline 16.6, v2 17.0) at a median of
11.5 minutes and $2.73 (baseline 13.0 minutes and $2.90). Every planner ran 27 to
36 experiment commands. R02, R20 and R23 were actionable in all five runs; R14
(1/5), R19 (2/5), R21 (0/5) and R25 (0/5) remain weak, and no plan fully specified
any validation. Output tokens are 38% of the cost, cache reads 37% (5.4M tokens
over about 70 turns) and cache writes 26%. The
[v4 record](tests/results/20261013-headless/v4-summary-plus-experiments-rails/summary.json)
keeps each run's plan, receipt and grade.

**Keeping long output in files cut cost by a quarter and recall by three.**
[Variant v5](tests/planner-variants/v5-compact-output) adds one instruction to v4:
write the change summary, bundle output and test logs to files and read only the
needed lines. Five runs scored 15, 15, 14, 16 and 17 (mean 15.4) at a median of
10.5 minutes and $2.09. The losses are almost all partial impact: plans named the
change without the application's consequence for R01, R02, R14, R16 and R19. The
planner prompt asks for affected code, applicability, recommendation and
validation, but never for the consequence. The
[v5 record](tests/results/20261013-headless/v5-compact-output-rails/summary.json)
keeps each run's plan, receipt and grade.

**Asking for each finding's consequence brings Opus low to Opus-high recall.**
[Variant v6](tests/planner-variants/v6-state-consequence) changes one phrase in
v4's planner prompt: each finding now also states what breaks or changes in this
application if nothing is done. Five runs scored 21, 20, 19, 18 and 18 (mean
19.2) at a median of 11.6 minutes and $3.15. Under the same grader, the October
12 Opus-high runs score 19, 18, 15, 18 and 21 (mean 18.2) at about 32 minutes and
$9.60. R14 rose from 1/5 to 5/5 and R01 to 5/5. R21 (0/5, partial
recommendations), R25 (0/5), R09 (2/5) and R19 (3/5) remain weak, and no plan
fully specified any validation. The
[v6 record](tests/results/20261013-headless/v6-state-consequence-rails/summary.json)
keeps each run's plan, receipt and grade.

## Fixture construction established runtime ground truth

Margin Notes is a reading-notebook application with eight implemented features:
private notebooks, rich notes, pagination, CSV import, citation enrichment,
queued exports, reminders and digests, and daily note-count reports.

The fixture was built one feature at a time, then independently verified before
shipping. Compatibility experiments compared the same application scenario on
baseline, upgraded, and repaired versions. Valid legacy behavior was retained in
the baseline rather than repaired in advance.

The frozen baseline uses Ruby 3.3.6, Bundler 2.5.22, Rails 7.0.8.7 with
`load_defaults 7.0`, PostgreSQL, and Redis. Its recorded test result was **46 runs,
325 assertions, zero failures, errors, or skips**, both normally and in CI.
Zeitwerk passed. The system suite contained **zero tests**, so that invocation
does not establish browser coverage. This deliberately old fixture is not a
production deployment template.

The research selected 29 compatibility families: 23 Rails and two each for
Sidekiq, Pagy, and Faraday. Of the Rails families, 17 are direct, five depend on
changed defaults, and one requires mixed versions. These are not 29 unconditional
failures, and they are not planner-evaluation results.

| Evaluation set | Exact upgrade |
| --- | --- |
| Development | Rails 7.0.8.7 → 8.1.0 |
| Development | Sidekiq 6.5.12 → 7.3.9 |
| Additional development smoke | concurrent-ruby 1.3.4 → 1.3.8, retaining Rails 7.0.8.7 |
| Held out | Pagy 8.6.3 → 9.3.5 |
| Held out | Faraday 1.10.4 → 2.12.2 |

Freeze the planner before using held-out feedback. Specify exact targets in
benchmarks: resolving a partial version such as `8.1` to the latest patch would
change the tuple from the researched Rails 8.1.0 target.

## Plugin discovery needed more than a cloned repository

Amp's additional-repository setting supplies the plugin checkout; the app's orb
setup makes its maintenance plugin available to Claude Code. In a sample orb,
the plugin source is:

`/home/user/workspace/repos/claude-plugins/plugins/maintain-rails`

The sample's `.agents/setup` checks for the plugin manifest and symlinks the whole
plugin directory to `$HOME/.claude/skills/maintain-rails`. Linking only the skill
would not register the planner subagent.

A Claude Code 2.1.296 startup check found neither maintenance component before
the link. After linking, it registered `maintain-rails:upgrade-gem`,
`maintain-rails:gem-upgrade-planner`, and the plugin as
`maintain-rails@skills-dir`, while retaining the existing application skills.
This check established discovery, not upgrade-planning quality.

The setup change is published in sample commit
[`9938031`](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa).
It changes only `.agents/setup` relative to frozen application commit
[`468e970`](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/468e97084e809f8613523d0ac1bee6bf69794b4a).
Sample commit `ab732f5` removes this step again, because runs now load the
plugin per session.

## The integrated smoke reached an approval gate

The [integrated smoke-test thread](https://ampcode.com/threads/T-01a1303f-32c7-7074-aa96-c61c143c0a0f)
ran in a fresh sample-project orb using Claude Code mode, model
`claude-opus-5-5`, and high effort. Amp uses the Agent SDK for this mode; the test
was not an Amp agent launching a separate Claude CLI process in the Terminal tab.
Its entire initial prompt was:

> Upgrade the concurrent-ruby gem to 1.3.8

The trace confirms an actual `Skill` invocation of
`maintain-rails:upgrade-gem`, followed by an `Agent` invocation of
`maintain-rails:gem-upgrade-planner`. The installed version and exact Gemfile pin
were 1.3.4. RubyGems listed the requested 1.3.8 release.

The returned plan proposed changing the pin to 1.3.8, running
`bundle lock --update concurrent-ruby --conservative`, and requiring `logger` in
`config/boot.rb` before Rails loads. Fixture experiments had established that
concurrent-ruby 1.3.5+ no longer implicitly loads `logger`, which this Rails 7.0
boot path expects. This is not a universal workaround for every Rails version.

**This smoke does not establish independent discovery of the logger issue.** The
top-level agent supplied it in the subagent handoff. The initial user prompt
contained no hint, but the subagent prompt did. Assess the returned plan
separately from independent discovery and retain the full handoff in future run
records.

The planner reported a disposable-copy trial: without the logger fix, boot failed
with `ActiveSupport::LoggerThreadSafeLevel::Logger`; with it, Zeitwerk and
production boot passed, and tests gave 46 runs, 325 assertions, and zero failures.
It also reported no other gem changes. These are results in the planner's report;
the underlying experiment logs are not exposed in the top-level trace.

The trial briefly ran Sidekiq against Redis inside its own orb and reported no
processed jobs, with possible residual zero-valued counter keys. Fresh orbs
isolate trials from one another; that Redis was not shared across smoke-test
threads. This does not establish that the experiment left no state changes
inside its own orb.

Under the old skill, the top-level agent asked for approval to change the pin and
apply the plan. It reported the working repository unchanged, with nothing
committed or pushed. A follow-up status callback to the parent thread succeeded;
it did not authorize implementation. The run establishes discovery, delegation,
and a returned plan, not a completed upgrade or a planner pass rate.

## The plan-only skill is published

The skill now identifies the gem and requested version, delegates with the gem
and exact current and requested versions, and returns the planner's plan without
implementation. It does not prescribe version-lookup commands. The planner
prompt remains unchanged. A target outside the Gemfile requirement belongs in
the plan as a proposed requirement change; it must not prevent planning while
waiting for permission to edit the Gemfile.

This revision is published in plugin commit
[`873118f`](https://github.com/andreimaxim/claude-plugins/commit/873118fa1a5d4acf1d6cb589b3f00a280e02d837).
Marketplace and plugin validation passed with the existing missing-version
warnings. The previous approval-and-implementation skill is in
[`91dab85`](https://github.com/andreimaxim/claude-plugins/commit/91dab855a85e90533a124c3d5a7098d58452326b).

The [manual smoke cases](tests/planner-smoke.md) define both the exact-pin case and
an inside-constraint control. Five repetitions of the exact-pin case have now
run; the inside-constraint control has not. This record covers work through
October 12, 2026.

For a paired comparison, use one fresh orb per case and skill revision: two
cases × old and new skills = four sessions. Use the same model and effort, the
exact natural prompt, and an unchanged planner prompt. Record the application
and plugin commits, fixture variation, full skill/subagent trace, raw planner
output, final response, and each criterion's result. Record time and cost when
available. That paired comparison has not been performed.

These smokes cover discovery, plan delivery, requirement handling, and unchanged
application files. They do not establish repeatability, comprehensive upgrade
coverage, or held-out performance.

## Five fresh orbs delegated planning without implementing

The existing threads named `Planner smoke 1 of 5` through `Planner smoke 5 of 5`
are a worked example of this architecture. They belong to
`andrei/claude-maintain-rails-sample`, each with its own orb, and their origin
metadata identifies [this evals-project coordinator thread](https://ampcode.com/threads/T-01a13002-554a-7329-95e1-ec31ef9d84d2)
as their parent. Launching, collection, and assessment happened here; the model
runs happened in the app project.

On October 12, 2026, each of those five orbs received exactly:

> Upgrade the concurrent-ruby gem to 1.3.8

The exported thread metadata confirms Claude Code through the Agent SDK,
`claude-opus-5-5`, high effort, and sample commit
[`9938031`](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa).
The plugin skill downloaded from every orb matched the published
[`873118f`](https://github.com/andreimaxim/claude-plugins/commit/873118fa1a5d4acf1d6cb589b3f00a280e02d837)
skill byte for byte. No follow-up instructions or solution hints were sent to
these runs.

| Run | Main-agent actions | Upgrade applied |
| --- | --- | --- |
| [1](https://ampcode.com/threads/T-01a13058-b72d-76af-9ff2-54f1515c41b1) | Skill → version lookup → planner → status/boot-file check → plan | No |
| [2](https://ampcode.com/threads/T-01a13058-c378-70aa-adf2-29f19d1e43ea) | Skill → version lookup → planner → Rails source/boot-file/status check → plan | No |
| [3](https://ampcode.com/threads/T-01a13058-d811-730f-b76c-ab28cb987c45) | Skill → version lookup → planner → plan | No |
| [4](https://ampcode.com/threads/T-01a13058-e286-7322-a416-6bc83af2b888) | Skill → version lookup → planner → status/boot-file check → plan | No |
| [5](https://ampcode.com/threads/T-01a13058-eb5b-7309-8491-17fb7c9bf299) | Skill → version lookup → planner → status/Redis-key check → plan | No |

All five main agents loaded `maintain-rails:upgrade-gem`, looked up the installed
version using `grep -n "concurrent-ruby" Gemfile Gemfile.lock`, and invoked
`maintain-rails:gem-upgrade-planner`. None performed an update or edit. Four ran
read-only checks after planning. Every final response returned a plan, then
offered to implement it; none withheld the plan pending approval.

All five plans proposed changing the exact pin and adding the logger boot fix.
The observed `Gemfile`, `Gemfile.lock`, and `config/boot.rb` in every orb matched
the frozen application checkpoint byte for byte. Four main-agent traces also
show a clean `git status`; run 3 relies on the downloaded files and the planner's
clean-tree report. These SDK threads have no Changes captures, so absent captures
were not treated as evidence of unchanged files.

**None of the five main-agent handoffs contained the logger solution.** Each
supplied the gem, versions, repository path, exact-pin context, and plan-only
scope. Runs 2 and 5 also supplied dependent gems' version constraints. No handoff
mentioned `logger`, `config/boot.rb`, or the boot failure. This differs from the
earlier smoke's hinted handoff, but the batch does not isolate the effect of
removing the lookup paragraph from the other skill changes.

The planners reported experiments in disposable copies. Their underlying
experiment logs were not independently collected here. Runs 4 and 5 reported
writes to Redis inside their own orbs, and run 5's main agent confirmed that
fixture keys remained. Those orbs were isolated from one another; unchanged
application files do not imply zero service-state side effects. Release/security
claims and comprehensive plan correctness were not graded in this batch.

The local audit exports are `.amp/in/artifacts/planner-five-orbs-20261012.json`
and `.amp/in/artifacts/planner-invocations-20261012.json`. They contain the visible
main-agent tool calls, returned reports, final responses, checked file hashes,
and exact planner invocations, without thinking blocks or credential metadata.
They are not committed; the thread links above retain the run records.
