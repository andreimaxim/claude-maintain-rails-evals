## Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is feasible, but it needs 16 code or config changes before the app boots and behaves the same. The app doesn't even boot on 8.1.0 without changes. After all 16 repairs, the upgraded disposable copy passes all 46 tests and boots in production with eager loading. Some changes rest on reading the framework source and are labelled that way. Several bugs are silent: no error, just wrong data or broken jobs. The working repository was not modified.

**Experiments.** All ran outside the real repo: separate bundle path, separate Postgres databases, a private Redis on port 6390 (stopped afterwards) and each copy's own `storage/`.
- **`base`** (`/tmp/up/base`): the current 7.0 code.
- **`up`** (`/tmp/up/up`): Rails 8.1.0 plus every repair. Bundler kept sidekiq 6.5.12, redis 4.8.1, rack 2.2.24 and puma 5.6.9, and added action_text-trix 2.1.19 and bigdecimal 4.1.3.
- **`prep`** (`/tmp/up/prep`): Rails 7.0 plus only the repairs marked "works on 7.0".

| Variant | Tests |
|---|---|
| `base` (7.0) | 46 runs, 0 failures |
| `prep` (7.0) | 46 runs, 0 failures |
| `up` (8.1), first boot | development, test and `zeitwerk:check` all fail to boot |
| `up` (8.1), all repairs | 46 runs, 0 failures; production eager boot OK |

The browser suite (`test:system`) was not run.

The `gem-changes` summary missed findings 4, 7, 8, 9, 10, 11, 12 and 16, and has no section for the six 8.1 defaults. I read those from the railties 8.1 source.

## A. Required changes

For each finding: the file, what happens on 8.1 if nothing is done, the repair, and whether that repair also works on 7.0.

### Boot and load failures

**1. `config/initializers/action_text.rb` (executed).**
- **On 8.1:** boot fails in every environment with `undefined method '+' for nil (NoMethodError)`. Since 7.1, `allowed_tags` starts as nil.
- **Repair:** build the list in `after_initialize`, starting from `allowed_tags`, or from the sanitizer's own allowed tags if that is nil, then add `details` and `summary`. The tested version is `/tmp/up/fixes/action_text.rb`.
- **Works on 7.0:** yes.
- **Check:** the test "rich text keeps collapsible excerpts and drops unsafe markup" passes on both versions. A probe showed `<details>` kept and `<script>` stripped on both.

**2. `app/models/note.rb:10`, keyword-style `enum status:` (executed).**
- **On 8.1:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` while eager loading, so production boot fails.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. Method names stay the same (`status_ready`).
- **Works on 7.0:** yes.

**3. `app/models/note.rb:12`, `serialize :tags, JSON` (executed).**
- **On 8.1:** `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Repair:** `serialize :tags, coder: JSON`. Stored data (`["a","b"]` text) round-trips unchanged.
- **Works on 7.0:** not verified, so ship it with the upgrade. The 7.0 signature passes unknown keywords through as `**options`.

**4. `Gemfile`, json pin (executed).**
- **On 8.1:** Bundler resolves json 3.1.0. Every JSON column read then fails inside ActiveSupport's JSON decoder (`ArgumentError: wrong number of arguments (given 2, expected 1)`). That broke exports, imports and sign-in.
- **Repair:** add `gem "json", "< 3"`, which resolved to 2.21.2.
- **Works on 7.0:** yes.

**5. `app/models/note.rb:14`, `alias_attribute :highlight_color, :color` (executed).**
- **On 8.1:** this broke 22 tests with `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Works on 7.0:** yes.
- **Check:** create and update with `highlight_color: "green"` stores `settings={"color": "green"}` and reads it back on both versions.

**6. `app/models/citation/provider.rb:13`, `Rails.application.secrets` (executed).**
- **On 8.1:** `NoMethodError: undefined method 'secrets'`. The method was removed in 7.2.
- **Repair:** move the same ENV-based YAML to `config/citation_provider.yml`. Load it in `application.rb` with `config.x.citation_provider = config_for(:citation_provider)`. Read `Rails.configuration.x.citation_provider.to_h` in the provider. Update the two `secrets` references in `test/controllers/citation_enrichments_controller_test.rb` (lines 45 and 116–121).
- **Works on 7.0:** yes.
- **Check:** the test that passes credentials to a fresh `bin/rails runner` subprocess ("provider credentials from the environment reach the server unchanged") passes on both versions.

**7. `config/routes.rb`, `get "/notes", "/journal", to: "notes#index"` (executed).**
- **On 8.1:** route loading fails, so every `notes_path` call raises `NameError`.
- **Repair:** two separate `get` lines. This keeps the route names `notes` and `journal`, as confirmed with `rails routes` on 7.0.
- **Works on 7.0:** yes.

### Wrong behaviour after the app boots

**8. `app/models/export.rb:42`, `fragments.sum` (executed).**
- **On 8.1:** `TypeError: String can't be coerced into Integer`. Rails 7.1 removed the extension that let `sum` join strings.
- **What users see:** the export job raises and stays in "working" with no file.
- **Repair:** `fragments.join`.
- **Works on 7.0:** yes.

**9. `app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)` (executed).**
- **On 8.1:** `ArgumentError (Passed nil to the :model argument...)`, so `/notes` and `/journal` return 500.
- **Repair:** drop `model: nil`.
- **Works on 7.0:** yes.

**10. `app/controllers/notes_controller.rb`, `where(notebooks: @notebook)` (executed).**
- **On 8.1:** `PG::UndefinedColumn: column notes.notebooks does not exist`, so filtering by notebook returns 500.
- **Repair:** `where(notebook: @notebook)`.
- **Works on 7.0:** yes.

**11. `app/views/imports/preview.html.erb`, `@import.annotations.stringify_keys` (executed).**
- **On 8.1:** stringifying the keys of this indifferent-access hash now converts its integer line numbers to strings. Lookups by `row.line` then miss and annotations silently disappear from the preview. No error is raised.
- **Repair:** use `@import.annotations` without `stringify_keys`.
- **Works on 7.0:** yes.

**12. `app/models/note.rb` `schedule_reminder`, `set(wait_until: reminder_epoch)` with an Integer (executed).**
- **On 8.1:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Scheduling reminders, postponing them, and scheduling imported reminders all fail.
- **Repair:** `wait_until: Time.at(reminder_epoch)`.
- **Works on 7.0:** yes.
- **Check:** the test still asserts that the job runs at exactly `nine_eastern`.

**13. `app/models/import.rb` `apply`, `return false` inside `transaction` (executed). This is the most serious silent data change.**
- **On 8.1:** since 8.0, leaving a transaction block with `return` commits instead of rolling back. A CSV whose second row is invalid now saves the import and the earlier rows. The test's record counts changed `Expected: [0, 3, 0, 1]  Actual: [1, 4, 1, 2]`.
- **Repair:** `imported = rows.all? { |row| row.note.save }; raise ActiveRecord::Rollback unless imported`, then return `imported` after the block.
- **A first attempt failed:** using `return true` inside the block broke the 7.0 success path, because 7.0 rolls back on `return`. That shows the repair must not exit the block early.
- **Works on 7.0:** yes, both the success path (create and receipt) and the all-or-nothing path pass.

**14. `app/models/import.rb` `receipt`, `citation[:id]` (executed).**
- **On 8.1:** since 7.2, `[:id]` no longer returns a custom primary key. The receipt CSV silently gets empty DOI cells (`On idleness,` instead of `On idleness,10.1000/Essays.1`).
- **Repair:** `citation&.doi`.
- **Works on 7.0:** yes.

**15. `app/jobs/citation_enrichment_job.rb`, `wait: :exponentially_longer` (executed).**
- **On 8.1:** the first retry raises `RuntimeError (Couldn't determine a delay based on :exponentially_longer)`.
- **What users see:** the job makes 2 provider requests instead of 6. In Sidekiq the RuntimeError escapes `retry_on`, so `fail_enrichment` never runs. The citation stays `pending`, and every later request answers "already being fetched". That last part is inferred from the source; I observed the RuntimeError, not the stuck row.
- **Repair:** `:polynomially_longer` (same formula).
- **Works on 7.0:** no, that option doesn't exist in 7.0, so ship it with the upgrade.

**16. `app/models/note.rb` `next_day_reminder_at` (executed).**
- **On 8.1:** `to_time` now always keeps the time zone. Across the DST change the "24 hours later" text renders `08:00 -05:00` instead of the documented and tested `2026-11-01T09:00:00-04:00`. It is the same instant (epoch 1793538000), so postponing itself is unaffected.
- **Repair:** `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`, which keeps the comment's stated behaviour.
- **The alternative:** accept the new display and update the comment and test. That changes what readers see, so I don't recommend it.
- **Works on 7.0:** yes.

### Environment config and Rails 8.2 warnings

**17. `config/environments/test.rb`, `show_exceptions = false` (executed).**
- **On 8.1:** `false` is no longer accepted. Exceptions are rendered as 404 pages, so 6 authorization tests ("…cannot be reached / RecordNotFound expected") fail.
- **Repair:** `:none`.
- **Works on 7.0:** no, because in 7.0 `:none` is truthy and would turn exception display on. Ship it with the upgrade.

**18. Sidekiq adapter (executed: deprecation observed).**
- **On 8.1:** the app works, but logs `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2.`
- **Production visibility:** production sets `report_deprecations = false`, so the warning won't show there.
- **Do now:** nothing is required for 8.1.
- **Plan for Rails 8.2:** move to sidekiq 7.3.3 or later separately. That also needs redis-client, so `rescue Redis::BaseError` in `Notebook#request_export` and `Sidekiq.redis { |r| r.sadd(...) }` in `User#request_digest` will change.

## B. Mixed-version rollout, queued work and rollback (executed with real Sidekiq payloads, `/tmp/up/xv.log`)

- **Jobs queued under 7.0, run by 8.1:** DigestJob and the scheduled NoteReminderJob both ran correctly. The wrapper class name is unchanged, and the digest was dated October 05.
- **8.1 TimeWithZone format:** 8.1 adds `"time_zone":"America/New_York"` to TimeWithZone arguments, so DigestJob now gets the reader's local time. Without a fix the digest subject reads "October 04" instead of "October 05", and the note window becomes the reader's local day instead of the UTC day the UI promises.
  - **Repair:** in `DigestMailer`, `requested_at = params[:requested_at].in_time_zone("UTC")`.
  - This handles both old and new payloads and works on 7.0.
- **Jobs queued under 8.1, run by 7.0 (rollback, or old workers during a rolling deploy):** DigestJob fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
  - **Repair:** enqueue `reading_completion.to_s` in `User#request_digest`. The mailer already calls `BigDecimal(...)` on it.
  - **Checked:** after the change, the 8.1 payload carries `"0.25"`, and both unrepaired 7.0 and `prep` delivered "25% of your notes".
  - **Queued-work risk:** jobs already enqueued by 8.1 before this fix ships stay unreadable on 7.0.
- **Deploy order:** ship the portable repairs on 7.0 first (1, 2, 5–14, 16, the digest UTC fix and `to_s`). Then ship the Rails bump together with 3, 4, 15 and 17. Drain the default queue before rollback, or keep the `to_s` fix.
  - **NoteReminderJobs** scheduled under 7.0 can run on 8.1 (verified).
  - **Stored data** keeps the same format: tags JSON, preferences YAML (`"---\nexport_heading: H\n"` on both versions), and session cookies (cookie serializer untouched).

## C. Optional framework defaults

The app keeps `load_defaults 7.0`. Nothing below is set explicitly, so every item keeps its old value unless adopted. "Exec." means a probe showed the effect.

**7.1**

| Default | What would change if adopted |
|---|---|
| `default_column_serializer = nil` | Exec.: `Notebook` raises `ArgumentError: missing keyword: :coder`. Add `coder: YAML` first. |
| `raise_on_assign_to_attr_readonly = true` | Exec.: updating a notebook with `slug` raises `ActiveRecord::ReadonlyAttributeError: slug` (500). The form permits `:slug`, so remove it from `notebook_params` first. |
| `commit_transaction_on_non_local_return` | Moot: it was removed in 8.0 and is now always on (finding 13). |
| `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records` | No app `after_commit` callbacks. |
| `belongs_to_required_validates_foreign_key` | Fewer parent queries on Note/Export/Import saves. Low risk. |
| `generate_secure_token_on` | No `has_secure_token`, so no effect. |
| `allow_deprecated_singular_associations_name` | No effect seen. |
| `sqlite3_adapter_strict_strings_by_default` | The app uses PostgreSQL, so no effect. |
| `marshalling_format_version`, `message_serializer`, `use_message_serializer_for_metadata` | Rolling-deploy risk: old servers can't read new messages, so adopt in a later deploy. |
| `action_view` / `action_text` `sanitizer_vendor` (HTML5) | Changes rich-text sanitizing. Re-run the details/script test. Repair 1 builds on whichever sanitizer is configured. |
| `use_big_decimal_serializer` | Moot in 8.1; see section B. |
| `query_log_tags_format`, `log_file_size`, `debug_exception_log_level`, `precompile_filter_parameters`, `raise_on_invalid_cache_expiration_time`, `allow_deprecated_parameters_hash_equality` | Negligible for this app. |
| Encryption hash/SHA-1 settings | No encrypted attributes. |
| `dom_testing_default_html_version = :html5` | Changes test HTML parsing. Re-run the view tests. |

**7.2**

| Default | What would change if adopted |
|---|---|
| `postgresql_adapter_decode_dates = true` | Exec.: the activity report crashes with `TypeError: no implicit conversion of Date into String`. Change `Date.iso8601(day)` to accept a Date first. |
| `validate_migration_timestamps` | All migrations match the expected format. |
| `web_image_content_types` | No variants, so no effect. |
| `yjit` | Memory trade-off only. |
| `enqueue_after_transaction_commit` | The config was removed in 8.1 and the default is false, so no change. Setting it per job would break the "failed enqueue rolls back" guarantee in `Citation#request_enrichment` and `Note#schedule_reminder`. |

**8.0**

| Default | What would change if adopted |
|---|---|
| `to_time_preserves_timezone = :zone` | Already forced in 8.1 regardless of this setting; see finding 16. |
| `strict_freshness = true` | `ExportDownloadsController#stale?`: when a client sends both conditional headers, only the ETag is checked. Same file, so low risk (source only). |

**8.1** (the change summary omitted these)

| Default | What would change if adopted |
|---|---|
| `escape_json_responses = false` | No JSON views, so no effect. |
| `action_on_path_relative_redirect = :raise` | All redirects use route helpers, so no effect. |
| `raise_on_missing_required_finder_order_columns` | Reasoned from source, not run: affects `first`/`last` on unordered relations; I didn't find any. |
| `escape_js_separators_in_json = false` | Negligible. |
| `render_tracker = :ruby` | Negligible. |
| `remove_hidden_field_autocomplete` | Hidden fields lose `autocomplete="off"`. Harmless. |

**Other behaviour change.** `has_secure_password` (7.1, executed) now rejects passwords over 72 bytes with "Password is too long". 7.0 already did this too.

## D. Validation to run against the real change

| Check | Data | Fails without the repair | Control that must not change |
|---|---|---|---|
| Import all-or-nothing | 3-row CSV, row 2 has DOI `not-a-doi` | Counts of imports / notes / citations / rich texts must stay the same; they increase | A valid 2-row CSV creates 1 import and 2 notes, and its receipt lists `10.1000/Essays.1` twice |
| Retry exhaustion | Provider returning 503 | Exactly 6 requests, and the citation ends `enrichment_failed` with the HTTP 503 message | A 503 then 200 sequence completes |
| Digest | Reader in Eastern time, request at 2026-10-05 03:30 UTC | Subject "October 05" | 8.1-enqueued payload performed by a 7.0 worker delivers |
| Reminders | 2026-10-31 09:00 Eastern | Job `:at` equals epoch 1793538000 | Postponing replaces the job; preview reads `-04:00` |
| Notes list | Both `/notes` and `/journal` | 200 on both paths | Notebook filter shows only that notebook |

A passing suite alone doesn't establish completeness. Also run `test:system` (not run here) and a manual Trix editor check.

## Unverified and open

- **Trix:** I didn't check the vendored `trix-1.3.5.js` against action_text 8.1, which now pulls in the `action_text-trix 2.1.19` gem. Editor and attachment behaviour in a browser is unchecked.
- **`coder: JSON` on 7.0:** never executed.
- **Stuck `pending` citation:** inferred from the source, not observed.
- **`strict_freshness` and the 8.1 defaults:** effects come from reading the source, not from runs.
- **Production Sidekiq server process:** never started; I performed jobs through the wrapper class.
- **Later 8.1.x patch releases:** may not need the json pin; not checked.

## Artifacts

- Copies: `/tmp/up/base`, `/tmp/up/prep`, `/tmp/up/up`
- Diffs: `/tmp/up/up.diff`, `/tmp/up/prep.diff`
- Resolved dependencies: `/tmp/up/up/Gemfile.lock`
- Change summary: `/tmp/up/changes.txt`
- Boot logs: `/tmp/up/boot-*.log`, `/tmp/up/zw-up*.log`
- Test logs: `/tmp/up/test-{base,prep,up}.log`
- Cross-version and probe logs: `/tmp/up/xv.log`, `/tmp/up/probes.log`, `/tmp/up/probes2.log`
- Scripts: `/tmp/up/{setup,boot,tests,xv,probes,probes2}.sh`, `/tmp/up/fixes/`

---

I haven't upgraded Rails yet. This is the plan; your repository is unchanged and still on Rails 7.0.8.7. The plan was tested on throwaway copies: with all the fixes, Rails 8.1.0 passes all 46 tests. The browser tests weren't run. The riskiest problem is #13: without that fix, a failed CSV import saves part of its rows instead of none.

To apply it, I'd do two commits:
1. The fixes that also work on Rails 7.0.
2. The Rails version change together with #3, #4, #15 and #17.

Should I go ahead?