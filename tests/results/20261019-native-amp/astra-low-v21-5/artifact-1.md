# Rails 7.0.8.7 → 8.1.0: application-specific risk review

## Application facts and scope

Evidence labels throughout: **History** = upstream changelog/PR; **Code** = application and released framework/dependency source inspected; **Inference** = predicted consequence, not executed behavior.

- **Code:** Ruby is pinned to 3.3.6, Rails to 7.0.8.7, and framework defaults to **7.0** ([Gemfile](file:///home/user/workspace/repo/Gemfile#L4-L8), [application configuration](file:///home/user/workspace/repo/config/application.rb#L12-L24)). Ruby meets Rails 8.1's >=3.2 requirement. This report assumes changing the Rails gem requirement, **not** changing `load_defaults`, regenerating the app, or upgrading Sidekiq separately.
- **Code:** PostgreSQL with `pg 1.6.0`, one database per environment; no sharding or replicas ([database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L26)). Notes use JSON text tags and jsonb settings; notebooks use YAML preferences; citations use a DOI string primary key ([schema](file:///home/user/workspace/repo/db/schema.rb#L55-L109)). The running PostgreSQL server version was not queried.
- **Code:** ERB HTML, Sprockets, importmap, Turbo, Action Text, and local Disk Active Storage; no image-processing dependency. The layout explicitly loads **vendored Trix 1.3.5**, not the gem's JavaScript ([layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14)); CSS still requires the gem's `trix` stylesheet ([stylesheet](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L7)). CSV imports accept rich HTML and annotations.
- **Code:** Active Job uses Sidekiq 6.5.12/Redis 4.8.1 outside tests; exports are native Sidekiq jobs ([configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24), [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10)). Tests explicitly use the test adapter. Digests enqueue zoned times and BigDecimals; reminders enqueue epoch integers.
- **Code:** Fragment caching is enabled in production, with no cache-store override (Rails' FileStore fallback); development uses MemoryStore when enabled, otherwise NullStore; tests use NullStore ([production](file:///home/user/workspace/repo/config/environments/production.rb#L15-L17), [development](file:///home/user/workspace/repo/config/environments/development.rb#L20-L34), [test](file:///home/user/workspace/repo/config/environments/test.rb#L25-L37)). Redis is used for jobs and digest reservations, not Rails caching.
- **Code:** Session authentication uses `session[:user_id]`; Action Text attachments use signed blob URLs. Mail is delivered synchronously from jobs, to files in development and the test delivery array in tests; production delivery is not configured explicitly. Citation-provider settings are read through `Rails.application.secrets` ([provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L14)). No secret values or encrypted credentials were inspected.

### Actual dependency resolution

**Observed resolver output:** Copied Gemfile/Gemfile.lock into an isolated temporary directory, changed only the Rails requirement, and ran `bundle lock --update rails` using Ruby 3.3.6/Bundler 2.5.22. Resolution succeeded on October 19, 2026; nothing was installed. [Full lockfile delta](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

| Change | Resolved result |
|---|---|
| Rails and its 12 component gems | 7.0.8.7 → 8.1.0 |
| Existing non-Rails gem upgraded | net-imap 0.6.7 → 0.6.8 |
| New lockfile entries | action_text-trix 2.1.19; bigdecimal 4.1.3; drb 2.2.3; json 3.1.0; rack-session 1.0.2; rackup 1.0.1; securerandom 0.4.1; uri 1.1.2; useragent 0.16.11; webrick 1.9.2 |
| Removed | method_source 1.1.0 |
| Important unchanged gems | Rack 2.2.24, Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, pg 1.6.0, Faraday 1.10.4, Pagy 8.6.3; Turbo, importmap, Sprockets, Nokogiri and rails-html-sanitizer also remain locked |

**Code:** The currently installed Ruby default gems provide bigdecimal 3.1.5, json 2.7.2, drb 2.2.0, securerandom 0.3.1 and uri 0.13.1. Their new explicit dependencies therefore matter even though they had no previous lockfile entries. **Inference:** A later resolution may select different transitive versions; the JSON 3 finding below belongs to this actual resolution, not to Rails 8.1's minimum requirements. Rack 3 migration advice is not applicable to this bundle.

## High-risk changes

### H1. Failed imports can now commit partial batches

**History:** Rails 7.1 introduced committing on non-local transaction exits; 7.2 removed the old rollback behavior ([7.2 Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md)). **Code:** Compared `within_new_transaction` in both release tags: 7.0 rolls back a written transaction whose block exits early; 8.1 commits on `return` unless an exception/thread abort intervenes.

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and each note, then uses `return false unless row.note.save` *inside* the transaction. The controller revalidates submitted CSV rather than requiring an earlier successful preview ([create](file:///home/user/workspace/repo/app/controllers/imports_controller.rb#L8-L19)).

**Inference:** A valid first row followed by an invalid row now leaves the import, earlier notes, and potentially citations committed while reporting failure. This is durable partial data, not a boot error. Explicit rollback/exception handling is needed to preserve all-or-nothing semantics; `load_defaults 7.0` cannot retain the removed behavior.

### H2. Digest day changes from UTC to the reader's zone

**History:** Active Job fixed TimeWithZone deserialization in 7.1.2 and included it in 7.2 ([history](https://github.com/rails/rails/blob/v7.1.5.2/activejob/CHANGELOG.md)). **Code:** The [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb) writes `time_zone` and restores it; 7.0 writes only the timestamp/offset and restores the worker's zone.

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC date** but enqueues time in the reader's zone. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses the deserialized value's `to_date` and `all_day` for the subject and query.

**Inference:** New jobs select a local calendar day rather than a UTC calendar day. Near midnight, subject/date and note membership change while deduplication remains UTC-based. Old payloads lacking `time_zone` retain the fallback; mixed producers/consumers can yield different content. Choose the digest's intended day explicitly before upgrading.

### H3. BigDecimal job payloads are not backward-readable by Rails 7.0 workers

**History:** Rails 7.1 added a BigDecimal serializer; 7.2 removed primitive serialization; 8.0 removed the opt-out ([7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removals](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md)). **Code:** [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb) emits an `_aj_serialized` object rather than leaving a decimal to become a JSON string.

**Application:** [reading_completion and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) pass a BigDecimal through Sidekiq; [mailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) converts the received value with `BigDecimal(...)`.

**Inference:** Old jobs containing decimal strings remain usable by the new mailer, and newly deserialized BigDecimals also fit that conversion. The dangerous direction is **new producer → old worker**: 7.0 lacks `ActiveJob::Serializers::BigDecimalSerializer` and cannot deserialize the payload. Queue isolation/draining or a staged serializer-compatible rollout is necessary; rollback to old workers with new queued payloads is also risky.

### H4. Import preview annotations disappear silently

**History:** Rails 8.0 fixed `HashWithIndifferentAccess#stringify_keys` to stringify integer keys too ([changelog example](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md)). **Code:** Before, integer keys survived; after, they become strings.

**Application:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L38-L41) keys by integer CSV source-line number. The [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys` and then still looks up `annotations[row.line]` with an integer.

**Inference:** The annotation section disappears without an exception, including for multiline CSV rows. This does **not** delete the annotation from the eventual saved note; it hides information during review. Keep the key representation consistent.

### H5. CSV receipts lose DOI values

**History:** Rails 7.2 removed `read_attribute(:id)` redirecting to a custom primary key ([changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md)). **Code:** `[]` calls `read_attribute`; the 8.1 implementation no longer translates `id` to the model primary key. A nonexistent `id` column reads as nil here.

**Application:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) uses `citation[:id]`, while [citations' primary key](file:///home/user/workspace/repo/db/schema.rb#L55-L61) is `doi` and there is no `id` column.

**Inference:** The generated CSV has blank DOI cells, although the HTML receipt still calls `citation.doi`. Use the DOI accessor or primary-key-aware `id` method. Rated high despite a small fix because exported data silently changes.

### H6. Reminder previews now follow daylight-saving transitions

**History:** Rails 8.1 removed old `to_time` preservation behavior ([changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md)). **Code:** 7.0's TimeWithZone conversion preserves a fixed numeric offset with this app's defaults; [8.1 `to_time`](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb) unconditionally constructs a Time with the named zone. This is not held back by `load_defaults 7.0`.

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) adds 86,400 seconds to `reminder_at.to_time`; [postponement](file:///home/user/workspace/repo/app/models/note.rb#L71-L72) converts that result to an epoch.

**Inference:** Across a DST boundary the displayed offset/wall time changes; the postponed **instant remains 24 elapsed hours later**. For example, New York's October 31, 2026 09:00 reminder previews November 1 09:00 −04:00 under the old fixed offset, versus 08:00 −05:00 under zone-aware conversion. Review presentation expectations; do not confuse this fix with a change to “same local time tomorrow.”

### H7. Negative fragment-cache lifetimes no longer mean immediately expired

**History:** Rails 7.1 introduced invalid-expiry handling ([changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md)). **Code:** [8.1 `merged_options`](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb) deletes a negative `expires_in` before reporting it. With retained 7.0 defaults it reports/logs instead of raising; the entry uses the store's default expiry, potentially none. 7.0 passed the negative TTL through, making the entry expired.

**Application:** The [completed-export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) always passes `export.expires_at - Time.current`, including already expired exports.

**Inference:** Expired indicators can now be cached without a TTL, with error reporting on writes; lifetime semantics and cache retention change silently. This does **not** bypass authorization or permit expired downloads: [download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L5-L15) checks `downloadable?` separately. If 7.1+ defaults are adopted, the same input instead raises and breaks the page. Avoid writing this fragment with a negative lifetime.

### H8. Development/test signing keys may change

**History:** 7.1 changed the generated key file from `tmp/development_secret.txt` to `tmp/local_secret.txt`; 8.1 also prefers environment/credentials keys locally ([upgrade guide](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md#development-and-test-environments-secret_key_base-file-changed), [8.1 Railties history](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md)). **Code:** Compared old `Application#secret_key_base` and new configuration implementation.

**Application:** [session authentication](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17), [rich text](file:///home/user/workspace/repo/app/models/note.rb#L8), and [signed blob links](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L3-L11) depend on signing.

**Inference, conditional:** If the effective key changes, existing local sessions, signed URLs and persisted Action Text attachment identifiers can become invalid. Preserve the effective old key or plan rotations. No key contents or deployed configuration were inspected, so actual key continuity is unknown. The filename change alone is not a production-key change.

### H9. Embedded HTML content is sanitized before reaching the editor

**History:** Action Text 7.1.3.4 added ContentAttachment sanitization for the Trix edit view, followed by fixes for absent/empty content ([history](https://github.com/rails/rails/blob/v7.1.5.2/actiontext/CHANGELOG.md)). **Code:** The endpoint diff adds sanitization of attachment `content` in [Content#render_attachments](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/content.rb); this occurs independently of the HTML4/HTML5 vendor default.

**Application:** [CSV parsing](file:///home/user/workspace/repo/app/models/import.rb#L101-L108) accepts `body_html`; [note form](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L48-L51) renders it with `rich_text_area`; [custom allowlist](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) permits collapsible content.

**Inference, conditional:** Imported or stored attachment content outside the allowed HTML set is stripped before editing; saving can persist the reduced representation. This is a security fix to preserve, not disable. Ordinary blob attachments without `content` are not this case. Database contents were not inspected, so affected stored content is unknown.

### H10. Attachment filenames gain additional substitutions

**History:** Rails 8.0 expands filename sanitization for Windows-unsafe characters ([changelog](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md)). **Code:** `Filename#sanitized` now replaces `<`, `>`, `?`, `*`, and `"` with `-`, in addition to the previous set.

**Application:** [attachment display/download URLs](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L4-L11) and [Markdown filenames](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11-L12) call blob filename conversion.

**Inference, conditional:** User-uploaded filenames containing those characters display/download differently without an exception; blob bytes and stored raw names are not rewritten. Generated parameterized notebook slugs are unlikely to encounter this. High under the requested data-format rubric, but a narrow practical impact.

## Medium-risk changes

### M1. Citation-provider configuration API is removed

**History:** `Rails.application.secrets` was deprecated in 7.1 and removed in 7.2 ([removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md)). **Code:** [Provider initialization](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L14) calls it, and [provider integration tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122) replace it during tests.

**Before → after:** Secrets YAML/environment-backed settings were available through the application; that accessor no longer exists. **Inference:** Enrichment fails before making its HTTP request, and the error is not the provider's custom failure type. Decide whether these settings belong in credentials, `config_for`, or explicit environment configuration, preserving deployment and test injection behavior. This is more than a blind accessor rename.

### M2. Built-in Sidekiq adapter is deprecated for removal in Rails 8.2

**History / Code:** [8.1 adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb) still accepts Sidekiq >=4.1 but warns that it will be removed in 8.2 and recommends Sidekiq >=7.3.3's own adapter.

**Application:** [adapter configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24), [Gemfile pins](file:///home/user/workspace/repo/Gemfile#L33-L36), and the native [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10).

**Inference:** This is not a dependency-resolution blocker for 8.1; it is a near-term backend migration decision. Do not automatically upgrade Sidekiq/Redis as part of this report—their compatibility and queued native jobs need a separate review. The installed Sidekiq 6.5.12 source already branches to `broadcast_to` on Rails >=7.1, so removal of `Logger.broadcast` alone is not a verified blocker here.

### M3. Resolved JSON 3.1 rejects inputs JSON 2.7 accepted

**History:** [JSON 3.1 changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md) documents default rejection of duplicate keys and comments, removal of `create_additions`/unknown options, stricter escapes/surrogates, and rejection of non-ASCII BINARY strings during generation. **Code:** Read the unpacked 3.1.0 history/source and Rails JSON encoding/decoding; this is an actual default-gem replacement in the resolved bundle.

**Application:** [Citation::Provider#metadata_from](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) parses external JSON and maps `JSON::ParserError` to an enrichment failure; [tags](file:///home/user/workspace/repo/app/models/note.rb#L12) use JSON serialization; Sidekiq uses JSON for the [digest](file:///home/user/workspace/repo/app/models/user.rb#L41) and [export](file:///home/user/workspace/repo/app/models/notebook.rb#L25-L26) queues.

**Before → after:** A provider document with duplicate `title` keys could previously use the later value; now parsing raises. **Inference:** Such responses become failed enrichments, not silently accepted metadata. Decide whether to require strict provider JSON, explicitly permit particular legacy forms, or constrain JSON separately. Ordinary generated string-keyed job payloads and tag arrays do not demonstrate a conflict; actual provider responses and historical payloads were not inspected. Do not assume all JSON 3 removals are exercised here.

## Low-risk mechanical changes

These can still block boot or a feature; “low” means the repair has a direct replacement, not that it is optional.

- **Code + History:** [routes.rb:18](file:///home/user/workspace/repo/config/routes.rb#L17-L19) passes two paths to one `get`; [8.1 removes that API](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md)—declare `/notes` and `/journal` separately while preserving the canonical helper.
- **Code + History:** [Note enum](file:///home/user/workspace/repo/app/models/note.rb#L10) uses removed keyword syntax; [8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md)—use `enum :status, { draft: 0, ready: 1 }, prefix: true`, retaining stored integer meanings.
- **Code + History:** [Note tags](file:///home/user/workspace/repo/app/models/note.rb#L12) uses the removed positional coder; [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md)—use `serialize :tags, coder: JSON`, not YAML or a format migration.
- **Code + History:** [highlight alias](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) targets a store accessor, not a column; [7.2 removes non-attribute aliasing](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md)—forward both getter and setter to `color` explicitly.
- **Code + History:** [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) performs `nil + array` because [7.1 defers default allowed tags](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md)—build from `sanitizer_allowed_tags`, retaining attachment/default tags as well as `details`/`summary`.
- **Code + History:** [reminder enqueue](file:///home/user/workspace/repo/app/models/note.rb#L61) supplies an integer to `wait_until`; [7.2 removed numeric scheduled_at support](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md) and 8.1 serializes it via `.utc`—pass a Time representing the same epoch.
- **Code + History:** [citation retry](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) uses removed `:exponentially_longer`; [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md)—rename to `:polynomially_longer` to preserve the existing formula.
- **Code + History:** [export concatenation](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) uses string-array `sum` without an identity; [7.1 removes the Rails override](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md)—use `join` or `sum("")`; Ruby's numeric identity otherwise raises.
- **Code + History:** [test exception config](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) uses removed boolean `false`; [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md)—use `:none`; 8.1 otherwise falls through to rendering exceptions, breaking the suite's `assert_raises` expectations.
- **Code + History:** [schema.rb](file:///home/user/workspace/repo/db/schema.rb#L13) will acquire alphabetically ordered column dumps under [8.1](https://github.com/rails/rails/pull/53281); review generated diffs rather than interpreting reordering as database changes.

## Changes judged inactive or not relevant to this upgrade as scoped

Each conclusion below is **Code-based filtering of upstream history**, with remaining uncertainty noted rather than a claim that the entire subsystem is unaffected.

- **PostgreSQL raw date decoding:** [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) would fail when `Date.iso8601` receives a Date, but decoding is gated by 7.2 defaults and stays **off** here; if enabling newer defaults, consume the returned Date directly.
- **Readonly assignment:** [Notebook's slug](file:///home/user/workspace/repo/app/models/notebook.rb#L8) is resubmitted by [the controller](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L40); `raise_on_assign_to_attr_readonly` remains **false** with 7.0 defaults. Enabling 7.1 defaults requires stopping even unchanged slug assignment.
- **Implicit YAML serializer removal:** [Notebook preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7) retain YAML because `default_column_serializer = nil` is a 7.1 default; if adopting it, explicitly retain YAML or deliberately migrate existing data.
- **HTML5 sanitizer default:** stays HTML4 with 7.0 defaults; do not attribute all HTML parsing changes to the gem upgrade. The nil allowlist and embedded-content sanitizer changes above still apply independently.
- **HTTP strict freshness:** the [download action](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L12) uses ETag and Last-Modified, but strict ETag precedence is gated by 8.0 defaults; existing combined-validator behavior remains.
- **Automatic after-commit job enqueue:** despite the 7.2 release description, 8.1's [Enqueuing source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb) defaults `enqueue_after_transaction_commit` to **false**; the app does not opt in. Do not assume its row-lock/Redis failure behavior changes automatically.
- **New cache/message formats:** cache format remains 7.0; 7.1 message-serializer/metadata defaults are not enabled. RedisCacheStore pooling/UNLINK and MemCacheStore changes do not apply to the configured cache stores.
- **MySQL, Trilogy, SQLite, composite keys, replicas, encryption:** no matching adapters, composite keys, replica configuration, `encrypts`, or encrypted columns found. DOI is a custom *single* key, covered separately above.
- **Action Cable / Action Mailbox:** only Cable base stubs/configuration, no application channels/subscriptions or inbound mailboxes; no concrete feature migration identified.
- **Action Mailer additions/removals:** custom mailers use `deliver_now` from their own jobs; no removed preview-path or `assert_enqueued_email_with` argument configuration found. Digest's changed day is an Active Job argument issue, not a Mailer delivery default.
- **Active Storage cloud services/variants:** Disk service and original-image rendering exclude Azure removal, S3/GCS changes and image/video variant-processing changes. Application code does not rely on the changed `attach` return value or removed collection purge APIs.
- **Active Storage autosave / Action Text embeds callback:** reviewed 8.1's attachment-autosave fix and moving embeds assignment to before-validation; the app's size validator reads `body.body.attachables`, not persisted `embeds`, and has no attachment-dependent after-commit callbacks. No concrete contract break identified from those changes.
- **New generators and infrastructure:** Solid Queue/Cache/Cable, Propshaft, authentication generator, Kamal, `allow_browser`, rate limiting and generated CI are not automatically adopted by updating the gems.
- **Action Pack parser removals:** app-generated query/form parameters use normal bracket syntax and ampersand separators; no semicolon-separated or leading-bracket parameter usage found. Unseen hand-written external URLs are not verified.
- **Rack/session/rackup:** Rack remains 2.2.24. The resolved rack-session 1.0.2 and rackup 1.0.1 packages are compatibility shims, not a switch to Rack 3 session implementations; Puma remains the application server, so new WEBrick is not its replacement.
- **net-imap 0.6.8:** inspected source diff from 0.6.7 (parser/coercion/sequence-set fixes); no IMAP retrieval in the app, so no affected feature identified.
- **useragent 0.16.11:** used by optional browser gating; no `allow_browser` call in this app.
- **securerandom 0.4.1:** inspected delta from Ruby's 0.3.1; the added alphanumeric compatibility method is guarded for Ruby <3.3, not this Ruby 3.3.6 environment.
- **uri 1.1.2:** inspected parser/common/generic deltas from 0.13.1; `URI.parse` already used RFC3986 before, so the DEFAULT_PARSER switch is not by itself evidence that [provider URL validation](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) changes. No app use of the obsolete escape/extract APIs found.
- **drb 2.2.3:** object-reference handling changes affect Rails' parallel-test infrastructure, not a production DRb service; [tests](file:///home/user/workspace/repo/test/test_helper.rb#L7-L12) use ordinary Rails-managed workers, with no custom object-ID conversion. No application migration identified; parallel suite still needs future verification.
- **bigdecimal 4.1.3:** reviewed [release history](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md) and [division-rounding PR](https://github.com/ruby/bigdecimal/pull/330). Removed `precs`, changed `divmod` return types, BigMath and precision-mode fixes have no matching calls. The app divides nonnegative integer counts and rounds to four decimals; no specific changed result was established. Arithmetic/native-extension verification remains unperformed, separate from the confirmed Active Job wire-format change.
- **method_source removal:** no application calls; Rails no longer depends on it for console support.

### Editor integration deserves a separate focused check

**History / Code:** [Action Text 8.1](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md) extracts Trix into `action_text-trix` and changes upload progress/Promise plumbing. The resolved gem supplies Trix 2.1.19 assets, but the app still loads vendored **1.3.5 JavaScript** while `require trix` now takes the new CSS. Its imported `@rails/actiontext` upload integration also updates.

**Inference / uncertainty:** Installing the dependency does **not** mean the browser automatically receives the new editor or its security fixes. This is a mixed-version integration requiring a deliberate editor choice and review of round-tripping existing links, attachments and collapsible excerpts. I did not establish a specific runtime incompatibility, so this is not presented as a confirmed high/medium break. Existing tests and stored content should inform that decision; no browser was run.

## Review limits and next decision

Read the Rails 7.0.8.7 and 8.1.0 released source trees, relevant endpoint diffs, component histories covering 7.1/7.2/8.0 and pre-8.1 maintenance releases, and 8.1 histories; traced candidate changes into application code. Downloaded/unpacked selected dependency gems and inspected their source/history. This is a targeted risk review, **not** a claim that every framework diff hunk or transitive dependency behavior was audited.

No application code, Gemfile, lockfile, database, queues or credentials were changed; no new gems were installed; no app, test suite or upgrade task was run. The only workspace outputs are this report and dependency diff, ignored locally.

**Decision:** Do not treat this as a drop-in version bump. First address the mechanical blockers, choose import rollback/digest-day/configuration behavior, and plan a queue-compatible deployment. Keep framework-default adoption as a separate step. When an implementation is authorized, focus verification on failed second-row imports, non-UTC midnight digests, mixed-version job payloads, integer-key preview annotations, DOI receipts, expired exports, DST previews and rich-text edit/save round trips.
