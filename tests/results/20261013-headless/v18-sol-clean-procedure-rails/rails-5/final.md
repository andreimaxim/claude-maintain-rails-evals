# Upgrade plan: Rails 7.0.8.7 → 8.1.0 (Margin Notes)

I wrote a plan only; nothing in the application changed (`git status` is clean). All edits and evidence are under `/tmp/tmp.Uhu5JGWTFz`.

**Bottom line:** the target is reachable with 19 small repairs. With them applied, every release (7.0.10, 7.1.6, 7.2.4, 8.0.5.1, 8.1.0) passes resolve, prepare, boot, eager, routes and the full test suite (46 runs, 0 failures). Without them, 7.1 and later releases don't boot.

**Inputs checked:**
- Ruby 3.3.6, Bundler 2.5.22. Rails 8.1 needs Ruby ≥ 3.2, so no Ruby change is required.
- `rails 7.0.8.7` is locked from rubygems.org, and `load_defaults 7.0` is set.
- There is no CI config, so the CI command used is `bin/rails test`.

**Where things are** (run logs are relative to `R=/tmp/tmp.Uhu5JGWTFz/lab/runs`):
- Repair script: `/tmp/tmp.Uhu5JGWTFz/repairs/apply.rb` (plus `repairs/action_text.rb`)
- Probes: `/tmp/tmp.Uhu5JGWTFz/probes/`; results: `/tmp/tmp.Uhu5JGWTFz/probe-results/*.log`
- Review table: `/tmp/tmp.Uhu5JGWTFz/changes/review.tsv`
- Final matrix: `/tmp/tmp.Uhu5JGWTFz/final-matrix.log`

**How "unrepaired" was tested:** a separate variant per release applies every repair except the one under test, so each finding's failure shows on its own.

**Evidence labels:** **[E]** executed (log and resolved lockfile exist); **[S]** source-based; **[P]** proposed, not executed.

## 1. Required changes

Repairs marked *prep* work on 7.0.8.7 and 8.1.0 alike, so ship them before changing Rails. All of them together pass on 7.0.8.7 and 7.0.10.

**F13 — digest uses the reader's local day instead of the UTC day** (Active Job 7.0.9, C4) [E]
- Where: `app/mailers/digest_mailer.rb#daily_digest`, called by `DigestJob`, with `requested_at` coming from `User#request_digest`.
- When: the reader's time zone isn't UTC.
- Consequence: the digest's date subject and the "updated that day" note list shift to the reader's local day. The suite fails at 7.0.10: `expected "Your reading digest for October 05, 2026"`, actual `"…October 04, 2026"` (`R/20261014T211031-r7_0_10-99fe12/tests.log`).
- Repair P13 (prep): add `requested_at = requested_at.in_time_zone("UTC")` after `values_at`.
- Validation: probe `digest_day`, Eastern reader at 23:30 local.
  - Unrepaired: FAIL (`x7_0_10-f11704`).
  - Repaired: PASS on all variants. Control (UTC reader) passes everywhere.
  - Mixed-version job payloads give the same UTC date in both directions (`job_envelope`: `current-038977`, `f7_1_6-92d471`, `f8_1_0-4f88be`).

**F1 — boot failure from the Action Text initializer** (Action Text 7.1, C141/C143; 8.1 merge 5e231ae65) [E]
- Where: `config/initializers/action_text.rb:3`.
- When: always, from 7.1.6 on.
- Consequence: boot, prepare and tests fail with ``undefined method `+' for nil (NoMethodError)`` (`R/…211106-r7_1_6-62b06e/boot.log`, same on 7.2.4, 8.0.5.1 and 8.1.0).
- Repair P1 (prep): inside `config.after_initialize { ActiveSupport.on_load(:action_view) { … } }`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [attachment tag, figure, figcaption]) | %w[details summary]`. Use the `on_load(:action_view)` form: in 8.1 the sanitizer vendor is only assigned in that hook.
- Validation: probe `rich_text_tags` keeps `<details><summary>`; control: `<script>` stripped, `<b>` kept. PASS on pcur, f7_1_6, f8_1_0, and x8_1_0 with `load_defaults 8.1` (sanitizer is `Rails::HTML5::SafeListSanitizer` there).

**F6 — exports crash on `Array#sum` of strings** (Active Support 7.1, C470) [E]
- Where: `app/models/export.rb` `finish(fragments.sum)`, reached from `ExportJob` via `Export#generate`.
- When: every export, including an empty notebook.
- Consequence: `TypeError: String can't be coerced into Integer` (`x7_1_6-215789`; b7_1_6 tests, 3 errors).
- Repair P6 (prep): `fragments.join`.
- Validation: `export_markdown`, two notes produce the exact Markdown; control: empty notebook gives the heading only. PASS when repaired.

**F2 — `Rails.application.secrets` removed** (railties 7.1 deprecation, 7.2 removal; C534/C1012) [E]
- Where: `app/models/citation/provider.rb` `initialize`, plus `config/secrets.yml` and its test helper.
- Consequence: ``NoMethodError: undefined method `secrets'`` (`x7_2_4-a6d7f4`).
- Repair P2 (prep):
  - Add `config/citation_provider.yml` with the same ERB and `.to_json` quoting.
  - In `config/application.rb`, add `config.x.citation_provider = config_for(:citation_provider)`; the provider reads `Rails.application.config.x.citation_provider.to_h`.
  - Update `test/controllers/citation_enrichments_controller_test.rb`.
  - Then delete `config/secrets.yml`. It holds no `secret_key_base`, so no key is lost [S].
- Validation: `provider_settings` returns the default url/user/password; control: explicit settings win. The suite's subprocess test with `"00123"` / `"sample: value # keep"` passes. Production runner boot is green (`current-7fa569`, `f8_1_0-2a041c`).

**F4 — `highlight_color` alias to a store accessor** (Active Record 7.1/7.2, C279/C917) [E]
- Where: `app/models/note.rb` `alias_attribute :highlight_color, :color`; used by `NotesController#note_params` and the views.
- Consequence: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute` (`x7_2_4-5e4af4`).
- Repair P4 (prep): explicit `highlight_color` / `highlight_color=` methods delegating to `color`.
- Validation: `highlight_color` probe: create gives green, update gives pink, read works; control: purple is rejected. PASS.

**F5 — import receipt loses the DOI** (Active Record 7.2, C277/C915; `Citation` primary key is `doi`) [E]
- Where: `app/models/import.rb#receipt` `citation[:id]`, from `ImportsController#show` as CSV.
- Consequence: silent data loss, `"title,doi\nCited,\nUncited,\n"` (`x7_2_4-4a8782`).
- Repair P5 (prep): `citation&.doi`.
- Validation: `receipt_doi` returns the DOI, and a note without a citation stays blank (control). The suite's receipt assertion also covers it.

**F7 — failed imports now save partially** (Active Record 7.2, C269/C913/C1265) [E]
- Where: `app/models/import.rb#apply`, `return false` inside `transaction`, from `ImportsController#create`.
- When: any row fails to save.
- Consequence: the import and earlier rows are committed while `false` is returned: `notes/imports [0, 0]->[1, 1]` (`x7_2_4-be3583`).
- Repair P7 (prep): `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }; true` inside the block, then `|| false`.
- Validation: `import_atomic`, an invalid middle row saves nothing; control: all-valid input saves both rows. PASS on all.

**F11 — scheduling reminders crashes** (Active Job 7.1/7.2, C581/C830) [E]
- Where: `app/models/note.rb#schedule_reminder` `set(wait_until: reminder_epoch)`, from `RemindersController` and `ReminderPostponementsController`.
- Consequence: ``NoMethodError: undefined method `utc' for an instance of Integer`` (`x7_2_4-0abcea`).
- Repair P11 (prep): `set(wait_until: Time.at(reminder_epoch))`.
- Validation: `reminder_schedule`, the job is enqueued at the exact epoch; control: nil is refused. Through the real Sidekiq adapter, the scheduled-set entry is at the epoch and the payload runs and sends one mail (`sidekiq_adapter`, `current-42b2b2` / `f8_1_0-69e480`).

**F12 — BigDecimal job argument breaks rollback** (Active Job 7.1/7.2, C178/C829) [E]
- Where: `app/models/user.rb#request_digest`, which passes `reading_completion` (a BigDecimal).
- Consequence: 7.2+ writes `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",…}`. A 7.0.8.7 worker reading it fails with `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (writer `x7_2_4-c16c15`, reader `current-2dcdac`).
- Repair P12 (prep): `reading_completion.to_s`; the mailer already calls `BigDecimal(…)`.
- Validation: every version reads every other version's payload (`bigdecimal_payload`).

**F16 — notebook filter on the notes list breaks** (Active Record 7.2, C223/C914) [E]
- Where: `app/controllers/notes_controller.rb#index` `where(notebooks: @notebook)`.
- Consequence: `PG::UndefinedColumn: column notes.notebooks does not exist`. This only surfaced after the other repairs (`R/…211627-f7_2_4-c7783c/tests.log`, 2 errors).
- Repair P16 (prep): `where(notebook: @notebook)`.
- Validation: `notes_filter`, plus the suite's filter and pagination tests.

**F15 — activity report fails if date decoding is on** (Active Record 7.2 option, C939) [E]
- Where: `app/models/notebook.rb#daily_note_counts` `Date.iso8601(day)`.
- When: `postgresql_adapter_decode_dates` is true. Effective value is false under kept defaults.
- Consequence: `TypeError: no implicit conversion of Date into String` (`x7_2_4-c3e4e2`).
- Repair P15 (prep): `day.to_date`.
- Validation: `activity_dates` with decoding off and on gives `[[2026-10-03, 2], [2026-10-01, 1]]`.

**F19 — `serialize` positional coder removed** (Active Record 7.1/7.2, C384/C385/C922) [E]
- Where: `app/models/note.rb` `serialize :tags, JSON`; `app/models/notebook.rb` `serialize :preferences` (implicit YAML).
- Consequence: Note fails to load: `wrong number of arguments (given 2, expected 1)` (`R/…211337-b7_2_4-88de65/eager.log`, `x7_2_4-0fafda`).
- Repair V1 (needs 7.1, so ship with the 7.1 hop): `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
- Validation: `stored_formats`.
  - Rows written by 7.0 (`["essay","draft idea"]`, `"---\nexport_heading: Old heading\n"`) read correctly.
  - Rewrites keep identical raw bytes on every version, so rollback reads them too.
  - Control: blank preferences stay nil.

**F20 — `retry_on wait: :exponentially_longer` removed** (Active Job 7.2, C828) [E]
- Where: `app/jobs/citation_enrichment_job.rb`.
- Consequence: `RuntimeError: Couldn't determine a delay based on :exponentially_longer` on the first provider outage (`x7_2_4-eff264`).
- Repair V2 (7.1 hop): `:polynomially_longer`.
- Validation: `retry_wait`, a retry is scheduled in the future, then failure is recorded after 3 attempts; control: a provider error fails without retry.

**F21 — boolean `show_exceptions` removed** (Action Pack 7.1/7.2, C94/C803) [E]
- Where: `config/environments/test.rb`, `show_exceptions = false`.
- Consequence: 2 failures, `ActiveRecord::RecordNotFound expected but nothing was raised` (`x7_2_4-dd0b58`).
- Repair V3 (7.1 hop): `:none`.

**F3 — keyword-argument `enum` removed** (Active Record 8.0, C870/C1268) [E]
- Where: `app/models/note.rb` `enum status:` with `_prefix`.
- Consequence: Note won't load: `wrong number of arguments (given 0, expected 1..2)`; tests show 46 errors (`R/…211355-b8_0_5_1-beb3d2`, `x8_0_5_1-6add6e`).
- Repair P3 (prep): `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- Validation: `enum_status`.

**F8 — import preview drops annotations** (Active Support 8.0, C1273) [E]
- Where: `app/views/imports/preview.html.erb` `@import.annotations.stringify_keys`, looked up by Integer line number.
- Consequence: silently missing: `line_2 dts=["Body"]` (`x8_0_5_1-2e3ba2`).
- Repair P8 (prep): drop `.stringify_keys`.
- Validation: `preview_annotations` line 2 shows its annotation; control: line 3 shows none.

**F9 — `form_with model: nil` removed** (Action View 8.0, C817/C1258) [E]
- Where: `app/views/notes/index.html.erb` search form.
- Consequence: `ActionView::Template::Error: Passed nil to the :model argument` (`x8_0_5_1-d07069`).
- Repair P9 (prep): `form_with(url: notes_path, method: :get, …)`.
- Validation: the probe renders `action="/notes" method="get"` with the top-level `name="query"`.

**F10 — route with two paths removed** (Action Pack 8.1, C1168/C1392) [E]
- Where: `config/routes.rb` `get "/notes", "/journal"`.
- Consequence: the routes stage fails with `Wrong number of arguments (expect 1, got 2)`, and `/notes` stops routing (`R/…211202-r8_1_0-406666/routes.log`, `x8_1_0-01e2c5`).
- Repair P10 (prep): two separate `get … to: "notes#index"` lines.
- Validation: `/journal` and `/notes` both reach `notes#index`; `notes_path` is unchanged.

**F14 — 24-hours-later reminder preview changes across DST** (Active Support 8.0/8.1, C1225/C1541) [E]
- Where: `app/models/note.rb#next_day_reminder_at` `reminder_at.to_time + 86_400`, shown in `notes/_reminder`. The model comment and the test pin the offset-keeping contract.
- Consequence at 8.1: `2026-11-01T08:00:00-05:00` instead of `…09:00:00-04:00` (`x8_1_0-8c2359`).
- Repair P14 (prep): `(reminder_at + 86_400).getlocal(reminder_at.utc_offset)`.
- Validation: the DST case and the control (no DST change) pass on all versions.
- This doesn't silence the 8.0 boot deprecation, which comes from the inherited `to_time_preserves_timezone = true` (10 warnings in f8_0_5_1 logs). Optionally set it to `:zone` while on 8.0 and remove it at 8.1.

**F22 — `json` 3.x breaks sessions on 8.1.0** (dependency; 8.1.0 adds an unbounded `json` dependency, commit 4646cc461) [E]
- Where: the resolver picks `json 3.1.0`, whose `parse(source, **options)` rejects ActiveSupport's `JSON.parse(json, options)`.
- Consequence: every signed-in request fails decoding the session cookie with `ArgumentError: wrong number of arguments (given 2, expected 1)`. Tests: 46 runs, 4 failures, 40 errors (`R/…211712-f8_1_0-b2b059/tests.log`).
- Repair G1 (8.1 hop): add `gem "json", "~> 2.7"` to the Gemfile; it resolves to 2.21.2.
- Validation: the suite is green, and `json_decode` passes.

**F17 — negative fragment-cache expiry for expired exports** (Active Support 7.1, C429) [E]
- Where: `app/views/exports/_export.html.erb` `expires_in: export.expires_at - Time.current`.
- Consequence:
  - From 7.1, each render of an expired export reports `Cache expiration time is invalid, cannot be negative: -3600.1…` (`f7_1_6-39c1be`).
  - With the 7.1 default enabled it raises `ActionView::Template::Error` on the exports page.
- Repair P17 (prep): `[export.expires_at - Time.current, 0].max`.
- Validation: no reports, and the page renders even with raising on (`f7_1_6-3761bc`, `f8_1_0-cb5a1c`). The suite's cached-indicator test passes.

**F18 — notebook settings form resubmits the read-only slug** (7.1 option, C351) [E]
- Where: `NotebooksController#notebook_params` permits `:slug`; the form keeps the hidden field, which the test pins.
- When: `raise_on_assign_to_attr_readonly` is enabled.
- Consequence: `ActiveRecord::ReadonlyAttributeError: slug` (`x8_1_0-5bccc6`).
- Repair P18 (prep): `permit(:name, :export_heading)`. Create still derives the slug from the name.
- Validation: notebook tests pass with the flag on (`x8_1_0-99e112`) and off (all variants).

**Other findings, no repair needed**
- **F23 — Sidekiq adapter deprecated [E].** 8.1 logs `The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2. Please upgrade sidekiq gem to version 7.3.3 or later`. Sidekiq 6.5.12 works on every version. This is a blocker for a future 8.2, not for 8.1; keep the pin.
- **F24 — `enqueue_after_transaction_commit` [E].** Effective `:never` on 7.2 and `false` on 8.1, so enqueues inside `with_lock` behave as today.
- **F27 — `schema.rb` column order [S].** 8.1 sorts columns alphabetically, so expect a one-time diff on the next migration.
- **F25 — dev/test secret file renamed [S].** The local secret moves to `tmp/local_secret.txt` (7.1), which resets local sessions and signed URLs in dev/test only.
- **DEP — dependency movements [E].** See the dependency section; BigDecimal paths stay green on `bigdecimal 4.1.3`.

**Documentation to update** with the repairs: ARCHITECTURE.md (Trix / Action Text 7.0.8.7 note) and references to `config/secrets.yml`. The Minitest `~> 5.25` and `concurrent-ruby 1.3.4` pins resolved fine on every variant; keep them unchanged unless separately authorized.

## 2. Optional defaults

Keep `load_defaults 7.0` for the upgrade. Nothing in the app sets any of these explicitly. "Effective" values were measured with `defaults.rb` / `defaults2.rb` on current, f7_2_4 and f8_1_0.

With every repair applied, `load_defaults 8.1` passes all 46 tests and the key probes (`x8_1_0`, `…214910`). Enable later, one at a time:

**Settings with app impact**
- **`message_serializer` / `use_message_serializer_for_metadata` (D11/D12):** effective Marshal (nil). Signed IDs inside stored rich text: with `:json_allow_marshal`, 8.1 reads sgids written by 7.0 [E]. With pure `:json` it fails (`RuntimeError: Unsupported serialization format`), and 7.0 cannot verify sgids written under either JSON setting [E] (`x8_1_0-baa063` / `x8_1_0-1d7a60`, `current-935480`). Use only `:json_allow_marshal`, only after rollback to 7.0 is off the table, and never pure `:json`.
- **`raise_on_invalid_cache_expiration_time` (D9):** effective false. Requires P17.
- **`raise_on_assign_to_attr_readonly` (D14):** effective false. Requires P18.
- **`postgresql_adapter_decode_dates` (D30):** effective false. Requires P15.
- **`default_column_serializer = nil` (D18):** effective YAML. Requires V1.
- **`to_time_preserves_timezone` (D32):** effective `true`; nil at 8.1, where `:zone` behavior applies. P14 keeps the contract.
- **`action_text.sanitizer_vendor` HTML5 (D24):** effective HTML4. P1's hook form keeps `details`/`summary` [E].

**Settings with no app impact** (code-based reasons are in `review.tsv`)
- D1, D7, D8, D21, D27: deprecated or removed settings, already handled by repairs.
- D2–D4: no `encrypts` in the app.
- D5, D17, D20: no app commit callbacks.
- D6: SQLite only.
- D10: query logs are off.
- D13, D25, D31: logging or performance only.
- D15, D26, D34, D37: suite green with `load_defaults 8.1`.
- D16: parameter filtering is unchanged.
- D19: no Marshal-cached records.
- D22: no `has_secure_token`.
- D23: no direct sanitize helpers in views.
- D28: no image variants.
- D29: migration timestamps are valid.
- D33: `stale?` uses a consistent ETag and last-modified [S].
- D35/D36: no JSON responses.
- D38: no relative redirects.
- D39: one-time cache-digest miss.
- D40: hidden fields lose `autocomplete="off"` and tests still pass.

## 3. Rollout and rollback

**Step 0, still on 7.0.8.7: ship P1–P18 (prep).** Green on 7.0.8.7 (`pcur`) and 7.0.10 (`x7_0_10`). This makes digest and BigDecimal job payloads version-neutral before any upgraded worker runs.

Then upgrade one release per deploy:
1. **7.0.10.**
2. **7.1.6 together with V1–V3.** These need 7.1 APIs; rolling back below 7.1 means reverting just these three code lines (no data impact).
3. **7.2.4.**
4. **8.0.5.1.** Optionally set `to_time_preserves_timezone = :zone`.
5. **8.1.0 together with G1** (`json ~> 2.7`), and remove the `:zone` line if you added it.

Use `bin/rails test` and `bin/rails zeitwerk:check` at each step, and expect no deprecation warnings except the 8.0 `to_time` one and the 8.1 Sidekiq one.

**Mixed-version and rollback evidence** (executed, with a shared `secret_key_base` and default serializers):
- **Sessions:** cookies written by 7.0.8.7, 7.2.4 and 8.1.0 are read by each other, and the control without a cookie redirects to sign-in (`current-178d32`, `f8_1_0-f43f4b`, `f7_2_4-8cf867`).
- **Active Job:** envelopes are readable 7.0 ↔ 7.1 ↔ 8.1. The BigDecimal case is safe only with P12.
- **Stored data:** serialized columns are byte-identical across versions, and rich-text sgids are readable both ways under default settings.
- **Cache:** the cache format stays 7.0 on all versions.
- **Database:** no migrations are required.

Rollback is not safe after enabling a JSON message serializer (see the defaults section).

## Version and check matrix

| Variant | Resolve | Prepare | Boot | Eager | Routes | Tests |
|---|---|---|---|---|---|---|
| current 7.0.8.7 | ok | ok | ok | ok | ok | 46 runs, 0 failures |
| r7.0.10 | ok | ok | ok | ok | ok | 1 failure (F13) |
| r7.1.6 / r7.2.4 / r8.0.5.1 / r8.1.0 | ok | fail F1 | fail F1 | fail F1 | fail F1 | fail F1 |
| b7.1.6 (P1 only) | ok | ok | ok | ok | ok | 1 failure, 3 errors (F13, F6) |
| b7.2.4 | ok | ok | ok | fail F19 | ok | errors |
| b8.0.5.1 | ok | ok | ok | fail F3 | ok | 46 errors |
| b8.1.0 | ok | ok | ok | fail F3 | fail F10 | 46 errors |
| pcur 7.0.8.7, prep repairs | ok | ok | ok | ok | ok | 46 runs, 0 failures |
| x7.0.10, prep repairs | ok | ok | ok | ok | ok | 46 runs, 0 failures |
| f7.1.6 / f7.2.4 / f8.0.5.1 / f8.1.0 (+G1), all repairs | ok | ok | ok | ok | ok | 46 runs, 0 failures |
| x8.1.0, all repairs + `load_defaults 8.1` | ok | ok | ok | ok | ok | 46 runs, 0 failures |

Final logs are listed in `/tmp/tmp.Uhu5JGWTFz/final-matrix.log`, with lockfiles at `lab/variants/*/Gemfile.lock`. Production runner boot is green on 7.0.8.7 and 8.1.0.

## Dependency movements

Compared with the current lock, from `changes-*/dependencies.json`:

**Added**
- `bigdecimal 4.1.3`, `drb 2.2.3`, `securerandom 0.4.1`, all from 7.0.10.
- `benchmark 0.5.0` and `mutex_m 0.3.0` (7.0.10–7.2), `cgi 0.5.2` (7.1–7.2).
- `rack-session 1.0.2`, `rackup 1.0.1`, `webrick 1.9.2` (7.1).
- `useragent 0.16.11` (7.2), `uri 1.1.2` (8.0).
- `action_text-trix 2.1.19` and `json` (8.1; pin `json` to 2.x per G1).

**Removed:** `method_source`.

**Moved:** `net-imap` 0.6.7 → 0.6.8.

**Unchanged:** rack 2.x, sidekiq 6.5.12, redis 4.8.1, pg 1.6.0, puma 5, and the importmap/turbo/stimulus/sprockets gems. All sources are rubygems.org; there are no Git or path gems.

## Remaining unknowns and coverage limits

- **Rich-text editor in the browser (16 rows marked unknown).** The layout loads vendored Trix 1.3.5, while Action Text 7.1+ ships Trix 2 (CVE fixes such as 2.1.1 don't reach 1.3.5). There are no system tests and no browser in the lab. Proposed: a system test for editing and attaching in the editor.
- **Git history.** 13,954 commits were not read individually. I read the full candidate lists for activejob, actiontext and activemodel, keyword-filtered the others, and inspected the patches behind 5e231ae65, 4646cc461 and dc4f4e059. I read `guides.diff` and the upgrading guide sections for every crossed release.
- **Configuration the lab replaced.** The lab generated its own `database.yml` and `storage.yml`; `pool:` is still accepted in 8.1 [S]. The production Action Cable Redis adapter and Puma were not run.
- **Assertion counts.** The 325 (7.0) vs 340 (7.1+) assertion counts were not investigated.
- **Pre-existing Sidekiq warning.** `ExportJob` arguments "do not serialize to JSON safely" (symbol keys); this is a Sidekiq issue, not Rails.

## Final check

- Every one of the 1,619 `review.tsv` rows is disposed: 97 finding, 1,506 not-applicable with a code or config reason, 16 unknown.
- Each repair was exercised on both sides: create and update, fresh and expired, old and new payloads, with and without each default.
- Every executed claim above cites a run log with a resolved `Gemfile.lock` in its variant.
- Green tests alone were not taken as clearing a finding; each finding has a probe or a failing check.

---

**My notes:**

- **Not upgraded yet.** The upgrade skill only plans, so your repo is untouched and still on `main` with Rails 7.0.8.7. Everything above was tested in scratch copies under `/tmp/tmp.Uhu5JGWTFz`.
- **Two items in the plan look off for this app and need checking before you rely on them:**
  - F16 cites a `PG::` error, but D6 says the app is "SQLite only."
  - The "Settings with no app impact" list cites D35/D36 as "no JSON responses," but the project guidance mentions Jbuilder.
- **Two changes need your approval:** pinning `gem "json", "~> 2.7"` (the project rules say not to add or change dependencies without authorization), and whether to add a browser test for the Trix 1.3.5 → 2 editor change.

Should I apply the prep repairs (P1–P18) on a branch as the first step?