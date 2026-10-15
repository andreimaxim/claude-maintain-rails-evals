The planner's full plan is below. I haven't changed the working application.

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

I did not modify `/home/user/workspace/repo`. Its `git status` is clean.

The baseline suite passes on 7.0.8.7 (46 runs, 0 failures). The same suite on Rails 8.1.0, before any repair, boots, then fails or errors on almost every request.

Evidence, patches and logs:
- `/tmp/out/changes.txt` is the gem-changes index.
- `/tmp/out/up_required_fixes.diff` is the full set of repairs applied to the disposable upgraded copy.
- The other logs are listed under "Evidence" at the end.

## How I tested

- **Copies.** All work was in disposable copies under `/tmp/upg`:
  - `base` is 7.0.8.7.
  - `up` is 8.1.0 with `load_defaults 7.0` kept and the required repairs applied.
  - `up2` is `up` with `load_defaults 8.1`.
  - `prep` is 7.0.8.7 plus only the preparatory repairs.
- **Isolation.** Each copy had its own Postgres databases (`mn_iso_*`) and I started a private Redis on port 6391. Active Storage and the mail output directory (`tmp/mails`) live inside each copy.
- **Setup.** I upgraded with `bundle update rails --conservative` after editing the Gemfile pin. Resolved: rails 8.1.0, actiontext 8.1.0, rack 2.2.x, sidekiq 6.5.12, redis 4.8.1, nokogiri-based `rails-html-sanitizer` 1.7.1, `bigdecimal` 4.1.3, `json` 2.21.2, Ruby 3.3.6.
- **Execution.** I ran the suite, `zeitwerk:check`, eager load, a production-mode boot and `assets:precompile`. I also ran a real Sidekiq 6.5.12 worker in both directions and loaded cross-version data.
- **Not exercised.** There are no system tests (`test/system` is empty) and I ran no browser.

## Required changes

Each is marked as source-based or executed. "Fails without repair" is the observed behaviour on 8.1.0.

### R1. Boot breaks: `config/initializers/action_text.rb` (executed)
- **Without repair:** `undefined method '+' for nil`. In 8.1, `ActionText::ContentHelper.allowed_tags` is `nil` by default. In 7.0 it was pre-filled, so `+=` worked.
- **Repair:** assign it explicitly in `after_initialize`, so the sanitizer vendor is already configured:
  `ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`
- **Also works on 7.0.8.7:** yes, it passed in the `prep` copy.
- **Validation:** `NotesControllerTest` "rich text keeps collapsible excerpts and drops unsafe markup" passes. The control is that `<script>` is still stripped, and `figure` and attachment markup are still allowed.

### R2. Boot breaks: `config/routes.rb` line `get "/notes", "/journal", to: "notes#index"` (executed)
- **Without repair:** `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Multi-path routes were deprecated in 8.0 and removed in 8.1.
- **Repair:** split into two `get` lines. The route names stay `notes_path` and `journal_path`.
- **Also works on 7.0.8.7:** yes.
- **Validation:** the existing "both list paths" test, which loops over `notes_path` and `journal_path`.

### R3. Boot breaks: `Note` model declarations (executed)
- **Enum.** `enum status: {...}, _prefix: true` gives `wrong number of arguments (given 0, expected 1..2)`.
  - **Repair:** `enum :status, {draft: 0, ready: 1}, prefix: true`.
  - **Also works on 7.0.8.7:** yes. The generated `status_draft?` and `status_ready` methods are unchanged.
- **Serialize.** `serialize :tags, JSON` gives `ArgumentError (given 2, expected 1)`.
  - **Repair:** `serialize :tags, coder: JSON`.
  - **Also works on 7.0.8.7:** no. The `coder:` keyword is 7.1+, so this ships in the upgrade commit.
  - **Stored data:** the column is text holding JSON, so existing rows are unchanged. I read tags written by 7.0 on 8.1.
- **Alias.** `alias_attribute :highlight_color, :color` fails on first model use with `Note model aliases 'color', but 'color' is not an attribute`. `color` is a `store_accessor`.
  - **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
  - **Also works on 7.0.8.7:** yes.
  - **Check:** the form post param `highlight_color` still saves.

### R4. Gem pin: `json` 3.1.0 is locked and breaks every JSON read (executed)
- **Without repair:** `ArgumentError (given 2, expected 1)` from `json-3.1.0/common.rb:291`. Rails 8.1.0 `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)` with a positional hash, and json 3 accepts keywords only. It shows up in `ActiveRecord::Coders::JSON.load`, so any JSON-coded column read fails, including during transaction rollback.
- **Repair:** `gem "json", "< 3"`. It resolved to 2.21.2 and I ran everything on that. The alternative is to move to a later 8.1.x patch that fixes it (the remote index lists 8.1.1 through 8.1.4). I did not test those, and I did not test whether 8.1.x supports json 3.
- **Also works on 7.0.8.7:** I did not test the pin there.

### R5. `Rails.application.secrets` is removed (executed)
- **Affected code:** `Citation::Provider#initialize` and `config/secrets.yml`, plus the test helper `with_provider`.
- **Without repair:** `NoMethodError: undefined method 'secrets'`. In production, `CitationEnrichmentJob` raises `NoMethodError`, which is not a `Provider::Error`. The citation stays `pending` and `request_enrichment` keeps answering "already being fetched".
- **Repair:** move the file to `config/citation_provider.yml` (same ERB and env sections) and set `config.x.citation_provider = config_for(:citation_provider)`. `Provider` reads `Rails.configuration.x.citation_provider.to_h`. Tests swap `Rails.configuration.x.citation_provider` instead of the secrets object, so each case still gets an isolated setting.
- **Also works on 7.0.8.7:** yes.
- **Docs to update:** `ARCHITECTURE.md` and `CONTRIBUTING.md` mention `secrets.yml`.
- **Validation:** the three provider tests, which cover credentials reaching the server and the 503 retry. A production-mode boot printed `[:url, :user, :password]`.

### R6. `Export#generate` crashes: `fragments.sum` (executed)
- **Without repair:** `TypeError: String can't be coerced into Integer`. Active Support's `Enumerable#sum` override was removed (it was deprecated in 7.0, which the baseline log shows).
- **Repair:** `fragments.join`.
- **Also works on 7.0.8.7:** yes, and it removes the deprecation warning.
- **Check:** the produced Markdown is identical.

### R7. `app/views/notes/index.html.erb`: `form_with(model: nil, ...)` (executed)
- **Without repair:** `ArgumentError: Passed nil to the :model argument, expect an object or false`. The notes list returns HTTP 500.
- **Repair:** `model: false`.
- **Also works on 7.0.8.7:** yes.

### R8. `NotesController#index`: `where(notebooks: @notebook)` (executed)
- **Without repair:** `PG::UndefinedColumn: column notes.notebooks does not exist`. It fails only when the `notebook_id` filter is present.
- **Repair:** `where(notebook: @notebook)`.
- **Also works on 7.0.8.7:** yes.
- **Validation:** "filters by notebook, status, and title". The control is that the unfiltered list is unchanged.

### R9. `CitationEnrichmentJob`: `wait: :exponentially_longer` was removed (executed)
- **Without repair:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. Experiment with the provider down: `perform_now` raised and the citation stayed `pending`. The first retry never schedules, and the "record the failure after 3 attempts" block never runs.
- **Repair:** `:polynomially_longer`.
  - **Delay formula:** unchanged, executions^4 + 2 seconds.
  - **With repair:** `perform_now` returned, status `pending`, 1 retry in Sidekiq's scheduled set.
- **Also works on 7.0.8.7:** no, so this ships in the upgrade commit.
- **Queued jobs:** retries already in Redis store only `executions`, so they are unaffected.

### R10. `Note#schedule_reminder`: `wait_until:` with an Integer (executed)
- **Without repair:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Scheduling a reminder returns 500.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`.
- **Also works on 7.0.8.7:** yes.
- **Queue data:**
  - 7.0 reminder payloads in the Sidekiq schedule have no `scheduled_at`, and a 7.0-enqueued past-due reminder ran and mailed on 8.1.
  - 8.1 payloads add `scheduled_at` as an ISO string, and a 7.0 worker ran one fine.

### R11. `Import#apply`: partial import now commits (executed). This is the highest-impact silent data bug.
- **Cause:** `return false` inside `transaction do ... end` rolled the transaction back in 7.0. In 7.2+ it commits.
- **Without repair:** the test "invalid rows ... applying them saves nothing" failed with `record_counts changed. Expected [0, 3, 0, 1], Actual [1, 4, 1, 2]`. That is one Import, valid rows' notes and Citation saved, with the invalid row rejected.
- **Repair:** do the work in the transaction, then `raise ActiveRecord::Rollback unless saved`, and return `saved`.
- **Also works on 7.0.8.7:** yes.
- **Paths kept working:** the success path still returns true and saves everything, and the controller still renders `:preview` with errors on failure. Counts return to `[0,3,0,1]`.

### R12. `Import#receipt`: `citation[:id]` now returns nil (executed)
- **Cause:** `citations` has primary key `doi` and no `id` column. 7.0 returned the primary key for `[:id]`; 7.2+ does not.
- **Without repair:** the CSV receipt's `doi` column is blank for every row.
- **Repair:** `citation&.doi`.
- **Also works on 7.0.8.7:** yes.
- **Validation:** the receipt test, with a control row that has no citation and so an empty cell.

### R13. `imports/preview.html.erb`: annotations silently disappear (executed)
- **Cause:** `@import.annotations.stringify_keys`. In 7.0, `HashWithIndifferentAccess#stringify_keys` returned a dup, so integer line keys survived. In 8.1 it converts them to `"2"`, so the lookup `annotations[row.line]` returns nil.
- **Without repair:** the page renders without errors but has no Annotation line. The preview is the user's last look before import, and the form posts the raw CSV, so the saved data is correct.
- **Repair:** use `row.annotation` (the `Row` struct already carries it) and drop `annotations` and `stringify_keys`.
- **Also works on 7.0.8.7:** yes.
- **Validation:** `#line_2 dd` includes "Read <b>twice</b> & reflect", with escaping preserved.

### R14. Digest day changes (executed)
- **Cause:** 8.1 serializes the time zone (`"time_zone":"America/New_York"`), so `DigestMailer` receives a local-zone time. The code and docs promise the UTC day.
- **Without repair:** the digest says "October 04" instead of "October 05, 2026" and covers the reader's local day. It also lists the wrong notes.
- **Repair:** in `DigestMailer#daily_digest`, add `requested_at = requested_at.utc`. I recommend this over changing the enqueue side, because the job payload and the existing "job carries the reader's local time" assertion stay unchanged and old queued payloads work too.
- **Executed:** a 7.0-enqueued digest (Eastern local time 23:46 on Oct 14) ran on 8.1 and produced "October 15, 2026".

### R15. `BigDecimal` job argument breaks rollback (executed)
- **Cause:** `DigestJob` is enqueued with a `BigDecimal` completion. 8.x always uses `BigDecimalSerializer` (the 7.1 opt-in flag was removed). 7.0 payloads were `"0.5"`.
- **Executed:** a 7.0 worker given the 8.1 payload failed with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. During a rolling deploy, or a rollback with jobs in Redis, those jobs fail and go to Sidekiq retry.
- **Repair:** enqueue `reading_completion.to_s("F")`, a string. The mailer already runs `BigDecimal(params[:completion])`, so it behaves the same.
- **Executed:** the string payload was run by the 7.0 worker and sent the mail with "100% ...". The digest test still passes.
- **Also works on 7.0.8.7:** yes. Ship it before the upgrade.

### R16. Test environment: `config.action_dispatch.show_exceptions = false` (executed)
- **Without repair:** 8.1 treats anything other than `:none` or `:rescuable` as "show". Tests that `assert_raises(ActiveRecord::RecordNotFound)` get "expected but nothing was raised" (7 failures). Production is unaffected.
- **Repair:** `:none`. This is 7.1+ only.

### R17. `NotesController#index` next-day reminder display (executed behavior change, decision needed)
- **Cause:** `Note#next_day_reminder_at` is `reminder_at.to_time + 86_400`.
  - The 8.1 line `config.active_support.to_time_preserves_timezone` is deprecated and no longer read. `to_time` now keeps the zone even with `load_defaults 7.0`.
  - So the preview across the 2026-11-01 DST end changed from `2026-11-01T09:00:00-04:00` to `2026-11-01T08:00:00-05:00`.
- **Scheduling:** the instant is the same (13:00Z), so what gets scheduled is unchanged. Only the displayed wall time and offset differ.
- **Recommendation:** accept the new display, which is the reader's local time. Use `reminder_at + 86_400`, update the existing test assertion and the model comment ("keeps the reminder's UTC offset"), and note that the label "24 hours later" stays true.
- **Alternative:** to keep the old display you would need manual offset math. I do not recommend it.
- **Also works on 7.0.8.7:** no. It would change 7.0's display, so it ships with the upgrade.

### R18. Production gem and deprecation
- Rails 8.1 deprecates the built-in Active Job `sidekiq` adapter (`DEPRECATION WARNING ... removed in Rails 8.2`, seen in `log/development.log`). Sidekiq 6.5.12 plus Rails 8.1.0 ran correctly in both directions in my test.
- Plan: this is required before Rails 8.2, not now. Moving to Sidekiq 7.3.3+ also moves to redis-client, which changes behavior this app depends on:
  - `Sidekiq.redis { |r| r.sadd(...) }` in `User#request_digest` returns an Integer, not a boolean, so `0` is truthy.
  - `rescue Redis::BaseError` in `Notebook#request_export` would no longer catch the right class.
- Do that as a separate change.

## Optional default adoption (`load_defaults 7.0` stays valid)

I ran `up2` with `load_defaults 8.1` plus the required repairs and `serialize :preferences, coder: YAML`. Result: 46 runs, 3 errors and 1 failure, and all were traced to the items below.

The tool's index listed defaults only through 8.0. I read the 8.1 defaults from `railties-8.1.0/lib/rails/application/configuration.rb`, and the list below includes them.

### Defaults that would break this app if adopted

| Default (version) | What happens here | Fix |
|---|---|---|
| `active_record.default_column_serializer = nil` (7.1) | `serialize :preferences` boots with "missing keyword: :coder", 46 errors. | `serialize :preferences, coder: YAML` keeps the existing YAML text, and I read data written by 7.0. 7.0 cannot take `coder:`, so adopt it in one step. Before rollout, check for non-safe-loadable stored YAML (for example `!ruby/hash:`) with `select count(*) from notebooks where preferences like '%!ruby%'`. Not run on real data. |
| `active_record.raise_on_assign_to_attr_readonly = true` (7.1) | `Notebook.update(notebook_params)` with the resubmitted `:slug` raises `ReadonlyAttributeError: slug`. | Drop `:slug` from `notebook_params` and the form field. |
| `active_record.postgresql_adapter_decode_dates = true` (7.2) | `Notebook#daily_note_counts` fails with `TypeError: no implicit conversion of Date into String` from `Date.iso8601`. | Stop calling `Date.iso8601` on the value, or branch on its class. Wait to ship until adoption. |
| `active_support.raise_on_invalid_cache_expiration_time = true` (7.1) | `exports/_export.html.erb` uses `expires_in: export.expires_at - Time.current`, which is negative for an expired export. The exports page 500s: `Cache expiration time is invalid, cannot be negative: -60`. | Use `cache_if export.downloadable?` with `[remaining, 1].max`. |

**Cache behavior today (observed, no flag):** a negative `expires_in` stores the value and `read` returns it. On 7.0 it returned nil. On current settings the "Expired" fragment is cached without ever expiring. The content is correct, so this is harmless, and `ExportDownloadsController` still checks authorization on every request.

### Defaults I did not execute or that stayed green in `up2`

- **`active_job.enqueue_after_transaction_commit` (7.2).**
  - **Does the default change?** Under 8.1.0 the class default is `false`. It is `true` only if you adopt `load_defaults 7.2` or later, or set it.
  - **Executed result:** with it forced to `true` and Redis unreachable, `Citation#request_enrichment` leaves the citation `pending` and `Note#schedule_reminder` leaves `reminder_job_id` set with `scheduled?` true.
  - **With it left `false`:** the transaction rolls back and the state is nil.
  - **Why it matters:** both methods document that a failed enqueue rolls back under the row lock.
  - **Recommendation:** keep it `false`. A tolerant fix would be an explicit `after_commit` compensating cleanup, which I did not build.
- **HTML5 sanitizer vendors (7.1).** Rendering stored rich text through a sample set differed slightly (see `/tmp/out/sanitizer_diff.txt`). Examples: attribute text in a `<noscript>` title is no longer escaped, whitespace between tags changes, and `<math>` content is dropped. The collapsible-excerpt test still passes. Review stored bodies before adoption.
- **`action_dispatch.strict_freshness` (8.0).** `ExportDownloadsController#stale?` passes both `etag:` and `last_modified:`. With strict freshness, only `If-None-Match` is consulted when both headers arrive. I did not run a conditional-GET experiment. A matching ETag with an older `If-Modified-Since` now returns 304 where 7.0 returned 200.
- **`active_support.message_serializer` and `use_message_serializer_for_metadata` (7.1)**, and **`marshalling_format_version` and `cache_format_version = 7.1`.** Not exercised. Rolling out new defaults then rolling back leaves signed values, Action Text `sgid`s and fragment caches written by the new format unreadable to the old version. Leave them off on the first deploy and enable them in a later one.
- **8.1 defaults:** `escape_json_responses = false`, `action_on_path_relative_redirect = :raise`, `raise_on_missing_required_finder_order_columns`, `escape_js_separators_in_json = false`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete`. These are neutral for the app's routes and forms as written (`redirect_to` uses path helpers and `/notes`), and the `up2` run was otherwise green.
- **8.0:** `Regexp.timeout = 1` is neutral. The DOI regex is anchored and linear.
- **7.2:** `config.yjit = true` is a memory trade-off in production. `web_image_content_types` adds WebP and `validate_migration_timestamps` is fine for the existing 2026-10-11 migrations.
- **7.1 callbacks:** `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction` and `generate_secure_token_on` do not apply, because no models use these.
- **`config.cache_classes = true` (test and production)**, `config.i18n.fallbacks` and `config.active_support.report_deprecations` still boot.

## Rollout and rollback

1. **Preparatory release on 7.0.8.7.** Ship R1, R2, R3 (enum and `alias_method` only), R5, R6, R7, R8, R10, R11, R12, R13, R14 and R15. In the `prep` copy all 46 tests passed on 7.0.8.7.
2. **Upgrade release.** Ship the Gemfile pin to 8.1.0 and `json < 3`, plus the 7.1+-only edits (`serialize :tags, coder: JSON`, R9, R16, R17).
3. **Queued work.** 7.0 payloads in Redis ran correctly on 8.1: the digest, the reminder and the immediate retry. 8.1 payloads fail on a 7.0 worker unless R15 is in place. 7.0 workers ran an 8.1 reminder payload fine.
4. **Rollback.** Without R15, any `DigestJob` enqueued by 8.1 fails on a 7.0 worker and lands in the retry set. Stored data was readable both ways in my test: YAML `preferences`, JSON `tags` and jsonb `settings`.
5. **Schema.** `db:schema:dump` on 8.1 reorders columns alphabetically (fixing the diff to `ActiveRecord::Schema[8.1]` and `pg_catalog.plpgsql`) and changes no database objects. Commit it separately.

## Remaining questions and unverified claims

- I did not try 8.1.1 through 8.1.4. I did not test whether `json` 3 works with a later 8.1.x.
- `csv` is still a default gem on Ruby 3.3.6. `app/models/import.rb` emits a warning about Ruby 3.4, so add `csv` to the Gemfile before upgrading Ruby.
- Production `file_store` cache behaviour was observed through a small script, not through the exports page.
- Whether real production `notebooks.preferences` rows contain YAML that safe-loads is unknown, and it only matters if `default_column_serializer` is adopted.
- No browser or system tests exist or were run.

## Evidence

All under `/tmp/out`:
- `base_test.log`: baseline suite, 46 runs green.
- `up_test1.log` through `up_test7.log`: progressive upgrade runs. `up_test7.log` has the final state: 1 remaining failure, the R17 display assertion, which needs the test update.
- `up2_load_defaults_8_1.log`: `load_defaults 8.1`.
- `prep_on_7_0_8_7.log`: preparatory repairs on 7.0.8.7.
- `bundle_update.log`: dependency resolution.
- `enqueue_base.txt`, `enqueue_up.txt` and `enqueue_failure.txt`: payloads and the failed-enqueue experiment.
- `sidekiq_up_old_payloads.log` and `sidekiq_base_new_payloads.log`: the two worker directions.
- `sanitizer_diff.txt`, `cache_negative_expiry.txt` and `assets_precompile_up.log`.
- `up_required_fixes.diff` and `changes.txt`.

The disposable copies are in `/tmp/upg/{base,up,up2,prep}`. The planner's Redis on 6391 is shut down, and the `mn_iso_*` databases are still in Postgres.

---

**Commentary:** Two decisions are yours before implementation. The first is R17: do you accept the new local-time display for the next-day reminder? The second is whether to ship the preparatory release (step 1) separately from the upgrade release. I recommend that, because the rollback safety for queued jobs depends on R15 going out first. Tell me whether to implement it and how you want it split.