# Faraday 1.10.4 to 2.12.2 upgrade plan for Margin Notes

## Verdict

The upgrade is feasible, but it needs three changes that must ship together with the version bump. With the version change alone, the app does not boot. With the three repairs in a disposable lab copy, all checks pass: bundle, boot, eager-load, routes, database and the full test suite (46 runs, 0 failures). The probes behave the same on the current version and the upgraded copy. The real checkout is unchanged: `git status` is clean and HEAD is still ab732f5.

Faraday is used in one place: `app/models/citation/provider.rb`. It is called from `Citation#enrich` and `CitationEnrichmentJob`, and tested in `test/controllers/citation_enrichments_controller_test.rb`. I confirmed FROM 1.10.4 against `Gemfile.lock` and the Gemfile's exact `"1.10.4"` requirement.

## Required repairs, in the order the blockers appeared

**F3 – keep the json gem at 2.7.2.**
- **Cause:** faraday 2.12.2 depends on the json gem, so Bundler now locks json 3.1.0 instead of the 2.7.2 that ships with Ruby 3.3.6. Json 3.0 rejects unknown options, and Active Support 7.0.8.7 passes one (`quirks_mode`).
- **Observed (executed):** the app fails at boot while reading the ERB in `config/secrets.yml`: `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`. Every unmodified check except bundle failed. Log: `/tmp/gem-upgrade-20261014-8141-qsner/runs/20261014T154015-af1864-unmodified-boot/output.log`.
- **Repair:** add `gem "json", "2.7.2"` to the Gemfile with a comment giving the reason. Remove it after a Rails upgrade that works with json 3.
- **Works on the current version:** yes. It is the json version the app loads today, so it can be added before the bump.

**F1 – the `:retry` middleware moved to a separate gem.**
- **Cause:** Faraday 2.0 removed the built-in retry middleware (#1356).
- **Observed (executed):** `Faraday::Error: :retry is not registered on Faraday::Request`, raised at `faraday-2.12.2/lib/faraday/middleware_registry.rb:57` from `provider.rb:37`. This is not a `Provider::Unavailable` error, so the job's `retry_on` would never record the failure. Log: `.../runs/20261014T154205-93230d-json-held-tests/output.log`.
- **Repair:** add `gem "faraday-retry", "~> 2.2"` (it resolved to 2.4.0). No code change is needed.
- **Works on the current version:** no. faraday-retry 2.x requires faraday 2.

**F2 – the `:basic_auth` middleware was removed.**
- **Cause:** Faraday 2.0 removed it (#1306, documented in UPGRADING.md).
- **Observed (executed):** `:basic_auth is not registered on Faraday::Request`, raised from `provider.rb:38`. Logs: `.../runs/20261014T154226-86070d-retry-gem-tests/output.log` and `.../runs/20261014T154337-f8406c-probe-no-auth-repair/output.log`.
- **Repair:** change the line to `faraday.request :authorization, :basic, @user, @password`.
- **Works on the current version:** no. I applied the same line to a separate copy still on 1.10.4 and it failed with `ArgumentError: wrong number of arguments (given 4, expected 3)` at `faraday-1.10.4/lib/faraday/request/authorization.rb:48`. Log: `/tmp/gem-upgrade-20261014-10802-u5rwb9/runs/20261014T154345-067df1-probe-auth-on-1x/output.log`.

## Validation (executed)

**Faraday behaviour probe:** `/home/user/planner-run/probes-faraday/provider_probe.rb` runs the provider against a local fake server.
- **Runs:** on the current version (B), on the upgraded copy with all repairs (U), and on U without the F2 repair.
- **Results:** B and U gave identical results in every case:
  - **Plain success (control):** one request.
  - **One 503 then success:** two requests, metadata returned.
  - **Two 503s:** two requests, then "unavailable (HTTP 503)"; the third response is never requested.
  - **500:** not retried (one request).
  - **Long credentials:** a 77-character user name and a non-ASCII password containing a colon arrive intact.
  - **DOI query encoding:** unchanged.
  - **Connection refused:** reported as "could not be reached".
  - **Read timeout:** two attempts, then "could not be reached".
- **Without the F2 repair:** the probe fails at middleware lookup.
- **Logs:** `/tmp/gem-upgrade-20261014-6961-x9pfwp/runs/20261014T154308-bedb85-probe` and `/tmp/gem-upgrade-20261014-8141-qsner/runs/20261014T154321-e69fe8-probe`.

**Full checks with all repairs:** `/tmp/gem-upgrade-20261014-8141-qsner/runs/20261014T154241-36a000-auth-mw-tests`.

## Rollout note (F4: other gems that move)

The bump also locks newer versions of three gems the app gets from Ruby today:

| Gem | Today | After |
|---|---|---|
| uri | 0.13.1 | 1.1.2 (uses the stricter RFC3986 URL parser by default, app-wide) |
| net-http | 0.4.1 | 0.10.0 |
| faraday-net_http | 1.0.2 | 3.4.4 |

It also drops ten adapter and multipart gems the app does not use, plus `ruby2_keywords`.

- **What I checked (executed):** a URL probe on 9 inputs (`uri_probe.rb`) gave identical `web_url?` results before and after; the control URL was accepted and `javascript:` was rejected on both.
- **Remaining risk:** other uses of these gems inside Rails are covered only by the test suite.
- **Action:** review the lock diff in the pull request and watch provider error rates after deploy.

## Optional defaults

None. `defaults.json` is empty, and the app sets no Faraday-wide connection options or adapter.

## Rollout order

1. Optionally ship the json 2.7.2 line (F3) on its own first.
2. In one deploy, bump faraday to 2.12.2, keep json at 2.7.2, add faraday-retry and change the authorization line.
3. Rollback means reverting that whole set together.

No stored data or queued job format changes: job arguments, stored citation fields and credentials are unaffected.

## Not covered (proposed checks only)

- **System tests and production-mode boot were not run.** Proposed: start a lab copy with the repairs, run `bin/rails test:system` and a production boot, expect both to pass, and compare against the current-version copy.
- **No real citation provider was contacted;** only the local fake.
- **faraday-retry's own changelog (1.0.4 to 2.4.0) was not collected.** The probe checked the retry behaviour, but `Retry-After` handling and backoff timing were not tested.
- **Faraday commits were not read one by one** because there are more than 80. I read the changelogs and upgrade guides for every release between the two versions.

## Files

- Evidence and review (structural check passed: 63 candidate groups, 4 findings, 4 limits): `/home/user/planner-run/evidence-faraday/` (`review.json`, `coverage.json`, `entries.tsv`, `dependencies.tsv`, `dependencies/`)
- Probes: `/home/user/planner-run/probes-faraday/provider_probe.rb` and `uri_probe.rb`
- Labs, with services cleaned up and logs kept:
  - current version (B): `/tmp/gem-upgrade-20261014-6961-x9pfwp`
  - upgraded copy (U): `/tmp/gem-upgrade-20261014-8141-qsner`
  - 1.10.4 compatibility test: `/tmp/gem-upgrade-20261014-10802-u5rwb9`

---

I've only planned the upgrade so far. Your repository hasn't been changed; all the testing happened in throwaway copies. Changing only the faraday version breaks the app, so the bump has to ship with three other changes: keep json at 2.7.2, add faraday-retry, and change one line in `app/models/citation/provider.rb`. Should I make these changes and run the full suite, including `bin/rails test:system`, which the plan didn't cover?