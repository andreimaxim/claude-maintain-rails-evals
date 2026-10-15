# Rails 7.0.8.7 → 8.1.0 upgrade risk report for Margin Notes

The upgrade has seven high-risk changes. Each one changes behavior without raising an error. Four of them are covered by the test suite, which still asserts the 7.0 behavior. There are four medium-risk changes, which need a decision. A dozen low-risk changes would show up as boot or test failures.

I read the Rails gems for 7.0.8.7, 7.1.0, 7.2.0, 8.0.0 and 8.1.0, plus `action_text-trix` 2.1.15, Sidekiq 6.5.12 and Sidekiq 7.3.9. I unpacked them into `/tmp/railsgems/src/`. I did not install, run or modify anything.

Each claim is tagged with its source: **[CL]** changelog, **[code]** gem or app source I read, **[inf]** my inference.

## Facts the ratings depend on (please correct any that are wrong)

- **Database:** PostgreSQL only (`pg` 1.6.0). No MySQL or SQLite.
- **Framework defaults:** `config.load_defaults 7.0` (`config/application.rb:12`). Rails 8.1 still accepts this, so the newer defaults stay off unless you raise it **[code]**.
- **Background jobs:** Active Job uses Rails' built-in Sidekiq adapter with Sidekiq 6.5.12 and `redis` 4.8.1 (`application.rb:24`). Sidekiq runs as a separate `bundle exec sidekiq` process. `ExportJob` is a plain Sidekiq job, and tests use the `:test` adapter.
  - **[inf]** Web servers and workers may run different Rails versions during a deploy, and Redis holds jobs written by 7.0, including reminders scheduled weeks ahead.
- **Rendering:** HTML only, through ERB. There are no Jbuilder views. Assets use Sprockets and importmap. Trix 1.3.5 is vendored and loaded as a classic script (`layouts/application.html.erb:13`).
- **Cache:** production sets no `cache_store`, so it gets the default `:file_store`. The only cached fragment is on the exports page (`exports/_export.html.erb:26`).
- **Other frameworks:** Active Storage uses the Disk service with no image processor. Action Cable has no channels. Mail goes out with `deliver_now` from inside jobs.
- **Time zones:** the app time zone is UTC. Each reader has a stored zone name in `users.time_zone`.
- **Ruby and pinned gems:** Ruby 3.3.6 meets Rails 8.1's `>= 3.2`. Rails 8.1's dependencies still resolve with rack 2.2 (Sidekiq 6.5 pins `rack ~> 2.0`), puma 5 and minitest 5 **[code: gemspecs]**.
- **Upgrade path:** I assume you jump straight from 7.0 to 8.1, so the 7.1 and 7.2 deprecation warnings never appear.

## High risk

**1. `return` inside `transaction` now commits, so a failed CSV import saves part of the file.**
- Before: in 7.0, leaving the block early after a write rolled back **[code: 7.0 `transaction.rb:336`]**.
- Now: 7.2 removed that, and 8.1 commits **[CL]** **[code: 8.1 `transaction.rb:655`]**.
- Where: `app/models/import.rb:53-58`, where `return false unless row.note.save` sits inside `transaction do`.
- What could go wrong: an invalid row after valid ones leaves the `Import`, the earlier notes and any new `Citation` rows committed. The app's documented guarantee is that nothing from a failed import is saved.
- Tests: `imports_controller_test.rb:65` (`assert_no_changes`) would catch it.
- Links: PR https://github.com/rails/rails/pull/48600 and https://github.com/rails/rails/blob/v7.2.0/activerecord/CHANGELOG.md.

**2. `citation[:id]` returns nil, which blanks the DOI column of the import receipt CSV.**
- Before: `read_attribute(:id)` mapped to the custom primary key (`doi`) **[code: 7.0 `read.rb:31`]**.
- Now: removed in 7.2 **[CL]**. The `citations` table has no `id` column, so it returns nil without raising **[code: 8.1 `read.rb:29`, ActiveModel `Attribute::Null`]**.
- Where: `app/models/import.rb:68`.
- Tests: `imports_controller_test.rb:45` would catch it.
- Fix: use `citation.doi` or `citation.id`.

**3. `DigestJob` now gets the request time in the reader's zone, so digests cover the reader's local day.**
- Before: 7.0 rebuilt TimeWithZone arguments in the worker's zone, UTC **[code]**.
- Now: since 7.2 the serialized zone is kept **[CL "Preserve the serialized timezone…"]** **[code: 8.1 `time_with_zone_serializer.rb`]**.
- Where: `app/models/user.rb:41` passes `requested_at`, which is in the reader's zone. `app/mailers/digest_mailer.rb:8-9` computes `to_date` and `all_day` from it.
- What could go wrong: the digest's date and note range follow the reader's local day, while the Redis reservation key stays on the UTC day (`user.rb:36`). That breaks the documented rule that the content day matches the reservation day.
- Mixed versions: payloads from 7.0 have no zone, so 8.1 workers keep the old behavior for those jobs.
- Tests: `digests_controller_test.rb:33-35` would fail.

**4. The BigDecimal job argument format changed, so old workers can't run new `DigestJob`s.**
- Before: in 7.0, `reading_completion` (a `BigDecimal`) went into the Sidekiq JSON as a plain string.
- Now: 8.x always wraps it as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer",…}` **[code: 8.1 `serializers.rb:107`]**.
- What could go wrong: a 7.0 worker can't find that serializer class and raises `DeserializationError` **[code: 7.0 `serializers.rb:42-43`]**. Any digest enqueued by an 8.1 web process and picked up by a 7.0 worker fails until the workers are upgraded.
- The 7.1 changelog calls out this exact race. It added `use_big_decimal_serializer`, off by default, as a two-step rollout. That flag was removed in 8.0, so jumping straight to 8.1 skips the safe path **[CL]**.
- Mitigation: upgrade workers before web, or drain the queues first.
- Link: PR https://github.com/rails/rails/pull/45618.

**5. `TimeWithZone#to_time` now keeps the zone, not just the UTC offset.**
- Before: 7.0 kept only the offset.
- Now: 8.1 always uses `getlocal(time_zone)` **[CL 8.1 "Remove deprecated support for `to_time` to preserve the system local time"]** **[code: `time_with_zone.rb:498`]**.
- Where: `app/models/note.rb:44` (`reminder_at.to_time + 86_400`), shown in `notes/_reminder.html.erb:19`.
- What changes: across a daylight-saving change, the "24 hours later" preview now shows the new offset and wall-clock time. The instant and the stored epoch (`.to_i`) are unchanged, so this arguably fixes the mismatch described in ARCHITECTURE.md **[inf]**.
- Tests: `reminders_controller_test.rb:21` asserts the old `-04:00` value.

**6. The `"Astana"` time zone now maps to Asia/Almaty instead of Asia/Dhaka.**
- Asia/Almaty has been UTC+5 since 2024, where Asia/Dhaka was UTC+6 **[code: TimeZone MAPPING diff]** **[CL 7.2]**.
- Where: readers whose stored `time_zone` is "Astana" (`user.rb:13,22`, `note.rb:37`).
- What could go wrong: their reminder times are read and shown one hour off, with no error. I also saw renames for Greenland/Nuuk and Canberra; I believe they don't change offsets **[inf]**.
- Check: `SELECT count(*) FROM users WHERE time_zone='Astana'`.
- Link: PR https://github.com/rails/rails/pull/51317.

**7. Action Text `to_plain_text` output changed (8.1, no changelog entry).**
- Found only in the code diff: `<script>`/`<style>` text is now dropped, and `<ol>` numbering counts only element siblings, where before whitespace text nodes counted too **[code: `plain_text_conversion.rb` 8.0 → 8.1]**.
- Where: `app/models/export.rb:78` (Markdown export content), plus the truncated previews in `notes/index.html.erb:53` and `imports/preview.html.erb:58`.
- Impact is narrow: imported `body_html` with whitespace between list items, or with script content. The new output is more correct **[inf]**.

## Medium risk

**8. `Rails.application.secrets` was removed in 7.2 [CL].**
- Where: `app/models/citation/provider.rb:13` reads `config/secrets.yml`. Tests also reassign it (`citation_enrichments_controller_test.rb:45,117-122`).
- What happens: `NoMethodError` the first time citation metadata is fetched.
- Decision: move these settings to `config_for` (it can read the same YAML), credentials, or ENV, and update the docs that point to secrets.yml.
- Link: PR https://github.com/rails/rails/pull/48472.

**9. The built-in Sidekiq adapter is deprecated in 8.1 and will be removed in 8.2.**
- It still works in 8.1 and logs a deprecation **[CL]** **[code: `sidekiq_adapter.rb:33`]**.
- The replacement needs Sidekiq 7.3.3 or later, which switches to `redis-client` **[code: sidekiq 7.3.9]**. That would cause silent breakage in this app:
  - `user.rb:38`: `redis.sadd` returns `0`/`1`, and `0` is truthy in Ruby, so the once-per-day digest limit stops working.
  - `notebook.rb:28`: `rescue Redis::BaseError` no longer catches Redis errors, which become `RedisClient::Error`.
  - `digests_controller_test.rb:50-51` stubs `Redis::CannotConnectError`.
- Link: PR https://github.com/rails/rails/pull/53058.

**10. `ActionText::ContentHelper.allowed_tags` now defaults to nil.**
- In 8.1 the default list is computed in `sanitizer_allowed_tags` instead **[code]**.
- Where: `config/initializers/action_text.rb:3`, where `+= %w[details summary]` raises `NoMethodError` at boot.
- Why it's medium: the obvious fix, `= %w[details summary]`, would silently strip every other tag, including `action-text-attachment`, `figure` and `figcaption`. The replacement has to rebuild the default list itself.

**11. Trix packaging changed.**
- Action Text 8.1 now depends on `action_text-trix` (>= 2.1.15) **[CL]**. That gem supplies `trix.css` for Trix 2 **[code]**.
- Where: `app/assets/stylesheets/actiontext.css:6` (`*= require trix`) will load the Trix 2 CSS, while the JavaScript stays the vendored 1.3.5.
- Effect: possible editor styling mismatch, with no error **[inf]**.
- Decision: move to Trix 2, which makes the 1.3.5 workaround unnecessary, or vendor the Trix 1 CSS.

**New defaults to decide on if you raise `load_defaults` [code: 8.1 `configuration.rb`].** These change nothing while you stay on `load_defaults 7.0`:
- **7.1 `raise_on_assign_to_attr_readonly`:** the notebook settings form re-submits `slug` (`notebooks_controller.rb:40`, `notebooks/_form.html.erb:13`), so saving settings would raise.
- **7.1 `default_column_serializer = nil`:** `serialize :preferences` (`notebook.rb:7`) needs `coder: YAML` to keep reading the YAML already stored. Choosing JSON would break existing rows.
- **7.1 `raise_on_invalid_cache_expiration_time`:** an expired export makes `expires_in` negative (`exports/_export.html.erb:26`), so the exports page would raise.
  - Even on 7.0 defaults, 8.1 already changes this path: the negative value is dropped, an error is logged and reported, and the fragment is written with no expiry. In 7.0 the entry was written already expired **[code: 8.1 `cache.rb:922`]**. The page probably looks the same **[inf]**.
- **7.2 `postgresql_adapter_decode_dates`:** `select_rows` would return `Date` objects, and `Date.iso8601(Date)` raises a `TypeError` (`notebook.rb:40`). `activity_reports_controller_test.rb:23` would catch it.
- **8.0 `strict_freshness`:** affects `stale?` in `export_downloads_controller.rb:11` when a request sends both conditional headers.
- **7.1 HTML5 sanitizer vendor:** changes the Action Text default allowlist base.

## Low risk (boot or tests would catch these)

- `enum status: {...}, _prefix: true` (`note.rb:10`): the keyword form was removed in 8.0. Use `enum :status, {...}, prefix: true` **[CL]**.
- `serialize :tags, JSON` (`note.rb:12`): the positional coder was removed in 7.2. Use `coder: JSON` **[CL]**.
- `alias_attribute :highlight_color, :color` (`note.rb:14`): `color` is a store accessor, which now raises `ArgumentError`. Use `alias_method` for the reader and writer **[CL 7.2]** **[code]**.
- `fragments.sum` on strings (`export.rb:42`): Active Support's `Enumerable#sum` override was removed in 7.1, so this raises `TypeError` in `ExportJob`. Use `join` **[CL]**.
- `set(wait_until: Integer)` (`note.rb:61`): numeric `scheduled_at` was removed in 7.2, and `job.serialize` raises calling `.utc` on an Integer. Use `Time.at(epoch)` **[code: `core.rb:130,177`]**.
- `retry_on … wait: :exponentially_longer` (`citation_enrichment_job.rb:7`): removed in 7.2. It raises only when the provider is unavailable, so boot won't catch it, but `citation_enrichments_controller_test.rb:67` will. Use `:polynomially_longer` **[CL]** **[code: `exceptions.rb:188`]**.
- `get "/notes", "/journal", to:` (`config/routes.rb:18`): a route with several paths was removed in 8.1 and raises at boot. Split it into two routes **[CL]**.
- `form_with(model: nil, …)` (`notes/index.html.erb:12`): removed in 8.0 and raises `ArgumentError`. Drop `model: nil` **[CL]**.
- `show_exceptions = false` (`config/environments/test.rb:31`): in 8.1 this is treated as "show", so the many `assert_raises(RecordNotFound)` tests fail. Use `:none` **[code: `exception_wrapper.rb:184`]**.
- `pin "@rails/actiontext", to: "actiontext.js"` (`config/importmap.rb:8`): the 8.1 file is UMD but still runs as a module. The installer now pins `actiontext.esm.js` **[code]** **[inf]**.
- Active Storage now touches records after a blob is analyzed (7.1). An attachment bumps `Note#updated_at` (through the rich text record) and `Export#updated_at` **[CL]**.
- `schema.rb` columns are now sorted alphabetically (8.1). Parallel test databases are named `_N` instead of `-N`. The development secret moved to `tmp/local_secret.txt`, which resets dev sessions **[CL]** **[code]**.

## Judged not relevant

- **MySQL, SQLite and Trilogy changes:** the app uses PostgreSQL only.
- **`enqueue_after_transaction_commit`:** it defaults to false in 8.1, so the app's enqueue-under-`with_lock` behavior is unchanged **[code: `enqueuing.rb:53`]**. It would only matter if you stop at 7.2.
- **Azure storage removal:** the app uses Disk.
- **Action Cable and Action Mailbox:** no channels and no inbound mail.
- **JSON response escaping and Jbuilder defaults:** HTML only.
- **Propshaft and new-app generator changes:** they affect only newly generated apps.
- **Removed query-string semicolons and leading-bracket params:** no known clients use them **[inf]**.
- **`ActiveRecord::Base.connection`:** soft-deprecated, with no warning unless configured **[code]**.
- **Cookie and cache format versions:** they stay at the 7.0 settings.
- **`lock!` on records with unsaved changes:** it already raised in 7.0.
- **Removed `to_s(:format)`, `mb_chars`, `Benchmark.ms` and `ProxyObject`:** grep found no uses.
- **Sidekiq 6.5.12's logger hook:** it already handles Rails 7.1+ **[code: `sidekiq/rails.rb`]**.

## Suggested approach

Go one release at a time (7.1 → 7.2 → 8.0 → 8.1) so the deprecation warnings point at most of the items above. On 7.1, turn on `use_big_decimal_serializer` only after every worker runs 7.1 **[inf]**.

The GitHub search API hit its rate limit partway through, so for the remaining entries I linked the release changelogs at `https://github.com/rails/rails/blob/v<version>/<component>/CHANGELOG.md`.

---

I haven't changed the app yet. Rails is pinned at exactly `7.0.8.7` in `Gemfile:7`, so 8.1.0 spans four releases, not a minor bump. Please answer these before I start:

1. **Path:** one release at a time (7.1 → 7.2 → 8.0 → 8.1, one commit per step with tests passing) or straight to 8.1? I recommend one at a time. It's the only safe way to roll out the BigDecimal job argument change (#4) while old and new workers run side by side.
2. **Behavior changes:** for #3 (digest day), #5 (`to_time`) and #7 (plain text), should the tests stay on the old behavior, with the code changed to keep it? Or should the code and tests take the new behavior?
3. **Medium items:** which replacement do you want for `secrets.yml` (#8)? And for Trix (#11), keep 1.3.5 and vendor its CSS, or move to Trix 2? CLAUDE.md says to keep dependency versions unless the task authorizes changing them. So I'd stay on Sidekiq 6.5 for now (#9) and keep `load_defaults 7.0`, unless you say otherwise.
4. **Data check:** the Astana check (#6) needs a query against production data. Please run it, or tell me how many readers it affects.