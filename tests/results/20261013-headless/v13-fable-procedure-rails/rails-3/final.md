# Upgrading rails from 7.0.8.7 to 8.1.0: plan

`Gemfile.lock` has rails at 7.0.8.7, so this is a major upgrade. Following the upgrade-gem skill, I only planned it. Nothing in the repository was changed. The plan below is the planner's report, unedited. My notes come after it.

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan

**Summary:** No, this can't go in as a plain bump. Even before any tests run, the upgraded copy fails to boot (`config/initializers/action_text.rb:3`). It took **15 required repairs** (R1–R15), one of them a `json` version constraint. Four more (D1–D4) are needed only when the app moves to `load_defaults 8.1`.

| Copy | Rails | Final check (tests) |
|---|---|---|
| `base` | 7.0.8.7 | all steps ok; 46 runs, 325 assertions, 0 failures, 0 errors |
| `upgraded` (check 11) | 8.1.0, `load_defaults 7.0` | all steps ok; 46 runs, 340 assertions, 0 failures, 0 errors |
| `defaults` (check 4) | 8.1.0, `load_defaults 8.1` | all steps ok; 46 runs, 340 assertions, 0 failures, 0 errors |

One of the repairs edits a test file (R12). That test helper calls `Rails.application.secrets`, which Rails 7.2 removed. Its assertions are unchanged.

Six repairs don't work on Rails 7.0 (R2, R4, R5, R6, R12, R14). They have to ship in the same commit as the Gemfile change.

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-rails`. Services are stopped; files are kept. The application at `/home/user/workspace/repo` was not modified.
- **Copies:**
  - `copies/base`: the current version.
  - `copies/upgraded`: Rails 8.1.0 with R1–R15, `json` pinned to 2.21.2.
  - `copies/defaults`: `upgraded` plus `load_defaults 8.1` and D1–D4.
  - `copies/backport*`: the repairs applied to 7.0.8.7, all together and one file at a time.
- **Inputs:** lock diff `lock-diff.md`, `changes.md`, `notes.md`. Start log is `/tmp/upgrade-lab-rails-start.log`.
- **Checks:** `checks/{base,upgraded,defaults,backport*}/NN/summary.md`.
- **Probes and matrix:**
  - `probes/probe1.rb` with output in `probe-1-{base,upgraded}.log`.
  - `writer.rb`, `reader.rb` and `stored_common.rb`. Matrix runs are in `matrix/121043/` (before R15) and `matrix/121130/` (after R15).
- **Backport:** `backport.log` and `backport-each.log`.
- **Patch:** `/tmp/upgrade-lab-rails/repairs.patch` holds R1–R15. The D repairs are only in `copies/defaults` and are not in this patch.

## Required changes

**R1. Action Text allowlist is nil** (`config/initializers/action_text.rb:3`)
- **Observed** (checks/upgraded/01/boot.log): ``action_text.rb:3:in `<main>': undefined method `+' for nil (NoMethodError)``
- **Cause:** In actiontext 8.1, `mattr_accessor(:allowed_tags)` has no default. The fallback is built lazily in `sanitizer_allowed_tags`. Related changelog entry: actiontext 7.1 sanitizer vendor.
- **If nothing is done:** the app won't boot.
- **Repair:**
  ```ruby
  Rails.application.config.after_initialize do
    helper = ActionText::ContentHelper
    helper.allowed_tags = helper.sanitizer.class.allowed_tags.to_a +
      [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  end
  ```
- **Works on 7.0:** probably. The per-file backport (backport-13) passed except 2 digest tests that failed with a lab Redis error ("ERR DB index is out of range"). The combined backport failed `NotesControllerTest#…collapsible_excerpts` because other files were applied at the same time. Not proven.
- **Validation:** boot fails on check 1 and passes on check 2. `NotesControllerTest#test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes. Control: probe 1, line 3 renders `<details><summary>` the same on both copies.

**R2. Keyword enum removed in 8.0** (`app/models/note.rb:10`)
- **Observed** (checks/upgraded/02): ``activerecord-8.1.0/lib/active_record/enum.rb:217:in `enum': wrong number of arguments (given 0, expected 1..2)``
- **If nothing is done:** eager load and production boot fail; every test fails.
- **Repair:** `- enum status: { draft: 0, ready: 1 }, _prefix: true` → `+ enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Works on 7.0:** No. The note.rb backport (backport-7) fails, but its logged errors (`undefined method 'any?' for an instance of String`) point at R4 in the same file. R2 on its own was not isolated.
- **Validation:** check 2 → 3, eager load passes.

**R3. Routes with multiple paths removed in 8.1** (`config/routes.rb:18`)
- **Observed** (checks/upgraded/02/routes.log): `mapper.rb:1854:in 'match': Wrong number of arguments (expect 1, got 2)`
- **If nothing is done:** routes and assets fail, and production cannot load routes.
- **Repair:**
  ```diff
  - get "/notes", "/journal", to: "notes#index"
  + get "/notes", to: "notes#index"
  + get "/journal", to: "notes#index"
  ```
- **Works on 7.0:** likely. The per-file run (backport-14) failed only on the lab Redis error.
- **Validation:** routes fail on check 2 and pass on check 3. `NotesControllerTest#test_lists_the_reader's_notes_newest_first_at_both_list_paths` passes. The route count goes from 65 to 61. The missing routes are framework-only routes (`rails/conductor/action_mailbox/inbound_emails` edit, update, destroy); `/journal` is still there.

**R4. `serialize` positional coder removed in 7.2** (`app/models/note.rb:12`)
- **Observed** (checks/upgraded/03): ``serialization.rb:193:in `serialize': wrong number of arguments (given 2, expected 1)``
- **Repair:** `- serialize :tags, JSON` → `+ serialize :tags, coder: JSON`
- **Works on 7.0: no.** Backport-7 fails with `undefined method 'any?' for an instance of String`, because 7.0 ignores `coder:` and returns the raw JSON string. Ship it with the bump.
- **Validation:** check 3 → 4, eager load passes. Probe 1, line 2 shows identical raw `["a","b"]` and the same value read back on both copies.

**R5. `alias_attribute` to a non-attribute removed in 7.2** (`app/models/note.rb:14`)
- **Observed** (checks/upgraded/04, 22 tests): `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'`
- **If nothing is done:** every Note load fails.
- **Repair:**
  ```diff
  - alias_attribute :highlight_color, :color
  + alias_method :highlight_color, :color
  + alias_method :highlight_color=, :color=
  ```
  The setter alias is needed because the form and strong params assign `highlight_color`.
- **Works on 7.0:** not isolated. It is in note.rb, so it ships with R4.
- **Validation:** check 4 → 5, 20 tests newly passing, including `NoteTest#test_newest_first…`. Probe 1, line 2: `hl="green"` on both copies.

**R6. `json` 3.1.0 is incompatible with ActiveSupport 8.1.0** (`Gemfile`; the error surfaces at `app/controllers/application_controller.rb:8` when the session is read)
- **Observed** (checks/upgraded/04): `21× ArgumentError: wrong number of arguments (given 2, expected 1) — app/controllers/application_controller.rb:8, json-3.1.0/lib/json/common.rb:291`. ActiveSupport calls `::JSON.parse(json, options)`, and json 3 accepts keyword options only.
- **If nothing is done:** every signed-in request returns 500, and the `Note#tags` coder fails too.
- **Repair:** in the Gemfile, `+ gem "json", "~> 2.7"`, then `bundle update json --conservative`. The lock moves to json 2.21.2.
- **Works on 7.0:** requires the upgrade, because it ships in the Gemfile change.
- **Validation:** check 4 → 5. The `SessionsControllerTest` and `NotebooksControllerTest` 500s disappear.

**R7. `action_dispatch.show_exceptions = false` removed in 7.2** (`config/environments/test.rb:31`)
- **Observed** (checks/upgraded/05, 6 tests): `ActiveRecord::RecordNotFound expected but nothing was raised.`
- **Repair:** `- show_exceptions = false` → `+ show_exceptions = :none`
- **Works on 7.0: no.** Backport-12 shows the same 7 failures. Ship with the bump.
- **Validation:** check 5 → 6. `NotebooksControllerTest#test_another_reader's_notebook_settings_cannot_be_reached` and 5 others pass.

**R8. `Enumerable#sum` override removed in 7.1** (`app/models/export.rb:42`)
- **Observed** (checks/upgraded/05): `TypeError: String can't be coerced into Integer — app/models/export.rb:42, app/jobs/export_job.rb:10`
- **If nothing is done:** every Markdown export job fails.
- **Repair:** `- finish(fragments.sum)` → `+ finish(fragments.join)`
- **Works on 7.0:** yes (backport-5 ok). This also removes the 7.0 deprecation warning seen on `base`.
- **Validation:** `ExportsControllerTest#test_a_reader_exports_a_notebook_as_Markdown…` and 2 others pass from check 6.

**R9. Numeric `scheduled_at` / `wait_until` removed in 7.2** (`app/models/note.rb:62`)
- **Observed** (checks/upgraded/05): `2× NoMethodError: undefined method 'utc' for an instance of Integer — app/models/note.rb:62, activejob-8.1.0/lib/active_job/core.rb:130`
- **If nothing is done:** scheduling or postponing a reminder returns 500.
- **Repair:** `wait_until: reminder_epoch` → `wait_until: Time.at(reminder_epoch)`
- **Works on 7.0:** not isolated; it is in note.rb.
- **Validation:** `RemindersControllerTest` 500s are gone from check 6.

**R10. `form_with(model: nil)` removed in 8.0** (`app/views/notes/index.html.erb:12`)
- **Observed** (checks/upgraded/05): `Expected: "Notes" Actual: "ArgumentError in Notes#index"`
- **If nothing is done:** the notes list, which is the landing page after sign-in, returns 500.
- **Repair:** `- form_with(model: nil, url: notes_path,` → `+ form_with(url: notes_path,`
- **Works on 7.0:** yes (backport-10 ok).
- **Validation:** `NotesControllerTest#test_renders_an_unbound_search_form` passes from check 6.

**R11. Active Job keeps the zone of TimeWithZone arguments (7.1)** (`app/mailers/digest_mailer.rb:8`)
- **Observed** (checks/upgraded/06): `-"Your reading digest for October 05, 2026" +"Your reading digest for October 04, 2026"`
- **If nothing is done:** a digest requested late in the evening covers the reader's local day instead of the UTC day, so the subject and the list of notes are wrong.
- **Repair:** add `requested_at = requested_at.utc` before `@date = requested_at.to_date`.
- **Works on 7.0:** yes (backport-3 ok).
- **Validation:** `DigestsControllerTest#test_a_reader_can_request_one_digest_per_UTC_day…` passes from check 7. The matrix shows upgraded readers now get `-04:00` times; the mailer's `.utc` covers that.

**R12. `Rails.application.secrets` removed in 7.2** (`app/models/citation/provider.rb:13`, `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`)
- **Observed** (checks/upgraded/05–08): ``NoMethodError: undefined method `secrets' for #<MarginNotes::Application…>``
- **If nothing is done:** citation enrichment fails for every note.
- **Repair:**
  - In `config/application.rb`: `+ config.x.citation_provider = config_for(:secrets).fetch(:citation_provider, {})`
  - In the provider: `settings = Rails.configuration.x.citation_provider.to_h`
  - In the test helper: replace `Rails.application.secrets.citation_provider` with `Rails.configuration.x.citation_provider`. Only the stub target changes; the assertions don't.
  - Update the comments in `config/secrets.yml` and the provider.
  - The alternative of calling `config_for` inside the provider was tried and left the test helper with no way to swap the URL.
- **Works on 7.0: no.** Backport-4 and backport-16 fail when the files are applied separately, for example ``three job attempts… Expected: 6 Actual: 0``. The application.rb, provider and test changes depend on each other and were not backported as a group. Ship with the bump.
- **Validation:** check 8 → 9, 2 tests newly passing, then the third after R14.

**R13. Plural association name in `where` removed in 7.2** (`app/controllers/notes_controller.rb:12`)
- **Observed** (checks/upgraded/06): `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`
- **If nothing is done:** filtering notes by notebook returns 500.
- **Repair:** `where(notebooks: @notebook)` → `where(notebook: @notebook)`
- **Works on 7.0:** yes (backport-1 ok).
- **Validation:** `NotesControllerTest#test_filters_by_notebook,_status,_and_title` and `#test_pages_through_filtered_notes…` pass from check 7.

**R14. `retry_on wait: :exponentially_longer` removed in 7.2** (`app/jobs/citation_enrichment_job.rb:7`)
- **Observed** (checks/upgraded/09): `RuntimeError: Couldn't determine a delay based on :exponentially_longer`
- **If nothing is done:** a provider outage crashes the retry instead of backing off.
- **Repair:** `:exponentially_longer` → `:polynomially_longer`, which is the replacement the changelog names and keeps the same timing.
- **Works on 7.0: no.** Backport-2 fails with `Couldn't determine a delay based on :polynomially_longer`. Ship with the bump.
- **Validation:** `CitationEnrichmentsControllerTest#test_a_provider_that_stays_unavailable…` passes from check 10.

**R15. Three repairs in the import flow**

These are separate causes; the template's "one finding per cause" would number them R15a, R15b and R15c.

1. **HWIA `stringify_keys` now stringifies integer keys (8.0)** (`app/views/imports/preview.html.erb:22`)
   - **Observed:** `Expected: "Second reading" Actual: "not-a-doi"`
   - **Repair:** drop `.stringify_keys`.
   - **Works on 7.0:** yes (backport-9).
2. **`transaction` no longer rolls back on `return` (7.2)** (`app/models/import.rb:53`)
   - **Observed:** ``record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]``
   - **If nothing is done:** a partly invalid CSV commits half an import.
   - **Repair:** `saved = rows.all? { |row| row.note.save }; raise ActiveRecord::Rollback unless saved`, then return `saved`.
   - **Works on 7.0:** yes (backport-6).
3. **`read_attribute(:id)` no longer returns a custom primary key (7.2)** (`app/models/import.rb:69`)
   - **Observed:** the CSV receipt's `doi` column comes out empty.
   - **Repair:** `citation && citation[:id]` → `citation&.doi`
   - **Works on 7.0:** yes (backport-6).
- **Validation:** both `ImportsControllerTest` tests pass from check 8.

**R16 (stored data). BigDecimal job argument unreadable by 7.0 workers** (`app/models/user.rb:41`)
- **Observed** (`matrix/121043/read-upgraded-by-base.log`): `job=ERROR ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`
- **Cause:** Rails 7.2 removed the old string serializer for BigDecimal arguments.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The job comment already describes the argument as a decimal string.
- **Works on 7.0:** yes (backport-8).
- **Validation:** after the repair, every cell of `matrix/121130/` reads `String:0.5`. Tests still pass at check 11.

## Default-related changes (`load_defaults 8.1`)

**D1. Default column serializer is nil (7.1)** (`app/models/notebook.rb:7`)
- **Observed** (checks/defaults/01): ``missing keyword: :coder If no default coder is configured, a coder must be provided to `serialize`.``
- **Repair:** `serialize :preferences, coder: YAML`. This keeps the stored YAML readable (probe 1: raw `"---\nexport_heading: Heading\n"`).

**D2. `raise_on_assign_to_attr_readonly` (7.1)** (`app/controllers/notebooks_controller.rb:40`)
- **Observed:** `ActiveRecord::ReadonlyAttributeError: slug`
- **Repair:** remove `:slug` from `permit`. The slug is set by `before_validation`.

**D3. `raise_on_invalid_cache_expiration_time` (7.1)** (`app/views/exports/_export.html.erb:26`)
- **Observed:** `Cache expiration time is invalid, cannot be negative: -60.0`
- **First attempt:** `cache_if export.downloadable?`. It broke `ExportsControllerTest#test_the_cached_availability_indicator…`, which expects a stale cached fragment to be served.
- **Repair:** `expires_in: [export.expires_at - Time.current, 1.second].max`

**D4. `postgresql_adapter_decode_dates` (7.2)** (`app/models/notebook.rb:40`)
- **Observed:** `TypeError: no implicit conversion of Date into String`
- **Repair:** `Date.iso8601(day)` → `day.to_date`

Validation for D1–D4: defaults checks 1 → 4 end at 46 runs, 0 failures.

**Every default in `changes.md`, one line each.** "Not exercised" means no test or probe reached it.
- `allow_deprecated_parameters_hash_equality=false`: the setting was removed in 8.0. Not exercised.
- AR encryption `hash_digest_class` and `support_sha1`: the app uses no Active Record encryption. No effect.
- `run_commit_callbacks_on_first_saved_instances`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`: no `after_commit` callbacks were found to rely on order. Tests pass.
- `sqlite3_adapter_strict_strings`: the app uses PostgreSQL. No effect.
- `allow_deprecated_singular_associations_name`: already enforced; see R13.
- `use_big_decimal_serializer`: always on in 8.1; see R16.
- `raise_on_invalid_cache_expiration_time`: see D3.
- `query_log_tags_format`: query log tags are not enabled. No effect.
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: the matrix shows encrypted cookies readable in every direction.
- `log_file_size`: affects dev and test only.
- `raise_on_assign_to_attr_readonly`: see D2.
- `belongs_to_required_validates_foreign_key`: tests pass.
- `precompile_filter_parameters`: tests pass.
- `default_column_serializer=nil`: see D1.
- `marshalling_format_version 7.1`: not exercised. No cache store stores records.
- `commit_transaction_on_non_local_return`: already the behavior in 8.1; see R15.
- `generate_secure_token_on`: no `has_secure_token` in the app.
- Action View and Action Text `sanitizer_vendor` HTML5: the defaults test suite passes, including the collapsible-excerpt test.
- `debug_exception_log_level`: changes logging only.
- `dom_testing_default_html_version :html5`: the defaults test suite passes.
- `enqueue_after_transaction_commit`: removed in 8.1. `ExportJob` is a Sidekiq native job and is unaffected; Active Job tests pass.
- `web_image_content_types` adds webp: no image variants are generated. Not exercised.
- `validate_migration_timestamps`: `db:prepare` is ok.
- `postgresql_adapter_decode_dates`: see D4.
- `yjit`: production performance only. Not exercised.
- `to_time_preserves_timezone :zone`: forced in 8.1 regardless of defaults. `Note#next_day_reminder_at` was rewritten in R9's file to `Time.at(reminder_at.to_i + 86_400, in: reminder_at.formatted_offset)`. `RemindersControllerTest` expects `2026-11-01T09:00:00-04:00` and passes from check 7 on. This is really its own required finding; the plan should list it separately.
- `strict_freshness`: `ExportDownloadsController#stale?` sends both an ETag and Last-Modified. Not exercised.

## Other gems that move
- **json 3.1.0 (new, replaces the default 2.7.2):** caused R6. Pinned to `~> 2.7`, which resolves to 2.21.2. `Citation::Provider` `JSON.parse` behaves the same in probes and tests.
- **bigdecimal 4.1.3 (new, replaces the default gem):** used in `User#reading_completion` and `DigestMailer`. Probe 1, line 5 output is identical (`0.1e1 1.0`).
- **uri 1.1.2, securerandom 0.4.1, drb 2.2.3 (new, replace default gems):** `URI.parse` in the provider is covered by the citation tests. No finding.
- **action_text-trix 2.1.19 (new):** Trix assets now come from this gem. The assets step passes.
- **rack-session, rackup, webrick, useragent (new):** no finding.
- **method_source (removed):** no finding.
- **All 12 Rails components (MAJOR):** covered by the findings above.

## Rollout and rollback
- **Mixed versions, jobs:** before R16, a DigestJob enqueued by an 8.1 web process fails on a 7.0 worker (`matrix/121043`). With R16, every combination works.
  - R16 works on 7.0, so ship it first, in a separate deploy before the bump.
  - Then drain or deploy web and worker processes together.
  - Upgraded workers read jobs enqueued by 7.0 (`read-base-by-upgraded`: ok).
- **Cookies and sessions:** readable in every direction, including with `defaults`.
- **Cache entries (only after `load_defaults 8.1`):** fragments written by `defaults` can't be read by 7.0: `cache=ERROR TypeError: incompatible marshal file format (can't be read) format version 4.8 required; 17.1 given`. Production uses the default file store. Rolling back after enabling the defaults means clearing `tmp/cache`, or setting `cache_format_version` explicitly before adopting the defaults.
- **Stored serialized columns:** unchanged. `notes.tags` stays JSON and `notebooks.preferences` stays YAML (probe 1).
- **Repairs that need the upgrade:** R2, R4 and R5 (note.rb), R6, R7, R12 and R14 must ship in the same commit as the Gemfile and Gemfile.lock change. R1, R3, R8, R10, R11, R13, R15 and R16 can land first on 7.0.

## Not verified
- **Backport for R1, R3 and the secrets.yml comment:** the per-file checks (backport-13/14/15) failed only because of the lab's `Redis::CommandError: ERR DB index is out of range` in 2 digest tests. Whether those changes are safe on 7.0 is not proven.
- **`ActiveSupport::Logger.new(STDOUT)` in production (`config/environments/production.rb:86`, BroadcastLogger guide):** production boot is ok. Log output was not inspected.
- **`strict_freshness` on `stale?` in `ExportDownloadsController`:** no probe sent both conditional headers.
- **`config.active_job.queue_adapter` in all tests (7.2 guide):** test.rb sets `:test` and tests pass. No separate probe.
- **Rack `:unprocessable_entity` deprecation:** no warning showed up in the logs.
- **`has_secure_password` and `attr_readonly` without the new defaults:** controls in probe 1 (lines 1–8) were identical on both copies.

The full patch is at `/tmp/upgrade-lab-rails/repairs.patch`. The D1–D4 edits are only in `/tmp/upgrade-lab-rails/copies/defaults`.

---

## My notes on the plan

- **There are more required repairs than the summary says.** The summary counts 15, but the report also has R16 (job arguments), R15 is really three separate fixes, and the `to_time_preserves_timezone` change to `Note#next_day_reminder_at` is a required fix listed among the defaults. Counted one per cause, that makes about 19.
- **The patch file doesn't match the report on R16.** The report says `repairs.patch` holds R1–R15, but R16 was validated in the upgraded copy (`matrix/121130`, check 11). Check the patch includes R16 before relying on it.
- **Which repairs must ship with the version change is unclear in places.** R7 is marked as not working on 7.0, but the rollout list leaves it out of the "can land first" group without saying why. R9 and the reminder-time fix are in `note.rb` too, so treat that whole file as shipping in the same commit as the Gemfile change.
- **The plan pins `json` to `~> 2.7`.** CLAUDE.md says dependency versions stay in place unless the task authorizes changing them. That rule is about other dependencies, and this pin only exists because the Rails upgrade breaks with json 3.1. Since you asked for the upgrade, I think the pin is covered, but please confirm.
- **`load_defaults 8.1` (D1–D4) is a separate decision.** Once it's enabled, 7.0 can't read the new cache entries, so rolling back means clearing `tmp/cache`.

Suggested order:
1. Deploy R16 by itself on 7.0.
2. Optionally, land the other repairs that work on 7.0.
3. Ship the Gemfile change with the repairs that need 8.1, and deploy web and worker processes together.
4. Later, adopt the new framework defaults.

Do you want me to implement it?