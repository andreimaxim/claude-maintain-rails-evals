I rated 6 changes high, 6 medium and 10 low. Ten changes alter behavior or break code that this app actually uses.

Several of the high-risk changes don't raise any error in production. The existing tests should catch five of the six. I compared the unpacked 7.0.8.7 and 8.1.0 gems and the 7.1, 7.2, 8.0 and 8.1.0 changelogs. Nothing in the app was installed, changed or run. Each claim is tagged **[changelog]**, **[code]** (gem or app source I read) or **[inference]**.

## Facts about the app these ratings depend on

- **Framework defaults stay at 7.0.** `config.load_defaults 7.0` (config/application.rb:12) is assumed to stay. M6 lists what breaks if you raise it.
- **Database:** PostgreSQL only (pg 1.6.0).
- **Background jobs:** Active Job uses `:sidekiq` (config/application.rb:24) with Sidekiq 6.5.12 and redis 4.8.1. Tests use `:test`. `ExportJob` is a plain Sidekiq job.
- **Rolling deploys:** I assume old and new workers can share Redis during a deploy. If you stop every worker first, the mixed-version part of H4 doesn't apply.
- **Caching:** production has caching on and no `cache_store` set, so it uses the default file store. Tests use the null store with caching off.
- **Front end:** HTML only (ERB, Sprockets, importmap, Turbo). Action Text runs with a vendored Trix 1.3.5 loaded as a classic script. Active Storage uses the local disk.
- **Not used:** JSON responses, Action Cable channels, Action Mailbox, Active Record encryption.
- **Time zones:** `users.time_zone` stores Rails zone names like "Eastern Time (US & Canada)".
- **Dependencies:** Rails 8.1 accepts your current pins (Ruby 3.3.6, rack 2.2.24, concurrent-ruby 1.3.4, minitest ~> 5.25, pg). It adds action_text-trix (~> 2.1.15), rack-session, rackup and useragent. **[code: gemspec metadata]**

## High

**H1. Leaving a transaction with `return` now commits instead of rolling back (7.2)**
- **Before:** if the block had written anything and exited early, Rails rolled back. **[code: old transaction.rb:336-342]**
- **Now:** it commits. **[code: new transaction.rb:655-668]** **[changelog: [7-2-stable activerecord](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md), "Remove deprecated behavior that would rollback…", PR #48600]**
- **Where:** `app/models/import.rb:53-58` has `return false unless row.note.save` inside `transaction do`.
- **What could go wrong:** if any row fails during apply, the import and the rows before it are saved. Meanwhile the controller shows the preview again with a 422 (`imports_controller.rb:12-19`). Submitting again creates duplicates. ARCHITECTURE.md promises the opposite. The test at `test/controllers/imports_controller_test.rb:48-72` should catch it.

**H2. `record[:id]` no longer returns a custom primary key (7.2)**
- **Before:** `read_attribute(:id)` returned the primary key.
- **Now:** it reads a column literally named `id`. `citations` has none, so the result is `nil`. **[code: new read.rb:29-34, attribute_set.rb]** **[changelog: PR #49019, removed in 7.2]**
- **Where:** `app/models/import.rb:68` (`citation && citation[:id]`).
- **What could go wrong:** the receipt CSV's DOI column comes out silently blank. The test at `imports_controller_test.rb:44-45` should catch it.

**H3. `HashWithIndifferentAccess#stringify_keys` now converts every key to a string (8.0)**
- **Before:** it only converted symbol keys, so integer keys stayed integers.
- **Now:** integer keys become strings. **[changelog: PR #53125]** **[code: the override was removed]**
- **Where:**
  - `app/models/import.rb:38-42` keys annotations by integer line number.
  - `app/views/imports/preview.html.erb:22` calls `.stringify_keys`.
  - Line 42 then looks them up with an integer.
- **What could go wrong:** annotations silently disappear from the import preview. The test at `imports_controller_test.rb:21-24` should catch it.

**H4. Active Job keeps a time's zone, and BigDecimal job arguments use a new format (7.1.3 / 7.2)**
- **Before:** a time with zone was rebuilt in the worker's zone (UTC). A BigDecimal was sent as a plain string.
- **Now:**
  - The serializer stores the zone name and the job rebuilds the time in the reader's zone.
  - BigDecimal has its own serializer. **[code: new time_with_zone_serializer.rb, big_decimal_serializer.rb]** **[changelog: [7-1-stable activejob](https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md) 7.1.3; [7-2-stable activejob](https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md) "Remove deprecated primitive serializer for BigDecimal"; PR #45618]**
- **Where:**
  - `app/models/user.rb:35,41` enqueues the digest job.
  - `app/jobs/digest_job.rb:6-7` passes the time through.
  - `app/mailers/digest_mailer.rb:8-9` uses `requested_at.to_date` and `.all_day`.
- **What could go wrong (one version running):** for non-UTC readers, the digest's date and note list follow their local day. That no longer matches the UTC reservation key (`user.rb:36`) or the "today (UTC)" hint (`notes/index.html.erb:10`). The test at `digests_controller_test.rb` (subject "October 05, 2026") should catch it. `BigDecimal(params[:completion])` keeps working. **[inference]**
- **What could go wrong (old and new running together):**
  - A 7.0 worker cannot load a digest job queued by 8.1, because of the BigDecimal format. It raises `DeserializationError`, and since there's no `discard_on`, Sidekiq retries it, so the digest is late.
  - Jobs queued by 7.0 still deserialize in UTC under 8.1.

  **[inference from code]**

**H5. `TimeWithZone#to_time` now keeps the zone, not just the offset (8.0 / 8.1)**
- **Before:** the result had a fixed offset (`getlocal(utc_offset)`).
- **Now:** it is `getlocal(time_zone)`, so adding seconds recalculates the offset. **[code: new time_with_zone.rb:497-498]** **[changelog: [8.1.0 activesupport](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md) "Remove deprecated support for `to_time`…"]**
- **Where:** `app/models/note.rb:43-45`, displayed at `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:** across a daylight-saving change, the "24 hours later" preview now shows the new offset and wall-clock time (e.g. `08:00-05:00` instead of `09:00-04:00`). The moment in time is the same. This arguably fixes a quirk ARCHITECTURE.md documents, but it changes output silently. The test at `reminders_controller_test.rb:21` asserts the old value.

**H6. Some Rails time-zone names map to different tz zones (7.2)**
- **The change:**
  - "Astana" changes from Asia/Dhaka to Asia/Almaty.
  - "Canberra" now maps to Australia/Canberra and "Greenland" to America/Nuuk.
  - "Asuncion" is new.

  **[code: diff of values/time_zone.rb]** **[changelog: 7-2-stable activesupport]**
- **Where:** `user.rb:13,22`, `note.rb:37`, `accounts/edit.html.erb:15`.
- **What could go wrong:** readers set to "Astana" would likely get UTC+5 instead of +6. Their entered and displayed reminder times would shift by an hour. Already-scheduled jobs keep their stored times. Canberra and Greenland follow the same rules as before. **[inference]**
- **To check:** count users with `time_zone = 'Astana'`.

## Medium

**M1. `Rails.application.secrets` is removed (deprecated 7.1, removed 7.2)**
- **The change:** `config/secrets.yml` is now silently ignored. **[code: no `secrets` in new railties]** **[changelog: 7-2-stable railties]**
- **Where:**
  - `app/models/citation/provider.rb:13` raises `NoMethodError` inside the job.
  - The tests use it at `citation_enrichments_controller_test.rb:45,117-122`.
- **The decision:** choose a replacement, such as `config_for`, credentials, or reading ENV directly.
  - Encrypted credentials can't read ENV.
  - Whichever you choose must still quote values like `"00123"` and `"sample: value # keep"`, which the `.to_json` in secrets.yml does today.

**M2. `ActionText::ContentHelper.allowed_tags` now starts as `nil` (7.1)**
- **The change:** `config/initializers/action_text.rb:3` (`+=`) raises `NoMethodError` at boot. **[code: new content_helper.rb:10,68-70]** **[changelog: 7-1-stable actiontext]**
- **The decision:** the fix has to rebuild the whole list, for example `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`. If any of those defaults is left out, rendered rich text silently loses its attachments.

**M3. Rails' built-in Sidekiq adapter is deprecated (8.1), and Rails 8.2 removes it**
- **The change:** the adapter still works with Sidekiq 6.5.12. **[code: new sidekiq_adapter.rb]** **[changelog: 8.1.0 activejob, PR #53058]**
- **Where:** `config/application.rb:24`.
- **The decision:** moving to Sidekiq 7.3.3 or later replaces redis-rb with redis-client. That would likely break two things:
  - `redis.sadd` at `user.rb:38` would return an Integer, which is always truthy, so the once-per-day digest check would stop working.
  - The `rescue Redis::BaseError` at `notebook.rb:28` would stop matching Redis errors.

  **[inference]**

**M4. Trix 2 now comes from the `action_text-trix` gem (8.1)**
- **The change:**
  - `*= require trix` in `app/assets/stylesheets/actiontext.css:6` now loads Trix 2.1.15's CSS, while `layouts/application.html.erb:13` still loads the vendored Trix 1.3.5 JavaScript.
  - `config/importmap.rb:8` points at `actiontext.js`, which is now a UMD build. Rails 7.1+ ships `actiontext.esm.js` for import maps.

  **[code]** **[changelog: 8.1.0 actiontext]**
- **What could go wrong:** the editor's styling won't match its JavaScript, with no error raised. It needs checking in a browser.
- **The decision:** adopt Trix 2, or keep 1.3.5 together with its own CSS.

**M5. A negative cache `expires_in` is now dropped and logged as an error (7.1)**
- **Where:** `app/views/exports/_export.html.erb:26` (`export.expires_at - Time.current`).
- **What changes:** for an export that has already expired, the "Expired" fragment is now cached with no expiry, and each such write logs an `ArgumentError`. What users see stays correct. **[code: new cache.rb:922-925]** **[inference on impact]**
- **What could go wrong:** with the 7.1 default `raise_on_invalid_cache_expiration_time = true`, the exports page would raise instead. Tests don't run with caching on, so they won't notice.

**M6. Newer framework defaults that would break this app if you raise `load_defaults`** **[code: railties configuration.rb]**
- **7.1 `raise_on_assign_to_attr_readonly`:** every notebook settings save raises, because the form resubmits the read-only `slug` (`notebooks_controller.rb:40`, `notebooks/_form.html.erb:13`). It raises even when the value is unchanged (`readonly_attributes.rb:49-63`).
- **7.1 `default_column_serializer = nil`:** `serialize :preferences` (`notebook.rb:7`) raises unless you add `coder: YAML`.
- **7.1 HTML5 sanitizer:** changes which tags rich text keeps.
- **7.1 cache and message format versions:** old Rails can't read the new format, which matters if you roll back.
- **7.2 `postgresql_adapter_decode_dates`:** `Date.iso8601(Date)` at `notebook.rb:40` raises a `TypeError`, so the activity page fails.
- **8.0 `strict_freshness`:** `ETag` takes precedence over `Last-Modified` in `export_downloads_controller.rb:11`.

## Low (each raises an error, and tests or boot should catch it)
- **`serialize :tags, JSON`:** change to `coder: JSON` (`note.rb:12`). Removed in 7.2.
- **Keyword-style enum:** `enum status: …, _prefix: true` becomes `enum :status, {…}, prefix: true` (`note.rb:10`). Removed in 8.0.
- **`alias_attribute :highlight_color, :color`:** raises because `color` is a store accessor, not an attribute. Use `alias_method` for the reader and writer (`note.rb:14`). Removed in 7.2.
- **`wait: :exponentially_longer`:** raises only when a retry happens. Rename it to `:polynomially_longer` (`citation_enrichment_job.rb:7`). Removed in 7.2.
- **`set(wait_until: reminder_epoch)` with an Integer:** raises `NoMethodError` (`#utc`). Wrap it in `Time.at` (`note.rb:61`). Removed in 7.2.
- **`fragments.sum` on strings:** now raises `TypeError`. Use `join` (`export.rb:42`). Removed in 7.1; the exports test drains the job and will catch it.
- **A route with two paths:** `get "/notes", "/journal"` raises `ArgumentError`. Split it into two routes (`routes.rb:18`). Removed in 8.1, PR #52409.
- **`form_with(model: nil, …)`:** raises. Drop `model: nil` (`notes/index.html.erb:12`). Removed in 8.0.
- **`show_exceptions = false`:** is now treated as `:all`, so the 23 `assert_raises` in tests fail. Use `:none` (`environments/test.rb:31`). Removed in 7.2.
- **Development secret file:** moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`. Dev sessions reset, and attachments already stored in dev rich text stop resolving. Dev only.
- **Action Text plain-text conversion rewritten (no error raised):** `<script>` and `<style>` text is now dropped, and ordered-list numbers are counted from list items only. Export Markdown and note excerpts may differ slightly. **[code]**

## Not relevant
- **MySQL, SQLite and Trilogy changes:** the app uses PostgreSQL.
- **Composite primary keys and encryption:** not used. Only H2 touches the DOI primary key.
- **`enqueue_after_transaction_commit`:** stays off by default in 8.1. Don't turn it on: `request_enrichment` and `schedule_reminder` rely on queuing jobs inside the lock.
- **Redis, Memcache and Solid Cache store changes:** the app uses the file, memory and null stores.
- **Action Cable, Action Mailbox, cloud Active Storage services and image variants:** not used.
- **JSON rendering and escaping changes, and the new `remote_ip` rules:** the app has no JSON responses and doesn't read `remote_ip`.
- **Rack 3 changes:** the app stays on rack 2.2.
- **Generator-only features:** Solid Queue/Cable/Cache, Kamal, Propshaft, the authentication generator, `bin/ci`.

ARCHITECTURE.md describes several of the old behaviors (UTC digest days, the offset in the reminder preview, Trix 1.3.5, secrets.yml). Update it once you decide on each.

Everything I compared is in `/tmp/gemcmp`:
- `/tmp/gemcmp/old` and `/tmp/gemcmp/new`: the unpacked 7.0.8.7 and 8.1.0 gems.
- `/tmp/gemcmp/cl`: the changelogs. The 7-2-stable and 8-0-stable files also include releases made after 8.1.0; I checked the 8.1.0 source wherever that mattered.
- `/tmp/gemcmp/sk`: Sidekiq 6.5.12.
- `/tmp/gemcmp/trix`: action_text-trix 2.1.15.
- `/tmp/gemcmp/mid`: Active Job 7.2.2 and 8.0.3.

---

I haven't changed anything yet; the Gemfile still pins `gem "rails", "7.0.8.7"`. The report above comes from a review agent, and I haven't re-checked its claims myself. This upgrade spans four minor versions (7.0 → 8.1), so it's a bigger job than a version bump.

Before I start, these need your decisions:

1. **H4:** Are you willing to stop all Sidekiq workers during the deploy? If not, digest jobs will fail and retry while old and new versions run side by side. Also, should the digest follow each reader's local day or stay on UTC?
2. **H5:** Do you want the new reminder-preview output across daylight-saving changes? If so, the test and ARCHITECTURE.md need updating.
3. **M1:** What should replace `secrets.yml`: `config_for`, credentials, or ENV?
4. **M4:** Should the editor move to Trix 2, or stay on 1.3.5 with its own CSS?
5. **M3:** Upgrading Sidekiq is optional for 8.1, so I'd leave it for later.
6. **M6:** I'd also leave `load_defaults` at 7.0 for now.

Tell me how to proceed and I'll start. One way is to go version by version (7.1 → 7.2 → 8.0 → 8.1), running the tests and the browser suite at each step.