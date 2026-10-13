# Plan: upgrade Rails 7.0.8.7 to 8.1.0 in Margin Notes

**Summary.** On Rails 8.1.0 the app does not start, and the test suite shows 14 changed or broken behaviours. One of them silently corrupts data: a failed import now saves part of the file. With the bundle resolved, the remaining 46 tests pass on 8.1 only after the changes below. Most fixes can ship first on 7.0, which I confirmed by running the tests there. Three changes cannot, and must go out in the same deploy as the version bump. Queued jobs are the main rollout and rollback risk. Cookies are not a risk.

Evidence labels used below: **[E]** I ran it (in a disposable copy), **[S]** I read it in the gem or app source, **[P]** a check I am proposing but have not run.

## Experiment setup (all in a disposable copy)
- **Copies:** the 8.1 copy is at `/tmp/upg-exp/app` (a `git archive` of HEAD `ab732f5`, bundle in `/tmp/upg-exp/bundle`). The 7.0 copy is at `/tmp/upg-exp/base` (bundle in `/tmp/upg-exp/bundle70`).
- **Isolated services:** a private PostgreSQL 15 cluster (`/tmp/upg-exp/pg`, port 55432, unix socket only) and a private Redis (port 56379, no persistence). Settings are in `/tmp/upg-exp/env.sh` (`PGHOST`, `PGPORT`, `REDIS_URL`, `BUNDLE_PATH`, `RAILS_ENV=test`).
- **Storage:** Active Storage used the copy's own `tmp/storage`. Both services are stopped now.
- **Working repo:** `git status` is still clean.
- **Resolution:** `bundle update rails concurrent-ruby --conservative` with `gem "rails", "8.1.0"` and the concurrent-ruby pin removed.
  - Resolved: rails 8.1.0, action_text-trix 2.1.19, rack 2.2.24 (sidekiq 6.5 holds rack at 2.x), rack-session 1.0.2, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, minitest 5.27.0, concurrent-ruby 1.3.8, zeitwerk 2.8.3, pagy 8.6.3, faraday 1.10.4, and json 3.1.0 (then pinned to 2.21.2, see R1).
  - Log: `/tmp/upg-exp/bundle-update.log`.
- **Final results:**
  - 8.1 with all changes: 46 runs, 2 failures. Both are the intended behaviour changes in R11 and R12 (`/tmp/upg-exp/test-8.1e.log`).
  - Unmodified 7.0: 46 runs, 0 failures (`/tmp/upg-exp/test-7.0-baseline.log`).
  - 7.0 with the preparatory patch (`/tmp/upg-exp/prep.patch`): 46 runs, 0 failures, and the 7.0 `Enumerable#sum` deprecation is gone (`/tmp/upg-exp/test-7.0-prep.log`).
- The 8.1 failures were fixed one at a time. Each step's log is `/tmp/upg-exp/boot-8.1{,b..e}.log` and `/tmp/upg-exp/test-8.1{,b..e}.log`.

## Required changes

"Prep" means the change also works on 7.0 and can ship before the upgrade. I confirmed that for the whole patch by running the 7.0 tests.

| # | Affected code | What breaks on 8.1 | Fix | Prep? |
|---|---|---|---|---|
| R1 | `Gemfile` | **[E]** activesupport 8.1.0 depends on an unconstrained `json`. The resolver picked json 3.1.0, so `ActiveSupport::JSON.decode` raises `ArgumentError` on every session cookie read. | Add `gem "json", "< 3"` (resolved to 2.21.2). Re-check if you target a later 8.1.x. | Lockfile change only; deploy with the upgrade |
| R2 | `config/initializers/action_text.rb` | **[E]** `allowed_tags` is now `nil` by default, so the app fails at boot with `NoMethodError` (`nil + Array`). | Set the tags inside `after_initialize`, using `allowed_tags \|\| (sanitizer.class.allowed_tags + [Attachment.tag_name, "figure", "figcaption"])` and adding `details` and `summary` (`/tmp/upg-exp/action_text_prep.rb`). | Yes [E] |
| R3 | `app/models/note.rb:10` (`enum status: …, _prefix:`) | **[E]** `ArgumentError` when the class loads. | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes [E] |
| R4 | `app/models/note.rb:12` (`serialize :tags, JSON`) | **[E]** The positional coder argument was removed. | `serialize :tags, coder: JSON` | **No.** **[E]** On 7.0 the `coder:` keyword is silently ignored and tags are written as YAML (`"---\n- a\n"`), which corrupts the column. Ship this only with the version bump. |
| R5 | `app/models/note.rb:14` (`alias_attribute :highlight_color, :color`, where `color` is a `store_accessor`) | **[E]** `ArgumentError` the first time attribute methods are defined. Eager loading still passes, so `zeitwerk:check` does not catch it. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes [E] |
| R6 | `config/routes.rb:18` (`get "/notes", "/journal", to:`) | **[E]** Multiple paths in one call are rejected, so the routes file fails to load. | Two separate `get` lines. `notes_path` and `journal_path` are kept. | Yes [E] |
| R7 | `config/secrets.yml`, `app/models/citation/provider.rb:13`, `test/controllers/citation_enrichments_controller_test.rb:45,116-121` | **[E]** `Rails.application.secrets` was removed. | Move the settings to `config/citation_provider.yml` and load them with `config.x.citation_provider = config_for(:citation_provider)`. Update the provider and the test. Production still reads `CITATION_PROVIDER_*`. | Yes [E] |
| R8 | `app/models/import.rb` `apply` (`return false` inside `transaction`) | **[E] Data integrity.** Leaving a transaction block with `return` now **commits** instead of rolling back. A CSV with one invalid row saves the import plus the earlier rows' notes and citations (test showed `record_counts` going from `[0,3,0,1]` to `[1,4,1,2]`). | `raise ActiveRecord::Rollback` and return a `saved` flag. | Yes [E] |
| R9 | `app/models/import.rb` `receipt` (`citation[:id]`) | **[E]** The citations table's primary key is `doi`. `[:id]` now returns nil, so the DOI column of the receipt CSV is empty. | `citation&.doi` | Yes [E] |
| R10 | `app/models/export.rb:42` (`fragments.sum`) | **[E]** `TypeError` (String can't be coerced into Integer). Every export job fails. 7.0 already logs a deprecation warning for this. | `fragments.join` | Yes [E] |
| R11 | `app/views/notes/index.html.erb:12` (`form_with(model: nil, …)`) | **[E]** `Passed nil to the :model argument`, so the main note list returns 500. | `form_with(url: notes_path, …)` | Yes [E] |
| R12 | `app/controllers/notes_controller.rb:12` (`where(notebooks: @notebook)`) | **[E]** `PG::UndefinedColumn notes.notebooks`, so filtering by notebook returns 500. | `where(notebook: @notebook)` | Yes [E] |
| R13 | `app/views/imports/preview.html.erb:22` (`annotations.stringify_keys`) | **[E]** `HashWithIndifferentAccess#stringify_keys` now really converts keys to strings, so the lookup by integer line number misses. Annotations silently disappear from the preview. | Use `@import.annotations` (or `row.annotation`). | Yes [E] |
| R14 | `app/models/note.rb:62` (`set(wait_until: reminder_epoch)`) | **[E]** `NoMethodError: undefined method 'utc' for Integer`. Reminders cannot be scheduled. | `wait_until: Time.at(reminder_epoch)` | Yes [E] |
| R15 | `app/jobs/citation_enrichment_job.rb:7` (`wait: :exponentially_longer`) | **[E]** `RuntimeError: Couldn't determine a delay`. | `wait: ->(executions) { executions**4 + 2 }`. This keeps 7.0's formula; jitter is applied differently. `:polynomially_longer` does not exist on 7.0. | Yes [E] |
| R16 | `config/environments/test.rb:31` (`show_exceptions = false`) | **[E]** `false` is now treated as "rescue everything", so `assert_raises` tests fail. Test environment only. | `:none` | **No.** `:none` is truthy on 7.0. Ship with the bump. |

Two behaviour changes the tests caught. You need to decide on each; this is not mechanical:

- **R17: digest day.**
  - **[E]** In 8.1, `TimeWithZoneSerializer` serializes the time zone too (`"time_zone":"America/New_York"`). `DigestMailer` now covers the reader's *local* day ("October 04"), not the UTC day ("October 05").
  - That contradicts the UTC wording in `notes/index.html.erb:10` and the Redis reservation key, which is also per UTC day.
  - To keep today's behaviour, use `requested_at.utc` in `app/mailers/digest_mailer.rb` before calling `to_date` and `all_day`. This works on 7.0 [S]; I have not run it [P].
- **R18: postponed reminder offset.**
  - **[E]** Across the 2026-11-01 DST change, `Note#next_day_reminder_at` gives 08:00 -05:00 on 8.1. On 7.0 it gave 09:00 -04:00. It is the same instant and epoch; only the displayed offset differs.
  - The cause is that `to_time` now keeps the zone, not just the offset. `ActiveSupport.to_time_preserves_timezone` is nil and deprecated.
  - Either accept the new display and update the test and comment, or keep the old one with `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400` [P].

## Optional default adoption (keep `load_defaults 7.0` for the upgrade itself)
**[S]** These come from `railties-8.1.0/lib/rails/application/configuration.rb`. Adopt them later, one at a time.

- **7.1:**
  - `default_column_serializer = nil` makes `serialize :preferences` in `app/models/notebook.rb` fail. Give it `coder: YAML` first.
  - `active_support.cache_format_version 7.1` is not readable by 7.0, so flip it only after a rollback to 7.0 is no longer possible. The only cache user is the fragment in `exports/_export.html.erb`, and production uses the default file store.
  - `message_serializer`.
  - The HTML5 sanitizer (`action_text.sanitizer_vendor`): re-check that `details` and `summary` survive. Today **[E]** the sanitizer is HTML4 and `details` is allowed.
- **7.2: `enqueue_after_transaction_commit`.** Do **not** turn this on globally. `Citation#request_enrichment` and `Note#schedule_reminder` rely on enqueueing inside the row lock, so that a failed enqueue rolls back. It is currently `false` **[E]**.
- **8.0:** `strict_freshness`, `Regexp.timeout`.
- **8.1:** `action_on_path_relative_redirect = :raise`, `raise_on_missing_required_finder_order_columns`, YJIT, `escape_json_responses = false`.
- **`bin/rails app:update`:** review the files it generates instead of accepting them wholesale.

## Mixed-version rollout and rollback
- **DigestJob payloads (blocking for rollback).**
  - **[E]** 8.1 always serializes `BigDecimal` with `BigDecimalSerializer`. 7.0 raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`/tmp/upg-exp/probe-7.0.out`).
  - So a 7.0 worker running during the deploy, or after a rollback, fails every DigestJob enqueued by 8.1. The reader's Redis reservation is already taken, so they cannot ask again that day.
  - **Fix (prep, 7.0-safe [S]):** pass `reading_completion.to_s` in `User#request_digest`. The mailer already calls `BigDecimal(params[:completion])`. Also deploy workers before or together with web.
- **TimeWithZone payloads:**
  - 7.0 → 8.1: jobs enqueued by 7.0 have no `time_zone` key, so 8.1 reads them in UTC, as today [S].
  - 8.1 → 7.0: 7.0 ignores the extra key [S], so the digest date is UTC again.
- **Sidekiq queue.**
  - The `ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper` class name and the `wrapped` key are the same in both versions [S]. So scheduled `NoteReminderJob`s already in Redis (GlobalID argument only) should run on 8.1 [P: enqueue under 7.0 and drain under 8.1 against the same isolated Redis].
  - `ExportJob` is a native Sidekiq job and does not depend on the Rails version.
  - `CitationEnrichmentJob` retry counts carry over in `executions` [S].
- **Sidekiq adapter deprecation.** **[S]** The built-in `sidekiq` adapter is deprecated in 8.1 and removed in 8.2. It needs sidekiq ≥ 7.3.3, which is a separate upgrade with its own risk:
  - redis-client replaces redis-rb.
  - `Sidekiq.redis { _1.sadd }` returns an Integer, so `User#request_digest`'s truthiness check breaks.
  - The rescue of `Redis::BaseError` in `Notebook#request_export` changes.
  - The tests already print redis 4.8 `sadd?` warnings.
- **Stored data.**
  - `notes.tags` (JSON text): R4 keeps it JSON on 8.1. Never deploy R4 to a 7.0 process.
  - `notebooks.preferences` (YAML): unchanged under 7.0 defaults [E].
- **Cookies and sessions.** `cookies_serializer` is `:json` on both [E]. 7.0 defaults already use SHA256 key derivation, so no forced sign-out is expected [S, P: sign in on 7.0, then read the cookie on 8.1].
- **Cache.** The 7.0 cache format stays in place while `load_defaults` stays 7.0 [S].
- **Schema.**
  - **[E]** `db:schema:dump` on 8.1 rewrites `db/schema.rb`: `Schema[8.1]`, `pg_catalog.plpgsql`, and alphabetically sorted columns. That is 72 lines of noise, and no migration is needed.
  - Commit the dump as its own change. 7.0 can still load it [P].

## Proposed sequence
1. Ship the preparatory patch on 7.0: R2, R3, R5–R15, plus the DigestJob `to_s` change and your choices for R17 and R18. Run the full suite and `test:system`. Watch production for 7.0 deprecation warnings (`report_deprecations` is currently false in production).
2. Optionally step through 7.1, 7.2 and 8.0 to see each version's deprecation warnings. I tested the direct jump to 8.1.
3. Ship the upgrade commit: Gemfile and lock (R1, the concurrent-ruby pin removed, `rails "8.1.0"`), R4, R16, and the regenerated schema. Workers and web go out together, and the queues should be drained first if you can.
4. Adopt framework defaults separately, then decide on Sidekiq 7.

## Not verified / open questions
- **System tests:** I did not run `test:system` under either version.
- **Production-mode checks on 8.1:**
  - asset precompile with Sprockets
  - the Importmap pin of `@rails/actiontext` now that `action_text-trix` is a separate gem
  - CSP
  - Puma 5 serving
- **Job checks, now in [P]:**
  - draining jobs between versions against a real Sidekiq
  - Sidekiq 6.5's runtime checks under Rails 8.1
- **R17 and R18:** which behaviour is wanted is a product decision.
- **Later 8.1.x:** does a later 8.1.x make the json pin unnecessary? That would require deviating from the exact requested 8.1.0.
- **Sidekiq 7:** when you plan to move to Sidekiq 7, given the 8.2 removal.

---

Note: the planning skill asked me to hand this to a `gem-upgrade-planner` subagent, but I can't start subagents from here, so I did the analysis and experiments myself. The working repository at `/home/user/workspace/repo` was not changed.

---

**My notes:**

- **Where the plan comes from:** the planning agent wrote this plan, and "I" in the plan means that agent. It also ran the [E] experiments in `/tmp/upg-exp`. I didn't re-run them or open its logs, so those results are its account and I haven't checked them.
- **A section I left out:** the agent's report ended with a "Notes on the plan above" section that was written as if it were my own checks. I didn't make those checks, so I left that section out.
- **What I checked myself:** `Gemfile` pins `rails "7.0.8.7"` and the lockfile resolves to 7.0.8.7.
- **Nothing is implemented yet:** I haven't changed the app.
- **Three changes must ship with the version bump, not before:** R1 (the `json` pin), R4 and R16. R4 matters most, because on 7.0 it silently writes `notes.tags` as YAML.
- **Most urgent prep fixes:** R8 stops a failed import from saving part of the file, and the DigestJob `to_s` change lets a rollback to 7.0 run digest jobs queued under 8.1.
- **Your decisions:** R17 (whether the digest covers the reader's local day or the UTC day) and R18 (how the postponed reminder's time is displayed across the DST change).