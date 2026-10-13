# Frozen planner benchmark results

All 60 requested attempts are assessed: Opus 5.5/low, Sonnet 5.5/medium and
Haiku 5.5/medium, five repetitions each of Rails, Sidekiq, Pagy and Faraday.
Ten Opus 5.5/high development runs are references, not a matched four-case model.
The plugin and application stayed frozen throughout the comparison.

Start with [per-run outcomes](benchmark-outcomes.csv), their
[JSON equivalent](benchmark-outcomes.json), or
[descriptive statistics](benchmark-statistics.json). The
[cycle record](../../planner-suite-20261012.md) explains the protocol, findings
and prior failed attempts. The [failure ledger](../../planner-failures-20261012.json)
keeps early failures separate from later recovery.

![Final finding recall versus response time for all 70 runs](accuracy-time.png)

The graph uses final finding recall and request-to-last-response time, including
failed workflows. Filled circles indicate full designated-plan delivery, crosses
indicate missing/incomplete plans or implementation, and hollow circles indicate
unverified native delivery. The interactive graph in the coordinator thread lets
readers select every run, including overlapping points, and inspect token footers.

## Read the measurements with their limits

- `raw_actionable` and `final_actionable` count selected findings with supported
  application impact, applicability and repair. The denominator is 23 for Rails
  and two for each other case. This is finding recall, not an overall accuracy,
  safety, validation or readiness score. Errors and unsafe recommendations are
  assessed separately. A missing plan has null recall, not zero.
- `response_wall_time_ms` measures initial request to last evaluated idle state,
  including startup and the parent's retries. It includes missing-plan responses,
  summaries and implementation outcomes. Do not call every response a success.
- `successful_plan_wall_time_ms` is null when full designated-plan delivery is
  absent or unverified. Haiku has seven eligible deliveries among twenty attempts.
  Full delivery may be nonliteral, but a lossy last summary is not a full report.
  Opus-low Faraday2 also has an incomplete last response.
- `reported_planner_tokens` contains the first native handback's usage footer
  when available: 59 of 70 slots. Some Haiku footers describe a status handback.
  These are neither total workflow tokens nor billed usage. Do not sum nested
  footers. Additional footer values remain in the per-run assessments.
- Statistics retain sample sizes, median, range and sample standard deviation.
  They describe these repetitions, not model reliability. Final-content statistics
  include implementation summaries; null no-plan scores are excluded explicitly.
  Eligible full-plan timing statistics have their own smaller sample sizes.

## Find the evidence for a run

The [evidence index](evidence-index.json) maps published files to original sources
and SHA-256 hashes. `saved_trace` in each outcome points to its reviewed visible
trace: original request, main tool inputs/results, all parent responses, final
text, model features and immutable evaluated boundary. Original absolute paths
inside assessments are provenance, not required local dependencies. Locate the
corresponding published file through the index or the directories below.

- `assessments/`: every selected raw/final finding judgment, quoted evidence,
  alternate substantive reports, validation gaps, errors and delivery differences.
- `*-models/` and `*-reports/`: recovered original native metadata and public
  reports. Audit availability does not mean a plan was delivered. Fourteen Haiku
  audits are available, including two planner-bypass runs.
- `sources/`: initial application/plugin revision and prompt-hash audits.
- `early-observations/`: original Haiku snapshots before later spontaneous reports.
- `quota-interrupted/`, `source-drift-excluded/`, `excluded/` and
  `superseded-development/`: earlier attempts outside the frozen benchmark table.
- `collection-refusals/`: six post-evaluation evidence-collection refusals,
  excluded from benchmark inputs, grades and elapsed time.
- `development-research/`: available diagnostic and first-batch trial logs,
  lockfiles and proposed patches. These prove only their named trial variants.
  They are evidence records, not changes integrated into the application.

Six Haiku model audits remain unavailable: Rails4, Sidekiq2/4/5 and Faraday1/5.
The requested configuration does not establish their actual served model.
Nested experiment logs were not generally collected, so claims in plans remain
attributed. The Pagy3 native artifact leaves CLI version unknown despite its
sender's contrary summary.

Full private exports, thinking/signature blocks and account/environment metadata
are excluded. An embedded native dump and literal Basic-auth values were removed
or redacted, preserving transformation reasons and original hashes in the index.
Published hashes describe the filtered files; source hashes describe their
unfiltered predecessors. Redaction does not change grades. The temporary project
pre-setup pin was restored to its previous empty value after the final batch.
