# rails 7.0.8.7 → 8.1.0 upgrade plan

Summary: a plain version bump won't work. With only the Gemfile changed, the app does not boot on 8.1.0. It needs 19 repairs (R1–R19). Most need no new code decision, but R6 adds a `json` version limit and R11 needs one test-helper edit. Turning on the new framework defaults (`load_defaults 8.1`) takes 4 more repairs (D1–D4).

Final results:
- **`upgraded`** (check 10, load_defaults 7.0): boot, schema, eager load, production boot, routes and assets are all ok. Tests: 46 runs, 316 assertions, 0 failures, 3 errors. The 3 errors are tests that call `Rails.application.secrets` themselves (see R11).
- **`defaults`** (check 3, load_defaults 8.1): same result, 46 runs, 316 assertions, 0 failures, 3 errors, all the same R11 test errors.
- **`base`** (7.0.8.7): 46 runs, 325 assertions, 0 failures, 0 errors.

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-rails` (services stopped, files kept).
- **Copies:**
  - `copies/base`: current 7.0.8.7.
  - `copies/upgraded`: rails 8.1.0 plus R1–R19.
  - `copies/defaults`: `upgraded` with `load_defaults 8.1` plus D1–D4.
  - `copies/backport*`: the repairs applied to 7.0.8.7.
- **Lock diff:** `/tmp/upgrade-lab-rails/lock-diff.md` (25 gems change).
- **Checks:** `checks/upgraded/01..10`, `checks/defaults/01..03`.
- **Notes and changes:** `notes.md`, `changes.md`.
- **Probes:** `probe-1-{base,upgraded,upgraded-fixed}.log`, `probe-2-*.log`, `probe-2b-*.log`, `probe-3-*.log`.
- **Matrix:** `writer.rb` and `reader.rb`; final run in `matrix/121227/`. The run in `matrix/121148/` has the full error text for M1 and M2.
- **Backport:** `backport.log`, `backport-each.log`.
- **Patch:** `/tmp/upgrade-lab-rails/repairs.patch` (Gemfile plus 14 files; it holds R1–R19, not D1–D4).

## Required changes

**R1. Action Text allowlist is nil** (config/initializers/action_text.rb:3)
- **Observed:** "undefined method `+' for nil (NoMethodError)" (checks/upgraded/01/boot.log).
- **Cause:** since actiontext 7.1, `allowed_tags` defaults to nil and the list is built lazily by `sanitizer_allowed_tags` (actiontext-8.1.0 content_helper.rb:68).
- **Repair:**
  ```ruby
  Rails.application.config.after_initialize do
    ActionText::ContentHelper.allowed_tags =
      ActionText::ContentHelper.sanitizer.class.allowed_tags +
      [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  end
  ```
- **If not done:** the app does not boot.
- **Works on 7.0:** inconclusive. backport-14 failed only on "Redis::CommandError: ERR DB index is out of range", a lab Redis problem.
- **Validation:** boot fails in check 01 and is ok in check 02. `test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes on both `upgraded` and `defaults` (HTML5 sanitizer), so unsafe markup is still dropped.

**R2. Enum with keyword arguments** (app/models/note.rb:10)
- **Observed:** "wrong number of arguments (given 0, expected 1..2)" at enum.rb:217 (checks/upgraded/02).
- **Cause:** activerecord 8.0 removed keyword-style `enum`.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **If not done:** eager load and production boot fail.
- **Works on 7.0:** not tested on its own. note.rb fails on 7.0 as a file because of R4.
- **Validation:** eager load fails in check 02 and passes in check 04. The status filter and status radio tests pass.

**R3. Route with two paths** (config/routes.rb:18)
- **Observed:** "Wrong number of arguments (expect 1, got 2)" at mapper.rb:1854 (checks/upgraded/02/routes.log).
- **Cause:** actionpack 8.1.0 removed routes to multiple paths.
- **Repair:** two lines, `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`.
- **If not done:** routes fail and the app does not boot.
- **Works on 7.0:** inconclusive (same Redis problem, backport-13).
- **Validation:** routes fail in check 02 and are ok in check 03. The `notes` and `journal` route names are unchanged. 65 → 61 routes is only the Action Mailbox conductor routes Rails dropped. `test_lists_the_reader's_notes_newest_first_at_both_list_paths` passes.

**R4. Serialize coder passed by position** (app/models/note.rb:12)
- **Observed:** "wrong number of arguments (given 2, expected 1)" at serialization.rb:193 (checks/upgraded/03).
- **Cause:** activerecord 7.2 removed passing the coder as a second argument.
- **Repair:** `serialize :tags, coder: JSON`.
- **Requires the upgrade:** on 7.0 tags come back as a String ("undefined method `any?' for an instance of String", backport-7).
- **Validation:** check 03 fails and check 04 boots. Probe-3 control: the stored tags `"[\"a\",\"b\"]"` read back as `["a", "b"]` on both copies.

**R5. alias_attribute on a store accessor** (app/models/note.rb:14)
- **Observed:** "Note model aliases `color`, but `color` is not an attribute. Use `alias_method :highlight_color, :color`" in 22 tests (checks/upgraded/04).
- **Cause:** activerecord 7.2 removed this; see the guide's 7.2 alias_attribute section.
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Works on 7.0:** not tested on its own (note.rb).
- **Validation:** fixed together with R6; check 05 has 20 tests newly passing, including `test_edits_a_note's_rich_body,_tags,_highlight,_and_status`.

**R6. json 3 breaks Active Support's JSON decode** (Gemfile)
- **Observed:** "21× ArgumentError: wrong number of arguments (given 2, expected 1) — app/controllers/application_controller.rb:8, json-3.1.0/lib/json/common.rb:291" (checks/upgraded/04).
- **Cause:** activesupport-8.1.0 json/decoding.rb:25 calls `::JSON.parse(json, options)` with a positional hash. json 3.x only accepts keywords there; changes.md does not mention it. It is hit while decrypting the session cookie.
- **Repair:** `gem "json", "< 3"`, which resolves to json 2.21.2.
- **If not done:** every signed-in request returns 500.
- **Ships with the Gemfile change.**
- **Validation:** check 04 → 05; the sign-in and notes tests pass again.

**R7. Enumerable#sum on strings** (app/models/export.rb:42)
- **Observed:** "TypeError: String can't be coerced into Integer" in 3 tests (checks/upgraded/05).
- **Cause:** activesupport 7.1 removed its `Enumerable#sum` override. `base` already logs this deprecation 3 times.
- **Repair:** `finish(fragments.join)`.
- **If not done:** Markdown exports fail.
- **Works on 7.0:** yes (backport-5).
- **Validation:** 3 ExportsControllerTest tests go from failing to passing (check 05 → 06).

**R8. show_exceptions = false** (config/environments/test.rb:31)
- **Observed:** "ActiveRecord::RecordNotFound expected but nothing was raised." in 6 tests (checks/upgraded/05).
- **Cause:** actionpack 7.2 removed the true/false values; see the guide's 7.1 section.
- **Repair:** `config.action_dispatch.show_exceptions = :none`.
- **Requires the upgrade:** on 7.0 it breaks 8 tests (backport-12).
- **Validation:** the 6 access-control tests go from failing to passing (check 05 → 06).

**R9. Numeric wait_until** (app/models/note.rb:62)
- **Observed:** "NoMethodError: undefined method `utc' for an instance of Integer — app/models/note.rb:62, activejob-8.1.0/lib/active_job/core.rb:130" (checks/upgraded/05).
- **Cause:** activejob 7.2 removed numeric `scheduled_at`.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`.
- **If not done:** scheduling a reminder returns 500.
- **Works on 7.0:** not tested on its own (note.rb).
- **Validation:** both RemindersControllerTest scheduling tests go from failing to passing.

**R10. form_with model: nil** (app/views/notes/index.html.erb:12)
- **Observed:** "Passed nil to the :model argument, expect an object or false" (checks/upgraded/05, test.log).
- **Cause:** actionview 8.0 removed `model: nil`.
- **Repair:** `model: false`.
- **If not done:** the notes list returns 500.
- **Works on 7.0:** yes (backport-10).
- **Validation:** `test_renders_an_unbound_search_form` goes from failing to passing.

**R11. Rails.application.secrets removed** (app/models/citation/provider.rb:13)
- **Observed:** "NoMethodError: undefined method `secrets'" (checks/upgraded/04–10).
- **Cause:** railties 7.2 removed `Rails.application.secrets`.
- **Repair:**
  - in config/application.rb: `config.x.citation_provider = config_for(:secrets)[:citation_provider]`
  - in provider.rb: read `Rails.application.config.x.citation_provider.to_h`
- **If not done:** citation enrichment cannot be configured.
- **Works on 7.0:** yes together with application.rb (backport-11 is ok; provider.rb alone fails, backport-4). Both files must ship together.
- **Validation:** probes 2 and 2b give identical settings on `base` and `upgraded`, including the environment-supplied user and password `00123` / `sample: value # keep`.
- **Test change needed:** citation_enrichments_controller_test.rb lines 45 and 117–122 call `Rails.application.secrets` themselves, so these 3 tests still error. Proposed change: read and swap `Rails.application.config.x.citation_provider` instead. The assertions stay the same.

**R12. Plural association name in where** (app/controllers/notes_controller.rb:12)
- **Observed:** "PG::UndefinedColumn: ERROR: column notes.notebooks does not exist" (checks/upgraded/06).
- **Cause:** activerecord 7.2 removed referring to an association by its plural name.
- **Repair:** `where(notebook: @notebook)`.
- **If not done:** filtering by notebook returns 500.
- **Works on 7.0:** yes (backport-1).
- **Validation:** 2 notebook-filter tests go from failing to passing (check 06 → 07).

**R13. to_time now keeps the zone** (app/models/note.rb:44)
- **Observed:** failure "#next_day_reminder time[datetime=\"2026-11-01T09:00:00-04:00\"]" (checks/upgraded/06).
- **Cause:** activesupport 8.1 removed system-local `to_time`; it now always keeps the receiver's zone.
- **Repair:** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`.
- **If not done:** a reminder postponed across a daylight-saving change goes off at the wrong time.
- **Works on 7.0:** not tested on its own (note.rb).
- **Validation:** `test_a_reader_schedules_a_reminder_in_their_time_zone…` goes from failing to passing. Probe-3 gives `2026-11-01T09:00:00-04:00` on both copies.

**R14. Job time arguments keep their zone** (app/mailers/digest_mailer.rb:7)
- **Observed:** "-\"Your reading digest for October 05, 2026\" +\"…October 04, 2026\"" (checks/upgraded/06).
- **Cause:** since activejob 7.1, the time-with-zone serializer stores `time_zone` and restores it (activejob-8.1.0 time_with_zone_serializer.rb:16).
- **Repair:** add `requested_at = requested_at.in_time_zone("UTC")`.
- **If not done:** the digest covers the wrong day near midnight.
- **Works on 7.0:** yes (backport-3).
- **Validation:** the DigestsControllerTest UTC-day test goes from failing to passing.

**R15. stringify_keys on the annotations hash** (app/views/imports/preview.html.erb:22)
- **Observed:** "Expected: \"Read <b>twice</b> & reflect\" Actual: \"10.1000/Essays.1\"" (checks/upgraded/05).
- **Cause:** in activesupport 8.0, `HashWithIndifferentAccess#stringify_keys` turns integer keys into strings too.
- **Repair:** remove `.stringify_keys`.
- **If not done:** the import preview drops annotations.
- **Works on 7.0:** yes (backport-9).
- **Validation:** the import preview test goes from failing to passing (check 06 → 07).

**R16. return inside a transaction now commits** (app/models/import.rb:53)
- **Observed:** "`record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]" (checks/upgraded/07).
- **Cause:** activerecord 7.2 removed rolling back on `return`.
- **Repair:** `saved = rows.all? { |row| row.note.save }`, then `raise ActiveRecord::Rollback unless saved`, then return `saved`.
- **If not done:** an import with an invalid row saves partial data.
- **Works on 7.0:** yes (backport-6).
- **Validation:** `test_invalid_rows_are_shown_with_their_errors,_and_applying_them_saves_nothing` goes from failing to passing.

**R17. read_attribute(:id) with a custom primary key** (app/models/import.rb:68)
- **Observed:** the receipt rows came out as "On idleness," with an empty DOI (checks/upgraded/07).
- **Cause:** activerecord 7.2 removed `read_attribute(:id)` returning a custom primary key.
- **Repair:** `citation&.doi`.
- **If not done:** the import receipt CSV loses its DOIs.
- **Works on 7.0:** yes (backport-6).
- **Validation:** the receipt test goes from failing to passing (check 07 → 08).

**R18. :exponentially_longer removed** (app/jobs/citation_enrichment_job.rb:7)
- **Observed:** probe-1 on `upgraded`: "ERROR RuntimeError: Couldn't determine a delay based on :exponentially_longer". On `base`: "retried executions=1 scheduled=true".
- **Cause:** activejob 7.2 removed the value.
- **Repair:** `wait: :polynomially_longer`.
- **If not done:** a provider outage crashes the job instead of retrying.
- **Requires the upgrade:** backport-2 fails with "Couldn't determine a delay based on :polynomially_longer".
- **Validation:** probe-1-upgraded-fixed now matches base.

**R19. BigDecimal job argument** (app/models/user.rb:41)
- **Observed:** a 7.0 reader fails on a payload written by 8.1: "ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::" (matrix/121148/read-upgraded-by-base.log).
- **Cause:** activejob 7.2 removed the plain BigDecimal serializer. DigestJob's own comment expects a decimal string.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`.
- **Works on 7.0:** yes (backport-8).
- **Validation:** in matrix/121227, `job_repaired` reads `2026-10-05 digest=0.5` in every cell. The digest test still passes in check 10.

## Default-related changes (only if `load_defaults` is raised)

- **D1. serialize without a coder** (app/models/notebook.rb:7)
  - **Observed:** "missing keyword: :coder If no default coder is configured" (checks/defaults/01).
  - **Cause:** `default_column_serializer = nil`.
  - **Repair:** `serialize :preferences, coder: YAML`. Keep YAML, because the stored rows are YAML.
  - **Requires the upgrade.**
- **D2. Dates now come back as Date** (app/models/notebook.rb:40)
  - **Observed:** "TypeError: no implicit conversion of Date into String" (defaults/02).
  - **Cause:** `postgresql_adapter_decode_dates`.
  - **Repair:** `[day.to_date, count]`.
- **D3. Assigning a read-only attribute raises** (app/controllers/notebooks_controller.rb:26)
  - **Observed:** "ActiveRecord::ReadonlyAttributeError: slug" (defaults/02).
  - **Cause:** `raise_on_assign_to_attr_readonly`.
  - **Repair:** `@notebook.update(notebook_params.except(:slug))`.
- **D4. Negative cache expiry raises** (app/views/exports/_export.html.erb:26)
  - **Observed:** "Cache expiration time is invalid, cannot be negative: -60.0" (defaults/02).
  - **Cause:** `raise_on_invalid_cache_expiration_time`.
  - **Repair:** `expires_in: (export.expires_at - Time.current if export.downloadable?)`.

Each of D2–D4 makes its one failing test pass (defaults/03).

How each new default affects this app:
- **message_serializer `:json_allow_marshal` / use_message_serializer_for_metadata:** cookies stay readable in both directions (matrix, cookie cell).
- **Cache format 7.1 / marshalling_format_version:** a 7.0 reader fails on new entries. See M2.
- **default_column_serializer nil:** D1.
- **postgresql decode dates:** D2.
- **raise_on_assign_to_attr_readonly:** D3; probe-3 showed assignment is allowed today.
- **raise_on_invalid_cache_expiration_time:** D4.
- **Sanitizer vendor HTML5 (Action Text and Action View) / dom_testing html5:** the rich-text tests pass under `defaults`.
- **to_time_preserves_timezone `:zone`:** covered by R13.
- **enqueue_after_transaction_commit:** reminder and digest tests pass. The rollback-on-enqueue-failure path inside `with_lock` in note.rb is untested (see Not verified).
- **active_job.use_big_decimal_serializer:** made moot by R19.
- **belongs_to_required_validates_foreign_key, run_after_transaction_callbacks_in_order_defined, before_committed_on_all_records, run_commit_callbacks_on_first_saved_instances, generate_secure_token_on, query_log_tags_format, precompile_filter_parameters, debug_exception_log_level, log_file_size, web_image_content_types, validate_migration_timestamps, yjit:** no test showed a change.
- **allow_deprecated_parameters_hash_equality, allow_deprecated_singular_associations_name, commit_transaction_on_non_local_return:** removed outright, which is R12 and R16.
- **Active Record encryption digest / sqlite strict strings:** not used here.
- **strict_freshness:** export_downloads_controller.rb:11 uses `stale?` with both ETag and Last-Modified. Not tested.

## Other gems that move
- **json 3.1.0 (new; replaces Ruby's default gem):** caused R6 and is limited to < 3. Its own changes (JSON.parse in citation/provider.rb:43) were not hit.
- **bigdecimal 4.1.3 (replaces default gem):** used in user.rb:56 and digest_mailer.rb:10. Digest test and probe-3 are unchanged.
- **drb, securerandom, uri (replace default gems):** no finding. `URI.parse` in provider.rb:56 is unchanged per probe-2.
- **action_text-trix (new):** Trix now comes from this gem, but layouts/application.html.erb:13 still includes the vendored `trix-1.3.5.js`. Not checked in a browser.
- **rack-session, rackup, useragent, webrick (new); method_source (removed):** no finding.

## Rollout and rollback (matrix/121227)
- **M1, job arguments.** Without R19, DigestJob payloads written by 8.1 cannot be read by 7.0 workers ("DeserializationError … Serializer ActiveJob::Serializers::"). That breaks rolling deploys with old Sidekiq workers and any rollback with jobs still queued. R19 fixes it. With R19, payloads read correctly in every direction.
  - Time arguments written by 8.1 carry `time_zone`; a 7.0 reader ignores it and reads UTC, which is harmless.
- **M2, cache entries (only after enabling defaults).** Fragments written with `load_defaults 8.1` cannot be read by 7.0: "cache=ERROR TypeError: incompatible marshal file format (can't be read)". Production uses the default file store. Raise `load_defaults` (or `cache_format_version`) only in a deploy after 8.1 is stable, or clear the cache on rollback.
- **Controls:** the session cookie (`{"session_id"=>"abc", "user_id"=>42}`), YAML preferences and JSON tags read the same in every cell.
- **Deploy order:**
  1. Ship R7, R10, R11 (both files), R12, R14, R15, R16, R17 and R19 first on 7.0; each passes alone there.
  2. Then ship the Gemfile bump, the json pin, and R1–R6, R8, R9, R13 and R18 in one commit. R4, R8 and R18 are confirmed to need the upgrade. The other note.rb repairs (R2, R5, R9, R13) and R1/R3 were not confirmed on 7.0 on their own, so they ship here.
  3. Defaults (D1–D4) go in a later deploy.

## Not verified
- **Citation enrichment through the tests:** the 3 CitationEnrichments tests can't run until their helper stops calling `Rails.application.secrets` (R11 test change). The app side is covered only by probes 1, 2 and 2b.
- **Backport of R1 and R3:** inconclusive; the per-file runs failed only on the lab Redis "ERR DB index is out of range".
- **note.rb repairs on 7.0:** R2, R5, R9 and R13 share note.rb with R4, which needs the upgrade, so the file-level backport result doesn't cover them.
- **Enqueue failure inside `with_lock`** (note.rb:61) with `enqueue_after_transaction_commit` under the new defaults: not tested.
- **Vendored Trix vs. action_text-trix:** not checked in a browser; the system tests weren't run.
- **Production logger (production.rb:86):** only checked by production boot, which passed.
- **strict_freshness:** the effect on `stale?` in export_downloads_controller.rb:11 was not tested.

---

**Notes:**
- This is a plan only. Your repository hasn't changed. All the trial work happened in copies under `/tmp/upgrade-lab-rails`, and `repairs.patch` there contains R1–R19.
- Two of these changes are decisions the project rules say you need to approve:
  - **R6** adds a new version limit, `json < 3`.
  - **D1–D4** only apply if you raise `load_defaults`, which changes the framework defaults.
- Even with every repair applied, 3 tests still error until the R11 test-helper change is made.

Do you want me to apply the changes in the deploy order above?