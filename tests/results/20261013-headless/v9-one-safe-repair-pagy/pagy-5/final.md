The upgrade from pagy 8.6.3 to 9.3.5 is small, but the app won't boot without code changes. Three changes are required, in three files. With them in a disposable copy, all 46 tests pass and `zeitwerk:check` passes. The suite has no system tests, so nothing was checked in a browser.

**How this was checked.** `gem-changes` read no release notes: pagy doesn't package a changelog, so it matched 0 entries (`/tmp/pg/changes.txt`). Everything below comes from comparing the installed source of pagy 8.6.3 and 9.3.5, plus experiments. I did not fetch the upstream 9.x release notes or upgrade guide.

**Experiments.** The copies were `/tmp/pg/app` (pagy 9.3.5, from `bundle update pagy --conservative`; only pagy changed in the lockfile) and `/tmp/pg/base` (pagy 8.6.3). Each had its own PostgreSQL test database (`margin_notes_pagy9_test` and `margin_notes_pagy8_test`), dropped afterwards. The test environment already uses a null cache store, the `:test` queue adapter and test storage. The repository was not modified.

## Required changes

**1. Boot failure: the `items` extra was renamed.** `config/initializers/pagy.rb:2` requires `pagy/extras/items`, which no longer exists in 9.x. The app does not boot at all; `db:prepare` and every test fail with:
`cannot load such file -- pagy/extras/items (LoadError)` (`/tmp/pg/dbprep.log`, `/tmp/pg/test9.log`).
- **Fix:** `require "pagy/extras/limit"`.

**2. Settings renamed. Old names are ignored without any warning.** In 9.x, `DEFAULT[:items]` becomes `:limit`, `:items_param` becomes `:limit_param`, and `:max_items` becomes `:limit_max`. Note it is `limit_max`, not `max_limit`.
- **Fix:** use these in the initializer:
  ```ruby
  Pagy::DEFAULT[:limit] = 10
  Pagy::DEFAULT[:limit_param] = :per_page
  Pagy::DEFAULT[:limit_max] = 50
  ```
- **If the old names are kept,** the app boots but the defaults become pagy's own: 20 per page, a `?limit=` URL parameter, and a cap of 100. Existing `?per_page=` bookmarks would then be ignored.
- **Evidence that tests can miss this:** with `:max_limit` misspelled, `per_page=100` showed "Displaying 62 notes" (cap 100) instead of "notes 1-50 of 62". Only the cap test in `notes_controller_test.rb:74` catches this.

**3. `@pagy.items` no longer exists.** `app/views/notes/index.html.erb:30` raises:
`ActionView::Template::Error: undefined method 'items' for an instance of Pagy`
This breaks the notes list and the redirect after sign-in.
- **Fix:** `@pagy.limit`.

**4. Invalid page numbers now cause a 500.** In 8.6.3 the page number was clamped to at least 1. In 9.x it is passed through as given, so `?page=`, `page=0`, `-1` or `two` (stale or hand-edited links) raise:
`Pagy::VariableError: expected :page >= 1; got 0`
Without overflow handling this is a 500. The test at `notes_controller_test.rb:74` caught it.
- **Recommended fix:** in `app/controllers/notes_controller.rb:18`, use `pagy(@notes, page: [params[:page].to_i, 1].max)`.
  - This works on 8.6.3 too, so it can ship ahead of the upgrade. In `/tmp/pg/base`, 46 runs passed (`/tmp/pg/test8_prep.log`).
  - On 9.3.5, page numbers past the end still go to the last page, keeping `per_page` in the links. Valid pages and filters are unchanged.
- **Alternative (not recommended):** override `pagy_get_page`. Its signature changed to `(vars, force_integer: true)` in 9.x, so the same override wouldn't fit both versions.

The full candidate change is in `/tmp/pg/candidate.diff`; the passing run is `/tmp/pg/test9_fixed.log`.

## Unchanged behaviour (checked with a probe test)

Output is in `/tmp/pg/probe8.txt` and `/tmp/pg/probe9.txt`; the results match on both versions:
- **Size cap:** `per_page=100` shows 50 notes.
- **Past the end:** `page=99&per_page=25` shows the last page, and the previous link is `/notes?page=2&per_page=25`.
- **Info line:** the `pagy_info` text is the same.
- **Already broken before the upgrade:** `per_page=0` and `per_page=abc` raise `Pagy::VariableError: expected :limit >= 1; got 0` (it was `:items` in 8.6.3). The upgrade doesn't introduce this. An optional fix is to clamp `per_page` the same way as `page`.

## New defaults

pagy has no versioned framework defaults like Rails' `load_defaults`. The 9.x changes that act like new defaults are the renamed keys above. They come with new built-in values (`limit` 20, `limit_param :limit`, `limit_max` 100), which this app overrides once the initializer uses the new names. The page-number change (finding 4) is not a setting. There's nothing optional to adopt for the features this app uses. I did not review extras the app doesn't use, such as keyset.

## Rollout and rollback

- Nothing is stored or queued: pagy state lives only in the URL (`page`, `per_page`), and the parameter names stay the same. Bookmarks keep working, and mixed old and new servers are safe.
- Rollback means reverting the Gemfile, initializer and view together. Any partial mix fails to boot or render, as findings 1 and 3 show.
- Ship the page-clamping change (4) first, since it's safe on 8.6.3.

## Not verified

- The upstream 9.0–9.3 release notes and upgrade guide. Each intermediate release was not checked separately; only the 9.3.5 source was compared with 8.6.3.
- Production-only behaviour such as caching.
- Browser behaviour.

---

This is only a plan, from a planning agent that tested in throwaway copies. I haven't changed your repository: `Gemfile` still pins `pagy "8.6.3"`, and the upgrade skill doesn't make the change. If you want me to go ahead, I'd change the Gemfile pin to 9.3.5, update the lockfile, and make the four changes above. The page clamp could go in as a separate commit first. Then I'd run `bin/rails test` and `bin/rails zeitwerk:check`.