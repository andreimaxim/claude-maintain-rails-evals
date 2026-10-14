# Rails upgrade plan for Margin Notes: 7.0.8.7 to 8.1.0

## Summary

Upgrading only the `rails` line breaks the app. It first fails to boot, then fails 46 of 46 tests. Some breakages raise errors. Others silently change data or behaviour: partial CSV imports, CSV receipts with blank DOIs, digests for the wrong day, annotations missing from the import preview, and job payloads that old workers can't read.

I upgraded a disposable copy to 8.1.0 and repaired it. All 46 tests (340 assertions) pass with `load_defaults 7.0` kept, and they also pass with `load_defaults 8.1` after three more fixes. The dev server, a Sidekiq worker and cross-version job payloads were all exercised. Most of the repairs also work on 7.0 and can ship first. The working repository was not modified.

One isolation lapse: for my first two 7.0 test runs on the `prep70` branch, the copy's `config/database.yml` still pointed at the real **`margin_notes_test`** database. Those runs reloaded fixtures into it. `TESTING.md` treats that database as disposable, but it was not isolated. After that, two runner scripts read the real `margin_notes_development` (0 users) and failed before writing anything. Redis use was always confined to DB 9. All later runs used `margin_notes_up_*`, and I dropped those databases at the end.

## Experiment record

- **Copy:** `/tmp/up/app`. Isolation settings are in `/tmp/up/env.sh`: `margin_notes_up_dev` / `margin_notes_up_test`, `REDIS_URL=redis://localhost:6379/9`, and the copy's own `storage/`, `tmp/mails` and cache.
- **Branches:** `up81` is Rails 8.1.0 plus the repairs; `prep70` is Rails 7.0.8.7 plus the repairs that work on 7.0.
- **Patches:** `/tmp/up/final-up81.patch` and `/tmp/up/final-prep70.patch`.
- **Resolved lockfile:** `/tmp/up/Gemfile.lock.up81`. It has rails 8.1.0, json 2.21.2 (pinned), rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1 and minitest 5.27.0. Ruby is 3.3.6.
- **Change index from the tool:** `/tmp/up/changes.txt`.
- **Baseline:** `/tmp/up/baseline-7.0.log` shows 46 runs, 0 failures.
- **Repair progression:** `/tmp/up/test-81-b.log` through `/tmp/up/test-81-k.log`; the final run, `test-81-k.log`, is green.
- **With 8.1 defaults:** `test-81-defaults81{,b,c}.log`.
- **7.0 compatibility:** `test-70-prep{,2,3,4}.log`.
- **Runtime checks:**
  - Server: `/tmp/up/server-81.log`. Every main page returned 200 after sign-in.
  - Sidekiq worker: `/tmp/up/sidekiq-81.log`. Export, digest, reminder and enrichment jobs ran.
  - Payload checks: `/tmp/up/payload-{70,81,81s}.json` and `/tmp/up/exec-*.log`, using the scripts in `/tmp/up/scripts/`.

## A. Required changes (each one fails or misbehaves on 8.1)

The tags mean:
- **[prep]**: verified on 7.0 with all tests passing, so it can ship before the upgrade.
- **[with-upgrade]**: must land in the same commit as the gem bump.

1. **json 3.x breaks every serialized column.** Bundler resolved `json 3.1.0` (activesupport 8.1 requires `json` with no upper bound). Reading `Note#tags` then fails with `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json/common.rb:291`, called from `ActiveSupport::JSON.decode`.
   - Fix: add `gem "json", "~> 2.7"` to the Gemfile. [prep]
   - Check: `bundle exec ruby -e 'require "active_support/json"; p ActiveSupport::JSON.decode("[1]")'`.

2. **`config/initializers/action_text.rb` stops boot.** Action Text 7.1+ leaves `allowed_tags` nil by default, so boot fails with `undefined method '+' for nil (NoMethodError)`.
   - Fix: inside `config.after_initialize { ActiveSupport.on_load(:action_view) { … } }`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. The full text is in the patch.
   - Running after initialization means it picks up the HTML5 sanitizer if that default is adopted later. [prep]
   - Check: the test "rich text keeps collapsible excerpts and drops unsafe markup".

3. **Old `enum` syntax** in `app/models/note.rb:10` raises `ArgumentError` (the keyword form was removed in 8.0).
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Same method names; stored integers unchanged. [prep]

4. **`serialize :tags, JSON`** (`note.rb:12`) raises `wrong number of arguments (given 2, expected 1)`.
   - Fix: `serialize :tags, coder: JSON`. The stored format is unchanged. [with-upgrade]
   - On 7.0, `coder:` is silently ignored and `tags` becomes a raw String. The 7.0 run failed with `undefined method 'any?' for an instance of String`. Do not ship this early.

5. **`alias_attribute :highlight_color, :color`** (`note.rb:14`) points at a `store_accessor`, which is no longer allowed. The error is: `Note model aliases 'color', but 'color' is not an attribute. Use alias_method …`.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. This covers the reader (the views) and the writer (the permitted parameter and the form radio buttons). [prep]

6. **`Rails.application.secrets` was removed** in 7.2. The error is `undefined method 'secrets'`.
   - Affected: `app/models/citation/provider.rb:13`, `config/secrets.yml`, and `test/controllers/citation_enrichments_controller_test.rb` (lines 45 and 117–122).
   - Fix:
     - Rename the file to `config/citation_provider.yml`.
     - Add `config.x.citation_provider = config_for(:citation_provider)[:citation_provider]` to `config/application.rb`.
     - Read `Rails.configuration.x.citation_provider.to_h` in the provider, and update the test the same way.
   - The values keep the same symbol keys and ERB/ENV behaviour. [prep]
   - Check: the test "provider credentials from the environment reach the server unchanged", which uses a fresh subprocess boot. Also confirm that production ENV values are set, and that an unset value still gives the error "No citation provider is configured".

7. **Multi-path `get "/notes", "/journal"`** (`config/routes.rb:18`) raises `Wrong number of arguments (expect 1, got 2)`.
   - Fix: use two lines, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", …, as: :journal`. This keeps the existing `notes`/`journal` route names. [prep]

8. **`where(notebooks: @notebook)`** (`notes_controller.rb:13`) fails with `PG::UndefinedColumn: column notes.notebooks does not exist`.
   - Fix: `where(notebook: @notebook)`. [prep]

9. **`form_with(model: nil, …)`** (`notes/index.html.erb:12`) raises `Passed nil to the :model argument`.
   - Fix: remove `model: nil`. The parameter names stay unscoped, as before. [prep]

10. **`fragments.sum` on strings** (`export.rb:42`) fails with `TypeError: String can't be coerced into Integer`, because Active Support no longer extends `sum` to strings. Every export job would fail.
    - Fix: `fragments.join`. [prep]

11. **`set(wait_until: reminder_epoch)` with an Integer** (`note.rb:61`) fails with `undefined method 'utc' for an instance of Integer`. Scheduling and postponing reminders both fail.
    - Fix: `wait_until: Time.at(reminder_epoch)`. This covers both the import path and the postpone path. [prep]

12. **`wait: :exponentially_longer` was removed** (`citation_enrichment_job.rb:7`). Calling `request_enrichment` raises `Couldn't determine a delay based on :exponentially_longer` the first time the job hits `Provider::Unavailable`.
    - Fix: `:polynomially_longer`, which uses the same formula. It only exists from 7.1, so it is [with-upgrade].
    - The alternative is a lambda `->(n) { n**4 + 2 }`, which would work on 7.0 but drops the jitter. I don't recommend it.
    - Retries already queued carry their execution count, and the job class name is unchanged, so they keep working.

13. **Silent: transaction exit via `return` now commits** (`Import#apply`). Rails 7.0 rolled back; 8.x commits. On 8.1 the existing test showed a failed row leaving the import and the earlier notes saved: `record_counts` went from `[0, 3, 0, 1]` to `[1, 4, 1, 2]`. That is a partial import.
    - Fix: `saved = transaction { save!; raise ActiveRecord::Rollback unless rows.all? { |r| r.note.save }; true }; saved == true`.
    - This keeps the stop-at-first-invalid-row behaviour and both outcomes (all rows saved, or nothing saved). [prep]

14. **Silent: `citation[:id]` returns nil** (`Import#receipt`). From 7.1, `[:id]` reads a column literally named `id`, and citations use `doi` as the primary key. Receipts came out as `On idleness,` with no DOI.
    - Fix: `citation&.doi`. [prep]

15. **Silent: `HashWithIndifferentAccess#stringify_keys` now converts Integer keys to strings** (`imports/preview.html.erb:22`). I measured this directly:
    - 7.0: `[HWIA, [2], "x"]`
    - 8.1: `[HWIA, ["2"], nil]`

    The result is that annotations disappear from the preview.
    - Fix: use `@import.annotations` without `stringify_keys`. [prep]

16. **Silent: digests cover the reader's local day instead of the UTC day.** From 7.1, the Active Job `TimeWithZone` serializer keeps the zone. On 8.1 the test got "October 04" where "October 05" was expected. That contradicts the UTC reservation key in `User#request_digest`, the code comments and the UI hint.
    - Fix: add `requested_at = requested_at.utc` in `DigestMailer#daily_digest`. [prep]
    - Doing it in the mailer handles both 7.0-format and 8.1-format jobs that are already queued. I checked this: a Los Angeles 22:14 Oct 13 payload produced the Oct 14 (UTC) digest on both versions.

17. **`next_day_reminder_at` shows a different time.** In 8.1, `to_time` always keeps the zone, so the "24 hours later" display changed from `09:00-04:00` to `08:00-05:00` across the DST change. The instant and the epoch are unchanged.
    - Fix: `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. This keeps the behaviour the code comment documents. [prep]
    - If you would rather show the reader's local wall-clock time, keep the new behaviour and update the comment and the test instead.

18. **Test configuration:** `config.action_dispatch.show_exceptions = false` is no longer understood. Exceptions get rendered as 404/500 pages, so `assert_raises` tests fail.
    - Fix: `:none`. [with-upgrade]: 7.0 treats the symbol as truthy and would render exceptions.

19. **Mixed-version queue safety for `BigDecimal`.** 8.1 always uses `BigDecimalSerializer`. A 7.0 worker given an 8.1 payload fails with `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`/tmp/up/exec-81on70.log`).
    - Fix: `DigestJob.perform_later(self, requested_at, reading_completion.to_s)` in `user.rb:41`. The mailer already calls `BigDecimal(params[:completion])`. [prep]
    - This was verified in both directions.

## B. Recommended (not breaking under `load_defaults 7.0`)

- **Export availability cache:** in `exports/_export.html.erb:26`, an expired export gives a negative `expires_in`. Under the current setting, 8.1 logs `ArgumentError: Cache expiration time is invalid, cannot be negative` and stores the fragment with no expiry. With the 7.1 default (`raise_on_invalid_cache_expiration_time = true`) the page fails with `ActionView::Template::Error`. Both were reproduced in `/tmp/up/scripts/cache.rb`.
  - Fix: `expires_in: [export.expires_at - Time.current, 1.second].max`. [prep] The cached-indicator test still passes.
- **Gemfile:** add `gem "csv"` before moving to Ruby 3.4 (Ruby 3.3 already warns about it).
- **Sidekiq:** 6.5.12 works with 8.1 but logs `The built-in sidekiq adapter is deprecated and will be removed in Rails 8.2`. Treat the Sidekiq 7.3.3+ upgrade as separate work. These are code reviews, not runs:
  - `redis.sadd` will return an Integer, and `0` is truthy, which would break the one-digest-per-day guard. Use `sadd?`.
  - `rescue Redis::BaseError` in `Notebook#request_export` and the test that stubs `Redis::CannotConnectError` would need `RedisClient` errors.
  - `ExportJob.perform_async(id, { format: "markdown" })` uses symbol keys, which strict arguments will reject. The warning already appears in the logs.

## C. New framework defaults

Under `load_defaults 7.0`, the app keeps every old value; none of these are set explicitly. The authoritative list is `railties-8.1.0/lib/rails/application/configuration.rb`. The tool's list misses all of 8.1, plus `cache_format_version`, `default_headers`, `add_autoload_paths_to_load_path` and `Regexp.timeout`. It also lists settings that 8.1 no longer has: `use_big_decimal_serializer`, `allow_deprecated_parameters_hash_equality`, `enqueue_after_transaction_commit` (now `false` in the class, not set by load_defaults) and `to_time_preserves_timezone`.

With `load_defaults 8.1` the suite failed in three places, and these fixes made it pass:
- **`default_column_serializer = nil`**: `missing keyword: :coder` on `Notebook` boot. Fix: `serialize :preferences, coder: YAML` (keeps the stored YAML). [with-upgrade or later, because 7.0 ignores `coder:`]
- **`raise_on_assign_to_attr_readonly`**: `ActiveRecord::ReadonlyAttributeError: slug`, because the settings form resubmits the slug. Fix: drop `:slug` from `notebook_params`. Create derives the slug from the name anyway. [prep]
- **`postgresql_adapter_decode_dates`**: `TypeError: no implicit conversion of Date into String` in `daily_note_counts`. Fix: `day.to_date`, which works for both strings and Dates. [prep]

Per release:

- **7.1**
  - `add_autoload_paths_to_load_path = false`: harmless; nothing uses `require` on app paths.
  - `precompile_filter_parameters`: no visible change.
  - `dom_testing html5`: test parsing only; still passes.
  - `log_file_size`: dev/test only.
  - `run_commit_callbacks_on_first_saved_instances`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`: the app has no commit callbacks.
  - `sqlite3` strict strings: not applicable.
  - `query_log_tags_format`: query logs are not enabled.
  - `raise_on_assign_to_attr_readonly`: see above.
  - `belongs_to_required_validates_foreign_key = false`: removes the parent lookup query on save; behaviour is otherwise the same.
  - `default_column_serializer`: see above.
  - `encryption.*`: not used.
  - `marshalling_format_version 7.1` and `cache_format_version 7.1`: 7.0 servers can't read the new cache or Marshal format, so enable these only after the rollout. The production cache is the default per-host file store.
  - `generate_secure_token_on`: not used.
  - `default_headers`: adds `X-Permitted-Cross-Domain-Policies` and sets `X-XSS-Protection` to 0.
  - `debug_exception_log_level`: logging only.
  - `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: affects new signed and encrypted cookies and messages. Enable in a second deploy, after every server is on 8.1, so that a rollback can still read them.
  - `raise_on_invalid_cache_expiration_time`: apply fix B first.
  - Action View / Action Text `sanitizer_vendor` HTML5: the rich-text test still passes with fix A2.
- **7.2**
  - `yjit`: more memory; overridden by 8.1's non-local-only setting.
  - `web_image_content_types` adds WebP: no variants are used.
  - `postgresql_adapter_decode_dates`: see above.
  - `validate_migration_timestamps`: the migrations are dated 2026-10-11, which passes.
- **8.0**
  - `strict_freshness`: `ExportDownloadsController#show` `stale?` will honour only `If-None-Match` when both headers are present. The ETag is the checksum, so no practical change.
  - `Regexp.timeout = 1`: the Import CSV, DOI and email regexes are linear.
- **8.1**
  - `escape_json_responses = false` and `escape_js_separators_in_json = false`: JSON responses will contain raw `<`, `>`, `&` and U+2028. Check any JSON embedded in HTML.
  - `action_on_path_relative_redirect :raise`: all redirects are absolute or use path helpers.
  - `raise_on_missing_required_finder_order_columns`: all tables have primary keys.
  - `render_tracker :ruby` and `remove_hidden_field_autocomplete`: markup and caching details only; the tests passed.

## D. Rollout and rollback

1. **PR 1, on 7.0:** all the [prep] items plus fix B. `prep70` passes 46/46 on 7.0.8.7 (`/tmp/up/test-70-prep4.log`). The data formats are unchanged; the new things are string `completion` arguments and UTC handling in the mailer, which both versions read.
2. **PR 2, the upgrade:** rails 8.1.0, `coder: JSON`, `:polynomially_longer` and `show_exceptions :none`.
   - Queued and scheduled Sidekiq jobs from 7.0 run on 8.1 (verified for DigestJob; the others use GlobalID or integer arguments).
   - With item 19 in place, a rollback to 7.0 can still read 8.1-enqueued digest jobs.
   - Remaining risk: retries of `CitationEnrichmentJob` enqueued by 8.1 can be read by 7.0, but 7.0 would ask for `:exponentially_longer`, which it still has, so they work.
3. **PR 3 or later:** adopt defaults one at a time, using `new_framework_defaults_*` files. Put the cache, Marshal and message-serializer settings last, once rollback to 7.x is no longer needed.

## Unverified and open questions

- System tests were not run (they need a display and a browser), and production mode was not booted (assets, file cache store).
- Production values for `CITATION_PROVIDER_*` are not visible to me.
- Unknown whether any external client relies on JSON escaping, which matters for the 8.1 default.
- The choice between the documented and local reminder display (item 17) is a product decision.
- Whether existing production `notebooks.preferences` YAML contains anything other than string hashes was not checked.

---

**My notes:**

- **I haven't upgraded anything yet. This is only a plan.** Your repository is unchanged. The planner did all its testing on a throwaway copy in `/tmp/up/app` and saved the fixes as patch files: `/tmp/up/final-prep70.patch` makes the changes that work on 7.0, and `/tmp/up/final-up81.patch` is the full set for 8.1.
- **The planner wrote to your real test database.** Its first two test runs reloaded fixtures into your local `margin_notes_test` database. If anything there matters to you, reset it with `bin/rails db:test:prepare`.
- **Next step:** the planner recommends doing this in stages: first the changes that work on 7.0, then the version bump. Do you want me to start with the first stage, or go straight to the bump? Either way you'd need to decide on the reminder time display (item 17).