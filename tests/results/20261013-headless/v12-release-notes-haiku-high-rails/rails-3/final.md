I upgraded the app to Rails 8.1.0. The change is uncommitted in the working tree. Lockfile resolution, Zeitwerk, the 46-test suite, and a production boot all pass. The editor and the system suite are not verified.

Per the upgrade-gem skill, the planner's plan comes first, verbatim. My commentary follows it.

---

# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

## Verdict

- Rails 8.1.0 does not boot this application unmodified. Four application-level boot failures and one dependency conflict appear before any test runs.
- Once the required repairs were applied in a disposable copy, the existing suite passes on 8.1.0 with `load_defaults 7.0`: 46 runs, 340 assertions, 0 failures. The same suite passes on 7.0.8.7 after the preparatory repairs.
- The index missed several removals, mostly because they have no code identifiers. The upgrade needs 18 required changes. Most can ship on 7.0 first.
- Four rollout hazards need ordering: BigDecimal job payloads, signed global IDs (`sgid`) under the 7.1 message serializer, the 7.1 fragment-cache format, and a keyword `serialize` spelling that silently breaks 7.0.
- Not verified: the Trix editor in a browser, and the system test suite (no Chrome in the sandbox).

## What was executed, and in what

- Index: `ruby /home/user/planner-run/maintain-rails/bin/gem-changes rails 7.0.8.7 8.1.0`, output at `/home/user/planner-run/out/gem-changes-rails.txt`. It read releases 7.0.10, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0.
- Upgrade guides for each minor: `/home/user/planner-run/exp/guides/upgrade-{7-1,7-2,8-0,8-1}-stable.md`.
- Defaults: `load_defaults` blocks read from the installed railties 8.1.0 source, `/home/user/planner-run/exp/bundle81/ruby/3.3.0/gems/railties-8.1.0/lib/rails/application/configuration.rb`.
- Isolation: a private PostgreSQL 15 cluster on port 5599 (`/home/user/planner-run/exp/pgdata`, socket directory `exp/pgsock`), a private Redis on port 6390, a separate database name per copy, Redis database indices 0 to 15, bundle path `exp/bundle81`. The shared PostgreSQL on 5432 and Redis on 6379 were not used. Both experiment services are stopped now.
- Copies: `base70` (untouched 7.0 baseline), `up81`/`up81c` (8.1 rebuild), `prep70`/`p70coder`/`p70fix`/`t70` (7.0 preparatory variants), `t81`, `ld71`, `ldfix` (defaults variants), `skq` (Sidekiq runtime), `skqres` (Sidekiq 7.3.3). Each run has a log under `/home/user/planner-run/exp/logs/`.
- Not run: the intermediate patch releases (7.1.6, 7.2.4, 8.0.5.1) were not installed separately. Their defaults come from the 8.1 railties source; their changes come from the index and the guides.

## Release-by-release defaults

The app loads `load_defaults 7.0`, so it keeps every 7.1, 7.2, 8.0 and 8.1 default below.

| Release | New default (value) | Effect on this app if adopted | Evidence |
|---|---|---|---|
| 7.1 | `raise_on_assign_to_attr_readonly = true` | Settings save raises on the unchanged slug (D3) | probe C, `ld71` |
| 7.1 | `default_column_serializer = nil` | Boot fails on `serialize :preferences` (D1) | `ld7.1-test.log` |
| 7.1 | `raise_on_invalid_cache_expiration_time = true` | Expired export fragment raises (D2) | probe A, `ld71` |
| 7.1 | `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | Action Text `sgid` unreadable by 7.0 (M2) | `sgid-matrix.log` |
| 7.1 | `cache_format_version = 7.1` | 7.0 cannot read entries (M3) | `cache-read-70.log` |
| 7.1 | `action_dispatch.default_headers` without `X-Download-Options` | Header is `nil` (was `noopen`); not asserted by tests | header probe (console) |
| 7.1 | sanitizer vendor HTML5 | No difference on a probe with `details`, `summary`, `figure`, `script`, `javascript:` href | `sanitize-up81c.log`, `sanitize-ld71.log` |
| 7.1 | `belongs_to_required_validates_foreign_key = false`, `dom_testing_default_html_version = :html5`, `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level = :error`, `marshalling_format_version = 7.1`, commit-callback ordering, `generate_secure_token_on`, encryption digest | Not observed; app has no commit callbacks or secure tokens | `ld71` suite (2 errors, both D2/D3) |
| 7.2 | `postgresql_adapter_decode_dates = true` | `daily_note_counts` raises (D4) | `ld7.2-fix-test.log` |
| 7.2 | `enqueue_after_transaction_commit = :default` | Not applicable on 8.1: the config is removed and the per-job default is `false`; 7.2 defaults do not set it on 8.1 | source: `activejob-8.1.0/lib/active_job/enqueuing.rb` |
| 7.2 | `active_storage.web_image_content_types` (adds webp), `validate_migration_timestamps`, `yjit` | Not exercised | none |
| 8.0 | `strict_freshness = true`, `Regexp.timeout ||= 1` | Not exercised | none |
| 8.1 | `action_on_path_relative_redirect = :raise`, `raise_on_missing_required_finder_order_columns = true`, `escape_json_responses = false`, `escape_js_separators_in_json = false`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete = true`, `yjit` env-dependent | Full 8.1 defaults suite passes; hidden-field autocomplete markup changes | `ldfix-test.log` |

Changes that happen on 8.1 regardless of defaults (no `load_defaults` involved): `to_time` always preserves the receiver's zone (F17); `show_exceptions = false` means `:all` (F9); BigDecimal arguments are always tagged (M1); `alias_attribute` on a non-attribute (F6); the Action Text sanitizer default is HTML4 with `allowed_tags` nil (F1).

## Required changes for 8.1.0

Repairs were applied in the copy and each one was removed on its own to test it (ablation). "Dual" means the repair also passes on 7.0. Logs are in `logs/abl-<name>.log`, summarized in `logs/ablation-summary.txt`.

**Boot-level (the application does not load)**

- **F1. Action Text allowed tags** (`config/initializers/action_text.rb:3`). Breaks: `NoMethodError: undefined method '+' for nil`. Repair: extend the effective list on `ActiveSupport.on_load(:action_view)`, keeping `allowed_tags || sanitizer.class.allowed_tags + [...]`. Dual: yes (7.0 variant). Validation: boot fails without it (`up81-db-prepare.log`); with it `zeitwerk:check` passes, and the probe keeps `<details>`/`<summary>` (`sanitize-up81c.log`). Control: note body rendering tests.
- **F2. Enum keyword syntax** (`app/models/note.rb:10`). Removed in 8.0: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Dual: yes. Validation: `up81-zeitwerk-after-boot-fix.log`. Control: the status filter test.
- **F3. Positional `serialize` coder** (`app/models/note.rb:12`). Removed in 7.2: `ArgumentError: wrong number of arguments (given 2, expected 1)`. Repair: `attribute :tags, :json` (dual). `serialize :tags, coder: JSON` works only on 8.1; on 7.0 it silently stores YAML (`coder-7.0-keyword.log`: dump `"---\n- a\n- b\n"`, load returns the raw string), so it must not ship before cutover. Validation: `tags-probe` identical dump/load on 7.0 and 8.1; full suites pass (`t81-test2.log`, `t70-test2.log`). Control: the notes tags round-trip test.
- **F4. json 3.x versus ActiveSupport 8.1.0.** Rails 8.1.0 pins `activesupport (= 8.1.0)`. Its `JSON.decode` calls `::JSON.parse(json, options)`, and `json 3.1.0` (selected by resolution) rejects that: `ArgumentError: wrong number of arguments (given 2, expected 1)`, raised from blob metadata on upload (`note_test.rb:20`, exports tests). Repair: `gem "json", "< 3"` (resolves to 2.21.2). 8.1.4 changes `decode`, but the requested version is 8.1.0. 8.1 only. Validation: `abl-json_gem_pin.log` (7 errors). Control: the export download test.
- **F5. Multi-path route** (`config/routes.rb:18`). Removed in 8.1: `bin/rails routes` exits 1 with `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Without boot, `notes_path` is undefined, sign-in redirects fail (`NameError` in `SessionsController`, 500). Repair: `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index"`. Dual: yes. Validation: `logs/abl-multi-path-routes.log`, `abl-multi_path_route.log` (17 errors). Control: the "both list paths" test.

**Runtime-level (boot succeeds, behavior breaks)**

- **F6. `alias_attribute :highlight_color, :color`** (`note.rb:14`). `color` is a `store_accessor`. Error is raised on first attribute use, not at boot: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`. Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` (the 7.2 guide's recommended manual alias). Dual: yes. Validation: `abl-alias_attribute_store-targeted.log` (15 errors; `zeitwerk:check` passes, so it is not a boot check). Control: the highlight radio test.
- **F7. `Rails.application.secrets`** (`app/models/citation/provider.rb:13`, citation tests). Removed in 7.2: `NoMethodError: undefined method 'secrets' for an instance of MarginNotes::Application`. Repair: `Rails.application.config_for(:secrets).citation_provider.to_h`; tests point the provider at the loopback server through `ENV["CITATION_PROVIDER_URL"]`, which is read per call. Dual: yes. Validation: `abl-secrets_removed*.log`. Control: the environment-credentials child-process test.
- **F8. `retry_on ... wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`). Removed in 7.2: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. The job raises instead of retrying, so the test expecting six provider requests fails. Repair: `wait: ->(executions) { (executions**4) + 2 }`, which passes on both 7.0 and 8.1 (`skqres-citation-lambda-81.log`). The lambda omits the default 15% jitter. Alternative `:polynomially_longer` keeps jitter but is 8.x only. Validation: `abl-exponentially_longer_removed.log`. Control: the "fails at once on 404" path.
- **F9. `show_exceptions = false`** (`config/environments/test.rb:31`). On 8.1, `false` falls through to `:all`, so tests see rendered errors instead of raised exceptions: `ActiveRecord::RecordNotFound expected but nothing was raised`. Repair: `:none` (the guide says `:none` replaces `false`). Not dual: on 7.0, `:none` is truthy. Test environment only. Validation: `abl-show_exceptions_false.log` (3 failures). Control: production stays on the default `:all`.
- **F10. `form_with(model: nil, ...)`** (`app/views/notes/index.html.erb:12`). Removed in 8.0: `ActionView::Template::Error: Passed nil to the :model argument`, making `/notes` a 500 and breaking sign-in. Repair: drop `model: nil`. Dual: yes. Validation: `abl-form_with_model_nil.log` (6 errors). Control: the "unbound search form" test.
- **F11. `fragments.sum` on strings** (`app/models/export.rb:42`). The ActiveSupport override was removed in 7.1: `TypeError: String can't be coerced into Integer`, so `ExportJob` fails and the export stays "working". The 7.0 baseline already prints `DEPRECATION WARNING: Rails 7.0 has deprecated Enumerable.sum` (`base70-test.log`). Repair: `fragments.join`. Dual: yes. Validation: `abl-enumerable_sum.log` (3 errors). Control: the export contents assertion.
- **F12. `NoteReminderJob.set(wait_until: <Integer>)`** (`app/models/note.rb:61`). Numeric `scheduled_at` removed in 7.2: `NoMethodError: undefined method 'utc' for an instance of Integer`, so reminders return 500. Repair: `wait_until: Time.at(reminder_epoch)`. Dual: yes. Validation: `abl-wait_until_integer.log` (2 errors). Control: the exact-time assertion `1_793_451_617` still passes.
- **F13. Import batch commits partially** (`app/models/import.rb`, `apply`). `return` inside `transaction` now commits (the 7.2 rollback behavior is gone). Observed record counts: expected `[0, 3, 0, 1]`, actual `[1, 4, 1, 2]`, so a rejected batch leaves an import and notes. Repair: `applied = rows.all? { |row| row.note.save }` followed by `raise ActiveRecord::Rollback unless applied`. Dual: yes (7.0 test passes). Validation: `abl-import_rollback_return.log` (1 failure). Control: the successful-import test.
- **F14. Receipt DOI** (`app/models/import.rb:67`). `citation[:id]` returned the custom primary key on 7.x, but 7.2 removed that: the DOI column is blank. Repair: `citation.doi`. Dual: yes. Validation: `abl-receipt_read_attribute_id.log`. Control: the receipt CSV test's title assertions.
- **F15. Preview annotations** (`app/views/imports/preview.html.erb:22`). `stringify_keys` in 8.0 turns integer line keys into strings, so `annotations[row.line]` misses silently: the test found the DOI `dd` instead of the annotation. Repair: remove `.stringify_keys`. Dual: yes. Validation: `abl-annotations_stringify_keys.log` (2 failures). Control: the DOI rendering.
- **F16. Notebook filter by table name** (`app/controllers/notes_controller.rb`). On 8.1, `where(notebooks: @notebook)` fails: `PG::UndefinedColumn: column notes.notebooks does not exist`. Repair: `where(notebook: @notebook)`. Dual: yes. Validation: `abl-notebook_filter_table_key.log`. The release that changed this is not identified in the index.
- **F17. Reminder preview** (`app/models/note.rb`, `next_day_reminder_at`). 8.1's `to_time` always keeps the receiver's zone. The unrepaired preview is `2026-11-01T08:00:00-05:00` on 8.1 versus `2026-11-01T09:00:00-04:00` on 7.0 (`to-time-unrepaired-81.log`). Repair (recommended, keeps the documented offset behavior): `(reminder_at.to_time + 86_400).getlocal(reminder_at.utc_offset)`, which gives the 7.0 result (dual). Alternative `reminder_at + 86_400` matches what the postponed reminder displays and removes the DST caveat in `ARCHITECTURE.md`; it changes page text and needs a product decision. Validation: `abl-to_time_offset.log` (1 failure). Control: the postponed reminder's epoch.
- **F18. Digest day** (`app/mailers/digest_mailer.rb`). Since 8.1, the request time keeps the reader's zone when deserialized, so the subject and listing window use the reader's day: expected "October 05, 2026", actual "October 04, 2026". This contradicts the UTC-day contract. Repair: `requested_at = requested_at.utc` in the mailer (dual). Validation: `abl-digest_utc.log`. Control: the per-UTC-day reservation test.

## Preparatory changes that work on 7.0 (ship first)

Each was verified in a 7.0 copy and the full 7.0 suite passes. Results: `logs/p70fix-test-final.log` (49 runs, 334 assertions, 0 failures) and `logs/t70-test2.log`.

- Tags as `attribute :tags, :json` (F3).
- Action Text extension (F1), `enum ... prefix:` (F2), `alias_method` (F6), `config_for(:secrets)` and ENV-based test (F7), two-route `/notes` (F5), `form_with url:` (F10), `join` (F11), `Time.at` (F12), explicit rollback (F13), `citation.doi` (F14), no `stringify_keys` (F15), `where(notebook:)` (F16), `getlocal` (F17), `requested_at.utc` (F18).
- Citation backoff lambda (F8).
- Digest completion sent as a fixed-point string, `reading_completion.to_s("F")`: payload is `["0.6667","0.0"]` on both 7.0 and 8.1 (`payload-string-70.log`, `payload-string-81.log`). This removes the mixed-version payload problem (M1).
- Export options with string keys, `ExportJob.perform_async(export.id, { "format" => "markdown" })`. The current code already prints `Job arguments to ExportJob do not serialize to JSON safely` (`skq-seed.log`). Needed before Sidekiq 7.
- Digest reservation: `added = Sidekiq.redis { |r| r.sadd(key, id) }; if added == true || added == 1`. Needed before Sidekiq 7 (G2).
- Defaults prerequisites for 7.1 and 7.2 (probes pass on 7.0 and 8.1): `serialize :preferences, coder: YAML` (D1; the YAML dump is identical on 7.0), `[export.expires_at - Time.current, 0].max` in the export partial (D2), `permit(:name, :export_heading)` without `:slug` (D3), `Date.iso8601(day.to_s)` (D4).

## Optional default adoption (after the bump, one at a time)

- **D1.** `load_defaults 7.1` requires an explicit coder for `preferences` (`ArgumentError: missing keyword: :coder`). Prerequisite above.
- **D2.** `raise_on_invalid_cache_expiration_time`: `Cache expiration time is invalid, cannot be negative: -60.0` on the exports page. Prerequisite above.
- **D3.** `raise_on_assign_to_attr_readonly`: `ActiveRecord::ReadonlyAttributeError: slug` on any settings save. Prerequisite above.
- **D4.** `postgresql_adapter_decode_dates`: `TypeError: no implicit conversion of Date into String` in `daily_note_counts`. Prerequisite above.
- **D5.** `message_serializer` and `cache_format_version` (7.1): deferred until no 7.0 process can read the data (M2, M3).
- **D6.** Not exercised: `strict_freshness`, `Regexp.timeout`, `yjit`, `web_image_content_types`, sanitizer vendor HTML5 beyond the probe, the `X-Download-Options` removal (IE only).
- Full 8.1 defaults (`ldfix`, with every repair) pass: `logs/ldfix-test.log`, 46 runs, 340 assertions, 0 failures.

## Mixed-version rollout and rollback

- **M1. BigDecimal payloads.** An 8.1 `DigestJob` payload tags the BigDecimal: `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. A 7.0 Sidekiq worker fails with `ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` and moves the job to Sidekiq's retry set (`rollback-worker-70.log`). Fix: ship the string-completion change on 7.0 first, then drain or delete any tagged jobs before rollback.
- **M2. `sgid` (Action Text attachments).** An `sgid` written under 8.1 defaults (message serializer JSON) fails on 7.0 with `NoMethodError: undefined method 'unpack1' for nil` during Action Text reads. An `sgid` written with `load_defaults 7.0` is readable by 7.0 and 8.1, and 7.0 `sgid`s are readable by 8.1 (`sgid-matrix.log`). Rule: don't adopt the 7.1 message-serializer default until no 7.0 process serves. Rollback after adoption requires rewriting affected attachments.
- **M3. Fragment-cache format.** Under 8.1 with cache format 7.1, 7.0 raises `TypeError: incompatible marshal file format (can't be read) ... format version 4.8 required; 17.2 given` (`cache-read-70.log`). The reverse direction works. The guide's advice (keep the old format on the first deploy) is confirmed.
- **M4. Keyword `serialize` on 7.0.** Silently writes YAML into the JSON column. Covered by F3.
- **M5. Session cookies.** Accepted in both directions when the secret is shared (both return 200, signed in; `cookie2-read81-of70.log`, `cookie2-read70-of81.log`). Not a blocker. Note: the 7.2 guide renames the dev/test secret file (`tmp/development_secret.txt` to `tmp/local_secret.txt`). Production uses `SECRET_KEY_BASE`.
- **M6. Stored data.** Preferences (YAML), tags (JSON text), jsonb highlight, reminder epoch, DOI, export and daily counts were written by 7.0 and read by 8.1 with `load_defaults 7.0` and 8.1 defaults. 8.1 writes tags as the same JSON text, and 7.0 reads them back (`xdata-seed70.log`, `xdata-read81d70.log`, `xdata-read81dfix.log`, `xdata-read70.log`).
- **M7. Queued work.** `ExportJob` (native Sidekiq) is unaffected by Active Job changes. A 7.0-enqueued `NoteReminderJob` processed by 8.1 was not tested.

## Dependencies and gem notes

- **G1. Gem resolution.** 14 Rails components move 7.0.8.7 to 8.1.0. `net-imap` 0.6.7 to 0.6.8. Added: `action_text-trix` 2.1.19, `json` 2.21.2 (pinned), `bigdecimal` 4.1.3, `rack-session`, `rackup`, `webrick`, `useragent`, `drb`, `securerandom`, `uri`. Removed: `method_source` 1.1.0. Lock diff: `/home/user/planner-run/exp/up81c/Gemfile.lock` vs `base70/Gemfile.lock`.
- **G2. Sidekiq 6.5.12.** Runs on 8.1: a real worker processed `ExportJob` (export completed with a file), `NoteReminderJob` (`reminder_sent_at` set), and `DigestJob` (`skq-sidekiq-worker.log`, `skq-check.log`). Rails 8.1 prints `The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2 ... upgrade sidekiq to version 7.3.3 or later`. Required before 8.2, not for 8.1.0. Sidekiq 7.3.3 resolves with Rails 8.1.0 and Rack 2.2.24. Under Sidekiq 7 the first full run failed `ExportJob` (symbol keys) and accepted a duplicate digest (`Integer` returned from `sadd`). With the two preparatory repairs, the full suite passes: `skqres-test3.log`, 49 runs, 349 assertions, 0 failures. Sidekiq 7's worker was not run; only the suite.
- **G3. Trix and Action Text.** Action Text 8.1 depends on `action_text-trix` 2.1.19, which supplies `trix.css` (required by `app/assets/stylesheets/actiontext.css`) and a Trix 2 script that the page does not load. The layout still loads the vendored Trix 1.3.5 classic script (`app/views/layouts/application.html.erb`). The layout comment about Action Text 7.0.8.7 bundling Trix 1.3.4 is stale. Asset compilation and the production precompile succeed (`prod81-server2.log`). Editor behavior is not verified.
- **G4. Production boot.** On 8.1 defaults after `assets:precompile`, `/session/new` returns 200 and `/notes` redirects to sign-in. Without precompiled assets the page returns 500 (asset pipeline configuration, not a code change).

## Documentation to update with the cutover

- `ARCHITECTURE.md`: the runtime and Rails version statement (around line 188); the Active Job time-zone paragraph (lines 169 to 175), which becomes true only with F18; the DST preview paragraph (lines 153 to 156), which depends on F17; the Trix and Action Text paragraph (lines 207 to 210); the Sidekiq 6.5 statement (lines 201 to 206); the BigDecimal completion statement (lines 166 to 168); the `secrets.yml` reference (lines 78 to 80).
- `config/initializers/action_text.rb` and `app/views/layouts/application.html.erb`: the Trix comments.
- `TESTING.md` lines 54 to 55: the Minitest comment about Rails 7.0's test runner.

## Not verified or open

- Browser behavior of the editor, Turbo and Stimulus (no Chrome).
- `bin/rails test:system`: not run.
- Whether Trix 1.3.5 or Trix 2 should be the editor on 8.1.
- The DST choice in F17.
- The upstream release that changed `where(table: record)` (F16).
- Rails Minitest 6 compatibility (the Gemfile comment): not evaluated.
- Lambda backoff jitter difference (F8).
- Intermediate patch releases were not installed separately.
- Index misses (no textual match): multi-path route (F5), enum keyword (F2), positional `serialize` (F3), `read_attribute(:id)` (F14), `Enumerable#sum` (F11), numeric `scheduled_at` (F12), built-in Sidekiq adapter deprecation (G2). The index's `DIGEST_RESERVATIONS_KEPT_FOR = 2.days` match and `Hash#merge` match are false positives.
- Two Redis index mistakes (indices above 15) in some of my runs produced spurious digest errors. The results cited above were rerun on valid indices; they are listed in the log names.

## Suggested sequence

1. On 7.0, ship the preparatory changes (string completion, tags attribute, string-keyed export arguments, Sidekiq-compatible digest reservation, defaults prerequisites, and the F1 to F18 repairs that are marked dual). Verify the full 7.0 suite. Drain or delete any tagged jobs.
2. Cut over to `rails 8.1.0`, `json < 3`, the `show_exceptions = :none` test change, and any remaining 8.1-only edits, with `load_defaults 7.0`. Run the suite, `zeitwerk:check`, a production boot with precompile, and the probes. This step is reversible to 7.0 because the formats stay at 7.0 defaults.
3. Adopt the defaults one at a time, each in its own deploy. Hold the message serializer and cache format until no 7.0 instance remains. Before adopting 7.2, apply the decode-date prerequisite.
4. Plan Sidekiq 7.3.3 before Rails 8.2.

---

## What I did

The upgrade-gem skill is plan-only, but you asked for the upgrade itself, so I went on to implement it. The changes are uncommitted in the working tree.

**Dependencies**
- `Gemfile`: `rails` is now `8.1.0`, and `json < 3` is pinned with a comment.
- `Gemfile.lock` was resolved with `bundle update rails --conservative`. It locks `rails` and `activesupport` at 8.1.0 and `json` at 2.21.2.

**Repairs** (the planner's verified set, all in the repo)
- `note.rb`: `enum :status, ..., prefix: true`; `attribute :tags, :json` in place of the positional `serialize`; `alias_method` for `highlight_color` and its setter; `getlocal` in `next_day_reminder_at`; `Time.at` for the scheduled reminder.
- `import.rb`: explicit `ActiveRecord::Rollback` on a failed batch; `citation.doi` in the receipt.
- `export.rb`: `fragments.join`.
- `digest_mailer.rb`: `requested_at.utc`, with the comment updated.
- `citation/provider.rb`, `citation_enrichment_job.rb`, `config/initializers/action_text.rb`, `config/routes.rb`, `config/environments/test.rb`, `notes_controller.rb`, `imports/preview.html.erb`, `notes/index.html.erb`.
- `citation_enrichments_controller_test.rb`: the provider URL goes through `ENV`, because `config_for` cannot be stubbed.

**Where I chose between the planner's options**
- Tags use `attribute :tags, :json`, not `serialize :tags, coder: JSON`. The keyword form silently writes YAML on 7.0, and the attribute form works on both.
- The citation retry is a lambda with the old backoff curve and no jitter. The planner's `:polynomially_longer` copy would have been 8.x-only.
- The reminder preview keeps the 7.0 offset behavior (`getlocal`), which matches the documented behavior.
- I did not apply the Sidekiq 7 preparation, the defaults prerequisites, or the string-completion change. None of them is needed for 8.1.0 with `load_defaults 7.0` on Sidekiq 6.5.
- `load_defaults` stays at 7.0. Nothing was adopted.

**Docs updated**: README, ARCHITECTURE, TESTING, `docs/references/fizzy.md`, `docs/guides/controllers.md`, the layout comment, the `secrets.yml` header, and the Gemfile comment.

## Verification

- `bundle check` passes. `bin/rails zeitwerk:check` passes.
- `bin/rails test`: 46 runs, 340 assertions, 0 failures. That matches the planner's verified run.
- A production boot (`RAILS_ENV=production bin/rails runner`) reports Rails 8.1.0.
- Tests ran against the repo's configured `margin_notes_test` database on the shared PostgreSQL, which `TESTING.md` treats as disposable. I did not use the planner's private cluster.

## Needs your decision or a check

- **Editor not verified.** Action Text 8.1 is installed, but the layout still loads the vendored Trix 1.3.5 script. I could not check the editor in a browser, and `bin/rails test:system` needs Chrome, which this sandbox doesn't have. Please run the note editor by hand before merging. The question of Trix 1.3.5 versus Trix 2 is still open.
- **Rolling deploy.** Under 8.1, the digest's BigDecimal completion is serialized as a tagged payload that a 7.0 worker can't deserialize. Deploy web and workers together, drain the queue, or ship the planner's string-completion change first.
- **Sidekiq.** Rails 8.1 warns that its built-in Sidekiq adapter is deprecated. Sidekiq 7.3.3 or later is needed before Rails 8.2.
- The 7.1+ defaults, and the message-serializer and cache-format hazards, don't apply while `load_defaults` stays at 7.0.

Nothing is committed. Let me know if you'd like a commit, or if you want the Trix editor checked next.