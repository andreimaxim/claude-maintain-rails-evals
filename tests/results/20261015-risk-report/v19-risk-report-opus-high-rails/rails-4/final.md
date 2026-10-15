# Rails 7.0.8.7 → 8.1.0 upgrade risk report for Margin Notes

I compared the released gems (7.0.8.7 and 8.1.0, plus the 7.1.0, 7.2.0 and 8.0.0 changelogs) with the app's code. I didn't install anything, change the app, or run it. Each claim is tagged **[changelog]**, **[code]** (I read the Rails source in both versions) or **[inference]**.

The most serious change: the import feature stops being all-or-nothing. Under 8.1, `return false` inside `Import#apply`'s transaction commits the half-finished import instead of rolling it back. Most of the other silent changes involve background jobs and time zones.

## Facts about the app that the ratings depend on (please correct any that are wrong)

1. **Framework defaults stay at 7.0.** `config/application.rb:12` keeps `load_defaults 7.0`, and 8.1 still supports that. Most ratings assume you keep it at first; raising it brings in the extra changes listed under M5.
2. **Ruby and dependencies resolve.** Ruby 3.3.6 meets 8.1's minimum of 3.2. Rack stays at 2.2, because Sidekiq 6.5.12 requires `rack ~> 2.0` and Rails 8.1 accepts rack ≥ 2.2.4. The `concurrent-ruby 1.3.4` and `minitest ~> 5.25` pins still satisfy 8.1. [code; I didn't run a bundle resolution]
3. **Database:** PostgreSQL only (`config/database.yml:18`).
4. **Front end:** HTML with ERB, Sprockets, importmap and Turbo. There are no JSON endpoints.
5. **Background jobs:**
   - Active Job uses Rails' built-in `:sidekiq` adapter with Sidekiq 6.5.12 and redis 4.8.1 (`config/application.rb:24`); tests use `:test`.
   - Jobs are queued inside `with_lock` transactions (`app/models/citation.rb:15`, `app/models/note.rb:57`).
   - `DigestJob` takes a TimeWithZone and a BigDecimal as arguments.
   - Reminder jobs can sit in Sidekiq's schedule for weeks, so 8.1 workers will run jobs that 7.0 queued. I checked that 8.1 reads 7.0 job data. [code]
6. **I assumed web and worker processes may run different versions during a deploy.** If you stop everything at once, H3 drops in severity.
7. **Caching:** production sets no `cache_store`, so the default file store is used, only for the fragment on the exports page.
8. **Rich text and files:** Action Text uses a vendored Trix 1.3.5; Active Storage uses the Disk service with no image processor.
9. **Citations:** the primary key is `doi` and the table has no `id` column.
10. **Stored data:** each user's `time_zone` is stored as a Rails zone name.

## High risk (behavior changes without raising an error)

**H1. `return` inside a transaction now commits instead of rolling back.** [changelog 7.2, code]
- **Before:** in 7.0, leaving a `transaction` block early with `return` rolled it back.
- **Now:** it commits.
- **Where:** `app/models/import.rb:53-58`, `return false unless row.note.save`.
- **What could go wrong:** if a later row fails to save, the import record, the earlier rows' notes and any new citations are kept. The page then says "Nothing has been saved" (`app/views/imports/preview.html.erb:18`). The import test that checks invalid rows save nothing (`test/controllers/imports_controller_test.rb`, `record_counts`) should catch it.
- **Fix:** `raise ActiveRecord::Rollback` inside the block.
- **Link:** https://github.com/rails/rails/commit/eccc6061f4

**H2. Time arguments to jobs now come back in their own zone.** [changelog 7.2, code]
- **Before:** a TimeWithZone argument was rebuilt in UTC on the worker.
- **Now:** the job data also stores the zone name, and the worker rebuilds the time in the reader's zone.
- **Where:** `app/models/user.rb:35-41` and `app/mailers/digest_mailer.rb:8-9`.
- **What could go wrong:**
  - The digest's date, subject and list of notes switch from the UTC day to the reader's local day.
  - The once-per-day check still uses the UTC date (`user.rb:36`), so near midnight the two days disagree. A reader can get two digests that cover the same local day, or miss notes.
  - During a mixed deploy, 7.0 workers ignore the new zone field and 8.1 workers treat old jobs as UTC.
  - `test/controllers/digests_controller_test.rb:33-35` will fail.
  - `ARCHITECTURE.md` describes the 7.0 behavior.
- **Link:** https://github.com/rails/rails/commit/18098ccc4c

**H3. BigDecimal job arguments use a new format.** [changelog 7.2/8.0, code]
- **Before:** BigDecimal went into the job data as a raw value and reached the worker as a string.
- **Now:** it is always written in a tagged format (`ActiveJob::Serializers::BigDecimalSerializer`) and the old setting is removed.
- **Where:** the `reading_completion` argument (`user.rb:41`).
- **What could go wrong:** a 7.0 worker can't read that format, so `DigestJob`s queued by 8.1 web servers fail and are retried until the workers are upgraded. Rolling back after a deploy has the same problem. Once everything runs 8.1 it works: `BigDecimal(params[:completion])` accepts a BigDecimal.
- **Link:** https://github.com/rails/rails/commit/2a761d23d2

**H4. `record[:id]` no longer reads a custom primary key.** [changelog 7.1/7.2, code]
- **Before:** `citation[:id]` returned the DOI, because `doi` is the primary key.
- **Now:** it reads a column literally named `id`. `citations` has none, so it returns nil.
- **Where:** `app/models/import.rb:68`.
- **What could go wrong:** the downloadable CSV receipt has an empty DOI column. The receipt assertion in `test/controllers/imports_controller_test.rb` catches it.
- **Fix:** use `citation&.doi`.
- **Link:** https://github.com/rails/rails/commit/39997a0f04

**H5. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys.** [changelog 8.0, code]
- **Before:** Integer keys stayed Integers.
- **Now:** they become strings.
- **Where:** `app/views/imports/preview.html.erb:22`, then `annotations[row.line]` at line 42 (the keys come from `app/models/import.rb:38-42`).
- **What could go wrong:** annotations silently disappear from the import preview. The `#line_2 dd` assertion in `test/controllers/imports_controller_test.rb` catches it.
- **Link:** https://github.com/rails/rails/commit/e8574542f8

**H6. `TimeWithZone#to_time` now keeps the zone.** [changelog 8.0/8.1, code]
- **Before:** the app's defaults made it keep only the UTC offset.
- **Now:** it always keeps the full zone.
- **Where:** `app/models/note.rb:44`, shown in `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:** across a DST change, the "24 hours later" preview shows the new offset (for example 08:00 −05:00 instead of 09:00 −04:00). The moment in time and the stored postponement don't change; `.to_i` is unaffected. `test/controllers/reminders_controller_test.rb:21` fails.
- **Links:** https://github.com/rails/rails/commit/9dcf17ec4c and https://github.com/rails/rails/commit/c79dc282d6

**H7. The "Astana" time zone now maps to a different region.** [changelog 7.2, code]
- **Before:** "Astana" mapped to Asia/Dhaka (UTC+6).
- **Now:** it maps to Asia/Almaty. Current timezone data puts Almaty at UTC+5 [inference].
- **Where:** stored `users.time_zone` values, used by `User#local_time` and reminder display.
- **What could go wrong:** readers set to Astana enter and see reminder times one hour off. "Canberra" and "Greenland" were re-pointed to equivalent regions, which I believe have the same rules [inference]. "Asuncion" was added.
- **Link:** https://github.com/rails/rails/pull/51317

**H8. Action Text plain-text output changed.** [code]
- **Before:** `<script>`/`<style>` text was included, and numbered lists counted whitespace between `<li>` tags.
- **Now:** `<script>`/`<style>` text is dropped, and list numbers count only elements. HTML with whitespace between `<li>` tags used to come out as "2.", "4.", and now comes out as "1.", "2.".
- **Where:** Markdown exports (`app/models/export.rb:78`) and excerpts (`app/views/notes/index.html.erb:53`, `app/views/imports/preview.html.erb:58`). This mainly matters for imported `body_html`.
- **Links:** https://github.com/rails/rails/commit/bd0729ce37 and https://github.com/rails/rails/commit/0a5faeaf71

**H9 (small impact). Notes get a second `updated_at` bump after an attachment is analyzed.** [changelog 7.1, code]
- **Before:** attaching a file touched the record once.
- **Now:** when the blob's background analysis finishes, it touches the attachment, then the rich text, then the Note again.
- **Where:** `DigestMailer` picks notes by `updated_at` (`digest_mailer.rb:9`).
- **What could go wrong:** usually the same moment as the save. If the worker is backed up past midnight, the note counts toward the next day's digest.
- **Link:** https://github.com/rails/rails/commit/294c271062

**H10 (small impact). Negative cache expiry is handled differently.** [changelog 7.1, code]
- **Before:** a negative `expires_in` wrote an already-expired entry.
- **Now:** the option is dropped, the entry is stored with no expiry, and an error is logged and reported on every fetch.
- **Where:** `app/views/exports/_export.html.erb:26`, for any expired completed export when caching is on.
- **What could go wrong:** the content stays correct ("Expired"), but production logs get noisy.

## Medium risk (errors whose fix needs a decision)

**M1. `Rails.application.secrets` is removed.** [changelog 7.1/7.2]
- **Where:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, and `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **What could go wrong:** the app still boots. The NoMethodError comes when `CitationEnrichmentJob` runs; Sidekiq then retries it and citations stay "pending".
- **Decision:** `config_for(:citation_provider)` keeps the per-environment ERB file (and the `.to_json` quoting trick), and its keys are symbols. The alternatives are credentials or reading ENV directly. The test that reassigns `secrets.citation_provider` needs a new seam.
- **Link:** https://github.com/rails/rails/commit/0c76f17f2d

**M2. The built-in Sidekiq adapter is deprecated and will be removed in 8.2.** [changelog 8.1, code]
- **Now:** it still works with Sidekiq 6.5.12; I checked `Setter#perform_async`, `perform_at`, and the stringified keys. It logs a deprecation warning at boot in development and production.
- **Where:** `config/application.rb:24`.
- **Decision:** the replacement needs Sidekiq ≥ 7.3.3, which replaces redis-rb with redis-client [inference]. That would affect:
  - the `if Sidekiq.redis { |r| r.sadd(...) }` check in `user.rb:38`, which would always be true if redis-client returns 0/1 instead of a boolean;
  - `rescue Redis::BaseError` in `notebook.rb:28`;
  - the `Redis::CannotConnectError` stub in `digests_controller_test.rb:50`.
- **Link:** https://github.com/rails/rails/pull/53058

**M3. Action Text now ships Trix 2 through the new `action_text-trix` gem.** [changelog 8.1, code]
- **Where:** the layout loads vendored Trix 1.3.5 (`app/views/layouts/application.html.erb:13`), and `config/importmap.rb:8` pins `actiontext.js`. In 8.1 that file is a UMD bundle; the ES module is now `actiontext.esm.js`.
- **Now:** it probably still works, because the bundle falls back to `globalThis` and only calls `setUploadProgress`/`setAttributes` [inference, not tried in a browser].
- **Decision:** keep Trix 1.3.5, or move to Trix 2 (`pin "trix"` plus the ESM build) and update `ARCHITECTURE.md:207-212`. Check attachment upload in a browser either way.
- **Link:** https://github.com/rails/rails/commit/d0d2d31f62

**M4. `show_exceptions = false` in the test environment now means "show all".** [changelog 7.2, code]
- **Where:** `config/environments/test.rb:31`.
- **What could go wrong:** every `assert_raises(ActiveRecord::RecordNotFound)` test fails. Worse, other exceptions turn into rendered error pages, so tests that don't check the status can pass. That would hide the Low-risk errors below.
- **Decision:** `:none` keeps today's behavior; `:rescuable` is the 8.1 generator default. Fix this first.
- **Link:** https://github.com/rails/rails/commit/ec2c2666c2

**M5. Newer framework defaults that would break the app if you raise `load_defaults`.** [code]
- **7.1 `raise_on_assign_to_attr_readonly`:** notebook settings updates raise, because the form resubmits the slug (`app/views/notebooks/_form.html.erb:13`, `notebooks_controller.rb:40`).
- **7.1 `default_column_serializer = nil`:** `serialize :preferences` (`notebook.rb:7`) raises.
- **7.1 `raise_on_invalid_cache_expiration_time`:** the exports page raises for expired exports (see H10).
- **7.2 `postgresql_adapter_decode_dates`:** `Date.iso8601(Date)` raises TypeError in `notebook.rb:40`.
- **7.1 HTML5 sanitizer:** small differences in how rich text is cleaned.
- **8.0 `strict_freshness`:** changes how `stale?` in `export_downloads_controller.rb:11` treats conditional requests.

## Low risk (each raises when booting or in the existing tests)

- `serialize :tags, JSON` (`note.rb:12`): the class-as-second-argument form is gone; use `coder: JSON` ([8069cc83e8](https://github.com/rails/rails/commit/8069cc83e8)).
- `enum status: …, _prefix: true` (`note.rb:10`): keyword form removed; use `enum :status, {…}, prefix: true`, which keeps the same scope names ([b9226a68bb](https://github.com/rails/rails/commit/b9226a68bb)).
- `alias_attribute :highlight_color, :color` (`note.rb:14`): `color` is a store accessor, not an attribute, so this raises ArgumentError; use `alias_method` for the reader and writer ([94d24f4504](https://github.com/rails/rails/commit/94d24f4504)).
- `where(notebooks: @notebook)` (`notes_controller.rb:12`): the plural name no longer resolves to `belongs_to :notebook`; use `where(notebook:)` ([4bf2c4cea1](https://github.com/rails/rails/commit/4bf2c4cea1); the exact error is my inference).
- `fragments.sum` (`export.rb:42`): Rails' `sum` override is gone and Ruby's raises TypeError for strings, which leaves the export stuck in "working"; use `join` ([3ec629784c](https://github.com/rails/rails/commit/3ec629784c)).
- `wait: :exponentially_longer` (`citation_enrichment_job.rb:7`): raises on the first retry; `:polynomially_longer` uses the same formula ([03dae98092](https://github.com/rails/rails/commit/03dae98092)).
- `set(wait_until: <Integer>)` (`note.rb:61`): raises NoMethodError `utc` while the job is being queued; use `Time.at(epoch)` ([798289699d](https://github.com/rails/rails/commit/798289699d)).
- `form_with(model: nil, …)` (`notes/index.html.erb:12`): raises ArgumentError; drop `model: nil` ([0c150bacaa](https://github.com/rails/rails/commit/0c150bacaa)).
- `get "/notes", "/journal", to:` (`config/routes.rb:18`): one route with two paths raises at route load; split it into two `get` lines ([d1f523dbfb](https://github.com/rails/rails/commit/d1f523dbfb)).
- `ActionText::ContentHelper.allowed_tags += …` (`config/initializers/action_text.rb:3`): the default is now nil, so boot fails. Assign the full list (`sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`). Assigning only the two tags would silently strip all other formatting ([e8137c527d](https://github.com/rails/rails/commit/e8137c527d)).
- Development and test secrets: they now come from credentials or `tmp/local_secret.txt` instead of `tmp/development_secret.txt`, so dev sessions and dev rich-text attachment links stop working; copy the old file across. Production is unaffected. [code]
- Cosmetic: `schema.rb` will list columns alphabetically, and parallel test databases are named `_N` instead of `-N`. [changelog 8.1]

## Parts of Rails judged not relevant

- MySQL, SQLite and Trilogy adapter changes: the app uses PostgreSQL only.
- `enqueue_after_transaction_commit`: it defaults to false in 8.1 and no `load_defaults` turns it on, so jobs queued inside `with_lock` still go out immediately. [code]
- `ActiveRecord::Base.connection` deprecation (`notebook.rb:40`): it only warns when `permanent_connection_checkout` is set.
- Action Cable: no channels. The production Redis adapter accepts redis 4.8.1.
- Action Mailbox, Active Record encryption, multiple databases and sharding: not used.
- Active Storage variants, previews and cloud services (including the Azure removal): the app uses the Disk service with no image processor.
- JSON rendering and escaping changes: there are no JSON views.
- Rack 3 changes: the app stays on Rack 2.2.
- Solid Queue/Cache/Cable, Propshaft, Kamal, the authentication generator and `bin/ci`: these only affect newly generated apps.
- Cache format: the 7.0 format is still supported.
- `to_time_preserves_timezone` deprecation: the app doesn't set it.
- Semicolon query separators and leading-bracket parameter names: not used.

The unpacked gem sources are in `/tmp/railsdiff/src/<version>/<gem>` (versions 7.0.8.7, 8.1.0, and changelogs for 7.1.0, 7.2.0, 8.0.0). Sidekiq 6.5.12 is in `/tmp/railsdiff/sidekiq/src`, and a blobless clone of rails/rails (for commit lookups) is in `/tmp/railsdiff/repo/rails`.

---

I haven't upgraded yet. The repo is unchanged and still pins `gem "rails", "7.0.8.7"`. The report above is from a review step, and I stopped there so you can read it before anything changes.

Before I start, there are a few things to decide:

- **Mixed deploys (H2, H3):** will web and worker processes ever run different versions at the same time? If not, these become much less risky.
- **Daily digest (H2):** should the digest go back to using the UTC day, or switch to each reader's local day? If it switches, the once-per-day check in `user.rb:36` needs the same change.
- **Citation provider secrets (M1):** move them to `config_for`, to credentials, or read them from ENV?
- **Sidekiq adapter (M2):** keep the deprecated built-in adapter for now, or upgrade to Sidekiq ≥ 7.3.3, which brings the Redis client changes listed in M2?
- **Trix (M3):** keep the vendored Trix 1.3.5, or move to Trix 2?
- **Framework defaults (M5):** I'd keep `load_defaults 7.0` for this upgrade and raise it separately later.

If you say go, I'd fix `show_exceptions` (M4) first so the test suite gives reliable results. Then I'd bump the gem and fix the rest.