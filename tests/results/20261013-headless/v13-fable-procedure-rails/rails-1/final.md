# rails 7.0.8.7 → 8.1.0 upgrade plan

**Summary:** This can't go in as a plain bump. With only the Gemfile changed, the `upgraded` copy did not boot (check 01). It needs 19 required repairs (R1–R19), including a `json` version constraint in the Gemfile. It needs 4 more repairs (D1–D4) only if the app moves to `load_defaults 8.1`.

The final check of `upgraded` (check 09) passes boot, db:prepare, eager-load, production-boot, routes and assets: **46 runs, 316 assertions, 0 failures, 3 errors**. The 3 errors are the citation-enrichment tests, whose test code calls the removed `Rails.application.secrets`. They need a new test helper (see R13). `base` (check 01): 46 runs, 325 assertions, 0 failures, 0 errors. `defaults` (check 04): 46 runs, 316 assertions, 0 failures, the same 3 errors.

## Setup and evidence
- Lab: `/tmp/upgrade-lab-rails` (services stopped, files kept).
- Copies:
  - `copies/base`: 7.0.8.7, unchanged.
  - `copies/upgraded`: 8.1.0 with R1–R19.
  - `copies/defaults`: `upgraded` with `load_defaults 8.1` and D1–D4.
  - `copies/backport*`: the repairs applied to 7.0.8.7.
- Lock diff: `/tmp/upgrade-lab-rails/lock-diff.md`. Changes: `changes.md`. Notes: `notes.md`.
- Checks: `checks/upgraded/01..09`, `checks/defaults/01..04`, `checks/base/01`.
- Probes: `probe-{1,3,4,5,6}-{base,upgraded}.log`, `probe-1-upgraded-repaired.log`.
- Matrix: `matrix/121048/`.
- Backport: `backport.log`, `backport-each.log`.
- Patches: `/tmp/upgrade-lab-rails/repairs.patch` (R repairs, 15 files) and `defaults-repairs.patch` (D repairs).
- I fixed several errors per check to stay within the 12-check budget. The "Compared with" lines therefore show test groups, not single repairs.

## Required changes

**R1. Action Text allowlist extension crashes boot** (`config/initializers/action_text.rb:3`)
- Observed (checks/upgraded/01/boot.log): ``undefined method `+' for nil (NoMethodError)  ActionText::ContentHelper.allowed_tags += %w[ details summary ]``
- Cause: actiontext 7.1 — `allowed_tags` is now nil by default, and the defaults come from the sanitizer the app has configured (`sanitizer_allowed_tags`).
- Repair:
  ```ruby
  Rails.application.config.after_initialize do
    helper = ActionText::ContentHelper
    defaults = helper.allowed_tags ||
      (helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])
    helper.allowed_tags = defaults + %w[ details summary ]
  end
  ```
- Works on the current version: yes. In the per-file backport (backport-13), the details/summary test passed. The 2 errors there were lab Redis errors (`ERR DB index is out of range`), not from this repair.
- Validation: boot passes, and `NotesControllerTest#test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes. Control: its "drops unsafe markup" assertions still pass.

**R2. `enum` with keyword arguments** (`app/models/note.rb:10`)
- Observed (checks/upgraded/02): `wrong number of arguments (given 0, expected 1..2)` at `activerecord-8.1.0/lib/active_record/enum.rb:217`.
- Cause: activerecord 8.0 removed keyword-argument `enum`.
- Repair: `-  enum status: { draft: 0, ready: 1 }, _prefix: true` / `+  enum :status, { draft: 0, ready: 1 }, prefix: true`
- Works on the current version: yes, as a line. The per-file backport of `note.rb` failed only because of R4's `coder:` in the same file.
- Without it, every model load fails. Validation: eager-load and production-boot turned ok by check 04.

**R3. Route with two paths** (`config/routes.rb:18`)
- Observed (checks/upgraded/02/routes.log): `Wrong number of arguments (expect 1, got 2) (ArgumentError)`
- Cause: actionpack 8.1 removed routes that list multiple paths.
- Repair: replace `get "/notes", "/journal", to: "notes#index"` with two `get` lines. This keeps the route names `notes` and `journal`.
- Works on the current version: yes. backport-14 had only the same lab Redis errors.
- Validation: routes ok from check 03. `test_lists_the_reader's_notes_newest_first_at_both_list_paths` passes. Control: the route names match base. The route count went from 65 to 61 only because of Action Mailbox conductor routes.

**R4. `serialize :tags, JSON`** (`app/models/note.rb:12`)
- Observed (checks/upgraded/03): `wrong number of arguments (given 2, expected 1)` at `serialization.rb:193`.
- Cause: activerecord 7.2 removed passing the coder as a positional argument.
- Repair: `serialize :tags, coder: JSON`
- Works on the current version: **no**. backport-7: `undefined method 'any?' for an instance of String`. Requires the upgrade.
- Validation: 45 tests went from erroring to running. `test_a_blank_title_re-renders_the_form_with_the_submitted_values` asserts tags as an Array.

**R5. `alias_attribute` to a store accessor** (`app/models/note.rb:14`)
- Observed (checks/upgraded/04, 22 tests): `Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'`
- Cause: activerecord 7.2 removed aliasing non-attributes.
- Repair: `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`
- Works on the current version: yes. Ships in `note.rb` with R4.
- Validation: `NotesControllerTest#test_edits_a_note's_rich_body,_tags,_highlight,_and_status`. Check 04→05: 20 newly passing.

**R6. json 3.1.0 breaks Active Support JSON decoding (Gemfile)**
- Observed (checks/upgraded/04, 21× in test.log, at `application_controller.rb:8`): `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291` ← `activesupport-8.1.0/.../json/decoding.rb:25`. Every request reading the encrypted session cookie returned 500.
- Cause: json 3.0 changed `JSON.parse`'s signature, and Active Support 8.1.0 still passes options as a positional hash. The error is in another gem that moved with the bump.
- Repair: add `gem "json", "~> 2.7"` to the Gemfile. The lock resolved to 2.21.2.
- Works on the current version: yes. It is only a constraint.
- Validation: sign-in and all pages that read the session went from 500 to OK (check 05).

**R7. `show_exceptions = false`** (`config/environments/test.rb:31`)
- Observed (checks/upgraded/05, 6 tests): `ActiveRecord::RecordNotFound expected but nothing was raised.` and `Redis::CannotConnectError expected but nothing was raised.`
- Cause: actionpack 7.2 removed `true`/`false` (guide 7.1).
- Repair: `config.action_dispatch.show_exceptions = :none`
- Works on the current version: **no**. backport-12: 8 failures. Requires the upgrade.
- Validation: the access-control tests (for example `NotebooksControllerTest#test_another_reader's_notebook_settings_cannot_be_reached`) and `DigestsControllerTest#test_a_digest_request_is_released_when_its_job_cannot_be_queued` pass.

**R8. `form_with(model: nil)`** (`app/views/notes/index.html.erb:12`)
- Observed (checks/upgraded/05): `Actual: "ArgumentError in Notes#index"`. The notes list returned 500.
- Cause: actionview 8.0 removed `model: nil`.
- Repair: drop `model: nil,`.
- Works on the current version: yes (backport-10).
- Validation: `test_renders_an_unbound_search_form` and `test_filters_by_notebook,_status,_and_title`.

**R9. HWIA `stringify_keys` now stringifies Integer keys** (`app/views/imports/preview.html.erb:22`)
- Observed (checks/upgraded/05): `Expected: "Read <b>twice</b> & reflect" Actual: "10.1000/Essays.1"`. Annotations were missing from the import preview.
- Cause: activesupport 8.0, `HashWithIndifferentAccess#stringify_keys`.
- Repair: `<% annotations = @import.annotations %>`. The lookup at lines 42/44 uses `row.line`, an Integer.
- Works on the current version: yes (backport-9).
- Validation: `ImportsControllerTest#test_previews_a_CSV_without_saving,…`.

**R10. `Enumerable#sum` of strings** (`app/models/export.rb:42`)
- Observed (checks/upgraded/05, 3 tests): `TypeError: String can't be coerced into Integer`. Export generation fails.
- Cause: activesupport 7.1 removed the `Enumerable#sum` override. Base logs the deprecation 3×.
- Repair: `finish(fragments.join)`
- Works on the current version: yes (backport-5; it also removes the deprecation).
- Validation: the 3 `ExportsControllerTest` tests.

**R11. `set(wait_until:)` with an Integer** (`app/models/note.rb:61`)
- Observed (checks/upgraded/05, test.log): ``undefined method `utc' for an instance of Integer`` at `activejob-8.1.0/lib/active_job/core.rb:130`. Scheduling a reminder returns 500.
- Cause: activejob 7.2 removed numeric `scheduled_at`.
- Repair: `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`
- Works on the current version: yes as a line. Ships in `note.rb`.
- Validation: `RemindersControllerTest#test_an_imported_reminder_is_scheduled_at_its_exact_time,_and_postponing_replaces_it`.

**R12. Digest day changes because job times keep their zone** (`app/mailers/digest_mailer.rb:10`)
- Observed (checks/upgraded/05): `-"Your reading digest for October 05, 2026" +"Your reading digest for October 04, 2026"`
- Cause: activejob 7.1+ serializes the `time_zone` of a TimeWithZone. The matrix confirms this: the upgraded reader gets `EDT -04:00 date=2026-10-04`, base gets `UTC date=2026-10-05`.
- Repair: add `requested_at = requested_at.in_time_zone` before `@date = …`. This restores the documented behavior of using the worker's zone.
- Works on the current version: yes (backport-3).
- Validation: `DigestsControllerTest#test_a_reader_can_request_one_digest_per_UTC_day…`.

**R13. `Rails.application.secrets` removed** (`app/models/citation/provider.rb:13`)
- Observed (checks/upgraded/05..09): ``NoMethodError: undefined method `secrets' for #<MarginNotes::Application…>``. Citation lookups fail in production.
- Cause: Rails 7.2 removed `secrets`. This is not matched in changes.md.
- Repair:
  - `config/application.rb`: `config.x.citation_provider = config_for(:secrets)[:citation_provider]`
  - `provider.rb`: `def initialize(settings = Rails.configuration.x.citation_provider.to_h)`
- Works on the current version: yes, if both files ship together. The per-file backport of `provider.rb` alone failed (backport-4); `application.rb` alone works (backport-11).
- Validation: probe-3 printed `["http://127.0.0.1:9393", "00123", "sample: value # keep"]` on both base and upgraded. That is the control showing the environment credentials are read unchanged.
- The 3 `CitationEnrichmentsControllerTest` tests still error because their helper (lines 45, 117–123) reads and assigns `Rails.application.secrets.citation_provider`. Proposed new helper: read and assign `Rails.configuration.x.citation_provider` instead. The assertions stay the same.

**R14. Plural association name in `where`** (`app/controllers/notes_controller.rb:12`)
- Observed (checks/upgraded/06): `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`. Filtering by notebook returns 500.
- Cause: activerecord 7.2 removed referring to a singular association by its plural name.
- Repair: `@notes.where(notebook: @notebook)`
- Works on the current version: yes (backport-1).
- Validation: `test_filters_by_notebook,_status,_and_title` and `test_pages_through_filtered_notes…`.

**R15. `return` inside a transaction now commits** (`app/models/import.rb:53-57`)
- Observed (checks/upgraded/06): ``record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]``. A CSV import with an invalid row saved partial data.
- Cause: activerecord 7.2 removed the rollback on non-local exit.
- Repair: replace `return false unless row.note.save` with `raise ActiveRecord::Rollback unless row.note.save`, end the block with `true`, and write `end || false`.
- Works on the current version: yes (backport-6).
- Validation: `ImportsControllerTest#test_invalid_rows_are_shown_with_their_errors,_and_applying_them_saves_nothing`. Control: the valid import test still saves.

**R16. `record[:id]` with a custom primary key** (`app/models/import.rb:67`)
- Observed (checks/upgraded/06): `+On idleness,` and `+Of experience,`. The import receipt CSV lost its DOIs.
- Cause: activerecord 7.2 removed `read_attribute(:id)` returning a custom primary key.
- Repair: `csv << [ note.title, citation&.id ]`
- Works on the current version: yes (backport-6).
- Validation: the receipt assertion in `test_previews_a_CSV…`.

**R17. `to_time` now preserves the zone** (`app/models/note.rb:44`)
- Observed (checks/upgraded/06): `Expected at least 1 element matching "#next_day_reminder time[datetime=\"2026-11-01T09:00:00-04:00\"]"`. A reminder postponed across a DST change shows a different offset.
- Cause: activesupport 8.1 removed the deprecated `to_time` system-offset behavior.
- Repair: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`
- Works on the current version: yes as a line (in `note.rb`).
- Validation: `RemindersControllerTest#test_a_reader_schedules_a_reminder_in_their_time_zone…`.

**R18. `retry_on wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`)
- Observed (probe-1-upgraded.log): `ERROR RuntimeError: Couldn't determine a delay based on :exponentially_longer`. The first unavailable provider response crashes the job instead of retrying. Base: `enqueued=1 delay_s=[3]`.
- Cause: activejob 7.2 removed the option. Use `:polynomially_longer` (7.1+).
- Repair: `wait: :polynomially_longer`
- Works on the current version: **no**. backport-2: `Couldn't determine a delay based on :polynomially_longer`. Requires the upgrade.
- Validation: probe-1-upgraded-repaired.log `enqueued=1 delay_s=[3]` (same as base). Tests don't reach this because of R13.

**R19. BigDecimal job argument can't be read by 7.0 workers** (`app/models/user.rb:41`)
- Observed (matrix/121048/read-upgraded-by-base.log): `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`
- Cause: activejob 7.2 removed the primitive BigDecimal serializer.
- Repair: `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already does `BigDecimal(params[:completion])`, and `DigestJob`'s comment documents a string.
- Works on the current version: yes (backport-8).
- Validation: check 09 has no regressions. The digest test asserts "50% of your notes were ready".

## Default-related changes (only with `load_defaults 8.1`; in `defaults-repairs.patch`)

- **D1** (`app/models/notebook.rb:7`): `missing keyword: :coder If no default coder is configured…` (checks/defaults/01). Repair: `serialize :preferences, coder: YAML`. probe-4 shows the stored form is YAML `"---\nexport_heading: Heading\n"`, so YAML must stay. Requires the upgrade.
- **D2** (`app/controllers/notebooks_controller.rb:40`): `ActiveRecord::ReadonlyAttributeError: slug` (checks/defaults/02). Repair: remove `:slug` from `permit`. The slug stays read-only on create because `assign_slug` sets it.
- **D3** (`app/models/notebook.rb:40`): `TypeError: no implicit conversion of Date into String` (checks/defaults/02). Repair: `[day.to_date, count]`.
- **D4** (`app/views/exports/_export.html.erb:26`): `Cache expiration time is invalid, cannot be negative: -60.0` (checks/defaults/02).
  - Attempt 1, `cache_if export.expires_at.future?`, broke `test_the_cached_availability_indicator_does_not_authorize_a_download` (check 03).
  - Final repair: `expires_in: [export.expires_at - Time.current, 1.second].max` (check 04 passes).

New defaults, one line each:
- 7.1 `allow_deprecated_parameters_hash_equality=false`: no comparisons found. No change seen.
- 7.1 `encryption.hash_digest_class` / `support_sha1…`: the app doesn't use AR encryption. No effect.
- 7.1 `run_commit_callbacks_on_first_saved_instances…` / `before_committed_on_all_records` / `run_after_transaction_callbacks_in_order_defined`: no after_commit callbacks found. Tests unchanged.
- 7.1 `sqlite3_adapter_strict_strings_by_default`: the app uses PostgreSQL. No effect.
- 7.1 `allow_deprecated_singular_associations_name=false`: already removed. Covered by R14.
- 7.1 `use_big_decimal_serializer`: covered by R19.
- 7.1 `raise_on_invalid_cache_expiration_time=true`: D4.
- 7.1 `query_log_tags_format`: query logs not enabled. No effect.
- 7.1 `message_serializer=:json_allow_marshal` / `use_message_serializer_for_metadata`: the matrix session cookie read `{"user_id"=>42}` in every cell. No break.
- 7.1 `log_file_size`: dev/test only.
- 7.1 `raise_on_assign_to_attr_readonly`: D2.
- 7.1 `belongs_to_required_validates_foreign_key=false`: tests pass.
- 7.1 `precompile_filter_parameters`: tests pass.
- 7.1 `default_column_serializer=nil`: D1.
- 7.1 `marshalling_format_version=7.1`: test cache is null_store. No stored marshalled records. Not exercised.
- 7.1 `commit_transaction_on_non_local_return`: removed. R15.
- 7.1 `generate_secure_token_on`: no `has_secure_token`.
- 7.1 `action_view/action_text sanitizer_vendor` HTML5: the R1 test still passes on `defaults`. Output differences in other markup were not probed.
- 7.1 `debug_exception_log_level`: logging only.
- 7.1 `dom_testing_default_html_version=:html5`: tests pass.
- 7.2 `enqueue_after_transaction_commit`: removed in 8.1. In the digest/reminder tests, jobs enqueued under `with_lock` still behave correctly.
- 7.2 `web_image_content_types` webp: not exercised (no image tests).
- 7.2 `validate_migration_timestamps`: db:prepare ok.
- 7.2 `postgresql_adapter_decode_dates`: D3.
- 7.2 `yjit`: production performance only. Not checked.
- 8.0 `to_time_preserves_timezone=:zone`: R17 (now the only behavior).
- 8.0 `strict_freshness`: `export_downloads_controller.rb:11` uses `stale?(etag:, last_modified:)`. A request carrying both headers now only checks If-None-Match. Not probed.

## Other gems that move
- **json 2.7.2 (default gem) → 3.1.0**: involved in R6. Constrain it to `~> 2.7`. The app uses it for `JSON.parse` in `citation/provider.rb:43` and for `serialize`.
- **bigdecimal → 4.1.3**: used by `user.rb:56` and `digest_mailer.rb:10`. The digest tests pass. R19 concerns job serialization, not this gem.
- **uri 1.1.2, securerandom 0.4.1, drb 2.2.3**: these replace the default gems. `URI.parse` in `provider.rb:56` works (citation tests that don't hit R13 pass). No finding.
- **action_text-trix (new)**: the layout still loads a vendored `trix-1.3.5.js` (`layouts/application.html.erb:13`). Assets ok; browser behavior not verified.
- **rack-session, rackup, useragent, webrick**: new framework dependencies. No finding.
- **method_source**: removed. No app use found.
- **sidekiq 6.5.12** did not move, but Rails 8.1 warns: `The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3` (probe-6-upgraded.log). Enqueueing matched base (control).

## Rollout and rollback
- **Job arguments (R19):** jobs queued by 8.1 with a BigDecimal can't be read by 7.0 workers (`BigDecimalSerializer is not known`). Jobs queued by 7.0 are read fine by 8.1. With R19, `DigestJob` passes a string, so both directions are safe. No other app job passes a BigDecimal.
- **Time zone in job arguments (R12):** an 8.1 writer adds `time_zone`. 7.0 readers ignore it, and with R12 8.1 readers use the worker zone. The digest day is the same in both directions.
- **Session cookie:** read in all 9 matrix cells, including `load_defaults 8.1`. No forced logout.
- **Ship with the Gemfile change**, because these fail on 7.0.8.7: R4, R7, R18, D1. R13's two files must ship together.
- **Can ship ahead on 7.0:** R1, R2, R3, R5, R8–R12, R14–R17, R19.
- **Jobs in flight:** citation enrichments retried after deploy are only affected by R18.

## Not verified
- **Citation enrichment end to end** on `upgraded`: the 3 tests can't run until their helper stops using `Rails.application.secrets` (R13). R18 was covered by a probe instead.
- **Per-file backport of `action_text.rb` and `routes.rb`:** backport-13 and 14 ended with `Redis::CommandError: ERR DB index is out of range`. That is lab infrastructure; the relevant tests passed.
- **Browser behavior:** `bin/rails test:system` was not run. This covers the vendored Trix 1.3.5 alongside the new `action_text-trix` gem and the HTML5 sanitizer output.
- **Guide 7.1 BroadcastLogger** (`production.rb:86`): production boot is ok. Log output was not inspected.
- **`strict_freshness` on export downloads, YJIT in production, and `marshalling_format_version` with a real cache store:** not probed.
- **Sidekiq 6.5 under Rails 8.2:** the built-in adapter will be removed. A sidekiq ≥ 7.3.3 upgrade is a separate follow-up.

---

**Notes:**
- This is a plan only. Your repo is unchanged: no Gemfile edit, no lockfile change, no commit. All the work happened in copies under `/tmp/upgrade-lab-rails`.
- Rails is currently locked at 7.0.8.7, so this jumps four minor versions at once.
- Even with every listed repair applied, 3 citation-enrichment tests still error. They need the test-helper change described in R13 first.
- The browser suite (`bin/rails test:system`) was never run.
- If you want me to go ahead, the main decision is whether to also move to `load_defaults 8.1`, which needs D1–D4 on top of R1–R19. I can also land the repairs that already work on 7.0 as a separate first step.