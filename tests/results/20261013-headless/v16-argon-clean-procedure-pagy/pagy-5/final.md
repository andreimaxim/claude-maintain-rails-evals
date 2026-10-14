# Pagy 8.6.3 to 9.3.5 upgrade plan for Margin Notes

With only the gem version changed, the app fails to start under 9.3.5. Three changes fix it: the gem pin, renamed settings in the Pagy initializer, and a one-word view change. I applied them in the throwaway workspace, and the app then started but one test failed. Pagy 9 stopped correcting bad page numbers, so a fourth change is needed in `NotesController`. With all four changes the full suite passed on 9.3.5: 46 runs, 325 assertions, 0 failures. The working checkout was not modified (`git status` clean after cleanup).

## 1. Required changes for the upgrade

### A. The `pagy/extras/items` file no longer exists, so the app cannot start
- **Affected code:** `/home/user/workspace/repo/config/initializers/pagy.rb`, lines 2 and 6–8. `/home/user/workspace/repo/Gemfile`, line 32 (`gem "pagy", "8.6.3"`).
- **What breaks:** Startup, eager loading and the test run all fail with `LoadError: cannot load such file -- pagy/extras/items (config/initializers/pagy.rb:2:in '<main>')`. On 9.3.5 the app drew 0 routes, compared with 67 on 8.6.3.
- **Applicability:** Introduced in 9.0.0, which renamed `items` to `limit` everywhere. It applies as soon as the gem is bumped. The repair only works on 9.x, so it must ship in the same deploy as the bump. Nothing is stored or queued: the request parameter keeps its custom name `per_page`, so existing URLs and bookmarks keep working.
- **Recommended repair:** Change line 32 of the Gemfile to `gem "pagy", "9.3.5"`, then replace the initializer settings with:
  ```ruby
  require "pagy/extras/limit"
  require "pagy/extras/overflow"
  Pagy::DEFAULT[:limit] = 10
  Pagy::DEFAULT[:limit_param] = :per_page
  Pagy::DEFAULT[:limit_max] = 50
  Pagy::DEFAULT[:overflow] = :last_page
  ```
  Keep the two existing comments in the file. Each new setting has the same meaning as the old one. In particular, `:limit_max` replaces `:max_items` with the same cap of 50; only the word order of the name changed.
- **Validation:** Without the repair, startup fails with the `LoadError` above. With it, the app starts, loads every file, draws 67 routes, and the suite passes. As a control, the probe printed the 9.3.5 settings as `{:limit=>10, :limit_param=>:per_page, :limit_max=>50, :overflow=>:last_page, :limit_extra=>true}`, matching the 8.6.3 `items` values one for one. `per_page=500&page=2` still caps the page size at 50.

### B. The page view calls `@pagy.items`, which no longer exists
- **Affected code:** `/home/user/workspace/repo/app/views/notes/index.html.erb`, line 30 (the per-page `select`).
- **What breaks:** The notes list cannot render, because `Pagy#items` was renamed to `#limit` in 9.0.0. Line 30 runs on every visit to `GET /notes`.
- **Applicability:** 9.0.0, immediately on the bump. The repair only works on 9.x, so ship it together with the bump.
- **Recommended repair:** On line 30, change `options_for_select([5, 10, 25, 50], @pagy.items)` to `options_for_select([5, 10, 25, 50], @pagy.limit)`.
- **Validation:** The existing assertion in `test/controllers/notes_controller_test.rb:60` (`select[name=per_page] option[selected]` is `"5"` when `per_page=5`) passed on 9.3.5 with the repair. As a control, the default page size still selects 10.

### C. Bad page numbers now raise an error instead of showing page 1
- **Affected code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb`, `#index` line 18 (`@pagy, @notes = pagy(@notes)`).
- **What breaks:** `GET /notes?page=0` (and `page=-1`, `page=two` or `page=`) now raises `Pagy::VariableError: expected :page >= 1; got 0`, which is a 500 error in production. On 8.6.3 these requests show page 1.
  - Cause: in 8.6.3, Pagy's `pagy_get_page` read the page parameter as `[params[...].to_i, 1].max`, so anything below 1 became 1. In 9.x it is `(page || 1).to_i` with no minimum, so an empty `page=` becomes 0, which is invalid.
  - This was the one failing test on 9.3.5: `NotesControllerTest#test_invalid_pages_show_the_first_page_and_page_size_is_capped_at_50`. The changelog does not mention it.
- **Applicability:** 9.0.0, immediately on the bump. The repair below also works on 8.6.3 (confirmed by probe), so it can be deployed before the bump. It has no stored-data effects.
- **Recommended repair:** Add this under `private` in `NotesController`:
  ```ruby
  # Pagy 9 no longer clamps the page param; keep blank, zero, negative, and non-numeric pages on page 1.
  def pagy_get_page(vars, **)
    [params[vars[:page_param] || Pagy::DEFAULT[:page_param]].to_i, 1].max
  end
  ```
  - The `**` lets the method accept the extra `force_integer:` keyword that 9.x passes while still working on 8.x, which passes no keyword.
  - Calling `super` instead would break on 8.6.3: Ruby would forward `force_integer:` to a method that does not accept it, raising `ArgumentError`.
  - Lowering the 9.x minimum-page check instead would let page 0 through and produce a negative offset.
- **Validation:**
  - Fails without the repair: the test above, run on 9.3.5, uses 52 notes with distinct `created_at` hours across two users' notebooks. For page `"0"`, `"-1"` and `"two"` it expects `.note` count 10, first note "Chapter 50", and range text "Displaying notes 1-10 of 52 in total". It raised `VariableError` without the repair and passed with it.
  - Same result on both versions: a probe with the override defined in place returned page 1 for `""`, `"0"`, `"-1"` and `"two"` on 8.6.3 and on 9.3.5.
  - Control: `per_page=500&page=2` still shows the last two notes. The previous-page link's query string is still `{"per_page"=>"50","page"=>"1"}`, and `per_page=50&page=9` still falls back to the last page ("51-52 of 52").

### D. Changelog entries checked that do not affect this app
- **Removed JavaScript files and CSS extras:** the app uses neither.
- **Size given as an array (the classic bar):** the app does not use it. The textual matches were unrelated `requests.size` lines in tests.
- **Constructor arguments changed to keyword arguments:** the app only calls `pagy(...)`, which handles this. The match in `app/jobs/citation_enrichment_job.rb` was unrelated.
- **`anchor_string` and `fragment`:** the app does not use them.
- **Renamed keyset and link-header names:** the app does not use them.
- **`pagy_url_for(@pagy, page)`** (view lines 61–62): still works. The test's link-query assertion passed.
- **`:item_name` behaviour change in 9.3.3:** the app passes a plain string. Output was identical on both versions: `Displaying notes 11-20 of 52 in total`. The reminder and model matches from commit `26b8117` were unrelated.

## 2. New configuration defaults across intermediate releases

Pagy has no Rails `load_defaults` settings. Version by version (9.0.x, 9.1.x, 9.2.x, 9.3.x), the only changes to its `Pagy::DEFAULT` settings were renames, and those are covered in 1A. 9.0.0 dropped `DEFAULT[:anchor_string]`, which the app never set. 9.2.0 deprecated `:after_latest` and 9.3.0 removed `:typecast_latest`; both are keyset-only and not used here. The probe confirmed `:limit_extra` defaults to `true`, so `per_page` keeps working. Nothing else needs configuring.

## 3. Rollout, rollback, and mixed-version risks

- **Database, `db/schema.rb`, Redis cache, cookies, tokens, queued jobs:** Pagy touches none of them. The Gemfile.lock diff contains only `pagy 8.6.3 → 9.3.5`, with no other gem moving.
- **URLs:** pagination links use `page` and `per_page` on both versions, so links built by an 8.6.3 server work on 9.3.5 and the reverse.
- **Mixed versions during rollout:**
  - Fix C must be live on any server running 9.3.5. Deploy it first, on 8.6.3, where it is safe and changes nothing (verified).
  - Fixes A and B cannot run on 8.6.3, so they must go out together with the bump.
- **Rollback:** reverting needs Gemfile, initializer and view rolled back together. Fix C can stay in place.

## 4. Verification log and open questions

**Executed in the workspace (`/tmp/upgrade-pagy-9.3.5`, deleted by cleanup):**
- **`setup`:** the bundle resolved with only `pagy 8.6.3 → 9.3.5` changing.
  - 8.6.3: started OK, 67 routes, 46 runs, 325 assertions, 0 failures.
  - 9.3.5: failed to start with the `LoadError` in 1A.
- **`test` after fixes A and B:** 46 runs, 305 assertions, 1 error (the `VariableError` in 1C).
- **`test` after fix C:** 46 runs, 325 assertions, 0 failures, 0 errors.
- **`probe`, run 1:** compared the Pagy source on both versions (`pagy_get_page` reading the page parameter, and the minimum-value check). It also showed `Pagy.new(page: "0" | "-1" | "two")` raises on both, and that `pagy_info` output was identical.
- **`probe`, run 2:** applied the override to `NotesController` and parsed pages and limits on both versions with the same results. `per_page=0` and `per_page=abc` raise `VariableError: expected :items >= 1; got 0` on 8.6.3 (`:limit` on 9.3.5). This is an existing bug, not a regression.
- **Logs** (deleted along with the workspace): `/tmp/upgrade-pagy-9.3.5/logs/{bundle-update,diag-baseline,diag-upgraded,schema-load-*,tests-baseline,tests-upgraded}.log`.
- The repair checks in that second probe used `Note.none`, i.e. zero records. The previous-link query string and the 52-record ranges were verified only by the controller test run.

**Based on reading source and the changelog:** the items in 1D. The `gem-changes` script could not unpack the 9.x gem files ("is not an octal string"), so it saw only the commit and changelog lists, not the code changes inside the gems. I read the backend and core Pagy code through the probes.

**Open questions:**
- Should `per_page=0` / `per_page=abc` be fixed too? They return a 500 on both versions today. Overriding `pagy_get_limit` the same way as the page fix would cover it, but that is outside this upgrade.
- The view at lines 61–62 is the only frontend Pagy code exercised. No browser (system) test was run.

---

**Notes:**
- I haven't changed your repository. This is only a plan. The planner tested the changes in a temporary copy that has since been deleted.
- Before making the changes, two things are worth deciding:
  - Whether to deploy the page-number fix in `NotesController` on its own first. It works on the current version, so it can go out before the gem upgrade.
  - Whether to also handle `per_page=0` and `per_page=abc`. Both already return a server error today, so this isn't caused by the upgrade.
- Run `bin/rails test:system` as well, since the planner didn't run the browser tests.

Tell me if you want me to make the changes.