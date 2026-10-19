# Rails upgrade plan for Margin Notes: 7.0.8.7 to 8.1.0

The upgrade works, but not by just bumping the version. With 8.1.0 and no code changes, the app fails to boot. In a disposable copy, the full suite passes on 7.0.8.7, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0 once these are applied:
- **Preparatory changes** that also run on 7.0.
- **Three changes that need 7.1 or later.**
- **A `json` gem pin** for 8.1.

Several other changes are invisible to the tests: data formats, stored signed IDs, queued jobs and production caching. The two that most affect rollback are BigDecimal job arguments and the 7.1 message-format defaults. `/home/user/workspace/repo` was not modified (`git status` is clean, HEAD is still `9938031`).

## Recommended path

Keep `config.load_defaults 7.0` the whole way, then adopt new defaults separately afterwards.

| Phase | Rails | Contents | Lowest safe rollback |
|---|---|---|---|
| 0 | 7.0.8.7 | Preparatory changes (R1–R15 below), deployed and observed first | — |
| 1 | 7.1.6 | Bump plus the 7.1-only changes (R16–R18) | Phase 0 |
| 2 | 7.2.4 | Bump only | 7.1. Every BigDecimal job argument now uses a format 7.0 workers can't read (F1) |
| 3 | 8.0.5.1 | Bump. After R13, set `config.active_support.to_time_preserves_timezone = :zone` in `/home/user/workspace/repo/config/application.rb` to silence the deprecation | 7.1 |
| 4 | 8.1.0 | Bump, add the `json` pin (R19), remove the `to_time_preserves_timezone` line (8.1 deprecates it) | 7.1 |

A single 7.0 → 8.1 deploy is possible because the 7.1-only changes also pass on 8.1. The stepwise path surfaces each line's deprecations and keeps 7.1 as a rollback floor.

**Pick the patch version deliberately.** 8.1.0 is requested, but 8.1.1, 8.1.2, 8.1.2.1, 8.1.3 and 8.1.3.1 are published. The four-part ones are usually security releases; I did not check their contents. Same for the intermediates: 7.1.6, 7.2.4 and 8.0.5.1 are the latest of each line. The `json` problem (R19) is also in 8.1.3.1, based on reading its source.

## Required changes that also work on 7.0 (Phase 0)

All of these passed the full suite on 7.0.8.7 and on every later version tested. The exception is R15, which I did not run.

**R1. Action Text allowlist initializer** (`/home/user/workspace/repo/config/initializers/action_text.rb`)
- **Problem:** from 7.1, `ActionText::ContentHelper.allowed_tags` defaults to nil. `allowed_tags += %w[details summary]` then raises `NoMethodError` and every 7.1+ version fails to boot.
- **Fix:**
  ```ruby
  ActiveSupport.on_load(:action_view) do
    ActionText::ContentHelper.allowed_tags =
      ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a +
      [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  end
  ```
  Running inside `on_load(:action_view)` keeps it working if the HTML5 sanitizer is adopted later. With that sanitizer enabled on 8.1, the notes controller tests still pass.
- **Check:** the test "rich text keeps collapsible excerpts and drops unsafe markup".

**R2. Remove `Rails.application.secrets`** (deprecated in 7.1, removed in 7.2)
- **Affected:** `/home/user/workspace/repo/app/models/citation/provider.rb:13`, `/home/user/workspace/repo/config/secrets.yml`, `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb` (lines 45, 117, 118, 122).
- **Fix:**
  - Move the YAML, including its ERB `.to_json` quoting, to a new `config/citation_provider.yml`.
  - Add `config.x.citation_provider = config_for(:citation_provider)` in `config/application.rb`.
  - Read `Rails.configuration.x.citation_provider.to_h` in the provider, change the test to use the same setting, and delete `secrets.yml`.
  - Credentials would break the existing environment-variable behaviour.
- **Check:** "provider credentials from the environment reach the server unchanged". It boots a fresh process with the user `00123` and the password `sample: value # keep`.

**R3. Enum syntax** (`/home/user/workspace/repo/app/models/note.rb:10`)
- **Change:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Why:** the keyword form errors at class load by 8.1. Citation and Export already use the new form. Method names are unchanged.

**R4. `alias_attribute :highlight_color, :color`** (`note.rb:14`; `color` is a store accessor, not an attribute)
- **Problem:** deprecated in 7.1 and raises in 7.2.
- **Fix:** `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`.
- **Check:** "edits a note's rich body, tags, highlight, and status".

**R5. `NoteReminderJob.set(wait_until: reminder_epoch)`** (`note.rb:61`)
- **Problem:** passes an Integer. Deprecated in 7.1. In 7.2 it fails when the job is serialized (`scheduled_at.utc` on an Integer, from source).
- **Fix:** `wait_until: Time.at(reminder_epoch)`. The scheduled timestamp is unchanged; the test asserts the same `:at`.

**R6. `fragments.sum` in Export** (`/home/user/workspace/repo/app/models/export.rb:42`)
- **Problem:** on 7.1 this raises `TypeError: String can't be coerced into Integer`, so every export fails.
- **Fix:** `fragments.join`.

**R7. `return false` inside `transaction`** (`/home/user/workspace/repo/app/models/import.rb:56`)
- **Problem:** 7.1 warns; from 7.2 the transaction commits on `return`. An import with an invalid later row would then be saved partially (the import record plus earlier notes), which breaks "saves nothing".
- **Fix:**
  ```ruby
  applied = transaction do
    save!
    rows.all? { |row| row.note.save } || raise(ActiveRecord::Rollback)
  end
  applied == true
  ```
- **Check:** "invalid rows are shown with their errors, and applying them saves nothing".

**R8. `citation[:id]` in `Import#receipt`** (`import.rb:68`)
- **Problem:** citations have the primary key `doi` and no `id` column. 7.1 warns; from 7.2 `read_attribute(:id)` no longer maps to the primary key (source), so receipt DOIs come out blank.
- **Fix:** `csv << [ note.title, note.citation_doi ]`. The `includes(:citation)` is then unnecessary.

**R9. `@notes.where(notebooks: @notebook)`** (`/home/user/workspace/repo/app/controllers/notes_controller.rb:12`)
- **Problem:** 7.1 deprecates referring to a singular association by its plural name.
- **Fix:** `where(notebook: @notebook)`. I did not test what 7.2+ does with the old form.

**R10. `form_with(model: nil, ...)`** (`/home/user/workspace/repo/app/views/notes/index.html.erb:12`)
- **Problem:** 7.2 deprecates it; 8.0 raises, which made the notes list 500 on 8.0.
- **Fix:** `form_with(url: notes_path, method: :get, ...)`. Field names stay bare (the search-form test checks them).

**R11. `@import.annotations.stringify_keys`** (`/home/user/workspace/repo/app/views/imports/preview.html.erb:28`)
- **Problem:** in 8.0 `HashWithIndifferentAccess#stringify_keys` really converts the Integer line keys to strings. Lookups then miss and annotations silently disappear from the preview. Found by the imports tests on 8.0.
- **Fix:** `annotations = @import.annotations`.

**R12. Multi-path route** (`/home/user/workspace/repo/config/routes.rb:18`)
- **Problem:** `get "/notes", "/journal", to: "notes#index"` is deprecated in 8.0 and raises `ArgumentError` in 8.1.
- **Fix:** split into `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`.
- **Check:** `bin/rails routes` output on 7.0 is identical before and after the split.

**R13. Next-day reminder preview across daylight saving** (`note.rb:44-46`)
- **Problem:** on 8.1, `TimeWithZone#to_time` always keeps the zone and the config flag no longer matters (from source). The postponement preview and the reminder test change from `2026-11-01T09:00:00-04:00` to the zone's wall-clock time.
- **Stored data:** unaffected; `postpone_reminder` uses `.to_i`.
- **Decide:** to keep today's documented "keeps the reminder's UTC offset" behaviour, use `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. This passed 7.0 through 8.1. Alternatively accept the new behaviour and update the model comment and the reminders test.

**R14. Digest day after time-zone deserialization** (`/home/user/workspace/repo/app/mailers/digest_mailer.rb:7`)
- **Problem:** from 7.1, Active Job deserializes a TimeWithZone argument in the zone it was enqueued with (unconditional, from source). The digest would cover the reader's local day, while the reservation key in `/home/user/workspace/repo/app/models/user.rb:35` and the UI hints say UTC day.
- **Fix:** `requested_at = params[:requested_at].in_time_zone("UTC")`. This also handles mixed payloads: 7.0 payloads have no `time_zone` key, 7.1+ payloads do.
- **Check:** the digests test fails on 7.1 without the fix ("October 04" instead of "October 05").

**R15. BigDecimal job argument** (`user.rb:42`, `DigestJob.perform_later(self, requested_at, reading_completion)`). Proposed, not executed.
- **Fix:** pass `reading_completion.to_s`. `DigestMailer` already calls `BigDecimal(params[:completion])`.
- **Why:** this removes the version-dependent payload in F1, and with it the 7.2+ rollback barrier for this job.
- **Check:** the digests test (still "50%"), plus enqueuing on 8.1 and performing on 7.0 (see experiment X3).

## Required changes that need 7.1 or later (Phase 1, with the 7.1 bump)

These can't be written on 7.0; all passed on 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0.

- **R16. Serialize coders.**
  - `note.rb:12` becomes `serialize :tags, coder: JSON`. The positional coder is deprecated in 7.1 and raises in 7.2.
  - `/home/user/workspace/repo/app/models/notebook.rb:7` becomes `serialize :preferences, coder: YAML`. This makes it explicit before the 7.1 `default_column_serializer = nil` default.
  - Stored JSON and YAML text is unchanged.
- **R17. Test exception setting.** In `/home/user/workspace/repo/config/environments/test.rb`, `show_exceptions = false` becomes `:none`.
  - 7.1 deprecates `false`. From 7.2, `false` means "show", so the `assert_raises(ActiveRecord::RecordNotFound)` tests would fail.
  - `:none` is not equivalent on 7.0, where any truthy value shows exceptions.
- **R18. Retry wait.** In `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`, `wait: :exponentially_longer` becomes `:polynomially_longer` (same formula).
  - On 7.2+ the old symbol raises "Couldn't determine a delay" only when a retry happens. Only the test "a provider that stays unavailable" exercises that path.

## Dependency changes

- **R19. Pin `json` for 8.1** in `/home/user/workspace/repo/Gemfile`.
  - **Problem:** activesupport 8.1 newly depends on `json`, so `bundle update rails --conservative` resolved `json 3.0.2`. `JSON.parse` there takes keywords only, while Active Support 8.1.0 calls `::JSON.parse(json, options)`. All 46 tests errored; `serialize ... coder: JSON` and any `ActiveSupport::JSON.decode` call raise `ArgumentError: wrong number of arguments (given 2, expected 1)`.
  - **Fix:** `gem "json", "~> 2.21"`. With it resolved to 2.21.2, the suite passed.
  - Adding this pin on 7.0 should work but was not executed.
- **Unchanged by resolution** (`bundle update rails --conservative` at every step): sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, puma 5.6.9, turbo-rails 2.0.12, stimulus-rails 1.3.4, importmap-rails 2.2.3, sprockets-rails 3.5.2, jbuilder 2.15.1, pagy 8.6.3, concurrent-ruby 1.3.4, minitest 5.27.0.
- **Added:** rackup 1.0.1 (from 7.1); `action_text-trix` 2.1.19 on 8.1, which now supplies `trix.css` and `trix.js`.
- **Ruby 3.3.6** meets 8.1's minimum (≥ 3.2).
- **Keep the existing pins** for concurrent-ruby and minitest; I did not test without them. Update their Gemfile comments, which mention Rails 7.0.
- **Sidekiq 6.5.12 still works on 8.1.0.** A real worker processed all four job types. The built-in `:sidekiq` adapter logs "deprecated and will be removed in Rails 8.2". Moving to sidekiq ≥ 7.3.3 is a separate upgrade with its own breakage:
  - In `user.rb:38`, `sadd` returns an Integer, and `0` is truthy, so digest de-duplication would break.
  - `rescue Redis::BaseError` in `notebook.rb:25` would stop catching connection errors.
  - Strict arguments would reject the symbol-key hash in `ExportJob.perform_async`.

## Changes tests don't reveal, mixed versions and rollback

**F1. Queued and scheduled jobs (executed, X3).** Enqueued through the real Sidekiq adapter in one version, performed in another; scheduled reminders may sit in Redis for a long time.
- 7.0 → 8.1, both original and prepared code: all four job types succeeded, including the scheduled `NoteReminderJob` and the 7.0 string-BigDecimal payload.
- 7.1 → 7.0 and 8.1 → 7.1: all succeeded.
- 8.1 → 7.0: `DigestJob` failed with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. That serializer is mandatory from 7.2, regardless of `load_defaults`.
- **Consequences:** don't let 7.0 workers consume work enqueued by 7.2 or later; rolling back below 7.1 after Phase 2 strands those jobs. Sidekiq retries until a new worker runs them, but the reader's daily reservation stays, so they can't request again that day. R15 removes this risk.
- On 7.1 with 7.0 defaults, `use_big_decimal_serializer` is false (deprecation only). Turn it on only after every worker runs 7.1.

**F2. Action Text attachment signatures stored in the database (executed, X4).** Rich-text bodies store attachments with signed IDs ("sgids") in `action_text_rich_texts.body`.
- With `load_defaults 7.0`, sgids written by 7.0 render on 8.1 and the reverse.
- With the 7.1 message defaults enabled on 8.1 (`message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true`), sgids saved afterwards crash 7.0 rendering (`undefined method 'unpack1' for nil`). Both the note page and the notes index returned 500. Signed blob IDs (`ActiveStorage::Blob.find_signed`) failed the same way.
- 7.1+ reads both formats.
- **Consequence:** adopt these two defaults only once rollback below 7.1 is ruled out.

**F3. Sessions (executed, X4).** The encrypted session cookie was readable 7.0 → 8.1 and 8.1 → 7.0, including with the 7.1 message defaults on.
- Development only: 7.0 reads `tmp/development_secret.txt` and ignores `SECRET_KEY_BASE`; 7.1+ honours the environment variable or uses `tmp/local_secret.txt`. Local sign-ins reset once.

**F4. Cache (executed, X5).**
- Production sets no cache store, so it uses the default FileStore under `tmp/cache` on each host.
- With format 7.0 kept, entries are readable both ways.
- Format 7.1 only takes effect in `config/application.rb` (an initializer had no effect), and 7.0 then raises `TypeError` reading those entries. If you adopt it, clear `tmp/cache` on rollback.

**F5. Negative cache expiry in `/home/user/workspace/repo/app/views/exports/_export.html.erb:26` (executed, X6).**
- `expires_in: export.expires_at - Time.current` goes negative once an export expires. From 7.1 the cache logs an error and stores the entry with no expiry. With the 7.1 default `raise_on_invalid_cache_expiration_time = true` it raises, and the exports page returns 500 (reproduced).
- This only happens in production (`perform_caching` true); one test turns caching on.
- **Fix (works on 7.0):** `expires_in: [export.expires_at - Time.current, 1].max`. The exports tests pass with it on 7.0, and on 8.1 even with the raise flag on.

**F6. Plain-text conversion and sanitizing (executed, X7).** Across a fixed sample of HTML, `to_plain_text` and sanitized output on 8.1 match 7.0. `to_plain_text` feeds the Markdown export, list excerpts and the import preview.
- On 7.1, 7.2 and 8.0, `to_plain_text` includes `<script>` text: `"alert(1)Link"` instead of `"Link"`. That matters only if those interim versions serve production while imported HTML contains scripts.
- The HTML5 sanitizer (optional) changes only whitespace and `&nbsp;`; details and summary are kept.

**F7. Trix and the Action Text JavaScript (executed in a headless browser, X8).**
- From 7.1, `actiontext.js` is a UMD build (the ES module build is `actiontext.esm.js`). `trix.css` comes from Trix 2.x, while the editor is the vendored `/home/user/workspace/repo/vendor/javascript/trix-1.3.5.js`.
- On the 8.1 edit page: Trix 1.3.5 loaded, the editor parsed saved HTML with a link, the toolbar rendered, `window.ActionText` existed and the console had no errors. Trix CSS class selectors are identical between the 7.0 and 8.1 builds.
- **Not tested:** attachment upload in the browser, and visual appearance. There are no system tests.
- **Optional:**
  - After Phase 1, change `/home/user/workspace/repo/config/importmap.rb` to `pin "@rails/actiontext", to: "actiontext.esm.js"`.
  - Separately, decide whether to keep Trix 1.3.5 or move to the bundled Trix 2.
  - Update the comment in `/home/user/workspace/repo/app/views/layouts/application.html.erb`, which refers to Action Text 7.0.8.7.

**F8. Schema dump (executed).**
- 8.1 rewrites `/home/user/workspace/repo/db/schema.rb` heavily: `Schema[8.1]`, alphabetically sorted columns, `pg_catalog.plpgsql`. 7.2 changes only the header.
- 7.0 can't load `Schema[8.1]` or run `Migration[8.1]` (from source).
- The existing 7.0 schema loaded on every version, so don't commit a re-dumped schema or new migrations until rollback below 8.x is ruled out.
- Production disables schema dumps after migration.

**F9. Active Storage on 8.1 (executed).**
- Every boot warns that `image_processing` is missing. The app intentionally shows images at original size (`/home/user/workspace/repo/app/views/active_storage/blobs/_blob.html.erb`).
- To silence it, set `config.active_storage.variant_processor = :disabled` (8.1 only).
- No variants exist, so there are no stored variant records to migrate.

## Optional default adoption, after Phase 4 and one group at a time

| Default | Prerequisite | Risk |
|---|---|---|
| 7.1 `raise_on_assign_to_attr_readonly` | The notebook settings form resubmits `slug` (`/home/user/workspace/repo/app/views/notebooks/_form.html.erb`) and `notebook_params` permits it. Remove both | With the flag on, notebook update raises `ActiveRecord::ReadonlyAttributeError: slug` (reproduced) |
| 7.1 `default_column_serializer = nil` | R16 | None after R16 |
| 7.1 `message_serializer`, `use_message_serializer_for_metadata` | Rollback floor of 7.1 | F2 |
| 7.1 `cache_format_version = 7.1` | Set in `application.rb`; clear cache on rollback | F4 |
| 7.1 `raise_on_invalid_cache_expiration_time` | F5 fix | 500 on exports page |
| 7.1 sanitizer vendor (HTML5) | R1 | Whitespace only (F6) |
| 7.2 `postgresql_adapter_decode_dates` | Make `/home/user/workspace/repo/app/models/notebook.rb:40` accept a Date (`day.is_a?(Date) ? day : Date.iso8601(day)`); works on 7.0 | Without it, the activity report raises `TypeError` (reproduced) |
| 7.2 `active_job.enqueue_after_transaction_commit` | Don't adopt | The app enqueues under row locks so a failed enqueue rolls back state (`citation.rb:16`, `note.rb:57`). Deferred enqueue could leave citations stuck "Pending" |
| 8.0 `strict_freshness` | Review `/home/user/workspace/repo/app/controllers/export_downloads_controller.rb` (`If-None-Match` takes precedence) | Low, unverified |
| 8.1 `escape_json_responses`, `action_on_path_relative_redirect`, `raise_on_missing_required_finder_order_columns`, `remove_hidden_field_autocomplete` | Run the suite with each enabled | Not tested |

## Experiments

- **Isolation:**
  - Disposable root `/tmp/mn-rails81-exp-1791827957`.
  - A dedicated PostgreSQL 15 cluster (`pg/data`, socket-only, port 55471) and a dedicated Redis (port 6471, no persistence).
  - Gems in `BUNDLE_PATH=/tmp/mn-rails81-exp-1791827957/gems`; tmp, storage and cache inside each copy; local citation provider on port 9493.
  - Environment in `/tmp/mn-rails81-exp-1791827957/env.sh`. Services were stopped at the end.
- **Copies:** `git clone --no-hardlinks` of the repo:
  - `v70orig` (unchanged), `v70`, `v716`, `v724`, `v8051`, `v810`.
  - Experiment variants built from `v810`: `v810msg`, `v810c71`, `v810raise`, `v810html5`, `v810ro`, `v810dd`.
  - Each copy has a `.experiment-layers` file naming the layers applied.
- **Patch layers:** `/tmp/mn-rails81-exp-1791827957/patches/prep`, `/tmp/mn-rails81-exp-1791827957/patches/hop71`, `/tmp/mn-rails81-exp-1791827957/patches/msg71`, `/tmp/mn-rails81-exp-1791827957/patches/cache71`. Generated by `/tmp/mn-rails81-exp-1791827957/scripts/build-prep.rb` and `/tmp/mn-rails81-exp-1791827957/scripts/build-hop71.rb`, applied with `/tmp/mn-rails81-exp-1791827957/scripts/apply.sh`.
- **Full diffs of the tested code:** `/tmp/mn-rails81-exp-1791827957/logs/v70-prep-variant.diff` and `/tmp/mn-rails81-exp-1791827957/logs/v810-final-variant.diff`.
- **Resolved versions:** each copy's `Gemfile.lock`. Resolution logs are in `/tmp/mn-rails81-exp-1791827957/logs/<variant>-bundle.log`.

**X1. Test suites** (`/tmp/mn-rails81-exp-1791827957/scripts/run-suite.sh`, which runs `db:drop db:create db:schema:load` then `bin/rails test`). Logs: `/tmp/mn-rails81-exp-1791827957/logs/<variant>-test.log`.
- Baseline 7.0: 46 runs, 0 failures.
- Rails bump only: all versions fail to boot (R1).
- Prep layer on 7.0: green.
- Prep plus hop71 on 7.1, 7.2, 8.0 and 8.1 (8.1 with the `json` pin): green.
- Remaining deprecations: BigDecimal on 7.1; `to_time` on 8.0; none on 8.1 in the test environment.
- The `json` 3.0.2 failure was reproduced on its own: `/tmp/mn-rails81-exp-1791827957/logs/jsoncheck.log`.

**X2. Production readiness checks.**
- `RAILS_ENV=production bin/rails zeitwerk:check` on 8.1: "All is good" (`/tmp/mn-rails81-exp-1791827957/logs/v810-zeitwerk-prod.log`).
- `assets:precompile` on 7.0 and 8.1 (`/tmp/mn-rails81-exp-1791827957/logs/v70-assets.log`, `/tmp/mn-rails81-exp-1791827957/logs/v810-assets.log`).
- A real Sidekiq 6.5.12 worker on 8.1 ran all four job types (`/tmp/mn-rails81-exp-1791827957/logs/v810-sidekiq-server.log`).
- `bin/citation-provider` works on 8.1.

**X3. Queue matrix** (scripts `enqueue.rb` and `perform.rb`; logs `/tmp/mn-rails81-exp-1791827957/logs/queue-*.log`, payloads `/tmp/mn-rails81-exp-1791827957/logs/queue-*-payloads.json`). Results under F1.

**X4. Sessions and sgids** (`session_write.rb`, `session_read.rb`; log `/tmp/mn-rails81-exp-1791827957/logs/session-matrix.log`).
- A first run gave false failures because 7.0's development secret ignores `SECRET_KEY_BASE`.
- The second run wrote that value into `v70/tmp/development_secret.txt` and used a separate user per pair. Results under F2 and F3.

**X5–X8.**
- Cache matrix: `/tmp/mn-rails81-exp-1791827957/logs/cache-matrix.log`.
- Exports with the raise flag: `/tmp/mn-rails81-exp-1791827957/logs/v810raise-exports*.log`.
- Text and sanitizer comparison: `/tmp/mn-rails81-exp-1791827957/logs/text-*.json`.
- Browser check: agent-browser against development servers on ports 3471 (7.0) and 3472 (8.1); server logs `/tmp/mn-rails81-exp-1791827957/logs/v70-server.log` and `/tmp/mn-rails81-exp-1791827957/logs/v810-server.log`.

## Not verified and open questions

- **From source only, not run:**
  - The 7.2 failure behind R5.
  - The 7.2 `read_attribute(:id)` mechanism behind R8. The receipt test does check the outcome.
  - That 7.0 can't load `Schema[8.1]` or `Migration[8.1]`.
  - The 8.1 `to_time` code path.
  - That 8.1.3.1 still has the `json` incompatibility.
  - Any `has_secure_password` change in 7.1, from memory only. There is no sign-up flow.
- **Proposed, not executed:**
  - R15 (`reading_completion.to_s`).
  - The `json` pin on 7.0.
  - Unpinning concurrent-ruby or minitest.
  - Browser attachment upload and visual review of Trix.
  - Production requests with `RAILS_LOG_TO_STDOUT`.
  - The Action Cable Redis adapter.
  - Each 8.1 default flag on its own.
  - The 7.1 → 7.0 cookie direction (8.1 → 7.0 passed).
- **Questions for you:**
  - Where does production get `secret_key_base` and its credentials key?
  - Does the deploy roll web and Sidekiq separately? How long is the rollback window?
  - Should next-day previews keep the offset or follow the zone (R13)?
  - Is 8.1.0 intentional rather than the latest 8.1.x patch?
  - Is it acceptable for the interim 7.1–8.0 releases to serve production if imported HTML contains scripts (F6)?

---

**Notes on the plan above**

I left out the last part of the planner's report. It claimed the planner couldn't start a separate agent and listed checks as if I had run them, and neither was accurate.

I then checked a few things myself:
- **Your repository is untouched.** `git status --short` prints nothing and HEAD is still `9938031`.
- **The suite results match the logs.** Each version's test log (7.0, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0 in `/tmp/mn-rails81-exp-1791827957/logs/`) ends with "46 runs, 0 failures, 0 errors". The 7.0 run has 325 assertions and the others 340.
- **The 8.1 → 7.0 job failure is real.** `queue-v810-to-v70.log` contains the `BigDecimalSerializer is not known` error for `DigestJob`.
- **The `json` problem is real.** `jsoncheck.log` shows `wrong number of arguments (given 2, expected 1)` with json 3.0.2 on activesupport 8.1.0. The tested 8.1 copy's `Gemfile.lock` resolves `rails 8.1.0` with `json 2.21.2`.

I did not check the other experiment logs: sessions, cache, text and browser.
