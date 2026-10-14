# Upgrade plan: pagy 8.6.3 to 9.3.5 (Margin Notes)

Upgrading pagy needs four code changes. Bumping the gem alone stops the app from booting with `cannot load such file -- pagy/extras/items (LoadError)`. After three renames there is one more breaking change: a malformed `?page=` value now causes a 500 error. I tried every change below in a throwaway copy. Pagy is the only thing the bundle changed. I did not touch the working repo.

## Experiments

- **Throwaway copy:** `/tmp/pg/copy`, with the gem pinned to `9.3.5` and `bundle update pagy --conservative`. The lockfile changed only pagy (8.6.3 to 9.3.5); log at `/tmp/pg/bundle.log`.
- **Isolation:**
  - Test database renamed to `margin_notes_pagy9_test`.
  - The cache is `:null_store`, jobs use the `:test` adapter, and Active Storage writes to the copy's own `tmp/storage`.
  - A second copy, `/tmp/pg/copy8`, uses the database `margin_notes_pagy8_test`.
  - You can drop both databases afterwards.
- **Change index:** `/tmp/pg/changes.txt`. It found no changelog entries because pagy doesn't ship a changelog, so I compared the 8.6.3 and 9.3.5 gem source directly.
- **Coverage:** the tool lists 9.0.9, 9.1.1, 9.2.2 and 9.3.5. I worked from the 9.3.5 source rather than reading each release's notes, because every breaking change in this range came with the 9.0 renames.

| Variant | Change | Result | Log |
|---|---|---|---|
| Gem bump only | none | Boot fails: `cannot load such file -- pagy/extras/items (LoadError)` | `/tmp/pg/test-unchanged.log` |
| A | Only the require renamed | 7 errors: `undefined method 'items' for an instance of Pagy` (index.html.erb:30), plus `Pagy::VariableError: expected :page >= 1; got 0` | `/tmp/pg/test-A.log` |
| D | Require and view fixed, old `:items` keys kept | 2 failures: `Expected exactly 10 elements matching ".note", found 20.` The `per_page` option is ignored. | `/tmp/pg/test-D.log` |
| B | Settings renamed and view fixed | 1 error: `Pagy::VariableError: expected :page >= 1; got 0` (notes_controller.rb:18) | `/tmp/pg/test-B.log` |
| C | B plus the page clamp | 46 runs, 0 failures, 0 errors | `/tmp/pg/test-C.log` |
| Clamp only, on 8.6.3 (`/tmp/pg/copy8`) | Controller change only | 46 runs, 0 failures, 0 errors | `/tmp/pg/test-8prep.log` |

`bin/rails test:system` ran 0 tests (`/tmp/pg/system-C.log`), so nothing has been checked in a browser.

## Required changes

**1. Page-size extra renamed** (`config/initializers/pagy.rb:2`)
- **If nothing is done:** the app won't boot (LoadError above).
- **Fix:** `require "pagy/extras/limit"`. Only works on 9.

**2. Setting names renamed** (`config/initializers/pagy.rb:6-8`)
- **If nothing is done:** pagy 9 ignores unknown keys without any warning. Variant D showed the result:
  - Pages show 20 notes instead of 10.
  - `?per_page=` is ignored, because the parameter is now read as `limit`.
  - The cap goes up from 50 to 100.
- **Fix:**
  - `Pagy::DEFAULT[:limit] = 10`
  - `Pagy::DEFAULT[:limit_param] = :per_page`
  - `Pagy::DEFAULT[:limit_max] = 50`
- **Watch the cap name:** it is `limit_max`, not `max_limit`. A wrong name also fails silently.
- **Unchanged:** `:overflow` keeps its name. Keeping `:limit_param = :per_page` means existing bookmarked and shared URLs keep working.

**3. `Pagy#items` removed** (`app/views/notes/index.html.erb:30`)
- **If nothing is done:** `undefined method 'items'`, which breaks every notes list page, including the page you land on after signing in.
- **Fix:** use `@pagy.limit`. Only works on 9.

**4. Invalid page numbers now raise an error** (`app/controllers/notes_controller.rb:18`)
- **Cause:** in 8.6.3 the page was clamped with `[params[:page].to_i, 1].max`. In 9.3.5 `pagy_get_page` returns `(page || 1).to_i` with no minimum.
- **If nothing is done:** `?page=`, `0`, `-1` or `two` raises `Pagy::VariableError` (a subclass of `ArgumentError`), so users get a 500 instead of page 1.
- **Why the overflow setting doesn't help:** `:last_page` handling only catches `OverflowError`, which is a subclass of `VariableError`, and this error is the parent class.
- **Fix:** `@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)`.
- **Paths checked with the fix:**
  - No page parameter at all gives page 1.
  - Pages past the end still go to the last page.
  - Filters and `per_page` are kept in the previous/next links.
  - All of these are covered by `test/controllers/notes_controller_test.rb:48,74`.
- **Works on the current version too:** passes on 8.6.3, so it can ship ahead of the upgrade.
- **Alternatives:** overriding `pagy_get_page` would also work, but its signature changed in 9 (it gained `force_integer:`). Catching `Pagy::VariableError` would also hide real configuration mistakes. I recommend the explicit clamp.

## Behaviour that stays the same (source reading plus the variant C tests)

- `pagy_url_for(pagy, page)` keeps the same signature. It now also adds the `per_page` parameter, as the old extra did, and the test at line 61 confirms the parameters are identical.
- `pagy_info(pagy, item_name:)` uses the same `pagy.info.*` locale keys and text. The app has no pagy translations of its own.

## New defaults (optional)

No new defaults affect this app:
- The 9.x default page size (20), the `limit_extra` switch (on by default), and the `:limit` parameter name are all overridden by the app's own settings.
- The `overflow` default is still `:empty_page`, and the app keeps `:last_page`.

## Rollout and rollback

- Pagy stores nothing: no database data, no cache entries, no jobs. The only state that crosses deploys is URLs, and their parameters (`page`, `per_page`) don't change.
- Mixed-version deploys are safe once change 4 has shipped. Changes 1 to 3 have to deploy together with the gem bump, because they don't work on 8. Rolling back means reverting them together.

## Validation and remaining gaps

- **Validation:**
  - Run `bin/rails test` (variant C).
  - Run `bin/rails zeitwerk:check` (not run yet).
  - Add a test that `GET /notes?per_page=5` shows 5 notes without relying on the default settings, since variant D showed the renamed settings only fail visibly through page-count assertions.
- **Not verified:**
  - A real browser run (there are no system tests).
  - The other `bin/rails test` warning (`ExportJob` argument serialization) has nothing to do with pagy.
- **Already broken on 8.6.3 (not a regression):** `?per_page=0` raises `VariableError` on both versions, from reading the source. It's worth fixing separately.

The diff in the throwaway copy is at `/tmp/pg/copy` (`git -C /tmp/pg/copy diff`). Ignore the `config/database.yml` change there; it only renames the test database for isolation.

---

I've only planned this upgrade; your repo is unchanged. The upgrade workflow is for planning, not for applying changes. If you want me to go ahead, I'd apply the four changes plus the gem bump, add the `per_page=5` test, and run `bin/rails test` and `bin/rails zeitwerk:check`.