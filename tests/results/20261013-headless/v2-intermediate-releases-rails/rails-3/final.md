# Rails upgrade plan for Margin Notes: 7.0.8.7 to 8.1.0

The upgrade is feasible, but the current code does not work on 8.1.0. It fails at boot, and once that is fixed, 14 of the 46 tests fail. Some of the breaks are silent data or behavior changes that the existing tests barely catch.

Every experiment ran in disposable copies under `/tmp/upg/` with a private Postgres 15 cluster (socket `/tmp/upg/pgsock`, port 55432) and a private redis on 127.0.0.1:6390. Each Rails version had its own bundle path. The working repo was not modified (`git status` is clean), and both services are stopped.

With the changes in section 2 applied and `load_defaults 7.0` kept, the suite passes on 8.1.0: 46 runs, 340 assertions, 0 failures.

## 1. Experiments run

| Variant | Command | Key versions | Result | Log |
|---|---|---|---|---|
| Baseline 7.0 | `bin/rails test` | rails 7.0.8.7, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12 | 46 runs, 0 failures | `/tmp/upg/logs/70-test.log` |
| 8.1, code unchanged | `bundle update rails concurrent-ruby --conservative`, then `zeitwerk:check` | rails 8.1.0, concurrent-ruby 1.3.8, rackup 1.0.1, json 3.1.0 | Fails at boot: `allowed_tags += ...` on nil | `81-bundle.log`, `81-zeitwerk.log` |
| 8.1, fixes applied one at a time | `bin/rails test` (runs 1–6) | as above; json pinned below 3 from run 3 (json 2.21.2) | Failures shrink to 0 by run 6 | `81-test-{1..6}.log` |
| 7.0 plus the preparatory changes | `bin/rails test` | 7.0 lockfile | Fails while `tags` uses `coder: JSON`; 46 runs, 0 failures once the positional form is restored | `70prep-test.log`, `70prep-test-2.log` |
| 8.1 with `load_defaults` 7.1, 7.2, 8.0, 8.1 | `bin/rails test` | same | 2–3 errors at each level (section 4) | `81-defaults-{7.1,7.2,8.0,8.1}.log` |
| 7.1.5.2, code unchanged | `bin/rails test` | own bundle `/tmp/upg/bundle71` | Same boot failure; with only that fixed: 1 failure, 3 errors, and a list of deprecations | `71-test.log`, `71-test-2.log` |
| Job payloads across versions | `probes/enqueue.rb` and `probes/deserialize.rb` against the private redis | sidekiq adapter | An 8.1-enqueued `DigestJob` fails on 7.0 workers | `probe-enqueue-*.log`, `probe-81-on-70.log`, `probe-70-on-81.log`, `/tmp/upg/probes/payloads-{70,81}.json` |
| Session cookie across versions | `probes/cookie.rb`, production mode, fixed `SECRET_KEY_BASE` | 8.1 at 7.0, 7.1 and 8.1 defaults | Readable in both directions | `probe-cookie.log` |
| Rich text, serializers, times | `probes/content.rb`, `probe_escape.rb`, `probe_time.rb` | 7.0 vs 8.1 at 7.0 defaults vs 8.1 at 8.1 defaults | See findings | `probe-content-{70,81,81d}.log` |
| Dev server; production asset precompile | `bin/rails server -p 3901`; `assets:precompile` | puma 5.6.9 on rack 2.2 | 200 / 301 / 302; precompile exit 0 | `81-server.log`, `81-assets.log` |

All logs are under `/tmp/upg/logs/`. The patched files are in `/tmp/upg/app81` (8.1) and `/tmp/upg/app70prep` (7.0).

## 2. Required changes

"Works on 7.0" is based on the passing `/tmp/upg/app70prep` run unless marked otherwise.

| # | Code | Break on 8.1 (introduced in) | Recommendation | Works on 7.0? | Validation |
|---|---|---|---|---|---|
| R1 | `config/initializers/action_text.rb` | `allowed_tags` is nil by default, so boot fails with NoMethodError (7.1, no warning) | In `after_initialize`, set `allowed_tags = (allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]) + %w[details summary]` | Yes | Boots. Rendered rich text keeps `<details>/<summary>` and still strips `<script>`, `onerror` and `javascript:` (verified in the content probe) |
| R2 | `Gemfile` | activesupport 8.1.0 accepts any `json`; Bundler picked 3.1.0, and `ActiveSupport::JSON.decode` then raises ArgumentError for every JSON-serialized column | Add `gem "json", "< 3"`, or check whether a later 8.1.x patch fixes this | Probably; 7.0 has no json gem in its lockfile (not executed) | `Gemfile.lock` shows json 2.x; the `tags` round-trip works |
| R3 | `app/models/note.rb` `enum status:, _prefix:` | Keyword form removed (deprecated 7.2, removed 8.0) | `enum :status, {...}, prefix: true` | Yes | `Note.statuses`, `status_ready` scope |
| R4 | `note.rb` `serialize :tags, JSON` | Positional coder removed (deprecated 7.1, removed 7.2) | `serialize :tags, coder: JSON` | **No.** On 7.0 the keyword is silently ignored and `tags` reads back as a String. Ship it in the same commit as the gem bump | The stored format matched byte for byte between 7.0 and 8.1 (probe). Re-check tag rendering |
| R5 | `app/models/notebook.rb` `serialize :preferences` | Required only if `default_column_serializer = nil` is adopted (7.1 default) | `serialize :preferences, coder: YAML` | Yes; on 7.0 YAML is the default anyway | YAML dump is identical across versions (probe) |
| R6 | `note.rb` `alias_attribute :highlight_color, :color` (`color` is a store accessor) | Raises ArgumentError (deprecated 7.1, raises 7.2) | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes | Highlight edit test |
| R7 | `config/routes.rb` `get "/notes", "/journal", to:` | Multiple paths removed (deprecated 8.0, removed 8.1) | Two routes: `as: :notes` and `as: :journal` | Yes; route names are unchanged | `bin/rails routes` shows `notes` and `journal` on both versions |
| R8 | `app/views/notes/index.html.erb:12` `form_with(model: nil, ...)` | Raises (8.0, no warning) | Drop `model: nil` | Yes | Search form markup |
| R9 | `app/controllers/notes_controller.rb` `where(notebooks: @notebook)` | Singular-association plural key: SQL error (deprecated 7.1, removed 7.2) | `where(notebook: @notebook)` | Yes | Notebook filter test |
| R10 | `app/models/export.rb` `fragments.sum` | `Array#sum` on Strings raises TypeError on 7.1 and later, so every export fails (seen on 7.1.5.2 and 8.1) | `fragments.join` | Yes | Export tests |
| R11 | `app/models/import.rb#apply` uses `return false` inside `transaction` | **Silent data change.** From 7.2 the non-local return commits; on 7.1 that happens if `commit_transaction_on_non_local_return` is adopted. Observed: an invalid import saved 1 import and 1 note | `raise ActiveRecord::Rollback` and return a `saved` flag | Yes | Imports test, "applying them saves nothing". Also audit production for partial imports if 7.2 or later ever ran without this fix |
| R12 | `import.rb#receipt` `citation[:id]` (primary key is `doi`) | **Silent.** Returns nil on 7.2+, so the receipt CSV has empty DOIs (deprecated 7.1) | `note.citation_doi` | Yes | Probe: 7.0 returns `"10.1000/probe.1"`, 8.1 returns `nil`. Receipt CSV assertion |
| R13 | `app/views/imports/preview.html.erb` `@import.annotations.stringify_keys` then `[row.line]` | **Silent.** From 8.0, `HashWithIndifferentAccess#stringify_keys` converts the Integer keys, so annotations disappear from the preview | Use `row.annotation` | Yes | `#line_2 dd` assertion |
| R14 | `app/models/citation/provider.rb`, `config/secrets.yml`, the `with_provider` helper in the citation test | `Rails.application.secrets` removed (deprecated 7.1, removed 7.2) | Move to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider)`, read `Rails.configuration.x.citation_provider.to_h`, and update the test | Yes | Citation tests, including "credentials reach the server unchanged". Set the same production env vars |
| R15 | `app/jobs/citation_enrichment_job.rb` `wait: :exponentially_longer` | Raises at enqueue in `retry_on` (deprecated 7.1, removed 7.2) | `:polynomially_longer` works only on 7.1+. A lambda `->(executions) { executions**4 + 2 }` works on both, but drops upstream's jitter | Yes (lambda) | Retry test |
| R16 | `note.rb#schedule_reminder` `set(wait_until: <Integer>)` | NoMethodError `utc` for Integer (deprecated 7.1) | `wait_until: Time.at(reminder_epoch)` | Yes | Enqueued `:at` still equals the epoch; Sidekiq schedule score `2030-01-01T12:00Z` (probe) |
| R17 | `config/environments/test.rb` `show_exceptions = false` | On 8.1, `false` falls through to "show all", so RecordNotFound becomes a 404 and access tests fail (deprecated 7.1) | `:none` | **No.** On 7.0 `:none` is truthy (source-based). Test env only; ship with the bump | Access-control tests |
| R18 | `app/mailers/digest_mailer.rb` and `app/models/user.rb#request_digest` | **Behavior change (7.1).** `TimeWithZone` job arguments keep the reader's zone, so the digest covers the reader's local day instead of the UTC day. This contradicts the reservation key and the "(UTC)" hint | `requested_at = requested_at.utc` in the mailer | Yes | Subject "October 05" test. Also makes 7.0- and 8.1-enqueued payloads behave the same |
| R19 | `user.rb#request_digest` passes a `BigDecimal` | **Queue incompatibility.** 7.2+ always uses `BigDecimalSerializer`. A 7.0 worker fails on it with "BigDecimalSerializer is not known" (executed) | Pass `reading_completion.to_s`; the mailer already calls `BigDecimal(...)` | Expected yes; not executed | Re-run the payload probe; the digest test's args assertion may need updating |
| R20 | `note.rb#next_day_reminder_at` `reminder_at.to_time + 86_400` | 8.1 removes the offset-preserving `to_time` (8.0 default, forced in 8.1). Across DST the preview shows 08:00 -05:00 instead of 09:00 -04:00. The epoch (`to_i`) is unchanged, so the scheduled job time is unaffected | Product decision. To keep the documented behavior: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` | Yes | `#next_day_reminder time[datetime=2026-11-01T09:00:00-04:00]` |

Other items:
- The built-in Sidekiq adapter is deprecated on 8.1 and will be removed in 8.2. It still works with sidekiq 6.5.12. Plan a Sidekiq 7.3.3+ upgrade before Rails 8.2; that is out of scope for this upgrade.
- Remove the `concurrent-ruby 1.3.4` pin and update the Minitest note in `TESTING.md`.
- Update the comments that describe the old behavior: "worker's time zone (UTC)" in `digest_mailer.rb` and `digest_job.rb`, `config/secrets.yml` in `provider.rb`, and the `to_time` comment in `note.rb`.

## 3. Rollout and rollback

1. **Preparatory release on 7.0.** Ship R1, R3, R5–R16 and R18–R20, plus the json pin. Use the lambda form for R15, keep the positional `serialize :tags, JSON`, and keep `show_exceptions = false`.
   - The 7.0 suite passes with these changes; R19 was not part of that run.
   - R11, R12 and R13 fix silent breaks, so they must be in place before any 7.2+ code runs.
2. **Upgrade release.** Bump the gem and include R4, R17 and the R2 pin. Keep `load_defaults 7.0`.
   - I tested a direct jump to 8.1.0. A stepped path (7.1, 7.2, 8.0, 8.1) gives you each release's deprecations, but 7.1 has the same boot break (R1) and the `sum` break (R10), so the preparatory release is still needed.
3. **Queued and scheduled work during a mixed deploy.**
   - Reminder and enrichment payloads are compatible in both directions (executed).
   - `NoteReminderJob` entries can sit in the Sidekiq schedule for months, which is another reason not to break that format.
   - Without R19, any `DigestJob` enqueued by 8.1 is lost if a 7.0 worker picks it up, including after a rollback.
   - Without R18, digest content depends on which version enqueued the job.
   - `ExportJob` is a native Sidekiq job and is unaffected.
   - Run web and worker on the same version, or ship R18 and R19 first.
4. **Stored data.**
   - `tags` JSON and `preferences` YAML are byte-identical between 7.0 and 8.1 at 7.0 defaults (probe).
   - With 8.1 defaults, U+2028 is stored unescaped in `tags`. It is still valid JSON that 7.0 can read.
   - Rich-text storage is unchanged.
   - Encrypted session cookies are readable across versions in both directions, even at 7.1 and 8.1 defaults (executed for this payload).
5. **Rollback.** Revert to the preparatory commit, not the original. It runs on 7.0 and reads the same data and payloads. R4 and R17 revert with the bump.

## 4. New configuration defaults, release by release

The app keeps the old value for every entry below: it uses `load_defaults 7.0` with no overrides and no `new_framework_defaults` file. Some defaults are no longer optional on 8.1; those are noted.

**7.1**
- `raise_on_assign_to_attr_readonly`: the update test breaks (ReadonlyAttributeError on `slug`, because the form resubmits it). Fix: drop `:slug` from `notebook_params`; works on 7.0, since `slug` is already ignored after creation.
- `raise_on_invalid_cache_expiration_time`: breaks the expired-export fragment in `app/views/exports/_export.html.erb:26` (`expires_in` is negative). Fix: floor the expiry at a small positive value, or skip the cache when the export is not downloadable.
- `default_column_serializer = nil`: requires R5.
- `commit_transaction_on_non_local_return`: always on from 7.2 (R11).
- `use_big_decimal_serializer`: always on from 7.2 (R19).
- `allow_deprecated_singular_associations_name = false`: R9.
- `allow_deprecated_parameters_hash_equality = false`: no use found.
- `action_view` and `action_text` `sanitizer_vendor` HTML5: rendered output differs only in whitespace (probe). R1's tags are kept.
- `dom_testing_default_html_version :html5`: tests pass.
- Security `default_headers` change: drops `X-Download-Options`.
- `cache_format_version 7.1`: the production file store becomes unreadable on rollback; clear `tmp/cache`. Not executed.
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: the session cookie stays compatible (executed).
- Low or no impact for this app: `belongs_to_required_validates_foreign_key = false`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `query_log_tags_format`, `marshalling_format_version`, `generate_secure_token_on`, the encryption digest settings, `sqlite3_adapter_strict_strings_by_default`, `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `debug_exception_log_level`, and `log_file_size`.

**7.2**
- `postgresql_adapter_decode_dates`: breaks the activity report (`Date.iso8601(Date)` raises TypeError in `Notebook#daily_note_counts`). Fix: `day.to_date`, which works on both versions.
- `active_job.enqueue_after_transaction_commit = :default`: only matters if you deploy 7.2 with its defaults. It would defer the enqueues that `Citation#request_enrichment` and `Note#schedule_reminder` make inside their row locks, breaking the "a failed enqueue rolls back" guarantee. In 8.1 the setting is gone and the per-job default is `false` (source).
- `validate_migration_timestamps`: existing timestamps are fine.
- `web_image_content_types` adds webp: no `image_processing` gem is in the bundle.
- `yjit = true`: higher production memory.

**8.0**
- `strict_freshness`: export downloads honor `If-None-Match` only. The ETag is the blob checksum, so the effect is minimal, and the tests pass.
- `to_time_preserves_timezone = :zone`: forced in 8.1 (R20).
- `Regexp.timeout = 1`: CSV import and DOI regexes; low risk.

**8.1**
- `escape_js_separators_in_json = false`: U+2028 is no longer escaped (probe).
- `action_on_path_relative_redirect = :raise`: all redirects use helpers or absolute paths.
- `raise_on_missing_required_finder_order_columns`: every model has a primary key.
- `escape_json_responses = false`: the app has no JSON responses.
- `render_tracker = :ruby`: cache digests change once.
- `remove_hidden_field_autocomplete`: hidden fields lose `autocomplete="off"`.
- `yjit` is enabled only outside dev and test.

The three adoption errors were reproduced at levels 7.1, 7.2, 8.0 and 8.1 in the defaults runs listed in section 1.

## 5. Not verified, and open questions

- System tests were not run; they need Chrome and a display.
- The R19 fix and the json pin on 7.0 were not executed.
- Rollback of the production file cache under `cache_format_version 7.1` was not executed.
- No real Sidekiq worker process was run. Payloads were deserialized directly.
- Decisions for you:
  - Should digests keep covering the UTC day (R18 keeps it) or switch to the reader's local day?
  - Should the next-day preview keep the original offset (R20)?
  - Direct jump to 8.1.0 or stepped releases?
  - Target 8.1.0 or a later 8.1.x patch (8.1.4 exists)? A later patch may make the json pin unnecessary; I did not check.
- I did not look at Ruby 3.4 implications. `csv`, `bigdecimal` and `mutex_m` warnings already appear, so add those gems before any Ruby upgrade.

---

I haven't upgraded Rails yet. This is only the plan, and your repo is unchanged. Rails is currently pinned to 7.0.8.7, and moving straight to 8.1.0 breaks the app: it won't start, and once that's fixed, 14 of the 46 tests fail.

The biggest risks are three changes that break nothing visibly (R11, R12, R13):
- **R11:** a failed import would save some of its notes instead of none.
- **R12:** DOIs would come out empty in import receipts.
- **R13:** annotations would disappear from the import preview.

The plan is two releases: first a set of fixes that also work on 7.0, then the gem bump itself.

Before I implement anything, I need your decisions on:
1. Whether to do the two-release rollout or a single commit.
2. Whether to target 8.1.0 exactly or a later 8.1.x patch, which might remove the need to pin `json` below 3.
3. Whether digests should keep covering the UTC day (R18).
4. Whether the next-day reminder preview should keep its original UTC offset across daylight-saving changes (R20).