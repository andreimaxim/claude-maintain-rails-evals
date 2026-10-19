# Rails 7.0.8.7 to 8.1.0: upgrade risk report for Margin Notes

The upgrade has four high-risk changes. Each one changes behaviour without raising an error: imports can save partially, digests cover a different day, retries break in a way that leaves citations stuck at "pending", and jobs can fail while old and new versions run side by side. There are also two medium and seven low changes. I only read the gem source, changelogs and app code; I didn't install or run anything.

I unpacked Rails 7.0.8.7 and 8.1.0 in `/tmp/gems/{7.0.8.7,8.1.0}` to compare them, and the 7.1.0, 7.2.0, 8.0.0 and 8.1.0 changelogs are in `/tmp/gems/cl/`. The re-resolved lockfile is `/tmp/lock/Gemfile.lock`. Changelog links below are of the form `https://github.com/rails/rails/blob/v<version>/<component>/CHANGELOG.md`.

## Facts about the app that the ratings depend on (please correct any that are wrong)
- **Database:** PostgreSQL only (`config/database.yml`). All MySQL and SQLite changes are ruled out.
- **Defaults:** `config.load_defaults 7.0` (`config/application.rb:10`). I assumed it stays at 7.0. Raising it adds the further risks listed at the end.
- **Background jobs:** Active Job runs on Sidekiq 6.5.12 with redis 4.8.1 (`config/application.rb:24`). Tests use the `:test` adapter. `ExportJob` is a plain Sidekiq job that doesn't go through Active Job.
- **Rendering:** the app renders HTML with Turbo, importmap, Sprockets and Action Text. It loads its own Trix 1.3.5 from `vendor/javascript/trix-1.3.5.js`. Active Storage uses the local disk.
- **Cache:** none outside development, where it's the memory store. Cache-store changes are not relevant.
- **Other gems that move (from the re-resolved lockfile):** rack stays on 2.x because Sidekiq 6.5 pins it. New or changed gems are bigdecimal 4.1.3, json 3.1.0, rack-session, rackup, webrick, useragent, action_text-trix, securerandom and uri. Ruby 3.3.6, pg 1.6.0, concurrent-ruby 1.3.4 and minitest 5.x all still resolve.

## High risk

**1. An early `return` inside `transaction` now commits instead of rolling back.**
- **Before:** in 7.0, `within_new_transaction` rolled back when the block exited early after writing (code I read).
- **Now:** 7.1 added `commit_transaction_on_non_local_return`, 7.2 removed the rollback behaviour, and 8.0 removed the setting. In 8.1 an early exit always commits (code I read).
- **Where:** `app/models/import.rb:53-56`. The block calls `save!` on the import, then does `return false unless row.note.save` for each row.
- **What could go wrong:** if a row fails validation, the import record and every row saved before it are committed. That is a partial import, and it contradicts "saves nothing".
- **Tests:** the test "invalid rows ... saves nothing" (`test/controllers/imports_controller_test.rb:48`) should catch the commit (my inference).
- **Fix:** `raise ActiveRecord::Rollback`, or validate the rows before opening the transaction.
- **Source:** activerecord CHANGELOG v7.1.0 (around line 318) and v7.2.0 ("Remove deprecated behavior that would rollback a transaction block when exited using return...").

**2. Time arguments to Active Job now keep their time zone, which changes which day a digest covers.**
- **Before:** the 7.0 `TimeWithZoneSerializer` deserialised in the worker's `Time.zone`, which is UTC (code I read).
- **Now:** 8.1 also serialises `time_zone` and deserialises in that zone (code I read; activejob CHANGELOG v7.2.0, "Preserve the serialized timezone...").
- **Where:**
  - `app/models/user.rb:41` passes `requested_at` in the reader's zone.
  - `app/mailers/digest_mailer.rb:8-9` uses `requested_at.to_date` and `requested_at.all_day`.
- **What could go wrong:** the digest now covers the reader's local day rather than the UTC day. The subject date and the list of notes change for readers who are not on UTC. It also no longer matches the reservation key built from the UTC day in `user.rb:36`.
- **Tests:** `test/controllers/digests_controller_test.rb:5-37` encodes the old behaviour and should fail (my inference).
- **Decision needed:** choose between local day and UTC day. If you keep UTC, convert explicitly in the mailer.

**3. `retry_on ... wait: :exponentially_longer` no longer works, and it fails only when a retry happens.**
- **What changed:** the option was deprecated in 7.1 and removed in 7.2 (activejob changelogs). In 8.1, `determine_delay` raises `"Couldn't determine a delay based on :exponentially_longer"` (code I read).
- **Where:** `app/jobs/citation_enrichment_job.rb:7`.
- **Why it's easy to miss:** the app boots normally and the error appears only when the provider is unavailable.
- **What could go wrong:** the RuntimeError escapes to Sidekiq's own retries, so `fail_enrichment` never runs. The citation stays `pending` forever, and `request_enrichment` then refuses every new request (my inference).
- **Tests:** `test/controllers/citation_enrichments_controller_test.rb:60` should catch it.
- **Fix:** `:polynomially_longer` gives the same timing.

**4. Big decimals in job arguments use a new format, which breaks old and new versions running side by side.**
- **What changed:** 7.1 added `BigDecimalSerializer` behind an opt-in, and 7.2 made it the only format (activejob CHANGELOG v7.1.0 "Fix BigDecimal (de)serialization", v7.2.0 "Remove deprecated primitive serializer").
- **Where:** `DigestJob.perform_later(..., reading_completion)` in `app/models/user.rb:41` passes a BigDecimal.
- **What could go wrong:** during a rolling deploy, a 7.0 Sidekiq worker can't deserialise a job queued by 8.1, so the job fails and goes into retries. The other direction is fine: `BigDecimal(params[:completion])` in `digest_mailer.rb:10` accepts both a String and a BigDecimal (my inference).
- **Mitigation:** drain the queue or deploy the workers first.
- **Also checked:** scheduled `NoteReminderJob` payloads from 7.0 deserialise fine in 8.1 (my inference).

## Medium risk

**5. `Rails.application.secrets` was removed (deprecated in 7.1, removed in 7.2).**
- **Source:** railties changelogs.
- **Where:** `app/models/citation/provider.rb:13`, which reads `config/secrets.yml`.
- **What breaks:** a NoMethodError, but only when an enrichment job runs, not at boot.
- **Decision needed:** there is no direct replacement. Move the settings to credentials, `config_for(:citation_provider)`, or plain ENV.
- **Tests:** `citation_enrichments_controller_test.rb:40` covers it.

**6. The built-in Sidekiq adapter is deprecated in 8.1 and will be removed in 8.2.**
- **Source:** activejob CHANGELOG v8.1.0. `check_adapter` emits the warning (code I read).
- **Where:** `config/application.rb:24`, with sidekiq pinned at 6.5.12.
- **Decision needed before 8.2:** Sidekiq 7.3.3 or later moves to redis-client.
- **Code that will need review then** (my inference):
  - `Sidekiq.redis { redis.sadd(...) }` in `app/models/user.rb`, whose boolean return value would change.
  - `rescue Redis::BaseError` in `app/models/notebook.rb`.

## Low risk

These all raise errors that booting the app or running the tests would catch.
- **`serialize :tags, JSON`** (`app/models/note.rb:12`): a positional coder raises ArgumentError since 7.2. Use `coder: JSON`.
- **`enum status: {...}, _prefix: true`** (`note.rb:10`): keyword syntax was removed in 8.0. Use `enum :status, {...}, prefix: true`.
- **`alias_attribute :highlight_color, :color`** (`note.rb:14`): `color` comes from a `store_accessor` and is not a real attribute, so 8.1 raises ArgumentError (code I read). Use `alias_method` for both the reader and the writer.
- **`citation[:id]`** (`app/models/import.rb:68`): Citation's primary key is `doi`. In 8.1, `[:id]` no longer maps to it and raises MissingAttributeError (code I read; activerecord v7.1.0 deprecation, v7.2.0 removal). The receipt CSV would return a 500 error. Use `citation.doi`. The receipt test at line 6 should catch it.
- **`NoteReminderJob.set(wait_until: reminder_epoch)`** (`note.rb:61`) passes an Integer. 8.1 stores it as-is and then calls `scheduled_at.utc.iso8601` while serialising the job, which raises NoMethodError (code I read). Use `Time.at(reminder_epoch)`. `reminders_controller_test.rb` covers it.
- **`fragments.sum`** (`app/models/export.rb:42`): Active Support's string-friendly `sum` override was removed in 7.1, so Ruby raises TypeError. It has been deprecated since 7.0. Use `join`. `test/models/export_test.rb` should catch it.
- **`ActionText::ContentHelper.allowed_tags += ...`** (`config/initializers/action_text.rb`): since 7.1 the default is nil, so this raises NoMethodError at boot (actiontext CHANGELOG v7.1.0). Base the list on `sanitizer_allowed_tags`.
- **`show_exceptions = false`** (`config/environments/test.rb:31`): boolean values were removed in 7.2. 8.1 treats `false` like `:all`, so exceptions are rendered as error pages instead of raised (code I read). The `assert_raises(ActiveRecord::RecordNotFound)` tests in exports and notes would fail. Use `:none`.
- **`has_secure_password` (since 7.1):** passwords longer than 72 bytes now fail validation instead of being silently truncated (my inference from Active Model 7.1).

## Not relevant, or only if `load_defaults` is raised
- **Database adapters other than PostgreSQL, multi-database, and encryption:** not used.
- **Cache-store changes:** the app uses no cache store outside development.
- **Action Cable and Action Mailbox:** stubs only.
- **`config.active_record.postgresql_adapter_decode_dates`:** enabled only by `load_defaults 7.2`. If you adopt it, `Date.iso8601(day)` in `app/models/notebook.rb:40` will raise, because `select_rows` will return Date objects.
- **`default_column_serializer = nil`:** enabled by `load_defaults 7.1`. If you adopt it, `serialize :preferences` in `notebook.rb:7` will raise.
- **HTML5 sanitizer:** also enabled by `load_defaults 7.1`. It changes how Action Text output is sanitised.
- **`to_time` keeping the zone (8.0 and 8.1):** `note.rb:44` only uses the epoch through `.to_i`, so results don't change. The comment there becomes inaccurate (my inference).
- **`ActiveRecord::Base.connection` soft deprecation** (`notebook.rb:40`): no warning by default.
- **Trix moved into the `action_text-trix` gem (8.1):** the app loads its own Trix 1.3.5 alongside the 8.1 `actiontext.js`. I didn't check whether they are compatible; check the editor in a browser.
- **json 3.1.0 and bigdecimal 4.1.3 arrive as new transitive dependencies:** I didn't review their changes. The relevant code is `JSON.parse` in `app/models/citation/provider.rb` and the BigDecimal division in `User#reading_completion`.

---

I haven't changed anything yet; the Gemfile still pins `rails "7.0.8.7"`. This is a jump of four minor versions. Before I start, two things need your decision:
- **Digests (#2):** should a digest cover the reader's local day or the UTC day?
- **Provider settings (#5):** should they move to credentials, `config_for`, or plain environment variables?

Tell me how you'd like to proceed. I can do the whole upgrade at once or go in steps (7.1, then 7.2, 8.0 and 8.1).