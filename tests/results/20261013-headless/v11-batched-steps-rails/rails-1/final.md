# Rails 7.0.8.7 to 8.1.0: upgrade plan for Margin Notes

The upgrade is feasible, but the app will not boot on 8.1.0 as it stands. Once it boots, about a dozen paths fail or silently change, and the test suite does not catch some of them. Rolling back after the upgrade would also lose digest emails unless one small change ships first.

I found 20 required repairs. 14 of them work on 7.0.8.7 and can ship first; I proved this by applying them to a 7.0 copy and running the suite (46 runs, 0 failures). The other 6 need 7.1 or later and belong in the upgrade commit. With all of them applied, 8.1.0 passes 47 runs with 0 failures and no deprecation warnings. The working repository was not modified.

## How I tested
- **Copies:**
  - `/tmp/up/base`: unchanged 7.0.8.7 baseline. 46 runs, 0 failures, 3 `Enumerable#sum` deprecation warnings.
  - `/tmp/up/v81`: Rails bumped only. Used to find failures one at a time.
  - `/tmp/up/prep70`: 7.0.8.7 plus the preparatory changes.
  - `/tmp/up/v81fix`: 8.1.0 plus all changes.
- **Isolation:**
  - Separate Postgres databases: `mnup_<copy>_test` and `mnup_mixed`.
  - A private Redis on port 6390 (db 0 for tests, db 1 for queue experiments), started in `/tmp/up/redis` and shut down afterwards.
  - Storage and caches stay inside each copy.
- **Dependencies:** `bundle lock --update rails` changed only the Rails gems; everything else stayed pinned (sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, pagy 8.6.3, concurrent-ruby 1.3.4, minitest 5.27.0). The json gem needed a pin (finding 16).
- **Change scripts:** `/tmp/up/scripts/prep.py`, `prep2.py`, `prep3.py` (works on 7.0) and `upgrade_only.py` (needs 7.1+). The full diffs are in `/tmp/up/prep70.diff` and `/tmp/up/v81fix.diff`.
- **Logs:**
  - Change index: `/tmp/up/changes.txt`
  - Bundler: `/tmp/up/bundle81*.log`
  - Boot: `/tmp/up/v81-boot-*.log`
  - Tests on the bare upgrade: `/tmp/up/v81-test{1,2}.log`
  - Tests on the fixed copies: `/tmp/up/{prep70,v81fix}-{test,test2,test3,final}.log`
  - Defaults sweep: `/tmp/up/sweep-<ver>.log`, `/tmp/up/probe-<ver>.log`
  - Queue experiments: `/tmp/up/mixed/`, including `sidekiq81.log`
  - Production boot: `/tmp/up/v81fix-prod.log`
- **Defaults sweep:** in `v81fix` only, `load_defaults` was switched by `PROBE_DEFAULTS` and a probe test added at `test/integration/upgrade_probe_test.rb`.
- **Not done:**
  - No browser (system test) run.
  - Rails 7.1, 7.2 and 8.0 were never installed. Their changes come from the changelogs and the 8.1 run.

## A. Changes that also work on 7.0 (ship first)
Each was verified by the `prep70` suite passing on 7.0.

1. **`Rails.application.secrets` was removed in 7.2** (`app/models/citation/provider.rb:13`, and the test helpers at `test/controllers/citation_enrichments_controller_test.rb:45,117`).
   - Without a fix, citation enrichment fails with `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application...>`.
   - Fix: move `config/secrets.yml` to `config/citation_provider.yml`, keeping the `.to_json` quoting. Add `config.x.citation_provider = config_for(:citation_provider)` and read `Rails.configuration.x.citation_provider.to_h`.
   - Check: the three enrichment tests fail without it and pass with it. That includes the subprocess test that boots with credentials from the environment. As a control, the production boot reports keys `[:url, :user, :password]`.
   - `secrets.yml` holds no `secret_key_base`, so session secrets are unaffected.

2. **Action Text initializer** (`config/initializers/action_text.rb`).
   - Without a fix, boot aborts: `undefined method '+' for nil (NoMethodError)`. From 7.1, `allowed_tags` starts out as nil.
   - Fix: assign inside `config.after_initialize`: the sanitizer's own allowed tags plus `ActionText::Attachment.tag_name`, `figure`, `figcaption`, `details` and `summary`.
   - Check: the app boots, and the test "rich text keeps collapsible excerpts and drops unsafe markup" passes. As a control, the probe showed `<img onerror>` and `javascript:` links still stripped.

3. **`enum status: {...}, _prefix: true`** (`note.rb`) uses keyword syntax, removed in 8.0.
   - Error: `wrong number of arguments (given 0, expected 1..2)`.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`.

4. **Two paths in one `get`** (`get "/notes", "/journal"` in `config/routes.rb`), removed in 8.1.
   - Error: `Wrong number of arguments (expect 1, got 2)`.
   - Fix: two separate `get` lines. I checked that the route names `notes` and `journal` are identical before and after.

5. **`alias_attribute :highlight_color, :color`** on a `store_accessor`.
   - Error: "Note model aliases `color`, but `color` is not an attribute."
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. No `highlight_color_*` dirty-tracking methods are used anywhere.

6. **`form_with(model: nil, ...)`** (`app/views/notes/index.html.erb:12`).
   - Without a fix, `/notes`, `/journal` and the redirect after sign-in return 500: `Passed nil to the :model argument, expect an object or false`.
   - Fix: drop `model: nil`.

7. **`fragments.sum`** (`app/models/export.rb`). The `Enumerable#sum` override for strings was removed in 7.1.
   - Without a fix, `ExportJob` fails with `TypeError: String can't be coerced into Integer`. The export stays "working" and Sidekiq keeps retrying.
   - Fix: `fragments.join`. This also removes the deprecation warning on 7.0.

8. **`set(wait_until: reminder_epoch)` with an Integer** (`note.rb`).
   - Without a fix, scheduling or postponing a reminder returns 500: `undefined method 'utc' for an instance of Integer`.
   - Fix: `wait_until: Time.zone.at(reminder_epoch)`.
   - Check: the reminder test confirms the job's `:at` is still the exact epoch.

9. **`return false` inside `transaction`** (`Import#apply`). From 8.0 a `return` inside a transaction commits instead of rolling back.
   - Without a fix, an import with an invalid row saves partial data. Observed: `record_counts` changed, expected `[0, 3, 0, 1]`, got `[1, 4, 1, 2]`.
   - Fix:
     ```ruby
     transaction do
       save!
       raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
       true
     end || false
     ```
   - Check: the "applying them saves nothing" test. As a control, a valid import still adds 2 notes, 1 citation and 1 import.

10. **`citation[:id]` in the import receipt** (`Citation` uses `doi` as its primary key).
    - Without a fix, the downloaded receipt silently loses its DOI column. Observed `On idleness,` where `On idleness,10.1000/Essays.1` was expected.
    - Fix: `note.citation_doi`.

11. **`@import.annotations.stringify_keys`** (`app/views/imports/preview.html.erb`).
    - Without a fix, annotations silently disappear from the preview. The keys now become strings, so lookups by Integer line number miss.
    - Fix: use `row.annotation`. HTML escaping is unchanged, and the test still checks for literal `<b>`.

12. **`where(notebooks: @notebook)`** (`notes_controller.rb`).
    - Without a fix, the notebook filter fails: `PG::UndefinedColumn: column notes.notebooks does not exist`.
    - Fix: `where(notebook: @notebook)`.

13. **`reminder_at.to_time + 86_400`**. 8.1 always keeps the time zone in `to_time`.
    - Without a fix, the "24 hours later" preview across a DST change shows `08:00 -05:00`. The test and the model comment both say it should keep the offset: `09:00 -04:00`.
    - It is the same instant, so the postpone epoch does not change.
    - Fix: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.
    - Alternative: accept the new local wall-clock display and update the test and comment. That is a product decision.

14. **The digest's local date** (`DigestMailer`). From 7.1, Active Job restores a `TimeWithZone` argument in its stored zone.
    - Without a fix, the subject says "October 04" where "October 05" was expected, and the note window moves to the reader's local day. The mailer comment says the digest covers the UTC day.
    - Fix: `requested_at = requested_at.utc`.
    - Check: in the mixed-version experiment, jobs from both versions produced "October 05".

15. **BigDecimal job argument, a rollback risk** (`User#request_digest`). 8.1 always uses `BigDecimalSerializer`, even with 7.0 defaults.
    - Observed: a job enqueued on 8.1 and performed on 7.0 fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
    - The digest is lost, and the Redis reservation makes the reader see "already requested" for the rest of the UTC day.
    - Fix: pass `reading_completion.to_s`; the mailer already calls `BigDecimal(...)` on it.
    - Check: tested in both directions. 8.1 to 7.0 delivered "100% of your notes". Jobs enqueued on 7.0 send `"0.5"`, which 8.1 reads fine.

## B. Changes for the upgrade commit (need 7.1+)
16. **Version bump plus a json pin.** Add `gem "json", "< 3"` (resolved 2.21.2).
    - Without the pin, the resolve picks json 3.1.0 (released 2026-10-13), and requests fail with `wrong number of arguments (given 2, expected 1)` from `ActiveSupport::JSON.decode`.
    - Not checked: whether a later 8.1.x release supports json 3.

17. **`serialize :tags, JSON`**.
    - Error: `serialize: wrong number of arguments (given 2, expected 1)`.
    - Fix: `serialize :tags, coder: JSON`. The stored JSON text format does not change.

18. **`serialize :preferences`**. Change to `serialize :preferences, coder: YAML` now; the stored YAML does not change.
    - It is required before adopting the 7.1 defaults. Otherwise every class load fails with `missing keyword: :coder If no default coder is configured...`.

19. **`config.action_dispatch.show_exceptions = false`** in `test.rb`. Change to `:none`.
    - On 8.1, the "another reader's ... cannot be reached" tests fail with "RecordNotFound expected but nothing was raised".
    - This must not ship on 7.0. There, `:none` is a truthy value and would turn exception display on. That conclusion is from reading the 7.0 source, not executed.

20. **`retry_on wait: :exponentially_longer`**, removed in 7.2. Change to `:polynomially_longer`.
    - This conclusion is from the changelog. I did not run the unfixed failure.
    - The real 8.1 worker retried `CitationEnrichmentJob` correctly with the fix.
    - The wait is computed on the worker, so no stored data is involved.

## C. Rollout, queued work and stored data
- **Order:**
  1. Deploy A on 7.0.8.7.
  2. Let any digest jobs enqueued before that deploy drain.
  3. Deploy B.
  4. Adopt new defaults later, one release at a time (section D).
  - Rails 7.1, 7.2 and 8.0 were not installed separately. Upgrading one minor version at a time would show more deprecation warnings, but I found no extra issues that require it.
- **Queue compatibility:** jobs enqueued on 7.0 performed fine on 8.1: Digest, Reminder (including scheduled ones) and Citation. In the other direction everything worked except the BigDecimal case, which finding 15 fixes. The Sidekiq wrapper class name is the same in both versions.
- **Real Sidekiq worker:** Sidekiq 6.5.12 ran under 8.1 and logged `The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2`.
  - Follow-up, not needed now: move to Sidekiq 7.3 or later.
  - From the docs, not executed: Sidekiq 7's strict arguments would reject `ExportJob.perform_async(id, { format: "markdown" })` because of its symbol keys.
- **Stored data:**
  - `notes.tags` (JSON), `notebooks.preferences` (YAML), `settings` (jsonb) and the Redis digest keys keep their format.
  - Fragment cache keys change once; expect a cold cache, not errors.
  - Not checked: reading session cookies across versions during a mixed deploy. Proposed check: sign in on 7.0, then make a request to 8.1.

## D. New framework defaults
The app calls `load_defaults 7.0` and sets none of the settings below explicitly, so every one of them keeps its old value. The results come from running the suite and the probe under each defaults level (`/tmp/up/probe-*.log`). The tool's index is incomplete here: it omits 8.1's own defaults plus 7.1's `default_headers` and `cache_format_version`, and lists `to_time_preserves_timezone` even though 8.1 removed that option.

**7.1**
- **`raise_on_assign_to_attr_readonly`: breaks notebook settings.** Every notebook update fails with `ActiveRecord::ReadonlyAttributeError: slug`, because the form posts a hidden `slug` and the controller permits it. Creating a notebook still works. Fix before adopting: remove `:slug` from `notebook_params` and drop the hidden field. Proposed, not run.
- **`raise_on_invalid_cache_expiration_time`: breaks the exports page.** Production has caching on, so the exports index returns 500 once any completed export has expired: `Cache expiration time is invalid, cannot be negative: -3600.03...`. Proposed fix, not run: `cache_if export.downloadable?, [export, "availability"], expires_in: ...`.
- **`default_column_serializer = nil`**: needs finding 18 first.
- **`message_serializer`, `use_message_serializer_for_metadata` and `cache_format_version 7.1`**: adopt only after rollback to 7.0 is off the table. Action Text attachment references (signed IDs) stored inside note bodies, and Active Storage URLs, would be unreadable on 7.0. That is from the docs, not executed.
- **HTML5 sanitizer (Action View and Action Text)**: observed output is identical apart from whitespace between `</p><p>`.
- **`default_headers`**: drops `X-Download-Options`.
- **No effect expected:**
  - `marshalling_format_version`: the app caches no records.
  - Encryption digest settings: no encrypted attributes.
  - Secure token generation: no secure tokens.
  - SQLite strict strings: the app uses Postgres.
  - `query_log_tags_format`: query logs are off.
  - `belongs_to_required_validates_foreign_key`: only drops a query.
  - Commit-callback ordering: the app defines no after-commit callbacks.
  - `add_autoload_paths_to_load_path`: no require through the load path.
  - `precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level`.
  - `dom_testing_default_html_version`: the suite passed with it apart from the errors listed in this section.

**7.2**
- **`postgresql_adapter_decode_dates`: breaks the activity report** with `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`. Proposed fix, works on 7.0, not run: `Date.iso8601(day.to_s)`.
- `web_image_content_types` adds WebP; there are no variants without image_processing.
- `validate_migration_timestamps`: the existing migration timestamps are valid.
- `yjit` affects memory use only.
- `enqueue_after_transaction_commit` is not in 8.1's defaults and is observed `false`. If it is ever enabled, re-check the enqueues inside `with_lock` in `Citation#request_enrichment` and `Note#schedule_reminder`.

**8.0**
- `strict_freshness`: no observed difference. A matching ETag with an old `If-Modified-Since` returned 304 under every setting, probably because Rack's conditional-GET handling runs first. Not confirmed.
- `Regexp.timeout = 1`: the DOI and CSV regexes are trivial.

**8.1**
- **`render_tracker :ruby`**: template digests change, so the fragment cache goes cold once.
- **`remove_hidden_field_autocomplete`**: the hidden `slug` and `import[csv]` fields lose `autocomplete="off"`.
- **No effect expected:** `escape_json_responses` (no JSON views), `action_on_path_relative_redirect` (all redirects are path helpers or absolute), `raise_on_missing_required_finder_order_columns`, `escape_js_separators_in_json`, `yjit`.

## Open questions
- Whether a later 8.1.x release removes the need for the json pin.
- No browser (system test) run was done.
- Reading cookies and signed messages across versions during a mixed deploy is unverified.
- The unfixed `retry_on :exponentially_longer` failure was not run.
- The fixes for the readonly slug, the cache expiry and the decoded dates are proposed but not run.
- Optional cleanup: the `concurrent-ruby 1.3.4` pin only exists for 7.0 and can be removed afterwards.

---

I haven't upgraded Rails yet; this is only the plan. Your repository is unchanged (`git status` is clean), and all testing happened in copies under `/tmp/up`.

The safest order is to ship the 15 changes in section A on 7.0.8.7 first, then do the version bump with section B. I can start on section A, or make the full bump in one branch, if you want.

I fixed one numbering error from the planner's report: the json pin is finding 16, not 7.