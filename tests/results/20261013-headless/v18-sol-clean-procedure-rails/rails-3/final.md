# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible. I found 20 changes this app needs, all tested in disposable copies. With every repair applied, the test suite passes on each release (46 runs, 0 failures on 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0). Without repairs, every release from 7.1.6 on fails to boot, and from 7.2.4 on, data and behaviour break silently in ways the tests only partly catch.

**What was run:** the gem is `rails`, Ruby 3.3.6, PostgreSQL, Sidekiq 6.5.12 on Redis 4.8.1, test command `bin/rails test`. The application at `/home/user/workspace/repo` was not modified (`git status` is clean).

**Copies used:** each copy is a separate app checkout with its own private PostgreSQL, Redis and disk storage:
- `r*` = plain upgrade, no changes
- `b*` = only the Action Text fix
- `u*` = only the changes needed to boot
- `f*` = all repairs
- `prep` = repairs that also work on 7.0.8.7
- `d8_1_0` = all repairs plus `load_defaults 8.1`

Every result cited below has a log under `/tmp/tmp.RaxHFSCVby/lab/runs/<run>/` and the resolved `Gemfile.lock` in that copy. "Executed" means a probe or test actually ran; "source-based" means I read the framework code; "proposed" means not run.

**Setup gap:** the lab tool skips `vendor/`, which holds the app's `vendor/javascript/trix-1.3.5.js`. That alone failed 29 tests on the unchanged 7.0.8.7 copy. I copied the tracked vendor files into every copy (`/tmp/tmp.RaxHFSCVby/fixvendor.sh`). It is not an upgrade problem.

## 1. Required changes

"Prep" means the repair also passes on 7.0.8.7 (copy `prep`: 46 runs, 0 failures; run `212420`), so it can ship before the version bump. All repairs are in `/tmp/tmp.RaxHFSCVby/repairs/` and `/tmp/tmp.RaxHFSCVby/repairs.diff`.

**F1 – Action Text tag allowlist breaks boot (7.1.6; C141)**
- **Where:** `config/initializers/action_text.rb` does `ActionText::ContentHelper.allowed_tags += %w[details summary]`.
- **Consequence:** from 7.1, `allowed_tags` starts as nil, so 7.1.6 through 8.1.0 crash with ``undefined method `+' for nil (NoMethodError)``. Prepare, boot, eager load, routes and tests all fail (runs `211324`, `211346`, `211408`, `211429`).
- **Repair (prep):** in `after_initialize` / `on_load(:action_view)`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]).to_a | %w[details summary]`. This keeps the safe defaults and the attachment markup.
- **Validation (executed):** the test "rich text keeps collapsible excerpts and drops unsafe markup" passes on every repaired copy.

**F2 – Markdown export crashes (7.1.6; C470)**
- **Where:** `app/models/export.rb#generate` uses `fragments.sum`, called from `ExportJob`.
- **Consequence:** already a deprecation warning on 7.0.8.7; on 7.1.6 every export fails with `TypeError: String can't be coerced into Integer`.
- **Repair (prep):** `fragments.join`.
- **Validation (executed):** probe `export_markdown` produces exactly `"# Export probe\n\n## First\n\nOne\n\n## Second\n"`; control, an empty notebook, produces `"# Empty probe\n"`. Passes on all repaired copies, fails on all `u*` copies.

**F3 – Daily digest covers the wrong day (7.0.10; C4)**
- **Where:** `User#request_digest` passes a time in the reader's zone to `DigestJob`, and `DigestMailer#daily_digest` then uses `requested_at.to_date` and `.all_day`.
- **Consequence:** 7.0.9+ keeps the time zone when a job reads that time back. A reader in Auckland at 12:00 UTC on 4 October gets "Your reading digest for October 05, 2026" instead of October 04 (copy `r7_0_10`, run `211242`; probe on `u7_1_6` through `u8_1_0`).
- **Repair (prep):** in `DigestMailer`, `requested_at = requested_at.in_time_zone("UTC")`. The repair is on the mailer side, so jobs already queued by either version are handled.
- **Validation (executed):** probe `digest_timezone`, Auckland reader vs UTC reader (control). It passes on the repaired 8.1 copy (run `214336`), including reading jobs queued by every other copy.

**F4 – `serialize :tags, JSON` no longer accepted (deprecated 7.1, removed 7.2.4; C385/C922)**
- **Where:** `app/models/note.rb`.
- **Consequence:** eager load fails on 7.2.4 with `wrong number of arguments (given 2, expected 1)` (run `212024`).
- **Repair (gated to 7.1, since 7.0 lacks the keyword):** `serialize :tags, coder: JSON`.
- **Validation (executed):** probe `tags_format` reads tags written as JSON text by 7.0 and writes `'["a","b"]'`; control is an empty list. Passes on every copy.

**F5 – keyword-style `enum` removed (deprecated 7.2, removed 8.0; C870/C1268)**
- **Where:** `app/models/note.rb` has `enum status: {...}, _prefix: true`.
- **Consequence:** on 8.0.5.1 and 8.1.0: `wrong number of arguments (given 0, expected 1..2)` (runs `212047`, `212109`).
- **Repair (prep):** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Validation (executed):** probe `enum_status` checks statuses, `status_ready?` / `status_draft?` and the `status_ready` scope.

**F6 – `alias_attribute` to a store accessor (raises from 7.2.4; C279/C917)**
- **Where:** `app/models/note.rb` has `alias_attribute :highlight_color, :color`; it is used by `notes#create/update` params and the views.
- **Consequence:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute` on 7.2.4 (run `212754`).
- **Repair (prep):** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Validation (executed):** probe `highlight_alias`: assigning green stores `{"color"=>"green"}`; control is a colour set directly plus an invalid colour being rejected.

**F7 – `Rails.application.secrets` removed (deprecated 7.1, removed 7.2.4; C534/C1012)**
- **Where:** `app/models/citation/provider.rb` and `test/controllers/citation_enrichments_controller_test.rb`.
- **Consequence:** ``undefined method `secrets'`` for every citation lookup (copies `u7_2_4` through `u8_1_0`).
- **Repair (prep):**
  - Rename `config/secrets.yml` to `config/citation_provider.yml` with flat per-environment keys.
  - In `config/application.rb`: `config.x.citation_provider = config_for(:citation_provider)`.
  - The provider defaults to `Rails.configuration.x.citation_provider.to_h`.
  - Update the three references in the test.
- **Validation (executed):** probe `citation_config` reads the URL and user from the environment; control: explicit settings still win. The "credentials … reach the server unchanged" test passes in a fresh process.

**F8 – import receipt loses the DOI (7.2.4; C277/C915)**
- **Where:** `Import#receipt` uses `citation[:id]`; citations' primary key is `doi`.
- **Consequence:** the receipt shows `[["Cited", nil], ["Uncited", nil]]` (probe on `u7_2_4`, `u8_0_5_1`, `u8_1_0`).
- **Repair (prep):** `citation&.doi`.
- **Validation (executed):** probe `import_receipt`; the uncited row stays blank (control).

**F9 – failed imports partly save (7.2.4; C269/C913/C1265)**
- **Where:** `Import#apply` uses `return false` inside `transaction`.
- **Consequence:** on 7.0 and 7.1 the block is rolled back; from 7.2.4 it commits. An import with one invalid row returns false but saves `[imports, notes] delta: [1, 1]` (probe on `u7_2_4`, `u8_0_5_1`, `u8_1_0`). The 7.1.6 deprecation said "In Rails 7.2 this transaction will be committed instead."
- **Repair (prep):** `raise ActiveRecord::Rollback unless row.note.save`, with the block returning `true` and `|| false` after it.
- **Validation (executed):** probe `import_apply`: delta `[0, 0]` when one row is invalid; control: two valid rows give `[1, 2]`.

**F10 – notebook filter on the notes list returns 500 (7.2.4; C914)**
- **Where:** `NotesController#index` uses `where(notebooks: @notebook)` (plural association name).
- **Consequence:** filtering by notebook returns status 500 (probe `notes_filter` on `u7_2_4` through `u8_1_0`).
- **Repair (prep):** `where(notebook: @notebook)`.
- **Validation (executed):** filtering by Alpha shows only Alpha's note; control: unfiltered shows both.

**F11 – scheduling a reminder returns 500 (7.2.4; C581/C830)**
- **Where:** `Note#schedule_reminder` calls `set(wait_until: reminder_epoch)` with an Integer.
- **Consequence:** ``NoMethodError: undefined method `utc' for an instance of Integer``; the reminder controller returns 500.
- **Repair (prep):** `wait_until: Time.at(reminder_epoch)`.
- **Validation (executed):** probe `reminder_schedule` with two different future times; both are enqueued at exactly that time. Probe `sidekiq_adapter` lands it in Sidekiq's scheduled set at the same time on the real Redis.

**F12 – citation retries crash (7.2.4; C580/C828)**
- **Where:** `CitationEnrichmentJob` uses `retry_on … wait: :exponentially_longer`.
- **Consequence:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer` (run `214720`).
- **Repair (gated to 7.1):** `:polynomially_longer` (same formula).
- **Validation (executed):** the first retry is 3.01–3.14 s later on every repaired copy; control: the third attempt records "failed".

**F13 – test config `show_exceptions = false` (7.2.4; C94/C803)**
- **Where:** `config/environments/test.rb`.
- **Consequence:** about 10 tests that expect `RecordNotFound` to be raised fail ("expected but nothing was raised").
- **Repair (gated to 7.1, since `:none` is truthy on 7.0):** `config.action_dispatch.show_exceptions = :none`.
- **Validation (executed):** suite green on `f7_2_4` and later.

**F14 – digest job argument format breaks rollback (removed 7.2; C178/C829)**
- **Where:** `DigestJob.perform_later(…, reading_completion)` passes a BigDecimal.
- **Consequence:** 7.2+ writes BigDecimal job arguments in a new format. 7.0.8.7 workers cannot read those jobs: `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (runs `214425`, `214432`).
- **Repair (prep):** pass `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`.
- **Validation (executed):** probe `digest_completion` shows "50% of your notes" when reading jobs from every copy in both directions (run `214338`).

**F15 – import preview drops annotations (8.0; C1273)**
- **Where:** `app/views/imports/preview.html.erb` uses `@import.annotations.stringify_keys` and then looks up by Integer line number.
- **Consequence:** 8.0 now stringifies Integer keys, so annotations disappear from the preview (`u8_0_5_1`, `u8_1_0`; also test `imports_controller_test.rb:22`).
- **Repair (prep):** drop `.stringify_keys`.
- **Validation (executed):** line 2 shows "Read twice probe"; control: line 3 has no annotation.

**F16 – route with two paths rejected (deprecated 8.0, removed 8.1.0; C1168/C1392)**
- **Where:** `config/routes.rb` has `get "/notes", "/journal", to: "notes#index"`.
- **Consequence:** the routes check fails with `Wrong number of arguments (expect 1, got 2)` (run `212109`).
- **Repair (prep):** two `get` lines; the `notes` and `journal` route names are unchanged.
- **Validation (executed):** `/notes` and `/journal` both return 200; control: `/notes/new` returns 200.

**F17 – notes list returns 500 (8.0; C817/C1258)**
- **Where:** `app/views/notes/index.html.erb` uses `form_with(model: nil, …)`.
- **Consequence:** the notes list, and the redirect after sign-in, return 500.
- **Repair (prep):** `form_with(url: notes_path, …)`.
- **Validation (executed):** probe `search_form` keeps the unscoped `name="query"` and the submitted value.

**F18 – "remind me a day later" shows a different time across clock changes (8.1.0; C1225/C1541)**
- **Where:** `Note#next_day_reminder_at` uses `reminder_at.to_time + 86_400`.
- **Consequence:** 8.0.5.1 only warns at boot. On 8.1.0 the result keeps the zone instead of the offset: `"2026-10-25T08:00:00+00:00"` where the documented behaviour (and the comment in the code) gives `"…09:00:00+01:00"`.
- **Repair (prep):** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.
- **Validation (executed):** a date across the change and a control date both give `+01:00` and exactly 86 400 seconds.

**F19 – activity report breaks if date decoding is turned on (D30; C939)**
- **Where:** `Notebook#daily_note_counts` uses `Date.iso8601(day)` on a raw select.
- **Consequence:** only when the PostgreSQL date-decoding default is enabled: `TypeError: no implicit conversion of Date into String` (`d8_1_0`, run `214934`).
- **Repair (prep):** `day.to_date`, which works whether the database returns a String or a Date.
- **Validation (executed):** passes with decoding on and off.

**F20 – Active Support 8.1.0 is incompatible with `json` 3.x (8.1.0; dependency movement)**
- **Where:** `Gemfile` / `Gemfile.lock`.
- **Consequence:** the plain upgrade resolves `json 3.1.0`. Active Support 8.1.0 still calls `JSON.parse(json, options)`, which `json` 3.x rejects, so every session cookie read fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`: 4 failures and 40 errors (run `212253`).
- **Repair:** `gem "json", "< 3"`, which resolves 2.21.2.
- **Validation (executed):** `f8_1_0` is green (run `212600`).

**F21 – Rails' built-in Sidekiq adapter deprecated (8.1; C1424)**
- **Consequence:** it still works with Sidekiq 6.5.12 (the probe enqueues, schedules and runs real jobs on 8.1). It logs "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2."
- **Plan:** keep Sidekiq 6.5.12 for this upgrade. Moving to Sidekiq ≥ 7.3.3 is a separate task: it brings a different Redis client and changes how `Sidekiq.redis`, `sadd` and `Redis::BaseError` behave.

## 2. Optional defaults

Nothing is set explicitly; the app loads `load_defaults 7.0`. Values below were measured on the repaired 8.1 copy (old) and the `load_defaults 8.1` copy (new) with probe `defaults_probe`.

**Defaults that need a change in this app first.** With all four applied, `d8_1_0` passes 46/46 (run `214839`), and they also pass on 7.0.8.7 (copy `pd`, run `214955`):

| Setting | Old → new | Effect in this app | Preparatory repair |
|---|---|---|---|
| D18 `default_column_serializer` | YAMLColumn → nil | `missing keyword: :coder` at eager load (`Notebook serialize :preferences`) | `serialize :preferences, coder: YAML`; stored YAML reads the same on every copy |
| D14 `raise_on_assign_to_attr_readonly` | false → true | `ActiveRecord::ReadonlyAttributeError: slug` on notebook update | stop permitting `:slug` in `NotebooksController#notebook_params` |
| D9 `raise_on_invalid_cache_expiration_time` | false → true | `Cache expiration time is invalid, cannot be negative: -60.0` in `exports/_export.html.erb` | `expires_in: [expires_at - Time.current, 1.second].max` |
| D30 `postgresql_adapter_decode_dates` | String → Date | F19 | F19 |

**Defaults that need care at rollout:**
- **D11 / D12 message serializer** (`:marshal` → `:json_allow_marshal`) and **D19** marshalling format (6.1 → 7.1); cache format 7.0 → 7.1. Enable these only after the 8.1 deploy is final: a rolled-back 7.0 cannot read data written in the new formats. This is source-based (from the upgrade guide).
- **D27 enqueue after transaction commit:** effective `:never` / false on 7.2.4 through 8.1.0. Leave it off. If it is turned on, a failed enqueue leaves the citation stuck in "pending" (executed: `["Redis::CannotConnectError: queue refused", "pending"]`). The current code relies on the enqueue happening inside the row lock.

**Defaults with no consequence observed here:**
- **D33 strict freshness:** downloads gave the same 200/304 results either way (executed).
- **D32 `to_time`:** made moot by F18.
- **D23/D24 HTML5 sanitizer:** suite green under `d8_1_0`.
- **D5, D17, D20, D22:** the app has no commit callbacks or secure tokens.
- **D26** affects tests only; **D28** web image types, no variants used; **D29** migration timestamps are valid; **D31** YJIT is a memory decision.
- **D34 `Regexp.timeout`:** the app's regular expressions are linear.
- **D35/D36:** no JSON responses. **D37:** every model has a primary key. **D38:** redirects are absolute. **D39:** one-time fragment cache miss. **D40:** markup only.
- **D10, D13, D16, D25:** logging and filtering only.
- **D2–D4:** no encrypted attributes. **D15:** foreign keys exist.
- **D1, D7, D8, D21:** these options were removed in 8.0; their new behaviour is forced and covered by F10, F14 and F9.

## 3. Rollout and rollback

**Sequence:**
1. Ship the prep repairs on 7.0.8.7: F1–F3, F5–F11, F14–F19, plus the default-prep repairs if you plan to adopt defaults later.
2. Bump to 7.1.6 and apply F4, F12 and F13 together.
3. Bump to 7.2.4, then 8.0.5.1, then 8.1.0 with the `json < 3` constraint, checking with `bin/rails test` and `zeitwerk:check` at each step.
4. Enable defaults afterwards, one release at a time, starting with the four in the first table.
5. Expect `schema.rb` dump changes on the next migration (sorted columns, extension naming). Commit those as their own diff.

**Queue compatibility (executed):**
- Full scheduled reminder jobs written by every version from 7.0.8.7 to 8.1.0 run on every other version, and a superseded job still sends nothing (run `215134`).
- Digest jobs, once F3 and F14 are in, read correctly in both directions.
- Unrepaired 7.2+ digest jobs cannot be read by 7.0. So drain or ship F14 before rolling back past 7.2.

**Rollback:** each step's repairs also work on the previous version, except F4, F12 and F13, which need 7.1 or later. Do not enable D11, D12 or D19 until rollback is no longer needed.

## Version check matrix

| Copy | Resolve | Prepare | Boot | Eager | Routes | Tests |
|---|---|---|---|---|---|---|
| current 7.0.8.7 (`211226`) | ok | ok | ok | ok | ok | 46 runs, 0 failures |
| r7.0.10 (`211242`) | ok | ok | ok | ok | ok | 1 failure (F3) |
| r7.1.6 / r7.2.4 / r8.0.5.1 / r8.1.0 | ok | fail F1 | fail | fail | fail | fail |
| u7.1.6 (`212725`) | ok | ok | ok | ok | ok | 1 failure, 3 errors |
| u7.2.4 (`213125`) | ok | ok | ok | ok | ok | 14 failures, 6 errors |
| u8.0.5.1 (`213154`) / u8.1.0 (`213226`) | ok | ok | ok | ok | ok | 19 failures, 6 errors each |
| prep (`212420`), pd (`214955`), f7.1.6 (`212436`), f7.2.4 (`212505`), f8.0.5.1 (`212533`), f8.1.0 (`212600`), d8.1.0 (`214839`) | ok | ok | ok | ok | ok | all green |

Production environment (dummy secret key): eager boot, the app's STDOUT logger inside the new 8.1 `BroadcastLogger`, and `assets:precompile` all pass on current and repaired 8.1 (runs `215024`–`215031`).

## Dependency movements

Comparing 8.1 with the current lock: `json` +2.21.2 (with the constraint; 3.1.0 without it), `action_text-trix` +2.1.19, plus new gems `bigdecimal`, `drb`, `securerandom`, `uri`, `useragent`, `webrick`, `rackup` and `rack-session`. `method_source` is dropped, and `net-imap` moves 0.6.7 → 0.6.8 (unrelated; the app does not use IMAP). `rack` stays 2.2.24 and `puma` stays 5.6.9; none of the app's existing pins were relaxed. Rails 8.1 needs Ruby ≥ 3.2; 3.3.6 qualifies.

## Remaining unknowns

- **U1 – production secret key:** Rails 7.0 could fall back to `secrets.yml` for `secret_key_base`; 7.2+ uses only the environment or credentials. I could not decrypt `credentials.yml.enc`, so confirm production sets `SECRET_KEY_BASE` or has `secret_key_base` in its credentials before deploying 7.2.
- **U2 – the rich-text editor in a browser:** `test/system` is empty, so nothing exercised the editor with the vendored Trix 1.3.5 next to Action Text 7.1+/8.1 JavaScript (Rails now bundles Trix 2.x). Proposed: a manual or system test that creates, edits and attaches a file in a note on 8.1.
- **U3 – production-only behaviour:** only checked with a dummy key in the lab, not real production configuration.
- **Upstream history:** I did not read all of the 13,954 Rails commits, only targeted candidates (Active Job, Action Text and specific patches). That is a coverage limit.

## Final checks

- **Review table:** all 1579 rows in `/tmp/tmp.RaxHFSCVby/changes/review.tsv` are disposed: 78 findings, 1491 not-applicable with a code or config reason, 10 unknown. About 900 unlabelled bug-fix rows got their reasons from rule families after reading each title, and were spot-checked; the reasons for the 577 labelled removal, deprecation and behaviour rows were audited row by row.
- **Other paths kept:**
  - Create and update both work.
  - Valid and invalid imports are both checked.
  - Jobs already queued by the old version and by the new one both run.
  - Filtered and unfiltered note lists both work.
  - The cached export indicator still behaves as the existing test documents.
- **Executed claims:** every executed result cited above has a run log and a resolved lockfile.

Passing tests alone do not discharge F3, F9, F14 or F18. Each of those has its own probe with a control.

## Files

- Repaired files and full diff: `/tmp/tmp.RaxHFSCVby/repairs/`, `/tmp/tmp.RaxHFSCVby/defaults-overlay/`, `/tmp/tmp.RaxHFSCVby/repairs.diff`
- Probes, their output and queued-job samples: `/tmp/tmp.RaxHFSCVby/probes/`, `/tmp/tmp.RaxHFSCVby/probe-results/`, `/tmp/tmp.RaxHFSCVby/payloads/`
- Change evidence: `/tmp/tmp.RaxHFSCVby/changes/` and `/tmp/tmp.RaxHFSCVby/changes-<copy>/dependencies.json`
- Lab copies and logs: `/tmp/tmp.RaxHFSCVby/lab/variants/`, `/tmp/tmp.RaxHFSCVby/lab/runs/`

---

**Notes:**
- I haven't upgraded anything yet. The upgrade skill only makes a plan; your repo is unchanged and still on `main`. The plan above is the planner's report as written. All its testing ran in throwaway copies of the app.
- Rails stays pinned to `7.0.8.7` in the `Gemfile` until we change it.
- The plan says "20 changes", but it lists F1–F21. F21 (Rails dropping its built-in Sidekiq support) needs nothing done for this upgrade.
- The plan relies on probes and copies in `/tmp`, which may not survive a restart.
- **Decision for you:** should I apply the repairs and bump Rails step by step on a new branch? The order would be the prep fixes on 7.0, then 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0, keeping `json` below 3.
- Before you deploy 7.2, check where production gets its secret key (U1 in the plan).