# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## Application facts and assessment boundary

**Evidence labels:** **History** means upstream changelog/commit; **Code** means application or released dependency source inspected; **Inference** means an expected consequence of those sources, not an executed result. This is a source-only assessment: no upgrade was installed, no application code/configuration was changed, and neither the application nor its tests were run. Findings below describe reachable code paths, not observed runtime failures.

- **Code:** Ruby is pinned to 3.3.6 ([Gemfile](file:///home/user/workspace/repo/Gemfile#L4-L8)); Rails 8.1.0 requires Ruby ≥ 3.2, so the Ruby requirement is satisfied. Critically, the app retains [`config.load_defaults 7.0`](file:///home/user/workspace/repo/config/application.rb#L10-L24). This report assesses changing the gem, **not** also adopting 8.1 defaults or regenerating configuration.
- **Code:** PostgreSQL is the only configured database ([database.yml](file:///home/user/workspace/repo/config/database.yml#L17-L26)), with pg 1.6.0. Models use ordinary associations, transactions, serialized text, JSONB, and a DOI primary key ([schema](file:///home/user/workspace/repo/db/schema.rb#L55-L117)). The deployed PostgreSQL version is not established by configuration.
- **Code:** This is an HTML/ERB application using Sprockets, importmap, Turbo, Action Text, and local Disk storage, not an API-only app. The editor explicitly loads vendored **Trix 1.3.5**, while Action Text JavaScript comes from the Rails gem ([layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [importmap](file:///home/user/workspace/repo/config/importmap.rb#L8)). No image-processing gem is enabled.
- **Code:** Active Job uses Sidekiq 6.5.12 and Redis 4.8.1; tests explicitly select `:test` ([application](file:///home/user/workspace/repo/config/application.rb#L22-L24), [test config](file:///home/user/workspace/repo/config/environments/test.rb#L30-L47), [Gemfile](file:///home/user/workspace/repo/Gemfile#L34-L39)). Exports use native Sidekiq, not Active Job ([ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10)). Reminders and citation requests enqueue inside row-lock transactions.
- **Code:** Readers have time zones; digest reservations are keyed by UTC date, while jobs carry a zoned timestamp and a BigDecimal completion ratio ([User](file:///home/user/workspace/repo/app/models/user.rb#L34-L56)). Mail is delivered synchronously inside jobs; development uses file delivery and tests use `:test`. Production delivery/host configuration is not established here.
- **Code:** Export availability uses expiring view fragments; production has no explicit cache-store override, development uses memory/null stores, and tests use null store ([fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L37), [development](file:///home/user/workspace/repo/config/environments/development.rb#L20-L34), [production](file:///home/user/workspace/repo/config/environments/production.rb#L58-L65)). Redis is used for jobs/reservations, not as the configured Rails cache.

### Dependency resolution facts

**Code / resolver evidence:** Copied Gemfile and lockfile into a scratch directory, changed only `rails` to `8.1.0`, and successfully ran `bundle lock --update rails` with Bundler 2.5.22 on Ruby 3.3.6. Resolution does not install gems. [Resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolved.lock) · [complete lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lock.diff).

| Dependency | Resolution change |
|---|---|
| Rails and its 12 component gems, including Railties | 7.0.8.7 → 8.1.0 together |
| net-imap | 0.6.7 → 0.6.8 |
| New locked dependencies | action_text-trix 2.1.19; bigdecimal 4.1.3; json 3.1.0; drb 2.2.3; securerandom 0.4.1; uri 1.1.2; rack-session 1.0.2; rackup 1.0.1; useragent 0.16.11; webrick 1.9.2 |
| Removed | method_source 1.1.0 |
| Not moved | Rack 2.2.24; Sidekiq 6.5.12; Redis 4.8.1; pg 1.6.0; Puma 5.6.9; Faraday 1.10.4; Pagy 8.6.3; existing Hotwire/Sprockets gems |

**Code:** “New locked” does not always mean new at runtime: this sandbox’s Ruby default gems include JSON 2.7.2, BigDecimal 3.1.5, URI 0.13.1, DRb 2.2.0, and SecureRandom 0.3.1. They were absent from the original lockfile. **Inference:** production baselines may differ. Resolution is a snapshot of the registry on 2026-10-19, not a reconstruction of the Rails 8.1 release-day bundle; in particular JSON 3.1.0 is a 2026 release.

## High-risk changes

### H1. A rejected CSV import can now leave a committed partial batch

**History:** Rails 7.1 introduced opt-in commits on non-local transaction returns; [7.2 removed the rollback behavior](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L371-L377). **Code:** the 7.0 transaction manager rolls back a transaction exited early with `return`; 8.1 commits in its `ensure` unless an exception/thread abort requires rollback. Retaining 7.0 defaults does not restore the removed behavior.

**Application:** [`Import#apply`](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and then executes `return false unless row.note.save` inside the transaction. **Inference:** with a valid first row and invalid second row, the caller still reports failure, but the import, first note, rich text, and new citation can already be committed. Retrying can duplicate the successful prefix. The existing [invalid-later-row request case](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L72) expresses the intended all-or-nothing contract. Review an explicit rollback strategy before upgrading.

### H2. Receipt CSVs silently lose DOI values

**History / Code:** [removal commit](https://github.com/rails/rails/commit/39997a0f049dfb3d94b28d1cb131b9136a1b7b0a) removes `read_attribute(:id)`’s custom-primary-key redirection in 7.2. Before, `citation[:id]` read its primary key, `doi`; now it looks for a literal `id` attribute. `Citation` has no such column.

**Application:** [`Import#receipt`](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) uses `citation[:id]`; [the schema](file:///home/user/workspace/repo/db/schema.rb#L55-L62) declares `doi` as the primary key. **Inference:** receipts contain empty DOI cells rather than an error, although the citation remains linked in the database. Use the actual DOI or primary-key reader; check the [existing CSV expectation](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L43-L45).

### H3. Annotation text disappears from import previews

**History / Code:** Rails 8.0’s [integer-key stringification fix](https://github.com/rails/rails/commit/e8574542f88695329e7324f864b9048b0ba0da1b) makes `HashWithIndifferentAccess#stringify_keys` stringify integer keys. Previously it merely duplicated the hash, leaving integers intact.

**Application:** [`Import#annotations`](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) keys annotations by integer source-line number; [the preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys` but still looks up `annotations[row.line]` with an integer. **Inference:** annotations no longer render, without raising; saved annotation data is not erased. Multiline CSV rows make actual source-line identity important. Keep the producer, transformation, and lookup key types consistent.

### H4. Digest selection changes from UTC days to reader-local days

**History:** [Active Job 7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49) preserves serialized `TimeWithZone` zones. **Code:** 7.0 stored the timestamp/offset but reconstructed it in the job’s current zone; 8.1 additionally stores the named zone and reconstructs in it. Old payloads without that field retain the fallback.

**Application:** [`User#request_digest`](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves the UTC day but sends a reader-zoned time; [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses that argument’s `to_date` and `all_day` for the subject and note selection. **Inference:** new jobs select a different interval near local midnight, while reservations still use UTC days. For example, 00:30 UTC is the preceding date in Los Angeles. Old queued jobs and new jobs can select different days, and different worker versions can interpret the same new payload differently. Decide the intended digest day and plan queue/worker rollout accordingly.

### H5. BigDecimal job payloads become incompatible with old workers

**History:** Rails 7.1 added a BigDecimal serializer; [7.2 removed the primitive fallback](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65). **Code:** 7.0 leaves a BigDecimal primitive for Sidekiq’s JSON encoding, yielding a decimal string on the worker. 8.1 writes an object tagged `ActiveJob::Serializers::BigDecimalSerializer` and reconstructs a BigDecimal.

**Application:** [`User#reading_completion` and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) send BigDecimal; [`DigestMailer`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L10) converts its received value using `BigDecimal(...)`, which also accepts BigDecimal itself. **Inference:** homogeneous new workers should handle both the old string and new typed value, but Rails 7.0 workers lack the new serializer and cannot deserialize newly written digest jobs. Do not let old workers consume new-format jobs during a rolling deployment or rollback; test both payload generations once an upgrade is authorized.

### H6. Reminder postponement now preserves the named zone through DST

**History:** [8.1 removes the old `to_time` preservation modes](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22). **Code:** 7.0’s `TimeWithZone#to_time` preserves a fixed UTC offset under this app’s defaults; 8.1 uses `getlocal(time_zone)`, preserving the zone’s transition rules regardless of the retained defaults.

**Application:** [`Note#next_day_reminder_at`](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) converts then adds 86,400 seconds; [the preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L17-L20) displays that result, and postponing uses its epoch. **Inference:** across a DST boundary the displayed offset and local clock time change compared with 7.0. The intended elapsed delay and resulting epoch remain 24 hours: this is a preview/zone-semantics change, not evidence of a one-hour delivery shift. Review the documented fixed-offset assumption and spring/fall transitions.

### H7. Negative fragment TTLs stop meaning “already expired”

**History:** [7.1 cache-expiration validation](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L867). **Code:** 7.0 accepts a negative expiration and writes an already-expired entry; 8.1 removes the negative `expires_in` option and reports/logs it. Raising instead requires the newer default, which this app has not adopted.

**Application:** [completed-export fragments](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L37) always calculate `expires_at - Time.current`, including after the deadline. **Inference:** an expired export can produce a fragment with no TTL instead of an immediately expired fragment, plus repeated warning/report traffic on misses. The output then cached is normally “Expired”; this does **not** itself make the file downloadable. [The download action](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L15) independently checks ownership and expiry. Avoid caching with a negative TTL; changing the defaults first would turn this into an error instead.

### H8. Plain-text extraction changes exported and previewed content

**History / Code:** [script/style omission](https://github.com/rails/rails/commit/bd0729ce37310c737e163c4f3f76db80d4c63057) removes their contents from plain text; [the iterative-conversion change](https://github.com/rails/rails/pull/55025) also computes ordered-list numbering from element siblings rather than all sibling nodes. These are visible in the full released-source diff, not just release headlines.

**Application:** CSV imports assign arbitrary body HTML ([Import](file:///home/user/workspace/repo/app/models/import.rb#L101-L106)); exports call [`body.to_plain_text`](file:///home/user/workspace/repo/app/models/export.rb#L77-L81), as do [import previews](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L56-L58) and [note excerpts](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L53). **Inference:** regenerated Markdown can omit text previously emitted from script/style nodes and renumber whitespace-separated ordered lists. Existing export files are not rewritten. Review representative stored HTML and export snapshots, including formatted lists; this may be a desirable correction, but it changes output data.

### H9. Local signing-key discovery can invalidate existing sessions and attachments

**History:** [7.1 upgrade guidance](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed) documents `tmp/development_secret.txt` → `tmp/local_secret.txt`. **Code:** 8.1 also checks ENV/credentials before generating a local secret.

**Application:** [sessions](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17) depend on signed/encrypted cookies; [rich-text attachments](file:///home/user/workspace/repo/app/models/note.rb#L8) depend on signed identifiers. **Inference, conditional:** if development/test relies on the generated old file and does not already supply the same key through ENV/credentials, upgrading creates a different key and invalidates cookies and old attachment signatures. No secret values were inspected, so this condition is unverified. Preserve the intended local key explicitly. This filename change is not a production-key migration.

## Medium-risk changes

### M1. Citation configuration API was removed

**History:** [`Rails.application.secrets` was removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63), after 7.1 deprecation in favor of credentials. **Application / Code:** [`Citation::Provider#initialize`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) calls it to read the environment-backed `citation_provider` settings from `config/secrets.yml`.

**Inference:** constructing the default provider raises `NoMethodError`; this is outside the provider’s declared error handling, so enrichment can remain pending while Sidekiq retries. Choose credentials, direct ENV reads, or application configuration, and preserve the current development/test versus production settings. There is no automatic secrets.yml-to-credentials migration.

### M2. Rails’ Sidekiq adapter is on a removal deadline

**History / Code:** [8.1 deprecates the built-in adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23); its warning names removal in **8.2** and directs applications to Sidekiq **7.3.3+** for the gem-owned adapter.

**Application:** [`queue_adapter = :sidekiq`](file:///home/user/workspace/repo/config/application.rb#L22-L24) currently uses Sidekiq 6.5.12. **Inference:** this is not an 8.1 dependency-resolution blocker, but must be addressed before the next Rails release. A Sidekiq upgrade is a separate decision affecting native [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10), JSON argument validation, Redis APIs/reservations, and deployment requirements; it was **not** performed or resolved as part of this gem-only proposal.

### M3. Newly resolved JSON 3.1.0 conflicts with Rails 8.1.0’s serialized-column reader

**History:** [JSON 3.0 changes](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md) reject unknown options instead of ignoring them; they also reject duplicate keys/comments by default and remove several legacy APIs. **Code:** Rails 8.1.0’s [`ActiveRecord::Coders::JSON`](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/coders/json.rb) passes `escape: false` to `ActiveSupport::JSON.decode`, which forwards it to `JSON.parse`. JSON 3.1.0’s parser option list does not accept `escape` and raises `ArgumentError` for unknown keywords.

**Application:** [`Note` serializes tags with JSON](file:///home/user/workspace/repo/app/models/note.rb#L12-L14). **Inference from the complete source chain:** even after mechanically updating the `serialize` declaration, reading nonblank stored tags can fail with an unknown-option error. Choose a compatible JSON constraint or a framework version/fix that supports JSON 3; resolving successfully does not establish runtime compatibility. This is a risk of **today’s actual resolved bundle**, not necessarily an original Rails 8.1 release-day dependency.

**Additional conditional compatibility decision:** [`Citation::Provider`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) parses external JSON. Responses with duplicate keys, comments, or formerly tolerated invalid escapes now fail and are recorded as failed enrichments instead of yielding the formerly accepted metadata. No evidence establishes that the provider emits such documents. Sidekiq’s JSON reader also gets the stricter defaults; its ordinary generated payloads do not require these extensions.

## Low-risk changes — mechanical fixes

Each item is **History + Code**, with the application outcome a source-based **Inference**. These should be caught by boot, focused tests, or the indicated browser check once execution is authorized.

- **Action Text allowlist initialization:** [`allowed_tags += ...`](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) now adds to `nil` and blocks initialization; seed the effective sanitizer defaults, including attachment tags, before adding `details`/`summary` ([7.1 entry](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33)). Do not replace the defaults with only those two tags.
- **Enum declaration:** [`enum status: ..., _prefix: true`](file:///home/user/workspace/repo/app/models/note.rb#L10) must become the positional-name form with `prefix: true`; Citation/Export already use the supported form ([8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md)).
- **JSON serialization declaration:** [`serialize :tags, JSON`](file:///home/user/workspace/repo/app/models/note.rb#L12) must use `coder: JSON` ([7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L423)); that mechanical fix does not resolve M3.
- **Aliasing a JSONB store accessor:** [`alias_attribute :highlight_color, :color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) now raises because `color` is not a model attribute/column; explicitly delegate or alias the reader **and writer** instead ([7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490-L492)).
- **Multi-path route:** [`get "/notes", "/journal", ...`](file:///home/user/workspace/repo/config/routes.rb#L17-L18) is removed in 8.1; declare two routes and preserve the existing `notes_path` helper ([8.1 entry](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107-L109)).
- **Retry algorithm name:** [`wait: :exponentially_longer`](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7-L9) must become `:polynomially_longer`; the old name was misleading, not a request to change the delay formula ([7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51-L53)).
- **Numeric scheduled time:** [`set(wait_until: reminder_epoch)`](file:///home/user/workspace/repo/app/models/note.rb#L60-L62) now leaves an Integer in `scheduled_at`, but job serialization calls `.utc`; pass `Time.at(reminder_epoch)` ([7.1 change](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L130)).
- **String summation:** [`fragments.sum`](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) relied on Rails’ removed nonnumeric `Enumerable#sum` override; concatenate with `join` or an explicit string initial value ([7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420-L422)).
- **Test exception setting:** [`show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) must become `:none`; 8.1’s exception wrapper otherwise treats it as the render-errors branch, defeating existing `assert_raises` expectations ([upgrade guidance](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#new-ways-to-handle-exceptions-in-controller-tests-integration-tests-and-system-tests)).
- **Trix asset alignment:** the [explicit Trix 1.3.5 script](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L13) does not switch to newly resolved action_text-trix 2.1.19, while [`require trix` CSS](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L8) resolves from that gem; align the intended JS/CSS asset versions and smoke-check editing saved links/attachments ([8.1 extraction](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md#L53-L57)). **Inference/uncertainty:** mixed-version compatibility was not executed; installing the new dependency alone does not deliver its Trix JavaScript fixes to this layout.
- **Schema dumps:** [schema.rb](file:///home/user/workspace/repo/db/schema.rb#L13-L24) will get alphabetically sorted columns on subsequent dumps; expect review noise, not automatic physical column reordering ([8.1 entry](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L689-L693)).

## Changes screened out or not established as regressions

These are **Code-based applicability judgments / Inference**, informed by the linked upstream history and defaults. “Not relevant” refers to the current gem-only upgrade, not a later defaults migration.

- **PostgreSQL date decoding:** the [7.2 Date-returning change](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L149-L157) is gated behind `load_defaults 7.2`; therefore [`daily_note_counts`’s `Date.iso8601(day)`](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) is not an immediate failure. It **would** need adjustment when enabling that default.
- **Readonly assignments:** the 7.1 raising default is not enabled; [`Notebook`’s readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L8) and [resubmitted hidden slug](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L14) become a separate concern if defaults change.
- **Implicit YAML removal:** [`serialize :preferences`](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) retains its YAML coder with 7.0 defaults; the explicit-coder requirement is a 7.1-defaults decision, not the same issue as positional JSON coder removal. The app writes primitive string-keyed preferences, not custom YAML classes.
- **HTML5 sanitizer default:** remains HTML4 with 7.0 defaults; do not attribute automatic HTML5 parsing to this upgrade. The independent nil-allowlist API change still applies.
- **Automatic after-commit job enqueue:** despite the 7.2 feature announcement, [8.1’s class attribute defaults to false](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L43-L55); this app does not opt in, so do not assume citation/reminder enqueue failure now occurs after commit. Native ExportJob is outside Active Job entirely.
- **Message/cache format migrations:** 7.1 JSON message metadata, cache format 7.1, and ETag-first strict freshness are not enabled by retained defaults. In particular, [export download conditional requests](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L13) still use the old freshness-combination policy.
- **Solid Queue/Cache/Cable, Propshaft, authentication generator, Kamal, new-app SSL defaults:** template/generator choices do not replace this app’s explicitly configured Sidekiq, existing cache store, Sprockets, custom sessions, or deployment configuration.
- **Rack 3 migration/session rewrite:** not forced by the resolved bundle: Sidekiq keeps Rack 2; rack-session 1.0.2 and rackup 1.0.1 are compatibility packages, not a switch to Rack 3. Puma remains unchanged. WEBrick is added through rackup but is not the configured Puma server.
- **Action Cable:** no application subscriptions/broadcasts were found beyond generated base channel/connection classes; composite streams, Redis subscription and PostgreSQL cable-adapter fixes have no identified application caller.
- **Action Mailbox / net-imap 0.6.7 → 0.6.8:** no inbound mailboxes/IMAP client use; inspected net-imap source changes concern parser/config/SequenceSet handling, not these outbound file/test mail deliveries.
- **Action Mailer batching/previews/new delivery features:** mailers use `deliver_now` from jobs, not `deliver_all_later`, preview customization, or removed mailer APIs; no distinct relevant regression identified beyond the Active Job digest issues above.
- **Other database adapters, composite keys, sharding/multiple databases, AR encryption, async/bulk queries, counter caches:** no corresponding configuration/callers; the DOI key is a single custom key, already accounted for in H2. `find_or_create_by`’s concurrency fix does not repair this app’s DOI creation race: it uses `find_or_initialize_by`.
- **Cloud storage/Azure removal, variants/preprocessing/image transformers:** configured services are Disk and no image processor is enabled; no cloud/variant-specific migration applies. Filename sanitization can replace additional punctuation in arbitrary uploaded attachment names, but generated export slugs contain none of it; review unusual user filenames if exact download names matter.
- **JSON render escaping, UJS module exports, custom serializers/instrumentation, CurrentAttributes, multibyte/deprecated formatting helpers:** no affected application use found; Jbuilder’s presence is not evidence of a JSON-rendering endpoint.
- **Redis cache pooling/UNLINK/TTL fixes:** Rails is not configured with RedisCacheStore or MemCacheStore. They do not change the app’s direct Redis digest reservations.
- **URI 0.13.1 → 1.1.2:** inspected parser/merge source; `URI.parse` already used RFC3986 in the old release. The app’s [http(s)/host validation](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) is not evidence of a blanket new URL rejection. No concrete previously accepted provider URL was established as a regression; review nonstandard production provider URLs separately.
- **BigDecimal 3.1.5 → 4.1.3:** [history](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md) includes division precision/rounding fixes and internal algorithm changes; the app divides note counts and rounds to four places, but source inspection did not establish a changed rounded result for an application input. Removed `precs`, changed `divmod`, and BigMath changes have no caller here. This remains a numerical review hotspot, not a claimed confirmed ratio regression; H5 concerns Rails serialization, not these arithmetic fixes.
- **SecureRandom 0.3.1 → 0.4.1:** source differences add a Ruby < 3.3 compatibility method and stop shipping the formatter already provided by Ruby; no identified UUID/token contract change on pinned Ruby 3.3.6.
- **DRb 2.2.0 → 2.2.3:** used indirectly for parallel tests ([test helper](file:///home/user/workspace/repo/test/test_helper.rb#L7-L12)); source changes include safer object-reference tracking. No custom DRb identity conversion or network service configuration was found; no concrete app regression established.
- **useragent 0.16.11 / method_source removal:** the app has no browser-version gate using the new parser, and no use of method_source; dependency presence/removal alone is not an application behavior change.

## Where to concentrate the upgrade review

**Inference / recommendation:** first address boot/API failures, then review invalid-later-row imports, DOI receipts, integer-keyed annotations, UTC-versus-local digests, old/new queued payloads, DST postponements, and cache deadlines. Existing import tests already encode several affected contracts, but test adapters do not prove Sidekiq wire compatibility. Review stored HTML and the real editor asset pair before relying on browser coverage.

**Source coverage / limits:** inspected the complete v7.0.8.7…v8.1.0 file-change inventory and targeted runtime diffs; component changelogs for 7.1, 7.2, 8.0, 8.1, plus patch histories through 7.1.5.2, 7.2.2.2, and 8.0.3; underlying commits for the receipt, hash-key, and plain-text changes; downloaded released dependency sources for the moved/new libraries. This is an application-focused triage, not a proof that every upstream change is harmless, a security audit of the target version, or a deployment approval. No test results are claimed. Application upgrade changes remain unmade.
