# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

On 8.1.0 the app as it stands fails at boot. After 19 repairs, 18 of which I applied and tested, the full suite passes (46 runs, 340 assertions, 0 failures). Ten of those repairs also work on 7.0 and can ship first as a preparatory change; the rest have to ship with the upgrade itself. Keep `load_defaults 7.0` for the upgrade deploy; adopting 7.1+ defaults needs four more fixes and has a rollback hazard. The working repo was not modified (`git status` is clean).

**How I tested.** I used three clones under `/tmp/up`:
- `base`: Rails 7.0.8.7, unchanged.
- `up`: Rails 8.1.0 plus repairs.
- `prep`: 7.0.8.7 plus the portable repairs.

Each clone had its own Postgres databases (`mnup_*`, dropped afterwards) and a private Redis on port 6391 (separate db per variant, shut down afterwards). Each also had its own Active Storage directory and `tmp/mails`, and both servers used the same `SECRET_KEY_BASE`. For the mixed-version tests, the shared database was `mnup_roll_development` with Redis db 3.

Resolved for 8.1.0 (`bundle update rails --conservative`): rails 8.1.0, action_text-trix 2.1.19, rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, minitest 5.27.0, importmap-rails 2.2.3, turbo-rails 2.0.12. json first resolved to 3.1.0, then 2.21.2 after pinning.

Repair diffs are in `/tmp/up/up-repairs.diff` and `/tmp/up/adoption-repairs.diff`. The upgraded copy's git history in `/tmp/up/up` has each step.

## A. Required with the upgrade, ordered by how they surfaced

Each finding marks whether the repair also works on 7.0, based on running the suite in `prep` (`/tmp/up/prep-test.log` and `prep-test2.log`: 46 runs, 0 failures).

**1. json 3.x breaks Active Support 8.1.0** (`Gemfile`). Bundler pulled in json 3.1.0. Every session read then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291` via `active_support/json/decoding.rb:25`, so every signed-in page returns 500 (`/tmp/up/up-test4.log`).
- **Repair:** add `gem "json", "< 3"`.
- **Check:** with the pin, sign-in and the note list work. Control: the cookie round-trip in section B.
- **Open question:** whether a later 8.1.x release no longer needs the pin.

**2. Action Text tag allowlist is nil at boot** (`config/initializers/action_text.rb`). Boot aborts with ``NoMethodError: undefined method `+' for nil``, because 7.1+ leaves `ActionText::ContentHelper.allowed_tags` nil.
- **Repair** (works on 7.0):
  ```ruby
  Rails.application.config.after_initialize do
    helper = ActionText::ContentHelper
    defaults = helper.allowed_tags || (helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])
    helper.allowed_tags = defaults + %w[ details summary ]
  end
  ```
- **Check:** the test "rich text keeps collapsible excerpts and drops unsafe markup" passes on 7.0, on 8.1, and under 7.1 through 8.1 defaults.

**3. Keyword-style `enum`** (`app/models/note.rb:10`). `ArgumentError: wrong number of arguments (given 0, expected 1..2)`.
- **Repair** (works on 7.0): `enum :status, { draft: 0, ready: 1 }, prefix: true`.

**4. Positional serializer coder** (`app/models/note.rb:12`). `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- **Repair:** `serialize :tags, coder: JSON`.
- **Do not ship this on 7.0.** There `coder:` is silently ignored: tags were read back as the raw String `"[\"x\",\"y\"]"`, and writes would store YAML in a JSON column.
- **Check:** both versions read and write the same rows (section B).

**5. `alias_attribute` to a store accessor** (`app/models/note.rb:14`). ``ArgumentError: Note model aliases `color`, but `color` is not an attribute``. This hits every Note load.
- **Repair** (works on 7.0): `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
- **Check:** the notes create and update tests that post `highlight_color` pass.

**6. One route with two paths** (`config/routes.rb:18`). `Wrong number of arguments (expect 1, got 2)` when routes load.
- **Repair** (works on 7.0): split into two `get` lines.
- **Check:** `/notes` and `/journal` both return 200 on the 8.1 server.

**7. `Rails.application.secrets` was removed** (`app/models/citation/provider.rb:13`, `config/secrets.yml`, and the citation test). `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`.
- **Repair** (works on 7.0):
  - Move the YAML to `config/citation_provider.yml`.
  - In `config/application.rb`, add `config.x.citation_provider = config_for(:citation_provider)`.
  - Read it with `Rails.configuration.x.citation_provider.to_h`.
  - Point the test at `Rails.configuration.x.citation_provider`.
- In production with no environment variables, the result is still `{url: nil, ...}`, so "No citation provider is configured" behaves as before.
- **Check:** the "credentials from the environment reach the server unchanged" test, which boots a fresh process.

**8. `show_exceptions = false` in tests** (`config/environments/test.rb:31`). On 8.1, `false` makes error pages render, so 7 `assert_raises(RecordNotFound)` tests failed and real errors were hidden as 500s.
- **Repair:** `:none`.
- **Not portable:** on 7.0, `:none` broke `notebooks_controller_test.rb:44` (`/tmp/up/prep-none.log`).

**9. `form_with(model: nil)`** (`app/views/notes/index.html.erb:12`). `ActionView::Template::Error: Passed nil to the :model argument`, so the whole note list fails.
- **Repair** (works on 7.0): drop `model: nil`.

**10. Plural name for a singular association** (`app/controllers/notes_controller.rb:12`). The notebook filter fails with `PG::UndefinedColumn: column notes.notebooks does not exist`.
- **Repair** (works on 7.0): `where(notebook: @notebook)`.

**11. Import preview loses annotations without an error** (`app/views/imports/preview.html.erb`). `HashWithIndifferentAccess#stringify_keys` now turns the integer line keys into strings, so `annotations[row.line]` misses and annotations vanish. The test saw "not-a-doi" where "Second reading" should be.
- **Repair** (works on 7.0): use `@import.annotations` without `.stringify_keys`.

**12. Integer passed to `wait_until`** (`app/models/note.rb:61`). ``NoMethodError: undefined method `utc' for an instance of Integer``. This breaks scheduling, imported reminders and postponing.
- **Repair** (works on 7.0): `set(wait_until: Time.at(reminder_epoch))`.
- **Check:** the job's `:at` still equals the exact epoch (1_793_451_617).

**13. `Array#sum` on strings** (`app/models/export.rb:42`). `TypeError: String can't be coerced into Integer`. Every export job fails and the export is left in "working" status.
- **Repair** (works on 7.0): `fragments.join`. It also removes the 7.0 deprecation.
- Exports already queued or retrying succeed once the repair is deployed.

**14. `retry_on wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`). `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised only when the provider is unavailable. The `fail_enrichment` block never runs, so the citation stays "pending" and `request_enrichment` keeps answering "already being fetched".
- **Repair:** `:polynomially_longer`. It uses the same formula plus jitter.
- **Not portable:** 7.0 raises the same error for the new name. A lambda would work on both versions but loses the jitter.
- **Check:** "a provider that stays unavailable… leaves a visible failure". The 8.1 worker retried a 7.0-enqueued job after about 10 s.

**15. Import receipt CSV loses DOIs without an error** (`app/models/import.rb:68`). `citation[:id]` no longer returns the custom primary key, so the receipt became `On idleness,` instead of `On idleness,10.1000/Essays.1`.
- **Repair** (works on 7.0): `note.citation_doi`.

**16. Invalid imports are now partly committed** (`Import#apply`). A `return` inside `transaction` now commits. Record counts went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`: an import row, a note and a citation were saved from an invalid file.
- **Repair** (works on 7.0):
  ```ruby
  transaction do
    save!
    raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }
    true
  end || false
  ```
- **Check:** the invalid-rows test (counts unchanged) plus the valid-import test as control.

**17. "24 hours later" preview changes across DST** (`Note#next_day_reminder_at`). In 8.1, `to_time` keeps the zone regardless of `load_defaults`. The preview changed from `2026-11-01T09:00:00-04:00` to `2026-11-01T08:00:00-05:00`; the epoch is unchanged (1793538000), so the postponed job's time is the same.
- **Repair** (works on 7.0): `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.

**18. Digest covers the reader's local day instead of the UTC day** (`DigestMailer#daily_digest`). Since 7.1, Active Job keeps the time zone of a `TimeWithZone` argument. The subject came out as "October 04" instead of "October 05", which contradicts the per-UTC-day reservation and the comment.
- **Repair** (works on 7.0): `requested_at = params[:requested_at].in_time_zone(Time.zone)`.
- Jobs queued by 7.0 carry no `time_zone`, so they already deserialize in UTC.

**19. Trix JS and CSS versions now differ — needs a decision.** This one has no tested repair.
- The layout still loads the vendored `trix-1.3.5.js`. Under 8.1, `*= require trix` serves Trix 2 CSS from action_text-trix 2.1.19 (observed in the served stylesheet), and `actiontext.js` is now a UMD bundle.
- The layout comment's reason for vendoring (a bug in Trix 1.3.4) no longer applies, because 8.1 ships Trix 2.
- **Recommended:** pin `trix` from action_text-trix, import it, and delete `vendor/javascript/trix-1.3.5.*` and its include tag. Keeping 1.3.5 would mean also vendoring its CSS.
- **Not verified:** there is no browser in this environment. Run `bin/rails test:system` and do a manual check: edit a note that has a link and an attachment, upload a file, then save and reload. It should fail on visual or attachment behavior before the change and pass after.

## B. Mixed-version rollout and rollback (tested in the shared database)

- **BigDecimal job argument (needs a preparatory change).** A 7.0 worker given an 8.1 DigestJob failed with `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The reader's Redis reservation stays set, so they can't re-request that day.
  - **Repair** (works on 7.0): `DigestJob.perform_later(self, requested_at, reading_completion.to_s)`. The payload is then the plain `"0.25"` string under both versions. A 7.0 worker processed it and sent "25% of your notes were ready".
  - Without it, a rollback would also strand 8.1 payloads sitting in the retry set.
- **Other jobs work in both directions:** 7.0-enqueued Digest, Export, Citation and Reminder jobs ran on an 8.1 worker, and an 8.1-scheduled reminder ran on a 7.0 worker.
- **Serialized columns** (`tags` JSON, `preferences` YAML, `settings` jsonb) read and write identically in both directions under the retained defaults.
- **Sessions:** a 7.0 cookie works on 8.1 and the reverse. In development only, the secret file moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`, so local sessions reset.
- **Downloads:** the ETag is identical (`W/"7bf13e5b…"`) on both versions, and conditional GETs behave the same.
- **Suggested order:**
  1. Deploy the portable repairs (2, 3, 5–7, 9–13, 15–18, the BigDecimal change, and the adoption repairs in section C) on 7.0.
  2. Upgrade with 1, 4, 8, 14 and 19.
  3. Adopt new defaults only later.

## C. New framework defaults

None of these are set explicitly. With `load_defaults 7.0` the app keeps the old value for each.

**7.1** (the change summary missed the first three):
- `add_autoload_paths_to_load_path`, `cache_format_version 7.1`, `default_headers`: the cache is a per-host file store, so this is low risk.
- `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata` — **rollback hazard, tested.** An attachment SGID written under 7.1 defaults crashed a 7.0 reader with ``NoMethodError: undefined method `unpack1' for nil`` at `messages/metadata.rb:54`. Adopt only once a return to 7.0 is no longer possible.
- `default_column_serializer nil` — blocks boot: ``missing keyword: :coder``. Repair: `serialize :preferences, coder: YAML`; on 7.0 it only works by accident.
- `raise_on_assign_to_attr_readonly` — `ReadonlyAttributeError: slug` on notebook update. Repair (works on 7.0): drop `:slug` from `notebook_params`; create still derives the slug.
- `raise_on_invalid_cache_expiration_time` — "Cache expiration time is invalid, cannot be negative: -60.0" on the exports page. A past `expires_at` raises too. Repair (works on 7.0): `expires_in: [export.expires_at - Time.current, 1.second].max`. This keeps the tested stale-indicator behavior.
- HTML5 sanitizers and `dom_testing html5`: tests pass.
- `belongs_to_required_validates_foreign_key`, the callback-order flags, `generate_secure_token_on`, encryption digests, `sqlite3` strings, `query_log_tags_format`, `precompile_filter_parameters`, `log_file_size`, `debug_exception_log_level`: no affected usage found (source only).
- `marshalling_format_version`: same rollout caveat as the cache format.

**7.2:**
- `postgresql_adapter_decode_dates` — `TypeError: no implicit conversion of Date into String` in `Notebook#daily_note_counts`. Repair (works on 7.0): `Date.iso8601(day.to_s)`.
- `yjit` (memory), `web_image_content_types` (no variants are used), `validate_migration_timestamps` (all timestamps are valid): no effect expected.
- `enqueue_after_transaction_commit`: the setting was removed in 8.1, and its effective value was `false` under every defaults version. The app depends on enqueueing inside `with_lock`, so do not opt in per job.

**8.0:**
- `strict_freshness`: only an If-None-Match match combined with an old If-Modified-Since would change (200 becomes 304). Not executed.
- `Regexp.timeout = 1` (the summary missed it): low risk.

**8.1** (the summary listed none of these):
- `escape_json_responses` and `escape_js_separators_in_json`: the app has no JSON endpoints.
- `action_on_path_relative_redirect :raise`: all redirects use path helpers.
- `raise_on_missing_required_finder_order_columns`: every model has a primary key.
- `render_tracker :ruby`: one-time fragment cache misses.
- `remove_hidden_field_autocomplete`: markup only.
- `yjit` off for local environments.

The ladder run (`/tmp/up/defaults-*.log`, then `/tmp/up/adopt-{7.0,8.1}.log`) passed 46/46 under both 7.0 and 8.1 defaults with these repairs.

These settings were removed or are always on in 8.x, so they can't be kept at the old value: parameters-hash equality, the BigDecimal serializer, committing on non-local return (finding 16), singular association names, and `to_time_preserves_timezone` (deprecated; finding 17).

## D. Optional follow-ups and open questions

- **Sidekiq adapter.** 8.1 warns: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq` gem to version 7.3.3 or later". Two things will need fixing then (from reading the source, not tested):
  - Sidekiq 7's strict arguments will reject `ExportJob.perform_async(export.id, { format: "markdown" })`, which already logs a warning today.
  - With redis-client, `sadd` returns an Integer, so `if Sidekiq.redis { … sadd … }` is always true and the once-a-day digest guard breaks. redis 4.8.1 already warns about this.
- **Ruby 3.4 preparation:** add `csv` (plus `mutex_m`/`bigdecimal`, which matter for 7.0 only).
- **Soft deprecations:** `Note.connection` (use `with_connection`), `cache_classes` (use `enable_reloading`). Running `bin/rails app:update` would bring in the new-defaults files.
- **Unverified:** browser and Trix behavior (19); whether the json pin is still needed on later patch releases; production cache and storage topology, and whether web and worker deploys overlap.

Logs are in `/tmp/up`:
- Change summary: `changes.txt`.
- Bundles: `bundle-up*.log`, `lock-diff.txt`.
- Test runs: `base-test.log`, `up-test1.log` through `up-test9.log`, `prep-*.log`, `defaults-*.log`, `adopt-*.log`.
- Workers: `base-sidekiq-*.log`, `up-sidekiq-on-base-payload.log`, `up-payloads.txt`.
- Servers: `base-server.log`, `up-server.log`.
- SGID rollback: `base-read-sgid.log`.
- Production boot: `up-prod-*.log`.
- Probe scripts: `/tmp/up/scripts/`.

---

**My notes:** I haven't upgraded anything yet. The upgrade skill only produces a plan, so your repo on `main` is unchanged. The planner made and tested its repairs in throwaway clones under `/tmp/up`.

The upgrade can't be just a version bump. On 8.1.0 the app as it is now fails at boot, and it needed 19 repairs to pass the test suite. The Trix change (item 19) also needs a decision from you and a check in a real browser, which couldn't be done here.

If you want me to go ahead, I'd recommend two steps:
1. **A preparatory commit on Rails 7.0** with the repairs that also work there.
2. **The upgrade commit:** the Rails bump, the json pin, and items 4, 8, 14 and 19.

I'd keep `load_defaults 7.0` until you no longer need to be able to roll back to 7.0. Tell me if I should start with step 1.