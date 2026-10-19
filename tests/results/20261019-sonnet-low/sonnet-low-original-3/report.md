# Plan: upgrade `rails` 7.0.8.7 to 8.1.0 in Margin Notes

I haven't changed the working app. The planner reported that it couldn't launch the `gem-upgrade-planner` subagent and did the analysis itself, and I haven't re-checked the plan.

## Verdict

The upgrade works, but it is not a plain version bump.

- **Baseline:** the unmodified 7.0.8.7 copy passes 46 runs, 325 assertions.
- **Bump only:** with just `rails 8.1.0` in the Gemfile, the app does not boot.
- **After the code fixes below:** the experiment copy passes 46 runs, 340 assertions, 0 failures. `zeitwerk:check` passes, `CI=1` eager-loaded tests pass, and the production `assets:precompile` succeeds.
- **Coverage gap:** findings 3, 5, 6 and 7 either have no failing test or only a partial one. Existing tests also encode the old behavior in two places. The digest test expects the UTC day, so the fix went in the mailer rather than the test. The reminder test (`test/controllers/reminders_controller_test.rb`) caught the DST preview change.

## Experiment record

- **Copies:** baseline in `/tmp/upg/base` (7.0.8.7) and upgrade in `/tmp/upg/r81` (8.1.0). `mise.toml` was deleted from both copies.
- **Isolation:** separate Postgres databases, a private redis-server on port 6391 (since shut down), each copy's own `tmp/` and `storage/`, and Ruby 3.3.6 via `/tmp/upg/env.sh`.
- **Resolved dependencies** (`/tmp/upg/r81/Gemfile.lock`):
  - rails and all components 8.1.0; rack 2.2.24 (unchanged); puma 5.6.9; sidekiq 6.5.12; redis 4.8.1; minitest 5.27.0.
  - New transitive gems: rackup 1.0.1, rack-session 1.0.2, action_text-trix 2.1.19, bigdecimal 4.1.3, json.
  - json resolved to 3.1.0 and had to be pinned to `< 3` (finding 1); it then resolved to 2.21.2.
- **Logs:** `/tmp/upg/base.log`, `/tmp/upg/r81_run1.log` to `/tmp/upg/r81_run8.log` (run 8 has one remaining failure, the digest date), `/tmp/upg/r81_precompile.log`, and the server and sidekiq logs in `/tmp/upg/out/`.
- **Artifacts:** the full experimental patch is `/tmp/upg/out/r81_experiment.diff`. The job-payload experiment files are in `/tmp/upg/out/`.
- **Not tested:** system tests and any browser (`test/system` is empty; no Chrome available). Production runtime was not exercised (assets only).

## Required changes

Each was reproduced and fixed in the copy. "Also works on 7.0" means the agent confirmed or reasoned that the same code is valid on the current version, so it can ship before the bump. The edits were only run on 8.1; the 7.0 claims are source-based.

1. **json 3.x incompatibility.**
   - Affects: `Gemfile`.
   - Failure: ActiveSupport 8.1.0 calls `JSON.parse(json, options)` with a positional hash. Unconstrained resolution picks json 3.1.0, which raises "given 2, expected 1". This broke every `serialize :tags, coder: JSON` read.
   - Fix: add `gem "json", "< 3"`, or use a later 8.1.x patch (not verified).
2. **`config/initializers/action_text.rb` crashes at boot.**
   - Failure: `ActionText::ContentHelper.allowed_tags` is now `nil`, so `+=` raises NoMethodError.
   - Fix: compute the base list as `allowed_tags || (sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"])`, then add `details` and `summary`. Do not assign the two tags alone; that would silently strip all other tags.
   - Also works on 7.0.
3. **`Rails.application.secrets` removed** (`app/models/citation/provider.rb`, `config/secrets.yml`, and the test's `with_provider`).
   - Fix: move to `config/citation_provider.yml` read with `config_for`, exposed as `config.x.citation_provider`. Keep the `.to_json` ERB quoting so the credential-passthrough test still passes.
   - Also works on 7.0. Update the docs that mention `secrets.yml` (`CONTRIBUTING.md`, `ARCHITECTURE.md`, `bin/citation-provider`).
   - Production secret-key resolution is unaffected: `secrets.yml` never held `secret_key_base`.
4. **`Note` model.**
   - `enum status: {...}, _prefix: true` becomes `enum :status, {...}, prefix: true`. Also works on 7.0.
   - `serialize :tags, JSON` becomes `serialize :tags, coder: JSON`. **Not valid on 7.0**; make this change in the upgrade PR.
   - `alias_attribute :highlight_color, :color` (on a `store_accessor`) raises. Replace with `alias_method` for the reader and writer. Also works on 7.0.
   - `serialize :preferences` in `notebook.rb` (YAML default) worked unchanged in tests.
5. **`config/routes.rb`: `get "/notes", "/journal", to:` raises.**
   - Fix: two `get` lines. `bin/rails routes` shows the same route names, `notes` and `journal`. Also works on 7.0.
6. **`Import#apply` now commits partial data.** This is the highest-severity finding.
   - Cause: `return false` inside `transaction do` rolled back on 7.0 but commits on 8.1.
   - Reproduced: an import with an invalid row saved the import and some notes (record counts `[1,4,1,2]` versus the expected `[0,3,0,1]`). The failing test is `test/controllers/imports_controller_test.rb:48`.
   - Fix: raise `ActiveRecord::Rollback` and return the result. Also works on 7.0.
7. **Silent behavior changes found by failing tests, with no loud error.** All three fixes are also valid on 7.0.
   - `Import#receipt`: `citation[:id]` is now nil for the string primary key `doi`. Use `citation.doi`.
   - `imports/preview.html.erb`: `HashWithIndifferentAccess#stringify_keys` now turns integer keys into strings, so annotations disappear from the preview. Drop `.stringify_keys`.
   - `notes_controller.rb`: `where(notebooks: @notebook)` is now an invalid column. Use `where(notebook: @notebook)`.
8. **API removals and deprecations.**
   - `CitationEnrichmentJob`: `wait: :exponentially_longer` becomes `:polynomially_longer`. Same delay formula, but **not valid on 7.0**.
   - `Export#generate`: `fragments.sum` becomes `fragments.join`. 7.0 already deprecates this.
   - `Note#schedule_reminder`: `wait_until: reminder_epoch` (an Integer) now raises on `.utc`. Use `Time.at(reminder_epoch)`. Also works on 7.0.
   - `notes/index.html.erb`: `form_with(model: nil, ...)` raises. Drop `model: nil`. Also works on 7.0.
   - `config/environments/test.rb`: `show_exceptions = false` no longer re-raises, so request tests got 500s instead of exceptions. Use `:none`. **Not valid on 7.0**, which treats a truthy value as "show".
9. **Time-zone behavior changes.**
   - `DigestMailer`: ActiveJob now serializes the zone, so the worker no longer deserializes `requested_at` as UTC. The digest subject and `all_day` window moved from Oct 5 to Oct 4 in the test. To keep the documented UTC-day behavior, use `requested_at.utc.to_date` and `requested_at.utc.all_day`. Also works on 7.0.
   - `Note#next_day_reminder_at`: `TimeWithZone#to_time` now returns a time in the zone. The "keeps the reminder's UTC offset" preview changed from `-04:00` to `-05:00` (the stored epoch is identical). To preserve it, use `Time.at(reminder_epoch + 86_400).localtime(reminder_at.utc_offset)`. Also works on 7.0.
   - Decide whether the old offset display or the new local wall time is the intended product behavior. The experiment preserved the old.

## Rollout and rollback handling (queued work)

The agent enqueued real payloads in each version and consumed them in the other.

- **7.0 payloads read by an 8.1 worker:** all three jobs deserialize. `DigestJob` receives `"0.5"` as a string, and the mailer's `BigDecimal(params[:completion])` handles it.
- **8.1 payloads read by a 7.0 worker (rollback or mixed deploy):** `DigestJob` fails with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. 8.1 wraps BigDecimal in a serializer hash; 7.0 sends a plain string.
- **Time-zone key:** 8.1 also adds `time_zone` to the TimeWithZone payload. A 7.0 worker ignores it, so the digest day depends on which version enqueued it.
- **Preparatory change (also works on 7.0):** pass `reading_completion.to_s` from `User#request_digest` and pass `requested_at.utc` from there. Both versions then read the same shape. Deploy this and let the queue drain before the bump.
- **Sidekiq retry path:** a Sidekiq-retried `CitationEnrichmentJob` and `NoteReminderJob` payload deserialized fine in both directions.
- **Scheduled jobs:** `scheduled_at` appears in 8.1 payloads, and 7.0 ignores it. A 7.0 worker executing an 8.1 scheduled payload was not tested end to end.
- **Native Sidekiq `ExportJob`:** unchanged by Rails.
- **Sessions:** a session cookie created by 7.0 was accepted by 8.1 and the reverse, in dev with the same `SECRET_KEY_BASE`. Production resolves the secret from ENV and then credentials in both versions (source-based).
- **Stored data:** the schema, Active Storage and Action Text tables work unchanged. `db:schema:dump` on 8.1 only reorders columns, switches to `Schema[8.1]` and writes `pg_catalog.plpgsql`. Do not commit that dump as part of the bump.

## Optional and follow-up items

- **Sidekiq built-in adapter deprecation:** the Sidekiq worker logged "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2. Please upgrade `sidekiq`". Plan a Sidekiq 7.3+ upgrade as a separate task (untested).
- **Trix and Action Text front end (unverified, browser-only):**
  - The layout loads vendored Trix 1.3.5 and its comment says Action Text 7.0 bundles a broken 1.3.4.
  - Rails 8.1 ships Trix 2.1.19 and `actiontext.css` requires its CSS, so the vendored JS no longer matches.
  - The `@rails/actiontext` pin points at the UMD `actiontext.js`; the 8.1 install ships `actiontext.esm.js` too.
  - Precompile succeeds, but the editor, attachments and existing note bodies were not tested in a browser. Run a browser check, then likely remove the vendored file and pins.
- **Rack stays on 2.2.24.** The 8.1.0 gemspec allows it and puma 5.6.9 served pages, so Rack 3, puma 6 and `load_defaults` 8.1 are all optional. The test helper uses `Puma::Server.new(app, Puma::Events.strings)`, which is Puma 5 API, so a puma bump needs a test change.
- **`config.load_defaults 7.0`:** keep it for this upgrade. 7.1 and later defaults change the sanitizer to HTML5, transaction return behavior and serialization, so adopt them separately.
- **Other gems not examined:** `concurrent-ruby` 1.3.4 (pinned for 7.0), `redis` 4.8.1, and `csv` becoming a bundled gem in Ruby 3.4.

## Recommended sequence

1. Ship the changes that also work on 7.0 as one PR: items 2, 3, 4 (enum and `alias_method` only), 5 to 7, the `sum`, `wait_until` and `form_with` fixes in 8, the digest and reminder changes in 9, and the `request_digest` argument change.
2. Let the queue drain.
3. Ship the bump PR: `rails 8.1.0`, the json pin, `serialize coder:`, `polynomially_longer`, and `show_exceptions = :none`.
4. Verify:
   - The import rollback test (`imports_controller_test.rb:48`).
   - A digest and a reminder enqueued during the mixed window.
   - A browser pass on Trix.

## Unverified

- Behavior of json 3.x with a later 8.1.x patch.
- Production runtime (only precompile was run).
- Browser and system behavior.
- Whether `show_exceptions = false` behaves identically in dev/prod.
- Rollback with scheduled (not just enqueued) payloads.
- The rollback behavior of the proposed `.to_s`/`.utc` payload change (reasoned from the 7.0 payload format, not run).

The full experimental patch is at `/tmp/upg/out/r81_experiment.diff`. I can implement this in the repo, starting with the 7.0-compatible PR, if you want.
