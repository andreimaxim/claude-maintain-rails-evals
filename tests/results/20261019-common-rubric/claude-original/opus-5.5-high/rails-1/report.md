# Upgrading Rails from 7.0.8.7 to 8.1.0 in Margin Notes

On 8.1.0 the app does not boot as it stands. With 20 changes and a `json` pin, the full test suite passes. Sixteen of those changes also work on 7.0.8.7 and should ship first.

All experiments ran in disposable copies under `/tmp/upg`, each with its own PostgreSQL databases and its own Redis on port 6390. Nothing in `/home/user/workspace/repo` was changed: `git status` is clean and it is still at 9938031.

**Labels used below:**
- **[S]**: concluded from reading the versioned gem source or changelogs (rails 7.1.5.2, 7.2.2.2, 8.0.3, 8.1.0, the installed 7.0.8.7, and sidekiq 6.5.12).
- **[E]**: run in a disposable copy (commands and logs in section 7).
- **[P]**: proposed check, not yet run.

## Summary

- **Boot on 8.1.0, unchanged:** fails. The first failure is the Action Text initializer, then `enum`, then `serialize`, then the routes. After those boot fixes, 25 of the 46 tests fail (19) or error (6) **[E]**.
- **Fix set:** 20 changes plus a `json` pin. With all of them, the suite passes on 8.1.0: 46 runs, 0 failures, 0 errors **[E]**.
  - **Before the bump:** 16 of the changes also work on 7.0.8.7. Applied together on 7.0 they pass the suite with no deprecation warnings, and `bin/rails routes` output is identical **[E]**.
  - **With the bump:** 3 changes depend on APIs added in 7.1 or later. A fourth item, `:polynomially_longer`, is needed with the bump only if you don't use the Proc form of A16 before it.
  - **Gemfile:** `json` must be pinned below 3.
- **What the tests do not catch:**
  - Jobs that cross versions during a mixed rollout or a rollback.
  - How long cache entries live.
  - The retry backoff path in a real worker.
  - The rollback hazard for stored rich-text attachment references if newer framework defaults are adopted.

  Separate checks covered these (section 4).
- **Framework defaults:** keep `config.load_defaults 7.0` for the upgrade itself. Adopt newer defaults later, one at a time; several have hazards specific to this app (section 5).

---

## 1. Changes that can land before the bump (they also work on 7.0.8.7)

All sixteen were applied together in a copy running 7.0.8.7: 46 runs, 0 failures, no deprecation output **[E]**. Ship them on 7.0 first. Their behaviour on 7.0 is unchanged unless the item says otherwise.

**A1. Citation provider settings read from `Rails.application.secrets`**
- **Where:**
  - `/home/user/workspace/repo/app/models/citation/provider.rb:13`
  - `/home/user/workspace/repo/config/secrets.yml`
  - `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb` (lines 45, 116-121)
- **What breaks:** `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2. On 8.1 it raises NoMethodError **[S][E]**.
- **Change:**
  - Move the file to `config/citation_provider.yml`. Keep the `.to_json` quoting so values like `"00123"` stay strings.
  - In `application.rb`, add `config.x.citation_provider = config_for(:citation_provider)`.
  - Make the provider's default `Rails.configuration.x.citation_provider.to_h`, and update the test helper to match.
  - Delete `secrets.yml`.
- **Tests catch it:** yes.

**A2. Action Text allowed-tags initializer**
- **Where:** `/home/user/workspace/repo/config/initializers/action_text.rb`
- **What breaks:** from 7.1, `ActionText::ContentHelper.allowed_tags` defaults to `nil`, so `+=` raises NoMethodError at boot **[S][E]**.
- **Change:** assign the whole list: `Rails::HTML::SafeListSanitizer.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`
- **Tests catch it:** yes (boot fails).

**A3. Keyword form of `enum`**
- **Where:** `/home/user/workspace/repo/app/models/note.rb:10`
- **What breaks:** `enum status:` is deprecated in 7.2 and an ArgumentError in 8.0 **[S][E]**.
- **Change:** `enum :status, { draft: 0, ready: 1 }, prefix: true`. This form already exists in 7.0.
- **Tests catch it:** yes.

**A4. `alias_attribute :highlight_color, :color`**
- **Where:** `/home/user/workspace/repo/app/models/note.rb:14`
- **What breaks:** `color` is a store accessor, not an attribute. Deprecated in 7.1; raises ArgumentError from 7.2 **[S][E]**.
- **Change:** define `highlight_color` and `highlight_color=` as plain methods that delegate to `color`.
- **Tests catch it:** yes.

**A5. Two paths in one route call**
- **Where:** `/home/user/workspace/repo/config/routes.rb:586` (`get "/notes", "/journal", ...`)
- **What breaks:** several paths in one route call are deprecated in 8.0 and an ArgumentError in 8.1. That breaks boot wherever routes are loaded eagerly **[S][E]**.
- **Change:** two separate `get` lines. On 7.0, `bin/rails routes` output is identical before and after **[E]**.
- **Tests catch it:** only indirectly.

**A6. `fragments.sum` on strings**
- **Where:** `/home/user/workspace/repo/app/models/export.rb:42`
- **What breaks:** already deprecated in 7.0. From 7.1, Ruby's own `Array#sum` raises TypeError, so every export job fails **[S][E]**.
- **Change:** `fragments.join`
- **Tests catch it:** yes.

**A7. `form_with(model: nil, ...)`**
- **Where:** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`
- **What breaks:** from 8.0 this raises "Passed nil to the :model argument", with no deprecation in 7.x. The notes list returns 500 **[S][E]**.
- **Change:** remove `model: nil`.
- **Tests catch it:** yes.

**A8. Import preview reads annotations with Integer keys**
- **Where:** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22,42-44` (`annotations.stringify_keys` read with Integer keys)
- **What breaks:** from 8.0, `stringify_keys` on a HashWithIndifferentAccess turns Integer keys into strings. `annotations[row.line]` then returns nil and annotations silently disappear from the preview **[S][E]**.
- **Change:** use `row.annotation` directly.
- **Tests catch it:** yes.

**A9. `citation[:id]` on a table keyed by `doi`**
- **Where:** `/home/user/workspace/repo/app/models/import.rb:68`
- **What breaks:** `citations` has primary key `doi` and no `id` column. Deprecated in 7.1; returns nil from 7.2, which empties the DOI column of the receipt CSV **[S][E]**.
- **Change:** `note.citation_doi`
- **Tests catch it:** yes, once the earlier failures are fixed.

**A10. `return false` inside `transaction`**
- **Where:** `/home/user/workspace/repo/app/models/import.rb:53-57`
- **What breaks:**
  - 7.0 rolls back on an early return.
  - 7.1 with 7.0 defaults rolls back and warns.
  - From 7.2 it **commits**, which saves a partial import **[S][E]**.
- **Change:** `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`, and return a flag set inside the block.
- **Tests catch it:** yes (`assert_nil Note.find_by(title: "Adam Bede")`).

**A11. Integer passed to `set(wait_until:)`**
- **Where:** `/home/user/workspace/repo/app/models/note.rb:61` (`set(wait_until: reminder_epoch)`)
- **What breaks:** deprecated in 7.1. From 7.2 a numeric `scheduled_at` is no longer converted, and `serialize` calls `.utc` on the Integer, which raises NoMethodError **[S][E]**.
- **Change:** `wait_until: Time.at(reminder_epoch)`. The enqueue timestamp is unchanged; the tests assert `:at`.
- **Tests catch it:** yes.

**A12. Plural name for a singular association in `where`**
- **Where:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12` (`where(notebooks: @notebook)`)
- **What breaks:** deprecated in 7.1 and removed in 7.2. PostgreSQL then reports "column notes.notebooks does not exist" **[S][E]**.
- **Change:** `where(notebook: @notebook)`
- **Tests catch it:** yes.

**A13. DigestJob receives a BigDecimal**
- **Where:** `/home/user/workspace/repo/app/models/user.rb:41`
- **What breaks:** from 7.2, BigDecimal arguments always use `BigDecimalSerializer`, which a 7.0 worker cannot read. A real Sidekiq 6.5.12 worker on 7.0 raised `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` and put the job in the retry set **[E]**.
- **Change:** pass `reading_completion.to_s`; the mailer already calls `BigDecimal(...)`. The payload is then identical on both versions **[E]**.
- **Tests catch it:** no. This is a mixed-version and rollback issue.

**A14. Digest day boundary depends on which version enqueued the job**
- **Where:** `/home/user/workspace/repo/app/mailers/digest_mailer.rb:7-9`
- **What breaks:** from 7.1, `TimeWithZoneSerializer` stores `time_zone`. A digest enqueued on 8.1 covers the reader's **local** day, while one enqueued on 7.0 covers the UTC day. The UI and the reservation key both say "UTC day" **[S][E]**.
- **Change:** add `requested_at = requested_at.in_time_zone("UTC")` in the mailer. This gives the same result for payloads written by either version.
- **Tests catch it:** partly (the subject-date assertion). The mixed-payload case is only caught by the probe.

**A15. Reminder preview offset**
- **Where:** `/home/user/workspace/repo/app/models/note.rb:43-45` (`reminder_at.to_time + 86_400`)
- **What breaks:** 8.1 always uses `to_time_preserves_timezone = :zone`. The preview then shows `08:00-05:00` instead of the documented `09:00-04:00`. The stored epoch is identical (1793538000) **[E]**.
- **Change:** either:
  - use `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`, which keeps the documented behaviour on both versions **[E]**; or
  - decide the new display is preferred, and update the comment and test.
- **Tests catch it:** yes (the `datetime=` assertion).

**A16. `retry_on` with `wait: :exponentially_longer`**
- **Where:** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`
- **What breaks:** deprecated in 7.1. In 8.1, a retry raises `RuntimeError: Couldn't determine a delay` **[E]**. Then:
  - the `retry_on` block never runs;
  - the citation stays `pending`, which blocks "Fetch again";
  - the job falls through to Sidekiq's own retries.
- **Change:** either:
  - to land it on 7.0, use `wait: ->(executions) { executions**4 + 2 }`, which drops the 15% jitter; or
  - use `:polynomially_longer` in the bump commit (B3).
- **Tests catch it:** yes (the "stays unavailable" test).

## 2. Changes that must land in the same commit as the bump (they do not work on 7.0.8.7)

**B1. Keyword coder for `serialize`**
- **Where:** `/home/user/workspace/repo/app/models/note.rb:12` and `/home/user/workspace/repo/app/models/notebook.rb:7`
- **Change:** `serialize :tags, coder: JSON` and `serialize :preferences, coder: YAML`.
- **Why it waits for the bump:** the positional form is deprecated in 7.1 and an ArgumentError from 7.2. The `coder:` keyword does not exist on 7.0 **[S]**.
- **Stored data:** the raw column contents are byte-identical between 7.0 and 8.1 **[E]**. Checked values:
  - `"---\nexport_heading: 'Reading: notes # 1'\n"`
  - `["Victorian","marriage","é"]`
  - the jsonb settings
- Making YAML explicit also protects against a later adoption of the 7.1 default `default_column_serializer = nil`.

**B2. Test environment exceptions**
- **Where:** `/home/user/workspace/repo/config/environments/test.rb:238`
- **Change:** `show_exceptions = :none`.
- **Why:** from 7.2, `false` falls through to showing all exceptions, so every `assert_raises(RecordNotFound)` fails **[S][E]**.
- **Why it waits for the bump:** on 7.0, `:none` is a truthy value and would also show exceptions **[S]**.

**B3. Retry delay name.** Use `:polynomially_longer` (accepted from 7.1) if A16's Proc form was not used.

**B4. Gemfile**
- **Change:** `gem "rails", "8.1.0"`, and add `gem "json", "< 3"`.
- **Why the `json` pin:** without it Bundler resolves `json 3.0.2`. Its `JSON.parse` only accepts keyword options, while ActiveSupport 8.1.0's decoder passes a positional hash, so every JSON column read raises ArgumentError **[E]**.
- **Resolved with the pin [E]:** rails 8.1.0, action_text-trix 2.1.19, json 2.21.2, bigdecimal 4.1.3, rack 2.2.24, rackup 1.0.1, rack-session 1.0.2, webrick 1.9.2, useragent 0.16.11, net-imap 0.6.8.
- **Unchanged:** sidekiq 6.5.12, redis 4.8.1, puma 5.6.9, minitest 5.27.0, concurrent-ruby 1.3.4.
- **Ruby:** 3.3.6 meets railties' `>= 3.2.0` **[S]**.

**B5. `db/schema.rb` churn**
- Under 8.1 the dump changes in three ways:
  - the header becomes `Schema[8.1]`;
  - it adds `pg_catalog.plpgsql`;
  - columns are listed alphabetically.

  After sorting, nothing else differs **[E]**.
- Migrations replay cleanly on a fresh database **[E]**. There are no data migrations.

## 3. Upgrade path

1. Deploy A1–A16 on 7.0.8.7. From then on, every job written by either version can be read by the other.
2. **Bump.** Either go straight to 8.1.0 with B1–B5, or go through 7.1 → 7.2 → 8.0 → 8.1 to see deprecations as you go.
   - A run on 7.1.5.2 with only A2 applied printed exactly the expected deprecations **[E]**: secrets, show_exceptions, positional coder, `alias_attribute`, singular association, `read_attribute(:id)`, transaction return, numeric `scheduled_at`, BigDecimal primitive, and `:exponentially_longer`.
   - Some changes break with no warning first: A2 (7.1), A6 (7.1), A7 (8.0), A8 (8.0), and the `json` 3 incompatibility.
   - Watch for deprecation warnings in `log/*.log` and test output. `disallowed_deprecation_warnings` is empty, so none of them fail the suite.
3. One deprecation remains on 8.1: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2" **[E]**.

## 4. Rollout, queued work, stored data, and rollback

**Jobs across versions.** One probe serialized and deserialized all four job types, and one real Sidekiq worker ran per direction **[E]**.

| Payload written by | 7.0 worker | 8.1 worker |
|---|---|---|
| 7.0 (any job) | OK | OK. A real Sidekiq 6.5.12 worker booted on Rails 8.1.0 and processed both DigestJob variants. |
| 8.1, original DigestJob with BigDecimal | **Fails** (DeserializationError, retries) | OK |
| 8.1, DigestJob after A13, NoteReminderJob, CitationEnrichmentJob | OK. Extra keys (`time_zone`, `scheduled_at`) are ignored and the time falls back to UTC. | OK |

- **Scheduled reminders** can sit in Sidekiq's schedule set across a deploy. Their payload (a Note GlobalID) loads on both versions **[E]**.
- **Retries:** the `exception_executions` key format is the same in both versions **[S]**.
- **ExportJob** is a native Sidekiq job and is not affected.
- **If A13 is not applied:**
  - Deploy workers before web.
  - On rollback, drain DigestJob from the queue and the retry set before the 7.0 workers take over.
  - Otherwise digests fail for up to Sidekiq's 25 retries. The reader's Redis reservation lasts 2 days.
- **Enqueuing inside `with_lock`** (`Citation#request_enrichment`, `Note#schedule_reminder`):
  - In 8.1, `enqueue_after_transaction_commit` defaults to false, so the documented behaviour (a failed enqueue rolls back) is preserved **[S]**.
  - It only changes if you set it per job, or if you adopt the 7.2 defaults while staying on 7.2.
- **Cookies and signed IDs:** with `load_defaults 7.0`, session cookies, rich-text attachment SGIDs and signed blob IDs work in both directions between 7.0 and 8.1 **[E]**.
- **Cache:** 8.1 reads cache format 7.0 **[S]**. You can still clear the file-store fragments on deploy.
- **Export page cache:** `/home/user/workspace/repo/app/views/exports/_export.html.erb:26` passes a negative `expires_in` for expired exports.
  - 7.0 treats such an entry as already expired.
  - 8.1 logs `ERROR ArgumentError: Cache expiration time is invalid` and caches the fragment **with no expiry** **[E]**.
  - The cached content is final, so today this is mostly noise in the logs and error reporter. It becomes a 500 if the 7.1 default `raise_on_invalid_cache_expiration_time` is adopted.
  - Recommended (works on 7.0): pass `expires_in` only while `export.downloadable?`.
- **Export Markdown:** `to_plain_text` output is identical between 7.0 and 8.1 for paragraphs, lists, quotes, links, details, headings, entities and attachments **[E]**.
- **Rollback:** after step 1 of the upgrade path, rolling back from 8.1 to 7.0 needs no data repair. There are no schema changes and all formats are compatible **[E]**. Only the Gemfile, the lockfile and the B items need reverting.

## 5. Optional default adoption (later, one at a time; not required for 8.1)

These come from the 8.1 `load_defaults` source **[S]**, with the hazards specific to this app.

**7.1 `use_message_serializer_for_metadata` and `message_serializer`: rollback hazard**
- With these on, an attachment SGID generated on 8.1 made 7.0's `SignedGlobalID.parse` raise NoMethodError **[E]**. Session cookies still worked **[E]**.
- SGIDs are stored inside `action_text_rich_texts.body`. After a rollback, any note whose body was saved with an attachment while these settings were on could fail to render. The parse error was run; the full render path and the exact set of affected notes are inferred, not run.
- Adopt only after the rollback window has closed.

**Other 7.1 defaults**
- **`raise_on_assign_to_attr_readonly`:** the notebook settings form re-submits `slug` (`notebooks_controller.rb:40` and the hidden field in `_form.html.erb`), so saving settings would raise. Prepare by not permitting `:slug` (works on 7.0) and adjusting the test.
- **`raise_on_invalid_cache_expiration_time`:** the exports page returns 500 (section 4).
- **`default_column_serializer = nil`:** covered by B1.
- **`cache_format_version 7.1`:** 7.0 cannot read the new format. Clear the cache on rollback.
- **HTML5 sanitizer vendors and `dom_testing_default_html_version`:** re-run the details/summary and script-stripping tests.

**7.2 defaults**
- **`postgresql_adapter_decode_dates`:** `Notebook#daily_note_counts` (`notebook.rb:40`) calls `Date.iso8601(day)` on what would now be a Date, which raises TypeError. Prepare with `day.to_date` (works on 7.0) **[S]**.
- **`enqueue_after_transaction_commit`:** only relevant if you pause on 7.2 and adopt its defaults (section 4).

**Other 8.0 and 8.1 defaults.** No app-specific hazard found; check each with the full suite:
- `strict_freshness` (`ExportDownloadsController#stale?`)
- `Regexp.timeout`
- `action_on_path_relative_redirect`
- JSON escaping
- YJIT

## 6. Dependencies to keep in mind

**Sidekiq 6.5.12 and redis 4.8.1**
- They work on 8.1.0 **[E]**, but Rails 8.2 removes the built-in Sidekiq adapter.
- Moving to Sidekiq 7.3.3+ (which uses redis-client) is a separate project with known traps **[S]**, not run:
  - `redis.sadd` returns 0 or 1, and `0` is truthy in Ruby, which breaks digest de-duplication (`user.rb:38`).
  - `rescue Redis::BaseError` (`notebook.rb:28`) will no longer catch the new client's errors.
  - Strict argument checking rejects `{ format: "markdown" }` with symbol keys (`notebook.rb:26`).

**Rack** stays at 2.2.24, because Sidekiq 6.5 requires `rack ~> 2.0`. `bin/citation-provider`'s `require "rack/handler/puma"` and Puma 5 are therefore unaffected.

**Trix**
- Action Text 8.1 gets `trix.css` from action_text-trix 2.1.19, while the layout still loads `vendor/javascript/trix-1.3.5.js`. The stylesheet and JavaScript versions no longer match.
- Assets precompile cleanly on 8.1 **[E]**. There are no system tests (`test/system` is empty), so the editor's look and behaviour are unverified.
- Optional: pin `@rails/actiontext` to `actiontext.esm.js` and move to Trix 2.

**Other pins**
- Keep `minitest ~> 5.25`; whether 8.1.0 works with Minitest 6 is unverified.
- The `concurrent-ruby 1.3.4` pin can probably be lifted after the upgrade; also unverified.

## 7. Experiments

Everything is in `/tmp/upg`. The working repo is untouched (`git status` clean), and the default Redis on port 6379 was left empty.

**Isolation**
- Each copy was cloned from the repo at 9938031 and had its own database names in `config/database.yml`: `mn_upg70_*`, `mn_prep70_*`, `mn_upg71_*`, `mn_upg81_*`.
- Separate Redis: `redis-server --port 6390 --save ""` (now shut down), with `REDIS_URL=redis://127.0.0.1:6390/{0,3,4}`.
- Storage and cache were under each copy's `tmp/`.
- Bundles were installed to `/tmp/upg/bundle71` and `/tmp/upg/bundle81`.
- For the cookie checks, a shared random dev/test secret was written to `tmp/development_secret.txt` (7.0) and `tmp/local_secret.txt` (8.1).
- Environment script: `/tmp/upg/env.sh`.

**Copies and commits**
- `/tmp/upg/base70`: the unchanged app.
- `/tmp/upg/prep70`: A1–A16 on 7.0.
- `/tmp/upg/v71`: 7.1.5.2 with only A2 (commits f80a3c0, aede5dd).
- `/tmp/upg/v81`, commits:
  - 4cf28bb: Gemfile only
  - eec0484: boot fixes
  - c304137: `json` pin
  - dbcb019 and 0649a63: behaviour fixes
  - f3775cb: environment-toggled 7.1 message defaults, for the probe only
- The full app diff for 8.1 is in `/tmp/upg/v81-app-changes.patch`.

**Logs** (all in `/tmp/upg/logs/`)

| Run | Result | Log |
|---|---|---|
| 7.0 baseline | 46 runs, 0 failures; one Enumerable#sum deprecation | `base70-test.log` |
| 8.1 unmodified | Boot fails in the Action Text initializer | `v81-unmodified-boot.log` |
| 8.1 with json 3 | ArgumentError in `JSON.parse` | `v81-bootfixed-test.log` |
| 8.1 after boot fixes | 19 failures, 6 errors | `v81-bootfixed-json2-test.log` |
| 8.1 with all fixes | 46 runs, 0 failures, 0 errors | `v81-allfixes2-test.log` |
| Preparatory changes on 7.0 | 46 runs, 0 failures, 0 errors | `prep70-test.log` |
| 7.1 deprecations | Deprecations listed in section 3 | `v71-original-test.log` |
| Routes | Identical on 7.0 before and after A5 | `base70-routes.txt`, `prep70-routes.txt`, `v81-routes.txt` |
| Job payload matrix | See section 4 | `aj-load-70.txt`, `aj-load-81.txt`; payloads in `/tmp/upg/payloads/` |
| Real Sidekiq workers | See section 4 | `sidekiq-worker-70.log`, `sidekiq-worker-81.log` |
| Plain text | Identical | `plain-70.txt`, `plain-81.txt` |
| Assets | Precompile cleanly | `*-assets.log` |
| Migrations | Replay cleanly | `v81-migrate.log` |

Probe scripts are in `/tmp/upg/probes/`. The cache, transaction-return, `read_attribute(:id)`, HashWithIndifferentAccess, `to_time` and retry-delay probes were inline `bin/rails runner` commands; their results are quoted above.

The databases `mn_upg70_test`, `mn_prep70_test`, `mn_upg71_test`, `mn_upg81_test` and `mn_upg81_development` are still on the local PostgreSQL. Drop them when you no longer need them.

## 8. Unverified points and open questions

- **[P] Browser check of the editor:** Trix 1.3.5 JavaScript with Trix 2.1 CSS, and the `actiontext.js` UMD import. Create and edit a note with a link, an attachment and a details block. No system tests exist.
- **[P] Production-mode boot** with real credentials, `RAILS_LOG_TO_STDOUT`, and a staging Sidekiq. Sidekiq's logger broadcast was only exercised in test mode.
- **Order of the Action Text allowlist:** on 8.1, Action Text replaces its sanitizer in `after_initialize`, while the replacement initializer reads `Rails::HTML::SafeListSanitizer` directly. That works with the 7.0 defaults; check again if `action_text.sanitizer_vendor` changes.
- **Does any Rails 8.1.x patch release support json 3?** Not checked, since the request was for exactly 8.1.0.
- **Do any production hosts have their own `secrets.yml` or `secret_key_base` source** that moving away from `Rails.application.secrets` would affect? The repo shows none.
- **A15 is a product decision:** keep the fixed-offset preview, or show local wall-clock time?
- **How long the rollback window lasts** decides when the 7.1 message defaults are safe to adopt.

---

**After the planner finished, I checked:**
- **Working repo:** clean and still at 9938031.
- **Isolated Redis:** the instance on port 6390 is shut down.
- **Logs:** the log files listed in section 7 exist.
- **Test results:**
  - `base70-test.log` and `prep70-test.log` both show 46 runs, 325 assertions, 0 failures, 0 errors.
  - `v81-allfixes2-test.log` shows 46 runs, 340 assertions, 0 failures, 0 errors.
  - `v81-bootfixed-json2-test.log` shows 19 failures and 6 errors.
  - `v81-unmodified-boot.log` shows the boot failure in `config/initializers/action_text.rb:3`.

**Still to explain:** the 8.1 run has 15 more assertions than the 7.0 runs (340 against 325) with the same 46 tests. The plan doesn't say why. Compare `/tmp/upg/v81-app-changes.patch` with the tests in the prepared 7.0 copy (`/tmp/upg/prep70`) to see whether the 8.1 copy changed or added test assertions. That shows whether the two passing runs check the same things.
