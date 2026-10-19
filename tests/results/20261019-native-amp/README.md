# Native Amp comparison

The approved Rails matrix is GPT-6.1 Sol and GPT-6 Astra, each at low, medium,
and high effort, with the frozen original planner and v21. Five repetitions per
configuration produce 60 sessions. Each session has its own fresh application
orb. The main and planner threads share that session's orb, not another session's
checkout or services. The bootstrap operator is outside the scored turn.

`threads.json` records the pinned runtime revision and session assignments.
Native `create_thread` launches each independent orb, and the coordinator records
returned IDs after each batch. Unknown creation outcomes need inspection; they
must not be retried blindly. The two rejected plugin-launch attempts created no
worker threads and are retained separately. Amp permits the plugin's local
main/planner delegation, but not new orbs from a plugin tool.

The original prompt uses the plan grader and v21 uses the risk-report grader.
Keep workflow failures, finding coverage, report accuracy, elapsed time, and
usage separate. Dollar estimates use the retained standard API prices, not a
verified provider bill.
Full exports and result archives stay private, outside the committed results.

## Launch and collection

All 60 operators were launched on October 19 against evals revision
[`586f16a`](https://github.com/andreimaxim/claude-maintain-rails-evals/commit/586f16a4510ec56928aa4103ec05fffe4b4a7575).
The manifest has 60 distinct worker IDs and five assignments for each of the
12 model, effort, and prompt combinations. A misspelled project reference was
rejected before thread creation, then corrected; it did not start an extra run.

All 60 result archives have been collected and checked. Their
receipts show the expected planner hash, request, application commit, model, and
effort, with unchanged application files and no collection errors. Native agent
definitions and usage records match the selected models; both agent definitions
also record the selected effort. The per-run `native-audit.json` files retain
those fields and source-export hashes without publishing the full exports.
Each operator ran exactly one session, and all 60 harness results are `done`.
No scored sessions were retried. Verbatim response delivery alone does not
establish full report delivery, as the smoke below explains.

## Results

All 60 sessions are graded, with five repetitions in every row below. Scores
refer to the complete primary report, including the linked artifact when the
planner returned a short summary. Parentheses show the observed range. Time and
cost columns are means per session, not totals.

### Original planner

| Model | Effort | Actionable / 23, mean (range) | Minutes | API-equivalent USD |
| --- | --- | --- | --- | --- |
| Sol | Low | 11.2 (9 to 14) | 5.4 | $0.38 |
| Sol | Medium | 16.0 (13 to 18) | 15.1 | $0.97 |
| Sol | High | 17.2 (13 to 20) | 18.8 | $1.49 |
| Astra | Low | 8.2 (6 to 10) | 4.4 | $2.32 |
| Astra | Medium | 16.2 (13 to 21) | 10.0 | $5.58 |
| Astra | High | 15.4 (14 to 16) | 16.3 | $8.49 |

### v21 risk report

| Model | Effort | Located / 23, mean (range) | Matching levels / 23 | Inaccurate items | Minutes | API-equivalent USD |
| --- | --- | --- | --- | --- | --- | --- |
| Sol | Low | 18.0 (14 to 20) | 12.6 | 0.2 | 6.9 | $0.57 |
| Sol | Medium | 20.4 (20 to 21) | 14.8 | 0.2 | 12.0 | $1.25 |
| Sol | High | 21.0 (20 to 22) | 14.8 | 0.0 | 19.3 | $1.83 |
| Astra | Low | 20.8 (20 to 21) | 15.8 | 0.2 | 7.2 | $4.83 |
| Astra | Medium | 21.0 (21 to 21) | 15.4 | 0.2 | 10.1 | $7.66 |
| Astra | High | 21.0 (20 to 22) | 15.0 | 0.0 | 14.3 | $8.28 |

Sol high has the highest observed original-plan mean, but its range overlaps
the medium configurations. On v21, Sol high and Astra medium/high have the same
mean coverage. Sol medium costs less and averages 0.6 fewer located findings
than Sol high. Astra low is faster than Sol medium and locates slightly more
findings, at about four times the API-equivalent cost. No original or v21 report
scores all 23 on its respective primary metric. Five repetitions of one Rails
upgrade do not establish a general model ranking.

The v21 reports consistently miss application-specific changes despite broad
coverage. The table-name association query (R04) is not located in 29 of 30
reports, and `form_with(model: nil)` (R15) is not located in 28. Risk levels also
disagree with the expected labels for several items across every configuration.
The expected labels are a draft, and some are marked as judgment calls. Scores
use those labels unchanged rather than treating every disagreement as a proven
factual error.

## Assessment method

The original prompt is graded for actionable findings out of 23. A finding must
describe the impact, application-specific applicability, and recommendation.
Validation is recorded separately. The v21 report is graded for located findings,
matching risk levels, and inaccurate accounts, each against 23 labeled changes.
Located findings and actionable findings measure different requirements, so the
two prompt scores are not directly comparable.

Both graders use the existing instructions and answer keys with Claude Opus 5.5
at high effort, with tools disabled. Each text is graded once, except the existing
grader's retry for invalid structured output. Identical texts share a grade within
the same prompt variant. Small text differences can produce grading differences
even when no finding was removed. Grades are model judgments, not a human audit
of every claim or exhaustive measurement of false positives.

Each run retains the planner response, the final response, and any linked Markdown
report or appendix. `artifact-1` is the linked primary plan or risk report in every
run that has one. Otherwise, the primary report is inline in `planner.md`.
Evidence and command appendices are graded separately, but never substituted for
the primary report based on their scores. `assessment.json` records each text's
SHA-256 and source artifact name. `outcomes.json` and `outcomes.csv` identify the
primary layer and retain its score alongside the planner and final scores.
`summary.json` records means, medians, ranges, and sample standard deviations.

## Report delivery

After trimming outer whitespace, 23 final responses contain the exact primary
report inline. Another 31 return the planner's exact reply with its report link.
The six remaining finals retain the report's finding prose, with differences
recorded in `delivery-review.json`. Most differences are closing notes, whitespace,
or link formatting. In `astra-medium-v21-4`, the main thread changed the route
removal citation from the Rails 8.1 changelog to the Rails 7.2 changelog while
keeping the label "Rails 8.1 removal". The original report remains available.

Returning an artifact link is different from returning its full text. File
availability in the collected archive was checked, but opening every original
link as a user was not. A low score for a short link response must not be reported
as the score of the complete linked report. The receipt's verbatim flag checks
whether the final starts with the planner response; the delivery assessment uses
full-text comparisons instead.

## Usage and cost

All 1,753 recorded main and planner assistant requests have input, output, cached
read, and cache creation counters. IDs are scoped by thread before deduplication.
For every request, uncached input plus cached reads plus cache creation equals
total input. All requests are within 272,000 input tokens and have no fast features.
The public `usage.json` files retain only request identity and token counters,
along with standard API-equivalent estimates. They do not expose thinking or
account metadata.

The retained [pricing snapshot](api-pricing.json) comes from OpenAI's API pricing
page on October 19. Per million tokens, Sol input/read/write/output prices are
$2/$0.10/$2.50/$10 and Astra prices are $10/$1/$12.50/$50. Cache creation is a
separate input category, not an extra charge added to the same uncached tokens.
The estimates total $218.23 across the 60 scored sessions. They exclude operators,
grading, orbs, tool charges, and unlogged helpers. The provider billing route is
unverified, so the estimates are not actual spend. Recorded counters are not
evidence that the API pricing route was used.

Elapsed times are harness wall time from dispatch to the final response, including
the main and planner but excluding operator setup, later collection, and grading.
Sessions took 3.2 to 22.0 minutes. Parallel execution can affect latency; the five
repetitions describe this run rather than establish performance on other tasks.

## Sol-medium smoke evidence

The smoke requests contained no solution hints. Each handoff supplied only the
gem, currentVersion, and requestedVersion. The application revision was
[`ab732f5`](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7).

| Session | Request | Time | Application unchanged | Planner response returned verbatim |
| --- | --- | --- | --- | --- |
| [Original patch](https://ampcode.com/threads/T-01a152fc-56c3-768a-97c2-5df4c326a0ee) | concurrent-ruby 1.3.8 | 457 seconds | Yes | Yes |
| [v21 patch, first collector](https://ampcode.com/threads/T-01a152fc-4bd6-76e1-89db-11f86aaaadd0) | concurrent-ruby 1.3.8 | 188 seconds | Yes | Yes |
| [v21 patch, native collector](https://ampcode.com/threads/T-01a15304-3c80-72c8-96d4-cca6a19d17b2) | concurrent-ruby 1.3.8 | 215 seconds | Yes | Yes |
| [Original no-op](https://ampcode.com/threads/T-01a15304-44e8-7108-9115-a0d5cf622ce2) | pagy 8.6.3, already installed | 49 seconds | Yes | Yes |

All configured agents were GPT-6.1 Sol at medium effort. Native usage records
also identify `gpt-6.1-sol`. The original patch planner proposed the exact pin
change and early logger require. The v21 patch report resolved dependencies on a
temporary copy and identified the logger compatibility issue without running the
application. The no-op report recognized the installed version and did not
invent an upgrade.

The original patch planner wrote the substantive plan to a local Markdown
artifact and returned a short summary linking it. Its parent returned that
summary verbatim. Returning the planner's response verbatim therefore does not
establish delivery of the full substantive plan. The runtime now retains generated
artifacts alongside the response so the two layers can be assessed separately.

The first collector used the plugin message API, which returned empty arrays for
local child threads. Private native exports recovered those transcripts. The
revised collector exports native thread data directly and keeps visible text,
calls, results, and usage without thinking or account metadata. The revised v21
smoke retained eight main messages and 20 planner messages, with four main tool
calls and 19 planner tool calls. The no-op retained seven main messages and six
planner messages. Both revised receipts have no collection errors.

The harness was then hardened to make native-export errors invalidate its result,
bound export and dispatch waits, cancel failed children, and refuse duplicate
planner calls. These changes affect failure handling, not the frozen prompts.
The 26 repository tests pass, and the runtime typechecks against the installed
Amp API declarations. Smokes establish operation of the harness, not Rails recall
or equality with Claude Code's tools and system instructions.
