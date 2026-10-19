# Rails 7.0.8.7 → 8.1.0: Margin Notes upgrade plan

**Decision: feasible, but not a Gemfile-only upgrade. Do not deploy the target unchanged.** Keep `config.load_defaults 7.0` initially, fix unconditional incompatibilities, and treat newer defaults as a separate rollout. Most importantly, fix partial CSV imports and digest semantics before new workers receive real work.

No working application files, application databases, queues, cache entries, or blobs were changed. Experiments used disposable checkouts, a private PostgreSQL cluster, a private Redis process, and checkout-local storage/cache/logs. The only repository-local configuration change was an ignore rule for the required artifact directory. No commit, push, or deployment was performed.

## Evidence and limits

- Application snapshot: [ab732f5](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). Gemfile and lock both specify Rails 7.0.8.7; Ruby is 3.3.6; `config/application.rb:12` loads 7.0 defaults. Ruby already satisfies Rails 8.1.0's **Ruby ≥ 3.2** requirement. Keep Ruby unchanged for this upgrade.
- Read the actual models, controllers, views, jobs, environment configuration, schema/migrations, and test coverage; compared exact upstream tags **v7.0.8.7, v7.1.0, v7.2.0, v8.0.0, v8.1.0**, not only the current stable-branch release summaries.
- **Executed baseline:** `bundle check`, isolated `db:schema:load`, `bin/rails test`: **46 runs, 325 assertions, 0 failures/errors/skips**.
- **Executed dependency-only target:** resolution succeeds, retaining **Sidekiq 6.5.12, redis 4.8.1, Puma 5.6.9, Rack 2.2.24, pg 1.6.0**. It adds rack-session 1.0.2 / rackup 1.0.1 and action_text-trix 2.1.19. Contrary to a common assumption, Rails 8.1.0 does not force Rack 3 or Sidekiq 7 here.
- That resolution also selected **JSON 3.1.0**, incompatible with Rails 8.1.0's positional `JSON.parse(json, options)` calls. A probe constraint `json < 3` resolved **2.21.2** and removed those errors. Initial and constrained locks are retained separately.
- The untouched target app fails boot at the Action Text initializer. A **partially adapted probe**, changing only that initializer, route syntax, Note enum/serialization/alias APIs, and the JSON constraint, ran the unchanged test suite: **46 runs, 161 assertions, 19 failures, 6 errors**. This is not a completed upgrade or a claim that all remaining errors have one cause. The earlier probe with JSON 3.1.0 had 28 failures / 17 errors.
- Standalone runner probes additionally verified partial-commit behavior, both directions of job-payload compatibility, UTC/local digest dates, DST conversion, negative cache expiry, integer-key stringification, and individual newer-default flags.
- **Not executed:** intermediate-version application suites, a fully repaired target suite, production boot/deployment, real Sidekiq worker consumption, browser workflows, old/new signed-token interoperability, full `load_defaults 8.1`, fresh migration replay, or asset precompilation. There are **no files under `test/system`**, so invoking that suite alone would not validate the editor.

All commands, exact dependency locks, configuration snapshots, probe patches, stdout, Rails logs, and private-service logs are in [rails-upgrade-evidence](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence). See its `README.md` for attribution and reproduction details. Findings below distinguish executed observations from source-derived conclusions and proposed validation.

## 1. Required changes, regardless of adopting newer defaults

### 1.1 CSV imports must explicitly roll back on a rejected row — highest data-integrity priority

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L61), reached through `ImportsController#create`.

**Change/applicability:** `return false unless row.note.save` exits the transaction non-locally. Rails 7.0 rolls this back; Rails 7.1 introduces the changed policy and Rails 7.2 removes the old rollback behavior. Keeping 7.0 framework defaults on Rails 8.1 does not restore it.

**Executed:** outside a test transaction, a valid first CSV row followed by a blank-title row returned `false` on both versions. Rails 7.0 persisted nothing; the 8.1 probe left **one Import, one Note, one Citation, and one rich-text row** committed. The current import request test fails earlier on annotation rendering in the target probe and never reaches its apply assertions; furthermore transactional fixtures are not a substitute for checking a real commit boundary.

**Recommendation:** remove the non-local return; explicitly abort the transaction when a row save fails and return a failure result *after* rollback. For example, use `ActiveRecord::Rollback` and make a normally completed block return true, mapping rollback's nil to false. Preserve each failed note's validation errors and the controller's 422 preview. Do not merely return a different false-like value from inside the loop: normal block completion commits.

**Works on 7.0?** Yes; explicit rollback is a safe preparatory change.

**Discriminating validation:** through the import endpoint without an enclosing fixture transaction, submit first-valid / second-invalid / third-valid rows, including a new DOI and rich body. Assert 422, visible row errors, and **zero committed changes in all four tables**, using a fresh connection/request. Also test all-valid rows and a failure on the first row. Verify two rows sharing one new DOI still share one citation. Run on current and target versions. If a bad target deployment has accepted imports, rollback alone will not remove partial batches; audit and reconcile those records before accepting resubmissions.

**Upstream:** [7.1 transaction change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2 removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-record).

### 1.2 Preserve UTC-day digests and introduce a rollback-compatible job payload

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L27-L56), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12).

**Change/applicability:** from 7.2, Active Job preserves the TimeWithZone argument's named zone and always uses its BigDecimal serializer. These are **not prevented by `load_defaults 7.0`**. The Redis reservation key explicitly uses a UTC date, while the mailer uses the deserialized argument's date and `all_day`.

**Executed:** request instant **2026-10-05 03:30 UTC = October 4, 23:30 Eastern** round-trips through JSON as:

- 7.0: UTC TimeWithZone + decimal String; subject **October 05**.
- 8.1: America/New_York TimeWithZone + BigDecimal; subject **October 04**.

Thus new workers can select the wrong content day relative to the existing reservation. The existing near-midnight digest test catches the date change, but its in-memory adapter does not prove real queue compatibility. A 7.0-produced full job executes under 8.1; **a new full job fails under 7.0 with `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`**. Those were JSON-transport runner checks, not actual worker-process checks.

**Recommendation:** normalize `requested_at` to UTC **inside the mailer**, before deriving both date and range, so old queued jobs and new jobs agree. Also enqueue a UTC timestamp and a native JSON decimal string, e.g. `reading_completion.to_s("F")`, rather than BigDecimal. Keep the mailer's explicit decimal conversion. Do not add a custom serializer merely to preserve this accidental transport behavior.

**Works on 7.0?** Yes for UTC normalization and an explicit String argument. Enabling the Rails 7.1 BigDecimal setting is **not** a 7.0 preparation and is unnecessary with String arguments.

**Discriminating validation:** real Sidekiq JSON transport, 2/3 completion, Eastern and a positive-offset zone on opposite sides of UTC midnight; include notes updated only on each competing day. Confirm UTC subject/content and 66.67% display, one reservation per UTC day, and release after enqueue refusal. Feed old-format and new-format jobs to both versions. Test already queued TimeWithZone arguments independently of the producer change.

**Rollout:** deploy the compatible producer/consumer contract everywhere while still on 7.0, then change framework versions. Inspect ready, scheduled, retry, and dead job sets for newer BigDecimal payloads before rolling back; process or explicitly transform them under a reviewed procedure rather than letting 7.0 workers repeatedly fail or blindly deleting queues. Preserve reservations to avoid duplicate requests; they expire after two days. Replay is not inherently email-idempotent.

**Upstream:** [7.2 TimeWithZoneSerializer](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [7.1 BigDecimal rollout warning](https://github.com/rails/rails/blob/v7.1.0/activejob/lib/active_job/arguments.rb), [7.2 Active Job removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-job).

### 1.3 Repair Action Text's boot initializer without losing the safe/attachment allowlist

**Affected:** [action_text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3).

**Change/applicability:** 7.1 makes `allowed_tags` nil, meaning “derive the default list dynamically.” `allowed_tags += ...` now raises at boot, even with old defaults. This was the actual first target failure.

**Recommendation:** derive the complete effective list from the selected sanitizer's default tags plus `ActionText::Attachment.tag_name`, `figure`, and `figcaption`, then add `details`/`summary`. If supporting both versions during preparation, use the existing non-nil list on 7.0, with that complete fallback for newer Rails. Prefer doing this after the sanitizer vendor is selected. **Do not use `(allowed_tags || []) + extras`: it drops ordinary markup and attachments.** Do not broaden attributes or bypass sanitization.

**Works on 7.0?** The complete-list fallback works on 7.0, using its existing sanitizer API. The probe used it successfully on the target; current-version preparation still needs its focused render test.

**Discriminating validation:** render a stored note with `details/summary`, paragraph, link, image/blob attachment and caption; assert allowed structures survive while scripts, event handlers, and javascript URLs do not. Reopen/save and inspect stored HTML too. Include malformed/nested HTML when adopting HTML5 sanitization later. Existing render tests cover part, not browser editor persistence.

**Upstream:** [7.0 helper](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/app/helpers/action_text/content_helper.rb), [7.1 helper](https://github.com/rails/rails/blob/v7.1.0/actiontext/app/helpers/action_text/content_helper.rb).

### 1.4 Resolve removed model APIs without changing stored data formats

**Affected:** [Note declarations](file:///home/user/workspace/repo/app/models/note.rb#L10-L14), [Notebook preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19), schema text `tags` / jsonb `settings` / text `preferences`.

| Finding | Recommendation | Can prepare on 7.0? | Discriminating validation |
|---|---|---|---|
| Keyword-style `enum status: ..., _prefix: true` is removed in 8.0. | Use `enum :status, { draft: 0, ready: 1 }, prefix: true`; preserve values and `status_ready` scope/predicates. Citation/Export already use modern syntax. | **Yes.** | Create/reload both enum values; exercise list filter and ready-note digest scope. |
| `serialize :tags, JSON` positional coder is removed in 7.2. | On 7.1 change to `serialize :tags, coder: JSON`; keep the existing JSON text format and `[]` database default. | **No** for that keyword rewrite on 7.0. An executed 7.0 probe wrote **YAML** when given `coder: JSON`. Do it after reaching 7.1, not as a blind pre-upgrade edit. | Load raw pre-upgrade JSON text, write multiple Unicode tags, inspect raw SQL bytes and reload on both old/new readers. Include untouched default `[]`. |
| `alias_attribute :highlight_color, :color` aliases a store accessor, not a database attribute; 7.2 rejects this. | Define `highlight_color` and its writer to call `color` / `color=` directly. Do not add a separate column or pretend `color` is a standalone attribute. | **Yes.** | Edit green over an existing yellow settings value; reload and assert JSONB `settings["color"]`, selected form value, and invalid-color rejection. |
| `serialize :preferences` implicitly uses YAML under old defaults, but 7.1 defaults set the default coder to nil. | Required **before defaults adoption**, not for a gem-only upgrade: explicitly use `coder: YAML` on 7.1+, retaining Rails' YAMLColumn safe loading. Do not switch this column to JSON without an intentional dual-reader/backfill plan. | Keyword version **not safe as a 7.0 coder migration**. Keep the current declaration until 7.1; no data rewrite needed. | Load an existing YAML export-heading hash, including punctuation, blank/nil preferences; write on new version and read on rollback version. Sample actual stored types safely before adding `type: Hash` or changing permitted classes. |

The JSON tag bytes matched between baseline and the correctly adapted target probe. Non-empty existing YAML preferences were not exercised across both runtimes; that remains a rollout gate, not an established migration success.

**Upstream:** [7.2 Active Record removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-record), [8.0 enum removal](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html#active-record), [7.0 serialize implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serialize implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb).

### 1.5 Move citation provider configuration off `Rails.application.secrets`

**Affected:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15), `config/secrets.yml`, and the fresh-process/configuration helpers in `test/controllers/citation_enrichments_controller_test.rb`.

**Change/applicability:** `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2. Provider initialization and its tests fail. This does not require moving environment values into an encrypted file.

**Recommendation:** move these provider settings to the ordinary `config_for`/`config.x` configuration path (e.g. an environment-sectioned `config/citation_provider.yml` loaded once into `config.x.citation_provider`), then change the provider and test substitution to use that source. Preserve environment lookup, development/test stand-in defaults, production's absent-config behavior, symbol keys, and YAML-safe quoting (`to_json` is already important). Remove the provider-only secrets file when no longer referenced. Do not log actual credentials or regenerate `secret_key_base`.

**Works on 7.0?** Yes, `config_for` and `config.x` exist there.

**Discriminating validation:** retain the fresh subprocess test with leading-zero username and password containing colon / space / `#`. Test no production URL and the 401, malformed-response, 503→200 and permanently unavailable paths. Both web and workers must receive the same settings before serving work.

**Upstream:** [7.2 Railties removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#railties).

### 1.6 Keep citation retries and reminder scheduling operational

**Affected:** [CitationEnrichmentJob:7](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L4-L9), [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L51-L68).

- `retry_on wait: :exponentially_longer` is renamed in 7.1 and removed in 7.2. Change to `:polynomially_longer` **after reaching 7.1**; it is not understood by 7.0. Both names use the same polynomial delay and jitter during the bridge release. Preserve three total job attempts, the provider's one retry on 503, and terminal failure recording. Validation: six total HTTP calls on persistent 503, no Sidekiq retry after exhausted handled attempts, and bounds on the first two scheduled waits. Existing tests cover count/status, not actual retry delays.
- `set(wait_until: reminder_epoch)` passes an Integer; 7.2 removes numeric scheduled-at support. **Executed target error:** `undefined method utc for Integer`. Convert at the boundary, e.g. `Time.at(reminder_epoch).utc`, retaining the bigint in PostgreSQL. **Works on 7.0: yes.** Validate exact non-round epoch scheduling through real Redis, replaced-job suppression, deleted-note discard, and a past-due reminder. Already scheduled Sidekiq timestamps live outside the AJ argument payload; do not “migrate” or reschedule every stored reminder just because new calls require Time objects.

**Upstream:** [7.2 Active Job removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html#active-job), [8.1 delay calculation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/exceptions.rb).

### 1.7 Fix export aggregation, DOI receipt output, annotation previews, forms, and routes

These are unconditional changes, not framework-default switches:

| Affected code / version | Concrete recommendation | 7.0 preparation? | Validation |
|---|---|---|---|
| [Export#generate:42](file:///home/user/workspace/repo/app/models/export.rb#L32-L43): Rails 7.1 removes nonnumeric `Enumerable#sum`; actual target raises `String can't be coerced into Integer`. | Use `fragments.join` (or explicit String initial value), keeping order/newlines. | **Yes.** | Existing exact Markdown test plus empty notebook, cancellation, and real queued job retry. Old queued exports use current implementation when consumed, so fix before running them under new Rails. |
| [Import#receipt:68](file:///home/user/workspace/repo/app/models/import.rb#L63-L70): 7.2 no longer maps `citation[:id]` to its nonstandard `doi` primary key. Target probe returns nil while `citation.id` and `.doi` still work. | Read `citation.doi` explicitly. | **Yes.** | CSV download with two different DOIs, a repeated DOI, and a no-citation row; exact output. Existing receipt expectation is useful, but target test currently stops earlier at preview rendering. |
| [imports preview:22,42–44](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44): Rails 8.0 now really stringifies integer keys in HashWithIndifferentAccess. `annotations[row.line]` becomes nil. | Simplest: use `row.annotation` already present on the parsed Row, removing the now-unneeded annotations map/method if no consumers remain. Alternatively retain consistent integer keys by removing `.stringify_keys`. | **Yes.** Merely changing lookup to `.to_s` without changing map creation **does not** work on 7.0. | Multiple distinct annotations with blank lines and a quoted multiline CSV row; compare visible annotation to source row. Probe lines 2,3,5 demonstrated old integer vs new String keys. |
| [notes/index:12](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12): 8.0 rejects explicit `form_with(model: nil)`. Actual target list returns 500. | Omit `model:` or use `model: false`, preserving GET URL and unbound fields. | **Yes.** | Existing unbound search test; submit filters/page size and verify query string + selected state, not just response success. |
| [routes:18](file:///home/user/workspace/repo/config/routes.rb#L17-L19): multi-path route deprecated in 8.0, removed in 8.1. | Two explicit GET declarations for `/notes` and `/journal`; retain canonical `notes_path` and alias behavior. | **Yes.** | GET both paths with filters, verify same authorized list and link destinations. |

**Upstream:** [7.1 Active Support changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [7.2 removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html), [8.0 stringify_keys change](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md), [8.0 Action View removals](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html#action-view), [8.1 Action Pack removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#action-pack).

### 1.8 Correct exception handling in the test environment

**Affected:** [test.rb:31](file:///home/user/workspace/repo/config/environments/test.rb#L30-L37), many authorization/error assertions.

Boolean `show_exceptions = false` is deprecated in 7.1 and no longer supported in 7.2. The target probe renders errors instead of raising, so expected `RecordNotFound`/enqueue-refusal exceptions are not raised to tests. **Change to `:none` on 7.1+. This is not a 7.0-safe switch**: older middleware treats the Symbol as truthy. Keep the explicit `queue_adapter = :test`; the 7.2 test-adapter change is already addressed here. For production-style HTTP error assertions, explicitly use `:rescuable`/`:all` and assert status plus no unauthorized write.

Validate a foreign-owned notebook/note, a genuine unexpected error, and a failed enqueue; do not change application authorization just to satisfy altered test middleware.

**Upstream:** [upgrade guide: exception handling](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#new-ways-to-handle-exceptions-in-controller-tests-integration-tests-and-system-tests).

### 1.9 Pin a compatible JSON dependency for the exact requested Rails release

**Affected:** target resolution; application JSONB settings, JSON tags, sessions, and Sidekiq payload handling all use JSON.

This is an **executed dependency compatibility failure**, not an inferred need for Rack/Sidekiq replacement. Rails 8.1.0 `ActiveSupport::JSON.decode` calls `JSON.parse` with a positional options hash; resolved JSON 3.1.0 accepts keyword options. The retained diagnostic stack attributes errors in JSON attributes and sessions to this boundary.

For the requested **8.1.0 exactly**, constrain JSON to a tested 2.x release; the probe's `< 3` resolved 2.21.2. Commit the resulting lock during the actual upgrade and inspect every transitive delta (including BigDecimal 4.1.3, net-imap 0.6.8), rather than assuming the old lock's unconstrained stdlib gems remain unchanged. A newer Rails patch may resolve this upstream, but that was not researched or tested and is not claimed here.

**Works on 7.0?** Keeping the existing JSON 2.7.2 runtime works. A broad new constraint does not by itself prove a newly resolved JSON 2.x is compatible with 7.0; retest if changing its resolution. No application monkeypatch is recommended.

Validate JSONB edit/reload, tag raw bytes, session round trips, provider JSON, and native/Active Job payloads. Source: [Rails 8.1 decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb); the installed JSON 3.1.0 `CHANGES.md` documents keyword-only options from 3.0 and is summarized in the evidence README.

## 2. Optional defaults and explicit behavior decisions

Do **not** flip `load_defaults` wholesale just because the gem boots. Exact target defaults are in [v8.1.0 configuration.rb](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).

### 2.1 Expired export fragments must not receive negative TTLs

[exports/_export:26](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L37) computes `expires_at - Time.current` even for already expired exports. New cache handling drops a negative expiration when lenient; 7.1 defaults set `raise_on_invalid_cache_expiration_time = true` and raise instead.

**Executed primitive check:** baseline read after negative TTL → nil; target lenient → cached value without that requested expiration; target strict → ArgumentError. Current tests normally disable caching, and one cache test exercises a deliberately stale indicator, so do not assume it covers fresh expired entries under the strict setting.

**Recommendation:** cache only the still-downloadable/positive-TTL indicator; render “Expired” outside that expiring cache block. This preparation works on 7.0. Do not change download authorization to trust the fragment. Validate uncached expired export, warm hit then expiry, exact deadline, and conditional download after expiry, with a local store and strict expiry checking. Before changing the cache format from 7.0 to 7.1, keep readers upgraded first or use a new cache namespace; default production store is FileStore (`tmp/cache`), development MemoryStore only when enabled, test NullStore. Redis here is not the Rails cache.

### 2.2 Read-only slugs: new defaults reject even unchanged assignments

`Notebook.attr_readonly :slug` combines with [NotebooksController's permitted slug](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L39-L42) and the hidden slug field in settings. With 7.1 `raise_on_assign_to_attr_readonly = true`, even assigning the same slug raises. The focused probe confirmed this.

**Recommendation:** exclude slug from writable settings parameters and remove its redundant hidden submission; keep the model read-only declaration and server-generated slug. This works on 7.0, including malicious changed-slug submissions (ignored, as today). Alternatively postpone the default explicitly. Validate ordinary name/heading edit, unchanged slug and tampered slug, and invariant export filename.

### 2.3 PostgreSQL date decoding changes the raw report's input type

[Notebook#daily_note_counts:40](file:///home/user/workspace/repo/app/models/notebook.rb#L33-L41) feeds raw query results into `Date.iso8601`. Under 7.2 defaults `postgresql_adapter_decode_dates = true`, the adapter returns Date objects. **Executed fresh-connection check:** Date returned; the report raises `TypeError: no implicit conversion of Date into String`. Old defaults still return strings and the ordinary target activity test passes.

**Recommendation:** make the conversion accept both, e.g. `Date.iso8601(day.to_s)`, or use a typed query boundary. The String/Date conversion preparation works on 7.0; the new configuration flag itself is newer. Validate unequal daily counts around UTC midnight, including empty report and other reader/notebook exclusion, under both decoder settings on fresh connections. No stored-date migration is needed; these dates are derived from UTC timestamps.

### 2.4 Rails 8.1 changes `to_time` even when old defaults are retained

This is **not merely optional adoption**: [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L40-L45) loses its documented fixed-offset conversion on 8.1. A 24-hour increment still targets the same epoch, but named-zone arithmetic updates the offset.

**Executed:** October 31, 09:00 Eastern + 24 elapsed hours displays **November 1, 09:00 -04:00** on 7.0 and **08:00 -05:00** on 8.1; those are the same instant. The actual postponed reminder is 08:00 -05:00. The current reminder test asserts the former preview.

**Recommendation:** consciously adopt the zone-correct preview and update the test/comment, or explicitly force a numeric offset if preserving the old displayed representation is required. To prepare the zone-correct behavior on 7.0, use zone-aware elapsed arithmetic (`reminder_at + 24.hours`) instead of the old `to_time` conversion. Do not replace elapsed hours with a calendar `1.day`, which changes the scheduling instant across DST. Validate both fall-back and spring-forward, preview vs queued epoch vs sent mail; stored epochs and existing scheduled work require no conversion.

**Upstream:** [8.1 time_with_zone.rb](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb), [8.1 Active Support removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#active-support).

### 2.5 Signing keys, metadata, and persisted rich-text attachments need a rollout gate

The working checkout has `tmp/development_secret.txt` and **no `tmp/local_secret.txt`** (filenames checked; values not read). Rails 7.1 renames the development/test secret file. Preserve the old value at the new path **and keep the old file for rollback**, rather than generating a different key; copy without printing it. This file preparation works with 7.0, which continues reading its old path. Preserve production `SECRET_KEY_BASE`/credentials separately; this development rename is not a production rotation instruction.

7.1 defaults also change message serializer and metadata envelopes; cache format changes separately. Keep old write formats through the initial framework rollout and rollback window. Only enable new formats after all relevant readers support them. Test each token type rather than assuming cookies, blob signed IDs, and Action Text SGIDs share an identical serializer.

**Proposed validation, not executed:** carry a pre-upgrade login cookie, Active Storage signed URL and stored `action-text-attachment` SGID into the new runtime with the same key; render and edit an old note; then generate new tokens/HTML and test rollback readers. Persisted SGIDs can outlive all jobs and sessions, so “wait for the queue to drain” does not solve that data compatibility risk. Keep blobs and their rows together in backups; do not re-sign rich-text bodies blindly. The app already uses 7.0's digest/key defaults, so the old 6.1→7.0 SHA1 rotation recipe is not automatically needed again.

**Upstream:** [secret file change](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [target metadata implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/messages/metadata.rb).

### 2.6 Queue timing: preserve the existing failure contract unless deliberately redesigned

`Citation#request_enrichment` and `Note#schedule_reminder` enqueue under row locks; their persisted state is meant to roll back if enqueue fails. `Notebook#request_export` deliberately commits before native Sidekiq enqueue and removes the export after a Redis failure.

Do not infer from 7.2 release highlights that the exact target automatically defers these jobs: **the 8.1 probe adapter has `enqueue_after_transaction_commit = false`**, matching target source. If deferral is enabled deliberately, failures can happen *after* the model transaction commits, invalidating these failure contracts. Old version names (`:never`, `:always`, `:default`) and the global config are removed in 8.1; the target per-job setting uses booleans. Neither form is a 7.0 API.

**Recommendation:** retain immediate enqueue for initial compatibility; review after-commit/outbox behavior separately if desired. Validation must use real Redis refusal and a separate worker/DB connection, not solely stubbing `perform_later` or relying on transactional fixture timing. Check pending citation/reminder job IDs, prior reminder preservation, export cleanup, and stale worker reads. Native `ExportJob` is not changed by Active Job's policy.

### 2.7 Rich-text browser assets and HTTP caching require separate acceptance checks

- The layout explicitly loads **vendored Trix 1.3.5**, whereas Rails 8.1's `action_text-trix` dependency supplies **2.1.x** (probe resolved 2.1.19). The app therefore **does not automatically start using Trix 2** just by updating gems. Action Text's JS/upload code and HTML5 sanitizer defaults also evolve. There is no executed evidence yet that the retained Trix 1 build works with the new JS. Prefer evaluating migration to the maintained supplied Trix asset as a distinct, tested browser change; remove the old classic script only when the new import/asset setup is correct and does not load both editors. Do not claim this is a proven server-side blocker or promise `details/summary` survive editor saves: the app already documents flattening under Trix 1.
- Validate production Sprockets precompile, importmap resolution, load one editor, open an existing rich note with links/attachments, edit/save, direct upload, oversize rejection, and rejected save retention. Inspect saved HTML as well as DOM. These are proposed browser checks, not covered by the empty system directory.
- 8.0 `strict_freshness` gives If-None-Match precedence over If-Modified-Since in [ExportDownloadsController](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L19). Optional adoption should test matching ETag + stale date (new RFC behavior differs), mismatching ETag, ownership denial, and expiration on both sides of the deadline. Keep authorization/availability before `stale?`, as it already is.

**Upstream:** [8.1 Action Text changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md), [framework defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).

## 3. Sidekiq upgrade is separable, and has its own compatibility work

Rails 8.1 deprecates the built-in Sidekiq adapter, scheduled for removal in 8.2; its source asks for **Sidekiq ≥ 7.3.3** for the gem-supplied adapter. **This is not a requirement to replace Sidekiq 6.5 for the requested 8.1.0 upgrade**, and dependency resolution confirmed the distinction. Retaining it initially reduces simultaneous changes, but a real worker smoke test is still required.

If upgrading Sidekiq now or later:

1. [Notebook#request_export](file:///home/user/workspace/repo/app/models/notebook.rb#L24-L29) passes `{ format: "markdown" }` into native Sidekiq. 6.5 warns; strict JSON arguments reject Symbol keys. Prepare `{ "format" => "markdown" }` on 6.5 now; the worker already expects String keys. Old queued exports already underwent JSON conversion and can retain their shape. Validate request→Redis→worker→attachment/download, not just an enqueue count.
2. `User#request_digest` relies on redis 4.x `sadd` returning a boolean. Newer clients return an integer, and **0 is truthy in Ruby**, which can enqueue repeated daily digests. Use `sadd?` where supported in the chosen clients or deliberately compare the integer result; redis 4.8.1 already provides `sadd?`. Preserve failure release and TTL. Test the **second** request, not only the first. Reconcile `Redis::BaseError` rescue classes and tests with the chosen Sidekiq/redis-client transport; don't assume the old redis gem's exception class still covers queue errors.
3. Move digest completion to String as above before strict arguments. Review Redis server/runtime requirements, pool behavior, queue and retry payload compatibility against the **chosen exact Sidekiq version**; this review did not resolve or run a Sidekiq 7 variant. Do not change the deployment's Redis URL or discard scheduled reminders.

**Upstream:** [exact Rails 8.1 Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb). Sidekiq 6.5 warning behavior was observed in the baseline logs; later-version specifics above remain validation requirements, not claims of a tested upgraded worker.

## 4. Sequence and release gates

Follow the [versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html): one minor at a time, reading deprecations. These are upgrade stages, not an instruction to expose obsolete intermediate releases publicly.

1. **Current-version preparation on 7.0.8.7.** Explicit import rollback; UTC digest consumption/production + String completion; Time reminder scheduling; method delegation for highlight; export join; explicit DOI receipt; consistent preview annotations; form and route fixes; full allowlist initialization; provider config migration; optional slug and cache-TTL preparations. Preserve the local signing secret. Add narrowly targeted regressions at the committed request/real transport boundaries. Keep current formats and dependency pins.
2. **7.1 bridge.** Use an explicitly selected patched 7.1 release in the real upgrade branch, still with old defaults. Run `app:update` interactively and review, never accept generated replacement configuration wholesale. Move tags/preferences to explicit keyword coders, `show_exceptions` to `:none`, and retry name to `:polynomially_longer`. Keep BigDecimal writes absent via the String contract. Confirm old-format jobs/HTML/files still read. Intermediate patch versions and their resolved locks have **not** been selected or executed in this assessment.
3. **7.2 → 8.0 → exact 8.1.0.** At each stage resolve/review a lock, boot web and workers, run `zeitwerk:check`, the full non-browser suite, targeted committed-boundary tests, and browser workflows. Inspect deprecations with them enabled; production.rb currently disables reporting. Keep 7.0 defaults and the compatible signing/cache write formats during this stage. Retain Sidekiq 6.5 unless choosing the separate work above. Constrain JSON for exact 8.1.0 and verify its lock.
4. **Data and schema rehearsal.** Use a sanitized production-shaped backup with old YAML/JSON fields, nonempty rich text, existing SGIDs/blobs and export attachments, alongside representative queued/scheduled/retry payloads. Back up PostgreSQL and Disk storage coherently. Existing schema already includes service_name, variant records, rich text, citations and reminders; source review found no required application-owned schema conversion. Still compare framework migrations via reviewed update output and rehearse both existing-db migration and fresh schema loading. Rails 8.0 fresh `db:migrate` may load schema instead of replaying old migrations; a passing fresh boot does not establish that every historical migration replay works. 8.1's alphabetical schema-column dump is expected generated diff, not a need to reorder live tables.
5. **Coordinated rollout/rollback.** Deploy compatible producers/readers first; quiet/drain workers safely, account for in-flight work, then replace web and worker processes. Inventory ready/scheduled/retry/dead sets by actual payload types. Do not flush Redis: it contains reservations and long-lived reminders as well as ready jobs. Test stored-ID/job-ID gates so old reminders send nothing after replacement. On rollback keep data-compatible schema/code and old signing keys; isolate/discard only disposable cache entries or move namespace, not storage or queues. Reconcile any partial imports and already emitted newer-format jobs before rollback workers consume them. Exact traffic/deployment topology is unknown, so a zero-downtime mixed-version rollout is **not yet certified**.
6. **New defaults in separate releases.** Fix/probe preferences coder, negative cache TTL, slug assignment, raw Date conversion, signing/cache serialization and strict freshness individually; HTML5 sanitization and editor changes get browser review. Then consider YJIT/thread/runtime tuning with measurements. Finally raise `load_defaults` only after each relevant switch is accepted. Do not add Solid Queue/Cache/Cable, Propshaft, the authentication generator, Kamal, or Rails CI scaffolding merely because newly generated Rails apps include them; the existing Sidekiq/Sprockets/authentication paths remain deliberate.

### Remaining questions / acceptance criteria

- What are the real PostgreSQL/Redis versions and deployment topology, authoritative production signing-key source, persistent cache sharing, and production mail/storage configuration? Local isolated services were PostgreSQL 15.19 / Redis 7.0.15, not evidence about deployment.
- Do stored preferences contain only the expected safe Hash/String values? How many old attachment SGIDs and scheduled/retry jobs need cross-version coverage? No live data/queues were inspected.
- Will the team accept the zone-correct reminder preview and stage Trix separately? Neither decision should be hidden inside a defaults bump.
- Gate release on a fully passing repaired target suite, real worker integration and meaningful browser tests, plus data/token rollback rehearsal. The assessment provides the plan and reproducible findings, **not an implemented or verified production-ready upgrade**.

### Reviewed exclusions

No app usages were found of Active Record `encrypts`, custom ActiveStorage::BaseController streaming, MemCacheStore/RedisCacheStore, SQLite/MySQL/Azure storage, mailer preview_path, Rails UJS, custom logger extensions, or manual requires of autoloaded app classes. Their upstream upgrade recipes therefore do not currently justify changes. Sprockets is already explicitly declared. Existing public signed-blob access, anonymous direct-upload exposure, missing production mail delivery setup, and abandoned upload cleanup are pre-existing application limitations, not problems this framework upgrade automatically fixes.
