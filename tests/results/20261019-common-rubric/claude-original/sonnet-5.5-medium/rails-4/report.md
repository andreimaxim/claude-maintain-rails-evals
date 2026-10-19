# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The planner subagent could not use `maintain-rails:gem-upgrade-planner` in its session, so it did the analysis directly. I have not re-run any of its experiments. I have not opened `/tmp/up` or confirmed it still exists, and I did not check the working application for changes. The plan below is its report.

Legend: **[X]** executed in a disposable copy, **[S]** read from upstream source only, **[P]** proposed and not run.

## Summary

- **Resolution:** Bundler resolves `rails 8.1.0` with every pinned gem (puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, pagy, faraday, sprockets-rails, bcrypt, minitest 5.x). Ruby 3.3.6 satisfies Rails 8.1.
- **Failure on a naive bump:** it fails at boot, then in tests, and several defects are silent data or behavior changes.
- **Test status:** after the changes below, 46 of 46 tests pass on 8.1.0, with no deprecation output.
- **Preparatory changes:** most work on 7.0.8.7 too. A copy of the current app with them applied also passes 46 of 46 tests on 7.0.8.7. Items 4, 6 and 10 each include a part that is 8.x-only.
- **Test coverage:** the suite catches the boot and most Active Record breaks. It does not cover the job-payload, rollback, default-adoption, or browser concerns below.
- **Rollback hazard:** BigDecimal job arguments written by 8.1 cannot be read by a 7.0 worker. See "Mixed-version rollout and rollback".

## Required changes

**1. Boot failure: `ActionText::ContentHelper.allowed_tags` is nil [X]**
- Affected: `config/initializers/action_text.rb` (`allowed_tags += %w[details summary]`).
- Applies on boot. In 8.1 the accessor defaults to nil and the safe list is computed lazily.
- Recommend:
  ```ruby
  ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]
  ```
  This also works on 7.0.
- Validate: `test_rich_text_keeps_collapsible_excerpts_and_drops_unsafe_markup` passes. A cross-version read of the same stored body gave identical rendered HTML and plain text.

**2. Boot failure: `Rails.application.secrets` is removed [X]**
- Affected: `app/models/citation/provider.rb:13`, `config/secrets.yml`, and `test/controllers/citation_enrichments_controller_test.rb` (the stubbing helper).
- Recommend: `config.x.citation_provider = config_for(:secrets).citation_provider` in `config/application.rb`, then read `Rails.configuration.x.citation_provider`. This also works on 7.0.
- Move to a plainly named config file later. `ARCHITECTURE.md` lines 79-80 and `CONTRIBUTING.md` line 38 reference `Rails.application.secrets` and need updating.

**3. Boot failure: `get "/notes", "/journal", to:` [X]**
- Affected: `config/routes.rb:18`. Multiple paths in one `get` raise.
- Recommend two `get` lines. Verify that `notes_path` and `journal_path` both still resolve; both did in the experiment copy. This also works on 7.0.

**4. Boot failure: keyword `enum` and positional `serialize` [X]**
- Affected: `app/models/note.rb`.
  - `enum status: {...}, _prefix: true` becomes `enum :status, {...}, prefix: true`. This works on 7.0.
  - `serialize :tags, JSON` becomes `serialize :tags, coder: JSON`. **This does NOT work on 7.0.8.7**, so apply it in the upgrade commit.
- Stored `tags` text is unchanged JSON. Tags were written on one version and read on the other, in both directions.

**5. Boot failure: `alias_attribute :highlight_color, :color` [X]**
- Affected: `app/models/note.rb`. `color` comes from `store_accessor`, not a column, and now raises.
- Recommend `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. This works on 7.0.
- The form and strong-params assignment still pass in the suite.

**6. Silent: `show_exceptions = false` is treated as `:all` [X]**
- Affected: `config/environments/test.rb:31`.
  - The test env now renders error pages instead of raising. Four "another reader's X cannot be reached" tests failed with "RecordNotFound expected but nothing was raised".
  - A fifth test failed because a stubbed Redis error rendered as a 500 instead of raising.
- Recommend `:none` to keep raising. **`:none` is not understood by 7.0**, so apply it in the upgrade commit. Do not use `:rescuable`: it would turn these into 404 responses.
- Production is unaffected because it does not set the option.

**7. Silent: `HashWithIndifferentAccess#stringify_keys` now returns string keys [X]**
- Affected: `app/views/imports/preview.html.erb`, which does `@import.annotations.stringify_keys` and then looks up by an integer line number.
- On 8.1 every annotation silently disappears from the preview. Only the test's text match revealed it.
- Recommend dropping `.stringify_keys`. This works on 7.0.
- Validate: `#line_3 dd` shows "Second reading".

**8. Silent: `return` inside a `transaction` block commits [X]**
- Affected: `Import#apply` (`return false unless row.note.save` inside `transaction do`).
  - On 8.1 an invalid row now commits the Import and the earlier rows. This is a partial import.
  - The test showed `record_counts` going from `[0,3,0,1]` to `[1,4,1,2]`.
- Recommend:
  ```ruby
  transaction { save!; rows.all? { |row| row.note.save } || raise(ActiveRecord::Rollback) } || false
  ```
  This works on 7.0.
- Validate: "applying them saves nothing" passes on both versions.

**9. Silent: `Model#[]` with `:id` no longer maps to the custom primary key [X]**
- Affected: `Import#receipt` uses `citation[:id]`. `Citation`'s primary key is `doi`.
- The CSV receipt's `doi` column becomes blank. The 7.0 output was `On idleness,10.1000/Essays.1`; 8.1 gave `On idleness,`.
- Recommend `citation&.doi`. This works on 7.0.

**10. Runtime errors in Active Record and Active Job [X]**
- `NotesController#index`: `@notes.where(notebooks: @notebook)` generates `notes.notebooks`.
  - Recommend `where(notebook: @notebook)`. The SQL is equivalent and it works on 7.0.
  - Validate: the notebook, status, and title filter test.
- `Export#generate`: `fragments.sum` over strings raises `TypeError` once the Rails 7.0 `Enumerable#sum` override is gone.
  - Recommend `fragments.sum("")` (or `join`). It also removes the 7.0 deprecation. Works on 7.0.
- `Note#schedule_reminder`: `wait_until: reminder_epoch` with an Integer raises `undefined method 'utc' for Integer`, so scheduling returns a 500.
  - Recommend `Time.at(reminder_epoch)`. Works on 7.0.
  - The test adapter still shows `at` as the epoch.
- `form_with(model: nil, url:)` in `notes/index.html.erb` raises. Drop `model: nil`. Works on 7.0.
- `CitationEnrichmentJob`: `wait: :exponentially_longer` is removed. Use `:polynomially_longer`, which has the same formula. **This does NOT work on 7.0.8.7.** Apply it in the upgrade commit.

**11. Gem constraint: `json` 3.x breaks 8.1.0 [X]**
- On a fresh resolve Bundler picks `json 3.0.2`, because the old lock had no `json` entry (Ruby's default gem was used).
- `ActiveSupport::JSON.decode` in 8.1.0 and 8.1.1 calls `JSON.parse(json, options)`, which fails on json 3.0 with "wrong number of arguments". This broke session cookies, `serialize` loads, and more.
- 8.1.4 fixed it, based on a source read of `decoding.rb` in 8.1.1 and 8.1.4 [S]. The requested version is 8.1.0, so add `gem "json", "< 3"`; the lock resolved `json 2.21.2`.
- Other lock changes:
  - Added: `action_text-trix 2.1.19`, `bigdecimal 4.1.3`, `drb`, `rack-session`, `rackup`, `securerandom`, `uri`, `useragent`, `webrick`.
  - Removed: `method_source`.
  - `net-imap` moved from 0.6.7 to 0.6.8.
- Rack stays at 2.2.24, since actionpack 8.1 allows rack >= 2.2.4.

## Behavior changes that need a product decision

**12. DigestMailer date follows the reader's zone for newly queued jobs [X]**
- Affected: `app/mailers/digest_mailer.rb`. The mailer derives the day from `requested_at.to_date` and `all_day`.
- Active Job 7.1 and later add a `time_zone` key to serialized `TimeWithZone` values, so the worker no longer sees UTC.
- Effect: the 8.1 payload for a reader at 23:30 Eastern on 4 Oct produced subject "October 04" instead of "October 05". Digest content (ready notes updated that day) and subject would shift to the reader's local day.
- The app's documented rule and the Redis reservation key are both the UTC day.
- Recommend `requested_at = requested_at.utc` at the top of the mailer. It is correct on both versions and for old payloads that lack `time_zone`.
- An old 7.0 payload run on 8.1 still gave "October 05".

**13. The next-day reminder preview changes representation [X]**
- Affected: `Note#next_day_reminder_at`, which uses `reminder_at.to_time + 86_400`.
- In 8.1 `TimeWithZone#to_time` always follows the zone, because `to_time_preserves_timezone` is deprecated and ignored. The preview became `2026-11-01T08:00:00-05:00` instead of `09:00:00-04:00`. It is the same instant, and the stored epoch is unchanged.
- To keep the existing display and test, use `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`. This works on both versions.
- Or accept the zone-correct display and update the test and comment. That is a product choice.

## Mixed-version rollout and rollback [X unless marked]

The two versions were run side by side against one database and Redis, with Sidekiq 6.5.12 workers on each.

- **7.0 payloads on an 8.1 worker:** `DigestJob`, `CitationEnrichmentJob`, `ExportJob` (native Sidekiq), and `NoteReminderJob` all ran. The digest rendered the UTC date.
- **8.1 payloads on a 7.0 worker (rollback):**
  - `DigestJob` fails permanently, and Sidekiq retries until it is drained:
    `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`
  - The other three ran.
  - Cause: Active Job 7.1 added a BigDecimal serializer, and `request_digest` passes a `BigDecimal` completion.
  - Recommend, in a preparatory commit, passing `reading_completion.to_s`. This works on 7.0. `DigestMailer` already does `BigDecimal(params[:completion])`, so the payload is identical on both versions.
  - Otherwise, drain the digest queue before a rollback.
- **Data compatibility, cross-read and written in both directions:** session cookies, rich-text bodies, `sgid` attachments, YAML `preferences`, JSON `tags`, and jsonb `settings`.
- **Download response headers:** the `ETag` and `Last-Modified` for an export download were identical on 7.0 and 8.1.
- **No new Active Storage or Action Text migrations.** The engine migrations are identical. `db:migrate` from empty works on 8.1. `schema.rb` re-dumps with alphabetized columns and `pg_catalog.plpgsql`, which is only churn.
- **Secret key base:** cross-version tests need the same `secret_key_base`. In dev and test it comes from a local file that differs by version, which was an experiment artifact. In production it is one value.
- **Rollback of code changes:** the commits that don't use 8.x-only syntax are safe on 7.0. Items 4 (`coder:`), 6 (`:none`), and 10 (`:polynomially_longer`) must be reverted with the Gemfile.

## Optional default adoption (`config.load_defaults 7.0` stays)

- `load_defaults` is unchanged, so none of this is required. An 8.1 default does not change the job `enqueue_after_transaction_commit` behavior: its default is `false` in the Active Job source. `Citation#request_enrichment` and `Note#schedule_reminder` enqueue inside `with_lock` and depend on that, so do not enable it casually.
- The suite was run with `load_defaults 8.1`, which gave four distinct breaks:
  - `serialize :preferences` without a coder raises. Use `coder: YAML`. The stored text is unchanged.
  - `attr_readonly :slug` raises on assignment. `NotebooksController` resubmits the slug and relies on it being ignored.
  - The `_export.html.erb` `cache ..., expires_in: export.expires_at - Time.current` raises "Cache expiration time is invalid, cannot be negative".
  - `Notebook#daily_note_counts` fails because the date column is now a `Date`, not a string.
- Not run and still to be assessed [S]:
  - The cookie and message serializer changes.
  - The sanitizer vendor change to HTML5.
- Adopt these one flag at a time, after the rollout settles.

## Dependencies and front end [X]

- **Puma 5.6.9:** `bin/rails server` boots on 8.1.
- **Sidekiq 6.5.12 and redis 4.8.1:** real enqueue and worker runs work. The `Redis#sadd` and `srem` deprecations come from redis 4.8, not Rails.
- **Assets:** `assets:precompile` succeeds in production. `zeitwerk:check` passes in test and production.
- **Trix:** Action Text 8.1 now depends on `action_text-trix` 2.x, but the app still loads a vendored Trix 1.3.5 classic script. The `trix.css` it requires is now the Trix 2 stylesheet.
  - In a browser on both versions, the toolbar has 14 buttons, the editor renders, and inserting a file uploads it and sets its `sgid`.
  - Toolbar icons render slightly lighter on 8.1. The visual difference looked cosmetic.
- **Unchanged:** `has_secure_password`, Pagy, Faraday, and Turbo/Stimulus pins show no differences.

## Remaining questions and unverified claims

- There are no system tests (`test/system/.keep` only), so browser behavior was only smoke-checked.
- Not tested: production load, a real Redis outage, Rack 3, Minitest 6 (the `~> 5.25` pin and its comment are untouched), and a stepwise 7.1, 7.2, 8.0 upgrade (the direct jump was tested).
- Whether the product wants the reader-local digest day (item 12) and the zone-correct next-day display (item 13) is a decision for you.
- Update `ARCHITECTURE.md`, `CONTRIBUTING.md`, and `TESTING.md` (Minitest note) when the upgrade lands, per the repo's guidance rules.

## Experiment record

- **Disposable copies:** `/tmp/up/base` (7.0.8.7), `/tmp/up/base_prep` (7.0 plus the compatible changes), `/tmp/up/app` (8.1.0 patched), `/tmp/up/app81d` (`load_defaults 8.1`).
- **Isolation:** a private Redis on port 6390 and separate Postgres databases, now shut down and dropped. Gems were installed under `BUNDLE_PATH=/tmp/up/bundle`.
- **Test command:** `RAILS_ENV=test DATABASE_URL=postgres:///mn_up_test REDIS_URL=redis://localhost:6390/0 BUNDLE_PATH=/tmp/up/bundle bin/rails test`.
- **Dependency locks:** `/tmp/up/Gemfile.lock.orig` and `/tmp/up/Gemfile.lock.81`.
- **Diffs:**
  - `/tmp/up/experiment_81_full.diff` has the 8.1 changes.
  - `/tmp/up/prep_on_70.diff` has the version-neutral changes that pass on 7.0.
- **Logs:**
  - `/tmp/up/base.log` is the 7.0 baseline (46 of 46).
  - `/tmp/up/up_plain.log` through `/tmp/up/up_v8.log` show the 8.1 progression.
  - `/tmp/up/up81_defaults2.log` is the `load_defaults 8.1` run.
  - `/tmp/up/worker_70_to_81.log` and `/tmp/up/worker_81_to_70.log` are the cross-version Sidekiq runs.
  - `/tmp/up/server_70.log` and `/tmp/up/server_81.log` are the dev servers.
- **Scripts:** `/tmp/up/scripts/` (`enqueue.rb`, `probe.rb`, `etag.rb`, `seed.rb`).
- **Screenshots:** `/tmp/up/editor_70.png` and `/tmp/up/editor_81.png`.

## Commentary

- Nothing was implemented, and I made no changes to the working application at `/home/user/workspace/repo`. The subagent says its experiments ran only in the `/tmp/up` copies. I did not verify this.
- I edited the subagent's report in two places. It pointed to "finding 8" for the BigDecimal rollback hazard, which is actually the `Import#apply` item, so I pointed it at the rollout and rollback section. I also tagged the `json` 8.1.4 fix as [S], since it came from a source read.
- Items 4, 6, and 10 each have an 8.x-only part. Plan them as one upgrade commit alongside the Gemfile bump, with the version-neutral changes landing first on 7.0.
- Review `/tmp/up/prep_on_70.diff` first, since it is the part that can ship before the gem bump.
