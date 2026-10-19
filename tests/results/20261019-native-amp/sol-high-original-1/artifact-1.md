# Rails 7.0.8.7 → 8.1.0: Margin Notes upgrade assessment

## Recommendation

Do not deploy this as a Gemfile-only upgrade. First ship a Rails-7.0-compatible preparation release, then advance through 7.1, 7.2, 8.0, and 8.1 with `config.load_defaults 7.0` retained. Review new defaults separately. The two highest-risk issues are **partially committed failed CSV imports** and **job payloads that Rails 7.0 workers cannot deserialize**. Neither is solved by getting the existing suite green.

This is an assessment, not an implemented upgrade. No tracked application files were changed. All execution used disposable, fixture-based databases, a separate Redis server, and fresh local storage/cache directories. Only evaluation artifacts and a repository-local ignore rule were added.

Assessment source: [application snapshot](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7). Target framework source is **v8.1.0**, not Rails main or the latest 8.1 patch. Historical changes were checked at v7.1.0, v7.2.0 and v8.0.0. The live `/v8.1/` guide currently identifies itself as 8.1.4, so exact-tag sources were used for conclusions about 8.1.0.

### Evidence labels

- **Executed**: application or framework behavior exercised in the isolated variants described below.
- **Source**: repository usage traced to exact-version upstream implementation/release guidance, not a production observation.
- **Proposed**: validation still needed before deployment. No production data, live provider, production secret, or production deployment was inspected.

## Application and dependency inventory

- Ruby **3.3.6**, Bundler **2.5.22**, Rails **7.0.8.7**, framework defaults **7.0**. Ruby already satisfies Rails 8.1's Ruby ≥3.2 requirement; no Ruby upgrade is required for this task.
- PostgreSQL; `pg 1.6.0`. The experiment used PostgreSQL 15.19. The server version in any real deployment remains unknown.
- Action Text bodies; Active Storage Disk blobs and Markdown export files. The blob partial serves originals; no image processor is installed and no variant migration is needed for that path.
- `notes.tags`: JSON in a text column; `notes.settings`: native jsonb; `notebooks.preferences`: YAML in a text column. These are different storage contracts.
- Active Job on **Sidekiq 6.5.12 / redis-rb 4.8.1**, plus native `ExportJob`. Redis also holds daily digest reservations, not the Rails fragment cache.
- Sprockets, importmap, Turbo and Stimulus; a deliberately vendored **Trix 1.3.5** classic script overrides the bundled editor. `@rails/actiontext` is an importmap side-effect import.
- Actual mailers deliver reminders/digests synchronously within jobs. The app's authentication is `has_secure_password` plus cookie sessions, not the new Rails authentication generator.

**Executed resolution:** Rails 8.1.0 resolves alongside the existing Sidekiq, Redis, Puma 5.6.9, Pagy 8.6.3, Faraday 1.10.4 and Sprockets dependencies. The resolver selected **Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1**. Rails 8.1.0 does not force Rack 3, a Sidekiq upgrade, Solid Queue, Solid Cache, Solid Cable, Propshaft, or a replacement authentication system. Do not mix those migrations into this upgrade.

However, a new transitive dependency resolution selected **JSON 3.1.0**, which is incompatible with this exact Rails patch. See R10. Both resolved lockfiles are retained.

## Required application changes

These apply even while retaining Rails 7.0 defaults, except where explicitly marked conditional.

### R1. Restore boot without losing the Action Text allowlist

**Affected:** [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), rich body rendering, existing `<details>/<summary>` excerpts and attachments.

**Source:** From Rails 7.1, `ActionText::ContentHelper.allowed_tags` and `allowed_attributes` are nil unless the application overrides them; effective defaults are assembled at render time. The current `allowed_tags += ...` therefore calls `nil + ...`. See [7.1 Action Text change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md) and [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).

**Recommendation:** Explicitly extend the effective default tags, including the Action Text attachment tag, `figure`, and `figcaption`, then add `details` and `summary`. Do not replace the list with just those two tags, use an empty-list fallback, or disable sanitization. Leave the default attributes intact. The experiment used the existing non-nil list when available, otherwise the sanitizer's safe tags plus Action Text attachment tags. This is compatible with 7.0 by source; the fallback was executed on 8.1.

**Executed:** Unchanged target boot fails in this initializer with `NoMethodError: undefined method '+' for nil`. A compatibility-only allowlist patch permits boot. **Proposed:** On both versions, render old stored excerpts and an embedded blob; verify the structure and attachment survive while script, event attributes, and `javascript:` URLs are removed. Render-only validation must be separate from editing: Trix 1.3.5 already flattens unsupported details on save, a pre-existing limitation rather than a new Rails regression. No bulk body rewrite is recommended.

### R2. Update Note's enum, serializer, and store-accessor alias without changing data

**Affected:** [Note declarations](file:///home/user/workspace/repo/app/models/note.rb#L10-L17), the note form's status/highlight/tags fields and their persisted representations.

**Source:** Keyword-style enums are removed in Rails 8.0; positional serializer coder arguments and aliases to non-column attributes are removed in 7.2. `color` is a generated `store_accessor`, not a database column. See [7.2 removals](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md), [8.0 removals](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_0_release_notes.md), and [alias generation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb).

**Recommendation:**

- `enum :status, { draft: 0, ready: 1 }, prefix: true` preserves integer values, `status_ready` scope and prefixed predicates. This syntax already works on 7.0; Citation and Export use it locally.
- On the **7.1 hop**, use `serialize :tags, coder: JSON`, keeping existing JSON bytes and the `[]` database default. Do **not** apply that keyword-only change on 7.0.
- Replace `alias_attribute :highlight_color, :color` with explicit Ruby getter/setter aliases to `color`/`color=` (or forwarding methods). Both read and write access are needed. This works on 7.0; do not add a second persisted color attribute or change jsonb storage.

**Executed:** The sanitizer-only target suite errors all 46 tests at the old enum declaration. After the enum/serializer/alias patches the model loads. Crucially, a standalone `serialize :tags, coder: JSON` declaration on **7.0.8.7 silently serializes an array as YAML**; it is not a safe preparatory edit. The same declaration on 8.1 writes JSON.

**Proposed validation:** Read an existing raw JSON tag array with mixed-case/non-ASCII tags; edit tags/highlight/status, reload, and inspect both raw `tags` bytes and jsonb settings. Assert prefixed scopes still select correctly. The keyword coder trap can corrupt data while apparently succeeding, so do not rely on boot alone. If such a premature edit was ever deployed, inventory and repair affected rows using the actual prior format; do not assume all rows remain JSON.

### R3. Replace the removed application secrets API in both provider and tests

**Affected:** [Citation::Provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15), [secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18), [provider test boundary](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L40-L57) and its helper at lines 101–123.

**Source:** `Rails.application.secrets` is removed in 7.2. **Executed:** Target provider tests raise `NoMethodError` on that API.

**Recommendation:** Keep environment-supplied provider settings, but load them through a cached application configuration value, e.g. `config.x.citation_provider = config_for(:secrets).citation_provider`, and make the provider/tests use that value. This is a small 7.0-compatible preparation using existing `config_for`/`config.x` APIs. A later file rename to `citation_provider.yml` is optional; moving actual credentials into source is not. Preserve symbol-key access and string values such as user `00123` and a password containing colon/hash. Preserve production's unset-provider failure rather than falling back to development credentials.

**Proposed validation:** Adapt and run the existing fresh-process credential test, then exercise successful enrichment, HTTP 401, 404, malformed metadata, 503 and exhausted retries using the local fake. Boot **web and workers** with the same new config and test a missing production URL without any real outbound request. Queued citation jobs carry a Citation GlobalID, not provider credentials; no queue rewrite is required for this API change.

### R4. Replace removed form/routing forms without changing public URLs

**Affected:** [unbound search form](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12-L36), [notes/journal route](file:///home/user/workspace/repo/config/routes.rb#L17-L19).

- Rails 8.0 removes `form_with(model: nil, ...)`. Omit `model:`; keep URL, GET method, field names and search role. Omitting it works on 7.0. **Executed:** Target notes pages fail with “Passed nil to the :model argument”.
- Rails 8.1 removes one route declaration accepting multiple paths. Declare `/notes` and `/journal` separately, preserving `/notes` as the canonical `notes_path`. Both declarations work on 7.0. This target evaluation patch was applied to allow request exploration; the removal itself is source-based ([8.1 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md)).

**Proposed validation:** Exercise both URLs after sign-in, unauthorized redirects, filtered pagination and generated next/previous links; assert the search form has no object scope and no changed URL contract. Old bookmarks need no migration.

### R5. Join Markdown fragments explicitly

**Affected:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L29-L43), native `ExportJob`, downloadable Markdown.

**Source:** Rails 7.1 removes Active Support's non-numeric `Enumerable#sum` behavior. **Executed:** Baseline emits a deprecation but joins strings; target raises `TypeError: String can't be coerced into Integer`. Export tests reach the same failure.

**Recommendation:** Replace `fragments.sum` with `fragments.join`. It works on 7.0 and preserves ordering, newlines and bytes. **Proposed validation:** Generate a multi-note export including a blank body, confirm exact Markdown bytes and filename, download it, and cancel a running export. Existing queued/retry `ExportJob` payloads can execute the corrected code without payload changes. A retry restarts generation; inspect existing working exports before replaying jobs because this app has no explicit failed-export state and can leave unattached blobs on failure.

### R6. Make import failure roll back explicitly — highest data-integrity priority

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L44-L61), imports controller's failed-preview response and all imported notes/citations/rich text.

**Source:** Non-local `return` from a transaction commits in Rails 7.2 onward; retaining 7.0 defaults cannot restore the removed rollback behavior. Rails 7.1's new transaction default can expose it earlier. Returning `false` from a normal transaction block also does not request rollback.

**Executed:** A CSV whose first row is valid and second title is blank returns `false` on both versions. Database count deltas `[imports, notes, citations, rich_texts]` are **`[0,0,0,0]` on 7.0** versus **`[1,1,1,1]` on 8.1**. The latter request reports failure after persisting a partial batch. This is an actual changed case, not just a suspicious `return`.

**Recommendation:** Use `row.note.save!` within the transaction and rescue `ActiveRecord::RecordInvalid` **outside** the transaction, returning false and retaining the note validation errors. Alternatively, explicitly raise `ActiveRecord::Rollback` and base the method result on the transaction result; simply adding that raise while leaving the unconditional final `true` is incorrect.

**Current-version compatibility:** Executed the `save!`/outer rescue preparation on **both versions**: result false, zero count deltas, and `Title can't be blank` preserved.

**Proposed validation:** Through the import POST, bypass the preview and submit a valid first row with a new shared DOI, then an invalid later row; assert no Import, Note, Citation, rich-text or attachment association survives and the failed row is shown. Include three rows and a quoted multi-line field. Existing request tests check atomicity, but target annotation failures occur before their apply assertion, masking this more serious failure.

**Rollout/data:** Ship this fix on 7.0 first. Do not retry a failed target import blindly: duplicate valid rows can already exist. Inventory affected partial batches using application evidence before any repair; rollback of Rails does not undo data committed by 8.1. No automatic cleanup/deletion was performed.

### R7. Preserve CSV annotations and DOI receipts across key/API changes

**Affected:** [annotation construction](file:///home/user/workspace/repo/app/models/import.rb#L37-L41), [preview lookup](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L48), [receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69), DOI-primary-key `citations` table in schema.

**Source / executed:**

- Rails 8.0 makes `HashWithIndifferentAccess#stringify_keys` stringify **all** keys, including integer source lines. The view still indexes with integer `row.line`, so annotations disappear. The direct integer-key probe returns the annotation on 7.0 and nil on 8.1. Existing request assertions also fail.
- Rails 7.2 stops treating `read_attribute(:id)` (also used by `record[:id]`) as a custom primary-key accessor. A Citation's primary key is `doi`, and it has no `id` column. The probe returns the DOI on 7.0 and nil on 8.1; receipt DOI fields can therefore become blank.

**Recommendation:** Remove the unnecessary `stringify_keys` and index the original annotations hash by integer line. Use `citation&.doi` in receipts (`citation&.id` would also return the primary key). Both work on 7.0; the annotation correction was exercised on both versions.

**Proposed validation:** Preview distinct annotations at two actual CSV source lines, including a quoted multi-line row, and ensure the right text stays beside each row. Download the receipt for notes sharing a DOI and a note without one; assert nonblank DOI values and an empty field only for the uncited note. These are read-time representation changes, not migrations of saved annotations/DOIs. Regenerating a receipt after the fix restores it; the upgrade cannot repair CSVs already downloaded with blank values.

### R8. Correct reminder scheduling and citation retry APIs

**Affected:** [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L51-L72), [CitationEnrichmentJob retry policy](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L4-L9).

**Source:** Rails 7.1 deprecates numeric `scheduled_at` and 7.2 removes it. The `wait_until: reminder_epoch` integer reaches that attribute; use `Time.at(reminder_epoch).utc`. `:exponentially_longer` is deprecated in 7.1 and removed in 7.2; `:polynomially_longer` is the new name for the same fourth-power backoff, not a request to change scheduling mathematics.

**Executed:** Target reminder requests error `undefined method 'utc' for Integer`. Passing the corresponding Time schedules the exact expected epoch **on both versions**. Source confirms the retry symbol is resolved when a retry occurs, so a successful provider call would miss that failure.

**Recommendation/current compatibility:** Ship epoch-to-Time conversion on 7.0. Rename the retry symbol on the **7.1 hop**, not on 7.0, where the replacement symbol is unavailable. If retry-policy preparation must precede that hop, a calculating Proc supported by both versions must preserve `executions**4 + 2`, existing jitter, three total attempts and the final failure callback; do not substitute a fixed/exponential delay.

**Proposed validation:** Schedule at a non-round epoch, postpone across a DST boundary, run both old and replacement reminder jobs and assert only the current stored job ID sends. Force persistent 503s: three job attempts, at most six provider requests with Faraday's one retry, final persisted failure and no unintended Sidekiq retry. Check the delay ranges, not just attempts. Existing scheduled jobs retain their Sidekiq score, GlobalID and job ID; do not bulk re-enqueue them, which can invalidate the note's `reminder_job_id` guard.

### R9. Make digest day and argument types explicit; bridge the queue before rollout

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L27-L57), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L7), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L2-L10), Redis daily reservations and existing scheduled/retry/dead job payloads.

**Source:** Rails 7.2 preserves a TimeWithZone argument's serialized zone; 7.0 deserializes it in the worker job context's zone (UTC here). Rails 7.1 introduces a tagged BigDecimal serializer behind an opt-in; 7.2 makes it unconditional. These are not gated by keeping `load_defaults 7.0` on 8.1.

**Executed:** For **2026-10-05 03:30 UTC = October 4 23:30 Eastern**, baseline worker arguments become UTC plus decimal string `"0.6667"`; target receives Eastern time plus a BigDecimal. The target test's subject changes from October 5 to October 4, despite the reservation remaining October 5 UTC. Actual Redis queue inspection confirms the wire formats. A 7.0 worker **cannot deserialize** the target BigDecimal payload (`Serializer ...BigDecimalSerializer is not known`). A target worker reads the legacy payload successfully. Compatibility is one-way.

**Recommendation:** Preserve the documented **UTC digest day**. In the 7.0 preparation, normalize the mailer's request instant to UTC before `to_date` and `all_day`; send an explicit UTC `Time` from the producer and the completion as a decimal string (`to_s("F")`). The mailer already parses the completion with `BigDecimal`. Normalize the consumer too, because legacy queued jobs and older producers may still supply a TimeWithZone.

**Current-version compatibility:** Executed UTC normalization and the portable argument JSON round trip on both versions; the **8.1-produced UTC Time + decimal string payload is readable by 7.0**. This avoids the need for an application-specific replacement serializer. Do not disable BigDecimal serialization globally on 8.1: that legacy setting has been removed.

**Proposed validation:** Request at both sides of UTC/local midnight in a positive and a negative offset zone, with ready notes straddling UTC midnight and a nontrivial completion such as 2/3. Assert reservation key, mail subject/day, included/excluded notes, and rounded percent after a real Redis JSON round trip. Test old→new and new→prepared-old workers, not just same-version `perform_enqueued_jobs`. Test adapter serialization in this suite does not impose Sidekiq's JSON conversion.

**Rollout/rollback:** Deploy producer/consumer preparation everywhere before enabling new Rails producers; keep reservation key format and two-day TTL unchanged to avoid duplicate daily requests. If unbridged target payloads already exist, inventory the ready queue, scheduled set, retry set and dead set. Promote workers before producers or use version-isolated queues; do not let old workers consume new tagged payloads. Before rollback, drain/convert/quarantine incompatible work while retaining usable class names and IDs. Draining only ready jobs is insufficient; future reminder/retry payloads can outlive the release. Never flush Redis: it holds reservations and queued work, not just a discardable cache. No real worker mail delivery was executed here; queue inspection/deserialization and file/test mail are the evidence.

### R10. Constrain JSON when resolving the exact requested Rails patch

**Affected:** Gemfile/Gemfile.lock; Rails JSON decoding of `Note.tags`, jsonb settings and session/request JSON, not just the provider's explicit JSON parse.

**Executed/source:** Fresh resolution introduced JSON **3.1.0**. Its `JSON.parse(source, **options)` rejects the positional options hash in Rails 8.1.0's `ActiveSupport::JSON.decode` (`JSON.parse(json, options)`). After core compatibility patches, this caused pervasive `ArgumentError (given 2, expected 1)` errors. See retained `target-create-note.log`, the unconstrained lockfile and exact dependency source snapshots.

**Recommendation:** For the exact **8.1.0** target, constrain JSON to a tested 2.x release/range; `< 3` resolved **2.21.2** here and removed this error. Do not hide this failure by changing Rails framework code or attributing every 500 to the application's upgrade APIs. Evaluate a later Rails patch separately if the target can change.

**Current-version compatibility:** Baseline uses the Ruby default JSON **2.7.2**. The tested 8.1 resolution uses **2.21.2**. A 7.0 bundle with 2.21.2 was **not** executed; if adding this constraint in a preparatory release, validate the exact resulting lockfile there too. **Proposed validation:** Minimal JSON decode, signed-in requests with session round trips, existing tag reload/update, jsonb highlight edits and the full suite using the reviewed lockfile. Preserve the lockfile in deployment/rollback; re-resolving dependencies can reproduce the broken combination.

### R11. Preserve test exception semantics instead of masking failures

**Affected:** [test environment](file:///home/user/workspace/repo/config/environments/test.rb#L25-L37), authorization/error assertions across request tests.

**Source:** Boolean `action_dispatch.show_exceptions` is deprecated in 7.1 and unsupported from 7.2. Use `:none` for this app's previous `false` behavior. `:rescuable`/`:all` are not equivalent. This change is **not** compatible with 7.0's boolean contract: make it on the 7.1 hop.

**Executed:** The partly patched target renders failures/404s rather than satisfying `assert_raises`, so numerous suite failures are error-handling configuration differences, not evidence that ownership checks disappeared. Do not weaken the authorization assertions to make the suite pass. **Proposed validation:** Assert that the missing/foreign record exception escapes under `:none`; separately select `:rescuable` for any test that intentionally verifies production's HTTP 404 representation, restoring the setting afterward. Test already explicitly sets `active_job.queue_adapter = :test`, so Rails 7.2's consistent adapter selection does not itself require a queue-adapter change here.

## Behavior decisions and optional new-default adoption

Keep these out of the first framework-only deployment, except the unavoidable time conversion in D1.

### D1. Unavoidable TimeWithZone#to_time change: approve the DST representation

**Affected:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L45), reminder preview and postponement. Rails 8.1 always preserves the receiver's named timezone in `to_time`, rather than the old fixed UTC offset. This is **not** avoidable simply by retaining defaults 7.0.

**Executed:** Adding 86,400 seconds to October 31 09:00 Eastern gives the **same instant**, epoch **1793538000**, in both variants, but the preview changes from **November 1 09:00 −04:00** to **November 1 08:00 −05:00**. This agrees with 24 elapsed hours later in the reader's actual zone; it is not a one-hour scheduling shift.

**Recommendation:** Preserve 24 elapsed hours, accept the corrected local preview, and update the specific display expectation/comment and architecture description during the upgrade. If fixed-offset presentation is genuinely required, explicitly construct a fixed-offset Time before adding seconds; that preparation works on 7.0 too. Do not switch to `1.day` wall-clock arithmetic by accident. **Proposed validation:** Spring and autumn transitions, a no-DST zone, both epoch and rendered offset; retain cancellation/job-ID checks. Stored epochs and scheduled scores need no conversion. Rollback changes presentation, not the already scheduled instant.

### D2. Rails 7.1 defaults: explicit YAML and readonly slug handling

**Affected:** [Notebook declarations](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19), [permitted slug](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L41), [hidden slug field](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L14).

- With 7.0 defaults, bare `serialize :preferences` still has a YAML default on 8.1. When enabling 7.1 defaults, the default coder becomes nil: declare **`serialize :preferences, coder: YAML`**, preserving existing YAML. Do this on 7.1+, alongside the JSON keyword change, not as a generic “all serializers to JSON” cleanup. Existing notebook fixtures have no preferences and cannot establish real stored-data compatibility. **Proposed:** Inventory actual YAML types using a sanitized backup, read/update a pre-upgrade export heading and confirm raw YAML stays readable after rollback; do not enable unsafe YAML loading to work around unknown classes. No blanket rewrite is required.
- `raise_on_assign_to_attr_readonly = true` raises even when assigning the **same** slug. The ordinary settings form resubmits that field. **Executed** under the target strict flag: unchanged-value assignment raises `ActiveRecord::ReadonlyAttributeError`. Remove `:slug` from permitted settings input and remove its hidden field, retaining the displayed code and model's `attr_readonly`; this preparation works on 7.0. **Proposed:** Both unchanged and malicious changed slugs must leave the slug unchanged without breaking a legitimate name/heading update. Keep legacy pre-deploy forms safe by ignoring incoming slug. Alternatively retain the old flag temporarily, but do not call strict readonly defaults adopted until the form path is fixed.

### D3. Rails 7.2 defaults: typed PostgreSQL dates

**Affected:** [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L33-L40), activity report. With current defaults, the target adapter still has `decode_dates=false`; the raw `DATE()` query returns text. Enabling `postgresql_adapter_decode_dates` makes it return Date, so `Date.iso8601(day)` raises.

**Executed:** Text on baseline/target with existing configuration; the target decode flag gives `TypeError: no implicit conversion of Date into String` in the existing parse. **Recommendation:** Normalize with `day.to_date` (works on String and Date in both Rails versions), or explicitly handle the typed result. This is a 7.0-compatible preparation, not a reason to keep date decoding off indefinitely. **Proposed:** Multiple UTC dates around midnight with an owner in another zone, counts and descending order, tested once with each adapter setting in fresh connections. No database values or timestamp timezone types need migration.

### D4. Rails 7.1 defaults: expired export fragments and sanitization

**Affected:** [availability cache](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36), rich body rendering and pre-escaped plain annotations.

- `expires_in: export.expires_at - Time.current` becomes negative for an already expired export. With strict invalid-expiration handling introduced by 7.1 defaults it raises; **executed** with the target flag. Default tests disable caching and the existing cache test does not establish safety with this strict flag. Recommend not caching an expired indicator and bounding any relative TTL at zero for the boundary race. This can be prepared on 7.0. **Proposed:** With caching actually enabled, cold and warm reads just before, exactly at, and after expiry; an expired cold read must render “Expired”, not 500. Keep ownership/expiry checks before `stale?` in downloads; cache content must never authorize access.
- 7.1 defaults choose HTML5 sanitizers on supported platforms; this Linux/Nokogiri combination supports them. This is distinct from R1's nil accessor API. Recommend adopt only after a stored-body render/edit corpus comparison: malformed nesting/tables, links, attachments, details, unsafe markup, literal `<b>` and ampersands in plain annotations, and plain-text Markdown export. Render-time differences do not justify rewriting all stored HTML. Keep vendor flags old until comparison is approved. These flags are a 7.1+ configuration step, not 7.0 API calls.

### D5. Rails 8.0/8.1 defaults and generator choices

**Affected:** [download validators](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L15), [application defaults](file:///home/user/workspace/repo/config/application.rb#L10-L24).

- `strict_freshness=true` gives `If-None-Match` precedence over `If-Modified-Since`. Existing tests use either one validator or consistent validators, so do not establish the changed case. **Source**: [request freshness implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb). **Proposed:** A matching ETag with an older conflicting date yields 200 in legacy mode vs 304 in strict mode; after expiry or for another owner it must still never bypass the earlier access check. Adopt RFC semantics as an independent defaults decision; no persisted-file rewrite.
- 8.1 JSON escape defaults affect JSON rendering, not this app's server-rendered annotation HTML; Jbuilder has no actual app views. No JSON API conversion is called for. Keep HTML escaping and Action Text sanitation independent of these defaults.
- New YJIT, regexp-timeout, template tracking and hidden-field rendering defaults warrant the normal asset/render/performance checks when adopted, but no application-specific incompatible usage was found for them. New path-relative redirect protection has no identified conflicting local redirect: existing destinations are route helpers or `/notes`.
- Do not run authentication/asset/queue installers over the app. Keep Sprockets and the chosen Trix script until a separately validated editor update. The target bundle includes **action_text-trix 2.1.19**, but the current layout still deliberately loads **1.3.5**. Installing the new Rails gem does not establish that the browser runs a new Trix. If adopting it, load exactly one editor version, align JS/CSS and Action Text importmap assets, and exercise loading/saving old linked bodies and uploads. No browser tests currently exist under `test/system`; the Selenium base alone is not coverage. Browser/production asset-build validation is still proposed.

## Mixed-version state, queue, and rollback plan

### Keep enqueue timing an explicit decision

[Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L67) and [Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb#L14-L23) enqueue under row locks; their current enqueue failure is synchronous and rolls back associated changes. Native exports commit their row before enqueue and delete it if Redis refuses.

**Executed:** On this target with 7.0 defaults, `ApplicationJob`, `NoteReminderJob` and `CitationEnrichmentJob` all have `enqueue_after_transaction_commit=false`. Do not assume the 7.2 release-note headline automatically changes this configured 8.1 application. On the 7.2 hop, adopting its defaults sets the adapter-driven `:default` policy; it must be evaluated independently. 8.1 uses booleans and no longer accepts `:never/:always/:default` or the old application config switch.

**Recommendation:** Preserve current immediate enqueue semantics during this upgrade. If a 7.2 defaults change requires a compatibility setting, use its supported `:never` at that hop, then `false` on 8.x; neither is a new setting to add on 7.0. Any later adoption of after-commit enqueue needs a failure contract redesign: Redis rejection occurs after the record is committed and cannot simply roll it back. The worker's row-lock guard does not make that enqueue failure atomic. **Proposed:** A real adapter plus a separate DB connection/worker, non-transactional request boundary, Redis refusal and transaction rollback tests. Ordinary test transactions and an in-memory adapter do not establish the timing behavior.

### Preserve durable and signed state

1. **Database:** Keep existing columns, enum values, JSON tags, jsonb settings and YAML preferences. Review `app:update` diffs and framework migrations, not a wholesale generated schema. Existing Active Storage schema already has service names and variant records. Existing migration classes/schema retain `[7.0]`; upgrading Rails does not require rewriting their compatibility version. Rails 8.1 alphabetizes schema dumps; review that noise separately. Only schema loads, not full migration-history replay, were executed here.
2. **Cookies/signatures:** Keep the same production `secret_key_base`/credential material. Existing 7.0 defaults already use JSON cookies and SHA256 key derivation, so the pre-7.0 SHA1 cookie migration is not automatically applicable. On dev/test, 7.1 renames `tmp/development_secret.txt` to `tmp/local_secret.txt`: copy the existing key to the new location before first boot and retain the old file for a 7.0 rollback. A key copy is compatible with current Rails; changing keys is not an upgrade prerequisite. These automatic-key paths were not exercised because probes supplied a disposable explicit key.
3. **Message serializer/metadata defaults:** 7.1 defaults change general message serialization and metadata encoding. These can affect Active Storage signed URLs/Action Text attachment SGIDs **stored inside rich text**, not only expiring browser cookies. New readers have legacy fallback, but old readers are not thereby proven to understand new writes. Keep old writer formats while 7.0 instances or a 7.0 rollback remain possible. Proposed: Generate an old attachment SGID/blob URL and session, render/resolve on the new version; then generate on the target and resolve on the rollback version, using the exact config and stable test key. Include old stored rich text, not just freshly signed blobs. After new signatures are persisted, rollback may require a prepared compatible reader or explicit legacy serializer/metadata writer configuration; a cold cache cannot repair signed stored content. Do not rotate keys or bulk re-sign stored bodies just to get tests green.
4. **Cache:** Production's inherited cache is file-based unless deployment overrides it; development uses memory/null. Keep cache format **7.0** during rolling framework upgrades. A shared FileStore must not receive new 7.1-format writes until old readers/rollback are retired, or use a separate version namespace/store. Only cache data may be discarded with an approved cache-only cleanup. Do not confuse this with Redis reservation/job data, and do not delete storage blobs to clear caches.
5. **Files:** Preserve Disk blobs, attachment IDs/keys, notebook slugs, export files and expiry timestamps. No conversion to variants/cloud storage is required. Rejected/abandoned uploads and expired exports are already unpurged; that separate cleanup policy is not part of this upgrade. Browser direct uploads and download expiry/conditional responses need explicit validation.
6. **Queues:** Retain Active Job/native class names, queue names, GlobalIDs, note reminder job IDs and export IDs. Bridge digest arguments as R9 before mixing versions; inventory scheduled/retry/dead sets before rollback. Sidekiq **6.5** really initialized and enqueued on 8.1 in this evaluation; the built-in adapter is deprecated, not removed, in 8.1. A Sidekiq ≥7.3.3 migration is optional for this requested target and required before Rails 8.2, not something forced by Rails 8.1.

If separately adopting Sidekiq 7+: change `ExportJob.perform_async`'s `{ format: "markdown" }` to a string-keyed hash first (works on current Sidekiq; the job already reads `"format"`). Use redis-rb's boolean `sadd?`, or explicitly compare the integer count, rather than depending on `sadd` returning boolean: in Ruby, zero is truthy. `sadd?` is available on current redis-rb 4.8.1. Re-test first vs duplicate reservations and enqueue-failure cleanup. Verify adapter wrapper compatibility, scheduled/retry processing and rollback in a dedicated experiment. Upstream Sidekiq 7.3.3 includes a wrapper alias for older queued Active Job work, but that alone does not establish every direction of a mixed-version rollout. No Sidekiq 7 variant was run.

## Suggested delivery sequence and acceptance gates

1. **Preparation on 7.0.8.7:** Fix the nil-tolerant Action Text allowlist extension, import rollback, explicit string joining, note enum/aliases, integer annotation lookup, DOI receipt accessor, unbound form and split routes, epoch-to-Time scheduling; replace provider secrets API; bridge digest UTC/string arguments. Remove accepted/resubmitted slug before enabling strict readonly. Preserve existing stored formats. Verify the preparatory release itself on 7.0, including real JSON job transport and historical data. Most individual probes above establish compatibility, but the entire combined preparation release has not been implemented or tested.
2. **7.1 hop:** Use a reviewed maintained patch on that line; update serializer declarations to keyword coders (JSON tags, explicit YAML preferences), `show_exceptions=:none`, retry symbol. Review `app:update`, deprecations, and dependency resolution; keep load defaults 7.0 and preserve signature/cache formats. Run the same validation matrix.
3. **7.2 hop:** Ensure removed APIs/transaction behavior are covered. Confirm queued-work compatibility and effective enqueue-after-commit setting. Do not enable a new job format through a defaults bump accidentally. Keep real Sidekiq jobs/reservations isolated during rehearsals.
4. **8.0 hop:** Confirm enum/form changes, annotation key behavior, assets and notifications; retain old defaults. Re-test web and worker boot, authorization, all import/export/mail workflows.
5. **8.1.0 hop:** Apply reviewed dependency constraint/lockfile; confirm split routes and unavoidable named-zone Time behavior. Run `bundle check`, `zeitwerk:check`, the full suite, public request regressions, production asset precompile and actual browser flows. No blanket framework ecosystem migration. Intermediate Rails variants and the full production-like 8.1 deployment were not executed in this assessment.
6. **Default adoption after stable rollout:** Enable D2–D5 one at a time, close the old-version rollback window before new cache/signature writers, and retain a rollback to the *prepared* application release rather than pristine 7.0. Only then consider raising `load_defaults`. Refresh architecture/testing documentation when actual behavior changes.

Before production, confirm the intended deployment patch policy: this assessment deliberately evaluates exact 8.1.0, not a claim that its initial patch is the appropriate security-maintenance destination today.

## Executed evidence and reproduction record

Evidence directory: [review artifacts](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/).

| Variant/check | Result and limits | Retained evidence |
| --- | --- | --- |
| 7.0.8.7 baseline, original code, fixtures | **46 runs, 325 assertions, 0 failures, 0 errors**; non-browser suite only | `baseline-tests.log`, `baseline-rails-test.log`, `baseline.Gemfile.lock` |
| 8.1.0, only Gemfile upgraded | **Boot fails** at nil Action Text tags | `target-boot-unmodified.log`, `target-unconstrained.Gemfile.lock` |
| 8.1.0, sanitizer boot patch only | **46 runs, 0 assertions, 46 errors**, old enum prevents fixture/model loading | `target-tests-sanitizer-only.log` |
| 8.1.0, sanitizer + enum + JSON keyword coder + getter/setter aliases + split routes, JSON 3.1.0 | **46 runs, 44 assertions, 28 failures, 17 errors**; JSON decoding separately diagnosed | `target-tests-core-compatibility.log`, `target-create-note.log`, `dependency-sources/` |
| Same compatibility patch, JSON 2.21.2 | **46 runs, 161 assertions, 19 failures, 6 errors**; expected remaining application incompatibilities; **not** a completed upgrade or green suite | `target-tests-core-compatibility-json2.log`, `target.Gemfile.lock`, `target-evaluation.patch` |
| `zeitwerk:check` | Passes baseline and partly patched JSON-2 target; does not exercise requests/retries/data behavior | `baseline-zeitwerk.log`, `target-zeitwerk.log` |
| Focused behavior probes | Reproduced partial commit, annotation keys, custom PK, string sum, DST, serializer trap, digest types; verified selected compatible corrections | `*-probe.log`, `probe.rb`, `preparation-probe.rb` |
| Real Redis queue inspection/deserialization | Confirmed old→new and new→old digest payload behavior; **no background mail worker delivery** | `*-job-wire-probe.log`, `job-wire-probe.rb`, `digest-*.json`, `portable-digest-*.json` |
| New-default API probes | Strict readonly equality raises; date decode breaks old parse; negative strict TTL raises. Flags were exercised individually, **not a complete boot with 8.1 defaults** | `*-optional-probe.log`, `optional-defaults-probe.rb` |

### Commands, resolved dependencies and isolation

- Source copies were created with `git archive HEAD | tar -x -C <variant>` from the snapshot above. No data directories or secret keys were copied. Each copy's database configuration was replaced **before boot**.
- Actual Rails commands and timestamps are in **`commands.log`**. They used `run.sh`: pinned Ruby via `mise exec --`, explicit `BUNDLE_GEMFILE`, target-only `BUNDLE_PATH`, `RAILS_ENV=test`, `PARALLEL_WORKERS=1`, separate database URL, separate `REDIS_URL`, disposable signing key and loopback-only fake provider settings. The wrapper is retained as a reproduction recipe; its original scratch paths must be reconstructed after cleanup.
- Dependencies: `baseline.Gemfile[.lock]`, `target.Gemfile[.lock]`, `target-unconstrained.Gemfile.lock`, `resolve.log`, `resolve-json2.log`; probe outputs include runtime loaded-gem versions, and preparation outputs record JSON 2.7.2 vs 2.21.2. JSON 3.1 source and Rails 8.1.0 decoder are retained together. An initial invalid Bundler path/shared-gems option was corrected before installation; that setup attempt did not test the application.
- Databases: **`margin_notes_upgrade_baseline_88b1`** and **`margin_notes_upgrade_target_88b1`**, on the local PostgreSQL socket, fixture/schema-only. Schema loading used `bin/rails db:create db:schema:load` only under the isolated wrapper. No application/development/production database was queried or written.
- Queue/reservations: separate Redis **7.0.15** instance bound to **127.0.0.1:16384**, persistence disabled, service `rails-upgrade-redis-88b1`. It was not the development Redis instance. No external cache, storage service, provider or SMTP was contacted.
- Storage/cache/logs: new `storage`, `tmp/storage`, `tmp/cache`, `tmp/mails` and `log` under each disposable copy; Disk service roots were copy-local. Fixture mail remained on the test adapter.
- Configuration inputs: `baseline-config/`, `target-config/`, source snapshot and `target-evaluation.patch`; output/SQL logs: `baseline-rails-test.log`, `target-rails-test.log`. `manifest.txt` records toolchain/service versions. Probe inputs and outputs are retained, rather than just a pass/fail summary. Optional-default probe failures for setters missing on 7.0 mean those settings do not exist there, not an application regression.
- Reproduction: reconstruct fresh copies from the linked commit, apply the saved database/config isolation, install the saved locks in local bundle paths, then use the retained wrapper/probe commands. The target evaluation patch contains **only diagnostic compatibility changes**, not all recommendations. Do not apply it directly to a live application as a finished upgrade.

### Remaining questions and checks not run

- What databases, workers, queue backlog, real secret source, shared cache and storage paths exist in deployment? None is established by this sample's generated production config. Actual PostgreSQL support level and any deployment-specific Rack middleware need confirmation.
- Are stored preferences strictly simple hashes, and are there historical attachment SGIDs/bodies from other deployments? Fixtures do not answer that. Use a sanitized snapshot/corpus with signatures preserved for compatibility rehearsal.
- Is UTC still the desired digest contract and 24 elapsed hours still the postponement contract? This plan preserves both documented contracts; changing either should be explicit product work.
- Production email host/SMTP are not configured in this sample; this is pre-existing, not caused by the upgrade. No real emails were sent.
- Not executed: intermediate version suites, full combined preparation release, a fully repaired target suite, new-default boot, production asset build, browser direct upload/editor save, historical-data restore, two-way real cookie/attachment-signature verification, concurrent worker transaction timing, deployment, or rollback rehearsal. These remain release gates; passing baseline tests/target autoload checks is not a completeness claim.

## Versioned upstream references

- [Upgrade guide at v8.1.0](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md): incremental hops, separate default adoption, cache format rollout, local signing-key filename.
- [7.1 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_1_release_notes.md) and [7.1 component changelogs](https://github.com/rails/rails/tree/v7.1.0): sum, serialization, sanitizers, retry and job argument changes.
- [7.2 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md): removed secrets/positional coder/non-column aliases/custom id/boolean exception flags, non-local transaction returns and retry APIs.
- [7.2 Active Job changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md): zone preservation, mandatory BigDecimal serializer, numeric schedule removal.
- [8.0 Active Support changelog](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md): integer-key stringification; [8.0 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_0_release_notes.md): enum/form removals versus generated-app defaults.
- [8.1 release notes](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md): multi-path route removal, timezone behavior, adapter deprecation, schema sorting.
- [8.1 defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), [serializer implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [time serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb), [Action Pack gemspec](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec).
- [Sidekiq 7.3.3 adapter/wrapper alias](https://github.com/sidekiq/sidekiq/blob/v7.3.3/lib/active_job/queue_adapters/sidekiq_adapter.rb), relevant only to the optional separate Sidekiq migration.

Fetched versioned source excerpts/changelogs are retained under `upstream/` alongside the experiment record.

### Cleanup/delivery state

The separate Redis service was stopped, both named disposable PostgreSQL databases were dropped, and the scratch application copies/local gem installations were removed after retaining the evidence. `cleanup.log` confirms no named scratch databases remain and both tracked working/staged diffs are empty. The report and evidence are local, ignored review artifacts only; no application upgrade, commit, push, deployment, shared-resource write, or production-data cleanup was performed.
