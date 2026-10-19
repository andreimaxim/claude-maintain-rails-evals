# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## Application facts and review assumptions

**Evidence labels:** **History** means an upstream changelog/commit; **Code** means application or framework source inspected; **Inference** means the predicted application consequence, not an executed test. Risk describes the supplied rubric, not how likely an ordinary request is to encounter the change. A beneficial silent behavior change can therefore be high risk.

- **Code:** Ruby is pinned to 3.3.6 and Rails to 7.0.8.7 in [Gemfile:4–8](file:///home/user/workspace/repo/Gemfile#L4-L8). Ruby satisfies Rails 8.1.0’s ≥3.2 requirement. This review assumes **only the Rails requirement changes**, retaining [`config.load_defaults 7.0`](file:///home/user/workspace/repo/config/application.rb#L9-L24). Adopting newer defaults is a separate decision.
- **Code:** This is an ERB/HTML application, with Sprockets, importmap, Turbo and Stimulus—not an API-only service ([Gemfile:10–29](file:///home/user/workspace/repo/Gemfile#L10-L29), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L1-L14)). Forms use `require`/`permit`, not the new `expect` API.
- **Code:** PostgreSQL is the single application database; `pg` stays at 1.6.0. The schema contains JSON text tags, JSONB settings, YAML-serialized notebook preferences, and citations whose primary key is `doi`, not `id` ([schema:55–109](file:///home/user/workspace/repo/db/schema.rb#L55-L109), [Note:10–14](file:///home/user/workspace/repo/app/models/note.rb#L10-L14), [Notebook:7–8](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8)). **Unknown:** deployed PostgreSQL version and database contents; neither was queried.
- **Code:** Active Job uses Sidekiq 6.5.12/Redis 4.8.1 outside tests; exports are native Sidekiq jobs ([application:22–24](file:///home/user/workspace/repo/config/application.rb#L22-L24), [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L12)). Tests explicitly use Active Job’s test adapter and Sidekiq testing ([test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L25-L40), [test helper](file:///home/user/workspace/repo/test/test_helper.rb#L1-L12)). **Inference:** mixed old/new workers are possible during deployment; the actual rollout strategy is unknown.
- **Code:** Action Text bodies accept editor and CSV HTML, extend the sanitizer allowlist, and use local Disk blobs. The browser explicitly loads **vendored Trix 1.3.5**, while CSS requires the gem’s `trix` asset ([initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), [layout:10–14](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14), [CSS:1–7](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L7)). Images render original blobs; no image processor is installed ([blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L15)).
- **Code:** Production enables controller caching without overriding Rails’ default FileStore; development uses MemoryStore or NullStore and tests use NullStore. Redis is **not** the Rails cache ([production:15–16,58–65](file:///home/user/workspace/repo/config/environments/production.rb#L15-L65), [development:20–34](file:///home/user/workspace/repo/config/environments/development.rb#L20-L34)). Export availability is cached with a computed TTL.
- **Code:** Sign-in uses cookie sessions; reminders and digests deliver plain-text mail. Development delivers to files; tests use test mail delivery. Production delivery infrastructure is not established by repository configuration. Citation enrichment reads `Rails.application.secrets` ([provider:13–15](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15)). Credentials and secret values were not inspected.

### Dependency resolution—not an installation

In a disposable copy of **both** Gemfile and Gemfile.lock, I changed only `rails` to `8.1.0` and ran `bundle lock --update rails` with Ruby 3.3.6/Bundler 2.5.22. Resolution succeeded against RubyGems on 2026-10-19. **Successful resolution does not establish runtime compatibility**; JSON below is a concrete counterexample. The [lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff) records the result.

| Resolved change | Consequence for this review |
| --- | --- |
| `rails` plus twelve lockstep components (including `railties`): 7.0.8.7 → 8.1.0 | Active Record, Active Job, Action Text, etc. are included, not just the Rails meta-gem. |
| New `action_text-trix` 2.1.19 | Gem-provided Trix assets change; the layout’s explicit vendored JS does not automatically change. |
| Newly locked `json` 3.1.0, `bigdecimal` 4.1.3, `uri` 1.1.2, `drb` 2.2.3, `securerandom` 0.4.1 | The inspected Ruby installation previously provides 2.7.2, 3.1.5, 0.13.1, 2.2.0 and 0.3.1 respectively. These were absent from the old lockfile, so another runtime’s baseline could differ. |
| New `rack-session` 1.0.2, `rackup` 1.0.1, `useragent` 0.16.11, `webrick` 1.9.2 | Compatibility/support dependencies, not an automatic Rack 3 migration. |
| `net-imap` 0.6.7 → 0.6.8; `method_source` 1.1.0 removed | No application IMAP consumer or method_source call found. |
| Rack stays 2.2.24; Sidekiq stays 6.5.12; Redis stays 4.8.1 | Rails 8.1 permits Rack ≥2.2.4; Sidekiq’s Rack ~>2.0 constraint remains satisfiable. |
| Puma, PG, Faraday, Pagy, Sprockets, importmap, Turbo, Stimulus, Nokogiri, HTML sanitizer, mail and test gems stay locked | Do not attribute changes from hypothetical upgrades of these gems to this result. |

**Scope:** I read the Rails 7.1, 7.2, 8.0 and 8.1 component changelogs, additional patch histories through 7.1.5.2/7.2.2.2/8.0.3, relevant commits, and the released endpoint source differences. I also unpacked newly resolved gems and compared relevant source/history. This is a prioritized static review, not an exhaustive certification of every intervening commit. No new gem was installed; no application process, tests, migrations, or database reads were run.

## High-risk changes

### H1. Failed CSV imports can commit a partial batch

**History + Code:** Rails 7.0 rolls back a written transaction exited by a non-local `return`; Rails 7.2 removes that behavior and commits unless an exception/rollback occurs. This is unconditional in 8.1, even with 7.0 defaults. See the [removal commit](https://github.com/rails/rails/commit/eccc6061f4f3abdfdeb9a363987a898418d9498f).

**Application:** [`Import#apply`, lines 50–60](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and each row, then executes `return false unless row.note.save` inside the transaction.

**Inference:** A valid first row followed by an invalid second row now leaves the import, first note, and associated records committed, even though the controller renders failure and the preview says nothing was saved. Resubmission can duplicate those notes. Preserve all-or-nothing semantics with an explicit rollback/exception and a deliberate result outside the transaction. The existing [invalid-row test](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L72) is an important future check; it was not run here.

### H2. Annotations silently disappear from import previews

**History + Code:** `HashWithIndifferentAccess#stringify_keys` formerly duplicated the hash, leaving integer keys unchanged; Rails 8.0 actually stringifies those keys. The [fix commit](https://github.com/rails/rails/commit/e8574542f88695329e7324f864b9048b0ba0da1b) explicitly describes this compatibility change.

**Application:** [`Import#annotations`](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) uses integer source-line keys. The [preview:22–44](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys`, then looks up `annotations[row.line]` using an integer.

**Inference:** The lookup returns nil and omits the annotation without an error. The CSV and stored annotation remain present: this is a misleading preview, not deletion of the annotation. Align the key type or avoid unnecessary conversion.

### H3. CSV receipts lose DOI values

**History + Code:** In 7.0 `read_attribute(:id)` translates `id` to the custom primary key. That translation is removed in 7.2; reading a nonexistent `id` now returns nil. See [7.2 Active Record removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md) and the [8.1 read implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb).

**Application:** [`Import#receipt`:63–69](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) writes `citation[:id]`; [citations use `doi` as their key](file:///home/user/workspace/repo/db/schema.rb#L55-L62).

**Inference:** The CSV’s DOI cells become blank even though the citations and HTML receipt remain intact. Use the actual DOI attribute or the primary-key-aware `citation.id` method; do not mechanically preserve bracket access.

### H4. Digests change from UTC days to reader-local days

**History + Code:** Old Active Job `TimeWithZone` serialization stores an instant/offset but deserializes in the worker’s zone. New serialization includes the named time zone and restores it; old payloads without that field retain the old fallback. This landed in the 7.1 patch line as well as 7.2. See the [serializer fix](https://github.com/rails/rails/commit/18098ccc4c837278c42d9757dd2b1e0bdd2016e0).

**Application:** [`User#request_digest`:34–41](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC** day in Redis but queues a reader-zoned time. [`DigestMailer`:6–12](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses the received time’s `to_date` and `all_day` for the subject and note query.

**Inference:** A request at 2026-10-05 03:30 UTC from an Eastern-time reader changes from an October 5 UTC digest to an October 4 local digest. The deduplication day remains October 5 UTC. New and old jobs/workers can therefore select different notes for the same request. Decide explicitly whether digests follow UTC or local days and align both reservation and selection; do not simply update expected dates in tests. The [existing boundary test](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L37) documents the current UTC contract.

### H5. BigDecimal job arguments are not backward-readable by 7.0 workers

**History + Code:** Rails 7.0 treats BigDecimal as a primitive; Sidekiq’s JSON transport turns it into a decimal string. Rails 7.1 adds a named BigDecimal serializer and 7.2 removes the legacy serialization path. New workers receive a BigDecimal again. Sources: [7.1 Active Job changelog](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removals](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

**Application:** [`User#reading_completion` and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) put a BigDecimal into `DigestJob`; the [mailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) converts the received value with `BigDecimal(...)`.

**Inference:** A 7.0 worker cannot resolve `ActiveJob::Serializers::BigDecimalSerializer` in a newly produced payload, causing deserialization/retries. New workers can still consume the old string argument, and the mailer conversion accepts both forms. A rollback to old workers with new jobs queued is unsafe. Plan queue draining/version separation or a transitional wire contract before mixing producers and consumers. This is separate from the independently resolved BigDecimal gem version.

### H6. Reminder previews retain the full time zone rather than a fixed offset

**History + Code:** With 7.0 defaults, `TimeWithZone#to_time` retains a fixed UTC offset. Rails 8.1 always returns a Time carrying the receiver’s full zone; the old configuration no longer controls it. See the [8.1 removal commit](https://github.com/rails/rails/commit/c79dc282d687cff1c5dc81e19d27257dca5e6a80).

**Application:** [`Note#next_day_reminder_at`:40–44](file:///home/user/workspace/repo/app/models/note.rb#L40-L44) does `reminder_at.to_time + 86_400`; the [reminder partial](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays that result, and [postponement](file:///home/user/workspace/repo/app/models/note.rb#L71-L73) converts it back to epoch seconds.

**Inference:** Across DST, the displayed offset and wall-clock time change. The result still represents **24 elapsed hours later**, so this is not evidence that the reminder sends an hour early/late. It corrects the old fixed-offset preview, but the time-zone contract changes silently and cannot be restored using `load_defaults 7.0`. Review spring/fall boundaries separately from the numeric scheduling API removal below.

### H7. Negative cache TTLs become entries without that expiry

**History + Code:** Rails 7.0 accepts a negative `expires_in`, producing an already-expired entry. New cache code deletes the negative expiry option and reports/logs an error when `raise_on_invalid_cache_expiration_time` is false—which it remains under 7.0 defaults. With 7.1 defaults it instead raises. Sources: [7.1 cache changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [8.1 option handling](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L907-L945).

**Application:** The [export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) passes `export.expires_at - Time.current` for every completed export, including expired ones.

**Inference:** Viewing an expired export can now store its “Expired” indicator without a TTL, rather than immediately expiring it; adopting 7.1 defaults can turn the same page into an exception. Prefer explicit handling of past deadlines rather than assuming a negative TTL disables caching. This does **not** bypass download authorization: [the download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) independently checks ownership and expiry before conditional responses.

### H8. Local signing-key selection can invalidate sessions and stored attachment signatures

**History + Code:** Rails 7.0 normally generates the development/test secret in `tmp/development_secret.txt`; 7.1 changes that to `tmp/local_secret.txt`. The target also prefers `SECRET_KEY_BASE`/credentials locally before generating a key. See the [upgrade guide](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed) and [8.1 key selection](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L526-L546).

**Application:** [Sign-in stores session user IDs](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17); [rich-text bodies](file:///home/user/workspace/repo/app/models/note.rb#L8) and [blob URLs](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L12) depend on signatures.

**Inference, conditional:** If the effective key changes, local sessions and signed attachments stop validating; retaining the underlying files does not repair old signatures. Preserve the effective key intentionally, accounting for the new precedence—not only the filename. I did not read key values or establish that this installation will change keys. Production is not affected by the local filename change; its removed secrets fallback needs review only if deployment actually relied on it.

### H9. Rich-text content attachments are interpreted and sanitized differently

**History + Code:** Rails 7.0’s content-attachment implementation recognizes a special horizontal-rule content type. Newer Rails supports arbitrary HTML content attachments; later security fixes sanitize an attachment’s `content` before rendering it for Trix and omit empty sanitized content. Sources: [7.1 Action Text history](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [7.2 history](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md), [8.1 attachment rendering](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/content.rb#L97-L107).

**Application:** [CSV bodies are assigned directly to Action Text](file:///home/user/workspace/repo/app/models/import.rb#L100-L108), edited through [the rich-text field](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L48-L51), rendered on [note pages](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L31), and converted to plain text in [exports](file:///home/user/workspace/repo/app/models/export.rb#L77-L81).

**Inference, content-dependent:** Imported or existing bodies with `action-text-attachment` content can render/export differently or lose stripped markup after an edit/save round trip. Ordinary blob attachments do not prove this case is present; stored bodies were not inspected. Review such bodies and retain sanitization rather than restoring unsafe content handling. This change is distinct from the optional HTML5 sanitizer default and from the definite initializer error listed below.

### H10. Uploaded filenames gain additional substitutions

**History + Code:** Active Storage now replaces `<`, `>`, `?`, `*` and `"` with `-` in `Filename#sanitized`, in addition to the prior unsafe-character set. See [8.0 Storage history](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md) and [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activestorage/app/models/active_storage/filename.rb#L55-L69).

**Application:** The [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L12) displays names and links to downloads; [Markdown export downloads](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L9-L12) also call `filename.to_s`.

**Inference, filename-dependent:** A name such as `draft?.pdf` becomes `draft-.pdf` in display/download output without changing the stored blob key. Generated export slugs are already normalized, so arbitrary uploaded attachments are the main exposure. High under the silent data-format rubric, but narrow practical impact; check any filename-based user workflow.

### H11. Eligible database reads now reconnect and retry automatically

**History + Code:** Since 7.1 Rails can reconnect safely mid-request, and later releases expand automatic retries to known-idempotent Arel SELECTs, association lookups and `exists?`. The default connection retry count is one; Rails tracks query retryability and transaction state rather than blindly retrying writes. Sources: [7.1 connection change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2 SELECT change](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.1 retry implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract_adapter.rb#L1020-L1120).

**Application:** [Current-user lookup](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L8) and [owned-note lookup](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L58-L60) use eligible model/association queries; [database configuration](file:///home/user/workspace/repo/config/database.yml#L16-L22) does not disable retries.

**Inference, outage-dependent:** An eligible read that used to fail may instead succeed after reconnecting, take longer, and observe later committed data. This is generally beneficial, but changes failure/latency semantics without an application exception. Review failover expectations; do not infer that entire imports or reminder transactions are automatically replayed. New pool-sizing options themselves do not require changing the existing `pool` setting.

## Medium-risk changes

### M1. Citation-provider configuration loses the secrets API

**History + Code:** `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2 ([Railties removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md)). Rails no longer loads `config/secrets.yml` through that API.

**Application:** [`Citation::Provider#initialize`:13–15](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) reads it by default; [provider tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122) also override it.

**Inference:** Enrichment fails before making an HTTP request. This is not a provider-unavailability retry: the missing API raises outside the provider’s handled error classes, so native Sidekiq retries can leave the citation pending. Choose credentials or an explicit environment-backed configuration source and migrate the test seam too. A blind rename does not preserve the existing `secrets.yml` loading contract.

### M2. Built-in Sidekiq adapter is deprecated for removal in Rails 8.2

**History + Code:** Rails 8.1 still includes its Sidekiq adapter, but warns that it will disappear in 8.2 and directs applications to Sidekiq ≥7.3.3 for the gem-owned adapter ([8.1 adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L35-L40)).

**Application:** [`config.active_job.queue_adapter = :sidekiq`](file:///home/user/workspace/repo/config/application.rb#L22-L24) uses the Rails adapter with [Sidekiq pinned to 6.5.12](file:///home/user/workspace/repo/Gemfile#L34-L36).

**Inference:** This is not a requirement to upgrade Sidekiq to run 8.1.0, nor a resolution blocker. It is medium because removal is announced for the next minor release. Decide whether to keep the deprecated adapter for this step or plan a separate Sidekiq/Redis/Rack upgrade; that separate upgrade needs its own argument and deployment review. The existing Sidekiq 6.5.12 Rails logger integration already handles `BroadcastLogger`, so I did not flag the obsolete logging API as an additional failure.

### M3. The newly resolved JSON 3.1.0 is incompatible with Rails 8.1.0’s decoder

**History + Code:** The old runtime’s JSON 2.7.2 accepts an options hash as a second positional argument. JSON 3.1.0 defines `parse(source, on_load: nil, object_class: nil, array_class: nil, **options)`, whereas Rails 8.1.0 still calls `::JSON.parse(json, options)`. Sources: [JSON 3 changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md), [JSON parser signature](https://github.com/ruby/json/blob/v3.1.0/lib/json/common.rb#L291-L298), [Rails decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb#L24-L25).

**Application:** [JSONB settings and serialized tags](file:///home/user/workspace/repo/app/models/note.rb#L12-L14) pass through Rails JSON decoding; cookie-session decoding also uses Rails JSON. This mismatch follows directly from the inspected Ruby signatures; it was not executed.

**Inference:** Ordinary decoding will raise `ArgumentError` after the earlier boot blockers are addressed. Decide whether to constrain JSON to a compatible release or choose a Rails/dependency combination that supports JSON 3. Do not treat lockfile success as an upgrade-ready bundle, or assume an application-level positional-to-keyword edit fixes Rails internals.

JSON 3 also rejects duplicate object keys and comments by default and rejects additional malformed encodings. The provider’s direct [`JSON.parse(body)`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) uses a compatible one-argument call, but previously accepted provider responses containing duplicate keys/comments would now become handled enrichment failures. Decide whether such nonstandard provider data should remain accepted; its presence has not been established.

## Low-risk, mechanical changes

Each item below is **History + Code**, with the predicted failure/fix inferred from those sources; none was executed.

- **Enum declaration:** [Note:10](file:///home/user/workspace/repo/app/models/note.rb#L10) uses removed keyword-style enum syntax; use `enum :status, { draft: 0, ready: 1 }, prefix: true`, preserving numeric values and method names ([8.0 AR removals](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md)).
- **JSON serializer declaration:** [Note:12](file:///home/user/workspace/repo/app/models/note.rb#L12) passes the removed positional coder; use `serialize :tags, coder: JSON`, preserving stored JSON rather than changing the format ([7.2 AR removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md)).
- **Alias of a store accessor:** [Note:13–14](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) aliases `color`, which is a JSONB store accessor, not a model column; new AR raises when generating the alias—use explicit reader/writer delegation or method aliases for both directions ([7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb#L87-L98)).
- **Action Text initializer:** [initializer:3](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) does `nil + [...]` because `allowed_tags` now defaults to nil, with fallback applied at runtime; initialize from the effective sanitizer tags **plus attachment tags** before extending it, not just `%w[details summary]` ([upstream fix](https://github.com/rails/rails/commit/e8137c527dd6bd43f695b472f440cab7466243a6)).
- **Multi-path route:** [routes:18](file:///home/user/workspace/repo/config/routes.rb#L17-L19) passes `/notes` and `/journal` to one `get`; support was removed in 8.1—split them into two declarations, preserving the `notes_path` helper and alias behavior ([8.1 Action Pack removals](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md)).
- **Retry wait name:** [CitationEnrichmentJob:7](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must replace removed `:exponentially_longer` with `:polynomially_longer`; the rename describes the existing polynomial backoff, not a reason to change attempt counts ([7.1 history](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md)).
- **Numeric scheduling:** [Note:61](file:///home/user/workspace/repo/app/models/note.rb#L56-L62) passes an epoch integer to `wait_until`; 8.1 stores it directly as `scheduled_at` then serializes with `.utc`, requiring a Time-like object—convert the same epoch with `Time.at` ([7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 core](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb)).
- **String summation:** [Export:42](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) relies on the removed Active Support `sum` override; Ruby’s zero identity cannot sum strings—use `fragments.join` or an explicit empty-string identity ([7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md)).
- **Exception configuration:** [test.rb:31](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) must change `false` to `:none`; the target no longer maps booleans and otherwise treats it like `:all`, turning expected raised exceptions into error responses ([7.2 removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md), [target switch](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb#L185-L199)).
- **Test database names:** [parallel test setup](file:///home/user/workspace/repo/test/test_helper.rb#L7-L12) inherits the 8.1 change from `-N` to `_N` database suffixes; review test-role create/drop permissions and any external cleanup scripts, not production database names ([8.1 AR history](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md)).

## Not active, or no application-specific regression established

These are **Code-based exclusions/inferences**, not a declaration that the entire subsystem is risk-free.

- **PostgreSQL automatic date decoding:** disabled under retained 7.0 defaults (`decode_dates` defaults false); [Notebook:38–40](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) still receives strings. Enabling 7.2 defaults would instead make `Date.iso8601(day)` receive a Date and raise ([configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L322-L334)).
- **Readonly assignment errors:** the 7.1 opt-in is not enabled; [Notebook’s readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) retains old behavior. Enabling it would make [the settings form’s unchanged slug submission](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L14) raise too; decide how to remove that assignment before adopting defaults.
- **YAML default serializer removal:** gated by 7.1 defaults, so [`serialize :preferences`](file:///home/user/workspace/repo/app/models/notebook.rb#L7) still gets YAML. Adopting new defaults requires an explicit coder that reads existing YAML, not a silent conversion to JSON.
- **HTML5 sanitizer default:** gated by 7.1 defaults; HTML4 remains selected here. This does not avoid H9 or the `allowed_tags` initializer break. Review persisted HTML separately if opting into HTML5.
- **HTTP strict freshness:** gated by 8.0 defaults; [export `stale?`](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L12) retains the requirement that both supplied validators match. New defaults prioritize ETag over Last-Modified; authorization remains outside that check.
- **New cache/message formats and signed-ID verifier defaults:** not automatically adopted with `load_defaults 7.0`; cache format stays 7.0 and legacy configuration paths remain. Preserve the actual key as described in H8 rather than assuming all old signatures are invalidated by a version bump.
- **Automatic job deferral until commit:** despite the 7.2 feature announcement, target 8.1’s `enqueue_after_transaction_commit` defaults to **false**, and neither [ApplicationJob](file:///home/user/workspace/repo/app/jobs/application_job.rb#L1-L7) nor individual jobs opt in ([target source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L41-L52)); do not claim [citation](file:///home/user/workspace/repo/app/models/citation.rb#L14-L23) or [reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) enqueues automatically move outside their locks.
- **Action Text/Trix asset packaging:** `action_text-trix` 2.1.19 supplies new CSS, but [vendored JS 1.3.5](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14) still executes. The target’s `actiontext.js` supports side-effect loading; no definite import failure was established. Review the mixed CSS/JS versions; a coherent Trix 2 migration and its editor/security behavior would be additional work, not something this gem bump completes ([8.1 packaging history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md)).
- **Action Text embed callback timing / blob autosave:** embeds move to `before_validation`, and blobs stop autosaving attachments; the app uses normal rich-text/attachment ownership and inspects `body.attachables` directly for size. No custom callback depending on the former timing or direct blob-side attachment mutation was found.
- **Storage variants, previewers, S3/GCS/Azure:** Disk-only configuration, original-image rendering, no processor/custom service; cloud service and transformation changes have no matching configured consumer.
- **Action Cable:** only generated base classes/configuration, no application broadcasts/subscriptions; Redis reconnection, ping, composite-stream and protocol changes have no implemented feature to affect.
- **Action Mailbox:** no application mailboxes/ingress feature; inbound parsing and routing changes are not used.
- **Action Mailer’s new bulk delivery/callback/preview APIs:** mailers use ordinary `deliver_now`; no custom delivery callbacks, preview paths or `deliver_all_later` usage. Digest argument behavior is covered above.
- **MySQL/SQLite/Trilogy, sharding, multiple databases, composite keys, AR encryption:** no matching database configuration or model feature; PostgreSQL’s single string DOI key is covered separately, not mistaken for a composite key.
- **New SQL/batch/upsert/CTE APIs and their deprecations:** no matching application calls; pagination uses existing Pagy integer limits and ordinary ordered relations.
- **Password byte-length validation, password challenges and reset tokens:** `has_secure_password` is used, but there is no password-setting/reset endpoint; account updates permit only `time_zone`, and existing login does not run password creation validation. Seed/fixture passwords are short ASCII; no affected password-write case was found.
- **Rack 3 status/header changes:** not part of this resolution; Rack remains 2.2.24. `rack-session` 1.0.2 is a Rack-2 compatibility/no-op require shim, and `rackup` 1.0.1 keeps Rack 2 compatibility ([session compatibility](https://github.com/rack/rack-session/tree/v1.0.2)).
- **URI 0.13.1 → 1.1.2:** source changes the `DEFAULT_PARSER`/`Parser` constants to RFC3986, but the app’s [provider `URI.parse`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) already used RFC3986 in the old version; relevant split behavior is unchanged. Deprecated escape/extract compatibility wrappers remain. No changed provider URL case was established ([source comparison](https://github.com/ruby/uri/compare/v0.13.1...v1.1.2)).
- **BigDecimal 3.1.5 → 4.1.3:** arithmetic/precision fixes and removed `precs`/changed `divmod` were reviewed, but [the app](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) uses finite integer counts, `/` and four-place `round`, not those removed APIs or BigMath. No changed application result established; do include asymmetric completion ratios in later verification. The concrete mixed-worker payload risk is H5 ([history](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md)).
- **DRb 2.2.0 → 2.2.3:** default object-ID lookup becomes an internal weak-map lookup; Rails uses DRb for the existing parallel test runner, but the app defines no DRb ID converter/service. No specific runner incompatibility established; parallel tests remain a later check ([source comparison](https://github.com/ruby/drb/compare/v2.2.0...v2.2.3)).
- **SecureRandom 0.3.1 → 0.4.1:** inspected changes add compatibility code for Ruby <3.3; that path is inactive on Ruby 3.3.6, with no custom app random generator.
- **net-imap 0.6.7 → 0.6.8:** changes include sequence-set coercion and Ractor/configuration fixes; no IMAP consumer. `mail` itself remains 2.9.1 ([diff](https://github.com/ruby/net-imap/compare/v0.6.7...v0.6.8)).
- **WEBrick/useragent:** Puma remains the configured server and `allow_browser` is not invoked; no app feature adopts either newly available API.
- **Removed method_source:** no direct app usage; it is no longer a Railties dependency, not an application API migration.
- **Asset pipeline/Solid Queue/Solid Cache/Solid Cable/Kamal/authentication generator:** new-application generator choices do not rewrite this app or install those gems. Existing Sprockets, Sidekiq, Redis and custom session authentication remain.
- **Autoload paths, `cache_classes`, logging:** no manual requires of autoloaded application classes were found; `cache_classes` remains a supported alias, and standard configured loggers are wrapped by BroadcastLogger. No application-specific mechanical edit is required on that evidence.
- **Schema column sorting:** 8.1 alphabetizes dumped columns; this changes future `schema.rb` output, not the live table layout. No positional schema consumer was found ([upstream change](https://github.com/rails/rails/pull/53281)).

The highest-priority decisions are preserving import atomicity and digest-day semantics, choosing a compatible JSON resolution, and planning job payload coexistence. Fixing only the visible boot errors would leave the silent data changes above unresolved. All application files and the original Gemfile.lock remain unchanged; this report is not a tested or installed upgrade.
