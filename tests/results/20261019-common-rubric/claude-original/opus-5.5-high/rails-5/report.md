# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

## Summary

The upgrade is feasible. Ruby 3.3.6, PostgreSQL 15, pg 1.6.0, Puma 5.6.9, Sidekiq 6.5.12 and rack 2.2 all work on 8.1.0. In a disposable copy, the unchanged app does not boot on 8.1.0: 46 of 46 tests error. With 17 code/config changes plus one gem pin, the full suite passes (46 runs, 0 failures).

- **Code that can ship first:** 13 of those changes also work on 7.0.8.7. I ran the full suite on 7.0.8.7 with them applied and it passed. One more preparatory change (sending the digest completion as a string) was added later. It was checked only in the worker experiments below, not in that suite run.
- **Changes the tests would not show:** rollback and mixed-version risks in queued jobs, signed messages and stored data. I tested these with Sidekiq workers and web servers on both versions sharing one database and one Redis.
- **Requested version:** 8.1.0 needs `json < 3`, and four later 8.1 patches exist, including security releases. Details are in D1 and D2.

## How the evidence was gathered

- **Source:** I read the unpacked gems (activesupport, activerecord, activejob, actiontext, actionpack, railties, activestorage) for 7.1.6, 7.2.4, 8.0.5.1 and 8.1.4 in `/tmp/mn-upgrade/src/`, plus 8.1.0 and 7.0.8.7 as installed.
- **Executed:** everything under `/tmp/mn-upgrade/`. The resources were isolated:
  - its own PostgreSQL 15 cluster (`/tmp/mn-upgrade/pgdata`, socket `/tmp/mn-upgrade/pgsock`, port 55432);
  - its own Redis on port 56379;
  - a separate gem home (`GEM_HOME=/tmp/mn-upgrade/gems`);
  - storage symlinked to `/tmp/mn-upgrade/storage` and mail written to `/tmp/mn-upgrade/mails`;
  - a fixed `SECRET_KEY_BASE`.
  - The environment is in `/tmp/mn-upgrade/env.sh`. The shared Postgres and Redis were not touched, and `/home/user/workspace/repo` is still clean at 9938031.
- **Copies:**

| Copy | Branch | Purpose |
|---|---|---|
| `/tmp/mn-upgrade/repo` | `exp-rails-8.1.0`, one commit per fix | 8.1.0 build |
| `/tmp/mn-upgrade/repo` | `exp-load-defaults-8.1` | 8.1 build with all new defaults |
| `/tmp/mn-upgrade/repo70` | `prep-on-7.0` | 7.0.8.7 with the preparatory changes |
| `/tmp/mn-upgrade/repo71` | `exp-rails-7.1.6` | collect 7.1 deprecation warnings |

- **Resolved dependencies:** `/tmp/mn-upgrade/logs/Gemfile.lock.8.1.0` and `Gemfile.lock.7.1.6`. The command was `bundle lock --update rails`, which updated only the Rails gems and added new dependencies. Gems already in the lockfile kept their versions (rack 2.2.24, sidekiq 6.5.12, puma 5.6.9, importmap/turbo/stimulus/sprockets/jbuilder).
- **Logs:** all in `/tmp/mn-upgrade/logs/`:

| Check | Log | Result |
|---|---|---|
| Baseline on 7.0.8.7 | `baseline-7.0.8.7-test.log` | 46 runs, 325 assertions, all pass |
| Unchanged app on 8.1.0, then one fix at a time | `8.1.0-boot.log`, `8.1.0-test-run1.log` … `8.1.0-test-run8.log` | run 8: all pass |
| Preparatory changes on 7.0.8.7 | `prep-on-7.0.8.7-test.log` | all pass, no deprecation warnings |
| 7.1.6 deprecations | `7.1.6-test-unchanged-app.log` | |
| `load_defaults 8.1` | `8.1.0-load_defaults-8.1-test*.log` | |
| Production boot and asset compile | `8.1.0-prod-boot.log` | |
| Cross-version workers | `sidekiq-*.log`, `redis-after-enqueue-*.txt` | |
| Signed message formats | `probe-*.json`, `probe-7.0-reads-8.1-*.log` | |
| Cross-version sessions | `session-cross-*.txt` | |
| Browser | `browser-*.txt` | |
| Rich text and time zones | `text-7.0.json`, `text-8.1.json` | |

- **Scripts:** `/tmp/mn-upgrade/scripts/`.

## Required changes, part A: ship first on 7.0.8.7

All of these also work on 7.0.8.7, and most were checked in that suite run; A14 was checked only in the worker experiments. Shipping them first means the version bump carries no behaviour change.

| # | Affected code | What breaks and when | Fix | Validation |
|---|---|---|---|---|
| A1 | `config/initializers/action_text.rb:3` | From 7.1, `ContentHelper.allowed_tags` starts as nil, so `+=` stops the app booting. Seen on 7.1.6 and 8.1.0. | Set `allowed_tags = (allowed_tags \|\| sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]` | App boots; the "collapsible excerpts" test passes on both versions, and also with `load_defaults 8.1` (HTML5 sanitizer). |
| A2 | `app/models/note.rb:10`, `enum status: {...}, _prefix: true` | Old syntax is removed in 8.0; ArgumentError when the class loads. | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Suite passes |
| A3 | `note.rb:15`, `alias_attribute :highlight_color, :color` | `color` is a `store_accessor`, not an attribute. Deprecated in 7.1; raises on use in 8.1. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Highlight test passes |
| A4 | `config/routes.rb:18`, `get "/notes", "/journal", to:` | ArgumentError when routes load on 8.1.0. I did not check which release deprecated it. | Two lines: `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal` | `journal_path` test passes |
| A5 | `app/models/export.rb:42`, `fragments.sum` | Strings no longer sum from 7.1 (TypeError; already deprecated in the baseline log). In production `ExportJob` keeps retrying and the export stays "working". | `fragments.join` | Export tests pass |
| A6 | `app/views/imports/preview.html.erb`, `@import.annotations.stringify_keys` | In 8.0, `HashWithIndifferentAccess#stringify_keys` turns the integer line keys into strings, so annotations silently disappear from the preview. | Use `@import.annotations` (integer keys) | Preview test passes |
| A7 | `app/views/notes/index.html.erb:12`, `form_with(model: nil, ...)` | 8.1 raises "Passed nil to the :model argument". | Drop `model: nil` | Search form tests pass |
| A8 | `app/controllers/notes_controller.rb:18`, `where(notebooks: @notebook)` | Plural name for a singular association: deprecated in 7.1, gone in 7.2. On 8.1 it raises `PG::UndefinedColumn`. | `where(notebook: @notebook)` | Notebook filter tests pass |
| A9 | `note.rb:62`, `set(wait_until: reminder_epoch)` (an Integer) | Deprecated in 7.1; on 8.1 enqueueing raises `undefined method 'utc' for Integer`, so scheduling a reminder returns a 500. | `set(wait_until: Time.at(reminder_epoch))` | Reminder tests pass; scheduled jobs carry over across versions (worker test below) |
| A10 | `app/models/import.rb`, receipt uses `citation[:id]` | From 7.2, `read_attribute(:id)` reads a literal `id` column. Citation's primary key is `doi`, so the receipt CSV DOI column comes out blank. | `citation&.doi` | Receipt CSV test passes |
| A11 | `app/models/citation/provider.rb:13`, the test helper, `config/secrets.yml` | `Rails.application.secrets` is removed in 7.2. In production, `CitationEnrichmentJob` would raise NoMethodError, which `retry_on` does not catch. Sidekiq would keep retrying and the citation would stay pending, so readers cannot re-request it. | Move the YAML with the same ERB `.to_json` quoting to `config/citation_provider.yml`, set `config.x.citation_provider = config_for(:citation_provider)`, and default the provider to `Rails.configuration.x.citation_provider.to_h`. Update the test helper the same way. | The credentials test (`"00123"`, `"sample: value # keep"`) passes on both versions |
| A12 | `app/jobs/citation_enrichment_job.rb:7`, `wait: :exponentially_longer` | Deprecated in 7.1. On 8.1 the retry itself raises "Couldn't determine a delay". The job then falls through to Sidekiq's retries, the citation stays pending, and the provider gets more than 6 requests. | `wait: ->(executions) { executions**4 + 2 }` (same base delay, without 7.0's random jitter). `:polynomially_longer` only exists from 7.1. | The "6 requests" test passes on both versions |
| A13 | `import.rb#apply`, `return false` inside `transaction` | 7.0 rolls back on an early return; from 7.2 it commits. A failed row would leave a partial import saved (seen on 8.1: record counts changed). | Track the result and `raise ActiveRecord::Rollback` explicitly | "Saves nothing" test passes |
| A14 | `app/models/user.rb`, `DigestJob.perform_later(self, requested_at, reading_completion)` | 8.1 always serializes BigDecimal with a serializer that 7.0 cannot read. Details under "Queued jobs" below. | Pass `reading_completion.to_s`; `DigestMailer` already calls `BigDecimal(...)` on it | Worker interop test below |
| A15 | `app/mailers/digest_mailer.rb` | From 7.1, Active Job keeps a time's zone through serialization. The digest would then cover the reader's local day, not the UTC day the docs promise ("October 04" vs "05" on 8.1). Jobs queued by 7.0 carry no zone, so behaviour would differ job by job during rollout. | Add `requested_at = requested_at.in_time_zone("UTC")` before `to_date`/`all_day` | Digest test passes; interop runs dated the UTC day for an Auckland reader in both directions |
| A16 | `note.rb#next_day_reminder_at`, `reminder_at.to_time + 86_400` | From 8.1, `TimeWithZone#to_time` always keeps the zone. The preview changes from `-04:00` to `08:00 -05:00` across a daylight-saving change. The stored epoch does not change. | Product decision. To keep the documented behaviour: `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Otherwise accept the new preview and update the test and ARCHITECTURE.md. | Reminder test passes |

## Required changes, part B: must ship with the version bump

- **B1 `serialize :tags, JSON` (`note.rb:12`) → `serialize :tags, coder: JSON`.** This cannot ship early. On 7.0, `coder:` is silently ignored and YAML is used, so tags would be written as YAML (I saw it write `"---\n- a\n"`). On 8.1.0 the old form raises ArgumentError. During a rolling deploy both versions write JSON as long as each runs its own correct syntax.
- **B2 `config/environments/test.rb`: `show_exceptions = false` → `:none`.** On 8.1, `false` counts as "show everything", so the `assert_raises RecordNotFound` tests fail. On 7.0, `:none` counts as true, so this also cannot ship early.
- **B3 Gemfile:** `gem "rails", "8.1.0"` plus `gem "json", "< 3"`. See D1.
- **B4 Documentation:** update README, ARCHITECTURE.md (secrets, the Trix 1.3.4 note, the Active Job 7.0 digest text, `to_time` preview), CONTRIBUTING.md (`secrets.yml`), TESTING.md (the minitest note), and the comment in `app/views/layouts/application.html.erb`. CLAUDE.md asks for guidance to be updated when decisions change.

## Dependency constraints

- **D1 json.** `activesupport 8.1.0` calls `::JSON.parse(json, options)` with options as a positional hash. json 3.0.x (released 2026-09) only accepts keyword options, so every JSON column read and every `ActiveSupport::JSON.decode` raises "wrong number of arguments (given 2, expected 1)". I saw this on 8.1.0. 8.1.4 passes `**options` instead. With the pin, json resolved to 2.21.2 and the suite passed.
- **D2 8.1.0 is not the latest 8.1.** RubyGems lists 8.1.1, 8.1.2, 8.1.2.1, 8.1.3, 8.1.3.1 and 8.1.4. The `.1` releases are security releases; I did not check which CVEs they fix. Unless exactly 8.1.0 is required, I recommend 8.1.4: it also makes the json pin unnecessary. I did not run the suite on 8.1.4.
- **D3 Requirements and new gems.** Rails 8.1 needs Ruby ≥ 3.2 (you have 3.3.6), `pg ~> 1.1`, PostgreSQL ≥ 9.3, `rack >= 2.2.4`, `concurrent-ruby >= 1.3.1` (your 1.3.4 pin is fine), and `minitest >= 5.1` (your `~> 5.25` pin is fine). Newly added gems: action_text-trix 2.1.19, rackup 1.0.1, rack-session 1.0.2, webrick, bigdecimal 4.1.3, uri, securerandom, drb, useragent. Rack stays on 2.2 because sidekiq 6.5.12 pins `rack ~> 2.0`.
- **D4 Sidekiq 6.5.12 runs on 8.1.0.** Workers boot and process every job type. However, Rails' built-in Sidekiq adapter is deprecated and will be removed in 8.2. Moving to Sidekiq ≥ 7.3.3 is a separate later change with its own app risks:
  - `User#request_digest` uses `if Sidekiq.redis { sadd }`, which becomes an Integer and is always true;
  - `rescue Redis::BaseError` will no longer match connection errors;
  - `ExportJob` passes symbol-keyed arguments, which Sidekiq 7 rejects.

## Changes tests would not reveal: queued jobs, stored data, rollout

**Queued jobs** (workers on each version processing jobs queued by the other, sharing one database and Redis):
- 7.0 queues, 8.1 worker runs: enrichment, digest, a due reminder and the export all completed, and a future reminder stayed scheduled.
- 8.1 queues, 7.0 worker runs (a rollback): `DigestJob` failed with `DeserializationError: BigDecimalSerializer is not known` and sat in the retry set. Its Redis reservation stayed, so the reader could not request again that day. An 8.1 worker later drained it.
- With fix A14, the 7.0 worker processed the 8.1 digest correctly.
- 8.1 adds `time_zone` and `scheduled_at` to job payloads; 7.0 ignores them.

**Signed messages, at `load_defaults 7.0`:** 8.1 produced byte-identical blob signed IDs, Action Text attachment sgids, other sgids and message-verifier output. Sessions, per-form CSRF tokens and flash all work in both directions between a 7.0 and an 8.1 server.

**If the 7.1 message defaults are adopted** (`message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true`):
- Sessions and CSRF still crossed versions in my test.
- 7.0 cannot read signed IDs or sgids written by 8.1, and it raises NoMethodError rather than returning nil.
- Action Text stores the sgid inside the rich-text HTML. So after a rollback, any note with an attachment that was saved under the new defaults fails to render, and its blob URLs return 500.
- Recommendation: adopt these settings only once rollback is no longer an option.

**Time zones:** 8.1 adds "Asuncion" to the zone list. If a reader picks it and you roll back, 7.0's `Time.find_zone!("Asuncion")` raises, which breaks that reader's reminder pages and emails. Before any rollback, query `users.time_zone` against the 7.0 zone list (`ActiveSupport::TimeZone.all.map(&:name)` on 7.0).

**Cache:** production still uses the default FileStore with cache format 7.0 on 8.1. Switching to the 7.1 cache format cannot be read by 7.0.

**Trix and Action Text JavaScript:**
- 8.1's `actiontext.js` is a UMD build, not ESM. Your vendored Trix 1.3.5 still loads, the toolbar appears, saved links load, and edits save, on both 7.0 and 8.1 (headless Chrome).
- Optional after the bump: pin `"@rails/actiontext"` to `actiontext.esm.js` (exists only from 7.1). Moving to the bundled Trix 2 (action_text-trix 2.1.19) is a separate product change.

**Rich text output:** rendering and `to_plain_text` gave identical results on 7.0 and 8.1 for lists, nested lists, blockquote and line breaks, details/summary/script, attachments with captions, pre blocks and entities. So for those cases the Markdown export format does not change.

**Logs:** 8.1 logs a warning on boot that the image_processing gem is missing. Variants are not used, so this is harmless. You could optionally set `active_storage.variant_processor = :disabled` after the bump.

## Optional: adopting new framework defaults (`load_defaults`)

Keep `load_defaults 7.0` for the upgrade itself. Running the suite on 8.1 with `load_defaults 8.1` showed four default-sensitive problems:

1. **`default_column_serializer = nil` (7.1).** The `Notebook` class fails to load. Fix: `serialize :preferences, coder: YAML`; stored YAML is unchanged.
2. **`postgresql_adapter_decode_dates` (7.2).** `Notebook#daily_note_counts` raises because `Date.iso8601` is given a Date. Fix: `day.to_date`, or cast to text in SQL. This would also work on 7.0 but was not run.
3. **`raise_on_invalid_cache_expiration_time` (7.1).** `exports/_export.html.erb:26` computes a negative `expires_in` for an expired export. The exports page would return 500 in production for any notebook with an expired completed export. Fix: clamp the value, or skip caching once the export is expired.
4. **`raise_on_assign_to_attr_readonly` (7.1).** `NotebooksController` permits `:slug` on update, so saving notebook settings returns 500. Fix: permit `slug` only on create.

With the YAML coder in place, the other 8.1 defaults passed the suite (HTML5 sanitizer, `strict_freshness`, the 8.1 redirect and JSON settings). For staging:
- Adopt the message serializers and cache format last, as above.
- YJIT turns on in production from the 7.2/8.1 defaults; check memory.
- If anyone runs 7.2 in production with 7.2 defaults, Sidekiq jobs are queued only after the transaction commits. That breaks the "a failed enqueue rolls back" guarantee in `Citation#request_enrichment` and `Note#schedule_reminder`. Set `enqueue_after_transaction_commit` to `:never` on 7.2, or `false` on 8.x. 8.1's default is already false.

## Rollout sequence

1. **On 7.0.8.7, deploy A1–A16** (A16 per the product decision). Web and workers can update in any order, because job payload formats are unchanged. Retries already queued are fine: the new retry delay only reads `executions`.
2. **Deploy the bump** (B1–B4, `load_defaults` unchanged). A rolling deploy is safe in both directions, because sessions, signed messages and job payloads were verified compatible. Rollback stays safe as long as no new defaults are adopted, subject to the Asuncion check.
3. **Adopt defaults gradually**, fixing items 1–4 first. Leave the message serializers and cache format until you are sure you will not roll back.

## Not verified, and open questions

- Rich-text attachment upload in a browser on 8.1 was not run. There are no system tests.
- The 8.1 worker's real retry path for an unavailable provider was only exercised through the test adapter. My first worker run got HTTP 401 because the production credentials variables were not set.
- I did not run the suite on 8.1.4, or on 7.2/8.0 as intermediate stops. Schema dump changes under 8.1 were not checked.
- Is exactly 8.1.0 required, or may you take 8.1.4?
- Should the next-day reminder preview keep the old behaviour (A16)?
- Does any deployment supply `secret_key_base` or other values through `config/secrets.yml` outside the repo? 7.2+ ignores that file.
- How long a rollback window do you need? That decides when the irreversible defaults (message formats, cache format) can be adopted.

The maintain-rails skill asked me to hand this to the `gem-upgrade-planner` agent, but no agent-spawning tool was available here, so I did the planning directly with the same constraints. The disposable copies, the isolated Postgres data and the logs remain under `/tmp/mn-upgrade/`; the isolated services are stopped.

---

**What I checked myself after the planner finished:**
- `/home/user/workspace/repo` has no changes and is still at commit 9938031.
- These result lines in `/tmp/mn-upgrade/logs/` match the plan:
  - `baseline-7.0.8.7-test.log`: 46 runs, 325 assertions, 0 failures.
  - `8.1.0-test-run1.log`: 46 errors.
  - `8.1.0-test-run8.log`: 46 runs, 340 assertions, 0 failures, 0 errors.
  - `prep-on-7.0.8.7-test.log`: 46 runs, 325 assertions, 0 failures.
- `sidekiq-7.0-processes-8.1-work-string-completion.log` supports A14. A digest queued on 8.1 with the completion passed as the string `"0.25"` was delivered by the 7.0 worker. The same log also contains a `BigDecimalSerializer is not known` failure, but that is a retry left over from the earlier run without the fix. It was first queued at 18:15:48 and is already on its first retry.
- The working copy still has the code that A2, A3, A5, A11 and A12 replace, and the `+=` on `allowed_tags` that A1 replaces. This is at the lines the plan cites in `app/models/note.rb`, `app/models/export.rb`, `app/models/citation/provider.rb`, `app/jobs/citation_enrichment_job.rb` and `config/initializers/action_text.rb`.

I did not re-run any experiments or re-check the other findings.

The note at the end of the plan about having no agent-spawning tool came from the planner itself. It was the planner agent, so the planning was still done by that agent as intended.

**Decisions for you:**
1. **8.1.0 or 8.1.4:** the plan recommends 8.1.4, which is not tested here. It includes security releases and removes the need for the `json < 3` pin.
2. **Next-day reminder preview (A16):** keep the old behaviour, or accept 8.1's change.
3. **Rollback window:** how long you need to be able to roll back decides when to adopt the new message serializer and cache format defaults, because 7.0 cannot read data written under them.
