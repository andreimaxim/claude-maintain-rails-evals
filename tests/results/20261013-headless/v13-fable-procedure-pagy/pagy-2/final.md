# pagy 8.6.3 → 9.3.5 upgrade plan

Summary: a plain version bump does not work. On 9.3.5 the app fails at boot. It needs 2 required repairs, R1 and R2, spread over 3 files. There are no repairs tied to new defaults, because pagy has no framework-defaults mechanism. With the repairs, the final check of `upgraded` (check 03) passes every step: 46 runs, 325 assertions, 0 failures, 0 errors. `base` gives the same result: 46 runs, 325 assertions, 0 failures, 0 errors.

## Setup and evidence
- Lab directory: `/tmp/upgrade-lab-pagy`.
- Copies:
  - `copies/base` runs pagy 8.6.3.
  - `copies/upgraded` runs 9.3.5 with the repairs applied.
  - `copies/backport` holds the repairs on 8.6.3.
- Lock diff (`/tmp/upgrade-lab-pagy/lock-diff.md`): only pagy changes, 8.6.3 → 9.3.5, a MAJOR version change.
- Check logs: `/tmp/upgrade-lab-pagy/checks/upgraded/01..03/`, `checks/base/01/`, `checks/backport/`.
- Probe logs: `/tmp/upgrade-lab-pagy/probe-1-{base,upgraded}.log`.
- Patch: `/tmp/upgrade-lab-pagy/repairs.patch`. Changes file: `/tmp/upgrade-lab-pagy/changes.md`. Notes: `/tmp/upgrade-lab-pagy/notes.md`.

## Required changes

**R1. Rename "items" to "limit"** (`config/initializers/pagy.rb:2,6-8`, `app/views/notes/index.html.erb:30`)
- Observed errors, in two stages:
  - Boot failed: `cannot load such file -- pagy/extras/items (LoadError)` (`checks/upgraded/01/`).
  - After the initializer was fixed, 6 tests failed with `ActionView::Template::Error: undefined method `items' for an instance of Pagy` at `index.html.erb:30` (`checks/upgraded/02/`).
- Cause: pagy 9.0.0 [removal], "BREAKING: Rename variable, param, accessor, extra and helper "items" to "limit"". The same release renamed `:max_limit` to `:limit_max`.
- Repair: `require "pagy/extras/limit"`, then set `Pagy::DEFAULT[:limit]`, `[:limit_param]` and `[:limit_max]`, and change the view to use `@pagy.limit`. The full hunks are in `repairs.patch`.
- Works on the current version: **no**. Both files fail on 8.6.3 (`backport-each.log`), so this ships in the same commit as the Gemfile change.
- Consequence if nothing is done: the app does not boot.
- Validation:
  - Fails without the repair: boot (check 01). Then these 6 tests, among others: `NotesControllerTest#test_lists_the_reader's_notes_newest_first_at_both_list_paths`, `#test_filters_by_notebook,_status,_and_title`, `SessionsControllerTest#test_signing_in_with_the_correct_password_opens_the_note_list`.
  - Passes with it: check 03.
  - Control: the per-page cap of 50 is still asserted in `test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50`, and passes.

**R2. Blank or invalid `page` values are no longer clamped to 1** (`app/controllers/notes_controller.rb:18`)
- Observed error: `Pagy::VariableError: expected :page >= 1; got 0` (`checks/upgraded/02/`, `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50`).
- Cause: no changelog entry names this. The installed source shows the change in the backend:
  - 8.6.3 `pagy_get_page` did `[params[...].to_i, 1].max`.
  - 9.3.5 does `(page || 1).to_i`, so `""`, `"0"`, `"-1"` and `"two"` produce 0 or a negative number, and `Pagy.new` raises.
- Repair:
  ```
  -    @pagy, @notes = pagy(@notes)
  +    @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- Works on the current version: **yes** (`backport-each.log`).
- Consequence if nothing is done: `/notes?page=0`, `?page=`, `?page=-1` or `?page=two` returns a 500 instead of the first page.
- Validation: the test above fails without the repair and passes with it in check 03. Control: the overflow cases (`per_page=50&page=9` shows the last page) pass in the same test.

Note: I applied the view part of R1 and R2 before the same check (03), so the "7 newly passing" line in that check covers both repairs together.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so I skipped step 7.

## Other gems that move
None. Only pagy changes, and it has no new dependencies.

## Rollout and rollback
- pagy stores nothing: no serialization, cookies, cache entries or job arguments are involved, so I skipped the step-8 matrix.
- R1 needs the upgrade and ships together with the Gemfile bump.
- R2 can ship first. It is harmless on 8.6.3.
- Rollback means reverting the whole commit. No data is affected in either direction.

## Not verified / controls
- **pagy 9.3.3 `item_name` change:** this is a control, not a finding. A probe calling `pagy_info` with counts 0, 1, 2 and 30 printed identical output on base and upgraded (`probe-1-*.log`), for example "Displaying 1 note" and "Displaying notes 1-10 of 30 in total".
- **Other 9.x removals:** I grepped for the keywords of `limit_max`, `after_latest`, `typecast_latest`, `link_header`, `get_vars`, the foundation, materialize, semantic and uikit extras, and the anchor and fragment refactor. None appear in the app.
- **Gem source diff:** `url_helpers.rb` (`pagy_url_for`) and `extras/overflow.rb` changed. Existing tests assert the prev-link query (`per_page=50&page=1`) and the overflow-to-last-page behaviour, and both pass on upgraded.

The lab services are stopped and the files are kept in `/tmp/upgrade-lab-pagy`.

---

This is only a plan. I haven't changed your repository: the Gemfile, lockfile and app code are untouched. The planner tested the upgrade on separate copies in `/tmp/upgrade-lab-pagy`. With both repairs on 9.3.5 the suite passed (46 runs, 0 failures), the same result as on 8.6.3. That run covered `bin/rails test` only; the plan doesn't say the browser tests (`bin/rails test:system`) were run.

I can apply the upgrade here if you want. That means bumping pagy, applying `repairs.patch`, and running both test suites.