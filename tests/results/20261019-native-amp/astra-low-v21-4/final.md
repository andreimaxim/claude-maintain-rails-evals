# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## Application facts and assessment boundary

- **Code:** Ruby is pinned to 3.3.6 and Rails to 7.0.8.7 ([Gemfile](file:///home/user/workspace/repo/Gemfile#L4-L8)). Ruby satisfies Rails 8.1's Ruby ≥ 3.2 requirement.
- **Code:** This assessment retains **`config.load_defaults 7.0`**, not 8.1 ([application configuration](file:///home/user/workspace/repo/config/application.rb#L10-L24)). Updating the defaults is a separate behavioral migration.
- **Code:** PostgreSQL is configured ([database.yml](file:///home/user/workspace/repo/config/database.yml#L16-L22)); HTML/ERB, Sprockets, importmap, Action Text and local Disk storage are used. No image processor is installed. Redis is for Sidekiq and digest reservations, not Rails caching. Production enables controller caching without selecting a different store (Rails' memory-store default); development uses memory/null stores, tests null.
- **Code:** Active Job uses Sidekiq outside tests; exports use native Sidekiq jobs. Digests carry a zoned timestamp and BigDecimal; reminders pass numeric epochs to `wait_until`. Files and rich-text bodies are persisted. These make rolling-deployment compatibility relevant, though whether this app actually deploys old/new workers together is unknown.
- **Code:** The browser explicitly loads vendored Trix **1.3.5**, not Rails' bundled Trix ([layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14)). Installing the new Trix dependency does not automatically replace that script.
- **Resolution evidence:** On 2026-10-19, copied Gemfile/Gemfile.lock to a temporary directory, changed only the Rails requirement to 8.1.0, and ran `bundle lock --update rails`. Resolution succeeded. All 13 Rails/framework gems move to 8.1.0. **Rack stays 2.2.24, Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, pg 1.6.0, Faraday 1.10.4, Pagy 8.6.3.** No Rack-3 migration is implied by this resolution.
- **Resolution evidence:** Added: `action_text-trix 2.1.19`, `bigdecimal 4.1.3`, `drb 2.2.3`, `json 3.1.0`, `rack-session 1.0.2`, `rackup 1.0.1`, `securerandom 0.4.1`, `uri 1.1.2`, `useragent 0.16.11`, `webrick 1.9.2`. `net-imap` moves 0.6.7 → 0.6.8; `method_source` disappears. The inspected Ruby supplies BigDecimal 3.1.5, JSON 2.7.2, URI 0.13.1, SecureRandom 0.3.1 and DRb 2.2.0 before those explicit dependencies. Dependency results are date-sensitive.

**Method:** Read Rails release-tag changelogs for 7.1, 7.2, 8.0 and 8.1, compared selected implementation files between released 7.0.8.7 and 8.1.0 source archives, and followed changed APIs into application code. Downloaded/unpacked newly resolved gems without installation. “Changelog” identifies upstream statements; “Code” identifies inspected implementation; “Inference” identifies predicted application effects. This is a focused, non-exhaustive static review, not proof that all intermediate patch changes or dependency interactions have been covered. No application boot, tests, migrations or upgrade installation were performed.

## High-risk changes

### 1. Failed imports can commit partial batches

**Before → after (changelog + code):** Rails 7.0 rolls back a written transaction on a non-local `return`. By 8.1, normal non-local exits commit; the compatibility option has been removed. Sources: [7.1 transaction change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L304-L330), [8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L76), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L643-L670).

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and then returns `false` from inside the transaction when a row cannot save.

**Inference:** An import with a valid first row and invalid later row can report failure while retaining its import record and earlier notes, including rich-text/citation data. Retrying creates duplicates. Replace the non-local exit with explicit rollback semantics while retaining the method's false result. Review this before any data-writing rollout.

### 2. Digests change their day and selected notes after job deserialization

**Before → after (changelog + code):** 7.0 serializes the timestamp offset but deserializes `TimeWithZone` in the worker's zone. 7.2+ includes the named timezone and restores it. Old payloads without the field still fall back to the worker zone. Sources: [7.2 entry](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a UTC date but queues a reader-zoned time; [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) selects `requested_at.all_day` and labels `requested_at.to_date`.

**Inference:** Newly enqueued digests select a local calendar day rather than UTC, including different notes and potentially a different date near midnight. Deduplication remains by UTC date. Old/new workers and old/new payloads can produce different output. Decide the intended digest day explicitly; do not rely on serializer side effects.

### 3. BigDecimal job arguments change wire format

**Before → after (changelog + code):** 7.0 treats BigDecimal as a primitive; JSON-backed queues turn it into a string. 7.1 introduced a named serializer and 7.2 removed the primitive compatibility path, irrespective of retaining 7.0 defaults. Sources: [7.1 compatibility warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L157), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65), [serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

**Application:** [reading_completion and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L7), [mailer conversion](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10).

**Inference:** New workers can consume legacy strings; old 7.0 workers cannot resolve the new `ActiveJob::Serializers::BigDecimalSerializer` payload. The mailer's conversion accommodates the intended new decimal type, but does not solve old-worker deserialization. Drain/separate workers or explicitly use a stable primitive payload before mixing versions.

### 4. Import-preview annotations silently disappear

**Before → after (changelog + code):** `HashWithIndifferentAccess#stringify_keys` previously left integer keys alone; Rails 8 actually converts them to strings. [Upstream before/after example](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L46).

**Application:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) keys annotations by integer source line; [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys` then reads with `row.line` integers.

**Inference:** The condition becomes false and readers no longer see annotations before approving an import. Stored note annotations are not deleted by this particular change. Use one key representation consistently.

### 5. Custom-primary-key access loses DOI values in receipts

**Before → after (changelog + code):** `read_attribute(:id)`/`[:id]` no longer redirect to a custom primary key, starting in 7.2. [Removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L425), [new implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb#L29-L35).

**Application:** Citations use `doi` as their primary key ([schema](file:///home/user/workspace/repo/db/schema.rb#L55)); [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) exports `citation[:id]`.

**Inference:** The receipt no longer reads the DOI and can emit a blank DOI instead. The association still uses `citation_doi`; this does not itself delete citations. Use the explicit DOI or primary-key reader rather than the literal `id` attribute.

### 6. Reminder postponement displays a different local time across DST

**Before → after (code + changelog):** With the old defaults, `TimeWithZone#to_time` retains a fixed UTC offset. In 8.1 it unconditionally returns a Time retaining the named zone. [8.1 change](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22), [implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L500).

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L45) computes `reminder_at.to_time + 86_400`; [postpone_reminder](file:///home/user/workspace/repo/app/models/note.rb#L71-L72) schedules its epoch.

**Inference:** The same 24-hour elapsed interval has a DST-adjusted offset and wall-clock display rather than the old fixed-offset preview. The scheduled instant should remain the same, not shift by an hour. High under the requested timezone-behavior rubric, but a narrower impact than the digest change. Check both spring-forward and fall-back previews.

### 7. Negative fragment-cache TTLs no longer mean an already-expired entry

**Before → after (changelog + code):** 7.0 accepts negative expiration; 7.1+ validates it. Under retained 7.0 defaults, the error is reported/logged rather than raised, and the invalid `expires_in` option is removed. [Entry](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L869), [implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L907-L945).

**Application:** [export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) always uses `export.expires_at - Time.current`, including already-expired exports.

**Inference:** An expired indicator can now be cached without that TTL, rather than immediately expire. This also produces warning/error reporting. It does **not** authorize expired downloads: [the download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L15) checks persisted availability first. Avoid negative TTLs; changing to 7.1+ defaults instead makes this path raise.

### 8. Attachment filenames receive additional sanitization

**Before → after (changelog + code):** Rails 8.0 adds `<`, `>`, `?`, `*` and `"` to characters replaced with `-` by `ActiveStorage::Filename#sanitized`. [Changelog](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md#L22), [implementation](https://github.com/rails/rails/blob/v8.1.0/activestorage/app/models/active_storage/filename.rb#L57-L72).

**Application:** The [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L2-L12) displays filenames and generates attachment links for user-supplied files.

**Inference:** Existing blobs with those characters acquire different visible/download names without modifying the raw stored filename. Ordinary filenames and parameterized notebook export slugs are unaffected. High under the silent data-format rubric; limited severity in this app.

## Medium-risk changes

### 9. Secrets API removal requires a configuration migration

**Before → after (changelog + code):** `Rails.application.secrets` loaded secrets.yml in 7.0; deprecated in 7.1, removed in 7.2. [Removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61).

**Application:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15) reads `Rails.application.secrets.citation_provider`.

**Inference:** Enrichment now errors before making its HTTP request. Choose credentials versus explicit environment/configuration access, preserving the existing environment-backed settings and missing-provider behavior. Merely renaming `secrets` to `credentials` does not migrate values. Also preserve the production signing key if any deployment sources it from secrets.yml; deployment key provenance was not inspected.

### 10. Built-in Sidekiq adapter is deprecated for removal in Rails 8.2

**Before → after (changelog + code):** Rails supplied the adapter; 8.1 still supplies it but warns it will be removed in 8.2, recommending Sidekiq ≥ 7.3.3. [Adapter warning](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L34-L39).

**Application:** [queue adapter setting](file:///home/user/workspace/repo/config/application.rb#L22-L24), [native ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L3-L10), and the resolved Sidekiq 6.5.12 pin.

**Inference:** Not a dependency-resolution blocker for 8.1, but a next-release removal under the requested medium-risk rubric. A Sidekiq upgrade is a separate decision affecting Redis requirements, native export arguments and direct Redis calls; it is not silently included here.

### 11. Newly resolved JSON 3 rejects formerly tolerated provider JSON

**Before → after (dependency changelog + source):** The current Ruby supplies JSON 2.7.2; resolution adds JSON 3.1.0. JSON 3 rejects duplicate keys and JavaScript comments by default, removes `create_additions`, and tightens malformed escape/surrogate handling. [JSON release history](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

**Application:** [Citation::Provider#metadata_from](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) parses external JSON and rescues parser errors as a failed enrichment. [Note tags](file:///home/user/workspace/repo/app/models/note.rb#L12) and Sidekiq payloads also use JSON.

**Inference:** A provider response formerly tolerated can now fail enrichment. Ordinary app-generated string arrays and standard job JSON have no demonstrated issue. Decide whether strict rejection is the intended external-data contract; inspect actual provider samples and historic serialized data. This is not evidence that the provider currently sends invalid/duplicate-key JSON. JSON version locking should be deliberate rather than an unnoticed side effect of the Rails update.

## Low-risk changes: mechanical fixes

- **Action Text initializer:** `allowed_tags` is now nil by default, so [the `+=` initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) fails at boot. Populate it from the sanitizer's effective default allowlist **including attachment tags**, then add `details`/`summary`; do not replace it with only those two tags. **Changelog + code:** [7.1 entry](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33).
- **Enum syntax:** [Note line 10](file:///home/user/workspace/repo/app/models/note.rb#L10) must become `enum :status, { draft: 0, ready: 1 }, prefix: true`; keyword declarations were removed in 8.0. **Changelog:** [removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L64).
- **Serialization argument:** [Note line 12](file:///home/user/workspace/repo/app/models/note.rb#L12) must use `serialize :tags, coder: JSON`, preserving its stored JSON format. **Changelog:** [7.2 positional-argument removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421).
- **Non-column alias:** [Note lines 13–14](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) alias a store accessor, not a database attribute; use ordinary getter/setter delegation for `highlight_color`. **Changelog + code:** [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490).
- **Retry symbol:** [CitationEnrichmentJob line 7](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must use `:polynomially_longer`; the old name raises when calculating a retry. **Changelog:** [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51).
- **Numeric scheduled time:** [Note line 61](file:///home/user/workspace/repo/app/models/note.rb#L61) passes an Integer; use a Time representing that epoch. 8.1 serializes `scheduled_at.utc.iso8601`, so the integer raises. **Changelog + code:** [7.1 time representation](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L15-L18), [8.1 serialization](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L130).
- **Multiple route paths:** Split [routes line 18](file:///home/user/workspace/repo/config/routes.rb#L17-L18) into two `get` declarations, preserving canonical `notes_path`. **Changelog:** [8.1 removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107).
- **String summation:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) uses `fragments.sum`; Ruby's sum starts from numeric zero after Rails' override is removed. Use `join` or an explicit string identity. **Changelog:** [7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420).
- **Test exception configuration:** Change [test.rb line 31](file:///home/user/workspace/repo/config/environments/test.rb#L31) from `false` to `:none` to retain raise-through semantics. **Changelog + code:** [7.2 boolean-support removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md#L100). Existing false happens not to match the new render branches, but is no longer supported configuration.

## Changes excluded or conditional, and remaining review limits

- **PostgreSQL date decoding — not active with 7.0 defaults.** 7.2 defaults enable Date results, but the 8.1 adapter itself defaults decoding off. If defaults are raised, [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) passes a Date to `Date.iso8601` and needs adjustment. **Code:** [defaults gate](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L322-L334).
- **Readonly attributes and missing default serializer — not active with 7.0 defaults.** [Notebook's preferences and readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) retain YAML and silent readonly-assignment handling. Choosing 7.1+ defaults requires explicitly preserving/migrating YAML and deciding how the resubmitted slug should behave. **Code:** [7.1 gates](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L280-L287).
- **HTML5 sanitizer default — not active with 7.0 defaults.** HTML4 remains selected; the nil-allowlist initializer failure above still applies. **Changelog + code:** [7.1 Action Text entry](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33).
- **HTTP strict freshness — not active with 7.0 defaults.** ETag precedence is gated by 8.0 defaults; [export conditional downloads](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L13) retain prior freshness behavior. **Code:** [configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L335-L340).
- **Automatic after-commit enqueueing — not enabled here in 8.1.** Do not infer behavior from the 7.2 announcement: the final job class attribute defaults false and the app does not override it. Existing row-lock enqueue paths still need their existing failure semantics. **Code:** [8.1 default](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L53).
- **New cache serialization format — not selected.** `load_defaults 7.0` retains format 7.0; no shared Redis/Memcached cache is configured. **Code:** [defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L242).
- **New-app infrastructure — not part of this update.** Solid Queue/Cache/Cable, Propshaft, deployment generators and authentication generator do not replace this app's configured Sidekiq/Sprockets/session code just because Rails changes. **Code/inference:** existing Gemfile and configuration, not generator output, control this application.
- **Other database adapters, sharding, encryption and composite keys — not relevant.** PostgreSQL single-database configuration; no application uses found. Citation's single custom primary key is covered separately.
- **Action Mailbox and Action Cable feature changes — no implemented mailbox or application broadcast use found.** Framework inclusion and generated channel/config files alone do not establish a user-facing path.
- **Mailer preview, bulk-delivery and delivery-callback changes — no matching usage found.** Actual mailers deliver synchronously inside jobs; digest argument changes are covered above.
- **Cloud storage, Azure removal and image variants — not relevant.** Disk is configured; blob partial renders originals; no image-processing dependency. Active Storage overall is relevant, not excluded.
- **Trix dependency transition — newly added gem does not select the editor.** The browser remains on vendored 1.3.5 while Action Text's JS changes. The inspected 8.1 upload listener still uses Trix events/attachment methods, but compatibility was not executed. Review attachment upload and saved-HTML round-trips before deployment; do not claim this upgrade delivers Trix 2 fixes to the browser. **Code/changelog:** [8.1 Action Text](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md), [listener](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/javascript/actiontext/index.js).
- **Rich-text embed assignment timing — review boundary, not a demonstrated regression.** 8.1 moves assignment to `before_validation`; [Note's attachment-size check](file:///home/user/workspace/repo/app/models/note.rb#L95-L98) reads body attachables, not the association's old callback timing. No timing-dependent application callback was found. **Changelog/code:** [8.1 Action Text](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).
- **Local signing key source — conditional risk.** 8.1 can use ENV/credentials keys in development/test instead of generated local keys, so existing local cookies/signed URLs may invalidate. [Sessions use signed cookie state](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17); actual secret values/provenance were intentionally not inspected. **Changelog:** [8.1 entry](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md#L156-L161).
- **Rack extraction dependencies — no Rack-major change.** Inspected rack-session 1.0.2 is a compatibility/no-op require target with Rack < 3; rackup 1.0.1 likewise retains Rack < 3. WEBrick is added via rackup but the app uses Puma. Do not apply Rack 3 header/body migration advice to this resolved bundle. **Dependency source:** [rack-session](https://github.com/rack/rack-session/tree/v1.0.2), [rackup](https://github.com/rack/rackup/tree/v1.0.1).
- **net-imap 0.6.8 — no application IMAP retrieval path found.** It remains a mail dependency, but these mailers send rather than retrieve messages; no application effect identified.
- **DRb/useragent — no direct application usage/new opt-in feature found.** Framework/test infrastructure dependencies, not evidence of a changed product feature. SecureRandom is used indirectly; no app-specific change established.
- **BigDecimal 4.1.3 and URI 1.1.2 — incomplete dependency-risk review.** Downloaded source confirms movement beyond Ruby's bundled versions; arithmetic in [reading_completion](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) and URI validation in [Provider#web_url?](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) are exposure points. No concrete additional regression established by this static pass; do not interpret that as compatibility certification. Sources: [BigDecimal history](https://github.com/ruby/bigdecimal/compare/v3.1.5...v4.1.3), [URI history](https://github.com/ruby/uri/compare/v0.13.1...v1.1.2).

## Decision

**Inference:** This is not a safe version-only deployment. Fix the mechanical boot/runtime incompatibilities first; then explicitly preserve import atomicity, choose digest date semantics, and plan job-payload compatibility before a rolling rollout. Retaining 7.0 defaults avoids several additional changes but does not avoid the high-risk findings above. Resolve the remaining dependency/editor uncertainties before treating the upgrade as ready. Application files and lockfile were left unchanged.