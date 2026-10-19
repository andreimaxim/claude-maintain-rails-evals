# Margin Notes: Rails 7.0.8.7 → 8.1.0 upgrade assessment

**Recommendation: proceed as a staged compatibility migration, not a Gemfile-only upgrade.** Keep `config.load_defaults 7.0` during the framework migration, then adopt defaults independently. Several changes below apply even with old defaults. No working-application files were changed; all runtime experiments used disposable copies and dedicated resources.

Assessment date: 2026-10-19. Application revision: [reviewed commit](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). Requested target is exactly 8.1.0, not an assertion that this is the latest or preferred security patch. Check supported patch/security releases before deployment; that policy review is not performed here.

## 1. Scope and evidence

The application uses PostgreSQL; JSON text tags and YAML notebook preferences; jsonb highlight settings; Action Text with a custom allowlist and vendored Trix 1.3.5; local Active Storage; CookieStore login; Active Job through Sidekiq 6.5.12; a native Sidekiq export job; Redis digest reservations; import/export workflows; time-zone-sensitive reminders/digests; and conditional HTTP/fragment caching for exports. Production's unspecified cache store falls back to Rails' FileStore under `tmp/cache`, not Redis. Test cache is NullStore except the explicit export cache test. No application encryption, custom Active Storage streaming controller, multi-database configuration, or business Action Cable broadcasts were found.

### Executed checks, not inferred results

- **Baseline:** Ruby 3.3.6 / Rails 7.0.8.7 / original lockfile: `bin/rails test` passed **46 runs, 325 assertions, no failures/errors/skips**.
- **Target dependency resolution:** `bundle lock --update rails --conservative` and `bundle install` succeeded with Rails 8.1.0, **Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, Puma 5.6.9, Sidekiq 6.5.12, redis 4.8.1, pg 1.6.0**. Rails 8.1.0 does not require Rack 3. Ruby's >=3.2 requirement is satisfied. Do not force unrelated upgrades just to resolve Rails.
- The unconstrained new dependency **json 3.1.0 is incompatible with Rails 8.1.0's positional-options `JSON.parse` call**. A full backtrace isolated this, rather than attributing the errors to model code. Constraining json to `~> 2.0` resolved **2.21.2** and removed that failure. Bigdecimal resolved to 4.1.3; action_text-trix to 2.1.19. Full locks are retained.
- **Untouched target application boot:** fails in the Action Text initializer (`nil + tags`).
- **Target diagnostic variant:** only the allowlist, multi-path route, Note enum, tags declaration, highlight delegation, test exception setting, and JSON dependency were adjusted to expose downstream behavior. With Rails **7.0 defaults**, the existing suite produced **46 runs, 174 assertions, 3 failures, 15 errors**. This is not a completed migration or a passing target suite.
- Separate application/framework probes confirmed partial import commits, blank receipt DOIs, changed annotation keys, integer scheduling failure, changed DST presentation, removed string-sum behavior, plural association query failure, and new job wire formats. These bypassed earlier failures that mask later assertions in existing tests.
- Additional probes enabled selected new defaults in-process: decoded PostgreSQL dates, readonly assignment enforcement, and invalid-cache-expiry raising all expose application failures. **A full app boot/suite with `load_defaults 8.1` was not run.**
- A Rails 8.1 job payload containing its new BigDecimal serializer **cannot be read by Rails 7.0.8.7** (`ActiveJob::DeserializationError`). Rails 8.1 read the legacy payload as a decimal string and UTC time.

All commands, exact dependency locks, synthetic payloads, variant patch, configuration, stdout/stderr, and Rails logs are in [the evidence directory](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/). See its `README.md` for reconstruction and run ordering. Runtime databases were `mn_rails_review_5586_baseline` and `mn_rails_review_5586_target`; Redis was a new instance on loopback port 16386, not the application's Redis. Files, cache, storage, and mail were copy-local; mail delivery was `:test`. No production data, existing queued work, or real provider was used.

### Versioned upstream basis

Read the [8.1 upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html) and release notes for [7.1](https://guides.rubyonrails.org/v7.1.0/7_1_release_notes.html), [7.2](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [8.0](https://guides.rubyonrails.org/v8.0.0/8_0_release_notes.html), and [8.1](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html). The release-note changelog links sometimes point at moving branches; this assessment instead read source archives tagged **v7.0.8.7, v7.1.0, v7.2.0, v8.0.0, and v8.1.0**. Specific source links accompany findings. Patch-level transitions between these releases still need the staged deprecation/test gates below.

## 2. Required changes: independent of adopting new defaults

### R1. Preserve all-or-nothing CSV imports

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb), reached from [ImportsController#create](file:///home/user/workspace/repo/app/controllers/imports_controller.rb).

**Condition/change:** a later CSV row fails validation after the import and an earlier row were saved. `return false` exits the transaction nonlocally. Rails 7.0 rolls that work back; Rails 7.2 removed that behavior, and 8.0 removed the compatibility setting. Keeping 7.0 defaults does not restore it. Source: [7.2 Active Record changes](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

**Observed:** the same valid-first/invalid-second CSV returned `false` in both versions; baseline record deltas were `[0,0,0,0]`, target deltas were **one import, one note, one citation, one rich-text body**. This can silently corrupt the advertised atomic-import contract.

**Recommendation:** use explicit rollback rather than nonlocal return: on a failed `row.note.save`, raise `ActiveRecord::Rollback`; make the transaction's success value `true` and convert its rollback result to `false`. If callers may already be inside a transaction, use a savepoint (`requires_new: true`) so the import rollback is local and real. Preserve row validation errors for the preview. **Compatible with 7.0.8.7.** Do not merely change to `break`, nor leave an unconditional `true` after a swallowed rollback.

**Validation:** valid first row creates a new shared DOI and rich text, invalid second row; assert false/422, errors remain, and zero persisted deltas in every involved table, both outside and inside a caller transaction. Existing request coverage has this intent, but target tests fail on the preview annotations before reaching it. On rollout, no schema migration is needed. If this failure ever reaches production, rollback of code does not remove partially imported data; reconciliation must use an audited import list, not indiscriminate deletion.

### R2. Preserve DOI receipts and line-number annotations

**Affected:** [Import#receipt and #annotations](file:///home/user/workspace/repo/app/models/import.rb), [preview template](file:///home/user/workspace/repo/app/views/imports/preview.html.erb).

- **DOI:** Rails 7.2 stops treating `read_attribute(:id)`/`record[:id]` as a custom primary-key accessor. `citations` has primary key `doi`, no `id` column. The target probe emitted `Receipt,` instead of the DOI. Use **`citation&.doi`** (or `id`, but DOI is clearer), not `citation[:id]`. **Works on 7.0.** Assert downloaded CSV preserves an exact mixed-case DOI and has a blank field only for an uncited note. Source: [7.2 AR removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).
- **Annotations:** Rails 8.0's `HashWithIndifferentAccess#stringify_keys` now converts integer keys too. The preview stringifies line keys then reads them using `row.line` integers, losing all annotations. Remove the unnecessary `stringify_keys` and keep integer indexing. **Works on 7.0.** Validate distinct annotations on source lines 2 and 4, including a quoted multiline CSV field and escaped HTML. This is presentation loss, not loss of stored annotation text. Source: [8.0 AS changes](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).

### R3. Keep JSON tags JSON; preserve YAML preferences

**Affected:** [Note serialization](file:///home/user/workspace/repo/app/models/note.rb), [Notebook preferences](file:///home/user/workspace/repo/app/models/notebook.rb), existing `notes.tags` / `notebooks.preferences` text columns.

**Required API change:** the second positional `serialize` argument is removed in Rails 7.2. On **Rails 7.1 or later**, use `serialize :tags, coder: JSON`. **Do not deploy that spelling on 7.0:** an executed type-serialization probe wrote `---\n- one\n- two\n` (YAML), not JSON. The keyword is not interpreted as the coder in 7.0. Keeping old syntax until the 7.1 hop is safer than inventing a cross-version wrapper.

**Optional-default dependency:** `serialize :preferences` still works with retained 7.0 defaults on Rails 8.1, but 7.1 defaults set `default_column_serializer = nil`. Before enabling those defaults, explicitly use `serialize :preferences, coder: YAML` on 7.1+. Preserve YAML; do not switch to JSON without a separate dual-read/data-migration plan. The 7.0-compatible explicit form is `serialize :preferences, YAML`, not the later keyword migration.

**Validation:** use old SQL bytes, not only objects created by the new ORM: JSON `[]`/nonempty Unicode tags and YAML null/empty/nonempty string-key preferences. Read/write through each version and inspect column bytes, then read new writes on the rollback version. Preserve null/default semantics rather than gratuitously adding `type: Hash`/`Array`. Inventory real stored preferences for permitted YAML classes before changing safe-load options; none were sampled here. Never enable unsafe YAML loading as a blanket fix.

Sources: [7.0 implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [versioned defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).

### R4. Update Note's enum and virtual highlight alias

**Affected:** [Note](file:///home/user/workspace/repo/app/models/note.rb) and its forms/strong parameters.

- Rails 8.0 removes keyword enum definitions. Change to **`enum :status, { draft: 0, ready: 1 }, prefix: true`**. Preserve integer mappings and the existing `status_ready`/`status_draft` method names. **This form works on 7.0**, as the other models already demonstrate.
- Rails 7.2 rejects `alias_attribute :highlight_color, :color` because `color` is a store accessor, not a database attribute. Implement explicit `highlight_color` and `highlight_color=` forwarding to `color`/`color=`. **Works on 7.0.** Do not alias directly to a fictitious column or bypass the jsonb store/validation machinery.

**Validation:** edit/save/reload a non-default highlight and tags through the real form; reject an unknown color; retain another settings key; verify enum scopes and persisted status values. Raw alias probe failed on target and succeeded on baseline. Sources: [7.2 AR removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.0 AR removals](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).

### R5. Repair note-list query, search form, and bookmark alias

**Affected:** [NotesController#index](file:///home/user/workspace/repo/app/controllers/notes_controller.rb), [notes index](file:///home/user/workspace/repo/app/views/notes/index.html.erb), [routes](file:///home/user/workspace/repo/config/routes.rb).

- Rails 7.2 removes plural references to singular associations: `where(notebooks: @notebook)` becomes **`where(notebook: @notebook)`** (or `notebook_id: @notebook.id`). Preserve the existing owner-scoped lookup. Target executed SQL incorrectly queried `notes.notebooks` and failed.
- Rails 8.0 rejects explicit `form_with(model: nil, ...)`. **Omit `model:`** for this unbound GET form; keep its URL, method, and field names.
- Rails 8.1 removes the two-path routing shorthand. Split into **`get "/notes", to: "notes#index"`** and **`get "/journal", to: "notes#index"`**, preserving `/journal` as an equivalent list endpoint, not a redirect.

**All three preparations work on 7.0.** Validate both paths, combined notebook/status/title filters with another owner's records present, pagination/filter links, and the unbound form's query names. Existing tests cover much of this. Sources: [7.2 AR](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.0 Action View](https://github.com/rails/rails/blob/v8.0.0/actionview/CHANGELOG.md), [8.1 Action Pack removals](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html#action-pack).

### R6. Fix Action Text initialization without discarding its safe defaults

**Affected:** [allowlist initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb), imported/stored rich text, embedded attachments.

From Rails 7.1, `ContentHelper.allowed_tags` defaults to nil; the effective defaults are computed at render time. The current `+=` crashes boot even with 7.0 defaults. **Do not fix this by replacing nil with an empty set and allowing only details/summary.** Retain the configured sanitizer's safe tags **plus** `ActionText::Attachment.tag_name`, `figure`, and `figcaption`, then add `details` and `summary`. A conditional fallback from existing `allowed_tags` to that union works on 7.0 too. On the newer framework, compute it after the sanitizer vendor has been selected, for example in `config.after_initialize`; don't freeze the HTML4 list accidentally when opting into HTML5.

**Validation:** boot/eager-load; render legacy bold/link/list/collapsible content and an embedded blob while dropping scripts/event handlers/javascript URLs; then save and reload through the editor. Test malformed nested HTML separately under both sanitizer vendors. Sanitization is render-time, but editor round trips can permanently rewrite stored HTML. This is not permission to purge or bulk-rewrite existing rich-text bodies.

Source: [7.1 Action Text changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [8.1 helper implementation](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb). The temporary diagnostic allowlist retained framework attachment tags; it is not a completed vendor-adoption implementation.

### R7. Replace removed secrets and retry APIs

**Affected:** [Citation::Provider](file:///home/user/workspace/repo/app/models/citation/provider.rb), [secrets.yml](file:///home/user/workspace/repo/config/secrets.yml), [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb), [provider request tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb).

- **Settings:** `Rails.application.secrets` is removed in 7.2. Move provider settings to an ordinary environment-backed `config_for` file and expose them through `config.x.citation_provider`; keep the same environment variable names, development/test stand-in defaults, and production absence behavior. Update the test helper that currently mutates `Rails.application.secrets`, not just the provider. **`config_for`/`config.x` preparation works on 7.0.** An interim `config_for(:secrets).fetch(:citation_provider)` also avoids the removed API, though renaming the config clarifies its purpose. Never print actual credentials.
- **Retries:** `wait: :exponentially_longer` is removed in 7.2. Rename it to **`:polynomially_longer` on Rails 7.1**, retaining three attempts and the exhausted-retry failure callback. The new symbol **does not work on 7.0**; do not apply it in the initial prep release. The algorithm was polynomial already. Do not silently replace it with an exponential formula or drop its jitter.

**Validation:** a fresh process must send the configured URL/basic-auth values unchanged (including punctuation), and no configured provider must still produce the existing visible failure. Simulate successive 503s, 401, malformed JSON, and transient connection failures. Assert three job executions maximum, at most six HTTP requests with Faraday's own retry, and no hand-off to Sidekiq retries for the handled exhaustion. Inspect scheduled delays as well as the eventual failure message; the current helper performs retries without proving real waiting. Sources: [7.2 release notes](https://guides.rubyonrails.org/v7.2.0/7_2_release_notes.html), [7.0 retry algorithm](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/exceptions.rb).

### R8. Keep exports working and fix negative fragment TTLs

**Affected:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb), [export partial](file:///home/user/workspace/repo/app/views/exports/_export.html.erb).

- Rails 7.1 removes Active Support's nonnumeric zero-argument `sum` behavior. Replace **`fragments.sum` with `fragments.join`**. **Works on 7.0**, preserving the actual string contract including the empty-notebook heading. Otherwise exports fail after entering working state and Sidekiq retries them.
- An expired completed export supplies **negative `expires_in`**. On target with old defaults, a negative-expiry probe discarded the invalid expiry and retained the cache value; with 7.1 defaults it raised `ArgumentError`. This is not only an opt-in crash. Render expired availability uncached; cache future availability with a **nonnegative** TTL (compute the remaining duration once; cap at zero if needed). `cache_if` with a valid TTL is available on 7.0. Simply switching to a past `expires_at` does not solve the issue: Rails converts it to a negative interval too.

**Validation:** empty and multiple-note Markdown exports; cache enabled with a cold cache before, at, and after the deadline; warm-hit then deadline crossing; distinguish availability rendering from download authorization. Existing export tests include a warm cache/authorization case but normal tests disable caching, and the target sum error hides the expiry path. Do not loosen the download controller's ownership/expiry checks. No blob purge or data-format migration is required; legacy failed jobs can retry on corrected workers. Sources: [7.1 AS removals](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [8.1 cache option processing](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb).

### R9. Make reminder scheduling and DST presentation explicit

**Affected:** [Note#schedule_reminder / #next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb), [reminder requests](file:///home/user/workspace/repo/app/controllers/reminders_controller.rb).

- Rails 7.2 removes numeric `scheduled_at` support. Pass **`Time.at(reminder_epoch)`** to `set(wait_until:)`, while retaining the persisted integer epoch. **Works on 7.0.** Target failed with `undefined method utc for Integer`. Validate exact seconds (including a non-minute-aligned imported epoch), past/due/future times, replacement job IDs, superseded jobs sending nothing, and enqueue failure retaining previous state.
- Rails 8.1 makes `TimeWithZone#to_time` retain the actual zone. Across the fall DST change, `to_time + 86_400` now displays **08:00 −05:00**, rather than the documented old **09:00 −04:00**, for the same instant. This occurs with 7.0 defaults too. If preserving the documented fixed-offset preview, convert explicitly with `reminder.to_time.getlocal(reminder.utc_offset) + 86_400`; **works on 7.0**. Alternatively adopt the actual-zone display deliberately and update the contract/test, not the scheduled epoch. `1.day` is not a substitute for 86,400 elapsed seconds across DST.

**Validation:** both spring and fall transitions, asserting instant, offset, displayed time, and exactly 86,400 elapsed seconds. Do not rely only on UTC fixtures. Existing reminder tests contain a fall-transition expectation but currently stop at scheduling failure. Sources: [7.2 Active Job removals](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 TimeWithZone#to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

### R10. Preserve UTC-day digests and make job payloads rollback-safe

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb).

**Day change:** Rails 7.2 preserves the serialized `TimeWithZone` zone. Reservation keys are UTC dates, but the mailer calls `requested_at.to_date` and `all_day`. For 2026-10-05 03:30 UTC / 2026-10-04 23:30 New York, baseline mail covered **October 5**, target **October 4**. Normalize **inside the consumer** to UTC before both date and range calculations. Producer normalization alone does not fix already queued local-zone jobs. **Consumer UTC normalization works on 7.0**, and also makes execution independent of an accidentally non-UTC worker.

**Decimal change:** 7.1 introduces an opt-in BigDecimal serializer; 7.2 makes it mandatory for BigDecimal arguments; 8.0 removes the switch. Old Sidekiq JSON payloads carry a string, newer ones a typed serializer hash. The existing `BigDecimal(params[:completion])` consumer accepts the tested string and BigDecimal, so it need not be rewritten merely to accept the newer type. However, **7.0 workers cannot deserialize newly typed payloads at all**.

**Recommendation:** before changing Rails, send `reading_completion.to_s("F")` from the producer and keep the existing tolerant consumer. **Works on 7.0** and retains decimal precision. Deploy UTC normalization to every old/new consumer before mixing traffic. Do not disable mandatory serializers through removed settings on 8.1. If typed jobs have already been queued, keep a capable worker fleet to drain/retry them or perform an explicit reviewed payload conversion; rolling all workers back to 7.0 is unsafe.

**Validation:** actual JSON round trips, not only Active Job's test adapter. Test old producer→new worker and new producer→rollback worker with 0.6667, zero, and a non-UTC midnight case; assert reservation key, included/excluded note dates, subject, and displayed percent. The current digest test catches the day change, but its in-memory adapter masks legacy JSON string conversion and cannot establish mixed-worker compatibility.

Sources: [7.1 serializer rollout guidance](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 zone/serializer changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb). Both directions were probed with saved payloads; full Sidekiq worker executions remain proposed.

### R11. Keep exception tests meaningful

**Affected:** [test environment](file:///home/user/workspace/repo/config/environments/test.rb), integration assertions expecting `RecordNotFound`.

Rails 7.2 removes boolean `show_exceptions`. Set **`:none` on Rails 7.1+** to preserve exception propagation. **Not an equivalent preparatory setting on 7.0**, where a truthy symbol does not mean “never render.” Keep `false` until the 7.1 hop. Do not use `:rescuable` merely to make tests quieter; update/add separate HTTP error-response tests when checking production 404s. Test queue adapter is explicitly `:test`, so the 7.2 change making all tests respect that configuration needs no adapter migration here. Source: [upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html).

### R12. Control newly resolved JSON compatibility

**Affected:** [Gemfile/lock](file:///home/user/workspace/repo/Gemfile), JSON tags, sessions and Active Support JSON decoding.

The executed fresh resolution selected json 3.1.0, whose `parse` signature rejects Rails 8.1.0's second positional options hash. This was an actual target failure, not a predicted conflict. For the exact requested Rails version, **constrain json below 3**, retain the tested resolved lock, and verify lock installation across deployment platforms. This constraint is satisfiable on Ruby 3.3.6/current Rails, but a new baseline resolution with the constraint was not tested; keep that separate from the original passing baseline. Alternatively choose a later Rails patch only after verifying it fixes this API interaction; no such patch is asserted here.

Validation: `ActiveSupport::JSON.decode`, sign-in/session round trip, JSON text tags read/write, and complete tests. Source: [Rails 8.1.0 decoding call](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb); resolved json sources and failure backtrace are attributable through the retained lock/log.

## 3. Optional default adoption and related conditional changes

These are not all prerequisites for running Rails 8.1 with `load_defaults 7.0`.

| Setting / affected application | Applicability and recommendation | Current-version preparation and discriminating validation |
|---|---|---|
| **7.1 readonly assignment raising**; Notebook `attr_readonly :slug`, notebook settings controller/form | The form resubmits the unchanged slug and the controller permits it. New enforcement raises even when assigning the same value. Remove `:slug` from permitted updates and remove its redundant hidden input before enabling the default. Keep `attr_readonly`. | Works on 7.0. Assert normal name/heading edit with unchanged submitted slug succeeds, a forged slug cannot change storage, and generated slug on creation still works. Target probe confirmed same-value assignment raises. |
| **7.1 no implicit column coder**; Notebook preferences | Explicit YAML coder as R3; optional-default gate, not an unconditional target failure with 7.0 defaults. | Make the keyword change at 7.1, not by blindly backporting JSON keyword syntax to 7.0. Check legacy YAML bytes in both directions. |
| **7.2 PostgreSQL date decoding**; Notebook#daily_note_counts | With new defaults, `select_rows` returns a Date, and `Date.iso8601(day)` raises. Prefer normalizing the documented date/string input with `day.to_date`, or deliberately keep decoding off until that change is ready. | `day.to_date` works for both Rails date strings and Dates on 7.0+. Validate counts for unequal groups around UTC midnight, including a user in another zone. Probe confirmed failure with decoding on and success with retained 7.0 defaults. |
| **7.1 HTML5 sanitizer**; Action Text/imported bodies | Separate from R6's mandatory nil fix. Compare stored malformed HTML and attachment rendering before enabling. Do not overwrite allowlists with only the additions. | Sanitizer selection is a newer-framework configuration. Cross-version safe allowlist construction can be prepared on 7.0. Browser/editor tests remain necessary; HTML parsing assertions are not editor round-trip tests. |
| **7.1 invalid cache expiry raising** | R8 must be fixed even before turning this on, because retained-default behavior changes to dropping the bad expiry. Enable raising after the expiry path is safe. | R8's rendering/TTL change works on 7.0; the new flag itself is not needed there. Test cold expired and warmed crossing-deadline cases. |
| **8.0 strict HTTP freshness**; ExportDownloadsController#show | Current `stale?` gets both ETag and Last-Modified. With `strict_freshness=true`, If-None-Match takes precedence; previously both conditions had to match. Adopt RFC behavior intentionally, not by changing authorization. | No prep change required on 7.0. On the newer version, matching ETag + stale If-Modified-Since must change 200→304 when enabled; mismatching ETag + future date remains 200. For expired/foreign exports, neither combination may bypass redirect/404. Existing tests send matching validators and miss the discriminating combination. |
| **7.1 message serializer/metadata and cache format** | Keep legacy writer formats while 7.0 readers/rollback are possible; see rollout section. Cookies are already JSON and digest/key-generator defaults are already SHA256 through load_defaults 7.0, so do not blindly apply the old 6.1→7.0 rotation recipe. | New format controls are introduced on newer Rails, not required 7.0 preparatory settings. Test actual session cookie, blob signed URL, Action Text attachment SGID, and disk URL in both directions, including purpose/expiry. |
| **7.2 YJIT / 8.1 production-only YJIT**, schema dump ordering, 8.1 JSON escaping/finder-order defaults | Ruby 3.3.6 can support YJIT; benchmark separately. Alphabetical schema column dumping is formatting, not a database migration. No implemented JSON endpoint or inline application JSON consumer was found; no blocking use of missing finder-order columns was identified. | Do not adopt generated CI/containers, browser blocking, authentication scaffolding, Solid Queue/Cache/Cable, Propshaft, or a changed Puma thread count merely because new apps generate them. Keep PostgreSQL/Sidekiq/Sprockets ownership unchanged. |

Sources: [8.1 versioned default definitions](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), [configuration guide](https://guides.rubyonrails.org/v8.1.0/configuring.html), [readonly implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/readonly_attributes.rb), [HTTP freshness implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb).

## 4. Queues, stored data, mixed-version rollout, and rollback

### Active Job transaction timing: do not infer behavior from the 7.2 headline

[Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb) and [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb) deliberately enqueue under row locks so enqueue failure rolls back state. Their workers re-lock before changing state. Deferring enqueue until after commit changes that failure contract: a failed push can leave a citation pending or a reminder ID stored with no queued job.

Rails 7.2 introduces adapter-dependent deferral (`:never`/`:default`/`:always`); Rails 8.1 removes those symbols and the old global config and uses a **boolean class attribute, default false**. The target application probe found `ApplicationJob.enqueue_after_transaction_commit == false`. Thus this is **not automatically enabled by Rails 8.1 or by its defaults**. Preserve immediate enqueue during the compatibility migration. If using a 7.2 deferral setting, use its supported `:never` there and translate to `false` for 8.0/8.1; neither new API belongs in an unguarded 7.0 prep release. Avoid importing the 7.2 symbol into 8.1 (it is not a valid false value).

If deferral is desired later, redesign durable enqueue-failure recovery before enabling it. Validate with a real isolated Sidekiq adapter and two database connections: refused enqueue must leave prior state intact; job picked before request commit must wait/reload correctly; rolled-back work must have the intended queue behavior. Existing test adapter/transactional fixtures and a stubbed class method do not prove that contract. The native ExportJob is not governed by Active Job's deferral setting.

Sources: [7.2 enqueuing](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb), [8.1 enqueuing](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb), [8.1 deferral](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb).

### Sidekiq is a separate decision, not a required Rack upgrade

Rails 8.1's built-in Sidekiq adapter still exists, but warns that it will be removed in 8.2 and recommends **Sidekiq >=7.3.3** for the gem-owned adapter. The least-changing 8.1 experiment retained 6.5.12. Resolution and Rails tests are **not** proof that production workers, middleware, shutdown/retry handling, and operational support are ready.

If upgrading Sidekiq as a separate step:

- [Notebook#request_export](file:///home/user/workspace/repo/app/models/notebook.rb) currently sends `{ format: "markdown" }`; Sidekiq 7 strict JSON arguments reject symbol keys. Change to **`{ "format" => "markdown" }`** first; this works on 6.5/7.0 Rails and does not change existing stored JSON jobs. Keep ExportJob accepting its current string keys. Test strict mode on 6.5 before the hop.
- [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb) expects the boolean result of redis-rb 4's single-member `sadd`. Sidekiq 7 uses redis-client, whose SADD command result is an integer; **0 is truthy in Ruby**. The same `if` can admit duplicate requests. Choose a documented compatible boolean API or explicit command/count comparison for the chosen client. Do not blindly use `.positive?` on today's boolean return or assume adding/updating the standalone redis gem controls `Sidekiq.redis`. Verify first/duplicate/concurrent requests and removal on push failure, retaining the current Redis key/TTL across deployment.
- Audit `rescue Redis::BaseError` in notebook export creation and test expectations for `Redis::CannotConnectError` against the new client's error classes. A missed rescue can strand an export row. This requires chosen-client validation; no Sidekiq 7 variant was run.
- Redis server >=6.2 is required by Sidekiq 7. Local experiment Redis was 7.0.15; actual deployment Redis version is unknown.

Source: [Rails 8.1 adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb), [versioned Sidekiq 7 upgrade guide](https://github.com/sidekiq/sidekiq/blob/v7.3.3/docs/7.0-Upgrade.md).

### Stored records and files

- Preserve schema/migration compatibility versions; there is no demonstrated need for a wholesale schema migration. Run existing migrations and schema-load separately on disposable copies at each hop. Do not confuse alphabetical Rails 8.1 schema dumps with physical column changes.
- Keep JSON tags, YAML preferences, DOI primary keys, enum integers, reminder epochs, reminder job IDs, and serialized worker class names stable.
- Existing Action Text body HTML/attachment SGIDs, Active Storage metadata and blobs, and generated Markdown files must survive rollback. No variants/image processor is installed; the app's blob partial serves originals. Do not add image processing or regenerate files as part of framework compatibility.
- Inventory ordinary queue, scheduled, retry, and dead sets **before deployment**, including native ExportJob and Rails wrapper jobs for digests, reminders, citations, and framework storage work. Checking only an empty immediate queue is insufficient: reminders can be scheduled far into the future.
- New workers must execute legacy serialized jobs against existing IDs without changing ownership, reminder supersession, or retry counts. Validate how jobs serialized on the new version behave on the rollback version, including core scheduled/enqueued timestamps and wrapper class names; only the time/decimal argument matrix was executed here.
- Do not clear Redis to simplify rollout: it holds both durable queued work and two-day digest reservations. Avoid clearing retry/dead queues or recreating reminders with new IDs without a reconciliation plan.

### Cookies, signatures, and caches

Keep the production `secret_key_base`, salts, and cookie identity stable. The actual deployment secret source was not inspected. Rails 7.1 changes the **development/test** local secret filename from `tmp/development_secret.txt` to `tmp/local_secret.txt`; retain the same key when local sessions and stored attachment signatures must survive. Never print it. This is a 7.1 transition step, not a production key rotation.

With 7.1 defaults, message metadata serialization changes format; new-format messages cannot be read by <7.1 Rails. `json_allow_marshal` lets new readers accept old messages, **not the reverse**. Keep the old message serializer/metadata writer settings on upgraded nodes while 7.0 readers are present or rollback to 7.0 is required. Do not assume login cookies and Action Text/Storage signatures use identical serialization paths: exercise both. A data body may contain a long-lived SGID even after sessions have expired.

Production FileStore may be deployment-local or shared; that infrastructure detail is unknown. Retain cache format 7.0 while 7.0 consumers exist, or use deployment-specific cache namespaces/cold caches. Rails 7.0.8.7's cache loader recognizes its older prefixes, not the newer 7.1 format; new Rails' ability to read both formats does not make an old process a new-format reader. Cache misses are acceptable, database/job loss is not. Invalidate only disposable application fragment caches, never the Redis queues/reservation sets. Preserve download-time authorization regardless of any stale availability fragment.

Sources: [upgrade guide local secrets](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [8.1 message metadata documentation](https://guides.rubyonrails.org/v8.1.0/configuring.html#config-active-support-use-message-serializer-for-metadata), [7.0 cache reader](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/cache.rb).

## 5. Execution plan and acceptance gates

1. **Prepare on 7.0.8.7, preserving behavior.** Implement only current-compatible recommendations: explicit import rollback, correct DOI access, integer annotation indexing, positional enum declaration, explicit highlight delegation, singular notebook filter, unbound form, split routes, future-only/nonnegative availability caching, string joining, Time scheduling, explicit reminder offset decision, UTC digest consumption, decimal-string production, and provider configuration migration. Remove slug from updates before later default adoption. A cross-version allowlist fix can also land here. Keep the current tags declaration, retry symbol, and test boolean until 7.1. Optional Sidekiq preparations are separate.
2. **Record the baseline and data/payload fixtures.** Use masked/synthetic legacy database bytes, representative rich text and attachments, old cookies/signatures, and captured queue payload structures. Add/extend contract tests, particularly ones currently masked by earlier failures. Test the old-new/new-old matrix before exposing mixed workers to live work.
3. **Walk the framework minors:** supported 7.0 patch checkpoint → 7.1 patch → 7.2 patch → 8.0 patch → exact requested 8.1.0, following upstream's incremental advice. Choose intermediate patch numbers explicitly in implementation and retain each lock. On 7.1 switch serialization keywords, retry name, and exception mode. Keep `load_defaults 7.0` and format/queue semantics stable. Resolve/install conservatively; review all transitive changes, including the JSON cap for the exact target. Review `app:update` interactively without accepting unrelated new-app defaults wholesale.
4. **At each hop:** boot and `zeitwerk:check`; run existing tests; run application-specific probes above; validate production-mode boot/assets and actual web/worker enqueue/perform/retry paths in isolated infrastructure; capture deprecations before their removals. Keep the concurrent-ruby pin until the legacy Rails boot no longer needs its compatibility protection. Do not call a failing suite ready.
5. **Browser and assets gate:** precompile Sprockets/importmap assets. The layout still loads vendored Trix 1.3.5 while new Action Text brings action_text-trix 2.x assets. Do not load both editors. Either explicitly validate the retained editor/integration or plan a single-editor update using the target assets and review JS/CSS/importmap changes together. Exercise create/edit/save/reopen of links and attachments, rejected oversized attachments, imported collapsible content, and Turbo navigation. No system test cases exist beyond the generated base; `test:system` alone would not establish these workflows. Known loss of details/summary through old Trix is already documented; don't misattribute it to this upgrade or silently promise preservation.
6. **Deployment gate:** choose a rollback floor and worker-first sequence proven by payload tests. Briefly pause producers if needed; quiet and drain current work, inspect scheduled/retry/dead work, and only then allow new writers. Keep consumer UTC normalization and decimal-string producers in the rollback build. Validate citation pending state, reminder IDs, digest reservations, and export progress through a deliberately refused queue push. Do not enable after-commit deferral casually. A real deployment or changes to its queues require separate authorization.
7. **Default adoption after compatibility is stable:** enable settings one at a time, separately from gem upgrades, with the table's discriminating tests. Keep old message/cache writer formats until the old-reader/rollback window closes. Only after all deliberate defaults are accepted change `load_defaults`; test the exact full effective configuration then.

## 6. Remaining questions and limitations

- Actual production Ruby/Redis/PostgreSQL versions, worker topology, shared cache mount, stable secret source, and outstanding job/data distributions were not inspected. Local configuration is not evidence of deployed configuration.
- No production deployment, browser session, full target production boot, asset precompile, real Sidekiq worker execution, full `load_defaults 8.1` run, or intermediate-version app suite was performed. The proposed gates remain required even if the obvious target failures are fixed.
- Existing tests have useful authorization and boundary coverage, but provide no durable cross-version queue/signature/cache-format assurance and no implemented browser system scenarios. Test adapter execution differs from Redis JSON serialization and real transaction timing.
- Rails 8.1 also removes semicolon query separators and leading-bracket parameter normalization. Generated forms here do not use them; externally saved/bookmarked URLs or clients were not inventoried. Review access patterns if those clients exist rather than modifying normal forms speculatively.
- Baseline application's direct uploads/blob URLs are not private-reader-authorized and production mail delivery is not configured. These are pre-existing documented deployment limitations, not newly discovered Rails regressions; this upgrade should neither claim to fix them nor expand their scope.

**Delivery state:** assessment and retained evidence only. No upgrade was implemented in the working application, and nothing was committed, pushed, or deployed.
