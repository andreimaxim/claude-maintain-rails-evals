# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but Rails 8.1.0 does not boot against this app as it stands. In a disposable copy it took about 20 code and dependency changes before the test suite passed (46 runs, 0 failures). Several of those changes are silent data or behaviour changes that tests only partly catch. Most of them can be made on 7.0 first; I ran that variant and it also passes (46/0, and the existing `Enumerable#sum` deprecation goes away).

The working repo was not modified (`git status` is clean). The experiments ran in copies under `/tmp/up/` against their own Postgres databases (`mn_upgr_test`, `mn_upgr_test70p`, `mn_upgr_test81d`, `mn_upgr_test81s6`, dropped afterwards) and Redis db 9 (flushed afterwards). Active Storage used each copy's own `tmp/storage`, and the cache was the test `null_store`. System tests were not run because no browser was set up.

Evidence labels: **[E]** = I ran it, **[S]** = from source or changelog only, **[P]** = check still to do.

## Experiment record (all in `/tmp/up/`)
- **Change index:** `summary.txt` (the `gem-changes` output).
- **Baseline on 7.0:** `baseline-test.log`, 46 runs, 0 failures.
- **8.1 with fixes added step by step:** `test-8.1-{a..h}.log`. The last one, `h`, is 46 runs, 0 failures. The copy is `app/`, and its locked gems are in `Gemfile.lock.8.1`: rails 8.1.0, sidekiq 7.3.9, redis-client 0.31, puma 8.0.2, json 2.21.2 (pinned below 3), minitest 5.27, capybara 3.40.
- **8.1 keeping Sidekiq 6.5.12 / redis 4.8.1 (rack resolves to 2.2.24):** copy `app81s6/`, lock `Gemfile.lock.8.1-sidekiq6`, log `test-8.1-sidekiq6.log`, 46/0.
- **8.1 with `load_defaults 8.1`:** copy `app81d/`, logs `test-8.1-defaults81.log` and `test-8.1-defaults81b.log`.
- **Changes on 7.0 first:** patch `prep.patch`, copy `app70prep/`, log `test-7.0-prep.log`, 46/0.
- **Production boot and eager load on 8.1:** `prod-boot.log` is OK, and `assets:precompile` exits 0 (`precompile.log`).
- **Job argument compatibility between versions:** `args81.json`, `args70.json`.
- **Export request while Redis is down:** `redis-down-export.log`.

## A. Required changes (boot failures or wrong behaviour at 8.1)

| # | Affected code | What happens on 8.1 if nothing is done | Fix | Works on 7.0? |
|---|---|---|---|---|
| 1 | Gemfile `puma ~> 5.0` | Won't boot: "Puma 5 is not compatible with Rack 3" [E] | Puma ≥ 6. Or keep Rack 2 by staying on Sidekiq 6.5, where Puma 5 may still work [P] | Puma 6 on 7.0 [P] |
| 2 | `json` resolved to 3.1.0 | Every JSON-coded column load raises `ArgumentError (given 2, expected 1)` because `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)` [E] | Pin `json < 3` (or use a later 8.1.x if it fixes this [P]) | yes |
| 3 | `config/initializers/action_text.rb` `allowed_tags += …` | Won't boot: `nil + Array`. From 7.1, `allowed_tags` is nil until Action Text sets it after initialization [E] | In `after_initialize`, set it to `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. Without the attachment tags, embedded images disappear [E] | yes [E] |
| 4 | `Note`: `enum status: {...}, _prefix: true` | Won't boot [E] | `enum :status, {...}, prefix: true` | yes [E] |
| 5 | `Note`: `serialize :tags, JSON` | Won't boot [E] | `serialize :tags, coder: JSON` | **No.** 7.0 doesn't accept `coder:`; do this in the same deploy as the version bump [S] |
| 6 | `Note`: `alias_attribute :highlight_color, :color` (a store accessor, not an attribute) | Raises at load [E] | `alias_method` for both reader and writer | yes [E] |
| 7 | `config/routes.rb`: `get "/notes", "/journal", to:` | `notes_path` is no longer defined, so redirects and links break [E] | Two routes: `get "/notes", …, as: :notes` and `get "/journal", …` | yes [E] |
| 8 | `Citation::Provider` and its test use `Rails.application.secrets` | Removed in 7.2 [S]. Only a few lines read it | `config.x.citation_provider = config_for(:secrets)[:citation_provider]` (or move it to credentials) | yes [E] |
| 9 | `Export#generate`: `fragments.sum` | `TypeError`, so every export fails in the worker [E]. Already a deprecation warning on 7.0 | `fragments.join` | yes [E] |
| 10 | `Import#apply`: `return false` inside `transaction` | **Silent data integrity bug:** a failing row now *commits* the import and the earlier rows. Record counts went from `[0,3,0,1]` to `[1,4,1,2]` [E] | `raise ActiveRecord::Rollback unless rows.all?(&:save)`, with the block returning true and `|| false` after it | yes [E] |
| 11 | `Import#receipt`: `citation[:id]` (the primary key is `doi`) | The receipt CSV's DOI column comes out blank, with no error [E] | `citation&.doi` | yes [E] |
| 12 | `imports/preview.html.erb`: `annotations.stringify_keys` then `[row.line]` | `HashWithIndifferentAccess#stringify_keys` now turns integer keys into strings (7.0 gives `[2]`, 8.1 gives `["2"]`), so annotations silently stop showing [E] | Drop `stringify_keys` | yes [E] |
| 13 | `notes/index.html.erb`: `form_with(model: nil, …)` | `ArgumentError`, so the main notes list returns 500 [E] | `model: false` | yes [E] |
| 14 | `NotesController#index`: `where(notebooks: @notebook)` | `PG::UndefinedColumn notes.notebooks` [E] | `where(notebook: @notebook)` | yes [E] |
| 15 | `Note#schedule_reminder`: `set(wait_until: <Integer>)` | `NoMethodError utc`, so reminders cannot be scheduled [E] | `wait_until: Time.at(reminder_epoch)` | yes [E] |
| 16 | `Note#next_day_reminder_at`: `reminder_at.to_time + 86_400` | Across a DST change it shows `08:00-05:00` instead of the documented `09:00-04:00`. 8.1 ignores the `load_defaults 7.0` setting here (the effective value is nil) and logs a deprecation [E] | `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)` | yes [E] |
| 17 | `CitationEnrichmentJob`: `wait: :exponentially_longer` | `RuntimeError` when the job is scheduled for a retry [E] | `:polynomially_longer` (same formula) [S] | **No** (7.1+), so do it with the bump |
| 18 | `DigestMailer` uses `requested_at.to_date` / `.all_day` | Since 7.1, `TimeWithZone` job arguments come back in the reader's time zone, not UTC. The digest then picks the wrong UTC day and the wrong set of notes (test: Oct 05 became Oct 04) [E] | Use `requested_at.utc.to_date` and `requested_at.utc.all_day` | yes [E] |
| 19 | `config/environments/test.rb`: `show_exceptions = false` | `RecordNotFound` becomes a rendered 404, so the 404 authorization assertions fail [E] | `:none` | **No** (on 7.0, `:none` is truthy), so do it with the bump |
| 20 | `test/.../citation_enrichments_controller_test.rb`: `Puma::Events.strings` | Fails on Puma 6+ [E] | `Puma::Server.new(app, nil, log_writer: Puma::LogWriter.null)` | needs Puma 6 |

## B. Dependency choice: Sidekiq
Rails 8.1.0 still ships its own Sidekiq adapter (`gem "sidekiq", ">= 4.1.0"`), so **upgrading Sidekiq is not required**. The 8.1 + Sidekiq 6.5.12 + redis 4.8.1 variant passes 46/0 [E].

If you do move to Sidekiq 7 (6.5 is old and keeps you on Rack 2), these further changes are required:
- **Export arguments:** `Notebook#request_export` passes `{ format: "markdown" }`, which `strict_args` rejects. Use string keys; this works on 6.5 as well [E].
- **Digest de-duplication:** `User#request_digest` relies on `redis.sadd` returning true or false. Under redis-client it returns `0`, which Ruby treats as true, so a reader can request a digest every time [E]. Use `redis.call("SADD", key, id) == 1`, which works on both versions [E].
- **Orphaned exports:** `rescue Redis::BaseError` misses `RedisClient::CannotConnectError`, so an export row is left stuck at queued [E, see `redis-down-export.log`]. Rescue both classes.
- **Test stub:** the test stub that raises `Redis::CannotConnectError` also needs updating.

Sidekiq 7.3's adapter keeps the `JobWrapper` class name [S], so reminders already scheduled in Redis still resolve.

## C. New defaults, release by release (the app currently keeps every old value through `load_defaults 7.0`)
**7.1** (I adopted all of these via `load_defaults 8.1` in `app81d/`):
- **Breaks the app if adopted [E]:**
  - `default_column_serializer=nil`: `serialize :preferences` won't boot. Add `coder: YAML` first; the stored data is YAML.
  - `raise_on_assign_to_attr_readonly`: the notebook settings form resubmits `slug`, and `NotebooksController` permits it, so the update raises `ReadonlyAttributeError`. Stop permitting `slug`.
  - `raise_on_invalid_cache_expiration_time`: `exports/_export.html.erb` passes a negative `expires_in` for expired exports and raises. Today this is only reported. Clamp it or skip caching when the value is ≤ 0.
- **No visible effect in tests, review anyway [S]:**
  - `run_after_transaction_callbacks_in_order_defined` and `before_committed_on_all_records`: the app has no `after_commit` callbacks.
  - `commit_transaction_on_non_local_return`: already forced on in 8.1. See A10.
  - `belongs_to_required_validates_foreign_key`: an existence query is skipped. `Note belongs_to :citation` is optional with `validate: true`, so no change.
  - `generate_secure_token_on`: not used.
  - `allow_deprecated_parameters_hash_equality` and `allow_deprecated_singular_associations_name`: no use found.
  - `sanitizer_vendor` HTML5 for Action View and Action Text: the rich-text sanitizing test still passed [E]. Existing stored bodies may be cleaned differently on render [P].
  - `dom_testing_default_html_version :html5`: tests passed [E].
  - `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: these affect cookies and signed or encrypted messages, so it is a **rolling-deploy risk**. Adopt only after every node runs 8.1.
  - `marshalling_format_version 7.1`: the cache must not be shared with 7.0 nodes.
  - `query_log_tags_format`, `log_file_size`, `debug_exception_log_level`, `precompile_filter_parameters`: cosmetic or performance only.
  - `encryption.*`: no Active Record encryption in use.
  - `sqlite3_*`: not applicable (PostgreSQL).
- **Job argument format:** `use_big_decimal_serializer` no longer exists in 8.1 [S], so 8.1 always writes BigDecimal job arguments in the new format. A 7.0 worker raises `DeserializationError: BigDecimalSerializer is not known` on the `DigestJob` completion argument [E]. See D.

**7.2:**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` raises in `Date.iso8601(Date)` [E]. Accept either a `Date` or a String.
- `enqueue_after_transaction_commit`: currently false [E]. Leave it off, or opt out per job. `Citation#request_enrichment` and `Note#schedule_reminder` rely on a failed enqueue rolling back the row lock. Deferring the enqueue would leave `pending` or a stale `reminder_job_id` behind [S].
- `validate_migration_timestamps`: check `db/migrate` names [P].
- `web_image_content_types` adds webp: no variant processor is installed, so the effect is small [S].
- `yjit`: watch memory.

**8.0:**
- `to_time_preserves_timezone :zone`: already effective in 8.1; covered by A16.
- `strict_freshness`: `ExportDownloadsController#stale?` sends both an etag and `last_modified`. When `If-None-Match` is present, only that is checked. This is harmless because the checksum etag is stronger [S].

**8.1:** the tool listed no new defaults for 8.1 [S, from `summary.txt`]. Read the 8.1 upgrade guide directly to confirm [P].

## D. Rollout and rollback risks (stored data and queued work)
- **Workers and web nodes at different versions:** jobs created by 8.1 carry the BigDecimal and the new `TimeWithZone` format. A 7.0 worker fails on `DigestJob` [E]. The digest reservation is already in Redis, so the reader can't re-request until the 2-day expiry. **Deploy Sidekiq workers together with or before web nodes, and drain or upgrade workers before rolling back.**
- **Jobs written by 7.0, read by 8.1:** these deserialize correctly; the time zone falls back to UTC [E].
- **Stored data:** `notes.tags` stays JSON and `notebooks.preferences` stays YAML; neither changes format. Keep the message, cookie and cache serializer defaults on the old values until rollback is no longer an option.
- **Import data:** imports applied before A10 is fixed may already contain partial commits if a 7.1+ build was ever run. That doesn't apply here, because production is on 7.0.
- **Version steps:** go 7.0 → 7.1 → 7.2 → 8.0 → 8.1, running tests and checking deprecations at each step. `disallowed_deprecation = :raise` is configured, but the list of disallowed warnings is empty.

## E. Suggested order
1. Land the changes that work on 7.0 (`/tmp/up/prep.patch`): A3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18. Optionally add the Sidekiq-related fixes from B, and `serialize :preferences, coder: YAML` together with not permitting `slug`. All of these work on 7.0, though only the `prep.patch` set was tested there (46/0).
2. Do the version bump in one change with A1, 2, 5, 17, 19, 20.
3. Adopt the new defaults later, one release at a time, after the fixes in C. Adopt the serializer-related defaults last.

## Still unverified or open
- System tests were not run.
- Puma 5 with Rack 2 on 8.1 was not tried.
- I didn't check whether a later 8.1.x removes the need for the `json < 3` pin.
- Stored Action Text bodies were not re-rendered under the HTML5 sanitizer.
- Migration timestamp validation was not checked.
- I didn't do a full pass over 7.1/7.2/8.0 deprecation logs at each intermediate version; I jumped straight to 8.1.
- Production Redis and Sidekiq queue contents during deploy weren't tested, nor were `capybara` and `selenium` against Puma 8.

---

**Notes:**
- This is a plan only. The upgrade skill doesn't make changes, so your repo is untouched and still on Rails 7.0.8.7.
- The most dangerous problems are the silent ones: A10 (a failed import now commits partial data), A11 and A12 (blank DOI column and missing annotations, with no error), A18 (digests pick the wrong day) and the digest de-duplication bug in B.
- I'd start by applying `/tmp/up/prep.patch` as a separate change on 7.0. Tell me if you want me to do that or go ahead with the full version bump.