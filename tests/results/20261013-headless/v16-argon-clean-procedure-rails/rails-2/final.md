# Rails upgrade plan for Margin Notes: 7.0.8.7 to 8.1.0

The upgrade is feasible, but it can't be a version bump alone. As soon as Rails is bumped, the app fails to boot. Once boot was fixed, 12 tests failed and 34 errored. After that came four silent behaviour changes, including one that saves partial data from failed CSV imports.

After the 20 repairs listed below, all 46 tests pass on 8.1.0 with the current `load_defaults 7.0`, and also with `load_defaults 8.1` (340 assertions). I tested the repairs in the throwaway workspace only. The working checkout was not changed: `cleanup` dropped the temporary databases and Redis numbers and reported "git status: clean".

**Versions.** In the upgraded `Gemfile.lock`:
- All Rails gems move to 8.1.0. `json` 3.1.0, `rack-session` 1.0.2, `rackup` 1.0.1, `action_text-trix` 2.1.19, `useragent`, `securerandom`, `uri`, `bigdecimal` 4.1.3, `drb` and `webrick` are added. `method_source` is removed. `net-imap` moves 0.6.7 to 0.6.8.
- **Rack stays at 2.2.24**, because `sidekiq 6.5.12` limits it to `rack < 3`. The Rack 3 items in the `gem-changes` report therefore don't apply. The app also has no custom middleware.

**How to read the "Before the bump?" column.** "Yes" means I ran the repair on the 7.0.8.7 copy and the full suite still passed (46 runs, 325 assertions, 0 failures). That run included every repair marked Yes; the four marked "No" failed it.

## 1. Required changes for the upgrade

| # | Affected code | What breaks on 8.1.0 if nothing is done | Version | Recommended repair | Before the bump? |
|---|---|---|---|---|---|
| R1 | `Gemfile` (new `json` dependency) | Every request that reads the session cookie fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`, raised from `json-3.1.0/lib/json/common.rb:291 parse`, which is called by `activesupport-8.1.0/.../json/decoding.rb:25`. Signing in and every signed-in page break. | 8.1 (`activesupport` now depends on `json` without a version limit) | Add `gem "json", "~> 2.7"` (resolves to 2.7.2). | Yes (7.0 already uses json 2.7.2) |
| R2 | `config/initializers/action_text.rb:3` | The app doesn't boot: `NoMethodError: undefined method '+' for nil`. In 8.x `allowed_tags` starts as `nil` and the default list is worked out when content is rendered. | 7.1 | Replace the line with the block shown after this table. | Yes |
| R3 | `app/models/note.rb:10` `enum status: {...}, _prefix: true` | The class doesn't load: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. | Deprecated 7.2, removed 8.0 | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes |
| R4 | `app/models/note.rb:12` `serialize :tags, JSON` | Passing the coder as the second argument was removed in 7.2. | Removed 7.2 | `serialize :tags, coder: JSON`. The stored value stays `["b","a"]` on both versions (probe). | **No.** On 7.0 `coder:` is ignored and `tags` comes back as a String (`undefined method 'any?' for an instance of String`). Ship it with the bump. |
| R5 | `app/models/note.rb:14` `alias_attribute :highlight_color, :color` (`color` is a `store_accessor` field, not a column) | `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` | Deprecated 7.1, removed 7.2 | `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=` | Yes. Probe: `highlight="green"`, and the radio button stays checked in `notes_controller_test` lines 114 and 160. |
| R6 | `config/routes.rb:18` `get "/notes", "/journal", to: "notes#index"` | Routes fail to load: `ArgumentError: Wrong number of arguments (expect 1, got 2)`, so every request fails. | Removed 8.1 | Two lines: `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"` | Yes. `journal_path=/journal` and `notes_path=/notes` on both versions. |
| R7 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122` | `Rails.application.secrets` was removed. On the upgraded copy the probe printed `NoMethodError: undefined method 'secrets' for an instance of MarginNotes::Application`. Every `CitationEnrichmentJob` would fail, and Active Job would retry it until it gave up. | Deprecated 7.1, removed 7.2 | Move the settings to `config/citation_provider.yml` (same ERB `.to_json` values, keyed by environment, without the `citation_provider:` level). Add `config.x.citation_provider = config_for(:citation_provider)` in `config/application.rb`. Change the default argument to `Rails.configuration.x.citation_provider.to_h`. Make the same replacement in the test. | Yes. Same `{url, user, password}` on both. The test that passes `"00123"` / `"sample: value # keep"` through a fresh `bin/rails runner` boot passes. |
| R8 | `app/jobs/citation_enrichment_job.rb:7` `wait: :exponentially_longer` | The symbol was removed in 8.0. | Deprecated 7.1, removed 8.0 | `wait: :polynomially_longer` (same back-off formula) | **No.** On 7.0 the "three job attempts" test fails with `Expected: 6, Actual: 2`. Ship with the bump. |
| R9 | `config/environments/test.rb:31` `show_exceptions = false` | Under 8.1, 33 tests failed. Most redirected to `/session/new` instead of reaching the page. | Deprecated 7.1 | `config.action_dispatch.show_exceptions = :none` | **No.** On 7.0 the new value is ignored and exceptions are rendered as error pages, so tests expecting `RecordNotFound` to be raised fail. Ship with the bump. |
| R10 | `app/views/notes/index.html.erb:12` `form_with(model: nil, ...)` | The notes list fails to render: `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. | 8.x | `form_with(url: notes_path, method: :get, class: "search", html: { role: "search" })` | Yes |
| R11 | `app/controllers/notes_controller.rb:12` `@notes.where(notebooks: @notebook)` | Filtering by notebook fails: `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`. | 8.x | `@notes = @notes.where(notebook: @notebook)` | Yes |
| R12 | `app/models/note.rb:61` `NoteReminderJob.set(wait_until: reminder_epoch)` (an Integer) | Scheduling a reminder fails: `NoMethodError: undefined method 'utc' for an instance of Integer`. | 7.1 (`scheduled_at` is now a Time) | `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))` | Yes. Probe on 7.0: `scheduled_at=1793520000.0`. Sidekiq scheduled the job `at=2030-01-01 00:00:00 UTC` on both versions. |
| R13 | `app/models/import.rb:53-59` `return false unless row.note.save` inside `transaction` | **Silent data corruption.** `return` inside a transaction now commits. A CSV with one bad row saves the Import and the valid rows before it. Test: `record_counts` changed from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. Probe: a note saved before `return` was kept (`kept=1` on 8.1, `kept=0` on 7.0). | Changed back to commit in 7.1, the old rollback removed in 7.2 | See the code after this table. | Yes. Invalid CSV gives `false`, `delta=[0, 0]`. Valid two-row CSV gives `true`, `delta=[1, 2]` (control). |
| R14 | `app/models/import.rb:68` `citation && citation[:id]` | The CSV receipt loses its DOIs. Before: `On idleness,10.1000/Essays.1`. After: `On idleness,`. Probe: `citation[:id]=nil` while `citation.id="10.1000/Zz.1"`. | 7.1 (`:id` no longer maps to a custom primary key) | `csv << [ note.title, citation&.doi ]` | Yes. Receipt is `Good A,10.1000/Zz.1` / `Good B,` on both. |
| R15 | `app/models/export.rb:42` `fragments.sum` | Every Markdown export fails: `TypeError: String can't be coerced into Integer`. 7.0 already printed a deprecation warning for this. | Rails' string `sum` removed 7.1 | `finish(fragments.join)` | Yes |
| R16 | `app/views/imports/preview.html.erb:22` `@import.annotations.stringify_keys` | **Silent.** Annotations disappear from the import preview. In 7.0 `stringify_keys` on this hash kept the integer line keys; in 8.1 it converts them to strings, so `annotations[row.line]` misses. Probe: `stringify[2]=nil`, `plain[2]="x"`. Test: expected `"Read <b>twice</b> & reflect"`, got the DOI cell. | 7.1 | `<% annotations = @import.annotations %>` | Yes |
| R17 | `app/mailers/digest_mailer.rb:7-9` | **Silent.** Active Job now keeps the time zone of a `TimeWithZone` argument, so the digest covers the reader's local day instead of the UTC day the app promises. Eastern reader at 03:30 UTC: subject was `October 05, 2026`, now `October 04, 2026`. | 7.1 | After `params.values_at`, add `requested_at = requested_at.in_time_zone(Time.zone)` | Yes. Repaired date is `2026-10-05` on both. |
| R18 | `app/models/note.rb:44` `reminder_at.to_time + 86_400` | **Silent.** The "remind me a day later" time drifts across a daylight-saving change. Reminder 2026-10-31 09:00 −04:00: 7.0 gives `2026-11-01T09:00:00-04:00`, 8.1 gives `2026-11-01T08:00:00-05:00`. `to_time` now always keeps the zone; the `to_time_preserves_timezone` setting is gone (`nil` on 8.1, `true` on 7.0). | Deprecated 7.1/8.0, removed 8.1 | `reminder_at.to_time.localtime(reminder_at.utc_offset) + 86_400` | Yes. DST case gives `2026-11-01T09:00:00-04:00` on both. Control on 2026-10-20 gives `2026-10-21T09:00:00-04:00` on both. |
| R19 | `app/models/notebook.rb:7` `serialize :preferences` | No change while `load_defaults 7.0` stays (YAML remains the default). Under the 7.1 default it fails to load: `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'.` | 7.1 default | `serialize :preferences, coder: YAML`. The stored text stays `"---\nexport_heading: Heads\n"`, and a NULL column still gives `nil`. | **No** (same reason as R4). Ship with the bump. |
| R20 | `app/models/notebook.rb:40` `Note.connection.select_rows(...)` plus `Date.iso8601(day)` | No change under 7.0 defaults. Under the 7.2 default `postgresql_adapter_decode_dates`, the activity report fails: `TypeError: no implicit conversion of Date into String`. `.connection` is also soft-deprecated from 7.2. | 7.2 default | `Note.connection_pool.with_connection { \|connection\| connection.select_rows(days) }.map { \|day, count\| [Date.iso8601(day.to_s), count] }` | Yes. Result `[[2026-10-14, n]]` on both. |

Code for R2 (`config/initializers/action_text.rb`):

```ruby
Rails.application.config.after_initialize do
  ActiveSupport.on_load(:action_view) do
    ActionText::ContentHelper.allowed_tags =
      ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a +
      [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
  end
end
```

The test "rich text keeps collapsible excerpts and drops unsafe markup" passes on 7.0, on 8.1, and on 8.1 with `load_defaults 8.1` (the HTML5 sanitizer).

Code for R13 (`app/models/import.rb`, `apply`):

```ruby
applied = false
transaction do
  save!
  raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
  applied = true
end
applied
```

`ActiveRecord::Rollback` is the only option that rolls back and still lets `apply` return `false`. Raising any other error would escape to the controller.

**Validation for R1–R20.** For each repair I ran the same check twice on the upgraded copy, once without the repair (fails) and once with it (passes). For R1–R3, R5–R12 and R14–R18 the check is the existing test that failed. For R13 it is the `imports_controller_test` "saves nothing" assertion plus the probe. For R19 and R20 it is the run with `--defaults 8.1`. As controls I used the valid-input, no-DST and creation paths noted in the table.

Tests worth adding, because nothing asserts these today:
- **R13:** CSV with a valid row "Good row" and an untitled row. Assert `Import.count` and `Note.count` don't change and `apply == false`.
- **R18:** Reader in "Eastern Time (US & Canada)" with a reminder at 2026-10-31 13:00 UTC. Assert `next_day_reminder_at.iso8601 == "2026-11-01T09:00:00-04:00"`.
- **R14:** Already covered by the existing receipt assertion.

Checked with no change needed:
- The 8.1 Sidekiq Active Job adapter still works with sidekiq 6.5.12. Probe: `wrapped=NoteReminderJob`, correct `at`.
- `has_secure_password` and `store_accessor`.
- Cookie and cache formats while `load_defaults 7.0` stays (Section 3).
- The only routes removed are the Action Mailbox conductor edit/update/destroy routes, which the app doesn't use.
- `db/schema.rb`: 8.1 sorts columns alphabetically, writes `Schema[8.1]` and `enable_extension "pg_catalog.plpgsql"`. The table definitions are the same.
- No deprecation warnings were recorded in any diagnostic run.
- Not caused by Rails, but still logged: Sidekiq's "Job arguments to ExportJob do not serialize to JSON safely" (symbol key in `Notebook#request_export`).

## 2. New configuration defaults (the app keeps `load_defaults 7.0`; nothing in `config/` overrides these)

I ran the full suite with `--defaults 8.1` (all repairs applied): 46 runs, 340 assertions, 0 failures.

**7.1**
- **`active_record.default_column_serializer = nil`**: breaks `Notebook` (R19). Configure: R19.
- **`active_record.raise_on_assign_to_attr_readonly = true`**: saving notebook settings raises `ActiveRecord::ReadonlyAttributeError: slug` at `app/controllers/notebooks_controller.rb:26`, because the form resubmits a hidden `slug`. Today the assignment is silently ignored.
  - Repair: at line 40, `params.require(:notebook).permit(:name, :export_heading)`.
  - Works on 7.0. Creation still gives `"second-book"`, because `assign_slug` overrides it.
  - Validation: `notebooks_controller_test.rb:22` (`PATCH` with `slug: "renamed"`; slug stays `"novels"`) fails without the repair and passes with it.
- **`active_support.raise_on_invalid_cache_expiration_time = true`**: the exports page fails at `app/views/exports/_export.html.erb:26` with `Cache expiration time is invalid, cannot be negative: -60.0` once an export has expired.
  - This matters even under the old defaults: on 8.1 a negative `expires_in` is now dropped and the entry is stored **without expiry** (probe: `neg write ok read="v"`; 7.0 gave `nil`), and the error is reported.
  - Repair: `expires_in: [export.expires_at - Time.current, 0].max`. Works on 7.0.
  - Control: positive TTL read `"v"`, zero TTL read `nil`. The test "cached availability indicator does not authorize a download" passes on both.
- **`active_support.cache_format_version = 7.1`**: entries written in the new format can't be read by 7.0. Probe: `TypeError: incompatible marshal file format (can't be read) format version 4.8 required; 17.2 given`. Rollback risk; see Section 3.
- **`active_support.message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true`**: cookies written this way were readable by 7.0 in the probe (encrypted session and signed cookie). Safe.
- **`action_text.sanitizer_vendor` / `action_view.sanitizer_vendor` (HTML5)**: covered by R2. Rich-text test passes.
- **`active_record.run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`**: the app defines no commit callbacks; only Active Storage does. The export tests pass.
- **`active_record.generate_secure_token_on = :initialize`**: no `has_secure_token` in the app.
- **`active_record.encryption.hash_digest_class` / SHA1 support**: no `encrypts` in the app.
- **`active_record.marshalling_format_version = 7.1`**: the app caches only HTML fragments, not records.
- **`belongs_to_required_validates_foreign_key = false`**: fewer queries only.
- **`query_log_tags_format`**: query log tags are not enabled.
- **`sqlite3_adapter_strict_strings_by_default`**: the app uses PostgreSQL.
- **`add_autoload_paths_to_load_path = false`**: no `require` of `app/` files.
- **`precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level`, `dom_testing_default_html_version`**: no app impact; tests pass.
- **`action_dispatch.default_headers`**: drops `X-Download-Options`.
- 7.1 also changes the local secret file to `tmp/local_secret.txt`. That changes development and test session secrets only.

**7.2**
- **`active_record.postgresql_adapter_decode_dates = true`**: breaks the activity report. Configure: R20.
- **`active_record.validate_migration_timestamps = true`**: all migrations are dated on or before today. No impact.
- **`active_storage.web_image_content_types`** (adds webp): the app has no variant processor; no impact.
- **`yjit = true`**: performance only.

**8.0**
- **`action_dispatch.strict_freshness = true`**: probe of `ExportDownloadsController#show` with a matching ETag and an old `If-Modified-Since` returned 304 on 7.0, 8.1, and 8.1 with the 8.1 defaults. No change. The 200 control downloaded 37 bytes.
- **`Regexp.timeout = 1`**: CSV input is capped at 100 KB. Not stress-tested.

**8.1**
- **`yjit = !Rails.env.local?`**: performance only.
- **`action_controller.action_on_path_relative_redirect = :raise`**: every redirect in the app uses a path helper or the absolute `/notes`. No impact.
- **`action_controller.escape_json_responses = false`, `active_support.escape_js_separators_in_json = false`**: no `render json:` and no Jbuilder views.
- **`active_record.raise_on_missing_required_finder_order_columns = true`**: every model has a primary key (`Citation` uses `doi`). No impact.
- **`action_view.render_tracker = :ruby`**: cache digests may change once, so fragment caches miss once.
- **`action_view.remove_hidden_field_autocomplete = true`**: the hidden `import[csv]` and `notebook[slug]` fields lose `autocomplete="off"`. Tests pass.

None of these settings is deprecated later in the range, except that `to_time_preserves_timezone` and `cache_format_version 7.0` are on their way out.

**Recommendation:** bump to 8.1.0 while keeping `load_defaults 7.0`. Then move up one step at a time (7.1, then 7.2, …) using `new_framework_defaults` files. Turn on `cache_format_version = 7.1` only after rolling back to 7.0 is no longer an option.

## 3. Rollout, rollback, and running both versions at once

- **Database rows and `db/schema.rb`:** no migration is needed. Stored values are byte-identical on both versions: `tags` is `["b","a"]`, `settings` is `{"color": "green"}`, `preferences` is the same YAML. Commit the re-sorted `schema.rb` together with the bump.
- **Redis fragment cache and session/signed cookies:** while `load_defaults 7.0` stays, the probe showed full cross-compatibility both ways (7.0 ↔ 8.1). With `cache_format_version 7.1`, a 7.0 process gets a `TypeError` on cache entries written by 8.1. Production has no `cache_store` set, so it uses the per-host file store under `tmp/cache`; clear it on rollback. Cookies written with the 8.1 defaults stayed readable by 7.0.
- **Queued Active Job payloads:**
  - An 8.1 `DigestJob` serializes the completion with `ActiveJob::Serializers::BigDecimalSerializer`. A 7.0 worker raises `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. This happens during rollout (new web, old workers) and on rollback.
    - Preparatory repair: in `app/models/user.rb:41`, pass `reading_completion.to_s`. 7.0 already writes `"0.3333"`, and the mailer calls `BigDecimal(params[:completion])`.
    - Unverified: I did not run this repair. It is a conclusion from the probe payloads.
  - 8.1 also adds `"time_zone"` to `TimeWithZone` arguments. 7.0 ignores it and uses UTC, which matches R17. A 7.0 payload deserialized on 8.1 gives UTC and `"0.3333"`; both are handled.
  - `NoteReminderJob` payloads from 8.1 add `scheduled_at`. 7.0 ignores it, and Sidekiq's `at` is the same on both.
  - Native `ExportJob` is not affected.
  - Deploy workers and web together, or drain the `default` queue first.
- **What to deploy on 7.0.8.7 first:** R1, R2, R3, R5, R6, R7, R10–R18 and R20, plus the Section 2 repairs for the `slug` parameter and cache TTL, plus `.to_s` for the digest. R13, R16, R17 and R18 fix silent data problems, so put them first.
- **What must ship with the bump:** R4, R8, R9 and R19.

## 4. Verification log and open questions

**Executed in `upgrade-workspace`:**
- `gem-changes rails 7.0.8.7 8.1.0`. The cached 7.0.10, 7.1.6, … gem files were unreadable ("not an octal string"), and the report printed no framework-defaults section. I took the defaults list from `railties-8.1.0/lib/rails/application/configuration.rb`.
- `setup` gave: upgraded boot FAILED (R2), test runner exit 1. Baseline: 46 runs, 325 assertions, 0 failures, 67 routes.
- Repeated `test` runs on the upgraded copy (with each repair applied in turn), then `test --defaults 8.1`, then `test --target baseline` with the shippable-early repairs (46 runs / 325 assertions / 0 failures). An attempt with R4, R8, R9 and R19 included failed, as recorded in the table.
- `reset`, then the scripted repairs `/tmp/fixes/apply.sh`.
- Probes:
  - `/tmp/fixes/probe2.rb`: stored data, job payloads, transaction behaviour, receipt, DST, HashWithIndifferentAccess, cache TTL, slug, secrets, routes.
  - `/tmp/fixes/probe3.rb` and `/tmp/fixes/probe4.rb`: cross-version cookies and cache, with and without `--defaults 8.1`.
  - `/tmp/fixes/probe5.rb`: `strict_freshness`.
  - A Sidekiq adapter probe.
  - A `SchemaDumper` diff.
- `cleanup` reported "git status: clean".
- Logs: `/tmp/upgrade-rails-8.1.0/logs/{bundle-update,diag-*,schema-load-*,tests-*}.log` were deleted by `cleanup`. A copy taken just before is at `/tmp/fixes/logs-copy/`.

**Conclusions from reading code only (not run):**
- Rack 3 items don't apply while sidekiq 6.5 keeps Rack at 2.x. Upgrading Sidekiq to 7 or later would bring in Rack 3; that is a separate task.
- The R2 ordering under the HTML5 sanitizer: the test covered it, but not in production eager-load mode.
- Removal of the conductor routes.

**Proposed, not yet run:**
- The `reading_completion.to_s` repair against a real 7.0 Sidekiq worker.
- A browser system test (`bin/rails test:system`) on 8.1 for Trix/`action_text-trix` 2.1.19 asset loading with Sprockets and importmap.
- Production-mode boot with `RAILS_LOG_TO_STDOUT`, since `Rails.logger` is now a `BroadcastLogger`.

**Open questions:**
1. Is `json` 3.1.0 incompatibility specific to this gem mirror? The pin is needed either way until `activesupport` supports it.
2. Should the digest move to the reader's local day (the 8.1 behaviour) instead of UTC? R17 keeps the documented UTC behaviour.
3. Is a rollback window needed? That decides how long to stay on `cache_format_version 7.0`.

---

**Notes:**
- I've only made a plan so far; nothing in your repo has changed. The upgrade skill plans the work but doesn't carry it out. The planner tested every repair in a throwaway copy.
- **Silent problems:** R13 saves partial data when a CSV import fails, R16 drops annotations from the import preview, R17 shifts the digest date, and R18 moves reminders by an hour across daylight saving. None of these causes a crash, so they're the main reason not to just bump the version.
- Four repairs (R4, R8, R9, R19) only work on 8.1, so they have to go in with the version bump itself. The rest can be deployed on 7.0 first.
- **Your decisions:** the open questions in Section 4, especially whether the digest should stay on the UTC day and how long you need to be able to roll back to 7.0.

If you'd like, I can implement this plan in a branch, either as one change or as the "deploy on 7.0 first" step followed by the bump.