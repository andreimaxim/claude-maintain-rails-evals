## Application facts behind the ratings

**This upgrade needs both compatibility fixes and behavioral review. Keeping Rails 7.0 defaults does not preserve all Rails 7.0 behavior.**

Evidence labels below: **History** = upstream changelog; **Code** = application/framework source read; **Inference** = predicted consequence, not runtime-tested.

- **Code:** Ruby is pinned to 3.3.6, which satisfies Rails 8.1’s Ruby ≥ 3.2 requirement. Rails defaults remain **7.0** in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L9-L24). This report assumes that setting stays unchanged.
- **Code:** PostgreSQL is configured in [database.yml](file:///home/user/workspace/repo/config/database.yml#L17-L23); notes use JSON-serialized text and native jsonb in [the schema](file:///home/user/workspace/repo/db/schema.rb#L93-L106).
- **Code:** This is a server-rendered HTML application using Action Text, Active Storage Disk storage, Sprockets, importmap, and a deliberately vendored Trix 1.3.5—not an API-only app. See [the layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14) and [import map](file:///home/user/workspace/repo/config/importmap.rb#L3-L8).
- **Code:** Active Job uses Sidekiq outside tests; exports use native Sidekiq jobs. Digests carry a zoned time and BigDecimal. Reminders enqueue inside row-lock transactions.
- **Resolution evidence:** Changing only Rails to 8.1.0 in temporary Gemfile/lockfile copies and running `bundle lock --update rails` succeeded. Rails components move together to 8.1.0. **Sidekiq 6.5.12, Redis 4.8.1, Rack 2.2.24, Puma 5.6.9, pg, Pagy, and Faraday stay unchanged.** Rack 3 is not required by this resolved bundle.
- The resolution adds `action_text-trix 2.1.19`, `bigdecimal 4.1.3`, `drb 2.2.3`, `json 3.1.0`, `rack-session 1.0.2`, `rackup 1.0.1`, `securerandom 0.4.1`, `uri 1.1.2`, `useragent 0.16.11`, and `webrick 1.9.2`; updates `net-imap 0.6.7 → 0.6.8`; and removes `method_source`. These are today’s resolution results, not dependencies frozen at Rails 8.1’s release date.

## High-risk changes

### 1. Early returns now commit transactions: partial imports can persist

**History + Code:** Rails 7.0 rolls back a written transaction exited by a non-local `return`. Rails 8.1 commits it unless an exception or explicit rollback intervenes. The restoration appeared in 7.1; its compatibility switch was subsequently removed.

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, saves notes in sequence, then executes `return false` when a note fails validation.

**Inference:** A valid first row followed by an invalid row can now leave the import and earlier notes committed while the request reports failure. Retrying can duplicate those notes. An exception from `save!` still rolls back; the dangerous case is the explicit early return.

**Review:** Decide how to preserve the intended all-or-nothing import contract using explicit rollback.

Sources: [7.1 transaction history](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L304-L330), [8.1 transaction implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb).

### 2. Digest time arguments retain the reader’s zone

**History + Code:** Rails 7.0 deserializes `TimeWithZone` arguments in the worker’s zone. Rails 7.2+ preserves the argument’s original zone. The new deserializer still accepts older payloads without that zone field.

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC date** but queues a time in the reader’s zone. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L10) derives both its date and `all_day` query from that argument.

**Inference:** New jobs select a reader-local calendar day rather than a UTC day, while duplicate-request reservations remain UTC-based. Around midnight, the digest subject and included notes change silently. Old and new queued payloads can produce different results.

**Review:** Choose UTC-day or reader-local-day semantics and align reservation keys, payloads, and mailer queries.

Sources: [7.2 Active Job history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

### 3. BigDecimal job payloads change across deployments

**History + Code:** Rails 7.0 treats BigDecimal as a primitive; JSON-backed queues turn it into a string. Rails 8.1 uses a tagged `BigDecimalSerializer` payload and reconstructs a BigDecimal.

**Application:** [User#reading_completion](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) supplies the decimal queued by `request_digest`; [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L10) consumes it.

**Inference:** Old Rails 7.0 workers cannot deserialize the new serializer class. This is a rolling-deployment and rollback hazard even if the new mailer accepts both decimal strings and BigDecimals.

**Review:** Coordinate producers and workers, including retry queues, before new producers emit these payloads.

Sources: [history and deployment warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155), [7.2 removal of primitive serialization](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65).

### 4. Import annotations disappear from previews

**History + Code:** `HashWithIndifferentAccess#stringify_keys` previously retained integer keys; Rails 8 converts them to strings.

**Application:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) uses integer source-line keys. [The preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys` but continues looking up `annotations[row.line]` with integers.

**Inference:** Annotation text silently disappears from the preview. The import still obtains annotations from its parsed rows, so this is misleading presentation rather than demonstrated storage loss.

Source: [explicit before/after history](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L46).

### 5. Receipt CSVs no longer obtain a DOI through `citation[:id]`

**History + Code:** `read_attribute(:id)`, also used by `[]`, no longer redirects to a differently named primary key.

**Application:** Citations have a `doi` primary key and no `id` column in [the schema](file:///home/user/workspace/repo/db/schema.rb#L55-L62). [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) writes `citation[:id]`.

**Inference:** The receipt loses its DOI value instead of reading the citation’s primary key. Use the actual DOI or primary-key method deliberately; audit exported receipts, not merely whether the download succeeds.

Sources: [history](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L219-L225), [8.1 attribute reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb).

### 6. Negative fragment-cache lifetimes lose their expiration

**History + Code:** Rails 8.1 rejects negative `expires_in`. With this app’s retained defaults, it reports the invalid value and removes that expiration option rather than raising.

**Application:** [The export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) passes `export.expires_at - Time.current`, which becomes negative after expiry.

**Inference:** An expired export’s fragment can be cached without its intended deadline. It renders the expired state, and the separate download authorization remains authoritative, so this is **not evidence of an access-control bypass**. Nevertheless, cache lifetime changes silently.

Sources: [7.1 history](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L867), [expiration normalization](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L908-L942).

### 7. Reminder previews now preserve a time zone, not a fixed offset

**History + Code:** Rails 7.0’s `TimeWithZone#to_time` preserves a fixed UTC offset with these defaults. Rails 8.1’s implementation preserves the full zone.

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) adds 86,400 seconds after conversion; [the reminder view](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays the result.

**Inference:** Across daylight-saving boundaries, the displayed offset and wall-clock time change. The elapsed-time postponement remains 24 hours; this corrects the old preview discrepancy but is still a silent user-visible change.

Sources: [8.1 history](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22), [implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L500).

## Medium-risk changes

### 8. `Rails.application.secrets` is removed

**History + Code:** Rails 7.0 reads `config/secrets.yml` through this API; Rails 7.2 removes it.

**Application:** [Citation::Provider’s default settings](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) depend directly on it.

**Inference:** Citation enrichment raises before reaching the provider and can leave citations pending while Sidekiq retries. Replacing the API requires choosing where provider configuration belongs—credentials, explicit environment configuration, or another application-owned configuration source.

Source: [removal history](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63).

### 9. Today’s resolution selects an incompatible JSON major version

**Code + History:** Ruby 3.3.6 ships JSON 2.7.2; the new lockfile selects JSON 3.1.0. JSON 3’s `parse` accepts options as keywords, whereas Rails 8.1.0’s `ActiveSupport::JSON.decode` passes a positional options hash.

**Application:** JSON decoding backs [note settings and serialized tags](file:///home/user/workspace/repo/app/models/note.rb#L12-L14); the provider also [parses external JSON](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L44).

**Inference:** Rails JSON decoding can raise argument errors after this otherwise successful bundle resolution. JSON 3 additionally rejects duplicate keys and comments by default, changing which provider responses are accepted.

**Review:** Resolve a compatible JSON/Rails combination explicitly; successful dependency resolution is insufficient.

Sources: [JSON changes](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md), [JSON parse signature](https://github.com/ruby/json/blob/v3.1.0/lib/json/common.rb#L291-L298), [Rails decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb#L24-L25).

## Low-risk changes

Each has a direct mechanical replacement or a localized compatibility check.

- **Code + History:** [Note’s keyword enum](file:///home/user/workspace/repo/app/models/note.rb#L10) is removed syntax; use positional name/mapping and `prefix:`. [History](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L64-L66).
- **Code + History:** [Positional JSON coder](file:///home/user/workspace/repo/app/models/note.rb#L12) must become `coder: JSON`. [History](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421).
- **Code + History:** [The alias to store accessor `color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) targets a non-column attribute; define explicit getter/setter delegation instead. [History](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490).
- **Code + History:** [Citation retry timing](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must rename `:exponentially_longer` to `:polynomially_longer`; the intended delay formula is unchanged. [History](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L22-L26).
- **Code + History:** [Reminder scheduling](file:///home/user/workspace/repo/app/models/note.rb#L61) passes integer epoch seconds to `wait_until:`; use a Time object. Numeric scheduled timestamps are removed. [History](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55-L57).
- **Code + History:** [String fragments summed without an identity](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) need `sum("")` or `join`; Rails’ nonnumeric-sum override is removed. [History](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420).
- **Code + History:** [Action Text’s allowlist initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) adds to a value now defaulting to nil; obtain the effective inherited allowlist before extending it. Preserve attachment tags too. [History](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33).
- **Code + History:** [Test exception configuration](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) should replace `false` with `:none`. [History](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md#L100).
- **Code + Inference:** Trix 2.1.19 becomes available through the new gem, but [the layout still explicitly loads vendored 1.3.5](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14). Do not assume upgrading Rails upgrades the editor actually served. Action Text’s upload glue also changes; inspect attachment upload/error behavior. [History](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

## Changes judged not applicable—or not activated

- **Code:** PostgreSQL date decoding would break [Date.iso8601(day)](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) if enabled, but it remains off under 7.0 defaults; reconsider when adopting 7.2 defaults. [Configuration source](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).
- **Code:** Readonly-assignment errors and removal of the default YAML coder are newer defaults, not activated here; [Notebook’s slug and preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) retain their old configuration.
- **Code:** Automatic post-commit Active Job enqueueing is not enabled by this upgrade’s final 8.1 configuration; `enqueue_after_transaction_commit` defaults to false. Do not infer changed reminder atomicity from the 7.2 changelog alone. [Source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb).
- **Code:** Strict ETag precedence is a newer default, not enabled here; [export downloads](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L12) retain the old freshness policy.
- **Code:** MySQL, SQLite, sharding, composite keys, Active Record encryption, and async queries have no configured application usage.
- **Code:** Active Storage cloud-service, image-variant, and previewer changes do not match the local Disk/no-image-processor setup.
- **Code:** Action Mailbox and application Cable broadcasts have no implemented feature usage; mailers use ordinary immediate delivery, not custom delivery jobs.
- **Code:** Solid Queue, Solid Cache, Propshaft, authentication generators, and deployment-template defaults are not automatically adopted by changing the Rails gem.
- **Code + Inference:** Added rack-session/rackup supply extracted infrastructure; no Rack-major change was resolved. Added DRb, SecureRandom, useragent, and WEBrick have no direct custom application integration identified.
- **Code:** The net-imap patch does not affect an app with no IMAP client usage. URI and BigDecimal are used, but beyond the risks above I did not establish another application-specific behavior change from their newly selected versions.

**Scope:** I read release histories and compared the Rails release sources, including relevant implementation diffs. This is a prioritized, non-exhaustive static assessment. No new gems were installed, and the application and tests were not run. Application files and the real lockfile remain unchanged.