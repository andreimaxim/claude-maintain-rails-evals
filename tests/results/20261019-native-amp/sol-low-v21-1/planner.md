## Application facts behind the ratings

**Rails 8.1.0 resolves with the existing Gemfile pins, but this is not a drop-in upgrade.** The most important risks are partial imports being committed, digest emails changing calendar days, and incompatible job payloads during a rolling deployment.

Evidence labels below: **History** means upstream changelog or commit; **Code** means application/framework source inspected; **Inference** means the expected consequence, not runtime verification.

- **Code:** Ruby is pinned to 3.3.6, sufficient for Rails 8.1. The application retains [Rails 7.0 defaults](file:///home/user/workspace/repo/config/application.rb#L10-L24). Ratings assume that stays unchanged; adopting newer defaults is a separate change.
- **Code:** PostgreSQL is the database. HTML uses ERB, Turbo, Sprockets and importmap. Notes use Action Text and local-disk Active Storage.
- **Code:** Active Job uses Sidekiq 6.5.12 outside tests; exports use native Sidekiq jobs. Redis is also used for digest reservations, not Rails caching.
- **Code:** Production enables fragment caching without overriding Rails’ default cache store. Tests use a null cache and the Active Job test adapter.
- **Code:** Existing data includes JSON-serialized note tags, YAML-serialized notebook preferences, citations with a string DOI primary key, rich text and stored attachments.
- **Resolution:** I copied Gemfile and lockfile, changed only Rails’ requirement, and ran `bundle lock --update rails`. All Rails components moved to 8.1.0. **Rack stayed at 2.2.24**, constrained by Sidekiq; Sidekiq, Redis, pg, Puma, Turbo and the sanitizer gems did not change.

## High-risk changes

### 1. An early return now commits an import transaction

**History:** Rails 7.1 introduced restored commit-on-return behavior; 7.2 removed the old rollback behavior. See the [Active Record 7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), “Remove deprecated behavior that would rollback a transaction block…”

**Before:** Returning from a written transaction block rolled back its writes.

**Now:** A normal nonlocal `return`, `break` or `throw` commits. Retaining 7.0 defaults cannot restore the removed behavior.

**Application use:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, saves rows sequentially, then `return false`s if a note cannot save.

**Inference:** If a later row fails validation, the import and earlier notes can remain committed even though the method reports failure. This violates the application’s all-or-nothing import contract. The failure path needs explicit rollback semantics before upgrading.

### 2. Digest jobs preserve the reader’s zone, changing their content day

**History:** Rails 7.2 preserves the serialized timezone in `ActiveSupport::TimeWithZone` job arguments. See the [Active Job 7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

**Before:** A zoned argument retained its instant but deserialized in the worker’s zone—UTC here.

**Now:** Newly serialized arguments include the timezone name, which the worker restores.

**Application use:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L44) reserves a **UTC-date** Redis key but passes reader-local `requested_at`. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses that argument’s `to_date` and `all_day`.

**Inference:** Newly queued digests select the reader’s local day rather than the UTC day. Around midnight, the email’s date and selected notes can disagree with its reservation key. Old queued jobs without a timezone field still use the worker zone, so both behaviors can coexist. Decide which day defines a digest and align reservation and selection explicitly.

### 3. BigDecimal job arguments gain a new wire format

**History:** Rails 7.1 introduced `BigDecimalSerializer`; 7.2 removed primitive BigDecimal serialization. The [7.1 changelog explicitly warns about rolling deployments](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md).

**Before:** Sidekiq’s JSON round trip turned a BigDecimal argument into a string.

**Now:** Active Job writes a serializer-tagged object and reconstructs a BigDecimal.

**Application use:** [Digest arguments](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) include BigDecimal completion; [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L10) converts it with `BigDecimal(...)`.

**Inference:** The mailer conversion accommodates either type, but **Rails 7.0 workers cannot deserialize the new serializer**. New producers and old consumers must not share these jobs during rollout or rollback without a compatibility plan.

### 4. Reminder postponement changes across daylight-saving transitions

**History and framework code:** Rails 8.1’s [`to_time` change](https://github.com/rails/rails/commit/c79dc282d687cff1c5dc81e19d27257dca5e6a80) makes `TimeWithZone#to_time` preserve the full timezone.

**Before:** Under these defaults, conversion preserved a fixed UTC offset.

**Now:** The returned Ruby `Time` retains the named zone and follows its offset transitions.

**Application use:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) adds 86,400 seconds after conversion, and [postponement](file:///home/user/workspace/repo/app/models/note.rb#L71-L72) uses that result.

**Inference:** The scheduled instant remains 24 elapsed hours later, but its displayed offset and wall time change across DST. This replaces the old fixed-offset preview behavior. Check both spring and autumn transitions; do not accidentally change the intended elapsed-time contract to “same local time tomorrow.”

### 5. Reading a custom primary key through `[:id]` no longer returns it

**History and framework diff:** Rails 7.2 removed the `read_attribute(:id)` fallback to a model’s custom primary key; see the [Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Before:** `citation[:id]` returned the DOI.

**Now:** It reads an actual `id` attribute. Citations have only their `doi` primary key.

**Application use:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) exports `citation[:id]`; the [schema](file:///home/user/workspace/repo/db/schema.rb#L55) defines the custom key.

**Inference:** Receipt CSVs can silently lose their DOI values. Use the explicit `doi` attribute or primary-key-aware `id` method.

### 6. Negative fragment-cache lifetimes no longer mean immediate expiry

**History and framework code:** Rails 7.1 added invalid-expiration handling. Current [cache-store code](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb) removes a negative `expires_in`, then reports an error or raises depending on configuration.

**Before:** A negative lifetime produced an already-expired entry.

**Now, with retained 7.0 defaults:** It reports the invalid lifetime rather than raising, and removes that expiration option.

**Application use:** The [completed-export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) always passes `export.expires_at - Time.current`, which becomes negative after expiry.

**Inference:** Expired fragments can be stored without the intended expiration. The [download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L5-L15) independently checks availability, so this does **not** bypass download authorization. Handle already-expired exports separately; adopting newer defaults instead makes this path raise.

## Medium-risk changes

### 7. Citation-provider configuration uses a removed secrets API

**History:** `Rails.application.secrets` was deprecated in 7.1 and [removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md).

**Before:** Rails loaded `config/secrets.yml`, including its environment-backed provider settings.

**Now:** The application secrets API is gone.

**Application use:** [Citation::Provider’s default initialization](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L14).

**Inference:** Enrichment fails when constructing the provider. Choose credentials or explicit environment-backed configuration and preserve the existing settings interface; this is a configuration-source decision, not just a rename.

### 8. Development/test signing-key filename changes

**History:** The [upgrade guide](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md#development-and-test-environments-secret_key_base-file-changed) documents `tmp/development_secret.txt` becoming `tmp/local_secret.txt`.

**Before/now:** Without copying the old key, Rails generates a different local signing secret.

**Application use:** Sessions and persisted Action Text/Active Storage signatures; [notes have rich-text bodies](file:///home/user/workspace/repo/app/models/note.rb#L5-L8).

**Inference:** Existing local sessions and signed attachment references can become invalid. Preserve the local key if existing development data matters. Production is not affected by this filename change.

## Low-risk changes

Each has a direct replacement and should be caught by loading the affected model or exercising its feature.

- **Code + history:** [Note’s keyword-style enum](file:///home/user/workspace/repo/app/models/note.rb#L10) is removed in Rails 8.0; use `enum :status, {...}, prefix: true`. [Changelog](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- **Code + history:** [Positional JSON coder](file:///home/user/workspace/repo/app/models/note.rb#L12) is removed; use `serialize :tags, coder: JSON`. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Code + history:** [Aliasing `highlight_color` to a store accessor](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) targets no real database attribute; Rails 7.2 rejects that. Explicitly delegate getter/setter to `color`. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Code + history:** [Enrichment retry](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must use `:polynomially_longer`; `:exponentially_longer` is removed, with the replacement preserving its wait formula. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Code + framework source:** [Reminder scheduling](file:///home/user/workspace/repo/app/models/note.rb#L56-L62) supplies an integer to `wait_until:`; convert the epoch to a `Time`. Numeric `scheduled_at` support was removed. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Code + history:** [Action Text’s initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) adds to `allowed_tags`, which now defaults to `nil`; build the override from `sanitizer_allowed_tags` instead, preserving attachment tags. [Changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md).
- **History:** Rails 8.1 alphabetizes schema dump columns; expect mechanical schema diffs. [PR #53281](https://github.com/rails/rails/pull/53281).

## Changes judged inactive or conditional here

- **PostgreSQL date decoding:** The activity report’s [Date.iso8601 call](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) would fail on a `Date`, but automatic decoding is enabled by **7.2 defaults**, not retained 7.0 defaults. Revisit if adopting them. **Code + history.**
- **Readonly assignment and default YAML removal:** New defaults affect notebook settings, but retained 7.0 defaults preserve current behavior and the YAML default. **Framework code.**
- **Enqueue-after-commit:** Despite the 7.2 announcement, Rails 8.1’s job-class default is `false`; this app does not enable it. Do not assume enqueue failures have moved outside its row-lock transactions. **Framework code.**
- **Strict HTTP freshness:** New default is not enabled here; export downloads retain their existing conditional-request policy. **Framework code.**
- **HTML5 sanitization:** Gated by newer defaults; retaining 7.0 keeps HTML4 sanitization. Attachment-content sanitization fixes still merit rich-text regression review. **History + code.**
- **Trix packaging:** Resolution adds `action_text-trix` 2.1.19, but the layout explicitly loads [vendored Trix 1.3.5](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14). The gem upgrade does not itself migrate this editor. The updated Action Text upload integration needs browser review; compatibility with this mixed setup is unverified. **History + code + inference.**
- **Rack 3, newer Sidekiq/Redis behavior:** Not part of the resolved upgrade; their versions stay unchanged. **Resolution.**
- **Solid Queue/Cache/Cable, Propshaft and generated authentication:** No automatic adoption by upgrading this existing application. **Configuration + framework source.**
- **MySQL/SQLite, multiple databases, Active Record encryption, cloud storage and image variants:** No matching configured use found. **Configuration/code.**
- **Action Mailbox and Cable feature changes:** Frameworks are loaded, but no application mail ingestion or broadcasts were identified. **Code.**
- **Redis/Memcached cache pooling:** Rails does not use either cache store here. **Configuration.**

### Dependency caveat

Resolution also adds JSON 3.1.0, BigDecimal 4.1.3, DRb 2.2.3, SecureRandom 0.4.1, URI 1.1.2, rack-session 1.0.2, rackup 1.0.1, useragent 0.16.11 and WEBrick 1.9.2; net-imap moves 0.6.7 → 0.6.8.

**Medium, conditional:** [JSON 3](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md) rejects duplicate keys and comments by default. [Provider response parsing](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) would reject responses previously accepted. The existing lockfile does not pin JSON; this sandbox currently supplies 2.7.2, so deployment’s actual baseline needs confirmation.

**Uncertainty:** [BigDecimal’s history](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md) includes division/rounding fixes relevant to the completion calculation. No specific changed four-decimal result was established. I did not complete source-history review of every newly resolved auxiliary dependency, so this is a targeted risk assessment, not an exhaustive compatibility certification.

No new gems were installed, and the application was neither changed nor run. Temporary resolution and source-review files were removed.