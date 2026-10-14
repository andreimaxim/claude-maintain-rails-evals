Here's the upgrade plan; I haven't changed your checkout. The planner tested everything in a throwaway copy under `/tmp`.

# Upgrade plan: pagy 8.6.3 to 9.3.5 (Margin Notes)

pagy 9.3.5 needs two code changes in this app. With both applied to a copy, the regular test suite passed (46 runs, 325 assertions, 0 failures, 0 errors), as did a set of 5 small check tests. Nothing in the original checkout was edited or run. The only gem that changes in `Gemfile.lock` is pagy, and Ruby 3.3.6 meets pagy 9's requirement of Ruby 3.1 or later.

## Required changes

### F1. pagy renamed "items" to "limit"

**Where:** `config/initializers/pagy.rb` lines 2 and 6–8, and `app/views/notes/index.html.erb` line 30.

**What breaks:**
- **Without the change**, the app does not start on any 9.x version tested (9.0.9, 9.1.1, 9.2.2, 9.3.5). The error is `cannot load such file -- pagy/extras/items (LoadError)`.
- **If you rename only the `require` line**, the old `:items` settings are silently ignored:
  - Pages show 20 notes instead of 10.
  - The `per_page` parameter is ignored (asked for 25, got 20).
  - Links pick up an extra `limit=20`, for example `{per_page:7, page:2, limit:20}`.

**Change** (the initializer, shown as a diff):
```ruby
require "pagy/extras/limit"
Pagy::DEFAULT[:limit] = 10
Pagy::DEFAULT[:limit_param] = :per_page
Pagy::DEFAULT[:limit_max] = 50
```
In the view, change `@pagy.items` to `@pagy.limit`. The overflow setting (`:last_page`) stays as it is.

**Rollout and rollback:** pagy 8.6.3 has no "limit" extra, so this must ship in the same deploy as the gem bump. Roll back by reverting both together. The `per_page` URL parameter keeps its name, so existing bookmarks still work.

**Evidence:**
- Sources: changelog entries 324aa7fbe739 and d72f47b2ab89, and the pagy migration guide.
- Run records: `runs/v9_3_5/003-boot.json` (failure), `runs/v9_3_5_partial/001-probe.json` (silent ignore), `runs/v9_3_5_fix2/006-tests.json` and `007-probe.json` (fixed), `runs/baseline/007-probe.json` (current behaviour).

### F2. Invalid page numbers now cause a server error

This one is not in pagy's changelog. It showed up as a test failure and is confirmed by the code diff.

**What changed:** pagy 8 forced bad `page` values up to 1. pagy 9.3.5 just converts the value to a number and then rejects anything below 1. As a result `page=""`, `0`, `-1` or `two` on `/notes` now returns HTTP 500 with `Pagy::VariableError: expected :page >= 1; got 0`. The existing test "invalid pages show the first page and page size is capped at 50" errors with only F1 applied.

**Change** in `app/controllers/notes_controller.rb` line 18:
```ruby
@pagy, @notes = pagy(@notes, page: [params[:page].to_i, 1].max)
```

**Rollout:** pagy 8.6.3 also accepts a `page:` option, so this can ship before or with the bump. That has not been run on 8.6.3 yet.

**Evidence:**
- With F1 only: the suite had 1 error, and the check test for page `0` / `two` errored (`runs/v9_3_5_fix/`).
- With both changes: page `0` and `two` both returned 200 (`runs/v9_3_5_fix2/`).
- Unaffected paths still behave as before: `page=2` works, and `page=99` still shows the last page.

## Low risk

**F3. Item-name wording (9.3.3).** pagy changed how it picks the singular or plural item name. This view passes its own `item_name`, so nothing changes. The range text "Displaying notes 1-10 of 32 in total" is the same before and after. The wording for a single page or an empty list was not checked separately.

## Defaults

pagy has no new framework defaults to adopt. The `:limit` values above keep the current behaviour: 10 per page, `per_page` parameter, maximum 50.

## Gaps and checks not run

- **Browser tests:** `bin/rails test:system` was not run (it needs Chrome with a display).
- **Intermediate versions:** 9.0.9, 9.1.1 and 9.2.2 fail to start with the same LoadError. Fixed copies were only built and tested for 9.3.5.
- **Code review depth:** Of 175 upstream commits, I read the priority commits and the full diffs of pagy's backend, overflow, limit, frontend and URL-helper files. The rest are unreviewed and assumed unused, since the app does not use keyset, calendar or JavaScript extras.
- **Production and Sidekiq:** not exercised. pagy is only used in `NotesController#index`, its view, the initializer and `ApplicationHelper`.
- **F2 on the current version:** the fix has not been run on 8.6.3.

## Files

Everything is under `/tmp/gem-upgrade-20261014-71552-i3er6z/`; the paths below are relative to it. Copies and logs are kept, and the lab's databases have been dropped.
- Plan: `plan.json`
- Check tests: `probes/pagy_probe_test.rb`
- Source research: `sources/index.md` and `dependencies-target/index.md`
- Run logs: `runs/{baseline,v9_0_9,v9_1_1,v9_2_2,v9_3_5,v9_3_5_partial,v9_3_5_fix,v9_3_5_fix2}/`
- Fully fixed copy: `variants/v9_3_5_fix2/app`

---

If you want me to go ahead, I'd bump the version, make the two changes above, then run `bin/rails test` and `bin/rails test:system` in your checkout. I'd also add a request test for `page=0` and `page=two`, so the new 500 error stays covered.