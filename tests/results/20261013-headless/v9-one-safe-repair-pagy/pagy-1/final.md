# Pagy upgrade plan for Margin Notes: 8.6.3 to 9.3.5

Upgrading pagy alone breaks the app. Booting fails, the notes list raises an error on every request, and certain page values now raise an error instead of falling back to page 1. Four small changes fix all of this, and with them the full suite passes on 9.3.5. Nothing is stored or queued, so rollout and rollback are simple. I did not change the working repository; `git status` is still clean.

## How I checked
- **Change summary:** `bin/gem-changes pagy 8.6.3 9.3.5` is saved in `/tmp/pagy-changes.txt`. It read releases 9.0.9, 9.1.1, 9.2.2 and 9.3.5 but found **0 changelog entries**, because pagy doesn't ship a changelog. My findings therefore come from comparing the 8.6.3 and 9.3.5 gem source directly, plus the experiments below.
- **Upgraded copy:** `/tmp/pagyexp`, with Gemfile pinned to `"9.3.5"` and `bundle update pagy --conservative` (log: `/tmp/pagy-bundle.log`). Only pagy changed in the lockfile.
- **Isolation:**
  - Database renamed to `margin_notes_pagyexp_test` / `_dev`.
  - The test environment already uses `:null_store` for cache and the `:test` queue adapter.
  - Disk storage stays inside the copy.
  - I dropped the test databases afterwards.
- **Preparatory-change check:** `/tmp/pagyexp8`, still on 8.6.3, with only the controller change from Finding 3 (database `margin_notes_pagyexp8_test`).

## Required changes (all found by running the app)

**1. The `items` extra was renamed to `limit` and boot fails** (`config/initializers/pagy.rb:2`)
- Error when the app loads: `cannot load such file -- pagy/extras/items (LoadError)` (`/tmp/pagy-test1.log`).
- Fix: `require "pagy/extras/limit"`.

**2. The `items` settings were renamed to `limit` and are silently ignored if left as they are** (initializer lines 6–8)
- `:items` becomes `:limit`, `:items_param` becomes `:limit_param`, `:max_items` becomes `:limit_max`.
- If only the require line is fixed, nothing raises. The old keys are just ignored:
  - The default page size becomes 20 instead of 10. I confirmed this with `bin/rails runner`: `Pagy.new(count: 52).limit` returned 20 (`/tmp/pagy-runner.log`).
  - The page-size cap becomes 100 instead of 50, the 9.x default visible in `extras/limit.rb`.
  - The `per_page` URL parameter stops working, because the default limit parameter is `:limit`. Existing bookmarks with `?per_page=` would be ignored.
- The tests catch the page-size change, but not the cap or the parameter name until the page-size test runs.

**3. Invalid page numbers now raise an error instead of showing page 1** (`app/controllers/notes_controller.rb:18`)
- 8.6.3 returned `[params[:page].to_i, 1].max`. 9.3.5 returns `(page || 1).to_i` with no lower bound.
- So `page=""`, `"0"`, `"-1"` and `"two"` all raise `Pagy::VariableError: expected :page >= 1; got 0`. That error is an `ArgumentError`, so it shows up as a 500 in production.
- Seen in `/tmp/pagy-test3.log` in "invalid pages show the first page and page size is capped at 50".
- Recommended fix: a private override in `NotesController` that works on both versions:
  ```ruby
  def pagy_get_page(*, **)
    [super.to_i, 1].max
  end
  ```
  - The `*, **` signature accepts the 8.x form `(vars)` and the 9.x form `(vars, force_integer:)`. With only this change on 8.6.3, the suite passes (46 runs, 0 failures; `/tmp/pagy8-test.log`). So it can ship before the upgrade.
  - Valid page numbers pass through unchanged. The overflow extra still sends too-high pages to the last page (the `page=9` assertion passes).
- Alternative, not recommended: passing `page:` explicitly in the `pagy(@notes, ...)` call repeats the parameter handling by hand. Rescuing `Pagy::VariableError` would also hide real configuration errors.

**4. `Pagy#items` was removed** (`app/views/notes/index.html.erb:30`)
- Error: `ActionView::Template::Error: undefined method 'items' for an instance of Pagy`. It fails every notes list render, including the redirect after sign-in.
- Fix: `@pagy.limit`. This only works on 9.x, so it has to ship together with the gem bump, not before it.

**Result:** with all four changes, `bin/rails test` gives 46 runs, 325 assertions, 0 failures, 0 errors (`/tmp/pagy-test4.log`). `bin/rails test:system` ran 0 tests, so the browser layer is not covered by any test.

## Code checked and unchanged
- **`pagy_url_for(@pagy, page)`:** 9.x adds a `fragment:` keyword and passes `freeze: false` when cloning the request params. The app uses neither. The prev link still keeps `per_page=50&page=1` (test assertion at line 91 passes).
- **`pagy_info(..., item_name:)`:** same signature and same `pagy.info.*` locale keys. The "Displaying notes 51-52 of 52 in total" assertions pass.
- **Overflow extra with `:last_page`:** it was rewritten to use keyword arguments. Its behavior is the same here, and the `page=9` test passes.
- **`@pagy.pages`, `@pagy.prev`, `@pagy.next`, `@pagy.count`:** still present (`attr_reader`, and `pages` is an alias of `last`).

## New defaults, release by release (from source; no upgrade guide is packaged)
- **9.0:**
  - `DEFAULT[:limit]` is 20. The app sets 10 once renamed. Left as `:items`, the app would silently move to 20.
  - `limit_param` defaults to `:limit`. The app sets `:per_page`.
  - `limit_max` is 100. The app sets 50.
  - `size` changed from an array to the integer 7. This only affects `pagy_nav`, which the app doesn't use.
- **9.1–9.3:** I found no new defaults that affect the code paths this app uses. The changes are in keyset, other extras, and the `fragment:` handling in `pagy_url_for` mentioned above. This is less certain because I read source rather than release notes.

There are no optional defaults to adopt. Once renamed, every value the app sets explicitly keeps its 8.x behavior.

## Rollout, rollback, stored data
- Pagy stores nothing in the database, cache, queue, or files. Page links carry only `page` and `per_page`, and both are read the same way before and after.
- With several versions deployed at once, only the controller override matters, and it is safe on both. Changes 1, 2 and 4 must ship in the same deploy as the gem bump.
- Rollback means reverting that one commit. Keep the controller override.

## Still to check (not run)
- Manual check in a browser of the per-page select and the prev/next links. No system tests cover them.
- Read the upstream 9.x release notes and changelog on GitHub. I worked from gem source only, so a change described only in prose could have been missed.
- Check whether any external links use `?limit=`. After the upgrade that parameter is ignored, because the app reads `per_page`, so it causes no error.

## Files
- Change summary: `/tmp/pagy-changes.txt`
- Bundle log: `/tmp/pagy-bundle.log`
- Test logs: `/tmp/pagy-test1.log` through `/tmp/pagy-test4.log`, `/tmp/pagy-sys4.log`, `/tmp/pagy8-test.log`
- Runner check: `/tmp/pagy-runner.log`
- Disposable copies: `/tmp/pagyexp` (9.3.5) and `/tmp/pagyexp8` (8.6.3)
- App files to change: `/home/user/workspace/repo/config/initializers/pagy.rb`, `/home/user/workspace/repo/app/controllers/notes_controller.rb`, `/home/user/workspace/repo/app/views/notes/index.html.erb`, `/home/user/workspace/repo/Gemfile`

---

The upgrade skill only makes a plan, so I haven't changed anything in your repository. The planner ran all its experiments in throwaway copies under `/tmp`. If you want me to go ahead, I'd ship the `pagy_get_page` override first, since it works on 8.6.3. Then I'd do the gem bump together with the initializer, view and Gemfile changes as one commit.