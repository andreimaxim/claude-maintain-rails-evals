# Rails 7.0.8.7 → 8.1.0: upgrade risk for Margin Notes

The upgrade carries five high-risk changes, three of them in Active Job. Most are quiet changes in how jobs, times and cached pages behave, and several only show up in a Sidekiq worker or in production. Eight more changes raise errors with simple fixes, most of them at boot.

## Facts the ratings depend on (please correct any that are wrong)
- **PostgreSQL** only (`config/database.yml`). MySQL and SQLite changes are not relevant.
- **`config.load_defaults 7.0` stays as it is** (`config/application.rb:12`). I rated against the 7.0 defaults, so 7.1–8.1 defaults like `enqueue_after_transaction_commit`, `postgresql_adapter_decode_dates`, the HTML5 sanitizer and `raise_on_invalid_cache_expiration_time` stay off. Adopting any of them later is a separate decision.
- **Active Job runs on Sidekiq 6.5.12 with redis 4.8.1** (`config/application.rb:21`), and Sidekiq jobs are also used directly (`ExportJob`). Tests use the Active Job test adapter.
- **Full-stack HTML app**: Sprockets, importmap, Turbo, Action Text and Active Storage on the Disk service. `ExportJob` writes Markdown files.
- **No cache store is set**, so production uses Rails' default file store. Fragment caching is used in `app/views/exports/_export.html.erb:26`.
- **What else moves**: I resolved the dependencies in `/tmp/res` with only the Rails pin changed. Only the Rails gems move, plus some small new ones (action_text-trix, rackup, rack-session, useragent, securerandom, bigdecimal 4.1.3, json, uri). Rack stays 2.2, and Sidekiq, Redis, Puma, Pagy and Faraday don't change (from the resolution I ran).
- Ruby 3.3.6 meets Rails 8's requirement of 3.2 or newer.

## High risk

**1. `retry_on wait: :exponentially_longer` no longer works, and failed lookups stay "pending" forever**
- **Before:** deprecated in 7.1, it worked as the polynomial backoff.
- **Now:** 8.1 `determine_delay` only knows `:polynomially_longer` and raises `"Couldn't determine a delay..."` for anything else (code read: `activejob-8.1.0/lib/active_job/exceptions.rb:175-187`).
- **Where:** `app/jobs/citation_enrichment_job.rb:7`.
- **What goes wrong:** it boots fine. The error only appears in the worker, the first time the provider is unavailable. The `retry_on` block never runs, so `fail_enrichment` is never called and the citation stays `pending`. `Citation#request_enrichment` (`app/models/citation.rb:16`) then refuses every new request for that DOI. Sidekiq's own retries just hit the same error again (inference).
- **Fix:** change it to `:polynomially_longer`.
- **Source:** activejob CHANGELOG for 7.1 (deprecation) and 7.2 (removal): https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md and https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md

**2. `DigestJob` now gets the time in the reader's time zone, which changes which day the digest covers**
- **Before:** 7.0's `TimeWithZoneSerializer#deserialize` did `Time.iso8601(value).in_time_zone`, which gave the worker's zone (UTC).
- **Now:** 8.1 stores the zone along with the time and restores it: `.in_time_zone(hash["time_zone"] || Time.zone)` (code read, `activejob-8.1.0/lib/active_job/serializers/time_with_zone_serializer.rb:16`).
- **Where:** `app/models/user.rb:34` builds `requested_at` in the reader's zone, and line 41 queues it. `app/mailers/digest_mailer.rb:3-9` relies on getting UTC: its comment says so, and it uses `requested_at.to_date` and `requested_at.all_day`.
- **What goes wrong:** the digest silently switches to the reader's local day. It picks different notes and shows a different date in the subject. Meanwhile the Redis reservation key is still based on the UTC day (inference).
- **Jobs queued before the upgrade** have no zone stored, so they keep the old UTC behaviour.

**3. `DigestJob`'s completion number is stored in a new format, which breaks jobs while old and new versions run side by side**
- **Before:** in 7.0, `BigDecimal` went to Sidekiq as-is and came back as a string.
- **Now:** 8.1 runs it through `BigDecimalSerializer`, which writes `{"_aj_serialized" => ...}` (code read, `activejob-8.1.0/lib/active_job/serializers.rb:107`, `arguments.rb:40`).
- **Where:** the call site is `app/models/user.rb:41`.
- **What goes wrong:** the new code itself is fine, because `BigDecimal(BigDecimal)` works in `digest_mailer.rb:9`. But during a rolling deploy, a 7.0 worker that picks up a job queued by 8.1 raises `DeserializationError`, and that digest is lost (inference).

**4. Export Markdown output changes for some rich text**
- **What changed:** `to_plain_text` was rewritten (code diff of `action_text/plain_text_conversion.rb`).
  - Ordered-list numbers are now counted over elements only. Before, whitespace text nodes were counted too, which can shift the numbers.
  - The contents of `<script>` and `<style>` are now dropped.
- **Where:** `app/models/export.rb:78`, `app/views/notes/index.html.erb:53` and `app/views/imports/preview.html.erb:58`.
- **Impact:** it is a correction, so the practical risk is small, but generated files will differ from earlier exports (inference).

**5. Expired exports are now cached with no expiry**
- **Before:** 7.0 wrote the entry with an expiry already in the past, so it was never served.
- **Now:** when the expiry is negative, 8.1 logs an error and drops `expires_in` (code read, `activesupport-8.1.0/lib/active_support/cache.rb:922-944`; it only raises if the 7.1+ default is turned on).
- **Where:** `app/views/exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export has expired.
- **What goes wrong:** the "Expired" fragment is stored with no expiry. The page still shows the right thing, because the export stays expired. But the file store keeps those entries forever and the logs fill with errors (inference).
- **Fix:** skip caching or clamp the value when it is 0 or less.

## Medium risk

- **The Rails-provided Sidekiq adapter is deprecated and will be removed in 8.2.** 8.1 warns: "upgrade `sidekiq` gem to version 7.3.3 or later" (code read, `activejob-8.1.0/lib/active_job/queue_adapters/sidekiq_adapter.rb:33-37`). Moving to Sidekiq 7 is a decision in itself:
  - It drops the `redis` gem in favour of `redis-client`.
  - `redis.sadd(key, id)` then returns an Integer (always truthy) instead of true/false. That would break the one-digest-per-day check in `app/models/user.rb:38` without any error (inference).
  - `rescue Redis::BaseError` in `app/models/notebook.rb:28` would stop catching Redis errors (inference).
- **`to_time_preserves_timezone` is deprecated and will be removed in 8.2.** `load_defaults 7.0` sets it, so expect deprecation warnings (code read, `activesupport-8.1.0/lib/active_support.rb:124-136`). `TimeWithZone#to_time` now always keeps the zone. `Note#next_day_reminder_at` (`app/models/note.rb:46`) gives the same `.to_i`, so reminders don't move, but the comment at line 44 becomes inaccurate (inference).

## Low risk (each one raises an error with a simple fix)

These were confirmed by reading the 8.1 source. Most fail at boot, under eager load, or in the tests. The two that only fail when that code runs are marked.

- **`enum status: {...}, _prefix: true`** (`app/models/note.rb:10`): keyword-style `enum` was removed in 8.0. Use `enum :status, {...}, prefix: true`.
- **`serialize :tags, JSON`** (`app/models/note.rb:12`): passing the coder by position was removed in 7.2. Use `coder: JSON`. `serialize :preferences` (`notebook.rb:7`) keeps YAML under the 7.0 defaults.
- **`alias_attribute :highlight_color, :color`** (`app/models/note.rb:14`): `color` is a `store_accessor`, not a column, and 8.1 raises `ArgumentError` (`attribute_methods.rb:90`). Use `alias_method` for the reader and the writer. This is used by the form, the controller params and the views.
- **`set(wait_until: <Integer>)`** (`app/models/note.rb:61`): 7.0 called `.to_f`, but 8.1 stores the value as-is and then calls `scheduled_at.utc` while serializing, which raises `NoMethodError`. Use `Time.at(reminder_epoch)`. This only fails when someone schedules a reminder.
- **`citation[:id]`** (`app/models/import.rb:68`): 7.0 mapped `"id"` to the primary key (`doi`), but 7.1+ no longer does, so the call raises `MissingAttributeError`. Use `citation.id` or `citation.doi`. This only fails on the receipt CSV download (covered by `test/controllers/imports_controller_test.rb`).
- **`get "/notes", "/journal", to:`** (`config/routes.rb:18`): more than one path in a single route now raises `ArgumentError` (`mapper.rb:1854`). Split it into two `get` lines.
- **`ActionText::ContentHelper.allowed_tags += ...`** (`config/initializers/action_text.rb:1`): `allowed_tags` now starts as `nil`, so `+=` raises at boot. Build the list from `sanitizer.class.allowed_tags` and the Action Text tags yourself.
- **`Note.connection`** (`app/models/notebook.rb:40`): this is a quiet deprecation in 7.2+. `with_connection`/`lease_connection` are preferred.

## Judged not relevant

- **MySQL, SQLite and Trilogy adapters**: the app uses PostgreSQL.
- **PostgreSQL date decoding** (`decode_dates`): it is only turned on by the 7.1+ defaults, so `Date.iso8601(day)` in `notebook.rb:40` still gets strings.
- **`enqueue_after_transaction_commit`**: it defaults to false under the 7.0 defaults, so enqueuing inside `with_lock` still rolls back on failure as the code expects (code read, `enqueuing.rb:53`).
- **Rack 3, `:unprocessable_entity` and Puma**: Rack stays 2.2.
- **Solid Queue, Cache and Cable, Propshaft, Kamal and the auth generator**: these are new-app defaults and are not adopted.
- **Action Cable, Action Mailbox and Active Storage variants**: they are unused (no channels with code, no mailbox, no image_processing).
- **Cache format version**: 7.0 is still supported in 8.1.
- **Composite primary keys and other new 7.1–8.1 features**: they are opt-in.

Most claims above come from reading the 7.0.8.7 and 8.1.0 gem source, unpacked in `/tmp/gems`. The "what goes wrong" parts are my inference. I did not open the individual pull requests, so the changelog links point to the per-version CHANGELOG files rather than specific PRs.

---

I haven't changed anything yet. Rails is pinned to exactly `7.0.8.7` in the `Gemfile`, so this jumps three minor versions plus a major one. Most of the low-risk fixes would fail at boot or in the tests, so they'd show up quickly. The ones to decide on first are the `DigestJob` time zone change (#2) and how to deploy with Sidekiq (#3): neither raises an error, and the tests won't catch them. Let me know if you want me to go ahead with the upgrade and which of these fixes to include.