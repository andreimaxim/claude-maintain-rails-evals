I found 6 high-risk changes, 6 medium and 6 low in the upgrade from Rails 7.0.8.7 to 8.1.0. The most serious ones change behaviour without raising an error, so the test suite may not show them. Several others (removal of `Rails.application.secrets`, and the old `enum`, `serialize` and `alias_attribute` forms) stop the app from booting, so they show up straight away.

I unpacked activesupport, activerecord, activejob, actiontext, actionpack, actionview, activemodel and railties at both versions under `/tmp/g/` and compared their source. I did not install anything or run the app.

Each claim is tagged: **[code]** means I read it in the gem or app source, **[changelog]** means a Rails changelog, and **[inference]** means my own reasoning.

## Facts about the app that the ratings depend on

Please correct any that are wrong.
- `config.load_defaults 7.0` is set, and none of the framework defaults from 7.1 to 8.1 have been adopted (`config/application.rb:12`).
- The database is PostgreSQL through `pg` 1.6.0.
- Assets use Sprockets with importmap, Turbo and Stimulus. Pages are rendered as HTML, and Jbuilder is also installed.
- Active Job runs on Sidekiq **6.5.12** using Rails's built-in `:sidekiq` adapter, with `redis` 4.8.1. One job, `ExportJob`, is a plain Sidekiq job.
- Action Text and Active Storage (Disk service) are in use, and Action Cable uses Redis in production.
- Settings come from `config/secrets.yml` through `Rails.application.secrets`.
- Ruby 3.3.6 meets Rails 8.1's minimum of 3.2. The pinned `concurrent-ruby` 1.3.4 meets the new minimum of 1.3.1. The pinned `minitest ~> 5.25` still satisfies Rails 8.1's requirement (minitest >= 5.1).
- **[inference]** I assumed web and Sidekiq processes are deployed together but can overlap during a rollout, and that jobs are still queued in Redis at that moment.

## High risk

**1. Job time arguments now arrive in the sender's time zone, which changes what the daily digest contains** [code]
- **Before (7.0):** a time-with-zone argument was rebuilt in the worker's time zone, `Time.iso8601(value).in_time_zone`.
- **Now (8.1):** the job stores the zone name and rebuilds the time in it (`activejob-8.1.0/lib/active_job/serializers/time_with_zone_serializer.rb`).
- **Where the app uses it:** `app/models/user.rb:38` passes `Time.current.in_time_zone(time_zone)` to `DigestJob`. `app/mailers/digest_mailer.rb:8-9` then uses `requested_at.to_date` and `requested_at.all_day` and relies on the time being in UTC, as its own comment says.
- **What goes wrong:** with no error, the digest covers the reader's local day instead of the UTC day, so a different set of notes is selected near midnight.
- **Tests to recheck:** `test/controllers/digests_controller_test.rb:10,39`.
- Introduced in Rails 7.1 ([7-1-stable activejob CHANGELOG](https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md)).

**2. BigDecimal job arguments are now wrapped in a serializer, and old workers can't read them** [code]
- **Before:** BigDecimal was passed through as a plain value (`activejob-7.0.8.7/lib/active_job/arguments.rb:50`), so Sidekiq's JSON stored it as a string.
- **Now:** it is wrapped by `BigDecimalSerializer`.
- **Where the app uses it:** `user.rb:38` passes `reading_completion`. `DigestMailer` calls `BigDecimal(params[:completion])`, which works with either form.
- **What goes wrong:** during the rollout, a 7.0 worker that picks up an 8.1-queued digest raises `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`activejob-7.0.8.7/lib/active_job/serializers.rb:43`), and that digest is lost.

**3. `wait: :exponentially_longer` was removed, and the job only fails when it retries** [code]
- **Where the app uses it:** `app/jobs/citation_enrichment_job.rb:7`.
- **Now:** the 8.1 `determine_delay` only knows `:polynomially_longer` and raises `Couldn't determine a delay` for anything else (`activejob-8.1.0/lib/active_job/exceptions.rb:175-188`).
- **What goes wrong:**
  - Booting succeeds; the error only fires on the first `Provider::Unavailable`.
  - The `fail_enrichment` block never runs, Sidekiq's own retries take over, and the citation can stay `pending`.
  - Because `request_enrichment` refuses to queue again while the citation is pending, it also stops new lookups.
- **Fix:** rename to `:polynomially_longer`, which uses the same formula. Deprecated in 7.1 and removed in 7.2.

**4. `citation[:id]` no longer returns the primary key** [code]
- **Before (7.0):** `read_attribute` mapped `"id"` to the primary key (`activerecord-7.0.8.7/.../read.rb:31`).
- **Now (8.1):** that mapping is gone.
- **Where the app uses it:** `citations` uses `doi` as its primary key and has no `id` column (`db/schema.rb:55`). `app/models/import.rb:72` writes `citation[:id]` into the import receipt CSV.
- **What goes wrong:** **[inference]** the DOI column of the receipt silently becomes empty.
- **Fix:** use `citation.doi` or `citation.id`.

**5. `TimeWithZone#to_time` now always keeps the time zone** [code]
- **Where the app uses it:** `app/models/note.rb:44` builds the next-day reminder with `reminder_at.to_time + 86_400`.
- **Before:** under the 7.0 defaults, `to_time` kept the UTC offset.
- **Now:** it calls `getlocal(time_zone)` (`time_with_zone.rb:497`).
- **Effect:**
  - **[inference]** The stored epoch (`.to_i`) is the same either way.
  - The displayed time and `iso8601` value in `app/views/notes/_reminder.html.erb:19` will now show the post-DST offset across a daylight-saving change.
  - This contradicts the model comment at `note.rb:41-43`. Severity is low, but it is a silent change in time handling.

**6. The Sidekiq adapter is deprecated, and Sidekiq 6.5 is untested with Rails 8**
- **Deprecation [code]:** 8.1's built-in adapter warns that it "will be removed in Rails 8.2" and asks for Sidekiq 7.3.3 or later (`activejob-8.1.0/.../sidekiq_adapter.rb`).
- **Compatibility [inference]:** Sidekiq 6.5.12 and Rails 8.1 are not a combination I know to be tested, and moving to Sidekiq 7 also requires redis-client and changes the Redis API.
- **App code that depends on Sidekiq/Redis directly:** `user.rb:37-44` (`Sidekiq.redis` `sadd`, which returns a boolean in redis 4.x) and `notebook.rb:25-29` (`perform_async`, `Redis::BaseError`).
- Treat this as a separate upgrade that has to be planned.

## Medium risk

**7. `Rails.application.secrets` is removed** [code]
- railties 8.1 no longer defines it; it was removed in 7.2.
- **Used in:** `app/models/citation/provider.rb:13`, and the test that changes it at `test/controllers/citation_enrichments_controller_test.rb:45,117-122`.
- **Decision needed:** move these settings to credentials, to `config_for(:citation_provider)`, or to environment variables. `config/secrets.yml` is ignored after the upgrade.

**8. `ActionText::ContentHelper.allowed_tags` now defaults to `nil`** [code]
- Before, it defaulted to an array (actiontext 7.0 `content_helper.rb:8`). Now the full list is computed in `sanitizer_allowed_tags`.
- **Used in:** `config/initializers/action_text.rb` runs `allowed_tags += %w[details summary]`, which becomes `nil + [...]` and raises `NoMethodError`.
- **What could go wrong:** **[inference]** the obvious fix, `= %w[details summary]`, would silently strip every other formatting tag. The list has to be built from `sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"] + %w[details summary]`.
- **Test to recheck:** `test/controllers/notes_controller_test.rb:137`.

**9. `serialize :preferences` with no coder** (`app/models/notebook.rb:8`) [code]
- It keeps working under `load_defaults 7.0`, which still uses YAML.
- Adopting the 7.1 defaults sets `default_column_serializer = nil`, and then this line raises "missing keyword: :coder" (`railties-8.1.0/.../configuration.rb:287`).
- **Decision needed:** keep YAML with `coder: YAML`, or migrate the data stored in the column.

**10. `attr_readonly :slug`** (`notebook.rb:9`) [code]
- The 7.1 default `raise_on_assign_to_attr_readonly = true` (`configuration.rb:284`) makes assigning to `slug` raise instead of being silently ignored.
- **Decision needed:** this only applies if you adopt that default.

**11. PostgreSQL date decoding** [code]
- Rails 8.1 adds `decode_dates`, which defaults to off but is turned on by the 7.2 framework defaults (`configuration.rb:332`).
- **Used in:** `app/models/notebook.rb:40` passes the raw `select_rows` value to `Date.iso8601`.
- **What could go wrong:** with the setting on, the value is already a `Date`, so that call raises a `TypeError`.

**12. Rails 8.2 will remove the deprecations now being warned about**
- This includes the Sidekiq adapter and the `to_time_preserves_timezone` setting.
- Production has `report_deprecations = false`, so check the deprecation warnings in development and test.

## Low risk

These fail loudly at boot or in tests.
- **`enum status: {...}, _prefix: true`** (`app/models/note.rb:10`): the keyword form is removed. Write `enum :status, {...}, prefix: true` [code].
- **`serialize :tags, JSON`** (`note.rb:12`): passing the coder as a positional argument is removed. Write `coder: JSON` [code].
- **`alias_attribute :highlight_color, :color`** (`note.rb:14`): `color` is a `store_accessor`, not a column attribute, and 8.x raises `ArgumentError` when an alias points at one (`activerecord-8.1.0/.../attribute_methods.rb:91`). Use `alias_method` for the reader and the writer [code].
- **`fragments.sum`** (`app/models/export.rb:42`): Active Support no longer lets `sum` add strings, so this raises `TypeError` in `ExportJob`. Use `fragments.join` [code].
- **`set(wait_until: reminder_epoch)` with an integer** (`note.rb:58`):
  - **Before:** 7.0 called `.to_f` on the value.
  - **Now:** 8.1 stores it as given, then calls `scheduled_at.utc` while serializing the job, which raises `NoMethodError` on an Integer (`activejob-8.1.0/lib/active_job/core.rb:130,177`).
  - **Fix:** pass `Time.at(epoch)` [code].
- **`config.cache_classes`** (`config/environments/*.rb`): it still works, but the newer name is `enable_reloading` [inference].

## Parts judged not relevant

- **MySQL, SQLite and Trilogy adapters, and Solid Queue/Cache/Cable defaults:** the app uses PostgreSQL, Sidekiq and Redis.
- **Propshaft as the new default:** existing Sprockets apps keep `sprockets-rails` [inference].
- **`enqueue_after_transaction_commit`:**
  - In 8.1 it is `false` (`activejob-8.1.0/lib/active_job/enqueuing.rb:53`), so the queue-under-row-lock design in `citation.rb:17-25` and `note.rb:54-66` is unaffected.
  - Do not turn it on, because those methods rely on a failed enqueue rolling back.
- **Native Sidekiq `ExportJob`:** it doesn't go through Active Job, so none of the changes above affect it.
- **`has_secure_password`, `form_with` and `button_to`:** I found no changes relevant to how the app uses them, but I didn't diff these exhaustively [inference].
- **Action Cable:** the app has only the default channel scaffolding.

Most of these were introduced in Rails 7.1 and 7.2, so the full entries are in those series' changelogs (the 8.1.0 gems only include the 8.x changelog): https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md, https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md and https://github.com/rails/rails/blob/7-2-stable/railties/CHANGELOG.md.

---

**My notes:** I haven't changed anything yet. The app is on Rails 7.0.8.7, so this upgrade crosses 7.1, 7.2 and 8.0. Before I start, please decide:
- **Sidekiq:** should Sidekiq 6.5 move to 7.3.3 or later as part of this upgrade, or as a separate step?
- **Secrets:** should the settings in `secrets.yml` move to credentials, `config_for` or environment variables?
- **Queued jobs during the rollout:** what should happen to them (risk #2)?

I'd also suggest stepping through the versions one at a time (7.1 → 7.2 → 8.0 → 8.1) instead of jumping straight to 8.1.0. Tell me how you'd like to go ahead.