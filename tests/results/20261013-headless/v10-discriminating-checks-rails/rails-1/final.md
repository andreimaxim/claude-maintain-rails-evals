# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

On Rails 8.1.0 the app as it stands does not boot. With the repairs below, the full suite passes on 8.1.0: 46 runs, 0 failures, under both `load_defaults 7.0` and `load_defaults 8.1`. A real Sidekiq 6.5.12 worker on 8.1 also processed an export, a scheduled reminder, a digest and a citation retry correctly.

Several breakages only appeared when the app ran, because the tests either cover them only partly or never reach them:
- the filtered notes list returns a 500;
- a failed import now saves part of the file;
- the import receipt silently loses the DOI column;
- digest jobs queued by 8.1 crash on a 7.0 worker (this matters during rollout or rollback);
- the digest date shifts to the reader's own day.

Nothing was changed in `/home/user/workspace/repo` (`git status` is clean).

## How the experiments were run
- **Copies:** two clones, each with its own databases and Redis DB:
  - `/tmp/up/app`, branch `up81`: Rails 8.1.0, databases `margin_notes_up_dev` / `margin_notes_up_test`, `REDIS_URL=redis://localhost:6379/9`.
  - `/tmp/up/app70`: Rails 7.0.8.7 plus only the repairs that also work on 7.0, databases `margin_notes_up70_*`, Redis DB 10.
- **Storage and mail:** `storage/`, `tmp/storage`, `tmp/mails` and the cache sit under each copy's own root.
- **Ruby:** 3.3.6.
- **Resolved gems (8.1 copy):** rails 8.1.0, json 2.21.2 (pinned, see R1), sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, puma 5.6.9, pg 1.6.0, action_text-trix 2.1.19. Lockfiles are saved at `/tmp/up/Gemfile.lock.81` (unpinned) and `/tmp/up/Gemfile.lock.81-json2` (pinned).
- **Defaults testing:** the 8.1 copy reads `config.load_defaults ENV["LOAD_DEFAULTS"]`. That switch exists only for the experiment and is not part of the recommended patch.
- **Change summary:** `/tmp/up/changes.txt`.
- **Scripts** (in `/tmp/up/scripts/`):
  - `probe.rb` and `import_return.rb`: model-level probes.
  - `requests.rb`: request-level checks run with `RAILS_ENV=test`.
  - `aj_dump.rb` / `aj_load.rb`: cross-version job payloads.
  - `cookie.rb`: cross-version session cookies in production mode.
  - `fresh.rb`: conditional-GET freshness.
  - `e2e.rb`: real Sidekiq run.
- **Logs** (in `/tmp/up/`):
  - Tests: `test70.log` (baseline), `test81*.log` (repair iterations), `test81-defaults-<v>[-fixed].log`, `test81-final*.log`, `test70-prep-final.log`.
  - Probes: `probe70.log`, `probe81*.log`.
  - Request checks: `req81fixed.log`, `req81unrepaired.log`, `req70prep.log`, `req81-d*-cache.log`.
  - Sidekiq: `sidekiq81.log`.
- **Patches:**
  - `/tmp/up/repairs-81-final.patch`: everything; it also contains the `LOAD_DEFAULTS` switch, which you should drop.
  - `/tmp/up/repairs-70-preparatory.patch`: only the changes that also work on 7.0.

## Required changes (things break if nothing is done)

**R1. A `json` 3.x gem breaks every JSON column.** The resolver picked json 3.1.0 for activesupport 8.1.0. Every serialized JSON read then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`, raised from `json/common.rb:291` via `ActiveSupport::JSON.decode` (for example `Note#tags`).
- **Fix:** add `gem "json", "~> 2.7"` to the Gemfile in the upgrade commit.
- **Check:** with the pin, the suite went from 28 failures to the remaining real issues.
- **Open question:** this was not checked against later 8.1.x patch releases.

**R2. The app fails to boot because of `config/initializers/action_text.rb`.** It now raises:
`undefined method '+' for nil (NoMethodError)` at `ActionText::ContentHelper.allowed_tags += ...`

Since 7.1, `allowed_tags` starts as nil and the sanitizer is chosen in an `after_initialize` hook.
- **Fix:** inside `Rails.application.config.after_initialize { ActiveSupport.on_load(:action_view) { ... } }`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`.
- **Works on 7.0:** yes.
- **Check:** render a note body containing `<details><summary>`, an `onclick` attribute and a `<script>`. Under both 7.0 and 8.1 defaults (that is, the HTML4 and HTML5 sanitizers) the output was `<details><summary>More</summary>hidden</details><p>p</p>bad()`. Details are kept and the script and handler are stripped. Without the fix the app does not boot.

**R3. Old `enum` syntax no longer loads.** `enum status: {...}, _prefix: true` in `app/models/note.rb` raises `wrong number of arguments (given 0, expected 1..2)` during eager load.
- **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Works on 7.0:** yes; `Citation` already uses this form.

**R4. `serialize :tags, JSON` no longer loads.** It raises `wrong number of arguments (given 2, expected 1)`.
- **Fix:** `serialize :tags, coder: JSON`.
- **Must not ship on 7.0.** I tested it there: 7.0 silently ignores `coder:` and uses its YAML coder, so 7.0 servers would write YAML into `notes.tags`, which 8.1 would then fail to parse as JSON. Ship it in the same deploy as the Rails bump.
- **Stored data:** the existing `["a","b"]` text reads back correctly on 8.1.

**R5. The `/notes` + `/journal` route breaks boot.** `get "/notes", "/journal", to:` raises `Wrong number of arguments (expect 1, got 2)` in the route mapper.
- **Fix:** two routes, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`.
- **Works on 7.0:** yes; the route names are unchanged (`bin/rails routes` checked on both).

**R6. `alias_attribute :highlight_color, :color` fails on first use of `Note`.** `color` is a `store_accessor`, not an attribute. Any `Note.new`, including in import and export code, raises:
`ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method ...'`
- **Fix:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Works on 7.0:** yes.
- **Check:** the create and update tests for highlight colour pass; the probe got `settings == {"color"=>"green"}`.

**R7. `Rails.application.secrets` was removed in 7.2.** `Citation::Provider.new` raises `NoMethodError: undefined method 'secrets'`, so all citation lookups fail.
- **Fix:**
  - move the settings to `config/citation_provider.yml`, keeping the same ERB and `.to_json` quoting;
  - in `config/application.rb`, set `config.x.citation_provider = config_for(:citation_provider)`;
  - read `Rails.configuration.x.citation_provider.to_h` in the provider;
  - update the test that swaps settings in and out;
  - delete `config/secrets.yml`.
- **Works on 7.0:** yes (46/46).
- **Check:** in production mode with `CITATION_PROVIDER_USER=00123 CITATION_PROVIDER_PASSWORD='sample: value # keep'`, the values come through unchanged. With no environment variables, the URL is nil, giving the same "No citation provider is configured" path as today.
- **Deploy note:** check that production does not rely on anything else in `secrets.yml`, such as `secret_key_base`. It only contains `citation_provider`.

**R8. Exports fail.** `Export#generate` uses `fragments.sum`, and Active Support's `Enumerable#sum` override was removed in 7.1. It raises `TypeError: String can't be coerced into Integer` (`app/models/export.rb:42`) after progress has already been saved. In production the export would stay "working" while Sidekiq retries it.
- **Fix:** `fragments.join`.
- **Works on 7.0:** yes.
- **Check:** with a real worker, the export completed and its file starts with `# E2E`.

**R9. The filtered notes list returns a 500.** `@notes.where(notebooks: @notebook)` in `NotesController#index` used to be accepted as the plural of the association name; that was removed in 7.2. It now raises:
`PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`
- **Fix:** `where(notebook: @notebook)`.
- **Works on 7.0:** yes.
- **Check:** GET `/notes?notebook_id=<A>` with notes in notebooks A and B should return 200 with only A's note. That was observed after the fix; without it the request raises the error above.

**R10. Every notes list page returns a 500.** `form_with(model: nil, ...)` in `app/views/notes/index.html.erb` raises:
`ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`
This hits both `/notes` and `/journal`.
- **Fix:** `form_with(url: notes_path, method: :get, ...)`. The parameter names stay unscoped.
- **Works on 7.0:** yes.

**R11. Import receipt loses the DOI.** `citation[:id]` in `Import#receipt` no longer returns the custom primary key (`doi`). The receipt CSV becomes `"title,doi\nCited,\n"` with no error.
- **Fix:** `citation&.doi`.
- **Works on 7.0:** yes.
- **Check:** import one cited row, then GET `.../imports/:id.csv`; the result should contain the DOI. Not covered by tests.

**R12. A failed import now saves part of the file.** `Import#apply` does `return false unless row.note.save` inside `transaction`. Since 7.2 that early return commits the transaction instead of rolling it back.
- **Observed without the fix:** for a CSV with one good row and one untitled row, the request returns 422 but saves 1 import and 1 note. The test's `record_counts` went from `[0,3,0,1]` to `[1,4,1,2]`. On 7.0 nothing was saved.
- **Fix:**
  ```ruby
  saved = false
  transaction do
    save!
    saved = rows.all? { |row| row.note.save }
    raise ActiveRecord::Rollback unless saved
  end
  saved
  ```
- **Works on 7.0:** yes. A successful import still saves everything, and the controller's error re-render still works because it calls `preview` again.
- **Data check:** audit production for imports whose notes are fewer than their CSV rows, if 8.1 ever ran without this fix.

**R13. Annotations disappear from the import preview.** `HashWithIndifferentAccess#stringify_keys` now also converts integer keys. `@import.annotations.stringify_keys[row.line]` therefore returns nil, and the preview stops showing annotations without any error.
- **Fix:** drop the `.stringify_keys` in `app/views/imports/preview.html.erb`. Integer keys still work in the hash on both versions.
- **Check:** the preview contains `<dd>my note</dd>`. Without the fix this was false on 8.1.

**R14. Reminder scheduling fails.** `NoteReminderJob.set(wait_until: reminder_epoch)` with an Integer raises `NoMethodError: undefined method 'utc' for an instance of Integer`.
- **Fix:** `set(wait_until: Time.at(reminder_epoch))`.
- **Works on 7.0:** yes.
- **Check:** with a real Sidekiq worker, a reminder 4 seconds out was delivered (`reminder_sent_at` set, "Reminder:" mail written).

**R15. Citation retries break.** `retry_on ..., wait: :exponentially_longer` raises `Couldn't determine a delay based on :exponentially_longer` when a retry is scheduled.
- **Fix:** `wait: :polynomially_longer`, which uses the same formula.
- **Does not work on 7.0**, so it must ship with the bump.

**R16. Test configuration.** `config.action_dispatch.show_exceptions = false` is no longer accepted. Exceptions get rendered instead of raised, so "RecordNotFound expected but nothing was raised" failures appear in the authorization tests.
- **Fix:** `:none` in `config/environments/test.rb`.
- **Does not work on 7.0:** there `:none` is truthy and would show exceptions. Ship with the bump.

**R17. The digest covers the wrong day.** Since 7.1, Active Job keeps the time zone of `TimeWithZone` arguments. A Tokyo reader's digest is therefore built for the Tokyo date, against the documented UTC day: the test expected "October 05" and got "October 04".
- **Fix (mailer side):** `requested_at = params[:requested_at].in_time_zone`. This also normalizes jobs already queued by either version.
- **Works on 7.0:** yes; it does nothing there.
- **Check:** serialize a request at 2026-10-14 23:30 UTC for a Tokyo reader. On 8.1, `to_date` gives 2026-10-15 without the fix and 2026-10-14 with it. A 7.0 worker reading the same payload also gives 2026-10-14.

**R18. Digest jobs queued by 8.1 crash on 7.0 workers (rollout and rollback).** Since 7.2, BigDecimal arguments are always serialized with `BigDecimalSerializer`. When a 7.0 worker reads a DigestJob queued by 8.1, it raises:
`ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`
The reader's Redis reservation for the day stays in place, so they cannot request again that day.
- **Fix:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already calls `BigDecimal(params[:completion])`.
- **Works on 7.0:** yes.
- **Check:** with the fix, an 8.1-written payload loads on 7.0 and gives `BigDecimal()=0.3333`.

**R19. Next-day reminder offset (also needed if the 8.0 default is adopted).** `reminder_at.to_time + 86_400` in `Note#next_day_reminder_at` now keeps the zone instead of the UTC offset. The test expecting `2026-11-01T09:00:00-04:00` across the DST change failed.
- **Fix:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. This keeps the documented "same UTC offset" behavior whatever the `to_time` setting, which is itself deprecated in 8.1.
- **Works on 7.0:** yes.
- **Check:** for an Eastern-time reminder on 2026-10-31 13:00 UTC, the result should be `2026-11-01 09:00:00 -0400`.

**Not a problem:** Sidekiq 6.5.12 worked with 8.1. It does log `The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2`; see "Later work" below.

## Changes needed only when adopting new defaults

I ran the suite with `load_defaults 7.1`, `7.2`, `8.0` and `8.1`. Before these repairs there were 2–3 errors at each level; after them, all levels pass 46/46.

**D1. `default_column_serializer = nil` (7.1).** `serialize :preferences` in `Notebook` then refuses to boot: `missing keyword: :coder If no default coder is configured...`
- **Fix:** `serialize :preferences, coder: YAML`. Stored YAML (`"---\nexport_heading: H\n"`) still reads back.
- **Version note:** on 7.0 this is silently ignored but harmless; it is only useful from 8.1 on.

**D2. `raise_on_assign_to_attr_readonly = true` (7.1).** Saving notebook settings raises `ActiveRecord::ReadonlyAttributeError: slug` at `notebooks_controller.rb:26`, because the form posts the hidden `slug` field.
- **Fix:** remove `:slug` from `notebook_params`. Keep the hidden field: a test explicitly requires it, and forms rendered by old servers still post it.
- **Other paths:** on create the slug is derived from the name anyway, so creation is unchanged.
- **Works on 7.0:** yes.

**D3. `raise_on_invalid_cache_expiration_time = true` (7.1).** The exports page raises `Cache expiration time is invalid, cannot be negative: -60.0` from `exports/_export.html.erb:26` when an export has expired. With the old setting on 8.1 this is reported as a handled error instead (from the source, not observed).
- **Fix:** `expires_in: [ export.expires_at - Time.current, 1.second ].max`.
- **Works on 7.0:** yes; the test for the cached availability indicator passes under all defaults.

**D4. `postgresql_adapter_decode_dates = true` (7.2).** The activity report raises `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`.
- **Fix:** `select("CAST(DATE(notes.created_at) AS text) AS day, ...")`. This keeps `Date.iso8601` strict and the date ordering unchanged.
- **Works on 7.0:** yes.

## New defaults by release

The app keeps every old value: it calls `load_defaults 7.0` and sets none of these explicitly. The change summary missed 8.0's `Regexp.timeout` and all of 8.1's defaults; I read those from the `railties-8.1.0` source.

**7.1**

| Setting | Effect for this app if adopted |
|---|---|
| `raise_on_assign_to_attr_readonly` | D2 |
| `default_column_serializer` | D1 |
| `raise_on_invalid_cache_expiration_time` | D3 |
| `action_view` / `action_text` `sanitizer_vendor` (HTML5) | Handled by R2; output checked above |
| `message_serializer` / `use_message_serializer_for_metadata` | Tested: a session cookie written by 8.1 with 8.1 defaults was read by 7.0, and the reverse also worked. Still enable only after the fleet is fully on 8.1. |
| `use_big_decimal_serializer`, `commit_transaction_on_non_local_return`, `allow_deprecated_singular_associations_name`, `allow_deprecated_parameters_hash_equality` | Their old values were removed later, so they are effectively forced (R18, R12, R9) |
| `dom_testing_default_html_version` (HTML5) | Suite passes |
| `marshalling_format_version` | Only affects cached Active Record objects; the app caches fragments only |
| `belongs_to_required_validates_foreign_key` | Notebooks are assigned only through owned records, so "must exist" behaves the same |
| Encryption digest settings, sqlite strict strings, after-commit callback order and first-instance settings, `before_committed_on_all_records`, `generate_secure_token_on`, `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size` | No effect: no encryption, no after-commit callbacks, no secure tokens, no query log tags; logging only |

**7.2**

| Setting | Effect for this app if adopted |
|---|---|
| `postgresql_adapter_decode_dates` | D4 |
| `enqueue_after_transaction_commit` | This config no longer exists in 8.1, where the class-level default is `false`, so in-lock enqueues stay immediate. Do not opt in: `Citation#request_enrichment` and `Note#schedule_reminder` rely on a failed enqueue rolling back. This only matters if you stop at 7.2 with 7.2 defaults. |
| `yjit` | Enabled; superseded in 8.1 by `!Rails.env.local?`, so YJIT runs in production. Expect more memory use. |
| `validate_migration_timestamps` | Existing migrations pass; future-dated timestamps would be rejected |
| `web_image_content_types` | No effect: no variants |

**8.0**

| Setting | Effect for this app if adopted |
|---|---|
| `to_time_preserves_timezone = :zone` | Covered by R19 |
| `strict_freshness` | At the unit level, `fresh?` changes for "matching ETag + older If-Modified-Since" (false → true). At HTTP level both versions already returned 304 for the export download, consistent with `Rack::ConditionalGet` giving If-None-Match precedence. No user-visible change expected. |
| `Regexp.timeout = 1` | Process-wide. CSV parsing and the DOI regex are linear; low risk. |

**8.1**

| Setting | Effect for this app if adopted |
|---|---|
| `render_tracker = :ruby` | Fragment cache keys may change once (cold cache) |
| `remove_hidden_field_autocomplete` | The hidden `import[csv]` and `notebook[slug]` fields lose `autocomplete="off"` |
| `escape_json_responses`, `escape_js_separators_in_json` | No JSON views or `render json:` |
| `action_on_path_relative_redirect = :raise` | All redirects use helpers or absolute paths |
| `raise_on_missing_required_finder_order_columns` | Every model has a primary key |

**Recommendation:** ship the bump with `load_defaults 7.0` plus R1–R19. Adopt the new defaults afterwards, one release at a time, using the generated `new_framework_defaults_*` files, with D1–D4 already in place.

## Rollout order and rollback
1. **Deploy on 7.0 first:** `/tmp/up/repairs-70-preparatory.patch`, which is R2, R3, R5–R14 and R17–R19 plus D2–D4. Verified: 46/46 on 7.0, production eager load succeeds, and request results match 8.1.
2. **Then deploy the bump** together with R1, R4, R15 and R16 (none of these work on 7.0).
   - Stored data stays compatible: tags (JSON) and preferences (YAML) read back on 8.1.
   - Session cookies work in both directions.
   - Queued jobs are compatible in both directions once R18 is in: a 7.0 worker ignores the `time_zone` and `scheduled_at` keys written by 8.1.
3. **Rollback hazards:**
   - DigestJobs queued before R18 is deployed.
   - Partial imports created if 8.1 ran without R12.
   - `db/schema.rb` regenerated as `Schema[8.1]` by any migration run on 8.1; 7.0 cannot load it.
   - Adopting the 7.1 message-serializer defaults before rollback is no longer a possibility.

## Unverified, still to check
- **Rich-text editor in a browser.** No browser was available and there are no system tests. On 8.1, `*= require trix` in `app/assets/stylesheets/actiontext.css` now resolves to Trix 2.1.19 CSS from action_text-trix, while the layout still loads the vendored Trix 1.3.5 JS. Action Text 8.1's `actiontext.js` is a UMD build. Assets precompile on both versions. I recommend vendoring the Trix 1.3.5 CSS next to the JS for the bump, and leaving a move to Trix 2 as separate work. Then run a browser check: edit an existing note that has a link and an attachment, save it, and confirm the HTML round-trips; also check that toolbar styling and direct upload work.
- **Fragment cache under caching:** the clamp in D3 is validated by the test suite. My `CACHE=1` request run probably did not exercise the memory store.
- **json 3 compatibility in later 8.1.x patches.**
- **Production `secret_key_base` source:** credentials or ENV still need confirming.

## Later work (not required for 8.1.0)
Rails 8.2 removes the built-in Sidekiq adapter, which means moving to Sidekiq 7.3.3+. That move would itself break two things:
- `ExportJob.perform_async(id, { format: "markdown" })`: symbol keys raise under strict args. Use string keys now; that works on both versions.
- `User#request_digest` uses `if redis.sadd(...)`: with redis-client, `sadd` returns an Integer, and 0 is truthy, so the once-per-day guard stops working. Use `sadd?` or compare to 1.

Also add `gem "csv"` before moving to Ruby 3.4, since `Import` depends on it.

**Flagged by the summary but not relevant:** the Action Cable command callbacks and the `has_secure_password reset_token` entries do not affect this app.

**Scratch resources left behind for cleanup:** databases `margin_notes_up_dev`, `margin_notes_up_test`, `margin_notes_up70_dev`, `margin_notes_up70_test`; Redis DBs 9 and 10; directories `/tmp/up/app` and `/tmp/up/app70`.

---

I haven't upgraded Rails yet; this is only the plan. Your repository is unchanged (`git status` is clean). I'd do it in two deploys:
1. The 7.0-compatible fixes first (`/tmp/up/repairs-70-preparatory.patch`).
2. The Rails bump, together with the fixes that only work on 8.1: R1, R4, R15 and R16.

Want me to apply the first step on a branch? I can also clean up the scratch databases, Redis DBs 9–10 and `/tmp/up` whenever you like.