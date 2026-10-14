# Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

The upgrade to 8.1.0 needs 18 code and Gemfile changes. With all of them applied, an isolated copy on 8.1.0 boots and passes all 46 non-system tests. Without them, the app won't boot on any version from 7.1 onward. Nothing was changed in `/home/user/workspace/repo`: the source hashes were checked at clean-up, and only the lab's own databases were dropped. The full plan, including where each piece of evidence is, is at `/tmp/gem-upgrade-20261014-71622-p9loa3/plan.json`; the rendered version is at `plan-rendered.txt` in the same folder.

Ruby 3.3.6 is new enough for every release up to 8.1.0 (8.x needs Ruby 3.2 or later). The app uses PostgreSQL, Sidekiq 6.5.12 and Redis 4.8.1. Even the 7.0.10 patch release changes the digest mailer's date (F15).

**What the tests showed:**
- With the fixes, the 8.1.0 copy boots, loads all code, prepares the database, draws routes and passes 46 runs (340 assertions). It keeps the 7.0 framework defaults.
- The same code on 7.0.8.7 also passes 46/46, except for two fixes that only work after the upgrade:
  - `serialize :tags, coder: JSON` (F3)
  - `show_exceptions = :none` (F6)
- Every other fix can be deployed on 7.0.8.7 first, along with the DigestJob argument change (F19).

**Recommended order:**
1. Deploy the fixes that work on the current version, plus the json pin, while still on 7.0.8.7.
2. Deploy the version bump together with F3, F6 and the new lockfile, keeping `load_defaults 7.0`.
   - Web and Sidekiq servers can run mixed versions during the rollout. Saved job arguments, time-zone values, tag JSON and notebook preference YAML were each read successfully in both directions between versions.
3. Adopt the new framework defaults later, one version at a time, after fixes D1–D4.

**Rollback:** revert the bump commit, including F3, F6 and the lockfile. The step-1 code stays valid on 7.0.8.7.

**Not established:**
- The browser (system) tests were never run (F22).
- The production environment was never booted with real credentials and `REDIS_URL`.
- Moving to Sidekiq 7.3.3+ is needed before Rails 8.2 (F20).

Passing the existing tests doesn't prove the upgrade is safe; each finding cites the specific run behind it.

## Required changes

Run records are under `/tmp/gem-upgrade-20261014-71622-p9loa3/runs/`.

Variant names in the evidence column:
- **baseline**: the unchanged app on 7.0.8.7.
- **v8_1_0**: the unchanged app bumped to 8.1.0.
- **t1–t9**: copies on 8.1.0 that add one fix at a time; t9 has all the fixes.
- **base_fix4 / base_fix5**: copies on 7.0.8.7 with the fixes, used to check which ones can ship before the bump.
- **d71b / d72b / d81c**: copies on 8.1.0 with newer `load_defaults` settings.

| ID | Where in the app | What happens on 8.1.0 without the fix | Fix | Safe to ship on 7.0.8.7 first? | Evidence |
|---|---|---|---|---|---|
| **F1** | `config/initializers/action_text.rb:3` | App won't boot on 7.1.6, 7.2.4, 8.0.5.1 or 8.1.0: ``undefined method `+' for nil (NoMethodError)`` | In `config.after_initialize`, set `ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags.to_a + [ActionText::Attachment.tag_name, "figure", "figcaption", "details", "summary"]` | Yes. The allowed-tag list is identical on 7.0 and 8.1 (48 tags) | Failing boot: `v7_1_6/003-boot`, `v8_1_0/003-boot`. Passing: `t1/002-boot`, `t8/007-probe`, `baseline/007-probe`, `base_fix4/006-tests` |
| **F2** | `app/models/note.rb:10` (`enum status:` keyword form) | Note model fails to load: `ArgumentError (given 0, expected 1..2)` | `enum :status, { draft: 0, ready: 1 }, prefix: true` | Yes | `t1/004-eager`, `t9/006-tests`, `base_fix4/006-tests` |
| **F3** | `app/models/note.rb:12` (`serialize :tags, JSON`) | Note model fails to load: `ArgumentError (given 2, expected 1)` | `serialize :tags, coder: JSON` | **No.** On 7.0 tags come back as strings and 15 tests error. Ship with the bump. Stored tag bytes are identical in both versions and each reads the other's | `t2/004-eager`, `base_fix2/006-tests`, `t9/013-probe`, `baseline/019-probe` |
| **F4** | `config/routes.rb:18` (`get "/notes", "/journal"`) | Routes fail to load: `Wrong number of arguments (expect 1, got 2)` | Split into two `get` lines. Route names `notes` and `journal` are kept | Yes | `t3/005-routes`, `t4/005-routes` |
| **F5** | `citation/provider.rb:13`, `config/secrets.yml`, the citation test helper, `ARCHITECTURE.md:79-80`, `CONTRIBUTING.md:38`, `bin/citation-provider:15` | Every citation lookup fails: ``undefined method `secrets'`` | Move the settings to `config/citation_provider.yml`, load with `config.x.citation_provider = config_for(:citation_provider)`, read `Rails.configuration.x.citation_provider.to_h`, update the docs | Yes. The credentials test (`"00123"` / `"sample: value # keep"`) passes. Production uses the same `CITATION_PROVIDER_*` variables | `t4/006-tests`, `t9/006-tests`, `base_fix4/006-tests` |
| **F6** | `config/environments/test.rb:31` | Tests stop seeing exceptions: `Redis::CannotConnectError expected but nothing was raised`, and a 422 becomes a 500 | `show_exceptions = :none` | **No.** On 7.0 it causes 23 test failures. Ship with the bump | `t4/006-tests`, `base_fix/009-tests` |
| **F7** | `note.rb:14` (`alias_attribute :highlight_color, :color`) | ``ArgumentError: Note model aliases `color`, but `color` is not an attribute`` | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes | `t4/006-tests`, `t9/006-tests` |
| **F8** | `export.rb:42` (`fragments.sum`) | Exports never finish: `TypeError: String can't be coerced into Integer` | `fragments.join` | Yes | `t5/006-tests`, `t9/006-tests` |
| **F9** | Gemfile has no json entry (today the app uses Ruby's built-in json 2.7.2) | Bundler picks json 3.1.0 (released 2026-10-13), which Rails 8.1.0 can't call. Every JSON column read fails with `ArgumentError (given 2, expected 1)`; 40 test errors | Add `gem "json", "~> 2.7"` (resolves to 2.21.2) | Yes | `t5/006-tests`, `t6/008-tests`, `base_fix4/006-tests` |
| **F10** | `notes/index.html.erb:12` (`form_with(model: nil)`) | The notes list page crashes: `Passed nil to the :model argument` | Remove `model: nil` | Yes | `t6/008-tests`, `t9/006-tests` |
| **F11** | `notes_controller.rb:12` (`where(notebooks: @notebook)`) | Filtering by notebook crashes: `PG::UndefinedColumn notes.notebooks` | `where(notebook: @notebook)` | Yes | `t6/008-tests`, `t9/006-tests` |
| **F12** | `citation_enrichment_job.rb:7` (`wait: :exponentially_longer`) | Instead of retrying, the job crashes: `Couldn't determine a delay based on :exponentially_longer` | `wait: ->(executions) { executions**4 + 2 }`. This drops the old random jitter. `:polynomially_longer` doesn't exist on 7.0 | Yes | `t6/008-tests`, `t9/006-tests`, `base_fix4/006-tests` |
| **F13** | `note.rb:62` (`set(wait_until: reminder_epoch)`) | Reminders can't be scheduled: ``undefined method `utc' for an instance of Integer`` | `set(wait_until: Time.at(reminder_epoch))` | Yes. 7.0 can read an 8.1 reminder job | `t6/008-tests`, `t9/006-tests`, `baseline/010-probe` |
| **F14** | `imports/preview.html.erb:22` (`annotations.stringify_keys`) | The import preview silently drops every row's annotation | Use `@import.annotations` | Yes | `t6/008-tests`, `t9/006-tests` |
| **F15** | `digest_mailer.rb:7-9` | Digests use the reader's local day instead of the UTC day: subject says "October 04, 2026" where "October 05, 2026" is expected. Already happens on 7.0.10 | `requested_at = params[:requested_at].in_time_zone("UTC")` | Yes. 7.0 reads the 8.1 time value as 2026-10-05 03:30 UTC | `v7_0_10/007-tests`, `t8/010-probe` (fails without fix), `t8/009-probe`, `baseline/011-probe` |
| **F16** | `note.rb:44-45` (`next_day_reminder_at`) | The "24 hours later" preview changes across a daylight-saving change: `2026-11-01T09:00:00-04:00` is no longer shown | `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400` | Yes | `t7/006-tests`, `t9/006-tests` |
| **F17** | `import.rb:50-61` (`Import#apply`) | **Data integrity:** an invalid import is partly saved. Record counts change from [0,3,0,1] to [1,4,1,2] | `saved = transaction { save!; raise ActiveRecord::Rollback unless rows.all? { \|row\| row.note.save }; true }; saved == true` | Yes. Ship it first, so no partly saved imports need clean-up | `t7/006-tests`, `t9/006-tests` |
| **F18** | `import.rb:68` (`citation[:id]`; the citations table's key is `doi`) | The DOI column in the receipt CSV comes out blank | `citation&.doi` | Yes | `t7/006-tests`, `t9/006-tests` |

## Rollout risks

**F19. Digest jobs can't be read by old workers during a rolling deploy.**
- Where: `user.rb:41` passes a BigDecimal to `DigestJob`.
- On 8.1 this argument is saved in a new format. A 7.0 worker fails with `ActiveJob::DeserializationError: ... Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`.
- Fix: pass `reading_completion.to_s`. The saved value is then "0.5", the same as 7.0 produces. Deploy this before the bump.
- Evidence: `baseline/010-probe`, `t8/011-probe`, `t9/007-probe`, `base_fix4/007-probe`, `t9/015-probe`, `baseline/020-probe`.
- Not tested: a full worker actually sending the mail across versions.

**F20. Rails' built-in Sidekiq adapter is deprecated in 8.1 and removed in 8.2.**
- The warning was observed: "The built-in `sidekiq` adapter is deprecated and will be removed in Rails 8.2" (`t9/015-probe`).
- Production hides it because `report_deprecations = false`.
- Not a blocker for 8.1.0. Plan a separate Sidekiq 7.3.3+ upgrade before Rails 8.2. Sidekiq 6.5 keeps Rack below version 3 (Rack 2.2.24 resolved).

**F21. Stricter JSON parsing of citation provider responses.**
- json 2.17+ rejects invalid escapes. A body that json 2.7.2 accepted as "Middleqmarch" now produces "The provider's response was not valid JSON" (`t9/017-probe` vs `baseline/022-probe`).
- No fix needed; it's handled as a permanent provider error. Watch the count of failed enrichments after deploy.
- The URL parser library (uri) also changed (0.13.1 to 1.1.2). Eight sample URLs gave the same accept/reject result before and after (`baseline/021-probe`, `t9/016-probe`).

**F22. Rich-text editor in the browser: not verified.**
- Action Text 8.1 now brings in Trix 2.1.19 through a new gem, `action_text-trix`. The app still loads its own copy of Trix 1.3.5 as a script tag.
- The browser tests need a display and Chrome, which weren't available. Run `bin/rails test:system` on the upgraded copy.
- If the editor or file uploads fail, replace the app's Trix 1.3.5 with the gem's `trix.js` and `trix.css`.

## Fixes needed before adopting newer framework defaults

All four were run on copies using newer `load_defaults`.

| ID | Default that triggers it | What breaks | Fix | Evidence |
|---|---|---|---|---|
| **D1** | 7.1: `default_column_serializer = nil` | `serialize :preferences` fails to load: `missing keyword: :coder` | `serialize :preferences, coder: YAML`. Stored YAML is byte-identical across versions (9/9 checks passed). Only apply with or after the bump; not verified on 7.0 | `d71/004-eager`, `d71b/008-probe`, `t9/009-probe` |
| **D2** | 7.1: `raise_on_assign_to_attr_readonly` | Saving notebook settings returns a 500 (`ReadonlyAttributeError: slug`) | Allow `:slug` only on create | `d71b/006-tests`, `d81c/006-tests`, `base_fix5/006-tests` |
| **D3** | 7.2: `postgresql_adapter_decode_dates` | Activity report crashes: `TypeError: no implicit conversion of Date into String` | `Date.iso8601(day.to_s)` | `d72b/006-tests`, `d81c/006-tests`, `base_fix5/006-tests` |
| **D4** | 7.1: `raise_on_invalid_cache_expiration_time` | Exports page errors once an export expires (`cannot be negative: -60.0`). With the current default it only logs the error | `expires_in: [export.expires_at - Time.current, 0].max` | `d71b/006-tests`, `d81c/006-tests` |

With all four fixes applied and `load_defaults 8.1`, the copy passes 46/46 (`d81c`). D2–D4 also pass on 7.0.8.7 (`base_fix5`).

## Framework default decisions (all 36 settings are recorded in plan.json)

- **Keep as is:**
  - `enqueue_after_transaction_commit` stays false (measured on 8.1). The app queues jobs inside a row lock so a failed enqueue rolls back.
  - `to_time_preserves_timezone`: don't set it; the option is deprecated. Handled by F16.
- **Adopt only after the bump is fully deployed, in its own deploy** (old servers can't read the new format during a rolling deploy):
  - `message_serializer`
  - `use_message_serializer_for_metadata`
  - `cache_format_version 7.1`
  - `marshalling_format_version`
- **Adopt after the D fixes:** `default_column_serializer` (D1), `raise_on_assign_to_attr_readonly` (D2), `postgresql_adapter_decode_dates` (D3), `raise_on_invalid_cache_expiration_time` (D4).
- **Already handled by required fixes:** `use_big_decimal_serializer` (F19), the singular association name setting (F11), `commit_transaction_on_non_local_return` (F17).
- **Not applicable:** the encryption settings and the SQLite strict-strings setting.
- **Everything else:** adopt later or any time. That includes `strict_freshness` (download tests passed), both `sanitizer_vendor` settings (the rich-text test passed) and `yjit` (an operations decision about memory).

## Source coverage

- 96 source pages reviewed, 67 not applicable, 25 unknown.
- All removal and deprecation changelog entries were read. Behavior-change entries were searched by the app's identifiers rather than opened one by one.

## Limits and unresolved checks

**Gaps in what could be collected:**
- The 7.0.8.7 release tag isn't an ancestor of the 8.1.0 tag in the Rails repository. The same applies to uri.
- Release notes for net-imap, securerandom and uri couldn't be fetched (HTTP 403).
- Rails 8.1's framework defaults had no collected source page. I read them from railties-8.1.0 `configuration.rb` and only exercised them through the d81 copies.

**Marked unknown:**
- Commit-level changes in the 12 Rails component libraries were only searched by identifier.
- The 7.1–8.1 release notes weren't read in full.
- Commits for bigdecimal, json and uri were not read individually.

**Checks not run:**
- Browser/system tests.
- Booting the production environment (credentials, master key, real `REDIS_URL`, a Sidekiq server process, the file store).
- Full Sidekiq worker execution across versions.
- The dependency changes in the 7.1.6, 7.2.4 and 8.0.5.1 lockfiles (only baseline to repaired 8.1.0 was researched).
- Whether a later Rails patch release fixes the json 3 problem.

**Process note:** in the lab copies t5–t8 I edited their git index with `git mv`, then restored it to its state at the time each copy was made. The diff record for t5 may still show the rename. The original repo was not touched.

## Files

All in `/tmp/gem-upgrade-20261014-71622-p9loa3/`:
- `plan.json`
- `plan-rendered.txt` (the full rendered plan, including the experiment list)
- `repair-target.patch` (the complete fix diff on 8.1.0)
- `repair-code.patch`
- `probes/` (probe scripts and saved job/data payloads)
- `sources/index.md`
- `dependencies-target/index.md`
- `variants/` (app copies: `baseline`, `v*`, `t1`–`t9`, `base_fix*`, `d71`–`d81c`)
- `runs/` (records and logs for every run)

---

This is only a plan. Rails is still on 7.0.8.7 in `Gemfile.lock` and nothing in your repo has changed.

The most important point: you can't just change the version number. On every version from 7.1 up, the app won't boot until F1 is fixed. On 8.1.0 it also needs the json pin (F9), because json 3.1.0 came out yesterday and Rails 8.1.0 can't work with it. Then it needs the other fixes in the table.

If you want, I can apply step 1 next: all the fixes that also work on 7.0.8.7, plus the json pin. It would go on a new branch, and I'd run the test suite before doing the version bump.