# Margin Notes: Rails 7.0.8.7 → 8.1.0 assessment

## Decision and evidence boundary

**Do not deploy a Gemfile-only upgrade.** There are boot/API incompatibilities and user-visible behavior changes independent of `config.load_defaults`. Use staged 7.1 → 7.2 → 8.0 → 8.1 upgrades, initially retaining `config.load_defaults 7.0`; adopt defaults in separate, reviewed changes.

This is a **source-based assessment**, not an executed compatibility certification. Inspected the application's code, migrations, locked dependencies, configuration and relevant tests, and compared the exact Rails tags v7.0.8.7 and v8.1.0. No app boot, dependency resolution, tests, migrations, workers, database/Redis queries, or browser checks were run. No application files were changed. All validations below remain proposed. Production inventory and real stored/queued data were unavailable. The rolling v8.1 guide currently identifies itself as 8.1.4, so conclusions below use exact-tag source rather than assuming that guide describes precisely 8.1.0.

## Dependency and infrastructure gate

- `Gemfile`, `.ruby-version`, and lockfile specify Ruby 3.3.6: satisfies Rails 8.1.0's Ruby >=3.2 requirement. Keep Ruby fixed during this Rails assessment. No Ruby upgrade is required solely for this target.
- Keep `pg 1.6.0`, Pagy 8.6.3, Faraday 1.10.4, Sprockets/importmap/Turbo/Stimulus initially. No application requirement to adopt Propshaft, Solid Queue, Solid Cache, Solid Cable, or the Rails authentication generator. Rails 8 application-generator defaults do not migrate this app's infrastructure automatically.
- **Do not report a mandatory Sidekiq/Rack conflict:** locked Sidekiq 6.5.12 requires Rack ~>2.0, but Rails 8.1.0 Action Pack requires Rack >=2.2.4, not Rack 3. A Rack-2 resolution is possible at that boundary; `rack-session` and other transitive dependencies still need a real resolution. Puma 5.6.9 and Sidekiq runtime integration remain unverified, not certified compatible from gemspecs alone.
- Rails 8.1 still includes its Sidekiq adapter, but deprecates it for removal in 8.2 and recommends Sidekiq >=7.3.3. A Sidekiq upgrade is separate work, not an automatic prerequisite for 8.1.0. If chosen, examine strict JSON arguments (`Notebook#request_export` passes symbol-keyed options), `Sidekiq.redis` command/results, Redis version requirements, exception classes, and existing queue wrappers. Do not casually change Sidekiq/redis-rb along with Rails and attribute resulting failures to Rails.
- Retain the Minitest 5 constraint and concurrent-ruby pin for the baseline; neither needs removal to achieve the requested outcome. Resolve conservatively in a disposable copy; retain the resulting full lockfile, Bundler version, platform and resolution log. Review new default/bundled gem requirements rather than assuming the current lockfile is sufficient.
- Rails 8.1 Action Text depends on `action_text-trix ~>2.1.15`; this matters to this app's explicit vendored Trix 1.3.5 and gem-provided stylesheet (see below).
- Exact 8.1.0 is assessed here, not endorsed as the latest security-maintained patch. Before production use, separately review applicable advisories and select an approved 8.1 patch if policy requires it.

## Required compatibility work, even with 7.0 defaults

### 1. Action Text allowlist initialization can no longer use `nil += [...]`

**Code:** `config/initializers/action_text.rb`; rich note/import rendering; `app/views/active_storage/blobs/_blob.html.erb`.

7.0 initializes `ActionText::ContentHelper.allowed_tags` with defaults; 8.1 leaves it nil and computes defaults in `sanitizer_allowed_tags`. Existing `allowed_tags += %w[details summary]` therefore fails against the target's unconfigured helper.

**Recommendation:** initialize the override from the effective sanitizer's default tags plus `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details`, and `summary`. Do not set just the two custom tags or discard attachment markup. Arrange initialization after the intended sanitizer is selected when later adopting HTML5 defaults. An explicit union derived from the selected sanitizer is possible on 7.0 too; do not call the new-only `sanitizer_allowed_tags` helper unconditionally on 7.0.

**Validation:** boot/eager-load; render an existing rich body and an imported body containing collapsible excerpts, links, attachment captions and signed attachment references. Assert scripts, event handlers and javascript URLs are removed, while details/summary and attachments survive. Existing sanitization request tests help, but do not establish editor round-trip compatibility.

### 2. Note enum and JSON serialization syntax

**Code:** `app/models/note.rb`: keyword-style `enum status: ..., _prefix: true`; `serialize :tags, JSON`.

Rails 8 removes keyword enum declarations; 7.2 removes positional serializer arguments. Change enum to `enum :status, { draft: 0, ready: 1 }, prefix: true` (already used for other models; **works on 7.0**). Change tags to `serialize :tags, coder: JSON` **at the 7.1 stage**, not as an unconditional 7.0 preparation: 7.0's method interprets its second positional argument as the coder; the new keyword is not the equivalent JSON declaration there.

**Stored data/validation:** keep the text column and JSON encoding; do not migrate tags to YAML or jsonb as part of the syntax fix. Load old `[]` and nonempty JSON arrays, edit/reload, inspect raw SQL values, and read new writes with the old version. Verify prefixed status scopes and predicates and unchanged integer mappings.

### 3. Highlight aliases must delegate to the JSON store accessor

**Code:** `Note` uses `store_accessor :settings, :color` and `alias_attribute :highlight_color, :color`; note forms permit/use `highlight_color`.

`color` is not a database attribute; Rails 7.2 removes `alias_attribute` support for non-attributes. Replace it with explicit `highlight_color` and `highlight_color=` methods delegating to `color`/`color=` (**works on 7.0**). Do not alias directly to the underlying `settings` column or create a new column.

**Validation:** existing note edit tests plus stored jsonb with an additional unrelated key: form read/write must preserve both highlight behavior and that key; invalid color must still be rejected. No data migration required.

### 4. CSV imports must explicitly roll back on an invalid later row

**Code:** `app/models/import.rb#apply`, `ImportsController#create`.

`return false unless row.note.save` leaves a transaction non-locally. Rails 7.0 rolls this path back; Rails 7.2 removes that rollback behavior. On the target, the import and successful earlier rows can commit while the response reports rejection. Retaining 7.0 defaults does not restore the removed behavior.

**Recommendation:** use explicit `ActiveRecord::Rollback` with an explicit success result, or bang saves and narrowly handle `ActiveRecord::RecordInvalid` outside the transaction while retaining row errors. **Both approaches work on 7.0.** Do not simply replace return with break, or rescue the error inside the transaction and then commit.

**Validation:** a valid first row creating a new citation, followed by an invalid second row, must leave import, notes, Action Text records, and new citations unchanged and still render useful row errors. Existing invalid-batch request coverage is valuable; extend expectations beyond only note count. Include a failed save after preview succeeds. Fix code before any new-version import writes; rollback of the deployment alone cannot undo partially committed imports.

### 5. CSV preview integer keys and receipt custom primary keys

**Code:** `Import#annotations`; `app/views/imports/preview.html.erb` calls `stringify_keys` then indexes by integer `row.line`; `Import#receipt` uses `citation[:id]`; citations have primary key `doi` and no `id` column.

In 7.0, HashWithIndifferentAccess's `stringify_keys` is a shallow copy that leaves integer keys alone; in 8.1 it inherits real stringification. The preview consequently loses annotation lookup by integer. Remove the unnecessary `stringify_keys` and keep integer line keys end-to-end (**works on 7.0**), rather than converting only one side. Rails 7.2 also removes the special `read_attribute(:id)` custom-PK fallback: use `citation.doi` (or `citation.id`), not `citation[:id]` (**works on 7.0**).

**Validation:** multiline CSV yielding nonconsecutive source lines and distinct annotations, with markup displayed literally; receipt must contain a mixed-case DOI shared by two rows plus a row with no citation. Existing import test contains much of this discrimination. Existing DOI data need no rewrite.

### 6. Citation provider configuration and retry policy

**Code:** `app/models/citation/provider.rb#initialize`, `config/secrets.yml`, `app/jobs/citation_enrichment_job.rb`.

`Rails.application.secrets` is removed in 7.2. Move the provider's environment-backed settings to an application-owned `config_for` YAML or explicit `config.x`/ENV configuration, preserving environment-specific defaults and symbol-key lookup. Preserve secret values and never log them. **These approaches work on 7.0**; migrate consumers before removing the old file and confirm it contains no other required settings.

`:exponentially_longer` is removed in 7.2; use `:polynomially_longer` beginning at 7.1. The renamed symbol **does not work on 7.0**. If a same-version preparatory policy is necessary, a callable can implement the existing fourth-power delay and jitter on both; otherwise avoid that extra abstraction and make the symbol change at the bridge version.

**Validation:** fresh web and worker boots with environment-provided provider credentials against the existing loopback test server, not injected settings only. Test success, permanent rejection, and repeated 503 with three Active Job attempts / at most six HTTP requests, final failed state, and retry schedule bounds. Keep the same exception class and retry count so already-retried jobs retain their attempt history.

### 7. Markdown export string aggregation

**Code:** `app/models/export.rb#generate`: `finish(fragments.sum)`.

Rails 7.1 removes its nonnumeric Enumerable/Array sum override. Ruby's zero identity is not a string concatenation identity. Replace with `fragments.join` (**works on 7.0**).

**Validation:** execute a queued native Sidekiq export with two differently titled/body notes and assert exact heading, order, whitespace, file bytes and filename; also export an empty notebook. Existing export tests help. Old queued jobs use the same IDs and can execute the corrected implementation; keep class names and arguments stable.

### 8. Reminder scheduling requires a time object, not an epoch integer

**Code:** `Note#schedule_reminder`: `set(wait_until: reminder_epoch)`.

7.0 converts `wait_until` to a float; 8.1 stores it as `scheduled_at` and serializes via `scheduled_at.utc.iso8601`. Integer input is no longer valid. Pass `Time.at(reminder_epoch).utc` (**works on 7.0**). Keep the stored epoch and job ID semantics; do not rewrite all reminder timestamps.

**Validation:** future and overdue reminders, rescheduling (old job sends nothing), worker execution after commit, deleted notes, and enqueue failure preserving the previous reminder. Exercise Sidekiq JSON scheduling, not only the Active Job test adapter. In 7.0 the serialized Active Job envelope did not include scheduled_at; the Sidekiq outer scheduled timestamp remains relevant. Capture real old and new envelopes in the sandbox and verify both directions before claiming mixed-version compatibility.

### 9. Digest serialization changes the content day and rollback compatibility

**Code:** `User#request_digest`, `DigestJob`, `DigestMailer#daily_digest`.

New TimeWithZone serialization carries the zone and reconstructs it; 7.0 reconstructed in the job's zone. The Redis reservation still uses a UTC day, while the mailer uses `requested_at.to_date`/`all_day`. A newly queued Eastern 23:30 request can now select the preceding local day rather than the reserved UTC day. This is a behavior change, not a missing config default.

**Recommendation:** make the mailer's UTC-day contract explicit by normalizing `requested_at` to UTC before deriving date/range; optionally normalize at enqueue too. **Works on 7.0 and handles old queued payloads.** Do not merely update the expected subject to the new local day without changing the product contract/reservation rule.

New Rails also uses `ActiveJob::Serializers::BigDecimalSerializer`; 7.0 workers do not have that serializer. Old Sidekiq-JSON jobs contain a decimal string, which new workers can still handle. For bidirectional compatibility, prepare `reading_completion.to_s("F")` as the digest argument on 7.0 and keep the mailer's decimal conversion. Avoid a custom serializer unless there is a real need to retain BigDecimal as a wire type.

**Validation:** serialize through Sidekiq JSON in both directions; 23:30 Eastern with notes on each side of UTC midnight must use the UTC subject/content day and preserve the 0.6667 completion. Check new workers consuming old strings and old workers consuming new prepared strings. Existing near-midnight tests expose day selection, but their Active Job test adapter does not reproduce the old BigDecimal → JSON string boundary.

**Rollout:** prepare the string producer before newer workers/producers. Drain/inventory unprepared BigDecimalSerializer payloads before rolling back to 7.0; otherwise keep compatible workers to process them. Retain reservation sets and expirations; do not clear Redis wholesale and allow duplicate digests. Retry execution can still duplicate mail; this pre-existing limitation is not fixed by the Rails upgrade.

### 10. Reminder preview timezone semantics change in 8.1

**Code:** `Note#next_day_reminder_at`, `_reminder.html.erb`.

8.1 `TimeWithZone#to_time` always uses the receiver's timezone, not a fixed offset; retaining 7.0 defaults does not prevent this. The existing test deliberately expects `2026-11-01T09:00:00-04:00` after adding 24 hours to Oct 31 09:00 Eastern. Zone-aware arithmetic represents that instant as Nov 1 08:00 -05:00 instead. The epoch remains the same, but rendered wall-clock time/offset changes.

**Recommendation:** explicitly choose the contract. To preserve today's fixed-offset display, use a fixed-offset Time (`reminder_at.getlocal(reminder_at.utc_offset) + 86_400`); **works on 7.0**. Preferably approve the clearer local-zone preview separately and compute 24 elapsed hours then convert to the reader's zone. Do not substitute `1.day` calendar arithmetic: that can change the postponed instant across DST. Validate both spring-forward and fall-back, exact epoch difference 86,400, offset, displayed time, and sent email. No stored epoch migration is required.

### 11. Routes and exception-test configuration

**Code:** `config/routes.rb`: `get "/notes", "/journal", to: "notes#index"`; `config/environments/test.rb`: `show_exceptions = false`.

8.1 removes multiple paths in one route call. Draw two explicit GET routes while preserving `notes_path` and `/journal` behavior (**works on 7.0**); verify both filtered/paginated URLs and path helpers. 7.2 removes boolean `show_exceptions`; set `:none` at 7.1 to preserve tests asserting raised RecordNotFound. **Do not use `:none` as equivalent on 7.0**, where the middleware's boolean semantics differ. Also verify production 404 responses separately from exception-raising tests.

### 12. Expired export cache duration

**Code:** `app/views/exports/_export.html.erb` computes `expires_in: export.expires_at - Time.current` even for expired exports.

8.1 detects negative durations; with old defaults it reports the invalid value and discards that option, potentially writing without the intended expiry. With 7.1 defaults it raises. Handle expired availability outside the timed cache and only cache a positive remaining lifetime (**works on 7.0**); account for the deadline passing between the condition and duration calculation. A nonnegative value with zero lifetime or an uncached expired branch is safer than an arbitrary long TTL. Do not assume switching to a past `expires_at` bypasses validation: the target converts it to a duration.

**Validation:** enable a real test-local store and caching, test miss/hit immediately before and after deadline, cold expired entry, cancellation, and another reader. Existing availability-cache test is relevant; ordinary tests run with caching disabled. Downloads must independently enforce expiry before a 304.

## Optional framework-default adoption (not prerequisites if 7.0 defaults remain)

1. **Notebook YAML preferences:** 7.1 defaults set `active_record.default_column_serializer = nil`; `Notebook` uses bare `serialize :preferences`. At the 7.1 stage make it `serialize :preferences, coder: YAML` before enabling those defaults. The new keyword is **not a safe 7.0 equivalent**. Preserve YAML bytes/types and permitted classes; no switch to JSON or bulk rewrite is required. Validate existing null, empty and populated string-keyed hashes, export-heading edits and old-runtime reads of new writes. Do not add `type: Hash` without separately evaluating its empty-value semantics.
2. **Readonly notebook slug:** 7.1 defaults enable `raise_on_assign_to_attr_readonly`; even the unchanged hidden slug resubmitted by the settings form is assigned and can raise. Remove slug from update parameters and remove the redundant hidden input, retaining creation slug generation and `attr_readonly` (**works on 7.0**). Test legitimate unchanged-slug save and a tampered slug; neither may alter the persisted slug. Alternatively delay the setting, not the API repairs above.
3. **PostgreSQL date decoding:** 7.2 defaults enable `postgresql_adapter_decode_dates`. `Notebook#daily_note_counts` currently calls `Date.iso8601(day)` on raw `select_rows` output; with new defaults `day` is already a Date. Normalize with `day.is_a?(Date) ? day : Date.iso8601(day)` (**works on 7.0**) or retain the old decoding option initially. Validate real PostgreSQL grouped dates and counts, including notes straddling UTC midnight and an empty notebook, under both settings. No date data rewrite required.
4. **HTTP freshness:** 8.0 defaults set `action_dispatch.strict_freshness = true`. `ExportDownloadsController` supplies both ETag and Last-Modified; ETag takes precedence rather than requiring both validators to match. Adoption is normally desirable, not a reason to remove validators. Validate matching ETag + stale If-Modified-Since (old behavior 200, strict behavior 304), mismatching ETag + fresh date (200), either header alone, and expired/foreign exports with matching validators (no authorized download/304). Existing tests do not fully exercise conflicting validators.
5. **Cache/message formats and signing:** keep cache format 7.0, legacy message metadata format and serializer initially. 7.1 defaults select cache 7.1, `message_serializer = :json_allow_marshal`, and new metadata serialization. New readers accepting old messages does not establish old readers accepting new ones. Inventory session cookies, persistent Action Text attachment SGIDs and Active Storage signed links before switching formats. Keep `secret_key_base` unchanged on all web/worker nodes. Development/test move from `tmp/development_secret.txt` to `tmp/local_secret.txt`; securely preserve the old key if local persisted attachments must survive. No need to print or rotate it. Test old/new cookie and attachment tokens in both directions including rollback; newer writes must not strand stored rich-text attachment references. Use a new cache namespace or clear only disposable application caches at format switch/rollback where readers differ; never flush queue/reservation Redis. These new config options are **not a 7.0 preparatory recipe**; defer them until their supported bridge version.
6. **HTML5 sanitization:** 7.1 defaults change Action View/Action Text sanitizer vendor. Optional relative to the version upgrade. Test malformed/nested HTML, tables, links, attachments and details/summary against a representative stored-body corpus; compare rendered and exported plain text, not only well-formed fixture markup. Rendering sanitizer changes generally do not rewrite stored bodies; editor saves do. Back up bodies/blobs before enabling new editing behavior.

## Frontend and storage validation gate

The layout explicitly loads classic `vendor/javascript/trix-1.3.5.js`; importmap loads the Rails-provided `@rails/actiontext`; CSS requires gem-provided `trix`. Upgrading Rails can therefore pair old editor JS with new Action Text JS and Trix 2 CSS. This combination is **not runtime-verified**; do not call it compatible merely because HTML request tests pass. Deliberately pin a consistent editor/CSS pair initially or migrate to the target's Trix 2 distribution and remove the old script in the same reviewed change. The latter is not presumed safe on Rails 7.0 without its own browser check.

Run production asset precompile and browser scenarios: edit/reopen a stored link, ordinary formatting, upload an image and non-image, reject >1MB embedded blob, save/reopen tags-only changes with attachments, CSV rich HTML, details/summary, export text and download. Confirm only one Trix is loaded and no module/runtime errors occur. There are no implemented system tests in the inspected test file inventory; `test:system` alone may execute zero scenarios. Existing details/summary flattening by Trix 1 is a known current limitation, not automatically a new regression or an upgrade mandate to redesign editing.

Local Disk storage and Active Storage schema are already present. No evidence requires a service migration or installing image processing: the app intentionally renders originals, not variants. Preserve existing blob keys, metadata, signed references and file bytes; verify old attachments before and after a rollback rehearsal. Public signed blob URLs, anonymous upload access, unattached-file cleanup, and incomplete production mail configuration are pre-existing deployment issues, not solved by changing Rails.

## Transactional enqueue policy: explicitly verify, do not infer from release headlines

`Citation#request_enrichment` and `Note#schedule_reminder` enqueue inside row locks and depend on immediate enqueue failure rolling back DB state. Rails 7.2's after-commit enqueue feature and subsequent 8.x API changes must be considered at each stage. Exact 8.1.0 has job-level `enqueue_after_transaction_commit` default **false**; do not claim that all target jobs automatically defer because the 7.2 release notes describe that feature. The 8.1 API accepts booleans, not the old `:never/:always/:default` or removed global setting.

Keep immediate behavior for these jobs initially; if necessary assert it explicitly at the supported stage. The new property is not available on 7.0. Test actual Redis refusal during each operation, rollback of pending/reminder state, worker visibility after commit, and a transaction that itself rolls back. If adopting deferral later, redesign the failure contract: an enqueue failure after commit cannot undo the already committed reminder or pending citation. Native `ExportJob.perform_async` is outside this Active Job policy and is intentionally queued after the export record commits.

## Delivery sequence and rollback plan

1. Capture baseline commit, Ruby/Bundler/platform, lockfile, effective configuration (redacted), passing/failing baseline outputs, and a synthetic stored-data/queue corpus. Back up production DB and Disk storage before any authorized deployment; this assessment did not inspect or alter them.
2. Ship current-compatible preparations: explicit rollback, enum syntax, highlight delegation, key/DOI access, export join, reminder Time, explicit digest UTC/decimal string, provider config migration, route split, cache-expiry guard, and chosen timezone contract. Add discriminating assertions to existing tests where possible. Keep stored schemas and job names stable.
3. In disposable environments, upgrade to the latest approved 7.0 patch, then 7.1 patch. At 7.1 change serializer syntax, retry symbol and exception config. Review `bin/rails app:update` diffs; do not overwrite Sidekiq, Disk, Sprockets, or environment-specific behavior with a new-app template. Enable deprecation reporting for the evaluation (production currently suppresses it). Retain 7.0 defaults.
4. Repeat for 7.2, 8.0, then exact 8.1.0; resolve and record each lockfile. At each stage run boot/eager-load, migrations/schema load in scratch DBs, full request/model suite, real worker/JSON boundary checks, production-mode assets and browser flows. Keep schema dump version/alphabetical column changes separate from actual database migrations.
5. Before production rollout, inventory immediate, scheduled, retry and dead jobs, including reminder job IDs and citation attempt counters. Preserve Active Job/Sidekiq wrapper class compatibility. Prefer worker-first upgrades after the JSON-safe producer preparation; exercise old producer → new consumer and new producer → old consumer, plus retry reserialization. Do not drain future reminders by executing them early, renumber stored job IDs, or purge queues to make tests green.
6. For rollback, retain the preparatory app release as the compatible fallback. Pause new producers as necessary, keep compatible workers for any new-only payloads, and reconcile scheduled/retry/dead work rather than blindly replaying it. Restore compatible cache/message settings and retain signing keys. A DB/file backup is recovery insurance, not permission to overwrite legitimate user writes. Partial imports or editor-induced content rewrites need targeted reconciliation; reverting code does not reverse them.
7. Only after the version-only rollout is stable, adopt framework defaults one by one with the optional-default checks above. Advance `load_defaults` only when the inherited cumulative changes are understood. Prefer a separate approved patch-security review before public deployment.

## Reproducible execution plan (not run)

Use a disposable worktree/copy without copied credentials, runtime files, real storage or `.env` files. A copied checkout alone is not isolation. Configure unique development/test/production database names (including parallel test DBs), a separate disposable Redis process/instance for Sidekiq and reservations, isolated Cable Redis if exercised, variant-local cache directories/namespaces, Disk roots, file-mail directories and a synthetic secret_key_base. Block external mail/HTTP and use the loopback citation provider. Set these before any boot because initializers may access services. Ensure test parallel workers cannot collide across variants.

For **each** baseline/bridge/target/defaults variant, retain: exact command and exit code, source revision and patch, full resolved Gemfile.lock, Ruby/Bundler versions, redacted effective config, isolated resource identifiers, stdout/stderr, Rails logs, worker/provider logs and relevant browser artifacts. Suggested paths: `.amp/in/artifacts/rails-review/<variant>/{commands.log,Gemfile.lock,config-redacted.txt,stdout.log,rails.log,sidekiq.log,provider.log}`. Do not publish secrets from environment dumps. None of those runtime-result files exists from this review.

After isolation, the command suite is `bundle check`, `bin/rails db:prepare`, `bin/rails zeitwerk:check`, `bin/rails test`, `bin/rails test:system`, and a production-configured `bin/rails assets:precompile`, with all variant resource variables explicitly supplied. Also execute the additional behavioral checks above through actual jobs/requests/browser interactions. Record suite counts: a green empty browser suite is not evidence of editor functionality.

Remaining questions: actual production PostgreSQL/Redis versions and deployment topology; shared cache use/namespace; signing-key source and rotation history; oldest scheduled/retry payloads; stored YAML classes and rich HTML corpus; acceptable fixed-offset versus local-zone reminder display; whether a Sidekiq update is desired separately; approved Rails patch/security policy. None blocks the source-based plan, but all relevant runtime gates must close before deployment approval.

## Exact upstream evidence

All GitHub source links below are pinned to the requested target tag; comparison baseline uses the equivalent paths at `v7.0.8.7`.

- [Upgrade guide at v8.1.0](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md): staged upgrades, defaults, cache format, local signing key.
- [7.1 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_1_release_notes.md), [7.2](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md), [8.0](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_0_release_notes.md), [8.1](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md): API removals identified above.
- [Cumulative defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb): readonly, YAML coder, cache/message metadata, sanitizer, date decoding, strict freshness.
- [Action Text content helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb), [engine initialization](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/engine.rb), [gemspec](https://github.com/rails/rails/blob/v8.1.0/actiontext/actiontext.gemspec).
- [Serialization API](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [7.0 serialization API](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [readonly assignment](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/readonly_attributes.rb).
- [HashWithIndifferentAccess](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/hash_with_indifferent_access.rb), [stringify_keys](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/core_ext/hash/keys.rb), [7.0 Enumerable sum](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/core_ext/enumerable.rb).
- [TimeWithZone job serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [BigDecimal serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb), [job envelope/scheduling](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb), [retry policy](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/exceptions.rb).
- [Enqueue policy](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb), [after-commit implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb), [Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).
- [TimeWithZone#to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb), [cache expiration validation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb), [PostgreSQL raw decoding](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb), [HTTP freshness](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb).
- [Ruby requirement](https://github.com/rails/rails/blob/v8.1.0/rails.gemspec), [Action Pack Rack dependency](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec); existing dependency versions and Sidekiq Rack constraint are also directly recorded in the application's Gemfile.lock.
