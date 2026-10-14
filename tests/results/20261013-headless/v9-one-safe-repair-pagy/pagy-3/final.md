The upgrade-gem skill only plans upgrades, so I haven't changed anything in the repo. Here is the planner's full report on going from pagy 8.6.3 to 9.3.5:

---

The upgrade from pagy 8.6.3 to 9.3.5 is small: three required changes in two files plus one controller method, and no framework-default decisions. On 9.3.5 unchanged, the app fails to boot. With the renames alone, 1 test fails. With all three changes, the full suite passes (46 runs, 0 failures).

**Tool output.** `gem-changes` read releases 9.0.9, 9.1.1, 9.2.2 and 9.3.5 but found 0 changelog entries, because pagy doesn't ship a changelog. So everything below comes from comparing the installed 8.6.3 and 9.3.5 gem source and from running the app. I did not read pagy's online release notes or upgrade guide.

**Where the app uses pagy:** `config/initializers/pagy.rb`, `app/controllers/notes_controller.rb` (`include Pagy::Backend`, `pagy(@notes)`), `app/helpers/application_helper.rb` (`include Pagy::Frontend`), and `app/views/notes/index.html.erb` (`@pagy.items`, `pagy_info`, `pagy_url_for`, `prev`/`next`/`pages`).

## Required changes

**1. The `items` extra was renamed to `limit` (confirmed by running it).**
- **What breaks:** the app won't boot: `cannot load such file -- pagy/extras/items (LoadError)` from `config/initializers/pagy.rb:2`.
- **Fix:** in the initializer, change:
  - `require "pagy/extras/limit"`
  - `DEFAULT[:items]` to `DEFAULT[:limit]`
  - `:items_param` to `:limit_param`
  - `:max_items` to `:limit_max` (not `:max_limit`; see `pagy-9.3.5/lib/pagy/extras/limit.rb:7-8`)
- **Silent risk:** if only the `require` line is changed, the old keys are ignored without warning. 9.3.5 would then default to 20 per page, read the page size from `limit` instead of `per_page`, and cap it at 100. Existing `?per_page=` bookmarks and links would stop working. Keeping `limit_param = :per_page` keeps those URLs working.
- **Check:** `notes_controller_test.rb:48` and `:74` assert the default of 10, that `per_page` is kept in links, and the cap of 50.

**2. `Pagy#items` was renamed to `Pagy#limit` (confirmed).**
- **What breaks:** every page that renders the note list (the note list itself and the redirect after sign-in) fails with `ActionView::Template::Error: undefined method 'items' for an instance of Pagy` at `app/views/notes/index.html.erb:30`. This caused 7 test errors in that run.
- **Fix:** change it to `@pagy.limit`.

**3. Invalid `page` values now return a 500 instead of page 1 (confirmed; the tool's text matching did not catch this).**
- **Why:** 8.6.3's `pagy_get_page` clamped the value (`[params[...].to_i, 1].max`). 9.3.5 uses `(page || 1).to_i` with no clamp, and the `overflow` extra only handles `OverflowError`, not this error.
- **What breaks:** `?page=`, `?page=0`, `?page=-1` and `?page=two` raise `Pagy::VariableError: expected :page >= 1; got 0` from `notes_controller.rb:18`. This is the only failure left after fixes 1 and 2 (`notes_controller_test.rb:74`). It affects stale or hand-edited URLs and crawlers.
- **Recommended fix:** add a private override in `NotesController`. I tested this exact method:
  ```ruby
  def pagy_get_page(vars, **)
    [params[vars[:page_param] || Pagy::DEFAULT[:page_param]].to_i, 1].max
  end
  ```
  - The `**` lets it accept both the 8.x one-argument call and the 9.x `force_integer:` keyword.
  - It also works on 8.6.3 (full suite plus probes: 56 runs, 0 failures), so it can ship before the gem bump.
  - Only the keyset extra uses `force_integer: false`, and the app doesn't use it.
- **Alternative (not recommended):** `rescue_from Pagy::VariableError` with a redirect. It would also catch the `per_page` errors below and adds an extra round trip.

## Not caused by the upgrade

- **Invalid `per_page` already errors on 8.6.3.** `per_page` values of `0`, `-3`, `abc` or empty raise `Pagy::VariableError` on both versions (`expected :items >= 1` on 8, `expected :limit >= 1` on 9). Fixing it would be a separate decision.
- **Nothing else changes for this app (probe results):** `per_page=500` is capped at 50, `page=99` shows the last page, and `page=2.5` behaves the same on both versions. Neither `?items=` nor `?limit=` is honoured on either version.
- **`pagy_info` and `pagy_url_for` keep the same signatures.** The "Displaying notes 1-10 of 52 in total" assertion passes on 9.

## Framework defaults and rollout

- **New defaults:** pagy has no opt-in defaults like Rails. The only changes are the renamed default keys (`limit: 20`, `limit_param: :limit`, `limit_max: 100`). The app keeps its old values (10, `per_page`, 50) once the keys are renamed. Leaving the keys un-renamed would mean adopting the new defaults, which I don't recommend.
- **Stored data and queued work:** pagy stores nothing and no jobs use it. The only persisted state is user URLs, and those stay valid because of the `per_page` mapping.
- **Mixed-version rollout:** both versions produce the same links. Ship the `pagy_get_page` override first (it works on 8), then the gem bump together with the initializer and view renames in one commit. Changes 1 and 2 must ship with the bump because they fail on the other version. To roll back, revert that commit; the override can stay.

## Experiments

All runs were in disposable copies at `/tmp/pagyx` (upgraded to pagy 9.3.5 via `bundle update pagy --conservative`) and `/tmp/pagyx8` (8.6.3). Both used `RAILS_ENV=test` and an isolated database, `pagyx_test`, which I dropped afterwards. Test config uses a null cache, the `:test` queue adapter and disk storage inside the copy. The real repo was not modified.

| Variant | Result | Log |
|---|---|---|
| Baseline 8.6.3 | 46 runs, 0 failures | `/tmp/pagyx-test-8.log` |
| 9.3.5, unchanged | `LoadError` at boot | `/tmp/pagyx-test-9.log` |
| 9.3.5, `require` line only (A) | 7 errors (`items` NoMethodError) | `/tmp/pagyx-test-9A.log` |
| 9.3.5, all renames (B) | 1 error (`VariableError :page`) | `/tmp/pagyx-test-9B.log` |
| 9.3.5, renames plus override (C) | 46 runs, 0 failures; `zeitwerk:check` OK | `/tmp/pagyx-test-9C.log` |
| 8.6.3 plus override | 56 runs, 0 failures | `/tmp/pagyx-test-8-override.log` |

- Probe logs: `/tmp/pagyx-probe-9C.log` and `/tmp/pagyx-probe-8.log`. The probe test is `/tmp/pagyx/test/controllers/probe_test.rb`.
- Bundle output: `/tmp/pagyx-bundle.log`.

## Not yet checked

- I didn't run the system tests, start a server, or check production behaviour. The claim that `VariableError` becomes a 500 is inferred, not observed.
- I only checked the English locale; it's the same file in both versions.
- After shipping, request `/notes?page=0` and confirm it returns a 200 showing page 1.

---

Want me to make these changes? That means pinning `pagy` to `9.3.5` in the Gemfile, renaming the settings in the initializer and the view, and adding the `pagy_get_page` override. Then I'd run `bin/rails test` and `bin/rails test:system`, since the planner didn't run the system tests.