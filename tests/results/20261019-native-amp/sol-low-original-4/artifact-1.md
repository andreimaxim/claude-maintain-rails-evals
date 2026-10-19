# Margin Notes: Rails 7.0.8.7 → 8.1.0 assessment

## Decision and evidence boundary

Proceed as a staged compatibility migration, not a Gemfile-only bump. Keep `config.load_defaults 7.0` initially. There are required API changes and behavior changes independent of that setting. Adopt newer defaults separately.

This is a **source-based assessment**, not a verified target build. I read the application, configuration, lockfile, schema, migrations, and relevant tests, and compared exact Rails tags 7.0.8.7, 7.1.0, 7.2.0, 8.0.0, and 8.1.0. No application boot, bundle resolution, database command, tests, queue writes, or browser experiment was run. No working application files were modified. The only repository-local metadata change was adding `/.amp/in/` to `.git/info/exclude` for this report. No target dependency set has been resolved. Upstream source snapshots are retained alongside this report in `upstream-sources/`; missing files from a tag were HTTP 404s, not runtime failures.

Runtime: Ruby 3.3.6 already meets Rails 8.1's >=3.2 requirement. Current lock: Rails 7.0.8.7, Rack 2.2.24, Puma 5.6.9, Sidekiq 6.5.12, redis-rb 4.8.1, pg 1.6.0, Pagy 8.6.3, Faraday 1.10.4. Rails defaults are 7.0; jobs use Sidekiq except in tests. PostgreSQL, Disk storage, cookie sessions, Action Text, and native Sidekiq export jobs are real application contracts.

## Required changes (including with Rails 7.0 defaults retained)

### 1. Action Text initializer no longer has a concrete default allowlist

- **Code:** `config/initializers/action_text.rb`: `ActionText::ContentHelper.allowed_tags += ...`.
- **Change:** 7.0's getter returns the default list; 8.1's getter defaults to nil and rendering computes its fallback separately. The existing initializer would call `nil + Array` and fail initialization. Independent of HTML4/HTML5 default selection.
- **Recommendation:** Build the full safe list from the selected sanitizer's allowed tags, plus `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details`, and `summary`, at the correct initialization point. Preserve all attachment attributes through the existing fallback; do not replace the allowlist with only the two custom tags. Check engine initialization order before selecting a sanitizer vendor.
- **Current-compatible preparation:** Yes, explicit construction using the current sanitizer's default tags and attachment tags works on 7.0; avoid relying on newer private helper names.
- **Validation:** Eager-load in development, test, and production-like mode. Render existing details/summary, links, an attached image, and hostile HTML; preserve safe structure and attachments while removing scripts and event attributes. Browser edit/save is separate: the existing Trix 1.3.5 workaround does not guarantee compatibility with Action Text 8.1. Test opening stored links/attachments, direct upload, submit, reload, export-to-plain-text, and no-op edits. Do not blindly replace Trix or assume the existing details-flattening limitation is newly caused by Rails. Retain original stored rich-text samples for rollback comparison.

### 2. Removed Active Record declaration APIs

- **Code:** `app/models/note.rb`: keyword-style enum, positional JSON coder, `alias_attribute :highlight_color, :color`.
- **Change:** Rails 8 removes keyword-style enums; Rails 7.2 removes positional coders and aliasing non-column attributes. `color` is a store accessor inside jsonb `settings`, not a database column, so this is not merely an alias that needs a custom-reader tweak.
- **Recommendation:** Use `enum :status, { draft: 0, ready: 1 }, prefix: true`; use `serialize :tags, coder: JSON` after moving to 7.1; replace `highlight_color` getter/setter with explicit forwarding to `color`/`color=`. Preserve integer enum values and JSON text format.
- **Current-compatible preparation:** Enum form and forwarding methods: yes. `coder: JSON`: **not** a safe 7.0 preparation—7.0's implementation chooses the positional argument and would keep YAML coding when only this keyword is supplied. Make this syntax change on the 7.1 rung, not before. No tags data migration is needed if the coder stays JSON.
- **Validation:** Load existing raw JSON tags, edit tags, reload, and verify persisted text remains JSON; cover `[]` and nonempty tags. Submit highlight colors through the note form and verify `settings['color']` after reload, including invalid-color rejection. Verify draft/ready queries and scopes keep the same integer mapping. `Citation` and `Export` already use positional enums and do not need equivalent rewrites.

### 3. Citation configuration and retry API removal

- **Code:** `app/models/citation/provider.rb` reads `Rails.application.secrets.citation_provider`; `config/secrets.yml` supplies environment-backed settings. `app/jobs/citation_enrichment_job.rb` uses `wait: :exponentially_longer`.
- **Change:** Both APIs are removed in 7.2. The retry error occurs on an unavailable provider, so a happy-path smoke test is insufficient.
- **Recommendation:** Move provider configuration to application-owned configuration, reading the same environment variables and preserving development defaults and missing-production-configuration behavior; update the constructor default and config test. Use `:polynomially_longer` on 7.1+, retaining three attempts, jitter, and exhaustion handling. This is a rename of the existing fourth-power algorithm, not a reason to change retry policy.
- **Current-compatible preparation:** Environment-backed application config: yes. New wait symbol: no on 7.0; apply on 7.1, or use a carefully validated equivalent callable if a single pre-upgrade implementation is necessary.
- **Validation:** Fresh-process environment test for web and worker, valid/missing credentials, permanent 404, 503 then success, sustained 503, 429, and timeout. Verify exhaustion records failure rather than handing the error to Sidekiq retries; sustained 503 should still make at most six provider requests across three job attempts. Test an already-retried job payload on the upgraded worker.

### 4. Imports can commit partial batches

- **Code:** `Import#apply` (`app/models/import.rb`) does `return false unless row.note.save` inside `transaction` after saving the import and previous rows.
- **Change:** 7.0 rolls back this non-local return after writes. In 7.2+ it commits; 8.0 removes the transitional configuration switch. Keeping 7.0 defaults does not protect 8.1.
- **Recommendation:** Use explicit rollback or exception-based control flow and return false outside the transaction while retaining row errors for rendering. Ensure the failure result cannot fall through to the method's final `true`. Do not just replace `return` with `break`, which is also a non-local-exit trap.
- **Current-compatible preparation:** Yes; explicit `ActiveRecord::Rollback` with an explicit success result works on 7.0 and 8.1.
- **Validation:** Valid first row creating a new citation and rich text; invalid second row. Both POST and direct domain operation must return failure with zero new imports, notes, citations, or rich texts. The existing invalid-row request test is valuable and should catch this change; inspect durable results outside an encompassing test transaction too. Restore atomicity before allowing target writers; rollback of code cannot undo partial batches already committed.

### 5. Custom primary key reads change receipt data

- **Code:** `Import#receipt` reads `citation[:id]`; schema uses `citations.doi` as the primary key and has no `id` column.
- **Change:** 7.2 removes the legacy `read_attribute(:id)` fallback to a custom primary key. CSV DOI cells would no longer contain the DOI (rather than this being a schema issue).
- **Recommendation:** Read `citation.doi` explicitly.
- **Current-compatible preparation:** Yes; no stored-data conversion.
- **Validation:** Import two rows sharing a mixed-case DOI and one without a DOI, download the CSV, and assert exact DOI cells and a blank uncited cell. Existing receipt coverage already distinguishes the cited case; keep that contract, not legacy attribute access.

### 6. String aggregation loses Rails' special sum behavior

- **Code:** `Export#generate` calls `finish(fragments.sum)` for an array of Markdown strings.
- **Change:** Rails 7.1 removes the deprecated Enumerable sum override. Ruby's default numeric identity makes String aggregation fail.
- **Recommendation:** `fragments.join`, preserving order and exact bytes.
- **Current-compatible preparation:** Yes.
- **Validation:** Run the native `ExportJob` through its JSON argument boundary, not just Active Job helpers. Zero-note and two-note exports must complete, attach a readable file, preserve order/newlines and Unicode, and remain downloadable. Preserve cancellation and retry behavior and verify checksum/conditional download. A failed export can leave working status and unattached blobs, so monitor these during trial runs; do not add unrelated cleanup as part of the upgrade.

### 7. Import preview annotations disappear after key stringification

- **Code:** `Import#annotations` builds a HashWithIndifferentAccess keyed by integer source line; `app/views/imports/preview.html.erb` calls `stringify_keys` then looks up `annotations[row.line]` using that integer.
- **Change:** 7.0 HashWithIndifferentAccess overrides stringify_keys as duplication; 8.1 inherits real key stringification. Integer 2 becomes string '2'; indifferent access only unifies symbols and strings, not integers.
- **Recommendation:** Keep the line-keyed map without stringification, or consistently produce and read string keys. No reason to alter persisted plain-text annotations.
- **Current-compatible preparation:** Yes, removing unnecessary stringification preserves the current integer-keyed contract.
- **Validation:** Preview a quoted multiline CSV and a blank line with distinct annotations on source lines 2 and 4. Assert each annotation appears next to its correct title and HTML is displayed literally. Existing preview assertions are discriminating; stored annotations and note pages must remain unchanged.

### 8. Exception-test configuration

- **Code:** `config/environments/test.rb`: `show_exceptions = false`.
- **Change:** Boolean support removed in 7.2.
- **Recommendation:** Set `:none` on 7.1+ to continue raising; use `:rescuable` only where production error responses are intentionally exercised. Audit test-local assignments before running the suite.
- **Current-compatible preparation:** No; don't substitute a truthy symbol into 7.0's boolean behavior.
- **Validation:** Unauthorized owned-record lookup raises in normal integration tests; a production-mode check returns 404, not 500. Keep the test adapter explicitly configured—it already addresses 7.2's test adapter consistency change.

## Required semantic decisions and mixed-version job risks

### 9. Digest day and decimal wire format

- **Code:** `User#request_digest` queues a zoned time and BigDecimal; `DigestJob#perform` forwards them; `DigestMailer#daily_digest` derives date and `all_day` from the received time. Reservation is explicitly UTC-day based.
- **Time change:** 7.0 discards the named time zone on deserialization. 8.1 emits `time_zone` and restores it. New jobs can select the reader's local day while still reserving the UTC day. Old jobs without the field use the worker zone. This happens independently of load_defaults.
- **Recommendation:** Preserve the documented UTC-day contract by normalizing to UTC at the mailer/consumer boundary, and preferably enqueue UTC context explicitly. Do not silently adopt local-day digests; that would also require redesigning the reservation key and its expiry semantics.
- **Decimal change:** 8.1 writes a tagged `ActiveJob::Serializers::BigDecimalSerializer` object; 7.0's JSON queue round trip produces a string and has no matching new serializer. New-worker consumption of legacy strings is distinct from old-worker consumption of new tagged arguments. Keeping 7.0 defaults does not keep the legacy decimal writer in 8.1.
- **Recommendation:** For a safe rollback window, explicitly enqueue `reading_completion.to_s('F')` as a string and keep consumer conversion via `BigDecimal`. Normalize the consumer first so existing/new zoned payloads produce the same UTC digest. Both preparatory changes work on 7.0. This avoids adding a compatibility serializer to old workers.
- **Validation:** At 2026-10-05 03:30 UTC, with New York local time still October 4, distinguish notes updated on each UTC date; assert October 5 subject/content and matching reservation key. Use a nontrivial decimal such as 2/3, not only 0 or 1. Cross JSON round trips in four directions: old→old, old→new, new→new, new→old. Existing digest test already covers the midnight day split, but the test adapter does not reproduce Sidekiq's JSON conversion. Verify a real isolated Redis job is executed and mail is captured locally. Do not reset reservation sets during deploy; doing so allows duplicate requests.
- **Rollout:** Deploy the neutral string payload and UTC consumer on 7.0 before introducing target producers. If target jobs were already emitted, inventory immediate, scheduled, retry, and dead sets before rollback. Old consumers must not receive unknown serializers; drain/quarantine incompatible jobs for compatible workers, without blindly deleting jobs or re-enqueueing emails. The two-day reservation TTL is not a queue-drain horizon. Native `ExportJob` has a separate JSON envelope and must retain its class name and string option-key contract.

### 10. Reminder timezone semantics change in 8.1 itself

- **Code:** `Note#next_day_reminder_at`: `reminder_at.to_time + 86_400`; note reminder preview renders that time, while postponing persists its epoch.
- **Change:** 8.1 `TimeWithZone#to_time` always retains the named zone, not just a fixed offset. Across DST the result's displayed offset/wall time can now follow the zone. The persisted +24 elapsed-hour instant stays the same, but the preview differs from the architecture's explicitly documented fixed-offset behavior. This is not an optional load_defaults change in 8.1.
- **Recommendation:** Prefer coherent zone-aware preview matching the scheduled reminder; document this small user-visible change. If fixed-offset display is contractual, construct a fixed-offset Time explicitly before addition. Do not change to `1.day` unless a calendar-day policy is intended.
- **Current-compatible preparation:** Explicit UTC-instant arithmetic followed by `in_time_zone(reader_zone)` works on 7.0 for the zone-aware policy; explicit numeric-offset conversion works on 7.0 for the fixed-offset policy.
- **Validation:** Both sides of New York's spring and fall DST changes; assert epoch delta is exactly 86,400, preview ISO offset, scheduled display, and stale earlier jobs send nothing. Include imported epochs and newly entered local times. Numeric `wait_until:` is used here, not direct assignment to the removed numeric `scheduled_at` API; do not label it a confirmed removal without testing the actual set(wait_until:) path.

## Optional default adoption—separate deployments

1. **Notebook preferences:** `Notebook` has bare `serialize :preferences`. Works with retained 7.0 defaults, but >=7.1 defaults set `default_column_serializer = nil`, so declare `coder: YAML` before enabling them. Preserve existing YAML and null behavior; do not switch to JSON without a dual-reader migration. The explicit coder keyword belongs on 7.1+, not a 7.0 preparatory deploy. Validate a historical YAML export heading, nil preferences, edit/reload, and old/new readers both ways. Stored preferences were not inspected in a live database; unusual YAML classes remain an inventory question.
2. **Read-only slug:** >=7.1 defaults raise on assignment to readonly attributes. Notebook settings permit and resubmit `slug`, including unchanged values; assignment itself can raise. Stop permitting/updating it before adopting that default (current-compatible), retaining model immutability. Test an ordinary unchanged hidden slug and a tampered slug: the name/heading update succeeds and slug stays fixed. New notebook slug derivation must still work.
3. **Raw PostgreSQL dates:** >=7.2 defaults enable date decoding. `Notebook#daily_note_counts` then receives Date objects where it currently calls `Date.iso8601(day)` on text. Accept Date or parse text (current-compatible) before enabling the default, or deliberately retain `postgresql_adapter_decode_dates = false`. Validate two UTC dates with unequal counts and a midnight boundary against a real PostgreSQL connection. Current activity report test should be rerun under both settings.
4. **HTML5 sanitizer:** >=7.1 defaults select the best supported sanitizer. This is separate from the initializer boot fix. Validate malformed table/list HTML, existing collapsible excerpts, embedded attachment attributes, XSS rejection, rendering and subsequent edits against saved snapshots. Rendering changes do not necessarily rewrite stored HTML, but editing can; keep database backups, not just HTML output snapshots.
5. **Cache and signed-message formats:** >=7.1 defaults change cache format and generic signed-message serialization/metadata. Exports cache availability fragments with a deadline; tests normally disable caching. Stay on old formats through the old-worker rollback window, or use a separate cache namespace/cold cache. Don't flush Redis wholesale: it contains jobs and digest reservations, not just a disposable cache. Test old/new cache reads in both directions, deadline expiry, and authorization/expiry before 304. Keep `secret_key_base` and signing configuration stable; test existing sessions, Action Text SGIDs, and blob signed URLs across both versions. Development/test secret filename changes from `tmp/development_secret.txt` to `tmp/local_secret.txt`; preserve the key if local signed attachments/sessions matter. Production is a separate key-source audit, not a reason to regenerate credentials.
6. **HTTP freshness:** >=8.0 defaults use strict freshness, affecting `ExportDownloadsController#show` when ETag and Last-Modified validators disagree. Decide deliberately; test matching/mismatching ETag crossed with older/newer If-Modified-Since, plus expired and another reader's exports. Authorization and expiry must run before every possible 304. Existing ETag-only tests are insufficient for conflicting-validator semantics.
7. **Other generated changes:** Do not automatically adopt Solid Queue/Cache/Cable, Propshaft, a new authentication scaffold, Kamal/Thruster, or a new editor. This app intentionally uses Sidekiq, Sprockets/importmap, and custom sessions. Review `app:update` diffs manually; retain custom mail, queue, storage, assets, routes, and provider configuration. Rails 8.1 alphabetizes schema columns: review semantic DDL separately from dump reorder noise. Keep historical migration versions, and verify a fresh migration path as well as loading the schema.

## Dependency and operational gates

- Ruby 3.3.6 needs no upgrade to satisfy Rails 8.1. PostgreSQL server version is not established by `database.yml`'s obsolete comment; inventory the actual server against each rung's adapter support policy.
- **Sidekiq 6.5.12 is not proven unsatisfiable solely from Rails 8.1:** Rails Action Pack allows Rack >=2.2.4, while Sidekiq pins Rack ~>2.0. Rack session/rackup versions must also resolve. Do not claim Rails 8.1 mandates Rack 3. Resolve and record the actual Rack/session/rackup/Puma matrix and exercise production-like server startup and multipart direct upload. If choosing Rack 3 or newer Sidekiq, scope the Sidekiq/Redis/Puma migration explicitly and test separately.
- Rails 8.1's built-in Sidekiq adapter remains present but deprecated for removal in 8.2; upstream recommends Sidekiq >=7.3.3 for the gem-owned adapter. That is forward maintenance, not evidence that 6.5 cannot run 8.1. An upgrade would affect `Sidekiq.redis`, single-member `sadd` truthiness/API, Redis error rescue classes, native export option JSON, strict argument checks, and test fake mode. Inspect those against the chosen version, not against a generic latest-Sidekiq guide.
- Keep concurrent-ruby 1.3.4, pg 1.6.0, Pagy, Faraday, and Minitest constraints initially unless the resolver gives a concrete conflict. No reason established here to combine their upgrades. Existing pin comments explain baseline constraints, not a requirement to keep them forever.
- Production mail delivery/link host and private attachment access are already unconfigured/limited, not new upgrade regressions. Preserve behavior during comparison; production readiness needs its own work. Do not infer production deployability from a green test run.

## Ordered execution and release plan (all checks still proposed)

1. **Isolated baseline:** Create a disposable checkout; supply a dedicated PostgreSQL database/role, a dedicated Redis instance (preferred over merely a DB number), checkout-local Disk storage and mail directory, isolated cache namespace/path, and no real mail or provider credentials. Explicitly override database URLs for every process, including spawned credential-test processes and parallel test databases. Copying a checkout alone does not isolate Redis or environment URLs. Use only synthetic or approved redacted data; preserve key material securely when testing real signed data.
2. **Prepare on 7.0:** Explicit transaction rollback, DOI accessor, string join, integer annotation map, enum form, highlight forwarding, UTC digest consumer and neutral string job payload, compatible Action Text allowlist, application-owned provider config. Keep existing schema/data formats. Add only missing contract regressions, using existing test files.
3. **Upgrade one rung at a time:** Latest suitable 7.0 patch → 7.1 → 7.2 → 8.0 → exact requested 8.1.0, per upstream guidance. On 7.1 change coder syntax, retry symbol, and exception mode; resolve all deprecations before each removal. Keep defaults 7.0 and dependency changes narrow. `app:update` is a reviewed merge, not wholesale replacement. Final patch selection/security review is separate; 8.1.0 is the requested assessment target, not a claim that its original patch is the recommended current production patch.
4. **At each rung:** Record exact command, Ruby/Bundler versions, Gemfile and lockfile, effective defaults and adapters, non-secret resource identifiers, stdout/stderr, Rails/worker logs, and exit status. Run `bundle check`, eager-load/zeitwerk, full Rails tests, and browser suite; browser configuration needs Chrome/display or an explicit disposable headless adjustment. Run production-like boot and asset precompile. No result is available yet.
5. **Target validation:** Exercise all cases above, especially cross-version JSON job delivery, retry exhaustion, DST, raw dates/default variants, warm export cache, conflicting HTTP validators, legacy signed attachments and saved HTML. Run old/new readers and writers against the same disposable data store to verify rollback compatibility; do not use real shared services. Test native Sidekiq exports and Active Job jobs separately. Capture dependencies/config/logs separately for retained-defaults and each new-default variant; a green retained-default build says nothing about enabled 8.1 defaults.
6. **Release:** Deploy compatible preparations to all old web/worker processes first. Back up database and Disk storage together; inventory scheduled reminders, retry/dead jobs, pending enrichments, working exports, serialized columns, and signing-key source. Test a restore. Keep class names/GlobalIDs and reminder job IDs stable. Use a controlled web/worker cutover if wire compatibility is not demonstrated. Long-delayed reminders mean an empty immediate queue is not proof that old work is gone.
7. **Rollback:** Keep old-format preferences/tags and neutral digest payloads through the rollback window. Retain blobs and signing keys so old content remains readable. Stop incompatible producers before routing to old consumers; inspect newly queued/retried work before replay. Do not delete all jobs or purge orphaned blobs as an upgrade shortcut. Framework changes do not make non-idempotent digest/reminder mail safe to replay; inspect delivery evidence. Roll back code without destructive schema reversal where possible; database restore can lose post-deploy writes and requires an explicit recovery decision.
8. **Only after stability:** Adopt defaults independently using the validations above, then advance `load_defaults`. Monitor partial import persistence, missing receipt DOIs/annotations, digest day/duplicates, pending citations, retry errors, stuck exports, signed attachment failures, and user sessions. Refresh architecture/runtime documentation with the decisions actually implemented.

## Upstream references

- Versioned upgrade guide: https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html
- Release/removal notes: https://guides.rubyonrails.org/v8.1.0/7_1_release_notes.html ; https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html ; https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html ; https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html
- Defaults and gates: https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb
- Serialization old/new: https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb ; https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb
- Action Text fallback: https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb
- Transaction old/new: https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb ; https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb
- Job time and decimal serializers: https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb ; https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb
- Sidekiq adapter: https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb
- Dependency floor: https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec ; https://github.com/rails/rails/blob/v8.1.0/railties/railties.gemspec
- Key normalization and timezone behavior: https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/hash_with_indifferent_access.rb ; https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/core_ext/hash/keys.rb ; https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb

Remaining unverified facts: target dependency resolution and server compatibility; actual deployed PostgreSQL/Redis versions and topology; production key/session/cache settings; historical serialized values and signed content; live queue payload inventory; browser interoperability of vendored Trix 1.3.5 with Action Text 8.1. All runtime checks in this plan remain proposed, not passed.
