# Rails 7.0.8.7 → 8.1.0: application-specific upgrade risk

## Application facts and assessment boundary

Evidence labels: **[Code]** means application or released upstream source read; **[History]** means an upstream changelog; **[Inference]** means an expected consequence, not an executed reproduction. Risk ratings are judgments based on those facts. This is a source-only assessment, not a claim that an upgraded application boots or passes tests.

- **[Code]** Ruby is **3.3.6**, Rails is pinned to **7.0.8.7**, and the application loads every Rails framework but retains **`config.load_defaults 7.0`**: [Gemfile](file:///home/user/workspace/repo/Gemfile#L1-L8), [application configuration](file:///home/user/workspace/repo/config/application.rb#L1-L24). Ruby satisfies Rails 8.1's Ruby ≥ 3.2 requirement. This report assumes only the Rails requirement changes—not adoption of 8.1 defaults or generated replacement configuration.
- **[Code]** PostgreSQL is the only database; tags are JSON in text, notebook preferences use serialized YAML, settings are jsonb, and citations use a string DOI primary key: [database configuration](file:///home/user/workspace/repo/config/database.yml#L17-L22), [Note](file:///home/user/workspace/repo/app/models/note.rb#L5-L18), [Notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L1-L19), [citation migration](file:///home/user/workspace/repo/db/migrate/20261011160000_create_imports_and_citations.rb#L1-L18).
- **[Code]** This is an HTML/ERB application with Sprockets, importmap, Turbo, Action Text, and local Disk uploads—not a JSON-only API. It deliberately loads **vendored Trix 1.3.5**, separately from Action Text: [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14), [import map](file:///home/user/workspace/repo/config/importmap.rb#L3-L8), [storage](file:///home/user/workspace/repo/config/storage.yml#L1-L7). There is no image-processing gem, and the [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L1-L14) uses original images.
- **[Code]** Active Job uses **Sidekiq 6.5.12 / Redis 4.8.1**, except tests use `:test`; exports use native Sidekiq. Digests enqueue a zoned time and BigDecimal, reminders enqueue an integer epoch as `wait_until`, and citation enrichment uses Rails secrets and retry backoff: [adapter](file:///home/user/workspace/repo/config/application.rb#L22-L24), [test adapter](file:///home/user/workspace/repo/config/environments/test.rb#L36-L40), [User](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [Note](file:///home/user/workspace/repo/app/models/note.rb#L56-L62), [provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13-L20), [retry](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L1-L12).
- **[Code]** Production enables controller caching and does not select an external store; Rails therefore uses its default FileStore. Development toggles MemoryStore/NullStore; tests use NullStore. The export-availability fragment has a deadline-derived TTL: [production](file:///home/user/workspace/repo/config/environments/production.rb#L16-L19), [cache configuration](file:///home/user/workspace/repo/config/environments/production.rb#L58-L63), [fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35). Redis is for jobs/reservations, not the Rails cache.
- **[Code]** Mailers send plain text; development writes files and tests collect deliveries. Production delivery and real deployment topology are not established here. No custom Cable channel, inbound mailbox, multitenancy, encryption, sharding, or application-defined transaction callbacks were found in the inspected code.
- **[Inference]** The application does not prove whether production workers share queues during deployment or whether a real database differs from the checked-in schema. Mixed-version queue risks below are conditional on that deployment pattern. Stored user HTML and legacy JSON contents were not inspected.

### Dependency resolution actually performed

**[Code / resolver output]** Copied `Gemfile` and `Gemfile.lock` outside the repository, changed only the Rails pin to 8.1.0, and ran **`bundle lock --update rails`** with Ruby 3.3.6 / Bundler 2.5.22. Resolution succeeded on 2026-10-19. No gems were installed and no application commands/tests were run.

All twelve Rails component gems plus the Rails metagem move together to **8.1.0**. Other lockfile changes:

| Dependency | Current → resolved |
| --- | --- |
| action_text-trix | absent → 2.1.19 |
| bigdecimal | not locked; local Ruby default 3.1.5 → 4.1.3 |
| json | not locked; local Ruby default 2.7.2 → 3.1.0 |
| drb | not locked; local Ruby default 2.2.0 → 2.2.3 |
| securerandom | not locked; local Ruby default 0.3.1 → 0.4.1 |
| uri | not locked; local Ruby default 0.13.1 → 1.1.2 |
| rack-session / rackup | absent → 1.0.2 / 1.0.1 |
| useragent / webrick | absent → 0.16.11 / 1.9.2 |
| net-imap | 0.6.7 → 0.6.8 |
| method_source | 1.1.0 → removed |

**Rack remains 2.2.24**, constrained by Sidekiq 6.5.12. Puma 5.6.9, Redis 4.8.1, pg 1.6.0, Pagy 8.6.3, Faraday 1.10.4, concurrent-ruby 1.3.4, and the Hotwire/asset gems remain unchanged. Do not assume Rack 3, Sidekiq 7, Solid Queue, Propshaft, or Redis 5 is part of this upgrade. The unlocked standard-library baseline above is the inspected local Ruby, not a guarantee about every deployed host. Resolving today selects newer transitive releases than were available when Rails 8.1.0 shipped.

## High-risk changes

### H1. A failed CSV import can commit the import and earlier rows

**Before → after [History + Code]:** Rails 7.0 rolls back a transaction exited by a non-local `return`; Rails 7.2 removes that behavior and commits a normally unwound transaction. This is unconditional in 8.1, even with 7.0 defaults. Sources: [7.1 history](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md#L304-L330), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L371-L377), [8.1 transaction implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb).

**Use [Code]:** [`Import#apply`](file:///home/user/workspace/repo/app/models/import.rb#L50-L60) saves the import, then executes `return false unless row.note.save` inside its transaction. The controller interprets false as an unsuccessful import: [create](file:///home/user/workspace/repo/app/controllers/imports_controller.rb#L9-L20).

**What can go wrong [Inference]:** An invalid later row leaves the import, earlier notes, rich text, and possibly new citations committed although the UI reports failure. Retrying can duplicate them. A revealing case is two rows with a valid first row and invalid second row. Preserve all-or-nothing semantics explicitly rather than relying on `return` to roll back.

### H2. Digest jobs preserve the reader's time zone, changing which notes/day are emailed

**Before → after [History + Code]:** The 7.0 TimeWithZone serializer stores an offset but restores the time in the executing job's `Time.zone`; 7.2+ also stores/restores the original zone. Sources: [7.2 history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L47-L49), [old serializer](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [new serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

**Use [Code]:** [`User#request_digest`](file:///home/user/workspace/repo/app/models/user.rb#L34-L41) reserves a **UTC** date but passes a reader-zoned time. [`DigestMailer#daily_digest`](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L12) derives both its subject date and `updated_at` range from that argument.

**What can go wrong [Inference]:** Newly queued jobs select the reader's local day while deduplication still uses UTC. Near midnight, old and new payloads can email different dates and note sets. Example: 00:30 in Tokyo is still the preceding UTC date. Choose the digest's intended day boundary explicitly, including jobs already queued. This is a semantic change, not merely a display improvement.

### H3. BigDecimal job payloads are incompatible with old workers

**Before → after [History + Code]:** In Rails 7.0, a BigDecimal passed through a JSON-backed adapter becomes a string. Rails 7.1 adds a tagged BigDecimalSerializer behind an opt-in; 7.2 removes the primitive fallback, and 8.0 removes the compatibility setting. Sources: [7.1 rollout warning](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L142-L155), [7.2 history](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L59-L65), [8.1 serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

**Use [Code]:** [`User#reading_completion` and enqueue](file:///home/user/workspace/repo/app/models/user.rb#L34-L56) send a BigDecimal to [`DigestJob`](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L1-L8). The [mailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L10) explicitly converts the argument back to BigDecimal.

**What can go wrong [Inference]:** A 7.0 worker cannot deserialize a new tagged argument because it lacks that serializer. New workers can still receive old strings, and the mailer's conversion handles both; that does **not** make the reverse direction safe. Coordinate producers/workers and draining or isolating queues rather than treating this as a rolling-deploy-safe drop-in change. The risk also applies to rollback while new payloads remain queued.

### H4. Negative fragment-cache TTLs no longer mean “already expired”

**Before → after [Code + History]:** In 7.0 a negative TTL produces an already-expired entry. New cache option normalization removes negative `expires_in`; by default it reports/logs the error rather than raising, then uses the store's fallback expiry. Sources: [7.1 expiration history](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md#L860-L870), [8.1 `merged_options`](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb#L908-L945).

**Use [Code]:** The [completed-export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L35) always supplies `export.expires_at - Time.current`, including expired exports. [`Export#downloadable?`](file:///home/user/workspace/repo/app/models/export.rb#L45-L48) and the [download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) independently enforce expiry.

**What can go wrong [Inference]:** Rendering an expired export now writes a fragment without the intended deadline (potentially indefinitely in FileStore/MemoryStore). No stale available link is established by that negative-TTL path: an already-expired export renders the expired indicator. This is a cache-lifetime regression, **not an authorization bypass**: the download action still checks ownership/expiry. Examine already-expired and deadline-crossing renders, not just future deadlines.

### H5. Reading `citation[:id]` no longer returns its DOI

**Before → after [History + Code]:** Rails removes `read_attribute(:id)`'s redirection to a differently named primary key in 7.2. `[]` calls `read_attribute`; `id` still means the actual primary key. Sources: [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L425-L427), [new reader](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb#L29-L34), [primary-key accessor](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/primary_key.rb#L18-L21).

**Use [Code]:** Citations have a `doi` primary key and no `id` column: [migration](file:///home/user/workspace/repo/db/migrate/20261011160000_create_imports_and_citations.rb#L1-L5). [`Import#receipt`](file:///home/user/workspace/repo/app/models/import.rb#L63-L69) uses `citation && citation[:id]` for the CSV DOI.

**What can go wrong [Inference]:** The receipt silently contains a blank DOI for cited notes. Use the actual DOI/primary-key accessor when upgrading. This is high despite the small fix because a downloaded data format changes without an error.

### H6. Plain-text exports and attachment filenames change

**Before → after [Code]:** The released Action Text diff changes ordered-list numbering from a node's index among **all children** to its index among **element children**, and removes script/style content from plain-text conversion. Thus whitespace between `<li>` elements no longer creates numbering gaps. Sources: [old converter](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/lib/action_text/plain_text_conversion.rb), [new converter](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/plain_text_conversion.rb). This was found in source, not inferred from a changelog headline.

**Use [Code]:** CSV accepts arbitrary body HTML: [`Import#build_row`](file:///home/user/workspace/repo/app/models/import.rb#L101-L108). [`Export#markdown_for`](file:///home/user/workspace/repo/app/models/export.rb#L77-L81) exports `body.to_plain_text`.

**What can go wrong [Inference]:** Existing notes can produce different Markdown without editing the note. `<ol><li>A</li>\n<li>B</li></ol>` distinguishes the numbering behavior; imported script/style text disappears from exports. These are useful fixes but observable data-output changes. No actual stored note containing these inputs was established.

**Separate filename change [History + Code]:** Active Storage 8.0 additionally replaces `<`, `>`, `?`, `*`, and `"` with `-` in sanitized filenames. Sources: [8.0 history](https://github.com/rails/rails/blob/v8.0.0/activestorage/CHANGELOG.md#L22-L24), [old](https://github.com/rails/rails/blob/v7.0.8.7/activestorage/app/models/active_storage/filename.rb), [new filename source](https://github.com/rails/rails/blob/v8.1.0/activestorage/app/models/active_storage/filename.rb#L57-L70). The [blob partial](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L2-L12) displays filenames and builds download links; Action Text's plain-text attachment fallback uses the filename. **[Inference]** Existing uploads with these characters acquire different displayed/download/export names; the raw stored filename need not change. Notebook-slug Markdown filenames normally avoid these characters, so that particular download is not the primary exposure.

### H7. Local signing-key selection changes, invalidating sessions and signed attachment references

**Before → after [Code + History]:** Rails 7.0 development/test generate `tmp/development_secret.txt`; 8.1 uses an explicitly supplied environment/credentials key first, otherwise `tmp/local_secret.txt`. Sources: [old key selection](https://github.com/rails/rails/blob/v7.0.8.7/railties/lib/rails/application.rb#L405-L422), [new configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L526-L546), [8.1 local-key history](https://github.com/rails/rails/blob/v8.1.0/railties/CHANGELOG.md).

**Use [Code]:** [Sessions](file:///home/user/workspace/repo/app/controllers/sessions_controller.rb#L7-L19) and [Active Storage signed blob paths](file:///home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb#L3-L12) depend on signing keys; [note bodies](file:///home/user/workspace/repo/app/models/note.rb#L8) contain signed attachable references through Action Text.

**What can go wrong [Inference]:** If the effective key changes, local users are signed out and existing signed URLs/embedded attachment references can stop verifying. Preserve/rotate the effective key when retaining local data. This is a **conditional local-data risk**, not proof production keys rotate: production already prefers ENV/credentials, and this repository's secrets file does not define `secret_key_base`. Credentials were not decrypted and deployed key values were not inspected.

### H8. The newly resolved BigDecimal gem changes arithmetic/precision behavior

**Before → after [History + Code]:** Rails now declares a BigDecimal dependency; this resolution selects **4.1.3** instead of the local Ruby's default **3.1.5**. The gem's history includes division rounding/precision fixes in 3.2 and a new division implementation plus precision fixes in 4.1: [BigDecimal history](https://github.com/ruby/bigdecimal/blob/v4.1.3/CHANGES.md), including linked upstream PRs.

**Use [Code]:** [`User#reading_completion`](file:///home/user/workspace/repo/app/models/user.rb#L53-L56) divides BigDecimals and rounds the quotient to four places; the [digest mailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L10) consumes the result.

**What can go wrong [Inference, not demonstrated]:** Numerical fixes can alter completion figures at a rounding boundary or unusual count magnitude, without an exception. The four-place rounding likely masks many differences; no differing pair of realistic note counts was established by source review. Check representative non-terminating fractions and rounding boundaries before calling this harmless. Removed `precs`, changed `divmod`, and BigMath changes are not used by this application's code.

### H9. Reminder postponement previews now retain the full time zone across DST

**Before → after [Code + History]:** Rails 7.0 `TimeWithZone#to_time` uses `getlocal(utc_offset)` under this app's defaults, producing a fixed-offset Time. Rails 8.1 unconditionally uses `getlocal(time_zone)`, preserving the zone object. Ruby 3.3's Time arithmetic copies that zone and recalculates local time for the resulting instant. Sources: [old conversion](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/time_with_zone.rb#L495-L500), [new conversion](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb#L493-L499), [Ruby Time arithmetic source](https://github.com/ruby/ruby/blob/v3_3_6/time.c#L4357-L4372), [8.1 history](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md#L15-L22).

**Use [Code]:** [`Note#next_day_reminder_at`](file:///home/user/workspace/repo/app/models/note.rb#L40-L44) calls `reminder_at.to_time + 86_400`; the [reminder partial](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20) renders the result.

**What can go wrong [Inference]:** Across a DST transition the displayed offset and wall-clock time change relative to 7.0, now following the reader's zone rather than retaining the original offset. The instant remains exactly 24 elapsed hours later, so this does not itself move the queued reminder to a different instant. It fixes the misleading old preview but changes observable timezone behavior without an error; check spring-forward and fall-back dates. This change applies even with retained 7.0 defaults, not only when adopting 8.0 defaults.

## Medium-risk changes

### M1. `Rails.application.secrets` is removed; citation-provider settings need a new home

**Before → after [History + Code]:** Rails 7.0 reads the provider configuration from `config/secrets.yml`; 7.1 deprecates `Rails.application.secrets` and 7.2 removes it. Sources: [7.1 history](https://github.com/rails/rails/blob/v7.1.0/railties/CHANGELOG.md#L165-L177), [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md#L61-L63).

**Use [Code]:** [`Citation::Provider#initialize`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15) defaults to `Rails.application.secrets.citation_provider.to_h`; the configuration file supplies environment-backed settings by environment.

**What can go wrong [Inference]:** The worker raises when enrichment constructs the provider. Unlike a pure rename, there is no equivalent automatic reading of this custom YAML through credentials. Decide between credentials, explicit ENV-backed application configuration, or another deliberate configuration source, preserving environment behavior and secret handling. Migrating provider settings must not inadvertently change the signing key described above.

### M2. Rails' built-in Sidekiq adapter is deprecated for removal in 8.2

**Before → after [History + Code]:** The built-in adapter works in 7.0 and remains in 8.1, but 8.1 warns it will be removed in **8.2**, recommending Sidekiq ≥ 7.3.3's own adapter. Sources: [8.1 history](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md#L19-L23), [adapter warning and implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb#L1-L45).

**Use [Code]:** The [application adapter](file:///home/user/workspace/repo/config/application.rb#L22-L24) selects `:sidekiq` with a 6.5.12 pin; [ExportJob](file:///home/user/workspace/repo/app/jobs/export_job.rb#L1-L11) separately uses native Sidekiq.

**What can go wrong [Inference]:** This is not an 8.1 dependency-resolution failure, but the next Rails release removes the adapter this app relies on. A Sidekiq upgrade is a separate decision with Redis, job JSON, middleware, runtime, and Rack consequences; it is not mechanically authorized by changing Rails. Production disables framework deprecation reporting, so absence of production warnings is not reassurance.

### M3. Newly resolved JSON 3.1 rejects inputs accepted by the current JSON runtime

**Before → after [History + Code]:** Local Ruby provides JSON 2.7.2; resolution adds JSON 3.1.0. JSON 3 defaults reject duplicate object keys and comments; later fixes reject invalid escapes/surrogates, and 3.1 rejects non-ASCII BINARY strings on generation. JSON 3 also rejects unknown options/removes legacy APIs. Source: [released JSON history](https://github.com/ruby/json/blob/v3.1.0/CHANGES.md).

**Use [Code]:** [`Citation::Provider#metadata_from`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L42-L52) calls `JSON.parse(body)`, turning ParserError into provider failure. [`Note#tags`](file:///home/user/workspace/repo/app/models/note.rb#L12) loads stored JSON. Sidekiq 6.5.12's inspected `load_json`/`dump_json` also use `JSON.parse`/`JSON.generate`.

**What can go wrong [Inference]:** A provider response with duplicate `title` keys previously selected the later value; it now fails enrichment. Historical non-standard JSON can fail reads; non-UTF-8 bytes can fail queue serialization. No malformed provider payload, tag row, or queued argument was established. Decide whether to keep the stricter contract, normalize the producer/data, or constrain the newly introduced dependency; do not globally enable permissive parsing without that decision. Normal tag arrays and ordinary generated Sidekiq payloads do not inherently contain duplicate keys.

## Low-risk changes — mechanical replacements

Each line is a separate application use; these need attention even though they are not the most dangerous behavior changes.

- **[History + Code]** Keyword-style enums are removed in 8.0: [`Note` line 10](file:///home/user/workspace/repo/app/models/note.rb#L10) needs positional name/mapping and `prefix: true`, preserving values and generated method names; [removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md). Citation/Export already use positional syntax.
- **[History + Code]** Positional `serialize` coder is removed in 7.2: [`serialize :tags, JSON`](file:///home/user/workspace/repo/app/models/note.rb#L12) becomes the keyword-coder form; preserve JSON rather than converting stored tags to YAML; [history](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L421-L423).
- **[History + Code]** `alias_attribute` no longer accepts non-column targets: [`highlight_color → color`](file:///home/user/workspace/repo/app/models/note.rb#L13-L14) targets a jsonb store accessor, not a column; use explicit reader/writer aliases or delegation; [removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md#L490-L492), [new guard](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb#L87-L96).
- **[History + Code]** Action Text's `allowed_tags` now defaults to nil, with effective defaults computed on demand: the [initializer's `+=`](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) fails; initialize the effective allowlist before extending it, retaining attachment/figure tags; [history](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md#L18-L33), [implementation](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb). Replacing it with only `details`/`summary` would be an incorrect fix that strips ordinary content.
- **[History + Code]** `:exponentially_longer` is removed in 7.2: [citation retry](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7-L9) should use `:polynomially_longer`, which keeps the old algorithm; [history](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md#L22-L26). Otherwise the transient-error retry path raises instead of retrying.
- **[History + Code]** Numeric `scheduled_at` support is removed: [`wait_until: reminder_epoch`](file:///home/user/workspace/repo/app/models/note.rb#L56-L62) needs a Time constructed from the epoch; [7.2 removal](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md#L55-L57), [8.1 serialization calling `utc`](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb#L120-L132). Do not treat epoch seconds as a relative wait. Old 7.0 serialized job hashes did not include `scheduled_at`, so this is not evidence that all old scheduled jobs become unreadable.
- **[History + Code]** Rails' string-friendly `sum` override is removed in 7.1: [`fragments.sum`](file:///home/user/workspace/repo/app/models/export.rb#L32-L42) needs `join` or an explicit string identity; [history](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md). Otherwise export generation raises under Ruby's numeric-default sum.
- **[History + Code]** Multi-path route declarations are removed in 8.1: [the `/notes`, `/journal` declaration](file:///home/user/workspace/repo/config/routes.rb#L17-L19) needs two declarations while retaining the canonical `notes_path`; [removal](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md#L107-L109).
- **[History + Code]** Boolean `show_exceptions` support is removed in 7.2: [`false` in test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) should use `:none` to retain the documented intent; [history](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md#L100-L102).

## Changes inspected but not active here

These exclusions apply to the checked-in application and retained 7.0 defaults, not to a later `app:update` or defaults migration.

- **[Code] PostgreSQL raw date decoding:** 7.2's `Date` rather than String results would break [`Date.iso8601(day)`](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L40), but the flag is enabled only by **7.2 defaults** and the adapter class defaults false; [configuration source](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L322-L334), [adapter](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb#L125-L132). Not an unconditional failure in this upgrade.
- **[Code] Readonly-assignment errors:** `attr_readonly :slug` exists and the [form/controller resubmit it](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L40), but raising on assignment is a **7.1 default**, not active under 7.0 defaults; [railtie default false](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/railtie.rb#L35-L41).
- **[Code] Default YAML serializer removal:** [`Notebook#preferences`](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) retains YAML because `default_column_serializer = nil` belongs to **7.1 defaults**; [configuration](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L280-L290). This is distinct from the unconditional removal of Note's positional coder syntax.
- **[Code] HTML5 sanitizer default:** not adopted with 7.0 defaults; the 8.1 ContentHelper starts with HTML4 unless configured otherwise. The nil allowlist API change still applies, as listed above. [Source](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).
- **[Code] Cache format 7.1 / MessagePack / Redis-cache pooling:** cache format remains 7.0; no MessagePack or Redis/Memcached store is configured. Do not infer a shared-cache format migration from this version bump; [defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).
- **[Code] HTTP strict freshness:** the [download action's `stale?`](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L8-L13) is relevant, but the changed ETag-vs-date precedence is enabled by **8.0 defaults** only; it is not active here. [Source](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb#L335-L340).
- **[Code] Automatic after-commit enqueueing:** despite the 7.2 changelog describing automatic deferral, 8.1's actual job class default is **false**, and this app does not enable it; enrichment/reminder enqueueing therefore remains inside row-lock transactions. [8.1 source](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb#L43-L54). Native ExportJob is not controlled by Active Job's setting.
- **[Code + History] Trix 2.1 / action_text-trix extraction:** installed assets move from Rails-vendored Trix to the new gem, but the [layout still explicitly loads `trix-1.3.5.js`](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L10-L14), not `trix.js`. Do not claim this upgrade automatically updates the running editor or gives it Trix 2 security fixes; [8.1 history](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md). Choosing to replace the vendored editor is additional upgrade work requiring saved-content/attachment review.
- **[Code] Action Text attachment sanitization/CVE headlines:** the 7.0.8.7 source already sanitizes content attachments in the Trix conversion path; do not count the same backported security fix twice merely because a 7.2 changelog lists it. New source does sanitize during attachment rendering too. No custom content-attachment class was found; normal stored body HTML still requires the allowlist repair above.
- **[Code] Rich-text test selectors:** Rails 8.1 changes selector matching, but no checked-in test calls `fill_in_rich_text_area` or its renamed alias; no current test failure established. The `rich_text_area` form helper remains an alias, so [the note form](file:///home/user/workspace/repo/app/views/notes/_form.html.erb#L48-L51) does not need a rename.
- **[Code] Action Text embed callback / Active Storage autosave fixes:** embed extraction moves before validation and Blob no longer autosaves attachments through the old relation; this app validates `body.body.attachables` directly, does not read `embeds` in validation, and defines no owner after-commit dirty-state callbacks. No application-specific behavior change established from those timing fixes.
- **[Code] Active Storage cloud adapters, Azure removal, image/video variants and proxy fixes:** Disk and original-image redirect URLs are used, not Azure/S3/GCS, processors, variants, or proxy delivery; the custom export action calls `blob.download` and `send_data`.
- **[Code] Action Cable changes:** no application broadcasts/custom subscription behavior found; generated base classes and production Redis configuration alone do not establish use of changed channel behavior.
- **[Code] Action Mailbox changes and net-imap 0.6.8:** no inbound mailbox or IMAP retrieval is implemented; ordinary file/test outbound mail does not use IMAP. Existing Mail/net-smtp versions stay locked.
- **[Code] Action Mailer delivery-job changes:** app mailers call `deliver_now` inside application jobs, not `deliver_later`; no custom delivery job, previews, interceptors, or multipart behavior was found. This does not remove the digest argument risks.
- **[Code] Other Active Record features:** MySQL/SQLite/Trilogy, composite keys, encryption, replicas/shards, bulk upserts, CTEs, explicit isolation settings, custom transaction callbacks, and async queries have no matching application use. Basic PostgreSQL reads may now reconnect/retry known-safe SELECTs; no volatile SELECT function or SQL-side effect was found that establishes an application correctness risk.
- **[Code] New Rails generators/default stack:** Solid Queue/Cache/Cable, Propshaft, Kamal, Thruster, authentication generator, browser gating, rate limiting, YJIT, and generated CSP/deployment settings are not enabled by changing this Gemfile pin. Existing `has_secure_password` authentication remains; the new reset-token API is unused.
- **[Code] JSON renderer escaping, Markdown renderer and strict template locals:** application controllers serve HTML/CSV/binary downloads, not an implemented JSON or Markdown-render action; no strict-locals templates or inline JSON script embedding was found. Generic raw JSON parsing remains relevant under M3.
- **[Code] Rack 3 parameter/status/middleware changes:** Rack remains 2.2.24; new rack-session 1.0.2 is a Rack-2-compatible shim and its session require target is intentionally a no-op, using Rack 2's session implementation. rackup 1.0.1 is similarly a compatibility extraction. [rack-session source](https://github.com/rack/rack-session/tree/v1.0.2), [rackup source](https://github.com/rack/rackup/tree/v1.0.1).
- **[Code] URI 1.1.2:** inspected the default RFC3986 parser against Ruby 3.3.6's URI 0.13.1; the parsing regex is unchanged, with compatibility helpers/error wording changes. [`web_url?`](file:///home/user/workspace/repo/app/models/citation/provider.rb#L55-L59) uses ordinary `URI.parse` and rescues invalid URIs; no changed result for that contract was established. [Released parser](https://github.com/ruby/uri/blob/v1.1.2/lib/uri/rfc3986_parser.rb).
- **[Code / bounded inference] Other resolver additions:** drb/securerandom support Rails internals; useragent supports unused browser-gating features; WEBrick is brought by rackup while the app uses Puma; method_source removal is internal. No direct application calls relying on their changed APIs were found. This is not a complete compatibility audit of every dependency's internal use of them.

## Where to look first

**[Inference / recommended follow-up after deciding to upgrade]** Repair boot/feature API removals first, then specifically exercise: failed second-row CSV import rollback; cited CSV receipt values; Tokyo/Los Angeles digest requests around UTC/local midnight; old/new job-payload consumption and rollback; expired cache entries and deadline-crossing rendering; saved rich-text lists, scripts/styles, attachment captions and unusual filenames. Confirm effective signing-key continuity without exposing key values. Review the actual deployed worker/queue topology before a rolling deployment.

**Review limits:** Read release histories for 7.1, 7.2, 8.0 and 8.1, compared the two released Rails source trees, and traced the relevant source differences into application code. This is a prioritized, non-exhaustive report; no production data, decrypted credentials, new-version installation, application boot, migration, or test execution was performed. All proposed failure scenarios are source-derived unless explicitly identified as resolver output. Application files and dependency pins are unchanged.
