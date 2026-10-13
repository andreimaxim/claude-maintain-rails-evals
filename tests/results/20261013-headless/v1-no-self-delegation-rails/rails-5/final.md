I didn't change the Rails version. The upgrade skill only produces a plan, so I passed the request to the planner, which tested it in throwaway copies. Your repository is unchanged, and its full plan follows.

# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

## Summary

The upgrade is doable without changing Sidekiq, Redis, Puma or Ruby. Bundler resolves Rails 8.1.0 while keeping sidekiq 6.5.12, redis 4.8.1, puma 5.6.9 and rack 2.2.24.

It needs about 16 code or config changes. Ten of them can ship first on 7.0, and I tested that set on 7.0 (all 46 tests pass, no deprecation warnings). The rest have to ship in the same deploy as the new Rails.

Two changes alter what users see and the current tests catch them, so someone has to decide what the app should do:
- **Digest day**: the daily digest would cover the reader's local day instead of the UTC day.
- **"24 hours later" reminder**: the preview would show local time instead of keeping the original UTC offset.

One queued-job format change makes rollback unsafe for digest jobs unless a small fix ships first (section B, item 13).

I changed nothing in `/home/user/workspace/repo`. Its git status is still clean.

## How I tested

- **Copies:** `/tmp/upg/base` is a clone on 7.0.8.7 (branch `prep` holds the subset that works on 7.0). `/tmp/upg/app` is a clone on 8.1.0. Branch `main` there has one commit per fix and keeps `load_defaults 7.0`. Branch `defaults81` adds `load_defaults 8.1`.
- **Gems:** `BUNDLE_PATH=/tmp/upg/bundle`, `BUNDLE_APP_CONFIG=/tmp/upg/app/.bundle`. The only Gemfile edits were `gem "rails", "8.1.0"` and later `gem "json", "< 3"`, followed by `bundle lock --update rails` (log: `/tmp/upg/lock1.log`, `/tmp/upg/install*.log`).
- **Services:**
  - Separate PostgreSQL databases: `mn_upg_base_test`, `mn_upg_81_test`, `mn_upg_cross`, `mn_upg_81_dev`, chosen through `DATABASE_URL`.
  - A private Redis on port 6390 via `REDIS_URL`, with no persistence (`/tmp/upg/env.sh`).
  - Active Storage files and mail stayed inside the copy's `storage/` and `tmp/`.
  - I stopped that Redis and dropped those databases afterwards.
- **Command:** `CI=1 bin/rails test -b` with `RAILS_ENV=test`. `CI=1` turns on eager loading, which matches production.

## A. Required changes that also work on 7.0 (ship these first)

Each of these was applied on 7.0 in `/tmp/upg/base` branch `prep`: 46 runs, 0 failures, no deprecations (`/tmp/upg/base-prep-test2.log`).

1. **`config/initializers/action_text.rb`**
   - Problem: `ActionText::ContentHelper.allowed_tags += %w[details summary]` crashes at boot on 8.1 (`NoMethodError: undefined method '+' for nil`). In 8.1 `allowed_tags` starts out empty.
   - Fix: inside `config.after_initialize`, assign the full list explicitly: `sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - Check: the existing "collapsible excerpts" test passes under both default sets.
2. **`app/models/note.rb:10`, the `status` enum**
   - Problem: `enum status: {...}, _prefix: true` raises `ArgumentError` when the class loads. In production (eager loading) that means the app will not boot.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`.
3. **`app/models/note.rb:14`, `alias_attribute :highlight_color, :color`**
   - Problem: `color` is a `store_accessor` key, not a real attribute, and 8.1 raises an error for that.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
4. **`config/routes.rb`, `get "/notes", "/journal", ...`**
   - Problem: 8.1 no longer accepts several paths in one route and fails at boot.
   - Fix: split it into `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. I confirmed both route names are unchanged (`/tmp/upg/base-routes.txt`).
5. **`Rails.application.secrets` has been removed** (`app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117-122`)
   - Fix: move the settings to `config/citation_provider.yml` and load them with `config.x.citation_provider = config_for(:citation_provider)`. The provider then reads `Rails.configuration.x.citation_provider.to_h`.
   - Deploy check: the production `CITATION_PROVIDER_*` environment variables are still read through ERB. Confirm on staging that `Citation::Provider.new` gets a non-empty URL.
6. **`app/models/export.rb:42`, `fragments.sum`**
   - Problem: on 8.1 this raises `TypeError` (plain Ruby `sum` cannot add strings). Every export job would fail, and Sidekiq would keep retrying it.
   - Fix: `fragments.join`.
7. **`app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)`**
   - Problem: 8.1 raises an error, so the notes list returns a 500.
   - Fix: `model: false`.
8. **`app/views/imports/preview.html.erb`, `@import.annotations.stringify_keys`**
   - Problem: on 8.1, `stringify_keys` turns the Integer line numbers into strings, so `annotations[row.line]` finds nothing and the annotations silently disappear from the preview.
   - Fix: drop `.stringify_keys`, or use `row.annotation`.
9. **`app/models/import.rb`, `apply`: `return false` inside `transaction`** (data integrity)
   - Problem: on 7.0 that `return` rolls the transaction back. On 7.1 and later it commits, so an import with invalid rows would partly save. The executed test showed record counts `[1,4,1,2]` instead of `[0,3,0,1]`.
   - Fix: `raise ActiveRecord::Rollback` unless every row saves, then return the result.
10. **`app/models/import.rb`, `receipt`: `citation[:id]`**
    - Problem: on 8.1 this returns nil (the citations table's primary key is `doi`), so the receipt CSV has an empty DOI column.
    - Fix: `citation&.doi`.
11. **`app/controllers/notes_controller.rb`, `where(notebooks: @notebook)`**
    - Problem: on 8.1 this raises `PG::UndefinedColumn notes.notebooks`.
    - Fix: `where(notebook: @notebook)`.
12. **`app/models/note.rb:61`, `set(wait_until: reminder_epoch)` with an Integer**
    - Problem: on 8.1 enqueueing fails with `NoMethodError: undefined method 'utc' for Integer`.
    - Fix: `wait_until: Time.at(reminder_epoch)`.
13. **Mixed-version and rollback fix for `DigestJob`** (`app/models/user.rb:41`)
    - Problem: 8.1 stores the BigDecimal completion argument in a new format that 7.0 cannot read. In the cross-version experiment, a 7.0 worker failed on an 8.1 payload with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`/tmp/upg/payload81.json`). An old worker during rollout, or a rollback, would retry and eventually kill those jobs.
    - Fix: enqueue `reading_completion.to_s`. The mailer already calls `BigDecimal(params[:completion])`, so this works on both versions. This one is source-based; I did not run it on 7.0.

## B. Required changes that must ship with 8.1 (they do not work on 7.0)

14. **`serialize`** (`note.rb:12`, `notebook.rb:7`)
    - Problem: `serialize :tags, JSON` fails at load time on 8.1.
    - Fix: `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
    - Executed check: on 7.0, `coder: JSON` is silently ignored and the column falls back to YAML (`/tmp/upg/base-prep-test.log`: `tags` came back as a String). Shipping this early would write YAML into `notes.tags`, so it must only go out with 8.1. The stored formats are unchanged, so existing rows still read correctly.
15. **`app/jobs/citation_enrichment_job.rb`, `wait: :exponentially_longer`**
    - Problem: on 8.1 this raises "Couldn't determine a delay", but only when a retry actually happens. No current test reaches that path.
    - Fix: `:polynomially_longer`, which does not exist in 7.0.
    - Check to add: a job test that raises `Unavailable` twice and asserts the job is re-enqueued.
16. **`config/environments/test.rb`, `show_exceptions = false`**
    - Problem: on 8.1, `false` no longer re-raises errors, so 7 tests expecting `RecordNotFound` failed.
    - Fix: use `:none`. On 7.0, `:none` would wrongly turn exception pages on, so this must ship with 8.1.
17. **Gemfile: `json`**
    - Problem: activesupport 8.1.0 does not cap its `json` dependency, so the lock pulled json 3.1.0. That version rejects `JSON.parse(json, options)`, and every cookie read raised `ArgumentError`.
    - Fix: add `gem "json", "< 3"`, which resolved to 2.21.2. Alternatively, check whether a later 8.1.x patch fixes this; I did not check.
18. **Gemfile: `concurrent-ruby` and `minitest` pins**
    - Optional: the `concurrent-ruby` 1.3.4 pin can be relaxed.
    - Keep `minitest ~> 5.25`; 5.27.0 resolved and works.
    - Ruby 3.3.6 shows warnings that `csv`, `bigdecimal` and `mutex_m` leave the default gems in Ruby 3.4. Adding `gem "csv"` is a good idea before any Ruby upgrade.

## C. Behaviour changes the team needs to decide on

19. **Digest day**
    - Change: on 8.1, Active Job keeps the time zone of a time argument. `DigestMailer` would now use the reader's local day (dates and `all_day`), while the per-day request limit stays on the UTC day. The test shows "October 04" where "October 05" was expected.
    - To keep today's behaviour: enqueue `requested_at.utc`. This works on both versions and keeps old and new workers consistent: 7.0 ignores the new `time_zone` key, and 8.1 falls back to `Time.zone` for old payloads.
    - To adopt local days instead: update the comments in `DigestMailer` and `DigestJob` and the test, and decide whether the per-day limit key should follow.
20. **`Note#next_day_reminder_at`** (`reminder_at.to_time + 86_400`)
    - Change: in 8.1, `TimeWithZone#to_time` always keeps the full zone. The preview now renders `2026-11-01T08:00:00-05:00` instead of `09:00-04:00`. The stored time (epoch) is unchanged.
    - To keep the current behaviour: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`, which produced `09:00-04:00` when run on 8.1.
    - Otherwise: update the comment and `reminders_controller_test.rb:21`.

## D. Adopting new framework defaults is optional

Keep `load_defaults 7.0` for the version change. On `load_defaults 8.1` (branch `defaults81`, `/tmp/upg/v81B-test.log`) three more things break:
- **`postgresql_adapter_decode_dates` (7.2):** `Notebook#daily_note_counts` raises `TypeError` in `Date.iso8601(Date)`. Fix with `day.is_a?(Date) ? day : Date.iso8601(day)`, which works on every version.
- **`raise_on_assign_to_attr_readonly` (7.1):** the notebook settings form posts a hidden `slug`, and updating it raises `ReadonlyAttributeError`. Fix by not permitting `:slug` on update, or by removing the hidden field.
- **`raise_on_invalid_cache_expiration_time` (7.1):** `exports/_export.html.erb:26` passes a negative `expires_in` for expired exports, which makes the exports page return a 500.
  - Even on 7.0 defaults, 8.1 logs an error and caches that fragment with no expiry.
  - Fix: clamp the value with `[..., 0].max`, or only cache while the export is downloadable.

Before adopting the 7.1+ cookie and cache formats (`message_serializer`, `cache_format_version 7.1`), finish rolling out 8.1 everywhere first.
- I ran a synthetic check of the encrypted session cookie: 7.0, 8.1 on 7.0 defaults, and 8.1 on 8.1 defaults could all read each other's cookies.
- I did not test cache entries across versions. The production cache is the default local `file_store`, which limits the impact.

Other optional items:
- Schema dump churn: the dump becomes `Schema[8.1]`, with alphabetically sorted columns and `pg_catalog.plpgsql`.
- An `image_processing` warning in the worker.
- `Note.connection` is soft-deprecated.

## E. Rollout, stored data and queued work

- **Order:** deploy section A on 7.0 first, including item 13 and, if you want the old digest day, the `.utc` fix from item 19. Then deploy 8.1 together with section B.
- **Stored data:**
  - `notes.tags` (JSON) and `notebooks.preferences` (YAML) keep the same format.
  - Action Text HTML is unchanged in the database; sanitising happens when the page is rendered.
  - No migrations are needed.
- **Queued Sidekiq jobs:**
  - 7.0 payloads ran on 8.1: `DigestJob` and `NoteReminderJob` deserialized fine (`/tmp/upg/payload70.json`). Scheduled reminders may sit in Redis for a long time, and they stay compatible.
  - In the other direction only the BigDecimal argument fails (item 13).
  - `ExportJob` is a plain Sidekiq job and is not affected.
  - Rollback is safe once item 13 is in place. Without it, check the retry set for `DigestJob` before rolling back.
- **End to end on 8.1:** a real `sidekiq` 6.5.12 worker against the private Redis completed `ExportJob`, `DigestJob` and the scheduled `NoteReminderJob`, with the file attached and mail written (`/tmp/upg/sidekiq81.log`). Rails logs "built-in sidekiq adapter deprecated, removed in 8.2".
- **Later Sidekiq 7.3+ move (not needed for 8.1):**
  - `perform_async(id, { format: "markdown" })` would be rejected because of the symbol keys.
  - `redis.sadd` would return an Integer, which is always truthy, so `User#request_digest` would always think a digest was queued.
  - `Redis::*` error classes change.

## F. Verified, unverified and still open

- **Executed:**
  - All the test runs above (logs `/tmp/upg/v81-test{,2..9}.log`, `v81B-test.log`, `base-*.log`).
  - Production-mode eager-load check (`zeitwerk:check`) on 8.1.
  - Puma 5 dev server returning 200 and 302.
  - The cookie and job-payload cross-version checks.
- **Source-based only:**
  - The 7.0 behaviour of `show_exceptions = :none`.
  - That item 13 works on 7.0.
  - That 8.1 `actiontext.js` only listens for `trix-attachment-add`, so it should still work with the vendored `trix-1.3.5.js`.
- **Not run:**
  - `bin/rails test:system`, which needs a display and Chrome. This is the check for editor uploads with Trix 1.3.5.
  - A real staging run with production credentials, `secret_key_base` and citation-provider environment variables.
  - Whether a later 8.1.x patch removes the need for the `json` pin.

All experiment material is in `/tmp/upg`. The per-fix commits are in `/tmp/upg/app` (`git log main`, `defaults81`) and `/tmp/upg/base` (`prep`), and the scripts are in `/tmp/upg/scripts/`.

---

**Decisions needed before implementing:**
1. **Digest day (item 19):** should the daily digest keep using the UTC day, or switch to the reader's local day?
2. **Reminder preview (item 20):** should the "24 hours later" preview keep its original UTC offset, or show local time?

If you want me to implement it, I'd do it in two steps: section A first on 7.0, then the version change with section B. Tell me your choices on those two questions.