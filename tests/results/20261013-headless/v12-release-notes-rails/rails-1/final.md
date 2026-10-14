# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

**Verdict:** the upgrade is doable, but it needs about 16 required code and config changes first. With the gem bump alone, a production boot fails while reading `config/initializers/action_text.rb`. In the test boot, which does not eager-load, it fails at the same place. After I applied the repairs below in a disposable copy, all 46 tests passed on Rails 8.1.0 with both `load_defaults 7.0` and `load_defaults 8.1`. I made no changes to `/home/user/workspace/repo`.

## How the experiments were run
- **Isolation:** throwaway clones at `/tmp/upg/app` (upgraded) and `/tmp/upg/old` (7.0.8.7). Both used the databases `upg_mn_development` and `upg_mn_test`, Redis db 9 (`REDIS_URL=redis://localhost:6379/9`), the copies' own `tmp/storage` and `tmp/mails`, and the test or memory cache. The production-mode boot used `DATABASE_URL=postgres://$USER@%2Fvar%2Frun%2Fpostgresql/upg_mn_development`.
- **One exception:** a single read-only `rails runner` (`/tmp/upg/totime.rb`) ran in the real checkout, so it loaded schema from `margin_notes_development`. It wrote nothing.
- **Dependencies:** the bump was `bundle update rails --conservative`, logged in `/tmp/upg/bundle1.log`. It resolved rails 8.1.0, json 3.1.0 (later pinned to 2.21.2), sidekiq 6.5.12, redis 4.8.1, puma 5.6.9 and Ruby 3.3.6.
- **Saved artifacts:**
  - Changelog index: `/tmp/gc.txt`
  - Diff of every repair: `/tmp/upg/all-repairs.diff` (the copy's branch `up` has two commits: required repairs, then default adoption)
  - Test logs: baseline `/tmp/upg/base-test.log`, each repair round `/tmp/upg/test1.log`…`test8.log`
  - Defaults runs: `/tmp/upg/test-defaults81*.log`, `/tmp/upg/test-defaults70-allfixes.log`
  - Repairs tested on 7.0: `/tmp/upg/old-portable-test.log`
  - Mixed-version queue runs: `/tmp/upg/enq-*.log`, `/tmp/upg/sk-*.log`
  - Production-mode boot: `/tmp/upg/prod-boot.log`

## A. Required changes (each one observed failing on 8.1.0 with `load_defaults 7.0`)

Validation pattern unless a finding says otherwise: the named test fails on 8.1 without the repair and passes with it, and the full suite stays green on 7.0 (`old-portable-test.log`, 46/46).

**1. json 3.x is pulled in and breaks every request that reads the session cookie.**
- Observed: `ArgumentError: wrong number of arguments (given 2, expected 1)` from `json-3.1.0/lib/json/common.rb:291` via `active_support/messages/metadata.rb:129`. Most controller tests fail.
- Repair: add `gem "json", "< 3"` (it resolved to 2.21.2).
- Validation: sign in, then `GET /notes` returns 200 instead of 500.
- Open question: whether a later 8.1.x patch supports json 3. Re-check before you remove the pin.

**2. The Action Text initializer stops boot.**
- Observed: `config/initializers/action_text.rb:3: undefined method '+' for nil (NoMethodError)`. Since 7.1, `allowed_tags` is nil and the defaults are computed lazily.
- Repair: in `config.after_initialize`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. If you later adopt the HTML5 sanitizer (a 7.1 default), wrap this in `ActiveSupport.on_load(:action_view)`, because the sanitizer itself is only swapped in on that hook.
- Works on 7.0: yes.
- Validation: `NotesControllerTest` "rich text keeps collapsible excerpts and drops unsafe markup". Control: script tags are still stripped and attachments still render.

**3. Hash-style `enum` in `app/models/note.rb:10`.**
- Observed: `ArgumentError: wrong number of arguments (given 0, expected 1..2)` during eager load (`zeitwerk:check`).
- Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. This matches `Citation` and works on 7.0.

**4. `serialize :tags, JSON` (positional coder) in `note.rb:12`.**
- Observed: `ArgumentError: wrong number of arguments (given 2, expected 1)`.
- Repair: `serialize :tags, coder: JSON`.
- **Not portable to 7.0, and dangerous there.** I confirmed that 7.0 silently ignores `coder:` and writes YAML (`"---\n- x\n- \"y\"\n"`), which 8.1 then cannot read as JSON. Ship this change only together with the gem bump, or stage the upgrade through 7.1 or 7.2.
- Stored data: JSON tags written by 7.0 read back fine on 8.1 (`["a", "b"]`).

**5. `alias_attribute :highlight_color, :color` points at a store accessor (`note.rb:14`).**
- Observed: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'`.
- Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0.
- Validation: the notes edit test covers both the form radio button and the update.

**6. One route with two paths, `get "/notes", "/journal"` in `config/routes.rb:18`.**
- Observed: `ArgumentError: Wrong number of arguments (expect 1, got 2)`, so routes fail to load.
- Repair: two lines, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`.
- Route names (`notes`, `journal`) are unchanged; I checked with `rails routes` on both versions. Works on 7.0.

**7. `Rails.application.secrets` was removed.**
- Affected code: `Citation::Provider#initialize`, `config/secrets.yml`, and `citation_enrichments_controller_test.rb`.
- Observed: `NoMethodError: undefined method 'secrets'`. In production every citation lookup would fail.
- Repair: move the same ERB/YAML into `config/citation_provider.yml` and add `config.x.citation_provider = config_for(:citation_provider)`. Read it in the provider and test as `Rails.configuration.x.citation_provider`. Keep the `.to_json` quoting so values like `"00123"` and `"sample: value # keep"` stay strings.
- Works on 7.0: yes.
- Validation: the test "provider credentials from the environment reach the server unchanged" starts a fresh process. A production boot printed the keys `{url:, user:, password:}`.
- Ops: deployment env vars are unchanged.

**8. `config.action_dispatch.show_exceptions = false` in `test.rb`.**
- Observed: on 8.1, `false` no longer means "raise". The tests asserting `ActiveRecord::RecordNotFound` failed with "nothing was raised", and other errors came back as 500 pages.
- Repair: `:none`. This is test-only and 7.1+ only, so set it together with the bump.

**9. `Array#sum` of strings in `Export#generate`.**
- Observed: `TypeError: String can't be coerced into Integer` (`export.rb:42`). Every export job would fail and retry.
- Repair: `fragments.join`. Works on 7.0.
- Validation: the exports tests, and a real Sidekiq run in which `ExportJob` finished as `completed` with a file attached.

**10. `form_with(model: nil, …)` in `notes/index.html.erb:12`.**
- Observed: `Passed nil to the :model argument, expect an object or false`, so the notes list returns 500.
- Repair: drop `model: nil`. Parameter names stay unscoped. Works on 7.0.

**11. `@notes.where(notebooks: @notebook)` in `NotesController#index`.**
- Observed: `PG::UndefinedColumn: column notes.notebooks does not exist`.
- Repair: `where(notebook: @notebook)`. Works on 7.0.
- Validation: the filter and pagination tests. Control: the unfiltered list.

**12. Import preview loses annotations.**
- Cause: in 7.1+, `HashWithIndifferentAccess#stringify_keys` really stringifies the integer line keys, so `annotations[row.line]` returns nil.
- Observed: the preview silently omits the annotation (`Expected "Read <b>twice</b> & reflect"`).
- Repair: drop `.stringify_keys` in `imports/preview.html.erb:22`. Works on 7.0.

**13. Import receipt loses DOIs.**
- Cause: `Import#receipt` uses `citation[:id]`, and Citation's primary key is `doi`. On 8.1 this returns nil (on 7.0 it returned the DOI).
- Observed: receipt rows `On idleness,` with no DOI. Tests do not catch this unless they assert the CSV body.
- Repair: `citation&.doi`. Works on 7.0.

**14. `return false` inside `transaction` in `Import#apply` now commits (data integrity).**
- Observed: the invalid-rows test shows `record_counts` changed from `[0,3,0,1]` to `[1,4,1,2]`, meaning a partial import was saved.
- Repair: `transaction { save!; raise ActiveRecord::Rollback unless rows.all? { _1.note.save }; true } || false`. Works on 7.0.
- Validation: an invalid second row saves nothing. Control: the valid import still creates 2 notes, 1 citation and 1 import.
- I grepped the other `with_lock` and `transaction` blocks and found no other early return inside them.

**15. `set(wait_until: reminder_epoch)` with an Integer in `Note#schedule_reminder`.**
- Observed: `NoMethodError: undefined method 'utc' for an instance of Integer`, so reminders cannot be scheduled.
- Repair: `wait_until: Time.at(reminder_epoch)`. Works on 7.0.
- Validation: both reminders tests, plus a real Sidekiq run that delivered the reminder.

**16. `retry_on … wait: :exponentially_longer` in `CitationEnrichmentJob`.**
- Observed: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`, raised at enqueue time on the first retry.
- Repair: `:polynomially_longer` (same formula). This is 7.1+ only, so ship it with the bump.

## B. Behavior and data-format changes the old tests would not have caught

**17. `DigestJob` time zone.**
- Since 7.1, Active Job keeps a `TimeWithZone` argument's zone (the payload now carries `"time_zone":"Pacific/Auckland"`). The digest then covers the reader's local day instead of the documented UTC day.
- Observed: `"October 04"` vs expected `"October 05"`.
- Repair: in `DigestMailer`, `requested_at = requested_at.in_time_zone("UTC")`. This handles payloads from both versions; 7.0 ignores the extra key.

**18. BigDecimal job argument (rollback hazard).**
- Rails 8.1 always uses `BigDecimalSerializer`, even under `load_defaults 7.0`.
- Experiment: a job enqueued by 8.1 and run by a 7.0 worker failed with `ActiveJob::DeserializationError … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- Repair: enqueue `reading_completion.to_s`; the mailer already calls `BigDecimal(...)`.
- Verified: with the repair, a 7.0 worker delivered the digest ("100% of your notes were ready…"). Jobs enqueued on 7.0 also ran on 8.1.

**19. `Note#next_day_reminder_at`.**
- In 8.1, `to_time` keeps the zone instead of the offset.
- Observed: 8.1 gives `2026-11-01T08:00:00-05:00`, while 7.0 gives `09:00:00-04:00`. It is the same instant, so the postponed epoch is unchanged, but the displayed wall time differs across a DST change.
- In 8.1 the setting is deprecated, so under `load_defaults 7.0` there is no config way back.
- Repair to keep the documented behavior: `reminder_at.to_time.localtime(reminder_at.utc_offset) + 86_400`. Works on 7.0.
- Product alternative: accept the zone behavior and update the comment, view and test.

**20. Sidekiq.**
- The built-in adapter still works in 8.1 but logs: `DEPRECATION WARNING: The built-in 'sidekiq' adapter is deprecated and will be removed in Rails 8.2. Please upgrade 'sidekiq' gem to version 7.3.3 or later`.
- This is not required for 8.1. Plan it as a separate upgrade, because it brings:
  - `redis-client`, where `sadd` returns an Integer, so `if 0` in `User#request_digest` becomes truthy;
  - different error classes from `Redis::BaseError` and `Redis::CannotConnectError`;
  - strict arguments, which reject the symbol-key hash in `Notebook#request_export`.
- Active Job's per-job `enqueue_after_transaction_commit` defaults to false in 8.1 (checked in the source), so the enqueue-under-lock rollback design is kept.

## C. New framework defaults, by release

The app stays on `load_defaults 7.0` for everything below unless you adopt a default. I tested all of them at once with `load_defaults 8.1`. Three repairs were needed (marked **repair** below); after them the suite was 46/46 on both default sets.

| Release | Default | Kept old? | What changes here if adopted |
|---|---|---|---|
| 7.0.10 | none | – | – |
| 7.1 | `default_column_serializer = nil` | yes | **Repair:** boot fails with `missing keyword: :coder` at `notebook.rb:7`. Use `serialize :preferences, coder: YAML`; existing YAML rows still read. |
| 7.1 | `raise_on_assign_to_attr_readonly` | yes | **Repair:** settings update fails with `ActiveRecord::ReadonlyAttributeError: slug`. Drop `:slug` from `notebook_params`; the hidden field is harmless and create still generates the slug. |
| 7.1 | `raise_on_invalid_cache_expiration_time` | yes | **Repair:** an expired export makes `/notebooks/:id/exports` fail with `Cache expiration time is invalid, cannot be negative: -60.0`. Clamp with `expires_in: [export.expires_at - Time.current, 1.second].max`. This keeps the tested stale-cache behavior; a `cache_if` alternative failed the existing test. Under the old value it only reports the error. |
| 7.1 | `active_job.use_big_decimal_serializer` | – | No longer configurable in 8.1; see item 18. |
| 7.1 | `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata` | yes | Cookies and session format change. Old 7.0 servers cannot read the new metadata. Adopt only after every server runs 8.1. |
| 7.1 | `marshalling_format_version 7.1` | yes | Changes the Marshal format of cached Active Record objects. Adopt after the rollout. |
| 7.1 | `sanitizer_vendor` (Action View and Action Text, HTML5) | yes | Rich-text sanitizing may differ slightly. Check that `<details>` survives (see item 2). |
| 7.1 | `dom_testing_default_html_version :html5` | yes | Tests passed. |
| 7.1 | `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances…`, `before_committed_on_all_records` | yes | No `after_commit` callbacks in the app; no effect. |
| 7.1 | `commit_transaction_on_non_local_return` | – | Always on in 8.1; see item 14. |
| 7.1 | `belongs_to_required_validates_foreign_key` | yes | Drops the parent-existence query on save. Note uses `validate: true` on `citation`. Tests passed. |
| 7.1 | `generate_secure_token_on`, encryption hash and SHA1 settings, `sqlite3…` | yes | Not used here (no `has_secure_token`, no `encrypts`, PostgreSQL). |
| 7.1 | `allow_deprecated_parameters_hash_equality false`, `allow_deprecated_singular_associations_name false` | yes | No usages found by grep. |
| 7.1 | `precompile_filter_parameters`, `query_log_tags_format`, `debug_exception_log_level`, `log_file_size` | yes | Logging only. |
| 7.2 | `postgresql_adapter_decode_dates` | yes | **Repair:** the activity report fails with `TypeError: no implicit conversion of Date into String` (`notebook.rb:40`). Use `Date.iso8601(day.to_s)`. |
| 7.2 | `enqueue_after_transaction_commit` | – | Deprecated in 8.x; the per-job default is false. Keep it off: the app relies on a failed enqueue rolling back. |
| 7.2 | `web_image_content_types` adds webp | yes | WebP attachment previews are no longer converted to PNG. |
| 7.2 | `validate_migration_timestamps` | yes | Existing timestamps (2026…) are valid. |
| 7.2 | `yjit` | yes | Memory and CPU only. |
| 8.0 | `to_time_preserves_timezone :zone` | – | Effectively forced in 8.1; see item 19. |
| 8.0 | `strict_freshness` | yes | `ExportDownloadsController` `stale?(etag:, last_modified:)`: when `If-None-Match` is sent, `If-Modified-Since` is ignored. The blob is immutable, so the effect is benign (source-based). Validate: a request with a matching ETag and an old If-Modified-Since gets 304. |
| 8.1 | none listed by the tool | – | – |

## D. Rollout plan
1. **Release 1, on 7.0:** ship the repairs that work on both versions: items 2, 3, 5, 6, 7, 9–15, 17, 18, 19, plus the slug, decode-dates and cache-clamp fixes. On 7.0 they passed 46/46, and the decode-dates and cache-clamp fixes passed under 7.0 defaults. Release 1 also stops 7.0 from writing BigDecimal payloads that a later version would read differently.
2. **Release 2:** the Rails 8.1 bump plus `json < 3`, items 4, 8 and 16, and `serialize :preferences, coder: YAML`.
   - Drain the queues first, or accept mixed processing. 7.0 payloads run on 8.1, which I verified for DigestJob, NoteReminderJob and ExportJob.
   - Rollback is safe for queued jobs once item 18 is in.
   - The tags data format is unchanged.
3. **Release 3+:** adopt defaults one at a time with `new_framework_defaults` files. Put the cookie and cache formats (`message_serializer`, metadata, `marshalling_format_version`) last, after no 7.0 server remains.
4. **Later, separately:** Sidekiq 7.3.3+ (item 20).

## Unverified and still to check
- System tests (`bin/rails test:system`) were not run.
- The `strict_freshness` 304 behavior and the HTML5-sanitizer handling of `<details>` were not exercised under adopted defaults.
- I did not walk every one of the 1,579 changelog entries by hand. I used `/tmp/gc.txt` as an index plus the runtime failures above, so lower-traffic paths may still hide issues: the Action Cable connection, mail views, and Active Storage blob rendering.
- The behavior on the reverted 7.0 code of cookies issued by 8.1 under `load_defaults 7.0` was not tested.

---

**What I did and what's next:** The upgrade skill I ran only produces a plan, so I haven't changed your repository. The fixes above were tested in throwaway copies under `/tmp/upg`.

The biggest risk is item 14: on 8.1, an import with invalid rows would save part of its data instead of rolling back. Item 4 also must not ship on 7.0, because 7.0 would quietly write YAML into a column that 8.1 reads as JSON.

If you want, I can carry out Release 1 (the fixes that work on both versions) as a first branch.