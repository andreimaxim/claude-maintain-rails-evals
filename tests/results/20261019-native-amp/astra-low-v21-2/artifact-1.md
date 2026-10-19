# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## Application facts and scope

Evidence labels: **Code** means application or released upstream source inspected; **History** means upstream changelog, guide, PR, or commit; **Inference** means the predicted application consequence, not an executed test.

- **Code:** Ruby is pinned to 3.3.6 and Rails to 7.0.8.7 in [Gemfile](file:///home/user/workspace/repo/Gemfile#L4-L8). Ruby meets Rails 8.1.0's ≥3.2 requirement. This assessment assumes [config.load_defaults 7.0](file:///home/user/workspace/repo/config/application.rb#L10-L24) stays in place. Changing it is a separate behavioral migration.
- **Code:** This is an HTML/ERB application using Sprockets, importmap, Turbo, Action Text, and PostgreSQL, not a JSON-only API. PostgreSQL configuration is in [database.yml](file:///home/user/workspace/repo/config/database.yml#L18-L23); the production server's PostgreSQL version was not queried.
- **Code:** Notes have JSON-serialized tags in a text column, jsonb settings, rich-text bodies, and reminders. Citations use `doi`, not `id`, as their primary key. See [Note](file:///home/user/workspace/repo/app/models/note.rb#L1-L19) and [schema](file:///home/user/workspace/repo/db/schema.rb#L55-L62).
- **Code:** Sidekiq 6.5.12 and Redis 4.8.1 are pinned. Active Job uses Sidekiq outside tests; native `ExportJob` also uses it. Digests serialize a zoned time and BigDecimal; reminders are scheduled by integer epoch. See [User](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [Note](file:///home/user/workspace/repo/app/models/note.rb#L56-L63), and [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10). Whether a real deployment overlaps old/new workers is unknown.
- **Code:** Storage is local Disk, with no image-processing gem. The layout explicitly loads vendored Trix **1.3.5**, rather than the gem-provided editor: [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14). Action Text's sanitizer allowlist is customized.
- **Code:** Development uses MemoryStore only when caching is enabled, otherwise NullStore; tests use NullStore. Production has no active cache-store override, so Rails' default FileStore applies. The export page caches an expiry indicator; the download controller independently checks ownership and expiry. See [development configuration](file:///home/user/workspace/repo/config/environments/development.rb#L19-L35), [production configuration](file:///home/user/workspace/repo/config/environments/production.rb#L59-L60), and [download action](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16).
- **Code:** Sessions hold a user ID. Citation configuration uses `Rails.application.secrets`. Mailers send reminder/digest text; development writes mail to files, tests capture it, and production delivery is not configured here. No secret values were read or decrypted.

**Dependency resolution, 19 October 2026 — observed:** I copied both bundle files to a temporary directory, changed only the Rails requirement to `8.1.0`, and successfully ran `bundle lock --update rails`. No gems were installed and the application was not booted or tested.

- Rails and its 12 companion gems move together to 8.1.0.
- Existing non-Rails update: **net-imap 0.6.7 → 0.6.8**. `method_source 1.1.0` disappears.
- New lock entries: **action_text-trix 2.1.19, bigdecimal 4.1.3, drb 2.2.3, json 3.1.0, rack-session 1.0.2, rackup 1.0.1, securerandom 0.4.1, uri 1.1.2, useragent 0.16.11, webrick 1.9.2**.
- Rack stays **2.2.24**; Sidekiq, Redis, Puma, pg, Pagy, Faraday, Nokogiri, rails-html-sanitizer, and the Hotwire gems stay locked. Do not assume Rack 3 or Sidekiq 7 migrations are forced by this upgrade.
- The new explicit standard-library dependencies replace this sandbox's Ruby defaults: BigDecimal 3.1.5, JSON 2.7.2, DRb 2.2.0, SecureRandom 0.3.1, URI 0.13.1. Production's effective defaults were not inspected.

The [resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolved.lock) and [lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lock.diff) preserve the actual result. These are today's resolver choices, not necessarily the dependencies selected when Rails 8.1.0 was released.

## High-risk changes with the current defaults retained

### 1. Failed imports can commit a partial batch

**Before → after — History + Code:** Rails 7.0 rolls back a written transaction exited by a non-local `return`. Rails 7.2 removes that behavior; Rails 8.1 commits absent an exception. Keeping 7.0 defaults does not restore rollback. [Removal commit](https://github.com/rails/rails/commit/eccc6061f4f3abdfdeb9a363987a898418d9498f).

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, saves rows sequentially, then executes `return false` if one note fails validation. The controller [renders an unsuccessful preview](file:///home/user/workspace/repo/app/controllers/imports_controller.rb#L8-L20).

**Risk — Inference:** A CSV with a valid first row and an invalid later row can leave the import and earlier notes committed while reporting failure. Repeating the request can duplicate those notes. Make rollback explicit while preserving the method's false/error contract; verify both database state and response for a later-row failure.

### 2. Digest date and selected notes change from UTC day to reader-local day

**Before → after — History + Code:** The 7.0.8.7 `TimeWithZoneSerializer` stores an ISO timestamp and deserializes in the worker's current zone. The target also stores the zone and restores it; older payloads without that field retain the fallback behavior. [PR #50240](https://github.com/rails/rails/pull/50240), [target serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC** date in Redis but enqueues a time in the reader's zone. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses the received time's `to_date` and `all_day` for the subject and database selection.

**Risk — Inference:** A new job can silently select a different set of notes and date its email differently, while deduplication remains tied to UTC. Old/new queued payloads can yield different digest days after deployment. Choose UTC versus local-day semantics explicitly; probe a non-UTC reader near midnight. The PR discussion initially questions format compatibility but ultimately confirms it; this is a semantic discrepancy, not an unreadable-time-payload claim.

### 3. BigDecimal digest payloads are not backward-readable by Rails 7.0 workers

**Before → after — History + Code:** Rails 7.0 treats BigDecimal as a primitive; Sidekiq's JSON turns it into a string. Rails 7.1 introduces `BigDecimalSerializer` behind a transition switch; 7.2 removes the primitive path, and the target always emits the serializer-tagged representation. [7.1 changelog and rollout warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155), [target serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

**Application:** [User#reading_completion](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) produces the value passed to [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L6-L7). [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) converts the input to BigDecimal and can accommodate the old string/new decimal distinction.

**Risk — Inference:** The mailer conversion is not the main problem: a 7.0 worker cannot deserialize a newly tagged decimal before the mailer runs. This affects rolling deployment and rollback, independently of `load_defaults`. Plan a staged serializer-compatible transition or stop old consumers before producing new-format jobs, including scheduled/retry queues.

### 4. CSV receipts silently lose citation DOIs

**Before → after — History + Code:** `read_attribute(:id)`/`record[:id]` formerly redirected to a custom primary key; now they read the literal `id` attribute. The upstream target test explicitly expects nil for a custom-key record with no `id` column. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L425-L427), [target read implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb).

**Application:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) outputs `citation[:id]`; [citations have a DOI primary key](file:///home/user/workspace/repo/db/schema.rb#L55-L62).

**Risk — Inference:** Successful receipt downloads can contain empty DOI cells without an exception. Read `citation.doi` or the primary-key-aware `citation.id` and check exported CSV contents, not merely HTTP success.

### 5. Import previews silently hide annotations

**Before → after — History + Code:** `HashWithIndifferentAccess#stringify_keys` previously left integer keys alone; Rails 8 stringifies them too. [Changelog with before/after example](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L47).

**Application:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) keys by integer source line. The [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) stringifies the hash, then still looks up `annotations[row.line]`.

**Risk — Inference:** Annotations disappear from the preview, although importing still stores them on the notes. Keep the key types consistent and check a CSV containing an annotation; multiline rows also exercise the source-line contract.

### 6. Reminder postponement preview changes across DST

**Before → after — History + Code:** Under the current 7.0 defaults, `TimeWithZone#to_time` preserves the fixed UTC offset. In Rails 8.1 it unconditionally preserves the full zone, so later arithmetic can cross a daylight-saving offset change. The old configuration setter no longer controls this method. [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22), [target implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L500).

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L40-L45) adds 86,400 seconds after `to_time`; the result is [shown on the note page](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) and used to postpone.

**Risk — Inference:** The preview's offset, abbreviation, and wall-clock time change across DST. This generally fixes the mismatch with the reader's local time; the intended elapsed interval and epoch remain 24 hours. Still a silent time-zone behavior change: cover both DST transitions rather than assuming all time arithmetic remains identical.

### 7. Negative cache TTL is removed rather than creating an already-expired entry

**Before → after — History + Code:** Previously a negative `expires_in` yielded an expired entry. The target removes the negative option and reports/logs an error when `raise_on_invalid_cache_expiration_time` is false, as it is with 7.0 defaults. With 7.1+ defaults it raises instead. [7.1 changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L867), [target implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L908-L945).

**Application:** The [export availability fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) computes `expires_at - Time.current`, including after expiry.

**Risk — Inference:** An expired export's indicator can be cached without the requested TTL, and each attempted negative TTL logs a handled error. There is **no demonstrated download-authorization bypass**: [downloadable?](file:///home/user/workspace/repo/app/models/export.rb#L45-L48) is checked in the download action independently. Avoid a negative TTL; adopting newer defaults turns this same path into a rendering exception.

### 8. Rich-text HTML parsing changes even without adopting the HTML5 sanitizer default

**Before → after — Code:** 7.0.8.7 builds fragments through `Nokogiri::HTML::Document` (HTML4). The target's `HtmlConversion` uses `ActionText.html_document_class`, which selects HTML5 when available on this CRuby/Nokogiri platform, independently of `load_defaults`. Compare [old conversion](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/lib/action_text/html_conversion.rb) with [target conversion](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/html_conversion.rb) and [parser selection](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text.rb#L46-L58).

**Application:** [Note's rich body](file:///home/user/workspace/repo/app/models/note.rb#L8), [CSV body_html assignment](file:///home/user/workspace/repo/app/models/import.rb#L101-L106), and [plain-text export](file:///home/user/workspace/repo/app/models/export.rb#L77-L81) all use this path.

**Risk — Inference:** HTML4/HTML5 repair malformed nesting and table fragments differently. Existing notes can render/export differently and saving can persist the new normalization. No stored production HTML was inspected, so affected data prevalence is unknown. Compare representative imported HTML and attachment bodies before any resave. This is distinct from the optional HTML5 sanitizer switch below.

**Additional security behavior — History + Code:** The target also sanitizes attachment `content` before producing editor/rendered attachment HTML ([source](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/content.rb#L97-L111); [7.2 history](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md)). The old endpoint does not perform this step. **Inference, data-dependent:** imported bodies containing HTML ContentAttachments can lose disallowed nested markup when edited and saved. No such stored record was inspected; ordinary uploaded blob attachments do not establish that this case is present. Include it in the rich-text round-trip review.

### 9. Local signing-key selection changes can invalidate sessions and attachment signatures

**Before → after — History + Code:** Rails 7.0 development/test uses `tmp/development_secret.txt`. Later Rails uses `tmp/local_secret.txt`, and 8.1 prefers an environment/credentials key when present even locally. [Upgrade-guide explanation](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md#L156-L163).

**Application:** [Session authentication](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17) and signed Action Text/Active Storage attachments referenced by [Note](file:///home/user/workspace/repo/app/models/note.rb#L8-L8).

**Risk — Inference, conditional:** If the effective key changes, local sessions and existing attachment signatures stop verifying. Preserve the effective key, accounting for the new precedence, rather than assuming that copying the old temporary file always suffices. Secret contents and live key selection were deliberately not inspected. This is not evidence that the production key changes; production's environment/credentials path can remain stable.

## Medium-risk changes and decisions

### 10. `Rails.application.secrets` is removed

**Before → after — History + Code:** Rails loaded `config/secrets.yml` through `application.secrets`; that API is deprecated in 7.1 and removed in 7.2. [Removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63).

**Application:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) calls it, and [citation request tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122) mutate it.

**Risk — Inference:** Enrichment raises before making its HTTP request; `Provider::Error` handling does not cover the missing API. Choose the replacement configuration contract—encrypted credentials versus an environment-backed configuration file/direct environment reads—and migrate tests with it. Do not silently change how production supplies credentials.

### 11. Built-in Sidekiq adapter is deprecated for removal in the next release

**Before → after — History + Code:** Rails 7.0 provides the adapter without this warning. Rails 8.1 retains it but says it will be removed in Rails 8.2 and directs users to Sidekiq ≥7.3.3's adapter. [Changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [explicit removal warning in source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L36-L41).

**Application:** [Adapter configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24) with the pinned Sidekiq 6.5.12.

**Risk — Inference:** This is not an 8.1 dependency-resolution blocker, but it creates a mandatory next-release decision. A Sidekiq major upgrade also needs its own review of native export jobs, Redis APIs, and queue compatibility; it was not silently included in this resolution.

### 12. The resolved JSON 3.1.0 rejects formerly accepted inputs

**Before → after — History + Code:** Relative to this Ruby's default JSON 2.7.2, JSON 3 rejects duplicate keys and comments by default, rejects invalid escapes, removes `create_additions`, and rejects unknown options. JSON 3.1 also rejects non-ASCII binary strings during generation. [Upstream history](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

**Application:** [Citation provider response parsing](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52); [serialized tags](file:///home/user/workspace/repo/app/models/note.rb#L12-L12); [digest enqueue](file:///home/user/workspace/repo/app/models/user.rb#L38-L41) and [native export enqueue](file:///home/user/workspace/repo/app/models/notebook.rb#L24-L26). Sidekiq 6.5.12's inspected `load_json`/`dump_json` use `JSON.parse`/`JSON.generate`.

**Risk — Inference, input-dependent:** A provider response with duplicate `title` keys that previously selected the last value now fails parsing and records a failed enrichment. Nonstandard stored/queued JSON or wrongly encoded strings can also be rejected. No such payload was established here; ordinary generated tag arrays and the inspected job arguments do not inherently violate the new rules. Choose whether to accept the stricter external-input contract or temporarily constrain this transitive version; inventory compatibility rather than globally disabling checks.

## If framework defaults are also advanced

These are **not automatic consequences of the requested gem-only change**. Source of truth: [8.1.0 load_defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L272-L377).

- **High, conditional — HTML5 sanitizer:** 7.1 defaults switch Action View/Action Text sanitizers from HTML4 to HTML5. The [custom allowlist](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), [imported HTML](file:///home/user/workspace/repo/app/models/import.rb#L101-L106), and [annotation simple_format](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L26-L26) need output/security review. **History + Code:** [Action Text explanation](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33). **Inference:** malformed HTML and subsequent resaves may differ; this does not imply known malicious stored content.
- **High, conditional — message/cache formats:** 7.1 defaults enable JSON-with-Marshal-fallback messages, new metadata serialization, and cache format 7.1 instead of 7.0. [Session usage](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17), signed rich-text attachments, and [export fragments](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) cross these boundaries. **History + Code:** [format history](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md). **Inference:** coordinate shared cache/message producers and consumers, including rollback; do not combine this with the first binary upgrade. JSON cookie serialization itself is already a 7.0 default here.
- **High, conditional — conditional HTTP responses:** 8.0 defaults enable `strict_freshness`: when both validators arrive, ETag takes precedence rather than requiring both to match. [ExportDownloadsController](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L13) supplies both validators. **Code:** [fresh? implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb#L38-L66). **Inference:** conflicting headers can change a 200 into a 304; authorization still runs first.
- **Medium, conditional — readonly slug:** 7.1 defaults raise on assignment to `attr_readonly`, including assignment of the unchanged value. Previously it was ignored on persistence. [Notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L8), its [hidden slug field](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L14), and [permitted update](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L40) exercise this. **Code:** [readonly writer](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/readonly_attributes.rb). **Inference:** ordinary settings saves raise; choose strict rejection versus the existing ignored-assignment contract.
- **Medium, conditional — implicit YAML coder:** 7.1 defaults remove the implicit YAML serializer; [Notebook's bare serialize :preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) then raises. **Code:** [serializer implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb). Preserve an explicit YAML coder to keep stored data readable, or deliberately migrate formats; do not mechanically substitute JSON. With current defaults YAML remains available.
- **Low, conditional — raw PostgreSQL dates:** 7.2 defaults enable date decoding; [daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) then passes a Date to `Date.iso8601`, which expects text; use the returned Date directly. **Code:** [adapter default is false](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb#L126-L132) and the load-defaults flag enables it. The changelog's “defaults to true” wording alone would overstate the risk to this app.
- The negative cache-TTL issue above becomes a rendering exception under 7.1 defaults rather than a logged warning; choose how to render expired indicators before enabling that flag.

## Low-risk mechanical changes

Each prediction below is based on **History + Code**; boot/loading or a focused feature test should expose it. “Low” describes repair complexity, not how many pages can be blocked.

- [Note's enum](file:///home/user/workspace/repo/app/models/note.rb#L10): keyword enum definitions were [removed in Rails 8](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L64-L66); use `enum :status, { draft: 0, ready: 1 }, prefix: true`, preserving integer mappings.
- [Note's tags serializer](file:///home/user/workspace/repo/app/models/note.rb#L12): positional coders were [removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L423); use `serialize :tags, coder: JSON`, not a storage-format change.
- [Highlight alias](file:///home/user/workspace/repo/app/models/note.rb#L13-L14): `color` is a store accessor, not a model attribute; [nonattribute alias_attribute support was removed](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490-L492); forward the reader/writer or use method aliases instead.
- [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3): [`allowed_tags` is now nil until overridden](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L29-L33), so `+=` raises; construct the override from the effective sanitizer defaults plus attachment tags, then append `details`/`summary`. Do not replace the defaults with only those two tags.
- [Reminder scheduling](file:///home/user/workspace/repo/app/models/note.rb#L61): [numeric scheduled_at support was removed](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55-L57); `wait_until` reaches that field, whose target serializer calls `.utc`; pass `Time.at(reminder_epoch)`.
- [Citation retry policy](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7): [`:exponentially_longer` was removed](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51-L53); `:polynomially_longer` preserves the actual old algorithm.
- [Markdown assembly](file:///home/user/workspace/repo/app/models/export.rb#L42): [Rails' nonnumeric sum override was removed](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420-L422); Ruby's default identity is zero, so use `fragments.join` or `sum("")`.
- [The /notes and /journal declaration](file:///home/user/workspace/repo/config/routes.rb#L17-L18): [multiple paths in one route call were removed](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107-L109); declare both routes separately, preserving the `notes_path` helper and alias behavior.
- [Test exception setting](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31): [boolean show_exceptions support was removed](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md); replace `false` with `:none` to explicitly preserve raising.
- [Schema file](file:///home/user/workspace/repo/db/schema.rb#L13): the next 8.1 schema dump alphabetizes columns ([PR #53281](https://github.com/rails/rails/pull/53281)); expect reviewable dump churn, not an automatic physical-column reorder.

## Areas ruled out or with no demonstrated application-specific regression

These are **Code-based scope judgments / Inference**, not guarantees about every upstream change.

- **MySQL, MariaDB, Trilogy, SQLite, sharding/replicas, encryption, composite keys:** no matching configuration/schema usage; their adapter, encryption-digest, and multi-database changes are outside this application's current path.
- **PostgreSQL advanced features:** no citext, native enum, partition, exclusion-constraint, custom batching, or bulk-upsert usage was found; basic associations/queries remain used, but no additional concrete result difference was established beyond the primary-key and opt-in date changes above.
- **After-commit enqueue:** do not apply the Rails 7.2 announcement unconditionally to the endpoint; [8.1 defaults enqueue_after_transaction_commit to false](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L43-L55), and [ApplicationJob](file:///home/user/workspace/repo/app/jobs/application_job.rb#L1-L7) does not enable it. Enqueue-under-lock behavior is not automatically deferred here.
- **Action Text validation timing:** embeds move from before-save to before-validation in 8.1; [Note's size validation](file:///home/user/workspace/repo/app/models/note.rb#L95-L98) reads body attachables directly, not the old timing of `embeds`, so no specific validation regression was established.
- **Trix 2 migration:** `action_text-trix 2.1.19` is added, but [the layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14) still loads Trix 1.3.5. Do not claim its editor fixes are adopted automatically. Gem-provided CSS/Action Text integration should be reviewed with that deliberately old editor; browser compatibility was not exercised.
- **Active Storage cloud adapters, proxies, variants, previews:** Disk is configured, image processing is absent, and the app's [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb) uses originals. Azure removal and cloud/variant changes do not require migrating this storage setup.
- **Action Mailbox and IMAP:** no inbound mailbox implementation. Resolved net-imap 0.6.8 has no identified application call site; reminder/digest delivery uses Action Mailer, not IMAP retrieval.
- **Action Cable:** only generated base classes/configuration, no application broadcasts/subscriptions found. No evidence that a Cable adapter migration is needed.
- **Action Mailer additions/removals:** delivery callbacks, previews, bulk delivery, and removed preview/test arguments have no matching use; digest argument semantics are covered above, and the mail gem itself is unchanged.
- **Active Model password features:** `has_secure_password` is used for sign-in, but no password-reset or password-changing flow is exposed; new reset-token APIs are not automatically a new route, and the password-byte-length validation change has no identified user write path here.
- **New controller APIs, rate limiting, browser gating, JSON response escaping, exotic query parsing:** no matching opt-in API or JSON-rendering path found; normal forms do not generate semicolon-separated queries or leading-bracket keys. Externally crafted legacy URLs were not inventoried.
- **Solid Queue/Cache/Cable, Propshaft, Kamal, authentication scaffolding, CI templates:** generator defaults do not replace existing dependencies, configuration, or controllers merely by changing the Rails gem.
- **Rack-session 1.0.2 / rackup 1.0.1:** inspected compatibility packages for Rack 2; the former's entrypoint is explicitly a no-op and Rack supplies session implementation. No Rack 3 session migration is implied.
- **WEBrick 1.9.2 / useragent 0.16.11:** newly resolved but no application WEBrick server or `allow_browser` call; Puma remains the configured server.
- **SecureRandom 0.3.1 → 0.4.1 / DRb 2.2.0 → 2.2.3:** SecureRandom's inspected change adds a Ruby <3.3 compatibility method, not a new output format on Ruby 3.3.6; DRb supports process-parallel testing, with no custom distributed-object use found.
- **URI 0.13.1 → 1.1.2:** the default parser constant changes, but this app's `URI.parse` [provider URL check](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) already used RFC3986 in the old implementation. No concrete http(s)-URL acceptance difference was established for this call site.
- **BigDecimal 3.1.5 → 4.1.3:** arithmetic history includes precision fixes, new math APIs, and removals, but the app uses finite integer-count division rounded to four decimal places, not the changed BigMath/divmod APIs. No independent arithmetic-result regression was established; Active Job's serialization change is the demonstrated risk. [Major-release history](https://github.com/ruby/bigdecimal/releases/tag/v4.0.0).
- **Test adapter:** [test.rb explicitly selects :test](file:///home/user/workspace/repo/config/environments/test.rb#L36-L37), so 7.2's consistent respect for queue_adapter does not make tests enqueue to production Sidekiq.

## Review limits and recommended order

This is a source-based, non-exhaustive assessment: I read release changelogs across 7.1, 7.2, 8.0, and 8.1, examined relevant PR/commit history, compared affected files in the two endpoint source archives, and inspected the resolver-selected dependencies. I did not audit every intermediate patch, every native-code change, live data, deployment secrets, or all interactions among third-party gems.

Before approving rollout, prioritize import atomicity, mixed-version queue compatibility, UTC/local digest semantics, receipt/preview contents, and stored rich-text round trips. Handle the mechanical blockers first, then assess new framework defaults separately. All predicted failures remain unexecuted by design: no application files were changed, no upgraded gems installed, no application/database tasks run, and nothing was committed or pushed.
