I haven't changed anything yet. The Gemfile still pins `rails` 7.0.8.7, so 8.1.0 is a jump across four release series (7.1, 7.2, 8.0, 8.1). Before editing the Gemfile I had a review done of what that upgrade changes for this app. Here is the full report:

---

# Rails 7.0.8.7 → 8.1.0: changes that affect Margin Notes

**Summary.** Two kinds of risk dominate. First, the app's own test suite would catch most problems, but about ten of them change behavior without raising an error in production:
- Import batches can now be partially saved.
- The import receipt loses its DOIs.
- Import previews lose their annotations.
- Digests cover the reader's local day instead of the UTC day.
- BigDecimal job arguments can't be read by an old worker during a deploy.

Second, several things only fail in Sidekiq jobs, after boot.

I compared the released gems for 7.0.8.7 against 8.1.0, read the changelogs of the latest patch in each series in between (7.1.5.2, 7.2.2.2, 8.0.3), and traced each relevant change into the app. The unpacked gems are in `/tmp/railsgems/<version>/<gem>/`. I didn't change, install, or run anything. The app tree is still clean.

Each claim is tagged **[changelog]**, **[code]** (gem or app source I read), or **[inference]**. Changelog links point to the stable-branch CHANGELOGs, e.g. `https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md`. The GitHub search API hit its rate limit, so the only PR I confirmed is #48600.

## Facts about the app that the ratings depend on

- **Defaults:** `config.load_defaults 7.0` (config/application.rb:12). The ratings assume you keep 7.0 defaults at first. Settings that only change when you raise `load_defaults` are listed under M4.
- **Database:** PostgreSQL through `pg` 1.6.0. MySQL, SQLite and Trilogy changes are ruled out.
- **Background jobs:** Active Job uses Rails' **built-in Sidekiq adapter** with Sidekiq 6.5.12 and redis 4.8.1 (application.rb:24). `ExportJob` is a native Sidekiq job. Tests use the `:test` adapter. Sidekiq 6.5 requires Rack 2, and Rails 8.1 still accepts Rack ≥ 2.2.4, so Rack stays on 2.2.
- **Rendering:** HTML only, with ERB, Sprockets, importmap and Turbo. There are no `.jbuilder` views or JSON endpoints.
- **Rich text:** Action Text with a vendored Trix 1.3.5 loaded as a classic script (layouts/application.html.erb:13). `@rails/actiontext` is pinned to `actiontext.js` (config/importmap.rb:8).
- **File storage:** Active Storage on the Disk service, with no `image_processing`.
- **Caching:**
  - Production has no `cache_store` set, so it uses the framework default, with `perform_caching` on.
  - There is one fragment cache, in exports/_export.html.erb:26.
- **Time zones:** Users store Active Support zone names (`users.time_zone`), and the app zone is UTC.
- **Secrets:** Provider settings come from `config/secrets.yml` through `Rails.application.secrets`.
- **Deprecations in production:** `report_deprecations = false`, so deprecation warnings are invisible in production.
- **Tests:** controller and model tests only. `test/system` is empty, so nothing checks behavior in the browser.
- **Ruby:** 3.3.6 (8.1 needs ≥ 3.2). The pins `concurrent-ruby 1.3.4` and `minitest ~> 5.25` satisfy 8.1's constraints. New dependencies include `action_text-trix`, `rackup`, `rack-session` and `useragent`.
- **Version choice:** 8.1.0 was released 2025-10-22. Later 8.1 releases exist (8.1.1 through 8.1.4), including the security releases 8.1.2.1 and 8.1.3.1. Consider targeting the latest 8.1 patch.

## High risk (behavior changes without an error)

**H1. An early `return` inside `transaction` now commits.**
- **Where:** app/models/import.rb:53-58 (`return false unless row.note.save` inside `transaction`).
- **Before:** 7.0 rolled back a block that exited early after writing. [code]
- **Now:** In 8.1, `within_new_transaction` commits unless an exception was raised or the thread is dying. The setting that controlled this was removed in 8.0. [code, changelog AR 7.1/7.2/8.0, PR #48600]
- **What breaks:** If a later row fails, the Import, the earlier notes and any new shared Citations stay saved. Meanwhile the preview tells the reader "Nothing has been saved", and resubmitting creates duplicates.
- **Tests:** imports_controller_test.rb:65-67 should fail. [inference]

**H2. `citation[:id]` returns nil.**
- **Where:** app/models/import.rb:68. The `citations` table's primary key is `doi`, and there is no `id` column (db/schema.rb:55).
- **Before:** `read_attribute(:id)` mapped to the primary key.
- **Now:** It is removed (deprecated 7.1, removed 7.2), and in 8.1 a missing attribute reads as nil without raising. [changelog, code]
- **What breaks:** The receipt CSV's DOI column comes out blank.
- **Tests:** imports_controller_test.rb:45 catches it.

**H3. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys to strings.**
- **Where:**
  - `Import#annotations` keys the hash by Integer line number (import.rb:38-42).
  - imports/preview.html.erb:22 calls `stringify_keys`.
  - Line 42 looks entries up with `annotations[row.line]`, an Integer.
- **What breaks:** In 8.x every lookup misses, so annotations silently disappear from the preview. [changelog AS 8.0.0.rc1, code]
- **Tests:** imports_controller_test.rb:22,24,62 catch it.

**H4. Time-with-zone job arguments keep their own zone (7.1.3).**
- **Where:** `User#request_digest` passes `requested_at` in the reader's zone (user.rb:51,57). DigestMailer uses `requested_at.to_date` and `.all_day` (digest_mailer.rb:8-9).
- **Before:** The argument arrived in UTC, so the digest covered the same UTC day as the Redis reservation key (user.rb:52).
- **Now:** It covers the reader's local day. The subject date and the chosen notes change for anyone not on UTC. [changelog AJ 7.1.3, code: both serializers]
- **Tests:** digests_controller_test.rb:33-35 catches it.

**H5. BigDecimal job arguments are stored in a new format, which breaks a mixed deploy or a rollback.**
- **Where:** user.rb:57 passes a `BigDecimal`.
- **Before:** 7.0 passed it through as a primitive, and Sidekiq stored `"0.6667"`.
- **Now:** 8.1 always wraps it as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",...}`. The opt-out setting was removed in 8.0. [changelog AJ 7.1/7.2/8.0, code]
- **Mixed versions:**
  - A 7.0 Sidekiq worker can't load that serializer. It raises `DeserializationError`, and `DigestJob` keeps retrying. [inference from the 7.0 source]
  - In the other direction, 8.1 reads old payloads fine, because the mailer calls `BigDecimal(string)`.
  - The new `time_zone` key from H4 is simply ignored by 7.0 workers.
- **Mitigation:** Upgrade or drain the workers before the web servers, and don't roll back while such jobs are queued. Alternatively, pass `completion.to_s`.

**H6. `TimeWithZone#to_time` now keeps the full zone.**
- **Where:** note.rb:44 `reminder_at.to_time + 86_400`, rendered at notes/_reminder.html.erb:19.
- **Before:** The result had a fixed offset, so after DST ended the preview showed "09:00 -04:00".
- **Now:** It shows "08:00 -05:00". That is the same instant, and the postponed reminder still uses `.to_i`, so stored data is unchanged. [changelog AS 8.0/8.1, code]
- **Impact:** This affects the display and ARCHITECTURE.md, and arguably fixes it.
- **Tests:** reminders_controller_test.rb:20-21 asserts the old value.

**H7. A negative cache `expires_in` is handled differently.**
- **Where:** exports/_export.html.erb:26 passes `export.expires_at - Time.current`, which is negative once an export has expired.
- **Before:** 7.0 wrote an entry that was already expired.
- **Now:** 8.1 drops the option, logs `ArgumentError` at error level, reports it to `Rails.error`, and caches the "Expired" fragment with no expiry. [code]
- **Impact:** The content stays correct, but you get error logs on every render.
- **If you adopt the 7.1 default** `raise_on_invalid_cache_expiration_time`, the exports page returns 500 whenever an expired export exists.

These three are also silent, but affect fewer users:

- **H8. Time zone mapping changed (7.2).** "Astana" moved from Asia/Dhaka to Asia/Almaty (current tzdata puts it at UTC+5, not UTC+6 [inference]). Readers who chose Astana will enter and see reminder times one hour off; the stored epochs don't change. "Greenland" and "Canberra" moved to equivalent zone IDs, and "Asuncion" was added. [code diff of `MAPPING`]
- **H9. Blob analysis now touches the records that own the attachment (Active Storage 7.1).** The chain is Blob → Attachment → `ActionText::RichText` (`touch: true`) → Note. So `Note#updated_at` moves to whenever `AnalyzeJob` runs. DigestMailer filters on `updated_at`, so a note saved near midnight UTC, or while workers are backed up, can move to the next day's digest. You can switch this off with `config.active_storage.touch_attachment_records = false`. [code; impact is inference]
- **H10. `to_plain_text` output changed.** Ordered-list numbering now counts only element siblings: imported HTML with whitespace between `<li>` items used to number 2., 4. and now numbers 1., 2. Text inside `<script>` and `<style>` is now dropped. This changes the Markdown export (export.rb:78) and the truncated previews. They are bug fixes, but the generated files differ. [code diff]

## Medium risk (errors where the fix needs a decision)

**M1. `Rails.application.secrets` was removed (7.2).**
- **Where:** citation/provider.rb:13 (a default argument) and config/secrets.yml. The tests also use it (citation_enrichments_controller_test.rb:45,117-122).
- **Failure mode:** It isn't caught at boot. The `NoMethodError` is raised inside `CitationEnrichmentJob`, and it isn't a `Provider::Error`, so Sidekiq retries. The citation stays "Pending", and citation.rb:16 then answers "already being fetched" to every new request.
- **Decision:** credentials, ENV, or `config_for` (which keeps the same YAML-with-ERB shape). [changelog railties 7.1/7.2, code]

**M2. `ActionText::ContentHelper.allowed_tags` now defaults to nil (7.1).**
- **Where:** config/initializers/action_text.rb:3 does `nil + [...]`, which raises `NoMethodError` at boot.
- **Decision:** The defaults now live in `sanitizer_allowed_tags`. A naive `= %w[details summary]` would boot but silently strip attachments, `figure`, `figcaption` and everything else.
- **Fix:** Rebuild the list as `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
- **Caution:** If you later adopt the HTML5 `sanitizer_vendor`, the sanitizer is swapped in `after_initialize`, after your initializer has already run. [inference]
- **Tests:** notes_controller_test.rb:137 covers this. [changelog AT 7.1.0.beta1, code]

**M3. The built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2.**
- **Status:** It works in 8.1.0 with Sidekiq 6.5.12, which already handles the 7.1 logger API. The warning won't show in production. [code]
- **Decision:** Moving to Sidekiq ≥ 7.3.3 brings redis-client, and these call sites would likely break [all inference, not checked against Sidekiq 7 source]:
  - `redis.sadd` returns 0 or 1 instead of a boolean (user.rb:38). Since 0 is truthy in Ruby, digests would be sent again for the same day.
  - `rescue Redis::BaseError` (notebook.rb:28) and the `Redis::CannotConnectError` tests would no longer match.
  - Strict arguments would reject `{ format: "markdown" }` (notebook.rb:26).

**M4. New defaults you'll face when raising `load_defaults`:**
- **7.1 `raise_on_assign_to_attr_readonly`:** The notebook form resubmits the slug (notebooks/_form.html.erb:13, notebooks_controller.rb:40), so every settings save would raise.
- **7.1 `default_column_serializer = nil`:** `serialize :preferences` (notebook.rb:7) would raise. Choose `coder: YAML` to keep reading the stored rows; picking JSON would break existing data.
- **7.1 `raise_on_invalid_cache_expiration_time`:** see H7.
- **7.2 `postgresql_adapter_decode_dates`:** `select_rows` would return `Date` objects, and `Date.iso8601(Date)` raises `TypeError` in the activity report (notebook.rb:40).
- **8.0 `strict_freshness`:** The ETag would win over Last-Modified in export_downloads_controller.rb:11.
- **Opt-in `enqueue_after_transaction_commit`:** Not on by default in 8.1. If you enable it, `Citation#request_enrichment` (citation.rb:15-22) and `Note#schedule_reminder` (note.rb:57-68) lose the "a failed enqueue rolls back" guarantee.

**M5. Trix and `actiontext.js`.**
- **What changed:** In 8.1, Action Text depends on Trix 2.1.15 through `action_text-trix`. Its `actiontext.js` is now a UMD bundle, and the ES module build moved to `actiontext.esm.js`. [changelog, code]
- **App setup:** The app imports the UMD file through importmap and loads Trix 1.3.5 itself.
- **Assessment:** It probably still registers the upload listener, but nothing checks that in a browser. [inference]
- **Decision:** Keep Trix 1.3.5 or move to Trix 2. The reason given in the layout comment for vendoring (the Trix 1.3.4 bug) no longer applies. Rails' Trix bump for CVE-2024-34341 doesn't help the vendored 1.3.5. [inference]

## Low risk (mechanical; boot or tests catch them)

- **note.rb:12** `serialize :tags, JSON` raises `ArgumentError` at class load. Use `coder: JSON`.
- **note.rb:10** `enum status: {...}, _prefix: true` raises `ArgumentError` (keyword form removed in 8.0). Use `enum :status, {...}, prefix: true`.
- **note.rb:14** `alias_attribute :highlight_color, :color` raises `ArgumentError`, because `color` is a store accessor. Use `alias_method` for the reader and writer.
- **notes_controller.rb:12** `where(notebooks: @notebook)` relied on plural names for singular associations, removed in 7.2. Rails now queries `"notes"."notebooks"`, which raises an SQL error. Use `notebook:`.
- **notes/index.html.erb:12** `form_with(model: nil, ...)` raises `ArgumentError`. Drop `model:`.
- **citation_enrichment_job.rb:7** `wait: :exponentially_longer` raises "Couldn't determine a delay" only when a retry happens, so the failure block never runs. Use `:polynomially_longer`, which is the same formula.
- **note.rb:61** `set(wait_until: <Integer>)` fails with `NoMethodError` on `utc` while the job is serialized. Pass `Time.at(epoch)`.
- **export.rb:42** `fragments.sum` over strings raises `TypeError` in ExportJob, leaving the export "working" while Sidekiq retries. Use `join`. This was already deprecated in 7.0.
- **test.rb:31** `show_exceptions = false` is now treated like `:all`, so the `assert_raises(RecordNotFound)` tests fail. Use `:none`.
- **Development secret:** it moved from `tmp/development_secret.txt` to `tmp/local_secret.txt`. Development sessions reset, and existing attachments in the development database stop resolving until you copy the file. [inference]
- **`has_secure_password`** now enforces a 72-byte maximum on passwords (7.1).
- **routes.rb:18** multi-path `get`: 8.0 deprecated it, and the 8.1.0 changelog says it was removed, but the 8.1.0 mapper still maps both paths without a warning. [code] Split it anyway.
- **schema.rb** will change on the next dump: columns sorted alphabetically (8.1) and `pg_catalog.plpgsql` (8.0).
- **notebook.rb:40** `Note.connection` is soft-deprecated, with no warning.

## Judged not relevant

- **Database adapters:** MySQL, SQLite and Trilogy changes. The app uses PostgreSQL.
- **Action Mailbox:** loaded by `rails/all`, but there's no ingress.
- **Action Cable:** there are no channels. The Redis adapter now needs `redis >= 4`, and 4.8.1 qualifies.
- **Cache stores:** Redis and Memcache store changes don't apply to the file, memory and null stores the app uses.
- **Active Storage:** variants, previews, S3/GCS/Azure services, and the Azure removal in 8.1 don't matter for the Disk service with no image processor.
- **JSON escaping defaults:** there are no JSON responses.
- **Generator-only additions:** Solid Queue, Cache and Cable, Kamal, the authentication generator, `allow_browser`, rate limiting and PWA files.
- **Unused Active Record features:** encryption, composite keys, sharding and multiple databases.
- **Removed queue adapters:** the Sucker Punch and Que removals.
- **Security headers:** CSP and Permissions-Policy are both commented out, and the Permissions-Policy middleware is now only added when configured.
- **Signed IDs:** the legacy verifier stays the default, so stored and bookmarked blob URLs keep verifying.
- **Rack 3 status renames:** Rack stays on 2.2.

## Notes for planning

- **Test coverage:** The existing tests would catch H1–H4, H6, M1, M2 and every Low item. H5, H7–H10, M3 and M5 need manual checking.
- **Stepwise upgrades:** If you upgrade through 7.2 or 8.0 instead, behavior at those stops differs from 8.1, for example the transaction-deferred enqueue under 7.2 defaults.

---

The report rests on reading gem source and changelogs; nothing was installed or run, and the working tree is unchanged.

To go ahead, I need you to decide:

1. **Target version:** exactly 8.1.0 as you asked, or the latest 8.1 patch, which includes later security fixes.
2. **Secrets (M1):** move the provider settings to credentials, ENV, or `config_for`.
3. **Trix (M5):** keep the vendored Trix 1.3.5 or move to Trix 2.
4. **Sidekiq (M3):** stay on Rails' built-in adapter with Sidekiq 6.5 for now, or switch now.
5. **Deploy order (H5):** upgrade or drain the Sidekiq workers before the web servers, or I change the job to pass the value as a string so mixed versions don't matter.

Once you've decided, I'll start with the changes that need no decision (the Low list, H1–H3, M2 and the test config), keep `load_defaults 7.0`, and run both `bin/rails test` and `bin/rails test:system`.