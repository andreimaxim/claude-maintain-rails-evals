# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

## Summary

The upgrade is feasible. In a disposable copy, the full suite (46 tests) passes on Rails 8.1.0 with `load_defaults 7.0`, and again with `load_defaults 8.1`, after 21 code/config changes.

- **On 8.1.0 without fixes, the app doesn't boot.** After the boot blockers were fixed, 46 of 46 tests failed or errored.
- **Silent corruption risks are covered by tests.** Every silent behavior change found here (partial imports, blank DOIs in receipts, missing annotations, digest day shift, reminder offset) is caught by an existing test. The suite's blind spots are elsewhere: mixed-version job payloads, rollback compatibility, and the browser editor. I tested the first two directly; the editor is unverified.
- **Most fixes can ship first, on 7.0.** 13 of the required changes, plus 4 needed only for the new defaults, also work on 7.0. I applied them on 7.0 and the suite was green with no deprecation warnings. They can go out as a preparatory PR before the version bump.
- **Four changes must ship with the bump:** the Gemfile, `serialize ... coder: JSON`, `:polynomially_longer`, and `show_exceptions = :none`. On 7.0 each one is broken or harmful.
- **Two rollout hazards were confirmed with real Sidekiq workers.** A DigestJob enqueued by 8.1 fails on a 7.0 worker. A one-line change on 7.0 removes this.

Nothing in `/home/user/workspace/repo` was modified; its git status is still clean.

## Required changes

"Works on 7.0" means I applied the change on 7.0.8.7 and the suite passed (commit `160d672`), unless marked otherwise.

| # | Code | Break on 8.1 | When it changed | Fix | Works on 7.0 |
|---|---|---|---|---|---|
| R1 | `Gemfile` | Resolving Rails 8.1.0 pulls in json 3.1.0. Active Support 8.1.0's JSON decoder calls `JSON.parse(json, options)`, which json 3 rejects. Every session and JSON column read fails. | Gem resolution | Bump `rails` to 8.1.0 and add `gem "json", "< 3"` (resolved to 2.21.2). | Bump only |
| R2 | `config/initializers/action_text.rb` | `allowed_tags` defaults to `nil` from 7.1, so `+=` raises at boot. | 7.1 | `allowed_tags = (allowed_tags \|\| Rails::HTML::SafeListSanitizer.allowed_tags.to_a + [Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]` | Yes |
| R3 | `app/models/note.rb:10` | `enum status: {...}, _prefix: true` raises an ArgumentError. | Deprecated 7.2, removed 8.0 | `enum :status, {...}, prefix: true` | Yes |
| R4 | `note.rb:12` | `serialize :tags, JSON`: the positional coder form was removed. | 7.2 | `serialize :tags, coder: JSON` | **No.** On 7.0 the keyword is silently ignored and the column falls back to YAML: it reads `"[]"` as a String and writes `"---\n- a\n- b\n"`. Verified with `/tmp/upg/probe70.rb` → `/tmp/upg/logs/probe70.log`. |
| R5 | `note.rb:14` | `alias_attribute :highlight_color, :color` raises because `color` is a `store_accessor`, not an attribute. | Deprecated 7.1, raises 7.2 | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes |
| R6 | `config/routes.rb:18` | `get "/notes", "/journal", ...` raises. | Deprecated 8.0, removed 8.1 | Two `get` calls with `as: :notes` and `as: :journal`. Route names are unchanged, checked with `bin/rails routes` on both versions. | Yes |
| R7 | `app/views/notes/index.html.erb:12` | `form_with(model: nil, ...)` raises. | 8.0 | Drop `model: nil`. | Yes |
| R8 | `config/environments/test.rb` | `show_exceptions = false` now means "show everything", so tests expecting `RecordNotFound` get 404/500 pages. | 7.1 → 8.x | `config.action_dispatch.show_exceptions = :none` | **No.** On 7.0 any symbol counts as true. |
| R9 | `app/models/citation/provider.rb:13`, test helper (lines 45 and 117–122), `config/secrets.yml` | `Rails.application.secrets` no longer exists. | Removed 7.2 | Move to `config/citation_provider.yml` (same ERB/`to_json` quoting). Set `config.x.citation_provider = config_for(:citation_provider)` in `application.rb`, read it in the Provider, and stub that in the test. Same environment variable names. | Yes. The fresh-boot credentials test passes on both. |
| R10 | `app/models/export.rb:42` | `fragments.sum` raises TypeError, so every export fails. It already prints a deprecation warning on 7.0. | Removed 7.1 | `fragments.join` | Yes |
| R11 | `app/controllers/notes_controller.rb:18` | `where(notebooks: @notebook)` produces SQL `notes.notebooks`, which doesn't exist. The notebook filter returns a 500. | Seen on 8.1; release not isolated | `where(notebook: @notebook)` | Yes |
| R12 | `note.rb:62` | `set(wait_until: <Integer>)` raises `undefined method utc`. | Seen on 8.1; release not isolated | `set(wait_until: Time.at(reminder_epoch))` | Yes |
| R13 | `app/views/imports/preview.html.erb` | `annotations.stringify_keys` now turns Integer line numbers into strings, so the preview silently drops every annotation. | 8.0 (7.0–7.2 return a `dup`) | Drop `.stringify_keys`. | Yes |
| R14 | `app/models/import.rb#apply` | `return false` inside `transaction` now **commits**. An invalid row leaves a saved import plus the earlier notes and citations. The test showed counts `[1,4,1,2]` instead of no change. | Default in 7.1, mandatory from 7.2 | `raise ActiveRecord::Rollback` and return a flag set at the end of the block. | Yes |
| R15 | `import.rb#receipt` | `citation[:id]` returns nil because `Citation`'s primary key is `doi`. The receipt CSV's DOI column is silently blank. | Deprecated 7.1, changed 7.2 | `citation&.doi` | Yes |
| R16 | `app/jobs/citation_enrichment_job.rb` | `wait: :exponentially_longer` raises when a retry is scheduled. | Removed 7.2 | `wait: :polynomially_longer`. I believe it uses the same formula but did not check. | **No.** 7.0 accepts it at class load, then raises at retry time. |
| R17 | `note.rb#next_day_reminder_at` | `TimeWithZone#to_time` now always keeps the named zone; the config is ignored, so there is no opt-out. Across a DST change, the "next day" preview shows `08:00-05:00` instead of `09:00-04:00`. The postponed epoch is the same. | `:zone` default 8.0, forced 8.1 | To keep the current documented behavior: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Showing the zone-correct wall time instead is a product decision. | Yes |
| R18 | `app/mailers/digest_mailer.rb` | Active Job now keeps the TimeWithZone's zone. The digest covers the reader's local day while the reservation key stays on the UTC day; the test got Oct 04 instead of Oct 05. | 7.2 | `requested_at = requested_at.utc` in the mailer, so payloads from either version behave the same. | Yes |
| R19 | `app/models/user.rb#request_digest` | BigDecimal job arguments are always tagged with `BigDecimalSerializer`, which 7.0 workers can't read (see rollout below). | 7.2 (opt-in 7.1) | Pass `reading_completion.to_s`; the mailer already calls `BigDecimal(...)`. | Yes. This also removes Sidekiq's "not JSON safe" warning. |

I also recommend fixing the export partial's cache call (`app/views/exports/_export.html.erb:26`), even with old defaults kept. On 8.1 a negative `expires_in` is dropped and logged as an error on every render of an expired export. Use `expires_in: [export.expires_at - Time.current, 0].max`. This works on 7.0 and keeps the stale-indicator behavior the test pins.

Documentation that describes old behavior and should change with the code: `ARCHITECTURE.md:79-80` (secrets), `CONTRIBUTING.md:38`, `TESTING.md` (Minitest/Rails 7.0 note), the Trix comment in the layout, and the comments in `provider.rb`, `DigestJob`, `DigestMailer`, and `Note#next_day_reminder_at`.

## Framework defaults: one row per default, per release

The app is on `load_defaults 7.0`, so it **keeps the old value for every row below**. Rows marked **forced** are no longer optional on 8.1: the config was removed or is ignored, and the related change above is required. "Tested" means the suite ran under `load_defaults 8.1` (commit `b53c08d`).

**7.1**

| Default | What adopting it changes here |
|---|---|
| `add_autoload_paths_to_load_path=false` | Nothing; the only `require` is `csv`. |
| `precompile_filter_parameters` | None. |
| `dom_testing_default_html_version=:html5` | `assert_select` parses as HTML5; suite passed. |
| `log_file_size` 100MB | Dev/test logs only. |
| `run_commit_callbacks_on_first_saved_instances_in_transaction=false` | No commit callbacks; none. |
| `sqlite3_adapter_strict_strings_by_default` | Not applicable (PostgreSQL). |
| `query_log_tags_format` | Query log tags are off; none. |
| **`raise_on_assign_to_attr_readonly=true`** | **Breaks notebook settings.** The form resubmits `slug`, so `update` raises `ReadonlyAttributeError` (tested). Fix: permit `:slug` only for new records. Works on 7.0. |
| `belongs_to_required_validates_foreign_key=false` | `notebook` presence is still checked when the notebook is reassigned (`owned_notebook` can be nil). Suite passed. |
| `before_committed_on_all_records` | No callbacks; none. |
| **`default_column_serializer=nil`** | **`serialize :preferences` raises at load** (tested). Fix: `coder: YAML`. Stored format is identical, verified 7.0 ↔ 8.1. Harmless on 7.0. |
| `encryption.*` | No encryption; none. |
| `marshalling_format_version` | No Marshal of records; none. |
| `run_after_transaction_callbacks_in_order_defined` | None. |
| `generate_secure_token_on` | None. |
| `commit_transaction_on_non_local_return` | **Forced** → R14. |
| `allow_deprecated_singular_associations_name=false` | **Forced**; covered by the R11 fix. |
| `default_headers` | `X-XSS-Protection: 0` instead of `1; mode=block`; `X-Download-Options` dropped. Headers change; no tests cover them. |
| `debug_exception_log_level=:error` | Log level only. |
| `use_big_decimal_serializer` | **Forced** → R19. |
| `cache_format_version=7.1` | Fragment cache entries written in a format 7.0 can't read. Only matters for rollback if the production cache persists (store not configured; see questions). |
| `message_serializer=:json_allow_marshal`, `use_message_serializer_for_metadata` | Tested: an 8.1 session cookie under new defaults decrypts on 7.0 and vice versa, because the app already uses the JSON cookie serializer. Rollback-safe. |
| `raise_on_invalid_cache_expiration_time` | Exports page returns 500 for any expired export (tested). Fixed by the `expires_in` clamp. |
| `allow_deprecated_parameters_hash_equality=false` | No params `==` comparisons; none. |
| `action_view.sanitizer_vendor` / `action_text.sanitizer_vendor` = HTML5 | Rich-text rendering changes (`/tmp/upg/logs/sanitize-cmp.log`): whitespace/newline differences, `<svg>` descendant text dropped, attribute entities not re-escaped. Neither vendor produced executable markup in my samples. Suite passed. |

**7.2**

| Default | What adopting it changes here |
|---|---|
| `yjit=true` | More memory (later narrowed by 8.1 to non-local environments). |
| `active_job.enqueue_after_transaction_commit=:default` | On 7.2 only, Sidekiq jobs would be enqueued after commit. That breaks the "failed enqueue rolls back" design in `Citation#request_enrichment` and `Note#schedule_reminder`. 8.1 defaults the class attribute to `false`. Not a risk on a direct jump to 8.1 unless you opt in; avoid this default if you stop on 7.2. |
| `web_image_content_types` adds webp | No variants (`image_processing` is not installed); none. |
| **`postgresql_adapter_decode_dates=true`** | **Breaks the activity report.** `select_rows` returns `Date` objects and `Date.iso8601(Date)` raises (tested). Fix: `day.to_date`. Works on 7.0. |
| `validate_migration_timestamps` | Existing timestamps are in the past; none. |

**8.0**

| Default | What adopting it changes here |
|---|---|
| `to_time_preserves_timezone=:zone` | **Forced in 8.1** → R17. |
| `action_dispatch.strict_freshness=true` | Export download sends both an ETag (blob checksum) and Last-Modified (`created_at`), and both are immutable per blob. The response only differs for a client sending a matching ETag with an older `If-Modified-Since`. Source-based; not tested. |
| `Regexp.timeout=1` | Process-wide. The DOI regex is anchored and simple; CSV parsing is capped at 100 KB. Low risk; not tested. |

**8.1**

| Default | What adopting it changes here |
|---|---|
| `yjit=!local` | Same as 7.2 but production only. |
| `escape_json_responses=false` | No JSON responses or jbuilder views; none. |
| `action_on_path_relative_redirect=:raise` | All redirects use path helpers or `/notes`; none. |
| `raise_on_missing_required_finder_order_columns` | Every table has a primary key; no implicit `first`/`last` in app code. |
| `escape_js_separators_in_json=false` | No JSON embedded in `<script>`; none. |
| `render_tracker=:ruby` | Affects the cache digest for the export partial's `cache` block. Existing keys change once (one-time miss). |
| `remove_hidden_field_autocomplete` | Hidden inputs lose `autocomplete="off"`; tests don't check that attribute. |

## Rollout and rollback

Steps 1–3 (preparatory work, staged defaults, Sidekiq follow-up) are recommended; step 4 lists the rollout and rollback risks.

1. **Ship the preparatory PR on 7.0 first:** R2, R3, R5–R7, R9–R15, R17–R19, the `expires_in` clamp, and optionally the four default-related fixes (`coder: YAML`, `slug` permit, `to_date`, clamp). It was verified green on 7.0 (`160d672`).

2. **Then bump in one PR:** R1, R4, R8, R16, with `load_defaults 7.0` kept. Verified green (`de511e5`), including eager loading (`CI=1`), `zeitwerk:check`, a production boot, and `assets:precompile`.
   - **Adopt the defaults later, one release at a time,** using a `new_framework_defaults` initializer.
   - **Keep `enqueue_after_transaction_commit` off.**
   - **Turn on the HTML5 sanitizer only after a visual check.**

3. **Sidekiq follow-up.** In development, Rails 8.1 logs that the built-in `sidekiq` adapter is deprecated and will be removed in 8.2; it wants Sidekiq 7.3.3 or later. Before that move:
   - `ExportJob.perform_async(id, { format: ... })` passes symbol keys, which Sidekiq 7's strict arguments will reject.
   - `redis.sadd`/`srem` return values change in redis-rb 5.
   - Neither is needed for 8.1.0.

4. **Mixed-version and rollback risks:**
   - **Queued DigestJobs.** Without R19, a DigestJob enqueued by 8.1 fails on a 7.0 worker with `DeserializationError: BigDecimalSerializer is not known` (`/tmp/upg/logs/xver-sidekiq70-consumes81.log`). It goes to the retry set. After rollback it keeps failing until it dies, and the per-day reservation blocks the reader from asking again that day. With R19 a 7.0 worker processed the 8.1 payload (`xver-sidekiq70-consumes81-b.log`). Without R19: upgrade workers before web, and on rollback revert web first, then drain the queue and retry set before reverting workers.
   - **Reminder jobs.** An 8.1 NoteReminderJob ran fine on 7.0 (extra keys `scheduled_at`/`timezone` are ignored). 8.1 workers processed 7.0 payloads, including ones that had failed and been retried.
   - **Stored data.** I wrote with 7.0, read and wrote with 8.1 under new defaults, then read back with 7.0 (`xver-*.log`). Tags JSON text, `settings` jsonb, `preferences` YAML, and rich text were byte-identical in both directions. No migrations are needed.
   - **Schema file.** `db:schema:dump` on 8.1 rewrites the header to `Schema[8.1]`, uses `pg_catalog.plpgsql`, and sorts columns alphabetically (cosmetic diff, 36 lines). A `Schema[8.1]` file cannot be loaded by 7.0, so revert `schema.rb` together with the code on rollback.
   - **Development secret.** The dev/test secret moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`, so local sessions reset once.
   - **Time zones.** Zone list diff: none removed; Asuncion added. **Astana** now maps to `Asia/Almaty` (UTC+5) instead of `Asia/Dhaka` (UTC+6). Astana readers' reminders entered before the upgrade will display an hour earlier, and new entries are read at the new offset. Canberra and Greenland changed identifiers only.

## Experiment provenance

- **Isolation.** Everything ran in `/tmp/upg`: a clone at `/tmp/upg/app` and a 7.0 worktree at `/tmp/upg/app70`. I used a private PostgreSQL 15 cluster (`/tmp/upg/pg`, Unix socket only, port 55432) and Redis on 56379, both now stopped. Gems were installed under `/tmp/upg/gems`, storage and mails stayed in the copy's `tmp/`, and the cache was null/memory. The shared 5432/6379 services were not touched.
- **Environment.** Settings are in `/tmp/upg/env.sh` and `/tmp/upg/xver_env.sh`. Ruby 3.3.6 was put on PATH directly to avoid trusting the copy's `mise.toml`, with `PARALLEL_WORKERS=1`.
- **Commits.** `de511e5` is 8.1 with old defaults, `b53c08d` is 8.1 with `load_defaults 8.1`, and `160d672` is the preparatory set on 7.0.
- **Resolved 8.1 lock.** rails 8.1.0, json 2.21.2, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, minitest 5.27.0, concurrent-ruby 1.3.4, pagy 8.6.3, turbo-rails 2.0.12, importmap-rails 2.2.3, sprockets-rails 3.5.2, action_text-trix 2.1.19, pg 1.6.0, tzinfo 2.0.6.
- **Logs** are in `/tmp/upg/logs`:
  - Baseline: `base-test.log`.
  - Step-by-step 8.1 runs: `t81-old-1…9.log`, `t81-new-1…4.log`.
  - 7.0 verification: `prep70-test-2.log`.
  - Cross-version jobs and data: `xver-*.log`.
  - Other checks: `sanitize-cmp.log`, `precompile-81.log`, `schema-dump-81.log`.
- **Release attribution.** I dated changes by grepping unpacked activesupport, activerecord, activejob, actionpack, actionview, railties, and actiontext 7.1.0, 7.2.0, and 8.0.0 in `/tmp/upg/src`, against 7.0.8.7 and 8.1.0.

## Not verified, and open questions

- **Rich-text editor (browser).** On 8.1, `*= require trix` resolves to Trix 2.1.19's CSS, while the layout loads the vendored Trix 1.3.5 JS. No browser is installed and `test/system` is empty, so editing, attachments, and Turbo behavior are untested. The options are to vendor the Trix 1.3.5 CSS, or to move to Trix 2 via importmap and drop the vendored file.
- **Server boot.** `bin/rails server` on puma 5 with Rails 8.1 was not started; only runner boots and Puma inside a test.
- **Retry formula.** That `:polynomially_longer` uses the same formula as `:exponentially_longer` is from memory, not checked.
- **Unchecked areas.** `strict_freshness` and `Regexp.timeout` effects, the response-header change, and the HTML5 sanitizer on real stored bodies (only samples were compared).
- **Production questions:**
  - Where does `secret_key_base` come from? The credentials file couldn't be decrypted here, and `secrets.yml` has none.
  - Is the production cache store persistent? Not configured, so this depends on whether `tmp/cache` survives deploys; it decides rollback safety for `cache_format_version`.
  - How many users have `time_zone = 'Astana'`?
  - How many DigestJobs are in the queue, scheduled, or retry sets at deploy time?
- **Path not tested.** I only tested a direct jump from 7.0 to 8.1. Stepping through 7.1, 7.2, and 8.0 was not executed. If you stop on 7.2, do not adopt its `enqueue_after_transaction_commit` default.

---

This is a plan only. Rails is still 7.0.8.7 and your repo hasn't been changed. If you want me to go ahead, I'd start with the preparatory PR on 7.0 (step 1), then do the version bump as a separate PR (step 2). It would help to have answers to the production questions first, especially where `secret_key_base` comes from and how many DigestJobs are queued at deploy time.