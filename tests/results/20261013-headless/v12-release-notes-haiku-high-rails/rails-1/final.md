The Rails gem is now at 8.1.0, and the suite passes on it: 46 runs, 340 assertions, 0 failures. I did not commit anything.

Going from 7.0.8.7 to 8.1.0 was not a version bump. The app failed to boot on 8.1.0 and had about 20 separate breakages. The gem-upgrade planner traced each one and produced a repair patch, which I reviewed and applied. Changes:

- **Gemfile / Gemfile.lock:** `rails` is pinned to `8.1.0`. `json` is pinned to `~> 2.7` with a comment. Without the pin, 8.1.0 fails on json 3.x. Rails 8.1.4 doesn't need it, so you could take 8.1.4 instead.
- **Code repairs:** the `ActionText` allowlist, `enum` and `serialize` syntax, the multi-path `/journal` route, `Rails.application.config_for(:secrets)`, the citation retry wait, reminder `wait_until`, export `join`, import rollback and receipt, the search form, the notebook filter, the digest timezone and completion string, the import preview lookup, reminder DST display, and `show_exceptions = :none` in test.
- **Docs:** README, ARCHITECTURE, TESTING, and `docs/references/fizzy.md` now say 8.1.0 where they said 7.0.8.7. The Trix note in the layout and ARCHITECTURE is rewritten as unverified.

Decisions I made:
- `load_defaults` stays at 7.0. The planner's optional defaults adoption is not applied.
- I kept the vendored Trix 1.3.5 build. Action Text 8.1.0 depends on `action_text-trix` 2.1.19, but the layout doesn't load it. I didn't verify the editor in a browser.
- I applied the upgrade directly to 8.1.0 rather than the staged sequence the planner suggested. The skill I invoked is plan-only, but you asked for the upgrade itself, so I went past it.

Not verified:
- **System tests:** not run, because no Chrome is available here. Rich-text editing and other browser behavior are therefore unchecked.
- **Mixed-version deploys:** if any node still runs 7.0 while digest jobs are queued, the 8.1 digest payloads may fail to deserialize. Deploy all nodes together, or ship the planner's 7.0-compatible repairs first.
- **Test environment:** I ran against the planner's disposable PostgreSQL and Redis on 127.0.0.1 ports 55433 and 56380, not the shared 5432 and 6379 instances.

The planner's full written plan is not reproduced here. I can paste it if you want the item-by-item detail.