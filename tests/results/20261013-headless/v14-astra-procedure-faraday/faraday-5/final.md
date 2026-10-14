I haven't changed your repo yet. I only made a plan, and it shows that bumping the version by itself would break the app. Faraday 1.10.4 → 2.12.2 needs three changes shipped together, and with them a copy of the app passes the test suite. Here's the planner's full plan:

---

# Upgrade plan: faraday 1.10.4 → 2.12.2 (Margin Notes)

**This upgrade needs three code and Gemfile changes, and they must ship in the same deploy as the version bump.** Faraday is used in only one place, `app/models/citation/provider.rb`. In the lab copy, the upgraded version with these three repairs boots, prepares the database, eager-loads, loads routes and passes the existing suite (46 runs, 325 assertions, 0 failures). System tests were not run. Nothing in `/home/user/workspace/repo` was edited or run.

## Required changes

**1. Pin `json` below 3.**
- **Problem:** faraday 2.12 adds a dependency on any `json` version, so Bundler picks json 3.1.0. With that, the app does not boot. Rails 7.0 fails while evaluating `config/secrets.yml` with `unknown keyword: quirks_mode (ArgumentError)` (`runs/v2_12_2/003-boot.json`). Web, Sidekiq and `bin/rails runner` would all fail.
- **Fix:** add `gem "json", "~> 2.7"` to the Gemfile. It resolves to 2.7.2, which is what Ruby 3.3.6 already ships.
- **Checked on the current version:** the pin passes the full suite with faraday 1.10.4 (`runs/baseline_jsonpin/007-tests.json`), so it can ship first.

**2. The retry middleware was moved out of faraday in 2.0.**
- **Problem:** every lookup fails with `Faraday::Error: :retry is not registered on Faraday::Request`. That error is neither `Provider::Error` nor `Provider::Unavailable`, so:
  - the enrichment job's `retry_on` doesn't catch it;
  - the citation stays `pending`, which also blocks "Fetch again".
- **Fix:** add `gem "faraday-retry", "~> 2.2"` (resolves to 2.4.0) and `require "faraday/retry"` at the top of `provider.rb`. Keep the existing retry options.
- **Results:**

| Check | Before fix (`v2_12_2_json`) | After fix (`v2_12_2_fixed`), same as baseline |
| --- | --- | --- |
| Test suite | 2 errors, 1 failure | passes |
| Probe: 503 then 200 | 0 requests sent | 2 requests |
| Probe: 503 every time | 0 requests sent | 2 requests, then `Unavailable (HTTP 503)` |
| Probe: 401 | 0 requests sent | 1 request, not retried |
| Probe: connection refused | 0 requests sent | same error message as baseline |

**3. The `basic_auth` middleware was removed in 2.0.**
- **Problem:** with only the retry fix applied, every lookup fails with `:basic_auth is not registered on Faraday::Request` (`runs/v2_12_2_retry_only/001-probe.json`).
- **Fix:** replace it with `faraday.request :authorization, :basic, @user, @password`.
- **Results:** the provider received exactly the same `Authorization` header on baseline and after the fix:
  - user `"00123"` with password `"pä ss: # w"` → `Basic [REDACTED]`
  - a nil password → `Basic [REDACTED]`

Changes 2 and 3 cannot be made ahead of the bump: faraday-retry 2.x requires faraday 2, and the new `:authorization` call fails on faraday 1.10. Deploy `Gemfile`, `Gemfile.lock` and `provider.rb` together to both web and Sidekiq, and roll back all three together. Queued jobs only carry the citation's ID, so old and new workers can run side by side. After any partial or failed deploy, look for citations stuck in `pending`.

## Rollout risks

**4. Retries now wait for a `RateLimit-Reset` header.** If the provider sends a 503 with that header, faraday-retry 2 waits that many seconds before retrying, inside the Sidekiq worker. Baseline retried after 0.0s; 2.12.2 waited 2.0s for `RateLimit-Reset: 2`.
- Optional fix: add `max_interval: 5` to the retry options. Longer waits would then skip the inline retry and fall through to the job's own retry. This fix was not tested.
- Whether the real provider sends this header is unknown.

**5. The `uri` (1.1.2) and `net-http` (0.10.0) gems now load across the whole app.** `URI` switches to a different default parser (from RFC2396 to RFC3986). I ran 11 tricky URLs through the provider's URL check (`web_url?`) on both versions and got identical results, including rejecting `javascript:` links. Inputs outside that sample were not tested.

There are no framework defaults to decide; the collected defaults list was empty.

## Gaps and checks not run
- `bin/rails test:system` was not run in any copy.
- Only local test servers were used. The real provider's TLS, timeouts and rate-limit headers were not exercised, and timeout errors were not tested.
- json 3.x was not researched, because the pin avoids it.
- No changelog pages were collected for faraday-retry 2.3/2.4. That range is covered only by its commit list and the code diff.
- For faraday, uri, faraday-net_http and faraday-retry, the source tool reported "current tag is not an ancestor of target". I reviewed the code diff between the two versions instead.
- Commits and release notes were scanned through the summary indexes and the library code diff, not patch by patch.
- Version sweep: 1.10.6 passes everything. 2.0.1 through 2.11.0 boot but fail the retry tests. 2.12.2 fails to boot.

## Files
- Plan JSON (passes the report checker): `/tmp/gem-upgrade-20261014-71536-7lo4i7/plan.json`
- Full rendered plan, including the experiment list: `/home/user/planner-run/claude-config/projects/-home-user-workspace-repo/5b3a850f-b011-48c4-ae03-6364540ccfa4/tool-results/bz0scu7n0.txt`
- Lab and run records: `/tmp/gem-upgrade-20261014-71536-7lo4i7/` (`runs/`, `sweep.json`)
- Repaired copy: `/tmp/gem-upgrade-20261014-71536-7lo4i7/variants/v2_12_2_fixed/app`
- Test scripts: `/tmp/gem-upgrade-20261014-71536-7lo4i7/probes/provider_probe.rb` and `uri_probe.rb`
- Collected sources: `/tmp/gem-upgrade-20261014-71536-7lo4i7/sources/` and `dependencies-fixed/`

The lab confirmed the original checkout's files are unchanged and removed its databases. The copies and logs are kept.

---

Do you want me to apply these changes to the repo on a new branch? That would be the `json` pin, `faraday-retry` and the `provider.rb` edits. Should I also add `max_interval: 5` from risk 4? It wasn't tested, so it's your call. After applying, I'd run `bin/rails test` and `bin/rails test:system`, since the planner never ran the browser tests.