I asked the upgrade planner for a plan to move Rails from 7.0.8.7 to 8.1.0; its full plan is below. Nothing in your repository has changed yet. All of its testing ran in throwaway copies under `/tmp/mn-exp`.

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

The upgrade is feasible, but it can't be a version bump alone. Rails 8.1.0 won't boot without code changes. After boot, 42 of the 46 tests fail. More importantly, at least seven behavior changes would ship unnoticed if they were fixed only until tests pass. Some of them corrupt or lose data without any error.

In a disposable copy, a set of 18 changes made all 46 tests pass on 8.1.0. Most of those changes also pass all 46 tests on 7.0.8.7, so they can ship first, on the current version.

## What I ran
Your working repository was not modified (`git status` is clean). Everything ran in `/tmp/mn-exp`, with its own Postgres 15 cluster (Unix socket, port 55432, data in `/tmp/mn-exp/pg`) and its own Redis on port 56379 (a separate Redis database for each copy). Its gems were installed in their own bundle folders. Each copy stored files in its own `tmp/storage`, and the test cache store is null.

- **Copies:**
  - `/tmp/mn-exp/base`: unchanged 7.0.8.7.
  - `/tmp/mn-exp/app`: 8.1.0 with all fixes.
  - `/tmp/mn-exp/port`: 7.0.8.7 with only the fixes that work on 7.0.
  - Settings for each are in `/tmp/mn-exp/env.sh`, `env-base.sh` and `env-port.sh`.
- **Versions resolved for 8.1:** `bundle update rails sidekiq concurrent-ruby --conservative` gave rails 8.1.0, sidekiq 7.3.9, redis-client 0.31.0, redis 4.8.1, concurrent-ruby 1.3.8, minitest 5.27.0 and json 2.21.2 (after a pin, see R1). Puma 5.6.9, pagy 8.6.3, turbo-rails 2.0.12, importmap-rails 2.2.3, sprockets-rails 3.5.2 and faraday 1.10.4 didn't change.
- **Results** (logs in `/tmp/mn-exp/logs/`):

| Run | Result | Log |
|---|---|---|
| Unchanged 7.0.8.7 | 46 runs, 0 failures | `test70.log` |
| 8.1, only the boot fixes | 17 failures, 25 errors | `test81-partial.log` |
| 8.1 with all fixes | 46 runs, 0 failures, no deprecation warnings | `test81-final.log` |
| 7.0 with the portable fixes | 46 runs, 0 failures | `test70-portable.log` |

- **Behavior probe:** `/tmp/mn-exp/scripts/probe.rb`, run on both versions (`probe70.log`, `probe81.log`).
- **Queue test across versions:** `scripts/enqueue.rb` and `scripts/consume.rb`, with payloads saved in `payload70.json` and `payload81.json`.
- **Not run:** system tests (`bin/rails test:system`), production-mode boot or asset precompile, a real Sidekiq worker process, and the step-by-step 7.1 → 7.2 → 8.0 route.

## Required changes
P means the change also works on 7.0.8.7 and was verified there. N means it only works on 7.1 or later.

| # | Code | What changes in 8.1 | Fix | P/N | How it shows up |
|---|---|---|---|---|---|
| R1 | `Gemfile` | ActiveSupport 8.1.0 needs the `json` gem, and json 3.1.0 resolved. Its parser no longer accepts an options hash, so any JSON column read raises `ArgumentError`. | Add `gem "json", "< 3"`, or check whether a later 8.1.x fixes it. | P | Probe: crashed on `notes.settings` |
| R2 | `config/initializers/action_text.rb` | `ContentHelper.allowed_tags` now starts as `nil`, so `+=` crashes at boot. | Set it in `after_initialize` as `(allowed_tags \|\| sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. | P | `boot81.log`; the details-tag rendering test |
| R3 | `app/models/note.rb:10` | The keyword form of `enum` raises. | `enum :status, {...}, prefix: true` | P | Probe |
| R4 | `note.rb:12` | `serialize :tags, JSON` with a positional coder raises. | `serialize :tags, coder: JSON` | N (7.1+) | Probe |
| R5 | `note.rb:14` | `alias_attribute :highlight_color, :color` raises the first time a Note is built, because `color` is a store accessor, not a column. `zeitwerk:check` doesn't catch this. | Write `highlight_color` and `highlight_color=` methods that delegate to `color`. | P | Probe; suite |
| R6 | `config/routes.rb:18` | `get "/notes", "/journal", to:` (several paths in one call) raises. Every route after it breaks, which caused most of the failures. | Two `get` lines with `as: :notes` and `as: :journal`. This keeps the 7.0 route names. | P | `test81-partial.log` |
| R7 | `app/models/citation/provider.rb:13` and `test/controllers/citation_enrichments_controller_test.rb:45,117-122` | `Rails.application.secrets` no longer exists (removed in 7.2). | Move `config/secrets.yml` to `config/citation_provider.yml`, read with `config_for` into `config.x.citation_provider`. Keep the ERB `.to_json` quoting: without it a bare URL is a YAML syntax error, which I hit. Production needs the same env vars, no new secrets. | P | Probe; suite |
| R8 | `app/models/export.rb:42` | `fragments.sum` on Strings: ActiveSupport's override of `sum` for non-numbers is gone, so it raises `TypeError`. | `fragments.join` | P | Suite |
| R9 | `app/models/note.rb:61` | `set(wait_until: <Integer epoch>)`: Active Job now calls `.utc` on it, and every reminder raises `NoMethodError`. | `Time.at(reminder_epoch)` | P | Probe; suite |
| R10 | `app/views/notes/index.html.erb:12` | `form_with(model: nil, ...)` raises. | Remove `model: nil`. | P | Suite |
| R11 | `app/controllers/notes_controller.rb` (index) | `where(notebooks: @notebook)` now becomes SQL for a column `notes.notebooks`, which doesn't exist. | `where(notebook: @notebook)` | P | Suite |
| R12 | `app/jobs/citation_enrichment_job.rb:7` | `wait: :exponentially_longer` was removed. It only fails at retry time, when a provider is down. | `:polynomially_longer` (same formula) | N (7.1+) | Probe: `RuntimeError` |
| R13 | `config/environments/test.rb:31` | `show_exceptions = false` should become `:none`. On 7.0, `:none` would mean "show exceptions", so this can't go in early. | `:none` | N (7.1+) | Source, plus test run |
| R14 | `Gemfile` sidekiq 6.5.12 | Rails 8 no longer ships the Sidekiq adapter for Active Job. It now comes from Sidekiq 7.3 and later (which uses redis-client), so moving to Sidekiq 7 is effectively required. That move drives R15–R17. | `gem "sidekiq", "~> 7.3"` | N | Bundle resolution |

### Silent behavior and data changes
These would ship unnoticed if you only fix things until tests pass.

| # | Code | What goes wrong | Fix | P/N | Evidence |
|---|---|---|---|---|---|
| R15 | `app/models/user.rb:38` | With Sidekiq 7, `redis.sadd` returns `0` or `1` instead of `false` or `true`. In Ruby `0` is truthy, so the once-per-day digest limit stops working. | `[true, 1].include?(redis.sadd(key, id))`. Plain `.to_i == 1` broke on 7.0, which I hit. | P | Probe on both versions |
| R16 | `app/models/notebook.rb:28` | `rescue Redis::BaseError` no longer catches anything, because Sidekiq 7 raises `RedisClient::CannotConnectError`. A failed enqueue leaves a stuck "queued" export. | `rescue StandardError`, matching `User#request_digest`. | P | Probe |
| R17 | `notebook.rb:27` | `perform_async(id, { format: "markdown" })` raises `ArgumentError`, because Sidekiq 7 rejects symbol keys in job arguments by default. | Use string keys. | P | Probe; suite |
| R18 | `app/models/import.rb` `#apply` (`return false` inside `transaction`) | It now commits. A CSV with a bad row saves the import plus the rows before it (counts changed from 0/3/0/1 to 1/4/1/2). | `raise ActiveRecord::Rollback`, then return whether it saved. | P | Suite |
| R19 | `import.rb` `#receipt` (`citation[:id]`) | `read_attribute(:id)` no longer falls back to the primary key. Citations use `doi` as their key, so receipts silently have a blank DOI column. No test checks this. | `citation&.doi` | P | Probe: 7.0 gives the DOI, 8.1 gives nil |
| R20 | `app/views/imports/preview.html.erb:22` (`annotations.stringify_keys`, then lookup by Integer line number) | `HashWithIndifferentAccess#stringify_keys` now turns Integer keys into strings, so annotations disappear from the import preview. | Drop `.stringify_keys`. | P | Runner on both versions; suite |
| R21 | `app/mailers/digest_mailer.rb` | A queued time now comes back in the time zone it was queued in. The digest then covers the reader's local day instead of the UTC day the app documents (the test shows Oct 4 vs Oct 5). | `params[:requested_at].utc`. This handles old and new payloads. | P | Probe; suite |
| R22 | `app/models/note.rb` `#next_day_reminder_at` (`reminder_at.to_time + 86_400`) | `to_time` now keeps the time zone instead of the UTC offset, which changes the documented behavior across a daylight-saving change (the test expects -04:00). | `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)` | P | Suite |

## Rollout and rollback (queued jobs and stored data)
- **BigDecimal job arguments.** This is confirmed. A digest job queued by 8.1 fails on a 7.0 worker with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. That breaks a mixed web/worker deploy and any rollback while such jobs are queued. Ship `reading_completion.to_s` (in `user.rb`) on 7.0 first. It is portable, and it is exactly what 7.0 already puts on the wire. The mailer's `BigDecimal(...)` accepts either form.
- **Time-zone arguments.** Payloads from either version can be read by the other (`payload*.json`). Only the meaning changes, and R21 makes that consistent.
- **Sidekiq wrapper class.** Sidekiq 7.3.9 still queues `ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper`, and 7.0 read those jobs, including scheduled ones. Long-lived reminder jobs in the `schedule` set should therefore survive in both directions. I haven't verified this with a real Sidekiq 6.5 process consuming jobs queued by 7.x.
- **Stored data.** No data format changes:
  - `notes.tags` stays JSON text.
  - `notebooks.preferences` stays YAML. Its default coder is still YAML under `load_defaults 7.0`; probed, and the raw contents are identical.
  - `notes.settings` stays jsonb.
  - `schema.rb` stays `Schema[7.0]`, and no migrations are needed.
- **Redis keys.** `digest_requests:*` keys are compatible.

## Recommended order
1. **On 7.0.8.7, deploy the portable fixes:** R2, R3, R5–R11, R15–R22, plus the digest `.to_s`. In the copy these pass all 46 tests (`/tmp/mn-exp/port`). R7 also needs the new config file and initializer, and the test changes.
2. **Ideally step through the versions** (7.1, then 7.2, then 8.0, then 8.1), running the suite and checking deprecations at each step. Production sets `report_deprecations = false`, so turn it on temporarily in staging.
3. **Deploy the 7.1+-only items with the 8.1 bump:** R1, R4, R12, R13, R14.
4. **Drain the queue first.** Drain or pause workers, upgrade workers and web together, and only roll back after the queue is drained of jobs queued by 8.1.
5. **Before going live,** confirm the production Redis server meets Sidekiq 7's minimum (believed to be 6.2), and check whether Sidekiq 7 rollback to 6.5 is safe for your Redis data.

## Optional (not required)
- **`load_defaults` 7.1 through 8.1:** adopt them one at a time with `new_framework_defaults_*`. Watch the HTML5 sanitizer for Action Text, the `default_column_serializer` that makes `serialize :preferences` need an explicit coder, and Active Storage, cache and cookie format changes. Cookie and cache changes need a rollout in two phases.
- **Pins and minor gems:**
  - Drop the `concurrent-ruby` 1.3.4 pin (8.1 resolved 1.3.8).
  - Keep the `minitest ~> 5` pin.
  - Add `gem "csv"`; there's a warning ahead of Ruby 3.4.
  - Puma 5 could move to 6, and `cache_classes` could become `enable_reloading`.

## Open questions
- System tests weren't run, and neither were the Turbo/importmap/Trix assets, production boot or `assets:precompile`.
- Does 8.1.x after 8.1.0 fix the json 3 problem? I didn't check.
- I'm not certain that the remaining specific cause I attributed to 7.1, 7.2 or 8.0 lands in that exact release.
- Is the R21/R22 behavior (UTC digest day, keep the offset) still what the product wants? I preserved the documented behavior rather than adopting the new framework semantics.

---

**What to decide next:**
- **Scope:** the upgrade also requires moving Sidekiq from 6.5 to 7.3 (R14), which goes beyond the Rails bump itself.
- **Release plan:** shipping the portable fixes on 7.0.8.7 first lowers the risk.
- **R21 and R22:** these need a product decision on the digest's UTC day and the time-zone offset.

If you want, I can start with the portable fixes on a branch, or apply the whole upgrade at once.