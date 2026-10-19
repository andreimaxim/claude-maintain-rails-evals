I haven't upgraded anything yet. Below is the planner's full plan for moving Rails from 7.0.8.7 to 8.1.0, followed by my notes.

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes (`/home/user/workspace/repo`)

The upgrade works. With the code changes below, all 46 tests pass on Rails 8.1.0 under both `load_defaults 7.0` and `load_defaults 8.1`. Without them, the app won't boot on 7.1 or later: the Action Text initializer crashes. Rails 8.1.0 also needs one extra Gemfile line (a `json` constraint) that 8.1.4 doesn't. Almost every code change also works on 7.0, so it can ship before the version bump. Most of the real risk is in jobs already queued in Redis, cached pages and signed links during a rollback. The existing tests don't cover those.

I couldn't hand this off to a separate planner agent (no spawn tool here), so I did the planning myself. One slip: an early `gem fetch` ran from inside the repo and left an untracked `rails-7.1.5.gem` there. I deleted it straight away and `git status` is clean again. Nothing else in the repo was touched.

Each conclusion is tagged: **[executed]** means I ran it, **[source]** means I read it in the gem source or changelog, **[proposed]** means it still needs to be run.

---

## 1. How the experiments were run

- **Copies:** everything ran in copies under `/tmp/mn-upgrade/`.
  - `base` is an untouched copy of the repo.
  - `prep70` is 7.0 plus the preparatory changes.
  - `v7.1.6`, `v7.2.3`, `v8.0.5`, `v8.1.0` each have the preparatory and 7.1-only changes, with `load_defaults 7.0`.
  - `v8.1.0-d71`, `-d72`, `-d80`, `-d81` and `v7.1.6-d71` are the same with newer defaults.
  - `v8.1.4-d81` is 8.1.4 with 8.1 defaults.
  - `rv-*` are copies of `v8.1.0-d81` with one fix reverted each.
- **Isolation:**
  - A private PostgreSQL 15 on port 55432 (data in `/tmp/mn-upgrade/pgdata`, one database per copy).
  - A private Redis on port 56379, separate database numbers per experiment.
  - Gems installed into `/tmp/mn-upgrade/bundle`; storage, cache and mail stayed in each copy's `tmp/`.
  - Settings are in `/tmp/mn-upgrade/env.sh`. I stopped both services at the end.
- **Scripts** (`/tmp/mn-upgrade/scripts/`):
  - `run.sh` runs `db:prepare` and the tests, and writes the resolved gem versions, `load_defaults` and connection URLs to the top of each log in `/tmp/mn-upgrade/logs/test-<copy>-<label>.log`.
  - `prep.rb` applies the preparatory changes; `hop71.rb` applies the 7.1-only ones.
  - `revert_one.rb` undoes one fix at a time.
  - `xver.rb` / `xrun.sh` write cookies, signed IDs, cache entries and job payloads with one version and read them with another.
  - `produce.rb` / `xq.sh` push real jobs through Sidekiq into Redis and run a real worker on the other version.
- **What the lockfiles resolved to:** `bundle lock --update rails --conservative` worked at every hop. Sidekiq 6.5.12, redis 4.8.1, rack 2.2.24, puma 5.6.9, faraday 1.10.4, pagy 8.6.3, minitest 5.27.0 and concurrent-ruby 1.3.4 all stay put. New gems come in: bigdecimal 4.1.3, rackup, rack-session 1.0.2 and (8.1) action_text-trix 2.1.19 and json.
- **Full diffs:**
  - `/tmp/mn-upgrade/logs/prep.diff` (preparatory changes only).
  - `/tmp/mn-upgrade/logs/v8.1.0-d81-full.diff` (everything, at 8.1.0 with 8.1 defaults).

---

## 2. Changes you have to make

### 2A. Changes that also work on 7.0 — ship these first
**[executed]** With all of these applied, the `prep70` copy passes 46/46 on 7.0 with zero deprecation warnings (`logs/test-prep70-rails70_final.log`). The `rv-*` runs show that undoing any one of them breaks at least one test on 8.1.

| # | Code | What breaks and when | Fix |
|---|---|---|---|
| R1 | `config/initializers/action_text.rb:3` | From 7.1, `ActionText::ContentHelper.allowed_tags` starts out `nil`, so `+=` crashes at boot. **[executed]** | In an `after_initialize` block, take `allowed_tags \|\| (sanitizer.class.allowed_tags + [Attachment.tag_name, "figure", "figcaption"])` and add `details summary`. The `<details>` test passes on 7.0 through 8.1. |
| R2 | `app/models/citation/provider.rb:13`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb:45,117-122` | `Rails.application.secrets` is deprecated in 7.1 and removed in 7.2. **[executed]** | Move the file to `config/citation_provider.yml` and set `config.x.citation_provider = config_for(:citation_provider)[:citation_provider]` in `config/application.rb`. Read it from `Rails.configuration.x.citation_provider` and update the test stubs. The test that passes tricky credentials (`"sample: value # keep"`) still passes. |
| R3 | `app/models/note.rb:10` `enum status: {...}, _prefix: true` | The keyword form of `enum` is removed in 8.0; the model fails to load. **[executed]** | `enum :status, { draft: 0, ready: 1 }, prefix: true`. Scope names like `status_ready` don't change. |
| R4 | `app/models/note.rb:14` `alias_attribute :highlight_color, :color` | `color` is a `store_accessor`, not a real attribute. Deprecated in 7.1; from 7.2 it raises when the model loads. **[executed]** | `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. |
| R5 | `app/models/note.rb:61` `set(wait_until: reminder_epoch)` (an Integer) | Deprecated in 7.1. On 8.x the reminder can't be scheduled (`undefined method 'utc' for Integer`). **[executed]** | `wait_until: Time.at(reminder_epoch)`. |
| R6 | `app/models/note.rb:44` `reminder_at.to_time + 86_400` | 8.0 warns. In 8.1, `to_time` always keeps the reader's time zone, so the "24 hours later" hint shows an hour-shifted local time across a daylight-saving change (the scheduled epoch doesn't change). **[executed]** | To keep today's display, use `Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)`. Alternatively, accept the new display and update the test and the model comment. That's a product decision. |
| R7 | `app/models/export.rb:42` `fragments.sum` | Summing strings is deprecated on 7.0 and fails from 7.1 (`TypeError`). Exports crash and Sidekiq retries them. **[executed]** | `fragments.join`. |
| R8 | `app/models/import.rb:53-58` `return false` inside `transaction` | Today a `return` rolls the transaction back. 7.1 defaults, and every version from 7.2, **commit** it instead. An import with one bad row would save the import and the earlier rows, even though the UI says "Nothing has been saved." **[executed]** | `applied = rows.all? { \|r\| r.note.save }; raise ActiveRecord::Rollback unless applied`, then return `applied`. |
| R9 | `app/models/import.rb:68` `citation[:id]` | Citations use `doi` as their primary key. 7.1 deprecates reading it via `[:id]`; on 8.x the receipt CSV's DOI column comes out blank. **[executed]** | `citation&.doi`. |
| R10 | `app/models/notebook.rb:40` `Date.iso8601(day)` | 7.2 defaults (`postgresql_adapter_decode_dates`) return a `Date` instead of text, and the activity report raises `TypeError`. **[executed]** | `Date.iso8601(day.to_s)` (or pluck with type casting). |
| R11 | `app/controllers/notes_controller.rb:12` `where(notebooks: @notebook)` | Using the plural name for a singular association is deprecated in 7.1; on 8.1 it produces invalid SQL (`column notes.notebooks does not exist`). **[executed]** | `where(notebook: @notebook)`. |
| R12 | `app/controllers/notebooks_controller.rb:40` permits `:slug` | 7.1 defaults raise when a read-only attribute is assigned; notebook settings updates fail. **[executed]** | Stop permitting `:slug` (it's already read-only; the hidden field can stay). |
| R13 | `app/views/exports/_export.html.erb:26` `expires_in: export.expires_at - Time.current` | For an expired export this is negative. With 7.1+ defaults that's an `ArgumentError`, so the exports page fails in production, where caching is on. **[executed]** | `expires_in: [export.expires_at - Time.current, 1.second].max`. This keeps the cached-indicator behaviour the test describes; a `cache_if` variant broke that test. |
| R14 | `app/views/imports/preview.html.erb:22` `.stringify_keys` | In 8.0, `HashWithIndifferentAccess#stringify_keys` also turns Integer keys into strings, so annotations silently disappear from the import preview. **[executed]** | Drop `.stringify_keys` and look up `annotations[row.line]`. |
| R15 | `app/views/notes/index.html.erb:12` `form_with(model: nil, ...)` | Deprecated in 7.2; raises in 8.0 on every notes page. **[executed]** | Remove `model: nil`. |
| R16 | `config/routes.rb:18` `get "/notes", "/journal", to:` | Deprecated in 8.0; in 8.1 the routes file fails to load (`ArgumentError`). **[executed]** | Two separate `get` calls. `bin/rails routes` output is identical on 7.0. |
| R17 | `app/jobs/digest_job.rb:7`, `app/mailers/digest_mailer.rb:8-9` | From 7.1, a queued time keeps the reader's time zone when the job runs. The digest would cover the reader's local day, not the UTC day that the reservation key and the docs promise. **[executed]** | Pass `requested_at.in_time_zone(Time.zone)` to the mailer. |
| R18 | `app/models/user.rb:41` passes a `BigDecimal` to `DigestJob` | From 7.2 Rails always encodes `BigDecimal` job arguments in a form 7.0 workers can't read. Rolled-back workers fail those jobs with `DeserializationError`. **[executed]** | Pass `reading_completion.to_s`. That's the same string the queue already carries on 7.0, and the mailer already calls `BigDecimal(...)`. |

### 2B. Changes that need Rails 7.1 or later (ship with the 7.1 bump)
**[executed]** These are in `scripts/hop71.rb`; tests pass on 7.1.6 through 8.1.0.

- **`app/models/note.rb:12`:** change `serialize :tags, JSON` to `serialize :tags, coder: JSON`. The old form is removed in 7.2 (`wrong number of arguments`).
  - **Don't make this change on 7.0.** **[source]** 7.0 doesn't understand `coder:` and quietly passes it through as an attribute option, so the column wouldn't use the JSON coder. I didn't run this case.
- **`app/models/notebook.rb:7`:** change `serialize :preferences` to `serialize :preferences, coder: YAML`.
  - This is needed once 7.1 defaults are on, where nothing is serialized by default (`missing keyword: :coder`). **[executed]**
  - Existing rows are YAML text, and `coder: YAML` reads them the same way. **[source]**
- **`app/jobs/citation_enrichment_job.rb:7`:** change `:exponentially_longer` to `:polynomially_longer` (same timing formula). Deprecated in 7.1; `:polynomially_longer` doesn't exist on 7.0.
- **`config/environments/test.rb:31`:** change `show_exceptions = false` to `:none`.
  - **[source]** On 7.2+, `false` is treated as "show error pages", so the 21 `assert_raises(RecordNotFound)` checks would quietly change meaning.
  - On 7.0, `:none` would count as true, so this can't go in early.

### 2C. Gemfile and dependencies
- **Rails pin:** `gem "rails", "8.1.0"`. Ruby 3.3.6 meets 8.1's minimum of 3.2.
- **json (8.1.0 only):** 8.1.0 lets bundler pick **json 3.1.0**, and ActiveSupport 8.1.0's JSON decoding is incompatible with it. Every request that reads a cookie fails (`wrong number of arguments (given 2, expected 1)`; log `test-v8.1.0-prep_hop71_defaults70.log`). **[executed]**
  - Either add `gem "json", "< 3"` (resolved to 2.21.2, 46/46 passing),
  - or target **8.1.4**, which fixes the decoder (46/46 passing with json 3.1.0, `logs/test-v8.1.4-d81-full.log`).
  - I'd recommend the latest 8.1.x: there are patch releases after 8.1.0 (8.1.2.1, 8.1.3.1, 8.1.4). Whether they are security fixes is unconfirmed (see section 6).
- **Sidekiq:** stays at 6.5.12 and resolves cleanly.
  - 8.1 deprecates Rails' built-in Sidekiq adapter (removal in 8.2). **[executed]** The warning shows in the worker log, but production hides deprecation reports.
  - Moving to Sidekiq ≥ 7.3.3 is a later, separate job. It brings redis-client, under which `sadd` returns an Integer, so `if Sidekiq.redis { sadd }` in `app/models/user.rb:38` would always be true. It also needs `ExportJob.perform_async(..., { format: })` to use string keys (Sidekiq 7 rejects non-JSON arguments).
- **minitest:** keep `~> 5.25`. I didn't test Rails 8.1.0 with Minitest 6.
- **concurrent-ruby:** the 1.3.4 pin can be dropped after 7.1, but that's optional.
- **bigdecimal:** 4.1.3 gets pulled in as a new dependency. The app's BigDecimal use is tested and passes. Pin `~> 3.1` only if you want to stay on the version Ruby 3.3 ships with. **[executed]**
- **rack:** stays on 2.2.24 because Sidekiq 6.5 needs it; Puma 5 works with it.
  - **[executed]** I booted the 8.1.0 production server on Puma 5.6.9 and signed in. `/notes`, `/journal`, `/notebooks`, the exports page with an expired export, the activity report, and note show/edit all returned 200, and the `<details>` markup rendered.

---

## 3. Optional: adopting new framework defaults (do this after the code is on the new version)

**[executed]** All 46 tests pass with 8.1 defaults (`test-v8.1.0-d81-full_slugfix.log`). R8, R10, R12, R13 and the `preferences` coder are required before these defaults can be switched on. Adopt them in steps, one `new_framework_defaults` file per version:

- **7.1 messages and cache:** `message_serializer :json_allow_marshal`, `use_message_serializer_for_metadata` and `cache_format_version 7.1`. Rails 7.0 can't read what these produce (section 4). Only turn them on once rolling back to 7.0 is off the table.
- **7.1 `raise_on_invalid_cache_expiration_time`:** needs R13.
- **7.1 `sanitizer_vendor` (HTML5):** the sanitizer test passes. How existing notes render under it is a proposed check (section 5).
- **7.1 `use_big_decimal_serializer`:** irrelevant once R18 is in.
- **7.2 `enqueue_after_transaction_commit = :default`:** only exists if you stop on 7.2 with 7.2 defaults. **[source]**
  - It would push the citation and reminder jobs to after the database commit, which breaks the "a failed enqueue rolls back" design in `Citation#request_enrichment` and `Note#schedule_reminder`.
  - Leave it at `:never`. 8.0 deprecates it and the 8.x default is off.
- **7.2 `postgresql_adapter_decode_dates`:** needs R10.
- **7.2 and 8.1 `yjit`:** turns YJIT on in production and raises memory use. Plan capacity for it.
- **8.0 `to_time_preserves_timezone :zone`:** see R6. 8.1 forces this behaviour regardless of defaults.
- **8.0 `strict_freshness`:** the download caching test passes.
- **8.0 `Regexp.timeout = 1`:** low risk; the DOI pattern is trivial.
- **8.1 `action_on_path_relative_redirect`, `raise_on_missing_required_finder_order_columns`, `escape_json_responses`, `remove_hidden_field_autocomplete`:** all tests pass. **[executed]**
- **Active Storage warning:** from 8.x, boot warns that `image_processing` is missing. Optionally set `config.active_storage.variant_processor = :disabled` (8.1 supports it; the app doesn't use variants). **[executed, source]**

---

## 4. Rolling out across versions: queued jobs, stored data, rollback

Results from writing with one version and reading with another (`logs/xver-read*.log`) and from real Sidekiq producer/worker runs (`logs/xq-*`). **[executed]**

- **Session cookie:** readable in every direction, 7.0 ↔ 7.1/8.1, under any defaults (it's already JSON under 7.0 defaults).
- **Jobs written by 7.0, run on 8.1:**
  - `DigestJob` (BigDecimal sent as a string), the scheduled `NoteReminderJob` and the app's own digest all ran and sent mail. Retry and dead sets were empty.
  - Reminders scheduled days ahead are safe to keep across the upgrade.
- **Jobs written by 8.1, run on 7.0 (rollback):**
  - The reminder and the app digest (with R18) ran fine.
  - A `DigestJob` carrying a `BigDecimal` failed with `BigDecimalSerializer is not known` and went to the retry set.
  - Without R18, any digest requested on 7.2+ fails until you roll forward again or the retries run out.
- **Digest time zone:** 7.0 ignores the new `time_zone` key, so with R17 both versions produce the same UTC-day digest.
- **Action Text attachment IDs (stored in note HTML):** IDs written with 7.1/8.1 *defaults* can't be read by 7.0 (`unpack1 for nil`). Attachments on notes edited after adopting the 7.1 message defaults would break if you rolled back to 7.0. With 7.0 defaults they stay readable.
- **Signed IDs (Active Storage blob URLs):**
  - Since 7.2 they are URL-safe, and 7.0/7.1 reject them.
  - These are generated fresh on every page render, so only cached pages and bookmarks are affected.
  - 8.1 keeps the 7.2 format via `use_legacy_signed_id_verifier = :generate_and_verify`. **[source]**
- **Cache entries:** 7.1-format entries crash 7.0 with `TypeError: incompatible marshal file format`. With the default production FileStore, clear `tmp/cache` before rolling back past the 7.1 cache-format change, or don't make that change until rollback is ruled out.
- **Export jobs:** they're native Sidekiq jobs, so Rails versions don't affect them.

**Recommended order:**
1. Deploy the 2A changes on 7.0 and let the digest queue drain.
2. Deploy 7.1 with the 2B changes.
3. Deploy 7.2, then 8.0, then 8.1, each with `load_defaults 7.0`.
4. Adopt the 7.1 defaults, then later ones, only when rollback to 7.0 is no longer needed.

Each intermediate version passes 46/46. A direct 7.0 → 8.1 deploy is technically possible but makes rollback harder.

---

## 5. Things the tests don't cover (proposed checks)

- **Trix editor mismatch:**
  - From 7.1, `*= require trix` in `app/assets/stylesheets/actiontext.css:6` pulls in **Trix 2** CSS (in 8.1 it comes from the action_text-trix gem). The layout (`app/views/layouts/application.html.erb:13`) still loads the vendored **Trix 1.3.5** JS.
  - `test/system/` is empty, so nothing covers editing, toolbar styling or attachment upload.
  - **[executed]** Asset precompile on 8.1 works. **[proposed]** In a browser, check editing, link and attachment round-trips, and direct upload. Then either vendor the matching 1.3.5 CSS or move to the gem's Trix 2 as a separate change.
  - The Trix 1.3.5 workaround notes in `ARCHITECTURE.md:207-212` will need revisiting.
- **Rendering existing notes [proposed]:** render every stored rich-text body under the 7.0 and 7.1+ sanitizers and diff the output. Do the same for Markdown export output (`to_plain_text`).
- **Retries in flight [proposed]:** start `CitationEnrichmentJob` retries on 7.0 and finish them on 8.1, checking the retry counts carry over.
- **Docs to update with the change:**
  - `ARCHITECTURE.md:79-84` (secrets, "exponentially longer"), `ARCHITECTURE.md:169-173` (digest time zone and BigDecimal wording) and `ARCHITECTURE.md:188`.
  - `README.md:7`, `CONTRIBUTING.md:38` (`config/secrets.yml`) and `TESTING.md:54-55` (Minitest pin rationale).
  - The v7.0 guide links in `docs/references/fizzy.md` and `docs/guides/controllers.md`.

---

## 6. Not verified, and open questions

- Whether the 8.1.x patch releases after 8.1.0 contain security fixes isn't confirmed. Pick the version deliberately.
- Real production data hasn't been checked:
  - Notebook `preferences` YAML containing classes outside the YAML loader's permitted list.
  - Users with passwords longer than 72 bytes (7.1 validates this when a password is set).
  - Notes whose `tags` aren't valid JSON.
- Not checked: the real cache store and whether `tmp/cache` is shared between deploys, whether production sets `SECRET_KEY_BASE` or credentials, and how many replicas run during a deploy.
- Development sessions reset because 7.1 reads its secret from `tmp/local_secret.txt` instead of `tmp/development_secret.txt`. **[source]**
- I didn't run Rails 8.1 with Minitest 6, Sidekiq 7.3+, or 8.1 with defaults 7.2 on Rails 7.2.3 (the `enqueue_after_transaction_commit` point is from reading the source only).

---

## My notes

- **The repo is untouched.** `git status` is clean and HEAD is still `ab732f5`. During planning, a downloaded `.gem` file briefly landed in the repo; it was deleted. All the experiments ran in copies under `/tmp/mn-upgrade/`.
- **Section 2C cites the wrong log for the json problem.** `test-v8.1.0-prep_hop71_defaults70.log` actually passes 46/46. The "given 2, expected 1" error in the logs comes from a 7.2.3 run hitting the old `serialize :tags, JSON` call. The problem itself is real, though: a separate check with Rails 8.1.0 and json 3.1.0 got `ActiveSupport::JSON.decode` failing with that error. So you need either the `json < 3` pin or 8.1.4. That check only covered decoding, so "every request that reads a cookie fails" is inferred, not observed.
- **The test logs don't record which fixes each run had.** For example, one 8.1.0 run fails the daylight-saving reminder test (R6). Use `logs/v8.1.0-d81-full.diff` as the record of what passes. These logs were checked and show 46/46 passing:
  - `test-prep70-rails70_final.log` (7.0 with the section 2A changes)
  - `test-v8.1.0-d81-full_slugfix.log` (8.1.0 with 8.1 defaults)
  - `test-v8.1.4-d81-full.log` (8.1.4 with 8.1 defaults)
- **Not re-checked:** the cross-version cookie and job runs, the revert-one-fix runs, the production-server smoke run, and everything tagged **[source]**. Nobody ran the warning against switching to `coder: JSON` while still on 7.0.

Decisions for you:
- **Version:** exact 8.1.0 with `gem "json", "< 3"`, or the latest 8.1.x (8.1.4 doesn't need the pin).
- **R6 reminder display:** keep the current "24 hours later" time across daylight-saving changes, or accept Rails 8.1's new behaviour and update the test.
- **Rollout:** step through each minor version as recommended, or jump straight from 7.0 to 8.1.

If you want me to go ahead, I'd start with the section 2A changes on 7.0, on a branch.
