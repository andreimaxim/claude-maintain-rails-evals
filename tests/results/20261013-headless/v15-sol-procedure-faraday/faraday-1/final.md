# faraday 1.10.4 to 2.12.2 upgrade plan for Margin Notes

## Verdict
The upgrade is feasible with three required repairs. With faraday bumped and nothing else changed, the app does not boot. Once I applied the three repairs in the lab copy, bundle, boot, eager-load, routes, database and the full test suite all passed: `46 runs, 325 assertions, 0 failures, 0 errors` (`/tmp/gem-upgrade-20261014-8209-rwzjws/runs/20261014T154244-aab119-repair3-tests/output.log`). The real checkout is unchanged: `git status` is clean and HEAD is still `ab732f5`.

## Required repairs
Faraday's code is used in one place, `app/models/citation/provider.rb`, plus the Gemfile.

**F1. Keep `json` on the 2.7 series (Gemfile).**
- **Cause:** faraday 2.12.2 now depends on the `json` gem with no version limit. Bundler picks json 3.1.0 instead of Ruby 3.3's built-in 2.7.2. json 3 rejects unknown options ("All unknown options will now cause an `ArgumentError`", json 3.0.0.rc1), but Active Support 7.0.8.7 passes one (`encoding.rb:110`, `quirks_mode: true`).
- **Observed failure (executed):** boot fails with `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`. It is raised while `config/secrets.yml` is read (the `to_json` calls in its ERB). Log: `/tmp/gem-upgrade-20261014-8209-rwzjws/runs/20261014T154013-45b1ab-unmodified-boot/output.log`.
- **Repair:** add `gem "json", "~> 2.7.2"` with a comment explaining the Active Support 7.0 conflict. This resolves to 2.7.6. Remove it after moving past Rails 7.0.
- **Works on 1.10.4 too**, so it can be merged before the bump.

**F2. The retry middleware moved to a separate gem.**
- **Cause:** faraday 2.0 removed it from core (upgrade guide, PR #1356).
- **Observed failure (executed):** `Faraday::Error: :retry is not registered on Faraday::Request` (`faraday-2.12.2/lib/faraday/middleware_registry.rb:57`). Log: `.../runs/20261014T154200-b3383f-repair1-tests/output.log`.
- **Repair:** add `gem "faraday-retry", "~> 2.2"` (locks 2.4.0) and `require "faraday/retry"` at the top of `provider.rb`.
- **Does not work on 1.10.4**, so it must ship together with the bump.

**F3. The `:basic_auth` middleware was removed.**
- **Cause:** in v2.12.2, `request.rb` registers only `url_encoded`, `authorization`, `instrumentation` and `json` (PR #1308).
- **Observed failure (executed):** `Faraday::Error: :basic_auth is not registered on Faraday::Request`. Log: `.../runs/20261014T154225-2c7e94-repair2-tests/output.log`.
- **Repair:** use `faraday.request :authorization, :basic, @user, @password`.
- **Does not work on 1.10.4:** there, `Authorization#initialize(app, type, param)` takes only one parameter. It must ship together with the bump.

No stored data is involved. JSON output was identical in the probe and Faraday doesn't write any stored or queued data. Rollback means reverting the whole commit: Gemfile, Gemfile.lock and `provider.rb`.

## Optional defaults
None. `defaults.json` is empty and Faraday has no opt-in defaults.

## Rollout order
1. F1 (the json line) can go in alone ahead of time.
2. F2, F3 and the faraday bump go in one commit and one deploy.
3. After deploying, run a staging lookup against the real provider. This is proposed, not executed:
   - **Setup:** real credentials configured.
   - **Action:** look up one known DOI and one DOI that returns 503 once.
   - **Assertion:** the title is returned and the provider log shows exactly two requests for the 503 DOI.
   - **Control:** the same lookups on the current release.

## Validation (executed)
`/home/user/planner-run/probes-faraday/provider_probe.rb` checks these cases against a local fake server:
- **Control:** a single 200 response gives one request and `Basic YTpi`.
- **Retry:** 503 then 200 gives two requests with the same `Authorization` header. The credentials are deliberately awkward (UTF-8 user, a colon and a 70+ character password).
- **Persistent 503:** two attempts, then `Unavailable (HTTP 503)`.
- **500 and 401:** one attempt each.
- **Connection refused:** `Unavailable`.
- **Read timeout:** `Unavailable` after two attempts, 12 seconds.

Results:
- **Old version (B, 1.10.4) and upgraded copy with all repairs (U):** every check passed, with identical output.
- **U with each repair removed in turn:**
  - Without F1 (json re-resolved to 3.1.0): fails with the same `quirks_mode` error (`/tmp/gem-upgrade-20261014-11060-vkqa0k/runs/20261014T154416-30b8c0-probe-without-repair1b/output.log`). Removing the Gemfile line alone did not reproduce it, because the lockfile kept json 2.7.6.
  - Without F2: fails with `:retry is not registered` (`/tmp/gem-upgrade-20261014-11190-b463j2/runs/.../probe-without-repair2`).
  - Without F3: fails with `:basic_auth is not registered` (`/tmp/gem-upgrade-20261014-11297-jja0mc/runs/.../probe-without-repair3`).

Two more probes showed no difference between B and U:
- `uri_probe.rb` checks `web_url?` (the check on stored `source_url` values) on 10 edge inputs. This matters because `uri` moves from 0.13.1 to 1.1.2 and now uses RFC 3986 parsing by default.
- `charset_probe.rb` checks non-ASCII titles with and without a charset, because the new `faraday-net_http` now honours the response charset.

## Source-based conclusions (not separately executed)
- The 2.0 error-class changes (`TimeoutError` now under `ServerError`, new 4xx classes) don't affect the app. It catches `ConnectionFailed` and `TimeoutError` by name and doesn't use the `raise_error` middleware.
- The removed adapters, multipart and `ruby2_keywords` are not referenced anywhere in the app.
- The default adapter is still `net_http`; the probe printed it.

## Limits
- System tests and production-mode boot were not run.
- The real citation provider was not contacted.
- The `uri` parsing change was checked on 10 inputs only. Existing stored `source_url` values were not re-checked.
- Sidekiq queued payloads were not tested separately.
- There are 251 upstream commits, so I didn't read `commits.patch` in full. Instead I read specific versioned files via `git show`.
- The faraday-retry 1.0.4 to 2.4.0 changelog was not read; its behaviour is covered only by the probe.

## Files
- Evidence and closed review: `/home/user/planner-run/evidence-faraday/` (`review.json` passes `gem-upgrade-review check`: 63 candidates, 3 findings, 5 limits)
- Probes: `/home/user/planner-run/probes-faraday/`
- Baseline lab: `/tmp/gem-upgrade-20261014-7003-j9i42d`
- Repaired copy: `/tmp/gem-upgrade-20261014-8209-rwzjws/app` (Gemfile and `app/models/citation/provider.rb` hold the repairs)

All lab services have been cleaned up; the lab folders and evidence are kept.

---

This is a plan only. The upgrade skill doesn't make changes, so your checkout is still clean on `main`. Bumping faraday alone breaks boot, because a newer `json` gem conflicts with Rails 7.0. The upgraded app's tests only passed with all three repairs applied together. If you want, I can apply them on a new branch: F1 first, then F2, F3 and the faraday bump together in one commit. I'd also run `bin/rails test:system`, which the plan didn't cover.