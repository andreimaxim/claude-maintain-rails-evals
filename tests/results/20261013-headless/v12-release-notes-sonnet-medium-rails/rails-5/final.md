The planner's full plan is below. I haven't implemented any of it, and the working repo is untouched.

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

## How this was verified

- **Disposable copies.** The planner worked in `/tmp/plan/base` (7.0.8.7), `/tmp/plan/up` (8.1.0) and `/tmp/plan/prep` (7.0.8.7 plus the preparatory edits). It used Ruby 3.3.6, isolated PostgreSQL databases and a throwaway Redis.
- **Resolved gems in `up`.**

  | Gem | Version |
  |---|---|
  | rails | 8.1.0 |
  | rack | 2.2.24 (unchanged) |
  | sidekiq | 6.5.12 |
  | redis | 4.8.1 |
  | puma | 5.6.9 |
  | pagy | 8.6.3 |
  | json | 2.21.2 (pinned `< 3`; see finding 1) |
  | action_text-trix | 2.1.19 (new) |
  | rails-dom-testing | 2.3.0 |
  | bigdecimal | 4.1.3 |
  | minitest | 5.27.0 |

- **Test results.**
  - The current app passes 46 tests.
  - A bare 8.1.0 upgrade does not boot. The first stop is `config/initializers/action_text.rb`, and it takes more than ten fixes to reach a clean suite.
  - With every fix below applied, 46 of 46 pass on 8.1.0.
  - With only the preparatory subset applied, 46 of 46 pass on 7.0.8.7.
- **Not run.** System tests were not run because the environment has no Chrome or chromedriver. Trix and Action Text editing in a browser is unverified.
- **Not bisected.** The planner did not install 7.1, 7.2 or 8.0. Which release first breaks each item comes from the changelogs, except where noted.
- **Evidence labels.** **[executed]** means the planner ran it. **[source]** means it came from changelogs or gem source. **[proposed]** means it was not run.
- **Artifacts.**
  - The fully fixed diff is `/tmp/plan/final_up_vs_current.diff`.
  - The preparatory subset is `/tmp/plan/prep_vs_current.diff`.

## A. Required changes

### 1. Gemfile resolution: `json` 3.1.0 breaks every JSON-coded column [executed]
- **What breaks.** `bundle update rails` resolves `json 3.1.0`. Active Support 8.1.0 calls `::JSON.parse(json, options)`, and json 3.x no longer accepts a positional options hash. The error is `ArgumentError: wrong number of arguments (given 2, expected 1)`.
  - It hits `Note#tags` and the transaction-rollback path that restores attributes.
  - It showed up as dozens of unrelated 500s.
- **Fix.** Add `gem "json", "< 3"` to the Gemfile. The planner used 2.21.2.
- **Validation.**
  - Fails: `Note.create!(tag_list: "a,b").reload.tags` on json 3.1.0.
  - Passes: the same call with json `< 3`.
  - Control: Notebook `preferences` (YAML) is unaffected.
- **Open question.** Whether a later 8.1.x patch fixes this was not checked. 8.1.0 is the requested version.

### 2. `Rails.application.secrets` removed (7.2) [executed]
- **Affected code.** `app/models/citation/provider.rb`, `config/secrets.yml`, `test/controllers/citation_enrichments_controller_test.rb`.
- **What happens.** `NoMethodError: undefined method 'secrets'`. Citation enrichment fails in every environment.
- **Fix.**
  - Rename `config/secrets.yml` to `config/citation_provider.yml` and drop the `citation_provider:` nesting under each environment.
  - Add `config.citation_provider = config_for(:citation_provider)` to `application.rb`.
  - Read `Rails.configuration.citation_provider.to_h` in `Provider`.
  - This works on 7.0 [executed in `prep`], so it can ship before the upgrade.
- **Validation.**
  - Fails: the existing credential-passing test, which boots a subprocess with `CITATION_PROVIDER_*` set, fails with `No citation provider is configured` if the config is nested wrongly.
  - Passes: with the right shape, the provider sees user `00123` and password `sample: value # keep`.
  - Control: with ENV unset, development defaults still give `Basic [REDACTED]`.

### 3. `ActionText::ContentHelper.allowed_tags += ...` raises at boot [executed]
- **Affected code.** `config/initializers/action_text.rb`. `allowed_tags` is `nil` by default in 8.x, so `+=` raises `NoMethodError`.
- **Fix.** Assign the full list: `sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"] + %w[details summary]`. This works on 7.0 [executed in `prep`].
- **Validation.** Render a rich-text body with `<details><summary>`, `<script>` and `onclick`. Details and summary must survive, and script and `onclick` must be stripped. Output was byte-identical to 7.0.8.7 under `load_defaults 7.0`.

### 4. Keyword `enum` removed (8.0) [executed]
- **Affected code.** `app/models/note.rb`: `enum status: {...}, _prefix: true`. It raises `ArgumentError` when `Note` loads, so the whole app fails.
- **Fix.** Use `enum :status, { draft: 0, ready: 1 }, prefix: true`. This works on 7.0.
- **Validation.** `status_draft?`, `status_ready` and `Note.statuses.key?` must behave identically. The notes filter test and the digest `status_ready` query cover them.

### 5. `serialize :tags, JSON` removed (7.2) [executed]
- **Fix.** Use `attribute :tags, :json`.
  - It works on 7.0.8.7 and 8.1.0, with stored `["a","b"]` readable both ways.
  - It reads a legacy value, reads the `'[]'` column default, and persists in-place mutation.
- **Why not `serialize :tags, coder: JSON`.** On 7.0 that silently selects the YAML coder and writes `"---\n- a\n- b\n"` into the column. A mixed-version rollout would corrupt data.
- **Not needed now.** `serialize :preferences` (YAML) works unchanged on 8.1 under `load_defaults 7.0`. It fails with `missing keyword: :coder` only if you adopt the 7.1 defaults.

### 6. `alias_attribute :highlight_color, :color` on a store accessor (8.0) [executed]
- **What happens.** `ArgumentError: Note model aliases 'color', but 'color' is not an attribute`.
- **Fix.** Use `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. This works on 7.0.
- **Caveat.** `where(highlight_color:)` and dirty-tracking aliases were available through `alias_attribute`. A repo-wide grep shows no uses.
- **Validation.** `patch note, highlight_color: "blue"` round-trips and the radio `[checked]` shows. Control: an invalid colour still produces a validation error.

### 7. `get "/notes", "/journal", to:` removed in 8.1 [executed]
- **What happens.** `ArgumentError: Wrong number of arguments (expect 1, got 2)` at `config/routes.rb:18`. It was deprecated in 8.0.
- **Fix.** Use two lines: `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. This works on 7.0.
- **Check.** Both `notes_path` and `journal_path` must still exist. The existing test asserts both.
- **Open question.** Route-name equality against `bin/rails routes` on the old version was not confirmed.

### 8. `Enumerable#sum` on strings removed (7.1) [executed]
- **Affected code.** `Export#generate`: `fragments.sum` raises `TypeError: String can't be coerced into Integer`. Every export job fails. This was a deprecation warning on 7.0.
- **Fix.** Use `fragments.join`. This works on 7.0.
- **Validation.** An export with a non-ASCII note title must download as the expected Markdown.

### 9. `where(notebooks: @notebook)` generates `notes.notebooks` [executed]
- **Affected code.** `NotesController#index`. It raises `PG::UndefinedColumn: column notes.notebooks does not exist`, so filtering by notebook breaks.
- **Fix.** Use `where(notebook: @notebook)`. This works on 7.0 and the query is equivalent.
- **Validation.** A request with `notebook_id` returns only that notebook's notes. Control: another reader's notebook ID still raises 404.

### 10. `form_with(model: nil, url:)` [executed]
- **What happens.** `Passed nil to the :model argument, expect an object or false`. The notes index returns 500.
- **Fix.** Drop `model: nil` in `app/views/notes/index.html.erb`. This works on 7.0.

### 11. Transaction exit through `return` now commits (7.2) [executed; silent data bug]
- **Affected code.** `Import#apply`: `return false unless row.note.save` inside `transaction`.
- **What happens.** On 7.0 the `return` rolled back. On 8.1 it commits, and no config toggles it back (`commit_transaction_on_non_local_return` was removed in 8.0).
  - A CSV with one invalid row saves the import and the earlier rows.
  - The test "applying them saves nothing" saw record counts go from `[0,3,0,1]` to `[1,4,1,2]`.
  - Without that test, the change is invisible.
- **Fix.** Use `saved = rows.all? { |r| r.note.save }`, then `raise ActiveRecord::Rollback unless saved`, then return `saved`. This works on 7.0 [executed in `prep`].
- **Other paths.** The other `with_lock` blocks return values by expression, not `return`, so they are fine. Creation and update both go through `save!`.

### 12. `citation[:id]` no longer returns the custom primary key (7.2) [executed; silent data bug]
- **Affected code.** `Import#receipt`. Receipt CSV rows now have an empty DOI: `On idleness,` instead of `On idleness,10.1000/Essays.1`. No error is raised.
- **Fix.** Use `citation&.doi`. This works on 7.0.
- **Validation.** Use the existing import test's CSV, which has two rows citing `10.1000/Essays.1`. Control: a note with no citation still gives an empty DOI.

### 13. `HashWithIndifferentAccess#stringify_keys` stringifies integer keys (8.0) [executed; silent UI loss]
- **Affected code.** `app/views/imports/preview.html.erb` calls `@import.annotations.stringify_keys`, then reads `annotations[row.line]` with an integer key.
- **What happens.** After the upgrade the lookup is `nil`, so the Annotation row disappears from the import preview with no error.
- **Fix.** Remove `.stringify_keys` in the view. Both versions return the right value.

### 14. `retry_on ... wait: :exponentially_longer` removed (8.0) [executed]
- **What happens.** `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. It is raised from `Citation#request_enrichment` on the first failed enqueue, so the whole request path fails.
- **Fix.** Use `:polynomially_longer`.
- **Not a preparatory change.** On 7.0 it fails with the same RuntimeError, so change it in the upgrade release. A lambda such as `wait: ->(n) { n**4 + 2 }` works on both versions but drops the 15% jitter.
- **Rollout.** The wait is computed when a job fails, not stored in the job, so queued retries are unaffected.

### 15. Test environment: `show_exceptions = false` [executed]
- **What happens.** Boolean values are no longer treated as `:none`, so exceptions are rescued and four RecordNotFound tests report "expected but nothing was raised".
- **Fix.** Set `config.action_dispatch.show_exceptions = :none`.
- **Not a preparatory change.** On 7.0 the symbol would be truthy and the tests would break. Change it with the version bump.

## B. Behavior changes with no error, and a decision needed

### 16. Digest day semantics and `BigDecimal` job arguments [executed end to end with real Sidekiq]
- **Affected code.** `User#request_digest`, `DigestJob`, `DigestMailer#daily_digest`. This is the highest-risk finding for deploys.
- **Change a: the job time keeps its zone.**
  - 8.1 serializes the `TimeWithZone` with `"time_zone":"America/New_York"`, so the worker rebuilds it in the reader's zone.
  - The documented behavior is that the worker's zone (UTC) decides the day.
  - For an Eastern reader requesting at 03:30 UTC on 5 Oct, the subject goes from "October 05, 2026" to "October 04, 2026", and `all_day` covers a different window.
- **Change b: `BigDecimal` is a new serializer type.**
  - 8.1 sends `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer"}` even under `load_defaults 7.0`. 7.0 sent the string `"0.3333"`.
- **Experiments.**

  | Scenario | Result |
  |---|---|
  | 7.0 producer → 8.1 worker | Works; digest dated Oct 05. |
  | 8.1 producer with a `BigDecimal` argument → 7.0 worker | `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The job retries and no mail is sent. |
  | 8.1 producer with `reading_completion.to_s` → 7.0 worker | Works; digest dated Oct 05. |

- **Fix, two lines.**
  - In `User#request_digest`, pass `reading_completion.to_s`. `DigestMailer` already runs `BigDecimal(params[:completion])`, and BigDecimal also accepts a `BigDecimal`.
  - In `DigestMailer`, add `requested_at = requested_at.in_time_zone("UTC")`.
  - This is a preparatory change. It works on 7.0 and keeps UTC-day semantics for both old queued payloads and new ones.
- **Recommended.** Keep the UTC-day behavior, which matches the code comments, the reservation key and the test name.
- **Alternative.** Adopt the reader-local day. The planner does not recommend it unless product wants it, because the Redis reservation is still keyed on the UTC day and would disagree with the subject.
- **Rollback.** Deploy the `.to_s` change first. Otherwise a rollback with `BigDecimal` payloads queued would leave dead jobs.
- **Validation.**
  - Fails: enqueue the digest for an Eastern reader at 2026-10-05 03:30 UTC and run it on 8.1. The subject should be "October 05, 2026"; unrepaired it is "October 04".
  - Passes with the mailer change.
  - Control: a UTC reader is unchanged. `DigestsControllerTest` asserts this.

### 17. `Note#next_day_reminder_at` display [executed]
- **What happens.** `to_time` now keeps the receiver's zone. The preview becomes `2026-11-01T08:00:00-05:00` instead of `...09:00:00-04:00` across a DST change. It is the same instant, and the stored epoch is identical.
- **Decision.** To keep today's display, use `Time.at(reminder_epoch + 86_400, in: reminder_at.utc_offset)`, which passes on both versions. Accepting the new display is also valid. In that case use `reminder_at + 24.hours` and update the test and the code comment.

### 18. `NoteReminderJob.set(wait_until: reminder_epoch)` with an Integer [executed]
- **What happens.** `NoMethodError: undefined method 'utc' for an instance of Integer`, from `ActiveJob#serialize`. This follows the 7.1 change that makes `scheduled_at` a `Time`. Every reminder scheduling request and the postpone action return 500.
- **Fix.** Use `wait_until: Time.at(reminder_epoch)`. This is the same on 7.0.
- **Rollout.** Queued reminders stay compatible both ways. A 7.0 worker ran a reminder carrying `scheduled_at`, and an 8.1 worker ran a 7.0 reminder.

## C. Mixed-version rollout and rollback checks

| Check | Result |
|---|---|
| Session cookies across versions, same secret | Both directions return 200 on `/notes`. |
| `Rails.cache` FileStore entries across versions | Readable both ways (cache format 7.0 is kept under `load_defaults 7.0`). |
| Raw `notebooks.preferences` and `notes.tags` | Identical and readable both ways. |
| Download ETag and Last-Modified for exports | Identical, and the 304 behavior is unchanged. |
| Failed Redis enqueue in `Citation#request_enrichment` | Still raises, and the pending state rolls back under `load_defaults` 7.0, 7.2 and 8.1. |
| Dev-only secret | The file name changed from `tmp/development_secret.txt` to `tmp/local_secret.txt`, so local sessions reset. Production is unaffected. |
| `ActiveRecord::Schema[8.1]` and the new dump format | Do not commit a regenerated `db/schema.rb` until the final cutover. A `[8.1]` schema cannot be loaded by 7.0. Fresh `db:migrate` works. |

- **Unverified:** whether `enqueue_after_transaction_commit` matters for other adapters, because the Sidekiq adapter has it off.
- **Unverified:** the two `Time` serializer variants beyond the arguments the planner dumped.

## D. Defaults to adopt later (optional)

The app still calls `load_defaults 7.0`. The planner ran the full suite with `load_defaults` set to 7.1, 7.2, 8.0 and 8.1 on the fixed copy. That temporary switch is not part of the plan.

| Default | Adopted? | Effect here |
|---|---|---|
| 7.1 `raise_on_assign_to_attr_readonly` | No | `NotebooksController#update` permits `:slug` and raises `ActiveRecord::ReadonlyAttributeError: slug`. Remove `:slug` from `notebook_params` and drop the hidden form field first. |
| 7.1 `raise_on_invalid_cache_expiration_time` | No | `exports/_export.html.erb` calls `cache ..., expires_in: export.expires_at - Time.current`. For an already-expired export it raises `Cache expiration time is invalid, cannot be negative`. With the old value, 8.1 swallows the error and caches the "Expired" fragment indefinitely, which is harmless. Before adopting, use `[expires_in, 0].max` or skip caching when expired. |
| 7.1 `default_column_serializer = nil` | No | `serialize :preferences` fails with `missing keyword: :coder`. Use `coder: YAML`. |
| 7.1 `sanitizer_vendor` (HTML5) | No | Small output differences such as nbsp and newline handling in rich-text bodies. `details` and `summary` are still allowed. |
| 7.1 `commit_transaction_on_non_local_return` | No | Moot once finding 11 is fixed. |
| 7.2 `postgresql_adapter_decode_dates` | No | `Notebook#daily_note_counts` raises `TypeError: no implicit conversion of Date into String` at `Date.iso8601(day)`. Guard it, for example `day.to_date`. |
| 7.2 `enqueue_after_transaction_commit` | No | No effect with Sidekiq. |
| 7.2 `web_image_content_types`, `validate_migration_timestamps`, `yjit` | No | No application effect found. |
| 8.0 `to_time_preserves_timezone = :zone` | Effectively adopted already | See finding 17. |
| 8.0 `strict_freshness` | No | Only matters when `If-None-Match` mismatches and `If-Modified-Since` matches. Current outputs are identical. |
| 8.0 `Regexp.timeout` | No | Not checked against the DOI, color and URL patterns; they look linear. |
| 8.1 `action_on_path_relative_redirect = :raise` | No | All redirects use path helpers. |
| 8.1 `escape_json_responses`, `remove_hidden_field_autocomplete`, `raise_on_missing_required_finder_order_columns`, `render_tracker` | No | No JSON or finder usage found. |

**Recommendation.** Do not change `load_defaults` in the upgrade itself, in line with the CLAUDE.md rule to keep framework defaults. Adopt these in separate steps afterwards.

## E. Other observations, no change required
- **Active Storage variants.** Production boot logs `Generating image variants require the image_processing gem`. The app does not create variants, so set `config.active_storage.variant_processor = :disabled` to silence it.
- **Rack stays at 2.2.24.** Rails 8.1 allows it. Rack 3 is a separate follow-up, because the tests use `Puma::Events.strings` and Rack 2 behaviors.
- **Trix.** The layout loads a vendored `trix-1.3.5.js` as a classic script. `actiontext.js` only attaches event listeners in both versions. The new `action_text-trix 2.1.19` gem's own `trix-*.js` and `trix-*.css` are also served by the asset pipeline, and precompile succeeded. A browser check of editing, upload and display is still needed.
- **Sidekiq.** Sidekiq 6.5.12 with redis 4.8.1 ran real enqueue and perform cycles on 8.1.0. The existing `Redis#sadd` deprecation warnings come from redis 4.8.1 and exist today.
- **Ruby.** Pins are unchanged, and `bigdecimal` moves to 4.1.3 as a bundled gem.

## F. Recommended order
1. **On 7.0.8.7, in one or two releases (the preparatory subset):**
   - the enum syntax;
   - `alias_method` for `highlight_color`;
   - the split routes;
   - the `where(notebook:)` fix;
   - `join` in the export;
   - the HWIA lookup;
   - `Time.at` for `wait_until`;
   - `Import#apply` with `Rollback`;
   - `citation&.doi`;
   - `form_with` without `model: nil`;
   - `config_for` provider config;
   - the Action Text initializer;
   - `attribute :tags, :json`;
   - the digest mailer and `.to_s` change;
   - the reminder display decision.

   Run the full suite on 7.0 and deploy. The `tags` and digest changes need a data-integrity check in staging.
2. **In the upgrade release:**
   - bump to 8.1.0 and pin `json < 3`;
   - use `polynomially_longer`;
   - set `show_exceptions = :none`;
   - update the Gemfile.lock;
   - regenerate `db/schema.rb` only if you want the `[8.1]` dump.
3. **Optionally hop** 7.0 → 7.1 → 7.2 → 8.0 → 8.1 to read deprecation warnings at each step. The planner did not run the intermediate versions.
4. **Afterwards:** adopt the `load_defaults` versions one at a time, with the guards from section D.

## G. Validation to add beyond a green suite

| Finding | Check | Control |
|---|---|---|
| 11 | Import a CSV with one invalid row. Assert `Import.count`, `Note.count` and `Citation.count` are unchanged. | A valid CSV still imports all rows. |
| 12 | Assert the receipt CSV row is `On idleness,10.1000/Essays.1`. | A note with no DOI gives an empty field. |
| 13 | Assert the preview shows `Read <b>twice</b> & reflect`. | A row without an annotation shows no Annotation entry. |
| 16 | Run a Sidekiq round trip (a `perform_enqueued_jobs` run is not enough). Assert the subject date for an Eastern reader at 03:30 UTC and that the payload has a string completion. | A UTC reader is unchanged. |
| 5 | Persist `tags`, read back a legacy `["x"]` row, and assert the raw column is JSON, not YAML. | `preferences` YAML is unchanged. |
| 18 | `post note_reminder_path` with a past epoch and assert a 302 with a job. | Postpone still replaces the earlier job. |
| 6 | `patch note_path` with `highlight_color: "blue"` and assert the radio is checked. | An invalid colour still fails validation. |

System tests, a real browser path and mailer delivery to an SMTP server were not executed.

## Key files
- `/tmp/plan/changes.txt`: changelog index output
- `/tmp/plan/final_up_vs_current.diff`: all fixes on 8.1.0
- `/tmp/plan/prep_vs_current.diff`: preparatory edits (verified on 7.0)
- `/tmp/plan/up_test10.log`, `/tmp/plan/prep_test.log`, `/tmp/plan/base_test.log`: test logs
- `/tmp/plan/ld_summary.txt`: `load_defaults` experiment results
- `/tmp/plan/S1.txt`, `/tmp/plan/S2S3.txt`, `/tmp/plan/crossload.txt`: job rollout experiments
- `/tmp/plan/Gemfile.lock.rails8.1.0-json3.1.0`: the lockfile that exposed the json break
- `/tmp/plan/bundle_up.log`: bundle output for the upgrade

## Commentary
- **Decisions for you.** Finding 16 (keep UTC-day digests, as recommended) and finding 17 (keep or accept the new reminder display).
- **Next step.** Tell me if you want me to implement it, starting with the preparatory subset on 7.0.8.7 as in section F.