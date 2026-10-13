I've built an upgrade plan for Rails 7.0.8.7 → 8.1.0. Your repository has not been changed. Here is the plan in full:

---

This app won't boot on 8.1.0 as it stands. I fixed it in a disposable copy and the suite then passed (46 runs, 340 assertions, 0 failures), with the app still on its current framework defaults (`load_defaults 7.0`). Most fixes also run on 7.0, so they can ship before the gem bump. Separately, a real Sidekiq 6.5.12 worker on 8.1 processed an export, a digest and a reminder correctly. The repository was not modified.

## What was run

- **Isolation:** clones under `/tmp/upg-exp/`, with their own Postgres cluster (port 55432), Redis (port 56379), bundle path, test and dev databases, and storage under each clone. All environment variables are in `/tmp/upg-exp/env.sh`; logs are in `/tmp/upg-exp/logs/`. I stopped Postgres and Redis afterwards. I removed `mise.toml` from the clones rather than trusting them.
- **Gems resolved for 8.1:** rails 8.1.0, sidekiq 6.5.12, rack 2.2.24, action_text-trix 2.1.19, concurrent-ruby 1.3.4, minitest 5.27.0, json 3.1.0 at first, then 2.21.2 after pinning.

| Variant | Result | Log |
|---|---|---|
| `base`: 7.0.8.7, unchanged | 46 runs, 0 failures | `base-test.log` |
| `v81`: 8.1.0, `load_defaults 7.0`, no app changes | won't boot | `v81-dbprep.log` |
| `v81`, after each fix in turn | 7 intermediate runs | `v81-test2.log` … `v81-test7.log` |
| `v81` with all fixes | 0 failures | `v81-test8.log`, patch in `v81-patch.diff` |
| `v81d`: `v81` plus `load_defaults 8.1` (and `coder: YAML`) | 3 errors | `v81d-test2.log` |
| `prep70`: the 7.0-safe fixes on 7.0.8.7 | 46 runs, 0 failures | `prep70-test.log`, patch in `prep70-patch.diff` |
| Job payloads swapped between 7.0 and 8.1 | see the queue section | `deser-70-on-81.log`, `deser-81-on-70.log` |
| Real Sidekiq worker on 8.1, development env | export, digest and reminder all worked | `v81-sidekiq.log` |

I could not run the browser suite because no Chrome or chromedriver is installed.

## A. Required changes

"Confirmed" means a test failed or the app failed to boot on 8.1 and passed after the fix. "Source" means I read it in the gem code but no test exercised it. "Works on 7.0" means the fix passed in `prep70`.

1. **Rich-text allowlist (boot failure, 7.1+).** Confirmed: `config/initializers/action_text.rb` stops boot with `undefined method '+' for nil`, because `allowed_tags` is now empty until set. Fix: set it inside `after_initialize`, starting from `allowed_tags ||` the default sanitizer list plus attachment, `figure` and `figcaption`, then add `details` and `summary`. Works on 7.0. A request test checks that collapsible excerpts survive.
2. **`enum status:` with `_prefix:` (removed in 8.0).** Confirmed in `app/models/note.rb`. Fix: `enum :status, {...}, prefix: true`. Works on 7.0.
3. **`serialize :tags, JSON` (removed in 7.2).** Confirmed. Fix: `serialize :tags, coder: JSON`, which only exists from 7.1, so it can't ship on 7.0. The stored format doesn't change.
4. **`alias_attribute :highlight_color, :color` (error in 7.2).** Confirmed: `color` comes from `store_accessor`, not a real attribute, so 7.2 raises. Fix: `alias_method` for both the reader and the writer. Works on 7.0.
5. **Route to two paths (removed in 8.1).** Confirmed: `config/routes.rb:18`, `get "/notes", "/journal"`. Fix: `get "/notes", to: "notes#index", as: :notes` plus a separate `get "/journal", ...`. Works on 7.0, and `bin/rails routes` shows the same names.
6. **`fragments.sum` on strings (7.1).** Confirmed: `app/models/export.rb` raises a TypeError because Active Support no longer sums strings. Fix: `fragments.join`. Works on 7.0.
7. **`form_with(model: nil, ...)` (removed in 8.0).** Confirmed in `app/views/notes/index.html.erb:12`. Fix: leave out `model:`; the field names stay unscoped. Works on 7.0.
8. **`where(notebooks: @notebook)` (removed in 7.2).** Confirmed: the plural name for a singular association breaks note filtering in `app/controllers/notes_controller.rb:11`. Fix: `where(notebook: @notebook)`. Works on 7.0.
9. **Integer `wait_until` (removed in 7.2).** Confirmed: `Note#schedule_reminder` raises `undefined method 'utc' for Integer`. Fix: `set(wait_until: Time.at(reminder_epoch))`. Works on 7.0.
10. **`Rails.application.secrets` (removed in 7.2).** Confirmed in `app/models/citation/provider.rb:13` and in `test/controllers/citation_enrichments_controller_test.rb`. Fix: move `config/secrets.yml` to `config/citation_provider.yml` and load it with `config.x.citation_provider = config_for(:citation_provider)`. Works on 7.0.
    - Keep the `.to_json` quoting in the new YAML. My first unquoted version broke the "credentials reach the server unchanged" test because the test password contains YAML-significant characters.
    - Production must still supply the `CITATION_PROVIDER_*` environment variables.
11. **`wait: :exponentially_longer` (removed in 7.2).** Confirmed in `app/jobs/citation_enrichment_job.rb`. On 8.1, use `:polynomially_longer`. On 7.0, use the lambda `->(executions) { executions**4 + 2 }`, which keeps the backoff (lambda tested on 7.0 only).
12. **Import keeps invalid rows (7.2; data integrity).** Confirmed: `Import#apply` uses `return false` inside `transaction`. On 7.0 that rolls back; on 7.2+ it commits. The test saw `[0,3,0,1]` become `[1,4,1,2]`, meaning a failing import saved the import record plus its valid rows. Fix: `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }` with `true` as the block's last value, then `|| false`. Works on 7.0. Any partial imports created while running 7.2+ before this fix would stay in the database.
13. **Import receipt loses DOIs (7.2; caught only by a test).** Source: `citation[:id]` in `Import#receipt` returns nil from 7.2 because `doi` is the primary key, so the CSV's doi column comes out blank without any error. Fix: `citation&.doi`. Works on 7.0.
14. **Import preview loses annotations (8.0).** Confirmed: `app/views/imports/preview.html.erb:22` calls `.stringify_keys` on an indifferent hash keyed by integer line numbers. In 8.0 that turns the keys into strings, so `annotations[row.line]` finds nothing. Fix: drop `.stringify_keys`. Works on 7.0.
15. **Test config (7.1, removed 7.2).** In `config/environments/test.rb`, change `show_exceptions = false` to `:none`. This is 7.1+ only: on 7.0 the symbol counts as true.
16. **Digest covers the wrong day (7.1; behaviour change).** Confirmed: the subject went from "October 05" to "October 04". Since 7.1, Active Job keeps a time's zone through the queue, so `DigestMailer` now uses the reader's local day. That no longer matches the UTC reservation key in `User#request_digest` or the "UTC day" text shown to users. Fix: `requested_at = requested_at.in_time_zone("UTC")` in the mailer. Works on 7.0.
17. **"24 hours later" display changes across DST (8.1).** Confirmed: the expected `2026-11-01T09:00:00-04:00` no longer appears. In 8.1, `to_time` always keeps the reader's time zone. The stored epoch (`to_i`) is unchanged; only the time shown in `notes/_reminder.html.erb` changes. To keep the documented fixed-offset display: `(reminder_at + 86_400).getlocal(reminder_at.utc_offset)`, which works on 7.0. The alternative is a product decision to accept the zone-aware display and update the comment and test.
18. **json gem (dependency).** Confirmed: `bundle update rails` pulled in json 3.1.0, and Active Support 8.1.0 then failed on every session read (`ArgumentError` in `JSON.parse`). The experiment pinned `gem "json", "< 3"`. I didn't check whether a later 8.1.x release fixes this.

## B. Framework defaults (optional; app stays on `load_defaults 7.0`)

None of these change unless adopted. With the A fixes plus `coder: YAML` in place, `load_defaults 8.1` caused exactly three errors, all predicted (`v81d-test2.log`). Each row says what changes for this app if the new default is adopted.

### 7.1

| Default | Effect here and recommendation |
|---|---|
| `default_column_serializer = nil` | Confirmed: `serialize :preferences` in `app/models/notebook.rb` raises. Add `coder: YAML` first (7.1+); the stored YAML is readable unchanged. |
| `raise_on_assign_to_attr_readonly = true` | Confirmed: every notebook settings save raises `ReadonlyAttributeError`, because `notebooks/_form.html.erb` resubmits `slug` and `NotebooksController#notebook_params` permits it. Stop permitting `:slug`; works on 7.0. |
| `raise_on_invalid_cache_expiration_time = true` | Confirmed: `exports/_export.html.erb:26` raises for an expired export, which in production would mean a 500 on the exports page. Use `cache_if export.downloadable?, ...`; works on 7.0. |
| `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata` | Affects signed and encrypted messages, including Action Text attachment ids stored inside saved rich text. If adopted, 7.0 servers can't read messages created afterwards. Adopt only after rollback to 7.0 is off the table. Not tested. |
| `marshalling_format_version = 7.1` | The app caches only HTML fragments, so little effect. Same rollback caveat. |
| `use_big_decimal_serializer` | Moot: from 8.0 this serializer is always on (see the queue section). |
| `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction` | No `after_commit` callbacks in the app; no effect expected. |
| `commit_transaction_on_non_local_return` | Moot: 7.2 always commits (fix A12). |
| `belongs_to_required_validates_foreign_key = false` | One fewer query on save. Low risk. |
| `generate_secure_token_on`, encryption hash settings, `sqlite3_adapter_strict_strings_by_default` | Not used in this app (no `has_secure_token`, no encryption, Postgres). |
| `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size` | Logging and performance only. |
| `allow_deprecated_singular_associations_name`, `allow_deprecated_parameters_hash_equality` | Removed anyway; covered by fix A8. No `params == hash` comparisons found. |
| `action_view.sanitizer_vendor` / `action_text.sanitizer_vendor` → HTML5 | Rich text and `simple_format` output may change slightly. Rerun the collapsible-excerpt test and compare stored notes. |
| `dom_testing_default_html_version = :html5` | Test selectors parse differently; rerun the suite. |

### 7.2

| Default | Effect here and recommendation |
|---|---|
| `postgresql_adapter_decode_dates = true` | Confirmed: `Notebook#daily_note_counts` raises because `Date.iso8601` now receives a `Date`. Accept both types (`day.is_a?(Date) ? day : Date.iso8601(day)`); works on 7.0. |
| `enqueue_after_transaction_commit = :default` | On 7.2 only, this would queue jobs after commit. That breaks the "failed enqueue rolls back" guarantee in `Citation#request_enrichment` and `Note#schedule_reminder`. Don't adopt on 7.2; from 8.0 the default is off again. |
| `web_image_content_types` adds WebP | No variants are generated here. Negligible. |
| `validate_migration_timestamps` | Existing migration timestamps are valid. |
| `yjit = true` | Turns on YJIT in production (Ruby 3.3.6). Watch memory. |

### 8.0

| Default | Effect here and recommendation |
|---|---|
| `to_time_preserves_timezone = :zone` | Same effect as A17; 8.1 behaves this way regardless of the setting. |
| `strict_freshness = true` | `ExportDownloadsController` uses `stale?` with both an ETag and Last-Modified. Only `If-None-Match` will be checked; both values are stable, so effect is minimal. |

### 8.1

The checklist tool didn't list these; I took them from `railties-8.1.0/lib/rails/application/configuration.rb`.

| Default | Effect here |
|---|---|
| `escape_json_responses = false`, `escape_js_separators_in_json = false` | No JSON is rendered or embedded in views. |
| `action_on_path_relative_redirect = :raise` | No relative redirects found. |
| `raise_on_missing_required_finder_order_columns` | Not hit in the tests. |
| `render_tracker = :ruby` | Affects cache digests for the export fragment. |
| `remove_hidden_field_autocomplete` | Markup change only. |
| `yjit` | Off in development and test. |

## C. Queued work, stored data, mixed versions and rollback

Executed check: I serialized jobs on each version and deserialized them on the other.
- **7.0 payloads on 8.1:** all fine. A time without a zone is read as UTC.
- **8.1 `DigestJob` on 7.0:** fails with `DeserializationError: BigDecimalSerializer is not known`. `DigestJob` has no `discard_on`, so a rolled-back or still-old worker retries it until it dies. Meanwhile the reader's daily Redis reservation stays in place, so no digest goes out that day.
- **Preparatory fix:** in `User#request_digest`, enqueue `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`, so this works on every version.
- **Zone in time arguments:** 7.1+ adds a time-zone field to queued times. 7.0 ignores it, and fix A16 makes both behave the same.
- **`scheduled_at`:** reminder payloads gain this field from 7.1. 7.0 ignores it, and Sidekiq does the actual scheduling.
- **Stored data:** the notes `tags` JSON and notebook `preferences` YAML formats are unchanged.

## Recommended order

1. On 7.0, ship and deploy the 7.0-safe fixes: A1, A2, A4–A14 (the lambda form of A11), A16, A17 if the old display is wanted, the digest `.to_s` change, `slug` no longer permitted, `cache_if`, and the date handling.
2. Upgrade in steps (7.1 → 7.2 → 8.0 → 8.1), holding `load_defaults 7.0` throughout. At 7.1, apply A3, A15, `coder: YAML`, and `:polynomially_longer`.
3. Before each deploy, drain or inspect the scheduled and retry queues in Sidekiq.
4. Adopt new defaults one at a time once rollback is no longer needed, leaving the message-serializer settings until last.

## Not verified / open questions

- **Browser and Trix:** the app loads Trix 1.3.5 itself (`layouts/application.html.erb`, `vendor/javascript/trix-1.3.5.js`) alongside `@rails/actiontext` from 8.1, which now pulls in a separate Trix 2 gem. Whether editing and attachment uploads still work needs the browser suite. Also check whether Trix 1.3.5 is affected by CVE-2024-34341.
- **Sidekiq:** 6.5.12 works with 8.1's built-in Sidekiq adapter, which is deprecated in 8.1 and removed in 8.2. Moving to Sidekiq 7.3.3+ will need `ExportJob`'s symbol-keyed hash argument fixed (strict arguments) and the redis 4.8 → redis-client switch. rack stays at 2.2 because Sidekiq 6.5 requires it.
- **Passwords:** since 7.1, `has_secure_password` rejects new passwords over 72 bytes (not tested).
- **Other pins:** the `concurrent-ruby 1.3.4` pin can probably go after 7.1 (not tested).
- **Not run:** the browser suite, the 7.1/7.2/8.0 intermediate versions themselves (only 7.0 and 8.1 were run), production-like caching, and real CSV or rich-text content from production.

## Paths

- Repo files: `/home/user/workspace/repo/app/models/{note,notebook,import,export,user}.rb`, `/home/user/workspace/repo/app/models/citation/provider.rb`, `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb`, `/home/user/workspace/repo/app/mailers/digest_mailer.rb`, `/home/user/workspace/repo/app/controllers/{notes,notebooks}_controller.rb`, `/home/user/workspace/repo/app/views/{notes/index,notes/_reminder,imports/preview,exports/_export,notebooks/_form,layouts/application}.html.erb`, `/home/user/workspace/repo/config/{routes.rb,secrets.yml,application.rb}`, `/home/user/workspace/repo/config/initializers/action_text.rb`, `/home/user/workspace/repo/config/environments/test.rb`
- Experiment logs and patches: `/tmp/upg-exp/logs/` (including `v81-patch.diff` and `prep70-patch.diff`)
- Experiment scripts: `/tmp/upg-exp/scripts/ser.rb`, `/tmp/upg-exp/scripts/deser.rb`
- Checklist tool output: `/tmp/gc.txt`

---

**Next steps:**
- **Decide on fix 17:** either keep the old fixed-offset reminder display, or accept the new zone-aware one and update the test.
- **Run the browser suite:** this needs Chrome and chromedriver installed. Without it, Trix editing and attachment uploads are unchecked.
- **Start implementing:** the safest first step is the 7.0-safe fixes in `/tmp/upg-exp/logs/prep70-patch.diff`. That patch passes the suite on 7.0.8.7 and is ready to review and apply. I can apply it on a branch if you want.