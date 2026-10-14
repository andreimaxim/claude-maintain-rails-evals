# Upgrade plan for pagy 8.6.3 to 9.3.5 in Margin Notes

The upgrade needs three small code changes. Without them the app won't boot on 9.3.5, and a bad `page` value would crash the notes list. Once I applied all three in the throwaway workspace, all 46 tests passed (325 assertions). The only dependency that changes is `pagy: 8.6.3 → 9.3.5`. Pagy adds no Rails configuration defaults and stores no data, so the rollout risk is low. The workspace has been cleaned up and the working checkout is unchanged (`git status` clean).

## 1. Required changes for the upgrade

### Finding A: the renamed `items` extra stops the app from booting
- **Affected code:** `/home/user/workspace/repo/config/initializers/pagy.rb`, lines 2 and 6–8: `require "pagy/extras/items"`, `Pagy::DEFAULT[:items]`, `[:items_param]`, `[:max_items]`.
- **What breaks:** On 9.3.5 the app won't start: `LoadError: cannot load such file -- pagy/extras/items (config/initializers/pagy.rb:2:in '<main>')`. Boot, eager loading and the test suite all fail before running.
- **Applicability:** Pagy 9.0.0 renamed `items` to `limit` everywhere, and `:max_items` became `:limit_max`. This breaks as soon as the gem is bumped. The fix only works on 9.x (8.6.3 has no `extras/limit`), so it must ship in the same commit as the bump.
- **Recommended repair:** Replace lines 2 and 6–8 with:
  ```ruby
  require "pagy/extras/limit"
  Pagy::DEFAULT[:limit] = 10
  Pagy::DEFAULT[:limit_param] = :per_page
  Pagy::DEFAULT[:limit_max] = 50
  ```
  Keep `limit_param` as `:per_page`. Otherwise existing bookmarked URLs would silently lose their page size, because the new default param name is `limit`.
- **Validation:** With the repair applied, boot and eager loading pass (67 routes, same as baseline). `NotesControllerTest` "pages through filtered notes…" (`per_page=5`, page 2 shows "Reading 08..04" and "Displaying notes 6-10 of 13 in total") passes. So does `per_page=500` being capped to 50. A probe confirmed `per_page: "500"` gives limit 50 and `per_page: "7", page: "99"` gives page 8 with limit 7 on both versions.

### Finding B: the `@pagy.items` accessor is gone from the view
- **Affected code:** `/home/user/workspace/repo/app/views/notes/index.html.erb:30`, `options_for_select([5, 10, 25, 50], @pagy.items)`.
- **What breaks:** `@pagy.items` no longer exists in 9.0.0, so the view would raise `NoMethodError` as soon as the gem is bumped. Read from the changelog, not observed: Finding A blocked boot first, and I applied both fixes together.
- **Applicability:** 9.0.0, immediately on the bump. Ship it with Finding A.
- **Recommended repair:** Change line 30 to `@pagy.limit`.
- **Validation:** `assert_select "select[name=per_page] option[selected]", "5"` passes on the upgraded copy. The control check is the default request with no `per_page`: it renders 10 notes.

### Finding C: an empty, zero or non-numeric `page` now raises (HTTP 500)
- **Affected code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:18`, `NotesController#index`, `@pagy, @notes = pagy(@notes)`.
- **What breaks:** In 8.6.3, `pagy_get_page` clamped the value with `[params[:page].to_i, 1].max`. In 9.3.5 it returns `(page || 1).to_i` with no clamp. Requests with `page=""`, `"0"`, `"-1"` or `"two"` now raise `Pagy::VariableError: expected :page >= 1; got 0` instead of showing page 1. This made `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50` fail at `notes_controller_test.rb:79`.
- **Applicability:** 9.0.0 backend refactor, immediately on the bump, for those inputs only. The repair also works on 8.6.3 (probed), so it can ship before the bump.
- **Recommended repair:** Change line 18 to `@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)`. I chose this over overriding `pagy_get_page` because that method's signature differs between 8 (`(vars)`) and 9 (`(vars, force_integer: true)`), and an override using `super` would break on one of the two versions.
- **Validation:**
  - Failing check without the repair: `GET /notes?page=0` (also `""` and `two`) must return 200 with "Chapter 50" first and "Displaying notes 1-10 of 52 in total". It fails on 9.3.5 without the repair and passes with it.
  - Controls: `page=3` stays on page 3, `page=99&per_page=7` still goes to page 8 (the `:last_page` overflow), and the filtered pagination test still passes.

### Things I checked that do not need changes
- **`pagy_info` with `item_name:`** (9.3.3 change, `index.html.erb:40`): the output is identical on both versions for counts 1, 7 and 13 ("Displaying 1 note", "Displaying 7 notes", "Displaying notes 11-13 of 13 in total").
- **`pagy_url_for`:** the prev/next links keep the filters, as shown by passing tests on both versions.
- **Changelog items that don't apply here:** the app uses no Pagy JavaScript files, CSS extras, `:size` arrays, anchor/fragment options, keyset or headers extras, and it doesn't subclass Pagy. Other textual matches (`requests.size`, `job.arguments`, `schedule_reminder`) are unrelated.
- **`per_page=0` or `per_page=abc`:** this already raises `Pagy::VariableError` on 8.6.3 (`expected :items >= 1; got 0`) and on 9.3.5 (`expected :limit >= 1`). It's an existing bug, not a regression. You could clamp it the same way (`limit: ...`) as a separate fix.

## 2. New configuration defaults across intermediate releases
Pagy has no `load_defaults` mechanism and introduces no Rails framework defaults in 9.0.9, 9.1.1, 9.2.2 or 9.3.5. The only default changes that matter here are Pagy constants the app overrides explicitly:
- `DEFAULT[:limit_param]` is now `:limit`. Keep it at `:per_page`.
- `DEFAULT[:limit_max]` is now 100. Keep it at 50.
- `DEFAULT[:limit_extra]` is now `true`, which is fine.

The `:after_latest` deprecation (9.2.0) and the `:typecast_latest` removal (9.3.0) only affect the keyset extra, which the app doesn't use.

## 3. Rollout, rollback, and mixed-version risks
Pagy doesn't touch database records, `db/schema.rb`, the Redis cache, cookies, tokens or Active Job payloads. Mixed-version risk is limited to URLs, and `per_page`/`page` URLs work the same on both versions as long as `limit_param` stays `:per_page`.
- **Before the bump:** Finding C can ship on 8.6.3 first.
- **With the bump:** Findings A and B must ship together with the gem bump.
- **Rollback:** reverting the bump must also revert A and B.

## 4. Verification log and open questions
**Checks run in the workspace** (`/tmp/upgrade-pagy-9.3.5`, Rails 7.0.8.7, Ruby 3.3.6, lockfile resolved to `pagy 9.3.5`):
- `gem-changes pagy 8.6.3 9.3.5`. It couldn't unpack the 9.x `.gem` files, so it relied on the changelog and commit list.
- `upgrade-workspace setup`: baseline had 46 runs with 0 failures; upgraded failed to boot with the `LoadError`.
- After Findings A and B, `upgrade-workspace test`: 1 error, the `Pagy::VariableError` page error.
- After Finding C: 46 runs, 325 assertions, 0 failures, 0 errors.
- Probes:
  - page and per_page parsing through `NotesController#pagy` on both versions (results above).
  - the repaired `page:` call on both versions: identical output.
  - `pagy_info` output on both versions: identical.
- Logs were in `/tmp/upgrade-pagy-9.3.5/logs` (`bundle-update.log`, `diag-*.log`, `schema-load-*.log`, `tests-*.log`). They were deleted by `cleanup`.

**Conclusions from reading code only:**
- The `@pagy.items` `NoMethodError` (Finding B).
- No JavaScript, CSS or keyset usage in the app.

**Not verified:**
- The browser (system) suite was not run.
- One check remains to run: `GET /notes?page=` in a real browser session, to confirm a 200 response once the repair is deployed.

---

This is only a plan. I haven't changed anything in your repo, and the version in `Gemfile` is still pinned to `"8.6.3"`. To apply it, update the version in `Gemfile` to `"9.3.5"`, run `bundle update pagy`, and make the three changes above. Then run `bin/rails test` and `bin/rails test:system`, since the browser suite hasn't been run yet. Want me to go ahead?