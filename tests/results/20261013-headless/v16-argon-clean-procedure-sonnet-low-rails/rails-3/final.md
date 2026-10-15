Here is the plan from the `maintain-rails:gem-upgrade-planner` agent. I haven't implemented it or changed the working app.

# Upgrade plan: rails 7.0.8.7 to 8.1.0 (Margin Notes)

On a bare bump, 8.1.0 does not boot. After 16 small repairs, the suite passes on the upgraded copy: 46 runs, 340 assertions, 0 failures. That holds with `load_defaults 7.0`, 7.1, 7.2, 8.0 and 8.1. Most repairs are Rails 7.1+ only. The ones that can ship on 7.0.8.7 first are marked "Ships before bump". Applied to a baseline copy, that subset still passed (46 runs, 325 assertions, 0 failures).

## 1. Required changes for the upgrade

### Dependency findings

**D1. `json` 3.1.0 breaks ActiveSupport 8.1.0.**
- **Affected code:** `Gemfile`. Bundler resolves `json 3.1.0` as a new dependency of Rails 8.1.0.
- **What breaks:** `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)` with a positional hash. Any jsonb read then raises `ArgumentError`. This hits `Note#settings`, which backs `store_accessor :settings, :color` at `app/models/note.rb:13`. It showed up as about 30 request, model and mailer failures.
- **Repair:** add `gem "json", "< 3"` to `Gemfile`. It resolved to json 2.7.2. This can't be done before the bump, because `json` isn't a dependency on 7.0.8.7.

**D2. `Rails.application.secrets` is gone, so `config/secrets.yml` is silently ignored.**
- **Affected code:** `config/secrets.yml`, `app/models/citation/provider.rb:13`, and `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **What breaks:** `NoMethodError: undefined method 'secrets'`. In production the failure would be quieter: no provider settings load, so lookups raise `No citation provider is configured`.
- **Repair (ships before bump):**
  - Rename the file to `config/citation_provider.yml`, with the keys directly under `development:`, `test:` and `production:`. Keep the `.to_json` quoting.
  - In `config/application.rb`, add `config.x.citation_provider = config_for(:citation_provider)`.
  - Use `Rails.configuration.x.citation_provider.to_h` in `Citation::Provider#initialize`.
  - Update the three test references.
- **Open point:** `secrets.yml` has no `secret_key_base` entry, so nothing is lost there. In production, `secret_key_base` must come from `ENV["SECRET_KEY_BASE"]` or the credentials.

**D3. Rack stays at 2.2.24.**
- `sidekiq 6.5.12` requires `rack ~> 2.0`, so the Rack 3 changes don't apply under this lock.
- The 8.1.0 `Gemfile.lock` has 25 changes. Notable ones are `rack-session`, `rackup`, `bigdecimal` 4.1.3, `drb`, `securerandom`, `uri`, `useragent`, `webrick` and `action_text-trix` added, and `method_source` removed.
- `bin/rails server` boots on 8.1.0 with Puma 5.6.9. A GET of `/session/new` returned 200.

**D4. The built-in Sidekiq adapter is deprecated.**
- `config/application.rb:24` sets `config.active_job.queue_adapter = :sidekiq`. Rails warns that the built-in adapter will be removed in 8.2 and asks for `sidekiq` 7.3.3 or later.
- Enqueue works today, so 8.1.0 needs no change. The 8.2 upgrade will need Sidekiq 7.3.3+, which also allows Rack 3.

### Application code findings

All of these fail immediately on the bump.

**R1. `config/initializers/action_text.rb:3` fails at boot.** `ActionText::ContentHelper.allowed_tags` is now `nil` by default, so `+` raises `NoMethodError`.
- **Repair (ships before bump):**
  ```ruby
  helper = ActionText::ContentHelper
  inherited = helper.allowed_tags || helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  helper.allowed_tags = inherited + %w[ details summary ]
  ```
- The test at `notes_controller_test.rb:137` passes on both versions.

**R2. `enum status: {...}, _prefix: true` at `app/models/note.rb:10` was removed.**
- **Repair (ships before bump):** `enum :status, { draft: 0, ready: 1 }, prefix: true`.

**R3. `serialize :tags, JSON` at `app/models/note.rb:12` was removed.**
- **Repair (7.1+ only):** `serialize :tags, coder: JSON`. On 7.0.8.7, `coder: JSON` is read as a plain options hash and `Note.new.tags` returns the string `"[]"`.
- **Related:** `app/models/notebook.rb:7` has a bare `serialize :preferences`. It keeps using YAML under `load_defaults 7.0`, but under 8.1 defaults it raises `ArgumentError: missing keyword: :coder`. Use `serialize :preferences, coder: YAML`. Stored data stays byte-identical.

**R4. `alias_attribute :highlight_color, :color` at `app/models/note.rb:14` no longer works for non-attributes.** `color` is a `store_accessor`.
- **Repair (ships before bump):** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. The form needs both.

**R5. `get "/notes", "/journal", to: "notes#index"` at `config/routes.rb:18` was removed.**
- **Repair (ships before bump):** use two lines, `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. This keeps `notes_path` and `journal_path`.
- The route count drops from 67 to 63 because Rails 8.1 removed four Action Mailbox conductor routes. The app's own 36 routes are unchanged.

**R6. `fragments.sum` at `app/models/export.rb:42` no longer sums strings.**
- **Repair (ships before bump):** `finish(fragments.join)`.

**R7. `form_with(model: nil, ...)` at `app/views/notes/index.html.erb:12` now raises.**
- **Repair (ships before bump):** drop `model: nil`.

**R8. `where(notebooks: @notebook)` at `app/controllers/notes_controller.rb:12` changed meaning.** A record value under a table-name key is now treated as a column, so it raises `PG::UndefinedColumn`.
- **Repair (ships before bump):** `where(notebook: @notebook)`.

**R9. `config.action_dispatch.show_exceptions = false` at `config/environments/test.rb:31` is no longer honored.** Exceptions are rescued into 500 or 302 responses, and nine tests failed.
- **Repair (7.1+ only):** `config.action_dispatch.show_exceptions = :none`. On 7.0, `:none` is truthy and would render error pages.

**R10. `wait: :exponentially_longer` at `app/jobs/citation_enrichment_job.rb:7` was removed.**
- **Repair (7.1+ only):** `:polynomially_longer`. It uses the same formula.

**R11. `wait_until: reminder_epoch` at `app/models/note.rb:61` now needs a Time, not an Integer.**
- **Repair (ships before bump):** `wait_until: Time.at(reminder_epoch)`.

**R12. `Import#apply` (`app/models/import.rb:53-61`) no longer rolls back on `return false`.** A non-local `return` now commits. With invalid rows, the import and the valid notes were saved.
- **Repair (ships before bump):**
  ```ruby
  saved = transaction do
    save!
    rows.each { |row| raise ActiveRecord::Rollback unless row.note.save }
    true
  end
  saved || false
  ```

**R13. `citation[:id]` at `app/models/import.rb:68` returns `nil` for a custom primary key.** The receipt CSV shows blank DOIs.
- **Repair (ships before bump):** `citation&.id`.

**R14. `stringify_keys` on a HashWithIndifferentAccess at `app/views/imports/preview.html.erb:22` now converts Integer keys.** `annotations[row.line]` misses, so the preview shows the DOI instead of the annotation.
- **Repair (ships before bump):** use `@import.annotations` without `.stringify_keys`.

**R15. `reminder_at.to_time + 86_400` at `app/models/note.rb:44` now follows the zone's DST rules.** The reminder preview shows `2026-11-01T08:00:00-05:00` instead of `2026-11-01T09:00:00-04:00`. The postponement epoch is unchanged.
- **Repair (ships before bump):** `reminder_at.utc.getlocal(reminder_at.utc_offset) + 86_400`.

**R16. The digest day changes from the UTC day to the reader's local day.** This is in `app/mailers/digest_mailer.rb:7-9`. `DigestsControllerTest` expected "October 05, 2026" and got "October 04, 2026".
- **Repair (ships before bump):** add `requested_at = requested_at.in_time_zone(Time.zone)` after `params.values_at`. This restores UTC-day behavior, which matches the comment above the method.

**R17. The `completion` argument has a new serialized form.** This is in `app/models/user.rb:41`. 8.1 writes a `BigDecimalSerializer` hash instead of `"0.5"`.
- **Repair (ships before bump):** `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`.
- This matters for the rollback hazard in section 3.

## 2. New configuration defaults across intermediate releases

`config/application.rb` has `config.load_defaults 7.0`. Test runs with `--defaults 7.1`, `7.2`, `8.0` and `8.1` on the repaired app all passed (46 runs, 340 assertions). Before the three repairs below, `load_defaults 8.1` produced three errors. All three repairs work on both versions and ship before the bump:

| Default | App impact | Repair |
|---|---|---|
| 7.1: `raise_on_assign_to_attr_readonly = true` | `NotebooksController#update` (`notebooks_controller.rb:40`) permits `:slug`, which is `attr_readonly`, so it raises `ReadonlyAttributeError`. | Remove `:slug` from `permit`. |
| 7.1: `raise_on_invalid_cache_expiration_time = true` | `app/views/exports/_export.html.erb:26` passes a negative `expires_in` once an export expires. | `expires_in: [export.expires_at - Time.current, 0].max`. |
| 7.2: `postgresql_adapter_decode_dates = true` | `Notebook#daily_note_counts` (`notebook.rb:40`) gets a `Date`, and `Date.iso8601(day)` raises `TypeError`. | `Date.iso8601(day.to_s)`. |

Other defaults need care at adoption time:
- **7.1 `cache_format_version = 7.1`:** a 7.0 process reading these entries raises `TypeError: incompatible marshal file format`. Keep the 7.0 format until every process is on 8.1.
- **7.1 `message_serializer = :json_allow_marshal`:** this changes the signed and encrypted message format. Adopt it only after every process is on 8.1.
- **7.1 `default_column_serializer = nil`:** already covered by `coder: YAML` in R3.
- **7.1 headers:** drops `X-Download-Options: noopen`. Nothing needed unless a client depends on it.

Everything else in 7.1 through 8.1 needs no app change. That covers the callback ordering defaults, the `belongs_to` foreign key validation, `strict_freshness`, `Regexp.timeout`, the 8.1 JSON escaping and redirect defaults, and the `yjit` settings. `config.active_support.to_time_preserves_timezone` is deprecated and ignored, which R15 already works around.

## 3. Rollout, rollback, and mixed-version risks

- **Database and schema:** no migrations are needed. Regenerating `db/schema.rb` on 8.1 changes only cosmetic things: the `Schema[8.1]` header, `pg_catalog.plpgsql`, and alphabetical column order. Serialized columns are byte-identical, and old YAML rows read correctly.
- **Cookies and sessions:** under `load_defaults 7.0` with the same `secret_key_base`, a 7.0-issued cookie works on 8.1 and an 8.1-issued cookie works on 7.0. Production must supply `secret_key_base` via env or credentials.
- **Redis cache:** with the 7.0 format (the default under `load_defaults 7.0`), `FileStore` is interoperable in both directions. Production has no explicit `cache_store`, and which store it uses was not confirmed.
- **Sidekiq payloads:**
  - `NoteReminderJob` and `CitationEnrichmentJob` carry only global ids. 7.0 workers ignore the extra keys.
  - `DigestJob` is the exception. Enqueued by 8.1, it contains `BigDecimalSerializer`, and a 7.0 worker raises `DeserializationError`. That is a rollback hazard.
  - With R17 shipped on 7.0 first, 8.1 emits the string form, so a 7.0 worker can read it. This is inferred from payload shapes and was not run.
  - Enqueued by 7.0, `DigestJob` runs fine on 8.1.
  - `ExportJob` is plain Sidekiq and unaffected. Its symbol-key warning is not an upgrade regression.
  - Jobs enqueued after the cutover with a past `wait_until` run immediately.

**Deploy before the bump (7.0.8.7 compatible, verified on baseline):** R1, R2, R4, R5, R6, R7, R8, R11, R12, R13, R14, R15, R16, R17, D2, and the three default-gated repairs (`:slug`, `Date.iso8601(day.to_s)`, the `[..., 0].max` expiry).

**Must wait for the bump:** D1 (`json` pin), R3 (`coder:`), R9 (`show_exceptions = :none`) and R10 (`polynomially_longer`).

## 4. Verification log and open questions

- **Resolved versions on the upgraded copy:** Rails components at 8.1.0, `rack 2.2.24`, `rack-session 1.0.2`, `rackup 1.0.1`, `puma 5.6.9`, `sidekiq 6.5.12`, `redis 4.8.1`, `faraday 1.10.4`, `pagy 8.6.3`, `json 2.7.2` (pinned), `bigdecimal 4.1.3`, `bootsnap 1.26.0`.
- **Executed in `/tmp/upgrade-rails-8.1.0`:**
  - Baseline: 46 runs, 325 assertions, 0 failures.
  - Bare bump: boot failed in `action_text.rb:3`.
  - After the 16 repairs: 46 runs, 340 assertions, 0 failures, including each `--defaults` run.
  - Probes: serializer behavior, Active Job serialization both ways, Sidekiq payload shapes, DST, `Import#apply` transactions, HashWithIndifferentAccess, cache interop, schema diff, server boot, and the cookie cross-read.
  - The logs were deleted at cleanup, so the numbers above are the evidence.
- **Not executed (read from source or output):**
  - Rack 3 behavior, since the lock stays on Rack 2.
  - The 8.2 Sidekiq adapter removal, taken from the warning text.
  - The 7.0 worker reading an 8.1 `DigestJob` after R17.
- **Proposed, not yet run:**
  - A real Redis-backed Sidekiq round trip of `DigestJob` and `NoteReminderJob` between 7.0 and 8.1 workers.
  - The `message_serializer` and `cache_format_version` adoption steps.
  - `bin/rails test:system`, which wasn't run because `test/system/` is empty.
- **Open questions:**
  1. Which cache store does production use, and which processes (web and Sidekiq) share it?
  2. Is the loss of four Action Mailbox conductor routes acceptable? The app doesn't use them.
  3. Should the digest keep the UTC day (the R16 repair) or move to the reader's local day? The code comment documents the UTC day.

## Commentary

The plan suggests two stages. First, ship the "before bump" changes on 7.0.8.7. Then change `Gemfile` to Rails 8.1.0 together with the four bump-only changes (D1, R3, R9, R10).

Do you want me to implement it, and should it be two staged changes or one?