# Rails upgrade risk report for Margin Notes: 7.0.8.7 to 8.1.0

I found 8 high-risk changes, 5 medium ones, and a group of new framework defaults to decide on. Most of the high ones change behavior with no error. One of them saves partial CSV imports. The existing tests would catch several of them, and I name those tests where they apply.

**How I worked:** I downloaded and diffed the 7.0.8.7 and 8.1.0 gems for every Rails component. I also read the 7-1, 7-2, 8-0 and 8-1 stable changelogs; for 8.1 I counted only entries up to the 8.1.0 release. Nothing in the app was installed, run or changed. Each claim is tagged **[changelog]**, **[code]** (I read the gem source), or **[inference]**.

## 1. Facts about the app that the ratings depend on (please correct any that are wrong)

- **Defaults:** `config.load_defaults 7.0` (config/application.rb:12). I assume you keep it at first; newer defaults are covered in section 3.
- **Database:** PostgreSQL only (pg 1.6.0). Ruby 3.3.6, which meets 8.1's minimum of 3.2.
- **Background jobs:** Active Job runs on Sidekiq 6.5.12 with redis 4.8.1, using Rails' built-in `:sidekiq` adapter (config/application.rb:24). Tests use the `:test` adapter. `ExportJob` is a native Sidekiq job.
- **Assumption about deploys:** web processes and Sidekiq workers may briefly run different Rails versions, and reminder jobs sit in Sidekiq's scheduled set for days.
- **Front end:** a full-stack HTML app (Sprockets, importmap, Turbo), with no JSON endpoints.
  - Action Text uses a **vendored Trix 1.3.5** (layouts/application.html.erb:13).
  - Uploads go to Active Storage on local disk.
- **Cache:** production sets no cache store, so it uses the default file store. The exports page uses fragment caching.
- **Secrets:** citation-provider settings come from `config/secrets.yml` through `Rails.application.secrets`. `secret_key_base` is not in secrets.yml.
- **Time zones:** `users.time_zone` stores Active Support zone names such as "Eastern Time (US & Canada)".
- **Action Cable and Action Mailbox:** neither is used. There are no channels or mailboxes.

## 2. High and medium changes

### HIGH-1: An early `return` inside `transaction` now commits instead of rolling back
- **Before:** in 7.0, `return false unless row.note.save` inside `transaction do` (app/models/import.rb:53-58) rolled back the import and every earlier row.
- **Now:** since 7.2 the transaction commits. [changelog: AR 7.1 "Bring back the historical behavior of committing transaction on non-local return", AR 8.0 "Remove deprecated `commit_transaction_on_non_local_return`"; code: `within_new_transaction` in 8.1 commits unless an exception was raised]
- **What could go wrong:** an import with one invalid row saves the `Import` record and every row before the bad one, while the user is shown "nothing saved". This is stored data.
- **Test coverage:** test/controllers/imports_controller_test.rb:72 should catch it.
- **Fix:** raise `ActiveRecord::Rollback` instead of returning.
- Links: https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md and https://github.com/rails/rails/blob/8-0-stable/activerecord/CHANGELOG.md

### HIGH-2: `record[:id]` no longer returns a custom primary key
- **Before:** `citations` has `doi` as its primary key (db/schema.rb:55). In 7.0, `citation[:id]` returned the DOI.
- **Now:** since 7.2, `read_attribute("id")` reads a real `id` column. There is none, so it returns `nil` without raising. [changelog: AR 7.1 deprecation, AR 7.2 removal; code: activerecord-8.1.0 read.rb and AttributeSet `Null` attribute]
- **Where:** `Import#receipt` (app/models/import.rb:68).
- **What could go wrong:** the downloaded receipt CSV has an empty `doi` column.
- **Test coverage:** imports_controller_test.rb:45 should catch it.
- **Fix:** use `citation.id` or `citation.doi`.
- Link: https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md

### HIGH-3: Time arguments to jobs keep their time zone, so the digest covers a different day
- **Before:** in 7.0, `TimeWithZoneSerializer` turned the time back into the worker's zone (UTC).
- **Now:** it stores a `"time_zone"` key and restores the time in that zone. [changelog: AJ 7.1.3 and 7.2 "Preserve the serialized timezone…"; code: both serializer files compared]
- **Where:**
  - `User#request_digest` passes `requested_at` in the reader's zone (app/models/user.rb:35,41).
  - `DigestMailer#daily_digest` uses `requested_at.to_date` and `.all_day` (app/mailers/digest_mailer.rb:7-9).
- **What could go wrong:**
  - The digest now covers the reader's local day, not the UTC day that the UI promises (notes/index.html.erb:10).
  - The subject date changes.
  - The Redis reservation key is still the UTC date (user.rb:36), so reservations and covered days drift apart.
  - During a mixed deploy, old payloads still resolve to UTC, so behavior depends on which version enqueued the job.
- **Test coverage:** digests_controller_test.rb:33 ("October 05") should catch it.
- Link: https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md

### HIGH-4: BigDecimal job arguments use a new payload format (mixed-version deploys)
- **Before:** in 7.0, a BigDecimal was sent as a plain JSON string and arrived as a String. The app relies on this (comment in app/jobs/digest_job.rb:4-5, `BigDecimal(params[:completion])` at digest_mailer.rb:10).
- **Now:** since 7.2 it is always wrapped as `{"_aj_serialized" => "ActiveJob::Serializers::BigDecimalSerializer", …}`. [changelog: AJ 7.1 entry warns about deploy races, AJ 7.2 removal, AJ 8.0 config removal; code: serializers.rb]
- **Where:** `DigestJob.perform_later(self, requested_at, reading_completion)` at user.rb:41.
- **What could go wrong:**
  - A digest enqueued by an 8.1 web process and picked up by a 7.0 worker fails to deserialize and goes into Sidekiq retries.
  - The reader's reservation stays taken, so they can't request another digest that day.
  - After every process runs 8.1 it works, because `BigDecimal(BigDecimal)` is fine.
- **Fix:** deploy workers first, or pass the value as a String.

### HIGH-5: `TimeWithZone#to_time` now keeps the zone, not a fixed offset
- **Before:** 7.0 used `getlocal(utc_offset)`.
- **Now:** 8.1 always uses `getlocal(time_zone)`, and the setting that controlled this is deprecated. [changelog: AS 8.0 adds `:zone`, AS 8.1 "Remove deprecated support for `to_time` to preserve the system local time" and "Deprecate `config.active_support.to_time_preserves_timezone`"; code: time_with_zone.rb in both versions]
- **Where:** `Note#next_day_reminder_at` (app/models/note.rb:43-45), whose comment documents the old behavior. It is displayed at app/views/notes/_reminder.html.erb:19.
- **What could go wrong:** across a daylight-saving change, the "24 hours later" preview shows a different wall-clock time and offset. The epoch is unchanged, so scheduling is not affected; this is display-only.
- **Test coverage:** reminders_controller_test.rb:21 should catch it.

### HIGH-6: `HashWithIndifferentAccess#stringify_keys` now turns Integer keys into strings
- **Before:** in 7.0 it was a plain `dup`, and Integer keys stayed Integers.
- **Now:** since 8.0 every key is stringified. [changelog: AS 8.0.0.rc2; code: the override is gone in 8.1]
- **Where:** `Import#annotations` uses line numbers as keys (import.rb:38-41). The preview calls `.stringify_keys` and then looks up by Integer (app/views/imports/preview.html.erb:22, 42-44).
- **What could go wrong:** annotations silently disappear from the import preview.
- **Test coverage:** imports_controller_test.rb:22 should catch it.
- Link: https://github.com/rails/rails/blob/8-0-stable/activesupport/CHANGELOG.md

### HIGH-7 (narrow): Action Text `to_plain_text` output changed
- **Change:** ordered lists are now numbered by element position, where 7.0 counted whitespace text nodes too (giving "2.", "4."). Text inside `<script>` and `<style>` is now dropped. [code: plain_text_conversion.rb diff; no changelog entry]
- **Where:** the Markdown export (export.rb:78) and list and preview snippets (notes/index.html.erb:53, imports/preview.html.erb:58).
- **What could go wrong:** export file contents change for CSV-imported HTML with whitespace between `<li>` tags or with script/style tags. Bodies written in Trix are unlikely to be affected. [inference]

### HIGH-8 (narrow): The "Astana" zone now maps to Asia/Almaty
- **Change:** "Astana" now maps to Asia/Almaty, which is UTC+5 in current tzdata, instead of Asia/Dhaka (UTC+6). [changelog: AS 7.2 "Updating Astana with Western Kazakhstan TZInfo identifier"; code: MAPPING diff]
- **Where:** `User#local_time` (user.rb:22) and `Note#reminder_at` (note.rb:37).
- **What could go wrong:** for users stored with "Astana", times they enter and the reminders they see shift by one hour. Stored epochs don't change.
- **Check:** `SELECT count(*) FROM users WHERE time_zone='Astana'`.
- The other mapping changes (Canberra, Greenland) keep the same offsets.

### MEDIUM-1: `Rails.application.secrets` is removed
- **Change:** removed in 7.2. [changelog: railties 7.1 deprecation, 7.2 removal]
- **Where:**
  - `Citation::Provider#initialize` default argument (app/models/citation/provider.rb:13).
  - Tests at test/controllers/citation_enrichments_controller_test.rb:45, 117-118, 122.
- **What could go wrong:**
  - It fails at runtime inside `CitationEnrichmentJob`, not at boot.
  - The job's `retry_on` only handles `Unavailable` (app/jobs/citation_enrichment_job.rb:7), so the `NoMethodError` goes to Sidekiq's own retries.
  - The citation stays `pending`, and `request_enrichment` then refuses to queue it again (citation.rb:16).
- **Decision needed:** where to keep these settings: `config_for(:citation_provider)`, credentials, or plain ENV. The test helper that swaps the URL depends on that choice.

### MEDIUM-2: The built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2
- **Change:** [changelog: AJ 8.1 "Deprecate built-in `sidekiq` adapter"; code: `check_adapter` warns "removed in Rails 8.2, upgrade to sidekiq 7.3.3+"]
- **Today:** it still works with Sidekiq 6.5.12. I read sidekiq-6.5.12's Rails integration and found nothing incompatible. [code]
- **Where:** config/application.rb:24.
- **Decision needed:** when to move to Sidekiq 7.3.3 or later. That upgrade affects code here (all of this is **[inference]** from Sidekiq 7, not verified against its source):
  - It swaps the `redis` gem for `redis-client`, which breaks `rescue Redis::BaseError` (notebook.rb:28) and the test stub of `Redis::CannotConnectError`.
  - Under redis-client, `redis.sadd` returns 0 or 1, and both are truthy in Ruby. The duplicate-digest guard (user.rb:38) would silently stop working.
  - Strict argument checking would reject the symbol-keyed hash in `ExportJob.perform_async(export.id, { format: "markdown" })` (notebook.rb:26).

### MEDIUM-3: `ActionText::ContentHelper.allowed_tags` is now `nil` by default
- **Change:** the defaults are applied at render time instead. [changelog: Action Text 7.1 sanitizer_vendor entry; code: 8.1 `sanitizer_allowed_tags`]
- **Where:** `allowed_tags += %w[ details summary ]` (config/initializers/action_text.rb:3) raises `NoMethodError` on `nil` at boot.
- **Why medium:** the fix is not a direct rename. The easy "fix" of setting `allowed_tags = %w[details summary]` would strip all other markup. A correct fix has to rebuild the default list (sanitizer tags plus `action-text-attachment`, `figure`, `figcaption`) and pick the HTML4 or HTML5 sanitizer.
- **Test coverage:** notes_controller_test.rb:133-145 cover this.

### MEDIUM-4: Trix now comes from the `action_text-trix` gem (Trix 2.1.15 or later)
- **Change:** actiontext 8.1 no longer ships Trix itself; it depends on the `action_text-trix` gem. [changelog: Action Text 8.1; code: gemspec and new gem contents]
- **What the app loads after the upgrade:**
  - Trix JS: the vendored 1.3.5 (layout:13).
  - Trix CSS: `*= require trix` (app/assets/stylesheets/actiontext.css:6) now resolves to the **Trix 2** stylesheet.
  - Action Text JS: `@rails/actiontext` is pinned to `actiontext.js` (config/importmap.rb:8), which is now a UMD bundle.
- **What could go wrong:** probably still loads, but the toolbar may look wrong and uploads may break. **[inference]** No system tests exist (test/system is empty), so nothing would catch this.
- **Decision needed:** keep 1.3.5, which was vendored for its saved-HTML fix, or move to Trix 2.

### MEDIUM-5: New framework defaults to decide on
These only take effect when you move `load_defaults` past 7.0 (or add `new_framework_defaults` files). [code: railties-8.1.0 configuration.rb]
- **7.1 `raise_on_assign_to_attr_readonly`:** the notebook settings form resubmits `slug` (notebooks/_form.html.erb:13, notebooks_controller.rb:40, `attr_readonly :slug` at notebook.rb:8). Every settings save would raise.
- **7.1 `default_column_serializer = nil`:** `serialize :preferences` (notebook.rb:7) raises; it needs `coder: YAML`.
- **7.1 `raise_on_invalid_cache_expiration_time`:**
  - Under 7.1 defaults, the exports page raises whenever an expired export renders on a cache miss, because `expires_in` goes negative (exports/_export.html.erb:26).
  - Even under 7.0 defaults, 8.1 now logs an error and writes that fragment with no expiry. In 7.0 it was written already expired. [code: cache.rb]
- **7.1 sanitizer vendor becomes HTML5:** this changes what Action Text allows; it interacts with MEDIUM-3.
- **7.2 `postgresql_adapter_decode_dates`:** `select_rows` returns `Date` objects, so `Date.iso8601(day)` (notebook.rb:40) raises `TypeError` on the activity page.
- **8.0 `strict_freshness`:** `stale?(etag:, last_modified:)` (export_downloads_controller.rb:11) would ignore If-Modified-Since. Harmless here.
- **8.0 `Regexp.timeout = 1`:** affects CSV and validation regexes. Low.

## 3. Low-risk changes (each raises at boot or in the existing tests, with a direct fix)
- `serialize :tags, JSON` becomes `serialize :tags, coder: JSON` (note.rb:12) [AR 7.2]
- `enum status: {...}, _prefix: true` becomes `enum :status, {...}, prefix: true` (note.rb:10) [AR 8.0]
- `alias_attribute :highlight_color, :color` (note.rb:14) raises because `color` is a store accessor, not an attribute; use an `alias_method` reader/writer pair [AR 7.2]
- `fragments.sum` (export.rb:42) raises `TypeError` because Rails' `Enumerable#sum` override is gone; use `join` [AS 7.1]
- `retry_on wait: :exponentially_longer` (citation_enrichment_job.rb:7) raises only when a retry fires; rename to `:polynomially_longer`, which uses the same formula [AJ 7.2]
- `set(wait_until: reminder_epoch)` with an Integer (note.rb:61) raises `NoMethodError` (`utc`) at enqueue; pass `Time.at(epoch)` [AJ 7.2]
- `where(notebooks: @notebook)` (notes_controller.rb:12) now builds a query on a column `notes.notebooks`, which fails; use `notebook:` [AR 7.2]
- `form_with(model: nil, …)` (notes/index.html.erb:12) raises `ArgumentError`; drop `model:` [AV 8.0]
- `get "/notes", "/journal", to:` (config/routes.rb:18) raises at route load; write two `get` lines [AP 8.0 deprecation, 8.1 removal]
- `show_exceptions = false` (config/environments/test.rb:31) is now treated as "show", so every `assert_raises(ActiveRecord::RecordNotFound)` test fails; use `:none` [AP 7.2]
- Active Storage now touches attached records after a blob is analyzed, so `updated_at` on Export and Note (through RichText) moves a few seconds after an upload. This happens silently but the effect is small [AS 7.1; code]
- `Note.connection` (notebook.rb:40) is soft-deprecated; it gives no warning by default [AR 7.2; code]
- schema.rb will be re-dumped as `Schema[8.1]` with columns sorted alphabetically [AR 8.1]
- The `concurrent-ruby 1.3.4` pin was a 7.0 workaround; 8.1 accepts 1.3.1 or later [code: gemspec]
- `minitest ~> 5.25`, `puma ~> 5.0`, and rack 2.2 (held there by Sidekiq 6.5) all satisfy 8.1's constraints [code: gemspecs]

## 4. Parts of Rails judged not relevant
- **MySQL, SQLite and Trilogy adapter changes:** the app uses PostgreSQL.
- **`enqueue_after_transaction_commit`:** it still defaults to `false` in 8.1, and its config option was removed, so enqueuing inside `with_lock` (citation.rb:15-20, note.rb:57-62) behaves as before [code].
- **Solid Queue, Solid Cache, Solid Cable, Kamal, Propshaft, Brakeman, RuboCop, `bin/ci`, PWA files, the auth generator:** these only affect newly generated apps.
- **Action Cable:** no channels, and the production redis adapter accepts redis 4 to 5.
- **Action Mailbox:** not used.
- **JSON rendering, `escape_json_responses` and Jbuilder changes:** the app renders no JSON.
- **`secret_key_base` lookup:** production reads ENV or credentials in both versions [code]. Development sessions reset once because the temp file name changed.
- **has_secure_password's new 72-byte limit:** the app has no way to set a password.
- **Active Storage variants, analyzers and the vips default:** no image_processing gem is installed. The blob checksum is still MD5, so download ETags stay the same [code].
- **Active Record encryption, composite primary keys, multiple databases and sharding:** not used.
- **Bundled en.yml locale files:** only additions.
- **Rate limiting, `params.expect`, `allow_browser`, Continuations:** new features the app doesn't use.

Source diffs and changelogs I used are in /tmp/railsdiff/src and /tmp/railsdiff/changelogs.

---

I haven't changed anything yet. Rails is currently 7.0.8.7, pinned in the `Gemfile` at line 7, so moving to 8.1.0 crosses four minor releases.

The riskiest changes give no error and change data or behavior:
- **HIGH-1:** an import with one bad row would save the rows before it.
- **HIGH-3 and HIGH-4:** digest jobs pick a different day, and they can fail while web processes and Sidekiq workers run different Rails versions.

Some decisions are needed before the upgrade:
- Where the citation-provider settings should live once `Rails.application.secrets` is removed (MEDIUM-1).
- Whether to keep Trix 1.3.5 or move to Trix 2 (MEDIUM-4).
- Whether this deploy can run old and new versions side by side (HIGH-4).
- Whether to leave `load_defaults` at 7.0 for now (MEDIUM-5).

I recommend upgrading one minor version at a time (7.1, then 7.2, 8.0, 8.1), running the test suite at each step. That way each deprecation warning shows up before the code it warns about is removed. Tell me how you'd like to proceed and I'll start.