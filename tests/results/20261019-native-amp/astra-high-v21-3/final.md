# Rails 7.0.8.7 → 8.1.0: application-specific risk report

## 1. Application facts and scope

**Assessment:** high-risk upgrade, despite a successful dependency resolution. Several application paths depend on behavior that Rails removed or corrected. Fixing boot errors alone will not make this upgrade safe.

Evidence labels used throughout:
- **[Code]**: application configuration, application code, or released upstream source read and compared.
- **[History]**: upstream changelog, release notes, or commit/PR.
- **[Resolution]**: Bundler resolution in a disposable copy, not an installed or executed upgrade.
- **[Inference]**: predicted application consequence from those sources; not a runtime test result.

### Configuration assumptions the developer should check

- **[Code]** Ruby is pinned to **3.3.6**, Rails to **7.0.8.7**; Ruby satisfies Rails 8.1's ≥3.2 requirement. This report assumes **`config.load_defaults 7.0` remains unchanged**. Sources: [Gemfile](file:///home/user/workspace/repo/Gemfile#L4-L8), [application configuration](file:///home/user/workspace/repo/config/application.rb#L3-L24), [Rails 8.1 gemspec](https://github.com/rails/rails/blob/v8.1.0/rails.gemspec).
- **[Code]** This is an HTML/ERB application with Sprockets, importmap, Turbo and Action Text, not a JSON-only API. The editor is explicitly **vendored Trix 1.3.5**, while its stylesheet comes from `require trix`: [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [stylesheet](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L7), [import map](file:///home/user/workspace/repo/config/importmap.rb#L3-L8).
- **[Code]** PostgreSQL, one database per environment, pg 1.6.0; ordinary integer IDs except citations' string DOI primary key. Tags are JSON in text, notebook preferences are YAML in text, and note settings use jsonb. Sources: [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L26), [schema](file:///home/user/workspace/repo/db/schema.rb#L55-L118), [Note](file:///home/user/workspace/repo/app/models/note.rb#L5-L19), [Notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19). The deployed PostgreSQL server version and actual stored data were not inspected.
- **[Code]** Active Job uses **Sidekiq 6.5.12 / redis 4.8.1** outside tests; exports are native Sidekiq jobs. Tests explicitly select the Active Job test adapter. No enqueue-after-commit override exists. Sources: [Gemfile](file:///home/user/workspace/repo/Gemfile#L34-L36), [application configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24), [test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L30-L40), [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L12), [ApplicationJob](file:///home/user/workspace/repo/app/jobs/application_job.rb#L1-L7).
- **[Code]** Production enables fragment caching and leaves the cache store at Rails' default FileStore; development uses MemoryStore only when caching is enabled, otherwise NullStore; tests use NullStore except an explicit cache test. Redis holds jobs and digest reservations, **not Rails.cache**. Sources: [production](file:///home/user/workspace/repo/config/environments/production.rb#L15-L17), [development](file:///home/user/workspace/repo/config/environments/development.rb#L20-L34), [cache test](file:///home/user/workspace/repo/test/controllers/exports_controller_test.rb#L59-L91), [Rails default store](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L58).
- **[Code]** Active Storage uses local Disk; no image processor is installed and the blob partial serves originals. Rich text accepts editor content and imported HTML. Sources: [storage configuration](file:///home/user/workspace/repo/config/storage.yml#L1-L7), [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L15), [import construction](file:///home/user/workspace/repo/app/models/import.rb#L101-L108).
- **[Code]** Sessions store a user ID; reminder/digest mail is sent synchronously inside jobs. Development mail writes files; tests capture mail; production mail delivery/host are not explicitly configured. Sources: [authentication](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L18), [reminders](file:///home/user/workspace/repo/app/models/note.rb#L75-L83), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L1-L9), [development mail](file:///home/user/workspace/repo/config/environments/development.rb#L39-L45). Production secrets, credentials, queue contents and deployment topology remain unverified.

### What actually resolves

**[Resolution]** On 19 October 2026, I copied Gemfile/Gemfile.lock, changed only the copied Rails requirement to `8.1.0`, and ran `bundle lock --update rails` with Ruby 3.3.6/Bundler 2.5.22. It succeeded. [Complete lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

| Dependency | Current → resolved |
|---|---|
| rails and all 12 framework gems | 7.0.8.7 → 8.1.0 |
| net-imap | 0.6.7 → 0.6.8 |
| action_text-trix | newly locked at 2.1.19 |
| bigdecimal | newly locked at 4.1.3; current Ruby default is 3.1.5 |
| json | newly locked at 3.1.0; current Ruby default is 2.7.2 |
| drb | newly locked at 2.2.3; current Ruby default is 2.2.0 |
| securerandom | newly locked at 0.4.1; current Ruby default is 0.3.1 |
| uri | newly locked at 1.1.2; current Ruby default is 0.13.1 |
| rack-session / rackup | newly locked at 1.0.2 / 1.0.1 |
| useragent / webrick | newly locked at 0.16.11 / 1.9.2 |
| method_source | 1.1.0 removed |

**[Resolution + Code]** Rack **stays 2.2.24**, Puma **5.6.9**, Sidekiq **6.5.12**, Redis **4.8.1**, pg **1.6.0**, Pagy **8.6.3**, Faraday **1.10.4**. Other existing locked gem versions also stay unchanged. Rack-session/rackup 1.x are compatibility packages delegating to Rack 2, not a Rack 3 migration. Ruby-default versions above came from gem metadata, without loading the application. Another environment may have different previously activated standard-library versions.

**[Code + History]** Review covered released Rails endpoint source differences, the 7.1/7.2/8.0/8.1 component changelogs, intervening patch changelogs through 7.1.5.2/7.2.2.2/8.0.3, and relevant implementations/commits. Added/moved dependency releases were unpacked and compared, not installed. This is a targeted assessment, not an exhaustive security or compatibility certification. A fresh resolution can select newer transitive versions later.

## 2. High-risk changes

### H1. A failed CSV import can now commit its earlier rows

**Before → after [Code + History]:** Rails 7.0 rolls back a written transaction exited by a non-local `return`. Rails 7.2 removes that rollback behavior; 8.1 commits normal non-exception exits regardless of `load_defaults`.

**Application [Code]:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, then returns `false` from inside the transaction when a row cannot save. [ImportsController](file:///home/user/workspace/repo/app/controllers/imports_controller.rb#L9-L19) renders errors on that result.

**Consequence [Inference]:** valid first row + invalid second row can leave the import, first note, citation and rich text persisted while the page says nothing was saved. This is a concrete atomicity violation, not just callback ordering. Use an explicit rollback/exception strategy while preserving the false/error-rendering contract. The existing [invalid-import case](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L72) is the key review case.

Upstream: [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L371-L377), [8.1 transaction implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L643-L681).

### H2. CSV receipts silently lose citation DOIs

**Before → after [Code + History]:** `read_attribute(:id)`, also used by `record[:id]`, formerly redirected to a custom primary key. Since 7.2 it reads the literal `id` attribute. Citations have a `doi` column and no `id` column; the absent attribute resolves to nil.

**Application [Code]:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) writes `citation[:id]`; [citations schema](file:///home/user/workspace/repo/db/schema.rb#L55-L62) defines the custom primary key.

**Consequence [Inference]:** successful CSV downloads contain blank DOI cells, rather than raising a useful error. Read `citation.doi` or the primary-key-aware `citation.id`. The [receipt expectation](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L43-L45) documents the required output.

Upstream: [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L425-L427), [new attribute reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb#L29-L34).

### H3. Import-preview annotations disappear

**Before → after [Code + History]:** `HashWithIndifferentAccess#stringify_keys` previously duplicated the hash without converting integer keys. Rails 8.0 fixes it to stringify those keys too. Indifferent access still equates strings and symbols, not integers and numeric strings.

**Application [Code]:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) keys annotations by integer source line. The [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) stringifies those keys, then still looks up `annotations[row.line]`.

**Consequence [Inference]:** annotation text is omitted without an exception; the underlying import can still save it. Remove the unnecessary conversion or make producer and consumer agree. Include a quoted multiline CSV row when reviewing line-number handling.

Upstream: [8.0 changelog and before/after example](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L47).

### H4. Digest jobs change from UTC days to the reader's local day

**Before → after [Code + History]:** old Active Job serializes a TimeWithZone's instant but deserializes it in the worker/job timezone. New payloads additionally record the original timezone; the new deserializer restores it. Old payloads without the extra field retain the fallback behavior.

**Application [Code]:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC date** in Redis but sends a reader-local time. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) uses that argument's `to_date` and `all_day` directly.

**Consequence [Inference]:** a 03:30 UTC request on 5 October in Eastern time becomes a 4 October digest instead of 5 October, while the reservation remains for 5 October. Its note-selection window also changes. Old/new producers or old backlog can produce different content for the same UTC reservation. Explicitly choose UTC or local-day semantics and align reservation, subject and query. The existing [near-midnight digest case](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L37) covers this boundary.

Upstream: [timezone preservation entry](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [8.1 serializer with legacy fallback](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb#L8-L17). This change was also backported within 7.1; it is not gated by framework defaults.

### H5. BigDecimal job payloads are not readable by Rails 7.0 workers

**Before → after [Code + History]:** Rails 7.0 passes BigDecimal as a primitive; Sidekiq's JSON round trip returns a string. Rails 8.1 always uses a tagged `ActiveJob::Serializers::BigDecimalSerializer`, restoring a BigDecimal. The transitional 7.1 opt-in switch is gone.

**Application [Code]:** [reading_completion and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) put a BigDecimal in DigestJob. [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) already converts the argument with `BigDecimal(...)`, so the changed Ruby type alone need not break this mailer.

**Consequence [Inference]:** a new producer feeding an old worker fails deserialization because Rails 7.0 lacks that serializer. Old string payloads remain readable by new workers; compatibility is not symmetric. Coordinate producer/worker rollout, queued retries and rollback, or bridge the argument format before upgrading. This is high risk even though the failure raises, because it affects queued work across versions.

Upstream: [7.1 explanation explicitly warns about mixed deployments](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L157), [7.2 removes primitive serialization](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L63-L65), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

### H6. Reminder previews change offset across daylight-saving boundaries

**Before → after [Code + History]:** Rails 7.0 defaults make TimeWithZone#to_time preserve a fixed UTC offset. Rails **8.1 always preserves the full timezone**. This is unconditional: keeping 7.0 defaults or setting the former compatibility option does not restore the old conversion.

**Application [Code]:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) adds 86,400 seconds after `to_time`; the [preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) displays it, and [postponement](file:///home/user/workspace/repo/app/models/note.rb#L71-L73) stores its epoch.

**Consequence [Inference]:** after a 31 October 2026 09:00 Eastern reminder, the next-day preview changes from `09:00-04:00` to `08:00-05:00`. Both represent the same instant, so this does **not** by itself shift the queued reminder by an hour. It changes displayed wall time/offset and breaks the [explicit existing expectation](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L13-L21). Decide whether to adopt the corrected local display or deliberately preserve a fixed offset.

Upstream: [removal commit, including deletion of the compatibility branches](https://github.com/rails/rails/commit/c79dc282d687cff1c5dc81e19d27257dca5e6a80).

### H7. Negative cache expiry no longer creates an immediately expired entry

**Before → after [Code + History]:** 7.0 accepts negative `expires_in`. In 8.1, negative TTLs are removed from the options and reported/logged when `raise_on_invalid_cache_expiration_time` is false, as it is with this app's 7.0 defaults. With 7.1+ defaults, the same input raises instead.

**Application [Code]:** [export availability fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) computes `expires_in: export.expires_at - Time.current`, which is negative after expiration.

**Consequence [Inference]:** expired-state fragments can be stored without a TTL and errors logged repeatedly. This is a cache-lifetime change, **not an authorization bypass**: [download ownership/expiry checks](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) run independently on every request. Avoid a negative TTL, for example by not caching past-deadline entries. Adopting newer defaults without addressing this instead breaks the exports page.

Upstream: [7.1 expiry policy](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L869), [8.1 normalization and reporting](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L908-L944).

### H8. Database connection failures can now be retried transparently

**Before → after [Code + History]:** Rails adds safe mid-request reconnection, then retries for eligible Arel SELECTs, association loads and `exists?`; the adapter default allows one retry. PostgreSQL's disconnected `PG::UnableToSend` is also recognized as a connection failure. This does not mean arbitrary writes or dirty transactions are replayed.

**Application [Code]:** ordinary reads in [current_user](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L8), [notes listing](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L8-L18), and [export association loading](file:///home/user/workspace/repo/app/models/export.rb#L32-L33) use these paths; [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L22) has no retry overrides.

**Consequence [Inference]:** a transient disconnect can yield a successful later read rather than an immediate request/job failure, with different latency and possibly later committed data. Generally beneficial, but a high-rated connection-behavior change under the requested rubric. Review failover/timeouts; no concrete duplicate-write defect is established here.

Upstream: [7.1 reconnection policy](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L1636-L1648), [7.2 SELECT retries](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L281-L288), [8.1 association retries](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L582-L585), [retry implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract_adapter.rb#L1049-L1127).

### H9. Semicolon-separated filter URLs change meaning

**Before → after [Code + History]:** this app's Rack 2 parser splits query strings on `&` and `;`. Rails 8.1's own parser splits on `&` by default; this changes even though Rack itself is not upgraded.

**Application [Code]:** [note-list filters](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L10-L18) read `status`, `query`, notebook and pagination parameters.

**Consequence [Inference, conditional on incoming URL]:** `/notes?status=ready;query=Eliot` previously applied two filters; now `status` is `ready;query=Eliot`, which fails the allowed-status check, and `query` is absent. It can show the unfiltered authorized list, without an error. Generated forms use normal ampersands; no evidence establishes that users have semicolon bookmarks. Review external links if supported; the ownership scope remains intact.

Upstream: [8.1 removal and example](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L111-L127), [new parser](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/query_parser.rb#L7-L48).

### H10. Rich-text attachment interpretation changes; the pinned editor does not upgrade with it

**Before → after [Code + History]:** 7.0 ContentAttachment recognizes the special horizontal-rule content type. Later Action Text supports arbitrary HTML content attachments, includes `content` in the serialized attributes, and sanitizes that embedded content on render/edit. In 8.1 Trix assets move to the separate `action_text-trix` gem.

**Application [Code]:** [CSV import](file:///home/user/workspace/repo/app/models/import.rb#L101-L108) accepts body HTML; [note editing](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L47-L50) and [Markdown export](file:///home/user/workspace/repo/app/models/export.rb#L77-L81) round-trip/render it. The [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14) still loads Trix **1.3.5 JS**, while the [CSS include](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L6) will resolve the newly supplied stylesheet.

**Consequence [Inference]:** imported/stored content-attachment markup can render or export differently; editing can persist a changed representation. Actual stored examples were not inspected, and ordinary paragraph/blob content is not claimed broken. The resolved Trix 2.1.19 **JavaScript is not automatically used**, so neither its new behavior nor its security fixes can be credited to the running editor. Review imported attachments, existing links/images, edit/save and exports; explicitly decide the editor asset pairing rather than blindly replacing the vendor file.

Upstream: [7.1 content-attachment change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [7.2 edit-view sanitization](https://github.com/rails/rails/blob/v7.2.0/actiontext/CHANGELOG.md), [8.1 attachment implementation](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/attachables/content_attachment.rb), [8.1 packaging change](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md), [Trix 2.1.19 release](https://github.com/basecamp/trix/releases/tag/v2.1.19).

## 3. Medium-risk changes

### M1. Citation-provider settings no longer come from Rails.application.secrets

**Before → after [Code + History]:** Rails 7.0 reads `config/secrets.yml` through `Rails.application.secrets`; the API was deprecated in 7.1 and removed in 7.2.

**Application [Code]:** [Citation::Provider#initialize](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L14) reads the setting there; [provider tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122) also replace those settings through the removed API.

**Consequence [Inference]:** metadata enrichment raises rather than constructing its HTTP client. The ordinary failure rescue only handles provider-specific errors, so this can leave enrichment pending while Sidekiq retries. Choose how to retain environment-backed settings—explicit `config_for`/application config, environment access, or credentials—and preserve test overrides. This is not safely fixed by a blind rename to credentials.

Upstream: [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63).

### M2. The built-in Sidekiq adapter is deprecated for removal in Rails 8.2

**Before → after [History + Code]:** Rails 8.1 still ships its adapter but warns that 8.2 removes it; upstream directs users to Sidekiq ≥7.3.3's own adapter.

**Application [Code]:** [queue configuration](file:///home/user/workspace/repo/config/application.rb#L22-L24) uses `:sidekiq`, with [Sidekiq 6.5.12 pinned](file:///home/user/workspace/repo/Gemfile#L34-L36). The dependency solver does not upgrade it automatically.

**Consequence [Inference]:** not a demonstrated Rails 8.1 boot incompatibility, but an explicit next-release removal requiring a separate Sidekiq/Redis/Rack compatibility and deployment decision. Native exports and direct Redis calls also need review if that separate upgrade is undertaken; do not conflate that hypothetical dependency graph with the one resolved here.

Upstream: [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [adapter warning specifying 8.2](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L34-L39).

### M3. The newly resolved JSON 3 parser rejects formerly accepted provider responses

**Before → after [History + Code]:** compared with the current Ruby-default JSON 2.7.2, JSON 3.1.0 rejects duplicate object keys and JavaScript comments by default, tightens invalid escapes/surrogate handling, and rejects unknown options. Generation also rejects duplicate keys and non-ASCII binary strings.

**Application [Code]:** [Citation::Provider#metadata_from](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) calls `JSON.parse` and turns parser errors into enrichment failures. JSON also underlies tag serialization, jsonb, sessions and Sidekiq payloads; app-produced tags and native-export arguments are ordinary arrays/strings, not a demonstrated failing format.

**Consequence [Inference, conditional]:** a provider response with repeated `title` keys that previously used the last value now fails, rather than recording metadata. Decide whether strict rejection is the desired provider contract or whether a narrowly scoped compatibility option is required. No evidence shows that the provider currently emits such data. Review existing external payloads rather than relaxing JSON globally.

Upstream: [JSON 3.1.0 changelog, especially 3.0.0.rc1 and 2.17.0](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md), [parser options](https://github.com/ruby/json/blob/v3.1.0/lib/json.rb).

## 4. Low-risk changes: direct, mechanical fixes

Each line is a separate finding; these are still blockers where noted. Predicted failures are **[Inference]**, supported by the cited **[Code + History]**; none was executed.

- **Enum syntax:** [Note line 10](file:///home/user/workspace/repo/app/models/note.rb#L10) must become `enum :status, { draft: 0, ready: 1 }, prefix: true`; keyword-only definitions were [removed in 8.0](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md). Keep the numeric mapping and generated prefix.
- **Serializer arguments:** [Note line 12](file:///home/user/workspace/repo/app/models/note.rb#L12) must use `serialize :tags, coder: JSON`; the positional coder was [removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L423). Keep JSON rather than accidentally changing persisted data format.
- **Alias of a store accessor:** [Note lines 13–14](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) aliases `color`, which is a jsonb store accessor, not a column; [7.2 removes non-attribute aliases](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490-L492). Define/delegate both `highlight_color` and `highlight_color=` to the accessor instead; attribute generation otherwise raises.
- **Action Text allowlist initialization:** [initializer line 3](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) now adds to nil and raises at initialization; initialize from the sanitizer's effective default tags **including Action Text attachment/figure/figcaption tags**, then add details/summary. [Upstream commit](https://github.com/rails/rails/commit/e8137c527dd6bd43f695b472f440cab7466243a6). Keeping the HTML4 vendor alone does not fix this.
- **Multi-path route:** [routes line 18](file:///home/user/workspace/repo/config/routes.rb#L17-L19) must be split into separate `/notes` and `/journal` routes, preserving the canonical helper; multi-path declarations were [removed in 8.1](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107-L109).
- **Retry wait rename:** [CitationEnrichmentJob line 7](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) must use `:polynomially_longer`; `:exponentially_longer` was [removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51-L53). This preserves the existing delay formula; the old name fails when retry handling calculates the delay.
- **Numeric wait_until:** [Note line 61](file:///home/user/workspace/repo/app/models/note.rb#L56-L62) supplies an integer epoch; 8.1 retains it as `scheduled_at` and calls `.utc.iso8601` during serialization. Pass a Time such as `Time.at(reminder_epoch)` without changing the stored epoch. [History](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55-L57), [source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L117-L130).
- **String sum:** [Export#generate line 42](file:///home/user/workspace/repo/app/models/export.rb#L32-L42) calls `fragments.sum` with no identity; the [7.1 removal of Rails' Enumerable#sum override](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420-L422) exposes Ruby's numeric default and raises on strings. Use `fragments.join` or `sum("")`.
- **Test exceptions setting:** [test configuration line 31](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) must change `false` to `:none`; [boolean support was removed in 7.2](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md). In 8.1 false falls into the render-exceptions branch, breaking tests that expect raised authorization/not-found errors; this is test-environment-only here.
- **Schema dumps:** [schema.rb](file:///home/user/workspace/repo/db/schema.rb#L13-L25) will be rewritten with alphabetically ordered columns by the [8.1 dumper](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L689-L696); expect review noise, not a request to reorder physical columns or rewrite old migrations.

## 5. Reviewed changes not active here, or with no demonstrated application impact

These are scoped conclusions from configuration/source searches, not guarantees about uninspected production data. Each line states why the change was excluded.

- **New framework defaults overall [Code]:** only `load_defaults 7.0` runs; the [8.1 defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L214-L382) gates many changes below. Do not run an update task and silently adopt them as part of this assessment.
- **PostgreSQL raw date decoding [Code + History]:** [Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) would reject a Date passed to `Date.iso8601`, but [`decode_dates` remains false](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb#L125-L132) with 7.0 defaults; adopting 7.2+ defaults needs a separate adjustment.
- **Implicit YAML serializer removal [Code]:** [Notebook#preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) keeps YAML because the [base default remains YAMLColumn](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb#L20); 7.1+ defaults set the default coder to nil. If later adopting those defaults, explicitly retain YAML or plan a data migration—do not switch existing YAML text blindly to JSON.
- **Readonly assignment raising [Code]:** [Notebook's readonly slug](file:///home/user/workspace/repo/app/models/notebook.rb#L8) is resubmitted by [settings updates](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L40); `raise_on_assign_to_attr_readonly` is not enabled by 7.0 defaults. With 7.1+ defaults, even assigning the same slug to a persisted record raises; handle that separately.
- **Automatic enqueue-after-commit [Code, contradicts a broad reading of the 7.2 changelog]:** final 8.1 [`enqueue_after_transaction_commit` defaults to false](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L40-L53); this app does not enable it. [Reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68) and [citation](file:///home/user/workspace/repo/app/models/citation.rb#L14-L23) enqueue-under-lock semantics therefore do not automatically change. Enabling it later would change how Redis failure interacts with committed state.
- **HTTP validator precedence [Code]:** [export downloads](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L15) use ETag and Last-Modified; `strict_freshness` remains false with 7.0 defaults, so both supplied validators still matter. The new request Cache-Control parser is an accessor, not automatic enforcement at this call site.
- **HTML5 sanitizer selection [Code]:** 7.0 defaults retain HTML4 for Action View/Action Text; this is distinct from the unconditional allowlist and content-attachment changes above. Adopting HTML5 later needs stored-HTML review.
- **Cache format / message serializer / metadata format [Code]:** 7.0 cache format and older message defaults remain selected; no automatic 7.1-format migration is established. The cache 6.1 removal does not apply to this app's selected 7.0 format.
- **RedisCacheStore/MemCacheStore pooling and counter fixes [Code]:** neither store is configured; direct `Sidekiq.redis` calls are not Rails cache calls.
- **MySQL, Trilogy, SQLite, multiple databases, shards, composite primary keys and AR encryption [Code]:** no corresponding adapter/configuration/schema/model use; citation's custom single-column key is addressed separately above.
- **New PostgreSQL constraint/enum/partition/vector-like type features [Code]:** schema has ordinary strings, integers, timestamps, text/jsonb and foreign keys, not those specialized features; no affected constraint-management calls were found.
- **New DB pool controls [History + Code]:** [8.1 says no default behavior change](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md#L136-L142); existing `pool:` remains accepted. Do not infer a required migration to `max_connections` or a changed pool size.
- **After-commit ordering/freshest-instance defaults [Code]:** 7.1 settings are not enabled; no application-defined after_commit callbacks were found. Framework attachment callbacks exist but do not justify claiming an application ordering regression.
- **Action Text embeds before_validation [Code + History]:** the callback moves earlier, but [size validation](file:///home/user/workspace/repo/app/models/note.rb#L95-L97) already reads `body.attachables`, not `embeds`; no specific broken size-limit behavior is demonstrated. Saving invalid and valid attachments remains a useful later review boundary.
- **Active Storage variants/preprocessing/cloud services/Azure removal [Code]:** Disk originals only; no image processor, preview transformation or cloud adapter is configured. Proxy-cache changes do not govern the application's `send_data` export download.
- **Active Storage blob attachment autosave removal [Code]:** [export generation](file:///home/user/workspace/repo/app/models/export.rb#L66-L74) attaches through the owner and does not save an attachment by saving its blob; no direct reliance on the removed behavior found.
- **Action Mailbox and net-imap 0.6.7 → 0.6.8 [Code]:** no inbound mailbox classes or IMAP client calls; examined net-imap changes concern IMAP parsing/sequence sets/config internals, not the file/test mail delivery used here.
- **Action Cable [Code]:** generated base classes and adapter config exist, but no application subscriptions/broadcasts; reconnect, ping and stream behavior changes have no identified feature consumer.
- **Action Mailer new callbacks/bulk enqueue/previews [Code]:** existing mailers use `deliver_now`, no delivery callbacks or preview customizations; the actual digest argument change is covered above.
- **Active Model password changes [Code + History]:** `has_secure_password` gains reset tokens, byte-length validation and stricter blank confirmation handling, but [account params](file:///home/user/workspace/repo/app/controllers/accounts_controller.rb#L13-L15) accept only time_zone and routes expose no registration/password-edit/reset flow. Existing authentication is not shown to fail; model/seed callers creating unusual passwords should be checked if present outside this repository.
- **New authentication generator, rate limiting, allow_browser, CSP/Permissions-Policy options [Code]:** opt-in APIs/generator output are unused; the security-policy initializers are commented. Installing Rails does not add these protections.
- **Solid Queue/Cache/Cable, Propshaft, Kamal, Docker/PWA and new CI defaults [Code]:** new-app scaffolding does not replace this app's explicitly retained gems/configuration.
- **New form helper names [Code]:** `rich_text_area`, `text_area` and checkbox aliases still exist; renaming every existing helper is not required.
- **JSON rendering escape defaults [Code]:** newer escaping defaults are gated, and no application JSON-rendering endpoint was found; JSON parsing at the provider and internal serialization remain in scope above.
- **URI 0.13.1 → 1.1.2 [Code]:** parser/default-constant, credential mutation and merge internals change, but [provider validation](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) uses URI.parse, which already used RFC3986 in the older version. No credential-mutation/custom-parser use or concrete changed accepted provider URL was established; this is not a verified URL regression.
- **BigDecimal 3.1.5 → 4.1.3 arithmetic [History + Code]:** division/rounding internals change, but [completion](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) divides nonnegative integer counts and rounds to four places; no changed application result was established. Removed `precs`, changed `divmod`, BigMath and precision-mode APIs are unused. [Changelog](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md), [division-rounding PR](https://github.com/ruby/bigdecimal/pull/330). This does not remove the separate Active Job payload risk.
- **DRb 2.2.0 → 2.2.3 [Code]:** object-ID tracking changes affect Rails' parallel test machinery indirectly; [test_helper](file:///home/user/workspace/repo/test/test_helper.rb#L7-L12) uses framework-managed workers, no custom DRb protocol. No specific incompatibility found, not runtime-verified.
- **SecureRandom 0.3.1 → 0.4.1 [Code]:** the additional Ruby-3.2 compatibility branch is inactive on Ruby 3.3.6; no app-specific token API incompatibility found.
- **Rack-session/rackup, WEBrick and useragent additions; method_source removal [Code + Resolution]:** Rack 2 shims preserve the chosen Rack stack; Puma, not WEBrick, serves this app; allow_browser/useragent is unused; no method_source consumer in application code. These are dependency changes, not demonstrated feature regressions.

## Review boundary

**[Inference]** Prioritize import atomicity, digest day/payload compatibility and rich-text round trips before rollout. Mechanical failures will otherwise mask those subtler differences. Existing tests provide useful cases but do not replace review of mixed-version workers, production cached fragments, stored HTML and actual provider responses.

**Work performed:** read-only application analysis, downloaded source/release comparisons and temporary lockfile resolution. **Not performed:** installing upgraded gems, booting/running the app, running its tests, editing its code/configuration/lockfile, migrations, commits, pushes or deployment. The report and lockfile diff are local review artifacts only.