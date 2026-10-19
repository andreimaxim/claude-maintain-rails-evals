# Rails upgrade plan for Margin Notes: 7.0.8.7 → 8.1.0

The upgrade is feasible on Ruby 3.3.6 without upgrading any other directly listed gem, but three things block a plain bump:

1. **About 18 code changes.** I wrote and tested them in a disposable copy. 15 of them also pass on 7.0.8.7, so they can ship before the upgrade. Three only work on 7.1 or later.
2. **A dependency pin.** Rails 8.1.0 resolves `json` 3.0.2, which breaks every encrypted cookie read. That means every signed-in request fails. Pin `json` below 3, or target 8.1.4 or later instead of 8.1.0.
3. **A rollout rule.** Keep `config.load_defaults 7.0` through the upgrade. Adopt newer defaults only after rollback to 7.0 is no longer an option. With newer defaults, Action Text attachment IDs saved into note bodies become unreadable by 7.0.

With the 7.0-compatible changes, the 7.1-only changes and the `json` pin, all 46 tests pass on 8.1.0, under both `load_defaults 7.0` and `load_defaults 8.1`. Nothing in `/home/user/workspace/repo` or its databases, Redis, cache or storage was changed.

## How the experiments were run (and how to reproduce them)

- **Isolation:** a separate PostgreSQL 15 cluster (`/tmp/upg/pgdata`, socket `/tmp/upg/pgsock`, port 5499) and a separate Redis (port 6390, no persistence). Environment is in `/tmp/upg/env.sh`.
- **Gems:** installed into `/tmp/upg/gems` via `/tmp/upg/env-variant.sh`. The global gems were only read, for the 7.0 baseline.
- **Copies:** separate git clones under `/tmp/upg`, each with its own `tmp/storage` and `tmp/cache`. Both services are stopped now.
- **Rails versions tested:** 7.0.8.7 (baseline), 7.1.6, 7.2.4, 8.0.5.1, 8.1.0, and 8.1.0 with `json` pinned (`/tmp/upg/v81j`). Each used `bundle lock --update rails` with every other Gemfile pin unchanged.
- **Code variants:** branches in `/tmp/upg/prep`:
  - `prep`: the changes that also work on 7.0.
  - `step71`: `prep` plus the three 7.1-only changes.
  - `defaults81`: `step71` with `load_defaults 8.1`.
  - `ablate81`: `defaults81` with three default-sensitive fixes reverted.
- **Diffs:** `git -C /tmp/upg/prep diff 9938031 prep` and `git -C /tmp/upg/prep diff prep step71`.
- **Runner:** `/tmp/upg/run_variant.sh <name> <branch> <gem-variant>`. Logs are in `/tmp/upg/logs/`.

## Test results

| Branch | Rails | Result | Log |
|---|---|---|---|
| unchanged | 7.0.8.7 | 46 runs, 325 assertions, green (one Enumerable#sum deprecation) | `v70-test.log` |
| unchanged | 7.1 / 7.2 / 8.0 / 8.1 | fails at boot in `config/initializers/action_text.rb` | `v7x/v8x-test-unchanged.log` |
| `prep` | 7.0.8.7 | green, no deprecations | `r-base-prep-test.log` |
| `prep` | 7.1.6 | green, 340 assertions | `r-v71-prep-test.log` |
| `step71` | 7.0.8.7 | 23 failures (expected: these changes need 7.1+) | `r-base-step71-test.log` |
| `step71` | 7.1.6 / 7.2.4 / 8.0.5.1 | green | `r-v7x/v80-step71-test.log` |
| `step71` | 8.1.0 with json 3.0.2 | 40 errors, all from JSON parsing of messages | `r-v81-step71-test.log` |
| `step71` | 8.1.0 with json 2.21.2 | green, no deprecations | `r-v81j-step71-test.log` |
| `defaults81` | 8.1.0 with json 2.21.2 | green | `r-v81j-defaults81-test.log` |
| `ablate81` | 8.1.0 | 3 errors (date decoding, read-only slug, negative cache expiry) | `r-v81j-ablate81-test.log` |

The `abl-<item>.log` files are single-item reverts on 8.1 with defaults 7.0. Each reverted change made its own test fail.

## Ruby and other gems

- **Ruby:** 3.3.6 satisfies Rails 8.1 (needs 3.2 or later). No change required. If Ruby later moves to 3.4, add `gem "csv"`: `app/models/import.rb` requires it and Ruby already warns.
- **`json` (required):** Rails 8.1.0 adds a `json` dependency with no upper bound, so Bundler picks 3.0.2. Active Support 8.1.0–8.1.3 calls `JSON.parse(json, options)` with a positional hash, which json 3 rejects. Every encrypted session cookie read raises `ArgumentError`.
  - Fix: add `gem "json", "~> 2.7"` (resolved to 2.21.2), or target Rails 8.1.4 or later. I checked the 8.1.4 source (`::JSON.parse(json, **options)`) but did not run it.
- **Lockfile changes for 8.1:**
  - New: `action_text-trix` 2.1.19, `rack-session` 1.0.2, `rackup` 1.0.1, `useragent`, `securerandom`, `uri`, `drb`, `bigdecimal` 4.1.3, `webrick`.
  - Removed: `method_source`. Updated: `net-imap` 0.6.7 → 0.6.8.
  - Unchanged: `rack` 2.2.24 (held by sidekiq 6.5's `rack ~> 2.0`), `sidekiq` 6.5.12, `redis` 4.8.1, `puma` 5.6.9, `pagy`, `faraday`, `turbo-rails`, `importmap-rails`, `sprockets-rails`, `jbuilder`, `web-console`, `minitest` 5.27, `concurrent-ruby` 1.3.4.
- **Sidekiq:** 6.5.12 works with Rails 8.1. In my local runs, a 7.0 worker ran an 8.1-enqueued job and an 8.1 worker ran 7.0-enqueued jobs (`v70-sidekiq-mixed.log`, `v81-sidekiq-mixed.log`). However, Rails 8.1 deprecates its built-in Sidekiq adapter, and 8.2 removes it. Moving to Sidekiq 7.3.3 or later is a separate change with its own risks for this app:
  - redis-client returns an Integer from `sadd`, which breaks the `User#request_digest` duplicate check.
  - It raises on `ExportJob`'s symbol-keyed arguments.
  - It affects the `Redis::BaseError` and `Redis::CannotConnectError` rescues.
- **Optional:** the `concurrent-ruby` 1.3.4 pin only exists for Rails 7.0 and can be lifted after 7.1. Keep the minitest 5 pin.

## Changes to make on 7.0 first (verified on 7.0.8.7 and 7.1.6)

Each item: affected code, the failure, the fix, and what proves it.

1. **`config/initializers/action_text.rb`.** From 7.1, `ActionText::ContentHelper.allowed_tags` starts as nil, so `+=` crashes at boot. Set it in `after_initialize`, inside `on_load(:action_view)`, as the sanitizer's allowed tags plus the attachment tag, figure, figcaption, details and summary. The "collapsible excerpts" test passes on 7.0, on 8.1 with defaults 7.0, and on 8.1 with defaults 8.1 (HTML5 sanitizer).
2. **`Citation::Provider` reads `Rails.application.secrets`** (also used by `with_provider` in `citation_enrichments_controller_test.rb`). Deprecated in 7.1, removed in 7.2.
   - In production, `CitationEnrichmentJob` would raise `NoMethodError` rather than `Provider::Unavailable`. Sidekiq would retry it and the citation would stay "pending". `request_enrichment` refuses to re-queue a pending citation, so readers could never fetch metadata again. The tests do not show this effect.
   - Fix: rename `config/secrets.yml` to `config/citation_provider.yml`, keeping the `.to_json` quoting. Load it with `config.x.citation_provider = config_for(:citation_provider)` and have the provider and test read it from there.
   - The test that checks credentials like `00123` survive a fresh boot still passes. Environment variable names are unchanged, and `secrets.yml` had no `secret_key_base`.
3. **`Note`: `enum status: …, _prefix: true`.** Raises at class load on 8.1. Change to `enum :status, {…}, prefix: true`.
4. **`Note`: `alias_attribute :highlight_color, :color`.** `color` is a store accessor, and 8.1 raises "is not an attribute". Use `alias_method` for both the reader and the writer.
5. **`Export#generate`: `fragments.sum`.** From 7.1 this raises `TypeError` (7.0 already warns). Use `fragments.join`.
6. **`Import#apply`: `return false` inside `transaction`.** On 7.0 this rolls back. From 7.2 (or 7.1 with 7.1 defaults) it commits, so the import and the earlier rows are saved. That breaks the documented "nothing from the batch remains". Use `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`.
7. **`NotesController#index`: `where(notebooks: @notebook)`.** From 7.2 the notebook filter fails with `PG::UndefinedColumn notes.notebooks`. Use `where(notebook: @notebook)`.
8. **`Import#receipt`: `citation[:id]`.** From 7.2 this reads an `id` column that doesn't exist, so the receipt CSV's DOI column comes out blank. Use `citation&.doi`.
9. **`Note#schedule_reminder`: `set(wait_until: reminder_epoch)` with an Integer.** On 8.0 and later, job serialization raises `NoMethodError` (`Integer#utc`), so scheduling a reminder returns a server error. Use `Time.at(reminder_epoch)`.
10. **`config/routes.rb`: `get "/notes", "/journal", to:`.** Deprecated in 8.0, an `ArgumentError` at boot on 8.1. Split it into two `get` lines; the `notes_path` and `journal_path` helpers stay the same.
11. **`notes/index.html.erb`: `form_with(model: nil, …)`.** Raises on 8.0. Remove `model: nil`.
12. **`imports/preview.html.erb`: `@import.annotations.stringify_keys`.** From 8.0, `stringify_keys` on a HashWithIndifferentAccess also stringifies Integer keys, so `annotations[row.line]` finds nothing and annotations silently disappear from the preview. Drop `.stringify_keys`.
13. **`DigestMailer#daily_digest`.** From 7.1, Active Job brings a time back in the zone it was queued in. A digest requested at 23:30 Eastern would then cover and be dated the reader's local day, not the UTC day the UI promises and the Redis reservation uses.
    - Which behaviour you get depends on which Rails version queued the job (`probe-job-args.log`). This is a problem during a mixed-version rollout.
    - Fix: `requested_at = requested_at.in_time_zone("UTC")` in the mailer.
14. **`User#request_digest` passes a BigDecimal.**
    - **Mixed-version risk:** from 7.2, Rails stores it in a new format. A 7.0 worker then fails with `DeserializationError: Serializer … BigDecimalSerializer is not known`. That happens with a mixed fleet or after a rollback, and the tests cannot show it. `DigestJob` does not discard on that error, so Sidekiq retries until the job dies. The day's reservation is already taken, so the reader cannot request again.
    - **Fix:** pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`. This also removes the Sidekiq warning about non-JSON arguments.
    - **Verified:** a 7.0 Sidekiq worker processed an 8.1-queued digest built this way.
15. **`Notebook#daily_note_counts`: `Date.iso8601(day)`.** With 7.2's `postgresql_adapter_decode_dates`, the raw select returns `Date` objects and this raises `TypeError` (`ablate81`). Use `Date.iso8601(day.to_s)`.
16. **`NotebooksController` permits `:slug`.** With 7.1's `raise_on_assign_to_attr_readonly`, every notebook settings save raises `ReadonlyAttributeError` (`ablate81`). Stop permitting `:slug`. The settings test still proves the slug is kept.
17. **`exports/_export.html.erb`: `expires_in: export.expires_at - Time.current`.** This is negative once an export has expired.
    - With 7.1 defaults: `ArgumentError`, so the exports page returns a server error (`ablate81`).
    - With 7.0 defaults on 7.1 or later: the expiry is silently dropped and the fragment is cached with no expiry (`probe_cache.rb`). The tests cannot show this.
    - Fix: `[export.expires_at - Time.current, 1].max`.
18. **`Note#next_day_reminder_at`: `reminder_at.to_time + 86_400`.**
    - **What changes:** on 8.1, `to_time` always keeps the time zone and this can no longer be configured. Across a daylight saving change, the "24 hours later" preview moves from the old offset (09:00 −04:00) to the new one (08:00 −05:00). The postponed time itself is the same.
    - **This needs your decision:** keep the documented behaviour with `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` (what I tested), or accept the new behaviour and update the test and ARCHITECTURE.md.

## Changes that must ship with 7.1 or later (do not land on 7.0)

1. **`serialize :tags, JSON` → `serialize :tags, coder: JSON`,** and `serialize :preferences, coder: YAML`.
   - On 7.0, the `coder:` keyword is silently ignored and YAML is used. That would write YAML into the JSON `tags` column (`probe_coder.rb`).
   - 7.1 deprecates the positional form and 7.2 raises on it.
   - The stored data format is unchanged: JSON stays JSON, YAML stays YAML.
2. **`CitationEnrichmentJob`: `wait: :exponentially_longer` → `:polynomially_longer`.** Same timing formula. Removed in 7.2. Jobs already waiting to retry are unaffected.
3. **`config/environments/test.rb`: `show_exceptions = false` → `:none`.** On 8.1, `false` is treated like "show everything", so the many `assert_raises(RecordNotFound)` tests would get error pages instead. On 7.0, `:none` counts as true and has the same effect.

If you roll back to 7.0, revert these three together with the Gemfile.

## Framework defaults (optional, after the upgrade, one at a time)

All tests pass with `load_defaults 8.1` once both change sets are in. The risk is rollback and stored data:

- **7.1 message format** (`message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`):
  - Attachment IDs signed under these defaults can't be read by 7.0 (`probe-messages.log`, `probe_sgid_v70.rb`). Signed blob IDs and message-verifier tokens fail the same way. Session cookies stayed readable.
  - Action Text stores these attachment IDs inside note bodies. After a rollback, `ActionText::Content#attachables` raises `NoMethodError`, so every note whose body was saved with new-format IDs fails to render.
  - With defaults 7.0 on 8.1, saved IDs stay in the 7.0 format. I confirmed this with a real upload stored in the isolated development database.
  - Enable only once rollback is ruled out. Never switch to strict `:json` without re-signing stored attachment IDs; that last point is from the Rails source, not tested.
- **7.1 `cache_format_version`:** production uses the default file store in `tmp/cache`. Clear it on rollback. Not tested.
- **7.2 `enqueue_after_transaction_commit = :default`** (7.2.x only; 8.0 and later default to false): with Sidekiq this defers enqueues until commit. That breaks the "a failed enqueue rolls back" design in `Citation#request_enrichment` and `Note#schedule_reminder`. If you stop at 7.2 with 7.2 defaults, set it to `:never`.
- **Covered by the changes above:** read-only attribute errors, date decoding, invalid cache expiry, commit on early return, no default column serializer.
- **Low-impact defaults:**
  - HTML5 sanitizer (tests pass; not checked against real stored content).
  - 8.0 `strict_freshness` (the export download test passes).
  - 8.1 hidden-field autocomplete removal, `raise_on_missing_required_finder_order_columns` and `action_on_path_relative_redirect` (no failing usages found).
  - YJIT in production (watch memory).
- **8.1 optional:** set `config.active_storage.variant_processor = :disabled` to silence the boot warning. This option only exists in 8.1.

## Other behaviour changes tests won't show

- **Trix styling:** 8.1 serves Trix 2's `trix.css` (from `action_text-trix`) to the vendored Trix 1.3.5 editor. Possible visual mismatch; not checked.
  - Checked in a headless browser against the 8.1 copy: Trix 1.3.5 loads, `window.ActionText` exists, and a direct upload saved a note with an attachment ID (`r-v81j-server.log`).
- **Time zones** (`tz-v70.txt` vs `tz-v81.txt`): "Asuncion" is new. "Astana" now maps to Asia/Almaty (+05) instead of Asia/Dhaka (+06), so local times for those readers shift by an hour.
  - Run `SELECT count(*) FROM users WHERE time_zone='Astana'` in production.
- **`db/schema.rb`:** the next dump only reorders columns alphabetically and changes the header to `Schema[8.1]` and `pg_catalog.plpgsql`. No column, type or index changes.
- **Development secret:** the development secret file moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`. Copy it, or development sessions and attachment IDs stored in the development database break.
  - Production key lookup is unchanged: `SECRET_KEY_BASE`, then credentials.
- **Export text:** Action Text's `to_plain_text` output was identical on all five versions for a sample with headings, nested and ordered lists, links, quotes and details. Export Markdown is unchanged.
- **Queued jobs:** the Sidekiq wrapper class name and the Active Job payload layout are compatible in both directions. 7.1 adds `scheduled_at`, which 7.0 ignores. Scheduled reminders and pending retries survive the upgrade. In the other direction, an 8.1 worker ran a 7.0-queued `NoteReminderJob`. I did not run a 7.0 worker on an 8.1-queued `NoteReminderJob` (only `DigestJob`).
- **Test isolation:** `bin/rails test` writes digest reservations to the Redis at `REDIS_URL`, by default the local 6379. Isolated runs need their own Redis.

## Rollout sequence

1. Ship the 7.0-compatible changes on 7.0 and update ARCHITECTURE.md. It currently describes the secrets file, the BigDecimal argument, Active Job 7.0's time-zone handling, the `to_time` preview and the `return` rollback. Let any `DigestJob` queued before this drain. Only those carry a BigDecimal, so they matter if a 7.2+ worker might pick them up.
2. Bump to 7.1.6 with the 7.1-only changes and `load_defaults 7.0`. Deploy and confirm the deprecation log is empty.
   - Alternatively jump straight to 8.1, since the 7.0-compatible changes remove the known payload incompatibilities. Stepping is still safer because each step has its own deprecation messages.
3. Continue through 7.2.4, 8.0.5.1, and then 8.1 with the `json` pin, still on `load_defaults 7.0`.
4. Adopt 7.1 → 8.1 defaults one setting at a time, only after the rollback window has closed.

## Checks still proposed

- Run the full suite, `bin/rails zeitwerk:check` (executed on 8.1: green) and `assets:precompile` (executed on 8.1: green) on each step's real branch.
- Browser regression of editing an existing note with an image attachment, plus a visual check of Trix with Trix 2's CSS. System tests were not run: the Selenium setup is non-headless Chrome.
- A staging rollback rehearsal from 8.1 to 7.0: queued, scheduled and retrying jobs, file cache contents, and notes saved after the upgrade.
- Confirm production deploy topology (rolling deploy? separate Sidekiq hosts?), the `SECRET_KEY_BASE` source and the `CITATION_PROVIDER_*` variables.

## Open questions and unverified claims

- Why exactly 8.1.0? 8.1.4 is out, carries later patches, and fixes the `json` problem. I didn't test 8.1.4 itself.
- Not tested:
  - how 7.0 reads 7.1-format cache entries;
  - whether strict `:json` can read 7.0-format attachment IDs;
  - HTML5 sanitizer output on real stored note bodies;
  - Ruby 3.4;
  - long-running Sidekiq 6.5 on 8.1 (only short worker runs);
  - production load.
- Statements about 8.1.4 and about 7.2's `enqueue_after_transaction_commit` come from reading the source, not from runs.

I did the analysis directly rather than through the planner subagent the upgrade skill names, because no subagent tool was available here. All experiment copies, branches and logs are under `/tmp/upg`, starting with `/tmp/upg/prep` and `/tmp/upg/logs/`.

---

**Notes:**

- The plan above is the planner's output, unchanged. Its last paragraph is wrong about how it was made. It was written by the `maintain-rails:gem-upgrade-planner` subagent, which is the one the skill names; it just didn't start another one inside itself.
- I didn't rerun the experiments. I opened the logs and the branches to check the plan's main claims, and they hold up:
  - On 7.0, the unchanged code passes 46 runs, 325 assertions.
  - On 8.1.0 with json 3, the full set of code changes fails at once, all at boot. Every error is `ArgumentError: wrong number of arguments (given 2, expected 1)`.
  - With `json` pinned below 3, the same code passes all 46 runs, 340 assertions, under both `load_defaults 7.0` and `load_defaults 8.1`.
  - The `ablate81` run has 3 errors, as the plan says.
  - One small difference: the json 3 run shows 4 failures as well as the 40 errors.
- `/home/user/workspace/repo` has no uncommitted changes and still pins `gem "rails", "7.0.8.7"`. All experiment material is under `/tmp/upg`.
- Two decisions needed from you before work starts:
  - Stay on exactly 8.1.0 with a `json` pin, or target 8.1.4 or later. Going by its source, 8.1.4 fixes the `json` problem, but no one has run it here.
  - How the "24 hours later" reminder preview should behave across a daylight saving change (item 18).
