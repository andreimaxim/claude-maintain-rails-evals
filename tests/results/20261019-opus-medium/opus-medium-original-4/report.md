# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes (`/home/user/workspace/repo`)

## Verdict

The upgrade to 8.1.0 works, but only with code changes. With the minimum set below, the full suite passes on 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0. Unchanged, the app won't boot on 7.1 or later. Several breaks wouldn't fail any test, and four of them change stored data or job data. The minimum set has three parts:

- **14 preparatory changes** that work on 7.0 today. I ran them on 7.0: green, with no deprecation warnings.
- **4 changes that need Rails 7.1 or later.**
- **One new Gemfile pin for 8.1.0:** `gem "json", "~> 2.7"`.

The safest order is to ship the preparatory changes on 7.0 first, then upgrade with `load_defaults 7.0` kept. Adopt the new framework defaults only when rolling back to 7.0 is no longer an option, because two of them make stored data unreadable by 7.0.

Evidence labels used below:
- **[EXEC]** I ran it, and the log path is given.
- **[SRC]** read from the installed gem source or upstream deprecation messages, not run.
- **[PROPOSED]** a check still to be done.

## 1. Inventory of what the upgrade touches

- **Ruby and gems:** Ruby 3.3.6, which meets 8.1's minimum of 3.2. `rails` is pinned to "7.0.8.7". Other pins: `concurrent-ruby 1.3.4`, `minitest ~> 5.25`, `sidekiq 6.5.12`, `redis 4.8.1`, `puma ~> 5.0` (5.6.9), `rack 2.2.24`, `pg 1.6.0`, `sprockets-rails`, `importmap-rails 2.2.3`, `turbo-rails 2.0.12`.
- **Defaults:** `config.load_defaults 7.0`. There is no `new_framework_defaults*.rb`.
- **Active Job:** `queue_adapter = :sidekiq` in `config/application.rb`, and `:test` in tests.
- **Cache:** no production `cache_store`, so production uses the default file store in `tmp/cache`. The only fragment cache is `app/views/exports/_export.html.erb:26`.
- **Database and storage:** PostgreSQL. Active Storage uses Disk (`storage/`, and `tmp/storage` in tests).
- **Action Text and Trix:** Trix 1.3.5 is vendored and loaded as a classic script (`app/views/layouts/application.html.erb`). The importmap pins `@rails/actiontext` to `actiontext.js`.
- **Settings:** `config/secrets.yml` is read through `Rails.application.secrets`. `config/credentials.yml.enc` exists, but there is no master key, so I couldn't inspect it.
- **Tests:** there are no system tests; `test/system` is empty.
- **Not used:** Active Record encryption (`encrypts`), Kredis, image_processing, and Action Cable channels.

## 2. Experiment setup (all disposable, outside the repo)

- **Root directory:** `/tmp/mn-upgrade-exp`.
- **Copies:** made with `git archive HEAD | tar -x` into `v70`, `v70prep`, `v71`, `v72`, `v80` and `v81`.
- **Isolation:**
  - A private PostgreSQL 15 cluster (`initdb` into `/tmp/mn-upgrade-exp/pg/data`) on socket `/tmp/mn-upgrade-exp/pgsock`, port 55432.
  - A private `redis-server` on 127.0.0.1:56379 with persistence off.
  - In each copy I rewrote `database.yml` with that host and port and gave each copy its own database names (`mn_<variant>_*`). `DATABASE_URL` was unset.
  - Environment: `REDIS_URL=redis://127.0.0.1:56379/0`, `PGHOST` and `PGPORT` set. These are recorded in `/tmp/mn-upgrade-exp/env.sh`.
  - Storage and cache live under each copy's own root.
  - Cross-version probes used the production environment, a shared isolated database `mn_cross`, a generated `SECRET_KEY_BASE`, and a shared file-store cache at `/tmp/mn-upgrade-exp/cross/cache`.
  - I confirmed no `mn_*` databases exist on the shared 5432 cluster. The test digest keys landed in Redis on 56379. The repo's `git status` is still clean. Both private services are now stopped; their data directories are kept.
- **Gems:** each variant has its own `BUNDLE_PATH` (`/tmp/mn-upgrade-exp/gems/<variant>`), resolved with `bundle lock --update rails`. Lockfiles are in each copy's `Gemfile.lock`; logs are `logs/<v>-bundle.log`.
  - **Rails versions resolved:** 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0.
  - **Unchanged everywhere:** sidekiq 6.5.12, puma 5.6.9, rack 2.2.24, minitest 5.27.0, concurrent-ruby 1.3.4, redis 4.8.1.
  - **New in 8.1.0:** `action_text-trix 2.1.19`, plus `json 3.1.0`, which breaks the app (finding R1). `bigdecimal 4.1.3` arrives from 7.1 on.
- **Scripts:**
  - `/tmp/mn-upgrade-exp/scripts/apply_prep.sh` and `prep_edits.rb` apply the preparatory changes.
  - `apply_hop71.sh` applies the 7.1-only changes.
  - `action_text_initializer.rb` is the replacement initializer.
  - `probe_messages.rb`, `probe_jobs.rb` and `probe_models.rb` are the cross-version probes.
- **Default variants:** in `/tmp/mn-upgrade-exp/v81` (git history inside the copy), `config/application.rb` reads `load_defaults` from `PROBE_LOAD_DEFAULTS` and the message serializer from `PROBE_MSG_SERIALIZER`, so every result can be traced to the exact defaults it ran with.

Test results (logs under `/tmp/mn-upgrade-exp/logs/`):

| Variant | Result | Log |
|---|---|---|
| 7.0 baseline | 46 runs, 0 failures | `v70-test.log` |
| 7.0 + preparatory changes | 46 runs, 0 failures, no deprecations | `v70prep-test-patched.log`, `v70prep-test-slugfix-defaults7.0.log` |
| 7.1–8.1, app unchanged | cannot boot (`ActionText::ContentHelper.allowed_tags` is nil) | `v7x/v8x-test-unchanged.log` |
| 7.1, Action Text fix only | 1 failure, 3 errors, 10 deprecation kinds | `v71-test-p1.log` |
| 7.1 / 7.2 / 8.0 / 8.1 + all changes (+ json pin on 8.1), `load_defaults 7.0` | all green | `v7x/v8x-test-patched.log` |
| 8.1 + all changes, `load_defaults` 7.1 / 7.2 / 8.0 / 8.1 | 1 error each (read-only `slug`), green after finding O1 | `v81-test-defaults-*.log`, `v81-test-slugfix-defaults8.1.log` |

`zeitwerk:check`, a production boot, `assets:precompile` and a Puma 5 dev boot all pass on 8.1 (`v81-boot-checks.log`, `v81-server.log`).

The 7.1 and 7.2 runs used an earlier version of the `next_day_reminder_at` fix (`to_time.getlocal`); the 7.0, 8.0 and 8.1 runs used the final version.

## 3. Required changes

**Preparatory changes (P1–P14) work on both 7.0.8.7 and 8.1.0.** I applied all of them to 7.0 and the suite was green with no deprecations. Ship them first, on 7.0.

| # | Affected code | Applies at | Problem | Recommendation | Evidence / validation |
|---|---|---|---|---|---|
| P1 | `config/initializers/action_text.rb` | 7.1+ | `allowed_tags` defaults to nil, so `+=` raises `NoMethodError` at boot | Set it explicitly in `after_initialize` to `sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]` (see `scripts/action_text_initializer.rb`) | [EXEC] boot failure; "keeps collapsible excerpts" test passes on 7.0 and 8.1 under 7.0 and 8.1 defaults. Probe: same sanitized output under the HTML4 and HTML5 sanitizers (`probe-models.log`) |
| P2 | `app/models/export.rb:42` `fragments.sum` | 7.1 | Rails' `Enumerable#sum` override was removed; Ruby's `sum` on strings raises `TypeError`, so every export fails in the worker | `fragments.join` | [EXEC] 3 errors on 7.1 |
| P3 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb` | deprecated 7.1, removed 7.2 | `Rails.application.secrets` no longer exists | Add `config/citation_provider.yml` (same ERB and `.to_json` quoting, no top-level key). Set `config.x.citation_provider = config_for(:citation_provider)` in `application.rb`. Default the provider to `Rails.configuration.x.citation_provider.to_h`. Point the test's override at `config.x` | [EXEC] the "credentials from the environment reach the server unchanged" test (values `00123` and `sample: value # keep`) passes on 7.0 and 8.1. See open question Q1 about `secret_key_base` |
| P4 | `app/models/note.rb:10` `enum status: …, _prefix: true` | deprecated 7.2, removed 8.0 | The keyword form of `enum` goes away | `enum :status, { draft: 0, ready: 1 }, prefix: true` | [SRC], upstream 7.2 and 8.0 notes; I applied it before running 7.2, so the failure itself wasn't seen. Suite is green |
| P5 | `app/models/note.rb:14` `alias_attribute :highlight_color, :color` | deprecated 7.1, raises 7.2+ | `color` is a `store_accessor`, not an attribute | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | [EXEC] 8.1 raises `ArgumentError` (`probe-models.log`); 7.1 prints the deprecation |
| P6 | `app/models/note.rb:61` `set(wait_until: reminder_epoch)` | deprecated 7.1, breaks 7.2 | 7.2 serializes `scheduled_at.utc.iso8601`, which fails on an Integer | `wait_until: Time.at(reminder_epoch)` | [EXEC] 7.1 deprecation; [SRC] `activejob-7.2.4/lib/active_job/core.rb:120,167`. Reminder tests assert the exact `at` |
| P7 | `app/models/import.rb:68` `citation[:id]` | 7.1 deprecation, nil on 7.2+ | `citations` uses `doi` as its primary key; on 8.1 `[:id]` returns nil, so the receipt CSV silently loses its DOI column | `citation&.doi` | [EXEC] 8.1 returns `[nil, "10.1000/models"]`; the import test checks the receipt body |
| P8 | `app/models/import.rb:53-57` `return false` inside `transaction` | 7.2 | A non-local exit now commits, so a failed row leaves a partial import (the import plus earlier notes). That breaks the "saves nothing" contract | `raise ActiveRecord::Rollback unless row.note.save`, plus a `saved` flag set at the end of the block | [EXEC] the probe commits on 8.1 and rolls back on 7.0; "applying them saves nothing" test |
| P9 | `app/controllers/notes_controller.rb:12` `where(notebooks: @notebook)` | 7.1 deprecation, removed 7.2 | Refers to the singular association by its plural name | `where(notebook: @notebook)` | [EXEC] 7.1 deprecation; filter test passes |
| P10 | `app/models/user.rb:41` passes a BigDecimal to `DigestJob` | 7.1 deprecation; 7.2+ always uses `BigDecimalSerializer` | 7.0 workers can't read the new payload | Pass `reading_completion.to_s`; `DigestMailer` already calls `BigDecimal(...)` | [EXEC] `probe-jobs.log`: an 8.1 BigDecimal payload on 7.0 fails with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`; the string form works both ways |
| P11 | `app/mailers/digest_mailer.rb:7` | 7.1, with no config change | The TimeWithZone serializer now keeps the zone (`"time_zone": "America/New_York"`). The digest would cover the reader's local day instead of the UTC day, which contradicts the UTC reservation key, the UI hint and `ARCHITECTURE.md` | `requested_at = requested_at.in_time_zone("UTC")` in the mailer, which handles 7.0- and 8.1-written payloads alike | [EXEC] digest test fails on 7.1 ("October 04" instead of "October 05"); probe shows 7.0 payloads come back as UTC and 8.1 payloads as EDT on 8.1 |
| P12 | `app/views/imports/preview.html.erb:22` `.stringify_keys` | 8.0 | `HashWithIndifferentAccess#stringify_keys` now turns Integer line keys into strings, so annotations silently disappear from the preview | Use `@import.annotations` without `stringify_keys` | [EXEC] 2 failures on 8.0 |
| P13 | `app/views/notes/index.html.erb:12` `form_with(model: nil, …)` | deprecated 7.2, raises 8.0 | — | Drop `model: nil` | [EXEC] |
| P14 | `config/routes.rb:18` `get "/notes", "/journal", to:` | deprecated 8.0, removed 8.1 | On 8.1 the whole route file fails to load | Two separate `get` lines; `journal_path` is still generated | [EXEC] all 46 tests error on 8.1 |
| P15 | `app/models/note.rb:44` `reminder_at.to_time + 86_400` | `:zone` behavior is always on in 8.1 | Only the "24 hours later" preview text changes across a DST switch; the stored epoch is the same either way | To keep the documented fixed-offset preview: `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. Otherwise accept the zone-aware display and update the test and docs (a product decision) | [EXEC] reminder test (`-04:00`) passes on 7.0, 8.0 and 8.1 with this change |

P15 is listed with the preparatory changes because it also works on 7.0, but it's a display decision rather than a break; P1–P14 are the minimum.

Two more changes are needed for the upgrade to be correct in production, even though no test fails without them:

- **P16 – Negative cache expiry.** `app/views/exports/_export.html.erb:26` sets `expires_in: export.expires_at - Time.current`, which is negative once an export expires. Under the 7.1 default `raise_on_invalid_cache_expiration_time` this raises, and the exports page returns a 500. Production has caching on; tests run with `null_store`, except one test.
  - Fix: `[export.expires_at - Time.current, 1.second].max`.
  - Evidence: [EXEC] with the original partial on 8.1 with 7.1 defaults: "Cache expiration time is invalid, cannot be negative: -60.0" (`v81-exports-origpartial-7.1.log`). With 7.0 defaults it passes.
- **O1 – Read-only slug.** `NotebooksController#notebook_params` permits `:slug`, and the form resubmits it. Under the 7.1 default `raise_on_assign_to_attr_readonly`, every notebook settings save raises `ReadonlyAttributeError`.
  - Fix: drop `:slug` from `permit` and keep the hidden field.
  - Evidence: [EXEC] green on 7.0 and on 8.1 with 8.1 defaults.
  - Strictly this is only needed before adopting the 7.1 defaults, but it's free to do now.

**Changes that need Rails 7.1 or later.** Land these in the same commit as the 7.1 bump. Not one of them is safe on 7.0:

- **H1 – `show_exceptions`.** In `config/environments/test.rb`, change `show_exceptions = false` to `:none`.
  - 7.1 deprecates `false`. In 7.2, `false` is treated as `:all`, so every `assert_raises(RecordNotFound)` test would break ([SRC] `exception_wrapper.rb:179-191`).
  - On 7.0, `:none` counts as truthy and would also break those tests (not executed; inferred from the 7.0 boolean check).
- **H2 – `serialize :tags`.** In `app/models/note.rb`, change `serialize :tags, JSON` to `serialize :tags, coder: JSON`.
  - The positional form raises `ArgumentError` on 7.2 ([SRC]).
  - **Do not deploy this on 7.0.** [EXEC]: on 7.0 the `coder:` keyword is silently ignored and the column is written as **YAML** (`"---\n- a<b\n…"`), which corrupts the JSON data.
- **H3 – `serialize :preferences`.** In `app/models/notebook.rb`, change `serialize :preferences` to `serialize :preferences, coder: YAML`.
  - Without it, `load_defaults` 7.1+ raises "missing keyword: :coder" ([EXEC]).
  - The stored YAML is byte-identical on 7.0 and 8.1 ([EXEC]).
- **H4 – Retry wait.** In `app/jobs/citation_enrichment_job.rb`, change `wait: :exponentially_longer` to `:polynomially_longer`.
  - On 7.2+, the old value raises "Couldn't determine a delay" on the first `Unavailable`. The final `fail_enrichment` then never runs, the citation stays pending forever, and the reader gets "already being fetched" ([SRC] `exceptions.rb:162-181`).
  - `:polynomially_longer` doesn't exist on 7.0.

**Dependencies:**

- **R1 – Pin `json`.** Add `gem "json", "~> 2.7"`; it resolved to 2.21.2. activesupport 8.1.0 depends on `json >= 0` and calls `JSON.parse(source, options)` with a positional hash. json 3.x (resolved: 3.1.0) accepts keyword arguments only. Every session decode then raises `ArgumentError`, and 46 of 46 tests error ([EXEC] `v81-test-patched` run before the pin). Whether 8.1.4 fixes this is unverified. This is a new Gemfile constraint, so it needs your approval per CLAUDE.md.
- **R2 – Keep the other pins.** Keep `minitest ~> 5.25` (8.1.0 passes with it). Keep `concurrent-ruby 1.3.4`, which can be relaxed after 7.1 (optional). Sidekiq 6.5, puma 5 and rack 2.2 all resolve and work.
  - Rails 8.1's built-in Sidekiq adapter is deprecated and will be removed in 8.2 ([EXEC] dev boot: `v81-dev-adapter.log`). That means a later Sidekiq 7.3.3+ upgrade, which isn't needed now.
  - `ExportJob` already gets a strict-args warning (symbol keys), which matters for that later upgrade.

**Hop-by-hop expectations (with P1–P16, O1, H1–H4 and R1 applied):** 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0 are each green. The remaining 8.0 boot-time deprecation (`to_time_preserves_timezone`) goes away if you set `config.active_support.to_time_preserves_timezone = :zone` on 8.0. Remove that line again on 8.1, where setting it is deprecated ([SRC] `activesupport-8.1.0/lib/active_support.rb:124-136`).

## 4. Optional default adoption (separate from the upgrade)

[EXEC] on 8.1 with `load_defaults` 7.1, 7.2, 8.0 and 8.1, after P1–P16, O1 and H1–H4: the only test failure is the `slug` one (O1).

**Safe once O1 and P16 are in:**
- 7.1: `raise_on_assign_to_attr_readonly`, `raise_on_invalid_cache_expiration_time`, `default_column_serializer = nil` (needs H3), the HTML5 sanitizers (same output in the probe).
- 7.2: `postgresql_adapter_decode_dates`. Raw `select_rows` then returns `Date` ([EXEC]); the P-change at `app/models/notebook.rb:40` handles both forms.
- 8.0: `strict_freshness` (export download ETag tests pass), `Regexp.timeout = 1`.
- 8.1: `escape_js_separators_in_json = false`. This changes the stored text of `notes.tags` for U+2028 and U+2029 only ([EXEC]); both versions can read either form.
- Ops impact: `yjit` adds memory use in production.

**One-way doors.** Adopt these only after you've committed to never rolling back below 7.1:
- `active_support.message_serializer = :json_allow_marshal` together with `use_message_serializer_for_metadata = true`:
  - [EXEC]: 7.0 can't read data written under 8.1 defaults. `GlobalID::Locator.locate_signed`, `Blob.find_signed` and the Action Text render all **raise** `NoMethodError: undefined method 'unpack1' for nil`.
  - So after a rollback, any note whose rich text got an attachment after the flip returns a 500.
  - 8.1 reads 7.0-written artifacts fine.
- `cache_format_version = 7.1`: [EXEC] 7.0 reading a 7.1-format file-store entry raises `TypeError: incompatible marshal file format`. It raises rather than returning a miss.
- **Never switch to `message_serializer = :json` unless you rewrite stored rich-text bodies.** [EXEC]: the signed IDs written under 7.0 that are stored inside `action_text_rich_texts.body` fail with "Unsupported serialization format", and the render raises.
- Session cookies are not a concern: `cookies_serializer = :json` was already part of the 7.0 defaults, and sessions decode both ways under every variant tested ([EXEC]).

**Not adopted:** `enqueue_after_transaction_commit` stays false on 7.2.4, 8.0 and 8.1 ([SRC] / [EXEC] prints `false`). Turning it on would break the "failed enqueue rolls back" design in `Citation#request_enrichment` and `Note#schedule_reminder`; leave it off.

## 5. Rollout, mixed versions and rollback

1. **Ship P1–P16 and O1 on 7.0.** All are safe on 7.0, and P10 and P11 make job payloads version-neutral. Let jobs that 7.0 queued earlier drain, or accept them: [EXEC] 7.0 payloads, including far-future scheduled `NoteReminderJob`s, Integer `at` values, BigDecimal-as-string and retry metadata, all deserialize on 8.1. The wrapper class `ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper` is unchanged.
2. **Upgrade Rails in a branch, one hop at a time** (7.1.6 → 7.2.4 → 8.0.x → 8.1.0), each with zero deprecations in dev and test. Production has `report_deprecations = false`, so look at staging logs.
   - Ship H1–H4 with the 7.1 commit.
   - Ship R1 with 8.1.
   - Keep `load_defaults 7.0` throughout.
   - Production can take each hop or jump straight to 8.1. [EXEC] shows 8.1 under 7.0 defaults and 7.0 interoperate both ways on sessions, sgids, signed blob IDs, the cache and jobs (`probe-messages.log`, `probe-jobs.log`).
3. **Mixed web and worker versions are safe once step 1 is deployed.** Without P10, a web server on 7.2+ enqueuing to 7.0 workers fails digests. With P11, either worker produces the same UTC-day digest.
4. **Rollback:**
   - Revert the code. No database migrations are needed for the upgrade (source-based: no framework tables change; `app:update` not run).
   - Under 8.1, `db/schema.rb` is written as `Schema[8.1]`, uses `pg_catalog.plpgsql` and sorts columns alphabetically ([EXEC] `logs/v81-schema.diff`). 7.0 can't load that file, so revert it together with the code.
   - Development secrets move from `tmp/development_secret.txt` to `tmp/local_secret.txt`, which resets dev sessions only ([SRC]).
   - Parallel test databases are now named `_0` instead of `-0` ([EXEC]); this matters if CI creates them in advance.
5. **After rollback is ruled out:** add the new framework defaults, ideally via `new_framework_defaults_*.rb`. Flip the one-way doors last, and clear `tmp/cache` if a rollback ever happens after them.

## 6. Proposed checks not yet run

- **Browser check (no system tests exist; no Chrome was available).** On 8.1, check that the Trix 1.3.5 editor plus `actiontext.js` loads saved rich text with links and attachments, that direct uploads still attach, and that the 1 MB attachment error shows.
  - 8.1's `actiontext.js` is now a UMD bundle; it is served and has the `trix-attachment-add` handler ([EXEC]).
  - Consider pinning `actiontext.esm.js`, and separately moving to the Trix 2 that `action_text-trix` ships. That second change also needs a browser check of how stored HTML loads.
- **Staging soak:** a Sidekiq 6.5.12 worker on 8.1 actually performing `NoteReminderJob`, `DigestJob`, `CitationEnrichmentJob` retries and `ExportJob` from 7.0-enqueued Redis entries. My checks covered deserialization only.
- **`to_plain_text` for real data:** the export Markdown was unchanged for my sample HTML (lists, nested lists, blockquotes, headings, captions). Diff a production-like sample to be sure.
- **Re-run the suite on 8.1.4**, the latest 8.1 patch (2026-09-24), to see whether the json pin is still needed. Decide whether "8.1.0 exact" is a hard requirement.

## 7. Open questions and unverified claims

- **Q1 (important):** where does production's `secret_key_base` come from? If a deploy step overwrites `config/secrets.yml` with a `secret_key_base`, removing secrets on 7.2 changes the key. That would invalidate every session, every signed blob URL, and every attachment sgid stored in rich text. Check `Rails.application.secret_key_base` in production against `ENV`/credentials before 7.2.
- **Production cache store and job queue:** is the production cache store really the default `tmp/cache`, and is that directory shared across releases? How deep is Sidekiq's scheduled set (pending reminders)?
- **Unverified by execution:** that the keyword `enum` form fails on 8.0 (P4) and the exact 7.2 behavior of the plural-association `where` (P9). Both were fixed before those versions ran.
- **Docs to update with the changes:**
  - `ARCHITECTURE.md` lines 79–84 (secrets, retry wording), 169–173 (Active Job 7.0 zone behavior) and 188–212 (Rails version, Trix rationale).
  - `CONTRIBUTING.md:38` (secrets.yml).
  - `TESTING.md:54` (minitest note).
  - `README.md:7`.
  - `docs/references/fizzy.md:20`.
  - The Trix comment in `app/views/layouts/application.html.erb`.

---

**My notes on the plan:**

- **This is a plan only; nothing in your app has been changed.** The upgrade skill is limited to planning. I checked that `git status` is clean and that the logs the plan cites are in `/tmp/mn-upgrade-exp/logs/`. I haven't re-run any of the planner's experiments.
- **In short:** this is a four-version jump (7.0 → 7.1 → 7.2 → 8.0 → 8.1), not a version bump. Changing the Gemfile line on its own leaves an app that won't boot. There are also several silent data and job problems that no test catches: P7, P8, P10, P11, P16 and H2.
- **Decisions I need from you before implementing:**
  1. **The `json` pin (R1):** may I add `gem "json", "~> 2.7"`? CLAUDE.md requires your approval for dependency changes. Otherwise, would you accept 8.1.4 instead of exactly 8.1.0, if that makes the pin unnecessary?
  2. **Reminder preview across daylight-saving changes (P15):** keep the current fixed-offset text, or switch to zone-aware display?
  3. **`secret_key_base` in production (Q1):** where does it come from? This needs an answer before the 7.2 step.
  4. **Delivery:** do you want the preparatory changes (P1–P16, O1) shipped separately on 7.0 first, as the plan recommends?
