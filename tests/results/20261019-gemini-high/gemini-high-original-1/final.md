## Upgrade Evaluation & Plan: `rails` `7.0.8.7` → `8.1.0`

Upgrading Margin Notes from `rails` `7.0.8.7` to `8.1.0` resolves cleanly on Ruby `3.3.6` (with `gem "json", "~> 2.7"` pinned to prevent Bundler from pulling in `json 3.1.0`, which breaks `ActiveSupport::JSON.decode` in `activesupport 8.1.0`), but **requires 15 code/configuration changes** to boot and pass behavioral contracts under `config.load_defaults 7.0`, plus **4 additional adjustments** if adopting `config.load_defaults 8.1`.

12 of the required changes can be landed as **preparatory changes on Rails `7.0.8.7`** (verified in [`.amp/in/experiments/prep-on-7.0.8.7`](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/test.log)); 4 changes **must be applied in lockstep** with the `rails` `8.1.0` gem bump because their new syntax/symbols fail or corrupt data on `7.0.8.7`.

---

### 1. Dependency Resolution Summary

- **Direct gem change** in [Gemfile](file:///home/user/workspace/repo/Gemfile#L7-L8):
  - `gem "rails", "7.0.8.7"` → `gem "rails", "8.1.0"`
  - Add `gem "json", "~> 2.7"` (see Finding R1 below).
- **Resolved dependency delta** ([lockfile diff](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-raw/lockfile.diff), [8.1.0 Gemfile.lock with json ~> 2.7](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/Gemfile.lock)):
  - Rails framework gems (`rails`, `activesupport`, `activemodel`, `activerecord`, `activejob`, `actionview`, `actionpack`, `actionDispatch`, `actionmailer`, `active_storage`, `actioncable`, `actionmailbox`, `actiontext`, `railties`): `7.0.8.7` → `8.1.0`
  - New transitive gems added by Rails `8.1.0`: `action_text-trix (2.1.19)`, `bigdecimal (4.1.3)`, `drb (2.2.3)`, `json (2.21.2)` (with `~> 2.7`; `3.1.0` if unconstrained), `rack-session (1.0.2)`, `rackup (1.0.1)`, `securerandom (0.4.1)`, `uri (1.1.2)`, `useragent (0.16.11)`, `webrick (1.9.2)`
  - Updated transitive gem: `net-imap` `0.6.7` → `0.6.8`
  - Removed transitive gem: `method_source (1.1.0)`
  - `rack` remains `2.2.24` (`sidekiq 6.5.12` constrains `rack (~> 2.0)`, which `actionpack 8.1.0` `rack (>= 2.2.4)` satisfies).

---

### 2. Required Changes (Even with `config.load_defaults 7.0`)

#### Phase A — Preparatory Changes Compatible with Rails `7.0.8.7`

All findings in Phase A work on both Rails `7.0.8.7` and `8.1.0` and were verified together on `7.0.8.7` in [`.amp/in/experiments/prep-on-7.0.8.7`](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/test.log).

1. **R1 — `json` 3.x keyword-argument incompatibility in `ActiveSupport::JSON.decode`**
   - **Affected code:** [Gemfile](file:///home/user/workspace/repo/Gemfile#L7-L9), affecting `ActiveRecord::Coders::JSON` in [Note (`serialize :tags`)](file:///home/user/workspace/repo/app/models/note.rb#L12) and `ActiveStorage::Blob#custom_metadata`.
   - **Applicability & Evidence (Source + Executed):** `activesupport 7.0.8.7` did not declare a `json` gem dependency, so Ruby `3.3.6` used default gem `json 2.7.2`. `activesupport 8.1.0` declares `json` without an upper bound, resolving `json 3.1.0`. In `json 3.1.0`, `JSON.parse(source, on_load: nil, ..., **options)` accepts only keyword options, whereas `ActiveSupport::JSON.decode(json, options = {})` (`activesupport-8.1.0/lib/active_support/json/decoding.rb:25`) passes `options` positionally (`::JSON.parse(json, options)`), raising `ArgumentError: wrong number of arguments (given 2, expected 1)` on `{}`.
   - **Works on `7.0.8.7`:** Yes (`json 2.21.2` / `2.7.2`).
   - **Recommendation:** Add `gem "json", "~> 2.7"` to [Gemfile](file:///home/user/workspace/repo/Gemfile#L8).
   - **Discriminating validation:** `bin/rails test test/models/note_test.rb:20` (`ActiveStorage::Blob.create_and_upload!` and `Note#tags` JSON decoding).

2. **R2 — `ActionText::ContentHelper.allowed_tags` is `nil` during initializer execution (Rails 7.1+)**
   - **Affected code:** [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3).
   - **Applicability & Evidence (Source + Executed):** In Rails 7.0, `ActionText::ContentHelper.allowed_tags` had a default block returning `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]`. In Rails 7.1+ (`actiontext-8.1.0/app/helpers/action_text/content_helper.rb:10,68-70`), `allowed_tags` defaults to `nil` and falls back to the default tags in `#sanitizer_allowed_tags` only when `allowed_tags` is `nil`. Calling `ActionText::ContentHelper.allowed_tags += %w[ details summary ]` raises `NoMethodError: undefined method '+' for nil` on boot ([probe-8.1.0-raw log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-raw/test.log)). Setting `allowed_tags` without including `[ActionText::Attachment.tag_name, "figure", "figcaption"]` would strip rich-text attachments on render.
   - **Works on `7.0.8.7`:** Yes.
   - **Recommendation:** Replace [config/initializers/action_text.rb](file:///home/user/workspace/repo/config/initializers/action_text.rb#L1-L3) with:
     ```ruby
     default_allowed_tags = ActionText::ContentHelper.allowed_tags ||
       (ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])
     ActionText::ContentHelper.allowed_tags = default_allowed_tags + %w[ details summary ]
     ```
   - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:107` (verifies `<figure class="attachment">` is kept) and `test/controllers/notes_controller_test.rb:137` (verifies `<details><summary>` is kept and `<script>`/`onclick`/`javascript:` are stripped).

3. **R3 — Keyword-argument `enum` syntax removed in Rails 8.0**
   - **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10).
   - **Applicability & Evidence (Source + Executed):** `enum status: { draft: 0, ready: 1 }, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)` in `activerecord-8.1.0/lib/active_record/enum.rb:217` ([probe-8.1.0-step1 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step1/test.log)). ([Citation](file:///home/user/workspace/repo/app/models/citation.rb#L7) and [Export](file:///home/user/workspace/repo/app/models/export.rb#L10) already use positional syntax.)
   - **Works on `7.0.8.7`:** Yes.
   - **Recommendation:** Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L10) to:
     ```ruby
     enum :status, { draft: 0, ready: 1 }, prefix: true
     ```
   - **Discriminating validation:** `bin/rails zeitwerk:check` and `bin/rails test test/controllers/notes_controller_test.rb:27`.

4. **R4 — `alias_attribute` on `store_accessor` (`:color`) removed in Rails 7.2**
   - **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L13-L14).
   - **Applicability & Evidence (Source + Executed):** `color` is defined via `store_accessor :settings, :color`, not as a schema column/attribute. Rails 7.2+ raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually` ([probe-8.1.0-step2 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step2/test.log)).
   - **Works on `7.0.8.7`:** Yes.
   - **Recommendation:** Replace `alias_attribute :highlight_color, :color` in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L14) with:
     ```ruby
     alias_method :highlight_color, :color
     alias_method :highlight_color=, :color=
     ```
   - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:107` and `test/controllers/notes_controller_test.rb:151`.

5. **R5 — Multiple paths in `get "/notes", "/journal"` removed in Rails 8.1**
   - **Affected code:** [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18).
   - **Applicability & Evidence (Source + Executed):** `actionpack-8.1.0/lib/action_dispatch/routing/mapper.rb:1854` raises `ArgumentError: Wrong number of arguments (expect 1, got 2)` when `get` / `match` receives more than one path ([probe-8.1.0-step2 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step2/test.log)).
   - **Works on `7.0.8.7`:** Yes.
   - **Recommendation:** Split [config/routes.rb](file:///home/user/workspace/repo/config/routes.rb#L18) into two route declarations:
     ```ruby
     get "/notes", to: "notes#index"
     get "/journal", to: "notes#index"
     ```
   - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:6` (checks both `notes_path` and `journal_path`).

6. **R6 — `form_with(model: nil, ...)` raises `ArgumentError` in Rails 8.1**
   - **Affected code:** [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12).
   - **Applicability & Evidence (Source + Executed):** `actionview-8.1.0/lib/action_view/helpers/form_helper.rb:756` raises `ArgumentError: Passed nil to the :model argument, expect an object or false` when `model: nil` is passed ([probe-8.1.0-step3 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log)).
   - **Works on `7.0.8.7`:** Yes.
   - **Recommendation:** Omit `model: nil` in [app/views/notes/index.html.erb](file:///home/user/workspace/repo/app/views/notes/index.html.erb#L12):
     ```erb
     <%= form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>
     ```
   - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:17`.

7. **R7 — `HashWithIndifferentAccess#stringify_keys` now stringifies `Integer` keys (Rails 7.1+)**
   - **Affected code:** [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22), [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L38-L42).
   - **Applicability & Evidence (Source + Executed):** `Import#annotations` returns an `ActiveSupport::HashWithIndifferentAccess` keyed by `Integer` `row.line`. In Rails 7.0, `HashWithIndifferentAccess#stringify_keys` was overridden as `dup` (no-op), leaving integer keys intact. In Rails 7.1+/8.1, that override was removed so `stringify_keys` converts integer keys `2` → `"2"`. Because `HashWithIndifferentAccess#[]` only converts `Symbol` keys to `String` (not `Integer`), `annotations[row.line]` on [line 41 of preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L41) returns `nil` and silently drops all annotations from the preview page ([probe-8.1.0-step3 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log)).
   - **Works on `7.0.8.7`:** Yes.
   - **Recommendation:** Change [app/views/imports/preview.html.erb](file:///home/user/workspace/repo/app/views/imports/preview.html.erb#L22) from `<% annotations = @import.annotations.stringify_keys %>` to `<% annotations = @import.annotations %>`.
   - **Discriminating validation:** `bin/rails test test/controllers/imports_controller_test.rb:6` and `test/controllers/imports_controller_test.rb:48`.

8. **R8 — `Enumerable#sum` without an initial value on `Array<String>` raises `TypeError` (Rails 7.1+)**
   - **Affected code:** [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42).
   - **Applicability & Evidence (Source + Executed):** `fragments.sum` on an array of strings emitted a deprecation warning in Rails 7.0 ([baseline test.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/test.log)) and raises `TypeError: String can't be coerced into Integer` in Rails 7.1+/8.1 ([probe-8.1.0-step3 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log)).
   - **Works on `7.0.8.7`:** Yes (and silences the existing deprecation warning on `7.0.8.7`).
   - **Recommendation:** Change `finish(fragments.sum)` in [app/models/export.rb](file:///home/user/workspace/repo/app/models/export.rb#L42) to `finish(fragments.sum(""))` (or `finish(fragments.join)`).
   - **Discriminating validation:** `bin/rails test test/controllers/exports_controller_test.rb:9`.

9. **R9 — `ActiveJob::Core#set(wait_until:)` requires a `Time`/`DateTime` object instead of an `Integer` epoch (Rails 7.1+)**
   - **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61).
   - **Applicability & Evidence (Source + Executed):** In Rails 7.0, `set(wait_until:)` called `.to_f` immediately. In Rails 7.1+/8.1 (`activejob-8.1.0/lib/active_job/core.rb:130,177`), `set` stores `scheduled_at = options[:wait_until]` and `serialize` calls `scheduled_at.utc.iso8601(9)`, raising `NoMethodError: undefined method 'utc' for an instance of Integer` when `reminder_epoch` (`Integer`) is passed ([probe-8.1.0-step3 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log)).
   - **Works on `7.0.8.7`:** Yes (`reminder_at.to_f == reminder_epoch.to_f`).
   - **Recommendation:** Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L61) to:
     ```ruby
     job = NoteReminderJob.set(wait_until: reminder_at).perform_later(self)
     ```
   - **Discriminating validation:** `bin/rails test test/controllers/reminders_controller_test.rb`.

10. **R10 — `ActiveJob::Serializers::TimeWithZoneSerializer` preserves the reader's time zone on deserialization (Rails 7.1+)**
    - **Affected code:** [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L6-L10), [app/jobs/digest_job.rb](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L8), [app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L35-L41).
    - **Applicability & Evidence (Source + Executed):** In Rails 7.0, `TimeWithZoneSerializer#deserialize` called `Time.iso8601(hash["value"]).in_time_zone`, converting `requested_at` to the worker's `Time.zone` (UTC). In Rails 7.1+/8.1 (`activejob-8.1.0/lib/active_job/serializers/time_with_zone_serializer.rb:8-17`), it serializes `"time_zone"` and deserializes into the original zone (`Eastern Time (US & Canada)`). Near midnight UTC (e.g., `2026-10-05 03:30 UTC` = `2026-10-04 23:30 EDT`), `requested_at.to_date` and `requested_at.all_day` in `DigestMailer#daily_digest` evaluate to the local date (`2026-10-04`) instead of the UTC date (`2026-10-05`), breaking the UTC-day digest contract and diverging from the `digest_requests:YYYY-MM-DD` Redis key ([probe-8.1.0-step3 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log)).
    - **Works on `7.0.8.7`:** Yes.
    - **Recommendation:** Explicitly convert `requested_at = requested_at.utc` in [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L7-L9) before calling `.to_date` and `.all_day`, and update the comments in [app/jobs/digest_job.rb](file:///home/user/workspace/repo/app/jobs/digest_job.rb#L4-L5), [app/mailers/digest_mailer.rb](file:///home/user/workspace/repo/app/mailers/digest_mailer.rb#L2-L5), [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L169-L173), and [TESTING.md](file:///home/user/workspace/repo/TESTING.md#L150-L153).
    - **Discriminating validation:** `bin/rails test test/controllers/digests_controller_test.rb:5`.

11. **R11 — `@notes.where(notebooks: @notebook)` plural association key lookup removed in Rails 7.2**
    - **Affected code:** [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12).
    - **Applicability & Evidence (Source + Executed):** `Note` defines `belongs_to :notebook` (singular). In Rails 7.0, `TableMetadata#associated_with?` fell back to `table_name.singularize`. In Rails 7.2+/8.1 (`activerecord-8.1.0/lib/active_record/table_metadata.rb:22-24`), `associated_with` only checks the exact association name (`:notebook`), so `@notes.where(notebooks: @notebook)` treats `notebooks` as a column on `notes` and fails with `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist` ([probe-8.1.0-step4 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step4/test.log)).
    - **Works on `7.0.8.7`:** Yes.
    - **Recommendation:** Change [app/controllers/notes_controller.rb](file:///home/user/workspace/repo/app/controllers/notes_controller.rb#L12) to `@notes = @notes.where(notebook: @notebook)`.
    - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:27` and `test/controllers/notes_controller_test.rb:48`.

12. **R12 — Non-local `return` inside `Import#apply` `transaction` block now commits instead of rolling back (Rails 7.1+) & `citation[:id]` no longer aliases custom `primary_key = "doi"` (Rails 7.2+)**
    - **Affected code:** [app/models/import.rb](file:///home/user/workspace/repo/app/models/import.rb#L50-L71).
    - **Applicability & Evidence (Source + Executed):**
      - In `Import#apply` ([lines 53-58](file:///home/user/workspace/repo/app/models/import.rb#L53-L58)), `return false unless row.note.save` executes a non-local `return` out of `transaction do ... end`. In Rails 7.1+/8.1, non-local returns inside `transaction` **commit** the transaction instead of rolling it back, persisting the `Import` and any preceding valid rows when a subsequent row is invalid ([probe-8.1.0-step4 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step4/test.log)).
      - In `Import#receipt` ([line 68](file:///home/user/workspace/repo/app/models/import.rb#L68)), `citation[:id]` calls `read_attribute(:id)`. Rails 7.2+ removed the `name = @primary_key if name == "id"` alias in `read_attribute` (`activerecord-8.1.0/lib/active_record/attribute_methods/read.rb:29-34`), so `citation[:id]` returns `nil` for `Citation` (`primary_key = "doi"`), producing blank DOIs in exported receipt CSVs ([probe-8.1.0-step4 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step4/test.log)).
    - **Works on `7.0.8.7`:** Yes.
    - **Recommendation:** Raise `ActiveRecord::Rollback` on row save failure in `Import#apply`, and use `citation&.doi` in `Import#receipt`:
      ```ruby
      def apply
        return false if invalid?

        applied = false
        transaction do
          save!
          if rows.all? { |row| row.note.save }
            applied = true
          else
            raise ActiveRecord::Rollback
          end
        end

        applied
      end

      def receipt
        CSV.generate do |csv|
          csv << %w[ title doi ]
          notes.includes(:citation).order(:id).each do |note|
            csv << [ note.title, note.citation&.doi ]
          end
        end
      end
      ```
    - **Discriminating validation:** `bin/rails test test/controllers/imports_controller_test.rb:6` (receipt CSV DOIs) and `test/controllers/imports_controller_test.rb:48` (partial batch rollback).

13. **R13 — `ActiveSupport::TimeWithZone#to_time` attaches `time_zone` instead of fixed `utc_offset` across DST in `Note#next_day_reminder_at` (Rails 8.0+)**
    - **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L40-L45), [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L20-L21).
    - **Applicability & Evidence (Source + Executed):** In Rails 7.0, `TimeWithZone#to_time` called `getlocal(utc_offset)` (fixed numeric offset `-04:00`), so `reminder_at.to_time + 86_400` across DST end returned `"2026-11-01T09:00:00-04:00"`. In Rails 8.0+/8.1 (`activesupport-8.1.0/lib/active_support/time_with_zone.rb:497-499`), `TimeWithZone#to_time` unconditionally calls `getlocal(time_zone)`, so `+ 86_400` adjusts for the DST transition and returns `"2026-11-01T08:00:00-05:00"`, failing [reminders_controller_test.rb:21](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21) ([probe-8.1.0-step4 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step4/test.log)).
    - **Works on `7.0.8.7`:** Yes (if preserving fixed offset via `getlocal(reminder_at.utc_offset)`).
    - **Recommendation:**
      - To preserve the current documented contract ([ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156)) and test assertion, change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44) to `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`.
      - Alternatively, if adopting Rails 8.1's timezone-aware `Time#to_time` behavior, keep `reminder_at.to_time + 86_400` and update [test/controllers/reminders_controller_test.rb](file:///home/user/workspace/repo/test/controllers/reminders_controller_test.rb#L21) (`"2026-11-01T08:00:00-05:00"`), the comment in [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L40-L43), and [ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L153-L156).
    - **Discriminating validation:** `bin/rails test test/controllers/reminders_controller_test.rb:6`.

14. **R14 — `Rails.application.secrets` removed in Rails 7.2**
    - **Affected code:** [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13), [config/secrets.yml](file:///home/user/workspace/repo/config/secrets.yml#L1-L18), [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45).
    - **Applicability & Evidence (Source + Executed):** `Rails.application.secrets` was removed in Rails 7.2, raising `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application:...>` ([probe-8.1.0-step4 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step4/test.log)).
    - **Works on `7.0.8.7`:** Yes (`Rails.application.config_for(:secrets)` works on both `7.0.8.7` and `8.1.0`).
    - **Recommendation:** Add `config.citation_provider = config_for(:secrets).citation_provider` to [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L24), and replace `Rails.application.secrets.citation_provider` with `Rails.application.config.citation_provider` in [app/models/citation/provider.rb](file:///home/user/workspace/repo/app/models/citation/provider.rb#L13) and [test/controllers/citation_enrichments_controller_test.rb](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L45) ([lines 117-122](file:///home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb#L117-L122)).
    - **Discriminating validation:** `bin/rails test test/controllers/citation_enrichments_controller_test.rb`.

---

#### Phase B — Lockstep Changes Required with the `rails` `8.1.0` Gem Bump (Incompatible with `7.0.8.7`)

These changes **must not** be deployed while running `7.0.8.7`; apply them in the same commit that bumps `rails` to `8.1.0`:

15. **R15 — `serialize :tags, JSON` positional coder argument removed in Rails 7.2**
    - **Affected code:** [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) (and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) when adopting `load_defaults 7.1+`).
    - **Applicability & Evidence (Source + Executed):** `activerecord-8.1.0/lib/active_record/attribute_methods/serialization.rb:193` defines `def serialize(attr_name, coder: nil, type: Object, comparable: false, yaml: {}, **options)`. Positional `serialize :tags, JSON` raises `ArgumentError: wrong number of arguments (given 2, expected 1)` on `8.1.0`.
    - **Works on `7.0.8.7`:** **No.** On `7.0.8.7` (`serialization.rb:103`), `serialize :tags, coder: JSON` leaves positional `class_name_or_coder = Object` and passes `coder: JSON` as an ignored option to `attribute`, silently switching `Note#tags` from `Coders::JSON` to `Coders::YAMLColumn` and writing YAML into `notes.tags`.
    - **Recommendation:** Change [app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L12) to `serialize :tags, coder: JSON` (and [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) to `serialize :preferences, coder: YAML`) in the `rails 8.1.0` upgrade commit.
    - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:107` and `test/controllers/notebooks_controller_test.rb:22`.

16. **R16 — `config.action_dispatch.show_exceptions = false` treated as `:all` instead of `:none` in Rails 7.2+**
    - **Affected code:** [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31).
    - **Applicability & Evidence (Source + Executed):** In `actionpack-8.1.0/lib/action_dispatch/middleware/exception_wrapper.rb:190-197`, `ExceptionWrapper#show?` matches `when :none` → `false`, `when :rescuable` → `rescue_response?`, `else` → `true`. When `config.action_dispatch.show_exceptions = false`, it hits `else` (`true`), swallowing `ActiveRecord::RecordNotFound` and `Redis::CannotConnectError` in integration tests ([probe-8.1.0-step3 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log)).
    - **Works on `7.0.8.7`:** **No.** On `7.0.8.7`, `request.show_exceptions?` checks `get_header("action_dispatch.show_exceptions") != false`; `:none != false` is `true`, which swallows exceptions on `7.0.8.7`.
    - **Recommendation:** Change [config/environments/test.rb](file:///home/user/workspace/repo/config/environments/test.rb#L31) to `config.action_dispatch.show_exceptions = :none` in the `rails 8.1.0` upgrade commit.
    - **Discriminating validation:** `bin/rails test test/controllers/notes_controller_test.rb:174` and `test/controllers/digests_controller_test.rb:45`.

17. **R17 — `retry_on ..., wait: :exponentially_longer` removed in Rails 7.2**
    - **Affected code:** [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7).
    - **Applicability & Evidence (Source + Executed):** `activejob-8.1.0/lib/active_job/exceptions.rb:174-189` removed `:exponentially_longer` in favor of `:polynomially_longer`, raising `RuntimeError: Couldn't determine a delay based on :exponentially_longer` when `Citation::Provider::Unavailable` is rescued ([probe-8.1.0-step5 failure log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step5/test.log)).
    - **Works on `7.0.8.7`:** **No.** `:polynomially_longer` was added in Rails 7.1 and raises `RuntimeError` on `7.0.8.7`.
    - **Recommendation:** Change `wait: :exponentially_longer` to `wait: :polynomially_longer` in [app/jobs/citation_enrichment_job.rb](file:///home/user/workspace/repo/app/jobs/citation_enrichment_job.rb#L7) in the `rails 8.1.0` upgrade commit.
    - **Discriminating validation:** `bin/rails test test/controllers/citation_enrichments_controller_test.rb:60`.

---

### 3. Optional Framework Default Adoption (`config.load_defaults 7.0` → `8.1`)

Advancing [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12) from `config.load_defaults 7.0` to `config.load_defaults 8.1` activates four defaults from `7.1`/`7.2` that directly impact Margin Notes (tested in [`.amp/in/experiments/probe-8.1.0-defaults81`](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81/test.log) and [`.amp/in/experiments/probe-8.1.0-defaults81-step2`](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step2/test.log)):

1. **D1 — `config.active_record.default_column_serializer = nil` (Rails 7.1 default)**
   - **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) (`serialize :preferences`).
   - **Impact:** Raises `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to serialize.` on boot ([probe-8.1.0-defaults81 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81/zeitwerk.log)).
   - **Recommendation:** Change to `serialize :preferences, coder: YAML` in [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L7) (lockstep with `8.1.0`).

2. **D2 — `config.active_support.raise_on_invalid_cache_expiration_time = true` (Rails 7.1 default)**
   - **Affected code:** [app/views/exports/_export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26).
   - **Impact:** `<% cache [export, "availability"], expires_in: export.expires_at - Time.current do %>` passes a negative `expires_in` whenever a completed export is past its 24-hour expiration, raising `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative` whenever caching is enabled ([probe-8.1.0-defaults81-step2 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step2/test.log)).
   - **Recommendation:** Change [line 26 of _export.html.erb](file:///home/user/workspace/repo/app/views/exports/_export.html.erb#L26) to `expires_in: (export.expires_at - Time.current if export.downloadable?)` (compatible with `7.0.8.7`).
   - **Discriminating validation:** `bin/rails test test/controllers/exports_controller_test.rb:59`.

3. **D3 — `config.active_record.postgresql_adapter_decode_dates = true` (Rails 7.2 default)**
   - **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L38-L41) (`Notebook#daily_note_counts`).
   - **Impact:** `Note.connection.select_rows(days)` decodes PostgreSQL `DATE(notes.created_at)` columns directly into `Date` instances instead of ISO 8601 `String`s, causing `Date.iso8601(day)` to raise `TypeError: no implicit conversion of Date into String` ([probe-8.1.0-defaults81-step2 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step2/test.log)).
   - **Recommendation:** Change [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L40) to `Note.connection.select_rows(days).map { |day, count| [day.is_a?(Date) ? day : Date.iso8601(day), count] }` (works under both `7.0` and `8.1` defaults).
   - **Discriminating validation:** `bin/rails test test/controllers/activity_reports_controller_test.rb:8`.

4. **D4 — `config.active_record.raise_on_assign_to_attr_readonly = true` (Rails 7.1 default)**
   - **Affected code:** [app/models/notebook.rb](file:///home/user/workspace/repo/app/models/notebook.rb#L8) (`attr_readonly :slug`), [app/views/notebooks/_form.html.erb](file:///home/user/workspace/repo/app/views/notebooks/_form.html.erb#L13) (`<%= form.hidden_field :slug %>`), [app/controllers/notebooks_controller.rb](file:///home/user/workspace/repo/app/controllers/notebooks_controller.rb#L39-L41) (`permit(:name, :slug, :export_heading)`).
   - **Impact:** Raises `ActiveRecord::ReadonlyAttributeError: slug` on `NotebooksController#update` even when `slug` is resubmitted unchanged ([probe-8.1.0-defaults81-step2 log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step2/test.log)), conflicting with the documented contract ([ARCHITECTURE.md](file:///home/user/workspace/repo/ARCHITECTURE.md#L40-L43)) and [test/controllers/notebooks_controller_test.rb](file:///home/user/workspace/repo/test/controllers/notebooks_controller_test.rb#L29-L38).
   - **Recommendation:** Explicitly set `config.active_record.raise_on_assign_to_attr_readonly = false` in [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L13) when adopting `config.load_defaults 8.1` (unless the application contract and test are intentionally changed to stop submitting/permitting `:slug` on update).

---

### 4. Stored Data, Queued Work, Mixed-Version Rollout, and Rollback Risks

1. **M1 — Persisted Action Text `attachable_sgid` and Active Storage `signed_id` under `config.active_support.use_message_serializer_for_metadata = true` (`load_defaults 7.1+`)**
   - **Evidence (Executed in [token_rollback_test.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/token_rollback_test.log)):**
     - `ActionText::RichText` persists `<action-text-attachment sgid="...">` in PostgreSQL (`action_text_rich_texts.body`).
     - Under `config.load_defaults 7.0`, Rails `8.1.0` and `7.0.8.7` both encode message verifier metadata with `{"_rails":{"message":"<Base64(Marshal)>",...}}` and are bidirectionally compatible (`7.0 <-> 8.1`).
     - Under `config.load_defaults 7.1+` / `8.1`, `config.active_support.use_message_serializer_for_metadata = true` encodes metadata with `{"_rails":{"data":...}}` (no `"message"` key). While Rails `8.1.0` can read `7.0.8.7` tokens, Rails `7.0.8.7` crashes with **`NoMethodError: undefined method 'unpack1' for nil`** (`Base64.strict_decode64(nil)`) when reading any `sgid` (stored in `action_text_rich_texts.body`) or `signed_id` generated with `use_message_serializer_for_metadata = true`.
   - **Rollout/Rollback Recommendation:** Keep `config.active_support.use_message_serializer_for_metadata = false` (or stay on `config.load_defaults 7.0` during initial rollout) until mixed-version deployment is complete and rollback to `7.0.8.7` is no longer needed.

2. **M2 — Development/Test `secret_key_base` file path change (`tmp/development_secret.txt` → `tmp/local_secret.txt`)**
   - **Evidence (Source + Executed in [cross_version_81.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/cross_version_81.log)):**
     - When `ENV["SECRET_KEY_BASE"]` and `credentials.secret_key_base` are unset in `development`/`test`, Rails `7.0.8.7` stores the generated secret in `tmp/development_secret.txt` (`railties-7.0.8.7/lib/rails/application.rb:583`), whereas Rails `8.1.0` uses `tmp/local_secret.txt` (`railties-8.1.0/lib/rails/application/configuration.rb:657`).
     - Without copying `tmp/development_secret.txt` to `tmp/local_secret.txt`, existing development sessions and any rich-text attachment `sgid`s stored in `margin_notes_development` become unverifiable after upgrading.
   - **Recommendation:** In development environments with existing rich-text attachments, copy `tmp/development_secret.txt` to `tmp/local_secret.txt` during upgrade (and back on rollback).

3. **M3 — Queued `DigestJob` `BigDecimal` argument serialization (`BigDecimalSerializer`)**
   - **Evidence (Executed in [aj_compare_70.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/aj_compare_70.log) and [aj_compare_81.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/aj_compare_81.log)):**
     - `User#request_digest` ([app/models/user.rb](file:///home/user/workspace/repo/app/models/user.rb#L41)) passes `reading_completion` (`BigDecimal`) to `DigestJob.perform_later`.
     - **Forward (`7.0` enqueuer → `8.1` worker):** Rails `7.0.8.7` serializes `BigDecimal` as a JSON string `"0.5"` in Sidekiq; Rails `8.1.0` deserializes it as `"0.5"` and `DigestMailer#daily_digest` (`BigDecimal(params[:completion])`) succeeds.
     - **Reverse (`8.1` enqueuer → `7.0` worker):** Rails `8.1.0` serializes `BigDecimal` with `{"_aj_serialized": "ActiveJob::Serializers::BigDecimalSerializer", "value": "0.5"}` (which also eliminates Sidekiq's non-native JSON warning on `DigestJob`). A Rails `7.0.8.7` worker fails to deserialize this payload with `ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
     - `NoteReminderJob`, `CitationEnrichmentJob`, and native Sidekiq `ExportJob` payloads are bidirectionally compatible (`7.0 <-> 8.1`).
   - **Rollout/Rollback Recommendation:** Upgrade Sidekiq workers to `8.1.0` before or simultaneously with web processes, and drain the `default` queue before rolling back to `7.0.8.7`.

4. **M4 — Cache format (`cache_format_version`) and Schema dump (`ActiveRecord::Schema[8.1]`)**
   - **Evidence (Source + Executed in [schema.diff](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/schema.diff)):**
     - `load_defaults 7.1+` sets `config.active_support.cache_format_version = 7.1`. Rails `8.1` reads `7.0` cache entries, but Rails `7.0` cannot read `7.1` cache entries. Keep `config.active_support.cache_format_version = 7.0` until rollback to `7.0.8.7` is no longer needed.
     - Running migrations in Rails `8.1.0` dumps `ActiveRecord::Schema[8.1].define` and `enable_extension "pg_catalog.plpgsql"` in [db/schema.rb](file:///home/user/workspace/repo/db/schema.rb#L13-L15), which Rails `7.0.8.7` rejects (`Unknown migration version "8.1"`).
     - `ActiveStorage::Blob` checksums remain Base64 MD5 (`"XrY7u+Ae7tCTyyK7j1rNww=="`) in both `7.0.8.7` and `8.1.0`, and no new Active Storage or Action Text database migrations are required.

5. **M5 — Built-in Active Job `:sidekiq` adapter deprecation in Rails 8.1**
   - **Evidence (Source + Executed in [log/development.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/log/development.log)):**
     - `activejob-8.1.0/lib/active_job/queue_adapters/sidekiq_adapter.rb:33-38` logs `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later to use the 'sidekiq' gem's adapter` when `config.active_job.queue_adapter = :sidekiq` is loaded with `sidekiq 6.5.12`.
     - Do not set `config.active_support.disallowed_deprecation_warnings = :all` while `sidekiq` remains on `6.5.12`.
     - Note also that `ApplicationJob.enqueue_after_transaction_commit` defaults to `false` in Rails `8.1.0` and **must remain `false`** because `Citation#request_enrichment` ([app/models/citation.rb](file:///home/user/workspace/repo/app/models/citation.rb#L14-L24)) and `Note#schedule_reminder` ([app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L56-L69)) rely on synchronous Redis enqueueing inside `with_lock` to roll back database state if Redis refuses the job.

---

### 5. Recommended Rollout Sequence

1. **Step 1 (Preparatory PR on Rails `7.0.8.7`):**
   - Apply **R1–R14**, **D2**, and **D3** while keeping `gem "rails", "7.0.8.7"`.
   - Verify with `bin/rails zeitwerk:check` and `REDIS_URL=redis://localhost:6379/1 bin/rails test`.
2. **Step 2 (Rails `8.1.0` Upgrade PR with `config.load_defaults 7.0`):**
   - Bump `gem "rails", "8.1.0"` in [Gemfile](file:///home/user/workspace/repo/Gemfile#L7), apply lockstep changes **R15–R17** and **D1** (`serialize :preferences, coder: YAML`), and copy `tmp/development_secret.txt` to `tmp/local_secret.txt` in local development.
   - Deploy workers before or together with web processes.
3. **Step 3 (Post-Rollout `config.load_defaults 8.1` Adoption PR):**
   - Once rollback to `7.0.8.7` is no longer needed, switch [config/application.rb](file:///home/user/workspace/repo/config/application.rb#L12) to `config.load_defaults 8.1` with `config.active_record.raise_on_assign_to_attr_readonly = false` (**D4**), and update [db/schema.rb](file:///home/user/workspace/repo/db/schema.rb#L13).

---

### 6. Executed Experiments & Retained Artifacts

All experiments were executed in isolated copies under `.amp/in/experiments/` using dedicated PostgreSQL databases (`margin_notes_exp_70_*`, `margin_notes_exp_81_*`), dedicated Redis databases (`10` and `11`), and an isolated `GEM_HOME` ([`.amp/in/experiments/gems`](file:///home/user/workspace/repo/.amp/in/experiments/gems)). The working repository was not modified.

| Variant | Configuration & Key Changes | Executed Commands | Result | Retained Artifacts |
| --- | --- | --- | --- | --- |
| **Baseline `7.0.8.7`** | Unmodified app on `rails 7.0.8.7`, isolated DB `margin_notes_exp_70_test`, `REDIS_URL=.../10` | `bin/rails db:prepare`, `bin/rails zeitwerk:check`, `bin/rails test` | 46 runs, 325 assertions, 0 failures, 0 errors (emits `Enumerable.sum` deprecation) | [dir](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7), [test.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/test.log), [zeitwerk.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/zeitwerk.log) |
| **Prep on `7.0.8.7`** | `rails 7.0.8.7` + all Phase A preparatory changes (**R1–R14, D2, D3**) | `bundle lock`, `bin/rails zeitwerk:check`, `bin/rails test` | 46 runs, 325 assertions, 0 failures, 0 errors (0 Rails deprecations) | [dir](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7), [test.log](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/test.log), [zeitwerk.log](file:///home/user/workspace/repo/.amp/in/experiments/prep-on-7.0.8.7/zeitwerk.log) |
| **Probe `8.1.0` Raw** | `rails 8.1.0` (`json 3.1.0`), unmodified app code (`load_defaults 7.0`) | `bundle lock --update rails`, `bin/rails db:prepare`, `bin/rails zeitwerk:check`, `bin/rails test` | Fails on boot in `config/initializers/action_text.rb:3` (**R2**) | [dir](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-raw), [lockfile.diff](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-raw/lockfile.diff), [test.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-raw/test.log) |
| **Probe `8.1.0` Step 1–4** | Progressive isolation of **R1–R16** on `rails 8.1.0` (`load_defaults 7.0`) | `bin/rails zeitwerk:check`, `bin/rails test` | Isolates `Note` enum/serialize/alias (**R3, R4, R15**), `json 3.1.0` (**R1**), routes (**R5**), `show_exceptions` (**R16**), `form_with` (**R6**), `stringify_keys` (**R7**), `fragments.sum` (**R8**), `wait_until` (**R9**), `TimeWithZoneSerializer` (**R10**), `where(notebooks:)` (**R11**), `Import` (**R12**), `to_time` (**R13**), `secrets` (**R14**) | [step1](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step1/test.log), [step2](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step2/test.log), [step3](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step3/test.log), [step4](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step4/test.log) |
| **Probe `8.1.0` Step 5 (`load_defaults 7.0`)** | `rails 8.1.0`, `load_defaults 7.0`, all **R1–R17** applied | `bin/rails zeitwerk:check`, `bin/rails test` | 46 runs, 340 assertions, 0 failures, 0 errors | [dir](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step5), [test.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step5/test.log), [zeitwerk.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-step5/zeitwerk.log) |
| **Probe `8.1.0` (`load_defaults 8.1`)** | `rails 8.1.0`, `load_defaults 8.1` (**D1–D4** isolated and resolved) | `bin/rails zeitwerk:check`, `bin/rails test`, `bin/rails db:migrate:reset db:seed`, `RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile` | 46 runs, 340 assertions, 0 failures, 0 errors; migrations, seeds, `development`/`test`/`production` boot, and asset precompilation succeed | [defaults81](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81/test.log), [defaults81-step2](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step2/test.log), [defaults81-step3](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/test.log), [aj_compare_81.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/aj_compare_81.log), [token_rollback_test.log](file:///home/user/workspace/repo/.amp/in/experiments/baseline-7.0.8.7/token_rollback_test.log), [assets_precompile.log](file:///home/user/workspace/repo/.amp/in/experiments/probe-8.1.0-defaults81-step3/assets_precompile.log) |

---

### 7. Unverified Claims & Remaining Questions

- **Browser/System execution (`bin/rails test:system`):** The repository currently has no system test files (`test/system/` contains only `.keep`), and [test/application_system_test_case.rb](file:///home/user/workspace/repo/test/application_system_test_case.rb#L4) configures non-headless Chrome. Interactive Trix attachment uploads in a real browser with `actiontext 8.1.0` + vendored `trix-1.3.5.js` were verified at the JavaScript source and asset-precompilation levels, not via a live browser session.
- **Open product decisions:**
  1. In `Note#next_day_reminder_at` ([app/models/note.rb](file:///home/user/workspace/repo/app/models/note.rb#L44), **R13**), should the reminder postponement preview keep the fixed UTC offset (`reminder_at.getlocal(reminder_at.utc_offset) + 86_400`) to preserve the existing test and documented quirk, or adopt Rails `8.1`'s DST-aware `reminder_at.to_time + 86_400` and update the test and documentation?
  2. When adopting `config.load_defaults 8.1` (**D4**), should `config.active_record.raise_on_assign_to_attr_readonly = false` be kept so `NotebooksController#update` continues to accept and ignore resubmitted `:slug` parameters, or should `:slug` be removed from `NotebooksController#notebook_params` and the edit form?

---

Per the `maintain-rails:upgrade-gem` workflow, the working application has not been modified. Let me know which Step (Step 1 preparatory changes on `7.0.8.7`, Step 2 upgrade to `8.1.0`, or full adoption including `load_defaults 8.1`) and which option for the two product decisions above you would like me to implement.