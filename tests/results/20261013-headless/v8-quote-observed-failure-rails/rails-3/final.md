# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

Upgrading to 8.1.0 with the current `load_defaults 7.0` is feasible, but it needs about 15 code and config changes. Without them, the app fails at boot and when loading `Note`. Even after the app boots, several features misbehave in ways the existing tests would not all catch: imports save rows partially, import receipts lose their DOIs, digests cover the wrong day, the reminder preview shows the wrong time, and exports, the notes list, reminders and citation retries break. Most of the fixes also work on 7.0.8.7, so they can ship first.

I did not touch `/home/user/workspace/repo`. All experiments ran in disposable copies under `/tmp/up`, each with its own Postgres databases, Redis and storage directory.

## How it was tested
- **Changelog index:** `ruby .../gem-changes rails 7.0.8.7 8.1.0`, output in `/tmp/up/changes.txt`. It missed several new defaults: the 8.0 `Regexp.timeout = 1`, all six 8.1 defaults, and four 7.1 ones (`cache_format_version`, `add_autoload_paths_to_load_path`, `default_headers`, `dom_testing` HTML version). I listed those from railties 8.1.0 `configuration.rb`.
- **Copies:**
  - `/tmp/up/base`: unchanged 7.0. Tests pass (46 runs, 0 failures; `base-test.log`).
  - `/tmp/up/r81`: Rails 8.1.0 with defaults still at 7.0. Ran `bundle update rails --conservative`. Lockfile saved as `/tmp/up/r81-Gemfile.lock`. Gems that matter here stayed put: rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, minitest 5.27.0, and json pinned to 2.21.2.
  - `/tmp/up/prep`: 7.0 plus the fixes that also work on 7.0.
  - `/tmp/up/r81d`: 8.1 with `load_defaults` stepped through 7.1, 7.2, 8.0 and 8.1.
- **Isolation:** test databases were `mn_up_{base,r81,prep}_test`. Development and mixed-version runs used `mn_up_mixed_dev`. Redis ran as a separate instance on port 6390 (`REDIS_URL=redis://127.0.0.1:6390/{0,1}`), which I have shut down. Each copy used its own `storage/` and `tmp/`.
- **Final diffs:** `/tmp/up/r81-final.diff` (all upgrade fixes) and `/tmp/up/r81d-defaults.diff` (adds the `preferences` coder).

## Required changes (each confirmed by running the app on 8.1.0)

| # | Code | What happens on 8.1.0 if unchanged | Fix | Works on 7.0? |
|---|---|---|---|---|
| 1 | `Gemfile` | json 3.1.0 gets resolved, and every JSON column read fails: `ArgumentError: wrong number of arguments (given 2, expected 1)` from `ActiveSupport::JSON.decode`. | Add `gem "json", "~> 2.10"`. | Yes |
| 2 | `config/initializers/action_text.rb` | The app does not boot: `undefined method '+' for nil (NoMethodError)` because `allowed_tags` now defaults to nil. | Set the full list inside `after_initialize` + `on_load(:action_view)` (file: `/tmp/up/action_text_portable.rb`). Rendered output was byte-identical on base, prep and 8.1. | Yes (prep tests pass) |
| 3 | `note.rb:10` `enum status: {...}, _prefix:` | `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when the model loads. | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes |
| 4 | `note.rb:12` `serialize :tags, JSON` | `wrong number of arguments (given 2, expected 1)` | `serialize :tags, coder: JSON` | **No.** On 7.0 the `coder:` option is ignored and YAML is used (I checked the coder object), so new tags would be written as YAML. Change this only together with the Rails bump. |
| 5 | `note.rb:14` `alias_attribute :highlight_color, :color` (target is a store accessor) | `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.` | `alias_method` for the reader and the writer | Yes |
| 6 | `citation/provider.rb:13`, `config/secrets.yml`, citation test | `undefined method 'secrets'`. Citation enrichment fails outright. | `config/citation_provider.yml` (flat, keeps the `.to_json` quoting), loaded with `config.x.citation_provider = config_for(:citation_provider)`. Template: `/tmp/up/citation_provider.yml`. Update the test helper the same way. The test that passes credentials through the environment passes on 7.0 and 8.1. | Yes |
| 7 | `routes.rb:18` `get "/notes", "/journal", ...` | `ArgumentError: Wrong number of arguments (expect 1, got 2)` while loading routes | Two `get` lines. Route names stay the same. | Yes |
| 8 | `export.rb:42` `fragments.sum` (already a deprecation warning on 7.0) | Every export fails: `TypeError: String can't be coerced into Integer` | `fragments.join` | Yes |
| 9 | `note.rb:62` `set(wait_until: reminder_epoch)` | `NoMethodError: undefined method 'utc' for an instance of Integer`. Reminders return 500. | `wait_until: Time.at(reminder_epoch)` | Yes |
| 10 | `notes/index.html.erb:12` `form_with(model: nil, ...)` | `Passed nil to the :model argument`. The notes list returns 500. | Drop `model: nil` | Yes |
| 11 | `notes_controller.rb` `where(notebooks: @notebook)` | `PG::UndefinedColumn: column notes.notebooks does not exist` | `where(notebook: @notebook)` | Yes |
| 12 | `citation_enrichment_job.rb:7` `wait: :exponentially_longer` | `RuntimeError: Couldn't determine a delay based on :exponentially_longer` the first time the provider is unavailable | A lambda such as `->(executions) { executions**4 + 2 }`, or `:polynomially_longer` once on 8.1 (it does not exist in 7.0) | Lambda: yes |
| 13 | `import.rb#apply`, `return false` inside `transaction` | Applying a CSV with a bad row now commits the import and the earlier rows. The test sees counts `[1, 4, 1, 2]` where `[0, 3, 0, 1]` was expected. | `raise ActiveRecord::Rollback unless rows.all? { ... }`, then `true`, and `\|\| false` after the block | Yes |
| 14 | `import.rb#receipt` `citation[:id]` | The DOI column of the receipt CSV comes out empty, silently | `citation&.doi` | Yes |
| 15 | `imports/preview.html.erb:22` `annotations.stringify_keys` | Integer line keys become `"2"`, so the annotation preview silently goes missing | Drop `.stringify_keys` | Yes |
| 16 | `digest_mailer.rb` | Job arguments now keep their time zone, so a Tokyo reader's digest covers the wrong day ("October 04" where "October 05" is expected) | `requested_at = params[:requested_at].in_time_zone` | Yes |
| 17 | `note.rb#next_day_reminder_at` `to_time + 86_400` | Even with 7.0 defaults, 8.1 keeps the zone, so the preview shows `08:00-05:00` instead of `09:00-04:00` (prints a deprecation notice). The epoch saved when postponing does not change. | `reminder_at.to_time.localtime(reminder_at.utc_offset) + 86_400` (same output on 7.0 and 8.1, checked with a probe) | Yes |
| 18 | `config/environments/test.rb` `show_exceptions = false` | Tests expecting `RecordNotFound` get a rendered 404 page instead | `:none` | **No.** On 7.0 `:none` is truthy. Change with the bump. |

**Results:**
- **8.1.0 with everything above:** 46 runs, 0 failures, both with eager loading off and with `CI=1` (`r81-test7.log`, `r81-test-ci.log`).
- **7.0 with only the 7.0-compatible subset:** 46 runs, 0 failures (`prep-test.log`).
- **Smoke test:** a `puma` server on 8.1 served sign-in, `/journal`, `/notes`, `/notebooks`, the activity report and the exports page with 200 or the expected redirects.

## Mixed-version rollout and rollback (shared database and Redis, tested)
- **Jobs from 7.0 run on 8.1:** a test job of every kind (Export, CitationEnrichment, Digest, NoteReminder) ran OK (`mixed-70to81.log`).
- **Jobs from 8.1 run on 7.0:** DigestJob fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`mixed-81to70.log`). 8.1 always uses this serializer, whatever the defaults. The reader's Redis reservation for that day stays set, so they cannot ask again until Sidekiq retries the job on an 8.1 worker.
  - Fix: in `User#request_digest`, pass `reading_completion.to_s`. This works on 7.0, and the mailer already calls `BigDecimal(...)`. Ship it before the bump.
  - Upgrade workers and web processes together, or drain the queue before rolling back.
- **Job timing:** with 7.0 defaults, 8.1 still enqueues jobs immediately inside the transaction (probe: queue size 1 inside the transaction). `Citation#request_enrichment` relies on that so a failed enqueue rolls back. Keep it that way.
- **Sidekiq:** 8.1 warns: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2." Moving to Sidekiq 7.3.3 or later is a separate upgrade. Its strict argument checking would reject `ExportJob.perform_async(id, { format: ... })`, because symbol keys are not valid JSON arguments.
- **Stored data:** `tags` (JSON), `preferences` (YAML) and `settings` (jsonb) read the same way in both versions.
  - Rich-text attachment SGIDs (signed references stored inside rich-text bodies) created on 7.0 or on 8.1 with old defaults are readable by both versions.
  - SGIDs created on 8.1 with `load_defaults 8.1` came back as **nil** on 7.0 (`sgid-matrix.log`). Rich text written after adopting the 7.1 message defaults cannot be rolled back cleanly.

## New framework defaults (all currently on the old values; adopt each separately)
With `load_defaults 7.1` or later, the suite fails at once with `missing keyword: :coder` from `notebook.rb:7`. The fix is `serialize :preferences, coder: YAML`, which works on 7.0 because the option is ignored and YAML is used anyway. After that fix:

**7.1**
- **`raise_on_assign_to_attr_readonly`:** notebook settings raise `ActiveRecord::ReadonlyAttributeError: slug`, because the form resubmits `slug`. Stop permitting `:slug` and remove the hidden field.
- **`raise_on_invalid_cache_expiration_time`:** the exports page returns 500, `Cache expiration time is invalid, cannot be negative: -60.0` (`_export.html.erb:26`). Skip caching when the export has expired, for example with `cache_if`.
- **`message_serializer` / `use_message_serializer_for_metadata`:** this is where the rollback break above comes from (from upstream docs; I did not test which of the two settings causes it). Adopt them in a later deploy, as the guide says.
- **`cache_format_version 7.1`:** 7.0 cannot read the fragment cache it writes. Clear `tmp/cache` on rollback.
- **`sanitizer_vendor` HTML5:** rich-text output was identical in the probe.
- **No effect here:** `default_column_serializer` (handled above), `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances` (the app has no `after_commit` callbacks of its own), `belongs_to_required_validates_foreign_key` (foreign keys protect), `query_log_tags_format`, `generate_secure_token_on`, `marshalling_format_version`, Active Record encryption (unused), SQLite strict strings (Postgres), `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`, `add_autoload_paths_to_load_path`, `default_headers`, and the `dom_testing` HTML5 parser (tests pass).
- **Not in 8.1's 7.1 defaults:** `use_big_decimal_serializer` and parameters/hash equality are no longer config settings in 8.1.

**7.2**
- **`postgresql_adapter_decode_dates`:** the activity report fails with `TypeError: no implicit conversion of Date into String` (`notebook.rb:40`). Use `day.to_date` (from the docs; not run on 7.0).
- **`yjit`:** uses more memory in production.
- **`web_image_content_types` adds WebP:** WebP uploads are treated as images; there is no variant processing.
- **`validate_migration_timestamps`:** the existing migrations (2026-10-11) pass.
- **`enqueue_after_transaction_commit`:** listed by the tool, but 8.1 removed the setting, so nothing to adopt.

**8.0**
- **`strict_freshness`:** downloads compare only the ETag when one is sent. The blob checksum and creation time never change, so the result should be the same (from the source; not run).
- **`Regexp.timeout = 1`:** CSV parsing has a timeout (low risk).
- **`to_time_preserves_timezone`:** already in effect on 8.1; handled by fix #17.

**8.1**
- `escape_json_responses = false`, `escape_js_separators_in_json = false`, `action_on_path_relative_redirect = :raise` (all redirects here use helpers or absolute paths), `raise_on_missing_required_finder_order_columns`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete` (affects the slug and CSV hidden fields), and `yjit` off outside production.
- Only the three test errors listed above failed with `load_defaults 8.1` (`r81d-test-8.1.log`). Runtime effects of these six were not checked beyond the test suite.

## Suggested order
1. On 7.0, ship the fixes that also work there: #2, 3, 5–17, the `preferences` coder, and `reading_completion.to_s`.
2. Bump to 8.1.0 with the json pin, #4 and #18, keeping `load_defaults 7.0`. Deploy web and workers together, with queues drained or watched for DigestJob.
3. Adopt defaults afterwards, one group per deploy: fix the `slug` form and the export cache first; put the message and cache serializer settings last, once rollback is no longer needed.
4. Afterwards, consider:
   - deleting `config/secrets.yml`
   - replacing `config.cache_classes` with `enable_reloading`
   - moving to the Sidekiq gem's own adapter
   - switching `Note.connection` to `with_connection`.

## Not verified
- System tests (`test:system`, browser).
- Rollback rendering of rich text whose SGID cannot be resolved.
- Which message setting causes the SGID break.
- `strict_freshness` with real conditional requests.
- The `day.to_date` fix on 7.0.
- Production asset precompile.
- Schema dump differences after running a migration on 8.1.
- Whether a later 8.1.x patch makes the json pin unnecessary.

A note on development: 8.1 reads its dev secret from `tmp/local_secret.txt` instead of `tmp/development_secret.txt`, so existing dev sessions become invalid.

To clean up, drop the `mn_up_*` databases (the `*_test-0`/`-1` parallel copies too) and delete `/tmp/up`.

---

I only made a plan; I haven't upgraded anything, and your repository is unchanged. The upgrade involves a big version jump (7.0.8.7 to 8.1.0), and 18 changes are needed. Some of the failures are silent, such as partial imports, missing DOIs and digests that cover the wrong day.

If you want me to implement it, I recommend the order the plan suggests: first a 7.0-compatible change set with the fixes that also work on 7.0, then the bump itself. I'd also first clear up the gaps under "Not verified," especially the browser suite.