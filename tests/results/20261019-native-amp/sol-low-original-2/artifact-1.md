# Margin Notes: Rails 7.0.8.7 → 8.1.0 assessment

## Decision and evidence boundary

Proceed as a staged compatibility upgrade, not a Gemfile-only change. Initially retain `config.load_defaults 7.0`; adopt newer defaults separately. Ruby 3.3.6 already meets Rails 8.1's Ruby >=3.2 requirement. No working application files were changed, no dependency resolution or application execution was attempted, and no database, Redis, cache, storage, or mail resource was touched. All findings below are source-based; validation steps are proposed, not passing results.

Inspected Gemfile/lock, application/environment/service configuration, models, controllers, jobs, mailers, import preview/layout/assets, migrations, and relevant tests. The locked runtime is Rails 7.0.8.7, pg 1.6.0, Sidekiq 6.5.12, redis 4.8.1, Rack 2.2.24, Puma 5.6.9, Sprockets Rails 3.5.2, Minitest 5.27.0. Those are baseline dependencies, NOT a resolved target bundle.

Upstream evidence: [8.1 upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), and tagged [7.1](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_1_release_notes.md), [7.2](https://github.com/rails/rails/blob/v8.1.0/guides/source/7_2_release_notes.md), [8.0](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_0_release_notes.md), [8.1](https://github.com/rails/rails/blob/v8.1.0/guides/source/8_1_release_notes.md) release notes. Specific sources are linked below. Source downloads were inspected with curl/rg under `/tmp/rails-upgrade-source`; they are not execution experiments or a retained runtime variant.

## Required changes, including behavior not gated by load_defaults

### 1. Action Text initializer cannot add to a nil allowlist

Affected: `config/initializers/action_text.rb` (`allowed_tags += ...`), stored Action Text, imported HTML, attachments.

Rails 7.0 initializes allowed_tags to its effective defaults. In 8.1 allowed_tags is nil and fallback defaults are applied at rendering; `nil + [...]` fails. This is a boot blocker independent of defaults.

Recommendation: explicitly construct the effective safe base from the configured sanitizer's allowed tags plus `ActionText::Attachment.tag_name`, `figure`, and `figcaption`, then add `details` and `summary`. Do not replace the entire allowlist with just those two tags, and do not lose attachment markup. Derive it after sanitizer configuration has been applied (a suitable initialization hook), especially when later enabling HTML5 sanitization. Preserve inherited effective tags if already supplied.

Current-version preparation: this construction works with 7.0's sanitizer API; do not use newer-only `sanitizer_allowed_tags` as an unguarded cross-version helper.

Validation: eager boot in development/test/production; render a stored details/summary excerpt, linked text, and a real attached image, alongside script/event-handler/javascript-URL probes. Assert safe structure and usable attachments, not just absence of exceptions. Existing editor limitations still flatten details on save; do not attribute that existing behavior to the upgrade.

Source: [7.0 helper](https://github.com/rails/rails/blob/v7.0.8.7/actiontext/app/helpers/action_text/content_helper.rb), [8.1 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).

### 2. Note declaration APIs removed

Affected: `app/models/note.rb`: keyword enum, positional JSON serializer, and `alias_attribute :highlight_color, :color`.

* Change enum to `enum :status, { draft: 0, ready: 1 }, prefix: true`; keep persisted integers and generated status-prefixed API unchanged. This works on 7.0.
* On 7.1 change `serialize :tags, JSON` to `serialize :tags, coder: JSON`. The positional coder is removed in 7.2. Do NOT deploy the keyword-only form to 7.0: 7.0 treats its second argument as the coder/type and does not interpret `coder:` as the new serializer selection. Keep JSON, not YAML, and preserve nil/default semantics rather than simultaneously adding a type constraint.
* Replace the alias with explicit `highlight_color` getter/setter delegating to `color` and `color=` (or ordinary method aliases), because color is a store accessor, not a real database column. Non-column alias_attribute is removed in 7.2. Explicit delegation works on 7.0.

Validation: read pre-upgrade raw JSON tags, change and reload them, and read target-written values on 7.0; create/update both statuses and filter with status_ready; submit each highlight through the HTTP form and verify `settings['color']` after reload, including invalid color rejection.

Source: 7.2/8.0 release notes; [7.0 serialization](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 serialization](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods/serialization.rb), [8.1 alias validation](https://github.com/rails/rails/blob/v8.1.0/activerecord/lib/active_record/attribute_methods.rb).

### 3. Citation provider reads a removed configuration API

Affected: `app/models/citation/provider.rb`, `config/secrets.yml`, fresh-process environment test in `test/controllers/citation_enrichments_controller_test.rb`.

Rails.application.secrets is removed in 7.2. Recommendation: move provider settings to `config/citation_provider.yml`, read with `Rails.application.config_for(:citation_provider)`, and preserve existing environment variables, environment-specific local defaults, key normalization, and production's no-provider behavior. Both config_for and direct ENV access work on 7.0. This is configuration migration, not credential-value rotation. Do not log actual credentials. Inventory any deployment-provided secret_key_base separately before retiring secrets.yml.

Validation: fresh subprocesses for each environment, explicit/missing URL and credentials, and an isolated loopback provider checking basic auth plus 200/401/404/503 paths. Existing happy-path configuration injection alone cannot prove that default Provider.new still loads configuration.

### 4. Retry policy uses a removed algorithm name

Affected: `app/jobs/citation_enrichment_job.rb`: `wait: :exponentially_longer` removed in 7.2.

Change to `:polynomially_longer` on 7.1; it names the existing fourth-power policy, not exponential backoff. That symbol is NOT supported by 7.0. For preparation on 7.0 either retain the old symbol until 7.1, or use a callable reproducing the fourth-power wait including the current jitter; do not silently change retry timing.

Validation: run actual provider-unavailable job attempts with controlled time/randomness, verify increasing scheduled waits, three total Active Job attempts, at most six HTTP requests including Faraday's 503 retry, then persisted failure with no further retry. A successful enrichment never exercises this removal. Already scheduled jobs keep their existing execution time; subsequent retries use the deployed code.

### 5. CSV imports can partially commit after non-local return

Affected: `Import#apply` in `app/models/import.rb`: `return false unless row.note.save` inside `transaction`.

7.2 removes rollback-on-return behavior. A later invalid row can leave the Import and earlier notes committed even though the method reports false. This is not fixed by retaining 7.0 defaults.

Recommendation: explicitly raise `ActiveRecord::Rollback` on an unsaved row and return a failure result outside the transaction; ensure success is returned only after the whole transaction commits. Keep row errors for the controller's preview. This works on 7.0 as preparation.

Validation: first row valid with new citation/rich text, second row invalid, submit directly to create (not just preview), then verify unchanged Import/Note/Citation/ActionText counts and no orphan associations. Existing invalid-import test is relevant; add a valid row before the rejected row if it does not already discriminate the partial-commit case. Also test successful multirow commit.

### 6. Receipt reads the wrong attribute for custom primary key

Affected: `Import#receipt`: `citation[:id]`; citations' primary key is `doi`, with no id column.

7.2 removes the special mapping of read_attribute(:id) to a custom primary key. Use `citation.doi` (or citation.id when intentionally requesting the primary key) instead. Works on 7.0; no data migration.

Validation: CSV download must contain exact, nonnumeric DOI and blank DOI for an uncited note, not just correct note titles or successful download.

### 7. Preview annotations lose integer-key lookup

Affected: `Import#annotations` returns HashWithIndifferentAccess keyed by integer source lines; `app/views/imports/preview.html.erb` calls stringify_keys then indexes by integer `row.line`.

In 7.0 HashWithIndifferentAccess#stringify_keys is a no-op duplicate; in 8.1 it uses normal stringification, so integer 2 becomes string '2' and annotation lookup misses. Recommendation: keep integer keys and remove unnecessary stringify_keys in the preview, or consistently use strings at construction and lookup. Both work on 7.0. No stored-data migration.

Validation: CSV preview with distinct annotations on multiple rows and a quoted multiline body; assert the right annotation under the right source-line heading, with literal HTML escaped. Persisted annotation assertions alone miss this presentation failure.

Source: [7.0 hash](https://github.com/rails/rails/blob/v7.0.8.7/activesupport/lib/active_support/hash_with_indifferent_access.rb), [8.1 hash](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/hash_with_indifferent_access.rb).

### 8. Digest queue payload and calendar-day semantics change

Affected: `User#request_digest`, `DigestJob`, `DigestMailer#daily_digest`, digest reservation Redis set, and digest request tests.

New TimeWithZone payloads preserve the named reader zone; the mailer currently uses requested_at.to_date/all_day but relies on old deserialization converting to UTC. Thus a 03:30 UTC October 5 request from Eastern time changes from the October 5 UTC digest to October 4 local-day content, while the reservation remains October 5 UTC. This is a behavior regression, not optional adoption of newer defaults.

Recommendation: explicitly normalize requested_at to UTC inside the mailer before deriving both date and query range. Works on 7.0 and handles both old and new payloads. Retain UTC reservation keys.

BigDecimal is now a tagged Active Job serializer instead of an untagged value that becomes a string through Sidekiq JSON. New serialized payloads may be unreadable by 7.0 workers (unknown serializer). Rails 8.1 can consume old string arguments; verify BigDecimal conversion in mailer for both representations rather than assuming a new failure. Recommended 7.0 preparation: enqueue completion as an explicit decimal string to preserve a common wire format; works with current BigDecimal(...) mailer conversion. Do not rely on disabling the BigDecimal serializer on 8.1, where that compatibility setting is removed.

Validation: actual Sidekiq JSON round trip across old-producer/new-consumer AND new-producer/old-consumer, using Eastern near midnight and Asia/Tokyo on the other side of UTC midnight; notes immediately on both sides of UTC day boundaries; completion 2/3 → 66.67% (matching view rounding), zero notes, and precise decimal strings. Assert digest subject, selected notes, and one-per-UTC-day reservations. Existing test adapter does not reproduce all JSON behavior; inspect actual queue payload and execute it. Existing Eastern digest test is a valuable regression test and should retain its UTC-day expectation.

Sources: [8.1 TimeWithZone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb), [BigDecimal serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/big_decimal_serializer.rb).

### 9. Reminder preview changes across daylight saving

Affected: `Note#next_day_reminder_at`: `reminder_at.to_time + 86_400`, used by reminder UI and postponement.

8.1 TimeWithZone#to_time retains the named time zone, rather than merely the fixed offset under the existing defaults. The instant remains 24 elapsed hours later, but displayed wall time/offset now follows DST. Keeping 7.0 defaults does not restore the fixed-offset result.

Recommendation: explicitly decide the presentation contract. Prefer `reminder_at + 24.hours` to retain 24 elapsed hours and present in the reader's zone consistently with the actual postponed reminder. This works on 7.0 and intentionally fixes the existing preview mismatch. If fixed-offset display is required instead, construct a fixed-offset Time explicitly; do not attempt to retain obsolete compatibility configuration.

Validation: America/New_York spring and fall transitions: compare displayed preview time/offset with persisted postponed epoch and subsequent UI. Distinguish +24.hours from +1.day (23/25 elapsed hours); assert the epoch difference is 86,400. Scheduling uses numeric epoch with wait_until, not direct assignment to removed numeric scheduled_at, so do not invent a scheduled_at migration.

Source: [8.1 to_time](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb), 8.1 release removals.

## Optional defaults adoption (not prerequisites for the gem version)

Source for gates: [8.1 load_defaults implementation](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).

1. **Notebook preferences:** `serialize :preferences` uses implicit YAML under 7.0 defaults. 7.1 defaults set default_column_serializer=nil. Before adopting them, explicitly select YAML (`coder: YAML` on 7.1+), preserving existing YAML text and string-key hashes. Explicit positional YAML works on 7.0, but keyword form does not select the coder there. Do not switch existing rows to JSON without a separately designed dual-reader migration. Validate pre-upgrade nonempty preferences, nulls, heading edits, old reader/new writer and reverse; use representative stored values, not just fixtures.
2. **Read-only slug:** 7.1 defaults enable raise_on_assign_to_attr_readonly. NotebooksController permits slug and the form resubmits it, including unchanged values; assignment can now raise rather than silently ignoring. Stop permitting/resubmitting slug before enabling this default; works on 7.0. Validate unchanged slug on ordinary settings save AND malicious changed slug, with a documented ignore/reject response. Existing settings tests already exercise both, but must run with the proposed default enabled.
3. **Activity report PostgreSQL dates:** 7.2 defaults enable postgresql_adapter_decode_dates. Notebook#daily_note_counts currently Date.iso8601(day), expecting a string from select_rows; pg then supplies Date. Adapt to preserve Date or parse a string (e.g. Date.iso8601(day.to_s)); works on 7.0. Test multiple UTC dates, same-day grouping and count types, under both decode_dates settings with actual PostgreSQL. A gem-only variant with 7.0 defaults will not expose this adoption bug.
4. **Sanitizer vendor:** 7.1 defaults select HTML5 sanitizers when supported. Keep HTML4 initially; compare imported/stored malformed HTML, nested details/summary, links and attachment galleries before opting into HTML5. The initializer fix above is still mandatory regardless. No rewrite of rich-text rows is needed merely to change render-time parsing; editing/resaving is a separate data-loss boundary.
5. **HTTP freshness:** 8.0 defaults set action_dispatch.strict_freshness=true. ExportDownloadsController uses stale?(etag:, last_modified:); ETag takes precedence over If-Modified-Since instead of the older combined evaluation. Validate matching ETag with older date, mismatching ETag with newer date, and each validator alone, plus expiry/ownership before 304. Preserve private revalidation and never use a cached availability flag to authorize download. Adoption of strict freshness need not be blocked, but is observable client behavior.
6. **Messages/cache:** 7.1 defaults use cache format 7.1, JSON-with-Marshal fallback message serialization, and new metadata encoding. App has signed Active Storage IDs/SGIDs/URLs and cookie sessions, plus export availability fragments. Do not bundle these format changes into the first runtime deployment. Hold compatible encodings through the rollback window; test actual old/new session cookies, stored rich-text attachment SGIDs and blob URLs both directions. Keep secret_key_base unchanged. Before cache format adoption, use a separate cache namespace or disposable cold cache; default development cache is null/memory and no shared Redis cache is configured. Do not flush Redis: it contains jobs and digest reservations, not the application cache.
7. **Remaining defaults:** review the generated defaults files individually, including YJIT, regex timeout, rendering dependency tracking, missing finder order columns and redirect policy. Current controllers redirect through route helpers rather than path-relative inputs; no concrete required change found for the 8.1 relative-redirect default. Do not introduce Solid Queue/Cache/Cable, Propshaft, the Rails authentication generator, or deployment scaffolding merely because fresh Rails 8 apps use them.

## Bundle, asset, and environment plan

* Resolve each version in a disposable variant and retain its lockfile. Rails 8.1 actionpack allows Rack >=2.2.4, while locked Sidekiq 6.5 requires Rack ~>2.0; this is NOT inherently an unsatisfiable intersection. Do not assert Rack 3 or a Sidekiq major upgrade is mandatory without running the resolver. Puma/Sprockets compatibility still needs execution, including production asset serving.
* Rails 8.1 includes its Sidekiq adapter but deprecates it for removal in 8.2, recommending Sidekiq >=7.3.3 for the external adapter. Moving Sidekiq now is a separate scope choice; if chosen, audit Redis version/client API, `User#request_digest` sadd boolean semantics, strict JSON args in native ExportJob (symbol-key input), retry behavior, wrapper class names, and scheduled/retry payload compatibility. Do not casually upgrade Redis 4 alongside Rails. The built-in adapter's continued presence does not certify this app's execution against 8.1.
* Keep Sprockets, importmap and the current manifest initially. Action Text JS/CSS comes from the upgraded gem, but layout separately loads vendored Trix 1.3.5; do not install or import a second Trix automatically. Decide a supported Trix version against Action Text 8.1, inspect its JS API, and browser-test rich text create/edit/reopen, links, direct uploads, attachment removal, and existing content before changing it. Compatibility of the current Trix build with 8.1 is unverified. Preserve old fingerprinted assets during rolling deploy/rollback and test a stale browser tab posting to a new server.
* In test environment replace obsolete show_exceptions=false with :none on 7.1+ so request tests retain raise behavior. Keep false on 7.0; do not assume symbols are interpreted identically there. Existing explicit :test queue adapter already meets 7.2's adapter-consistency change. Preserve Sidekiq fake testing for native exports.
* Keep Minitest 5.x initially; the baseline pin is intentional. Keep concurrent-ruby pin until independently justified. Test production eager boot and assets:precompile as well as ordinary tests: production disables deprecation reporting and tests use a null cache and test storage, hiding relevant differences.
* Copy/retain the development secret from tmp/development_secret.txt to tmp/local_secret.txt at 7.1 if continuity matters. Never expose its value. Production continuity requires separately confirming how secret_key_base is supplied; no live deployment or credentials were inspected.
* Run app:update interactively in the disposable variant, review changes, preserve service configuration and custom mail-file delivery. Existing migrations stay versioned [7.0]. Compare Active Storage/Action Text engine migration requirements with schema before proposing any database write. 8.1's alphabetical schema dump order is metadata churn, not an application data migration.

Source: [8.1 actionpack dependencies](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec), [8.1 Sidekiq adapter](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb).

## Rollout and rollback sequence

1. On 7.0, prepare explicit rollback, DOI receipt access, consistent annotation keys, highlight delegation, positional enum, compatible sanitizer setup, provider config migration, UTC digest normalization, decimal string wire arguments, and deliberate DST presentation. Verify on the unchanged runtime before proceeding. Keep serializer keywords and polynomial retry symbol for 7.1.
2. Upgrade through latest patch releases of 7.0 → 7.1 → 7.2 → 8.0 → requested 8.1.0, following upstream guidance. At 7.1 change serializer declaration and retry symbol, repair deprecations before removal; retain 7.0 defaults initially. Run app:update and inspect rather than overwriting configuration wholesale.
3. Separate producers from consumers during rollout. Prefer quiescing job-producing endpoints briefly, stopping old workers, and starting compatible new workers before resuming producers. Alternatively use deliberately versioned queue routing; all relevant job classes must route consistently. Include default, scheduled, retry and dead work, not just the immediate queue. Do not delete pending reminders, exports, citation retries or digest reservations to make the upgrade pass.
4. Keep a snapshot of representative old payloads and test them against each consumer, including native ExportJob options, Active Job wrapper name, GlobalIDs, executions/exception_executions and scheduled times. Future reminders may remain queued for months; draining today's queue is not sufficient. Retain class names and model identities.
5. Rollback requires old workers to understand all target-written payloads. Decimal strings reduce one risk but do not establish whole-payload compatibility. If cross-version tests fail, stop new producers/workers and isolate new-format work for a compatible consumer; do not point 7.0 workers at it. Existing old reminders can keep their IDs/epochs; verify stale reminder suppression after worker restart.
6. Keep stored tags JSON, preferences YAML, rich text and signed IDs readable by both releases. No irreversible data rewrite is recommended. Retain old assets, signing secret and compatible message formats. Back up PostgreSQL and storage together before actual deployment; an application rollback alone cannot repair partially committed imports or lost edited content.
7. Only after runtime stability and a defined rollback horizon adopt newer defaults one at a time using the above discriminating cases. The exact 8.1.0 target is evaluated here, not asserted to be the latest security patch; review patch/security maintenance before production deployment.

## Proposed isolated validation and attribution requirements

No experiments were run for this assessment, so there are no target resolved dependencies, test outputs, application logs, or passing-test claims to attach. Source inspection alone does not certify deployment readiness.

Before any application command, create a disposable copy excluding credentials, storage, tmp, logs and local bundle configuration; reproduce only synthetic data. Isolation must be explicit:

* A dedicated PostgreSQL database/user or private PostgreSQL instance for each variant, with DATABASE_URL and test parallel-worker database naming checked before db:prepare. Never use margin_notes_test or development implicitly.
* A dedicated Redis instance/socket/port (preferable to just a DB number), configured through REDIS_URL for Sidekiq and reservations; use variant-specific cable settings if exercised. No live worker may consume experiment queues.
* Disk service roots, cache path/namespace, mail file delivery, log paths, tmp and Bootsnap cache rooted inside that variant. Production experiments must override delivery to test/file, provider URL to isolated loopback, and secrets to synthetic values. A copied checkout alone does not isolate any of these.

For each baseline, staged target, target-with-7.0-defaults and optional-default variant retain: exact source commit/diff, commands and exit codes, Ruby/Bundler versions, Gemfile.lock, effective nonsensitive config/resource endpoints, stdout/stderr and Rails/worker/provider log paths. Archive them under `.amp/in/artifacts/rails-upgrade/<variant>/` with secrets redacted. Preserve JSON payload fixtures and outputs for cross-version comparisons.

Suggested commands, only after that isolation is verified, from each variant directory:

```
ruby --version
bundle --version
bundle check
# After changing only the disposable variant's Gemfile:
bundle update rails
bundle exec ruby -e 'require "bundler/setup"; puts Bundler.load.specs.map { |s| "#{s.name} #{s.version}" }.sort'
RAILS_ENV=test bin/rails db:prepare
RAILS_ENV=test bin/rails zeitwerk:check
RAILS_ENV=test bin/rails test
RAILS_ENV=test bin/rails test:system
# Synthetic production config with isolated DB/storage/cache and no external mail:
RAILS_ENV=production bin/rails zeitwerk:check
RAILS_ENV=production bin/rails assets:precompile
```

Run all commands with explicit isolated environment, record it safely, capture output and exit status; the snippets alone are not a runnable isolation recipe. Tests use processor-count parallel workers and require multiple disposable databases. Browser base is non-headless Chrome; supply a display/browser driver or document the limitation rather than calling skipped system tests passed. Follow suite runs with the targeted cases above, real JSON queue round trips and controlled worker execution. Do not assume source-level resolver constraints prove bundle resolution or passing tests prove stored-data compatibility.

Remaining questions: actual deployed Ruby/PostgreSQL/Redis versions; actual signing-secret source and cookie retention; production worker topology and longest scheduled reminder; shared storage/cache topology; representative legacy preferences/rich text and outstanding queue formats; whether fixed-offset reminder display is intentionally contractual; desired Trix support policy; exact target patch/security approval. These need deployment inventory or isolated execution, not guesses from the generated configuration.
