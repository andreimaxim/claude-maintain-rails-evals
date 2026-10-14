I've only planned the upgrade so far. The planner made its changes in throwaway copies, and your checkout is untouched. Here is its plan:

---

I've written the upgrade plan for pagy 8.6.3 → 9.3.5. The upgrade needs two code changes, and they have to ship in the same commit as the Gemfile bump. I only changed throwaway copies; the original checkout is untouched and its file hashes match.

## Required changes

**1. Rename `items` to `limit`** (`config/initializers/pagy.rb`, `app/views/notes/index.html.erb:30`)

Pagy 9.0.0 renamed the `items` extra, its settings and `Pagy#items` to `limit`. Without this change the app won't start on any 9.x version: `cannot load such file -- pagy/extras/items (LoadError)`.

The fix:
- Change `require "pagy/extras/items"` to `require "pagy/extras/limit"`.
- Change the three settings to `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page` and `[:limit_max] = 50`.
- In the view, change `@pagy.items` to `@pagy.limit`.

Keep the URL parameter named `per_page` so existing links and the page-size select keep working. If you renamed only the `require`, nothing would fail loudly. Pagy would ignore the old settings and quietly fall back to 20 notes per page, a `limit` parameter and a cap of 100. The view would also raise `NoMethodError` on `@pagy.items`.

**2. Treat invalid page numbers as page 1 again** (`NotesController#index`)

Pagy 8 turned a blank, zero, negative or non-numeric `?page=` into page 1. Pagy 9 (since 9.0.3) passes the number through and raises `Pagy::VariableError: expected :page >= 1; got 0` (or `got -3`). That's a 500 error instead of the first page. The changelog lists this only as "Improve pagy_get_page with force_integer option"; I found it by comparing the 8.6.3 and 9.3.5 source. The overflow extra doesn't catch this error.

The fix is a private method in `NotesController`:
```ruby
def pagy_get_page(vars, force_integer: true)
  force_integer ? [super, 1].max : super
end
```
On 8.6.3 this method would raise `ArgumentError`, because the old version doesn't accept `force_integer`. So it can't go in ahead of the bump. To roll back, revert the gem bump, initializer, view and controller change together. No stored data depends on pagy.

## What I ran
- **Current version:** boot, database setup, eager loading, routes and the full suite pass (46 runs, 325 assertions).
- **Unchanged upgrade (9.0.9, 9.1.1, 9.2.2 and 9.3.5):** every version fails at startup with the `LoadError` above.
- **9.3.5 with only change 1:** startup, database, eager loading and routes pass. The suite gets 1 error, in the existing invalid-pages test at `notes_controller_test.rb:79` (`got 0`).
- **9.3.5 with both changes:** everything passes with the same counts as the current version (46 runs, 325 assertions, 0 failures).
- **Extra tests I wrote** (`probes/pagy_probe_test.rb`, 9 tests):
  - Current version: all pass.
  - 9.3.5 with only change 1: 4 errors, all from invalid page numbers.
  - 9.3.5 with both changes: all pass.

  They cover a page size of 5, the default of 10, a request for 999 being capped at 50, the four kinds of invalid page, and a page past the end falling back to the last page. With both changes, that last check showed "Displaying notes 11-14 of 14 in total" and a previous-page link of `/notes?per_page=5&page=2`.

## Checked and not applicable
- **Item-name text (9.3.3):** the view passes its own `item_name`, so the default change doesn't reach it. 9.3.5 rendered "Displaying 1 note" correctly.
- **Features the app doesn't use:** the keyset changes in 9.2/9.3, the move to keyword arguments, the fragment/anchor rework, the link-header rename and the JavaScript removals.
- **Other gems:** none moved; only pagy changes in `Gemfile.lock`. pagy 9 needs Ruby 3.1 or later, and the app runs 3.3.6.
- **Stored data:** pagy touches no cookies, cache entries, database values or queued jobs, and none of these scenarios had defaults to decide.

## Not checked
- The browser suite (`bin/rails test:system`).
- Exact wording of the "Displaying notes…" line on the current version. The output was captured unreliably, so I couldn't compare it. The row-count checks did pass on both versions.
- The `ArgumentError` from change 2 on 8.6.3; this comes from reading the source, not a run.
- 29 lower-priority upstream commits weren't opened one by one. I checked the overall diff for pagination, URL building, the info line, overflow handling and the `limit` extra.

## Files
Everything is in `/tmp/gem-upgrade-20261014-71585-5s9d2k`:
- Plan: `plan.json`
- Sources: `sources/index.md`
- Repaired copy: `variants/v9_3_5_fixed2/app`
- Failing copies: `variants/v9_3_5_fixed/app` (change 1 only) and `variants/v9_3_5/app` (unchanged)
- Run logs: `runs/{baseline,v9_3_5,v9_3_5_fixed,v9_3_5_fixed2}/`, plus `sweep.json` for the version sweep

The lab databases have been dropped.

---

**My take:** With both code changes, the upgrade passed the full test suite at 9.3.5. Change 2 matters most because the changelog doesn't mention it. Without it, a URL with a bad page number like `?page=0` returns a 500 error instead of the first page.

Want me to apply the bump and both changes in one commit on a new branch, then run the browser tests the planner skipped (`bin/rails test:system`)?