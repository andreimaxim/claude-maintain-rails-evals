Here's the plan for upgrading pagy from 8.6.3 to 9.3.5. It was tested in throwaway copies of the app, and your working tree hasn't been changed.

# pagy 8.6.3 to 9.3.5 upgrade plan for Margin Notes

Margin Notes won't boot on any pagy 9.x version (9.0.9, 9.1.1, 9.2.2 or 9.3.5) without code changes. After one fix it boots, but one existing test fails. With both fixes below, the app boots, prepares the database, eager-loads and loads routes, and all 46 existing tests pass (325 assertions). I made every change in lab copies only. The original checkout was not modified, and its file hashes were verified unchanged.

Nothing else moves: the target lockfile differs from the baseline only in the pagy line. The tools listed no framework defaults for this upgrade, and no stored data (cookies, cache entries, database values, queued jobs) depends on pagy. 9.3.5 needs Ruby 3.1 or later, and the app runs 3.3.6.

## Required changes

### F1. pagy 9 renames "items" to "limit", so the app cannot boot
- **Where:** `config/initializers/pagy.rb` lines 2 and 6–8, and `app/views/notes/index.html.erb:30` (`@pagy.items`).
- **What I saw:** on all four 9.x versions, boot fails with `cannot load such file -- pagy/extras/items (LoadError)`.
- **Hidden trap:** if only the `require` line is changed, the app boots, but the old settings are silently ignored:
  - the page size becomes pagy's default of 20 instead of 10;
  - `?per_page=` stops working, because pagy now reads `?limit=`;
  - the maximum page size becomes 100 instead of 50.

  A test against that partial fix confirmed all three.
- **Fix:**
  ```ruby
  require "pagy/extras/limit"
  require "pagy/extras/overflow"
  Pagy::DEFAULT[:limit] = 10
  Pagy::DEFAULT[:limit_param] = :per_page
  Pagy::DEFAULT[:limit_max] = 50
  Pagy::DEFAULT[:overflow] = :last_page
  ```
  In the view, change `@pagy.items` to `@pagy.limit`. Keeping `per_page` as the URL parameter means existing bookmarks still work.
- **Source:** the 9.0.0 changelog entries "Rename items to limit" and "Rename :max_limit to :limit_max".
- **Rollout:** this change doesn't work on 8.6.3, so ship it in the same deploy as the Gemfile bump, and roll both back together.

### F2. pagy 9 no longer treats bad page numbers as page 1
- **Where:** `app/controllers/notes_controller.rb:18`.
- **What changed:** pagy 8.6.3 turned a bad `?page=` value into 1. Pagy 9.3.5 doesn't. A page value of `''`, `0`, `-1` or `two` now raises `Pagy::VariableError: expected :page >= 1; got 0`, so the notes list returns a 500 error instead of the first page. The overflow setting doesn't catch this error.
- **What I saw:** with only F1 applied, the existing test `test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` errors (46 runs, 1 error).
- **Source:** commit 4b8e98ad6286 ("Improve pagy_get_page with force_integer option"). The changelog does not call this a breaking change.
- **Fix:**
  ```ruby
  @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- **Works on the current version:** a copy on 8.6.3 with only this fix passes all 46 tests. It can be merged before the bump, and rolling back the bump doesn't require undoing it.

## Recommended order
1. Merge F2 while still on 8.6.3.
2. Deploy the Gemfile bump together with F1.
3. To roll back, revert step 2 only.

## What I ran
- **Behavior test** (`probe_pagy.rb`), run against the current app, the partial F1 fix and the fully fixed copy. It checks per_page=25, the cap at 500→50, the default of 10, a blank or negative page, the controller's page fix, a normal page 2 as a control, and page 99 of 12 falling back to the last page.
  - Current app: all 8 checks pass.
  - Partial F1 fix: 6 of 8 fail.
  - Fully fixed copy: every check that goes through the app's code passes. The run still reports failure (exit 1) because two checks deliberately call pagy without the controller's page fix, to show the new pagy behavior. Those are expected to fail.
- **Full test suite:** 46 runs, 325 assertions, 0 failures and 0 errors on the fully fixed copy, and the same result on the current version.
- **Isolation:** databases, Redis, file storage and mail stayed inside the lab. The citation provider only used the local stand-in server that the tests start. The lab's databases have been removed. Copies and logs remain.

## Limits and checks not run
- I didn't run the browser tests (`bin/rails test:system`). `test/system` contains no tests, and Chrome/Selenium was not used.
- I reviewed the full code diff for pagy's library and the priority commits. Of the 175 commits, 29 lower-priority ones were not opened individually. These touch docs, e2e and playground files, which I judged not to apply.
- The 9.3.3 change to how `pagy_info` picks the item name doesn't apply, because the view passes its own `item_name`. I checked this from the source and the existing tests only; non-English translations were not tested.
- Real production traffic was not tested.
- Passing the existing tests is not proof of safety on its own. The two changes above are what the evidence supports.

## Files
- Plan JSON: `/tmp/gem-upgrade-20261014-71555-vxkzit/plan.json`
- Behavior test script: `/tmp/gem-upgrade-20261014-71555-vxkzit/probe_pagy.rb`
- Run records:
  - `/tmp/gem-upgrade-20261014-71555-vxkzit/runs/v9_3_5/003-boot.log` (boot failure)
  - `/tmp/gem-upgrade-20261014-71555-vxkzit/runs/v9_3_5_requireonly/002-probe.log` (partial F1 fix)
  - `/tmp/gem-upgrade-20261014-71555-vxkzit/runs/v9_3_5_fixed/006-tests.log` (F1 only, F2 error)
  - `/tmp/gem-upgrade-20261014-71555-vxkzit/runs/v9_3_5_fixed2/006-tests.log` and `008-probe.log` (fully fixed)
  - `/tmp/gem-upgrade-20261014-71555-vxkzit/runs/baseline_pageclamp/006-tests.log` (F2 fix on 8.6.3)
  - `/tmp/gem-upgrade-20261014-71555-vxkzit/runs/baseline/008-probe.log` (current app)
- Fixed copy: `/tmp/gem-upgrade-20261014-71555-vxkzit/variants/v9_3_5_fixed2/app`
- Sources: `/tmp/gem-upgrade-20261014-71555-vxkzit/sources/index.md` and `/tmp/gem-upgrade-20261014-71555-vxkzit/sources/repositories/59ffd940c63a/range.patch`

---

I haven't changed the repo yet; the upgrade skill only produces a plan. Should I apply it? I'd make the controller page fix (F2) first, then bump the Gemfile together with the settings and view change (F1), and run `bin/rails test` after each step.