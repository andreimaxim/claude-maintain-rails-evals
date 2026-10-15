I found 12 changes in Rails 7.0.8.7 → 8.1.0 that affect Margin Notes: 4 high, 2 medium and 6 low. Most of them come from Active Job and Active Support.

To find them, I downloaded and read the released 8.1.0 source of activejob, activerecord, activesupport and railties into `/tmp/g/`. I compared that source with this app's code and did not install or run anything. I did not read actionpack, actionview, actiontext or activestorage line by line, so the "not relevant" list below is partly inference. Labels used below: [source] means read in the 8.1.0 gem source, [app] means read in this repo, [inference] means my own reasoning. Links point to the official upgrade guide (https://guides.rubyonrails.org/upgrading_ruby_on_rails.html) and the CHANGELOGs on GitHub (https://github.com/rails/rails/blob/v8.1.0/<component>/CHANGELOG.md, plus the 7-1-stable, 7-2-stable and 8-0-stable branches).

## Facts about the app the ratings depend on (please correct if wrong)
- **Rails setup:** `config.load_defaults 7.0`, so 7.1+ defaults do not apply unless adopted. The app renders HTML with Sprockets, importmap, Turbo, Stimulus, Action Text and Active Storage on local disk. Jbuilder is in the Gemfile. [app]
- **Database:** PostgreSQL only (`config/database.yml`). [app]
- **Jobs:** Active Job runs on `:sidekiq` 6.5.12 with redis 4.8.1 (`config/application.rb:24`). `ExportJob` is a native `Sidekiq::Job`. I assume production does a rolling deploy, so old and new workers will share Redis for a while. [app / inference]
- **Settings:** the app reads settings from `config/secrets.yml` through `Rails.application.secrets`. [app]
- **Versions:** Ruby 3.3.6 meets Rails 8.1's minimum. Puma is `~> 5.0`. [app]

## High risk

**1. Time-with-zone job arguments now keep their zone (Active Job 7.1)**
- **Before:** 7.0 deserialized an `ActiveSupport::TimeWithZone` argument in `Time.zone`, which is UTC here.
- **Now:** the serializer stores `"time_zone"` and deserializes in the original zone. [source] `activejob/lib/active_job/serializers/time_with_zone_serializer.rb:8-17`
- **Where:**
  - `app/models/user.rb:35,41` passes `Time.current.in_time_zone(time_zone)` to `DigestJob`.
  - `app/mailers/digest_mailer.rb:7-9` uses `requested_at.to_date` and `requested_at.all_day`, and its comment says it relies on the UTC behaviour.
- **Risk:** the digest will silently cover the reader's local day instead of the UTC day. The subject date and note set change near midnight, and they no longer match the UTC Redis reservation key at `user.rb:36`. [inference]
- **Link:** activejob CHANGELOG 7.1.

**2. BigDecimal job arguments are always serialized as BigDecimal (7.1 opt-in, now always on)**
- **Before:** 7.0 handed `BigDecimal` to Sidekiq's JSON, so it arrived as a string. The comment at `digest_job.rb:5-6` relies on this.
- **Now:** `BigDecimalSerializer` is in the default serializer list. [source] `activejob/lib/active_job/serializers.rb:107`
- **Where:** `DigestJob.perform_later(..., reading_completion)` at `app/models/user.rb:41,54-57`. The new worker side still works, because `BigDecimal(BigDecimal)` is accepted.
- **Risk:** during a rolling deploy, 7.0 workers cannot deserialize a payload enqueued by 8.1, so `DeserializationError` fails the digest job. Sidekiq retries it but the digest may not arrive, and that day's reservation is already taken. [inference] The fix is to deploy workers first, or pass `.to_s`.
- **Link:** upgrade guide, 7.1 `use_big_decimal_serializer`.

**3. `retry_on wait: :exponentially_longer` no longer exists**
- **Before:** 7.0 accepted `:exponentially_longer`.
- **Now:** `determine_delay` only accepts `:polynomially_longer`, a Duration, an Integer or a Proc. Anything else does `raise "Couldn't determine a delay..."`. [source] `activejob/lib/active_job/exceptions.rb:171-189`
- **Where:** `app/jobs/citation_enrichment_job.rb:7`.
- **Risk:** boot does not fail. The error appears only when the provider returns `Unavailable`. The retry then raises a RuntimeError instead of rescheduling, and Sidekiq's own retries take over. Most likely the block that calls `fail_enrichment` (`citation_enrichment_job.rb:8`) never runs, so citations stay `pending`. [inference] The fix is to switch to `:polynomially_longer`.
- **Link:** activejob CHANGELOG 7.1 (deprecation) and 8.0 (removal).

**4. `TimeWithZone#to_time` now always keeps the zone (`to_time_preserves_timezone` is fixed at `:zone`, and the setting is deprecated)**
- **Before:** under 7.0 defaults, `to_time` returned a Time with a fixed UTC offset.
- **Now:** it is always `getlocal(time_zone)`. [source] `activesupport/lib/active_support/time_with_zone.rb:497-499`, `active_support.rb:124-136`
- **Where:** `app/models/note.rb:43-45`, whose comment explicitly relies on keeping the offset. The result is shown in `app/views/notes/_reminder.html.erb:19`.
- **Risk:** across a daylight-saving change, the displayed "24 hours later" wall-clock time and offset change. The stored epoch from `postpone_reminder` (`note.rb:72`) stays the same. [inference]
- **Link:** activesupport CHANGELOG 8.0.

## Medium risk

**5. `Rails.application.secrets` and `config/secrets.yml` were removed (7.2)**
- **Where:**
  - `app/models/citation/provider.rb:13`
  - `test/controllers/citation_enrichments_controller_test.rb:45,117-122`
  - `config/secrets.yml`
- **Risk:** you get a NoMethodError when a provider is built, not at boot. You need to choose a replacement: credentials, `config.x`, or ENV directly. The test file mutates secrets at runtime, so it needs reworking too. [source: `secrets` is not defined anywhere in railties 8.1]
- **Link:** railties CHANGELOG 7.2.

**6. The built-in Sidekiq adapter is deprecated and will be removed in Rails 8.2**
- **Now:** in 8.1 the adapter warns. It asks you to upgrade to sidekiq 7.3.3 or later, which ships its own adapter. [source] `activejob/lib/active_job/queue_adapters/sidekiq_adapter.rb:33-37`
- **Risk:** moving to Sidekiq 7 also changes the Redis client (redis-client instead of the `redis` gem). That affects:
  - `Sidekiq.redis { |redis| redis.sadd ... }` in `app/models/user.rb:38-43`
  - `rescue Redis::BaseError` in `app/models/notebook.rb:28`
  - `ExportJob` (`app/jobs/export_job.rb`)

  [inference]

## Low risk (mechanical; booting the app or running the tests should catch these)
- **Positional `serialize` coder:** `serialize :tags, JSON` at `app/models/note.rb:12` raises ArgumentError. Change it to `coder: JSON`. The signature only accepts `coder:` as a keyword. [source] `serialization.rb:193`
- **`serialize :preferences` with no coder:** `app/models/notebook.rb:7` keeps working under `load_defaults 7.0`, because the default is YAMLColumn. If you adopt 7.1 defaults, set `default_column_serializer = nil` or the app raises "missing keyword: :coder". [source] `serialization.rb:20,194`, `configuration.rb:287`
- **Underscore enum options:** `enum status: {...}, _prefix: true` at `app/models/note.rb:10` raises "invalid option(s): :_prefix". Use `enum :status, {...}, prefix: true`. [source] `enum.rb:378-382`
- **`alias_attribute` to a non-column:** `alias_attribute :highlight_color, :color` at `app/models/note.rb:14` points at a `store_accessor`, not a column. It raises ArgumentError when attribute methods are generated, which is most likely on first use rather than at boot. Use `alias_method` for both the reader and the writer. [source] `attribute_methods.rb:87-95`
- **Integer `wait_until`:** `NoteReminderJob.set(wait_until: reminder_epoch)` at `app/models/note.rb:61` passes an Integer. 8.1 stores it as is and then calls `scheduled_at.utc` when serializing, which raises NoMethodError inside `with_lock`. I traced this but did not run it. Pass `Time.at(epoch)` instead. [source] `core.rb:130,177`
- **`ActiveRecord::Base.connection` soft-deprecated:** `Note.connection.select_rows` at `app/models/notebook.rb:40` keeps working and only warns if configured. `with_connection` and `lease_connection` are the replacements. [source] `connection_handling.rb:276-283`

## Judged not relevant
- **Database adapters:** MySQL and SQLite changes (8.0 SQLite production work and others) do not apply, because the app uses PostgreSQL. [app]
- **Solid Queue, Solid Cache, Solid Cable, Kamal, Propshaft, the auth generator:** these are new-app defaults only. The app keeps Sprockets and Sidekiq. [app]
- **Cache store and `cache_format_version` changes:** production has no explicit cache store and the app has no `Rails.cache` usage I found. [app / inference]
- **`enqueue_after_transaction_commit`:** the default is still false in 8.1, so jobs enqueued under `with_lock` (`note.rb:57-62`) still enqueue immediately. [source] `enqueuing.rb:53`
- **Removed `to_s(:format)`, `fixture_path`, `show_exceptions` booleans:** I found no usage. [app, grep]
- **Rack 3, Puma 5, Minitest pin:** Rails 8.1 still allows Rack 2 and Puma 5. Check `bundle update` resolution once you decide to upgrade. [inference]
- **Action Text and Trix:** the importmap pins only `actiontext.js` (`config/importmap.rb:8`). How Trix is packaged changed in 8.x. I did not verify this, so check it if editor assets break. [inference]
- **Kredis, Action Cable, Active Storage variants:** these are unused or commented out in the Gemfile and config. [app]

Not covered: Action Pack and Action View changes (for example the 8.0 `params.expect` and stricter routing or rendering behaviour), Action Mailer details, and the gems that `bundle update` would move (turbo-rails, importmap-rails, jbuilder). Read their 7.1 to 8.1 CHANGELOGs next.

---

I haven't changed anything yet. The app is on Rails 7.0.8.7, so this upgrade crosses three minor versions and one major version. Three of the high-risk items change behaviour without raising any error: the digest day and its timezone, the BigDecimal payloads during a rolling deploy, and the reminder display across daylight-saving changes. You'll need to decide how each of those should behave before upgrading. Tell me how you'd like to proceed. One option is to step through 7.1 → 7.2 → 8.0 → 8.1 and fix the deprecations at each step.