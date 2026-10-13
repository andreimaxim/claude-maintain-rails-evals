I wrote a plan for the upgrade but didn't make the upgrade itself. The upgrade skill only produces a plan, and the repository has no changes (`git status` is clean). Here is the plan in full:

# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but it can't be a version bump alone. Rails 8.1.0 doesn't boot this app unchanged. After 21 application changes plus a dependency pin, the test suite passes on 8.1.0. Several of those changes fix problems that the tests don't catch or that only appear with live data and queued jobs.

The working repository was not modified; `git status` is still clean. All experiments ran in disposable copies under `/tmp/upg`, using a private Postgres and Redis.

## How the experiments were run

- **Copies:**
  - `/tmp/upg/base`: unchanged 7.0.8.7, gems in `/tmp/upg/bundle-base`.
  - `/tmp/upg/up`: Rails 8.1.0 plus the fixes. Changes are visible with `git diff` in that directory, and as a patch in `/tmp/upg/up-full.diff`.
  - `/tmp/upg/prep`: 7.0.8.7 with only the changes that also work on 7.0.
- **Services:**
  - Postgres 15 on its own data directory (`/tmp/upg/pg`, socket `/tmp/upg`, port 55432).
  - Redis on port 56379.
  - Databases selected with `DATABASE_URL`: `mn_base_test`, `mn_up_test`, `mn_prep_test`, and `mn_shared` for the mixed-version tests.
  - Citation provider URL pointed at an unused port.
  - Each copy has its own `storage/` directory.
  - All services are stopped now.
- **Gems resolved for 8.1.0** (`bundle update rails --conservative`):
  - Rails 8.1.0, rack 2.2.24, sidekiq 6.5.12, minitest 5.27.0, turbo-rails 2.0.12, pagy 8.6.3.
  - New: `action_text-trix` 2.1.19.
  - The resolver first picked **json 3.1.0** (released 2026-10-13). I pinned `json < 3` and got 2.21.2.
- **Results (logs in `/tmp/upg`):**
  - Baseline 7.0: 46 runs, 0 failures (`base-test.log`).
  - 8.1.0 progression, each step adding one fix: `up-test-1.log` to `up-test-8.log`. Final run: 46 runs, 0 failures, with `load_defaults 7.0`.
  - 8.1.0 with `load_defaults 8.1`: `up-test-defaults81*.log`. Final run: 0 failures after three more fixes.
  - The `prep` copy on 7.0: 46 runs, 0 failures (`prep-test.log`), and `zeitwerk:check` passes.
- **Mixed-version tests:**
  - Job payloads went through real Redis with the Sidekiq adapter (scripts in `/tmp/upg/scripts/`, logs `exp-*.log`).
  - Production-mode Puma ran with a shared database and the same `SECRET_KEY_BASE`, signing in on one version and browsing on the other (`exp-smoke-*.log`, `base-server.log`, `up-server.log`).
- **Inputs:** The changelog index from `gem-changes` was the starting point. Its 8.1 defaults list was empty, so I read `railties-8.1.0/lib/rails/application/configuration.rb` directly for those.

## A. Required changes: confirmed failures on 8.1.0

"Works on 7.0" means it can ship as a preparatory change before the bump. Those changes were applied in `/tmp/upg/prep` and passed there.

| # | Code | What breaks if nothing is done | Fix | Works on 7.0? | Removed in |
|---|---|---|---|---|---|
| 1 | `Gemfile` / json | Activesupport 8.1.0 calls `JSON.parse(json, options)` with a positional hash, and json 3.x rejects it. Every JSON column read and decode fails with "wrong number of arguments (given 2, expected 1)". | Add `gem "json", "< 3"` until a Rails release supports json 3. | Yes | Not a Rails change |
| 2 | `config/initializers/action_text.rb` | Boot fails: `undefined method '+' for nil`. `ContentHelper.allowed_tags` is nil since 7.1. | In `after_initialize` with `on_load(:action_view)`, set `allowed_tags = sanitizer.class.allowed_tags + [Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. | Yes. Rendering of `<details>` matched on 7.0 and 8.1 (`scripts/render.rb`). | 7.1 |
| 3 | `app/models/note.rb:10`, `enum status: {...}, _prefix: true` | Class fails to load (ArgumentError). | `enum :status, {...}, prefix: true` | Yes | 8.0 |
| 4 | `note.rb:12`, `serialize :tags, JSON` | Class fails to load (ArgumentError). | `serialize :tags, coder: JSON` | **No.** On 7.0, `coder:` is probably ignored, which would mean YAML (not run). Ship it in the same change as the bump. | 7.2 |
| 5 | `note.rb:14`, `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`) | ArgumentError on first use of Note; most tests errored. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes | 7.2 |
| 6 | `config/routes.rb`, `get "/notes", "/journal", to:` | Routes fail to load: "Wrong number of arguments". | Two separate `get` lines. | Yes | 8.1 |
| 7 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, and the test helper | `Rails.application.secrets` no longer exists, so citation enrichment fails. | Move the settings to `config/citation_provider.yml`, load with `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider`. Production operators must still set the same `CITATION_PROVIDER_*` environment variables. Update `ARCHITECTURE.md:79`, `CONTRIBUTING.md:38` and `config/secrets.yml`. | Yes | 7.2 |
| 8 | `app/models/export.rb:42`, `fragments.sum` on strings | Every export job fails with TypeError ("String can't be coerced into Integer"). It already prints a deprecation on 7.0. | `fragments.join` | Yes | 7.1 |
| 9 | `app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)` | The notes list (`/notes`, `/journal`) and the sign-in redirect target return 500. | Drop `model: nil`. | Yes | 8.x |
| 10 | `app/controllers/notes_controller.rb:12`, `where(notebooks: @notebook)` | Filtering by notebook raises `PG::UndefinedColumn notes.notebooks`. | `where(notebook: @notebook)` | Yes | 8.x |
| 11 | `app/jobs/citation_enrichment_job.rb`, `wait: :exponentially_longer` | The first retry raises "Couldn't determine a delay", so a failure is never recorded. | `:polynomially_longer` (7.1 and later). | **No** with that symbol. A lambda such as `->(n) { n**4 + 2 }` works on both versions but has no jitter. | 7.2 |
| 12 | `note.rb` `schedule_reminder`, `set(wait_until: reminder_epoch)` (an Integer) | Scheduling a reminder raises `undefined method 'utc' for Integer`. | `wait_until: Time.at(reminder_epoch)` | Yes | 7.1 |
| 13 | `app/models/import.rb` `apply`, `return false` inside `transaction` | **Silent data corruption.** An invalid row now commits the import and the earlier rows. Measured record counts: `[1, 4, 1, 2]` instead of `[0, 3, 0, 1]`. | Use `raise ActiveRecord::Rollback` and return a flag set at the end of the block. | Yes | 7.2 (non-local return now commits) |
| 14 | `import.rb` `receipt`, `citation[:id]` (the primary key is `doi`) | The receipt CSV's DOI column becomes empty; it also gained odd `# encoding` lines in the failing assertion output. Since 7.1, `[:id]` reads a column literally named `id`. | `citation&.doi` | Yes | 7.1 |
| 15 | `app/views/imports/preview.html.erb`, `annotations.stringify_keys` then `annotations[row.line]` | Annotations disappear from the import preview. Since 7.1, `stringify_keys` really stringifies integer keys. | Drop `.stringify_keys`. | Yes | 7.1 |
| 16 | `config/environments/test.rb`, `show_exceptions = false` | Tests that expect `RecordNotFound` get rendered 404 pages, so authorization tests stop proving anything. | `:none` | **No** (on 7.0 `:none` is truthy). Ship with the bump. | 7.2 |
| 17 | `app/mailers/digest_mailer.rb` | **Behavior change, no error.** Since 7.1, TimeWithZone job arguments keep the reader's zone. The digest then covers the reader's local day while the Redis reservation key and the UI text say "UTC day". Test showed Oct 04 instead of Oct 05; a live Wellington user got Oct 14 instead of Oct 13. | `requested_at = requested_at.in_time_zone("UTC")` in the mailer. This handles both old and new payloads. | Yes | 7.1 |
| 18 | `note.rb` `next_day_reminder_at`, `reminder_at.to_time + 86_400` | Display only: "24 hours later" now shows zone-adjusted wall time (08:00 -05:00 instead of 09:00 -04:00 across the DST change). 8.1 ignores `to_time_preserves_timezone`; it always preserves the zone. The epoch value is unchanged. | Keep the documented behavior with `Time.at(reminder_at.to_i + 86_400, in: reminder_at.formatted_offset)`, or decide to accept the new behavior and update the test and comment. This is a product decision. | Yes | 8.0/8.1 |

## B. Risks during a mixed-version rollout and rollback

1. **BigDecimal job argument (`User#request_digest`, `DigestJob`).**
   - 8.1 always uses `BigDecimalSerializer`.
   - Verified: a DigestJob enqueued by 8.1 and run by a 7.0 worker fails with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`exp-drain-70-of-81.log`). Sidekiq would keep retrying it, and the day's Redis reservation stays held, so the reader can't request again.
   - Fix: pass `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`. Verified that 8.1 to 7.0 then works (`exp-drain-70-of-81-stringcompletion.log`).
   - This is a preparatory change that works on 7.0. Ship it before the bump.
2. **Other queued payloads.**
   - Verified: 7.0-enqueued Digest, Reminder, Enrichment and Export jobs all run on an 8.1 worker (`exp-drain-81-of-70.log`).
   - Verified: 8.1-enqueued Reminder, Enrichment and Export jobs run on 7.0. The extra `scheduled_at` and `time_zone` keys are ignored.
   - Scheduled NoteReminderJobs can sit in Sidekiq's `schedule` set for a long time, so both directions matter. Both work.
3. **Sessions.** Signing in on one version and browsing on the other works in both directions while `load_defaults 7.0` is kept (smoke logs). The one 500 in the reverse direction was a test artifact: each copy had its own storage directory.
4. **Code that only works on 8.1.** `serialize coder:`, `show_exceptions: :none` and `:polynomially_longer` can't run on 7.0. Rolling back the code therefore means rolling back these lines too.
5. **Data.** No schema or migration changes are needed. Stored formats don't change while the old defaults are kept: the JSON `tags`, the YAML `preferences` and the jsonb `settings` read back identically on 8.1.

## C. New defaults in each release

The app currently calls `load_defaults 7.0` and sets none of these values explicitly, so it keeps every old value. Adoption is optional and should be done one setting at a time, after the bump. Results come from 8.1 with `load_defaults 8.1` unless marked as reading the source.

**7.1**
- `default_column_serializer = nil`: `serialize :preferences` (`notebook.rb`) fails to load. Required before adoption: `serialize :preferences, coder: YAML`. Existing YAML rows read back fine.
- `raise_on_assign_to_attr_readonly = true`: saving notebook settings raises `ReadonlyAttributeError: slug`, because the form posts a hidden `slug` and `notebooks_controller.rb` permits it. Fix (works on 7.0): remove `:slug` from the permit list.
- `raise_on_invalid_cache_expiration_time = true`: the exports page returns 500 for any expired completed export (`exports/_export.html.erb:26` passes a negative `expires_in`). Production has `perform_caching` on, so users would see this. Fix (works on 7.0): `[export.expires_at - Time.current, 1.second].max`.
- `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata`, `cache_format_version 7.1`, `marshalling_format_version 7.1`: no visible change for a single version. During a mixed or rollback window, 7.0 servers can't read messages or cache entries written in the new format. Examples are signed Active Storage URLs in rich text, and the production FileStore if it is shared. Adopt only after rollback is no longer needed (from the upgrade guide; not tested).
- `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` set to HTML5: the same output for `<details>` and for script stripping in my sample (`scripts/render.rb`). Whitespace differs slightly.
- `dom_testing_default_html_version = :html5`: tests passed.
- `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false`: the app has no `after_commit` callbacks, so there is no expected effect.
- `belongs_to_required_validates_foreign_key = false`: fewer queries; tests passed.
- `generate_secure_token_on`, Active Record encryption hash settings, `sqlite3_adapter_strict_strings_by_default`: not used here.
- `query_log_tags_format`: query logs are not enabled.
- `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size` (development only), and the new default headers (`X-XSS-Protection: 0`): low impact.
- Listed in 7.1 but not configurable in 8.1:
  - `use_big_decimal_serializer`: always on (see B1).
  - `commit_transaction_on_non_local_return`: always commits (see A13).
  - `allow_deprecated_parameters_hash_equality`: the app does no hash comparisons of params.

**7.2**
- `postgresql_adapter_decode_dates = true`: the activity report fails with `TypeError` at `Date.iso8601(day)` (`notebook.rb:40`). Fix (works on 7.0): `day.to_date`.
- `enqueue_after_transaction_commit`: only matters if you stop at 7.2 with 7.2 defaults. Jobs would then be enqueued after commit, which breaks the documented "failed enqueue rolls back" guarantee in `Citation#request_enrichment` and `Note#schedule_reminder`. On 8.1 it is a per-job setting that defaults to false (from the source).
- `validate_migration_timestamps`: the existing migration timestamps are well-formed.
- `yjit`: Ruby 3.3.6 supports it.
- `web_image_content_types` (adds WebP): images are only linked via `rails_blob_path`, so no effect.

**8.0**
- `strict_freshness`: when a request has both `If-None-Match` and `If-Modified-Since`, only the ETag is checked. `ExportDownloadsController` sends an ETag (the immutable blob checksum), so results should match in practice. Proposed check: request with a matching ETag and a stale date, and with a mismatching ETag and a fresh date.
- `to_time_preserves_timezone = :zone`: 8.1 enforces this regardless of config (see A18).
- `Regexp.timeout = 1`: the DOI and CSV regexes are simple.

**8.1** (the tool listed none)
- `escape_json_responses = false`, `escape_js_separators_in_json = false`: JSON output changes slightly.
- `action_on_path_relative_redirect = :raise`: every redirect uses path helpers or absolute paths.
- `raise_on_missing_required_finder_order_columns`: Citation's primary key is `doi` and no implicit order is used.
- `render_tracker = :ruby`, `remove_hidden_field_autocomplete`: the import preview's hidden `csv` field loses `autocomplete=off`.
- `yjit` is off in local environments.
- The full test suite passed with these defaults.

## D. Other items

- **Trix and assets.** The layout loads a vendored classic Trix 1.3.5 (`vendor/javascript/trix-1.3.5.js`). The `*= require trix` in `actiontext.css` now resolves to the Trix 2 stylesheet from `action_text-trix`, and 8.1's `actiontext.js` targets Trix 2. Precompile succeeds and the pages render (smoke test), but the editor was **not checked in a browser**. Recommended: drop the vendored 1.3.5 and add `pin "trix"` / `import "trix"` from the gem. Then run `bin/rails test:system`, which I did not run, and test by hand: editing saved HTML containing links and attachments, uploading attachments, and `<details>`.
- **Sidekiq 6.5.12.** Works on 8.1.0, but Rails warns that its built-in Sidekiq adapter is deprecated and will be removed in 8.2. Plan a Sidekiq 7.3.3+ upgrade separately. That upgrade brings in `strict_args`, which matters because `ExportJob.perform_async(id, { format: ... })` uses symbol keys and already warns, and redis-client.
- **Other upcoming breakage.**
  - Redis 4.8: `sadd` and `srem` return values will change in redis 5. They are used as booleans in `user.rb`, so switch to `sadd?` and `srem?`.
  - Add `gem "csv"` before Ruby 3.4.
  - Install `image_processing` or set `variant_processor = :disabled`; precompile warns about this.
  - `Note.connection` is soft-deprecated in favour of `with_connection` / `lease_connection`.

## Recommended order

1. **Preparatory release on 7.0**, deployed and soaked: changes 1 (pin), 2, 3, 5–10, 12–15, 17, 18, B1 (`.to_s`), plus the slug, cache-expiry and `to_date` fixes from section C.
2. **Bump release**: the Rails 8.1.0 bump together with 4, 11 and 16, keeping `load_defaults 7.0`. Drain or verify the Sidekiq queues around the switch; with B1 shipped, rollback to step 1 is safe for queued jobs.
3. **Adopt defaults one at a time** once rollback is off the table. Leave the message, cache and marshalling serializers until last.

I'd consider going through 7.1 and 7.2 first to collect their deprecation warnings. Every removal I found surfaced directly on 8.1, though.

## Still unverified

- No browser or system-test run, so the Trix editor and Turbo behavior are unchecked.
- `serialize coder:` on 7.0 was not tested.
- `strict_freshness` with real conditional requests was not exercised.
- Behavior with a shared production cache store and Active Storage service was not tested; production config uses the per-host `:local` disk.
- How production supplies `CITATION_PROVIDER_*` and `SECRET_KEY_BASE` is unknown.
- The json 3 incompatibility is from source and the test run; I didn't check whether a later Rails 8.1.x release fixes it.

---

**My notes:**
- **Biggest risk:** change A13. On 8.1, an import with a bad row would save the import and the rows before it instead of rolling back, and nothing would raise an error. The A17 digest date shift and the B1 job problem during a mixed-version rollout also wouldn't show up as errors.
- **Not decided yet:** A18 needs your call on whether to keep the current "24 hours later" display or accept Rails 8.1's new behaviour.
- **Patch:** the full set of changes that passes the tests on 8.1.0 is in `/tmp/upg/up-full.diff`.

I can start on the step 1 preparatory release on a branch if you want; it stays on Rails 7.0.