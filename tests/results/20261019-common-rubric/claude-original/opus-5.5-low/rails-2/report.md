# Upgrade plan: Rails 7.0.8.7 to 8.1.0 for Margin Notes

You can't just bump the Gemfile: the app crashes at boot. In a disposable copy it took 14 source fixes, plus a `json` pin, before all 46 tests passed on 8.1.0. Several of those fixes cover behaviour that no test checks or that a test caught only by chance. Two of them can damage data during a mixed-version rollout or a rollback.

**Labels:** **[E]** means it was run and has a log. **[S]** means it comes from the Rails 7.0.8.7 and 8.1.0 gem source or the changelogs, without running it. **[P]** means a proposed check that hasn't been run.

## Experiment setup and evidence

- **Copies:**
  - `/tmp/rx/base`: unchanged, from `git archive HEAD`.
  - `/tmp/rx/up`: 8.1.0 with the fixes, still on `load_defaults 7.0`.
  - `/tmp/rx/up-defaults`: `up` plus `load_defaults 8.1`.
- **Isolation:**
  - Databases: separate PostgreSQL databases set through `DATABASE_URL`: `rx_base_test`, `rx_up_test`, `rx_upd_test` and `rx_mixed`.
  - Redis: a private `redis-server` on port 6390, databases 0–4 via `REDIS_URL`, shut down afterwards.
  - Cache: the test environment uses `:null_store`, and one test swaps in its own in-process `MemoryStore`.
  - Storage: each copy's own `tmp/storage`.
  - Run with `RAILS_ENV=test PARALLEL_WORKERS=1`.
- **Resolved dependencies:** `bundle update rails --conservative` gave rails 8.1.0 and action_text-trix 2.1.19. It also brought in json 3.0.2, which was not in the lock before. Sidekiq 6.5.12 and redis 4.8.1 stayed, because both are pinned. The lock diff is in `/tmp/rx/logs/lock-diff.txt`. The json pin is recorded in `/tmp/rx/logs/up-bundle2.log`.
- **Results:**
  - **[E] Baseline on 7.0:** 46 runs, 0 failures (`base-test.log`).
  - **[E] 8.1 with only the version bump:** crashes at boot (`up-boot1.log`).
  - **[E] 8.1 as fixes were added:** `up-test1.log` … `up-test11.log`. The final run is 46 runs, 340 assertions, 0 failures (`up-test11.log`).
  - **[E] `zeitwerk:check` and `assets:precompile`:** both pass (`up-assets.log`).
  - **[E] 8.1 with `load_defaults 8.1`:** 3 errors remain after the extra `coder: YAML` fix (`up-defaults81-test2.log`).
  - **[E] Cross-version job payloads:** enqueued with `/tmp/rx/scripts/enqueue.rb` (`payload-70.txt`, `payload-81.txt`) and performed with `/tmp/rx/scripts/perform.rb` (`perform-81-on-70.log`, `perform-70-on-81.log`).
  - **[E] Schema dump diff:** `schema-diff.txt`.
  - **Full patches:** `/tmp/rx/logs/up-patch.diff` and `/tmp/rx/logs/up-defaults-patch.diff`.
  - All logs are under `/tmp/rx/logs`.
- **Not run:**
  - System tests: there are none in `test/system`, and no browser is installed.
  - A real Sidekiq worker process.
  - A production-environment boot with real credentials.

## A. Required changes (8.1.0 with `load_defaults 7.0` kept)

"Works on 7.0" means the change can be merged and deployed before the version bump.

| # | Affected code | What happens on 8.1 | Recommendation | Works on 7.0 | Evidence |
|---|---|---|---|---|---|
| A1 | Gemfile (indirect `json` dependency) | activesupport 8.1.0 doesn't limit the `json` version, so the lock picked json 3.0.2. `ActiveSupport::JSON.decode` then raises `ArgumentError (given 2, expected 1)` on every read of a JSON column, here `serialize :tags`. | Add `gem "json", "< 3"` (resolved to 2.21.2), or check whether a later 8.1.x patch fixes this. | Yes, harmless | [E] `up-test5.log`, fixed in `up-test6.log` |
| A2 | `config/initializers/action_text.rb` | Since 7.1, `ActionText::ContentHelper.allowed_tags` is `nil` by default, so `+=` raises `NoMethodError` at boot. | Set it in `after_initialize` from `(allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]) + %w[details summary]`. | Yes, the resulting list is the same as on 7.0 | [E] `up-boot1.log`, `up-boot2.log` |
| A3 | `app/models/note.rb:10`, `enum status: {...}, _prefix: true` | The keyword-argument form was removed in 8.0 (`ArgumentError`). | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes | [E] `up-test1.log` |
| A4 | `note.rb:12`, `serialize :tags, JSON` | Passing the coder as a positional argument was removed in 7.2. | `serialize :tags, coder: JSON` | **No**: `coder:` needs 7.1+, so this goes in the bump commit | [E] `up-test2.log` |
| A5 | `note.rb:14`, `alias_attribute :highlight_color, :color` | `color` is a `store_accessor`, not a database column. 8.x raises `ArgumentError`. | Write `highlight_color` and `highlight_color=` methods by hand. | Yes | [E] `up-test3.log` |
| A6 | `config/routes.rb`, `get "/notes", "/journal", to:` | Listing several paths in one route was removed, and the `notes_path` helper disappears. | Two routes: `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index"`. | Yes ([P] confirm the helper names with `bin/rails routes` on 7.0) | [E] `up-test3.log` |
| A7 | `Rails.application.secrets` in `app/models/citation/provider.rb:13` and `test/controllers/citation_enrichments_controller_test.rb:45,117-122`; `config/secrets.yml`; `CONTRIBUTING.md` mentions `secrets.yml` | `secrets` was removed in 7.2/8.0, so these raise `NoMethodError`. | Move the settings to `config/citation_provider.yml`, load them with `config.x.citation_provider = config_for(:citation_provider)`, and update the provider, the test and `CONTRIBUTING.md`. | Yes | [E] `up-test4.log`, `up-test5.log` |
| A8 | `app/models/export.rb:42`, `fragments.sum` | Summing strings no longer works and raises `TypeError`, so every export job fails. It was already deprecated on 7.0 (`base-test.log`). | `fragments.join` | Yes | [E] `up-test5.log` |
| A9 | `config/environments/test.rb`, `show_exceptions = false` | Booleans are no longer accepted. Exceptions get rescued and rendered, and five not-found tests start failing. | `:none` | **No**: on 7.0, `:none` counts as true and turns exception pages on. Change it in the bump commit. | [E] `up-test6.log` → `up-test7.log` |
| A10 | `app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)` | Raises "Passed nil to the :model argument", so the notes list returns 500. | Drop `model: nil`. | Yes ([P] check the rendered form attributes are unchanged on 7.0) | [E] `up-test7.log` |
| A11 | `app/jobs/citation_enrichment_job.rb`, `wait: :exponentially_longer` | Removed in 7.2. Raises "Couldn't determine a delay" when a retry is due, so the job is never retried. | `:polynomially_longer`. 7.1+ also adds 15% random jitter to the wait. | **No** (needs 7.1+). A lambda such as `->(n) { n**4 + 2 }` works on both versions if you want to change it early. | [E] `up-test7.log` |
| A12 | `note.rb`, `set(wait_until: reminder_epoch)` with an Integer | Raises "undefined method `utc` for Integer", so reminders can't be scheduled. | `wait_until: Time.at(reminder_epoch)` | Yes | [E] `up-test7.log` |
| A13 | `app/controllers/notes_controller.rb:15`, `where(notebooks: @notebook)` | Generates SQL for a `notes.notebooks` column that doesn't exist (`PG::UndefinedColumn`). | `where(notebook: @notebook)` | Yes | [E] `up-test7.log` |
| A14 | `app/views/imports/preview.html.erb`, `annotations.stringify_keys` | **Fails silently: import previews stop showing annotations.** On 8.1, stringifying an indifferent-access hash turns Integer keys like `2` into `"2"`, so looking up by line number finds nothing. | Use `@import.annotations` directly. | Yes | [E] Runner output: 7.0 gives `{2=>"x"}`, 8.1 gives `{"2"=>"x"}`. Test failure in `up-test8.log`. |
| A15 | `app/models/import.rb`, `receipt` reads `citation[:id]` | **Fails silently: the DOI column of every import receipt CSV is empty, and no test checks it.** Citations use `doi` as the primary key and have no `id` column. Since 7.2, `[:id]` reads a column called `id`, so it returns `nil`. | Use `note.citation_doi`. | Yes | [E] Runner output: 7.0 gives `"10.1000/x"`, 8.1 gives `nil`. |
| A16 | `import.rb`, `apply`: `return false` inside `transaction do` | **Data integrity: a failing row leaves a partial import saved.** 7.0 rolls back when the block exits with `return`. 7.1+ **commits**. A test caught this: counts were `[1,4,1,2]` instead of `[0,3,0,1]`. | `raise ActiveRecord::Rollback unless rows.all? { _1.note.save }`, and return false when the transaction returns nil. | Yes | [E] `up-test9.log` → `up-test10.log` |
| A17 | `note.rb`, `next_day_reminder_at` computes `reminder_at.to_time + 86_400` | On 8.1, `to_time` always keeps the time zone, and the old setting is ignored. Across a DST change, the page shows the new offset (`-05:00`) instead of the documented same offset (`-04:00`). | `(reminder_at + 86_400.seconds).to_time.getlocal(reminder_at.utc_offset)` | Yes ([P] confirm with the existing reminder test on 7.0) | [E] `up-test8.log` |
| A18 | `app/mailers/digest_mailer.rb` and `User#request_digest` | **Fails silently: the digest covers the reader's local day instead of the UTC day.** Since 7.1, the job serializer keeps the time zone of a time argument, so the worker receives the reader's local time instead of UTC. | Add `requested_at = requested_at.in_time_zone("UTC")` in the mailer. | Yes | [E] Digest test in `up-test8.log`, fixed in `up-test11.log` |
| A19 | `User#request_digest` passes the reading completion as a `BigDecimal` | 8.1 always uses a dedicated serializer for decimals, and a 7.0 worker can't read that payload (see C1). | Pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`. | Yes, and it must be **deployed first** | [E] `perform-81-on-70.log`: `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` |

**[S] Unchanged while `load_defaults 7.0` stays in place:**
- **Cookies and sessions:** the cookie serializer stays `:json` and the key generator stays SHA256. The session only holds an integer user id.
- **Cache:** the cache format stays 7.0, which 8.1 can still read.
- **Job enqueueing:** `enqueue_after_transaction_commit` stays false. Jobs enqueued while `Citation` and `Note` hold row locks are still rolled back together with a failed enqueue.
- **Schema dump:** the changes are cosmetic (`Schema[8.1]`, `pg_catalog.plpgsql`, columns sorted alphabetically). There are no precision changes [E].

## B. Optional: adopting new defaults (a separate, later step)

[E] Results with `load_defaults 8.1` in `/tmp/rx/up-defaults`:

| # | Affected code | What changes | Fix (and whether it also works on 7.0) |
|---|---|---|---|
| B1 | `app/models/notebook.rb:7`, `serialize :preferences` | 7.1 sets `default_column_serializer = nil`, so every model fails to load. | `serialize :preferences, coder: YAML` (7.1+ only). Stored YAML hashes of strings stay readable [S]. |
| B2 | `Notebook#daily_note_counts` | 7.2 turns on `postgresql_adapter_decode_dates`, so `select_rows` returns `Date` objects, and `Date.iso8601(Date)` raises `TypeError`. | Accept either a `Date` or a string. Works on 7.0. |
| B3 | `NotebooksController#notebook_params` permits `:slug` | 7.1 turns on `raise_on_assign_to_attr_readonly`. The settings form resubmits the slug, so it raises `ReadonlyAttributeError`. | Don't permit `:slug` on update. Works on 7.0. |
| B4 | `app/views/exports/_export.html.erb:26`, `expires_in: export.expires_at - Time.current` | For an expired export the duration is negative. With the 7.1 default this raises, and the exports page returns 500. With `load_defaults 7.0` the bad duration is logged and dropped, so the "Expired" fragment is cached with no expiry [S]. | Only cache when `export.downloadable?` (for example with `cache_if`), or clamp the duration. Works on 7.0. |
| B5 | Cache format 7.1 and the `:json_allow_marshal` message serializer | 7.0 can't read entries written in the new format. | Adopt only after the rollout is finished and rollback is off the table. Production sets no `cache_store`, so it uses the default file store on each host [S]. |
| B6 | Action Text and Action View `sanitizer_vendor` (HTML5) | Changes how stored rich text is sanitized when rendered. | [P] Render the stored bodies with both the HTML4 and HTML5 sanitizers and compare the output. |
| B7 | `strict_freshness` (8.0), `escape_json_responses` and `action_on_path_relative_redirect` (8.1) | [S] Little effect here: `ExportDownloadsController` sends both an ETag and a Last-Modified date, there are no jbuilder views, and redirects use absolute paths. | None needed. |

## C. Mixed-version rollout and rollback risks

- **C1 – Sidekiq queues (high risk).** Job payloads written by 8.1 include the decimal serializer marker, and 7.0 workers can't read them [E]. After a rollback, any retry or scheduled job written by 8.1 will fail. Reminders can be scheduled arbitrarily far ahead, so these entries can sit in the queue for a long time.
  - Mitigation: deploy A19 on 7.0 first. Before the bump, drain the queues or confirm they hold no such jobs.
  - Scheduled `NoteReminderJob` payloads work in both directions [E].
  - 7.0 ignores the extra `time_zone` key that 8.1 adds [E/S]. However, a 7.0 worker uses UTC, so A18 must also be on 7.0 for both versions to behave the same.
- **C2 – Retries queued under 7.0.** `CitationEnrichmentJob` retries already in the queue keep their old payload. The wait is recalculated when the retry runs, so they are fine once A11 is in place [S].
- **C3 – Cache.** No risk while the cache format stays 7.0. Only adopting B5 makes it one-way.
- **C4 – Schema file.** After a schema dump on 8.1, `db/schema.rb` declares `Schema[8.1]`, which a 7.0 checkout can't load. This affects CI and local setup after a rollback, not production data. Leave the dump out of the bump commit, or revert it together with the bump.
- **C5 – Development secret.** 7.1+ reads the development secret from `tmp/local_secret.txt` instead of `tmp/development_secret.txt` [S], so development sessions reset once. Production `secret_key_base` must come from credentials or the environment, because `secrets.yml` holds none. Which one production uses was not verified.
- **C6 – Partial imports.** Partial imports saved on 8.1 before A16 is fixed stay in the database. Put A16 in the bump commit itself, if it isn't deployed earlier on 7.0.

## D. Strongly recommended follow-up: Sidekiq

Rails 8.1 still includes a `:sidekiq` adapter but warns that it will be removed in 8.2 [E]. Moving to Sidekiq 7.3.3+ changes app behaviour in ways the tests barely cover. All of the following is [S]:
- **Duplicate digests:** Sidekiq 7 uses `redis-client`, where `sadd` returns `0` or `1`. Both are truthy in Ruby, so the once-a-day digest check in `User#request_digest` would always pass. Compare with `sadd(...) == 1`. Redis 4.8 already logs a warning about this (`up-test8.log`).
- **Rejected export jobs:** strict job arguments reject `ExportJob.perform_async(id, { format: "markdown" })` because of the symbol key. The log already warns about this.
- **Missed connection errors:** `rescue Redis::BaseError` in `Notebook#request_export` would not catch `RedisClient::Error`.

## E. Checks still to run [P]

1. A browser smoke test of the rich-text editor. The layout loads the vendored Trix 1.3.5 JavaScript, while 8.1 serves Trix 2 CSS from `action_text-trix` alongside `actiontext.js` 8.1 [E: the precompile output contains both]. Check editing, `details`/`summary` sanitization, and attachment upload.
2. A real `bundle exec sidekiq` worker on 8.1 running all four jobs end to end, including running out of retries (`retry_on`) and `discard_on`.
3. A production-environment boot with real credentials.
4. A request test for the import receipt that checks the DOI column, to cover A15.
5. Re-run the C1 cross-version test after A19 to confirm a 7.0 worker can read the payload.

## F. Suggested sequence

1. **On 7.0**, with each step safe to deploy and roll back on its own:
   - A3, A5, A6, A7, A8, A10, A12, A13, A14, A15, A16, A17, A18 and A19.
   - The 7.0-compatible fixes for B2, B3 and B4.
2. **Optionally**, step through 7.1, 7.2 and 8.0 to see each version's deprecation warnings.
3. **The bump commit:**
   - `rails 8.1.0` and the json pin (A1).
   - A2, A4, A9 and A11.
   - Leave the schema dump out.
4. **Deploy and settle:** deploy, wait until the Sidekiq queues hold only 8.1 payloads, then decide when rollback is no longer an option.
5. **New defaults:** adopt them one at a time (B1–B6), with the cache format last.
6. **Sidekiq:** upgrade it (D) before Rails 8.2.

## Unverified claims and open questions

- Whether a later 8.1.x patch limits the `json` version, and whether 8.1.0 is a firm target or any 8.1.x is acceptable.
- Whether production jobs other than `DigestJob` take decimal or time arguments, and what the scheduled and retry sets contain right now.
- Where production gets `secret_key_base` from, and whether the file cache is shared between hosts.
- Whether the export-page behaviour under `load_defaults 7.0` described in B4 is acceptable. It is [S] only.
- Whether the mismatch between Trix 1.3.5 JavaScript and Trix 2 CSS is acceptable, or Trix should be upgraded together with Rails.

The working repository is unchanged. The agent briefly downloaded `rails-8.1.0.gem` into it by mistake and deleted it right away. The final `git status` was clean. All experiment files are under `/tmp/rx`.

---

## My comments

- **What I didn't check myself:** I didn't re-run any experiments or open the logs. The [E] results are as the planning agent reported them; to confirm one, look at its log in `/tmp/rx/logs`.
- **What to fix first:** A15, A16, A18 and C1 are the riskiest. Their failures are silent, or they leave partial imports saved or jobs that a 7.0 worker can't read after a rollback. A16, A18 and A19 work on 7.0, so deploy them before the version bump.
