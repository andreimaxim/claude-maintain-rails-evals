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
usage separate. Cost is unavailable until the native token records are assessed.
Full exports and result archives stay private, outside the committed results.

## Launch and collection

All 60 operators were launched on October 19 against evals revision
[`586f16a`](https://github.com/andreimaxim/claude-maintain-rails-evals/commit/586f16a4510ec56928aa4103ec05fffe4b4a7575).
The manifest has 60 distinct worker IDs and five assignments for each of the
12 model, effort, and prompt combinations. A misspelled project reference was
rejected before thread creation, then corrected; it did not start an extra run.

As of 07:49 UTC, nine result archives have been collected and checked. Their
receipts show the expected planner hash, request, application commit, model, and
effort, with unchanged application files and no collection errors. Native agent
definitions and usage records match the selected models; both agent definitions
also record the selected effort. The per-run `native-audit.json` files retain
those fields and source-export hashes without publishing the full exports.
These runs are not graded yet. Verbatim response delivery alone does not establish
full substantive-plan delivery, as the smoke below explains.

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
