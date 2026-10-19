Here is the planner's plan, verbatim. I haven't implemented anything or changed the app. The planner said it couldn't launch `maintain-rails:gem-upgrade-planner`, so it did the planning itself. I haven't re-run any of its experiments, and every "executed" result below is the planner's own report.

# Plan: rails 7.0.8.7 to 8.1.0

The app runs Ruby 3.3.6, Postgres, Sidekiq 6.5.12, Sprockets and importmap, Action Text and Active Storage.

## Experiment record
- **Disposable copies:** all are under `/tmp/exp`.
  - `base`: unmodified 7.0.8.7.
  - `prep70`: base plus the preparatory changes.
  - `hop71`: prep70 on Rails 7.1.6.
  - `v81`: Rails 8.1.0 plus fixes.
- **Isolation:**
  - Each experiment used its own Postgres server (`initdb` at `/tmp/exp/pgdata`, socket `/tmp/exp`, port 55432), its own Redis (port 56379), and per-copy `storage/` and `tmp/`.
  - The environment is set in `/tmp/exp/env.sh`: `PGHOST`, `PGPORT`, `PGUSER`, `REDIS_URL`.
  - `v81` used `GEM_HOME=/tmp/exp/gems81`, and `hop71` used `/tmp/exp/gems71`.
  - `mise.toml` was removed in the copies only.
- **Slip to disclose:** one `psql` SELECT ran without the isolated environment and hit the machine's default Postgres. It was read-only and wrote nothing.
- **Baseline:** 7.0.8.7 passes `bin/rails test` with 46 runs and 0 failures (`/tmp/exp/base_test.log`).
- **Evidence:** logs are in `/tmp/exp/evidence/`. Probe scripts are in `/tmp/exp/scripts/`. The full diff of the fixes is `/tmp/exp/evidence/v81_changes.diff`.
- **Resolved 8.1.0 lock changes:**
  - Unchanged: rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, turbo-rails 2.0.12, sprockets-rails 3.5.2.
  - New: action_text-trix 2.1.19, bigdecimal 4.1.3, drb, rack-session, rackup, securerandom, uri, useragent, webrick, json.
- **Not verified:** system tests and any real browser (no Chrome here), the 7.2 and 8.0 intermediate hops, production deployment, and Sidekiq 7.

## Required changes
Each was proven by running a failing 8.1.0 test or probe, then a fix. Tests catch every item except rows 13 to 16, which are silent. The last column says whether the fix also works on 7.0.8.7.

| # | Affected code | Failure on 8.1.0 | Fix | Works on 7.0.8.7? |
|---|---|---|---|---|
| 1 | `Gemfile` | `activesupport 8.1.0` requires an unbounded `json`, which resolved to json 3.1.0. `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)`, which json 3.x rejects. Every `serialize ... JSON` read and every session read then raises ArgumentError. 8.1.1 has the same code. 8.1.4 uses `**options`. | Add `gem "json", "< 3"` (resolved 2.21.2), or request 8.1.4+. | Yes |
| 2 | `config/initializers/action_text.rb` | `ActionText::ContentHelper.allowed_tags` is nil by default in 8.1, so `+=` raises NoMethodError at boot. | Set the full list explicitly: `sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. Do not assign only `%w[details summary]`, which would strip every other tag. | Yes |
| 3 | `app/models/note.rb:10`, `:12`, `:14` | Keyword `enum status:, _prefix:` and positional `serialize :tags, JSON` are both removed. `alias_attribute :highlight_color, :color` raises because `color` is a store accessor, not an attribute. | Use `enum :status, {...}, prefix: true`, `serialize :tags, coder: JSON`, and `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. | `enum` and `alias_method`: yes. `coder:` is 7.1+ only, because 7.0 takes the keyword as the coder. |
| 4 | `config/routes.rb:18` | `get "/notes", "/journal", to:` with two paths raises. | Use two `get` lines. `rails routes` in dev matches 7.0, except Rails' own conductor routes. | Yes |
| 5 | `app/views/notes/index.html.erb:12` | `form_with(model: nil, ...)` raises ArgumentError, so the main page returns 500. | Drop `model: nil`. | Yes |
| 6 | `app/models/export.rb:42` | `fragments.sum` over Strings raises TypeError, because the Rails 7.0 `Enumerable#sum` shim is gone. | Use `fragments.join`. | Yes (this also removes a 7.0 deprecation). |
| 7 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, test `with_provider` | `Rails.application.secrets` was removed in 7.2. | Move to `config/citation_provider.yml` read with `config_for`, store it in `config.x.citation_provider`, and update the test. Production env-var behavior is unchanged: a prod boot gave nil values when unset. | `config_for` and `config.x` work on 7.0. `secrets` is deprecated on 7.1. |
| 8 | `app/jobs/citation_enrichment_job.rb` | `wait: :exponentially_longer` was removed and raises at retry time. | Use `:polynomially_longer`. The formula (`executions**4 + 2`) and the default jitter (0) are the same. | No, 7.1+ only. |
| 9 | `config/environments/test.rb` | `show_exceptions = false` is now treated as `:all`, so every `assert_raises` and RecordNotFound test fails. | Use `:none`. | No, 7.1+ only. On 7.0, `:none` is truthy and would show exceptions. |
| 10 | `app/models/note.rb:61` | `wait_until: reminder_epoch` (an Integer) raises NoMethodError on `utc`. Reminder scheduling breaks. | Use `wait_until: Time.at(reminder_epoch)`. | Yes |
| 11 | `app/controllers/notes_controller.rb:12` | `where(notebooks: @notebook)` used to produce `notes.notebook_id = ?`. 8.1 produces `notes.notebooks = ?`, which is a Postgres UndefinedColumn error on the notebook filter. SQL is captured in `/tmp/exp/probe1_70.log` and `/tmp/exp/probe1_81.log`. | Use `where(notebook: @notebook)`. | Yes |
| 12 | `app/views/imports/preview.html.erb` | `HashWithIndifferentAccess#stringify_keys` now converts integer keys to strings, so `annotations[row.line]` misses and annotations vanish. | Remove `.stringify_keys`. | Yes |
| 13 | `app/models/import.rb` `receipt` | **Silent data loss.** `citation[:id]` gave the DOI on 7.0 and gives nil on 8.1, so the receipt CSV loses DOIs. | Use `citation&.doi`. | Yes |
| 14 | `app/models/import.rb` `apply` | **Silent behavior inversion.** `return false` inside `transaction do` rolled back on 7.0 but commits on 8.1 (source: 7.0 and 8.1 `within_new_transaction`). A rejected import therefore saves the import record and the first note. | `applied = false; transaction { save!; applied = rows.all?(&:save); raise ActiveRecord::Rollback unless applied }; applied`. A naive `return true` fix would roll back on 7.0. | Yes |
| 15 | `app/mailers/digest_mailer.rb` | **Silent.** The 8.1 job payload carries `time_zone`, so `requested_at` deserializes in the reader's zone. The digest then covers the reader's local day, not the documented UTC day (subject became "October 04" instead of "05"). | Add `requested_at = requested_at.utc` in the mailer. | Yes |
| 16 | `app/models/note.rb` `next_day_reminder_at` | **Silent.** `to_time + 86_400` no longer keeps the reminder's UTC offset across DST. The stored epoch is the same instant, but the displayed time changes from `09:00-04:00` to `08:00-05:00`. | Either keep the documented behavior with `Time.at(reminder_epoch + 86_400).localtime(reminder_at.utc_offset)`, or accept the new display and change the test and copy. This is a product decision. | Yes |

### Results
- `prep70` is 7.0.8.7 with the 7.0-compatible fixes: rows 2, 3 (except `coder:`), 4 to 6, 10 to 16, plus the digest `to_s("F")` change. It ran 46 tests with 0 failures.
- `hop71` is 7.1.6 with every fix. It ran 46 tests with 0 failures and zero deprecation warnings (`/tmp/exp/evidence/hop71b_test_run.log`).
- `v81` is 8.1.0. It ran 46 tests, 340 assertions, 0 failures (`/tmp/exp/evidence/v81_final_test_run.log`).
- `bin/rails zeitwerk:check` passes.
- A production-mode boot with `SECRET_KEY_BASE_DUMMY=1` passes.
- The 7.1.6 run with only the 7.0-compatible fixes (`hop71a_test_run.log`) is what shows that rows 7 to 9 and `serialize` are 7.1-gated.

## Mixed-version, queue and rollback findings
These were executed against Sidekiq and Redis.

- **Digest job, rollback break.**
  - **Payload change:** a `BigDecimal` argument is a plain string (`"0.3333"`) on 7.0. On 8.1 it is `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",...}`.
  - **7.0 worker result:** a 7.0 worker given the 8.1 payload fails with `DeserializationError: Serializer ...BigDecimalSerializer is not known`. The job then retries in Sidekiq's retry set.
  - **8.1 worker result:** the 8.1 worker processed 7.0-queued jobs fine.
  - **Fix:** pass `reading_completion.to_s("F")` in `User#request_digest`. The wire format is then identical to 7.0's, and a 7.0 worker processed the resulting 8.1 payload.
  - **Where it applies:** this also covers a mixed fleet (8.1 web, 7.0 workers). Ship it on 7.0 first.
- **Other job payloads.**
  - Citation enrichment, reminder and native `ExportJob` payloads are cross-readable in both directions.
  - 8.1 adds `scheduled_at` and a `time_zone` key, and 7.0 ignores both.
  - `time_zone` is why row 15 matters. A 7.0 payload deserializes as UTC, and an 8.1 payload deserializes in the reader's zone.
  - **Open item:** a 7.0-scheduled reminder in Sidekiq's scheduled set was not run by the 8.1 worker. I did not move it to the queue after `Sidekiq::ScheduledSet` failed to load without `require "sidekiq/api"`. Re-check it. The 8.1-scheduled reminder did run on the 7.0 worker.
- **Stored data.** Both versions wrote the same raw columns: `notes.tags` as `["a","b"]`, `settings` as `{"color":"green"}`, and `notebooks.preferences` as the same YAML. Each version reads the other's rows.
- **Rich text.** A stored attachment (sgid) and a `<details>` block rendered byte-identically on 7.0 and 8.1 with the same secret. The allowed-tags list had the same SHA.
- **Sessions.**
  - Cookies from the 7.0 server worked on the 8.1 server and the reverse, with the same secret.
  - In dev only, Rails 7.1+ reads `tmp/local_secret.txt` instead of `tmp/development_secret.txt`. This signs out dev sessions and breaks old dev sgids.
  - Production uses credentials and is unaffected. `secrets.yml` held no `secret_key_base`.
- **Schema.**
  - `db:schema:dump` under 8.1 rewrites `db/schema.rb` to `Schema[8.1]`, `enable_extension "pg_catalog.plpgsql"` and alphabetically sorted columns.
  - I did not test whether 7.0 can load that file, but it would likely fail. Do not commit a regenerated schema until the rollback window closes.
  - There are no pending migrations.
- **Boot and server.** Puma 5.6.9 on Rack 2.2.24 serves Rails 8.1.0 (`/tmp/exp/evidence/server_81.log`). Sidekiq 6.5.12 runs on 8.1.0.

## Optional defaults
These are not required. Keep `load_defaults 7.0` for now. Two hazards were confirmed by flipping a single flag and running tests.

- **`postgresql_adapter_decode_dates = true` (7.2 defaults):** `Notebook#daily_note_counts` fails with `TypeError: no implicit conversion of Date into String` (`Date.iso8601` gets a Date).
- **`raise_on_assign_to_attr_readonly = true` (7.1 defaults):** `ActiveRecord::ReadonlyAttributeError: slug`, because `notebooks_controller` permits `:slug` and `Notebook` has `attr_readonly :slug`.

These hazards come from source reading only:
- **7.1 defaults, `message_serializer :json_allow_marshal`:** it changes sgids and signed messages, which would be a rollback hazard.
- **7.1 defaults, HTML5 sanitizer:** `action_text.sanitizer_vendor` switches the Action Text sanitizer to the HTML5 vendor.
- **7.1 defaults, `default_column_serializer = nil`:** `serialize :preferences` has no coder, so this setting matters for it.
- **Transaction-commit enqueue:** in 8.1.0, `enqueue_after_transaction_commit` defaults to false and no `load_defaults` block sets it. Opting in per job class would break the `with_lock` plus `perform_later` rollback semantics in `Citation#request_enrichment` and `Note#schedule_reminder`.
- **`concurrent-ruby 1.3.4` pin:** it can go after the upgrade, but I did not test unpinning.

## Follow-ups (not blocking 8.1.0)
- **Sidekiq adapter:** the built-in `sidekiq` Active Job adapter is deprecated in 8.1 and removed in 8.2. Upgrading Sidekiq to 7.3.3+ is its own project. These hazards come from source reading:
  - **Strict args:** `ExportJob` is called with symbol-key args `{format: "markdown"}`, which Sidekiq 7 strict args would reject. Sidekiq 6.5 already warns about this.
  - **Redis errors:** `Notebook#request_export` rescues `Redis::BaseError`, which Sidekiq 7 no longer raises.
  - **Redis client:** Sidekiq 7 uses redis-client instead of `redis`.
- **Action Text JS:**
  - **Current setup:** the layout loads a vendored Trix 1.3.5 (`vendor/javascript/trix-1.3.5.js`) and the importmap pins `@rails/actiontext` to `actiontext.js`.
  - **8.1 file:** 8.1 ships `actiontext.js` as UMD and `actiontext.esm.js`, and bundles Trix 2 through `action_text-trix`.
  - **Stub check:** a Node stub import of both files registered `trix-attachment-add`. That does not prove browser behavior.
  - **Needs a browser check:** decide whether to repin to `actiontext.esm.js` and stay on Trix 1.3.5, or move to Trix 2 with its CSS. Run `bin/rails test:system`, or a manual editor and upload smoke test, on a machine with Chrome.
- **Rack 3 and Puma 6:** not required and not tested.
- **Image variants:** Sidekiq logs a warning at boot about image variants without `image_processing`. Setting `config.active_storage.variant_processor = :disabled` would silence it.
- **Doc updates:** `ARCHITECTURE.md:79-80` and `CONTRIBUTING.md:38` still describe `config/secrets.yml` and `Rails.application.secrets`. `TESTING.md` should keep its Minitest 5 pin note.

## Recommended sequence
1. **On 7.0.8.7, ship the 7.0-compatible set.**
   - That is rows 2, 3 (`enum` and `alias_method`), 4 to 6 and 10 to 16, the `config_for` and `config.x` part of row 7, and the digest `to_s("F")` change.
   - Validate with `bin/rails test`, a rejected-import check that nothing is saved, a notebook-filter request, and a digest and reminder job run on a real worker.
2. **Go to 7.1.x.** Apply the 7.1-only items: row 3 `coder:`, row 8, row 9. Require zero deprecation warnings and a green suite. I tested 7.1.6.
3. **Go to 8.1.0.**
   - Add the json pin and bump Rails.
   - Before deploying, confirm no 8.1-enqueued job fails on 7.0 workers, and drain or inspect the Sidekiq retry and scheduled sets.
   - Deploy workers first, then web.
4. **Rollback.** Rolling back is safe only if the digest string change is already in place. Otherwise a `DigestJob` queued by 8.1 fails on 7.0 and must be cleared from the retry set.
5. **Intermediate hops.** Stepping through 7.2 and 8.0 is optional and not verified. The direct 8.1 run passed with the fixes above.

## Commentary
- **Experiments run:** all the experiments above ran in `/tmp/exp`. They covered unit and request tests, probes, and Sidekiq and Redis queue checks.
- **Not run:** no browser or system tests, no production deployment, and no 7.2 or 8.0 hops.
- **Product decision pending:** row 16, the DST display of next-day reminders.
- **Re-check before rollout:** the 7.0-scheduled reminder that the 8.1 worker did not run.

I can implement this if you want. Row 16 needs your decision first, on whether to keep the reminder's original UTC offset or accept the new DST display.
