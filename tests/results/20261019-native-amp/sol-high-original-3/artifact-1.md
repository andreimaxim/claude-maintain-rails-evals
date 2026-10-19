# Margin Notes: Rails 7.0.8.7 → 8.1.0 evaluation

## Recommendation

**Feasible, but not a Gemfile-only upgrade.** Upgrade the runtime in minor-version checkpoints (7.1 → 7.2 → 8.0 → exactly 8.1.0), initially retaining `config.load_defaults 7.0`. Make compatibility fixes first; adopt newer defaults separately. Do not combine this with a Ruby, Rack-major, Sidekiq-major, asset-pipeline, or queue-backend migration.

No working-application files were changed. All executions were in disposable checkouts backed by a dedicated PostgreSQL instance, dedicated Redis instance, and checkout-local cache/storage. Experimental changes below are evidence, **not an implemented or deployable upgrade**. No commit, push, deployment, or shared database change was performed.

Reviewed source: [repository snapshot](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7), its locked dependencies, configuration, controllers, models, jobs, views, schema/migrations, and tests. Current Ruby is 3.3.6, Rails defaults 7.0, PostgreSQL, Sidekiq 6.5.12 / redis-rb 4.8.1, Sprockets/importmap, Action Text, Disk Active Storage. Rails 8.1.0 requires Ruby ≥3.2; this Ruby already qualifies.

### Evidence summary

| Executed variant | Result | Evidence in this directory |
|---|---|---|
| Original application, Rails 7.0.8.7 | 46 tests, 325 assertions, no failures/errors | `baseline-tests.log`, `baseline.Gemfile.lock` |
| Only Rails pin changed to 8.1.0 | Bundle resolves; application boot fails at Action Text initializer | `target-bundle.log`, `target-initial-boot.log`, `target.Gemfile.lock` |
| Experimental compatibility fixes, Rails 8.1.0, defaults 7.0, JSON <3 | 46 tests, 340 assertions, no failures/errors; one DST display expectation deliberately updated | `target-tests-runtime-fixed-final.log`, `target-final.diff`, `target-json2.Gemfile.lock` |
| Same repaired runtime with defaults 8.1 | First fails boot for missing preferences coder. After explicit YAML coder: 46 tests, 325 assertions, 3 errors (readonly slug, raw date, negative cache lifetime) | `defaults-initial-boot.log`, `defaults-tests.log`, `defaults-final.diff` |
| Repaired target eager loading and production asset build | Both succeed | `target-final-zeitwerk.log`, `target-production-assets.log` |
| JSON argument compatibility, actual Redis enqueue/retrieval, signature/cookie probes | Detailed below; not a full separate-worker/shutdown test | `*-probes.log`, `*-cross-read.log`, `*-queue-probe.log`, `*-signatures-final-read.log`, `*-cookies.log` |

Passing the repaired suite is not completeness: its Active Job test adapter skips Sidekiq's JSON transport, it has no concrete browser system tests, and most tests disable caching. Actual deployed data, jobs, secrets and infrastructure were not inspected.

## 1. Required runtime compatibility changes (independent of adopting new defaults)

“7.0-compatible” below is source-based unless a specific execution is identified. Do not apply newer configuration or serializer syntax to 7.0 merely because Ruby accepts its keywords.

### R1 — Repair Note declarations without changing stored data

Affected: [Note lines 10–14](file:///home/user/workspace/repo/app/models/note.rb#L10-L14), note forms, digest ready-note query.

- Rails 8 removes keyword-style enum definitions. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`; retain integer mappings and generated `status_ready`/`status_draft` names. **Works on 7.0**, as already demonstrated by the positional enums in Citation/Export.
- Rails 7.2 removes the positional coder argument. On 7.1+, use `serialize :tags, coder: JSON`; retain JSON in the existing text column, including `[]`, not YAML or JSONB. **Not a valid 7.0 preparatory substitution:** 7.0's positional implementation ignores a `coder:` keyword for coder selection and defaults to YAML. Schedule this syntax change at the 7.1 checkpoint, or use an explicitly tested temporary version branch only if one source tree must run both versions.
- Rails 7.2 rejects `alias_attribute` targeting a non-column. `color` is a JSONB store accessor, not a column. Define getter/setter forwarding to `color`/`color=`, or use both `alias_method` forms after `store_accessor`. **Works on 7.0.** Do not alias to `settings` or turn color into a new database attribute.

Observed: target boot failed separately for enum and serializer; model attribute initialization then failed for the alias. Validate existing JSON rows, blank/multiple tags, changed/cleared highlights, invalid colors, and prefixed status scopes through create/update/reload. Existing note request tests cover much of this; add a historical raw JSON-row read/write/rollback check. No data migration should be needed if the format is preserved.

Sources: [7.2 removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-record), [8.0 removals](https://guides.rubyonrails.org/v8.0.0/8_0_release_notes.html#active-record), [7.0 serializer implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serializer implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb).

### R2 — Preserve import atomicity explicitly

Affected: [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L61).

Rails 7.2 makes a normal non-local `return` from a transaction commit rather than roll back; retaining 7.0 defaults does not retain that behavior. A valid first CSV row followed by an invalid second row currently relies on the rollback-on-return implementation. On the target it returns false **after committing the import and first note/rich text/citation**.

Recommendation: explicitly raise `ActiveRecord::Rollback` on a failed row save inside the transaction, return true inside the transaction only on complete success, and return false when it rolls back. Preserve row validation errors for the preview. **Works on 7.0.** Merely changing `return` to `break` does not express rollback.

Executed outside the test suite's outer transaction: baseline false with changes `[0,0,0]`; target false with `[1,1,1]` for import/note/rich-text counts (`*-probes.log`). The existing invalid-import request test also fails once its earlier preview failure is repaired. Keep that valid-first/invalid-second input; verify all four relevant tables, including newly created citations, remain unchanged and that a fully valid file persists all rows. Audit any partial imports created by an attempted upgrade before replaying them; do not blindly reimport duplicates.

Sources: [7.1 transaction change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2 removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-record).

### R3 — Preserve import preview annotations and DOI receipts

Affected: [preview line 22](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L45), [Import#annotations and #receipt](file:///home/user/workspace/repo/app/models/import.rb#L37-L69), string-primary-key `citations.doi` in the schema.

Two independent changes:

1. Rails 8 fixes `HashWithIndifferentAccess#stringify_keys` to stringify integer keys too. Preview looks up `annotations[row.line]` with an integer, so annotations disappear. Remove the unnecessary `.stringify_keys` and retain integer keys, or consistently use strings at both boundaries. **Removing the conversion works on 7.0.** Probe: key 2 remains accessible after conversion on 7.0, but not on 8.1.
2. Rails 7.2 removes `record[:id]`'s custom-primary-key fallback. `citation[:id]` now returns nil because the column is `doi`, not `id`. Use `citation.doi` (most explicit), or `citation.id`. **Both work on 7.0.** Preserve exact case-sensitive DOI values; do not add a surrogate ID to fix this API use.

Validation: two nonidentical annotations on physical CSV lines 2 and 4 (blank/multiline input), plus CSV receipts for mixed-case DOI values, shared citations and a row without a citation. Existing import tests cover the main populated case; extend rather than duplicate them.

Sources: [8.0 Active Support change](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md), [7.2 Active Record removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

### R4 — Repair route, filtering and unbound form contracts

Affected: [routes line 18](file:///home/user/workspace/repo/config/routes.rb#L17-L19), [NotesController#index line 12](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L7-L18), [notes search form](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12).

- Rails 8.1 removes one route declaration for multiple paths. Split `/notes` and `/journal` into separate `get` declarations, retaining `notes_path` and the bookmark alias.
- Rails 7.2 removes plural references to singular associations: change `where(notebooks: @notebook)` to `where(notebook: @notebook)` or `where(notebook_id: @notebook.id)`. Target currently generates `notes.notebooks`, which PostgreSQL rejects.
- Rails 8 removes explicit `model: nil` in `form_with`. Omit `model:` for this unbound GET search form, or use `model: false`.

**All three can be prepared on 7.0.** Executed target failures confirm each affected path. Validate both list URLs, all combined filters and pagination/overflow/per_page preservation, another reader's notebook, and search submission with no model-bound parameter nesting. Existing notes tests already distinguish these cases; no Pagy upgrade is required.

Sources: [8.1 Action Pack removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#action-pack), [7.2 Active Record removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-record), [8.0 Action View removals](https://guides.rubyonrails.org/v8.0.0/8_0_release_notes.html#action-view).

### R5 — Migrate provider configuration; preserve error/retry behavior

Affected: [Citation::Provider initializer](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15), [secrets.yml](file:///home/user/workspace/repo/config/secrets.yml), provider test helper and fresh-boot environment test, [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L1-L12).

`Rails.application.secrets` was removed in 7.2. Move these environment-backed settings to `config.x.citation_provider` or a dedicated `config_for` file; read them from the provider and update the test boundary consistently. Preserve symbol keys, blank-production behavior and development/test defaults. This is not a request to decrypt credentials or move actual secret values into code. A `config.x` environment-backed configuration **works on 7.0**. After all references move, remove the app-owned obsolete `secrets.yml` and update its setup/docs references in the actual implementation.

Replace `wait: :exponentially_longer` with `:polynomially_longer` on 7.1+. Same fourth-power backoff and jitter, not a different exponential algorithm. **The new symbol does not work on 7.0.** If it must be prepared there, use a tested Proc implementing the current `(executions**4) + rand * (executions**4) * 0.15 + 2`, otherwise make the rename at the 7.1 checkpoint.

Validation: keep the fresh child-process environment test with quotes/colons/newlines in the dummy password; check exact Basic auth at a loopback provider, no-provider error, permanent 401/404, malformed JSON, transient 503, and all three job attempts with one HTTP retry each. Execute the failing-provider path, not only enqueueing. Existing tests expose `secrets` removal but it masks the retry-wait failure until repaired. Already queued citation jobs keep their class/GlobalID and exception execution counters; retain those names and retry declarations while migrating.

Sources: [7.2 Railties and Active Job removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [7.1 backoff clarification](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md).

### R6 — Treat scheduling and time representation as separate changes

Affected: [Note#schedule_reminder and #next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L72), [reminder preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb), reminder tests.

- Numeric `wait_until: reminder_epoch` no longer works after numeric `scheduled_at` support is removed in 7.2. Pass `Time.at(reminder_epoch).utc`; retain the bigint epoch in PostgreSQL. **Works on 7.0.** Target execution raised `undefined method utc for Integer`.
- In Rails 8.1 `TimeWithZone#to_time` preserves the named zone, not just its offset; the old configurable behavior is removed even under defaults 7.0. Current preview across US fall-back changes from `2026-11-01 09:00 -04:00` to `2026-11-01 08:00 -05:00`, but both represent epoch **1793538000**, exactly 24 elapsed hours after the original reminder. This is not a one-hour scheduling bug.

Recommendation: retain the 24-elapsed-hours product contract and use `reminder_at + 86_400` explicitly, so the preview shows the actual zoned local time on both Rails versions. **Works on 7.0 but deliberately changes its old display.** Alternatively preserve the old fixed-offset display explicitly with a fixed-offset `Time` if that is desired; do not switch to a calendar-day advance without a product decision. The experimental target adopted the actual-zone display and updated that one existing expectation.

Validation: both spring-forward and fall-back, asserting epoch and wall-clock/offset independently; nonexistent/ambiguous local input; imported numeric timestamps including seconds; obsolete job suppression and a deleted note; real Sidekiq schedule score/job identity and queue rejection inside the row lock. Existing tests exercise fall-back display and schedule but not a separate worker's scheduled queue.

Sources: [7.2 scheduled_at removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 time_with_zone implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

### R7 — Pin the digest's UTC day explicitly, and protect queue compatibility

Affected: [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L27-L56), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L1-L12).

Rails 7.2 preserves the serialized time zone of `TimeWithZone` arguments. At 2026-10-05 03:30 UTC / October 4 23:30 Eastern, old workers interpret October 5 UTC, while new workers use October 4 Eastern. Without a change, the Redis reservation is still for October 5 but the new mailer selects October 4's notes. The existing digest test actually catches this (target subject changed to October 04); the behavior is not protected by retaining framework defaults.

Recommendation: normalize `requested_at = requested_at.utc` in the mailer before deriving both the date and `all_day`. Also make producer arguments transport-neutral: pass `reading_completion.to_s("F")` rather than a raw `BigDecimal`, and preferably UTC request time. Keep conversion to `BigDecimal` at the consumer; it accepts historical strings and new BigDecimal values. These preparations **work on 7.0** and preserve the documented UTC-day contract; they avoid needing a custom serializer.

A separate rollout blocker: Rails 7.2+ always writes a tagged `BigDecimalSerializer`; 7.0 has no such serializer. Cross-reading target arguments on 7.0 produced `ActiveJob::DeserializationError`. A `load_defaults 7.0` flag does not prevent this in 8.1. 7.1's temporary `use_big_decimal_serializer = false` is only a bridge, not an 8.1 solution.

Executed JSON-roundtrip results:

| Writer → reader | Time/decimal result |
|---|---|
| 7.0 → 8.1 | Accepted; old no-zone payload becomes UTC, decimal is String |
| 8.1 → 7.0 | Rejected: unknown BigDecimalSerializer |
| 8.1 → 8.1 | Preserved Eastern zone; decimal is BigDecimal |

Dedicated Redis enqueue/retrieval plus manual `ActiveJob::Base.execute` confirmed delivery for both versions; the repaired target explicitly used UTC. This is not a separate Sidekiq worker process test. Retained raw payloads: `*-arguments.json`, `*-sidekiq-job.json`.

Validation: a ready note just on each side of UTC midnight and local midnight, plus a nontrivial 2/3 completion, through real JSON/Redis transport; compare reservation key, email date and note membership. Test old/new writers against old/new readers and rollback readers. Do not infer queue compatibility from in-memory Active Job assertions.

Sources: [7.1 decimal serializer deployment warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 time-zone and primitive serializer changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 serializers](https://github.com/rails/rails/tree/v8.1.0/activejob/lib/active_job/serializers).

### R8 — Preserve export construction and safe cache lifetimes

Affected: [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L32-L42), [export indicator cache](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L40), [ExportDownloadsController](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb).

Rails 7.1 removes Active Support's nonnumeric `sum` override. `fragments.sum` now raises `String can't be coerced into Integer`. Use `fragments.join` (**works on 7.0**); keep heading/body order and Markdown bytes. Existing generated blobs remain valid and require no regeneration. Already queued ExportJobs run code from the new process, so repair generation before releasing workers.

The indicator computes `expires_in: expires_at - Time.current` even after expiry. In 8.1 with old defaults, a negative expiration is ignored (probe retained a value instead of expiring it); with 7.1+ defaults, the same input raises. Render expired indicators uncached and cache only live ones using the absolute deadline or a nonnegative lifetime computed once, accounting for the deadline crossing during rendering. **The restructuring works on 7.0.** Avoid only disabling the new exception setting: that hides a changed cache policy.

Validation: multi-note/empty-notebook export exact bytes, cancellation during generation, failed upload, active indicator cache miss/hit, cold expired indicator, and times just before/at/after expiry with caching enabled. Expired/foreign download requests must still be denied before conditional GET. Existing request tests cover several of these, and the defaults run exposed the negative lifetime. This is not evidence of a download authorization bypass: that controller checks ownership and `downloadable?` before consulting validators.

Sources: [7.1 sum removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [8.1 cache implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb).

### R9 — Repair the sanitizer initializer; gate editor compatibility in a browser

Affected: [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L12-L19), [importmap](file:///home/user/workspace/repo/config/importmap.rb), blob partial and saved rich text.

From 7.1, `ActionText::ContentHelper.allowed_tags` is nil until an application override; effective defaults are computed when rendering. The existing `+=` crashes even with old framework defaults. Assign the selected sanitizer's safe tags **plus** `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details`, `summary`; preserve default allowed attributes/attachment attributes. Do not replace the list with only details/summary or disable sanitization. Building this explicit union **works on 7.0**, though adopting HTML5 defaults later should obtain the selected sanitizer's list after its configuration is applied.

The app intentionally loads vendored Trix 1.3.5 as a classic script to fix a 7.0 bundled-editor problem. The 8.1 resolution adds `action_text-trix 2.1.19` (constraint ~>2.1.15), supplying Trix assets, while the layout still loads 1.3.5 and Action Text JS updates to 8.1. Production Sprockets precompilation succeeded; **editor runtime interoperability was not tested**. Do not claim the older editor fails, or blindly run the installer and discard the deliberate workaround. Browser-test the current pairing; preferably adopt matching Trix JS/CSS in a separately reviewed asset change, with exactly one editor registration/import and no duplicate old classic script.

Validation: open/edit/re-save an old note with a link, attachment/caption, details/summary and unsafe markup; upload and remove an image, retry a rejected >1 MB attachment, navigate with Turbo and re-open. Compare rendered and stored HTML and attachment resolution, not only successful POSTs. HTML5 sanitization is optional default adoption below; stored HTML and SGIDs make this a data/rollback concern.

Sources: [7.1 Action Text initializer change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [8.1 ContentHelper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb), [8.1 Action Text gemspec](https://github.com/rails/rails/blob/v8.1.0/actiontext/actiontext.gemspec).

### R10 — Update test exception configuration at the right checkpoint

Affected: [test environment](file:///home/user/workspace/repo/config/environments/test.rb#L25-L29), authorization/error assertions throughout request tests.

Boolean `show_exceptions` support is removed in 7.2. Use `:none` on 7.1+ to preserve the current “raise exceptions in tests” contract. **Do not prepare this on 7.0:** its boolean handling does not give `:none` the same meaning. Retain `:rescuable` only in explicit error-response tests, not to make existing `assert_raises` disappear. Executed target failures were being rendered as HTTP 500 until this was repaired. Re-run other-reader and invalid-resource tests; add explicit production-mode 404/422 response checks where needed.

Source: [versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#new-ways-to-handle-exceptions-in-controller-tests-integration-tests-and-system-tests).

## 2. Dependency resolution finding: JSON 3 breaks this exact target

`bundle update rails` on the experiment date resolved JSON **3.1.0**. Rails 8.1.0's `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)` with two positional arguments; JSON 3 accepts options as keywords. Signed-in requests failed during cookie decoding with `ArgumentError: wrong number of arguments (given 2, expected 1)`. This is an **executed resolution/boot-path failure**, not a speculative API concern.

For exactly Rails 8.1.0, constrain `json`, e.g. `< 3`, and commit/review the resolved lockfile. Experimental resolution selected **2.21.2** and authenticated requests worked. This bound is also compatible with the current runtime, but pinning it on 7.0 alone is not a comprehensive JSON-3 compatibility evaluation. No need to unpin concurrent-ruby or upgrade unrelated gems for this task.

Rails 8.1.0 successfully resolved with **Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, Puma 5.6.9, Sidekiq 6.5.12, redis-rb 4.8.1, pg 1.6.0, Pagy 8.6.3**. Ruby stayed 3.3.6 / Bundler 2.5.22. Do not report a Rack 3/Sidekiq dependency conflict that did not occur. Full dependencies are in the retained locks. New target dependencies also include BigDecimal 4.1.3; checkpoint testing should use the actual resolved lock rather than a guessed dependency set.

Source: [8.1 JSON decoding](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb), `target-session-backtrace.log`, `target-bundle-json2.log`.

## 3. Optional defaults: separate deployments, not blanket load_defaults 8.1

All conditions here apply when enabling the relevant default (usually by advancing load_defaults), not solely when installing 8.1.

| Default / affected code | Concrete recommendation; preparation compatibility | Discriminating validation / evidence |
|---|---|---|
| **7.1: no implicit YAML coder** — `Notebook.serialize :preferences` | On 7.1+, explicitly use `coder: YAML`, preserving existing YAML text and string-key headings. Do not silently change to JSON. The keyword is not a proper 7.0 preparation; if explicit 7.0 preparation is essential, retain/use a positional YAMLColumn coder on 7.0 and move to keywords at 7.1. | Executed defaults boot failed without coder. YAML heading read/write succeeded after explicit coder. Still proposed: read historical NULL/YAML rows and legacy allowed types; round-trip on rollback reader. No bulk data conversion is recommended. |
| **7.1: raise on readonly assignment** — `Notebook.slug`, controller permits it and form resubmits hidden slug | Stop permitting/assigning slug on notebook updates; remove hidden submission. Creation still derives slug from name. Works on 7.0. Keep `attr_readonly`, do not weaken it merely for this form. | Executed: even resubmitting the identical slug raises under new defaults. Check same-value form submission and forged changed slug; name/heading update while stored slug is unchanged. Existing notebook request test exposes it. |
| **7.2: decode PostgreSQL dates** — `Notebook#daily_note_counts` raw `select_rows` | Accept both Date and string (`day.is_a?(Date) ? day : Date.iso8601(day)`, or `day.to_date` on trusted DB results). Works on 7.0. Alternatively defer `postgresql_adapter_decode_dates`. | Executed: string under old defaults, Date under new, `Date.iso8601(Date)` fails. Existing activity test distinguishes dates, order and ownership; add UTC-midnight boundaries and fresh connection under each setting. |
| **7.1: raise on invalid cache expiry** — completed export indicator | R8's cache fix must precede this adoption. | Defaults suite raises with `expires_in: -60`; old-default target silently discards a negative expiration. Test cold expired rendering with caching enabled. |
| **7.1: HTML5 sanitizer** — Action Text/imported HTML | Adopt after reviewing a representative old HTML corpus and effective allowlist. Do not conflate boot fix R9 with choosing a new parser. No 7.0 framework-default toggle exists; the runtime-compatible allowlist fix is separate. | Still proposed: malformed nested markup, tables, links, details/summary, attachments and unsafe URLs through render → edit → save, compare persisted HTML and rollback rendering. Existing simple sanitizer test is insufficient. |
| **7.1: message serializer/metadata and cache format 7.1** — blob signed IDs, embedded SGIDs, FileStore fragments | Retain old writer settings until every reader, including rollback target, supports new formats; then stage writer adoption. Use isolated/namespaced or cleared application cache when changing its format; do not flush Redis queues or digest reservations. New config settings are not 7.0 preparations. | Executed signature matrix below demonstrates asymmetric rollback. Cache-format cross-reader test still proposed; current production defaults to FileStore, development MemoryStore/NullStore, tests NullStore. No Redis cache is configured. |
| **8.0: strict HTTP freshness** — authenticated export downloads with both ETag and Last-Modified | Adopt separately if RFC-style ETag precedence is desired; retain authorization/expiry checks before `stale?`. The new setting is not a 7.0 preparation. | Executed Request probe: matching ETag + old If-Modified-Since is not fresh under old defaults, fresh under new. Proposed endpoint test with those conflicting validators plus expired/foreign requests; existing tests supply both matching, so cannot distinguish precedence. |

Other newer defaults/features do not require conversion of this app: no Active Record Encryption, custom encryption algorithms, custom cache clients, SQLite, MySQL, Azure storage, Action Mailbox ingress, custom logger-broadcast API calls, or manual app-directory requires were found. JSON response escaping changes in 8.1 are lower applicability: no application JSON rendering endpoints were found, and import annotations use HTML escaping. Review Active Storage/direct-upload JSON through browser validation rather than changing escaping globally. New render tracking, hidden-field autocomplete, YJIT, browser guards, auth generators, local CI, Propshaft, Solid Queue/Cache/Cable and job continuations are not prerequisites. Keep PostgreSQL, Sidekiq, Redis and Sprockets unless separately authorized.

Versioned source of truth for the default distinctions: [8.1 configuration.rb](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), especially its 7.1/7.2/8.0/8.1 `load_defaults` branches.

## 4. Mixed-version rollout, stored data and rollback

### Queue: deploy compatible producers before newer workers/writers

1. On 7.0 deploy transport-neutral digest arguments (decimal string, explicit UTC semantics) and the cross-compatible application repairs. Validate old-producer/new-consumer and new-producer/old-consumer behavior.
2. Keep job class names, `gid://` app/model identities, integer enum mappings, user/note/notebook IDs and native ExportJob argument shape stable. Do not drop/recreate application tables for this framework update.
3. New workers should be able to read old GlobalIDs and old decimal strings. They do not automatically solve payloads written by a newer runtime that old workers cannot understand. During overlap, prevent unprepared 7.0 workers from consuming tagged BigDecimal jobs. Prefer preparatory neutral arguments; otherwise isolate writer generations/queues and drain compatible readers in a controlled deployment.
4. Account for **Sidekiq ready queues, retry set, scheduled set and dead jobs**, not just the default queue. Reminders can be scheduled far beyond deployment time, and superseded reminders intentionally stay queued. Do not clear/reschedule them with fresh job IDs: `reminder_job_id` is the suppression contract. Active Storage analysis/purge jobs are also Active Jobs and need preserved class availability. A rollback must keep an appropriate reader for any incompatible residual payloads or explicitly transform them with audited semantics. The experiment did not inventory any deployed sets.
5. Keep digest reservation keys/UTC-day logic stable through the two-day reservation retention window. Do not clear reservations as a substitute for fixing payload compatibility: that can send duplicate mail. Mail delivery is not idempotent; a retry after delivery can resend it.

The complete scheduled Active Job envelope also evolved (including `scheduled_at` serialization). Numeric schedule API failure was executed; cross-version **entire job envelopes** for scheduled reminders, retries and Active Storage jobs were not exhaustively executed and remain a release gate. Sidekiq's own scheduling score is not a substitute for checking Active Job's inner envelope.

### Do not accidentally change transaction/queue failure guarantees

`Citation#request_enrichment` and `Note#schedule_reminder` enqueue while holding a transaction/row lock so an enqueue exception aborts the pending/job-ID update. The 7.2 release notes describe deferral to after commit, but that is **not a universal assertion about this target**: inspected 8.1 code and executed target probe show `enqueue_after_transaction_commit` default **false**. Preserve and test that behavior rather than automatically opting into deferral.

If selecting a newer adapter or enabling `enqueue_after_transaction_commit = true`, a Redis failure can occur after the state has committed, leaving an enrichment pending or reminder recorded but not queued. That requires an application design change (outbox/reconciliation or revised failure contract), not just a toggle. On 8.1 the setting is Boolean; earlier `:never/:always/:default` and global configuration are removed. No 7.0 setting is necessary to retain its immediate behavior. Run a real Redis failure in a disposable process and assert both database state and queue state, including nested transactions. The existing digest failure test stubs `perform_later`, so it does not establish transactional-adapter semantics.

### Signatures and stored rich text: preserve keys AND writer format

Development/test key filename changes in 7.1 from `tmp/development_secret.txt` to `tmp/local_secret.txt`; migrate/copy it if local sessions and attachments must survive. In production preserve the actual `secret_key_base` and credential source on every process. No application-owned production secret_key_base entry was found in `secrets.yml`, but the actual deployed key source was not inspected.

Using the **same synthetic key** and purpose for each variant, executed verification was:

| Reader | 7.0 writer | 8.1 writer, defaults 7.0 | 8.1 writer, defaults 8.1 |
|---|---|---|---|
| 7.0 | Blob signed ID + attachment SGID valid | Both valid | Both error (`NoMethodError` while decoding metadata) |
| 8.1, defaults 7.0 | Both valid | Both valid | Both valid |
| 8.1, defaults 8.1 | Both valid | Both valid | Both valid |

This establishes a rollback risk for **new signed IDs and SGIDs persisted in Action Text HTML** after adopting message defaults. “New readers can read old tokens” is not proof of reverse compatibility. Do not enable new message writers while unprepared 7.0 readers/rollback remain possible. A rollback plan must retain legacy-compatible writers or provision compatible readers/explicit verifier rotations and validate them before adoption; there is no blanket promise that simply switching the flag back rewrites stored SGIDs.

Separately, an executed sign-in/session-cookie cross-read worked in all nine writer/reader combinations with the JSON cookie serializer and same key. Do not generalize that success to Active Storage/SGID verification, or to untested deployment-specific cookie/key overrides. The initial signature experiment used differing local secret sources and was invalid for format comparison; its logs are retained under `*-initial-secret-mismatch.log`, not used for this matrix.

### Existing persistent data and files

- Keep `notes.tags` JSON text, `notebooks.preferences` YAML text, JSONB settings, integer status values and bigint reminder epochs as-is. Probe historical rows before deployment; no production data was read here.
- Keep rich-text HTML, Active Storage blob/attachment rows, blob keys and Disk root stable. Do not regenerate signatures, purge unattached blobs, delete expired files, or transform the whole HTML corpus as part of the upgrade. Sample deployment access-policy weaknesses documented in ARCHITECTURE remain unrelated existing issues.
- Preserve the storage mount across web/worker generations. Validate reads of existing images and completed Markdown blobs, old signed redirects/direct uploads and rollback rendering with retained files. Signature verification probes did not prove cross-environment filesystem access or complete historical attachment loading.
- `schema.rb` columns sort alphabetically on 8.1 dumps; this is not a schema/data migration. Keep existing `Migration[7.0]` histories. If a regenerated schema starts using a newer Schema/Migration compatibility version, keep the old deploy artifact/schema for a 7.0 rollback/fresh recovery: old runtimes cannot necessarily load a new schema DSL. Compare migrations and schema dumps in a disposable database rather than hand-applying a generated diff to production.

### Sidekiq modernization is conditional, not required for 8.1.0

The Rails built-in Sidekiq adapter is deprecated in 8.1 and scheduled for removal in 8.2; upstream recommends Sidekiq ≥7.3.3 for its adapter. It still enqueued/executed the target probe with Sidekiq 6.5.12. A production separate-worker boot, draining/shutdown and concurrency test remains proposed.

If upgrading Sidekiq/Redis later, repair native ExportJob options to `{ "format" => "markdown" }` before strict JSON enforcement (works on current Sidekiq). Also change the digest `sadd` condition to `sadd?` (available in redis-rb 4.8.1) or explicitly compare the integer count: Redis 5-style integer **0 is truthy in Ruby**, otherwise repeat reservations enqueue duplicate digests. Rework Redis-specific exception/configuration use against the selected new adapter/client and verify duplicate requests and failure cleanup. Do not infer these changes are mandatory for retaining the current pins.

## 5. Proposed delivery sequence and release gates

1. **Preparation on 7.0:** explicit import rollback; positional enum; highlight forwarding; correct association/DOI/key usage; string joining; split routes; unbound form; Time scheduling; UTC digest consumer + string decimal producer; provider config migration; nonnegative/uncached-expired cache structure. Optionally fix actual-zone reminder display and readonly form handling as separately identified behavior choices. Execute full request/model tests plus real-transport compatibility checks. Keep newer serializer keywords, retry symbol and exception setting out of this 7.0 deployment.
2. **7.1 checkpoint:** choose an explicit patch/lockfile; switch serializer declarations to keywords, retry wait symbol and test exception mode; repair Action Text initializer; initially leave defaults at 7.0. Run `app:update` as a diff/review exercise in the branch, preserving app mailer/storage/Sidekiq/importmap/Trix settings; do not accept generated backend or authentication changes blindly. Recheck production boot, eager load, assets, database migrations and tests.
3. **7.2 then 8.0 checkpoints:** repeat deprecation checks and real Redis payload tests, including scheduled/retried jobs and both reader generations. Keep neutral digest payloads and old message/cache writers until the rollback contract permits a change.
4. **8.1.0:** lock JSON <3 (or another independently verified resolution), retain defaults 7.0 and existing infrastructure pins for the first production rollout. Ship web/worker compatible artifacts together under an approved deployment plan; monitor enqueue/perform/deserialization failures, imports, pending enrichment, digest dates and reminder lateness. No deployment has been authorized or run here.
5. **Defaults adoption:** separate commits/deployments for preferences/readonly/cache/date fixes, HTML5 corpus review, freshness, then message/cache formats only after compatibility gates. Advance load_defaults only after each effective setting is accounted for. No need to adopt Solid backends, Propshaft, Trix migration, YJIT policy or new generators to call the runtime upgrade successful.

Before release, still needed:

- Full intermediate-version resolutions and executions (only baseline and exact target were executed here).
- Dedicated worker process, queue outage, scheduled/retry/dead payload matrix, shutdown/draining behavior; no production Redis inventory was inspected.
- Browser editor/direct-upload/Turbo workflow on old saved content, plus production-like authorized 404s and conditional downloads. There are currently no concrete system test cases.
- Representative sanitized historical HTML/YAML/JSON and preserved storage checks; no live customer data or actual production credentials inspected.
- Rollback rehearsal including tagged historical job arguments, new-message SGIDs, cache format and old/new application artifacts. Do not call a passing unit suite a rollback rehearsal.
- If changing policy to local-day digests, calendar-day postponement, delayed transactional enqueues or private-file access, obtain a separate product/design decision: those are not behavior-preserving framework maintenance.

## 6. Experiment attribution and reproduction

See [EXPERIMENTS.md](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/EXPERIMENTS.md) for isolated service commands, exact runner/environment, variant diffs/configs/locks, log names, scratch cleanup and limitations. `baseline-final.diff` contains only disposable isolation configuration; `target-final.diff` and `defaults-final.diff` capture experimental app/test changes. These are **not patches applied to the working tree**.

Upstream references are pinned release guides/tags, not edge documentation: [upgrade guide 8.1.0](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), [7.1.0 release source](https://github.com/rails/rails/blob/v7.1.0/guides/source/7_1_release_notes.md), [7.2.0 release notes](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [8.0.0 release notes](https://guides.rubyonrails.org/v8.0.0/8_0_release_notes.html), [8.1.0 release notes](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html). The retained exact 8.1.0 source archive has SHA-256 `e3f97438a5cc66a297effcf70bb05e7989f595ab975e9bc83535466d0abc3414`; current lock SHA-256 is `2c3b526ba4054c08f2cd5184fdafe654fb9e29c6f2da6473457a63b817c148bb`.
