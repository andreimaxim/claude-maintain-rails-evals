# Rails 7.0.8.7 → 8.1.0 upgrade risk report for Margin Notes

I found six high-risk changes. Five of them change behavior without raising an error, and the sixth breaks jobs queued while old and new versions run side by side. I confirmed each one in the Rails 7.0.8.7 and 8.1.0 gem source. I didn't install anything, change the app, or run it, and I wrote no report files.

Sources:
- **Code read**: what I compared in the two gem versions, in `/tmp/g/old/<gem>` and `/tmp/g/new/<gem>` (activerecord, activesupport, activejob, actionpack, actiontext, railties, activemodel).
- **Changelog**: CHANGELOG entries. The 8.1 gems only ship 8.1 entries; the 7.1–8.0 entries are on GitHub (`rails/rails`, the `7-1-stable`, `7-2-stable` and `8-0-stable` branches, `*/CHANGELOG.md`). I didn't look up the individual pull requests, so the links below point to the changelogs, not to PRs.

## Facts about the app that the ratings depend on
- **Defaults:** `config.load_defaults 7.0` (`config/application.rb:12`). Several 7.1–8.0 behaviors that are gated behind new defaults don't apply unless you bump this. Those are noted below.
- **Database:** PostgreSQL only (`config/database.yml`).
- **Jobs:** Active Job runs on Sidekiq 6.5.12 with redis 4.8.1 (`config/application.rb:24`). `ExportJob` is a native Sidekiq job. Tests use the `:test` adapter.
- **Cache:** no cache store is set in production, so Rails uses its default file store. Fragment caching is used in `app/views/exports/_export.html.erb:26`. Test uses `:null_store`.
- **Rendering:** server-rendered HTML with Sprockets, importmap, Turbo, Stimulus, Action Text and Active Storage (local disk). The app has no JSON API controllers.
- **Secrets:** settings come from `config/secrets.yml` through `Rails.application.secrets`.
- **Tests:** test env sets `show_exceptions = false`, and controller tests use `assert_raises(ActiveRecord::RecordNotFound)`.

## High risk

**1. `return` inside a `transaction` block now commits instead of rolling back**
- **Before:** an early `return` from a block that had already written rolled the transaction back (`old/.../abstract/transaction.rb`, the `!completed && transaction.written` branch).
- **Now:** it commits (`new/.../transaction.rb`, `within_new_transaction`). The 7.1 changelog adds `commit_transaction_on_non_local_return`, and later versions remove the old behavior.
- **Where:** `app/models/import.rb:387-392`: `return false unless row.note.save` inside `transaction do`.
- **What could go wrong:** if a row fails to save during apply, the Import record and earlier rows' notes are now saved. This breaks the "saves nothing" promise in the class comment. Replace the `return` with `raise ActiveRecord::Rollback` (or `save!` and rescue).
- **Source:** code read.

**2. `record[:id]` no longer reads a primary key that isn't named `id`**
- **Before:** 7.0's `read_attribute` mapped `"id"` to the primary key (`old/.../attribute_methods/read.rb:31`).
- **Now:** 8.1 removed that mapping (7.1 changelog).
- **Where:** `citations` has `primary_key: "doi"` (`db/schema.rb:55`), and `app/models/import.rb:402` reads `citation && citation[:id]`.
- **What could go wrong:** the receipt CSV's doi column becomes blank and nothing raises. I think it returns nil rather than raising, but that's my inference. Use `citation.id` or `citation.doi`.
- **Source:** code read.

**3. TimeWithZone job arguments keep their time zone**
- **Before:** 7.0 deserialized them in `Time.zone`, which is UTC in the worker.
- **Now:** 8.1 stores and restores `time_zone` (`new/activejob/.../time_with_zone_serializer.rb`).
- **Where:** `User#request_digest` passes `requested_at` already in the reader's zone (`app/models/user.rb:182,188`). `DigestMailer#daily_digest` (`app/mailers/digest_mailer.rb:3-6,476-477`) and `DigestJob` (lines 13-14) depend on the UTC conversion that 7.0 did.
- **What could go wrong:** the digest's `@date` and the `all_day` range become the reader's local day. Different notes are selected near midnight, and the subject date changes.
- **Source:** code read.

**4. BigDecimal job arguments use a new serializer**
- **Before:** in 7.0, BigDecimal passed through as a JSON string.
- **Now:** 8.1 always uses `BigDecimalSerializer`. The `use_big_decimal_serializer` setting was added in 7.1 and removed later (changelog).
- **Where:** `DigestJob.perform_later(self, requested_at, reading_completion)` at `app/models/user.rb:188`.
- **What could go wrong:**
  - During a rolling deploy, 7.0 workers can't deserialize the new format and raise a DeserializationError.
  - The same applies to the new TimeWithZone payloads from item 3.
  - The mailer's `BigDecimal(params[:completion])` still works with either form.
- **Source:** code read, plus inference for the rolling-deploy effect.

**5. `TimeWithZone#to_time` keeps the zone, not a fixed offset**
- **Before:** with 7.0 defaults (`to_time_preserves_timezone = true`), `to_time` returned a Time with a fixed offset.
- **Now:** 8.1's `to_time` returns `getlocal(time_zone)` (`new/.../time_with_zone.rb:497`), and the setting is deprecated.
- **Where:** `Note#next_day_reminder_at` (`app/models/note.rb:43-45`, whose comment depends on keeping the offset) and the view `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:** across a daylight-saving change, the "24 hours later" text and its `(UTC%:z)` offset now show local time. The scheduled epoch (`.to_i` at line 72) doesn't change. The visible effect is limited, but nothing raises.
- **Source:** code read.

**6. `wait_until:` no longer accepts an Integer**
- **Before:** 7.0 called `options[:wait_until].to_f` (`old/.../core.rb:162`).
- **Now:** 8.1 stores the value as is and serializes `scheduled_at.utc.iso8601(9)` (`new/.../core.rb:130,177`). The adapter also calls `scheduled_at.to_f`.
- **Where:** `NoteReminderJob.set(wait_until: reminder_epoch)`, where `reminder_epoch` is a bigint (`app/models/note.rb:61`).
- **What could go wrong:** I expect `NoMethodError: undefined method 'utc' for Integer` when scheduling reminders, including reminders from imports. That's an inference from the code; I didn't run it. Use `Time.at(reminder_epoch)`. It raises, but only at runtime, so I rated it high.
- **Source:** code read.

## Medium risk

**7. `Rails.application.secrets` was removed**
- **What changed:** deprecated in 7.1 and removed in 7.2. `def secrets` is gone from railties 8.1.
- **Where:** `app/models/citation/provider.rb:13` and `config/secrets.yml`.
- **What could go wrong:** citation lookups raise NoMethodError. You need to decide where the settings go (credentials, `config_for`, or ENV).
- **Source:** code read and changelog.

**8. `retry_on wait: :exponentially_longer` was removed**
- **What changed:** 8.1's `determine_delay` only knows `:polynomially_longer` and raises "Couldn't determine a delay" for anything else (`new/activejob/.../exceptions.rb:173-189`).
- **Where:** `app/jobs/citation_enrichment_job.rb:502`.
- **What could go wrong:** the error only appears when the provider is unavailable. The job then fails instead of retrying, `fail_enrichment` never runs, and the citation stays `pending`. While it's pending, `request_enrichment` refuses new requests. The rename is mechanical, but boot won't catch it.
- **Source:** code read.

**9. Rails' own Sidekiq adapter is deprecated**
- **What changed:** 8.1 says the built-in adapter "will be removed in Rails 8.2" and asks for sidekiq 7.3.3 or later (activejob 8.1 CHANGELOG, line 19).
- **Where:** the app pins sidekiq 6.5.12 and redis 4.8.1.
- **What could go wrong:** nothing breaks in 8.1. Upgrading Sidekiq is a separate major change that also touches `Sidekiq.redis` usage in `app/models/user.rb:185-190` and `ExportJob`.
- **Source:** code read and changelog.

**10. `show_exceptions = false` now means "show exceptions"**
- **What changed:** 8.1's `ExceptionWrapper#show?` treats anything other than `:none` or `:rescuable` as `:all` (`new/actionpack/.../exception_wrapper.rb:185-197`).
- **Where:** `config/environments/test.rb`, and the tests at:
  - `test/controllers/notebooks_controller_test.rb:44-45`
  - `test/controllers/activity_reports_controller_test.rb:35`
  - `test/controllers/exports_controller_test.rb:123-127`
  - `test/controllers/notes_controller_test.rb:177`
  - `test/controllers/digests_controller_test.rb:51`
- **What could go wrong:** these tests now get 404 or 500 responses instead of exceptions. Set `:none`, or change the tests to assert status codes.
- **Source:** code read.

**11. `Enumerable#sum` no longer concatenates non-numbers**
- **What changed:** the Active Support override was deprecated in 7.1 and is gone in 8.1. Only Range#sum remains (`new/.../enumerable.rb:253`).
- **Where:** `fragments.sum` on strings in `app/models/export.rb:247`.
- **What could go wrong:** Ruby raises TypeError, so every export job fails. Use `join`.
- **Source:** code read.

**12. `ActionText::ContentHelper.allowed_tags` is now nil by default**
- **What changed:** 8.1 computes the list lazily in `sanitizer_allowed_tags` (`new/actiontext/app/helpers/action_text/content_helper.rb:10,68`).
- **Where:** `config/initializers/action_text.rb:3` uses `+=`.
- **What could go wrong:** boot raises NoMethodError on nil. If you fix it by setting only `%w[details summary]`, Action Text would strip every other tag. Build the list from `sanitizer.class.allowed_tags` plus the attachment, `figure` and `figcaption` tags.
- **Source:** code read.

**13. Negative cache `expires_in` is handled differently**
- **What changed:** 8.1 deletes a negative `expires_in` and, with 7.0 defaults, only logs it (`new/.../cache.rb:922-945`; `raise_on_invalid_cache_expiration_time` is false under 7.0 defaults).
- **Where:** `app/views/exports/_export.html.erb:26` passes `export.expires_at - Time.current`, which is negative after expiry.
- **What could go wrong:** the "Expired" fragment is written with no expiry, and errors are logged. The page output is probably still correct; that's an inference. If you adopt the 7.1 defaults, this raises and the page fails.
- **Source:** code read, plus inference for the effect.

## Low risk (mechanical, caught at boot or by tests)
- **`serialize :tags, JSON`** (`app/models/note.rb:12`): a positional coder raises ArgumentError in 8.1, which only accepts the `coder:` keyword. Use `coder: JSON`. Source: code read.
- **`enum status: {...}, _prefix: true`** (`app/models/note.rb:10`): the keyword form and `_prefix` raise "invalid option(s)" in 8.1 (`enum.rb:379-381`). Use `enum :status, {...}, prefix: true`. Source: code read.
- **`alias_attribute :highlight_color, :color`** (`app/models/note.rb:14`): `color` is a `store_accessor`, not an attribute. 8.1 raises ArgumentError (`attribute_methods.rb:90-92`). Use `alias_method` or explicit methods. The form permits `:highlight_color`. Source: code read.
- **Route with multiple paths** (`config/routes.rb`, `get "/notes", "/journal"`): support was removed in 8.1 (actionpack CHANGELOG, line 107). Split it into two routes. Source: changelog.
- **`Note.connection.select_rows`** (`app/models/notebook.rb:40`): `.connection` is soft-deprecated in favor of `with_connection` or `lease_connection`. Source: code read.
- **`config.cache_classes`** in the environment files: superseded by `enable_reloading`, and still works. Source: inference.

## Changes I judged not relevant, or only relevant if you bump `load_defaults`
- **PostgreSQL date decoding** (`decode_dates`, a 7.2 default): it's off under 7.0 defaults. If you turn it on, `Date.iso8601(day)` in `notebook.rb:40` gets a Date and raises TypeError. Source: code read.
- **`serialize :preferences` with no coder** (`app/models/notebook.rb:7`): this works under 7.0 defaults because the default coder is YAML. The 7.1 defaults set the default serializer to nil, and then it raises "missing keyword: :coder". Source: code read; the YAML default is an inference.
- **MySQL, SQLite, Trilogy and SolidQueue/Cache/Cable changes:** not used.
- **Kamal, Propshaft and other new-app generator defaults:** they don't affect existing apps.
- **`strict_freshness`** (an 8.0 default that changes which header wins in `stale?`): off under 7.0 defaults. It's used at `export_downloads_controller.rb:11`.
- **`has_secure_password`:** the 72-byte password limit (7.1) and reset tokens (8.0) don't change how `authenticate` works here (inference).
- **Other gem versions:** Ruby 3.3.6, puma 5, concurrent-ruby 1.3.4 and minitest 5.25 should all satisfy 8.1's requirements. I inferred this from the gemspecs and didn't resolve the bundle.

---

I haven't changed any files yet. This report only reviews the upgrade.

The app pins Rails at exactly 7.0.8.7, so this jump crosses four minor versions. The biggest risks are the six high-risk items: four of them change behavior without raising an error, and one breaks jobs queued while old and new versions run side by side during a deploy. Fixing items 1–2, 6–8 and 10–12 before or alongside the version bump would cover most of the changes that break things.

Tell me if you want me to go ahead with the upgrade, and whether to do it in one jump or step through 7.1, 7.2 and 8.0.