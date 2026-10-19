# Margin Notes: Rails 7.0.8.7 → 8.1.0 assessment

## Recommendation

**Proceed as a staged compatibility upgrade, not a Gemfile-only change or an immediate `load_defaults 8.1` switch.** The exact target resolves with the existing Ruby 3.3.6, Sidekiq 6.5.12, redis-rb 4.8.1, Puma 5.6.9, Sprockets, and Rack 2.2.24. Neither Ruby nor a Rack/Sidekiq/asset-pipeline replacement is a prerequisite. Resolution is not runtime certification. The unchanged application fails to boot on 8.1.0 at its Action Text initializer.

The most important non-boot risks are **partially committed imports**, **different digest content days for new versus already-queued jobs**, and **new job serialization that a 7.0 rollback worker cannot read**. Keeping Rails 7.0 defaults initially avoids several further changes but does not avoid removed APIs or unconditional serialization changes.

No application, Gemfile, lockfile, schema, database, queue, cache, or stored upload in the working checkout was changed. Only ignored audit artifacts and a local Git exclude rule were written. No upgrade was committed, pushed, or deployed.

## Evidence and scope

- Read application models, controllers, jobs, mailers, rendering/configuration, migrations/schema, and existing tests. This is a small HTML/PostgreSQL application with Action Text, Disk Active Storage, native Sidekiq exports, and Active Job reminders/citations/digests. `config.load_defaults 7.0` is explicit.
- Compared tagged Rails source at 7.0.8.7, 7.1.0, 7.2.0, 8.0.0, and 8.1.0 where relevant. Intermediate `.0` versions identify introduction/removal points, not recommended deployment patch versions. Exact inspected source is retained under `sources/`; source conclusions below are not claims that the application was exercised.
- Executed dependency resolution/install, target framework probes, a legacy-reader probe, and one unchanged-target boot in a disposable `git archive HEAD` copy. Application services were fail-closed: `DATABASE_URL=postgresql://127.0.0.1:1/rails_audit_no_access`, `REDIS_URL=redis://127.0.0.1:1/15`. Cache/storage/logs were copy-local; test configuration uses null cache and copy-local `tmp/storage`. No production/development/test service was used, no worker ran, and no application suite/browser test ran.
- Snapshot: current repository HEAD at audit time (recorded in `EXPERIMENTS.md`). Findings below use current tracked files. No live deployment configuration, existing database rows, persistent blob HTML, or Redis payloads were inspected.

### Upstream references

- [Versioned 8.1 upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html): incremental minor upgrades, defaults adoption, local secret rename, alias behavior.
- [7.1 release notes](https://guides.rubyonrails.org/v8.1.0/7_1_release_notes.html): sum override removal, serialization/alias/id deprecations, secrets and exception configuration.
- [7.2 release notes](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html): removed legacy serializers/id/aliases/retry wait, transaction exits, enqueue timing.
- [8.0 release notes](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html): keyword enum removal.
- [8.1 release notes](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html): multiple route paths, time conversion, Sidekiq adapter deprecation.
- [8.1 defaults source](https://raw.githubusercontent.com/rails/rails/v8.1.0/railties/lib/rails/application/configuration.rb) is authoritative for defaults still selectable at the final target. For example, 7.2's historical enqueue default should not be inferred to remain the 8.1 behavior.

## A. Required compatibility work

Each validation below is **proposed**, unless explicitly marked executed. “Works on 7.0” means supported by inspected APIs; preparatory changes themselves have not been implemented or run through application tests.

### A1. Action Text initializer stops boot (7.1+)

**Affected:** `config/initializers/action_text.rb:3`; `Note#body`; `app/views/active_storage/blobs/_blob.html.erb`.

**Finding:** 7.0 eagerly initializes `ContentHelper.allowed_tags`; 7.1+ leaves it nil and computes effective defaults in `sanitizer_allowed_tags`. `allowed_tags += ...` calls `nil +` on 8.1 even with 7.0 defaults. **Executed:** unchanged-target runner failed here with `NoMethodError` (`boot-target.log`).

**Recommendation:** assign an explicit union of the existing override or sanitizer class's safe default tags, Action Text's attachment tag, `figure`, `figcaption`, and `details`/`summary`. Do not “fix” by assigning only the two custom tags: that would strip normal rich text and attachment structure. The fallback-to-safe-defaults expression can work on 7.0; the newer `sanitizer_allowed_tags` helper alone is not a 7.0-compatible preparation. Keep the current HTML4 vendor for the first upgrade; adopt HTML5 separately (C5).

**Discriminating validation:** boot and render existing text with links, inline formatting, `details/summary`, image and nonimage attachments, plus script/event-handler/javascript-URL attacks. Check both preserved structure and removed unsafe markup, not just boot. Existing rich-text request tests cover some of this, not existing signed attachment compatibility or browser saves. Render-time sanitizer changes need no blanket rewrite of stored HTML; editing and resaving can change it permanently.

### A2. Note's enum, serialized JSON, and non-column alias

**Affected:** `app/models/note.rb:10-14`; `NotesController#note_params`; note status scopes, highlight form, tags.

- **Enum:** keyword definition removed in 8.0. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. **Works on 7.0**; preserve numeric mapping and `status_ready` scope/predicate names. Citation and Export already use positional enum syntax.
- **Tags:** positional coder removed in 7.2. Use `serialize :tags, coder: JSON` **only after reaching 7.1**. **Not a safe 7.0 preparation:** 7.0 accepts arbitrary keywords, but selects its coder from the positional argument; merely adding `coder: JSON` does not select the JSON coder and can silently write YAML to a JSON-text column. Keep current syntax through the 7.0 preparatory release, then change in 7.1 before 7.2. Do not convert stored tags or change the text-column default `[]`.
- **Highlight:** `color` is a `store_accessor` into `settings` jsonb, not a database column. 7.2 removes `alias_attribute` for nonattributes. Replace with explicit getter and setter forwarding `highlight_color` to `color` (or aliases of both store accessor methods). **Works on 7.0.** Do not rename the jsonb key or treat `highlight_color` as a column.

**Discriminating validation:** read legacy raw tag JSON and persist/reload changed tags; inspect raw text remains JSON and can be read by a 7.0 reader. Include empty tags and non-ASCII/quoted values. Update highlight through the existing request form and confirm exactly `settings["color"]`, not a second key, changes. Confirm ready/draft filters and predicates keep their names and values. Existing note-edit tests are useful but do not validate cross-version raw encoding.

### A3. `/notes` and `/journal` route declaration (8.1)

**Affected:** `config/routes.rb` multi-path `get`.

**Finding:** 8.1 rejects more than one path. **Executed** exact declaration in `framework-probe-target.log`: `ArgumentError: Wrong number of arguments (expect 1, got 2)`.

**Recommendation:** two separate `get` routes to `notes#index`, retaining the canonical `notes_path` name without duplicate named helpers. **Works on 7.0.** Keep `/journal` as an alias, not an unrequested redirect.

**Validation:** load routes; request both URLs with notebook/status/search/pagination parameters; assert matching reader-scoped output and canonical pagination links. Existing list test already visits both URLs.

### A4. Citation provider settings disappear (7.2)

**Affected:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb` (default settings, fresh-process ENV test, settings substitution); related setup documentation and provider comments.

**Recommendation:** move provider-only configuration to `Rails.application.config.x.citation_provider`, populated directly from ENV with the current development/test defaults and production nil behavior; keep the existing injected settings argument. Both `config.x` and direct ENV strings work on 7.0. This avoids a redundant compatibility wrapper or an unnecessary credential-store migration. If YAML/config_for is chosen instead, preserve quoting/JSON escaping of ENV values. Remove the provider-only secrets file/references after migration; do not delete or rotate application credentials or `secret_key_base`.

**Validation:** run existing loopback-provider and fresh-process tests after updating their configuration boundary. Use user `00123`, password `sample: value # keep`, blank/missing production URL, and a URL override for both web and worker. Check values arrive unchanged without logging them. Outstanding queued citation jobs contain a GlobalID, not credentials: the worker uses its deployed settings at execution time. Backfill identical ENV configuration before switching/rolling back code.

### A5. Citation retry wait removed (7.2)

**Affected:** `app/jobs/citation_enrichment_job.rb:7`.

**Recommendation:** use `wait: :polynomially_longer` at 7.1+, preserving attempts 3 and jitter. **Not supported by 7.0.8.7**, which recognizes only `:exponentially_longer`; change at the 7.1 step. If a 7.0-compatible preparation is essential, an explicit Proc must preserve both fourth-power delay and current jitter; avoid introducing that extra code just for this upgrade.

**Validation:** force persistent 503 and verify six HTTP attempts, terminal failure state, and no escape into Sidekiq's retries. Also verify retry timestamps for execution counts 1 and 2 with jitter controlled, not only immediate test-adapter draining. Pending retries resolve this policy from new code; preserve execution counters and the job class name.

### A6. Exports fail after progress reaches the end (7.1)

**Affected:** `app/models/export.rb:42`, `finish(fragments.sum)`.

**Finding:** Rails removed its nonnumeric sum override; Ruby's implicit identity is zero. **Executed:** equivalent string array `.sum` raises TypeError on 8.1; `.join` returns expected Markdown.

**Recommendation:** `finish(fragments.join)`. **Works on 7.0**, no output/data-format change intended. Existing queued `ExportJob` IDs/options remain usable; no job renaming or export-state rewrite is needed.

**Validation:** drain native Sidekiq exports for zero, one, and several notes with ordered headings and rich-text plaintext; assert exact downloadable bytes, completion/progress, cancellation, and 24-hour availability. Existing export request test checks normal bytes, but a test of enqueueing alone would not catch this failure.

### A7. CSV receipt loses custom-primary-key DOI (7.2)

**Affected:** `app/models/import.rb:68`, `citation[:id]`; schema `citations` has string primary key `doi`, no `id` column. HTML receipt correctly uses `.doi` already.

**Recommendation:** use `citation.doi` (or `.id` for primary-key semantics), not `[:id]`. **Works on 7.0.** 7.2 removes `read_attribute(:id)`'s custom-primary-key fallback; this is not an indication to add an id column or change GlobalIDs.

**Validation:** import a nonblank mixed-case DOI, then assert its exact CSV receipt value; include one uncited row as contrast. Existing import receipt test is discriminating. Citation's GlobalID and associations should continue using the unchanged DOI primary key; round-trip an existing citation GlobalID in job validation.

### A8. Invalid imports can partially commit (7.1 defaults; unconditional 7.2)

**Affected:** `app/models/import.rb:50-60`, `return false unless row.note.save` inside `transaction`.

**Finding:** 7.0 rolls back a nonlocal exit after writes. 7.1 can opt into committing, and 7.2 removes rollback-on-return altogether. The first rows and Import can persist even though the controller returns the invalid preview. Keeping 7.0 defaults on 8.1 does not restore this behavior.

**Recommendation:** explicitly raise `ActiveRecord::Rollback` on a failed row, then return a failure result outside the transaction; return true only after every row succeeds. Preserve invalid row objects for preview errors. **Works on 7.0.** Do not just replace `return` with `break`, and do not swallow arbitrary exceptions.

**Validation:** valid first row creating both Note and Citation, invalid second row, then assert no change to Import/Note/Citation/ActionText rows (and embeds if present). The existing invalid-import request test already uses an earlier valid row and checks record counts; run it at every step. Also validate successful all-row commit. This is a permanent consistency fix, not a data migration; audit for partial imports if an uncorrected newer variant was ever used.

### A9. Digests change from UTC day to local day (7.2), including across a single deployment

**Affected:** `User#request_digest` (`app/models/user.rb:35-41`), `DigestJob`, `DigestMailer#daily_digest` (`app/mailers/digest_mailer.rb:8-9`). Redis reservation explicitly uses the UTC date; mailer derives date/range from deserialized time.

**Finding:** 7.0/7.1 TimeWithZone payloads only carry ISO8601 value; deserialization uses worker Time.zone (UTC). 7.2+ additionally serializes zone identity and restores it. **Executed:** target deserializes an old-format 23:30 Eastern payload as October 5 UTC, but a newly serialized payload as October 4 Eastern, same instant. Thus new jobs query a local day while reservations remain UTC; old queued jobs still query UTC. There is no defaults flag governing this. The existing near-midnight digest test should expose changed mail content when run, but does not test both payload generations together.

**Recommendation:** retain documented UTC contract: send the request instant in UTC and normalize `requested_at = requested_at.utc` in the mailer before computing BOTH subject date and `all_day`. The consumer normalization also handles already-queued zone-preserving jobs. **Works on 7.0.** If local-day digests are desired, that is a separate product change requiring reservation keys, retention/boundaries, and duplicate-delivery policy to change together.

**Validation:** at 2026-10-05 03:30 UTC (October 4 23:30 Eastern), seed ready notes on opposite sides of UTC midnight and local midnight. Consume captured old and new JSON payloads; assert October 5 subject and only UTC-day membership in both. Repeat with Tokyo to test the other direction, and assert one reservation per UTC date. Keep worker Time.zone explicitly UTC. Already-delivered wrong-day email cannot be undone by rollback; do not replay whole queues.

### A10. BigDecimal queued arguments block a 7.0 worker rollback (7.1 defaults; unconditional 7.2)

**Affected:** `User#reading_completion`, `User#request_digest`, `DigestJob`, `DigestMailer`.

**Finding:** 7.0 treats BigDecimal as a primitive; Sidekiq JSON turns it into a string. New Rails uses an `_aj_serialized: ActiveJob::Serializers::BigDecimalSerializer` envelope; old Rails has no registered serializer for it. A 7.0 worker cannot consume new envelopes. New Rails can consume legacy string arguments. **Executed:** the 7.0.8.7 reader rejects the new envelope with ActiveJob::DeserializationError, but accepts the prepared string payload (`legacy-reader-probe.log`); target JSON-round-trips both layouts; old string and new BigDecimal both convert successfully through this mailer's `BigDecimal(...)` with resolved bigdecimal 4.1.3. The target mailer conversion succeeds; the demonstrated risk is old-worker deserialization, not target conversion failure. The current Active Job test adapter does not model the old Sidekiq JSON conversion.

**Recommendation:** enqueue `reading_completion.to_s("F")` as an intentional decimal string before any newer producers start. **Works on 7.0** and preserves precision without float conversion. Keep consumer support for both already-queued string and new BigDecimal values. No database format changes are needed.

**Validation:** cross-version JSON payload matrix, using a nontrivial ratio such as 2/3 and zero. Old→new and new prepared-string→old must work; unprepared new envelope→old must fail in a controlled test. Inspect schedule/retry/dead queues as well as ready queues before rollback. Either keep newer workers for those entries or predeploy/test a serializer reader on old workers; do not downgrade workers into unreadable jobs or drop queues. Do not rely on disabling the serializer at 8.1: the old primitive mode has been removed.

### A11. Reminder preview changes at daylight saving boundaries (8.0 default, unconditional 8.1)

**Affected:** `Note#next_day_reminder_at` (`app/models/note.rb:44`) and `app/views/notes/_reminder.html.erb`.

**Finding:** 8.1 `TimeWithZone#to_time` preserves the zone object, regardless of the legacy timezone-preservation setting. Adding 86,400 seconds adjusts offset across DST. **Executed:** October 31 09:00 Eastern becomes November 1 **08:00 −05:00**; old fixed-offset display is **09:00 −04:00**, the same instant. Reminder epoch/postponement remains 24 elapsed hours, not “same wall clock tomorrow.”

**Recommendation:** deliberately choose representation. Prefer accepting the correct reader-local preview, preserving the same epoch, and updating the current test/comment that promises the old fixed offset. If exact old display must survive the upgrade, use explicit `.getlocal(reminder_at.utc_offset)` before addition; **works on 7.0 and 8.1**. Do not substitute `+ 1.day`, which changes elapsed duration across DST. No stored epoch or scheduled job should be rewritten merely for display.

**Validation:** fall-back and spring-forward previews; compare shown instant with actual postponed `reminder_epoch` and delivered mail. Assert superseded scheduled jobs send nothing, and schedule execution on either version matches the persisted job ID. Existing fall-back preview assertion expects the old offset and will need an explicit decision, not blind test repair.

### A12. Test exceptions configuration must use symbols (7.1+, old booleans removed 7.2)

**Affected:** `config/environments/test.rb`, `config.action_dispatch.show_exceptions = false`; many ownership tests expect RecordNotFound to raise.

**Recommendation:** switch to `:none` at 7.1. **Do not prepare this on 7.0**: 7.0 expects boolean semantics and a symbol can enable rendering. In 8.1 the boolean false falls through the wrapper's switch to “show,” not “raise.” Keep production's normal HTTP error behavior.

**Validation:** test configuration should raise for unauthorized lookup; separately run a production-like request expecting 404 and ensure a foreign note/import/export cannot be mutated. Passing tests that only check raised errors do not verify deployed error responses.


### A13. Reminder scheduling passes an epoch where newer Active Job expects Time (7.2)

**Affected:** `app/models/note.rb:61`, `NoteReminderJob.set(wait_until: reminder_epoch)`. This is separate from the DST display decision in A11.

**Finding:** numeric `scheduled_at` support was removed in 7.2. `set(wait_until:)` now stores the supplied object directly, and job serialization calls `.utc.iso8601(9)` on it. The app supplies an Integer. **Executed:** target integer wait_until fails serialization with `NoMethodError: undefined method utc for an instance of Integer`; `Time.at(1_793_451_617).utc` serializes successfully as `2026-10-31T13:00:17.000000000Z`.

**Recommendation:** convert the epoch to a Time at the scheduling boundary, e.g. `wait_until: Time.at(reminder_epoch).utc`, while retaining the integer epoch as the persisted domain value. **Works on 7.0**, which converts a Time wait_until to floating-point seconds. Include this in the preparatory release in D2. Do not convert the database column to datetime or add a job serializer for this internal scheduling option.

**Validation:** schedule the non-round imported epoch used in the existing reminder test, assert exact Sidekiq `at` and DB epoch, execute when due, then replace it and ensure the old job sends nothing. Test a past timestamp and a DST transition instant without changing elapsed-time semantics. Existing 7.0 scheduled jobs do not carry this newer serialized `scheduled_at` field; Sidekiq's outer schedule retains their delivery time. Keep and execute old scheduled payloads rather than dropping/re-enqueueing them, which would change reminder job IDs.

## B. Enqueue timing and queue/server migration boundaries

**Affected:** `Citation#request_enrichment` and `Note#schedule_reminder` enqueue under row locks and rely on Redis failure rolling back DB updates; `Notebook#request_export` is native Sidekiq and saves before enqueue; `User#request_digest` releases Redis reservation on synchronous enqueue failure.

- **Source conclusion:** historical Rails 7.2 defaults select `:default` enqueue-after-commit; its Sidekiq adapter inherits the abstract adapter's `true`. Retaining load_defaults 7.0 on that step leaves old timing. Rails 8.1's class setting is boolean, defaults **false**, and the old application config/symbol settings have been removed. **Executed:** standalone 8.1 class default was false. Do not claim all Rails 8.1 jobs automatically defer, nor copy 7.2 `:never` into 8.1 (a truthy symbol would be hazardous).
- **Recommendation:** preserve synchronous timing in the initial upgrade. On 7.2 use per-job `:never` for citation/reminder jobs if adopting that version's defaults; on 8.x use `false`. Such setters do not exist on 7.0, so apply at the appropriate stage, not in the preparatory release. Accepting deferred enqueue requires redesigning failure recovery: an exception after commit cannot roll back pending state or reminder replacement, and a returned job before commit does not prove Redis accepted it.
- **Validation:** use two real DB connections and a real isolated Sidekiq queue, not transactional fixtures alone. Hold commit open, check when payload appears, then commit/rollback; force Redis refusal and verify citation status/old reminder ID/epoch stay intact. On success run a concurrent worker and verify row locks prevent stale state. Exercise native export separately; Active Job flags cannot change it.
- Rails 8.1 retains the built-in Sidekiq adapter but deprecates it for removal in 8.2; upstream recommends Sidekiq >=7.3.3 for its gem-owned adapter. This is **follow-up**, not an 8.1.0 prerequisite. Keep Sidekiq 6.5/Redis 4 for this scope. A later Sidekiq/Redis migration needs its own review of `User#request_digest`'s `sadd` truthiness/error classes, native ExportJob JSON options, wrapper class compatibility, server API and Redis-server requirements. Do not incidentally upgrade it while resolving Rails.

## C. Optional new-default adoption (separate deployments)

Keep `config.load_defaults 7.0` initially. These are not prerequisites to run the requested Rails gem unless deliberately enabled.

### C1. YAML preferences and readonly notebook slug (7.1 defaults)

**Affected:** `Notebook` lines 7–8, settings controller strong parameters, hidden slug field in `app/views/notebooks/_form.html.erb`.

- New defaults set default column serializer to nil. Before enabling, specify `serialize :preferences, coder: YAML` at 7.1+, preserving existing YAML bytes and nil/hash behavior. **Keyword coder is not safe on 7.0** (same issue as A2). Do not switch it to JSON without a separate dual-reader/backfill/rollback plan. Current fixture notebooks omit preferences, so existing data-type diversity is not established by tests. Validate old raw YAML with string keys and export heading, nil/empty, modified-write→old-reader, and audit safe-load permitted types before considering stricter type declarations.
- New defaults raise on assignment of `attr_readonly` even for the **same** value. Every normal edit resubmits slug, so this is not limited to malicious tampering. Remove slug from **update**-permitted attributes (and the redundant hidden field); preserve generated-on-create slug and attr_readonly. This request-boundary preparation **works on 7.0**. Test unchanged and changed submitted slugs, persisted slug stability, successful name/export-heading update, plus model-level assignment policy. Alternatively retain `raise_on_assign_to_attr_readonly = false` temporarily on newer Rails.

### C2. PostgreSQL date decoding (7.2 defaults)

**Affected:** `Notebook#daily_note_counts` (`app/models/notebook.rb:40`), raw `select_rows` then `Date.iso8601(day)`.

Enabling `postgresql_adapter_decode_dates` returns a Date instead of text; parsing the Date again is invalid. Prefer type-cast `pluck` of the grouped SQL date/count expression, or normalize the raw result only when it is text. **A text-or-Date normalization works on 7.0**; enabling the new configuration itself does not. Validate with decoding off and on, at least two UTC dates and a non-UTC reader, exact counts/order and empty result. Existing activity report test is useful but only exercises one decoder mode. No stored timestamps or report rows need migration.

### C3. Cache encoding and negative expiry (7.1 defaults)

**Affected:** `app/views/exports/_export.html.erb:26`, caches availability with `expires_in: export.expires_at - Time.current`; production enables caching, development toggles it, tests normally disable it.

- An expired completed export computes a **negative** duration on a cache miss. New `raise_on_invalid_cache_expiration_time = true` turns this into an exception instead of showing “Expired.” Keep expired availability uncached or otherwise avoid issuing a cache write with nonpositive lifetime; positive deadlines must still expire correctly. **Works on 7.0.** Validate with caching enabled on cold and warm stores, before/exactly at/after expiry, and an unchanged export cache key. Retain per-request authorization/expiry before download conditional handling. Existing MemoryStore cache test should be rerun with the new invalid-expiry setting explicitly enabled.
- Keep cache format **7.0** while 7.0 instances or rollback readers can see the same FileStore/shared cache. New readers read old bytes; old readers are not guaranteed to read new 7.1 envelope bytes. After old readers retire, adopt 7.1 with a new namespace/cold disposable cache or a forward-reader deployment first. For rollback, use the old namespace or discard only disposable caches, never storage or Redis job/reservation keys. No Redis cache is configured here; production has no explicit cache store override. Verify the actual deployment store/path before planning shared-cache action.

### C4. Signing formats and secret continuity (7.1 defaults)

**Affected:** sign-in CookieStore user ID, Active Storage blob/disk URLs, Action Text persisted attachment SGIDs.

The app already uses **7.0 SHA256 key derivation/digests and JSON cookies**: do not prescribe the 6.1→7.0 SHA1 cookie migration. Preserve production `secret_key_base` and credentials across all releases. For development/test, carry old `tmp/development_secret.txt` forward to `tmp/local_secret.txt` securely; otherwise signatures for existing local rich-text attachments can break, not just logins.

Changing generic message serializer to JSON/Marshal-fallback and enabling new metadata envelopes is distinct from the cookie payload serializer. Active Storage uses `app.message_verifier("ActiveStorage")`; generic signing changes apply there. New Rails can read old formats, which does **not** prove an old rollback reader can verify newly written tokens. Keep legacy generic signing settings (`active_support.message_serializer = :marshal`, `active_support.use_message_serializer_for_metadata = false` on newer Rails) while 7.0 rollback is required, then roll out reader compatibility/rotations before new writers. These new settings are **not a 7.0 preparation**. Do not claim JSON session cookies necessarily change format merely because generic verifier defaults do: cookie jars use their own serialization path.

Validate both directions with a sign-in cookie, blob signed ID/redirect URL, disk URL, and an attachment SGID embedded in stored rich text; exercise old documents after upgrading and newly saved documents after rollback. Stored SGIDs may have no expiry and outlive any release window; waiting for a 24-hour export lifetime does not solve this. Do not rotate secrets as a casual upgrade step or rely on fixture-generated signatures.

### C5. Sanitizer, editor assets, and stored rich text

**Affected:** Action Text initializer, `app/views/layouts/application.html.erb:10-14`, importmap Action Text JS, `app/assets/stylesheets/actiontext.css` (`require trix`), vendored classic Trix 1.3.5, rich-text imports/exports.

New defaults select HTML5 sanitizer on this Ruby/Nokogiri platform. Independently, Rails 8.1 depends on `action_text-trix` (~>2.1.15); this resolution selected **2.1.19**, while the layout still executes the explicit 1.3.5 classic script. A server gem upgrade does not automatically switch that script. CSS supplied under `trix` may therefore move ahead of the executing editor. This is a compatibility/asset validation requirement, **not proven evidence that Trix 1.3.5 cannot operate with 8.1**.

Do not combine an editor replacement or a switch to Propshaft with the framework repair without separate justification. Either deliberately retain and test the current editor during the upgrade or move JS/CSS together to a compatible Trix 2 asset in a separate reviewed step (with correct importmap/classic loading, no double registration). Existing `details/summary` flattening on save is documented pre-existing behavior, not caused by this upgrade; do not silently change its contract.

Validate production asset precompile with local fake secrets, browser create/reopen/edit/save, links with attributes, direct upload, image/nonimage attachments, and malformed imported HTML under old/new sanitizers. Assert persisted body, displayed body, and Markdown plain text; retain an original HTML corpus for rollback. Existing request tests bypass browser serialization, and `test/system` contains no test files: a successful empty system suite would not establish editor compatibility. No browser or asset check was run here.

### C6. HTTP conditional freshness and schema output

**Affected:** `ExportDownloadsController#show`, currently supplies both ETag and Last-Modified; `db/schema.rb`.

8.0 defaults enable strict freshness: If-None-Match takes precedence when both conditional headers arrive. This changes 304 behavior only for contrasting validators. Existing export test sends both matching values and does not distinguish algorithms. Validate matching ETag + stale If-Modified-Since, and mismatching ETag + fresh date, before deciding to adopt; in every variant ownership/expiry must still precede 304. Keep 7.0 defaults initially. The new setting need not be backported to 7.0; direct authorization ordering already works there.

8.1 schema dumps alphabetize columns; treat dump reordering as output churn, not physical column migration. Keep historical `Migration[7.0]` versions. Compare a disposable schema load and full historical migration run (including rich-text backfill) before any DB migration deployment. The requested gem change alone does not justify destructive/schema-wide migrations.

Other new-app defaults (Solid Queue/Cache/Cable, Propshaft, authentication generator, Kamal, browser restrictions, Puma thread template changes) are not requirements to retrofit this app. Its explicit Sidekiq adapter and 5-thread Puma config remain. SQLite, MySQL, Active Record encryption, Rails UJS, custom streaming subclasses and custom autoload requirements have no corresponding use in the inspected application; do not add unrelated migration work for them.

## D. Ordered delivery and rollback plan

1. **Capture baseline safely.** In a disposable environment: explicit unique PostgreSQL DB per variant, private Redis instance/namespace, copy-local Disk roots/cache/mail files, and loopback provider. Do not just copy the checkout and retain default database names/localhost Redis. Capture exact commands, Ruby/Bundler, lockfiles, config/defaults, logs, warnings, DB schema and resource identities. Back up real DB+blob storage before an eventual authorized deployment; do not use production data for probes without an approved sanitized process.
2. **Preparatory 7.0 release:** A1 safe-tag union, positional enum and explicit highlight delegates, split routes, config.x provider settings, string join, DOI accessor, explicit transaction rollback, UTC digest normalization, decimal-string arguments, Time-valued reminder scheduling. If new defaults are planned, stop submitting/updating slug and fix nonpositive fragment expiry now. Run baseline suites and the focused boundary cases before deploying this release. These preserve durable formats and job names. This release is the preferred rollback destination, not the original unprepared 7.0 code.
3. **Upgrade minor by minor:** latest approved patches of 7.0 → 7.1 → 7.2 → 8.0 → exact requested 8.1.0, retaining 7.0 defaults initially. At 7.1 move JSON coder to keyword syntax, rename retry wait, and switch show_exceptions to :none; declare YAML coder when enabling new defaults. Read `app:update` diffs in the disposable branch, never blindly overwrite application config, routes or services. Do not carry obsolete 7.2 enqueue settings into 8.1. Review all deprecations, including those hidden by production `report_deprecations = false`.
4. **Validate each step:** `bundle check`, eager-load/zeitwerk check, unit/integration suite with private DB/Redis, targeted real Sidekiq execution, production-like assets/requests, and actual browser editor/reminder workflows. System browser base currently needs Chrome/display and has no scenarios. Repeat risky cases with new-default settings individually, not only with aggregate defaults. Verify current pg/Puma/Sprockets integrations by execution; lock success alone does not prove them.
5. **Queue rollout:** inventory ready/scheduled/retry/dead entries and in-flight work; long-future reminders mean “drain ready queue” is insufficient. Preserve GlobalIDs and job IDs; export native Sidekiq arguments remain separate from Active Job serialization. Deploy prepared producers/consumers first. Then use newer consumers before newer producers where possible; capture real JSON round trips in both directions. If crossing directly with old unprepared workers, pause producers and coordinate worker replacement rather than mixing incompatible formats. Avoid deleting jobs or rewriting reminder IDs. Do not replay email jobs indiscriminately: delivery is not exactly once.
6. **Keep rollback viable:** preserve original data encodings, secrets, signing defaults and cache format/namespace. Avoid broad schema or rich-text rewrites. Quiesce new producers and account for in-flight/scheduled/retry work before switching workers back. New serializer envelopes must be absent, read-compatible, or left for retained newer workers. Rollback of code cannot undo delivered mail, changed persisted HTML, or committed partial imports. Keep generated exports/blob objects accessible to both versions.
7. **Adopt defaults after stabilization**, one concern per release: YAML coder/readonly parameters, raw date typing, cache expiration/format, signing envelope, HTML5 sanitization, freshness, and optional editor modernization. Recheck old/new readers and rollback for each. Only then advance `load_defaults`; no need to keep obsolete compatibility settings indefinitely. Evaluate current security fixes for the chosen 8.1 patch before production authorization; this assessment targets exactly 8.1.0, not an assertion that it is the latest secure patch.

## Remaining gates / uncertainty

- Actual persisted preference types, old tag encodings, attachment SGIDs, production signing keys/source, deployed cache store, PostgreSQL version, Redis version and queued payload populations are unknown. No source review can establish their contents.
- Boot was stopped by the first real initializer failure. Other findings are source-derived or standalone probes, not a claim of sequential application execution after fixes.
- No application tests, live Sidekiq/Redis/DB transaction tests, asset precompile, HTTP freshness exercise, cross-version token verification, or browser workflow was executed. They remain required acceptance gates; do not report a green suite or upgrade readiness from the successful dependency resolve.
- Product choices remain: retain documented UTC digests (recommended), accept correct zone-aware reminder preview versus preserve fixed-offset representation, and when to adopt editor/default changes. No decision is required to start the compatible preparatory work.
