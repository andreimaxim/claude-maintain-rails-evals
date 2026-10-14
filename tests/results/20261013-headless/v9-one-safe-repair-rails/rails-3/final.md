I've written the plan for upgrading `rails` from 7.0.8.7 to 8.1.0 below. Nothing in `/home/user/workspace/repo` was changed. All experiments ran in copies under `/tmp/exp`, each with its own Postgres databases and Redis db number.

On Rails 8.1.0 the app as written fails to boot. The first error is `NoMethodError: undefined method '+' for nil` in `config/initializers/action_text.rb`. After the boot and load errors, the suite ran with 14 failures and 32 errors. Once the 16 repairs in section B were applied, it passes 46 runs with 0 failures and 0 errors.

The most serious problems the tests would not have caught on their own:
- **Import commits partial data.** A failed CSV import now saves the import and the earlier rows.
- **Wrong digest day.** The daily digest covers the reader's local day instead of the UTC day.
- **Rollback breaks queued digests.** Digest jobs queued by 8.1 cannot be read by 7.0 workers.

Labels: **[exec]** means I saw it happen in an experiment, **[src]** means it comes from reading source or changelogs, **[proposed]** means a check not yet run.

## A. Experiment record

| Copy | What it is | DBs / Redis | Result |
|---|---|---|---|
| `/tmp/exp/base` | current app, 7.0.8.7 | `mnx_base_*`, redis db 13 | 46 runs, 0 failures (`/tmp/exp/base-test.log`) |
| `/tmp/exp/up` | 8.1.0, `load_defaults 7.0` kept | `mnx_up_*`, db 14 | Failed to boot, then 14F/32E (`up-boot1.log`, `up-test1.log` … `up-test6.log`); after fixes 0F/0E (`up-test7.log`) |
| `/tmp/exp/def` | `up` plus `load_defaults 8.1` | `mnx_def_*`, db 15 | Failures listed in section C (`def-test.log`, `def-test2.log`); after fixes 0F/0E (`def-test3.log`) |
| `/tmp/exp/port` | 7.0.8.7 plus the fixes that also work on 7.0 | `mnx_port_*`, db 12 | 46 runs, 0F/0E (`port-test.log`) |

- **Resolved dependencies** (`/tmp/exp/up-Gemfile.lock.r2`): rails 8.1.0, json 2.21.2 (pinned below 3), rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, pg 1.6.0, concurrent-ruby 1.3.4, minitest 5.27.0. The first resolution, before the json pin, is in `up-Gemfile.lock.r1`.
- **Patches:** `/tmp/exp/up-app.patch` (required fixes) and `/tmp/exp/def-app.patch` (required fixes plus default adoption).
- **Probe scripts:** `/tmp/exp/scripts/probe.rb`, `at.rb` and `jobs.rb`. Their output is in `/tmp/exp/probe-{base,base2,up,def}.log`.
- **Change summary:** `/tmp/gc.txt`.
- **Live smoke test [exec]:** Puma served `GET /session/new` with a 200. A real Sidekiq 6.5.12 worker on 8.1 ran ExportJob, DigestJob, NoteReminderJob and CitationEnrichmentJob, and the enrichment retry fired. Logs: `/tmp/exp/up-server.log`, `/tmp/exp/up-sidekiq.log`.

## B. Required changes (behavior with `load_defaults 7.0` kept)

"Works on 7.0" means the fix passed the 7.0 suite in `/tmp/exp/port`. Those fixes can ship ahead of the Rails bump.

1. **Dependency resolution: json 3.x**
   - What happens: `bundle update rails` resolved json 3.1.0. Every serialized-column load then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291`, because Active Support 8.1.0 calls `JSON.parse(json, options)`.
   - Fix: add `gem "json", "< 3"` (it resolved to 2.21.2).
   - Check: remove the pin later and confirm `Note.first.tags` still loads.

2. **`config/initializers/action_text.rb`: `allowed_tags` is nil in 7.1+** [exec]
   - What happens: boot fails with `undefined method '+' for nil (NoMethodError)`.
   - Fix: inside `Rails.application.config.after_initialize`, set `ActionText::ContentHelper.allowed_tags = sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. Works on 7.0.
   - Check [exec, `at.rb`]: on 7.0, on 8.1 with the HTML4 sanitizer, and on 8.1 with the HTML5 sanitizer, `<details>`, `<summary>` and `<figure>` survive and `<script>` is stripped.

3. **`Note`: keyword-style `enum status: …, _prefix: true`**
   - What happens: eager load fails at `note.rb:10` with `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0.

4. **`Note`: `serialize :tags, JSON`**
   - What happens: `ArgumentError (given 2, expected 1)` at `note.rb:12`.
   - Fix: `serialize :tags, coder: JSON`. The stored format is unchanged. This does **not** work on 7.0, so it must ship in the upgrade commit.

5. **`Note`: `alias_attribute :highlight_color, :color`, where `color` is a `store_accessor`, not an attribute**
   - What happens: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.` It is raised on first model use, so `db:seed` fails.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. The writer is needed because the form and `note_params` use it. Works on 7.0.

6. **`config/routes.rb`: `get "/notes", "/journal", to: …`**
   - What happens: `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Routes don't load, so every path helper is missing.
   - Fix: two `get` lines. This keeps the `notes` and `journal` route names. Works on 7.0.

7. **`Rails.application.secrets` was removed** (`Citation::Provider#initialize` and the citation test)
   - What happens: `NoMethodError: undefined method 'secrets'`.
   - Fix: move `config/secrets.yml` to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider.to_h`. The test should mutate that value instead. Works on 7.0.
   - Deploy note: production still reads `CITATION_PROVIDER_*` from the environment, but make sure deploy tooling no longer looks for `secrets.yml`.

8. **`Export#generate`: `fragments.sum` on Strings**
   - What happens: `TypeError: String can't be coerced into Integer`. Every export fails in the worker.
   - Fix: `fragments.join`. Works on 7.0.

9. **`notes/index.html.erb`: `form_with(model: nil, …)`**
   - What happens: `ActionView::Template::Error (Passed nil to the :model argument…)`, so the notes list returns 500.
   - Fix: drop `model: nil`. Works on 7.0.

10. **`NotesController#index`: `where(notebooks: @notebook)`**
    - What happens: `PG::UndefinedColumn: column notes.notebooks does not exist` whenever the list is filtered by notebook.
    - Fix: `where(notebook: @notebook)`. Works on 7.0.

11. **`Note#schedule_reminder`: `set(wait_until: <Integer>)`**
    - What happens: `NoMethodError (undefined method 'utc' for an instance of Integer)`, so scheduling and postponing reminders both return 500.
    - Fix: `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
    - Check [exec]: Sidekiq's scheduled set holds `2030-01-01T09:00:00Z` on both versions.

12. **`CitationEnrichmentJob`: `wait: :exponentially_longer`**
    - What happens: on the first provider outage the retry raises `RuntimeError (Couldn't determine a delay based on :exponentially_longer)`. This is not raised at load time.
    - Fix: `:polynomially_longer`, which uses the same formula. Not available on 7.0, so it ships with the upgrade.
    - Check [exec]: a live retry was rescheduled.

13. **`Import#apply`: `return false` inside `transaction`** (silent data change)
    - What happens: 7.2+ always commits on a non-local exit. A CSV whose second row is invalid persisted the Import, the first Note and the Citation: `Expected [0, 3, 0, 1] Actual [1, 4, 1, 2]`.
    - Fix: `saved = transaction { save!; rows.all? { |r| r.note.save } or raise ActiveRecord::Rollback }`, then return `saved == true`. Works on 7.0.
    - Paths covered: successful apply, failed apply, and the controller re-rendering the preview after a failure.

14. **`Import#receipt`: `citation[:id]`, where the primary key is `doi`**
    - What happens: the receipt CSV's doi column is empty (`On idleness,` instead of `On idleness,10.1000/Essays.1`).
    - Fix: `citation&.doi`. Works on 7.0.

15. **`imports/preview.html.erb`: `annotations.stringify_keys[row.line]`**
    - What happens: HashWithIndifferentAccess now stringifies Integer keys too, so annotations silently disappear from the preview.
    - Fix: use `row.annotation`, which the Row struct already carries. Works on 7.0. `Import#annotations` then has no callers.

16. **Test environment: `config.action_dispatch.show_exceptions = false`**
    - What happens: exceptions are rendered instead of raised, so the authorization tests ("RecordNotFound expected but nothing was raised") stop checking anything.
    - Fix: `:none`. Not valid on 7.0, so it ships with the upgrade.

### Behavior changes that tests caught but code may not

17. **Digest day (Active Job keeps the time zone since 7.1)**
    - What happens: the mailer gets `requested_at` in the reader's zone, so the subject says "October 04" instead of "October 05". The `all_day` window also shifts, while the Redis dedupe key stays UTC.
    - Fix: `requested_at = requested_at.utc` in `DigestMailer#daily_digest`. On 7.0 this changes nothing. It also covers 7.0 payloads that arrive with no zone [exec: such a payload deserialized on 8.1 as a UTC TimeWithZone].

18. **`Note#next_day_reminder_at` (8.1 removed `to_time_preserves_timezone`; `to_time` always keeps the zone)**
    - What happens: the shown postponed time changes from `2026-11-01T09:00:00-04:00` to `2026-11-01T08:00:00-05:00`. It is the same instant, so the stored epoch is unaffected.
    - Fix, to keep the documented behavior: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Works on 7.0.
    - If the product prefers local wall-clock time instead, update the comment and the test. Either way, remove any leftover `to_time_preserves_timezone` setting before 8.2; 8.1 already warns about it.

### Queued jobs, rolling deploy and rollback

19. **DigestJob's BigDecimal argument** [exec]
    - 8.1 always uses `BigDecimalSerializer`, even with `load_defaults 7.0`. A 7.0 worker reading an 8.1 payload raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
    - In that case Sidekiq retries the job, and the reader's Redis reservation blocks a second request that day. The reverse direction works: 7.0 payloads arrive on 8.1 as `"0.5"`, which `BigDecimal(...)` accepts.
    - Fix: pass `reading_completion.to_s` in `User#request_digest`. Ship it first, on 7.0, so payloads are the same in both directions.

20. **Other payloads and storage**
    - NoteReminderJob and CitationEnrichmentJob carry only GlobalIDs, so scheduled reminders created on 7.0 run on 8.1 [exec: the live worker sent one]. ExportJob is a native Sidekiq job and is unaffected.
    - Before rollback, drain or inspect Redis `schedule` and `retry` for DigestJob payloads written by 8.1.
    - No migrations are needed. `schema.rb` gets a `[8.1]` header on the next dump.

### Recommended order
1. Release the changes that work on 7.0 (items 2, 3, 5–11, 13–15, 17–19) and run the suite on 7.0.
2. Bump Rails together with items 1, 4, 12 and 16.
3. Deploy workers and web together, or drain the default queue of DigestJobs first.

## C. Optional default adoption

Every default introduced in 7.1, 7.2, 8.0 and 8.1 is currently **not** set, so the app keeps the old value. Nothing in this section is required for 8.1. Adopt the defaults one release at a time, using `new_framework_defaults_*.rb` files.

### Defaults that break this app if adopted [exec, `def` copy]
- **7.1 `default_column_serializer = nil`**
  - What happens: `serialize :preferences` fails with `ArgumentError: missing keyword: :coder` on every Notebook load.
  - Fix: `serialize :preferences, coder: YAML`. Keep YAML, because the stored data is YAML (`"---\nexport_heading: …"`). Switching to JSON would need a data migration.
- **7.1 `raise_on_assign_to_attr_readonly = true`**
  - What happens: `ActiveRecord::ReadonlyAttributeError: slug` when saving notebook settings, because the form resubmits `slug`.
  - Fix: remove `:slug` from `notebook_params`. Creation is unaffected, since `assign_slug` overwrites it anyway.
- **7.1 `raise_on_invalid_cache_expiration_time = true`**
  - What happens: `Cache expiration time is invalid, cannot be negative: -60.0` in `exports/_export.html.erb` once an export has expired, so the exports page returns 500.
  - Recommended fix: `expires_in: [export.expires_at - Time.current, 1.second].max`. It keeps cache hits and misses as they are.
  - Alternative: `cache_if expires_at.future?`. It changes the documented behavior that a cached link outlives the deadline, and failed the existing test.
- **7.2 `postgresql_adapter_decode_dates = true`**
  - What happens: `Notebook#daily_note_counts` fails with `TypeError: no implicit conversion of Date into String`, because `select_rows` now returns `Date`.
  - Fix: `day.to_date`, which handles both String and Date.

With those four fixes, `load_defaults 8.1` passes 46/0/0 (`def-test3.log`). All four fixes also work on 7.0.

### Remaining defaults

**7.1**
- *No visible change for this app:*
  - `allow_deprecated_parameters_hash_equality=false`: no Parameters/Hash comparisons in the code.
  - Encryption `hash_digest_class` / `support_sha1…`: no encrypted attributes.
  - `run_commit_callbacks_on_first_saved_instances…`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`: there are no `after_commit` callbacks.
  - `sqlite3_adapter_strict_strings`: the app uses PostgreSQL.
  - `allow_deprecated_singular_associations_name=false`: no affected usage found.
  - `use_big_decimal_serializer`: already forced in 8.1 (item 19).
  - `query_log_tags_format`: query log tags are not enabled.
  - `log_file_size`: only affects development and test.
  - `belongs_to_required_validates_foreign_key=false`: saves the extra notebook query.
  - `precompile_filter_parameters`: the app's filter list is plain symbols.
  - `generate_secure_token_on`: no `has_secure_token`.
  - `debug_exception_log_level`: log level only.
  - `commit_transaction_on_non_local_return`: removed in 7.2; see item 13.
- *Sanitizers:* `action_view` / `action_text sanitizer_vendor` switch to HTML5. Output was identical in my sample [exec]. Re-check stored rich text that has malformed HTML [proposed].
- *Testing:* `dom_testing_default_html_version=:html5` affects test parsing only. The suite passed.
- *Rollout risk [src]:*
  - `message_serializer=:json_allow_marshal`, `use_message_serializer_for_metadata`, `marshalling_format_version=7.1`, and cache format 7.1 (cache store unset, so the production file cache) all produce messages, cache entries or Marshal data that 7.0 servers can't read.
  - Stored Action Text attachment `sgid`s and Active Storage signed IDs should still be readable under `json_allow_marshal`. Do not move to `:json` without re-signing.
  - Enable these only after 8.1 is fully deployed and rollback to 7.0 is off the table. Cross-version cookie and sgid reads were not tested [proposed: sign in on 7.0, then read the session and render a note with an attachment on 8.1, and the reverse].

**7.2**
- `enqueue_after_transaction_commit=:default`: at 8.1 the effective value is `false` [exec], so jobs are pushed inside the transaction and a failed enqueue rolls back the pending state. If this is ever enabled, the "rolled back on failed enqueue" guarantees in `Citation#request_enrichment` and `Note#schedule_reminder` stop holding.
- `web_image_content_types` adds webp. Only matters for variants, which the app doesn't use.
- `validate_migration_timestamps`: existing migration timestamps are valid.
- `yjit=true`: enables YJIT on Ruby 3.3. Raises memory use; watch the workers.

**8.0**
- `to_time_preserves_timezone=:zone`: already forced in 8.1 (item 18).
- `strict_freshness=true`: `ExportDownloadsController` would honor only `If-None-Match` when both headers arrive. The ETag is the blob checksum, so the effect is negligible [src].

**8.1** (absent from the change summary; values read from the `def` copy)
- `action_on_path_relative_redirect=:raise`: all redirects use absolute paths or helpers.
- `raise_on_missing_required_finder_order_columns`, `remove_hidden_field_autocomplete`, `escape_json_responses=false`, `escape_js_separators_in_json=false`: no failures with defaults adopted.

## D. Unverified points and open questions
- json 3 is incompatible with Rails 8.1.0. A later 8.1.x patch may fix it; check before dropping the pin.
- The Sidekiq adapter built into Rails is deprecated and will be removed in 8.2. Moving to Sidekiq 7.3.3+ is separate work and has its own breakage:
  - `perform_async(id, {format: …})` hits strict args (the worker already warns about this).
  - With redis 5 or redis-client, `sadd` returns an Integer, so `if 0` breaks digest dedupe (a deprecation warning is already logged).
  - `rescue Redis::BaseError` in `Notebook#request_export` stops matching.
- Puma 5 with rack 2.2 booted fine. Rack 3 and Puma 6 were not tried.
- The browser suite was not run because no system tests exist.
- Development's secret key base moves to `tmp/local_secret.txt`, so local sessions will reset [src].
- `ActiveRecord::Base.connection` (used in `Note.connection` in `daily_note_counts`) is soft-deprecated. It is optional to move to `with_connection`.

---

Following the upgrade skill, this is a plan only and I haven't implemented it. Your repo is unchanged, still on `rails 7.0.8.7` on `main`. The fixes were tested in throwaway copies under `/tmp/exp`, and `/tmp/exp/up-app.patch` holds the required changes. To go ahead, I'd start with step 1: ship the fixes that also work on 7.0 before bumping Rails. Want me to do that?