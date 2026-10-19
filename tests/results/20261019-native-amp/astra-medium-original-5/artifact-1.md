# Margin Notes: Rails 7.0.8.7 → 8.1.0 upgrade assessment

## Decision and evidence boundary

**Do not deploy this as a Gemfile-only upgrade.** Use a compatibility release, then exercise 7.1 → 7.2 → 8.0 → exactly 8.1.0, initially retaining `config.load_defaults 7.0`. Adopt newer defaults separately. Several removals and behavioral changes apply even with 7.0 defaults.

This is a **source-based application assessment**, not a tested upgrade. I inspected the application, its locked dependencies, configuration, schema/migrations, and relevant tests, plus exact upstream release-tag sources. No application boot, dependency resolution, database preparation, test suite, browser, worker, or runtime experiment was executed. All validation below is proposed, not passed. Neither database contents nor production configuration nor queued payloads were inspected. No working application file was changed.

Baseline: [reviewed application revision](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). `Gemfile.lock` locks Rails 7.0.8.7, Ruby 3.3.6, Bundler 2.5.22, Sidekiq 6.5.12, redis 4.8.1, Rack 2.2.24, Puma 5.6.9, pg 1.6.0, Pagy 8.6.3, Faraday 1.10.4, concurrent-ruby 1.3.4, and Minitest 5.27.0. Rails defaults are explicitly 7.0. PostgreSQL, Redis-backed Sidekiq, Disk Active Storage, Action Text, Sprockets, and importmap are actual application dependencies.

The hosted `/v8.1/` guide currently identifies itself as 8.1.4, so final conclusions use **v8.1.0 tag sources**, not an assumption that the moving guide exactly describes 8.1.0. Exact 7.0.8.7, 7.1.0, 7.2.0, and 8.0.0 sources were also compared. Archived inputs and checksums are in `upstream/` and `evidence.txt` alongside this report.

## 1. Required code changes, independent of default adoption

“7.0-compatible” below means supported by the inspected 7.0.8.7 implementation, **not executed on that version**. Keep schema values and public behavior unchanged unless explicitly noted.

### R1 — Action Text allowlist initializer fails from 7.1

- **Affected:** `config/initializers/action_text.rb:3` does `ActionText::ContentHelper.allowed_tags += %w[ details summary ]`.
- **Change/condition:** From 7.1, `allowed_tags` and `allowed_attributes` default to `nil`; fallback allowlists are computed at rendering time. The existing addition to nil fails during initialization, even with 7.0 defaults. [7.1 Action Text changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).
- **Recommendation:** Explicitly derive the full allowlist from the chosen sanitizer's default tags plus `ActionText::Attachment.tag_name`, `figure`, and `figcaption`, then union `details`/`summary`. Preserve default attachment attributes; do not replace the allowlist with only the two extra tags. When adopting a different sanitizer vendor, derive the list after that vendor is selected, not from the earlier HTML4 instance.
- **7.0 preparation:** Yes, using the existing sanitizer/default tag APIs; the 7.1-only helper methods are not available on 7.0. A nil fallback around the existing list is sufficient for the initial retained-HTML4 upgrade.
- **Validation:** Boot with old defaults and with HTML5 selected. Render stored collapsible excerpts, a signed attachment, ordinary links, scripts, event attributes, and `javascript:` links. Assert safe content and attachment attributes remain and unsafe markup is removed. Existing server rendering test helps, but cannot prove browser edit/save preservation.

### R2 — Note enum syntax removed in 8.0

- **Affected:** `app/models/note.rb:10` uses `enum status: ..., _prefix: true`.
- **Recommendation:** Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. This preserves stored integers, `status_ready`, `status_draft?`, and form values. `Citation` and `Export` already use positional syntax.
- **7.0 preparation:** Yes; its `enum(name, values, **options)` supports this form.
- **Validation:** Load Note, read old draft/ready rows, filter the list by status, and save each status. Assert existing scope/predicate names, not merely successful class loading. [Removal](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_0_release_notes.md).

### R3 — Positional serializer removed in 7.2; don't change stored JSON

- **Affected:** `app/models/note.rb:12`, `db/schema.rb:99`: `serialize :tags, JSON` over text containing JSON arrays, default `[]`.
- **Recommendation:** On 7.1, switch to `serialize :tags, coder: JSON`. Do not change the coder or migrate this column as an incidental upgrade step.
- **7.0 preparation:** **No for the keyword-only substitution.** Rails 7.0 accepts extra keyword options but selects its coder from the second positional argument; `coder: JSON` is not its serialization API and can leave the YAML coder selected. Stage this edit after moving to 7.1, which supports both syntaxes. [7.0 implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [7.2 removals](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md).
- **Validation:** Use pre-upgrade raw rows containing `[]` and `["history","a & b"]`; read, edit, reload, inspect raw JSON, and read new writes in the rollback version. Fresh fixtures alone do not establish stored-data compatibility.

### R4 — `alias_attribute` cannot alias a JSON store accessor from 7.2

- **Affected:** `app/models/note.rb:13-14`: `color` is a `store_accessor` in `settings`, not a database column. Forms permit `highlight_color` and list rendering calls it.
- **Recommendation:** Replace `alias_attribute :highlight_color, :color` with explicit reader/writer delegation to `color` and `color=` (or method aliases after the accessor is defined). Do not add a new column or move JSON keys.
- **7.0 preparation:** Yes.
- **Validation:** Submit `highlight_color: "pink"`, reload, assert `settings["color"] == "pink"` and the rendered highlight; reject an invalid color without corrupting existing settings. [7.2 alias changes](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md), [removal of non-attribute aliases](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md).

### R5 — Citation configuration uses removed `Rails.application.secrets`

- **Affected:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, and its fresh-process credential test.
- **Change:** API deprecated in 7.1 and removed in 7.2. Dependency-injected settings can hide the default-constructor failure; real workers use the default constructor.
- **Recommendation:** Move provider settings to an application configuration file read with `Rails.application.config_for(:citation_provider)` or explicit application configuration. Preserve current environment names, development defaults, symbol keys, blank production configuration, and proper escaping of credentials. Remove the obsolete provider-only secrets configuration after migration. Do not copy values into tracked plaintext credentials.
- **7.0 preparation:** Yes; `config_for` exists. Preserve the injection argument used by tests.
- **Validation:** Fresh web/worker processes must send environment credentials containing punctuation unchanged to the local fake provider; test absent production URL, 401, and a successful lookup. Existing fresh-process test is useful. [Removal](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md). Production signing-key origin is a separate question in §3.

### R6 — Retry delay symbol removed in 7.2

- **Affected:** `app/jobs/citation_enrichment_job.rb:7`, `wait: :exponentially_longer`.
- **Recommendation:** On 7.1 change to `:polynomially_longer`; this is a naming correction, preserving the fourth-power delay and jitter. Keep three Active Job attempts and Faraday's one retry for 503, not Sidekiq retries for provider unavailability.
- **7.0 preparation:** **No** for the new symbol. Apply at 7.1; alternatively a callable implementing the identical delay including jitter works on both, but is unnecessary if staging through 7.1.
- **Validation:** Persistent 503 must produce six provider requests and a final failed citation. Inspect scheduled retries and their delay ranges as well as attempt count; an immediate test-adapter drain does not verify production timing. [7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

### R7 — Numeric `wait_until` no longer represents a supported scheduled time

- **Affected:** `app/models/note.rb:61`: `set(wait_until: reminder_epoch)` passes an Integer.
- **Change:** 7.0 converted this to a float; 7.2 removes numeric `scheduled_at` support. In 8.1 `set` assigns the value unchanged and serialization calls `scheduled_at.utc.iso8601`, so an Integer fails. [7.0 core](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/core.rb), [8.1 core](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).
- **Recommendation:** Pass `Time.at(reminder_epoch).utc`; retain the integer database field. Do not reinterpret existing stored epochs as local calendar times.
- **7.0 preparation:** Yes; `Time#to_f` gives the same queue timestamp.
- **Validation:** Schedule a non-round-second epoch (the existing 1,793,451,617 case is useful), JSON-round-trip the job through the real adapter, and assert its exact due instant. Execute superseded and current jobs and prove only the current job sends. Inventory scheduled/retry payloads rather than deleting or blindly re-enqueuing reminders.

### R8 — Multi-path route definition removed in 8.1

- **Affected:** `config/routes.rb:18`: `get "/notes", "/journal", to: "notes#index"`.
- **Recommendation:** Define two GET routes, preserving the canonical `notes_path` and the `/journal` bookmark alias. Check names against `resources :notes, except: :index`.
- **7.0 preparation:** Yes.
- **Validation:** Inspect route recognition/generation; request both URLs with filters/page size and verify the same authorized list. Existing list test covers both paths. [8.1 removal](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md).

### R9 — `form_with(model: nil)` removed in 8.0

- **Affected:** `app/views/notes/index.html.erb:14`, the unbound GET search form.
- **Recommendation:** Omit `model:`; retain URL, GET method, and unscoped field names.
- **7.0 preparation:** Yes.
- **Validation:** Assert GET `/notes`, query/notebook/status/per_page names and persistence across pagination; ensure no nested `note[...]` names appear. [Removal](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_0_release_notes.md).

### R10 — Export string concatenation uses removed `Enumerable#sum` behavior

- **Affected:** `app/models/export.rb:42`, `finish(fragments.sum)`.
- **Change:** 7.1 removes the Rails override that inferred a string identity; Ruby's zero identity cannot add these strings.
- **Recommendation:** Use `fragments.join` (or explicit string identity). Preserve ordering, blank lines, cancellation, and attachment completion order.
- **7.0 preparation:** Yes.
- **Validation:** Generate both empty and multi-note exports; compare exact Markdown bytes, filename, content type, cancellation state, and completed download. A queued job assertion alone misses this. [Removal](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_1_release_notes.md).

### R11 — Invalid imports can commit earlier rows instead of rolling back

- **Affected:** `app/models/import.rb:50-60`, non-local `return false` from a transaction after saving the Import and prior notes/citations/rich text.
- **Change:** 7.1 defaults can opt into commit on non-local return; 7.2 removes rollback-on-return behavior. Keeping 7.0 defaults does **not** preserve the behavior on 7.2/8.1. [7.1 rationale](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2 removals](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md).
- **Recommendation:** Explicitly raise `ActiveRecord::Rollback` when a row fails, and return false after the transaction based on a success flag/result. Do not leave the trailing unconditional `true`, and do not merely prevalidate rows: save-time failures still need rollback. Keep the row errors for preview rendering.
- **7.0 preparation:** Yes. No data migration is required for the fix.
- **Validation:** Valid first row with new DOI and rich text, invalid second row: no Import, Note, Citation, or rich-text row persists. Also validate a failure at save time and a fully successful batch. The existing invalid-second-row test is discriminating; a preview-only test or invalid-first-row case is not enough. Stop rollout if partial imports are observed; rollback cannot automatically reconstruct intended batches from partial writes.

### R12 — Receipt lookup of a custom primary key changes in 7.2

- **Affected:** `app/models/import.rb:68` uses `citation[:id]`; `citations` has primary key `doi` and no `id` column.
- **Recommendation:** Use `citation.doi` (or `citation.id`, which represents the declared primary key), retaining nil for uncited rows.
- **7.0 preparation:** Yes.
- **Validation:** Import a mixed-case DOI and a no-DOI row; inspect exact downloaded CSV and sharing of identical DOI records. Existing receipt test covers a DOI but add the uncited contrast. [7.2 removal](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md), [8.1 attribute reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb).

### R13 — Import preview loses annotations when integer keys are stringified in 8.0

- **Affected:** `app/models/import.rb:38-41` builds an indifferent hash keyed by integer line numbers; `app/views/imports/preview.html.erb:22,42-44` stringifies it, then still indexes with integers.
- **Change:** In 7.0 `HashWithIndifferentAccess#stringify_keys` only duplicates the hash; in 8.0 it actually converts integer keys to strings. Indifferent access only treats Symbols/Strings interchangeably, not Integers. [8.0 changelog](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).
- **Recommendation:** Remove the unnecessary `.stringify_keys` and keep integer source-line keys throughout this internal view path.
- **7.0 preparation:** Yes.
- **Validation:** Include a blank line and a quoted multiline CSV body so rows begin on unequal source lines; assert the annotation text on the right row, including literal HTML characters. Existing import test already provides useful inputs. This affects preview display, not the persisted annotation column.

### R14 — Digest arguments change both calendar semantics and queue format

- **Affected:** `app/models/user.rb:34-56`, `app/jobs/digest_job.rb`, `app/mailers/digest_mailer.rb:7-10`. Redis reservation is keyed by UTC date; the mailer derives date/range from the deserialized zoned argument.
- **Time change:** Rails 7.2 preserves the original TimeWithZone zone. New payloads from an Eastern reader at October 4 23:30 (October 5 03:30 UTC) now select October 4 locally, while the reservation and UI promise October 5 UTC. Legacy payloads lack `time_zone` and still fall back to the worker/job zone. This applies regardless of `load_defaults`. [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).
- **Decimal change:** Rails 7.1 adds a BigDecimal serializer (initially opt-in); 7.2 always uses it. New typed payloads reference `ActiveJob::Serializers::BigDecimalSerializer`, absent on 7.0. A new producer/old consumer, including rollback to a 7.0 worker, can fail deserialization. Old JSON payloads contain decimal strings; new workers can still pass those to the existing `BigDecimal(...)` conversion. [7.1 compatibility warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md).
- **Recommendation:** Before upgrading, normalize `requested_at` to UTC inside `DigestMailer#daily_digest` before both `to_date` and `all_day`. Serialize completion explicitly as `reading_completion.to_s("F")` from producers to keep a primitive stable queue contract. Optionally send request time as UTC too, but consumer normalization is needed for already queued time-zone-bearing messages.
- **7.0 preparation:** Yes for UTC normalization and decimal-string arguments. Existing BigDecimal/String inputs remain accepted. Do not change the digest reservation to a local date as a framework migration side effect.
- **Validation:** Execute real JSON payloads in all producer/consumer directions with same UTC instant but different local dates, notes on both sides of UTC midnight, and completion `0.6667` (not just 0 or 1). Include a legacy no-`time_zone` payload and a typed decimal payload. Assert content date, selected notes, percentage, reservation behavior, and successful retries. Existing tests cover the UTC/local boundary but use the Active Job test adapter, not Sidekiq JSON or an old worker.

### R15 — Reminder DST preview changes unconditionally in 8.1

- **Affected:** `app/models/note.rb:43-44`, `reminder_at.to_time + 86_400`, and `test/controllers/reminders_controller_test.rb`'s fixed-offset expectation.
- **Change:** 7.0 preserves a fixed offset; 8.1 `TimeWithZone#to_time` preserves the full zone. Across the November 1, 2026 fall-back, October 31 09:00 Eastern + 86,400 seconds is November 1 08:00 -05:00, rather than the old preview's 09:00 -04:00. The epoch is unchanged. This is not fixed by retaining 7.0 defaults. [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb), [8.1 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md).
- **Recommendation:** Keep the documented 24 elapsed hours. Prefer explicitly computing `reminder_at + 86_400` and accepting the correct reader-zone preview; do not substitute calendar-day arithmetic. Update the preview test/docs as an intentional display correction. If exact legacy offset display is required, explicitly create a fixed-offset Time instead.
- **7.0 preparation:** Both explicit choices work on 7.0; choosing zone-aware output intentionally changes the current preview, not the stored instant.
- **Validation:** Test spring-forward and fall-back with local clock/offset and exact epoch assertions. Existing scheduled jobs keep their original due instants; don't reschedule them just because rendering changes.

### R16 — Test exception setting must use the symbolic API from 7.1

- **Affected:** `config/environments/test.rb:31`, `show_exceptions = false`, and many `assert_raises(ActiveRecord::RecordNotFound)` request tests.
- **Change:** Boolean support was removed in 7.2. In 8.1 `false` falls through to rendering exceptions; it is not equivalent to `:none`. [8.1 wrapper](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb).
- **Recommendation:** Change to `:none` after reaching 7.1. Keep explicit production-like `:rescuable`/`:all` checks separate when testing rendered 404/500 responses.
- **7.0 preparation:** **No** as a drop-in substitution: 7.0's false-based check does not give `:none` the new meaning.
- **Validation:** Missing and other-reader records must raise under the normal test config; in a separate production-like config they must return the intended HTTP status without revealing data. Don't “fix” failures by weakening authorization assertions.

## 2. Optional defaults: changes required only when adopting them (plus one cache caveat)

Keep these decisions separate from the framework version bump. The authoritative defaults are in [v8.1.0 application configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).

### D1 — Explicit YAML coder before 7.1 defaults

`Notebook#preferences` (`app/models/notebook.rb:7`) is serialized YAML text. `load_defaults 7.1` sets `active_record.default_column_serializer = nil`, so its implicit coder then fails. On 7.1+, declare `serialize :preferences, coder: YAML`; keep YAML, don't switch to JSON without a separate dual-read/data migration/rollback plan. Keyword coder configuration is not the 7.0 API (R3); apply it at the 7.1 stage. Validate existing raw YAML with string-keyed export headings, nil/empty preferences, edits, and rollback reads. Confirm actual stored types before adding a `type: Hash` restriction. No such restriction is needed merely to upgrade.

### D2 — Readonly slug assignment raises, even when unchanged

7.1 defaults set `raise_on_assign_to_attr_readonly = true`. `Notebook` declares `attr_readonly :slug`, while the settings form submits a hidden slug and `NotebooksController#notebook_params` permits it. The [write guard](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/readonly_attributes.rb) checks assignment, not changedness. Even resubmitting the same slug raises. Remove the hidden field and stop permitting slug; keep model readonly protection and creation-time derivation. This preparation works on 7.0. Validate ordinary settings submission, forged unchanged/changed slug parameters, and automatic slug creation. Existing notebook tests need their hidden-field expectation updated but should retain the immutability assertion.

### D3 — PostgreSQL raw DATE results become Date objects under 7.2 defaults

`Notebook#daily_note_counts` (`app/models/notebook.rb:38-40`) assumes `select_rows` returns a string and calls `Date.iso8601(day)`. `postgresql_adapter_decode_dates = true` returns Date objects for raw DATE columns. Recommendation: normalize with `Date.iso8601(day.to_s)` or use a query interface with a stable typed contract; retaining explicit false is a temporary alternative. The normalization works on 7.0 too. Validate actual PostgreSQL rows (not mocked rows), UTC midnight on two different dates, unequal counts, empty notebooks, and isolation from other notebooks. The existing activity report test is relevant. [Adapter configuration](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb).

### D4 — Expired export fragment TTL needs fixing even if exceptions are disabled

`app/views/exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, negative after expiration. 7.1 defaults raise on invalid negative TTL. **With retained 7.0 defaults, 8.1 instead reports/logs the invalid TTL and drops it; it does not preserve the old immediate-expiry behavior.** Thus an expired fragment can lose its intended TTL. [Cache implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb).

Fix before the upgrade: never pass a negative TTL. For the smallest behavior-preserving change, clamp to zero; alternatively render expired exports outside the expiring fragment. `expires_at:` alone does not fix this because 8.1 computes a relative TTL and validates it too. Both recommended approaches work on 7.0. Validate cache-enabled first render/hit, immediately before expiry, exact expiry, and cold/warm renders after expiry; assert no exception and no stale download authorization. The download controller correctly checks ownership/expiry before conditional HTTP caching—preserve that separation. The existing cache test helps but ordinary tests with caching off do not cover it.

### D5 — Conditional downloads prefer ETag under 8.0 defaults

`ExportDownloadsController#show` calls `stale?` with ETag and Last-Modified. `strict_freshness = true` changes combined-header evaluation to prefer If-None-Match; old behavior required both supplied validators to agree. Recommendation: adopt intentionally after checking clients, keeping authorization and expiry checks first. Retaining false is possible. No pre-upgrade code change is required; new default configuration is version-gated. Validate an unexpired export with a matching ETag but stale If-Modified-Since (new 304 vs old 200), nonmatching ETag plus fresh date (200), and matching validators after expiry (redirect, never 304). Existing tests don't exercise conflicting validators. [Implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb).

### D6 — HTML5 sanitization and Trix asset alignment are separate decisions

7.1 defaults choose HTML5 sanitizers where supported; retaining 7.0 defaults retains HTML4. Test malformed nested rich HTML, links, collapsible excerpts, attachment markup, and Markdown plain-text export before changing the parser; differences can affect existing stored content without any database rewrite.

Rails 8.1 changes the bundled editor dependency to `action_text-trix ~> 2.1.15`. This app **still explicitly executes vendored Trix 1.3.5** (`app/views/layouts/application.html.erb:13`); a gem update won't replace that script, while `@rails/actiontext` and Trix CSS can change underneath it. [8.1 gemspec](https://github.com/rails/rails/blob/v8.1.0/actiontext/actiontext.gemspec), [changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

Recommendation: make and test an explicit editor choice. Prefer the Rails-supported Trix 2 asset path, loading exactly one Trix build and matching CSS; remove the old workaround only after verification. This is not established to be a boot requirement, and Trix 1 compatibility with the new Action Text client has not been executed. Do not assume Trix 2 solves `details`/`summary` preservation. The current architecture explicitly documents flattening on editor save.

Validation: build production Sprockets assets; open a pre-upgrade rich note with a link and attachment, edit tags/highlight/body, save, reload, inspect stored HTML and signed attachments, and repeat in the rollback browser/server combination. Test direct upload and the >1 MB rejection. Preserve originals before editor conversions: restoring code doesn't undo rewritten HTML. Moving to Trix 2 on Rails 7.0 requires its own compatibility check, not an assumed safe preparation. `test/system/` is empty; running that suite as-is would not exercise this workflow.

## 3. Mixed-version rollout, persistent formats, and queue semantics

### M1 — Stable signing keys and old-readable message formats

Sessions store a user ID, and Active Storage blob URLs plus Action Text embedded SGIDs depend on signed messages. SGIDs are durable content, not merely short-lived session cookies.

- Rails 7.1 renames the local development/test key file from `tmp/development_secret.txt` to `tmp/local_secret.txt`. For an existing local environment, preserve the old key under both names during the overlap/rollback period rather than silently regenerating it or moving away the only copy needed by 7.0. Do not print or archive its contents. [Upgrade guide](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md).
- Production secret origin is unverified. The checked-in provider secrets file does not establish how deployment supplies `secret_key_base`. Preserve the same key through credentials or environment; if a deployment relied on secrets.yml, migrate that source too before 7.2. Coordinate web and workers. A framework upgrade is not a key-rotation project.
- 7.1 defaults change `message_serializer` to `:json_allow_marshal` and `use_message_serializer_for_metadata` to true. New metadata envelopes are explicitly unreadable by pre-7.1 Rails; new readers accept old envelopes. Keep legacy serializer/metadata settings until no 7.0 reader or rollback target remains. Configuring the new options belongs on 7.1+, not as an assumed 7.0-compatible switch. Cookies already use JSON under this app's 7.0 defaults; changing the generic message serializer is not the same as changing the cookie serializer. [Versioned format guidance](https://github.com/rails/rails/blob/v8.1.0/guides/source/configuring.md).
- Validate 7.0-written session cookies, blob signed IDs, and attachment SGIDs in 8.1; validate newly written equivalents in the rollback app using the **same synthetic key**. Include real attachment rendering and retrieval, not only signature generation. Verify new signatures cannot bypass ownership assumptions. Keep legacy formats or implement a separately reviewed bridge if rollback below 7.1 must remain possible after enabling new writers.

### M2 — Cache serialization is a separate rollout switch

7.0 and 7.1 cache formats are both supported by 8.1. Keep `cache_format_version = 7.0` through the mixed fleet/rollback window. Enabling 7.1 writes new-format entries older 7.0 processes aren't designed to read; new readers can read old entries. Production does not configure a custom cache store in this checkout (framework FileStore is the normal fallback); verify the real deployed store/mount/namespace rather than treating Redis used by Sidekiq as the cache. Development MemoryStore is per-process and test normally uses NullStore.

Validation: cross-read old/new fragment entries on an isolated store and exercise expiry plus an unauthorized viewer. When changing format, use a new cache namespace or controlled eviction limited to this app's cache if needed—**not Redis FLUSHALL**, which would destroy jobs and digest reservations. Cache data is disposable; stored attachment SGIDs are not.

### M3 — Enqueue-after-commit is not automatically the 8.1 behavior here

`Citation#request_enrichment` and `Note#schedule_reminder` enqueue while holding row locks and rely on an enqueue failure rolling back database state. `Notebook#request_export` intentionally commits an Export before native Sidekiq enqueue. `User#request_digest` compensates Redis reservation on enqueue failure.

7.2 defaults enable adapter-based transaction deferral; 8.1 has a per-job **boolean** `enqueue_after_transaction_commit` defaulting to **false**, and removes the old symbolic values/global configuration. The reviewed `ApplicationJob` does not override it. Do not blindly copy `:always`, `:never`, or `config.active_job.enqueue_after_transaction_commit` from intermediate upgrade examples. [7.2 defaults](https://github.com/rails/rails/blob/v7.2.0/railties/lib/rails/application/configuration.rb), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb).

Recommendation: retain immediate enqueue semantics for the initial upgrade; explicitly set per-job false on 8.1 if documenting the contract is useful. This setting isn't the 7.0 API; the old behavior needs no setting there. Deferring later is an intentional redesign: a Redis failure after commit cannot roll back pending citation/reminder state, even if `perform_later` previously returned a job object. Native `ExportJob` is not governed by Active Job's setting.

Validation: non-fixture-transaction integration runs with a separate worker/DB connection; queue failure before commit, worker racing the producer, outer rollback, replacement reminder, and deferred enqueue failure if adopting that mode. Test that pending statuses, stored job IDs, Redis reservations, and sent emails reflect the chosen contract. Test adapters and transactional fixtures do not establish cross-process ordering.

### M4 — Preserve the full backlog through upgrades and rollback

Before rollout, inventory default queues, scheduled jobs, retries, and dead jobs, including Rails-generated Active Storage jobs. Long-future reminders cannot be handled by just waiting for the immediate queue to empty. Retain job classes, argument order, GlobalID application name, wrapper class compatibility, and persisted reminder IDs. Native `ExportJob` already uses numeric ID plus JSON string-keyed options; keep its format stable.

Deploy R14's primitive decimal producer and UTC-normalizing consumer on 7.0 first. Prefer worker-first upgrades after proving new workers can consume old payloads; this still isn't permission for new producers to send typed arguments to remaining old workers. For rollback, stop incompatible producers/consumers, inspect all pending formats, and use compatible consumers or a reviewed payload migration before returning to 7.0. Do not discard queued work to make a deployment succeed; re-enqueuing without preserving job identity can suppress reminders or duplicate deliveries. Already delivered email and partially committed imports are not undone by code rollback.

## 4. Dependencies and scope

- **Ruby:** 3.3.6 satisfies Rails 8.1.0's >=3.2 requirement. A Ruby upgrade is not required for this request; keep it separate.
- **Rails family:** Update all locked Rails components consistently, regenerate the lockfile, and review actual transitive changes. Rails 8.1 adds dependencies including `action_text-trix`; no target bundle was resolved in this assessment.
- **Do not invent a mandatory Rack 3 / Sidekiq upgrade:** 8.1.0 Action Pack declares Rack >=2.2.4, while current Sidekiq pins Rack ~>2.0. `rack-session 1.0.2` and `rackup 1.0.1` have Rack <3 variants satisfying Rails' declared lower bounds. This is source evidence that Rack 3 is not inherently required, **not a successful full-bundle resolution or runtime certification**. [Action Pack gemspec](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec), [Railties gemspec](https://github.com/rails/rails/blob/v8.1.0/railties/railties.gemspec), [rack-session metadata](https://rubygems.org/api/v2/rubygems/rack-session/versions/1.0.2.json), [rackup metadata](https://rubygems.org/api/v2/rubygems/rackup/versions/1.0.1.json).
- **Sidekiq:** The 8.1 built-in adapter remains and declares Sidekiq >=4.1.0, but is deprecated for removal in 8.2; its warning recommends Sidekiq >=7.3.3. Sidekiq 6.5.12's `on(:quiet)` API exists in the inspected installed source. Retaining it is a bounded compatibility strategy pending executed checks, not a support/security endorsement. A separate Sidekiq modernization must review Redis version/client APIs, `sadd` truthiness, strict JSON args (including Export's symbol-keyed options before encoding), error classes, wrappers, and retry/scheduled data. Do not silently combine it with this Rails change. [8.1 adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).
- **Puma 5/Rack 2:** Keep initially if resolution permits, but test actual server startup, Rack middleware, cookies, CSRF, multipart CSV uploads, download headers, and redirects. Gem dependency acceptance alone is insufficient.
- **Other pins:** concurrent-ruby 1.3.4 satisfies 8.1's declared >=1.3.1; don't remove the current compatibility pin during the 7.0 preparation. Keep Minitest 5 during the transition. Retain Faraday 1, pg, Pagy, Sprockets, importmap, Turbo, and Stimulus unless resolution or an observed failure requires otherwise. Verify assets and Pagy behavior on the resolved bundle.
- **Do not adopt new-app architecture incidentally:** Solid Queue/Cache/Cable, Propshaft, authentication generator, Kamal, and Docker are not requirements for upgrading this existing app. No Active Record `encrypts`, custom autoload-path requires, SQLite, Azure storage, or custom Active Storage streaming controller was found, so those common upgrade items have no evidenced application change here.
- **Schema:** Keep historical migrations versioned `[7.0]`. 8.1 alphabetizes schema columns; don't confuse dump-order churn with a data migration. Existing Active Storage tables include service_name and variant records. Inspect upstream engine migration needs during the actual upgrade; do not reinstall Action Text or rerun the plaintext conversion on existing data. Newer migration timestamp checks require an appropriately dated CI clock; the October 11, 2026 filenames are not future-dated relative to this review.
- **Security boundary:** Public signed Active Storage access, direct-upload abuse protection, unattached/expired file cleanup, and missing production mail transport are documented pre-existing limits, not regressions proved by this upgrade. Do not claim the Rails upgrade fixes them. Exact 8.1.0 is the requested assessment target; production release approval should separately review later security patches rather than assume an initial minor release is current.

## 5. Concrete delivery and validation sequence

1. **Disposable baseline:** Create a clean copy of the reviewed revision. Configure isolation *before* booting anything: unique PostgreSQL database names for each variant and parallel worker, a dedicated disposable Redis instance (or verified unused logical DB plus variant-specific queue/key namespaces), distinct Disk storage/cache/mail/log directories, synthetic signing keys, and loopback fake provider. Never run the supplied setup/db:prepare against inherited development defaults. No copied real credentials or links to live storage. Confirm both subprocesses and the Sidekiq worker inherit isolation. Database URL alone does not isolate Redis or Disk resources.
2. **7.0 compatibility release:** R2, R4, R5, R7-R15 as applicable, including the explicit rollback, stable digest queue contract, and cache TTL fix. Prepare R1 without changing sanitizer vendor. D2/D3 can be prepared without adopting defaults. Verify on 7.0. Preserve current serialization declarations until 7.1; do not prematurely use the new retry symbol or symbolic test exception API. Treat the DST preview correction as a separately visible behavior choice.
3. **Incremental framework stages:** Following the [versioned upgrade guide](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md), use supported patch releases at each intermediate minor as appropriate, with exact versions recorded. At 7.1 switch serializer keywords, retry symbol, and `show_exceptions`. Keep 7.0 defaults. Run `app:update` only in the disposable copy and review changes rather than accepting generator overwrites. Then evaluate 7.2, 8.0, and exact 8.1.0, preserving the same synthetic legacy data and job fixtures across variants.
4. **Checks for each resolved variant:** `bundle check`, `bin/rails zeitwerk:check`, `bin/rails test`, production-mode boot/server and asset compilation, then browser workflows. `bin/rails test:system` currently has no actual tests in `test/system`; implement/exercise meaningful editor and upload flows before claiming browser coverage. Use an isolated real Sidekiq process for R6/R7/R14/M3; fake/test adapters alone do not satisfy queue serialization and ordering checks.
5. **Cross-version gate:** Execute old-writer/new-reader and new-writer/rollback-reader cases for serialized columns, sessions, SGIDs/blob URLs, cache fragments, queued/retry/scheduled jobs. Test with `load_defaults 7.0`, then each selected new default independently; the distinction must be in test records. Snapshot synthetic raw rows and payloads before and after. Do not enable new message/cache formats while 7.0 remains a supported rollback reader.
6. **Production rollout after approval:** Back up durable DB/storage and signing material securely; capture backlog counts/formats without logging sensitive bodies. Deploy compatible consumers/producers in the validated order. Observe boot errors, deserialization failures, pending citation/reminder states, import partial writes, email day/content, attachment rendering, download expiry, and cache errors. Only then adopt defaults in separately reversible releases. Set a rollback floor before enabling irreversible-to-old-readers formats or editor rewrites.

### Required experiment record (future work; no entries claimed executed)

For every baseline, intermediate, target-old-defaults, target-new-defaults, and rollback variant retain: source revision and patch; exact command and exit status; Ruby/Bundler versions; complete resolved Gemfile.lock; sanitized effective configuration (load_defaults, serializer/metadata/cache modes, queue adapter and transaction setting, sanitizer/editor versions, DB/Redis/storage/cache isolation identities); synthetic input rows and queue payloads; assertions/output; and paths to stdout/stderr, Rails logs, Sidekiq logs, provider requests, mail files, and browser captures. Store these under a unique variant directory, not a shared log overwritten by the next run. Never retain actual secret values.

## Remaining questions / release gates

- What are the actual production PostgreSQL/Redis versions, cache store/mount, signing-key source, queue topology, and shared Disk-storage arrangement?
- Must rollback remain possible all the way to Rails 7.0 after enabling new defaults, or can its floor advance to 7.1+?
- What serialized YAML values, attachment SGIDs, and job argument formats already exist in durable data/backlogs? No production data scan was performed.
- Should the DST preview intentionally retain its old offset display, or adopt reader-zone-correct output while preserving 24 elapsed hours?
- Can the current Puma/Sidekiq/Rack combination resolve and execute all flows with exactly Rails 8.1.0? Source constraints permit a plausible narrow path; only a resolved and executed variant can settle it.

**Delivery state:** assessment and evidence artifacts only. No upgrade implementation, runtime verification, commit, push, merge, or deployment.
