# pagy 8.6.3 → 9.3.5 upgrade plan

Summary: This is not a plain bump. With only the version change, the app fails to boot. It needs 3 repairs; no repairs relate to new defaults. After the repairs, the final check of `upgraded` passes every step, with 46 runs, 325 assertions, 0 failures and 0 errors. `base` gives the same result: 46 runs, 325 assertions, 0 failures and 0 errors. Two of the repairs only work on pagy 9, so they must ship in the same commit as the Gemfile change.

## Setup and evidence
- Lab: `/tmp/upgrade-lab-pagy`. The copies are:
  - `copies/base`: pagy 8.6.3, unchanged.
  - `copies/upgraded`: pagy 9.3.5 plus the repairs.
  - `copies/backport*`: the repairs applied on 8.6.3.
- Lock diff: `/tmp/upgrade-lab-pagy/lock-diff.md`. Only pagy changes (8.6.3 → 9.3.5, MAJOR).
- Check logs:
  - `checks/upgraded/01`: boot fails.
  - `checks/upgraded/02`: 7 test errors.
  - `checks/upgraded/03`: all steps ok.
  - `checks/base/01`: all steps ok.
- Probe logs: `probe-1-base.log`, `probe-1-upgraded.log`.
- Backport logs: `backport.log`, `backport-each.log`.
- Gem diff: `gem-diff.log`, `gem-source.diff`.
- Patch: `/tmp/upgrade-lab-pagy/repairs.patch`. It also changes the `Gemfile` pin from `"8.6.3"` to `"9.3.5"`.

## Required changes

**R1. The `items` extra was renamed to `limit`** (`config/initializers/pagy.rb:2,6-8`)
- **Observed error:** `cannot load such file -- pagy/extras/items (LoadError)` from `config/initializers/pagy.rb:2` (`checks/upgraded/01/boot.log`).
- **Cause:** pagy 9.0.0 "BREAKING: Rename variable, param, accessor, extra and helper 'items' to 'limit'" and "Rename :max_limit > :limit_max".
- **Consequence if nothing is done:** the app does not boot at all.
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
- **Works on the current version:** no. The backport fails with `cannot load such file -- pagy/extras/limit` (`backport.log`).
- **Validation:**
  - Boot goes from FAIL (check 01) to ok (check 02).
  - `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` still checks that `per_page=500` is capped at 50 and that the prev link keeps `per_page=50`. It passes in check 03.

**R2. The `Pagy#items` accessor was removed** (`app/views/notes/index.html.erb:30`)
- **Observed error:** `ActionView::Template::Error: undefined method 'items' for an instance of Pagy` in 6 tests (`checks/upgraded/02/summary.md`).
- **Cause:** the same pagy 9.0.0 rename of `items` to `limit`.
- **Consequence if nothing is done:** the notes list (`GET /notes`) returns a 500 error, including the page shown right after sign-in.
- **Repair:**
  ```
  -options_for_select([5, 10, 25, 50], @pagy.items)
  +options_for_select([5, 10, 25, 50], @pagy.limit)
  ```
- **Works on the current version:** no (`backport-each.log`: "index.html.erb: FAILS on the current version").
- **Validation:**
  - These tests fail in check 02 and pass in check 03: `SessionsControllerTest#test_signing_in_with_the_correct_password_opens_the_note_list`, `NotesControllerTest#test_renders_an_unbound_search_form`, `#test_filters_by_notebook,_status,_and_title`, `#test_shows_an_empty_state_when_nothing_matches`, `#test_pages_through_filtered_notes_newest_first,_keeping_the_filters_and_page_size`, and 1 more.
  - The last of those asserts `select[name=per_page] option[selected]` is "5".

**R3. An invalid `page` parameter now raises instead of being treated as page 1** (`app/controllers/notes_controller.rb:18`)
- **Observed error:** `Pagy::VariableError: expected :page >= 1; got 0` (`checks/upgraded/02/summary.md`), from the test that sends `page` as `""`, `"0"`, `"-1"` and `"two"`.
- **Cause:** no changelog entry names this. The gem source explains it:
  - 8.6.3 `Backend#pagy_get_page` returned `[params[...].to_i, 1].max`, so bad values became page 1.
  - 9.3.5 returns `(page || 1).to_i`, and `SharedMethods#assign_and_check` then raises when the page is below 1.
- **Consequence if nothing is done:** a URL such as `/notes?page=0` or `?page=abc` (a stale or hand-edited link) returns a 500 error instead of page 1.
- **Repair:**
  ```
  -    @pagy, @notes = pagy(@notes)
  +    @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- **Works on the current version:** yes (`backport-each.log`), so it can ship ahead of the upgrade.
- **Validation:**
  - `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` fails in check 02 and passes in check 03.
  - Control: the same test's `per_page=50, page=9` request still lands on the last page (overflow `:last_page`), showing "Displaying notes 51-52 of 52 in total".

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 was skipped.

## Other gems that move
None. pagy is the only gem that changes in the lock. It goes up a major version and has no new dependencies.

## Rollout and rollback
- pagy stores nothing: no serialized data, cache entries, cookies or job arguments. Step 8 had nothing to test, so there is no matrix finding.
- R3 can be deployed first, on 8.6.3.
- R1, R2 and the Gemfile/Gemfile.lock bump must ship together in one commit.
- Rolling back means reverting that whole commit. The URL parameter (`per_page`) is the same on both versions, so existing links and bookmarks keep working in either direction.

## Not verified
- **9.3.3 change: `:item_name` with one/other keys now defaults to the `:other` key** (`index.html.erb:40`). This is a control, not a finding. The probe `pagy_info` for counts 0, 1 and 3 gives the same output on both copies ("No notes found", "Displaying 1 note", "Displaying 3 notes"; `probe-1-*.log`). The app passes a plain string, so the change does not affect it.
- **Gem files changed that the app calls** (`backend.rb`, `frontend.rb`, `extras/overflow.rb`, `extras/limit.rb`). The controller tests reach `pagy_url_for`, `pagy_info`, overflow `:last_page` and the `limit_max` cap, and all pass. No separate probe was needed.
- **Other 9.x removals** (`pagy*_get_vars`, `after_latest`, anchor/fragment refactor, link header, keyword-argument vars): a grep of the app found no use of any of them.

---

I've only planned the upgrade so far; your repo hasn't changed. Pagy is pinned to 8.6.3 in `Gemfile.lock`. The tested patch, including the Gemfile pin change, is at `/tmp/upgrade-lab-pagy/repairs.patch`. Do you want me to apply it, run `bin/rails test` and `bin/rails test:system` (the plan's figures cover only the main suite), and commit on a new branch?