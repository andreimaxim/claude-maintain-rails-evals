I've made a plan for upgrading Rails from 7.0.8.7 to 8.1.0 but haven't changed your repository yet. Here is the planner's full plan:

---

I've worked out the 7.0.8.7 → 8.1.0 plan, and I did not change `/home/user/workspace/repo`. With only the Gemfile changed, the app doesn't boot. Once the required repairs below are applied in a disposable copy, it boots, eager-loads, serves production-mode requests and runs real Sidekiq jobs. The suite passes there (46 runs, 0 failures) with `load_defaults` set to each of 7.0, 7.1, 7.2, 8.0 and 8.1. Two of these upgrades lose or corrupt data without failing loudly: a failed CSV import would commit some of its rows (finding 7), and rolling back while digest jobs are queued would fail those jobs (finding 12).

**Evidence labels:** **[ran]** means I saw it happen in an experiment, **[source]** means I read it in the gem or app code, and **[proposed]** means it is still unchecked.

**Test setup.** Two clones live under `/tmp/upg/work`: `base` (still on 7.0) and `up` (8.1.0). They use their own Postgres 15 on a socket in `/tmp/upg/work`, port 55432, and their own Redis on port 56379, both now stopped. Disk storage and file mail were per copy. Environment files are `/tmp/upg/env.sh` and `/tmp/upg/prodenv.sh`.

- **Resolved versions** (`/tmp/upg/up-Gemfile.lock`): rails 8.1.0, json 2.21.2 (pinned, see finding 1), rack 2.2.24 (held there by sidekiq 6.5.12), redis 4.8.1, puma 5.6.9, pg 1.6.0, action_text-trix 2.1.19, minitest 5.27.0.
- **Full diff** of the upgraded copy: `/tmp/upg/up-full.diff`. The `EXP_LOAD_DEFAULTS` switch in its `config/application.rb` was only for experiments.
- **Changes that also work on 7.0:** `/tmp/upg/base-preparatory.diff`. The 7.0 suite still passes with it (`/tmp/upg/base-prep-test.log`).
- **Other logs:** change summary `/tmp/upg/changes.txt`; tests `/tmp/upg/base-test.log`, `/tmp/upg/up-test.log` and `/tmp/upg/up-test-defaults-{7.0,7.1,7.2,8.0,8.1}.log`; servers `/tmp/upg/*-server.log`; Sidekiq `/tmp/upg/sidekiq-run.log`; experiment scripts in `/tmp/upg/scripts/`.

## A. Required changes (the app breaks without them)

Each finding has a "Prep" note: "on 7.0" means it can ship before the upgrade (all of those were applied to `base` and its suite passed); "with the upgrade" means it only works on 7.1 or later and must ship in the upgrade commit.

1. **The `json` gem must be pinned below 3.** [ran] Bundler picked json 3.1.0 as a new dependency. Rails 8.1.0 calls `::JSON.parse(json, options)` with a plain hash, which json 3.1 rejects, so reading any JSON column (here `Note#tags`) fails: `ArgumentError: wrong number of arguments (given 2, expected 1)` at `activesupport-8.1.0/.../json/decoding.rb:25`.
   - Fix: add `gem "json", "~> 2.15"` (resolved to 2.21.2).
   - Check: without the pin, any page loading `notes.tags` raises; with it, that works. Control: saved tags still read back as `["a","b"]`.
   - Prep: with the upgrade.
   - Not checked: whether a later 8.1.x works with json 3.

2. **Action Text allowed tags** (`config/initializers/action_text.rb`). [ran] Boot fails with `undefined method '+' for nil (NoMethodError)`, because in 7.1+ `ActionText::ContentHelper.allowed_tags` starts as nil.
   - Fix: inside `config.after_initialize { ActiveSupport.on_load(:action_view) { ... } }`, set `allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]`.
   - Running it after initialization means it picks up whichever sanitizer is configured, HTML4 now or HTML5 if you adopt that 7.1 default. The `details`/`script` test passed under both.
   - Prep: on 7.0. Check: `NotesControllerTest` "rich text keeps collapsible excerpts and drops unsafe markup".

3. **`Note`: old `enum` syntax and positional `serialize` coder.** [ran]
   - `enum status: {...}, _prefix: true` fails at eager load: `ArgumentError: wrong number of arguments (given 0, expected 1..2)`. Use `enum :status, { draft: 0, ready: 1 }, prefix: true` (prep: on 7.0).
   - `serialize :tags, JSON` fails: `(given 2, expected 1)`. Use `serialize :tags, coder: JSON` (prep: with the upgrade). The stored JSON text is unchanged.

4. **`Note`: `alias_attribute :highlight_color, :color`** points at a store accessor, not a database column. [ran] The first use of `Note` raises `Note model aliases 'color', but 'color' is not an attribute`.
   - Fix: `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`.
   - Prep: on 7.0. Check: the notes edit test asserts `settings == {"color"=>"green"}` and the radio button is checked.

5. **`Rails.application.secrets` was removed in 7.2.** [ran] `Citation::Provider.new` and its test raise `undefined method 'secrets'`, so the "fetch citation metadata" action fails on every request.
   - Fix: move the settings to `config/citation_provider.yml`, load them with `config.x.citation_provider = config_for(:citation_provider)`, and read `Rails.configuration.x.citation_provider.to_h` in the provider. Update the provider test helper the same way.
   - Prep: on 7.0. Executed check: production mode returns `{url: nil, ...}`; development returns the local defaults.
   - Also update the mentions in `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md` and the provider comment.
   - Deploy order: set the same `CITATION_PROVIDER_*` environment variables before the switch. `secret_key_base` is unaffected because `secrets.yml` never held it.

6. **`retry_on ... wait: :exponentially_longer`** (`CitationEnrichmentJob`). [ran] Loading works, but the first retry fails: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. The job errors instead of retrying, and the "failed" state is never recorded.
   - Fix: `:polynomially_longer`. Prep: with the upgrade (7.0 doesn't have it).
   - Real Sidekiq run: retries came after 3s and then 18s.

7. **`Import#apply` commits a partial import.** [ran] `return false` inside `transaction` now commits instead of rolling back. The test "invalid rows ... applying them saves nothing" showed counts going from `[0,3,0,1]` to `[1,4,1,2]`: one extra Import, Note, Citation and rich text were saved while the user saw an error. No error is raised, so this is silent bad data.
   - Fix: `applied = false; transaction { save!; raise ActiveRecord::Rollback unless rows.all? { |r| r.note.save }; applied = true }; applied`.
   - Prep: on 7.0. The controller's re-preview path still works, and the success path's receipt test passes.
   - After deploying, look for partial `imports` rows created during any window where the old code ran on 8.1.

8. **Import receipt CSV loses its DOIs.** [ran] Since 7.1, `citation[:id]` reads a column literally named `id`, and `citations` has none (its key is `doi`). The receipt came out as `On idleness,` with the DOI empty.
   - Fix: `citation&.doi`. Prep: on 7.0.

9. **Import preview hides annotations.** [ran] In 8.0 `HashWithIndifferentAccess#stringify_keys` returns a plain Hash, so `annotations[row.line]` (an Integer key) finds nothing. The test showed `Actual: "10.1000/Essays.1"` where the annotation should be.
   - Fix: use `row.annotation` in `imports/preview.html.erb`. Prep: on 7.0.

10. **Routes and views.** [ran]
    - `get "/notes", "/journal", to:` fails while drawing routes: `Wrong number of arguments (expect 1, got 2)`. Fix: two `get` lines with `as: :notes` and `as: :journal`, which keeps both named helpers seen on 7.0.
    - `form_with(model: nil, ...)` in `notes/index` fails: `Passed nil to the :model argument`. Fix: drop `model: nil`.
    - `@notes.where(notebooks: @notebook)` fails: `PG::UndefinedColumn: column notes.notebooks does not exist`. Fix: `where(notebook: @notebook)`.
    - Prep: all on 7.0.

11. **Reminders: integer `wait_until`.** [ran] `NoteReminderJob.set(wait_until: reminder_epoch)` raises `undefined method 'utc' for an instance of Integer`, so scheduling a reminder returns 500.
    - Fix: `wait_until: Time.at(reminder_epoch)`. Prep: on 7.0. The test checks the job's `:at` equals `Time.utc(2026,10,31,13).to_i`.

12. **`DigestJob` arguments: a mixed-version and rollback hazard.** [ran]
    - **BigDecimal argument.** 8.1 always serializes BigDecimal with `BigDecimalSerializer`, whatever the defaults. A digest queued by 8.1 and run by a 7.0 worker failed: `ActiveJob::DeserializationError ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. Fix: pass `reading_completion.to_s` in `User#request_digest`; the mailer already calls `BigDecimal(...)`. Ship this before the upgrade. It works on 7.0, and a string payload from 8.1 ran fine on 7.0.
    - **Time zone of `requested_at`.** 7.1+ keeps the zone of time arguments (the payload gains `"time_zone":"Asia/Tokyo"`). The mailer then covers the reader's local day instead of the documented UTC day. The test got "October 04" where "October 05" was expected. Fix in `DigestMailer`: `requested_at = requested_at.in_time_zone(Time.zone)`. This handles both payload formats; a 7.0-queued job run on 8.1 produced "October 07".
    - Check: a Tokyo reader requests at 2026-10-07 20:00 UTC; assert the subject says October 07. Control: a UTC reader's subject is unchanged.

13. **`Export#generate` uses `fragments.sum` on strings.** [ran] Every export fails: `TypeError: String can't be coerced into Integer`. Fix: `fragments.join`. Prep: on 7.0. The Markdown download test passes.

14. **"Remind me a day later" shows a different time.** [ran] 8.1 removed the old `to_time` behavior. Across the 2026-11-01 DST change, `reminder_at.to_time + 86_400` displays `08:00-05:00` instead of the documented `09:00-04:00`. The scheduled moment is the same (`1793538000`); only the shown time changes.
    - Fix: `Time.at(reminder_epoch, in: reminder_at.formatted_offset) + 86_400`. It gave identical output on 7.0 and 8.1.
    - I recommend keeping the documented offset behavior. Switching to local wall-clock time would need a product decision and changes to the test and the model comment.

15. **Test environment setting.** [ran] With `show_exceptions = false`, exceptions became 500 pages, which broke every `assert_raises(RecordNotFound)` test. Fix: `:none`. Prep: with the upgrade (on 7.0 that value would turn on exception pages).

## B. New framework defaults

None of these is set explicitly today; `load_defaults 7.0` keeps the old values. The listed preparatory changes (P1–P3 below) let each `load_defaults` level pass the suite [ran].

**7.1**
- `default_column_serializer = nil`: `Notebook` fails to load with `missing keyword: :coder`. **P1:** `serialize :preferences, coder: YAML`. It reads the existing YAML hashes, but only works on 7.1+.
- `raise_on_assign_to_attr_readonly`: notebook update raises `ActiveRecord::ReadonlyAttributeError: slug` when a forged slug is submitted. A same-value slug did not raise. **P2:** remove `:slug` from `notebook_params` (on 7.0).
- `raise_on_invalid_cache_expiration_time`: the exports page raises `Cache expiration time is invalid, cannot be negative: -60.0` for any expired export, and production has caching on.
  - This also changes without the default: 7.0 treated a negative expiry as already expired, while 8.1 with the old setting stores the entry **with no expiry** and reports the error.
  - **P3:** `expires_in: [export.expires_at - Time.current, 1.second].max` (on 7.0). It keeps the "cached link doesn't authorize a download" test passing. I rejected `cache_if`, because it broke that test's cached read.
- `message_serializer`, `use_message_serializer_for_metadata`: session cookies worked across 7.0 and 8.1 in both directions, including with 8.1 defaults [ran]. To be safe, still adopt them in a later deploy than the gem change.
- `sanitizer_vendor` HTML5 (Action View and Action Text): the `details`/`summary` test passes with finding 2's repair.
- `dom_testing_default_html_version = :html5`: the suite passed.
- `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `run_after_transaction_callbacks_in_order_defined`: the app has no `after_commit` callbacks.
- `belongs_to_required_validates_foreign_key`: one fewer query for `Notebook`/`Export`/`Import` belongs_to checks.
- `generate_secure_token_on`, `allow_deprecated_singular_associations_name`, `allow_deprecated_parameters_hash_equality`, `query_log_tags_format`, `precompile_filter_parameters`, `debug_exception_log_level`, `log_file_size`: no app use found [source].
- `commit_transaction_on_non_local_return`: no longer configurable on 8.1; it already applies (finding 7).
- `use_big_decimal_serializer`: always on in 8.1 (finding 12).
- Active Record encryption settings: encryption isn't used.

**7.2**
- `postgresql_adapter_decode_dates`: the activity report fails with `TypeError: no implicit conversion of Date into String`. **P4:** `[day.to_date, count]` (on 7.0).
- `enqueue_after_transaction_commit`: it stayed `false` on 8.1 even with 8.1 defaults [ran]. If it is ever set to `true`, the documented guarantee that a failed enqueue rolls back `Citation#request_enrichment` and `Note#schedule_reminder` stops holding.
- `validate_migration_timestamps`: the existing timestamps are valid.
- `web_image_content_types` (adds webp): only changes how attachments display.
- `yjit = true`: Ruby 3.3.6; watch memory.

**8.0**
- `to_time_preserves_timezone = :zone`: already in effect on 8.1 (finding 14).
- `strict_freshness`: download conditional GETs gave the same results on 7.0, 8.1 and 8.1 with new defaults: 304, 304 and 200 for both validators matching, ETag matching with an old date, and ETag mismatching [ran]. The ETag value is unchanged.

**8.1**
- The summary listed no new 8.1 defaults, but the changelog says `load_defaults 8.1` switches template dependency tracking to `:ruby`. Only fragment-cache digests could change.

## C. Rollout, rollback and follow-ups

- **Rollout order:**
  1. Ship the preparatory changes on 7.0: findings 2, 3 (enum), 4, 5, 7–14, and P2–P4.
  2. Ship the gem bump together with the json pin, the `coder:` changes (findings 3 and P1), `:polynomially_longer` and `show_exceptions :none`.
  3. Adopt new defaults later, one version at a time.
- **Queued and scheduled work:**
  - Existing scheduled reminders (GlobalID only) and citation retries run on either version.
  - Digests are safe across versions once finding 12 is applied.
  - `ExportJob` takes a primitive argument and is unaffected.
- **Rollback:** don't commit a regenerated `db/schema.rb` during the rollback window. 8.1 writes `Schema[8.1]`, sorts columns alphabetically and writes `pg_catalog.plpgsql`, and 7.0 cannot load that.
- **Sidekiq:** the built-in adapter logs "deprecated and will be removed in Rails 8.2" [ran]. Moving to Sidekiq 7.3.3+ is a separate project: with redis-client, `sadd` may return Integer 0, which Ruby treats as true, and would break the once-per-day digest guard in `User#request_digest` [source, not tested].
- **Trix:** the layout loads `vendor/javascript/trix-1.3.5.js` while 8.1 ships Trix 2.1.19 through `action_text-trix`. I could not test the editor in a browser, and there are no system tests. Proposed check: create and edit a note with a link and a file attachment, and assert the attachment survives the save. Consider moving to the bundled Trix.
- **Other:**
  - `Note.connection` is soft-deprecated since 7.2 but gave no warning.
  - 8.1 logs an `image_processing` warning; setting `config.active_storage.variant_processor = :disabled` is optional.
  - The `csv` gem warning is a Ruby 3.4 concern.
- **Still unverified:** browser and Trix behavior; Sidekiq 7 migration; production log and error-reporter volume; whether partial imports already exist in production.

---

The upgrade skill only produces a plan, so I haven't edited the app or committed anything. The planner's tested diffs are in `/tmp/upg/`: `base-preparatory.diff` for the changes that also work on Rails 7.0, and `up-full.diff` for the full upgrade. If you'd like, I can apply them in the order above, starting with a preparatory branch that stays on 7.0.