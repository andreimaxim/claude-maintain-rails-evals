## Verdict

Upgrading to Rails 8.1.0 is not a version bump for this app. With the current `config.load_defaults 7.0`, the app does not boot on 8.1.0 until about 19 code changes land (R1–R19 below). The same repairs pass the full suite on 7.0.8.7, so most of them can ship before the gem bump. Each optional default adds its own fixes, and three of them break the suite at `load_defaults 7.1`/`7.2`. Two rollout hazards need controls before any deploy: BigDecimal job payloads, and the 7.1 cache and signed-value formats.

The request names 8.1.0, but 8.1.4 is the latest patch. In the 8.1.0–8.1.3 source, `ActiveSupport::JSON.decode` passes its options hash positionally to `json`, and `json` 3.x rejects that. 8.1.4 fixes it, and the repaired suite passes on 8.1.4 with `json` 3.1.0. I recommend 8.1.4 unless 8.1.0 is required.

## What was run

- **Working repo:** untouched. `git status` is clean and HEAD is `ab732f5`.
- **Summary:** `gem-changes rails 7.0.8.7 8.1.0` wrote `/tmp/rails-upgrade/gem-changes.txt` (1360 lines, 1579 changelog entries).
- **Disposable clones of the repo:**
  - `/tmp/rails-upgrade/base70` is the pristine 7.0.8.7 reference.
  - `/tmp/rails-upgrade/prep70` is 7.0.8.7 with the 7.0-safe repairs.
  - `/tmp/rails-upgrade/copy` is 8.1.0 with the repairs. `EXP_LOAD_DEFAULTS` selects the `load_defaults` level.
  - `/tmp/rails-upgrade/copy814` is 8.1.4 with the repairs.
- **Isolation:** Postgres databases `margin_notes_upgrade_test` and `margin_notes_upgrade_dev`. A dedicated `redis-server` on port 6390, stopped at the end. A loopback citation stub on port 9393, outside the bundle. Test cache is `null_store`. Files and mail are under each clone's `tmp/`.
- **Resolved dependencies (8.1.0 copy):** Rails family 8.1.0; `json` 2.21.2 (pinned `< 3`); `sidekiq` 6.5.12; `redis` 4.8.1; `faraday` 1.10.4; `pagy` 8.6.3; `rack` 2.2.24; `rails-dom-testing` 2.3.0; `minitest` 5.27.0. Lock diff: `/tmp/rails-upgrade/logs/lock-diff-7.0-to-8.1.txt`.
- **Test totals:**
  - Baseline 7.0.8.7: 46 runs, 325 assertions, 0 failures.
  - 8.1.0 with repairs at 7.0 defaults: 46 runs, 340 assertions, 0 failures.
  - 7.0 clone with the 7.0-safe set: 46 runs, 325 assertions, 0 failures.
  - 8.1.4 with repairs at 7.0 and 8.1 defaults, `json` 3.1.0: 46 runs, 340 assertions, 0 failures each.

Tags below: **[executed]** means an experiment or suite run showed it. **[source]** means read from the installed gem source only.

## Required changes for 8.1.0 (any `load_defaults`)

For each item, the first line is the break, observed on the unrepaired 8.1.0 copy. Then the repair, whether it also works on 7.0.8.7, and the check.

**Boot and load-time**

1. **R1 `config/initializers/action_text.rb:3`** [executed]
   - Break: `NoMethodError: undefined method '+' for nil`. The `allowed_tags` default is nil in 8.1.
   - Repair: build the full list explicitly from the sanitizer's tags plus `details` and `summary`. The result matches the 7.0 list exactly.
   - Works on 7.0: yes.
   - Check: boot fails before the repair. Control: the tag list equals the 7.0 list.

2. **R2 `app/models/note.rb:10`** [executed]
   - Break: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. The legacy `enum status: {...}, _prefix: true` form is removed.
   - Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`.
   - Works on 7.0: yes.
   - Check: every test fails at load before the repair.

3. **R3 `app/models/note.rb:12`** [executed]
   - Break: `ArgumentError: wrong number of arguments (given 2, expected 1)`. The positional coder in `serialize :tags, JSON` is removed.
   - Repair: declare the attribute directly, so the same line works on 7.0 and 8.1:
     ```ruby
     module TagsJSON
       def self.dump(tags) = ...  # ActiveSupport::JSON.encode(tags), written as a normal def
       def self.load(json) = ...  # ActiveSupport::JSON.decode(json) unless json.blank?
     end
     attribute :tags, ActiveRecord::Type::Serialized.new(ActiveRecord::Type::Text.new, TagsJSON)
     ```
   - Rejected: `serialize :tags, coder: JSON` works on 8.1, but on 7.0 the keyword is ignored. It then writes YAML (`"---\n- a\n- b\n"`), and a legacy JSON row loads as a String, which breaks `tag_list`. This was executed in the 7.0 clone.
   - Works on 7.0: yes. Stored bytes match the original (`["a","b \u003cx\u003e"]`) on both versions.
   - Check: `tags_probe.rb` reads the legacy row and the in-place append back on each version.

4. **R4 `app/models/note.rb:14`** [executed]
   - Break: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
   - Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
   - Works on 7.0: yes.
   - Check: `notes_controller_test` "edits a note's rich body, tags, highlight, and status" fails before the repair.

5. **R5 `config/routes.rb:18`** [executed]
   - Break: `ArgumentError: Wrong number of arguments (expect 1, got 2)`. The two-path `get` is rejected, and `notes_path` disappears.
   - Repair: separate `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`.
   - Works on 7.0: yes.
   - Check: the list-path tests fail before the repair.

6. **R6 `app/models/citation/provider.rb:13` and test references** [executed]
   - Break: `NoMethodError: undefined method 'secrets' for MarginNotes::Application`. `Rails.application.secrets` is gone in 8.1, and the citation tests mutate it.
   - Repair: a new `config/initializers/citation_provider.rb` sets `Rails.application.config.x.citation_provider = Rails.application.config_for(:secrets).citation_provider.to_h`. The provider default and the test code read `config.x` instead.
   - Works on 7.0: yes.
   - Check: "provider credentials from the environment reach the server unchanged" fails before the repair.

7. **R7 Gemfile / `json`** [executed, plus source]
   - Break: `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291`, from `ActiveRecord::Coders::JSON#load`. Every non-blank JSON-coded read fails: the tags column in this app, and likely ActiveStorage metadata (source only, not run).
   - Repair for 8.1.0: `gem "json", "< 3"`. Use 8.1.4 instead, where the fix is in place.
   - Works on 7.0: harmless (7.0 already uses `json` 2.x).
   - Check: `note_test` "newest first breaks created_at ties" fails before the repair.

**Behavior and data changes**

8. **R8 `app/models/export.rb:42`** [executed]
   - Break: `TypeError: String can't be coerced into Integer`. ActiveSupport 7.1 removed the `Enumerable#sum` override that let strings sum.
   - Repair: `finish(fragments.join)`.
   - Works on 7.0: yes.
   - Check: the export tests fail before the repair.

9. **R9 `app/views/notes/index.html.erb:12`** [executed]
   - Break: `ArgumentError: Passed nil to the :model argument, expect an object or false`. The notes list returns 500.
   - Repair: `form_with(model: false, ...)`.
   - Works on 7.0: yes.
   - Check: "renders an unbound search form" and "lists the reader's notes at both list paths" fail before the repair.

10. **R10 `app/controllers/notes_controller.rb:12`** [executed]
    - Break: `column notes.notebooks does not exist`. The table-name key in `where(notebooks: ...)` no longer resolves.
    - Repair: `where(notebook: @notebook)`.
    - Works on 7.0: yes.
    - Check: "filters by notebook, status, and title" fails before the repair.

11. **R11 `app/jobs/citation_enrichment_job.rb:7`** [executed]
    - Break: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, on the retry path. The symbol was removed in 7.2.
    - Repair: `wait: :polynomially_longer`, the same formula on 8.x. The 7.0-compatible alternative is `wait: ->(executions) { executions**4 + 2 }`, which also works on 8.1 but drops the jitter.
    - Works on 7.0: the symbol no. The Proc form yes.
    - Check: "retrying one unavailable response" fails before the repair. Control: "fetches a manually entered DOI" passes either way.

12. **R12 `app/models/note.rb:61`** [executed]
    - Break: `NoMethodError: undefined method 'utc' for an instance of Integer`. ActiveJob 8.1 serializes `scheduled_at` with `.utc`.
    - Repair: `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`.
    - Works on 7.0: yes.
    - Check: "an imported reminder is scheduled at its exact time" fails before the repair. Control: the stored `reminder_epoch` is unchanged.

13. **R13 `config/environments/test.rb:31`** [executed]
    - Break: `show_exceptions = false` is no longer normalized, so tests get error pages instead of raised exceptions. Example: "RecordNotFound expected but nothing was raised".
    - Repair: `config.action_dispatch.show_exceptions = :none`.
    - Works on 7.0: no. On 7.0 the symbol is truthy and about four tests fail. This change must ship with the gem bump, not before.
    - Check: "another reader's notebook settings cannot be reached" fails before the repair. Production is unaffected, since it sets no value.

14. **R14 `app/models/import.rb` (`apply`)** [executed; and a plain-AR probe]
    - Break: an early `return` inside `transaction` now commits. The 8.x code always commits on a normal exit, and the `commit_transaction_on_non_local_return` config is removed. The probe showed `users_delta=0` on 7.0 and `users_delta=1` on 8.1.
    - Effect in this app: a CSV with an invalid row after the first valid one leaves the import row and earlier notes saved, while `apply` returns false.
    - Repair:
      ```ruby
      applied = false
      transaction do
        save!
        rows.each do |row|
          raise ActiveRecord::Rollback unless row.note.save
        end
        applied = true
      end
      applied
      ```
    - Works on 7.0: yes.
    - Check: "invalid rows are shown with their errors, and applying them saves nothing" fails with "`record_counts` changed". Control: "previews a CSV without saving, then imports every row" passes both ways.

15. **R15 `app/models/import.rb` (receipt)** [executed]
    - Break: `citation[:id]` returns nil. In 8.1, `read_attribute("id")` no longer maps to a custom primary key (`doi` here). The CSV's DOI column comes out blank.
    - Repair: `citation&.doi`.
    - Works on 7.0: yes.
    - Check: the receipt assertion in "previews a CSV…" fails before the repair.

16. **R16 `app/views/imports/preview.html.erb:22`** [executed]
    - Break: `HashWithIndifferentAccess#stringify_keys` stringifies integer keys (since ActiveSupport 8.0.0.rc1). The integer line lookup then returns nil, and the annotation rows disappear from the preview. Saved annotations are fine, because `apply` reads `row.annotation`.
    - Repair: `<% if row.annotation %>` and `<dd><%= row.annotation %></dd>`.
    - Works on 7.0: yes.
    - Check: the preview probe diffs against 7.0 (missing `dt Annotation`); the import test fails before the repair.

17. **R17 `app/jobs/digest_job.rb`** [executed]
    - Break: since 8.x the ActiveJob `TimeWithZone` serializer restores the reader's zone. The 7.0 serializer restored `Time.zone`, which is UTC for this app. The digest then reports a different date and a different set of notes. The test shows "October 04, 2026" where "October 05, 2026" is expected.
    - Repair: `requested_at = requested_at.in_time_zone` at the top of `perform`. This matches the 7.0 behavior.
    - Works on 7.0: yes (a no-op there).
    - Check: "a reader can request one digest per UTC day" fails before the repair. Control: the reservation assertions and the Redis tests pass.

18. **R18 `app/models/note.rb` (`next_day_reminder_at`)** [executed]
    - Break: in 8.x `TimeWithZone#to_time` always keeps the zone. The `to_time_preserves_timezone` setting is deprecated and ignored. On 7.0 this app got a fixed UTC offset, so the next-day reminder's `datetime` changes to a different offset around DST. The test expects `2026-11-01T09:00:00-04:00`.
    - Repair: `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. The epoch is unchanged either way.
    - Works on 7.0: yes.
    - Check: "a reader schedules a reminder in their time zone" fails before the repair. Control: the stored `reminder_epoch` and `sent_at` assertions pass.

19. **R19 `app/models/user.rb` (`request_digest`)** [executed, rollout]
    - Break: in 8.x, BigDecimal job arguments are serialized as `{"_aj_serialized"=>"ActiveJob::Serializers::BigDecimalSerializer","value"=>"0.5"}` regardless of `load_defaults`. A 7.0 worker raises `ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
    - Repair: `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The string payload matches what 7.0 wrote, and `DigestMailer` already parses it with `BigDecimal(...)`.
    - Works on 7.0: yes. The 7.0 clone passes 46 of 46 with it.
    - Check: an 8.1-enqueued digest run by a 7.0 worker fails before the repair and delivers the mail after it. Zero worker errors after the repair.

**Verified as not needing a change**

Sidekiq 6.5.12 with the ActiveJob adapter works on 8.1.0. All four background flows (digest, citation enrichment, reminder, export) completed through a real worker against Redis, with zero worker errors, on both the 8.1 copy and the 7.0 reference. The ActiveJob Sidekiq adapter ships in 8.1.

## Optional default adoption

The "current" column is the effective value at `load_defaults 7.0`, measured by `effective_config.rb` (`/tmp/rails-upgrade/logs/effective-config-*.txt`). Rows marked "test" were exercised by the suite under the cumulative load level. Rows marked "probe" were exercised by an experiment.

| Adopt at | Setting (current → adopted) | What happens here | Repair (works on 7.0?) |
|---|---|---|---|
| 7.1 | `raise_on_assign_to_attr_readonly` (false → true) | Settings update raises `ActiveRecord::ReadonlyAttributeError: slug` (the form resubmits `slug`). [test] | Drop `:slug` from `notebook_params`. Yes. |
| 7.1 | `raise_on_invalid_cache_expiration_time` (false → true) | Exports index raises `Cache expiration time is invalid, cannot be negative: -60.0` for an expired export. [test] On 7.0 an already-expired entry is written silently (source). | Clamp `expires_in` to at least 1 second in `_export.html.erb`. Yes. |
| 7.1 | `default_column_serializer` (YAML → nil) | All tests fail at boot: `missing keyword: :coder`. [test] | `serialize :preferences, coder: ActiveRecord::Coders::YAMLColumn.new(:preferences, Object)`. Same bytes. Yes. |
| 7.1 | `cache_format_version`, `message_serializer`, `use_message_serializer_for_metadata`, `marshalling_format_version` | Rolling-deploy break: see the mixed-version section. [probe] | Pin during rollout. Not a code fix. |
| 7.1 | `action_view`/`action_text` `sanitizer_vendor` (nil → HTML5) | Vendor changes. Ten rich-text samples rendered identically under the explicit allow-list. [probe] The explicit list freezes the HTML4 tags, so a vendor-aware list is needed if that is ever wanted. | Not required. |
| 7.1 | `action_dispatch.default_headers` | `X-Download-Options: noopen` disappears from responses. [probe] | Adopt, or set the header explicitly. |
| 7.1 | `debug_exception_log_level` (fatal → error), `dom_testing_default_html_version` (html4 → html5) | Log level only; the cumulative 7.1 suite passes with html5. [test] | None. |
| 7.1 | `add_autoload_paths_to_load_path`, `precompile_filter_parameters`, `belongs_to_required_validates_foreign_key`, the commit-callback ordering settings | No app-file requires and no commit callbacks in the app (grep). Not probed otherwise. | None found; unverified. |
| 7.2 | `postgresql_adapter_decode_dates` (false → true) | Activity report raises `TypeError: no implicit conversion of Date into String`. [test] | `Date.iso8601(day.to_s)` in `Notebook#daily_note_counts`. Yes. |
| 7.2 | `validate_migration_timestamps` | `db:migrate:status` clean. [executed] | None. |
| 7.2 | `web_image_content_types` (adds webp), `yjit` | Not probed. | Unverified. |
| 7.2 / 8.1 | `enqueue_after_transaction_commit` | In 8.1 this is a boolean class attribute that defaults to `false`. The summary's `:default` mode does not exist in 8.1. Opt-in is risky: with the default, a refused enqueue raises and rolls back the pending state. With `true`, the state stays `pending` with no job, and the next request returns `false`. [probe] | Keep `false`. Do not opt in without a reconciliation path (not implemented). |
| 8.0 | `strict_freshness` (false → true) | No observable change on the download endpoint. `Rack::ConditionalGet` already gives `If-None-Match` priority, and the statuses are identical. [probe] | Adopt freely. |
| 8.0 | `Regexp.timeout` (nil → 1s) | Not probed. Patterns are simple. | Unverified. |
| 8.1 | `escape_js_separators_in_json` (true → false) | Stored tags with U+2028/U+2029 change bytes (`\u2028` becomes raw). Both still load. [probe] | Choose deliberately, or pin `true`. |
| 8.1 | `escape_json_responses`, `action_on_path_relative_redirect`, `raise_on_missing_required_finder_order_columns`, `render_tracker`, `remove_hidden_field_autocomplete`, `yjit` in production | No JSON responses, no relative redirects, no order-less finders (grep). The hidden-field and render-tracker changes are markup-only, not probed. | None. |
| Removed in 8.x | `use_big_decimal_serializer`, `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `commit_transaction_on_non_local_return`, `to_time_preserves_timezone` (ignored) | The removal behavior is now unconditional: R14, R18, R19 above. `Parameters == Hash` is now false, and no app code compares params (grep). | See R14, R18, R19. |

Cumulative `load_defaults` results (with R1–R19 applied, and with the 7.1 changes of the preferences coder):
- Adopting 7.1 without the optional repairs gives two failures (the export cache and the slug update).
- Adopting 7.2 adds the date-decode failure.
- 8.0 and 8.1 add no new failures.
- With the four optional repairs applied, 7.1, 7.2, and 8.1 each pass 46 runs, 340 assertions, 0 failures.

## Mixed-version rollout and rollback

- **BigDecimal job payloads [executed].** An 8.1 enqueue run by a 7.0 worker fails with the `BigDecimalSerializer is not known` error above. After R19, all four flows complete on the 7.0 worker. Logs: `mixed-m81-enq-70-work-sidekiq.log` (before) and `mixed-m81-enq-70-work-strcompletion2-sidekiq.log` (after). The reverse direction (7.0 enqueues, 8.1 worker) completes all flows.
- **Cache and signed values under 7.1 defaults [executed].** The 7.0 reader raises on values written by 8.1 at 7.1 defaults:
  - Cache: `TypeError: incompatible marshal file format (can't be read) format version 4.8 required; 17.2 given`.
  - Signed messages: `TypeError` in the same family.
  - Signed GlobalIDs (rich-text attachment sgids): `NoMethodError: undefined method 'unpack1' for nil`.
  Pinning `ActiveSupport.cache_format_version = 7.0`, `message_serializer = :marshal`, and `use_message_serializer_for_metadata = false` makes the 7.0 reader succeed on all three. The reverse direction (7.0 writes, 8.1 at 7.1 reads) is fine. Note that `cache_format_version = 6.1` is rejected by 8.1 (`Unrecognized ActiveSupport::Cache.format_version: 6.1`). Logs: `mixed-81-7.1defaults-written-read-by-70.txt`, `mixed-81-7.1compat-written-read-by-70.txt`, `mixed-70-written-read-by-81-7.1.txt`.
- **Stored formats [executed].** The attribute-based tags (R3) and YAML preferences keep their stored bytes on both versions. Using `serialize ... coder:` on 7.0 would write YAML into rows that 7.0 and 8.1 both read as JSON, so that form must not be deployed before the upgrade.
- **Retry algorithm [source].** Each worker runs its own job class, so `:polynomially_longer` only matters if the 8.x code runs on 7.0. Ship the symbol switch atomically with the gem bump. Do not ship it earlier.
- **Rollback [source plus the runs above].** Once 8.1 writes cache or signed values at 7.1 defaults, 7.0 cannot read them without the pins above. Keep the pins until no 8.x replica can roll back. Queued BigDecimal jobs from before R19 are the other rollback hazard, so drain them before rolling back.

Proposed rollout order:
1. Ship the 7.0-safe preparatory set on 7.0.8.7 (see below). Suite: 46 runs, 325 assertions, 0 failures.
2. Bump to 8.1.4 (or 8.1.0 with the `json` pin) with the atomic changes: `:polynomially_longer`, `show_exceptions = :none`, and the Gemfile. Keep `load_defaults 7.0`.
3. Adopt defaults one level at a time, with the optional repairs and the cache and message pins in place during the rolling window.

## Preparatory work

Safe on 7.0.8.7 [executed]: everything in `/tmp/rails-upgrade/patches/final-7.0-preparatory.diff`. That covers R1, R2, R3 (attribute form), R4, R5, R6, R8–R12 (except the symbol, which uses the Proc form), R14–R19 (R19 as the string payload), the R20-free views, and the optional repairs P23–P26. The 7.0 suite passes 46 of 46.

Not preparatory (8.x only), so they belong to the bump:
- `retry_on ... wait: :polynomially_longer`. On 7.0 it raises `Couldn't determine a delay based on :polynomially_longer`.
- `show_exceptions = :none`. On 7.0 the symbol is truthy and about four tests fail.
- `serialize :tags, coder: JSON`. On 7.0 it silently writes YAML.
- The `json < 3` pin, which is only needed on 8.1.0.

## Corrections to the summary

- **Incomplete defaults.** The summary has no 8.1 block. It also omits settings that `load_defaults` sets at 7.1, 8.0, and 8.1, such as `cache_format_version`, `default_headers`, `debug_exception_log_level`, `add_autoload_paths_to_load_path`, `precompile_filter_parameters`, `Regexp.timeout`, `escape_json_responses`, `action_on_path_relative_redirect`, `escape_js_separators_in_json`, `raise_on_missing_required_finder_order_columns`, `render_tracker`, and `remove_hidden_field_autocomplete`.
- **Listed but absent or ignored in 8.1.** `use_big_decimal_serializer`, `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, the `enqueue_after_transaction_commit = :default` mode, and `to_time_preserves_timezone = :zone`.
- **Real breaks it did not attach to app code.** The keyword-form `enum` (R2), the positional `serialize` coder (R3), `read_attribute(:id)` (R15), `form_with(model: nil)` (R9), `Enumerable#sum` (R8), and the early-return commit (R14) all appear only in the "no textual match" or removal lists, without an app reference. Other breaks are absent altogether: the JSON decode interaction (R7), the TimeWithZone job serializer (R17), the BigDecimal payload (R19), the integer `wait_until` (R12), and the `where(table:)` key (R10).
- **Real breaks it did flag.** The `action_text` initializer, `alias_attribute`, `secrets`, `stringify_keys` (R16), `:exponentially_longer` (R11), the enqueue-after-commit reference, and `Date.iso8601` (D4) were all flagged with app references.

## Unverified and open

- **Not run:** `bin/rails test:system` (Chrome and Selenium), `assets:precompile`, and `rails server`. The suite and the boot checks ran through `bin/rails test`, `runner`, and `zeitwerk:check`, which passes on the repaired 8.1.0 copy and the 7.0 clone.
- **Not probed:** `belongs_to_required_validates_foreign_key`, `precompile_filter_parameters`, `Regexp.timeout`, `yjit` in production, `web_image_content_types`, and `remove_hidden_field_autocomplete`.
- **Source only:** that ActiveStorage metadata uses the same `Coders::JSON` path (R7), and that 8.1 with `load_defaults 7.0` logs and stores a negative-`expires_in` entry without expiry (D2). The 7.0 behavior (write an already-expired entry) was read from the source but also not executed separately.
- **Not checked:** the 7.2 source for `enqueue_after_transaction_commit = :default`. The claim here is only that 8.1 has no such mode.
- **8.1.x patches:** only 8.1.0 and 8.1.4 were run. 8.1.1 through 8.1.3 were not checked beyond 8.1.3's positional decode call. The gem-changes tool reads only up to 8.1.0.
- **Mixed-version tests** were simulated with two checkouts that share Redis and the dev database. Real replicas and a production cache store were not used. Only the FileStore was exercised for cache formats.
- **Secrets:** experiments used a shared development secret file. Production `config_for(:secrets)` with its ERB and environment variables was not exercised.
- **Performance:** the attribute-based tags declaration was not benchmarked.

## Files

- Summary output: `/tmp/rails-upgrade/gem-changes.txt`
- Lock diff: `/tmp/rails-upgrade/logs/lock-diff-7.0-to-8.1.txt`
- Patch log: `/tmp/rails-upgrade/logs/copy-patch-log.txt`
- Diffs: `/tmp/rails-upgrade/patches/final-8.1.0-repairs.diff` (8.1.0, including `Gemfile`), `/tmp/rails-upgrade/patches/final-7.0-preparatory.diff` (7.0-safe)
- Effective defaults: `/tmp/rails-upgrade/logs/effective-config-{7.0,7.1,7.2,8.0,8.1}.txt`
- Suite logs: `/tmp/rails-upgrade/logs/baseline-7.0-test.log`, `v81-d70-P1-19-test.log`, `v81-d70-repairs-tagsattr-test.log`, `prep70-preparatory-test.log`, `prep70-all-repairs-test.log`, `v81-defaults-7.1-cumulative-test.log`, `v81-defaults-{7.2,8.1}-cumulative-test.log`, `v81-defaults-8.1-repaired-test.log`, `prep70-with-optional-repairs-test.log`, `prep70-string-completion-test.log`, `v814-d70-json3-test.log`, `v814-d81-json3-test.log`
- End-to-end and mixed-version logs: `/tmp/rails-upgrade/logs/e2e-81-d70-check.log`, `e2e-70-orig-check.log`, `mixed-m70-enq-81-work-check.log`, `mixed-m81-enq-70-work-sidekiq.log`, `mixed-m81-enq-70-work-strcompletion2-sidekiq.log`
- Probes and scripts: `/tmp/rails-upgrade/probes/` (scripts and `out-*` outputs), `/tmp/rails-upgrade/logs/probe-*.txt`, and `/tmp/rails-upgrade/scripts/run_e2e.sh` and `run_mixed.sh`

---

Commentary:

- I confirmed the repo is still clean at `ab732f5`. I did not inspect the `/tmp/rails-upgrade` artifacts or re-run any of the suites, so the test numbers above are the planner's reported results.
- The plan does not implement the upgrade. Nothing in `/home/user/workspace/repo` has changed.
- Two decisions are yours to make before any implementation: whether to target 8.1.4 (recommended) or 8.1.0 with the `json` pin, and whether to ship the 7.0-safe preparatory set as its own change first. I'd recommend the preparatory set first, since the plan says it passes the suite on 7.0.8.7.