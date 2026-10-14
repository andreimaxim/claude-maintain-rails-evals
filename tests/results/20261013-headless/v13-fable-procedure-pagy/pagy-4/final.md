# pagy 8.6.3 → 9.3.5 upgrade plan

**Summary:** This can't go in as a plain version bump. It needs 3 small repairs to the application, and none relate to new defaults. Without them the app won't boot. With the repairs, `upgraded` check 4 passes every step: 46 runs, 325 assertions, 0 failures, 0 errors. `base` gives the same result: 46 runs, 325 assertions, 0 failures, 0 errors. Two of the repairs only work with pagy 9, so they must ship in the same commit as the Gemfile change.

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-pagy`. It has two copies: `copies/base` (pagy 8.6.3) and `copies/upgraded` (pagy 9.3.5 plus the repairs). Its services are now stopped.
- **Lock diff:** `/tmp/upgrade-lab-pagy/lock-diff.md`. Only one gem changes: `pagy 8.6.3 → 9.3.5`, a major version.
- **Changes summary and notes:** `/tmp/upgrade-lab-pagy/changes.md` and `/tmp/upgrade-lab-pagy/notes.md`.
- **Checks:** `/tmp/upgrade-lab-pagy/checks/upgraded/01` to `04`, and `checks/base/01`.
- **Probe:** `/tmp/upgrade-lab-pagy/probe-1-{base,upgraded}.log`.
- **Backport:** `/tmp/upgrade-lab-pagy/backport.log` and `backport-each.log`.
- **Gem diff:** `/tmp/upgrade-lab-pagy/gem-diff.log`.
- **Patch:** `/tmp/upgrade-lab-pagy/repairs.patch`. It covers the Gemfile, the initializer, the view and the controller.

## Required changes

**R1. The `items` extra and settings were renamed to `limit`** (`config/initializers/pagy.rb:2,6-8`)
- **Observed** in `checks/upgraded/01/boot.log`: `cannot load such file -- pagy/extras/items (LoadError)` from `config/initializers/pagy.rb:2`.
- **Cause:** pagy 9.0.0 has a breaking change: "Rename variable, param, accessor, extra and helper "items" to "limit"" and "Rename :max_limit > :limit_max".
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
- **If nothing is done:** the app does not boot at all.
- **Works on the current version:** no. The backport check fails on 8.6.3 with `cannot load such file -- pagy/extras/limit`. This ships with the bump.
- **Validation:**
  - Fails without the repair: the boot step fails in check 01 and passes in check 02.
  - Control: `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` passes in check 04. It confirms that `per_page=500` is still capped at 50 and that the `per_page` parameter is still used in links.

**R2. The `Pagy#items` accessor was removed** (`app/views/notes/index.html.erb:30`)
- **Observed** in `checks/upgraded/02/summary.md`, across 6 tests: `ActionView::Template::Error: undefined method `items' for an instance of Pagy`.
- **Cause:** the same pagy 9.0.0 rename as R1.
- **Repair:**
  ```
  -    <%= form.select :per_page, options_for_select([5, 10, 25, 50], @pagy.items) %>
  +    <%= form.select :per_page, options_for_select([5, 10, 25, 50], @pagy.limit) %>
  ```
- **If nothing is done:** the note list (`/notes`) returns a 500 error, including the redirect target after sign-in.
- **Works on the current version:** no. The backport per-file table says the view "FAILS on the current version".
- **Validation:**
  - Fails without the repair: 6 tests that failed in check 02 pass in check 03, among them `SessionsControllerTest#test_signing_in_with_the_correct_password_opens_the_note_list` and `NotesControllerTest#test_filters_by_notebook,_status,_and_title`.
  - Control: `assert_select "select[name=per_page] option[selected]", "5"` passes.

**R3. Invalid `page` values are no longer treated as page 1** (`app/controllers/notes_controller.rb:18`)
- **Observed** in `checks/upgraded/03/summary.md`: `Pagy::VariableError: expected :page >= 1; got 0`.
- **Cause:** this change is not in the changelog. I found it by comparing the gem sources:
  - In 8.6.3, `Pagy::Backend#pagy_get_page` did `[params[...].to_i, 1].max`, so bad values became page 1.
  - In 9.3.5 it does `(page || 1).to_i`. So `page=0`, `page=-1` and `page=two` now become 0 or a negative number, which raises an error. The overflow extra doesn't help, because it only handles pages that are too high.
- **Repair:**
  ```
  -    @pagy, @notes = pagy(@notes)
  +    @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- **If nothing is done:** any `/notes?page=0`, `?page=-1` or `?page=abc` returns a 500 error. These come from stale or hand-edited links and bots.
- **Works on the current version:** yes. The backport table says the controller "works on the current version", so it can land before the bump.
- **Validation:**
  - Fails without the repair: `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` errors in check 03 and passes in check 04. It asserts 10 notes and "Displaying notes 1-10 of 52 in total" for `""`, `"0"`, `"-1"` and `"two"`.
  - Control: in the same test, `page=9` with `per_page=50` still shows the last page ("51-52 of 52").

## Default-related changes
None. pagy is not a framework, and `changes.md` has no "New framework defaults" section.

## Other gems that move
None. pagy is the only gem that changes, and it has no dependency or requirement changes. It needs Ruby >= 3.1, and the app runs 3.3.6.

## Rollout and rollback
- **Stored data:** none of the noted entries concern serialization, cookies, cache, messages or jobs, so step 8 (the writer/reader matrix) did not apply.
- **Deploy order:** R3 can ship first on its own. R1, R2 and the Gemfile bump must ship together in one commit.
- **Rollback:** rolling back means reverting that same commit. No stored data is involved in either direction.
- **Bookmarks:** the URL parameters `page` and `per_page` keep their names, so existing bookmarks keep working.

## Controls (entries checked, no change found)
- **pagy 9.3.3 `:item_name` now defaults to the `:other` key** (`app/views/notes/index.html.erb:40`): checked with probe 1. `pagy_info` gave the same output on both versions for counts 0, 1, 2 and 52, for example "Displaying 1 note" and "No notes found".
- **Changed gem files the app calls** (`backend.rb`, `frontend.rb`, `extras/overflow.rb`, `i18n.rb`): `pagy_url_for` is covered by the test that checks the `rel=prev` query string, `pagy_info` by probe 1, overflow `:last_page` by the `page=9` assertion, and the backend by R3.

## Not verified
- **9.0.0 renames of the fragment URL, `anchor_string` and `pagy_link_header`, and removal of the `pagy*_get_vars` methods:** I grepped the app and found no uses, so nothing to check.
- **The 9.x frontend refactor of the pagination nav helpers:** the app does not use them. It renders its own Previous/Next links.

---

This is only a plan. Your repo hasn't been changed; all the work above was done in the throwaway copies under `/tmp/upgrade-lab-pagy`. To get the full test suite passing on pagy 9.3.5 you need three small edits: the initializer, one line in the notes list view, and one line in the notes controller. The ready-made patch is at `/tmp/upgrade-lab-pagy/repairs.patch`.

Want me to apply it, run `bin/rails test` and `bin/rails test:system` here, and commit it on a branch?