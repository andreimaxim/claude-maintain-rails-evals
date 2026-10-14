# Plan: upgrade `rails` 7.0.8.7 → 8.1.0 in Margin Notes

**Verdict: feasible, but not as a plain gem bump.** Bumping only the gem makes the app fail at boot. After 19 code/config changes and one gem constraint, the upgraded copy passes boot, eager load, routes, `db:prepare` and the full suite (46 runs, 340 assertions, 0 deprecations; log `/tmp/gem-upgrade-20261014-10652-i9mqzt/runs/20261014T155010-*-r17-tests`).

- Five of the bugs give wrong results without any error: partial imports get saved, DOIs vanish from receipts, annotations vanish from previews, digests cover the wrong day, and the reminder preview shows a different time.
- Three repairs (F03, F07, F17) do not work on Rails 7.0 and must ship in the same deploy as the gem bump.
- Rails 7.0 workers cannot read one job format that Rails 8.1 writes. Fix it before deploying (F19).

The real checkout is unchanged (`git status` clean at `ab732f5`). All work ran in disposable labs, which have been cleaned up; their evidence files are kept.

## Required repairs

Each one blocked or broke the upgraded copy, with the exact error observed. "Works on 7.0" means the repair passed the full baseline check on Rails 7.0.8.7 (`/tmp/gem-upgrade-20261014-20022-mus8fv/runs/*compat-tests`). The full diff is `/home/user/planner-run/evidence-rails/candidate-repairs.diff`.

| ID | Where | What happened on 8.1 | Repair | Works on 7.0? |
|---|---|---|---|---|
| F01 | `config/initializers/action_text.rb:3` | App won't boot: `undefined method '+' for nil`. `allowed_tags` defaults to nil since 7.1. | Set the full tag list inside `after_initialize` + `on_load(:action_view)`, built from `sanitizer.class.allowed_tags` + attachment tag, figure, figcaption, details, summary | yes |
| F02 | `note.rb:10` | Note won't load: `wrong number of arguments (given 0, expected 1..2)` (keyword-style `enum` removed in 8.0) | `enum :status, { draft: 0, ready: 1 }, prefix: true` | yes |
| F03 | `note.rb:12` | Note won't load: `wrong number of arguments (given 2, expected 1)` | `serialize :tags, coder: JSON` | **no**: on 7.0 it silently writes YAML (`"---\n- b\n- a\n"`) and reads existing JSON rows back as strings |
| F04 | `routes.rb:18` | Routes fail: `Wrong number of arguments (expect 1, got 2)` | Two separate `get` lines. Route names (`notes`, `journal`) are identical to before. | yes |
| F05 | Gemfile (new constraint) | Every signed-in request returns 500 and uploads fail. Rails 8.1.0 accepts any `json` version, so Bundler picked json 3.1.0 (released 2026-10-13), whose `parse` no longer takes the options hash Rails passes: `json/common.rb:291 ... (given 2, expected 1)` | `gem "json", "< 3"` (resolves to 2.21.2), with a comment explaining why. Drop it when a Rails release supports json 3. | yes |
| F06 | `note.rb:14` | First use of Note raises: ``Note model aliases `color`, but `color` is not an attribute`` | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | yes |
| F07 | `config/environments/test.rb:31` | Errors render 404 pages instead of raising, so the cross-reader authorization tests fail | `show_exceptions = :none` (test environment only) | **no**: on 7.0 `:none` counts as true and shows pages |
| F08 | `export.rb:42` | Exports never finish: `String can't be coerced into Integer`, and the export stays "working" forever | `fragments.join` | yes (also clears the existing 7.0 deprecation warning) |
| F09 | `notes/index.html.erb:12` | The `/notes` landing page returns 500: `Passed nil to the :model argument` | Remove `model: nil` | yes |
| F10 | `notes_controller.rb:12` | Filtering by notebook fails: `PG::UndefinedColumn: column notes.notebooks does not exist` | `where(notebook: @notebook)` | yes |
| F11 | `note.rb:62` | Scheduling a reminder fails: ``undefined method `utc' for an instance of Integer`` | `wait_until: Time.at(reminder_epoch)` | yes |
| F12 | `note.rb:45` | Next-day reminder preview shows `08:00-05:00` instead of `09:00-04:00` across the DST change. 8.1.0 dropped the old offset behaviour; 8.0.5.1 still had it. | `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` | yes |
| F13 | `imports/preview.html.erb:22` | Annotations silently missing from the import preview (`stringify_keys` changed in 8.0) | Use `@import.annotations` without `.stringify_keys` | yes |
| F14 | `import.rb:68` | Receipt CSV silently loses every DOI (`citation[:id]` no longer returns the `doi` primary key) | `citation&.doi` | yes |
| F15 | `import.rb:50-61` | **Data integrity:** `return` inside a transaction now commits. A failed import changed row counts from [2,22,2] to [3,23,3]. | `raise ActiveRecord::Rollback unless rows.all? { … save }`, track success in a `saved` flag | yes |
| F16 | `citation/provider.rb:13`, `config/secrets.yml`, citation test helper | Enrichment fails: ``undefined method `secrets'`` (removed in 7.2) | Move settings to `config/citation_provider.yml`, load with `config.x.citation_provider = config_for(:citation_provider)`, update provider and test helper, delete `secrets.yml` | yes |
| F17 | `citation_enrichment_job.rb:7` | When the provider is down: `Couldn't determine a delay based on :exponentially_longer`. No retry is scheduled and the citation is stuck "pending". | `wait: :polynomially_longer` (same backoff formula) | **no**: 7.0 raises on the new name |
| F18 | `digest_mailer.rb` | Digest covers the reader's local day ("October 04") instead of the promised UTC day, and includes a note from the wrong day. Since 7.1, time job arguments come back in the writer's time zone. | `requested_at = requested_at.in_time_zone(Time.zone)` | yes |

## Deployment and rollback finding

- **F19 (`user.rb:41`):** Rails 8.1 always writes a BigDecimal job argument in a format 7.0 workers cannot read. Observed when 7.0 read an 8.1-written digest job: `ActiveJob::DeserializationError: … BigDecimalSerializer is not known`. The digest is never sent, and the Redis reservation blocks a retry that day.
  - **Repair:** pass `reading_completion.to_s`. This matches the payload 7.0 already wrote, and the mailer already converts it with `BigDecimal(...)`.
  - **Verified:** digest jobs written through `User#request_digest` were read correctly in both directions (7.0 → 8.1 and 8.1 → 7.0).
- **F20 (source-based, not executed):** Rails 8.1 deprecates its built-in Sidekiq adapter, with removal planned for 8.2. It still works with sidekiq 6.5.12. Plan a separate upgrade to sidekiq 7.3.3+ (and redis 5, which changes what `Redis#sadd` returns) before Rails 8.2.

## Optional framework defaults

The app stays on `load_defaults 7.0`. I tested each setting alone in its own copy. These four need a code change before adoption:

| ID | Setting | Value today | Effect if adopted | Prep change |
|---|---|---|---|---|
| D01 | `default_column_serializer = nil` | YAML | All 46 tests error: `missing keyword: :coder` | `serialize :preferences, coder: YAML` (only after 7.1+) |
| D02 | `raise_on_assign_to_attr_readonly` | false | Every notebook update raises `ReadonlyAttributeError: slug`, because the form posts the slug | Stop permitting `:slug` on update |
| D03 | `raise_on_invalid_cache_expiration_time` | false | Exports index fails when a completed export has expired: "cannot be negative" | Never pass a negative `expires_in` (clamp it, or skip the cache for expired exports) |
| D04 | `postgresql_adapter_decode_dates` | false | Activity report fails: `no implicit conversion of Date into String` | Accept a `Date` in `daily_note_counts` |

- **No test failures when toggled (still require an adoption decision):** HTML5 sanitizers (rich text still keeps details/summary and strips script), HTML5 test parser, `belongs_to_required_validates_foreign_key`, after-commit callback ordering, missing finder order columns, relative-redirect `:raise`, hidden-field autocomplete, `escape_json_responses`, `enqueue_after_transaction_commit`, `strict_freshness` (suite only; the conditional-GET probe was inconclusive, see limits).
- **Session format:** with `use_message_serializer_for_metadata` adopted, a cookie written by 8.1 was still readable by 7.0.
- **Forced on you, not optional:** three settings were removed upstream, so their new behaviour applies regardless (`allow_deprecated_singular_associations_name` → F10, `commit_transaction_on_non_local_return` → F15, `use_big_decimal_serializer` → F19).
- Every default's current value, gating and effect is recorded in the review file.

## Rollout order

1. **On 7.0, before the bump:** ship F01, F02, F04, F05, F06, F08–F16, F18 and F19. All were validated together on 7.0.8.7 with 0 deprecations.
2. **Bump deploy:** the Rails bump to 8.1.0 plus F03, F07 and F17, all together.
   - Drain or stop 7.0 workers so 8.1 jobs aren't picked up by them.
   - Sessions survive in both directions (tested in production mode).
   - Stored data (`tags` JSON, `preferences` YAML, `settings` jsonb, blob metadata, rich-text body) is byte-identical when written by either version, and readable by the other.
3. **Rollback:** revert code and gem together. On 7.0, the F03 line would write YAML into `tags`. Drain any 8.1-written digest jobs first; they are safe once F19 is in.
4. **Later, one at a time:** the D01–D04 prep changes, then optional defaults. Separately, the Sidekiq/redis upgrade (F20).
5. **Developers:** local sessions reset once, because the dev secret file moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`.

## How each finding was validated

- **Experiments run:** each behaviour finding has a probe with expected values, unequal data and a control. Each probe ran three ways: on 7.0, on 8.1 with the repair, and on 8.1 with only that repair reverted.
- **Without the repair:** every probe reproduced the failure.
- **With the repair:** every probe passed and matched 7.0.
- **Boot-level findings** (F01–F04, F06) used the failing check logs plus the reverted-copy runs.
- **Source-based only:** F20, plus the version attributions, which come from changelogs and targeted git diffs.
- **Proposed, not run:** the checks listed for F20, D02–D04, and in the limits below.

## Limits

- **Browser:** no browser and no system tests. The Trix/actiontext.js change in 8.1 (new `action_text-trix` gem alongside the vendored `trix-1.3.5.js`) is unverified in a browser.
- **Not executed:** a real Sidekiq process, `bin/rails server` on puma 5 with rack 2.2, and production `assets:precompile`.
- **Inconclusive:** the `strict_freshness` conditional-GET probe returned 304 on both versions, where the source predicts 200.
- **Discarded test-environment artifacts:** fixture foreign-key errors from leftover probe data, and test-env session secret differences between versions.
- **Source coverage:** I read changelogs and upgrade-guide sections for every minor version (no missing tags) and used targeted source diffs. I did not review all 13,953 commits individually.

## Files

- Review (structural check passes: 153 candidates, 24 findings, 8 limits): `/home/user/planner-run/evidence-rails/review.json`
- Candidate repairs: `/home/user/planner-run/evidence-rails/candidate-repairs.diff`
- Evidence directory: `/home/user/planner-run/evidence-rails/` (coverage.json, entries.tsv, defaults.json, dependencies.tsv, dependencies/)
- Probes and their outputs: `/home/user/planner-run/probes/` (p_*.rb, pd_defaults.rb, out/)
- Lab run logs:
  - Baseline (7.0): `/tmp/gem-upgrade-20261014-9482-d5u450`
  - Upgraded (8.1): `/tmp/gem-upgrade-20261014-10652-i9mqzt`
  - Upgraded with single repairs reverted: `/tmp/gem-upgrade-20261014-19214-ahljpb`
  - 7.0 with the portable repairs: `/tmp/gem-upgrade-20261014-20022-mus8fv`
  - Default toggles: `/tmp/gem-upgrade-20261014-20323-35d5dd`

---

I haven't upgraded anything yet; this is only the plan. Your checkout is unchanged on `main`. The planner tested the upgrade in throwaway copies of the app, and the repairs are collected in `candidate-repairs.diff`.

The browser suite (`bin/rails test:system`) was not run, so the Trix editor change has not been checked in a browser.

If you want, I can apply the first stage (the repairs that also work on Rails 7.0) on a new branch, run the full test and browser suites, and then do the gem bump as a second step.