Here is the planner's full plan for upgrading rails from 7.0.8.7 to 8.1.0. I haven't changed anything in the app.

# Upgrade plan: rails 7.0.8.7 → 8.1.0 (Margin Notes)

The app does not boot on 8.1.0 as-is. The planner fixed each break in a disposable copy until the suite ran to completion.

Resolved versions in the copy's `Gemfile.lock`:
- rails, railties and all Rails components move to 8.1.0.
- `rack` stays at 2.2.24, because Rails 8.1 allows it. The Rack 3 items don't apply unless rack is bumped separately.
- `sidekiq` 6.5.12 and `redis` 4.8.1 are unchanged.
- Added: `action_text-trix` 2.1.19, `rack-session` 1.0.2, `rackup` 1.0.1, `json`, `bigdecimal` 4.1.3, `drb`, `securerandom`, `uri`, `useragent`, `webrick`.
- Removed: `method_source`, which nothing in the app uses. `net-imap` moves to 0.6.8.
- `json` resolved to 3.1.0 on its own. The planner pinned it to 2.7.2 so the app could run (finding 7).

## 1. Required changes for the upgrade

All of these take effect immediately on the bump, under `load_defaults 7.0`. With them applied, the suite goes from a boot failure to 46 runs, 329 assertions, 1 failure, 0 errors. The 1 failure is the stale digest-payload assertion in finding 5. The suite also passes under `load_defaults 8.1` once that assertion is updated. The only other `--defaults 8.1` failures were the four default-triggered ones in section 2.

### 1. Action Text initializer crashes boot
- **Affected code:** `config/initializers/action_text.rb:3`.
- **What breaks:** boot fails with `NoMethodError: undefined method '+' for nil`. `ActionText::ContentHelper.allowed_tags` is nil by default from 7.1 on.
- **Applicability:** applies on the bump. The repair also works on 7.0.
- **Repair:**
  ```ruby
  helper = ActionText::ContentHelper
  helper.allowed_tags = helper.sanitizer.class.allowed_tags.to_a +
    [ ActionText::Attachment.tag_name, "figure", "figcaption" ] + %w[ details summary ]
  ```
- **Validation:** `test/controllers/notes_controller_test.rb:138` must pass. It asserts that `details summary` and `details p` render and that script, `onclick` and `javascript:` hrefs are absent.

### 2. `enum` and `serialize` signatures, and implicit YAML serialization
- **Affected code:** `app/models/note.rb:10` (`enum`), `app/models/note.rb:12` (`serialize :tags, JSON`), `app/models/notebook.rb:7` (`serialize :preferences`).
- **What breaks:** loading `Note` raises `ArgumentError` at `note.rb:10`. The positional coder on `serialize :tags` raises too. In 7.1+, `serialize :preferences` without a coder no longer defaults to YAML.
- **Applicability:** the `enum` form also works on 7.0. `serialize coder:` is 7.1+ only, so it ships with the bump.
- **Repair:**
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  serialize :tags, coder: JSON
  serialize :preferences, coder: YAML
  ```
  Use `coder: YAML` for `preferences`. Existing rows are YAML text, so JSON would break reads of them.
- **Validation:** the notebooks controller test "settings update the name and export heading but keep the slug" (`notebooks_controller_test.rb:22`) must pass. The `middlemarch` and `montaigne` fixtures must still load with tags JSON.

### 3. `alias_attribute` on a `store_accessor` attribute
- **Affected code:** `app/models/note.rb:13-14`. Used in `notes/index.html.erb:44`, `notes/show.html.erb:3`, `notes/_form.html.erb:31-37` and `notes_controller.rb:68`.
- **What breaks:** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`. This hit every Note-touching test.
- **Applicability:** applies on the bump. The repair also works on 7.0.
- **Repair:** remove `alias_attribute` and define the methods by hand.
  ```ruby
  def highlight_color = color
  def highlight_color=(value)
    self.color = value
  end
  ```
- **Validation:** the edit test (`notes_controller_test.rb:107`) posts `highlight_color: "green"` and asserts the checked radio. The `validates :color` inclusion check must still reject "red".

### 4. `get "/notes", "/journal"` is no longer accepted
- **Affected code:** `config/routes.rb:18`.
- **What breaks:** route drawing raises `ArgumentError`, and `notes_path` becomes undefined.
- **Applicability:** applies on the bump. The repair works on 7.0 and gives the same route names.
- **Repair:**
  ```ruby
  get "/notes", to: "notes#index", as: :notes
  get "/journal", to: "notes#index"
  ```
- **Validation:** `notes_controller_test.rb:7` iterates `[notes_path, journal_path]` and must get 200 on both.
- **Route diff note:** 8.1 drops three dev-only Action Mailbox conductor routes (`edit`, `update`, `destroy` on `/rails/conductor/action_mailbox/inbound_emails/:id`). Nothing in the app uses them.

### 5. Active Job argument payloads change (digest job)
- **Affected code:** `app/models/user.rb:41` (`DigestJob.perform_later(self, requested_at, reading_completion)`), `app/jobs/digest_job.rb`, `app/mailers/digest_mailer.rb:7-10`.
- **What changes:**
  - **Time zone.** 8.1 serializes `TimeWithZone` with `time_zone` and restores the reader's zone in the worker. A request at 23:30 New York time on Oct 4 now gets the subject "…October 04, 2026". Before, the worker used UTC and it read "October 05, 2026". The digest day and the notes listed change.
  - **BigDecimal.** The argument is now sent as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. On 7.0 it was the plain string `"0.5"`.
- **Rollout consequence:** a 7.0 worker raises `ActiveJob::DeserializationError` on jobs enqueued by 8.1 processes. Rollback strands them too. A 7.0 payload deserializes fine on 8.1.
- **Repair (ship before the bump):**
  ```ruby
  DigestJob.perform_later(self, requested_at.utc, reading_completion.to_s("F"))
  ```
  Update the assertion at `digests_controller_test.rb:29` to expect `"2026-10-05T03:30:00.000000000Z"`.
- **Validation:** with a New York reader and a request at `Time.utc(2026,10,5,3,30)`, assert the subject is "…October 05, 2026" and the body lists only Oct 5 UTC notes. The "one digest per UTC day" test and the "50% of your notes were ready" body must still pass.

### 6. Other API removals that break behavior
- **a. Multiple-key `where(notebooks: @notebook)`** (`notes_controller.rb:12`)
  - **Breaks:** `PG::UndefinedColumn: column notes.notebooks does not exist`.
  - **Repair:** `@notes.where(notebook: @notebook)`. Works on 7.0.
  - **Validation:** the tests at `notes_controller_test.rb:26` and `:58` pass, and a second user's notebook must not appear.
- **b. `form_with(model: nil)`** (`notes/index.html.erb:12`)
  - **Breaks:** `ActionView::Template::Error: Passed nil to the :model argument`.
  - **Repair:** drop `model: nil`. Works on 7.0.
  - **Validation:** the test at `notes_controller_test.rb:17` asserts `form[role=search][action="/notes"][method=get]`.
- **c. `Rails.application.secrets`** (removed in 7.2). Used in `app/models/citation/provider.rb:13` and `config/secrets.yml`.
  - **Breaks:** `NoMethodError: undefined method 'secrets'`. Production would lose the provider URL, user and password.
  - **Repair:** move the file to `config/citation_provider.yml`, flattened to `development: &local {url:, user:, password:}`, `test: *local` and `production: {...}`. In `config/application.rb` set `config.x.citation_provider = config_for(:citation_provider)`. Use `Rails.configuration.x.citation_provider.to_h` in `provider.rb`. The tests in `citation_enrichments_controller_test.rb` (lines 45, 117) must also use `config.x`. Works on 7.0.
  - **Validation:** "provider credentials from the environment reach the server unchanged".
- **d. `Array#sum` on strings** (`app/models/export.rb:42`)
  - **Breaks:** `TypeError: String can't be coerced into Integer`.
  - **Repair:** `finish(fragments.join)`. Works on 7.0.
  - **Validation:** the three export download tests.
- **e. `retry_on ... wait: :exponentially_longer`** (`citation_enrichment_job.rb:8`)
  - **Breaks:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
  - **Repair:** use `:polynomially_longer`. Not available on 7.0, so it ships with the bump.
  - **Validation:** "a provider that stays unavailable ... leaves a visible failure".
- **f. `stringify_keys` now stringifies integer keys** (`imports/preview.html.erb:22`)
  - **Breaks:** annotations silently vanish from the import preview.
  - **Repair:** use `@import.annotations` without `.stringify_keys`. Works on 7.0.
  - **Validation:** the CSV preview test.
- **g. `return` inside `transaction do` now commits** (`app/models/import.rb:53`, `apply`)
  - **Breaks:** invalid imports are partly saved. Record counts went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`.
  - **Repair:**
    ```ruby
    saved = false
    transaction do
      save!
      saved = rows.all? { |row| row.note.save }
      raise ActiveRecord::Rollback unless saved
    end
    saved
    ```
    Works on 7.0.
  - **Validation:** "invalid rows ... applying them saves nothing" asserts counts stay `[0, 3, 0, 1]`.
- **h. `citation[:id]` with string primary key `doi`** (`import.rb`, `receipt`)
  - **Breaks:** the receipt CSV prints blank DOIs.
  - **Repair:** `citation&.doi`. Works on 7.0.
  - **Validation:** the receipt assertion in the CSV test.
- **i. `Time#to_time` preserves the zone now, not the offset** (`note.rb:44`, `next_day_reminder_at`, shown in `_reminder.html.erb:19`)
  - **Breaks:** across the end of daylight saving time, "24 hours later" renders `2026-11-01T08:00:00-05:00` instead of `2026-11-01T09:00:00-04:00`. It is the same instant, but the displayed time differs. The comment at `note.rb:41-43` documents the old behavior.
  - **Repair:** `Time.at(reminder_epoch + 86_400).localtime(reminder_at.formatted_offset)`. Works on 7.0.
  - **Validation:** the reminders test asserts `#next_day_reminder time[datetime="2026-11-01T09:00:00-04:00"]`. `postpone_reminder` must still store the epoch plus 86,400 seconds.
- **j. `wait_until:` needs a `Time`** (`note.rb:68`)
  - **Breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`.
  - **Repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`. Works on 7.0.
  - **Validation:** the reminders test checks the enqueued job and its time.

### 7. `json` 3.1.0 breaks `ActiveSupport::JSON.decode`
- **Affected code:** `Gemfile` (no `json` entry). It shows up in any JSON read, such as `serialize :tags, coder: JSON`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291`. 8.1.0 calls `::JSON.parse(json, options)` with a positional hash. Any `Note` create or load fails.
- **Applicability:** applies on the bump, because the lock added `json` 3.1.0. Check whether a fixed `json` or Rails patch exists.
- **Repair:** in `Gemfile`, `gem "json", "2.7.2"`. The planner tried `~> 2.7` first, but it resolved to 2.21.2, which was not installed. With network access, use `"~> 2.7"`.
- **Validation:** `Note.create!` with non-null `tags` (`test/models/note_test.rb:4`).

### 8. Test-only config
- `config/environments/test.rb:31` sets `show_exceptions = false`.
- **What breaks:** exceptions render as 500 pages, so `assert_raises(ActiveRecord::RecordNotFound)` fails in several tests.
- **Repair:** `config.action_dispatch.show_exceptions = :none`. This is 7.1+ only, so it ships with the bump. On 7.0 the symbol is truthy and would render error pages.

## 2. New configuration defaults across intermediate releases

The app uses `config.load_defaults 7.0` (`config/application.rb:11`). None of these settings are set explicitly, so the old values are kept.

| Default | Release | 7.0 | 8.1 | Impact and what to configure |
|---|---|---|---|---|
| `active_record.raise_on_assign_to_attr_readonly` | 7.1 | false | true | `notebooks_controller.rb:26` permits `:slug`, and `attr_readonly :slug` is in `notebook.rb:8`. This raised `ReadonlyAttributeError: slug` on update. Remove `:slug` from `notebook_params`. Works on 7.0. |
| `active_record.postgresql_adapter_decode_dates` | 7.2 | false | true | `notebook.rb:40` `daily_note_counts`: `Date.iso8601(day)` raised `TypeError`. Use `Date.iso8601(day.to_s)`. Check `activity_reports_controller_test.rb:18`. |
| `active_support.raise_on_invalid_cache_expiration_time` | 7.1 | false | true | `exports/_export.html.erb:26`: `expires_in` goes negative once an export expires. Use `[export.expires_at - Time.current, 0].max`. Works on 7.0. |
| `cache_format_version` | 7.1 | 7.0 | 7.1 | Production uses the default file store. 7.0 processes cannot read 7.1-format entries, so adopt this only after rollback is no longer needed. |
| `active_support.message_serializer` and `use_message_serializer_for_metadata` | 7.1 | nil, nil | `:json_allow_marshal`, true | Session cookies still decoded across versions in both directions. |
| `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records` | 7.1 | false | true | No `after_commit` callbacks in `app/`. No change. |
| Active Record encryption hash digest | 7.1 | SHA1 | SHA256 | `encrypts` is not used. No change. |
| `action_view.sanitizer_vendor` | 7.1 | HTML4 | HTML5 | The details/summary test still passes. Spot-check other rendered notes. |
| `add_autoload_paths_to_load_path` | 7.1 | true | false | Nothing is required by load path. No change. |
| `active_job.enqueue_after_transaction_commit` | 7.2 | false | `:default` | The app enqueues inside `with_lock` (`note.rb:63-72`, `citation.rb:17-20`). Behavior was unchanged in testing. |
| `escape_json_responses`, `escape_js_separators_in_json` | 8.1 | true | false | No `render json:`. No change. |
| `action_on_path_relative_redirect` | 8.1 | `:log` | `:raise` | All redirects use path helpers. No change. |
| `raise_on_missing_required_finder_order_columns` | 8.1 | nil | true | `Citation` has primary key `doi`. No change. |
| `strict_freshness`, `Regexp.timeout`, `precompile_filter_parameters`, `query_log_tags_format` | 8.0, 8.1 | off or nil, `:legacy` | on, 1.0 s, `:sqlcommenter` | No action needed. |
| `to_time_preserves_timezone` | 7.1 | true | ignored, deprecated | Behavior changed on the bump regardless of defaults. See 6i. |
| `Rails.application.secrets`, `config.cache_classes` | removed, deprecated | | | See 6c. `cache_classes` still works but is replaced by `enable_reloading`. |

Not triggered or not re-checked: `button_to_generates_button_tag`, `remove_hidden_field_autocomplete`, `default_column_serializer`, `use_rfc4122_namespaced_uuids` and `automatically_invert_plural_associations`. The 8.1 change that sorts `schema.rb` columns alphabetically takes effect on the next schema dump. The planner did not run a dump, so the actual diff is unconfirmed.

**Recommendation:** keep `load_defaults 7.0` for the bump. Then raise it one release at a time (7.1, 7.2, 8.0, 8.1) after the repairs above are shipped.

## 3. Rollout, rollback and mixed-version risks

- **Database and schema:** no migration is needed. `db/schema.rb` was identical before and after. `preferences` stays YAML text and `tags` stays JSON.
- **Active Job:** the one concrete incompatibility is BigDecimal (finding 5). Ship the string-argument change first. The Sidekiq envelope otherwise differs only by an added `scheduled_at` key, which 7.0 ignores. `ExportJob.perform_async` is a native Sidekiq job and is unaffected.
- **Session cookie:** signed and encrypted cookies decoded in every version combination when they shared a `secret_key_base`. Production needs the same stable `secret_key_base` on both versions.
- **Cache:** with `cache_format_version` 7.0 retained, entries are shared. Adopting 7.1 format breaks rollback. The cached export fragment key includes a template digest, so it may regenerate.
- **Rack:** the lock keeps rack 2.2.24. If you later move to Rack 3, review `Rack::Request#values_at`. The test code at `citation_enrichments_controller_test.rb:108` uses it.
- **Preparatory repairs to ship on 7.0.8.7 before the bump:** findings 1, 2 (enum only), 3, 4, 6a, 6b, 6c, 6d, 6f, 6g, 6h, 6i, 6j, the `slug` permit change, the `Date.iso8601(day.to_s)` and cache `max` changes, and the digest argument change (5). With them applied, the 7.0 suite ran 46 runs, 315 assertions, 1 failure (the stale digest payload assertion).
- **Must wait for the bump:** `serialize coder:`, `:polynomially_longer`, `show_exceptions = :none`, and the `json` pin.

## 4. Verification log and open questions

**Run in the planner's disposable workspace:**
- Baseline: boots, 67 routes, 46 runs, 325 assertions, 0 failures. Upgraded boot failed at `config/initializers/action_text.rb:3`.
- Repeated test runs while applying repairs went from 45 failures and errors, to 25, to 4, to 1.
- The baseline suite with the preparatory repairs: 46 runs, 315 assertions, 1 failure.
- Side-by-side probes of config defaults, Active Job payloads, the Sidekiq envelope, session cookies, `to_time` and route listings.
- Cleanup ran and the checkout is clean.

**From source reading only (not run):**
- The `Rack::Request#values_at` removal.
- The explanations for 6f and 6h rest on the observed failures, not on tracing the Rails source.
- The 7.0 failure on an 8.1 `BigDecimalSerializer` payload was run as deserialization in a 7.0 process, not as a real worker retry.

**Not verified:**
- `bin/rails test:system`.
- Real Sidekiq worker execution on 8.1. The suite uses the `:test` adapter.
- A real `schema.rb` dump on 8.1.
- `bin/rails app:update` and any new Active Storage or Action Text migrations from 8.1.

**Open questions:**
- Is the `json` pin acceptable, or should the app wait for a Rails patch release?
- Should digests keep the old UTC-day behavior (what the repair preserves), or move to the reader's local day? That is a separate product decision.

---

**Commentary:** the plan only. I haven't implemented anything. I can start with the preparatory repairs on 7.0.8.7 and then do the bump if you want.