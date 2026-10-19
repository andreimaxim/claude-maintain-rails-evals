# Rails 7.0.8.7 → 8.1.0: application-specific upgrade risk

## Application facts and scope

**Evidence labels:** **Code** means application/framework/dependency source inspected; **History** means an upstream changelog, commit or PR; **Inference** means the predicted effect on this application, not an executed reproduction. Risk is impact-based: silent behavioral, persisted-data and mixed-version job changes are high even when they fix a framework bug. Mechanical errors with a direct replacement are low, even when they prevent boot.

- **Code:** The application pins Rails 7.0.8.7 and Ruby 3.3.6, loads all Rails frameworks, and explicitly retains **`config.load_defaults 7.0`**. This report assumes only the Rails requirement changes; adopting newer defaults is a separate decision. Ruby already meets Rails 8.1's ≥3.2 requirement. [Gemfile](file:///home/user/workspace/repo/Gemfile#L1-L8), [application configuration](file:///home/user/workspace/repo/config/application.rb#L1-L24).
- **Code:** PostgreSQL (`pg` 1.6.0), one database per environment; HTML/ERB, Sprockets, importmap, Turbo and Stimulus. This is not an API-only application. [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L26), [Gemfile](file:///home/user/workspace/repo/Gemfile#L10-L37), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L1-L15).
- **Code:** Active Job uses pinned Sidekiq 6.5.12 and Redis 4.8.1 outside tests; exports use native Sidekiq jobs. Digests carry a reader GlobalID, a reader-zoned time and a BigDecimal. Reminders use numeric epoch scheduling. [job configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24), [digest enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [reminders](file:///home/user/workspace/repo/app/models/note.rb#L56-L68), [export job](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L10).
- **Code:** Rich text is stored by Action Text; attachments and exported Markdown use Active Storage Disk. No image-processing gem is installed. The layout deliberately loads vendored **Trix 1.3.5**, while CSS uses the framework's `trix.css`. [storage](file:///home/user/workspace/repo/config/storage.yml#L1-L7), [blob view](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L14), [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [CSS](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L7).
- **Code:** Production enables fragment caching without overriding the framework's FileStore; development optionally uses MemoryStore, tests NullStore. Redis is used for jobs and digest reservations, not Rails caching. Exports have a time-limited fragment and a separately authorized download action. [production](file:///home/user/workspace/repo/config/environments/production.rb#L15-L17), [development](file:///home/user/workspace/repo/config/environments/development.rb#L20-L35), [fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36), [download](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16).
- **Code:** Notes serialize tags as JSON in text, use a jsonb settings accessor, and notebooks serialize preferences with the implicit YAML coder. Citations use DOI as their primary key, not an `id` column. [models](file:///home/user/workspace/repo/app/models/note.rb#L10-L19), [notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19), [schema](file:///home/user/workspace/repo/db/schema.rb#L55-L61).
- **Code:** Authentication uses encrypted cookie sessions containing the user ID; citation-provider settings come from `Rails.application.secrets`. Mail is delivered synchronously inside background jobs, to files in development and the test adapter in tests. [session handling](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18), [provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15), [development mail settings](file:///home/user/workspace/repo/config/environments/development.rb#L39-L45), [test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L36-L48).
- **Limit:** No database contents, deployed environment, credentials or existing Redis payloads were inspected. No application boot, tests, new-gem installation, migration or service change was performed. Findings below are static predictions; existing early boot errors must be repaired before downstream behavior is observable.

### Dependency resolution actually performed

Copied `Gemfile` and `Gemfile.lock` outside the repository, changed only Rails to `8.1.0`, and ran `bundle lock --update rails` under Ruby 3.3.6 / Bundler 2.5.22. Resolution **succeeded** on 2026-10-19. It does not establish runtime compatibility.

**Code / resolver evidence:** All 13 Rails-family gems move to 8.1.0: rails, railties, actioncable, actionmailbox, actionmailer, actionpack, actiontext, actionview, activejob, activemodel, activerecord, activestorage and activesupport. `net-imap` moves 0.6.7 → 0.6.8; `method_source` 1.1.0 disappears. New locked dependencies are:

| Gem | Resolved version | Previous baseline |
|---|---:|---|
| action_text-trix | 2.1.19 | No gem; application uses vendored Trix 1.3.5 |
| bigdecimal | 4.1.3 | Ruby's installed default 3.1.5, not previously locked |
| json | 3.1.0 | Ruby's installed default 2.7.2, not previously locked |
| uri | 1.1.2 | Ruby's installed default 0.13.1, not previously locked |
| drb | 2.2.3 | Ruby's installed default 2.2.0, not previously locked |
| securerandom | 0.4.1 | Ruby's installed default 0.3.1, not previously locked |
| rack-session | 1.0.2 | Session implementation supplied by Rack 2 |
| rackup | 1.0.1 | Rack 2's server/handler implementation |
| useragent | 0.16.11 | Not locked |
| webrick | 1.9.2 | Not locked |

Rack **remains 2.2.24**, because Sidekiq 6.5 requires Rack 2; Puma remains 5.6.9, Redis 4.8.1, Faraday 1.10.4, Pagy 8.6.3, pg 1.6.0, and the existing sanitizer/Nokogiri gems remain unchanged. There is no forced Rack 3, Sidekiq 7, Redis 5, Propshaft or Solid Queue upgrade. Default-gem baselines above describe this Ruby installation; deployment images could differ.

[Full lockfile delta](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff) · [Resolver output](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolution.txt)

## High-risk changes with the existing 7.0 defaults

### H1. Failed CSV imports can commit a partial batch

**History:** Rails restored committing transactions on non-local `return`, `break` and `throw`; the rollback compatibility path was removed. [Removal commit](https://github.com/rails/rails/commit/eccc6061f4f3abdfdeb9a363987a898418d9498f), [7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L304-L334).

**Code:** In 7.0.8.7, leaving a written transaction early rolls it back; 8.1.0 commits unless an exception or abort intervenes. [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and preceding rows, then `return false`s when a later note is invalid. This is not protected by `load_defaults 7.0` in the target.

**Inference:** A valid first row followed by an invalid second row leaves the import, first note and possibly its citation/rich text committed, even though the response reports failure. Retrying can duplicate data. Preserve explicit all-or-nothing rollback semantics. The [existing regression case](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L72) already describes the critical boundary.

### H2. CSV receipts silently lose DOI values

**History:** `read_attribute(:id)` no longer substitutes a custom primary key from Rails 7.2. [Changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L427).

**Code:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) uses `citation[:id]`, which delegates to `read_attribute`; the citations table has only `doi` as its primary key. Before, this returned the DOI; target source reads the nonexistent `id` attribute, whose null attribute value is nil.

**Inference:** CSV downloads have blank DOI cells while the HTML receipt, using `citation.doi`, still looks correct. Use the intended DOI or primary-key method, and inspect actual CSV output rather than only response status.

### H3. Import previews silently omit annotations

**History:** Rails 8 fixes `HashWithIndifferentAccess#stringify_keys` to stringify non-symbol keys too. [Before/after example](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L45).

**Code:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) indexes annotations by integer source-line numbers. The [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) calls `stringify_keys` but then looks up `annotations[row.line]` with an integer. In 7.0 the integer keys survive; in the target they become strings.

**Inference:** Annotation text disappears from the preview without an exception, although it is still imported. Make key conversion and lookup consistent; the source-line identifiers themselves should remain correct for multiline CSV rows.

### H4. Digests change from UTC days to reader-local days

**History:** Active Job preserves the serialized TimeWithZone's named zone instead of reconstructing it solely in the worker's zone. [PR #50240](https://github.com/rails/rails/pull/50240), [target serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

**Code:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC date** in Redis but passes a time in the reader's zone. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses that object's `to_date` and `all_day`. The exact 7.0.8.7 source deserializes with `.in_time_zone` and no stored zone; 8.1 uses the new `time_zone` field with a fallback for old payloads.

**Inference:** A Tokyo request at 00:30 local time can now select and label the next calendar day's local interval, while its reservation remains the previous UTC date. Mixed old/new workers and old queued payloads can produce different digest windows. The new format is readable by old workers, but old workers ignore the added zone. Decide explicitly whether the product contract is UTC or local days and keep the reservation/window aligned.

### H5. BigDecimal job arguments change format and mixed-version compatibility

**History:** Rails 7.1 adds an explicit BigDecimal serializer; 7.2 removes the primitive path and Rails 8 removes its compatibility switch. [7.1 migration warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

**Code:** [Reading completion](file:///home/user/workspace/repo/app/models/user.rb#L41-L56) is sent through Sidekiq's JSON queue. In 7.0 it arrives as a decimal string. The target writes a serializer-tagged object and restores a BigDecimal. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) normalizes with `BigDecimal(...)`, so the new value type alone need not break this mailer.

**Inference:** A 7.0 worker cannot resolve the new BigDecimalSerializer; new workers can still receive old string-valued jobs. A web/worker rolling deployment needs a staged serializer-compatible intermediate release or deliberate queue draining/cutover, not just a successful boot. This is distinct from the separately resolved bigdecimal gem version.

### H6. Reminder previews change across daylight-saving boundaries

**History / Code:** Rails 8.1 removes the old `to_time` behavior; `TimeWithZone#to_time` now uses `getlocal(time_zone)`, retaining the named zone rather than only a fixed UTC offset. [Changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22), [target implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L500).

**Code:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L45) adds 86,400 seconds to `reminder_at.to_time`; the [view](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays its wall-clock time and zone.

**Inference:** The same postponed instant can now display the new DST offset instead of retaining the old offset. This corrects the current preview discrepancy but changes visible behavior without an error. The contract remains **24 elapsed hours**, not “same local time tomorrow”; scheduling epochs should not change from this fix alone. Check spring-forward and fall-back examples, not UTC-only cases.

### H7. Negative cache TTLs no longer mean immediately expired entries

**History:** Rails 7.1 adds invalid-expiration handling. [Changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L869).

**Code:** The [export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) passes `expires_at - Time.current`, which is negative after expiry. Previously this made an already-expired cache entry. Target [cache option handling](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L909-L944) deletes the negative TTL and reports/logs an error. With retained 7.0 defaults it does **not** raise, leaving the store's default TTL, here no explicit expiry.

**Inference:** Expired-status fragments can persist without a TTL, and negative TTLs are logged rather than honored. This does not by itself restore expired download access: [the controller rechecks expiry before `stale?`](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L15). If 7.1 defaults are later enabled, this same path raises instead. Review caching only unexpired availability or using a deliberate expiry strategy.

### H8. Action Text changes the HTML content-attachment model and edit-time sanitization

**History:** Rails 7.1 broadens HTML content attachments beyond the old horizontal-rule special case; subsequent releases sanitize their HTML before presenting it to Trix. [7.1 changelog](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [7.2 security fix](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md#L3-L10).

**Code:** Compare [old content attachment](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/lib/action_text/attachables/content_attachment.rb) with [target](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/attachables/content_attachment.rb): the target requires nonempty `content` and an HTML content type, rather than only the special MIME name. Its `Content#render_attachments` sanitizes `content` before rendering. [CSV import](file:///home/user/workspace/repo/app/models/import.rb#L101-L106) accepts arbitrary body HTML; [note editing](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L48-L51) round-trips it through Trix; [Markdown export](file:///home/user/workspace/repo/app/models/export.rb#L77-L81) converts it to plain text.

**Inference, conditional on stored HTML:** Legacy content attachments without `content` can become missing attachments; HTML content can be stripped or represented differently on editing/export and then persisted when saved. Ordinary blob attachments are a different path. Inspect representative stored/imported HTML; no claim is made that the database currently contains these legacy attachments. This change applies even while retaining the HTML4 sanitizer vendor.

### H9. Blob analysis now touches owning records

**History:** Rails 7.1 fixes cache invalidation by touching records when blobs are analyzed. [Changelog](https://github.com/rails/rails/blob/v7.1.0/activestorage/CHANGELOG.md#L147-L154).

**Code:** Target blobs run `after_update :touch_attachments`; attachments touch their record, and Action Text rich text touches its parent. This app uses [rich-text attachments](file:///home/user/workspace/repo/app/models/note.rb#L8) and selects digest content by [note `updated_at`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L8-L9). Image analysis still records `analyzed: true` when the optional Vips library is absent; lack of image variants does not eliminate this path.

**Inference:** Delayed analysis/reanalysis can move a note into a later digest's “updated today” interval without a reader editing it, and invalidate related cache versions. Review whether digest membership should reflect edits or all framework touches; the affected analysis timing was not measured.

### H10. Local signing keys may change, invalidating sessions and attachment references

**History:** Rails 7.1 renames `tmp/development_secret.txt` to `tmp/local_secret.txt`; newer Rails also prefers ENV/credentials keys in development/test. [Upgrade guide](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md#L156-L164).

**Code:** The app relies on [sessions](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18) and [signed blob links](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L3-L11); no local key override is present in application configuration.

**Inference, conditional:** If key selection produces a different value, existing local cookies, signed URLs and Action Text signed references can stop validating. Preserve the actual old key and verify the target's precedence, not just the filename. Credentials and key values were deliberately not inspected, so invalidation is not asserted as already confirmed. The filename rename does not itself affect production.

## Medium-risk decisions and blockers

### M1. Removed `Rails.application.secrets` breaks citation enrichment

**History:** Deprecated in 7.1, removed in 7.2. [Changelog](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L57-L63).

**Code:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L15) reads provider URL and credentials through that API; [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18) currently obtains them from environment variables. Tests also mutate this settings object.

**Inference:** Default provider construction raises rather than making a request. The application must choose credentials, `config.x`, or explicit environment-backed configuration and preserve symbol-key lookup/test overrides; there is no safe blind rename that migrates this file's contract. The error is outside `Provider::Error` handling and can leave enrichment pending while Sidekiq retries.

### M2. Sidekiq 6.5 depends on an adapter scheduled for removal

**History / Code:** Rails 8.1's built-in Sidekiq adapter remains available but warns that it will be removed in **8.2**, recommending Sidekiq ≥7.3.3's bundled adapter. [Changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [adapter warning](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L34-L40).

**Code:** The app explicitly chooses `:sidekiq` in [application configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24) and pins 6.5.12 in the Gemfile. Resolution does not change it.

**Inference:** This is not an 8.1 dependency-resolution failure, but it is a next-release removal needing a separate Sidekiq/Redis/job-argument review. Do not silently update Sidekiq while treating this as only a Rails upgrade.

### M3. Today's resolved JSON 3.1 is incompatible with Rails 8.1.0's decoder

**History:** JSON 3 removes positional option hashes from `JSON.parse`, rejects unknown keywords, and rejects duplicate keys/comments by default. [JSON 3 release history](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

**Code:** The old Ruby-default JSON 2.7.2 accepts `parse(source, opts = {})`. Resolved JSON 3.1 defines `parse(source, on_load: nil, object_class: nil, array_class: nil, **options)`. Rails 8.1.0 still calls **`::JSON.parse(json, options)`** from [ActiveSupport::JSON.decode](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb#L24-L25). Its JSON column coder also passes `{ escape: false }` into decoding, an unsupported JSON 3 parser option.

**Inference from those signatures:** Even after mechanically repairing `serialize :tags`, loading [stored tags](file:///home/user/workspace/repo/app/models/note.rb#L12-L14), jsonb settings and Rails JSON cookie payloads encounters an argument mismatch. This is a **resolver-accepted runtime blocker**, not evidence that resolution failed. Decide on an explicitly compatible JSON constraint or a separately reviewed Rails patch target; changing only the argument splat would not address the unsupported `escape` option.

**Additional contract change:** Direct [provider `JSON.parse`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) and Sidekiq's direct JSON parser do not pass a positional options hash, but JSON 3 rejects payloads with duplicate keys, comments, invalid escapes or malformed Unicode that older versions tolerated. Provider failures are rescued and reported as invalid JSON. Existing provider/queue payload compatibility is unverified; avoid claiming every old job will fail.

### M4. Trix is extracted into a gem, but this application's editor remains old

**History:** Rails 8.1 replaces vendored Trix with `action_text-trix >=2.1.15`; resolution selects 2.1.19. [Changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

**Code:** The app's [explicit `trix-1.3.5.js` include](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14) still wins for JavaScript; [CSS](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L6) now comes from the new gem, and [Action Text JavaScript](file:///home/user/workspace/repo/config/importmap.rb#L8) comes from Rails 8.1. The new gem registers/precompiles assets; it does not rewrite this layout.

**Inference / uncertainty:** This creates an old-editor/new-integration/new-styles combination, not an automatic Trix upgrade. Runtime incompatibility was not proved. Decide deliberately whether to retain the workaround or migrate to the target editor, with attachment/edit/save round-trip review. Do not claim the gem update delivers Trix security fixes to browsers while the vendored script remains in use. Any editor migration can change persisted HTML, so its content-round-trip review is high-impact even though the integration decision itself is medium.

## If newer framework defaults are adopted later

These are **not automatic consequences** of the requested gem-only upgrade. The gating source is [Rails 8.1 `load_defaults`](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L259-L369).

- **High, conditional — HTTP freshness:** 8.0 defaults enable `strict_freshness`: with both headers present, ETag takes precedence instead of requiring both ETag and Last-Modified to match. [Export download](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L13) can return 304 where it previously returned 200. Authorization/expiry remain ahead of that decision. **History / Code:** [Action Pack changelog](https://github.com/rails/rails/blob/v8.0.0/actionpack/CHANGELOG.md), [implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb#L39-L68).
- **High, conditional — HTML5 sanitization:** 7.1 defaults change HTML4 parsing/sanitization to HTML5 where supported. [Custom allowlist](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), [imported HTML](file:///home/user/workspace/repo/app/models/import.rb#L101-L106), and rendered rich text can retain/strip/restructure different markup. Review malformed HTML and collapsible excerpts; do not infer the vendor switch just from the new gem version. **History / Code:** [Action Text 7.1 entry](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L34).
- **High, conditional — cache/message formats:** 7.1 defaults select cache format 7.1, JSON-with-Marshal-fallback messages, and the new metadata envelope. Existing 7.0 caches and signing settings remain selected until changed. [Export fragments](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) and [signed blob links](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L3-L11) make old/new-reader compatibility and rollback important; fallback reading by a new process does not prove old processes can read new writes. **History / Code:** [Active Support 7.1 changelog](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), configuration source above. **Inference:** stage these format changes independently.
- **Low, conditional — PostgreSQL raw date decoding:** 7.2 defaults return `Date` from `select_rows`; [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) currently calls `Date.iso8601` on a string. Adapt the consumer if enabling this setting; retaining 7.0 leaves decoding off. **History / Code:** [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L99-L103).
- **Low, conditional — implicit YAML serializer:** 7.1 defaults set `default_column_serializer = nil`; [Notebook's `serialize :preferences`](file:///home/user/workspace/repo/app/models/notebook.rb#L7) then requires an explicit coder. Specify YAML to preserve existing storage; choosing JSON instead would be a separate high-risk data-format migration. **History / Code:** [7.1 changelog](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L907-L938).
- **Low, conditional — readonly assignment:** 7.1 defaults raise even on resubmitting a persisted readonly attribute; the [settings form sends slug](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L14), and [the controller permits it](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L40). Omit that assignment when adopting the default. **History / Code:** [7.1 entry](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L1209-L1224).

## Low-risk changes: mechanical fixes and localized compatibility checks

Each line is based on **History + Code**; the expected application failure is **Inference**, not a test result.

- **Keyword enum removal:** [Note's `enum status: ..., _prefix: true`](file:///home/user/workspace/repo/app/models/note.rb#L10) must become positional `enum :status, ..., prefix: true`; integer mappings stay unchanged. [Rails 8 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md).
- **Positional serializer removal:** [Note's `serialize :tags, JSON`](file:///home/user/workspace/repo/app/models/note.rb#L12) needs `coder: JSON`; preserve JSON storage and separately resolve M3. [Rails 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L423).
- **Non-attribute alias removal:** [Highlight's alias to the store accessor `color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) now raises because `color` is not a model attribute/column; explicitly delegate both reader and writer to the existing store accessor. [Rails 7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490-L492).
- **Nil Action Text allowlist:** [The initializer's `allowed_tags += ...`](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) calls `+` on nil in the target; derive and extend effective default tags rather than replace them with only `details/summary`. This applies even with 7.0 defaults. [7.1 entry](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L34).
- **String `sum` removal:** [Export#generate's `fragments.sum`](file:///home/user/workspace/repo/app/models/export.rb#L36-L42) now uses Ruby's numeric initial value and raises; `fragments.join` or an explicit empty-string identity preserves concatenation. [7.1 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420-L428).
- **Numeric scheduled time removal:** [Reminder `wait_until: reminder_epoch`](file:///home/user/workspace/repo/app/models/note.rb#L61) leaves an Integer in `scheduled_at`, but target serialization calls `utc.iso8601`; pass `Time.at(reminder_epoch)` to preserve the instant. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [target code](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L124-L132).
- **Retry option rename/removal:** [Citation job's `wait: :exponentially_longer`](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must use `:polynomially_longer`; the delay formula need not change. [7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L19-L25), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).
- **Multiple paths in one route removed:** [The `/notes`, `/journal` declaration](file:///home/user/workspace/repo/config/routes.rb#L17-L18) needs separate route declarations preserving both URLs and helper naming. [8.1 removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md).
- **Boolean exception setting removed:** [Test `show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) should become `:none`, preserving exception-based authorization tests. [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md).
- **Schema dump/test infrastructure:** [schema.rb](file:///home/user/workspace/repo/db/schema.rb#L13) columns are alphabetized on future dumps and [parallel tests](file:///home/user/workspace/repo/test/test_helper.rb#L7-L12) use `_N` database suffixes; review generated diffs/local test DB naming, not production data order. [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md).

## Changes screened out, or no application-specific regression established

These are **Code-based applicability judgments**, not claims that the frameworks have no other changes.

- **MySQL/MariaDB/Trilogy/SQLite adapters:** Not configured; their SQL, transaction and migration changes do not apply to this PostgreSQL app.
- **Composite keys, encryption, sharding, async queries, batch cursors, CTEs and custom connection adapters:** No use found in the models/configuration; a DOI primary key is not a composite primary key.
- **`find_or_create_by` race fix:** Citation creation uses `find_or_initialize_by` plus a later save, so the documented uniqueness-conflict behavior is not automatically repaired.
- **Automatic after-commit job deferral:** Despite the broad 7.2 announcement, the exact 8.1 target defaults `enqueue_after_transaction_commit` to **false** and the app never enables it. [Source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L41-L55). Do not claim the reminder/citation enqueue-under-lock behavior automatically moves after commit; explicitly enabling it would require reviewing failure/rollback semantics.
- **Action Text embeds callback timing:** 8.1 moves embed assignment to `before_validation`, but this app's size validator reads `body.body.attachables` directly, not `embeds`. No demonstrated bypass of its 1 MB validator was found; ordinary validation/save coverage remains appropriate. [Application validator](file:///home/user/workspace/repo/app/models/note.rb#L95-L98), [history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).
- **Active Storage collection append/replacement removal, Blob→Attachment autosave removal:** No direct application dependency on the old APIs was found; attachments use Action Text and `has_one_attached` rather than saving a blob to save a newly built attachment.
- **Image/video transformations, preprocessed variants and cloud-storage services:** No application variants and no S3/GCS/Azure service configured; original blobs are rendered. Blob analysis/touching is separately relevant (H9).
- **Private-file policy:** The upgrade does not add application sign-in checks to Rails' blob/direct-upload controllers. Existing signed-URL privacy/upload-abuse concerns are not new upgrade behavior.
- **Action Mailbox:** Loaded but no inbound mailbox classes or ingress configuration found; inbound parsing/routing changes and net-imap 0.6.7→0.6.8's SequenceSet/config/parser fixes do not affect the implemented outbound mail features. [Dependency diff](https://github.com/ruby/net-imap/compare/v0.6.7...v0.6.8).
- **Action Cable:** Only generated base classes/configuration, no application streams or broadcasts; reconnect/subprotocol changes do not change an implemented user feature.
- **Action Mailer additions/removals:** No previews, delivery callbacks, `deliver_later`, or removed `assert_enqueued_email_with` parameter API in use; synchronous delivery stays. Digest behavior changes are covered separately.
- **New authentication generator/reset-token APIs:** They do not replace the existing session controller or add routes. Password byte-length/confirmation validation changes apply when assigning passwords, but no user-facing registration/password-change flow was found; existing sign-in does not assign a password. Seed/fixture passwords are ASCII and below the limit.
- **Rack 3 status/header/session changes:** Rack stays 2.2.24. New rack-session 1.0.2 is the Rack-2 compatibility package; the Rails server shim falls back to Rack 2 with rackup 1.0.1. Do not import a generic Rack-3 migration checklist into this resolution.
- **WEBrick and useragent:** WEBrick is added through rackup but the app selects Puma; `allow_browser`/browser gating is not configured, so adding useragent does not impose a browser restriction.
- **Redis cache pooling/UNLINK and MemCacheStore changes:** Neither store is configured. The Redis gem and Sidekiq reservation code remain unchanged.
- **Bigdecimal 3.1.5→4.1.3:** Upstream changes include division/precision fixes, Float construction without precision, and `divmod`/`precs` changes. The app uses finite integer-derived ratios rounded to four places and string construction; no concrete changed result was established for those inputs. Keep a nonterminating fraction check in the eventual digest review; do not attribute H5's wire-format change to this gem. [Release history](https://github.com/ruby/bigdecimal/releases), [application arithmetic](file:///home/user/workspace/repo/app/models/user.rb#L53-L56).
- **URI 0.13.1→1.1.2:** The default parser constant changes, but `URI.parse` already used RFC3986 in the installed old source; the app's provider calls that method. No concrete acceptance difference was established for its HTTP(S) URLs; Faraday stays pinned. [Source comparison](https://github.com/ruby/uri/compare/v0.13.1...v1.1.2).
- **DRb / SecureRandom:** New locks replace Ruby-default versions; DRb is framework test-process infrastructure and SecureRandom continues using `Random.urandom` on this platform. No custom DRb protocol, RNG override or deterministic-randomness contract was found. [DRb history](https://github.com/ruby/drb/compare/v2.2.0...v2.2.3), [SecureRandom history](https://github.com/ruby/securerandom/compare/v0.3.1...v0.4.1).
- **Removed method_source:** Railties drops this console implementation dependency; application code does not call it.
- **New-app defaults/tooling:** Solid Queue/Cache/Cable, Propshaft, Kamal, generated authentication, Docker and CI changes do not rewrite this existing application on a gem update. Force-SSL/template changes also do not enable the currently commented-out production setting.
- **Other 8.1 defaults/APIs:** JSON response escaping, path-relative redirect enforcement, modern-browser gating, new rate limiting and continuations are not exercised by this HTML app's current declarations. Existing absolute-path route helpers and strong-parameter code do not require adoption of `params.expect`.

## Review basis and next decision

I inspected tagged Rails sources at 7.0.8.7, 7.1.0, 7.2.0, 8.0.0 and 8.1.0, intervening stable-branch changelogs, the full endpoint diff as a search surface, and focused source diffs for the affected paths. Later patch changelog entries were not assumed present unless corroborated in the 8.1.0 source. Newly resolved gems were downloaded/unpacked for reading only. This is a targeted risk review, not an exhaustive proof of compatibility or a security audit of today's supported patch levels.

**Recommendation (inference):** Do not treat this as a one-line deploy. Resolve the JSON compatibility decision and mechanical boot/API failures first; then prioritize import atomicity, CSV/preview content, digest UTC/local semantics and mixed-worker serialization. Keep `load_defaults 7.0` initially, preserve signing keys, and adopt newer defaults separately. Once an upgrade is authorized, the existing import/digest/reminder/export tests plus queued-payload and rich-text round-trip cases are the highest-value checks. None were run during this read-only review.
