# Pagy and Faraday held-out planner assessments

This is the coordinator's answer key. It was recovered only after plugin
[11b074b](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94)
was frozen. Do not copy this file, repair recipes or scoring criteria into
application worker orbs. No tuning follows held-out exposure.

Use the same four independent judgments as the
[development rubric](planner-development.md): application impact, applicability,
valid recommendation and discriminating validation. Mark each supported,
partial, missing or incorrect. Actionability requires the first three supported.
Assess raw planner and final response separately, including errors, genuine extra
findings, handoff attribution, delivery and workflow. Proposed checks are not
executed checks; uncollected nested experiments remain model-reported.

| Case | Exact natural prompt | Lane |
| --- | --- | --- |
| Pagy | `Upgrade the pagy gem to 9.3.5` | 8.6.3 → 9.3.5; Rails/other application dependencies retained |
| Faraday | `Upgrade the faraday gem to 2.12.2` | 1.10.4 → 2.12.2; Rails retained; target may add faraday-retry |

## Pagy has two families, not one finding for each rename

| ID | Application impact and applicability | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| PG1 | Initializer requires removed `pagy/extras/items`, so boot fails. Repairing only the require leaves `@pagy.items` in the note-list select, causing rendering failure. Repairing require and reader but retaining `items`, `items_param`, `max_items` silently changes default 10 → 20, ignores `per_page`, loses the 50 cap and changes link vocabulary. | Migrate together to `pagy/extras/limit`, `limit: 10`, `limit_param: :per_page`, `limit_max: 50`, and `@pagy.limit`. Preserve overflow, filtering, owner authorization, order and public URL contract. | Use asymmetric owned/filter-excluded/foreign notes. Page 2 at five displays positions 6–10; follow the actual Next href for 11–15. Check default 10, size 25 last page, requested 500 capped to 50, selection/range, exact retained filter queries, `/journal`, empty search, foreign 404 and anonymous redirect. Successful HTTP status alone misses silent drift. |
| PG2 | The current `pagy(@notes)` relies on Pagy 8 invalid-page normalization. After full PG1 repair, blank, zero, negative and nonnumeric pages return 500 `Pagy::VariableError` on 9, rather than page one. `overflow: :last_page` handles stale positive pages, not these invalid values. | Explicit request-boundary normalization, e.g. `pagy(@notes, page: [params[:page].to_i, 1].max)`. This form is verified on both versions. | Repair PG1 first, then compare all four invalid inputs to page-one content. Include valid first/next/last and stale page 99 controls, filtering and ownership. Verify the preparatory patch on baseline when recommending advance deployment. |

Ground truth used 63 matching notes ordered opposite to insertion IDs, owned
filter-excluded controls and newest foreign notes, with unchanged dataset
checksums across variants. Outcomes were baseline 22/22, unchanged target boot
failure, require-only 3/22, require+reader 4/22, full PG1 18/22, PG1+PG2 22/22,
and baseline+PG2 22/22. Require-only is not the observed silent-drift stage.

Malformed `per_page` values already return 500 on baseline; do not count them as
new Pagy 9 defects. Unoffered valid size 7 rendering with selection 5 is also a
baseline limitation. Normal/CI suites and browser checks passed on baseline and
fully repaired target; zero system tests do not establish browser coverage for
an evaluated planner run.

Primary evidence:
[F3 verification](https://ampcode.com/threads/T-01a12baa-d4d0-7708-bab7-c372714f1754).
Detailed experiments used the F3 feature tree, not a new proof on the final F8
tree. The final fixture plan accepts both families.

## Faraday failures happen before provider I/O

| ID | Application impact and applicability | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| FD1 | `Citation::Provider` uses `request :retry, max: 1, retry_statuses: [503]`. Faraday 2's dependency graph no longer supplies/loads compatible retry middleware. Unregistered retry raises before any provider request, leaving citations pending and falling into Sidekiq retries. This masks FD2. | Add/load compatible `faraday-retry` with the target bump. Verified example is 2.2.1; `Bundler.require` loads `faraday/retry` in this app, so extra explicit require is acceptable but not required. Preserve one GET retry and bounded application attempts. | Real HTTP provider and queue/worker: 503→200 makes exactly two requests and completes; persistent 503 makes six requests over three attempts and records visible failure with empty scheduled/retry/dead sets; 401 makes one request and fails. Check raw target zero requests/pending/retries and independently isolate FD1 with FD2 repaired. |
| FD2 | The provider uses removed `request :basic_auth, @user, @password`. After FD1 is repaired, registration fails before I/O, leaving pending citations/fallback retries. This is not a provider credential rejection. | `request :authorization, :basic, @user, @password`, preserving environment-backed string credentials and the actual Basic header. Preserve ownership and response validation. | With FD1 repaired, reproduce zero-request registration failure, then inspect actual identical Basic header on successful real HTTP. Use a fresh process with numeric/colon/hash credentials, real wrong-password 401, successful/failed refresh, owner/no-DOI denial and unsafe metadata controls. |

Assess the actual resolved bundle. Fixture resolution selected JSON 3.0.2 and
failed in existing secrets ERB `.to_json` with `unknown keyword: quirks_mode`.
That experiment first constrained `json < 3`, resolving 2.21.2. This is a lane
prerequisite, not FD1/FD2; do not require an incidental resolution if a planner
demonstrates a different compatible bundle. Do not apply Rails-upgrade repairs
or require a Rails upgrade in this Faraday-only lane.

Adding faraday-retry 2.2.1 must be coupled to compatible Faraday: do not call it
an advance patch for a bundle retaining Faraday 1. Equivalent versioned repairs
are acceptable when their dependency and loading contracts are correct.

Fixture proof used corrected F5 baseline/derived worktrees, real Rails server,
PostgreSQL, Redis, Sidekiq and an independent loopback provider. Baseline credential
quoting and stale-snapshot persistence races were corrected before comparisons;
they are not new Faraday regressions. Broken-variant ownership FAIL counters were
rejected harness artifacts: actual foreign requests returned 404 without enqueue.

Other proved controls: imported DOI, duplicate request while pending (one job/
request), shared metadata across readers without foreign-note authorization,
missing DOI, unsafe/incomplete metadata, failed refresh retaining prior metadata,
Redis enqueue failure with rollback/recovery, and stale-loaded-instance behavior.
Browser states were proved in fixture verification, not automatically credited
to evaluated planner reports.

Primary evidence:
[F5 verification](https://ampcode.com/threads/T-01a12bfc-77d3-7317-9ffc-741238ee99af).
The original plan and corrections were recovered from the
[fixture-building thread](https://ampcode.com/threads/T-01a12a2a-b175-7704-8f32-3fdc646d0213).
No new fixture experiments ran during answer-key recovery.
