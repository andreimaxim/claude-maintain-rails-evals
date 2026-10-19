# Rails 7.0.8.7 → 8.1.0: application-specific upgrade risk

## 1. Application facts and assessment boundary

**This is not a drop-in upgrade.** Dependency resolution succeeds, but source inspection identifies boot/request blockers, silent changes to imports and digests, and an incompatible newly resolved JSON dependency. This is a read-only assessment, not a tested upgrade.

Evidence labels used throughout:
- **[History]**: upstream changelog, release/upgrade guide, or commit.
- **[Code]**: application code or released dependency source inspected directly, including endpoint diffs.
- **[Inference]**: the predicted consequence for this application; not exercised at runtime.

The following facts determine the ratings:

- **[Code] Runtime and defaults:** Ruby **3.3.6**, Rails **7.0.8.7**, and `config.load_defaults 7.0`; no framework-default migration initializer. Rails 8.1.0 requires Ruby ≥3.2, so the configured Ruby meets its requirement. This report assumes **the defaults remain 7.0**, not that `app:update` is run or new defaults are adopted. [Gemfile](file:///home/user/workspace/repo/Gemfile#L1-L8), [application configuration](file:///home/user/workspace/repo/config/application.rb#L1-L24), [8.1 gemspec](https://github.com/rails/rails/blob/v8.1.0/rails.gemspec#L12).
- **[Code] Database:** PostgreSQL with `pg 1.6.0`, one database per environment, no replica/shard configuration. Notes use a JSON-serialized text column and a JSONB store accessor; citations have **DOI as their primary key and no `id` column**. [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L26), [Note](file:///home/user/workspace/repo/app/models/note.rb#L5-L19), [schema](file:///home/user/workspace/repo/db/schema.rb#L55-L64). The production PostgreSQL server version and deployment overrides were not inspected.
- **[Code] Web:** server-rendered ERB, cookie-backed sign-in storing `user_id`, Turbo/importmap, Sprockets. The app provides CSV/Markdown downloads, not an application JSON API. [authentication](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [routes](file:///home/user/workspace/repo/config/routes.rb#L4-L26).
- **[Code] Jobs:** Active Job uses **Sidekiq 6.5.12 / Redis 4.8.1**, except the test adapter in tests; `ExportJob` uses Sidekiq directly. Digest arguments include `TimeWithZone` and `BigDecimal`; reminders pass an integer epoch to `wait_until`. [job adapter](file:///home/user/workspace/repo/config/application.rb#L22-L24), [digest producer](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [reminder producer](file:///home/user/workspace/repo/app/models/note.rb#L56-L62), [native export job](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10). Rolling deployment and queue-drain practices are unknown.
- **[Code] Rich text/storage:** Action Text notes, a custom `details`/`summary` allowlist, local Disk storage, and original-image URLs rather than variants. The layout explicitly loads **vendored Trix 1.3.5**, not Rails' bundled editor JS. [allowlist](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), [storage](file:///home/user/workspace/repo/config/storage.yml#L1-L7), [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L14), [editor override](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14).
- **[Code] Caching/mail:** production enables fragment caching without overriding Rails' default FileStore; development selects MemoryStore/NullStore; tests normally use NullStore. Export indicators have a calculated TTL, but download authorization checks the database independently. Mail is delivered to files in development and the test adapter in tests; production delivery details are not configured here. [production](file:///home/user/workspace/repo/config/environments/production.rb#L15-L17), [development](file:///home/user/workspace/repo/config/environments/development.rb#L20-L45), [indicator](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L34), [download](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16).
- **[Code] Secrets:** provider settings are read through `Rails.application.secrets`. `tmp/development_secret.txt` exists and `tmp/local_secret.txt` does not. Neither secret file contents nor decrypted credentials were read. [provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15).

### Actual dependency resolution

**[Resolution]** On 19 October 2026, copied `Gemfile` and `Gemfile.lock` to a temporary directory, changed only the Rails requirement to `8.1.0`, and ran `bundle lock --update rails` with Ruby 3.3.6. No gems were installed and the application was not loaded. This resolves against today's gem index, **not the index at Rails 8.1.0's release**.

| Dependency | Current → resolved |
|---|---|
| rails, railties, actioncable, actionmailbox, actionmailer, actionpack, actiontext, actionview, activejob, activemodel, activerecord, activestorage, activesupport | 7.0.8.7 → 8.1.0 |
| net-imap | 0.6.7 → 0.6.8 |
| action_text-trix | newly locked at 2.1.19 |
| bigdecimal | Ruby default 3.1.5 → explicitly locked 4.1.3 |
| json | Ruby default 2.7.2 → explicitly locked 3.1.0 |
| drb | Ruby default 2.2.0 → explicitly locked 2.2.3 |
| securerandom | Ruby default 0.3.1 → explicitly locked 0.4.1 |
| uri | Ruby default 0.13.1 → explicitly locked 1.1.2 |
| rack-session / rackup / useragent / webrick | newly locked at 1.0.2 / 1.0.1 / 0.16.11 / 1.9.2 |
| method_source | removed (was 1.1.0) |

The Ruby-default versions above were read from the configured Ruby's gem specifications, not inferred from an absent lockfile entry. All other locked gem versions remain unchanged, notably Rack **2.2.24**, Puma **5.6.9**, Sidekiq **6.5.12**, Redis **4.8.1**, Faraday **1.10.4**, pg **1.6.0**, and the sanitizer/Nokogiri gems. **Rack 3, Solid Queue, and Propshaft are not forced by this resolution.**

Review artifacts: [resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolved.Gemfile.lock), [lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff). These are evidence, not replacement application files.

## 2. High-risk changes

“High” follows the requested rubric: silent changes, persisted/queued data, caching, time zones, and security behavior. It does not mean every item has equally severe consequences. Except where explicitly conditional, these changes apply even with Rails 7.0 defaults. Application effects below assume earlier mechanical blockers have been addressed.

### H1. A failed CSV import can commit a partial batch — Active Record 7.2

**Before → after [History, Code]:** Rails 7.0 rolls back a written transaction when its block exits through a nonlocal `return`. Rails 7.2 removes that behavior: a normal `return`, `break`, or `throw` commits; exceptions still roll back. Retaining 7.0 defaults does not retain the old rule.

**Use:** [`Import#apply`](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, saves each row, then executes `return false unless row.note.save` inside the transaction. The controller renders the failed-import preview on that false result. [Controller](file:///home/user/workspace/repo/app/controllers/imports_controller.rb#L9-L20).

**Consequence [Inference]:** a valid first row followed by an invalid second row can leave the import, first note, rich text, and citation persisted even though the request reports failure. Resubmitting can duplicate the earlier rows. This is a direct data-integrity risk, not just changed error handling. Review explicit rollback/exception control flow, including the method's false return contract. The existing [invalid-row test](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L74) expresses the intended all-or-nothing behavior but was not run.

**Source:** [removal commit, including transaction tests](https://github.com/rails/rails/commit/eccc6061f4f3abdfdeb9a363987a898418d9498f).

### H2. Digests change from UTC days to reader-local days — Active Job 7.1 patch / 7.2

**Before → after [History, Code]:** the old `TimeWithZoneSerializer` stores an offset-bearing timestamp but deserializes it in `Time.zone`. The new serializer also stores the named time zone and restores it; old payloads without that field still fall back to `Time.zone`.

**Use:** [`User#request_digest`](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) sends the reader-local request time but reserves a Redis key by **UTC date**. [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) derives both its subject date and note selection from the deserialized timestamp's `to_date`/`all_day`.

**Consequence [Inference]:** a request at 03:30 UTC on 5 October from a New York reader previously selected 5 October UTC; a newly serialized job now selects 4 October in New York. The reservation remains for 5 October UTC. Subject, included notes, and deduplication-day semantics diverge; old/new payloads or workers can produce different digests. Decide explicitly whether digest days are UTC or reader-local, then normalize on that basis. The [existing test](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L37) deliberately covers this midnight boundary.

**Sources:** [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb). The fix also appears in the 7.1 patch history, so investigate it during a staged upgrade, not only at 7.2.

### H3. BigDecimal job arguments are not backward-readable by 7.0 workers — Active Job 7.1–8.0

**Before → after [History, Code]:** 7.0 leaves `BigDecimal` as a primitive; Sidekiq's JSON encoding turns it into a string. New Active Job emits an object tagged with `ActiveJob::Serializers::BigDecimalSerializer` and reconstructs a decimal. The transitional opt-out introduced in 7.1 is gone by 8.0.

**Use:** [`reading_completion` and digest enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [`DigestJob`](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L7), [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L10).

**Consequence [Inference]:** a Rails 7.0 worker cannot deserialize a newly tagged decimal, so mixed workers/producers are unsafe without an explicit transition. New workers can still receive old string payloads. The mailer's `BigDecimal(...)` conversion accepts the intended old/new argument representations; the main risk is queue compatibility, not an assumed mailer type error. Coordinate workers, producers, scheduled/retry queues, and rollback before changing serialization.

**Sources:** [7.1 changelog's explicit rolling-deployment warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L157), [7.2 primitive removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65), [8.0 opt-out removal](https://github.com/rails/rails/blob/v8.0.0/activejob/CHANGELOG.md#L13-L15), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

### H4. CSV receipts silently lose DOIs — Active Record 7.2

**Before → after [History, Code]:** `read_attribute(:id)`/`record[:id]` formerly redirected to a custom primary key. That compatibility mapping is removed. `record.id` still represents the primary key, but `record[:id]` reads the actual `id` attribute; for this table it is absent and yields nil.

**Use:** [`Import#receipt`](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) writes `citation[:id]`; [citations schema](file:///home/user/workspace/repo/db/schema.rb#L55-L64) has `doi`, not `id`.

**Consequence [Inference]:** successful CSV downloads contain blank DOI cells while HTML receipts still show `citation.doi`. Use the explicit DOI or primary-key reader. High despite the small fix because the externally exported data changes without an error.

**Sources:** [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L425-L427), [8.1 attribute reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb#L29-L34).

### H5. Import-preview annotations disappear — Active Support 8.0

**Before → after [History, Code]:** `HashWithIndifferentAccess#stringify_keys` previously duplicated the hash without converting integer keys. It now actually stringifies them. Indifferent access equates symbols and strings, **not integers and strings**.

**Use:** [`Import#annotations`](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) uses integer CSV line numbers. The [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys` and then still looks up `annotations[row.line]`.

**Consequence [Inference]:** lookup by integer returns nil, hiding annotations before the user approves import. The annotations are still saved to notes; this is a preview/review failure rather than deletion from the database. Keep lookup and key types consistent.

**Source:** [8.0 changelog, including the exact integer-key example and decision not to backport](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L47).

### H6. Reminder postponement previews change across DST — Active Support 8.1

**Before → after [History, Code]:** under the app's old defaults, `TimeWithZone#to_time` retains a fixed UTC offset. In 8.1 it always retains the time-zone object, so later arithmetic can follow DST transitions. The old configuration no longer restores fixed-offset conversion.

**Use:** [`Note#next_day_reminder_at`](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) adds 86,400 seconds after `to_time`; the [note page](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays the result, and postponement uses its epoch.

**Consequence [Inference]:** 31 October 2026, 09:00 New York + 24 elapsed hours previously displayed 1 November 09:00 −04:00; it now displays 08:00 −05:00. **The instant and scheduled epoch are unchanged**, but the displayed local time/offset changes and the [existing assertion](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L19-L21) expects the old representation. Decide and document elapsed-hours versus same-local-time semantics; do not accidentally “fix” this by changing the scheduled instant.

**Sources:** [8.1 removals](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22), [8.1 `to_time`](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L497-L499).

### H7. Negative fragment-cache TTLs are discarded rather than expiring entries — Active Support 7.1

**Before → after [History, Code]:** 7.0 accepts a negative `expires_in`, making the entry already expired. New cache code removes a negative TTL and reports an error. With this app's retained 7.0 defaults, it logs/reports instead of raising, leaving the store's default expiry (none for the configured default store). With 7.1+ defaults it raises.

**Use:** the [completed-export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L34) always supplies `export.expires_at - Time.current`, including for expired exports.

**Consequence [Inference]:** after expiry, the page can store an “Expired” fragment without a TTL and emit cache-expiration errors. This is changed retention/logging, **not evidence of unauthorized downloads**: the [download action](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) independently checks ownership and expiry. Avoid caching with nonpositive remaining lifetimes; review any later adoption of the raising default separately.

**Sources:** [7.1 changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L869), [8.1 invalid-TTL handling](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L907-L945).

### H8. Local signing-key changes invalidate sessions and persisted attachment references — Railties 7.1/8.1

**Before → after [History, Code]:** local generated secrets move from `tmp/development_secret.txt` to `tmp/local_secret.txt`. Additionally, 8.1 honors `SECRET_KEY_BASE` or credentials in local environments before generating a local key.

**Use:** [cookie sign-in](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18), [`has_rich_text :body`](file:///home/user/workspace/repo/app/models/note.rb#L8), and [signed blob URLs](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L4-L11). The old local file exists here; the new one does not.

**Consequence [Inference, conditional on effective secret]:** simply booting the upgrade with a different key logs local users out and can invalidate signed attachment identifiers already stored in rich text. Preserve the effective key, not merely the filename, accounting for the new environment/credentials precedence. This finding is specifically about local development/test; no production key rotation was established.

**Sources:** [upgrade guide](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [8.1 local precedence](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md#L156-L163), [configuration implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L526-L535).

### H9. Uploaded filenames gain additional sanitization — Active Storage 8.0

**Before → after [History, Code]:** `ActiveStorage::Filename#sanitized` additionally substitutes `<>?*"` with dashes. `to_s` uses this sanitized representation; the stored raw filename is not migrated by this method.

**Use:** arbitrary rich-text uploads rendered in the [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L4-L12). Export filenames also use `to_s`, although generated notebook slugs already avoid these characters.

**Consequence [Inference, conditional on existing filenames]:** attachment labels and download filenames can change silently, e.g. `chapter?.pdf` becomes `chapter-.pdf`. Review filename-sensitive integrations or expectations. High by the requested data-format/security rubric, but materially less severe than partial imports.

**Sources:** [8.0 changelog](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md#L22-L25), [8.1 filename implementation](https://github.com/rails/rails/blob/v8.1.0/activestorage/app/models/active_storage/filename.rb#L57-L68).

### H10. HTML content attachments are interpreted and sanitized differently — Action Text 7.1–8.0

**Before → after [History, Code]:** the old content-attachment implementation recognizes the special horizontal-rule type; the new one accepts HTML content attachments with a nonempty `content` attribute. The rendering path sanitizes that attribute, removes it when sanitized content is empty, and uses the newer representation for editor HTML and plain-text conversion.

**Use:** the app accepts imported `body_html` in [`Import#build_row`](file:///home/user/workspace/repo/app/models/import.rb#L101-L106), renders it as [note body](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L31), and converts it to [Markdown plain text](file:///home/user/workspace/repo/app/models/export.rb#L77-L81).

**Consequence [Inference, content-dependent]:** specially formed or legacy `<action-text-attachment>` content can render/export differently; sanitization can remove content formerly passed through to the editor. Inspect real saved HTML and round trips rather than treating security fixes as behavior-neutral. No database content was read, so the presence of these particular attachments is unknown. Ordinary Blob attachments do not by themselves establish this case.

**Sources:** [7.1 content-attachment change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L64-L66), [7.2 sanitization fixes](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md#L3-L10), [8.0 empty-content removal](https://github.com/rails/rails/blob/v8.0.0/actiontext/CHANGELOG.md#L45-L57), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/content.rb#L99-L109). Endpoint source comparison, rather than assuming every historical security entry is new relative to 7.0.8.7, establishes this difference.

## 3. Medium-risk changes

### M1. Provider configuration uses the removed `Rails.application.secrets` API — Railties 7.2

**Before → after [History, Code]:** Rails 7.0 reads `config/secrets.yml` through `Rails.application.secrets`; 7.1 deprecates this and 7.2 removes it.

**Use:** [`Citation::Provider#initialize`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15); [integration-test setup](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122) also mutates that object.

**Consequence [Inference]:** provider construction raises rather than loading settings. `Citation#enrich` rescues only the provider's own error type, so this failure can go to Sidekiq retries and leave enrichment pending. Decide whether to preserve environment-backed settings through explicit configuration or move them into credentials, then migrate tests and deployment configuration together. This is not safely solved by a blind API rename.

**Source:** [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63).

### M2. The built-in Sidekiq adapter is deprecated for removal in 8.2 — Active Job 8.1

**Before → after [History, Code]:** the built-in adapter remains in 8.1 but warns that it will be removed in 8.2; Rails directs users to Sidekiq ≥7.3.3's adapter. The resolved Sidekiq remains 6.5.12.

**Use:** [`queue_adapter = :sidekiq`](file:///home/user/workspace/repo/config/application.rb#L22-L24) and all three application Active Jobs.

**Consequence [Inference]:** it is not a dependency-resolution blocker today, but the next Rails release requires a backend/dependency decision. A Sidekiq 7 migration is separate work, including Redis client and native-job compatibility; do not assume Rails' lock update performs it. The pinned 6.5.12 source already branches to `Rails.logger.broadcast_to` on Rails ≥7.1, so I did **not** infer a logging boot failure from the older broadcast API's removal.

**Sources:** [8.1 deprecation](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [adapter warning](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L36-L41), [Sidekiq 6.5.12 Rails integration](https://github.com/sidekiq/sidekiq/blob/v6.5.12/lib/sidekiq/rails.rb#L55-L63).

### M3. Today's resolved JSON 3.1.0 is incompatible with Rails 8.1.0's decoder

**Before → after [History, Code]:** this Ruby currently supplies JSON 2.7.2. Rails' new explicit, unconstrained JSON dependency resolves to 3.1.0. JSON 3's `parse` takes one positional source argument and keyword options; Rails 8.1.0's `ActiveSupport::JSON.decode` still calls `::JSON.parse(json, options)` with a positional hash. JSON 3 also rejects unknown options, whereas Rails' serialized-column coder passes `escape: false` into decoding.

**Use:** [`Note#tags`](file:///home/user/workspace/repo/app/models/note.rb#L12) uses Rails' JSON column coder (after fixing its removed positional syntax); [`settings` JSONB](file:///home/user/workspace/repo/app/models/note.rb#L13) also goes through Rails JSON decoding. This is a shared framework path, not merely the provider's direct JSON call.

**Consequence [Inference from incompatible signatures]:** reading nonempty JSON values can raise `ArgumentError` even after the obvious Rails API migrations. Successful resolution proves version constraints only, not runtime compatibility. Decide between constraining JSON to a compatible release, selecting a compatible Rails release, or a separately reviewed compatibility fix; this report does not change the requested version or propose an unverified monkey patch.

**Additional contract change [History, Code, Inference]:** JSON 3 rejects duplicate object keys and comments by default and tightens invalid escape handling. [`Citation::Provider#metadata_from`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) uses `JSON.parse` directly and turns parse errors into failed enrichments. A previously accepted response with duplicate `title` keys would now fail, rather than use the last title. Provider payloads were not fetched, so occurrence is unknown; decide whether strict rejection is the desired contract.

**Sources:** [JSON 3.1.0 history](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md), [JSON parser signature](https://github.com/ruby/json/blob/v3.1.0/lib/json/common.rb#L291-L298), [Rails decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb#L24-L25), [Rails column coder](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/coders/json.rb#L6-L20). Sources were inspected; no new JSON native extension was compiled or loaded.

## 4. Low-risk/mechanical changes

Each item has a direct replacement and is expected to be caught by booting or the relevant existing test once an upgrade is authorized. “Low” does not mean it can be ignored.

- **[History, Code, Inference] Action Text initializer:** [`allowed_tags += ...`](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) now adds to nil and fails initialization; obtain the effective default tags, including Action Text attachment tags, before extending them—do not replace the allowlist with only `details`/`summary`. [7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L35).
- **[History, Code, Inference] Enum arguments:** [`enum status: ..., _prefix: true`](file:///home/user/workspace/repo/app/models/note.rb#L10) is removed syntax; use positional `:status` and `prefix: true`, preserving the integer mapping and existing `status_ready` callers. [8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L64-L66).
- **[History, Code, Inference] Serialized tags:** [`serialize :tags, JSON`](file:///home/user/workspace/repo/app/models/note.rb#L12) requires `coder: JSON`; preserve its existing JSON representation rather than changing the stored format. This alone does not resolve M3. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L423).
- **[History, Code, Inference] Store-accessor alias:** [`alias_attribute :highlight_color, :color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) now rejects `color`, which is a store accessor, not a database attribute; explicitly delegate/alias both the getter and setter. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490-L492), [implementation/error](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb#L87-L96).
- **[History, Code, Inference] Numeric reminder schedule:** [`wait_until: reminder_epoch`](file:///home/user/workspace/repo/app/models/note.rb#L61) now reaches serialization that calls `scheduled_at.utc`; pass `Time.at(reminder_epoch)` instead, preserving the epoch exactly. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55-L57), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L129-L130).
- **[History, Code, Inference] Retry wait name:** [`:exponentially_longer`](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) is removed; use `:polynomially_longer`, preserving the existing fourth-power backoff and attempts rather than inventing a new exponential policy. [7.1 clarification](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L22-L27), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51-L53).
- **[History, Code, Inference] String summation:** [`fragments.sum`](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) loses Active Support's nonnumeric convenience and raises under Ruby's numeric-zero identity; use string concatenation (`join` or an explicit empty-string identity). [7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420-L422).
- **[History, Code, Inference] Multi-path route:** [`get "/notes", "/journal"`](file:///home/user/workspace/repo/config/routes.rb#L17-L18) now raises for multiple paths; declare two routes while retaining `notes_path` and the alias. [8.1 removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107-L109).
- **[History, Code, Inference] Test exception policy:** [`show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) must become `:none`; 8.1's fallback treats unsupported `false` as “show”, so authorization tests expecting raised errors can instead receive error pages. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md#L100-L102), [8.1 switch](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb#L185-L197).
- **[History, Code] Parallel test database names:** the [parallelized test suite](file:///home/user/workspace/repo/test/test_helper.rb#L7-L12) changes database suffixes from `-N` to `_N`; update any external grants/cleanup scripts if present. None were identified here. [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L769-L774).
- **[History, Code] Schema dumps:** the existing [Ruby schema](file:///home/user/workspace/repo/db/schema.rb#L1-L15) will sort columns alphabetically on a future dump; this is representation churn, not a database-column migration. [upstream PR](https://github.com/rails/rails/pull/53281).

## 5. Changes ruled out or bounded by this application's configuration

These are not claims that an entire Rails component is unchanged. They identify the reviewed change families with no demonstrated additional application regression.

- **PostgreSQL date decoding — not active with 7.0 defaults [Code]:** [`Notebook#daily_note_counts`](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) still receives date strings. The [8.1 configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L322-L334) enables decoding only at 7.2 defaults. **If those defaults are adopted**, `Date.iso8601(day)` will receive a Date instead of a string and needs a direct adjustment; this is not an unconditional 8.1 break.
- **Readonly assignment / implicit YAML coder — not active with 7.0 defaults [Code]:** [`Notebook`](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) retains its YAML serializer and nonraising readonly assignment. Adopting 7.1 defaults removes the implicit coder and raises even when the settings form resubmits a persisted slug; preserve the YAML data format and stop assigning readonly fields as part of that separate defaults migration. [default switches](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L280-L287).
- **HTTP strict freshness — not active with 7.0 defaults [Code]:** the [export download](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L12) retains the old requirement that both supplied validators match; ETag precedence is enabled by 8.0 defaults. The new request Cache-Control parser alone does not change this action's decisions. [default](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L335-L340), [implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb#L44-L65).
- **Automatic enqueue-after-commit — not enabled here at the target [Code]:** despite the broad 7.2 changelog description, 8.1 declares `enqueue_after_transaction_commit` **false** and the app does not override it; the row-lock enqueue paths in [Note](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) and [Citation](file:///home/user/workspace/repo/app/models/citation.rb#L14-L23) are not automatically deferred. Opting in later would change rollback-on-enqueue-failure guarantees and needs separate review. [target source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L44-L53).
- **HTML5 sanitizer default — not adopted [Code]:** 7.0 defaults retain HTML4 for Action View/Action Text; this does not protect against the nil-allowlist initializer change or H10. [default switches](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L313-L320).
- **Cache/message format upgrades — not opted in [Code]:** cache format remains 7.0 rather than 7.1, and the 7.1 message serializer/metadata defaults are not enabled; no MessagePack cookie migration is configured. [default switches](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L305-L311).
- **Redis/Memcache cache-pool changes — not relevant [Code]:** Redis is used for Sidekiq and digest reservations, not `RedisCacheStore`; MemCacheStore is only commented out. Do not confuse these with the fragment-TTL issue above. [production cache configuration](file:///home/user/workspace/repo/config/environments/production.rb#L58-L59).
- **MySQL/MariaDB/Trilogy/SQLite adapters — not relevant [Code]:** PostgreSQL is the only configured adapter; their type, locking, DDL, and SQLite-specific Rails 8 improvements are excluded.
- **AR encryption, composite keys, replicas/shards, bulk insert/upsert, custom association-query constraints — not used [Code]:** no matching application use found; the DOI key is a single custom key, covered by H4, not a composite key.
- **Connection retry improvements — relevant infrastructure, no application-specific semantic failure established [History, Code, Inference]:** Rails now retries known idempotent reads on broken connections, including some association/exists queries, unlike old immediate failure paths; normal [note lookups](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L59-L60) can benefit. Failover timing/snapshot expectations remain an unverified operational consideration, not evidence of duplicate writes. [7.2 history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L281-L288), [8.1 association extension](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L582-L585).
- **Active Storage cloud services/variant processors — not relevant [Code]:** Disk services and original blobs are used; Azure removal, S3/GCS changes, preview/variant transformations and their security restrictions have no selected application path.
- **Action Text validation timing — bounded [History, Code]:** embeds are populated before validation instead of before save; the app's [size validator](file:///home/user/workspace/repo/app/models/note.rb#L95-L98) reads `body.attachables`, not `embeds`, so the timing change does not by itself show a lost size check. No custom Blob-attachment autosave logic was found. [8.1 history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md#L59-L61).
- **Trix dependency split — not an automatic editor JS upgrade [History, Code, uncertainty]:** new `action_text-trix 2.1.19` supplies assets, but the [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14) keeps Trix 1.3.5 JS; [`require trix` CSS](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L7) does move to the new gem. This leaves mixed asset versions requiring browser review; no specific layout failure was established without running it. Do not claim the Rails upgrade updates the vendored editor or delivers its newer security fixes. [8.1 split](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md#L53-L57).
- **Action Cable — no application subscriptions/broadcasts found [Code]:** only generated base classes/configuration; Redis reconnect and channel changes were not assigned a feature risk.
- **Action Mailbox / IMAP — not used [Code]:** no inbound mailbox workflow. The only existing non-Rails lockfile version bump, net-imap 0.6.7 → 0.6.8, changes IMAP internals not exercised by outbound file/test delivery; its released source diff was reviewed.
- **Action Mailer new callbacks, bulk enqueue, preview paths — not used [Code]:** these mailers call `deliver_now` inside jobs, with no custom delivery callbacks/preview-path override. Their payload/day risks are H2/H3, not a new mail transport configuration.
- **Active Model password features — no exposed reset/challenge workflow [Code]:** `has_secure_password` is used, but no password-reset endpoints or custom challenge setter are wired. The length check does change from characters to bytes, and blank confirmation is no longer skipped, but this app exposes no password-writing UI: account updates permit only `time_zone`, and seeds assign short ASCII passwords. Existing authentication hashes are not migrated by those validations. [Account parameters](file:///home/user/workspace/repo/app/controllers/accounts_controller.rb#L14-L15), [7.1 validation history](https://github.com/rails/rails/blob/v7.1.0/activemodel/CHANGELOG.md#L44-L62).
- **Action View helper renames — aliases remain [History, Code]:** [`rich_text_area`](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L50) still works as an alias; no mandatory rename to `rich_textarea`. No `form_with model: nil` or void-tag content use was found. [8.0 alias note](https://github.com/rails/rails/blob/v8.0.0/actiontext/CHANGELOG.md#L49-L53).
- **Action Pack JSON escaping, `params.expect`, browser gates, rate limits, CSP — not adopted/application API not present [Code]:** no JSON-rendering application action or opt-in gate/rate limiter; CSP initializer is commented. Semicolon/bracket parsing compatibility removals have no identified generated-link/form dependency; external handcrafted clients were not inspected.
- **Railties new-app defaults — not an existing-app migration [Code]:** Solid Queue/Cache/Cable, Propshaft, authentication generation, Kamal, and generated CI/Docker files are not added by changing this Gemfile requirement. Ruby version is already sufficient.
- **New rack-session/rackup dependencies — compatibility shells, not Rack 3 [Code]:** their resolved v1 source delegates to existing Rack 2 functionality; `rack-session`'s entry point is intentionally a no-op. No separate session-wire-format migration was found from these two gems. [rack-session v1 source](https://github.com/rack/rack-session/blob/v1.0.2/lib/rack/session.rb).
- **New useragent / WEBrick dependencies — no selected production feature [Code]:** the app does not call `allow_browser`, uses Puma, and has no WEBrick-specific server configuration; no application behavioral change established.
- **drb / securerandom — no application-specific incompatibility found [Code]:** DRb serves Rails' test infrastructure rather than app RPC; the SecureRandom source difference adds a Ruby <3.3 compatibility method, not a changed random-generation path on Ruby 3.3.6. Other Ruby-default fallbacks were compared against the unpacked resolved gems.
- **URI 0.13.1 → 1.1.2 — no proven provider validation change [Code]:** although `URI::DEFAULT_PARSER` changes, the app's [`URI.parse`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) already used the RFC3986 parser before. The new constant alone is insufficient to claim different accepted provider URLs; remaining URI/security changes and upstream clients were not exhaustively certified. [upstream comparison](https://github.com/ruby/uri/compare/v0.13.1...v1.1.2).
- **BigDecimal 3.1.5 → 4.1.3 — arithmetic review still warranted [History, Code, uncertainty]:** division precision/rounding fixes apply to the operation used by [`reading_completion`](file:///home/user/workspace/repo/app/models/user.rb#L53-L56), but no specific changed result after its `.round(4)` was established; removed `precs`, changed `divmod`, and BigMath changes are not called. Do not equate this uncertainty with proved numeric compatibility. The confirmed queue-format risk is H3. [history](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md), [division-rounding PR reviewed](https://github.com/ruby/bigdecimal/pull/330).
- **method_source removal — no direct use [Code]:** it was a Railties console dependency, not called by the application.

## Coverage and delivery state

Reviewed upstream component changelogs across 7.1, 7.2, 8.0 and 8.1, intervening patch histories, released 7.0.8.7/8.1.0 source differences for candidate paths, relevant intermediate sources, the transaction-removal commit, dependency sources/histories, and matching application code/tests. This is a prioritized assessment, not an exhaustive audit of every Rails commit, every dependency integration, or stored production data. New configuration defaults are explicitly separated from unconditional changes.

**No application code, Gemfile, or application lockfile was changed. No upgrade was installed, no application or tests were run, and no database/Redis/provider operation was performed.** The only repository-local additions are ignored report/evidence artifacts and the local exclusion rule for their directory. Findings about runtime outcomes are source-based predictions, not passing/failing test results.
