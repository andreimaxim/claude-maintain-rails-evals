The planner's full plan is below. Nothing in the working application has been changed.

# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

Bumping Rails alone leaves the app unbootable. With the repairs below, the upgraded copy boots, eager-loads and passes all 46 tests (340 assertions). That holds both under the current `load_defaults 7.0` and with `load_defaults 8.1`. Most repairs can ship on 7.0.8.7 first. Five cannot (listed under Rollout).

## 1. Required changes for the upgrade

These apply as soon as the gem is bumped. Each line gives the file and line, then what fails in the upgraded copy.

| # | Affected code | Failure observed on the upgraded copy |
|---|---|---|
| 1 | `config/initializers/action_text.rb:3` | Boot fails. `NoMethodError: undefined method '+' for nil`. `ActionText::ContentHelper.allowed_tags` is now nil until used. |
| 2 | `app/models/note.rb:12`, `app/models/notebook.rb:7` | `serialize :tags, JSON` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. `serialize :preferences` raises `ArgumentError: missing keyword: :coder`. |
| 3 | `app/models/note.rb:10` | `enum status: {...}, _prefix: true` uses the keyword form, which was removed in 8.0. |
| 4 | `app/models/note.rb:13-14` | `alias_attribute :highlight_color, :color` raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute.` `color` is a `store_accessor`. |
| 5 | `config/routes.rb:18` | `get "/notes", "/journal"` raises `ArgumentError: Wrong number of arguments (expect 1, got 2)`. |
| 6 | `config/environments/test.rb:31` | `show_exceptions = false` is no longer understood. Any value other than `:none` or `:rescuable` now renders error pages. `RecordNotFound` was never raised in tests, and requests returned 500. |
| 7 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117-122` | `NoMethodError: undefined method 'secrets'`. `Rails.application.secrets` was removed in 7.2. |
| 8 | `app/views/notes/index.html.erb:12` | `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. |
| 9 | `app/jobs/citation_enrichment_job.rb:7` | `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. |
| 10 | `app/models/note.rb:61` | `NoMethodError: undefined method 'utc' for an instance of Integer`. `wait_until:` now requires a Time. |
| 11 | `app/controllers/notes_controller.rb:12` | `PG::UndefinedColumn: column notes.notebooks does not exist`. `where(notebooks: @notebook)` is no longer resolved to the `notebook` association. |
| 12 | `app/models/export.rb:42` | `TypeError: String can't be coerced into Integer`. `fragments.sum` on strings no longer concatenates. |
| 13 | `app/views/imports/preview.html.erb:22`, `app/models/import.rb:39` | `HashWithIndifferentAccess#stringify_keys` now stringifies integer keys (8.0). Probe: `[2]` becomes `["2"]`, and `h.stringify_keys[2]` goes from `"a"` to `nil`. Annotations vanish from the preview. |
| 14 | `app/models/import.rb:53-58` | `return false` inside `transaction` now commits (7.2 removed the rollback). The invalid-rows test saw `record_counts` change from `[0,3,0,1]` to `[1,4,1,2]`. The import is partly saved. |
| 15 | `app/models/import.rb:68` | `citation[:id]` returns nil for the custom primary key `doi`. The receipt CSV has blank DOIs. |
| 16 | `app/mailers/digest_mailer.rb:8` | Active Job (7.1) serializes `TimeWithZone` with a `"time_zone"` key and restores it. The digest subject changes from `"October 05, 2026"` to `"October 04, 2026"`. Probe: `to_date` goes from `Mon, 05 Oct` to `Sun, 04 Oct`. |
| 17 | `app/models/note.rb:44` | `reminder_at.to_time + 86_400` yields `2026-11-01T08:00:00-05:00` instead of `2026-11-01T09:00:00-04:00`. The next-day preview label changes. The epoch passed to the scheduler does not change. |
| 18 | `Gemfile` / `Gemfile.lock` | See the `json` pin and the removed runtime dependencies below. |

**`json` gem.** The resolver picks `json 3.1.0`, which `ActiveSupport::JSON.decode` cannot call. Every JSON-serialized attribute then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)`. I pinned `gem "json", "< 3"`, which resolved to 2.7.2 offline. This is probably an artifact of this environment, so confirm it against a clean `bundle update`.

**Dependency changes in `Gemfile.lock`:**
- `method_source` is removed. It is not used directly, so no action is needed.
- `net-smtp`, `net-imap` and `mini_mime` remain through `mail`. No Gemfile additions are needed.
- `rack` moves 2.2.24 to 3.2.7, and `rack-session`, `rackup`, `webrick` and several others are added.
- The app has no custom middleware. Its only `Rack::Request` use is in a test.
- `action_text-trix` 2.1.19 is added.

**Other changes that surfaced:**
- `bin/rails routes` drops four dev-only Action Mailbox conductor routes: edit, update and delete (PATCH, PUT and DELETE).
- The `db/schema.rb` dump becomes `Schema[8.1]` with columns sorted alphabetically. This is a noisy diff only.

### Repairs verified in the workspace

Every row below passes the full suite on the upgraded copy. The last column is whether it also passes on 7.0.8.7.

| # | Repair | Safe on 7.0.8.7? |
|---|---|---|
| 1 | In `config/initializers/action_text.rb`, set `allowed_tags = (allowed_tags \|\| (sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])) + %w[details summary]` | Yes |
| 2 | `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML` | **No.** Probe on 7.0 shows `coder: JSON` silently selects `YAMLColumn` and writes `"---\n- x\n"`. Ship it with the bump. |
| 3 | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes |
| 4 | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes |
| 5 | Two lines: `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"` | Yes. Route names `notes` and `journal` are unchanged. |
| 6 | `config.action_dispatch.show_exceptions = :none` | **No.** 7.0 treats `:none` as truthy. Ship it with the bump. |
| 7 | Rename `config/secrets.yml` to `config/citation_provider.yml` and flatten it per environment. Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`. In `Citation::Provider`, read `Rails.configuration.x.citation_provider`. Update the test to match. | Yes |
| 8 | `form_with(model: false, ...)` | Yes |
| 9 | `wait: :polynomially_longer` | **No.** 7.0 lacks the symbol. Ship it with the bump. Alternative on 7.0: a lambda `->(n) { n**4 + 2 }`. |
| 10 | `wait_until: Time.at(reminder_epoch)` | Yes |
| 11 | `where(notebook: @notebook)` | Yes |
| 12 | `finish(fragments.join)` | Yes |
| 13 | In the preview view, use `@import.annotations` without `.stringify_keys` | Yes |
| 14 | Replace `return false` with `raise ActiveRecord::Rollback unless row.note.save`, set `applied = true` after the loop, and return `applied` | Yes |
| 15 | `csv << [note.title, note.doi]` | Yes |
| 16 | In the mailer, `requested_at = requested_at.utc` before `to_date` and `all_day` | Yes |
| 17 | `Time.at(reminder_epoch + 86_400).localtime(reminder_at.utc_offset)` | Yes |
| 18 | `gem "json", "< 3"` | n/a |

**Validation.**
- The discriminating checks are the exact failures in the table above, observed on the unrepaired upgraded copy.
- The controls are the same tests passing after repair. Examples: `ImportsControllerTest` valid-CSV import still saves 2 notes, the `/journal` and `/notes` list tests, `NotesControllerTest` filtering by notebook, and `RemindersControllerTest`.
- The reminder test uses Eastern time with a daylight-saving boundary. The digest test uses an Eastern reader with a 03:30 UTC request.
- On 7.0.8.7, with every repair marked "Yes" applied and the three "No" items reverted, the suite gave 46 runs, 325 assertions and 0 failures.

## 2. New configuration defaults across intermediate releases

The app uses `config.load_defaults 7.0` (`config/application.rb:12`). That keeps the old value for every default listed below. None of these are explicit in `config/`, so none change on the bump.

**Release 7.1, adopted via `load_defaults 7.1`:**
- `raise_on_assign_to_attr_readonly = true`:
  - **Affected:** `Notebook` has `attr_readonly :slug` (`notebook.rb:8`), and `notebooks_controller.rb:40` permits `:slug`.
  - **Observed:** `ActiveRecord::ReadonlyAttributeError: slug` in the notebook settings update test.
  - **Repair:** `permit(:name, :export_heading)`. Create is unaffected because `assign_slug` overwrites it. Safe on 7.0.
- `raise_on_invalid_cache_expiration_time = true`:
  - **Affected:** `exports/_export.html.erb:26`, `expires_in: export.expires_at - Time.current`.
  - **Observed:** `Cache expiration time is invalid, cannot be negative: -60.0` for an expired export.
  - **Repair:** `expires_in: [export.expires_at - Time.current, 0].max`. Safe on 7.0.
- `postgresql_adapter_decode_dates = true` (7.2 defaults):
  - **Affected:** `Notebook#daily_note_counts`, `notebook.rb:40`.
  - **Observed:** `TypeError: no implicit conversion of Date into String` from `Date.iso8601(day)`.
  - **Repair:** `Date.iso8601(day.to_s)`. Safe on 7.0.
- `default_column_serializer = nil`: already satisfied by the explicit `coder:` repair above.
- `cache_format_version = 7.1`:
  - **Impact:** Production has no `cache_store` set, and the test store is `:null_store`. There is no impact unless a Redis cache is added later.
  - **Config:** Leave it unset.
- `message_serializer = :json_allow_marshal`, plus `use_message_serializer_for_metadata`:
  - **Observed under 7.0 defaults:** `cookies_serializer` is `:json`. Messages from `message_verifier` are still Marshal ("BAhJ…") on both versions.
  - **Observed under 8.1 defaults:** `:json_allow_marshal` and metadata set to true. New messages (signed ids, attachment sgids) become JSON, which 7.0 cannot read.
  - **Config:** Adopt late.
- `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `before_committed_on_all_records = true`, `run_after_transaction_callbacks_in_order_defined = true`:
  - **Affected:** The models have no `after_commit` or `before_committed!` callbacks, so no effect.
- `belongs_to_required_validates_foreign_key = false`: `Note belongs_to :citation` is `optional: true`, so no effect.
- `generate_secure_token_on = :initialize`: no `has_secure_token` in the app.
- `marshalling_format_version = 7.1`: affects Marshal-cached records only. There are none.
- `encryption.hash_digest_class` and `support_sha1_for_non_deterministic_encryption`: the app has no encrypted attributes.
- `add_autoload_paths_to_load_path = false`: the boot check passed.
- `precompile_filter_parameters`, `dom_testing_default_html_version = :html5` and `sanitizer_vendor`: the tests passed under these.
- `action_dispatch.default_headers` changes: no effect on tests.

**Release 7.2:**
- `yjit = true`: runtime only. Verify memory use on the host.
- `validate_migration_timestamps = true`: the migration timestamps (`2026101…`) do not trip it in the tests.
- `web_image_content_types`: Active Storage image variants are not used.

**Release 8.0:**
- `strict_freshness = true`: no conditional GET code in the app.
- `Regexp.timeout = 1`: `Citation::Provider` URL checks use `URI`, not regexes. No impact seen.

**Release 8.1:**
- `escape_json_responses = false` and `escape_js_separators_in_json = false`: the app has no `render json:`. Jbuilder is installed but unused for HTML.
- `action_on_path_relative_redirect = :raise`: all `redirect_to` calls use path helpers. `routes.rb:26` uses `redirect("/notes")`, which is absolute. No impact.
- `raise_on_missing_required_finder_order_columns = true`: `Import.last` is in tests only, on a model with a primary key. No impact.
- `render_tracker = :ruby` and `remove_hidden_field_autocomplete = true`: the tests passed under these.

Under `load_defaults 8.1` the suite had exactly three failures before repair, all covered above.

**Deprecated or removed settings.** None of the settings the app sets explicitly are deprecated or removed. The exceptions are `show_exceptions = false` (removed in 7.2), `Rails.application.secrets` (removed in 7.2) and `serialize` with a positional coder (removed in 7.2). All are covered above.

**Existing configuration to be aware of:**
- `config.active_job.queue_adapter = :sidekiq` in `application.rb` and `:test` in `test.rb` now apply to all tests (7.2). The suite passes.
- The cache store is a null store in test, and production sets none. The 7.1 pooling change therefore has no effect.

## 3. Rollout, rollback and mixed-version risks

**Active Job payloads**
- **BigDecimal.** 8.1 serializes `BigDecimal` as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. 7.0 sent the plain string `"0.5"`.
  - **Affected:** `User#request_digest`, `user.rb:41`, passes `reading_completion`.
  - **Observed:** A 7.0 worker handed an 8.1 payload raises `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. This only matters on rollback or in a mixed fleet.
  - **Repair:** Pass `reading_completion.to_s("F")`. It is safe on 7.0, produces identical wire data on both versions, and `DigestMailer` already calls `BigDecimal(params[:completion])`.
- **TimeWithZone.** 8.1 adds a `"time_zone"` key to the `requested_at` argument. A 7.0 worker ignores it and reads the time in UTC. An 8.1 worker reading an old payload, which has no key, also gets UTC. The `.utc` repair in `DigestMailer` makes both give the same date.
- **GlobalID.** The `_aj_globalid` arguments are unchanged.
- **Sidekiq.** Both versions enqueued correctly to Redis on Sidekiq 6.5.12 (probe `ActiveJob::Base.queue_adapter = :sidekiq`). The existing warning "Job arguments to ExportJob do not serialize to JSON safely" appears on both.

**Cookies and sessions.** Under `load_defaults 7.0`, `cookies_serializer` is `:json`, the signed and encrypted salts are unchanged, and the key generator uses SHA256 on both versions. Sessions therefore roll in either direction. Only adopting `load_defaults 7.1` or later changes the message format, as described above.

**Database**
- **Schema.** `db/schema.rb` is unchanged until someone regenerates it. After that it shows `Schema[8.1]` and sorted columns.
- **Tags.** `tags` is stored as JSON text with default `"[]"` and reads the same on both versions. This is only true if 7.0 is still running the old `serialize :tags, JSON`.
- **Preferences.** `preferences` stays YAML. A legacy value `"---\nexport_heading: Old\n"` deserializes to `{"export_heading"=>"Old"}` on 8.1, and `{}` serializes to `"--- {}\n"` on both.

**Cache.** The app has no persistent cache store, so there are no entries to mix.

**What to ship on 7.0.8.7 first.** These are the "Yes" rows in Section 1, plus these:
- Slug permit, cache clamp and `Date.iso8601(day.to_s)` from Section 2.
- The `.to_s("F")` completion change.
- The `config_for` move of `secrets.yml` and the `.utc` mailer change.
- `where(notebook:)`, `form_with model: false`, `Time.at(...)` for `wait_until`, and `fragments.join`.
- The import transaction rewrite, `note.doi`, the `alias_method` pair and the route split.
- The `stringify_keys` removal, the positional `enum :status` and the Action Text initializer.

**Ship with the bump:** the `serialize ... coder:` change, `show_exceptions = :none`, `polynomially_longer`, the `json < 3` pin and the Rails bump itself.

## 4. Verification log and open questions

**Executed in `upgrade-workspace`**
- **Gem changes report.** `gem-changes rails 7.0.8.7 8.1.0` was run (output was 2034 lines). Its "new framework defaults" section did not appear. I read the defaults from `railties-8.1.0/lib/rails/application/configuration.rb` and from the changelog.
- **Setup.** `upgrade-workspace setup rails 7.0.8.7 8.1.0`:
  - Resolved versions: all Rails components 8.1.0, rack 3.2.7, rack-session 1.0.2, bigdecimal 4.1.3, json 3.1.0 (before my pin), method_source removed, net-imap 0.6.8.
  - Baseline: 46 runs, 325 assertions, 0 failures. Upgraded: boot failed at `config/initializers/action_text.rb:3`.
  - Logs: `/tmp/upgrade-rails-8.1.0/logs` (`tests-baseline.log`, `tests-upgraded.log`, `tests-upgraded-defaults-8.1.log`, `diag-*.log`, `schema-load-*.log`, `bundle-update.log`).
  - These logs were deleted at cleanup.
- **Fix iterations.**
  - **`test`.** `upgrade-workspace test` and `test --defaults 8.1` were run repeatedly, with edits made only in `/tmp/upgrade-rails-8.1.0/upgraded`.
  - **Failures.** I saw the failure for every Section 1 and Section 2 repair above, including the Section 2 errors for `ReadonlyAttributeError`, negative cache expiry and `Date`.
  - **Final result.** The last runs gave 0 failures on both configurations.
- **Probes.** `upgrade-workspace probe` was used for:
  - routes and route names
  - `HashWithIndifferentAccess#stringify_keys`
  - Active Job serialization (TimeWithZone and BigDecimal) and Redis queue payloads via the Sidekiq adapter
  - `to_time` offsets and `Citation[:id]`
  - `serialize` coder behavior on both versions, including legacy YAML
  - config values for cookies, message serializer and cache format under both load_defaults
  - a schema dump comparison and a route diff
- **Baseline check.** I applied the "safe on 7.0" repairs to `baseline` and ran `test --target baseline`: 46 runs, 325 assertions, 0 failures.
- **Cleanup.** The workspace and databases were removed.

**Based on reading source or changelog, not executed**
- The `json 3.1.0` incompatibility was observed, but I did not determine whether it exists outside this sandbox's gem set.
- Rack 3 requirements for custom middleware: the app has none.
- `enqueue_after_transaction_commit`: the probe showed `false` for `CitationEnrichmentJob` in the test environment. I did not test the Sidekiq adapter in production mode, so `request_enrichment` and `schedule_reminder` (which enqueue inside `with_lock`) are unverified against a real Redis failure.
- The system test suite (`bin/rails test:system`) was not run.
- Hash-vs-`ActionController::Parameters` equality, `render json:` escaping and `redirect_to` relative paths: not used in the app, per grep.

**Open questions**
- Is `json 3.1.0` genuinely incompatible with Rails 8.1.0 outside this environment? If not, the pin can be dropped.
- Does production send mail over SMTP? The mail gems remain available, but no delivery method is configured in `config/environments/production.rb`.
- Which Ruby, Puma and Sidekiq versions will production run? Puma 5 and Sidekiq 6.5.12 were not exercised under Rack 3 beyond the tests and a queue push. Puma 5 is old for Rack 3.

Relevant files, all in `/home/user/workspace/repo`:
- `config/initializers/action_text.rb`
- `config/routes.rb`
- `config/application.rb`
- `config/secrets.yml`
- `config/environments/test.rb`
- `app/models/note.rb`
- `app/models/notebook.rb`
- `app/models/import.rb`
- `app/models/export.rb`
- `app/models/user.rb`
- `app/models/citation/provider.rb`
- `app/mailers/digest_mailer.rb`
- `app/jobs/citation_enrichment_job.rb`
- `app/controllers/notes_controller.rb`
- `app/controllers/notebooks_controller.rb`
- `app/views/notes/index.html.erb`
- `app/views/imports/preview.html.erb`
- `app/views/exports/_export.html.erb`
- `test/controllers/citation_enrichments_controller_test.rb`

I haven't implemented any of this. The sections that matter most for your decision are:
- **Rollout order:** most repairs can ship on 7.0.8.7 first. Five have to land with the bump itself.
- **Open `json` question:** the `json < 3` pin may only be needed in the planner's sandbox. Check it against a clean `bundle update`.
- **Not run:** the system test suite (`bin/rails test:system`).

Tell me if you want me to start implementing, and whether to do the 7.0-safe repairs first or everything in one change.