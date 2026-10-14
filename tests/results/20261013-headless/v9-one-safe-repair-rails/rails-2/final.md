# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

On Rails 8.1.0 the app breaks in 14 places, and some of them only show up when it runs. Once I fixed all 14 in a disposable copy, the app booted and the suite passed: **46 runs, 340 assertions, 0 failures** (the unchanged app on 7.0 had 325 assertions passing). Twelve of the 14 fixes also work on Rails 7.0. I applied those to a second copy still on 7.0 and the suite passed there too. One more finding is a risk during the rollout itself: Rails 8.1 job payloads that 7.0 workers cannot read. Sidekiq 6.5.12 and the rest of the bundle keep working with Rails 8.1.0. The working repository was not modified and `git status` is still clean.

## How I tested
- **Copies:**
  - `/tmp/up/app` is the unchanged app on 7.0.
  - `/tmp/up/a81` is the app on Rails 8.1.0 with fixes.
  - `/tmp/up/prep` is the app on 7.0 with only the fixes that work on both versions.
  - All changes are in `/tmp/up/a81.diff`.
- **Isolated services:**
  - A separate PostgreSQL 15 cluster (`/tmp/up/pgdata`, port 55433, Unix socket only).
  - A separate Redis on `/tmp/up/redis.sock` with no persistence.
  - Active Storage and the cache used each copy's own `tmp/` and `storage/`.
  - Settings are in `/tmp/up/env.sh` (`DATABASE_URL`, `REDIS_URL`, `PARALLEL_WORKERS=1`). Both services are stopped now.
- **Resolved gems for 8.1:** in `/tmp/up/a81/Gemfile.lock`. Running `bundle lock --update rails` changed only Rails. It kept rack 2.2.24 (puma 5.6.9 and sidekiq 6.5.12 require it), redis 4.8.1, pagy 8.6.3, turbo-rails 2.0.12, importmap 2.2.3, minitest 5.27.0 and concurrent-ruby 1.3.4. It also brought in **json 3.1.0** (finding R3).
- **Logs:**
  - Change index: `/tmp/up/changes.txt`
  - Baseline on 7.0: `/tmp/up/base-test.log`
  - Failures on 8.1 as fixes were added: `/tmp/up/a81-test{1..8}.log`
  - Boot failures on 8.1: `a81-boot.log`, `a81-zw.log`
  - 7.0 copy with the shared fixes: `prep-test.log`
  - Real Sidekiq worker: `a81-sidekiq.log`
  - Production eager-load and asset precompile: `a81-prod.log`, `a81-assets.log`
  - Job payloads: `digest_payload_7.0.json`, `digest_payload_8.1.0.json`
  - Probe scripts: `enqueue.rb`, `exec.rb`, `defaults_probe.rb`, `cfg.rb`

## Required changes
Each item says how I know: **E** means I reproduced it on 8.1, **S** means it comes from reading source only. "Works on 7.0" means the fix passed the 7.0 suite in `/tmp/up/prep`.

**R1. `ActionText::ContentHelper.allowed_tags` is nil on 7.1+, so the app does not boot (E).**
- **Where:** `config/initializers/action_text.rb`.
- **What happens:** `undefined method '+' for nil (NoMethodError)`.
- **Fix:** in an `after_initialize` block, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`.
- **Works on 7.0:** yes.
- **Check:** the test "rich text keeps collapsible excerpts and drops unsafe markup". I also checked by hand that `<details>` is kept and `<script>` and `onerror` are stripped.

**R2. `enum status:` with `_prefix:` no longer works, so the app does not boot (E).**
- **Where:** `app/models/note.rb:10`.
- **What happens:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when eager loading or running `zeitwerk:check`.
- **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. The stored integers and the `status_ready` scope stay the same.
- **Works on 7.0:** yes.

**R3. json 3.1.0 is incompatible with Rails 8.1.0 (E).**
- **Why it happens:** Rails 8.1's Active Support depends on json with no upper bound, so the resolver picks 3.1.0.
- **What happens:** `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)` and fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`. Every session-cookie read and every `serialize ... JSON` load fails, which turns most requests into a 500.
- **Fix:** add `gem "json", "~> 2.10"` to the Gemfile. That resolved 2.21.2 and fixed it.
- **Works on 7.0:** yes, the pin is harmless there.
- **Open question:** a later 8.1.x patch may fix this. I did not check.

**R4. `serialize :tags, JSON` must become `serialize :tags, coder: JSON` (E).**
- **What happens on 8.1:** `ArgumentError (given 2, expected 1)`.
- **Does not work on 7.0:** 7.0 accepts no `coder:` keyword (it only has `**options`). Ship this in the same deploy as Rails 7.1 or later.
- **Stored data:** the JSON in the `tags` column is read the same way.
- **Check:** the notes create and edit tests that cover tags.

**R5. `alias_attribute :highlight_color, :color` fails because `color` is a store accessor, not an attribute (E).**
- **What happens:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
- **Fix:** `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. That covers the reader (index and show views) and the writer (the form and permitted params).
- **Works on 7.0:** yes.

**R6. `Rails.application.secrets` has been removed (E).**
- **Where:** `Citation::Provider#initialize` and `citation_enrichments_controller_test.rb`.
- **What happens:** ``undefined method `secrets'``, so every citation enrichment fails.
- **Fix:**
  - Move `config/secrets.yml` into `config/citation_provider.yml`.
  - In `application.rb`, set `config.x.citation_provider = config_for(:citation_provider)`.
  - Read `Rails.configuration.x.citation_provider.to_h`.
- **Works on 7.0:** yes, including the YAML alias.
- **Production:** the values still come from `CITATION_PROVIDER_*` environment variables. In the eager-loaded production run, all three values were nil because those variables were unset in the test environment.
- **Unverified:** whether production also keeps `secret_key_base` or anything else in `secrets.yml` or `config.secret_key_base`.

**R7. Passing several paths to one `get` is no longer allowed (E).**
- **Where:** `routes.rb`, `get "/notes", "/journal"`.
- **What happens:** `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Routes load lazily, so in tests this only appeared on the first request.
- **Fix:** two routes, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. The route names are the same as on 7.0, which I checked with `bin/rails routes`.
- **Works on 7.0:** yes.

**R8. `Enumerable#sum` on strings no longer works (E).**
- **Where:** `Export#generate`.
- **What happens:** `TypeError: String can't be coerced into Integer`, so every export fails in the worker.
- **Fix:** `fragments.join`.
- **Works on 7.0:** yes.

**R9. `where(notebooks: @notebook)` in `NotesController#index` (E).**
- **What happens:** `PG::UndefinedColumn: column notes.notebooks does not exist` whenever the list is filtered by notebook.
- **Fix:** `where(notebook: @notebook)`.
- **Works on 7.0:** yes.

**R10. `form_with(model: nil, ...)` in `notes/index` (E).**
- **What happens:** `Passed nil to the :model argument`, so the note list is a 500.
- **Fix:** remove `model: nil`.
- **Works on 7.0:** yes.

**R11. `set(wait_until: <Integer epoch>)` in `Note#schedule_reminder` (E).**
- **What happens:** ``undefined method `utc' for Integer``, so no reminder can be scheduled or postponed.
- **Fix:** `wait_until: Time.at(reminder_epoch)`. The test still asserts the exact `at` timestamp.
- **Works on 7.0:** yes.

**R12. `retry_on wait: :exponentially_longer` no longer works (E).**
- **What happens:** `Couldn't determine a delay based on :exponentially_longer`. The `retry_on` block never records the failure, and the test asserting 6 provider calls saw 2.
- **Fix:** `:polynomially_longer`, which gives the same delays.
- **Does not work on 7.0:** that symbol only exists from 7.1. Change it in the 7.1 step.

**R13. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys to strings (E).**
- **Where:** `imports/preview.html.erb`.
- **What happens:** the template looks up `annotations[row.line]` with an Integer, so the import preview shows the wrong row's value (the DOI in place of the annotation). The tests passed silently on 7.0.
- **Fix:** use `@import.annotations` without `.stringify_keys`.
- **Works on 7.0:** yes.

**R14. `citation[:id]` returns nil when the primary key is `doi` (E).**
- **Where:** `Import#receipt`.
- **What happens:** the receipt CSV loses every DOI.
- **Fix:** `citation&.doi`.
- **Works on 7.0:** yes.

**R15. `return` inside `transaction` in `Import#apply` now commits (E). This loses data.**
- **What happens:** with an invalid row, `record_counts` changed from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. The import and the earlier rows were committed, although the UI says "Nothing has been saved".
- **Why:** under `load_defaults 7.0` it rolled back. Rails 8 always commits on a non-local exit.
- **Fix:**
  ```ruby
  saved = false
  transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    saved = true
  end
  saved
  ```
- **Works on 7.0:** yes. The successful path is also covered by the preview-then-import test.

**R16. Test configuration: `config.action_dispatch.show_exceptions = false` must become `:none` (E).**
- **What happens:** with `false`, 8.1 rescues exceptions. Four `assert_raises(RecordNotFound)` tests and one Redis error test failed.
- **Does not work on 7.0:** a symbol counts as true there. Change it in the 7.1 step.

**R17. Reminder postponement display changes (E). Exact delivery time does not change.**
- **What happens:** `to_time_preserves_timezone` from the 7.0 defaults no longer applies, so `reminder_at.to_time + 86_400` returns system-local time. The epoch stays the same (1793538000 on both versions), but the "24 hours later" label goes from `2026-11-01T09:00:00-04:00` to `08:00:00-05:00`.
- **Recommended fix:** keep the documented behaviour (the model comment and the test both say so) with `Time.at(reminder_at.to_i + 86_400, in: reminder_at.formatted_offset)`.
- **Works on 7.0:** yes.
- **Alternative:** accept the new display and update the comment and test. That changes what the reader sees.

**R18. Digest day changes (E).**
- **What happens:** from 7.1, `TimeWithZoneSerializer` keeps the zone (the payload now includes `"time_zone":"Asia/Tokyo"`). `DigestMailer` then uses the reader's local day, while the Redis reservation key still uses the UTC day. The test saw "October 04" where it expected "October 05".
- **Fix:** in `DigestMailer#daily_digest`, use `requested_at = requested_at.utc`. This works for jobs already queued in the old format and in the new one.
- **Works on 7.0:** yes.

## Rollout risks with mixed versions, queued work and rollback
- **M1. BigDecimal job arguments (E).**
  - **What happens:** Rails 8.1 always uses `BigDecimalSerializer`; the `use_big_decimal_serializer` setting is gone. A `DigestJob` queued by 8.1 and run on 7.0 failed with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. This hits old workers during a rolling deploy and after a rollback.
  - **Fix:** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)` in `User#request_digest`. The mailer already calls `BigDecimal(params[:completion])`.
  - **Checks:** works on 7.0. Payloads from 7.0 ran fine on 8.1, and the new payload carries `"1.0"`.
- **M2. TimeWithZone payloads (E).** 7.0 workers ignore the extra `time_zone` key, and R18 keeps the result the same either way.
- **M3. Jobs already scheduled (S).** Reminder and citation jobs already in Sidekiq's scheduled or retry sets hold GlobalIDs and work under the new code. No data migration is needed. Cookies stay JSON and the cache format stays 7.0, so rollback is safe once M1 and R18 are deployed first.
- **M4. Rollback and schema (S).** If any migration runs on 8.1, `schema.rb` will say `ActiveRecord::Schema[8.1]` and 7.0 cannot load it. Keep schema changes out of the upgrade deploy.

## Sidekiq (follow-up, not needed for 8.1.0)
The real Sidekiq 6.5.12 worker processed the `DigestJob` (the mail was delivered) and the `ExportJob` (status completed, file attached). Every job logs: `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later`.

Moving to Sidekiq 7 is a separate change, and it brings its own breakage:
- `redis.sadd` returns an Integer, which is always truthy, so digest de-duplication breaks silently. Use `sadd?`.
- `rescue Redis::BaseError` in `Notebook#request_export` no longer matches the errors raised by redis-client.
- `ExportJob.perform_async(id, { format: "markdown" })` will raise under strict args. It already logs "do not serialize to JSON safely". Use string keys.

## New framework defaults
The app keeps `load_defaults 7.0`, and every default below stays at its old value unless noted. All of them are optional to adopt.

**7.1**

| Setting | What changes in this app if adopted |
|---|---|
| `raise_on_assign_to_attr_readonly` | **(E)** `ActiveRecord::ReadonlyAttributeError: slug` on every notebook settings save, because `notebooks/_form` posts a hidden `slug` and the controller permits it. Remove both first (works on 7.0). |
| `default_column_serializer = nil` | `serialize :preferences` with no coder would raise. Add `coder: YAML` first. The stored data stays YAML. |
| `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances`, `before_committed_on_all_records` | The app has no `after_commit` callbacks of its own; only Action Text and Active Storage internals are affected. |
| `commit_transaction_on_non_local_return` | Already forced in Rails 8 (R15). |
| `belongs_to_required_validates_foreign_key = false` | `Note` with a nil `owned_notebook` still fails validation. Low risk. |
| `generate_secure_token_on` | No `has_secure_token` in the app, so no effect. |
| `use_big_decimal_serializer` | Forced in 8.1 (M1). |
| `raise_on_invalid_cache_expiration_time` | **(E)** `ArgumentError: Cache expiration time is invalid, cannot be negative`. `exports/_export.html.erb` passes a negative `expires_in` for expired exports, so the exports page would 500 in production, where caching is on. Fix with `cache_if export.downloadable?, ...` (S). |
| `sanitizer_vendor` HTML5 (Action View and Action Text) | Same output in my probe for details/script/onerror. |
| `dom_testing_default_html_version` | Changes how test assertions parse HTML. |
| `message_serializer`, `use_message_serializer_for_metadata` | Adopt only after every server runs 7.1 or later. |
| `marshalling_format_version` | No Active Record objects are cached, so low risk. |
| `precompile_filter_parameters`, `query_log_tags_format`, `debug_exception_log_level`, `log_file_size` | Cosmetic. |
| `encryption.*`, `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `sqlite3_adapter_strict_strings_by_default` | Not used (no encryption, PostgreSQL, no params-hash comparisons). |

**7.2**

| Setting | What changes in this app if adopted |
|---|---|
| `postgresql_adapter_decode_dates` | **(E)** `TypeError: no implicit conversion of Date into String` in `Notebook#daily_note_counts`, which breaks the activity report. Fix first with `day.is_a?(Date) ? day : Date.iso8601(day)`. |
| `enqueue_after_transaction_commit` | Keep it off. `Citation#request_enrichment` and `Note#schedule_reminder` rely on an enqueue failure inside `with_lock` rolling the transaction back. |
| `validate_migration_timestamps` | Check migration filenames. |
| `web_image_content_types` | No variants are used. |
| `yjit` | Uses more memory. |

**8.0**

| Setting | What changes in this app if adopted |
|---|---|
| `to_time_preserves_timezone = :zone` | Already effectively forced (R17). |
| `strict_freshness` | `ExportDownloadsController#stale?` would honour only If-None-Match when both headers are sent. The download still works. |

**8.1:** the change index lists no new defaults for this release.

## Suggested sequencing
1. Deploy on 7.0 the fixes that work on both versions (`/tmp/up/prep`, green): R1, R2, R3 pin, R5–R11, R13–R15, R17, R18, M1. Also remove the slug from the notebook form and params.
2. Upgrade Rails, and in the same change apply R4, R12 and R16. I only tested the two ends; I did not run the 7.1, 7.2 or 8.0 copies. If you go through those versions one at a time, the removal points above come from the changelog and are not tested.
3. Adopt new defaults one at a time, after the prerequisite fixes noted in the table.
4. Upgrade Sidekiq to 7.3.3 or later before Rails 8.2.

## Not verified
- System tests (`test/system` is empty) and real browser behaviour.
- Production credentials and `secret_key_base` sourcing.
- Puma 5 under production load on Rails 8.1. It booted and the suite passed, but I did not run the server itself.
- The `cache_if` fix for the export page.
- Whether later 8.1.x releases fix the json 3 problem.

---

**Note:** This is a plan only. The upgrade skill doesn't make changes, so your repository is still on Rails 7.0.8.7 and clean. The planner tested the upgrade in disposable copies under `/tmp/up/`, and `/tmp/up/a81.diff` has the full set of changes that got the suite passing on 8.1.0. The two items most worth your attention are R15 (an import with an invalid row now saves partial data) and M1 (jobs queued by 8.1 fail on 7.0 workers during a rolling deploy or rollback). Tell me if you want me to start on step 1.