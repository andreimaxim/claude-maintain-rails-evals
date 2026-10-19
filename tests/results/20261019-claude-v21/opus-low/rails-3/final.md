I haven't changed anything yet. You asked me to upgrade, but this is a big jump (7.0.8.7 → 8.1.0), so I asked a subagent to check what it would affect in this app first. Here is its report:

---

I checked the 7.0.8.7 and 8.1.0 gem sources side by side (Active Record, Active Job, Active Support, Action Pack, Action Text, Railties) and found three changes that silently alter behavior, plus several that will stop the app or a job with an error. I didn't install anything, change the app, or run it. The dependency check was done on a copy of the Gemfile in `/tmp/lock`.

## Facts the ratings depend on (please correct any that are wrong)

- **Framework defaults:** `config.load_defaults 7.0` stays as it is (`config/application.rb:12`). Several 7.1–8.1 changes only apply when you raise this, so they don't affect you now.
- **Setup:** PostgreSQL. Active Job runs on Sidekiq 6.5.12 with Redis 4.8.1. The app renders HTML (ERB, Turbo, importmap, Sprockets). It uses Action Text, Active Storage (local disk) and `has_secure_password`.
- **Cache:** no cache store is set in production, so it is the default file store. One fragment cache is used. Time zone is unset (UTC).
- **Other gems that move:** none of importance. Resolving with `rails 8.1.0` leaves Rack 2.2.24, Puma 5.6.9, Sidekiq, Redis, Faraday, pg and Pagy unchanged. It only adds small gems (rackup, rack-session, action_text-trix, bigdecimal, json, uri and others).
- **Tests:** they use the `:test` job adapter and `show_exceptions = false`.
- **Rolling deploys:** I assumed Sidekiq workers may briefly run 7.0 code while web servers run 8.1 code, or the reverse.

## High risk

**1. An early `return` inside a transaction now commits instead of rolling back**
- **Before:** in 7.0, leaving the block early after a write rolled the transaction back (`activerecord-7.0.8.7 .../abstract/transaction.rb:336`). From code.
- **Now:** 8.1 commits unless the thread is aborting (`activerecord-8.1.0 .../transaction.rb:654-660`). From code. This went in 7.1 behind `commit_transaction_on_non_local_return`; later releases removed the setting.
- **Where:** `app/models/import.rb:55-63`. `Import#apply` saves the import, then runs `return false unless row.note.save` inside `transaction do`.
- **What could go wrong:** if a row fails to save, the import and the notes saved before it are committed, and the user still sees "nothing saved". This breaks the "saves the import with every row's note, or saves nothing" rule in the class comment (inference). Fix by raising `ActiveRecord::Rollback`.
- [7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md)

**2. `record[:id]` no longer reads a custom primary key**
- **Before:** in 7.0, `read_attribute("id")` was redirected to the primary key (`attribute_methods/read.rb:31`). From code.
- **Now:** 8.1 reads a literal `id` attribute (`read.rb:29-34`). From code. This changed in 7.1 with composite primary keys.
- **Where:** `app/models/import.rb:66`, `citation && citation[:id]`. `citations` uses `primary_key: "doi"` (`db/schema.rb:55`).
- **What could go wrong:** the DOI column of the import receipt CSV becomes empty for every row, with no error (inference). Use `citation.doi` or `note.citation_doi`.
- [7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md)

**3. Active Job now keeps the time zone of time arguments and serializes BigDecimal differently**
- **Before:** in 7.0, `TimeWithZone` arguments came back in `Time.zone` (UTC here), and a BigDecimal went into the queue as a plain string. From code.
- **Now:** 8.1 stores the `time_zone` and restores it (`time_with_zone_serializer.rb`). BigDecimal arguments use a new `BigDecimalSerializer`. From code.
- **Where:** `app/models/user.rb:38-44` passes `requested_at` in the reader's zone and the BigDecimal `reading_completion` to `DigestJob`. `app/mailers/digest_mailer.rb:3-8` (and the comment in `app/jobs/digest_job.rb:4-5`) depend on the worker seeing UTC.
- **What could go wrong:**
  - The digest now covers the reader's local day (`requested_at.to_date` / `all_day`), while the Redis reservation key is still the UTC day (`user.rb:37`). Near midnight, digest contents and the subject date change (inference).
  - During a rolling deploy, a 7.0 worker receiving a job from 8.1 raises "Serializer ActiveJob::Serializers::BigDecimalSerializer is not known" (`activejob-7.0.8.7 serializers.rb:43`), and the digest fails (inference).

## Medium risk

**4. `Rails.application.secrets` and `config/secrets.yml` are removed (deprecated in 7.1, gone in 7.2)**
- `railties-8.1.0` has no `def secrets`. From code.
- **Where:** `app/models/citation/provider.rb:13` and `config/secrets.yml`.
- **What could go wrong:** this isn't caught at boot. It fails with `NoMethodError` the first time `CitationEnrichmentJob` runs, so citations stay `pending` while Sidekiq retries (inference).
- **Decision needed:** move these settings to `config_for(:citation_provider)`, credentials, or reading ENV directly.

**5. The built-in Sidekiq Active Job adapter is deprecated and will be removed in Rails 8.2**
- **Source:** `activejob-8.1.0 .../sidekiq_adapter.rb:34-37`. From code.
- **Where:** `config/application.rb:20`.
- **Decision needed:** Sidekiq 6.5.12 is pinned, and the replacement adapter ships with Sidekiq 7.3.3 or later. Sidekiq 7 also brings the Redis 5 client and strict JSON arguments. `ExportJob.perform_async(export.id, { format: "markdown" })` at `app/models/notebook.rb:25` passes symbol keys, which strict arguments would reject (inference).

**6. `ActionText::ContentHelper.allowed_tags` now defaults to `nil`**
- **Before:** in 7.0 it held the sanitizer's tag list (`content_helper.rb:8`).
- **Now:** in 8.1 it is a bare `mattr_accessor` and the default list is built in `sanitizer_allowed_tags` (`content_helper.rb:10,68-69`). From code.
- **Where:** `config/initializers/action_text.rb:3` does `+=` on it, which raises `NoMethodError` on `nil` at boot (inference).
- **Why medium, not low:** the fix needs care so the safe defaults and the attachment and `figure` tags are kept. Build the list from `sanitizer_allowed_tags` or the sanitizer class's defaults, not from an empty list. This is security-sensitive.

## Low risk (booting or the test suite should catch these)

- **`serialize` with a positional coder:** `serialize :tags, JSON` (`app/models/note.rb:10`) becomes an ArgumentError. Change it to `coder: JSON`. From code.
- **Keyword-style `enum`:** `enum status: {...}, _prefix: true` (`note.rb:8`) raises. Use `enum :status, {...}, prefix: true`. From code.
- **`alias_attribute` to a store accessor:** `alias_attribute :highlight_color, :color` (`note.rb:12`) raises "not an attribute" (`attribute_methods.rb:85-87`). Use `alias_method` or explicit methods. From code.
- **`wait_until` with an Integer:** `NoteReminderJob.set(wait_until: reminder_epoch)` (`note.rb:56`) now hits `scheduled_at.utc` during serialization (`core.rb:130`) and raises NoMethodError, so no reminder can be scheduled. Pass `Time.at(epoch)`. From code; the failure is my inference. The tests should catch it because the test adapter serializes jobs.
- **`retry_on ... wait: :exponentially_longer`:** in `app/jobs/citation_enrichment_job.rb:7` this raises "Couldn't determine a delay", but only when a retry actually happens (`exceptions.rb:188`). Rename it to `:polynomially_longer`. This is a mechanical rename, but tests that don't exercise a retry won't catch it.
- **One route with two paths:** `get "/notes", "/journal", to:` (`config/routes.rb:18`) raises "Wrong number of arguments" (`mapper.rb:1854`). Split it into two routes and keep the `notes` route name. From code.
- **`show_exceptions = false` in `config/environments/test.rb`:** it is now treated as `:all` (`exception_wrapper.rb:188-197`), so the `assert_raises(ActiveRecord::RecordNotFound)` tests will fail. Use `:rescuable` or `:none`. From code.
- **Negative cache `expires_in`:** `app/views/exports/_export.html.erb:26` passes a negative value for expired exports. It now logs an ArgumentError and stores the entry with no expiry (`cache.rb:922-944`). It raises only with 7.1+ defaults. The cached "Expired" text stays correct (inference).

## Judged not relevant

- **PostgreSQL raw date decoding:** `daily_note_counts` (`notebook.rb:35-36`) calls `Date.iso8601` on a raw value, which would break if dates came back decoded. That only happens with `postgresql_adapter_decode_dates`, which is off under 7.0 defaults. Re-check it if you raise `load_defaults`.
- **Jobs enqueued after commit:** `enqueue_after_transaction_commit` defaults to false (`enqueuing.rb:53`), so the "enqueue under lock" logic in `Citation`, `Note` and `Notebook` is unchanged.
- **Column serializer default:** under 7.0 defaults it stays YAML, so `serialize :preferences` (`notebook.rb:7`) is unaffected.
- **`to_time_preserves_timezone`:** `next_day_reminder_at` only uses `.to_i`, so the result is the same.
- **Adapters, Rack and Puma:** MySQL/SQLite, Solid Queue/Cache/Cable, Propshaft and the other job adapters aren't used. Rack 3 and Puma 6 aren't pulled in.
- **Faraday, Pagy, pg, concurrent-ruby, minitest 5:** their locked versions don't change.

Gem sources are unpacked in `/tmp/gems/<gem>-<version>/`. The resolved lockfile is `/tmp/lock/Gemfile.lock`. The changelog links are to each component's 7-1-stable, 7-2-stable and 8-0-stable branches on GitHub. I didn't trace each change to its pull request, so look there for the PR numbers.

---

The three high-risk items won't raise errors, so the test suite may not catch them unless tests cover those paths. Items 1 and 2 have simple fixes in the code. Item 3 needs a decision: should the digest use UTC or the reader's time zone? And how will you handle jobs queued while 7.0 and 8.1 servers are both running during the deploy?

Two other questions before I start: what should replace `secrets.yml` (item 4), and should Sidekiq stay at 6.5 for now (item 5)? Once you've decided, I can bump the Gemfile and make the fixes.