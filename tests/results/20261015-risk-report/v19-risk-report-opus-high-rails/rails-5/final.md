# Rails 7.0.8.7 to 8.1.0 upgrade risk for Margin Notes

The upgrade spans four release series (7.1, 7.2, 8.0, 8.1). I found seven high-risk changes, six medium and about fifteen low. The most serious one breaks a data guarantee: a failed CSV import would start saving part of the batch instead of nothing.

The existing test suite would catch several of the high-risk changes, but not the Action Text plain-text change, the Astana time zone change, the cache expiry change, or the problem when old and new job workers run side by side.

I worked from the 7.0.8.7 and 8.1.0 gem source, which I downloaded and unpacked into `/tmp/railsgems/src/{7.0.8.7,8.1.0}/`, the changelogs on the 7.1 to 8.1 stable branches, and a few pull requests. Each claim is tagged **[code]** (I read the 8.1.0 source), **[changelog]**, or **[inference]** (my reasoning, not verified). I did not run anything or change the application.

## Facts about the application the ratings depend on

Please correct any of these that are wrong.

- **Config defaults:** `config/application.rb:12` uses `config.load_defaults 7.0`. I assumed it stays at 7.0 for the upgrade. Raising it is a separate decision, covered below.
- **Database:** PostgreSQL only (`config/database.yml:18`). `citations` uses `doi` as its primary key and has no `id` column (`db/schema.rb:55`).
- **Jobs:** Active Job runs on Sidekiq 6.5.12 with the `redis` 4.8.1 gem (`config/application.rb:24`, `Gemfile`). Tests use the `:test` adapter. `ExportJob` is a plain Sidekiq job, not an Active Job.
  - Jobs are enqueued inside transactions and row locks (`citation.rb:15-23`, `note.rb:57-68`). The code relies on a failed enqueue raising an error.
  - `enqueue_after_transaction_commit` still defaults to `false` in 8.1 **[code]**, so this keeps working.
- **Cache:** none configured in production, so Rails falls back to its default file store at `tmp/cache` **[code]**. There is one fragment cache, in `app/views/exports/_export.html.erb:26`.
- **Rendering:** HTML through ERB, with Sprockets, importmap, Turbo and Action Text. The layout loads a vendored Trix 1.3.5 as a classic script (`layouts/application.html.erb:13`). `config/importmap.rb:8` pins `@rails/actiontext` to `actiontext.js`.
- **Time zones:** each reader has a time zone and the app depends on it in three places:
  - Reminder times use the reader's zone.
  - Digests deliberately follow the UTC day (described in `ARCHITECTURE.md`).
  - `next_day_reminder_at` deliberately keeps the reminder's UTC offset.
- **Secrets:** `config/secrets.yml` is read through `Rails.application.secrets` (`app/models/citation/provider.rb:13`).
- **Tests:** `config/environments/test.rb:31` sets `show_exceptions = false`, and several tests use `assert_raises` against requests.
- **Deployment:** I assumed a rolling deploy is possible, meaning web and worker processes on different Rails versions share one Redis queue for a while.

## High risk

### 1. Leaving a transaction with `return` now commits instead of rolling back
- **Before:** in 7.0, exiting a `transaction` block with `return` after a write rolled the transaction back **[code]** (`transaction.rb:336-342` in 7.0).
- **Now:** 7.2 removed that behavior. In 8.1 the block commits whenever no exception is raised **[code]** (`transaction.rb:643-677`).
- **Where:** `app/models/import.rb:53-58`. `Import#apply` runs `save!` and then `return false unless row.note.save` inside `transaction do`.
- **What goes wrong:** when a later row fails to save, the import record, the earlier rows' notes, and any new citations they autosaved are all committed. `ARCHITECTURE.md` promises "nothing from the batch remains".
  - `test/controllers/imports_controller_test.rb:48-73` would catch this.
  - The fix is to raise `ActiveRecord::Rollback`, or to return after the block.
- **Source:** [7-2-stable activerecord CHANGELOG](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md) ("Remove deprecated behavior that would rollback a transaction block when exited using `return`..."), and [PR #48600](https://github.com/rails/rails/pull/48600).

### 2. `DigestJob` now receives the request time in the reader's zone
- **Before:** 7.0 deserialized a TimeWithZone argument in the worker's zone (UTC) **[code]**.
- **Now:** since 7.1.3/7.2, the serializer stores `time_zone` and restores it on deserialization **[code]** (`activejob/lib/active_job/serializers/time_with_zone_serializer.rb`).
- **Where:** `app/models/user.rb:35,41` passes `Time.current.in_time_zone(time_zone)`. `app/mailers/digest_mailer.rb:8-9` then uses `requested_at.to_date` and `requested_at.all_day`.
- **What goes wrong:** the digest's date and its "notes updated that day" window become the reader's local day. The Redis reservation key is still the UTC date (`user.rb:36`).
  - Near local midnight, readers get the wrong day's notes and the wrong date in the subject line, with no error.
  - `test/controllers/digests_controller_test.rb:33` would catch the date change.
- **Source:** [PR #50240](https://github.com/rails/rails/pull/50240), and the 7-1-stable / 7-2-stable activejob changelogs.

### 3. `DigestJob`'s BigDecimal argument changes format, which breaks old workers during a mixed-version deploy
- **Before:** 7.0 passed a BigDecimal through as-is, and Sidekiq stored it as a string.
- **Now:** 7.2 removed that primitive path. 8.1 always wraps it as `{"_aj_serialized" => "ActiveJob::Serializers::BigDecimalSerializer", ...}` **[code]** **[changelog]**.
- **Where:** `user.rb:41` (`reading_completion`) and `digest_mailer.rb:10`. `BigDecimal(BigDecimal)` still works, so 8.1 on both sides is fine **[inference]**.
- **What goes wrong:** a 7.0 worker cannot look up that serializer class. It raises `ArgumentError`, which surfaces as `DeserializationError` **[code]** (7.0 `serializers.rb:42-43`).
  - Digest jobs enqueued by 8.1 web processes fail and are retried by Sidekiq until the workers are upgraded.
  - The reverse direction (7.0 payload read by an 8.1 worker) works.
  - The tests won't catch this. Upgrade workers first, or drain the queue.
- **Source:** [7-2-stable activejob CHANGELOG](https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md) ("Remove deprecated primitive serializer for `BigDecimal` arguments").

### 4. `TimeWithZone#to_time` now keeps the zone instead of the fixed offset
- **Before:** with 7.0 defaults, `getlocal(utc_offset)` returned a fixed offset, so adding 86,400 seconds kept the old offset across a daylight saving change.
- **Now:** 8.1 always uses `getlocal(time_zone)` **[code]** (`time_with_zone.rb:497-499`).
- **Where:** `app/models/note.rb:43-45` (`reminder_at.to_time + 86_400`), shown in `app/views/notes/_reminder.html.erb:19`.
- **What goes wrong:** across a daylight saving change, the "24 hours later" preview shows a different offset and clock time than today.
  - The instant is the same, and `postpone_reminder` uses `.to_i`, so the postponed reminder itself is unaffected **[inference]**.
  - `test/controllers/reminders_controller_test.rb:21` (expects `-04:00`) and `ARCHITECTURE.md` document the old behavior. The test would catch it.
- **Source:** [8.1.0 activesupport CHANGELOG](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md) ("Remove deprecated support for `to_time` to preserve the system local time"), and the 8-0-stable entry adding `:zone`.

### 5. The "Astana" time zone now maps to Asia/Almaty instead of Asia/Dhaka
- **What changed:** `ActiveSupport::TimeZone::MAPPING` diff **[code]**. Almaty is UTC+5 on current tzdata, Dhaka is UTC+6 **[inference]**.
- **Where:** stored `users.time_zone`, used by `user.rb:22` (`local_time`), `note.rb:37` (`reminder_at`), and the reminder views and email.
- **What goes wrong:** for readers set to "Astana", reminder times are displayed an hour off, and new reminders entered as local times map to different instants. There is no error and no test covers it.
- **Smaller mapping changes:** "Greenland" now maps to America/Nuuk and "Canberra" to Australia/Canberra. These are renames or aliases with the same rules **[inference]**. "Asuncion" is a new choice.
- **Source:** [PR #51317](https://github.com/rails/rails/pull/51317).

### 6. Action Text `to_plain_text` output changed
- **Before / now:** two differences **[code]**, from a diff of `actiontext/lib/action_text/plain_text_conversion.rb`. I found no changelog entry for them.
  - Ordered-list numbers now count element siblings only. In 7.0 they counted all child nodes, so whitespace between `<li>` tags inflated the numbers.
  - The contents of `<script>` and `<style>` are now dropped.
- **Where:**
  - Markdown exports: `app/models/export.rb:78`.
  - Note list previews: `app/views/notes/index.html.erb:53`.
  - Import previews: `app/views/imports/preview.html.erb:58`.
  - Imported `body_html` is stored unsanitized, so it can contain both of these.
- **What goes wrong:** exported files and previews for the same notes differ from today's output, with no error. No test covers lists or style tags.

### 7. A negative cache `expires_in` now means the fragment never expires
- **Before:** in 7.0 the entry was written already expired, so it was never served **[code]**.
- **Now:** in 8.1 the negative `expires_in` is deleted and an `ArgumentError` is logged and reported, so the entry is written with no expiry **[code]** (`cache.rb:922-924,937-945`). Raising instead requires 7.1 defaults.
- **Where:** `app/views/exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export has expired.
- **What goes wrong:** "Expired" fragments stay in the file store permanently, and each one logs an error when written. The content stays correct, so the practical impact is low **[inference]**. No test catches it.
- **Source:** [PR #45892](https://github.com/rails/rails/pull/45892).

## Medium risk

### 1. `Rails.application.secrets` was removed in 7.2
- **Before:** deprecated in 7.1 **[changelog]**. In 8.1 the method no longer exists **[code]**.
- **Where:** `app/models/citation/provider.rb:13`, the default argument, and `config/secrets.yml`.
- **What goes wrong:** citation enrichment fails at runtime, not at boot. Any test that runs the job would catch it.
- **Decision needed:** where these settings should live: credentials, `config_for`, or plain ENV. `ARCHITECTURE.md` also documents this setup.
- **Source:** [7-2-stable railties CHANGELOG](https://github.com/rails/rails/blob/7-2-stable/railties/CHANGELOG.md).

### 2. `ActionText::ContentHelper.allowed_tags` now defaults to `nil`
- **Before:** in 7.0 it was pre-filled with the sanitizer's tags plus `action-text-attachment`, `figure` and `figcaption`.
- **Now:** since 7.1 it is `nil`, and the defaults are computed at render time in `sanitizer_allowed_tags` **[code]**.
- **Where:** `config/initializers/action_text.rb:3` uses `+=`, which becomes `nil + Array` and fails at boot.
- **Trap:** the obvious fix, `allowed_tags = %w[details summary]`, would silently strip every other tag from rendered notes. The fix needs to rebuild the full default list.
- **Source:** [7-1-stable actiontext CHANGELOG](https://github.com/rails/rails/blob/7-1-stable/actiontext/CHANGELOG.md) (HTML5 sanitizer entry).

### 3. `show_exceptions = false` now behaves like `:all`
- **Before:** `false` meant exceptions were raised in tests.
- **Now:** support for booleans was removed in 7.2. `ExceptionWrapper#show?` falls through to `true` for anything that isn't `:none` or `:rescuable` **[code]**.
- **Where:** `config/environments/test.rb:31`.
- **What goes wrong:** tests silently get error pages instead of exceptions. `assert_raises` tests break, for example `digests_controller_test.rb:51` and `exports_controller_test.rb:126-127`, and other failures can be hidden behind error-page responses.
- **Decision needed:** `:none` keeps today's behavior. `:rescuable` is the new generator default.
- **Source:** [7-1-stable](https://github.com/rails/rails/blob/7-1-stable/actionpack/CHANGELOG.md) and 7-2-stable actionpack changelogs.

### 4. The built-in Sidekiq adapter is deprecated and will be removed in 8.2
- **What changed:** 8.1 logs a deprecation warning when `queue_adapter = :sidekiq` is set **[code]** (`sidekiq_adapter.rb:33`).
- **Where:** `config/application.rb:24`.
- **Decision needed:** the replacement is Sidekiq 7.3.3 or later, which ships its own adapter. That upgrade moves Sidekiq from the `redis` gem to `redis-client`, which affects:
  - the direct `Sidekiq.redis { |r| r.sadd/expire/srem }` calls in `user.rb:38-43`;
  - `rescue Redis::BaseError` in `notebook.rb:28`.
- **Compatibility note:** Sidekiq 6.5.12's Rails integration already handles the 7.1 logger API, so it works with 8.1 for now **[code]**. Its `rack ~> 2.0` constraint keeps Rack on 2.2, which 8.1 allows **[code]**.
- **Source:** [PR #53058](https://github.com/rails/rails/pull/53058).

### 5. Trix moved to version 2 in a separate gem
- **What changed:**
  - Action Text 7.1 moved to Trix 2 **[changelog]**. 8.1 depends on the `action_text-trix ~> 2.1.15` gem **[code]**.
  - `actiontext.js` is now a UMD bundle, with a separate `actiontext.esm.js` **[code]**.
- **Where:**
  - `*= require trix` in `app/assets/stylesheets/actiontext.css:6` will now resolve to the Trix 2.1.15 stylesheet, while the JavaScript is still the vendored Trix 1.3.5 (`layouts/application.html.erb:13`).
  - `config/importmap.rb:8` imports the UMD file. It probably still works through `globalThis` **[inference]**.
  - Upload errors now show an `alert` where 7.0 threw an exception **[code]**.
- **Decision needed:** adopt the bundled Trix 2 and drop the vendored copy, or vendor the Trix 1 stylesheet and pin `actiontext.esm.js`. This needs a check in the browser.

### 6. Whether to raise `load_defaults` later
Staying at 7.0 works. Each step up changes behavior this app depends on **[code]** (`railties/lib/rails/application/configuration.rb`):
- **7.1:**
  - `default_column_serializer = nil` makes `serialize :preferences` (`notebook.rb:7`) fail.
  - `raise_on_assign_to_attr_readonly` makes notebook updates fail, because the form resubmits the slug (`notebooks/_form.html.erb:13`, `notebook.rb:8`).
  - `raise_on_invalid_cache_expiration_time` makes the expired export page raise (high-risk item 7).
- **7.2:** `postgresql_adapter_decode_dates` returns `Date` objects, so `Date.iso8601(day)` in `notebook.rb:40` fails.
- **8.0:** `strict_freshness` changes how conditional GETs are evaluated (`export_downloads_controller.rb:11`).

## Low risk (mechanical; booting or the existing tests would catch these)

- `retry_on ... wait: :exponentially_longer` (`app/jobs/citation_enrichment_job.rb:7`): removed in 7.2, so the retry handler raises "Couldn't determine a delay" **[code]**.
  - If missed, the citation would stay pending through Sidekiq's own retries.
  - Rename to `:polynomially_longer` (same formula). `citation_enrichments_controller_test.rb:60` catches it.
- `set(wait_until: reminder_epoch)` with an Integer (`note.rb:61`): numeric `scheduled_at` was removed in 7.2, and `serialize` calls `Integer#utc`. Pass `Time.at(...)` instead **[code]**.
- `enum status: {...}, _prefix: true` (`note.rb:10`): the keyword form was removed in 8.0. Use `enum :status, {...}, prefix: true` **[changelog]** **[code]**.
- `serialize :tags, JSON` (`note.rb:12`): the positional coder was removed in 7.2. Use `coder: JSON` **[code]**.
- `alias_attribute :highlight_color, :color` (`note.rb:14`): `color` comes from `store_accessor`, not a column, and aliasing non-attributes now raises `ArgumentError`. Use `alias_method` for the reader and the writer **[code]**.
- `citation[:id]` (`import.rb:68`): no longer maps to the `doi` primary key (removed in 7.2) and raises `MissingAttributeError`. Use `citation.id` or `citation.doi` **[code]**.
- `form_with(model: nil, ...)` (`notes/index.html.erb:12`): raises `ArgumentError` since 8.0. Drop `model: nil` **[code]**.
- `get "/notes", "/journal", to:` (`config/routes.rb:18`): multiple paths raise `ArgumentError` in 8.1 ([PR #52409](https://github.com/rails/rails/pull/52409) deprecated it in 8.0). Split into two routes **[code]**.
- `fragments.sum` on strings (`export.rb:42`): Active Support's `Enumerable#sum` override was removed in 7.1, so this raises `TypeError`. Use `join` **[code]**. Export tests catch it.
- The JSON column coder now writes `<`, `>` and `&` unescaped in `tags` (`note.rb:12`). The decoded values are identical and both versions read both forms **[code]**.
- `Note.connection` (`notebook.rb:40`): soft-deprecated, with no warning by default **[code]**.
- `form.rich_text_area` (`notes/_form.html.erb:50`): now a plain alias of `rich_textarea`.
- Development and test `secret_key_base` now comes from `tmp/local_secret.txt` (or credentials) instead of `tmp/development_secret.txt` **[code]**. This invalidates development sessions and signed IDs in existing development data only. Production uses credentials or ENV as before.
- The `concurrent-ruby 1.3.4` and `minitest ~> 5.25` Gemfile pins still satisfy 8.1's requirements and can be revisited later.

## Judged not relevant

- **MySQL, SQLite, Trilogy and composite primary keys:** PostgreSQL only.
- **`enqueue_after_transaction_commit`:** still `false` by default in 8.1, and the app never sets it.
- **Action Cable:** no channels. The production Redis adapter accepts `redis` 4.
- **Action Mailbox:** loaded by `rails/all` but unused.
- **Active Storage variants, previews, libvips, S3, GCS and Azure:** no image processor and Disk service only.
- **JSON rendering changes** (escaping, `escape_json_responses`): the app serves no JSON.
- **Rack 3 and `:unprocessable_entity`:** Sidekiq 6.5 keeps Rack on 2.2.
- **Cache format:** the 7.0 format is still supported.
- **Built-in locales:** only gained keys. The `:long` and `:short` formats the app uses are unchanged.
- **`TimeZone#iso8601` and `#at`:** unchanged.
- **Pessimistic locking:** only a read-only guard was added.
- **Migrations:** the `[5.2]`, `[6.0]` and `[7.0]` versions are still supported.
- **Strict freshness and `default_headers`:** only change with newer `load_defaults`.

## One more consideration: 8.1.0 is not the latest 8.1 patch

8.1.0 lacks security fixes released afterwards in 8.1.2.1 and 8.1.3.1 **[changelog]**, several in parts this app uses:
- Active Storage Disk service path traversal and glob injection;
- metadata filtering in the direct-upload controller (open to anonymous users here);
- range-request limits;
- `NumberConverter`, which `number_to_human_size` and `number_to_percentage` use;
- `SafeBuffer#%` and the tag helpers.

Consider targeting the latest 8.1.x instead.

---

I haven't changed anything yet: the Gemfile still pins `rails` to 7.0.8.7. The report above covers what the upgrade would affect.

Before I start, I need these decisions from you:

1. **Which version:** exactly 8.1.0, or the latest 8.1.x patch with the security fixes listed in the last section?
2. **How to deploy:** can web and worker processes run different Rails versions at the same time? If so, high-risk item 3 means the workers need to be upgraded first or the queue drained.
3. **Behavior to keep:** for high-risk items 2, 4, 6 and 7, should I keep today's behavior or accept the new behavior? This covers the digest day, the reminder preview offset, the plain-text output and the cache expiry.
4. **Medium-risk choices:**
   - where the settings in `config/secrets.yml` should move;
   - whether `show_exceptions` should be `:none` or `:rescuable`;
   - how to handle Trix;
   - whether moving off the built-in Sidekiq adapter is part of this upgrade or a later one.