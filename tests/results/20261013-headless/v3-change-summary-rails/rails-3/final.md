I haven't made any changes. The upgrade-gem skill only covers planning, so this is the plan for moving Rails from 7.0.8.7 to 8.1.0, unedited. The planner only read code, gem sources and changelogs. It didn't install any Rails version or run any tests.

---

I ran no upgrade experiments: no disposable copy, no bundle resolution against Rails 7.1 through 8.1, and no test runs. Everything below comes from reading the code and the unpacked Rails gem sources and changelogs, plus one small Ruby check. The working tree is unchanged.

The biggest risks are two places where the upgrade silently changes data with nothing raising: CSV imports can partly commit, and import receipts lose their DOI column. Both can be fixed now in ways that also work on 7.0.

## Basis
- **Tool output:** `ruby /home/user/planner-run/maintain-rails/bin/gem-changes rails 7.0.8.7 8.1.0` saved to `/tmp/gc/out.txt`. It read releases 7.0.10, 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0.
- **Sources:** I unpacked the gems from `/home/user/.cache/gem-changes/*.gem` into `/tmp/gsrc/u/` and checked Active Job, Active Record, Action Text, Active Support and railties directly.
- **The tool missed the 8.1 defaults entirely.** I took them from `railties-8.1.0/.../new_framework_defaults_8_1.rb.tt`.
- **Executed check:** `ruby -rdate -e 'Date.iso8601(Date.today)'` raises `TypeError: no implicit conversion of Date into String`.
- **Upgrade path:** go 7.0, 7.1, 7.2, 8.0, 8.1, deploying each step. Keep `load_defaults 7.0` and adopt new defaults separately. The app is on Ruby 3.3.6, which is fine for 8.1.

## A. Required changes that can ship now on 7.0
Each of these also works on 7.0.

1. **Imports can commit partially (silent data change from 7.2).** `app/models/import.rb` `#apply` uses `return false unless row.note.save` inside `transaction`.
   - Today that `return` rolls back. Rails 7.2 removed that behaviour, so the `return` commits: the `Import` row and the earlier notes are saved.
   - Tests only reach this if a note fails to save after its validation passed, for example because of a race.
   - Fix: `raise ActiveRecord::Rollback` and then return false.
   - Validation: a unit test that stubs the second row's `save` to return false and asserts `Import.count` and `Note.count` don't change.

2. **Receipt DOIs go blank (7.2).** `Import#receipt` uses `citation[:id]`, and `citations` uses `doi` as its primary key. Rails 7.2 removed `[:id]` mapping to a custom primary key, so the DOI column becomes empty.
   - Fix: use `citation&.doi`.
   - The existing receipt assertion in `test/controllers/imports_controller_test.rb` would catch this.

3. **`Rails.application.secrets` was removed in 7.2.** It is used in `app/models/citation/provider.rb:13` and backed by `config/secrets.yml`.
   - Fix: move the settings to `config/citation_provider.yml` read with `Rails.application.config_for(:citation_provider)`. That returns symbol keys, so `values_at(:url, ...)` keeps working.
   - Deploy the same `CITATION_PROVIDER_*` environment variables.

4. **`retry_on ... wait: :exponentially_longer` was removed in 7.2** (`app/jobs/citation_enrichment_job.rb`). The replacement, `:polynomially_longer`, doesn't exist in 7.0.
   - For a change that works on both, use `wait: ->(executions) { executions**4 + 2 }`. This drops the built-in jitter.
   - Alternatively, switch to `:polynomially_longer` in the 7.1 commit.

5. **Integer `wait_until` breaks reminder scheduling (7.2).** `Note#schedule_reminder` calls `NoteReminderJob.set(wait_until: reminder_epoch)` with an Integer.
   - 7.1 deprecates this. From 7.2 on, `serialize` calls `scheduled_at.utc` on the Integer, raises `NoMethodError`, and scheduling and postponing fail with a 500.
   - Fix: `wait_until: Time.at(reminder_epoch)`.
   - Validation: `test/controllers/reminders_controller_test.rb` on 7.2.

6. **`alias_attribute :highlight_color, :color` on a store accessor** (`app/models/note.rb:14`). 7.1 deprecates this and 7.2 raises `ArgumentError` because `color` is not an attribute.
   - Fix: write explicit `highlight_color` and `highlight_color=` methods that delegate to `color`. The form and views use it, and strong params permit it.

7. **`enum status: {...}, _prefix: true`** in `note.rb` was deprecated in 7.2 and removed in 8.0.
   - Fix: `enum :status, {...}, prefix: true`, the same form `Citation` already uses.

8. **BigDecimal job argument changes format.** `User#request_digest` passes a BigDecimal to `DigestJob`.
   - 7.0 stores it as a string. From 7.2 (or 7.1 with that default) it uses `BigDecimalSerializer`, which 7.0 workers can't read during a rolling deploy or rollback.
   - Fix: pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)` on it.

9. **Daily counts crash if 7.2 date decoding is adopted.** `Notebook#daily_note_counts` calls `Date.iso8601(day)`. With `postgresql_adapter_decode_dates` (a 7.2 default), `select_rows` returns `Date` objects and raises `TypeError` (confirmed above).
   - Fix: `day.is_a?(Date) ? day : Date.iso8601(day)`.

10. **Multiple paths on one route** (`get "/notes", "/journal", to: "notes#index"` in `config/routes.rb`) were deprecated in 8.0 and removed in 8.1.
    - Fix: split into two `get` lines, keeping `as: :notes` on the first.

11. **Notebook updates fail if the 7.1 read-only default is adopted.** The notebook form re-submits `slug` in a hidden field and `notebook_params` permits it. With `raise_on_assign_to_attr_readonly`, `write_attribute` raises `ReadonlyAttributeError` on any assignment to a persisted record, even with the same value.
    - Fix: stop permitting `:slug` and remove the hidden field. Update `test/controllers/notebooks_controller_test.rb:26,29,37`, which currently asserts the hidden field exists.

12. **Exports page can 500 if the 7.1 cache default is adopted.** `app/views/exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export has expired. With `raise_on_invalid_cache_expiration_time`, that raises `ArgumentError` in production.
    - It doesn't show up in tests because the test environment uses `null_store` with caching off.
    - Fix: pass `expires_at: export.expires_at`, or skip the expiry when it's already past.

13. **Digest day changes (7.1, a behaviour change rather than a default).**
    - Since 7.1 the serializer keeps `ActiveSupport::TimeWithZone` arguments in the reader's zone; 7.0 deserialized them in `Time.zone` (UTC).
    - `DigestMailer` (`@date`, `all_day`) and its comment assume UTC, so near midnight the digest covers the reader's local day instead.
    - `test/controllers/digests_controller_test.rb:33` would fail ("October 05" vs "04").
    - In a mixed-version deploy the result depends on which worker version runs the job.
    - Fix: decide the intended semantics. To keep UTC, add `requested_at = requested_at.utc` in the mailer, which works on both versions.

## B. Changes that must ship with a specific version bump
These are not valid on 7.0.

- **7.1:**
  - `config.action_dispatch.show_exceptions = false` becomes `:none` in `config/environments/test.rb`. The boolean form was removed in 7.2, and `:none` is truthy on 7.0, so it can't go in early.
  - `serialize :tags, JSON` becomes `serialize :tags, coder: JSON`. The positional coder was removed in 7.2.
  - `serialize :preferences` becomes `serialize :preferences, coder: YAML` (before adopting `default_column_serializer = nil`).
- **Action Text initializer (crashes at boot on 7.1+):** `config/initializers/action_text.rb` does `ActionText::ContentHelper.allowed_tags += %w[details summary]`.
  - From 7.1, `allowed_tags` defaults to `nil` (`mattr_accessor(:allowed_tags)`, confirmed in 7.1.6 and 8.1.0), so `nil + Array` raises `NoMethodError`.
  - Fix: in `config.after_initialize`, set it to `(sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`.
  - Do it after the sanitizer vendor is applied. Otherwise the HTML4 list gets frozen in after you adopt `action_text.sanitizer_vendor`.
- **`to_time` (forced in 8.1):** in 8.1, `TimeWithZone#to_time` always keeps the zone (`getlocal(time_zone)`), and the `to_time_preserves_timezone` setting is deprecated.
  - `Note#next_day_reminder_at` keeps the same epoch, so scheduling is unchanged.
  - The "24 hours later" display (`_reminder.html.erb`, format `(UTC%:z)`) now shows the zone's offset after a DST change instead of the original offset.
  - Update the method comment and confirm the wording is acceptable.
- **Sidekiq adapter:** the built-in `:sidekiq` adapter is deprecated in 8.1 and removed in 8.2. Optionally move to sidekiq 7.3.3 or later. Sidekiq 7's strict arguments would then reject the symbol-key hash in `Notebook#request_export` (`{ format: "markdown" }`), so stringify it first.
- **Gem resolution (to check by experiment):**
  - Puma `~> 5.0` with the Rack 3 / rackup stack that Rails 7.1+ allows. This is unverified, and `bin/rails server` may not find Puma. Either pin `rack ~> 2.2` or move to Puma 6+.
  - `concurrent-ruby 1.3.4` was pinned for a 7.0 Logger bug and can be unpinned from 7.1.
  - Keep `minitest ~> 5.25` until 8.1 is confirmed to work with Minitest 6.

## C. New framework defaults
The app loads `load_defaults 7.0` and sets none of these explicitly, so it keeps every old value today.

**7.1**
| Default | Effect here if adopted |
|---|---|
| `raise_on_assign_to_attr_readonly` | Notebook update raises (A11) |
| `raise_on_invalid_cache_expiration_time` | Exports page raises once an export expires (A12) |
| `default_column_serializer = nil` | `serialize :preferences` without a coder raises (B) |
| `action_text.sanitizer_vendor`, `action_view.sanitizer_vendor` = HTML5 | Rich text and `simple_format` output may differ slightly; do the `allowed_tags` fix first |
| `dom_testing_default_html_version = :html5` | `assert_select` parsing changes; re-run tests |
| `active_job.use_big_decimal_serializer` | A8; only enable once no 7.0 workers remain (moot after A8) |
| `message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata` | Changes signed and encrypted messages (Active Storage blob links in rich text); old servers can't read them, so enable in a later deploy after all servers run 7.1 |
| `marshalling_format_version 7.1` | Only matters for cached records; the app caches fragments only |
| `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `before_committed_on_all_records` | The app defines no `after_commit` callbacks; low impact |
| `commit_transaction_on_non_local_return` | A1 (forced in 7.2) |
| `belongs_to_required_validates_foreign_key = false` | Skips loading unchanged parents; low impact |
| `generate_secure_token_on`, `allow_deprecated_singular_associations_name`, `sqlite3_*`, encryption settings | Not used |
| `allow_deprecated_parameters_hash_equality = false` | No Parameters-to-Hash comparisons found |
| `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size` | Logging and performance only |

**7.2**
| Default | Effect here if adopted |
|---|---|
| `postgresql_adapter_decode_dates` | Activity report raises unless A9 is in place |
| `enqueue_after_transaction_commit = :default` | `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue under a row lock so a failed enqueue rolls back. Deferring the enqueue breaks that, and a Redis failure would then leave the citation "pending" or the reminder ID set. Don't adopt. The setting is deprecated in 8.0 and removed in 8.1, where the per-job default is `false`, matching current behaviour. |
| `web_image_content_types` adds webp | Low impact (no variants, no `image_processing`) |
| `validate_migration_timestamps` | Existing timestamps look valid |
| `yjit` | Watch memory |

**8.0**
| Default | Effect here if adopted |
|---|---|
| `to_time_preserves_timezone = :zone` | Forced in 8.1 anyway; display-only change (B) |
| `strict_freshness` | `ExportDownloadsController` `stale?` with ETag and last-modified: only `If-None-Match` counts when both are sent; harmless since the ETag is the checksum |

**8.1** (missed by the tool)
| Default | Effect here if adopted |
|---|---|
| `escape_json_responses = false`, `escape_js_separators_in_json = false` | No JSON endpoints found; low impact |
| `raise_on_missing_required_finder_order_columns` | Every model has a primary key; low impact |
| `action_on_path_relative_redirect = :raise` | All redirects use helpers or absolute paths; safe |
| `render_tracker = :ruby` | Fragment cache digests change once (cache busts) |
| `remove_hidden_field_autocomplete` | Markup only |

## D. Rollout, stored data and queued work
- **Long-lived queued jobs:** `NoteReminderJob` sits in Sidekiq's scheduled set until its reminder time.
  - 8.1 reads 7.0 payloads without trouble: the `scheduled_at` and `time_zone` keys are optional.
  - Rolling back is the risk: payloads written by 7.1+ carry BigDecimal (fixed by A8) and `TimeWithZone` with a `time_zone` key, which 7.0 ignores and reads as UTC.
- **Shipping the fixes:** deploy all of section A on 7.0 first, then bump one minor version per deploy.
- **Serialization defaults:** enable the message and marshal serialization defaults only in a later deploy, once no older servers remain.
- **Stored data:**
  - `notebooks.preferences` is YAML text and `notes.tags` is JSON text. The coder changes keep these formats, so no migration is needed.
  - The Redis digest reservation keys don't change.
  - Native `ExportJob` payloads don't involve Active Job.

## E. Proposed checks (not run)
Run these in a copy with its own PostgreSQL databases, its own Redis database or prefix, its own `tmp/cache` and `storage` paths, and its own Sidekiq instance. For each run, record the `Gemfile.lock`, `config.load_defaults` value, command, and log path.
- At each step (7.1.6, 7.2.4, 8.0.x, 8.1.0): `bundle update rails`, `bin/rails zeitwerk:check`, `bin/rails test`, `bin/rails test:system`, with `active_support.deprecation = :raise` on the 7.1 step.
- Targeted tests to add: import rollback (A1), receipt DOI (A2), Integer `wait_until` (A5), exports page with an expired export and a real cache store (A12), activity report with decode-dates (A9), and digest day near midnight (A13).
- Cross-version Sidekiq check: enqueue `DigestJob` and `NoteReminderJob` from the 7.0 copy, run them with 8.1 workers, then the reverse.
- Run `bin/rails server` under the resolved Rack and Puma versions.

## Still unverified
- The Puma 5 / Rack 3 incompatibility.
- Whether the HTML5 sanitizer changes stored rich text containing `details` and `summary`.
- Whether the A13 change to the digest day is wanted.
- Whether Minitest 6 is allowed with Rails 8.1.

---

This is a jump across four minor versions (7.0 → 7.1 → 7.2 → 8.0 → 8.1), not a single version bump. To proceed, I'd first make the section A fixes, which also work on the current 7.0. Before that, I need two decisions from you:
- **Digest day (A13):** should the digest keep using UTC days, or switch to each reader's local day?
- **Gem versions:** am I allowed to upgrade Puma and change the pinned versions of `concurrent-ruby` and `minitest`? The project rules say to leave dependency versions alone unless the task allows it.