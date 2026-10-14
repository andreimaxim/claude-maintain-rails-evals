# Upgrade plan: rails 7.0.8.7 → 8.1.0 (Margin Notes)

The upgrade needs 20 required code and config changes plus one Gemfile pin. Together they make the suite green on every release, but several of these breaks are invisible to the existing tests. The most serious ones:

- **Boot fails from 7.1** because of the Action Text initializer.
- **CSV imports stop being all-or-nothing from 7.2.** A failing row leaves the import and earlier rows saved.
- **Every signed-in request returns 500 on 8.1.0** unless `json` is pinned below 3.
- **Digest emails switch from the UTC day to the reader's local day** starting at the very first patch release, 7.0.10.

I did not change the application; `git status` is clean. All work is in `WORK=/tmp/tmp.UaRAFB8yPH`, and the lab is `LAB=/tmp/tmp.UaRAFB8yPH/lab`.

**Prerequisites**
- Ruby 3.3.6 meets Rails 8.1's `>= 3.2.0`.
- Postgres stays as is.
- No CI file exists, so the suite command is `bin/rails test` (TESTING.md).
- The locked current version (7.0.8.7) comes from rubygems.org, and every crossed release was read: 7.0.10, 7.1.6, 7.2.4, 8.0.5.1, 8.1.0. `coverage.json` reports no gaps.

**Evidence labels:** *executed* (lab run or probe with a log and resolved lockfile), *source-based* (gem source or changelog read), *proposed* (not run).

## 1. Required changes

Each entry gives what breaks and from which release, the error or result seen, the fix, and how it was checked. "Before the bump" means the fix also runs on 7.0.8.7 (checked: all 46 tests pass with these fixes on 7.0.8.7). Probes are in `WORK/probes/`.

**F1 Action Text tag allowlist (`config/initializers/action_text.rb`), from 7.1.6.** *Executed.*
- `ActionText::ContentHelper.allowed_tags` is now `nil` by default (gem source compared at v7.0.8.7 and v8.1.0; changelog C141 is related).
- Every stage from prepare onward fails: `action_text.rb:3: undefined method '+' for nil (NoMethodError)`.
- Fix: inside `config.after_initialize`, take `allowed_tags || (sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"])` and add `details`/`summary`. Safe before the bump.
- Check (P10, every variant): `<details>`/`<summary>` are kept, `<script>` is removed, and `<b>` is kept as the control.

**F2 `Rails.application.secrets` (`Citation::Provider#initialize`, `config/secrets.yml`, the citation test helper).** Deprecated in 7.1, removed in 7.2. *Executed.*
- On 7.2: `NoMethodError: undefined method 'secrets' for an instance of MarginNotes::Application`.
- Fix:
  - Move the same environment-based ERB to `config/citation_provider.yml` (`WORK/repair/citation_provider.yml`).
  - In `config/application.rb`: `config.x.citation_provider = config_for(:citation_provider)`.
  - The provider reads `Rails.configuration.x.citation_provider.to_h`.
  - The test swaps `Rails.configuration.x.citation_provider`.
  - Safe before the bump.
- Check:
  - P11: the provider URL equals the environment value.
  - The subprocess test where a fresh boot reads the environment passes on all repaired variants.
  - Production boot gives the same `provider_url` on 7.0.8.7 and 8.1.0.

**F3 `serialize :tags, JSON` (Note).** Removed in 7.2 (C922). *Executed.*
- Eager load fails: `serialize: wrong number of arguments (given 2, expected 1)`.
- Fix: `serialize :tags, coder: JSON`. Ship it with the 7.1 bump: 7.0 has no `coder:` keyword (source-based; not run on 7.0).
- Check (P8): tags already stored as `'["old","tags"]'` read back correctly, and new writes are still `'["a","b"]'`, on 7.0 through 8.1.

**F4 `enum status: {...}, _prefix: true` (Note).** Deprecated in 7.2, removed in 8.0 (C870, C1268). *Executed.*
- Eager load fails: `enum.rb:217 wrong number of arguments (given 0, expected 1..2)`.
- Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Safe before the bump.
- Check: P8 (`status_ready?`) plus the status filter tests.

**F5 `alias_attribute :highlight_color, :color` (Note; `notes/_form`, `NotesController#note_params`).** Removed in 7.2 (C917). *Executed.*
- Every Note load fails: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`.
- Fix: plain `highlight_color` / `highlight_color=` methods that call `color`. Safe before the bump.
- Check (P7): `highlight_color: "blue"` saves `settings["color"]`; the control `"purple"` is rejected as "Color is not included".

**F6 `retry_on ..., wait: :exponentially_longer` (CitationEnrichmentJob).** Removed in 7.2 (C828). *Executed.*
- `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
- Fix: `wait: ->(executions) { executions**4 + 2 }`. `:polynomially_longer` only exists from 7.1. Safe before the bump.
- Check (P6): first retry at 3 s on every version, the same as the original on 7.0 and 7.1.

**F7 `fragments.sum` of strings (Export#generate).** Removed in 7.1 (C470). *Executed.*
- `TypeError: String can't be coerced into Integer` (`export.rb:42`); three export tests error.
- Fix: `fragments.join`. Safe before the bump.
- Check (P12): the exact Markdown file content is identical on every version.

**F8 `citation[:id]` in `Import#receipt`.** Citations use `doi` as the primary key; removed in 7.2 (C915). *Executed.*
- The receipt CSV loses the DOI: `"Cited,\nUncited,\n"`.
- Fix: `citation&.doi`. Safe before the bump.
- Check (P2): `Cited,10.1000/probe.1`; the control (a note with no citation) stays blank.

**F9 `return` inside `transaction` (Import#apply).** C269, C913, C1265; from 7.2 an early return commits instead of rolling back. *Executed.*
- The original code on 7.2, 8.0 and 8.1 gives `apply=false persisted=true delta imports/notes=[1, 1]`: a partial import is saved.
- Fix:
  ```ruby
  saved = transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end
  saved == true
  ```
- Check (P1, no outer transaction): the repaired code gives `[0, 0]` on 7.0 through 8.1; the control (all rows valid) gives `[1, 2]`. Safe before the bump.

**F10 `show_exceptions = false` (`config/environments/test.rb`).** Removed in 7.2 (C803). *Executed.*
- Exceptions get rendered instead of raised, so tests fail with "ActiveRecord::RecordNotFound expected but nothing was raised".
- Fix: `:none`. Ship it with 7.1: on 7.0, `:none` counts as true and would render exceptions (source-based).

**F11 `get "/notes", "/journal"` (`config/routes.rb`).** Removed in 8.1 (C1392).
- `Wrong number of arguments (expect 1, got 2) (ArgumentError)`.
- Fix: two separate `get` lines. Safe before the bump.
- Check (P18): both paths route to `notes#index`.

**F12 BigDecimal job argument (`User#request_digest` → DigestJob).** 7.1 deprecates it; from 7.2 the BigDecimal serializer is always used. *Executed.*
- A 7.0.x worker reading a 7.2+ payload: `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- Fix: pass `reading_completion.to_s`. That payload (`"1.0"`) is byte-identical to what 7.0 already writes. Safe before the bump.
- Check: the cross-version payload matrix (see Rollout).

**F13 Job time arguments keep their zone (DigestMailer).** C4, already in 7.0.10. *Executed.*
- Payloads gain `"time_zone":"America/New_York"`. Unrepaired 7.0.10 sends a subject of "October 04, 2026" where "October 05, 2026" (the UTC day) is expected; `digests_controller_test.rb:33` fails.
- Fix: in the mailer, `requested_at = params[:requested_at].utc`. Safe before the bump.
- Check (P4): every repaired reader produces Oct 05 for payloads from 7.0.8.7, 7.0.10, 7.2.4 and 8.1.0. The control note updated on Oct 4 UTC is left out.

**F14 Integer `wait_until` (`Note#schedule_reminder`).** Removed in 7.2 (C830). *Executed.*
- `NoMethodError: undefined method 'utc' for an instance of Integer`: reminders can't be scheduled.
- Fix: `wait_until: Time.at(reminder_epoch)`. Safe before the bump.
- Check (P5): the Sidekiq schedule score equals 1793451600 on every variant.

**F15 `where(notebooks: @notebook)` (NotesController#index).** Removed in 7.2 (C914). *Executed.*
- `PG::UndefinedColumn: column notes.notebooks does not exist`.
- Fix: `where(notebook: @notebook)`. Safe before the bump.
- Check (P13): filtered to `["in"]`; the other notebook's note is excluded.

**F16 `form_with(model: nil, ...)` (`notes/index.html.erb:12`).** Removed in 8.0 (C1258). *Executed.*
- `Passed nil to the :model argument, expect an object or false`.
- Fix: drop `model:`. Safe before the bump.
- Check: the "renders an unbound search form" test passes.

**F17 `annotations.stringify_keys` (`imports/preview.html.erb`).** 8.0 (C1273) now turns Integer keys into strings. *Executed.*
- Annotations disappear from the preview.
- Fix: use `@import.annotations` directly. Safe before the bump.
- Check (P14): `a[2] == "Note A"`.

**F18 `reminder_at.to_time + 86_400` (`Note#next_day_reminder_at`).** C1225 and C1541; `to_time` now keeps the time zone, not the offset. *Executed.*
- The 8.1 hint shows `2026-11-01T08:00:00-05:00`; `reminders_controller_test.rb:21` expects `09:00:00-04:00`.
- Fix: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Safe before the bump.
- Check (P16): same instant as before, the offset is kept across the DST change, and a summer date (control) is unchanged.
- On 8.0 only, a boot-time `to_time` deprecation warning remains; it comes from `load_defaults 7.0` and is harmless.

**F19 json gem (Gemfile).** Not in the changelog; found via the dependency report. *Executed.*
- activesupport 8.1.0 adds an unconstrained `json` dependency, and Bundler picks json 3.1.0.
- `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291` when decoding cookies: 40 errors.
- Fix: `gem "json", "~> 2.7"` (resolves 2.21.2). No other pins were relaxed.

**F20 Trix packaging (C1405).** *Proposed browser check.*
- From 8.1, Action Text gets Trix from the new `action_text-trix` gem. The app still loads its vendored `trix-1.3.5.js` alongside 8.1's `actiontext.js`.
- System tests were not run (they need Chrome). Run `bin/rails test:system` on 8.1 and exercise editing and attachments by hand.

**F21 Built-in Sidekiq adapter.** Deprecated in 8.1 (C1424), observed in the logs. Non-blocking; keep sidekiq 6.5.12 and redis 4.8.1 pinned. Moving to Sidekiq ≥ 7.3.3 is a separate task: `redis.sadd` would return an Integer there, which breaks the truth test in `User#request_digest`.

## 2. Optional framework defaults

The app stays on `load_defaults 7.0`; none of these settings are set explicitly. I read the effective values at runtime (P21/P22 output). Don't enable any of these as part of the upgrade.

| Setting | Current → new default | What it would do here |
|---|---|---|
| D9 `raise_on_invalid_cache_expiration_time` | false → true | The expired-export fragment in `exports/_export.html.erb` uses a negative `expires_in`, which then raises `ArgumentError: Cache expiration time is invalid, cannot be negative: -5` (executed at the cache-store level). Guard the cache call first. |
| D18 `default_column_serializer` | YAML → nil | `serialize :preferences` (Notebook) has no coder and would fail (source-based). Add `coder: YAML` first. |
| D14 `raise_on_assign_to_attr_readonly` | false → true | Submitting the same slug did not raise (executed); a tampered slug would. |
| D11, D12, D19 message/cookie serializer, marshalling format | — | Enable only after the whole fleet runs the new version. |
| D23, D24 HTML5 sanitizer | — | Rerun P10 first. |
| D26 HTML5 test parser | — | Rerun the suite first. |
| D33 `strict_freshness` | — | Affects `ExportDownloadsController#stale?`. Proposed. |
| D34 `Regexp.timeout` | — | Proposed. |
| D31 YJIT | — | Production memory impact. Proposed. |
| D39 render tracker | — | One-time cache miss. |
| D40 hidden-field autocomplete | — | Changes the markup of the hidden slug/CSV inputs. |
| D30 `decode_dates` | — | No effect on `daily_note_counts` (executed). |

Not applicable here (with reasons recorded in `review.tsv`):

- D1–D7, D10, D13, D15–D17, D20, D22, D25, D28, D29, D35–D38 do not touch any code path this app uses.
- D8, D21, D27 and D32 are removed or forced by later releases; they are covered by F12, F9, the job-enqueue probe (P19) and F18.

## 3. Rollout and rollback

1. **Deploy on 7.0.8.7 first** with the "safe before the bump" fixes: F1, F2, F4–F9, F11–F18. All 46 tests pass and probes match (`current-prep` variant).
   - F12 and F13 must be live before any upgraded worker exists. With them, every payload pair checked reads correctly in both directions.
   - Unfixed, a 7.0 worker can't read a raw BigDecimal written by 7.2+ (`DeserializationError`).
2. **Bump to 7.1.6** with F3 and F10. Deprecations drop to zero.
3. **Bump to 7.2.4, then 8.0.5.1, then 8.1.0** (with F19), one deploy per step. Wait for queues to drain between steps.
   - Expect one-off side effects: development sessions reset because the local secret file is renamed in 7.1, and `schema.rb` columns get re-sorted on the next schema dump (C1493).
4. **Rollback:** a 7.0.8.7 reader with the original code correctly handles the repaired payloads from 7.0.10, 7.2.4 and 8.1.0 (P4 passes). Keep the F12/F13 code across the rollback window.

## Version and check matrix

46 tests in every suite run. Run logs are in `LAB/runs/`.

| Variant | Result | Run |
|---|---|---|
| current 7.0.8.7 | all stages pass | `20261014T211141-current-86d18f` |
| 7.0.10, unrepaired | 1 failure (F13) | `211201` |
| 7.1.6 / 7.2.4 / 8.0.5.1 / 8.1.0, unrepaired | resolve OK, boot fails (F1) | `211243`, `211319`, `211344`, `211405` |
| F1 only: 7.1.6 / 7.2.4 / 8.0.5.1 / 8.1.0 | F7/F13 test failures / F3 eager / F4 eager / F4 and F11 | `u*` runs |
| F1 plus class-load fixes: 7.2.4, 8.1.0 | F5/F10 test failures (and F19 json pin on 8.1.0) | `l*` runs |
| Repaired: current, 7.0.10, 7.1.6, 7.2.4, 8.0.5.1, 8.1.0 | all stages and tests pass | `212109`, `212121`, `212137`, `212153`, `212209`, `212224` |

The one baseline failure I hit was caused by my own lab credentials override and is fixed. Copying `vendor/javascript` into the lab was a setup step only.

## Dependency movements

Reports are in `WORK/changes-<variant>/dependencies.json`.

- **Added at 8.1:** action_text-trix 2.1.19, bigdecimal 4.1.3, drb, json, rack-session, rackup, securerandom, uri, useragent, webrick.
- **Changed:** net-imap 0.6.7 → 0.6.8.
- **Removed:** method_source.
- No Git or path sources are involved.
- rack stays at 2.2.24 because of the Sidekiq 6.5 pin. The concurrent-ruby 1.3.4 and minitest ~> 5.25 pins resolve unchanged.

## Remaining unknowns

- Browser behaviour with Trix 1.3.5 (F20); system tests were not run.
- Three rack-3 changelog rows (C1060, C1061, C1312), not exercised because rack stays at 2.x.
- Repository history: 13,954 commits, so commit-level review covered only targeted source files. Everything else relies on the changelogs and upgrade guides.
- Production-only settings beyond the eager-load boot check.

## Completeness check

- All 1,619 review rows are disposed in `WORK/changes/review.tsv`: 80 findings, 1,536 not applicable, 3 unknown. 928 of the not-applicable rows were judged from the entry title against app code I read in full.
- Each fix keeps its other paths working: valid imports, uncited receipts, invalid colours, summer reminders, already-stored formats, and payloads read across versions in both directions.
- All 95 runs have a log and a resolved `Gemfile.lock`.
- Green tests alone did not count as clearing a finding.

Key paths:
- `/tmp/tmp.UaRAFB8yPH/summary.md`
- `/tmp/tmp.UaRAFB8yPH/changes/review.tsv`
- `/tmp/tmp.UaRAFB8yPH/repair/` (the fixes, applied in the lab only)
- `/tmp/tmp.UaRAFB8yPH/probes/`
- `/tmp/tmp.UaRAFB8yPH/payloads/`
- `/tmp/tmp.UaRAFB8yPH/lab/runs/`

---

I haven't upgraded Rails yet. The upgrade skill only plans the work, so your repository is unchanged (still on rails 7.0.8.7, working tree clean). All of the test runs above were in a separate copy at `/tmp/tmp.UaRAFB8yPH/lab`, not in your repo.

The plan recommends doing this in steps. First, ship the fixes that already work on 7.0.8.7. Then move up one version at a time: 7.1.6, 7.2.4, 8.0.5.1, and finally 8.1.0 with the `json` pin.

Do you want me to make these changes in the repository? I can do all the steps here or just the first one. Either way, the browser tests weren't run, so the rich-text editor check on 8.1 is still open.