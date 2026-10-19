# Plan for upgrading Rails 7.0.8.7 to 8.1.0 in Margin Notes

**Summary:** don't jump straight to 8.1.0. Ship 14 compatible fixes on 7.0 first, then upgrade one Rails version at a time. Changing only the version number breaks the app: it won't boot on 7.1, many tests fail on 7.2, and on 8.1.0 routes don't load. With all fixes applied, the full suite (46 tests) passed on 7.0, 7.1.6, 7.2.3, 8.0.5 and 8.1.0. The biggest remaining risks don't show up in the tests: data written by newer versions that 7.0 can't read after a rollback, and some behaviour changes. Two decisions need you: which 8.1 patch version to target, and whether 7.0 must stay a rollback target.

The `/home/user/workspace/repo` checkout is unchanged: still at commit `ab732f5`, nothing uncommitted. All experiments ran in separate copies under `/home/user/upgrade-lab`, each with its own databases, a separate Redis on port 6391 (now stopped) and its own storage and cache. The shared Redis and the `margin_notes_*` databases weren't touched. One early slip: a downloaded `rails-8.1.0.gem` landed in the repo root; it was moved to `/home/user/upgrade-lab/downloads/`.

Below, **[Executed]** means run in the lab, **[Source]** means read from upstream gem source or changelogs, and **[Proposed]** means not done yet.

## Decisions for you
1. **Target version.** On 8.1.0, Bundler picks json 3.1.0 by default, and then reading any signed or encrypted cookie fails, so every session cookie read raises an error [Executed]. 8.1.0 also lacks later security fixes (8.1.2.1, 8.1.3.1); 8.1.4 is current. Reading 8.1.4's source, it already handles json 3.x [Source]. I recommend 8.1.4. If 8.1.0 is required, add `gem "json", "< 3"` [Executed].
2. **Rollback to 7.0.** Rails 7.0 can't read Action Text attachment signatures created on 7.1 or later, so those attachments show as "missing" [Executed]. Either accept that rollbacks go to 7.1 at the earliest once 7.1 has been live, or first deploy a small 7.0-only patch so 7.0 can read them [Executed: `lab_rollback_sgid_initializer.rb`]. That patch touches a private Rails API and should be removed after 7.1.

## Path
Go 7.0.8.7 → 7.1.6 → 7.2.3 → 8.0.5 → 8.1.x, one deploy per step. Keep `config.load_defaults 7.0` throughout. Adopt newer defaults one at a time, and only once rolling back below the version that introduced each one is ruled out.

1. **On 7.0:** ship fixes 1–14, plus 18–21 if you plan to adopt the newer defaults later. Add the rollback patch if you need it. Then let the job queues turn over.
2. **7.1.6:** ship fixes 15–17 together with the version bump. In staging, turn on deprecation reporting, because production currently hides deprecations.
3. **7.2.3:** no further code changes expected. Don't adopt the 7.2 defaults.
4. **8.0.5:** only a `to_time` deprecation warning is expected.
5. **8.1:** review the `bin/rails app:update` diff, regenerate the schema, and run `zeitwerk:check` (it passed in the lab).
6. **Afterwards:** adopt new defaults one at a time, then upgrade Sidekiq.

## A. Required changes that also work on 7.0
All 14 were applied together on 7.0 and the full suite passed (`prep70-test-final.log`) [Executed].

**1. The Action Text initializer stops the app booting on 7.1** (`/home/user/workspace/repo/config/initializers/action_text.rb`)
- **Problem:** in 7.1 `ActionText::ContentHelper.allowed_tags` starts as `nil`, so the current `+=` raises at boot [Executed].
- **Trap:** the obvious fix, `allowed_tags = %w[details summary]`, would strip every other tag, including attachments, from all stored notes when they render.
- **Fix:** build the full list after initialization:
  ```ruby
  Rails.application.config.after_initialize do
    ActionText::ContentHelper.allowed_tags =
      ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a +
      [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]
  end
  ```
- **Check:** 7.0, 7.1 and 8.1 then allow the same 48 tags. Sample stored notes render the same on each, apart from signatures and attribute quoting [Executed].

**2.** `/home/user/workspace/repo/app/models/export.rb:42`: `fragments.sum` on strings raises on 7.1. Use `fragments.join`.

**3.** `/home/user/workspace/repo/app/models/note.rb:10`: the old `enum status:` syntax is removed in 8.0. Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. Method names such as `status_ready` stay the same.

**4.** `/home/user/workspace/repo/app/models/note.rb:14`: `alias_attribute :highlight_color, :color` raises on 7.2 because `color` is a `store_accessor`, not a column. Use `alias_method` for both the reader and the writer.

**5.** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12`: `where(notebooks: @notebook)` produces invalid SQL on 7.2. Use `where(notebook: @notebook)`.

**6. `Rails.application.secrets` is removed in 7.2**
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb:13`, `/home/user/workspace/repo/config/secrets.yml`, and the test helper at `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb` (lines 45, 117, 118, 122).
- **Fix:** move the file to `config/citation_provider.yml`, keeping the ERB and `.to_json` quoting. Load it with `config.x.citation_provider = config_for(:citation_provider)`. Have the provider read `Rails.configuration.x.citation_provider.to_h`. Update the test and `ARCHITECTURE.md` to match.
- **Side effect:** development sessions reset once, because the development secret file moves to `tmp/local_secret.txt`.

**7.** `/home/user/workspace/repo/app/models/import.rb:68`: `citation[:id]` is blank from 7.2 because the `citations` primary key is `doi`, so the receipt CSV shows an empty DOI. Use `citation&.doi`.

**8. A failed import saves partial data from 7.2** (`/home/user/workspace/repo/app/models/import.rb:53-56`)
- **Problem:** `return` inside a transaction now commits instead of rolling back. An import with a bad later row keeps the import and the notes saved before it [Executed].
- **Fix:**
  ```ruby
  saved = false
  transaction do
    save!
    saved = rows.all? { |row| row.note.save }
    raise ActiveRecord::Rollback unless saved
  end
  saved
  ```

**9.** `/home/user/workspace/repo/app/models/note.rb:61`: scheduling a reminder with a numeric `wait_until` raises on 7.2. Use `Time.at(reminder_epoch)`; jobs are still scheduled for exactly the same moment.

**10.** `/home/user/workspace/repo/app/mailers/digest_mailer.rb:7-9`: from 7.1, jobs keep the reader's time zone on time arguments. The digest then covers the reader's local day and no longer matches its UTC reservation key (the lab subject read "October 04" instead of "October 05"). Convert with `.in_time_zone("UTC")`.

**11.** `/home/user/workspace/repo/app/models/user.rb:41`: jobs queued on 7.2 or later write BigDecimal arguments in a new format, and a 7.0 worker fails to read them [Executed]. Pass `reading_completion.to_s`; the mailer already converts it back.

**12.** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`: `form_with model: nil` is deprecated. Use `form_with(url: notes_path, ...)`.

**13.** `/home/user/workspace/repo/config/routes.rb:18`: listing two paths in one route raises on 8.1. Split it into separate `/notes` and `/journal` routes. `bin/rails routes` output on 7.0 is byte-identical before and after.

**14.** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22`: from 8.0, `.stringify_keys` turns the line-number keys into strings and the preview loses its annotations. Remove `.stringify_keys`.

## B. Changes that must ship with the 7.1 bump
These fail or misbehave on 7.0, so they can't go out early.

**15. JSON column serializer** (`/home/user/workspace/repo/app/models/note.rb:12`)
- Change `serialize :tags, JSON` to `serialize :tags, coder: JSON`.
- **Danger:** on 7.0 the new form silently writes YAML into the JSON `tags` column, which would corrupt stored data [Executed].
- **Also:** add `serialize :preferences, coder: YAML` in `/home/user/workspace/repo/app/models/notebook.rb:7`. Without it, adopting the 7.1 serializer default stops the app booting.

**16.** `/home/user/workspace/repo/config/environments/test.rb:31`: change `show_exceptions = false` to `:none`. On 7.2 `false` stops raising, so tests that expect an exception get an error page instead. On 7.0, `:none` would turn exception pages on.

**17.** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`: change `:exponentially_longer` to `:polynomially_longer`. On 7.2 the old name makes the retry fail, and the citation is left pending. The wait times are the same; the new name doesn't exist on 7.0.

## C. Dependencies
- **json:** see decision 1.
- **Sidekiq:** 6.5.12 still works on 8.1 [Executed]. Rails 8.1 deprecates its built-in Sidekiq adapter and plans to remove it in 8.2, so the Sidekiq 7 move (section F) is a follow-up, not part of this upgrade.
- **Puma and Rack:** Puma 5.6.9 with Rack 2.2.24 boots 8.1 and serves pages and assets [Executed]. Keep them for now; Sidekiq 6.5 holds Rack at 2.x.
- **Trix:** 8.1 adds the action_text-trix gem, but the vendored Trix 1.3.5 keeps working. The Trix version mentioned in the layout comment and `ARCHITECTURE.md` will be out of date.
- **Ruby:** 8.1 needs Ruby 3.2 or later; the app uses 3.3.6, so no change is needed.

## D. Optional new defaults
Running the suite with 8.1 defaults found the four problems below. Each fix also works on 7.0.

18. **Read-only slug** (`/home/user/workspace/repo/app/controllers/notebooks_controller.rb:40`): the settings form resubmits `slug`, which raises under the 7.1 read-only default. Remove `:slug` from `permit`.
19. **Activity report** (`/home/user/workspace/repo/app/models/notebook.rb:40`): under the 7.2 date-decoding default, `select_rows` returns Date objects and the report crashes. Use `Date.iso8601(day.to_s)`.
20. **Expired exports** (`/home/user/workspace/repo/app/views/exports/_export.html.erb:26`): a negative cache expiry raises under the 7.1 default. Use `[export.expires_at - Time.current, 1].max`. Don't switch to `cache_if`, because that breaks an existing test.
21. **Reminder preview** (`/home/user/workspace/repo/app/models/note.rb:44`): across a daylight-saving change, 8.1 shows the "24 hours later" time with a different offset. The underlying moment is the same. Decide which display you want; the fix that keeps today's behaviour is in the plan.

Other defaults:
- **Hold off until rollback is ruled out:** the 7.1 message format (7.0 can't read signatures written in it) and the 7.1 cache format (7.0 can't read it, or clear `tmp/cache`).
- **Skip:** the 7.2 enqueue-after-commit default. It would break the guarantee that a failed enqueue rolls back the pending state, and no test covers that.

## E. Mixed-version rollout and rollback
- **Sessions:** work in both directions between 7.0 and 8.1 while on 7.0 defaults [Executed].
- **Jobs:** jobs queued on 7.0 run on 7.1 and 8.1, and jobs queued on 8.1 run on 7.0 once fix 11 is in [Executed]. Reminders can sit in Sidekiq's schedule for months, so ship fixes 9–11 before 7.2 and inspect the queues before any rollback below 7.2.
- **Attachments:** see decision 2. Only attachments uploaded after the upgrade are affected; existing ones survive edits on 8.1 (simulated, not tested in a browser).
- **Time zones:** "Asuncion" exists only in 8.1, so a rollback breaks validation for users who chose it. "Astana" points to a zone one hour different from 7.2 on. Count the users with each value, and consider hiding Asuncion until rollback is ruled out.
- **Schema:** 8.1 rewrites `db/schema.rb` (cosmetic changes only), but 7.0 can't load the new file, so it must roll back with the code.
- **Assets:** gem asset fingerprints change, so during a rolling deploy each host must serve its own precompiled assets.
- **Unchanged:** stored tags and preferences are byte-identical across versions, and no new Active Storage or Action Text migrations are needed.

## F. Sidekiq 7 follow-up (needed before Rails 8.2)
Tested with Sidekiq 7.3.9 on 8.1: 2 failures and 3 errors before these fixes [Executed].
- **Exports fail:** Sidekiq 7 rejects the `{ format: "markdown" }` argument. Use string keys, which also work on 6.5.
- **Duplicate digests are no longer blocked, and nothing reports it:** `redis.sadd` returns `0`, which Ruby treats as true. Use `redis.call("SADD", ...) == 1`, which behaves the same on 6.5.
- **Redis errors (from source only):** the rescue in `/home/user/workspace/repo/app/models/notebook.rb:28` won't catch the new client's errors. Add `RedisClient::Error` behind a `defined?` guard.

## Still unverified
- **Browser behaviour:** direct uploads and editing with Trix 1.3.5 on 8.1, and how `details`/`summary` content behaves. The app has no system tests yet.
- **Production setup:** the cache store, number of hosts, whether they share Redis, and where the secret key comes from.
- **Data counts:** rich-text rows with signatures from each phase, Astana/Asuncion users, and long-dated reminder jobs.
- **Not run:** a full 8.1.4 test run, Sidekiq 7 with a real worker, and Rack 3 or Puma 6.
- **Version-specific:** on 7.1.6 only, text inside `<script>` tags shows up in Markdown exports. 8.1 behaves like 7.0 again.
- **Not checked:** whether editing a note on 7.0 that contains a missing attachment drops it permanently.
- **Docs:** several statements in `/home/user/workspace/repo/ARCHITECTURE.md` need updating alongside the changes.

I spot-checked part of the plan: the cited lines in the Action Text initializer, `note.rb`, `citation/provider.rb` and `routes.rb` match the code. The lab logs and scripts exist, and the final 8.1 run shows 46 runs, 340 assertions, 0 failures. The other `[Executed]` claims come from the planning agent's report and I haven't re-run them.

Everything is in `/home/user/upgrade-lab`:
- `logs/`: per-version test runs and probe results
- `scripts/`: the patch scripts and probes
- `<variant>/Gemfile.lock`: the lockfile for each tested version
- `logs/prep70-final.diff` and `logs/v81-final.diff`: the combined changes

---

**My notes:**

- **Nothing is upgraded yet.** The upgrade skill only produces a plan, so the Gemfile still pins `rails` at 7.0.8.7. I checked the repo afterwards: it's still at `ab732f5` with no uncommitted changes, and the stray `rails-8.1.0.gem` is now in `/home/user/upgrade-lab/downloads/`, not the repo.
- **You asked for 8.1.0 exactly, but the plan recommends 8.1.4.** On 8.1.0 with Bundler's default json 3.1.0, every signed or encrypted cookie read fails, and later security fixes are missing. If you need 8.1.0 itself, the workaround is to pin `gem "json", "< 3"`.
- **To go ahead, I need:**
  - which target you want: 8.1.0 with the json pin, or 8.1.4;
  - whether 7.0 has to stay a rollback target.

  With those answers, I can start with the Phase 1 fixes, which work on 7.0 and can ship before any version bump.
