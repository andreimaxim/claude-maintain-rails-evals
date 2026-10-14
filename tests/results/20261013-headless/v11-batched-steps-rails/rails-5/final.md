# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but it can't ship as a Gemfile bump. With only the version changed, the app doesn't boot. Getting it working took 18 code and config changes plus a `json` pin, all tried in disposable copies. Five of the problems are silent: the test suite catches some only partly and others not at all.

With every repair applied, the upgraded copy passes the full suite (48 runs, 0 failures), both with the current `load_defaults 7.0` and with `load_defaults 8.1` plus 3 more repairs. The working repository was not modified (`git status` is clean).

## How this was tested
- **Copies:** `/tmp/upg/base` (current code on 7.0), `/tmp/upg/up` (8.1 with the required repairs), `/tmp/upg/base2` (7.0 with the repairs that also work there), `/tmp/upg/upd` (8.1 with `load_defaults 8.1`).
- **Isolation:** separate Postgres databases (`upg_*`, dropped afterwards), a private Redis on port 6390 (shut down afterwards), storage and cache inside each copy. In the copies only, the production database user was changed to the local role.
- **Bundle:** `bundle update rails --conservative`. This kept sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, rack 2.2.24, pagy 8.6.3 and faraday 1.10.4. It pulled in json 3.1.0, which I later pinned to 2.21.2.
- **Logs:** `/tmp/upg/logs/`. Change summary: `/tmp/upg/changes.txt`. Diffs: `upgrade.diff` (all repairs), `portable.diff` (repairs that run on 7.0), `defaults.diff` (extra repairs for new defaults). Test runs: `up2.txt` … `up11.txt` and `*-test-final.txt`. Experiments: `mixed.txt`, `mixed2.txt`, `http.txt`.
- **Scripts:** `/tmp/upg/scripts/` (`run_mixed.sh`, `http_flow.sh`, `cookie_cross.sh`, `upgrade_checks_test.rb`).
- **Baseline:** 46 runs, 0 failures on 7.0 (`logs/base-test.txt`).

Each finding below says whether it was **observed** in an experiment or rests on **source** reading only.

## A. Required changes (the app breaks or misbehaves on 8.1 without them)

"Portable" means the repair also works on 7.0 and can ship before the upgrade. I checked this in `base2`: 46 runs, 0 failures.

1. **Rich-text allowed tags make boot fail (observed).** `config/initializers/action_text.rb`: since 7.1, `ActionText::ContentHelper.allowed_tags` is nil by default, so boot fails with `NoMethodError: undefined method '+' for nil`.
   - **Repair:** inside `Rails.application.config.after_initialize`, set `allowed_tags = sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. This gives the same set as today on 7.0. Portable.
   - **Check:** `NotesControllerTest` "rich text keeps collapsible excerpts and drops unsafe markup" (`<details>` kept, unsafe markup dropped). On the production server, the note page still contains `<details>`.

2. **Keyword-style `enum` (observed).** `app/models/note.rb`: `enum status: {...}, _prefix: true` fails with `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. Method names stay the same (`status_ready` etc.). Portable.

3. **`serialize :tags, JSON` (observed).** Fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`.
   - **Repair:** `serialize :tags, coder: JSON`.
   - **Not portable:** on 7.0 the `coder:` keyword is silently ignored and YAML is used (I saw `YAMLColumn`), which would misread the existing JSON tags. Ship it in the same commit as the Rails bump.
   - **Data:** existing rows were written as `["a","b"]` by 7.0 and read back as `["a", "b"]` by 8.1, in both directions (`mixed2.txt`).

4. **`alias_attribute` to a store accessor (observed).** `alias_attribute :highlight_color, :color` fails with `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`.
   - **Repair:** `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. Portable.
   - **Check:** the notes edit test (radio button checked, highlight saved).

5. **Route with two paths (observed).** `config/routes.rb`: `get "/notes", "/journal", ...` fails with `ArgumentError: Wrong number of arguments (expect 1, got 2)`, and `notes_path` disappears.
   - **Repair:** `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. Both route names match what `rails routes` shows on 7.0. Portable.
   - **Check:** both list paths return 200 (test and production server).

6. **`Rails.application.secrets` was removed in 7.2 (observed).** Used in `Citation::Provider` and its test: `NoMethodError: undefined method 'secrets'`.
   - **Repair:** add `config/citation_provider.yml` with the same ERB and environment variables as today (`/tmp/upg/fixes/citation_provider.yml`). Set `config.citation_provider = config_for(:citation_provider)` in `application.rb`, read `Rails.configuration.citation_provider.to_h` in the provider, and update the test to the new accessor. Portable.
   - **Check:** "provider credentials from the environment reach the server unchanged" (it boots a fresh process with environment variables). Also check that production still gets `CITATION_PROVIDER_*`.

7. **json 3.x is incompatible with activesupport 8.1.0 (observed).** The resolver picked json 3.1.0. Every request with a session cookie then fails inside `ActiveSupport::JSON.decode`, which calls `JSON.parse(json, options)`: `ArgumentError: wrong number of arguments (given 2, expected 1)`. Users can't sign in.
   - **Repair:** add `gem "json", "< 3"` (resolved to 2.21.2). This should also work on 7.0, but I didn't run it there.
   - **Unverified:** whether a later 8.1.x patch fixes this. If you move to that patch, drop the pin.

8. **Test environment `show_exceptions = false` (observed).** Integration tests now get rendered 404/500 responses instead of exceptions, so `assert_raises(ActiveRecord::RecordNotFound)` and `assert_raises(Redis::CannotConnectError)` fail ("nothing was raised"). That hides real authorization regressions.
   - **Repair:** `config.action_dispatch.show_exceptions = :none`. Only valid on 7.1+, so ship it with the bump.

9. **`fragments.sum` on strings (observed).** In `Export#generate`, ActiveSupport no longer extends `Enumerable#sum` for non-numbers, so every export job fails with `TypeError: String can't be coerced into Integer`. Exports stay "working" forever.
   - **Repair:** `fragments.join`. Portable.
   - **Check:** the export/download test, and a real Sidekiq worker on the production server writing `"# H\n"`.

10. **`form_with(model: nil, ...)` (observed).** The notes index returns 500: `Passed nil to the :model argument, expect an object or false`.
    - **Repair:** `form_with(url: notes_path, method: :get, ...)`. Same field names. Portable.

11. **`where(notebooks: @notebook)` (observed).** Filtering notes by notebook fails with `PG::UndefinedColumn: column notes.notebooks does not exist`.
    - **Repair:** `where(notebook: @notebook)`. Portable.

12. **`set(wait_until: reminder_epoch)` with an integer (observed).** Scheduling a reminder returns 500: `undefined method 'utc' for an instance of Integer`.
    - **Repair:** `wait_until: Time.at(reminder_epoch)`. Portable. This covers both scheduling and postponing.
    - **Check:** the reminder tests assert the job's `:at` equals the epoch.

13. **`retry_on wait: :exponentially_longer` (observed, silent).** The value was removed in 7.2. On the first `Unavailable` error the job raises `Couldn't determine a delay based on :exponentially_longer`. It never retries and never runs the `fail_enrichment` block, so the citation stays `pending`. After that, `request_enrichment` always answers "already being fetched", so the note can never be re-enriched.
    - **Repair:** `:polynomially_longer` (same formula). Not portable (7.1+), so ship with the bump.
    - **Check:** the citation test expects 6 provider requests across 3 attempts and a visible failure. Without the repair it saw 2.
    - **Queued work:** retries enqueued by 7.0 workers carry no wait strategy, and an 8.1 retry payload ran fine on 7.0 (`mixed2.txt`).

14. **`return` inside `transaction` in `Import#apply` (observed, data integrity).** On 8.x, `return false` inside the block **commits**. When a later row is invalid, the import, earlier notes and citations are kept, even though the reader sees "applying them saves nothing". Measured record counts went from `[0,3,0,1]` to `[1,4,1,2]`.
    - **Repair:** `applied = transaction { save!; raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }; true }; applied == true`. Portable. The valid path still saves all rows, and the invalid path re-renders the preview with the row errors.
    - **Check:** both import tests (valid import plus receipt; invalid rows save nothing).

15. **`HashWithIndifferentAccess#stringify_keys` now converts integer keys (observed, silent).** The import preview looks annotations up by integer line number after `.stringify_keys`. Every annotation lookup misses, and the page shows the wrong `<dd>` (the DOI instead of the annotation).
    - **Repair:** drop `.stringify_keys` in `app/views/imports/preview.html.erb`. Portable.

16. **`citation[:id]` on a model whose primary key is `doi` (observed, silent).** It now returns nil, so every DOI column in the import receipt CSV is blank.
    - **Repair:** `csv << [note.title, note.citation_doi]`. Portable, and it needs no association load.

17. **Digest date when the reader's zone differs from UTC (observed, silent).** Active Job now keeps the zone when serializing a `TimeWithZone`. The digest covers the reader's local day instead of the UTC day the app documents, and its reservation key is UTC. Test result: "October 04" instead of "October 05". Payloads enqueued by 7.0 have no zone and still arrive as UTC.
    - **Repair:** add `requested_at = requested_at.utc` in `DigestMailer#daily_digest`. Portable, and it works for both old and new payloads.

18. **Rollback cannot read BigDecimal job arguments (observed, rollout risk).** 8.1 always serializes `BigDecimal` with `BigDecimalSerializer`. A 7.0 worker then fails with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The Redis reservation still blocks a new digest for that day.
    - **Repair:** in `User#request_digest`, pass `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`. Portable.
    - **Check:** `upgrade_checks_test.rb` asserts the argument is a String. It failed before the repair with `{"_aj_serialized"=>"...BigDecimalSerializer"...}` and passes after. A real 7.0 consumer then sent "0%" mail (see section D).

19. **"24 hours later" display crosses a DST change (observed, display only).** 8.1 always keeps the zone in `to_time`, so `reminder_at.to_time + 86_400` now shows `08:00 -05:00` instead of the documented `09:00 -04:00`. It is the same instant, and postponing (`to_i`) is unchanged.
    - **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`. Portable.
    - **Alternative:** accept the zone-aware display. That would change the documented behavior and the test.

20. **Negative cache expiry on expired exports (observed, silent).** `app/views/exports/_export.html.erb` computes `expires_in: expires_at - Time.current`, which is negative for expired exports. On 7.0 that entry expired immediately. On 8.1 (old default) the app reports `ArgumentError: Cache expiration time is invalid, cannot be negative` as a handled error and stores the fragment with **no expiry**. With the production file store, those entries are never evicted.
    - **Repair:** `expires_in: [export.expires_at - Time.current, 1.second].max`. Portable. It keeps today's documented behavior where an already-cached fragment is served until its key changes.
    - **Rejected alternative:** `cache_if remaining.positive?` breaks the existing "cached availability indicator" test.
    - **Check:** `upgrade_checks_test.rb` "no invalid cache expiration" failed without the repair (2 reports) and passes with it. The control asserts `.export-expired` still renders.

## B. New framework defaults

The app keeps `load_defaults 7.0`, so the old value of every setting below stays in effect. Two exceptions are forced by 8.1 regardless: `to_time` keeps the zone (finding 19), and BigDecimal arguments use the serializer (finding 18). On 8.1 the effective `enqueue_after_transaction_commit` is `false` with both 7.0 and 8.1 defaults (observed).

In `upd` (`load_defaults 8.1`), four more things broke (observed) and needed three repairs:
- **`default_column_serializer = nil` (7.1):** `Notebook` fails with `missing keyword: :coder`. Repair: `serialize :preferences, coder: YAML`. The stored data is YAML; 7.0 and 8.1 read each other's rows.
- **`raise_on_assign_to_attr_readonly` (7.1):** updating a notebook fails with `ActiveRecord::ReadonlyAttributeError: slug`. The form posts a hidden slug. Repair: drop `:slug` from `notebook_params`; create assigns it from the name anyway.
- **`postgresql_adapter_decode_dates` (7.2):** the activity report fails with `TypeError: no implicit conversion of Date into String`. Repair: `day.to_date`. Portable.
- **`raise_on_invalid_cache_expiration_time` (7.1):** the exports page returns 500 for an expired export. The repair is finding 20.

What each release's defaults would change for this app:

| Release | Setting | Effect if adopted |
|---|---|---|
| 7.1 | `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`, `cache_format_version 7.1` | Session cookies stayed valid in both directions between 7.0 and 8.1-defaults servers (observed). A 7.0 server would miss cache entries written in the 7.1 format. Adopt them in a later deploy, after rollback is no longer possible. |
| 7.1 | `belongs_to_required_validates_foreign_key=false` | One fewer query on note/export/import saves. |
| 7.1 | `run_after_transaction_callbacks_in_order_defined`, commit-callback settings, `before_committed_on_all_records` | No effect: there are no commit callbacks. |
| 7.1 | `sanitizer_vendor` HTML5 (Action View and Action Text), `dom_testing_default_html_version :html5` | The rich-text tests pass. |
| 7.1 | `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`, `add_autoload_paths_to_load_path=false`, default headers | Low effect. |
| 7.1 | Encryption digest settings, `generate_secure_token_on`, `marshalling_format_version`, `sqlite3_*`, `query_log_tags_format` | Not used by the app. |
| 7.1 | `allow_deprecated_parameters_hash_equality=false` | No `params == Hash` comparisons found. |
| 7.1 | `use_big_decimal_serializer` | Forced anyway on 8.1. |
| 7.2 | `enqueue_after_transaction_commit` | Not effective on 8.1 (observed `false`). If ever enabled, an enqueue failure inside `Citation#request_enrichment`'s lock would leave the citation `pending`. |
| 7.2 | `web_image_content_types` | No variants in the app. |
| 7.2 | `validate_migration_timestamps` | Existing migration names are valid. |
| 7.2 | `yjit` | 8.1 sets it to `!Rails.env.local?`, so on in production. Watch memory. |
| 8.0 | `strict_freshness` | `ExportDownloadsController#stale?` would honor only `If-None-Match` when both headers are sent. Not tested. |
| 8.0 | `Regexp.timeout = 1` | Unlikely to matter for the DOI regex. |
| 8.1 | `escape_json_responses=false`, `escape_js_separators_in_json=false` | jbuilder output changes slightly. |
| 8.1 | `action_on_path_relative_redirect=:raise` | Redirects use helpers or absolute paths. |
| 8.1 | `raise_on_missing_required_finder_order_columns` | Not tested. |
| 8.1 | `render_tracker=:ruby`, `remove_hidden_field_autocomplete` | Small HTML difference. |

Recommendation: ship 8.1 on `load_defaults 7.0`. Then adopt defaults release by release, using the three repairs above (or `new_framework_defaults_*` files). Turn on the message and cache format settings last.

## C. Dependency notes
- **sidekiq 6.5.12 / redis 4.8.1 still work on 8.1.** A real worker processed export and digest jobs. The built-in `sidekiq` adapter is deprecated in 8.1 and goes away in 8.2 (source). Moving to Sidekiq ≥ 7.3.3 is a separate project, with known effects (source-based):
  - `Sidekiq.redis { sadd }` returns an Integer, so `0` is truthy and the once-per-day digest guard breaks.
  - Strict arguments reject the symbol-keyed options in `ExportJob.perform_async(..., { format: })`.
  - `rescue Redis::BaseError` no longer catches redis-client errors.
- **puma 5.6.9 with rack 2.2 served the app correctly on 8.1** (observed).
- **Pre-existing, not caused by the upgrade:** production `DigestJob` fails on both versions with "Missing host to link to", because production has no `action_mailer.default_url_options`.

## D. Rollout and rollback
- **Ship before the bump (all work on 7.0):** findings 1, 2, 4, 5, 6, 9 through 12, and 14 through 20, plus the `day.to_date` and slug-permit repairs. This makes the bump itself small.
- **Ship only with the bump:** findings 3, 8 and 13, plus the json pin.
- **Rolling forward:** 7.0 payloads for DigestJob, NoteReminderJob and CitationEnrichmentJob all performed on 8.1 (`mixed2.txt`). Stored YAML preferences, JSON tags and the `settings` jsonb read the same in both directions.
- **Rolling back:** with finding 18's repair in place, a digest enqueued by 8.1 performed on a 7.0 worker ("0%" mail). Without it, the job dies with a `DeserializationError`. Cache entries carry over as long as `cache_format_version` stays 7.0. Sessions carried over in both directions in my tests.

## E. Not verified and open questions
- The system and browser suite was not run, and neither was ActionCable.
- No later 8.1.x patch was evaluated (the remote gem lookup failed).
- I didn't test the json pin on 7.0, or `strict_freshness` with real conditional GET requests.
- Product decision: should the next-day reminder preview keep its fixed offset (my repair) or follow the zone?
- `upgrade_checks_test.rb` only runs on 8.x: its error-reporter `unsubscribe` call doesn't exist on 7.0.

---

The upgrade skill only produces a plan, so I haven't changed your repository; it's still on Rails 7.0.8.7. Before anyone acts on this, decide whether the next-day reminder preview should keep its fixed offset or follow the time zone (finding 19). Also run the browser suite (`bin/rails test:system`), because the planner didn't. If you want, I can start implementing the changes that also work on 7.0 as a first commit.