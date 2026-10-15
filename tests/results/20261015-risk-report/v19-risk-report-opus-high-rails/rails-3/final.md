# Rails 7.0.8.7 to 8.1.0: changes that affect Margin Notes

I compared the unpacked 7.0.8.7 and 8.1.0 gems for every Rails component, read the 7.1, 7.2, 8.0 and 8.1 changelogs, and read Sidekiq 6.5.12 and 7.3.9. Nothing in the app was installed, changed or run. Each claim is tagged **[changelog]**, **[code]** (gem or app source I read) or **[inference]**.

The changes most likely to slip through are the four that change data or delivered results without raising an error:
- **Import#apply** now commits a half-finished import.
- **Digest emails** now cover the reader's local day instead of the UTC day.
- **Digest jobs** queued by new web servers fail on old workers during a rolling deploy.
- **Import receipt CSVs** come out with an empty DOI column.

There are also about ten mechanical breakages that booting the app or running its tests would catch.

## Facts about the app that the ratings depend on (please correct any that are wrong)

- **Database:** PostgreSQL only (`config/database.yml:18`). `config.time_zone` is not set, so the app runs in UTC. Each reader's time zone is stored in `users.time_zone`.
- **Framework defaults:** `config.load_defaults 7.0` (`config/application.rb:12`). Rails 8.1 still accepts it **[code]**. I assumed you keep it for the upgrade.
- **Jobs:**
  - Active Job runs on the **built-in Rails Sidekiq adapter** with Sidekiq 6.5.12 and redis 4.8.1 (`config/application.rb:24`). Tests use the `:test` adapter.
  - `ExportJob` is a native Sidekiq job.
  - `NoteReminderJob` is scheduled days ahead, so jobs queued under 7.0 will run under 8.1.
  - **I assumed web servers and Sidekiq workers are deployed separately**, so old and new versions can overlap.
- **Sidekiq and Rack versions:** the upgrade can keep Sidekiq 6.5.12, because Rails 8.1 still ships its adapter (removal is planned for 8.2) **[code]**. Sidekiq 6.5.12 requires `rack ~> 2.0`, so Rack should stay at 2.2.x **[inference]**. Sidekiq 6.5.12's Rails integration already supports the 7.1+ logger **[code]**.
- **Front end:** a server-rendered HTML app using Sprockets, importmap and Turbo. No JSON responses.
- **Action Text:** the app loads its own copy of Trix 1.3.5 (`app/views/layouts/application.html.erb:13`). The allowlist is extended in `config/initializers/action_text.rb:3`.
- **Active Storage:** Disk service only, no image processing.
- **Cache:** production doesn't set a cache store, so it uses the default file store. The only fragment cache is in `app/views/exports/_export.html.erb:26`.
- **Provider settings:** the citation provider is configured through `Rails.application.secrets` and `config/secrets.yml`.
- **Runtime versions:** Ruby 3.3.6 meets 8.1's `>= 3.2` requirement. All other locked gem versions satisfy 8.1's dependency ranges **[code]**.

## High risk

**1. A `return` inside a transaction now commits instead of rolling back**
- **Before:** in 7.0, leaving a `transaction` block early with `return` rolled the transaction back **[code]**.
- **Now:** 8.0 removed the option to keep that, and 8.1 commits **[code, changelog]**.
- **Where:** `app/models/import.rb:53-56` returns `false` from inside `transaction do` when a row fails to save.
- **What could go wrong:** the Import record and the rows saved before the failing row stay in the database, while the user is told nothing was saved. `test/controllers/imports_controller_test.rb:65-72` should catch it.
- **Link:** https://github.com/rails/rails/pull/48600

**2. Time arguments to jobs now keep the reader's time zone**
- **Before:** `ActiveSupport::TimeWithZone` job arguments came back in the worker's zone (UTC) **[code]**.
- **Now:** since 7.1 they come back in the zone they were sent from **[code, changelog]**.
- **Where:** `app/models/user.rb:41` passes the reader's local `requested_at`. `app/mailers/digest_mailer.rb:8-9` uses `.to_date` and `.all_day` on it.
- **What could go wrong:**
  - The digest covers the reader's local day, and the subject date changes (for example October 04 instead of October 05 in `test/controllers/digests_controller_test.rb:33`).
  - The once-per-day limit is still counted per UTC day.
  - The comments in the mailer and the hint in `app/views/accounts/edit.html.erb:16` will no longer be true.
- **Link:** https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md (7.1.3)

**3. BigDecimal job arguments now use a format 7.0 workers can't read**
- **Before:** 7.0 queued a BigDecimal as a plain string.
- **Now:** 8.1 always wraps it as `ActiveJob::Serializers::BigDecimalSerializer`. The opt-out setting was removed in 8.0 **[code, changelog]**.
- **Where:** `app/models/user.rb:41` passes `reading_completion`, a BigDecimal (`user.rb:56`).
- **What could go wrong:** during a rolling deploy, a 7.0 worker raises "Serializer ... is not known", which becomes `DeserializationError`. `DigestJob` doesn't discard on that, so Sidekiq retries it until a new worker picks it up. Digests are delayed, and could be lost if retries run out. The reverse direction is fine: `BigDecimal(params[:completion])` at `digest_mailer.rb:10` accepts the old string **[code]**.
- **Link:** https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md

**4. `record[:id]` no longer returns a custom primary key**
- **Before:** in 7.0, `read_attribute(:id)` mapped to the primary key.
- **Now:** in 7.2+, it reads a column literally named `id`. `citations` has no such column, so the value is `nil` with no error **[code]**.
- **Where:** `app/models/import.rb:68` (`citation[:id]`).
- **What could go wrong:** the DOI column of the import receipt CSV is silently empty. `test/controllers/imports_controller_test.rb:45` should catch it. The fix is `citation.doi` or `citation.id`.
- **Link:** https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md

**5. `TimeWithZone#to_time` now keeps the full zone, not just the offset**
- **Before:** under your defaults, `to_time` returned a Time with a fixed offset.
- **Now:** 8.1 always returns a Time carrying the zone **[code, changelog]**.
- **Where:** `app/models/note.rb:44` (`next_day_reminder_at`), shown in `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:** across a daylight saving change, the "24 hours later" preview shows the new offset and wall-clock time, for example 08:00 at UTC-05:00 instead of 09:00 at UTC-04:00. The scheduled time itself is unchanged, so this only affects the label **[inference]**. `test/controllers/reminders_controller_test.rb:21` and the comment at `note.rb:40-42` will disagree.
- **Link:** https://github.com/rails/rails/blob/8-1-stable/activesupport/CHANGELOG.md (8.1.0)

**6. A negative cache `expires_in` now means the entry never expires**
- **Before:** in 7.0, a negative value made the entry expire immediately.
- **Now:** since 7.1 the option is dropped and an error is logged and reported. Under your defaults it doesn't raise **[code, changelog]**.
- **Where:** `app/views/exports/_export.html.erb:26`, where `expires_at - Time.current` is negative for expired exports.
- **What could go wrong:** the "Expired" fragment is cached with no expiry, and every render logs an `ArgumentError`. What users see stays correct, so the impact is small **[inference]**.
- **Link:** https://github.com/rails/rails/blob/7-1-stable/activesupport/CHANGELOG.md

**7. Action Text's plain-text conversion changed**
- **Before:** `<script>` and `<style>` text was included, and numbered-list bullets counted whitespace nodes.
- **Now:** `<script>` and `<style>` produce no text, and numbering counts only elements **[code]**.
- **Where:** `app/models/export.rb:110` builds the Markdown export from `to_plain_text`, and imported `body_html` is stored as given. Excerpts in `app/views/notes/index.html.erb:53` are also affected.
- **What could go wrong:** export file contents change for those notes. This is a narrow change.
- **Link:** none. I found no changelog entry for this; it comes from diffing `plain_text_conversion.rb`.

**8. The "Astana" time zone now maps to Asia/Almaty**
- **Before:** Asia/Dhaka (UTC+6).
- **Now:** Asia/Almaty, which is UTC+5 with current tz data **[code, changelog]**.
- **Where:** `app/models/user.rb:13` and `:22`, and `note.rb:37`.
- **What could go wrong:** for readers set to Astana, reminder times shift by an hour, both when entered and when displayed. Other mapping changes (Canberra, Greenland, the new Asuncion zone) don't change offsets **[inference]**.
- **Link:** https://github.com/rails/rails/blob/7-2-stable/activesupport/CHANGELOG.md

## Medium risk

**`Rails.application.secrets` was removed**
- **Before:** deprecated in 7.1. **Now:** removed in 7.2 **[changelog]**.
- **Where:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, and the test helper at `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **What could go wrong:** a `NoMethodError` when enrichment runs, not at boot.
- **Decision needed:** there's no direct replacement. Choose between `config_for(:citation_provider)`, credentials, or ENV. Keep the `.to_json` quoting that the environment test checks.
- **Link:** https://github.com/rails/rails/blob/7-2-stable/railties/CHANGELOG.md

**The built-in Sidekiq adapter is deprecated and will be removed in 8.2**
- 8.1 logs a deprecation warning when the adapter is set at `config/application.rb:24` **[code, changelog]**.
- The fix is Sidekiq 7.3.3 or later. In Sidekiq 7.3.9's source **[code]**:
  - `redis.sadd` returns 0 or 1. Both are truthy in Ruby, so the once-per-day digest check at `app/models/user.rb:38` silently stops working.
  - Redis errors become `RedisClient::Error`, so `rescue Redis::BaseError` at `app/models/notebook.rb:28` stops catching them.
  - Strict argument checking raises on the symbol-key hash `{ format: "markdown" }` at `notebook.rb:26`.
- The wrapper class name is unchanged, so queued jobs stay compatible **[code]**.
- **Link:** https://github.com/rails/rails/blob/8-1-stable/activejob/CHANGELOG.md

**`show_exceptions = false` in the test environment is no longer supported**
- **Where:** `config/environments/test.rb:31`.
- **What changed:** 7.2 removed support for `true` and `false`. 8.1 treats any unrecognised value as `:all`, so test exceptions are rendered as error pages instead of raised, with no warning **[code, changelog]**.
- **What could go wrong:** the many `assert_raises(ActiveRecord::RecordNotFound)` tests will fail.
- **Decision needed:** `:none` keeps today's behaviour; `:rescuable` is the new generated default.

**Framework defaults after 7.0 (only matters when you raise `load_defaults`)**

Each new default breaks something specific in this app **[code]**:
- **7.1, `default_column_serializer = nil`:** `serialize :preferences` at `app/models/notebook.rb:7` raises.
- **7.1, `raise_on_assign_to_attr_readonly`:** the notebook settings form re-submits the slug (`app/controllers/notebooks_controller.rb:40`), which then raises.
- **7.1, `raise_on_invalid_cache_expiration_time`:** expired exports make the exports page raise (see High item 6).
- **7.1, `action_text.sanitizer_vendor`:** switches Action Text to the HTML5 sanitizer.
- **7.2, `postgresql_adapter_decode_dates`:** `Date.iso8601(day)` at `notebook.rb:40` gets a `Date` instead of a string and raises a `TypeError`.
- **8.0, `strict_freshness`:** changes how ETags and `If-Modified-Since` interact in `app/controllers/export_downloads_controller.rb:11`.

## Low risk (booting or running the tests would catch these)

- **`serialize :tags, JSON`** (`note.rb:12`): the positional coder argument now raises; use `coder: JSON` **[code]**.
- **`enum status: {...}, _prefix: true`** (`note.rb:10`): the keyword form now raises an `ArgumentError`; use `enum :status, {...}, prefix: true` **[code]**.
- **`alias_attribute :highlight_color, :color`** (`note.rb:14`): `color` is a store accessor, not an attribute, so this raises since 7.2; define the reader and writer with `alias_method` **[code]**.
- **`fragments.sum`** (`export.rb:42`): Rails no longer sums strings (7.1), so this raises a `TypeError` and exports never finish; use `join` **[code]**.
- **`set(wait_until: reminder_epoch)` with an Integer** (`note.rb:61`): raises `NoMethodError` (`utc`) when the job is queued (7.2); use `Time.at(reminder_epoch)` **[code]**.
- **`wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`): removed in 7.2, and it only raises when a retry happens. If missed in production, citations stay "pending" for good. Use `:polynomially_longer`, which has the same timing **[code]**.
- **`get "/notes", "/journal", ...`** (`config/routes.rb:18`): multiple paths in one route were removed in 8.1 and now raise when the routes load; write two routes and keep the `journal` name **[code, changelog]**.
- **`allowed_tags +=`** (`config/initializers/action_text.rb:3`): `allowed_tags` is now `nil` by default (7.1), so boot fails. Build the list from `sanitizer.class.allowed_tags` plus `action-text-attachment`, `figure`, `figcaption`, `details` and `summary`. Setting only `%w[details summary]` would silently strip every other tag **[code]**.
- **Trix:** Action Text 8.1 depends on the `action_text-trix` gem (Trix 2.1.15), but the app keeps loading its own 1.3.5. `actiontext.js` still uses the same Trix API, so this probably works, but check uploads in a browser **[inference]**.
- **Schema dump and dev secret:** `db/schema.rb` will be rewritten with an 8.1 header, and the development secret moves to `tmp/local_secret.txt`, which signs out local sessions **[inference]**.

## Judged not relevant

- **MySQL, SQLite and Trilogy changes:** the app uses PostgreSQL.
- **PostgreSQL minimum version:** still 9.3; `pg 1.6.0` meets `~> 1.1`.
- **Jobs enqueued inside a transaction:** 8.1 defaults to queuing immediately, as 7.0 did, so the jobs queued under `with_lock` behave as before **[code]**.
- **Rack 3 changes** (such as `:unprocessable_entity`): Rack isn't upgraded.
- **Action Cable** (no channels), **Action Mailbox** (unused), **Active Storage** variants, previews and cloud services (Disk only, no image processing).
- **JSON escaping and `escape_json_responses`:** the app serves HTML only; Jbuilder is installed but has no templates.
- **Solid Queue, Propshaft and YJIT:** these are new-app generator defaults only.
- **Fixes released after 8.1.0** (8.1.1 to 8.1.4, such as the Kyiv zone rename and integer-string limits): not part of 8.1.0.
- **Unchanged:** `TimeZone#iso8601`, `TimeZone#at`, the default locales (only additions), and `select_rows` on a relation.

The unpacked gems and changelogs are in `/tmp/gems/old`, `/tmp/gems/new`, `/tmp/gems/cl`, `/tmp/gems/sidekiq` and `/tmp/gems/sidekiq7`, if you want to look closer.

---

I haven't changed anything yet. This is a review of the upgrade from Rails 7.0.8.7 to 8.1.0 so you can decide before I start. Before I make the change, I need three answers:

1. **Your deploy setup.** Can old and new Sidekiq workers run at the same time during a deploy? If so, BigDecimal digest jobs from the new version will fail on old workers (High #3).
2. **Which day the digest covers.** Should it cover the reader's local day (the new behaviour) or the UTC day (today's behaviour)? See High #2.
3. **Scope.** Should this stay a Rails-only upgrade that keeps `load_defaults 7.0` and Sidekiq 6.5.12? And where should the citation provider settings move now that `secrets` is gone: `config_for`, credentials, or ENV?