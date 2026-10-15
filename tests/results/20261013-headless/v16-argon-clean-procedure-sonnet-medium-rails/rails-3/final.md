# Upgrade plan: rails 7.0.8.7 to 8.1.0 (Margin Notes)

The workspace was cleaned up and `git status` on `/home/user/workspace/repo` is clean. The application checkout was never modified.

The bump cannot ship as-is: `upgraded` fails to boot. With the repairs below, `upgraded` boots, eager-loads and passes 46 runs, 340 assertions, 0 failures, 0 errors. That holds with `load_defaults 7.0` and with `--defaults 8.1`.

Resolved versions in the `upgraded` lockfile:
- rails, railties, actionpack, actionview, activerecord, activesupport, actionmailer, activejob, actiontext, actioncable, actionmailbox, actionstorage-side gems: 8.1.0
- Added: action_text-trix 2.1.19, bigdecimal 4.1.3, drb 2.2.3, json 3.1.0 (later pinned to 2.7.2, see 1.1), rack-session 1.0.2, rackup 1.0.1, securerandom 0.4.1, uri 1.1.2, useragent 0.16.11, webrick 1.9.2
- Removed: method_source
- net-imap 0.6.7 to 0.6.8
- rack stays at 2.2.24 and puma at 5.6.9

## 1. Required changes for the upgrade

Every finding below was reproduced in `upgrade-workspace` on `upgraded`. The exception is the `config/application.rb` hunk in 1.3, which was only run, not tested against the default coder, and the routes finding in 1.6, which has no isolated probe. The suite failures cover both. Findings not marked "backported to 7.0.8.7" cannot ship before the bump.

### 1.1 json 3.1.0 breaks Active Support JSON decoding
- **Affected code**: `Gemfile` (no json entry), `app/models/note.rb:12` (`serialize :tags`). It hits any model load that decodes JSON.
- **What breaks**: Bundler resolves json to 3.1.0. Active Support 8.1.0 calls `::JSON.parse(json, options)` with a positional hash, and json 3.1.0 rejects it. Creating a note with `Note.create!(title: "a", status: "ready")` raises `ArgumentError: wrong number of arguments (given 2, expected 1)`. The trace goes through `activesupport-8.1.0/lib/active_support/json/decoding.rb:25` and `json-3.1.0/lib/json/common.rb:291`.
- **Applicability**: Immediately on the bump, through `bundle update rails`. Backported to 7.0.8.7: yes, `gem "json", "2.7.2"` is the baseline default gem.
- **Repair**: Add `gem "json", "2.7.2"` to `Gemfile` after `concurrent-ruby` and re-lock. Revisit once a Rails release fixes the call. I did not check which release does.
- **Validation**: Without the pin, creating a note fails as above. With the pin, `bin/rails test` passes. The control is that `Note#tags` still round-trips.

### 1.2 `enum status: {...}, _prefix: true` and `serialize :tags, JSON` are removed
- **Affected code**: `app/models/note.rb:10`, `app/models/note.rb:12`, `app/models/notebook.rb:7`.
- **What breaks**: Loading `Note` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)` at `note.rb:10`. After the enum fix, the `serialize :tags, JSON` call is the next failure to fix. With `load_defaults 8.1`, `serialize :preferences` fails with `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to serialize.`
- **Applicability**: Immediately on the bump. The `preferences` failure appears only with `load_defaults 7.1` or later. Backported to 7.0.8.7: only the enum form. `coder:` is unsupported before 7.1.
- **Repair**:
  - `app/models/note.rb:10` becomes `enum :status, { draft: 0, ready: 1 }, prefix: true`. This works on 7.0.
  - `app/models/note.rb:12` becomes `serialize :tags, coder: JSON`.
  - `app/models/notebook.rb:7` becomes `serialize :preferences, coder: YAML`.
- **Validation**: Note tests error at class load without the repair and pass with it. A round trip of `Notebook#export_heading = "H"` reads back "H". The control is `Note.new.status_draft?`.
- **Data**: Stored formats are unchanged. `tags` is JSON text and `preferences` is YAML.

### 1.3 `Rails.application.secrets` and `config/secrets.yml` are removed
- **Affected code**: `config/secrets.yml`, `app/models/citation/provider.rb:3` and `:13`, `test/controllers/citation_enrichments_controller_test.rb:45`, `:117`, `:118`, `:122`.
- **What breaks**: `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Every citation lookup and two tests fail.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes, verified. `config_for` and `config.x` exist on 7.0.
- **Repair**:
  - Rename `config/secrets.yml` to `config/citation_provider.yml`.
  - Flatten the file so each env holds `url`, `user` and `password`. Use `<<: *local` for the test env. Keep the `.to_json` ERB quoting so values like "00123" stay strings.
  - Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  - In `provider.rb` use `Rails.configuration.x.citation_provider.to_h`.
  - In the test, replace `Rails.application.secrets.citation_provider` with `Rails.configuration.x.citation_provider`.
- **Validation**: The test "provider credentials from the environment reach the server unchanged" boots a fresh `bin/rails runner` with `CITATION_PROVIDER_USER=00123` and asserts that exact basic-auth header. It passes on both versions. The control is the other provider tests.

### 1.4 `get "/notes", "/journal", to:` is no longer accepted
- **Affected code**: `config/routes.rb:18`.
- **What breaks**: `ArgumentError: Wrong number of arguments (expect 1, got 2)` at `config/routes.rb:18`. Boot succeeded but the route table was empty, so `notes_path` and `note_path` were undefined.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: Use two lines: `get "/notes", to: "notes#index"` then `get "/journal", to: "notes#index"`.
- **Validation**: The `upgraded` route list matches `baseline`, including the `notes` and `journal` names, except 4 framework-owned action_mailbox conductor routes (edit, update and destroy). The control is `NotesControllerTest` loading both `/notes` and `/journal`.

### 1.5 Action Text initializer: `allowed_tags` is nil by default
- **Affected code**: `config/initializers/action_text.rb:3`.
- **What breaks**: Boot fails with `NoMethodError: undefined method '+' for nil`.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: Compute the default list when it is nil, then add the tags:
  ```ruby
  helper = ActionText::ContentHelper
  default_tags = helper.allowed_tags ||
    helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  helper.allowed_tags = default_tags + %w[ details summary ]
  ```
- **Validation**: "rich text keeps collapsible excerpts and drops unsafe markup" passes on 7.0, 8.1, and 8.1 with `load_defaults 8.1`. That last case includes the HTML5 sanitizer vendor. The control is that unsafe markup is still stripped.

### 1.6 `alias_attribute :highlight_color, :color` fails
- **Affected code**: `app/models/note.rb:14`. `color` is a `store_accessor`, not an attribute.
- **What breaks**: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color' or define the method manually.` This fails nearly every test and every export and import.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**:
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
  Because alias_method copies the method body at that line, the `store_accessor` line must stay above it.
- **Validation**: The note edit test, which sets a highlight color through the form, passes. The control is saving a note with a blank color.

### 1.7 `Array#sum` on strings no longer works
- **Affected code**: `app/models/export.rb:42`.
- **What breaks**: `TypeError: String can't be coerced into Integer`. Every export job fails.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: Change `fragments.sum` to `fragments.join`.
- **Validation**: The Markdown export test downloads the file and compares its content. It passes with the repair on 7.0 and 8.1.

### 1.8 `show_exceptions = false` in the test environment
- **Affected code**: `config/environments/test.rb:31`.
- **What breaks**: Six tests that expect `ActiveRecord::RecordNotFound` to be raised see no exception and fail with "ActiveRecord::RecordNotFound expected but nothing was raised." The controller responds with a 404 or 500 page instead.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: no. 7.0 treats any non-false value as true, so `:none` would show exceptions.
- **Repair**: Set `config.action_dispatch.show_exceptions = :none` at bump time.
- **Validation**: The foreign-reader tests pass again. The control is that a normal 200 request still passes.

### 1.9 `exponentially_longer` retry wait is removed
- **Affected code**: `app/jobs/citation_enrichment_job.rb:7`.
- **What breaks**: `RuntimeError: Couldn't determine a delay based on :exponentially_longer` raised from `Citation#request_enrichment` at `citation.rb:20`. The enqueue itself fails.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: no, because `:polynomially_longer` does not exist on 7.0.
- **Repair**: Use `wait: :polynomially_longer`. If you want the change before the bump, use `wait: ->(executions) { executions**4 + 2 }`. That drops the jitter, so it is not an exact backport.
- **Validation**: The "provider that stays unavailable" test passes, with its three attempts.

### 1.10 Passing an Integer as `wait_until` fails
- **Affected code**: `app/models/note.rb:61`.
- **What breaks**: `NoMethodError: undefined method 'utc' for an instance of Integer`, raised from `Note#schedule_reminder`. Scheduling and postponing reminders fail with a 500.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: `wait_until: Time.at(reminder_epoch)`.
- **Validation**: Probe on `upgraded` unrepaired: `schedule_reminder(Time.utc(2026,11,2,14).to_i)` raises the `utc` error, and repaired returns `true`. The control `schedule_reminder(nil)` returns `false` both ways.

### 1.11 `form_with(model: nil)` now raises
- **Affected code**: `app/views/notes/index.html.erb:12`.
- **What breaks**: `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. The notes list, which is also the sign-in landing page, returns 500.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: `form_with(model: false, ...)`.
- **Validation**: "renders an unbound search form" passes. The control is that the search and per_page parameters still work.

### 1.12 `where(notebooks: @notebook)` generates invalid SQL
- **Affected code**: `app/controllers/notes_controller.rb:12`.
- **What breaks**: With `notebook_id=...` supplied, `/notes` raises `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`. The reader sees a 500.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: `@notes.where(notebook_id: @notebook.id)`.
- **Validation**: Probe on `upgraded` unrepaired: `user.notes.where(notebooks: nb).count` raises the `UndefinedColumn` error. The repaired `where(notebook_id: nb.id).count` returns 4 on baseline and upgraded. Another reader's notebook still raises `RecordNotFound` at `current_user.notebooks.find`.

### 1.13 `HashWithIndifferentAccess#stringify_keys` now stringifies Integer keys
- **Affected code**: `app/models/import.rb:38-42`, `app/views/imports/preview.html.erb:22`.
- **What breaks**: The preview lookup `annotations[row.line]` returns nil, so the Annotation row disappears from the preview. A test fails with "Expected: 'Read <b>twice</b> & reflect' Actual: '10.1000/Essays.1'". Baseline `{2=>"a"}` becomes upgraded `{"2"=>"a"}`.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: `Import#annotations` becomes `rows.to_h { |row| [row.line, row.annotation] }`. In the view use `@import.annotations` with no `stringify_keys`.
- **Validation**: Probe: with two rows, unrepaired `annotations.stringify_keys[2]` is nil on both versions, and repaired lookup by Integer line returns "first note". The preview tests pass.

### 1.14 Silent change: `return false` inside `transaction do` now commits
- **Affected code**: `app/models/import.rb:51-60` (`Import#apply`).
- **What breaks**: A row whose `save` returns false after the first row used to roll everything back. Now the import and the first note are committed while `apply` returns false. The test suite did not catch this, because the preview validates before saving.
- **Observed**: With the second row's `save` forced to return false, `apply` returns `false` on both versions. Baseline delta is notes=0, imports=0. Upgraded delta is notes=1, imports=1.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**:
  ```ruby
  saved = false
  transaction do
    save!
    saved = rows.all? { |row| row.note.save }
    raise ActiveRecord::Rollback unless saved
  end
  saved
  ```
- **Validation**: The failing-row probe gives 0/0 on both versions with the repair. The control is a normal two-row import: `apply` returns true with 2 notes and 1 import on both versions.

### 1.15 `citation[:id]` returns nil for a custom primary key
- **Affected code**: `app/models/import.rb:68`.
- **What breaks**: The receipt CSV loses every DOI. Probe on `upgraded` unrepaired: `"title,doi\nA,\nB,\n"`. Repaired and on baseline: `"title,doi\nA,10.1000/pr.2\nB,\n"`. The existing receipt test fails.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**: `citation && citation.id`.
- **Validation**: As above. The control is that a note without a citation still gets a blank DOI.

### 1.16 Active Job serializes `TimeWithZone` with its zone
- **Affected code**: `app/mailers/digest_mailer.rb:7-9`, `app/jobs/digest_job.rb:6`, `app/models/user.rb:35`.
- **What breaks**: The digest used to be computed in the worker's UTC zone. It is now computed in the reader's zone. The documented behavior is the UTC day. The test reads "Your reading digest for October 04, 2026" instead of October 05, and the 24-hour window is wrong.
- **Observed**: Eastern reader, request at 2026-10-05 03:30 UTC. Unrepaired upgraded subject: "...October 04, 2026". Control, request at 15:30 UTC (same day in both zones): "October 05, 2026" in both.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes, verified.
- **Repair**: In `DigestMailer#daily_digest`, add `requested_at = requested_at.utc` before `@date = requested_at.to_date`.
- **Validation**: Probe after the repair: October 05 for both inputs on both versions. The existing digest test then passes.

### 1.17 `Time#to_time` on a `TimeWithZone` no longer preserves the original UTC offset
- **Affected code**: `app/models/note.rb:44` (`next_day_reminder_at`), displayed by `app/views/notes/_reminder.html.erb`.
- **What breaks**: The reminder at 2026-10-31 09:00 EDT, plus 24 hours across the end of daylight saving time. Baseline: `2026-11-01T09:00:00-04:00`. Upgraded: `2026-11-01T08:00:00-05:00`. The preview text changes from 09:00 (UTC-04:00) to 08:00 (UTC-05:00). The instant is the same, and the stored epoch is unchanged, because both sides use `+86400`.
- **Applicability**: Immediately on the bump. Backported to 7.0.8.7: yes.
- **Repair**, which keeps the documented behavior: `(reminder_at.utc + 86_400).localtime(reminder_at.utc_offset)`. Otherwise update the comment and the assertion to the new wall-clock display.
- **Validation**: Probe: DST crossing gives `2026-11-01T09:00:00-04:00` on both versions, and the June control gives `2026-06-02T09:00:00-04:00`.

### 1.18 Rack 3 is blocked by sidekiq 6.5.12
- **Affected code**: `Gemfile` (`sidekiq 6.5.12`, `redis 4.8.1`, `puma ~> 5.0`).
- **What changes**: The `gem-changes` Rack 3 items do not apply to this resolution. Sidekiq 6.5.12 requires `rack ~> 2.0` and `bundle update rack` keeps 2.2.24. A real Puma server running `Rails.application` serves requests on both versions, with the same headers.
- **Warning**: In non-test environments, `queue_adapter = :sidekiq` prints "DEPRECATION WARNING: The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2. Please upgrade sidekiq gem to version 7.3.3 or later."
- **Follow-up**: Plan a separate change to sidekiq 7.3.3 or later, after which Rack 3 can resolve. That change would also need Puma 6, and `Rack::Request` use in `citation_enrichments_controller_test.rb:108` would need review. Not tested.

## 2. New configuration defaults across intermediate releases

The application sets `config.load_defaults 7.0` in `config/application.rb:12` and sets none of these explicitly in `config/`. The only settings it already makes in `config/` are `active_job.queue_adapter`, `cache_store`, `show_exceptions`, `eager_load` and `i18n.fallbacks`, none of which collides with a new default. The suite passes on 8.1 with `load_defaults 7.0` and with `load_defaults 8.1` once the 1.x repairs and the three below are applied. Per-version `case` entries in `railties-8.1.0/lib/rails/application/configuration.rb` are the source for the lists.

| Version | Default | Effect here | Action when adopting |
|---|---|---|---|
| 7.1 | `active_record.raise_on_assign_to_attr_readonly = true` | Observed with `load_defaults 8.1`: `ActiveRecord::ReadonlyAttributeError: slug`. See 2.1 | Fix 2.1 first |
| 7.1 | `active_support.raise_on_invalid_cache_expiration_time = true` | Observed: `ArgumentError: Cache expiration time is invalid, cannot be negative: -60.0`. See 2.2 | Fix 2.2 first |
| 7.1 | `active_record.default_column_serializer = nil` | `serialize :preferences` needs a coder. Covered in 1.2 | Covered |
| 7.1 | `active_support.cache_format_version = 7.1` | 7.0 cannot read 7.1 entries. See section 3 | Adopt only after rollback is no longer needed |
| 7.1 | `active_support.message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | Cookies written with 8.1 defaults were read by 7.0 in my probe | Safe in my probe. See section 3 |
| 7.1 | `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `before_committed_on_all_records = true`, `run_after_transaction_callbacks_in_order_defined = true`, `generate_secure_token_on = :initialize`, `marshalling_format_version = 7.1`, `add_autoload_paths_to_load_path = false` | The app has no commit callbacks, `has_secure_token`, or `$LOAD_PATH`-dependent requires (read from source) | None |
| 7.1 | `action_text.sanitizer_vendor`, `action_view.sanitizer_vendor` (HTML5) | Rich text sanitization passes my test, but only that fixture | Add a rich-text test with other tags |
| 7.1 | `dom_testing_default_html_version = :html5` | `assert_select` passes | None |
| 7.1 | `active_record.encryption.*`, `sqlite3_adapter_strict_strings_by_default`, `query_log_tags_format`, `belongs_to_required_validates_foreign_key` | Not used, or covered by tests | None |
| 7.2 | `active_record.postgresql_adapter_decode_dates = true` | See 2.3 | Fix 2.3 first |
| 7.2 | `validate_migration_timestamps = true` | Latest migration is 2026_10_11, past | None |
| 7.2 | `yjit = true`, `active_storage.web_image_content_types` | None relevant | None |
| 8.0 | `action_dispatch.strict_freshness = true`, `Regexp.timeout ||= 1` | App regexes (DOI format, wildcard-escaped LIKE) are short; read from source | None |
| 8.1 | `action_controller.escape_json_responses = false`, `active_support.escape_js_separators_in_json = false` | The app has no `render json:` or jbuilder views | None |
| 8.1 | `action_controller.action_on_path_relative_redirect = :raise` | All `redirect_to` calls use path helpers; root uses `redirect("/notes")` | None |
| 8.1 | `active_record.raise_on_missing_required_finder_order_columns = true` | Suite passes. The app has no PK-less `first`/`last` | None |
| 8.1 | `action_view.render_tracker = :ruby`, `remove_hidden_field_autocomplete = true` | Fragment cache and forms pass the suite | None |

None of the 7.0-era settings set by `load_defaults 7.0` is deprecated by a later release in this range except `active_support.to_time_preserves_timezone`. That one is set as `nil` on 8.1 and warns if you read it, and it is the cause of 1.17.

### 2.1 `raise_on_assign_to_attr_readonly`: `attr_readonly :slug`
- **Affected code**: `app/models/notebook.rb:8`, `app/controllers/notebooks_controller.rb:40`, `app/views/notebooks/_form.html.erb` (hidden `slug` field).
- **What breaks**: With `load_defaults 8.1`, `nb.update(slug: nb.slug)` raises `ActiveRecord::ReadonlyAttributeError: slug` even for an unchanged value. The settings form posts a hidden slug, so saving notebook settings fails with a 500. `nb.update(name: "x")` still works.
- **Applicability**: Only when adopting `load_defaults 7.1` or later. Backported to 7.0.8.7: yes.
- **Repair**: Change `notebook_params` to `permit(:name, :export_heading)`. Leave the hidden field, because the existing test asserts it is present and an ignored hidden field is harmless. Removing the field would break that test.
- **Validation**: "settings update the name and export heading but keep the slug" posts `slug: "renamed"` and expects slug `novels`. It fails without the repair and passes with it under `--defaults 8.1`. The control is the name and export_heading update in the same test.

### 2.2 `raise_on_invalid_cache_expiration_time`: expiry in the view
- **Affected code**: `app/views/exports/_export.html.erb:26`.
- **What breaks**: A completed export whose `expires_at` has passed still renders the cache block. `expires_in: export.expires_at - Time.current` is negative, so the exports page raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0`.
- **Applicability**: Only on `load_defaults 7.1` or later. Backported to 7.0.8.7: yes.
- **Repair**: `expires_in: [ export.expires_at - Time.current, 0 ].max`.
- **Validation**: The test "the cached availability indicator does not authorize a download" passes. In a probe, a negative expiry raises and `0` succeeds.

### 2.3 `postgresql_adapter_decode_dates`: raw date strings
- **Affected code**: `app/models/notebook.rb:39-40` (`daily_note_counts`).
- **What breaks**: `select_rows` returns Date objects instead of ISO text. The activity report raises `TypeError: no implicit conversion of Date into String` at `notebook.rb:40`. In a probe the raw type is `Date` under defaults and `String` otherwise.
- **Applicability**: Only on `load_defaults 7.2` or later. Backported to 7.0.8.7: yes.
- **Repair**: `Date.iso8601(day.to_s)`.
- **Validation**: Three notes created at 2026-10-05 03:30, 2026-10-05 01:00 and 2026-10-04 23:59 UTC give `[[Mon, 05 Oct 2026, 2], [Sun, 04 Oct 2026, 1]]` on baseline, upgraded, and upgraded with `--defaults 8.1`.

## 3. Rollout, rollback and mixed-version risks

All checks below were run with `load_defaults 7.0` unless noted.

- **Database**: No migration is needed. Stored `tags` (JSON text), `preferences` (YAML text) and `settings` (jsonb) are unchanged.
- **`db/schema.rb`**: Dumping on 8.1 against the same database gives a cosmetic diff. The header is `ActiveRecord::Schema[8.1]`, the extension line is `pg_catalog.plpgsql`, and columns are sorted alphabetically in every table. The tables, indexes and foreign keys are the same, and there is no destructive diff. Re-dump on 8.1 so the churn lands in one commit.
- **Cookies and sessions**: A cookie written with `encrypted` and `signed` on either version was read by the other, in both directions, with the app's current digests and JSON serializer. This also held when 8.1 wrote with `load_defaults 8.1`. I used a fixed test secret, not the real session store. Real session cookies were not tested.
- **Cache**: Fragment caching is the only cache use, and `test.rb` uses `null_store`. With `load_defaults 7.0`, `FileStore` entries (a hash, a time, a date, a BigDecimal and an html_safe string) were readable across versions in both directions. If 8.1 wrote with `load_defaults 8.1` (`cache_format_version 7.1`), a 7.0 process reading them raised `TypeError: incompatible marshal file format (can't be read) format version 4.8 required; 17.1 given`. So adopt `load_defaults 8.1` only after the rollback window closes, or clear the cache on rollback. Marshaled Active Record objects are not compatible across versions, but the app does not cache any.
- **Queued jobs**: Both directions run with the repairs applied:
  - Active Job payloads: the 8.1 payload for `DigestJob` adds `time_zone` and `scheduled_at`. A 7.0 worker ran the 8.1 payload, and an 8.1 worker ran the 7.0 payload.
  - Sidekiq wrapper payloads: pushed through the Sidekiq adapter on each version and executed by `JobWrapper` on the other. Both gave "Your reading digest for October 05, 2026".
  - A digest job queued before the bump and run by a worker without repair 1.16 would use the reader's local date. Deploy 1.16 first.
  - `ExportJob` is a native Sidekiq job with string keys and is unaffected.
- **Mixed-version risk with the repairs**: Deploy these on 7.0.8.7 first, because each was verified to pass the baseline suite (46 runs, 325 assertions, 0 failures):
  - 1.3 (secrets), 1.4 (routes), 1.5 (Action Text initializer), 1.6 (alias_method), 1.7 (export sum), 1.10 (wait_until), 1.11 (form_with), 1.12 (where), 1.13 (annotations), 1.14 (transaction), 1.15 (receipt), 1.16 (digest), 1.17 (next day), and the `enum :status` half of 1.2.
  - 2.1, 2.2 and 2.3 are also safe on 7.0.8.7. In my backport run the baseline had 2.1 only partially applied, so run 2.1 in your own check.
  - Do not backport `coder:` (1.2), `:none` (1.8) or `polynomially_longer` (1.9). The `json` pin (1.1) is safe.

## 4. Verification log and open questions

### Executed in `upgrade-workspace` (logs in `/tmp/upgrade-rails-8.1.0/logs`, now deleted by cleanup)
- `gem-changes rails 7.0.8.7 8.1.0`. Several `.gem` extractions for 7.0.10, 7.1.6 and later were skipped with "not an octal string" errors (cache corruption). The changelog and upgrade-guide sections were still read, but the commit and `lib/` file listings may be incomplete. I did not re-fetch them.
- `setup rails 7.0.8.7 8.1.0`:
  - Baseline: boot OK, eager_load OK, routes=67, 46 runs, 325 assertions, 0 failures.
  - Upgraded: boot FAILED at `config/initializers/action_text.rb:3`, eager_load FAILED, routes=0, test runner exited with status 1.
  - The load-defaults pass failed the same way.
- Iterated `upgrade-workspace test` and `test --defaults 8.1` on `upgraded` until clean (46 runs, 340 assertions, 0 failures, 0 errors, 0 skips both ways). `test --target baseline` with the 7.0-compatible subset: 46 runs, 325 assertions, 0 failures.
- Probes: the 1.x and 2.x comparisons above, Puma and Rack versions (rack 2.2.24, puma 5.6.9 on both), cookie and cache round trips (`/tmp/probe_w.rb`, `/tmp/probe_r.rb`), job payload round trips and the `schema.rb` dump diff. I ran `setup` a second time by mistake midway. That reset `upgraded`, and I re-applied the repair patch before continuing.

### Based on reading source only
- Defaults marked "read from source" in section 2: no commit callbacks, `has_secure_token`, or `render json:` in `app/`, and `redirect_to` using path helpers only.
- The explanation that json 3.1.0 removed positional options is inferred from the trace and the `parse` signature. I did not read a release note.

### Not verified
- `bin/rails test:system` (selenium) and the development environment.
- A real `bin/rails server` boot (only an in-process Puma server run).
- Production-like cookies using real `secret_key_base`, and real Redis cache stores.
- A Sidekiq 7 / Rack 3 / Puma 6 combination.
- Whether a later 8.1.x patch release fixes the json incompatibility, so the pin in 1.1 may be removable.
- Whether you want 1.17 kept as the old display or updated to the new wall-clock behavior. This is a product decision.

---

**Commentary:** The upgrade skill only plans, so I haven't changed anything in the repo. The plan suggests two stages:

1. First, backport the repairs marked "backported to 7.0.8.7" to the current Rails and deploy them.
2. Then bump `rails` to `8.1.0`, with the json pin, `coder:`, `show_exceptions = :none` and `polynomially_longer` changes.

Two items need your decision:
- **1.17:** Do you want to keep the old DST display or accept the new wall-clock behavior?
- **1.18:** Sidekiq 7.3.3 or later is a separate follow-up.

Tell me whether to implement the plan, and whether to do it in both stages or as a single bump.