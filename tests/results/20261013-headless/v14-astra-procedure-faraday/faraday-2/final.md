Here's the upgrade plan for faraday 1.10.4 → 2.12.2, as the planner returned it. Your working copy hasn't been changed yet.

---

Upgrading faraday from 1.10.4 to 2.12.2 needs two code changes and one new gem constraint, all shipped in a single deploy. With those changes applied in a lab copy, the app boots, the database prepares, eager loading and routes work, and the test suite passes (46 runs, 325 assertions, 0 failures, the same as before). Your checkout at `/home/user/workspace/repo` was not changed.

Faraday is only used in `app/models/citation/provider.rb` (`Citation::Provider`). Every 2.x version broke it unchanged:
- **2.0.1 through 2.11.0:** 3 citation tests failed (1 failure, 2 errors).
- **2.12.2:** the app would not boot.

## Required changes (one commit, one deploy)

1. **Retry middleware moved to its own gem (F1).** Add `gem "faraday-retry", "~> 2.2"` (it resolved to 2.4.0) and put `require "faraday/retry"` at the top of `provider.rb`.
   - Without it, every lookup fails with `Faraday::Error: :retry is not registered on Faraday::Request`. The provider's error handling doesn't catch that error.
   - With it, the retry-then-success, persistent-503 (two attempts), 401 (one attempt) and unreachable-host cases give exactly the same output as the current version.

2. **`basic_auth` middleware was removed (F2).** Replace `faraday.request :basic_auth, @user, @password` with:
   ```ruby
   faraday.request :authorization, :basic, @user, @password
   ```
   - Without it, every lookup fails with `:basic_auth is not registered on Faraday::Request`.
   - With it, the `Authorization` header is byte-for-byte the same as today (`Basic [REDACTED]`, using awkward test credentials).
   - This new form fails on 1.10.4 (`ArgumentError: wrong number of arguments (given 4, expected 3)`), so it can't go out before the bump.

3. **Constrain json below 3 (F3).** Add `gem "json", "< 3"`. faraday 2.12.2 adds a `json` dependency, and Bundler picked json 3.1.0. That stops Rails 7.0 from booting while it reads `config/secrets.yml`: `unknown keyword: quirks_mode (ArgumentError)` from `activesupport-7.0.8.7 json/encoding.rb:110`. With the constraint, json resolved to 2.21.2 and everything passed.

**Rollout and rollback:** deploy all three together, since faraday-retry 2.x needs faraday 2 and the new auth line needs faraday 2. To roll back, revert the whole commit (Gemfile, Gemfile.lock, `provider.rb`). No stored data, cookies or queued job payloads change. If a deploy goes wrong, the affected enrichment jobs show as Failed with the existing "Fetch again" button.

**Optional framework defaults:** none were found for this upgrade.

## Not checked
- **json range:** json jumps from 2.7.2 to 2.21.2. That range rejects invalid escape sequences (2.17), warns on duplicate keys (2.13) and deprecates comments (2.20). Only the test suite and the probe exercised this. A tighter pin such as `~> 2.7.2` was not tried.
- **json constraint on the current version:** adding it to 1.10.4 first was not tested. It would be checked by adding it to the baseline copy and rerunning the checks.
- **Commit-level review:** I did not read every commit. 62 source pages are marked unknown (the commit pages for faraday, faraday-net_http, faraday-retry, json, net-http and uri, whose release tags don't share history). I only inspected the request-middleware registration and the authorization middleware in the full faraday diff.
- **Other moved libraries:** net-http (0.4.1 to 0.10.0), uri (0.13.1 to 1.1.2) and faraday-net_http (1.0.2 to 3.4.4) were covered only by the tests and the probe.
- **Not run:** the browser tests (`bin/rails test:system`), and anything against the real production provider. All HTTP went to a local test server.
- **Probe records:** the probe runs in the run list show "passed" because the script finished. The actual pass/fail of each assertion is in the probe logs.

## Files
Everything is in `/tmp/gem-upgrade-20261014-71584-65rr8s`; its databases have been removed, and copies and logs are kept.
- **Plan:** `plan.json` (source notes per page are in the JSON, not the rendered text).
- **Probe:** `probes/provider_probe.rb`
- **Repaired copy:** `variants/v2_12_2_fixed/app` (Gemfile, Gemfile.lock, `app/models/citation/provider.rb`)
- **Comparison copies:** `variants/v2_12_2_auth_unchanged/app` (retry and json fixed, old auth line kept) and `variants/baseline_auth_middleware/app` (new auth line on 1.10.4).
- **Key run records:**
  - `runs/v2_12_2/003-boot.json` (the json boot failure)
  - `runs/v2_0_1/007-tests.json` and `runs/v2_11_0/007-tests.json` (unchanged-code test failures)
  - `runs/v2_12_2_fixed/008-tests.json` and `runs/v2_12_2_fixed/009-probe.json` (repaired results)
  - `runs/baseline/007-probe.json` and `runs/baseline/006-tests.json` (current-version reference)
- **Source research:** `sources/index.md` and `dependencies-v2_12_2_fixed/index.md`

---

The `"< 3"` limit on json works around a gem conflict and isn't really about faraday. If you'd rather control which json version you get, a tighter pin is worth trying. Before shipping, it's also worth running `bin/rails test:system` and making a real call to the production citation provider, since neither was tested. If you want, I can apply the three changes to your working copy on a branch.