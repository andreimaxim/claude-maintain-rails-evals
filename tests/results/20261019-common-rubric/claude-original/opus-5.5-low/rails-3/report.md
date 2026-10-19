# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Summary:** The upgrade is feasible, and Sidekiq 6.5, Puma 5 and Rack 2.2 can stay. With Rails 8.1.0 and no other changes, the app does not boot. After 14 small code changes and one gem pin, the full suite passes on 8.1.0 (46 runs, 0 failures, 0 deprecation warnings). Twelve of those changes also pass on 7.0.8.7 and can ship ahead of the bump.

Several problems would get past a green suite:
- **Imports:** a failed import keeps its saved rows.
- **Import receipt:** the CSV loses its DOIs.
- **Notes:** the highlight colour stops working.
- **Digest emails:** the digest covers a different day.
- **Rollback:** queued digest jobs fail on 7.0.

**Incident in the working repo.** Early on, a `gem fetch` dropped `rails-8.1.0.gem` into `/home/user/workspace/repo`. A setup command that failed partway then ran `git add -A && git commit` there and created commit `54dcbbd "base"`. I undid it right away with `git reset 9938031` and deleted that file. `git status` is clean and HEAD is `9938031` again, but the reflog still shows the stray commit. Everything after that ran only in the copy.

## Evidence base
- **From reading source:** your app's code, plus the gem source of Rails 8.1.0 as installed.
- **Executed:** everything in "Executed checks" below.
- **Proposed:** the checks at the end, not yet run.

## Executed checks
**Setup**
- **Copy:** `/tmp/upg-exp/app`, made with `git archive HEAD`, a fresh git repo inside, `mise trust`.
- **Isolated services:**
  - Its own PostgreSQL 15 cluster at `/tmp/upg-exp/pg`, port 55432, socket in `/tmp/upg-exp`.
  - Its own redis-server on port 56379.
  - Gems in `BUNDLE_PATH=/tmp/upg-exp/bundle`.
  - Storage in the copy's `tmp/`, a file cache at `/tmp/upg-exp/cache`, and `CITATION_PROVIDER_URL=http://127.0.0.1:59393`.
- **Environment variables:** `/tmp/upg-exp/env.sh`. **Logs:** `/tmp/upg-exp/logs/`.
- **Branches in the copy:**
  - `master`: the base app.
  - `rails81` (commit `4e76b86`): every change.
  - `prep70` (commit `c7db00d`): the version-neutral subset on 7.0.8.7.
- Both services are stopped now.

**Results**
1. **Baseline on 7.0.8.7:** 46 runs, 325 assertions, 0 failures (`baseline-7.0.log`). It warns about `Enumerable#sum` on strings and about Sidekiq strict args.
2. **Dependency resolution:** with `gem "rails", "8.1.0"` and `bundle update rails --conservative`, resolution succeeded (`resolve-81-conservative.log`).
   - Unchanged: sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, puma 5.6.9.
   - Added: action_text-trix 2.1.19, **json 3.0.2**, bigdecimal 4.1.3, rackup, rack-session, and others.
3. **Boot with no other changes:** fails with `NoMethodError` in `config/initializers/action_text.rb` (`boot-81-unchanged.log`).
4. **Fix-and-retest loop:** `test-81-fix1..8.log`. The final run is 46 runs, 340 assertions, 0 failures, 0 deprecation warnings.
5. **Same subset on 7.0.8.7:** 46 runs, 0 failures, no deprecations (`test-70-prep.log`).
6. **Mixed-version job payloads**, via `/tmp/upg-exp/scripts/enqueue.rb` and `consume.rb` against the real Sidekiq adapter:
   - **Queued on 7.0, read by 8.1:** every job deserializes. Old Digest payloads have no zone, so they come back in UTC (`mix-*-70*.log`, `mix-con-81-from-70.log`).
   - **Queued on 8.1, read by 7.0:** `DigestJob` fails with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known` (`mix-con-70-from-81.log`).
   - **Stored data** reads the same in both directions: the YAML `preferences`, the JSON `tags`, the jsonb `color`, and a FileStore cache entry.
7. **8.1 boot checks:**
   - `zeitwerk:check` passes.
   - Production boot passes, with eager load and the Sidekiq adapter.
   - Puma 5.6.9 dev server: `/notes` gives 302, `/session/new` gives 200 (`server-81.log`).
   - Production `assets:precompile` exits 0 (`precompile-81.log`).
   - `development.log` contains: "built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2".
8. **Schema dump on 8.1:** the header becomes `Schema[8.1]`, columns are sorted alphabetically, and the extension becomes `pg_catalog.plpgsql`. The structure is the same.

## Required changes
"Works on 7.0" means the change passed the suite on 7.0.8.7 (check 5).

1. **`ActionText::ContentHelper.allowed_tags` is nil in 8.1, so boot fails.**
   - **Where:** `config/initializers/action_text.rb`.
   - **Change:** inside `ActiveSupport.on_load(:action_text_content)`, set it to `(allowed_tags || sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`.
   - **Works on 7.0:** yes.
   - **Still to validate:** a request test that a stored `<details>` survives rendering.
2. **The `json` gem must stay below 3.0.**
   - **Why:** Active Support 8.1.0 calls `JSON.parse(json, options)` with a positional hash, and json 3.0.2 only accepts keyword arguments. Every session read raises `ArgumentError`, and every page returns 500.
   - **Change:** add `gem "json", "< 3"`, which resolved to 2.21.2. Alternatively, check whether a later 8.1.x patch fixes the call (not checked).
   - **Works on 7.0:** not tested.
3. **`enum status: {...}, _prefix: true` is removed syntax.**
   - **Where:** `app/models/note.rb:10`.
   - **Change:** `enum :status, { draft: 0, ready: 1 }, prefix: true`.
   - **Works on 7.0:** yes.
4. **`serialize :tags, JSON` must become `serialize :tags, coder: JSON`.**
   - **Where:** `note.rb:12`.
   - **Works on 7.0:** no. Rails 7.0 does not accept `coder:`, so ship this with the bump.
   - **Stored format:** unchanged (check 6).
5. **`alias_attribute :highlight_color, :color` now raises,** because `color` is a store accessor, not an attribute.
   - **Change:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.
   - **Works on 7.0:** yes.
6. **`Rails.application.secrets` was removed.**
   - **Where:** `app/models/citation/provider.rb:13`, `config/secrets.yml`, and three uses in `test/controllers/citation_enrichments_controller_test.rb`.
   - **Change:** rename the file to `config/citation_provider.yml` with the environment as the top-level key, add `config.x.citation_provider = config_for(:citation_provider)` in `application.rb`, and read `Rails.configuration.x.citation_provider.to_h`.
   - **Works on 7.0:** yes.
   - **Value handling:** the `.to_json` quoting still keeps `"00123"` as a string and returns nil for unset production values. The environment-credentials test passes.
   - **Also update:** the `ARCHITECTURE.md` text about `secrets.yml`.
7. **Multi-path `get "/notes", "/journal", to:` is no longer supported.**
   - **Where:** `config/routes.rb:18`.
   - **Change:** `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. These keep the route names 7.0 generated (checked with `bin/rails routes`).
   - **Works on 7.0:** yes.
8. **`form_with(model: nil, ...)` now raises.**
   - **Where:** `app/views/notes/index.html.erb:12`.
   - **Change:** remove `model: nil`.
   - **Works on 7.0:** yes.
9. **`config.action_dispatch.show_exceptions = false` must become `:none`.**
   - **Where:** `config/environments/test.rb`.
   - **Why:** on 8.1, `false` renders 500 pages instead of raising, so the `RecordNotFound` tests fail.
   - **Works on 7.0:** no. On 7.0 a truthy `:none` means "show exceptions", so ship this with the bump.
10. **`retry_on wait: :exponentially_longer` was removed.**
    - **Where:** `app/jobs/citation_enrichment_job.rb:7`.
    - **Change:** `wait: ->(executions) { executions**4 + 2 }`. It keeps the old delay curve without jitter. `:polynomially_longer` does not exist on 7.0.
    - **Works on 7.0:** yes.
11. **`fragments.sum` on strings raises `TypeError`,** because Active Support's `Enumerable#sum` override is gone.
    - **Where:** `app/models/export.rb:42`.
    - **Change:** `fragments.join`.
    - **Works on 7.0:** yes, and it also clears the 7.0 deprecation.
12. **`set(wait_until: Integer)` raises `NoMethodError utc`.**
    - **Where:** `note.rb:61`.
    - **Change:** `set(wait_until: Time.at(reminder_epoch))`.
    - **Works on 7.0:** yes.
13. **`where(notebooks: @notebook)` now reads `notebooks` as a column,** which fails with `PG::UndefinedColumn`.
    - **Where:** `app/controllers/notes_controller.rb:18`.
    - **Change:** `where(notebook: @notebook)`.
    - **Works on 7.0:** yes.
14. **Changes that keep current behavior.** Tests catch some of these only by chance; none would raise an error:
    - **a. Imports half-save.** `return false` inside `transaction` rolls back on 7.0 but commits on 7.1 and later, so a failed import keeps its saved rows. Use `applied = transaction { save!; raise ActiveRecord::Rollback unless rows.all? { |r| r.note.save }; true }; applied == true`. A plain `return true` would roll back on 7.0. **Works on 7.0:** yes.
    - **b. Receipt CSV loses DOIs.** `Import#receipt` uses `citation[:id]`, which is nil on 8.1 because the primary key is `doi`. Use `citation&.doi`. **Works on 7.0:** yes.
    - **c. Preview drops annotations.** `@import.annotations.stringify_keys` in `app/views/imports/preview.html.erb` now really turns the keys into strings, so lookups by integer line return nothing. Drop `.stringify_keys`. **Works on 7.0:** yes.
    - **d. Digest covers a different day.** The Time-with-zone job serializer now keeps the reader's zone, so `DigestMailer` would use the reader's local day instead of the UTC day documented in the view hint and in `User`. Add `requested_at = requested_at.utc`. **Works on 7.0:** yes. Adopting the local day instead is a product decision; you would then also change the Redis reservation key and the hint.
    - **e. Next-day reminder preview changes.** `to_time` now keeps the zone, so `next_day_reminder_at` displays across a DST change differently than the test expects. The stored epoch is not affected. To keep the current fixed-offset display, use `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. **Works on 7.0:** yes.

## Rollout and rollback risks
- **Rollback breaks queued digest jobs.** Rails 8.1 always writes `BigDecimal` job arguments with `BigDecimalSerializer`, which 7.0 cannot read (check 6).
  - **Effect:** `DigestJob`, which passes `reading_completion`, would fail on any 7.0 worker after a rollback or during a mixed deploy. It has no `discard_on`, so Sidekiq retries it until it lands in the dead set.
  - **Preparatory fix (proposed, not run):** pass `reading_completion.to_s` from `User#request_digest`. The mailer already calls `BigDecimal(...)`, and 7.0 already wrote `"0.0"` as a string.
  - **Ordering:** ship it before the bump, then switch workers before web.
- **Mixed versions, other directions:** 7.0 payloads read on 8.1 work, but with UTC zones; 14d makes both behave the same.
  - **Extra keys:** 8.1 adds `scheduled_at` and nanosecond `enqueued_at`, which 7.0 ignores.
  - **Already-scheduled `NoteReminderJob`:** those jobs keep working.
- **Stored data:** YAML `preferences`, JSON `tags`, jsonb `settings`, and cache entries read the same in both directions as long as `load_defaults 7.0` stays.
- **Schema file:** a `Schema[8.1]` file cannot be loaded by 7.0. Don't commit a regenerated `db/schema.rb` until rollback is no longer an option. There are no migrations in this upgrade.
- **Sessions (from source, not tested):**
  - Production cookies should stay compatible, because cookie settings come from `load_defaults 7.0`.
  - Development's secret file moved from `tmp/development_secret.txt` to `tmp/local_secret.txt`, which likely signs out local sessions.

## Optional (not required)
- Raise `load_defaults` one step at a time (7.1 → 8.1) using `new_framework_defaults` files. Two of them change stored or queued data:
  - The 7.1 cache format and message serializers are unreadable by 7.0.
  - The HTML5 sanitizer would change how rich text renders.
- `enqueue_after_transaction_commit` defaults to false in 8.1, which keeps the app's enqueue-under-row-lock design. Don't turn it on: `perform_later` would no longer fail inside the lock and roll it back.
- Before 8.2: move to Sidekiq 7.3.3 or later and its own adapter. That move would also need:
  - **`User#request_digest`:** redis-client's `sadd` returns an Integer, so `0` is truthy and every request would send a digest.
  - **`ExportJob` arguments:** the symbol-key `{ format: "markdown" }` hash fails strict arguments.
  - **`Notebook#request_export`:** `rescue Redis::BaseError` no longer catches redis-client errors.
- Optional cleanups:
  - `config.cache_classes` can become `enable_reloading`.
  - `:unprocessable_entity` will become `:unprocessable_content` when Rack 3.1 arrives.
  - Add `csv` to the Gemfile before Ruby 3.4.

## Proposed checks (not run)
- **System tests (`bin/rails test:system`), which need Chrome.** The layout loads the vendored `trix-1.3.5.js`, while `require trix` and `@rails/actiontext` now come from Trix 2 (action_text-trix). Check:
  - Editing.
  - Attachment uploads.
  - Styling.
  - That stored rich text, including `<details>`, stays intact.
- **A cross-version session cookie test** with the production `SECRET_KEY_BASE`.
- **Running `DigestJob` again in both directions** after the `.to_s` change.
- **Draining a 7.0-era Sidekiq retry set and scheduled set** on 8.1 in staging.
- **A request test for the import receipt CSV,** checking the DOIs are present, plus a model test that a failed import saves nothing. Both should fail before the 14a and 14b fixes.

## Unverified claims and open questions
- Whether a later 8.1.x patch fixes the json 3 problem.
- The exact Rails release that introduced each change listed above. I confirmed them by behaviour on 8.1.0, not from changelogs.
- Whether you want the digest day and reminder preview kept as they are (my changes keep them) or moved to the new behaviour.
- How you deploy. The worker/web ordering above assumes separate Sidekiq and web processes, and I have not seen the production queue backlog.

---

**Working repo check:** I re-checked the incident myself. `git status` in `/home/user/workspace/repo` is clean, and HEAD is `9938031` on `main`. The stray `54dcbbd "base"` commit now shows up only in the reflog and isn't on any branch. You can leave it there or expire it with `git reflog expire`. All the experiment work is in `/tmp/upg-exp/` (logs in `/tmp/upg-exp/logs/`), and you can delete that folder.
