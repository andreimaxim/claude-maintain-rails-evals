Here is the planner's full plan for upgrading rails from 7.0.8.7 to 8.1.0. I haven't changed the working app.

# Upgrade plan: rails 7.0.8.7 to 8.1.0 (Margin Notes)

The upgrade is feasible. It needs about 16 required code and config changes. Eight of them fail loudly at boot or in tests. Four break behaviour silently or only on some paths. Two exist only to keep a mixed 7.0 and 8.1 fleet working.

The planner ran `bin/rails routes` once in the real checkout, which wrote to `log/development.log`. `git status` is still clean. All experiments ran in disposable copies under `/tmp/exp`, each with its own Postgres database and Redis DB number.

## Experiment setup

- **Baseline:** a copy of the repo on 7.0.8.7 passed 46 runs, 325 assertions, 0 failures. Log: `/tmp/out/baseline.log`.
- **Upgraded copy:** `/tmp/exp/app`. The Gemfile was changed to `rails 8.1.0` and `bundle update rails --conservative` was run.
- **Resolved dependencies:** rails 8.1.0, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, faraday 1.10.4, pagy 8.6.3, turbo-rails 2.0.12, sprockets-rails 3.5.2, concurrent-ruby 1.3.4. Ruby is 3.3.6.
- **Other tools:** rails-dom-testing moved from 2.0 to 2.2, and json had to be pinned (see finding 1).
- **Isolation:** Postgres databases `mn_exp_*` and Redis DBs 9 to 14.
- **Result:** with all repairs below, the upgraded copy passes 46 runs, 340 assertions, 0 failures. `zeitwerk:check` passes. Production boot with eager load and `assets:precompile` succeed.
- **Not run:** the system tests (`bin/rails test:system`), because Chrome and Selenium are not set up here. The CSS and JS (Trix, actiontext.css) were also not exercised in a browser.
- **Not bisected:** only the 8.1.0 endpoint was tested. 7.1, 7.2 and 8.0 were not booted separately. Each breakage is attributed to a release from the changelog index (`/tmp/out/changes.txt`), not from a per-release run.
- **Artifacts:**
  - the full repair diff: `/tmp/out/upgrade.diff`
  - upgrade run logs: `/tmp/out/up1.log` to `up12.log`
  - bundle output: `/tmp/out/bundle.log`
  - changelog index: `/tmp/out/changes.txt`
  - load_defaults 8.1 run: `/tmp/out/d81.log` and `d81b.log`
  - Sidekiq cross-version scripts: `/tmp/out/rt1.rb`, `rt2.rb`, `rt3.rb`
  - Sidekiq payloads: `/tmp/out/rt1_old.txt` and `rt1_new.txt`
  - data read-back script and outputs: `/tmp/out/d1.rb`, `d1_old.txt`, `d1_app.txt`
  - Sidekiq worker log from the live run: `/tmp/out/sidekiq.log`
- **7.0.8.7 compatibility:** `/tmp/exp/prep` is the current-version copy with only the repairs that also work on 7.0. It passed 46 runs, 325 assertions, 0 failures on 7.0.8.7 (`/tmp/out/prep.log`).
- **Live smoke test:** the upgraded app ran under Puma 5.6.9 with a real Sidekiq 6.5.12 worker. Sign-in with CSRF, note create, export request, export download, digest, citation enrichment and reminder all worked. Export, digest and enrichment jobs ran on the worker.

## Required changes

"Also works on 7.0" means the repair was tested in `/tmp/exp/prep` on 7.0.8.7.

### 1. json 3.1.0 is incompatible with activesupport 8.1.0

- **Where:** `Gemfile.lock` pins json 3.1.0.
- **What happens:** `ActiveRecord::Coders::JSON` calls `ActiveSupport::JSON.decode`, which calls `::JSON.parse(json, options)` with a positional hash. That raises `ArgumentError: wrong number of arguments (given 2, expected 1)` for any read of the JSON-serialized `Note#tags` (`/tmp/out/up5.log`).
- **Repair:** add `gem "json", "~> 2.9"` (resolved to 2.21.2). Only 2.x was tried, not a later 8.1.x patch release, so recheck against the newest 8.1.x before finalising.
- **Also works on 7.0:** untested; the pin is only needed for 8.1.
- **Validation:** a model test that creates a note with `tag_list: "a, b"`, reloads it and asserts `tags == ["a", "b"]`. It fails with json 3.1.0 and passes with 2.x. The control is notes with `tags` of `[]`, which are unchanged.

### 2. `config/initializers/action_text.rb` fails at boot

- **What happens:** `ActionText::ContentHelper.allowed_tags += ...` raises `undefined method '+' for nil`, because `allowed_tags` is now nil by default.
- **Repair:** assign the full list explicitly:
  ```ruby
  helper = ActionText::ContentHelper
  helper.allowed_tags = (helper.allowed_tags || (helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])).to_a + %w[ details summary ]
  ```
  Setting only the two extra tags would drop every default tag.
- **Also works on 7.0:** yes.
- **Executed check:** the same rich-text body was read under 7.0.8.7 and under 8.1.0 (`/tmp/out/d1_old.txt` vs `d1_app.txt`). `to_plain_text`, rendered HTML, `details`/`summary` and script and `onerror` stripping are identical. The sanitizer stays `Rails::HTML4::SafeListSanitizer`.
- **Validation:** boot the app, then render a note whose body contains `<details><summary>S</summary>x</details>` and `<script>`. Assert the `details` tag is kept and the `script` is stripped. The control is a plain `<strong>` body.

### 3. `Note` model definitions raise on load

Each of these makes every `Note` load fail with an `ArgumentError`.

- **`enum status: {...}, _prefix: true`:** the keyword form was removed. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. It generates the same `status_draft?` methods. Also works on 7.0.
- **`serialize :tags, JSON`:** the positional coder was removed. Use `serialize :tags, coder: JSON`. This works on 7.1 and later only. On 7.0 it fails, so it cannot be a preparatory change. Stored data is unchanged: the column is still JSON text.
- **`alias_attribute :highlight_color, :color`:** `color` is a store accessor, not an attribute, so it now raises `Note model aliases 'color', but 'color' is not an attribute`. Use `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. The form field `note[highlight_color]`, the stored key `settings["color"]` and the validation on `color` are unchanged. Also works on 7.0.
- **Validation:** the existing notes request tests cover create with `highlight_color: "green"` and update with `"blue"`. Add a model test asserting `Note.new(highlight_color: "pink").settings == {"color" => "pink"}`. The control is an existing `settings` JSON written before the upgrade, which reads back identically (verified).

### 4. Multi-path route raises at boot

- **Where:** `get "/notes", "/journal", to: "notes#index"` in `config/routes.rb`.
- **What happens:** `ArgumentError: Wrong number of arguments (expect 1, got 2)`.
- **Repair:** two lines, `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. The `notes` and `journal` route names are unchanged (checked with `rails routes`). Also works on 7.0.
- **Validation:** the existing test that requests both `/notes` and `/journal` and compares the lists.

### 5. `Rails.application.secrets` is gone

- **Where:** `Citation::Provider` and `config/secrets.yml`.
- **What happens:** `NoMethodError: undefined method 'secrets' for MarginNotes::Application`, so citation enrichment is dead.
- **Repair:**
  - Rename `config/secrets.yml` to `config/citation_provider.yml` and drop the top-level `citation_provider:` key.
  - Add `config.x.citation_provider = config_for(:citation_provider)` to `config/application.rb`.
  - Have the provider read `Rails.configuration.x.citation_provider.to_h`.
  - Update the test helper to set `Rails.configuration.x.citation_provider`.
- **Rollout:** this keeps the same environment variables. Check that production `CITATION_PROVIDER_*` variables are still set. Also works on 7.0.
- **Validation:** the existing test asserting credentials reach the server unchanged (basic-auth header). The control is a provider with a blank URL, which still gives "No citation provider is configured".

### 6. `retry_on wait: :exponentially_longer` was removed

- **Where:** `CitationEnrichmentJob`.
- **What happens:** `RuntimeError: Couldn't determine a delay based on :exponentially_longer` when enqueue-time retry is triggered.
- **Repair:** use `:polynomially_longer`. The delay formula is the same. It exists on 7.1 and later only, so it is not a preparatory change for 7.0.
- **Validation:** the existing test where the provider stays unavailable, which asserts the failure is recorded after 3 attempts. The control is a successful lookup.

### 7. `Enumerable#sum` over strings in `Export#generate`

- **What happens:** `fragments.sum` raises `TypeError: String can't be coerced into Integer`. No export can complete.
- **Repair:** use `fragments.join`, which produces the same string. Also works on 7.0, and it removes the 7.0 deprecation warning.
- **Validation:** the existing export download test (the exported Markdown body). The control is a cancelled export, which writes no file.

### 8. `form_with(model: nil, ...)` in `notes/index.html.erb`

- **What happens:** `ArgumentError: Passed nil to the :model argument`, so the notes list returns 500.
- **Repair:** drop `model: nil`. The generated search form is the same. Also works on 7.0.
- **Validation:** the existing test for the unbound search form (`form[role=search][action="/notes"][method=get]`).

### 9. `where(notebooks: @notebook)` in `NotesController#index`

- **What happens:** `PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering by notebook raises. It worked on 7.0 only through the table-name interpretation of the key.
- **Repair:** `where(notebook: @notebook)`. Also works on 7.0.
- **Validation:** the existing "filters by notebook, status, and title" test. The control is an unfiltered list.

### 10. `wait_until:` now needs a Time

- **Where:** `NoteReminderJob.set(wait_until: reminder_epoch)` in `Note#schedule_reminder`.
- **What happens:** `NoMethodError: undefined method 'utc' for an instance of Integer`, so no reminder can be scheduled.
- **Repair:** `Time.at(reminder_epoch)`. Also works on 7.0. The queued payload then carries `scheduled_at` as an ISO time, and the Sidekiq `schedule` score is unchanged.
- **Validation:** the reminder request test asserts the enqueued job's `:at` equals the epoch for 9:00 Eastern. The control is a postponement, which replaces the job.

### 11. Test environment `show_exceptions = false`

- **Where:** `config/environments/test.rb`.
- **What happens:** `false` is no longer treated as `:none`. Eight "another reader's record cannot be reached" tests showed `ActiveRecord::RecordNotFound expected but nothing was raised`. These are tests of ownership scoping, so they are important.
- **Repair:** set it to `:none`. This is not valid on 7.0, where a symbol is truthy and would enable exception pages. Make this change in the upgrade commit, not before.

### 12. Silent: `HashWithIndifferentAccess#stringify_keys` now converts integer keys

- **Where:** `imports/preview.html.erb` does `@import.annotations.stringify_keys` and then `annotations[row.line]` with an Integer key.
- **What happens:** the lookup returns nil, so the import preview silently omits every annotation. No error is raised.
- **Repair:** drop `.stringify_keys`. The hash already has Integer keys, and the lookup works on both versions. Checked on 7.0.8.7 and 8.1.0 (`/tmp/out/hw.rb`). Also works on 7.0.
- **Validation:** an import test where line 2's annotation is "Read ..." and the preview must show it in a `dd` under `#line_2`. The existing test fails without the repair. The control is a row with no annotation, which shows no Annotation heading.

### 13. Silent data bug: `Import#apply` commits on `return` inside `transaction`

- **What happens:** `return false unless row.note.save` inside `transaction do` now commits instead of rolling back. Applying a CSV with one invalid row saved the Import and the earlier rows. The existing test showed `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]`.
- **Why the 7.1 default is not the cause:** the planner did not isolate which setting or release causes this. It happens under `load_defaults 7.0`, so adopting or skipping the 7.1 default `commit_transaction_on_non_local_return` does not control it.
- **Repair:**
  ```ruby
  saved = transaction do
    save!
    rows.all? { |row| row.note.save } || raise(ActiveRecord::Rollback)
  end
  saved == true
  ```
  Create (new import and new citations) still works, and a failed run leaves nothing behind.
- **Also works on 7.0:** yes.
- **Validation:** import a CSV where row 2 is valid and row 3 has an invalid DOI. Assert `Import.count`, `Note.count` and `Citation.count` are unchanged and the response is 422. Fails without the repair, passes with it. The control is an all-valid CSV that imports every row once.
- **Rollout:** no data format is involved. If a bad import was applied after deploying without this repair, partial imports would exist. Ship this change with the upgrade at the latest.

### 14. Silent: `citation[:id]` returns nil for a string primary key

- **Where:** `Import#receipt`, on a table whose primary key is `doi`.
- **What happens:** the CSV receipt's DOI column is blank for every row. The test showed `On idleness,` where `On idleness,10.1000/Essays.1` was expected.
- **Repair:** use `citation&.doi`. Also works on 7.0.
- **Validation:** the existing receipt assertion. The control is a note with no citation, which stays blank.

### 15. Silent: ActiveJob now keeps the time zone, so the digest covers the reader's local day

- **Where:** `DigestMailer` and `User#request_digest`.
- **What happens:** `requested_at` is now a `TimeWithZone` serialized with a `time_zone` key and deserialized in the reader's zone. The documented behaviour is the UTC day. A reader in US Eastern who requests at 2026-10-04 23:30 local (2026-10-05 03:30 UTC) got "October 04, 2026" instead of "October 05, 2026". The `all_day` filter also covers the wrong 24 hours.
- **Repair:** add `requested_at = requested_at.utc` at the start of `DigestMailer#daily_digest`. A 7.0 payload (no `time_zone` key) still works. Also works on 7.0.
- **Validation:** the existing digest test, which sets an Eastern reader and expects the October 05 subject and the Bacon note. The control is a UTC reader, who gets the same day either way.

### 16. Mixed-version rollout: `BigDecimal` job arguments

- **What happens:** 7.0 enqueued `reading_completion` as the bare string `"0.0"`. 8.1 enqueues `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.0"}`. The 8.0 changelog removed the old primitive serializer, so this is now always on, even under `load_defaults 7.0`.
- **Executed check:** jobs were run from the raw Sidekiq payloads. An 8.1 worker ran 7.0-enqueued payloads fine (reminder, digest, enrichment). A 7.0 worker running an 8.1-enqueued `DigestJob` failed with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. Under real Sidekiq that job would retry and keep failing until an 8.1 worker takes it. The same applies on rollback to 7.0 for already-queued 8.1 jobs.
- **Repair (preparatory):** `DigestJob.perform_later(self, requested_at, reading_completion.to_s("F"))` in `User#request_digest`. `DigestMailer` already does `BigDecimal(params[:completion])`. On both 7.0.8.7 and 8.1.0 the payload is then the plain string `"0.0"`. Deploy this on the current version first. Full suite is green on both copies.
- **Other jobs:** the other payloads (`NoteReminderJob`, `CitationEnrichmentJob`) were consumed by a 7.0 worker correctly. 7.0 ignores the extra `time_zone` and `scheduled_at` keys. The native `ExportJob` is unchanged.

## Test-suite notes

- `rails-dom-testing` stays at 2.2, and no behaviour change was found in the application's selectors. A first attempt to change the import selectors was wrong and was reverted. The real cause was finding 12.
- `bin/rails test` prints a Sidekiq warning about non-JSON-safe `ExportJob` arguments (it passes a Hash with symbol keys). That warning exists today and is not an upgrade requirement. Sidekiq 7 would reject it.

## Optional default adoption (`load_defaults 7.0` stays valid)

The summary lists 7.1, 7.2 and 8.0 defaults. It lists no new 8.1 defaults. The application keeps the old value for all of them now, because it does not set them. The planner set `load_defaults 8.1` in `/tmp/exp/d81` to see what adopting them all would do. With the repairs above, the first run failed to load `Notebook` and, after one fix, three tests still failed (`/tmp/out/d81.log`, `d81b.log`).

**7.1 defaults**
- `serialize :preferences` has no coder, because `default_column_serializer` becomes nil. It raises `missing keyword: :coder`. Use `serialize :preferences, coder: YAML`, which is 7.1 and later only. Existing YAML text is unchanged.
- `raise_on_assign_to_attr_readonly = true` makes `Notebook#update` raise `ActiveRecord::ReadonlyAttributeError: slug`. The settings form resubmits the slug and `notebook_params` permits it. To adopt, stop permitting `:slug` and remove the hidden field.
- `raise_on_invalid_cache_expiration_time = true` raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0` on the exports page. The cause is `cache ..., expires_in: export.expires_at - Time.current` for an expired export. Clamp it with `[..., 0].max` or set an explicit expiry, and expect the same page to break in production otherwise.
- `commit_transaction_on_non_local_return`: irrelevant once finding 13 is repaired.
- `generate_secure_token_on`, `belongs_to_required_validates_foreign_key` and `before_committed_on_all_records`: no visible effect on this application.
- `sanitizer_vendor` (Action Text and Action View) becomes HTML5. Not tested; the existing sanitizer behaviour in finding 2 was verified on HTML4 only. Check rich-text output again if adopted.
- `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata` and `marshalling_format_version 7.1`: they affect signed values and caches. This app uses cookie sessions and no cache store. Not tested. For a rolling deploy, change them in a second deploy after all servers are on 7.1 or later.
- The encryption, sqlite3 and query-log defaults don't apply. The app has no encrypted attributes and uses PostgreSQL.

**7.2 defaults**
- `postgresql_adapter_decode_dates = true` makes `Notebook#daily_note_counts` fail with `TypeError: no implicit conversion of Date into String`, because `select_rows` now returns `Date` objects and the code calls `Date.iso8601` on them. To adopt, remove that conversion.
- `enqueue_after_transaction_commit`: in 8.1 it is a boolean that stays `false` even under `load_defaults 8.1`. A failed enqueue with Redis unreachable was checked. `Citation#request_enrichment` raises `Redis::CannotConnectError` and leaves `enrichment_status` nil, and `Note#schedule_reminder` also raises, in both the 7.0-defaults and 8.1-defaults copies (7.0 itself has no such flag).
- `validate_migration_timestamps`: the migration timestamps (2026-10-11) pass.
- `web_image_content_types`: no variants are used. `yjit = true`: memory note only.

**8.0 defaults**
- `to_time_preserves_timezone`: the 7.0 default (`true`) is deprecated in 8.1 and ignored. Independently of load_defaults, `Note#next_day_reminder_at` changed. For 9:00 EDT on 31 Oct, the old value displayed `2026-11-01T09:00:00-04:00` and the new one `08:00:00-05:00`. Both are the same instant. The reminder epoch and the job time do not change, only the displayed label in `#next_day_reminder`. The planner repaired it to keep the old label with `Time.at(reminder_epoch + 86_400).localtime(reminder_at.utc_offset)`. Also works on 7.0. The alternative of accepting the new label (`reminder_at + 24.hours`) shows the true local time, and would need the comment and test changed. The planner recommends the explicit repair, because the code comment and test state the offset is meant to be kept.
- `strict_freshness = true`: the download action calls `stale?(etag:, last_modified:)` after the ownership and expiry checks. All 46 tests passed with it on. A request with only `If-Modified-Since` was not sent.

## Other observations (not required)

- Production boot logs `Generating image variants require the image_processing gem`. 7.0 was not booted to compare. If no variants are used, set `config.active_storage.variant_processor = :disabled`.
- Sidekiq 6.5.12 and redis 4.8.1 work with Rails 8.1.0 on the real worker that was run. Redis prints "Redis#sadd will always return an Integer in Redis 5.0.0" on every digest request, and the app would need `sadd?` when moving to redis 5.
- Rack stays at 2.2.24 and Puma at 5.6.9 on 8.1, and both worked under the live smoke test.
- Ruby 3.3.6 prints a csv gem warning (it stops being a default gem in 3.4). That exists today.

## Rollout and rollback

1. **On 7.0.8.7 first (one deploy):** findings 2, 3 (enum and alias only), 4, 5, 7, 8, 9, 10, 12, 13, 14, 15, 16, and the explicit `next_day_reminder_at`. All were tested together on 7.0.8.7. No stored data changes.
2. **Upgrade commit:** the Gemfile (rails 8.1.0 and json `~> 2.9`), `serialize :tags, coder: JSON`, `:polynomially_longer`, and `show_exceptions = :none`.
3. **Mixed fleet:** a 7.0 worker handles reminder and enrichment jobs enqueued by 8.1. The digest job is safe only after step 1's string change. An 8.1 worker handles every 7.0-queued job tested (`/tmp/out/rt2.rb`).
4. **Stored data:** the same rows (YAML `preferences`, JSON `tags`, `settings` JSON, rich text, attached blobs) read identically on 8.1 (`/tmp/out/d1_old.txt` vs `d1_app.txt`). Sessions stay valid because the cookie serializer and digest settings are unchanged at `load_defaults 7.0`. A session cookie across versions was not tested.
5. **Rollback:** going back to 7.0 is safe for data. The remaining risk is any `DigestJob` already queued by an 8.1 server before step 1, so drain or delete those.

## Verification status

- **Executed:** everything marked as run above, including the baseline, the full upgraded test suite, the `load_defaults 8.1` run, the Sidekiq payloads in both directions, the data read-back, the live Puma and Sidekiq run, and the production boot.
- **Source-based only:** release attribution for each removal, and the 8.1 `enqueue_after_transaction_commit` reading (the source was read and the failed-enqueue check was run).
- **Proposed, not run:** the new model and request tests described under findings 1, 3 and 15 (beyond the existing tests that already fail without each repair). A bisect through 7.1, 7.2 and 8.0, a system-test run, a browser check of Trix and the CSS, and a cross-version session cookie check. Also the 8.1 HTML5 sanitizer output.
- **Open question:** what in 8.1 makes `return` inside `transaction` commit under `load_defaults 7.0` (finding 13). The repair does not depend on the answer.

---

**Commentary:** I didn't implement anything, per the skill's instructions. The repair diff is at `/tmp/out/upgrade.diff` if you want to apply it. Tell me whether to implement it, and whether to follow the planner's two-deploy order (7.0-compatible fixes first, then the version bump).