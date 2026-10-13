Here's the full plan from the upgrade planner. Nothing in `/home/user/workspace/repo` was changed. The planner did its trial upgrade in disposable copies under `/tmp/up`.

---

I upgraded a disposable copy to Rails 8.1.0. As the code stands, the app does not boot on 8.1: it crashes in an initializer before loading anything else. After the 17 fixes below (Gemfile/lock not counted) the 46-test suite passes on 8.1, and the boot, page and job checks below work. Several of these failures would not show up as a failing test. They would quietly change data: partly-saved imports, blank DOIs in import receipts, digests for the wrong day. Two job-format changes can also break older workers while old and new versions run side by side.

`/home/user/workspace/repo` was not modified.

## What I ran

| | |
|---|---|
| Change index | `ruby …/gem-changes rails 7.0.8.7 8.1.0` → `/tmp/up/changes.txt` |
| Copies | `/tmp/up/base` (7.0 baseline), `/tmp/up/r81` (8.1), `/tmp/up/prep` (7.0 plus the changes that also work on 7.0), `/tmp/up/d7.1`, `d7.2`, `d8.0`, `d8.1` (8.1 with each newer `load_defaults`) |
| Isolation | Separate Postgres databases (`up_base_test`, `up_r81_test`, `up_prep_test`, `up_d71_test`…`up_d81_test`, plus `up_shared` for cross-version checks), a private Redis on port 6390 (now shut down), bundle in `/tmp/up/bundle81`, Active Storage and mail under each copy's `tmp/` |
| Resolved dependencies | `/tmp/up/r81_Gemfile.lock` (as first resolved). It moved rails to 8.1.0 and json to 3.1.0; sidekiq 6.5.12, rack 2.2.24, puma 5.6.9, pagy 8.6.3 and turbo-rails 2.0.12 stayed put. The final lock in `/tmp/up/r81/Gemfile.lock` pins json 2.21.2. |
| Patch that made 8.1 pass | `/tmp/up/r81_patch.diff` |
| Same fixes on 7.0 | `/tmp/up/prep_patch.diff` |
| Test logs | Baseline `/tmp/up/base_test.log` (46 runs, 0 failures). 8.1 fixing rounds `r81_test.log` → `r81_test9.log` (final: 0 failures). 7.0 with prep fixes `prep_test.log` (0 failures). Newer defaults `defaults_{7.1,7.2,8.0,8.1}.log`. |

## A. Required changes (each confirmed by running it unless marked otherwise)

"Works on 7.0" means I applied the fix to the 7.0 copy and the suite still passed, so it can ship before the Rails bump.

1. **`config/initializers/action_text.rb`** crashes boot on 7.1 and later (`undefined method '+' for nil`), because `allowed_tags` starts out empty. Fix: in `after_initialize`, start from `allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]`, then add `details summary`. **Works on 7.0.** Check: the existing test "rich text keeps collapsible excerpts".
2. **`json` gem**: an unpinned bundle update picked json 3.1.0. With it, ActiveSupport 8.1.0's JSON decoding raises `ArgumentError` whenever `serialize :tags` loads, which caused most of the 500s. I pinned `gem "json", "~> 2.7"` (resolved 2.21.2). This depends on what rubygems offers today, so recheck it at upgrade time.
3. **`Note`, `enum status: …, _prefix:`** is removed by 8.0. Change to `enum :status, {…}, prefix: true`. **Works on 7.0.**
4. **`serialize :tags, JSON` and `Notebook serialize :preferences`** fail with ArgumentError on 8.1. Change to `coder: JSON` and `coder: YAML`. The `coder:` form does **not** exist on 7.0, so this has to ship with the bump.
   - Stored data is compatible: I wrote rows on 7.0, read and updated them on 8.1, and read them back on 7.0 (shared database). The stored strings were identical (`"---\nexport_heading: …"` and `["a","b"]`).
5. **`alias_attribute :highlight_color, :color`** raises on 8.1 because `color` comes from a store accessor, not a column. Use `alias_method` for both the reader and the writer. **Works on 7.0.**
6. **`config/routes.rb`, `get "/notes", "/journal"`**: listing several paths in one route is gone in 8.1 and the route file fails to load. Split it into two `get` lines. **Works on 7.0;** both URLs return 200 on 8.1.
7. **`Rails.application.secrets` is removed**, so citation lookup would raise NoMethodError the first time a job runs. Load `config_for(:secrets)[:citation_provider]` into `config.x.citation_provider` and update `test/controllers/citation_enrichments_controller_test.rb`. **Works on 7.0.** I'd also suggest renaming the file away from `secrets.yml`. Production still uses the `credentials.yml.enc`/ENV secret key, so sessions are unaffected.
8. **`Export#generate`, `fragments.sum`** fails on 8.1 (`TypeError: String can't be coerced`) because summing strings was removed. Use `join`. **Works on 7.0.** Every export job fails without this.
9. **`Import#apply`, `return false` inside `transaction`** is a silent data-integrity problem. On 7.0 the early return rolls back; on 8.1 it **commits**, so an invalid row leaves a partial import. The test showed counts going from `[0,3,0,1]` to `[1,4,1,2]`. Fix with `raise ActiveRecord::Rollback` and a flag, not with another `return`: a `return true` inside the block would roll back on 7.0. **Works on 7.0.**
10. **`Import#receipt`, `citation[:id]`** returns nil on 8.1 because `citations` uses `doi` as its primary key and has no `id` column. Receipt CSVs silently lose every DOI. Use `citation&.doi`. **Works on 7.0.**
11. **`imports/preview.html.erb`, `annotations.stringify_keys`**: on 8.1 the integer line keys become strings, so `annotations[row.line]` finds nothing and the preview drops every annotation. Drop the `stringify_keys`. **Works on 7.0.**
12. **`notes/index.html.erb`, `form_with(model: nil, …)`** raises on 8.1 and gives a 500 on `/notes`, the post-login page. Remove `model: nil`. **Works on 7.0.**
13. **`NotesController#index`, `where(notebooks: @notebook)`** gives `PG::UndefinedColumn notes.notebooks` on 8.1. Use `where(notebook: @notebook)`. **Works on 7.0.**
14. **`CitationEnrichmentJob`, `wait: :exponentially_longer`** is removed. On 8.1 the request raises "Couldn't determine a delay". Use `:polynomially_longer` on 7.1 and later, or the lambda `->(n) { n**4 + 2 }` on 7.0; both give the same delays.
15. **`Note#schedule_reminder`, `set(wait_until: Integer)`** fails on 8.1 (`undefined method 'utc' for Integer`). Use `Time.at(reminder_epoch)`. **Works on 7.0.**
16. **`Note#next_day_reminder_at`, `reminder_at.to_time + 86_400`**: on 8.1 the result keeps the time zone instead of the UTC offset. The instant is the same, but the display changes from `09:00-04:00` to `08:00-05:00`, contradicting the code comment and the test. Fix: `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. **Works on 7.0.** The `to_time_preserves_timezone` setting is deprecated in 8.1 and goes away in 8.2.
17. **`DigestMailer` and `User#request_digest`**: on 8.1, times passed to jobs keep the reader's zone. The digest would cover the reader's local day, not the UTC day the reservation and the UI text promise (the test showed Oct 04 instead of Oct 05). Fix: call `requested_at.utc` in the mailer. **Works on 7.0,** and handles jobs from either version.
18. **`config/environments/test.rb`, `show_exceptions = false`**: on 8.1 errors become 500 responses, and six tests expecting `RecordNotFound` failed. Use `:none` (7.1 and later only).

## B. Rollout and rollback risks (confirmed with real payloads)

- **BigDecimal job argument**: 8.1 serializes `reading_completion` with `BigDecimalSerializer` even under `load_defaults 7.0`. A 7.0 worker raises `DeserializationError: Serializer … BigDecimalSerializer is not known` (from `/tmp/up/payload81.json`). Fix: pass `reading_completion.to_s`, which the mailer already turns back into a BigDecimal. Deploy that on 7.0 **before** the bump so old workers, retries and a rollback can all read pending digest jobs.
- **TimeWithZone argument**: 8.1 adds a `time_zone` key. 7.0 ignores it and still reads the value, and 8.1 reads 7.0 payloads. Fix 17 makes the meaning the same in both directions.
- **Reminder jobs scheduled for later**: these sit in Sidekiq's schedule across the deploy. Their arguments are only a record ID, so 8.1 processed them fine with real Sidekiq. Export, digest, enrichment and reminder jobs all completed on 8.1 (`/tmp/up/sk81.log`).
- **Partial imports**: if 8.1 ever runs without fix 9, look for imports whose notes don't match their CSV.
- **Sessions**: a 7.0 session cookie was accepted by the 8.1 server, and the pages I tried (`/notes`, `/journal`, notebook settings, exports, imports, activity report, a note) all returned 200. I did not check the reverse (an 8.1 cookie on 7.0, i.e. after a rollback). In development, the local secret file moves to `tmp/local_secret.txt`, so local sessions reset.
- **Order:** ship the "works on 7.0" fixes first. Then bump in one step to 8.1 with the 8.1-only edits (4, 14, 18 and the json pin), keeping `load_defaults 7.0`. Drain the queues or confirm fix 17 and the BigDecimal fix are live before old workers stop.

## C. Follow-ups (not needed for 8.1)

- The built-in Sidekiq adapter is deprecated and will be removed in 8.2; it needs sidekiq ≥ 7.3.3. That upgrade will break `User#request_digest`: `sadd` will return an Integer, and `0` counts as true in Ruby, so the one-digest-per-day limit stops working (Redis already warns about this). It will also reject `ExportJob`'s symbol-keyed arguments, which already log a strict-args warning.
- Ruby 3.4 will need `csv`, `bigdecimal` and `mutex_m` added explicitly (current warnings).

## D. New framework defaults

The app keeps `load_defaults 7.0` and sets none of these explicitly, so all keep their old values. The `d*` runs turned each one on in order (7.1 includes all 7.1 settings, and so on).

**7.1**
- `raise_on_assign_to_attr_readonly`: **breaks notebook settings.** The form re-sends `slug` and `NotebooksController` permits it, so updates raise `ReadonlyAttributeError` (confirmed). Stop permitting `:slug` first.
- `raise_on_invalid_cache_expiration_time`: **breaks the exports page** for expired exports. `_export.html.erb` passes a negative `expires_in` (confirmed, -60). Clamp the value or skip caching when expired.
- `default_column_serializer = nil`: harmless once fix 4 is in.
- `commit_transaction_on_non_local_return`: now always on in 8.1 (see fix 9).
- `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`, `cache_format_version 7.1`, `marshalling_format_version`: new readers can read old formats, but **after adopting them, 7.0 can't read what 8.1 writes.** That affects cache entries and signed IDs, possibly including those stored inside rich-text attachments (not verified). Adopt only after rollback is no longer an option.
- `sanitizer_vendor` (Action View and Action Text, HTML5) and `dom_testing_default_html_version :html5`: sanitized rich-text output may change. The suite still passed under 7.1 defaults.
- Others with no detected effect: `run_after_transaction_callbacks_in_order_defined` (only `with_lock` here, no commit callbacks), `before_committed_on_all_records`, `belongs_to_required_validates_foreign_key` (saves a query for Note/Export/Import), `allow_deprecated_parameters_hash_equality`, `precompile_filter_parameters`, `query_log_tags_format`, `debug_exception_log_level`, `generate_secure_token_on`, encryption settings (not used), `log_file_size`, `add_autoload_paths_to_load_path=false` and `default_headers` (`X-XSS-Protection: 0`). The change index missed the last three and all of 8.1.

**7.2**
- `postgresql_adapter_decode_dates`: **breaks `Notebook#daily_note_counts`** (`Date.iso8601(Date)` TypeError, confirmed). Accept either a Date or a String first.
- `web_image_content_types` adds webp: affects rich-text image variants, and `image_processing` isn't installed.
- `validate_migration_timestamps`: existing migrations are fine.
- `yjit`.
- `enqueue_after_transaction_commit`: in 8.1 this is per-job and off by default, so `with_lock` enqueues still happen inside the lock and still roll back on failure, as the code comments assume (verified in source; jobs ran).

**8.0**
- `strict_freshness`: export downloads check expiry before `stale?` and the ETag is an immutable checksum, so no harm (download test passed).
- `to_time_preserves_timezone :zone`: covered by fix 16.
- `Regexp.timeout = 1`.

**8.1**
- `action_on_path_relative_redirect :raise`: every redirect uses a helper or an absolute path.
- `raise_on_missing_required_finder_order_columns`.
- `escape_json_responses false`: there are no JSON views.
- `render_tracker :ruby`: fragment cache digests change once.
- `remove_hidden_field_autocomplete`: markup only.
- `yjit` off in development/test.
- The suite passed under 8.1 defaults apart from the three failures already listed (slug, cache expiry, activity report).

## E. Not verified yet

- Whether an 8.1 session cookie works on 7.0. My curl form posts failed CSRF checks, so I used runner-enqueued jobs instead.
- System and browser tests (`bin/rails test:system`) were not run, including the Trix editor shipped via the new `action_text-trix` gem.
- Whether signed IDs inside stored rich text survive a rollback after adopting the 7.1 message defaults.
- Whether the enrichment job's final-failure path works with a real provider. The provider wasn't running, so I only saw retries being scheduled.
- Production asset precompile and puma 5 under 8.1 were not exercised. A production-mode eager boot did succeed.

---

**My notes:**
- **Two inconsistencies in the plan:**
  - The intro says "17 fixes," but section A lists 18. The json pin (item 2) is a Gemfile change, which may be why it wasn't counted.
  - The last 8.1-defaults bullet mentions an "activity report" failure, but the 7.2 entry calls it `Notebook#daily_note_counts`. Those are probably the same failure under two names.
- **What I suggest doing next:** start with a small PR that has only the "works on 7.0" fixes, plus the BigDecimal `.to_s` change from section B. Then a second PR bumps to 8.1.0, keeps `load_defaults 7.0`, and includes items 2, 4, 14 and 18. Run `bin/rails test:system` before merging the second one, since browser tests haven't been run yet.

I haven't made any changes yet. Tell me if you want me to start on the first PR.