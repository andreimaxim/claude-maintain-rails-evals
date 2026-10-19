# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## Application facts and scope

**This is not a safe version-only bump.** Dependency resolution succeeds, but source inspection identifies boot/runtime blockers and silent changes to imports, digests, reminders, and caching. Findings below describe behavior after any earlier boot blockers have been addressed, not a claim that the unchanged application boots on 8.1.

Evidence labels: **History** = upstream release notes/changelog/commit; **Code** = application or released framework/dependency source read; **Inference** = predicted application consequence, not an executed test.

- **Code:** Ruby is pinned to **3.3.6**, Rails to **7.0.8.7** ([Gemfile](file:///home/user/workspace/repo/Gemfile#L1-L7)). Ruby satisfies Rails 8.1.0's `>= 3.2.0` requirement. This review does not include a Ruby upgrade.
- **Code:** The baseline upgrade retains **`config.load_defaults 7.0`** and `rails/all`, with Active Job's Sidekiq adapter ([application configuration](file:///home/user/workspace/repo/config/application.rb#L1-L24)). Changing the gem does **not** automatically opt into every 7.1–8.1 default. Conditional findings are explicitly separated below.
- **Code:** PostgreSQL is the only database adapter ([database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L31)). `citations.doi` is a string primary key; note tags are JSON in text, settings are JSONB, notebook preferences are serialized text ([schema](file:///home/user/workspace/repo/db/schema.rb#L55-L109)). The deployed PostgreSQL version and actual stored data were not inspected.
- **Code:** This is a server-rendered HTML application using ERB, Sprockets, importmap, Turbo, and Action Text. It deliberately loads **vendored Trix 1.3.5**, not the gem's Trix JavaScript ([layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [import map](file:///home/user/workspace/repo/config/importmap.rb#L3-L8)). Jbuilder is installed, but no application JSON views were found.
- **Code:** Active Storage uses local Disk, including rich-text uploads and export files; images render original blobs, not variants ([storage configuration](file:///home/user/workspace/repo/config/storage.yml#L1-L7), [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L15)). Rich text accepts imported HTML and a custom `details`/`summary` allowlist.
- **Code:** Sidekiq **6.5.12**, Redis **4.8.1**, Faraday **1.10.4**, pg **1.6.0**, Pagy **8.6.3**, and concurrent-ruby **1.3.4** are pinned. Digests/enrichment/reminders use Active Job; exports use native Sidekiq. Redis also holds digest reservations, **not Rails.cache**. Tests select `:test` for Active Job and fake native Sidekiq ([test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L32-L45), [test helper](file:///home/user/workspace/repo/test/test_helper.rb#L1-L12)).
- **Code:** Development uses MemoryStore when caching is enabled, otherwise NullStore; tests use NullStore; production does not override Rails' default FileStore ([development](file:///home/user/workspace/repo/config/environments/development.rb#L20-L35), [production](file:///home/user/workspace/repo/config/environments/production.rb#L15-L18), [upstream default](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L58)). Production caching is enabled.
- **Code:** Authentication stores a user ID in the Rails session; email is delivered synchronously by reminder/digest jobs. Development writes files, tests collect mail, and production has no explicit delivery method/host configured. No application Action Cable broadcasts or Action Mailbox processing were found.

### Actual dependency resolution

**Observed resolver result:** Copied only Gemfile/Gemfile.lock into a temporary directory, changed only the copied Rails requirement, then ran `bundle lock --update rails` using Ruby 3.3.6/Bundler 2.5.22. No installation or application execution. Resolution reflects RubyGems on **2026-10-19**, not the dependency versions available on Rails 8.1.0's release date.

- All 13 Rails-family gems become **8.1.0**: rails, railties, actioncable, actionmailbox, actionmailer, actionpack, actiontext, actionview, activejob, activemodel, activerecord, activestorage, activesupport.
- Existing non-Rails lockfile version change: **net-imap 0.6.7 → 0.6.8**. Removed: **method_source 1.1.0**.
- New lock entries: **action_text-trix 2.1.19; bigdecimal 4.1.3; drb 2.2.3; json 3.1.0; rack-session 1.0.2; rackup 1.0.1; securerandom 0.4.1; uri 1.1.2; useragent 0.16.11; webrick 1.9.2**.
- **Rack stays 2.2.24, Sidekiq stays 6.5.12, Puma stays 5.6.9**, and the other pinned dependencies stay put. Rails 8.1.0 allows Rack >= 2.2.4; Sidekiq's Rack ~> 2.0 constraint does not make this resolution impossible.
- Newly explicit stdlib dependencies can still change runtime versions: this Ruby installation supplies json **2.7.2**, bigdecimal **3.1.5**, drb **2.2.0**, securerandom **0.3.1**, uri **0.13.1**. Those baseline versions were read from installed gem specifications, not assumed from the old lockfile. Other deployments may differ.

The [complete lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff) records the exact resolver result. Resolution is not runtime compatibility; see M1.

## High-risk changes with the existing defaults

### H1. Failed CSV imports can commit a partial batch

**History:** Rails 7.1 reintroduced commit on non-local transaction return behind configuration; 7.2 removed the rollback behavior ([7.2 Active Record changelog][ar72]). **Code:** Comparing the released transaction managers confirms that 7.0 rolls back a written transaction exited by `return`; 8.1 commits unless there is an exception or an aborting thread ([old implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb), [new implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L642-L680)). Keeping 7.0 defaults no longer preserves rollback-on-return.

**Application:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and earlier rows, then `return false`s on an invalid row. **Inference:** A valid first row followed by an invalid second row will now leave the import, first note, and associated records committed while the response says nothing was saved. Retrying can duplicate notes. Plan explicit rollback semantics, not merely a syntax update. The existing [invalid-row request test](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L73) captures this contract, but was not run.

### H2. CSV receipts silently lose citation DOIs

**History:** 7.2 removes the special mapping from `read_attribute(:id)` to a custom primary key ([changelog][ar72]). **Code:** `[]` delegates to `read_attribute`; the old `name = @primary_key if name == "id"` line is gone ([new reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb#L29-L34)). Unknown `id` reads return nil rather than the DOI.

**Application:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L70) emits `citation[:id]`, while [citations have primary key `doi`](file:///home/user/workspace/repo/db/schema.rb#L55-L62). **Inference:** Nonempty DOI columns become empty CSV fields without a useful failure. Use the actual DOI attribute or primary-key `id` method deliberately. This is high despite a small fix because exported data changes silently.

### H3. Import-preview annotations disappear after key normalization

**History:** Rails 8.0 fixes `HashWithIndifferentAccess#stringify_keys` to stringify all keys, not only symbols ([changelog][as80]). **Code:** 7.0's implementation simply duplicated the hash; 8.1 inherits actual stringification.

**Application:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) uses integer source-line keys; the [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) stringifies them and then looks up the original integer. **Inference:** Key `2` becomes `"2"`, so annotation text is silently omitted from the preview. This does not remove the annotation stored on the eventual note. Normalize both sides consistently; include multiline CSV rows in later verification.

### H4. Digests change from UTC days to the reader's local day

**History:** Rails 7.2 fixes preservation of `TimeWithZone` argument zones ([Active Job changelog][aj72]). **Code:** 7.0 serializes the offset and deserializes in the worker's zone; 8.1 also serializes the named zone and restores it ([serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb)). Old payloads without the zone retain the fallback behavior.

**Application:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC-date** Redis key but queues a reader-zone timestamp. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses that timestamp's `to_date` and `all_day` for subject and query.

**Inference:** A request at 2026-10-05 03:30 UTC from an Eastern-time reader becomes an October 4 local-day digest rather than the expected October 5 UTC digest. Deduplication still follows October 5 UTC. Old/new producers and workers can disagree about content during deployment. Decide the product's day boundary and make it explicit; the [existing digest test](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L37) provides an asymmetric near-midnight case.

### H5. BigDecimal job payloads are incompatible with old workers

**History:** 7.1 introduces BigDecimalSerializer with a rollout warning; 7.2 removes primitive serialization and 8.0 removes its compatibility switch ([7.1][aj71], [7.2][aj72], [8.0][aj80]). **Code:** New jobs contain an `_aj_serialized` BigDecimalSerializer envelope; Rails 7.0 has no corresponding serializer. Existing primitive JSON decimal strings remain strings when read by the new worker.

**Application:** [User#reading_completion and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) pass a BigDecimal through Sidekiq JSON to [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L7). **Inference:** Old workers cannot deserialize newly produced jobs, including jobs left after a rollback. New workers receive BigDecimal rather than String for newly generated jobs; the mailer's `BigDecimal(...)` normalization already accommodates both. Drain/isolate old workers or stage a compatible reader before changing producers. Retaining 7.0 framework defaults does not solve this.

### H6. Reminder postponement previews change across daylight-saving transitions

**History:** Rails 8.0 introduces named-zone-preserving `to_time`; 8.1 removes the old conversion paths ([8.0 changelog][as80], [8.1 changelog][as81]). **Code:** In 8.1 `TimeWithZone#to_time` unconditionally calls `getlocal(time_zone)`; the legacy configuration accessor no longer changes that implementation ([source](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L499)).

**Application:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) adds 86,400 seconds after converting to Time, and [the reminder partial](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays it. **Inference:** Across the 2026 Eastern fall-back, 09:00 −04:00 plus 24 elapsed hours displays 08:00 −05:00 rather than fixed-offset 09:00 −04:00. The instant and queued epoch remain the same: this is a timezone/display change, **not** a claim that reminders shift an hour in absolute time. Confirm the desired preview contract on both DST boundaries.

### H7. Negative fragment-cache TTLs no longer mean immediate expiration

**History:** Rails 7.1 adds invalid-expiration handling ([changelog][as71]). **Code:** 8.1 deletes a negative `expires_in`, then raises if configured or reports/logs and continues otherwise ([implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L899-L946)). With the app's retained 7.0 defaults, it takes the non-raising path.

**Application:** [Export availability fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) computes `expires_in: export.expires_at - Time.current`, including after the deadline. **Inference:** An expired entry can be stored with no TTL instead of immediately expiring, with extra error logging; subsequent rendering can keep that fragment until eviction/key change. Usually it contains “Expired,” so this is not by itself an authorization bypass. [Download authorization and expiry](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) are independently checked. With 7.1+ defaults, this same input instead raises; choose how expired indicators should be cached.

### H8. Rich-text attachment HTML is sanitized before being returned to the editor

**History:** The 7.1 patch/7.2 history adds sanitization of ContentAttachment HTML in Trix edit views and stripping empty `content` attributes ([7.1 patch history](https://github.com/rails/rails/blob/v7.1.5.2/actiontext/CHANGELOG.md), [7.2 history](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md)). **Code:** Unlike 7.0.8.7, 8.1 sanitizes attachment `content` within `Content#render_attachments`, also used by `to_trix_html` ([source](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/content.rb#L98-L136)). This is separate from the opt-in HTML5 sanitizer.

**Application:** [Imported `body_html`](file:///home/user/workspace/repo/app/models/import.rb#L100-L108), [rich-text editor](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L48-L51), [rendered note](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L31) and [Markdown conversion](file:///home/user/workspace/repo/app/models/export.rb#L77-L81) all traverse Action Text content.

**Inference:** Existing content attachments containing disallowed markup can render/export differently and lose that markup permanently when an edited form is saved. This is a security improvement to keep, not bypass; review representative stored HTML and safe custom excerpts. No database corpus was read, so presence of affected attachment markup is unverified. Ordinary blob attachments without a `content` attribute do not establish this failure case.

### H9. More characters in attachment filenames become dashes

**History:** Active Storage 8.0 expands filename sanitization ([changelog](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md)). **Code:** `Filename#sanitized` adds `<`, `>`, `?`, `*`, and `"` to replaced characters ([source](https://github.com/rails/rails/blob/v8.1.0/activestorage/app/models/active_storage/filename.rb#L59-L65)).

**Application:** [Blob labels, image alt text, and download links](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L2-L12) use `blob.filename`. **Inference:** A stored upload named `chapter?.txt` is presented/downloaded as `chapter-.txt`; database blob keys are not rewritten. High under the requested data-format criterion, although the practical impact is limited to filenames containing those characters. Notebook-generated slug filenames are less exposed.

### H10. Local signing-key lookup changes can invalidate sessions and embedded attachments

**History:** Rails 7.1 renames the local secret file from `tmp/development_secret.txt` to `tmp/local_secret.txt` ([upgrade guide](https://guides.rubyonrails.org/v8.1/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed)); 8.1 also honors ENV/credentials keys locally when present ([railties changelog](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md)).

**Application:** [Session authentication](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17) and persisted [rich-text attachments](file:///home/user/workspace/repo/app/models/note.rb#L8) depend on signatures. **Inference:** If local development currently relies on the old generated key and it is not preserved, sessions and signed attachment references stop validating. This file rename is a **development/test** issue, not evidence of production key rotation. Secret values were not inspected; confirm key provenance rather than generating new keys casually.

## Medium-risk changes

### M1. The resolved JSON 3.1.0 introduces a Rails 8.1.0 decoder incompatibility

**History:** JSON 3.0 changes options to keyword arguments, removes old APIs, and rejects duplicate keys/comments by default ([JSON 3.1.0 changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md)). **Code:** Rails 8.1.0 calls `::JSON.parse(json, options)` with a second positional argument ([decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb#L24-L25)); the resolved JSON version defines `parse(source, on_load: nil, object_class: nil, array_class: nil, **options)` ([JSON source](https://github.com/ruby/json/blob/v3.1.0/lib/json/common.rb#L291-L297)). That call shape raises ArgumentError on Ruby 3.3.

**Application:** [Note tags/settings](file:///home/user/workspace/repo/app/models/note.rb#L12-L14) are decoded through Active Record's JSON coder/type, and [provider responses](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) use JSON.parse directly. **Inference:** Rails JSON decoding fails, including note loading; direct provider parsing additionally changes acceptance of duplicate keys/comments. Decide whether to constrain JSON to a compatible 2.x release or choose a Rails version with compatible decoding, then re-resolve and review that result. This is a source-verified incompatible call signature, **not an executed boot failure**. It is specific to the actual current resolver result, not an unavoidable dependency of every Rails 8.1 installation.

### M2. `Rails.application.secrets` is removed

**History:** Deprecated in 7.1, removed in 7.2 ([railties changelog](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md)). **Code:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L14) reads it, and [provider tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122) replace entries through it.

**Before → after:** `config/secrets.yml` supplies provider settings; the accessor no longer exists. **Inference:** Enrichment fails before its HTTP request, and its ordinary provider-error handler does not catch that NoMethodError. Choose credentials, explicit ENV configuration, or `config_for` with an intentional configuration contract; update tests with that decision. Do not confuse migration of provider credentials with rotation of the session-signing key.

### M3. Built-in Sidekiq adapter is deprecated for removal in Rails 8.2

**History / Code:** 8.1's adapter remains present, but explicitly says it will be removed in **8.2**, recommending Sidekiq **>= 7.3.3** ([changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L40-L46)).

**Application:** [Configured adapter](file:///home/user/workspace/repo/config/application.rb#L21-L23), [pinned Sidekiq/Redis](file:///home/user/workspace/repo/Gemfile#L33-L36), plus the native [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L3-L10). **Inference:** This is not a resolver blocker or proof of failure in 8.1. It is medium because the next release removes the adapter; choose a separately reviewed Sidekiq/Redis upgrade or another backend. Do not silently loosen those pins as part of the Rails-only assessment.

### M4. Provisional compatibility risk: Trix packaging changes, but the application continues loading its old editor

**History:** Rails moved bundled Trix from 1.x to 2.x and 8.1 extracts it to `action_text-trix`, permitting independent updates ([8.1 Action Text changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md#L53-L57)). The actual resolution selects **2.1.19**. **Code:** Its engine adds Trix assets, but the application's [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14) explicitly loads `trix-1.3.5.js`, while [the import map](file:///home/user/workspace/repo/config/importmap.rb#L8) loads the upgraded Action Text integration.

**Before → after:** Matching-era integration plus a local Trix fix becomes new integration/assets paired with the old explicitly selected JavaScript. **Inference / uncertainty:** The upgrade does **not** automatically replace the vendored script or deliver the newer editor's security fixes. I have not established that this combination necessarily raises. Medium is a conservative compatibility/maintenance decision: choose whether to migrate the editor and test saved links, attachments, direct uploads, and `details` excerpts, rather than assuming the new gem changed the active browser code. Loading both editors is not a safe default solution.

## Relevant changes only if newer framework defaults are adopted

These are **not baseline failures** with the existing `load_defaults 7.0`. Source of gating is [Rails 8.1's `load_defaults`](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L270-L382).

- **Medium, 7.1+: notebook serialization needs an explicit coder.** Previously [Notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) implicitly uses YAML; new defaults set `default_column_serializer = nil`, so coder-less `serialize` raises. Decide to preserve YAML explicitly or migrate stored data; blindly selecting JSON cannot read existing YAML. [History][ar71]; **Code + inference**. With 7.0 defaults, implicit YAML remains.
- **Medium, 7.1+: assigning readonly slug raises.** [Notebook's readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L8) is [permitted and resubmitted by updates](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L25-L40). Previously assignment was accepted in memory and omitted from UPDATE; `raise_on_assign_to_attr_readonly = true` raises even for reassignment of the existing value. Decide to stop assigning it or preserve old behavior. [History][ar71]; **Code + inference**.
- **Low/mechanical, 7.2+: raw PostgreSQL dates decode to Date objects.** [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) passes raw dates to `Date.iso8601`; opting into `postgresql_adapter_decode_dates` makes that a type error. Remove redundant parsing or deliberately retain text decoding. [History][ar72]; **Code** confirms adapter default is false outside the newer framework defaults.
- **High, 7.1+: HTML5 sanitization changes parsed output.** [Rich-text rendering](file:///home/user/workspace/repo/app/views/notes/show.html.erb#L31), [custom tags](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), and imported HTML can be normalized/sanitized differently from HTML4, especially malformed HTML and nesting; editor resaves can persist changes. [Action Text history](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md); **Code + inference**, no affected stored document verified.
- **High, 7.1+: cache/message formats require a rollout decision.** New defaults write cache format 7.1 and JSON-based signed messages/metadata instead of the retained 7.0/Marshal formats. Old processes need not understand newly written formats; shared fragment caches and Active Storage signed links are the application surfaces ([export cache](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26), [blob links](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L4-L11)). Keep old writers until compatible readers are deployed or plan invalidation. [History][as71]; **Code + inference**. Session cookies already use JSON under 7.0 defaults: this is not a claim that all cookies switch from Marshal now.
- **High, 8.0+: conditional-download freshness changes.** [ExportDownloadsController](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L13) supplies ETag and Last-Modified. Previously both request validators had to match; `strict_freshness = true` gives If-None-Match precedence, so matching ETag plus an older If-Modified-Since can change 200 to 304. Ownership/expiry checks still precede it. [History](https://github.com/rails/rails/blob/v8.0.0/actionpack/CHANGELOG.md), [implementation](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb#L45-L64); **Code + inference**.

## Low-risk, direct replacements

Each is classified low for a mechanical correction, not because leaving it unfixed is harmless.

- **Code + history:** [Note enum](file:///home/user/workspace/repo/app/models/note.rb#L10): keyword definition removed in 8.0; use `enum :status, { draft: 0, ready: 1 }, prefix: true`, keeping stored integers and scope names ([history](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md)).
- **Code + history:** [Note tags](file:///home/user/workspace/repo/app/models/note.rb#L12): positional coder removed in 7.2; `serialize :tags, coder: JSON` preserves intent and existing JSON data ([history][ar72]).
- **Code + history:** [Highlight alias](file:///home/user/workspace/repo/app/models/note.rb#L13-L14): 7.2 rejects `alias_attribute` targets that are not database attributes; `color` is a JSONB store accessor, not a column—explicit reader/writer delegation preserves the form contract ([history][ar72], [implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb#L87-L95)).
- **Code + history:** [Enrichment retry](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7): removed `:exponentially_longer` becomes `:polynomially_longer`; this renames the same backoff, not a new timing policy ([history][aj72]).
- **Code + history:** [Reminder scheduling](file:///home/user/workspace/repo/app/models/note.rb#L61): numeric `wait_until` now reaches a Time-only `scheduled_at`; convert epoch seconds to `Time.at(...)`, preserving the instant ([history][aj72], [source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L183-L190)).
- **Code + history:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L36-L42): removal of Active Support's nonnumeric `sum` makes strings fail with Ruby's zero identity; `fragments.join` directly expresses the required concatenation ([history][as71]).
- **Code + history:** [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3): `allowed_tags` now defaults to nil, so `+=` fails; build the override from the sanitizer defaults **plus Action Text's attachment/figure/figcaption tags** and the two custom tags, not just `details`/`summary` ([upstream commit](https://github.com/rails/rails/commit/e8137c527dd6bd43f695b472f440cab7466243a6)).
- **Code + history:** [Two-path route](file:///home/user/workspace/repo/config/routes.rb#L17-L18): 8.1 removes multiple path arguments; split `/notes` and `/journal` into separate `get` declarations, preserving the alias ([history](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107-L109)).
- **Code + history:** [Test `show_exceptions = false`](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31): change to `:none`; 7.2 removes booleans, and 8.1's wrapper falls through to rendering exceptions for false rather than propagating them ([history](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md), [source](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb#L185-L197)).
- **Code + history:** [Schema dump](file:///home/user/workspace/repo/db/schema.rb#L13-L24): 8.1 alphabetizes dumped columns; expect review noise, not database column reordering from the gem change itself ([PR #53281](https://github.com/rails/rails/pull/53281)).

## Changes screened out or not established as application regressions

- **Active Record MySQL, Trilogy, SQLite, composite keys, shards/replicas, encryption:** no matching adapter, configuration, `encrypts`, composite key, or multi-database usage found; PostgreSQL/string-primary-key findings are covered above (**Code**).
- **`find_or_create_by` race handling:** app uses `find_or_initialize_by` for citations, so the 7.1 retry-on-uniqueness change does not solve its concurrent-new-DOI conflict ([calls](file:///home/user/workspace/repo/app/models/import.rb#L100-L105); **History + code**).
- **Job deferral after transaction commit:** 7.2 history advertises automatic deferral, but the actual 8.1 source defaults `enqueue_after_transaction_commit` to false and the app does not enable it; do not infer changed enqueue timing from that older changelog alone ([source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L49-L53); **Code**).
- **New callbacks/association ordering, batching APIs, query-log tags:** no application dependency on reordered transaction callbacks/custom batch cursors/query-log configuration found; do not attribute a changed query result without a matching call (**Code; bounded review**).
- **Action Text embeds before-validation callback:** code moved association assignment from before-save to before-validation, but the app's size validation reads `body.attachables`, not `embeds`; no size-limit bypass established. Review upload/validation lifecycle later, without claiming it is broken ([validation](file:///home/user/workspace/repo/app/models/note.rb#L94-L98), [history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md#L59); **History + code**).
- **Active Storage cloud services, Azure removal, variants/video preprocessing and proxy streaming:** configured Disk plus original-blob rendering and application-controlled export downloads do not use those paths; no image-processing gem (**Code**).
- **Action Cable / Action Mailbox:** framework dependencies are present, but no application broadcast/subscription or inbound-mail feature found; outbound digest/reminder mail is not IMAP (**Code**).
- **Action Mailer preview-path/removal and new bulk-delivery APIs:** app has no custom preview path or bulk `deliver_all_later`; existing mail jobs call `deliver_now` (**Code**).
- **Active Model password byte-length/reset-token changes:** `has_secure_password` is used, but this app's request routes expose sign-in/time-zone settings, not password creation/reset/change; no new failure demonstrated for authenticating existing digests. Revisit if provisioning/password mutation is added ([account params](file:///home/user/workspace/repo/app/controllers/accounts_controller.rb#L14-L16); **History + code**).
- **Redis/MemCache cache pooling, Redis UNLINK, RedisCacheStore TTL fixes:** Redis is used directly and by Sidekiq, not as Rails.cache; current stores are File/Memory/Null (**Code**).
- **HTML JSON response escaping, browser restrictions, rate limiting, authentication generator, CSP changes, Params#expect:** not automatically adopted by existing HTML controllers/configuration; `require`/`permit` remains supported (**Code**).
- **Leading-bracket and semicolon query parsing:** generated forms and links use normal parameter names and `&`; no dependent external client identified. Manually supplied legacy URLs could differ, but no application caller established (**History + code + uncertainty**).
- **Solid Queue/Cache/Cable, Propshaft, Kamal, generated PWA/CI/Docker files:** new-application/generator choices, not dependencies or infrastructure installed by this lockfile change (**History + resolver**).
- **net-imap 0.6.8:** timeout/parser/SequenceSet fixes are real ([release](https://github.com/ruby/net-imap/releases/tag/v0.6.8)), but no inbound IMAP client is used (**History + code**).
- **rack-session 1.0.2 / rackup 1.0.1 / WEBrick 1.9.2:** compatibility packages retain Rack 2; rack-session's entrypoint is a no-op and session implementations remain in Rack. Puma remains configured; no switch to Rack 3 or WEBrick demonstrated (**Dependency source + resolver**).
- **useragent 0.16.11:** introduced for framework browser checks; the application never opts into `allow_browser` (**Code**).
- **securerandom 0.4.1:** compared with Ruby 3.3.6's 0.3.1; the added compatibility `alphanumeric` method is conditional on Ruby < 3.3, so no application token-format change established (**Dependency source**).
- **uri 1.1.2:** default parser constants/build paths change, but this app's `URI.parse` already used RFC3986 in 0.13.1; source comparison did not establish a changed result for its HTTP(S) provider validation. Do not claim a wholesale RFC2396→RFC3986 switch for that call ([provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59); **Dependency source**).
- **bigdecimal 4.1.3:** arithmetic implementation and precision fixes warrant attention, but no changed four-decimal completion result was established for this app's integer-count division. The verified high risk is the **Active Job serialization** change above, not an asserted arithmetic failure ([division fix PR](https://github.com/ruby/bigdecimal/pull/330), [4.1.0 release](https://github.com/ruby/bigdecimal/releases/tag/v4.1.0); **History + code + uncertainty**).
- **drb 2.2.3:** changed internal object-reference tracking affects Rails parallel-test transport; [parallel tests are enabled](file:///home/user/workspace/repo/test/test_helper.rb#L7-L9), but no custom DRb protocol/object-ID assumptions or application production DRb service found. Compatibility remains unexecuted (**Dependency source + code**).
- **method_source removal:** no direct application use found; railties changes its console integration instead (**Code + resolver**).

## Confidence and next decision

This is a **read-only, source-based assessment**, not an exhaustive compatibility certification. I read configuration before tracing changelog changes into application calls; consulted 7.1/7.2/8.0/8.1 histories and patch histories; compared the released 7.0.8.7 and 8.1.0 source trees and inspected targeted implementation differences and newly resolved dependencies. Older release-branch entries were checked against target source rather than assumed present merely because of their release number. No application data, secret values, server, migrations, or tests were executed; no new gems were installed.

Recommended decision: retain 7.0 defaults for the first migration phase; resolve the JSON compatibility choice; address mechanical removals and provider configuration; then explicitly preserve or change import atomicity and UTC digest semantics. Plan producer/worker ordering before any deployment. Only after that should newer defaults and the editor migration be adopted separately. The existing import/digest/reminder/export request tests are useful later checks, but passing them would not by itself establish rolling-deploy compatibility.

[ar71]: https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md
[ar72]: https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md
[aj71]: https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md
[aj72]: https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md
[aj80]: https://github.com/rails/rails/blob/v8.0.0/activejob/CHANGELOG.md
[as71]: https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md
[as80]: https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md
[as81]: https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md

---

**Application files and dependencies remain unchanged.** The required review is complete; implementation awaits your decision.