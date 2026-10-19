# Rails 7.0.8.7 → 8.1.0: Margin Notes upgrade plan

## Recommendation and evidence status

Proceed as a staged compatibility upgrade, **not a Gemfile-only deployment**. Keep `config.load_defaults 7.0` during the framework upgrade, then adopt newer defaults separately. This does not opt out of removed APIs or unconditional serialization/transaction changes.

The application is Ruby 3.3.6, PostgreSQL, Rails 7.0 defaults, Sprockets/importmap, Action Text, Disk Active Storage, Sidekiq 6.5.12 and redis-rb 4.8.1. Tests use Active Job's test adapter and Sidekiq fake mode. Ruby already satisfies Rails 8.1's >= 3.2 requirement.

**Executed:** only dependency resolution in a disposable checkout, with Rails changed to exactly 8.1.0. `mise exec -- bundle lock --update rails` exited 0. It retained Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, pg 1.6.0, Pagy 8.6.3, concurrent-ruby 1.3.4 and Faraday 1.10.4. It resolved Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1 and action_text-trix 2.1.19. There is **no mandatory Rack 3 / Sidekiq 7 / Puma 6 upgrade** established here. The earlier preliminary Rack-conflict concern was disproved.

**Not executed:** bundle installation, Rails boot, database preparation/migrations, application tests, real worker delivery, asset compilation or browsers. All behavior findings below are source-based, not reproduced failures. All validations below remain proposed. No working application, database, queue, cache or storage was modified. The dependency-only process never loaded Rails or connected to application services; no runtime experiment was attempted with the copied service configurations.

Resolution evidence beside this report: `resolution-command.txt`, `resolution.log`, `baseline.Gemfile.lock`, `candidate.Gemfile`, `candidate.Gemfile.lock`. The full locks, rather than this selected list, identify the dependencies. New transitive dependencies include BigDecimal 4.1.3 and JSON 3.1.0; runtime validation must use the saved lock, not an unrecorded re-resolution. There are no Rails runtime logs for this experiment.

## Required compatibility work (even with 7.0 defaults)

### 1. Action Text initializer fails before feature testing

- **Code:** [config/initializers/action_text.rb:3](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3).
- **Change/condition:** From 7.1, `ContentHelper.allowed_tags` defaults to nil; effective defaults are calculated at rendering time. `nil += %w[details summary]` fails regardless of `load_defaults`.
- **Recommendation:** Explicitly build the allowlist from the selected sanitizer's default tags, `ActionText::Attachment.tag_name`, `figure`, `figcaption`, plus `details` and `summary`. Apply it after the intended sanitizer vendor is selected. Do not merely use `Array(allowed_tags) + extras`: that discards ordinary safe tags and attachment markup.
- **Current-version preparation:** Constructing from `ContentHelper.sanitizer.class.allowed_tags` plus the attachment tags works on 7.0 too. The new `sanitizer_allowed_tags` helper itself is not a 7.0-compatible preparation.
- **Validation:** Boot with eager loading and reloading; render a persisted excerpt containing details/summary, links, an image attachment and script/event/javascript-URL attacks. Require preserved safe structure and attachment identity, with unsafe markup absent. Existing notes-controller sanitizer tests are a useful start, not full HTML parser or browser coverage.
- **Source:** [7.1 Action Text changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [8.1 content helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).

### 2. Three incompatible Note declarations

- **Code:** [app/models/note.rb:10–14](file:///home/user/workspace/repo/app/models/note.rb#L10-L14).
- **Required changes:**
  1. Replace keyword `enum status: ..., _prefix: true` with `enum :status, { draft: 0, ready: 1 }, prefix: true`. Rails 8.0 removes the keyword declaration. The positional form already works on 7.0, as Citation and Export demonstrate. Preserve numeric mappings and `status_ready`/`status_ready?` names.
  2. Change `serialize :tags, JSON` to `serialize :tags, coder: JSON` on 7.1, before 7.2 removes the second positional argument. **Do not make this keyword-only change on 7.0:** its implementation does not select the coder from that keyword. Keep existing JSON text, including `[]`; do not rewrite tags to YAML or jsonb as part of this upgrade.
  3. Replace `alias_attribute :highlight_color, :color` with explicit `highlight_color` and `highlight_color=` methods forwarding to the store accessor. `color` is a jsonb store key, not an Active Record column; 7.2 rejects aliasing a nonexistent attribute. Explicit forwarding works on 7.0 and preserves both reads and writes.
- **Validation:** Load existing nonempty and empty JSON tags, edit/reload them, check raw persisted JSON, status scopes and predicates, and create/update/read the highlight through the form. Reopen newly written rows under the rollback version. Existing note request tests cover much of the observable contract; fixtures alone do not cover older real serialized rows.
- **Sources:** [7.2 removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-record), [8.0 removals](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html#active-record), [7.0 serialization](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serialization](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb).

### 3. Export string accumulation

- **Code:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L32-L43), `fragments.sum`.
- **Change:** Rails 7.1 removes Active Support's special Enumerable/Array sum behavior. Ruby's default numeric identity is inappropriate for these Markdown strings.
- **Recommendation:** `finish(fragments.join)`. Works on 7.0 and target; preserves the heading even for an empty notebook.
- **Validation:** Exact downloaded Markdown bytes for empty and multi-note notebooks, chronological order, whitespace and rich-text plain text; execute a queued native ExportJob, not just its model method. Existing export tests already assert meaningful output and cancellation.
- **Source:** [7.1 Active Support removals](https://guides.rubyonrails.org/v8.1.0/7_1_release_notes.html#active-support).

### 4. CSV import atomicity can silently change

- **Code:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L61).
- **Change/condition:** `return false` exits a transaction after the Import and possibly earlier rows were written. Rails 7.0 rolls those writes back; 7.1's new defaults commit on nonlocal return; 7.2 removes the rollback behavior regardless of defaults. A later invalid row can therefore leave a partial batch while the UI says it failed.
- **Recommendation:** Use explicit `ActiveRecord::Rollback` on a failed row and return a false result from outside the block; return true only on complete success. Preserve failed row errors for the preview. If this API is used inside another transaction, explicitly test that boundary and use a savepoint if it must roll back only the batch. Do not replace `return` with `break`: it does not establish rollback.
- **Current-version preparation:** Explicit rollback and an explicit result work on 7.0. Do this before enabling 7.1 defaults or moving to 7.2.
- **Validation:** A valid first row with a new DOI, followed by a blank-title/invalid-DOI row; assert no new Import, Note, Citation or ActionText record survives, while the invalid row is rendered. Verify after an actual transaction boundary as well as inside Rails transactional tests. The existing invalid-import test is relevant; success-only imports cannot find this regression.
- **Sources:** [7.1 defaults](https://github.com/rails/rails/blob/v7.1.0/railties/lib/rails/application/configuration.rb), [7.2 transaction removal](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-record).

### 5. Import receipts and annotation previews lose data

- **Code:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L70), [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L42), [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44).
- **Changes:** Citation's primary key is `doi`; Rails 7.2 no longer maps `citation[:id]` to the custom primary key. Use `citation.doi` (or `citation.id`) to preserve receipts. Rails 8.0 makes `HashWithIndifferentAccess#stringify_keys` stringify integer keys too; the preview still indexes with integer `row.line`, so annotations disappear.
- **Recommendation:** Use `citation.doi`; remove the unnecessary `.stringify_keys` in the preview and retain integer line keys. Both changes work on 7.0. Changing only the lookup to `row.line.to_s` would not preserve the old HWiA behavior on 7.0.
- **Validation:** CSV receipt includes the exact mixed-case DOI for two notes sharing a citation, plus a note without one. Preview a multiline quoted body that produces source lines 2 and 4, with different annotations containing literal `<b>` and `&`; both annotations must render escaped on the correct row. Existing import tests contain these discriminating inputs.
- **Sources:** [7.2 custom-primary-key removal](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-record), [8.0 HWiA changelog](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).

### 6. Provider configuration must leave Rails.application.secrets

- **Code:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15), config/secrets.yml, and secrets accesses in test/controllers/citation_enrichments_controller_test.rb (lines 45, 117–122).
- **Change:** Rails 7.2 removes `Rails.application.secrets`.
- **Recommendation:** Move the existing environment-backed YAML to a dedicated provider configuration read with `Rails.application.config_for`, or assign that result to `config.x.citation_provider`; update Provider and its tests together. Preserve environment names, development/test fallback behavior and JSON quoting of environment values. Do not accidentally configure production with demonstration credentials. Keep both web and worker configuration identical.
- **Current-version preparation:** `config_for`/`config.x` are available on 7.0. Do not move or regenerate `secret_key_base` while replacing this unrelated provider configuration.
- **Validation:** Existing fresh-process credential test with punctuation/newlines in synthetic credentials, successful lookup, unconfigured provider, 401 and repeated 503 behavior. Do not log credentials.
- **Source:** [7.2 Railties removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#railties).

### 7. Reminder scheduling and citation retry API removals

- **Code:** [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L69), [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L1-L14).
- **Changes:** Active Job changes `scheduled_at` to a Time in 7.1 and removes numeric support in 7.2. The current integer `wait_until: reminder_epoch` reaches `scheduled_at`, and target serialization calls `utc.iso8601`. Convert at the enqueue boundary with `Time.at(reminder_epoch).utc`; keep the database epoch integer. This works on 7.0 too. Rename `wait: :exponentially_longer` to `:polynomially_longer` on 7.1; the old symbol is removed in 7.2. The new symbol is **not** supported by 7.0, so do not put that rename in the 7.0 preparation deployment. The algorithm is polynomial already; preserve attempts: 3 and jitter rather than introducing a new retry policy.
- **Validation:** Schedule at exact epoch 1,793,451,617; inspect Redis's schedule score and run due work; reschedule and confirm the older job sends no email; test deleted notes. Run three provider-failure attempts with the local fake, verify at most six HTTP calls, retry delays within the existing polynomial+jitter bounds, and terminal failure state without an additional Sidekiq retry loop.
- **Queued-work impact:** Old 7.0 jobs do not carry the new inner `scheduled_at`; Sidekiq owns their scheduling externally. Do not rewrite schedule scores or replace job IDs casually: reminder cancellation depends on the persisted Active Job ID. Test old scheduled and retry payloads in new workers and the reverse for rollback.
- **Sources:** [7.1 Active Job changelog](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-job), [8.1 core](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).

### 8. Digest time-zone semantics and mixed-version decimal payloads

- **Code:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L27-L57), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L1-L9), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L1-L13).
- **Time change:** Rails 7.2 preserves a TimeWithZone argument's serialized zone. The reader's local time previously deserialized in the job's UTC zone. The Redis reservation remains keyed by UTC date, while the mailer uses `requested_at.to_date` and `requested_at.all_day`. New payloads can select a different day than old payloads for the same instant, independent of defaults.
- **Recommendation:** Preserve the documented UTC-day contract explicitly in the consumer: normalize `requested_at` to UTC before both date and range calculations. Optionally send UTC from the producer too, but a producer-only fix does not repair queued arguments. Consumer normalization is valid on 7.0 and handles both old and new payloads.
- **Decimal change:** 7.1 introduces BigDecimalSerializer behind a flag; 7.2 makes it mandatory. A 7.0 worker cannot resolve that new serializer. Old Sidekiq JSON payloads carry a string, whereas the Active Job test adapter currently leaves a BigDecimal. DigestMailer's `BigDecimal(...)` conversion already accepts either, so changing that conversion is not the principal fix.
- **Recommendation:** Before mixed-version operation, send `reading_completion.to_s("F")` as the digest argument. This is native JSON, works on 7.0, preserves precision, and is accepted by the existing mailer. Alternatively deploy serializer-capable consumers everywhere before enabling new writers; 7.1 is a useful bridge. Do not claim `load_defaults 7.0` disables this change in 7.2/8.1.
- **Validation:** JSON-round-trip actual job payloads in separate old/new producer/consumer combinations. Use 2026-10-05 03:30 UTC / 2026-10-04 23:30 Eastern and notes on both UTC days; require the October 5 digest and matching UTC reservation. Use completion 0.6667, not only 0 or 1. Verify old string, new BigDecimal marker and proposed string payloads, then a real isolated Sidekiq execution and duplicate request. Existing digest tests already check midnight semantics but do not exercise cross-version Redis serialization.
- **Rollout/rollback:** Retain the normalization/string preparation in the rollback build. Inventory immediate, scheduled, retry and dead jobs for serializer markers; upgrading consumers first alone is insufficient if workers can roll back while newer-format work remains. Do not flush digest reservations: doing so allows duplicate requests and emails.
- **Sources:** [7.1 decimal change](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 time-zone/decimal changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 TimeWithZone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

### 9. Reminder preview changes across DST even without new defaults

- **Code:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L45), [reminder preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20).
- **Change:** In 8.1 `TimeWithZone#to_time` preserves the actual zone, not the old fixed-offset conversion. Adding 86,400 seconds across a DST boundary can change the displayed offset/wall-clock time. The scheduled instant still advances 24 elapsed hours.
- **Recommendation:** Make the intended display explicit. To preserve existing output, construct a fixed-offset Time, e.g. `Time.at(reminder_epoch).getlocal(reminder_at.utc_offset) + 86_400` (works on 7.0). Preferably adopt a separately acknowledged UI correction that shows the resulting instant in the reader's zone; then update the old fixed-offset expectation deliberately. Do not change to calendar-day arithmetic accidentally.
- **Validation:** Eastern 2026-10-31 09:00 -04:00 advances to the instant represented locally as November 1 08:00 -05:00, while the old preview says 09:00 -04:00. Test spring-forward too, comparing both epoch and visible offset. Existing reminder tests assert the old fall-back preview, so a changed assertion needs a reason.
- **Source:** [8.1 TimeWithZone#to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

### 10. Routing and test exception configuration

- **Code:** [routes.rb:18](file:///home/user/workspace/repo/config/routes.rb#L17-L23), [test.rb:31](file:///home/user/workspace/repo/config/environments/test.rb#L30-L37).
- **Changes/recommendation:** Rails 8.1 removes one route declaration with multiple paths. Split `/notes` and `/journal` into individual GET declarations, preserve `notes_path`, explicitly name the alias as needed. Works on 7.0. On 7.1 change `show_exceptions = false` to `:none`; boolean support is removed in 7.2 and false falls through to rendering on target. `:none` is **not** a 7.0-compatible replacement for false, so stage with the framework version.
- **Validation:** Both URLs with identical pagination/filter query strings; correct generated next/previous links. Existing unauthorized-resource tests must still raise. Separately exercise production-style responses as 404s, not only test exception propagation. Keep the explicit test queue adapter: the 7.2 change making tests consistently honor it is not a reason to use Sidekiq globally in tests.
- **Sources:** [8.1 Action Pack removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#action-pack), [7.2 Action Pack removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#action-pack).

## Default adoption: separate choices, not prerequisites for the gem bump

The authoritative comparison is the tagged [8.1 load_defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb). Enabling 8.1 defaults recursively enables 7.1, 7.2 and 8.0 defaults.

| Affected behavior | Applicability, recommendation and 7.0 preparation | Discriminating validation |
|---|---|---|
| Notebook YAML preferences (`app/models/notebook.rb:7`) | 7.1 defaults set `default_column_serializer = nil`; the bare `serialize :preferences` then fails. On 7.1+, specify `coder: YAML` explicitly, preserving the existing YAML text. Do not opportunistically switch to JSON. The keyword form is not a safe 7.0 preparation; retain the old declaration until the bridge. | Read anonymized existing YAML (including null and nonempty heading), update/save, then read from the rollback build. Inventory unexpected serialized classes before tightening a type or safe-load allowlist; do not enable unsafe YAML loading to get green tests. |
| Notebook read-only slug (`notebook.rb:8`, `notebooks_controller.rb:40`, settings form) | 7.1 defaults raise on assignment to persisted read-only attributes, even resubmitting the same value. Stop permitting slug on updates and remove the hidden field; preserve create-time slug generation. This preparation works on 7.0. Keep model-level readonly protection. | Ordinary name/heading update succeeds; unchanged and malicious changed slug submissions never modify slug. Current settings test deliberately resubmits it. |
| Activity report raw DATE (`notebook.rb:38–40`) | 7.2 defaults enable `postgresql_adapter_decode_dates`; raw select_rows returns Date instead of String, breaking `Date.iso8601(day)`. Normalize via `day.to_date` or `Date.iso8601(day.to_s)` on both versions, or temporarily retain false. | Use real PostgreSQL with the setting both false and true; dates around UTC midnight, multiple notes on one date, empty notebook and foreign owner. Exact counts/order, not just a successful SQL call. |
| Expired export fragment (`app/views/exports/_export.html.erb:26`) | The current computed `expires_in` becomes negative after expiry. 7.1 adds invalid-TTL handling; with 7.0 defaults it reports/removes the invalid TTL, and 7.1 defaults raise. Cache only while available with a positive TTL, rendering expired state uncached, or use a supported absolute deadline deliberately. Conditional caching works on 7.0. Do not authorize downloads from this cache. | Enable caching; test before, at and after expiry, cold/warm cache and a deadline shortened without changing the cache key. A warm stale link must never permit download. Existing cache test helps; null-store tests are insufficient. |
| Conditional download (`ExportDownloadsController#show`) | 8.0 `strict_freshness = true` makes ETag take precedence over Last-Modified. Keep old setting until intentionally adopted; no required controller rewrite. The flag is not a 7.0 preparation API. | Before expiry, matching ETag + stale If-Modified-Since changes 200 → 304; nonmatching ETag + fresh date stays 200. Also test single headers. At/after expiry or with another reader, authorization/expiry must win before any 304. Existing tests do not exercise conflicting validators on an available export. |
| HTML5 sanitization (`action_text.rb`, persisted note bodies) | 7.1 defaults choose the best-supported HTML5 sanitizer. Keep HTML4 for initial compatibility, then test HTML5 explicitly. Existing stored HTML is rendered under the selected parser; no DB rewrite is required by the framework. | Malformed nested markup, details/summary, link protocols, embedded attachment attributes, render/plain-text export and edit/save round trips. Avoid normalizing all stored HTML as part of the framework deployment. |
| Signed messages and cache formats | 7.1 defaults change message serialization/metadata and cache format to 7.1. Keep the old writer formats until all readers and rollback candidates understand the new formats. Do not add new configuration setters to 7.0 without checking support. See rollout section. | Bidirectional old/new verification and cache reads; a new reader accepting old bytes does not prove the old reader accepts new bytes. |

Other generated-app choices—Propshaft, Solid Queue/Cache/Cable, authentication generator, Kamal/Thruster, browser gating, CI/lint files—are **not automatic requirements for upgrading this existing application**. Retain Sprockets/importmap, Sidekiq, explicit storage and authentication. Do not bulk-accept `app:update` output. The existing pg and Ruby versions do not show a source-level minimum-version blocker. Production server/service versions still need inventory.

## Cross-version deployment, persistent data and optional adjacent work

### Queue transaction timing is version/configuration dependent

Citation#request_enrichment and Note#schedule_reminder enqueue inside row locks, relying on an enqueue error to roll back state. Native Notebook#request_export deliberately persists before queueing and compensates for Redis errors.

Rails 7.2 with its new defaults selects adapter-controlled after-commit enqueueing; its built-in Sidekiq adapter inherits a true after-commit preference. With the app's retained 7.0 defaults it is not selected. Rails **8.1 defaults the per-job property to false**. The broad release-note statement that jobs defer is therefore not a sufficient description of this app at the target. Do not blindly copy a 7.2 initializer into 8.1: symbols `:never/:always/:default` and the global config are removed there.

Keep current synchronous-enqueue semantics for initial compatibility. If explicitly configuring each job, use `:never` on 7.2 and false on 8.0/8.1; the setter does not exist on 7.0. Do not treat false as equivalent to `:never` on 7.2's case-based implementation. Opting into deferral requires a new failure/recovery design: Redis failure after commit cannot roll back the pending citation or replacement reminder. Native Sidekiq jobs are not governed by Active Job's flag.

**Proposed validation:** real isolated worker, actual commits (not only transactional fixtures), enqueue failure before and after commit, rollback, job pickup racing with the request, and persisted job IDs. Require that earlier reminder state survives the selected failure mode. Sources: [7.2 defaults](https://github.com/rails/rails/blob/v7.2.0/railties/lib/rails/application/configuration.rb), [7.2 enqueue implementation](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb), [8.1 enqueuing](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb).

### Sessions, attachment signatures and secrets

The app stores user ID in the session, embeds signed attachment references in Action Text and exposes signed blob links. Development/test local-secret filename changes from `tmp/development_secret.txt` to `tmp/local_secret.txt` in 7.1. Preserve the existing secret when carrying development data forward; otherwise old attachment references and sessions can become invalid. Production key provenance is unverified; retain its exact secret, salts and key derivation during the provider-config migration.

Keep 7.0 message/cache writer formats during mixed-version operation. 7.1's new reader fallbacks are not proof of reverse compatibility. Test old session cookies, blob signed IDs, persisted Action Text SGIDs, rendered blob redirects and Disk service URLs on the candidate, and candidate-created equivalents on the rollback build. Some attachment references are stored long-term, so waiting for short-lived Disk URLs or sessions to expire is not enough. If adopting new writers, introduce verified reader compatibility/rotations first, or explicitly retire rollback to 7.0. Do not rotate secrets or rewrite every rich-text body as a shortcut.

Development uses memory/null cache; production leaves the store implicit. Do not assume Redis is the application cache: here Redis holds Sidekiq and digest reservations. Determine the actual production cache and namespace, then either prove cross-version format compatibility or use versioned cache namespaces/cold cache. Never flush the shared Redis instance to invalidate HTML fragments.

Sources: [versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [7.1 message/cache changes](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [Active Storage verifier](https://github.com/rails/rails/blob/v8.1.0/activestorage/lib/active_storage/engine.rb).

### Trix and browser behavior need their own gate

The layout explicitly loads vendored Trix 1.3.5 while `*= require trix` pulls the gem's CSS and importmap loads the gem's Action Text JS. Rails 8.1 moves Trix to action_text-trix; this resolution selected 2.1.19. The explicit old script does not magically update. Thus leaving the layout unchanged combines old Trix JS with new Action Text JS/CSS.

No browser incompatibility was executed here. Validate the existing combination or, preferably, deliberately adopt the gem-supplied matched Trix assets and remove the old script/manifest inclusion in that tested change. A Trix 2 asset change should not be asserted compatible with 7.0 without its own browser test. Avoid loading two Trix builds simultaneously. Exercise precompiled production assets, load/edit/save an existing link and attachment, new direct upload, oversized attachment rejection, and sanitization. This app has a system-test base but **no system-test cases**; running `test:system` alone supplies no browser coverage. Existing details/summary flattening on editor save is documented, not newly caused by this upgrade; compare before/after rather than attributing every difference to Rails.

Source: [8.1 Action Text changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

### Sidekiq upgrade is recommended separately, not a resolver prerequisite

Rails 8.1 still ships the built-in adapter but deprecates it for removal in 8.2, recommending Sidekiq >= 7.3.3 for the gem-owned adapter. Keep Sidekiq 6.5 during the minimal Rails experiment to avoid conflating migrations; separately assess the supported Sidekiq/Rack/Redis/Puma stack before release. If upgrading Sidekiq, trace strict JSON arguments (`ExportJob` currently receives a symbol-keyed hash), Redis command return types (`User#request_digest` branches on `sadd` truthiness), connection errors (`Notebook#request_export` rescues Redis::BaseError), and old/new wrapper class names. These are adjacent-upgrade risk areas, **not verified failures with a particular new Sidekiq version**. Do not disable strict argument checking globally to conceal an incompatible job contract.

Source: [8.1 Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).

## Delivery sequence and validation gates

1. **Inventory and baseline in isolation.** Record Ruby/Bundler, full lock, effective defaults, deployment topology, actual PostgreSQL/Redis versions, worker commands, queue names, credentials provenance, cache/store paths, SMTP settings and anonymized stored formats. No production inventory was performed here. Use a disposable database name, a dedicated Redis instance/port, separate storage/cache/mail directories and test-only credentials; set these for child processes too. A copied checkout's database.yml and default REDIS_URL still point to shared services and must not be used unchanged. Disable parallelism or provision exclusively disposable worker databases. Keep provider traffic on the test fake; do not send mail externally.
2. **Deploy 7.0-compatible preparation.** Enum/forwarding, export join, explicit import rollback, DOI reads, integer-key annotations, provider config replacement, Time scheduling, UTC digest consumption and decimal-string production, and conditional-cache/read-only-form preparations can precede Rails. Validate on 7.0; preserve them in a rollback build. Do not prematurely apply coder keywords, :none or :polynomially_longer.
3. **Upgrade one minor at a time.** Following the upstream guide, use current patch releases within 7.0 → 7.1 → 7.2 → 8.0 as checkpoints, then the requested 8.1.0. Record exact checkpoint locks; this assessment inspected the versioned initial-release changes and current 7.0.8.7/target 8.1.0 source, not every intermediate patch. Introduce the version-gated syntax/configuration changes at 7.1 and resolve deprecations before proceeding. Run `app:update` only in disposable working copies and review each merge; keep load_defaults 7.0 initially.
4. **Runtime validation after dependencies install.** Run eager-load/zeitwerk checks, all model/request tests, schema load and a separate full migration replay on disposable databases, asset precompile and browser scenarios. Rails 8.0 fresh `db:migrate` can load the schema instead of replaying all historical migrations, so it is not evidence of full replay. Rails 8.1 alphabetizes schema columns; review that as generated noise, not a data migration. Preserve migration version brackets. Add only contract-level regression tests where existing ones miss the behavior.
5. **Cross-version contract matrix.** Run old→old, old→new, new→new and new→rollback for stored YAML/JSON, signed cookies/attachments and actual JSON queue payloads. Exercise reminders, digest decimals/time zones, citation retries, native exports and framework Active Storage jobs. Preserve JIDs, Active Job IDs, retry counters and schedules. Tests that manufacture all data/jobs under the new version cannot establish this.
6. **Deploy consumers with verified compatibility before producers; retain rollback capability deliberately.** Keep writer formats stable for the rollback window. Inventory retry/dead/scheduled work, including far-future reminders—draining the immediate queue is insufficient. If a new format cannot be read by the rollback build, stop incompatible producers and use a specifically tested replay/migration/forward-fix plan; do not flush queues or discard jobs. An already-sent email or partially committed import cannot be undone by a code rollback.
7. **Adopt defaults individually.** Enable only after the relevant validation above; record exact effective values in each variant. Then raise load_defaults and remove superseded temporary overrides. Do not combine serializer/asset/queue-provider changes with the first framework deploy.

For every future runtime variant, retain the command, source diff, exact Gemfile.lock, effective configuration, isolated resource identifiers, exit status/stdout/stderr, Rails logs and Sidekiq logs together. Compare a clean 8.1/7.0-defaults variant with a separate defaults-adoption variant; a single passing run is not evidence for both.

## Remaining questions / release decision

- No runtime compatibility or production-readiness conclusion is established by successful resolution. The concrete source blockers above must be addressed and executed checks completed before deployment.
- Is rollback required all the way to 7.0, or only to a prepared 7.1+ bridge? This determines which signature and job formats may be written.
- What data/queues actually exist outside this sample, how old are attachment signatures, and are web/workers rolled simultaneously? These materially change rollout timing, not the identified code fixes.
- Should the reminder preview retain the old fixed-offset presentation, or intentionally show the reader's correct post-DST local time? The absolute 24-hour scheduling contract should stay unchanged either way.
- The target is exactly 8.1.0 as requested. A production release should separately assess current maintenance/security patch suitability; no current vulnerability audit or newer-patch recommendation is claimed here.
- Existing public Active Storage URLs, upload-abuse exposure, mail delivery gaps and orphan-file cleanup are documented application limitations, not fixes silently included in this Rails upgrade.

The application remains unmodified and unupgraded. Only this assessment and dependency-resolution evidence were produced; nothing was committed, pushed or deployed.