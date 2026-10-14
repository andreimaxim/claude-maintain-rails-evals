# rails 7.0.8.7 → 8.1.0 upgrade plan

Summary: the upgrade cannot go in as a plain bump. Plain 8.1.0 does not boot (`config/initializers/action_text.rb:3`). It needs **19 required repairs** (R1–R19), including a `json` version limit in the Gemfile and a test-helper change. Adopting `load_defaults 8.1` needs **4 more repairs** (D1–D4).

Results:
- **`base`** (7.0.8.7): every check step ok; 46 runs, 325 assertions, 0 failures, 0 errors.
- **`upgraded`**:
  - Check 12, the last of the 12 allowed, ended at 46 runs, 257 assertions, 4 failures, 5 errors. Boot, db:prepare, eager-load, production boot, routes and assets are all ok.
  - I made R12–R17 after the check limit. The full suite then gave 46 runs, 316 assertions, 0 failures, 3 errors (`tests-upgraded-final.log`). The 3 errors are the test helper's own use of `Rails.application.secrets` (R10).
  - With that test change plus R18, the `testfix` copy gives 46 runs, 340 assertions, 0 failures, 0 errors (`tests-testfix.log`).
- **`defaults`** (8.1 defaults, D1–D4 applied): 46 runs, 316 assertions, 0 failures, 3 errors. The errors are the same R10 test-helper ones.
- **Not re-checked:** R19 was made after both full runs. It is covered only by the matrix.

## Setup and evidence
- Lab: `/tmp/upgrade-lab-rails`. Services are stopped; the files are kept.
- Copies:
  - `copies/base`: current 7.0.8.7.
  - `copies/upgraded`: rails 8.1.0, json limited to 2.21.2, plus R1–R19.
  - `copies/testfix`: `upgraded` with the proposed test change and R18. It does not have R19.
  - `copies/defaults`: `upgraded` (copied before R18 and R19 were made there) with `load_defaults 8.1` and D1–D4. The R19 edit was added to it later.
- Lock diff: `/tmp/upgrade-lab-rails/lock-diff.md` (25 gems).
- Changes: `changes.md`. Notes: `notes.md`.
- Checks: `checks/upgraded/01..12`, `checks/defaults/01..04`, `checks/backport*`.
- Focused runs and probes: `probe-*.log`, `tests-upgraded-final.log`, `tests-testfix.log`.
- Matrix: `matrix/121522/` (before R19) and `matrix/121554/` (with R19).
- Patches:
  - `/tmp/upgrade-lab-rails/repairs.patch`: R-findings, 15 files.
  - `defaults.patch`: R plus D.
  - `testfix.patch`: the proposed test change.
  - The `repairs-N.patch` files are per-file splits.

## Required changes
The "works on current version" answers come from `backport-each.log`.

**R1. Action Text allowlist initializer** (`config/initializers/action_text.rb:3`)
- **Error:** `undefined method '+' for nil (NoMethodError)` (checks/upgraded/01/boot.log). The app does not boot.
- **Cause:** actiontext 7.1 sanitizer change. `allowed_tags` now defaults to nil and is computed lazily from `sanitizer_vendor`.
- **Repair:** build the list in `config.after_initialize { ActiveSupport.on_load(:action_view) { ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"] } }`.
- **Works on current version:** no. The file failed alone, but only with 2 Redis errors from the lab ("ERR DB index is out of range", digests tests), so the result is inconclusive.
- **Validation:** boot ok from check 2. `test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes, which also shows unsafe markup is still dropped.

**R2. Enum keyword form** (`app/models/note.rb:10`)
- **Error:** `wrong number of arguments (given 0, expected 1..2)` (checks/upgraded/02, eager-load and all 46 tests).
- **Cause:** keyword `enum` was deprecated in AR 7.2 and removed in 8.0.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Works on current version:** not separated. `note.rb` failed as a file because of R3.
- **Validation:** eager-load gets past line 10 in check 3. Control: the other enums (`export.rb:10`, `citation.rb:7`) were already positional.

**R3. `serialize` coder argument** (`app/models/note.rb:12`)
- **Error:** `wrong number of arguments (given 2, expected 1)` (checks/upgraded/03).
- **Cause:** passing the coder positionally was removed in AR 7.2.
- **Repair:** `serialize :tags, coder: JSON`.
- **Works on current version:** no. On 7.0 tags become the string `"[\"Victorian\", \"marriage\"]"` (backport-7).
- **Validation:** eager-load ok in check 4. Matrix control: `tags=["reform", "medicine"]` is identical in every cell.

**R4. Route with two paths** (`config/routes.rb:18`)
- **Error:** `Wrong number of arguments (expect 1, got 2)` (checks/upgraded/02-04, routes and production boot).
- **Cause:** actionpack 8.1 removed routes with multiple paths.
- **Repair:** split into `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. The route names `notes` and `journal` are kept.
- **Works on current version:** yes in substance. The single-file run failed only on the lab's 2 Redis errors.
- **Validation:** routes, production boot and assets ok from check 5. `test_lists_the_reader's_notes_newest_first_at_both_list_paths` passes.

**R5. `alias_attribute` on a store accessor** (`app/models/note.rb:14`)
- **Error:** `Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'` (22 tests, checks/upgraded/05).
- **Cause:** aliasing non-attributes was removed in AR 7.2. `color` is a `store_accessor`, not a column.
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Works on current version:** not separated (see R2).
- **Validation:** the 22 errors are gone at check 6. `test_edits_a_note's_rich_body,_tags,_highlight,_and_status` passes.

**R6. json 3.1.0 against Active Support 8.1.0** (Gemfile)
- **Error:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291`, from `activesupport-8.1.0/lib/active_support/json/decoding.rb:25` (13 tests, plus 30 logged 500s from `application_controller.rb:8`, check 6).
- **Effect if not fixed:** every request that decodes JSON returns 500, including the JSON tags column and the current-user lookup.
- **Cause:** json 3.x dropped the positional options hash for `JSON.parse`. json is a new dependency here, replacing Ruby's default gem 2.7.2.
- **Repair:** add `gem "json", "< 3"` to the Gemfile; it resolves to 2.21.2.
- **Validation:** check 7 showed 20 tests newly passing.

**R7. `show_exceptions` in the test environment** (`config/environments/test.rb:31`)
- **Error:** `ActiveRecord::RecordNotFound expected but nothing was raised` (6 tests, check 7).
- **Cause:** true/false values were removed in actionpack 7.2, and the guide's 7.1 section describes the change.
- **Repair:** `config.action_dispatch.show_exceptions = :none`.
- **Works on current version:** no (backport-12). It ships with the bump.
- **Validation:** check 8 showed 7 tests newly passing.

**R8. `form_with` with a nil model** (`app/views/notes/index.html.erb:12`)
- **Error:** `Passed nil to the :model argument, expect an object or false` (5 tests, check 8). The notes list returns 500.
- **Cause:** actionview 7.2 deprecated this and 8.0 removed it.
- **Repair:** drop `model: nil`, leaving `form_with(url: notes_path, method: :get, ...)`.
- **Works on current version:** yes.
- **Validation:** check 9 showed 5 tests newly passing, including `test_renders_an_unbound_search_form`.

**R9. String `sum` in the export** (`app/models/export.rb:42`)
- **Error:** `TypeError: String can't be coerced into Integer` (3 tests, check 9). Markdown exports fail in the Sidekiq job.
- **Cause:** activesupport 7.1 removed its override of `Enumerable#sum`. The base copy already logs this deprecation 3 times.
- **Repair:** `finish(fragments.join)`.
- **Works on current version:** yes.
- **Validation:** check 10 showed 3 tests newly passing.

**R10. Removed `Rails.application.secrets`** (`app/models/citation/provider.rb:13`)
- **Error:** ``undefined method `secrets'`` (3 tests, checks 10–12).
- **Cause:** railties 7.2 removed `Rails.application.secrets`.
- **Effect if not fixed:** citation lookups raise.
- **Repair:**
  - `config/application.rb`: `config.x.citation_provider = config_for(:secrets).fetch(:citation_provider, {})`.
  - `provider.rb`: read `Rails.configuration.x.citation_provider.to_h`.
- **Probe:** `probe-secrets-base.log` and `-upgraded.log` print the same settings: `[[:@url, "http://127.0.0.1:9393"], [:@user, "margin-notes"], [:@password, "local-only"]]`.
- **Test change needed:** `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122` calls the removed API itself. The proposed change replaces `Rails.application.secrets.citation_provider` with `Rails.configuration.x.citation_provider` (`testfix.patch`). It touches only the test's setup, not what it asserts. With it the file passes and the full suite is 46 runs, 0 failures, 0 errors.
- **Works on current version:** `application.rb` alone works. `provider.rb` alone fails because it needs `application.rb`. The two files together with the test change were not checked on 7.0.

**R11. Numeric `wait_until`** (`app/models/note.rb:62`)
- **Error:** ``undefined method `utc' for an instance of Integer`` (2 tests, check 11). Scheduling a reminder returns 500.
- **Cause:** activejob 7.2 removed numeric `scheduled_at`.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`.
- **Validation:** check 12 showed 1 test newly passing; `reminders_controller_test` gives 3/3.

**R12. Plural name for a singular association** (`app/controllers/notes_controller.rb:12`)
- **Error:** `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist` (2 tests, check 12). Filtering notes by notebook returns 500.
- **Cause:** AR 7.2 removed using a plural name for a singular association.
- **Repair:** `where(notebook: @notebook)`.
- **Works on current version:** yes.
- **Validation:** `probe-notes-filter-upgraded.log` gives 13 runs, 0 failures.

**R13. `stringify_keys` in the import preview** (`app/views/imports/preview.html.erb:22`)
- **Observed:** `Expected: "Read <b>twice</b> & reflect" Actual: "10.1000/Essays.1"`. The import preview silently drops annotations.
- **Cause:** activesupport 8.0.0.rc1 changed `HashWithIndifferentAccess#stringify_keys` to stringify all keys, including integers.
- **Repair:** `<% annotations = @import.annotations %>` (drop `.stringify_keys`).
- **Works on current version:** yes.
- **Validation:** the imports tests pass (`probe-imports-upgraded-2.log`, 4 runs, 0 failures).

**R14. Import receipt DOI column** (`app/models/import.rb:66`)
- **Observed:** receipt rows read `On idleness,` where `On idleness,10.1000/Essays.1` is expected (`probe-imports-upgraded.log`). Receipt CSVs lose their DOI column.
- **Cause:** AR 7.2 removed `read_attribute(:id)` returning a custom primary key. Citation's primary key is `doi`.
- **Repair:** `csv << [ note.title, citation&.doi ]`.
- **Works on current version:** yes.
- **Validation:** same test file as R13.

**R15. Early `return` inside a transaction** (`app/models/import.rb:54`)
- **Observed:** `` `record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2] ``. When one row is invalid, the import and the earlier rows are saved anyway.
- **Cause:** AR 7.2 removed the rollback on `return` inside a transaction.
- **Repair:** `saved = rows.all? { |row| row.note.save }; raise ActiveRecord::Rollback unless saved`, then return `saved`.
- **Works on current version:** yes.
- **Validation:** `test_invalid_rows_..._saves_nothing` passes.

**R16. Next-day reminder time across daylight saving** (`app/models/note.rb:44`)
- **Probe 1:** base gives `2026-11-01T09:00:00-04:00`, upgraded gives `2026-11-01T08:00:00-05:00`. The postpone preview and the postponed reminder move by one hour across the daylight-saving change.
- **Cause:** with 8.x, `to_time` keeps the zone (`to_time_preserves_timezone`, deprecated in 8.1).
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.
- **Validation:** probe 2 prints the same value on base and upgraded. `reminders_controller_test` gives 3/3.
- **Alternative not recommended:** setting `to_time_preserves_timezone = :offset` would also work, but that setting is deprecated in 8.1.

**R17. Digest date** (`app/mailers/digest_mailer.rb:7`)
- **Observed:** subject `October 04, 2026` where `October 05, 2026` is expected. The digest covers the wrong day near midnight.
- **Cause:** since 7.1, Active Job keeps the `TimeWithZone` zone on job arguments.
- **Repair:** `requested_at = requested_at.in_time_zone`.
- **Works on current version:** yes.
- **Validation:** `digests_controller_test` gives 2/2.

**R18. `:exponentially_longer` retry wait** (`app/jobs/citation_enrichment_job.rb:7`)
- **Error:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. This was hidden behind R10 and appeared in the testfix run.
- **Cause:** activejob 7.2 removed `:exponentially_longer`.
- **Repair:** `wait: :polynomially_longer`.
- **Works on current version:** no (backport-2). It ships with the bump.
- **Validation:** `tests-testfix.log` gives 46 runs, 0 failures.

**R19. BigDecimal job argument** (`app/models/user.rb:41`)
- **Matrix 121522:** a payload written by upgraded and read by base gives `ERROR ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimal`.
- **Effect if not fixed:** a digest queued by 8.1 fails on a 7.0 worker during the rollout or after a rollback.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already calls `BigDecimal(params[:completion])`.
- **Works on current version:** yes.
- **Validation:** matrix 121554 has the same job cell in all 9 combinations.

## Default-related changes
These are needed only when `load_defaults 8.1` is adopted (`checks/defaults/01..04`).

**D1. Serialized column without a coder** (`app/models/notebook.rb:7`)
- **Error:** `missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'` (46 tests).
- **Repair:** `serialize :preferences, coder: YAML`.
- **Validation:** matrix prefs cell identical everywhere.

**D2. Negative cache expiry** (`app/views/exports/_export.html.erb:26`)
- **Error:** `Cache expiration time is invalid, cannot be negative: -60.0`.
- **Repair:** `expires_in: [export.expires_at - Time.current, 1.second].max`.
- **Rejected alternative:** `cache_if` would change what the test asserts about the stale cached indicator.
- **Validation:** `test_the_cached_availability_indicator_does_not_authorize_a_download` passes.

**D3. Assigning a read-only slug** (`app/controllers/notebooks_controller.rb:26`)
- **Error:** `ActiveRecord::ReadonlyAttributeError: slug`.
- **Repair:** `@notebook.update(notebook_params.except(:slug))`.
- **Validation:** `test_settings_update_..._keep_the_slug` passes.

**D4. Dates decoded by the PostgreSQL adapter** (`app/models/notebook.rb:40`)
- **Error:** `TypeError: no implicit conversion of Date into String`.
- **Repair:** `Date.iso8601(day.to_s)`.
- **Validation:** `test_a_notebook's_notes_are_counted_by_UTC_creation_date` passes.

New defaults, one line each:
- **`allow_deprecated_parameters_hash_equality`:** removed. No comparison of params with a Hash was observed; the tests pass.
- **`active_record.encryption.*`:** the app uses no `encrypts`. No effect.
- **`run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`:** the app has no `after_commit`. No effect; the defaults tests pass.
- **`sqlite3_adapter_strict_strings_by_default`:** PostgreSQL app. No effect.
- **`allow_deprecated_singular_associations_name`:** removed in 8.0 regardless of defaults. This is R12.
- **`use_big_decimal_serializer`:** removed in 8.0. The BigDecimal serializer is always on, which is R19.
- **`raise_on_invalid_cache_expiration_time`:** today logged; becomes a raise. This is D2.
- **`query_log_tags_format`:** no query log tags are configured. No effect.
- **`message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata`:** the session cookie reads the same in every matrix cell.
- **`log_file_size`:** dev and test only.
- **`raise_on_assign_to_attr_readonly`:** this is D3.
- **`belongs_to_required_validates_foreign_key`:** the defaults tests pass.
- **`precompile_filter_parameters`:** the defaults tests pass.
- **`default_column_serializer = nil`:** this is D1.
- **`marshalling_format_version = 7.1`:** not probed separately.
- **`cache_format_version` (7.1 format):** a fragment written under defaults and read by base gives `ERROR TypeError: incompatible marshal file format`. See Rollout.
- **`commit_transaction_on_non_local_return`:** removed in 8.0. This is R15.
- **`generate_secure_token_on`:** no `has_secure_token`.
- **`action_view` / `action_text` `sanitizer_vendor` (HTML5):** the defaults tests pass. The R1 list is built from whichever sanitizer is active.
- **`debug_exception_log_level`:** log level only.
- **`dom_testing_default_html_version = :html5`:** the defaults tests pass.
- **`enqueue_after_transaction_commit`:** probe 3 shows enqueue inside a transaction is immediate on both versions (`inside_tx=1`). Its configuration was removed in 8.1.
- **`web_image_content_types` (webp):** not checked; it affects only uploaded image variants.
- **`validate_migration_timestamps`:** db:prepare ok.
- **`postgresql_adapter_decode_dates`:** this is D4.
- **`yjit`:** production performance only. Not checked.
- **`to_time_preserves_timezone = :zone`:** this already applies on 8.1 even with the 7.0 defaults. It is R16.
- **`strict_freshness`:** `export_downloads_controller.rb:11` passes both an etag and `last_modified`. Not probed.

## Other gems that move
- **json 3.1.0 (new; replaces default gem 2.7.2):** incompatible with Active Support 8.1.0. This is R6; keep it below 3.
- **bigdecimal 4.1.3 (new; replaces default gem 3.1.5):** used at `user.rb:56` and `digest_mailer.rb:10`. No finding; the matrix shows `0.5` everywhere. `divmod` and `precs` are not used.
- **uri 1.1.2, securerandom 0.4.1, drb 2.2.3 (new; replace default gems):** `URI.parse` (`provider.rb:56`) is covered by the citation tests. No finding.
- **rack-session, rackup, webrick, useragent (new):** no finding. The useragent and webrick changelogs were not read.
- **action_text-trix (new):** Rails 8.1 now supplies Trix through this gem. The layout still loads the app's own `trix-1.3.5.js` (layout line 13); assets are ok. Whether two Trix versions conflict in the browser is not verified.
- **method_source:** removed.

## Rollout and rollback
- **Ship together.** R1, R3, R7 and R18 fail on 7.0 and must go in the same commit as the Gemfile and lock change. R10's `provider.rb` needs its `config/application.rb` change and the test change in the same commit.
- **Backport the rest first.** R8, R9, R12, R13, R14, R15, R17 and R19 work on 7.0, and so do the R10 `config/application.rb` change and R4. They can ship ahead of the bump.
- **Queued jobs (Sidekiq/Redis):**
  - Without R19, a digest job queued by 8.1 fails with `DeserializationError` on any 7.0 worker. This bites in a mixed deploy and on rollback.
  - Deploy R19 before or with the bump. With it, every matrix cell is identical.
  - TimeWithZone payloads from 8.1 carry an extra `time_zone` key. The 7.0 reader still read them as `October 05` in matrix 121522.
- **Fragment cache:** once `load_defaults 8.1` (cache format 7.1) is on, rolling back to 7.0 makes cached fragments raise `incompatible marshal file format`. That would make the exports page return 500 until the cache is cleared. Enable the new defaults in a later deploy than the bump, and clear `tmp/cache` on any rollback.
- **Cookies and serialized columns:** the session cookie, `tags` (JSON) and `preferences` (YAML) read the same in every direction.

## Not verified
- **Check limit:** the 12-check limit was reached. R12–R17 were verified with focused test runs and the full suite, R18 with the testfix suite, and R19 only through the matrix. No final `check upgraded` was run after them.
- **Backports of R1 and R4:** inconclusive. The single-file runs failed only on the lab's Redis `ERR DB index is out of range` errors in the digests tests.
- **`note.rb` backports:** R2, R5, R11 and R16 were not tested separately on 7.0 from R3.
- **Route count:** upgraded reports 61 routes; base reports 65. No test failed and this was not investigated.
- **Sidekiq adapter:** `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later` (probe-3-upgraded.log). Sidekiq is 6.5.12. Not required for 8.1, but it is needed before 8.2.
- **Other deprecations:** not followed up:
  - `Note.connection` (`notebook.rb:40`) is deprecated in favour of `with_connection`/`lease_connection`.
  - `:unprocessable_entity` and `rich_text_area` still work as aliases.
- **Production logger:** `ActiveSupport::Logger.new(STDOUT)` at `production.rb:86` was not exercised with `RAILS_LOG_TO_STDOUT`. Production boot is ok.
- **`strict_freshness` and webp defaults:** not probed.

---

**Notes:**
- This is a plan only. Your repo is unchanged: rails is still locked at 7.0.8.7 in `Gemfile.lock:195`. The trial changes are in `/tmp/upgrade-lab-rails`, and `repairs.patch` plus `testfix.patch` can be applied when you're ready.
- Before relying on the plan, check the 4-route drop (65 → 61). Nothing tested it. Also check that the app's own Trix 1.3.5 doesn't clash with the Trix that Rails 8.1 now bundles. Run the browser suite (`bin/rails test:system`) for this; the plan doesn't mention running it.
- R19 was only checked through the job-compatibility matrix. Run one final full suite on the upgraded copy after all repairs are applied.
- I'd recommend this order: ship the backportable fixes on 7.0 first, then the bump with R1/R3/R7/R18 and the R10 changes, then `load_defaults 8.1` in a separate later deploy.

Do you want me to implement it?