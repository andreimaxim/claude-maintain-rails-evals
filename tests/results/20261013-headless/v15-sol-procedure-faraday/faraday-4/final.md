## Upgrade plan: faraday 1.10.4 → 2.12.2 (Margin Notes)

**Verdict:** The upgrade is feasible with three required repairs. Without them it breaks at boot. With all three in the lab copy, every check passed: bundle, boot, eager-load, routes, database, and 46 tests with 325 assertions and 0 failures. The real checkout is unchanged (`git status` is clean, HEAD is still `ab732f5`). I did not run system tests or a production-mode boot.

### Required repairs

**1. Pin `json` to the 2.7 line.** This can ship before the bump.
- **Cause:** faraday 2.12 added `json` as a runtime dependency (commit 9e5c8a1, #1589). Bundler then picked json 3.1.0. Since json 3.0.0, unknown options raise `ArgumentError`, and Active Support 7.0.8.7 passes `quirks_mode` when `config/secrets.yml` is rendered at boot.
- **Observed failure:** `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`, via `railties-7.0.8.7/lib/rails/secrets.rb:29`. Boot, eager-load, routes, database and tests all failed. Log: `/tmp/gem-upgrade-20261014-8179-oaotk8/runs/20261014T154018-12286b-unmodified-boot/output.log`
- **Repair:** add `gem "json", "~> 2.7.2"` to the Gemfile with a comment linking it to Active Support 7.0. It resolves to 2.7.6; the app currently loads Ruby's built-in 2.7.2. Remove the pin when Rails is upgraded.
- **Works on 1.10.4 (executed):** in a fork still on faraday 1.10.4, all 6 checks passed (46 runs, 0 failures).
- **Queued jobs (executed):** a CitationEnrichmentJob Sidekiq payload is byte-identical between json 2.7.2 and 2.7.6. Old-writer/new-reader and new-writer/old-reader both passed.

**2. Add `faraday-retry`.** This ships with the bump.
- **Cause:** Faraday 2.0 moved the retry middleware into its own gem. It affects `app/models/citation/provider.rb:37`.
- **Observed failure:** `Faraday::Error: :retry is not registered on Faraday::Request` (`faraday-2.12.2/lib/faraday/middleware_registry.rb:57`). The result was 2 errors and 1 failure in `test/controllers/citation_enrichments_controller_test.rb`. Every lookup raised an unrescued error, so enrichment jobs crashed instead of finishing or recording a failure. Log: `/tmp/gem-upgrade-20261014-8179-oaotk8/runs/20261014T154222-89a0a9-json-constraint2-tests/output.log`
- **Repair:** add `gem "faraday-retry", "~> 2.2"` (resolves 2.4.0). `Bundler.require` loads it; adding `require "faraday/retry"` in `provider.rb` is optional. faraday-retry 2.x needs faraday 2, so it can't land earlier.

**3. Switch `:basic_auth` to `:authorization, :basic`.** This must be in the same commit as the bump.
- **Cause:** Faraday 2.0 dropped the `:basic_auth` middleware (#1308). It affects `provider.rb:38`.
- **Observed failure:** `Faraday::Error: :basic_auth is not registered on Faraday::Request`. Log: `/tmp/gem-upgrade-20261014-8179-oaotk8/runs/20261014T154247-47c64f-retry-gem-tests/output.log`
- **Repair:** `faraday.request :authorization, :basic, @user, @password`
- **Fails on 1.10.4 (executed):** `faraday-1.10.4/lib/faraday/request/authorization.rb:48:in 'initialize': wrong number of arguments (given 4, expected 3)`. Log: `/tmp/gem-upgrade-20261014-11300-kn43sz/runs/20261014T154500-a6ca14-probe-auth-repair-on-1x/output.log`

**Stored data and rollback:** none of the repairs touch the database, cache or stored files. The Authorization header bytes are unchanged. Repairs 2 and 3 roll back with the bump; repair 1 can stay.

### Optional defaults
None. `defaults.json` was empty for faraday and every moved dependency. The default adapter is still `:net_http` (`lib/faraday.rb:155` at v2.12.2).

### Rollout order
1. Merge the json pin on faraday 1.10.4 and deploy.
2. In one commit: bump faraday to 2.12.2, add faraday-retry, and change the auth middleware.
3. No data migration is needed. Jobs queued under either version run fine under the other.

### Validation (executed)
I wrote one probe for the citation provider (`/home/user/planner-run/probes/faraday_provider_probe.rb`). It gave identical results on the current version and the repaired upgrade, 0 failures on each. It covered:
- **Credentials:** the auth header with non-ASCII user and password, and with a nil password.
- **Retries:** 503 then 200 gives two requests, both with the header. Two 503s give `Unavailable` after 2 requests. A 500 is not retried (the control case).
- **Errors:** a 401 gives `Error`. A read timeout gives `Unavailable` after one retry (about 11s). A refused connection gives `Unavailable`.
- **URL check:** a 9-URL table through `web_url?`, which matters because uri 1.0 changed its default parser.

The same probe on the upgrade with repair 3 reverted fails with the `:basic_auth` error.

Source-based only: I compared faraday-retry 1.0.4 with 2.4.0 and the net_http adapter 1.0.2 with 3.4.4. They have the same exception lists, retryable methods and timeout mapping. The adapter adds `Errno::EALREADY`. faraday-retry 2.x also obeys a `RateLimit-Reset` header.

### Limits
- I did not run system tests or a production-mode boot.
- I did not run the open-timeout path against an unreachable host. The net-http 0.8/0.9 timeout changes are judged from source only: both still raise errors the app already rescues.
- I did not contact the real citation provider; only local fakes were used.
- I did not test the `RateLimit-Reset` handling in faraday-retry 2.x.
- json 3 can't be used until Rails is upgraded.
- I didn't read all 251 faraday commits one by one: I read the upgrade guide and the 2.0 and 2.12 removals, scanned the other titles, and compared the code the app uses at both versions.

### Files
- Evidence and closed review: `/home/user/planner-run/evidence/faraday/` (`review.json`, `coverage.json`, `dependencies.tsv`, `dependencies/`). `gem-upgrade-review check` passed: 63 candidates, 3 findings, 5 limits.
- Probes: `/home/user/planner-run/probes/faraday_provider_probe.rb`, `/home/user/planner-run/probes/job_payload_probe.rb`, with payload output in `/home/user/planner-run/probes/out/`.
- Labs (services cleaned up, evidence kept):
  - Baseline: `/tmp/gem-upgrade-20261014-6937-a8c1vb`
  - Upgraded with repairs: `/tmp/gem-upgrade-20261014-8179-oaotk8` (see `app/Gemfile`, `app/app/models/citation/provider.rb`)
  - Version-compatibility fork: `/tmp/gem-upgrade-20261014-11300-kn43sz`

---

**Next step:** I haven't upgraded anything yet. This is the plan, and your repository is unchanged. If you want me to go ahead, I'll do the two steps in order: first the `json` pin by itself, then one commit with the faraday bump, `faraday-retry` and the auth change. After that I'll run `bin/rails test` and `bin/rails test:system`, since the browser tests weren't run during planning.