# Margin Notes: Rails 7.0.8.7 → 8.1.0 assessment

## Recommendation

Proceed as a staged compatibility upgrade, not a gem-only change. Keep `config.load_defaults 7.0` initially. Ruby 3.3.6 already meets Rails 8.1.0's Ruby ≥3.2 requirement. Dependency resolution succeeds without changing Sidekiq, Redis, Puma, Faraday, Pagy, or the asset pipeline. The unchanged app is nevertheless incompatible with the target. Do not deploy it until the required fixes and queue compatibility gates below are satisfied.

No working application files were changed. No application database, Redis, cache, storage, provider, or mail delivery was accessed. Application tests, application boot, migrations, browser behavior, and production configuration were NOT executed. Findings below distinguish source inspection (S), executed isolated framework probes (E), and proposed application validation (V).

## Required compatibility and behavior work

### 1. Model declarations and store-backed highlight (S, E for declarations)

Affected: `app/models/note.rb`: keyword-form `enum`, positional `serialize :tags, JSON`, `store_accessor :settings, :color`, `alias_attribute :highlight_color, :color`.

* Rails 8 removes keyword-style enum definitions. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. This modern form already works in 7.0; the other enums already use it.
* Rails 7.2 removes positional coders. At the 7.1 stage use `serialize :tags, coder: JSON`. Do NOT make this a 7.0 preparatory patch: 7.0's implementation takes the coder positionally and can silently keep YAML when given `coder:` as an option. Keep JSON data JSON; do not rewrite existing tags to YAML.
* Rails 7.2 requires alias targets to be real attributes and bypasses custom accessors. `color` is an accessor into jsonb `settings`, not a database attribute. Replace the alias with explicit `highlight_color` and `highlight_color=` methods delegating to `color`/`color=` (or the existing delegation pattern). This works on 7.0 and preserves validation through `color`. Do not add a new column.

V: save/reload a green highlight while retaining an unrelated settings key, edit to blue, reject an invalid color, and check form selection. Load old JSON tags including empty arrays, edit and read them with both versions. Existing note request tests cover much of this, but add persisted format/readback checks rather than trusting declaration success.

Upstream: [7.2 removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [8.0 removals](https://guides.rubyonrails.org/v8.0.0/8_0_release_notes.html), [7.2 alias upgrade guidance](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#alias-attribute-now-bypasses-custom-methods-on-the-original-attribute), [7.0 serialization implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb).

### 2. Action Text initializer fails; preserve the inherited allowlist (S, E)

Affected: `config/initializers/action_text.rb`, rich bodies imported/edited/rendered, attachment markup.

`ActionText::ContentHelper.allowed_tags` is nil on 8.1; the framework resolves its default allowlist at use time. `allowed_tags += ...` raises NoMethodError. Build the override from the effective inherited tags (the helper's `sanitizer_allowed_tags`), then add `details` and `summary`, at a lifecycle point after the chosen sanitizer is configured. Preserve `action-text-attachment`, `figure`, and `figcaption`, not just the sanitizer's base tags. Resolve lifecycle/reloading in the isolated app rather than assuming an initializer ordering. The effective-default approach is available on 7.0 too; verify reloading and both sanitizer vendors.

V: boot eagerly and lazily; render stored details/summary with links and attachments, strip scripts/event handlers and unsafe URLs, and retain safe attachment markup. Check repeated reloads. Existing body/attachment tests do not prove the custom collapsible-excerpt behavior survives.

Upstream: [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb), [7.0 helper](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/app/helpers/action_text/content_helper.rb), [8.1 engine sanitizer initialization](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/engine.rb).

### 3. Citation provider configuration and retries (S)

Affected: `app/models/citation/provider.rb`, `config/secrets.yml`, `app/jobs/citation_enrichment_job.rb`, provider configuration subprocess test in `test/controllers/citation_enrichments_controller_test.rb`.

* `Rails.application.secrets` was removed in 7.2. Move this environment-backed configuration to `config.x.citation_provider` or read the existing environment variables at this boundary, preserving environment-specific development defaults, symbolized keys, and configuration for BOTH web and workers. This preparation can run on 7.0. Do not accidentally change authentication or print credentials. Check whether real deployments separately source `secret_key_base` from secrets; keep the production signing key stable.
* `retry_on wait: :exponentially_longer` is removed in 7.2. Rename to `:polynomially_longer` at the 7.1 stage; it names the same polynomial schedule, not a newly exponential one. The new symbol is NOT a 7.0-compatible preparatory change. Retain three attempts and the exhausted handler; retain Faraday's one 503 retry and six-request maximum. No Faraday upgrade is required by this Rails upgrade.

V: fresh processes with environment overrides; Basic Auth and URL path; 503 followed by success; persistent 503 leads to exactly three job attempts/six HTTP requests and failed status; 404 fails once. Run with the real selected adapter for retry scheduling as well as the test adapter. Existing tests are useful but were not run here.

Upstream: [7.2 removal list](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [8.1 retry implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/exceptions.rb).

### 4. Reminder scheduling requires a time object (S, E)

Affected: `Note#schedule_reminder` uses `NoteReminderJob.set(wait_until: reminder_epoch)`; imported times and reminder rescheduling/postponing use the same path.

Numeric scheduled times are unsupported from 7.2. Target job serialization calls `.utc` on the scheduled time and fails on Integer. Convert with `Time.at(reminder_epoch)` after existing validation; store the epoch column unchanged. This works on 7.0. Do not confuse seconds with milliseconds or change existing scheduled Sidekiq scores.

V: schedule the asymmetric epoch 1,793,451,617 and inspect Redis scheduled score, job ID, and deserialized argument; also schedule a past epoch, replace a reminder, execute old and new job IDs, and simulate refused enqueue while retaining the old ID/time. Tests with the test adapter alone do not establish Redis payload behavior.

Upstream: [7.2 removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [8.1 job serialization/set](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).

### 5. Failed CSV import can commit earlier rows (S; database reproduction still proposed)

Affected: `Import#apply`, `app/models/import.rb`: `return false unless row.note.save` exits the transaction nonlocally. Rails 7.0 rolls back that path; from 7.2 the transaction commits. A valid first row and invalid second row can leave an Import, Note, Citation, and rich text even though the request reports failure. This is not protected by retaining 7.0 defaults on 8.1.

Use an explicit `ActiveRecord::Rollback` when a row cannot save and return a separately recorded success/failure result. Preserve the invalid row's errors for rendering. This works on 7.0; do not merely replace `return` with `break` (same changed semantics), nor add preview-only validation and assume it makes the transaction safe.

V: direct POST of a valid first row followed by an invalid second row; assert error output and zero changes to imports, notes, citations, and rich texts. Run outside an encompassing test transaction as well. The existing invalid-row request test is valuable but not an executed result here. Also simulate a later row failure after earlier writes, rather than only an entirely invalid CSV.

Upstream: [7.1 transition](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2 removal of rollback on nonlocal exit](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html).

### 6. CSV receipt silently loses DOI; preview silently loses annotations (S, E for hash behavior)

Affected: `Import#receipt` uses `citation[:id]` despite DOI being the primary key (`db/migrate/20261011160000_create_imports_and_citations.rb`); `app/views/imports/preview.html.erb` stringifies a HashWithIndifferentAccess keyed by integer source lines, then indexes with integers.

* Rails 7.2 no longer redirects `read_attribute(:id)` to a custom primary key. Use `citation.doi` (or `citation.id`), not `citation[:id]`. Compatible with 7.0. Preserve DOI case and trimming rules.
* Target `stringify_keys` actually stringifies integer keys; in 7.0 the indifferent hash implementation just duplicated them. Remove the unnecessary stringification and retain integer indexing, or consistently use string keys. Compatible with 7.0. No stored annotation migration is necessary.

V: receipt with one DOI shared by two notes and a blank DOI; preview two distinct annotations on source lines 2 and 4 separated by a blank line/multiline CSV body, with literal HTML escaping. Existing import tests include distinguishing examples and should catch these after boot blockers are removed.

Upstream: [7.2 primary-key removal](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [7.0 indifferent hash](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/hash_with_indifferent_access.rb), [8.1 indifferent hash](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/hash_with_indifferent_access.rb).

### 7. Markdown exports fail string summation (S, E)

Affected: `Export#generate` calls `finish(fragments.sum)`. Rails 7.1 removes the nonnumeric Enumerable sum override; Ruby's default 0 cannot be added to strings. Use `fragments.join` (works on 7.0). No blob/file format migration is needed; preserve exact Markdown order/newlines. Native `ExportJob` is not an Active Job and must be exercised separately.

V: export zero and multiple notes with different titles/bodies and an overridden heading; download and compare exact bytes, order and filename; cancellation during generation; retry a failure. Existing export model/request tests provide coverage, not evidence of an executed target run.

Upstream: [7.1 removal](https://guides.rubyonrails.org/v7.1.0/7_1_release_notes.html).

### 8. Digest day changes and decimal queue format changes (S, E)

Affected: `User#request_digest`, `DigestJob#perform`, `DigestMailer#daily_digest`, Redis keys `digest_requests:YYYY-MM-DD`.

Rails 8.1 TimeWithZone serialization preserves the named zone, unlike 7.0's worker-zone reconstruction. The app reserves a UTC day but the mailer uses `requested_at.to_date`/`all_day`. For an Eastern request at 2026-10-04 23:30 (2026-10-05 03:30 UTC), target jobs select October 4's LOCAL day while the reservation is October 5 UTC. This is unconditional serializer behavior, not controlled by `load_defaults`.

Preserve the documented UTC-day contract: normalize `requested_at` to UTC in the mailer before deriving date/range; preferably also pass UTC from the producer. Both changes work on 7.0, and consumer normalization handles already-queued jobs. Do not merely change expected test dates or switch the reservation to local dates without a separate product decision.

Rails 7.2+ always uses BigDecimalSerializer; 7.0 treats BigDecimal as primitive, which JSON turns into a string. Target reads old strings successfully and `DigestMailer` already parses them. Old workers have no BigDecimalSerializer and cannot read new envelopes. Prepare the producer to pass `reading_completion.to_s("F")` (7.0-compatible; mailer already accepts strings), and keep it through the rollback window. Do not use Float for the percentage. Alternatively perform a coordinated nonoverlapping worker cutover with no rollback consumption of new envelopes. Do not flush the reservation sets: that allows duplicate digests.

V: JSON roundtrip, not just Active Job's test adapter, for all four producer/consumer version pairings. Check a 0.6667 completion and contrasting notes updated on each side of UTC and local midnight. Assert UTC subject day, membership, 66.67% formatting as appropriate to the template, and reservation deduplication. Repeat using old queued payloads and target-created payloads after rollback. Existing digest test covers UTC midnight but the ordinary test adapter misses the old decimal JSON conversion.

Upstream: [8.1 TimeWithZone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [7.0 serializer registry](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/serializers.rb), [8.1 decimal serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

### 9. Test exception mode must move to symbols (S)

Affected: `config/environments/test.rb` sets `config.action_dispatch.show_exceptions = false`; many request tests assert raised RecordNotFound. Rails 7.2 removes boolean support. At the 7.1 stage use `:none` to preserve those tests. This is NOT a safe 7.0 prep: 7.0 treats a nonfalse symbol as enabling exception rendering. Check tests that temporarily override the mode too. Test a foreign record and a genuine application exception, not just a successful response.

Upstream: [upgrade guide exception modes](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), [7.2 removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html).

## Optional new-default adoption: separate deployments

These are not grounds to claim the gem-only upgrade requires every new default.

| Default / affected code | Condition, recommendation and discriminating validation | Current-version preparation |
|---|---|---|
| YAML notebook preferences | `Notebook.serialize :preferences` works with retained 7.0 defaults; 7.1 defaults set `default_column_serializer = nil`, causing missing coder. Before adopting, specify `coder: YAML` at ≥7.1. Keep stored YAML; switching to JSON would require a separate dual-reader/data migration. Inventory representative old nil/empty/hash values and permitted classes, then read/write/read across rollback. | Do not use the new keyword interface as a general 7.0 coder migration. Existing implicit YAML can stay until 7.1. |
| Readonly slug | 7.1 defaults raise on assigning a persisted readonly attribute. Notebook form resubmits `slug`; controller permits it, including tampering. Remove slug from update parameters (creation already derives it) before enabling. Check unchanged hidden slug, forged slug, and successful name/heading changes with persisted slug unchanged. | Parameter restriction works on 7.0. |
| PostgreSQL dates | 7.2 defaults enable `postgresql_adapter_decode_dates`. `Notebook#daily_note_counts` currently applies Date.iso8601 to a raw string; decoded Date will fail. Retained 7.0 defaults do NOT enable it. Use a typed query (e.g. grouped count) or accept Date and parse strings only. Verify identical UTC counts on two dates, including near midnight, with flag off/on and a real pg connection. | A Date/string-compatible result conversion works on 7.0. New flag isn't a 7.0 feature. |
| Cache expiry validation | 7.1 defaults raise for invalid expiration. `_export.html.erb` passes `export.expires_at - Time.current` even for expired exports. Skip availability fragment caching for expired records; cache only future deadlines. Enable actual caching and test before, exactly at, and after expiry, including another reader and download denial. Current tests disable caching. | Conditional caching works on 7.0. |
| Cache/message formats | 7.1 defaults change cache format, message serializer and metadata envelope. Keep cache format 7.0 and old message format through mixed 7.0 workers/web and rollback window. New readers accepting old data is not proof old readers accept new. For later adoption namespace disposable fragment cache or cold-start it; do not delete storage/queued work. Test cookie, signed blob ID, Action Text SGID, service URL and fragment values both directions, with same secret and salts. | Delay new config until supported; no 7.0 API additions necessary. |
| HTML5 sanitizer | 7.1 defaults choose best-supported vendor (HTML5 on this MRI/Nokogiri environment). Compare rendering malformed old/imported HTML, details/summary, links, tables and attachments with HTML4/HTML5. Preserve allowlist extension; rendering differences need not imply a DB rewrite. | Keep HTML4 during compatibility phase; vendor switch requires ≥7.1 configuration. |
| Conditional downloads | 8.0 defaults enable strict_freshness, giving If-None-Match precedence over If-Modified-Since. `ExportDownloadsController#show` sends both validators via stale?. Test matching/nonmatching ETag with conflicting timestamp; verify owner/expiry checks still occur before 304 and Cache-Control stays private/must-revalidate. | No change needed for retained defaults; tests can be prepared on 7.0 with version-appropriate expectations. |

Rails 8.1 `TimeWithZone#to_time` now retains the named zone, not merely a fixed UTC offset. `Note#next_day_reminder_at` adds 86,400 elapsed seconds: the instant remains the same, but its DST preview changes to the correct next-day offset/wall time. This is independent of new defaults and generally desirable. Keep elapsed-time postponement, update the misleading comments/docs, and explicitly validate Eastern 2026-03-07 09:00 → March 8 10:00 (and fall-back 09:00 → 08:00), both +86,400 seconds. If presentation must be identical across mixed web nodes, use `reminder_at + 86_400` to preserve zone behavior already on 7.0; do not accidentally change to calendar `1.day` arithmetic. The current probe explicitly sets the app's 7.0 `to_time_preserves_timezone = true`; otherwise a bare Active Support process would misleadingly use system UTC.

8.1 alphabetizes schema dump columns. Review schema churn separately; it does not require a destructive DB migration. Newly generated Rails 8 apps use different infrastructure, but this application need not adopt Propshaft, Solid Queue/Cache/Cable, Kamal, or the new authentication generator. Preserve Sprockets/importmap and current explicit job/storage settings initially.

Upstream defaults source: [8.1 load_defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb); [PostgreSQL change](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md); [TimeWithZone conversion](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

## Queue, transaction, browser and deployment gates

1. **Keep existing enqueue semantics initially.** `Citation#request_enrichment` and `Note#schedule_reminder` enqueue under row locks and rely on a raised enqueue error rolling back state. 8.1's `enqueue_after_transaction_commit` defaults to false; do not infer a forced target change from the 7.2 release note. If enabling it later, Redis failure occurs after commit and these invariants require redesign (persisted enqueue intent/outbox or explicit recovery). The property doesn't exist on 7.0; don't add it unguarded there. Test refused enqueue at a real commit boundary and a separate worker process, not only fixture/test transactions. Native `Notebook#request_export`/`ExportJob` do not use this Active Job setting. [8.1 enqueuing source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb).
2. **Do not mandate Sidekiq upgrade as a Rails dependency fix.** Resolution retained Rails 8.1.0, Sidekiq 6.5.12, redis 4.8.1, Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, Puma 5.6.9. Rails 8.1 still has its Sidekiq adapter but deprecates it for removal in 8.2, recommending Sidekiq ≥7.3.3. Dependency resolution is not runtime support proof. If upgrading Sidekiq separately, audit Redis server requirements, redis-client API/exceptions and `sadd` return semantics, strict JSON arguments in native ExportJob (`{format: ...}` currently symbol keys), and adapter wrapper compatibility. Do not expand this Rails upgrade by silently doing all of that. [8.1 adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).
3. **Stored queues include scheduled/retry/dead sets.** Draining only the default ready queue does not establish safety. Inventory all job classes, wrapper class names, execution/retry metadata and times, GlobalIDs and payload serializers. Preserve NoteReminderJob's job IDs and reminder_job_id links, exports' IDs and blob references. Test scheduled reminders and citation retries created before upgrade with target workers, and target payloads with rollback workers. Do not mass-requeue reminders with new IDs or delete queues to ease upgrade. Keep class names stable; account for framework Active Storage jobs as well as app jobs.
4. **Browser integration is unverified.** Layout loads vendored Trix 1.3.5 as a classic script; Action Text JS and `require trix` CSS will come from the upgraded gem. Do not assume this old editor/new integration/new CSS pairing works, nor that importmap pins update the vendored editor. Asset-precompile and drive edit/save/reopen of links and attachments, direct-upload rejection, galleries and details/summary. Compare browser-submitted HTML against stored bodies. Trix already flattens details on editor save; distinguish that existing behavior from upgrade regressions. Choose a matched supported editor/integration/CSS set in a separate reviewed change if necessary, preserving old stored content and old clients/assets during rollout. No browser compatibility claim was verified here.
5. **Signing/storage continuity.** Keep production secret_key_base and credentials access stable, preserve Disk storage and DB rows, retain old digested assets during rolling deployment. Development/test secret file moves from tmp/development_secret.txt to tmp/local_secret.txt in 7.1; copy the existing key rather than rotate it inadvertently if existing signed attachments/sessions must remain usable. No keys were inspected. Test pre-upgrade sessions and signed attachments against target and vice versa; DB fixture tests with freshly signed tokens cannot establish this. Existing public Active Storage URLs/direct uploads and lack of cleanup are known app policies, not newly introduced upgrade failures.
6. **Runtime and production smoke gates.** Keep Ruby fixed while upgrading Rails. Run eager-load/zeitwerk, production asset precompile and boot under both stdout/file logger branches; the upgrade guide notes Rails.logger becomes BroadcastLogger but no app-specific logger extension was found. Verify sign-in/CSRF/Turbo, filtered pagination, imports, settings, activity, export cache/download and real job/mail execution. Production mail delivery/host are not configured in this sample; supply isolated file/test mail delivery for verification, never infer real email delivery from a green suite. No custom AR encryption, ActiveStorage::BaseController subclass, RedisCacheStore/MemCacheStore, SQLite usage, UJS, or manual app-class requires were found to make those guide sections migration requirements.

## Execution sequence and rollback

1. On 7.0, land only compatible preparation: modern enum; explicit highlight accessors; preserved effective Action Text tags; provider config replacement; Time.at scheduling; explicit import rollback; DOI reader; integer annotation keys; fragments.join; UTC digest consumer/producer and decimal-string arguments; readonly parameter restriction and safe expired-cache handling. Add/extend public contract tests and validate them on 7.0. No data format conversion needed.
2. Move in disposable environments through latest appropriate patches of 7.1, 7.2, 8.0, then requested 8.1.0, resolving and retaining a lockfile for every stage. At 7.1 switch serialized tags to coder: JSON, explicitly preserve YAML preferences, use polynomially_longer and show_exceptions :none. Review app:update diffs manually; do not overwrite app configuration or enable all defaults. Capture deprecations in development/test/staging (production explicitly disables reporting).
3. Provision genuinely isolated PostgreSQL DB/role, Redis process or private DB with no existing data (including cable), per-copy Disk storage, cache root and mail output for app checks. Set test worker count to one initially to simplify attribution; parallel workers require separately named disposable DBs. Tests write real Redis reservations. Never run db:prepare/test against the shared source checkout's default databases. Run baseline and each variant's bundle check, zeitwerk:check, unit/request suite, browser suite, and extra cross-version/real-worker probes above. Existing browser directory contains no actual feature system tests, so `test:system` alone is not adequate browser coverage.
4. Deploy compatible producers/consumers first, validate old→new and new→old payloads, then target framework with 7.0 defaults. Pause producers/quiet workers if the measured payload compatibility requires a coordinated boundary; scheduled/retry/dead work must still have an explicit owner. Keep old deployment, DB/schema, blobs and assets rollback-capable. Decimal strings and UTC normalization should remain on rollback as well. Mixed-version DB readers/writers must preserve JSON tags and YAML preferences.
5. Adopt defaults individually only after fleet convergence and rollback compatibility testing. Cache namespaces can be changed/discarded, but durable preferences, rich text, attachments, reminders and reservations cannot. For a rollback after changing message formats, use tested compatible readers/rotations or postpone the format change; “the new version reads old tokens” is insufficient. No destructive schema changes are indicated by this assessment. Choose patch/security policy separately: evaluation here targets exactly 8.1.0, not a claim it is the preferred current security patch.

## Evidence and remaining work

Executed on Ruby 3.3.6 / Bundler 2.5.22:

* Target dependency-only resolution: `BUNDLE_GEMFILE=.amp/in/rails-upgrade/resolution/Gemfile bundle lock --update rails`. Success; complete resolved dependencies are in `../rails-upgrade/resolution/Gemfile.lock`; command/output in `../rails-upgrade/resolution/output.log`. Application lockfile was untouched.
* Installed target bundle into `../rails-upgrade/bundle`, using the disposable tracked checkout under `../rails-upgrade/disposable`; output in `../rails-upgrade/install.log`.
* Framework-only source-pattern probes with both exact bundles (no Rails application boot). Retained scripts: `../rails-upgrade/current/probe.rb` and `../rails-upgrade/disposable/probe.rb`; output: `../rails-upgrade/current-probe.log` and `../rails-upgrade/disposable-probe.log`. Final commands/configuration and attribution are in `../rails-upgrade/evidence.txt`. Deliberately invalid DB/Redis endpoints; no service clients used; no application cache/storage/mail initialized.
* Target probes reproduce enum/serialize argument errors, nil Action Text allowlist, string sum TypeError, missing preview annotation, integer scheduled-time `.utc` error, preserved digest local date/BigDecimal envelope, and DST named-zone conversion. Baseline shows the contrasting current behavior. They are framework probes of actual application expressions, NOT app-level regression tests.
* First probe attempts failed because a standalone gem require did not include its app/helpers path; fixed the probe to require the helper from its resolved gem directory. Initial failed output remains in `../rails-upgrade/target-probe.log`; use the final variant logs above. Release-note download initially used dotted filenames (404); corrected to upstream underscore filenames; no inference used failed fetches.

Versioned release notes and source snapshots are retained in `../rails-upgrade/sources/`. Main guidance: [versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), and versioned 7.1/7.2/8.0/8.1 release notes. Sources were compared against actual app/config/test code, not just architecture documentation.

Not yet verified: app boot after compatible fixes; full dependency runtime compatibility; transaction commit reproduction in PostgreSQL; all cross-version queued envelopes (including framework jobs); signed-token two-way compatibility; old stored YAML classes and malformed HTML inventory; deployed Redis/PostgreSQL/server topology; actual production signing-key source; browser editor interoperability; application suite and production asset/logger smoke checks. These are explicit rollout gates, not assumed successes. No runtime production data was inspected and no actual upgrade was implemented.
