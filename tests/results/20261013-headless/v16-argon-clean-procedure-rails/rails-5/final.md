# Upgrade plan for Margin Notes: rails 7.0.8.7 to 8.1.0

The bump is feasible. On 8.1.0 the app doesn't boot until the first fix below is made. With all of the repairs below applied in the disposable workspace, the suite passed on 8.1.0 under `load_defaults` 7.0, 7.1, 7.2, 8.0 and 8.1 (46 runs, 340 assertions, 0 failures). Most repairs also passed on 7.0.8.7 (46 runs, 325 assertions, 0 failures), so they can ship before the bump. The working checkout was not modified; `cleanup` reported `git status: clean`.

Resolved versions (upgraded `Gemfile.lock`):
- rails/railties and all components 8.1.0.
- New gems: `action_text-trix` 2.1.19, `bigdecimal` 4.1.3, `drb` 2.2.3, `rack-session` 1.0.2, `rackup` 1.0.1, `securerandom` 0.4.1, `uri` 1.1.2, `useragent` 0.16.11, `webrick` 1.9.2.
- `method_source` removed; `net-imap` 0.6.7 to 0.6.8.
- `json` 3.1.0 unless pinned (finding 1.2).
- `rack` stays at 2.2.24, `puma` at 5.6.9, `sidekiq` at 6.5.12.

## 1. Required changes for the upgrade

Each finding gives affected code, what breaks, applicability, the repair, and validation. "Ships early" means the repair also passed on 7.0.8.7.

**1.1 Action Text initializer stops the app booting**
- **Affected code:** `config/initializers/action_text.rb:3` (`ActionText::ContentHelper.allowed_tags += ...`).
- **What breaks:** boot fails with `NoMethodError: undefined method '+' for nil`. Since 7.1, `allowed_tags` has no default value.
- **Applicability:** immediately on the bump. Ships early.
- **Repair:**
  ```ruby
  Rails.application.config.after_initialize do
    ActiveSupport.on_load(:action_view) do
      ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags +
        [ ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary" ]
    end
  end
  ```
- **Validation:** boot fails without it and succeeds with it. Control: the test `rich text keeps collapsible excerpts and drops unsafe markup` passes on both versions (`<details>` kept, unsafe markup dropped).

**1.2 json 3.1.0 makes every session cookie read fail**
- **Affected code:** `Gemfile`. Bundler resolves `json` 3.1.0 as a new dependency.
- **What breaks:** reading any encrypted cookie raises `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291` (called from `ActiveSupport::JSON.decode`). Every signed-in request returns 500.
- **Applicability:** on the bump.
- **Repair:** add `gem "json", "~> 2.7"`. It resolved to 2.7.2 on both versions.
- **Validation:** an integration probe (sign in, then `GET /notebooks`) returned that error without the pin and 200 with it.

**1.3 `Rails.application.secrets` is removed (7.2)**
- **Affected code:**
  - `app/models/citation/provider.rb:13`
  - `config/secrets.yml`
  - `test/controllers/citation_enrichments_controller_test.rb:45,117-122`
  - The references in `ARCHITECTURE.md:79-80` and `CONTRIBUTING.md:38`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Every citation lookup fails.
- **Applicability:** on the bump. Ships early.
- **Repair:**
  - Rename the file to `config/citation_provider.yml`, keeping the ERB values, with `development: &local_citation_provider` / `test: <<: *local_citation_provider` / `production:` sections that contain the url, user and password keys directly.
  - In `config/application.rb`, add `config.x.citation_provider = config_for(:citation_provider)`.
  - In the provider, default to `Rails.configuration.x.citation_provider.to_h`.
  - Update the test to use `Rails.configuration.x.citation_provider`.
- **Validation:** the 4 citation tests error without the change and pass with it on both versions. They cover the credentials reaching the server, a retry after 503, and the 401 and 404 failures.

**1.4 Old `enum` syntax is removed (8.0)**
- **Affected code:** `app/models/note.rb:10`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2)` when the class loads.
- **Applicability:** on the bump. Ships early.
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Validation:** `Note.statuses` is unchanged, and the `status_ready` filter tests pass on both versions.

**1.5 `serialize` with a positional coder is removed (7.2)**
- **Affected code:** `app/models/note.rb:12`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Applicability:** must ship with the bump. Rails 7.0 silently ignores `coder:`, so `coder: JSON` would fall back to YAML there.
- **Repair:** `serialize :tags, coder: JSON`
- **Validation:** a probe saved `tag_list: "b, a"` and read the raw column as `["b","a"]` on both versions. Stored data is identical.

**1.6 `alias_attribute` to a store accessor raises (7.2)**
- **Affected code:** `app/models/note.rb:14`.
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.`
- **Applicability:** on the bump. Ships early.
- **Repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Validation:** `update!(highlight_color: "pink")` then reload gives `["pink","pink",{"color"=>"pink"}]` on both versions. The edit test passes.

**1.7 One route with two paths is rejected (8.1)**
- **Affected code:** `config/routes.rb:18`.
- **What breaks:** route drawing fails with `ArgumentError: Wrong number of arguments (expect 1, got 2)`. No routes load.
- **Applicability:** on the bump. Ships early.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index", as: :notes
  get "/journal", to: "notes#index", as: :journal
  ```
- **Validation:** the route probe printed `["notes","/notes(.:format)"]` and `["journal","/journal(.:format)"]` on both versions.

**1.8 Non-local `return` inside a transaction now commits (7.1)**
- **Affected code:** `app/models/import.rb:50-61` (`Import#apply`).
- **What breaks:** an import with an invalid row now keeps the import and the rows saved before it. The test record counts changed from `[0,3,0,1]` to `[1,4,1,2]`.
- **Applicability:** silent data corruption on the bump. Ships early.
- **Repair:**
  ```ruby
  transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end || false
  ```
- **Validation:** the invalid-row test (rows "Adam Bede" valid, then a blank title with `not-a-doi`) leaves counts unchanged. Control: the valid two-row import creates 2 notes, 1 citation and 1 import.

**1.9 `HashWithIndifferentAccess#stringify_keys` now converts Integer keys (7.1)**
- **Affected code:** `app/views/imports/preview.html.erb:22`.
- **What breaks:** annotations disappear from the preview. The test expected `"Read <b>twice</b> & reflect"` and found only the DOI `"10.1000/Essays.1"`.
- **Applicability:** on the bump. Ships early.
- **Repair:** `annotations = @import.annotations`
- **Validation:** `#line_2 dd` and `#line_4 dd` show their annotations on both versions.

**1.10 `record[:id]` no longer returns a non-`id` primary key**
- **Affected code:** `app/models/import.rb:68` (`citation[:id]`, where the primary key is `doi`).
- **What breaks:** the receipt CSV becomes `On idleness,` instead of `On idleness,10.1000/Essays.1`.
- **Applicability:** on the bump. Ships early.
- **Repair:** `csv << [ note.title, citation&.doi ]`
- **Validation:** the receipt equals `"title,doi\nOn idleness,10.1000/Essays.1\nOf experience,10.1000/Essays.1\n"` on both versions.

**1.11 `Enumerable#sum` on strings is removed (7.1)**
- **Affected code:** `app/models/export.rb:42`.
- **What breaks:** `TypeError: String can't be coerced into Integer`. Every export job fails.
- **Applicability:** on the bump. Ships early.
- **Repair:** `finish(fragments.join)`
- **Validation:** the export and download tests pass on both versions.

**1.12 `form_with(model: nil)` raises (8.x)**
- **Affected code:** `app/views/notes/index.html.erb:12`.
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. The note list returns 500, including the page shown right after sign-in.
- **Applicability:** on the bump. Ships early.
- **Repair:** `model: false`
- **Validation:** `form[role=search][action="/notes"][method=get]` is present on both versions.

**1.13 `where(notebooks: record)` is no longer treated as the association**
- **Affected code:** `app/controllers/notes_controller.rb:12`.
- **What breaks:** `PG::UndefinedColumn: column notes.notebooks does not exist` when filtering by notebook.
- **Applicability:** on the bump. Ships early.
- **Repair:** `@notes.where(notebook: @notebook)`
- **Validation:** the filter-by-notebook and pagination tests pass on both versions.

**1.14 `set(wait_until:)` with an Integer raises**
- **Affected code:** `app/models/note.rb:61`.
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. No reminder can be scheduled.
- **Applicability:** on the bump. Ships early.
- **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`
- **Validation:** the reminder tests pass. A real Sidekiq enqueue on both versions landed in the ScheduledSet about 3600 s ahead.

**1.15 `retry_on wait: :exponentially_longer` is removed (7.2)**
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer` when a lookup hits 503.
- **Applicability:** on the bump. The replacement does not exist on 7.0, so it must ship with the bump.
- **Repair:** `wait: :polynomially_longer` (same delay formula).
- **Validation:** the "provider stays unavailable" test now records the failure instead of raising.

**1.16 `show_exceptions = false` is no longer honoured in tests**
- **Affected code:** `config/environments/test.rb:31`.
- **What breaks:** 6 tests that expect `ActiveRecord::RecordNotFound` report "nothing was raised", because the error is rescued and rendered instead.
- **Applicability:** must ship with the bump; `:none` is truthy on 7.0.
- **Repair:** `config.action_dispatch.show_exceptions = :none`
- **Validation:** the cross-reader access tests raise again.

**1.17 Active Job keeps the time zone of time arguments (7.1)**
- **Affected code:** `app/mailers/digest_mailer.rb:7-9`, with arguments sent from `User#request_digest` (`app/models/user.rb:41`).
- **What breaks:** the digest covers the reader's local day instead of the UTC day. The test subject changed from "October 05, 2026" to "October 04, 2026", and the `updated_at` range shifts too.
- **Applicability:** on the bump. Ships early.
- **Repair:** add `requested_at = requested_at.in_time_zone(Time.zone)` after line 7.
- **Validation:** the digest test passes on both versions. A probe with a reader in Tokyo and `2026-10-04 20:30 UTC` showed 7.0 deserializing to `UTC` and 8.1 to `JST +09:00` without the repair.

**1.18 `to_time` behaviour changes (8.0 default; legacy setting removed in 8.1)**
- **Affected code:** `app/models/note.rb:44` (`next_day_reminder_at`).
- **What breaks:** the displayed postponed time loses the reminder's fixed offset after a DST change. The test expected `2026-11-01T09:00:00-04:00`; that element was not found.
- **Applicability:** on the bump. Ships early.
- **Repair:** `(reminder_at + 86_400).getlocal(reminder_at.utc_offset)`
- **Validation:** for New York, reminder at `2026-10-31 13:00 UTC`, both versions give `2026-11-01T09:00:00-04:00`, and `to_i` minus the epoch is 86400.

**1.19 Notes that need no code change before the bump**
- **Sidekiq adapter:** Rails 8.1 logs "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2". Enqueueing still works with sidekiq 6.5.12. Plan a move to sidekiq 7.3.3 or later before Rails 8.2.
- **Rack 3:** `gem-changes` flagged Rack 3 items, but the bundle kept rack 2.2.24 and `Rails::Server` still uses `Rack::Handler::Puma`. They don't apply until rack and puma move.
- **Routes:** the only route difference is that the Action Mailbox conductor edit, update and destroy routes are gone. The app doesn't use them.

## 2. New configuration defaults across intermediate releases

The app sets `config.load_defaults 7.0` and keeps every old value unless noted. These findings were seen with `test --defaults`. All need finding 2.1 first, because without it the app won't load under any of these defaults.

**2.1 `active_record.default_column_serializer = nil` (7.1)**
- **Affected code:** `app/models/notebook.rb:7` (`serialize :preferences`).
- **What breaks:** loading the class raises `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to 'serialize'`.
- **Applicability:** when adopting defaults 7.1 or later. Ship it with the bump: 7.0 accepts `coder:` only by ignoring it.
- **Repair:** `serialize :preferences, coder: YAML`. Stored values stay YAML: the raw value was `"---\nexport_heading: Café Notes\n"` on both versions.
- **Validation:** all tests pass under `--defaults 7.1` through `8.1`.

**2.2 `active_record.raise_on_assign_to_attr_readonly = true` (7.1)**
- **Affected code:** `app/controllers/notebooks_controller.rb:40` permits `:slug`; `app/models/notebook.rb:8` has `attr_readonly :slug`.
- **What breaks:** updating a notebook raises `ActiveRecord::ReadonlyAttributeError: slug`, because the edit form posts a hidden `slug` field.
- **Applicability:** when adopting defaults 7.1 or later. Ships early.
- **Repair:** `permit(:name, :export_heading)`
- **Validation:** the test "settings update the name and export heading but keep the slug" passes. Control: create still assigns the slug from the name.

**2.3 `active_support.raise_on_invalid_cache_expiration_time = true` (7.1)**
- **Affected code:** `app/views/exports/_export.html.erb:26`.
- **What breaks:** once an export has expired, the exports page raises `Cache expiration time is invalid, cannot be negative: -60.0`.
- **Applicability:** when adopting defaults 7.1 or later. Ships early.
- **Repair:** `expires_in: [export.expires_at - Time.current, 1.second].max`
- **Rejected alternative:** I tried `cache_if export.downloadable?`. It broke the test asserting that the cached indicator lives until its original deadline.
- **Validation:** the cached-indicator test passes under defaults 7.0, 7.1 and 8.1.

**2.4 `active_record.postgresql_adapter_decode_dates = true` (7.2)**
- **Affected code:** `app/models/notebook.rb:40`.
- **What breaks:** the activity report raises `TypeError: no implicit conversion of Date into String`.
- **Applicability:** when adopting defaults 7.2 or later. Ships early.
- **Repair:** `Date.iso8601(day.to_s)`
- **Validation:** the activity report test passes under defaults 7.0 and 8.1.

**2.5 Other defaults: no effect found here**

These were checked by reading the code and by the full suite passing under `--defaults 8.1`.

| Release | Default | Effect for this app and what to configure |
|---|---|---|
| 7.1 | `cache_format_version 7.1` | A Rails.cache rollout concern only. Production sets no cache store, so it uses the per-host file store. Enable it after all hosts run 8.1. |
| 7.1 | `message_serializer :json_allow_marshal` | Cookies are already `:json` (probed). No impact. |
| 7.1 | `active_job.use_big_decimal_serializer` | Not adoptable here: on 8.1 the BigDecimal serializer is always used (see section 3). |
| 7.1 | `run_after_transaction_callbacks_in_order_defined` | No `after_commit` callbacks. |
| 7.1 | `sqlite3_adapter_strict_strings_by_default` | PostgreSQL app. N/A. |
| 7.1 | `encryption.hash_digest_class SHA256` | No `encrypts`. N/A. |
| 7.1 | `action_dispatch.default_headers`, `debug_exception_log_level`, `precompile_filter_parameters` | No behaviour change seen. |
| 7.2 | `validate_migration_timestamps` | Existing migrations pass. |
| 7.2 | `active_job.enqueue_after_transaction_commit` | Not set by `load_defaults`. Do not opt in. `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue under the row lock so a failed enqueue rolls back. |
| 7.2 | `yjit` | Runtime only. |
| 8.0 | `to_time_preserves_timezone = :zone` | Covered by finding 1.18. 8.1 logs that the setting is deprecated, and `load_defaults 8.0` removes the warning. |
| 8.0 | `action_dispatch.strict_freshness` | `ExportDownloadsController#show` uses `stale?(etag:, last_modified:)`. When `If-None-Match` is present, `If-Modified-Since` is now ignored. Proposed check below. |
| 8.1 | `escape_json_responses = false`, `escape_js_separators_in_json = false` | No `render json:` or jbuilder views. |
| 8.1 | `action_on_path_relative_redirect = :raise` | All redirects use route helpers. |
| 8.1 | `raise_on_missing_required_finder_order_columns` | `first`/`last` are only used on arrays. |
| 8.1 | `action_view.render_tracker = :ruby`, `action_text.sanitizer_vendor` (HTML5) | Suite passes. |

Recommendation: bump with `load_defaults 7.0`. Then adopt the defaults one release at a time through `new_framework_defaults_*.rb`, after the repairs in 2.1 to 2.4 are deployed.

## 3. Rollout, rollback, and mixed-version risks

- **Queued Active Job payloads (high risk).** `DigestJob` receives `reading_completion`, a BigDecimal.
  - 8.1 enqueues it as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.6667"}`.
  - A 7.0 worker raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`, so mixed-version workers and rollbacks lose digests.
  - Repair, ship before the bump: in `app/models/user.rb:41`, pass `reading_completion.to_s`. Both versions then enqueue `"0.5"`, verified with a real Sidekiq enqueue. `DigestMailer` already calls `BigDecimal(...)`.
- **Time arguments.** 8.1 adds `"time_zone":"Asia/Tokyo"` to time payloads, which a 7.0 worker ignores (probed). With finding 1.17 deployed, both versions produce the same UTC day.
- **Other jobs.** `NoteReminderJob` and `CitationEnrichmentJob` arguments are GlobalIDs and safe both ways. `ExportJob` is native Sidekiq and is unaffected by the Rails version.
- **Stored records.** The `tags` (JSON) and `preferences` (YAML) column formats are identical on both versions (probed raw values).
- **`db/schema.rb`.** The first dump on 8.1 rewrites it to `ActiveRecord::Schema[8.1]`, `enable_extension "pg_catalog.plpgsql"`, and columns sorted alphabetically. The database structure doesn't change. Regenerate it in the bump PR and don't run migrations from 7.0 hosts after that.
- **Cookies and cache.** The cookie serializer stays `:json` and the cache format stays 7.0, so sessions survive in both directions. Don't enable `cache_format_version 7.1` until rollback is no longer possible.
- **Order of deployment:**
  1. **On 7.0.8.7 first:** findings 1.1, 1.3, 1.4, 1.6–1.14, 1.17, 1.18, 2.2, 2.3, 2.4 and the `to_s` job-argument fix. The `json ~> 2.7` pin is harmless on 7.0. All of these together passed 46/46 on 7.0.8.7.
  2. **With the bump:** 1.5 (`coder: JSON`), 1.15, 1.16, 2.1 (`coder: YAML`), and the Gemfile and lockfile.

## 4. Verification log and open questions

**Executed** (logs were under `/tmp/upgrade-rails-8.1.0/logs`, removed by cleanup: `bundle-update.log`, `diag-{baseline,upgraded,upgraded-defaults-7.0…8.1}.log`, `tests-*.log`, `schema-load-*.log`):
- `gem-changes rails 7.0.8.7 8.1.0`. It skipped the cached 7.0.10 and 7.1.6 gem files ("not an octal string") and printed no framework-defaults section, so I covered the defaults with `test --defaults`.
- `setup` reported:
  - baseline: boot OK, 67 routes, 46 runs / 325 assertions / 0 failures.
  - upgraded: boot failed (finding 1.1).
- An iterative `upgrade-workspace test` sequence on upgraded. The 7.0-defaults runs went 46 errors → 11F/35E → 19F/6E → 3F/10E → 4F → 0F (340 assertions). `--defaults 7.1`, `7.2`, `8.0` and `8.1` exposed findings 2.1 to 2.4, then reached 0 failures.
- `test --target baseline` with the early-ship repairs: 46 runs / 325 assertions / 0 failures.
- Probes:
  - routes, the session integration probe (json error), and Active Job serialization and cross-version deserialization;
  - serializer and coder raw values, the highlight alias, the next-day time in New York, and the cache, message, cookie and `to_time` settings;
  - schema dump diff, real Sidekiq enqueue, and server handler lookup.
- `cleanup rails 8.1.0`: databases dropped, Redis flushed, checkout `git status` clean.

**From reading code, not executed:**
- No custom Rack middleware, `render json:`, `has_secure_token`, `after_commit` or encryption in the app.
- Production `ActiveSupport::Logger` + `TaggedLogging` stays compatible with `BroadcastLogger`.

**Proposed checks not yet run:**
- `bin/rails test:system`.
- `GET` an export download with both `If-None-Match` and a matching `If-Modified-Since` under `--defaults 8.0`. Expect 304 only when the etag matches.
- A production-like boot with `RAILS_LOG_TO_STDOUT`.

**Open questions:**
- Whether json 3.1.0 really resolves from rubygems.org or only from the local gem cache. The pin is safe either way.
- When to move to sidekiq 7.3.3 or later, which Rails 8.2 will require.
- Whether `ARCHITECTURE.md` and `CONTRIBUTING.md` should be updated in the same PR for the secrets-to-`config_for` change.

---

**Note:** This is only a plan; I haven't upgraded anything yet, and your checkout is unchanged. The plan's trial run of the upgrade used a throwaway copy of the app.

Rails is locked at 7.0.8.7, so this jumps across four releases. The trial passed the main test suite, but the browser tests (`bin/rails test:system`) haven't been run.

Two things matter most:
- **Two bugs that don't show up as errors:** imports with a bad row would save partial data (1.8), and digests would cover the wrong day (1.17).
- **Rollback can lose digest emails** (section 3) unless the small `to_s` fix in `user.rb` is deployed before the upgrade.

The plan suggests shipping most fixes on 7.0 first and then making the version change. If you want, I can make those first fixes now, or do the whole upgrade on a branch.