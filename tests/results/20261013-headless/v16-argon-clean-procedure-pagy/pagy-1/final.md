# Upgrade plan: pagy 8.6.3 to 9.3.5 (Margin Notes)

As it stands, the bump to 9.3.5 stops the app from booting. Three small changes fix that: rename the `items` settings to `limit`, rename `@pagy.items` in the notes index, and handle page numbers of 1 or lower in `NotesController#index`. With those changes in the disposable workspace, the upgraded copy booted and the full suite passed (46 runs, 325 assertions, 0 failures, 0 errors). Pagy is the only gem whose version changes in `Gemfile.lock`. The workspace has been cleaned up and the working checkout is unchanged.

## 1. Required changes for the upgrade

### F1. The `items` extra and its settings were renamed to `limit` (9.0.0); the app does not boot
- **Affected code:** `/home/user/workspace/repo/config/initializers/pagy.rb`
  - line 2: `require "pagy/extras/items"`
  - lines 6–8: `Pagy::DEFAULT[:items]`, `[:items_param]`, `[:max_items]`
- **What breaks:** the app fails to boot and the test runner exits before running anything:
  `LoadError: cannot load such file -- pagy/extras/items (config/initializers/pagy.rb:2)`.
  If only the `require` were fixed, the old keys would be silently ignored in 9.x. Pages would still default to 10 notes, because pagy's own default is also 10. But `?per_page=` would stop being read, since the default parameter name becomes `limit`, and the cap of 50 would be lost.
- **Applicability:** takes effect as soon as the gem is bumped. The new names do not exist in 8.6.3, so this repair can only ship together with the bump. No stored data or queued jobs are involved.
- **Recommended repair:** replace the initializer with:
  ```ruby
  require "pagy/extras/limit"
  require "pagy/extras/overflow"
  Pagy::DEFAULT[:limit] = 10
  Pagy::DEFAULT[:limit_param] = :per_page
  Pagy::DEFAULT[:limit_max] = 50
  Pagy::DEFAULT[:overflow] = :last_page
  ```
  Keep `limit_param = :per_page` so existing bookmarked URLs and the form field keep working.
- **Validation (executed):**
  - Without the repair, boot fails with the error above.
  - With it, boot, eager load and all 67 routes are OK.
  - The probe returned the same results on 8.6.3 and on 9.3.5 with the new keys:

    | Request params | Result on both versions |
    |---|---|
    | `per_page=25` | limit 25 |
    | `page=9, per_page=50` | limit 50, page 2 (overflow sends it to the last page) |
    | `items=25` or `limit=25` | ignored, limit stays 10 |

  - Control: `notes_controller_test.rb` lines 54–60 (`per_page=5` is selected) and lines 87–95 (`per_page=500` is capped to 50, and the prev link query is `{"per_page"=>"50","page"=>"1"}`) pass.

### F2. The `@pagy.items` accessor was removed (9.0.0); the notes index would raise NoMethodError
- **Affected code:** `/home/user/workspace/repo/app/views/notes/index.html.erb:30`
- **What breaks:** `GET /notes` raises `NoMethodError` (`undefined method 'items'` on the `Pagy` object).
- **Applicability:** takes effect as soon as the gem is bumped. `Pagy#limit` does not exist in 8.6.3, so this ships with the bump.
- **Recommended repair:** `options_for_select([5, 10, 25, 50], @pagy.limit)`
- **Validation (executed):** with the repair, the test at `notes_controller_test.rb:60` passes: `select[name=per_page] option[selected]` is "5". Control: with no `per_page` parameter, the select still marks 10 as selected (`notes_controller_test.rb` index tests pass).

### F3. Page numbers below 1 now raise instead of falling back to page 1 (9.0.0 internal refactor; no changelog entry)
- **Affected code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:18`, `NotesController#index`: `@pagy, @notes = pagy(@notes)`
- **What breaks:**
  - In 8.6.3, `pagy_get_page` returned `[params[:page].to_i, 1].max`.
  - In 9.3.5 it returns `(page || 1).to_i`, so `page=0`, `-1`, `""` or `two` all produce 0.
  - That raises `Pagy::VariableError: expected :page >= 1; got 0`, which surfaces as a 500 error on stale or hand-edited URLs.
- **Validation of the failure (executed):** the suite fails in `test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` (test line 79). The probe showed `{"page"=>"0"}` returns page 1 on 8.6.3 and raises on 9.3.5.
- **Applicability:** takes effect as soon as the gem is bumped, for any request with a page value below 1 or a non-numeric page value.
- **Recommended repair:** `@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)`
  - Passing `page:` explicitly is supported in both 8.6.3 (`vars[:page] ||=`) and 9.3.5. I conclude from reading the source that it can ship before the bump; I did not run it on baseline.
  - I do not recommend overriding `pagy_get_page`, because its signature differs between versions (`(vars)` in 8.x versus `(vars, force_integer:)` in 9.x).
- **Validation (executed on upgraded):**
  - Failing check: the test at `notes_controller_test.rb:78–84` runs pages `""`, `"0"`, `"-1"` and `"two"`. Each must render 10 notes, with "Chapter 50" first and the range text "Displaying notes 1-10 of 52 in total". It errors without the repair and passes with it.
  - Control: `page=2, per_page=500` shows Montaigne then Middlemarch (51–52 of 52); `page=9, per_page=50` overflows to the last page. Both pass.

### F4. Checked and not affected
- **`pagy_info(item_name:)` (9.3.3 change):** the probe output was identical on both versions: "Displaying notes 51-52 of 52 in total" and "Displaying 1 note".
- **`pagy_url_for(@pagy, page)`:** unchanged; the prev and next link tests pass.
- **Areas the app does not use:**
  - JS files that were removed
  - the CSS extras foundation, materialize, semantic and uikit
  - array values for `:size`
  - `anchor_string` and `fragment`
  - keyset pagination
  - headers and jsonapi extras
  - overrides of `pagy_get_items` or other internals

  The textual matches in `citation_enrichments_controller_test.rb`, `citation_enrichment_job.rb`, `reminders_controller.rb` and `note.rb` were unrelated.

## 2. New configuration defaults across intermediate releases
Pagy has no `load_defaults` mechanism. The only change in this range that works like a new default is the URL parameter name `items` becoming `limit` in 9.0.0. The app overrides it explicitly with `limit_param = :per_page` (F1), so the app sees no change. No later release in the range deprecates the renamed keys. The `:after_latest` deprecation (9.2.0) and `:typecast_latest` removal (9.3.0) only apply to keyset pagination, which the app does not use.

## 3. Rollout, rollback, and mixed-version risks
- **Data and stored state:** none. Pagy does not touch the database, `db/schema.rb`, Redis, cookies or Active Job payloads.
- **Mixed versions:** URLs use `per_page` and `page` in both versions, so links generated by either version work on the other during rollout or rollback.
- **What can ship early:** F3 can ship on 8.6.3 now.
- **What must ship together:** F1 and F2 must ship in the same deploy as the bump. Rolling back means reverting all three changes together, although F3 is harmless to keep.

## 4. Verification log and open questions
**Executed in `upgrade-workspace`:**
- Commands run: `gem-changes pagy 8.6.3 9.3.5`, then `upgrade-workspace setup`, `test`, `probe` and `cleanup`.
- Lockfile: only `pagy 8.6.3 → 9.3.5` changed.
- Rails is 7.0.8.7 with `load_defaults 7.0`.
- Baseline (8.6.3): 46 runs, 325 assertions, all passing.
- Upgraded (9.3.5) with F1 and F2 only: 1 error (F3). With F1, F2 and F3: 46 runs, 325 assertions, 0 failures, 0 errors.
- Logs were under `/tmp/upgrade-pagy-9.3.5/logs` (`tests-baseline.log`, `tests-upgraded.log`, `diag-*.log`, `bundle-update.log`). They have been deleted by cleanup.

**Based on reading source:** that the F3 repair works on 8.6.3, and the F4 "not affected" items other than `pagy_info` and `pagy_url_for`.

**Not run yet:**
- The F3 repair on baseline.
- The browser system tests.

**Open questions:**
1. **Existing bug on both versions (decision needed):** `per_page=0`, `per_page=abc` or an empty `per_page` already raises on both versions (`Pagy::VariableError: expected :items >= 1; got 0` on 8.6.3, `:limit` on 9.3.5). The upgrade does not change this. I recommend fixing it separately by passing `limit: params[:per_page].to_i.clamp(1, 50)` when the parameter is present.
2. **Unreadable release archives:** the `gem-changes` script could not open the release archives (9.0.9, 9.1.1, 9.2.2, 9.3.5), so the `lib/` changes were checked against the installed 9.3.5 gem source and the CHANGELOG instead.

---

**Note:** I haven't applied the upgrade yet. The upgrade skill only plans it, so your checkout is unchanged and still on pagy 8.6.3.

Applying it means changing the Gemfile pin to `"9.3.5"`, running `bundle update pagy`, and making fixes F1–F3. Those passed the full test suite in the throwaway copy. The browser tests (`bin/rails test:system`) haven't been run yet, so I'd run them after applying. Want me to go ahead?