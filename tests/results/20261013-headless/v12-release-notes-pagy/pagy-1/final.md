I've written a plan for upgrading pagy from 8.6.3 to 9.3.5. It needs three code changes. Without them the app won't boot, and after a partial fix the notes index still fails with errors (500s for users) in two ways. With all three applied in a disposable copy, the full `bin/rails test` run passes (46 runs, 0 failures, 0 errors), `zeitwerk:check` passes, and the lockfile changes only pagy. The browser suite (`test:system`) was not run. The working repository was not modified.

## How I tested
- **Change index:** `ruby /home/user/planner-run/maintain-rails/bin/gem-changes pagy 8.6.3 9.3.5`, output in `/tmp/pagy-changes.txt`. It read the release notes for 9.0.9, 9.1.1, 9.2.2 and 9.3.5, covering the 9.0.0 to 9.3.4 changelog entries. It flagged two items, `@pagy.items` and `item_name`.
- **Copies:**
  - `/tmp/pagyx/app` has Gemfile `gem "pagy", "9.3.5"` and was updated with `bundle update pagy --conservative` (log: `/tmp/pagyx/bundle.log`). The lockfile now has `pagy (9.3.5)` and nothing else changed.
  - `/tmp/pagyx/app8` is the unchanged 8.6.3 baseline, used as the control.
- **Isolation:** both copies used `DATABASE_URL=postgres:///pagyx_test`, a separate database that I dropped afterwards. The test environment already uses a `:null_store` cache, the `:test` Active Job adapter and `:test` Active Storage, so no shared queue, cache or storage was touched.
- **Logs:**
  - `/tmp/pagyx/db.log`: boot failure
  - `/tmp/pagyx/test9a.log`: after the initializer fix only
  - `/tmp/pagyx/test9b.log`: notes tests after all fixes
  - `/tmp/pagyx/test9-full.log`: full suite after all fixes
  - `/tmp/pagyx/test8-prep.log`: page fix on 8.6.3
  - `/tmp/pagyx/probe-app8.log` and `/tmp/pagyx/probe-app.log`: behaviour probe on both versions (probe script: `/tmp/pagyx/probe/pagy_probe_test.rb`)

## Required changes

**R1. The initializer stops the app from booting** (`config/initializers/pagy.rb`)
- **What happens:** with no change, `bin/rails db:create` raises `cannot load such file -- pagy/extras/items (LoadError)`. Every process fails: web, console, jobs and tests.
- **Cause:** 9.0.0 renamed "items" to "limit" and `:max_items` to `:limit_max`.
- **Fix:** require `pagy/extras/limit` and set `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page`, `[:limit_max] = 50`. Keep the `overflow` extra and `:last_page`; both still exist in 9.x.
- **Why the names must change:** the old `DEFAULT` keys are not errors, they are simply ignored. If you leave `:items_param` or `:max_items` in place, the `per_page` parameter stops working and the cap falls back to 100.
- **Validation:**
  - Fails without the fix: the app boots at all.
  - `GET /notes?per_page=500&page=2` shows 50 per page and the prev link carries `per_page=50` (existing test at line 74).
  - Control: `GET /notes?per_page=5` keeps `per_page=5` in the prev and next links (test at line 48). Verified.
- **Current version:** this change cannot be made ahead of time on 8.6.3. It must ship in the same deploy as the gem bump.

**R2. `@pagy.items` no longer exists** (`app/views/notes/index.html.erb:30`)
- **What happens:** every notes index render raises `ActionView::Template::Error: undefined method 'items' for an instance of Pagy`. This showed up in 5 tests (`test9a.log`).
- **Fix:** use `@pagy.limit`. Same deploy as R1.
- **Validation:** the `select[name=per_page] option[selected]` element equals "5" for `per_page=5`, and equals "10" with no parameter.

**R3. Invalid page numbers now raise instead of showing page 1** (`app/controllers/notes_controller.rb:18`)
- **What happens:** 9.x changed `pagy_get_page` from `[params[:page].to_i, 1].max` to `(page || 1).to_i`. So `?page=`, `?page=0`, `?page=-1` and `?page=two` raise `Pagy::VariableError: expected :page >= 1; got 0` (a 500). On 8.6.3 all four returned 200 with page 1.
- **Not covered by the change index:** the changelog does not describe this, and the tool did not flag it. The existing test at line 74 catches it.
- **Recommended fix:** `@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)`.
  - This also works on 8.6.3 (`test8-prep.log`: 13 runs, 0 failures), so it can ship first as a preparatory change.
  - Pages past the end, such as `?page=999`, still go to the last page through the overflow extra. Verified 200 on both versions.
- **Alternatives, not recommended:**
  - Overriding `pagy_get_page`: its signature changed (9.x adds `force_integer:`), so the override would be tied to one version.
  - `rescue_from Pagy::VariableError`: it would also swallow limit errors and lose the "show page 1" behaviour.
- **Validation:**
  - Each of the four bad values returns 200 and renders page 1. This fails on 9.3.5 without R3 and passes with it.
  - Control: `?page=2` still renders page 2 with the filters kept.

## Checked, no action needed (executed probe on both versions)
- **`pagy_info` with `item_name`** (9.3.3 change to `:item_name`): the app passes a plain string, and the output is identical on both versions:
  - "Displaying 2 notes"
  - "Displaying notes 1-1 of 2 in total"
  - "Displaying 1 note"
- **`pagy_url_for` links:** identical on both versions, e.g. `/notes?per_page=1&page=2`.
- **Existing bug, not caused by the upgrade:** `?per_page=0` and `?per_page=abc` already raise on 8.6.3 (`expected :items >= 1; got 0`). On 9.3.5 the message becomes `expected :limit >= 1; got 0`. Fixing it would be a separate change, for example passing `limit: params[:per_page].to_i.clamp(1, 50)` when present.

## Other changes in the range and whether they apply
- **9.0.0:**
  - The `vars` hash became keyword arguments. The R3 call uses keyword-compatible syntax that works on both versions.
  - Fragment and anchor_string refactor, and removal of the 8.x deprecations: not used here.
- **9.0.1:** `row_comparison` renamed to `tuple_comparison` (keyset): not used.
- **9.0.2:** link header renamed to `pagy_link_header`: not used.
- **9.0.3:** JavaScript files removed, and `pagy*_get_vars` methods removed. The app uses no pagy JavaScript and no overrides.
- **9.2.0 and 9.3.0:**
  - `:after_latest` became `:filter_newest`, and `:typecast_latest` was removed: keyset only, not used.
- **9.3.3:** `:aria_label` no longer has an `:other` key. The app writes its own nav `aria-label` and has no pagy locale overrides (`config/locales/en.yml` has none).
- **New configuration defaults:** pagy has no Rails-style `new_framework_defaults` setting. The only new default in the range is `DEFAULT[:limit_max] = 100`, set by the limit extra. The app keeps its own cap of 50 only if R1 sets the `:limit_max` key. Under the old `:max_items` key the cap silently becomes 100.

## Rollout and rollback
- **Order:** ship R3 first; it works on 8.6.3. Then ship R1, R2 and the gem bump together.
- **No stored data or queued jobs** involve pagy. URLs keep the same `page` and `per_page` parameters, so bookmarks still work on both versions during a mixed-version deploy.
- **Rollback:** revert R1, R2 and the gem bump together. R3 can stay.
- **Cache:** none is involved (`null_store` in test). If production caches the index fragment, the HTML is unchanged anyway.

## Still unverified
- The browser suite (`bin/rails test:system`) was not run.
- Only the development and test boot paths were tested. A production eager-load boot is expected to behave the same, since the failure is a require in the initializer.

---

That's the plan. Your repo hasn't been changed; all the testing happened in copies under `/tmp/pagyx`. Do you want me to make the upgrade now? That means the three code changes plus the Gemfile/lockfile bump, then running `bin/rails test` and `bin/rails test:system`.