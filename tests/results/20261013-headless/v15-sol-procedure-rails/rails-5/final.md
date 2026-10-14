The upgrade-gem skill only plans upgrades and doesn't apply them, so I haven't bumped Rails. Your working tree is unchanged. The planning agent tested the upgrade on disposable copies of the app, and its plan is below as it reported it.

---

## Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is feasible with 18 required repairs. Without them, Rails 8.1.0 doesn't boot. With all of them applied in the lab, every check passes: bundle, boot, eager load, routes, `db:prepare`, all 46 tests, and production boot plus `assets:precompile`. One rollback hazard has no tested fix (O02), so treat 8.1 as roll-forward-only once readers save notes with attachments. Optional defaults are left alone; adopting four of them needs a small fix first.

The real checkout is unchanged (`git status` is clean at `ab732f5`). The lab services are cleaned up, and the lab copies and logs are kept.

### Required repairs
Each was observed failing on 8.1 in the upgraded lab, then passing after the single change. "7.0-OK" means the full suite also passed with that change on Rails 7.0.

| ID | Location | Observed failure → repair | 7.0 |
|---|---|---|---|
| R01 | Gemfile | Rails 8.1.0 pulls in json 3.1.0, whose `JSON.parse` no longer accepts a positional hash; Active Support passes one (`decoding.rb:25`). Every session read failed with `ArgumentError: wrong number of arguments (given 2, expected 1)`. → add `gem "json", "~> 2.7"` (locks 2.21.2). | not run |
| R02 | `config/initializers/action_text.rb:3` | Boot failed: `undefined method '+' for nil`. → set the allowed tags list inside `after_initialize` / `on_load(:action_view)`. | OK |
| R03 | `note.rb:10` | `enum status: …, _prefix:` removed → `enum :status, {…}, prefix: true` | OK |
| R04 | `note.rb:12` | `serialize :tags, JSON` → `serialize :tags, coder: JSON` | **No**: on 7.0 it silently uses YAML and views fail. Must ship with the Rails bump. |
| R05 | `routes.rb:18` | Multi-path `get` removed → two `get` lines. Route table is identical, including the `notes` and `journal` names. | OK |
| R06 | `note.rb:14` | `alias_attribute` on a store key raised `ArgumentError: … 'color' is not an attribute` → two `alias_method` lines (reader and writer) | OK |
| R07 | `citation/provider.rb`, `config/secrets.yml`, citation test | `Rails.application.secrets` removed → `config/citation_provider.yml` read by `config_for` into `config.x.citation_provider` | OK |
| R08 | `notes/index.html.erb:12` | `form_with(model: nil)` raised → drop `model: nil` | OK |
| R09 | `notes_controller.rb:12` | `where(notebooks:)` → `PG::UndefinedColumn` → `where(notebook:)` | OK |
| R10 | `export.rb:42` | `fragments.sum` → `TypeError: String can't be coerced into Integer`, every export job failed → `fragments.join` | OK |
| R11 | `note.rb:62` | `wait_until:` with an Integer → `undefined method 'utc'` → `Time.at(reminder_epoch)` | OK |
| R12 | `note.rb:45` | `to_time` now always keeps the zone (the setting is deprecated and has no effect). The postpone preview showed `08:00 (UTC-05:00)` instead of `09:00 (UTC-04:00)` → `.to_time.localtime(reminder_at.utc_offset) + 86_400` | OK |
| R13 | `citation_enrichment_job.rb:7` | `Couldn't determine a delay based on :exponentially_longer` → `:polynomially_longer` (same formula) | **No**: ship with the bump |
| R14 | `import.rb#apply` | **Data integrity:** `return` inside a transaction now commits. An import with a later invalid row saved the import and earlier notes (counts went from `[0,3,0,1]` to `[1,4,1,2]`). → `raise ActiveRecord::Rollback unless rows.all?(&:save)` plus a success flag | OK |
| R15 | `import.rb:72` | `citation[:id]` (Citation's key is `doi`) → receipt DOI column was empty → `citation&.doi` | OK |
| R16 | `imports/preview.html.erb:22` | `stringify_keys` now converts Integer keys too, so annotations vanished from the preview → drop `stringify_keys` | OK |
| R17 | `digest_mailer.rb` | Active Job now keeps the reader's time zone, so the digest covered the wrong day ("October 04" instead of "October 05") → `requested_at = requested_at.in_time_zone` | OK |
| R18 | `config/environments/test.rb:31` | `show_exceptions = false` is no longer valid, so authorization tests failed → `:none` | **No**: ship with the bump |

R03, R05 and R09 had no text match in the generated evidence; they surfaced only through the lab runs.

### Rollout findings
- **O01 (BigDecimal job argument):** 8.1 always uses a BigDecimal serializer for job arguments, even under `load_defaults 7.0`. A 7.0 worker fails on 8.1-written digest jobs: `ActiveJob::DeserializationError: … BigDecimalSerializer is not known`. Repair: enqueue `reading_completion.to_s`. Tested both directions between 7.0 and 8.1.
- **O02 (rollback hazard, no tested fix):** attachment IDs that 8.1 writes into rich-text note bodies can't be read by 7.0. After a rollback, notes saved on 8.1 with attachments lose them; observed `expected=[930001] actual=[]`. Cause: `activesupport-8.1.0/.../messages/metadata.rb:138` combined with `globalid-1.4.0/.../verifier.rb:7`. A custom-verifier fix I tried failed. Rolling back after attachment writes needs a data step to re-sign those IDs; I haven't run that.
- **O03:** in development and test, Rails 7.1+ reads `tmp/local_secret.txt` instead of `tmp/development_secret.txt`. Developers should copy the file or they'll be signed out. Production is unaffected; production-env sessions worked in both directions.
- **O04:** `schema.rb` columns are sorted alphabetically from 8.1 (from the upgrade guide). Dump once in the upgrade commit; the diff should be reordering only.
- **O05:** the built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2. It works now (real Redis round trips). Plan a Sidekiq ≥ 7.3.3 upgrade separately.

These worked in both directions and need no action: tags JSON, settings jsonb and preferences YAML (byte-identical), production session cookies, and 7.0-written attachments read on 8.1.

### Optional defaults
Keep `load_defaults 7.0` for this upgrade. Each setting was run alone against the full suite in a separate copy.
- **Needs a fix before adopting:**
  - D01 `raise_on_assign_to_attr_readonly` → `ReadonlyAttributeError: slug`. First stop permitting `:slug` and remove its hidden field.
  - D02 `postgresql_adapter_decode_dates` → `TypeError` in `Notebook#daily_note_counts`.
  - D03 `raise_on_invalid_cache_expiration_time` → "Cache expiration time is invalid, cannot be negative: -60.0" in `_export.html.erb:26`.
  - D04 `default_column_serializer = nil` → `missing keyword: :coder`. Needs `serialize :preferences, coder: YAML`, which only works after the bump.
- **D05 (message-serializer settings):** session cookies stayed readable on 7.0, but the attachment-ID problem from O02 remains. Adopt only after the rollback window closes.
- **D06:** six template settings are removed or no longer have an effect. Setting three of them breaks boot (`Invalid option key: allow_deprecated_parameters_hash_equality=`). Don't add them.
- All other defaults ran green, and the reasons are recorded per setting.

### Rollout order
1. **Deploy on 7.0 first** (each change passed the suite on 7.0): R02, R03, R05–R12, R14–R17 and O01. Let the queues drain.
2. **Upgrade deploy:** Rails 8.1.0 together with R01, R04, R13 and R18. Workers and web go out on the same release. Dump the schema (O04) and tell developers about O03.
3. **Rollback window:** rolling back is safe only before readers save notes with attachments (O02).
4. **Later:** adopt optional defaults one per deploy with their fixes, then upgrade Sidekiq before Rails 8.2.

### Limits
- **Executed:** everything marked "observed" or "tested" above, with logs under the lab `runs/` directories.
- **Source-based:** O04, and R01 on Rails 7.0.
- **Proposed, not run:** the O02 re-signing step, the O03 rename check, and D01–D03 re-runs with their fixes.
- **Not covered:**
  - There are no browser tests. Trix 1.3.5 with Action Text 8.1's JavaScript, direct uploads and Turbo are unverified.
  - `strict_freshness` (conditional downloads) is covered only by the green suite.
  - I didn't run a real Sidekiq server or `RAILS_LOG_TO_STDOUT`.
  - The 13,954 upstream commits weren't read individually. I used changelogs, the upgrade guides and targeted source files.

### Files
- Evidence: `/home/user/planner-run/evidence-rails/`, with `review.json` (closed: 153 candidates, 29 findings, 6 limits, 75 check runs), `repairs.diff` (full repair diff) and `dependencies.tsv`.
- Probes: `/home/user/planner-run/probes-rails/` (output in `out/`).
- Labs (logs kept):
  - Baseline 7.0: `/tmp/gem-upgrade-20261014-9575-ya72d2`
  - Upgraded 8.1: `/tmp/gem-upgrade-20261014-10780-h6iwgx` (final runs `runs/*final-*`)
  - Defaults: `/tmp/gem-upgrade-20261014-15986-gpuh9j`
  - 7.0 compatibility: `/tmp/gem-upgrade-20261014-20235-tdy5rc`

---

**Before you go ahead:**
- **Attachments can be lost on rollback (O02).** Once readers save notes with attachments on 8.1, going back to 7.0 drops those attachments. There's no tested fix, so decide up front whether you'll treat the upgrade as one-way.
- **Imports can save partial data (R14).** On 8.1, an import with a later bad row keeps the import and the earlier notes. That fix can ship on 7.0 now, ahead of the upgrade.
- **Browser behaviour is untested.** The browser suite wasn't run, so the editor, direct uploads and Turbo on 8.1 haven't been checked.

If you want, I can apply the plan, starting with the changes that are safe to ship on 7.0.