## Application facts and scope

This is a **high-risk upgrade**, principally because imports can partially commit and digest contents can change without errors.

The assessment assumes **only Rails changes to 8.1.0**, while [`config.load_defaults 7.0`](file:///home/user/workspace/repo/config/application.rb#L12) stays in place.

**Facts from application code:**
- Ruby 3.3.6; PostgreSQL; HTML/ERB with Sprockets, importmap, Turbo and Action Text.
- Sidekiq 6.5.12 and Redis 4.8.1 handle jobs; tests explicitly use Active Job’s test adapter.
- Notes use JSON-serialized tags, a JSONB settings column, rich text and local-disk attachments.
- CSV imports save multiple records in one transaction. Digests enqueue zoned times and `BigDecimal` values.
- Production enables fragment caching without selecting an external cache store. Redis is not configured as the Rails cache.
- The layout explicitly loads vendored Trix 1.3.5; upgrading Rails does not replace that script.

**Dependency-resolution evidence:** `bundle lock --update rails` succeeded in a temporary copy. All Rails components move to 8.1.0. Rack remains **2.2.24**, constrained by Sidekiq; this is **not a Rack 3 upgrade**. Other changes:
- Added: `action_text-trix 2.1.19`, `bigdecimal 4.1.3`, `json 3.1.0`, `drb 2.2.3`, `securerandom 0.4.1`, `uri 1.1.2`, `rack-session 1.0.2`, `rackup 1.0.1`, `useragent 0.16.11`, `webrick 1.9.2`.
- Updated: `net-imap 0.6.7 → 0.6.8`.
- Removed: `method_source`.
- The installed Ruby currently supplies BigDecimal 3.1.5 and JSON 2.7.2 as default gems; the newly locked versions therefore matter.

I read release changelogs across 7.1, 7.2, 8.0 and 8.1 and compared the released Rails source trees. Below, **History** means upstream release history, **Code** means inspected implementation/application code, and **Inference** means predicted impact—not an executed reproduction.

## High-risk changes

### 1. Failed imports can leave partially saved batches

**History:** [Rails 7.2 removes rollback on non-local transaction exits](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Before → after:** Rails 7.0.8.7 rolls back a written transaction exited through `return`; 8.1 commits unless an exception or other rollback condition intervenes. Keeping 7.0 defaults does not retain the old behavior.

**Application:** [`Import#apply`](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, then returns `false` from inside the transaction when a note fails validation.

**Inference:** An invalid later row can leave the import and earlier notes committed while the controller renders a failed-import response. This directly breaks the all-or-nothing contract. Review explicit rollback behavior before upgrading.

### 2. Digests switch from UTC days to readers’ local days

**History:** [Rails 7.2 preserves serialized `TimeWithZone` zones](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

**Before → after:** The old serializer preserves the instant but reconstructs it in the worker’s zone. The new serializer includes and restores the originating zone.

**Application:** [`User#request_digest`](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC date**, but enqueues the request time in the reader’s zone. [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) derives both the subject date and `updated_at` query window from that argument.

**Inference:** New jobs select a local calendar day while deduplication still follows UTC. Around midnight, different notes and a different subject date can result. Old queued payloads lack the zone field, so behavior can also depend on when the job was enqueued. Decide which calendar defines the digest.

### 3. New BigDecimal job payloads cannot be read by old workers

**History:** [Rails 7.1 introduces BigDecimal serialization](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md); [7.2 removes the primitive fallback](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

**Before → after:** JSON-backed queues previously turned the argument into a string. Rails 8.1 writes a typed `BigDecimalSerializer` payload.

**Application:** [`User#reading_completion`](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) supplies that argument to `DigestJob`; [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) converts it with `BigDecimal(...)`.

**Inference:** The mailer’s conversion accommodates the changed type, but Rails 7.0 workers do not know the new serializer. A rolling deployment or rollback can strand new digest jobs. Plan queue/worker compatibility, not just application boot.

### 4. CSV receipts silently lose DOI values

**History:** [Rails 7.2 removes `read_attribute(:id)`’s custom-primary-key fallback](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Before → after:** `citation[:id]` previously read the custom primary key; now it reads the literal `id` attribute.

**Application:** [`Import#receipt`](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) exports `citation[:id]`, but [`citations` uses `doi` as its primary key](file:///home/user/workspace/repo/db/schema.rb#L55-L62), with no `id` column.

**Inference from code:** Receipts produce an empty DOI field rather than the DOI. Use the intended `doi` or primary-key reader explicitly.

### 5. Import previews silently omit annotations

**History:** [Rails 8.0 fixes `HashWithIndifferentAccess#stringify_keys`](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).

**Before → after:** Previously this operation effectively duplicated the indifferent hash, leaving integer keys intact. It now stringifies integer keys too.

**Application:** [`Import#annotations`](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) keys annotations by integer source-line numbers. The [preview stringifies those keys and then looks up integers](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44).

**Inference:** Annotation lookups return `nil`, hiding annotations in previews even though import assignment still stores them.

### 6. Expired export fragments lose their expiration

**History:** [Rails 7.1 adds invalid cache-expiration handling](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md). **Code:** [8.1 deletes negative `expires_in` values before reporting the error](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L908-L945).

**Before → after:** Negative TTLs previously produced already-expired entries. Under retained 7.0 defaults, the new implementation reports the invalid value without raising and removes the TTL.

**Application:** The [export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) computes `expires_in: export.expires_at - Time.current`, which becomes negative after expiry.

**Inference:** The expired-state fragment can be cached without a deadline. A render crossing the deadline also deserves attention. This does **not** establish unauthorized downloads: the [download controller independently checks availability](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L15). Adopting newer defaults instead changes this case into an exception.

### 7. Reminder previews change across daylight-saving boundaries

**History:** [Rails 8.1 changes `to_time` timezone preservation](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md). **Code:** `TimeWithZone#to_time` now returns a `Time` carrying the receiver’s zone.

**Before → after:** The application’s old conversion preserves a fixed UTC offset; the new conversion retains timezone rules.

**Application:** [`Note#next_day_reminder_at`](file:///home/user/workspace/repo/app/models/note.rb#L40-L44) adds 86,400 seconds after conversion; the [reminder view displays it](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20).

**Inference:** Across DST, the preview’s offset and wall-clock time change. This appears to correct the existing misleading preview; the elapsed-time postponement remains 24 hours. It is nevertheless an observable timezone change.

### 8. JSON 3 changes accepted external and persisted data — conditional risk

**History:** [JSON 3.1.0’s changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md) records rejection of duplicate keys and comments by default, stricter escapes, and removal of legacy loading options.

**Before → after:** Some documents accepted by JSON 2.7.2 now raise parsing errors.

**Application:** [`Citation::Provider#metadata_from`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) parses external JSON and converts parse failures into enrichment failure; [`Note`](file:///home/user/workspace/repo/app/models/note.rb#L12-L13) also uses JSON serialization.

**Inference:** Provider responses containing formerly tolerated JSON can switch from successful enrichment to recorded failure. Historical nonstandard serialized data could become unreadable. I did **not** inspect production payloads or stored values, so exposure is unverified; normal JSON string arrays are not evidence of a problem.

## Medium-risk changes

### 9. Citation-provider configuration loses `Rails.application.secrets`

**History:** [Rails 7.2 removes `Rails.application.secrets`](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md).

**Before → after:** The provider could read `config/secrets.yml` through Rails; that API no longer exists.

**Application:** [`Citation::Provider#initialize`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) uses it by default, and citation-enrichment tests use it too.

**Inference:** Provider initialization fails before making its HTTP request. Choose an explicit environment-backed configuration or credentials arrangement; merely renaming the accessor does not preserve the existing configuration source.

### 10. Sidekiq’s built-in Rails adapter is deprecated for removal in 8.2

**History/code:** [Rails 8.1’s adapter warning](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L33-L38) requires Sidekiq 7.3.3 or newer for the replacement supplied by Sidekiq.

**Before → after:** The built-in adapter remains available in 8.1, but is scheduled for removal in the next release.

**Application:** [`config.active_job.queue_adapter = :sidekiq`](file:///home/user/workspace/repo/config/application.rb#L22-L25), with Sidekiq pinned at 6.5.12.

**Inference:** This is not an immediate dependency-resolution failure, but requires a separate Sidekiq upgrade decision. That would also reopen Rack, Redis-client and native-job compatibility; those upgrades are not included in this resolution.

## Low-risk, mechanical changes

Each follows upstream history and the cited application call site:

- **Enum declaration:** [`Note` line 10](file:///home/user/workspace/repo/app/models/note.rb#L10) uses removed keyword syntax; use positional name/mapping and `prefix: true`. [Rails 8.0 history](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- **Serialized tags:** [`serialize :tags, JSON`](file:///home/user/workspace/repo/app/models/note.rb#L12) needs `coder: JSON`. [Rails 7.2 history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Store-accessor alias:** [`alias_attribute :highlight_color, :color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) targets a store accessor, not a database attribute; replace with ordinary reader/writer delegation. [Rails 7.2 history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Action Text initializer:** [`allowed_tags += ...`](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) now adds to `nil`; derive the effective sanitizer allowlist before extending it, preserving attachment tags. [Rails 7.1 history](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md).
- **Retry delay:** [`wait: :exponentially_longer`](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) becomes `:polynomially_longer`, preserving the existing formula. [Rails 7.2 history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Reminder scheduling:** [`wait_until: reminder_epoch`](file:///home/user/workspace/repo/app/models/note.rb#L61) must receive a time object; numeric `scheduled_at` support was removed and serialization calls `.utc`. [Rails 7.2 history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **String aggregation:** [`fragments.sum`](file:///home/user/workspace/repo/app/models/export.rb#L42) needs an explicit string identity or `join`; Ruby’s native sum starts with numeric zero. [Rails 7.1 history](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md).
- **Route alias:** [`get "/notes", "/journal"`](file:///home/user/workspace/repo/config/routes.rb#L21-L22) must become separate route declarations. [Rails 8.1 history](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md).

## Changes screened out or not established as application risks

These are **code-based conclusions**, not assurances that the entire framework is unaffected:

- **PostgreSQL date decoding:** Not enabled with retained 7.0 defaults; [`daily_note_counts`](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) remains relevant if newer defaults are adopted, because it parses returned strings.
- **Default YAML serializer removal / readonly assignment errors:** Both newer-default choices; [`Notebook` preferences and slug](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) retain their old defaults in this assessment.
- **Automatic post-commit enqueueing:** Not enabled by this application; 8.1’s job-class default is `false`. Do not assume jobs under row locks become deferred automatically.
- **HTTP conditional-request precedence:** New strict freshness remains off with 7.0 defaults; the export’s ETag/Last-Modified handling does not automatically switch.
- **Exception rendering:** The removed boolean setting is relevant, but the fix is mechanical: [`show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) must become `:none`. **Code warning:** leaving `false` silently falls through to rendering exceptions in 8.1, potentially masking test failures. Treat this as **high-risk test-behavior drift until fixed**, not a boot error.
- **Trix dependency:** The new gem does not replace the explicitly loaded 1.3.5 script; do not count its editor/security changes as delivered. Compatibility of that old editor with the upgraded Action Text upload integration remains unverified.
- **Action Text HTML5 sanitizer default:** Not adopted with 7.0 defaults; the initializer failure above still applies independently.
- **Cloud storage, variants and previews:** No configured S3/GCS/Azure service or image processor; those changes are outside the current application path.
- **Action Cable and Action Mailbox:** No application broadcasts or inbound-mail handling found.
- **MySQL, SQLite, sharding and record encryption:** Not used.
- **Rack/session extraction:** Rack stays at 2.2.24; inspected `rack-session 1.0.2` is a compatibility shim, not replacement session behavior.
- **Net::IMAP:** Its patch upgrade does not affect the application’s outgoing file/test mail delivery.
- **BigDecimal arithmetic:** Division implementation and precision fixes changed, but I found no demonstrated changed result for the app’s four-decimal completion calculation; queue-format incompatibility is established separately above.
- **Other added support gems:** No specific application regression established for DRb, SecureRandom, URI, rackup, useragent or WEBrick; their full transitive behavior is not exhaustively audited.

**Delivery state:** Read-only assessment completed. No application files or lockfile were changed, no new versions were installed, and the application/tests were not run. Temporary source and resolution files were removed.