I rated 17 changes in the Rails 7.0.8.7 to 8.1.0 upgrade: 4 high, 4 medium and 9 low. The biggest risks are background-job data and time zones, which tests are unlikely to catch. I read the 8.1.0 component gems (activesupport, activerecord, activejob, actiontext, actionpack, railties), downloaded to `/tmp/g81`, and the app's code. I did not fetch the changelog files or PR pages, so nothing below is confirmed from a changelog. Each claim is marked **[source]** (read in 8.1.0 code), **[app]** (read in app code) or **[recall]** (my memory of which release made the change; please check the CHANGELOGs).

## Facts the ratings depend on (please correct any that are wrong)
- `config.load_defaults 7.0` (`config/application.rb`). I assume it stays at 7.0 at first, so the new defaults below only bite if you raise it.
- PostgreSQL only. There is no MySQL or SQLite, so those adapter changes don't apply.
- Active Job runs on Sidekiq 6.5.12 with redis 4.8.1. `ExportJob` is a native Sidekiq job.
- The app renders HTML: sprockets, importmap, Turbo, Action Text, Active Storage on local disk, and a fragment cache in `app/views/exports/_export.html.erb`.
- Production sets no cache store, so it uses the default file store.
- Production hides deprecation reports (`report_deprecations = false`), so you won't see deprecation warnings there.
- `config/secrets.yml` is read through `Rails.application.secrets`.
- Ruby 3.3.6 is fine (8.x needs at least 3.2). Puma 5, minitest 5 and the concurrent-ruby 1.3.4 pin look fine [recall].

## High

**1. Active Job keeps a time's own time zone (Rails 7.1) [source + recall]**
- **Before:** 7.0 turned a `TimeWithZone` argument back into a time in `Time.zone`, which is UTC here.
- **Now:** 8.1 stores `"time_zone"` alongside the time and restores it (`activejob/lib/active_job/serializers/time_with_zone_serializer.rb`).
- **Where:** `User#request_digest` passes `requested_at` in the reader's zone (`app/models/user.rb:182,188`). `DigestMailer#daily_digest` relies on getting UTC back (`app/mailers/digest_mailer.rb:3-5,348-349`).
- **What could go wrong:** the digest would cover the reader's local day instead of the UTC day. That changes which notes go out and the date in the subject. The comments, tests (`test/controllers/digests_controller_test.rb`) and the Redis reservation key, which stays on the UTC day, would no longer agree with what is sent.

**2. BigDecimal job arguments get a new format (Rails 7.1 option, the only behavior in 8.x) [source + recall]**
- **Before:** in 7.0 a BigDecimal went into the queue as a plain string.
- **Now:** 8.1 always uses `BigDecimalSerializer` (`activejob/lib/active_job/serializers.rb:107`), and the `use_big_decimal_serializer` setting is gone.
- **Where:** `DigestJob.perform_later(self, requested_at, reading_completion)` (`app/models/user.rb:188`). The mailer's `BigDecimal(params[:completion])` handles both formats.
- **What could go wrong:** during a rolling deploy, a 7.0 Sidekiq worker can't read a job queued by 8.1 [inference], and that digest is lost. Deploy workers first, or drain the queue.

**3. `TimeWithZone#to_time` always keeps the zone (8.0 default; the setting is deprecated in 8.1) [source]**
- **Before:** under 7.0 defaults, `to_time` returned a Time with a fixed UTC offset.
- **Now:** 8.1's `to_time` is `getlocal(time_zone)` no matter what the setting says (`activesupport/lib/active_support/time_with_zone.rb:497`), and the setting warns that it goes away in 8.2.
- **Where:** `Note#next_day_reminder_at` (`app/models/note.rb:40-45`) is shown with format `"... (UTC%:z)"` in `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:** the scheduled time doesn't change, because `to_i` is the same [inference]. But across a DST change the "24 hours later" label now shows the reader's local wall-clock time and offset, which contradicts the code comment and probably a test.

**4. Negative cache `expires_in` [source]**
- **Before:** 7.0 wrote the entry already expired.
- **Now:** 8.1 logs an `ArgumentError`, drops `expires_in` and writes an entry that never expires (`activesupport/lib/active_support/cache.rb:922-924,937-945`). It raises only if `raise_on_invalid_cache_expiration_time` is turned on.
- **Where:** `cache [export, "availability"], expires_in: export.expires_at - Time.current` (`app/views/exports/_export.html.erb:26`). This goes negative for expired exports, and only in production, because tests use `perform_caching = false`.
- **What could go wrong:** the "Expired" fragment stays in the cache forever and errors fill the logs. If that raise setting is ever turned on, the page fails with a 500. The rendered content looks correct, so this one is mild.

## Medium

**5. `Rails.application.secrets` removed (deprecated 7.1, removed 7.2) [source + recall]**
- **Where:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, and the tests at `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **What could go wrong:** it raises `NoMethodError`. You need to decide whether the citation provider settings move to `config_for(:citation_provider)`, credentials or ENV. The test that swaps settings at runtime will also need rewriting.

**6. PostgreSQL decodes dates in raw queries (7.1 default, `postgresql_adapter_decode_dates`) [source]**
- **Before:** `select_rows` returned dates as strings.
- **Now:** if you adopt 7.1 or later defaults, it returns `Date` objects.
- **Where:** `Notebook#daily_note_counts` calls `Date.iso8601(day)` on the result (`app/models/notebook.rb:140`). That raises `TypeError` once `day` is already a Date [inference].

**7. Writing a read-only attribute raises (7.1 default, `raise_on_assign_to_attr_readonly`) [source]**
- **Where:** `attr_readonly :slug` (`app/models/notebook.rb:108`). The settings form resubmits the slug as a hidden field (`app/views/notebooks/_form.html.erb:13`), and the controller permits it (`app/controllers/notebooks_controller.rb:40`).
- **What could go wrong:** with the 7.1 defaults, every notebook update raises. You need to decide whether to stop permitting `:slug`.

**8. `serialize` without a coder (7.1 default `default_column_serializer = nil`) [source]**
- **Where:** `serialize :preferences` (`app/models/notebook.rb:107`), a YAML text column.
- **What could go wrong:** it raises once defaults go to 7.1. The decision is `coder: YAML` to keep the stored data readable, or a data migration.

## Low
These raise at boot or in tests, and the fix is mechanical.
- **`enum status: {...}, _prefix: true`** (`app/models/note.rb:10`): the keyword form is removed in 8.x [source: `enum(name, values = nil, **options)`]. Change it to `enum :status, {...}, prefix: true`.
- **`serialize :tags, JSON`** (`app/models/note.rb:12`): the coder can no longer be passed positionally [source, serialization.rb:193]. Use `coder: JSON`.
- **`alias_attribute :highlight_color, :color`** (`app/models/note.rb:14`): `color` comes from `store_accessor`, not a real attribute, so this raises `ArgumentError` [source, attribute_methods.rb:90]. Write the alias methods by hand.
- **`retry_on ... wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`): this was removed, and in 8.1 it raises "Couldn't determine a delay" when a retry happens, not at boot [source, exceptions.rb:188]. Use `:polynomially_longer`, which uses the same formula. `test/controllers/citation_enrichments_controller_test.rb:60-71` should catch it.
- **`fragments.sum` on strings** (`app/models/export.rb:247`): ActiveSupport no longer adds string support to `Enumerable#sum` [source: only the Range override remains], so this raises `TypeError` inside `ExportJob`. Use `join`. The exports tests run `ExportJob.drain`, so they should catch it.
- **`ActionText::ContentHelper.allowed_tags += ...`** (`config/initializers/action_text.rb:3`): `allowed_tags` now defaults to `nil` [source, `actiontext/app/helpers/action_text/content_helper.rb:10,69`], so this fails at boot. Build the list from `sanitizer.class.allowed_tags` plus the attachment tags.
- **`config.action_dispatch.show_exceptions = false`** (`config/environments/test.rb:31`): the boolean was replaced by `:none` (7.1, booleans removed 7.2) [recall].
- **Built-in Sidekiq adapter:** still present in 8.1 and still accepts sidekiq 6.5, but it is deprecated and removed in 8.2 [source, `sidekiq_adapter.rb`]. When it goes, you'll need Sidekiq 7.3.3 or later. That upgrade changes the Redis client, which affects `Sidekiq.redis { sadd }` truthiness and `rescue Redis::BaseError` in `app/models/user.rb` and `app/models/notebook.rb` [inference]. Plan for it now.
- **`Note.connection`** (`app/models/notebook.rb:140`): soft-deprecated in 7.2 in favour of `with_connection` or `lease_connection` [recall]. No error.

## Judged not relevant
- **MySQL, SQLite and Trilogy adapters:** the app uses PostgreSQL.
- **`enqueue_after_transaction_commit`:** it defaults to `false` in 8.1 [source, `enqueuing.rb:53`], so jobs queued under `with_lock` in `Note` and `Citation` still enqueue right away.
- **Cache format versions:** the app stays on the 7.0 format. Moving to the 7.1 format is only a concern if you change the defaults.
- **Propshaft, Solid Queue/Cache/Cable, Kamal, Thruster and the authentication generator:** these are new-app defaults, and the app keeps sprockets and Sidekiq.
- **`fixture_path` renamed to `fixture_paths`:** not used in `test/test_helper.rb`.
- **HTML5 sanitizer default (7.1 `sanitizer_vendor`):** only applies if you adopt the new defaults. If you do, re-check the `details` and `summary` allowlist and the `javascript:` URL test.
- **Action Cable, Action Mailbox and Active Storage variants:** not used beyond defaults. `app/channels` holds only the generated base classes, and no image processing gem is installed.

---

I haven't changed anything yet. The `Gemfile` still pins `rails` at `7.0.8.7`. Before I start, decide on items 1 and 5:
- **Item 1:** should digests keep covering the UTC day? If so, convert `requested_at` to UTC before the job is queued.
- **Item 5:** where should the citation provider settings move once `Rails.application.secrets` is gone?

Also decide whether to keep `load_defaults 7.0` for now; items 6–8 only apply if you raise it. Once you've decided, I can make the upgrade, possibly stepping through 7.1, 7.2 and 8.0 first.