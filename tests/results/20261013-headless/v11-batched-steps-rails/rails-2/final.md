# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

Rails 8.1.0 will not boot in this app as it stands. Once I fixed the boot errors, 25 of the 46 tests still failed. With the 18 repairs below plus a test-config change, all 46 tests pass on 8.1.0, and the repairs that also work on 7.0 pass there too. Several of the problems are silent data or behaviour changes that the current tests only partly catch.

Two things I did not test: the system (browser) tests, and Rails 7.2 and 8.0 on their own. I did run 7.0.8.7, 7.1.6 and 8.1.0.

One process slip: while checking network access I ran `gem fetch` with the repo as the working directory, which dropped `rails-8.1.0.gem` into the repo root. I deleted it straight away and `git status` is clean. Nothing else in the working application was changed.

## How I tested

- **Index:** the change summary is at `/tmp/up/changes.txt`. It has no 8.1 framework-defaults section, so I read those from railties 8.1.0 directly.
- **Copies:** separate copies of the app under `/tmp/up/`:
  - `v70`: untouched baseline.
  - `v71`: Rails 7.1.6.
  - `v81`: Rails 8.1.0, repaired one error at a time.
  - `v70fix`: the repairs applied on 7.0.8.7, to show they work on the current version.
  - `v81fix`: 8.1.0 with all repairs.
  - `v81def`: like `v81fix` but with `load_defaults 8.1`.
- **Isolation:** each copy had its own gem directory (`/tmp/up/bundle`), its own PostgreSQL databases (`up_<copy>_*` on a private server at port 55432), Redis on port 56379, and file storage under `tmp/localstorage`. The PostgreSQL and Redis servers are stopped now.
- **Dependencies:** on 8.1.0, bundler kept sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, minitest 5.27, pagy 8.6.3, turbo-rails 2.0.12 and concurrent-ruby 1.3.4. It also added json 3.1.0, which breaks the app (finding R1).
- **Scripts:** `/tmp/up/scripts/repairs.sh` applies the repairs, `probe.rb` exercises the affected code, and `runtests.sh` runs the suite.
- **The probe:** runs against Sidekiq and Redis rather than the test adapter. It checks models, enqueued job payloads and HTTP requests, and loads job payloads queued by one Rails version into the other.
- **Logs:** `/tmp/up/logs/`. Test runs are `test*_<copy>.log`, probe runs are `probe_<copy>_*.log`, and the full code diff is `diff_app_v70_v81fix.patch`.

Final results: `v81fix` 46 tests, 0 failures (`test_v81fix_3.log`). `v70fix` 46 tests, 0 failures (`test_v70fix_3.log`). `v81def` 46 tests, 0 failures after the D-repairs (`test_v81def_3.log`).

## Required changes: without these, 8.1.0 breaks or behaves differently

"Executed" means I saw the error or behaviour in a run. "Also works on 7.0" means it passed the suite in `v70fix`, so it can be shipped before the upgrade.

**R1. Pin `json`** (executed). Rails 8.1 newly depends on the `json` gem, and bundler picked json 3.1.0. Rails' JSON decoder passes options in a form json 3.x no longer accepts. Every read of `notes.tags` (stored with `serialize :tags, JSON`) fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291`. That error turned 13 requests into 500s.
- Repair: add `gem "json", "< 3"` (it resolved to 2.21.2) until a Rails release supports json 3.
- Check: `Note.find(id).tags` returns `["a","b"]`. Control: the raw column still holds `["a","b"]`.

**R2. Action Text initializer** at `config/initializers/action_text.rb` (executed). It fails to boot on 7.1 and later with `NoMethodError: undefined method '+' for nil`. Since 7.1, `ContentHelper.allowed_tags` starts as nil and the defaults are computed when content is rendered.
- Repair: my version is `/tmp/up/scripts/action_text_initializer.rb`. Inside `config.after_initialize` plus `ActiveSupport.on_load(:action_view)`, it sets the list to the existing value (or the sanitizer's defaults plus `action-text-attachment`, `figure` and `figcaption`) plus `details` and `summary`. Also works on 7.0.
- Do not set `allowed_tags = %w[details summary]` on its own: that would remove every default tag.
- Check: the existing test "rich text keeps collapsible excerpts and drops unsafe markup" passes, and `<details>` survives rendering. Control: `<script>` is still removed and attachments still render.

**R3. Note enum** at `app/models/note.rb:10` (executed). Boot fails with `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Also works on 7.0, and the stored integers are unchanged.

**R4. Note tags column** (executed). Deprecated in 7.1 and gone in 7.2.
- Repair: `serialize :tags, coder: JSON`. Make this change in the same commit as the Rails bump. On 7.0 the `coder:` keyword is not supported, so do not ship it early (I did not check what 7.0 does with it).
- The stored JSON format is unchanged, so rollback is safe.

**R5. `alias_attribute :highlight_color, :color`** (executed). From 7.2, creating a note fails with `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`.
- Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Also works on 7.0.
- Check: PATCH `/notes/:id` with `highlight_color=blue`, then `Note#highlight_color == "blue"` and `settings["color"] == "blue"`. Control: the color validation error is still reported on `:color`.

**R6. Two paths in one route** at `config/routes.rb:18` (executed). On 8.1, `get "/notes", "/journal", to:` fails with `ArgumentError: Wrong number of arguments (expect 1, got 2)`.
- Repair: two `get` lines. `bin/rails routes` gives the same names (`notes`, `journal`) on 7.0 and 8.1.

**R7. `Rails.application.secrets` is removed in 7.2** (executed). `Citation::Provider.new` fails with `NoMethodError: undefined method 'secrets'`, so every citation lookup fails.
- Repair: move the same ERB/ENV content from `config/secrets.yml` to `config/citation_provider.yml`, with top-level environment keys. Add `config.x.citation_provider = config_for(:citation_provider)`, default `Provider` to `Rails.configuration.x.citation_provider.to_h`, and update `with_provider` in `test/controllers/citation_enrichments_controller_test.rb`.
- Also works on 7.0, and deployment needs no change because it reads the same environment variables.
- Not recommended: encrypted credentials. They would need values moved into the encrypted file and would no longer read these environment variables.
- Check: the citation-enrichment tests, including "provider credentials from the environment reach the server unchanged".

**R8. `fragments.sum`** at `app/models/export.rb:42` (executed). It fails from 7.1 with `TypeError: String can't be coerced into Integer`, so every export job fails.
- Repair: `fragments.join`. Also works on 7.0.
- Check: the Markdown output is byte-identical (`"# Heading\n\n## N1\n\nHello\n"` on both versions).

**R9. `retry_on wait: :exponentially_longer`** (executed). From 7.2 the retry fails with `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. This is raised inside the retry handling, so the citation is never marked failed when the provider stays unavailable.
- Repair: `wait: ->(executions) { executions**4 + 2 }`, the 7.0 formula without the random jitter. Works on 7.0 and 8.1, including for retries already queued during the deploy.
- Alternative: `:polynomially_longer` only exists from 7.1, so it cannot go in as a preparatory change.

**R10. Import "apply" commits a partial import** at `app/models/import.rb` (executed; a silent data change). On 8.1, `return false` inside `transaction` commits instead of rolling back. Test result: `record_counts` expected `[0, 3, 0, 1]`, got `[1, 4, 1, 2]`, meaning the import, the earlier valid notes and the citation were all saved.
- Repair: `transaction { save!; raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }; true } || false`. Also works on 7.0.
- Check: probe `import_invalid_apply` gives `[false, [0, 0]]`. Control: the valid-CSV test imports 2 notes and 1 citation.

**R11. `@notes.where(notebooks: @notebook)`** at `notes_controller.rb` (deprecation seen on 7.1). It uses the plural name for a singular association, which is removed in 7.2.
- Repair: `where(notebook: @notebook)`. Also works on 7.0.

**R12. `form_with(model: nil, ...)`** at `notes/index.html.erb:12` (executed). On 8.1, the notes list and sign-in landing fail with `ActionView::Template::Error: Passed nil to the :model argument`.
- Repair: remove `model: nil`. The field names are unchanged.

**R13. Import preview hides annotations** at `imports/preview.html.erb` (executed; silent). From 7.1, `HashWithIndifferentAccess#stringify_keys` turns the integer keys into strings, so `annotations[row.line]` finds nothing and the Annotation fields disappear (`Actual: "10.1000/Essays.1"`).
- Repair: use `@import.annotations` without `.stringify_keys`. Also works on 7.0.

**R14. Import receipt CSV** at `Import#receipt` (deprecation seen on 7.1). It uses `citation[:id]`, which is deprecated in 7.1. Use `citation&.doi`.
- On 8.1 the probe shows the correct DOI with the repair; I did not capture the unrepaired 8.1 output.
- Check: the receipt is `title,doi\nT,10.1234/abc` on both versions.

**R15. Reminder scheduled with a raw number** at `Note#schedule_reminder` (executed). `set(wait_until: reminder_epoch)` passes an Integer; 7.1 deprecates this ("Assigning a numeric/epoch value to scheduled_at is deprecated") and on 8.1 the reminder request returns 500.
- Repair: `wait_until: Time.at(reminder_epoch)`. Also works on 7.0.
- Check: the Sidekiq scheduled time equals the epoch (probe `schedule_reminder`) and the reminder email is sent once.

**R16. Digest date moves to the reader's time zone** at `DigestMailer` (executed; silent). From 7.1, Active Job keeps the time zone of a TimeWithZone argument. The mailer's `to_date` and `all_day` then use the reader's zone instead of the worker's UTC day, contradicting the "today (UTC)" contract. Test result: `"Your reading digest for October 05, 2026"` became `"October 04, 2026"`.
- Repair: `requested_at = requested_at.in_time_zone` in the mailer. Also works on 7.0, and handles payloads queued by either version (shown by the cross-version probe).

**R17. BigDecimal job argument breaks mixed-version workers** (executed). On 8.1 the digest's completion value is queued in a new BigDecimal format. A 7.0 worker cannot read it: `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- Repair: pass `reading_completion.to_s` from `User#request_digest`. The mailer already calls `BigDecimal(...)` on it. Also works on 7.0.
- Ship this before the Rails bump so 7.0 and 8.1 can both read queued digest jobs in either direction (verified).

**R18. Next-day reminder display after a DST change** at `Note#next_day_reminder_at` (executed; display only). On 8.1, `to_time` always keeps the zone, so the next-day reminder is shown with the new offset instead of the documented "keeps the reminder's UTC offset". The test expected `2026-11-01T09:00:00-04:00`.
- Repair: `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. Also works on 7.0.
- The epoch is unchanged (difference 86400), so postponing a reminder behaves the same.

**Test configuration (test only).** From 7.2, `show_exceptions = false` no longer means "raise", so errors render 500 pages and the `assert_raises` checks fail. Set `config.action_dispatch.show_exceptions = :none` in `config/environments/test.rb`; it is accepted from 7.1.

## New framework defaults (all optional; the app stays on `load_defaults 7.0`)

The app keeps the old value of every setting below. I tested the full set together with `load_defaults 8.1` in `v81def`; the D-repairs below then pass on 8.1, and the three applied to `v70fix` also pass on 7.0.

### 7.1 defaults

- **`default_column_serializer = nil`** (executed): boot fails with `missing keyword: :coder` because of `serialize :preferences` in `notebook.rb`.
  - D1: `serialize :preferences, coder: YAML`. The stored YAML is unchanged.
- **`raise_on_assign_to_attr_readonly = true`** (executed): notebook settings PATCH returns 500 `ActiveRecord::ReadonlyAttributeError: slug`, because the form resubmits `slug`.
  - D2: remove `:slug` from `notebook_params`. Also works on 7.0.
- **`raise_on_invalid_cache_expiration_time = true`** (executed): an expired export makes the exports page fail with `Cache expiration time is invalid, cannot be negative: -60.0` (`_export.html.erb:26`).
  - D3: `expires_in: [export.expires_at - Time.current, 1.second].max`. Also works on 7.0.
- **`commit_transaction_on_non_local_return`:** the app already depends on this through R10, which removes the dependency.
- **Encrypted-message format** (`message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata`; source-based): affects signed and encrypted cookies and the session. Rolling back to 7.0 after enabling it would make new-format cookies unreadable, signing users out. Enable only after the rollback window has passed.
- **`marshalling_format_version = 7.1`:** only matters for cached Active Record objects. The app caches only view fragments, so low impact.
- **`action_view` / `action_text` `sanitizer_vendor` to HTML5** (source-based): existing rich text is re-sanitized with the HTML5 parser at render time. Re-check `<details>`, attachments and unsafe markup before adopting.
- **`belongs_to_required_validates_foreign_key = false`:** fewer queries when saving.
- **`run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`:** no app commit callbacks; no impact found.
- **`allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`:** the second is resolved by R11.
- **`use_big_decimal_serializer`:** resolved by R17.
- **`sqlite3_adapter_strict_strings_by_default`:** PostgreSQL app, no impact.
- **`query_log_tags_format`, `log_file_size`, `precompile_filter_parameters`, `debug_exception_log_level`, `dom_testing_default_html_version`:** no change found for this app.
- **Active Record encryption settings and `generate_secure_token_on`:** not used.

### 7.2 defaults

- **`postgresql_adapter_decode_dates = true`** (executed): the activity report returns 500 with `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`.
  - D4: `Date.iso8601(day.to_s)`. Also works on 7.0.
- **`enqueue_after_transaction_commit`:** has no effect on 8.1, where it is a per-job setting defaulting to false. If it is ever turned on for these jobs, `Citation#request_enrichment` and `Note#schedule_reminder` lose the "a failed enqueue rolls back" guarantee.
- **`web_image_content_types` adds webp:** affects only how images attached to rich text are displayed.
- **`validate_migration_timestamps`:** the existing migration timestamps are valid.
- **`yjit`:** a memory question for deployment only.

### 8.0 defaults

- **`to_time_preserves_timezone = :zone`:** 8.1 behaves this way regardless; handled by R18.
- **`strict_freshness = true`** (source-based; the probe did not distinguish the two settings): applies to `ExportDownloadsController#stale?`. When a client sends a matching ETag with an older If-Modified-Since, it now gets 304 instead of 200. Export files never change, so this is harmless.

### 8.1 defaults (read from railties source; the summary omits them)

- **`escape_json_responses = false`, `escape_js_separators_in_json = false`:** the app has no JSON views.
- **`action_on_path_relative_redirect = :raise`:** all `redirect_to` calls use path helpers.
- **`raise_on_missing_required_finder_order_columns`:** applies to `.first` or `.last` without an order. I saw none in the app code; I did not search exhaustively.
- **`render_tracker = :ruby`, `remove_hidden_field_autocomplete`, `yjit` outside development and test:** nothing in this app found to be affected.

## Rollout, mixed versions and rollback

1. **On 7.0 first** (each repair passed the full suite in `v70fix`): R2, R3, R5 to R18 (except R4), D2, D3, D4. Shipping R17 and R9 first is what makes mixed-version job queues safe.
2. **Upgrade in steps:** 7.1, then 7.2, 8.0, 8.1. Treat the deprecation list I saw on 7.1 (`test2_v71.log`) as a checklist, and do R1, R4 and the test-config change at their steps.
3. **Queued work:**
   - CitationEnrichmentJob, NoteReminderJob and DigestJob payloads (with R17) loaded on both versions in both directions.
   - 8.1 adds `scheduled_at` and `time_zone` keys to payloads, which 7.0 ignores.
   - The native Sidekiq `ExportJob` is unaffected.
   - Still to check: a scheduled reminder queued by 7.0 and actually run end to end on 8.1 at its due time. I only checked that its arguments load.
4. **Stored data:** the tags JSON, preferences YAML, enum integers and rich-text HTML formats are unchanged, so rolling back is safe as long as the 7.1 message, cache and sanitizer defaults are not adopted.
5. **Schema dump:** the 8.1 `schema.rb` header changes (`Schema[8.1]`, `pg_catalog.plpgsql`) and columns are reordered. This is cosmetic, but a schema dumped by 8.1 should not be committed until rollback is no longer possible.

## Unverified and open questions

- System (browser) tests were not run on any version.
- 7.2 and 8.0 were not run on their own; each step should get a test run and a deprecation sweep.
- No production-like boot (`eager_load`, `assets:precompile`) on 8.1; and `bin/rails zeitwerk:check` was not run.
- Sidekiq 6.5.12 with the Active Job adapter shipped in Rails 8.1 enqueued and ran jobs correctly here. Sidekiq 7 or later and Ruby 3.4 (which will need the `csv` gem added) are separate upgrades.
- The 7.1 password-length (72-byte) validation and the HTML5 sanitizer output on existing rich text were reviewed from source only.
- I did not check whether `alias_method` resets the `highlight_color` form value after a validation error.

---

This is a plan only, as the upgrade skill requires. I haven't upgraded Rails or changed any app files. I checked `git status` myself and the repo is clean, so the stray gem file the planner mentions really is gone. If you want me to go ahead, I'd start with step 1 of the rollout: the repairs that also work on 7.0, shipped before the version bump.