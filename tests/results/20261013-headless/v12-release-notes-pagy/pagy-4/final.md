Upgrading pagy from 8.6.3 to 9.3.5 needs four small changes in three files. Without them the app doesn't boot, and the obvious partial fix still changes page-size behaviour and makes malformed `page` URLs raise. With all four applied in a disposable copy, the suite passed (46 runs, 0 failures) and `zeitwerk:check` was clean. The working repository was not modified.

## Required changes

**1. Boot fails: `config/initializers/pagy.rb`.** Pagy 9 renamed "items" to "limit", and the `items` extra no longer exists. `db:prepare` on the upgraded copy failed with:
`LoadError: cannot load such file -- pagy/extras/items` at `config/initializers/pagy.rb:2`.
- **Fix:** require `pagy/extras/limit` and rename the settings:
  - `Pagy::DEFAULT[:items] = 10` becomes `Pagy::DEFAULT[:limit] = 10`
  - `[:items_param] = :per_page` becomes `[:limit_param] = :per_page`
  - `[:max_items] = 50` becomes `[:limit_max] = 50`
  - `require "pagy/extras/overflow"` and `[:overflow] = :last_page` stay as they are.
- **Fixing only the require is not enough.** I tested that variant (log `/tmp/pg/testA.log`). The old `DEFAULT` keys are silently ignored, so pagy 9's own defaults apply: 20 per page, the `?limit=` parameter, and a cap of 100. The app's `?per_page=` choice stopped working. In the paging test, page 2 with `per_page=5` showed all 13 notes instead of notes 6-10.

**2. `@pagy.items` no longer exists: `app/views/notes/index.html.erb:30`.** Use `@pagy.limit` there. The existing assertion `select[name=per_page] option[selected] "5"` covers this.

**3. Malformed page numbers now raise: `NotesController#index`.** This one isn't in the changelog summary at all; I found it by running the app. Pagy 8 clamped the page number to at least 1. Pagy 9 converts it to an integer without clamping, so bad values raise an error and the request fails with a 500. Each request below was made as the `reader` fixture user with one note (logs `/tmp/pg/probe_noclamp.log`, `/tmp/pg/probe_fixed.log`, `/tmp/pg/probe8.log`):

| `page` | 8.6.3 | 9.3.5, no fix | 9.3.5, fixed |
|---|---|---|---|
| `""`, `"0"`, `"two"`, `"abc"` | 200 | `Pagy::VariableError: expected :page >= 1; got 0` | 200 |
| `"-1"` | 200 | `...got -1` | 200 |
| `"1"` (control) | 200 "Displaying 1 note" | 200 | 200 |

- **Fix:** add a private override in `NotesController`:
  ```ruby
  def pagy_get_page(*)
    page = super
    page.is_a?(Integer) ? [page, 1].max : page
  end
  ```
- **It also works on 8.6.3,** so it can go out first as a separate change. The full suite passed on 8.6.3 with it (47 runs including my probe; `/tmp/pg/test8_override.log`).
- **Alternatives:** catching `Pagy::VariableError` and redirecting would change the response from a 200 on page 1 to a redirect, and would also hide real configuration errors. Checking `params[:page]` in a `before_action` repeats pagy's own parameter handling.

**4. Validation.** The existing test `invalid pages show the first page and page size is capped at 50` fails on 9.3.5 without fix 3 and passes with it. `pages through filtered notes ... keeping the filters and page size` fails without fix 1's settings renames and passes with them. The controls that must not change:
- the `per_page=500` request is capped at 50;
- `per_page=50&page=9` still shows the last page;
- the previous/next links keep `per_page`, `query`, `notebook_id` and `status`;
- the summary still reads "Displaying notes 6-10 of 13 in total" and "Displaying 1 note".

## Other changes checked, no action needed
- **9.3.3 change to `:item_name`:** it only affects the lookup used when no name is passed. The app always passes `item_name: "note".pluralize(count)`, and the probe showed the singular "Displaying 1 note" unchanged.
- **`pagy_url_for(pagy, page)`:** still accepted in 9 (`pagy_url_for(pagy, page, absolute: false, fragment: nil, **_)`). The link assertions pass.
- **Other 9.x removals and renames** (keyword-argument variables, fragment/anchor rework, keyset `after_latest`/`typecast_latest`, `pagy*_get_vars`, the link header, JavaScript files): the app uses none of them.
- **Existing bug, not caused by the upgrade:** `?per_page=0` raises `Pagy::VariableError` on both 8.6.3 (`expected :items >= 1`) and 9.3.5 (`expected :limit >= 1`). Fix it separately if you want.

## New defaults
Pagy has no Rails-style framework defaults, and none of the 9.0 to 9.3.5 releases add a setting the app would have to opt into. What changed are the default values behind the renamed settings: 20 per page, `:limit` as the URL parameter, a cap of 100, and the `limit` extra switched on by default. The app keeps its old behaviour (10, `per_page`, 50) only if it sets the new keys as in fix 1. Adopting pagy's defaults would turn existing `?per_page=` bookmarks into no-ops and would change both the page size and the cap.

## Rollout and rollback
- **Data and jobs:** there is no stored data or queued job involving pagy, so nothing to migrate.
- **Mixed versions:** with `limit_param = :per_page`, both versions generate and accept the same URLs, so servers can run different versions side by side and rollback is safe.
- **Order:** deploy fix 3 first on 8.6.3. Fixes 1 and 2 must ship together with the version bump, because 8.6.3 doesn't recognise the `limit` names.

## How this was tested, and what wasn't
- **Setup:** disposable copies at `/tmp/pg/app` (pagy 9.3.5 via `bundle update pagy --conservative`; only pagy changed in `Gemfile.lock`, log `/tmp/pg/bundle.log`) and `/tmp/pg/app8` (8.6.3). Each used its own Postgres test database (`margin_notes_pagy9_test`, `margin_notes_pagy8_test`, dropped afterwards). The test environment uses `null_store` for the cache, the `:test` job adapter and `tmp/storage` for files.
- **Logs and diff:** test runs are in `/tmp/pg/testA.log` (require fix only), `/tmp/pg/testB.log` (settings renamed, no page fix: 1 error) and `/tmp/pg/testC.log` (all fixes: 46 runs, 0 failures). The full repair is in `/tmp/pg/repair.diff`, and the changelog summary is `/tmp/pg/changes.txt`.
- **Not run:** the browser suite (`bin/rails test:system`), and the app was never booted in development or production mode.
- **Not checked:** I didn't look for other `pagy` calls outside `app/`, `config/`, `lib/` and `test/`.

---

**Commentary:** This is only a plan. Your repo is unchanged and still on pagy 8.6.3. Besides the version bump in the `Gemfile` (`gem "pagy", "9.3.5"`), the upgrade needs the three changes above. Before merging, also run `bin/rails test:system`, which the planner didn't. If you want, I can apply the changes, either as one commit or with the page-clamping fix first as its own change.