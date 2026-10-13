Here's the planner's full plan for upgrading Rails from 7.0.8.7 to 8.1.0. It was tested in disposable copies; your repository hasn't been changed and `git status` is clean.

---

I've built the plan below from changelogs, source reading and experiments run in disposable copies. Upgrading straight to Rails 8.1.0 breaks this app in about 15 places. Nine of them fail quietly (wrong data, wrong dates, wrong offsets, or failures that only show up later), and the existing suite catches only some. All but three of the fixes also work on 7.0.8.7, so they can ship before the upgrade. I did not touch the working repository. One slip: an early `gem fetch` dropped `rails-8.1.0.gem` into the repo root; I deleted it and `git status` is clean.

## How it was tested

- **Isolation:** each copy is a separate clone. They used their own PostgreSQL 15 instance on port 55432 (data in `/tmp/up/pgdata`), their own Redis on 56379 (no persistence), and per-copy storage folders. The test cache is `:null_store`. The shared PostgreSQL and Redis on the machine were never used. Both test services are now stopped.
- **Copies:**
  - `/tmp/up/base`: unchanged 7.0.8.7. 46 runs, 0 failures. One existing deprecation: `Enumerable#sum` in `export.rb`. Log: `/tmp/up/base-test.log`.
  - `/tmp/up/up81`: `rails "8.1.0"` with `bundle lock --update rails`. Lock log `/tmp/up/up81-lock.log`, test logs `/tmp/up/up81-test1..6.log`, final diff `/tmp/up/up81-final.diff`. Resolved versions: Rails 8.1.0, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, json 2.21.2 (after pinning), bigdecimal 4.1.3, minitest 5.27.0, action_text-trix 2.1.19. With all fixes applied: 46 runs, 0 failures. Production asset precompile and a production boot also worked (`GET /session/new` 200, `/journal` 302).
  - `/tmp/up/up81d`: the same as up81 plus `load_defaults 8.1`. Logs `/tmp/up/up81d-test1.log` and `test2.log`.
  - `/tmp/up/prep70`: 7.0.8.7 with only the fixes that also work on 7.0. 46 runs, 0 failures. Diff `/tmp/up/prep70.diff`, log `/tmp/up/prep70-test.log`.
- **Cross-version data check:** scripts `/tmp/up/x/produce.rb` and `/tmp/up/x/consume.rb`, run in production mode with a fixed `SECRET_KEY_BASE` against a shared database `cross_prod`. Results are in `/tmp/up/x/consume81.log`, `consume70.log` and `consume70-from81d.log`.
- **Change index:** the full gem-changes output is in `/tmp/up/gem-changes.txt`. It left out the 8.1 defaults block, so I took that list from `railties-8.1.0/lib/rails/application/configuration.rb`.

## A. Required changes (each one breaks under 8.1; "Verified" means I saw it fail and then pass)

| # | Code | What breaks if nothing is done | Fix | Works on 7.0? | Removed in |
|---|---|---|---|---|---|
| 1 | `config/initializers/action_text.rb` | The app won't boot: `allowed_tags` is `nil` from 7.1, so `+=` raises `NoMethodError`. Verified. | Set it inside `after_initialize`: `allowed_tags \|\| (sanitizer.class.allowed_tags + [Attachment.tag_name, "figure", "figcaption"])`, then add `details summary`. | Yes | 7.1 |
| 2 | `Note`: `enum status: {...}, _prefix: true` | Eager load fails with `ArgumentError`. Verified. | `enum :status, {...}, prefix: true` | Yes | 8.0 |
| 3 | `Note`: `serialize :tags, JSON` | Fails at class load. Verified. | `serialize :tags, coder: JSON`. The stored JSON stays the same. | **No.** On 7.0 `coder:` is silently ignored and YAML is used (verified), which would corrupt tags. Make this change together with the 7.1 Gemfile bump. | 7.2 |
| 4 | `config/routes.rb`: `get "/notes", "/journal"` | Routes fail to load. Verified. | Two separate `get` lines. | Yes | 8.1 |
| 5 | `Note`: `alias_attribute :highlight_color, :color` (`color` comes from `store_accessor`) | `ArgumentError` when the alias is used. Verified. | Define the reader and writer methods by hand. | Yes | 7.2 |
| 6 | `Citation::Provider`: `Rails.application.secrets` (also `config/secrets.yml` and the `with_provider` helper plus line 45 of `citation_enrichments_controller_test.rb`) | `NoMethodError`, so citation enrichment stops working. Verified. | `config.x.citation_provider = config_for(:secrets)[:citation_provider]`, read through `Rails.configuration.x`; consider renaming the file. | Yes | 7.2 |
| 7 | `CitationEnrichmentJob`: `wait: :exponentially_longer` | When the provider is down, retry raises `RuntimeError` ("Couldn't determine a delay"). The `fail_enrichment` block never runs, so the citation stays `pending` and the app reports "already being fetched" forever. This also hits retries queued before the deploy. Verified. | `wait: ->(executions) { executions**4 + 2 }`, which keeps 7.0's base delay but drops the random jitter. `:polynomially_longer` only exists from 7.1. | Yes (the lambda form) | 7.2 |
| 8 | `Export#generate`: `fragments.sum` | `TypeError`: Markdown exports fail. 7.0 already warns about this. Verified. | `fragments.join` | Yes | 7.1 |
| 9 | `notes/index.html.erb`: `form_with(model: nil, ...)` | Every request to the note list returns 500. Verified. | Remove `model: nil`. | Yes | 8.0 |
| 10 | `NotesController#index`: `where(notebooks: @notebook)` | Filtering by notebook raises `PG::UndefinedColumn`. Verified. | `where(notebook: @notebook)` | Yes | 7.2 |
| 11 | `Note#schedule_reminder`: `set(wait_until: reminder_epoch)` with an Integer | Scheduling a reminder returns 500 (`undefined method utc for Integer`). Verified. | `wait_until: Time.at(reminder_epoch)` | Yes | 7.2 |
| 12 | `Import#apply`: `return false` inside `transaction` | **Silent data corruption:** from 7.2 that `return` commits instead of rolling back, so a CSV with an invalid row saves the import and the earlier rows. The test caught counts `[1,4,1,2]` where `[0,3,0,1]` was expected. Verified. | `raise ActiveRecord::Rollback` plus a `saved` flag. | Yes | 7.2 |
| 13 | `Import#receipt`: `citation[:id]` (the primary key is `doi`) | **Silent:** the receipt CSV's DOI column comes out empty. Verified. | `citation&.doi` | Yes | 7.2 |
| 14 | `imports/preview.html.erb`: `annotations.stringify_keys` | **Silent:** from 8.0 the integer line-number keys become strings, so `annotations[row.line]` is nil and annotations disappear from the preview. Verified. | Remove `.stringify_keys`. | Yes | 8.0 |
| 15 | `DigestMailer`: `requested_at.to_date` / `.all_day` | **Silent:** from 7.1 Active Job keeps the reader's time zone on time arguments, so the digest covers the reader's local day instead of the documented UTC day. The test got Oct 04 where Oct 05 was expected. Verified. | `requested_at = requested_at.utc`, and update the comments in `digest_job.rb` and `digest_mailer.rb`. | Yes | 7.1 |
| 16 | `Note#next_day_reminder_at`: `to_time + 86_400` | **Visible change:** across a DST boundary the displayed offset changes (`09:00-04:00` becomes `08:00-05:00`). The epoch is the same (1793538000 in both versions), so the scheduled time does not move. Verified. | Either `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400` to keep today's display, or accept the zone behavior and update the test and comment. Your call. | Yes | 8.1 |
| 17 | `config/environments/test.rb`: `show_exceptions = false` | Tests that expect `RecordNotFound` get rendered 500 pages instead. Verified. | `:none` (or `:rescuable`). | **No** (`:none` needs 7.1+) | 7.2 |
| 18 | Gemfile: `json` has no constraint | Bundler resolves json 3.1.0, and Active Support 8.1.0's `JSON.parse(json, options)` raises `ArgumentError` when decoding the session cookie, so every signed-in request returns 500. Verified. | Add `gem "json", "~> 2.10"` (2.21.2 resolved and worked). | Harmless on 7.0 | n/a |

## B. Mixed-version rollout, stored data and queued work

- **`DigestJob` BigDecimal argument (rollback hazard):** 8.1 always uses `BigDecimalSerializer`, and a 7.0 worker raises `DeserializationError: Serializer ... BigDecimalSerializer is not known` (verified). `DigestJob` has no `discard_on`, so Sidekiq would keep retrying. Fix before upgrading: `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. This works on 7.0 and the mailer already calls `BigDecimal(...)` on it (verified on both versions). Payloads from 7.0 read fine on 8.1.
- **TimeWithZone payloads:** 8.1 adds a `time_zone` key, which 7.0 ignores. Old 7.0 payloads fall back to UTC on 8.1. With fix 15 both cases give the same UTC day. Verified.
- **Reminders and citation jobs:** `NoteReminderJob` and `CitationEnrichmentJob` payloads deserialize in both directions (verified). Pending retries of `CitationEnrichmentJob` need fix 7 in place before 8.1 workers pick them up.
- **Session cookies, preferences, tags, highlight colors and Action Text sgids** all read correctly in both directions while `load_defaults 7.0` is kept. Verified.
- **ExportJob** is a native Sidekiq job and is unaffected.
- **Deploy order:**
  1. Ship section A's 7.0-compatible fixes plus the `.to_s` change on 7.0. Drain or let finish any `CitationEnrichmentJob` retries.
  2. Upgrade stepwise (7.1 → 7.2 → 8.0 → 8.1), keeping `load_defaults 7.0`. Make fixes 3 and 17 at the 7.1 step.
  3. Upgrade web and worker processes together, or upgrade workers first.
- **Sidekiq:** 6.5.12 still works with 8.1. A real enqueue to the isolated Redis succeeded. The built-in adapter is deprecated and removed in Rails 8.2; Sidekiq 7.3.3+ fixes that, but its `strict_args!` would reject `ExportJob.perform_async(id, { format: "markdown" })`, which uses symbol keys. That belongs to a separate task.

## C. Optional new defaults (none adopted today; the app is on `load_defaults 7.0` with no overrides)

**7.1**
- `default_column_serializer = nil`: `Notebook`'s `serialize :preferences` fails to boot (verified). Needs `coder: YAML`, which is 7.1+ only.
- `raise_on_assign_to_attr_readonly`: the notebook settings form posts the hidden `slug`, so updates raise `ReadonlyAttributeError` (verified). Stop permitting `:slug`.
- `raise_on_invalid_cache_expiration_time`: expired exports pass a negative `expires_in` in `exports/_export.html.erb`, which raises "cannot be negative" (verified). Clamp the value or skip caching.
- `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`: **stored-data rollback hazard.** Action Text sgids written to `action_text_rich_texts.body` after adoption crash 7.0 when rendering (`undefined method unpack1 for nil`), and blob signed IDs stop resolving (verified, each flag separately). Turn these on only after rollback to versions before 7.1 is ruled out.
- `cache_format_version 7.1`: older versions miss the fragment cache. Low impact.
- `sanitizer_vendor` (HTML5) for Action View and Action Text: still keeps `details`/`summary` with fix 1 (verified).
- `dom_testing_default_html_version :html5`: suite passes.
- No effect expected here (source-based): `belongs_to_required_validates_foreign_key`, the transaction callback-order flags, `generate_secure_token_on`, the encryption digest settings (no `encrypts`), the SQLite and query-log settings, `precompile_filter_parameters`, `add_autoload_paths_to_load_path`, the `default_headers` change (drops `X-Download-Options`), `debug_exception_log_level`, `log_file_size`, `marshalling_format_version`.

**7.2**
- `postgresql_adapter_decode_dates`: the activity report's `Date.iso8601(day)` raises `TypeError` because a Date now comes back instead of a String (verified). Handle both types.
- `validate_migration_timestamps`: current migrations pass.
- `web_image_content_types` adds webp, which doesn't matter here (no variants).
- `yjit`: watch memory.

**8.0**
- `strict_freshness`: export downloads would use only `If-None-Match`, against the blob checksum ETag. Probably harmless. Not exercised.
- `Regexp.timeout = 1`: not exercised.
- 8.0 also makes `to_time` keep the zone; see fix 16.

**8.1**
- `escape_json_responses = false` and `escape_js_separators_in_json = false`: no JSON responses here.
- `action_on_path_relative_redirect = :raise`: all redirects use absolute paths.
- `raise_on_missing_required_finder_order_columns`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete`: suite passes with all of these on.
- `yjit` only outside dev/test.

## D. Unverified and open questions

- No browser checks were run (`test/system` is empty). The vendored Trix 1.3.5 alongside Action Text 8.1's `actiontext.js` and the new `action_text-trix` 2.1.19 gem precompiles fine, but editing, uploads and attachment rendering need a manual pass.
- Only 8.1.0 was installed. The intermediate 7.1, 7.2 and 8.0 bundles were never resolved; check each one for the json-3 problem.
- Not run: the strict-freshness download behavior, a real Sidekiq worker on 7.0 consuming 8.1 jobs (only deserialization was tested), and the production file cache across versions.
- Decisions for you: keep the reminder's offset display or accept zone-based times (fix 16)? Keep the `secrets.yml` file name, or move to a dedicated `config_for` file or credentials?

---

**What's next:** The safest order is to first ship the fixes that already work on 7.0 (everything in section A except fixes 3 and 17, plus the `DigestJob` `.to_s` change from section B), then go up one version at a time. Before any of that, I need two decisions from you: fix 16 (keep the reminder's current time-offset display, or accept the new time-zone behavior) and fix 6 (where the citation-provider setting should live). Do you want me to start on the 7.0-compatible changes?