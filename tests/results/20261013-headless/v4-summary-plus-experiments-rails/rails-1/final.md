# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

Rails 8.1.0 does not boot on this app as it stands. In a disposable copy it took 15 required fixes before the existing suite passed: 46 runs, 0 failures. Three of those fixes cover data-safety and behaviour changes that the current tests would never reveal. Eleven of the fixes also work on 7.0.8.7, so they can ship first.

Three rollout risks matter most:
- **Partial imports.** Rails 8.1 commits a half-finished CSV import.
- **Digest jobs during the deploy.** If the web servers run 8.1 while workers still run 7.0, every digest email job fails.
- **Rollback after adopting the new defaults.** Rich-text attachment links saved after that point can't be read by 7.0 again.

The working repo was not changed. An earlier `gem fetch` accidentally wrote `rails-8.1.0.gem` into it; I deleted it, and `git status` is clean.

## Test setup
- **Copies** (all under `/tmp/mn-upg/`):
  - `base`: untouched 7.0.8.7.
  - `up`: Rails 8.1.0, keeping `load_defaults 7.0`.
  - `up81d`: Rails 8.1.0 with `load_defaults 8.1`.
  - `prep`: 7.0.8.7 plus only the fixes that work on both versions.
- **Services:** a private PostgreSQL 15 on socket `/tmp/mn-upg/pg`, port 55432, and a private Redis on 127.0.0.1:56379. Each copy had its own databases. Mail and storage stayed inside each copy's `tmp/`. Settings are in `/tmp/mn-upg/env.sh`. Both services are stopped now.
- **What resolved:** rails 8.1.0, concurrent-ruby 1.3.8, json 2.21.2 (I had to pin it below 3), sidekiq 6.5.12, redis 4.8.1, pagy 8.6.3, puma 5.6.9, rack 2.2, minitest 5.27.0, and action_text-trix 2.1.19 (newly pulled in).
- **Patch and logs:** the full experimental patch is `/tmp/mn-upg/up-full.diff`; the subset that works on both versions is `/tmp/mn-upg/prep.diff`. Logs are in `/tmp/mn-upg/logs/` (named in each section below).

## A. Required changes
"Both" means the fix works on 7.0.8.7 too, and `prep` proved it: 46 runs, 0 failures, no deprecation warnings (`prep-on-7.0-test.log`). "8.1" means it has to land in the upgrade commit itself.

| # | Where | What breaks on 8.1 (seen in my runs) | Fix | Works on |
|---|---|---|---|---|
| 1 | `config/initializers/action_text.rb` | Boot fails: `undefined method '+' for nil`. `allowed_tags` is now nil by default. | In `after_initialize`, set `allowed_tags = (allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]) + %w[details summary]` | Both |
| 2 | `app/models/note.rb:10` | The `enum status:, _prefix:` keyword form was removed (ArgumentError). | `enum :status, {...}, prefix: true` | Both |
| 3 | `note.rb:12` | `serialize :tags, JSON` raises ArgumentError. | `serialize :tags, coder: JSON`. Stored format is unchanged. | 8.1 |
| 4 | `note.rb:14` | `alias_attribute` pointing at a `store_accessor` raises "color is not an attribute". | `alias_method :highlight_color, :color` and the same for `highlight_color=` | Both |
| 5 | `config/routes.rb:18` | `get "/notes", "/journal"` (two paths in one route) raises ArgumentError. | Two separate `get` lines with `as: :notes` and `as: :journal`. Route names stay the same. | Both |
| 6 | Gemfile | Every request returns 500: ActiveSupport 8.1.0 calls `JSON.parse` with positional options, which json 3.1.0 rejects. | `gem "json", "< 3"`, until a Rails patch release confirms it works with json 3. | 8.1 |
| 7 | `config/environments/test.rb` | `show_exceptions = false` no longer means "raise", so tests expecting RecordNotFound got a 404 page instead. | `:none` | 8.1 only. On 7.0, `:none` would *enable* the error pages. |
| 8 | `note.rb` `schedule_reminder` | `set(wait_until: <Integer>)` gives NoMethodError `utc` and a 500 response. | `wait_until: Time.zone.at(reminder_epoch)` | Both |
| 9 | `app/views/notes/index.html.erb:12` | `form_with(model: nil)` raises. | Drop `model: nil`. | Both |
| 10 | `app/models/export.rb:42` | `fragments.sum` on strings raises TypeError, so every export fails. 7.0 already warns about this in the tests. | `fragments.join` | Both |
| 11 | `app/controllers/notes_controller.rb` | `where(notebooks: @notebook)` is now read as a column: PG UndefinedColumn. | `where(notebook: @notebook)` | Both |
| 12 | `app/models/citation/provider.rb:13` and its test | `Rails.application.secrets` was removed (NoMethodError). | Move the settings to `config/citation_provider.yml`, load with `config.x.citation_provider = config_for(:citation_provider)`, and update the test stub. **Production must keep providing the same `CITATION_PROVIDER_*` environment variables.** | Both |
| 13 | `app/jobs/citation_enrichment_job.rb:7` | `wait: :exponentially_longer` raises "Couldn't determine a delay". | Use `:polynomially_longer` (7.1+ only), or a lambda `executions**4 + 2`, which also works on 7.0 but loses 7.0's built-in jitter. | Lambda: both |

## B. Changes the current tests can't catch on their own
These either changed behaviour or data silently. I found them by tracing failures and running probes.

14. **Partial CSV import gets committed (data integrity).** `Import#apply` does `return false` inside `transaction`. Rails 7.0 rolls that back; 8.1 commits it, even with 7.0 defaults. Running the "applying them saves nothing" test on 8.1 changed the record counts from `[0,3,0,1]` to `[1,4,1,2]` (`up-test5.log`).
    - **Fix:** `raise ActiveRecord::Rollback unless rows.all?(&:save)` and return a flag. This works on both versions and must ship **before** any 8.1 server takes traffic.

15. **Import receipt loses its DOIs.** `citation[:id]` returned the DOI on 7.0 (the table's primary key is `doi`) and returns nil on 8.1, so the receipt CSV's doi column comes out empty.
    - **Fix:** `citation&.doi`. Works on both.

16. **Import preview drops annotations.** `@import.annotations.stringify_keys` on a hash with indifferent access now turns the integer line numbers into strings, so `annotations[row.line]` finds nothing.
    - **Fix:** drop `.stringify_keys` in `app/views/imports/preview.html.erb`. Works on both.

17. **Digest covers the wrong day.** Since 7.1, a time-with-zone job argument comes back in the reader's own zone instead of UTC. `DigestMailer` then covers the reader's local day, which contradicts the "UTC day" text in the hint and comments. Example: the subject said Oct 04 instead of Oct 05.
    - **Fix:** `params[:requested_at].utc` in the mailer. Works on both, and it also handles jobs queued by either version.

18. **"Remind me a day later" shows a different clock time.** `reminder_at.to_time + 86_400` now keeps the reader's time zone rather than a fixed offset. It is the same instant, but across a DST change the hint reads `08:00-05:00` instead of `09:00-04:00` (`/tmp/mn-upg/probe_time.rb`). The 8.1 runtime reported `ActiveSupport.to_time_preserves_timezone` as nil and used `:zone` behaviour while the app still loaded 7.0 defaults, so I treat this as unavoidable.
    - **Fix:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Works on both, and the stored epoch is the same either way.

19. **Rich-text editor JavaScript (not browser-verified).** In 8.1, `actiontext.js` is a UMD bundle; the ES-module build is now `actiontext.esm.js`, and Action Text expects Trix 2 (from the action_text-trix gem). The layout still loads the vendored Trix 1.3.5. Assets compile and `/notes/new` renders, but no browser was available and `test/system` is empty.
    - **Proposed:** pin `@rails/actiontext` to `actiontext.esm.js`, pin and import `trix`, drop `vendor/javascript/trix-1.3.5.js`, then check by hand: create and edit a note with a link, an attachment and `<details>`, and re-open notes saved under 7.0.

## C. Mixed-version rollout and rollback
- **Digest jobs fail when 8.1 queues and 7.0 runs them (tested).** 8.1 always serialises BigDecimal arguments with a new serializer, even under 7.0 defaults, and 7.0 can't read it (`ActiveJob::DeserializationError`). The reverse direction (7.0 queues, 8.1 runs) is fine. Reminder jobs work in both directions (`/tmp/mn-upg/enqueue.rb`, `/tmp/mn-upg/execute.rb`).
  - **Mitigation:** upgrade the Sidekiq workers before or together with the web servers, or pass `reading_completion.to_s` (works on both; the mailer already calls `BigDecimal()`).
  - **Rollback:** any digest jobs that 8.1 queued must be drained or dropped first.
- **Partial imports:** ship fix 14 before any 8.1 server serves requests.
- **Sessions:** cookies made by either version are accepted by the other in production mode (`cookie-test.log`).
- **Signed attachment IDs (SGIDs) in rich text:** compatible both ways under 7.0 defaults. With `load_defaults 8.1`, 7.0 can't read new ones (`unpack1 for nil`). So adopting the 7.1 message-serializer defaults makes rollback lossy for rich text saved afterwards.
- **Dev/test secret file:** 8.1 generates `tmp/local_secret.txt` instead of `tmp/development_secret.txt`, so local sessions and SGIDs are invalidated once. My local tests showed the mismatch; the cause is from the source.
- **Stored data:** tags (JSON) and preferences (YAML) are written exactly as before under 8.1 (`probe-up-defaults70.log` vs `probe-base.log`). No migration is needed, and `schema.rb` will be re-headed `Schema[8.1]`.
- **Sidekiq adapter:** Rails' built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2. Moving to Sidekiq 7.3.3+ later is a separate change. It brings redis-client, where `sadd` returns 0/1, and `if 0` is true in Ruby, so `User#request_digest` would stop blocking repeat requests. Sidekiq 7's strict arguments would also reject `ExportJob.perform_async(id, { format: ... })` because of the symbol keys. Switching to string keys now works on both; `sadd?` works with redis 4.8 but not with redis-client.
- **Optional dependency changes:** the concurrent-ruby 1.3.4 pin can be dropped. Whether the minitest `~> 5.25` pin is still needed was not checked.

## D. Framework defaults, release by release
The app keeps `load_defaults 7.0`, and none of these is set explicitly, so all of them keep their old value. `up81d` with `load_defaults 8.1` had 3 errors (`up81d-test2.log`) and the probes in `probe-up81d.log`.

**7.1**
- `default_column_serializer = nil`: `serialize :preferences` with no coder fails at load. Use `coder: YAML`, which keeps the stored YAML format.
- `raise_on_assign_to_attr_readonly`: the notebook settings form resubmits `slug`, and the update raises `ReadonlyAttributeError` even when the slug hasn't changed. Stop permitting or submitting `:slug`.
- `raise_on_invalid_cache_expiration_time`: `exports/_export.html.erb:26` passes a negative `expires_in` for expired exports, which becomes a 500 in production, where caching is on. Clamp the value or skip caching.
- `message_serializer`, `use_message_serializer_for_metadata`, `marshalling_format_version`: rolling-deploy and rollback risk (section C). Adopt only after every node runs 8.1.
- `sanitizer_vendor` (Action Text and Action View) and `dom_testing_default_html_version`: the HTML5 sanitizer still kept `<details>` and dropped unsafe markup with fix 1 in place.
- `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`: the app defines no commit callbacks, so no effect expected.
- `belongs_to_required_validates_foreign_key`: no effect seen.
- `generate_secure_token_on`, `encryption.*`, `sqlite3_adapter_strict_strings_by_default`, `query_log_tags_format`: not used here.
- `allow_deprecated_parameters_hash_equality`: no `Parameters == Hash` comparisons found.
- `use_big_decimal_serializer`: already in effect on 8.1 regardless (section C).
- `precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level`: harmless.

**7.2**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises TypeError, because `Date.iso8601` is given a Date. Accept a Date or a String.
- `enqueue_after_transaction_commit`: it is false on 8.1 either way; I saw `eatc=false` under both 7.0 and 8.1 defaults. If ever enabled, `Citation#request_enrichment` and `Note#schedule_reminder` would lose their "a failed enqueue rolls back" guarantee.
- `validate_migration_timestamps`: existing migrations pass.
- `web_image_content_types` adding webp: no image variants are used.
- `yjit`: a memory consideration only.

**8.0**
- `strict_freshness`: in `ExportDownloadsController`, only `If-None-Match` would count when both headers are sent. Ownership and expiry are still checked first, so the risk is low. Source-based only; not tested.
- `Regexp.timeout = 1` (global): CSV and DOI regexes are expected to be fine; not measured.

**8.1** (the gem-changes tool did not list these, so I read them from railties' defaults)
- `escape_json_responses = false` and `escape_js_separators_in_json = false`: there are no JSON endpoints.
- `action_on_path_relative_redirect = :raise`: all redirects use route helpers or absolute paths.
- `raise_on_missing_required_finder_order_columns`: `Import.last` appears only in tests.
- `render_tracker = :ruby` and `remove_hidden_field_autocomplete`: cosmetic; the import preview's hidden `csv` field loses `autocomplete="off"`.
- `yjit = !local`.

**Recommendation:** upgrade with `load_defaults 7.0`, then adopt the defaults one at a time after the fixes above, with message serialization last.

## E. Suggested order
1. **On 7.0, ship the prep fixes:** 1, 2, 4, 5, 8–18, plus `reading_completion.to_s`. These are already proven on 7.0.
2. **Upgrade commit:** the Gemfile change with the json pin, fixes 3 and 7, `serialize :preferences, coder: YAML`, the Trix/importmap change, and any `config/secrets.yml` cleanup.
3. **Deploy** workers first, or together with the web servers.
4. **Adopt defaults** gradually, as described in D.

## F. Still unverified
- **Browser behaviour** of Trix 1 against Action Text 8.1, and of Trix 2 against rich text saved under 7.0.
- **Live Sidekiq server** (rather than calling `ActiveJob::Base.execute` on the queued payloads), including retry timing and jitter for fix 13.
- **Real HTTP conditional requests** for `strict_freshness`.
- **json 3 and Rails 8.1.x patches:** whether a later 8.1 patch works with json 3.
- **Production specifics:** the production cache store and how deployment injects the `CITATION_PROVIDER_*` variables.

---

That's the plan for upgrading Rails from 7.0.8.7 to 8.1.0. Following the upgrade skill, I only planned it and didn't change any code. I checked afterwards and the repo is still clean.

Start with step E1: it ships the fixes that work on both versions, including the partial-import fix (14), while you're still on 7.0. Should I go ahead with that?