# Plan for upgrading Rails 7.0.8.7 to 8.1.0 in Margin Notes

The upgrade is feasible without changing other dependencies. Plan it as three deploys, because a straight gem bump breaks badly. On 8.1.0 the app does not boot, and once it boots, about 20 code paths fail. Several of them corrupt or silently change data, and the existing tests do not catch them. Two of the needed changes must not be deployed early: one writes the wrong data format on 7.0, the other has the opposite meaning there.

I did not modify the working repository; `git status` is still clean. All experiments ran in disposable copies under `/tmp/exp`, using a private Postgres 15 cluster (port 5440, socket `/tmp/exp/pg`), a private Redis (port 6390), and each copy's own `tmp/` and `storage/`. Both services are stopped now.

## Experiments run
| Variant | Path | Resolved dependencies | Result and log |
|---|---|---|---|
| Baseline 7.0, unchanged | `/tmp/exp/v70` | lockfile as committed | 46 runs, 0 failures (`/tmp/exp/logs/v70-test.log`) |
| Rails 8.1.0 with probe fixes, `load_defaults 7.0` | `/tmp/exp/v81` (bundle in `/tmp/exp/bundle81`) | rails 8.1.0, json 2.21.2 (pinned), rack 2.2.24, sidekiq 6.5.12, puma 5.6.9, action_text-trix 2.1.19, concurrent-ruby 1.3.4, minitest 5.27.0 (`/tmp/exp/logs/v81-resolved.txt`) | Failures traced step by step in `v81-boot*.log` and `v81-test1..5.log`. Final run after the fixes: 46 runs, 0 failures (`v81-test-final2.log`). Full probe diff in `/tmp/exp/logs/v81-probe.diff` |
| 8.1 with `load_defaults` 7.1, 7.2, 8.0 and 8.1 (env `PROBE_LOAD_DEFAULTS`) | same copy | same | `/tmp/exp/logs/v81-defaults-{7.1,7.2,8.0,8.1}.log` and matching `.test.log` |
| 7.0 with the candidate early fixes | `/tmp/exp/v70p` | committed lockfile | 46 runs, 0 failures (`v70p-test-final2.log`). Diff in `/tmp/exp/logs/v70p-portable.diff` |
| Real Sidekiq jobs across versions (shared dev database `margin_exp_shared_dev`) | v70 and v81 | — | `/tmp/exp/logs/sidekiq-v81-to-v70.log`, `sidekiq-v70-to-v81.log`. Scripts in `/tmp/exp/scripts/` |
| Job payloads, cross-version job loading, signed-ID compatibility | — | — | `payload-*.log`, `cross-*.log`, and the sgid runs (`scripts/sgid_*.rb`; their output was printed but not saved to a log) |
| Booting `rails server` on 8.1 under Puma 5 | v81 | — | GET `/session/new` returned 200 (`v81-server.log`) |

Upstream sources for 7.1.5.2, 7.2.2.2, 8.0.3 and 8.1.0 are unpacked under `/tmp/up/src`, including the `new_framework_defaults_*.rb.tt` templates and `load_defaults` in `railties-8.1.0/lib/rails/application/configuration.rb`.

## Required changes

"Early" means the change can ship on 7.0 before the upgrade. For each, the second paragraph gives the evidence: "executed" means I ran it, "source" means I read the upstream code.

1. **json 3.x breaks Active Support 8.1.0.** Running `bundle lock --update rails` picked json 3.1.0, released 2026-10-13. Active Support's JSON decoding then raises `ArgumentError` on every JSON-serialized column, so every request touching notes failed. Pin `gem "json", "< 3"` and check the production lockfile resolution.
   - Executed. Early: not applicable (dependency resolution only).
2. **ActionText initializer crashes at boot** (`config/initializers/action_text.rb`). In 8.1 `allowed_tags` starts as nil, so `nil + [...]` fails. Compute the base list first: `allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]`, then add `details` and `summary`.
   - Executed. Early: yes, tested on 7.0.
3. **Old `enum` syntax** (`app/models/note.rb`). `enum status: {...}, _prefix: true` raises `ArgumentError` at class load. Use `enum :status, {...}, prefix: true`.
   - Executed. Early: yes.
4. **`alias_attribute :highlight_color, :color`** (`note.rb`). `color` is a store accessor, not a column, and 8.1 raises for that (`activerecord-8.1.0/lib/active_record/attribute_methods.rb:90`). Use `alias_method` for both `highlight_color` and `highlight_color=`. Validation errors stay keyed on `:color`, as now.
   - Executed. Early: yes.
5. **`serialize :tags, JSON` and `serialize :preferences`.** Positional coders and an implicit coder are gone. Use `coder: JSON` and `coder: YAML`.
   - **This must ship in the upgrade deploy, not before.** On 7.0, `serialize :tags, coder: JSON` silently falls back to YAML and would write YAML into `notes.tags`.
   - Executed: the 7.0 probe dumped `"---\n- a\n- b\n"`. Rolling back the code also reverts this line, and the stored formats are the same on both versions.
6. **Multi-path route** (`config/routes.rb:18`). `get "/notes", "/journal", ...` raises in 8.1. Split it into `get "/notes", to: "notes#index", as: :notes` and a separate `get "/journal", ...`.
   - Executed: route names are identical on 7.0 and 8.1. Early: yes.
7. **`form_with(model: nil, ...)`** (`app/views/notes/index.html.erb:12`) raises `ArgumentError`. Drop `model: nil`.
   - Executed. Early: yes.
8. **`Rails.application.secrets` was removed in 7.2** (`app/models/citation/provider.rb:13`, the test helper at `test/controllers/citation_enrichments_controller_test.rb:45,117`).
   - Move the provider settings to `config/citation_provider.yml` with the same ENV lookups, and load them with `config.x.citation_provider = config_for(:citation_provider)`.
   - Update `ARCHITECTURE.md:79-80`, `CONTRIBUTING.md:38`, the comment in `bin/citation-provider`, and `config/secrets.yml`.
   - Executed. Early: yes.
9. **`config.action_dispatch.show_exceptions = false`** (`config/environments/test.rb`). On 8.1 the tests stop seeing `RecordNotFound` raised. Use `:none`.
   - Ship with the upgrade. On 7.0, `:none` is a truthy value and would turn exception rendering on (source-based, not executed).
10. **`set(wait_until: reminder_epoch)` with an Integer** (`note.rb:62`). 8.1 raises `NoMethodError: utc`, so reminders cannot be scheduled. Use `Time.at(reminder_epoch)`.
    - Executed. Early: yes.
11. **`where(notebooks: @notebook)`** (`app/controllers/notes_controller.rb:18`). The notebook filter returns 500 on 8.1. Use `where(notebook: @notebook)`.
    - Executed. Early: yes.
12. **`fragments.sum` on strings** (`app/models/export.rb:42`). Active Support no longer extends `sum`, so `ExportJob` raises `TypeError`. Exports stay "working" while Sidekiq retries. Use `fragments.join`.
    - Executed. Early: yes.
13. **Import preview loses annotations** (`app/views/imports/preview.html.erb`). On 8.1, `stringify_keys` on the indifferent-access hash turns integer line keys into strings, so annotations disappear without an error. Drop `.stringify_keys`.
    - Executed. Early: yes.
14. **Import receipt loses the DOI** (`app/models/import.rb`). `citation[:id]` now returns nil when the primary key is `doi`, so receipt CSV downloads have an empty DOI column. Use `citation&.doi`.
    - Executed (`payload-v81.log`). Early: yes.
15. **`Import#apply` saves partial imports.** A `return false` inside `transaction` now commits, so an import with an invalid row persists the import and the earlier rows. Use `raise ActiveRecord::Rollback unless rows.all?(&save)` and return a flag.
    - Executed: the test's record counts changed by +1. Early: yes, tested.
    - Audit production for orphan partial imports only if 8.1 ever ran without this fix.
16. **`retry_on ... wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb`). Nothing fails at boot; the error surfaces only when a retry is scheduled ("Couldn't determine a delay").
    - `fail_enrichment` is then never called, the citation stays `pending` for good, and `request_enrichment` refuses to queue another lookup.
    - Use `wait: ->(executions) { executions**4 + 2 }`, which matches the current curve and works on 7.0. `:polynomially_longer` does not exist on 7.0.
    - Executed.
17. **Digest day changes, and readers would not be told.** 8.1 jobs now keep the time zone of `TimeWithZone` arguments. `DigestMailer` would then pick the reader's local day, while the UI promises the UTC day: the test got "October 04" instead of "October 05".
    - Normalize in the mailer with `requested_at = requested_at.utc`. That keeps the enqueued payload unchanged, which a test asserts.
    - Executed on both versions. Early: yes.
18. **BigDecimal job argument** (`app/models/user.rb`, `reading_completion`). This is a queue compatibility problem; see the rollout section. Pass `reading_completion.to_s`.
    - Executed. Early: yes, and it must ship before any 8.1 process enqueues jobs.
19. **`next_day_reminder_at`** (`note.rb`, and the hint in `_reminder.html.erb`). In 8.1, `to_time` always keeps the zone and there is no opt-out; the setting is deprecated. The displayed time therefore follows daylight saving instead of the "keeps UTC offset" behavior the code comment describes. The epoch stored on postpone is unchanged.
    - To keep today's behavior, use `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)` (executed on both versions).
    - The alternative is a product decision: accept local wall-clock time and update the comment and the test.

## Configuration defaults, release by release

The app keeps every old value: it has `config.load_defaults 7.0`, no `new_framework_defaults_*` files, and no overrides. "Keeps old" means the 7.0 behavior stays until the value is opted into.

**7.1**

| Setting | What adopting it would do here |
|---|---|
| `raise_on_assign_to_attr_readonly` | **Breaks** notebook settings save: the form resubmits `slug`, giving `ReadonlyAttributeError` (executed). Fix first by removing `:slug` from the permitted params (works on 7.0, not executed). |
| `raise_on_invalid_cache_expiration_time` | **Breaks** the exports page for expired completed exports. `expires_in` goes negative at `app/views/exports/_export.html.erb:26` (executed). Without it, 8.1 logs a warning and caches the "Expired" fragment with no expiry, which is harmless. Fix: only use `cache` while downloadable, or clamp the value. |
| `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata` | 8.1 still reads old signed IDs. But signed IDs created after adoption are unreadable on 7.0 (executed). ActionText stores these inside `action_text_rich_texts.body`, so attachments created afterward break on rollback. Session and cookie compatibility on rollback was not tested. Adopt only after the rollback window closes. |
| `cache_format_version = 7.1` | Production uses the default file cache in `tmp/cache`. 7.0 cannot read 7.1-format entries. Clear the cache on rollback or adopt late (not tested). |
| `default_column_serializer = nil` | Covered by item 5. |
| `action_view` and `action_text` `sanitizer_vendor` (HTML5) | Stored rich text gets re-parsed by the HTML5 sanitizer. Tests passed, but the item-2 initializer must compute its tag list from the active vendor. |
| `belongs_to_required_validates_foreign_key = false` | Fewer queries. No behavior change here. |
| `dom_testing_default_html_version` | Affects test parsing only. Tests passed. |
| `add_autoload_paths_to_load_path = false`, `precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level` | No effect on this app. |
| `default_headers` (drops `X-Download-Options`) | Matters only for Internet Explorer downloads. |
| `query_log_tags_format`, SQLite strict strings, encryption digest, `marshalling_format_version`, `generate_secure_token_on`, the commit-callback ordering settings (`run_commit_callbacks_on_first_saved_instances_in_transaction`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`) | No effect: the app has no commit callbacks, encryption or secure tokens. |
| Forced in 8.x, so the old value cannot be kept: `commit_transaction_on_non_local_return` (item 15), `use_big_decimal_serializer` (item 18), `allow_deprecated_singular_associations_name` (item 11), `allow_deprecated_parameters_hash_equality` | The app does not compare params, so the last one has no effect. |

**7.2**

| Setting | What adopting it would do here |
|---|---|
| `postgresql_adapter_decode_dates` | **Breaks** the activity report: `Date.iso8601(Date)` raises `TypeError` at `app/models/notebook.rb:40` (executed). Fix with `Date.iso8601(day.to_s)` (not executed). |
| `enqueue_after_transaction_commit` | Not a `load_defaults` entry in 8.1; its value is `false` here (executed). Setting it true would undo the guarantees documented in `Citation#request_enrichment` and `Note#schedule_reminder` that a failed enqueue rolls back. Keep it false. |
| `web_image_content_types` adds webp | Webp attachments would display inline. Minor. |
| `validate_migration_timestamps` | Existing migrations are fine. Future-dated migrations would raise. |
| `yjit = true` | Higher memory use. |

**8.0**

| Setting | What adopting it would do here |
|---|---|
| `to_time_preserves_timezone = :zone` | Forced anyway in 8.1 (item 19). |
| `strict_freshness` | Export downloads send ETag and Last-Modified. With this on, `If-None-Match` alone decides. The ETag is the blob checksum, so the result is the same (source-based). |
| `Regexp.timeout = 1` | Low risk: DOI validation regex and CSV parsing. |

**8.1**

| Setting | What adopting it would do here |
|---|---|
| `escape_json_responses = false`, `escape_js_separators_in_json = false` | No `render json` or view `to_json` in the app. |
| `action_on_path_relative_redirect = :raise` | All redirects use route helpers. |
| `raise_on_missing_required_finder_order_columns` | Every model has a primary key. |
| `render_tracker = :ruby` | The export fragment's cache digest changes once. |
| `remove_hidden_field_autocomplete` | Changes `button_to` markup only. |
| `yjit = !local` | Higher memory use in production. |

Running the whole suite under 8.1 defaults produced no further failures beyond the ones above (executed).

## Rollout, queued work and rollback

**Deploy A, on 7.0.** Ship items 2–4, 6–8, 10–19, plus the slug, date-decoding and cache fixes. The 7.0 suite passes with the tested subset; the slug, date-decoding and cache fixes are not yet tested.

**Deploy B, the upgrade.**
- Changes: `rails` 8.1.0, the json pin, item 5 (`serialize` coders), and item 9 (`show_exceptions`). Keep `load_defaults 7.0`.
- Jobs left in Redis by 7.0 run fine on 8.1 workers (executed):
  - DigestJob runs under the old UTC semantics.
  - NoteReminderJob runs and sends its email.
  - ExportJob is a native Sidekiq job, so its payload does not change.
- An 8.1 web process enqueuing a raw BigDecimal for a 7.0 worker fails with `DeserializationError` (executed). It lands in the Sidekiq retry set, and that reader's daily Redis reservation is already taken, so they cannot request again that day. This also applies to 8.1-enqueued jobs left over after a rollback. Deploy A's `.to_s` removes this risk.
- 8.1 payloads also carry `time_zone` and `scheduled_at`. 7.0 ignores them, and with item 17's mailer change the result is the same.

**Deploy C onward.** Adopt defaults one file at a time. Do the 7.1 message serializer, metadata format and cache format last, after the rollback window closes.

## Dependency notes
- **Sidekiq 6.5.12** works with 8.1's built-in adapter, with a deprecation warning saying it is removed in 8.2 (executed).
  - Moving to Sidekiq 7.3.3 or later would bring strict arguments: `ExportJob.perform_async(..., { format: })` passes symbol keys, which already logs a warning now.
  - It would also bring redis-client, and the `Sidekiq.redis` `sadd`/`srem` return values in `User#request_digest` need checking.
- **Rack stays on 2.2**, because Sidekiq 6.5 pins it, and **Puma 5.6.9** serves fine (executed). Puma 6 would break the test helper's `Puma::Events.strings`.
- **Trix:** the layout loads the vendored `trix-1.3.5.js`, but 8.1 brings `@rails/actiontext` JavaScript and action_text-trix 2.1.19, built for Trix 2. Compatibility is untested.
- **image_processing:** an 8.1 worker logs a warning that it is missing. Consider `variant_processor = :disabled`.

## Still unverified
- **Browser suite:** `bin/rails test:system` was not run. In particular, rich-text editing and attachment upload with Trix 1.3.5 are untested.
- **Untested fixes:** the slug-param, date-decoding and cache-partial fixes.
- **Untested rollback risks:** session and cookie compatibility, and the cache format, if the 7.1 message and cache defaults are adopted.
- **Credentials and production state:**
  - Whether `config/credentials.yml.enc` holds `secret_key_base` for production. I could not decrypt it, and 8.1 no longer reads `secrets.yml`.
  - Whether production Redis currently holds retrying CitationEnrichment jobs.
  - Whether any partial imports already exist.
- **Version choice:** 8.1.0 lacks later patch and security releases (8.1.2.1, 8.1.3.1, 8.1.4 exist). Should the target be the latest 8.1.x? If so, re-check the json 3 incompatibility against it.
- **Upgrade path:** going straight to 8.1 skips the 7.1 and 7.2 deprecation shims. The source review above stands in for them; stepping through each minor version is the more conservative path.

---

**Next steps:** The upgrade skill only produces a plan, so I haven't changed your repository. It's still clean on `main`. To go ahead, I need two decisions from you:

1. **Target version:** exactly 8.1.0, or the latest 8.1.x? The latest includes later security fixes.
2. **Reminder times (item 19):** keep today's fixed-UTC-offset behavior, or switch to local wall-clock time, which follows daylight saving?

Once you've decided, I'd begin with Deploy A: the fixes that work on 7.0 and can ship before the gem bump.