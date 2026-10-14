# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade can't go in as a plain version bump. On 8.1.0 the app won't boot, and after that is fixed, all 46 tests error. I found 17 required repairs (R1–R17). Applying all of them in a disposable copy gave **46 runs, 340 assertions, 0 failures** with `load_defaults 7.0` kept, and the same result with `load_defaults 8.1` once two default-related repairs (D1, D2) were added. The working repo was not touched (`git status` is clean).

## Setup and evidence
- **Isolation:** each copy is a separate git clone with its own database name (`mn_base_*`, `mn_up_*`, `mn_def_*`). They used a private PostgreSQL 15 (socket `/tmp/up/svc`, port 55432) and a private Redis on 56379, both stopped afterwards. Variables are in `/tmp/up/env.sh`.
- **The three copies:**
  - `/tmp/up/base`: Rails 7.0.8.7, used as the control.
  - `/tmp/up/up`: Rails 8.1.0 with `load_defaults 7.0`.
  - `/tmp/up/def`: Rails 8.1.0 with `load_defaults 8.1`.
- **Resolved gems** (`bundle update rails --conservative`, log `/tmp/up/up-bundle.log`, lock diff `/tmp/up/up-lock.diff`, versions `/tmp/up/up-resolved.txt`): rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, turbo-rails 2.0.12, minitest 5.27.0, json 3.1.0 (2.21.2 after R1).
- **Starting points:** the 7.0 control passes, 46 runs and 325 assertions (`/tmp/up/base-test.log`). The bumped app fails as described in each finding (logs `/tmp/up/up-test1.log` through `up-test8.log`). The change index is `/tmp/up/changes.txt`.
- **Test-suite results:**
  - Final 8.1 runs: `/tmp/up/up-test-final.log` and `/tmp/up/def-test2.log`.
  - Repairs back-ported to 7.0: `/tmp/up/base-test-prep.log` (passes), patch `/tmp/up/prep-on-7.0.patch`.
  - Full 8.1 diff: `/tmp/up/up-final.patch`.
- **Probe scripts:** in `/tmp/up/probes/`, with matrix outputs `job-matrix.log`, `rem-matrix.log`, `cookie-matrix.log`, `sgid-matrix.log`, `probe1-*.log`, `probe2-up.log` and `probe3.log`.

"Works on 7.0" below means the repair was applied to the 7.0 copy and that suite passed.

## Required changes (8.1.0 with `load_defaults 7.0`)

**R1. json 3.1.0 is incompatible with Active Support 8.1.0** (`Gemfile`). Active Support 8.1.0 depends on `json` with no upper bound, and bundler picked 3.1.0. Every JSON-serialized read then fails: `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291` via `active_support/json/decoding.rb:25`. This hits `Note#tags`, raised on rollback in every test.
- **Repair:** add `gem "json", "< 3"` (resolved 2.21.2). Works on 7.0.
- **Validate:** `Note.first.tags` raises with json 3.1.0 and returns an Array with 2.x.
- **Open question:** whether a later 8.1.x patch release fixes this.

**R2. Action Text allowed tags are nil since 7.1** (`config/initializers/action_text.rb`). Boot fails: `NoMethodError: undefined method '+' for nil` at line 3. Action Text also chooses its sanitizer only when Action View loads. My first repair in `after_initialize` read the old HTML4 sanitizer's tag list, so the repair has to run in `on_load(:action_view)`.
- **Repair:**
  ```ruby
  Rails.application.config.after_initialize do
    ActiveSupport.on_load(:action_view) do
      ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a +
        [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
    end
  end
  ```
  Works on 7.0.
- **Validate** with `probes/probe3.rb`: rendering `<details><summary>`, a `<script>` and an attachment keeps `details` and the attachment and strips `<script>`. It passed on base, up and def (def uses `Rails::HTML5::SafeListSanitizer`).

**R3. Keyword-argument `enum`** (`app/models/note.rb:10`). Removed in 8.0, now `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. Method names (`status_ready`) and stored integers are unchanged. Works on 7.0.

**R4. `serialize :tags, JSON`** (`app/models/note.rb`). The positional coder was removed in 7.2: `ArgumentError (given 2, expected 1)`.
- **Repair:** `serialize :tags, coder: JSON`. The stored JSON text is unchanged.
- **Does not work on 7.0:** there `coder:` is not understood, so `tags` comes back as a String (`undefined method 'any?' for an instance of String` in `notes/_tags`). Ship it in the same commit as the gem bump.

**R5. `alias_attribute` on a `store_accessor`** (`app/models/note.rb:14`). Now fails with: "Note model aliases `color`, but `color` is not an attribute. Use `alias_method :highlight_color, :color`…".
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Both are needed because the form writes the value and the views read it. Works on 7.0.

**R6. One route with two paths** (`config/routes.rb`). Removed in 8.1: `ArgumentError: Wrong number of arguments (expect 1, got 2)` from `get`. On 7.0 this line produced two named routes, `notes` and `journal`.
- **Repair:** `get "/notes", to: "notes#index", as: :notes` plus `get "/journal", to: "notes#index", as: :journal`. Works on 7.0.
- **Validate:** `bin/rails routes` lists the same two named routes as on 7.0.

**R7. `show_exceptions = false` in the test environment** (`config/environments/test.rb`). Booleans are no longer accepted: missing records render a 404 page instead of raising, so the permission tests fail with "ActiveRecord::RecordNotFound expected but nothing was raised".
- **Repair:** `:none`. **Not for 7.0**, where a symbol is truthy and would turn exception pages on. Ship it with the bump.

**R8. `Rails.application.secrets` was removed in 7.2** (`app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:115-121`). Every citation lookup fails: `NoMethodError: undefined method 'secrets'`.
- **Repair:**
  1. Move the same environment-variable-driven settings to `config/citation_provider.yml`.
  2. Load it in `config/application.rb` with `config.x.citation_provider = config_for(:citation_provider)`.
  3. Read `Rails.configuration.x.citation_provider.to_h` in the provider and the test helper.
  4. Delete `secrets.yml`, and update the comment in `bin/citation-provider` and the guidance docs.
  Works on 7.0. Production must keep `CITATION_PROVIDER_*` set. `secret_key_base` never came from `secrets.yml`, so it is unaffected.
- **Validate:** the credentials test checks that the provider receives the configured Basic-auth header.

**R9. `where(notebooks: @notebook)`** (`app/controllers/notes_controller.rb:18`). The notebook filter now fails: `PG::UndefinedColumn: column notes.notebooks does not exist`.
- **Repair:** `where(notebook: @notebook)`. Works on 7.0.
- **Validate:** with a notebook filter only that notebook's notes are listed; without one, all of them (control).

**R10. `form_with(model: nil, …)`** (`app/views/notes/index.html.erb:12`). Every notes list fails: "Passed nil to the :model argument, expect an object or false".
- **Repair:** drop `model: nil`. Parameter names (`query`, `notebook_id`) stay top-level, as before. Works on 7.0.

**R11. `Array#sum` of strings** (`app/models/export.rb:42`). Every export job fails: `TypeError: String can't be coerced into Integer`. 7.0 already printed a deprecation warning for this.
- **Repair:** `fragments.join`. Works on 7.0.

**R12. Integer `wait_until`** (`app/models/note.rb` `schedule_reminder`). Every reminder fails: `NoMethodError: undefined method 'utc' for an instance of Integer`.
- **Repair:** `set(wait_until: Time.at(reminder_epoch))`. Works on 7.0.
- **Validate:** the Sidekiq schedule score stays `2000000000.0` with the same job_id in both versions (`probes/rem-matrix.log`).

**R13. `HashWithIndifferentAccess#stringify_keys` behaves differently** (`app/views/imports/preview.html.erb`, `annotations.stringify_keys`). The preview silently loses every annotation: the test sees "10.1000/Essays.1" where it expected "Read <b>twice</b> & reflect". There is no error, only missing output.
- **Repair:** use `@import.annotations` directly, keyed by line number. Works on 7.0.

**R14. `return` inside a transaction now commits** (`app/models/import.rb` `apply`). The setting that kept the rollback was removed in 8.0. An import with one invalid row now saves the import and the rows before the bad one: record counts went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. This is silent data corruption.
- **Repair:**
  ```ruby
  saved = transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end
  saved == true
  ```
  Works on 7.0.
- **Validate:** an invalid CSV saves nothing (the test at `imports_controller_test.rb:48`). Control: a valid CSV saves 2 notes, 1 citation and 1 import.

**R15. `citation[:id]` on a table whose primary key is `doi`** (`app/models/import.rb` `receipt`). This changed in 7.2, and the receipt CSV now has a blank DOI column ("On idleness," with nothing after it).
- **Repair:** `citation&.doi`. Works on 7.0.

**R16. `wait: :exponentially_longer` was removed** (`app/jobs/citation_enrichment_job.rb`). The first retry raises `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, so the "record failure after 3 attempts" path never runs.
- **Repair:** `wait: ->(executions) { executions**4 + 2 }`. That is the old formula without its random jitter, and works on 7.0. `:polynomially_longer` does not exist on 7.0, so avoid it if you want a preparatory change.

**R17. Times passed to Active Job keep their time zone since 7.1** (`app/mailers/digest_mailer.rb`). The job now arrives in the reader's zone, so the digest covers the reader's local day instead of the UTC day the UI promises. The subject changed from "October 05, 2026" to "October 04, 2026" (`digests_controller_test.rb:33`).
- **Repair:** `requested_at = requested_at.utc` in the mailer. Works on 7.0.
- **Mixed-version check** (`probes/job-matrix.log`): with the repair, the UTC date is 2026-10-05 for payloads written by either version.

**R18. `to_time` now keeps the time zone** (`app/models/note.rb` `next_day_reminder_at`). The 8.0 removal changes the "+24h keeps the UTC offset" behavior across daylight-saving changes. The expected `time[datetime="2026-11-01T09:00:00-04:00"]` was not found.
- **Repair:** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. The epoch saved when postponing is identical either way; only the displayed offset differs. Works on 7.0.
- **Also:** 8.1 warns that `config.active_support.to_time_preserves_timezone` is deprecated. Never set it.

**R19. Mixed-version job argument format** (`app/models/user.rb` `request_digest`). 8.1 always serializes `BigDecimal` with `BigDecimalSerializer`. A digest queued by 8.1 and run by a 7.0 worker fails with `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`probes/job-matrix.log`).
- **Repair:** pass `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`, and a 7.0 queue already carried `"0.5"`. Deploy this on 7.0 first; it passed there.

## Default-related repairs (needed only when adopting the new defaults; verified in `/tmp/up/def`)
- **D1. `default_column_serializer = nil` (7.1).** `serialize :preferences` fails at load: "missing keyword: :coder If no default coder is configured…". Repair: `serialize :preferences, coder: YAML`, which matches the stored `"---\nexport_heading: H\n"`. Ship it with the bump; it is 7.1+ syntax.
- **D2. `raise_on_assign_to_attr_readonly = true` (7.1).** The settings form resubmits the hidden `slug`, so every notebook update fails with `ActiveRecord::ReadonlyAttributeError: slug`, even when the value is unchanged. Repair: remove `:slug` from `notebook_params`; creation still derives the slug in `assign_slug`. Works on 7.0.
- **D3. `postgresql_adapter_decode_dates = true` (7.2).** The activity report fails with `TypeError: no implicit conversion of Date into String`. Repair: `day.to_date` in `Notebook#daily_note_counts`, which accepts both String and Date. Works on 7.0. Also update the "returns … ISO 8601 text" comment.
- **D4. `raise_on_invalid_cache_expiration_time = true` (7.1).** An expired export's index page fails with "Cache expiration time is invalid, cannot be negative: -60.0" (`exports/_export.html.erb:26`). Repair: `expires_in: [export.expires_at - Time.current, 1.second].max`, which keeps the cached-hit behavior that test checks. Works on 7.0.

**Validation for D2 and D3** (`/tmp/up/def/test/probe/upgrade_probe_test.rb`):
- Without the repairs it fails twice (`/tmp/up/def-probe-test-norepair.log`); with them it passes (`def-probe-test.log`).
- The PATCH resubmitting `slug=hacked` assertion checks that the name and export heading change while the slug stays `essays`.
- Control: creating a notebook with a blank slug still produces `brand-new`.
- Control: the activity report renders `time[datetime]`.

## New framework defaults (the app keeps every old value; none are set explicitly)
- **7.1**
  - `default_column_serializer`: see D1.
  - `raise_on_assign_to_attr_readonly`: see D2.
  - `raise_on_invalid_cache_expiration_time`: see D4.
  - `commit_transaction_on_non_local_return`: irrelevant now, since 8.0 always commits (R14).
  - `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`: affect the stored data that matters for rollback, below.
  - `sanitizer_vendor` HTML5 (Action View and Action Text): attribute escaping in rendered rich text changes slightly. `probe3.log` shows the attachment `content` attribute now rendered unescaped.
  - `dom_testing_default_html_version :html5`: tests pass.
  - `use_big_decimal_serializer`: superseded by R19.
  - No impact, because the app has no after_commit callbacks, encryption, secure tokens, SQLite, query log tags, `Parameters == Hash` comparisons or cached Active Record objects: `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `belongs_to_required_validates_foreign_key` (one less parent query on save), `generate_secure_token_on`, the encryption settings, `sqlite3_adapter_strict_strings_by_default`, `query_log_tags_format`, `allow_deprecated_singular_associations_name`, `allow_deprecated_parameters_hash_equality`, `marshalling_format_version`, `precompile_filter_parameters`, `log_file_size` (dev and test logs only), `debug_exception_log_level`.
- **7.2**
  - `postgresql_adapter_decode_dates`: see D3.
  - `validate_migration_timestamps`: all 12 migrations already use 14-digit timestamps.
  - `yjit = true` (Ruby 3.3.6): uses more memory.
  - `web_image_content_types` adds WebP: no variants are used.
  - `enqueue_after_transaction_commit`: the setting was removed in 8.1, and `ActiveJob::Base.enqueue_after_transaction_commit` is `false` under both 7.0 and 8.1 defaults (probe). So the "enqueue under the row lock and roll back if Redis refuses" design in `Citation#request_enrichment` and `Note#schedule_reminder` still holds. Do not turn it on, or a failed enqueue would happen after commit and leave a citation stuck in `pending`.
- **8.0**
  - `to_time_preserves_timezone :zone`: already forced by the removal (R18).
  - `strict_freshness = true` (from source, not run): `ExportDownloadsController` would answer 304 on a matching ETag alone. The ETag is the blob checksum, so this is acceptable. Ownership and expiry are still checked first.
- **8.1:** nothing app-affecting appeared in the index. Loading the 8.1 defaults passed after D1–D4.

**Recommendation:** ship the upgrade with `load_defaults 7.0`. Adopt the new defaults in a later deploy, after the rollback window closes.

## Rollout and rollback
- **Deploy to 7.0 first:** R1, R2, R5, R6, R8–R18 excluding R7, plus R19, D2, D3 and D4. They all passed on 7.0 (`/tmp/up/prep-on-7.0.patch`).
- **Ship with the gem bump:** R3/R4 and D1 if adopting defaults (the `coder:` syntax), and R7.
- **Queued Sidekiq jobs** (`rem-matrix.log`, `job-matrix.log`):
  - Scheduled `NoteReminderJob` jobs work in both directions between 7.0 and 8.1, and keep the same job_id. That matters because `send_reminder` checks the job_id.
  - Digest jobs are compatible in both directions only with R19 and R17.
  - `ExportJob` is a plain Sidekiq job and is unaffected.
- **Session cookies:** compatible in all directions, including 8.1 defaults read by 7.0 (`cookie-matrix.log`).
- **Rollback risk with 8.1 defaults:** signed IDs created with the 8.1 defaults use a new format (`{"_rails":{"data":…}}`). Rails 7.0 crashes parsing them (`undefined method 'unpack1' for nil` in `base64`; `sgid-matrix.log`). Action Text stores these signed IDs in `action_text_rich_texts.body` for every attachment. Rich text saved after adopting the 7.1 message-serializer defaults would break note rendering on a rollback to 7.0. With 7.0 defaults on 8.1 the format stays readable.
- **Built-in Sidekiq adapter:** 8.1 prints a deprecation warning: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later". That is a follow-up, not needed for 8.1.0, and it would bring redis 5, Sidekiq strict JSON arguments for `ExportJob`'s options hash, and `sadd` return-value changes.

## Not verified
- System tests (they need a display and Chrome).
- A real Puma server and Sidekiq worker running end to end. I checked boot, eager loading in production and `zeitwerk:check` ("All is good!"), but not live requests.
- `assets:precompile`.
- `strict_freshness` (source reading only).
- Whether a patch release after 8.1.0 removes the need for R1.
- Production `CITATION_PROVIDER_*` and secret wiring.

---

**My notes on the plan:**

- **Nothing is changed yet.** The upgrade skill only produces a plan, so `Gemfile`, `Gemfile.lock` and the app code are still on Rails 7.0.8.7.
- **The repair count doesn't add up.** The plan's opening says 17 required repairs, but it lists 19 (R1–R19). Its summary also says only D1 and D2 were needed for `load_defaults 8.1`, while the section itself describes four (D1–D4). The detailed sections look like the reliable version.
- **R14 is the most serious item.** After the bump, an import with one bad row would silently save part of the data. Fix it before the bump or in the same change.

If you want me to go ahead, I'd follow the plan's order: first a change on 7.0 with the repairs that work there, then the gem bump together with R3, R4 and R7, keeping `load_defaults 7.0`.