# Upgrade plan: pagy 8.6.3 to 9.3.5 (Margin Notes)

The upgrade needs three changes. Without them the app fails at boot, the notes list returns a 500 for every reader, and bad `?page=` values crash. With all three applied in a disposable copy, the full suite passed (46 runs, 0 failures). Nothing else in the app is affected, and there is no stored data, queued work or cache that depends on pagy.

Pagy has no Rails-style "new framework defaults". The 9.x releases rename settings and change some behavior, and none of that is opt-in. I worked through 9.0.x, 9.1.x, 9.2.x and 9.3.0–9.3.5 from the change summary (`/tmp/pg/changes.txt`) and the upstream release notes.

## Where the app uses pagy
- `config/initializers/pagy.rb`: loads the `items` and `overflow` extras and sets the page size to 10, the `per_page` URL parameter, a cap of 50, and `overflow = :last_page`.
- `app/controllers/notes_controller.rb:2,18`: `include Pagy::Backend` and `pagy(@notes)`.
- `app/helpers/application_helper.rb:2`: `include Pagy::Frontend`.
- `app/views/notes/index.html.erb:30,40,59-62`: `@pagy.items`, `pagy_info(..., item_name:)`, `@pagy.pages`, `prev`, `next` and `pagy_url_for`.

## Required changes

### R1. Rename the initializer settings ("items" became "limit" in 9.0.0)
- **Affected:** `config/initializers/pagy.rb`.
- **What breaks if nothing is done (seen):** the app doesn't boot. `cannot load such file -- pagy/extras/items (LoadError)` (log: `/tmp/pg/up_noinit.log`).
- **Repair:** load `pagy/extras/limit` instead, and rename the three settings: `DEFAULT[:items]` to `[:limit]`, `[:items_param]` to `[:limit_param]`, and `[:max_items]` to `[:limit_max]`. Keep `overflow`. The URL parameter stays `per_page`, so existing links and bookmarks keep working.
- **This only works on 9.x.** Ship it in the same deploy as the gem bump.

### R2. The view calls `@pagy.items`
- **Affected:** `app/views/notes/index.html.erb:30`.
- **What breaks if nothing is done (seen):** every request to the notes list returns a 500. `ActionView::Template::Error: undefined method 'items' for an instance of Pagy` (log: `/tmp/pg/up_init.log`, 7 errors). That includes the redirect after sign-in.
- **Repair:** use `@pagy.limit`. This only works on 9.x (on 8.6.3, `respond_to?(:items)` is true and there is no `limit`).

### R3. Bad `page` values now raise an error instead of falling back to page 1
This isn't in the change summary. I found it by running the suite.
- **Cause:** in 8.6.3, `Pagy::Backend#pagy_get_page` returned `[params[:page].to_i, 1].max`. In 9.3.5 it returns `(page || 1).to_i` with no lower bound.
- **What breaks if nothing is done (seen):** `?page=`, `?page=0`, `?page=-1` and `?page=two` raise `Pagy::VariableError: expected :page >= 1; got 0` (or `got -1`), which is a 500 in production. Stale or hand-edited URLs would hit this. The test at `test/controllers/notes_controller_test.rb:74` catches it (log: `/tmp/pg/up_full.log`). I confirmed each value in `/tmp/pg/pages.rb`; `"3"` still works.
- **Repair:** add a private override in `NotesController`:
  ```ruby
  def pagy_get_page(...)
    [super.to_i, 1].max
  end
  ```
  - It brings back the 8.x behavior.
  - Page numbers past the end are still handled by the `overflow: :last_page` setting.
  - The `...` forwarding also accepts 9.x's `force_integer:` keyword. The app never calls the non-integer form.
- **This also works on 8.6.3 (tested),** so it can ship first as a preparatory change. A copy running pagy 8.6.3 with only this override passed 46/46 (log: `/tmp/pg/v8_prep.log`).
- **Alternatives (not recommended):**
  - Clean the page value in `index` and pass it as `pagy(@notes, page: ...)`. This works too, but it repeats the lookup of the `page` parameter.
  - Rescuing `Pagy::VariableError` would hide other configuration errors.

## Checked, no action needed
- **9.3.3, `item_name` now defaults to the `:other` key:** the app passes an already pluralised string. `pagy_info` gives the same output on both versions: "Displaying 1 note" and "Displaying 2 notes" (`/tmp/pg/info.rb`). The ".range" assertions also pass.
- **9.0.0, `limit_max` rename:** handled by R1. Requests with `per_page=500` are still capped at 50, and the test assertions at lines 87–91 pass.
- **9.0.0, keyword arguments for `Pagy.new` and `pagy()`:** the app passes no option hash.
- **9.0.0, fragment, anchor_string and 8.x deprecation removals:** not used.
- **9.0.2, `pagy_link_header`:** not used.
- **9.0.3, removed JS files and `pagy*_get_vars`:** not used. The app has no pagy JS and no custom frontend helpers.
- **9.0.1 `tuple_comparison`, 9.2.0 `after_latest`/`filter_newest`, 9.3.0 `typecast_latest`:** these belong to the keyset and calendar extras, which the app doesn't use.
- **9.3.3, removal of `:other` from the `aria_label` key:** the app has no pagy nav helpers and no custom pagy locale entries (`config/locales/en.yml` has none).
- **`pagy_url_for` and the prev/next query strings:** they still keep the filters and `per_page`, checked by the test at line 48.

## Rollout and rollback
- **Order:**
  1. Optionally deploy R3 alone on 8.6.3.
  2. Deploy the gem bump with R1 and R2 together. They can't be applied separately from the bump in either direction.
- **No persisted state:** the app stores no data, jobs or cache entries that depend on pagy.
- **Mixed-version servers:** both versions generate the same URL format (`page` and `per_page`), so links from old servers work on new ones and the other way round.
- **Rollback:** revert the Gemfile, the initializer and the view together. R3 can stay in place.

## Validation
Each check fails on 9.3.5 without its repair and passes with it.
1. **R1:** `bin/rails zeitwerk:check` or booting the app gives a LoadError without the repair and succeeds with it.
2. **R2:** sign in as fixture user and run `GET /notes`. It gives the `undefined method 'items'` 500 without the repair. With it, it returns 200 and `select[name=per_page] option[selected]` equals 10, or 5 when `?per_page=5`.
3. **R3:** `GET /notes?page=` with `0`, `-1` and `two` (test line 74, with 52 notes). Without the repair it raises `VariableError`. With it, each returns 10 notes, the first is "Chapter 50", and the page shows "Displaying notes 1-10 of 52 in total".
4. **Controls, behavior that must stay the same:**
   - `?per_page=500&page=2` shows notes 51–52 and its prev link carries `per_page=50&page=1`.
   - `?per_page=50&page=9` shows the last page.
   - Filtered pagination keeps its query parameters.
   - `pagy_info` output for counts of 1 and 2 is identical across versions.

## Experiments (executed)
- **Setup:**
  - Ruby 3.3.6 at `~/.local/share/mise/installs/ruby/3.3.6/bin`. The mise shim fails in a non-interactive shell.
  - Copies at `/tmp/pg/app` (pagy 9.3.5, via `bundle update pagy --conservative`, log `/tmp/pg/bundle.log`) and `/tmp/pg/app8` (8.6.3 plus the R3 override). `.git` was removed from both.
- **Isolation:**
  - Separate PostgreSQL databases (`margin_notes_pagyexp_test` and `margin_notes_pagyexp8_test`), dropped afterwards.
  - Disk storage under each copy's `tmp/storage`.
  - The test environment's `null_store` cache and `:test` job adapter.
- **Logs (all under `/tmp/pg`):**

| Run | Log | Result |
|---|---|---|
| Baseline on 8.6.3 | `baseline.log` | 46/46 pass |
| 9.3.5, no changes | `up_noinit.log` | LoadError at boot |
| 9.3.5 + R1 | `up_init.log` | 7 errors |
| 9.3.5 + R1 + R2 | `up_full.log` | 1 error |
| 9.3.5 + R1 + R2 + R3 | `up_fixed.log` | 46/46 pass |
| 8.6.3 + R3 only | `v8_prep.log` | 46/46 pass |

- The working repo was not modified.

## Not verified
- The browser suite (`bin/rails test:system`) was not run.
- I didn't confirm through a full production-mode request that a `VariableError` shows up as a 500; I'm inferring that from it being an unhandled error.
- I didn't check the HTML output of pagy helpers the app doesn't use.

---

This is only a plan. Your repo is unchanged: the Gemfile still pins pagy to `8.6.3`. To apply it, you'd also change the Gemfile pin to `"9.3.5"` and run `bundle update pagy --conservative`. Do you want me to make these changes?