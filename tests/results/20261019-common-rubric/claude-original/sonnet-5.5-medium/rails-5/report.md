# Plan: upgrade `rails` 7.0.8.7 to 8.1.0 in Margin Notes

This plan comes from the `maintain-rails:gem-upgrade-planner` subagent. I relayed it without re-running any experiment, and I did not modify the working application. The subagent said it had no tool to launch a further subagent, so it did the analysis itself. Its experiments ran in disposable copies under `/tmp/upg`.

## Verdict

- **Hard blockers:** a straight Gemfile bump does not boot. Eight further changes are needed to get the suite green.
- **Beyond the suite:** the planner found two behaviour regressions and one rollback hazard that no test in the suite would catch.
- **Result with the patch set:** 46 runs, 340 assertions, 0 failures on Rails 8.1.0. Baseline on 7.0.8.7 is 46 runs, 325 assertions, 0 failures.
- **Version-neutral subset:** the planner applied the subset that is compatible with 7.0 to a second copy still on 7.0.8.7. It also passes 46/46.
- **Not run:** no intermediate Rails versions (7.1, 7.2, 8.0) were run. The staged path below is a recommendation, not something verified.

## How it was tested

| Copy | Purpose | Database | Redis |
|---|---|---|---|
| `base` | pristine 7.0.8.7 | `mn_upg_base` | `localhost:6390` db 0 |
| `r81` | 8.1.0 plus the patch set | `mn_upg_r81` | db 1 |
| `prep` | 7.0.8.7 plus the 7.0-compatible patches | `mn_upg_prep` | db 2 |
| `r81sk` | `r81` with Sidekiq 7.3 | `mn_upg_r81sk` | db 3 |

- **Isolation:** Redis ran as its own server on port 6390, started with `--save ""` and now shut down. The shared database `mn_upg_shared` on Redis db 5 was used only for the cross-version queue test.
- **Resolved dependencies:** Ruby 3.3.6 throughout. Rails 8.1.0 resolved with rack 2.2.24 (kept by Sidekiq 6.5.12), rack-session 1.0.2, sidekiq 6.5.12, redis 4.8.1, pagy 8.6.3 and json 2.21.2 (after the pin). The full lock is `/tmp/upg/r81_Gemfile.lock.after`.
- **Evidence files:**
  - Test logs: `/tmp/upg/base_test.log`, `/tmp/upg/r81_test_run1.log` through `/tmp/upg/r81_test_run8.log`, `/tmp/upg/prep_test_run1.log`, `/tmp/upg/r81sk_test.log`.
  - Patches: `/tmp/upg/r81_experiment.patch` (all 8.1 changes) and `/tmp/upg/prep_70_compatible.patch` (changes that also work on 7.0).
  - Queue and worker runs: `/tmp/upg/xv/` holds the Sidekiq payload dumps, worker logs, `enqueue.rb`, `seed.rb` and `env_dev.sh`.
  - Probes and diffs: `/tmp/upg/probe1.rb`, `/tmp/upg/probe2.rb` and `/tmp/upg/probe3.rb`, plus the two `schema_after_migrate_*.rb` files.

## A. Required changes

| # | Where | Failure on 8.1 | Fix | Works on 7.0? |
|---|---|---|---|---|
| 1 | `Gemfile` | `json` 3.0.2 resolves, and ActiveSupport 8.1.0 calls `JSON.parse(str, opts)`. That raises "wrong number of arguments" in sessions, the JSON-typed `settings` column and encrypted messages. | Add `gem "json", "< 3"`. This is the transitive-dependency pin that was tested. Whether a later 8.1.x removes the need for it was not tested. | n/a |
| 2 | `config/initializers/action_text.rb` | `ActionText::ContentHelper.allowed_tags` is `nil` by default, so `+=` raises `NoMethodError` at boot. | Seed from `allowed_tags \|\| (sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])`, then add `details` and `summary`. | Yes |
| 3 | `app/models/note.rb:10` | `enum status: {...}, _prefix: true` raises ArgumentError. | `enum :status, {...}, prefix: true` (generates the same `status_ready` and `status_draft?` methods). | Yes |
| 4 | `app/models/note.rb:12` | `serialize :tags, JSON` raises. | `serialize :tags, coder: JSON`. | No. 7.0 treats the hash as the class argument, so do this at the 7.1 or 8.1 step. |
| 5 | `app/models/note.rb:14` | `alias_attribute :highlight_color, :color` raises because `color` is a store accessor, not an attribute. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. | Yes |
| 6 | `config/routes.rb:18` | `get "/notes", "/journal", to:` raises (multi-path form). | Two lines, `get "/notes"` and `get "/journal"`. App routes and names are identical to before (diffed). | Yes |
| 7 | `app/models/export.rb:42` | `fragments.sum` over strings raises `TypeError`. Rails 7.0 already warns about this (visible in the 7.0 worker log). | `fragments.join`. | Yes |
| 8 | `app/views/notes/index.html.erb:12` | `form_with(model: nil, ...)` raises "Passed nil to the :model argument". | Drop `model: nil`. | Yes |
| 9 | `app/controllers/notes_controller.rb:18` | `where(notebooks: @notebook)` relied on 7.0 singularising the key. In 8.1 it queries a nonexistent `notes.notebooks` column. | `where(notebook: @notebook)`. | Yes |
| 10 | `app/jobs/note_reminder_job.rb`, `app/models/note.rb:61` | `set(wait_until: <Integer>)` raises `undefined method 'utc'`. | `wait_until: Time.at(reminder_epoch)`. | Yes |
| 11 | `app/jobs/citation_enrichment_job.rb:5` | `wait: :exponentially_longer` was removed and raises at retry time. | `:polynomially_longer`. The retry delays matched the old ones in the 8.1 worker log (3 s, then 19 s). | No. 7.0 does not know the new name. |
| 12 | `config/secrets.yml`, `app/models/citation/provider.rb:13`, the citation test, `ARCHITECTURE.md:79`, `CONTRIBUTING.md:38` | `Rails.application.secrets` no longer exists. | Move the settings to `config/citation_provider.yml` read by `config.x.citation_provider = config_for(:citation_provider)`. The file must use a flat per-environment layout. The first attempt nested the key and silently produced blank credentials. | Yes |
| 13 | `config/environments/test.rb` | `show_exceptions = false` is no longer understood. Not-found errors render a 404 page, so the `assert_raises(RecordNotFound)` tests fail. | `:none`. | No. On 7.0, `:none` is truthy and shows exception pages. |
| 14 | `app/views/imports/preview.html.erb` | `HashWithIndifferentAccess#stringify_keys` now turns the Integer line keys into strings, so `annotations[row.line]` finds nothing. The preview silently drops annotations. | Use `@import.annotations` directly. | Yes |
| 15 | `app/models/import.rb:54` | `return false` inside `transaction` used to roll back (7.0 rolled back an early exit after writes). In 8.1 it commits, so an import with an invalid row leaves the Import and the earlier notes saved. Test counts went from `[0,3,0,1]` to `[1,4,1,2]`. | `rows.all? { ... } \|\| raise(ActiveRecord::Rollback)`, returning `!!applied`. | Yes |
| 16 | `app/models/import.rb:66` | `citation[:id]` returns `nil` for the string primary key `doi`, so the receipt CSV loses its DOI column. | `citation&.id`. | Yes |

Items 15 and 16 were caught by the existing import tests. They are data-integrity bugs, so keep those tests.

## B. Behaviour changes the tests do not decide

Required for correctness:

1. **Digest date.**
   - **Change:** on 8.1, `TimeWithZone` serialises with a `time_zone` key, so `DigestJob` receives `requested_at` in the reader's zone. `DigestMailer` then covers the reader's local day instead of the UTC day. The UI text and `User#request_digest` both promise UTC.
   - **Observed:** with `requested_at` at 23:30 US Eastern, the subject read "October 04" (local) instead of "October 05" (UTC).
   - **Fix:** `requested_at = requested_at.utc` in `DigestMailer`. It is version-neutral and ran green on 7.0.

2. **Reminder postponement preview.**
   - **Change:** `reminder_at.to_time + 86_400` used to keep the fixed offset. On 8.1 it follows the zone, so across a daylight saving change it shows `08:00-05:00` instead of `09:00-04:00`. The instant is the same.
   - **Decision for you:** accept the new display and update the test and the comment above `next_day_reminder_at`. Or keep the old display with `Time.at(reminder_epoch + 86_400).localtime(reminder_at.utc_offset)`, which was verified on both versions.

Not breaking, but worth knowing:

3. **Boot warnings and new deprecations.** Sidekiq's job-wrapper log warns that the built-in `sidekiq` Active Job adapter is deprecated and will be removed in Rails 8.2. Active Storage warns that variant generation needs `image_processing`.
4. **Schema dump.** `db:migrate` rewrites `db/schema.rb` with `Schema[8.1]`, alphabetised columns and `pg_catalog.plpgsql`. No DDL changes. A 7.0 app cannot load that header, so do not commit the regenerated schema before deciding to roll forward. All 12 migrations ran from scratch on 8.1.
5. **Environments.** `config.cache_classes` still works on 8.1. Production boot with eager loading succeeded. `assets:precompile` succeeded on 8.1 using `SECRET_KEY_BASE_DUMMY=1`. Precompile could not be run on 7.0 because it does not support that variable.

## C. Rollout and rollback (tested with real Sidekiq processes, development environment)

**7.0 enqueue, 8.1 worker.** A `DigestJob`, two scheduled `NoteReminderJob`s, a `CitationEnrichmentJob` and a native `ExportJob` were enqueued under 7.0. The 8.1 worker processed all of them with nothing in retry or dead. A pending 7.0 digest still produced the UTC-day mail.

**8.1 enqueue, 7.0 worker (rollback).**
- `NoteReminderJob`, `CitationEnrichmentJob` and `ExportJob` ran fine.
- A `DigestJob` enqueued by 8.1 fails on 7.0 with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. It lands in Sidekiq retry and would eventually go to the dead set.
- A digest queued as `requested_at.utc` plus `completion.to_s` completed on 7.0. `DigestMailer` already does `BigDecimal(params[:completion])`.

**Preparatory change.** In `User#request_digest`, pass `DigestJob.perform_later(self, requested_at.utc, reading_completion.to_s)`. It is the version-neutral way to avoid both the `BigDecimalSerializer` payload and the zone-carrying payload. Its payload was confirmed under 8.1 and its processing under 7.0, but the whole suite was not run with that exact edit in place. Ship it on 7.0 first, before any 8.1 deploy.

**Stored data.**
- `notes.tags` (JSON text), `notes.settings` (jsonb) and `notebooks.preferences` (YAML) written by 7.0 read identically on 8.1.
- A legacy `!ruby/hash:ActiveSupport::HashWithIndifferentAccess` YAML value raises `Psych::DisallowedClass` on both versions, so it is not a regression. Check production with `SELECT DISTINCT LEFT(preferences, 30) FROM notebooks`.
- Rich text is unchanged. With the sanitizer and `load_defaults 7.0` as they are, a corpus covering lists, links, quotes, `<details>`, attachments and `<script>` gave byte-identical plain text and rendered HTML on 7.0 and 8.1.

**Browser smoke test.** The edit page loads on both versions with the vendored Trix 1.3.5 (14 toolbar buttons). Turbo and Stimulus load. The 8.1 build pulls Trix 2 CSS (`action_text-trix` 2.1.19), so the toolbar icons differ slightly in the screenshots, but nothing broke.

## D. Optional default adoption

The planner kept `config.load_defaults 7.0`. These settings would change behaviour if adopted:

- **`load_defaults 7.2`** sets `postgresql_adapter_decode_dates`. `Notebook#daily_note_counts` was verified to raise `TypeError: no implicit conversion of Date into String` at `Date.iso8601(day)`. Fix it before adopting.
- **`load_defaults 7.1`** sets `default_column_serializer = nil`. `serialize :preferences` has no coder, so it would need an explicit `coder: YAML` to keep reading existing rows (source-based, not run). It also sets `raise_on_assign_to_attr_readonly`, which matters for `Notebook` `attr_readonly :slug`, and the HTML5 sanitizer vendor, which changes rich text sanitising.
- **`load_defaults 8.0`** sets `strict_freshness`, which affects the `stale?(etag:, last_modified:)` call in `ExportDownloadsController`.
- **`enqueue_after_transaction_commit`** is off by default in 8.1. Do not enable it: `Citation#request_enrichment` and `Note#schedule_reminder` rely on enqueueing under the row lock and rolling back if the enqueue fails.

## E. Follow-up, not required for 8.1.0

- **Sidekiq 7.3 or later.** It is needed before Rails 8.2 and would also allow Rack 3. In `r81sk` (Sidekiq 7.3.9) two failures were observed:
  - `ExportJob.perform_async(id, { format: "markdown" })` raises because Sidekiq 7 rejects Symbol keys.
  - The `sadd` in `User#request_digest` returns an Integer, so `0` counts as truthy and the once-per-day dedupe stops working (digest test failed).
  - Expect to change `Redis::BaseError` to `RedisClient::Error` in `Notebook#request_export`, but this was not tested.
- **Minitest.** The `~> 5.25` pin is still in place. Minitest 6 on 8.1 was not tested.
- **Docs.** Update the stale 7.0 statements in `ARCHITECTURE.md` (lines 79, 188, 207), `README.md:7`, `CONTRIBUTING.md:38`, `TESTING.md:54` and `docs/references/fizzy.md:20`. The Trix 1.3.4 comment in `app/views/layouts/application.html.erb` also no longer matches the bundled Trix 2.1.19.

## F. Recommended order

1. On 7.0.8.7, ship the version-neutral patches (`/tmp/upg/prep_70_compatible.patch`) together with the digest argument change from section C.
2. Optionally pass through 7.1 and 7.2 to surface deprecations. Those hops were not tested.
3. Do the 8.1.0 step: the Gemfile bump and `json` pin, plus the non-neutral items (rows 4, 11 and 13). Decide the reminder-display question.
4. Run `bin/rails test`, `zeitwerk:check`, a production eager-load boot, `assets:precompile` and the system tests (on a machine with a browser).
5. Drain the Sidekiq queues, or at least the digest jobs, before any rollback.

## Unverified

- Direct uploads of images through Trix 1.3.5 with Action Text 8.1 JS.
- System tests (Selenium needs a display).
- Rack 3 and Puma 6 (Sidekiq 6.5.12 pins Rack 2).
- The `bin/citation-provider` stub on newer Rack.
- Production data shapes (YAML preferences).
- Behaviour on intermediate Rails versions.

## Open questions

- Is the reader-local reminder display acceptable, or should the old fixed-offset display stay?
- Is any deployment script relying on `config/secrets.yml` or on `Rails.application.secrets`?

---

Commentary: the planner's digest item was labelled "rows 17 and 18 combined", which does not match the 16-row table in section A. I relabelled it as B.1 and changed nothing else. I did not independently re-run any experiment. The evidence files under `/tmp/upg` are the planner's.
