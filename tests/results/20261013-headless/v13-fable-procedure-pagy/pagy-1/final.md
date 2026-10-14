# pagy 8.6.3 → 9.3.5 upgrade plan

Summary: pagy cannot go in as a plain version bump. The app needs 2 changes, both shipped with the Gemfile change. The new framework defaults step did not apply, so there are 0 default-related changes. With the changes, `upgraded` passes every check: 46 runs, 325 assertions, 0 failures, 0 errors (check 03). `base` also passes: 46 runs, 325 assertions, 0 failures, 0 errors (check 01).

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-pagy`. It holds two copies:
  - `copies/base` runs pagy 8.6.3.
  - `copies/upgraded` runs pagy 9.3.5 with the changes applied.
- **Lock diff:** `/tmp/upgrade-lab-pagy/lock-diff.md`. Only pagy changes (8.6.3 → 9.3.5, MAJOR).
- **Checks:** `checks/base/01`, `checks/upgraded/01..03`
- **Probe:** `probe-1-{base,upgraded}.log`
- **Backport:** `backport.log`, `backport-each.log`
- **Gem diff:** `gem-diff.log`, `gem-source.diff`
- **Patch:** `/tmp/upgrade-lab-pagy/repairs.patch`

## Required changes

**R1. Rename "items" to "limit"** (`config/initializers/pagy.rb:2,6-8`, `app/views/notes/index.html.erb:30`)
- **Observed** (`checks/upgraded/01/boot.log`):
  `config/initializers/pagy.rb:2:in '<main>': cannot load such file -- pagy/extras/items (LoadError)`
- **Consequence if nothing is done:** the app does not boot at all.
- **Cause:** pagy 9.0.0 "BREAKING: Rename variable, param, accessor, extra and helper 'items' to 'limit'" and "Rename :max_limit > :limit_max".
- **Repair:**
  ```
  -require "pagy/extras/items"
  +require "pagy/extras/limit"
  -Pagy::DEFAULT[:items] = 10
  -Pagy::DEFAULT[:items_param] = :per_page
  -Pagy::DEFAULT[:max_items] = 50
  +Pagy::DEFAULT[:limit] = 10
  +Pagy::DEFAULT[:limit_param] = :per_page
  +Pagy::DEFAULT[:limit_max] = 50
  ```
  In the view: `-@pagy.items)` / `+@pagy.limit)`
- **Works on the current version:** no. `backport-each.log` shows both files fail on 8.6.3 ("cannot load such file -- pagy/extras/limit"), so this ships in the same commit as the Gemfile bump.
- **Validation:**
  - Fails without it: check 01 fails at boot. With it, boot, eager load and production boot pass (check 02).
  - Control: `test_invalid_pages_..._capped_at_50` checks that `per_page=500` is capped at 50 and that `per_page=50` survives in the prev link. It passes in check 03.

**R2. Invalid `page` parameter now raises** (`app/controllers/notes_controller.rb:18`)
- **Observed** (`checks/upgraded/02/`): `Pagy::VariableError: expected :page >= 1; got 0`, raised from `notes_controller.rb:18` and the gem's `pagy-9.3.5/lib/pagy/shared_methods.rb:11`.
- **Consequence if nothing is done:** `GET /notes?page=` (also `page=0`, `-1` or `two`) returns a 500 instead of the first page.
- **Cause:** no changelog entry explains it. In the gem source, 8.6.3's `pagy_get_page` returned `[params[...].to_i, 1].max`. 9.3.5 returns `(page || 1).to_i`, which no longer clamps the value to at least 1.
- **Repair:**
  ```
  -    @pagy, @notes = pagy(@notes)
  +    @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- **Works on the current version:** yes (`backport-each.log`), so it can land before the bump.
- **Validation:**
  - Fails without it: `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` fails in check 02 and passes in check 03 ("1 newly passing").
  - Controls: the other 45 tests are unchanged. That includes the overflow `:last_page` assertion (`per_page=50&page=9` shows "51-52 of 52").

## Default-related changes
None. pagy is not a framework and `changes.md` has no "New framework defaults" section.

## Other gems that move
None. pagy itself is the only MAJOR change, and the dry `bundle lock` run moved no other gem.

## Rollout and rollback
- **Matrix (step 8):** not run. The notes contain no entries about serialization, cookies, cache entries or jobs, and pagy only reads request parameters.
- **Order:** R2 can deploy first on 8.6.3. R1 has to ship in the same commit as the Gemfile bump.
- **Rollback:** reverting that commit is enough. No stored data is involved.
- **URLs:** the `per_page` parameter name is unchanged (`limit_param: :per_page`), so existing bookmarks keep working.

## Controls and coverage
- **`item_name` change (9.3.3)** at `index.html.erb:40`: the probe printed identical `pagy_info` output on both copies for counts 0, 1 and 2 ("No notes found", "Displaying 1 note", "Displaying 2 notes"). Logs: `probe-1-*.log`. No finding.
- **Gem files the app calls:** the gem diff changes `backend.rb` (R2), `extras/limit.rb` (R1), `extras/overflow.rb` and `frontend.rb` (`pagy_url_for`, `pagy_info`). The note-list controller tests cover all of these and they pass in check 03.

## Not verified
- None of the remaining removals from 9.0.0–9.3.4 match anything the app uses, so they were not grepped individually. They cover keyset, `after_latest`, `typecast_latest`, `anchor_string`, the fragment URL, `pagy_link_header`, JavaScript files and `pagy*_get_vars`; the app uses only the `limit` and `overflow` extras, `pagy`, `pagy_info` and `pagy_url_for`.
- Browser system tests were not run, because the lab check runs `bin/rails test` only.

---

I haven't changed your repository yet. The upgrade skill only produces a plan, and the work above was done on copies in `/tmp/upgrade-lab-pagy`. Two things to note before applying it:

- **Without R2, empty or invalid `page` values become a 500 error.** Nothing in pagy's changelog mentions this; it was found by comparing the gem's source between versions, so it's easy to miss.
- **The browser suite (`bin/rails test:system`) wasn't run on the upgraded copy.** It should be run after applying the changes.

If you want, I can apply the bump plus R1 and R2 to your repository and run both test suites.