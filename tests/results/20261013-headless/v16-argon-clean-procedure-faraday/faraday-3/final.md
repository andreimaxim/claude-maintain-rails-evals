# Faraday 1.10.4 → 2.12.2 upgrade plan for Margin Notes

The upgrade is small and confined to one place, but it needs three changes made together. With all three applied, the upgraded copy boots, eager-loads, draws 67 routes (same as baseline) and passes the full suite: 46 runs, 325 assertions, 0 failures. As soon as the gem is bumped, the app fails to boot and, after that is fixed, every citation lookup raises an error.

Faraday is only used in `app/models/citation/provider.rb`, called from `Citation#enrich` (`app/models/citation.rb:29`), which `CitationEnrichmentJob` runs (`app/jobs/citation_enrichment_job.rb`).

## 1. Required changes for the upgrade

### R1. The app will not boot: Faraday 2 pulls in `json` 3.1.0, which Rails 7.0.8.7 cannot use
- **Affected code:** `Gemfile:39`, `Gemfile.lock`, and `config/secrets.yml` lines 7–9 and 16–18. Those lines call `.to_json`, which goes through `ActiveSupport::JSON.encode` (activesupport-7.0.8.7 `json/encoding.rb:110`).
- **What breaks:** Faraday 2.12.2 lists `json` and `logger` as runtime dependencies. Today the lockfile has no `json` entry, so the app uses Ruby 3.3.6's built-in json 2.7.2. After the bump, Bundler locks `json (3.1.0)`, and boot fails with `ArgumentError: unknown keyword: quirks_mode` (raised from `json-3.1.0/lib/json/common.rb:377`, reached from `config/environment.rb:5`). Boot, eager loading and the test runner all fail before running anything.
- **Applicability:** Happens immediately on the bump. You can add the pin while still on 1.10.4, and it matches the version the app already runs.
- **Recommended repair:** Add `gem "json", "2.7.2"` to `Gemfile`. Don't loosen it to `~> 2.7`: I did not test which 2.x versions still accept `quirks_mode`. Remove the pin when Rails is upgraded past 7.0.
- **Validation:** Executed. Without the pin, boot fails with the error above. With it, `Gemfile.lock` resolves `json (2.7.2)`, `bin/rails runner` boots, and the full suite passes. Control check: the "credentials from the environment" test boots a separate `bin/rails runner` process and reads `config/secrets.yml` values like `"00123"` and `"sample: value # keep"` unchanged.

### R2. Every citation lookup raises an error: the `:basic_auth` middleware was removed in 2.0
- **Affected code:** `app/models/citation/provider.rb:38`, in `Citation::Provider#connection`: `faraday.request :basic_auth, @user, @password`.
- **What breaks:** Every lookup raises `Faraday::Error: :basic_auth is not registered on Faraday::Request`. `Faraday::Error` is not caught by the `rescue` on line 29 and is not handled by the job's `retry_on Unavailable`, so the job errors out instead of recording a failure. In the upgraded copy this caused 3 errors in `test/controllers/citation_enrichments_controller_test.rb`.
- **Applicability:** Happens immediately on the bump (removed in 2.0, PR #1308).
- **Recommended repair:** Use one line that works on both versions:
  ```ruby
  faraday.request :authorization, "Basic", Base64.strict_encode64("#{@user}:#{@password}")
  ```
  It can ship on 1.10.4 before the bump. The 2.x-only form `faraday.request :authorization, :basic, @user, @password` also works on 2.12.2, but on 1.10.4 it raises `ArgumentError: wrong number of arguments (given 4, expected 3)`, so it cannot be deployed first.
- **Validation:** Executed with `upgrade-workspace probe`, using a test-adapter stub and asymmetric credentials: user `"00123"`, password `"sample: value # keep é"` plus 80 `p` characters.
  - Assertion: the `Authorization` header received equals `"Basic " + Base64.strict_encode64("00123:<password>")`.
  - Result: `true` on both 1.10.4 and 2.12.2.
  - With the 2.x-only form, the full upgraded suite passes, including the exact header assertions on lines 23 and 57 of the test file.
  - Control: the 401 path still produces `"The provider rejected the configured credentials (HTTP 401)"`.

### R3. The retry middleware must be added as its own gem
- **Affected code:** `app/models/citation/provider.rb:37`: `faraday.request :retry, max: 1, retry_statuses: [503]`.
- **What breaks:** The `faraday-retry 1.0.4` gem currently locked only works with Faraday 1, and `faraday-retry` is no longer a Faraday dependency, so `:retry` would also be unregistered.
- **Applicability:** Happens immediately on the bump. This change cannot ship before the bump, because `faraday-retry 2.x` requires `faraday ~> 2.0`.
- **Recommended repair:** Add `gem "faraday-retry", "~> 2.2"` to the `Gemfile`. It resolved to 2.4.0. Bundler loads it automatically, so no explicit `require` is needed.
- **Validation:** Executed.
  - In the probe, the first request got a 503 and the second a 200. Result on 2.12.2: final status 200, 2 requests sent, and the header was identical on both.
  - A stub that always returns 503 ends with status 503 and is not raised, so the provider's `when 429, 500..599` branch still raises `Unavailable`.
  - The suite confirms the job behaviour: "three job attempts, each retrying one 503" gives 6 requests, and the page shows "Failed: The provider is unavailable (HTTP 503)".

### Dependency moves with no impact on this app
These gems are dropped from the lockfile: `faraday-em_http`, `faraday-em_synchrony`, `faraday-excon`, `faraday-httpclient`, `faraday-multipart` (and `multipart-post`), `faraday-net_http_persistent`, `faraday-patron`, `faraday-rack`, and `ruby2_keywords`. The app uses none of them; the `Rack::` references in tests are Rack itself, not `faraday-rack`. `faraday-net_http` moves from 1.0.2 to 3.4.4, and `net-http 0.10.0`, `uri 1.1.2` and `logger` are added.

Other 2.x changes that don't affect this code:
- `Faraday::ConnectionFailed` and `Faraday::TimeoutError` still exist, so the `rescue` on line 29 still works.
- Nothing here uses the `request: { open_timeout:, timeout: }` options in a way that changed, `Request#method`, `UploadIO`, `Response::Middleware`, the connection's auth helpers, or `default_connection_options`.
- Most other textual matches from the change-summary script were false positives: `ActionCable::Connection`, `Note.statuses.key?`, migration `execute`, `Logger::Formatter`. The one exception is `Rack::Test::UploadedFile` in `test/controllers/imports_controller_test.rb:116`: I didn't open that file, but it belongs to the separate `rack-test` gem, not `faraday-rack`, and that test passed on the upgraded copy.

## 2. New configuration defaults across intermediate releases
None. Faraday has no `load_defaults` or framework configuration defaults, and none of the 2.0–2.12 releases introduce configuration this app sets. The app stays on Rails `load_defaults 7.0`, and the Rails version does not change.

## 3. Rollout, rollback, and mixed-version risks
- **Database, `db/schema.rb`, cookies, cache:** Unaffected. Faraday only makes outbound HTTP calls. Schema load and the schema dump comparison ran without issue (logs below).
- **Queued jobs:** `CitationEnrichmentJob` arguments don't involve Faraday, so jobs queued by either version run on the other. The only risk is a 2.12.2 worker running without the R2 fix: its jobs would fail with `Faraday::Error`, and they would not be retried or marked as failed.
- **Order of deploys:**
  1. On 1.10.4: ship the version-independent auth line from R2, and the `json` pin from R1 (it matches what already runs).
  2. Bump `faraday` to 2.12.2 and add `faraday-retry ~> 2.2` in the same deploy.
- **Rollback:** Revert the Gemfile and lockfile only. The R2 auth line and the `json` pin are safe to keep on 1.10.4.

## 4. Verification log and open questions
**Executed in the workspace** (the logs below were deleted by `cleanup`):
- `upgrade-workspace setup faraday 1.10.4 2.12.2`
  - Baseline: boot OK, 67 routes, 46 runs / 325 assertions, 0 failures.
  - Upgraded: boot failed with `quirks_mode`.
  - Logs: `/tmp/upgrade-faraday-2.12.2/logs/{bundle-update,diag-baseline,diag-upgraded,schema-load-*,tests-*}.log`.
- In `upgraded`, added the `faraday-retry ~> 2.2` and `json 2.7.2` pins and ran `bundle lock` / `bundle install`. Resolved versions: `faraday 2.12.2`, `faraday-net_http 3.4.4`, `faraday-retry 2.4.0`, `json 2.7.2`, `net-http 0.10.0`, `uri 1.1.2`.
- `upgrade-workspace test`: 3 errors from `:basic_auth is not registered on Faraday::Request`. After the R2 fix (`:authorization, :basic` form): 46 runs, 325 assertions, 0 failures, 0 errors.
- Probe 1 (retry, auth, all-503 case on both versions): results as described under R2 and R3. Baseline raised `ArgumentError (given 4, expected 3)` for the 2.x-only form.
- Probe 2 (version-independent string form): `true` on both versions.
- `upgrade-workspace cleanup faraday 2.12.2`: workspace removed, `git status` clean.

**Not run:**
- The full suite with the version-independent auth line in the app on 1.10.4. Only the probe covered it, so run the suite on 1.10.4 before shipping that line.
- A real-network timeout or connection-refused check. That `ConnectionFailed`/`TimeoutError` still map to `Unavailable` is based on reading the code.

**Open questions:**
- Upstream, `quirks_mode` was dropped by json 2.10+, so other 2.x versions above 2.7.2 might also break boot. Only 3.1.0 failing and 2.7.2 working were tested.
- `gem-changes` couldn't open the downloaded 1.10.6–2.12.2 `.gem` files ("is not an octal string"). Changelog and commit coverage came from GitHub release notes, `UPGRADING.md` and the git history instead.

---

This is only a plan; I haven't changed anything in your repo, and the working tree is still clean. The current version (1.10.4) comes from `Gemfile.lock`, and the `Gemfile` pins it exactly.

The recommended auth line in R2, which works on both versions, was only checked with a small standalone test, not the full suite. The full suite passed on 2.12.2 using the other form (`:authorization, :basic, @user, @password`), which only works on 2.x. Run the full suite once on the line you actually ship. If you want, I can make the changes next: the `json` pin, the auth line, the `faraday` bump and `faraday-retry`.