## Upgrade plan: pagy 8.6.3 → 9.3.5 (Margin Notes)

**Verdict:** The upgrade is safe once four small code changes are made. Without them the app won't start. With all four applied in the lab copy, boot, eager load, routes, database and the full test suite (46 runs, 0 failures) all pass. pagy has no runtime dependencies, so only pagy itself moves in the lock (same rubygems source). Pagy has no optional framework defaults to adopt.

The real checkout was not touched: `git status` is clean and HEAD is still `ab732f5`.

### Required repairs

**F4 – Blank or invalid page numbers crash the note list.** This one is not in the changelog. I found it by running the tests and confirmed it in upstream commit `8da2185`.
- **Where:** `app/controllers/notes_controller.rb:18`
- **What changed:** pagy 8.6.3 turned any bad page number into page 1. In 9.x, a page of `""`, `0`, `-1` or `two` reaches Pagy as 0 and raises `Pagy::VariableError: expected :page >= 1; got 0`. Users would get a 500 error for a malformed or stale link.
- **Repair:**
  ```ruby
  @pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
  ```
- **Works on the current version:** yes. On a copy still running 8.6.3, the probe and the full suite both passed.

**F1 – The page-size add-on file was renamed, so boot fails.**
- **Where:** `config/initializers/pagy.rb:2`
- **Observed failure:** `cannot load such file -- pagy/extras/items (LoadError)`, from `config/initializers/pagy.rb:2` (log: `/tmp/gem-upgrade-20261014-8048-mf3ine/runs/*unmodified-boot/output.log`). Boot, eager load, routes, database and tests all failed.
- **Repair:** `require "pagy/extras/limit"`

**F2 – The page-size settings are silently ignored (no error).**
- **Where:** `config/initializers/pagy.rb:6-8`
- **What changed:** 9.x ignores `:items`, `:items_param` and `:max_items`. Without the rename:
  - pages show 20 notes instead of 10 (probe: "Expected: 10 Actual: 20");
  - the `per_page` URL parameter is ignored (an existing test got 13 titles instead of 5);
  - the cap rises from 50 to 100.
- **Repair:** use `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page` and `[:limit_max] = 50`. Keeping `:per_page` means existing URLs and bookmarks keep working.

**F3 – The note list view errors.**
- **Where:** `app/views/notes/index.html.erb:30`
- **Observed failure:** `ActionView::Template::Error: undefined method 'items' for an instance of Pagy`. This also breaks the page users land on after signing in.
- **Repair:** change `@pagy.items` to `@pagy.limit`.

F1, F2 and F3 don't work on 8.6.3, so they must ship together with the version bump. None of the four repairs touches stored data, and the URL format is unchanged. Rolling back means reverting the bump plus F1–F3; F4 can stay.

### Optional defaults
None.

### Rollout order
1. Ship F4 on 8.6.3.
2. In one change: bump pagy in `Gemfile`/`Gemfile.lock` and apply F1, F2 and F3.
3. Run `bin/rails test` and boot in production mode (not tested here).

### Evidence and validation

**Tested in the lab copies:**
- I wrote a probe test (`/home/user/planner-run/evidence-pagy/probes/pagy_probe_test.rb`). It uses 25 notes, so the page sizes of 10, 5 and 50 don't divide evenly. It includes a control case (page 2, `per_page=5`) that should give the same result on every build.
- **Original app on 8.6.3:** 5 runs, 20 assertions, 0 failures.
- **Upgraded copy with all repairs:** passes.
- **Upgraded copy with one repair removed at a time:**
  - without F2: 4 failures, including the control (expected, since `per_page` is ignored);
  - without F3: 5 errors;
  - without F4: 1 error.
- The probe also checks other paths through the changed code:
  - a page past the end goes to the last page (page 99 shows "21-25 of 25");
  - the previous/next links keep `per_page`;
  - `limit=` is not treated as the page-size parameter;
  - the selected page-size option is correct.
- `bin/rails test:system` ran 0 tests on both builds, because the app has no system tests.

**Based on reading upstream source and changelog, not tested:**
- Removed features the app doesn't use: anchor/fragment options, array `:size`, the CSS and JS add-ons, keyset, calendar.
- The change to the default item name in 9.3.3 doesn't affect the app, because it passes `item_name:` explicitly.
- The 9.0.8 change to overflow handling only affects the `:empty_page` mode; the app uses `:last_page`.

### Limits
- Browser behavior is unverified because there are no system tests.
- Production-mode boot was not run.
- I only fetched the minor-release tags, so I can trace F4 to commit `8da2185`, but the earliest fetched release containing it is 9.0.9.
- I reviewed commits only for the parts of pagy the app uses, not every commit.
- `per_page=""` or `per_page=0` should raise an error on both versions, based on reading the code. That's an existing problem, not caused by the upgrade, and I didn't test it.

### Files
- Evidence and finished review: `/home/user/planner-run/evidence-pagy/` (`review.json`, `coverage.json`, `entries.tsv`, `dependencies.tsv`, `probes/`)
- Lab copies (services cleaned up, logs kept):
  - original app on 8.6.3: `/tmp/gem-upgrade-20261014-6826-hdvovg`
  - upgraded copy with the repairs: `/tmp/gem-upgrade-20261014-8048-mf3ine`
  - copy testing F4 on 8.6.3: `/tmp/gem-upgrade-20261014-9608-lbbud6`

---

I haven't upgraded pagy yet. The upgrade skill only plans the change, and your repo is untouched. The upgrade to 9.3.5 needs four small code changes. Without them the app won't start, and with them all 46 tests pass in a test copy. If you want me to go ahead, I'd first ship the page-number fix (F4) on the current version, then bump pagy together with the other three fixes.