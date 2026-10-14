I didn't change the Rails version: the plan says the app won't even boot on Rails 8.1.0 until 15+ code fixes land. Below is the planner's full plan as written; nothing in your repo was modified. Please check the notes after the plan, because the plan has some internal mistakes.

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

On Rails 8.1.0 with no other changes, the app does not boot. After 15 required repairs, the full suite passes on 8.1.0 with `load_defaults 7.0` (46 runs, 340 assertions, 0 failures). The same repairs, minus three that have to ship with the upgrade itself, also pass on 7.0.8.7 (46 runs, 325 assertions, 0 failures). Three of the required changes fix bugs the suite cannot catch:
- **Rolling deploy:** jobs enqueued by 8.1 fail on 7.0 workers (finding 14).
- **Partial imports:** a failed import keeps the rows saved before the bad one (finding 10).
- **Import receipt:** the downloadable receipt silently loses every DOI (finding 11).

The working repo was not modified. All experiments ran in disposable copies under `/tmp/up`, against their own Postgres databases (`mn_up_base_test`, `mn_up_new_test`, `mn_up_prep_test`, `mn_up_adopt_test`, `mn_up_mixed`) and a private Redis on port 6391, now shut down.

## How the experiments were run

| Variant | Path | What it is | Result |
|---|---|---|---|
| base | `/tmp/up/base` | current app on 7.0.8.7 | 46 runs, 2 errors (both from my private Redis not yet running) |
| new | `/tmp/up/new` | Gemfile `rails "8.1.0"` (`bundle update rails --conservative`) plus the repairs | 46 runs, 340 assertions, 0 failures (`/tmp/up/logs/new-test-10.log`) |
| prep | `/tmp/up/prep` | the new code with the original 7.0 Gemfile and lock, minus repairs 2, 6 and 7 | 46 runs, 325 assertions, 0 failures (`/tmp/up/logs/prep-test-2.log`) |
| adopt | `/tmp/up/adopt` | new plus `load_defaults ENV["LOAD_DEFAULTS"]` and `serialize :preferences, coder: YAML` | logs `adopt-test-d{7.0,7.1,7.2,8.0,8.1}.log` |

- **Dependencies:** the lock diff is in `/tmp/up/logs/lockdiff.txt` and bundle output in `/tmp/up/logs/bundle.log`. Rack stays at 2.2.24, because sidekiq 6.5.12 requires rack < 3. Puma 5.6.9, pagy, faraday and redis are unchanged.
- **Repairs:** the full patch is `/tmp/up/logs/repair.diff`.
- **Test env:** `/tmp/up/env.sh`.
- **Scripts:** `/tmp/up/scripts/*.rb` and `/tmp/up/run.sh`.
- **Change index:** the change summary is `/tmp/up/changes.txt`. It left out every 8.1 default (escape_json_responses, path-relative redirects, the finder-order check, the json separator escaping, render_tracker, hidden-field autocomplete) and the 8.0 `Regexp.timeout`. I read those from railties 8.1.0.

## A. Required changes

For each finding, "Seen" is the error or behaviour the experiment showed on 8.1.0. Where the repair is listed as working on 7.0, it was confirmed in the prep variant.

1. **Gem resolution picks json 3.1.0, which breaks Active Support 8.1.0**
   - **Seen:** every request that reads a session cookie fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291:in 'parse'`, called from `ActiveSupport::JSON.decode`. activesupport 8.1.0 calls `JSON.parse(json, options)`.
   - **Repair:** add `gem "json", "< 3"` to the Gemfile; it resolved to 2.21.2. This also works on 7.0.
   - **Check:** sign-in followed by `GET /notes` fails with json 3.1 and succeeds with 2.x. The sessions controller tests do exactly this.

2. **`serialize :tags, JSON` in `app/models/note.rb:12`**
   - **Seen:** the app fails to load at class definition with `ArgumentError: wrong number of arguments (given 2, expected 1)`.
   - **Repair:** `serialize :tags, coder: JSON`. 7.0 does not accept `coder:`, so this ships with the upgrade.
   - **Stored data:** JSON written by 7.0 reads correctly on 8.1 and the reverse (`/tmp/up/scripts/data_*.rb`).

3. **Keyword-style `enum status: {...}, _prefix: true` in `note.rb`**
   - **Seen:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at load.
   - **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0.

4. **`alias_attribute :highlight_color, :color` where `color` comes from `store_accessor`**
   - **Seen:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
   - **Repair:** define `highlight_color` and `highlight_color=` by hand, delegating to `color`. Works on 7.0. Writing (the form and `note_params`) and reading (index and show views) were both covered by passing tests.

5. **`Rails.application.secrets` was removed in 7.2 (`app/models/citation/provider.rb:13`, `config/secrets.yml`, the citation enrichment tests)**
   - **Seen:** `NoMethodError: undefined method 'secrets'`, so every citation lookup fails.
   - **Repair:**
     - Move the settings to a new `config/citation_provider.yml`, keeping the ERB and `.to_json` quoting.
     - Load it in `config/application.rb` with `config.x.citation_provider = config_for(:citation_provider)`.
     - Have `Provider` read `Rails.configuration.x.citation_provider.to_h`.
     - Point the test stubs at `Rails.configuration.x.citation_provider`.
   - Works on 7.0. I did not use credentials because they would drop the ERB and environment-variable quoting.
   - **Check:** the existing fresh-boot test that passes user `"00123"` and password `"sample: value # keep"` gets both strings through unchanged.
   - **Deploy:** production keeps reading the same `CITATION_PROVIDER_*` environment variables.

6. **`retry_on ... wait: :exponentially_longer` in `app/jobs/citation_enrichment_job.rb`**
   - **Seen:** when the job retries, it fails with `RuntimeError (Couldn't determine a delay based on :exponentially_longer)`. The "three attempts then mark failed" path breaks, so a citation stays pending.
   - **Repair:** `:polynomially_longer`, which does not exist in 7.0, so this ships with the upgrade. It uses the same formula as the old option, so retry timing is unchanged.
   - **Queued work:** retries already scheduled by 7.0 live in Active Job's own scheduled payloads and keep their times.

7. **`config.action_dispatch.show_exceptions = false` in `config/environments/test.rb`**
   - **Seen:** 8.1 renders 404 pages instead of raising, so six "another reader cannot reach…" tests fail with `ActiveRecord::RecordNotFound expected but nothing was raised`.
   - **Repair:** `:none`, together with the upgrade. On 7.0, `:none` counts as true and shows exceptions.
   - **Impact:** test environment only.

8. **`ActionText::ContentHelper.allowed_tags += %w[details summary]` in `config/initializers/action_text.rb`**
   - **Seen:** `NoMethodError: undefined method '+' for nil` at boot. Since 7.1, `allowed_tags` defaults to nil.
   - **Repair:** inside `ActiveSupport.on_load(:action_view)`, set `allowed_tags = sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. Works on 7.0. The file is `/tmp/up/fix_action_text.rb`.
   - **Check:** the rich-text test keeps `details`/`summary` and still strips unsafe markup. It passed under `load_defaults` 7.0 and 7.1 (HTML5 sanitizer).

9. **One route with two paths: `get "/notes", "/journal", to: "notes#index"` in `config/routes.rb`**
   - **Seen:** every route helper raises `ArgumentError (given 2, expected 1)`, for example in `SessionsController#create`.
   - **Repair:** two lines: `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. Works on 7.0, and `bin/rails routes` gives the same helper names on both versions.

10. **`return false` inside `transaction` in `Import#apply` (silent data corruption)**
    - **Seen:** on 7.0 the `return` rolls back. On 8.1 it commits, so a file whose third row fails leaves the import and the earlier notes saved. The test reported `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]`.
    - **Repair:** set `saved = rows.all? { |row| row.note.save }`, `raise ActiveRecord::Rollback unless saved`, and return `saved`. Works on 7.0.
    - **Both paths still work:** the "apply" path of the preview-then-apply test passes, and the invalid-row path saves nothing.

11. **`citation[:id]` in `Import#receipt` when `citations` uses `doi` as its primary key**
    - **Seen:** the receipt CSV comes out as `On idleness,` and `Of experience,` with empty DOI columns. 7.0 returned the DOI.
    - **Repair:** `citation&.doi`. Works on 7.0.

12. **`@import.annotations.stringify_keys` in `app/views/imports/preview.html.erb`**
    - **Seen:** keys become strings while the view looks them up by integer line, so annotations disappear from the preview. The `#line_2 dd` assertion then saw `"10.1000/Essays.1"` instead of the annotation.
    - **Repair:** use `@import.annotations` directly. Works on 7.0.

13. **`where(notebooks: @notebook)`, a plural name for a `belongs_to` (`app/controllers/notes_controller.rb:18`)**
    - **Seen:** `PG::UndefinedColumn: column notes.notebooks does not exist`, a 500 whenever the list is filtered by notebook.
    - **Repair:** `where(notebook: @notebook)`. Works on 7.0.

14. **`form_with(model: nil, ...)` in `app/views/notes/index.html.erb`**
    - **Seen:** `Passed nil to the :model argument`, so `/notes` returns 500.
    - **Repair:** drop `model: nil`; the fields stay unscoped. Works on 7.0.

15. **`set(wait_until: reminder_epoch)` with an Integer in `Note#schedule_reminder`**
    - **Seen:** `NoMethodError: undefined method 'utc' for an instance of Integer`, so reminders cannot be scheduled.
    - **Repair:** `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
    - **Check:** the Redis `schedule` score equals the epoch on both versions (`/tmp/up/scripts/sched.rb`).

16. **`fragments.sum` over strings in `Export#generate`**
    - **Seen:** `TypeError: String can't be coerced into Integer`. The export job fails and retries forever.
    - **Repair:** `fragments.join`. Works on 7.0.

17. **Active Job keeps the time zone of `TimeWithZone` arguments (DigestJob and `DigestMailer`)**
    - **Seen:** the digest covers the reader's local day instead of the UTC day the reservation key uses. The mail said "October 04" where the test expects 05, and it would have included notes from the previous UTC day.
    - **Repair:** `requested_at = requested_at.utc` in the mailer. Works on 7.0, which already delivers the time in UTC.
    - **Checked both ways:** a 7.0-enqueued digest performed on 8.1 arrives as UTC and works.

18. **Postponed-reminder preview: `Note#next_day_reminder_at` (`reminder_at.to_time + 86_400`)**
    - **Seen:** in 8.1, `to_time` always keeps the zone, so the preview shows `2026-11-01T08:00-05:00` instead of the documented `09:00-04:00`. The stored epoch is the same either way.
    - **Repair:** `reminder_at.to_time.localtime(reminder_at.utc_offset) + 86_400`, which keeps the documented behaviour. Works on 7.0.
    - **Alternative:** accept the new zone-following display and update the test and comment. That changes what readers see on the page and in the email.

19. **BigDecimal job arguments (`User#request_digest`) break mixed-version rollout**
    - **Seen:** 8.1 always uses `BigDecimalSerializer`. A digest job enqueued by 8.1 and run by a 7.0 worker failed with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. Sidekiq then retries it until an 8.1 worker picks it up.
    - **Repair:** pass `reading_completion.to_s`; `DigestMailer` already calls `BigDecimal(params[:completion])`. Works on 7.0, which already sends a string.
    - **Check:** enqueue on 8.1, perform on 7.0. Without the repair it fails as above; with it, the mail is sent.
    - **This one was not executed.** It is the only repair I did not apply in the copies.

The cross-version job test is `/tmp/up/scripts/enqueue.rb` plus `perform.rb`. 7.0→8.1 worked for all three jobs. 8.1→7.0 worked for CitationEnrichment and NoteReminder and failed for Digest as shown.

## B. Optional: adopting new framework defaults (none adopted now)

Run with the adopt variant, which already has `serialize :preferences, coder: YAML`.

### Must be fixed before setting `load_defaults` to 7.1 or later

- **`default_column_serializer = nil` (7.1):** `Notebook` fails with `missing keyword: :coder`. Fix with `serialize :preferences, coder: YAML`, which needs 8.1. Existing YAML reads fine.
- **`raise_on_assign_to_attr_readonly` (7.1):** `NotebooksController#update` raises `ActiveRecord::ReadonlyAttributeError: slug`, even when the slug is unchanged, because `notebook_params` permits `:slug` and the form posts it as a hidden field.
  - **Fix:** remove `:slug` from `permit`. Creation still derives the slug from the name. Works on 7.0.
- **`raise_on_invalid_cache_expiration_time` (7.1):** viewing an expired export raises `Cache expiration time is invalid, cannot be negative: -60.0` from `app/views/exports/_export.html.erb:26`. Today it is only logged.
  - **Fix:** compute `remaining = export.expires_at - Time.current` and pass `expires_in: (remaining if remaining.positive?)`.
- **`postgresql_adapter_decode_dates` (7.2):** `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String`. Fix with `Date.iso8601(day.to_s)`, which works on both versions.

### Other 7.1 defaults

| Default | Old value kept? | What changes for this app if adopted |
|---|---|---|
| message_serializer / metadata, marshalling_format_version | yes | Cookie and cache formats change. Adopt only after every server runs 8.1. Sessions moved both ways with the defaults unchanged (executed: 302 then 200 in both directions). |
| sanitizer_vendor HTML5 (Action View and Action Text) | yes | Suite passes. Already-stored rich text may sanitize slightly differently. |
| commit_transaction_on_non_local_return | — | Finding 10 already covers it; on 8.1 the commit happens regardless of this setting. |
| run_after_transaction_callbacks_in_order_defined, before_committed_on_all_records, run_commit_callbacks_on_first_saved_instances | yes | No `after_commit` in app code. |
| belongs_to_required_validates_foreign_key | yes | Skips loading the parent on validation. `Note`'s optional citation is not affected. |
| allow_deprecated_parameters_hash_equality, allow_deprecated_singular_associations_name | yes | The plural-name case is already broken on 8.1 (finding 13). |
| encryption settings | yes | No effect: there is no `encrypts`. |
| sqlite3 strict strings | yes | No effect: the app uses Postgres. |
| query_log_tags_format, debug_exception_log_level, precompile_filter_parameters, log_file_size | yes | Logging only. |
| generate_secure_token_on | yes | No `has_secure_token`. |
| dom_testing_default_html_version | yes | Suite passes under it. |

### 7.2, 8.0 and 8.1 defaults

- **web_image_content_types (7.2):** no variants are used.
- **validate_migration_timestamps (7.2):** existing timestamps are valid.
- **yjit (7.2):** affects memory and performance only.
- **strict_freshness (8.0):** `ExportDownloadsController` sends both `etag` and `last_modified`. With strict freshness only `If-None-Match` counts. The blob checksum never changes, so the effect is harmless. Source-based only.
- **`Regexp.timeout = 1` (8.0):** the DOI regex and CSV parsing are bounded by size, so no effect is expected. Not tested.
- **8.1 defaults (suite passes under them):** `escape_json_responses = false`, `action_on_path_relative_redirect = :raise` (the app only redirects through route helpers), `raise_on_missing_required_finder_order_columns`, `escape_js_separators_in_json = false`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete`.
- **`enqueue_after_transaction_commit`:** stays `false` on 8.1. Do not turn it on. `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue under the row lock so a failed enqueue rolls the change back.

## C. Rollout and rollback

1. **Ship on 7.0 first:** findings 1, 3, 4, 5 and 8–19, plus the slug-permit fix. All of these passed on 7.0 in the prep variant (17 and 18 were applied there too). Finding 19 was not applied anywhere; it is source-based.
2. **Then the upgrade commit:** the Gemfile change plus findings 2, 6 and 7, all with `load_defaults 7.0`.
3. **Stored data:** tags, preferences and session cookies interoperate in both directions (executed).
4. **Queued and retrying Sidekiq jobs:**
   - Without finding 19, a rollback leaves 8.1 Digest payloads failing on 7.0.
   - `ExportJob` is a native Sidekiq job and is unaffected.
   - Already-retrying `:exponentially_longer` jobs keep their scheduled payloads.
5. **Default adoption later:** move `load_defaults` up one version per deploy. Turn on the 7.1 message and cache serializers only after rollback to 7.x is no longer needed.
6. **Follow-up:** 8.1 warns `The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2`. Before Rails 8.2, upgrade to sidekiq ≥ 7.3.3 together with redis-client and rack 3 / puma 6. At that point `ExportJob.perform_async(export.id, { format: "markdown" })` needs string keys under Sidekiq 7 strict args.

## Not verified

- System and browser tests (`bin/rails test:system`).
- A real Sidekiq server process and a `rails server` boot on Puma 5 / Rack 2. I only ran runners, integration sessions and a production-mode asset precompile.
- Strict-freshness requests and the HTML5 sanitizer against existing stored rich text.
- Repair 19, as noted.
- Production with `report_deprecations = false` will hide the Sidekiq deprecation.

The test databases `mn_up_*` are still on the local Postgres; drop them with `dropdb`.

---

**Problems in the plan:**
- **Numbering:** the summary says "15 required repairs" but section A lists 19. The rolling-deploy bug it calls "finding 14" is actually finding 19.
- **Contradiction about finding 19:** rollout step 1 says all its findings "passed on 7.0 in the prep variant." But finding 19 itself says that fix was never applied or run anywhere.
- **"Optional" fix that isn't:** the `serialize :preferences, coder: YAML` change is listed as optional, yet its own note says it needs 8.1. It can't go into the 7.0 prep release.

**Cleanup:** the planner left test databases named `mn_up_*` on your local Postgres. You can remove them with `dropdb`.

If you want me to make the changes, I'd do it in the plan's order. First a release on 7.0 with the fixes that work there, then the Gemfile change plus findings 2, 6 and 7. Tell me if you want me to go ahead.