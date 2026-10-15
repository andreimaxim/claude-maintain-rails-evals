# Plan: Rails 7.0.8.7 to 8.1.0 for Margin Notes

Upgrading to Rails 8.1.0 breaks the application as it stands. It fails to boot, and once booted it has one data-loss path and several silent behavior changes. All of this was found in a disposable copy at `/tmp/exp`.

The copy has its own Postgres databases (`exp_mn_test` and `exp_mn_dev`) and Redis db 9. I did not modify `/home/user/workspace/repo`.

## Evidence and variants

- **Change index:** `/tmp/out/changes.txt`, from `gem-changes rails 7.0.8.7 8.1.0`. It covers 7.0.10, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0.
- **Baseline:** the 7.0.8.7 copy at `/tmp/base` passes 46 runs, 0 failures (`/tmp/out/test70.log`).
- **Upgraded copy:** `bundle update rails` resolved rails 8.1.0, json 3.1.0, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1 and minitest 5.27.0. The bundle log is `/tmp/out/bundle.log`. The experiment lockfile is `/tmp/out/artifacts/Gemfile.lock.81`.
- **Repairs:** I applied the repairs one at a time. Test logs run `test81.log` through `test81j.log` in `/tmp/out`. The cumulative diff is `/tmp/out/artifacts/exp-81.diff`.
- **Final upgraded run:** 46 runs, 1 failure. The failure is an expectation that has to change, covered in finding 11.
- **Other checks:**
  - `zeitwerk:check` passes.
  - Eager load passes with `CI=1`.
  - Production boots.
  - A real Sidekiq 6.5.12 worker ran `ExportJob` and `DigestJob` against 8.1 (`/tmp/out/sidekiq.log`). The export ended `completed`.
  - Rich text rendering with `details`, `summary` and a file attachment worked after the initializer repair.
  - 7.0-format `DigestJob` payload: `/tmp/out/payload70.json`.
- **Preparatory variant:** `/tmp/prep` on 7.0.8.7, `/tmp/out/test70prep.log`. It had 9 failures. Eight of them are the `show_exceptions` change that only works on 7.1+. The ninth is the reminder expectation change from finding 11.

The tests only catch some of these. Findings 4, 7, 8 and 10 surfaced because tests broke. Findings 6 and 9 are only partly or not at all detected by the existing tests, and I list what to add.

## Required changes (found by experiment)

Findings 1 to 7 are runtime failures. Findings 8 to 11 are silent behavior changes.

1. **Boot failure in `config/initializers/action_text.rb`.**
   - Without a repair: `NoMethodError: undefined method '+' for nil` at `ActionText::ContentHelper.allowed_tags += %w[details summary]`. Every command, including `db:create`, aborts.
   - Cause: `allowed_tags` is nil from 7.1 on. The sanitizer's defaults are computed lazily.
   - Repair: assign `(helper.allowed_tags || helper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`.
   - Do not use only `sanitizer.class.allowed_tags + %w[details summary]`. It would strip `action-text-attachment`, `figure` and `figcaption`.
   - Check on the upgraded app: sanitize `<details><summary>s</summary>x</details><figure>f</figure>` and a note with a blob attachment. Both render intact (verified). Control: a `<script>` tag is still removed.
   - The repair also works on 7.0, because `allowed_tags` is already set there.

2. **Removed API in `app/models/note.rb`.**
   - `enum status: {...}, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when `Note` loads.
   - Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. It also works on 7.0.
   - Control: `status_ready` and `status_draft?` still work.
   - Validation: load `Note`, then run the digest and notes filter tests.

3. **`serialize` without `coder:` in `note.rb` and `notebook.rb`.**
   - `serialize :tags, JSON` raises `ArgumentError: wrong number of arguments (given 2, expected 1)`. Bare `serialize :preferences` fails on the default-serializer removal.
   - Repair: `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
   - The `coder:` form only exists from 7.1, so this cannot ship before the upgrade.
   - Stored data is unchanged. `tags` is JSON text and `preferences` is YAML text of a string-keyed Hash, both written by 7.0.
   - Validation: read a notebook and a note written by 7.0, rewrite them under 8.1, and read them back from 7.0 during rollback. The `tags` and `settings` values round-tripped in the smoke run.

4. **`alias_attribute :highlight_color, :color` in `note.rb`.**
   - `color` is a `store_accessor` key, not a column. Loading raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'...`.
   - Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
   - This keeps creation and update working. The form and `permit(:highlight_color)` still work, and the note-form tests pass.
   - Do not use `where(highlight_color:)`. It never worked and is not used.

5. **Multi-path route in `config/routes.rb`.**
   - `get "/notes", "/journal", to: ...` raises `Wrong number of arguments (expect 1, got 2)`.
   - Repair: two `get` lines. Both `notes` and `journal` stay named and both paths serve the list. I confirmed this with `rails routes`.

6. **`Rails.application.secrets` was removed.**
   - `Citation::Provider` and its test call it. It fails with `NoMethodError: undefined method 'secrets'`, and nothing is reported until a lookup happens.
   - Repair:
     - Rename `config/secrets.yml` to `config/citation_provider.yml` and use `config_for(:citation_provider)`.
     - Keep the ERB and `.to_json` environment reads. Flatten the key, or use `config.x.citation_provider = config_for(:citation_provider).citation_provider` as I did.
     - Read `Rails.configuration.x.citation_provider` in the provider.
   - A mistake to avoid: leaving the top-level key nested sent `Basic Og==` (empty credentials) in the HTTP requests.
   - Validation: the existing test for credentials such as `"00123"` and `"sample: value # keep"` reaching the server unchanged passes. A fresh `rails runner` subprocess reads the environment. This works on 7.0 too.

7. **Several smaller removed or tightened APIs.** Each failed on 8.1 and passes after its repair.
   - **`form_with(model: nil, ...)`** in `notes/index.html.erb` raises `Passed nil to the :model argument`. Drop `model: nil`.
   - **`where(notebooks: @notebook)`** in `NotesController#index` produces `PG::UndefinedColumn: column notes.notebooks does not exist`. Use `where(notebook: @notebook)`.
   - **`fragments.sum`** in `Export#generate` raises `TypeError: String can't be coerced into Integer`. 7.0 only warned. Use `fragments.join`. Any export would fail.
   - **`set(wait_until: Integer)`** in `Note#schedule_reminder` raises `NoMethodError: undefined method 'utc' for an instance of Integer`. Use `Time.at(reminder_epoch)`. The test adapter's `at` value is the same epoch.
   - **`wait: :exponentially_longer`** in `CitationEnrichmentJob` raises `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. Use `:polynomially_longer`.
   - **`config.action_dispatch.show_exceptions = false`** in `test.rb` no longer means "raise". The "another reader's record" tests then get a 404 and report `RecordNotFound expected but nothing was raised`. Use `:none`. This is 7.1+ only.
   - Controls: the tests that exercise these paths pass after the repairs.

## Silent changes that tests would partly miss

8. **`Import#apply` leaves partial data (data-integrity bug).**
   - `return false` inside `transaction do ... end` commits on 8.1. Rollback-on-return was removed.
   - Observed: after an invalid row, `record_counts` went from `[0,3,0,1]` to `[1,4,1,2]`. An Import, a Citation and a valid note were saved. The documented contract is "saves the import with every row's note, or saves nothing".
   - Repair: set `saved = false`, call `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`, then `saved = true`, and return `saved` after the block. This keeps the success path and rollback on invalid rows.
   - It also works on 7.0, so it can ship first.
   - Validation: the existing invalid-CSV import test fails on 8.1 without the repair. Add a control that a fully valid CSV still creates 1 Import and all notes.
   - Adopting `commit_transaction_on_non_local_return` would not help here. It only controls this commit.
   - The `with_lock` blocks never use `return`, so they are fine.

9. **`Import#receipt` silently blanks the DOI column.**
   - `citation[:id]` no longer reads the primary key (`doi`). The CSV receipt gave `On idleness,` instead of `On idleness,10.1000/Essays.1`. The tests caught it, but no error is raised.
   - Repair: `citation.id`, which works on 7.0.
   - Validation: download `receipt.csv` for notes with and without a citation and compare.

10. **`HashWithIndifferentAccess#stringify_keys` now converts integer keys.**
    - On 8.1 `{2=>"x"}.stringify_keys` has key `"2"`. On 7.0 it kept key `2`. The import preview's `annotations[row.line]` then returns nil, so annotations vanish from the preview. The test failed with the DOI shown where the annotation belongs.
    - Repair: drop `.stringify_keys` in `app/views/imports/preview.html.erb`, because integer keys already work. This is safe on 7.0.
    - Validation: preview `Adam Bede,...,First reading` and `,...,Second reading`, and assert the annotation in `#line_N dd`.

11. **Digest day and reminder wall-clock display.**
    - **Digest.** Active Job serialization (7.1+) now carries the zone name. A `DigestJob` for an Eastern reader at `2026-10-04T23:30-04:00` now covers 4 October instead of the UTC day 5 October. The subject date and the `all_day` window both change. The test failed with `"October 04, 2026"`.
      - Repair: `requested_at = requested_at.utc` before `to_date` and `all_day` in `DigestMailer`. The mailer comment says the digest is for the UTC day.
      - The repair is a no-op on 7.0, where the worker zone is UTC.
      - Rollout: a 7.0 worker reads the new payload fine and ignores the `time_zone` key. An 8.1 worker reads an old payload without it and falls back to `Time.zone`, which is UTC. I confirmed this from source. I did not run a 7.0 payload through an 8.1 `perform_now` and look at the result.
      - `completion` stays the legacy string `"0.0"` (confirmed in `payload70.json`).
    - **Reminder.** `reminder_at.to_time + 86_400` stopped keeping the offset. Display went from `2026-11-01T09:00:00-04:00` to `08:00-05:00`.
      - The postponed instant is identical (13:00Z), so `postpone_reminder` is unchanged. The 7.0 label was wrong.
      - Recommendation: `reminder_at + 86_400` without `to_time`, which is correct on both versions. Update the comment on `next_day_reminder_at` and the expectation at `reminders_controller_test.rb:21`.
      - Do not change `to_time_preserves_timezone` to chase the old label.

## Dependency finding

- `activesupport 8.1.0` depends on an unpinned `json`, so bundler chose `json 3.1.0`. That version breaks `ActiveSupport::JSON.decode`: `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291`. It hit every JSON-serialized or store column.
- Add `gem "json", "< 3"` (resolved 2.21.2 in the copy) until a Rails patch release handles json 3. I did not test any 8.1.x patch release.
- Other pins held: `sidekiq 6.5.12`, `redis 4.8.1`, `pagy 8.6.3`, `faraday 1.10.4`, `puma 5.6.9` and `rack 2.2.24` all worked on 8.1.0 in the runs above.
- The `minitest "~> 5.25"` pin existed for Rails 7.0. In the copy I removed the constraint and bundler resolved 5.27.0. Rails 8.1 may work with Minitest 6, but I did not test it.
- Sidekiq 6.5 is old for Rails 8. It worked here for `perform_async` and Active Job jobs. Whether it is supported on Rails 8.1 is unverified.

## New defaults from `load_defaults 7.1` through 8.0

The app keeps `load_defaults 7.0`, so none of these apply until adopted.

- **7.1**
  - `allow_deprecated_parameters_hash_equality = false`: adopting would make `params == hash` comparisons false. I found none in `app`.
  - **Encryption:** `hash_digest_class`, `support_sha1_for_non_deterministic_encryption`. The app has no `encrypts` calls, so there is no effect.
  - **`sqlite3_adapter_strict_strings_by_default`:** not applicable, the app uses PostgreSQL.
  - **`run_commit_callbacks_on_first_saved_instances_in_transaction`:** the models have no `after_commit` callbacks, so there is no effect.
  - **`allow_deprecated_singular_associations_name`:** the app has no singular association named in the plural.
  - **`use_big_decimal_serializer = true`:**
    - `User#request_digest` passes a BigDecimal to `DigestJob`, which today sends a string.
    - Old workers cannot decode it.
    - Adopt this in a separate later deploy.
  - **`raise_on_invalid_cache_expiration_time`:** `Export` uses `expires_in: export.expires_at - Time.current`, which is negative after expiry. Adoption raises `ArgumentError` for expired exports in the view fragment cache. This needs a guard first.
  - **`query_log_tags_format = :sqlcommenter`:** only the log format changes.
  - **Message serialization:** `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`. Both need a two-deploy rollout. First deploy without changing, then enable.
  - **`log_file_size`:** limits dev and test log growth only.
  - **`raise_on_assign_to_attr_readonly = true`:**
    - `Notebook` has `attr_readonly :slug`, and the settings form posts `slug`.
    - On adoption, `update` with a changed slug raises `ActiveRecord::ReadonlyAttributeError`. Today it is silently ignored.
    - `notebook_params` would need to drop `:slug` on update, and creation must still accept it.
    - Validation: run the existing "keeps the slug" settings test.
  - **`belongs_to_required_validates_foreign_key = false`:** `Note belongs_to :notebook` and `:citation, validate: true`. There is a mild extra-query difference only.
  - **`precompile_filter_parameters`:** no effect.
  - **`before_committed_on_all_records`:** no effect.
  - **`default_column_serializer = nil`:** the app already passes explicit coders after finding 3.
  - **`marshalling_format_version = 7.1`:** a two-deploy rollout is needed before it can be adopted.
  - **`run_after_transaction_callbacks_in_order_defined`:** no `after_commit` callbacks.
  - **`commit_transaction_on_non_local_return`:** see finding 8.
  - **`generate_secure_token_on = :initialize`:** the app has no `has_secure_token` use.
  - **Sanitizer vendors (`action_view`, `action_text`):**
    - These move to HTML5. Allowed `details` and `summary` and sanitizing behavior may differ.
    - Test them with real stored note HTML before adopting.
  - **`debug_exception_log_level`:** log level only.
  - **`dom_testing_default_html_version = :html5`:** `assert_select` behavior on HTML5 parsing. I did not test it.
- **7.2**
  - **`enqueue_after_transaction_commit = :default`:**
    - `Note#schedule_reminder`, `Citation#request_enrichment` and `User#request_digest` enqueue inside `with_lock` on purpose, so a failed enqueue rolls back state.
    - Adopting changes this to enqueue after commit. A failed enqueue would leave a pending state committed.
    - Also, the job then runs after commit, which removes the need for the row lock to wait on the request.
    - Keep the old behavior, or move to explicit handling per job with `enqueue_after_transaction_commit = false`.
  - **`web_image_content_types`:** adds `image/webp`. The app has no variants.
  - **`validate_migration_timestamps`:** adoption would reject existing migration files with non-standard timestamps. Check `db/migrate`.
  - **`postgresql_adapter_decode_dates`:** `daily_note_counts` parses `DATE(...)` as `Date.iso8601(day)`. Adoption returns a `Date` and `Date.iso8601(Date)` raises `TypeError`. Change the parse first.
  - **`yjit`:** a memory tradeoff.
- **8.0**
  - **`to_time_preserves_timezone = :zone`:** no further effect beyond finding 11.
  - **`strict_freshness = true`:** `ExportDownloadsController#show` uses `stale?(etag:, last_modified:)`. A client sending both `If-None-Match` and `If-Modified-Since` would be judged by the ETag only. Test it with the checksum ETag.
- **8.1:** `gem-changes` listed no new 8.1 defaults. I did not independently check the 8.1 new-defaults file, so the 8.1 defaults are unverified.

## Recommended order of work

1. Preparatory change set that also works on 7.0.8.7. Run the 7.0 suite after each of these:
   - Finding 8: `Import#apply` rollback.
   - Finding 9: `citation.id`.
   - Finding 10: `stringify_keys`.
   - Finding 11: `.utc` in `DigestMailer`, and `reminder_at + 86_400`.
   - Finding 7: `fragments.join`, `where(notebook: @notebook)`, `form_with` without `model: nil`, and `Time.at` for `wait_until`.
   - Findings 1, 2, 4, 5 and 6.
   - `/tmp/prep` shows these ship cleanly on 7.0.8.7 apart from the 7.1+ items below. The only 7.0 failures there are the `:none` setting and the reminder expectation change.
2. Upgrade change set (needs 7.1+):
   - Finding 3: `coder:`.
   - `show_exceptions = :none`.
   - `polynomially_longer`.
   - The `json < 3` pin and `rails 8.1.0` in the Gemfile.
3. Keep `load_defaults 7.0`. Adopt new defaults one release at a time, each with its own validation. Do not adopt `load_defaults 8.1` in the same release.

## Rollout and rollback

- **Mixed versions:** queued Active Job payloads (TWZ, GlobalID, string completion) deserialize across 7.0 and 8.1 as described in finding 11. The `ExportJob` Sidekiq payload is plain JSON and is independent of Rails.
- **Sessions and cookies:** `cookies_serializer`, `key_generator_hash_digest_class` and the message serializer are unchanged under `load_defaults 7.0`, so existing cookies and signed IDs stay valid. I did not run a cookie round trip across versions.
- **Cache:** the 7.0 cache format version persists, and production booted with it. I did not exercise reading old file-store fragments.
- **Rollback to 7.0:** stored data is unchanged by anything above. Rows saved by finding 8's bug before the repair would have to be cleaned manually. The `coder:` keyword and `show_exceptions: :none` must be reverted on rollback.

## Verification still proposed

- A real browser or system-test run: I did not run `bin/rails test:system`.
- A 7.0 payload through an 8.1 worker `perform_now` and mail check.
- A real 7.0 preparatory deploy with the dev data.
- Importing real CSV files with large, malformed or Unicode rows.
- Any 8.1.x patch release of Rails with json 3.

Redis dbs 7 to 9 on the shared server were flushed after the runs. The isolated databases `exp_mn_*`, `base_mn_*` and `prep_mn_*` still exist.

---

Commentary: This is a plan only, and I have not changed the working application. The planner ran its experiments in a copy under `/tmp`. Those copies and their `exp_mn_*`, `base_mn_*` and `prep_mn_*` databases are still there if you want to clean them up. Tell me if you want me to implement it, starting with the preparatory change set that also works on 7.0.8.7.