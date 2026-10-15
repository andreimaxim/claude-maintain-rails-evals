## Upgrade plan: rails 7.0.8.7 to 8.1.0 for this application

**Verdict.** This is not a version bump. With `load_defaults 7.0` kept, the unmodified app does not boot on 8.1.0, and 8.1.0 also changes runtime behavior in ways `load_defaults` does not gate. Each repair below was tested in a disposable copy. Repairs that depend on Rails 8.x cannot be prepared on 7.0. Every other repair passes the full suite on 7.0 and leaves the probed 7.0 behavior unchanged, so it can ship before the bump. The working repository `/home/user/workspace/repo` is unchanged (clean, HEAD `ab732f5`).

### What was run

- Summary: `/home/user/planner-run/out/gem-changes.txt`. Treated as an index only. It omitted the `load_defaults 8.1` block and did not flag several failures (for example `citation[:id]`).
- Isolation: a dedicated PostgreSQL 15 cluster (`/home/user/planner-run/exp/pgdata`, socket `/home/user/planner-run/exp/run`, port 55432) and a dedicated Redis 7.0.15 (port 56379). The shared services on 5432 and 6379 were not used. Environment: `/home/user/planner-run/exp/env.sh`.
- Copies: `exp/base` (7.0.8.7, untouched), `exp/base-prep` (7.0 plus the preparatory set), `exp/r81` (8.1.0 with `load_defaults 7.0` plus all repairs, `json < 3`), `exp/r81-nodigest` (r81 with the digest repairs reverted), `exp/r81-adopt` (r81 with 7.1/7.2 defaults switched on, for the adoption checks).
- Repairs were applied by `/home/user/planner-run/exp/scripts/apply_repairs.py <copy> prep|full`. Probes are in `/home/user/planner-run/exp/scripts/upgrade_probe_test.rb` (P01–P12), `defer_probe_test.rb` (P13).
- Results: baseline 7.0 suite 46 runs / 325 assertions / 0 failures (`exp/logs/base-test.log`). `base-prep` 46 suite runs plus 10 probes: 0 failures (`exp/logs/base-prep-test2.log`), and probe output identical to the untouched baseline. `r81` with all repairs: 0 failures (`exp/logs/r81-full-test2.log`). Probe outputs: `exp/logs/probe-base.txt`, `probe-r81.txt` (unrepaired), `probe-r81-repaired.txt`, `probe-final-r81-adopt.txt`.
- Resolved on 8.1.0: rails, railties, activerecord and the other framework gems 8.1.0; sidekiq 6.5.12; redis 4.8.1; minitest 5.27.0; json 2.21.2 (pinned `< 3`); rack 2.2.24. Ruby 3.3.6 is supported.

### Required before the bump (works on 7.0; executed)

Each item lists the 8.1.0 failure as observed, with `base-prep` evidence.

1. **Action Text `allowed_tags` (boot).** `config/initializers/action_text.rb:3`: `undefined method '+' for nil`. In 8.1 `allowed_tags` has no default. Repair: assign the explicit list derived from `ActionText::ContentHelper.sanitizer.class.allowed_tags` plus `details`, `summary`, the attachment tag, `figure` and `figcaption`. Validation: boot; probe P09 keeps `<details><summary>` and `<mark>`, and strips `javascript:` from links. Output is identical to 7.0.
2. **`enum status: {...}, _prefix: true` (boot).** `app/models/note.rb:10`: `wrong number of arguments (given 0, expected 1..2)`. Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0. Validation: `Note.statuses` and the notes status filter test; control: the stored integers `0` and `1` are unchanged.
3. **`alias_attribute :highlight_color, :color` (boot).** `color` is a `store_accessor`, not an attribute, so 8.1 raises `Note model aliases color, but color is not an attribute`. Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0. Validation: the note form radio `note[highlight_color]` is checked and a PATCH to `blue` persists `color`.
4. **Multi-path route (boot).** `config/routes.rb:18`: `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Repair: two `get` lines with explicit names, `as: :notes` and `as: :journal`. Works on 7.0. Validation: `notes_path` and `journal_path` resolve, and the route table differs from the baseline only in Action Mailbox conductor routes. One earlier run showed an intermittent `undefined local variable or method 'notes_path' for SessionsController` with the auto-named form. It did not recur with the explicit names. Root cause not isolated.
5. **`Rails.application.secrets` removed (runtime).** `Citation::Provider` default raises `undefined method 'secrets'`. Repair: `Rails.application.config_for(:secrets)[:citation_provider].to_h`. Works on 7.0. The citation test helper must stub `config_for`, not `secrets`. Validation: CitationEnrichmentsControllerTest records the request and its Basic auth header against a local stub provider, and a 404 remains a permanent failure.
6. **`Enumerable#sum` on strings (runtime).** `app/models/export.rb:42`: `TypeError: String can't be coerced into Integer`. ActiveSupport's string-summing override was removed in 7.1. Repair: `fragments.join`. Works on 7.0. Validation: the export test asserts the Markdown file content and the `completed` status. Without the repair, the job raises and the export stays `working`; this is inferred from the code, not observed.
7. **`where(notebooks: @notebook)` (runtime).** `GET /notes?notebook_id=…` raises `PG::UndefinedColumn: column notes.notebooks does not exist`. Repair: `where(notebook: @notebook)`. Works on 7.0. Validation: the "filters by notebook" test.
8. **`form_with(model: nil, url: notes_path…)` (view).** `app/views/notes/index.html.erb`: `Passed nil to the :model argument, expect an object or false`. This 500s every notes list page, including the sign-in redirect target. Repair: drop `model: nil`. Works on 7.0. Validation: `GET /notes` returns 200 with `form[role=search][action="/notes"][method=get]`.
9. **Reminder scheduling (runtime).** `NoteReminderJob.set(wait_until: <Integer>)` raises `undefined method 'utc' for an instance of Integer` (`Note#schedule_reminder`), so `POST /notes/:id/reminder` returns 500. Repair: `wait_until: Time.at(reminder_epoch)`. Works on 7.0. Validation: the reminders test asserts the enqueued `at` equals 1793451617. Control: postponement keeps the same epoch arithmetic.
10. **`HashWithIndifferentAccess#stringify_keys` (view).** `app/views/imports/preview.html.erb:22` builds string keys, so integer-line lookups miss and the annotation `<dd>` disappears from the preview. Changelog: 8.0.0.rc1. Repair: remove `.stringify_keys`. Works on 7.0. Validation: preview probe P01 shows the annotation `dd`; control: the body `dd` ("Idle minds") is still present.
11. **`Import#apply` with a `return` inside `transaction` (data integrity; not gated).** In 8.x a `return` inside a transaction commits. The probe applied a CSV whose second row has a blank title: 7.0 leaves counts at `[0,3,1]` (import, note, rich text) and returns false, while 8.1 leaves `[1,4,2]`, a partial import. `ImportsController#create` calls `apply` directly, so this is reachable without preview. Repair: `applied = rows.all? { |row| row.note.save }`, then `raise ActiveRecord::Rollback unless applied`. Works on 7.0; P05 is identical to the 7.0 baseline. Validation: POST a CSV with a blank title and no preview, expecting 422 and no change in `Import.count` or `Note.count`. Control: a valid CSV still imports every row.
12. **Import receipt DOI (data format).** `Import#receipt` uses `citation[:id]`, which returns nil on 8.1 because `[]` no longer maps `id` to the custom primary key `doi`. The receipt DOI column is blank. Repair: `citation.doi`. Works on 7.0. Validation: the receipt CSV test expects `10.1000/Essays.1`; control: the title column is unchanged.
13. **Digest date (data; not gated).** `ActiveJob` deserializes `requested_at` with the reader's zone on 8.1 (`-14400`, `2026-10-04`) instead of UTC (`2026-10-05`). Probe P11 on 8.1: "Your reading digest for October 04, 2026" versus October 05 on 7.0. Repair: `requested_at = requested_at.in_time_zone("UTC")` in `app/mailers/digest_mailer.rb`. Works on 7.0; P11 is identical. Validation: P11 with `r81-nodigest` (repair reverted) fails, and the repaired copy passes. Control: the job arguments for the reader's local time remain as the existing test asserts.
14. **BigDecimal job argument (rollout; not gated).** On 8.1 `DigestJob`'s `BigDecimal` completion serializes as `ActiveJob::Serializers::BigDecimalSerializer`. A 7.0 worker raises `ActiveJob::DeserializationError: … Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. Repair: `reading_completion.to_s` in `User#request_digest`. The payload is the same string as on 7.0, and `DigestMailer` already parses strings. Validation: P11 payload with `to_s` is a plain `"0.5"`, and the mailer still prints "50% of your notes were ready".
15. **Next-day reminder display (not gated).** `Note#next_day_reminder_at` used `to_time`, which in 8.1 is always zone-aware. The "24 hours later" hint changes from "Sun 1 Nov 2026, 09:00 (UTC-04:00)" to "08:00 (UTC-05:00)". The stored epoch is unchanged because postponement uses `to_i`. Repair preserving 7.0 display: `Time.at(reminder_at.to_i + 86_400).getlocal(reminder_at.utc_offset)`. Validation: P03 matches the baseline, and the epoch stays 1793538017. The alternative `reminder_at + 86_400` would show the correct local time but is a product change and would require updating the model comment and the test.

**Required in the bump commit (not preparatory)**

16. **Positional `serialize :tags, JSON` (boot).** `note.rb:12` raises `wrong number of arguments (given 2, expected 1)` on 8.1. The keyword form `serialize :tags, coder: JSON` fixes 8.1 (writes `["a","b"]`, same as 7.0). On 7.0 the keyword is silently ignored: it writes `"---\n- a\n- b\n"` and reads existing JSON text back as a String, which broke 13 tests. Do not prepare it on 7.0. Validation: write `tag_list "a, b"`, assert the raw column is `["a","b"]`, and read a row containing `["x","y"]` back as an Array.
17. **`show_exceptions = false` (test environment).** 8.1 requires `:none`. Without it, tests that expect exceptions see 500s (for example `RecordNotFound` and `Redis::CannotConnectError expected but nothing was raised`). On 7.0, `:none` breaks 8 controller tests, so it cannot be prepared. Production is unaffected (not set).
18. **Active Job `wait: :exponentially_longer` (retry).** Removed in 8.x: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. Repair: `:polynomially_longer`, which 7.0 does not know. A Proc on 7.0 would be an alternative but drops the random jitter. Validation: the citation test expects three attempts on 503; a 404 fails once without retry.
19. **Json gem (dependency).** ActiveSupport 8.1.0 calls `::JSON.parse(json, options)` positionally, and json 3.1.0 accepts keywords only. Every read of the JSON-coded `tags` attribute raises `ArgumentError: wrong number of arguments (given 2, expected 1)`. Repair: `gem "json", "< 3"` (verified). Alternative: move to activesupport 8.1.4 (`gem fetch`, source only, not executed), which calls `JSON.parse(json, **options)`. The requested target is 8.1.0, so pinning is the verified option.
20. **Test-harness adaptations.** The export test's subscriber lambda now receives different arguments on 8.1 (`wrong number of arguments (given 2, expected 1)`); the adaptation accepts both forms. Root cause of the convention change was not characterized. These are test-only and do not change app behavior.

### Optional default adoption, by release

The app keeps `load_defaults 7.0`. Adoption is verified only where stated. Everything below the first line is not forced by 8.1.

- **7.1 defaults:**
  - `active_job.use_big_decimal_serializer`: no longer a switch in 8.x (see 14). Forced.
  - `raise_on_invalid_cache_expiration_time = true`: **executed**. The expired-export partial raises `Cache expiration time is invalid, cannot be negative: -60.0…` (probe P06). Keep off, or guard the `cache` block with `expires_at.future?` (proposed).
  - `raise_on_assign_to_attr_readonly = true`: **executed**. `ActiveRecord::ReadonlyAttributeError: slug` even when the slug is unchanged (P12). The notebook settings form resubmits `slug` (`app/views/notebooks/_form.html.erb:13`), so adoption would 500 on save. Keep off, or stop permitting `slug` on update (proposed).
  - `default_column_serializer = nil`: **executed**; boots because the repaired `Notebook` serializes `preferences` with `coder: YAML`. The bare form would raise a missing coder error.
  - `commit_transaction_on_non_local_return`: removed in 8.x, so repair 11 applies.
  - `message_serializer` and `use_message_serializer_for_metadata`: rolling-deploy risk for signed and encrypted messages and cookies. Source only, not executed.
  - `sanitizer_vendor` (Action Text and Action View): one HTML sample gave identical output with HTML5. Not characterized further.
  - `belongs_to_required_validates_foreign_key`, `precompile_filter_parameters`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined`, `marshalling_format_version`, `log_file_size`, `generate_secure_token_on`, `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `query_log_tags_format`: not exercised; the app has no matching usage that I found, or the setting is test- or log-only. Not verified.
- **7.2 defaults:**
  - `postgresql_adapter_decode_dates = true`: **executed**. `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String` (P04). Keep off. If adopted, `Date.iso8601(day.to_s)` is the proposed fix (not executed).
  - `active_job.enqueue_after_transaction_commit`: **executed** per job. With `self.enqueue_after_transaction_commit = true`, the job is enqueued after commit and discarded on rollback (P13: inside 0, after commit 1, after rollback 0; default: 1, 1, 1). The global config key is excluded from 8.1's global options, so it has no effect and must be set per job class. Impact: `Citation#request_enrichment` and `Note#schedule_reminder` rely on "queued under the row lock". If the enqueue moved after commit, a failed enqueue would no longer roll back the pending state; this is inferred, not observed. Keep off.
  - `validate_migration_timestamps`, `web_image_content_types`, `yjit`: not executed; migrations were not run on 8.1.
- **8.0 defaults:**
  - `to_time_preserves_timezone = :zone`: not optional in 8.1 (see 15).
  - `strict_freshness = true`: default is false under `load_defaults 7.0` in the 8.1 railtie. Not discriminated: probe P07 gave 304 on both versions. Source only.
  - `use_big_decimal_serializer` and `commit_transaction_on_non_local_return`: removed in 8.0 and therefore forced.
- **8.1 defaults (`load_defaults 8.1`, read from the railtie; missing from the summary):** `escape_json_responses = false`, `action_on_path_relative_redirect = :raise`, `raise_on_missing_required_finder_order_columns = true`, `escape_js_separators_in_json = false`, `render_tracker = :ruby`, `remove_hidden_field_autocomplete = true`. The app has no relative redirects and no unordered `first`, `last` or `find_each`, so only the JSON-escape and hidden-field settings could apply. None were executed.

### Mixed-version rollout and rollback

- **Order:** ship the preparatory set on 7.0 first. The queued `DigestJob` payloads then carry a plain string completion and both versions can read them. Verified: a 7.0 payload deserializes on 8.1 with a UTC zone and the string `"0.5"`. The 8.1 payload with `BigDecimalSerializer` is not readable by 7.0 (14).
- **Bump:** the required items 16–20 ship in the same commit as the Rails bump.
- **Rollback:** reverting to 7.0 must also revert `serialize :tags, coder: JSON` to the positional form. With the keyword left in place, 7.0 would write `tags` as YAML. JSON text already in the column reads correctly with the positional form (verified).
- **Stored data:** `notes.tags` is the same JSON text in both forms. `notebooks.preferences` stays YAML with `coder: YAML`. The bump needs no migration.
- **Partial imports:** imports applied on unrepaired 8.1 may have left partial data. The `imports` table stores no CSV, so partial imports cannot be detected from the database. Cleanup is manual.
- **Exports:** exports that failed on 8.1 remain `working`. Users can cancel them, because `cancellable?` covers `working`. Retries restart `generate` from the first note.
- **Reminders:** jobs enqueued by 7.0 carry the same epoch in `at`. Not executed end to end.

### Unverified and open

- Real Sidekiq workers against Redis, production boot (`eager_load`, `show_exceptions :all`), migrations on 8.1, and `bin/rails test:system` (Selenium) were not executed.
- Session cookies and signed messages across 7.0 and 8.1 were not tested.
- The 8.1.4 alternative to pinning json is source-only.
- Changelog entries for `where(notebooks:)`, `form_with(model: nil)`, `read_attribute(:id)` and the Active Job zone preservation were not located in the summary. They are observed on 8.1.0, not traced to a changelog line.
- The summary's release list covers 7.0.10 through 8.1.0. I read the entries I cited, not all 1,579.
- The latest 8.1 patch is 8.1.4 per rubygems. Choosing between 8.1.0 with a json pin and 8.1.4 is a decision for the team.
- The digest test and the parallel test runs share Redis across workers. This did not cause the observed failures but was not isolated.

---

I did not implement the upgrade. The repo is unchanged. The planner's findings mean the change is larger than a Gemfile bump: about 20 items, with items 1–15 shippable on 7.0 first and items 16–20 belonging in the bump commit.

Decision for you: should I implement this in the repo, and if so, in which order? The options are:
- **Preparatory 7.0 commit first** (items 1–15), then the bump commit (items 16–20 plus `rails "8.1.0"`), with `json < 3` pinned as the verified choice. This matches the rollout the planner recommends.
- **Single commit** with everything together.

I'd recommend the two-commit path. It keeps the risky 8.x changes isolated and lets you revert the bump without losing the 7.0 fixes. Also confirm whether you'd prefer the json pin or moving to activesupport 8.1.4, since the latter is not the version you requested.