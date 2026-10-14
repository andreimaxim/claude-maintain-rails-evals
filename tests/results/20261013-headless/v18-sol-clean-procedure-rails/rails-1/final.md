I've planned the Rails upgrade but haven't made it yet: the upgrade skill only produces a plan, and nothing in the repository has changed. Your `Gemfile.lock` has `rails` at 7.0.8.7. The planner's full report follows unchanged.

---

# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

**Bottom line:** the upgrade is feasible, but not as a bare version bump. 18 framework changes affect this app's code. Releases 7.1.6, 7.2.4, 8.0.5.1 and 8.1.0 all fail to boot until the first one is fixed, and 8.1.0 also needs one Gemfile constraint. With all repairs below, the test suite passes on every crossed release (46 runs, 340 assertions). Passing tests are not proof of completeness: 819 changelog rows remain unreviewed, and the browser editor was not tested.

**Starting point:** Ruby 3.3.6 (Rails 8.1 needs at least 3.2), Bundler 2.5.22, `load_defaults 7.0`, every gem from rubygems.org. Releases crossed: 7.0.10, 7.1.6, 7.2.4, 8.0.5.1, 8.1.0, with no source gaps. There is no CI config, so I used the documented command `bin/rails test`.

**Lab setup notes:**
- I forced `PARALLEL_WORKERS=1`, so the normal parallel run is still unchecked.
- The lab copier skips `vendor/` and empty directories. As a lab-only fix I copied `trix-1.3.5.js` into `app/javascript`, removed the `vendor/javascript` link from `manifest.js` and added `app/assets/images/.keep`. This is not an app change.
- Before that fix the baseline failed with `link_tree argument must be a directory`. After it, the baseline is green (46 runs, 325 assertions).
- The baseline already warns about `Enumerable#sum` at `export.rb:42`.
- Sidekiq's "ExportJob args do not serialize to JSON safely" warning appears on 7.0.8.7 too, so it is not caused by the upgrade.

## 1. Required changes

Evidence labels: **executed** means a lab run (logs under `/tmp/tmp.zhdcNKoFO7/lab/runs/`). **Source-based** means read in the installed gem source. **Proposed** means not run.

"Prep-safe" means the repair passes on 7.0.8.7 and can ship first. All prep-safe repairs together are the variant `curprep`: 46 runs, 325 assertions, no deprecations. Each probe asserts an app result with unequal inputs plus an unaffected control.

| # | Release / changelog ID | File and caller | Consequence (quoted) | Repair | Validation |
|---|---|---|---|---|---|
| F1 | 7.1, C141/C143 (Action Text `allowed_tags` now defaults to `nil`) | `config/initializers/action_text.rb:3` | Boot fails: `undefined method '+' for nil (NoMethodError)` on every stage from 7.1 (executed, `r716` boot.log) | In `after_initialize`, use `allowed_tags` or the sanitizer's default list plus attachment/figure/figcaption, then add `details`, `summary`. Prep-safe. | p01: `<details>` kept; controls: `<script>` removed, `<b>` kept, attachment tag allowed. Passes on current, curprep, r810h (executed). |
| F2 | 7.1, C470 (`Enumerable#sum` override removed) | `Export#generate`, `fragments.sum` | `TypeError: String can't be coerced into Integer` (executed, rvsum716) | `fragments.join`. Prep-safe. | p02: two notes come out oldest first; control: an empty notebook gives `"# Empty\n"` (executed). |
| F3 | **7.0.9**, C4 (time arguments keep their time zone) | `DigestMailer#daily_digest`; payload from `User#request_digest` | Subject `October 04, 2026` instead of `October 05` (executed, r7010 tests and p03) | `params[:requested_at].utc`. Prep-safe. Needed already at 7.0.10. | p03 cross-version payloads (executed): 7.0.8.7 payload read by 8.1 passes; 8.1 payload read by 7.0.8.7 (rollback) passes; 8.1 payload read by unrepaired 7.0.10 gives Oct 04. |
| F4 | 7.1 deprecation, 7.2 removal (C178/C826/C829/C1260) | `User#request_digest` passes a BigDecimal to `DigestJob` | An 8.1 payload becomes `{"_aj_serialized":"…BigDecimalSerializer","value":"0.5"}`. 7.0.8.7 (rollback) then fails: `ActiveJob::DeserializationError … BigDecimalSerializer is not known` (executed) | Pass `reading_completion.to_s`. The payload stays `"0.5"` in both directions. Prep-safe. | p03 rollback read passes with the repair; control: the mail still says "50% of your notes were ready". |
| F5 | 7.2, C922 (positional coder for `serialize` removed) | `Note`, `serialize :tags, JSON` | `serialize: wrong number of arguments (given 2, expected 1)` (executed, r724a) | `serialize :tags, coder: JSON`. **Ship with the 7.1 bump only.** On 7.0 the keyword is ignored and tags are stored as `"---\n- beta\n- alpha\n"` (executed, curfix2). | p04: stored `["beta","alpha"]`; an existing JSON row reads back; control: default `[]` (executed on r810h). |
| F6 | 7.2 / 8.0, C870/C1268 (keyword-argument `enum` form) | `Note`, `enum status:, _prefix:` | 7.2: "…`status_draft?`, which is already defined by another enum". 8.0: `wrong number of arguments (given 0, expected 1..2)` (executed) | `enum :status, { draft: 0, ready: 1 }, prefix: true`. Prep-safe. | p05: `status_ready?` and the status scope work (executed). |
| F7 | 7.2, C279/C917 (`alias_attribute` to a non-attribute) | `Note`, `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`) | `ArgumentError: Note model aliases 'color', but 'color' is not an attribute` (executed, rvalias724) | `alias_method :highlight_color, :color` plus `alias_method :highlight_color=, :color=`. Prep-safe. | p05: writes `settings == {"color"=>"green"}`; `purple` rejected via the `color` validation; control: blank allowed. |
| F8 | 7.2, C830 (numeric `scheduled_at` removed) | `Note#schedule_reminder`, `set(wait_until: epoch)` | `NoMethodError: undefined method 'utc' for an instance of Integer` (executed, rvwait724) | `wait_until: Time.at(reminder_epoch)`. Prep-safe. | p07: job scheduled at the exact epoch, job id saved, postponing adds 24h; control: `nil` is refused. |
| F9 | 7.2, C277/C915 (`read_attribute(:id)` no longer means primary key) | `Import#receipt`, `citation[:id]` (Citation's key is `doi`) | Receipt reads `Cited,` instead of `Cited,10.1000/…` (executed, rvimp724) | `citation&.doi`. Prep-safe. | p06: receipt shows the DOI; control: uncited row is blank. |
| F10 | 7.2, C913 (`return` inside `transaction` now commits) | `Import#apply`, `return false unless row.note.save` | Invalid import saves partially: counts `[0,0]` become `[1,1]` (executed) | Raise `ActiveRecord::Rollback` and return `saved == true`. Prep-safe. | p06: an invalid row saves nothing and returns false; control: a valid import applies. |
| F11 | 7.2, C534/C1012 (`Rails.application.secrets` removed) | `Citation::Provider#initialize` and the citation enrichment test helper | `NoMethodError: undefined method 'secrets'` (executed, rvsec724) | Add `config/citation_provider.yml` (same ERB, `.to_json` quoting), set `config.citation_provider = config_for(:citation_provider)`, and update the test helper. Prep-safe. Delete `config/secrets.yml` afterwards. | p08: values come from ENV; control: explicit settings override. The fresh-boot credentials test passes on r810h. |
| F12 | 7.2, C803 (`show_exceptions` true/false removed) | `config/environments/test.rb` | 7.1 warns that `false` is deprecated | Use `:none` **only from 7.1**. On 7.0, `:none` counts as true and turns errors into 500 pages (executed, curfix2: 23 failures). | Suite green on r716h through r810h. |
| F13 | 7.2, C914 (plural name for a singular association removed) | `NotesController#index`, `where(notebooks: @notebook)` | `PG::UndefinedColumn: column notes.notebooks does not exist` (executed) | `where(notebook: @notebook)`. Prep-safe. | p09: notebook A included, B excluded. |
| F14 | 7.2, C828 (`:exponentially_longer` removed) | `CitationEnrichmentJob` `retry_on` | Removed in 7.2 | `wait: :polynomially_longer` from 7.1 (raises on 7.0, executed). | p11: delays 3 s and 18 s, the same on 7.0 (old value) and on 7.1 and 8.1 (new value). |
| F15 | 8.1, C1392 (one route with several paths removed) | `config/routes.rb`, `get "/notes", "/journal"` | `Wrong number of arguments (expect 1, got 2)` (executed, r810a routes.log) | Two routes, the first with `as: :notes`. Prep-safe. | p09: `notes_path == "/notes"`, `/journal` routes to `notes#index`; control: `/notes`. |
| F16 | 8.0, C1258 (`form_with model: nil` removed) | `notes/index.html.erb` search form | `Passed nil to the :model argument` (executed, r8051f) | Remove `model: nil`. Prep-safe. | Search-form request tests pass on r8051h. |
| F17 | 8.0, C1273 (`stringify_keys` now stringifies Integer keys) | `imports/preview.html.erb`, `@import.annotations.stringify_keys` | Annotation missing from the preview (`dd` shows the body text `"a"`) (executed, rvprev8051) | Remove `.stringify_keys`. Prep-safe. | p10: line 2 annotation shown; control: line 4 has none. |
| F18 | 8.1, C1541/C1526 (`to_time` always keeps the zone) | `Note#next_day_reminder_at` | Hint shows `08:00-05:00` instead of `09:00-04:00` across the DST change (executed, rvnext810) | `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`. Prep-safe. | p07: hint and the +24h epoch are correct. |
| F20 | 8.1, C1424 (built-in Sidekiq adapter deprecated) | `config.active_job.queue_adapter = :sidekiq` with sidekiq 6.5.12 | Only a deprecation (source-based); tests use the test adapter, so it never showed. | Follow-up: Sidekiq ≥ 7.3 ships its own adapter. That move also changes `redis`/`sadd` behaviour, so do it as a separate upgrade. | Proposed. |

**Required dependency change (8.1.0):** `activesupport 8.1.0` depends on `json` with no upper bound, so Bundler resolves `json 3.1.0` (released 2026-10-13). json 3 accepts only keyword options, and Rails 8.1.0 still passes a positional hash in `ActiveSupport::JSON.decode`. Result: `ArgumentError: wrong number of arguments (given 2, expected 1)` from session decryption, 40 test errors (executed, r810f). Add `gem "json", "~> 2.7"` (resolves 2.21.2). Remove it once a Rails patch release fixes the call.

## 2. Optional defaults (keep `load_defaults 7.0` for this upgrade)

"Effective" values come from a runner probe on 7.0.8.7 and the repaired 8.1.0 (p12). On 8.1 the effective values stay at the old behaviour, except:
- **Forced by version, not optional:** F18 (`to_time` always keeps the zone; an 8.0 boot deprecation comes from the `load_defaults 7.0` value).
- `commit_transaction_on_non_local_return`: no longer configurable from 7.2, which is F10.
- `web_image_content_types` no longer includes `image/jpg`. The app has no image variants, so this does not matter.

| Defaults version | Setting | Effective now → on 8.1 | App impact if you enable it later |
|---|---|---|---|
| 7.1 | `raise_on_assign_to_attr_readonly` | false → false | `NotebooksController#update` resubmits `:slug` (the field is `attr_readonly`) and would raise. First stop permitting `:slug`. (Source-based) |
| 7.1 | `raise_on_invalid_cache_expiration_time` | — → false | `exports/_export` computes `expires_in: expires_at - Time.current`, which is negative for expired exports and would raise. Clamp it first. (Proposed probe) |
| 7.1 | `default_column_serializer` | YAML → YAML | `Notebook serialize :preferences` (no coder) would raise. Give it a coder; stored data is YAML. (Source-based) |
| 7.1 | `message_serializer`, `use_message_serializer_for_metadata`, `marshalling_format_version` | nil / 6.1 | Cookies/messages written after enabling can't be read by older servers. Enable one deploy after the upgrade settles. |
| 7.1 | sanitizer vendor (Action View / Action Text), `dom_testing_default_html_version` | HTML4 → HTML4 | Re-run p01 and the rich-text tests with HTML5. |
| 7.1 | `use_big_decimal_serializer` | n/a | Option removed in 8.0; covered by F4. |
| 7.1 | other 7.1 settings: callback order, `before_committed_on_all_records`, `belongs_to_required_validates_foreign_key`, `generate_secure_token_on`, `precompile_filter_parameters`, encryption settings, SQLite strict strings, query log format, `debug_exception_log_level`, `log_file_size` | old behaviour | No app usage found (no encryption, secure tokens or after_commit callbacks; PostgreSQL only). |
| 7.2 | `enqueue_after_transaction_commit` | n/a → false | **Do not enable.** `Citation#request_enrichment` and `Note#schedule_reminder` rely on a failed enqueue rolling back inside the row lock. |
| 7.2 | `postgresql_adapter_decode_dates` | — → false | `Notebook#daily_note_counts` calls `Date.iso8601` on the raw value and would fail on a Date. Repair before enabling. (Source-based) |
| 7.2 | `validate_migration_timestamps`, `yjit`, webp content types | false | Low impact. |
| 8.0 | `strict_freshness` | false | `ExportDownloadsController stale?(etag:, last_modified:)` changes only when both headers are sent. |
| 8.0 | `Regexp.timeout = 1` | nil | Optional. |
| 8.1 | `escape_json_responses`, `escape_js_separators_in_json` | true | No JSON responses in the app. |
| 8.1 | `raise_on_missing_required_finder_order_columns` | nil | Optional. |
| 8.1 | `action_on_path_relative_redirect` | :log | Optional. |
| 8.1 | `render_tracker`, `remove_hidden_field_autocomplete` | off | Hidden `import[csv]` and slug fields would lose `autocomplete`; tests don't depend on it. |

## 3. Rollout and rollback

1. **PR 1, still on 7.0.8.7 (prep-safe):** F1, F2, F3, F4, F6, F7, F8, F9, F10, F11, F13, F15, F16, F17, F18. Executed on 7.0.8.7: green and no deprecations. F3 and F4 must be live before any 7.0.10+ or 7.2+ worker runs.
2. **PR 2, 7.0.8.7 → 7.0.10:** no further code.
3. **PR 3, 7.1.6:** F5 (`coder: JSON`), F12 (`:none`), F14 (`:polynomially_longer`). Executed green (r716h). Leave `concurrent-ruby 1.3.4` and `minitest ~> 5.25` pinned; both are allowed by 8.1.
4. **7.2.4, then 8.0.5.1, then 8.1.0** (8.1.0 with the `json ~> 2.7` pin). Executed green (r724h, r8051h, r810h). Deploy each release separately and drain Sidekiq queues between steps.

**Queue compatibility (executed in both directions):** with F4 the completion argument stays a plain string. Time payloads written from 7.0.9 onward carry a `time_zone` key that older readers ignore. Old payloads read correctly on 8.1.

**Rollback:** every repair except F5, F12 and F14 is safe on 7.0.8.7. To roll back past 7.1, revert those three together with the Gemfile. `tags` data stays JSON either way, because F5's coder writes the same format.

**Proposed before production:**
- Run the full suite with parallel workers.
- Run `bin/rails test:system` with a browser (see Trix below).
- Check scheduled `NoteReminderJob` entries in the live Sidekiq scheduled set after deploy.

## Version/check matrix (stages: resolve, prepare, boot, eager, routes, tests)

- current (7.0.8.7): all pass; 46 runs, 325 assertions.
- r7010 (7.0.10, unrepaired): all pass except 1 test failure (F3).
- r716, r724, r8051, r810 (unrepaired): resolve passes; every later stage fails with F1.
- r716a (only F1 fixed): F2 errors plus the F3 failure.
- r724a: eager fails (F5); tests also hit F6.
- r8051a: eager fails (F6).
- r810a: eager fails (F6); routes fail (F15).
- r8051f: F16 errors.
- r810f: json 3 errors (40).
- r8051g / r810g: F17 (and F18 on 8.1).
- r716h, r724h, r8051h, r810h (all repairs): all stages pass; 46 runs, 340 assertions.
- curprep (prep-safe set on 7.0.8.7): green.
- curfix2 (full repair set on 7.0.8.7): 23 failures, which is why F5, F12 and F14 wait for 7.1.

Lockfiles: `/tmp/tmp.zhdcNKoFO7/lab/variants/<name>/Gemfile.lock`.

## Dependency movements (current → 8.1.0, json pinned)

- **Added:** `action_text-trix` 2.1.19 (37signals, rubygems), `json` 2.21.2 (3.1.0 if unpinned), and stdlib extractions: bigdecimal 4.1.3, drb, securerandom, uri, rack-session 1.0.2, rackup 1.0.1, webrick, useragent. Up to 8.0 also mutex_m, benchmark and cgi.
- **Moved:** net-imap 0.6.7 → 0.6.8. The app has no IMAP or Action Mailbox use.
- **Removed:** method_source.
- **Unchanged:** rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, pg 1.6.0, puma 5.6.9, pagy 8.6.3, sprockets-rails 3.5.2.
- No Git or path sources.

## Remaining unknowns and coverage limits

- **F19, Trix:** the layout loads the vendored Trix 1.3.5 (its comment is tied to Action Text 7.0.8.7). Action Text moves to Trix 2.x (C140 and later; the `action_text-trix` gem in 8.1). Browser editing and attachments were not executed. A system test is proposed.
- **`review.tsv`:** 105 findings or default rows, 695 not-applicable, 819 unknown. 315 of the not-applicable rows rest on keyword rules over entry titles. Each one names the code or config reason and is marked "[title-level rule; entry text not traced line by line]". The 819 unknown rows were reviewed by title only. Duplicates are grouped under F-numbers.
- **History:** 13,954 commits, far over the 80-commit limit. Only `commit-index.md` was read; no candidate patches or `guides.diff` were reviewed.
- **Lab differences:** parallel tests, production config and system tests were not exercised.

Every executed claim above has a run log and a resolved lockfile in the lab.

Files are in `/tmp/tmp.zhdcNKoFO7`:
- `summary.md`
- `changes/review.tsv`
- `changes/defaults.json`
- `changes-r810h/dependencies.json`
- `repairs/files/`: the full repair set
- `repairs/prep/`: the prep-safe set
- `probes/`: p01–p12
- `payloads/`
- `lab/runs/`
- `lab/isolation.json`

---

**Next step:** going straight to 8.1.0 won't work. The app fails to boot from 7.1 on, and 8.1.0 also needs `json` pinned to `~> 2.7`. I suggest following the staged rollout above, starting with PR 1: the prep-safe code fixes, which still run on 7.0.8.7. If you want, I'll implement PR 1 on a branch, or every step through 8.1.0.