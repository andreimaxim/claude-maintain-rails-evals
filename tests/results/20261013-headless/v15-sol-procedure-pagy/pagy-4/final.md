## Upgrade plan: pagy 8.6.3 → 9.3.5 (Margin Notes)

**Verdict:** The upgrade is feasible, but it needs four small repairs that all ship together. Bumping pagy alone stops the app from booting. Fixing only the boot error still leaves the page-size settings silently ignored and makes some page URLs return HTTP 500. With all four repairs, every check passes in the upgraded lab: bundle, boot, eager-load, routes, database and the full `bin/rails test` suite (46 runs). No other gems moved: only pagy changed in the lock, from the same rubygems source, with no dependencies added or removed. The real checkout is unchanged (`git status` clean, HEAD `ab732f5`).

### Required repairs (rollout order)
1. **F4. Keep bad page numbers on page 1.** File: `app/controllers/notes_controller.rb`. Add this private override:
   ```ruby
   def pagy_get_page(vars, **)
     [params[vars[:page_param] || Pagy::DEFAULT[:page_param]].to_i, 1].max
   end
   ```
   - **Why:** Pagy 9.0.0 (upstream commit 8da2185, then 4b8e98a) stopped forcing the page number to at least 1. Now `?page=0`, `-1`, blank or `two` returns HTTP 500 with `Pagy::VariableError: expected :page >= 1; got 0` (raised from `notes_controller.rb:18`).
   - **Current version:** The body is the same as 8.6.3's own method, and `**` accepts the new `force_integer:` keyword in 9. Based on reading the source, it should also work on 8.6.3, so it can land before the bump, but I did not run it on 8.6.3.
2. **One commit, together with the Gemfile/lock bump to `"9.3.5"`:**
   - **F1:** In `config/initializers/pagy.rb:2`, change `require "pagy/extras/items"` to `require "pagy/extras/limit"`. Without this, boot fails with `cannot load such file -- pagy/extras/items (LoadError)`.
   - **F2:** In `app/views/notes/index.html.erb:30`, change `@pagy.items` to `@pagy.limit`. Without this, every notes list render fails with `undefined method 'items' for an instance of Pagy`. That includes the page shown right after sign-in.
   - **F3:** In `config/initializers/pagy.rb:6-8`, set `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page` and `[:limit_max] = 50`. The upstream changelog names this key both `:max_limit` and `:limit_max`; the 9.3.5 source uses `:limit_max`.
     - **Why:** The old keys produce no error, they just stop working. Page size goes from 10 to 20, `?per_page` is ignored, and a new public `?limit` parameter is honoured up to 100 instead of the cap of 50.
   - These three repairs do not work on 8.6.3, so they must not ship without the bump.
3. **Update the comments too:** the comment in `pagy.rb` describes the extra, so update it to match.

**Stored data and rollback:** No database, cache or job data is involved. Pagination state lives only in the URL (`?page`, `?per_page`), and those names stay the same, so existing bookmarks keep working. To roll back, revert the code commit and the Gemfile/lock together.

**Optional defaults:** None. `defaults.json` is empty. Upstream suggests the Gemfile constraint `~> 9.3`. That is optional, and the project rules say to keep exact pins unless told otherwise.

### Evidence and validation (executed)
- **Baseline (8.6.3):** all checks passed, `/tmp/gem-upgrade-20261014-6785-tyzfcm/runs/20261014T153855-bae23f-baseline-tests`.
- **Unmodified bump:** boot failed with the LoadError, `/tmp/gem-upgrade-20261014-8011-so6597/runs/20261014T153911-26796a-unmodified-boot/output.log`.
- **Repairs applied one at a time in the upgraded lab** (logs under `/tmp/gem-upgrade-20261014-8011-so6597/runs/`):
  - After F1 (`...153947-7e4eda-repair1-tests`): boot passed; the F2 errors appeared.
  - After F2 (`...154000-a14565-repair2-tests`): one failure and one error remained.
    - The paging test got 13 rows instead of 5 (F3).
    - `Pagy::VariableError: expected :page >= 1; got 0` at `notes_controller_test.rb:79` (F4).
  - After F3 (`...154029-f59834-repair3-tests`): only the F4 error remained.
  - After F4 (`...154041-9c8e25-repair4-tests`): all checks passed.
- **Probe** (`/home/user/planner-run/evidence-pagy/probes/pagination_probe_test.rb`):
  - **Setup:** 120 extra notes, so default, per-page and cap values all give different results.
  - **What it checks:** default page size 10; `per_page=25` is honoured and kept in the next-page link; `per_page=500` is capped at 50; pages `0`, `-3`, `two` and blank show page 1.
  - **Controls:** `?limit=7` is ignored; `page=999` shows the last page; the single-result text reads "Displaying 1 note".
  - **Results:**

    | Run | Result | Log |
    |---|---|---|
    | 8.6.3 baseline | 7/7 pass | `...6785-tyzfcm/runs/20261014T154103-8810f0-probe-B` |
    | 9.3.5, all repairs | 7/7 pass | `...154117-67b6f0-probe-U-all` |
    | 9.3.5, without F3 | 4 failures (got 20, 20, 20, 7) | `...154123-12969e-probe-U-no-r3` |
    | 9.3.5, without F4 | 1 error, `VariableError ... got 0` | `...154128-fc9214-probe-U-no-r4` |

### Source-based exclusions
Read the 9.0.0 breaking-changes section, every release note through 9.3.5, and the code diff from 8.6.3 to 9.3.5 for the backend, the core class, the limit and overflow extras, `pagy_info` and the English locale. These changes don't affect this app:
- Removed CSS extras and renamed JS files
- Array `:size`
- Anchor string and fragment handling
- Keyset and calendar changes
- The 9.0.8 overflow change, which only touches `:empty_page`; the app uses `:last_page`, and the probe control passed
- The 9.3.3 locale `item_name` change, because the app passes an explicit `item_name`

### Limits
- System tests, production-mode boot and the development configs were not run.
- The upstream history has 175 commits. I read the files and commits for the APIs the app uses, but not the diffs for keyset, calendar, JS, CSS or the demo apps.
- The "without repair" probe runs reverted one repair at a time in the upgraded lab, then restored it.
- **Proposed, not run:** a system-test pass of the notes list's per-page select and Previous/Next links on 9.3.5. Setup: 30 notes. Action: pick 25, then click Next. Assert: 5 rows on page 2. Control: the same steps on 8.6.3.

### Files
- Evidence and review (structural check passed): `/home/user/planner-run/evidence-pagy/review.json`, along with `coverage.json`, `entries.tsv` and `dependencies.tsv` in the same directory.
- Helper script I wrote to fill in the review: `/home/user/planner-run/fill.py`.
- Labs, with services cleaned up and files kept:
  - Baseline: `/tmp/gem-upgrade-20261014-6785-tyzfcm`
  - Upgraded, with all four repairs applied: `/tmp/gem-upgrade-20261014-8011-so6597`

---

I haven't upgraded anything yet; this is only the plan, and your checkout is unchanged. In short, pagy 9 renamed `items` to `limit`. The rename breaks boot, breaks the notes list, and makes the page-size settings stop working without any error. Pagy 9 also returns HTTP 500 for page numbers like `?page=0`. All four fixes are small and passed the full test suite in a throwaway copy of the app, but the browser tests weren't run. Want me to make the changes?