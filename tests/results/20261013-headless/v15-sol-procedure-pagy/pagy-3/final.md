# Pagy upgrade plan: 8.6.3 to 9.3.5 (Margin Notes)

**Verdict:** The upgrade is safe to do, but it needs three code changes shipped in the same commit as the version bump. With all three applied in the disposable lab, the full test suite passed: `46 runs, 325 assertions, 0 failures, 0 errors`. Nothing is stored, so there is no data migration. The real checkout is unchanged (`git status` is clean, still at `ab732f5`).

Pagy is the only gem that moves. It has no runtime dependencies before or after, and its source stays rubygems.org.

## Required repairs (one commit, together with the bump)

1. **F1 – Gemfile and `config/initializers/pagy.rb`.**
   - Change `gem "pagy", "8.6.3"` to `"9.3.5"`.
   - In the initializer, use `require "pagy/extras/limit"` and set `Pagy::DEFAULT[:limit] = 10`, `[:limit_param] = :per_page`, `[:limit_max] = 50`. Keep `[:overflow] = :last_page`.
   - **What breaks today:** after the bump, the app won't boot. `unmodified-boot` failed with `cannot load such file -- pagy/extras/items (LoadError)` at `config/initializers/pagy.rb:2`.
   - **Worse partial fix:** if you rename only the `require` line and keep the old setting names, the app boots but Pagy silently ignores them. The page size falls back to 20 (probe: `Expected: 10 / Actual: 20`). The `per_page` parameter stops working, the cap becomes 100 via `?limit=`, and an invalid `per_page` no longer raises.
   - Source: 9.0.0 BREAKING entries (items renamed to limit, then `:max_limit` renamed to `:limit_max`) and `gem/lib/pagy/extras/limit.rb` at tag 9.3.5.

2. **F2 – `app/views/notes/index.html.erb:30`.** Change `@pagy.items` to `@pagy.limit`.
   - Without it, the notes list raises on every render: `ActionView::Template::Error: undefined method 'items' for an instance of Pagy` (log: `/tmp/gem-upgrade-20261014-8185-ka1kkf/runs/20261014T153938-8a808f-repair1-tests/output.log`).

3. **F3 – `NotesController`, private section.** Add this method to keep the current page handling:
   ```ruby
   def pagy_get_page(vars, force_integer: true)
     force_integer ? [super, 1].max : super
   end
   ```
   - Pagy 8.6.3 turned any bad page number into page 1 (`[params[:page].to_i, 1].max`). In 9.x, `gem/lib/pagy/backend.rb` returns `(page || 1).to_i`, and `SharedMethods#assign_and_check` then rejects it.
   - **What breaks today:** `?page=` with an empty value, `0`, `-1` or `two` raises `Pagy::VariableError: expected :page >= 1; got 0`. That is a 500 in production. ARCHITECTURE.md says these show page 1, and `test/controllers/notes_controller_test.rb:74` checks it.
   - Log: `/tmp/gem-upgrade-20261014-8185-ka1kkf/runs/20261014T153950-9b5448-repair2-tests/output.log`.

None of the three works on 8.6.3: 8.6.3 has no `extras/limit`, no `#limit`, and its `pagy_get_page(vars)` takes no `force_integer:` keyword. So they cannot go out ahead of the bump.

## Optional defaults
None. `defaults.json` is empty. The new settings that come with the limit extra (`limit_param :limit`, `limit_max 100`) are overridden by F1. The 9.0.8 change to how overflowing pages behave applies only to `:empty_page`, and the app uses `:last_page`.

## Rollout order
1. Single commit: the Gemfile and lock change, the initializer, the view, and the controller override.
2. Update the docs that say "Pagy 8.6.3" (`ARCHITECTURE.md:17`, `docs/guides/controllers.md:108`).
3. Run `bin/rails test` and `bin/rails test:system`.
4. Deploy.

Rollback is reverting that one commit; there is no stored data to undo. Bookmarked URLs keep the `per_page` parameter name.

## Validation (executed)
The probe is `/home/user/planner-run/probes-pagy/pagy_upgrade_probe_test.rb`.
- **Setup:** 61 extra notes with distinct titles and strictly increasing timestamps.
- **Checks:**
  - default page size is 10;
  - `per_page=5` gives 5 rows and the next link keeps it;
  - `per_page` of 500 or 75 is capped at 50;
  - the control `?limit=25` does not change the size;
  - an empty page, `0`, `-1` and `two` all show the newest note first;
  - the control `page=2` shows the 11th note;
  - `page=999` shows the last page.
- **Unchanged control:** `per_page=0` still raises `VariableError` on both versions. This is existing behaviour that ARCHITECTURE.md already documents.

| Run | Result |
|---|---|
| Current app, Pagy 8.6.3 (`probe-baseline2`) | PASS, 4 runs / 24 assertions |
| Pagy 9.3.5 with all repairs (`probe-repaired`) | PASS |
| Without F3 (`probe-no-page-clamp`) | `Pagy::VariableError: expected :page >= 1; got 0` |
| Old setting names (`probe-old-var-names`) | 4 failures (default size 20, cap and control fail) |
| Without F2 (`probe-no-view-fix`) | 3 `undefined method 'items'` errors |
| Full check on 9.3.5 with repairs (`final`) | boot, eager-load, routes, database and tests all PASS |

The first probe run on the current app failed on a wrong assertion of mine: Pagy correctly carries other query parameters into the next link. I fixed the probe, not the app.

## Upstream coverage (source-based)
- I read all 80 changelog entries for 9.0.0 through 9.3.4. There are 175 commits, so instead of every patch I diffed `8.6.3..9.3.5` for `gem/lib` and `gem/locales/en.yml`.
- Changes that don't apply here:
  - keyword-argument vars: the app calls `pagy(@notes)` without vars;
  - anchor and fragment refactor, and the removed CSS-framework extras;
  - keyset, calendar, countless, search and jsonapi extras: not used;
  - the 9.3.3 `:item_name` change: the app always passes `item_name:` to `pagy_info`.

## Limits
- System tests and production-mode boot were not run in the lab (proposed).
- I did not read every commit patch.
- The probe covers only the HTML notes list, which is the app's only place that uses Pagy.

## Files
- Evidence: `/home/user/planner-run/evidence-pagy/` (`review.json` passes the structural check)
- Probe and review script: `/home/user/planner-run/probes-pagy/`
- Lab logs (services cleaned up): `/tmp/gem-upgrade-20261014-6997-t36y5j` (current version) and `/tmp/gem-upgrade-20261014-8185-ka1kkf` (upgraded)

---

This is only a plan. I haven't changed your checkout yet. The main risk is F3: if you bump the version and skip it, a bad `?page=` value gives a 500 error instead of showing page 1. The system tests haven't been run against 9.3.5 yet. If you want me to make the change, I'll put the bump and the three fixes in one commit, update the two docs, and run `bin/rails test` and `bin/rails test:system`.