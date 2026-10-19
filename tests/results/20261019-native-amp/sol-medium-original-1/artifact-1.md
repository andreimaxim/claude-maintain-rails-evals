# Margin Notes: Rails 7.0.8.7 → 8.1.0 assessment

## Recommendation

Proceed as a staged compatibility migration, not a Gemfile-only update. Keep `config.load_defaults 7.0` while upgrading the framework through 7.1 → 7.2 → 8.0 → 8.1; adopt newer defaults separately. There are real failures even with 7.0 defaults retained, plus silent changes to import annotations and digest dates.

The repository pins Ruby 3.3.6, Rails 7.0.8.7, Sidekiq 6.5.12, Redis 4.8.1, pg 1.6.0, Pagy 8.6.3, Puma 5.6.9, and concurrent-ruby 1.3.4. Ruby already meets Rails 8.1's ≥3.2 requirement. A disposable bundle resolved and installed **Rails 8.1.0 with the existing direct dependency constraints unchanged**. It retained Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, and connection_pool 2.5.5. A mandatory Rack 3/Sidekiq 7 upgrade would be an incorrect prerequisite here. Resolution does not prove runtime compatibility or maintenance/security suitability.

**Delivery:** assessment only. No working application, dependency lock, schema, stored data, or queues were changed. Only ignored assessment artifacts and a repository-local `/.amp/in/` exclusion were written. No commit, push, or deployment was performed.

## Evidence and limits

- **S — source-based:** application code and tests inspected, compared with upstream tagged Rails code and versioned guides below.
- **P — executed probe:** small framework-level reproductions using the copied 7.0.8.7 bundle and separately installed 8.1.0 bundle. They do not boot Margin Notes or access PostgreSQL, Redis, Rails cache, Active Storage, or mail services. Scheduling uses an in-memory test adapter. Time zone is UTC and `to_time_preserves_timezone=true`, matching the relevant 7.0 default. No production/development data was inspected.
- **V — proposed validation:** application-level checks still to execute in an isolated application copy. The application's test suite, browser workflows, migrations, worker process, and production boot were **not run**. There are no system test cases (`test/system` contains only `.keep`), so even running that task would not validate Trix.

Probe commands, full output, the probe source, both complete Gemfiles/lockfiles, installation output, and archived tagged sources are retained alongside this report:

- [7.0 probe output](rails-7.0-probes.txt), [8.1 probe output](rails-8.1-probes.txt).
- [Probe source](rails-upgrade-evidence/probe.rb).
- [Baseline lock](rails-upgrade-evidence/baseline/Gemfile.lock), [target lock](rails-upgrade-evidence/target/Gemfile.lock).
- [Dependency resolution](rails-8.1-resolution.txt), [installation output](rails-8.1-bundle-install.txt).
- [Tagged source archive](rails-upgrade-evidence/upstream-tagged-sources.tar.gz).

Commands, from the corresponding evidence directory:

```sh
# baseline/
mise exec -- bundle exec ruby ../probe.rb
# target/
BUNDLE_PATH=/tmp/margin-notes-rails81-gems mise exec -- bundle exec ruby ../probe.rb
```

The resolution/install commands used `--gemfile .amp/in/rails-upgrade-experiment/Gemfile` from the repository root; that scratch bundle has been archived as `rails-upgrade-evidence/target`. The initial resolve was `mise exec -- bundle lock --update rails --gemfile ...`; installation added `BUNDLE_PATH=/tmp/margin-notes-rails81-gems`. No app logs were generated; framework logs are in the two probe output files. Probes intentionally catch and print exceptions, so a zero process exit is **not** a passing application test. Full resolved dependencies, including new transitive dependencies, are in the target lock, not inferred from the Rails version.

## Required compatibility work, independent of newer defaults

Each validation below is still proposed unless marked P.

### 1. Action Text allowlist initializer fails from 7.1 onward — S, P

**Affected:** `config/initializers/action_text.rb:3`, all rich-text rendering and application initialization. `allowed_tags` becomes nil until explicitly configured, even with 7.0 defaults. The current `allowed_tags += ...` raises `NoMethodError`; the probe reproduces it in 8.1 and succeeds in 7.0.

**Recommendation:** explicitly build from the effective sanitizer's default tags, including Action Text's attachment tag, `figure`, and `figcaption`, then add `details` and `summary`. Apply at a lifecycle point where the selected sanitizer is known; don't replace the allowlist with only the two custom tags. Initially preserve the existing HTML4 vendor, then evaluate HTML5 separately.

**Current-version preparation:** yes, explicitly composing the old defaults works in 7.0. New `sanitizer_allowed_tags` helper APIs must not be called unconditionally on 7.0.

**Validation:** clean eager boot; render stored details/summary, links and embedded attachments; reject scripts, event attributes and javascript URLs. Include a note saved by 7.0, not just freshly assigned HTML. Retain blob references and raw rich-text bytes across a render-only request.

### 2. `Note` enum and serialization declarations are removed APIs — S, P

**Affected:** `app/models/note.rb:10-14`. `enum status: ..., _prefix: true` is removed in Rails 8.0; positional `serialize :tags, JSON` is removed in 7.2. Probes reproduce `ArgumentError` for both declarations in 8.1.

**Recommendation:** `enum :status, { draft: 0, ready: 1 }, prefix: true`; from 7.1 use `serialize :tags, coder: JSON`. Preserve the JSON text column and integer status mapping. No data rewrite is needed for these API changes. Do not change tags to YAML, or introduce `type: Array` defaults without separately assessing null/default semantics.

**Current-version preparation:** enum conversion **yes**, confirmed by probe. Keyword-coder conversion **no**: 7.0's implementation chooses the coder from its second positional argument; `coder: JSON` is not a supported equivalent. Make that conversion at the 7.1 step, not as an unverified 7.0 “cleanup.”

**Validation:** open and edit an existing note with multiple tags, empty tags, ready/draft status, and a settings color; reload persisted values and verify old-version readers can read a target-written row.

### 3. Highlight aliases a store accessor, not a database attribute — S

**Affected:** `app/models/note.rb:13-14`, note form and list/show styling. Rails 7.2 removes `alias_attribute` for non-existent columns. `color` is generated by `store_accessor :settings`, not a physical column. This is not just the upgrade guide's custom-getter alias case.

**Recommendation:** replace the alias with explicit `highlight_color` getter/setter forwarding to `color`. Keep the `settings` jsonb shape unchanged.

**Current-version preparation:** yes.

**Validation:** edit yellow to green, reload, check `settings['color']`, checked radio and rendered highlight; invalid color must still reject the save. Existing request coverage is useful but has not been run here.

### 4. Citation provider reads removed application secrets — S

**Affected:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, web and worker processes. `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2. Enrichment can fail at runtime without an application boot failure.

**Recommendation:** use `Rails.application.config_for(:secrets).fetch(:citation_provider).to_h` with this file's existing environment nesting/ERB, or move that same contract to a dedicated configuration file. Preserve all three environment variables and literal credential bytes. This does not require moving environment-derived settings to encrypted credentials. Separately establish the deployed `secret_key_base` source; preserving the provider settings alone does not preserve session/blob signatures.

**Current-version preparation:** yes, `config_for` exists in 7.0. Test the actual YAML aliases and environment behavior before deployment.

**Validation:** fresh web and worker processes against a loopback provider, with a nontrivial URL and credentials containing YAML-sensitive punctuation. Verify exactly one retry on 503 and permanent refusals. The existing subprocess credentials test covers part of this; it has not been executed here.

### 5. Citation retry algorithm name is removed — S

**Affected:** `app/jobs/citation_enrichment_job.rb:7`. `:exponentially_longer` is deprecated in 7.1 and removed in 7.2; the failure occurs when a transient provider error triggers retry, not necessarily on enqueue.

**Recommendation:** at 7.1 change to `:polynomially_longer` (same fourth-power backoff and jitter, despite the old name). Keep three total attempts and the terminal persisted failure behavior.

**Current-version preparation:** direct symbol replacement **no**: 7.0 recognizes only the old symbol. Prefer the 7.1 staged conversion over a compatibility wrapper. If a single cross-version release is essential, an explicit wait proc can express the old formula, but must preserve its jitter deliberately.

**Validation:** persistently unavailable local provider; verify two requeues, expected delay ranges, at most six provider HTTP requests, then failed citation state without falling through to Sidekiq retries. Include a queued retry produced before deployment.

### 6. Native export concatenation fails — S, P

**Affected:** `app/models/export.rb:42`, `ExportJob` execution. Rails 7.1 removes the implicit string identity in `Enumerable#sum`. Probes show the current fragments concatenate under 7.0 but raise `TypeError` under 8.1.

**Recommendation:** `finish(fragments.join)`. This preserves exact concatenation and avoids numeric sum semantics.

**Current-version preparation:** yes; matching output confirmed by probe.

**Validation:** export a notebook with two distinct notes and an empty notebook; assert Markdown bytes, heading, stable order, completion/file availability, and cancellation. Native job enqueue tests alone cannot catch this execution failure. Old queued exports remain runnable with this code-only fix.

### 7. Import atomicity changes on early transaction return — S

**Affected:** `app/models/import.rb:50-60`. The `return false unless row.note.save` exits a transaction after the Import and possibly earlier rows have saved. Rails 7.0 rolls back this nonlocal exit; 7.1 defaults can opt into commit and 7.2 removes rollback-on-return. Keeping `load_defaults 7.0` is not a permanent workaround.

**Recommendation:** replace nonlocal return with explicit `ActiveRecord::Rollback`, return a success marker only after every note saves, and translate the rolled-back result into false outside the transaction. Keep note validation errors for the preview. Do not prevalidate and assume later writes cannot fail.

**Current-version preparation:** yes.

**Validation:** a valid first row introducing a new DOI followed by an invalid later row; assert **zero changes** to Imports, Notes, Citations and ActionText rich texts, not just an error response. The existing import test is well targeted but not executed here. Do not roll back a release by replaying failed batches; partial imports created by an unsafe target would require reconciliation.

### 8. Import annotations disappear after stringification — S, P

**Affected:** `app/models/import.rb:38-41`, `app/views/imports/preview.html.erb:22,42-44`. Rails 8.0 changes indifferent-hash `stringify_keys` to stringify integer keys. Source-line keys 2 and 4 become `'2'` and `'4'`, but the view still indexes by integer. Probes confirm both lookups silently become nil. Persisted annotations are not themselves lost by this display bug.

**Recommendation:** remove the unnecessary `stringify_keys` here and keep integer source-line keys end to end; alternatively use string keys consistently at both construction and lookup. Do not just change lookup to `row.line.to_s` while leaving the old producer unchanged.

**Current-version preparation:** removing stringification **yes**, confirmed by probe; string-only lookup alone **no** on 7.0.

**Validation:** preview rows with distinct annotations, a blank line and a quoted multiline HTML cell. Assert the right annotation beside its starting source line, including invalid rows; verify HTML-looking annotation text is escaped.

### 9. Citation receipt assumes `[:id]` means custom primary key — S

**Affected:** `app/models/import.rb:63-69`, `Citation` table whose primary key is `doi` (`db/migrate/20261011160000_create_imports_and_citations.rb`). Rails 7.2 removes the special `read_attribute(:id)` behavior for custom primary keys. `citation[:id]` is not the DOI column on the target; receipt DOI values can become blank.

**Recommendation:** use `citation&.doi` (domain-explicit) or `citation&.id`. Keep actual DOI spelling/case unchanged; do not add an `id` column.

**Current-version preparation:** yes.

**Validation:** receipt with a mixed-case DOI, another distinct DOI and an uncited note; compare CSV fields and ensure shared citations still serialize their DOI. The existing exact CSV assertion would detect one case, once upstream boot failures are fixed.

### 10. Numeric reminder scheduling is no longer supported — S, P

**Affected:** `app/models/note.rb:61`, imported and manually scheduled reminders. Rails 7.2 removes numeric `scheduled_at` support; 8.1 preserves `wait_until` as assigned and job serialization calls `.utc`. Probe: integer epoch raises `NoMethodError`; a UTC Time enqueues at exactly 1793451617 under both versions.

**Recommendation:** pass `Time.at(reminder_epoch).utc` to `wait_until`. Keep the stored bigint epoch and existing job-ID replacement semantics.

**Current-version preparation:** yes, confirmed by probe.

**Validation:** exact seconds preserved, past times promptly executable, failed enqueue leaves the previous reminder unchanged, stale scheduled jobs send nothing, latest job sends once. Execute old and new serialized scheduled jobs; do not delete future scheduled reminders during rollout.

### 11. Two request APIs prevent normal pages from working — S, P

**Affected:** `app/views/notes/index.html.erb:12` explicitly passes `model: nil` to `form_with` (removed in 8.0); `config/routes.rb:26` supplies `/notes` and `/journal` in one `get` call (removed in 8.1). Both errors are reproduced by probes.

**Recommendation:** omit `model:` on the unbound search form; split the two GET declarations, preserving the existing canonical `notes_path` and journal bookmark alias. Do not replace the journal alias with a redirect unless intentionally changing behavior.

**Current-version preparation:** yes for both.

**Validation:** both URLs return the same authorized filtered list; search has the correct GET target, fields and no unintended model binding. Existing request tests exercise these contracts.

### 12. Exception configuration changes test behavior — S

**Affected:** `config/environments/test.rb:31`. Boolean `show_exceptions=false` is removed in 7.2; authorization tests rely on raised `RecordNotFound`, not rendered 404 pages.

**Recommendation:** use `:none` from 7.1 onward, preserving the old test contract. Do not blindly accept generated `:rescuable`, which changes what these tests observe.

**Current-version preparation:** direct symbol replacement **no**: 7.0 checks for boolean false; use the staged 7.1 edit.

**Validation:** a missing or foreign note still raises in tests; in a separately configured production-like request, the response is a 404 and no unauthorized side effect occurs. The explicit test queue adapter is already `:test`, so Rails 7.2's test-adapter consistency change does not require changing this app's adapter.

## Behavior and data-format changes to resolve explicitly

### 13. Digests change from UTC days to reader-local days — S, P; required to preserve the app contract

**Affected:** `app/models/user.rb:34-56`, `app/jobs/digest_job.rb`, `app/mailers/digest_mailer.rb:7-10`. Reservations use a UTC date, while the mailer derives the date/range from a deserialized zoned time. Rails 7.2 begins serializing and restoring its named time zone. At 2026-10-05 03:30 UTC, the Eastern reader's old job yields October 5 UTC; the new job yields October 4, 23:30 Eastern. This changes the subject **and selected notes**, while reservations still enforce UTC days. Probe confirms this independently of defaults.

**Recommendation:** normalize `requested_at` to UTC before deriving `@date` and `all_day` in the mailer. Optionally also enqueue UTC context, but fixing only new producers does not protect pre-existing target-format jobs. Preserve the documented UTC digest policy rather than changing the expected test to the new local day.

**Current-version preparation:** yes.

**Validation:** old and new JSON payloads for Eastern near midnight and a positive-offset zone; notes on opposite sides of UTC/local midnight; assert date, membership and reservation key all use the same UTC day. Existing digest test already has a discriminating Eastern timestamp.

### 14. BigDecimal job format breaks old workers/rollback — S, P; rollout risk, not a mailer conversion bug

**Affected:** same digest producer. Rails 7.0 leaves BigDecimal primitive and Sidekiq JSON makes it a string. Rails 7.1 introduces an opt-in serializer; 7.2 makes the typed serializer mandatory. Target emits `ActiveJob::Serializers::BigDecimalSerializer`; 7.0 cannot deserialize that name. Both old string payloads and new typed payloads are readable by 8.1. The existing `BigDecimal(params[:completion])` works with **both** String and BigDecimal on pinned Ruby 3.3.6; this was tested. Do not “fix” that conversion unnecessarily.

**Recommendation:** prepare the producer to enqueue `reading_completion.to_s` before upgrading, preserving precision and making new payloads native JSON-safe strings across both versions. Let the mailer continue accepting both representations. On a staged 7.1 deployment keep the optional serializer off until no 7.0 consumers remain, unless using the explicit string contract.

**Current-version preparation:** explicit decimal strings **yes**. New serializer configuration is not a 7.0 compatibility fix.

**Validation:** queue-boundary JSON round trips, not only the Active Job test adapter (which preserves BigDecimal without JSON in 7.0). Use a value such as 0.6667, verify displayed 67%, and run old→new and new→old consumers. The probe executes old/new deserialization and confirms the one-way incompatibility.

**Rollout/rollback:** if any new typed jobs already exist in ordinary, retry, scheduled or dead sets, converting the producer does not rewrite them. Drain with compatible workers or supply a separately verified backward reader before returning to 7.0. Do not flush queues; reminders and exports are durable user work.

### 15. Reminder DST preview changes without changing the stored instant — S, P

**Affected:** `app/models/note.rb:40-44` and reminder preview. Rails 8.1 always preserves the named zone in `TimeWithZone#to_time`; the old true setting preserves only its UTC offset. The probe for October 31, 09:00 Eastern plus 86400 seconds yields old November 1, 09:00 -04:00 versus target 08:00 -05:00, with the **same epoch**.

**Recommendation:** make the intended display explicit. Prefer a zone-aware preview using `reminder_at + 24.hours`, preserving 24 elapsed hours and showing the user's correct wall-clock time. This is a deliberate visible correction: update the existing fixed-offset expectation and documentation. If strict legacy display preservation is required, explicitly convert to a fixed offset before addition (`getlocal(reminder_at.utc_offset)`) instead. Do not change to `1.day`, which can mean a different elapsed duration across DST.

**Current-version preparation:** both explicit alternatives work in 7.0, but zone-correct display deliberately changes current behavior. Changing a framework flag cannot restore old 8.1 behavior.

**Validation:** spring-forward and fall-back, both the displayed offset/time and queued epoch delta of 86400; imported reminder remains unchanged. Existing reminder tests assert the old preview, not both DST boundaries.

## Optional adoption of newer defaults (not prerequisites for the gem upgrade)

Keep these separate from required work above. Each is gated by changing defaults/explicit configuration, not merely installing Rails 8.1.

| Finding and affected code | Recommendation, current-version preparation, discriminating validation |
| --- | --- |
| **Notebook YAML:** `Notebook.serialize :preferences` relies on the implicit YAML coder; 7.1 defaults set `default_column_serializer=nil`. | At the 7.1 stage explicitly use `coder: YAML` before adopting those defaults. Explicit positional YAML is supported on 7.0 but is itself removed later; keyword syntax is not the direct 7.0 preparatory form. Keep existing YAML, including empty/nil behavior. Validate a stored export heading and target-written preferences read by old code; audit unexpected YAML classes before changing permitted classes. Do not simply switch the text column to JSON. |
| **Readonly slug:** 7.1 defaults enable `raise_on_assign_to_attr_readonly`; controller permits/resubmits slug and form includes a hidden slug. Setter raises even for an unchanged value on persisted records. | Stop accepting/resubmitting slug as a writable settings attribute while retaining `attr_readonly`; this is a 7.0-compatible preparation. Check normal name/heading update and forged changed slug. Otherwise pin the old default until addressed. |
| **PostgreSQL dates:** 7.2 defaults enable raw date decoding; `Notebook#daily_note_counts` calls `Date.iso8601(day)` after `select_rows`, assuming String. | Retain decoding false initially, or make SQL explicitly return ISO date text (e.g. a date-to-text expression under controlled ISO DateStyle), or accept already-decoded Date while retaining parsing for old Strings. A String/Date-aware boundary is compatible with 7.0. Validate actual PostgreSQL results with decoding off and on, two dates across UTC midnight, and exact counts/order. No PostgreSQL probe was executed here. |
| **Expired cache TTL:** 7.1 defaults raise for invalid expiration; `app/views/exports/_export.html.erb:26` passes `expires_at - Time.current`, negative for expired exports. | Avoid cache writes with expired/negative TTL: render expired state without this cache, or otherwise use a valid deliberate policy. Compatible with 7.0. Check miss/hit before expiry, exact expiry and after expiry with caching enabled; a new setting can turn today's warning/uncached write into an exception. Default tests disable caching; retain the authorization-before-conditional-response check on downloads. |
| **HTML5 sanitization:** 7.1 defaults choose HTML5 on this MRI/Nokogiri platform; stored HTML may parse differently. | Initially preserve HTML4, then compare representative stored/imported malformed HTML, details/summary, attachments and unsafe markup before selecting HTML5. Rendering generally need not rewrite DB HTML; editing/Trix may. Vendor selection APIs arrive in 7.1, so do not add those new config keys to 7.0 as if they were an effective pin. |
| **Message metadata, serializers and cache format:** 7.1 defaults change message serializer/metadata and cache format; sign-in uses cookie session and Action Text/Storage use signed IDs/URLs. | Keep current secret, salts, cookie serializer and old writer settings while mixed/rollback is possible; adopt each format only after two-way verification or an intentional invalidation plan. Do not assume new readers accepting old values proves old readers accept new values. No format migration settings need adding to 7.0 for the initial approach. Validate old/new cookies, blob redirect IDs and embedded attachment SGIDs in both directions with the same test secret, plus populated cache entries. Cache may be disposable; embedded references are not. |
| **Conditional download freshness:** 8.0 defaults enable `strict_freshness`; `ExportDownloadsController#show` uses ETag and Last-Modified. | Evaluate intentional RFC precedence separately. Use a request with a matching If-None-Match but conflicting If-Modified-Since, and vice versa, as well as unauthenticated, foreign-owner and expired requests. 7.0 has no equivalent new flag to adopt; keeping old defaults is the preparation. |
| **Other generated defaults:** YJIT, Puma threads, new JSON escaping, render tracker, Solid services, Propshaft, browser restrictions, authentication generator and CI templates. | Do not replace this app's Sidekiq/native ExportJob, Sprockets/importmap, sessions, local storage or services just to resemble a new Rails app. Treat new features/performance/security-default policy as separate work. Existing URL helpers are not path-relative redirects; lists explicitly order records, and app JSON endpoints/AR encrypted columns are absent. No change is established for the new order/JSON defaults here. |

## Browser/editor compatibility and persistent content

The layout explicitly loads **vendored Trix 1.3.5** (`app/views/layouts/application.html.erb:10-14`); the import map supplies `@rails/actiontext` from the Rails gem. Upgrading Rails does **not** replace that hard-coded editor. Rails 7.1 shipped Trix 2.x; Rails 8.1 extracts its dependency to `action_text-trix` (≥2.1.15), and changes attachment upload integration.

**Recommendation:** make the editor version an explicit compatibility/security review, not an assumed automatic upgrade. Prefer testing a matching supported 2.x editor with 8.1 Action Text; do not claim the retained 1.3.5 pair is compatible without a browser run. Updating the editor before the server upgrade also needs an independent browser check on Rails 7.0, so this is not an established cross-version preparation.

**Validation:** production-style asset precompile and actual browser create/edit/save/reopen, link attributes, original-size image and non-image attachment direct uploads, validation rejection over 1 MB, progress/failure state and Turbo navigation. Include stored 7.0 HTML and new HTML read by 7.0 for rollback. Existing tests cover server rendering/size rejection, not this JS pairing. Saving details/summary through the current editor is already documented to flatten them; do not misattribute that existing data-loss behavior to Rails 8.1 or promise upgrading Trix fixes it. Do not bulk re-save rich text during an upgrade. Back up raw bodies plus matching blob/attachment rows and disk files.

## Enqueue timing and dependency choices

`Citation#request_enrichment` and `Note#schedule_reminder` enqueue under a row lock/transaction and depend on enqueue errors rolling back database state. `Notebook#request_export` commits before a **native Sidekiq** enqueue and compensates for Redis errors. These are distinct contracts.

Rails 7.2 introduced deferred enqueueing; **Rails 8.1's source default is false**, and the load-defaults chain does not enable it. Do not mechanically add the 7.2 `:never` symbol to 8.1 (symbols are removed), or assume deferred enqueue is forced by 8.1. If explicitly enabling `enqueue_after_transaction_commit=true` later, failures can occur after the DB commit and invalidate the existing rollback assumptions. Keeping current immediate timing requires no new 7.0 setting. Validate a real refused enqueue outside test transaction wrappers, row-lock visibility with a separate worker connection, reminder replacement and citation pending state. The native export is unaffected by an Active Job flag.

Rails 8.1's built-in Sidekiq adapter still accepts this version but is deprecated; its warning recommends Sidekiq ≥7.3.3 for the gem-owned adapter, anticipating removal in Rails 8.2. That is **optional for this 8.1.0 target**, not evidence of a resolver blocker. If a Sidekiq modernization is chosen, separately assess Redis client APIs, `sadd` boolean-vs-integer behavior in digest reservations, exception classes used by compensation, strict JSON handling, adapter wrapper compatibility, Redis server requirements and native ExportJob payloads. Do not combine that additional upgrade casually with Rails. Rails 8.1 Action Cable's Redis adapter declares redis ≥4,<6; existing Redis 4.8.1 meets that source constraint, though reconnect behavior is not exercised.

## Suggested implementation and release sequence

1. **Inventory and preserve:** identify the real deployed Ruby/PostgreSQL/Redis versions, web/worker topology, secret source, persistent disk mount and cache store. Snapshot DB and disk together. Inventory immediate, scheduled, retry and dead jobs by class/payload format without logging private content. Current repository defaults are not evidence of production configuration. Keep the requested exact 8.1.0 target for assessment; assess its patch/security policy separately before a real deployment.
2. **Prepare on 7.0:** string export join; explicit highlight accessors; explicit transaction rollback; integer annotation lookup; explicit DOI receipt; Time reminder scheduling; unbound form and split routes; provider `config_for`; UTC digest interpretation and string decimal arguments. Compose the Action Text allowlist compatibly. Validate these against the current version before moving on. Decide the DST preview contract separately. No bulk data rewrite is needed for these steps.
3. **7.1 checkpoint:** use an appropriate 7.1 patch release, retain 7.0 defaults; convert serialized-coder syntax, exception config and retry symbol; explicitly preserve notebook YAML. Review `app:update` interactively rather than overwriting infrastructure/config. Capture deprecations with production-equivalent configuration because production currently disables reporting. Keep secrets stable; see local-secret note below.
4. **7.2, 8.0, then exact 8.1.0 checkpoints:** use patch releases for intermediate lines per Rails upgrade guidance, lock each variant, clear all applicable deprecations/removals, run application and queue compatibility gates at every step. Keep all frameworks' Rails component versions aligned. Do not infer success at 8.1 just because 7.2 tests pass.
5. **Rollout:** prefer workers upgraded before new producers, or quiesce producers and finish in-flight work at each format boundary. Inventory/safely retain long-delayed reminders rather than trying to “drain” all future work. Verify old Active Job wrapper names and native ExportJob jobs on the new worker. Explicit decimal strings avoid the demonstrated 7.0 reader incompatibility, but do not prove all payloads or adapters are compatible. Canary sign-in, import, export, enrichment, reminder and digest; watch retries, pending-state age, deserialization errors and attachment downloads.
6. **Rollback gate:** before permitting new-format writers or newer defaults, establish whether rollback readers can consume their jobs/messages/HTML. Retain the compatible worker version long enough to process jobs it alone understands; prevent old workers claiming typed BigDecimal jobs. Keep preparation changes in the rollback release. Do not flush Redis (it contains both queued work and two-day digest reservations), regenerate keys, or roll back application-owned schema/data as a reflex. Preserve job UUIDs, reminder IDs and reservation keys to avoid duplicate sends or stranded work.
7. **Defaults adoption:** after stable 8.1 runtime, enable settings incrementally with the conditional validations above, then change `load_defaults`. Treat cache invalidation separately from durable data conversion and message-signing compatibility.

**Development/test signatures:** Rails 7.1 renames `tmp/development_secret.txt` to `tmp/local_secret.txt`. Securely preserve the existing local secret through that transition if local sessions/attachment signatures must survive; do not print it. This rename is not a production secret migration. Existing production `SECRET_KEY_BASE`/credentials must stay stable independently. Do not rerun the old plain-text-to-rich-text data migration as an upgrade strategy.

## Application validation gate still to execute

Use a **disposable application copy plus genuinely isolated resources**: unique PostgreSQL databases including parallel worker DBs, a dedicated Redis process/port (not just copied config), copy-local Disk roots, isolated cache directory/namespace, test/file mail delivery, loopback citation provider and test-only signing secret. Explicitly replace inherited `DATABASE_URL`, `REDIS_URL`, storage/cable configuration and provider settings before boot; verify resolved resource identities without printing secrets. Native Sidekiq exports and digest reservations need separate attention even when Active Job uses its test adapter.

For each baseline/intermediate/target variant retain the exact tree diff, Ruby/Bundler versions, complete lockfile, effective defaults/resource configuration, command, exit status, full stdout/stderr and app/worker logs. Run:

- `bundle check`, `bin/rails zeitwerk:check`, complete request/model/job tests, then real worker/JSON boundaries and browser workflows described above. Report test counts and skips; do not call an empty system suite browser coverage.
- Existing-schema upgrade and independent empty-database setup; audit framework migration diffs rather than assuming new framework tables are needed. Rails 8.0 fresh `db:migrate` may load schema first, so distinguish schema-load success from replaying migrations. Rails 8.1 alphabetizes schema columns; schema diff noise is not an instruction to reorder live columns.
- Two-way job payload compatibility including future reminders/retries and native exports; real enqueue failure and transaction behavior; cached expiry boundaries; session/blob-signature interoperability; target assets with the actual chosen Trix version.

### Remaining uncertainties

No deployed services/data were inspected. Actual YAML object classes, malformed stored HTML prevalence, signed-link consumers, long-lived queued payloads, cache contents, PostgreSQL server version, production mail setup and rolling-deploy topology remain unverified. Full target application boot is not established; the probes intentionally isolate individual failures rather than patching and running the application. No claim is made that the list exhausts bugs in transitive gems or that the exact requested release is a safe current patch choice.

## Versioned upstream references

These sources describe the requested interval; stable-branch changelog links in release notes were not treated as immutable evidence. The source archive contains the exact tagged files used.

- [Rails 8.1.0 upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html): staged upgrades, defaults separation, local secret rename, test adapter and aliases.
- Release notes: [7.1](https://guides.rubyonrails.org/v8.1.0/7_1_release_notes.html), [7.2](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html), [8.0](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html), [8.1](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html): API removals, defaults and new-app-only features.
- [8.1 defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), [8.1 actionpack gemspec](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec), [8.1 railties gemspec](https://github.com/rails/rails/blob/v8.1.0/railties/railties.gemspec).
- [7.1 Action Text changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [8.1 Action Text helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb), [8.1 Action Text changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).
- [7.1 Active Support changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md) (`sum`), [8.0 Active Support changelog](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md) (integer hash keys), [8.1 TimeWithZone](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).
- [7.0 serialization source](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serialization source](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [7.2 Active Record changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- [7.1 Active Job changelog](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 Active Job changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 time-zone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [8.1 scheduling/core](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb), [8.1 enqueue defaults](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb), [8.1 Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).
