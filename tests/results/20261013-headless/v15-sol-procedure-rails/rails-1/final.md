# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is doable, but it needs about 20 small code changes plus one gem constraint first. A plain bump to 8.1.0 doesn't boot (the first error is at `config/initializers/action_text.rb:3`). With all the repairs, everything passes in the lab: boot, eager load, routes, `db:prepare`, all 46 tests, production-mode boot and `assets:precompile`.

Four of the problems don't raise any error; they just change behavior. The worst is that importing a CSV with a bad row now partly saves it (F17). Most repairs also work on 7.0, so they can ship before the version bump. A lab copy running 7.0 with those repairs applied passed all 46 tests. I didn't edit or run anything in the real checkout; `git status` is clean.

## Required changes
"Works on 7.0" means I tested the repair on 7.0.8.7 too (in the lab copy C).

| # | Where | Upstream cause | Effect on 8.1 without the repair | Repair | Works on 7.0 |
|---|---|---|---|---|---|
| F01 | `config/initializers/action_text.rb:3` | `allowed_tags` starts empty (nil) since 7.1 | App won't boot: `undefined method '+' for nil` | In `after_initialize`, set `allowed_tags = sanitizer.class.allowed_tags.to_a + [attachment tag, "figure", "figcaption", "details", "summary"]` | yes |
| F02 | `config/routes.rb:18` | One route with two paths removed in 8.1 | Routes fail: `Wrong number of arguments (expect 1, got 2)` | Two `get` lines with `as: :notes` and `as: :journal` | yes |
| F03 | `note.rb:10` | Keyword-style `enum` removed in 8.0 | Note class fails to load | `enum :status, {…}, prefix: true` | yes |
| F04 | `note.rb:12` | Positional coder for `serialize` removed in 7.2 | Note class fails to load | `serialize :tags, coder: JSON` (stored text identical) | no; ship with the bump |
| F05 | Gemfile | activesupport accepts any `json` version, so the bump picks json 3.1.0, which rejects how Rails 8.1.0 calls `JSON.parse` | Any request that reads the session cookie returns 500: `wrong number of arguments (given 2, expected 1)` | `gem "json", "< 3"` (resolves 2.21.2) | yes |
| F06 | `note.rb:14` | `alias_attribute` to a non-column removed in 7.2 | `Note model aliases 'color', but 'color' is not an attribute` | `alias_method` for `highlight_color` and `highlight_color=` | yes |
| F07 | `config/environments/test.rb:31` | `true`/`false` values removed in 7.2 | Test-only: errors show as error pages, so "not found" assertions fail | `show_exceptions = :none` | no |
| F08 | `citation/provider.rb:13`, `config/secrets.yml`, citation enrichment test, docs | `Rails.application.secrets` removed in 7.2 | `undefined method 'secrets'` | Move settings to `config/citation_provider.yml` and load with `config.x.citation_provider = config_for(:citation_provider)` | yes |
| F09 | `citation_enrichment_job.rb:7` | `:exponentially_longer` removed in 7.2 | When the provider is down: `Couldn't determine a delay…`, and the failure is never recorded | `:polynomially_longer` (same delay formula) | no |
| F10 | `notes/index.html.erb:12` | `form_with model: nil` removed in 8.0 | The notes list (page after sign-in) raises an error | Drop `model: nil` | yes |
| F11 | `notes_controller.rb:12` | Plural name for a singular association removed in 7.2 | Notebook filter fails: `column notes.notebooks does not exist` | `where(notebook: …)` | yes |
| F12 | `export.rb:42` | Rails' string-joining `Enumerable#sum` removed in 7.1 | Every export fails: `String can't be coerced into Integer` | `fragments.join` | yes |
| F13 | `note.rb:61` | Numeric `scheduled_at` removed in 7.2 | Scheduling a reminder: `undefined method 'utc' for … Integer` | `wait_until: Time.at(reminder_epoch)` | yes |
| F14 | `note.rb:44` | upstream commit `c79dc282d6`: `to_time` always keeps the time zone | Silent: the "24 hours later" text shows `08:00-05:00` instead of `09:00-04:00` | `reminder_at.getlocal(reminder_at.utc_offset) + 86_400` | yes |
| F15 | `imports/preview.html.erb:22` | `stringify_keys` now converts Integer keys (8.0) | Silent: annotations disappear from the import preview | Drop `.stringify_keys` | yes |
| F16 | `import.rb` `receipt` | `record[:id]` no longer returns a custom primary key (7.2) | Silent: the receipt CSV has an empty DOI column | Use `note.citation_doi` | yes |
| F17 | `import.rb` `apply` | `return` inside a transaction now commits (7.2) | **Silent data loss: an invalid CSV is partly saved** (one extra import, note and citation) | `raise ActiveRecord::Rollback unless rows.all? { … }` | yes |
| F18 | `digest_mailer.rb` | Time arguments to jobs now keep their zone (7.0.9) | Silent: digest covers the reader's local day ("October 04" instead of 05) | `requested_at.in_time_zone(Time.zone)` | yes |
| F20 | `exports/_export.html.erb:26` | Negative `expires_in` is now reported as an error (7.1) | Each render of an expired export logs and reports `Cache expiration time is invalid` | `expires_in: [export.expires_at - Time.current, 1.second].max` | yes |

For F20 I first tried `cache_if export.downloadable?`, but it broke an existing test ("the cached availability indicator does not authorize a download"), so I rejected it. The full diff is in `repairs-8.1.patch`.

## Optional defaults
Keep `load_defaults 7.0` for the upgrade itself. I tested each setting on its own in a separate lab copy. With the three companion changes below, `load_defaults 8.1` passes all 46 tests.

- **D1** `default_column_serializer = nil`: without a change, Notebook fails to load (`missing keyword: :coder`). Add `serialize :preferences, coder: YAML`; the stored YAML is unchanged.
- **D2** `raise_on_assign_to_attr_readonly`: saving notebook settings raises `ReadonlyAttributeError: slug`. Remove `:slug` from `notebook_params` and keep the hidden field, which a test checks for.
- **D3** `postgresql_adapter_decode_dates`: the activity report raises `TypeError: no implicit conversion of Date into String`. Use `Date.iso8601(day.to_s)`.
- **D4** `message_serializer` / `use_message_serializer_for_metadata`: after adopting, Rails 7.0 cannot read attachment IDs that 8.1 stores in rich-text bodies. In the lab, 7.0 failed with `TypeError` (or `NoMethodError` with the metadata setting too). Only adopt once rolling back to 7.0 is off the table.
- `raise_on_invalid_cache_expiration_time` makes expired exports raise unless F20 is in place.
- These made no observable difference: `strict_freshness` (Rack already answers 304 on an ETag match), relative-redirect `:raise`, finder order columns, both HTML5 sanitizers, HTML5 test parsing, and the `belongs_to` foreign-key check.
- `enqueue_after_transaction_commit` was removed in 8.1 and is off by default; keep it off, because `with_lock` rollback on a failed enqueue depends on it.

## Rollout order
1. **Deploy on 7.0 first:** F01–F03, F05, F06, F08 (set the same `CITATION_PROVIDER_*` variables in every environment), F10–F18, F20, and **R1**. R1 means passing `reading_completion.to_s` to `DigestJob`. Without it, a digest queued by 8.1 and run by a 7.0 worker fails with `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. With it, digest jobs run in both directions.
2. **Upgrade:** bump to 8.1.0 together with F04, F07 and F09, keeping `load_defaults 7.0`. Reminder and enrichment jobs queued by either version run on the other.
3. **Later deploys:** the optional defaults with their companions, with D4 last.
4. **R2, before Rails 8.2:** Rails' built-in Sidekiq adapter is deprecated (the warning shows in development). Upgrading Sidekiq to 7.3.3+ is a separate project.

Rollback: F17 only went wrong in the lab's 8.1 copy, so production has no partly saved imports. Still, check for them if any interim build ever ran. Leave D4 out until rollback is no longer needed.

## Evidence and validation
- **Executed:** each finding has a probe in `/home/user/planner-run/probes`, plus test runs for F07, F10 and F11. Each was run three ways: on 7.0 (passes), on 8.1 without that one repair (fails with the error quoted above), and on 8.1 with it (passes).
- **Stored and queued formats, both directions:** tags JSON, preferences YAML, digest and reminder job payloads, and attachment IDs. Each version wrote data that the other version read back.
- **Not affected:**
  - uri 1.1.2: provider URL validation is identical (11 edge URLs).
  - bigdecimal 4.1.3: completion arithmetic is identical.
- **Not executed (limits):**
  - **Browser:** no system tests, so Trix 1.3.5 with 8.1's `actiontext.js` and direct uploads are unverified. Proposed: a signed-in reader attaches a PNG and saves; check that the figure renders and the blob exists, compared with the same flow on 7.0.
  - **Running services:** no Puma `rails server` start in production and no real Sidekiq worker process.
  - **Source-based only:** the development-only session reset from the secret file rename, and cache-format rollback effects if 7.1+ defaults are adopted.
  - **Coverage:** I didn't read the 13,954 commits one by one; I used the changelogs, upgrade guides and targeted source.
- Two orphan export rows left by probes that failed on purpose were lab state, not findings.

## Files
- Evidence directory: `/home/user/planner-run/evidence-rails`, including `review.json` (passes `gem-upgrade-review check`) and `repairs-8.1.patch`
- Probes: `/home/user/planner-run/probes`
- Review input script: `/home/user/planner-run/review-input/fill_review.py`
- Lab copies (services cleaned up, logs kept under `runs/`):
  - 7.0 baseline: `/tmp/gem-upgrade-20261014-9493-2f8nrj`
  - 8.1 repaired: `/tmp/gem-upgrade-20261014-10716-95ddhg` (first failure: `runs/20261014T154134-230927-unmodified-boot/output.log`)
  - 7.0 plus compatible repairs (C): `/tmp/gem-upgrade-20261014-17052-wf0yq5`
  - Defaults experiments: `/tmp/gem-upgrade-20261014-17438-wta2fu`

---

**My notes:**
- This is only a plan. Nothing in your repo has changed.
- The finding numbers skip F19. The planner didn't say why, so a finding may have been dropped. I can ask it if you want.
- The browser suite (`bin/rails test:system`) wasn't run, so the Trix and direct-upload flow on 8.1 is still unchecked.

Do you want me to start on step 1? That means applying the repairs that also work on 7.0, plus R1, on a branch.