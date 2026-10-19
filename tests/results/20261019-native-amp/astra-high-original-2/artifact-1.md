# Margin Notes: Rails 7.0.8.7 → 8.1.0 upgrade plan

## Decision

**Do not deploy a Rails-version-only change.** The dependency graph resolves, but the application does not boot unchanged, and several later changes affect stored data and queued work. Upgrade the runtime separately from framework defaults: initially retain `config.load_defaults 7.0`, fix removed APIs and behavior changes, then adopt newer defaults individually.

This is an assessment, not an implemented upgrade. The working application was not changed. Experiments ran in disposable checkouts with separate PostgreSQL databases, a dedicated Redis instance, copy-local storage/cache/logs, and test mail delivery. The evidence directory linked below retains the experimental patches and commands; they are not a proposed production patch.

The exact requested target, **8.1.0**, was evaluated, not “latest Rails 8.1”. Published minor-version guides can contain later patch changes, so the conclusions below were checked against tagged source. No claim is made that 8.1.0 is the appropriate security patch for a future production deployment.

## What was executed

Evidence is in [rails-8.1-review](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/). The README there maps variants, commands, configuration, dependency locks, output, and application logs.

| Variant | Executed result |
|---|---|
| Current Rails 7.0.8.7, unchanged application | `bundle check`, isolated `db:schema:load`, `bin/rails test`: **46 runs, 325 assertions, 0 failures/errors/skips**. |
| Rails 8.1.0 only, all other Gemfile constraints retained | Bundle resolved; boot failed at `config/initializers/action_text.rb:3` (`nil + tags`). |
| Target with six narrow boot/test-enabling adjustments, still 7.0 defaults | Newly resolved JSON 3.1.0 was incompatible with Rails 8.1.0's JSON decoder. Full suite: **46 runs, 11 assertions, 4 failures, 41 errors**; full backtrace located `JSON.parse`. |
| Same target, additionally constrained to JSON < 3 (resolved 2.21.2) | **46 runs, 174 assertions, 3 failures, 15 errors**. These expose application incompatibilities, not a completed upgrade. |
| Focused current/target probes | Demonstrated partial import commits, blank receipt DOIs, time-zone/date changes, unsafe early serializer migration, retry failure, expiration behavior, and default-dependent readonly/YAML/date failures. |
| Cross-version JSON argument probes | Target reads old digest arguments; current Rails rejects the target's `BigDecimalSerializer`. Explicit UTC `Time` plus decimal `String` arguments round-trip in **both directions**. |
| In-process proposed atomic-import implementation | Valid import succeeds and later-invalid-row import rolls back on **both** versions. No application file changed by this probe. |
| Real Sidekiq adapter/Redis enqueue smoke, both versions | Sidekiq 6.5.12 accepted a synthetic portable digest job; JSON envelope and job ID were checked. The exact synthetic jobs were removed. No worker was run. |

The target's six adjustments were: nil-aware Action Text allowlist, split list routes, positional `enum`, keyword JSON coder, explicit highlight getter/setter, and `show_exceptions = :none`. No failing assertion was removed or changed. The target is intentionally **not green**; no full fix set was implemented.

## Required compatibility work

### 1. Freeze a compatible target dependency resolution; do not widen the upgrade unnecessarily

**Affected:** [Gemfile](file:///home/user/workspace/repo/Gemfile), [lockfile](file:///home/user/workspace/repo/Gemfile.lock), [application defaults](file:///home/user/workspace/repo/config/application.rb#L9-L24).

- Ruby 3.3.6 meets Rails 8.1.0's Ruby ≥ 3.2 requirement. No Ruby upgrade is required.
- The real resolution retained Rack 2.2.24, Puma 5.6.9, Sidekiq 6.5.12, Redis 4.8.1, pg 1.6.0, Pagy 8.6.3, Faraday 1.10.4, Sprockets, importmap, Turbo, and Stimulus. **Rails 8.1.0 does not force Rack 3, Sidekiq 7, Redis 5, or a different asset/queue stack.** The Sidekiq adapter enqueue path was exercised, but full worker/server lifecycle compatibility remains unverified.
- A fresh resolution picked **JSON 3.1.0**. Rails 8.1.0 calls `JSON.parse(json, options)`; that JSON version requires keyword options. This broke serialized note tags, blob metadata and cookie/session decoding in the tested variant. For the exact target, constrain `json < 3` and retain the validated lockfile; the probe used **2.21.2**. Do not hide this with an application monkey patch. This finding is conditional on dependency resolution, not a claim about every historical Rails 8.1 lockfile.
- Adding `< 3` also permits current Ruby's JSON 2.7.2; the exact proposed current-version bundle after adding the constraint was not separately resolved. Keep `concurrent-ruby 1.3.4` while the 7.0 runtime remains in service; removing that pin is not needed here.

**Validation:** resolve and boot with the final locked graph; JSON-round-trip existing tag arrays, blob metadata, session cookies, and job envelopes. Test a real Puma request and worker startup, not just Bundler success.

**Sources:** [8.1.0 gemspec](https://github.com/rails/rails/blob/v8.1.0/rails.gemspec), [Action Pack dependencies](https://github.com/rails/rails/blob/v8.1.0/actionpack/actionpack.gemspec), [8.1.0 JSON decoder](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/json/decoding.rb); resolved JSON source and execution backtrace retained in evidence.

### 2. Preserve the complete Action Text allowlist when fixing initialization

**Affected:** [Action Text initializer](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3), rich-text notes and CSV bodies.

From 7.1, `ActionText::ContentHelper.allowed_tags` is nil until explicitly overridden; defaults are calculated at rendering time. `+=` therefore prevents boot even with 7.0 defaults. Build the override from the existing allowlist or the configured sanitizer's default tags, **including Action Text attachment, figure and figcaption tags**, then add `details` and `summary`. Do not replace it with just those two custom tags. The fallback expression used by the experiment is in `target-boot-only.patch` and is source-compatible with 7.0.8.7 as well.

**Validation:** existing collapsible-excerpt/XSS test and attachment rendering test; additionally save/reopen a note containing an old attachment SGID, links, captions, and collapsible content. Unsafe script/event/URL markup must still be removed. Actual browser round trips remain proposed.

**Source:** [Action Text 7.1.0 change](https://github.com/rails/rails/blob/v7.1.0/actiontext/CHANGELOG.md), [8.1.0 helper](https://github.com/rails/rails/blob/v8.1.0/actiontext/app/helpers/action_text/content_helper.rb).

### 3. Update Note declarations without changing their data contract

**Affected:** [Note declarations](file:///home/user/workspace/repo/app/models/note.rb#L8-L18), [tags/settings columns](file:///home/user/workspace/repo/db/schema.rb#L93-L104).

| Finding / condition | Recommendation and current-version compatibility | Discriminating validation |
|---|---|---|
| Keyword-form `enum` removed in Rails 8.0 | Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. **Works on 7.0**; other app enums already use this form. Keep numeric mapping and prefixed scopes/predicates unchanged. | Existing draft/ready records, `status_ready` scope, prefixed predicates, form radio values and filtering. |
| Positional JSON coder removed in 7.2 | Switch to `serialize :tags, coder: JSON` **only once running 7.1+**. On 7.0.8.7 that spelling silently used YAML in the executed probe! It is not a safe preparatory edit for current servers. | Read raw pre-upgrade JSON including `[]`, accented tags, ordered nonempty arrays; save/reload; verify newly written bytes are JSON and readable by the rollback build. Never test solely with newly created records. |
| `alias_attribute` of a non-column removed in 7.2; aliases also stop following custom accessors | `color` is a JSONB `store_accessor`, not a column. Replace `alias_attribute :highlight_color, :color` with explicit getter and setter delegating to `color`. **Works on 7.0**; retain JSONB and existing string key `"color"`. | Existing color renders selected; assigning highlight persists `settings["color"]`; blank and invalid colors follow existing validation. Existing request tests cover much of this. |

**Sources:** [Active Record 7.2.0 removals](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [8.0.0 enum removal](https://github.com/rails/rails/blob/v8.0.0/activerecord/CHANGELOG.md), [7.0.8.7 serialization implementation](https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb).

### 4. Fix the note-list routing, query, and unbound form

**Affected:** [routes](file:///home/user/workspace/repo/config/routes.rb#L17-L19), [notebook filter](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L7-L18), [search form](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12-L35).

- Rails 8.1 removes multiple paths in one route declaration. Declare `/notes` and `/journal` separately, retaining `notes_path` and `journal_path` and their same action.
- Rails 7.2 stops interpreting plural names as singular associations. Replace `where(notebooks: @notebook)` with `where(notebook: @notebook)` (or the explicit foreign key). The target generated SQL for a nonexistent `notes.notebooks` column. Keep the owned-notebook lookup and `current_user.notes` scope.
- Rails 8.0 rejects explicit `model: nil` in `form_with`. Omit `model:` from the unbound GET search form.

All three changes are **compatible with 7.0**. Validate both paths, an owned versus foreign notebook, filters combined with status/title, a non-first page, retained query parameters, and top-level unbound form fields. Existing list tests already supply useful asymmetric fixtures.

**Sources:** [Action Pack 8.1.0](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md), [Active Record 7.2.0](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md), [Action View 8.0.0](https://github.com/rails/rails/blob/v8.0.0/actionview/CHANGELOG.md).

### 5. Make failed CSV imports explicitly atomic — highest data-integrity priority

**Affected:** [Import#apply](file:///home/user/workspace/repo/app/models/import.rb#L50-L60).

A nonlocal `return false` from a transaction rolled back on 7.0. Rails 7.1 introduced committing as an opt-in/new default; 7.2 removed the old rollback behavior. Retaining 7.0 defaults on 8.1 **does not preserve it**.

Executed input: valid first row with new citation/rich text, then invalid second row. Current returned false and wrote nothing. Target returned false but persisted **one import, one note, one citation and one rich-text record**.

Replace the nonlocal return with an explicit rollback and return success from inside the transaction:

```ruby
transaction do
  save!
  rows.each { |row| raise ActiveRecord::Rollback unless row.note.save }
  true
end || false
```

Keep the initial `return false if invalid?`. This approach was exercised successfully on **both versions**, for success and later-row failure. Preserve per-row errors for the controller's error rendering; do not rescue every database exception into a validation failure.

**Validation:** submit an invalid batch directly to create, bypassing preview; assert all four record counts unchanged, first valid note absent, and second-row errors displayed. The existing import test has this intent but currently fails earlier on the target preview's missing annotation, masking the partial commit. If a bad build ever ran, audit partial imports before accepting a rollback as recovery; rolling back code cannot remove already committed rows safely.

**Sources:** [7.1.0 transaction change](https://github.com/rails/rails/blob/v7.1.0/activerecord/CHANGELOG.md), [7.2.0 removal](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

### 6. Preserve CSV annotations and citation receipts

**Affected:** [integer-key annotations](file:///home/user/workspace/repo/app/models/import.rb#L37-L42), [preview lookup](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22-L44), [receipt](file:///home/user/workspace/repo/app/models/import.rb#L63-L70), [DOI primary key](file:///home/user/workspace/repo/db/schema.rb#L55-L62).

- Rails 8.0 makes `HashWithIndifferentAccess#stringify_keys` stringify integer keys too. The preview converts source line numbers to strings but still looks them up by Integer, so annotations disappear. Remove the unnecessary `stringify_keys`; keep integer line keys end to end. **Works on 7.0.** Validate distinct annotations on lines 2 and 4 with a blank/multiline CSV row, including escaped markup.
- Since 7.2, `citation[:id]` no longer aliases the model's custom primary key. The target receipt probe produced a **blank DOI**, not an exception. Use `citation&.doi` (or `citation&.id`) explicitly. **Works on 7.0.** Validate cited and uncited rows in downloaded CSV, exact DOI case, and shared citation references. No schema or DOI migration is necessary.

**Sources:** [Active Support 8.0.0](https://github.com/rails/rails/blob/v8.0.0/activesupport/CHANGELOG.md), [Active Record 7.2.0](https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md).

### 7. Migrate citation configuration and retry policy at the right stage

**Affected:** [provider](file:///home/user/workspace/repo/app/models/citation/provider.rb#L1-L39), `config/secrets.yml`, [citation job](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L4-L9), provider integration tests.

- `Rails.application.secrets` is removed in 7.2. Load the existing environment-backed configuration explicitly with supported `config_for(:secrets)` into `config.x.citation_provider`, or move the same ENV mapping into that configuration directly; update the provider and test overrides to consume it. **Can be prepared on 7.0.** Preserve development/test defaults, production's absent-provider behavior, symbol keys, and exact string credentials. Renaming the YAML file is optional, not a framework requirement. Do not expose real secrets in logs.
- `retry_on ... wait: :exponentially_longer` is removed in 7.2. Use `:polynomially_longer` at the **7.1 bridge**, preserving three attempts and default jitter. That spelling **does not work on 7.0.8.7**; don't deploy it early. The target probe confirmed failure when handling an unavailable provider, after bypassing the separately failing secrets lookup.

**Validation:** fresh-process environment credentials including `00123` and punctuation; no provider configured; 401/404 immediate failure; recurring 503 produces at most six HTTP attempts and final failed status; retry delay windows and persisted attempt counts. Existing success tests alone do not execute the retry scheduling branch. Keep job class/argument names stable so queued citations and retries survive.

**Sources:** [Railties 7.2.0](https://github.com/rails/rails/blob/v7.2.0/railties/CHANGELOG.md), [Active Job 7.1.0](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2.0 removals](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md).

### 8. Pass a Time to reminder scheduling, preserving epoch storage and job identity

**Affected:** [Note#schedule_reminder](file:///home/user/workspace/repo/app/models/note.rb#L50-L83).

7.1 changed Active Job scheduling to Time objects; 7.2 removed numeric support. The target raises `undefined method utc for Integer` while serializing the job. Use `set(wait_until: Time.at(reminder_epoch).utc)`; leave the database bigint, validations, job ID comparison and row lock intact. The Time form was exercised on **both versions**, preserving the exact epoch 1793451617.

**Validation:** seconds that are not on a minute boundary; imported and manually selected times; replacement/postponement with both old and new jobs executing; deleted note; enqueue failure leaves the previous epoch/job ID intact. Test the real Sidekiq schedule score as well as the test adapter.

Old 7.0 Active Job payloads lack the new internal `scheduled_at` field; the Sidekiq schedule already owns their due time. Do not discard/recreate them simply because the application now passes Time. Validate a saved old full envelope at due time on the new worker, including retained `job_id`; this complete delayed-worker replay remains proposed.

**Sources:** [Active Job 7.1.0/7.2.0 changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1.0 core serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/core.rb).

### 9. Make digest dates explicitly UTC and arguments portable across workers

**Affected:** [User#request_digest](file:///home/user/workspace/repo/app/models/user.rb#L27-L57), [DigestJob](file:///home/user/workspace/repo/app/jobs/digest_job.rb), [DigestMailer](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L2-L12).

**Runtime behavior:** from 7.2, Active Job preserves the serialized TimeWithZone zone. The mailer currently relies on losing it and deriving UTC by accident. A request at October 5, 2026 03:30 UTC / October 4 23:30 Eastern produced **October 4** mail on the target, while the Redis reservation was still for October 5. Normalize `requested_at` to UTC in the mailer **before both `to_date` and `all_day`**. This works on 7.0, handles already queued values, and preserves the documented UTC-day feature. Consider passing UTC from the producer too; that is also cross-version safe.

**Wire format:** 7.1 introduced `BigDecimalSerializer`; 7.2 removed the legacy primitive behavior. New target jobs contain a typed serializer hash. Rails 7.0 workers cannot deserialize it — executed cross-read failed with unknown serializer. Old jobs carry a decimal string and new workers can read them. `DigestMailer` already accepts both through `BigDecimal(...)`; no new numeric conversion abstraction is needed.

**Recommendation:** prepare the producer to enqueue `reading_completion.to_s("F")` on **7.0**, with UTC normalization at the consumer. Portable UTC Time/string payloads were tested in both directions. Do not enable a BigDecimal serializer flag on 8.1: that transitional flag has been removed. If choosing typed BigDecimal instead, upgrade every consumer to a version that understands it before switching writers and prohibit rollback to 7.0 while such payloads exist.

**Validation:** both sides of UTC/local midnight, unequal note membership on the two dates, one request per UTC day, ratio 0.6667, JSON transport not just the Active Job test adapter, old → new and new → old consumers. Include retry/dead/scheduled sets, not only the ready queue. Preserve the two-day digest reservation keys during rollout; flushing Redis permits duplicate daily requests.

**Sources:** [7.1.0 serializer introduction](https://github.com/rails/rails/blob/v7.1.0/activejob/CHANGELOG.md), [7.2.0 timezone and serializer changes](https://github.com/rails/rails/blob/v7.2.0/activejob/CHANGELOG.md), [8.1.0 timezone serializer](https://github.com/rails/rails/blob/v8.1.0/activejob/lib/active_job/serializers/time_with_zone_serializer.rb).

### 10. Account for unconditional `to_time` behavior, even with old defaults

**Affected:** [next-day reminder calculation](file:///home/user/workspace/repo/app/models/note.rb#L35-L45), [preview](file:///home/user/workspace/repo/app/views/notes/_reminder.html.erb#L16-L20), reminder request test.

Rails 8.1's `TimeWithZone#to_time` preserves the zone, not just the fixed offset. Executed DST example: October 31 at 09:00 −04:00 plus 86,400 seconds becomes **November 1 at 08:00 −05:00**, whereas current displays 09:00 −04:00. The instant and 24-elapsed-hour postponement remain identical; this is a presentation/contract change, not a shifted reminder delivery.

Recommend accepting the zone-correct preview and making the elapsed-time intent explicit with `reminder_at + 24.hours`; it also works on 7.0 but deliberately changes the old preview there. Update the existing expectation and documentation as a separate behavior decision. If exact old fixed-offset presentation must remain, explicitly construct a fixed-offset Time instead. Do not use `1.day` if preserving 24 elapsed hours across DST is the contract, and do not expect `load_defaults 7.0` or the deprecated timezone setting to restore the old 8.1 behavior.

**Validation:** fall-back and spring-forward transitions, assert both displayed offset/wall time and exactly 86,400 seconds between epochs. Do not rewrite stored reminder epochs.

**Source:** [8.1.0 TimeWithZone implementation](https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/time_with_zone.rb).

### 11. Replace string `sum` in export generation

**Affected:** [Export#generate](file:///home/user/workspace/repo/app/models/export.rb#L32-L42).

Rails 7.1 removed Active Support's nonnumeric `Enumerable#sum` override. `fragments.sum` raises `String can't be coerced into Integer`. Use `fragments.join`, preserving heading, order and exact separators. **Works on current Rails.** Test empty notebook, multiple unequal bodies and actual downloadable bytes. Keep cancellation checks and stored progress unchanged; pending exports can continue on corrected workers without rewriting their job arguments or completed files.

**Source:** [Active Support 7.1.0 removal](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md).

### 12. Preserve exception assertions when updating test configuration

**Affected:** [test environment](file:///home/user/workspace/repo/config/environments/test.rb#L25-L40), authorization/error assertions throughout request tests.

Change boolean `show_exceptions = false` to `:none` at the **7.1 bridge**. Booleans were removed in 7.2; the target's fallback treats false as show-all, so existing `assert_raises` contracts would silently become rendered responses. The symbol is **not equivalent on Rails 7.0**. Do not copy the generated `:rescuable` test default unless deliberately converting those tests to response assertions.

The existing explicit `active_job.queue_adapter = :test` is already appropriate for Rails 7.2's consistent adapter handling. Retain it, but add separate real-adapter validation rather than changing the whole suite to Sidekiq.

**Sources:** [Action Pack 7.1.0](https://github.com/rails/rails/blob/v7.1.0/actionpack/CHANGELOG.md), [7.2.0](https://github.com/rails/rails/blob/v7.2.0/actionpack/CHANGELOG.md).

## Optional defaults and conditional adoption work

These must not be confused with the mandatory removals above. Source of truth: [Rails 8.1.0 `load_defaults`](https://github.com/rails/rails/blob/v8.1.0/railties/lib/rails/application/configuration.rb).

| Setting / affected app code | Condition and recommendation | Current compatibility and discriminating validation |
|---|---|---|
| Default column serializer; [Notebook preferences](file:///home/user/workspace/repo/app/models/notebook.rb#L7-L19) | 7.1 defaults set the implicit serializer to nil. `serialize :preferences` then fails. Explicitly retain **YAML**, e.g. `serialize :preferences, coder: YAML` on 7.1+. Do **not** change it to JSON merely to make the declaration resemble tags. Synthetic current data was `---\nexport_heading: ...`; deployed rows have not been audited. | The keyword spelling is not a reliable explicit-coder declaration on 7.0; make it at the bridge. Before adoption, read existing YAML/null values, edit heading, inspect raw bytes and read back on rollback runtime. Avoid introducing `type: Hash`/changed nil semantics without a separate need. |
| `raise_on_assign_to_attr_readonly`; [notebook settings controller](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L25-L40) and hidden slug field | Enabled by 7.1 defaults. Even assigning the **unchanged** persisted slug raises; tested on target. Remove slug from permitted input and the hidden field, retaining model `attr_readonly` and creation-time slug derivation. Or defer this default. | Removing that input works on 7.0 and preserves its effective persisted behavior. Test a normal settings save and forged changed slug, as well as new notebook name-derived slug. |
| PostgreSQL date decoder; [daily_note_counts](file:///home/user/workspace/repo/app/models/notebook.rb#L33-L40) | 7.2 defaults enable native Date decoding. With 7.0 defaults the target still returned String and this report worked; with decoding enabled on a fresh connection it failed at `Date.iso8601(Date)`. Normalize with `day.to_date`, or retain decoding disabled until ready. | `to_date` works for current ISO String and Date. Test an empty report plus UTC-near-midnight records, different local user zone, unequal counts, both decoder configurations. Do not treat the changelog's shorthand “defaults true” as proof it is enabled under this app's 7.0 defaults. |
| Invalid cache expiration; [export availability fragment](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L25-L37) | Caching is enabled in production and opt-in development. Expired exports compute a negative TTL. **Even without new defaults**, target drops that invalid TTL and can retain the expired fragment indefinitely (observed); 7.1 defaults additionally raise and break the page. Clamp the computed TTL to zero at minimum, or skip caching expired indicators with a nonnegative TTL. Merely switching to an already-past `expires_at` is insufficient: target converts it to negative `expires_in` too. | A nonnegative TTL works on 7.0. Exercise cache miss/hit immediately before, exactly at, and after expiry under enabled caching. Separately preserve authoritative expiry/ownership checks before any conditional download response. Existing cache test does not test target's new default unless explicitly enabled. |
| `strict_freshness`; [download controller](file:///home/user/workspace/repo/app/controllers/export_downloads_controller.rb#L4-L15) | 8.0 defaults prefer ETag when both conditional headers are supplied; legacy behavior requires both conditions. No code change is needed if accepting RFC semantics, but adoption needs its own test. | Flag is not available as such on 7.0; do not add it as a prep. With a matching ETag and too-old If-Modified-Since, legacy returns 200, strict returns 304. Test the inverse mismatch too; expired/foreign exports must never yield authorized 304s. Existing test uses both headers only after expiry, so it does not cover this difference. |
| HTML5 sanitizer / DOM testing | 7.1 defaults choose HTML5 when supported. This changes parsing of malformed stored/imported HTML; the allowlist boot repair is required regardless. Adopt deliberately, retaining custom safe tags and attachment markup. | New vendor settings belong on 7.1+. Compare old saved malformed lists/tables, details/summary, safe links, malicious markup and attachments through display **and edit/save**. No browser or historical-content corpus check was executed. |
| Enqueue-after-commit | App citation/reminder methods promise failed enqueue rolls back state under `with_lock`. With retained defaults, Rails **8.1.0 defaults this per-job setting to false**. Do not infer automatic deferral from release summaries. If adopting 7.2 defaults at an intermediate stage, that version sets `:default`, and its Sidekiq adapter inherits deferral; a Redis failure can then occur **after** pending state or replacement job ID commits. | Keep immediate behavior during upgrade (`:never` on 7.2, boolean false on 8.1 if setting explicitly). Those old symbols/global config are removed in 8.1; neither API exists on 7.0. Any deliberate switch to after-commit needs a redesigned failure/reconciliation contract, not just a config toggle. Validate real commit/rollback/enqueue-refusal without a surrounding test-fixture transaction masking callbacks. Native `ExportJob.perform_async` is not governed by Active Job's setting. |

Other generated-app choices — Propshaft, Solid Queue/Cache/Cable, Kamal, authentication scaffolding, new CI DSL, or `params.expect` — are **not required** to upgrade this existing application. No custom encrypted Active Record attributes, app-class manual `require`s, mailer preview paths, or ActiveStorage::BaseController subclasses were found; related upgrade-guide sections do not currently require application changes. Keep existing migration version declarations; schema alphabetization in 8.1 is dump formatting, not a data migration.

## Stored data, assets, mixed-version rollout and rollback

### Retain formats and secrets until old readers are retired

1. **Database:** preserve numeric enum values, JSON text tags, JSONB color, YAML preferences, DOI primary keys, and reminder epochs. No required application schema conversion was identified. Capture anonymized old-format rows and old attachments for staging; none of the production data was inspected. Do not backfill formats during a compatibility deploy. If YAML accidentally gets written into tags by an early keyword-coder change, treat it as a data repair problem — rolling back code alone is not enough.
2. **Sessions/signatures:** keep production `secret_key_base`, cookie key, and existing digest/serializer settings stable. Rails 7.0 defaults already use SHA256 key generation and JSON cookies; the older 6.1→7.0 cookie rotator advice is not itself a requirement here. In development/test, preserve the old `tmp/development_secret.txt` value as `tmp/local_secret.txt` before a real local-data upgrade; copying it rather than deleting the old file also preserves rollback. Experiments intentionally used fresh synthetic keys and did not establish cross-version cookie/signature compatibility.
3. **Message formats:** 7.1 defaults change general message serialization to `:json_allow_marshal` and metadata encoding. Active Storage uses the application's message verifier; Action Text stores signed attachable identifiers inside HTML. New readers accepting old tokens does **not** prove old readers accept new ones. Leave these switches in legacy mode during a mixed deployment/rollback window, or deploy and test readers/rotations first. Test old → new **and new → old** session cookies, blob signed IDs, attachment SGIDs and Disk service links with identical test secrets/purposes/expiry. Stored HTML tokens can live indefinitely, so “wait for a session TTL” alone is not sufficient.
4. **Cache format:** target supports keeping 7.0 cache format. Adopt 7.1 format only after old cache readers/rollback builds are out of play, or use a new namespace and cold cache. Production uses Rails' default file store unless deployment overrides it; development uses memory/null and tests null/temporary memory stores. There is no configured Redis application cache. Determine whether production `tmp/cache` is shared across releases before assuming any mixed-reader exposure. Cache entries are disposable; database records, queues and uploaded files are not.

Sources: [tagged upgrade guide](https://github.com/rails/rails/blob/v8.1.0/guides/source/upgrading_ruby_on_rails.md), [7.1 cache/message changes](https://github.com/rails/rails/blob/v7.1.0/activesupport/CHANGELOG.md), [Active Storage verifier](https://github.com/rails/rails/blob/v8.1.0/activestorage/lib/active_storage/engine.rb).

### Queue rollout must include future and retried work

- Inventory ready, scheduled, retry and dead jobs before rollout. Reminders may be far in the future; draining today's ready queue is not a compatibility strategy for them.
- Deploy the UTC/decimal-string digest preparation to **all producers**, and compatible consumer behavior to all workers before allowing a new writer format. Keep job names, GlobalID model names, queue names, job IDs and native export argument shape stable.
- If any target typed-BigDecimal jobs were already enqueued, old 7.0 consumers cannot safely resume until those jobs are handled by compatible consumers or deliberately converted with preserved IDs/attempt metadata. Do not purge them or broadly re-enqueue: reminders rely on exact job ID matching and digests/emails are not exactly-once.
- A supported full-envelope replay rehearsal should cover an old scheduled reminder, stale replacement reminder, deleted note, in-flight citation retry, native export, and old/new digest payloads through actual workers. The assessment executed argument serialization and real enqueue/readback, **not full worker replay or restart/drain behavior**.
- Preserve Redis digest reservation sets and completed export blobs across both rollout and rollback. Deploying old code does not undo new database writes, outgoing email or a partial import.

### Trix is a separate browser/runtime decision

[The layout](file:///home/user/workspace/repo/app/views/layouts/application.html.erb#L9-L14) explicitly serves vendored **Trix 1.3.5**, while [actiontext.css](file:///home/user/workspace/repo/app/assets/stylesheets/actiontext.css#L1-L9) requires the gem-provided `trix` stylesheet and importmap serves the new `@rails/actiontext` JS. Rails 8.1 extracts Trix into `action_text-trix`; this resolution installed **2.1.19**. Upgrading Rails therefore does **not** automatically replace the old editor script and may leave a mixed editor/CSS/integration combination.

Choose and validate a coherent editor/stylesheet/integration set. Updating to gem-supplied Trix 2 is a separate browser-facing change, not proof that the current override is broken; no incompatibility was established by a browser run here. Do not load both editor scripts. Precompile and inspect the actual resolved JS/CSS assets; exercise Turbo navigation, saved links, old SGID attachments, direct uploads at 1 MB and above, captions, validation errors, and reopening then saving historical HTML. The current editor's flattening of details/summary is already documented behavior, not a new Rails regression. Back up rich text before testing write-time editor normalization; code rollback cannot reconstruct structure already flattened by an editor.

Source: [Action Text 8.1.0 changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md).

### Optional Sidekiq modernization is a separate scope

The built-in adapter still exists on Rails 8.1.0 and the actual enqueue smoke worked with 6.5.12. It is deprecated for removal in 8.2, which asks for Sidekiq ≥ 7.3.3. Schedule that upgrade separately rather than claiming it is required by 8.1.

If combined later, review native [export options](file:///home/user/workspace/repo/app/models/notebook.rb#L22-L30) (`{ format: "markdown" }` is not strict JSON), [digest Redis boolean membership](file:///home/user/workspace/repo/app/models/user.rb#L35-L44), Redis client/error APIs and server requirements. Prepare string-key native arguments and verify duplicate-reservation behavior instead of disabling strict argument checks. Existing 6.5 emits warnings, not errors. This assessment did not test Sidekiq 7/Redis-client migration.

## Recommended execution sequence and acceptance gates

1. **Preparation on 7.0.8.7:** atomic import rollback, explicit citation DOI, integer annotation keys, string join, singular notebook query, omit nil form model, separate routes, positional enum, explicit highlight accessors, supported provider configuration, Time scheduling, UTC digest consumption and decimal-string arguments, nonnegative cache TTL. Readonly-form input removal can be prepared now. Keep tests green and inspect raw serialized data. Do **not** apply keyword coders, `:polynomially_longer`, or `show_exceptions: :none` early.
2. **Bridge 7.1 with 7.0 defaults:** use an appropriate patch release, review `app:update` interactively, fix Action Text initialization if not already prepared, switch coder declarations explicitly to JSON for tags/YAML for preferences, retry symbol and exception config. Preserve keys and legacy cache/message formats. Re-run checks and resolve deprecations before advancing.
3. **7.2 → 8.0 → exact 8.1.0:** retain old defaults initially and a validated dependency lock. Check the timezone/serialization changes, route removals and actual worker startup at each step. Intermediate-version runtime tests were not executed in this assessment; they remain gates, not implied successes.
4. **Compatibility rehearsal:** restore an anonymized old-format database plus matching blob storage into isolated staging; replay representative old/new jobs and signatures in both directions; simulate unavailable Redis/provider, rollback, worker restart and cache expiry. Keep production mail disabled during the rehearsal. A copied checkout without separate services is not isolation.
5. **New defaults separately:** adopt YAML/readonly/date/HTML5/cache/freshness settings one at a time after their specific checks. Handle queue deferral's changed failure contract explicitly. Only then raise `load_defaults`, with legacy overrides retained for any still-open rollout window.

For the completed candidate, execute `bundle check`, `bin/rails zeitwerk:check`, full request/model suite, migration-from-empty and migration-on-restored-data checks, production-style eager boot and asset precompile, browser workflows, and real worker smoke/replay using disposable resources. Run `bin/rails test:system` only with a real nonempty browser suite: **there are currently no system test cases**, just its base class. A successful empty invocation would not validate Trix/Turbo.

## Remaining questions / unverified boundaries

- What production PostgreSQL/Redis versions, worker topology, shared cache paths, secret sources and rollback horizon are used? Only local PostgreSQL 15.19 and the repository's declared configuration were examined.
- Are there historical YAML values beyond the ordinary hash/null preferences this code writes, malformed rich text, old signing keys, or queued custom payloads? No production database, storage or queue was read.
- Browser behavior, full worker execution/lifecycle, signature interoperability, asset precompilation and intermediate-version runtimes remain **proposed checks**. The existing tests and scratch probes do not establish them.
- Production mail delivery/host configuration and private-attachment access policy are already incomplete in this sample. Rails upgrade defaults do not solve those pre-existing deployment concerns; they were not changed.

**Delivery state:** local assessment and reproducible evidence only. No working-application upgrade, commit, push, deployment, production migration or production-data change was performed.
