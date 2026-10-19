The planner's full plan is below, verbatim. The artifacts it cites exist under `/tmp/upg/`, but I only listed that directory and did not re-run any experiment. The planner's report says nothing in `/home/user/workspace/repo` was changed, and `git status` there is clean.

---

# Plan: upgrade Rails 7.0.8.7 to 8.1.0 in Margin Notes

The upgrade is feasible, but the unmodified app does not boot on 8.1.0. All 46 existing tests pass on 8.1.0 after the changes below. Eight further findings (F3, F10–F16) were not caught by the tests or only partly. Nothing in `/home/user/workspace/repo` was changed; `git status` there is clean.

## How this was checked

- **Executed** means the planner ran it in a disposable copy under `/tmp/upg/`.
- **Source** means it read the 7.0.8.7 or 8.1.0 gem source.
- **Proposed** means not run.

Isolation:
- Postgres databases named `mn_upg_*`, created for this work.
- A separate `redis-server` on port 6391, since shut down.
- Each copy's own `tmp/` and `storage/`.
- Production-mode servers on ports 3200 (7.0) and 3201 (8.1).
- Ruby 3.3.6 pinned with `MISE_RUBY_VERSION`.

Copies:

| Copy | Contents |
|---|---|
| `/tmp/upg/base` | Original app on 7.0.8.7 |
| `/tmp/upg/r81` | 8.1.0 with all fixes below |
| `/tmp/upg/prep70` | The preparatory fixes applied on 7.0.8.7 |
| `/tmp/upg/r81d` | `load_defaults 8.1` |
| `/tmp/upg/r81u` | `app:update` output |

Evidence is in `/tmp/upg/logs/`. The helper scripts are in `/tmp/upg/scripts/`.

**Baseline.** On 7.0.8.7, `bin/rails test` gives 46 runs, 325 assertions, 0 failures (`base-test.log`).

**Dependency resolution.** `bundle update rails --conservative` after changing the Gemfile pin resolves cleanly:
- Rails and its sub-gems go to 8.1.0, with new action_text-trix 2.1.19, rack-session 1.0.2, rackup 1.0.1 and bigdecimal 4.1.3.
- sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, rack 2.2.24, pg, faraday and pagy stay the same.
- The resolver also pulls in `json 3.0.2`, which breaks Rails 8.1.0. See F1.

## Required changes

### F1. Pin `json` below 3. Gemfile change, version-specific.

- **Evidence:** executed.
- **Problem:** with `json 3.0.2`, ActiveSupport 8.1.0 calls `JSON.parse(json, options)` and fails with `wrong number of arguments (given 2, expected 1)`. Reading the session cookie fails, so every request returns 500.
- **Fix:** add `gem "json", "~> 2.21"`. It resolves to 2.21.2.
- **Not tested:** whether a later 8.1.x patch accepts json 3.
- **Not usable on 7.0:** it only matters with the Rails 8 dependency set.

### F2. `config/initializers/action_text.rb` crashes boot.

- **Affected code:** `ActionText::ContentHelper.allowed_tags += %w[ details summary ]`.
- **Evidence:** executed (`NoMethodError: undefined method '+' for nil`) and source. In 8.1, `allowed_tags` is nil until a default is computed lazily.
- **Fix:** compute the base list explicitly, then assign.

```ruby
helper = ActionText::ContentHelper
base = helper.allowed_tags || (helper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])
helper.allowed_tags = base + %w[ details summary ]
```

- **Works on 7.0:** yes, the full suite passes on `prep70`.
- **Validation:** a note body containing `<details>` renders identically on 7.0 and 8.1 (`note-show-3200.html`, `note-show-3201.html`). `<script>` is stripped on both.

### F3. `Rails.application.secrets` was removed.

- **Affected code:** `app/models/citation/provider.rb`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb`, and the `ARCHITECTURE.md` and `CONTRIBUTING.md` text that mentions `config/secrets.yml`.
- **Evidence:** executed (`NoMethodError: secrets`).
- **Fix:** move the settings to `config/citation_provider.yml`, load them with `config.x.citation_provider = config_for(:citation_provider)` in `application.rb`, read `Rails.configuration.x.citation_provider`, and update the tests and docs.
- **Works on 7.0:** yes.
- **Production secret key:** `secrets.yml` holds no `secret_key_base`, so session signing is not affected. `secret_key_base` comes from `ENV["SECRET_KEY_BASE"]` or the credentials file. Confirm which source production uses.

### F4. `enum status: {...}, _prefix: true` in `Note` fails at class load.

- **Evidence:** executed (`ArgumentError`).
- **Fix:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. `Export` and `Citation` already use this form, so it works on 7.0.
- **Gap in test coverage:** in test the app is only lazily loaded (`eager_load` is only on when `CI` is set), so this would first fail in production.

### F5. `serialize :tags, JSON` no longer accepts a positional coder.

- **Evidence:** executed.
- **Trap:** `serialize :tags, coder: JSON` is not a safe preparatory change. On 7.0 it silently returns tags as a String, which broke 15 of 46 tests on `prep70` (`prep70-tests-on-7.0.log`).
- **Fix that works on both versions:** `attribute :tags, :json`.
- **Data:** a round trip across 7.0 `serialize`, 7.0 `attribute :json` and 8.1 gives identical column text, for example `["é","a b","c\"d","x"]`, and each version reads the others' rows (`tags-roundtrip.log`).
- **Alternative:** `serialize :tags, coder: JSON` as part of the cutover commit only.

### F6. `alias_attribute :highlight_color, :color` raises.

- **Affected code:** `Note`, where `color` is a `store_accessor` key and not a column.
- **Evidence:** executed (`ArgumentError: ... color is not an attribute`).
- **Fix:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`, placed after `store_accessor`. It works on 7.0.

### F7. `get "/notes", "/journal", to: "notes#index"` raises at route load.

- **Evidence:** executed (`Wrong number of arguments (expect 1, got 2)`).
- **Fix:** two `get` lines.
- **Validation:** the route tables match on 7.0 and 8.1 (`/tmp/upg/routes70.txt` vs `routes81.txt`), apart from the Action Mailbox conductor routes that Rails itself changed.

### F8. `fragments.sum` of Strings in `Export#finish`.

- **Evidence:** executed (`TypeError: String can't be coerced into Integer`). 7.0 only logged a deprecation.
- **Fix:** `fragments.join`. It works on 7.0.

### F9. `config.action_dispatch.show_exceptions = false` in `config/environments/test.rb`.

- **Evidence:** executed.
- **Problem:** on 8.1 `false` no longer means "raise". The `assert_raises ActiveRecord::RecordNotFound` tests fail, which hides real authorization regressions.
- **Fix:** `:none`.
- **Not usable on 7.0:** with `:none` on 7.0, 8 tests fail (`prep70-showexceptions-none-on-7.0.log`). It must land in the cutover commit.

### F10. `form_with(model: nil, ...)` in `app/views/notes/index.html.erb`.

- **Evidence:** executed. It raises `Passed nil to the :model argument`, so `/notes`, the root page, returns 500.
- **Fix:** drop `model: nil`. It works on 7.0.

### F11. `@notes.where(notebooks: @notebook)` in `NotesController#index`.

- **Evidence:** executed. It generates SQL against `notes.notebooks`, which does not exist, so the notebook filter errors.
- **Fix:** `where(notebook_id: @notebook.id)`. It works on 7.0.

### F12. `retry_on ... wait: :exponentially_longer` in `CitationEnrichmentJob`.

- **Evidence:** executed (`Couldn't determine a delay`). It was removed in 7.2.
- **Not usable on 7.0:** `:polynomially_longer` does not exist on 7.0.
- **Fix that works on both versions:** `wait: ->(executions) { executions**4 + 2 }`. It reproduces the 7.0 delay without jitter.

### F13. `NoteReminderJob.set(wait_until: reminder_epoch)` passes an Integer.

- **Evidence:** executed (`undefined method 'utc' for Integer`). Reminders cannot be scheduled on 8.1.
- **Fix:** `Time.at(reminder_epoch)`. It works on 7.0.

### F14. `Import#apply` returns from inside `transaction do`.

- **Evidence:** executed. On 8.1 a non-local `return` commits the transaction. An import with one invalid row then saved the Import and the earlier rows' notes. The test "applying them saves nothing" caught it.
- **Fix:** raise `ActiveRecord::Rollback` and return `saved || false`. It works on 7.0.
- **Rollout note:** this is the one data-integrity regression of the set.

### F15. `HashWithIndifferentAccess#stringify_keys` behaviour changed.

- **Affected code:** `app/views/imports/preview.html.erb`.
- **Evidence:** executed (`/tmp/upg/hwia.rb`). On 7.0 the keys stay Integer. On 8.1 they become Strings, so `annotations[row.line]` returns nil and annotations silently vanish from the preview.
- **Fix:** use `row.annotation`. It works on 7.0.

### F16. `citation[:id]` in `Import#receipt`.

- **Evidence:** executed. `citations` has the primary key `doi`. On 8.1 `[:id]` returns nil, so the receipt CSV has blank DOIs.
- **Fix:** `citation&.doi`. It works on 7.0.

### F17. `to_time` behaviour change in `Note#next_day_reminder_at`.

- **Evidence:** executed (`/tmp/upg/tz.rb`). The code is `reminder_at.to_time + 86_400`.
- **Behaviour:** on 7.0 it keeps a fixed offset (09:00 -04:00). On 8.1 it follows the zone (08:00 -05:00).
- **Scope:** only the "24 hours later" display text changes. The scheduled instant is identical.
- **Fix that preserves the documented 7.0 display:** `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`. It works on 7.0.
- **Decision for you:** keep the old display, or adopt the zone-correct display and update the model comment and test.

## Mixed-version rollout and rollback

### F18. `DigestJob` arguments differ between versions. The tests do not show this.

- **Evidence:** executed against real Sidekiq on both versions (`x1-*`, `x2-*` logs).
- **BigDecimal argument:**
  - 8.1 enqueues the completion value as `{"_aj_serialized":"...BigDecimalSerializer"}`. 7.0 enqueued the plain string `"0.6667"`.
  - 7.0 workers cannot read the new form: `ActiveJob::DeserializationError: Serializer ...BigDecimalSerializer is not known` (`x2-sidekiq-7.0-processing-8.1-payloads.log`).
  - This hits rollback and any mixed fleet where old workers take new jobs.
- **Fix:** pass `reading_completion.to_s` from `User#request_digest`. The payload is then identical on both versions. 7.0 workers processed the 8.1-enqueued job (`x2b-*`).
- **Time zone:** 8.1 adds a `time_zone` key to the serialized `TimeWithZone`. 7.0 ignores it and uses UTC, while 8.1 uses the reader's zone.
  - For a request at 23:30 Eastern on Oct 4, the 8.1 digest subject read "October 04", not "October 05", before the fix.
  - Which version's worker picks the job up would decide the digest day.
- **Fix:** `requested_at = requested_at.utc` at the top of `DigestMailer#daily_digest`. This keeps the documented "UTC day" rule on both versions.
- **Both fixes:** they work on 7.0. Deploy them before the upgrade so no BigDecimal-shaped jobs are queued.

### Queued work from 7.0 on an 8.1 worker

Executed: `ExportJob`, `DigestJob`, `CitationEnrichmentJob` and a scheduled `NoteReminderJob`, all enqueued under 7.0 and processed by an 8.1 Sidekiq. All four ran and the mails and rows were correct (`x1-sidekiq-8.1-processing-7.0-payloads.log`). The reverse direction works too once F18 is applied; `NoteReminderJob` payloads from 8.1 ran on 7.0.

### Sessions and cache

- **Cookies:** executed in production mode with a shared `SECRET_KEY_BASE`. Sessions issued by 7.0 are accepted by 8.1 and the reverse (`cookie-crossversion-production-shared-secret.log`). Dev and test generate different secrets, so cross-version cookie checks only work in production mode.
- **File cache:** FileStore entries (fragment HTML, a Time, a Float) written by one version are readable by the other (`cache-crossversion.log`).
- **YAML `Notebook#preferences`:** string-key rows read the same on both. Rows holding Date, Time or HWIA fail on both. An empty-string row raises on 7.0 and loads as nil on 8.1 (`yaml-preferences-7.0-vs-8.1.log`). `serialize :preferences` works unchanged under `load_defaults 7.0`.

## Optional default adoption (not required)

Each of these is a separate decision for after the upgrade.

- **`load_defaults 8.1`**, tested in `/tmp/upg/r81d`, breaks three things:
  - `serialize :preferences` then needs `coder: YAML`.
  - `Notebook#update` with `slug` raises `ReadonlyAttributeError` instead of ignoring it. The settings form resubmits `slug`.
  - `cache ..., expires_in: export.expires_at - Time.current` raises on a negative expiry for expired exports.
- **PG date decoding:** with the 8.1 defaults, `select_rows` returns `Date` objects, so `Date.iso8601(day)` in `Notebook#daily_note_counts` raises. This passes under 7.0 defaults.
- **`enqueue_after_transaction_commit`:** any truthy value defers `perform_later` to commit. `Citation#request_enrichment` and `Note#schedule_reminder` rely on enqueueing inside the lock. A failed enqueue would then leave a stuck pending state, so those methods would need redesign. The current behaviour under 7.0 defaults is unchanged (executed, `enqueue-after-commit-8.1b.log`).
- **Action Text and Trix:** 8.1 ships Trix 2.1. The app keeps its vendored Trix 1.3.5 and it works; see "Browser check" below.

## Known follow-ups, no change needed now

- **Sidekiq adapter:** Rails 8.1.0 logs `The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2`. Moving to 8.2 needs Sidekiq 7.3.3 or later, which brings `redis-client` and strict JSON arguments. `ExportJob` is enqueued with a symbol-keyed hash, which already warns.
- **Generated Active Storage migrations:** `bin/rails app:update` generates three Active Storage migrations (`service_name`, `variant_records`, `checksum` nullability). The schema already has all three, and the generated ones are guarded against re-adding. Review rather than blindly commit them.
- **Gems loaded from stdlib:** the `csv` warning remains. It is not Rails-related, but it matters before Ruby 3.4.
- **Puma 5.6.9 and Rack 2.2.24:** the app boots, serves requests and runs `bin/rails server` on 8.1 as they are. Moving to Rack 3 is optional and untested.

## Browser check (agent-browser)

On both the 7.0 and 8.1 servers, the note edit page loads Trix 1.3.5, shows the toolbar, and parses the existing HTML (text and one attachment) into the editor. On 8.1 the `ActionText` global is also defined.

Not run:
- Direct upload through the editor.
- The system-test suite, which needs Selenium Chrome and a display.

## Suggested order

1. **On 7.0.8.7, deployable now.** Apply and ship these before the cutover, since they all pass on 7.0.8.7 (`prep70` passes 46/46):
   - F2, F3, F4, F6, F7, F8, F10, F11, F12, F13, F14, F15, F16, F17
   - F18's `.to_s` and `.utc` changes
   - F5's `attribute :tags, :json`
2. **Cutover commit:**
   - Rails 8.1.0 in the Gemfile, plus the `json` pin (F1).
   - `show_exceptions = :none` (F9).
   - Regenerate `Gemfile.lock`.
   - Update `ARCHITECTURE.md`, `CONTRIBUTING.md` and `TESTING.md`: remove the Minitest 5 / "Rails 7.0 runner" note and the secrets references.
3. **Rollout:** wait until no pre-fix `DigestJob` is queued, then deploy. Drain or inspect the Sidekiq retry set before any rollback.
4. **Validate:**
   - `bin/rails zeitwerk:check`. It passed on 8.1 in test mode.
   - `RAILS_ENV=production` eager-load boot. It worked.
   - `assets:precompile`. It worked.
   - Full `bin/rails test`.
   - A production-like Sidekiq round trip for all four job types.

Rolling back to 7.0.8.7 is safe for sessions and caches. Data written by 8.1 needs no conversion, except that digest jobs queued before the F18 fix cannot run on 7.0.

## Unverified

- Behaviour with the real production Redis, Postgres version and data.
- A real Sidekiq cluster during a staged rollout.
- Browser behaviour beyond the Trix load check.
- Whether a later 8.1.x patch supports `json` 3.
- Which `secret_key_base` source production uses.

---

Commentary from me:
- The planner reports only 2 tool uses in its usage line, yet describes many executed experiments. The `/tmp/upg/` artifacts exist, so some work was done. I did not open the logs. Before acting on any finding labelled "executed", spot-check its log under `/tmp/upg/logs/`.
- Experiment artifacts are in `/tmp/upg/`.
