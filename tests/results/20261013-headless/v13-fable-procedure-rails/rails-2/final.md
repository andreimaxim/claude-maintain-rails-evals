# rails 7.0.8.7 → 8.1.0 upgrade plan

**Summary:** This cannot go in as a plain bump. With only the version changed, `upgraded` does not boot. The plan needs 19 required repairs (R1–R19) and 4 more (D1–D4) if the app later adopts the new framework defaults.

- **`upgraded` with all repairs:** boot, schema, eager load, production boot, routes and assets are all ok. Tests: 46 runs, 316 assertions, 0 failures, 3 errors. All 3 errors are tests that call the removed `Rails.application.secrets` (R8); fixing them needs a test change.
- **`base`:** 46 runs, 325 assertions, 0 failures, 0 errors.
- **`defaults` (8.1 defaults loaded):** 46 runs, 316 assertions, 0 failures, the same 3 errors.

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-rails`. Notes are in `notes.md`, the changelog summary in `changes.md`, and the lock diff in `lock-diff.md`.
- **Copies:**
  - `copies/base` is the app on 7.0.8.7.
  - `copies/upgraded` is the app on 8.1.0 plus the R repairs and the `json < 3` pin.
  - `copies/defaults` is `upgraded` with `load_defaults 8.1` plus the D repairs.
- **Check logs:**
  - `checks/upgraded/01..09/summary.md`
  - `checks/defaults/01..04/`
  - `checks/backport*/`
- **Probes and other logs:**
  - `probe-1-*.log` (to_time), `probe-2-*.log` (provider settings), `probe-3*-*.log` (retry wait), `probe-4-*.log` (sidekiq adapter and YAML preferences)
  - `matrix.log` and `matrix/120758/`, `matrix/120955/`
  - `backport.log`, `backport-each.log`
- **Patch:** `/tmp/upgrade-lab-rails/repairs.patch`. It covers the `upgraded` repairs only (R1–R19 and the json pin); the D repairs are only in `copies/defaults`.

## Required changes

**R1. Action Text allowlist no longer has a default value** (`config/initializers/action_text.rb:3`)
- **Error** (checks/upgraded/01): `undefined method '+' for nil (NoMethodError) ActionText::ContentHelper.allowed_tags += %w[ details summary ]`
- **Cause:** actiontext 7.1. The default `allowed_tags` is now `nil` and is resolved lazily from the sanitizer vendor (`content_helper.rb:69`).
- **Consequence if nothing is done:** the app does not boot.
- **Repair:**
  ```
  -ActionText::ContentHelper.allowed_tags += %w[ details summary ]
  +ActionText::ContentHelper.allowed_tags = Rails::HTML::SafeListSanitizer.allowed_tags.to_a +
  +  [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  ```
- **Works on the current version:** yes. The per-file backport failed only on `Redis ERR DB index is out of range`, a lab problem.
- **Validation:** boot passes from check 02. `NotesControllerTest#test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes.

**R2. `enum` with keyword arguments was removed** (`app/models/note.rb:10`)
- **Error** (checks/upgraded/02): `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at `enum.rb:217`
- **Cause:** activerecord 8.0.0.rc1, "Remove deprecated support for defining `enum` with keyword arguments".
- **Consequence:** the `Note` model fails to load, so every page and test fails.
- **Repair:** `-enum status: { draft: 0, ready: 1 }, _prefix: true` / `+enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Works on the current version:** not measured separately; it is part of the `note.rb` file that fails as a whole because of R4. The form is valid on 7.0, since `citation.rb` already uses it.
- **Validation:** eager load passes from check 04.

**R3. A route with several paths was removed** (`config/routes.rb:18`)
- **Error** (checks/upgraded/02): `Wrong number of arguments (expect 1, got 2) (ArgumentError)`
- **Cause:** actionpack 8.1.0, "Remove deprecated support to a route to multiple paths".
- **Consequence:** routes do not load.
- **Repair:** `-get "/notes", "/journal", to: "notes#index"` / `+get "/notes", to: "notes#index"` / `+get "/journal", to: "notes#index"`
- **Works on the current version:** yes (same Redis-only failure as R1).
- **Validation:** the routes step is ok from check 03. `NotesControllerTest#test_lists_the_reader's_notes_newest_first_at_both_list_paths` passes in check 09 (it was failing with a 500 in check 05).
- **Control:** the route count goes from 65 to 61 only because the framework's `rails/conductor/action_mailbox` routes changed; no application route is missing.

**R4. `serialize` no longer takes a coder as its second positional argument** (`app/models/note.rb:12`)
- **Error** (checks/upgraded/03): `serialize': wrong number of arguments (given 2, expected 1)`
- **Cause:** activerecord 7.2.0, "Remove deprecated support to passing coder and class as second argument to `serialize`".
- **Repair:** `-serialize :tags, JSON` / `+serialize :tags, coder: JSON`
- **Works on the current version:** no. On 7.0 the per-file backport stores tags as a string (`undefined method 'any?' for an instance of String`). This repair requires the upgrade and ships in the same commit as the Gemfile change.
- **Validation:** eager load and production boot pass from check 04.

**R5. `alias_attribute` cannot alias a `store_accessor`** (`app/models/note.rb:14`)
- **Error** (check 04, 22 tests): `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.`
- **Cause:** activerecord 7.2.0, "Remove deprecated support to call `alias_attribute` with non-existent attribute names".
- **Consequence:** note pages and forms raise errors.
- **Repair:** `-alias_attribute :highlight_color, :color` / `+alias_method :highlight_color, :color` / `+alias_method :highlight_color=, :color=`
- **Works on the current version:** yes; it is plain Ruby.
- **Validation:** 20 tests pass again in check 05, including `NotesControllerTest#test_edits_a_note's_rich_body,_tags,_highlight,_and_status`.

**R6. json 3.1.0 breaks Active Support 8.1.0's JSON decoding** (`Gemfile`)
- **Error** (check 04): `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291`, called from `activesupport-8.1.0/lib/active_support/json/decoding.rb:25` (`::JSON.parse(json, options)`). The server logged it 21 times (`application_controller.rb:8`).
- **Cause:** json 3.0, where `parse` accepts keyword arguments only. The bump pulls json 3.1.0 in as a new gem replacing Ruby's default json.
- **Consequence:** every signed-in request returns a 500, and JSON-coded columns cannot be read.
- **Repair:** `+gem "json", "< 3"`, then `bundle update json --conservative`, which resolves to json 2.21.2.
- **Works on the current version:** yes.
- **Validation:** the 21 logged errors are gone in check 05, and `NoteTest#test_rejects_rich_text_attachments_larger_than_one_megabyte` passes.

**R7. `show_exceptions = false` is no longer accepted** (`config/environments/test.rb:31`)
- **Error** (check 05, 6 tests): `ActiveRecord::RecordNotFound expected but nothing was raised.` Also `Redis::CannotConnectError expected but nothing was raised.`
- **Cause:** actionpack 7.2.0 removed the `true`/`false` values. The test default is now `:rescuable`, so exceptions are rendered as error pages instead of raised.
- **Repair:** `-config.action_dispatch.show_exceptions = false` / `+config.action_dispatch.show_exceptions = :none`
- **Works on the current version:** no. On 7.0 the per-file backport fails the same 7 tests, so this requires the upgrade.
- **Validation:** the "another reader's … cannot be reached" tests and `DigestsControllerTest#test_a_digest_request_is_released…` pass in check 06.

**R8. `Rails.application.secrets` was removed** (`app/models/citation/provider.rb:13`, `config/secrets.yml`)
- **Error** (checks/upgraded/09): `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application…>`
- **Cause:** railties 7.2.0, "Remove deprecated `Rails.application.secrets`".
- **Consequence:** in production, every citation enrichment request raises at `Citation::Provider.new`.
- **Repair:** add `config.x.citation_provider = config_for(:secrets)[:citation_provider]` to `config/application.rb`, and change the provider's default argument to `Rails.configuration.x.citation_provider.to_h`.
- **Works on the current version:** yes, when `provider.rb` and `application.rb` ship together. The per-file run failed only because the two were split.
- **Validation:** probe-2 gives identical output on both versions with environment values `00123` and `sample: value # keep`: `["http://127.0.0.1:9393", "00123", "sample: value # keep"]`.
- **Test change needed:** `test/controllers/citation_enrichments_controller_test.rb:45,117-122` reads and assigns the removed API. Change those lines to `Rails.configuration.x.citation_provider` (read and assign). These 3 tests stay in error until that change is made; I did not edit the tests.

**R9. Active Support's `Enumerable#sum` override for strings was removed** (`app/models/export.rb:42`)
- **Error** (check 05, 3 tests): `TypeError: String can't be coerced into Integer`. `base` already printed a deprecation warning for this.
- **Cause:** activesupport 7.1.
- **Consequence:** every Markdown export job fails.
- **Repair:** `-finish(fragments.sum)` / `+finish(fragments.join)`
- **Works on the current version:** yes.
- **Validation:** `ExportsControllerTest#test_a_reader_exports_a_notebook_as_Markdown…` passes in check 06.

**R10. `wait_until` no longer accepts an Integer** (`app/models/note.rb:62`)
- **Error** (log of check 05): `NoMethodError: undefined method 'utc' for an instance of Integer — app/models/note.rb:62, activejob-8.1.0/lib/active_job/core.rb:130`
- **Cause:** activejob 7.2.0, "Remove deprecated support to set numeric values to `scheduled_at`".
- **Consequence:** scheduling a reminder returns a 500.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`
- **Works on the current version:** yes; it is valid on 7.0, though not measured separately because the `note.rb` per-file run fails on R4.
- **Validation:** `RemindersControllerTest#test_a_reader_schedules_a_reminder…` no longer returns a 500 (check 06). It passes fully once R14 is applied (check 07).

**R11. `form_with model: nil` was removed** (`app/views/notes/index.html.erb:12`)
- **Error** (test.log, check 05): `ArgumentError (Passed nil to the :model argument, expect an object or false)`
- **Cause:** actionview 8.0.0.rc1.
- **Consequence:** the notes list (the root page) returns a 500.
- **Repair:** `-form_with(model: nil, url: notes_path, …` / `+form_with(url: notes_path, …`
- **Works on the current version:** yes.
- **Validation:** `NotesControllerTest#test_renders_an_unbound_search_form` passes.

**R12. Time arguments to jobs now keep the reader's time zone** (`app/mailers/digest_mailer.rb:7`)
- **Error** (check 05): `-"Your reading digest for October 05, 2026" +"Your reading digest for October 04, 2026"`
- **Cause:** Active Job's TimeWithZone serializer now stores and restores the `time_zone`. Matrix 120758 shows the same payload deserialized as `03:30 UTC` by base and `2026-10-04 23:30 EDT` by upgraded.
- **Consequence:** readers away from UTC get the digest for the wrong day.
- **Repair:** `+requested_at = requested_at.in_time_zone(Time.zone)`
- **Works on the current version:** yes.
- **Validation:** `DigestsControllerTest#test_a_reader_can_request_one_digest…` passes in check 06.

**R13. Referring to a singular association by its plural name was removed** (`app/controllers/notes_controller.rb:12`)
- **Error** (check 06): `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`
- **Cause:** activerecord 7.2.0.
- **Consequence:** filtering notes by notebook fails.
- **Repair:** `where(notebooks: @notebook)` → `where(notebook: @notebook)`
- **Works on the current version:** yes.
- **Validation:** `test_filters_by_notebook…` and `test_pages_through_filtered_notes…` pass.

**R14. `to_time` now always keeps the receiver's time zone** (`app/models/note.rb:44`)
- **Error** (check 06): `Expected … "#next_day_reminder time[datetime=\"2026-11-01T09:00:00-04:00\"]", found 0`
- **Probe** (probe-1): base gives `2026-11-01T09:00:00-04:00`, upgraded gives `2026-11-01T08:00:00-05:00`.
- **Cause:** activesupport 8.1.0, "Remove deprecated support for `to_time` to preserve the system local time".
- **Consequence:** the "a day later" reminder time shown to the reader is wrong across a daylight-saving change.
- **Repair:** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`
- **Works on the current version:** yes.
- **Validation:** `RemindersControllerTest#test_a_reader_schedules_a_reminder…` passes in check 07.

**R15. `HashWithIndifferentAccess#stringify_keys` now turns Integer keys into strings** (`app/views/imports/preview.html.erb:22`)
- **Error** (check 06): `Expected: "Read <b>twice</b> & reflect" Actual: "10.1000/Essays.1"`
- **Cause:** activesupport 8.0.0.rc1. The view then looks up `annotations[row.line]` with an Integer and finds nothing.
- **Consequence:** the import preview drops every annotation.
- **Repair:** `-@import.annotations.stringify_keys` / `+@import.annotations`
- **Works on the current version:** yes.
- **Validation:** the import preview assertions pass in check 08.

**R16. Leaving a transaction with `return` now commits it** (`app/models/import.rb:53-57`)
- **Error** (check 07): `` `record_counts` changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2] ``
- **Cause:** activerecord 7.2.0, "Remove deprecated behavior that would rollback a transaction block when exited using `return`".
- **Consequence:** an invalid import partially saves its rows. The same pattern at `export.rb:34,39` is outside a transaction, so it is unaffected.
- **Repair:**
  ```
  -    transaction do
  -      save!
  -      rows.each do |row|
  -        return false unless row.note.save
  -      end
  -    end
  -
  -    true
  +    saved = false
  +    transaction do
  +      save!
  +      saved = rows.all? { |row| row.note.save }
  +      raise ActiveRecord::Rollback unless saved
  +    end
  +    saved
  ```
- **Works on the current version:** yes.
- **Validation:** `ImportsControllerTest#test_invalid_rows_are_shown…saves_nothing` passes in check 08.

**R17. `record[:id]` no longer returns a custom primary key** (`app/models/import.rb:68`)
- **Error** (check 07): the receipt CSV has `On idleness,` where it expected `On idleness,10.1000/Essays.1`.
- **Cause:** activerecord 7.2.0, "Remove deprecated support to `read_attribute(:id)` to return the custom primary key value". The citations primary key is `doi`.
- **Consequence:** import receipts lose their DOIs.
- **Repair:** `citation && citation[:id]` → `citation&.doi`
- **Works on the current version:** yes.
- **Validation:** `ImportsControllerTest#test_previews_a_CSV…offers_a_receipt` passes in check 08.

**R18. `retry_on wait: :exponentially_longer` was removed** (`app/jobs/citation_enrichment_job.rb:7`)
- **Error** (probe-3-upgraded.log): `ERROR RuntimeError: Couldn't determine a delay based on :exponentially_longer`. No test reached this: the retry tests stop earlier on R8.
- **Cause:** activejob 7.2.0.
- **Consequence:** when the provider is unavailable, the enrichment job crashes instead of retrying.
- **Repair:** `wait: :polynomially_longer`
- **Works on the current version:** no. On 7.0 it raises `Couldn't determine a delay based on :polynomially_longer` (backport-2). Ships with the Gemfile change.
- **Validation:** probe-3b gives `[:exponentially_longer, [3, 18, 83]]` on base and `[:polynomially_longer, [3, 18, 83]]` on upgraded, so the delays are the same.

**R19. A BigDecimal job argument cannot be read by 7.0 workers** (`app/models/user.rb:41`)
- **Error** (matrix 120758, written by upgraded, read by base): `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`
- **Cause:** activejob 7.2.0 removed the primitive BigDecimal serializer.
- **Consequence:** during a rolling deploy or rollback, `DigestJob`s queued by 8.1 fail on 7.0 Sidekiq workers.
- **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already calls `BigDecimal(params[:completion])`.
- **Works on the current version:** yes.
- **Validation:** after the repair the matrix (120819) has every cell readable, and the digest test still asserts `50%`.

## Default-related changes (needed only with `load_defaults 8.1`)
- **D1.** `app/models/notebook.rb:7`
  - Error (checks/defaults/01): `missing keyword: :coder If no default coder is configured…`
  - Repair: `serialize :preferences, coder: YAML`
  - Stored YAML is unchanged (probe-4 shows `"---\nexport_heading: Heading\n"` on both versions).
- **D2.** `app/views/exports/_export.html.erb:26`
  - Error (defaults/02): `Cache expiration time is invalid, cannot be negative: -60.0`
  - Repair: `expires_in: [export.expires_at - Time.current, 1.second].max`
  - Second attempt: `cache_if export.expires_at.future?` was rejected because it changed the behavior the test asserts.
- **D3.** `app/controllers/notebooks_controller.rb:39`
  - Error (defaults/02): `ActiveRecord::ReadonlyAttributeError: slug`
  - Repair: drop `:slug` from `permit`. The form at `_form.html.erb:13` can then also stop sending it.
- **D4.** `app/models/notebook.rb:40`
  - Error (defaults/02): `TypeError: no implicit conversion of Date into String`
  - Repair: `[day.to_date, count]`. This works whether the value is a Date or a String.

One line per new default (the D repairs above are each the "test showed it" evidence):
- **7.1 `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`:** the app uses Marshal today. The matrix (120955) shows defaults-written signed messages fail on 7.0: `TypeError: incompatible marshal file format`. Signed and encrypted cookies and the session are affected, so enable this only after 8.1 is fully deployed and rollback is no longer needed.
- **7.1 `default_column_serializer nil`:** shown by D1.
- **7.1 `raise_on_invalid_cache_expiration_time`:** shown by D2.
- **7.1 `raise_on_assign_to_attr_readonly`:** shown by D3.
- **7.2 `postgresql_adapter_decode_dates`:** shown by D4.
- **7.1 `marshalling_format_version 7.1` and cache format:** the test cache is a null store. A rollback reading the production Redis cache was not tested.
- **7.2 `enqueue_after_transaction_commit`:** jobs are enqueued inside `with_lock` (`note.rb:60`). Tests pass with defaults, and the deferral is effectively a no-op, since 8.1 removed the config and the Sidekiq adapter has its own setting.
- **7.1 `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `belongs_to_required_validates_foreign_key`, `generate_secure_token_on`, `allow_deprecated_parameters_hash_equality`:** tests pass with defaults; no app-specific probe.
- **7.1 sanitizer vendor HTML5 (Action View and Action Text):** the rich-text sanitizer test passes with defaults.
- **7.1 `dom_testing_default_html_version :html5`:** tests pass.
- **8.0 `to_time_preserves_timezone :zone`:** already forced by 8.1 (R14).
- **8.0 `strict_freshness`:** `export_downloads_controller.rb:11` sends both an ETag and Last-Modified. Not probed.
- **7.2 `yjit`, `log_file_size`, `precompile_filter_parameters`, `query_log_tags_format`, `debug_exception_log_level`:** operational only, no visible effect.
- **7.1 Active Record encryption settings:** the app does not use encryption.
- **SQLite strict strings:** the app uses PostgreSQL.
- **7.2 `validate_migration_timestamps`:** db:prepare is ok.
- **7.2 `web_image_content_types`:** blobs render through `_blob.html.erb`. Not probed.

## Other gems that move
- **json 3.1.0** (new, replaces Ruby's default): caused R6. Pin `< 3` until Active Support passes keyword arguments; the lab resolved json 2.21.2.
- **bigdecimal 4.1.3** (new, replaces default): `user.rb:56` and `digest_mailer.rb:10` work; the digest test asserts `50%`. No `divmod` or `precs` in the app.
- **uri 1.1.2** (new, replaces default): `URI.parse` at `provider.rb:56` is covered by the enrichment controller tests that run.
- **drb and securerandom** (new, replace defaults): not called directly by the app.
- **rack-session, rackup, useragent, webrick, action_text-trix** (new): framework dependencies. The layout still includes the vendored `trix-1.3.5.js` (`application.html.erb:13`); assets and pages pass, but it now duplicates the gem's Trix (see Not verified).
- **method_source:** removed from the bundle; nothing in the app uses it.

## Rollout and rollback
1. **First, deploy on 7.0** the repairs that work on the current version: R1, R3, R5, R6 (the pin is harmless on 7.0), R8 (application.rb and provider.rb together), R9–R17 and R19. R19 must be live before any 8.1 process enqueues digests, or 7.0 workers cannot read those jobs.
2. **Then ship with the Gemfile bump** the repairs that require it: R4, R7 (test config), R18, plus the R8 test edits. `note.rb` as a whole goes here because of R4.
3. **Stored data during a rolling deploy:**
   - Session and signed messages read fine in both directions while `load_defaults` stays at 7.0.
   - Jobs queued by 8.1 carry a `time_zone` key, which 7.0 ignores, so 7.0 reads them back in UTC. R12 makes both versions produce the same digest day.
4. **Adopting the 8.1 defaults** (D1–D4) is a later, separate deploy. Move the message serializer last, because 7.0 cannot read JSON-serialized signed or encrypted cookies.

## Not verified
- Whether 8.1 shows a deprecation warning for the built-in Sidekiq adapter (`config/application.rb:24`, sidekiq 6.5.12). Probe-4 instantiates it without warnings. Plan to move to sidekiq ≥ 7.x's own adapter.
- Duplicate Trix: the vendored `trix-1.3.5.js` plus the `action_text-trix` 2.1.19 gem. Needs a browser check (`bin/rails test:system`), which was not run.
- `:unprocessable_entity` deprecation (rack 3.2): rack did not move in this bump.
- `Rails.logger` BroadcastLogger at `production.rb:86`: production boot is ok, but log output was not inspected.
- Rollback reads of the production Redis cache under cache format 7.1: not tested.
- Each `note.rb` hunk except R4 was not backported on its own.

All files are under `/tmp/upgrade-lab-rails`: `repairs.patch` (R repairs), `copies/defaults` (D repairs), `notes.md`, `matrix.log`, `backport-each.log`. The lab services are stopped.

---

**My notes:** This is a plan only. Nothing in your repo has changed. Rails is locked at 7.0.8.7, so this jumps four minor versions. Rails can't simply be bumped: it won't boot on 8.1.0 without the 19 repairs above.

- **Three tests still error** with all the repairs applied. They need the R8 test edit (switching to `Rails.configuration.x.citation_provider`), which the planner didn't make.
- **The `json < 3` pin (R6) adds a dependency constraint.** Your CLAUDE.md asks you to keep dependency versions unless the task authorizes it. I'd count it as part of this upgrade, but it's your call.
- **The browser suite (`bin/rails test:system`) was not run.** That leaves the duplicate Trix risk open.

If you want me to go ahead, I'd start by applying the repairs that already work on Rails 7.0 (step 1 of the rollout) as their own commit.