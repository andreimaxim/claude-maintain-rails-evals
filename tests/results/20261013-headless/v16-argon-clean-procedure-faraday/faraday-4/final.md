# Faraday 1.10.4 to 2.12.2 upgrade plan for Margin Notes

Bumping only the faraday version breaks the app in two ways. With nothing else changed, the upgraded copy fails on boot, and once boot is fixed the citation lookup fails. I made three changes in the disposable workspace and the full suite then passed: 46 runs, 325 assertions, 0 failures, 0 errors. Two of the changes are in the Gemfile and one is in `app/models/citation/provider.rb`. None of the three can ship before the bump, so all of them go in one deploy with the version change. The working checkout is unchanged (`git status` is clean).

## 1. Required changes for the upgrade

### R1. A json 3.x pulled in by Faraday 2.x stops the app from booting
- **Affected code:** `/home/user/workspace/repo/config/secrets.yml` lines 7–9 and 16–18 (`ENV...to_json` inside ERB), and `/home/user/workspace/repo/Gemfile` line 39.
- **What breaks:** Faraday 2.12.2 needs the `json` gem but sets no upper version limit. Bundler therefore picked json 3.1.0, which is installed on this machine, instead of the 2.7.2 that ships with Ruby. ActiveSupport 7.0.8.7 still passes json an option that 3.x no longer accepts. Boot, eager loading and the test runner all failed with `ArgumentError: unknown keyword: quirks_mode` (raised from `active_support/json/encoding.rb:110` via `rails/secrets.rb:29`, reported at `config/environment.rb:5`). Routes dropped from 67 to 0.
- **Applicability:** Happens immediately on the bump, in every environment where json 3.x can be resolved. The same Gemfile line can go in before the bump (it was not tested on 1.10.4). There is no stored-data effect.
- **Recommended repair:** In the Gemfile, add `gem "json", "< 3"`. The lock resolved to json 2.21.2. Alternatively, `bundle lock --update faraday --conservative` might keep json at 2.7.2, but I did not try it, and an explicit limit protects against a later `bundle update`.
- **Validation:**
  - Fails without the repair: `bin/rails runner 'puts "x".to_json'` raises the `quirks_mode` ArgumentError on the unpinned upgraded copy (seen in the setup run).
  - Passes with it: the same snippet in a probe printed `"x"` on both copies (json 2.7.2 on baseline, 2.21.2 on upgraded), boot was OK and there were 67 routes.
  - Control: the "provider credentials from the environment reach the server unchanged" test, which boots a fresh `bin/rails runner` with the user `00123` and the password `sample: value # keep`, passed.

### R2. The retry middleware is no longer part of Faraday
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb:37`, `faraday.request :retry, max: 1, retry_statuses: [503]`. `app/jobs/citation_enrichment_job.rb:7` depends on it: its attempt arithmetic counts two requests per job attempt.
- **What breaks:** Faraday 2.0 moved this middleware into the separate `faraday-retry` gem, and faraday 2.12.2 no longer brings it in. The Gemfile.lock diff shows `faraday-retry: 1.0.4 → (removed)`. Without that gem, `:retry` is not registered. I did not separately capture that error message (I added the gem in the same step as R1), but the registry raises the same way it does for `:basic_auth` in R3. Without the gem, every citation lookup fails, and the existing test expecting 6 requests (3 job attempts, each with one 503 retry) would fail.
- **Applicability:** Happens immediately on the bump. faraday-retry 2.x requires Faraday 2.x, so this ships with the bump. Queued jobs only carry a global record ID for the Citation, so their payloads do not change.
- **Recommended repair:** In the Gemfile, add `gem "faraday-retry", "~> 2.2"`, which resolved to 2.4.0. Bundler requires it automatically, so no code change is needed.
- **Validation:**
  - With the repair, these tests passed on upgraded: "fetches a manually entered DOI's title...", which asserts exactly 2 requests for a 503 followed by a 200, and "a provider that stays unavailable...", which asserts 6 requests and the error "Failed: The provider is unavailable (HTTP 503)".
  - Control: the 401 case in the same test asserts exactly 1 request (no retry) and the message "The provider rejected the configured credentials (HTTP 401)". It passed.

### R3. `:basic_auth` request middleware removed
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb:38`, `faraday.request :basic_auth, @user, @password`, in `Citation::Provider#connection`.
- **What breaks:** In the upgraded workspace, the test runs failed with `Faraday::Error: :basic_auth is not registered on Faraday::Request`, raised at `provider.rb:38`. Because this is not a `Provider::Error` or `Unavailable`, it escapes `Citation#enrich` and the job's `retry_on`, so every enrichment job errors.
- **Applicability:** Happens immediately on the bump. The replacement does not work on 1.10.4: a probe on baseline raised `ArgumentError: wrong number of arguments (given 4, expected 3)`. It must ship in the same deploy as the bump.
- **Recommended repair:** Change the line to `faraday.request :authorization, :basic, @user, @password`.
- **Validation:**
  - Probe against a raw TCP server with the user `00123` and the password `sample: value # keep`. On baseline the old form sent `Authorization: Basic [REDACTED]`. On upgraded the new form sent the identical header, and the old form raised the error above.
  - The suite tests on the DOIs `10.1000/eliot.1871`, `10.1000/configured` and `10.1000/essais` passed.
  - Control: a connection-refused request (`http://127.0.0.1:1`) still raises `Citation::Provider::Unavailable: The provider could not be reached (Failed to open TCP connection ...)` on both versions. So `Faraday::ConnectionFailed` and `Faraday::TimeoutError` still exist with the same names and messages, and the adapter is still `:net_http` (faraday-net_http 1.0.2 → 3.4.4).

### Other dependency moves (no app impact)
These were reviewed and need no change:
- **Gems no longer pulled in:** em_http, em_synchrony, excon, httpclient, multipart, net_http_persistent, patron, faraday-rack, multipart-post and ruby2_keywords are no longer pulled in. The app uses none of them. The `Rack::Request` and `Rack::Test` hits in the tests come from rack itself, not faraday-rack.
- **Gems added:** net-http 0.10.0, uri 1.1.2 and json are added.
- **Requires Faraday no longer loads:** the app does not rely on Faraday loading `base64`, `logger`, `pp` and similar libraries. The test helper `Base64.strict_encode64` still worked.
- **Other removed APIs not used:** `Request#method`, `UploadIO`, `Response::Middleware`, the `Connection#basic_auth`/`token_auth` helpers, and the `Logger::Formatter#error` rename. The `basic_auth` hits in the tests are a local test helper.

## 2. New configuration defaults across intermediate releases
Faraday has no Rails `load_defaults` settings, so there is nothing to adopt. Two library-level defaults changed in the range, and neither affects this app:
- **2.0, `default_connection_options` deep-merged:** the app does not set them.
- **2.0, default adapter:** it was briefly removed and then restored as `:net_http` in 2.0.1. A probe confirmed `:net_http` on both versions.

## 3. Rollout, rollback, and mixed-version risks
- **What the gem does not touch:** Faraday has no effect on database records, `db/schema.rb`, cache entries, cookies or tokens.
- **Queued jobs:** `CitationEnrichmentJob` payloads only reference the Citation record, so jobs work on either version during a mixed rollout.
- **Behavior during rollout:** the retry count (2 requests per attempt, 6 in total) and the Authorization header bytes are identical on both versions.
- **What ships together:** R2 and R3 cannot be deployed before the bump, so the Gemfile changes, the `provider.rb` change and the lock update must go out in one deploy.
- **Rollback:** reverting the deploy reverts all three changes together.
- **Can ship early:** only the `json "< 3"` limit, and it was not tested on 1.10.4.

## 4. Verification log and open questions
**Executed** (logs under `/tmp/upgrade-faraday-2.12.2/logs/`: `bundle-update.log`, `diag-*.log`, `tests-*.log`; that directory was deleted at cleanup):
- **`gem-changes faraday 1.10.4 2.12.2`:** it skipped parsing the cached `.gem` files because of an octal-string error, but it still read the release notes, `UPGRADING.md` and the commits.
- **`upgrade-workspace setup`:**
  - Baseline: 46 runs, 0 failures.
  - Upgraded: boot failed on `quirks_mode`.
- **First fix and test run:** I added `faraday-retry ~> 2.2` and `json < 3`, giving faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 2.4.0 and json 2.21.2. `upgrade-workspace test` then failed 2 tests on `:basic_auth is not registered`.
- **Second fix and test run:** I applied R3 and reran. Boot OK, eager load OK, 67 routes, 46 runs, 325 assertions, 0 failures.
- **Probes:**
  - Auth header comparison: identical Base64 header on both versions; the new form fails on baseline.
  - Connection-refused path: same `Unavailable` message on both.
  - json and Faraday versions.
- **`cleanup`:** the working checkout is clean. However, `bundle install` put faraday-retry 2.4.0 and json 2.21.2 into the shared Ruby gem directory, outside the repo.

**Based on reading source only:**
- Timeouts (`open_timeout: 2`, `timeout: 5`) behave the same.

**Proposed / open:**
- Run the json limit on 1.10.4 if you want to ship it early.
- Test a real timeout (a server that stalls longer than 5 s) to confirm that `Faraday::TimeoutError` still maps to `Unavailable` with net_http 3.4.4.
- `export.rb:42` (`fragments.sum`) prints an `Enumerable.sum` deprecation warning. It appears on both versions and is not related to Faraday.

---

**My notes:** This is only a plan. I haven't changed your repo; the trial upgrade ran in a throwaway copy that has been deleted. The upgrade needs three changes shipped together:

- In the Gemfile, change the faraday pin to `"2.12.2"`.
- Add `gem "faraday-retry", "~> 2.2"` and `gem "json", "< 3"`.
- Change `app/models/citation/provider.rb:38` to `faraday.request :authorization, :basic, @user, @password`.

With those changes the full test suite passed in the copy. The trial left faraday-retry 2.4.0 and json 2.21.2 installed in the shared Ruby gem directory, outside the repo. Let me know if you want me to make the changes on a branch.