This is the full upgrade plan from the planning agent, unedited. I haven't changed your repository. The test runs it cites happened in copies under `/tmp/pg`.

---

The upgrade from pagy 8.6.3 to 9.3.5 needs three code changes, two in files the change summary flagged and one it missed. Without them the app does not boot, the notes list errors on every request, and bad `page` values raise errors. With all three in a disposable copy, the full suite passed. A test run showed the controller change also works on 8.6.3, so it can ship first.

## How I tested it
- **Change summary:** `ruby /home/user/planner-run/maintain-rails/bin/gem-changes pagy 8.6.3 9.3.5`, output in `/tmp/pg/changes.txt`. It covers 9.0.9, 9.1.1, 9.2.2 and 9.3.5, and flagged only two lines in `app/views/notes/index.html.erb` (30 and 40).
- **Upgraded copy:** `/tmp/pg/app`, with the Gemfile pin changed to `"9.3.5"` and `bundle update pagy --conservative` (log in `/tmp/pg/bundle.log`). Only pagy changed in the lock, 8.6.3 to 9.3.5.
- **Isolation:**
  - Database: a separate PostgreSQL database, `DATABASE_URL=postgres:///pagy9_exp_test`, `RAILS_ENV=test`.
  - Cache, jobs, storage: the test environment already uses a `:null_store` cache and the `:test` job adapter, and storage is under the copy's own `tmp/storage`.
  - Cleanup: both experiment databases were dropped afterwards. The working repo was not changed.
- **Second copy:** `/tmp/pg/app8`, still on pagy 8.6.3, with only the controller change from finding 3 (database `pagy8_exp_test`).

| Run | Variant | Result | Log |
|---|---|---|---|
| 1 | pagy 9.3.5, no code changes | Does not boot: `cannot load such file -- pagy/extras/items (LoadError)` from `config/initializers/pagy.rb` | `/tmp/pg/db.log` (overwritten by run 2) |
| 2 | + initializer renamed | 46 runs, **7 errors**: 6 × `ActionView::Template::Error: undefined method 'items' for an instance of Pagy`, 1 × `Pagy::VariableError: expected :page >= 1; got 0` | `/tmp/pg/test-initfix.log` |
| 3 | + view uses `@pagy.limit` | 46 runs, **1 error** (the `VariableError`) | `/tmp/pg/test-viewfix.log` |
| 4 | + `pagy_get_page` override | 46 runs, 325 assertions, **0 failures, 0 errors** | `/tmp/pg/test-full-repair.log` |
| 5 | pagy **8.6.3** + override only | 46 runs, 325 assertions, 0 errors | `/tmp/pg/test-8-prep.log` |

I did not run `bin/rails test:system`. The system tests don't mention `pagy` or `per_page`.

## Required changes

**1. Initializer: the "items" extra and settings were renamed to "limit" (9.0.0, breaking).** Executed check.
- **Affected code:** `config/initializers/pagy.rb`.
- **If nothing is done:** the app does not boot (`LoadError` above).
- **Fix:**
  - `require "pagy/extras/limit"`
  - `Pagy::DEFAULT[:limit] = 10`
  - `Pagy::DEFAULT[:limit_param] = :per_page`
  - `Pagy::DEFAULT[:limit_max] = 50`
  - Keep `require "pagy/extras/overflow"` and `DEFAULT[:overflow] = :last_page`; they still exist in 9.
- **Why it is safe for existing links:** keeping `limit_param = :per_page` means bookmarked URLs and the `per_page` select keep working. Pagy 9's own default parameter name would be `limit`, which would silently ignore `per_page` in existing links. Don't adopt it.
- **Why it can't be prepared early:** this file can't work on both versions, so it ships in the same commit as the gem bump.
- **Check that fails without the fix and passes with it:** `bin/rails zeitwerk:check` or booting the app.
- **Control (should not change):** `per_page=500&page=2` still caps at 50 and shows "Displaying notes 51-52 of 52 in total". The prev link query stays `{"per_page"=>"50","page"=>"1"}` (`notes_controller_test.rb:87-91`). Run 4 passed this.

**2. View: `@pagy.items` was removed and is now `@pagy.limit` (9.0.0).** Executed check.
- **Affected code:** `app/views/notes/index.html.erb:30`.
- **If nothing is done:** every notes index request fails with `undefined method 'items' for an instance of Pagy`.
- **Fix:** use `@pagy.limit`. This method only exists in 9, so it ships with the bump.
- **Check:** the existing test asserting `select[name=per_page] option[selected]` is "5" (`notes_controller_test.rb:60`) errors without the fix and passes with it.
- **Control:** the default page shows 10 notes.

**3. Bad `page` values are no longer treated as page 1; they now raise an error.** Executed check; the change summary did not flag this.
- **What changed in the gem:**
  - 8.6.3, `pagy_get_page`: `[params[...].to_i, 1].max`, so bad values became page 1.
  - 9.3.5: `(page || 1).to_i`, so `""`, `"0"`, `"-1"` and `"two"` reach Pagy unchanged and raise `Pagy::VariableError: expected :page >= 1; got 0`.
- **Effect here:** the app has no `rescue_from`, so stale or hand-edited URLs (including an empty `page=` from forms) would produce 500 errors in production.
- **Recommended fix:** add this private override in `NotesController`. It works on both 8.6.3 (run 5) and 9.3.5 (run 4), so it can ship before the bump.
  ```ruby
  def pagy_get_page(vars, **)
    [super.to_i, 1].max
  end
  ```
- **Alternative I don't recommend:** `rescue_from Pagy::VariableError` with a redirect. It would also hide other variable errors, and it changes the response from a 200 on page 1 to a redirect, which breaks the current tested behaviour.
- **Check:** `notes_controller_test.rb:74` sends `page` values `""`, `"0"`, `"-1"` and `"two"` and expects 10 notes starting at "Chapter 50". It errors on 9 without the fix and passes with it.
- **Controls:**
  - `page=2` with `per_page=500` still returns notes 51-52.
  - `page=9` with `per_page=50` (past the end) still falls back to the last page through the overflow extra.
- **Not changed:** `per_page=0` raises in both 8 and 9. That is existing behaviour, not a regression; I traced it in the source but didn't run it.

## Flagged but no change needed (source-based)
- **9.3.3 `:item_name` change:** it only affects the default `pagy.item_name` translation. The app passes an explicit `item_name:` string to `pagy_info`, so the output is the same, and run 4's "Displaying notes … of 52 in total" assertions pass. Not checked: the single-note wording ("1 note"); a request test with one note would cover it.
- **Other removals:** `max_limit`, the keyword-argument change for `pagy(...)`, the fragment and anchor refactors, `pagy*_get_vars`, the JS files, `after_latest` and `typecast_latest` (keyset pagination), and `link_header`. None are used here; the app calls only `pagy(@notes)`, `pagy_info` and `pagy_url_for(@pagy, n)`, and those signatures are unchanged.

## New defaults, release by release
Pagy has no Rails-style framework-defaults file.
- **9.0:** the defaults move to the `limit` names. `limit_max` is 100 (same as the old `max_items`), and the app overrides it to 50. The parameter default becomes `limit`; the app keeps `per_page` (see finding 1).
- **9.1, 9.2, 9.3:** no new defaults that affect this app. `filter_newest` and the keyset items are unused.

## Rollout and rollback
- **Order:** ship finding 3 first, since it works on 8. Then ship the gem bump together with findings 1 and 2 in one commit.
- **Data and jobs:** no stored data or queued jobs involve pagy, and the URL format (`per_page`, `page`) is the same on both versions. Running old and new versions side by side is safe, and rolling back is just reverting that commit.

## Still open
- System tests weren't run.
- I didn't do a manual browser check of the pagination links.
- The single-note `pagy_info` wording isn't covered by a test.

---

The test results above come from the planning agent's runs. I didn't rerun them myself. If you want me to go ahead, I'd make two changes:
1. Add the `pagy_get_page` override, which also works on the current 8.6.3.
2. In one commit, bump the gem to 9.3.5 and make the initializer and view changes.