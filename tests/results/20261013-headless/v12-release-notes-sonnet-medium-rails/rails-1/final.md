# Upgrade plan: rails 7.0.8.7 to 8.1.0 for Margin Notes

The upgrade is feasible, but it is not a version bump. Without changes, `bin/rails test` cannot even boot on 8.1.0. After 15 repairs the suite passes on 8.1.0 (46 runs, 340 assertions, 0 failures) with `load_defaults 7.0` kept. Most repairs also run on 7.0.8.7, so they can ship before the gem change. A few only work on 8.1 and must ship with it.

The working application is untouched (`git status` clean). All experiments ran in copies under `/tmp/plan` with their own `plan_*` PostgreSQL databases and their own Redis server on port 6391. I dropped the databases and stopped that Redis afterwards. The default `margin_notes_*` databases and the default Redis were not used.

Evidence labels: **[E]** means I executed it. **[S]** means it comes from reading source or the changelog. **[P]** means a check I propose but did not run.

## 1. Experiments and where to find them

| Item | Path |
|---|---|
| Changelog index (1360 lines) | `/tmp/plan/changes.txt` |
| 7.0.8.7 baseline copy | `/tmp/plan/base`; tests `/tmp/plan/base-test.log`, 46 runs, 0 failures |
| 8.1.0 copy with repairs | `/tmp/plan/up`; repairs summarised in `/tmp/plan/app.diff`, `config.diff`, `test.diff` |
| Wholesale `load_defaults` 7.1, 7.2, 8.0 and 8.1 | `/tmp/plan/def`; logs `/tmp/plan/def-7.1.log` to `def-8.1.log` |
| 7.0.8.7 with the compatible repairs only | `/tmp/plan/prep`; `/tmp/plan/prep-test2.log`, 46 runs, 0 failures |
| Failure logs from the repair sequence | `/tmp/plan/up-test-1-boot-failure.log` to `up-test-9.log` |
| Job payloads and cross-version runs | `/tmp/plan/payload-base.json`, `payload-up.json`, `crossversion.log`, `crosssgid.log` |
| Scripts | `/tmp/plan/enqueue.rb`, `execute.rb`, `flow.sh`, `flow2.sh`, `rollback.rb`, `sgid_out.rb`, `sgid_in.rb` |

**Commands.** I ran `MISE_RUBY_VERSION=3.3.6 REDIS_URL=redis://localhost:6391/N bin/rails test` in each copy. I changed the 8.1 copy with `bundle update rails --conservative`, then `bundle update json --conservative`.

**Resolved dependencies.** `/tmp/plan/lock.diff` has the full diff. Rails moves to 8.1.0, `action_text-trix` 2.1.19 is added, `bigdecimal` 4.1.3 is added, and `json` 2.21.2 is pinned. `concurrent-ruby` 1.3.4, `sidekiq` 6.5.12, `redis` 4.8.1, `puma` 5.6.9, `rack` 2.2.24, `faraday` 1.10.4 and `minitest` 5.27.0 are unchanged and all work.

**Configuration.** I kept `config.load_defaults 7.0`. Dev and test databases and Redis were isolated as described above. For the cookie test I copied the dev secret into the 8.1 copy.

## 2. Required changes

Each row is something that breaks on 8.1.0 if left alone. The "Also valid on 7.0" column says whether the repair can ship before the gem bump. I checked this on the `/tmp/plan/prep` copy (46 runs, 0 failures); the items marked ✔ were applied there, so the check covers them.

| # | Affected code and what happens (observed unless marked) | Repair | Also valid on 7.0 |
|---|---|---|---|
| 1 | `json` resolves to 3.1.0 and 8.1.0 fails on it. `ActiveSupport::JSON.decode` calls `JSON.parse(json, {})` and fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`. This broke the `Note#tags` read, `/tmp/plan/up-test-4.log`. | Add `gem "json", "< 3"` (resolved to 2.21.2), or move to a later 8.1.x patch. I did not test whether a later patch fixes it. | Not needed on 7.0 |
| 2 | `config/initializers/action_text.rb` does `allowed_tags +=`. On 8.1 `allowed_tags` is nil at that point, so boot dies with `undefined method '+' for nil`, `/tmp/plan/up-test-1-boot-failure.log`. | Compute the base set first, as in `/tmp/plan/up/config/initializers/action_text.rb`: `allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]`, then add `details` and `summary`. | ✔ |
| 3 | `Note`: `enum status: {...}, _prefix: true` fails with `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. | `enum :status, { draft: 0, ready: 1 }, prefix: true`. The generated methods keep the same names. | ✔ |
| 4 | `Note`: `serialize :tags, JSON` fails with `given 2, expected 1`. | `serialize :tags, coder: JSON`. | ✘ The keyword form only exists from 7.1, so it ships with the bump. |
| 5 | `Note`: `alias_attribute :highlight_color, :color` fails with `Note model aliases 'color', but 'color' is not an attribute`. `color` is a `store_accessor`. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Both are needed because `notes_controller` permits `:highlight_color`. Do not use `store_accessor :settings, :highlight_color`; it would store under a new JSON key and orphan existing data. | ✔ |
| 6 | `config/routes.rb`: `get "/notes", "/journal", to:` fails with `Wrong number of arguments (expect 1, got 2)`. The `digest_path` and `notes_path` errors in the same log are consequences. | Two routes. Route names `notes` and `journal` are unchanged. | ✔ |
| 7 | `Rails.application.secrets` is removed, so `Citation::Provider` raises `NoMethodError: undefined method 'secrets'`. | Add `config/initializers/citation_provider.rb` with `Rails.configuration.x.citation_provider = Rails.application.config_for(:secrets).citation_provider`. Read that value in `Provider`. Update the test that overrides the settings, and the `ARCHITECTURE.md` and `CONTRIBUTING.md` text. `config/secrets.yml` stays as a plain YAML file. Confirm production gets `secret_key_base` from credentials or `SECRET_KEY_BASE`. The file has no such key, and nothing reads it as secrets on 8.x. | ✔ |
| 8 | `config/environments/test.rb`: `show_exceptions = false` is now treated as "show". Tests that expect a raise report `ActiveRecord::RecordNotFound expected but nothing was raised`. 8.1 `ExceptionWrapper#show?` treats anything except `:none` and `:rescuable` as true. | Set `:none`. | ✘ On 7.0 the symbol is truthy, so it would show exceptions. Ship with the bump. |
| 9 | `Export#generate`: `finish(fragments.sum)` on strings gives `TypeError: String can't be coerced into Integer`. A real Export job failed on 8.1 until this was fixed. | `fragments.join`. | ✔ |
| 10 | `CitationEnrichmentJob`: `wait: :exponentially_longer` is removed. The error is `Couldn't determine a delay based on :exponentially_longer`. In production this fires only on the first provider failure, so it is latent. | `:polynomially_longer`. It uses the same formula, with 15% jitter by default. | ✘ The name is 7.1+. The 7.0-safe alternative is `->(executions) { executions**4 + 2 }`. I recommend `:polynomially_longer` at the bump, because the lambda has no jitter. |
| 11 | `Note#schedule_reminder`: `wait_until: reminder_epoch` (an Integer) gives `NoMethodError: undefined method 'utc' for Integer`, so the reminder endpoints return 500. | `wait_until: Time.at(reminder_epoch)`. A real Sidekiq enqueue produced the same schedule score, 1893499200, on 7.0 and on 8.1. | ✔ |
| 12 | `NotesController#index`: `where(notebooks: @notebook)` fails with `PG::UndefinedColumn: column notes.notebooks does not exist`. This breaks the notebook filter. | `where(notebook: @notebook)`. The notebook is already scoped to the current user. | ✔ |
| 13 | `notes/index.html.erb`: `form_with(model: nil, ...)` fails with `Passed nil to the :model argument, expect an object or false`. The note list and the post-sign-in page return 500. | Drop `model: nil`. | ✔ |
| 14 | `imports/preview.html.erb`: `@import.annotations.stringify_keys` now converts the Integer line keys to Strings, so `annotations[row.line]` is nil. The preview silently drops every annotation. | Use `@import.annotations` directly. | ✔ |
| 15 | `Import#apply`: `return false` inside `transaction do` now commits. Before, it rolled back. The 8.1 copy saved valid rows from an invalid CSV, counts `[1,4,1,2]` instead of `[0,3,0,1]`, `/tmp/plan/up-test-8-before-import-fixes.log`. Source check: 8.1 has no `commit_transaction_on_non_local_return` setting at all. Of the transaction and lock blocks in `app/` (`Import#apply`, `with_lock` in `Citation`, `Export` and `Note`), only `Import#apply` returns from inside. | `saved = transaction { save!; rows.all? { \|r\| r.note.save } \|\| raise(ActiveRecord::Rollback) }`, then return `saved ? true : false`. This keeps the preview and the creation paths working. | ✔ |
| 16 | `Import#receipt`: `citation[:id]` returns nil for a record whose primary key is `doi`, so the CSV receipt has empty DOI cells. | `citation&.id`. | ✔ |
| 17 | `Note#next_day_reminder_at`: `TimeWithZone#to_time` is now always `getlocal(time_zone)`. In 8.1 `to_time_preserves_timezone` is deprecated and its value is ignored, so `load_defaults 7.0` does not preserve the old behavior. A reminder at 09:00 -04:00 on 31 Oct previews as `2026-11-01T08:00:00-05:00` instead of `09:00-04:00`. The scheduled instant is the same, 13:00Z. Only the display changes, in the "24 hours later" preview and the postpone label. | The app documents the old behavior in `ARCHITECTURE.md`. Preserve it with `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. The alternative is to accept the new display and rewrite the docs and the test, which is a product decision. I recommend preserving. | ✔ |
| 18 | `DigestMailer`: the digest date was the worker's UTC day. The queued time now keeps the reader's zone on deserialize, because the 8.1 payload gains `time_zone`. The digest day shifted from "October 05" to "October 04" in the test. | `requested_at.utc.to_date` and `requested_at.utc.all_day`. This matches the documented UTC-day contract and the Redis reservation day. | ✔ |

## 3. Mixed-version rollout, stored data and rollback

**BigDecimal job argument (observed, `/tmp/plan/crossversion.log`).**
- 8.1 serializes `BigDecimal` job arguments with `ActiveJob::Serializers::BigDecimalSerializer` even under `load_defaults 7.0`. Rails 7.0 sent a plain string.
- A `DigestJob` enqueued by an 8.1 web process and run on a 7.0 worker fails with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- Fix: pass `reading_completion.to_s` in `User#request_digest`. `DigestMailer` already does `BigDecimal(params[:completion])`. The payload is then the string `"0.6667"` on both versions. Deploy this on 7.0 first.
- Test status: the string-argument version passed the test suite on 7.0 in `/tmp/plan/prep`. I did not execute its payload across versions. I also did not apply it in the 8.1 copy, so a failing `DigestJob` run there still needs a check.

**Other queued payloads (observed).**
- 7.0 digest and reminder payloads run correctly on 8.1. The digest correctly covers the UTC day.
- 8.1 reminder payloads, which add `scheduled_at`, run on 7.0.
- The 8.1 `TimeWithZone` payload adds a `time_zone` key, which 7.0 ignores.
- `ExportJob` is a native Sidekiq job with an unchanged payload.
- The 7.0 `CitationEnrichmentJob` payload was not run on 8.1. The GlobalID format is identical in both payloads, so this is source-level confidence only.

**Stored data (observed).** There are no migrations and no schema change.
- `notes.tags` JSON, `notes.settings` jsonb (`color`), `notebooks.preferences` YAML and rich text bodies all read and write on 8.1.
- The YAML written by 8.1 is the same text, `"---\nexport_heading: Hi\n"`.
- Signed global IDs and Active Storage signed IDs created on 7.0 read on 8.1, and the reverse.
- Pages rendered by 7.0 and 8.1 from the same data were diff-identical. Exceptions are timestamps and one extra zone, "Asuncion", in the account time-zone list. This is additive and does not invalidate stored zones.

**Sessions (observed).** A session cookie signed on 7.0 works on 8.1 and the reverse, with the same secret. `config/boot.rb` and `Rails.application.secret_key_base` must stay the same in production.

**Rollback.** With only the required changes, rolling back means reverting the Gemfile and lockfile plus the code. The only 8.1-written state that 7.0 cannot read is the `BigDecimal` and `time_zone` job payloads. Item 18 and the `.to_s` change cover them. See also the rollback risk in section 4.

## 4. Optional default adoption by release

The app stays on `load_defaults 7.0`. I recommend adopting defaults later in separate steps, using `new_framework_defaults_X_Y.rb` files, rather than in this upgrade. Everything in the "tested" lines below comes from the `/tmp/plan/def` copy, which already contains the repairs above.

**7.1** (tested: three suite errors)

| Setting | Kept old value? | Effect if adopted |
|---|---|---|
| `active_record.default_column_serializer = nil` | Yes | `Notebook`'s `serialize :preferences` raises `ArgumentError: missing keyword: :coder`. It needs `coder: YAML`. This is not backward compatible with 7.0. |
| `raise_on_assign_to_attr_readonly = true` | Yes | `ReadonlyAttributeError: slug` on notebook update, because the settings form resubmits `slug` and `attr_readonly :slug` silently ignores it today. The controller would need to stop permitting `:slug` or drop it from the update params. |
| `raise_on_invalid_cache_expiration_time = true` | Yes | `exports/_export.html.erb` caches with `expires_in: export.expires_at - Time.current`, which is negative for expired exports. The error is `Cache expiration time is invalid, cannot be negative: -60.0`. Clamp it with `[x, 0].max` and skip caching when expired. |
| `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | Yes | New sgids in stored rich text and signed ids are JSON. A 7.0 process reading them fails with `NoMethodError: undefined method 'unpack1' for nil`. **Rollback hazard.** Use the two-step rollout from the 7.1 upgrade guide. |
| `active_record.marshalling_format_version = 7.1`, `active_support.cache_format_version = 7.1` | Yes | Affects the cache format. Production uses a file store and dev/test use `:null_store`. Rolling deploys on a shared cache dir are untested. |
| `action_view.sanitizer_vendor`, `action_text.sanitizer_vendor` (HTML5), `dom_testing_default_html_version = :html5` | Yes | Tests pass, including the rich-text test that keeps `details`/`summary` and drops scripts. Behavior on malformed stored HTML is untested. |
| `precompile_filter_parameters`, `add_autoload_paths_to_load_path = false`, `debug_exception_log_level = :error`, `log_file_size` | Yes | No observed effect. |
| Encryption hash and SHA-1 settings, `generate_secure_token_on`, SQLite strict strings, `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `belongs_to_required_validates_foreign_key`, `allow_deprecated_singular_associations_name`, `query_log_tags_format`, `commit_transaction_on_non_local_return` (no longer a setting in 8.1) | Yes | [S] Not used, or not relevant to this code (no `encrypts`, no `has_secure_token`, no SQLite, no model callbacks). |
| `active_job.use_big_decimal_serializer` | n/a | The flag does not gate the serializer in 8.1 (see section 3). |
| `action_controller.allow_deprecated_parameters_hash_equality = false` | Yes | [S] `params` is never compared to a Hash in `app/`. |

**7.2**
- `postgresql_adapter_decode_dates = true` (tested): `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String` at `Date.iso8601(day)`. Drop the `iso8601` call or branch on `Date`.
- `yjit = true`: enables YJIT, with a possible memory increase.
- `active_storage.web_image_content_types` adds `image/webp`: [S] no effect, because the app uses no variants.
- `validate_migration_timestamps = true`: no effect, because the 12 migrations have valid timestamps.
- `active_job.enqueue_after_transaction_commit = :default`: the built-in Sidekiq adapter in 8.1 still enqueues inside the transaction. With Redis down, `request_enrichment`, `schedule_reminder` and `request_export` all rolled back identically under 7.0 and 8.1 defaults, `/tmp/plan/rollback.rb`. This may change when the sidekiq gem is upgraded and its own adapter is used. Retest then.

**8.0**
- `to_time_preserves_timezone = :zone`: already ignored (item 17).
- `strict_freshness = true`: affects only requests that send both `If-None-Match` and `If-Modified-Since` to `ExportDownloadsController#show`. A 200 and 304 probe of the current behavior is in `/tmp/plan/flow2-up.log`.
- `Regexp.timeout = 1` is also set. The only regexp in the app, the DOI format, is simple.

**8.1** (not individually exercised; read from `configuration.rb` and tested only as part of the 8.1 defaults run)
- `escape_json_responses = false`: no JSON endpoints.
- `action_on_path_relative_redirect = :raise`: the app only redirects to path helpers and the absolute `/notes`.
- `raise_on_missing_required_finder_order_columns = true`: `Citation` has a primary key, so no effect.
- `remove_hidden_field_autocomplete = true`: the Trix hidden input loses `autocomplete="off"`.
- `render_tracker = :ruby`: needs Prism and will regenerate the `cache` digests once.
- `yjit` becomes `!Rails.env.local?`.

**Result of the wholesale defaults runs.** Across `load_defaults` 7.1, 7.2, 8.0 and 8.1, the only failures were the three above (slug readonly, negative cache expiry, Date type), plus the `serialize :preferences` coder error. Everything else passed.

## 5. Other observations

- **Sidekiq adapter deprecation (observed):** `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later`. Sidekiq 6.5.12 with Rails 8.1.0 works: I enqueued, scheduled and ran real jobs through a Sidekiq worker. This is not a blocker for 8.1.0. Plan a Sidekiq 7 move before 8.2.
- **Missing `image_processing` warning (observed, production boot):** `Generating image variants require the image_processing gem... set config.active_storage.variant_processor = :disabled`. Low severity; the app uses no variants.
- **Trix (partly verified):** 8.1 bundles Trix 2.1.19. The layout still loads vendored Trix 1.3.5 as a script, and `actiontext.css` now `require`s the 2.x stylesheet. Both compile and the trix selector sets are the same. A browser check of the toolbar was not done. `ARCHITECTURE.md` says the vendored copy exists because 7.0.8.7's bundled 1.3.4 cannot load saved HTML that has attributes. The vendored script and the `@rails/actiontext` pin can be removed in a follow-up once a browser confirms Trix 2.
- **Docs to update:** `TESTING.md` says `BigDecimal` "arrives as a string in a worker" and the time "is deserialized in UTC in both". Both are false on 8.1. The Gemfile comment on Minitest 6 can only be reconsidered separately; I did not test it.

## 6. Validation, per finding

For each, "before" means the 8.1.0 copy without the repair, and "after" means with it. The existing test named is the check unless marked proposed.

| Finding | Check that fails before and passes after | Control that must not change |
|---|---|---|
| 1 json | `Note.first.tags` plus `ActiveSupport::JSON.decode("[1]")` in a runner. Before: `given 2, expected 1`. | Existing note tests. |
| 2 action_text initializer | Boot with the repaired initializer; the existing rich-text test posts `<details><summary>`, a `<script>` and a `javascript:` link. | Script and event handlers stay stripped. |
| 3 to 6 | `bin/rails zeitwerk:check`, `NoteTest`, `NotesControllerTest` (`notes_path` and `journal_path`), and a request to `/journal`. Route names are unchanged. | `Note.status_ready` and the status filter keep working. |
| 7 secrets | `CitationEnrichmentsControllerTest` "provider credentials from the environment reach the server unchanged". It spawns a fresh `bin/rails runner` with `CITATION_PROVIDER_*` env vars. | The same test asserts the Basic auth header carries the exact user and password. |
| 8 show_exceptions | `NotebooksControllerTest` and others assert `ActiveRecord::RecordNotFound` is raised. | Non-error paths unchanged. |
| 9 export | `ExportsControllerTest`, a full export then download. A real Sidekiq worker also produced the file, `/tmp/plan/flow2-up.log`. | The generated Markdown starts `# Heading` and keeps the note order. |
| 10 retry wait | `CitationEnrichmentsControllerTest` "a provider that stays unavailable...": six requests in all, three attempts each retrying one 503, with the failure recorded on the citation. | Permanent refusal (404/401) records the failure without retry. |
| 11 reminders | `RemindersControllerTest`: the enqueued job's `at` equals the epoch, and the real Sidekiq score is 1893499200. | Postponing replaces the earlier job and the earlier job sends nothing. |
| 12 and 13 | `NotesControllerTest` filters by notebook, status and title; the sign-in test lands on `/notes`. | The 50-per-page cap and filter-preserving pagination stay. |
| 14 and 16 | `ImportsControllerTest`: the preview shows `Read <b>twice</b> & reflect` under line 2, and the receipt CSV rows carry `10.1000/Essays.1`. | An import without annotations or DOIs previews normally. |
| 15 | `ImportsControllerTest` "invalid rows ... saves nothing". It asserts `[Import, Note, Citation, Export]` counts are unchanged after posting the invalid CSV. | A valid CSV still creates all rows plus one import, and a retry with a fixed CSV succeeds. |
| 17 | `RemindersControllerTest` asserts `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]`. | The instant `postpone_reminder` schedules is unchanged. |
| 18 | `DigestsControllerTest`: the subject must be "October 05, 2026" for a reader in a zone that is still the 4th. | The reservation key still uses the UTC date. |
| `.to_s` digest argument [P] | Enqueue `DigestJob` through real Sidekiq on 8.1 and run `execute.rb` on 7.0. Before the repair it fails with the BigDecimal error. | The mail body percentage is identical. Also run the 7.0 payload on 8.1. |
| Real Sidekiq adapter [P] | Add an integration check that runs `/tmp/plan/enqueue.rb` style enqueues against a disposable Redis. The test suite uses the `:test` adapter, which does not exercise the adapter. | None needed. |

## 7. Order of work

1. On 7.0.8.7, ship the compatible repairs: items 2, 3, 5, 6, 7, 9, 11 to 18, plus the `.to_s` digest argument. I ran the first set on `/tmp/plan/prep`: 46 runs, 0 failures. After that deploy, no 7.0 worker will receive a 8.1-only BigDecimal payload.
2. Then ship the bump: Gemfile and lockfile (Rails 8.1.0 plus the `json` pin), items 1, 4, 8 and 10, and the `bin/rails zeitwerk:check` and full suite runs.
3. Run the real-Sidekiq and browser checks from sections 5 and 6 on staging.
4. Adopt `load_defaults` 7.1 to 8.1 in separate steps, each with the repairs in section 4.

## 8. Not verified

- The system tests (`bin/rails test:system`): there are none, and no Chrome and driver were available.
- Browser rendering of the Trix editor and toolbar under the 2.x CSS.
- Intermediate hops. I tested 7.0.8.7 and 8.1.0 and read the intermediate changelogs, but I did not boot 7.1.6, 7.2.4 or 8.0.5.1. The deprecation warnings those versions would have shown (`alias_attribute`, `form_with model: nil`, `enum` keyword form, `secrets`, `exponentially_longer`) are inferred from the changelogs.
- Whether a later 8.1.x patch fixes the `json` 3.x incompatibility.
- Production behavior: a real production Redis, cable and the shared-cache scenarios.
- Whether a Rails 8.1 application with `load_defaults 7.0` stays supported beyond 8.1. I only confirmed that it boots and behaves as above.

---

Commentary: I did not implement anything or change the repo, as the skill requires a plan only. Say if you want me to start on step 1 (the repairs that also work on 7.0.8.7).