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

**A thread in the evals project coordinates the evaluation.** Configure Amp
project `andrei/claude-maintain-rails-evals` with this repository as its primary
repository and both `andreimaxim/claude-maintain-rails-sample` and
`andreimaxim/claude-plugins` as additional repositories to clone. Its orb has:

- `/home/user/workspace/repo`: this evals repository, where coordination and
  assessment happen.
- `/home/user/workspace/repos/claude-maintain-rails-sample`: the application
  checkout available to the coordinator.
- `/home/user/workspace/repos/claude-plugins`: the general plugin checkout
  available to the coordinator.

**Each run happens in a dedicated orb in the application's Amp project.** For
Margin Notes, that is `andrei/claude-maintain-rails-sample`, with the sample app
as its primary repository and `andreimaxim/claude-plugins` configured as an
additional repository to clone. Each run's orb has:

- `/home/user/workspace/repo`: the application and the model's working directory.
- `/home/user/workspace/repos/claude-plugins`: the plugin checkout loaded by the
  app's setup, as described below.

The coordinator selects cases, starts run threads, waits for their results,
collects the planner invocations and returned plans, and assesses them here. A
batch with ten concurrent runs uses ten separate app-project orbs, not ten
agents sharing the coordinator's application checkout. Start runs with
`executor: orb`, `agent_mode: external-agent:claude-code`, and features
`model:claude-opus-5-5` and `effort:high`. This runs Claude Code through the Agent
SDK.

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
are running. The [evaluation-cycle record](tests/planner-suite-20261012.md)
tracks those runs and the planned correctness/time comparison: Opus 5.5 high,
Opus 5.5 low, Sonnet 5.5 high, then Sonnet 5.5 medium. Held-out results remain
unopened, and no delivery improvement is claimed before the fresh assessment.

To retain a completed run's visible tool trace and planner response without
thinking blocks or account/environment metadata, keep the full export in a
private temporary directory:

```sh
private_dir=$(mktemp -d)
amp threads export <thread-id> > "$private_dir/thread.json"
python3 tests/collect-planner-trace.py "$private_dir/thread.json" /tmp/planner-trace.json
rm -r "$private_dir"
```

Review tool output for secrets before sharing the trace. The collector requires
an idle thread, a completed planner invocation, and final assistant text. It
does not grade the plan or collect nested experiment logs. Keep the full export
private and remove it after collection.

An async launch acknowledgment is not a completed planner report. If the planner
runs in the background, collect its completed native JSONL transcript privately
and pass `--background-transcript <path>` to the collector. It requires matching
agent identity, a completed final report, and a later parent response. The trace
retains the report and source hash, not the transcript's thinking blocks.

Export and collect the scored turn before sending evidence-recovery follow-ups.
Keep that trace unchanged: later collection messages are not benchmark input or
part of its elapsed time. `wall_time_ms` uses the initial request and recorded
idle-state timestamp, not the start timestamp of a streamed final message.

Check the collector with
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v`.

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
