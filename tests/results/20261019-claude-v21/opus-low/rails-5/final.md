I found eight changes between Rails 7.0.8.7 and 8.1.0 that affect Margin Notes: two high, two medium and four low. Five of them raise an error, and the boot or test suite should catch four. The fifth is a retry setting that only fails when the citation provider is down, and no test covers that path. The two high ones change behaviour without raising anything.

I worked from the released 8.1.0 source (activejob, activerecord, actiontext, railties, plus activerecord 7.0.8.7 for comparison), a test resolution in `/tmp/up`, and the app's code. I didn't fetch changelog or PR pages, so where I name the release that made a change, that is from memory and the PR links should be checked. Labels: **[code]** means I read the gem source, **[inference]** is my reasoning.

## Facts the ratings depend on (please correct any that are wrong)
- PostgreSQL only; `config.load_defaults 7.0`, which the upgrade does not change (`config/application.rb:12`).
- Active Job runs on Sidekiq 6.5.12 with redis 4.8.1. Exports bypass Active Job and call `ExportJob.perform_async` directly (`app/models/notebook.rb:25`).
- The app renders HTML (ERB, Turbo, Action Text, Active Storage on local disk). The production cache store is the default; no cache store is configured.
- I assumed web servers and Sidekiq workers will run old and new code side by side during a deploy.
- Bundler moves only the Rails components (7.0.8.7 to 8.1.0) and adds small dependencies: action_text-trix, bigdecimal, drb, json, rack-session, rackup, securerandom, uri, useragent, webrick. It drops method_source and bumps net-imap from 0.6.7 to 0.6.8. Rack stays at 2.2.24, and sidekiq, redis, pg, puma and concurrent-ruby keep their versions **[code: resolved lockfile]**.

## High risk

**1. Time arguments to jobs now keep their time zone (digest covers a different day).**
- **Before:** Rails 7.0 sent a time to a job as an ISO string and the worker read it back in its own zone (UTC). `DigestMailer` relies on this; its comment at `app/mailers/digest_mailer.rb:3-5` says so.
- **Now:** the 8.1 `TimeWithZoneSerializer` also stores `"time_zone"` and reads the time back in that zone **[code: activejob/lib/active_job/serializers/time_with_zone_serializer.rb]**. I believe this arrived in 7.1 **[inference]**.
- **Where:** `User#request_digest` passes `requested_at` already set to the reader's zone (`app/models/user.rb:35,41`). `DigestMailer#daily_digest` then uses `requested_at.to_date` and `requested_at.all_day` (`app/mailers/digest_mailer.rb:8-9`).
- **What goes wrong:** the digest silently covers the reader's local day instead of the UTC day, and its subject date changes. The Redis reservation is still keyed by UTC day (`user.rb:36`), so the two no longer agree near midnight. `test/controllers/digests_controller_test.rb:29` only checks `"value"`, so it may not catch this.
- **Fix:** decide which day the digest should cover, then either convert explicitly in the mailer or pass `.utc`.

**2. BigDecimal job arguments have a new format that old workers can't read.**
- **Before:** in 7.0, `reading_completion` (a BigDecimal) went into the queue as a plain decimal string. That's what the comment at `app/jobs/digest_job.rb:4-5` describes.
- **Now:** 8.1 always uses `BigDecimalSerializer`, which writes an `_aj_serialized` hash **[code: activejob/lib/active_job/serializers.rb:107, big_decimal_serializer.rb]**. The 7.1 changelog had this as `active_job.use_big_decimal_serializer`, and I believe it became unconditional later **[inference]**.
- **Where:** `app/models/user.rb:41`, `app/jobs/digest_job.rb`, `app/mailers/digest_mailer.rb:10`.
- **What goes wrong:** a DigestJob queued by an 8.1 web process and picked up by a 7.0 worker hits an unknown serializer. It raises a DeserializationError and the digest is lost or retried. The reservation still blocks the reader from asking again that day.
- **Fix:** upgrade the workers before the web processes, or drain the queue first. Passing `.to_s` would also remove the dependency.

## Medium risk

**3. `retry_on ... wait: :exponentially_longer` is no longer accepted, and fails only at retry time.**
- **Now:** `determine_delay` accepts only `:polynomially_longer`, a duration, an integer or a proc. Anything else raises `"Couldn't determine a delay..."` **[code: activejob/lib/active_job/exceptions.rb:171-189]**. The symbol was deprecated in 7.1 and removed in 7.2 **[inference]**.
- **Where:** `app/jobs/citation_enrichment_job.rb:7`.
- **What goes wrong:** nothing at boot. The first time `Citation::Provider::Unavailable` happens, a RuntimeError is raised instead of retrying. The `fail_enrichment` block never runs, so the citation stays `pending`. `Citation#request_enrichment` (`app/models/citation.rb:14-17`) then refuses to queue a new lookup. No test covers `Unavailable` or `fail_enrichment`.
- **Fix:** choose between `:polynomially_longer` (the same curve, renamed) and an explicit delay.

**4. `Rails.application.secrets` and `config/secrets.yml` are gone.**
- **Now:** railties 8.1 has no `secrets` method **[code: grep of railties/lib]**. It was removed in 7.2 after a 7.1 deprecation **[inference]**.
- **Where:** `app/models/citation/provider.rb:13` reads `Rails.application.secrets.citation_provider`; `config/secrets.yml` holds the values.
- **What goes wrong:** NoMethodError when the provider is built.
- **Fix:** decide where these settings live: credentials, `config_for(:citation_provider)` with a renamed YAML file, or ENV directly.

## Low risk (error at boot or in tests, mechanical fix)
- **Action Text allowed tags:** `ActionText::ContentHelper.allowed_tags` now defaults to `nil` and the list is computed lazily **[code: actiontext/app/helpers/action_text/content_helper.rb:10,69]**. So `+=` at `config/initializers/action_text.rb:3` raises NoMethodError at boot. Replace it with a full list built from the sanitizer's allowed tags plus the attachment tag, `figure`, `figcaption`, `details` and `summary`. Once the list is set explicitly it stops following future sanitizer changes **[inference]**.
- **`serialize :tags, JSON`** at `app/models/note.rb:12` raises ArgumentError, because the coder must now be passed as `coder: JSON` **[code: serialization.rb:193]**. `serialize :preferences` (`notebook.rb:7`) keeps working only because `load_defaults 7.0` sets YAML as the default coder **[code/inference]**.
- **`enum status: {...}, _prefix: true`** at `app/models/note.rb:10` raises, because the old keyword form and its underscore options were removed **[code: enum.rb:379]**. Use `enum :status, {...}, prefix: true`.
- **`alias_attribute :highlight_color, :color`** at `app/models/note.rb:14`: `color` is a `store_accessor`, not a real attribute, and 8.1 raises ArgumentError for that **[code: attribute_methods.rb:91]**. Define `highlight_color` and `highlight_color=` methods by hand.
- **`set(wait_until: reminder_epoch)`** at `app/models/note.rb:61` passes an Integer. 8.1 stores it as-is and calls `.utc` on it when serializing the job (`core.rb:130,177`), so scheduling a reminder raises NoMethodError **[code]**. Use `Time.at(reminder_epoch)`. The tests at `reminders_controller_test.rb:47,52` will then see Float `:at` values.

## Judged not relevant
- **Jobs queued after transaction commit:** 8.1 defaults to `false` (`enqueuing.rb:53`), so jobs queued under `with_lock` in `citation.rb` and `note.rb` still enqueue immediately **[code]**.
- **Date decoding in PostgreSQL raw queries:** `decode_dates` is only switched on by the 7.2 defaults. If you later raise `load_defaults`, `Date.iso8601(day)` at `app/models/notebook.rb:40` will receive a Date and raise TypeError **[code: postgresql_adapter.rb:1144]**.
- **Other new framework defaults** (the 7.1 cache format, HTML5 sanitizer, `serialize` coder default and so on) don't apply while `load_defaults` stays 7.0.
- **MySQL, SQLite and Trilogy adapter changes:** the app uses PostgreSQL only.
- **Rack 3 support:** Rack stays at 2.2.24.
- **Sidekiq adapter:** it is still bundled in 8.1 and requires `sidekiq >= 4.1.0` **[code]**. Whether Sidekiq 6.5 has been tested with Rails 8 is unverified **[inference]**.
- **`ExportJob.perform_async`:** it uses Sidekiq directly, not Active Job.
- **Active Storage variants and previews:** no image processor is installed.
- **Action Cable, Action Mailbox, Kredis:** not used beyond the generated stubs.

The upgraded lockfile is at `/tmp/up/Gemfile.lock`, and the unpacked 8.1.0 sources are under `/tmp/gems/`.

---

I haven't upgraded anything yet: the Gemfile still pins `rails` to `7.0.8.7`. This jump crosses three minor versions (7.1, 7.2, 8.0), not just one.

To start, I need your answers on:
1. **Digest day (#1):** should the digest cover the reader's local day or the UTC day?
2. **Deploy order (#2):** can you upgrade the Sidekiq workers before the web processes, or drain the queue first? If not, I'll pass `reading_completion` as a string.
3. **Citation provider settings (#4):** should they move to credentials, a `config_for` YAML file, or ENV?
4. **Retry curve (#3):** should I switch to `:polynomially_longer`?