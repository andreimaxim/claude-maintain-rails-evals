# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but it is not a version bump. Changing only the Rails version, Rails 8.1.0 fails to boot. Once it boots, all 46 tests error. After 19 fixes it passes all 46 tests with `load_defaults 7.0`. With three more fixes it passes at every defaults level from 7.1 to 8.1.

Several of the changes are silent data or behaviour changes that the tests only caught because of specific assertions:
- partial CSV imports getting saved;
- DOIs disappearing from import receipts;
- digests covering the wrong day.

There are also two rollout/rollback risks that only showed up when running both versions side by side.

The working repository was not modified (`git status` is clean).

## What I ran
- **Change index:** `ruby /home/user/planner-run/maintain-rails/bin/gem-changes rails 7.0.8.7 8.1.0`, output in `/tmp/upg/changes.txt`.
  - Its 8.1 defaults section is empty. Railties 8.1.0 actually adds six defaults, which are listed below.
  - It also lists five settings that 8.1 no longer has, because their new behaviour is now always on.
- **Disposable copies:**
  - `/tmp/upg/base` is the current code on 7.0.8.7.
  - `/tmp/upg/v81` is the upgraded copy, with gems in its own `vendor/bundle`. `load_defaults` is switched by an `UPG_DEFAULTS` environment variable.
  - `/tmp/upg/prep70` is 7.0 plus only the changes that also work on 7.0.
- **Isolated services:**
  - Databases `upg_base_test`, `upg_v81_test`, `upg_v81_dev` and `upg_prep70_test`.
  - A private Redis on port 6391 with no persistence, now shut down. The shared Redis and the app's own databases were never touched, which matters because the digest test calls Redis directly.
  - Storage and mail stayed inside each copy.
- **Dependencies resolved for 8.1:**
  - rails 8.1.0, puma 5.6.9, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, turbo-rails 2.0.12, minitest 5.27.0.
  - json is pinned at 2.21.2; the first resolution chose json 3.1.0, which breaks (item 5 below).
  - Lockfile diff: `/tmp/upg/logs/lock-diff.txt`.
- **Patch record:** all changes are in `/tmp/upg/full-81.diff` (8.1) and `/tmp/upg/prep70.diff` (changes that also work on 7.0).

| Run | Result | Log |
|---|---|---|
| Baseline 7.0 | 46 runs, 0 failures; one deprecation (`Enumerable#sum`) | `/tmp/upg/logs/base-test.log` |
| 8.1, only the Rails version changed | does not boot | `/tmp/upg/logs/v81-boot.log` |
| 8.1, then each fix added in turn | 46 errors, then 3 failures, then green | `/tmp/upg/logs/v81-test1.log` to `v81-test6.log` |
| 8.1 + all fixes, `load_defaults` 7.0 / 7.1 / 7.2 / 8.0 / 8.1 | all 46/0 | `/tmp/upg/logs/v81-final-defaults-*.log`, `v81-last-*.log` |
| 7.0 + the changes that also work on 7.0 | 46/0, no deprecations | `/tmp/upg/logs/prep70-test2.log` |
| `zeitwerk:check` and `bin/rails server` on 8.1 | pass; pages return 200/301/302; Puma 5.6.9 works on Rack 2.2 | `/tmp/upg/logs/v81-server.log` |

There are no system tests (`test/system` contains only `.keep`), so no browser checks were possible.

## A. Required changes (with `load_defaults 7.0` kept)

"Prep" means the change also works on 7.0 and can ship before the upgrade. I confirmed that by running the 7.0 suite with all prep changes applied. "Upgrade only" means it must ship in the same commit as the Rails bump.

1. **Boot failure in `config/initializers/action_text.rb`.** From 7.1, `ActionText::ContentHelper.allowed_tags` starts as nil, so `nil + [...]` raises `NoMethodError`.
   - Fix: inside `after_initialize` and `on_load(:action_view)`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]) | %w[details summary]`.
   - Prep. The "collapsible excerpts" test passes at every defaults level.
2. **`enum status: {...}, _prefix: true` in `Note`** is removed in 8.0. Change to `enum :status, {...}, prefix: true`, the form `Citation` and `Export` already use. Prep.
3. **`serialize :tags, JSON` in `Note`** is removed. Change to `serialize :tags, coder: JSON`. For `Notebook`, make it `serialize :preferences, coder: YAML`.
   - **Upgrade only.** On 7.0, `coder:` is silently ignored and YAML is used, which broke 15 tests and would corrupt stored tags.
   - I confirmed the stored JSON and YAML are byte-identical between versions and readable in both directions.
4. **`alias_attribute :highlight_color, :color` (a store accessor)** raises from 7.2. Replace it with `alias_method` for the getter and setter, which are the only methods the views, controller and tests use. Prep.
5. **Dependency: json 3.x.** activesupport 8.1.0 adds `json` as a dependency, and bundler picked json 3.1.0. activesupport 8.1.0 then calls `JSON.parse` with a positional options hash, which json 3 rejects. Every JSON column read failed.
   - Fix: add `gem "json", "~> 2.7"`, or use a later 8.1.x if it fixes this; I did not check.
   - I only verified this in the 8.1 bundle.
6. **`get "/notes", "/journal", to: ...` in `config/routes.rb`.** Routes with several paths are removed in 8.1. Split it into two `get` lines with `as: :notes` and `as: :journal`; the route names are unchanged. Prep.
7. **`config.action_dispatch.show_exceptions = false` in `config/environments/test.rb`.** In 8.1, `false` means show all exceptions. That made `assert_raises(RecordNotFound)` and the Redis-failure test pass for the wrong reason or fail.
   - Fix: `:none`.
   - Upgrade only. Based on the 7.0 source, which treats any truthy value as "show", I did not run 7.0 with `:none`.
8. **`Rails.application.secrets` in `Citation::Provider` and the citation enrichment test** is removed in 7.2.
   - Fix:
     - Move the values to `config/citation_provider.yml`.
     - Load them with `config.x.citation_provider = config_for(:citation_provider)`.
     - Read them through `Rails.configuration.x.citation_provider`.
   - Prep. It passes on both versions, including the test that boots a fresh process with credentials from the environment.
   - Production environment variables are unchanged. Delete `config/secrets.yml` afterwards.
9. **`fragments.sum` in `Export#generate`** raises `TypeError` once Active Support's `sum` override is gone. Use `fragments.join`. Prep.
10. **`form_with(model: nil, ...)` in `notes/index.html.erb`** raises from 8.0. Drop `model: nil`. Prep.
11. **`retry_on ..., wait: :exponentially_longer` in `CitationEnrichmentJob`** is removed in 7.2.
    - Prep option: a lambda `->(n) { n**4 + 2 }`. It drops 7.0's 15% jitter (7.0 source: `JITTER_DEFAULT` is 0.15). Add `rand * n**4 * 0.15` if you want the jitter back.
    - In the upgrade commit, `:polynomially_longer` is the equivalent.
12. **`@notes.where(notebooks: @notebook)` in `NotesController#index`.** Using the plural association name is no longer allowed and now produces a bad SQL column. Use `where(notebook: @notebook)`. Prep.
13. **`NoteReminderJob.set(wait_until: reminder_epoch)` with an Integer** fails with "undefined method `utc` for Integer". Use `Time.at(reminder_epoch)`. Prep.
14. **Silent: `@import.annotations.stringify_keys` in `imports/preview.html.erb`.** From 8.0, Integer keys are turned into strings, so the annotation lookup by line number misses and annotations quietly vanish from the preview. Drop `stringify_keys`. Prep.
15. **Silent: `TimeWithZone` job arguments now keep the sender's time zone (7.1).** `DigestJob` receives `requested_at` in the reader's zone, so `to_date` and `all_day` follow the reader's local day instead of the documented UTC day. Readers west of UTC get the wrong day.
    - Fix: `requested_at = requested_at.utc` in `DigestMailer#daily_digest`. Prep.
16. **Silent: `citation[:id]` in `Import#receipt`.** It returned the DOI on 7.0; on 8.1 it returns nil because `Citation`'s primary key is `doi` (confirmed with a direct check on both versions). CSV receipts silently lose their DOIs.
    - Fix: `note.citation&.doi`. Prep.
17. **Data integrity: `return false` inside `transaction` in `Import#apply`.** On 8.1 this commits, so an invalid import saves the import record and earlier rows (test: record counts `[1,4,1,2]` instead of `[0,3,0,1]`).
    - Fix: `raise ActiveRecord::Rollback` and return `applied || false`. Prep.
18. **Product decision: `Note#next_day_reminder_at` uses `reminder_at.to_time + 86_400`.** 8.1 always keeps the time zone (the old setting is deprecated). Across a DST change, the "24 hours later" label in `_reminder.html.erb:19` changes from the old offset (for example `-04:00`) to the reader's zone. The stored epoch is the same in both versions.
    - To keep the documented behaviour: `Time.at(reminder_at.to_i + 86_400, in: reminder_at.formatted_offset)`. Prep.
    - Otherwise, change the model comment and the test in `reminders_controller_test.rb:21`.
19. **Preparatory for rollout:** in `User#request_digest`, pass `reading_completion.to_s` (see rollout risk 1).

Not required now: the built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2. That showed up only as a warning from a real worker, not in tests. Moving to Sidekiq 7.3.3 or later is a separate job: Sidekiq 7's strict argument checking would reject `ExportJob`'s symbol-key hash, which already logs warnings today.

## B. New framework defaults, release by release

The app sets none of these explicitly, so all of them currently keep the 7.0 value. Fixes 20 to 22 below are needed to adopt them, and all three are prep.

**7.1**
- `raise_on_assign_to_attr_readonly`: the notebook settings form posts `slug`, which becomes a 500.
  - Fix 20: remove `:slug` from the permitted params. Forms already open in browsers still post it; it is just filtered out.
- `raise_on_invalid_cache_expiration_time`: `_export.html.erb` passes a negative `expires_in` for expired exports.
  - Fix 21: `expires_in: [export.expires_at - Time.current, 1.second].max`.
  - I tried `cache_if` first. It failed the test that requires a cached link to still be served after expiry.
- `message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true`: see rollout risk 2. Cookies are not affected.
- `default_column_serializer = nil`: `serialize :preferences` without a coder would raise. Fix 3 already covers this.
- `sanitizer_vendor` (Action View and Action Text) becomes HTML5: rich text is cleaned at render time, so no stored data changes. Tests pass.
- `cache_format_version = 7.1`: 7.0 cannot read the new cache format (from the upgrade guide, not tested). Production uses the default file cache. On rollback, clear `tmp/cache`.
- `belongs_to_required_validates_foreign_key = false`: no change observed.
- `marshalling_format_version`, `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances...`, `generate_secure_token_on`, encryption digest settings, `sqlite3_adapter_strict_strings_by_default`, `query_log_tags_format`: the app uses none of the features these affect.
- `add_autoload_paths_to_load_path`, `precompile_filter_parameters`, `dom_testing_default_html_version`, `log_file_size`, `debug_exception_log_level`, `default_headers` (drops `X-Download-Options`): no functional effect. Tests pass.

**Listed by the tool but now always on in 8.1**
- `allow_deprecated_singular_associations_name`: item 12.
- `commit_transaction_on_non_local_return`: item 17.
- `use_big_decimal_serializer`: rollout risk 1.
- `allow_deprecated_parameters_hash_equality`: I found no Parameters-to-Hash comparisons (source only).
- `to_time_preserves_timezone` (8.0): item 18.

**7.2**
- `postgresql_adapter_decode_dates`: `Notebook#daily_note_counts` gets Date objects, so `Date.iso8601(Date)` raises `TypeError`.
  - Fix 22: `Date.iso8601(day.to_s)`.
- `validate_migration_timestamps`: the existing timestamps (20261011…) are valid.
- `web_image_content_types` adds WebP: no effect, because image variants are not set up (no `image_processing`).
- `yjit`: watch memory use in production.
- `enqueue_after_transaction_commit`: removed as a global setting in 8.0. In 8.1 it is a per-job setting that defaults to false (from source), so the old behaviour stays.
  - Do not turn it on for `CitationEnrichmentJob` or `NoteReminderJob`. Both rely on "a failed enqueue rolls back the row change".

**8.0**
- `strict_freshness`: `ExportDownloadsController#stale?` would use only the ETag (the blob checksum) when the browser sends both headers. Expect slightly more 304s. Not tested with requests.
- `Regexp.timeout = 1`: the app's regexes (DOI format) are simple. Low risk.

**8.1** (missing from the tool's output)
- `escape_json_responses = false`: no JSON endpoints.
- `action_on_path_relative_redirect = :raise`: every redirect uses a path helper or an absolute URL.
- `raise_on_missing_required_finder_order_columns`: every model has a primary key.
- `escape_js_separators_in_json = false`: the YAML files embed values with ERB `.to_json`. Raw U+2028 in credentials is unverified.
- `render_tracker = :ruby`: fragment cache keys may change once.
- `remove_hidden_field_autocomplete`: HTML-only change.
- `yjit` becomes production-only.

## C. Rollout and rollback

1. **BigDecimal job arguments (confirmed with real workers).** A `DigestJob` enqueued by 8.1 fails on a 7.0 worker with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. It keeps retrying and never runs unless 8.1 workers come back.
   - Ship fix 19 (completion as a string) before the upgrade.
   - In the other direction, 8.1 workers processed 7.0-enqueued digest, retrying-enrichment and scheduled-reminder jobs correctly.
   - The extra `time_zone` key that 8.1 adds is ignored by 7.0.
   - Logs: `/tmp/upg/logs/mixed-worker70.log`, `mixed-worker81.log`.
2. **Rich-text attachment links written after adopting 7.1 defaults (confirmed).** Action Text stores a signed ID for each attachment in `action_text_rich_texts.body`. Once 7.1 defaults are on, newly saved IDs either crash on 7.0 (`NoMethodError` in `Messages::Metadata.decode`) or show up as missing attachments. This matrix shows what 7.0 sees when reading attachments saved by 8.1:

| Setting held back | What 7.0 sees |
|---|---|
| neither | crash |
| only `use_message_serializer_for_metadata = false` | attachment missing |
| only `message_serializer = :marshal` | attachment missing |
| both | attachment resolves |

   - 8.1 reads attachments written by 7.0 under every defaults level.
   - So adopt these two settings in a later deploy, after the rollback window. Logs: `/tmp/upg/logs/sgid-*.log`.
3. **Cookies and sessions:** an encrypted cookie written by either version was read correctly by the other, with 8.1 at defaults 7.0, 7.1 and 8.1 (`/tmp/upg/logs/cookie-matrix.log`). The probe used a raw encrypted cookie, not the session middleware itself.
4. **Suggested order:**
   1. Deploy the prep changes on 7.0 (items 1, 2, 4, 6, 8–19, plus fixes 20–22).
   2. Drain or let finish any queued `DigestJob`s.
   3. Deploy 8.1 with `load_defaults 7.0`, together with items 3, 5 and 7.
   4. Move up the defaults one release at a time, holding back the two message settings, and the cache format if rollback stays possible.
   5. Adopt the message settings last.

## D. Not verified
- Behaviour with the real production cache store and the real Active Storage service.
- `strict_freshness` with real HTTP requests.
- U+2028 in provider credentials.
- Whether 7.0 can read the 7.1 cache format (from the guide only).
- Whether a later 8.1.x removes the need for the json pin.
- Browser behaviour: there is no system suite and no browser was run.
- Whether readers should see the reminder offset or their own time zone (item 18) is a product decision.
- Copies, logs and the four `upg_*` test databases are kept in place so every result can be traced to its variant.

Files are in `/tmp/upg`:
- changes.txt
- full-81.diff
- prep70.diff
- probe_serialize.rb
- probe_cookie.rb
- probe_sgid.rb
- probe_id.rb
- probe_enqueue.rb
- probe_enqueue70.rb
- probe_serialized.rb
- logs/

---

**My notes:**
- This is a plan only. Nothing in your repository has changed; it's still on `main` with Rails 7.0.8.7 and a clean `git status`.
- Before anything is implemented, you need to decide item 18: should the reminder label show the original offset or the reader's own time zone?
- If you want to go ahead, I'd start by applying the prep changes in `/tmp/upg/prep70.diff` on a branch while still on 7.0. That way they can ship before the Rails bump.
- The planner left four test databases in place (`upg_base_test`, `upg_v81_test`, `upg_v81_dev`, `upg_prep70_test`), plus the copies in `/tmp/upg`. I can delete them once you're done with them.