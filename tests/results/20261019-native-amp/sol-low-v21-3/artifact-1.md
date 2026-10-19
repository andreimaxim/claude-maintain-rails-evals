# Rails 7.0.8.7 → 8.1.0: application-specific upgrade risk

## Application facts and scope

Evidence labels: **History** means upstream changelog or PR; **Code** means released framework/dependency source or application source inspected; **Inference** means the predicted application consequence, not an executed reproduction.

- **Code:** Ruby is pinned to 3.3.6 (`Gemfile:4`); it meets Rails 8.1's Ruby ≥3.2 requirement. The application loads all Rails frameworks but retains `config.load_defaults 7.0` ([application configuration](file:///home/user/workspace/repo/config/application.rb#L3-L24)). This review assumes that line stays unchanged. Adopting 8.1 defaults is a separate, materially riskier change.
- **Code:** PostgreSQL is the sole configured database ([database.yml](file:///home/user/workspace/repo/config/database.yml#L17-L22)); its deployed server version is not established by configuration. Rails 8.1 requires PostgreSQL 9.3 or newer. No replicas, sharding, encryption, composite keys, or custom database adapters were found.
- **Code:** This is server-rendered HTML with Turbo/importmap/Sprockets, Action Text rich bodies, local Disk uploads, and Markdown/CSV exports. The layout explicitly loads vendored Trix 1.3.5, not the framework's Trix asset ([layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [import map](file:///home/user/workspace/repo/config/importmap.rb#L3-L8)).
- **Code:** Active Job uses Sidekiq outside tests; tests explicitly use `:test` ([application.rb](file:///home/user/workspace/repo/config/application.rb#L22-L24), [test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L30-L47)). Sidekiq 6.5.12 and Redis 4.8.1 are exact pins. ExportJob is native Sidekiq. Jobs carry GlobalIDs, zoned times, and BigDecimal values.
- **Code:** Production enables fragment caching without an explicit cache store, so the framework's FileStore default applies; development optionally uses MemoryStore and tests use NullStore. Redis is not the application cache ([production.rb](file:///home/user/workspace/repo/config/environments/production.rb#L15-L17), [development.rb](file:///home/user/workspace/repo/config/environments/development.rb#L20-L35)).
- **Code:** Digests and reminders call `deliver_now`; development writes mail to files and tests use test delivery. No inbound mailbox or application cable broadcasts were found. Deployment configuration, existing stored payloads, and live queued jobs were not inspected.

### Dependency resolution

**Code / resolver observation:** Copied only Gemfile and Gemfile.lock into `/tmp/rails-upgrade-review`, changed only the Rails requirement to `8.1.0`, and ran `bundle lock --update rails` with Bundler 2.5.22. Resolution succeeded. No gems were installed and no application code was run.

All 13 Rails packages move to 8.1.0. Other changes in that resolution:

| Dependency | Result |
|---|---|
| net-imap | 0.6.7 → 0.6.8 |
| action_text-trix | added 2.1.19 |
| bigdecimal / json / uri | newly locked 4.1.3 / 3.1.0 / 1.1.2 |
| drb / securerandom | added 2.2.3 / 0.4.1 |
| rack-session / rackup / useragent / webrick | added 1.0.2 / 1.0.1 / 0.16.11 / 1.9.2 |
| method_source | removed |

Rack remains **2.2.24**, constrained by Sidekiq 6.5; this is not a Rack 3 upgrade. pg, Sidekiq, Redis, Faraday, Pagy, Puma, Turbo, Sprockets, sanitizer, Nokogiri, and mail retain their locked versions. Added dependencies can replace Ruby default gems: this sandbox's current Ruby defaults are JSON 2.7.2, BigDecimal 3.1.5, URI 0.13.1, but the original lockfile does not guarantee those versions on every host. Resolution reflects the available gem index at review time, not the dependency versions available when Rails 8.1.0 first shipped.

## High-risk changes

### 1. Failed imports can commit a partial batch

**History:** Rails 7.1 reintroduced committing on non-local transaction exits, and 7.2 removed the old rollback behavior. See [PR #48600](https://github.com/rails/rails/pull/48600) and [7.2 Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Code:** Compared `within_new_transaction` in both released versions. 7.0.8.7 rolls back a written transaction exited with `return`; 8.1 commits absent an exception. This is no longer protected by retaining 7.0 defaults.

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and then returns false from inside the transaction if any row fails to save.

**Inference:** If a later note fails validation/save, the import and earlier notes can persist even though the request reports failure. This violates batch atomicity and can create duplicates on retry. Prioritize a case with a valid first row and invalid later row. Explicit rollback or an exception is needed to preserve all-or-nothing behavior; merely returning false no longer does so.

### 2. Digest dates and selected notes change when zoned job arguments round-trip

**History:** [7.2 Active Job changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md) says deserialization now preserves the serialized TimeWithZone timezone.

**Code:** Old `TimeWithZoneSerializer` writes an ISO timestamp and deserializes in `Time.zone`. New source adds `time_zone` and restores it, falling back to `Time.zone` for old payloads.

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC** date but passes a time in the reader's zone. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) derives both the subject date and `updated_at` day range from that argument.

**Inference:** Newly queued digests now cover the reader's local day rather than the previous UTC day, while reservation keys remain UTC-based. Near midnight these disagree; recipients can see a different date and different notes with no error. Old/new queued payloads also produce different results. Decide explicitly whether the digest day is UTC or reader-local and align reservations, selection, and subject. An asymmetric case such as a Los Angeles reader shortly after UTC midnight distinguishes the behaviors.

### 3. BigDecimal job payloads become incompatible with old workers

**History:** [7.1 Active Job changelog](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md) documents a serializer to fix BigDecimal becoming a string through JSON; [7.2](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md) removes the legacy primitive path. The compatibility switch itself is removed in 8.0.

**Code:** 8.1 writes a tagged `ActiveJob::Serializers::BigDecimalSerializer` object and restores a BigDecimal; 7.0 has no such serializer. Retaining 7.0 defaults does not retain the old payload format.

**Application:** [User#reading_completion and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L8), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10).

**Inference:** An old worker consuming a new digest payload can fail deserialization. Existing old string payloads can still reach the new mailer's BigDecimal conversion; this is principally a mixed-worker/rollback hazard, not evidence that the new mailer necessarily errors. Plan queue isolation/draining and rollback compatibility before deploying producers.

### 4. Reminder postponement changes its displayed DST offset

**History:** [8.1 Active Support changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md) removes old `to_time` behavior and deprecates its configuration switch.

**Code:** 7.0's TimeWithZone conversion with existing defaults preserves a fixed UTC offset; 8.1's implementation unconditionally returns `getlocal(time_zone)`, retaining the full zone.

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L45) adds 86,400 seconds to `reminder_at.to_time`, and [postpone_reminder](file:///home/user/workspace/repo/app/models/note.rb#L71-L72) uses its epoch.

**Inference:** Across a DST transition, the preview now follows the destination instant's zone offset rather than retaining the original offset. The epoch is still 24 elapsed hours later—not a calendar-day postponement. This silently changes a user-visible time contract; retaining 7.0 defaults does not prevent it. Compare a zone with DST on both sides of a transition before accepting the display change.

### 5. Expired export cache fragments lose their negative TTL

**History:** [7.1 Active Support changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md) introduces invalid-expiration handling.

**Code:** In 7.0 a negative `expires_in` creates an already-expired entry. In 8.1 `Cache::Store#merged_options` deletes a negative TTL and reports it; it raises only if `raise_on_invalid_cache_expiration_time` is enabled. That raising default is gated behind 7.1 defaults, so it is not enabled here.

**Application:** [export availability fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) always computes `export.expires_at - Time.current`, including for expired exports.

**Inference:** With existing defaults, rendering an expired export writes an entry without this expiration instead of an immediately expired one. This changes cache retention silently; generally the cached content is correctly “Expired,” not an unauthorized download. [Download authorization/expiry](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L5-L15) remains independent. If newer defaults are adopted, the same request raises instead. Review expiry handling before enabling that default.

### 6. Rich-text attachment processing and editor dependency change

**History / Code:** [8.1 Action Text changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md) moves embeds extraction from `before_save` to `before_validation`, changes attachment upload integration, and replaces bundled Trix with `action_text-trix` ≥2.1.15 (resolved 2.1.19). The old release source bundles 1.3.4.

**Application:** [Note attachments validation](file:///home/user/workspace/repo/app/models/note.rb#L94-L98), [rich-text form](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L48-L51), and [explicit Trix 1.3.5 override](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14).

**Inference:** Association bookkeeping now happens earlier, while application size validation still walks body attachables. This is a stored attachment relationship boundary worth reviewing for accepted/rejected edits and abandoned uploads. No bypass of the 1 MB validation was established. The dependency update does **not** automatically upgrade the app's editor: its explicit 1.3.5 script wins. New Action Text JS plus old Trix is an unverified combination. Treat replacing the override with Trix 2 as a separate stored-content compatibility/security decision; round-trip collapsible excerpts, links, and attachments before doing so. These are review risks, not confirmed data loss from the gem bump alone.

## Medium-risk changes

### 7. Citation provider configuration API is removed

**History:** [7.2 Railties changelog](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md) removes deprecated `Rails.application.secrets`.

**Code / application:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15) reads it; [secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18) supplies environment-backed settings. The API exists in old application source and is absent in 8.1.

**Inference:** Default provider construction raises instead of fetching metadata; enrichment can stay pending while Sidekiq retries unexpected errors. Choosing credentials versus direct environment/custom configuration, and preserving development/test defaults, needs an application decision—not just a method rename. Tests injecting settings alone would miss this path.

### 8. Rails' Sidekiq adapter is deprecated for removal in 8.2

**History / Code:** [8.1 Active Job changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md) and `SidekiqAdapter#check_adapter` require migration to Sidekiq ≥7.3.3 before Rails 8.2. The adapter still exists and accepts Sidekiq ≥4.1 in 8.1.

**Application:** [configured adapter](file:///home/user/workspace/repo/config/application.rb#L22-L24), exact Sidekiq/Redis pins in Gemfile, plus [native ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L3-L10).

**Inference:** This is not a dependency-resolution blocker for 8.1; it is a next-release removal requiring a deliberate Sidekiq/Redis/Rack upgrade plan. Do not silently include that larger upgrade in this Rails-only change.

## Low-risk changes

Each line is **History + Code; consequence is Inference** unless otherwise stated.

- **Enum keyword syntax removed:** [Note:10](file:///home/user/workspace/repo/app/models/note.rb#L10) must become `enum :status, { draft: 0, ready: 1 }, prefix: true`; model loading catches this. Citation/Export already use positional syntax. [8.0 AR history](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- **Positional serialize coder removed:** [Note:12](file:///home/user/workspace/repo/app/models/note.rb#L12) needs `serialize :tags, coder: JSON`, retaining JSON data format; model loading catches it. [7.2 AR history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **alias_attribute no longer aliases noncolumns:** [Note:13–14](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) aliases the store accessor `color`, not a column; use ordinary reader/writer aliases or explicit delegation. Loading/generated attribute use exposes the error. [7.2 AR history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Retry wait symbol removed:** [CitationEnrichmentJob:7](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) needs `:polynomially_longer`, which preserves the old delay formula; exercise an unavailable-provider retry. [7.1](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 AJ history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Numeric scheduled_at unsupported:** [Note:61](file:///home/user/workspace/repo/app/models/note.rb#L60-L62) passes an integer to `wait_until`; 8.1 stores it as scheduled_at then serializes with `.utc.iso8601`, which integers lack. Convert the epoch to a Time; reminder scheduling exposes this. [7.2 AJ history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Action Text allowlist now defaults to nil:** [initializer:3](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) does `nil + [...]` and fails boot. Build from `sanitizer_allowed_tags`, not an empty list, to preserve attachment markup and safe defaults. [7.1 Action Text history](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md).
- **Boolean show_exceptions support removed:** [test.rb:31](file:///home/user/workspace/repo/config/environments/test.rb#L30-L34) needs `:none` instead of false to keep exceptions visible to tests. [7.2 Action Pack history](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md).
- **Custom primary-key bracket access changes:** [Import#receipt:68](file:///home/user/workspace/repo/app/models/import.rb#L63-L70) reads `citation[:id]`; citations' primary key is DOI, with no id column ([migration](file:///home/user/workspace/repo/db/migrate/20261011160000_create_imports_and_citations.rb#L1-L5)). Old read_attribute remaps id to the primary key; new code does not. Use `citation.id` or `.doi`; a CSV receipt assertion should catch missing DOI values. [7.1 history](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md). This is mechanical but silently wrong until that path is checked.

## Changes judged not applicable, or not enabled by this upgrade

- **PostgreSQL automatic raw Date decoding:** gated by 7.2 defaults in released configuration source; [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) remains valid with 7.0 defaults. If enabling it later, `Date.iso8601(day)` receives a Date instead of a string and needs adjustment.
- **Readonly assignment errors:** gated by 7.1 defaults; [Notebook's readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) and unchanged slug resubmission retain old behavior. Enabling the new setting later affects even assigning the existing value.
- **No default YAML serializer:** gated by 7.1 defaults; [Notebook#preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) retains YAML. Changing defaults later requires an explicit coder and a decision to preserve existing stored YAML.
- **ETag-only strict freshness:** gated by 8.0 defaults; [export conditional download](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L12) retains the previous ETag/Last-Modified combination rules.
- **After-commit automatic enqueue:** despite the 7.2 changelog description, released 8.1 source defaults `enqueue_after_transaction_commit` to false; no application override found. Do not assume citation/reminder jobs are now automatically deferred. Their existing row-lock/enqueue timing still needs preservation.
- **Cache/message serialization defaults:** 7.1 cache format and new message metadata/serializer defaults are not enabled. 7.0 cache format remains supported; no automatic cache migration or session invalidation established.
- **HTML5 sanitizer default:** gated behind 7.1 defaults; HTML4 remains selected. ContentAttachment sanitization does differ in endpoint source, but no application-created HTML ContentAttachment payload was found; do not mistake the 7.2 security changelog alone for a newly introduced exposure/fix relative to a patched 7.0.8.7.
- **Action Cable features:** no application subscriptions/broadcasts found; Redis is configured but not evidence of usage.
- **Action Mailbox / net-imap 0.6.8:** no inbound processing or IMAP calls found. Compared released net-imap library sources: parser/debug/Ractor utility fixes do not affect outgoing file/test mail.
- **Active Storage cloud services, variants, previewers:** only Disk is configured and no image processor is installed; cloud/transformer changes do not apply. Existing signed URL access policy is not repaired by this upgrade.
- **MySQL/SQLite, multi-database, composite PK, encrypted attributes:** unused by configured application/schema; their adapter/API changes are excluded.
- **New-app defaults and generators:** Solid Queue/Cache/Cable, Propshaft, authentication generator, deployment templates, YJIT/Regexp defaults do not replace this application's configured stack merely by changing the gem.
- **Rack 3 migration:** not selected; rack-session 1.0.2 and rackup 1.0.1 preserve the Rack 2 line. Their extracted session/server code is relevant infrastructure, but no app-specific changed session contract was established from inspected sources.
- **JSON 3.1.0 removals:** released history removes `create_additions`, mutable default options, and several aliases. Inspected app paths use JSON.parse/to_json, and Sidekiq 6.5 uses JSON.parse/generate, not those removed APIs. No confirmed break found; tags, provider parsing, and queue JSON remain worth checking because a Ruby default gem is now explicitly replaced. [JSON history](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).
- **BigDecimal 4.1.3 / URI 1.1.2:** the app uses constructor/division/rounding and URI.parse with HTTP/host checks; no concrete newly incompatible input was established. Do not confuse the new BigDecimal gem with the separately confirmed Active Job payload-format change. These newly locked major versions warrant targeted arithmetic/provider-URL checks after an upgrade is authorized.
- **drb/securerandom/useragent/webrick additions and method_source removal:** framework runtime, test/server, browser-detection, or console dependencies; no custom app use that establishes a behavioral regression was found. No `allow_browser` policy is introduced automatically.
- **Active Model password-reset tokens and Action Mailer new APIs:** optional additions unused by the current password login and synchronous mailers; no direct migration identified.

## Limits and next decision

Reviewed upstream 7.1/7.2/8.0/8.1 component changelogs, PR #48600's patch, endpoint source-diff inventory and relevant implementation diffs, dependency metadata, and selected newly resolved gem sources/history. This is a targeted review, not an exhaustive audit of every intervening patch commit or third-party dependency; “not established” is not a compatibility guarantee. No upgrade, migration, test execution, or application boot was performed.

**Recommendation (Inference):** do not treat the successful lock resolution as a safe deployment. First decide import atomicity, digest day/payload rollout, and provider configuration. Then make the mechanical API fixes and authorize targeted verification of failed imports, mixed queued digests, reminder scheduling/DST, expired export caching, and rich-text edit/upload round-trips. Keep changing framework defaults separate from changing the Rails version.
