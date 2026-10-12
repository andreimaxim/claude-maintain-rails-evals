# Planner evaluation cycle, October 12, 2026

This cycle develops the planner on Rails and Sidekiq, then measures the frozen
revision on held-out Pagy and Faraday. Concurrent-ruby smoke controls are outside
this batch. Four model/effort configurations contribute twenty benchmark
repetitions each. The first ten development repetitions exposed plan-summary
loss and are superseded by ten fresh repetitions of a delivery correction.
The current total is 80 benchmark repetitions, ten superseded development runs,
and three initial diagnostics: 93 sessions. Extra tuning or failed-run retries
must remain visible rather than being counted as fast successful benchmarks.

## Compare correctness and time on the same frozen revision

The user requested this order:

1. Opus 5.5, high effort (current cycle).
2. Opus 5.5, low effort.
3. Sonnet 5.5, high effort.
4. Sonnet 5.5, medium effort.

Each configuration runs five fresh repetitions of each of the four exact cases.
Use the same frozen plugin and application for all configurations. Once held-out
feedback is opened, do not tune the plugin between configurations. Complete each
configuration before starting the next.

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
existing missing-version warnings. Its behavioral evaluation is still running.

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

| Case | Repetition | Thread | Assessment |
| --- | --- | --- | --- |
| Rails | 1 | [Run](https://ampcode.com/threads/T-01a130f5-6041-750d-9ced-cc2a618c0733) | Pending |
| Rails | 2 | [Run](https://ampcode.com/threads/T-01a130f5-6838-7475-9d63-3d309e755348) | Pending |
| Rails | 3 | [Run](https://ampcode.com/threads/T-01a130f5-70e7-745a-be63-fc60eb6b3f3d) | Pending |
| Rails | 4 | [Run](https://ampcode.com/threads/T-01a130f5-7c87-757c-824f-c16f35cd5b4c) | Pending |
| Rails | 5 | [Run](https://ampcode.com/threads/T-01a130f5-842f-706e-a063-afa7d7818041) | Pending |
| Sidekiq | 1 | [Run](https://ampcode.com/threads/T-01a130f5-8f2a-71fe-b389-31477fa8f168) | Pending |
| Sidekiq | 2 | [Run](https://ampcode.com/threads/T-01a130f5-9cff-75de-b5c8-5e4bc03ed9b4) | Pending |
| Sidekiq | 3 | [Run](https://ampcode.com/threads/T-01a130f5-a56e-739d-bc1c-f296279d2b3c) | Pending |
| Sidekiq | 4 | [Run](https://ampcode.com/threads/T-01a130f5-ad20-7013-a640-06f3c2e211a9) | Pending |
| Sidekiq | 5 | [Run](https://ampcode.com/threads/T-01a130f5-b8de-70ab-ae3c-202cc0276102) | Pending |

## Held-out results remain unopened

The exact targets are Pagy 8.6.3 → 9.3.5 and Faraday 1.10.4 → 2.12.2, five fresh
repetitions each. No held-out run has launched. The revision is not yet frozen
for held-out evaluation, and benchmark results remain incomplete.
