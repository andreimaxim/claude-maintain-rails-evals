Here is the planner's full plan for upgrading Rails 7.0.8.7 to 8.1.0. I haven't changed the working repo.

# Upgrade plan: Rails 7.0.8.7 to 8.1.0 for Margin Notes

The upgrade is doable, but not as a version bump. On 8.1.0 the app does not boot until the changes below are made. All 46 tests then pass, but the test suite hides two silent failures: a partly saved import and a blank DOI column in the import receipt (findings 4 and 5).

**How this was tested.** I copied the app to `/tmp/plan/*`. Each copy used its own Postgres databases (`plan_*`, since dropped) and its own Redis server on port 6391 (shut down). I used isolated storage and mail directories, and I did not touch the working repo. The working repo is clean, and `mise.toml` was deleted in the copies only.

I ran four checks on the test suite:
- Baseline on 7.0.8.7 was 46 green.
- Bridge copies went to 7.1.6, 7.2.4 and 8.0.5.1.
- The fixed 8.1.0 copy is `/tmp/plan/v81`, with a `load_defaults 8.1` variant at `/tmp/plan/v81d`.
- The fixed 8.1.4 copy is `/tmp/plan/v814`.

**Resolved dependencies.** The `bundle update rails --conservative` run left these unchanged:
- rack 2.2.24
- puma 5.6.9
- sidekiq 6.5.12
- redis 4.8.1
- faraday 1.10.4
- sprockets-rails 3.5.2
- pagy 8.6.3

It added these:
- json 3.1.0 (2.21.2 once pinned)
- bigdecimal 4.1.3
- rackup
- rack-session
- action_text-trix 2.1.19

Not run: system tests (no browser installed), so the Trix 1.3.5 versus Trix 2 interaction is untested.

**Key files:**
- Changelog index: `/tmp/plan/changes.txt`
- Applied-fix diff: `/tmp/plan/v81_changes.diff`
- Test logs:
  - `/tmp/plan/base_test.log`
  - `/tmp/plan/h716_test.log`
  - `/tmp/plan/h724_test.log`
  - `/tmp/plan/h8051_test.log`
  - `/tmp/plan/v81_test1.log` to `v81_test10.log`
  - `/tmp/plan/v81d_test.log`
  - `/tmp/plan/prep_test2.log`
  - `/tmp/plan/v814_test.log`
- Experiment scripts: `/tmp/plan/scripts/`
- Mixed-version worker logs: `/tmp/plan/mix1_worker.log` and `mix2_worker.log`

## Recommended path

Hop 7.0.8.7 to 7.1.6, fix the deprecations, then go to 7.2, then 8.0, then 8.1. 7.1.6 boots and passes 45 of 46 tests with about 15 distinct deprecation warnings, so it works as a bridge. On 7.2.4 and 8.0.5.1 every test errors at `Note`'s `enum` line.

The 8.1.0 gem is usable only with a `json` pin (finding 1). I recommend going to 8.1.4 instead. With 8.1.4 and json 3.1.0, all 46 tests passed on that copy and I found no other differences from 8.1.0.

## Required findings

Each finding is marked as executed (E) or source-read (S).

### 1. `json` 3.x breaks 8.1.0 (E)

- **What happens:** Bundler resolves json 3.1.0. `ActiveSupport::JSON.decode` calls `JSON.parse(json, options)`, which raises `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Where:** The trace goes through `Messages::Metadata#deserialize_from_json` and `MessageEncryptor#read_message`. Any request that reads an encrypted cookie (session, flash) returns a 500.
- **Repair:** Move to 8.1.4, or add `gem "json", "< 3"` for 8.1.0 exactly. I verified both.
- **Validation:** Sign in and request `/notes` with the session cookie. Without the repair it returns 500. With it, 200.
- **Control:** The 8.1.4 run passes the full suite with json 3.1.0.

### 2. `config/initializers/action_text.rb` breaks boot, from 7.1 (E)

- **What happens:** `ActionText::ContentHelper.allowed_tags += %w[details summary]` raises `NoMethodError: undefined method '+' for nil`. `allowed_tags` is now nil unless set. The boot fails in every environment.
- **Repair:** Set it in `Rails.application.config.after_initialize`:
  - Take the existing value, or `sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]` when it is nil.
  - Append `details summary`.
- **Works on 7.0:** Yes. The existing value is non-nil there.
- **Validation:** Render `<details><summary>S</summary>…</details><script>…`. The rendered HTML was identical on 7.0 and 8.1.0 (details and summary kept, script and onclick dropped). The existing test "rich text keeps collapsible excerpts and drops unsafe markup" passes.
- **Control:** With `load_defaults 8.1`, the HTML5 sanitizer differs only in whitespace.

### 3. Syntax removed in 7.2 (E; deprecated in 7.1, so the replacements can be adopted on 7.1)

- **`app/models/note.rb` enum:** `enum status: {...}, _prefix: true` raises `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. Use `enum :status, {...}, prefix: true`. This works on 7.0 as well, because `Export` and `Citation` already use that form.
- **`serialize :tags, JSON`:** 7.2 removes the positional coder (`ArgumentError: wrong number of arguments (given 2, expected 1)`). Use `coder: JSON`. This is 7.1 and later only. On 7.0 `coder:` is read as a hash.
- **`alias_attribute :highlight_color, :color` (a `store_accessor`):** 7.2 raises `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`. Define `highlight_color` and `highlight_color=` as methods. This works on 7.0.
- **`config/routes.rb`:** `get "/notes", "/journal", to:` raises `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Split it into two `get` lines. This works on 7.0, and `rails routes` for the app is unchanged.
- **`app/views/notes/index.html.erb`:** `form_with(model: nil, …)` raises `ArgumentError: Passed nil to the :model argument, expect an object or false`. Use `model: false`. This works on 7.0.
- **`config/environments/test.rb` `show_exceptions = false`:** In 8.x `false` means show all exceptions. Every `assert_raises(ActiveRecord::RecordNotFound)` test then fails with "expected but nothing was raised", and 14 other tests fail. Use `:none`. This is 7.1 and later only.
- **Validation for the whole finding:** The suite goes from 46 errors to green on 8.1.0 and 7.1.6 after the fixes. Only the `:none` and `coder:` changes fail on 7.0; the rest pass there.

### 4. `Import#apply` commits partial imports (E)

- **What happens:** `return false` inside `transaction do` rolled back on 7.0 and 7.1. On 7.2, 8.0 and 8.1.0 it commits.
- **Experiment:** I added a `before_save` that aborts on one title and imported a two-row CSV with that title in row 2.
  - 7.0 and 7.1: `apply returned false; notes=0; import persisted=false`
  - 8.1.0: `apply returned false; Import.count for notebook=1; notes=1; import persisted=true`
- **Consequence:** The row 1 note and the import record stay saved, which breaks the "saves every row, or saves nothing" contract. No error is raised, and the existing tests cannot see it because they fail validation before the transaction.
- **Repair:** Record the result in a local variable and `raise ActiveRecord::Rollback` inside the block when a row fails to save. This is one repair for both paths. It works on 7.0, and I measured `notes=0` on 7.0 (the `prep` copy) and on 8.1.0.
- **Validation:** Use the script above.
- **Control:** A fully valid CSV still saves the import and all rows.

### 5. `Import#receipt` DOI column goes blank (E)

- **What happens:** `citation[:id]` returns nil because `Citation`'s primary key is `doi`. It returned the DOI on 7.0 and 7.1 (with a deprecation) and returns nil from 7.2.
- **Consequence:** The receipt CSV has an empty DOI column. No error is raised.
- **Repair:** Use `citation&.doi`. This works on 7.0.
- **Validation:** Import a CSV that has DOIs, download the receipt, and assert the DOI column equals the stored `citation_doi`. The existing test would catch this only once the earlier preview failure (finding 6) is fixed.

### 6. `HashWithIndifferentAccess#stringify_keys` converts Integer keys (E)

- **What happens:** `app/views/imports/preview.html.erb` calls `@import.annotations.stringify_keys` and then looks up `annotations[row.line]` with an Integer. On 7.0 the keys stay Integer. On 8.1 they become strings (`{"2"=>"x"}`), so the lookup returns nil and the annotations disappear from the preview. No error is raised.
- **Repair:** Use `row.annotation`, which the `Row` struct already carries, and drop the map. This works on 7.0.
- **Validation:** The preview test fails with `Expected: "Second reading" Actual: "not-a-doi"` without the fix and passes with it.

### 7. `Rails.application.secrets` removed in 7.2 (E)

- **What happens:** `Citation::Provider` and the test helper raise `NoMethodError: undefined method 'secrets'`. `config/secrets.yml` is no longer read.
- **Repair:** Move the same ERB and ENV content to `config/citation_provider.yml`. The shape is `development`, `test: *local`, and `production`. Read it with `Rails.application.config_for(:citation_provider)`. This works on 7.0.
- **Test helper:** Stub `config_for` in `with_provider` instead of assigning to `secrets`.
- **Validation:** The test "provider credentials from the environment reach the server unchanged" runs in a subprocess and covers the ENV path.
- **Production:** `secrets.yml` held no `secret_key_base`, so credentials or the ENV variable are unaffected. Confirm the production environment sets the three `CITATION_PROVIDER_*` variables.

### 8. Other removed or changed behavior, each found by running the suite or an experiment (E)

- **`Array#sum` on strings in `Export#generate`:** `fragments.sum` raises `TypeError: String can't be coerced into Integer`, from 7.1. Use `fragments.join`. This works on 7.0.
- **`NoteReminderJob.set(wait_until: reminder_epoch)`:** An Integer raises `NoMethodError: undefined method 'utc' for an instance of Integer` (the Integer-epoch form is deprecated in 7.1 and removed in 7.2). Use `Time.at(reminder_epoch)`. This works on 7.0, and the queued epoch is unchanged.
- **`wait: :exponentially_longer`:** It raises `RuntimeError: Couldn't determine a delay based on :exponentially_longer` on the first retry. Use `:polynomially_longer` on 7.1 and later. It is not available on 7.0.
- **`@notes.where(notebooks: @notebook)` in `NotesController#index`:** This raises `PG::UndefinedColumn: column notes.notebooks does not exist`. Use `where(notebook: @notebook)`. This works on 7.0.
- **Digest day:** `DigestJob` now serializes the time zone, so the worker restores the reader's zone and the digest covers the reader's local day. Rails 7.0's worker used UTC. The test gets `"October 04, 2026"` instead of `"October 05, 2026"`, so the digest lists a different set of notes.
  - Repair: add `requested_at = requested_at.in_time_zone("UTC")` in `DigestMailer`. It works for both old and new queued payloads and on 7.0.
  - Check: I processed a 7.0-enqueued job on 8.1 after the fix, and the subject was the UTC day.
- **Reminder preview:** `to_time` now preserves the zone, so `next_day_reminder_at` displays `2026-11-01T08:00:00-05:00` instead of `09:00-04:00`. It is the same instant and `.to_i` is unchanged, but the preview text differs and the test fails.
  - Pick one: use `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)` to keep the old display, or accept the new display and update the test and the code comment.
  - I recommend the first, because the repo documents "keeps the offset". It works on 7.0.

## Optional: adopting new defaults

Adopting `load_defaults 8.1` on 8.1.0 gives these results (E where marked):

- **`serialize :preferences` with no coder (7.1 default `default_column_serializer = nil`):** It raises `ArgumentError: missing keyword: :coder`, and every test errors. Set `coder: YAML` first. The stored YAML is unchanged. Rows written by 7.0 and by 8.1 (`"---\nexport_heading: …\n"`) read in all three versions, in both directions (E). `tags` and `settings` bytes are identical too.
- **`raise_on_assign_to_attr_readonly` (7.1):** The notebook settings form resubmits `slug` via `hidden_field :slug` and the controller permits it. It then raises `ActiveRecord::ReadonlyAttributeError: slug` (E). To adopt, drop the hidden field and the `:slug` permit.
- **`postgresql_adapter_decode_dates` (7.2):** `daily_note_counts` gets a Date from `select_rows`, so `Date.iso8601(day)` raises `TypeError: no implicit conversion of Date into String` (E). To adopt, drop the `Date.iso8601` call and accept Date values.
- **`raise_on_invalid_cache_expiration_time` (7.1):** `cache [...], expires_in: export.expires_at - Time.current` in `exports/_export.html.erb` raises `Cache expiration time is invalid, cannot be negative: -60.0` once an export expires (E). To adopt, clamp with `[…, 0].max` or skip the cache for expired exports.
- **`run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `generate_secure_token_on`, `belongs_to_required_validates_foreign_key`:** The app has no `after_commit` or `has_secure_token` use and its `belongs_to` associations are optional, so there are no effects (S).
- **`sanitizer_vendor` HTML5 (7.1):** The rendered HTML differs only in whitespace (E).
- **`dom_testing_default_html_version = :html5` (7.1):** All tests pass with it (E).
- **`enqueue_after_transaction_commit` (7.2):** In 8.1.0 the config is removed and the default is false (S, plus E: `CitationEnrichmentJob.enqueue_after_transaction_commit` read `false` under `load_defaults 8.1`). If you adopt 7.2 defaults on the 7.2 or 8.0 hop, `Citation#request_enrichment` and `Note#schedule_reminder` would defer the enqueue until after the lock transaction commits. That would break the model comments that say a failed enqueue rolls back the pending state. I did not run this on 7.2. Do not set it on the hops.
- **`strict_freshness` (8.0):** `ExportDownloadsController#show` uses `stale?(etag:, last_modified:)`. Only `If-None-Match` would count when both headers are sent (S, not run). Re-verify the conditional-GET behavior if adopted.
- **`yjit`, `web_image_content_types`, `validate_migration_timestamps`:** No effect. The migration timestamps are in the past and there are no image variants.
- **8.1 defaults:** `raise_on_missing_required_finder_order_columns`, `action_on_path_relative_redirect` and `remove_hidden_field_autocomplete` have no effect. The app has no unordered `.first` or `.last` and its redirects use helpers. `render_tracker` and `escape_json_responses` also have no effect (S).
- **`to_time_preserves_timezone` in 8.1.0:** The config is inert and deprecated, and `to_time` always preserves the zone. This is an executed behavior change (see finding 8) and not a config choice.
- **Overall with `load_defaults 8.1`:** After the `coder: YAML` fix, 3 of 46 tests fail. They are the three items marked E above: slug readonly, decode_dates and expiry. Everything else passes.

## Mixed-version rollout and rollback

- **Old to new (Sidekiq jobs, E):** `DigestJob`, `NoteReminderJob` and the native `ExportJob` enqueued by 7.0 all ran correctly on 8.1 with the fixes applied. The reminder was sent, the export completed, and the digest used the UTC day.
- **New to old, rollback (E):** The `DigestJob` enqueued by 8.1.0 carries `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer", …}`, and a 7.0 worker raises `ActiveJob::DeserializationError: Serializer … is not known`. The job sits in the Sidekiq retry set.
  - 7.0 serialized the same value as a plain `"0.5"` string.
  - Preparatory fix: pass `reading_completion.to_s` from `User#request_digest`. The mailer already calls `BigDecimal(params[:completion])`, so it works on 7.0. Do this before the first 7.1 deploy.
  - The reminder job (new `scheduled_at` string) ran fine on 7.0, and the extra `time_zone` key is ignored there.
- **Sessions (E):** Cookies written by 7.0 and by 8.1 are readable by the other (200 in both directions) when `secret_key_base` is the same. In the dev copies the secret file was renamed (`development_secret.txt` to `local_secret.txt`), which signs everyone out only in development. Production uses credentials or ENV and is unaffected, but confirm `config/master.key` or `SECRET_KEY_BASE` stays the same.
- **Stored data (E):** YAML preferences, JSON tags and jsonb settings are byte-identical. The migrations run from scratch on 8.1 (E: `db:migrate` on an empty database completed with no errors). The first schema dump on 8.1 reorders columns alphabetically and changes the header to `Schema[8.1]` with `enable_extension "pg_catalog.plpgsql"`. That is dump churn only, and the schema file cannot be loaded by 7.0 after that dump, so do not commit it before the rollback window ends.
- **Preparatory changes that also work on 7.0 (E):** I ran the 7.0-compatible subset on 7.0.8.7 and got 46 green (`/tmp/plan/prep_test2.log`). It is these changes:
  - findings 2, 4, 5, 6, 7;
  - the enum, `alias_attribute`, routes, `form_with` and `sum` fixes;
  - the `Time.at` wait value, the `where(notebook:)` change, and both the digest and `next_day` changes;
  - the BigDecimal string.
- **7.1 and later only:** `coder:`, `:none` and `polynomially_longer`.

## Not required, but worth planning

- **Sidekiq adapter deprecation (E, in the worker log):** `The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2. Please upgrade sidekiq gem to version 7.3.3 or later`. A move to Sidekiq 7 needs a separate plan.
  - `User#request_digest` uses `Sidekiq.redis { |r| r.sadd(...) }` as a boolean. On a redis-client based Sidekiq 7 `sadd` returns an Integer (0 is truthy in Ruby), which would break the once-per-day guard. redis 4.8.1 already prints a warning about this (E).
  - `Notebook#request_export` rescues `Redis::BaseError`, so that needs updating too.
  - I did not test Sidekiq 7.
- **Boot and server (E):** The production eager-load boot, `zeitwerk:check`, `assets:precompile` and a dev server under Puma 5.6.9 all work on 8.1.0. Rack stays at 2.2.24, so there is no Rack 3 migration on this path.
- **Trix and the layout (S plus one executed render check):** `app/views/layouts/application.html.erb` loads the vendored `trix-1.3.5.js`, but Action Text 8.1 ships action_text-trix 2.1.19 and CSS for Trix 2. The page rendered with the 1.3.5 script tag. Browser behavior is unverified, so run system tests once a browser is available. The likely repair is to drop the vendored copy and the `javascript_include_tag`, and pin `trix` in the importmap. `app:update` would show the diff.
- **Pins:** `concurrent-ruby 1.3.4` and `minitest ~> 5.25` can be revisited after the upgrade.

## Things I could not verify

- Behavior in a real browser (Trix, attachments, Turbo).
- Intermediate 7.2 and 8.0 behavior with all fixes applied. I ran only the unmodified-plus-action_text-fix app there, which stops at the `enum` line.
- `strict_freshness` and `enqueue_after_transaction_commit` under real traffic.
- Production-only settings (cache store, `RAILS_SERVE_STATIC_FILES`, log tags).

## Suggested order

1. On 7.0.8.7, deploy the 7.0-compatible set above plus `reading_completion.to_s`.
2. Go to 7.1.6, apply `coder:`, `:none` and `polynomially_longer`, and run with deprecations visible.
3. Go to 7.2.4, then 8.0.5.1, then 8.1.4. Pin `json < 3` only if you must stay on 8.1.0.
4. Keep `load_defaults 7.0`. Treat the defaults above as a separate change per default, with the validations given.

---

**Commentary:** You asked for exactly 8.1.0. The plan found that 8.1.0 needs a `json < 3` pin to work, and that 8.1.4 doesn't. Tell me which you want before I implement anything. I stopped at the plan, as the skill requires.