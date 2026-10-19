# Rails 7.0.8.7 → 8.1.0: Margin Notes upgrade-risk report

## Application facts the ratings depend on

**Scope:** change only the Rails requirement; retain `config.load_defaults 7.0`. Ratings below are for that upgrade, not for adopting Rails 8.1 defaults. The repository's current code remains unchanged.

Evidence labels: **[C]** upstream changelog/release history; **[S]** application/framework/dependency source read; **[R]** copied-bundle resolution; **[I]** inferred application consequence, not an executed result. High means silent behavior, stored-data or mixed-version queue risk; medium means a decision-bearing incompatibility or next-release removal; low means a mechanical correction. Confidence/conditions are stated separately from severity.

- **[S] Runtime:** Ruby **3.3.6**, Rails **7.0.8.7**, all Rails frameworks loaded, and **7.0 defaults**: [Gemfile:4–8](file:///home/user/workspace/repo/Gemfile#L4-L8), [application.rb:3–24](file:///home/user/workspace/repo/config/application.rb#L3-L24). Ruby satisfies [Rails 8.1's ≥3.2 requirement](https://github.com/rails/rails/blob/v8.1.0/railties/railties.gemspec#L12).
- **[S] Database:** one PostgreSQL database per environment, ordinarily a pool of five; `pg` is pinned to 1.6.0: [database.yml:17–26](file:///home/user/workspace/repo/config/database.yml#L17-L26), [Gemfile:13–17](file:///home/user/workspace/repo/Gemfile#L13-L17). Production PostgreSQL version and infrastructure overrides were not checked. Citations have a string **`doi` primary key**, not an `id` column: [schema.rb:55–62](file:///home/user/workspace/repo/db/schema.rb#L55-L62).
- **[S] Jobs:** Active Job uses **Sidekiq 6.5.12 / Redis 4.8.1**, while exports are native Sidekiq jobs: [Gemfile:34–36](file:///home/user/workspace/repo/Gemfile#L34-L36), [application.rb:22–24](file:///home/user/workspace/repo/config/application.rb#L22-L24), [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L11). Tests explicitly use Active Job's test adapter: [test.rb:36–37](file:///home/user/workspace/repo/config/environments/test.rb#L36-L37). Deployment overlap and existing scheduled/retry queues are unknown.
- **[S] Rendering/storage:** this is an ERB HTML application with CSV receipts, Action Text notes and Disk-backed Active Storage, not a JSON-only service. The layout explicitly loads **vendored Trix 1.3.5**; only `@rails/actiontext` comes through the import map: [layout:9–14](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [importmap:8](file:///home/user/workspace/repo/config/importmap.rb#L8), [storage.yml:1–7](file:///home/user/workspace/repo/config/storage.yml#L1-L7). [The custom blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L15) renders originals, not image variants.
- **[S/I] Caching:** production enables fragment caching without overriding Rails' default FileStore; development switches between MemoryStore and NullStore; tests normally use NullStore: [production.rb:15–17,58–59](file:///home/user/workspace/repo/config/environments/production.rb#L15-L59), [development.rb:20–34](file:///home/user/workspace/repo/config/environments/development.rb#L20-L34), [test.rb:25–28](file:///home/user/workspace/repo/config/environments/test.rb#L25-L28), [framework FileStore default](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L58). Redis is for queues/reservations, not the configured application cache.
- **[S] Time/mail/authentication:** no application time-zone override, so the framework zone is UTC. Readers have their own zones; digest reservations deliberately use UTC dates: [User:27–41](file:///home/user/workspace/repo/app/models/user.rb#L27-L41). Reminders/digests send synchronously from jobs; development writes mail to files: [DigestJob:6–7](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L6-L7), [Note:75–82](file:///home/user/workspace/repo/app/models/note.rb#L75-L82), [development.rb:39–43](file:///home/user/workspace/repo/config/environments/development.rb#L39-L43). Authentication uses the default cookie session and a user ID: [ApplicationController:7–17](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17).
- **[S] External input/configuration:** citation enrichment reads settings through `Rails.application.secrets` and parses provider JSON: [Provider:13–14,42–59](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L59). Production settings, credentials and historical provider response bodies were not inspected.

### Dependency resolution, not installation

**[R]** A temporary copy of `Gemfile` and `Gemfile.lock`, changing only Rails to `8.1.0`, successfully resolved with `bundle lock --update rails` on **2026-10-19**, using Ruby 3.3.6 / Bundler 2.5.22. This is a present-day resolution, not the dependencies available when Rails 8.1.0 was released.

| Change | Resolved result |
| --- | --- |
| Rails and all 12 component gems | 7.0.8.7 → 8.1.0 |
| Existing dependency moved | `net-imap` 0.6.7 → 0.6.8 |
| Newly locked Ruby-distributed libraries | `bigdecimal` 4.1.3, `drb` 2.2.3, `json` 3.1.0, `securerandom` 0.4.1, `uri` 1.1.2 |
| Other additions | `action_text-trix` 2.1.19, `rack-session` 1.0.2, `rackup` 1.0.1, `useragent` 0.16.11, `webrick` 1.9.2 |
| Removed | `method_source` 1.1.0 |
| Important versions unchanged | Rack 2.2.24, Sidekiq 6.5.12, Redis 4.8.1, Puma 5.6.9, pg 1.6.0, Faraday 1.10.4; Nokogiri, rails-html-sanitizer, Sprockets/importmap/Turbo/Stimulus integrations also stay locked |

**[S]** For the libraries previously outside the lockfile, this Ruby's default versions supply the comparison baseline: BigDecimal 3.1.5, DRb 2.2.0, JSON 2.7.2, SecureRandom 0.3.1, URI 0.13.1. Another deployment's actual baseline could differ.

Evidence: [resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0/resolved.Gemfile.lock), [complete lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0/lockfile.diff), [resolution log](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0/resolution.log). A successful resolution does **not** establish runtime compatibility.

## High-risk changes

### H1. Invalid imports can commit an incomplete batch

**Before → after [C/S]:** Rails 7.0.8.7 rolls back a written transaction exited by a non-local `return`. Rails 7.1 introduced an opt-in change; 7.2 commits on normal non-local exits, and 8.0 removed the compatibility setting. At 8.1, retaining 7.0 defaults does not preserve rollback-on-return.

**Application [S]:** [Import#apply:50–60](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import and each note, then executes `return false unless row.note.save` inside the transaction. [The error view:15–18](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L15-L18) tells the reader nothing was saved.

**Consequence [I]:** a valid first row followed by an invalid row can persist the import, first note, citation and rich text while reporting failure. Retrying can duplicate the successful subset. This directly violates the all-or-nothing contract, with no transaction exception.

**Review next:** explicitly roll back on validation failure while preserving the method's false/error contract. The existing [invalid-second-row regression:48–73](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L48-L73) is the key acceptance case; no new hypothetical scenario is needed.

**Upstream:** [PR #48600](https://github.com/rails/rails/pull/48600); [7.0.8.7 transaction source](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L316-L350) versus [8.1 transaction source](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb#L643-L668); [8.0 removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L76).

### H2. Digest content changes from UTC days to reader-local days

**Before → after [C/S]:** the exact 7.0.8.7 `TimeWithZone` argument deserializer converts the timestamp into the worker's `Time.zone`. The newer serializer includes an IANA time-zone name and restores that zone. Old payloads without the new field still fall back to the worker zone.

**Application [S]:** [User#request_digest:34–41](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) queues a reader-zoned time but reserves the **UTC date** in Redis. [DigestMailer:7–12](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L12) uses the deserialized time's date and `all_day` for the subject and query.

**Consequence [I]:** new jobs cover a different time interval, and near midnight a different named date, from the reservation. The existing test requests at **2026-10-05 03:30 UTC / October 4, 23:30 Eastern**: old behavior produces an October 5 UTC digest; new serialization produces an October 4 Eastern digest. Notes near the day boundaries change. Old and new workers can interpret the new time payload differently, independently of the decimal incompatibility below.

**Review next:** decide whether digests remain UTC-based; if so normalize explicitly at the business boundary instead of depending on serialization. Inspect [the existing boundary test:5–37](file:///home/user/workspace/repo/test/controllers/digests_controller_test.rb#L5-L37).

**Upstream:** [PR #50240](https://github.com/rails/rails/pull/50240), [7.2 changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [old serializer](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/serializers/time_with_zone_serializer.rb#L5-L8), [new serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb#L8-L16). The endpoint source, not assumptions about backports, determines the comparison.

### H3. New digest jobs cannot be deserialized by Rails 7.0 workers

**Before → after [C/S]:** 7.0 treats BigDecimal as a primitive argument; Sidekiq's JSON round-trip turns it into a string. Rails 7.1 added an initially opt-in `BigDecimalSerializer`; 7.2 removed the primitive behavior and 8.0 removed the opt-in setting. Rails 8.1 emits a serializer-tagged object unconditionally.

**Application [S]:** [User:41,54–56](file:///home/user/workspace/repo/app/models/user.rb#L41-L56) passes the decimal reading-completion ratio into `DigestJob`; [DigestMailer:10](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L10) converts the received value to BigDecimal.

**Consequence [I]:** a 7.0 worker taking a newly produced job cannot resolve `ActiveJob::Serializers::BigDecimalSerializer`; the job fails before the mailer runs. Deploying old code again while new jobs remain has the same risk. New workers can still accept old string arguments, and the mailer already handles that form. The risk is queue compatibility, not a demonstrated change to the completion percentage.

**Review next:** plan producer/consumer rollout and rollback, including retry/scheduled jobs. Options include routing versioned queues or stopping old consumers before new-format production; draining only the immediate queue is insufficient if retries remain.

**Upstream:** [7.1 changelog explicitly warns about rolling deploys](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb#L7-L17).

### H4. Imported-note CSV receipts lose their DOI values

**Before → after [C/S]:** `read_attribute(:id)` / `record[:id]` formerly redirected to a custom primary key. Since 7.2 it reads the literal `id` attribute; for this model that is absent and yields nil. `record.id` remains the primary-key accessor.

**Application [S]:** [Import#receipt:63–69](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) writes `citation[:id]`, while [the citations table:55](file:///home/user/workspace/repo/db/schema.rb#L55) uses `doi`.

**Consequence [I]:** successful receipt downloads silently contain blank DOI cells. Citation relationships and the database DOI are not themselves removed.

**Review next:** use `citation.id` or `citation.doi`. The existing [CSV assertion:43–45](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L43-L45) expresses the contract.

**Upstream:** [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L425), [8.1 read implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb#L29-L33), [upstream custom-key regression](https://github.com/rails/rails/blob/v8.1.0/activerecord/test/cases/primary_keys_test.rb#L48-L52).

### H5. Import previews omit annotations

**Before → after [C/S]:** before Rails 8.0, `HashWithIndifferentAccess#stringify_keys` effectively copied the hash and retained integer keys. It now stringifies **all** keys, including integers. Indifferent access covers strings/symbols, not integer/string equivalence.

**Application [S]:** [Import#annotations:38–41](file:///home/user/workspace/repo/app/models/import.rb#L38-L41) keys annotations by numeric source line. [The preview:22–44](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44) stringifies them, then looks them up with the original integer.

**Consequence [I]:** annotations disappear from the review screen without an exception, although their values can still be imported. The reader can no longer review the complete import accurately.

**Review next:** retain integer keys throughout, or consistently use strings. [The existing preview assertions:20–24](file:///home/user/workspace/repo/test/controllers/imports_controller_test.rb#L20-L24) cover this.

**Upstream:** [8.0 changelog with before/after integer-key examples](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md#L30-L43).

### H6. The “24 hours later” reminder preview changes across DST

**Before → after [C/S]:** under this app's old defaults, `TimeWithZone#to_time` preserves a fixed UTC offset. The 8.1 implementation always preserves the time-zone object and its transition rules; the deprecated compatibility configuration no longer changes this implementation.

**Application [S]:** [Note#next_day_reminder_at:35–44](file:///home/user/workspace/repo/app/models/note.rb#L35-L44) calculates `reminder_at.to_time + 86_400`; [the reminder partial:16–19](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L19) renders it.

**Consequence [I]:** for the existing Eastern DST-end example, the preview changes from **2026-11-01 09:00 −04:00** to **08:00 −05:00**. This is the **same instant**, not an hour's change to the scheduled delivery. [Postponement:71–72](file:///home/user/workspace/repo/app/models/note.rb#L71-L72) still uses the resulting epoch. High reflects a silent time-zone/display-contract change, not claimed corruption of reminder timestamps.

**Review next:** choose whether to retain the intentionally fixed-offset preview or adopt the more natural reader-local display; do not accidentally replace 24 elapsed hours with a calendar day. See [the existing DST assertion:18–21](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L18-L21).

**Upstream:** [8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22), [actual 8.1 implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L494-L499).

### H7. Expired-export fragments can be stored without an expiration

**Before → after [C/S]:** old cache code allowed a negative TTL, making the entry immediately expired. New code detects negative `expires_in`, removes it, and reports/logs a handled error when `raise_on_invalid_cache_expiration_time` is false. That flag remains **false** with 7.0 defaults. With no store-wide TTL, the write then has no expiration. Adopting 7.1 defaults would instead raise an ArgumentError.

**Application [S]:** [the export fragment:25–36](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) always calculates `export.expires_at - Time.current`, including when the completed export has already expired.

**Consequence [I]:** expired availability fragments can persist until invalidation/cleanup rather than expire immediately, with repeated invalid-TTL logging during reads/renders. For the normal expired case the cached text is “Expired”; this does **not** establish a download authorization bypass. [The download controller:5–15](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L5-L15) checks ownership and authoritative expiry before its conditional response.

**Review next:** avoid caching with a negative lifetime—e.g. cache only the still-available state—and distinguish cache-storage behavior from download permissions.

**Upstream:** [7.1 configuration introduction](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L861-L870), [8.1 negative-TTL handling](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L907-L944).

### H8. Conditional: local signing-key selection can invalidate sessions and attachments

**Before → after [C/S]:** development/test previously generated or read `tmp/development_secret.txt`. New Rails uses `tmp/local_secret.txt`; 8.1 additionally prefers `SECRET_KEY_BASE` or credentials over generating a local key. These are separate changes to file location and key precedence.

**Application [S]:** [session authentication:7–17](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L7-L17), [Action Text body:8](file:///home/user/workspace/repo/app/models/note.rb#L8), and [signed blob links:3–11](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L3-L11) depend on application-derived signatures.

**Consequence [I, conditional]:** if the chosen key differs, existing local sessions stop authenticating and stored attachment SGIDs/signed URLs can stop resolving. Old and new local processes may disagree. This is not evidence that a production key will change; actual secret values were deliberately not inspected.

**Review next:** establish and preserve the intended key in each environment. For a generated local key, preserve the old value under the new location, but also check the newer ENV/credentials precedence. Do not print secret values during the comparison.

**Upstream:** [upgrade guide: file rename and attachment impact](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md#L169-L179), [8.1 precedence changelog](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md#L156-L163), [8.1 key selection](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L526-L547).

## Medium-risk changes

### M1. Citation-provider configuration loses `Rails.application.secrets`

**Before → after [C/S]:** `Rails.application.secrets` reads the YAML-backed configuration in 7.0, is deprecated in 7.1, and removed in 7.2. Rails 8.1 does not transparently move arbitrary secrets to credentials.

**Application [S]:** [Provider#initialize:13–14](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L14) invokes it by default; [config/secrets.yml:5–18](file:///home/user/workspace/repo/config/secrets.yml#L5-L18) defines the environment-backed provider settings. [Citation#enrich:28–33](file:///home/user/workspace/repo/app/models/citation.rb#L28-L33) instantiates that default provider.

**Consequence [I]:** enrichment raises before sending HTTP. This is not a `Provider::Error`, so the job's usual permanent-failure path does not handle it; normal queue retries can leave the citation pending. Tests that inject settings directly can miss the default-construction failure.

**Decision:** choose credentials versus explicit environment/configuration loading, and preserve development/test defaults and production secret provisioning. Merely changing the method name can leave the provider unconfigured.

**Upstream:** [7.1 deprecation](https://github.com/rails/rails/blob/v7.1.0/railties/CHANGELOG.md#L165-L168), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61).

### M2. Built-in Sidekiq adapter is one release away from removal

**Before → after [S]:** Rails 7.0 supplies the adapter used by Sidekiq 6.5.12. Rails 8.1 still supplies it, but warns that it is removed in **8.2** and recommends Sidekiq **7.3.3 or newer**, which supplies its own adapter.

**Application [S]:** [queue adapter configuration:24](file:///home/user/workspace/repo/config/application.rb#L24), [Sidekiq/Redis pins:35–36](file:///home/user/workspace/repo/Gemfile#L35-L36). Native [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L3-L10) also means a later Sidekiq major upgrade is not solely an Active Job concern.

**Consequence [I]:** no mandatory Sidekiq major upgrade was introduced by this resolution, but the next Rails release removes the selected adapter. A later upgrade needs its own Redis/client/job compatibility review. Production currently [suppresses deprecations](file:///home/user/workspace/repo/config/environments/production.rb#L75-L76), so absence of a visible production warning is not evidence of safety.

**Decision:** budget the separate Sidekiq upgrade before Rails 8.2; do not silently broaden this Rails-only change to include it.

**Upstream source:** [8.1 adapter and deprecation message](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L1-L38).

### M3. Conditional: newly locked JSON 3 rejects previously accepted provider documents

**Before → after [C/S/R]:** compared with this Ruby's JSON 2.7.2 baseline, JSON 3.1.0 rejects duplicate object keys and JavaScript comments by default; parsing also tightens malformed-escape/surrogate handling. The duplicate-key case previously accepted the final value. These changes come from the **resolved transitive dependency**, not `load_defaults`.

**Application [S]:** [Provider#metadata_from:42–52](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) calls `JSON.parse` without options and maps ParserError to a permanent provider error; [Citation:28–36](file:///home/user/workspace/repo/app/models/citation.rb#L28-L36) persists that failure.

**Consequence [I, conditional on provider input]:** e.g. `{"title":"first","title":"final","url":"https://example.org/work"}` previously supplied the final title but now fails enrichment as invalid JSON. The in-repository stand-in generates ordinary JSON, so it is not evidence of an affected response in deployment. No historical provider responses were available to establish incidence.

**Decision:** prefer enforcing a strict provider contract; if real responses depend on old leniency, decide explicitly whether to change the producer or narrowly configure parsing. Do not globally weaken JSON parsing just to remove a new error.

**Upstream:** [JSON changelog](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md); [exact changelog from the resolved released gem](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0/json-3.1.0-CHANGES.md#L5-L65). JSON 3 also removes APIs/options and rejects non-ASCII BINARY generation, but no such directly affected call was established in this application; ordinary UTF-8 tags and generated queue payloads are not claimed broken.

## Low-risk mechanical changes

These can block boot or features before the high-risk paths are reachable. “Low” describes the straightforward correction, not whether the current code will run unchanged.

- **[C/S/I] Enum keyword syntax removed in 8.0:** [Note:10](file:///home/user/workspace/repo/app/models/note.rb#L10) must become `enum :status, { draft: 0, ready: 1 }, prefix: true`; [removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md#L64).
- **[C/S/I] Positional serialization coder removed in 7.2:** [Note:12](file:///home/user/workspace/repo/app/models/note.rb#L12) needs `serialize :tags, coder: JSON`; retain JSON rather than changing the stored format; [removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421).
- **[C/S/I] Attribute alias must name a database attribute in 7.2:** [Note:13–14](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) aliases the `color` store accessor, not a column; replace with explicit getter/setter forwarding or ordinary method aliases, preserving `highlight_color` form inputs; [removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490).
- **[C/S/I] Action Text sanitizer defaults are lazy/nil since 7.1:** [initializer:3](file:///home/user/workspace/repo/config/initializers/action_text.rb#L3) does `nil + [...]` at boot; extend the effective `sanitizer_allowed_tags` defaults, including attachment tags, rather than setting an allowlist of only `details`/`summary`; [change](https://github.com/rails/rails/commit/e8137c527dd6bd43f695b472f440cab7466243a6), [effective defaults](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb#L68-L73).
- **[C/S/I] Active Support's nonnumeric `sum` override removed in 7.1:** [Export:42](file:///home/user/workspace/repo/app/models/export.rb#L42) sums strings without an identity, so Ruby's numeric-zero default raises; use `fragments.join` or `sum("")`; [removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L420).
- **[C/S/I] Numeric scheduled times removed in 7.2:** [Note:61](file:///home/user/workspace/repo/app/models/note.rb#L61) passes an integer to `wait_until`; pass `Time.at(reminder_epoch)` so serialization can call `utc.iso8601`, preserving the instant; [removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55), [8.1 serialization](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L130).
- **[C/S/I] Retry wait alias removed in 7.2:** [CitationEnrichmentJob:7](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) needs `:polynomially_longer` instead of `:exponentially_longer`; this renames the same backoff algorithm, not a new retry policy; [7.1 explanation](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L22-L26), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L51).
- **[C/S/I] Multiple paths in one route call removed in 8.1:** [routes:18](file:///home/user/workspace/repo/config/routes.rb#L18) must declare `/notes` and `/journal` separately while retaining their shared action and canonical helper; [removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107).
- **[C/S/I] Boolean `show_exceptions` removed in 7.2:** [test.rb:31](file:///home/user/workspace/repo/config/environments/test.rb#L31) needs `:none` instead of `false`; otherwise the exception-handling fallback no longer expresses “raise,” affecting existing `assert_raises` request tests; [removal](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md#L100).

## Changes/areas not applicable under the stated scope

Each exclusion is limited to the setup and call sites read, not a claim that the entire subsystem is unchanged.

- **[S/I] PostgreSQL raw DATE decoding default:** not enabled with 7.0 defaults, so [Notebook#daily_note_counts:38–40](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40) still receives date text; adopting 7.2 defaults later would require removing/revisiting `Date.iso8601` on an already-decoded Date ([default gate](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L331-L334)).
- **[S/I] Raising on readonly-attribute assignment:** not enabled with 7.0 defaults; [Notebook's readonly slug:8](file:///home/user/workspace/repo/app/models/notebook.rb#L8) is not automatically a new failure ([7.1 default gate](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L280-L287)).
- **[S/I] Removal of implicit YAML as the default column serializer:** gated by 7.1 defaults; [Notebook preferences:7](file:///home/user/workspace/repo/app/models/notebook.rb#L7) keep the YAMLColumn fallback, unlike Note's genuinely removed positional coder syntax ([fallback](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb#L20), [gate](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L287)).
- **[S/I] HTML5 sanitizer default:** not adopted with 7.0 defaults, though the initializer still needs the low-risk repair above; sanitizer/Nokogiri versions themselves do not move ([default gates](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L313-L320)).
- **[S/I] Rails 7.1 cache/message serialization defaults and 8.1 Active Record signed-ID verifier defaults:** not automatically adopted; do not assume a wholesale cookie/cache-format migration from the version bump alone ([defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L306-L310), [legacy signed-ID compatibility](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/railtie.rb#L338-L349)); signing-key selection remains the separate H8 risk.
- **[S/I] Strict HTTP ETag precedence:** enabled by 8.0 defaults, not 7.0; [export downloads' combined validators:11](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L11) do not automatically switch semantics ([gate](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L335-L340)).
- **[S/I] Automatic post-transaction enqueue:** do not apply the 7.2 announcement blindly to 8.1; the target class default is **false**, with no application override, so [reminder scheduling under a lock](file:///home/user/workspace/repo/app/models/note.rb#L56-L62) and [citation enqueueing](file:///home/user/workspace/repo/app/models/citation.rb#L14-L23) are not automatically deferred ([target default](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L53)).
- **[C/S/I] Active Job tests respecting the configured adapter:** the app explicitly configures `:test`, so the 7.2 change does not send its Active Job tests to Redis ([test config](file:///home/user/workspace/repo/config/environments/test.rb#L36-L37), [changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L3-L14)).
- **[C/S/I] New Trix gem's editor upgrade:** not applied to the explicitly loaded vendored 1.3.5 script; do not assume Trix 2.x features/security fixes are inherited. The Rails `actiontext.js` integration does change, so later browser verification should cover existing attachment uploads and saved rich text ([layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14), [8.1 Action Text history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md)).
- **[S/I] Rack 3 migration / extracted session and server APIs:** Rack stays 2.2.24; the resolved `rack-session` 1.x and `rackup` 1.x are Rack-2 compatibility packages, not a Rack 3 migration ([session compatibility](https://github.com/rack/rack-session/tree/v1.0.2)).
- **[S/I] WEBrick addition:** application and local citation-provider server use Puma, not WEBrick; adding the Rackup dependency does not switch servers ([Gemfile:16–17](file:///home/user/workspace/repo/Gemfile#L16-L17), [provider server](file:///home/user/workspace/repo/bin/citation-provider#L17-L21)).
- **[S/I] `useragent`/new browser restrictions:** no `allow_browser` declaration was found in application controllers, so the new dependency alone does not block older browsers ([ApplicationController](file:///home/user/workspace/repo/app/controllers/application_controller.rb#L1-L19)).
- **[S/I] `net-imap` 0.6.8 fixes:** no IMAP client/inbound-mail workflow; reviewed sequence-set coercion, parser-debug and Ractor changes do not participate in the file/test mail-delivery paths ([mail config](file:///home/user/workspace/repo/config/environments/development.rb#L39-L45), [upstream diff](https://github.com/ruby/net-imap/compare/v0.6.7...v0.6.8)).
- **[S/I] DRb 2.2.3:** used indirectly by [parallel tests](file:///home/user/workspace/repo/test/test_helper.rb#L7-L9); reviewed object-reference hardening/SSL changes do not establish a changed application contract, and there is no app-owned DRb protocol ([upstream diff](https://github.com/ruby/drb/compare/v2.2.0...v2.2.3)); parallel test execution remains unverified.
- **[S/I] SecureRandom 0.4.1:** reviewed library changes chiefly supply compatibility for Ruby 3.2; no app-specific random-format dependency was found on Ruby 3.3.6 ([upstream diff](https://github.com/ruby/securerandom/compare/v0.3.1...v0.4.1)).
- **[S/I] URI 1.1.2:** [provider URL checking](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) uses `URI.parse`, which already used RFC3986 parsing in the old baseline; no changed outcome for this application's normal HTTP(S) URLs was established ([upstream diff](https://github.com/ruby/uri/compare/v0.13.1...v1.1.2)).
- **[C/S/I] BigDecimal arithmetic revisions:** reviewed division/rounding fixes, but no changed four-decimal completion result was established for [integer count division followed by `round(4)`](file:///home/user/workspace/repo/app/models/user.rb#L54-L56); explicit-precision, custom-rounding, BigMath and infinity cases are not used ([rounding fix](https://github.com/ruby/bigdecimal/pull/330), [release history](https://github.com/ruby/bigdecimal/releases)); the proven job wire-format risk is H3, not a claimed numeric regression.
- **[R/S/I] `method_source` removal:** no application use was found; Rails no longer requires it, so there is no identified application API to replace.
- **[S/I] MySQL/SQLite adapters, multi-database/sharding, composite-key and encrypted-attribute changes:** this schema/configuration uses PostgreSQL, a single database and ordinary scalar keys with no encrypted model attributes; the scalar custom-key change that *does* apply is H4 ([database config](file:///home/user/workspace/repo/config/database.yml#L17-L26), [schema](file:///home/user/workspace/repo/db/schema.rb#L13-L105)).
- **[S/I] Cloud storage and image variants/previews:** Disk services and original-blob rendering rule out S3/GCS/Azure and image-processor changes; no general claim is made that all Active Storage behavior is unchanged ([storage](file:///home/user/workspace/repo/config/storage.yml#L1-L7), [custom partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L15)).
- **[S/I] Action Mailbox and Action Cable feature changes:** frameworks are loaded, but no application inbound mailbox or subscription/broadcast workflow was found; reminder/digest mail delivery is not Action Mailbox.
- **[S/I] Solid Queue/Cache/Cable, Propshaft, authentication scaffolding, deployment/generator defaults:** a gem requirement change does not regenerate this existing app, change its explicit Sidekiq adapter or replace its Sprockets Gemfile entry ([Gemfile:10–11,34–36](file:///home/user/workspace/repo/Gemfile#L10-L36)).

## Review limits and next decision

**Overall assessment: high risk as an unchanged-code upgrade.** The most important issues are partial import persistence, digest day selection, and mixed-version digest payloads. Mechanical boot/feature fixes will not by themselves address those contracts.

This was a read-only review of application code, release changelogs (including intervening release branches), selected underlying PRs/commits, downloaded tagged Rails source, the full endpoint diff as a discovery source, and resolved dependency source/history. It is **not** a line-by-line audit of every Rails change, a complete security audit, or a compatibility certification.

No new gem was installed; the application, database tasks and tests were not run. Existing tests are cited as contracts, **not** as passed/failed executions. Unknowns include production configuration/keys, queue contents/deployment overlap, actual provider payloads, and browser compatibility between the updated Action Text integration and the pinned editor.

If the upgrade is approved, first preserve the 7.0 defaults while fixing the listed removals and business-contract changes, then validate the existing invalid-import, CSV/preview, UTC-digest, DST-reminder, export-expiry and attachment scenarios. Treat adoption of newer defaults and a Sidekiq major upgrade as separate decisions.
