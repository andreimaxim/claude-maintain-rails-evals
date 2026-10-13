# Plan: upgrading Rails 7.0.8.7 to 8.1.0 in Margin Notes

Rails 8.1.0 does not boot this application as it stands. In a disposable copy it took about 20 code changes to get the suite green, and several of them fix behavior changes that the tests only partly catch. Seventeen of those changes, plus a new config file and a test-helper edit, can go in now while still on 7.0.8.7: with them applied the full suite passes on 7.0 (46 runs, 0 failures). Three changes have to wait until the 7.1 step. With everything applied, the suite passes on 8.1.0 under both `load_defaults 7.0` and `load_defaults 8.1`. The working repository was not modified.

## How the experiments were run
- **Where:** `/tmp/mn-exp`, with a private Postgres 15 cluster (socket in `/tmp/mn-exp`, port 55432) and a private Redis on port 56379 (no persistence). Both are now stopped. Environment settings are in `/tmp/mn-exp/env.sh`; gems for the 8.1 variants went into `/tmp/mn-exp/bundle81`. Active Storage, cache and mail used each copy's own `tmp` directory or the test adapters.
- **Copies:**

| Copy | What it is | Result | Log |
|---|---|---|---|
| `base` | Unmodified 7.0.8.7 | 46 runs, all pass | `logs/base-test.log` |
| `v81` | Rails pinned to 8.1.0, everything else as resolved by `bundle lock --update rails`, then patched one break at a time | Failures recorded at each step | `logs/v81-test*.log` |
| `v81` with `load_defaults` 7.1, 7.2, 8.0, 8.1 | Same, to see which new defaults the app reacts to | Recorded | `logs/v81-defaults-*.log` |
| `prep70` | 7.0.8.7 plus the preparatory patch | 46 runs, all pass | `logs/prep70-test.log` |
| `prep81` | 8.1.0 plus the preparatory patch plus the 7.1-only edits | All pass under `load_defaults` 7.0 and 8.1; production eager load and `assets:precompile` succeed | `logs/prep81-*.log` |

- **What 8.1.0 resolved to:** rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, minitest 5.27.0, concurrent-ruby 1.3.4. It also pulled in action_text-trix 2.1.19 and **json 3.1.0**; the experiments pin json to 2.21.2.
- **Patch and scripts:** `/tmp/mn-exp/scripts/prep.py` makes the edits; the result is `/tmp/mn-exp/patches/prep.diff` and the files under `patches/`. The ActionText initializer used is `/tmp/mn-exp/action_text_patch.rb`. The job-payload scripts are `scripts/jobs_dump.rb` and `scripts/jobs_load.rb`; their output is `logs/payload-70.json` and `logs/payload-81.json`.
- **Release notes:** upstream changelogs and `load_defaults` tables were read from the 7.1.0, 7.2.0, 8.0.0 and 8.1.0 gems (`/tmp/mn-exp/gemsrc`).
- **Not run:** 7.1.x, 7.2.x and 8.0.x were not run. For those versions the attributions come from the changelogs, not from running them.

## Required changes
In the table, "Works on 7.0?" means verified on 7.0 in `prep70` unless marked otherwise.

| # | Release | Affected code | What happens on 8.1 (how we know) | Recommendation | Works on 7.0? |
|---|---|---|---|---|---|
| 1 | Dependency | Gemfile | Every serialized-column read fails with `ArgumentError` in `JSON.parse`: activesupport 8.1.0 passes a positional options hash, and json 3.x only accepts keywords (run) | Pin `gem "json", "< 3"`. Check whether a later 8.1.x fixes this | Yes (no-op) |
| 2 | 7.1 changed the default; 8.1 permanent | `config/initializers/action_text.rb` | App does not boot: `allowed_tags` is now nil, so `+=` raises `NoMethodError` (run) | Set the tags in an `after_initialize` / `on_load(:action_view)` block that starts from `allowed_tags \|\| default list` (see `action_text_patch.rb`) | Yes. `<details>` is kept and `<script>` stripped on both versions (run) |
| 3 | 7.2 removed | `enum status:` with keyword syntax in `app/models/note.rb` | Load error (run) | `enum :status, {...}, prefix: true` | Yes |
| 4 | 7.2 removed | `serialize :tags, JSON` and `serialize :preferences` | Load error (run) | Switch to `coder: JSON` and `coder: YAML`, **in the same commit as the 7.1 bump**. On 7.0 the `coder:` keyword is silently ignored and tags would be written as YAML (`"---\n- a\n"`, run). Keeping JSON for tags and YAML for preferences keeps stored rows readable | **No** |
| 5 | 7.2 removed | `alias_attribute :highlight_color, :color` (target is a store accessor) | `ArgumentError` (run) | Define `highlight_color` and `highlight_color=` by hand | Yes |
| 6 | 7.2 removed | `Rails.application.secrets` in `app/models/citation/provider.rb`, `config/secrets.yml`, and the test helper | `NoMethodError` (run) | Move the settings to `config/citation_provider.yml` with `config.x.citation_provider = config_for(:citation_provider)`. Update the test helper, `CONTRIBUTING.md`, `ARCHITECTURE.md` and the comment in `bin/citation-provider` | Yes. In production with no env vars set, all three values are nil, as before |
| 7 | 8.1 removed | `get "/notes", "/journal", ...` in `config/routes.rb` | Routes fail to load (run) | Use two `get` lines. The route names `notes` and `journal` stay the same (run) | Yes |
| 8 | 8.0 removed | `form_with(model: nil, ...)` in `app/views/notes/index.html.erb` | Template error (run) | Drop `model: nil` | Yes |
| 9 | 7.2 removed | `where(notebooks: @notebook)` in `NotesController#index` | `PG::UndefinedColumn notes.notebooks`, so the notebook filter breaks (run) | `where(notebook: @notebook)` | Yes |
| 10 | 7.2 removed | `set(wait_until: reminder_epoch)` with an Integer, in `Note#schedule_reminder` | `undefined method utc for Integer`, so scheduling a reminder returns 500 (run) | `wait_until: Time.at(reminder_epoch)` | Yes |
| 11 | 7.1 removed | `fragments.sum` in `Export#generate` | `TypeError`, so every export job fails (run) | `fragments.join` | Yes |
| 12 | 7.2 removed | `retry_on ..., wait: :exponentially_longer` in `CitationEnrichmentJob` | Error "Couldn't determine a delay"; 2 provider requests instead of 6 (run) | `wait: ->(executions) { executions**4 + 2 }` (the same formula). Optionally switch to `:polynomially_longer` once on 7.1 | Yes |
| 13 | 7.2 changed behavior | `citation[:id]` in `Import#receipt` (Citation's primary key is `doi`) | The receipt CSV's DOI column would come out empty. Inferred from the changelog; masked in the run because the earlier rows failed first | `note.citation_doi` | Yes |
| 14 | 7.1 config; 7.2 removed the old behavior | `return false` inside `transaction` in `Import#apply` | The transaction now **commits**, so a partial import is saved (row counts changed from `[0,3,0,1]` to `[1,4,1,2]`, run) | Set a flag, `raise ActiveRecord::Rollback`, return the flag | Yes |
| 15 | 8.0 | `@import.annotations.stringify_keys` in `imports/preview.html.erb` | Integer line keys become strings, so annotations disappear from the preview (run) | Drop `.stringify_keys` | Yes |
| 16 | 7.2 default, permanent in 8.1 | `Date.iso8601(day)` in `Notebook#daily_note_counts` | Postgres now returns a `Date`, so `Date.iso8601` gets the wrong type (from the changelog; masked in the run) | `Date.iso8601(day.to_s)` | Yes |
| 17 | 7.2 | `DigestMailer` with a time-zone argument | The job now restores the reader's zone, so the digest covers the reader's local day rather than the documented UTC day ("October 04" vs "October 05", run) | Convert with `params[:requested_at].in_time_zone(Time.zone)`. Changing the digest to the local day would be a product decision | Yes |
| 18 | 8.1 removed | `reminder_at.to_time + 86_400` in `Note#next_day_reminder_at` | `to_time` now always keeps the zone, so the 24-hours-later preview shows the new offset across DST, not the documented one (run) | `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)` | Yes |
| 19 | 7.2 removed boolean | `show_exceptions = false` in `config/environments/test.rb` | `false` is treated as `:all`, so seven "another reader cannot reach…" tests stop testing access control (run) | Set `:none` **at the 7.1 step** (on 7.0 a symbol is truthy). Using `:rescuable` would mean rewriting those tests to assert 404s | **No** |
| 20 | 7.2 removed | BigDecimal argument in `User#request_digest` | Breaks during rollout, see below | Pass `reading_completion.to_s` | Yes |

## Mixed-version rollout and rollback
**DigestJob's BigDecimal argument.** A 7.0 worker cannot read a DigestJob enqueued by 8.1: it fails with `DeserializationError: BigDecimalSerializer is not known`. This matters for a staggered deploy or a rollback. Deploy change 20 before the Rails bump; the payload with the string argument was verified readable in both directions.

**Other job payloads are safe.**
- The extra `time_zone` and `scheduled_at` keys written by 8.1 are ignored by 7.0.
- Far-future NoteReminderJob payloads round-trip in both directions.
- The Sidekiq wrapper class name is the same on both versions.

All of these were verified by running.

**Import partial commits.** If 7.1 or later goes out without change 14, any partially committed import stays in the database. A rollback does not repair it.

**Stored data.**
- Tags must stay JSON and preferences YAML (change 4).
- The ActionText bodies already stored were rendered correctly by the 8.1 tests.

**Schema file.** Once regenerated on 8.1, `db/schema.rb` will say `Schema[8.1]` and 8.1 may also reorder its columns. 7.0 cannot load `Schema[8.1]`. Don't commit a regenerated `schema.rb` until the rollback window has closed.

**Recommended order.**
1. Land the preparatory changes on 7.0.
2. Step 7.1 → 7.2 → 8.0 → 8.1, keeping `load_defaults 7.0` and reading the deprecation output at each step.
3. Adopt new defaults one at a time, only after rollback is no longer needed.

## New configuration defaults
The app sets `load_defaults 7.0` and overrides none of the defaults below, so it currently keeps the old value for all of them.

**7.1 defaults**
- **`raise_on_assign_to_attr_readonly`:** with it on, saving notebook settings raises `ReadonlyAttributeError`, because the form posts a hidden `slug` (run). Stop permitting `:slug` in `NotebooksController`; that is included in the patch and works on 7.0.
- **`raise_on_invalid_cache_expiration_time`:** with it on, the exports page returns 500 once an export has expired, because of the negative `expires_in` in `exports/_export.html.erb` (run). Clamp it with `[…, 1.second].max`; the existing stale-cache test still passes.
- **`default_column_serializer = nil`:** requires an explicit coder on every `serialize` (change 4).
- **`cache_format_version 7.1`, `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`:** 7.0 cannot read what these produce. That covers the production file-store fragment cache, and possibly signed or encrypted cookies and the signed IDs inside ActionText bodies. Adopt them last and clear the cache. **Unverified.**
- **`sanitizer_vendor` HTML5 (Action View and ActionText):** the sample I tested renders the same.
- **No visible effect in this app:**
  - `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false`: the app has no callbacks of its own.
  - `belongs_to_required_validates_foreign_key = false`: only skips a query.
  - `marshalling_format_version`, `query_log_tags_format`: query logs are off.
  - `generate_secure_token_on`, encryption settings, sqlite strict strings: not used.
  - `add_autoload_paths_to_load_path = false`: only `require "csv"`.
  - `precompile_filter_parameters`, `dom_testing_default_html_version`, `log_file_size`, `debug_exception_log_level`: no visible effect.
  - `default_headers`: drops `X-Download-Options`.
- **Removed later, so the new behavior became permanent:**
  - `commit_transaction_on_non_local_return`: change 14.
  - `allow_deprecated_singular_associations_name`: change 9.
  - `use_big_decimal_serializer`: change 20.
  - `allow_deprecated_parameters_hash_equality`: no usage found.

**7.2 defaults**
- **`enqueue_after_transaction_commit = :default`:** with Sidekiq, a job enqueued inside a transaction would wait until the commit. That breaks the documented "a failed enqueue rolls back" behavior in `Citation#request_enrichment` and `Note#schedule_reminder`. This applies only if you run 7.2 with `load_defaults 7.2`. In 8.1 the setting is gone and the per-job default is false (source-checked). Do not adopt it on 7.2.
- **`postgresql_adapter_decode_dates`:** change 16; permanent in 8.1.
- **`validate_migration_timestamps`:** the existing migrations are not future-dated.
- **`web_image_content_types` adds webp:** no variants are used.
- **`yjit`:** increases memory use.

**8.0 defaults**
- **`to_time_preserves_timezone = :zone`:** change 18; permanent in 8.1.
- **`strict_freshness`:** in `ExportDownloadsController`, `If-None-Match` wins over `If-Modified-Since`. The ETag is the blob checksum, so the effect should be negligible.
- **`Regexp.timeout = 1`:** a risk only for pathological input to the DOI or CSV regexes. **Unverified.**

**8.1 defaults**
- **`render_tracker :ruby`:** may change template digests, invalidating the export fragment cache once.
- **`remove_hidden_field_autocomplete`:** tests pass.
- **`action_on_path_relative_redirect :raise`:** all redirects use helpers or absolute paths.
- **`raise_on_missing_required_finder_order_columns`:** every table has a primary key.
- **`escape_json_responses = false`, `escape_js_separators_in_json = false`:** the app has no JSON views.
- **`yjit` only outside local environments.**

## Dependency risks (not exercised)
- **Sidekiq adapter:** Rails' built-in Sidekiq adapter is deprecated in 8.1 and removed in 8.2. Moving to sidekiq 7.3.3+ would bring in:
  - `redis-client`, where `sadd` returns an Integer. Since 0 is truthy in Ruby, `User#request_digest`'s once-per-day guard would never trigger.
  - Strict arguments, so `ExportJob.perform_async(id, { format: ... })` with symbol keys raises `ArgumentError`. That is not a `Redis::BaseError`, so the export row is left orphaned.
  - Possibly a new wrapper class name, which would make rollback unsafe.

  Treat that as a separate upgrade.
- **Puma 5 and Rack 2:** these stay as they are. A later move to Rack 3 or Puma 6 would break `bin/citation-provider` (`rack/handler/puma`) and `Puma::Events.strings` in the test helper. `bin/citation-provider` was not run on 8.1.
- **concurrent-ruby pin:** the 1.3.4 pin can probably go after 7.1. **Unverified.**

## What tests would not have caught
- The 7.0 YAML fallback for `coder:`.
- The BigDecimal rollback failure.
- Cache and message-format rollback.
- The `enqueue_after_transaction_commit` behavior on 7.2.
- The Sidekiq 7 hazards above.
- The masked access-control assertions (change 19).

## Still to check
- Run each intermediate version (7.1, 7.2, 8.0) with deprecation output turned on.
- Run the browser tests, which need a display, especially for Trix 2.1.19.
- Confirm that 7.0 can read session cookies and ActionText signed IDs written after the 7.1 message defaults are adopted.
- Confirm whether a later 8.1.x removes the need for the json pin.
- Add regression tests for:
  - changes 9 and 13, which currently fail only indirectly;
  - the rollback case of the import;
  - a digest test that pins the UTC day regardless of the zone carried in the payload.

The key files are `/tmp/mn-exp/patches/prep.diff`, `/tmp/mn-exp/scripts/prep.py`, `/tmp/mn-exp/action_text_patch.rb` and `/tmp/mn-exp/logs/`.

---

I haven't upgraded anything yet; the upgrade skill only produces a plan, and your repository is unchanged. This is a jump from 7.0.8.7 to 8.1.0, not a minor bump. I'd start by landing the 17 preparatory changes that already work on 7.0. If you'd like me to apply them, or begin the 7.1 step, just say so.