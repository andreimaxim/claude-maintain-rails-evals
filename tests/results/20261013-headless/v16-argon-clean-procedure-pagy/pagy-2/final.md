# Upgrade plan: pagy 8.6.3 to 9.3.5 (Margin Notes)

Upgrading as-is breaks the app: it won't boot. It needs two required changes plus one controller fix that you can ship now, before the bump. I tested all three in the workspace: the upgraded suite went from failing to start to 46 runs, 325 assertions, 0 failures, 0 errors. Nothing changes for stored data, cookies, cache or jobs. The workspace has been cleaned up and `git status` in `/home/user/workspace/repo` is clean.

## 1. Required changes for the upgrade

### R1. The `items` extra and settings were renamed to `limit` (boot failure)
- **Affected code:** `/home/user/workspace/repo/config/initializers/pagy.rb` lines 2 and 6–8.
- **What breaks:** the app does not boot. Every test and every request fails with `LoadError: cannot load such file -- pagy/extras/items (config/initializers/pagy.rb:2:in '<main>')`.
- **Applicability:** introduced in 9.0.0 ("Rename variable, param, accessor, extra and helper 'items' to 'limit'"). It takes effect as soon as the gem is bumped. The fix cannot go out before the bump because `pagy/extras/limit` does not exist in 8.6.3 (I checked its `extras/` directory). Ship it in the same commit as the Gemfile change. The URL parameter stays `per_page` because the app sets it explicitly, so bookmarked URLs keep working.
- **Recommended repair:** replace the setup lines with:
  ```ruby
  require "pagy/extras/limit"
  require "pagy/extras/overflow"

  Pagy::DEFAULT[:limit] = 10
  Pagy::DEFAULT[:limit_param] = :per_page
  Pagy::DEFAULT[:limit_max] = 50
  Pagy::DEFAULT[:overflow] = :last_page
  ```
  Also update the comment on line 1, which still describes the `items` extra.
- **Validation:** before the repair, the app fails at boot. After it, it boots and loads every file. The existing test `notes_controller_test.rb` lines 87–91 checks that `per_page=500&page=2` shows "Displaying notes 51-52 of 52 in total" and a prev link with `{"per_page"=>"50","page"=>"1"}`. That proves the cap of 50 and the `per_page` name still work. Line 54 (`per_page=5`) is the control for a normal value under the cap. Both pass after the repair.

### R2. `@pagy.items` was renamed to `@pagy.limit`
- **Affected code:** `/home/user/workspace/repo/app/views/notes/index.html.erb` line 30 (`options_for_select([5, 10, 25, 50], @pagy.items)`).
- **What breaks:** `@pagy.items` no longer exists in 9.x, so `GET /notes` would raise `NoMethodError`. I only saw this by reading the source: I fixed it together with R1, so it never failed on its own in the workspace.
- **Applicability:** 9.0.0, takes effect immediately on the bump. 8.6.3 has no `limit` method, so ship it with the bump.
- **Recommended repair:** change it to `@pagy.limit`.
- **Validation:** `notes_controller_test.rb` line 60 checks `select[name=per_page] option[selected]` equals "5" when `per_page=5` is sent. That is the discriminating check. The default case, where 10 is selected, is the control. It passed after the repair.

### R3. Bad `?page=` values now cause an error instead of showing page 1
- **Affected code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb`, line 18 in `NotesController#index` (`pagy(@notes)`).
- **What breaks:** in 8.6.3, `Pagy::Backend#pagy_get_page` turned the value into a number of at least 1 (`[params[...].to_i, 1].max`). In 9.3.5 it only converts to an integer (`(page || 1).to_i`). As a result, `GET /notes?page=` (blank), `page=0`, `page=-1` and `page=two` now raise `Pagy::VariableError: expected :page >= 1; got 0`, which users see as a 500. The upgraded suite caught this in `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` (test file lines 74–79). This change is not in the changelog.
- **Applicability:** 9.0 backend refactor. It applies immediately on the bump, for requests with a bad page value. The repair works on both 8.6.3 and 9.3.5, so you can ship it first.
- **Recommended repair:** add a private method to `NotesController`:
  ```ruby
  def pagy_get_page(vars, **)
    [super.to_i, 1].max
  end
  ```
  The `**` accepts 9.x's `force_integer:` keyword and is harmless on 8.6.3. Putting a rescue around `Pagy::VariableError` instead would also hide genuine configuration errors, so I don't recommend it.
- **Validation:**
  - Probe on both versions: `""`, `nil`, `"0"`, `"-1"` and `"two"` all return 1, and `"3"` returns 3.
  - The full suite went from 1 error (305 assertions) to 0 errors (325 assertions).
  - The control check is the existing tests at lines 87–95:
    - `page=2` with `per_page=500` still shows notes 51–52.
    - `per_page=50&page=9` still falls back to the last page through the overflow setting.

### Other changelog items checked, which don't affect this app
- The app has no JavaScript, CSS extras or keyset pagination.
- It does not use `:size` arrays, `anchor_string` or `fragment`.
- The `size` matches are unrelated `requests.size` calls in a test.
- The `arguments.first` and `schedule_reminder` matches are false positives.
- 9.3.3 changed the `:item_name` key (it now uses `:other`). A probe gave the same output on both versions: `pagy_info(..., item_name: "notes")` shows "Displaying notes 51-52 of 52 in total", and with a count of 1 it shows "Displaying 1 note". So line 40 of `index.html.erb` is unaffected.
- `pagy_url_for(@pagy, page)` on lines 61–62 works unchanged. The prev-link test passed.
- A non-numeric `per_page` (for example `"abc"`) turns into a limit of 0 on both versions. That is an existing bug, not something the upgrade causes.

## 2. New configuration defaults across intermediate releases
pagy is not a Rails component, so there are no `load_defaults` changes. 9.0.0 renamed four settings: `:items` to `:limit`, `:items_param` to `:limit_param`, `:max_items` to `:limit_max`, and `:items_extra` to `:limit_extra`. The app sets the first three explicitly, which R1 covers. It doesn't set `:limit_extra`, which defaults to true, the same as before. 9.2.0 deprecated `:after_latest` and 9.3.0 removed `:typecast_latest`; both are keyset-only and the app doesn't use either. No other new defaults affect this app.

## 3. Rollout, rollback, and mixed-version risks
- **Stored data, `db/schema.rb`, Redis cache, cookies and tokens, Active Job payloads:** pagy stores nothing in any of these, so running both versions side by side is safe. The `Gemfile.lock` diff changes only pagy.
- **URLs:** `per_page` and `page` stay the same, so links generated by either version work on the other.
- **Order of changes:**
  1. Ship R3 (the `pagy_get_page` override) on 8.6.3 first.
  2. Then ship the Gemfile bump together with R1 and R2 as one commit.
- **Rollback:** reverting that commit is enough. Keep the R3 override, since it works on both versions.

## 4. Verification log and open questions
- **Executed in the workspace:**
  - `gem-changes pagy 8.6.3 9.3.5`. The script could not unpack the 9.x .gem files, so it skipped the per-release package diffs; it still read the changelog and the git commits.
  - `upgrade-workspace setup`: the lockfile resolved to pagy 9.3.5. Baseline passed (46 runs, 325 assertions, 0 failures). Upgraded failed to boot with the R1 `LoadError`.
  - `upgrade-workspace test` after R1 and R2: 1 error (the R3 `VariableError`). After R3: 46 runs, 325 assertions, 0 failures, 0 errors.
  - Two `upgrade-workspace probe` runs: the page-number and `pagy_info` comparisons, and the override behaving the same on both versions.
  - `cleanup`: checkout clean.
- **Logs:** they were under `/tmp/upgrade-pagy-9.3.5/logs` but were deleted at cleanup.
- **Based on reading source only:** the R2 `NoMethodError` (fixed before it could fail on its own), the 8.6.3 and 9.3.5 implementations of `pagy_get_page` and `pagy_get_limit`, and the fact that `extras/limit` is missing from 8.6.3.
- **Proposed, not run:**
  - A request test for `GET /notes?per_page=5` that asserts exactly 5 `.note` items and selected option "5".
  - The browser suite (`bin/rails test:system`).
- **Open question:** should a non-numeric `per_page` be fixed separately? It fails the same way on both versions.

---

**My notes:**
- **Nothing in the repo has changed yet:** the upgrade skill only produces a plan, so `Gemfile` still pins `pagy "8.6.3"`.
- **What blocks the upgrade:** the `items` → `limit` rename stops the app from booting until the initializer is updated. The view's `@pagy.items` also needs renaming to `@pagy.limit`.
- **New 500 errors:** after the bump, a blank, zero, negative or non-numeric `?page=` value causes a server error. The `pagy_get_page` override prevents this and works on both versions, so it can ship first.
- **Not yet run:** the browser suite (`bin/rails test:system`).

Should I go ahead and implement it in that order: the controller fix first, then the bump with the initializer and view changes?