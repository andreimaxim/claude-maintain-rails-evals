Here is the upgrade plan for pagy 8.6.3 → 9.3.5. I haven't changed your repo. The planner made the changes and ran the tests in throwaway copies under `/tmp/pg`.

---

The upgrade from pagy 8.6.3 to 9.3.5 is small, but the app won't start without code changes. It needs three edits, which I've applied and tested in a disposable copy. Your working repo was not modified (`git status` is clean).

## How I tested it
- **Change index:** `ruby /home/user/planner-run/maintain-rails/bin/gem-changes pagy 8.6.3 9.3.5`, saved to `/tmp/pg/changes.txt`. It read releases 9.0.9, 9.1.1, 9.2.2 and 9.3.5 but found **0 changelog entries**, because pagy doesn't ship a changelog in the gem. So the findings below come from comparing the installed 8.6.3 and 9.3.5 gem source and from running the app, not from release notes. I didn't read the upstream upgrade guide or release notes. That means I can't say which 9.x release made each change, only that 9.3.5 has it.
- **Copy:** `/tmp/pg/app`, with `bundle update pagy --conservative` (log: `/tmp/pg/bundle.log`). The only lockfile change was pagy 8.6.3 → 9.3.5 (Rails 7.0.8.7).
- **Isolation:** the copy's `config/database.yml` pointed at `margin_notes_pagy9exp_test` / `_dev`. The test environment already uses `:null_store` cache, the `:test` queue adapter and Disk storage inside the copy. I dropped the experiment databases afterwards.
- **Second copy:** `/tmp/pg/app8` stayed on 8.6.3 (database `margin_notes_pagy8exp_test`) to check that the fix for finding 2 also works on the current version.

## Required changes

**1. The app won't boot: the `items` extra and its settings were renamed to `limit`**
- **Affected code:** `config/initializers/pagy.rb`.
- **What happens if nothing is done:** every boot fails with `cannot load such file -- pagy/extras/items (LoadError)` (log: `/tmp/pg/test9.log`). The 9.3.5 gem has `extras/limit.rb` and no `items.rb`.
- **Fix:** replace the initializer's settings with these:
  - `require "pagy/extras/limit"`
  - `Pagy::DEFAULT[:limit] = 10`
  - `Pagy::DEFAULT[:limit_param] = :per_page`
  - `Pagy::DEFAULT[:limit_max] = 50` (note: `limit_max`, not `max_limit`)
  - Keep `overflow` and `:last_page` as they are.
- **Why the setting names matter:** if the old keys were kept, the extra's own defaults would silently apply instead: the `limit` param name, a cap of 100, and the default limit of 20. Those defaults come from 9.3.5's `lib/pagy/extras/limit.rb` lines 7–8 and `lib/pagy.rb`.
- **Bookmarks and links:** keeping `limit_param = :per_page` means existing bookmarks, links and the form's `per_page` field keep working.
- This only works on 9.x, so it has to ship in the same deploy as the gem bump.

**2. Blank, zero, negative or non-numeric `page` values now cause errors**
- **Affected code:** `NotesController#index` (`pagy(@notes)`).
- **The change:** in 8.6.3, `pagy_get_page` returned `[params[:page].to_i, 1].max`. In 9.3.5 it returns `(page || 1).to_i` (see `backend.rb:39-42`). So `?page=`, `0`, `-1` or `two` become 0 or negative.
- **What happens if nothing is done:** `Pagy::VariableError: expected :page >= 1; got 0`. The `overflow` extra doesn't catch this error, so it would be a 500 in production. The existing test `test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` catches it (`/tmp/pg/test9a.log`).
- **Fix:** `@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)`. Both versions use `vars[:page] ||= pagy_get_page(vars)`, so passing the page explicitly works on both.
- **Checked on 8.6.3:** this change alone passes the full suite (46 runs, 0 failures; `/tmp/pg/test8prep.log`). It can be merged before the gem bump.
- **Alternative not recommended:** overriding `pagy_get_page`. Its signature changed (9.x adds `force_integer:`), so it wouldn't work on both versions.

**3. `Pagy#items` was removed and the view now errors**
- **Affected code:** `app/views/notes/index.html.erb:30`.
- **What happens if nothing is done:** `ActionView::Template::Error: undefined method 'items' for an instance of Pagy` on every notes list render, including when the list is empty.
- **Fix:** change `@pagy.items` to `@pagy.limit`. This only works on 9.x, so it ships with the bump.

**After all three fixes:** the full 9.3.5 suite passes (`46 runs, 325 assertions, 0 failures, 0 errors`; `/tmp/pg/test9b.log`). That includes the tests that check the filters and `per_page` are kept in prev/next links, that the page size is capped at 50, and that a page past the end shows the last page.

## Unchanged and checked
- **`pagy_info(@pagy, item_name:)`:** the signature is unchanged in 9.3.5 (`frontend.rb:31`), and the `.range` text assertions pass.
- **`pagy_url_for(pagy, page)`:** still accepts this call (`url_helpers.rb:9`).
- **`pages`, `prev`, `next`, `count`:** all still work, and the tests pass.

## New defaults
Pagy has no versioned framework-defaults mechanism. The only defaults that changed are the extra's own: the `limit` param name, `limit_max` 100, and `limit_extra` true. The app sets every one of these explicitly except `limit_extra`, whose default (true) is the behavior it needs. There's nothing optional to adopt.

## Existing bug, same on both versions (not caused by the upgrade)
`?per_page=0`, `abc` or `-5` raise `Pagy::VariableError` on 8.6.3 (`expected :items >= 1`) and 9.3.5 (`expected :limit >= 1`) alike, so production returns a 500. I confirmed this with a temporary integration test run in both copies. Fixing it is a separate decision. One option is to also pass a clamped `limit:` from the controller, but that bypasses the extra's cap, so the 50 maximum would have to be applied there too.

## Rollout
- **Stored data and queued work:** nothing pagy-related is stored or queued, and the URL parameter names are unchanged, so old and new versions build the same links.
- **Order:**
  1. Ship finding 2 first. It works on 8.6.3 and is safe to roll back.
  2. Ship the gem bump together with findings 1 and 3. They can't be split, because the 9.x code won't load on 8.x and the reverse.
- **Rollback:** revert that second deploy as a whole.

## Not verified
- **Browser:** there are no system tests (`bin/rails test:system` ran 0 tests; `/tmp/pg/sys9.log`), and I didn't do a manual browser check.
- **Release notes:** I didn't consult the upstream release notes or upgrade guide, so which 9.x release introduced each change is still unconfirmed.

Experiment copies are in `/tmp/pg/app` (the full patched diff, plus the copy's database.yml) and `/tmp/pg/app8`.

---

The `Gemfile` pins pagy exactly at `"8.6.3"`, so the version there needs changing to `"9.3.5"` before running `bundle update pagy --conservative`. If you'd like, I can make the page-param change first and then the gem bump with the two 9.x-only fixes, in that order.