# Planner evaluation cycle, October 12, 2026

This cycle develops the planner on Rails and Sidekiq, then measures the frozen
revision on held-out Pagy and Faraday. Concurrent-ruby smoke controls are outside
this batch. The revised comparison retains ten Opus-high development results
and runs twenty repetitions each on Opus low, Sonnet medium, and Haiku medium.
The first ten development repetitions exposed plan-summary loss and are
superseded by ten fresh repetitions of a delivery correction. The original
80-slot comparison is replaced by 70 slots; no Opus-high held-out batch is added
before switching to Opus low. Extra tuning or failed-run retries remain visible
rather than being counted as fast successful benchmarks.

The delivery-correction batch hit Claude Code's session quota. All ten attempts
are incomplete, with no scored plan or successful wall time. The provider reports
a reset at 17:50 UTC on October 12. After the user reported quota restored,
ten fresh replacement attempts launched at approximately 17:54 UTC, using the
same candidate and protocol. At that point the revised matrix required 93
sessions, including the ten quota-interrupted attempts. Ten later source-drift
attempts bring the planned total to at least 103. The interrupted runs
remain separate from successful results. All ten replacements completed by
18:37:34 UTC. Their original turns and timing are captured and assessed. The user
then requested freezing without another tuning cycle.

## Compare correctness and time on the same frozen revision

The user's latest requested order is:

1. Assess the completed Opus 5.5/high development batch and freeze its revision.
2. Opus 5.5, low effort.
3. Sonnet 5.5, medium effort.
4. Haiku 5.5, medium effort.

Each new configuration runs five fresh repetitions of each of the four exact
cases. Use the same frozen plugin and application for all configurations. Do not
tune the plugin after this freeze, including in response to development feedback.
Complete each configuration before starting the next. Opus high has no held-out
results and is not a four-case matched comparison with the new configurations.

Keep the concurrency schedule the same: ten Rails/Sidekiq workers, then ten
Pagy/Faraday workers per new configuration. The Opus-high reference used ten
concurrent development workers. Launching twenty workers together for a later
configuration would introduce a timing-comparison difference.

Report correctness by case: actionable findings, omissions, incorrect or unsafe
recommendations, validation quality, and whether the delivered final response
preserves the raw plan. Keep workflow failures and incomplete runs visible.
Do not pool unlike findings into an arbitrary weighted correctness score.

Report request-to-final-plan wall time for each run, plus the median and range
for each case/configuration. This includes startup and workflow overhead; report
the planner's own elapsed-time footer separately when available. A progress
message is not the finish timestamp, and an incomplete run is not a fast success.
Keep model, effort, source revisions, timestamps, and completeness status with
each result. Five repetitions describe this sample, not a reliability guarantee.

## Development revisions and launch protocol

The first development revision was plugin
[da946b3](https://github.com/andreimaxim/claude-plugins/commit/da946b38b401d21b139bcc9d87d3303f6d9ca7b7).
It changes the general investigation method and preservation of plan details,
without fixture paths, expected findings, or repair recipes. It was published
after the user approved pushing. The
[diagnostic assessment](planner-development-diagnostic-20261012.md) explains the
observations behind it; those diagnostic outputs used the preceding revision.

The second candidate is
[11b074b](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94).
Only the skill's delivery instruction changes: return the full planner report
verbatim and separate any additional commentary. The planner bytes are unchanged.
This addresses lost impacts, conditions, and repairs in three of the five Rails
final responses. It does not claim to repair remaining raw-plan omissions or
incorrect recommendations. Marketplace/plugin validation passed with the same
existing missing-version warnings. The first ten fresh attempts were interrupted;
all replacements completed and are assessed in the
[second-batch assessment](planner-development-batch2-20261012.md).

The current development repetitions use fresh `andrei/claude-maintain-rails-sample` orbs, application
[9938031](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa),
Claude Code through the Agent SDK, `claude-opus-5-5`, and high effort. The worker
receives only the natural upgrade request. It does not receive this repository,
answer keys, scoring criteria, or follow-up coaching.

Use the [development rubric](planner-development.md) to assess application impact,
applicability, recommendations, and validation separately. Assess the raw planner
report and delivered final response separately. Preserve the actual handoff and
verify loaded plugin bytes; parent-supplied findings are not independent planner
discovery. Saved trial logs are evidence only for the variant they identify, and
proposed checks do not count as executed checks.

Do not modify the plugin during a five-run batch. Assess all ten development
repetitions before freezing the revision and launching held-out runs. Once
held-out feedback is opened, retain that frozen revision for all held-out runs.

## Frozen after assessment, without another tuning cycle

The user requested assessment followed by an unconditional freeze of the current
candidate. Plugin revision
[11b074b](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94)
and application revision
[9938031](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa)
remain unchanged. Both coordinator checkouts are clean. The frozen planner
SHA-256 is `6fb8e6b1df27e475bdd97b3a55c93118c6b763339664812a7d18cce10908b71e`;
the frozen skill SHA-256 is
`bf6aa50a5216265adc52fdd53428af037df779856d7c0d125dfdc288af4bd652`.
The freeze precedes opening any held-out answer key or results.

Native metadata audits report `claude-opus-5-5`, high effort, and Claude Code
2.1.296 for all 27 planner instances in the ten development orbs, including
nested planner delegations. These collection-only follow-ups occurred after the
original turns were saved and are excluded from scored inputs and wall time.
The separate Amp Task graders do not expose their exact model; their conclusions
were checked against quoted evidence, original traces, and application source.

## First development batch is assessed and superseded

The ten runs launched at approximately 15:31 UTC. Their initial prompts are
exactly `Upgrade the rails gem to 8.1.0` and
`Upgrade the sidekiq gem to 7.3.9`, respectively.

| Case | Repetition | Thread | Actionable raw/final | Wall time |
| --- | --- | --- | --- | --- |
| Rails | 1 | [Run](https://ampcode.com/threads/T-01a130bd-5de7-72a2-9dfa-c967c45ac96e) | 22/23 → 5/23 | 35m 00s |
| Rails | 2 | [Run](https://ampcode.com/threads/T-01a130bd-65a9-7478-98cf-64e6e06e4a17) | 19/23 → 8/23 | 34m 29s |
| Rails | 3 | [Run](https://ampcode.com/threads/T-01a130bd-6d6e-7070-8ee0-0788bba8530e) | 20/23 → 20/23 | 44m 56s |
| Rails | 4 | [Run](https://ampcode.com/threads/T-01a130bd-753a-738e-832f-196f344149d2) | 21/23 → 21/23 | 27m 10s |
| Rails | 5 | [Run](https://ampcode.com/threads/T-01a130bd-7f8c-779d-a076-15498db6314f) | 22/23 → 3/23 | 30m 43s |
| Sidekiq | 1 | [Run](https://ampcode.com/threads/T-01a130bd-872b-7442-89f5-bce7bca825f5) | 2/2 → 2/2 | 21m 37s |
| Sidekiq | 2 | [Run](https://ampcode.com/threads/T-01a130bd-92fb-76eb-ba3c-19e4a7a1175a) | 2/2 → 2/2 | 23m 15s |
| Sidekiq | 3 | [Run](https://ampcode.com/threads/T-01a130bd-9b2a-7198-a7dd-28acdab89849) | 2/2 → 2/2 | 14m 00s |
| Sidekiq | 4 | [Run](https://ampcode.com/threads/T-01a130bd-a506-728d-b39c-50add8ca6420) | 2/2 → 2/2 | 21m 43s |
| Sidekiq | 5 | [Run](https://ampcode.com/threads/T-01a130bd-ae55-7649-bb2a-afaeefb77b41) | 2/2 → 2/2 | 20m 42s |

Rails median: 34m 29s, range 27m 10s–44m 56s. Sidekiq median: 21m 37s,
range 14m 00s–23m 15s. All ten delivered completed plans; selected-family
actionability is not an overall correctness pass. The
[assessment](planner-development-batch1-20261012.md) records errors, delivery loss,
validation limits, timing provenance, and the source correction to the grader.

## Delivery correction: five fresh runs per development case

These runs use candidate 11b074b, with the same model, effort, application,
natural prompts, and isolated-worker protocol. Do not combine their correctness
or timing with the superseded batch.

| Case | Repetition | Thread | Assessment | Elapsed until interruption ms |
| --- | --- | --- | --- | ---: |
| Rails | 1 | [Run](https://ampcode.com/threads/T-01a130f5-6041-750d-9ced-cc2a618c0733) | Incomplete: session limit | 577840 |
| Rails | 2 | [Run](https://ampcode.com/threads/T-01a130f5-6838-7475-9d63-3d309e755348) | Incomplete: session limit | 397921 |
| Rails | 3 | [Run](https://ampcode.com/threads/T-01a130f5-70e7-745a-be63-fc60eb6b3f3d) | Incomplete: session limit | 432994 |
| Rails | 4 | [Run](https://ampcode.com/threads/T-01a130f5-7c87-757c-824f-c16f35cd5b4c) | Incomplete: session limit | 408110 |
| Rails | 5 | [Run](https://ampcode.com/threads/T-01a130f5-842f-706e-a063-afa7d7818041) | Incomplete: session limit | 394288 |
| Sidekiq | 1 | [Run](https://ampcode.com/threads/T-01a130f5-8f2a-71fe-b389-31477fa8f168) | Incomplete: session limit | 383152 |
| Sidekiq | 2 | [Run](https://ampcode.com/threads/T-01a130f5-9cff-75de-b5c8-5e4bc03ed9b4) | Incomplete: session limit | 384397 |
| Sidekiq | 3 | [Run](https://ampcode.com/threads/T-01a130f5-a56e-739d-bc1c-f296279d2b3c) | Incomplete: session limit | 378993 |
| Sidekiq | 4 | [Run](https://ampcode.com/threads/T-01a130f5-ad20-7013-a640-06f3c2e211a9) | Incomplete: session limit | 409761 |
| Sidekiq | 5 | [Run](https://ampcode.com/threads/T-01a130f5-b8de-70ab-ae3c-202cc0276102) | Incomplete: session limit | 374840 |

All ten initial application revisions and downloaded plugin bytes match the
intended sources. No final working-file or service-state preservation audit was
performed after interruption. No experiment from these attempts is credited as
a completed check.

Failure metadata, original-turn timestamps, export hashes, and explicit null
correctness/successful-time fields are in
`.amp/in/artifacts/planner-suite-20261012/delivery-attempts.json`. Sidekiq run 5
was initially captured because its tool status was `done`, despite a termination
envelope and partial report. That unscored capture is retained under
`delivery/incomplete/`; it is not a completed benchmark trace. The collector now
rejects recovered partial reports and parent API-error responses. Both new
regression cases failed before the fix; all three test methods pass afterward.
Rechecking the real exports rejects all ten interrupted attempts while accepting
all ten previously completed development reports with unchanged final text and
elapsed time.

## Fresh retry after the quota reset

These are new sample-project orbs, not continuations of interrupted planners.
They use candidate 11b074b, application 9938031, Opus 5.5/high, and the same exact
natural prompts. Preserve the original scored turn before any collection-only
follow-ups. Assess all ten before freezing and opening held-out feedback.

| Case | Repetition | Thread | Actionable raw/final | Wall time |
| --- | --- | --- | --- | --- |
| Rails | 1 | [Run](https://ampcode.com/threads/T-01a13140-02ab-760b-aa0f-025b3f7fd927) | 21/23 → 21/23 | 31m 58s |
| Rails | 2 | [Run](https://ampcode.com/threads/T-01a13140-0bbf-705c-993c-0b3c658428f8) | 20/23 → 20/23 | 28m 21s |
| Rails | 3 | [Run](https://ampcode.com/threads/T-01a13140-14ec-766a-ac70-8c3deed0847f) | 19/23 → 19/23 | 31m 27s |
| Rails | 4 | [Run](https://ampcode.com/threads/T-01a13140-1cd9-7270-ac6a-e959dee2abb8) | 21/23 → 21/23 | 43m 25s |
| Rails | 5 | [Run](https://ampcode.com/threads/T-01a13140-244e-76ba-992b-a6e9d04729c9) | 21/23 → 21/23 | 33m 57s |
| Sidekiq | 1 | [Run](https://ampcode.com/threads/T-01a13140-2d86-7568-b150-4bcca5794937) | 2/2 → 2/2 | 21m 31s |
| Sidekiq | 2 | [Run](https://ampcode.com/threads/T-01a13140-35a6-72ef-8bd4-dcffeab67c1d) | 2/2 → 2/2 | 23m 18s |
| Sidekiq | 3 | [Run](https://ampcode.com/threads/T-01a13140-3cf1-7227-b3f9-4e67e5e0792a) | 2/2 → 2/2 | 21m 55s |
| Sidekiq | 4 | [Run](https://ampcode.com/threads/T-01a13140-4614-70ed-9df8-459c959022e4) | 2/2 → 2/2 | 19m 01s |
| Sidekiq | 5 | [Run](https://ampcode.com/threads/T-01a13140-4e91-720c-b8d2-755cb8acd580) | 2/2 → 2/2 | 18m 39s |

Rails median: 31m 58s, range 28m 21s–43m 25s. Sidekiq median: 21m 31s,
range 18m 39s–23m 18s. Times are rounded from request-to-recorded-idle
milliseconds, not summed across concurrent workers. The full concurrent batch
took 43m 31s from the earliest request to the latest completion.

The collector accepted all ten original turns, with no incomplete attempts.
Each capture preserves the original final response, tool hand-back, timestamps,
and evaluated message boundary before any follow-up. Raw exports and unreviewed
captures remain private. The initial source audit matches the candidate in all
ten orbs; no final full-tree or service-state audit is claimed.

The assessment covers raw and final application impact, applicability, repairs,
validation, errors and delivery. All ten preserve selected-family actionability;
remaining omissions and unsafe claims are recorded, not tuned away. The user
requested freezing this revision and moving directly to Opus low, then Sonnet
medium and Haiku medium. No additional tuning or Opus-high held-out runs follow.

## Opus low: first frozen benchmark batch

Ten fresh sample-project orbs launched at approximately 19:01 UTC, with requested
model `claude-opus-5-5` and low effort. Initial prompts remain exactly the natural
Rails and Sidekiq requests, with no answer-key context. All ten original turns
completed and were captured before any collection-only follow-up. All twenty
raw/final reports are assessed. The coordinator reconciled counts, capture hashes
and 842 exact-quote memberships for the low-effort assessments; none mismatched.

| Case | Repetition | Thread | Actionable raw/final | Wall time | Reported planner tokens |
| --- | --- | --- | --- | --- | ---: |
| Rails | 1 | [Run](https://ampcode.com/threads/T-01a1317d-421e-774f-9075-12cba5e1aa24) | 18/23 → 18/23 | 11m 59s | 45877 |
| Rails | 2 | [Run](https://ampcode.com/threads/T-01a1317d-4e6c-7202-a9d0-f0a79401c306) | 19/23 → 19/23 | 12m 08s | 48659 |
| Rails | 3 | [Run](https://ampcode.com/threads/T-01a1317d-5f32-71ab-8850-773b885f5fda) | 13/23 → 13/23 | 12m 06s | 45817 |
| Rails | 4 | [Run](https://ampcode.com/threads/T-01a1317d-6cc0-73d9-9172-4ac8661e124d) | 16/23 → 16/23 | 11m 18s | 46918 |
| Rails | 5 | [Run](https://ampcode.com/threads/T-01a1317d-7952-766d-b731-75b4bab7176a) | 17/23 → 17/23 | 10m 04s | 45852 |
| Sidekiq | 1 | [Run](https://ampcode.com/threads/T-01a1317d-863c-7031-9b23-8b1185f8ff56) | 2/2 → 2/2 | 6m 52s | 42441 |
| Sidekiq | 2 | [Run](https://ampcode.com/threads/T-01a1317d-8fec-71af-99b0-f3567cd7e3bf) | 2/2 → 2/2 | 8m 54s | 41713 |
| Sidekiq | 3 | [Run](https://ampcode.com/threads/T-01a1317d-97ac-70ec-8689-8ab4d387a7bf) | 2/2 → 2/2 | 7m 30s | 42758 |
| Sidekiq | 4 | [Run](https://ampcode.com/threads/T-01a1317d-9f41-746e-895c-b06303ba492b) | 2/2 → 2/2 | 2m 03s | 44705 |
| Sidekiq | 5 | [Run](https://ampcode.com/threads/T-01a1317d-a879-7479-8a40-77d5c2bed4e3) | 2/2 → 2/2 | 6m 01s | 44183 |

Rails median: 11m 59s, range 10m 04s–12m 08s. Sidekiq median: 6m 52s,
range 2m 03s–8m 54s. Both layers retain selected-family actionability in every
run. These are selected-finding recall counts, not overall accuracy or readiness.
The ten raw/final plans have zero fully specified validation families under the
same strict rubric as the high reference; useful partial checks still count as
partial evidence, not zero testing.

Rails coverage is lower and more variable than the high reference. R25 is never
actionable. Runs 1, 2, 4 and 5 propose an unsafe skip-cache alternative for R09;
run 3 omits R09 and the conditional R20/R21/R23 families. Missing application
impacts recur for removed APIs. Run 5's `rows.all?(&:save)` repair is invalid:
`Import::Row` contains a `note`, so persistence must use `row.note.save`. Run 3
reports accidentally committing in the working application and attempting a
reset; the collected parent check returned an error without output, so exact
restoration is not independently established.

Sidekiq retains 2/2 selected recall, but only run 2 identifies the actual
`connection_pool` 3 scheduler failure and required cap. Run 4 incorrectly excludes
Active Job from strict-argument risk and misses the digest BigDecimal prerequisite.
Run 3 recommends unsafe method-wide cleanup and lockfile-only rollback. Other
plans retain unsafe alternatives despite selecting a safe primary repair. All
five omit old-epoch scheduling and timeout changes. These omissions remain
outside the two selected-family denominator.

The grading records are retained as `opus-low-rails-assessment.json` and
`opus-low-sidekiq-assessment.json` under
`.amp/in/artifacts/planner-suite-20261012/`. Original scored captures remain
private and unchanged. Ten metadata-only follow-ups report 28 planner instances:
nine orbs have a depth-1 → depth-2 → depth-3 self-delegation chain; Sidekiq run 4
has one planner. All recorded assistant models are `claude-opus-5-5`, all recorded
efforts are low, and all CLI versions are 2.1.296. Requested-model fields are
unknown in some audits; lack of an explicit Agent override is not a recorded
request. Follow-up shells report override environment variables unset, not their
original-process state. The JSON audits are retained under `opus-low-models/` in
the same artifact directory. They contain metadata and source hashes, not full
native transcript bodies. Collection does not change scored input or timing.

## Reported token usage and observed run variation

The native `Agent` return footer supplies `subagent_tokens` for each of the
twenty completed reference/low runs. This is reported planner usage, not total
workflow input/output, billed tokens or a sum of nested-agent usage. The usage
definition is not independently audited. Keep it separate from request-to-final
wall time and from model/effort metadata.

| Configuration | Case | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Opus high | Rails | 56198 | 52516 | 57906 | 58436 | 55729 |
| Opus high | Sidekiq | 52277 | 55802 | 53069 | 49504 | 46165 |
| Opus low | Rails | 45877 | 48659 | 45817 | 46918 | 45852 |
| Opus low | Sidekiq | 42441 | 41713 | 42758 | 44705 | 44183 |

| Configuration | Case | Final recall median; range | Wall-time sample SD | Token median; range |
| --- | --- | --- | --- | --- |
| Opus high | Rails | 21/23; 19–21/23 | 5.73 min | 56198; 52516–58436 |
| Opus high | Sidekiq | 2/2; 2/2 | 1.99 min | 52277; 46165–55802 |
| Opus low | Rails | 17/23; 13–19/23 | 0.88 min | 45877; 45817–48659 |
| Opus low | Sidekiq | 2/2; 2/2 | 2.58 min | 42758; 41713–44705 |

Sample standard deviation uses five request-to-final times per group. Ranges
describe observed variation, not confidence intervals or reliability guarantees.
The apparent speed difference includes startup, nested delegations, experiments
and parent checks; this comparison does not isolate inference speed.

## Held-out key opened only after freeze

The exact targets are Pagy 8.6.3 → 9.3.5 and Faraday 1.10.4 → 2.12.2, five fresh
repetitions each. The coordinator recovered the held-out fixture key after the
freeze was recorded and pushed, alongside the Opus-low launch. No held-out run
had launched before the requested pause. The key remains in the coordinator's
evaluation repository, never in worker prompts or files. No plugin changes
follow this exposure.

## Resumed held-out attempts are excluded for source drift

The one-time 3h40m pause expired at 23:02:07.389 UTC. Ten fresh Opus-low orbs
launched at approximately 23:04 UTC with only the natural Pagy/Faraday requests.
The plugin remote had changed during the pause: its `main` now points to
[30cd881](https://github.com/andreimaxim/claude-plugins/commit/30cd881a8d4a0da8d51a2e52d22039c88afd8459),
where `plugins/maintain-rails` is absent. The coordinator's local frozen checkout
remains unchanged. Both frozen prompt downloads from the first new orb failed
because the files are absent. Its natural request therefore did not reach the
frozen planner. Some workers began direct application edits instead.

All ten attempts are excluded, not graded as poor or fast successful planner
runs. Every worker acknowledged the stop and is idle. They report local,
uncommitted application edits; no worker reports a commit or push. Those files
remain in the excluded orbs, not integrated into the coordinator. This is not a
full independent file/service audit. Private exports taken before stop requests
and after acknowledgments are preserved separately from scored traces. At this
point there was no valid Opus-low held-out result; pinned replacements follow.
The ten excluded sessions increase the planned total from 93 to at least 103 if
all remaining slots complete without more failures.

| Case | Repetition | Excluded attempt |
| --- | --- | --- |
| Pagy | 1 | [Run](https://ampcode.com/threads/T-01a1325b-3321-771e-80a2-aae5b63385d4) |
| Pagy | 2 | [Run](https://ampcode.com/threads/T-01a1325b-3bf5-70e6-b94a-5bb82cd0ba54) |
| Pagy | 3 | [Run](https://ampcode.com/threads/T-01a1325b-44cb-7314-a5d0-8e762cc2a3b3) |
| Pagy | 4 | [Run](https://ampcode.com/threads/T-01a1325b-4e6a-745d-bf23-f0a7fb216959) |
| Pagy | 5 | [Run](https://ampcode.com/threads/T-01a1325b-5e44-775c-8c7d-f48d9b59579f) |
| Faraday | 1 | [Run](https://ampcode.com/threads/T-01a1325b-6776-779f-bd72-517d71858d32) |
| Faraday | 2 | [Run](https://ampcode.com/threads/T-01a1325b-7015-71a3-a538-447b0eb67bc6) |
| Faraday | 3 | [Run](https://ampcode.com/threads/T-01a1325b-77d7-731a-94db-6de77d0b8064) |
| Faraday | 4 | [Run](https://ampcode.com/threads/T-01a1325b-80f7-75cb-925d-284d1f7958f4) |
| Faraday | 5 | [Run](https://ampcode.com/threads/T-01a1325b-8b1f-718c-b532-8c730f57e868) |

Recovery requires pinning the worker's plugin checkout before setup and Claude
Code startup, rather than coaching an already-started run. The proposed
[project pre-setup script](frozen-planner-pre-setup.sh) checks out the frozen
application/plugin commits and verifies the prompt hashes, refusing to overwrite
tracked changes. It restored the deleted plugin in disposable local clones,
passed twice, and refused a staged-change negative control without deleting the
file. The user approved applying this temporary shared setting and restoring the
previous empty value after the suite. It was applied on October 13, before the
fresh replacements below, and the project read-back matches the reviewed script
exactly. Plugin/application history and billing/provider settings remain untouched.

## Pinned Opus-low held-out replacements

Ten fresh orbs launched at approximately 05:09 UTC on October 13. They use the
same exact natural prompts, requested Opus 5.5/low, and ten-worker grouping.
Downloaded application/plugin HEADs and both prompt SHA-256 values match the
freeze in all ten orbs. This is a source audit, not an unchanged final working-tree
or service-state audit. The pin changes setup/snapshot identity, so these wall
times include its startup overhead and must not be treated as isolated model
inference times.

| Case | Repetition | Thread | Actionable raw/final | Wall time | Reported planner tokens |
| --- | --- | --- | --- | --- | ---: |
| Pagy | 1 | [Run](https://ampcode.com/threads/T-01a133a9-f053-757c-bf96-4b2f0514dfde) | 0/2 → 0/2 | 5m 42s | 44815 |
| Pagy | 2 | [Run](https://ampcode.com/threads/T-01a133a9-f969-7268-8b8c-aeef78012bbb) | 1/2 → 1/2 | 4m 55s | 44487 |
| Pagy | 3 | [Run](https://ampcode.com/threads/T-01a133aa-01e2-7781-8bf3-0b17f1a2d60d) | 1/2 → 1/2 | 5m 27s | 43753 |
| Pagy | 4 | [Run](https://ampcode.com/threads/T-01a133aa-0e0f-721e-8689-d1e25112b728) | 2/2 → 2/2 | 3m 38s | 42918 |
| Pagy | 5 | [Run](https://ampcode.com/threads/T-01a133aa-17da-74a8-ba42-8155f152d4ec) | 1/2 → 1/2 | 4m 50s | 45572 |
| Faraday | 1 | [Run](https://ampcode.com/threads/T-01a133aa-2102-726a-b427-24c2cd6f6984) | 1/2 → 1/2 | 1m 57s | 46108 |
| Faraday | 2 | [Run](https://ampcode.com/threads/T-01a133aa-2a4d-7294-ba40-6e47232a4bd8) | 0/2 → 0/2 | 3m 04s | 40041 |
| Faraday | 3 | [Run](https://ampcode.com/threads/T-01a133aa-336c-70ab-ae56-f3e7a756e32d) | 1/2 → 1/2 | 7m 52s | 44877 |
| Faraday | 4 | [Run](https://ampcode.com/threads/T-01a133aa-3cc5-70f1-8f13-8594cd1f0536) | 2/2 → 2/2 | 3m 35s | 41835 |
| Faraday | 5 | [Run](https://ampcode.com/threads/T-01a133aa-4489-752f-91b5-dc06c2d2d17d) | 0/2 → 0/2 | 6m 48s | 44847 |

Pagy median: 4m 55s, range 3m 38s–5m 42s; sample time SD 0.80 min. Faraday
median: 3m 35s, range 1m 57s–7m 52s; sample time SD 2.54 min. Both recall
ranges are 0–2/2, with median 1/2. Reported planner token medians are 44487
(42918–45572) and 44847 (40041–46108), respectively. These are native first
Agent-return footers, not total billed usage; Faraday run 2's footer precedes
resumed work and particularly understates the complete workflow.

All ten original turns were collected before metadata follow-ups. Pagy has 5/10
actionable family memberships in each layer: PG1 2/5, PG2 3/5. Every Pagy repair
recipe is valid, but incomplete impact explanations in runs 1–3 and incorrect
blank-page exemptions in runs 1 and 5 prevent full actionability credit. Runs 2,
4 and 5 misdescribe require-only as the silent-drift stage; the remaining reader
failure masks that stage. Preserve these errors separately from recall.

Faraday has 4/10 actionable memberships per layer. Only run 4 fully connects both
registration failures to pre-HTTP failure, pending citation state and fallback
retries. Run 2's native hand-back contains no findings, and its final is a delta
summary after asynchronous reports, not a complete plan. Retain its zero recall
and timing as a workflow/delivery failure, not a fast successful full plan.
Runs 1, 2 and 4 have not established a compatible complete application bundle;
JSON compatibility remains a separate lane prerequisite rather than a third
selected finding. Run 5's claim of immediate permanent failure without retries
is incorrect: unhandled errors enter Sidekiq fallback retries.

Validation is partial, not absent: no raw/final family fully specifies the
strict scenario/control matrix. Collected main-trace log excerpts in Pagy run 2
and Faraday run 2 support limited diagnostic results. Nested experiment paths and
green-suite claims are not independent execution proof. Pagy run 5 and Faraday
run 3 disclose accidental shared-Redis writes and unsafe whole-key cleanup advice.
Faraday run 5 discloses a transient working-checkout edit and restoration. These
workflow failures are separate from recall, and final clean status does not prove
preservation throughout. No worker changes were integrated.

Independent quote/count/hash reconciliation found no mismatches. A targeted
upstream-source check confirms that `faraday-retry` 2.2.1 and 2.4.0 skip a retry
when `Retry-After` exceeds `max_interval`; they do not merely clamp the sleep.
The optional cap advice in runs 1 and 3 omits this retry-policy tradeoff.

Native audits cover 27 planner instances, all served `claude-opus-5-5` at low
effort on CLI 2.1.296. Eight orbs self-delegate through depth 3, Pagy run 4 through
depth 2, and Faraday run 1 has one planner. Faraday run 2 resumes planners during
the original turn. Requested-model fields and the original process environment
remain unknown where not recorded; unset follow-up variables prove neither.
Audit-file main-session timestamps sometimes include pre-follow-up attachment
rows, so benchmark timing still comes only from immutable original exports.

Reviewed assessments, model audits and the 30-row CSV are under
`.amp/in/artifacts/planner-suite-20261012/`; full exports remain private. Opus low
is assessed on all four cases, with no tuning after held-out exposure.

## Sonnet medium: all four cases assessed

Ten fresh sample-project orbs launched at approximately 05:31 UTC on October 13,
requesting `claude-sonnet-5-5` and medium effort. The prompts and concurrency
grouping are unchanged. All ten completed and were assessed before the held-out
launch. Downloaded plugin HEAD/prompt hashes and initial application revisions
match the freeze in every orb. Native audits cover 30 planner instances, all
served Sonnet 5.5/medium on CLI 2.1.296; each orb has a depth-1→2→3 planner chain.

| Case | Repetition | Thread | Actionable raw/final | Wall time | Reported planner tokens |
| --- | --- | --- | --- | --- | ---: |
| Rails | 1 | [Run](https://ampcode.com/threads/T-01a133bd-b6bb-76de-945c-5391d23035e3) | 17/23 → 17/23 | 18m 18s | 51402 |
| Rails | 2 | [Run](https://ampcode.com/threads/T-01a133bd-bfc9-761d-a1f1-18033ab9e5fc) | 18/23 → 18/23 | 22m 52s | 54851 |
| Rails | 3 | [Run](https://ampcode.com/threads/T-01a133bd-c927-76f5-b340-ccefb4b035b0) | 14/23 → 14/23 | 13m 32s | 49146 |
| Rails | 4 | [Run](https://ampcode.com/threads/T-01a133bd-d62c-704f-9a49-3e2091a0282f) | 17/23 → 17/23 | 17m 35s | 50390 |
| Rails | 5 | [Run](https://ampcode.com/threads/T-01a133bd-deab-712c-9d70-c752d06e553b) | 17/23 → 15/23 | 14m 49s | 49336 |
| Sidekiq | 1 | [Run](https://ampcode.com/threads/T-01a133bd-eb33-72f8-a569-f45fc5e4ced4) | 1/2 → 1/2 | 8m 02s | 47766 |
| Sidekiq | 2 | [Run](https://ampcode.com/threads/T-01a133bd-f47c-72ef-ba93-f6efd8743a41) | 1/2 → 1/2 | 6m 50s | 48417 |
| Sidekiq | 3 | [Run](https://ampcode.com/threads/T-01a133bd-fcd6-76b8-a2af-a38b2f7e92e8) | 1/2 → 1/2 | 4m 41s | 46694 |
| Sidekiq | 4 | [Run](https://ampcode.com/threads/T-01a133be-054f-720e-87d6-848f85f740a8) | 1/2 → 1/2 | 12m 32s | 45922 |
| Sidekiq | 5 | [Run](https://ampcode.com/threads/T-01a133be-0e63-74ea-b918-2cbbb717c51d) | 1/2 → 1/2 | 6m 08s | 46523 |

Rails median: 17m 35s, range 13m 32s–22m 52s, sample SD 3.62 min. Final recall
median 17/23, range 14–18/23. Run 5 compresses away the concrete notebook-query
and retry-time failure explanations, losing R04 and R14 actionability during
delivery. R25 remains unactionable throughout; conditional and direct omissions
vary. A genuine extra mixed-version Asuncion time-zone validation risk in run 2
is recorded without increasing selected-family recall. Remaining source, cookie,
job/drain and unsupported-verification claims are retained in the assessment.

Sidekiq median: 6m 50s, range 4m 41s–12m 32s, sample SD 2.99 min. Every raw/final
retains SK2. All SK1 repairs are valid, but their concrete Symbol rejection is not
connected to the queued-row/no-job consequence; outage-orphan discussion does
not establish that separate impact. All five advise unsafe method-wide cleanup;
acknowledging its hazard without requiring an enqueue-only boundary is not a safe
repair. Run 3 incorrectly dismisses the BigDecimal masking prerequisite, uses
target-only test constants before the bump, and omits scheduler-failure impact.
Other runs correctly identify the prerequisite and connection-pool protection.
Unmeasured throughput and universal reverse-payload assurances remain unsupported.

No report fully specifies a validation family under the unchanged strict rubric;
useful partial checks and nested claimed experiments remain separately recorded.
The coordinator reconciled 1054 quote memberships, all counts, capture/export
hashes and wall times, with no mismatches. Reviewed assessments and native audits
are in `.amp/in/artifacts/planner-suite-20261012/`; its CSV now has 40 rows.

Ten Sonnet-medium Pagy/Faraday orbs launched at approximately 06:12 UTC. Their
downloaded plugin HEAD/prompt hashes and initial application revisions all match
the freeze. All ten completed and were assessed before Haiku medium launched.
Native audits cover another 30 planner instances, all served Sonnet 5.5/medium
on CLI 2.1.296, with depth-1→2→3 delegation in every orb.

| Case | Repetition | Thread | Actionable raw/final | Wall time | Reported planner tokens |
| --- | --- | --- | --- | --- | ---: |
| Pagy | 1 | [Run](https://ampcode.com/threads/T-01a133e3-9bbe-760d-98e4-823e861c4a78) | 1/2 → 1/2 | 3m 55s | 44022 |
| Pagy | 2 | [Run](https://ampcode.com/threads/T-01a133e3-a6a7-74fb-aea1-ec027bbd3025) | 1/2 → 1/2 | 3m 30s | 44034 |
| Pagy | 3 | [Run](https://ampcode.com/threads/T-01a133e3-af46-76d8-8c5e-861033293ffb) | 1/2 → 1/2 | 4m 14s | 45534 |
| Pagy | 4 | [Run](https://ampcode.com/threads/T-01a133e3-bb84-749e-bf39-96085b6ac168) | 2/2 → 2/2 | 3m 50s | 44084 |
| Pagy | 5 | [Run](https://ampcode.com/threads/T-01a133e3-c7eb-74ce-8011-b9dd251920db) | 1/2 → 1/2 | 4m 10s | 46982 |
| Faraday | 1 | [Run](https://ampcode.com/threads/T-01a133e3-d3e2-741a-95e7-223471030e7b) | 1/2 → 1/2 | 5m 07s | 45470 |
| Faraday | 2 | [Run](https://ampcode.com/threads/T-01a133e3-de4d-733a-af28-9fa753850acf) | 0/2 → 0/2 | 4m 44s | 42933 |
| Faraday | 3 | [Run](https://ampcode.com/threads/T-01a133e3-e850-718a-9838-354bf6e42d56) | 2/2 → 2/2 | 7m 01s | 46354 |
| Faraday | 4 | [Run](https://ampcode.com/threads/T-01a133e3-f1cc-7633-b6db-fc3f8c6e8977) | 0/2 → 0/2 | 3m 31s | 44082 |
| Faraday | 5 | [Run](https://ampcode.com/threads/T-01a133e3-fc79-7674-ab88-84c10d632af6) | 0/2 → 0/2 | 2m 55s | 44350 |

Pagy median: 3m 55s, range 3m 30s–4m 14s, sample SD 0.29 min. Faraday median:
4m 44s, range 2m 55s–7m 01s, sample SD 1.59 min. Reported planner token medians
are 44084 (44022–46982) and 44350 (42933–46354), respectively; these are first
Agent-return footers, not total workflow or billed usage.

Pagy retains 6/10 actionable family memberships in each layer: all five PG2
normalizations, but only run 4 fully explains PG1. Other runs omit a rendering,
query, default or cap consequence despite valid repairs. Runs 1, 4 and 5
misidentify require-only as silent rendered-list drift and disclose shared Redis
use. Invalid-page contract-abandonment alternatives in runs 2 and 5 do not
preserve baseline behavior. Final responses preserve counts, not exact reports.

Faraday retains 3/10 memberships in each layer. Only run 3 connects both failures
to pending citations and fallback retries; run 1 explains FD2 completely.
Raw run 4 recommends retry 2.x as preparation on Faraday 1, which is incompatible.
Its final removes that constraint but still omits complete application impacts.
Standalone probes in runs 4 and 5 do not establish a bootable application bundle.
Reports of flushing numbered Redis databases in runs 1 and 3 lack independent
evidence of exclusive ownership; no shared-state breach is inferred from that
uncertainty alone.

Every validation family remains partial under the same strict scenario/control
rubric. No nested probe logs were independently collected. The coordinator
reconciled 541 quote memberships, counts, capture/export hashes and wall times
with no mismatches. Reviewed assessments, native audits and the 50-row CSV are
under `.amp/in/artifacts/planner-suite-20261012/`.

## Haiku medium: development batch collecting

Ten fresh Rails/Sidekiq orbs launched at approximately 06:29 UTC on October 13,
requesting `claude-haiku-5-5` and medium effort. All ten source audits match the
frozen application, plugin HEAD and prompt hashes. Several early idle responses
are status messages while nested background agents continue. Preserve these
early exports, but do not count them as fast successful plans. Assess completed
reports and workflow failures before launching held-out cases. No coordinator
coaching or planner tuning follows these results. The temporary project pin
remains active; restore its previous empty value after the suite.
