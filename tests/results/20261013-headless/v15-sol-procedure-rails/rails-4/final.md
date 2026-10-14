I haven't upgraded Rails yet. I only produced a plan, and your checkout is unchanged. Moving from 7.0.8.7 to 8.1.0 needs 19 code and config changes; without them the app won't start. Here is the plan from the upgrade planner, as written:

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

## Verdict

The upgrade works, but it needs 19 code and configuration changes. Without them the app doesn't even boot. With all of them, the disposable upgraded copy passes bundle check, boot, eager load, routes, `db:prepare`, all 46 tests (340 assertions), the production asset build and a production eager-load boot. Final run: `/tmp/gem-upgrade-20261014-10692-5im210/runs/*-final-tests/output.log`.

Six of the problems would not crash anything. They would silently produce wrong results: partial imports, receipts missing DOIs, import previews missing annotations, digests for the wrong day, a changed reminder preview, and jobs that old workers can't read. Keep `config.load_defaults 7.0` for the whole rollout.

Experiments ran only in disposable copies under `/tmp`. The real checkout is unchanged (`git status` is clean, HEAD is ab732f5).

## Required repairs

These can land on 7.0 first unless marked "ship with the bump". Labels: **executed** means I observed the failure and then the fix in the copy; **source** means it comes from reading upstream code.

| ID | Location | Problem on 8.1 (observed) | Repair | Evidence |
|---|---|---|---|---|
| F1 | `config/initializers/action_text.rb:3` | ``undefined method `+' for nil`` and the app won't boot. `allowed_tags` is now nil by default. | After initialization, set `allowed_tags = sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption", "details", "summary"]` | executed |
| F2 | `note.rb:10` | `wrong number of arguments (given 0, expected 1..2)` | `enum :status, {...}, prefix: true` | executed |
| F3 | `note.rb:12` | `given 2, expected 1` | `serialize :tags, coder: JSON` (ship with the bump; this form only exists from 7.1) | executed |
| F4 | `routes.rb:18` | `Wrong number of arguments (expect 1, got 2)` | Two separate `get` lines; the route table is otherwise identical to before | executed |
| F5 | Gemfile (json is a hidden dependency) | Rails 8.1's JSON decoding (`activesupport-8.1.0 json/decoding.rb:25`) passes options in a form json 3.1.0 rejects (`json/common.rb:291`), causing 500s on most pages | Add `gem "json", "< 3"` with a comment pointing at that line (resolves to 2.21.2) | executed |
| F6 | `note.rb:14` | ``Note model aliases `color`, but `color` is not an attribute`` | `alias_method` for `highlight_color` and `highlight_color=` | executed |
| F7 | `environments/test.rb:31` | `false` is now treated like "show all", so ownership tests stop seeing `RecordNotFound` | `show_exceptions = :none` (ship with the bump) | executed |
| F8 | `notes/index.html.erb:12` | `Passed nil to the :model argument` | Remove `model: nil` | executed |
| F9 | `notes_controller.rb:12` | `column notes.notebooks does not exist` | `where(notebook: @notebook)` | executed |
| F10 | `citation/provider.rb:13`, `config/secrets.yml`, the citation test | ``undefined method `secrets'`` | Move the same settings to `config/citation_provider.yml`, load with `config.x.citation_provider = config_for(:citation_provider)`, update the test, `bin/citation-provider`, ARCHITECTURE.md and CONTRIBUTING.md | executed |
| F11 | `citation_enrichment_job.rb:5` | ``Couldn't determine a delay based on :exponentially_longer`` | `:polynomially_longer`, which is the same formula (ship with the bump) | executed |
| F12 | `export.rb:42` | `TypeError: String can't be coerced into Integer`; every export fails | `fragments.join` | executed |
| F13 | `note.rb:63` | ``undefined method `utc' for an instance of Integer`` | `wait_until: Time.at(reminder_epoch)` | executed |
| F14 | `note.rb:46` | The next-day reminder preview across a daylight-saving change shows `08:00:00-05:00` instead of the documented `09:00:00-04:00` | `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400` | executed |
| F15 | `imports/preview.html.erb:22` | Import preview drops every annotation | Use `@import.annotations` without `.stringify_keys` | executed |
| F16 | `import.rb` `apply` | A failing row now **commits** a partial import. Probe counts went `[1,2,1]` → `[2,3,2]` | `raise ActiveRecord::Rollback unless rows.all?(&:save)` and return a flag set only on success | executed |
| F17 | `import.rb:69` | Receipt CSV loses every DOI | `citation&.doi` | executed |
| F18 | `digest_mailer.rb` | The job now keeps the reader's time zone, so digests are titled "October 04" instead of "October 05" | `params[:requested_at].in_time_zone("UTC")` | executed |
| R1 | `user.rb:41` | Jobs written by 8.1 make 7.0 workers fail: `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` | `reading_completion.to_s` (the mailer already does `BigDecimal(...)`), which keeps one job format both ways | executed |

The combined diff is at `/home/user/planner-run/probes-rails/upgrade-repairs.diff`. Its `cable.yml` change is a lab artifact; don't apply it. The deletion of `secrets.yml` and the new `citation_provider.yml` appear there as "Only in" lines.

## Rollout items

- **R2 – Sidekiq adapter deprecated (source):** Rails 8.1 deprecates its built-in Sidekiq adapter and will remove it in 8.2. Sidekiq 6.5.12 still works on 8.1. Plan a Sidekiq ≥ 7.3.3 upgrade before 8.2.
- **R3 – Trix versions mismatch (unverified, needs a browser):** 8.1 supplies Trix 2.1.19 CSS through the new `action_text-trix` gem, while the layout still loads the bundled `trix-1.3.5.js`. Recommendation: switch the layout to `javascript_include_tag "trix"`, delete `vendor/javascript/trix-1.3.5.*`, and update the layout comment.
- **R4 – schema.rb rewrite (executed):** 8.1 dumps `Schema[8.1]`, writes `pg_catalog.plpgsql`, and sorts columns alphabetically. Commit a regenerated `schema.rb` with the bump. Rolling back needs the old file.
- **R5 – Cookies, caches, dev secret (source; one default executed):** Keep the 7.0 cookie, cache and message formats until every process runs 8.1. Developers should rename `tmp/development_secret.txt` to `tmp/local_secret.txt`, or they'll lose local sessions once.

## Optional new defaults

Each was tested alone in a separate copy. All are currently at their 7.0 value and none is required.

- **Breaks today if adopted:**
  - **D1** – `raise_on_invalid_cache_expiration_time` makes the exports page raise `Cache expiration time is invalid, cannot be negative: -60.0` at `_export.html.erb:26`. Fix first: only pass `expires_in` while the export is downloadable.
  - **D2** – `raise_on_assign_to_attr_readonly` makes notebook settings raise `ReadonlyAttributeError: slug`. Fix first: stop permitting `:slug` and drop the hidden field.
  - **D3** – `default_column_serializer = nil` fails with `missing keyword: :coder` at `notebook.rb:7`. Fix first: `serialize :preferences, coder: YAML`.
  - **D4** – `postgresql_adapter_decode_dates` makes the activity report fail with `no implicit conversion of Date into String` at `notebook.rb:40`.
- **Suite passes on its own:** strict_freshness, sanitizer_vendor (with the F1 fix), dom_testing html5, remove_hidden_field_autocomplete (still check back-navigation in a browser), raise_on_missing_required_finder_order_columns, belongs_to_required_validates_foreign_key, after-transaction callback order, message_serializer.
- **Removed in 8.x and no longer optional:** big_decimal serializer (R1), non-local-return commit (F16), singular association names (F9), to_time zone (F14). `enqueue_after_transaction_commit` defaults to false in 8.1, so jobs still enqueue immediately as they do on 7.0.

## Rollout order

1. **On 7.0:** land the changes that work there: F1, F2, F4, F5, F6, F8–F10, F12–F18, and R1. Deploy, and let any queued `DigestJob`s drain.
2. **The bump:** Rails 8.1.0 plus F3, F7, F11, the `json < 3` constraint, the regenerated `schema.rb` (R4), and the Trix switch (R3) once verified in a browser.
3. **Deploy:** job payloads now read correctly in both directions between 7.0 and 8.1 (executed with the R1 fix).
4. **Rollback:** keep `load_defaults 7.0` and the old `schema.rb` available. If any 8.1 BigDecimal-format job slipped through, drain it on an 8.1 worker before rolling back.
5. **Later, one per deploy:** adopt optional defaults after their pre-fixes (D1–D4).

## How the findings were validated (executed)

- **Probes:** `probe_import.rb`, `probe_reminder_export.rb` and `probe_digest_job.rb` in `/home/user/planner-run/probes-rails/`. Each was run on the 7.0 baseline (pass), on 8.1 without that repair (fail) and on 8.1 with it (pass), each with an unchanged control case:
  - a valid import
  - an uncited row
  - a reminder date with no daylight-saving change
  - an empty notebook export
  - a UTC reader
- **Job payloads:** captured through the real `User#request_digest` and saved in `payloads/`. 7.0-written payloads read correctly on 8.1. 8.1-written payloads fail on 7.0 until R1 is applied, then pass.
- **Optional defaults:** copy `/tmp/gem-upgrade-20261014-15554-gv3ze0`, runs `def-*`.

## Limits

- **No browser:** there is no Chrome/chromedriver and the app has no system tests, so R3 (Trix) and the hidden-field autocomplete change are unverified in a browser.
- **No live Sidekiq worker:** jobs were tested by executing captured payloads directly.
- **Production mode:** checked only by asset precompile and an eager-load boot, not by serving requests.
- **Not run:** `bin/citation-provider`.
- **Upstream reading:** individual commits weren't read. I used changelogs, the upgrade guides and the actual gem source instead.
- **Intermediate versions:** 7.1, 7.2 and 8.0 weren't installed separately; the release where each change first appears comes from the changelogs.

## Files

- Review (structural check passes: 153 candidates, 27 findings, 8 limits): `/home/user/planner-run/evidence-rails/review.json`
- Evidence: `/home/user/planner-run/evidence-rails/` (coverage.json, entries.tsv, defaults.json, dependencies.tsv, dependencies/)
- Probes, payloads and repair diff: `/home/user/planner-run/probes-rails/`
- Labs (services cleaned up, logs kept):
  - baseline: `/tmp/gem-upgrade-20261014-9505-pmujj7`
  - upgraded: `/tmp/gem-upgrade-20261014-10692-5im210`
  - upgraded without repairs: `/tmp/gem-upgrade-20261014-14907-c44oq3`
  - optional defaults: `/tmp/gem-upgrade-20261014-15554-gv3ze0`

---

**What I'd do next:** I recommend doing this in two steps, as the rollout order above lays out. First, a change on Rails 7.0 with the fixes that work there (step 1). Second, a separate change that bumps Rails to 8.1.0 (step 2). Before step 2 ships, someone should check the Trix editor switch (R3) in a real browser, because that couldn't be tested here.

Should I start on the step 1 fixes on a new branch?