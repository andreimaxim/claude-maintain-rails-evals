# Margin Notes: Rails 7.0.8.7 → 8.1.0 upgrade plan

## Decision

**Feasible, but not a Gemfile-only upgrade.** Keep `config.load_defaults 7.0` initially, remove the concrete incompatibilities below, upgrade through 7.1 → 7.2 → 8.0 → 8.1 in reviewable stages, and adopt defaults separately. Retaining 7.0 defaults does **not** retain removed APIs, old transaction semantics, job serializers, or Rails 8.1 time conversion behavior.

Ruby 3.3.6 already satisfies Rails 8.1.0's Ruby >= 3.2 requirement. The resolver retained Sidekiq 6.5.12, redis 4.8.1, Puma 5.6.9, Rack 2.2.24, pg 1.6.0, Pagy 8.6.3, and the existing asset stack. **Rails 8.1 does not require a Rack 3, Sidekiq 7, Propshaft, Solid Queue, or Solid Cache migration here.** Resolution is not runtime certification of those combinations.

One newly resolved dependency **does** need constraining for this exact target: JSON 3.1.0 breaks Active Support 8.1.0's JSON decoder. A separate `json < 3` variant resolved to 2.21.2 and passed the decoder/message probes. Preserve that constraint and tested lockfile, or separately evaluate a Rails patch that fixes the incompatibility.

This assessment targets exactly **8.1.0**, not the latest 8.1 patch. Security advisories/latest patch suitability have not been audited; select a deployment patch deliberately rather than assuming the initial minor release is the right production destination.

### Scope and evidence

Inspected the application, configuration, schema, migrations, and tests at [this application revision](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7), and version-tagged upstream release notes/source. The working application is unchanged. Existing untracked `.amp/` plugin files were left alone. Only ignored research/evidence artifacts and the repository-local `/.amp/in/` exclusion were created.

- **S — source-based:** application usage traced to versioned implementation/guidance; not an executed application regression.
- **E — executed:** dependency resolution/install or isolated framework probe, with precise variant recorded below.
- **P — proposed:** application-level validation still required. No app boot, database-backed suite, browser workflow, live worker, or production check was run.

[Experiment evidence and reproduction instructions](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/README.md) include commands, all three Gemfiles/lockfiles, flags, payloads, activated dependency versions, and outputs. Experiments ran only in a disposable copy without loading its Rails environment. No database/Redis connection, application cache, mail delivery, or Active Storage resource was used. Memory caches were private to individual processes; service URLs were fail-closed, and downloads went to a private gem directory.

## Required compatibility work

### R1. Constrain the newly resolved JSON dependency

**Affected:** [Gemfile](file:///home/user/workspace/repo/Gemfile), [Note tags](file:///home/user/workspace/repo/app/models/note.rb#L12), JSONB settings, session/message decoding, and framework JSON consumers.

**S/E:** The unconstrained resolution installs JSON 3.1.0. [Active Support 8.1.0 calls `JSON.parse(json, options)`](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb#L24-L25); the resolved JSON 3.1.0 method accepts only one positional argument. The executed decoder probe raises `ArgumentError: wrong number of arguments (given 2, expected 1)`. The serialized-column JSON coder calls that decoder too. This is a current-resolution hazard, not a claim that Rails 8.1 originally shipped with JSON 3.

**Recommendation:** Add a tested JSON < 3 constraint for the exact 8.1.0 upgrade; preserve the resolved 2.21.2 lock. Do not assume successful bundling validates Rails' unbounded transitive dependencies. The syntax of the constraint works on 7.0; the baseline-with-JSON-2.21.2 combination was not executed and should be tested if shipped as preparation.

**P:** Round-trip existing JSON tags, empty tags, nested JSONB settings, sign-in cookies, signed blob IDs, and citation HTTP responses. Include `ActiveSupport::JSON.decode`, not only direct `JSON.parse`, because the latter succeeded in the failing variant.

### R2. Repair Action Text's allowlist initialization without stripping safe content

**Affected:** [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), all boot paths, note rendering/imported HTML/attachments.

**S/E:** Since 7.1, `ActionText::ContentHelper.allowed_tags` defaults to nil; defaults are computed at runtime. Executing the existing initializer against 8.1 raises on `nil + ...`, independently of `load_defaults`. [7.1 Action Text changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33), [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).

**Recommendation:** Explicitly derive the allowlist from the chosen sanitizer's safe defaults, retaining `ActionText::Attachment.tag_name`, `figure`, `figcaption`, and adding `details`/`summary`. Apply after the configured sanitizer is available. Do **not** use `(allowed_tags || []) + extras`, which would remove the inherited formatting/attachment allowlist. Constructing that union from `sanitizer.class.allowed_tags` is compatible with 7.0; the new `sanitizer_allowed_tags` helper is not a 7.0 API.

**P:** Cold/eager boot, development reload, and render a stored note containing a link, image attachment, details/summary, and unsafe script/event/javascript-URL markup. Preserve the safe structures and remove unsafe markup. Existing render tests help, but do not cover browser editing or historical content round trips.

### R3. Replace the three incompatible Note declarations; preserve stored formats

**Affected:** [Note declarations](file:///home/user/workspace/repo/app/models/note.rb#L10-L14), note forms/filtering, digest ready-note queries, tags, and highlights.

- **Enum — S:** The keyword-only declaration is removed in 8.0. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. This works on 7.0 already (Citation and Export use the positional API). Keep integer values and prefix unchanged; no status data migration. [8.0 removals](https://guides.rubyonrails.org/v8.0/8_0_release_notes.html#active-record).
- **Serialized tags — S:** The second positional coder is removed in 7.2. On **7.1 or later**, use `serialize :tags, coder: JSON`. **Do not apply that keyword rewrite blindly on 7.0.8.7:** its implementation selects its coder from the second positional argument, not the `coder:` keyword. It is not a safe cross-version preparation. Keep the current declaration until the 7.1 stage; do not accidentally change JSON text into YAML or tighten the type contract while fixing the call signature. [7.2 removals](https://guides.rubyonrails.org/v7.2/7_2_release_notes.html#active-record), [7.0 implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb#L103-L123).
- **Highlight alias — S:** `color` is a `store_accessor` backed by `settings`, not a database attribute. 7.2 removes aliases of non-attributes and bypasses custom accessors for real attribute aliases. Replace `alias_attribute` with an explicit `highlight_color` getter/setter delegating to `color`/`color=` (or both method aliases after the accessor). This works on 7.0. Do not create a new column or use `attribute :color` to evade the error. [Upgrade guidance](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#alias-attribute-now-bypasses-custom-methods-on-the-original-attribute).

**P:** Open/edit/reload a pre-upgrade note with two distinguishable tags, a nondefault highlight, and ready status. Inspect raw tags JSON and unchanged settings keys; test dirty persistence and prefixed scopes/predicates. Exercise empty/default `[]`, escaped quotes/Unicode, and data written by each version read by the other. Fixtures alone are not a stored-data inventory.

### R4. Remove the citation provider's dependence on Rails secrets

**Affected:** [Citation::Provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15), `config/secrets.yml`, [citation request tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L40-L57), including their settings mutation helper.

**S:** `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2. Retaining 7.0 defaults cannot restore it. The provider's default argument will fail when a worker constructs it. [7.2 Railties removals](https://guides.rubyonrails.org/v7.2/7_2_release_notes.html#railties).

**Recommendation:** Move the environment-backed provider settings to a dedicated `config_for` configuration or `config.x` populated from the same environment variables; credentials are an alternative, not a requirement. Preserve development/test stand-in defaults and production's absent-provider behavior; do not install real values in source. Update both web and worker configuration and tests that currently access/mutate `Rails.application.secrets`. A dedicated config loaded with `config_for` works on 7.0, so this is preparation work. Verify symbol-key lookup behavior rather than changing only the method name.

**P:** Keep the fresh-process credential test, including punctuation/quotes in environment values, and run enrichment from an actual isolated worker. Test missing provider URL, 401, 404, one 503 then success, and exhausted retry. Preserve the existing production signing key separately; provider configuration migration must not rotate `secret_key_base`.

### R5. Split the two-path GET route

**Affected:** [routes](file:///home/user/workspace/repo/config/routes.rb#L17-L19), `/notes`, `/journal`, and `notes_path`.

**S:** Rails 8.1 removes mapping one route declaration to multiple paths. Define two GET routes to `notes#index`, preserving the canonical `notes_path` name and the journal alias. This syntax works on 7.0. [8.1 Action Pack removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#action-pack).

**P:** Assert recognition and authorized filtered/paginated responses for both URLs, including query parameters and `notes_path` generation. The existing dual-path test should remain useful; a boot/eager-load check should draw the routes too.

### R6. Make failed CSV imports roll back explicitly

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L61).

**S:** `return false` from inside a transaction currently relies on rollback on non-local exit. Rails 7.1 introduced opt-in commit-on-return (new defaults); 7.2 removed the old rollback behavior, and 8.0 removed its toggle. If a later `row.note.save` returns false after earlier writes, the target transaction commits those writes even though the method reports failure. This is a data-integrity risk, not just an API error. [7.1 transaction change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L304-L331), [7.2 removals](https://guides.rubyonrails.org/v7.2/7_2_release_notes.html#active-record), [8.1 transaction implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L643-L677).

**Recommendation:** Raise `ActiveRecord::Rollback` on a rejected row and return success only when the transaction block actually completes. Do not leave the unconditional trailing `true` after a swallowed rollback. Keep validation errors available for the preview. This works on 7.0 and should precede the framework upgrade; no data rewrite is needed.

**P:** Valid first row, invalid second row; assert no import, note, new citation, or rich-text rows persist and errors still identify the source line. Run at least one check with a real outer commit boundary (not only fixtures' enclosing transaction), reading from another connection afterward. Existing invalid-row tests are relevant but have not been run here. Inventory/reconcile any partial batches if an unsafe variant ever reached production; framework rollback does not undo already committed imports.

### R7. Stop depending on old custom-primary-key and hash-stringification behavior

**Affected:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69), [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L42), [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L45).

**S:** Since 7.2, `citation[:id]` no longer redirects to the table's custom primary key. Citations have `doi`, no `id` column. Use `citation.doi` (or its actual primary-key accessor) so receipts retain the DOI. This works on 7.0. [7.2 removals](https://guides.rubyonrails.org/v7.2/7_2_release_notes.html#active-record).

**S/E:** In 8.0, `HashWithIndifferentAccess#stringify_keys` starts converting integer keys too. The preview stringifies integer source-line keys and then indexes with an integer, silently hiding annotations. The probe returned `"second"` on 7.0 and nil on 8.1 for the same integer lookup. Remove the unnecessary `stringify_keys` and retain integer keys on both sides; this works on 7.0 and 8.1. [8.0 change](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L45).

**P:** Import a quoted multiline body so row starts are lines 2 and 4; show distinct annotations at each, including literal markup, and download a receipt with an exact mixed-case DOI and one row without a DOI. Assert the actual CSV values, not merely content type/success.

### R8. Use string concatenation for Markdown exports

**Affected:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L32-L43).

**S/E:** Rails 7.1 removes its nonnumeric `Enumerable#sum` override. The current string-fragment sum works with a deprecation on 7.0 and raises `TypeError` on 8.1. Replace `fragments.sum` with `fragments.join`; works on both versions and preserves bytes. [7.1 Active Support removals](https://guides.rubyonrails.org/v7.1/7_1_release_notes.html#active-support).

**P:** Empty notebook (heading only), two asymmetric notes in creation order, Unicode/multiline text, and cancellation mid-export. Assert generated bytes and that cancelled jobs retain no file. Existing queued native `ExportJob` payloads contain IDs/options and can use the new implementation; there is no need to rewrite completed Markdown files or reschedule all exports.

### R9. Pass a Time to scheduled Active Jobs; rename the retry strategy at the correct stage

**Affected:** [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L51-L69), [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L4-L9).

**S/E:** Numeric `scheduled_at` is deprecated in 7.1 and unsupported in 7.2. `set(wait_until: reminder_epoch)` reaches this path. The target probe fails serializing the integer (`undefined method utc`); `Time.at(epoch).utc` serializes correctly. Convert only at the job boundary; keep the persisted integer epoch. This preparation works on 7.0, whose API accepts a Time and uses its epoch. [Active Job changes](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L15-L24), [8.1 Core](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).

**S:** Replace `wait: :exponentially_longer` with `:polynomially_longer` on **7.1 or later**, before 7.2 removes the old name. It preserves the fourth-power delay and jitter; it is not a request for a new backoff algorithm. The new symbol does **not** work on 7.0.8.7, so do not ship it as baseline preparation.

**P:** Imported epoch with nonzero seconds, a local date/time, past-due scheduling, replacement/postponement, and Redis refusal preserving the prior reminder. Execute a delayed payload produced on the old version in the new worker, retaining its job ID; confirm obsolete/deleted-note jobs send nothing. For retry, inspect delayed retries and three total attempts (up to six HTTP requests), with visible final failure and no subsequent Sidekiq retry for that handled provider error. A test adapter's in-memory scheduling alone does not establish Redis behavior.

### R10. Make digest day and wire types explicit before mixing workers

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L2-L12), Redis `digest_requests:YYYY-MM-DD` reservations.

**S/E — day:** Rails 7.2 preserves a serialized TimeWithZone's named zone; the old decoder uses the worker zone. The exact test boundary, New York 2026-10-04 23:30, round-trips to October 5 UTC under 7.0 but October 4 local under 8.1. The mailer uses `to_date` and `all_day` from that argument, while reservations explicitly use UTC. New jobs can therefore select a different set/day of notes despite unchanged source, and old queued jobs lacking `time_zone` can behave differently from newly queued ones. [7.2 serializer change](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

**Recommendation:** Preserve the documented UTC-day contract: normalize `requested_at` to UTC in the consumer before both date and range calculations; also send UTC explicitly from the producer to stabilize new payloads. These changes work on 7.0. A switch to reader-local digests would be a separate product/data policy change requiring reservation-key changes too.

**S/E — decimal:** 7.1 adds an opt-in BigDecimal serializer; 7.2 removes primitive serialization. New target arguments contain `ActiveJob::Serializers::BigDecimalSerializer`. The 7.0 reader raises `ActiveJob::DeserializationError` on them. Conversely, the target reads old JSON payloads as a String; it reads new ones as BigDecimal. `DigestMailer` already calls `BigDecimal(...)`, so that consumer can tolerate both shapes; the deserialization failure occurs before the mailer. [7.1 rollout warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155).

**Recommendation:** On 7.0, explicitly enqueue `reading_completion.to_s("F")`, which matches the existing real-queue wire contract and is readable across versions. Do not rely on globally disabling a serializer in 8.1; the 7.1 compatibility toggle was removed later. If choosing typed BigDecimal payloads instead, first deploy capable readers to every worker and establish a rollback reader; drain/version queues before enabling new writers.

**P:** JSON round trip **and** real Sidekiq execution with 7.0→new, new→7.0, and same-version producers/consumers, near local midnight with ready notes on opposite UTC days and a nonterminating fraction such as 2/3. Check subject, selected notes, percentage, deduplication, and failed enqueue cleanup. Existing Active Job tests do not emulate JSON conversion of BigDecimal. Do not clear digest reservation sets during deployment: that would permit duplicate daily requests. A rollback must preserve new queued work or quarantine it for a capable worker, not silently discard it.

### R11. Replace the boolean test exception configuration

**Affected:** [test environment](file:///home/user/workspace/repo/config/environments/test.rb#L25-L37), authorization tests using `assert_raises(ActiveRecord::RecordNotFound)`.

**S:** `show_exceptions = false` is deprecated in 7.1 and removed in 7.2. The 8.1 implementation treats values other than `:none`/`:rescuable` as rendering all exceptions, so leaving false can hide unexpected exceptions behind HTTP responses. Set `:none` at the 7.1 stage; it is **not** equivalent on 7.0, which uses a boolean check. [Upgrade guidance](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#new-ways-to-handle-exceptions-in-controller-tests-integration-tests-and-system-tests), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb#L185-L198).

**P:** Verify the normal exception-raising suite plus one explicit production-style 404 response. Keep `config.active_job.queue_adapter = :test` in test: Rails 7.2's consistent adapter selection is already handled by this app's override. Native Sidekiq jobs still need separate testing; the Active Job adapter does not control them.

## Behavior/default adoption decisions — not all are mandatory on 7.0 defaults

All default gates below were checked against [Rails 8.1.0 `load_defaults`](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), rather than inferred from generator defaults.

### D1. Notebook preferences: retain YAML explicitly before 7.1 defaults

**Affected:** [Notebook preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19), existing `notebooks.preferences` text.

**S:** With 7.1 defaults, `default_column_serializer` becomes nil and bare `serialize :preferences` fails. With retained 7.0 defaults the implicit YAML coder remains. On 7.1+, declare `serialize :preferences, coder: YAML`. Do not switch the coder to JSON just because that is the format of Note tags; it would misread the existing column. Keep default type semantics until stored values are inventoried. The keyword declaration is a **7.1-stage** change, not a safe 7.0 rewrite.

**P:** Read raw pre-upgrade YAML, nil and empty preferences, update an export heading, generate the export, and read new writes under the rollback version. Inventory non-Hash/serialized object values before adding a `type: Hash` or YAML permissions change. Safe plain String-keyed heading hashes shown in this app do not require an unsafe YAML loader.

### D2. Readonly slugs: stop assigning even the unchanged value before enabling strictness

**Affected:** [Notebook#attr_readonly](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L10), [strong parameters](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L40), [hidden slug input](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L14).

**S:** `raise_on_assign_to_attr_readonly = true` is gated on 7.1 defaults. It raises for assigning a readonly attribute on a persisted record **even if the value is unchanged**. Ordinary settings submission currently does just that. Remove slug from the writable parameters and its hidden field, retaining its displayed value and create-time model derivation. That preparation works on 7.0; do not remove the model protection.

**P:** Submit unchanged, missing, and maliciously changed slugs while editing a name/heading; verify a successful edit and unchanged persisted slug. Existing same-slug tests should be updated only where they assert the unnecessary hidden input.

### D3. PostgreSQL raw dates: handle the typed result before 7.2 defaults

**Affected:** [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L33-L40).

**S:** `postgresql_adapter_decode_dates = true` is enabled by 7.2 defaults; the underlying adapter default remains false on the retained 7.0 profile. With it enabled, raw `select_rows` returns a Date for `DATE(created_at)`, making `Date.iso8601(day)` fail. Normalize with `day.to_date` (both Date and Rails-extended String support it), or `Date.iso8601(day.to_s)`. Both are compatible baseline preparations. Do not cast the timestamp into a user's time zone: the report promises UTC dates.

**P:** Run the actual PostgreSQL grouping with decoding off/on, including two different counts, notes across UTC midnight, deleted notes, and another notebook. Assert Date results and displayed counts. No database type change or data backfill is needed. [7.2 change](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L99-L101).

### D4. Export fragment expiry: negative TTL changes even before strict defaults

**Affected:** [availability fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36), caching-enabled environments only.

**S/E:** The TTL becomes negative for an expired export. In 7.0 the probe's entry immediately expires. In 8.1 with the non-raising flag, the invalid TTL is removed and the entry survives; with 7.1 defaults' `raise_on_invalid_cache_expiration_time = true`, it raises `ArgumentError`. Development/test usually disable caching, concealing this path; the export test explicitly enabling MemoryStore is relevant. The download controller does not trust the fragment, so this is not evidence of a new authorization bypass.

**Recommendation:** Do not pass a negative TTL: clamp it to zero or keep the expired presentation outside the timed cache. Clamping `expires_at - Time.current` at zero works on 7.0. Merely replacing `expires_in` with an already-past `expires_at` is not a fix: the new store derives a negative TTL from it too.

**P:** Caching enabled, miss then hit, one second before/exactly at/one second after expiry, with unchanged cache version, and another reader. Check page output, absence of exceptions, and expired download rejection. [7.1 invalid-expiry setting](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L867).

### D5. HTTP validator precedence changes with 8.0 defaults

**Affected:** [ExportDownloadsController](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16).

**S:** `action_dispatch.strict_freshness = true` makes `If-None-Match` take precedence over `If-Modified-Since`. Previously both conditions had to match when both headers were present. Adopt deliberately; no controller rewrite is necessary, and expiry/ownership must remain before `stale?`. There is no 7.0 configuration to adopt this new flag; the existing behavior can be retained on the target until chosen.

**P:** Matching ETag plus an older/nonmatching modified-since header (old 200 vs new 304), nonmatching ETag plus a matching date (must stay 200), and expired/foreign exports with otherwise matching validators (must not yield an authorized 304). The existing test uses only Last-Modified, so it cannot distinguish this change. [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb#L45-L64).

### D6. Reminder preview timezone changes unconditionally by 8.1

**Affected:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L40-L45), [preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20), existing DST assertion.

**S/E:** Rails 8.1 `TimeWithZone#to_time` retains the named zone, not merely the offset; this is **not protected by keeping 7.0 defaults**. The app's calculation changes display from November 1 09:00 -04:00 to 08:00 -05:00 after an October 31 09:00 New York reminder. The probe confirms the same resulting epoch (1793538000) on both versions: the reminder still moves 24 elapsed hours, not a calendar day.

**Recommendation:** Preserve the 24-elapsed-hour scheduling contract. Prefer explicitly calculating/displaying in the reader's zone (`reminder_at + 86_400`) and deliberately update the preview assertion/docs; this expression works on 7.0 too but intentionally changes its displayed preview. If strict display preservation is required during preparation, explicitly convert with `getlocal(utc_offset)` before adding seconds; that preserves the old fixed-offset display on both. Do not change to `1.day` casually; calendar-duration behavior differs around DST. [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L499).

**P:** Spring and fall DST transitions, exact resulting epoch and wall-clock/offset text, postponed mail time, and an existing scheduled reminder. No persisted epoch rewrite is required.

### D7. Rich-text parser, sanitizer, and editor must be evaluated separately

**Affected:** [Trix layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [import map](file:///home/user/workspace/repo/config/importmap.rb#L8), `app/javascript/application.js`, `app/assets/stylesheets/actiontext.css`, stored Action Text bodies, CSV HTML, attachment partial.

**S/E:** HTML5 sanitizer adoption is gated by 7.1 defaults on supported platforms. Separately, target Action Text's HTML parser chooses HTML5 when Nokogiri supports it, even without loading the newer defaults. The malformed table probe changes nesting/text placement. Holding `sanitizer_vendor` at HTML4 is therefore not a guarantee of byte-identical HTML parsing. [7.1 sanitizer change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33), [8.1 parser selection](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text.rb).

**S:** Rails 8.1 supplies Trix through `action_text-trix ~> 2.1.15` (resolved 2.1.19), and Action Text's package declares Trix ^2.0.0. The layout still explicitly loads vendored Trix 1.3.5, so a gem upgrade does **not** upgrade the browser editor. CSS resolves the framework `trix` asset, risking a mixed JS/CSS generation. [8.1 Trix change](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md#L53-L57), [package contract](https://github.com/rails/rails/blob/v8.1.0/actiontext/package.json).

**Recommendation:** Treat alignment with supplied Trix 2 assets as an explicit frontend compatibility stage; remove the 1.3.5 override only when replacing it with a single tested Trix entry, with matching CSS. Do not load both editors or run `action_text:install` blindly over the custom attachment partial. Retain Sprockets/importmap. An editor change can be tested separately on 7.0, but compatibility with the old Action Text JS is **not established here** and must not be assumed. No proof was obtained that the current Trix 1.3.5 fails a particular 8.1 interaction; its version mismatch is a validation/release gate, not a reproduced browser failure.

**P:** Browser-load and resave pre-upgrade links/attachments, new direct image uploads, rejected >1 MB attachments, form validation, edit/save without changing text, and Turbo navigation. Render then edit malformed HTML and details/summary from representative stored data; compare resulting stored HTML and export plain text. Trix already flattens details/summary in the current app: do not label that pre-existing loss as introduced by the upgrade. Back up originals before any bulk normalization; server rendering alone is not evidence that edit-save is lossless. No system-test scenarios currently exist beyond the test base, so invoking an empty browser suite would not cover this.

## Mixed-version rollout and rollback controls

### M1. Stable signing keys and message formats are needed for durable attachments

**Affected:** sessions, signed Active Storage blob/Disk URLs, Action Text attachable signed GlobalIDs stored in rich-text HTML.

**S:** The local development/test signing file changes from `tmp/development_secret.txt` to `tmp/local_secret.txt` in 7.1. This workspace has the former and not the latter (names/existence only were inspected). Preserve/copy the existing key securely before booting a new local version if existing cookies/attachments should keep working. Keep both filenames consistent if rolling back. Production key provisioning was not inspected; retain the same effective `SECRET_KEY_BASE`/credential key. Do not generate or rotate one as a side effect of removing provider secrets. [Versioned upgrade guidance](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed).

**S/E:** 7.1 defaults change general message serialization to `:json_allow_marshal` and enable the new metadata envelope. Synthetic verifier probes with JSON 2.21.2 show new readers accepting old messages, but 7.0 failing on new-profile messages. 7.0 **does** read a target message using the legacy Marshal/metadata-false profile. This is not a full application cookie/blob/GlobalID round-trip test.

**Recommendation:** While 7.0 readers/rollback remain, keep the legacy message-writing profile (`message_serializer = :marshal`, `use_message_serializer_for_metadata = false` on versions supporting them), or deploy compatible readers first. Do not mistake JSON's Marshal **read** fallback for old-reader compatibility with new **writes**. These configuration switches are new in 7.1; don't put unsupported configuration into a baseline preparation and call it validated.

**P:** Cross-version sign-in session, signed blob ID, expiring Disk link, and a saved Action Text attachment SGID in both directions, with identical keys and tampered/expired controls. Use actual app verifiers/salts as well as synthetic ones. Attachment SGIDs may be non-expiring, so waiting for cookies/jobs to drain does not end their rollback risk: retain a compatible rollback reader or keep legacy writes until rollback to 7.0 is retired. Do not bulk rewrite signed HTML merely to silence missing attachments.

### M2. Cache format is separate from Redis queue state

**Affected:** export fragments; production's default FileStore, development's opt-in MemoryStore, test NullStore/explicit local MemoryStore.

**S:** 7.1 defaults select cache format 7.1; the 7.0 loader only understands older formats. New readers have fallbacks, not a guarantee that old readers can read new entries. MemoryStore instances are process-local; shared FileStore or a future network store needs coordination. Redis in this app is a queue/reservation backend, **not** a configured Rails cache.

**Recommendation:** Keep cache format 7.0 while old nodes share entries, or use a separate cache namespace/directory and accept cold caches on rollout/rollback. Clearing disposable fragments is acceptable; flushing Redis to achieve that would destroy unrelated jobs and digest reservations and is not acceptable. The 7.0 format already works on the current version. Do not introduce RedisCacheStore solely for the upgrade.

**P:** Cross-read written fragments with actual chosen store/format in both directions, or verify namespace separation; verify expiry and download authorization with a cold cache. Production cache topology has not been confirmed from deployment infrastructure.

### M3. Do not unintentionally change enqueue timing under row locks

**Affected:** [Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb#L11-L23), [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L51-L69), native export enqueue.

**S:** Rails 7.2 defaults can defer enqueue until commit, with adapter-dependent behavior. Its built-in Sidekiq adapter inherits a true default. These methods rely on Redis enqueue failure being raised **inside** the row-lock transaction so the pending/reminder state rolls back. Deferring it can commit state before a failed enqueue, and transactional tests may never reach a real commit. However, the exact **8.1.0** class default is `enqueue_after_transaction_commit = false` and its `load_defaults` no longer sets the 7.2 knob. Do not infer a forced target behavior from the 7.2 release headline. [7.2 implementation](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb), [8.1 default](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L44-L53).

**Recommendation:** Preserve immediate enqueue for these jobs during the compatibility upgrade, relying on the existing worker row-lock logic. On 7.2 use its supported `:never` setting when adopting defaults; on 8.0+ use the boolean per-job/class setting, and remove obsolete app-level/symbol settings before 8.1. The setting is not a 7.0 API, so add it only at its appropriate stage. Redesigning enqueue atomicity/outbox handling would be separate work, not an automatic default adoption.

**P:** Nontransactionally wrapped request tests with a refused enqueue and a fast independent worker: previous reminder/pending state must remain correct, no phantom queued job, no premature email, and no lost update. Native `ExportJob.perform_async` is outside Active Job; its existing create-before-enqueue and failure cleanup must be tested separately.

### M4. Sidekiq modernization is optional for 8.1, but has application-specific prerequisites

**S/E:** The target lock resolves with Sidekiq 6.5.12. Rails 8.1's built-in adapter accepts it but emits a deprecation recommending Sidekiq >= 7.3.3 for the gem-provided adapter; removal is announced for Rails 8.2. This deprecation is not a Rails 8.1 dependency-resolution blocker. [8.1 adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).

If upgrading Sidekiq separately, trace at least these existing calls:

- `Notebook#request_export` sends `{ format: "markdown" }`; Sidekiq 7 strict JSON arguments reject symbol keys. Send `{ "format" => "markdown" }` instead; this is safe on 6.5.
- `User#request_digest` relies on redis-rb 4's single-member `sadd` boolean. Sidekiq 7 uses redis-client, where SADD returns an integer and 0 is truthy in Ruby: a duplicate could be treated as accepted. Prefer a cross-client numeric operation such as `redis.call("SADD", key, id).to_i == 1`, validated on both. Merely retaining the separate `redis` gem does not retain Sidekiq's old connection API.
- `Notebook#request_export` rescues `Redis::BaseError`; new backend exceptions are `RedisClient::Error`. Update failure cleanup for the selected backend, not just the happy path. Digest rescue is broader but its tests currently inject old-client exception classes.
- Verify Redis server version (Sidekiq 7 requires >= 6.2), client changes, concurrency/database pool, serialized wrapper class compatibility, and retry/scheduled/dead sets. These were not tested here.

[Versioned Sidekiq 7 upgrade guide](https://github.com/sidekiq/sidekiq/blob/v7.3.3/docs/7.0-Upgrade.md), [7.3.3 Redis adapter](https://github.com/sidekiq/sidekiq/blob/v7.3.3/lib/sidekiq/redis_client_adapter.rb). Do not combine this optional migration with Rails merely to remove every warning.

## Recommended implementation sequence

1. **Baseline and inventory.** In a genuinely isolated environment, run the existing suite on the current lock; capture deprecated paths, representative serialized columns/rich text, stable signing keys, queue lengths/classes/oldest scheduled jobs, actual cache/storage topology, and baseline request/worker outputs. Do not log credentials or copy live user data into review artifacts. Back up database **and** local blob storage together.
2. **Ship 7.0-compatible preparation.** Explicit import rollback/result, `.doi` receipts, unstringified annotation keys, `join`, positional enum, explicit highlight accessor delegation, stable UTC/string digest arguments/consumer, Time scheduling, split routes, replacement provider configuration, nonnegative cache TTL, and removal of writable slug. Repair the allowlist with a cross-version safe-default union. Keep persisted values/job IDs/schema unchanged. Choose the DST display policy separately. Verify on 7.0 before changing framework gems.
3. **Move to a patched 7.1 staging point, retaining 7.0 defaults.** Convert serialized-column declarations to keyword coders, use `:polynomially_longer`, set `show_exceptions = :none`, preserve the local signing key, and inventory all deprecations. Test representative old data. Keep message/cache writer formats compatible and use the prepared digest wire contract. Review `app:update` diffs manually; preserve Sprockets, Sidekiq, Disk storage, custom mail config, attachment rendering, and environment-specific behavior.
4. **Move through 7.2 and 8.0, then exact 8.1.0.** Repeat boot/eager-load, full suite, real queue and request checks at each checkpoint. Preserve transaction enqueue behavior explicitly where a checkpoint's defaults differ. Regenerate only the needed lockfile changes; constrain JSON for the exact target. Existing `Migration[7.0]` files do not need wholesale version edits. A change to schema dump column ordering in 8.1 is not a request to reorder physical columns.
5. **Align and exercise browser assets.** Build production assets, ensure one supported Trix version and matching CSS, and exercise the real note edit/upload workflow. Test stored attachment signatures and actual rollback readers; do not declare the upgrade complete because requests render HTML.
6. **Roll web/worker versions with an explicit compatibility boundary.** Prefer prepared stable payloads and legacy message formats. Otherwise stop new writes, quiet/drain compatible work, route incompatible work to versioned workers/queues, and preserve scheduled/retry/dead entries. Do not wipe queues or reassign reminder job IDs, which are the stale-job suppression token. Verify process shutdown/startup and producer/consumer cross-pairs before re-enabling traffic.
7. **Adopt defaults individually after compatibility is stable.** YAML coder, readonly handling, date decoding, cache expiry, sanitizer, conditional requests, and message/cache formats have dedicated gates above. Only then raise `load_defaults`; keep explicit compatibility overrides until old readers and rollback obligations are retired. Choosing not to adopt a default immediately is not a failed Rails gem upgrade.
8. **Rollback rehearsal.** Boot the rollback build against a copy of data written by the new build, process old/new queue payloads, load existing/new attachment SGIDs and sessions, and exercise completed downloads. Prefer rolling back to the prepared compatible release. New message encodings in durable rich text or incompatible pending payloads can make an unprepared 7.0 rollback unsafe even with an unchanged SQL schema.

## Validation gates still to execute

Run each application command only in an isolated copy with unique PostgreSQL databases (including any parallel-worker databases), dedicated Redis instance/database, copy-local cache/storage/mail/log paths, and a local fake citation provider. An ordinary checkout copy with the current database.yml/REDIS_URL defaults is **not** isolated. Capture the effective Rails/defaults/adapter configuration and exact bundle before each run.

- `bundle check`, environment boot in test/development/production-like modes, `bin/rails zeitwerk:check`, route drawing, and production asset compilation.
- `bin/rails test`, focused imports/notes/notebooks/activity/exports/reminders/digests/citation tests, including real transaction boundaries and caching-on variants described above. Use disposable databases/Redis and a controlled worker timezone; freeze relevant dates explicitly.
- A real Sidekiq worker with JSON storage, both native and Active Job payloads; scheduled/retry/replacement jobs, provider unavailability and enqueue refusal. Use file/test email, not real delivery.
- Actual browser scenarios for sign-in, rich-text edit/resave/attachments, validation, Turbo and production assets. `test/system` currently contains no scenarios; the base uses headed Chrome and requires a display. Add/execute meaningful scenarios rather than treating an empty system test run as evidence.
- Stored-data/old-to-new-to-old round trips and signature checks, plus different-process reads of imports and worker updates.

### What was executed, and what it establishes

| Executed variant/check | Observed result | Limit |
| --- | --- | --- |
| Target `bundle lock --update rails`, then install to private GEM_HOME | Successful; Rails 8.1.0 and existing pinned direct dependencies resolve; JSON 3.1.0 selected | Not application boot/runtime compatibility |
| Direct target ActiveSupport JSON decode | ArgumentError on parser options | Isolated framework failure; application impact traced through JSON coder/source |
| Target + `json < 3`, `bundle update json` | JSON 2.21.2 selected; synthetic message decoding works | Not a complete dependency/security audit |
| String aggregation, annotation key lookup, copied initializer, numeric scheduling | Distinguishing old/new behavior/errors reproduced; `join`, unchanged integer keys, Time boundary work in both frameworks | No generated export, rendered preview, or actual scheduled job run |
| Digest argument JSON cross-read | New named zone changes day; 7.0 cannot read new BigDecimal serializer; target reads old string payload | No actual Redis worker/email delivery |
| DST calculation | Same epoch; new named-zone display differs; explicit fixed-offset/zoned alternatives demonstrated | No browser or request test |
| Private MemoryStore negative TTL | Old expires; target nonraising retains; target strict flag raises | No application fragment rendered |
| Malformed Action Text HTML | Different HTML4/HTML5 tree/output | Not an inventory of persisted HTML or browser round-trip compatibility |
| Synthetic verifier cross-read with JSON 2 variant | New reads old; old fails new-profile; old reads target legacy-profile | Actual cookies/blob/GlobalID salts/policies still need testing |

### Remaining questions / boundaries

- Is there a real deployed environment beyond this sample? Its signing-key source, shared cache/storage mounts, PostgreSQL/Redis versions, deployment order, proxy headers, and worker fleet are unverified.
- What legacy YAML/rich-text values and long-lived scheduled/retry jobs actually exist? Only schema/code/fixtures and synthetic payloads were inspected, not live application data.
- Should reminder previews preserve the existing fixed offset or intentionally show the reader's correct post-DST wall time? The instant contract is clear; the display decision must be explicit.
- Can rollback to 7.0 remain supported, or may it stop at a prepared newer release? This determines when new durable signed-message formats are safe to write.
- No uses were found requiring an Active Record Encryption migration, SQLite handling, a custom ActiveStorage streaming-controller fix, Rails UJS migration, or new Solid infrastructure. The custom download controller inherits ApplicationController and uses `send_data`, not ActiveStorage::BaseController streaming.
- The app's existing public signed blob URLs, unauthenticated direct-upload surface, unattached blobs, and missing production mail configuration are documented pre-existing deployment concerns. They are not fixed by upgrading Rails, and are not included as unrelated implementation work in this plan.

## Primary upstream references

- [Rails 8.1.0 upgrade guide, including intermediate-version guidance](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html)
- [7.1.0 release notes](https://github.com/rails/rails/blob/v7.1.0/guides/source/7_1_release_notes.md)
- [7.2.0 release notes](https://github.com/rails/rails/blob/v7.2.0/guides/source/7_2_release_notes.md)
- [8.0.0 release notes](https://github.com/rails/rails/blob/v8.0.0/guides/source/8_0_release_notes.md)
- [8.1.0 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md)
- [Exact 8.1.0 default configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb)
- [Exact Action Pack gem dependencies](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec), [Railties dependencies](https://github.com/rails/rails/blob/v8.1.0/railties/railties.gemspec)

**Delivery state:** assessment/report and reproducible experiment evidence only. No application upgrade, source changes, committed changes, push, or deployment.
