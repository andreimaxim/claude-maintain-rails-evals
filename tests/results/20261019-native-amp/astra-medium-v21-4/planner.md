## Application facts and upgrade scope

This assessment assumes **upgrading the gems while retaining `config.load_defaults 7.0`**, as configured in [application.rb](file:///home/user/workspace/repo/config/application.rb#L9-L24). Adopting Rails 8.1 defaults is a separate change.

**Observed in application code/configuration:**

- Ruby **3.3.6**, PostgreSQL, Puma, Sprockets, importmap, Turbo, and server-rendered ERB—not a JSON-only application. Ruby meets Rails 8.1’s ≥3.2 requirement.
- Active Job uses **Sidekiq 6.5.12 / Redis 4.8.1**; tests use the test adapter. Exports use a native Sidekiq job.
- Notes use Action Text and local-disk Active Storage. The layout explicitly loads **vendored Trix 1.3.5**; upgrading Rails does not replace that script.
- Imports write multiple records transactionally. Tags use JSON serialization; notebook preferences use implicit YAML serialization; highlight colors live in JSONB.
- Digests carry zoned times and `BigDecimal` arguments. Reminders use integer epoch times.
- Production enables fragment caching without overriding Rails’ default file store. Development uses memory/null stores; Redis is **not** the application cache.
- Citation-provider configuration uses `Rails.application.secrets`. Credentials and production data were not inspected.

**Dependency resolution:** I copied `Gemfile` and `Gemfile.lock`, changed only Rails to 8.1.0, and successfully ran `bundle lock --update rails` in the copy.

| Resolution result | Versions |
|---|---|
| Rails and its 12 companion framework gems | 7.0.8.7 → 8.1.0 |
| Existing dependency updated | `net-imap` 0.6.7 → 0.6.8 |
| Newly locked dependencies | `action_text-trix` 2.1.19, `bigdecimal` 4.1.3, `drb` 2.2.3, `json` 3.1.0, `rack-session` 1.0.2, `rackup` 1.0.1, `securerandom` 0.4.1, `uri` 1.1.2, `useragent` 0.16.11, `webrick` 1.9.2 |
| Removed dependency | `method_source` |
| Not upgraded | Rack 2.2.24, Sidekiq, Redis, Puma, PostgreSQL driver, Faraday, Pagy, Hotwire gems, sanitization gems |

The newly locked standard-library gems replace Ruby 3.3.6’s defaults, notably JSON 2.7.2 and BigDecimal 3.1.5. These versions reflect resolution **today**, not Rails 8.1’s original release date.

Below, **history** means upstream changelog/release evidence; **code** means inspected source. Application consequences are **static inferences**, not executed reproductions.

## High-risk changes

### 1. Failed imports can commit a partial batch

**Before:** Rails 7.0 rolls back a written transaction when a non-local `return` exits its block.  
**Now:** Rails 8.1 commits a normal non-local exit; the compatibility setting was removed in Rails 8.0.

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, then returns `false` from inside the transaction when a note fails validation.

**Consequence:** A valid first row followed by an invalid row can leave the import and earlier notes committed while the response reports failure. This breaks the all-or-nothing contract and risks duplicates on resubmission. Use an explicit rollback mechanism rather than relying on `return`.

**Evidence:** History + endpoint transaction-source comparison. [Rails 7.1 transaction change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md); [Rails 8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).

### 2. CSV receipts silently lose citation DOIs

**Before:** `record[:id]` resolved a custom primary key.  
**Now:** It reads the literal `id` attribute; this citation table has none, so it returns `nil`.

**Application:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L70) writes `citation[:id]`, while [the schema](file:///home/user/workspace/repo/db/schema.rb#L55-L62) defines `doi` as the primary key.

**Consequence:** Successful CSV downloads contain blank DOI fields, although the HTML receipt still uses `citation.doi`. Read the DOI explicitly.

**Evidence:** History + attribute-reader source comparison. [Rails 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

### 3. Import-preview annotations disappear

**Before:** `HashWithIndifferentAccess#stringify_keys` left integer keys unchanged.  
**Now:** Rails 8 converts them to strings.

**Application:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L42) indexes annotations by integer source-line numbers. [The preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys`, then still looks up integer keys.

**Consequence:** Annotations disappear from the preview without an exception, even though they remain in the submitted CSV and saved notes.

**Evidence:** History + code. [Rails 8.0 bug fix and before/after example](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).

### 4. Digests change from UTC-day selection to reader-local-day selection

**Before:** Active Job deserialized `TimeWithZone` arguments into the worker’s zone.  
**Now:** It preserves the serialized argument’s named time zone.

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC date**, but passes the request time in the reader’s zone. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) derives the subject date and `updated_at` range directly from that argument.

**Consequence:** Near midnight, the subject date and selected notes change while deduplication remains UTC-based. Old queued jobs without the added zone field retain the old fallback behavior, so results can also depend on which version enqueued the job.

**Evidence:** History + serializer comparison. [Rails 7.2 Active Job changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md). Decide explicitly whether digests represent UTC or local days.

### 5. BigDecimal job payloads are incompatible with old workers

**Before:** Sidekiq’s JSON storage turned Active Job `BigDecimal` arguments into strings.  
**Now:** Active Job uses a tagged `BigDecimalSerializer`; the temporary compatibility option is gone.

**Application:** [Reading completion](file:///home/user/workspace/repo/app/models/user.rb#L53-L57) is passed to `DigestJob`.

**Consequence:** Rails 7.0 workers cannot deserialize newly produced tagged arguments during a mixed-version deployment or rollback. Rails 8.1 can still receive old string arguments; the mailer’s `BigDecimal(...)` conversion handles either type.

**Evidence:** History explicitly warns about rolling-deployment incompatibility; serializer source confirms it. [Rails 7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

Separately, the resolved BigDecimal gem includes [division precision/rounding fixes](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md). The app divides counts and rounds to four places; I have **not established a changed result** for those inputs.

### 6. Reminder previews change across daylight-saving transitions

**Before:** `TimeWithZone#to_time` preserved a fixed UTC offset under this app’s defaults.  
**Now:** Rails 8.1 preserves the named zone, including daylight-saving rules.

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L45) adds 86,400 seconds after `to_time`; [the reminder view](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays that result.

**Consequence:** The displayed offset and wall-clock time change across DST. The postponed epoch remains 24 elapsed hours later. This likely corrects the documented preview discrepancy, but it is still a user-visible behavior change—not prevented by keeping 7.0 defaults.

**Evidence:** History + `to_time` source comparison. [Rails 8.1 removal of old behavior](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md).

### 7. Expired export fragments can become non-expiring

**Before:** A negative `expires_in` produced an already-expired entry.  
**Now:** Rails detects negative expiration. With 7.0 defaults, it reports/logs the problem and removes the expiration option rather than raising.

**Application:** [The export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) calculates `expires_in: export.expires_at - Time.current`, which becomes negative after expiry.

**Consequence:** The expired indicator can be cached without a TTL until eviction or key invalidation. With 7.1+ defaults, this instead raises. Avoid caching with a past deadline.

The [download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) independently checks ownership and expiry, so this does **not** itself authorize expired downloads.

**Evidence:** History + cache option-handling source. [Rails 7.1 expiration change](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md).

### 8. Rich-text attachment representations change

**Before:** HTML content attachments supported a restricted horizontal-rule representation.  
**Now:** Action Text supports sanitized arbitrary HTML content attachments, with a `content` attribute; attachment rendering and plain-text conversion consequently differ.

**Application:** [CSV imports accept body HTML](file:///home/user/workspace/repo/app/models/import.rb#L100-L108), [note pages render it](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L31), and [exports convert it to plain text](file:///home/user/workspace/repo/app/models/export.rb#L77-L81).

**Consequence:** Existing content attachments can render/export differently; legacy horizontal-rule attachments lacking the newly required content need inspection. Stored payloads were not inspected, so exposure is conditional.

There is also an asset mismatch to resolve: [the layout pins Trix 1.3.5](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14), while [the stylesheet requires gem-provided Trix CSS](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L8), now supplied by `action_text-trix` 2.1.19. Do not assume the newer editor or its security fixes become active automatically.

**Evidence:** History + attachment/asset source. [Rails 7.1 Action Text changes](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md); [Rails 8.1 Trix extraction](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

### 9. Attachment filenames are sanitized more aggressively

**Before:** Characters such as `?`, `*`, and `"` survived `ActiveStorage::Filename#to_s`.  
**Now:** They become hyphens.

**Application:** [Attachment captions and links](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L2-L12) use these filenames.

**Consequence:** Displayed/downloaded filenames change silently—for example, `a?b.txt` becomes `a-b.txt`. The underlying stored filename is not rewritten by this accessor.

**Evidence:** History + filename-source comparison. [Rails 8.0 Active Storage change](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md).

### 10. JSON dependency changes provider-response acceptance

**Before:** Ruby’s JSON 2.7.2 accepted duplicate object keys and JavaScript comments.  
**Now:** Resolved JSON 3.1.0 rejects these by default and tightens other malformed-input handling.

**Application:** [Citation::Provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L59) parses external responses and converts parser failures into enrichment failures.

**Consequence:** Previously accepted provider responses can now mark citations failed. No actual provider payload demonstrating this was available; this is a conditional integration risk. Normal strict JSON remains the intended contract.

**Evidence:** Dependency resolution + JSON history + application code. [JSON 3.0/3.1 changes](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

### 11. Local signing-key selection changes

**Before:** Development/test normally used `tmp/development_secret.txt`.  
**Now:** Rails uses environment/credentials when present, otherwise `tmp/local_secret.txt`.

**Application:** [Authentication uses Rails sessions](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17), and rich-text attachments use signed identifiers/URLs.

**Consequence:** If the effective key changes, local sessions and existing signed attachment references stop validating. Preserve key continuity where local stored content matters. Production key continuity remains unverified.

**Evidence:** History + application configuration source comparison. [Upgrade guide](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md); [Rails 8.1 key-selection entry](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md).

## Medium-risk changes

- **`Rails.application.secrets` is removed.** Previously [Citation::Provider’s constructor](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) read it; now provider construction raises. Choose credentials, explicit environment configuration, or another supported configuration source while preserving deployment inputs. **History + code:** [Rails 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md).

- **The built-in Sidekiq adapter is deprecated for removal in Rails 8.2.** The app’s [adapter setting](file:///home/user/workspace/repo/config/application.rb#L22-L24) still resolves in 8.1, but Rails directs users to Sidekiq ≥7.3.3’s adapter. That is a separate dependency and rollout decision—not an upgrade Bundler performed here. **History + adapter code:** [Rails 8.1 deprecation](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md).

## Low-risk, mechanical changes

Each item is supported by upstream history and inspected code; predicted failures were not executed.

- [Note’s keyword-form enum](file:///home/user/workspace/repo/app/models/note.rb#L10) is removed: use `enum :status, {...}, prefix: true`. [Rails 8.0 history](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- [Positional JSON serialization](file:///home/user/workspace/repo/app/models/note.rb#L12) is removed: use `serialize :tags, coder: JSON`, preserving the stored format. [Rails 7.2 history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- [The highlight alias](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) targets a store accessor, not a database attribute; replace `alias_attribute` with method-level reader/writer delegation. [Rails 7.2 history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- [Action Text’s initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) adds to an allowlist that now defaults to `nil`; explicitly extend the effective default allowlist, retaining attachment tags. [Rails 7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md).
- [Reminder scheduling](file:///home/user/workspace/repo/app/models/note.rb#L60-L62) passes an integer to `wait_until`; pass a `Time`, such as `Time.at(reminder_epoch)`. [Rails 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- [Citation retries](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must rename `:exponentially_longer` to `:polynomially_longer`; this preserves the existing backoff formula. [Rails 7.1 history](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md).
- [Export string concatenation](file:///home/user/workspace/repo/app/models/export.rb#L42) cannot use argumentless `sum`; use `join` or `sum("")`. [Rails 7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md).
- [The `/notes` and `/journal` route](file:///home/user/workspace/repo/config/routes.rb#L17-L19) must become separate route declarations. [Rails 8.1 removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md).
- [Test exception configuration](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) must replace `show_exceptions = false` with `:none` to preserve raising behavior. [Rails 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md).

## Changes judged not applicable to this upgrade as configured

These are **code/configuration-based exclusions**, not blanket compatibility guarantees.

- **PostgreSQL date decoding:** still disabled with 7.0 defaults; enabling 7.2 defaults would break [the activity report’s `Date.iso8601(day)`](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40).
- **Readonly-assignment exceptions:** not enabled; adopting 7.1 defaults would affect the notebook form’s resubmitted slug.
- **Removal of implicit YAML as a new default:** not active; [notebook preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7) retain YAML under 7.0 defaults.
- **HTML5 sanitizer, cache 7.1 format, and newer message-format defaults:** not enabled by this version-only change.
- **ETag precedence over Last-Modified:** `strict_freshness` remains false; the export controller retains its existing dual-validator behavior.
- **Automatic post-transaction job enqueueing:** final Rails 8.1 source defaults this to false, and `ApplicationJob` does not enable it; the 7.2 announcement alone is not evidence that this app’s enqueue timing changes.
- **MySQL, SQLite, sharding, composite-primary-key, and Active Record encryption changes:** corresponding adapters/features are not used.
- **Action Cable and Action Mailbox feature changes:** only generated Cable scaffolding exists; no application broadcasts or inbound-mail processing were found.
- **Cloud storage, image transformations, and preview processors:** local Disk storage and original-image rendering are used; no image processor is installed.
- **New-app defaults such as Solid Queue/Cache/Cable, Propshaft, Kamal, and generated authentication:** they do not replace this existing app’s configuration.
- **Rack 3 migration:** not occurring; the added Rack session/up launcher packages retain Rack 2 compatibility here.
- **`net-imap` changes and new WEBrick/user-agent functionality:** no IMAP retrieval, WEBrick serving, or browser-gating feature is used.
- **URI’s empty-host rejection:** the provider already rejects missing/blank hosts; broader unusual-URL compatibility was not established.
- **SecureRandom’s added compatibility method:** inactive on Ruby 3.3.6; DRb changes concern the parallel-test infrastructure rather than application production behavior.
- **Password-reset/challenge additions:** no reset flow or password-editing endpoint uses them.

**Delivery state:** This is a read-only assessment. No application files were changed, no gems were installed, and no application or tests were run. Temporary resolution/source files were removed. The highest-priority follow-up is preserving import atomicity and planning queued-job compatibility before addressing the mechanical boot/runtime failures.