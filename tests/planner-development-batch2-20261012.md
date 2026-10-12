# The delivery correction preserves findings, with correctness gaps remaining

All ten fresh Opus 5.5/high runs completed after the quota reset. Their exact
requests, source revisions, thread links and wall times are in the
[cycle record](planner-suite-20261012.md). The user requested assessment and then
freezing the existing plugin, without another correction or development rerun.

## Each final response retains its actionable findings

| Case | Run | Raw actionable | Final actionable |
| --- | --- | --- | --- |
| Rails | 1 | 21/23 | 21/23 |
| Rails | 2 | 20/23 | 20/23 |
| Rails | 3 | 19/23 | 19/23 |
| Rails | 4 | 21/23 | 21/23 |
| Rails | 5 | 21/23 | 21/23 |
| Sidekiq | 1 | 2/2 | 2/2 |
| Sidekiq | 2 | 2/2 | 2/2 |
| Sidekiq | 3 | 2/2 | 2/2 |
| Sidekiq | 4 | 2/2 | 2/2 |
| Sidekiq | 5 | 2/2 | 2/2 |

Actionability requires supported application impact, applicability and repair,
as defined in the [rubric](planner-development.md). These counts are not overall
correctness passes. Every final preserves the substantive central plan, although
introductions and closing commentary differ; literal whole-report byte identity
is not established. Harness indentation and metadata are excluded from content
comparison. The substantial selected-finding loss seen in the earlier batch is
absent here. These fresh samples do not isolate a causal effect or establish
reliability.

## Rails still omits conditional effects and some direct impacts

No run makes R25 actionable: none states the application's conflicting ETag/date
validator effect and an explicit keep/adopt decision. Runs 1–3 incompletely
explain the implicit Notebook preference coder failure (R20). Run 2 incompletely
explains citation retry impact (R14); run 3 incompletely explains authorized
notebook filtering and removed-secrets impact (R04/R19); run 4 omits R04.

Run 5 recommends "clamp the value, or skip caching once the export is expired".
Clamping is valid, but skipping the cache loses the fixture's stale-indicator
contract, so R09's repair receives partial credit. Run 1's different suggestion,
"pass `expires_in` only while `export.downloadable?`", still reads the fragment
cache and does not bypass an existing cached indicator. The coordinator checked
this distinction against the partial and the stale-indicator controller test.

Other errors remain outside selected-family counts: run 2 gives an incorrect
reason to drain legacy decimal-string jobs before new workers consume them;
run 3 claims prior deprecation of explicit `form_with(model: nil)`; run 4's
summary preparatory count conflicts with its correctly gated YAML-coder detail.
Broad both-direction rollout and all-job rollback claims exceed sampled proof.
Latest-patch/security claims remain unverified. Correct 7.2 BigDecimal onset
under retained 7.0 defaults is accepted, as in the prior adjudication.

## Sidekiq recall is complete, but extra claims are not all safe

All five include the digest BigDecimal prerequisite, Redis error mismatch and
required `connection_pool < 3` scheduler protection. Selected SK1/SK2 repairs
are valid, including portable array or `call("SADD", ...)` integer comparisons.

Runs 1, 3 and 4 explicitly narrow broad cleanup to enqueue. Run 2 recommends
method-wide `StandardError` cleanup despite describing the safer narrow boundary;
it can delete an export after enqueue succeeds if job-ID persistence fails.
Run 5 primarily uses a target-only RedisClient rescue with coupled rollback;
its broader alternative remains hazardous without narrowing.

Runs 1 and 3 misstate the timeout direction: this baseline is 5 seconds and the
target is 3. Runs 2, 3 and 5 omit the later Rails after-commit configuration gate.
Runs 2, 4 and 5 infer halved throughput without load evidence. The old-epoch
scheduling change is identified in runs 1, 3 and 5, but omitted in 2 and 4;
run 5's `>= now` check cannot distinguish erroneously distant future execution.
Run 5's "last 7.x" release claim is contradicted by the published 7.3.10 release.

## Validation remains partial, not zero testing

No raw or final plan completely specifies every scenario and control for any
selected family under the strict rubric. Fully specified validation counts are
therefore 0/23 for each Rails report and 0/2 for each Sidekiq report. Existing
test names, green suites and representative probes still provide partial
evidence. This is not a claim that no checks ran or that suites failed.

Nested experiment outcomes remain model-reported unless the original main trace
contains the actual output. Planner-authored sections claiming parent spot checks
are not independent verification. Finals generally remove or qualify those
sections. Compare with the first batch's equally strict grading, not the earlier
diagnostics' more liberal validation credit.

## Model audits and freeze retain the evaluated workflow

The ten native metadata audits report 27 planner instances, all using
`claude-opus-5-5`, high effort, and Claude Code 2.1.296. Some planners delegate
again to the same planner, so an orb does not represent one isolated model call.
That overhead remains in the recorded request-to-final wall time. The two Amp
Task assessors' exact model is not exposed. The coordinator checked their counts,
quoted evidence, original trace hashes, and material source-based distinctions.

The collected grading JSONs and metadata audits are retained under
`.amp/in/artifacts/planner-suite-20261012/`. Private original-turn exports and
unreviewed full traces are not committed. Collection-only follow-ups do not
change the saved scored turn or its timing.

The frozen plugin is
[11b074b](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94),
with application
[9938031](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa).
No further tuning follows this assessment. The next configurations are Opus low,
Sonnet medium, then Haiku medium, using the same bytes and five fresh repetitions
per case. Opus high remains a development-only reference; no held-out high batch
is added before switching models.
