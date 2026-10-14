# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

**Verdict.** The app does not survive this upgrade as it stands. On 8.1.0 it won't boot, and once that's fixed 46 of 47 tests fail. I upgraded a disposable copy and applied 16 repairs, listed below. With them, the full suite passed (47 runs, 0 failures, 0 deprecations) on 8.1.0 with `load_defaults 7.0` kept, and the version-independent ones also passed on 7.0.8.7. Adopting the newer framework defaults then breaks five more things, covered in a separate section.

Several breaks would not show up in the current tests:
- A rejected CSV import now partly saves.
- Import receipts lose their DOI column.
- Enrichment retries stop recording failures.
- Digest jobs queued by 8.1 fail on 7.0 workers.

The working repository was not changed (`git status` is clean).

## How this was tested
- **Isolation:** the copy is at `/tmp/up/app`, with database `margin_upg_test` (since dropped) and its own `redis-server` on port 6390 (since stopped). Environment: `/tmp/up/env.sh`. Active Storage used the copy's `tmp/storage`.
- **Change summary:** `/tmp/up/changes.txt`.
- **Resolved dependencies:** rails 8.1.0, rack 2.2.24 (held back by sidekiq 6.5.12), puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, pg 1.6.0, json 2.21.2 (pinned), minitest 5.27.0, turbo-rails 2.0.12. Original lockfile: `/tmp/up/Gemfile.lock.7.0`; bundle log: `/tmp/up/bundle-8.1.log`.
- **Test runs:** baseline `/tmp/up/baseline-test.log`. Each repair round: `/tmp/up/test-8.1{,b,c,d,e,f}.log`. Repaired on 7.0: `/tmp/up/test-7.0-repaired.log`. With newer defaults: `/tmp/up/test-8.1-defaults8.1b.log`.
- **Probes:** `/tmp/up/scripts/probe.rb`, with outputs `/tmp/up/probe-7.0.log`, `probe-8.1.log`, `probe-8.1b.log`, `probe-8.1-d81b.log`, `probe-8.1-d72.log`. There is also a conditional-GET request test, `/tmp/up/scripts/fresh_test.rb`.
- **Mixed versions:** `/tmp/up/scripts/{enqueue,consume,enqueue2,consume2}.rb`, run against the 7.0 copy at `/tmp/up/app70r`.
- **All repairs as one diff:** `/tmp/up/repairs-8.1.diff`. Snapshot of the repaired copy: `/tmp/up/app-repaired-8.1-defaults7.0`.
- **What ran:** only 7.0.8.7 and 8.1.0. Findings about 7.1, 7.2 and 8.0 as intermediate stops come from changelogs and gem source.

## Required changes (each one observed failing on 8.1.0 with `load_defaults 7.0`)

The "Validation" line for each finding gives the check: it fails on 8.1 without the repair, passes with it, and the control must stay the same.

**R1. json 3.x makes every cookie read fail.**
- **Where:** `Gemfile` (no lock on json yet; bundling 8.1 pulled in json 3.1.0).
- **Observed:** every request with a session failed with `ArgumentError: wrong number of arguments (given 2, expected 1)`, raised from `active_support/json/decoding.rb:25` calling `JSON.parse`.
- **Repair:** add `gem "json", "< 3"` (resolved to 2.21.2) until an Active Support release supports json 3. It is harmless on 7.0.
- **Validation:** sign in, then `GET /notes` returns 200. Control: a signed-out request still redirects to the sign-in page.

**R2. `config/initializers/action_text.rb` stops the app from booting.**
- **Observed:** `undefined method '+' for nil (NoMethodError)`. Since 7.1, `allowed_tags` starts as nil and the defaults are built lazily.
- **Repair:** run after initialization, inside `ActiveSupport.on_load(:action_view)`:
  ```ruby
  base = helper.allowed_tags || (helper.sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"])
  helper.allowed_tags = base + %w[details summary]
  ```
  This works on 7.0, where `allowed_tags` is already filled in.
- **Validation:** boot succeeds, and `allowed_tags` includes both `details` and `action-text-attachment` (checked: true, true). Render a note whose body has `<details>` and an attachment: both survive. Control: a `<script>` tag is still stripped.

**R3. The route with two paths fails to load.**
- **Where:** `config/routes.rb:18`, `get "/notes", "/journal", to: ...`.
- **Observed:** `ArgumentError: Wrong number of arguments (expect 1, got 2)`. It surfaced in `zeitwerk:check` and on the first request, not at `rails runner` boot, because 8.x loads routes lazily.
- **Repair:** two separate `get` lines. The route names `notes` and `journal` stay the same (compared against the original's `bin/rails routes`). Works on 7.0.
- **Validation:** `GET /journal` and `GET /notes` both return 200.

**R4. Keyword-style `enum` in `Note` fails at class load.**
- **Observed:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at `app/models/note.rb:10`.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. `Citation` already uses this form on 7.0.
- **Validation:** `Note.status_ready` scope and `note.status_ready?` still work, and the stored integers are unchanged.

**R5. `serialize :tags, JSON` fails at class load.**
- **Observed:** `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Repair:** `serialize :tags, coder: JSON`. This only works from 7.1 on, so it must land in the same commit as the Rails bump (or at a 7.1 stop).
- **Data check:** the raw column still reads `["a","b"]` on both versions.
- **Validation:** probe D/D2 covers create, update and reading back the raw column.

**R6. `alias_attribute :highlight_color, :color` fails as soon as a `Note` is used.**
- **Why:** `color` is a `store_accessor`, not a real attribute.
- **Observed:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'`.
- **Repair:** `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. Works on 7.0.
- **What it drops:** the `highlight_color_changed?` style helpers. Nothing uses them.
- **Validation:** create and update a note with a colour (probe D/D3): `settings` stays `{"color"=>"blue"}`. Control: the form radio stays checked (existing test, line 114).

**R7. `Rails.application.secrets` no longer exists, so citation lookups fail.**
- **Where:** `Citation::Provider#initialize` and the test helper `with_provider`.
- **Observed:** `NoMethodError: undefined method 'secrets'`.
- **Repair (recommended):** move the settings to `config/citation_provider.yml` (same ERB and environment variables), set `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider.to_h`. This works on 7.0 and can ship first.
- **Alternative:** encrypted credentials. Not recommended, because it changes how operators supply the `CITATION_PROVIDER_*` environment variables.
- **Validation:** citation-enrichment request tests, plus a check that the credentials set in the environment reach the provider unchanged. Control: with no URL configured in production, it still reports "No citation provider is configured".

**R8. The test environment's `show_exceptions = false` is now read as rescue-and-render.**
- **Observed:** tests expecting `ActiveRecord::RecordNotFound` saw "nothing was raised" (they got a 404 page instead).
- **Repair:** `:none`, in the same commit as the bump. On 7.0, `:none` would be truthy and mean the opposite.
- **Validation:** the existing tests that check other readers' records can't be reached.

**R9. `Export#generate` uses `fragments.sum` on strings, so every export fails.**
- **Observed:** `TypeError: String can't be coerced into Integer` at `export.rb:42`. In production the Sidekiq job retries forever and the export stays "working".
- **Repair:** `fragments.join`. Works on 7.0.
- **Validation:** probe G (status completed, same Markdown as on 7.0) and the export-download test. Control: a cancelled export still stores no file.

**R10. `NoteReminderJob.set(wait_until: <Integer>)` fails.**
- **Observed:** `NoMethodError: undefined method 'utc' for an instance of Integer` at `note.rb:62`. Scheduling, postponing and imported reminders all fail.
- **Repair:** `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
- **Validation:** schedule a reminder and check the job's `scheduled_at` equals the epoch exactly. Control: a superseded job still sends nothing.

**R11. `form_with(model: nil, ...)` breaks the notes list.**
- **Where:** `notes/index.html.erb:12`.
- **Observed:** `Passed nil to the :model argument, expect an object or false`. This breaks `/notes`, `/journal` and the redirect after sign-in.
- **Repair:** drop `model: nil`. Works on 7.0.
- **Validation:** the existing "renders an unbound search form" test; input names keep no `note[...]` prefix.

**R12. Notebook filter `where(notebooks: @notebook)` breaks.**
- **Where:** `NotesController#index`.
- **Observed:** `PG::UndefinedColumn: column notes.notebooks does not exist`.
- **Repair:** `where(notebook: @notebook)`. Works on 7.0.
- **Validation:** `GET /notes?notebook_id=` lists only that notebook's notes. Control: another reader's notebook id still returns not found.

**R13. Import receipt CSV loses its DOI column.** The tests partly cover this; it's a silent data change.
- **Where:** `Import#receipt`, which uses `citation[:id]` on a table whose primary key is `doi`.
- **Observed:** `On idleness,` with an empty DOI instead of `On idleness,10.1000/Essays.1`.
- **Repair:** `citation&.doi`. Works on 7.0.
- **Validation:** download the CSV receipt and compare it with the exact expected text. Control: a note without a citation keeps an empty cell.

**R14. Atomic import is no longer atomic. This is a data-integrity problem.**
- **Where:** `Import#apply` exits its `transaction` block with `return false`. Since 7.2 that commits instead of rolling back.
- **Observed:** an invalid file changed record counts from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. The import row, earlier notes and citations were saved.
- **Repair:**
  ```ruby
  saved = transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end
  saved == true
  ```
  Works on 7.0. Anywhere else that leaves a transaction with `return`, `break` or `throw` needs a source audit; none were found.
- **Validation:** the existing "invalid rows ... saves nothing" test. Also apply a CSV whose 2nd of 3 rows is invalid, then assert the counts of `Import`, `Note`, `Citation` and `ActionText::RichText` are unchanged. Control: a fully valid import still saves every row.

**R15. Import preview silently drops annotations.**
- **Where:** `imports/preview.html.erb`, where `annotations.stringify_keys` now turns the integer line keys into strings.
- **Observed:** the `#line_2 dd` showed the DOI; the annotation was missing.
- **Repair:** use `@import.annotations` without `.stringify_keys`. Works on 7.0.
- **Validation:** preview shows "Read <b>twice</b> & reflect" in line 2, escaped.

**R16. Digest date changes.**
- **Where:** `DigestMailer`. Active Job now keeps the time zone of a `TimeWithZone` argument.
- **Observed:** subject "October 04, 2026" instead of "October 05, 2026". The `updated_at` window also moves to the reader's local day, which contradicts the UTC reservation key in `User#request_digest`.
- **Repair:** `requested_at = requested_at.utc` in the mailer. This handles payloads queued by both 7.0 and 8.1.
- **Alternative:** adopt local days as a product change. That would also require changing the reservation key, so it isn't recommended here.
- **Validation:** request a digest for a reader in UTC-4 at 22:00 local. Subject and note set must match the UTC date. Control: a UTC reader sees no change.

**R17. Enrichment retries stop recording failures.**
- **Where:** `CitationEnrichmentJob`, `retry_on ... wait: :exponentially_longer`.
- **Observed:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised at retry time, not at load. In production the job falls through to Sidekiq's own retries, the `fail_enrichment` block never runs, and the citation stays `pending`. Every later request then answers "already being fetched".
- **Repair:** `:polynomially_longer` (7.1+, same formula), in the same commit as the bump.
- **Alternative:** a lambda that works on both versions, but it loses the jitter.
- **Validation:** with the provider stuck on 503 for 3 attempts, the citation ends `failed` with the error text. Control: `/unavailable-once` still completes.

**R18. The 24-hours-later preview changes its displayed offset across DST.** There is no config switch for this.
- **Where:** `Note#next_day_reminder_at`, which does `reminder_at.to_time + 86_400`. On 8.1, `to_time` keeps the zone; the setting is deprecated, to be removed in 8.2.
- **Observed:** the probe showed `2026-10-25 11:00:00 +0200` instead of `12:00 +0300`. The existing test expected `2026-11-01T09:00:00-04:00`.
- **What doesn't change:** the epoch stays +86400, so postponement timing is unaffected (probe K).
- **Repair:** `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. Works on 7.0.
- **Validation:** the reminders test at line 21. Control: postponing reschedules at exactly epoch + 86400.

## Rollout, stored data and queued jobs
- **R19 (required before the upgrade): BigDecimal job arguments.**
  - **Problem:** 8.1 always uses the BigDecimal serializer (the old setting is gone). A `DigestJob` enqueued by 8.1 and run on a 7.0 worker failed: `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The same happens to jobs left in the queue after a rollback.
  - **Repair:** in `User#request_digest`, pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`. Deploy this on 7.0 first.
  - **Validation:** rerun the cross-version scripts. 8.1 enqueue must execute on 7.0. Control: 7.0 enqueue, 8.1 execute already works (observed).
- **Other job payloads are compatible:**
  - Scheduled `NoteReminderJob`s run in both directions (observed).
  - The extra `time_zone` key in time arguments is ignored by 7.0.
  - `ExportJob` is a native Sidekiq job and is unaffected.
- **Stored data:**
  - `notes.tags` (JSON) and `notebooks.preferences` (YAML) keep the same on-disk format.
  - Rails 7.2 moves the development secret to `tmp/local_secret.txt`, so local sessions reset. This is development only.
- **Preparatory deploy on 7.0:** R2, R3, R4, R6, R7, R9 to R16, R18 and R19 all ran green on 7.0 (`/tmp/up/test-7.0-repaired.log`).
- **Same commit as the bump:** R1, R5, R8, R17.
- **Recommended order:** stop at 7.1, 7.2 and 8.0 to read deprecation warnings. Note that on an actual 7.2, `load_defaults 7.2` defers job enqueueing until after commit. That would break the "failed enqueue rolls back" guarantees in `Citation#request_enrichment` and `Note#schedule_reminder`. On 8.1 this does not happen even with 7.2 or 8.1 defaults (probe J2 enqueued immediately; J rolled back to nil).

## Optional default adoption (each release's defaults vs this app)
The app keeps every old value today: it uses `load_defaults 7.0` and sets none of these explicitly. With `load_defaults 8.1` on the repaired copy, 4 tests failed.

**7.1 defaults**
- **`default_column_serializer = nil`.** Every model fails to load: `missing keyword: :coder` at `notebook.rb:7`. Fix: `serialize :preferences, coder: YAML`. Stored YAML is unchanged.
- **`raise_on_assign_to_attr_readonly`.** Notebook settings update raises `ActiveRecord::ReadonlyAttributeError: slug`, because the form resubmits the hidden slug. Fix: remove `:slug` from `notebook_params` and the hidden field. Create is unaffected, since `assign_slug` sets it.
- **`raise_on_invalid_cache_expiration_time`.** The exports page returns 500 for any expired completed export: `Cache expiration time is invalid, cannot be negative: -60.0` (`exports/_export.html.erb:26`). With the old value, 8.1 reports it as a handled warning on every render. Fix: `cache_if export.downloadable?, ...`.
- **`message_serializer`, `use_message_serializer_for_metadata`, `cache_format_version 7.1`** (the last is missing from the summary's list). Adopt only after no 7.0 servers remain; they cannot read the new message metadata or cache entries.
- **`marshalling_format_version`.** Same rule as above.
- **`belongs_to_required_validates_foreign_key`, `before_committed_on_all_records`, ordered `after_commit`, `run_commit_callbacks_on_first_saved_instances`.** The app defines no commit callbacks. No change observed.
- **Sanitizer and DOM-testing switch to HTML5.** The suite passed. Rich-text HTML may serialize slightly differently.
- **Others.** Encryption, sqlite, secure token, singular association names, query log tags, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`: not used here, or no behavior change.
- **`use_big_decimal_serializer`.** Already forced on 8.1 (see R19).

**7.2 defaults**
- **`postgresql_adapter_decode_dates`.** The activity report fails: `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`. Fix: `Date.iso8601(day.to_s)`, which works with both settings.
- **`enqueue_after_transaction_commit`.** No effect on 8.1. It matters only on a real 7.2.
- **`web_image_content_types`.** No variants are used.
- **`validate_migration_timestamps`.** Existing timestamps are valid.
- **`yjit`.** On Ruby 3.3 this means more memory.

**8.0 defaults**
- **`strict_freshness`.** No change observable. Rack 2.2's `ConditionalGet` already gives `If-None-Match` priority: matching ETag plus an old `If-Modified-Since` returned 304 on both versions.
- **`Regexp.timeout = 1`** (missing from the summary). There is low risk given the 100 KB CSV limit.
- **`to_time_preserves_timezone`.** Already effective on 8.1 (see R18).

**8.1 defaults** (the summary listed none)
- `escape_json_responses = false`, `escape_js_separators_in_json = false`: no JSON or Jbuilder endpoints here.
- `action_on_path_relative_redirect = :raise`: all redirects are absolute.
- `raise_on_missing_required_finder_order_columns`: all tables have primary keys.
- `render_tracker = :ruby`: affects cache-digest dependency tracking. The exports partial cache should be checked.
- `remove_hidden_field_autocomplete`: drops `autocomplete="off"` from the slug and CSV hidden fields. Firefox may restore a stale CSV value on back navigation.
- `yjit` off in local environments.

## Still unverified
- The browser suite, `bin/rails server` under puma 5, a production boot with real credentials, Action Cable, and asset precompilation were not run.
- Rails 7.1, 7.2 and 8.0 were not installed.
- The built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2. Moving to sidekiq 7.3.3+ brings `redis-client`, where `sadd` returns an Integer (always truthy). That would break the duplicate-digest guard in `User#request_digest`; this was not tested.
- The json `< 3` pin should be rechecked against a later 8.1.x patch release.

---

This is a plan only. Your repository is unchanged, still on rails 7.0.8.7. All of the planner's testing was done on a throwaway copy under `/tmp/up`. My suggested order:
1. Ship the 7.0-compatible fixes first, especially R14 (atomic import) and R19 (BigDecimal job arguments).
2. Do the version bump in one commit together with R1, R5, R8 and R17.

`/tmp/up/repairs-8.1.diff` has every repair as one diff. Tell me if you want me to apply it.