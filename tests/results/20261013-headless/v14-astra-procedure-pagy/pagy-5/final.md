# Upgrade plan: pagy 8.6.3 to 9.3.5 (Margin Notes)

The upgrade needs two code changes, and both must ship in the same commit as the Gemfile and Gemfile.lock bump. Without them, the app fails to start on 9.x and some page links return a 500 error. I made both changes in a copy of the app on 9.3.5. That copy passes startup, `db:prepare`, eager loading, routes, the existing test suite (46 runs, 0 failures) and a 6-test probe suite. The original checkout was not changed; the lab confirmed its source hashes are the same.

## Required

**F1. Rename "items" to "limit" (the app fails to start on 9.x without this)**
- **Problem:** pagy 9.0 renamed "items" to "limit" everywhere. On every 9.x release I sampled, startup fails with `cannot load such file -- pagy/extras/items (LoadError)` from `config/initializers/pagy.rb:2`.
- **Partial fix is worse:** if only the `require` line is changed, the old settings are silently ignored. Pages would show 20 notes instead of 10, the `per_page` parameter would be ignored, and the cap would be 100 instead of 50.
- **Repair in `config/initializers/pagy.rb`:**
  - `require "pagy/extras/limit"`
  - `Pagy::DEFAULT[:limit] = 10`
  - `Pagy::DEFAULT[:limit_param] = :per_page`
  - `Pagy::DEFAULT[:limit_max] = 50`
  - leave `:overflow = :last_page` as it is.
- **Repair in `app/views/notes/index.html.erb:30`:** change `@pagy.items` to `@pagy.limit`.
- **What I checked:** with the repair, 9.3.5 gives the same output as 8.6.3:
  - `per_page=25` shows 25 notes, and the Next link keeps `per_page=25`.
  - `per_page=500` is capped at 50.
  - With no parameters, the page shows 10 notes and the Next link is `page=2&per_page=10`.
  - `page=999` shows the last page.
- **Rollback:** these changes don't work on 8.6.3, so revert them together with the gem bump. The URL parameter is still called `per_page`, so bookmarks work in both directions.

**F2. Invalid `?page` values now cause a 500 error (not in the changelog; found in the code diff)**
- **Problem:** pagy 9 no longer turns a bad page number into page 1. For page values `""`, `"0"`, `"-1"` and `"two"`, 9.3.5 raises `Pagy::VariableError: expected :page >= 1; got 0`, and the overflow setting does not catch it.
- **Effect on tests:** the existing test `test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` errors (46 runs, 1 error).
- **Repair:** add a private override in `NotesController`:
  ```ruby
  def pagy_get_page(vars, force_integer: true)
    force_integer ? [super, 1].max : super
  end
  ```
- **What I checked:** with the override, all four values return page 1 with "Displaying notes 1-10 of 32 in total", the same as 8.6.3. The full suite passes.
- **Not run:** I did not run the override on 8.6.3. It is only meant to ship with the bump.

## Rollout notes (no code change required)
- **F3:** bad `per_page` values (`""`, `0`, `abc`, `-5`) already raise an error on 8.6.3. That is existing behaviour, not a new problem. Only the message changes, from `:items >= 1` to `:limit >= 1`, so update any alert rules or error groupings that match the old text.
- **F4:** a 9.3.3 change to the default "item" wording does not affect this app, because the notes page passes its own wording. The text is the same on both versions: "Displaying 1 note" and "Displaying 9 notes".

## Other dependencies, defaults and stored data
- pagy is the only gem whose version changed in the lockfile, and the dependency check found nothing to research.
- The sources listed no framework defaults to decide on.
- pagy keeps no state in cookies, caches, the database or queued jobs, so there is nothing to check between old and new versions.

## Limits
- **Wrong guide collected:** the only guide fetched was pagy's "migrate from other gems" page, not an 8-to-9 upgrade guide. I relied on the changelog and the code diff instead.
- **In-between versions:** 9.0.9, 9.1.1 and 9.2.2 only reached startup, which failed with the same error. I ran the repaired code only on 9.3.5.
- **Browser tests not run:** `bin/rails test:system` needs Chrome and a display, so the page-size dropdown has not been checked in a browser.
- **Production services not run:** I only ran the test environment. Redis, Sidekiq and the citation provider were not exercised, but pagy doesn't use them.
- **Ruby setup:** the `ruby` shim had no version set, so I ran every script through `mise exec ruby@3.3.6`.

## Files
- Plan data: `/tmp/gem-upgrade-20261014-71536-njvjq4/plan.json`
- Probe: `/tmp/gem-upgrade-20261014-71536-njvjq4/probes/pagination_probe_test.rb`
- Run records: `/tmp/gem-upgrade-20261014-71536-njvjq4/runs/{baseline,v9_3_5,v9_3_5_fixed,v9_3_5_fixed_page}/`
  - `v9_3_5_fixed` has only the F1 renames; `v9_3_5_fixed_page` has both repairs.
- Repaired copy: `/tmp/gem-upgrade-20261014-71536-njvjq4/variants/v9_3_5_fixed_page/app`
- Sources: `/tmp/gem-upgrade-20261014-71536-njvjq4/sources/index.md`, with the code diff at `/tmp/gem-upgrade-20261014-71536-njvjq4/sources/repositories/59ffd940c63a/range.patch`
- Dependency check: `/tmp/gem-upgrade-20261014-71536-njvjq4/dependencies-v9_3_5/`

The lab's test databases have been dropped; the copies and logs are kept.

---

That's the plan only. Your repo is still on pagy 8.6.3 and nothing in it has changed. To apply it, put the Gemfile/lockfile bump, the F1 renames and the F2 controller override in a single commit, then run `bin/rails test:system` somewhere with Chrome, since the browser tests weren't run. I can make those changes if you want.