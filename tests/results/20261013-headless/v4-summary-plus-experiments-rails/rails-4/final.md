I upgraded a disposable copy to Rails 8.1.0 and ran it: it does not boot as the application stands. Seven changes are required just to boot, and about eleven more to make the 46 tests pass. Most can land on Rails 7.0 now, before the version changes. Adopting some of the newer framework defaults would break three more things, and Active Job payloads are not compatible between versions in one direction, which matters during rollout and rollback. The working repository was not modified (a stray `rails-8.1.0.gem` I downloaded into it was removed; `git status` is clean).

## How I tested
- **Copies:** `/tmp/exp/base` (Rails 7.0.8.7, untouched) and `/tmp/exp/up` (Rails 8.1.0), each a clone of the repo with `mise.toml` removed.
- **Isolated services:** a private PostgreSQL 15 at `/tmp/exp/pgdata` (socket `/tmp/exp`, port 55432; the upgraded copy's database names were renamed `margin_notes_up_*`), Redis on 127.0.0.1:56379, and each copy's own `storage/`, `tmp/storage`, `tmp/cache` and `tmp/mails`. Environment is in `/tmp/exp/env.sh`. Both services are now stopped.
- **Gems resolved for 8.1:** rails 8.1.0, concurrent-ruby 1.3.8, json 2.21.2 (after a pin, see A1), rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, pagy 8.6.3, turbo-rails 2.0.12, importmap-rails 2.2.3, sprockets-rails 3.5.2, action_text-trix 2.1.19. Lockfile: `/tmp/exp/up/Gemfile.lock`; gems in `/tmp/exp/bundle-up`.
- **Results and logs:**
  - Baseline on 7.0: 46 runs, 0 failures (`/tmp/exp/base-test.log`).
  - On 8.1, fixing failures one at a time: `/tmp/exp/up-test1.log` to `up-test6.log`. The last run is 46 runs, 0 failures. All changes are in `/tmp/exp/up-full.diff`.
  - The same changes back on 7.0 (except the two that need 7.1): 46 runs, 0 failures (`/tmp/exp/base-portable-test.log`, `/tmp/exp/base-portable.diff`, `/tmp/exp/portable.patch`).
  - Newer defaults: I made `load_defaults` read `PROBE_LOAD_DEFAULTS` in the copy only. The suite at 8.1 defaults is in `/tmp/exp/up-test-defaults81.log`; the probe script is `/tmp/exp/probe_defaults.rb`.
  - A real Sidekiq 6.5.12 worker under 8.1: `/tmp/exp/up-sidekiq.log`. Export, reminder and digest jobs ran; the citation lookup retried as expected.
  - Job payloads produced by each version and read by the other: `/tmp/exp/payload-70.json`, `/tmp/exp/payload-81.json`, using `ser.rb` and `deser.rb`.
  - Production-mode boot and `assets:precompile` (`/tmp/exp/up-assets.log`) both succeed.
- **Not run:** the browser tests (no browser available), and any boot at 7.1, 7.2 or 8.0 on their own. The intermediate-release findings come from changelogs and from failures reproduced on 8.1.

## A. Required changes (each one failed when run on 8.1)
"Works on 7.0" means it passed the 7.0 test run above.

1. **Gemfile:** `gem "rails", "8.1.0"`, and drop the `concurrent-ruby` pin. activesupport 8.1.0 depends on `json` with no upper bound, so json 3.1.0 resolves, and every JSON column load fails with "wrong number of arguments" (Active Storage blob metadata, `Note#tags`). Add `gem "json", "< 3"`.
   - *Check:* `bundle exec ruby -e 'require "json"; p JSON::VERSION'` should be below 3, and saving a note with an attachment should work.
2. **`config/initializers/action_text.rb`:** fails at boot ("undefined method `+' for nil"). From 7.1, `ActionText::ContentHelper.allowed_tags` starts as nil.
   - *Fix:* after initialization, set the list to (existing tags, or the sanitizer's default tags plus the attachment tag, `figure` and `figcaption`) plus `details` and `summary`. Works on 7.0. The `details`/`summary` test passes on 8.1 with both the 7.0 defaults and the 8.1 defaults (which switch to the HTML5 sanitizer).
3. **`app/models/citation/provider.rb:13` and `config/secrets.yml`:** `Rails.application.secrets` was removed in 7.2 (it warns in 7.1).
   - *Fix:* move the settings to `config/citation_provider.yml`, load them with `config.x.citation_provider = config_for(:citation_provider)`, and have the provider read that. Update `with_provider` in `test/controllers/citation_enrichments_controller_test.rb:117-122`. Works on 7.0. Deploy must still pass the `CITATION_PROVIDER_*` environment variables.
4. **`app/models/note.rb:10`:** `enum status: {...}, _prefix: true` fails at load in 8.0+. Use `enum :status, {...}, prefix: true`. Works on 7.0.
5. **`app/models/note.rb:12` and `app/models/notebook.rb:7`:** `serialize :tags, JSON` gives ArgumentError in 7.2+, and a bare `serialize :preferences` fails at boot once 7.1 defaults are loaded.
   - *Fix:* `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`. Stored YAML and JSON read back unchanged (checked against the raw column). The `coder:` keyword does not exist in 7.0, so this lands with the 7.1 step.
6. **`app/models/note.rb:14`:** `alias_attribute :highlight_color, :color` fails because `color` is a store accessor, not a column. Use `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0.
7. **`config/routes.rb:18`:** `get "/notes", "/journal", to:` gives ArgumentError in 8.1. Split it into two `get` lines; route names stay `notes` and `journal`. Works on 7.0.
8. **`app/views/notes/index.html.erb:12`:** `form_with(model: nil, ...)` makes the notes list and sign-in return 500 in 8.1. Drop `model: nil`. Works on 7.0.
9. **`app/controllers/notes_controller.rb:12`:** `where(notebooks: @notebook)` is a plural name for a singular association, which is gone from 8.0 (SQL error on `notes.notebooks`). Use `where(notebook: @notebook)`. Works on 7.0.
10. **`app/models/export.rb:42`:** `fragments.sum` relied on Rails' string `Enumerable#sum`, removed in 7.1 (TypeError, so every export fails in the worker). Use `fragments.join`. Works on 7.0.
11. **`app/jobs/citation_enrichment_job.rb:7`:** `wait: :exponentially_longer` was removed in 7.2 ("Couldn't determine a delay"). Use `->(executions) { executions**4 + 2 }`, which works on 7.0, or `:polynomially_longer` from 7.1.
12. **`app/models/note.rb:61`:** `set(wait_until: <integer>)` raises "undefined method `utc' for Integer" from 7.2, so no reminder can be scheduled. Use `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
13. **`app/models/import.rb:53-60`:** `return false` inside `transaction` is a data-integrity problem. Rails 7.0 rolls back on it; from 7.2 it commits. On 8.1 the test showed a CSV with one bad row persisting the import and its valid notes (record counts `[1,4,1,2]` instead of `[0,3,0,1]`).
    - *Fix:* inside the transaction, `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`, then return `true`, with `|| false` after the block. Works on 7.0.
14. **`app/models/import.rb:68`:** `citation[:id]` no longer returns the `doi` primary key (removed in 7.2), so the receipt CSV silently has empty DOIs. Use `citation&.doi`. Works on 7.0.
15. **`app/views/imports/preview.html.erb:22`:** `.stringify_keys` on the indifferent hash now turns the integer line numbers into strings (8.0), so the preview silently stops showing annotations. Drop `.stringify_keys`. Works on 7.0.
16. **`app/models/note.rb:44`:** `to_time` keeping the UTC offset is no longer possible on 8.1, even with `load_defaults 7.0` (`ActiveSupport.to_time_preserves_timezone` is nil). Across a DST change the "24 hours later" time now shows -05:00 instead of -04:00. The actual reminder instant is unchanged; only the display and the test differ.
    - *Fix:* `(reminder_at + 86_400).to_time.getlocal(reminder_at.utc_offset)`. Works on 7.0.
17. **`app/mailers/digest_mailer.rb:8`:** since 7.1, Active Job keeps the reader's time zone when it deserializes a time. The digest then covers the reader's local day ("October 04" instead of "October 05"), while the once-per-day reservation key in `User#request_digest` is still the UTC day.
    - *Fix (keeps documented behaviour):* `requested_at = requested_at.in_time_zone(Time.zone)`. Works on 7.0. Switching to local days instead is a product decision that would also need the reservation key and the hint text changed.
18. **`config/environments/test.rb:31`:** `show_exceptions = false` is no longer accepted after 7.2, so tests that expect `RecordNotFound` get rendered 404/500 pages. Use `:none`. This value exists only from 7.1.

## B. Recommended preparation that the tests do not catch
- **`User#request_digest`:** pass `reading_completion.to_s`.
  - *Why:* a DigestJob enqueued by 7.1+ carries a BigDecimal marker that 7.0 cannot read (confirmed: "Serializer ActiveJob::Serializers::BigDecimalSerializer is not known"). DigestJob has no `discard_on`, so during a mixed deploy or a rollback, old workers would keep retrying those digests.
  - The mailer already does `BigDecimal(params[:completion])`, so a string works on both versions. Not executed.
- **`Notebook#request_export`:** pass `{ "format" => "markdown" }`. Sidekiq 6.5 already warns that symbol keys are unsafe (seen in the worker log), and Sidekiq 7 rejects them. Works on 7.0.
- **Sidekiq:** 6.5.12 works with 8.1.0 (worker run). The built-in adapter is deprecated and removed in 8.2, so plan a separate move to Sidekiq 7.3.3+ (which brings redis 5 and the `sadd?` change).
- **`Notebook#daily_note_counts`:** make it accept a `Date` as well as a string (see C, 7.2) before adopting 7.2 defaults.
- **`app/views/exports/_export.html.erb:26`:** clamp `expires_in` so it is never negative, before adopting 7.1 defaults.
- **`notebooks/_form.html.erb`:** remove the hidden `slug` field and `:slug` from `notebook_params`, before adopting 7.1 defaults.

## C. New framework defaults, release by release
The application calls `load_defaults 7.0` and sets none of these explicitly, so it keeps every old value. "Observed" means I ran it with that version's defaults loaded.

**7.1**
- `raise_on_assign_to_attr_readonly`: every notebook settings save would fail, because the form posts the hidden `slug` (observed `ReadonlyAttributeError`, even when the value is unchanged). Prepare as in B.
- `default_column_serializer = nil`: boot fails unless A5 is in place (observed).
- `raise_on_invalid_cache_expiration_time`: the exports page returns 500 for an expired export wherever caching is on, including production (observed "cannot be negative"). Prepare as in B.
- `allow_deprecated_singular_associations_name = false`: covered by A9 (removed in 8.0 anyway).
- `commit_transaction_on_non_local_return`: covered by A13 (forced in 7.2).
- `use_big_decimal_serializer`: forced in 7.2. Covered in B and E.
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: change signed and encrypted messages, such as signed Active Storage blob URLs. Servers still on 7.0 cannot read them. Adopt only after every server and worker is upgraded. The session cookie already uses JSON and is not affected.
- `cache_format_version 7.1`: affects the production file cache. 7.0 cannot read the new entries, so clear `tmp/cache` on rollback or adopt later. Low impact: the cache holds only fragments.
- `marshalling_format_version 7.1`: only matters if Active Record objects are cached; the app caches no records. Same rollout caution.
- `sanitizer_vendor` (Action View and Action Text) moves to HTML5. Rich text is re-sanitized when rendered; the stored HTML does not change. The test for allowed tags and dropped unsafe markup passed at 8.1 defaults.
- `dom_testing_default_html_version :html5`: the suite at 8.1 defaults had no parser-related failures.
- `belongs_to_required_validates_foreign_key = false`: fewer validation queries on note, export and import saves. Low impact.
- `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false`: the app defines no commit callbacks of its own. Low impact.
- Changed `default_headers` (X-XSS-Protection "0"), `debug_exception_log_level`, `precompile_filter_parameters`, `log_file_size`, `add_autoload_paths_to_load_path = false`, `query_log_tags_format`: low impact. Nothing found that relies on `$LOAD_PATH` for app code.
- Not used by this app: `encryption.*`, `generate_secure_token_on`, `sqlite3_adapter_strict_strings_by_default`, `allow_deprecated_parameters_hash_equality`.

**7.2**
- `postgresql_adapter_decode_dates`: `Date.iso8601(Date)` raises a TypeError, so the activity report returns 500 (observed).
- `active_job.enqueue_after_transaction_commit`:
  - *Risk:* if jobs were deferred until commit, a failed enqueue in `Citation#request_enrichment` or `Note#schedule_reminder` would no longer roll back. A citation could stay "pending" forever, and a note's `reminder_job_id` could point at a job that does not exist.
  - The config key is gone in 8.1, and `ActiveJob::Base.enqueue_after_transaction_commit` is `false` there (observed). During the 7.2 step, keep it off; to be safe, set it to false on `ApplicationJob`.
- `web_image_content_types` adds webp: webp attachments would render as images in `active_storage/blobs/_blob.html.erb`. Visible change only.
- `validate_migration_timestamps`: the existing migrations (2026-10-11) are valid; this only affects new migrations.
- `yjit = true`: more memory in production.

**8.0**
- `to_time_preserves_timezone :zone`: forced in 8.1 regardless (A16).
- `action_dispatch.strict_freshness`: in `ExportDownloadsController`, when a client sends both `If-None-Match` and `If-Modified-Since`, only the ETag (blob checksum) is checked. Low impact, arguably more correct.
- `Regexp.timeout = 1`: not exercised by the app's regexes.

**8.1**
- `escape_json_responses = false`, `escape_js_separators_in_json = false`: the app serves no JSON views.
- `action_on_path_relative_redirect :raise`: all redirects use route helpers or an absolute path.
- `raise_on_missing_required_finder_order_columns`: every table has a primary key.
- `render_tracker :ruby`: the export fragment cache key may change once, causing misses.
- `remove_hidden_field_autocomplete`: changes markup only.
- `yjit` is off in development and test.

## D. Suggested order
1. On 7.0, land everything marked "works on 7.0" in A and B; it passes the current suite.
2. Then step 7.1, 7.2, 8.0, 8.1 with `load_defaults 7.0` kept. In test, set `active_support.deprecation = :raise` to surface what each step deprecates. A5 and A18 land at 7.1.
3. Adopt new defaults one file at a time with `new_framework_defaults_*`, only after the whole fleet is upgraded.
4. Expect `db/schema.rb` to be reordered alphabetically, with `Schema[8.1]` and `pg_catalog.plpgsql`. Cosmetic.

## E. Stored data and queued work
- **Jobs from 7.0 read by 8.1:** fine (verified). Time-with-zone arguments arrive as UTC and the completion as a string.
- **Jobs from 8.1 read by 7.0:** reminder jobs are fine (the extra `scheduled_at` key is ignored). Digest jobs fail unless B's `to_s` change is in.
- **Long-delayed reminders** in the Sidekiq scheduled set carry only a record reference, so they survive in both directions.
- **Export jobs** are plain Sidekiq jobs and are not affected.
- **Stored data:** YAML in `notebooks.preferences`, JSON in `notes.tags`, `settings` jsonb, and Action Text bodies all need no migration.
- **Rollback after adopting 7.1 message or cache formats:** signed URLs issued by 8.1 stop working on 7.0, and cache entries need clearing.

## F. Not verified / open questions
- No boot at 7.1, 7.2 or 8.0 alone, so which deprecation warnings appear at each step is unconfirmed.
- Browser tests not run (`bin/rails test:system`), so the Trix editor, `button_to` markup and Turbo behaviour on 8.1 are unchecked. Precompile does emit trix and actiontext assets.
- The `json < 3` pin is needed for 8.1.0 specifically. Whether a later 8.1.x removes the need is unknown.
- B's BigDecimal `to_s` change was not executed.
- Product decision: should the digest cover the reader's local day (the new Rails behaviour) or stay on the UTC day, as A17 keeps it?
- Production values for `CITATION_PROVIDER_*` and `SECRET_KEY_BASE` were not checked.

---

**Next step:** Nothing has changed in your repository yet. This is only a plan. Rails is currently at 7.0.8.7, so this is a jump across four minor versions. I'd start with step D1: one change on 7.0 with the A and B fixes marked "works on 7.0". The `/tmp/exp/portable.patch` file is a ready starting point for it.

Before that, please decide one thing: should the digest stay on the UTC day (A17) or move to each reader's local day? Tell me to go ahead and I'll start D1.