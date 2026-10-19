# Rails 7.0.8.7 → 8.1.0: Margin Notes upgrade assessment

## Recommendation

**Do not treat this as a Gemfile-only upgrade.** Stage the runtime upgrade through 7.1, 7.2, 8.0, then the requested **8.1.0**, initially retaining `config.load_defaults 7.0`. Fix removed APIs and preserve the application's documented contracts first; adopt newer defaults separately. Several failures are unconditional, including the Action Text initializer, route definition, model APIs, and background-job APIs. Others change persisted or queued behavior even with old framework defaults.

Ruby **3.3.6 already satisfies Rails 8.1.0's Ruby ≥ 3.2 requirement**. No application schema conversion is inherently required by the findings below. Preserve the existing JSON tags, YAML notebook preferences, integer enums, DOI primary keys, reminder epochs, and rich-text HTML.

This is a **source-based plan, not an executed upgrade**. No application files, Gemfile, lockfile, database, Redis queue, cache, or storage were modified. No Rails boot, dependency resolution, tests, or browser experiments were executed. All validations below remain proposed. The only repository-local additions are this ignored review artifact and its local exclude rule. Pre-existing untracked `.amp/` files were left alone.

## Evidence and scope

Inspected application configuration, all models/jobs/mailers/controllers, affected views, routes, schema/migrations, dependency lockfile, tests, and repository guidance. Checked the official versioned upgrade guide and Rails source tags **v7.0.8.7, v7.1.0, v7.2.0, v8.0.0, v8.1.0**, including release notes, gemspecs, `load_defaults`, and implementing methods. The intermediate tags establish when changes appeared; select current patch releases within those minor lines when actually staging the upgrade.

Relevant current configuration:

- [Gemfile](file:///home/user/workspace/repo/Gemfile), [lockfile](file:///home/user/workspace/repo/Gemfile.lock): Rails 7.0.8.7, Ruby 3.3.6, Bundler 2.5.22, pg 1.6.0, Sidekiq 6.5.12, redis 4.8.1, Puma 5.6.9, Rack 2.2.24, concurrent-ruby 1.3.4, Minitest 5.27.0; Sprockets/importmap/Turbo/Stimulus remain in use.
- [Application configuration](file:///home/user/workspace/repo/config/application.rb#L9-L25): Rails 7.0 defaults; Sidekiq adapter. [Test configuration](file:///home/user/workspace/repo/config/environments/test.rb#L25-L47): explicit test job adapter, null cache, file storage, test email.
- [Production](file:///home/user/workspace/repo/config/environments/production.rb): caching enabled, no explicit cache-store override (framework FileStore default), Disk storage; no configured production mail-delivery contract. Development caching is optional MemoryStore. Redis is used for Sidekiq and digest reservations, not as the configured Rails cache.
- Tests cover many request contracts, but there are **no system-test cases** under `test/system`. Active Job's test adapter does not perform Sidekiq's JSON round trip; native Sidekiq fake mode does. Existing tests are not evidence of worker interoperability, production cache behavior, or editor compatibility.

Upstream entry points: [8.1 upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), [7.1 notes](https://guides.rubyonrails.org/v8.1.0/7_1_release_notes.html), [7.2 notes](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html), [8.0 notes](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html), [8.1 notes](https://guides.rubyonrails.org/v8.1.0/8_1_release_notes.html).

## A. Required compatibility changes

“7.0-safe” means supported by the inspected current-version source, **not experimentally verified**.

### A1. Action Text allowlist initialization — boot blocker from 7.1

**Affected:** [action_text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3). `allowed_tags += ...` assumes a populated collection. In 7.1+ the override starts as `nil`; defaults are calculated by `sanitizer_allowed_tags`. This initializer attempts `nil + ...`, independent of `load_defaults`.

**Recommendation:** Build the explicit allowlist from the active sanitizer's default tags, plus `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details`, and `summary`. Configure it at an appropriate initialization point after selecting the sanitizer. Do not fix this with only `%w[details summary]` or `nil.to_a`: those drop ordinary rich text and attachment markup. Leave default allowed attributes intact. This construction can be made **7.0-safe**. Reassess the sanitizer vendor separately in B5.

**Validation:** Boot and eager-load each variant. Render a previously stored body containing paragraphs, a link, an image attachment, `details/summary`, a script, and an unsafe URL; safe structure and attachment identity survive, scripts/events/unsafe URLs do not. Existing sanitization test lacks attachments. Sources: [7.0 helper](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/app/helpers/action_text/content_helper.rb), [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb), [engine initialization](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/engine.rb).

### A2. Multiple paths in one route — boot blocker in 8.1

**Affected:** [routes](file:///home/user/workspace/repo/config/routes.rb#L17-L24): `get "/notes", "/journal", to: "notes#index"`. Rails 8.1 rejects more than one positional path.

**Recommendation:** Separate the routes, preserve `notes_path` as `/notes`, and preserve `/journal` as an alias. **7.0-safe.**

**Validation:** Boot routes, verify `notes_path`, visit both paths signed in and signed out, and paginate filtered results from the alias. Existing notes tests cover the two list paths. Source: [8.1 route mapper](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/routing/mapper.rb).

### A3. Enum declaration — model load blocker in 8.0

**Affected:** [Note](file:///home/user/workspace/repo/app/models/note.rb#L10-L14): keyword-style `enum status: ..., _prefix: true` is removed.

**Recommendation:** Use `enum :status, { draft: 0, ready: 1 }, prefix: true`, as the application's other enums already do. **7.0-safe.** Do not change the integer mapping, predicates, or scopes.

**Validation:** Reload existing 0/1 records; verify `status_ready`, filters, forms, and digest selection retain their meaning. Sources: [7.0 enum](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/enum.rb), 8.0 release notes.

### A4. Positional `serialize` coder — model load blocker in 7.2

**Affected:** [Note tags](file:///home/user/workspace/repo/app/models/note.rb#L12-L14), backed by a text column containing JSON, default `[]`.

**Recommendation:** At the **7.1 stage**, change to `serialize :tags, coder: JSON`. Do not switch to YAML or add a new `type:` constraint as an incidental upgrade change. **Not a safe direct backport to 7.0:** its method does not interpret `coder:` as the serializer; passing that keyword can leave the YAML path selected or fail downstream. Do not equate “accepts keyword options” with compatible behavior.

**Validation:** Load rows written by 7.0, edit/reload tags in the new runtime, inspect stored JSON, then read those rows with the old runtime. Include `[]`, non-ASCII tags, commas/duplicates through `tag_list`, and existing records not regenerated from fixtures. Sources: [7.0 serialization](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [7.1 transition API](https://github.com/rails/rails/blob/v7.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serialization](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb).

### A5. Alias of a JSONB store accessor — model attribute generation failure in 7.2

**Affected:** [Note highlight](file:///home/user/workspace/repo/app/models/note.rb#L13-L17). `color` is a method supplied by `store_accessor :settings`, not a database attribute. `alias_attribute :highlight_color, :color` is no longer supported for it.

**Recommendation:** Replace with explicit `highlight_color`/`highlight_color=` forwarding to `color`/`color=` (or both corresponding method aliases). Keep the JSONB key `color`. **7.0-safe.**

**Validation:** Edit an existing yellow note to green through the request form, reload its settings, and verify rendering and invalid-color rejection. Both getter and setter must work. Sources: [upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#alias-attribute-now-bypasses-custom-methods-on-the-original-attribute), [8.1 attribute generation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb).

### A6. Removed `Rails.application.secrets` — citation enrichment and tests break in 7.2

**Affected:** [provider default settings](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L15), `config/secrets.yml`, and [citation tests](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L40-L58), including `with_provider` at lines 105–123.

**Recommendation:** Move the provider's environment-backed settings and current environment-specific fallback policy into `config.x.citation_provider` (or a dedicated `config_for` file); change both provider reads and test overrides. Use direct Ruby ENV assignment, or properly quoted YAML values, so `00123` and `sample: value # keep` remain exact strings. Do not move only the production reader and leave the test helper mutating `secrets`. **7.0-safe.** Preserve deployment secret-key configuration independently; do not regenerate signing keys.

**Validation:** Run the existing fresh-process credential test against its local fake provider, plus missing configuration and 401/503 behavior. Verify web and worker processes receive the same configuration without logging credentials. Source: 7.2 release notes.

### A7. Unbound search form — `/notes` fails in 8.0

**Affected:** [notes index](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12-L37): explicit `model: nil` now raises.

**Recommendation:** Omit `model:` on this URL-based GET form. **7.0-safe.** No need to introduce a form model or change parameter names.

**Validation:** Render list and search, asserting GET `/notes`, unscoped filter parameters, selected page size, and retained pagination filters. Source: [8.1 form helper](https://github.com/rails/rails/blob/v8.1.0/actionview/lib/action_view/helpers/form_helper.rb).

### A8. Import's non-local return — partial data commits in 7.2+

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L61): `return false` inside `transaction` after an earlier row has saved. The old rollback behavior is removed in 7.2, regardless of retaining old defaults at the final target.

**Recommendation:** Use explicit `ActiveRecord::Rollback` for an invalid row and derive the method's boolean result from transaction success. Preserve the invalid note's errors for the preview. Do not rescue every database exception as a validation failure. **7.0-safe.**

**Validation:** Submit a CSV with a valid first row creating a new citation/rich-text record and an invalid second row. Assert no Import, Note, Citation, or rich-text record remains; assert 422 and line-specific errors. The existing invalid-import test is a good regression case. Also check outside transactional fixtures, because transaction nesting can hide commit behavior. Sources: 7.2 and 8.0 release notes; [8.1 transaction implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/abstract/transaction.rb).

### A9. Custom primary-key read — receipt DOI regression in 7.2

**Affected:** [Import#receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L70): `citation[:id]` formerly redirected to the actual primary key; the `citations` primary key is `doi`, not `id`.

**Recommendation:** Use `citation&.doi` (or `citation.id` if deliberately requesting the abstract primary key). **7.0-safe.** Keep DOI case and whitespace policy unchanged; no ID migration.

**Validation:** Download a receipt with a mixed-case DOI, shared DOI rows, and a row with no citation; compare exact CSV values. Existing receipt test covers the non-`id` primary key. Sources: 7.2 release notes; [7.0 attribute read](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/read.rb), [8.1 read](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/read.rb).

### A10. Integer annotation keys become strings — silent preview data loss in 8.0

**Affected:** [Import#annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L41) builds an indifferent hash keyed by integer source lines; [preview](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L45) calls `stringify_keys` then still looks up `row.line` as an integer. Rails 8 really stringifies these keys; previously the indifferent-hash override merely duplicated the hash.

**Recommendation:** Remove this unnecessary `stringify_keys` call and retain the integer line-key contract, or render `row.annotation` directly. **7.0-safe.** Merely changing lookup to `row.line.to_s` is not a safe cross-version preparation while the old no-op stringify remains.

**Validation:** Preview two different annotations on source lines 2 and 4, with an intervening blank line and a multiline quoted body; ensure neither annotation disappears or moves to another row and HTML is still literal text. The existing preview test discriminates this. Source: [8.0 Active Support changelog](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md).

### A11. String `sum` — Markdown export fails from 7.1

**Affected:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L32-L43): `fragments.sum` relies on the removed Active Support nonnumeric sum override. Ruby's sum starts with numeric zero.

**Recommendation:** Use `fragments.join`. **7.0-safe.** Keep ordering, delimiters, and heading fallback unchanged.

**Validation:** Export an empty notebook and one with two differently dated notes; compare complete Markdown, not just attachment presence. Existing export request test checks exact bytes. Sources: 7.1 release notes; [7.0 enumerable extension](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/core_ext/enumerable.rb).

### A12. Numeric `wait_until` — reminder enqueue fails in 7.2+

**Affected:** [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L56-L68): an integer epoch is passed to `wait_until`. Target Active Job stores that object as `scheduled_at`, then serializes with `.utc.iso8601`, so an integer is invalid.

**Recommendation:** Pass `Time.at(reminder_epoch).utc` to `wait_until`; keep the database epoch integer. **7.0-safe:** the old implementation calls `.to_f` on the supplied time.

**Validation:** Schedule a non-round epoch with seconds (the existing 1,793,451,617 case), compare the outer Sidekiq scheduled timestamp, execute when due, and ensure a replaced reminder sends nothing. Include a refused enqueue retaining the previous reminder. Old 7.0 job envelopes lack the new `scheduled_at` field; the target deserializer accepts its absence, but execute an actual saved old envelope before rollout. Preserve job IDs; do not blindly recreate scheduled jobs. Sources: [7.0 job core](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/core.rb), [8.1 job core](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).

### A13. Removed retry algorithm name — citation outages break in 7.2

**Affected:** [CitationEnrichmentJob](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L4-L9): `:exponentially_longer` is removed; it was actually polynomial backoff.

**Recommendation:** At the **7.1 stage**, rename to `:polynomially_longer`, preserving three attempts and the existing exhausted handler. **Not 7.0-safe:** that symbol is not supported there. There is no need to add a custom backoff lambda merely to backport the rename.

**Validation:** Local provider returning 503 repeatedly: verify polynomial retry intervals including jitter, three job executions, at most six HTTP attempts, and final visible failure rather than Sidekiq's own retry cascade. Include an old queued retry envelope with nonzero execution counters. Sources: 7.2 notes; [8.1 retry implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/exceptions.rb).

### A14. Digest day now depends on preserved argument zone — behavioral change in 7.2

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L34-L56), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L10). Reservations use UTC day, but the mailer derives its date/range directly from a time argument in the reader's zone. Rails 7.2 includes and restores the argument's named zone; the old deserializer converted it to the job's zone, UTC here. New messages can select a different day without any exception.

**Recommendation:** Explicitly normalize `requested_at` to UTC in the mailer before `to_date` and `all_day`, so existing queued arguments are covered. Also enqueue UTC time, making the contract explicit at the producer. **7.0-safe.** Do not change the reservation key or user-facing UTC promise. Local-day digests would be a separate behavior change.

**Validation:** At 2026-10-05 03:30 UTC, Eastern local time is October 4, 23:30. Include a ready note updated on each UTC day and a draft; require the October 5 subject and only that day's ready notes. Test old-envelope/new-worker and new-envelope/old-worker with JSON, plus fresh new/new. The current digest request test uses this boundary, but not real Sidekiq JSON or cross-version workers. Sources: [7.2 job changelog](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [target zoned-time serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

### A15. BigDecimal payload format — mixed-version/rollback hazard

**Affected:** The same digest producer passes `reading_completion` as BigDecimal. Rails 7.0 leaves it primitive; Sidekiq JSON turns it into a string. Rails 7.1 can enable, and 7.2 mandates, `ActiveJob::Serializers::BigDecimalSerializer`. A 7.0 worker does not have that serializer constant and cannot deserialize a new serialized decimal. Keeping `load_defaults 7.0` does not prevent this at 8.1.

**Recommendation:** Before upgrading, enqueue `reading_completion.to_s("F")` as a decimal string. The existing mailer already calls `BigDecimal(...)`, which accepts old string payloads and target BigDecimal values. The producer change is **7.0-safe** and preserves the currently observed worker contract without a custom serializer. Deploy it to every producer before permitting mixed workers. Do not rely on changing the mailer to fix a deserialization failure that happens before `perform`.

**Validation:** Use completion `0.6667`, not only zero or one. Perform the real JSON round trip and the four producer/consumer version combinations; compare rendered percentage and argument deserialization. Include retry/scheduled/dead payloads, not only the immediate queue. If new serializer payloads have already been emitted, drain them on capable workers or establish a tested compatibility reader before rolling workers back. Sources: [7.0 argument handling](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/arguments.rb), [7.0 serializer registry](https://github.com/rails/rails/blob/v7.0.8.7/activejob/lib/active_job/serializers.rb), [target decimal serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

### A16. `to_time` preserves the named zone in 8.1 — DST display changes

**Affected:** [Note#next_day_reminder_at](file:///home/user/workspace/repo/app/models/note.rb#L40-L45), reminder preview, and [reminder test](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L6-L25). At 7.0 `to_time` retains a fixed offset; 8.1 retains the zone, so adding 86,400 seconds follows its DST offset. The instant remains 24 elapsed hours later, but preview text changes. The old setting cannot preserve this behavior at 8.1.

**Recommendation:** Preserve the documented current display contract explicitly with `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` if doing a behavior-preserving upgrade. **7.0-safe.** Alternatively, deliberately adopt zone-aware display as a separate user-visible improvement, updating the test and architecture statement; do not call it an epoch/scheduling correction. Never substitute `1.day` without evaluating calendar-day versus elapsed-time semantics.

**Validation:** From October 31, 2026 09:00 Eastern, +86,400 seconds is November 1 13:00 UTC. Legacy display is 09:00 −04:00; zone-aware display is 08:00 −05:00. Require identical scheduled epochs and consciously chosen text; add the spring transition counterpart. Sources: [8.1 TimeWithZone#to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb), 8.1 release notes.

### A17. Test exception policy — unsupported boolean from 7.2

**Affected:** [test environment](file:///home/user/workspace/repo/config/environments/test.rb#L30-L31) sets `show_exceptions = false`; authorization tests rely on exceptions being raised. Target exception middleware recognizes `:none`, not false, for this policy.

**Recommendation:** Change to `:none` at the **7.1 stage**. **Not 7.0-safe:** its middleware specifically checks false, so the symbol changes behavior there. Retain separate production-style tests for actual 404 responses rather than changing every exception assertion indiscriminately.

**Validation:** A foreign-reader record raises in the configured test mode; in an explicitly production-style exception mode it returns 404 and reveals/writes no data. Sources: 7.1/7.2 release notes; [8.1 exception wrapper](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/middleware/exception_wrapper.rb).

## B. Optional default adoption and conditional changes

These do **not** justify immediately changing `load_defaults` to 8.1. The source of truth is [8.1 load_defaults](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb), not a freshly generated app's infrastructure choices.

### B1. Notebook preferences need an explicit YAML coder before 7.1 defaults

[Notebook](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L20) uses implicit YAML `serialize :preferences`. With retained 7.0 defaults, target Rails still supplies YAMLColumn. With 7.1+ defaults, `default_column_serializer = nil`, so the declaration fails.

At the 7.1 stage explicitly use `serialize :preferences, coder: YAML`; this preserves the stored YAML and is **not a direct 7.0 keyword backport**, for the same reason as A4. Do not switch existing rows to JSON or add `type: Hash` casually: that adds migration/default/type semantics. Validate pre-existing YAML hashes and NULL, save/change/remove the export heading, and read target-written records under the old runtime. Inspect a sanitized stored-data sample before tightening allowed YAML classes; no production data was inspected. Source: [serialization implementation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb).

### B2. Read-only slug assignment raises even when resubmitted unchanged

With 7.1+ defaults, `raise_on_assign_to_attr_readonly = true`. [Notebook's `attr_readonly`](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L10), the [hidden slug field](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L9-L15), and [permitted slug parameter](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L38-L41) mean an ordinary settings update assigns the read-only attribute. The target setter checks readonly status, not whether the value differs.

Before adopting this default, remove slug from the submitted settings and update allowlist; the model already derives it on creation, so the client need not assign it there either. This preparation is **7.0-safe**. Validate ordinary name/heading edits with the same submitted slug and a forged changed slug, requiring unchanged persisted slug and no server error. Keep model `attr_readonly`. Source: [readonly attributes](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/readonly_attributes.rb).

### B3. Raw PostgreSQL dates become Date objects with 7.2 defaults

[Notebook#daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L33-L41) calls `Date.iso8601(day)` on `select_rows` results. `postgresql_adapter_decode_dates = true` returns Date instead of ISO text for the SQL date column.

Before adoption, accept the actual typed result and parse only strings, e.g. `day.is_a?(Date) ? day : Date.iso8601(day)`. This is **7.0-safe** and allows rolling runtimes; retain UTC grouping and ordering. Validate records on both sides of UTC midnight while the owner uses a non-UTC zone, multiple records on one date, and empty notebooks. Run with decoding off and on rather than mocking row types. Source: [PostgreSQL adapter](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb).

### B4. Expired-export fragment TTL becomes invalid

[Export fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L36) always supplies `expires_in: export.expires_at - Time.current`, including for expired exports. 7.1+ defaults raise on negative TTL. Even with the flag off, target Rails logs/removes the invalid TTL rather than preserving the old negative-expiration behavior.

Compute TTL once and cache only while it is positive; render the expired branch without that cache. `cache_if` with a positive-TTL condition is a **7.0-safe** option. Merely switching to past `expires_at:` is not a fix, because target cache option processing converts it to a relative TTL. Validate before expiry, exactly at expiry, and after expiry, on both cold and warm caches with caching enabled. Preserve the download action's independent authorization/expiry check. Existing cache test is valuable but uses MemoryStore, not production FileStore. Source: [cache expiration handling](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache.rb).

### B5. HTML5 sanitization and editor assets require a stored-content/browser gate

7.1+ defaults choose HTML5 sanitization where supported (this MRI/Nokogiri application), separately from required A1. Stored HTML from CSV and earlier editors may parse/render differently even if all new fixtures pass.

Keep the prior vendor initially; adopt HTML5 after checking a sanitized corpus of stored HTML, malformed nesting, links, details/summary, galleries and attachments, and unsafe markup. Do not disable sanitization to preserve layout. An explicit HTML4 vendor setting belongs to the 7.1+ configuration API, **not a necessary 7.0 change**.

Independently, [layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14) hard-pins classic Trix 1.3.5, while [CSS](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L9) resolves framework `trix.css`, and the import map resolves upgraded `actiontext.js`. Rails 8.1 adds `action_text-trix ~> 2.1.15` ([gemspec](https://github.com/rails/rails/blob/v8.1.0/actiontext/actiontext.gemspec)); upgrading Rails does not replace that explicitly selected old script. **A runtime incompatibility has not been established**, but leaving mixed old JS/new CSS/integration is not a verified outcome. Prefer a deliberately matched target Trix JS/CSS pair after browser checks; do not automatically install a second Trix copy. A Trix 2 switch is not claimed 7.0-safe without testing.

Precompile assets, inspect served asset identities, then edit an existing link/attachment, directly upload an image, save/reopen, and confirm no missing attachment IDs or browser errors. Check details/summary rendering and edit/save separately: flattening by the old editor is already documented, not newly caused by Rails. Snapshot stored body HTML before edit tests; rollback of code cannot restore markup rewritten by an editor. Source: [Action Text engine](https://github.com/rails/rails/blob/v8.1.0/actiontext/lib/action_text/engine.rb).

### B6. Strict HTTP freshness changes conditional downloads with 8.0 defaults

[ExportDownloadsController](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L16) passes both ETag and Last-Modified to `stale?`. Under `strict_freshness = true`, If-None-Match takes precedence instead of requiring both conditions to agree.

Adopting the standards-compliant default is reasonable, but characterize it explicitly: matching ETag plus an older If-Modified-Since gives **200 under the old combined rule, 304 under strict freshness**, while the export is still authorized/unexpired. Also test a nonmatching ETag, both matching, expiry with a matching ETag, and another reader. Existing test covers ETag alone and expiry, not conflicting headers. No controller change is inherently required; the setting is a newer API, not current-version preparation. Source: [HTTP cache request logic](https://github.com/rails/rails/blob/v8.1.0/actionpack/lib/action_dispatch/http/cache.rb).

### B7. Do not accidentally change enqueue/transaction guarantees

[Citation#request_enrichment](file:///home/user/workspace/repo/app/models/citation.rb#L11-L23) and [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L54-L68) enqueue under row locks; a Redis error currently rolls back the pending state/replacement reminder. Deferring enqueue until after commit changes that failure contract.

Rails 7.2's new defaults enable adapter-dependent deferral; **8.1's actual class attribute defaults to false**, and its accepted configuration is boolean per-job, not the old global config or `:never/:always/:default` symbols. Do not copy intermediate advice into 8.1 unchanged. Keeping 7.0 defaults throughout the runtime stages avoids the 7.2 opt-in. If explicitly selecting immediate enqueue at 7.2, use that version's `:never`; on 8.0/8.1 use `false`. These assignments are **not supported on 7.0** and should not be added there.

Retain immediate-enqueue behavior for the initial migration unless separately redesigning error recovery. Test real transaction commit/rollback and a failing enqueue outside fixture transactions, verifying stored state, job IDs, and visible outcomes. Test a fast worker contending for the same lock. Native `ExportJob` is not subject to Active Job's deferral; its export row is deliberately committed before push. Sources: [7.2 enqueue logic](https://github.com/rails/rails/blob/v7.2.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb), [8.1 class default](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueuing.rb), [8.1 deferral implementation](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/enqueue_after_transaction_commit.rb).

## C. Dependencies and scope boundaries

1. **Resolve and lock; do not presume Rack 3 is mandatory.** Rails 8.1 actionpack requires Rack ≥ 2.2.4, not ≥ 3; railties requires rackup ≥ 1.0; actionpack requires rack-session ≥ 1.0.1. Sidekiq 6.5.12 constrains Rack to 2.x, so a Rack-2-compatible dependency solution is plausible, using compatible rackup/rack-session releases. This has **not been resolved or boot-tested**. Preserve the pinned direct dependencies initially; verify with the actual solver and inspect all transitive changes. Sources: [actionpack gemspec](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec), [railties gemspec](https://github.com/rails/rails/blob/v8.1.0/railties/railties.gemspec), current lockfile.
2. **Sidekiq is a separate decision.** Rails 8.1 still includes its Sidekiq adapter, with a deprecation recommending Sidekiq ≥ 7.3.3; removal is scheduled for Rails 8.2. That is not evidence that 8.1 forces an immediate Sidekiq/Redis-client migration. Validate the existing 6.5 adapter in a real worker. If upgrading Sidekiq, separately address `User#request_digest`'s boolean `sadd` assumption, native export option symbol keys, changed Redis error classes, strict JSON validation, server-version requirements, and historical job wrappers. Do not hide those changes in this Rails plan. Source: [8.1 Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).
3. **Keep Puma initially, subject to a live server check.** A Rack-2 runtime avoids assuming a Puma/Rack-3 migration. If Puma is upgraded, review the test fake-provider's `Puma::Events.strings`/`Puma::Server` usage, not just application boot. No successful target Puma run is claimed.
4. **Keep concurrent-ruby and Minitest pins while staging.** 1.3.4 satisfies target Active Support's ≥ 1.3.1 constraint; loosening it early can change Rails 7.0's implicit Logger loading. Minitest 5 is permitted by the target source. Do not upgrade test framework and Rails simultaneously without need. Source: [Active Support gemspec](https://github.com/rails/rails/blob/v8.1.0/activesupport/activesupport.gemspec).
5. **Do not install new-app defaults by accident.** Solid Queue/Cache/Cable, Propshaft, authentication generation, Kamal, image processing, and a new storage service are not required to upgrade this application's existing explicit Sidekiq/Sprockets/Disk stack. There are no custom Active Storage controller subclasses using the removed streaming inclusion, no encrypted AR attributes, no custom job serializers, no SQLite usage, and no implemented broadcasts found. Encryption-rotation, SQLite, and custom-serializer migration recipes do not currently apply.
6. **Schema dump changes are not data migrations.** Rails 8.1 alphabetically orders columns in `schema.rb`. Inspect separately from substantive schema changes. Preserve historical migration version declarations. Verify both loading the schema and replaying migrations on isolated databases; do not run a destructive historical down migration as the Rails rollback procedure.

## D. Stored data, cookies, caches, and rollback

### Preserve signing keys and defer one-way format adoption

- Rails 7.1 renames development/test `tmp/development_secret.txt` to `tmp/local_secret.txt`. Preserve the old key securely when retaining existing local data; otherwise sessions and signed Active Storage/Action Text references may stop verifying. Never print the key or assume copying encrypted credentials includes it. Preserve the production `secret_key_base` source and value as well; its actual deployed configuration was not inspected.
- Existing session storage contains a user ID; Rails 7.0 defaults already select JSON cookies and SHA256 key-generator digest. Do not apply a Rails-6-to-7 digest rotation recipe blindly.
- Defer 7.1 `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true` until all readers can consume them and rollback below 7.1 is no longer needed. The newer reader supports legacy envelopes, but the reverse is not generally true. This matters to signed blob URLs and Action Text SGIDs embedded in durable HTML, not merely short-lived cookies.
- With 7.0 defaults retained, those newer settings remain off/legacy. If adopting later defaults early, explicitly retain the legacy message settings in the **new runtime**; these new config APIs are not preparatory 7.0 changes. Record resolved configuration, and exercise old/new cookies, blob signed IDs, Disk URLs, and rich-text SGIDs in both directions with unchanged keys. Keep new-writer output compatible during the rollback window. These token classes do not necessarily all use the same serializer; test their actual public flows instead of inferring compatibility from a single verifier test.
- Do not purge old blobs or rewrite stored SGIDs as part of the runtime upgrade. Keep database and storage snapshots consistent. Old HTML may live indefinitely, so waiting for ordinary browser sessions to expire does not settle attachment compatibility.

Sources: [secret-file upgrade guidance](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html#development-and-test-environments-secret-key-base-file-changed), [message configuration](https://guides.rubyonrails.org/v8.1.0/configuring.html#config-active-support-use-message-serializer-for-metadata), [8.1 metadata implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/messages/metadata.rb).

### Treat fragment cache compatibility separately from durable content

Retain cache format 7.0 until the old-runtime rollback window closes, or use a new cache namespace/directory for the new deployment. New Rails understands older entries; that does not imply Rails 7.0 understands the 7.1 binary format. Its old loader interprets the leading zero as its own Marshal format, unlike the target binary coder. An isolated cache or deliberate cold-cache rollback is acceptable because these fragments are disposable; a blanket Redis flush is not, because Redis owns jobs and digest reservations here.

Validate cross-version FileStore reads/writes with availability fragments, not only MemoryStore; cover expiry and a viewer with different ownership. Production FileStore sharing across hosts or releases is unknown and determines the actual mixed-version exposure. Sources: [7.0 cache loader](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/cache.rb), [8.1 cache coder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/cache/coder.rb).

### Queue rollout and rollback sequence

1. Deploy 7.0-safe preparation, especially UTC digest normalization and decimal-string production, to **all producers and workers**. Include web processes, scheduled tasks, and consoles that can enqueue. Capture representative redacted old payloads before draining anything.
2. Inventory ready, scheduled, retry, and dead sets: digest jobs, future reminder jobs, citation retries, native exports, and Active Storage framework jobs. Emptying only the immediate queue is insufficient; long-future reminders cannot simply be waited out.
3. Validate new workers consuming saved old envelopes in isolated Redis/DB/storage. Preserve Active Job IDs, native Sidekiq JIDs, GlobalIDs, retry counters, wrapper class names, queue names, timestamps, and locale/timezone fields. Deleting or recreating reminder IDs changes stale-job suppression; digest deduplication does not guarantee exactly-once email.
4. Prefer a controlled pause of producers and workers for each actual cutover, or a tested workers-first rollout where payload compatibility is established. Do not create untested old-worker/new-producer overlap. Back up durable state and record the queue checkpoint; any production pause or mutation needs explicit operational authorization.
5. Roll back to the **prepared** old release, not the original unprepared baseline, while old-compatible formats remain in use. Check for newly emitted serializer/envelope formats before doing so. If incompatible jobs exist, leave capable consumers running to finish or migrate them with a separately tested operational procedure; do not discard them or replay completed email jobs blindly.
6. Keep original JSON/YAML/enum/DOI/epoch formats, signing keys, and blob files readable throughout. Restore data only for a documented recovery need, not automatically when reverting code, since that would erase user writes after the snapshot. If editor writes or a partial-import failure already damaged data, a code rollback alone will not repair it.

## E. Implementation and validation order

### Stage 0 — preparation on 7.0.8.7

Implement only the 7.0-safe changes from A1–A3, A5–A12 where marked, A14–A16, plus selected default-readiness preparations B2–B4. Keep A4 coder keywords, A13 retry rename, and A17 exception symbol for 7.1. Keep DST display preservation separate from a deliberate display improvement. Extend existing public request tests rather than creating tests for private methods.

### Stage 1 — 7.1 runtime, old defaults

Resolve a lockfile, apply A4/A13/A17, make notebook's YAML coder explicit, and review `bin/rails app:update` differences without overwriting application ownership, routes, service adapters, or asset setup. Collect deprecations in a development/test-like isolated environment; production currently disables deprecation reporting. Run the full request/model suite and the boundary probes. Establish a tested rollback checkpoint.

### Stages 2–4 — 7.2, 8.0, 8.1.0 runtimes, old defaults

Repeat resolution, update-diff review, eager loading, suites, workers, assets, and cross-version tests at every stage. Do not call these intermediate versions production-ready merely because they are stepping stones. Exercise the time/decimal changes at 7.2, annotation/form/enum changes at 8.0, and route/time conversion changes at 8.1. Pin and record the exact patch dependencies used for every variant.

### Stage 5 — defaults and optional dependency adoption

Only after the target runtime and rollback plan are validated, enable B defaults individually and repeat their discriminating tests. Keep message/cache writers legacy until all readers and rollback releases support the newer formats. Adopt Trix/assets and Sidekiq changes as separately reviewable decisions with their own compatibility evidence. Change `config.load_defaults` only after all resulting settings have been accounted for.

### Required isolation for every future experiment

A copied checkout alone is **not** sufficient:

- Use a disposable checkout with no copied live credentials, `.env`, symlinked storage, cache, or runtime files.
- Give each variant an explicitly unique PostgreSQL database/role and `DATABASE_URL`. Account for parallel-test database suffixes or set `PARALLEL_WORKERS=1`. Check all environment configs before `db:prepare` or test preparation.
- Use a dedicated Redis instance/port or otherwise proven isolated Redis resource for **both** Sidekiq and digest reservations, not the application's default URL. Give both producer and worker that explicit URL. Do not run `FLUSHALL` on the shared service.
- Override test/local storage roots, cache directory/namespace, logs, and mail output into variant-specific disposable paths. Use only fake provider credentials and local scripted HTTP responses; prevent production email or outbound provider use.
- Do not run `.agents/setup` as an experiment: it starts shared services and prepares the configured development database.

### Proposed commands and evidence package

After establishing the isolation above, run in each disposable variant:

```sh
bundle check
# After changing only the experimental variant's Rails requirement:
bundle update rails
bin/rails zeitwerk:check
bin/rails test
bin/rails test:system
# In an isolated production-like environment, with explicit safe settings:
bin/rails assets:precompile
```

`test:system` currently has no cases, so a zero-test result proves nothing. Add/exercise a real browser editor workflow, run a live server on the selected Rack/Puma stack, and run real Sidekiq producer/consumer probes. The current system-test base also needs a display or a deliberately configured headless browser.

Retain **per variant**, rather than overwriting a single log:

- `manifest.md`: checkout identity, exact command/cwd, Ruby/Bundler versions, resolved service endpoints with credentials redacted, defaults and explicit configuration, environment names, and exit status;
- exact `Gemfile` and `Gemfile.lock`, plus any experimental patch;
- `commands.log`, `bundle.log`, `zeitwerk.log`, `tests.log`, `assets.log`, `web.log`, `worker.log`, and redacted old/new job-envelope fixtures;
- storage/cache/database setup definitions and output paths, and assertions/output for each boundary probe;
- inspected browser screenshots under the review-artifacts directory if UI validation is performed.

At minimum, add the discriminating tests missing from the current suite: old/new queued payload interoperability; stored-data round trips in both runtimes; cookie/attachment signatures in both directions; enabled FileStore expiry behavior; conflicting conditional-request headers; and real edit/save of existing rich text. Existing tests already strongly exercise several API regressions, but do not replace those tests with implementation-derived expectations.

## Remaining questions and confidence limits

- Actual target dependency resolution, Puma/Sidekiq boot, request suite results, and asset/browser compatibility remain unverified. Source constraints are not a successful bundle or runtime result.
- No production database/storage sample, queued workload, deployed PostgreSQL/Redis version, cache sharing topology, secret-key source, or rollout topology was inspected. Inventory these before operational approval.
- Preserve the documented UTC digest day and legacy DST preview unless a separate behavior change is approved. This plan does not silently reinterpret them.
- Production email configuration and private blob authorization are already absent/limited according to both code and architecture. They are deployment concerns, not regressions introduced by this Rails upgrade; no unrelated feature work is proposed here.
- This evaluates the specifically requested 8.1.0 release, not its suitability as the latest security-patched deployment target. Review patch/security policy separately before release.

**Executed evidence:** read-only code/source inspection and versioned upstream source comparisons only. Upstream sources were downloaded using `curl -fsSL https://codeload.github.com/rails/rails/tar.gz/refs/tags/v<VERSION> | tar -xz -C <temporary-source-directory>` for the five tags listed above, then inspected with `rg`, `sed`, and `diff`; no downloaded code was run. Temporary source downloads were removed after review. There are no experimental commands, resolved target lockfiles, or runtime logs to report because no experiments were executed.
