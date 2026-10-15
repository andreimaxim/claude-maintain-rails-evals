Before changing anything I checked what this upgrade would affect. The app is on Rails 7.0.8.7, so going to 8.1.0 crosses 7.1, 7.2 and 8.0 as well. Here is the full report:

---

I found 20 changes between 7.0.8.7 and 8.1.0 that affect Margin Notes: 9 high, 4 medium and 7 low. Most of them come from 7.2 and 8.0, not 8.1 itself. Many of the high-risk ones fail silently in production, but the existing tests should fail on most of them. Nothing was installed, run or changed in the app. I compared the released gems, unpacked under `/tmp/railsdiff/src/{7.0.8.7,8.1.0}/<gem>`, using the changelogs from 7.1.5.2, 7.2.2.2 and 8.0.3 (all in that same folder). I couldn't look up PR numbers because the GitHub API was rate-limited, so the links below go to the changelog files. Sources are marked **[changelog]**, **[code]** (Rails or app source I read) or **[inference]**.

## Facts the ratings depend on (please correct any that are wrong)
- **Framework defaults stay at 7.0** (`/home/user/workspace/repo/config/application.rb:12`). Many behavior changes from 7.1 to 8.1 only apply after you raise that setting, so they are not counted here. There's a short list of them at the end. [code]
- **Database:** PostgreSQL through `pg` 1.6.0. MySQL and SQLite changes don't apply. [code]
- **Background jobs:** Active Job uses Rails' built-in Sidekiq adapter, with Sidekiq 6.5.12 and redis 4.8.1 (`config/application.rb:24`); tests use the `:test` adapter. `ExportJob` is a plain Sidekiq job, so Active Job changes don't touch it. [code]
- **Rolling deploys:** I assumed web and worker processes can briefly run different Rails versions during a deploy, and that reminder jobs may be scheduled weeks ahead. [inference]
- **Front end:** the app renders HTML with Sprockets and importmap. It loads a vendored Trix 1.3.5 as a plain script and uses Action Text and Active Storage on local disk. It serves no JSON. [code]
- **Caching:** the only caching is one fragment cache in the exports page. Production sets no cache store, so Rails' default file store applies. [code/inference]
- **Settings:** citation-provider settings come from `config/secrets.yml` through `Rails.application.secrets`. [code]
- **Unused frameworks:** Action Cable has no channels and Action Mailbox isn't used. [code]
- **Tests:** there are no system (browser) tests, so editor and styling changes are untested. [code]
- **Ruby:** 3.3.6, and Rails 8.1 needs 3.2 or later. [code]
- **Dependencies:** 8.1 adds `action_text-trix`, `useragent`, `rack-session` and `rackup` to the bundle. Nothing in 8.1 forces a change to the pinned Sidekiq, redis, rack, concurrent-ruby or minitest versions. [code: 8.1.0 gem metadata]

## High risk (behavior changes without an error)

**1. `return` inside a transaction now commits instead of rolling back.** Removed in 7.2 ([7-2-stable AR changelog](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md): "Remove deprecated behavior that would rollback a transaction block when exited using `return`..."; background in [7-1-stable](https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md)). [changelog + code]
- **Before:** 7.0's `within_new_transaction` rolled back when the block exited early after writing.
- **Now:** 8.1 commits whenever no exception was raised.
- **Where:** `Import#apply` in `/home/user/workspace/repo/app/models/import.rb:53-58` does `return false unless row.note.save` inside `transaction`.
- **What breaks:** an import with a bad row would keep the Import, every note before the bad row and any new citations. The page still says "Nothing has been saved." The fix is to raise `ActiveRecord::Rollback` or call `save!` and rescue. `test/controllers/imports_controller_test.rb:65-72` should catch it. [inference]

**2. Times passed to jobs now arrive in the reader's time zone, not UTC.** Changed in 7.2 ([7-2-stable activejob](https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md): "Preserve the serialized timezone when deserializing `ActiveSupport::TimeWithZone` arguments"). [changelog + code]
- **Before:** 7.0 rebuilt the time in the worker's zone, UTC.
- **Now:** 8.1 also stores the zone name and restores it (`time_with_zone_serializer.rb`).
- **Where:** `User#request_digest` passes the time in the reader's zone (`app/models/user.rb:35,41`). `DigestMailer` (`app/mailers/digest_mailer.rb:8-9`) uses `requested_at.to_date` and `requested_at.all_day`.
- **What breaks:** the digest silently switches to the reader's local day. The Redis reservation key is still the UTC day (`user.rb:36`), so near local midnight the two disagree, which contradicts the docs. `test/controllers/digests_controller_test.rb:33` (subject date) should fail. [inference]

**3. Digest jobs fail while old and new versions run side by side.** 7.2 removed the old way of passing `BigDecimal` arguments, and 8.0 removed the setting that controlled it ([7-2-stable activejob](https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md), [8-0-stable activejob](https://github.com/rails/rails/blob/8-0-stable/activejob/CHANGELOG.md)). [changelog + code]
- **Change:** 8.1 always wraps `BigDecimal` as `ActiveJob::Serializers::BigDecimalSerializer`.
- **Where:** `user.rb:41` passes the reading-completion share as a `BigDecimal`.
- **What breaks:**
  - A 7.0 worker can't find that serializer class, so it raises an error while reading the job's arguments (`DeserializationError`).
  - `DigestJob` has no `discard_on`, so Sidekiq keeps retrying until a new worker picks it up.
  - Meanwhile the reader's Redis reservation blocks them from asking again that day.
- **Other direction:** 7.0-enqueued jobs run fine on 8.1. The completion value arrives as a string and `BigDecimal()` accepts it, the time falls back to UTC, and scheduled `NoteReminderJob`s keep the same wrapper class name. [code]

**4. The import receipt CSV loses its DOI column.** Removed in 7.2 ([7-2-stable AR](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md): "Remove deprecated support to `ActiveRecord::Base#read_attribute(:id)` to return the custom primary key value"). [changelog + code]
- **Before:** in 7.0, `record[:id]` returned the primary key even when it isn't `id`.
- **Now:** 8.1 reads a column literally named `id`. `citations` has none (its primary key is `doi`), so it silently returns `nil`.
- **Where:** `Import#receipt` uses `citation && citation[:id]` (`app/models/import.rb:68`).
- **What breaks:** every DOI cell in the downloaded receipt is blank. Use `citation.doi`. `imports_controller_test.rb:43-45` should catch it. [inference]

**5. Annotations disappear from the import preview.** Changed in 8.0 ([8-0-stable activesupport](https://github.com/rails/rails/blob/8-0-stable/activesupport/CHANGELOG.md): "Fix `ActiveSupport::HashWithIndifferentAccess#stringify_keys` to stringify all keys not just symbols"). [changelog + code]
- **Where:** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22` calls `@import.annotations.stringify_keys`. That hash is keyed by integer line numbers, and line 42 looks them up with `annotations[row.line]`.
- **Before:** in 7.0, `stringify_keys` left integer keys alone.
- **Now:** keys become `"2"`, so the lookup returns `nil` and annotations vanish from the preview without an error. `imports_controller_test.rb:22,24` should fail. [inference]

**6. The "24 hours later" reminder preview shows a different local time and offset.** 8.0 added the `:zone` behavior and 8.1 removed the old modes ([8-0-stable activesupport](https://github.com/rails/rails/blob/8-0-stable/activesupport/CHANGELOG.md), [v8.1.0 activesupport](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md): "Remove deprecated support for `to_time` to preserve the system local time..."). [changelog + code]
- **Before:** 7.0 defaults kept a fixed offset.
- **Now:** in 8.1, `TimeWithZone#to_time` always keeps the zone (`getlocal(time_zone)`).
- **Where:** `Note#next_day_reminder_at` (`app/models/note.rb:43-45`), shown in `app/views/notes/_reminder.html.erb:19`.
- **What changes:** across a daylight-saving change the preview now shows the zone's new offset and local time. The moment is the same, and so is the `.to_i` value used for postponing. This arguably fixes what ARCHITECTURE.md describes as a known oddity, so the docs need updating. `test/controllers/reminders_controller_test.rb:21` asserts the old value. [inference]

**7. Readers whose time zone is "Astana" shift by an hour.** Changed in 7.2 ([7-2-stable activesupport](https://github.com/rails/rails/blob/7-2-stable/activesupport/CHANGELOG.md): "Updating Astana with Western Kazakhstan TZInfo identifier"). [changelog + code]
- **Change:** "Astana" now maps to `Asia/Almaty` instead of `Asia/Dhaka`.
- **Where:** a reader's stored zone name drives reminder display (`note.rb:37`) and how entered times are read (`user.rb:22`). [code]
- **Not affected:** the zone names `User` validates against are unchanged apart from a new "Asuncion", and the "Greenland" and "Canberra" remaps point to equivalent zones.
- **What changes:** with current tz data, Astana readers see reminder times an hour different, and newly entered times land an hour apart. [inference]

**8. Markdown export text changes for some notes.** This comes from the code diff of `plain_text_conversion.rb`; it isn't in the changelog. [code]
- **Lists:** numbered-list items are now counted by element only. Before, whitespace between `<li>` tags also counted, so imported HTML produced "2., 4.". [code]
- **Script and style:** `<script>` and `<style>` content is now dropped. [code]
- **Where:** `Export#markdown_for` (`app/models/export.rb:78`) and the note list excerpt (`app/views/notes/index.html.erb:53`). Mostly HTML imported through `body_html`. [inference]

**9. Expired export fragments are now cached forever, and an error is logged.** Changed in 7.1. [code]
- **Before:** in 7.0, a negative `expires_in` stored an entry that expired immediately.
- **Now:** in 8.1, `merged_options` drops a negative `expires_in`, logs an `ArgumentError` and stores the entry with no expiry. That's because `raise_on_invalid_cache_expiration_time` stays false under 7.0 defaults.
- **Where:** `app/views/exports/_export.html.erb:26` uses `expires_in: export.expires_at - Time.current`, which is negative once an export has expired.
- **Impact:** the cached content ("Expired") is still correct, so this mostly means log noise and permanent file-store entries. The tests won't notice. [inference]

## Medium risk (raises an error, and the fix needs a decision)

**10. `Rails.application.secrets` was removed.** Deprecated in 7.1, removed in 7.2 ([7-2-stable railties](https://github.com/rails/rails/blob/7-2-stable/railties/CHANGELOG.md)). [changelog + code]
- **Where:** `/home/user/workspace/repo/app/models/citation/provider.rb:13`, plus test stubbing at `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **When it fails:** boot is fine. It raises `NoMethodError` when a `CitationEnrichmentJob` runs. That isn't the `Unavailable` error the job retries on, so Sidekiq keeps retrying and the citation stays "pending" (which also blocks re-requests).
- **Decision:** move these settings to credentials, `config_for`, or plain environment variables. [inference]

**11. The Action Text allowlist initializer crashes at boot.** [code]
- **Before:** in 7.0, `ActionText::ContentHelper.allowed_tags` defaulted to a list.
- **Now:** in 8.1 it is `nil`, and the default list is built in `sanitizer_allowed_tags`.
- **Where:** `/home/user/workspace/repo/config/initializers/action_text.rb:3` does `nil += %w[details summary]`, which raises `NoMethodError` at boot.
- **Decision:** rebuild the whole list: sanitizer defaults, the attachment tag, `figure`, `figcaption`, plus `details` and `summary`. Setting only `details` and `summary` would silently strip everything else from rich text.

**12. Trix moved to its own gem, so the editor's CSS no longer matches its JavaScript.** From the [v8.1.0 actiontext changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md) ("satisfied by a gem, `action_text-trix`... upgrades Trix to `>= 2.1.15`"). [changelog + code]
- **Change:** `*= require trix` in `app/assets/stylesheets/actiontext.css:6` now pulls Trix 2.1.15 CSS from the new gem. The layout still loads the vendored Trix 1.3.5 JavaScript (`app/views/layouts/application.html.erb:13`).
- **What still works:** `actiontext.js` (`config/importmap.rb:8`) still loads as a module and still uses Trix 1-compatible upload calls.
- **Decision:** keep Trix 1.3.5 and vendor its CSS, or move to Trix 2 and drop the workaround. The reason for the workaround (7.0 bundling Trix 1.3.4) no longer applies. No test covers the editor. [inference]

**13. The built-in Sidekiq adapter is deprecated and goes away in Rails 8.2.** From the [v8.1.0 activejob changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md). [changelog + code]
- **8.1:** it only warns. Production hides deprecations (`config/environments/production.rb:76`).
- **Replacement:** Sidekiq 7.3.3 or later. That moves off redis-rb 4, so check `Sidekiq.redis { |r| r.sadd ... }` truthiness at `app/models/user.rb:38` and `rescue Redis::BaseError` at `app/models/notebook.rb:28`. [inference]
- **Compatibility:** Sidekiq 6.5.12's own Rails integration supports 7.1+ logging and should work with 8.1. [code + inference]

## Low risk (mechanical; booting or the tests would catch it)
14. **`serialize :tags, JSON`** (`app/models/note.rb:12`) is removed syntax and raises `ArgumentError` at load. Use `coder: JSON`. [changelog 7.2 + code]
15. **`enum status: {...}, _prefix: true`** (`note.rb:10`) is removed syntax. Use `enum :status, {...}, prefix: true`. [changelog 8.0 + code]
16. **`alias_attribute :highlight_color, :color`** (`note.rb:14`) points at a `store_accessor`, not a real attribute, and raises `ArgumentError` when the first Note loads. Use `alias_method` for both the reader and the writer. [changelog 7.2 + code]
17. **`retry_on ..., wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`): the option was removed. It fails only when a retry happens ("Couldn't determine a delay"), not at boot. Rename to `:polynomially_longer` (same formula). The test at `citation_enrichments_controller_test.rb:60-71` exercises retries. [changelog 7.2 + code]
18. **`set(wait_until: reminder_epoch)` with an Integer** (`note.rb:61`): job serialization calls `.utc` on it and raises inside `with_lock`. Use `Time.at(reminder_epoch)`. [changelog 7.2 + code]
19. **`form_with(model: nil, ...)`** (`app/views/notes/index.html.erb:12`) now raises `ArgumentError` on the main notes page. Drop `model: nil`. [changelog 8.0 + code]
20. **Other mechanical changes:**
    - **`where(notebooks: @notebook)`** (`app/controllers/notes_controller.rb:12`): the plural fallback was removed, so this becomes the column `notes.notebooks` and SQL fails. Use `notebook:`. [changelog 7.2 + code]
    - **`get "/notes", "/journal", to:`** (`config/routes.rb:18`): one path per call now; it raises at boot. [changelog 8.0/8.1 + code]
    - **`show_exceptions = false`** (`config/environments/test.rb:31`): 8.1 treats `false` as "show all", so every `assert_raises(ActiveRecord::RecordNotFound)` test fails. Use `:none`. [changelog 7.2 + code]
    - **`db/schema.rb`:** the next dump will list columns alphabetically, so expect a noisy diff. [changelog 8.1]
    - **Updated timestamps:** since 7.1, analyzing an Active Storage blob touches the records it's attached to. That moves `updated_at` on exports and on notes with attachments, which `DigestMailer` filters on. The effect should be tiny. [changelog 7.1 + inference]

## Not relevant here
- **Jobs queued inside a transaction:** `enqueue_after_transaction_commit` defaults to `false` in 8.1 (`enqueuing.rb:53`), so jobs queued under `with_lock` (`citation.rb:15-22`, `note.rb:57-63`) still go out immediately. If you deploy 7.2 as a stop on the way, they would be deferred until commit. [code + changelog]
- **Sessions and cookies:** with 7.0 defaults, the JSON cookie serializer and SHA256 key derivation are unchanged, so existing sessions survive. The production `secret_key_base` must come from an environment variable or credentials, because `secrets.yml` no longer works. [code + inference]
- **Cache format 7.0:** still supported in 8.1. [code]
- **`.connection` in `notebook.rb:40`:** still allowed by default. [code]
- **Adapters and services the app doesn't use:** MySQL, SQLite, Trilogy, Azure storage, the SuckerPunch adapter, Action Mailbox and Action Cable (redis 4.8.1 still fits). [code]
- **JSON escaping, YJIT, strict ETag freshness:** only switch on with 8.0/8.1 defaults, and the app serves no JSON. [code]
- **Semicolon query separators:** no URLs use them. [inference]
- **`has_secure_password`:** the new reset tokens and byte-based length check don't matter, since the app has no password-setting UI. [code]
- **PostgreSQL version:** 8.1 requires 9.3 or later. [code]

## Traps for when you raise `load_defaults` later [code]
- **7.1 (missing coder):** `serialize :preferences` (`app/models/notebook.rb:7`) needs an explicit coder.
- **7.1 (read-only slug):** the slug readonly check would likely raise on the settings form (`app/views/notebooks/_form.html.erb:13`).
- **7.1 (cache expiry):** a negative `expires_in` raises, which would make the exports page error (500) for expired exports.
- **7.1 (sanitizer):** Action Text switches to the HTML5 sanitizer.
- **7.2 (dates):** PostgreSQL date columns come back as `Date` objects, so `Date.iso8601(day)` (`notebook.rb:40`) raises `TypeError`.
- **8.0 (ETag):** ETag takes precedence over Last-Modified on export downloads (`app/controllers/export_downloads_controller.rb:11`).

---

I haven't changed the Gemfile or any code yet, so you can read this before deciding how to go ahead. Some decisions are needed first:

- **Where the citation-provider settings go (#10):** credentials, `config_for`, or environment variables.
- **Trix (#12):** keep 1.3.5 or move to Trix 2.
- **How to deploy:** whether to upgrade straight to 8.1.0 or stop at 7.1 and 7.2 first. Going straight there means planning for the job-format problem (#3) when old and new processes overlap.

Before bumping the gem, I'd suggest fixing the silent high-risk issues (#1, #2, #4 and #5) with tests that cover them, since none of them raise an error. Tell me how you'd like to proceed and I'll start.