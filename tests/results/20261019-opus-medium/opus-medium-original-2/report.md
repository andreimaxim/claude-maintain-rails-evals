I have the planner's report and checked its lab artifacts, so here's the full plan. I didn't change the repository: it's still clean at `ab732f5`. Rails is still 7.0.8.7.

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes (`/home/user/workspace/repo`)

I couldn't hand this to the `maintain-rails:gem-upgrade-planner` agent because this session can't start agents, so I did the analysis and experiments myself. The working repository was not modified (`git status` is still clean).

## Verdict

The upgrade is feasible. Ruby 3.3.6 meets Rails 8.x's minimum of 3.2.0, and the other gems resolve at every step. Sidekiq 6.5.12 runs on Rails 8.1 with no change.

Unchanged, the app fails to boot on 7.1 and later. Once that is fixed:
- About 15 more breakages surface across 7.1–8.1.
- Several changes silently alter data or behavior, and some of them the current tests would not catch.
- One problem needs a Gemfile constraint at 8.1: Rails 8.1 pulls in `json 3.1.0`, and that breaks reading every session cookie.

With the fixes below, the full suite passes on 7.0, 7.1, 7.2, 8.0 and 8.1. On 8.1 that holds with `load_defaults` at every level from 7.0 to 8.1. The one exception is a test that encodes the current `to_time` behavior, which needs a product decision (item D1).

**How claims are marked:**
- **[SRC]** I read the installed gem source.
- **[EXEC]** I ran it in the lab.
- **[PROPOSED]** A check I have not run.

## Lab setup and reproducibility [EXEC]

- **Location:** everything is under `/tmp/rails-upgrade-lab`, outside the repo.
  - Each variant is a `git clone` of the repo: `app-70`, `app-71`, `app-72`, `app-80`, `app-81`, `app-prep`, `app-step71`.
  - Each variant has its own `bundle config --local path` in `/tmp/rails-upgrade-lab/bundles/<variant>`.
  - Variants were built by `/tmp/rails-upgrade-lab/scripts/make-variant.sh` (Gemfile pin, then `bundle lock --update rails`).
- **Isolation:**
  - **Database:** a private PostgreSQL 15 cluster (initdb at `/tmp/rails-upgrade-lab/pg`, unix socket only at `/tmp/rails-upgrade-lab/pgsock`, port 55432). Each copy's `config/database.yml` points there with `lab<NN>_*` database names. Cross-version tests used `labshared_production` with a fixed `SECRET_KEY_BASE`.
  - **Redis:** a private server on port 56379. `REDIS_URL=redis://127.0.0.1:56379/1` is set in `/tmp/rails-upgrade-lab/scripts/env.sh`.
  - **Storage and cache:** both resolve to each copy's own `Rails.root`; the cross-version cache test used `/tmp/rails-upgrade-lab/xver/cache-shared`. Cable uses `async`/`test` and was not exercised.
  - **Shared services untouched:** the shared Redis keyspace and the shared PostgreSQL database list were the same before and after.
- **Commands:** `bin/rails test` and `bin/rails runner <script>` from `/tmp/rails-upgrade-lab/scripts/`, with Ruby 3.3.6 and Bundler 2.5.22. Logs are in `/tmp/rails-upgrade-lab/logs/`. The private servers are stopped; restart them with the `pg_ctl` / `redis-server` commands documented in `scripts/env.sh`.
- **Resolved versions** (`bundle lock --update rails`):

| Step | Rails | rack | sidekiq | redis | Other notable |
|---|---|---|---|---|---|
| 7.1 | 7.1.6 | 2.2.24 | 6.5.12 | 4.8.1 | |
| 7.2 | 7.2.4 | 2.2.24 | 6.5.12 | 4.8.1 | |
| 8.0 | 8.0.5.1 | 2.2.24 | 6.5.12 | 4.8.1 | |
| 8.1 | 8.1.0 | 2.2.24 | 6.5.12 | 4.8.1 | adds action_text-trix 2.1.19 and json 3.1.0 |

  Unchanged at every step: puma 5.6.9, minitest 5.27.0, concurrent-ruby 1.3.4, importmap 2.2.3, turbo 2.0.12, jbuilder 2.15.1, sprockets-rails 3.5.2, web-console 4.2.1. Rack stays at 2.x because Sidekiq 6.5 requires `rack ~> 2.0`.
- **Patches** (lab-only artifacts, not applied to the repo):
  - `/tmp/rails-upgrade-lab/patches/prep-cross-version.patch` — 18 files, works on 7.0.
  - `/tmp/rails-upgrade-lab/patches/step-7.1-only.patch`

**Test results:**

| Run | Result | Log |
|---|---|---|
| Baseline 7.0 | 46 runs, 0 failures | `baseline-70-test.log` |
| Unchanged app, 7.1/7.2/8.0/8.1 | boot fails: `NoMethodError: undefined method '+' for nil` | `dbprep-*-unchanged.log` |
| Prep patch on 7.0 | 46 runs, 0 failures | `test-70-prep3.log` |
| Prep + 7.1-only patch, 7.1/7.2/8.0 | 0 failures | `test-71/72/80-prep3.log` |
| Same, 8.1 | 40 errors (json 3) | `test-81-prep3.log` |
| Same, 8.1 + json pin | 1 failure (D1) | `test-81-prep4.log` |
| 8.1 with `load_defaults` 7.0 through 8.1 | only the D1 failure | `test-81-defaults-*.log` |

## A. Required changes that work on 7.0 (land first, deploy on 7.0)

Every item in this section is in `prep-cross-version.patch`. The patch passes the full suite on 7.0 [EXEC], and none of these items changes any stored data format.

**A1. Action Text allowlist crashes boot on 7.1 and later**
- **Code:** `/home/user/workspace/repo/config/initializers/action_text.rb:3`
- **Why:** In 7.1+, `ContentHelper.allowed_tags` defaults to nil and is computed later [SRC]. In 8.1 the sanitizer is assigned inside an `on_load(:action_view)` hook.
- **Change:**
  ```ruby
  ActiveSupport.on_load(:action_view) do
    h = ActionText::ContentHelper
    defaults = h.allowed_tags || (h.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])
    h.allowed_tags = defaults + %w[ details summary ]
  end
  ```
- **Validation:** Boot works on all versions [EXEC]. `<details>`/`<summary>` and image attachments render on 7.0 and on 8.1 with 7.0 and 8.1 defaults (`xver-cookies-actiontext.log`).

**A2. `Rails.application.secrets` is removed in 7.2 (deprecated in 7.1)**
- **Code:**
  - `/home/user/workspace/repo/app/models/citation/provider.rb:13`
  - `/home/user/workspace/repo/config/secrets.yml`
  - `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb:45,117-122`
- **Change:** Build `config.x.citation_provider` in `config/application.rb` from `ENV.fetch`, with local defaults only in development and test. Read it with `Rails.configuration.x.citation_provider.to_h`, then delete `secrets.yml`.
- **Avoid moving this to `config_for` YAML:** the existing test sends user `"00123"` and password `"sample: value # keep"`, which unquoted YAML would mangle. The ENV-in-Ruby version passes that test [EXEC].
- **Production impact:** none on `secret_key_base`, because `secrets.yml` never defined it.

**A3. Keyword-style enum is an ArgumentError at class load on 8.0 (deprecated in 7.2)**
- **Code:** `/home/user/workspace/repo/app/models/note.rb:10`
- **Change:** `enum :status, { draft: 0, ready: 1 }, prefix: true` (same scope and method names; `Citation` and `Export` already use this form).
- **Validation [EXEC]:** 8.0/8.1 errored at `note.rb:10` before the fix.

**A4. `alias_attribute :highlight_color, :color` raises on 7.2 (deprecated in 7.1)**
- **Code:** `/home/user/workspace/repo/app/models/note.rb:14`
- **Why:** `color` comes from `store_accessor`, so it is not an attribute.
- **Change:** Define explicit `highlight_color` and `highlight_color=` methods that delegate to `color`.
- **Validation:** The notes form and index highlight classes still work [EXEC].

**A5. Integer `wait_until:` crashes on 7.2 (deprecated in 7.1)**
- **Code:** `/home/user/workspace/repo/app/models/note.rb:61`
- **Why:** On 7.2, `scheduled_at` stays an Integer and `serialize` calls `.utc` on it [SRC].
- **Change:** `set(wait_until: Time.at(reminder_epoch))`.
- **Validation:** The reminder test still asserts `enqueued_jobs[:at] == 1_793_451_617` [EXEC].

**A6. `retry_on wait: :exponentially_longer` is removed in 7.2**
- **Code:** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`
- **Why:** On 7.2+, `determine_delay` raises "Couldn't determine a delay" at retry time [SRC]. The job would fall through to Sidekiq retries and leave the citation pending.
- **Change:** `wait: ->(executions) { executions**4 + 2 }` keeps the formula but drops the 15% jitter. Alternatively, switch to `:polynomially_longer` in the 7.1 step.

**A7. `return` inside a transaction commits on 7.2 and later (data integrity)**
- **Code:** `/home/user/workspace/repo/app/models/import.rb:53-58`
- **Why:** On 7.0/7.1 the block rolls back; on 7.2+ it commits [SRC]. An invalid row would leave the Import plus the earlier notes saved.
- **Evidence [EXEC]:** `probe-behaviors.log` shows 0 rows left after the `return` on 7.0/7.1 and 1 row on 7.2/8.0/8.1.
- **Change:**
  ```ruby
  saved = false
  transaction do
    save!
    saved = rows.all? { |row| row.note.save }
    raise ActiveRecord::Rollback unless saved
  end
  saved
  ```
- **Validation:** The existing "applying them saves nothing" test.

**A8. `citation[:id]` is nil on 7.2 and later (silent data change in the receipt CSV)**
- **Code:** `/home/user/workspace/repo/app/models/import.rb:67-68`
- **Why:** The Citation primary key is `doi`, so `[:id]` no longer maps to it.
- **Evidence [EXEC]:** Returns `"10.1234/x"` on 7.0/7.1 and nil on 7.2+. The existing receipt test catches it [EXEC].
- **Change:** `note.citation&.doi`.

**A9. `Array#sum` of strings raises TypeError on 7.1**
- **Code:** `/home/user/workspace/repo/app/models/export.rb:42`
- **Why:** 7.0 already warns about it.
- **Change:** `fragments.join`.
- **Validation:** 3 export tests failed on 7.1 before the fix [EXEC].

**A10. TimeWithZone job arguments keep their zone on 7.1 and later (digest date changes)**
- **Code:**
  - `/home/user/workspace/repo/app/mailers/digest_mailer.rb:7-10`
  - `/home/user/workspace/repo/app/models/user.rb:41`
- **Why:** The 7.1+ serializer stores `time_zone` and restores it [SRC]. The digest would then cover the reader's local day, which no longer matches the UTC reservation key.
- **Evidence:** The digest test failed on 7.1 with "October 04" instead of "October 05" [EXEC].
- **Change:** `requested_at = params[:requested_at].in_time_zone("UTC")`. This reads both 7.0 and 7.1+ payloads correctly (`xver-jobs.log`).

**A11. `BigDecimal` job argument breaks rollback**
- **Code:** `/home/user/workspace/repo/app/models/user.rb:41`
- **Why:** On 7.2+, the BigDecimal serializer is mandatory.
- **Evidence [EXEC]:** A DigestJob enqueued by 8.1, even with 7.0 defaults, fails on a 7.0 worker with `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. On 7.1 with 7.0 defaults, enqueuing emits a deprecation warning.
- **Change:** Pass `reading_completion.to_s`. The mailer already calls `BigDecimal(...)`, so every version and payload works.

**A12. `HashWithIndifferentAccess#stringify_keys` stringifies Integer keys on 8.0**
- **Code:** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22`
- **Why:** On 8.0+, `annotations[row.line]` returns nil, so preview annotations disappear.
- **Evidence [EXEC]:** Confirmed by probe; the existing import test catches it.
- **Change:** Drop `.stringify_keys`.

**A13. `form_with(model: nil)` raises on 8.0 (deprecated in 7.2)**
- **Code:** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`
- **Change:** `form_with(url: notes_path, method: :get, ...)`. The parameter names are unchanged.

**A14. A route with multiple paths is removed in 8.1 (deprecated in 8.0)**
- **Code:** `/home/user/workspace/repo/config/routes.rb:18`
- **Change:**
  ```ruby
  get "/notes", to: "notes#index", as: :notes
  get "/journal", to: "notes#index", as: :journal
  ```
- **Validation:** `bin/rails routes` shows the same `notes` and `journal` names on 7.0 and 8.1 [EXEC].

**A15. Referring to a singular association by its plural name is deprecated in 7.1**
- **Code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12`
- **Change:** `where(notebook: @notebook)`.

**A16. Notebook settings save would raise once the 7.1 readonly default is adopted**
- **Code:**
  - `/home/user/workspace/repo/app/controllers/notebooks_controller.rb:40`
  - `/home/user/workspace/repo/app/views/notebooks/_form.html.erb:13`
- **Why:** The form resubmits `slug`. Under `raise_on_assign_to_attr_readonly`, `ReadonlyAttributeError` fires even when the value is unchanged [EXEC, `probe_readonly.rb`].
- **Change:** Stop permitting `:slug`. The hidden field can stay, so the existing test still passes.

**A17. PostgreSQL date decoding breaks the activity report once the 7.2 default is adopted**
- **Code:** `/home/user/workspace/repo/app/models/notebook.rb:40`
- **Why:** `postgresql_adapter_decode_dates` (a 7.2 default) makes `select_rows` return `Date`. `Date.iso8601(Date)` then raises TypeError [EXEC].
- **Change:** `Date.iso8601(day.to_s)`.
- **Note:** No test catches this, because tests run with 7.0 defaults.

**A18. Negative cache `expires_in` raises once the 7.1 default is adopted**
- **Code:** `/home/user/workspace/repo/app/views/exports/_export.html.erb:26`
- **Why:** With `raise_on_invalid_cache_expiration_time`, the exports page returns 500 for any expired export when caching is on, as it is in production.
- **Evidence [EXEC]:** The existing cache test errors with "cannot be negative: -60.0" under 7.1 defaults. Under 7.0 defaults it only logs an error on each render.
- **Change:** `expires_in: [export.expires_at - Time.current, 1.second].max`.

## B. Required changes that must land with the 7.1 bump (not 7.0-compatible)

These are in `step-7.1-only.patch`.

**B1. Serializer coder arguments**
- **Code:**
  - `/home/user/workspace/repo/app/models/note.rb:12` → `serialize :tags, coder: JSON`
  - `/home/user/workspace/repo/app/models/notebook.rb:7` → `serialize :preferences, coder: YAML`
- **Why:** Positional coders are removed in 7.2 (ArgumentError). A bare `serialize` raises once `default_column_serializer = nil`, a 7.1 default.
- **Do not ship this on 7.0 [EXEC]:** 7.0 accepts `coder: JSON` but silently ignores it and writes YAML (`"---\n- a\n- b\n"`). The real model then fails with `JSON::ParserError` (`probe_serialize2.rb`).
- **Data format:** Same as today on 7.1+. Tags and preferences written by 7.0 read back correctly on 8.1 [EXEC].

**B2. Test exception setting**
- **Code:** `/home/user/workspace/repo/config/environments/test.rb:31` → `show_exceptions = :none`
- **Why:** On 7.2, `false` falls through to "show" [SRC]. Tests asserting `assert_raises(RecordNotFound)` would then get rendered error pages instead.
- **Not on 7.0:** there, `:none` is truthy.

## C. Required at the 8.1 bump

**C1. Constrain the json gem: `gem "json", "< 3"` in `/home/user/workspace/repo/Gemfile`**
- **Why:** activesupport 8.1.0 depends on `json` with no version limit and calls `::JSON.parse(json, options)` positionally (`active_support/json/decoding.rb:25`) [SRC]. json 3.x only takes keyword options.
- **Evidence [EXEC]:** With json 3.1.0, every request carrying a session cookie raised `ArgumentError` in `Messages::Metadata#deserialize_from_json`. That was 40 test errors, and every signed-in request in production would fail.
- **After the pin:** json 2.21.2, and the suite passes.
- **Later patches:** activesupport 8.1.3.1 has the same call (unpacked and read in `/tmp/rails-upgrade-lab/downloads/as-8131`), so the constraint is needed on any 8.1.x until upstream changes.

**C2. Gemfile and schema**
- Set `gem "rails", "8.1.0"`.
- `db/schema.rb` will be regenerated with `ActiveRecord::Schema[8.1]`, `enable_extension "pg_catalog.plpgsql"`, and alphabetically sorted columns. That diff is cosmetic only [EXEC, `schema-diff-81.txt`]. Commit it on its own so reviewers can see that.

## D. Behavior decisions (cannot be deferred)

**D1. `to_time` always keeps the zone on 8.1, whatever the config**
- **Code:**
  - `/home/user/workspace/repo/app/models/note.rb:43-45` (`next_day_reminder_at`)
  - `/home/user/workspace/repo/test/controllers/reminders_controller_test.rb:21`
  - ARCHITECTURE.md:153
- **What changes:** Across a DST change, the "24 hours later" preview becomes `2026-11-01T08:00-05:00` instead of `09:00-04:00` [EXEC]. The scheduled time (epoch) does not change. On 8.0 with 7.0 defaults you get a deprecation warning.
- **Option 1:** Accept the change. The preview then matches the time the postponed reminder will show. Update the test and the ARCHITECTURE.md paragraph.
- **Option 2:** Keep today's behavior with `reminder_at.getlocal(reminder_at.utc_offset) + 86_400`. It works on 7.0 and 8.1, and the reminder tests pass on both [EXEC].
- **This is a product call.** Decide before the 8.0 step.

**D2. Trix and the Action Text JavaScript [PROPOSED]**
- **Code:**
  - `/home/user/workspace/repo/app/views/layouts/application.html.erb:13` loads vendored Trix 1.3.5.
  - `/home/user/workspace/repo/config/importmap.rb:8` pins `@rails/actiontext` to `actiontext.js`.
- **What changes:** In 8.1 that file is a UMD build; an `actiontext.esm.js` exists with no imports. 8.1 also bundles Trix 2.1.19 through `action_text-trix`.
- **Recommendation:**
  - Re-pin to `actiontext.esm.js` from 7.1 onward.
  - Keep Trix 1.3.5 until a browser check passes.
  - Moving to Trix 2 is optional and needs editor checks: attachments, links, and re-editing old content.
- **Not verified:** system tests need a display and Chrome, and I did not run them.

## E. Optional adoption of new framework defaults

Keep `config.load_defaults 7.0` through the 8.1 version bump. Adopt new defaults one flag at a time using `new_framework_defaults_*.rb`, only after the prep work has shipped. In the lab, 8.1 passes its suite at every defaults level with the prep applied [EXEC].

**Flags that affect stored data or rollback** (adopt only after rolling back to 7.0 is off the table):
- **`message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata = true` (7.1):**
  - **Effect [EXEC]:** Action Text attachment sgids written under either flag are unreadable on 7.0. On the show page the attachment silently disappears. The first 8.1-with-8.1-defaults note made 7.0 raise `NoMethodError` in `Messages::Metadata`, giving a 500 on `/notes` (`xver-rollback-actiontext.log`, `xver-sgid-bisect.log`).
  - **Rollback to 7.1 reads everything [EXEC].**
  - **Forward compatibility:** 8.1 with 8.1 defaults reads sgids from 7.0, which are Marshal-based, and 7.0 session cookies [EXEC].
  - **Never move to a strict `:json` serializer** without first re-signing the stored `action-text-attachment` sgids.
  - **Session cookies:** 7.0 accepted a cookie issued by 8.1 with 8.1 defaults [EXEC, single cookie test]. Treat that as observed, not guaranteed.
- **`cache_format_version = 7.1`:** 7.0 raises `TypeError: incompatible marshal file format` reading such an entry; it does not treat it as a miss [EXEC, `xver-cache.log`]. If you roll back after adopting it, clear `tmp/cache` (the production file store) on every host.
- **`enqueue_after_transaction_commit = :default` (7.2):**
  - **Effect [EXEC]:** When the enqueue fails, the citation is left permanently `pending` instead of rolled back, and the suite still passes (`probe-after-commit-72.log`). This affects `Citation#request_enrichment` (`citation.rb:14-24`) and `Note#schedule_reminder` (`note.rb:56-69`).
  - **On 7.2:** set `config.active_job.enqueue_after_transaction_commit = :never`. Note that `false` means `:default` on 7.2 [SRC].
  - **On 8.0:** the default is `false` and the config key is deprecated, so remove it.

**Smaller flags, low risk** [SRC]:

| Flag | Introduced | Note |
|---|---|---|
| `postgresql_adapter_decode_dates` | 7.2 | needs A17 first |
| `raise_on_assign_to_attr_readonly` | 7.1 | needs A16 first |
| `raise_on_invalid_cache_expiration_time` | 7.1 | needs A18 first |
| `action_text.sanitizer_vendor` = HTML5 | 7.1 | stored rich text is re-sanitized at render; spot-check odd HTML |
| `strict_freshness` | 8.0 | export download ETag precedence |
| `Regexp.timeout` | 8.0 | |
| `action_on_path_relative_redirect`, `escape_json_responses`, `remove_hidden_field_autocomplete` | 8.1 | |

**Other optional items:**
- **Image processing:** set `config.active_storage.variant_processor = :disabled` to silence the 8.1 boot warning, since `image_processing` is not installed [EXEC log].
- **Sidekiq 7.3.3+:** the built-in adapter is deprecated and removed in 8.2 [EXEC: development log]. Before moving, handle three things:
  - `sadd` returns an Integer under Sidekiq 7, and `if 0` is truthy, which breaks the once-per-day digest guard (`user.rb:38`).
  - `rescue Redis::BaseError` (`notebook.rb:28`) would no longer catch Sidekiq 7's Redis errors.
  - Sidekiq 7 rejects the symbol-keyed `ExportJob` arguments (`notebook.rb:26`); 6.5 already warns.

  Rack 3 then also requires Puma 6+. This is not needed for 8.1.
- **Pins:** `concurrent-ruby 1.3.4` can be relaxed after 7.1. Keep `minitest ~> 5.25` for now.

## F. Stored data and queued work (rollout and rollback)

- **Queued and scheduled jobs:**
  - **Wrapper class:** identical in every version (`ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper`) [EXEC].
  - **Long-scheduled `NoteReminderJob` payloads:** read correctly 7.0↔7.1↔8.1 in both directions.
  - **Mixed-version DigestJob payloads:** after A10 and A11, they deserialize the same everywhere.
  - **Pre-upgrade drain:** before any rollback from ≥7.2 to 7.0, look for queued or retrying DigestJob payloads containing `BigDecimalSerializer` (left from before A11). `NoteReminderJob` has `discard_on DeserializationError`, so a reminder whose arguments fail to deserialize is dropped silently. It takes only a Note today.
- **Mixed fleets during a deploy:** web and workers on adjacent versions are safe with defaults held at 7.0 and the A items shipped.
- **Data columns:** `notes.tags` (JSON) and `notebooks.preferences` (YAML) keep the same format. Before 7.1, run an audit to confirm every preferences row is a Hash of Strings or nil (YAML safe-load).
- **Active Storage:** blobs and variants are unchanged. Blob URLs are regenerated on each render.
- **Sessions:** dev and test sessions reset at 7.1 (`tmp/local_secret.txt` replaces `development_secret.txt`) [SRC]. Production uses `SECRET_KEY_BASE` or credentials, with no change.

## G. Stepwise path and gates

| Step | Changes | Gates |
|---|---|---|
| **0 (on 7.0)** | Ship the A items. Decide D1. | Full suite and system tests pass on 7.0. A browser check of note editing, attachments and `<details>`. |
| **1 (7.1.6)** | Bump with the B items, defaults still 7.0. | Suite passes. Zero deprecations except Sidekiq/Redis ones. Production smoke test: sign-in, note with attachment, import, export download, digest, reminder schedule and postpone. Workers drain. |
| **2 (7.2.4)** | Bump. If you test `load_defaults 7.2`, set `enqueue_after_transaction_commit = :never`. | Suite passes. No BigDecimal payloads left. Confirm rollback is only to 7.1, not 7.0. |
| **3 (8.0.5.1)** | Bump. | Suite passes. Act on the `to_time` deprecation according to D1. |
| **4 (8.1.0)** | Bump with the json pin (C1). Commit the schema dump separately. Re-pin actiontext ESM (D2). | Suite passes. Sidekiq worker smoke test [EXEC already: `sidekiq-81-worker.log` shows both an Active Job and a native job completing]. |
| **5** | Adopt new defaults incrementally (section E). | Each flag deployed only after the rollback target can read its output. |

## H. Documentation to update with the code

- `/home/user/workspace/repo/ARCHITECTURE.md`:
  - lines 80 and 84 (secrets, retry wording)
  - line 153 (preview behavior, per D1)
  - line 169 (Active Job time and decimal handling)
  - line 188 (runtime version)
  - line 207 (Trix)
- `/home/user/workspace/repo/TESTING.md`: lines 54–55 (Minitest note) and 151–152 (test adapter behavior).
- `/home/user/workspace/repo/CONTRIBUTING.md`: line 38 (`secrets.yml`).
- `/home/user/workspace/repo/README.md`: line 7 (versions).

## I. Unverified claims and open questions

1. **Browser behavior:** system tests were not run. This covers Trix 1.3.5 with Action Text 8.1's JavaScript, the UMD-vs-ESM pin, and direct uploads.
2. **Deployment topology is unknown:** number of hosts, shared or per-host `tmp/cache`, whether `REDIS_URL` is shared across environments, and where `secret_key_base` comes from.
3. **Production data:**
   - Are there `notebooks.preferences` rows holding non-String YAML?
   - How many rich texts with attachments exist (that is the rollback exposure under E)?
   - How large is the Sidekiq scheduled set?
4. **Patch level:** the requested version is 8.1.0, but 8.1.2.1 and 8.1.3.1 exist. I did not review their security advisories; consider the latest 8.1.x. The json constraint still applies.
5. **Why cookies stayed compatible:** the 8.1-with-8.1-defaults session cookie was readable by 7.0, but I did not establish the mechanism.
6. **Ruby 3.4:** stdlib warnings about `csv`, `bigdecimal`, `mutex_m` and `drb` will matter if Ruby moves to 3.4. Not required for 8.1 on 3.3.6.

---

## My notes

- **Who did the work:** The first line of the plan says it "couldn't hand this to" the planner. That line was written by the planner agent itself. It ran the analysis and lab experiments on its own.
- **What I checked:** Both patch files exist under `/tmp/rails-upgrade-lab/patches/`, and the logs are in `/tmp/rails-upgrade-lab/logs/`. Three results match their logs:
  - Baseline 7.0: 46 runs, 0 failures.
  - Prep patch on 7.0: 46 runs, 0 failures.
  - 8.1 with the json pin: 46 runs, 1 failure.

  I didn't re-run any experiments or check the other findings against the gem source.
- **Highest-risk items:**
  - **C1:** Rails 8.1 pulls in json 3.x, which would break every signed-in request. The plan's fix is to pin `json < 3`.
  - **A7:** from Rails 7.2, a failed import keeps its partial notes instead of rolling back.
  - **A11 and the serializer and cache-format defaults in section E:** these limit how far back you can safely roll back.
- **Decisions only you can make:**
  - **D1:** across a daylight-saving change, should the "24 hours later" reminder preview keep today's time or change on 8.1? This needs deciding before the 8.0 step.
  - **Target version:** whether to target 8.1.0 exactly or the latest 8.1.x patch release (open question I.4).
- **Untested:** browser and system tests weren't run, which leaves the Trix and Action Text JavaScript changes unverified.

If you want me to go ahead, I'd start with step 0: the A changes, which work on Rails 7.0, in a branch off `main`.
