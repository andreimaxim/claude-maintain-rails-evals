# Rails 7.0.8.7 → 8.1.0: Margin Notes upgrade assessment

**Recommendation: proceed as a staged compatibility migration, not a version-only deployment.** Keep `config.load_defaults 7.0` initially. The exact target resolves, but the unchanged application does not boot. Several later changes affect persisted content, atomic imports, and queued digests independently of framework defaults.

No working application files were changed. Experiments used archived disposable checkouts, separately named PostgreSQL databases, a dedicated Redis process, copy-local storage/cache, and synthetic data. This is a plan, not an implemented upgrade or deployment.

## Evidence and scope

Application reviewed: [repository revision](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). Traced all application models, jobs, controllers, mailers, relevant views, configuration, migrations, and existing tests; checked the Rails sources at tags **v7.0.8.7, v7.1.0, v7.2.0, v8.0.0, v8.1.0**, rather than treating current main-branch documentation as the target contract.

Evidence labels below:
- **Executed / app:** the actual archived application ran.
- **Executed / probe:** isolated framework calls reproduced the application's relevant expression or payload shape; this is not an upgraded-app test pass.
- **Source:** application + versioned upstream source establish the change; application validation remains proposed.

### Executed results

| Variant | Configuration and result |
|---|---|
| Baseline | Rails 7.0.8.7, original lockfile, `load_defaults 7.0`; isolated schema load succeeded; `bin/rails test`: **46 runs, 325 assertions, 0 failures/errors/skips**. |
| Target, only Rails changed | Rails 8.1.0, defaults still 7.0; `bundle lock --update rails` and installation succeeded. Boot failed at `config/initializers/action_text.rb:3`: `allowed_tags` is nil. No target application suite was run past this blocker. |
| Target dependency probe | Resolver chose JSON **3.1.0**. Rails 8.1.0 `ActiveSupport::JSON.decode` passes a positional options hash to JSON's now-keyword-only `parse`, raising `ArgumentError`; JSONB/store access and some other probes were obstructed by this. |
| Target + JSON constraint | A separate variant added `gem "json", "< 3"`, resolving **2.21.2**. Framework probes then demonstrated the Rails changes independently of the JSON incompatibility. This variant still contains the unmodified application boot blockers. |
| Cross-version queue | Enqueued synthetic digest-shaped jobs through **real Sidekiq 6.5.12 → dedicated Redis**, retrieved the JSON, and executed it through Active Job on each version. New BigDecimal payloads fail on 7.0; new zoned-time payloads select a different digest day on 8.1. UTC Time + decimal String payloads work in both directions. No real mail was delivered. |

Ruby **3.3.6**, Bundler **2.5.22**, PostgreSQL **15.19**, Redis server **7.0.15**. Ruby meets Rails 8.1's >=3.2 requirement; no Ruby upgrade is necessary for this target. Original Ruby default gems used JSON 2.7.2 and BigDecimal 3.1.5; target selected BigDecimal 4.1.3. Exact lockfiles, probe code, command manifest, output, and logs are alongside this report.

**Important dependency distinction:** Rails 8.1.0 does not require Rack 3. The actual resolution retained Rack **2.2.24**, Sidekiq **6.5.12**, Redis **4.8.1**, Puma **5.6.9**, pg **1.6.0**, Sprockets Rails **3.5.2**, Pagy **8.6.3**, Faraday **1.10.4**, and the existing Hotwire gems; it added rack-session **1.0.2**, rackup **1.0.1**, and action_text-trix **2.1.19**. The built-in Sidekiq adapter instantiated successfully and emitted its 8.2-removal warning. This proves resolution/adapter construction, not full production compatibility. Keep unrelated gem upgrades separate.

## Required compatibility work

Line references are to the original working tree. “7.0-safe” means the recommendation can be prepared on 7.0.8.7, not that its complete application implementation has been tested here.

### R1. Constrain JSON for the exact Rails 8.1.0 target

- **Affected:** `Gemfile` / `Gemfile.lock`; `Note.settings` JSONB, JSON text tags, JSON request and framework decoding.
- **Condition/evidence:** **Executed / probe.** The target's unconstrained JSON dependency selected 3.1.0. Rails calls `JSON.parse(json, options)` but this JSON version accepts options as keywords. The failure appeared in real PostgreSQL JSONB attribute decoding, not just dependency metadata.
- **Recommendation:** constrain `json < 3` for this exact target and retain the reviewed lockfile. The experiment resolved 2.21.2. Do not monkey-patch the JSON parser. Reassess the bound only alongside a Rails version known to support JSON 3.
- **7.0-safe:** a `< 3` constraint allows the existing default JSON 2.7.2; changing its resolved version still needs baseline tests.
- **Validation:** run `ActiveSupport::JSON.decode('{"color":"green"}')`, then save/reload a note with JSON tags and JSONB settings; run request tests on the exact production lockfile. Retain a minimal failure for JSON 3 so a future lockfile update cannot silently reintroduce it.
- **Source:** [Rails 8.1 decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb). The installed JSON 3.1.0 method signature is saved in `json3-decoder-evidence.txt`.

### R2. Action Text allowlist initialization blocks boot

- **Affected:** `config/initializers/action_text.rb:3`, note rendering, imported HTML and rich-text attachments.
- **Condition/evidence:** **Executed / app.** In 7.0, `allowed_tags` is eagerly populated. In 7.1+, nil means “use sanitizer defaults plus Action Text attachment tags”; `nil + [...]` fails regardless of `load_defaults`.
- **Recommendation:** explicitly form the allowlist from the selected sanitizer's safe tags plus `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details`, and `summary`. Do this at a lifecycle point after sanitizer selection (e.g. `after_initialize`), without disabling sanitization or replacing the defaults with only the two custom tags. Keep the inherited safe attributes and Action Text attachment attributes.
- **7.0-safe:** yes, constructing that complete set from `ContentHelper.sanitizer.class.allowed_tags` and the attachment tags works on 7.0 too. The full initializer replacement was not executed.
- **Validation:** production eager boot and development reload; persisted rich text with `details/summary`, bold/link content, and image/file attachments remains intact, while script, event handlers and javascript URLs are removed. Run existing rich-text request tests and a browser edit/save cycle; do not use “boot succeeds” as the sanitizer acceptance criterion.
- **Sources:** [7.0 helper](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/app/helpers/action_text/content_helper.rb), [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb), [sanitizer initializer](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/engine.rb).

### R3. Replace removed model declaration forms without changing data formats

- **Affected:** `app/models/note.rb:10–14`, `app/models/notebook.rb:7`, `db/schema.rb:89,99–100`.
- **Evidence:** **Executed / probe + source.** Keyword `enum status: ..., _prefix: true` is removed in 8.0. The positional coder to `serialize` is removed in 7.2. Aliasing the non-column store accessor `color` via `alias_attribute` raises in 7.2+.
- **Recommendation:** use `enum :status, { draft: 0, ready: 1 }, prefix: true`; use explicit forwarding reader/writer methods for `highlight_color` to `color`; on the 7.1 step use `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`. Retain integer enum values, JSON array text for tags, YAML text for preferences, and native JSONB for settings. Do not switch preferences to JSON or add a Hash type/default as incidental cleanup.
- **Critical 7.0 caveat:** enum and forwarding methods are 7.0-safe (probed). **The JSON keyword-coder rewrite is not:** on 7.0 it silently uses YAML. The probe serialized `["history"]` as `---\n- history\n` instead of JSON. Make that change when moving to 7.1, where both API forms are supported; do not predeploy it on 7.0. Move the YAML spelling at that same stage.
- **Validation:** read pre-upgrade raw rows (nonempty tags, empty tags, nil/empty/nonempty preferences, unrelated settings keys), edit/reload under new code, then read new writes with the rollback version. Assert actual raw JSON/YAML bytes and values, status scope/predicate names, and highlight form persistence. Existing fixture tests do not establish old-row/new-row interoperability.
- **Sources:** [7.0 serialization API](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serialization API](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [7.2 removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-record), [8.0 removals](https://guides.rubyonrails.org/v8.0.0/8_0_release_notes.html#active-record).

### R4. Restore explicit all-or-nothing imports

- **Affected:** `app/models/import.rb:50–60` (`return false` inside the transaction).
- **Condition/evidence:** **Executed / probe + source.** 7.0 rolls back on this non-local return. 7.1 defaults can commit it; 7.2 removes the old rollback behavior entirely. With the current sequence, an invalid later row can leave the import, earlier notes, citations, and rich text committed while the request reports failure. A subsequent user retry can duplicate the earlier rows.
- **Recommendation:** use an explicit rollback and return the transaction result, not unconditional `true` after the block. Use `transaction(requires_new: true)` so a containing transaction (including tests/callers) cannot swallow the intended batch rollback. For example, save the import, iterate rows raising `ActiveRecord::Rollback` on failed `note.save`, end the successful block with `true`, and coerce a rolled-back nil result to `false`. Preserve the failing row's validation errors. Do not rely on the removed configuration switch.
- **7.0-safe:** yes; the probe demonstrated explicit rollback on both versions. The complete nested application implementation is still proposed.
- **Validation:** valid first row followed by invalid DOI/title/reminder row; assert no import, note, new citation, rich text or attachment-association changes both outside and inside an outer transaction. Keep the existing invalid-batch request test. Validate the full successful batch separately. No migration should retroactively “repair” partially applied historical imports without identifying them.
- **Source:** [7.2 removal of rollback-on-return](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-record), [7.1 defaults](https://github.com/rails/rails/blob/v7.1.0/railties/lib/rails/application/configuration.rb).

### R5. Import preview annotations and receipt DOI change independently

- **Affected:** `app/models/import.rb:38–41,63–70`; `app/views/imports/preview.html.erb:22,42–44`.
- **Condition/evidence:** **Executed / probe.** Rails 8.0 makes HWiA `stringify_keys` stringify integer keys too. The view then looks up the old integer line number and silently omits annotations. Separately, 7.2 stops interpreting `citation[:id]` as a custom primary key; `citations` has only a `doi` primary key, so receipts emit nil.
- **Recommendation:** retain integer source-line keys and remove the unnecessary `stringify_keys` in the preview; use `citation&.doi` (or `id` method) for receipts instead of `[:id]`.
- **7.0-safe:** yes; numeric-key lookup and explicit DOI access work on both versions.
- **Validation:** multiline CSV whose rows start at lines 2 and 4, distinct annotations with literal markup, and multiple notes sharing a DOI; assert annotations remain escaped and receipt DOI columns are nonempty/exact. Existing import tests already distinguish both failures; rerun them unchanged where possible.
- **Sources:** [8.0 HWiA change](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md), [7.2 primary-key removal](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-record).

### R6. Markdown generation uses removed string-sum behavior

- **Affected:** `app/models/export.rb:36–42`.
- **Condition/evidence:** **Executed / probe.** Rails 7.1 removes the deprecated Enumerable sum override. `fragments.sum` now starts from numeric zero and raises `TypeError` for strings; exports stay working/retrying rather than completing.
- **Recommendation:** `fragments.join` preserves exact byte concatenation and note ordering. **7.0-safe:** yes, probed.
- **Validation:** the existing multi-note export content assertion, an empty notebook (heading only), cancellation after the first note, and retry of an already-queued export. Existing native `ExportJob` argument shape and persisted job IDs need not change for this Rails-only upgrade.
- **Source:** [7.1 Active Support removals](https://guides.rubyonrails.org/v7.1.0/7_1_release_notes.html#active-support).

### R7. Secrets API removal breaks citation enrichment

- **Affected:** `app/models/citation/provider.rb:13–14`, `config/secrets.yml`; `test/controllers/citation_enrichments_controller_test.rb:45,117–122`; setup documentation.
- **Condition/evidence:** **Source.** `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2. Enrichment fails when constructing the provider; a test fresh-boot path and its local HTTP-server setup use the removed API too.
- **Recommendation:** move only citation settings to an application-owned config file loaded with `config_for` into `config.x.citation_provider`, or directly populate that setting from the same environment variables. Preserve development/test stand-in defaults, production missing-setting behavior, symbol keys, and exact string credentials. Update the provider and test boundary together, then remove the now-unused secrets file and its obsolete references. Do not change the production signing secret as part of this settings move.
- **7.0-safe:** yes, `config_for`/`config.x` already exist. Avoid logging settings values.
- **Validation:** existing fresh-process test with user `00123` and password containing `:`, `#`, spaces; success, 401, missing provider config, transient 503 retry and final failure. Check server and worker read identical environment settings.
- **Source:** [7.2 Railties removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#railties).

### R8. Reminder scheduling and citation retry API removals

- **Affected:** `app/models/note.rb:61`; `app/jobs/citation_enrichment_job.rb:7`.
- **Condition/evidence:** **Executed / probe.** Numeric `wait_until` is no longer converted to a Time (numeric scheduled_at support removed in 7.2); serialization calls `utc` on the Integer and fails. `:exponentially_longer` is removed in 7.2; it fails only when an unavailable-provider error is retried.
- **Recommendation:** pass `Time.at(reminder_epoch).utc`; keep the database epoch and Sidekiq schedule score unchanged. At the **7.1 step**, rename wait to `:polynomially_longer` (same fourth-power + jitter + 2 algorithm), keeping attempts 3. Do not “correct” it to exponential backoff.
- **7.0-safe:** Time conversion yes (probed). **Renamed retry symbol no:** 7.0 recognizes only the old symbol. Use the intermediate 7.1 step instead of prematurely changing it or discarding jitter with a simplistic lambda.
- **Validation:** schedule the exact second `1793451617`, verify Redis sorted-set timing and persisted `reminder_job_id`, replace/postpone and execute both old and new jobs, ensure only the current job sends. Exercise provider retries (3 job attempts × 2 HTTP attempts) including actual delay ranges and final failed state. Include scheduled jobs produced before the upgrade; Sidekiq's outer scheduling score remains numeric while newer Active Job adds an ISO scheduled_at field.
- **Sources:** [7.2 Active Job removals](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html#active-job), [7.0 retry algorithm](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/exceptions.rb), [8.1 core serialization](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).

### R9. Digests need a stable day and wire contract before mixed-version workers

- **Affected:** `app/models/user.rb:34–56`, `app/jobs/digest_job.rb`, `app/mailers/digest_mailer.rb:7–10`.
- **Condition/evidence:** **Executed / real queue probe.** The reservation key uses a UTC date, but the mailer uses the deserialized argument's local date/all_day. 7.2 preserves the TimeWithZone zone; previously the worker normalized it to UTC. For the existing test's 2026-10-05 03:30 UTC / New York 2026-10-04 23:30 request, new jobs select **October 4 Eastern**, not **October 5 UTC**. BigDecimal is always explicitly serialized in 7.2+, even with older defaults; a 7.0 worker cannot deserialize that serializer.
- **Recommendation:** preserve the documented UTC digest semantics explicitly. Normalize `requested_at` to UTC in the mailer for both old and new queued jobs; produce UTC `Time` plus `reading_completion.to_s("F")` as the stable job arguments. The mailer already accepts decimal strings. Keep the Redis reservation key and its two-day TTL unchanged.
- **7.0-safe:** yes; the prepared payload worked on both readers through real Sidekiq/Redis. The existing test assertion that the payload carries local time should be updated deliberately; keep its UTC content/date assertions. This is behavior preservation, not a new local-day digest feature.
- **Validation:** all producer/consumer combinations, including legacy string completion, new BigDecimal completion, prepared strings; east/west zones spanning UTC midnight and DST. Assert actual subject and inclusion/exclusion of ready notes straddling both UTC and local midnight, not just enqueue counts. Test reservation refusal and enqueue failure release. The Active Job test adapter alone does not JSON-round-trip BigDecimal the way Sidekiq does.
- **Rollout:** deploy the stable producer/normalizing consumer on 7.0 first to every producer and worker. Inspect existing immediate/scheduled/retry/dead jobs before switching writers. If any new-serializer jobs have already been written, **rollback to unprepared 7.0 is unsafe**: drain them with a compatible worker or use a deliberately verified compatibility reader. Do not erase Redis reservations or queues to make rollback work.
- **Sources:** [7.1 BigDecimal rollout guidance](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 zone/serializer changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 TimeWithZone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

### R10. Preserve or deliberately change the DST preview contract

- **Affected:** `app/models/note.rb:40–44`, reminder display and postponement; `test/controllers/reminders_controller_test.rb:20–21`.
- **Condition/evidence:** **Executed / probe.** 8.1 `TimeWithZone#to_time` retains the named zone, not just the current offset. For October 31 09:00 Eastern + 86400 seconds, the old preview is `2026-11-01T09:00:00-04:00`; new is `2026-11-01T08:00:00-05:00`. **These are the same instant**: postponement remains 24 elapsed hours, not 25 or a local calendar day. This is unconditional in 8.1, not prevented by `load_defaults 7.0`.
- **Recommendation:** for a strictly behavior-preserving upgrade, replace `to_time` with explicit `getlocal(reminder_at.utc_offset)` before adding seconds. Alternatively accept the arguably clearer zone-correct preview in a separate intentional UX change and update the architecture/test contract; do not quietly change to `1.day` calendar arithmetic. The old preservation flag cannot restore this behavior in 8.1.
- **7.0-safe:** explicit fixed-offset conversion yes (probed).
- **Validation:** spring-forward and fall-back cases; assert both preview string and epoch delta exactly 86400, plus the actual scheduled/delivered instant.
- **Sources:** [8.1 removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#active-support), [8.1 to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

### R11. Split the two list routes; preserve test exception behavior

- **Affected:** `config/routes.rb:18`; `config/environments/test.rb:31`; authorization tests expecting exceptions.
- **Condition/evidence:** routes **executed / probe**, exception behavior **source**. 8.1 removes multiple positional paths; define separate `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"` and keep both helper names. 7.2 removes boolean show_exceptions support; on 8.1, `false` falls into the “show” branch rather than `:none`.
- **Recommendation:** split routes on 7.0; on the 7.1 step change test `show_exceptions` to `:none`, retaining existing assertions that unauthorized access raises `RecordNotFound`. Separately test production-style 404 responses; do not relax authorization expectations simply to get green tests.
- **7.0-safe:** split routes yes (probed); **`:none` no**—7.0 checks false rather than the new symbolic modes. Make that setting change with 7.1.
- **Validation:** both list URLs and helpers, same ordering/filters/pagination; missing/foreign note/notebook import/export/reminder requests raise in test mode and return appropriate HTTP errors in production-like mode. Existing suite covers most of this once it can boot.
- **Sources:** [8.1 routing removal](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#action-pack), [8.1 exception wrapper](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb).

## Optional framework defaults: adopt separately, after compatibility is green

Changing the gem version and changing `load_defaults` are different releases. The current application explicitly loads 7.0 defaults. Do not run `app:update` with blanket overwrite or introduce new infrastructure just because generators do.

| Default / affected code | Applicability and recommendation | 7.0 preparation and discriminating validation |
|---|---|---|
| **7.1 readonly assignment raising** — `Notebook.attr_readonly :slug`; settings controller permits slug and form resends it | Opt-in with newer defaults. Even resubmitting the **unchanged** slug raises (probe). Remove slug from permitted settings and the hidden form field; retain model-level readonly protection. | Safe on 7.0; assert unchanged slug submission and malicious changed slug do not crash and never alter persisted slug, while name/heading update. |
| **7.1 default_column_serializer=nil** — `Notebook.serialize :preferences` | Opt-in; without explicit YAML coder, newer defaults raise on this declaration. R3 must precede adoption. Existing YAML is not automatically migrated. | Move explicit coder spelling at 7.1; inspect/read/write nil, empty and nonempty old YAML. |
| **7.1 HTML5 sanitizer vendor** — imported and stored Action Text HTML | Optional default; keeping HTML4 avoids an unrelated parser switch initially. R2 is mandatory regardless. HTML5 can normalize malformed nesting differently; fresh simple fixtures do not cover legacy content. | R2 set composition is preparable; vendor setting is a newer-version API. Compare an anonymized corpus with malformed lists/tables, links, details and attachments under both parsers, render and edit/save. Do not bulk-rewrite stored bodies as part of changing parser defaults. |
| **Negative fragment TTL policy** — `app/views/exports/_export.html.erb:26` | An expired export supplies negative `expires_in`. **Probe:** 8.1 compatibility mode discards the negative TTL and caches without expiry; 7.1+ strict default raises instead. The default change is optional, but fix the invalid caller now: only cache a future availability window, preferably `cache_if ...` with absolute `expires_at`; render expired state uncached. Keep download authorization before `stale?`. | Safe on 7.0. Test cache miss and hit at expiry−1s, exactly expiry, expiry+1s with caching **enabled**, both strict/compatibility settings. Existing null-store tests miss this; the cache-specific test helps, but add exact boundary and cold expired render. |
| **7.2 PostgreSQL date decoding** — `Notebook#daily_note_counts:40` | Opt-in. Raw `select_rows` starts returning Date, so `Date.iso8601(day)` raises (probe). Before adoption accept Date directly, or parse only a String. This is not a database date-format migration. | Type-aware conversion is 7.0-safe. Run the existing UTC-boundary report test with decoder off/on and verify newest-first dates/counts and isolation from another reader. |
| **7.2 transaction-deferred Active Job enqueue** — `Citation#request_enrichment`, `Note#schedule_reminder` | Nuance: 7.2's new defaults use adapter-dependent deferral; **8.1 job-class default is false** and `load_defaults 8.1` does not turn it on. Do not claim Rails 8.1 automatically changes these calls. If deliberately enabled, enqueue failure can happen after DB commit, leaving pending citation/new reminder ID instead of rolling back. | No class setting on 7.0; on 7.2 use supported symbols, on 8.1 boolean false/true (symbols were removed and are truthy). Preserve immediate enqueue during this upgrade unless redesigning its failure contract. Test real queue failure under a row lock and an outer transaction, DB state, provider job ID and concurrent worker timing. |
| **8.0 strict conditional freshness** — `ExportDownloadsController#stale?` | Optional: matching If-None-Match takes precedence over contradictory If-Modified-Since rather than requiring both. May turn a 200 into 304; not an authorization bypass because expiry/ownership checks occur first. | Keep old flag until adoption. Test matching ETag + stale date, nonmatching ETag + fresh date, ETag-only, expired export and foreign owner. Existing tests lack conflicting validators on an unexpired file. |
| **7.1+ cache/message serialization** | Optional format adoption has rollout risks detailed below. Keep cache 7.0, legacy message serializer/metadata until all readers are compatible. | These newer knobs are not equivalent 7.0 settings; retain old defaults. Test both read directions and rollback, not only new reads of old values. |

Source of these default gates: [8.1 versioned load_defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), [7.2 implementation](https://github.com/rails/rails/blob/v7.2.0/railties/lib/rails/application/configuration.rb), [8.1 enqueue implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb), [8.1 cache option normalization](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb), [conditional freshness](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb).

Other defaults have no identified app-specific blocker: no AR Encryption declarations, no custom autoload-path `require`, no custom Active Storage streaming subclasses, no application broadcasts or inbound mailbox implementation, no SQLite/MySQL adapters, no custom transaction callbacks/secure tokens/AR-object caches. Existing finders use primary keys or explicit orders; redirects use paths/helpers, not path-relative strings. Review default changes, but do not invent migration work for unused APIs. Alphabetical schema dumps in 8.1 are formatting, not a required column reorder. Keep historical migration version annotations.

## Front-end / rich-content validation gate

**Source-based risk, not an observed browser failure:** `app/views/layouts/application.html.erb:10–13` explicitly loads vendored **Trix 1.3.5**, while `config/importmap.rb` obtains the upgraded Rails Action Text JS and `app/assets/stylesheets/actiontext.css` loads framework-provided Trix CSS. Rails 8.1 gets Trix >=2.1.15 from the new `action_text-trix` gem (resolved 2.1.19); Action Text declares a Trix 2 peer dependency. The old editor override survives a Rails gem update, so the app will not automatically use the matching editor.

Recommend aligning editor JS/CSS with the target's Trix package when the backend compatibility work lands, removing only the now-obsolete 1.3.5 override/assets after reference checking. This is not a 7.0 preparatory swap: the current override fixes a documented 7.0 editor issue. Keep Sprockets, importmap and existing Turbo/Stimulus; Propshaft is not required. Avoid blindly rerunning installation generators.

Proposed acceptance: production asset precompile, browser create/edit/save/reopen of a pre-upgrade note containing links, lists, literal markup, inline image and file attachments; upload/reject >1MB; failed validation keeps input; Turbo navigation initializes one editor. Test a pre-existing details/summary excerpt: the repository already documents that Trix flattens these on save. Do not mislabel that known limitation as a new Rails regression or claim it is fixed. No system test cases are present; the system-test base alone provides no browser coverage. No browser check was run during this read-only assessment.

Source: [8.1 Action Text changes](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md), [peer dependency](https://github.com/rails/rails/blob/v8.1.0/actiontext/package.json).

## Stored data, signatures, queued work, and rollback

1. **Signing identity must remain stable.** `secret_key_base`, key-derivation settings, application identity, storage service names, DB records and blob files must survive the upgrade. On development/test, Rails 7.1 renames `tmp/development_secret.txt` to `tmp/local_secret.txt`: preserve/copy the same value securely before the first new boot. Do not print it or commit it. Production's actual key source is not verified; `config/secrets.yml` here contains citation settings, not a production signing key.
2. **Session cookies vs general messages are distinct.** `load_defaults 7.0` already uses JSON cookies and SHA256 key derivation. Do not prescribe an irrelevant 6.1→7.0 digest rotation. The 7.1 general-message serializer becomes `:json_allow_marshal` and enables the new metadata envelope. New readers can accept old formats; that does **not** imply old readers accept new formats. Cookie middleware uses a special null serializer internally; do not assume the general envelope switch itself changes these session cookies. Still test login/session/CSRF round trips in both directions with stable keys.
3. **Action Text SGIDs are durable database content.** Persisted `action_text_rich_texts.body` contains signed blob identities; Active Storage also uses a message verifier for URLs/direct uploads. Preserve legacy message output while any 7.0 reader/rollback target exists. New-format SGIDs written into bodies do not expire away like short-lived cookies; draining jobs alone does not make rollback safe. Before changing message defaults, test pre-upgrade attachment rendering and new-body rendering on rollback code with the same synthetic key, purposes and expiry rules. Preserve old secret rotations until old content has been accounted for; do not regenerate all signing keys as a shortcut. The full application SGID/cookie cross-version matrix is **proposed**, not executed here.
4. **Cache is disposable; Redis is not all cache.** Development uses memory/null stores, tests null, production has no explicit override (Rails default file store). Redis holds Sidekiq and digest reservations. Keep cache format 7.0 while sharing with old readers, or change only the cache namespace/path and allow cold misses; new 7.1 cache format isn't a two-way guarantee with 7.0. Never `FLUSHDB` the app Redis to solve cache compatibility. Capture and verify any real production cache override first.
5. **Job inventory must include more than the immediate queue.** Include Sidekiq scheduled/retry/dead sets: future `NoteReminderJob`s can remain long after deploy; old retry jobs retain attempts; framework blob analysis/purge jobs may also be present. Preserve classes, GlobalID model identity, DOI primary keys, IDs and Sidekiq wrapper compatibility. Execute old reminders, citation retries, exports and blob jobs under new workers in staging. The executed queue matrix covered the risky digest types, not every job class or real worker process.
6. **Rollback should target the prepared release, not the untouched original.** Keep UTC/string digest producers, explicit rollback/import fixes, enum/alias fixes and key identity during rollback. If formats have been advanced, require a reader-compatible rollback build or pause producers and drain/convert narrowly inventoried incompatible payloads with backup and authorization. Do not drop jobs, reset reminder IDs, clear reservation sets, or revert DB content to an old snapshot and silently lose new notes.
7. **Keep the storage volume, not just database rows.** Existing exported files and rich-text attachments remain on Disk. No required bulk rewrite of tags, preferences, notes or blob files was found. Back up database + storage consistently; retain both through rollout/rollback. Confirm actual production storage topology before deployment. Export expiry does not purge files in this app.

Sources: [versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [8.1 message metadata](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/messages/metadata.rb), [cache fallback serializers](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache/serializer_with_fallback.rb), [Active Storage verifier](https://github.com/rails/rails/blob/v8.1.0/activestorage/lib/active_storage/engine.rb).

## Execution plan and release gates

1. **Prepare on 7.0.8.7:** add behavior-preserving enum/forwarder, explicit atomic-import handling, DOI/annotation access, export join, Time scheduling, UTC/string digest boundary + UTC consumer, split routes, settings-source migration, expiry-safe caching, and optional readonly/date-decoder readiness. Fix the Action Text initializer without broadening its safe defaults. Add the discriminating tests above; run full existing suite. Do **not** predeploy JSON keyword coder, renamed retry symbol, or symbolic exception mode.
2. **Move one minor at a time: 7.1 → 7.2 → 8.0 → exact 8.1.0**, using reviewed patch releases for intermediate steps and recording each lockfile. At 7.1 switch coder/retry/exception syntax and read deprecations in an isolated production-like environment (production config normally suppresses them). Review `app:update` diffs instead of overwriting application configuration. Keep `load_defaults 7.0`. No intermediate full-app experiments were performed in this assessment.
3. **Pin compatible dependency resolution:** apply the JSON constraint for 8.1.0, review all transitive changes and target platforms. Keep Sidekiq/Redis/Puma/Rack/Faraday/Pagy upgrades out of the Rails-only change unless executed compatibility evidence requires them. Run bundle check, eager loading, isolated DB/schema/migration setup, full request/model tests, asset precompile and browser workflow checks on the exact lockfile. New empty system suites are not evidence of browser correctness.
4. **Verify mixed releases before deploy:** run an anonymized persisted-data corpus and producer/consumer matrix; perform failure injection for enqueue failure and transaction rollback; rehearse rollback with new data and surviving scheduled work. Confirm production secrets, storage, mail settings, cache and worker topology. The repo explicitly lacks a verified production mail configuration; assessment is not deployment readiness approval.
5. **Deploy prepared code everywhere, then framework changes:** migrate readers before incompatible writers; keep signing/cache/wire formats stable. Observe failed/dead jobs, pending citations, stuck exports, 500s, digest date/content, reminder timings and attachment resolution. Preserve old browser asset versions during rolling deploys.
6. **Adopt new defaults in separate, reversible changes** after the framework release is stable and the rollback boundary is documented. Move format-writing defaults only when every reader is compatible and durable new-format content is supported by the rollback release.

### Separate future Sidekiq upgrade

Rails 8.1 warns that its built-in adapter is removed in 8.2 and recommends Sidekiq >=7.3.3. That is future maintenance, **not a proven Rails 8.1 blocker**. If undertaken, perform a separate Sidekiq/Redis audit: `Notebook#request_export` currently passes a symbol-keyed options hash (strict JSON risk); `User#request_digest` relies on redis-rb's boolean single-member `sadd` (integer zero would be truthy); export cleanup rescues `Redis::BaseError` (new clients may raise different classes). Validate new-insertion vs duplicate reservations, failed queue cleanup, strict argument checking and worker/server requirements. Do not mechanically upgrade Sidekiq and assume its redis-client behavior matches redis-rb 4. This separate upgrade was not executed.

## Remaining uncertainty / what this assessment does not prove

- Full 8.1 application boot/tests and browser flows remain blocked/proposed; standalone probes do not substitute for them.
- Production DB/Redis versions, signing-key provenance, environment overrides, cache sharing, storage mounts, queued payload inventory, and real stored HTML/YAML/JSON content were not inspected. No real application services or data were modified.
- Intermediate patch versions need selection and resolution at implementation time. Only the two endpoint Rails versions were executed; intermediate conclusions are from tagged source/release notes.
- Exact 8.1.0 was evaluated as requested. Deployment should also independently review currently available security fixes and maintenance policy; this assessment is not a security clearance for the .0 release or older retained infrastructure gems.
- Existing public blob URLs, anonymous direct-upload policy, lack of unattached-file cleanup, and possible repeated email delivery after retries are documented pre-existing limitations, not claimed fixed by this upgrade.

## Evidence index

See [COMMANDS.md](COMMANDS.md) for resource isolation, exact commands, variants and cleanup. Principal files:
- `baseline-test.log`, `baseline-schema.log`, `baseline.Gemfile.lock`, `baseline.database.yml`, `baseline-rails-test.log`.
- `target-resolve.log`, `target-install.log`, `target-boot.log`, `target-sidekiq-adapter.log`, `target.Gemfile`, `target.Gemfile.lock`.
- `baseline-probe.log`, `target-probe-initial.log`, `target-probe-diagnostic.log`, `target-json2-probe.log`; `probe.rb` and initial/diagnostic versions. Errors are retained, not suppressed as passing results.
- `target-json2.Gemfile`, `target-json2.Gemfile.lock`, resolve/install logs, `json3-decoder-evidence.txt`.
- `wire_probe.rb`, `*-wire-emit.log`, `*-wire-read.log`, `*.sidekiq.json`: synthetic cross-version queue payloads and results.
- Versioned upstream archive checksums and relevant configuration snapshot.
