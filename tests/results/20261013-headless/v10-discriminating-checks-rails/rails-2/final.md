I've written an upgrade plan for Rails 7.0.8.7 to 8.1.0. Upgrading a copy with only the Gemfile changed fails before the app boots or any test runs. Fifteen required repairs, all listed below, got it booting and passing (46 runs, 0 failures), on both its current 7.0 defaults and the 7.1 through 8.1 defaults. Three of the broken behaviours were not visible in the suite: jobs written by 8.1 that 7.0 workers cannot read, a cached fragment stored with no expiry, and a citation left stuck at "pending" if you opt into a newer job setting.

The working repository was not changed. Everything ran in copies under `/tmp/up/` with their own test databases and Redis db 13. One exception: the copy's own `bin/rails test` runs had no `REDIS_URL` set, so `DigestsControllerTest` used the default `redis://localhost:6379/0`. That left three `digest_requests:2026-10-0{5,6,7}` keys there, holding test-fixture user IDs, with a 48-hour expiry. I left them in place; delete them if that Redis matters.

## How it was tested

| What | Where |
|---|---|
| Change summary from `gem-changes` | `/tmp/up/changes.txt` |
| Upgraded copy (Rails 8.1.0, puma 5.6.9, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, json 2.21.2) | `/tmp/up/app`; lockfile at `/tmp/up/Gemfile.lock.81b` |
| Unchanged 7.0 copy, used for compatibility checks | `/tmp/up/app70` |
| Every change I made in the upgraded copy | `/tmp/up/upgrade-final.patch` |
| Test logs: 7.0 baseline (46 runs, 0 failures) | `/tmp/up/test70.log` |
| Test logs: 8.1 with only the Gemfile changed | `/tmp/up/test81.log` |
| Test logs: each repair step | `test81b.log` through `test81g.log` |
| Test logs: 8.1 with each newer defaults version, after repairs | `test81_defaults{7.0,7.1,7.2,8.0,8.1}_fixed.log` (all 46 runs, 0 failures) |
| Test logs: preparatory changes applied to the 7.0 copy | `test70_prep.log` (46 runs, 0 failures) |
| Probe scripts | `/tmp/up/scripts/` |
| Probe output | `probe70.log`, `probe81.log`, `probe2_*.log` |
| Job payloads read across versions | `jobs_cross.log` |
| Cookies read across versions | `cookies{70,81}.json` |

To switch defaults in the upgraded copy I added two test-only switches to its `config/application.rb`: `PROBE_LOAD_DEFAULTS` and a `PROBE_NEW_DEFAULTS` block. Don't carry them over.

## Required changes (the app breaks without them)

"Works on 7.0" means I applied the change to the 7.0 copy and its suite still passed. Those can ship as a preparatory commit before the upgrade.

1. **json 3.x breaks Rails 8.1.0.** Rails 8.1.0 brings in the `json` gem, which resolved to 3.1.0. Every Active Storage metadata read then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`, raised from `json-3.1.0/lib/json/common.rb:291` via `active_support/json/decoding.rb:25`.
   - **Fix:** add `gem "json", "~> 2.7"` to the Gemfile (resolved to 2.21.2). Works on 7.0.
   - **Check:** with the pin removed, `bin/rails test test/controllers/notes_controller_test.rb:107` errors; with it, it passes.
   - **Unverified:** whether a later 8.1.x patch release fixes this.

2. **`config/initializers/action_text.rb` stops the app from booting.** The error is `NoMethodError: undefined method '+' for nil` at line 3, because `allowed_tags` now starts as nil and is filled in on first use.
   - **Fix:** in `config.after_initialize`, inside `ActiveSupport.on_load(:action_view)`, set `allowed_tags = sanitizer.class.allowed_tags.to_a + [Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. Works on 7.0.
   - **Why that placement:** it runs after Action Text has swapped in the configured sanitizer. Probing showed it keeps `<details>` and strips `<script>` with both the HTML4 and HTML5 sanitizers (`probe2_81_html.log`).
   - **Check:** the "rich text keeps collapsible excerpts" test passes, and `zeitwerk:check` passes.

3. **Hash-style `enum` in `Note` is removed.** `enum status: {...}, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at boot.
   - **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0.

4. **`serialize :tags, JSON` in `Note` is removed.** It raises `ArgumentError: wrong number of arguments (given 2, expected 1)` at boot.
   - **Fix:** `serialize :tags, coder: JSON`. This does **not** work on 7.0, so it must ship in the upgrade commit.
   - **Data:** the stored format is unchanged (`["a","b"]` in both probes).

5. **`alias_attribute :highlight_color, :color` in `Note` is rejected.** `color` comes from a JSON store column, not a real attribute, and Rails now raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`.
   - **Fix:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0.
   - **Check:** the create and update note tests assert the green/blue radio button is checked. Probe B confirms the stored value is still `{"color"=>"green"}`.

6. **One route with two paths (`/notes` and `/journal`) is no longer accepted.** The router raises `ArgumentError: Wrong number of arguments (expect 1, got 2)` at `config/routes.rb:18`.
   - **Fix:** split it into two `get` lines. This keeps both route names, `notes` and `journal`. Works on 7.0.

7. **The notes search form uses `form_with(model: nil, …)`.** In `notes/index.html.erb` this raises `Passed nil to the :model argument`.
   - **Fix:** drop `model: nil`. Works on 7.0.

8. **The plural association name in `NotesController#index` is gone.** `where(notebooks: @notebook)` produces `PG::UndefinedColumn: column notes.notebooks does not exist`.
   - **Fix:** `where(notebook: @notebook)`. Works on 7.0.

9. **Exports no longer join their text.** `Export#generate` uses `fragments.sum` on strings, which raises `TypeError: String can't be coerced into Integer`. Every export job fails.
   - **Fix:** `fragments.join`. Works on 7.0.
   - **Queued work:** exports already queued or retrying are fine, because the job's arguments are only an id and options.

10. **Import preview stops showing annotations, and no test error reveals why.** `.stringify_keys` now turns the integer line keys into strings, so `annotations[row.line]` returns nil. The test reported `Expected "Second reading", Actual "not-a-doi"`.
    - **Fix:** drop `.stringify_keys` in `imports/preview.html.erb`. Works on 7.0.

11. **A failed import now half-saves (data integrity).** `Import#apply` uses `return false` inside `transaction`. On 7.0 that rolled back. From 7.2 a `return` commits the transaction, so the import and every row before the bad one are saved. The test showed record counts going from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`.
    - **Fix:**
      ```ruby
      transaction do
        save!
        raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
        true
      end || false
      ```
      Works on 7.0. It covers both paths: a valid import saves everything (the receipt test) and an invalid one saves nothing (the record-counts test).
    - **Existing data:** run an audit query for imports whose notes are fewer than the rows in their CSV. That can only happen if a build at 7.2 or later was ever deployed.

12. **The import receipt loses its DOI column, silently.** `citation[:id]` returns nil now that `citations` has primary key `doi` and no `id` column. The CSV comes out as `On idleness,` with the DOI blank.
    - **Fix:** `note.citation&.doi`. Works on 7.0.

13. **`Rails.application.secrets` is removed.** `Citation::Provider` and its test raise `NoMethodError: undefined method 'secrets'`.
    - **Fix:** rename `config/secrets.yml` to `config/citation_provider.yml` with flattened keys (the same ERB and `.to_json` quoting). In `application.rb` add `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider.to_h` in the provider and the test. Works on 7.0.
    - **Check:** the existing "credentials from the environment reach the server unchanged" test, using user `00123` and the password with `#`, passes.
    - **Deploy:** the environment variables for production stay the same.

14. **Scheduling a reminder fails.** `Note#schedule_reminder` passes an integer to `wait_until:`, which now raises `NoMethodError: undefined method 'utc' for an instance of Integer`.
    - **Fix:** `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
    - **Queued work:** reminders already in Sidekiq's schedule are unaffected. Old and new payloads read fine in both directions (`jobs_cross.log`).

15. **Three behaviour changes Rails 8.1 makes regardless of config:**
    - **Retry option `:exponentially_longer` is removed.** In `CitationEnrichmentJob` it gives `RuntimeError: Couldn't determine a delay based on :exponentially_longer` on the first retry.
      - **Fix:** `:polynomially_longer`, which uses the same formula. This is upgrade-commit only: it doesn't exist in 7.0. If you want a change that also works on 7.0, use a lambda instead.
    - **`show_exceptions = false` in `config/environments/test.rb` no longer means "raise".** The "RecordNotFound expected" tests fail.
      - **Fix:** `:none`. This is upgrade-commit only, because on 7.0 any symbol counts as true.
    - **The postponed-reminder time displays differently.** `to_time` now always keeps the zone and can no longer be configured. `Note#next_day_reminder_at` renders `2026-11-01T08:00-05:00` instead of the documented `09:00-04:00`; it is the same moment.
      - **Fix:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. This keeps the behaviour described in the comment. Works on 7.0.
      - **Check:** `reminders_controller_test.rb:6` asserts `datetime="2026-11-01T09:00:00-04:00"`.

16. **The daily digest covers the wrong day, and mixing versions loses jobs.**
    - **Wrong day:** on 8.1, a time passed to a job keeps its time zone, so `DigestMailer` now uses the reader's local day while the reservation key is per UTC day. The test showed "October 04" where "October 05" was expected.
      - **Fix:** `params[:requested_at].utc` in the mailer. Works on 7.0, and handles payloads queued by 7.0, which already arrive in UTC.
    - **Rollback hazard:** 8.1 always uses the `BigDecimalSerializer` for decimal job arguments; it can no longer be turned off. A 7.0 worker reading those jobs fails with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
      - **Fix:** pass `reading_completion.to_s` from `User#request_digest`. The mailer already calls `BigDecimal(...)` on it. With this change, payloads cross versions in both directions (`jobs_cross.log`).
      - **Deploy:** ship this in the preparatory commit.

## Default adoption (optional, not needed for 8.1)

None of these are set explicitly and the app is on `load_defaults 7.0`, so it keeps every old value. Below is what changes for this app if you adopt each version's defaults. I ran the suite at each version after the repairs above.

**7.1**

These need a change first:
- **`default_column_serializer = nil`:** every test errors with `missing keyword: :coder`, from `Notebook`'s `serialize :preferences`.
  - **Fix:** `serialize :preferences, coder: YAML`. Existing YAML reads and writes in the same format (checked).
- **`raise_on_assign_to_attr_readonly`:** updating a notebook raises `ReadonlyAttributeError: slug`, because the settings form resubmits the slug.
  - **Fix:** drop `:slug` from `notebook_params`. Create ignores it anyway, since the slug is always derived from the name.
- **`raise_on_invalid_cache_expiration_time`:** the exports page raises `Cache expiration time is invalid, cannot be negative: -60.0` for any expired export.
  - Under the old value, 8.1 does something different from 7.0. It logs that error and stores the fragment with **no expiry** (probe J: 7.0 read back nil, 8.1 read back 1).
  - **Fix:** `expires_in: [export.expires_at - Time.current, 1.second].max`. I recommend this over `cache_if downloadable?`. That alternative breaks the existing test that deliberately serves the stale link.
- **`sanitizer_vendor` HTML5:** fine once repair 2 is in.

Safe to adopt after the whole fleet runs 8.1, because 7.0 servers can't read what the new values write:
- `message_serializer` and `use_message_serializer_for_metadata` (signed and encrypted messages)
- `cache_format_version 7.1`
- `marshalling_format_version` (only matters if records are stored in a cache)

No effect on this app:
- `parameters_hash_equality`
- the encryption settings (no encrypted attributes)
- `run_commit_callbacks_on_first_saved_instances`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined` (no app `after_commit` callbacks)
- `sqlite3_strict_strings`
- `query_log_tags_format`
- `generate_secure_token_on`
- `belongs_to_required_validates_foreign_key`
- `precompile_filter_parameters`
- `add_autoload_paths_to_load_path` (only `lib/tasks` exists)

Minor:
- `debug_exception_log_level`, `log_file_size`
- `dom_testing_default_html_version` (the suite passes with it)
- `default_headers` (drops `X-Download-Options`)

The 7.1 setting `commit_transaction_on_non_local_return` no longer exists. Since 7.2 a `return` inside a transaction always commits, which is repair 11.

**7.2**
- **`postgresql_adapter_decode_dates`:** the activity report raises `TypeError: no implicit conversion of Date into String` in `Notebook#daily_note_counts`.
  - **Fix:** `day.to_date` instead of `Date.iso8601(day)`. It works with both the old and new values, and on 7.0.
- **`enqueue_after_transaction_commit`:** in 8.1 the app-wide setting is gone, so enqueuing stays immediate by default. Do **not** turn it on per job for `CitationEnrichmentJob` or `NoteReminderJob`. With it on and Redis down, the citation stays `"pending"` and a retry returns `false`, so it is stuck (`probe2_81_eac.log`).
- **`web_image_content_types` adds WebP:** WebP uploads are now treated as images. Minor.
- **`validate_migration_timestamps`:** all 12 migrations already use the correct format.
- **`yjit`:** a production memory decision.

**8.0**
- **`strict_freshness`:** `ExportDownloadsController` checks expiry before `stale?`, and its ETag is the file's checksum. Safe.
- **`to_time_preserves_timezone`:** no longer a default; it is always on in 8.1 (repair 15).

**8.1**
- `escape_json_responses`, `escape_js_separators_in_json`: the app has no JSON responses.
- `action_on_path_relative_redirect`: controllers redirect with `_path` helpers.
- `raise_on_missing_required_finder_order_columns`, `render_tracker`, `remove_hidden_field_autocomplete`: the suite passes with them.
- `yjit`: production only.

## Rollout and rollback

- **Ship most fixes first.** Everything marked "works on 7.0" can go out on 7.0 as a preparatory release. That includes repairs 11, 12 and 16, which fix data and behaviour problems that do or could already reach production.
- **Upgrade commit:** the Rails and json versions, `coder: JSON`, `:polynomially_longer`, and `show_exceptions :none`.
- **Sessions survive both ways.** Signed and encrypted cookies written by either version are read by the other (`cookies{70,81}.json`).
- **Queued and scheduled jobs survive both ways**, given repair 16.
- **Adopt newer defaults one version at a time,** only after the whole fleet runs 8.1.
- **Sidekiq adapter will need replacing before Rails 8.2.** The built-in adapter logs "deprecated and will be removed in Rails 8.2". Moving to Sidekiq 7.3.3 or later is a separate task, and it is not required for 8.1. Before that move, three things in this app need changing (inferred from Sidekiq's documented changes, not tested):
  - `ExportJob.perform_async(…, { format: "markdown" })` uses symbol keys; it only warns today but will raise.
  - `User#request_digest` relies on `sadd` returning true or false; it will return an Integer, so `if` is always true.
  - `rescue Redis::BaseError` in `Notebook#request_export` will no longer match.

## Not verified

- System (browser) tests were not run; they need a display.
- Production with real Redis and Sidekiq workers was not run. Only the test environment was booted under Puma 5 on Rack 2.2: `/session/new` returned 200 and `/journal` redirected to sign-in.
- The production cache store's behaviour across mixed versions.
- Whether any 7.2 or later build ever reached production, which is what makes the import audit in repair 11 necessary.

---

**My notes:**
- This is only a plan. I haven't changed your repository, which is still on Rails 7.0.8.7.
- The plan's summary says there are fifteen required repairs, but the list has 16.
- The planner wrote three test keys into your local Redis db 0 (`digest_requests:2026-10-05` through `2026-10-07`). They expire within 48 hours, or you can delete them now.
- If you want me to go ahead, I'd suggest starting with the preparatory commit: the repairs marked "works on 7.0".