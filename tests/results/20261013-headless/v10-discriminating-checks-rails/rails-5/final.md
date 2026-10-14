The planner's full plan is below, unchanged. As the upgrade skill directs, nothing in the repository has been modified yet. The planner tested everything on disposable copies under `/tmp`.

---

I upgraded a disposable copy to Rails 8.1.0. It does not boot until two things are fixed. Once it boots, 14 more changes are needed. Several of them are silent behaviour or data changes that the current tests would not catch on their own. With all of them applied, the test suite passes (46 runs, 0 failures) both on the current framework defaults (`load_defaults 7.0`) and with `load_defaults 8.1`. Nothing in the working repository was changed.

## How I tested
- **Copies.** `/tmp/base` is an untouched baseline on Rails 7.0.8.7. `/tmp/upg` is upgraded to Rails 8.1.0 with all repairs applied. `/tmp/prep` is the baseline with only the repairs that also work on 7.0. I deleted `mise.toml` from each copy because mise would not run there. Ruby 3.3.6 came from the mise install path.
- **Isolation.** Each copy has its own gem bundle (`<copy>/vendor/bundle`). Each uses its own Postgres databases (`margin_notes_upg_*` and `margin_notes_base_test`) and a private Redis on port 6390. Caches were in-memory or null and storage was the copy's own `tmp/storage`. The environment is in `/tmp/plan/env.sh`. The shared Redis on 6379 and the app's own databases were not touched.
- **Gems resolved by `bundle update rails`.** Rails 8.1.0, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, pagy 8.6.3, puma 5.6.9, minitest 5.27.0, concurrent-ruby 1.3.4, bigdecimal 4.1.3 (new), and json 3.1.0 (which breaks Rails; see finding R1).
- **Logs** are in `/tmp/plan/`:
  - change summary: `summary.txt`
  - bundle runs: `bundle1.log`, `bundle2.log`, lock diff in `lockdiff.txt`
  - test runs, in order of repair: `test_upg1.log` to `test_upg6.log`, final runs `test_upg_final_{7.0,8.1}.log`, baseline `test_base.log`, 7.0-compatible repairs `test_prep70.log`
  - framework-default experiments: `exp_defaults_*.log`
  - cross-version job experiments: `xv_*.rb` and `payload_*.json`
  - production asset build: `precompile.log`
  - diffs of all repairs: `repairs_upg.diff` (8.1) and `repairs_prep70.diff` (7.0-compatible subset)

## Required changes (8.1 breaks without them)
"7.0 OK" means the repair also works on Rails 7.0, so it can ship before the upgrade. That was checked: `/tmp/prep` passes 46/46 on 7.0.

**R1. json 3.x breaks Rails 8.1.0** (found by running). Bundler resolved json 3.1.0. Every serialized-column read then fails inside ActiveSupport's JSON decoding: `ArgumentError: wrong number of arguments (given 2, expected 1)`, at `json-3.1.0/lib/json/common.rb:291:in 'parse'`. Since `current_user` touches a serialized column, every signed-in request fails.
- Fix: add `gem "json", "< 3"` to the Gemfile (it resolved to 2.21.2).
- Check: a note's `tags` column loads with 3.1.0 and fails, and loads with 2.21.2.

**R2. `config/initializers/action_text.rb`: the app does not boot** (run). Error: `undefined method '+' for nil (NoMethodError)`, because `ActionText::ContentHelper.allowed_tags` now starts as `nil`.
- Fix: inside `config.after_initialize { ActiveSupport.on_load(:action_view) { ... } }`, set `allowed_tags` to `ContentHelper.sanitizer.class.allowed_tags.to_a` plus the attachment tag name, `figure`, `figcaption`, `details` and `summary`. 7.0 OK.
- Check (run): a body of `<details><summary>More</summary><p>Hidden</p></details><script>…` renders `<details>` and still strips `<script>`, on 7.0, on 8.1, and under the HTML5 sanitizer default.

**R3. `Note`: `enum status: {...}, _prefix: true`** fails when classes load: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. 7.0 OK.

**R4. `Note`: `serialize :tags, JSON`** fails: `ArgumentError (given 2, expected 1)`.
- Fix: `serialize :tags, coder: JSON`. The stored data is the same.
- This one does **not** work on 7.0, so it must ship in the same change as the Rails bump.

**R5. `Note`: `alias_attribute :highlight_color, :color`** (`color` is a store accessor). Error: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`, raised lazily at the first use of `Note`.
- Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. 7.0 OK.
- The note form (create and update) and the highlight class on the list and detail pages are covered by the existing tests.

**R6. `config/routes.rb`: `get "/notes", "/journal", to: ...`** raises `ArgumentError: Wrong number of arguments (expect 1, got 2)` when routes load.
- Fix: two separate `get` lines. `bin/rails routes` still shows `notes` and `journal` with the same names as before. 7.0 OK.

**R7. `Rails.application.secrets` is gone** (used in `Citation::Provider`). Error: `NoMethodError: undefined method 'secrets'`, so every citation lookup fails.
- Fix: move the settings to `config/citation_provider.yml`, load them with `config.citation_provider = config_for(:citation_provider)`, and have `Provider` read `Rails.configuration.citation_provider.to_h`.
- Update the test helper `with_provider` in `test/controllers/citation_enrichments_controller_test.rb`, then delete `config/secrets.yml`. 7.0 OK.
- Production checked (run): with the environment variables unset, it still yields `url: nil`, which gives the same "No citation provider is configured" outcome.
- Before deploying, confirm production sets the same `CITATION_PROVIDER_*` variables.

**R8. `CitationEnrichmentJob`: `wait: :exponentially_longer`.** On the first retry: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. The job then crashes into Sidekiq's own retries instead of recording `enrichment_failed`.
- Fix: `:polynomially_longer`, which uses the same formula.
- Not valid on 7.0, so ship it with the bump. Retries already queued carry no wait setting, so they are safe across versions.

**R9. `Import#apply`: `return false` inside `transaction` now commits.** This is a silent data-integrity change. Run result: the existing test failed with ``record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]``. An invalid CSV row leaves a saved Import plus partial notes and citations.
- Fix: `transaction { save!; raise ActiveRecord::Rollback unless rows.all? { |r| r.note.save }; true } || false`. 7.0 OK.
- Check: an invalid second row leaves all counts unchanged. Control: a fully valid CSV imports 2 notes, 1 citation and 1 import.

**R10. `Import#receipt`: `citation[:id]` on `citations`, whose primary key is `doi`.** `[:id]` no longer maps to the primary key, so the receipt CSV's DOI column comes out empty: `On idleness,` instead of `On idleness,10.1000/Essays.1`. Nothing errors.
- Fix: `citation&.doi`. 7.0 OK.

**R11. `imports/preview.html.erb`: `@import.annotations.stringify_keys`.** `stringify_keys` on this hash now converts integer keys to strings. Run result: 7.0 gives `[2] → "ann"`, 8.1 gives `["2"] → nil`. Annotations silently disappear from the import preview.
- Fix: drop `.stringify_keys`. 7.0 OK.

**R12. `NotesController#index`: `where(notebooks: @notebook)`.** The old singular-name fallback is gone. Error: `PG::UndefinedColumn: column notes.notebooks does not exist`, so the notebook filter on the notes list fails.
- Fix: `where(notebook: @notebook)`. The SQL generated on 7.0 is identical. 7.0 OK.

**R13. `notes/index.html.erb`: `form_with(model: nil, ...)`** raises `Passed nil to the :model argument`, so the main notes list returns 500.
- Fix: remove `model: nil`. 7.0 OK.

**R14. `Note#schedule_reminder`: `set(wait_until: <Integer>)`** raises `NoMethodError: undefined method 'utc' for an instance of Integer`. No reminder can be scheduled or postponed.
- Fix: `wait_until: Time.at(reminder_epoch)`. 7.0 OK.

**R15. `Export#generate`: `fragments.sum` over strings** raises `TypeError: String can't be coerced into Integer`. Every export fails.
- Fix: `fragments.join`. 7.0 OK.

**R16. `DigestMailer` now receives the time in the reader's zone.** Active Job now stores the time zone with the time. Run result: the subject became "October 04, 2026" where "October 05" was expected. The digest silently covers the reader's local day instead of the documented UTC day.
- Fix: `requested_at = requested_at.utc` in the mailer. 7.0 OK.
- Jobs queued by 7.0 carry no zone, so 8.1 reads them as UTC, which is fine.

**R17. `Note#next_day_reminder_at`.** `to_time_preserves_timezone` no longer has any effect in 8.1 and `to_time` always keeps the zone. Run result: 7.0 shows `2026-11-01T09:00:00-04:00`, 8.1 shows `08:00-05:00`. The stored epoch is the same; only the "24 hours later" preview text changes.
- Fix: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. 7.0 OK.
- Note that keeping the old offset is a product decision the code comment already documents.

**R18. Test environment: `show_exceptions = false` now means "render all errors".** Five `assert_raises RecordNotFound` tests break as a result.
- Fix: `:none` in `config/environments/test.rb`. 8.x only.

## Rollout risks for queued jobs and stored data
**Q1. BigDecimal job argument** (run). On 8.1 the BigDecimal serializer is always on. A digest job queued by 8.1 and run by a 7.0 worker fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. That applies during a mixed rollout and after a rollback.
- Preparatory fix: `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. Run check: an 8.1-enqueued job then delivers on 7.0.
- Jobs crossing in the other direction, from 7.0 to 8.1, already work (run).

**Q2. Scheduled reminder jobs** (run). The 8.1 payload adds a `scheduled_at` key. Reminders cross in both directions (7.0 → 8.1 and 8.1 → 7.0) and deliver once.
- `ExportJob` is a native Sidekiq job and is unaffected.

**Q3. Rollout order.** Ship R2, R3, R5–R7, R9–R17 and Q1 on 7.0 first. Then ship the bump together with R1, R4, R8 and R18. Deploy workers and web together. Rollback is safe once Q1 is in place.

## Deprecations to plan for (no action needed for 8.1)
- **Sidekiq adapter.** Rails 8.1 prints: `The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2`. Production does not show this (`report_deprecations = false`).
  - Moving to Sidekiq 7.3.3 or later means moving to redis-client. That changes `User#request_digest`, which calls `Sidekiq.redis { sadd/srem }` and already gets a "Use Redis#sadd?" warning.
  - It also changes `Notebook#request_export`, which rescues `Redis::BaseError`. I'd make that a separate task before 8.2.
- **Puma 5** worked on Rails 8.1 here. Upgrading it is optional.

## Framework defaults (all optional; the app keeps the old values as `load_defaults 7.0`)
Tests pass with `load_defaults 8.1` once the repairs below are in. I'd adopt them one release at a time, after the rollback window.

**7.1**
- `raise_on_assign_to_attr_readonly`. Run result: `NotebooksController#update` raises `ActiveRecord::ReadonlyAttributeError: slug` on every settings save. The form always posts the hidden slug field, even when its value is unchanged.
  - Repair: remove `:slug` from `notebook_params`. 7.0 OK. The hidden field and its test can stay.
- `default_column_serializer = nil`. Fails when classes load: `missing keyword: :coder`, from `Notebook serialize :preferences`.
  - Repair: `coder: YAML`. The stored YAML is unchanged (run).
- `raise_on_invalid_cache_expiration_time`. Run result: `ArgumentError: Cache expiration time is invalid, cannot be negative`, from the cache block in `exports/_export.html.erb`, whenever an export has expired. The exports page returns 500.
  - Even on the old value, 8.1 now reports an error and stores that fragment with no expiry (run: read returned `"v"`).
  - Repair: `expires_in: [export.expires_at - Time.current, 1.second].max`. This kept the cached-indicator test passing on 7.0 and 8.1. A `cache_if downloadable?` variant broke that test.
- `use_big_decimal_serializer`: always on in 8.1 (see Q1).
- `message_serializer` / `use_message_serializer_for_metadata` / `marshalling_format_version`: 7.0 cannot read data written in the new formats. Adopt them only after rollback is ruled out.
- HTML5 sanitizer (`action_view` and `action_text` sanitizer vendor): run, output identical.
- `dom_testing_default_html_version = :html5`: the suite passed with 8.1 defaults.
- `commit_transaction_on_non_local_return`: now fixed behaviour (see R9).
- Not applicable to this app:
  - `belongs_to_required_validates_foreign_key`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`: the models use no `after_commit` callbacks.
  - `generate_secure_token_on`: no `has_secure_token`.
  - Encryption settings: no encrypted attributes.
  - `sqlite3_*`: the app uses PostgreSQL.
  - Parameters-hash equality: no comparisons found.
  - `query_log_tags_format`: query log tags are off.
  - `log_file_size` and `debug_exception_log_level`: logging only.
  - `precompile_filter_parameters`: harmless.

**7.2**
- `postgresql_adapter_decode_dates`. Run result: `no implicit conversion of Date into String (TypeError)` in `Notebook#daily_note_counts`. The activity report returns 500.
  - Repair: `[day.to_date, count]`. 7.0 OK.
- `enqueue_after_transaction_commit`: only matters if 7.2 is a stopping point. It would defer jobs queued in `Citation#request_enrichment` and `Note#schedule_reminder` until after commit, which breaks their "failed enqueue rolls back" guarantee. On 8.1 it defaults to false per job class, so keep it off.
- `validate_migration_timestamps`, `web_image_content_types`, and `yjit`: no impact found (yjit only affects memory use).

**8.0**
- `strict_freshness`: `ExportDownloadsController` uses `stale?(etag:, last_modified:)`. Adopting it means a matching ETag alone returns 304. That seems fine; not run.

**8.1**
- `action_on_path_relative_redirect = :raise`: the app only redirects to absolute paths.
- `raise_on_missing_required_finder_order_columns`: `Citation`'s string `doi` primary key still gives an ordering column.
- `escape_json_responses`, `escape_js_separators_in_json`, `render_tracker`, `remove_hidden_field_autocomplete`, `yjit`: low impact (from reading the source, not run).

## Validation to add (each fails on 8.1 without its repair and passes with it)
- **R10:** request the receipt CSV and assert `10.1000/Essays.1` appears.
  - The existing import test already covers R9 and R11.
- **R12:** assert that `GET /notes?notebook_id=` returns only that notebook's notes.
  - Control: an unfiltered list still shows all notes.
- **R16:** a reader in New York at 23:30 local time gets a digest whose subject is the UTC date.
- **R17:** the DST-boundary preview shows `-04:00`.
  - Control: the postponed epoch is exactly +86,400 seconds.
- **Q1:** a payload enqueued by 8.1 and performed by 7.0 delivers. Use `/tmp/plan/xv_enqueue.rb` and `/tmp/plan/xv_perform.rb`.
- **Each optional default above:** add the repro as a test before flipping the flag:
  - notebook update with `slug` posted
  - expired-export page under a MemoryStore
  - activity report under the 7.2 defaults

## Not verified
- System tests (`bin/rails test:system`) were not run, and a real Sidekiq process was not run. Jobs were run by `ActiveJob::Base.execute` on payloads read from Redis.
- I did not walk through the changelogs of every intermediate patch release beyond the change summary.
- `credentials.yml.enc` could not be decrypted, so production boot was only checked with `SECRET_KEY_BASE_DUMMY`.
- The Ruby 3.4 warnings about csv, bigdecimal and mutex_m apply only if Ruby is also upgraded.
- For R17, whether to keep the old offset in the preview is a product decision.

---

**Next step:** I'd do this as two changes, following Q3:
1. A preparatory change on Rails 7.0 with every repair marked "7.0 OK", plus the Q1 fix.
2. The Rails 8.1.0 bump, together with R1, R4, R8 and R18.

Before release, the system tests should be run, and someone needs to confirm production sets the `CITATION_PROVIDER_*` variables. Do you want me to start on the first change?