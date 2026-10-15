## Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The working tree at `/home/user/workspace/repo` is unchanged (clean at `ab732f5`). All trials ran in disposable copies with their own Postgres cluster (port 55432), Redis (port 56379, one database index per variant), and bundle path.

**Bottom line**

- 8.1.0 does not boot with the current code. I needed about ten edits to boot and run the existing suite with `load_defaults 7.0` kept. `json` must also be pinned below 3.
- Five behavior changes passed the existing suite or failed only in one test. Those are: a partial CSV import is committed, the receipt drops DOIs, the annotation disappears from the import preview, the digest covers the wrong day, and the reminder preview shows a different offset.
- Most boot and runtime repairs also work on 7.0.8.7, so they can ship first. Four changes are cutover-only: `serialize :tags, coder: JSON`, the `:polynomially_longer` retry, `show_exceptions = :none` in test, and the json pin.
- Adopting 8.1 defaults is a separate, larger step. Four defaults break code: `default_column_serializer`, `raise_on_assign_to_attr_readonly`, `raise_on_invalid_cache_expiration_time`, and `postgresql_adapter_decode_dates`.

### Evidence and what was run

- Baseline: 7.0.8.7 suite passes, 46 runs, 325 assertions, 0 failures (`/tmp/mn-exp/base-test.log`).
- **v1**: 8.1.0 with `load_defaults 7.0`. Boot repairs applied one at a time. Final suite: 4 failures, all silent behavior changes (`/tmp/mn-exp/v1-json2-test.log`).
- **v2**: v1 plus repairs for the silent changes. Suite passes, 46 runs, 340 assertions, 0 failures (`/tmp/mn-exp/v2-test.log`). The reminder expectation was updated to the new display.
- **v3**: v2 with `load_defaults 8.1`. Before repair: 3 errors (`/tmp/mn-exp/v3-test.log`). After repair: 46 runs, 340 assertions, 0 failures (`/tmp/mn-exp/v3-repaired-test2.log`).
- **prep**: baseline on 7.0.8.7 with the preparatory subset applied. 46 runs, 316 assertions, 1 failure, which is the intended reminder display change (`/tmp/mn-exp/prep-test3.log`).
- Probe matrix (`/tmp/mn-exp/probes/findings_probe_test.rb`, outputs `probe-base.txt`, `probe-v1.txt`, `probe-v2.txt`, `probe-v3.txt`, `probe-v3-repaired.txt`). Each row below shows observed values.
- Patches: `/tmp/mn-exp/v1-changes.diff`, `v2-changes.diff`, `v3-changes.diff`, `prep-changes.diff`.
- Resolved versions for 8.1 copies: rails and actionpack 8.1.0, sidekiq 6.5.12, redis 4.8.1, pagy 8.6.3, json 2.21.2 (pinned), loofah 2.25.2, nokogiri 1.19.4, rack 2.2.24, puma 5.6.9, minitest 5.27.0. Ruby 3.3.6 from mise, Postgres 15.19.
- Note: the unpinned resolution picked json 3.1.0, which is the cause of R13.

### Required changes: boot and runtime breaks

Preparatory means it works on 7.0.8.7 (verified in `prep`).

| ID | Location | Observed failure | Repair | Works on 7.0? |
|---|---|---|---|---|
| R1 | `config/initializers/action_text.rb:3` | `NoMethodError: undefined method '+' for nil` | Assign the list: `ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + %w[ details summary ] + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]` | Yes |
| R2 | `app/models/note.rb:10` | `ArgumentError: wrong number of arguments (given 0, expected 1..2)` | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes |
| R3 | `app/models/note.rb:12` | `wrong number of arguments (given 2, expected 1)` | `serialize :tags, coder: JSON` | **No**, see M4 |
| R4 | `config/routes.rb:18` | `Wrong number of arguments (expect 1, got 2)` | Split into `get "/notes"` and `get "/journal"` | Yes |
| R5 | `app/models/note.rb:14` | `Note model aliases color, but color is not an attribute` | `alias_method :highlight_color, :color` plus `=` | Yes |
| R6 | `app/models/note.rb:61` | `undefined method 'utc' for an instance of Integer` | `wait_until: Time.at(reminder_epoch)` | Yes |
| R7 | `app/models/citation/provider.rb:13`, citation test helper | `undefined method 'secrets'` | `Rails.application.config_for(:secrets).fetch(:citation_provider)`; the test sets `ENV["CITATION_PROVIDER_URL"]` | Yes (4 of 4 citation tests pass) |
| R8 | `app/models/export.rb:42` | `TypeError: String can't be coerced into Integer` | `fragments.join` | Yes |
| R9 | `app/views/notes/index.html.erb:12` | `Passed nil to the :model argument, expect an object or false` | Drop `model: nil`. The summary did not flag this line. | Yes |
| R10 | `app/controllers/notes_controller.rb:12` | SQL `"notes"."notebooks" = $2`, then 500 | `where(notebook: @notebook)` | Yes |
| R11 | `app/jobs/citation_enrichment_job.rb:7` | `Couldn't determine a delay based on :exponentially_longer` | `wait: :polynomially_longer` (same formula per the 8.1 comment). 7.0 has no such name (source). Proc alternative not tested. | No, cutover-only |
| R12 | `config/environments/test.rb` | `show_exceptions = false` now renders 404; `RecordNotFound expected but nothing was raised` | `config.action_dispatch.show_exceptions = :none` (test only). 7.0 treats it as a boolean (source). | No, cutover-only |
| R13 | `Gemfile` | json 3.1.0 with AS 8.1.0: `wrong number of arguments (given 2, expected 1)` in `json/common.rb:291` during session decode | `gem "json", "~> 2.9"`. Rails v8.1.4 source (fetched upstream) passes `**options`. The exact fixing patch was not identified. | Not needed on 7.0 |

### Silent behavior changes

Each row names the test that fails on v1 and passes with the repair.

| ID | Location | Observed without repair | Repair | Works on 7.0? |
|---|---|---|---|---|
| S1 | `app/models/import.rb:50-60` | Partial import committed. `record_counts` was `[1, 4, 1, 2]`, expected `[0, 3, 0, 1]` (`imports_controller_test.rb:65`). Cause: AR 8.1 commits on a `return` from a transaction block (`within_new_transaction` ensure path). `commit_transaction_on_non_local_return` no longer exists in 8.1 (source), so it cannot restore rollback. The preview template also says "Nothing has been saved" on this path (source). | `raise ActiveRecord::Rollback unless row.note.save` inside the block, then `true`, then `end \|\| false` | Yes |
| S2 | `app/models/import.rb:68` | Receipt CSV `With DOI,` (blank). `citation[:id]` returns nil in 8.1 (runner: base `"10.1000/x"`, 8.1 nil). | `citation&.doi` | Yes |
| S3 | `app/views/imports/preview.html.erb:22` | Annotation row missing. `stringify_keys` now stringifies integer keys, so `annotations[row.line]` is nil. Fails `imports_controller_test.rb:22`. | Drop `.stringify_keys` | Yes |
| S4 | `app/mailers/digest_mailer.rb:8` | Subject `October 04, 2026` (expected `October 05`), and a note updated `2026-10-04 23:30 UTC` is included. Active Job 8.1 keeps the reader's zone; 7.0 deserialized in UTC (runner). This breaks the documented UTC-day rule. | `requested_at = requested_at.utc` in the mailer, which also covers jobs already queued | Yes |
| S5 | `app/models/note.rb:44` | Preview `2026-11-01T09:00:00-04:00` becomes `2026-11-01T08:00:00-05:00`. Instant unchanged (`1793538000`) and postponed display matches the new preview. `TimeWithZone#to_time` is zone-based in 8.1 regardless of `load_defaults` (source). | `reminder_at + 86_400`. This is a product decision because it changes 7.0 display too. | Yes (visible change) |

### Optional default adoption (`load_defaults 8.1`, all at once, in v3)

| ID | Default | Observed effect | Repair (verified in v3) |
|---|---|---|---|
| D1 | 7.1 `default_column_serializer = nil` | Boot fails: `missing keyword: :coder` at `notebook.rb:7` | `serialize :preferences, coder: YAML` (keeps YAML format). Not run on 7.0. |
| D2 | 7.1 `raise_on_assign_to_attr_readonly` | `ActiveRecord::ReadonlyAttributeError: slug` on every settings save, including an unchanged slug (P12) | Remove `:slug` from `notebook_params`, keep the hidden field. Create still derives the slug (`probe-notebook`). Not run on 7.0. |
| D3 | 7.1 `raise_on_invalid_cache_expiration_time` | Exports index 500 after expiry: `Cache expiration time is invalid, cannot be negative` | `expires_in: [export.expires_at - Time.current, 1].max`. `cache_if` also passes but changes the tested stale-indicator read (`exports_controller_test.rb:78`). |
| D4 | 7.2 `postgresql_adapter_decode_dates` | Activity report `TypeError: no implicit conversion of Date into String` | `Date.iso8601(day.to_s)`, which works on both |

Not observed (probe or source evidence):

- `belongs_to_required_validates_foreign_key`: probe P11 identical.
- `strict_freshness`: P9 identical. Rack `ConditionalGet` gives `If-None-Match` priority first (source).
- `enqueue_after_transaction_commit`: P1 and P2 identical. Active Job 8.1 class default is `false` (source). P2 showed the enqueue error rolled back the citation state, which means the enqueue ran inside the transaction.
- `sanitizer_vendor` HTML5: v2 and v3 render the sample identically.
- Message serializer: cookies work both ways (below).
- `escape_json_responses`, relative redirects, unordered finders: no matching usage found by grep. Not executed.
- `X-Download-Options` was dropped from `default_headers` (P10). No code uses it.
- yjit: not measured.

### Non-default change needing a decision: Action Text HTML5 parse

Action Text 8.1 parses with `Nokogiri::HTML5` when available (`action_text.rb:50-56`). This applies even with `load_defaults 7.0`. On save, the stored body changes:

- Base: `<p>Before <figure class="attachment">…</figure> after</p>`
- 8.1: `<p>Before </p><figure class="attachment">…</figure> after<p></p>`

Rendering also changes (P8): output differs from base, but `<details>`/`<summary>` survive. I found no config that keeps the HTML4 parse. Options: accept and document, or add a test for the normalized output before cutover.

### Mixed-version rollout and rollback

- **M1 (digest jobs, source-based, not executed).** 8.1 writes `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer"}` and adds `time_zone` to the time argument. Captured payloads are in `/tmp/mn-exp/xver/jobs-v3/digest.json` and `/tmp/mn-exp/xver/jobs-base/digest.json`. Active Job 7.0 raises `ArgumentError: Serializer … is not known` for unknown serializer names (`serializers.rb:43`). Proposed preparatory change: pass `reading_completion.to_s("F")` and `requested_at.utc` so payloads hold only strings and UTC times. This works on 7.0 but is unverified.
- **M2 (reminder jobs).** 8.1 writes `scheduled_at` into the payload. Base payloads have none, since the schedule sits in Sidekiq. Cross-read unverified.
- **M3 (session cookies, executed).** A cookie written by base and read by v3 returns 200. A v3 cookie read by base returns 200. A base cookie read by v2 returns 200. Logs: `/tmp/mn-exp/xver/cookie-*.txt.status`.
- **M4 (tags).** With `coder: JSON` on 7.0, the write stores YAML: `"---\n- alpha\n- beta\n"`, while base stores `["alpha","beta"]`. Reads then fail with `undefined method 'any?' for an instance of String` (12 errors). After cutover, 8.1 with `coder: JSON` writes the same JSON as base. So R3 must not ship before cutover.
- **M5 (schema).** `db:schema:dump` on 8.1 changes the header to `Schema[8.1]`, reorders columns in about 100 lines, and writes `pg_catalog.plpgsql`. Run it as its own commit.
- **M6 (fragment cache).** The 7.1 `cache_format_version` default was not tested across versions. The exports fragment lives at most 24 hours.
- **Rollback.** No migrations are involved, so rollback is code-only. Before rolling back, drain or keep 8.1 workers for the default queue (M1). The rewritten HTML (Action Text section) stays in the database after rollback.

### Phased plan

- **Phase 0, on 7.0.8.7 (ship first):** R2, R4, R5, R6, R7 with its test helper, R8, R9, R10, S1, S2, S3, S4, and the `to_s` in D4 (harmless now). Decide S5 and M1 before shipping. Verified in `prep`: 46 runs, 1 expected failure.
- **Phase 1, cutover to 8.1.0 with `load_defaults 7.0`:** R1, R3 (only at cutover), R11, R12, R13. Verified in v2: 46 runs, 0 failures.
- **Phase 2, default adoption as its own change:** D1 through D4 must land before 7.1 and 7.2 defaults can be enabled. Verified only as one step to 8.1 (v3, repaired). Stepwise adoption was not tested.

### Validation design for each finding

Each validation fails on v1 without the repair and passes with it. Controls stay the same.

- **S1:** `ImportsControllerTest` "invalid rows are shown with their errors, and applying them saves nothing" (`imports_controller_test.rb:48-66`). Data: a CSV whose second row has a blank title and invalid DOI, posted directly to `imports#create`. Asserts counts unchanged. Control: "previews a CSV without saving, then imports every row".
- **S2:** Receipt assertion at `imports_controller_test.rb:45`. Control: the `No DOI,` row stays blank (P5).
- **S3:** `imports_controller_test.rb:22` (`#line_2 dd`). Control: the DOI `dd` still renders.
- **S4:** Digest test subject at `digests_controller_test.rb:33` and probe P3 (`2026-10-04 23:30 UTC` excluded, `2026-10-05 00:30 UTC` included). Control: the second same-day request still reports "already requested".
- **S5:** Preview at `reminders_controller_test.rb:21` and P4 (epoch equality). Control: `reminder_epoch` after postpone is unchanged, and the scheduled job runs at `nine_eastern`.
- **D2:** P12 (update status, tampered slug left unchanged) and the notebook settings test. Control: create and the derived slug.
- **D3:** P6 expired read shows `Expired` with no link. Control: fresh and cached reads show the download link.
- **D4:** P7 counts match base `[[Wed, 02 Sep 2026, 1]]`.
- **R3 tags:** `tags_write_probe.rb` raw value must be JSON, matching base.
- **M1 (proposed):** check the writer payload has no `_aj_serialized` BigDecimal, then run a 7.0 reader on it. Not run.

### Gaps and unverified

- **Cross-version job reader run was denied** by the permission system. I did not retry or work around it. M1 and M2 remain source-based.
- Upgrade guides for 7.1 and 7.2, and each intermediate release note page, were not read individually. I used the installed railties `load_defaults` blocks for 7.1 through 8.1, the 8.1 guide (only the column-order note), the summary's changelog matches, and the 8.0 guide pointer (no content).
- The gem-changes summary omitted all 8.1 defaults, the `form_with(model: nil)` call, and the slug `attr_readonly` path. Its per-file matches were broad. The enum, positional-serialize, and route breaks appear only in its unmatched-removals section.
- Not run: the browser suite (`bin/rails test:system`), production Redis enqueue, Active Storage signed IDs across versions, yjit performance, fragment cache across versions. The 8.1.4 patch was not tested as an alternative to the json pin.
- Probes use fixtures and fixed dates. The DST probe covers one zone.
- Postgres and Redis were stopped at the end. The data directory `/tmp/mn-exp/pgdata` remains for reruns.

### Key files

- Summary: `/tmp/rails-gem-changes.txt`
- Experiment environment: `/tmp/mn-exp/env.sh`, probe runners `/tmp/mn-exp/run_probe.sh` and `/tmp/mn-exp/run_file_probe.sh`
- Probe source: `/tmp/mn-exp/probes/findings_probe_test.rb`, `tags_write_probe.rb`, `semantics.rb`
- Logs: `/tmp/mn-exp/base-test.log`, `v1-dbprep.log` (first boot failure), `v1-json2-test.log`, `v2-test.log`, `v3-test.log`, `v3-repaired-test2.log`, `prep-test3.log`
- Probe outputs: `/tmp/mn-exp/probe-base.txt`, `probe-v1.txt`, `probe-v2.txt`, `probe-v3.txt`, `probe-v3-repaired.txt`
- Cross-version artifacts: `/tmp/mn-exp/xver/`

---

Commentary: The upgrade itself is not implemented. The repository has no changes. Decisions needed before implementation:

1. **S5 (reminder postpone):** Keep the 86,400-second postpone (preserves the current wall-clock display) or accept the new zone-based display?
2. **Action Text HTML5 parse:** Accept the normalized stored HTML and document it, or add a test first?
3. **M1 (digest job payloads):** The cross-version reader check was denied, so the proposed `to_s` and `utc` change for queued digest jobs is still unverified. Do you want me to run that check in a scratch copy with approval?