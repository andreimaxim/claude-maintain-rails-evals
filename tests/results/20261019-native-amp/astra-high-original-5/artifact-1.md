# Margin Notes: Rails 7.0.8.7 → 8.1.0 upgrade assessment

**Recommendation: proceed as a staged compatibility upgrade, not a Gemfile-only update. Keep `config.load_defaults 7.0` initially.** The exact 8.1.0 dependency set resolves, but the unchanged application does not boot, and several existing workflows change semantics even with 7.0 defaults. No application changes have been implemented.

Assessment dated 19 October 2026, against [the inspected application revision](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). Ruby 3.3.6 meets Rails 8.1.0's Ruby ≥3.2 requirement. PostgreSQL, Sidekiq/Redis, Sprockets, importmap, and vendored Trix are the actual stack; this is not a new Rails 8 application.

## Evidence and its limits

- **Inspected:** all application models, controllers, jobs, mailers, relevant views, configuration, schema/migrations, existing tests, and exact-version upstream sources through 7.1, 7.2, 8.0, and 8.1.
- **Executed in isolation:** dependency resolution/install; one unchanged-application target boot; focused framework/API probes reproducing application expressions against disposable PostgreSQL tables; JSON job payload round trips in both version directions; selected default switches. The probes are not a full application test run.
- **Not executed:** full test suite on a repaired application, browser workflows, real Sidekiq processing, production asset compilation, a full rolling deployment/rollback, or inspection of deployed data/secrets/infrastructure.
- **Isolation:** separate disposable databases, test/fake in-process queues, unreachable non-application Redis URL, temporary cache/storage paths. Neither the working application's databases nor its Redis/storage were used. Disposable databases were dropped. No application files, original lockfile, or original secret files were changed.

All commands, variants, dependencies, outputs and SQL logs are retained in [evidence/commands.md](evidence/commands.md). Key results:

| Probe | 7.0.8.7 | 8.1.0 |
|---|---|---|
| Exact Rails pin, other Gemfile constraints unchanged | Original lock | Resolves with Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, Rack 2.2.24 |
| Unchanged app boot | Not run | Fails at `config/initializers/action_text.rb:3`, `nil + tags` |
| Keyword JSON column serializer | **Writes YAML**, reads old JSON as a String | Correct with compatible JSON gem |
| Non-local return after an insert in transaction | Rollback: zero rows | **Commit: one row** |
| Digest request at 2026-10-05 03:30 UTC in New York | Deserializes to October 5, completion String | Deserializes to **October 4**, completion BigDecimal |
| New unmodified digest arguments consumed by old Rails | — | Old consumer raises unknown BigDecimalSerializer |
| New arguments normalized to UTC Time + decimal String | Old consumer succeeds | New consumer succeeds |
| Negative cache TTL | Miss | Entry retained without TTL; raises with 7.1 invalid-expiration default |
| Next-day reminder across US DST end | 09:00 −04:00 | 08:00 −05:00, **same epoch** |

**Dependency-resolution caveat:** today's exact 8.1.0 resolution pulled `json 3.1.0`. Rails 8.1.0 calls `JSON.parse(json, options)` while JSON 3.1.0 requires keyword options. This caused failures reading both JSON tags and jsonb settings. A second experimental lock with only `json < 3` changed resolved JSON to 2.21.2 and removed those failures. Both locks and diagnostic backtraces are retained. Treat this as a tested target-lock constraint, not a claim that every Rails 8.1 release has the issue. Do not silently substitute a different Rails release for the requested target.

## Required compatibility work

Each validation below is **proposed at the application boundary** unless explicitly described as an executed probe. “Works on 7.0” means suitable preparation without first changing Rails; it does not mean these edits have been made or the whole application verified.

### R1. Fix Action Text initialization; retain the complete safe allowlist

**Affected:** [initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), rich-text note rendering and attachments. Rails 7.1 makes `ContentHelper.allowed_tags` nil until explicitly configured. `+=` therefore fails regardless of `load_defaults` (confirmed by full target boot).

**Recommendation:** derive the allowlist from the chosen sanitizer's defaults, preserving `ActionText::Attachment.tag_name`, `figure`, and `figcaption`, then add `details` and `summary`. Do not replace nil with an empty array and retain only the two custom tags. For example, the default sanitizer tags plus those five additions is compatible with both tested versions; coordinate initialization with sanitizer selection when adopting HTML5 later.

**7.0 preparation:** yes; allowlist construction was probed on both versions. **Validate:** boot/eager-load in development, test and production; render stored collapsible content, a valid attachment and ordinary links; exclude script, event-handler attributes and javascript URLs. Existing request tests cover much of rendered output, not editor round trips. [Upstream 7.1 change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md).

### R2. Split the two-path route

**Affected:** [routes](file:///home/user/workspace/repo/config/routes.rb#L17-L23): `get "/notes", "/journal", to: "notes#index"`. Rails 8.1 removes multi-path declarations; the probe raises an argument error.

**Recommendation:** two `get` declarations, preserving `notes_path` and `journal_path`, the same controller, and the separate resource routes. **7.0 preparation:** yes. **Validate:** the existing dual-list-path test plus generated helper URLs and POST `/notes`; do not remove bookmarked `/journal`. [Upstream 8.1 removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md).

### R3. Modernize Note's enum and replace the non-column attribute alias

**Affected:** [Note declarations](file:///home/user/workspace/repo/app/models/note.rb#L10-L14). Rails 8.0 removes keyword enum declarations. Rails 7.2 rejects `alias_attribute` targeting a non-column: `color` is a store accessor, not a column.

**Recommendation:** `enum :status, { draft: 0, ready: 1 }, prefix: true`; explicit `highlight_color` reader/writer forwarding to `color`. Keep integer values and `status_ready` scope unchanged. Citation and Export already use the positional enum API.

**7.0 preparation:** yes; both replacements were probed. **Validate:** existing edit request with green highlight and deduplicated tags, reload jsonb `settings`, draft/ready filters and digest selection; invalid color remains rejected. No schema/data migration required. [7.2 AR removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.0 AR removals](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).

### R4. Change tags serializer only at the 7.1 boundary; preserve stored JSON

**Affected:** `Note.serialize :tags, JSON`; `notes.tags` is text with literal `[]` default. Rails 7.2 removes the second positional argument; use `serialize :tags, coder: JSON` from 7.1 onward.

**7.0 preparation: NO.** Executed on 7.0.8.7, that keyword syntax silently chooses YAML: `["Victorian"]` becomes a YAML document, and old JSON is read as a String. Do not deploy it as an apparently harmless preparatory change. Change syntax alongside the 7.1 runtime, or use an explicitly tested temporary version branch only if one source release must run both runtimes.

**Data/rollback:** leave JSON rows as JSON; no bulk reserialization or YAML-to-JSON rewrite is needed. Audit representative raw stored tags, including empty arrays, Unicode and multiple tags. If an erroneous prep release already wrote YAML, inventory and repair those rows separately before rollback; old JSON readers cannot safely read them. **Validate:** old row → new read/write → old read, comparing raw column bytes/format as well as array values. Also constrain the exact target's JSON dependency as described above. [7.0 implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb#L103-L122), [7.1 signature](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

### R5. Make failed CSV imports explicitly roll back

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L61). It saves the Import and preceding valid notes, then exits the transaction with `return false` on an invalid row. Committing non-local returns is opt-in/default-new-app behavior in 7.1 and unconditional in 7.2; keeping 7.0 defaults on 8.1 does not save this contract.

**Recommendation:** raise `ActiveRecord::Rollback` on a failed row, have the transaction return `true` only after every row succeeds, and convert its nil rollback result to `false` outside. Merely raising Rollback and then retaining the unconditional final `true` would misreport success. Keep row errors for preview rendering.

**7.0 preparation:** yes; rollback/result pattern was probed on both. **Data/rollback:** partial imports are durable corruption of this application's all-or-nothing contract, not something reverting the code repairs. **Validate:** successful first row with a new DOI and rich body, invalid second row; zero new Imports, Notes, Citations, rich texts and attachments after request, with correct row errors. Exercise outside an enclosing test transaction too. [7.2 transaction implementation](https://github.com/rails/rails/blob/v7.2.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L613-L650).

### R6. Preserve import receipt identifiers and preview annotations

**Affected:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L70) reads `citation[:id]` though the primary key is `doi`. From 7.2, `read_attribute(:id)` no longer redirects to a custom primary key: the probe returned nil. Use `citation&.doi` (or `.id`) instead.

[Preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L28-L53) calls `annotations.stringify_keys` then looks up integer `row.line`. Rails 8.0 really stringifies integer keys; annotations disappear. Simplest fix: remove the unnecessary `stringify_keys`, keeping the existing integer-keyed annotation map and integer lookups. Changing only the lookup to a String would break 7.0, whose method leaves integer keys intact.

**7.0 preparation:** both recommendations work. **Validate:** existing CSV receipt with nonnumeric mixed-case DOI, absent DOI, and two different annotations at source lines 2 and 4 after a multiline row; literal `<b>` and `&` remain escaped text. These are read-path changes, not data migrations. [7.2 AR removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.0 stringify change](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L47).

### R7. Stop summing strings in Markdown exports

**Affected:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L32-L42). Rails 7.1 removes Active Support's nonnumeric zero-argument `sum` extension; the current call raises TypeError. Use `fragments.join` with no separator, preserving exact Markdown bytes.

**7.0 preparation:** yes, probed. **Queued/stored work:** queued/retried ExportJobs run this method; a failure after progress updates leaves an export working until a successful retry. Existing completed file bytes need no rewrite. **Validate:** existing complete export test with two ordered notes and explicit heading; also empty notebook, cancellation and retry from partial progress. [7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420-L422).

### R8. Replace secrets API and retry name at the correct boundaries

**Affected:** [Citation::Provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L16), `config/secrets.yml`, citation request tests, and [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L1-L13).

- `Rails.application.secrets` is removed in 7.2. Move the environment-backed provider settings to a dedicated configuration loaded through `config_for`/`config.x`, or read the same ENV values directly. Credentials are an alternative, not a requirement to encrypt these environment lookups. Preserve development/test fallback URL/user/password, production missing-config behavior, symbol keys, and exact string values such as `00123` and `sample: value # keep`. Move every test reference/stub too; do not leave unused secrets-only configuration. **Works on 7.0:** yes, these configuration mechanisms exist there; not executed as an app change.
- `wait: :exponentially_longer` is removed in 7.2; use `:polynomially_longer` beginning in 7.1, preserving attempts=3 and jitter/backoff. **Works on 7.0: no**; probe fails when retrying. Do not change to ordinary exponential delay or an arbitrary constant.

**Validate:** existing fresh-process ENV test and loopback provider tests, including two HTTP attempts per Active Job attempt and final visible failure. Test actual scheduled retry timing, not just immediate helper execution. Old queued jobs retain class/record identifiers; the running worker supplies the retry behavior. [7.2 Railties removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63), [7.2 AJ removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L65).

### R9. Pass Time to reminder scheduling; explicitly preserve the intended DST display

**Affected:** [Note#schedule_reminder and #next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L72), reminder preview, and scheduled jobs.

- Rails 7.2 removes numeric `scheduled_at` support; `wait_until: reminder_epoch` eventually fails serialization (`Integer#utc`). Pass `Time.at(reminder_epoch).utc`; **works on 7.0**, same scheduling epoch in both probes. Keep the database bigint and precision.
- Rails 8.1 makes `TimeWithZone#to_time` preserve the named zone, not just a fixed offset, independent of old defaults. The current +86,400 seconds still schedules the **same instant**, but its preview changes from `2026-11-01T09:00:00-04:00` to `08:00:00-05:00`. To preserve the documented/tested fixed-offset preview, explicitly use `at.to_time.getlocal(at.utc_offset) + 86_400` for the reminder time `at`. **Works on 7.0**, probed. Alternatively adopt local-zone display deliberately and update the contract/tests, not by accident. Do not replace elapsed seconds with a calendar-day advance.

**Validate:** exact epoch 1,793,451,617, rescheduling keeps only the replacement active, deleted notes are discarded, one delivery for repeated same job, and DST transitions in both directions. Test preview offset separately from epoch. Existing delayed jobs retain their Redis due scores and reminder_job_id; do not requeue them en masse or regenerate IDs on deploy. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55-L65), [8.1 to_time source](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L499).

### R10. Make digest day and queue argument formats explicit before mixed-version deployment

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L35-L56), `DigestJob`, [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L2-L12). The reservation key uses a UTC date, but mailer selection relies on older deserialization discarding the reader's zone. Rails 7.2 preserves it; new jobs near midnight select a different day's notes and subject while old queued jobs still select UTC.

Rails 7.1 introduces opt-in BigDecimalSerializer; 7.2 makes it the serialization path. Rails 7.0 workers cannot deserialize the new tagged type. The in-memory Active Job test adapter hides the current BigDecimal-to-String JSON conversion. `BigDecimal(params[:completion])` accepts both types in the tested runtimes, so that conversion itself is not a demonstrated mailer error; the wire format and day boundary are the problems.

**Recommendation, safe on 7.0:** enqueue an explicit UTC Time (`requested_at.utc`) and decimal String (`reading_completion.to_s`); normalize the received request time to UTC in the mailer too, so legacy zone-carrying queued jobs obey the same contract. Do not change reservation date/TTL. Consumer-only normalization does not solve old workers rejecting the new BigDecimal tag: normalize the producer before upgrading it.

**Validate:** real JSON round trips plus actual Sidekiq runs with both producer/consumer versions; local October 4 at 23:30 versus UTC October 5 at 03:30, distinct notes on each UTC day, one draft, another reader, nontrivial decimal percentage. Probe confirmed old/new normalized arguments deserialize correctly; full envelope/GlobalID/worker execution remains proposed. **Rollback:** upgrade readers first or normalize all producers before generating incompatible jobs; account for ready, scheduled, retry and dead sets, not just queue length. Never flush Redis, which also holds digest reservations. [7.1 serializer rollout note](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155), [7.2 changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L65).

### R11. Preserve exception-raising test mode

**Affected:** `config/environments/test.rb` sets `action_dispatch.show_exceptions = false`; authorization tests assert raised RecordNotFound. From 7.2 boolean support is removed; target treats false like the default rescue-all mode. Use `:none` beginning in 7.1.

**7.0 preparation: no.** `:none` is truthy in its old API; probes confirm the opposite behavior. **Validate:** foreign notebook/note requests raise in these tests, while separate production-like response checks still return 404 rather than expose exceptions. Keep the existing explicit `active_job.queue_adapter = :test`; 7.2's consistent adapter selection needs no further change here. [Versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md#L100-L102).

## Optional defaults: do not enable all of them with the runtime upgrade

The [exact 8.1.0 load_defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L224-L385) separates these from removals above. Review defaults one at a time.

| Default / condition | App-specific recommendation and 7.0 compatibility | Discriminating validation |
|---|---|---|
| 7.1 `default_column_serializer = nil` | `Notebook.serialize :preferences` otherwise continues using YAML with 7.0 defaults. Before adopting the nil default, declare `coder: YAML` on 7.1+, retaining safe YAML loading and string-keyed export_heading. Do not switch existing text to JSON or enable unsafe YAML. On 7.0 the keyword does not select the coder; the observed YAML behavior is incidental, so defer this declaration to 7.1. | Read old YAML and nil preferences; update heading; old version reads new YAML. No bulk data conversion. |
| 7.1 `raise_on_assign_to_attr_readonly = true` | Notebook form resubmits hidden slug and controller permits it: **even unchanged slug raises** on a persisted record (probed). Stop permitting/resubmitting slug before adoption. This preparation works on 7.0; keep model readonly constraint. | Rename notebook with original slug submitted and with a tampered slug; heading/name save and slug stays unchanged. |
| Invalid cache expiration, changed from 7.1 | Exports partial supplies `expires_in: expires_at - Time.current`. Expired exports give negative TTL: target with old defaults drops TTL; new defaults raise. Prefer `expires_at: export.expires_at`, optionally skip caching already-expired indicators. Supported on 7.0. This also repairs an observable cache behavior change without adopting defaults. | Enabled caching: before deadline, exactly at it, after it on a cold cache and a hit. Existing test explicitly enables MemoryStore but ordinary tests use NullStore. Keep download authorization/expiry before `stale?`. |
| 7.2 PostgreSQL date decoding | `Notebook#daily_note_counts` currently calls `Date.iso8601(day)` on `select_rows`. New default returns Date, causing TypeError; retained 7.0 defaults leave String (both probed). Use `day.to_date` for either, safe on 7.0. | Asymmetric counts on two UTC dates, including 23:30/00:30 with reader outside UTC; integer counts, dates and newest-first order unchanged. |
| 8.0 HTTP strict freshness | `ExportDownloadsController#stale?` receives ETag and Last-Modified. New default gives If-None-Match precedence. No required app edit; adopt intentionally on 8.x, not as a 7.0 behavior-preserving change. | Matching ETag + older/nonmatching If-Modified-Since: old behavior can be 200, new 304. Mismatched ETag + matching date must return body. Expired or foreign export must never become 304. |
| 7.1 HTML5 sanitization | Applies to rich-text bodies and import HTML, not just new edits. Keep HTML4 initially or deliberately compare before switching. Backend choice/configuration is a 7.1+ step. | Stored malformed/nested markup, links, details/summary, attachments, script/event/URL rejection; compare rendered DOM and plain-text exports. No automatic rewriting of stored HTML. |
| 7.1 cache format, message serialization/metadata | Keep 7.0 cache format and existing message settings until all readers can accept new writes. **7.0 cache format remains supported by 8.1.0**; no mandatory format migration. Rails 7.0 can't be prepared merely by setting 7.1 options. | Bidirectional FileStore payload reads; synthetic then actual session cookie, Active Storage signed URL, and Action Text attachable SGID across old/new and rollback. See rollout section. |

No need to adopt Solid Queue/Cache/Cable, Propshaft, generated authentication, Kamal, or new `params.expect` APIs to satisfy this request. Keep Sprockets directives/importmaps; no asset-pipeline replacement is justified by this code. No application Active Record encryption, SQLite, custom streaming controller, or explicit requires of app-autoloaded files were found. Existing SHA256 key-generation defaults are already enabled by load_defaults 7.0; the older 6.1→7.0 digest migration is not this upgrade.

## Sidekiq is a separate, optional upgrade for this target

Rails 8.1.0's built-in adapter still loads Sidekiq 6.5.12 (probed), but is deprecated for removal in 8.2. The upstream recommendation is Sidekiq ≥7.3.3 to obtain its own adapter. Do not describe this as a Rails 8.1 resolver blocker or simultaneously change queues to Solid Queue.

If upgrading Sidekiq separately, the [versioned Sidekiq guide](https://github.com/sidekiq/sidekiq/blob/v7.3.3/docs/7.0-Upgrade.md) and [Redis adapter](https://github.com/sidekiq/sidekiq/blob/v7.3.3/lib/sidekiq/redis_client_adapter.rb) expose additional application work:

- `Notebook#request_export` sends `{ format: "markdown" }`; Sidekiq 7 strict JSON validation raises. Send string keys instead. This works on current Sidekiq and preserves existing queued JSON arguments; current fake tests JSON-round-trip keys and can obscure the producer issue unless strict validation is enabled.
- `User#request_digest` uses `if redis.sadd(key, id)`. Old redis-rb single-member return is boolean; the new client returns a count. Ruby treats zero as true, permitting repeated digests. Use an explicit integer result contract such as low-level `call("SADD", key, id) == 1` consistently; verify that bridge on both clients before shipping. Avoid `.to_i` on old booleans.
- `rescue Redis::BaseError` in export creation won't catch the new client's `RedisClient::Error`. Adapt the narrow enqueue-failure rescue to the chosen client; a new constant is not safe to reference on the current bundle without that dependency. Ensure failed enqueue removes the saved Export. User's broad StandardError cleanup already differs from this path.
- Verify Redis ≥6.2, concurrency/DB-pool sizing, both client error families during transition, and Active Job wrapper constant compatibility in ready/scheduled/retry/dead payloads. The new adapter source provides a backwards-compatible JobWrapper class; this alone does not prove every queued payload or rollback direction.
- Citation and reminder jobs intentionally enqueue **inside row-lock transactions** so a synchronous enqueue failure rolls back state. Rails 8.1.0's `enqueue_after_transaction_commit` class setting defaults to **false** in inspected source; there is no demonstrated forced change in this target. Rails 7.2 defaults set `:default`, delegating to the adapter (Sidekiq 7.3.3 returns true); retained 7.0 defaults leave `:never`. Preserve immediate enqueue if adopting those intermediate defaults. Do not blindly enable after-commit enqueue: failure could then leave pending citation or scheduled reminder metadata committed without a job. Validate with actual queue failure and independent DB connections, not transaction-wrapped mocks. Class setting API/values differ across versions; use the version's supported form rather than setting it on 7.0.

These are source-based conditional findings. No Sidekiq 7 or real Redis/worker experiment was executed.

## Rich-text editor and stored signatures need their own release gate

`app/views/layouts/application.html.erb` explicitly loads vendored **Trix 1.3.5**; `@rails/actiontext` comes from the upgraded gem. Rails 8.1 adds `action_text-trix ~>2.1.15` (resolved to 2.1.19), but that dependency does **not** replace the explicitly named old script. Request tests cannot establish this JS pairing is compatible.

Recommendation: deliberately choose and browser-test a Trix 2.x/Action Text 8.1 pairing, update the loading path and related assets together, and remove the old vendored bundle only once unused. Do not load both editor runtimes. This is target-stage work; compatibility of Trix 2.x with the current Rails 7.0 JS was not verified, so it is not asserted as safe 7.0 preparation. [8.1 Action Text changes](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

Exercise existing saved links and attachments, adding/removing a file, direct-upload success/failure, size rejection, and edit/save/reopen. Inspect stored HTML/SGIDs after a new-editor save and reopen with rollback assets. The application already documents that editing details/summary through Trix flattens it; do not mislabel that existing limitation as an upgrade regression. No populated browser test suite exists under test/system, so `test:system` alone would not establish coverage.

Before the first 7.1 boot, **copy**, rather than overwrite/regenerate, the local `tmp/development_secret.txt` value to `tmp/local_secret.txt`; the old file exists here. Keep both during the rollback window. The versioned upgrade guide says the filename change invalidates sessions and derived attachment signatures if not preserved. Production key provenance was not inspected: preserve the effective production secret_key_base and stable GlobalID application identity on every web/worker instance. Never print key values.

Stored Action Text bodies contain non-expiring attachable SGIDs, and generated blob links can be long-lived; their compatibility horizon is not the 24-hour Export availability window. New message readers accepting old data does not imply old readers accept new metadata. With 7.1 serialization defaults, retain old writers through the overlap or prove compatible reader rotations first. Reverting defaults does not repair newly stored unreadable signatures. Validate actual old/new saved rich text and blob URLs, not just newly generated same-version tokens. Active Storage still overrides the general AR signed-ID verifier for backwards compatibility in [8.1 source](https://github.com/rails/rails/blob/v8.1.0/activestorage/app/models/active_storage/blob.rb#L120-L130); do not infer a compulsory blob-ID migration from the generic AR signed-ID change.

## Delivery and rollback sequence

1. **Establish isolated baseline and data corpus.** Run existing request/model tests and eager-load check; retain baseline logs. Seed representative old JSON tags, YAML preferences, rich text/attachments, completed/expired/working exports, and delayed/retry jobs. Snapshot database and blob resources together; inventory real queue shapes and oldest scheduled/retry work without disclosing private payloads. Production topology and service versions remain unverified.
2. **Ship safe 7.0 preparation separately:** R1 allowlist, R2 routes, R3 enum/delegation, R5 rollback, R6 receipt/preview, R7 join, R8 provider config, R9 Time input/fixed-offset choice, R10 normalized producer + UTC consumer. Cache/date/slug preparation can also land independently. Keep JSON tags positional, old retry symbol and boolean exception setting until the runtime boundary. Verify each behavior rather than treating syntax acceptance as proof.
3. **Advance one minor line at a time** (7.1 → 7.2 → 8.0 → exact 8.1.0), selecting and pinning the intermediate patches at implementation time; follow the [upstream upgrade sequence](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#the-upgrade-process). On 7.1 change tags to keyword coder, retry name, and exception setting; keep old writer formats/defaults while old consumers remain. Use app:update as a reviewed diff, not blanket replacement of environment/service/storage configuration. Retain generated changelogs/default comparisons per stage.
4. **At target, lock compatible transitive dependencies.** For the tested 8.1.0 resolution constrain JSON <3 (or independently select a verified compatible target lock). Do not fold Sidekiq/Pagy/Faraday/asset-stack upgrades into this change. Resolve deprecations deliberately rather than claiming they are all immediate blockers.
5. **Gate release on actual application execution:** `bundle check`, isolated `zeitwerk:check`, migrations/schema-load and existing tests, then new targeted contract cases above, browser smoke flows, production-mode Sprockets precompile, and real Sidekiq JSON execution with file/test-only mail delivery and loopback citation provider. Upgrade probes are not substitutes for these checks. Confirm PostgreSQL version against adapter support (8.1 requires PostgreSQL ≥9.3); deployment versions are unknown.
6. **Roll out readers/workers before incompatible writers**, or drain/quiesce affected producers and consumers for a coordinated cutover. Delayed reminders may be far in the future; “queue is empty” does not mean old work is gone. Preserve queues, reservations, retry counts, job IDs and due scores; no blanket purge/re-enqueue. Keep immediate enqueue/transaction guarantees until consciously redesigned. Monitor failed imports, enrichment state, expired export pages, duplicate digests and missed reminders.
7. **Rollback gate:** prove new stored rows and new jobs are readable by the chosen rollback release, not only that new code reads old data. Keep schema changes additive and optional defaults off; retain old secrets/assets. Keep JSON tags and YAML preferences in their original formats. Isolate/invalidate only disposable fragment-cache entries if cache formats change—never Redis queue/reservation data. If new serializers/SGIDs have already been written and old readers cannot consume them, stop new producers and drain/translate specifically affected synthetic-validated payload types or roll forward; reverting the gem pin is not sufficient.
8. **Adopt defaults later**, with separate data-format/rollback checks. Schema dumping in 8.1 alphabetizes columns; treat resulting schema.rb ordering changes as dump changes, not evidence that tables must be recreated. Retain historical migration compatibility versions.

## Remaining questions before implementation/release

- What Rails/Sidekiq versions must coexist during deployment and rollback, and for how long? Which scheduled/retry/dead jobs actually exist?
- What are production PostgreSQL/Redis versions, cache store, disk/shared-storage layout, secret provisioning and web/worker deployment order? Repository defaults are not deployment evidence.
- Do saved serialized columns contain values beyond the documented JSON arrays and string-keyed YAML hashes? No production data was examined.
- Is preserving fixed-offset reminder preview the desired contract (as current comments/tests say), or should it intentionally display the reader's DST-adjusted local time?
- Which target Trix version/assets and browser matrix are supported? Real browser, CSRF/session continuity, stored-attachment and mixed-version worker checks remain outstanding.

**Delivery state:** assessment and isolated evidence only. No upgrade, application patch, commit, push, migration of application data, or deployment has been performed.
