# pagy 8.6.3 → 9.3.5 upgrade plan

**Summary:** The upgrade cannot go in as a plain bump: the app won't boot on 9.3.5. It needs 3 required repairs (R1 to R3) and no default-related ones. With the repairs, the final check of `upgraded` (check 4) passed every step: 46 runs, 325 assertions, 0 failures, 0 errors. `base` gives the same result: 46 runs, 325 assertions, 0 failures, 0 errors. R2 and R3 work only on 9.3.5, so they must ship in the same commit as the Gemfile change. R1 also works on 8.6.3.

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-pagy`. The services are stopped and the files are kept.
- **Copies:**
  - `copies/base` is pagy 8.6.3 as it is today.
  - `copies/upgraded` is pagy 9.3.5 plus the repairs.
  - `copies/backport` is 8.6.3 plus the repairs.
- **Lock diff:** `/tmp/upgrade-lab-pagy/lock-diff.md`. Only pagy changes, from 8.6.3 to 9.3.5 (MAJOR).
- **Checks:** `checks/base/01`, `checks/upgraded/01` to `04`, `checks/backport/01`.
- **Probe:** `probe-1-base.log`, `probe-1-upgraded.log`.
- **Patch:** `/tmp/upgrade-lab-pagy/repairs.patch`.
- **Other logs:** `backport.log`, `backport-each.log`, `gem-diff.log`.

## Required changes

**R1. The page number is no longer clamped** (`app/controllers/notes_controller.rb:18`)
- **Observed** (`checks/upgraded/03`): `Pagy::VariableError: expected :page >= 1; got 0`
- **Cause:** no changelog entry covers this, so I compared the gem source.
  - 8.6.3 `backend.rb:35` used `[params[...].to_i, 1].max`.
  - 9.3.5 `backend.rb:41` uses `(page || 1).to_i`, and `shared_methods.rb:11` raises when the page is below 1.
- **Consequence if nothing is done:** `/notes?page=0`, `?page=-1`, `?page=two` or `?page=` raise an error, so readers get a 500 instead of the first page.
- **Repair:**
  ```diff
  -    @pagy, @notes = pagy(@notes)
  +    @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- **Works on the current version:** yes (`backport-each.log`).
- **Validation:** `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` fails without the repair and passes with it (check 3 → 4). It loops over `""`, `"0"`, `"-1"` and `"two"` and expects page 1. Control: the paging and overflow parts of the same test still pass (page 9 shows the last page, and per_page 500 is capped to 50).

**R2. `pagy/extras/items` and the `:items*` settings were renamed to `limit`** (`config/initializers/pagy.rb:2,6-8`)
- **Observed** (`checks/upgraded/01/boot.log`): `cannot load such file -- pagy/extras/items (LoadError)`
- **Cause:** pagy 9.0.0 "BREAKING: Rename variable, param, accessor, extra and helper 'items' to 'limit'" and "Rename :max_limit > :limit_max".
- **Consequence if nothing is done:** the app does not boot.
- **Repair:** load `pagy/extras/limit` and set `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page` and `[:limit_max] = 50` (see `repairs.patch`).
- **Works on the current version:** no, it requires the upgrade.
- **Validation:** boot fails on check 1 and passes on check 2. Control: the per_page cap of 50 test still passes, so the cap still holds.

**R3. The `@pagy.items` accessor was renamed** (`app/views/notes/index.html.erb:30`)
- **Observed** (`checks/upgraded/02`): ``ActionView::Template::Error: undefined method `items' for an instance of Pagy``
- **Cause:** the same 9.0.0 rename as R2.
- **Consequence if nothing is done:** the note list returns a 500, including the redirect page after sign-in.
- **Repair:** `options_for_select([5, 10, 25, 50], @pagy.items)` becomes `@pagy.limit`.
- **Works on the current version:** no, it requires the upgrade.
- **Validation:** 6 tests go from failing to passing (check 2 → 3), including `SessionsControllerTest#test_signing_in_with_the_correct_password_opens_the_note_list`. The `select[name=per_page] option[selected]` assertion with value "5" now passes.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 did not apply.

## Controls
- **9.3.3 `:item_name` change** (`index.html.erb:40`): the app passes an already pluralized string. Probe 1 printed the same output on both copies: "Displaying 1 note" and "Displaying 3 notes". The test's `.range` assertions also pass.
- **`overflow` extra and `pagy_url_for`:** both changed in the gem diff. The page 9 → last page test and the prev-link URL assertion pass on `upgraded`.

## Other gems that move
None. pagy is the only gem in the lock diff.

## Rollout and rollback
- No stored data is involved: no serialization, cache entries, cookies or jobs. Step 8 was not needed.
- Ship R2 and R3 together with the bump.
- R1 can be merged ahead of the bump.
- To roll back, revert the whole commit. The R2 and R3 code fails to boot or render on 8.6.3.

## Not verified
- The 9.0.0 entries about the fragment URL, `anchor_string` and keyword arguments: the app doesn't use those features (grep found nothing), so they were not probed.

---

This is only a plan. Your repository hasn't been changed. All the testing ran on copies in `/tmp/upgrade-lab-pagy`, and the combined repairs are in `/tmp/upgrade-lab-pagy/repairs.patch`. The browser suite (`bin/rails test:system`) isn't in the results above, so it should be run when the upgrade is applied. If you'd like, I can apply the bump and the three repairs to the repo next.