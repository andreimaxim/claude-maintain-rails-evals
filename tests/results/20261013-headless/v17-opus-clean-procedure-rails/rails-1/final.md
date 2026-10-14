# Upgrade plan: rails 7.0.8.7 → 8.1.0

## Summary
The upgrade needs 20 changes: 19 code or config edits and 1 gem move. After them, every check on 8.1.0 passes: boot, eager load, routes, schema, 46 tests (0 failures, 0 errors) and GET requests to 10 routes (observed). The one gem that must move is `json`, pinned `< 3`, which resolves to 2.21.2 (observed). There are 22 optional defaults. Biggest risk: `serialize :tags, coder: JSON` silently writes YAML on 7.0, so that change must ship with the upgrade and never before it (observed).

Labels: **observed** means a command showed it, **from source** means changelog, commit or gem code, **proposed** means not run.

## Required changes
Each was validated with `ruby P/upgrade-copy validate "TITLE" --file W/check-N.rb`. "Ships" is what the backport showed: whether the change works at 7.0 alone.

| # | Change (file) | Error at 8.1 without it (observed) | Cause (from source) | Ships |
|---|---|---|---|---|
| 1 | `config/initializers/action_text.rb:3`: build `allowed_tags` inside `after_initialize` from the defaults, plus `details summary` | Boot fails: `undefined method '+' for nil` | actiontext 8.1 `mattr_accessor(:allowed_tags)` has no default | Before |
| 2 | `app/models/note.rb:10`: `enum :status, {…}, prefix: true` | `enum.rb:217 wrong number of arguments (given 0, expected 1..2)` (eager load, all 46 tests) | commit b9226a6 | Before |
| 3 | `note.rb:12`: `serialize :tags, coder: JSON` | `serialization.rb:193 wrong number of arguments (given 2, expected 1)` | AR 7.1 changelog; removed in 7.2 | **With upgrade only** |
| 4 | `config/routes.rb:18`: split `/notes` and `/journal` into two `get` lines | `mapper.rb:1854 Wrong number of arguments (expect 1, got 2)` | commit d1f523d | Before |
| 5 | `note.rb:14`: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | `Note model aliases 'color', but 'color' is not an attribute` (16+ tests) | AR 7.2 removal | Before |
| 6 | Gemfile: `gem "json", "< 3", require: false` | `json-3.1.0 common.rb:291 parse: wrong number of arguments (given 2, expected 1)`, called from activesupport `json/decoding.rb:25` (×30) | json 3.1.0 crossed a major version | Before ("resolves and installs" at 7.0.8.7) |
| 7 | `app/models/export.rb:42`: `fragments.sum("")` | `TypeError: String can't be coerced into Integer` | 7.0 already warned about this line | Before |
| 8 | `config/environments/test.rb:31`: `show_exceptions = :none` | Tests expect `RecordNotFound` to be raised, but get a 404 (7 tests) | actionpack 7.2 removal | With upgrade (at 7.0, `:none` counts as true and shows exceptions) |
| 9 | Citation settings: `config/application.rb` sets `config.x.citation_provider = config_for(:secrets).citation_provider.to_h`; `app/models/citation/provider.rb:13` reads it; `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122` | `undefined method 'secrets'` | railties 7.2 removal | Before |
| 10 | `app/jobs/citation_enrichment_job.rb:7`: `wait: :polynomially_longer` | `Couldn't determine a delay based on :exponentially_longer` | commit 03dae98 | With upgrade (7.0 raises the same error for `:polynomially_longer`) |
| 11 | `app/views/notes/index.html.erb:12`: drop `model: nil` from `form_with` | `Passed nil to the :model argument` | actionview | Before |
| 12 | `app/controllers/notes_controller.rb:12`: `where(notebook: @notebook)` | `PG::UndefinedColumn: column notes.notebooks does not exist` | commit 4bf2c4c | With upgrade (its check showed 500 when backported; the cause looks like change 3, not verified) |
| 13 | `note.rb:62`: `wait_until: Time.at(reminder_epoch)` | `undefined method 'utc' for an instance of Integer` (activejob `core.rb:130`) | activejob 8.1 calls `.utc` on `scheduled_at` | Before |
| 14 | `note.rb:45`: `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400` | Next-day reminder is `2026-11-01T08:00:00-05:00`, expected `09:00:00-04:00` | activesupport 8.1 `to_time` now always keeps the time zone | Before |
| 15 | `app/mailers/digest_mailer.rb:8`: `requested_at = requested_at.in_time_zone(Time.zone)` | Digest subject says "October 04" instead of "October 05" | commit 18098cc: jobs now restore a time in the zone it was saved in | Before |
| 16 | `app/views/imports/preview.html.erb:22`: use `@import.annotations` without `.stringify_keys` | Annotation missing from the import preview | activesupport 8.0: `stringify_keys` now also converts Integer keys | Before |
| 17 | `app/models/import.rb:53-60`: `raise ActiveRecord::Rollback unless rows.all? { … }` | A failed import is partly saved: notes added=1, imports added=1 | AR 7.2: `return` inside a transaction now commits | Before |
| 18 | `import.rb:68`: `citation&.id` | Receipt shows `A,` with the DOI missing | commit 39997a0: `[:id]` no longer reads a custom primary key | Before |
| 19 | `app/views/exports/_export.html.erb:26`: `expires_in: [export.expires_at - Time.current, 0].max` | Probe-2: entry stored with no expiry, plus 2× `ArgumentError: Cache expiration time is invalid, cannot be negative` reported to the error reporter | activesupport 7.1 setting is false at load_defaults 7.0, so it reports and stores | Before |
| 20 | `app/models/user.rb:41`: `reading_completion.to_s` | Job argument becomes `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.0"}`; 7.0 wrote `"0.0"` | activejob 8.1 always uses BigDecimalSerializer | Before |

**Validation (observed):** 19 of the 20 gave PASS on before, FAIL or a boot or load error with only that change undone, and PASS on after. For change 4, the copy without it stopped with `undefined method 'notes_path'`, which counts as FAIL. CONTROL lines matched, with one exception in check-19: the copy without the repair counted 2 cached entries instead of 1, because the expired entry was also stored. The check scripts are `/tmp/gem-upgrade/repo-rails-8.1.0/check-1.rb` to `check-20.rb`.

**Rollout:**
- **Change 3 (stored data).** Backport probe-5 on 7.0 with the repair wrote tags raw as `"---\n- a\n- b\n"` (YAML). On 8.1 it writes `"[\"a\",\"b\"]"`, the same as 7.0 does today, and reads existing JSON rows correctly. So it must deploy together with Rails 8.1 and must never go to a 7.0 server. On rollback to 7.0, the old line `serialize :tags, JSON` returns, and the stored format is the same.
- **Change 20 (queued jobs).** It keeps the job payload readable by 7.0 workers during a rolling deploy.
- **Change 15 (queued jobs).** Jobs queued by 7.0 and run on 8.1 still give "October 05" (observed, probe-4). The 8.1 payload adds a `"time_zone"` key. In the probe, 7.0 read a payload without that key correctly (observed). That a 7.0 worker ignores the extra key is from source, not tested on a mixed deploy.
- **Change 19 (cache).** Entries already cached are unaffected.
- All other changes: rollout "none".

## Risks without a code change
- **Response header name:** `Link` becomes `link` (Rack 3). HTTP header names are case-insensitive. Only clients that compare names case-sensitively would notice (observed, check and probe-3).
- **Schema dump:** `db/schema.rb` will be rewritten on the next dump: `Schema[8.1]`, `pg_catalog.plpgsql`, and columns sorted alphabetically. The database itself does not change (observed). Reviewers of the next migration will see a large diff.
- **Routes:** the Action Mailbox conductor edit, update and destroy routes are gone (observed). This is a development-only UI.
- **`saved_change_to_color`:** before it returned `[nil, nil]`, after it returns `["green","blue"]`. This is a bug fix and the app never calls it (probe-1).
- **JSON.parse on a binary body:** it no longer changes the encoding of its argument (before UTF-8, after ASCII-8BIT). The parsed result is identical (probe-4).

## Gems that move with this upgrade
- **json:** 2.7.2 → 2.21.2, pinned `< 3`. json 3.1.0 breaks activesupport 8.1's JSON decoding (observed).
- **Added:** action_text-trix, rack-session, rackup, useragent, webrick.
- **Moved:** bigdecimal 4.1.3 (major), uri 1.1.2 (major), securerandom 0.4.1 (major), drb 2.2.3, net-imap 0.6.8.
- **Removed:** method_source.
- Probe-4 showed no change for `BigDecimal(...)`, `round(4)` or `URI.parse` in `web_url?`. securerandom's removed `Formatter` is `Random::Formatter`, not the `Logger::Formatter` the app uses.

## Optional: framework defaults
The app calls `load_defaults 7.0`. Values below are from the defaults probe on the after copy.

**Adopt now**
- `raise_on_invalid_cache_expiration_time`: currently false. Safe now that change 19 is in.
- `precompile_filter_parameters`: currently nil (old behaviour). Speed only.
- `action_dispatch.debug_exception_log_level = :error`: currently `:fatal`. Changes log level only.
- `log_file_size`: currently nil. Local environments only.

**Adopt later, in a separate step**
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: currently nil. Affects cookies and signed messages; needs two deploys for a rolling upgrade.
- `marshalling_format_version 7.1`: framework value 6.1. Affects caches.
- `default_column_serializer nil`: currently YAML. `notebook.rb:7 serialize :preferences` relies on YAML, so first change it to `coder: YAML`.
- `belongs_to_required_validates_foreign_key false`: currently true. Saves a query per save.
- `run_after_transaction_callbacks_in_order_defined true`: currently false. The app has no `after_commit` callbacks.
- `before_committed_on_all_records true`: currently false.
- `run_commit_callbacks_on_first_saved_instances_in_transaction false`: currently true.
- `raise_on_assign_to_attr_readonly true`: currently false. Affects `notebook.rb:8 attr_readonly :slug`, so check the settings form first.
- `query_log_tags_format :sqlcommenter`: currently `:legacy`.
- `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` (HTML5): currently HTML4. Re-test the `details`/`summary` allowlist when switching.
- `dom_testing_default_html_version :html5`: currently `:html4`. Tests only.
- `enqueue_after_transaction_commit`: framework value false. Affects `with_lock` + `perform_later` in `note.rb:62`, `citation.rb:20` and `user.rb:41`.
- `web_image_content_types` (adds webp): currently png, jpeg, gif.
- `postgresql_adapter_decode_dates`: currently nil. `notebook.rb:40` calls `Date.iso8601` on the raw value and would break, so change that code first.
- `to_time_preserves_timezone`: currently nil. Already covered by change 14.
- `strict_freshness true`: currently false. Affects `export_downloads_controller.rb:11 stale?`.
- `yjit`: currently false.

**Never, unless the feature is adopted**
- `encryption.hash_digest_class` and `support_sha1_for_non_deterministic_encryption`: the app uses no encryption.
- `sqlite3_adapter_strict_strings_by_default`: the app runs on PostgreSQL.
- `validate_migration_timestamps`: currently nil, no effect expected.
- `generate_secure_token_on`: the app has no `has_secure_token`.

**Nothing to adopt** (removed by 8.1): `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `use_big_decimal_serializer`, `commit_transaction_on_non_local_return`.

## Checked, not applicable
The one-line decisions for all 51 candidates are in `/tmp/gem-upgrade/repo-rails-8.1.0/candidates.md`. In short:
- **No change observed:** `serialize :preferences` and the tags raw format (probe-1), the sanitizer output (probe-3), `daily_note_counts` (probe-3), `X-Download-Options` still sent (probe-3), hidden-input `autocomplete` (probe-3), `inspect` filtering (probe-3), routes `only:`/`except:`, the test queue adapter.
- **Not applicable:** a different object of the same name. Examples are `Blob#purge`, `URI#host`, Relation vs instance `transaction`, `with_rich_text_body`, generator and CLI changes.
- **Additive:** features the app does not use.

## Not verified
- `production.rb:86`: the STDOUT logger is now wrapped in a BroadcastLogger. Production only (from source).
- The citation provider URL from `secrets.yml` (127.0.0.1:9393) was not isolated, so no code was run against a real provider. The tests use an in-process Puma stand-in.
- A Sidekiq mixed-version deploy and rollback was not run.
- The 13,954 commits were not reviewed one by one ("All commits listed: no").
- The cause of change 12's backport failure (thought to be change 3) is not proven.

## Evidence
- **Versions:** before rails 7.0.8.7, json 2.7.2. After rails 8.1.0, json 2.21.2.
- **Commands:** `setup`, `gem-changes`, `check` and `check --side after` (×19), `runner` probes 1–5, `validate` ×20, `backport`, `backport --hold`, the defaults probe, `diff --all`, `cleanup`.
- **Files and logs, in `/tmp/gem-upgrade/repo-rails-8.1.0`:**
  - `findings.md` (F1–F20)
  - `candidates.md`
  - `check-1.rb` to `check-20.rb`
  - `probe-1.rb` to `probe-5.rb`
  - `backport.patch`
  - `logs/`
- The copies, databases and Redis data were removed by `cleanup`. The application repository was not modified.

---

**Note:** This is a plan only. I haven't upgraded Rails, and your repository is unchanged. The upgrade-gem skill plans upgrades but doesn't apply them. If you want me to make the changes, I'd do it in two steps:
1. Ship the changes marked "Before" while still on 7.0.
2. Bump Rails and pin `json < 3` together with changes 3, 8, 10 and 12. Change 3 must never be deployed to a 7.0 server, because there it saves tags as YAML.

Tell me if you want me to go ahead.