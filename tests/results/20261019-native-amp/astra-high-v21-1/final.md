# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## Application facts and scope

- **[Application code]** This is an HTML/ERB application using Turbo, import maps, Sprockets, cookie sessions, Action Text, and Active Storage—not a JSON-only API. See [Gemfile](file:///home/user/workspace/repo/Gemfile#L10-L35), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L1-L15), and [session handling](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18).
- **[Application code]** Ruby is pinned to 3.3.6, satisfying Rails 8.1's Ruby ≥3.2 requirement. Rails is pinned to 7.0.8.7, and [application configuration](file:///home/user/workspace/repo/config/application.rb#L12-L24) loads **7.0 defaults**. This report assumes changing the Rails gem requirement only—not changing `load_defaults`, running generators, or replacing infrastructure.
- **[Application code]** PostgreSQL is the only configured database, with a default pool of five; `pg` stays at 1.6.0. Production server version, environment overrides, and actual stored data were not inspected. See [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L26).
- **[Application code]** Sidekiq 6.5.12 and Redis 4.8.1 are pinned. Active Job uses Sidekiq outside tests; exports use native Sidekiq jobs. Tests explicitly use Active Job's test adapter and Sidekiq fake queues. See [Gemfile](file:///home/user/workspace/repo/Gemfile#L34-L36), [test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L36-L37), and [test helper](file:///home/user/workspace/repo/test/test_helper.rb#L4-L9).
- **[Configuration + framework source]** Production enables fragment caching without overriding Rails' default FileStore; development optionally uses MemoryStore, and tests use NullStore. Redis is **not** the Rails cache store. See [production configuration](file:///home/user/workspace/repo/config/environments/production.rb#L15-L17), [development configuration](file:///home/user/workspace/repo/config/environments/development.rb#L20-L34), and [framework default](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L58).
- **[Application code]** Active Storage uses Disk storage, without image variants. The browser explicitly loads **vendored Trix 1.3.5**, while its stylesheet uses the gem-provided `trix.css`. See [storage](file:///home/user/workspace/repo/config/storage.yml#L1-L7), [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L12), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14), and [stylesheet](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L7).
- **[Application code]** Relevant persisted formats are JSON text tags, JSONB note settings, YAML notebook preferences, rich-text HTML, and citations with a `doi` primary key rather than `id`. See [Note](file:///home/user/workspace/repo/app/models/note.rb#L5-L19) and [schema](file:///home/user/workspace/repo/db/schema.rb#L55-L106).
- **[Scope]** This was a static review of upstream changelogs, source/history, and application code/tests. I did **not** install target gems, boot the app, run tests, connect to databases/Redis, decrypt credentials, or change application files. Predicted application outcomes are deductions from source, not executed regression tests.

### Dependency resolution actually performed

**[Resolver result]** I copied `Gemfile` and `Gemfile.lock` into a temporary directory, changed only Rails' requirement to `8.1.0`, and ran `bundle lock --update rails` with Ruby 3.3.6/Bundler 2.5.22. It succeeded on 2026-10-19; no installation was performed.

| Change | Resolved result |
|---|---|
| Rails, Railties, and all 11 framework component gems | 7.0.8.7 → 8.1.0 |
| Existing transitive gem update | `net-imap` 0.6.7 → 0.6.8 |
| Newly locked gems | `action_text-trix` 2.1.19; `bigdecimal` 4.1.3; `drb` 2.2.3; `json` 3.1.0; `rack-session` 1.0.2; `rackup` 1.0.1; `securerandom` 0.4.1; `uri` 1.1.2; `useragent` 0.16.11; `webrick` 1.9.2 |
| Removed | `method_source` 1.1.0 |
| Important unchanged gems | Rack 2.2.24, Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, pg 1.6.0, concurrent-ruby 1.3.4, Turbo, Sprockets, Faraday, Pagy, Nokogiri, and rails-html-sanitizer |

**[Environment metadata]** Current local Ruby defaults include JSON 2.7.2, BigDecimal 3.1.5, DRb 2.2.0, SecureRandom 0.3.1, and URI 0.13.1. They are absent from the original lockfile, so another deployment's baseline may differ. Newly locking them is not automatically behavior-neutral.

**[Conclusion]** There is **no resolver-level Rack 3/Sidekiq conflict**: Action Pack 8.1 permits Rack ≥2.2.4, and Rack 2 was retained. Resolution does not establish runtime compatibility. Transitive selections may change if resolved again later.

## High-risk changes

### H1. Failed CSV imports can commit partial data

**Before → after [changelog + source]:** Rails 7.0 rolls back a written transaction exited by a non-local `return`. Rails 7.1 introduced commit-on-return behind a default; 7.2 removed the rollback behavior. Rails 8.1 commits this exit even with 7.0 defaults.

**Application use [code]:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and successive notes, then executes `return false unless row.note.save` inside the transaction.

**Risk [inference]:** A valid first row followed by an invalid second row can leave the import, first note, rich text, and citation persisted while the request reports failure. The [existing all-or-nothing test](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L72) describes this boundary. Use an explicit rollback/error strategy; another non-local exit is not sufficient.

Sources: [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [old implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L316-L350), [target implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L643-L675).

### H2. Receipt downloads silently lose citation DOIs

**Before → after [changelog + source]:** `read_attribute(:id)`, also used by `record[:id]`, previously redirected to a custom primary key. Since 7.2, it reads the literal `id` attribute. A nonexistent attribute returns nil in this case; `record.id` still represents the primary key.

**Application use [code]:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) writes `citation[:id]` into the DOI column. [Citations have a `doi` primary key and no `id` column](file:///home/user/workspace/repo/db/schema.rb#L55-L62).

**Risk [inference]:** CSV downloads succeed with blank DOI cells. Use the explicit DOI reader or primary-key method, preserving the contract in [the receipt test](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L43-L45).

Sources: [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [target reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb), [nonexistent attribute representation](https://github.com/rails/rails/blob/v8.1.0/activemodel/lib/active_model/attribute.rb#L230-L237).

### H3. Import-preview annotations disappear

**Before → after [upstream PR + source]:** `HashWithIndifferentAccess#stringify_keys` used to retain integer keys. Rails 8.0 makes all keys strings. Indifferent access does not equate integer `2` with string `"2"`.

**Application use [code]:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) creates integer line-number keys; the [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) stringifies them, then looks them up using integer `row.line`.

**Risk [inference]:** Annotations vanish from the preview without an exception, although they can still be imported. Keep producer and consumer key types consistent.

Source: [Rails PR #53125](https://github.com/rails/rails/pull/53125), including an explicit integer-key before/after example.

### H4. Digest jobs select a different day's notes

**Before → after [changelog + source]:** Rails 7.0 reconstructs serialized zoned times in the worker's `Time.zone`. Later Active Job preserves the original named zone. Old payloads without the new `time_zone` field retain the fallback behavior.

**Application use [code]:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) passes the reader's zoned time but reserves requests by **UTC date**. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L2-L10) uses the deserialized `to_date` and `all_day` without normalization.

**Risk [inference]:** At 2026-10-05 03:30 UTC, an Eastern reader's new job selects October 4 locally, rather than October 5 UTC. Subjects and included notes change while Redis deduplication remains UTC-based. Old and new queued payloads can behave differently. Decide whether digests are UTC-day or reader-local-day, and align selection and reservation rules. The [existing test](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L37) distinguishes these cases.

Sources: [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [target serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb). This fix also appears in 7.1 patch history.

### H5. BigDecimal job arguments are incompatible with old workers

**Before → after [changelog + source]:** Rails 7.0 treats BigDecimal as a primitive; JSON queues turn it into a string. Rails 8.1 emits a tagged `ActiveJob::Serializers::BigDecimalSerializer` object that restores a BigDecimal. The transitional opt-out was removed.

**Application use [code]:** [User#request_digest and #reading_completion](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) pass a BigDecimal to [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L7). The [mailer's `BigDecimal(...)` conversion](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) can accept either a legacy string or BigDecimal; it is not itself a required rewrite.

**Risk [inference]:** Rails 7.0 workers cannot resolve the new serializer name in Rails 8.1-produced jobs. Old strings remain readable by new workers, but the reverse direction is unsafe. Coordinate producers, workers, queued work, and rollback—not only web deployment.

Sources: [7.1 deployment warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65), [target serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

### H6. Reminder previews change across daylight-saving boundaries

**Before → after [changelog + source]:** With 7.0 defaults, `TimeWithZone#to_time` preserves a fixed UTC offset. In 8.1 it always preserves the full time zone, regardless of `load_defaults 7.0`.

**Application use [code]:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) performs `reminder_at.to_time + 86_400`; [the reminder partial](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays it.

**Risk [inference]:** After October 31, 2026 at 09:00 −04:00, the next-day preview becomes November 1 at 08:00 −05:00 instead of 09:00 −04:00. **The epoch remains 24 elapsed hours later**—this is not evidence of a one-hour scheduling shift. Decide which presentation is intended; [the current test](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L19-L21) explicitly expects the old offset.

Sources: [8.1 removal](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md), [target implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L499).

### H7. Expired export fragments can be cached without their intended TTL

**Before → after [changelog + source]:** Rails 7.0 accepts negative `expires_in`, creating an already-expired entry. Rails 8.1 removes that option and reports/logs the invalid value when `raise_on_invalid_cache_expiration_time` is false, as with 7.0 defaults. Newer defaults raise instead.

**Application use [code]:** [The export partial](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) caches all completed exports with `expires_in: export.expires_at - Time.current`, including expired ones.

**Risk [inference]:** After expiry, “Expired” fragments can be stored with no expiration, changing cache retention and generating invalid-expiry reports on misses. This is **not an authorization bypass**: [the download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L15) checks the current deadline before conditional responses. Decide whether to skip caching expired fragments or provide another explicit policy.

Sources: [7.1 changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L867), [target negative-expiry handling](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L905-L944).

### H8. Uploaded-file display and download names change

**Before → after [changelog + source]:** Active Storage additionally replaces `"`, `*`, `?`, `<`, and `>` with `-` in sanitized filenames; `chapter?.pdf` becomes `chapter-.pdf`.

**Application use [code]:** [The blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L4-L12) uses `blob.filename` for display, alt text, and download links.

**Risk [inference]:** Existing uploads containing those characters get different displayed/download names without an error. Blob keys and file contents are not renamed. Generated slug-based Markdown names are unlikely to be affected. High follows the requested silent-data-format rubric; practical impact is narrower than H1.

Source: [8.0 Active Storage changelog](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md#L22-L25).

### H9. Local sessions and attachment signatures can change

**Before → after [guide + source]:** The generated development/test secret moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`; 8.1 also honors ENV/credential secrets locally before generating one.

**Application use [code + file metadata]:** [Cookie sessions](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18) and [rich-text attachment references](file:///home/user/workspace/repo/app/models/note.rb#L8) depend on signing secrets. The old local-secret file exists here; the new file does not. Secret contents and encrypted credentials were not inspected.

**Risk [conditional inference]:** Unless the same effective secret is retained, local cookies and existing local Action Text attachment signatures can become invalid. Whether ENV/credentials supply the matching secret is unverified. This is a local data-continuity risk, **not a confirmed production key rotation**.

Sources: [upgrade guide](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [target secret selection](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L526-L545).

### H10. Database reads reconnect/retry instead of immediately surfacing some failures

**Before → after [changelog + source]:** Rails expanded automatic reconnection/retry for known-idempotent SELECTs, including association reads in 8.1. The target defaults to one connection retry and guards whether connection/transaction state can be restored; it does not indiscriminately retry writes.

**Application use [code]:** [Session lookup](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L8), [authentication](file:///home/user/workspace/repo/app/models/user.rb#L15-L16), and association-backed lists exercise those reads. [Database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L26) sets no retry override.

**Risk [inference]:** During transient disconnects, requests can succeed after retry rather than fail immediately; latency and observation time change. No normal-operation query-result regression was established. Review failover expectations separately from H1. High follows the supplied connection-behavior rubric.

Sources: [7.1 policy](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L1628-L1646), [7.2 SELECT retries](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L281-L286), [8.1 association retries](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L582-L585).

### H11. BigDecimal division precision changes—application impact unconfirmed

**Before → after [dependency history + source]:** Local BigDecimal 3.1.5 becomes locked to 4.1.3. Intermediate releases changed `/` precision/rounding; 4.1 introduced new arithmetic algorithms with subsequent corrections.

**Application use [code]:** [User#reading_completion](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) divides counts and rounds to four places; [the digest](file:///home/user/workspace/repo/app/views/digest_mailer/daily_digest.text.erb#L14) formats the result as a percentage.

**Risk [conditional inference]:** This numerical code deserves a focused compatibility check, but I have **not established a valid count pair whose final four-place result changes**. High is provisional under the silent-numeric-results rubric, not a claim of a demonstrated wrong percentage. H5's queue-format incompatibility is stronger evidence.

Sources: [BigDecimal changelog](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md), [precision PR #329](https://github.com/ruby/bigdecimal/pull/329), [rounding PR #330](https://github.com/ruby/bigdecimal/pull/330).

## Medium-risk changes

### M1. Citation-provider configuration uses a removed API

**Before → after [changelog + source]:** `Rails.application.secrets` loads `config/secrets.yml` in 7.0, is deprecated in 7.1, and is removed in 7.2.

**Application use [code]:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L14) reads provider settings through it; [request tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L103-L122) override that object.

**Risk [inference]:** Enrichment raises before contacting the provider. Choose the replacement configuration owner—`config_for` plus ENV, application configuration, or credentials—while preserving per-environment behavior and test overrides. This needs a configuration decision, not just a method rename.

Source: [Railties 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md).

### M2. Built-in Sidekiq adapter is deprecated for removal in Rails 8.2

**Before → after [changelog + source]:** Rails 8.1 retains its adapter but warns of removal in 8.2, directing users to Sidekiq ≥7.3.3's adapter.

**Application use [code]:** [Application configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24) selects `:sidekiq`; [Gemfile](file:///home/user/workspace/repo/Gemfile#L34-L36) pins Sidekiq 6.5.12/Redis 4.8.1.

**Risk [inference]:** The 8.1 resolution works, but this adapter cannot be carried unchanged into the next release. A Sidekiq upgrade needs a separate Redis/native-job/dependency review; it did not occur here. Medium follows the requested next-release-removal rule.

Sources: [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [adapter warning](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).

### M3. JSON 3 rejects provider responses previously accepted

**Before → after [dependency changelog + source]:** Local JSON 2.7.2 accepts duplicate object keys and JavaScript-style comments. Resolved JSON 3.1.0 rejects both by default, tightens invalid escapes, removes `create_additions`, and rejects unknown options.

**Application use [code]:** [Citation::Provider#metadata_from](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) parses JSON and converts `JSON::ParserError` to a provider error; [Citation#enrich](file:///home/user/workspace/repo/app/models/citation.rb#L28-L32) records failure.

**Risk [conditional inference]:** Duplicate `title`/`url` keys or comments now fail enrichment. No such live payload was inspected. Decide whether strict rejection is intended or the provider contract needs repair; broad unsafe deserialization is not an appropriate workaround. Ordinary valid provider JSON and tag arrays have no demonstrated regression. Sidekiq's inspected calls use `parse`/`generate`, not removed `create_additions` APIs.

Source: [JSON 3.0/3.1 changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

## Low-risk, mechanical changes

- **[Changelog + code] Action Text allowlist:** [The initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) adds to `allowed_tags`, now initially nil; extend the effective default allowlist instead, retaining attachment tags. Otherwise boot raises. [Upstream commit](https://github.com/rails/rails/commit/e8137c527dd6bd43f695b472f440cab7466243a6).
- **[Changelog + code] Enum:** [Note's keyword-style declaration](file:///home/user/workspace/repo/app/models/note.rb#L10) must become `enum :status, { draft: 0, ready: 1 }, prefix: true`, preserving values and prefixes. [8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- **[Changelog + code] Serialized tags:** [Positional JSON coder](file:///home/user/workspace/repo/app/models/note.rb#L12) becomes `serialize :tags, coder: JSON`; preserve the stored format. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **[Changelog + code] Store-accessor alias:** [Note aliases virtual `color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14), which `alias_attribute` now rejects; provide reader/writer forwarding to that accessor, not a new column. [Target validation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb#L87-L98).
- **[Changelog + code] String-array sum:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) relies on Rails' removed `sum` override; Ruby's numeric identity raises TypeError. `fragments.join` or `sum("")` preserves concatenation. [7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md).
- **[Changelog + code] Retry spelling:** [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7-L9) needs `:polynomially_longer` instead of `:exponentially_longer`, preserving the old polynomial schedule; the old option fails when retrying. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51-L55).
- **[Changelog + code] Reminder scheduling type:** [Integer `wait_until`](file:///home/user/workspace/repo/app/models/note.rb#L60-L62) must be converted to the equivalent Time; the target calls `scheduled_at.utc.iso8601`, which Integer cannot supply. [7.1 change](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L15-L18), [target serialization](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L129-L130).
- **[Changelog + code] Route aliases:** [Multi-path `get`](file:///home/user/workspace/repo/config/routes.rb#L17-L18) is removed in 8.1; split `/notes` and `/journal` into separate routes while retaining canonical `notes_path`. [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md).
- **[Changelog + code] Test exceptions:** [`show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) becomes `:none`; otherwise false falls through to rendered error responses and breaks existing `assert_raises` tests. [Target dispatch](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb#L185-L198).
- **[Changelog + code] Schema/test housekeeping:** [Schema dumps](file:///home/user/workspace/repo/db/schema.rb#L13) sort columns alphabetically; [parallel tests](file:///home/user/workspace/repo/test/test_helper.rb#L8-L9) use `_N` database suffixes instead of `-N`. Review generated diffs/disposable test databases, not production data migrations. [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md).

## Changes not activated, or not relevant to observed paths

These are scoped exclusions, not assertions that entire components are risk-free.

- **[Configuration + source] PostgreSQL date decoding:** [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) would fail at `Date.iso8601(day)` if raw dates became Date objects, but this is enabled by **7.2 defaults**, not the gem bump; target adapter default is false. Revisit before changing defaults.
- **[Configuration + source] Default YAML coder removal:** [Notebook#preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7) retains YAML with 7.0 defaults; `default_column_serializer = nil` belongs to 7.1 defaults. Explicitly preserve YAML if later adopting them.
- **[Configuration + source] Readonly assignment errors:** [Notebook's readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L8) does not begin raising unless 7.1's `raise_on_assign_to_attr_readonly` default is adopted; revisit [the permitted slug](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L39-L40) then.
- **[Configuration + source] HTML5 sanitizers/parser:** New defaults gate these; retaining 7.0 keeps HTML4. The nil allowlist failure above is independent. [Framework defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L269-L321).
- **[Configuration + source] HTTP freshness precedence:** [Export downloads use both validators](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11-L12), but ETag-preferred `strict_freshness` belongs to 8.0 defaults; existing both-headers behavior remains.
- **[Configuration + source] Cache/message formats and callback-order defaults:** Cache format 7.0 remains supported; 7.1 message-serialization, metadata, and callback-order opt-ins are not automatically adopted. Stage those decisions separately.
- **[Target source + application code] Deferred enqueue after commit:** Despite the general 7.2 announcement, exact target 8.1 defaults `enqueue_after_transaction_commit` to **false**. [ApplicationJob](file:///home/user/workspace/repo/app/jobs/application_job.rb#L1-L7) does not override it, so [citation](file:///home/user/workspace/repo/app/models/citation.rb#L14-L23) and [reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) enqueueing stays inside locks. [Target default](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L53).
- **[Resolution + source] Rack 3 migration:** Not selected. `rack-session` 1.0.2 and `rackup` 1.0.1 are Rack-2 compatibility packages, not new Rack-3 session behavior. No forced Puma/Redis/Sidekiq major upgrade occurred.
- **[Application code + dependency source] Automatic Trix JavaScript upgrade:** Not effective: [the layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14) retains vendored 1.3.5. The new gem supplies 2.1.19 CSS through `require trix`, while Action Text's upload integration also changes. **Review mixed asset versions before shipping**; a functional malfunction was not established statically, and newer JS fixes are not delivered merely by adding the gem. [Packaging change](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md), [Trix history](https://github.com/basecamp/trix/releases).
- **[Application code] Cloud storage, image/video variants, custom streaming controllers:** Not used; [Disk configuration](file:///home/user/workspace/repo/config/storage.yml#L1-L7) and [the custom blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L5) rule out Azure/S3/GCS, processor-default, and custom streaming-inclusion changes.
- **[Application + target source] RichText embed timing / Blob reverse autosave:** Reviewed: embeds move to `before_validation`, and blobs no longer autosave attachments. This app [checks attachables directly](file:///home/user/workspace/repo/app/models/note.rb#L95-L97) and [saves attachments through the export owner](file:///home/user/workspace/repo/app/models/export.rb#L66-L74), not `blob.save`; no dependency on old timing/reverse autosave was found.
- **[Application code] MySQL, SQLite, composite keys, sharding, encrypted attributes, bulk upserts, complex join/merge fixes:** No matching adapter/configuration/calls were found. The single-column custom DOI key is covered in H2.
- **[Application code] Action Mailbox / net-imap:** No inbound-mail or IMAP path; mailers send outbound digests/reminders. The resolved net-imap patch concerns IMAP timeout mapping, parsing, and sequence sets, not those calls. [0.6.8 history](https://github.com/ruby/net-imap/releases/tag/v0.6.8).
- **[Application code] Application Action Cable broadcasts/subscriptions:** Only generated base classes exist; no application channel or broadcast calls were found. Redis cable configuration alone does not establish use of the changed APIs.
- **[Application code] JSON response escaping / UJS / alternative templates:** No `render json:` endpoints, Rails UJS, HAML, or Slim paths were found. Provider JSON parsing remains relevant under M3.
- **[Application code] New authentication/reset APIs:** `has_secure_password` is used, but no password-reset route or call was found; the upgrade does not replace existing sessions. Password-challenge/confirmation changes do not alter the observed login flow.
- **[Configuration + resolution] Solid Queue/Cache/Cable, Propshaft, Kamal, generated CI:** These are generator/new-app choices, not automatic replacements for the current Sidekiq/Sprockets/storage/cache setup.
- **[Dependency source comparison] URI 1.1.2:** Although the default parser constant changes, this application's `URI.parse` and Faraday's normal parse/join path already use RFC3986 under URI 0.13.1. No use of changed username setters/parser constants was found. [URI history](https://github.com/ruby/uri/releases/tag/v1.0.0).
- **[Dependency source comparison] SecureRandom 0.4.1:** The inspected 0.3.1→0.4.1 change adds Ruby-3.2 compatibility; this app pins 3.3.6. No new cryptographic output format was found.
- **[Dependency source + framework use] DRb 2.2.3:** Rails parallel tests use a local Unix-socket coordinator. The gem replaces arbitrary ObjectSpace lookup with an exported-object weak map; no custom DRb IDs or SSL use were found. No application migration identified, but parallel tests remain unexecuted. [History](https://github.com/ruby/drb/releases/tag/v2.2.3).
- **[Resolution + code] useragent / WEBrick / method_source:** Browser gating is unused, Puma is the configured server, and there are no application `method_source` calls; no direct application behavior change identified.
- **[Resolution] Unchanged external libraries:** No Faraday, Redis, Sidekiq, Pagy, Turbo, Sprockets, Nokogiri, or sanitizer version migration should be attributed to this resolution; Rails integration changes still need review.

## Decision and limits

**Recommendation [inference]:** Do not treat this as a dependency-only production rollout. Resolution succeeds, but the current code has boot/runtime incompatibilities and silent changes affecting import integrity, receipts, queued jobs, dates, and caching. Preserve 7.0 defaults initially; address these contracts before separately adopting newer defaults. Existing import, digest, reminder, note, notebook, and export tests are useful review targets; none were run here.

History reviewed includes 7.1, 7.2, 8.0, and 8.1 release changelogs, patch histories through 7.1.5.2/7.2.2.2/8.0.3, and source comparisons of exact 7.0.8.7/8.1.0 endpoints. This is prioritized, not exhaustive, and is not a security audit of the exact 8.1.0 release. No application upgrade, commit, push, or deployment was performed.