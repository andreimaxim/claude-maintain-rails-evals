# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

This upgrade can't be a single version bump. On 8.1, at least seven pieces of code break or change behaviour. Two of them lose data without an error: import receipts drop their DOIs, and the digest email covers a different day. The safest route goes through each minor release in turn: 7.0 → 7.1 → 7.2 → 8.0 → 8.1. Deploy each step fully before starting the next, and keep `load_defaults 7.0` throughout.

**Status:** nothing has been executed apart from `bin/gem-changes` (output in `/tmp/gc.txt`) and reading the code. Every conclusion below comes from the changelogs and source. I ran no tests and built no disposable copy. Points I gave from memory of Rails or Sidekiq, rather than confirming in the changelog output, are marked "unverified".

## A. Required code changes

| # | Code | What breaks | Version | Fix | Works on 7.0? |
|---|---|---|---|---|---|
| A1 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117-122` | `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2, so citation lookups fail. | 7.2 | Move to `config_for(:citation_provider)` in a new `config/citation_provider.yml` with the same ERB and environment variables. Change the test so it swaps the settings by injection instead of mutating `secrets`. | Yes |
| A2 | `app/models/import.rb:68` `citation[:id]` | Citation's primary key is `doi` and the table has no `id` column. From 7.2, `read_attribute(:id)` no longer returns a custom primary key, so receipt CSVs get **an empty DOI column with no error**. | 7.1 warns, 7.2 changes | Use `citation.doi` | Yes |
| A3 | `app/models/note.rb:10` `enum status: {...}, _prefix: true` | Keyword-argument `enum` is deprecated in 7.2 and removed in 8.0. | 8.0 | `enum :status, { draft: 0, ready: 1 }, prefix: true`. Citation and Export already use this form. | Yes |
| A4 | `app/models/note.rb:14` `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`, not a real attribute) | Aliasing something that isn't an attribute is deprecated in 7.1 and removed in 7.2. | 7.2 | Define `highlight_color` and `highlight_color=` as explicit methods that delegate to `color`. | Yes |
| A5 | `app/models/note.rb:12` `serialize :tags, JSON` | Passing the coder as a positional argument is deprecated in 7.1 and removed in 7.2. | 7.2 | `serialize :tags, coder: JSON`. The stored format doesn't change. | **No.** `coder:` only exists from 7.1, so make this change in the 7.1 step. |
| A6 | `app/models/notebook.rb:7` `serialize :preferences` (no coder, `text` column holding YAML) | Rows hold YAML. 7.1 stops defaulting to YAML once `default_column_serializer = nil` is adopted. | 7.1 defaults | `serialize :preferences, coder: YAML`, keeping the stored format. Confirm the stored values are plain Hash/String, which YAML safe-load permits. | **No.** Do it in the 7.1 step. |
| A7 | `app/jobs/citation_enrichment_job.rb:7` `wait: :exponentially_longer` | Deprecated in 7.1 and removed in 7.2, raising when the class loads. | 7.2 | `wait: :polynomially_longer`, which has the same delay formula. Retries already scheduled in Sidekiq hold only a timestamp, so they are unaffected. | **No.** Do it in 7.1 or later. |
| A8 | `config/environments/test.rb:31` `show_exceptions = false` | Booleans are deprecated in 7.1 and removed in 7.2 (the changelog entry is filed under actionpack 7.2.0). | 7.2 | `:none` | **No.** Do it in 7.1 or later. |
| A9 | `config/initializers/action_text.rb` `ActionText::ContentHelper.allowed_tags += ...` | **Unverified:** I recall that 7.1 made `allowed_tags` default to nil and compute it lazily from `sanitizer_vendor`, which would make `+=` raise `NoMethodError` at boot. | 7.1 | Verify by booting the disposable copy. If confirmed, set an explicit list built from the sanitizer's safe-list tags plus Action Text's tags plus `details summary`. Then check that `<details>` and `<summary>` survive a save and render. | Needs a version-aware form |
| A10 | `app/models/notebook.rb:26` `ExportJob.perform_async(export.id, { format: "markdown" })` | Sidekiq 6.5 warns about symbol keys. Sidekiq 7 rejects them by default (`strict_args!`), which would break every export request. Rails 8.1 deprecates its built-in `:sidekiq` adapter in favour of the adapter Sidekiq 7.3.3+ ships (that version figure is unverified). | Sidekiq 7 / Rails 8.1 | Use `{ "format" => "markdown" }` now. Upgrade Sidekiq 6.5.12 → 7.3+ and redis 4.8 → 5 / redis-client as a separate step, after Rails 7.2 and before 8.1. Check `User#request_digest`, whose `sadd` return value changes type in redis 5. | Key change: yes |
| A11 | `app/models/notebook.rb:40` `Note.connection.select_rows(relation)` | `connection` is soft-deprecated in 7.2 in favour of `with_connection` / `lease_connection`. If `postgresql_adapter_decode_dates` is ever adopted, `day` arrives as a `Date` and `Date.iso8601(Date)` raises `TypeError`. | 7.2 deprecation / 7.2 defaults | Use `Note.with_connection { \|c\| c.select_rows(days.to_sql) }` from 7.2 on. Replace `Date.iso8601(day)` with `day.to_date`, which accepts both String and Date. | `to_date`: yes. `with_connection`: 7.2 or later. |
| A12 | `app/views/layouts/application.html.erb:13`, `vendor/javascript/trix-1.3.5.js`, `pin "@rails/actiontext"` | Action Text 7.1 targets Trix 2, and 8.1 moves Trix into the separate `action_text-trix` gem. The app pairs vendored Trix 1.3.5 with the newer `actiontext.js`. | 7.1 / 8.1 | Use a browser test to check attachment uploads and editor behaviour at each step. Decide whether to keep the vendored Trix 1 or adopt the gem. | n/a |
| A13 | `Gemfile` pins | `concurrent-ruby 1.3.4` and `minitest ~> 5.25` were pinned to work around Rails 7.0 problems. `puma ~> 5` is old. `faraday 1.10` and `pagy 8.6.3` are independent of Rails. | Every step | Re-resolve the bundle at each step and loosen the 7.0-specific pins once on 7.1 or later. | n/a |

The other matched entries I checked need no action:
- **`before_action` callback checks:** the setting that raises on missing callback actions is only generated into new apps' environment files.
- **`has_secure_password`:** 7.1 adds a 72-byte maximum validation, which is harmless.
- **Migrations:** `Migration[7.0]` is still supported.
- **`form_with` / `button_to`:** I found no removed options in use.
- **Not in use:** encryption, `has_secure_token`, and `cookies_serializer` are not used, so the encryption and token defaults don't apply.

## B. Behaviour changes that tests won't catch, and rollout risks

- **B1. Digest day changes (7.1, unverified).** `DigestJob` and `app/mailers/digest_mailer.rb` depend on the job's Time argument coming back in UTC; the comment says so. I believe Active Job 7.1's TimeWithZone serializer keeps the sender's zone. If so, `requested_at.to_date` and `all_day` become the reader's local day, while `User#request_digest` still reserves by UTC date. Readers near midnight would get a different set of notes.
  - Decide which day the digest should cover, then pass it explicitly, for example the ISO date string.
  - Validation: a test that enqueues a digest for a reader in "Eastern Time" at 23:30 local time, runs it with `perform_enqueued_jobs`, and asserts on `@date` and the notes included. Run it on 7.0 and on 7.1.
- **B2. BigDecimal job arguments (`completion`).** On 7.0, BigDecimal arguments travel as strings. The `use_big_decimal_serializer` setting is deprecated in 7.2 and removed in 8.0, so 8.0 always uses the BigDecimal serializer.
  - `BigDecimal(params[:completion])` accepts either form, so the new code is fine.
  - The risk: a pre-7.1 worker can't deserialize jobs enqueued by 8.0 or later. Never run 7.0 workers alongside 8.0 web servers, and drain the queue before any rollback across the 8.0 boundary.
- **B3. Mixed-version deploys at 7.1.** Leave `message_serializer`, `use_message_serializer_for_metadata` and `marshalling_format_version` at their old values for the 7.1 deploy. Turn them on in a later deploy only after no 7.0 process remains. Signed and encrypted cookies and Active Storage signed IDs depend on these.
- **B4. Expired exports in the cache block (7.1).** `app/views/exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export has expired.
  - Keeping the old value of `raise_on_invalid_cache_expiration_time`, it gets reported and logged. Adopting the new default makes the exports page raise in production.
  - Tests use `null_store` with caching off, so they won't see it.
  - Fix: only cache while `downloadable?`, or clamp the value to a minimum of 1 second. Both work on 7.0.
- **B5. Jobs enqueued inside transactions.** `Citation#request_enrichment` and `Note#schedule_reminder` both enqueue under a row lock and rely on a failed enqueue rolling back the transaction.
  - Keep `enqueue_after_transaction_commit` off. The app does this implicitly through `load_defaults 7.0`.
  - In 8.1 the config setting is gone. Confirm the per-job class default is false (unverified for 8.1 with the Sidekiq-provided adapter).
- **B6. `Note#next_day_reminder_at` and `to_time`.** 8.0 drops `to_time` preserving system local time, and 8.1 deprecates `to_time_preserves_timezone`. Because the method returns `.to_i`, the instant doesn't change. Only the comment (which talks about keeping the offset) and any displayed representation could differ. Replace with `reminder_at + 1.day`, but only if 24 elapsed hours is still what you want across daylight-saving changes.
- **B7. Stored data.** All of these keep the stored format, so no data migration is needed:
  - `tags` is JSON text, and the fix in A5 keeps JSON.
  - `preferences` is YAML text, and the fix in A6 keeps YAML.
  - The `settings` jsonb column is unaffected.

  Jobs already in Sidekiq at each deploy boundary:
  - `CitationEnrichmentJob` and `NoteReminderJob` carry GlobalIDs.
  - `ExportJob` carries an id plus a hash.
  - `DigestJob` carries a GlobalID, a Time and a decimal string; see B1 and B2 for the risks.

  Scheduled reminders can sit in the queue for a long time. Each boundary must deserialize them in both directions, or the queue must be drained.

## C. New framework defaults (all currently kept at their old value through `load_defaults 7.0`; none set explicitly)

Adopting these is optional. Use one `new_framework_defaults_X_Y.rb` per step and turn settings on one at a time.

### 7.1

| Setting | What adopting it would change for this app |
|---|---|
| `allow_deprecated_parameters_hash_equality = false` | Safe. No `params ==` comparisons found. |
| Encryption `hash_digest_class` / `support_sha1` | Not applicable; no encryption is used. |
| `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined` | No `after_commit` callbacks found. Low impact. |
| `sqlite3_adapter_strict_strings_by_default` | Not applicable (PostgreSQL). |
| `allow_deprecated_singular_associations_name = false` | Low impact. |
| `use_big_decimal_serializer` | See B2. Turn it on only after every worker runs 7.1 or later. It becomes mandatory in 8.0. |
| `raise_on_invalid_cache_expiration_time` | **Breaks expired exports. Fix B4 first.** |
| `query_log_tags_format` | No effect; query log tags aren't enabled. |
| `message_serializer` / `use_message_serializer_for_metadata` | See B3. Needs two deploys. |
| `log_file_size` | Development and test only. |
| `raise_on_assign_to_attr_readonly` | **Breaks notebook settings.** The settings form resubmits `slug` (`notebooks_controller.rb:40`, `_form.html.erb:13`), so updates raise `ReadonlyAttributeError`. Tests at `notebooks_controller_test.rb:29,37` would catch it. Fix: stop permitting `:slug` on update. That works on 7.0. |
| `belongs_to_required_validates_foreign_key = false` | Skips loading the parent on validation. Fine. |
| `precompile_filter_parameters` | Safe. |
| `default_column_serializer = nil` | Needs A6 first. |
| `marshalling_format_version` | See B3. |
| `commit_transaction_on_non_local_return` | **Changes `Import#apply`.** It does `return false` inside `transaction`. Today that rolls back (with a deprecation warning in 7.1). With the new default it **commits** a partial import and its notes. Fix: `raise ActiveRecord::Rollback` and return false after the block. Works on 7.0. Validate with a test that has an invalid second row and asserts no import or notes are saved. |
| `generate_secure_token_on` | Not applicable. |
| `action_view` / `action_text` `sanitizer_vendor` HTML5 | Changes the sanitizing of rich-text bodies and the `details`/`summary` allow-list (A9). Check with existing note bodies. |
| `debug_exception_log_level` | Logging only. |
| `dom_testing_default_html_version = :html5` | `assert_select` uses the HTML5 parser. Small test differences are possible. |

### 7.2

| Setting | What adopting it would change for this app |
|---|---|
| `enqueue_after_transaction_commit` | Don't adopt; see B5. Removed in 8.1. |
| `web_image_content_types` adds webp | webp attachments stop being converted to PNG variants. No image processing gem is installed, so low impact. |
| `validate_migration_timestamps` | Existing timestamps (`2026101...`) are valid. |
| `postgresql_adapter_decode_dates` | Breaks `daily_note_counts` unless A11 is done. |
| `yjit` | Ruby 3.3.6, so this only costs memory. |

### 8.0

| Setting | What adopting it would change for this app |
|---|---|
| `to_time_preserves_timezone = :zone` | See B6. |
| `strict_freshness` | No `fresh_when` or `stale?` calls found, so no effect. |

### 8.1

The tool lists no 8.1 framework defaults. Read the 8.1 release notes and `new_framework_defaults_8_1` template directly before that step; this hasn't been done yet.

## D. Proposed order

1. **On 7.0:** make A1, A2, A3, A4, the A10 key change, the A11 `to_date` change, B4, the `Import#apply` rollback fix, and the slug permit fix. Deploy.
2. **Bump to 7.1:** make A5, A6, A7 and A8, and settle A9. Before deploying, decide B1 and change `DigestJob` if needed. Deploy with defaults kept, then turn on the message-serializer settings in a second deploy.
3. **Bump to 7.2:** add `with_connection`. Check the Trix behaviour (A12).
4. **Sidekiq 7.3+ and redis 5:** upgrade, then drain the queue.
5. **Bump to 8.0**, then **8.1:** switch to the Sidekiq-provided adapter and handle the Trix gem.

## E. Proposed validation (not run)

Use a disposable copy (`cp -a` to `/tmp/mn-upgrade`) with its own isolated services:
- its own PostgreSQL database names via `DATABASE_URL`, for example `margin_notes_upgrade_test`;
- `REDIS_URL` pointing at a separate Redis instance or database number;
- `tmp/storage` inside the copy.

At each step:
- Run `bundle update rails` and record `Gemfile.lock`.
- Run `bin/rails zeitwerk:check`, `bin/rails test` and `bin/rails test:system` with `RUBYOPT=-W:deprecated`, logging deprecations to a file per step.
- Add the targeted tests:
  - B1 digest day;
  - A2 receipt DOI column;
  - `Import#apply` partial rollback;
  - B4: an expired export rendered with `:memory_store` and caching on;
  - A11 date type;
  - A9: a body containing `<details>` round-tripped.
- Do a Sidekiq round-trip with real 7.0 and new-version workers to check B2 and the deserialization of already-queued jobs.

## Open questions

- Confirm B1 (the TimeWithZone serializer change), A9 (`allowed_tags` nil in 7.1), and whether Rails 8.1's adapter works with Sidekiq 6.5.
- Which day should the digest cover?
- Do production `preferences` rows hold only plain YAML types?
- How long do reminder jobs stay queued at deploy time?

---

I haven't upgraded anything yet: the upgrade skill only produces a plan, so no files have changed. Rails is pinned at exactly `7.0.8.7` in the `Gemfile`.

Before I start, please answer the open questions above, especially which day the digest should cover. Then tell me whether to begin with step 1, the changes that work on 7.0. I recommend doing those as their own commit before any version bump.