# Upgrade plan: rails 7.0.8.7 → 8.1.0 (Margin Notes)

I didn't modify the application (`git status` is clean). All lab work is under `/tmp/tmp.8seO08WdWT`.

**What it takes:**
- **Twenty code repairs** (R1–R20). Without them the app fails at boot from 7.1, at class load or routing in 7.2–8.1, or misbehaves silently.
- **One dependency pin:** `gem "json", "~> 2.21"`. Without it, every signed-in request on 8.1.0 fails.
- **Same toolchain:** Ruby 3.3.6 already meets Rails 8.1's `>= 3.2.0`, and Bundler 2.5.22 is unchanged.
- **Keep `load_defaults 7.0`** during the upgrade. Adopting newer defaults needs three extra repairs (O1–O3).

With all repairs applied, 8.1.0 passes the CI command (`bin/rails test`): 46 runs, 340 assertions, 0 failures, no deprecation warnings. The browser suite is empty and Chrome isn't installed, so no JavaScript or system test ran.

**Evidence labels:** "executed" means there is a run log and a resolved lockfile. "Source-based" means I read the gem source. "Proposed" means not run.

## Version/check matrix (executed)

All lockfiles resolved. Baseline `current` is 7.0.8.7: 46 runs, 0 failures (`runs/20261014T211138-current-5e2cbb`). "First new failure" is the earliest release where each problem appears.

| Release | Unrepaired result | First new failures |
|---|---|---|
| 7.0.10 | boots; 1 test failure | digest date (F02) |
| 7.1.6 | **boot fails**: `config/initializers/action_text.rb:3: undefined method '+' for nil` | F01, then export `TypeError` (F03) |
| 7.2.4 | eager load fails: `serialize ... wrong number of arguments (given 2, expected 1)`; 28 errors from `Note model aliases 'color', but 'color' is not an attribute` | F04–F07, F09–F14 |
| 8.0.5.1 | eager load fails: `enum ... wrong number of arguments (given 0, expected 1..2)` | F08, F15, F17 |
| 8.1.0 | routes fail: `Wrong number of arguments (expect 1, got 2)`; session decode fails: `ArgumentError (given 2, expected 1)` inside `json-3.1.0` | F16, F18, D1 |
| 8.1.0, all repairs | 46 runs, 340 assertions, 0 failures | — |

- The final repaired run is `f8_1_0`, `runs/20261014T212041-f8_1_0-858974`.
- The repaired 7.1.6, 7.2.4 and 8.0.5.1 variants are also green.
- `u*` variants carry only the boot repairs, so the silent changes are visible.
- `p7_0` is 7.0.8.7 plus every portable repair: 46 runs, 0 failures (`runs/20261014T213651-p7_0-b4809a`).

## 1. Required changes

Each finding lists the source change, where it hits the app, the consequence, one repair, and how it was validated.

- **Preparatory repairs** (marked *prep*) were verified on 7.0.8.7 in `p7_0` and can ship before the version bump.
- **Bump-time repairs** must land in the same commit as the version they need.
- Probes are in `/tmp/tmp.8seO08WdWT/probes`. Each was run on `current`, on the unrepaired `u*`/`b*`/`r*` variant, and on `f8_1_0`.
- Unless noted, the probe passes on `current` and on `f8_1_0`.

**F01 – Action Text allowed tags (C141, 7.1).** *Prep.*
- **Where:** `config/initializers/action_text.rb` does `allowed_tags += %w[details summary]`. Since 7.1, `allowed_tags` is nil until the app sets it.
- **Consequence:** the app doesn't boot (executed, `r7_1_6`).
- **Repair:** in `after_initialize`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]) | %w[details summary]`.
- **Validation:** p01 checks `<details>`/`<summary>` are kept, `figure`/`figcaption` defaults are kept, and `<script>`/`<marquee>` are dropped (controls). Passes on current, p7_0, every u variant and f8_1_0.

**F02 – Job time arguments keep the reader's time zone (C4, from 7.0.10).** *Prep.*
- **Where:** `DigestMailer#daily_digest`. The job argument comes from `User#request_digest`.
- **Consequence (executed):** the test fails with `"Your reading digest for October 05, 2026"` expected but `October 04` received. Probe p02 on `r7_0_10` shows the new payload adds `"time_zone":"America/New_York"`.
- **Repair:** `requested_at = requested_at.utc` in the mailer.
- **Validation:** p02 checks a fresh payload, a 7.0.8.7-format payload and a 7.0.10+-format payload; all three give Oct 05. A UTC reader at noon is the control. Passes on current, p7_0 and f8_1_0, so it's safe in both rollback directions.

**F03 – `Enumerable#sum` override removed (C470, 7.1).** *Prep.*
- **Where:** `Export#generate` calls `fragments.sum`.
- **Consequence:** `TypeError: String can't be coerced into Integer` (3 export tests, `u7_1_6`).
- **Repair:** `fragments.join`.
- **Validation:** the export suite passes on p7_0 and f8_1_0.

**F04 – Plural association name in `where` (C223/C914/C867/C1264, removed in 7.2).** *Prep.*
- **Where:** `NotesController#index` does `where(notebooks: @notebook)`.
- **Consequence:** `PG::UndefinedColumn: column notes.notebooks does not exist` (p10, u7_2_4).
- **Repair:** `where(notebook: @notebook)`.
- **Validation:** p10 checks only notebook A's note is returned; the unfiltered count of 2 is the control.

**F05 – `return` inside a transaction now commits (C269/C913, 7.2).** *Prep.*
- **Where:** `Import#apply`.
- **Consequence:** a CSV whose second row is invalid now saves the import and the earlier note. p04 on u7_2_4 shows `[0, 3, 0] -> [1, 4, 1]` (imports, notes, citations); the test sees `Expected [0,3,0,1] Actual [1,4,1,2]`.
- **Repair:** `applied = transaction { save!; rows.each { |r| raise ActiveRecord::Rollback unless r.note.save }; true }`, then return `applied ? true : false`.
- **Validation:** p04 checks the invalid file saves nothing and returns false; a valid file saving 2 notes is the control.

**F06 – `read_attribute(:id)` with a custom primary key (C277/C915, 7.2).** *Prep.*
- **Where:** `Import#receipt` uses `citation[:id]`; the citations primary key is `doi`.
- **Consequence:** receipt rows become `"Row A,\n"` instead of `"Row A,10.1000/probe.2\n"` (p04 on u7_2_4).
- **Repair:** `citation&.id`.
- **Validation:** p04 receipt check; an uncited row staying blank is the control.

**F07 – `serialize` positional coder removed (C385/C922, 7.2).** *Bump-time:* `coder:` only exists from 7.1.
- **Where:** `Note` (`serialize :tags, JSON`) and `Notebook` (`serialize :preferences`).
- **Consequence:** eager-load `ArgumentError` on 7.2.4.
- **Repair:** `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
- **Validation:** p15 compares stored bytes. They are identical on current and f8_1_0 (`["a","b"]` and `"---\nexport_heading: Head\n"`), so rollback is safe. Rows written in the old format read back correctly; a NULL preference is the control.

**F08 – `enum` keyword form removed (C870/C1268, 8.0).** *Prep.*
- **Where:** `Note` declares `enum status:`.
- **Consequence:** eager-load `ArgumentError` on 8.0.5.1.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
- **Validation:** p15 checks the `status_draft` scope and the `status_draft?` predicate.

**F09 – `alias_attribute` to a non-attribute (C279/C917, 7.2).** *Prep.*
- **Where:** `Note` aliases `highlight_color` to the `color` store accessor.
- **Consequence:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`. It's raised lazily, so 28 tests error.
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Validation:** p06 checks that create and update through `highlight_color` both persist; an unknown colour being rejected is the control.

**F10 – `retry_on wait: :exponentially_longer` removed (C828, 7.2).** *Bump-time with 7.1.*
- **Where:** `CitationEnrichmentJob`.
- **Repair:** `wait: :polynomially_longer`.
- **Validation:** p17 shows identical delays, `[3.0, 18.0]`, before and after.

**F11 – Numeric `scheduled_at` removed (C581/C830, 7.2).** *Prep.*
- **Where:** `Note#schedule_reminder` passes an integer epoch to `wait_until`.
- **Consequence:** `NoMethodError: undefined method 'utc' for an instance of Integer` with both the test adapter and the Sidekiq adapter (p07/p21 on u7_2_4).
- **Repair:** `set(wait_until: Time.at(reminder_epoch))`.
- **Validation:** p07 and p21 check the Sidekiq `at` equals the epoch; an immediate job is the control.

**F12 – `show_exceptions = false` removed (C803, 7.2).** *Bump-time with 7.1.*
- **Where:** `config/environments/test.rb`.
- **Repair:** `:none`. Note that `:none` is truthy on 7.0, so this can't ship early.
- **Validation:** request suites pass on 7.1–8.1.

**F13 – `Rails.application.secrets` removed (C534/C1012, 7.2).** *Prep.*
- **Where:** the `Citation::Provider#initialize` default, `config/secrets.yml`, and the test helper `citation_enrichments_controller_test.rb` (lines 45, 117–122).
- **Consequence:** `NoMethodError: undefined method 'secrets'` (p13, b7_2_4/b8_1_0).
- **Repair:**
  - Add `config/citation_provider.yml`: the same ERB/`to_json` env reads as `secrets.yml`.
  - Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  - Read `Rails.application.config.x.citation_provider.to_h` in `Citation::Provider`.
  - Update the test to set `config.x` instead of secrets.
- **Validation:** p13 checks the URL comes from `CITATION_PROVIDER_URL` and an unset user falls back to the default (control). The existing "provider credentials from the environment" test (fresh boot, password `"sample: value # keep"`) passes.
- **Rollout note:** the 7.1 guide says the dev/test `secret_key_base` file was renamed to `tmp/local_secret.txt`. Production's source for `secret_key_base` is unknown (see Unknowns).

**F14 – BigDecimal job argument (C178/C829, 7.2).** *Prep.*
- **Where:** `User#request_digest` passes `reading_completion` to `DigestJob`.
- **Consequence:** from 7.2 the payload is `{"_aj_serialized"=>"ActiveJob::Serializers::BigDecimalSerializer","value"=>"0.6667"}`. A 7.0 worker reading it fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (p03 on current), which breaks rollback.
- **Repair:** `reading_completion.to_s`. `DigestMailer` already calls `BigDecimal(params[:completion])`.
- **Validation:** p03 shows the payload is the string `"0.6667"` on p7_0 and f8_1_0 and renders "67%". A 7.0-era string payload is the control.

**F15 – `HashWithIndifferentAccess#stringify_keys` now stringifies Integer keys (C1273, 8.0).** *Prep.*
- **Where:** `app/views/imports/preview.html.erb` does `@import.annotations.stringify_keys` and then looks up `annotations[row.line]` with an Integer.
- **Consequence:** annotations disappear from the preview (p04 on u8_0_5_1; test expected `"Read <b>twice</b> & reflect"`).
- **Repair:** drop the `.stringify_keys`.
- **Validation:** p04 checks line 2 shows its annotation and line 3 shows none (control).

**F16 – Route with multiple paths removed (C1392, 8.1).** *Prep.*
- **Where:** `config/routes.rb` has `get "/notes", "/journal", to: ...`.
- **Repair:** two routes, `as: :notes` and `as: :journal`. This keeps both existing helper names.
- **Validation:** p14 checks both paths, both helpers, and `/notes/1` → `notes#show` (control).

**F17 – `form_with(model: nil)` raises (C1258, 8.0).** *Prep.*
- **Where:** the search form in `notes/index.html.erb`.
- **Consequence:** `Passed nil to the :model argument` (7 errors).
- **Repair:** remove the `model:` argument.
- **Validation:** the existing "renders an unbound search form" test passes.

**F18 – `to_time` always preserves the zone (C1541, 8.1).** *Prep.*
- **Where:** `Note#next_day_reminder_at`, used by the `notes/_reminder` view.
- **Consequence (executed, f8_1_0 before this repair):** `Expected ... time[datetime="2026-11-01T09:00:00-04:00"], found 0`. Across DST the displayed offset changes; the epoch doesn't.
- **Repair:** `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.
- **Validation:** p07 checks the epoch is +86400 and the offset is -04:00 across DST; a non-DST date is the control.

**F19 – Built-in Sidekiq adapter deprecated (C1424, 8.1; removed in 8.2).**
- **Where:** `config.active_job.queue_adapter = :sidekiq` with sidekiq 6.5.12.
- **Consequence:** `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2` (p21 on f8_1_0). It still works today: the job is pushed with the right `at`.
- **Repair:** none needed for 8.1. Plan a sidekiq ≥ 7.3.3 upgrade, which also needs redis 5, before 8.2. Leave the current pins alone for now.

**D1 – Dependency: json 3.x (new runtime dependency of activesupport 8.1.0, `>= 0`).**
- **Consequence:** resolution picks json 3.1.0. `ActiveSupport::JSON.decode` then raises `ArgumentError (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291`, so every session decode fails: 40 errors, `b8_1_0`/`r8_1_0`, p20.
- **Repair:** `gem "json", "~> 2.21"`. It resolves to 2.21.2.
- **Validation:** p20 passes on f8_1_0 and on p7_0 with 7.0.8.7, so the pin can ship first.

## 2. Optional defaults (keep `load_defaults 7.0` for the upgrade)

**Default inventory.** No framework default is set explicitly. Effective values were checked with a runner (`probes/defaults.rb`); results are in `review.tsv` D1–D40. Under 7.0 defaults on 8.1.0:
- enqueue after commit: `false` (`:never` on 7.2)
- PG date decoding: `false`
- `to_time` preservation: `nil` (always zone)
- `strict_freshness`: `false`
- message serializer: Marshal
- sanitizer vendor: HTML4
- `Regexp.timeout`: `nil`

Three defaults need repairs before you adopt them (all executed):

- **O1 – PG date decoding (7.2 default).** Enabling it raises `TypeError: no implicit conversion of Date into String` at `Notebook#daily_note_counts` (`o_dates_unrep`). Repair: `day.to_date`. Verified green with the setting on (`o_dates_rep`) and on p7_0.
- **O2 – `raise_on_assign_to_attr_readonly` (7.1 default).** Enabling it raises `ActiveRecord::ReadonlyAttributeError: slug` in `NotebooksController#update`, because `notebook_params` permits `:slug`. Repair: stop permitting `:slug` but keep the hidden field the test asserts. Green with the setting on (`o_readonly`) and on p7_0.
- **O3 – `raise_on_invalid_cache_expiration_time` (7.1 default).** Enabling it raises `Cache expiration time is invalid, cannot be negative: -60.0` in `exports/_export.html.erb`. Repair: `expires_in: [export.expires_at - Time.current, 1.second].max`. Green on `o_cache_rep` and p7_0.
  - I tried `cache_if` first and rejected it: it broke the tested contract that a cached indicator survives until the original deadline.
  - Even with the old default, from 7.1 a negative expiry is dropped rather than applied. Source-based: this is benign here, because the cache key changes when the export updates.

Proposed checks before adopting the rest:
- **Enqueue after commit:** `Note#schedule_reminder` and `Citation#request_enrichment` rely on an enqueue failure rolling back the row lock, so leave this off.
- **Message serializer and metadata:** adopt only after every server is on 7.1 or later.
- **HTML5 sanitizer:** re-run p01.
- **Strict freshness:** check `ExportDownloadsController#show`'s `stale?`.
- **Path-relative redirect raise, hidden-field autocomplete, `Regexp.timeout`, YJIT:** source-based only.

## 3. Rollout and rollback

1. **Release A on 7.0.8.7:** all *prep* repairs plus the json pin. Verified together in `p7_0`. Optionally include O1–O3 too; they're portable. This makes queued payloads (F02, F14) version-neutral before any worker changes.
2. **Release B, Rails 7.1.6:** F07, F10 and F12. Check deprecation output is limited to the known 7.1 warnings (verified on `f7_1_6`).
3. **Release C:** step through 7.2.4, then 8.0.5.1, then 8.1.0 as separate deploys, or go straight to 8.1.0. All four repaired lanes are green. Deploy web and Sidekiq workers together. Drain the scheduled reminders queue, or confirm it runs mixed versions: payload probes p02, p03 and p07 cover old→new and new→old.
4. **Rollback:** the stored formats (p15) and job payloads (p02, p03) are identical or readable both ways once Release A is out. Rolling back to 7.0 after 7.2+ is safe only because of F14's string argument. Before release A, a 7.2+ BigDecimal payload breaks a 7.0 worker (observed error above).
5. **Don't change** pins for sidekiq, redis, puma, pg, concurrent-ruby or minitest. All of them resolved unchanged on every variant.

**Dependency movements** (current → 8.1.0, `changes-f8_1_0/dependencies.json`):
- rails 7.0.8.7 → 8.1.0, plus all components.
- Added: bigdecimal 4.1.3 (already at 7.0.10), rack-session 1.0.2 and rackup 1.0.1 (from 7.1), json 2.21.2 (pinned), action_text-trix 2.1.19, drb, securerandom, uri, useragent and webrick.
- Removed: method_source.
- net-imap 0.6.7 → 0.6.8.
- Unchanged: rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, minitest 5.27.0.

## Remaining unknowns and coverage limits

- **Trix and Action Text JavaScript (U1, unknown).** The layout loads the vendored classic-script `trix-1.3.5.js` while importmap pins `actiontext.js`. From 7.1 Rails bundles Trix 2; from 8.1 it comes from the `action_text-trix` gem. Source-based: 8.1's `actiontext.js` still calls `attachment.setUploadProgress`/`setAttributes`. It hasn't been run in a browser: no Chrome and no system tests. **Proposed:** a manual or system check of editing, attaching and reloading a note with links and attachments on 8.1, then decide whether to drop the vendored copy.
- **Production secret and environment (unknown).** I didn't decrypt `credentials.yml.enc`, so I can't tell where production's `secret_key_base` comes from now that `secrets.yml` is ignored (7.2+). Production boot, `BroadcastLogger` and Sidekiq workers weren't run, so test-only results don't prove the production configuration.
- **Review table (`changes/review.tsv`):** 88 findings, 1441 not-applicable, 90 unknown.
  - About 1300 of the not-applicable rows were routed by keyword rules to a configuration-based reason, and the entries weren't individually re-read. Treat them as a coverage limit, not proof.
  - The 90 unknowns are listed in the TSV.
- **Commit history:** 13,954 commits. Only the commit index and keyword-matched candidates were inspected (about 100 patches for the APIs above); the remaining roughly 3,000 risk candidates are unreviewed.
- **Lab setup changes (not upgrade findings):**
  - Copied `vendor/javascript` into each variant (the lab omits vendor).
  - Redirected `CITATION_PROVIDER_URL` to a closed local port.
  - Used a private Redis and PostgreSQL. An early credential override broke one baseline test; I reverted it.

## Final checks

- Every review row has a status; the unknowns are listed above and in the TSV.
- Each repair was checked on its other paths:
  - create and update (F09, F05)
  - fresh and cached (O3)
  - old and new payloads (F02, F14)
  - control inputs in every probe
  - the existing test suite on p7_0 and f8_1_0
- Every executed claim above has a log under `lab/runs/` and a resolved lockfile (versions confirmed per variant).
- Green tests alone aren't the evidence for any finding; each one has a probe or an observed error.

Files are in `/tmp/tmp.8seO08WdWT`:
- `changes/review.tsv`
- `changes-f8_1_0/dependencies.json`
- `repairs/*.sh` and `repairs/action_text.rb`
- `probes/p*.rb`
- `lab/variants/{current,p7_0,r*,u*,f*,b*,o_*}/Gemfile.lock`
- `lab/runs/`

---

**My notes:** I haven't upgraded Rails yet. The upgrade skill only produces a plan, so the repo is unchanged, still on Rails 7.0.8.7 from `Gemfile.lock`. The plan contains 19 code repairs (F01–F19), not the 20 its summary says, and F19 is a deprecation that needs no change for 8.1. It also needs the json pin (D1).

Two things are still unknown: whether the Trix editor works in a browser, and where production gets `secret_key_base`. Should I apply Release A (the repairs that work on 7.0, plus the json pin) first, or do the whole upgrade to 8.1.0 in one go?