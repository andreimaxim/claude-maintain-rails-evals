## Application facts behind the ratings

This assessment assumes **upgrading Rails while retaining `config.load_defaults 7.0`**, as currently configured—not adopting all Rails 8.1 defaults.

**Code read:**
- Ruby 3.3.6 satisfies Rails 8.1’s Ruby ≥3.2 requirement. PostgreSQL uses `pg` 1.6.0; the actual deployed PostgreSQL version is unverified. See [Gemfile](file:///home/user/workspace/repo/Gemfile#L4-L17) and [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L22).
- This is an HTML application using ERB, Sprockets, importmap, Action Text and Disk-backed Active Storage—not a JSON-only API.
- Active Job uses Sidekiq 6.5.12 outside tests. Exports use native Sidekiq jobs. See [configuration](file:///home/user/workspace/repo/config/application.rb#L12-L24) and [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L11).
- Imports, serialized note tags, notebook preferences, time-zone-sensitive digests, reminders and expiring export fragments exercise changed framework behavior.
- The browser explicitly loads **vendored Trix 1.3.5**, independently of Rails’ supplied Trix. See [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14).

**Dependency-resolution evidence:** I copied the Gemfile and lockfile, changed only Rails’ requirement, and successfully ran `bundle lock --update rails` there.

| Resolution result | Versions |
|---|---|
| Rails and its framework gems | 7.0.8.7 → 8.1.0 |
| Existing dependency updated | `net-imap` 0.6.7 → 0.6.8 |
| Newly locked dependencies | `action_text-trix` 2.1.19, `bigdecimal` 4.1.3, `drb` 2.2.3, `json` 3.1.0, `rack-session` 1.0.2, `rackup` 1.0.1, `securerandom` 0.4.1, `uri` 1.1.2, `useragent` 0.16.11, `webrick` 1.9.2 |
| Removed | `method_source` |
| Not upgraded | Rack 2.2.24, Sidekiq 6.5.12, Redis, Puma, PostgreSQL driver, Faraday, Pagy, Turbo and Sprockets |

The newly explicit standard-library dependencies matter: this sandbox currently supplies JSON 2.7.2 and BigDecimal 3.1.5. Resolution reflects today’s available gems, not only those available when Rails 8.1.0 shipped.

## High-risk changes

### 1. Failed imports can leave partial data committed

**History + source:** Rails 7.0 rolls back a written transaction exited through a non-local `return`; Rails 7.2 removes that behavior and commits instead. Retaining 7.0 defaults does not preserve it. [Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Application:** [`Import#apply`](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and each note inside a transaction, then executes `return false unless row.note.save`.

**Consequence—inference from both code paths:** If a later note fails validation, earlier notes and the import can remain committed while the controller presents a failed import. Retrying can duplicate those earlier rows. This needs explicit rollback behavior before upgrading.

### 2. Digest jobs change both their wire format and their content day

**History + source:**
- BigDecimal arguments previously passed through Active Job and became strings in JSON queues. New versions use `BigDecimalSerializer`; Rails 7.0 workers cannot deserialize that new serializer.
- Rails 7.2 preserves a serialized `TimeWithZone` argument’s original zone rather than reconstructing it in the worker’s zone.

Sources: [7.1 Active Job changelog](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [target time serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

**Application:** [`User#request_digest`](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) reserves a UTC date but queues the reader’s zoned time and a BigDecimal. [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses that argument’s `to_date` and `all_day`.

**Consequences—inference:**
- New producers sharing queues with old workers can produce unreadable jobs.
- Newly produced digests cover the reader’s local day, while reservations remain UTC-based. Near midnight, the subject date and selected notes change silently.
- Previously queued jobs without the zone field retain the fallback behavior, creating different results depending on payload age.

Decide the digest’s intended calendar boundary and coordinate producer/worker rollout.

### 3. Import previews silently lose annotations

**History + source:** Rails 8.0 fixes `HashWithIndifferentAccess#stringify_keys` to stringify integer keys too; previously those keys remained integers. [Changelog](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).

**Application:** [`Import#annotations`](file:///home/user/workspace/repo/app/models/import.rb#L37-L42) keys annotations by integer line number. The [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys`, then still reads `annotations[row.line]`.

**Consequence—inference:** Annotation lookup returns nil, hiding annotations from the preview without removing them from the imported notes. Readers can approve content they were not shown.

### 4. Receipt CSVs silently lose DOIs

**History + source:** Rails 7.2 removes `read_attribute(:id)`’s special mapping to a custom primary key. `record[:id]` uses that reader. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Application:** Citations use `doi` as their primary key ([schema](file:///home/user/workspace/repo/db/schema.rb#L55-L62)), but [`Import#receipt`](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) exports `citation[:id]`.

**Consequence—inference:** The CSV’s DOI becomes nil rather than the DOI primary-key value. Use the intended DOI attribute or primary-key reader explicitly.

### 5. Expired export fragments acquire different cache lifetimes

**History + source:** Rails 7.1 introduces invalid-expiration handling. In the target source, negative `expires_in` is removed; Rails either reports the error or raises, depending on configuration. With retained 7.0 defaults, it reports rather than raises. [Changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [target implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb).

**Application:** The [export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) always computes `expires_in: export.expires_at - Time.current`, including after expiry.

**Consequence—inference:** A negative-lived entry previously expired immediately; the new entry has no per-call TTL and can retain the “Expired” fragment until eviction/invalidation. Adopting newer defaults instead makes this an exception. The [download action](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L5-L15) independently checks authorization and expiry, so this does **not** establish an expired-download bypass.

### 6. Reminder previews change across daylight-saving transitions

**Source:** Rails 7.0’s `TimeWithZone#to_time` preserves an offset under this application’s defaults. Rails 8.1 unconditionally preserves the actual time zone. [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md), [implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

**Application:** [`Note#next_day_reminder_at`](file:///home/user/workspace/repo/app/models/note.rb#L35-L45) calculates `reminder_at.to_time + 86_400`; the [reminder preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays it.

**Consequence—inference:** The resulting instant remains 24 elapsed hours later, but its displayed offset and wall-clock time now follow DST. This fixes the old misleading preview, but changes an observable time contract even with 7.0 defaults.

### 7. HTML attachment sanitization changes editor round trips

**History + endpoint source diff:** Action Text adds sanitization of HTML content attachments when preparing editor content, rather than relying only on final rendered-output sanitization. [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md), [target content implementation](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/content.rb).

**Application:** [CSV imports assign arbitrary body HTML](file:///home/user/workspace/repo/app/models/import.rb#L100-L108), and the [note form](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L50) reopens it in Trix.

**Consequence—inference, conditional on stored content:** Embedded HTML can be stripped or normalized before editing; saving can persist that altered representation. This is security hardening, not a reason to disable sanitization. Existing content attachments need round-trip review. I did not inspect database contents.

## Medium-risk changes

### 8. Citation-provider configuration loses its API

**History:** `Rails.application.secrets` is removed in Rails 7.2. [Railties changelog](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md).

**Before → after:** Rails loaded `config/secrets.yml`; the API no longer exists.

**Application:** [`Citation::Provider#initialize`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) uses it by default.

**Consequence—inference:** Enrichment fails when constructing the provider. Choose credentials, explicit environment-backed configuration, or another supported configuration source; changing the method name alone does not migrate the configuration.

### 9. The retained Sidekiq adapter is deprecated for removal

**History + source:** Rails 8.1 still supplies the adapter, but warns that it will be removed in Rails 8.2; the recommended replacement is supplied by Sidekiq ≥7.3.3. [Adapter source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).

**Application:** [The application selects `:sidekiq`](file:///home/user/workspace/repo/config/application.rb#L22-L24), and the dependency resolution retains 6.5.12.

**Consequence:** This is not a Rails 8.1 dependency-resolution blocker, but it needs a separate Sidekiq upgrade decision before the next Rails release. That decision would require reassessing native export jobs and Redis usage.

### 10. Resolved JSON 3 changes accepted provider responses

**Dependency history:** JSON 3 rejects duplicate keys and comments by default, removes `create_additions`, and rejects unknown options. [JSON changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

**Application:** [`Citation::Provider#metadata_from`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) calls `JSON.parse` and converts parser errors into enrichment failure.

**Consequence—inference:** A provider response previously accepted despite duplicate keys or comments now fails. Whether this occurs is unverified; no real provider payloads were available. Decide whether strict rejection is the contract and consider constraining this newly introduced major dependency separately.

## Low-risk changes: direct mechanical fixes

These are source/history-backed API differences; their application failures are inferred, not executed.

- **Enum declaration:** [Note line 10](file:///home/user/workspace/repo/app/models/note.rb#L10) must become positional `enum :status, …, prefix: true`; keyword declarations were [removed in Rails 8.0](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- **Serialization arguments:** [Note line 12](file:///home/user/workspace/repo/app/models/note.rb#L12) needs `serialize :tags, coder: JSON`; the positional coder was [removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Alias of a store accessor:** [Note lines 13–14](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) alias `color`, which is not a database attribute; [7.2 rejects this](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md). Explicit reader/writer delegation preserves the intended behavior.
- **Action Text initializer:** [`allowed_tags += …`](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) now adds to nil; [7.1 changed its default](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md). Build the extension from the effective sanitizer allowlist, preserving attachment tags.
- **Route aliases:** [The two-path `get`](file:///home/user/workspace/repo/config/routes.rb#L17-L18) must become two route declarations; [8.1 removes multiple-path support](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md).
- **Retry name:** [`:exponentially_longer`](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) becomes `:polynomially_longer`, preserving the actual backoff calculation; [removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Reminder scheduling argument:** [`wait_until: reminder_epoch`](file:///home/user/workspace/repo/app/models/note.rb#L60-L62) must pass a Time rather than numeric epoch; [numeric scheduling support was removed](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **String aggregation:** [`fragments.sum`](file:///home/user/workspace/repo/app/models/export.rb#L42) needs an explicit string identity or `join`; [7.1 removes Rails’ nonnumeric sum override](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md).
- **Test exception configuration:** [`show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) becomes `:none`; [boolean support was removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md).

## Conditional risks and areas ruled out

- **New defaults—medium if adopted:** Notebook preferences rely on implicit YAML, and notebook updates resubmit an `attr_readonly` slug. Rails 7.1 defaults remove the implicit serializer and raise on readonly assignment. These are **not active with retained 7.0 defaults**. [Notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19), [controller](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L25-L40), [defaults source](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).
- **PostgreSQL date decoding—low if enabled:** [`daily_note_counts`](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) expects strings and calls `Date.iso8601`; 7.2 defaults return Date objects. Source confirms decoding remains disabled with this application’s defaults.
- **HTTP freshness—high if enabled:** Newer defaults prioritize ETags when both conditional headers are supplied, rather than requiring both validators to match; this affects [export downloads](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11). `strict_freshness` remains off here. [History](https://github.com/rails/rails/blob/v8.0.0/actionpack/CHANGELOG.md).
- **Automatic after-commit enqueueing:** Not activated in the inspected 8.1 endpoint: `enqueue_after_transaction_commit` defaults to false. Do not assume Rails now moves this application’s locked reminder/enrichment enqueue operations after commit. [Source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb).
- **Trix dependency:** Installing `action_text-trix` does not replace the explicitly loaded vendored script. Compatibility of that old editor with the new Action Text assets remains unverified; do not count the gem update as a browser-editor/security upgrade.
- **BigDecimal:** Division and precision fixes affect the operation used by [reading completion](file:///home/user/workspace/repo/app/models/user.rb#L54-L56). I found no demonstrated four-decimal result difference for this application; this remains a numerical review gap, not a confirmed regression. [History](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md).
- **URI parser-default change:** Not itself a demonstrated provider regression: source shows this Ruby’s old `URI.parse` already uses RFC3986, as does the new version.
- **Rack 3 changes:** Not applicable to the resolved bundle; Rack stays at 2.2.24.
- **MySQL, SQLite, composite-primary-key and Active Record encryption changes:** No corresponding application configuration or use found.
- **Redis/Memcached cache pooling and Solid Cache:** Not applicable; Redis is used for jobs/reservations, not as the configured Rails cache.
- **Solid Queue, Solid Cable, Propshaft and generated authentication:** New-app choices, not automatic replacements for this existing configuration.
- **Cloud storage, image variants and video previews:** No configured cloud service or image-processing dependency; Disk attachments remain relevant, but those backend-specific changes do not.
- **Action Mailbox, IMAP fetching and application Cable broadcasts:** No implemented usage found; `net-imap`’s resolved update has no identified application call site.
- **Remaining new support dependencies:** No specific application regression established for DRb, SecureRandom, rackup, WEBrick or useragent; this is not a claim of exhaustive transitive compatibility.

**Assessment:** This is not a safe version-only upgrade. Prioritize import atomicity and digest queue compatibility, then the mechanical blockers. I inspected release histories and targeted old/new source diffs, but did not install Rails 8.1, boot the application, run tests, or change application files. Temporary research files were removed.