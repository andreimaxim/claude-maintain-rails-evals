# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but it can't be a version bump. Unchanged, the app does not boot on 8.1.0. Once it boots, 13 more breaks show up at runtime, and several of them lose or alter data silently. With the repairs below, the upgraded copy passes the whole suite (46 runs, 340 assertions, 0 failures, serial and parallel). It also boots in production mode, and every signed-in page returned 200 in a live server smoke test. Most repairs also work on 7.0 and can ship first. Three must ship together with the upgrade.

The working repository was not modified (`git status` is clean).

## How this was tested
- **Copies:** `/tmp/up/base` (unchanged 7.0), `/tmp/up/new` (8.1.0 with the old `load_defaults 7.0` kept), `/tmp/up/d81` (8.1.0 with `load_defaults 8.1`), and `/tmp/up/prep` (7.0 plus the repairs I claim also work on 7.0).
- **Isolated services:** a private Postgres 15 cluster (`/tmp/up/pg`, port 55432) and Redis (port 56379, one database index per copy), with separate database names per copy. Both services are stopped now.
- **Dependencies (`/tmp/up/new/Gemfile.lock`):** rails 8.1.0, sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, puma 5.6.9, minitest 5.27.0, concurrent-ruby 1.3.4. json was first 3.1.0, then 2.21.2 after the pin described in finding 1.
- **Logs:**
  - Change summary: `/tmp/up/changes.txt`
  - Bundle output: `/tmp/up/new-bundle.log`, `/tmp/up/new-bundle2.log`
  - Boot failures: `/tmp/up/new-boot.log`
  - Test runs in order: `/tmp/up/new-test1.log` … `new-test7.log`
  - Baseline: `/tmp/up/base-test.log` (46/325, green)
  - 8.1 defaults: `/tmp/up/d81-test.log`, `/tmp/up/d81-test7.log`
  - Prep copy on 7.0: `/tmp/up/prep-test.log` (green)
  - Experiment scripts: `/tmp/up/*.rb`

**The summary tool was incomplete:**
- It missed the job-time-zone change (finding 6) and the json 3 breakage (finding 1).
- It cited the wrong files for the `form_with(model: nil)` change.
- Its defaults list omits these, all of which 8.1's `load_defaults` sets:
  - `cache_format_version = 7.1`
  - `default_headers`
  - `add_autoload_paths_to_load_path`
  - `Regexp.timeout` (8.0)
  - every 8.1 default

## A. Required changes
"Executed" means I watched it fail on the upgraded copy and pass after the repair. "Prep-safe" means it also passes the 7.0 suite in `/tmp/up/prep`.

**1. json 3.x breaks every JSON column read (executed).** Active Support 8.1.0 declares `json >= 0`, so Bundler picks json 3.1.0. Active Storage blob reads then fail with `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291`, called from `active_support/json/decoding.rb:25`.
- **Repair:** add `gem "json", "< 3"` to the Gemfile (resolves to 2.21.2). It also works on 7.0.
- **Validate:** `test/models/note_test.rb:20` (the attachment-size test) fails without the pin and passes with it. A control is any `notes.tags` read.

**2. The Action Text initializer stops the app booting (executed, prep-safe).** `config/initializers/action_text.rb` fails with ``NoMethodError: undefined method `+' for nil``. From 7.1, `ActionText::ContentHelper.allowed_tags` stays `nil` until read (actiontext `content_helper.rb:69`).
- **Repair:** wrap it in `config.after_initialize` and start from `allowed_tags || (sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"])`, then add `details` and `summary`. The tested file is `/tmp/up/action_text_fix.rb`.
- **Validate (`/tmp/up/san.rb`):** render `<details><summary>…<script>…<img onerror>`. 7.0, 8.1 with the HTML4 sanitizer, and 8.1 with HTML5 all produced identical output: `details` and `summary` kept, `script` and `onerror` stripped.

**3. Enum keyword form is rejected (executed, prep-safe).** `note.rb:10`, `enum status: {...}, _prefix: true`, fails with `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.

**4. `serialize` needs `coder:` (executed, not prep-safe).** `serialize :tags, JSON` fails with `wrong number of arguments (given 2, expected 1)`.
- **Repair:** `serialize :tags, coder: JSON`. Also change `Notebook` to `serialize :preferences, coder: YAML` now, because `load_defaults 7.1` raises `missing keyword: :coder` without it.
- **Must ship with the upgrade:** on 7.0, `coder: JSON` is silently ignored and the column gets YAML. Measured: `type=ActiveRecord::Coders::YAMLColumn db="---\n- a\n"`. Never backport this line.
- **Stored data:** rows written by 7.0 read correctly on 8.1, and rows rewritten by 8.1 read correctly after rolling back to 7.0. Byte formats are identical: `["a","b"]` and `---\nexport_heading: …`.

**5. `alias_attribute` on a store accessor (executed, prep-safe).** It fails with ``Note model aliases `color`, but `color` is not an attribute``.
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. This covers both form assignment (create and update) and the reads in the views.

**6. `Rails.application.secrets` is removed (executed, prep-safe).** Citation lookups fail with ``NoMethodError: undefined method `secrets'``.
- **Repair:** move `config/secrets.yml` to `config/citation_provider.yml` (flat, one section per environment, same `.to_json` ERB), and set `config.x.citation_provider = config_for(:citation_provider)` in `application.rb`.
- Change `Citation::Provider` and the test helper `citation_enrichments_controller_test.rb:45,117-122` to read `Rails.configuration.x.citation_provider`.
- **Validate:** the existing "credentials from the environment reach the server unchanged" test uses user `00123` and password `sample: value # keep`, in a fresh process. It passes on 7.0 and 8.1. The production boot printed `provider=[:url, :user, :password]`.
- I recommend this over credentials, which would lose the environment-variable configuration.

**7. A route with two paths raises (executed, prep-safe).** `routes.rb:18`, `get "/notes", "/journal"`, fails with `ArgumentError: Wrong number of arguments (expect 1, got 2)`. The tests then saw ``undefined local variable or method `notes_path'``.
- **Repair:** two lines, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. Both route names keep their 7.0 values.

**8. `form_with(model: nil)` raises (executed, prep-safe).** `notes/index.html.erb:12` returns 500: `Passed nil to the :model argument`.
- **Repair:** drop `model: nil`. Field names stay unscoped (`query`).

**9. Test exceptions no longer raise (executed, not prep-safe).** With `config.action_dispatch.show_exceptions = false`, 8.1 treats `false` as "show". The not-found tests got `RecordNotFound expected but nothing was raised`.
- **Repair:** `:none`, shipped with the upgrade. On 7.0 a symbol counts as true, so it would show exceptions there.

**10. Plural association name in `where` (executed, prep-safe).** `NotesController#index` with `where(notebooks: @notebook)` fails: `PG::UndefinedColumn: column notes.notebooks does not exist`.
- **Repair:** `where(notebook: @notebook)`.

**11. String concatenation with `sum` (executed, prep-safe).** `Export#generate`, `fragments.sum`, fails with `TypeError: String can't be coerced into Integer`. Every export job fails, so exports never reach "completed".
- **Repair:** `fragments.join`.

**12. Reminder scheduling with an epoch Integer (executed, prep-safe).** `Note#schedule_reminder` with `set(wait_until: reminder_epoch)` fails: ``undefined method `utc' for an instance of Integer``.
- **Repair:** `Time.at(reminder_epoch)`. Through the real Sidekiq adapter (`/tmp/up/sched.rb`), the scheduled score is 1793538000 on both 7.0 and 8.1.
- Reminders already queued by 7.0 are readable by 8.1 workers.

**13. Retry wait value removed (executed, not prep-safe).** `CitationEnrichmentJob` with `wait: :exponentially_longer` raises `Couldn't determine a delay based on :exponentially_longer` on the first retry. Rails 7.0 rejects `:polynomially_longer`, so this ships with the upgrade.
- **Repair:** `:polynomially_longer`, shipped with the upgrade.
- **Alternative:** `wait: ->(n) { n**4 + 2 }` works on both versions, but it drops the jitter.

**14. Transactions now commit on early `return` – silent data loss (executed, prep-safe).** `Import#apply` does `return false` inside `transaction`, and 8.x commits on that kind of early exit. Applying a CSV with an invalid row saves the import and the earlier rows. Measured `[Import, Note, Citation, RichText]` counts went from expected `[0,3,0,1]` to `[1,4,1,2]`.
- **Repair:** `applied = rows.all? { |row| row.note.save }`, then `raise ActiveRecord::Rollback unless applied`, then return `applied`.
- **Validate:** `imports_controller_test.rb:48` fails without the repair and passes with it. The control is the valid-CSV test at line 6, which still creates 2 notes, 1 citation and 1 import.
- **Data:** look for existing partial imports, i.e. imports whose notes are fewer than their CSV rows. Not checked.

**15. Import receipt loses its DOIs – silent (executed, prep-safe).** `Import#receipt`, `citation[:id]`, now reads a non-existent `id` column, so the CSV DOI column is empty (`On idleness,` instead of `On idleness,10.1000/Essays.1`).
- **Repair:** `note.citation_doi`.

**16. Preview hides annotations – silent (executed, prep-safe).** `imports/preview.html.erb` calls `@import.annotations.stringify_keys`, which now turns the Integer line keys into Strings. `annotations[row.line]` returns nil and annotations disappear. The test saw `"10.1000/Essays.1"` where it expected `"Read <b>twice</b> & reflect"`.
- **Repair:** remove `.stringify_keys`.

**17. Digest date shifts to the reader's zone (executed, prep-safe).** Active Job now restores a time with its original zone, so `DigestMailer` computes the reader's local day. The subject showed "October 04" where "October 05" (UTC) was expected. That contradicts the UTC reservation key in `User#request_digest`.
- **Repair (consumer side):** `requested_at = params[:requested_at].in_time_zone(Time.zone)`. This also handles jobs queued by 7.0.

**18. Postponed reminder shows a different offset (executed, prep-safe).** `Note#next_day_reminder_at` uses `to_time`, which now always keeps the zone. It shows `2026-11-01T08:00:00-05:00` instead of `09:00:00-04:00`. The epoch is the same (1793538000), so postponing itself is unchanged.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. This keeps the behavior described in the method's comment, and `reminders_controller_test.rb:6` checks it.

## B. Rollout and rollback risks (mixed versions, queued work)

**Digest jobs fail on old workers (executed, `/tmp/up/aj_*.rb`).**
- 8.1 serializes `BigDecimal` with its own serializer. A 7.0 worker reading that job fails with `ActiveJob::DeserializationError … BigDecimalSerializer is not known`. The digest is never sent, and the Redis reservation blocks a re-request until the next day.
- **Prep change (works on 7.0):** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The mailer already accepts a String.
- With that change plus finding 17, all four producer/consumer combinations give the same date (2026-10-05) and completion ("0.6667").
- Also upgrade workers no later than web servers.

**Reminder jobs (executed):** payloads written by 8.1, which add `scheduled_at`, deserialize on 7.0, so rollback is safe.

**Stored data (executed):** the serialized `tags`, `preferences` and `settings` columns round-trip unchanged in both directions.

**Recommended order:**
1. Ship the prep-safe repairs and the json pin on 7.0.
2. Deploy 8.1 with the not-prep-safe items: `coder:` (finding 4), `show_exceptions: :none` (9) and `:polynomially_longer` (13).
3. Keep `load_defaults 7.0` until the release is stable.

## C. New framework defaults, release by release

The app sets `load_defaults 7.0` and none of these explicitly, so all of them keep their old values. The table shows what adopting each would change here.

| Release | Default | What changes for this app if adopted |
|---|---|---|
| 7.1 | `default_column_serializer = nil` | Boot fails (executed) unless `coder: YAML` is in place (finding 4). |
| 7.1 | `raise_on_assign_to_attr_readonly` | Notebook settings update fails with `ActiveRecord::ReadonlyAttributeError: slug` (executed), because the form resubmits the slug. Repair (prep-safe): drop `:slug` from `notebook_params`. Create already ignores it via `assign_slug`. |
| 7.1 | `raise_on_invalid_cache_expiration_time` | `exports/_export.html.erb:26` returns 500, `Cache expiration time is invalid, cannot be negative: -60.0` (executed). Production has caching on, so any expired export breaks the exports page. Repair (prep-safe): `expires_in: [export.expires_at - Time.current, 1.second].max`. I rejected `cache_if expires_at.future?`: it also skips reading the cached fragment, which broke `exports_controller_test.rb:59` (line 78). |
| 7.1 | `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata` | Old servers may fail to read new session cookies, signing users out during a mixed-version deploy or rollback. **Unverified**: my cookie harness failed even for a single version. Enable in a later deploy. |
| 7.1 | `cache_format_version 7.1` | 7.0 cannot read the new cache format (file store in production). Clear `tmp/cache` on rollback. Source-based. |
| 7.1 | `sanitizer_vendor` HTML5 (Action View and Action Text) | No difference with the finding 2 repair (executed). |
| 7.1 | `dom_testing_default_html_version :html5` | The suite passes under it (executed). |
| 7.1 | `marshalling_format_version`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved…`, `generate_secure_token_on`, encryption digest settings, `sqlite3_adapter_strict_strings_by_default`, `query_log_tags_format` | No use in this app (no `after_commit`, no secure tokens, no encryption, no SQLite, no query logs, records not cached). |
| 7.1 | `belongs_to_required_validates_foreign_key` | Same outcome: owners are assigned or nil. |
| 7.1 | `precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level`, `default_headers`, `add_autoload_paths_to_load_path=false` | Performance, logging or header-only changes. Nothing in the app depends on the autoload paths being on the load path. |
| 7.1 (forced in 8.1) | `use_big_decimal_serializer`, `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `commit_transaction_on_non_local_return` | Already forced in 8.1; covered by section B and findings 10 and 14. |
| 7.2 | `postgresql_adapter_decode_dates` | Activity report fails with `TypeError: no implicit conversion of Date into String` in `Notebook#daily_note_counts` (executed). Repair (prep-safe): `day.to_date`. |
| 7.2 | `validate_migration_timestamps` | Existing migration timestamps are valid. |
| 7.2 | `web_image_content_types` adds webp | No variant processing in the app. |
| 7.2 | `yjit` | Memory and performance only. |
| 7.2 | `enqueue_after_transaction_commit` | Removed. In 8.1 it defaults to false. Do not enable it: `Citation#request_enrichment` and `Note#schedule_reminder` rely on enqueueing inside the row lock so a failed enqueue rolls back. |
| 8.0 | `strict_freshness` | `ExportDownloadsController` would honor only If-None-Match. Blob checksum and created_at never change, so only rare clients see a different 304/200. Source-based. |
| 8.0 | `to_time_preserves_timezone` | Removed; covered by finding 18. |
| 8.0 | `Regexp.timeout = 1` | The DOI and CSV patterns are linear. |
| 8.1 | `escape_json_responses`, `escape_js_separators_in_json` | No JSON endpoints. |
| 8.1 | `action_on_path_relative_redirect :raise` | All redirects use absolute paths or route helpers. |
| 8.1 | `raise_on_missing_required_finder_order_columns` | All tables have primary keys. |
| 8.1 | `render_tracker :ruby` | Fragment digests change once, so the export indicator cache misses once. |
| 8.1 | `remove_hidden_field_autocomplete` | Markup only; tests pass. |

With all of these repairs, the `load_defaults 8.1` copy passes 46 runs and 340 assertions.

## D. Deprecations and follow-ups (not required for 8.1)
- **Sidekiq adapter:** the only deprecation logged is "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2". Moving to Sidekiq 7.3.3 or later is a separate task with its own risks. These are source-based, not run:
  - With redis-client, `sadd` returns 0 or 1, which are both truthy in Ruby, so the once-per-day digest guard in `User#request_digest` silently stops working. Use `sadd?` or compare `> 0`.
  - `rescue Redis::BaseError` in `Notebook#request_export` would no longer catch connection errors.
  - Strict arguments would reject `{ format: "markdown" }` with Symbol keys in `ExportJob.perform_async`; Sidekiq 6.5 already warns about it.
- Puma stays at 5.6.9. Upgrading it is not required for this upgrade.

## Still open
- Cookie compatibility under the 7.1 message settings is unverified.
- Rolling back across the cache format is source-based only.
- Browser system tests were not run (they need a display).
- Production data was not checked for imports that were already partially committed or for expired-export cache entries.
- Whether the digest should follow the reader's local day is a product decision. I kept the documented UTC behavior.

---

**About this plan:** I haven't upgraded anything yet. The upgrade skill only plans, so your repository is unchanged; all the testing above ran on scratch copies under `/tmp/up`.

Two small mistakes in the plan's text:
- **Wrong cross-references:** "The summary tool was incomplete" says the job-time-zone change is "finding 6" and the json break is "finding 1". The time-zone change is actually finding 17. The json pin is finding 1.
- **Contradictory label:** finding 1 is marked "executed" but not "prep-safe", even though its text says the pin also works on 7.0. The recommended order also ships it on 7.0.

If you want me to go ahead, I'd follow the plan's order:
1. A first change on 7.0 with the json pin and all the repairs that also work there.
2. Then the version bump to 8.1.0, together with the three changes that only work on 8.1 (`coder:`, `show_exceptions = :none` and `:polynomially_longer`).

You'd also need to decide whether the digest email should use UTC or each reader's own day; the plan keeps UTC.