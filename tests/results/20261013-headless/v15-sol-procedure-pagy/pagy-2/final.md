Upgrading Margin Notes from pagy 8.6.3 to 9.3.5 is feasible, but it needs three small code changes. All three come from the 9.0.0 major release, and with them applied the full test suite passed in the lab (46 runs, 0 failures). Without them, the app fails to boot. Nothing else changes with the bump, and there are no stored data or database migrations involved. The real checkout is unchanged (`git status` is clean).

## Required repairs (all three tested in the upgraded lab copy)

**F1. `config/initializers/pagy.rb` lines 2 and 6–8: 9.0.0 renamed "items" to "limit"**
- **Observed failure (executed):** ``cannot load such file -- pagy/extras/items (LoadError)`` at `config/initializers/pagy.rb:2`. Log: `/tmp/gem-upgrade-20261014-8024-3y2n78/runs/20261014T153858-4a6142-unmodified-boot/output.log`. Every later check failed the same way.
- **Repair:**
  - `require "pagy/extras/limit"`
  - `Pagy::DEFAULT[:limit] = 10`
  - `Pagy::DEFAULT[:limit_param] = :per_page`
  - `Pagy::DEFAULT[:limit_max] = 50`
  - Keep `:overflow = :last_page` as it is.
- **Why the setting names matter:** if only the `require` line is fixed, pagy 9 ignores the old setting names. It then reads the page size from `limit` instead of `per_page`, uses its own cap of 100, and the app behaves as if no page size was requested. Setting `limit_param` to `:per_page` keeps existing URLs and bookmarks working.
- **Validation (executed):** with the `limit_param`/`limit_max` lines removed, the probe had 4 failures, for example `Expected exactly 7 elements matching ".note", found 10.` Log: `/tmp/gem-upgrade-20261014-8024-3y2n78/runs/20261014T154048-4d79d5-probe-no-param-repair`.
- **Works on 8.6.3?** No. Ship it in the same change as the bump.

**F2. `app/views/notes/index.html.erb:30`: `@pagy.items` becomes `@pagy.limit`**
- **Observed failure (executed):** ``ActionView::Template::Error: undefined method `items' for an instance of Pagy``. This happens on every render of the notes list. Log: `.../runs/20261014T153916-2edcdb-repair1-tests/output.log`.
- **Validation (executed):** without this change the probe fails with the same error (`.../runs/20261014T154046-72438a-probe-no-view-repair`). With it, the probe passes.
- **Works on 8.6.3?** No. Ship it with the bump.

**F3. `app/controllers/notes_controller.rb:18`: invalid page numbers are no longer corrected to page 1**
- **Not in the changelog.** Found from the source and a failing test:
  - 8.6.3 `gem/lib/pagy/backend.rb:35` used `[params[...].to_i, 1].max`, which turned any bad page into page 1.
  - 9.x `backend.rb:39-42` uses `(page || 1).to_i` with no lower bound. The clamp was removed during the 9.0.0 refactor.
- **Observed failure (executed):** `Pagy::VariableError: expected :page >= 1; got 0` for `page=""`, `"0"`, `"-1"` and `"two"`. Users would get a server error (500) from bad or stale page links. Log: `.../runs/20261014T153953-4a825d-repair2-tests/output.log`. This breaks the existing test "invalid pages show the first page".
- **Repair:** `@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)`
- **Validation (executed):** without the repair the probe errors (`.../runs/20261014T154044-aada97-probe-no-page-repair`). With it, the probe passes. As a control, page=2 and page=99 (past the end, which shows the last page) behave the same before and after.
- **Works on 8.6.3?** Yes, based on reading the code. I did not run it against 8.6.3 on its own, so I'm not claiming more than that.

## Optional defaults
There are none. `defaults.json` was empty, and the app uses none of the new 9.x features (keyset pagination, `:filter_newest`, `limit_selector_js`).

## Rollout order
1. Optionally land F3 first. It does not depend on the bump, but it is untested on 8.6.3, so landing it with the bump is the safe option.
2. In one deploy: the Gemfile/lock bump to 9.3.5, plus F1 and F2.
3. Rollback means reverting that deploy as a whole. Pagy stores nothing in the database or job queues, so no data handling is needed. Existing `?per_page=` URLs keep working.

## Changes reviewed and ruled out
- **9.0.0 removals:** the removed CSS extras, renamed JS files, array `:size`, `:anchor_string`/`:fragment`, keyword-argument constructors and renamed protected methods. The app uses none of these and has no Pagy subclasses.
- **9.1 and 9.2:** a new locale, calendar changes and keyset changes. The app uses none of them.
- **9.3.3 `:item_name` change:** the app passes an already pluralized string to `pagy_info`, and the "single result uses singular item name" probe passed on both versions.
- **Dependencies:** only pagy itself moves. No dependencies are added, removed or switched to a different source.

## How it was checked
- **Baseline:** all checks passed on 8.6.3 (`/tmp/gem-upgrade-20261014-6809-xe7jff/runs/20261014T153845-45ab47-baseline-tests`).
- **Upgraded and repaired:** bundle, boot, eager-load, routes, database and tests all passed (`/tmp/gem-upgrade-20261014-8024-3y2n78/runs/20261014T154003-1452f7-repaired-tests`).
- **Probe:** `/home/user/planner-run/probes-pagy/pagination_probe_test.rb` (7 tests). It covers:
  - the default size of 10 as a control
  - `per_page=7`, so the page size differs from the default
  - the cap of 50
  - invalid page values
  - a page past the end showing the last page
  - singular wording for one result
  - paging after a note is updated
- **Probe results:** it passed on both the 8.6.3 baseline (`runs/20261014T154039-67f682-probe-base2`) and the repaired upgrade (`runs/20261014T154041-a9a872-probe-repaired2`). Its first version had one wrong expectation (the next link also carries `per_page=10`); it failed the same way on both versions and I corrected it.

## Limits
- I did not run the browser tests (`bin/rails test:system`) or boot in production mode.
  - **Proposed check:** run `bin/rails test:system` and open `/notes?per_page=5&page=0` in production mode.
  - **Assertion:** the page shows page 1 with 5 notes.
  - **Control:** `/notes` with no parameters shows 10 notes.
- There were 175 upstream commits, more than the 80 that can be read one by one. I read the 9.x changelog and migration guide in full, and compared the code for `backend.rb`, `url_helpers.rb`, `extras/limit.rb` and `extras/overflow.rb` between the two versions. Changes to the view helpers and translations were covered by the probe, not by reading their full diffs.
- To test F1, I deleted the new `limit_*` lines rather than restoring the old `items` names. Both leave pagy on its default `limit` parameter, but this approximates the "forgot to rename" case rather than reproducing it exactly.

## Files
- **Evidence, including the closed review:** `/home/user/planner-run/evidence-pagy/` (`review.json`, `coverage.json`, `entries.tsv`, `dependencies.tsv`, `upstream/`). `gem-upgrade-review check` reported "Review closed: 5 candidates, 3 findings, 3 limits"; that check confirms the structure only, not the conclusions.
- **Labs:** `/tmp/gem-upgrade-20261014-8024-3y2n78` (9.3.5 with the repairs) and `/tmp/gem-upgrade-20261014-6809-xe7jff` (8.6.3 baseline). Their services are cleaned up and the run logs are kept.

---

**My notes:** The plan above came from the planning agent. I haven't changed your repository: the gem is still locked at 8.6.3 and the working tree is clean. If you want me to go ahead, I'd make one change: bump the lock to 9.3.5 and apply all three fixes, then run `bin/rails test` and `bin/rails test:system`. The browser tests weren't run during planning.