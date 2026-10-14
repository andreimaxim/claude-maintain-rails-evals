I upgraded a disposable copy to Rails 8.1.0. It doesn't boot without changes, and after it boots, several behaviors still change without any error. Twenty repairs (R1–R20 below) make the full suite pass on 8.1.0, both with the 7.0 defaults and with six of the new defaults adopted. Thirteen of the code repairs and the json pin also work on 7.0 and can ship first. The working repository was not modified.

## How the checks were run
- **Copies:** `/tmp/up/base` (7.0 control), `/tmp/up/v81` (8.1 plus repairs), `/tmp/up/prep70` (7.0 plus the repairs that work on 7.0).
- **Isolated services:** databases `mn_up_*` (since dropped), a separate Redis on port 6390 (since stopped), storage and mail under each copy's own `tmp/`.
- **Dependencies:** `bundle update rails --conservative` resolved Rails 8.1.0 with rack 2.x, sidekiq 6.5.12, redis 4.8.1 and json 3.1.0 (`/tmp/up/v81_lock.diff`).
- **Diffs:** `/tmp/up/v81_final.diff` (it also contains env-gated `EXP_*` lines in `config/application.rb` that I used to switch single new defaults on; leave those out), and `/tmp/up/prep70_final.diff`.
- **Test logs:** baseline on 7.0 `/tmp/up/base_test.log` (46 passed); on 8.1 `/tmp/up/v81_test2.log` through `v81_test9.log` show the failures disappearing one repair at a time. Final runs: `v81_test10.log` (8.1, old defaults) and `v81_test11.log` (8.1 with six new defaults) both 46/46; `/tmp/up/prep70_test2.log` (7.0 with the early repairs) 46/46.
- **Cross-version and rollback:** scripts in `/tmp/up/scripts/`. Logs: `seed70.log`, `consume81.log`, `seed81.log`, `consume70.log`, `server81.log`.
- **Change index:** `/tmp/up/changes.txt`.

## Required changes (8.1 breaks without them)

Each item gives the observed error or behavior, the repair, and the check. **Prep** means the repair also works on 7.0 (shown by `prep70`).

| # | Code | Observed on 8.1 without the repair | Repair (recommended) | Prep |
|---|---|---|---|---|
| R1 | Gemfile (json) | The resolver picks json 3.1.0, and every JSON-serialized column then fails: `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291 parse`, called from `activesupport-8.1.0 json/decoding.rb:25` | Pin `gem "json", "~> 2.10"` (resolved to 2.21.2) | n/a |
| R2 | `config/initializers/action_text.rb` | Boot fails: `NoMethodError: undefined method '+' for nil` (`allowed_tags` starts as nil since 7.1) | Inside `after_initialize` → `ActiveSupport.on_load(:action_view)`, set `allowed_tags = (allowed_tags \|\| sanitizer.class.allowed_tags + [Attachment.tag_name, "figure", "figcaption"]).to_a \| %w[details summary]` (`/tmp/up/action_text_repair.rb`). `on_load` makes it run after any sanitizer-vendor switch | yes |
| R3 | `note.rb:10` `enum status:, _prefix:` | `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at eager load | `enum :status, {…}, prefix: true` | yes |
| R4 | `note.rb:12` `serialize :tags, JSON` | `ArgumentError (given 2, expected 1)` | `serialize :tags, coder: JSON` | **no** (needs 7.1+) |
| R5 | `routes.rb:18` `get "/notes", "/journal"` | `ArgumentError: Wrong number of arguments (expect 1, got 2)` | Two `get` lines; route names `notes` and `journal` stay the same (checked with `rails routes`) | yes |
| R6 | `note.rb` `alias_attribute :highlight_color, :color` (a store accessor) | `ArgumentError: Note model aliases 'color', but 'color' is not an attribute` | `alias_method` for both the reader and the writer | yes |
| R7 | `Citation::Provider`, `config/secrets.yml`, the test helper | `NoMethodError: undefined method 'secrets'` | Move the file to `config/citation_provider.yml` without the nested key, set `config.x.citation_provider = config_for(:citation_provider)`, read `Rails.configuration.x.citation_provider.to_h`, update the test helper. The environment-credential test passes | yes |
| R8 | `test.rb` `show_exceptions = false` | Exceptions become responses, e.g. `RecordNotFound expected but nothing was raised` | `:none` | **no** (7.0 treats `:none` as true) |
| R9 | `export.rb:42` `fragments.sum` | `TypeError: String can't be coerced into Integer`. Every export fails. 7.0 already logs a deprecation for this | `fragments.join` | yes |
| R10 | `notes/index.html.erb:12` `form_with(model: nil, …)` | `Passed nil to the :model argument`, so `/notes` returns 500 | Remove `model: nil` | yes |
| R11 | `notes_controller.rb` `where(notebooks: @notebook)` | `PG::UndefinedColumn: column notes.notebooks does not exist` | `where(notebook: @notebook)` | yes |
| R12 | `citation_enrichment_job.rb` `wait: :exponentially_longer` | `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. The `retry_on` block never runs, so the citation stays `pending` | `:polynomially_longer` (same formula) | **no** |
| R13 | `note.rb` `set(wait_until: reminder_epoch)` (an Integer) | `NoMethodError: undefined method 'utc' for an instance of Integer`. Reminders cannot be scheduled | `wait_until: Time.at(reminder_epoch)` | yes |
| R14 | `note.rb` `next_day_reminder_at` | The preview across the DST change shows `2026-11-01T08:00:00-05:00` instead of `09:00:00-04:00`. `to_time_preserves_timezone` is `nil` on 8.1 even under `load_defaults 7.0` (7.0: `true`). The `.to_i` used when postponing does not change | `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. Don't set `to_time_preserves_timezone` instead: it's deprecated and removed in 8.2 | yes |
| R15 | `digest_mailer.rb` | Wrong data, no error. Since 7.1 the TimeWithZone job argument keeps the reader's zone, so the subject and the `all_day` window move to the local day. The test saw "October 04" where "October 05" (UTC) is expected | `requested_at = params[:requested_at].utc`. Works for old payloads without `time_zone` and for new ones | yes |
| R16 | `imports/preview.html.erb` `annotations.stringify_keys` | No error, wrong output. Since 8.0, integer line keys become `"2"`, so annotations disappear from the preview | Use `@import.annotations` directly | yes |
| R17 | `import.rb` receipt `citation[:id]` | No error, wrong data. Since 7.2, `read_attribute(:id)` no longer returns a custom primary key (here `doi`), so the receipt CSV has a blank doi column | `citation&.doi` | yes |
| R18 | `import.rb#apply`, `return false` inside `transaction` | **Data change, no error.** Since 7.2 an early return commits. Expected record counts `[0,3,0,1]`, got `[1,4,1,2]`: an invalid import saves the Import, earlier notes, citations and rich text | Set `saved = rows.all?(&:save)`, then `raise ActiveRecord::Rollback unless saved`, and return `saved`. The success path and the "re-render preview" path both pass | yes |

The `rails-html` sanitizer, sessions and stored data needed no repair:
- A session cookie signed by 7.0 was accepted by 8.1 (GET `/notes`, `/notes/1`, the activity report and exports all 200; POSTs 303 with the page's CSRF token).
- 8.1 rendered rich text with attachment sgids written by 7.0 (`<details>` kept, attachment rendered).
- YAML `preferences` and JSON `tags` written by either version were read correctly by the other.
- Production boot (`eager_load`) and `assets:precompile` succeeded on 8.1.

## Rollout and rollback risks (queued work and stored data)
- **R19, DigestJob BigDecimal argument.** Observed: 8.1 always uses `BigDecimalSerializer`, even under `load_defaults 7.0`. On rollback (or during a mixed 7.0/8.1 fleet), a 7.0 worker fails with `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. That reader's `digest_requests:<date>` Redis key stays set, so they can't request another digest that day.
  - **Repair:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already calls `BigDecimal(...)`. Works on 7.0.
  - **Verified:** after the repair, a payload enqueued on 8.1 runs on 7.0, and the mail shows "100% … ready".
  - **Order:** ship this before 8.1 is deployed.
- **7.0 → 8.1 queued work.** A 7.0 DigestJob, a scheduled NoteReminderJob, and a CitationEnrichmentJob retry with `executions: 1` all ran on repaired 8.1, and the retry was rescheduled with `executions: 2`.
  - CitationEnrichmentJob retries queued by 7.0 run the 8.1 class, so R12 is required on any 8.1 worker before it drains them.
  - 8.1 payloads (extra `scheduled_at`, `time_zone`) also ran on 7.0, apart from the DigestJob case above.
- **Order of deploys:**
  1. Ship the "yes" rows plus R19 and R20 on 7.0 first; all 46 tests pass there.
  2. Ship R4, R8 and R12 together with the gem bump.
  - On rollback, revert those three together with the gem bump.
- **Built-in Sidekiq adapter.** Observed on 8.1: `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later`. Not required for 8.1.0. Source-based and not tested: moving to Sidekiq 7 would also mean:
  - `perform_async(export.id, { format: "markdown" })` raises under strict args (Sidekiq 6.5 already warns "do not serialize to JSON safely").
  - `redis.sadd` returns an Integer, and `0` is truthy in Ruby, which would break the one-digest-per-day check in `User#request_digest`. Use `sadd?`.

## Optional new defaults (the app keeps `load_defaults 7.0`; nothing below is set explicitly)
- **7.1**
  - **`raise_on_assign_to_attr_readonly`:** with it on, notebook update raises `ActiveRecord::ReadonlyAttributeError: slug`, because the edit form posts a hidden `slug`.
    - **R20 repair:** keep the hidden field (a test asserts it) but remove `:slug` from `notebook_params`. Create already derives the slug from the name.
  - **`default_column_serializer = nil`:** `serialize :preferences` raises `ArgumentError: missing keyword: :coder`.
    - **Repair:** `coder: YAML`, which keeps reading the existing YAML rows (needs 7.1+).
  - **`raise_on_invalid_cache_expiration_time`:** an expired export's fragment has negative `expires_in`. With the flag on, the exports page raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative`. Without it, 8.1 reports and logs a handled `ArgumentError` on every render.
    - **Repair:** `expires_in: [export.expires_at - Time.current, 1.second].max`. This keeps the tested "stale cached link but refused download" behavior. I rejected `cache_if export.downloadable?` because it changes that behavior and fails `exports_controller_test.rb:59`.
  - **`sanitizer_vendor` HTML5 (Action View and Action Text):** with the R2 repair, `<details>`/`<summary>` are kept and `<script>` and `onerror` are stripped (observed).
  - **`message_serializer :json_allow_marshal` / `use_message_serializer_for_metadata`:** risk for a rolling deploy only. Enable them in a later deploy once no 7.0 host remains (not tested).
  - **`cache_format_version 7.1`:** production uses the default FileStore. Only matters if `tmp/cache` is shared between hosts; enable after the rollout.
  - **`marshalling_format_version 7.1`:** same advice as `cache_format_version`.
  - **`run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`:** the app has no after-commit callbacks of its own; Active Storage's are not affected (source-based).
  - **`belongs_to_required_validates_foreign_key`:** removes a parent query on save; no change in behavior.
  - **`generate_secure_token_on`, `encryption.*`, `sqlite3_*`, `allow_deprecated_singular_associations_name`:** not used here.
  - **`add_autoload_paths_to_load_path=false`:** nothing in the app relies on it.
  - **`precompile_filter_parameters`, `query_log_tags_format`, `debug_exception_log_level`, `log_file_size`:** logging only.
  - **`default_headers`:** drops `X-Download-Options`.
  - **`dom_testing_default_html_version :html5`:** may change `assert_select` parsing; not tested.
  - **`use_big_decimal_serializer`:** already effectively on in 8.1 (see R19).
  - **`allow_deprecated_parameters_hash_equality`:** no Parameters/Hash comparisons in the app.
- **7.2**
  - **`postgresql_adapter_decode_dates`:** the activity report raises `TypeError: no implicit conversion of Date into String`.
    - **Repair:** `[day.to_date, count]`, which works with both strings and dates and on 7.0.
  - **`enqueue_after_transaction_commit`:** observed `false` on 8.1. If enabled, the jobs enqueued inside `with_lock` (`request_enrichment`, `schedule_reminder`) would be pushed after commit. `job.job_id` is still assigned, but a Redis failure would leave `reminder_job_id` saved with no job behind it (source-based).
  - **`validate_migration_timestamps`:** current migrations pass.
  - **`web_image_content_types`:** no variants are used.
  - **`yjit`:** a memory decision.
- **8.0**
  - **`strict_freshness`:** no difference a client can see. All variants, including 7.0, returned 304 because `Rack::ConditionalGet` already gives `If-None-Match` precedence.
  - **`to_time_preserves_timezone :zone`:** already effectively on (see R14).
  - **`Regexp.timeout = 1`:** relevant only to pathological input for the DOI and CSV regexes.
- **8.1** (from railties source; not exercised)
  - **`escape_json_responses`:** no JSON views.
  - **`action_on_path_relative_redirect :raise`:** all redirects use absolute paths or route helpers.
  - **`raise_on_missing_required_finder_order_columns`:** may affect `first`/`last` without an order on `Citation`, whose primary key is a string.
  - **`render_tracker`, `remove_hidden_field_autocomplete`, `escape_js_separators_in_json`:** minor.
  - **`yjit`:** now off in development and test.

## Validation for each finding
In the upgraded copy, each repair has a check that fails without it and passes with it. The existing tests now cover R2–R18:
- `notes_controller_test` (R3, R5, R6, R10, R11)
- `exports_controller_test` (R9)
- `reminders_controller_test:6/:38` (R13, R14; the control is the unchanged epoch `nine_eastern`)
- `digests_controller_test:33` (R15)
- `imports_controller_test:6/:47` (R16–R18; the control is the successful two-row import)
- `citation_enrichments_controller_test:60` (R12)

These are the existing tests, unmodified except the R7 test-helper change. The CI that passes after the repairs is not by itself evidence for the rollout risks and optional defaults; those need the checks below.

Add tests for what the suite doesn't cover yet:
- **Import rollback assertion:** a failed apply leaves Import, Note, Citation and RichText counts unchanged.
- **DigestJob rollback (R19):** an enqueue test asserting the third argument is a String.
- **Each optional default:** run the suite with that default switched on, using the `EXP_*` pattern in the copy.

## Open questions and things not verified
- System tests (they need a browser) were not run, and there are no Trix or JS checks.
- The Sidekiq server process was not run; payloads were executed with `ActiveJob::Base.execute` / `ExportJob.new.perform`.
- Production rendering was not tested, because `database.yml` adds `username: margin_notes`.
- `json ~> 2.10` is needed only because of activesupport 8.1.0 itself; a later 8.1.x release may make the pin unnecessary.
- The dev secret moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`, which signs out local development sessions only.
- Ruby 3.4 will need `gem "csv"` (a warning only on 3.3.6).

---

**Note:** I haven't upgraded Rails in your repo yet. The upgrade skill only produces a plan, so the repo is still on Rails 7.0.8.7. The plan above was tested on throwaway copies under `/tmp/up/`, and the diffs there can be reused. Do you want me to apply it? I'd suggest two commits: first the changes that also work on 7.0, plus R19 and R20, then the gem bump together with R4, R8 and R12.