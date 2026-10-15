The planner finished. Its full plan is below, verbatim, followed by my notes on how it compares with the tree I actually changed.

## Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

No repository files were modified. The disposable workspace was created, tested, and removed by `cleanup`, and its logs were copied to `/tmp/rails-8.1-upgrade-evidence/`. Before the plan, four things need attention.

**Working-tree drift.** At the start, `git status` was clean. The checkout now has 22 modified or untracked entries. I did not make these edits, and they were changing while I worked. The files I checked match parts of this plan, but many I did not review. The differences are listed in the last part of this report.

**Setup baseline was invalid.** `upgrade-workspace setup` copied an already-8.1 `Gemfile` and lock into the `baseline` copy, so both copies ran 8.1.0 and failed the same way. I rebuilt `baseline` from `git show HEAD:` for the four changed files. Its probe then reported `rails=7.0.8.7`, `ar=7.0.8.7`, `rack=2.2.24`.

**`gem-changes` gave partial output.** All 65 Rails `.gem` archives failed with `"...is not an octal string"`. The commit list, `lib/` diff, and framework-defaults sections are therefore missing. I rebuilt the defaults list from the installed `railties-8.1.0` `load_defaults` blocks and read the other items from the changelog text. The rack claim ("moves to 3.2.7") does not hold for this lock: `rackup 1.0.1` requires `rack &lt; 3`, so the lock stays at `rack 2.2.24`.

**Environment workaround.** `mise` refused the copied `mise.toml`. I set `MISE_TRUSTED_CONFIG_PATHS` for the workspace path only and did not change the global trust store. I did not run `reset`, because it would have checked out HEAD over the `upgraded` copy.

### Test results

| Run | Result |
|---|---|
| Baseline 7.0.8.7, HEAD code | 46 runs, 325 assertions, 0 failures, 0 errors |
| Upgraded 8.1.0, boot fixes only | 46 runs, 19 assertions, 12 failures, 34 errors |
| Upgraded 8.1.0, all repairs, `load_defaults 8.1` | 46 runs, 340 assertions, 0 failures, 0 errors |
| Upgraded 8.1.0, all repairs, `load_defaults` 7.1, 7.2, 8.0 | Each 46 runs, 340 assertions, 0 failures |
| Baseline 7.0.8.7, version-neutral repairs | 46 runs, 325 assertions, 0 failures, 0 errors |

The 7.0 `load_defaults` case was not re-run after the last app edits. The final-state 8.1 results were only run with `load_defaults 8.1` and with the partial targets.

## 1. Required changes for the upgrade

Each entry gives the affected code, what breaks, when it applies, the repair, and the validation. **Pre-bump** means the repair also passes the 7.0.8.7 baseline suite.

**R1. Action Text allowlist is nil on boot (`/home/user/workspace/repo/config/initializers/action_text.rb:3`)**
- Breaks: `NoMethodError: undefined method '+' for nil`. Boot fails. Action Text 8.1 leaves `ActionText::ContentHelper.allowed_tags` nil until set (`actiontext-8.1.0/app/helpers/action_text/content_helper.rb:10`).
- Applies: on the gem bump.
- Repair (pre-bump: yes):
  ```ruby
  ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags +
    [ ActionText::Attachment.tag_name, "figure", "figcaption" ] + %w[ details summary ]
  ```
- Validation: the allowlists and sanitized output for a sample body are byte-identical on 7.0 and 8.1. Both copies use `Rails::HTML4::SafeListSanitizer`.

**R2. `serialize :tags, JSON` raises on 8.1 (`app/models/note.rb:12`)**
- Breaks: `ArgumentError: wrong number of arguments (given 2, expected 1)` at `activerecord-8.1.0/.../serialization.rb:193`, so `Note` cannot be defined.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `attribute :tags, :json`. On both versions it writes `["a","b"]`, reads it back, and reads `nil` as `nil`. The database default is `"[]"`.
- Do not ship `serialize :tags, coder: JSON` before the bump. On 7.0.8.7 that keyword is ignored and the column is YAML-encoded: `"---\n- a\n- b\n"` instead of `["a","b"]`. That is the form currently in the working tree.

**R3. `alias_attribute` on a non-attribute (`app/models/note.rb:14`)**
- Breaks: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute` (`activerecord-8.1.0/lib/active_record/attribute_methods.rb:91`). Every test that touches `Note` fails.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`.

**R4. Multi-path route removed (`config/routes.rb:18`)**
- Breaks: `ArgumentError: Wrong number of arguments (expect 1, got 2)`. Routes do not load, which causes `NameError` for `notes_path` and `digest_path` across the suite.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"` on separate lines.

**R5. `Rails.application.secrets` removed (`app/models/citation/provider.rb:13`)**
- Breaks: `NoMethodError: undefined method 'secrets'`. Railties 8.1 has no `secrets` method, though 7.0.8.7 defines it (`railties-7.0.8.7/lib/rails/application.rb:389`).
- Applies: on the gem bump.
- Repair (pre-bump: yes): `Rails.application.config_for(:secrets).citation_provider.to_h`. The output matches 7.0 exactly.
- The test at `test/controllers/citation_enrichments_controller_test.rb:45,117-122` mutates `secrets`. I rewrote it with a stub on `config_for`. The test-side rewrite is part of this repair.

**R6. `show_exceptions = false` in test (`config/environments/test.rb:31`)**
- Breaks: on 8.1, `show?` treats any value other than `:none` or `:rescuable` as true (`actionpack-8.1.0/.../exception_wrapper.rb:188-198`). Cross-reader tests then receive a rendered error page instead of `RecordNotFound`: "RecordNotFound expected but nothing was raised".
- Applies: on the gem bump.
- Repair: `config.action_dispatch.show_exceptions = :none` on 8.1. On 7.0.8.7 this value breaks 23 tests, so it is **not** pre-bump safe. Switch the value in the same change as the bump.

**R7. `form_with(model: nil)` removed (`app/views/notes/index.html.erb:12`)**
- Breaks: `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. This breaks the notes list and every page that renders it, including sign-in redirects.
- Applies: on the gem bump (removed in 8.0).
- Repair (pre-bump: yes): drop `model: nil`.

**R8. `where(notebooks: @notebook)` produces the wrong column (`app/controllers/notes_controller.rb:12`)**
- Breaks: 8.1 compiles it to `"notes"."notebooks" = 7`, which raises `PG::UndefinedColumn: column notes.notebooks does not exist`. On 7.0 the SQL is `"notes"."notebook_id" = 7`.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `where(notebook: @notebook)`.

**R9. `Array#sum` on strings (`app/models/export.rb:42`)**
- Breaks: `TypeError: String can't be coerced into Integer`. Active Support 8.1 no longer overrides `Enumerable#sum` (7.1 removal). Every export job fails in `Export#generate`. On 7.0 the same call returns `"# x\nbody"` with a deprecation warning. The gem-changes output did not flag this line.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `finish(fragments.join)`.

**R10. Integer `wait_until` (`app/models/note.rb:62`)**
- Breaks: `NoMethodError: undefined method 'utc' for an instance of Integer`. ActiveJob 8.1 calls `scheduled_at.utc.iso8601(9)` (`activejob-8.1.0/.../core.rb:130`). 7.0 accepts an Integer.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `NoteReminderJob.set(wait_until: Time.at(reminder_epoch))`. Probe on 8.1: the `Time` form enqueues and the Integer form raises.

**R11. `stringify_keys` drops integer lookups (`app/views/imports/preview.html.erb:22`)**
- Breaks: `annotations[2]` returns `"Second reading"` on 7.0 but `nil` on 8.1 after `stringify_keys`. The annotation text silently disappears from the import preview. Tests on lines 22 and 62 fail.
- Applies: on the gem bump (8.0 HashWithIndifferentAccess change).
- Repair (pre-bump: yes): `&lt;% annotations = @import.annotations %&gt;`.

**R12. Commit on non-local return (`app/models/import.rb:53-58`)**
- Breaks: a `return false` inside `transaction` now commits. Probe: a `User` row created before the `return` survives with `rows_after=1` on 8.1 and `rows_after=0` on 7.0. The "applying them saves nothing" test fails with `record_counts changed`. This is a data-integrity regression.
- Applies: on the gem bump (7.1 change, in force on 8.1).
- Repair (pre-bump: yes):
  ```ruby
  transaction do
    save!
    rows.each { |row| raise ActiveRecord::Rollback unless row.note.save }
    true
  end || false
  ```

**R13. `citation[:id]` returns nil on a non-`id` primary key (`app/models/import.rb:68`)**
- Breaks: the receipt CSV has a blank DOI on 8.1 (`"On idleness,"`) and `"10.1000/Essays.1"` on 7.0.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `citation&amp;.doi`.

**R14. `to_time` arithmetic changes the postponed reminder time (`app/models/note.rb:45`)**
- Breaks: the reminder postponed by a day becomes `2026-11-01T08:00:00-05:00` on 8.1 and `2026-11-01T09:00:00-04:00` on 7.0. The app test pins the 7.0 value.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`. This keeps the 7.0 value.
- Note: the method comment says "twenty-four elapsed hours", but 7.0 yields 25 elapsed hours across DST, so the comment and behavior disagree. Choosing between them is a product decision.

**R15. ActiveJob `TimeWithZone` argument changes the digest day (`app/mailers/digest_mailer.rb:7`)**
- 7.0 serializes `"2026-10-04T23:30:00.000000000-04:00"` and deserializes it in UTC (`to_date` October 5). 8.1 adds `"time_zone"=&gt;"America/New_York"` and deserializes in the reader's zone (`to_date` October 4).
- Breaks: the subject becomes "October 04" instead of "October 05" (test at `digests_controller_test.rb:33`).
- Applies: on the gem bump.
- Repair (pre-bump: yes): `requested_at = requested_at.in_time_zone("UTC")`.

**R16. `:exponentially_longer` removed (`app/jobs/citation_enrichment_job.rb:7`)**
- Breaks: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. 8.1 has `:polynomially_longer` (`activejob-8.1.0/.../exceptions.rb:175`), but 7.0.8.7 lacks it, so no symbol works on both.
- Applies: on the gem bump.
- Repair (pre-bump: yes): `wait: -&gt;(executions) { executions**4 + 2 }`. The 7.0 and 8.1 formulas are identical when `retry_jitter` is at its default of 0.0.

**R17. `json` 3.x breaks ActiveSupport 8.1 decoding (`Gemfile`)**
- Breaks: `ActiveSupport::JSON.decode` calls `::JSON.parse(json, options)` with a positional hash (`activesupport-8.1.0/.../decoding.rb:25`). json 3.1.0 raises `ArgumentError (given 2, expected 1)`. This breaks every JSON `serialize` read and the `tags` path.
- Applies: on the gem bump. The fix is `gem "json", "~&gt; 2.7"`, which locked to json 2.21.2 locally.
- Pre-bump: not tested. 7.0 already uses json 2.7.2, so the pin should be neutral, but it was not run on the baseline.

**R18. Bare `serialize :preferences` fails under `load_defaults` 7.1 or later (`app/models/notebook.rb:7`)**
- Breaks: `ArgumentError: missing keyword: :coder` at eager load. The 7.1 defaults set `default_column_serializer = nil`.
- Applies: when adopting `load_defaults 7.1` or later, including the 8.1 gem bump.
- Repair (pre-bump: yes): `serialize :preferences, coder: YAML`. The bytes match 7.0 (`"---\na: 1\n"` in both), and the baseline suite passes.

**R19. `Date.iso8601` gets a `Date` object (`app/models/notebook.rb:40`)**
- Breaks: `TypeError: no implicit conversion of Date into String`. The 7.2 defaults set `postgresql_adapter_decode_dates = true`.
- Applies: when adopting `load_defaults 7.2` or later.
- Repair (pre-bump: yes): `Date.iso8601(day.to_s)`.

**R20. `slug` is permitted and raises on assignment (`app/controllers/notebooks_controller.rb:40`)**
- Breaks: `ActiveRecord::ReadonlyAttributeError: slug` on update. The 7.1 defaults set `raise_on_assign_to_attr_readonly = true`.
- Applies: when adopting `load_defaults 7.1` or later.
- Repair (pre-bump: yes): `permit(:name, :export_heading)`. The hidden field stays in the form, and create still derives the slug from the name.

**R21. Negative cache expiration (`app/views/exports/_export.html.erb:26`)**
- Breaks: `Cache expiration time is invalid, cannot be negative: -60.0`. The 7.1 defaults set `raise_on_invalid_cache_expiration_time = true`.
- Applies: when adopting `load_defaults 7.1` or later.
- Repair (pre-bump: yes): `expires_in: [export.expires_at - Time.current, 0].max`.

**R22. Built-in Sidekiq adapter is deprecated (`config/application.rb:24`)**
- Breaks: nothing in the test suite, because `test.rb` sets the adapter to `:test`. Development and production would emit the 8.1 deprecation.
- Applies: on the gem bump. Removing the warning requires the `sidekiq` gem adapter, which needs sidekiq ≥ 7.3.3. The app pins `sidekiq 6.5.12` and `redis 4.8.1`, and `notebook.rb:28` rescues `Redis::BaseError`. Sidekiq 7 uses `redis-client`, so this is a separate upgrade.

**Gem constraints**
- All Rails components move to 8.1.0 together. `action_text-trix 2.1.19` is added automatically. The layout still loads the vendored `trix-1.3.5.js` (`app/views/layouts/application.html.erb:13`), and the importmap never loads `action_text-trix`, so the two do not double-load. Not verified in a browser.
- `rack` stays at 2.2.24, held by `rackup 1.0.1` and `rack-session 1.0.2`. Rack 3 items apply only if the lock is re-resolved.
- The `minitest ~&gt; 5.25` comment in the Gemfile and TESTING.md refers to Rails 7.0 and is stale.

## 2. New configuration defaults across intermediate releases

The app uses `config.load_defaults 7.0` (`config/application.rb`). Nothing in `config/` overrides the defaults below, except `show_exceptions` in the test environment. Values come from `railties-8.1.0/lib/rails/application/configuration.rb`.

| Release | Default | Effect in this app | Later change | Configure |
|---|---|---|---|---|
| 7.1 | `active_record.default_column_serializer = nil` | Breaks `Notebook.preferences` (R18) | none | `coder: YAML` now |
| 7.1 | `raise_on_assign_to_attr_readonly = true` | Breaks slug update (R20) | none | Permit only writable params |
| 7.1 | `raise_on_invalid_cache_expiration_time = true` | Breaks export fragment (R21) | none | Clamp expiry now |
| 7.1 | `run_commit_callbacks_on_first_saved_instances_in_transaction = false` | No app `after_commit` callbacks found | none | Keep default |
| 7.1 | `belongs_to_required_validates_foreign_key = false` | Affects required-belongs_to checks; tests pass | none | Keep default |
| 7.1 | `before_committed_on_all_records = true` | No `before_commit` callbacks found | none | Keep default |
| 7.1 | `generate_secure_token_on = :initialize` | `has_secure_token` not used | none | None |
| 7.1 | `marshalling_format_version = 7.1`; `encryption.hash_digest_class = SHA256` | Encryption not used | none | None |
| 7.1 | `run_after_transaction_callbacks_in_order_defined = true` | Callback ordering only | none | Keep default |
| 7.1 | `query_log_tags_format = :sqlcommenter` | Log text only | none | Keep default |
| 7.1 | `cache_format_version = 7.1` | Cache entry format (see Section 3) | none | Keep 7.0 until tested |
| 7.1 | `message_serializer = :json_allow_marshal`; `use_message_serializer_for_metadata = true` | Message and cookie format (see Section 3) | none | Keep 7.0 until tested |
| 7.1 | `sanitizer_vendor = best_supported_vendor` (HTML5 when available) | Rich text sanitizer vendor; output was not compared on 8.1 defaults | none | Compare sanitized output before adopting |
| 7.1 | `add_autoload_paths_to_load_path = false` | `lib/` and autoload paths not required by the app | none | Keep default |
| 7.1 | `dom_testing_default_html_version = :html5` | Test parsing; suite green with it | none | Keep default |
| 7.1 | `action_dispatch.default_headers` (drops `X-Download-Options`); `debug_exception_log_level = :error` | Headers and logs only | none | Keep default |
| 7.2 | `yjit = true` | Enables YJIT | none | Measure before adopting |
| 7.2 | `postgresql_adapter_decode_dates = true` | Dates decode as `Date` (R19) | none | `to_s` now |
| 7.2 | `validate_migration_timestamps = true` | Migration timestamps are validated | none | Keep default |
| 8.0 | `action_dispatch.strict_freshness = true` | `export_downloads_controller.rb:11` `stale?` needs both ETag and Last-Modified to match | none | Keep default |
| 8.0 | `Regexp.timeout = 1` | `Citation` DOI regex is well within 1 s | none | Keep default |
| 8.1 | `yjit = !Rails.env.local?` | Enables YJIT in production | none | Measure before adopting |
| 8.1 | `action_controller.escape_json_responses = false` | No `render json:` in the app | none | Keep default |
| 8.1 | `action_on_path_relative_redirect = :raise` | All `redirect_to` calls use path helpers | none | Keep default |
| 8.1 | `raise_on_missing_required_finder_order_columns = true` | Every table has a primary key | none | Keep default |
| 8.1 | `escape_js_separators_in_json = false` | Not exercised | none | Keep default |
| 8.1 | `action_view.render_tracker = :ruby` | Performance only | none | Keep default |
| 8.1 | `remove_hidden_field_autocomplete = true` | `form_tag`-style hidden fields lose `autocomplete="off"` | none | Keep default |

Deprecated or removed settings that touch this app:
- `config.action_dispatch.show_exceptions = true/false`: deprecated in 7.1, and `false` behaves like `:all` on 8.1 (R6).
- `Rails.application.secrets`: deprecated in 7.1, removed in 8.1 (R5).
- `alias_attribute` on a non-attribute: deprecated in 7.1, an error in 8.0 and later (R3).
- `read_attribute(:id)` on a non-`id` primary key: deprecated in 7.1 (R13).

**Load-defaults results.** I ran the upgraded copy with `--defaults 7.1`, `7.2`, `8.0`, and `8.1`, with all repairs in place. All four passed. Before the R18 to R21 repairs, `8.1` defaults failed with 46 errors at eager load.

**Advisable path.** Repairs R1 to R16 and R18 to R21 can be applied and shipped on 7.0.8.7 first. Then bump and adopt `load_defaults` stepwise (7.1, 7.2, 8.0, 8.1) with the suite run at each step. I did not run the bumped gem at 7.1, 7.2, or 8.0, so the deprecation output at those intermediate releases is unverified.

## 3. Rollout, rollback, and mixed-version risks

- **Database records.** `notes.tags` stays JSON text under R2's `attribute :tags, :json`, verified on both versions. `notebooks.preferences` stays YAML under R18, verified. The `coder: JSON` form would silently write YAML on 7.0 (see R2), so it must not be deployed before the bump.
- **`db/schema.rb`.** Not dumped or compared in this run. The 8.1 upgrade guide says columns are now sorted alphabetically, so expect a noisy diff and a changed `ActiveRecord::Schema[...]` version on the next dump. Unverified.
- **Redis.** Sidekiq and the digest reservation keys (`digest_requests:&lt;date&gt;`) use the same gems and key format on both versions. Neither version changes the Redis payload format for these keys. Not run.
- **Cookies and signed or encrypted values.** The 7.1 defaults change `message_serializer` and `cache_format_version`. The session cookie can therefore decode differently across mixed processes. Not run. Keep the 7.0 values explicit until a cross-version decode test has passed. Dev and test secrets move from `tmp/development_secret.txt` to `tmp/local_secret.txt`; production uses credentials and is unaffected.
- **Cache entries.** `cache_format_version` 7.0 to 7.1 changes entry bytes. Production uses the default file store, and `exports/_export.html.erb` uses fragment caching. Mixed-version reads of fragments written by the other version are unverified.
- **Active Job payloads.** Verified on the 8.1 side only: 8.1 writes `time_zone` for `TimeWithZone` (R15), and writes `scheduled_at` as an ISO 8601 string (`core.rb:130`). Whether 7.0 workers read 8.1 payloads, and the reverse, was not run. Digest and reminder jobs queued during rollout are the exposed cases. The safe approach is to drain queues before the bump, or keep producers on 7.0 until queues empty.
- **Rollback.** Reverting to 7.0 after rows were written by 8.1 leaves JSON and YAML values in the same columns, as described above. Make sure the R2 change is already in place on 7.0 before any 8.1 processes write.

## 4. Verification log and open questions

**Executed in the workspace**
- `ruby .../gem-changes rails 7.0.8.7 8.1.0`: produced changelog, upgrade-guide, and removal sections. The defaults, commit, and `lib/` sections were missing because of the archive error above.
- `upgrade-workspace setup rails 7.0.8.7 8.1.0`: created copies and logs. Baseline was invalid until rebuilt from HEAD.
- `bundle check`: "The Gemfile's dependencies are satisfied" for both copies.
- Probes (side by side on baseline and upgraded). Logs saved to `/tmp/rails-8.1-upgrade-evidence/probe_*.txt`: version, `secrets` vs `config_for`, `TimeWithZone` round trip, JSON decoding, `Array#sum`, `HashWithIndifferentAccess#stringify_keys`, `where(notebooks:)`, reminder `wait_until`, `attribute :json` vs `serialize`, serialization of `tags` and `preferences`, return inside a transaction, Action Text allowlists.
- Test runs via `upgrade-workspace test`: outputs saved to `/tmp/rails-8.1-upgrade-evidence/test_*.txt`. Logs at `/tmp/rails-8.1-upgrade-evidence/workspace-logs/`.
- Resolved gem versions in the upgraded lock: rails, actionpack, activerecord, and the rest of the Rails family at 8.1.0; `json 2.21.2` (after the pin); `rack 2.2.24`; `rackup 1.0.1`; `rack-session 1.0.2`; `action_text-trix 2.1.19`; `sidekiq 6.5.12`; `redis 4.8.1`. Baseline: rails 7.0.8.7 with `json 2.7.2`.
- `cleanup rails 8.1.0`: workspace removed, PostgreSQL and Redis databases dropped. The `cleanup` output printed a `git status` check, which now lists the working-tree changes described below.

**Source reading only**
- The `load_defaults` blocks, `show?` handling, `serialize` signature, and the `secrets`, `Enumerable#sum`, and `attr_readonly` behavior were read from installed gem source. The behavior was then confirmed by a probe or test for each item marked above.

**Not run**
- `bin/rails zeitwerk:check`. The workspace eager-load check passed on both copies, which covers `app/`, `config/`, and `lib/` but is not the same command.
- `bin/rails test:system`. Chrome and Selenium were not checked.
- Production boot.
- `db:schema:dump` comparison.
- Cross-version cookie, cache, and Active Job payload decoding in both directions (only the 8.1 output side was run).
- The `json` pin on the 7.0 baseline.
- Sanitized output under `load_defaults 8.1` (HTML5 vendor). The rich-text test passed, but output was not compared.
- Browser behavior of Trix and Turbo.
- Intermediate gem versions (7.1, 7.2, 8.0) with deprecation scanning.

**Open questions**
- Reminder postponement: keep the 7.0 offset-preserving value (R14) or accept the 24-elapsed-hour result on 8.1?
- Digest day: UTC (as the mailer comment states, and R15 implements) or the reader's local day?
- Sidekiq: upgrade to the gem's adapter (7.3.3 or later) as a separate change?
- Rack: re-resolve the lock to rack 3? Is that needed?

**Differences from the working tree**

These are the items I could confirm against the working tree when I last looked (the lock and `note.rb` snapshot shortly after setup, and the `git status` at cleanup).

- `app/models/note.rb:12`: the working tree uses `serialize :tags, coder: JSON`. Pre-bump, use `attribute :tags, :json` (R2). The `coder:` form is only correct after 8.1.
- `Gemfile`: the `json ~&gt; 2.7` pin matches R17.
- `Gemfile.lock`: the json entry was not re-checked.
- `config/initializers/action_text.rb`: matches R1.
- `config/routes.rb`: the two-line split matches R4.
- `app/models/notebook.rb`, `app/controllers/notebooks_controller.rb`, and `app/views/exports/_export.html.erb` are **not** modified in the working tree. Repairs R18 to R21 are missing.
- `config/environments/test.rb`, `app/models/citation/provider.rb`, `test/controllers/citation_enrichments_controller_test.rb`, `app/models/import.rb`, `app/models/export.rb`, `app/mailers/digest_mailer.rb`, `app/jobs/citation_enrichment_job.rb`, `app/controllers/notes_controller.rb`, `app/views/notes/index.html.erb`, and `app/views/imports/preview.html.erb` are modified, but I did not review their contents against R5 to R16.
- `config/secrets.yml` is modified and `config/initializers/secrets.rb` is new. I did not review them. They may reintroduce `secrets`-based behavior.
- `app/jobs/digest_job.rb`, `app/views/layouts/application.html.erb`, `ARCHITECTURE.md`, `README.md`, and `docs/references/fizzy.md` are modified and were not reviewed.

No test has been run on the working tree itself. Its state should be checked against this plan before it is treated as the upgrade.

---

## My notes on the plan

The planner's "working-tree drift" was my own edits. It ran alongside my work, so it saw my changes as external. The plan therefore describes a state that differs from what I did in the repo.

**Verified against my working tree**
- Rails is 8.1.0, `load_defaults` stays at 7.0, and the whole suite passes: 46 runs, 340 assertions, 0 failures, 0 errors. That run was after my last app edit.
- `zeitwerk:check` passes. A production-env eager load also boots.
- `bin/rails test:system` runs 0 tests because the app has no system tests. Browser behavior is unverified.

**Where my tree differs from the plan's repairs**
- **R2 (tags):** I used `serialize :tags, coder: JSON`, which is correct on 8.1 only. The plan's `attribute :tags, :json` is the pre-bump-safe option. I have not tested it. Since the bump ships in one change, the current form is fine as long as nothing runs on 7.0 against this data.
- **R14 (reminder):** The plan says 7.0 gives 25 elapsed hours across DST. My test asserts `2026-11-01T09:00:00-04:00`, which is 13:00 UTC on Nov 1, exactly 24 elapsed hours after the reminder. That test passes on my tree, so I disagree with that claim. The open question is still whether the comment or the behavior should win.
- **R15 (digest):** `requested_at.utc` in my mailer is the same as the plan's `in_time_zone("UTC")`. I did not change the UTC-day behavior.
- **R16 (retry):** I used `:polynomially_longer`, which is 8.1-only. That is fine on this change. The plan's lambda is only needed if the retry must run on 7.0 too.
- **R18 to R21:** These only apply once `load_defaults` moves to 7.1 or later. They are not needed while the app stays on 7.0 defaults. They should be fixed before stepping defaults forward.
- **R22 (Sidekiq):** The adapter deprecation is new to me and is not in my tree. It would show in development and production logs. Removing it means moving to the sidekiq gem's adapter, which is a separate upgrade.

**Open items**
- Whether the reminder should use 24 elapsed hours or the 7.0 wall-clock value.
- Whether to keep the Minitest 5 pin. The Gemfile and `TESTING.md` comments refer to Rails 7.0, so they are stale.
- Trix: the stylesheet is now Trix 2 while the layout runs Trix 1.3.5. This needs a browser check.

I have not committed anything.