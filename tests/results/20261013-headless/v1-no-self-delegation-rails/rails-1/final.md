# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but bumping the version alone breaks the app. Boot, eager loading and the test suite all failed in the experiment copy. About half the necessary fixes are behaviour changes that the suite only partly catches or doesn't catch at all: a CSV import can now be half-saved, import receipts lose their DOIs, and digests and reminder times shift by a day or an hour.

In a disposable copy, a set of preparatory changes passed the full suite on the current Rails 7.0 (46 runs, 0 failures). The same changes plus five 8.1-only edits passed on Rails 8.1.0 (46 runs, 0 failures). Keep `config.load_defaults 7.0` throughout. With it, session cookies and cache entries read correctly in both directions between versions (tested), so rollback is safe for those.

The real rollback hazard is queued jobs. A DigestJob enqueued on 8.1 cannot be read by a 7.0 worker. Ship the preparatory changes on 7.0 first.

## Recommended order
1. **Release A, on Rails 7.0:** the preparatory changes in section 1. Deploy, let the queues drain, and fix any data saved wrongly.
2. **Release B, Rails 8.1.0:** the 8.1-only edits in section 2, keeping `load_defaults 7.0`.
3. **Later, separately:** move Sidekiq to 7.3.3 or later before Rails 8.2, and consider newer framework defaults (section 4).

Also consider 8.1.4 rather than exactly 8.1.0: RubyGems lists 8.1.1 through 8.1.4, including 8.1.2.1 and 8.1.3.1. I didn't test those or check whether they fix the json problem below.

## 1. Required changes that also work on 7.0 (verified on both versions)

| # | Code | What changes in 8.1 | Fix |
|---|---|---|---|
| 1 | `app/models/note.rb:10` `enum status:, _prefix:` | Class fails to load (tested) | `enum :status, {...}, prefix: true` |
| 2 | `note.rb` `alias_attribute :highlight_color, :color` | `color` is a store accessor, not an attribute: ArgumentError (tested) | `alias_method :highlight_color, :color` plus the setter |
| 3 | `config/routes.rb:18` `get "/notes", "/journal"` | Several paths in one `get` is rejected (tested) | Two `get` lines with `as: :notes` and `as: :journal`. Route names stay the same (checked with `rails routes`) |
| 4 | `config/initializers/action_text.rb` `allowed_tags +=` | `allowed_tags` is now nil by default: NoMethodError at boot (tested) | In `after_initialize`, take `allowed_tags` or the built-in default, then add `details summary`. The details/summary test passes on both |
| 5 | `app/models/export.rb:42` `fragments.sum` | TypeError, so every export fails. Already a deprecation warning on 7.0 | `fragments.join` |
| 6 | `app/models/citation/provider.rb:13` and the test, `Rails.application.secrets` | Removed. Every enrichment fails | Move `config/secrets.yml` to `config/citation_provider.yml`, flattened (the `citation_provider:` level dropped) and still read from ENV; set `config.citation_provider = config_for(:citation_provider)`; update the test's override. Keep `.to_json` quoting. The test that checks credentials from the environment passes |
| 7 | `app/views/notes/index.html.erb:12` `form_with(model: nil, ...)` | "Passed nil to the :model argument", so the notes list returns 500 (tested) | Drop `model: nil` |
| 8 | `app/controllers/notes_controller.rb:13` `where(notebooks: @notebook)` | Becomes `notes.notebooks` (no such column): 500 when filtering by notebook (tested) | `where(notebook: @notebook)` |
| 9 | `note.rb:61` `set(wait_until: reminder_epoch)` (an Integer) | `undefined method 'utc' for Integer`, so reminders cannot be scheduled (tested) | `wait_until: Time.at(reminder_epoch)` |
| 10 | `app/jobs/citation_enrichment_job.rb` `wait: :exponentially_longer` | "Couldn't determine a delay" when enqueueing (tested) | Use a lambda that works on both versions, `->(executions) { executions**4 + 2 }` (I added the `+ 2`; it was not checked against 7.0's exact formula). Or switch to `:polynomially_longer` in release B, which 7.0 doesn't support |

**Silent behaviour changes the current tests don't fully cover**

| # | Code | What changes in 8.1 | Fix |
|---|---|---|---|
| 11 | `app/models/import.rb#apply`, `return false unless row.note.save` inside `transaction` | On 7.0 that `return` rolls back. On 8.1 it commits, so an invalid row leaves the import and earlier notes and citations saved (tested: counts went from `[0,3,0,1]` to `[1,4,1,2]`) | `raise ActiveRecord::Rollback unless rows.all? { _1.note.save }`, with a `saved` flag |
| 12 | `import.rb#receipt` `citation[:id]` | Citation's primary key is `doi` and it has no `id` column. `[:id]` now returns nil, so receipt CSVs have empty DOI columns (tested: `citation[:id]=nil`) | `citation&.doi` |
| 13 | `app/views/imports/preview.html.erb` `annotations.stringify_keys` | Now really converts the integer line numbers to strings, so `annotations[row.line]` is nil and preview annotations disappear (tested) | Drop `.stringify_keys` |
| 14 | `note.rb#next_day_reminder_at` `reminder_at.to_time + 86_400` | `to_time` now keeps the time zone rather than the UTC offset, so across a daylight-saving change the time moves (tested: `09:00-04:00` became `08:00-05:00`). The code comment documents keeping the offset | `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` |
| 15 | `app/mailers/digest_mailer.rb` and `User#request_digest` | Since 7.1, a time with a zone is restored in its original zone. On 7.0 it came back in UTC. Digests would cover the reader's local day while the once-per-day reservation key still uses the UTC day (tested: subject changed from Oct 05 to Oct 04) | In the mailer, `requested_at = requested_at.in_time_zone("UTC")`. This handles payloads from either version |
| 16 | `User#request_digest` passes a BigDecimal | 8.1 serializes BigDecimal with a new serializer that 7.0 doesn't know (see rollout) | Pass `reading_completion.to_s`. `DigestJob` already calls `BigDecimal(...)` on it |

## 2. Required for 8.1 only (release B)
- **Gemfile:** `rails "8.1.0"`. Remove the `concurrent-ruby 1.3.4` pin, which existed only for the 7.0 Logger bug.
- **json:** Bundler resolved `json 3.1.0`, and activesupport 8.1.0 calls `JSON.parse(src, opts_hash)`, which json 3 rejects. Every JSON-serialized attribute read raised ArgumentError (tested). Add `gem "json", "~> 2.7"`; it resolved to 2.21.2.
- **`note.rb`:** `serialize :tags, JSON` becomes `serialize :tags, coder: JSON`. The old positional form raises on 8.1, and 7.0 doesn't accept `coder:`. Stored data is unchanged.
- **`config/environments/test.rb`:** `show_exceptions = false` becomes `:none`. With the old value, the RecordNotFound ownership tests stopped seeing the exception (8 tests in all; one NotFound test errored for another reason). `:none` is truthy on 7.0, so this can't be done in advance.
- **Resolved versions:** rack stays 2.2.24 (Sidekiq 6.5 needs rack 2), puma 5.6.9, redis 4.8.1, minitest 5.27, pagy 8.6.3, turbo-rails 2.0.12, importmap 2.2.3. `action_text-trix` 2.1.19 is new; it serves the `actiontext.js` pin.
- **`db/schema.rb`:** an 8.1 dump sorts columns alphabetically and writes `pg_catalog.plpgsql`. That is cosmetic; commit it in its own change.

## 3. Rollout and rollback
- **Jobs from 7.0, run on 8.1 (tested):** these deserialize fine. The BigDecimal arrives as a String, and the time arrives in UTC, so the old payloads are handled.
- **Jobs from 8.1, run on 7.0 (tested):** they fail with `DeserializationError: BigDecimalSerializer is not known` when the job carries a BigDecimal. Unprotected, a rollback would leave DigestJobs failing and retrying, while their Redis reservation blocks the reader from asking again that day. Fix 16 shipped first on 7.0 removes this.
  - NoteReminderJob and CitationEnrichmentJob carry only record references, and 8.1's extra `scheduled_at` and `time_zone` keys are ignored by 7.0 (source-based).
  - ExportJob is a native Sidekiq job and doesn't depend on Rails' job format.
- **Scheduled reminders** already in the Sidekiq scheduled set keep working on either version (record reference only).
- **Before deploying B:** drain or inspect the Sidekiq retry and scheduled sets for DigestJob, and run 7.0 and 8.1 workers side by side only after release A has been live long enough for its payloads to be the only ones queued.
- **Session cookies (tested):** with a shared `SECRET_KEY_BASE` and `load_defaults 7.0`, cookies written by either version decrypt on the other. Cookie serializer is `:json`.
- **Cache (tested):** entries written to a shared FileStore read on both versions at format 7.0.
- **Stored data from the bugs above:**
  - Rows saved under fixes 11–13 if B ships without them: partial imports. Clean them up by finding imports whose notes don't match a full CSV; that needs a query, not just a revert.
  - `notebooks.preferences` stays YAML (the default serializer with `load_defaults 7.0`); `notes.tags` stays JSON. No data migration is needed.

## 4. Optional defaults and later work (not required for 8.1.0)
- **Built-in Sidekiq adapter:** deprecated in 8.1 and removed in 8.2 (source: `sidekiq_adapter.rb#check_adapter`). Sidekiq 6.5 worked on Rails 8.1, enqueueing and processing through the isolated Redis (tested). Moving to Sidekiq 7.3.3 or later is a separate change. From source and memory, not tested:
  - In 7.x, `redis.sadd` returns an Integer, so `if ... sadd` in `User#request_digest` is always true and the once-a-day guard breaks.
  - Sidekiq 7 raises `RedisClient` errors, so the `rescue Redis::BaseError` in `Notebook#request_export` (and the test stub using `Redis::CannotConnectError`) stops matching.
  - Sidekiq 7 rejects non-JSON arguments by default, and `ExportJob.perform_async(id, { format: "markdown" })` passes a hash with symbol keys (Sidekiq already warns about this on 7.0).
  - Sidekiq 7 needs Redis 6.2 or later.
- **`load_defaults` 7.1 or later:**
  - `raise_on_assign_to_attr_readonly` makes every notebook settings save raise, because the form resubmits `slug` (tested: `ReadonlyAttributeError` even when the value is unchanged).
  - Also review `default_column_serializer` (nil, which breaks `serialize :preferences`), the 7.1 cache and message formats (one-way: rollback can't read them), and `enqueue_after_transaction_commit`. It is currently false; turning it on would break the enqueue-under-row-lock rollback in `Citation#request_enrichment` and `Note#schedule_reminder`.
  - Adopt these one at a time, after B is stable.
- **Puma 6 and Rack 3** become possible once Sidekiq no longer pins rack 2.
- **Unrelated to the upgrade:** in production-env Sidekiq, DigestJob fails with "Missing host to link to" because `config/environments/production.rb` sets no `action_mailer.default_url_options`. 7.0 has the same config, so this is source-inferred; I didn't run it on 7.0.

## 5. Checks still to do
- System tests (`bin/rails test:system`); they need a display and Chrome, so I didn't run them.
- A staging run with real Sidekiq: enqueue on A, process on B, then roll back to A with B-enqueued jobs queued.
- Whether 8.1.x patch releases still need the json pin.
- A query against production imports for partial saves, if B ever ran without fix 11.
- Asset precompile on 8.1 (sprockets plus the new trix gem) wasn't run.

## Experiments
Everything ran under `/tmp/mn-exp`: its own Postgres 15 cluster on port 55432 (`pgdata`), redis-server 7.0.15 on 56379 (databases 2–5), separate test databases per copy, the `:test` storage service inside each copy, and a separate bundle path (`/tmp/mn-exp/bundle`). Both services are stopped, and the working repo is untouched.

Each command ran with `PARALLEL_WORKERS=1`, the copy's own `DATABASE_URL` and `REDIS_URL`, and `bin/rails test`.

| Copy | What it is | Result |
|---|---|---|
| `base` | Unmodified 7.0 | 46/0 (`base-test.log`) |
| `r81a` | Rails 8.1.0, fixed one failure at a time | Boot errors (`r81a-zeitwerk*.log`), then 19F/6E → 5F/10E → 4F/0E (`r81a-test3.log` to `r81a-test5.log`) |
| `prep70` | Preparatory changes on 7.0 (`prep70.diff`) | 46/0 (`prep70-test2.log`) |
| `r81b` | Preparatory changes plus 8.1-only edits (`r81b.diff`, `Gemfile.lock` inside the copy) | 46/0 (`r81b-test.log`); Sidekiq round trip in `r81b-sidekiq.log` |

The edits are scripted in `/tmp/mn-exp/scripts/prep.py`. The probes are in `/tmp/mn-exp/probes/`: payloads (`payload-base.json`, `payload-r81a.json`), cross-version deserialization, cookies, cache, and miscellaneous checks.

---

I haven't upgraded Rails yet: this is only the plan, and nothing in your repository has changed. The tested changes are in `/tmp/mn-exp/prep70.diff` (release A, still on 7.0) and `/tmp/mn-exp/r81b.diff` (release B, Rails 8.1.0).

Two decisions are yours before I make the change:
- **Two releases or one:** shipping the 7.0-compatible fixes first means rolling back is safe while jobs are still queued.
- **Version:** exactly 8.1.0, as you asked, or the latest 8.1.x patch release, which wasn't tested.

Tell me which you want and I'll apply it.