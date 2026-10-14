# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade can be done, but the app does not boot on 8.1.0 without code changes. I found 17 things that break, and three of them lose or change data without any error:

- **Partial imports get saved.** A failed import now saves some rows instead of none.
- **Import receipts lose their DOIs.** The DOI column in the receipt CSV comes out empty.
- **Digest emails cover a different day.** The digest switches from the UTC day to the reader's local day.

There is also a rollout risk: digest jobs queued by 8.1 fail on workers still running 7.0.

In a disposable copy with these repairs applied, the full suite passes on 8.1.0 (46 runs, 340 assertions, 0 failures), as does an eager-loaded run. With `load_defaults 8.1` on top, three more failures appear; a repair for each was tested and passes.

I did not change the working repository.

## Test setup

- **Copies:** `/tmp/upg/base` (7.0.8.7, the control), `/tmp/upg/v71` (7.1.6), `/tmp/upg/prep` (7.0 plus the repairs that work on both versions), `/tmp/upg/v81` (8.1.0, `load_defaults 7.0`), `/tmp/upg/v81d` (8.1.0, `load_defaults 8.1`).
- **Isolation:**
  - Separate databases named `upg_{base,prep,v71,v81,v81d}_{dev,test}`.
  - A separate Redis on port 6390 (`REDIS_URL=redis://127.0.0.1:6390/0`, now shut down).
  - Each copy uses its own `tmp/storage` and `storage` folders.
  - Production-mode runs pointed `DATABASE_URL` at `upg_base_dev`.
  - `mise.toml` was removed from the copies (I did not trust it); `PATH` pointed directly at Ruby 3.3.6. The environment settings are in `/tmp/upg/env.sh`.
- **Gems:** new gem versions were installed into the shared Ruby 3.3.6 gem directory, since Bundler has no per-copy path here.
- **Dependencies resolved for 8.1.0** (`/tmp/upg/logs/lock-diff.txt`): rack stays at 2.2.24 because Sidekiq 6.5 holds it there. Also puma 5.6.9, sidekiq 6.5.12, concurrent-ruby 1.3.4, action_text-trix 2.1.19, rackup 1.0.1, and json 3.1.0 at first, pinned down to 2.21.2.
- **Results:**
  - Control (7.0): 46 runs, 0 failures (`base-test.log`).
  - First 8.1 run: 46 errors (`v81-test1.log`).
  - Final 8.1 run: 0 failures (`v81-test-final.log`, and `v81-test-eager.log` with `CI=1`). `zeitwerk:check` passes.
  - Puma 5.6.9 boots on 8.1 and serves `/notes` (302), `/journal` (302) and `/session/new` (200) (`v81-server.log`).
- **Candidate diff:** `/tmp/upg/v81-candidate.diff`. The change summary from the script is `/tmp/upg/changes.txt`.

## Required changes (each confirmed by running the copy)

"Works on 7.0" means I tested the change in the `prep` copy and the 7.0 suite still passes (`prep-test2.log`), so it can ship before the version bump.

1. **json 3.x breaks every JSON column read.** Rails 8.1.0 does not limit json, so Bundler picks 3.1.0.
   - Error on every `serialize ... JSON` load: `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291` via `active_support/json/decoding.rb:25`.
   - Fix: add `gem "json", "< 3"` to the Gemfile (resolves to 2.21.2). Remove the pin once a later Rails patch supports json 3.

2. **Action Text initializer stops the app booting** (`config/initializers/action_text.rb`). From 7.1 the default `allowed_tags` is `nil` and computed later.
   - Error: `undefined method '+' for nil (NoMethodError)`.
   - Fix (works on 7.0, tested): set the list inside `Rails.application.config.after_initialize`, as `ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - Because it uses whichever sanitizer is active, it keeps working if the HTML5 sanitizer is adopted later. The rich-text sanitizing test passes.

3. **Keyword-style `enum` is removed in 8.0** (`app/models/note.rb:10`).
   - Error: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - Fix (works on 7.0): `enum :status, { draft: 0, ready: 1 }, prefix: true`. Method names and stored integers stay the same.

4. **`serialize` with a positional coder is removed in 7.2.**
   - Fix: `serialize :tags, coder: JSON` (`note.rb`) and `serialize :preferences, coder: YAML` (`notebook.rb`). Stored data is read the same way.
   - **This does not work on 7.0.** The `coder:` keyword is silently ignored there and `tags` comes back as a raw String (`undefined method 'any?' for an instance of String` in `notes/_tags.html.erb`).
   - Apply it at the 7.1 step; 7.1.6 warns "Passing the coder as positional argument is deprecated".
   - Spelling out `coder: YAML` also protects `preferences` if 7.1's `default_column_serializer = nil` is adopted later.

5. **`alias_attribute` pointing at a store accessor is removed in 7.2** (`note.rb:14`).
   - Error: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
   - Fix (works on 7.0): `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. The form, the strong parameters and the highlight views were covered by tests.

6. **One route drawn for two paths is removed in 8.1** (`config/routes.rb:18`).
   - Error: `ArgumentError: Wrong number of arguments (expect 1, got 2)`, then `notes_path` is undefined.
   - Fix (works on 7.0): `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. Route names stay `notes` and `journal`, and `POST /notes` is unchanged.

7. **`Rails.application.secrets` is removed in 7.2** (`app/models/citation/provider.rb:13`, the test helper, `config/secrets.yml`).
   - Error: `NoMethodError: undefined method 'secrets'`.
   - Fix (works on 7.0):
     - Add `config/citation_provider.yml`, organized by environment with no `citation_provider:` wrapper key. My first attempt kept that nesting and sent `Basic Og==`, an empty user and password.
     - Add `config.x.citation_provider = config_for(:citation_provider)` in `application.rb`.
     - Read `Rails.configuration.x.citation_provider.to_h` in the provider.
     - Update `test/controllers/citation_enrichments_controller_test.rb`.
   - Keep the `.to_json` quoting so values like "00123" and "sample: value # keep" survive. The credentials test that boots a fresh process passes.
   - Production must still export `CITATION_PROVIDER_*`; I did not check the real deployment environment.

8. **Filtering notes by notebook crashes** (`notes_controller.rb:12`, `where(notebooks: @notebook)`). Rails 7.2 removed using the plural association name.
   - Error: `PG::UndefinedColumn: column notes.notebooks does not exist`.
   - Fix (works on 7.0): `where(notebook: @notebook)`.

9. **The search form crashes** (`views/notes/index.html.erb:12`, `form_with(model: nil, ...)`).
   - Error: `Passed nil to the :model argument, expect an object or false`.
   - Fix (works on 7.0): remove `model: nil`.

10. **Scheduling a reminder crashes** (`Note#schedule_reminder`, `set(wait_until: reminder_epoch)` with an Integer). From 7.1, `scheduled_at` is a Time.
    - Error: `NoMethodError: undefined method 'utc' for an instance of Integer`.
    - Fix (works on 7.0): `wait_until: Time.at(reminder_epoch)`. The test still asserts the exact `at` epoch.

11. **`:exponentially_longer` is removed in 7.2** (`citation_enrichment_job.rb:7`).
    - Error: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
    - Fix: `:polynomially_longer`, which uses the same formula. It only exists from 7.1, so make this change at the 7.1 step (7.1.6 prints the deprecation warning).

12. **The Markdown export crashes** (`Export#generate`, `fragments.sum` on strings). Rails 7.1 removed its `Enumerable#sum` override.
    - Error: `TypeError: String can't be coerced into Integer`.
    - Fix (works on 7.0): `fragments.join`.

13. **Failed imports are partly saved, with no error.** `Import#apply` uses `return false` inside `transaction`. From 7.2 that commits instead of rolling back.
    - Observed: the invalid-import test's record counts went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. The import, its notes and its citation were saved even though the reader was told nothing was saved.
    - Fix (works on 7.0): `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`, set `applied = true` after it, and return `applied`. Both the successful and the rejected path pass.
    - Data check: on 7.0 nothing like this was committed. Existing rows are only at risk if a 7.2+ build runs before this fix.

14. **Import receipts lose the DOI, with no error** (`Import#receipt`, `citation[:id]`). The citations table's primary key is `doi`; Rails 7.2 stopped returning the custom primary key for `[:id]`.
    - Observed: the receipt reads `On idleness,` instead of `On idleness,10.1000/Essays.1`.
    - Fix (works on 7.0): `citation&.doi`. Receipts are built at request time, so old imports are fixed too.

15. **Import preview hides annotations** (`views/imports/preview.html.erb:22`, `annotations.stringify_keys`). Rails 8.0 now converts the integer line-number keys to strings.
    - Observed: the "Annotation" entry is missing and `#line_2 dd` shows the DOI instead.
    - Fix (works on 7.0): use `@import.annotations` without `stringify_keys`.

16. **Digest emails cover the reader's local day instead of the UTC day.** From 7.1, Active Job keeps the time zone of `requested_at`. That conflicts with the UTC-day reservation key in `User#request_digest` and the comment in `DigestMailer`.
    - Observed: subject `October 04, 2026` instead of `October 05, 2026`. The notes listed change the same way.
    - Fix (works on 7.0): `requested_at = requested_at.utc` in `DigestMailer#daily_digest`. This covers jobs queued under 7.0 (no zone stored, read as UTC) and jobs queued under 8.1 (zone stored). Both payloads produced "October 05, 2026" on 8.1 (`/tmp/upg/run_payload.rb`).

17. **The "24 hours later" preview shows a different UTC offset.** Rails 8.1 always keeps the time zone in `to_time`.
    - Observed: across the DST change it no longer shows `2026-11-01T09:00:00-04:00` (the next-day preview selector found 0 matches).
    - The stored epoch is unchanged: it is still the reminder plus 86,400 seconds.
    - Fix (works on 7.0): `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. This keeps the documented "keeps the reminder's offset" behavior.
    - If you would rather show the wall-clock time after the DST change, that is a product decision and the test and comment need updating.

**Test configuration (`config/environments/test.rb`).** `show_exceptions = false` is deprecated in 7.1. On 8.1 it no longer re-raises, so tests that expect `RecordNotFound` saw 302/500 responses instead. Change it to `:none` at the 7.1 step; 7.0 only accepts true or false.

## Optional framework defaults

This app calls `load_defaults 7.0`. On 8.1.0 it keeps the old value for every setting below unless noted. The "Effect" column is for this app.

**7.1**

| Setting | Effect if adopted |
|---|---|
| `raise_on_assign_to_attr_readonly` | **Breaks** (tested): `ActiveRecord::ReadonlyAttributeError: slug` when updating notebook settings, because the form sends the slug back. Repair (tested under both defaults): permit only `:name, :export_heading`. `assign_slug` already overrides any submitted slug on create, so creation is unchanged. |
| `raise_on_invalid_cache_expiration_time` | **Breaks** (tested): `Cache expiration time is invalid, cannot be negative: -60.0` in `exports/_export.html.erb:26` once an export has expired. Repair (tested under both defaults): `expires_in: [export.expires_at - Time.current, 0].max`. A cached fragment is still served until its key changes, a fresh render of an expired export still works, and the test that a cached indicator does not authorize a download still passes. Production uses the default file store (`tmp/cache`). |
| `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata` | **Rollback risk** (tested in production mode): tokens made by 8.1 with these on cannot be read by 7.0. The 7.0 reader crashed with `undefined method 'unpack1' for nil` in `strict_decode64` on such a signed ID. Action Text attachment signed IDs stored in note bodies are one example. With the 7.0 defaults, tokens worked in both directions. Adopt these only after rollback to 7.0 is no longer needed. |
| `cache_format_version 7.1` | Entries written under 7.1 cannot be read by 7.0 after a rollback. Clear `tmp/cache` on rollback. |
| `default_column_serializer = nil` | Safe once repair 4 spells out `coder: YAML`. Without it, `serialize :preferences` would fail. |
| `sanitizer_vendor` (HTML5) for Action View and Action Text | Repair 2 follows the active sanitizer, so `details` and `summary` stay allowed. Sanitized output may differ slightly; untested beyond the existing test. |
| `belongs_to_required_validates_foreign_key = false` | Skips the parent query on unchanged foreign keys. Low risk. |
| `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction` | No-op: the app defines no commit callbacks. |
| `dom_testing_default_html_version :html5` | All tests passed under `load_defaults 8.1`, which includes it. |
| `marshalling_format_version`, `precompile_filter_parameters`, `generate_secure_token_on`, encryption hash and SHA-1 settings, `query_log_tags_format`, `debug_exception_log_level`, sqlite strict strings, `log_file_size`, `add_autoload_paths_to_load_path`, new default headers | No-op or low impact here: no encryption, no `has_secure_token`, no SQLite, Marshal-cached records not seen. |

The setting `allow_deprecated_parameters_hash_equality` was not looked at.

**7.2**

| Setting | Effect if adopted |
|---|---|
| `postgresql_adapter_decode_dates` | **Breaks** (tested): `TypeError: no implicit conversion of Date into String` at `notebook.rb:40` (`Date.iso8601(day)`) on the activity report. Repair (passes under both defaults): `day.to_date`. |
| `enqueue_after_transaction_commit` | The 7.2 setting does not exist in 8.1, and the per-job default is `false`. In 8.1 jobs are not deferred, so `Citation#request_enrichment` and `Note#schedule_reminder` keep queuing jobs inside the row lock, which is what they rely on. Do not turn deferral on. If you stop at 7.2 and adopt 7.2 defaults, deferral would remove the "failed enqueue rolls back" guarantee. |
| `validate_migration_timestamps` | Existing migration timestamps are in the expected format. |
| `web_image_content_types` adds webp | Affects only webp images in rich text, which skip PNG conversion. |
| `yjit` | Production performance only. |

**8.0**

| Setting | Effect if adopted |
|---|---|
| `strict_freshness` | `ExportDownloadsController#stale?` uses ETag and Last-Modified together. When both request headers are sent, only the ETag (blob checksum) counts. Little effect. |
| `Regexp.timeout = 1` | Could affect the DOI and CSV regular expressions only on pathological input. |

`to_time_preserves_timezone` is now forced on regardless (see item 17).

**8.1**

| Setting | Effect if adopted |
|---|---|
| `escape_json_responses = false` | The app renders no JSON (no Jbuilder views). |
| `action_on_path_relative_redirect = :raise` | All redirects use route helpers. |
| `raise_on_missing_required_finder_order_columns` | No error in tests. |
| `escape_js_separators_in_json`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete`, `yjit` | Low impact here; not separately tested. |

I recommend going to `load_defaults 8.1` one version at a time after the upgrade is stable. The three breaking defaults are listed above and their repairs pass under 8.1 defaults (`/tmp/upg/logs/v81d-test-final.log`).

## Rolling out with old and new versions running together

- **`BigDecimal` job arguments (`DigestJob`).** 8.1 always stores them as `BigDecimalSerializer`. 7.0 stored a raw `"0.5"` string, and Sidekiq warns the argument "do not serialize to JSON safely".
  - Tested: a 7.0 worker given an 8.1 payload raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. An 8.1 worker handles a 7.0 payload correctly.
  - Upgrade Sidekiq workers before or together with the web servers. During a rollback, 8.1 digest jobs will keep failing and retrying, and end up in the dead set after Sidekiq's retries run out.
  - To remove the risk: pass `reading_completion.to_s` from `User#request_digest`. Version-independent in principle (the mailer already calls `BigDecimal(...)`), but this was not run.
  - You can also pass through 7.1 with `use_big_decimal_serializer = false`; that setting is removed in 8.0.
- **Time-zone argument.** 8.1 adds a `time_zone` key to time arguments. Repair 16 makes the digest correct under both payload formats (tested). I did not test old/new handling of this key on its own: the only 7.0 run of an 8.1 payload failed earlier, on `BigDecimal`.
- **Scheduled reminders.** These can sit in Sidekiq's schedule for weeks. An 8.1 `NoteReminderJob` payload was read correctly by 7.0 (tested; `scheduled_at` is ignored there). The arguments are only a GlobalID.
- **Sidekiq adapter.** Rails' built-in `:sidekiq` adapter still works in 8.1 but logs "deprecated and will be removed in Rails 8.2". The fix is Sidekiq 7.3.3 or later, which also means redis-client and Rack 3 changes. Plan that as a separate step before Rails 8.2.
- **Local development secret.** It moves from `tmp/development_secret.txt` to `tmp/local_secret.txt` (seen in development). Local sessions and signed IDs made with the old secret become invalid. Development only.

## Order of work

1. **On 7.0, ship the changes that work on both versions** (tested together in `/tmp/upg/prep`): items 2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17. You can also add the optional `day.to_date`, cache-expiry and slug-permit repairs here (unrun on 7.0), and `reading_completion.to_s` (not run).
2. **Bump to 7.1.6.** With step 1's changes, the suite passes with 0 failures. The only deprecation warnings left are positional coder, `BigDecimal` serialization, `show_exceptions` and `exponentially_longer` (`v71-test.log`). Apply item 4, `:polynomially_longer` and `show_exceptions = :none` here.
3. **Bump to 7.2.x, 8.0.x and 8.1.0** with the json pin. At each version, run the suite with `CI=1`, `zeitwerk:check` and a boot. I did not run 7.2 or 8.0 separately; their deprecations were inferred from the 7.1 and 8.1 runs plus the changelog.
4. **Adopt framework defaults** separately, as described above.

## Not verified

- **Browser behavior:** no browser or chromedriver was available, and `test/system` is empty. Trix 1.3.5 (vendored) alongside Action Text 8.1's `actiontext.js` and the unused Trix 2.1.19 asset is unverified for editing, attachments and uploads. Needs a manual browser check.
- **Sidekiq end to end:** I did not run a real Sidekiq worker on 8.1. The proposed check is to run `bundle exec sidekiq` against the isolated Redis and process `ExportJob`, `DigestJob`, `NoteReminderJob` and `CitationEnrichmentJob`.
- **Production settings:** whether production has a `CITATION_PROVIDER_*` environment and which cache store it uses.
- **Stored data:** I did not inspect production data. The YAML `preferences` and JSON `tags` formats are unchanged in code, and old payloads in the Sidekiq retry and dead sets were not inspected.
- **Ruby 3.4 warnings:** `csv` and `mutex_m` will leave Ruby's default gems in 3.4. Add `gem "csv"` if you move to Ruby 3.4.

## Cleanup

Drop the `upg_*` PostgreSQL databases and `/tmp/upg`.

Files are in `/tmp/upg`:
- `v81-candidate.diff` — all repairs against the original code
- `changes.txt` — change summary from the script
- `logs/lock-diff.txt` — resolved dependency changes
- `logs/` — test, boot and bundle logs

---

**Notes:**

- **Nothing in your repository has changed yet.** The upgrade skill only plans the upgrade, so `Gemfile` still has `rails 7.0.8.7`. A tested diff of all the repairs is at `/tmp/upg/v81-candidate.diff`. I can apply it to a branch, following the order of work above, if you'd like.
- **The planning run left things on your machine.** It created the `upg_*` PostgreSQL databases and `/tmp/upg`, and installed newer gem versions into the shared Ruby 3.3.6 gem directory. I haven't removed any of these. Tell me if you want them cleaned up.