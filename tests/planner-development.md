# Rails and Sidekiq planner development evaluations

This is the coordinator's answer key. Never copy it, its criteria, or its repair
recipes into an application worker orb. These evaluations measure the returned
upgrade plan, not completion of an upgrade.

## Frozen diagnostic configuration

- Application: [9938031](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/9938031e54e1d7d074f1200a0da17e49390c86fa).
  This adds plugin discovery to the frozen feature baseline
  [468e970](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/468e97084e809f8613523d0ac1bee6bf69794b4a).
- Plugin: [873118f](https://github.com/andreimaxim/claude-plugins/commit/873118fa1a5d4acf1d6cb589b3f00a280e02d837).
- Worker project: `andrei/claude-maintain-rails-sample`; one fresh orb per session,
  with the plugin repository, but without the evals repository.
- Agent: Claude Code through the Agent SDK, `claude-opus-5-5`, high effort.
- Baseline: Ruby 3.3.6, Rails 7.0.8.7 with `load_defaults 7.0`, PostgreSQL,
  Redis server 7, Sidekiq 6.5.12, redis-rb 4.8.1.

Use exactly these initial prompts, without skill hints, expected findings,
formatting instructions, or follow-up coaching:

| Case | Prompt |
| --- | --- |
| Rails | `Upgrade the rails gem to 8.1.0` |
| Sidekiq | `Upgrade the sidekiq gem to 7.3.9` |

The Rails lane initially retains 7.0 defaults and Sidekiq 6. The Sidekiq lane
retains Rails 7.0.8.7. Separate a necessary dependency change from an optional
upgrade. Ruby 3.3.6 already satisfies Rails 8.1's Ruby requirement.

## Assess the plan and the workflow separately

For each finding record four independent fields: **application impact**, **correct
applicability**, **valid recommendation**, and **discriminating validation**.
Mark each field `supported`, `partial`, `missing`, or `incorrect`, with a short
quotation or reference to the returned plan. A finding counts as actionable only
when the first three fields are supported. Report validation separately; proposed
validation is not an observed passing experiment. Do not convert these fields
into an arbitrary weighted score or call a run a pass merely because it lists IDs.

Assess the raw planner response and the parent's final response separately. Record
whether the actual skill and planner were invoked, whether the plan was delivered
without an edit-approval gate, and evidence about working-file preservation. Keep
the full planner handoff: a finding supplied by the parent is not independent
planner discovery. Generic changelog entries without an application connection do
not earn application-impact credit.

Count omissions and incorrect claims separately. Incorrect conditions, unsafe
upgrade order, invalid repairs, unnecessary dependency upgrades, and claims of
verification unsupported by observed logs matter even when recall improves.
Investigate findings outside this selected answer key; absence from the key does
not make them false. Do not reward issue counts or report length.

## Rails: 17 direct findings

"Direct" means no newer-default adoption is required, not that every finding is
an unconditional user-visible crash. Equivalent repairs that preserve the public
contract are acceptable; the listed recipes are verified examples, not required
wording.

| ID | Affected code and impact | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| R01 | `app/models/note.rb`: keyword-style enum declaration no longer loads. | Positional enum declaration with `prefix: true`; preserve values and prefixed helpers/scopes. | Persist different draft/ready notes and exercise status filters and helpers after reload. |
| R02 | `app/models/note.rb`: positional JSON coder in `serialize :tags, JSON` is removed. | Explicit `coder: JSON`, shipped with Rails >=7.1. On 7.0 this syntax silently selects YAML, so it is not a safe advance patch. | Reload existing unequal JSON tags, edit comma-separated input, and verify both stored representation and array values. |
| R03 | `app/models/note.rb`: `alias_attribute :highlight_color, :color` targets a JSON store accessor, not a column. | Forward the reader and writer explicitly to `color`. | Edit highlight color, reload JSON settings, and verify form/error rendering; preserve existing settings. |
| R04 | `app/controllers/notes_controller.rb`: object-valued `where(notebooks: notebook)` produces an invalid column predicate on the authorized joined relation. | Use singular association key `notebook` or an explicit notebook foreign key, retaining owner authorization. | Use unequal notebook populations and another owner; check inclusion, exclusion, and foreign-notebook denial. |
| R05 | `app/models/import.rb`: receipt reads `citation[:id]` although Citation's primary key is DOI, losing receipt DOI values. | Read `citation&.doi` or the actual primary-key attribute. | Apply an import with distinct DOI values and compare downloaded receipt fields to persisted citations. |
| R06 | `app/models/import.rb`: nonlocal return from the transaction commits earlier rows when a later row fails, despite the all-or-nothing error response. | Express rollback explicitly, such as `save!` with `RecordInvalid` handled outside the transaction or `ActiveRecord::Rollback`. | Real apply request with a valid row followed by an invalid row; fresh PostgreSQL counts prove no notes/citations/import survive. Include a successful batch. |
| R07 | `app/models/export.rb`: string `fragments.sum` raises TypeError in the real export worker. | `fragments.join`; leave numeric sums alone. | Real worker completes an export and returns exact ordered Markdown bytes; failed export without repair remains working with no artifact. |
| R08 | `app/views/imports/preview.html.erb`, `app/models/import.rb`: integer source-line annotations are stringified, then looked up by integer, losing annotations. | Remove the conversion or consistently normalize both key creation and lookup. | Unequal annotations at source lines 2 and 4, including a multiline CSV row; preview displays the right literal text without saving. |
| R10 | `app/models/note.rb`: `to_time + 86_400` preserves the named zone on target, changing offset/display across DST but not the instant. | Explicitly keep fixed-offset display or adopt named-zone display and update the documented contract. Do not call it a changed scheduling instant. | Compare epoch, wall-clock time, and offset across a DST boundary plus a non-boundary control. |
| R11 | `app/mailers/digest_mailer.rb`, `app/jobs/digest_job.rb`, `app/models/user.rb`: queued TimeWithZone retains the argument's zone; digest content day can disagree with UTC reservation day near midnight. | Explicitly select UTC/worker zone for the existing UTC-day contract, or consistently change both content and reservation policy. | Real JSON queue/worker with local and UTC dates differing; cross each midnight separately and inspect reservation keys and delivered note membership. |
| R13 | `app/models/note.rb`: numeric `wait_until: reminder_epoch` raises on target before enqueue. | `Time.at(reminder_epoch)`. | Inspect the real scheduled payload/score and persisted schedule time; `perform_now` does not test scheduling. Preserve replacement and ownership controls. |
| R14 | `app/jobs/citation_enrichment_job.rb`: removed `:exponentially_longer` delay breaks bounded ActiveJob retry, falling into Sidekiq retries. | `:polynomially_longer`, with Rails >=7.1 rather than as a 7.0 advance patch. | Persistent provider 503 yields six requests over three attempts and a recorded failure, not endless pending/fallback retries. Include 503->200 and 401 controls. |
| R15 | `app/views/notes/index.html.erb`: explicit `form_with(model: nil, ...)` raises. | Omit the nil model while preserving the unbound GET search form. | Render and submit search/filter form; confirm names, method, and resulting note membership. |
| R16 | `config/routes.rb`: two paths in one `get` declaration prevent route drawing. | Separate declarations preserving `/notes`, `/journal`, and existing helpers. | Draw routes and request both URLs as an owner, with identical authorized list behavior. |
| R17 | `config/environments/test.rb`: boolean `show_exceptions = false` no longer preserves the exception policy. This is a test/runtime configuration effect. | Set `:none` with the upgrade, not on Rails 7.0. | Exercise a raised request exception and missing-record policy, plus normal test and CI eager-loading modes. |
| R18 | `config/initializers/action_text.rb`: inherited `allowed_tags` is nil, so `+=` fails at boot. | Assign a complete safe allowlist including the required excerpt and attachment tags. | Boot, then render details/summary and attachment markup while excluding scripts, handlers, and javascript URLs. Replacing the list with only the added tags is incomplete. |
| R19 | `app/models/citation/provider.rb`, `config/secrets.yml`: removed `Rails.application.secrets` access fails before provider requests. | Migrate config access; verified example uses `config_for(:citation_provider)` through `config.x`. Preserve environment-backed string values. | Fresh-process request with special-character credentials; verify actual Basic header, successful metadata, and bounded failure behavior. Do not expose credentials. |

## Rails: five defaults-dependent findings

The fixture retains `load_defaults 7.0`. Credit these as conditional adoption
risks. Calling them inevitable failures under retained defaults is incorrect.
Each gate was selected independently in an upgraded copy during fixture proof.

| ID | Exact gate | Affected code and impact | Valid recommendation and validation |
| --- | --- | --- | --- |
| R09 | `active_support.raise_on_invalid_cache_expiration_time = true` (7.1) | `app/views/exports/_export.html.erb`: negative cache expiry raises, including on a cache hit. Retained defaults still render 200 Expired with a handled warning. | Clamp expiry to zero. Test before/after deadline, cached and fresh reads, and authoritative download expiry/ownership. A verified `cache_if` alternative broke the stale-link contract. |
| R20 | `active_record.default_column_serializer = nil` (7.1) | `app/models/notebook.rb`: implicit preference coder raises missing `coder`. | Explicit YAML coder preserving existing YAML data; create/edit/reload unequal preferences and export heading with the gate both off and on. |
| R21 | `active_record.raise_on_assign_to_attr_readonly = true` (7.1) | `app/controllers/notebooks_controller.rb`, notebook form/model: ordinary update resubmits readonly slug and raises. | Do not submit/permit slug on updates while preserving creation. Test creation, editable name/heading changes, attempted slug change, and persisted slug. |
| R23 | `active_record.postgresql_adapter_decode_dates = true` (7.2) | `app/models/notebook.rb#daily_note_counts`: raw PostgreSQL date becomes Date; `Date.iso8601(day)` raises for populated reports. | Accept String and Date, e.g. `day.to_date`. Test real PostgreSQL with decoding off/on, asymmetric UTC date counts, empty reports, and ownership. |
| R25 | `action_dispatch.strict_freshness = true` (8.0) | `app/controllers/export_downloads_controller.rb`: matching ETag list plus older If-Modified-Since changes 200-with-bytes to 304. This is intended HTTP precedence. | Make an explicit keep/adopt decision, not an automatic rollback. Test a list containing the matching ETag in both orders, conflicting/nonconflicting validators, expired 302s, and foreign 404s. |

## Rails: one mixed-version finding

| ID | Applicability and impact | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| R12 | `app/models/user.rb`, `app/jobs/digest_job.rb`, `app/mailers/digest_mailer.rb`: only an 8.1 producer -> 7.0 worker fails on unknown BigDecimalSerializer. Both same-version paths and 7.0 -> 8.1 deliver. The existing consumer accepts both String and BigDecimal. | Deliberate decimal-string producer contract or a compatible rollout/drain strategy. Do not manufacture a string-only consumer or predict failure on all-8.1 workers. | Real JSON producer/consumer matrix, both directions and same-version controls, with exact delivered completion percentage. |

## Sidekiq: two selected findings and additional observed risks

| ID | Affected code and impact | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| SK1 | `app/models/notebook.rb#request_export`: Symbol hash key is warned/enqueued by 6, rejected by 7 before enqueue, leaving a queued export without job ID. | JSON-native string key `"format" => "markdown"`; preserve worker decoding. | Real Redis/worker: job ID and completed export, exact Markdown bytes, and queue/row state on rejection. |
| SK2 | `app/models/user.rb#request_digest`: SADD changes Boolean first/duplicate results to integers 1/0; zero is truthy so duplicates enqueue. | Verified cross-version form `sadd(key, [id]) == 1`. Scalar `sadd(key, id) == 1` breaks Sidekiq 6 because its scalar response is Boolean. Target-only integer comparison is acceptable only when its deployment/order constraint is explicit. | Real Redis: first/duplicate request, another reader, another UTC day, and reservation release on enqueue failure. Verify both versions when recommending a preparatory patch. |

Sidekiq 7 also rejects the digest's BigDecimal before enqueue. A decimal-string
producer is the verified prerequisite to expose SK2; omitting it makes the digest
upgrade plan incomplete. This is an additional observed effect, not a third
selected family. Redis-down cleanup also misses `RedisClient::CannotConnectError`
when rescuing `Redis::BaseError`; fixture proof accepted a RedisClient error rescue.
Record it separately rather than increasing selected-family recall. Redis server
7 already satisfies Sidekiq 7's server requirement. Actual proof resolved
redis-client 0.31.0 while retaining redis-rb 4.8.1; do not require that incidental
resolution as a planner finding.

## Provenance and limitations

This key consolidates the original maintainer plan recovered from the archived
[fixture-building thread](https://ampcode.com/threads/T-01a12a2a-b175-7704-8f32-3fdc646d0213)
Changes capture `cap_01a130428ef9714bb946846a29f979bd`, path
`docs/margin-notes-feature-plan.md`, and inspection of the frozen application.
The plan records independent baseline/upgraded/repaired proofs; those experiments
were not rerun while consolidating this key. Their primary evidence is in:

- [F1 verification](https://ampcode.com/threads/T-01a12b69-a0e3-7149-883c-8078e0c8de6a): R01/R04/R15/R16/R17.
- [F2 verification](https://ampcode.com/threads/T-01a12b8b-9eab-70bf-b4e0-f7b317cb27bc): R02/R03/R18/R20/R21; coder-order correction.
- [F4 verification](https://ampcode.com/threads/T-01a12bc5-fdef-77dc-a520-92ba29a9407f): R05/R06/R08; R24 rejected, not part of this key.
- [F5 verification](https://ampcode.com/threads/T-01a12bfc-77d3-7317-9ffc-741238ee99af): R14/R19 and retry-order correction.
- [F6 verification](https://ampcode.com/threads/T-01a12c6d-ba77-768c-8949-038cb0599c10): R07/R09/R25/SK1, cache/default correction, Redis-down observation.
- [F7 verification](https://ampcode.com/threads/T-01a12ceb-9fa2-73fa-812b-976e5f9a6dea): R10/R11/R12/R13/SK2, final UTC-day correction and cross-version SADD repair.
- [F8 verification](https://ampcode.com/threads/T-01a12d7e-8802-75da-95fc-64346acb2c07): R23 with actual PostgreSQL decoding off/on.

Global boot failures mask later findings. Disposable experiments must record
prerequisite patches and dependency resolutions before claiming an independent
reproduction. The recorded Rails proof used a `json < 3` constraint; assess a
planner's resolved bundle rather than assuming this remains necessary in every
resolution. No target repair belongs in the frozen application.

The baseline's recorded result is 46 runs, 325 assertions, zero failures/errors/
skips, in normal and CI modes, with Zeitwerk passing. Its system suite has zero
tests. These results do not establish browser or real-worker coverage for a new
planner run. Model-reported experiments are not independently collected logs.

## Development and held-out sequence

Start with one unchanged diagnostic run per case. Investigate observed omissions
and incorrect claims before changing the planner; a single omission is not a
reliability estimate. Change general investigation behavior, not fixture-specific
issue lists. Run five fresh repetitions per development case on the final revision.
Freeze its exact bytes before opening held-out feedback, then run five repetitions
each for Pagy and Faraday. One improvement cycle totals 22 sessions; extra
diagnostic iterations increase that count. The concurrent-ruby controls are outside
this batch.
