## Upgrade plan: pagy 8.6.3 → 9.3.5 (Margin Notes)

**Verdict:** The upgrade is safe once two small required changes go in. The bump alone stops the app from booting. Both changes depend on 9.x, so they must ship in the same commit as the Gemfile/lock bump. pagy is the only gem that moves; it has no runtime dependencies and the source stays rubygems. pagy has no defaults to opt into. The real checkout is unchanged: `git status` is clean and HEAD is still `ab732f5`.

### Required repairs (both tested in a lab copy)

**F1. The `items` settings were renamed to `limit` in 9.0.0.** Affects `config/initializers/pagy.rb:2,6-8` and `app/views/notes/index.html.erb:30`.
- **Observed failure:** with only the bump, boot fails with `cannot load such file -- pagy/extras/items (LoadError)` at `config/initializers/pagy.rb:2`. Log: `/tmp/gem-upgrade-20261014-8040-os7m0z/runs/20261014T153905-38fa03-unmodified-boot/output.log`.
- **Partial fixes are worse than none:** changing only the `require` line boots but silently misbehaves. Pages show 20 notes instead of 10, `per_page` is ignored and the 50 cap is lost. Probe output: `Expected exactly 10 elements matching ".note", found 20`, with 5 failures in `/tmp/gem-upgrade-20261014-8733-67xfmn/runs/20261014T154055-5bd1b2-probe-v2`.
- **Repair:**
  - Change the require to `require "pagy/extras/limit"`.
  - Set `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page` and `[:limit_max] = 50`, and remove the old `items` keys.
  - In the view, change `@pagy.items` to `@pagy.limit`.
- **Source:** the 9.0.0 CHANGELOG renaming table, plus `extras/limit.rb` and `shared_methods.rb` at tag 9.3.5.

**F2. Invalid page numbers now cause a 500 error.** This change is not in the changelog; I found it by diffing the source. Commit `8da2185` (9.0.0) removed the clamp to page 1 (`[...to_i, 1].max`) from `Pagy::Backend#pagy_get_page`.
- **Observed failure:** the existing test `test/controllers/notes_controller_test.rb:74` fails with `Pagy::VariableError: expected :page >= 1; got 0` at `app/controllers/notes_controller.rb:18`. This happens for `?page=` (blank), `0`, `-1` and `two`. Log: `/tmp/gem-upgrade-20261014-8040-os7m0z/runs/20261014T153947-538353-repair1-tests/output.log`.
- **Repair:** add this private method to `NotesController`:
  ```ruby
  def pagy_get_page(vars, force_integer: true)
    page = super
    force_integer ? [page, 1].max : page
  end
  ```
- **Older version (not run, read from source):** 8.6.3's `pagy_get_page(vars)` would reject the `force_integer:` keyword, so this cannot land before the bump.

**Stored data and rollback:** neither finding touches stored or queued data. The URL parameter stays `per_page`, so existing bookmarks keep working. To roll back, revert the code changes together with the bump.

### Rollout order
1. Make one commit with the Gemfile/lock bump, the F1 initializer and view changes, and the F2 controller override.
2. Run `bin/rails test`, `bin/rails test:system` and `zeitwerk:check`.
3. Deploy. No migration or cache flush is needed.

### Validation (run in disposable lab copies)
- **Probe:** `/home/user/planner-run/probes-pagy/pagy_probe_test.rb`, 6 tests with 19 assertions. It checks:
  - the default page size of 10;
  - `per_page=5` and that it carries into the next-page link;
  - that `?limit` is ignored;
  - the cap of 50 per page;
  - that invalid pages show page 1;
  - with `page=2` as a control that should change nothing;
  - overflow past the end showing the last page with a working previous link;
  - singular wording ("Displaying 1 note").
- **Results:**

| Run | Result | Log |
|---|---|---|
| Current version (8.6.3) | PASS | `/tmp/gem-upgrade-20261014-6857-b8ridh/runs/20261014T154038-5fb0a0-probe-v2` |
| 9.3.5 with both repairs | PASS | `/tmp/gem-upgrade-20261014-8040-os7m0z/runs/20261014T154040-cdf2c0-probe-v2` |
| 9.3.5 without F2 | FAIL with `VariableError` | `/tmp/gem-upgrade-20261014-8718-ul8sud/runs/20261014T154050-4d13d4-probe-v2` |
| 9.3.5 without F1 | Boot fails; the partial-F1 variant fails as above | |

- **Full checks:** with both repairs, the bundle, boot, eager-load, routes, database and test checks all pass on 9.3.5. Logs: `/tmp/gem-upgrade-20261014-8040-os7m0z/runs/*-repair2-*`. The current-version baseline also passed.

### Upstream changes that don't affect this app (source-based)
- **Removed or changed features the app doesn't use:** the removed CSS extras, JS file renames, the `anchor_string`/`fragment` changes, the array form of `:size`, the switch to keyword arguments (the app calls `pagy(collection)` with no options), the removed `pagy_get_vars`, and the keyset/calendar/locale changes.
- **`item_name` wording change (9.3.3):** the app passes a plain string, and the probe confirms the "Displaying …" text is the same on both versions.

### Limits
- I did not run system tests or production mode.
- There were 175 upstream commits, so I reviewed the changelog sections and the 8.6.3 → 9.3.5 source diff of `gem/lib` rather than every commit. JS/CSS assets and the keyset code were not reviewed in depth because the app doesn't use them.
- I did not bump through intermediate versions, because both failures trace directly to 9.0.0 code.

### Files
- Evidence and the review file (its structural check passes): `/home/user/planner-run/evidence-pagy/` (`review.json`, `coverage.json`, `entries.tsv`, `dependencies.tsv`)
- Probe and the script that filled the review: `/home/user/planner-run/probes-pagy/`
- Lab copies (services cleaned up, logs kept): `/tmp/gem-upgrade-20261014-6857-b8ridh` (current version), `/tmp/gem-upgrade-20261014-8040-os7m0z` (upgraded), `/tmp/gem-upgrade-20261014-8718-ul8sud` and `/tmp/gem-upgrade-20261014-8733-67xfmn` (the "without F2" and "partial F1" variants)

---

**What this means:** The upgrade from pagy 8.6.3 to 9.3.5 is a plan only so far. Nothing in your repository has changed. The bump works with two small code changes:

1. **Rename `items` to `limit`** in the pagy initializer and the notes list view. Without this, the app won't boot.
2. **Override `pagy_get_page` in `NotesController`.** Without it, a blank or invalid `?page=` returns a 500 error instead of showing page 1.

Both changes need to go in the same commit as the bump. In throwaway copies of the app, version 9.3.5 with both changes passed the regular test suite and the pagination checks. The browser (system) tests were not run there, so run `bin/rails test:system` before deploying.

Should I apply the upgrade now?