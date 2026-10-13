# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is feasible, but the app does not boot on 8.1 as it stands, and several things change silently. In a disposable copy I made 15 code changes and one Gemfile pin. After that the full suite passed on 8.1 (46 runs, 0 failures) both with `load_defaults 7.0` and with `load_defaults 8.1`. I also boot-tested Puma 5.6.9 and ran jobs end to end through a real Sidekiq 6.5.12 worker.

Five changes stay quiet: the suite passes without some fixes, or there's no error, only different output or data:
- **CSV import partial commit:** when a later row is invalid, earlier rows and the import are now saved, where 7.0 rolled them back.
- **Import receipt:** the DOI column in the receipt CSV becomes empty.
- **Import preview:** annotations disappear.
- **Digest date:** the email covers the reader's local day instead of the UTC day.
- **Postponed reminder:** it is displayed at a different clock time (the send time is unchanged).

`/home/user/workspace/repo` was not modified; it is still clean.

## Experiment record

**Setup**
- Copies (Ruby 3.3.6):
  - `/tmp/mn-upg/app` – Rails 8.1.0 with all fixes.
  - `/tmp/mn-upg/app70` – Rails 7.0.8.7 plus the preparatory changes.
  - `/tmp/mn-upg/app71` – Rails 7.1.6 plus the preparatory changes.
- Isolation:
  - A private `redis-server` on port 6391 (separate db numbers per copy). It is now shut down.
  - Separate Postgres databases `mn_upg_test`, `mn_upg70_test`, `mn_upg71_test` and `mn_upg_dev`. They are now dropped.
  - Active Storage files and mail stayed under each copy's `tmp/` and `storage/`.
  - The provider URL pointed at a closed port.
- Commands: `bin/rails test`, `CI=1 bin/rails zeitwerk:check`, the runtime probe `/tmp/mn-upg/scripts/probe.rb`, the payload replay `/tmp/mn-upg/scripts/replay.rb`, `/tmp/mn-upg/scripts/enqueue_dev.rb`, `bundle exec sidekiq`, and `bin/rails server` with curl.
- In the 8.1 copy, I tried new defaults with `PROBE_LOAD_DEFAULTS` and `PROBE_DEFAULTS`. These are environment hooks I added to that copy's `config/application.rb` for the experiments only.

**Resolved dependencies on 8.1**
- `bundle update rails --conservative` gave rails 8.1.0 with sidekiq 6.5.12, redis 4.8.1, concurrent-ruby 1.3.4, puma 5.6.9, pagy 8.6.3 and bootsnap 1.26.0. New gems included bigdecimal 4.1.3, uri 1.1.2 and rackup.
- It also resolved json 3.1.0, which breaks 8.1 (finding 1). I added `gem "json", "< 3"`, which resolved json 2.21.2.

**Logs** (all in `/tmp/mn-upg/logs/`)
- Baseline on 7.0: `baseline-7.0.log` – 46 runs, green. One deprecation: `Enumerable.sum` with strings.
- 8.1 fix iterations: `boot-8.1.log`, `zw-8.1.log`, then `test-8.1-a.log` through `test-8.1-g.log`.
- 8.1 final runs: `test-8.1-final-ld7.0.log` and `test-8.1-final-ld8.1.log` (both green), plus `test-8.1-loaddefaults81*.log`.
- Preparatory changes on old Rails: `test-7.0-prep.log` (the `coder:` failure), `test-7.0-prep-b.log` (green), `test-7.1-prep.log` (green).
- Probes: `probe-*.log`.
- Job payloads captured from each version: `payload-7.0.json`, `payload-7.1.json`, `payload-8.1.json`.
- Real worker and server: `sidekiq-8.1-dev.log`, `server-8.1-dev.log`.
- The patch of preparatory changes: `/tmp/mn-upg/prep.patch`.

## Required changes

Each item lists the affected code, what goes wrong, the fix, whether the fix also works on 7.0, and how it was checked. "Executed" means I ran it in the copies. "Source" means I concluded it from reading code or changelogs.

1. **json gem 3.x breaks every signed or encrypted cookie read.**
   - What goes wrong: activesupport 8.1.0 calls `JSON.parse(json, options)` with a positional hash, and json 3.1.0 rejects it. Every request that reads the session failed with a 500.
   - Fix: pin `gem "json", "< 3"` with the upgrade.
   - Status: executed (`test-8.1-c.log`).

2. **`config/initializers/action_text.rb` stops boot.**
   - What goes wrong: from 7.1, `ActionText::ContentHelper.allowed_tags` is `nil` by default, so `+=` raises `NoMethodError`.
   - Fix: in an `after_initialize` with `on_load(:action_view)`, build the list as `allowed_tags || sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]`, then add `details summary`.
   - Works on 7.0: yes.
   - Status: executed. The test "rich text keeps collapsible excerpts" passes under both default sets.

3. **`app/models/note.rb` – `enum status: {...}, _prefix: true`.**
   - What goes wrong: the keyword form was removed; it raises `ArgumentError` at class load.
   - Fix: `enum :status, {...}, prefix: true`. This is the form `Citation` already uses.
   - Works on 7.0: yes. Status: executed.

4. **`app/models/note.rb` – `serialize :tags, JSON`.**
   - What goes wrong: the positional coder is removed in 7.2 and raises.
   - Fix: `serialize :tags, coder: JSON`.
   - Works on 7.0: **no**. On 7.0 the `coder:` keyword is silently ignored and the column falls back to YAML. Tags then fail to read (`undefined method join/any? for String`), and new writes would be YAML in a column that holds JSON.
   - Ship this change only together with Rails ≥ 7.1. 7.1 accepts both forms.
   - Status: executed (`test-7.0-prep.log`, `test-7.1-prep.log`).

5. **`app/models/note.rb` – `alias_attribute :highlight_color, :color`.**
   - What goes wrong: `color` comes from `store_accessor`, not a real attribute. 8.1 raises at first use.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
   - Works on 7.0: yes. Status: executed.

6. **`config/routes.rb:18` – `get "/notes", "/journal", to: ...`.**
   - What goes wrong: a route with multiple paths was removed in 8.1 (actionpack 8.1.0 changelog), and it raises.
   - Fix: two routes, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index"`.
   - Works on 7.0: yes. Status: executed.

7. **`Rails.application.secrets` in `app/models/citation/provider.rb` and its test.**
   - What goes wrong: removed in 7.2.
   - Fix: add `config/citation_provider.yml` with the same ERB and environment variables, and set `config.x.citation_provider = config_for(:citation_provider)`. Update the test to mutate `config.x.citation_provider`.
   - Works on 7.0: yes. Status: executed.
   - Delete `config/secrets.yml` after the cutover. It contains no `secret_key_base` (source), so session keys don't change.

8. **`app/jobs/citation_enrichment_job.rb` – `wait: :exponentially_longer`.**
   - What goes wrong: removed in 7.2. It only fails when a retry happens, so boot looks fine.
   - Fix: `wait: ->(executions) { executions**4 + 2 }`. This is the same schedule without jitter. `:polynomially_longer` doesn't exist on 7.0.
   - Works on 7.0: yes.
   - Status: executed with a real Sidekiq worker. Retries came at 3 s and 18 s, then the citation was marked `failed`.

9. **`app/models/export.rb:42` – `fragments.sum` on strings.**
   - What goes wrong: raises `TypeError` on 7.1+, so every export job fails. 7.0 already prints a deprecation warning for this.
   - Fix: `fragments.join`.
   - Works on 7.0: yes. Status: executed.

10. **`app/controllers/notes_controller.rb:18` – `where(notebooks: @notebook)`.**
    - What goes wrong: the plural name for a `belongs_to` was removed, giving `PG::UndefinedColumn`.
    - Fix: `where(notebook: @notebook)`.
    - Works on 7.0: yes. Status: executed.

11. **`app/views/notes/index.html.erb:12` – `form_with(model: nil, ...)`.**
    - What goes wrong: 8.1 raises "Passed nil to the :model argument".
    - Fix: drop `model: nil`.
    - Works on 7.0: yes. Status: executed.

12. **`app/models/note.rb` – `set(wait_until: reminder_epoch)` with an Integer.**
    - What goes wrong: 8.1 calls `.utc` on it and raises.
    - Fix: `set(wait_until: Time.at(reminder_epoch))`.
    - Works on 7.0: yes. Status: executed.

13. **`config/environments/test.rb` – `show_exceptions = false`.**
    - What goes wrong: in 8.1 a boolean no longer disables exception pages. Tests expecting `RecordNotFound` saw rendered 404s instead.
    - Fix: set it to `:none`.
    - Works on 7.0: **no**. On 7.0 a symbol counts as true and turns exception pages on. Change it together with the bump. 7.1 warns but still accepts `false`.
    - Status: executed.

14. **Silent: `app/models/import.rb#apply` – `return false` inside `transaction`.**
    - What goes wrong: from 7.2 a `return` inside a transaction commits it. An import with an invalid later row now saves the `Import` and the earlier notes and citations. Executed: `record_counts` changed from `[0,3,0,1]` to `[1,4,1,2]`.
    - Fix: `raise ActiveRecord::Rollback unless rows.all? { |r| r.note.save }`, with a local `saved` flag for the return value.
    - Works on 7.0: yes. Status: executed.

15. **Silent: `Import#receipt` – `citation[:id]`.**
    - What goes wrong: `Citation`'s primary key is `doi`. On 8.1, `read_attribute(:id)` no longer maps to it, so the receipt CSV's doi column comes out empty. The suite caught this.
    - Fix: `citation&.doi`.
    - Works on 7.0: yes. Status: executed.
    - Source: I didn't pin down which release changed this.

16. **Silent: `app/views/imports/preview.html.erb` – `@import.annotations.stringify_keys`.**
    - What goes wrong: on 8.1, `HashWithIndifferentAccess#stringify_keys` turns the integer line keys into strings. The `annotations[row.line]` lookups then miss and annotations vanish from the preview. Executed: 8.1 returns `{"2"=>"x"}`.
    - Fix: drop `.stringify_keys`.
    - Works on 7.0: yes. Status: executed.

17. **Silent: digest date, `app/mailers/digest_mailer.rb`.**
    - What goes wrong: from 7.1, Active Job keeps a `TimeWithZone` argument's zone. The payload now carries `"time_zone":"America/New_York"`. The digest then covers the reader's local day, not the UTC day promised in the UI and comments (test: October 04 instead of 05).
    - Fix: `params[:requested_at].in_time_zone("UTC")` in the mailer. This also handles jobs already queued by 7.0, which carry no zone.
    - Works on 7.0: yes.
    - Must ship **before or with 7.1**, the release where the behaviour starts. Status: executed on 7.0, 7.1 and 8.1.

18. **Silent: `Note#next_day_reminder_at` – `reminder_at.to_time + 86_400`.**
    - What goes wrong: in 8.1 `to_time` always keeps the zone (the setting is deprecated). Across the 2026-11-01 DST change, the displayed time becomes 08:00 −05:00 instead of the documented 09:00 −04:00.
    - What doesn't change: the scheduled epoch, `.to_i`, is the same.
    - Fix to keep current behaviour: `Time.at(reminder_at.to_i + 86_400).getlocal(reminder_at.utc_offset)`.
    - Alternative: accept the zone-based display and update the comment and the test. That's a product decision.
    - Works on 7.0: yes. Status: executed.

## Dependencies and other gems
- **Sidekiq 6.5.12 works with 8.1.** I verified the Active Job adapter, the native `ExportJob`, `discard_on`, and retries end to end. However:
  - Rails warns "built-in sidekiq adapter deprecated, removed in 8.2; use sidekiq ≥ 7.3.3".
  - Keep that Sidekiq upgrade out of this change. With Sidekiq 7, `ExportJob`'s symbol-keyed args raise (strict args).
  - Sidekiq 7 also uses `redis-client`. `rescue Redis::BaseError` in `Notebook#request_export` would stop catching errors, and `sadd` returns an Integer, so `if 0` is always true and the one-digest-per-day limit would break. That last point is from source.
- **`concurrent-ruby 1.3.4` pin:** it only exists for Rails 7.0, so it can be relaxed afterwards. **Minitest 5 pin:** keep it; it works with 8.1.
- **csv warning:** a Ruby 3.4 stdlib warning, not related to Rails.

## Framework defaults by release

Today the app calls `load_defaults 7.0` and sets none of these explicitly, so it keeps every old value. The list below comes from 8.1's own `load_defaults` table. The gem-changes tool listed several 7.1, 7.2 and 8.0 settings that are no longer settable in 8.1: the BigDecimal serializer, `commit_transaction_on_non_local_return`, `enqueue_after_transaction_commit`, `to_time_preserves_timezone`, Parameters hash equality, and the after-commit ordering setting. Their old behaviour is gone, and findings 14, 17 and 18 cover the effect. The tool also missed all of the 8.1 defaults.

Executed result: with all defaults through 8.1, the suite fails in exactly three places until the fixes marked (A) below are applied. All three fixes also work on 7.0. After them, `load_defaults 8.1` is green.

**7.1**
- `raise_on_assign_to_attr_readonly` (A):
  - The notebook settings form resubmits `slug` (hidden field, and the controller permits `:slug`), so saving settings raises `ReadonlyAttributeError` (500).
  - Fix: remove `:slug` from `notebook_params`.
- `default_column_serializer = nil` (A):
  - `serialize :preferences` with no coder raises at class load.
  - Fix: `coder: YAML`. On 7.0 this resolves to the same `YAMLColumn`, which I checked, so stored data is unchanged.
- `raise_on_invalid_cache_expiration_time` (A):
  - In `exports/_export.html.erb`, `expires_in: expires_at - Time.current` is negative for an expired export. The exports page raises (500) whenever caching is on, as in production.
  - Even without this default, 8.1 drops the negative expiry and caches the fragment with **no expiry**, where 7.0 discarded it. Executed probe.
  - Fix: `expires_in: [export.expires_at - Time.current, 1.second].max`. This keeps the stale-fragment behaviour the test documents.
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`:
  - These change the format of signed and encrypted messages. That includes the signed global IDs stored inside Action Text bodies and Active Storage signed URLs. Session cookies use `cookies_serializer`, and whether the metadata setting also affects them is unverified.
  - 7.0 cannot read the new format. Enable only after every host runs ≥ 7.1, and treat it as a point of no easy rollback for rich text saved afterwards.
- `cache_format_version 7.1`: 7.0 can't read the new entries. The cache is the per-host default file store (`tmp/cache`), so this is low risk. Enable after full rollout.
- `marshalling_format_version 7.1`: no Active Record objects are cached. None.
- `sanitizer_vendor` HTML5 (Action View and Action Text): the suite passes. Already-stored rich text might render slightly differently. That's an open check (below).
- `dom_testing_default_html_version :html5`: tests pass. `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size` (development and test only): no functional effect.
- `default_headers`: drops `X-Download-Options`.
- `add_autoload_paths_to_load_path = false`: the app only requires stdlib. None.
- `belongs_to_required_validates_foreign_key = false`: tests pass.
- `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances`, `generate_secure_token_on`: the app has no `after_commit` callbacks or secure tokens. None.
- Encryption digest settings, `query_log_tags_format`, sqlite strict strings: not used.

**7.2**
- `postgresql_adapter_decode_dates` (A):
  - `Notebook#daily_note_counts` now gets `Date` objects, and `Date.iso8601(Date)` raises `TypeError`, so the activity report returns 500.
  - Fix: `day.to_date`.
- `validate_migration_timestamps`: the existing timestamps are valid. None.
- `web_image_content_types` adds webp: there's no `image_processing`, so the effect is minimal.
- `yjit`: memory usage only.
- `enqueue_after_transaction_commit` is not part of 8.1 defaults; it is `false` (executed). Keep it off. `Citation#request_enrichment` and `Note#schedule_reminder` rely on enqueueing inside the lock so a failed enqueue rolls back.

**8.0**
- `strict_freshness`: `ExportDownloadsController#stale?` sends an ETag (the blob checksum) and a Last-Modified. With this default only If-None-Match counts. The checksum is content-stable, so the risk is low.
- `Regexp.timeout = 1`: the import regexes are simple. Low.

**8.1**
- `escape_json_responses = false` and `escape_js_separators_in_json = false`: the app has no JSON views. None.
- `action_on_path_relative_redirect :raise`: there are no relative redirects. None.
- `raise_on_missing_required_finder_order_columns`: all models have primary keys. None.
- `render_tracker :ruby`: template digests may change, which busts fragment caches once.
- `remove_hidden_field_autocomplete`: changes markup only.

## Rollout and rollback
1. **Ship on 7.0 first.** These are findings 2, 3, 5–12 and 14–18, plus the (A) fixes and `coder: YAML`. All are verified green on 7.0 with no deprecation warnings (`test-7.0-prep-b.log`). They don't change stored data.
2. **Deploy 7.1.6 to every web and worker host.** Include `coder: JSON` and the `show_exceptions` change.
   - 7.1 with the old defaults still writes BigDecimal as a plain string, so 7.0 workers can read its jobs (executed).
   - 7.1 can read 8.1 job payloads (executed).
3. **Upgrade to 8.1 only after step 2 is complete.** This makes 7.1 the rollback target, not 7.0.
   - Reason: 8.1 always writes `BigDecimalSerializer` for `DigestJob`'s completion argument. **7.0 cannot read it** (`DeserializationError: Serializer ... BigDecimalSerializer is not known`, executed).
   - `DigestJob` has no `discard_on`, so on a 7.0 worker such jobs would fail and retry.
   - Jobs queued by 7.0 run fine on 8.1: the completion arrives as a String, which `BigDecimal()` handles, and the time arrives in UTC (executed).
   - If you ever add `discard_on ActiveJob::DeserializationError` to more jobs, as `NoteReminderJob` already has, a version mismatch would silently drop those jobs.
4. **Adopt defaults afterwards, one at a time,** with `new_framework_defaults` files. Turn on the message, cookie and cache format settings only once rollback to 7.0 is off the table.

## Not verified / open questions
- **System tests:** not run. They need a display and Chrome.
- **Production config:** not run in production mode. Precompiling assets with sprockets under 8.1 isn't verified.
- **Stored rich text under the HTML5 sanitizer:** proposed check is to render every `action_text_rich_texts.body` from a production snapshot with HTML4 and HTML5 and diff the output.
- **Signed global IDs in rich text:** proposed check is to confirm that IDs written after enabling `use_message_serializer_for_metadata` still resolve on 7.1, and to decide on rollback accordingly.
- **Which release changed `read_attribute(:id)` and `HashWithIndifferentAccess#stringify_keys`:** observed only on 8.1, and only 8.1's changelog was available locally. Both fixes work on 7.0, so this doesn't affect the plan.
- **Production `secret_key_base` and credentials:** I couldn't decrypt `config/credentials.yml.enc` (no master key). Confirm that production supplies `secret_key_base` from credentials or an environment variable.
- **Queued jobs in production:** check what is waiting in the Sidekiq queue, retry and scheduled sets (especially `DigestJob` and long-dated `NoteReminderJob`) before each step.
- **Product decisions:** reminder display (finding 18) and whether the stale export-availability fragment should still be served.

---

**My notes:** I've only planned the upgrade so far. Your repo is unchanged and nothing has been committed. The plan's main advice is not to jump straight from 7.0 to 8.1. Ship the fixes that work on 7.0 first, then deploy 7.1.6 everywhere, then move to 8.1. That way you can still roll back.

Before I implement it, I need two answers from you:
1. **Reminder display (item 18):** keep today's 09:00 −04:00 display across the daylight-saving change, or accept 8.1's zone-based time?
2. **Scope:** do you want all three steps, or only the first one (the fixes that work on 7.0) for now?