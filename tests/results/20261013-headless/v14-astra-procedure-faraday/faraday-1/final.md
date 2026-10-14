# Upgrade plan: faraday 1.10.4 to 2.12.2 (Margin Notes)

Upgrading to faraday 2.12.2 breaks the app as it stands: first it won't boot, and after that every citation lookup fails. Three changes fix it, and they must ship together in one deploy. In a copy with those changes, boot, database preparation, eager loading, routes and all 46 tests pass. A side-by-side probe of the citation provider gave the same results as today. The working application was not modified; everything ran in disposable copies under `/tmp/gem-upgrade-20261014-71584-k7guhm`, and its source hashes were unchanged at the end.

Faraday is used in one place, `Citation::Provider` (`app/models/citation/provider.rb`). It makes GET requests with one retry on HTTP 503 and with basic auth.

## Required changes (one deploy, one revert)

**F1. The retry middleware moved to a separate gem.**
- **Problem:** Every 2.x version tested fails with `Faraday::Error: :retry is not registered on Faraday::Request`. Nothing rescues this error, so the background job crashes and the citation stays "pending".
- **Fix:** Add `gem "faraday-retry", "~> 2.2"` (it resolved to 2.4.0) and put `require "faraday/retry"` at the top of `provider.rb`. The `:retry` line itself stays as it is.
- **Check:** Retry counts match the current version:
  - 503 then 200: 2 requests, then success.
  - 503 every time: 2 requests, then "unavailable (HTTP 503)".
  - 500 and 429: 1 request each.
  - A read timeout: still retried once.
  - The test expecting 6 requests across three job attempts passes.

**F2. The `:basic_auth` middleware was removed.**
- **Fix:** Use `faraday.request :authorization, :basic, @user, @password`.
- **Check:** The `Authorization` header is byte-for-byte the same as today for these credentials:
  - the test pair "00123" / "sample: value # keep"
  - 50-character user and password
  - a missing password
  - missing user and password
  - a non-ASCII password
- **Ordering constraint:** This line does not work on the current version. On 1.10.4 every lookup fails with `ArgumentError: wrong number of arguments (given 4, expected 3)`, so it cannot go out ahead of the upgrade.

**F3. Faraday 2.12.2 pulls in the `json` gem, and json 3.1.0 stops the app from booting.**
- **Problem:** The upgrade resolves json 3.1.0. With Rails 7.0, reading `config/secrets.yml` then raises `unknown keyword: quirks_mode (ArgumentError)`. This is the first thing that fails at the exact target, before F1 and F2.
- **Fix:** Add `gem "json", "~> 2.7"` (it resolved to 2.21.2). It can be removed once Rails is upgraded past 7.0.
- **Not tested:** whether this pin also resolves on the current faraday version. It isn't needed there.

**Rollout and rollback:** Ship F1–F3 together with the 2.12.2 pin, and roll back by reverting that one commit. No stored data changes. The queued citation job only stores a reference to the citation record, so jobs queued before or after the deploy should still run. I judged that from the code and did not test it.

## Rollout risk

**F4. Newer json rejects invalid escape sequences.** A provider response whose title contains `\q` currently parses to "Aq" and the lookup succeeds. After the upgrade it fails with "The provider's response was not valid JSON", and the citation is marked failed with no retry. Other inputs gave the same results before and after:
- duplicate keys
- `/* */` comments
- raw tab characters
- the link check (`web_url?`) on 10 URLs

No code change is recommended; after deploy, watch for more "not valid JSON" errors.

## Framework defaults
None were collected for this upgrade.

## What was not checked
- The browser test suite (`bin/rails test:system`) was not run.
- The real production provider (TLS, proxies, real credentials, real network timeouts) was never contacted. All tests used a local stand-in server.
- I only scanned the Faraday release notes and changelogs for relevant terms; minor fixes were not read one by one. Of the Faraday source diff, I read only the request and authentication files.
- The commit histories of the other libraries that moved were not read; probe results are the only evidence there:
  - faraday-net_http 1.0.2 → 3.4.4
  - net-http 0.4.1 → 0.10.0
  - uri 0.13.1 → 1.1.2
  - faraday-retry 1.0.4 → 2.4.0
- For faraday, faraday-net_http, faraday-retry and uri, the current release tag isn't an ancestor of the target tag. That means the target-only commit lists may not show everything.
- In the plan, 69 source pages are marked unknown, 154 reviewed and 17 not applicable.
- One record looks misleading: the run of the F2 line on the current version (`baseline_authz`) shows "exit 0" because the probe catches errors. Its output is the ArgumentError quoted under F2.
- Passing the existing tests does not by itself show the upgrade is safe.

## Files
- Plan: `/tmp/gem-upgrade-20261014-71584-k7guhm/plan.json` (render with `gem-upgrade-report render`)
- Repaired copy: `/tmp/gem-upgrade-20261014-71584-k7guhm/variants/v2_12_2_repaired/app`
  - Its intermediate failing copies, kept for evidence, are `v2_12_2`, `v2_12_2_json`, `v2_12_2_retry` and `baseline_authz`.
- Probes: `/tmp/gem-upgrade-20261014-71584-k7guhm/probes/provider_probe.rb` and `deps_probe.rb`
- Run records: `/tmp/gem-upgrade-20261014-71584-k7guhm/runs/`
- Sources: `/tmp/gem-upgrade-20261014-71584-k7guhm/sources/`, `dependencies-target/`, `dependencies-repaired/`

---

That is the plan only. Nothing in your repo has changed yet. Applying it means one commit with four parts:
- the faraday 2.12.2 pin
- adding `faraday-retry`
- a `json ~> 2.7` pin
- two lines changed in `app/models/citation/provider.rb`

Before deploying, it's also worth running `bin/rails test:system`, since the browser tests weren't run. Do you want me to make the changes?