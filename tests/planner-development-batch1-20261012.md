# The first development batch loses plan details during delivery

All ten Opus 5.5/high development runs completed on October 12, 2026. The
[cycle record](planner-suite-20261012.md) links every run and reports actionable
raw/final findings separately. This batch used plugin
[da946b3](https://github.com/andreimaxim/claude-plugins/commit/da946b38b401d21b139bcc9d87d3303f6d9ca7b7)
and application
[9938031](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa).
The worker prompts were exactly `Upgrade the rails gem to 8.1.0` and
`Upgrade the sidekiq gem to 7.3.9`. No held-out cases were opened.

Five fresh repetitions per case do not establish reliability or an overall
correctness pass. Three initial diagnostics used an earlier plugin; they are
not a matched baseline for these five repetitions.

## Rails summaries remove impacts, conditions, and repairs

Raw Rails actionability was 22, 19, 20, 21, and 22 out of 23 selected families.
Final-response actionability was 5, 8, 20, 21, and 3. A finding counts only when
the plan explains the application impact, correct applicability, and a valid
recommendation. A named code location or a changelog mention alone is not enough.

Examples of substantive delivery loss:

| Run | Raw report | Delivered response | Consequence |
| --- | --- | --- | --- |
| Rails 1 | Full allowlist includes `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details`, and `summary`. | “Build the list from `sanitizer.class.allowed_tags`” | Omits Action Text's attachment additions; not an equivalent safe repair. |
| Rails 2 | `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)` | “`Time.at(...)` … for the next-day reminder” | Drops the original fixed-offset display contract. |
| Rails 5 | `Pass reading_completion.to_s to DigestJob.perform_later` | “a job queued by 8.1 fails on a 7.0 worker” | Keeps the risk but removes the concrete producer repair. |
| Rails 5 | Readonly-slug repair is conditional on new-default adoption. | Slug repair appears under “Needed for safe mixed versions”. | Changes the applicability condition. |

The raw reports also have gaps. R25, the conditional HTTP-freshness keep/adopt
decision, is actionable only in raw run 2 and is lost from its final response.
Runs 2–4 do not fully explain the conditional implicit Notebook preference coder
failure. Run 3 proposes a valid `Time.at` scheduling repair without explaining
the target rejection before enqueue. These are not repaired by verbatim delivery.

Incorrect claims outside selected-family counts remain visible. Run 4 says the
keyword enum “raises on 7.2 and 8.0”; its removal is in 8.0. Run 5 gives an
unsupported five-hour DST display example even though the fixed-offset repair
and unchanged scheduling instant are correct. Broad rollback and all-job
compatibility claims exceed the sampled evidence. Committing a schema dump alone
does not establish an operational rollback boundary.

## Sidekiq finds both selected families but still makes mistakes

Each raw and final Sidekiq plan is actionable for SK1 and SK2: JSON-native export
arguments and duplicate-digest reservation behavior. Every plan also includes the
decimal-string prerequisite for digest enqueueing. Their raw `call("SADD", ...) == 1`
repairs work across both clients; do not reject them as the invalid scalar
`sadd(key, id) == 1` repair described in the rubric.

Material additional findings:

- **Run 3's pool cap is not merely optional.** Its target lockfile resolves
  `connection_pool 3.0.2`. Saved earlier evidence shows that this combination with
  Sidekiq 7.3.9 crashes the scheduler. The repetition's repaired worker tests use
  pool 2.5.5, not the problematic uncapped bundle. Green suites and ordinary-job
  completion do not prove scheduled-job readiness.
- **Runs 2 and 3 give the wrong timeout comparison:** “1 to 3 seconds”. For this
  application's stock settings, redis-rb 4.8.1 supplies 5 seconds and Sidekiq
  7.3.9 sets 3. The target redis-client default of 1 is not the app's baseline.
- **Runs 1 and 4 omit the after-commit configuration gate** in their later Rails
  7.2 claims. With retained `load_defaults 7.0`, Active Job's `:never` setting
  still queues immediately. Sidekiq's adapter preference applies under `:default`.
- **Cleanup needs a narrow boundary.** Run 1 restricts broad exception cleanup to
  enqueue. Runs 2–5 suggest widening the method-level rescue; that also surrounds
  `job_id` persistence after enqueue succeeds. If that persistence fails, the
  repair can delete an export that already has a queued job. This consequence is
  source-based; no failure-injection experiment was run for it.
- **Runs 2, 4, and 5 identify a genuine extra scheduling change:** the target
  adapter interprets old positive epochs below 1,000,000,000 as relative delays.
  The application accepts such values. Absence from the selected key does not
  make this finding false. The exact trial results remain model-reported.

Source references for the disputed claims:
[redis-rb defaults](https://github.com/redis/redis-rb/blob/v4.8.1/lib/redis/client.rb#L10-L19),
[Sidekiq 6 option handling](https://github.com/sidekiq/sidekiq/blob/v6.5.12/lib/sidekiq/redis_connection.rb),
[Sidekiq 7 timeout](https://github.com/sidekiq/sidekiq/blob/v7.3.9/lib/sidekiq/redis_connection.rb#L26-L35),
[Rails 7.2 job default](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/enqueuing.rb#L43-L55),
and [Rails 7.2 enqueue gate](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb#L6-L25).

## A grader's BigDecimal objection was rejected

The independent Rails grader marked repeated “7.2+” BigDecimal onset claims
incorrect because Rails 7.1 already registers `BigDecimalSerializer`. Registration
is not enough: [Rails 7.1's switch defaults false](https://github.com/rails/rails/blob/v7.1.6/activejob/lib/active_job.rb#L51-L57),
and [its serialization path preserves legacy writes](https://github.com/rails/rails/blob/v7.1.6/activejob/lib/active_job/arguments.rb#L104-L115)
under retained 7.0 defaults. Adopting 7.1 defaults or explicitly opting in enables
new writes. [Rails 7.2 removes the legacy branch](https://github.com/rails/rails/blob/v7.2.4/activejob/lib/active_job/arguments.rb#L101-L107).

The plans' 7.2 onset is therefore correct for this retained-default lane. This
correction does not change their selected-family counts: the grader already
credited the actual 8.1 producer → 7.0 consumer direction and recommendation.
The provisional grading JSON's registration-only objection is not an accepted
benchmark finding.

## Timing uses the original scored turn, not collection follow-ups

These are request-to-recorded-idle times, including startup and workflow overhead.
They are not planner-only durations or the concurrent batch's elapsed time.

| Case | Run | Request UTC | Completed UTC | Wall ms | Planner footer ms |
| --- | --- | --- | --- | ---: | ---: |
| Rails | 1 | 15:31:20.241 | 16:06:20.248 | 2100007 | 2023377 |
| Rails | 2 | 15:31:22.181 | 16:05:51.143 | 2068962 | 1989524 |
| Rails | 3 | 15:31:24.204 | 16:16:20.355 | 2696151 | 2604725 |
| Rails | 4 | 15:31:26.274 | 15:58:36.588 | 1630314 | 1549315 |
| Rails | 5 | 15:31:28.801 | 16:02:12.294 | 1843493 | 1774254 |
| Sidekiq | 1 | 15:31:31.512 | 15:53:08.984 | 1297472 | 1226237 |
| Sidekiq | 2 | 15:31:33.838 | 15:54:48.582 | 1394744 | 1320118 |
| Sidekiq | 3 | 15:31:36.512 | 15:45:36.017 | 839505 | 773131 |
| Sidekiq | 4 | 15:31:38.666 | 15:53:21.166 | 1302500 | Unavailable |
| Sidekiq | 5 | 15:31:40.824 | 15:52:23.012 | 1242188 | 1172470 |

## Evidence supports specific variants, not every claimed experiment

The reviewed traces are under `.amp/in/artifacts/planner-suite-20261012/development/`.
They retain the original handoffs and final responses, not private thinking.
Every run's downloaded plugin bytes match da946b3; dependency files matched the
application baseline during planning. Clean git status appears in several parent
spot-checks, but is not a full filesystem or service-state audit. Rails run 2
explicitly reports leftover test databases in its orb's shared PostgreSQL.

Sidekiq run 3's collection-only follow-up recovered all 39 requested trial files,
including the five synthetic-payload logs. The archive SHA-256 is
`23b040bb19dd43a1a32eb9f08914dc9dba58a7fa679ac0e047b6c72893f99d13`.
Inspection found only synthetic example.com records, local passwordless Redis,
and no credentials or environment dumps. No new experiments were run during
collection. Independently inspected repaired suites give **47 runs, 331
assertions, zero failures/errors/skips** on both versions. Saved forward/rollback
logs establish representative queued/scheduled/retry compatibility with pool
2.5.5; manually requeued retries were not observed completing afterward.

The grading retains proposed versus model-reported versus collected checks.
Under a full scenario-and-controls reading of the rubric, the Rails reports have
no completely specified validation family; this does not mean their observed
suites failed. The earlier diagnostic assessment credited existing test names
more liberally. Do not compare those validation totals as an improvement measure.
Use the stricter standard consistently for the forthcoming model comparison.

The delivery-only correction is published in
[11b074b](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94).
Ten fresh development runs will assess it before freezing. They are separate
from this superseded batch; no improvement is claimed until they are assessed.
