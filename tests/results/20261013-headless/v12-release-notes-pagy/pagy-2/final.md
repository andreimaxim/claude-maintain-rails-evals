The upgrade can't ship as a plain version bump, but the fix is small: three changes that have to go out in the same deploy as the version bump. On 9.3.5 with only the version changed, the app fails to boot. With the three changes applied, the notes list behaved the same as on 8.6.3 in every case I probed.

**How I tested.** The change summary is at `/tmp/pg/changes.txt`. I ran experiments in two copies, `/tmp/pg/app` (upgraded) and `/tmp/pg/app8` (8.6.3), each with its own Postgres database (`pagyexp_test` and `pagyexp8_test`, both dropped afterwards). In the test environment the cache is `:null_store`, jobs use the `:test` adapter, and storage is `tmp/storage` inside each copy, so nothing touched shared services. I bumped only pagy (`bundle update pagy --conservative`; the lockfile shows `pagy (9.3.5)`, log at `/tmp/pg/bundle.log`). The working repository is unchanged.

Pagy has no per-release config defaults the way Rails does. Within this range it only renamed settings, and this app overrides all of them (see the defaults section).

## Required changes

**1. The initializer no longer loads (executed).** `config/initializers/pagy.rb` requires `pagy/extras/items`, which 9.0 renamed. Booting fails with:
`cannot load such file -- pagy/extras/items (LoadError)` (`/tmp/pg/boot.log`)

- **Fix:** require `pagy/extras/limit` and rename the settings: `DEFAULT[:items]` to `[:limit]`, `[:items_param]` to `[:limit_param]`, `[:max_items]` to `[:limit_max]`.
- **Partial rename risk (from source):** if only the require is renamed, the old keys are ignored without any error. Pagy 9 would then show 20 notes per page, read the page size from `limit` instead of `per_page`, and cap it at 100 instead of 50.
- **Not a preparatory change:** `extras/limit` doesn't exist in 8.6.3, so this must ship in the same deploy as the bump.

**2. The view calls a removed method (executed).** `app/views/notes/index.html.erb:30` calls `@pagy.items`. Six of the 13 notes controller tests failed with:
`ActionView::Template::Error: undefined method 'items' for an instance of Pagy` (`/tmp/pg/t1.log`)

- **Fix:** use `@pagy.limit`. That method doesn't exist in 8.6.3, so this is also part of the same deploy.

**3. Invalid page numbers now cause a 500 error (executed; the changelog never mentions it).** In 8.6.3, `pagy_get_page` raised any page number below 1 up to 1. In 9.x it does `(page || 1).to_i`, so `page=""`, `page=0`, `page=-1` and `page=two` all raise:
`Pagy::VariableError: expected :page >= 1; got 0` (`/tmp/pg/t2.log`)

The test "invalid pages show the first page…" catches this. Stale or hand-edited links would otherwise show users an error page.

- **Fix:** add a private override in `NotesController`:
  ```ruby
  def pagy_get_page(vars, **)
    [super, 1].max
  end
  ```
- **Works on the current version too:** with this override on 8.6.3, the full suite passed (46 runs, 0 failures; `/tmp/pg/v8_override_test.log`). It can ship first, on its own.
- **I recommend this one.** The alternatives are worse: rescuing `Pagy::VariableError` would also hide page-size errors, and changing the request parameters in a `before_action` affects the pagination links.

## Validation

**Already run:**
- **Upgraded copy with all three fixes:** `bin/rails zeitwerk:check` reports "All is good!", and the full suite passes (46 runs, 325 assertions, 0 failures; `/tmp/pg/v9_full.log`). `bin/rails test:system` ran 0 tests because there are no system tests, so no browser behavior was checked.
- **Side-by-side probe:** a throwaway test (`/tmp/pg/scripts/probe_test.rb`) signs in as `users(:reader)` and creates 23 notes in `notebooks(:essays)`. For each set of URL parameters it records the status, the "Displaying…" text, the selected page size, the Next link and the number of rows. It also covers one matching note and no matches.
  - On 9.3.5 with the fixes (`/tmp/pg/probe_v9_fixed.txt`) the results match 8.6.3 (`/tmp/pg/probe_v8.txt`) everywhere. The only difference is the wording of an error message (`:items` vs `:limit`) in cases that already crashed on 8.6.3.
- **Does each check catch its problem?**
  - Problem 3: the test "invalid pages show the first page…" fails without the override (`/tmp/pg/t2.log`) and passes with it.
  - Problems 1 and 2: boot and the index tests fail without the fix and pass with it.
- **Control:** for `page=99`, `per_page=500` (capped at 50), `per_page=7`, and the filtered paging test (links keep `query`, `notebook_id`, `status` and `per_page`), the results are identical on both versions.

**Still proposed:** a request test for `per_page=""` (behavior I want to keep the same). It's also worth checking the `per_page` dropdown still works by hand on a staging server, since no browser test covers it.

## Existing bugs (same on both versions, not caused by the upgrade)
- `per_page` values of `0`, `abc`, `""` or `-5` raise `Pagy::VariableError` (a 500).
- Array parameters (`page[]=2`, `per_page[]=3`) raise `NoMethodError: undefined method 'to_i' for an instance of Array`.

Neither is required for this upgrade. If you want, a fix is to clamp `per_page` in the same override style.

## Optional defaults, release by release (from source unless noted)
- **9.0:** the renames above. Pagy 9's own defaults are `limit: 20`, `limit_param: :limit`, `limit_max: 100` and `limit_extra: true`, the same as 8.x's item defaults. The app overrides them to 10, `per_page` and 50, so nothing changes once the settings are renamed. Other breaking changes in 9.0 (keyword arguments to `Pagy.new`, fragment/anchor and link-header changes, removed JavaScript files) don't apply: the app only uses `pagy(...)`, `pagy_info` and `pagy_url_for(pagy, page)`, and none of those signatures changed. The `pagy_url_for` part was executed: the links match.
- **9.0.3:** the `pagy*_get_vars` methods were removed. The app doesn't override them.
- **9.1:** no setting changes that affect this app.
- **9.2 and 9.3.0:** `after_latest` became `filter_newest`, and `typecast_latest` was removed. These only matter for keyset pagination, which the app doesn't use.
- **9.3.3:** the default `item_name` changed. The app always passes its own `item_name`; the probe shows "Displaying 1 note" and the same range text on both versions. `config/locales/en.yml` doesn't override any pagy keys.
- **Overflow:** the default is still `:empty_page`, and the app keeps `:last_page` (`page=99` shows the last page; executed).

## Rollout and rollback
- **Stored data:** none. Pagy keeps nothing in the database, cache or job queue.
- **URLs:** the generated URLs use the same `page` and `per_page` parameters on both versions (executed), so bookmarks and a mix of old and new servers during a deploy are fine.
- **Order:**
  1. The `pagy_get_page` override can ship first, because it works on 8.6.3.
  2. Fixes 1 and 2 go in the same commit as the Gemfile and lockfile bump.
- **Rollback:** revert that commit as a whole. Leaving the override in place is harmless.

## Unverified
- I didn't run a development server or a real browser, and there are no system tests.
- I read the changelogs as summarized by the tool and compared the 8.6.3 and 9.3.5 gem source. I didn't read the source of every 9.x patch release in between.

---

That's the plan from the upgrade planner, which tested in throwaway copies under `/tmp/pg`. Your repository is still on pagy 8.6.3 and I haven't changed anything: the upgrade skill only produces a plan.

The upgrade needs three code changes along with the version bump. Two have to ship in the same commit as the bump: renaming the initializer settings and changing `@pagy.items` to `@pagy.limit` in the view. The third, the `pagy_get_page` override, can ship first. Should I implement it?