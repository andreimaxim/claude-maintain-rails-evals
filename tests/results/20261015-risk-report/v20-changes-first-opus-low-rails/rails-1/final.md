# Rails 7.0.8.7 → 8.1.0 upgrade risk report for Margin Notes

I compared the released gem sources for both versions (activerecord, activejob, activesupport, actiontext, actionpack, actionview, railties) and the CHANGELOGs on the `7-1-stable`, `7-2-stable`, `8-0-stable` and `8-1-stable` branches. Nothing in the repository was installed, changed or run. I did not run the test suite, so when I say a test "probably" catches something, I'm inferring that from the test names.

Each claim is tagged: **[CL]** comes from a changelog, **[src]** from gem source I read, **[app]** from application code I read, **[inf]** is my own inference.

## Facts about the app that the ratings depend on (please correct any that are wrong)

- **Framework defaults stay on 7.0:** `config.load_defaults 7.0` (`config/application.rb:10`). Several of the riskiest 7.1–8.0 defaults only apply if you raise this, so I list those separately at the end.
- **Database:** PostgreSQL only (`config/database.yml`). The MySQL and SQLite changes don't apply.
- **Jobs:** Active Job runs on Sidekiq 6.5.12 with the redis 4.8.1 gem (`application.rb:18`, Gemfile). `ExportJob` is a native `Sidekiq::Job` and doesn't go through Active Job. Jobs are queued in Redis, so old and new code will process each other's queued payloads during a deploy.
- **Rendering:** server-rendered HTML with importmap, Sprockets, Turbo, Action Text, and Trix 1.3.5 loaded from `app/views/layouts/application.html.erb:13`. Active Storage uses the local service.
- **Cache:** no `cache_store` is configured, so production uses the default file store. Fragment caching is used in `app/views/exports/_export.html.erb:26`.
- **Config:** `config/secrets.yml` exists and is read by `Rails.application.secrets`. Ruby is 3.3.6, which 8.1 supports.

## High risk

### 1. `return` inside a `transaction` block now commits instead of rolling back
- **Before:** In 7.0, leaving a transaction block with `return` rolled it back.
- **Now:** 7.1 added `commit_transaction_on_non_local_return`, 7.2 deprecated it, and 8.0 removed it. Such a `return` now always commits. [CL 7-1 / 8-0 activerecord] ([8.0 changelog](https://github.com/rails/rails/blob/8-0-stable/activerecord/CHANGELOG.md))
- **Where the app uses it:** `app/models/import.rb:53-58`, where `Import#apply` does `transaction do save!; rows.each { |row| return false unless row.note.save } end`. [app]
- **What could go wrong:** If a row fails to save, the import and every note saved before it are now committed, but the method still returns `false`. That breaks the "saves nothing" rule in the file's own comment. [inf] `test/controllers/imports_controller_test.rb:48` ("applying them saves nothing") may catch this, but only if that path reaches `apply`.
- **Fix:** raise `ActiveRecord::Rollback`, or validate the rows before opening the transaction.

### 2. Active Job keeps the original time zone for `TimeWithZone` arguments
- **Before:** In 7.0, a `TimeWithZone` argument was deserialized in the worker's `Time.zone` (UTC) [src 7.0 `time_with_zone_serializer.rb`].
- **Now:** In 7.1+ the serializer stores `time_zone` and deserializes into that zone [CL 7-1 activejob; src 8.1].
- **Where the app uses it:** `User#request_digest` passes `Time.current.in_time_zone(time_zone)` to `DigestJob` (`app/models/user.rb:35,41`). `DigestMailer#daily_digest` uses `requested_at.to_date` and `requested_at.all_day` (`app/mailers/digest_mailer.rb:7-9`), and its comment explicitly relies on the UTC behavior. [app]
- **What could go wrong:** The digest's date, subject line and note window will follow the reader's local day instead of the UTC day. That also stops matching the UTC-day Redis reservation key (`user.rb:36`). No error is raised. [inf]

### 3. BigDecimal job arguments use a new format, which matters while old and new code run side by side
- **Before:** In 7.0, a BigDecimal argument was queued as a plain string.
- **Now:** 7.1 added `BigDecimalSerializer` behind a flag. 8.0 removed the flag, so the serializer is always used. [CL 7-1 / 8-0 activejob]
- **Where the app uses it:** `DigestJob.perform_later(self, requested_at, reading_completion)`, where `reading_completion` is a BigDecimal (`user.rb:41,56`). [app]
- **What could go wrong:** Jobs queued by 8.1 contain `_aj_serialized: "ActiveJob::Serializers::BigDecimalSerializer"`. A 7.0 Sidekiq worker can't deserialize that class, so the job fails. [inf] The other direction is fine, because the mailer calls `BigDecimal(params[:completion])` (`digest_mailer.rb:10`), which accepts strings.
- **Fix:** drain the queues, or deploy the workers first.

### 4. `retry_on ... wait: :exponentially_longer` was removed, and it only fails when a retry happens
- **Before:** 7.1 deprecated `:exponentially_longer`.
- **Now:** 7.2 removed it [CL 7-2 activejob]. 8.1's `determine_delay` raises `"Couldn't determine a delay based on :exponentially_longer"` [src `exceptions.rb:171-189`].
- **Where the app uses it:** `app/jobs/citation_enrichment_job.rb:7`. [app]
- **What could go wrong:** Booting won't catch this. The first time the provider is unavailable, the retry path raises a RuntimeError. Active Job never re-enqueues, the `fail_enrichment` block never runs, and Sidekiq's own retries take over. The citation stays `pending`, and `Citation#request_enrichment` then refuses new requests. [inf] The 503 test (`citation_enrichments_controller_test.rb:65-68`) will probably fail and reveal it.
- **Fix:** switch to `:polynomially_longer`. It uses the same formula with jitter added.

### 5. Negative `expires_in` on a cache write is now dropped instead of expiring the entry
- **Before:** In 7.0, an entry written with a negative `expires_in` was already expired, so it was never served.
- **Now:** In 7.1+ a negative `expires_in` is removed from the options and an `ArgumentError` is logged and reported, so the entry is written with no expiry. If `raise_on_invalid_cache_expiration_time` is on, the write raises instead. That setting is a 7.1 default, but it stays off under 7.0 defaults. [src `activesupport-8.1.0/lib/active_support/cache.rb:922-944`; CL 7-1 activesupport]
- **Where the app uses it:** `cache [export, "availability"], expires_in: export.expires_at - Time.current` (`app/views/exports/_export.html.erb:26`). This value is negative for expired exports. [app]
- **What could go wrong:** Under 7.0 defaults, the "Expired" fragment is now cached forever, which still shows the right content, and every render logs an error. If you adopt the 7.1 defaults, the exports page returns a 500 for any expired export. `test/controllers/exports_controller_test.rb:88` covers this case. Rated high because it changes caching behavior silently. [inf]

## Medium risk

### 6. `Rails.application.secrets` was removed in 7.2
- **Change:** `Rails.application.secrets` was removed in 7.2 [CL 7-2 railties].
- **Where the app uses it:**
  - `app/models/citation/provider.rb:13`
  - `config/secrets.yml`
  - `test/controllers/citation_enrichments_controller_test.rb:45,117-122`, which also assigns to it. [app]
- **What could go wrong:** You get a NoMethodError the first time a citation lookup runs, not at boot.
- **Decision needed:** choose between credentials, `config_for(:citation_provider)` or ENV, and decide how the test should override the URL.

### 7. `ActionText::ContentHelper.allowed_tags` is now `nil` by default
- **Before:** In 7.0 the attribute was pre-filled with the sanitizer's tags plus `action-text-attachment`, `figure` and `figcaption` [src 7.0].
- **Now:** It is `nil` unless the app sets it, and the defaults are computed lazily in `sanitizer_allowed_tags` [src 8.1 `content_helper.rb:10,68`; CL 7-1 actiontext].
- **Where the app uses it:** `config/initializers/action_text.rb` does `allowed_tags += %w[details summary]`. [app]
- **What could go wrong:** Boot fails with `nil + Array`. The obvious fix (`= %w[details summary]`) would silently strip every other tag, including attachments. You need to build the list from the sanitizer's defaults explicitly. [inf]

### 8. The built-in Sidekiq adapter is deprecated in 8.1 and will be removed in 8.2
- **Change:** The adapter still works in 8.1 but prints a deprecation warning. 8.2 will require Sidekiq 7.3.3+, which ships its own adapter. [CL 8-1 activejob; src `sidekiq_adapter.rb:33-37`]
- **Where the app uses it:** `config.active_job.queue_adapter = :sidekiq` (`config/application.rb:18`). [app]
- **What could go wrong when you upgrade Sidekiq later:** Sidekiq 7 drops the `redis` gem in favor of `redis-client`. [inf]
  - `redis.sadd(key, id)` returns 0 or 1 instead of true or false. Since 0 is truthy in Ruby, digest de-duplication in `user.rb:38` would silently stop working.
  - `rescue Redis::BaseError` in `app/models/notebook.rb:28` would stop catching enqueue failures.

  Plan this before 8.2.

## Low risk (mechanical; tests or boot should catch these)

- **`serialize :tags, JSON`:** the positional coder argument was removed in 7.2. Use `serialize :tags, coder: JSON` (`app/models/note.rb:12`). [CL 7-1 / 7-2]
- **Keyword-argument `enum`:** `enum status: {...}, _prefix: true` was removed in 8.0. Use `enum :status, {...}, prefix: true` (`note.rb:10`). [CL 8-0]
- **`alias_attribute` on a non-attribute:** `alias_attribute :highlight_color, :color` points at a `store_accessor`, not a column. Since 7.2 this raises ArgumentError when Note's attribute methods are generated. Define the methods by hand (`note.rb:13-14`). [CL 7-2; src `attribute_methods.rb:90`]
- **`read_attribute(:id)` with a custom primary key:** `citation[:id]` no longer maps to the `doi` primary key and raises `MissingAttributeError`. Use `citation.id` (`app/models/import.rb:68`, the CSV receipt). This is covered by `imports_controller_test.rb:43`. [CL 7-2; src `read.rb`]
- **Numeric `wait_until`:** `set(wait_until: reminder_epoch)` with an Integer now fails in `serialize` with `Integer#utc`. Pass `Time.at(epoch)` (`note.rb:61`). [CL 7-2; src `core.rb:130,177`]
- **`to_time` keeps the zone:** `reminder_at.to_time` now keeps the zone rather than the offset [CL 8-0 / 8-1 activesupport]. The `.to_i` used in `note.rb:44,72` is unchanged, but the comment at `note.rb:41-42` becomes inaccurate. [inf]
- **`Model.connection`:** it is soft-deprecated, but still works under the default settings (`notebook.rb:40`). [src `connection_handling.rb:277`]

## New defaults that only matter if you raise `load_defaults`

Each of these needs a decision when you do.

- **`postgresql_adapter_decode_dates` (7.2):** `select_rows` would return `Date` objects, and `Date.iso8601(day)` in `notebook.rb:40` would raise. [src railtie / configuration.rb:332]
- **`raise_on_invalid_cache_expiration_time` (7.1):** the exports view would raise for expired exports (item 5).
- **`enqueue_after_transaction_commit` (8.0):** `Citation#request_enrichment` and `Note#schedule_reminder` deliberately enqueue inside `with_lock` and read `job.job_id` straight away (`citation.rb:15-23`, `note.rb:57-62`). Deferring the enqueue would break the "rollback on failed enqueue" design. [src `enqueue_after_transaction_commit.rb`]
- **`raise_on_assign_to_attr_readonly` (7.1):** `NotebooksController` permits `:slug` (`notebooks_controller.rb:40`) while `Notebook` has `attr_readonly :slug`. Updates that include a slug would start raising.
- **`default_column_serializer = nil` (7.1):** `serialize :preferences` without a coder (`notebook.rb:7`) would raise.

## Judged not relevant

- **MySQL/Trilogy/SQLite adapter changes:** the app uses PostgreSQL.
- **Solid Queue, Solid Cache, Solid Cable, Kamal, Thruster, and the propshaft default:** new-app generators only. The app keeps Sprockets.
- **Active Storage variant processor and analyzer changes:** no `image_processing`, and no variants.
- **Composite primary keys, encryption and multi-db:** not used.
- **Action Cable:** Redis is configured, but there are no channels beyond the base class.
- **`params.expect` (8.0):** an optional addition. `require/permit` still work.
- **Trix:** 8.1's Action Text depends on the `action_text-trix` gem, and the app loads a vendored Trix 1.3.5 itself. I didn't verify that `actiontext.js` 8.1 works with Trix 1.x, so check the editor in a browser [inf].
- **Dependency pins:** `concurrent-ruby 1.3.4` and `minitest ~> 5.25` were Rails 7.0 workarounds and can probably be revisited. Puma 5 and Rack 2.2 are still allowed by 8.1. Rebuild the lockfile and check that importmap-rails, turbo-rails and stimulus-rails resolve [inf].

## Where to look first

Fix the rollback in `Import#apply`, the digest's time zone, and the BigDecimal format before deploying. All three change behavior without raising an error.

The unpacked gem sources are in `/tmp/gems/<gem>-<version>/` and the changelogs are in `/tmp/cl/`.

---

I haven't changed anything yet. Rails is pinned at exactly `7.0.8.7` in the Gemfile, so this upgrade jumps four minor versions (7.1, 7.2, 8.0, 8.1). Once you've read the report, tell me if you want me to go ahead. If so, say whether you want one step straight to 8.1.0 or one step per minor version, and how you want to replace `Rails.application.secrets`.