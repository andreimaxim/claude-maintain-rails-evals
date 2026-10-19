# Rails 7.0.8.7 → 8.1.0: application-specific risk assessment

## Application facts the ratings depend on

**Evidence labels:** **History** means a Rails/gem changelog; **Code** means released source or application code inspected; **Inference** means a consequence deduced from those sources, not an executed upgrade test.

- **Code:** Ruby is pinned to 3.3.6 (`Gemfile:4`); Rails 8.1 requires Ruby ≥3.2, so no Ruby upgrade is required.
- **Code:** `config/application.rb:3,12,24` loads all Rails frameworks, **retains `load_defaults 7.0`**, and uses Sidekiq. This report assesses changing the Rails requirement, not adopting 8.1 defaults or regenerating configuration.
- **Code:** PostgreSQL is the sole configured database (`config/database.yml:18–21`). The server version is not established by that file. There is one database per environment, no configured replicas/shards. `db/schema.rb:55` makes DOI, not `id`, the citation primary key.
- **Code:** The app renders HTML/ERB with Turbo, importmap and Sprockets. Rich text uses Action Text; the layout explicitly loads vendored **Trix 1.3.5**, not the Rails-provided Trix asset (`app/views/layouts/application.html.erb:11–16`, `config/importmap.rb:8`, `app/javascript/application.js:5`).
- **Code:** Action Text extends the sanitizer allowlist (`config/initializers/action_text.rb:3`). Uploads and generated exports use local Active Storage. The blob partial deliberately uses originals (`app/views/active_storage/blobs/_blob.html.erb:1–4`); no image processor/cloud service dependency is present.
- **Code:** Active Job runs on Sidekiq 6.5.12 / Redis 4.8.1; `ExportJob` is native Sidekiq (`app/jobs/export_job.rb:4`). Digest jobs carry a zoned time and BigDecimal (`app/models/user.rb:34–56`). Reminders enqueue inside row locks (`app/models/note.rb:56–62`); citation enrichment does too (`app/models/citation.rb:14–20`).
- **Code:** Production enables fragment caching and does not override the Rails cache store (`config/environments/production.rb:17–19,65–66`); development uses memory/null store (`config/environments/development.rb:22–34`). Redis is used for jobs and digest reservations, not as the configured fragment cache. Production mail delivery and infrastructure are not established; development writes mail to files (`config/environments/development.rb:39–43`).

### Actual dependency resolution

**Code / observed resolver result:** Copied Gemfile and lockfile to an isolated temporary directory, changed only Rails to `8.1.0`, and ran `bundle lock --update rails` successfully on 2026-10-19. Nothing was installed. All 13 Rails packages (Rails, Railties, Active Support/Model/Record/Job/Storage and Action Pack/View/Text/Mailer/Mailbox/Cable) move together to 8.1.0.

Other changes: **added** `action_text-trix 2.1.19`, `bigdecimal 4.1.3`, `drb 2.2.3`, `json 3.1.0`, `rack-session 1.0.2`, `rackup 1.0.1`, `securerandom 0.4.1`, `uri 1.1.2`, `useragent 0.16.11`, `webrick 1.9.2`; **updated** `net-imap 0.6.7 → 0.6.8`; **removed** `method_source 1.1.0`. Gems newly explicit in the lockfile can replace Ruby default gems at runtime; absence from the old lockfile does not mean the functionality was absent.

**Rack stays 2.2.24**, Sidekiq stays 6.5.12, Redis stays 4.8.1, Puma stays 5.6.9, pg stays 1.6.0; sanitizer/Nokogiri, Turbo, importmap and Sprockets also stay locked. Do not assume Rack 3, Sidekiq 7 or Solid Queue are part of this resolution. Resolution is not proof that these old integrations work with Rails 8.1.

## High-risk changes

### 1. Failed imports can partially commit (7.2 removal of rollback-on-return)

**History:** [Rails 7.2 Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md) removes rollback when a transaction exits through `return`, `break` or `throw`; [7.1 history](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md) explains the transition. **Code:** The endpoint versions' transaction implementations confirm this is no longer controlled by the old compatibility setting in 8.1.

Before: a non-local return rolled back with this app's 7.0 behavior. Now: normal non-local exit commits. **Application:** `app/models/import.rb:50–60` saves the import and then `return false unless row.note.save` from inside the transaction.

**Inference:** If a later row fails validation, the import and earlier notes can remain committed despite an apparent failed batch. This directly breaks the all-or-nothing data contract. Decide to use an explicit rollback/exception path; inspect a failure after at least one successful row, not just a failure in the first row.

### 2. CSV receipts silently lose citation DOIs (7.2)

**History:** [7.2 Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md) removes `read_attribute(:id)` returning a custom primary key. **Code:** `[]` delegates to `read_attribute`; 7.0 rewrites `id` to the primary key, 8.1 does not ([new read implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb)).

Before: `citation[:id]` returned the DOI. Now: it asks for an actual `id` attribute; there is none on Citation. **Application:** `app/models/import.rb:63–69`, `db/schema.rb:55–62`.

**Inference:** CSV generation can emit an empty DOI rather than the cited identifier (or expose a missing-attribute failure depending on the loaded record). Use the real DOI/primary-key reader. Review receipts with nonblank DOIs; ordinary `citation.id` remains the primary-key interface.

### 3. Digest day changes when zoned arguments retain their zone (7.2)

**History:** [7.2 Active Job changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md). **Code:** [8.1 TimeWithZone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb) adds `time_zone` and restores it; 7.0 restored the instant in the worker's current zone.

Before: the UTC worker received the request time in UTC. Now: newly enqueued arguments retain the reader's zone. **Application:** `app/models/user.rb:35–41` reserves a **UTC** date, while `app/mailers/digest_mailer.rb:7–12` uses `requested_at.to_date` and `requested_at.all_day`.

**Inference:** Near midnight, the reservation still uses a UTC day but the email selects/dates a local day. Even away from midnight the selected interval shifts for non-UTC readers. Old payloads lacking `time_zone` keep the fallback behavior, so queue contents can yield different semantics during rollout. Choose UTC-day versus reader-day semantics explicitly.

### 4. BigDecimal job payload format changes (mandatory by 7.2)

**History:** [7.1 Active Job changelog](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md) explains the serializer and rolling-deployment risk; [7.2](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md) removes the primitive path. **Code:** [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

Before: Sidekiq's JSON round trip turned the unwrapped decimal into a string. Now: Active Job writes a tagged `BigDecimalSerializer` argument and restores a decimal. **Application:** `app/models/user.rb:41,53–56`, `app/jobs/digest_job.rb:6–7`, `app/mailers/digest_mailer.rb:10`.

**Inference:** Old 7.0 workers cannot deserialize new decimal payloads; this is a cross-version queue/rollback hazard even though the mailer explicitly converts its input. Drain/isolate queues or coordinate producer/worker cutover, including scheduled/retry jobs. The newly resolved BigDecimal 4.1.3 is an additional numeric-runtime change, not the cause of this Rails wire-format change; its historical runtime comparison was not fully established here.

### 5. Negative fragment TTL is discarded rather than expiring immediately (7.1+)

**History:** [7.1 Active Support changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md) introduces invalid-expiration handling. **Code:** [8.1 cache `merged_options`](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb) deletes negative `expires_in`, then logs/reports or raises. With 7.0 defaults the class flag is false, so it reports rather than raising.

Before: an already-past TTL produced an expired entry. Now: the negative TTL is removed and the write falls back to store defaults. **Application:** `app/views/exports/_export.html.erb:25–38` computes `export.expires_at - Time.current`, including for already expired exports.

**Inference:** An expired indicator can persist without its intended TTL; the initial expiry-boundary render can also report an error. The authoritative download check remains separate (`app/controllers/export_downloads_controller.rb:5–15`), so this does **not** establish unauthorized downloads. This is high under the requested caching-behavior rubric, although the visible stale indicator's business impact is limited. Adopting ≥7.1 defaults later changes this to an exception unless corrected.

### 6. `to_time` keeps a zone, not merely its current offset (8.1)

**History:** [8.1 Active Support changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md) removes old conversion behavior and deprecates the compatibility setting. **Code:** [TimeWithZone#to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb) now unconditionally returns a zone-aware Time; retained 7.0 defaults do not preserve the old implementation.

Before: adding elapsed seconds to the converted Time kept the original fixed offset. Now: zone rules can change its displayed offset after a DST transition. **Application:** `app/models/note.rb:40–44,71–72` and the reminder preview using that method.

**Inference:** The reminder's `to_i` still represents 24 elapsed hours later, but the preview's wall time/offset changes across DST. This is a silent, user-visible time-zone change, not evidence that reminders move to the wrong instant. Confirm the desired presentation using a DST-crossing example.

## Medium-risk changes

### 7. Secrets API removed (7.2)

**History:** [7.2 Railties changelog](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md). Before: Rails loaded `config/secrets.yml` and exposed `Rails.application.secrets`. Now: that API is gone. **Application:** `app/models/citation/provider.rb:13–14` reads its URL and credentials through it.

**Inference:** Normal enrichment jobs fail constructing the provider, rather than reporting a configured/unconfigured provider result. Choose credentials, explicit environment configuration, or another maintained configuration source. It is not just a rename: preserve the environment-backed structure and credential handling intentionally.

### 8. Alias to a store accessor no longer supported (7.2)

**History:** [7.2 Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md) removes `alias_attribute` targeting nonexistent database attributes. Before: aliasing the generated Ruby accessor worked. Now: attribute-method generation rejects the alias target if it is not a real attribute. **Application:** `app/models/note.rb:13–17` makes `color` a JSONB store accessor then aliases `highlight_color` to it; `db/schema.rb:100` has `settings`, not a `color` column.

**Inference:** Note attribute-method generation can raise, blocking forms and model use. Choose explicit accessor delegation or expose the store accessor directly, preserving the public form field and validation contract. Renaming a database column is not a correct automatic fix.

### 9. Built-in Sidekiq adapter deprecated in 8.1; removed in 8.2

**History and Code:** [8.1 Active Job changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md), [adapter source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb). Before: supported Rails-provided adapter. Now: still present, but instructs upgrading to Sidekiq ≥7.3.3 for Sidekiq's own adapter.

**Application:** `config/application.rb:24`, `Gemfile` pins Sidekiq 6.5.12 and Redis 4.8.1. **Inference:** Not an immediate missing-adapter failure in 8.1, but a next-release removal requiring a separate Sidekiq/Redis compatibility and rollout decision. Do not silently expand this Rails-only upgrade to Sidekiq 7.

### 10. Resolved JSON 3.1 is stricter than the unpinned default JSON runtime

**History:** [JSON changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md): JSON 3 rejects duplicate keys/comments by default, removes `create_additions` and legacy APIs; 3.1 rejects non-ASCII BINARY strings during generation. **Code:** `app/models/citation/provider.rb:42–52` parses provider JSON and turns parser errors into enrichment failures; Note serializes tags with JSON (`app/models/note.rb:12`).

Before: behavior depended on the unlocked Ruby-provided JSON; its deployed version is not recorded. Now: resolution explicitly selects 3.1.0. **Inference, conditional:** A formerly tolerated provider response with duplicate keys/comments is now rejected. Choose strict rejection or provider normalization rather than assuming every old response remains accepted. Normal string-array tags do not establish a data-format break. Compatibility of all locked third-party gems with JSON 3's removed APIs remains a source-review gap, not a verified pass.

## Low-risk / mechanical changes

- **Code + History:** `config/initializers/action_text.rb:3` adds tags to an accessor now initialized to **nil** ([7.1 Action Text history](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md)); boot fails on `nil + array`. Build the override from `sanitizer_allowed_tags` so defaults and attachment tags survive.
- **Code + History:** `app/models/note.rb:10` uses removed keyword enum syntax ([8.0 Active Record history](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md)); convert to `enum :status, { draft: 0, ready: 1 }, prefix: true`, preserving generated names and stored values.
- **Code + History:** `app/models/note.rb:12` passes a positional serializer, removed in [7.2](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md); use `serialize :tags, coder: JSON` without changing existing stored JSON.
- **Code + History:** `app/jobs/citation_enrichment_job.rb:7` uses removed `wait: :exponentially_longer` ([7.2 Active Job history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md)); `:polynomially_longer` is the direct replacement preserving the actual algorithm.
- **Code + History:** `app/models/note.rb:61` passes an integer to `wait_until`; 8.1 stores it unchanged and later calls `.utc` during serialization ([core source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb)). Convert the epoch to a Time; scheduling otherwise raises.
- **Code + History:** `app/models/notebook.rb:40` calls `Date.iso8601(day)` after raw `select_rows`; PostgreSQL now decodes dates as Date by default ([7.2 history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md)). Use the decoded Date or explicitly disable the adapter decoding; current code raises rather than silently producing wrong counts.
- **Code + History:** `app/models/export.rb:42` sums strings with no identity; Rails removed its nonnumeric `sum` override ([7.1 Active Support history](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md)). Use a string identity or `join`; Ruby's default numeric identity raises.
- **Code + History; inference:** Action Text now obtains Trix ≥2.1.15 from a separate gem ([8.1 history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md)), resolved to 2.1.19, but the app explicitly serves 1.3.5. **The editor is not automatically upgraded.** Reconcile the explicit asset with the supported Trix version and check edit/upload round trips. Incompatibility of this exact mixed-version pair was not established by execution; this low rating covers asset wiring, not an assertion that rich-text data migration is safe.
- **Code + History:** Action Text 8.1 changes upload progress and assigns embeds before validation ([history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md)); the app validates blob sizes via body attachables (`app/models/note.rb:95–97`), not the embeds callback. Inspect direct-upload acceptance/rejection and UI progress; no app-specific semantic failure was established.

## Changes / framework areas not implicated by this setup

- **Code:** New-app Solid Queue/Cache/Cable, Propshaft, authentication generator and deployment tooling are not adopted by changing this Gemfile; the app retains explicit Sidekiq, Sprockets and custom sessions.
- **Code:** Rails 7.1+ readonly-assignment default is not enabled with `load_defaults 7.0`; `Notebook#attr_readonly :slug` (`app/models/notebook.rb:8`) therefore does not automatically make the resubmitted slug field fail.
- **Code:** The new no-default-column-serializer setting belongs to 7.1 defaults; `serialize :preferences` (`app/models/notebook.rb:7`) retains the inherited YAML coder here. Changing defaults or switching stored preferences to JSON is a separate stored-data migration.
- **Code:** HTML5 sanitization is enabled by 7.1 defaults, not this version-only change. The nil-allowlist API break above still applies. Attachment-content security sanitization fixes are present, but the app does not implement custom HTML content attachments; ordinary stored HTML should still receive round-trip review.
- **Code:** New message/cookie serializers and cache format 7.1 are defaults-gated. No deliberate session/cache-format migration is established by this upgrade alone; existing sessions use `session[:user_id]` (`app/controllers/sessions_controller.rb`).
- **Code:** Active Job 8.1 defaults `enqueue_after_transaction_commit` to false. Despite 7.2's announcement, this target does **not** automatically defer this app's locked enqueues. Changing that setting would require reviewing Redis-error rollback behavior in `Note#schedule_reminder` and `Citation#request_enrichment` separately.
- **Code:** New strict HTTP freshness default is not enabled with 7.0 defaults; `stale?` in `app/controllers/export_downloads_controller.rb:11` is relevant to a later defaults migration, not an automatic 8.1 behavior switch.
- **Code:** MySQL/SQLite adapter changes are not applicable to PostgreSQL; PostgreSQL composite keys, generated columns, geometric/network types, bulk upserts, replicas and sharding have no matching application usage/schema here.
- **Code:** Action Cable broadcasting changes are not implicated: only generated base channel/connection classes are present, with no app streams/broadcasts.
- **Code:** Action Mailbox/IMAP changes are not implicated: no inbound mailbox implementation; `net-imap 0.6.8` is resolved but app mailers send messages rather than fetching IMAP mail.
- **Code:** Active Storage image/video processing, variants, cloud adapters and proxy immutable caching changes have no matching usage: local Disk storage, original-image blob redirects, and application-controlled export downloads.
- **Code:** Action Mailer deferred-delivery options have no matching use: both implemented jobs call `deliver_now`. The lock resolution retains the same `mail` gem.
- **Code:** Active Model's password-reset token additions do not replace the app's `has_secure_password` sign-in (`app/models/user.rb:5,15–16`); no reset-token endpoint exists.
- **Code:** Rack 3 protocol changes are not part of this lock resolution. New rack-session 1.0.2 supplies Rack-2-compatible session extraction; it must not be confused with rack-session 2's Rack-3 requirements.
- **Code / limited inference:** `rackup`/WEBrick are new server tooling dependencies, not a replacement for configured Puma; DRb supports framework tooling; useragent serves browser-policy APIs not invoked by the app; securerandom supports framework identifiers. No application-specific changed contract was established for these additions, URI 1.1.2, or removal of method_source. Their complete upstream histories were not audited.

## Scope and confidence

Read release-tag changelogs at 7.1.0, 7.2.0, 8.0.0 and 8.1.0; compared released endpoint source trees and followed the concrete implementations behind the findings. The endpoint diff covers changes omitted from milestone changelogs, but this was a targeted review, not a claim to have audited every one of its 3,296 changed files or every intervening patch changelog. Downloaded/unpacked selected new transitive gems and inspected their source/history; BigDecimal/URI and remaining new tooling histories are incomplete as noted above.

No application boot, tests, migrations, new-version installation or live-provider requests were performed. Findings are static evidence and explicit inference, not demonstrated runtime failures. Before approving the upgrade, prioritize import rollback, digest UTC/local-day semantics, queue compatibility, CSV DOI preservation, DST presentation and expired-fragment behavior; then repair the mechanical blockers and exercise request/system/job tests in an authorized upgrade workspace.
