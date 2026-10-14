# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible. I took a disposable copy to Rails 8.1.0 and made it pass all 46 tests while keeping `load_defaults 7.0`. That took 17 code or config changes. Most of them also work on 7.0 today and can ship first.

Bumping only the Rails pin breaks boot, and once boot is fixed every test errors. Several of the breakages fail silently rather than loudly:
- A failed CSV import now saves a partial import.
- The import receipt drops DOIs.
- The import preview loses annotations.
- Digest emails switch from the UTC day to the reader's local day.
- The day-later reminder preview shows a different time.

The biggest rollout risk is stored data: some 8.1 defaults write signed values into note bodies that 7.0 can't read, which would make rollback unsafe.

The working repository was not modified (git status is clean). All experiments ran in copies under `/tmp/upg/`, each using its own uniquely named Postgres databases (since dropped), a private redis-server on port 6390 (since stopped), and its own storage and cache directories.

## Experiment record

| Copy | What it is | Result |
|---|---|---|
| `/tmp/upg/base` | Unchanged 7.0.8.7 | 46 runs, 0 failures (`logs/base-test.log`). One `Enumerable#sum` deprecation; Sidekiq warns that `ExportJob` arguments aren't JSON-safe. |
| `/tmp/upg/new` | rails 8.1.0, `json < 3`, all required fixes, `load_defaults 7.0` | 46 runs, 340 assertions, 0 failures (`logs/new-test10.log`). Diff: `logs/base-to-new.diff` |
| `/tmp/upg/prep`, `/tmp/upg/prep2` | 7.0.8.7 plus only the fixes that work on both versions | 46 runs, 0 failures, no deprecations (`logs/prep-test3.log`, `logs/prep2-test2.log`). Diff: `logs/base-to-prep2.diff` |
| `/tmp/upg/defs` | `new` with `load_defaults` stepped 7.1 → 7.2 → 8.0 → 8.1 | Logs `logs/defs-<ver>-test.log`; after fixes, 0 failures at 7.0 and 8.1 (`logs/defs-fixed2-*.log`). Diff: `logs/new-to-defs.diff` |

- **Resolved versions** (`logs/new-resolved.txt`): rails 8.1.0, json 2.21.2 (after the pin), sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, rack 2.2.24, turbo-rails 2.0.12, action_text-trix 2.1.19, Ruby 3.3.6.
- **Commands**: tests ran with `RAILS_ENV=test DATABASE_URL=postgres:///upg_<copy>_test REDIS_URL=redis://localhost:6390/<n> bin/rails test`. The probe scripts are in `/tmp/upg/*.rb`.
- **Other checks that passed**:
  - Production boots with eager loading on both versions, with the Sidekiq adapter (`logs/prod-boot-*.log`).
  - `zeitwerk:check` passes.
  - Puma serves pages on 8.1 (`logs/new-server.log`).
  - Running every migration from scratch on 8.1 gives the same schema content. Only column order and the `pg_catalog.plpgsql` prefix change.

## A. Required changes

"Both versions" means I ran the suite on 7.0 with the change applied and it passed, so it can ship before the upgrade.

1. **`Rails.application.secrets` was removed in 7.2.** It's used in `app/models/citation/provider.rb:5` and `test/controllers/citation_enrichments_controller_test.rb`. Citation enrichment fails with ``NoMethodError: undefined method `secrets' for #<MarginNotes::Application>``.
   - **Fix:** in `config/application.rb`, add `config.x.citation_provider = config_for(:secrets).citation_provider`. The provider then reads `Rails.configuration.x.citation_provider.to_h`, and the tests set it the same way. You could rename the file to `config/citation_provider.yml` at the same time.
   - **Checked:** this produces the same symbol-keyed hash. A user of `00123` and a password of `a: b # c` survive unchanged in production on both versions, and the "credentials from the environment reach the server unchanged" test passes. Works on both versions.

2. **`json 3.x` breaks Active Support 8.1.0.** Bundler resolves `json 3.1.0`. ActiveSupport 8.1.0 passes options to `JSON.parse` in a way json 3 rejects, so every JSON-coded column fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291`. That covers `Note#tags` and Active Storage blob metadata, and caused 30 request failures.
   - **Fix:** add `gem "json", "< 3"` to the Gemfile. That resolved to 2.21.2.

3. **Old-style `enum` is removed in 8.0.** `app/models/note.rb:10` is `enum status: {...}, _prefix: true`, and the app fails to load at that line. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`, the same form `Citation` already uses. Works on both versions.

4. **`serialize` with a positional coder is removed in 7.2.** `serialize :tags, JSON` (`note.rb`) fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`. Use `serialize :tags, coder: JSON`. This form only exists from 7.1, so it has to ship with the upgrade. The stored format is unchanged, and tags written on 7.0 read back correctly on 8.1.

5. **`alias_attribute` can no longer point at a store accessor.** `alias_attribute :highlight_color, :color` fails with `` ArgumentError: Note model aliases `color`, but `color` is not an attribute. Use `alias_method :highlight_color, :color` ``.
   - **Fix:** `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`.
   - **Checked:** the form, the strong params and the list highlight all still work. Works on both versions.

6. **One `get` with two paths is no longer accepted.** `config/routes.rb:18` raises `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Split it into `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. This keeps the `notes_path` and `journal_path` helpers. Works on both versions.

7. **Action Text `allowed_tags` starts as `nil` from 7.1.** `config/initializers/action_text.rb` fails at boot with ``undefined method `+' for nil (NoMethodError)``.
   - **Fix:** use the version in `/tmp/upg/action_text_fix.rb`. It runs in `after_initialize`, starts from either the existing list or the sanitizer's defaults plus `action-text-attachment`, `figure` and `figcaption`, then adds `details` and `summary`.
   - **Checked:** `<details>` survives with both the HTML4 and HTML5 sanitizers. Works on both versions.

8. **`form_with(model: nil, ...)` is removed in 8.0.** The search form in `app/views/notes/index.html.erb:12` fails with `Passed nil to the :model argument`, so the notes index returns 500. Drop `model: nil`; the parameter names stay the same. Works on both versions.

9. **`where(notebooks: @notebook)` no longer works.** In `notes_controller.rb:12` it raises `PG::UndefinedColumn: column notes.notebooks does not exist`. Use `where(notebook: @notebook)`. Works on both versions.

10. **`Array#sum` of strings now raises.** In `export.rb:42`, `fragments.sum` fails with `TypeError: String can't be coerced into Integer`, so every export job fails. Use `fragments.join`. Works on both versions and removes the current deprecation.

11. **Epoch integers in `set(wait_until:)` no longer work.** `note.rb` passes `reminder_epoch` directly and gets ``undefined method `utc' for an instance of Integer``. Use `wait_until: Time.at(reminder_epoch)`. Works on both versions.

12. **`retry_on wait: :exponentially_longer` is removed in 7.2.** In `citation_enrichment_job.rb`, use `:polynomially_longer` (same formula). That value only exists from 7.1, so it ships with the upgrade.

13. **`show_exceptions = false` is removed in 7.2.** In `config/environments/test.rb`, the request tests that expect `RecordNotFound` or `Redis::CannotConnectError` to raise get rescued 404/500 responses instead. Set it to `:none`. Don't do this early: on 7.0 the symbol counts as true. Production is not affected.

14. **A failed import now saves partial data.** In `Import#apply` (`import.rb:50-61`), the `return false` inside `transaction` used to roll back. From 8.0 it always commits. Observed: `` `record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2] `` — an Import, a Note and a Citation persisted from a rejected file.
    - **Fix:** `saved = rows.all? { |row| row.note.save }; raise ActiveRecord::Rollback unless saved`, then return `saved`.
    - **Checked:** both the successful and the invalid-row paths. The import record is restored to unsaved, so the controller's preview re-render still works. Works on both versions.

15. **`citation[:id]` no longer returns the primary key** (removed in 7.2). `Citation`'s primary key is `doi`, and the import receipt CSV (`import.rb`) now gets an empty DOI column. Observed: `citation[:id]=nil id="10.1000/x"`. Use `citation&.doi`. Works on both versions.

16. **`HashWithIndifferentAccess#stringify_keys` now really stringifies.** In `imports/preview.html.erb`, `annotations[row.line]` looks up integer keys, so annotations silently disappear from the preview. Observed: `stringify_keys[2]=nil keys=["2"]` on 8.1, versus `"ann"` on 7.0. Remove `.stringify_keys`. Works on both versions.

17. **Job time arguments now keep the reader's time zone (7.1).** The Active Job time serializer now restores the original zone. `DigestMailer` uses `requested_at.to_date` and `.all_day`, so the digest moves from the UTC day to the reader's local day. That changes both the subject (`October 04` instead of `October 05`) and which notes are listed.
    - **Fix:** in `DigestMailer`, add `requested_at = requested_at.in_time_zone("UTC")`. That covers jobs enqueued by either version (7.0 payloads carry no zone).
    - **Checked:** cross-version Sidekiq payloads gave `October 05` in both directions. Works on both versions.

18. **`to_time` now keeps the zone, and the old setting is ignored in 8.1** (it reports `nil` and logs a deprecation, even under 7.0 defaults). `Note#next_day_reminder_at` (`reminder_at.to_time + 86_400`) still points at the same instant, so scheduling is unaffected. But the preview across the DST change now reads `2026-11-01T08:00:00-05:00` instead of the `09:00:00-04:00` your test asserts.
    - **Fix (keeps the old display):** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. Works on both versions.
    - **Decision for you:** the alternative is to accept the new, arguably more correct local time and update the test.

19. **Negative cache lifetime for expired exports.** `exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export expires. On 8.1 with the old default, every render reports `ArgumentError: Cache expiration time is invalid, cannot be negative` as a handled error. Under the 7.1 default it becomes `ActionView::Template::Error` and the exports page returns 500.
    - **Fix:** `expires_in: [export.expires_at - Time.current, 1.second].max`.
    - **Rejected alternative:** `cache_if export.downloadable?` also bypasses reading the cache, which broke the test "the cached availability indicator does not authorize a download".
    - **Checked:** works on both versions and under both default sets. The test suites use `:null_store`, but that test switches to a memory store.

20. **Pass the digest's completion as a string.** I'd make this change before the upgrade. 8.1 always wraps `BigDecimal` job arguments in a new serializer; the setting that controlled this was removed in 7.2. A 7.0 worker given one fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. `DigestJob` has no `discard_on`, so the job retries and the reader's daily reservation stays held.
    - **Fix:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already does `BigDecimal(params[:completion])`.
    - **Checked:** both directions succeed and both suites pass. Deploy it on 7.0 first.

## B. Framework defaults: current state and what adopting each would change

Everything below stays at its old value because the app calls `load_defaults 7.0` with no overrides.

**7.1**
- **`raise_on_assign_to_attr_readonly`:** the notebook settings update fails with `ActiveRecord::ReadonlyAttributeError: slug`, because the form posts a hidden `slug` and the controller permits it. Remove `:slug` from the permitted params. Notebook creation is unaffected because the slug is generated before validation.
- **`default_column_serializer = nil`:** every test errors with `missing keyword: :coder` because `Notebook` uses `serialize :preferences` with no coder. Use `serialize :preferences, coder: YAML` (7.1+ only). Preferences written on 7.0 read back correctly.
- **`raise_on_invalid_cache_expiration_time`:** causes the 500 in A19; the fix there covers it.
- **`message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true`:** these block rollback.
  - Attachment links (SGIDs) that 8.1 writes into note bodies under these defaults crash 7.0 when it reads them: ``undefined method `unpack1' for nil (NoMethodError)``.
  - With only the metadata setting turned off, 7.0 silently treats the attachment as missing (`rendered_has_blob=false`).
  - 8.1 under 7.0 defaults writes the old format, and 7.0-written links read fine on 8.1 under either default set.
- **`cache_format_version 7.1` and `marshalling_format_version 7.1`:** the app only caches HTML fragments in a per-host file store, so the impact is small. A host on 7.0 can't read entries written in the new format. I reasoned this from source and didn't test it.
- **HTML5 sanitizer for Action View and Action Text:** the tests pass, including `<details>` being kept and unsafe markup dropped. Edge-case markup in saved bodies may sanitize slightly differently; not compared.
- **`dom_testing_default_html_version :html5`:** the tests pass with it.
- **`belongs_to_required_validates_foreign_key = false`:** a required `belongs_to` then checks only the foreign key column, not the loaded record. `owned_notebook` returns `nil` for another reader's notebook, so the "must exist" error still fires. The test passed.
- **Settings with no effect here:**
  - `run_commit_callbacks_on_first_saved_instances`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`: the app defines no commit callbacks.
  - `generate_secure_token_on`: no `has_secure_token`.
  - Active Record encryption settings: the app doesn't use encryption.
  - `sqlite3_adapter_strict_strings_by_default`: the app uses Postgres.
  - `query_log_tags_format`: query log tags aren't enabled.
  - `precompile_filter_parameters`: performance only.
  - `add_autoload_paths_to_load_path = false`: the app doesn't `require` from autoload paths.
  - `log_file_size`: development and test only.
  - `debug_exception_log_level`: changes log level only.
  - `default_headers`: drops `X-XSS-Protection`.
  - `allow_deprecated_parameters_hash_equality`: no comparisons found.
  - `use_big_decimal_serializer`: moot, since 8.1 ignores it (see A20).
  - `commit_transaction_on_non_local_return`: moot, since 8.1 always commits (see A14).

**7.2**
- **`postgresql_adapter_decode_dates`:** the activity report fails with `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`. Use `[day.to_date, count]`; works on both versions.
- **`enqueue_after_transaction_commit`:** with these gems it is effectively `false` even under `load_defaults 8.1`. I checked with Redis unreachable: `schedule_reminder` still raises and leaves no `reminder_job_id`, the same as today.
- **`web_image_content_types` adds webp:** only affects how blobs display. The app has no variant processing.
- **`validate_migration_timestamps`:** the existing migrations replay cleanly on 8.1 (run under the 7.0 defaults); the timestamps look valid by inspection.
- **`yjit = true`:** more memory use in production on Ruby 3.3.6.

**8.0**
- **`strict_freshness`:** in `ExportDownloadsController`, `stale?(etag:, last_modified:)` would only consult `If-None-Match`. Content is keyed by checksum, so the risk is low. Reasoned from source, not tested.
- **`Regexp.timeout = 1`:** the CSV parsing and DOI regex are bounded by the 100 KB limit. Not tested.
- **`to_time_preserves_timezone`:** already in effect regardless of the setting (A18).

**8.1** (from the railties source; the suite is green under `load_defaults 8.1` after the fixes above)
- **`action_on_path_relative_redirect = :raise`:** every redirect in the app uses absolute paths or helpers.
- **`escape_json_responses = false`, `escape_js_separators_in_json = false`:** the app has no JSON endpoints.
- **`raise_on_missing_required_finder_order_columns`:** no failures seen.
- **`render_tracker = :ruby`, `remove_hidden_field_autocomplete`:** markup and cache-digest differences only.
- **`yjit` only outside local environments.**

## C. Rollout order

1. **Deploy on 7.0 first:** A1, A3, A5–A11, A14–A20 and the B fix for activity-report dates. Optionally also remove `:slug` from the permitted params.
2. **Deploy the upgrade:** rails 8.1.0, the `json < 3` pin, A4, A12, A13, keeping `load_defaults 7.0`. Rolling between 7.0 and 8.1 is safe for:
   - **Sessions:** a cookie from either version works on the other with the same secret.
   - **Queued and scheduled jobs:** all three job types ran in both directions through the real Sidekiq payload format once A20 is in.
   - **Stored data:** tags, preferences and attachments are readable both ways.
   - **Local environments:** development and test sessions will reset, because 8.1 uses `tmp/local_secret.txt` instead of `tmp/development_secret.txt`.
3. **Adopt defaults later, in steps.** Apply the slug, `coder: YAML`, date and cache fixes first. Flip the two message-serializer settings only once you've ruled out rolling back to 7.0, since they permanently change stored attachment data.

## Unverified items and open questions

- **Browser behaviour wasn't tested** (no browser installed). The layout still loads the vendored `trix-1.3.5.js`, while Action Text 8.1 ships Trix 2.1.19 via `action_text-trix`. The 8.1 `actiontext.js` only uses Trix events and APIs that 1.x has, but check editing and uploading attachments manually.
- **Sidekiq 6.5.12 works but is on notice.** 8.1 warns: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later". Sidekiq 7 will also reject `ExportJob`'s symbol-key arguments and changes the `sadd`/`srem` return values used in `User#request_digest`. That's a separate upgrade.
- **The test suite can reach shared Redis.** It pushes `ExportJob` to real Redis, at `localhost:6379` unless `REDIS_URL` is set.
- **Not exercised at runtime:** `strict_freshness`, cache-format rollover across hosts, and HTML5 sanitizer differences on real stored bodies.
- **Product decision:** whether the day-later preview should keep the old fixed offset (A18).
- **Copy differences:** `/tmp/upg/defs` predates A20, and `prep2` was the copy used to check the 7.0-compatible fixes on 7.0.

---

**My notes:**
- This is a plan only. Your repo hasn't changed; the only edits are in the scratch copies under `/tmp/upg/`.
- The summary says it took 17 changes, but section A lists 20 items. Use the list in section A.
- Before anything can be implemented, you need to make two decisions:
  - **Pinning `json < 3`:** this adds a dependency constraint, which the project rules say needs your approval.
  - **The DST reminder preview (A18):** either keep the old displayed time or accept the new one and update the test.
- If you want, I can start with step C1, the changes that also work on 7.0, on a branch.