**Rails 8.1.0 is feasible on the pinned Ruby 3.3.6, but this is not a Gemfile-only upgrade.** Several app APIs are removed, and job/time behavior can change independently of `config.load_defaults`.

This is a source-based assessment; I did not boot the app, resolve a target bundle, run tests, or access its databases, Redis, or storage. No application files were changed.

## Required compatibility work

Paths below are relative to the repository root.

| Affected code | Finding and recommendation | Discriminating validation |
|---|---|---|
| `config/routes.rb` | Rails 8.1 rejects multiple paths in one route declaration. Split `get "/notes", "/journal"` into separate declarations, preserving the canonical `notes_path`. **Works on 7.0.** | Boot routes; request both URLs and confirm pagination still generates `/notes`. |
| `config/initializers/action_text.rb` | In 8.1, `ActionText::ContentHelper.allowed_tags` starts as `nil`; `+=` fails. Construct the effective default allowlist—including `action-text-attachment`, `figure`, and `figcaption`—then add `details`/`summary`. **Can be prepared on 7.0.** | Eager-load; render saved collapsible content and an attachment; verify scripts remain stripped. |
| `app/models/note.rb` | Keyword-style `enum` is removed in Rails 8. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. **Works on 7.0.** Existing integer values need no conversion. | Verify status scopes, predicates, form selection, and stored integers. |
| `app/models/note.rb` | Positional `serialize :tags, JSON` is removed in 7.2. Use `coder: JSON` on the newer framework. **Not an equivalent preparation on 7.0**, whose serializer selects its coder from the positional argument. | Read existing JSON text; edit tags; inspect raw stored text; read the result with the rollback version. |
| `app/models/note.rb` | `alias_attribute :highlight_color, :color` targets a JSON store accessor, not a database column. Rails 7.2 removes this support. Replace with explicit getter/setter delegation to `color`. **Works on 7.0.** | Submit a non-default highlight; reload and verify both rendered selection and `settings["color"]`. |
| `app/models/citation/provider.rb`, `config/secrets.yml`, citation request tests | `Rails.application.secrets` is removed in 7.2. Move provider configuration to an explicit environment-backed configuration object or credentials, preserving local defaults and production’s missing-setting behavior. Update tests that mutate `secrets`. **Can be prepared on 7.0.** | Fresh-process boot with alternate credentials against the loopback provider; verify authentication and missing configuration without logging secrets. |
| `app/models/import.rb` | `return false` inside `transaction` no longer guarantees rollback. A valid first row followed by an invalid row can leave partial imports. Explicitly raise `ActiveRecord::Rollback` and return failure outside the block. **Works on 7.0.** | Apply a valid-first/invalid-second CSV; assert no import, notes, citations, or rich texts persist. The existing request test is relevant but was not executed here. |
| `Import#receipt` | `citation[:id]` no longer maps to the custom primary key `doi`. Use `citation.doi`. **Works on 7.0.** | Download a receipt containing a DOI, plus a note without a citation. |
| `CitationEnrichmentJob` | `wait: :exponentially_longer` is removed in 7.2. Rename to `:polynomially_longer` starting with 7.1. **The new symbol is not supported on 7.0**; a compatible callable can bridge versions if necessary. | Return repeated 503s; verify retry delays, three total job attempts, and final failed enrichment state. |
| `Note#schedule_reminder` | Numeric `wait_until: reminder_epoch` is no longer supported; 8.1 serializes `scheduled_at` as a time. Pass `Time.at(reminder_epoch).utc`. **Works on 7.0.** | Inspect the real queue score and execute immediately before/after the requested instant. |
| `Note#next_day_reminder_at` | Rails 8.1’s `TimeWithZone#to_time` preserves the named zone, not merely a fixed offset. Adding 86,400 seconds can change the displayed offset across DST, contrary to the method’s documented contract. Use an explicitly fixed-offset `Time` if retaining that contract. **Can be prepared on 7.0.** | At 2026-10-31 09:00 Eastern, verify the preview remains 2026-11-01 09:00 −04:00 while the scheduled epoch advances exactly 86,400 seconds. |
| `config/environments/test.rb` | Replace `show_exceptions = false` with `:none` on newer Rails; 8.1’s exception wrapper otherwise treats it as the default rendering mode. **Do not use this as a 7.0 preparation.** | Unauthorized resource requests must still raise `RecordNotFound` in integration tests. |
| `app/views/imports/preview.html.erb` | The code stringifies annotation keys, then looks them up using integer line numbers. Newer `HashWithIndifferentAccess` inherits actual key stringification rather than the old no-op. Use `annotations[row.line.to_s]`, or omit unnecessary stringification. **Works on 7.0.** | Preview annotations on different source lines, including quoted multiline CSV rows. |

## Job payloads and mixed-version rollout

**Digest behavior needs an explicit decision before deployment.**

- `User#request_digest` queues a zoned time and `BigDecimal`. Rails 8.1 preserves the argument’s named zone; the old serializer reconstructs it in the job’s zone. Consequently, `DigestMailer` can select a different day near midnight.
- Newer Rails serializes `BigDecimal` with a dedicated serializer. Rails 7.0 lacks that serializer, so old workers cannot safely consume all newly produced payloads.

To preserve the current UTC-day contract, prepare the producer on 7.0 to pass `requested_at.utc` and `reading_completion.to_s`. Validate at 03:30 UTC when Eastern is still on the previous date, with notes on both dates and a nontrivial completion fraction.

Run old→new and new→old payload checks through a **real JSON queue round trip**. Existing Active Job test-adapter checks do not establish that compatibility.

For reminders, enrichment retries, and framework jobs, inventory scheduled/retry/dead queues—not just ready jobs. Avoid overlapping unverified producer/consumer versions. Preserve job IDs because reminders use them to suppress superseded work; preserve digest reservation keys and their TTLs.

## Optional defaults—not prerequisites

Initially retain `config.load_defaults 7.0`, then adopt defaults separately:

- **Notebook preferences:** 7.1 defaults remove the implicit serializer. Explicitly retain YAML before changing defaults; do not relabel existing YAML as JSON. `serialize :preferences, YAML` is valid on 7.0; use the keyword form later. Validate existing rows and rollback reads.
- **Read-only slugs:** 7.1 defaults raise on assignment, while the notebook form resubmits `slug`. Stop assigning it during updates if adopting this default; that preparation works on 7.0.
- **Activity reports:** 7.2 defaults decode PostgreSQL dates as `Date`; `Date.iso8601(day)` then becomes invalid. Normalize with `day.to_date`, compatible with both returned forms and 7.0.
- **Messages, caches, and signatures:** defer new metadata/message/cache formats until rollback compatibility is demonstrated. Preserve `secret_key_base`; in development/test preserve the old secret when moving to `tmp/local_secret.txt`. Test existing sessions, attachment SGIDs, and blob links in both directions.
- **Editor:** this app deliberately vendors Trix 1.3.5. Validate it with Action Text 8.1 before replacing it; inspect saved links, attachments, collapsible HTML, editing, and re-saving.
- Keep Sidekiq, Sprockets, and the existing storage backend initially. Solid Queue, Solid Cache, and Propshaft are not required migrations.

Sidekiq 6.5.12’s Rails adapter remains available in 8.1 but is deprecated. A Sidekiq upgrade is a separate risk: Redis client return values affect `User#request_digest`, and native `ExportJob` arguments must retain their string-key JSON contract. Target dependency resolution remains unverified; I found no basis to declare Rack 3 mandatory for Rails 8.1.

## Recommended execution plan

1. Make and verify the 7.0-compatible preparations above.
2. Upgrade sequentially through 7.1 → 7.2 → 8.0 → 8.1.0, resolving dependencies and reviewing `app:update` diffs at each step.
3. In disposable environments, isolate PostgreSQL—including parallel test databases—Redis, cache, storage, mail output, and provider endpoints. Retain each variant’s lockfile, configuration, command, stdout/stderr, and logs.
4. Run eager loading, request/model tests, browser workflows, real-worker execution, and the cross-version data/payload checks above.
5. Back up database **and attachment storage**; deploy with a tested queue handoff and rollback procedure. Do not rewrite stored formats or adopt new defaults in the initial framework deployment.

Upstream basis: [versioned upgrade guide](https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html), [7.2 removals](https://guides.rubyonrails.org/v8.1.0/7_2_release_notes.html), [8.0 removals](https://guides.rubyonrails.org/v8.1.0/8_0_release_notes.html), and tagged Rails 7.0.8.7/8.1.0 source for serializers, routing, sanitization, time conversion, configuration defaults, and exception handling.

**Delivery state:** assessment only. Production data shapes, queue inventory, deployment overlap, target dependency resolution, and runtime compatibility remain to be verified.