# Faraday upgrade plan for Margin Notes: 1.10.4 to 2.12.2

The upgrade is small, but it won't work as a bare version bump. With only the version changed, the app fails to boot and the citation provider stops authenticating. Three changes fix it. With them, the upgraded copy boots, eager-loads, draws all 67 routes and passes the full suite: 46 runs, 325 assertions, 0 failures. Faraday is used in one place, `Citation::Provider` in `/home/user/workspace/repo/app/models/citation/provider.rb`. The working checkout was not modified, and the cleanup command confirmed `git status` is clean.

## 1. Required changes for the upgrade

### R1. `json` 3.1.0 is pulled in and breaks boot (dependency conflict)

- **Affected code:** `/home/user/workspace/repo/Gemfile` (lockfile has no explicit `json`). The crash happens while `config/secrets.yml` lines 7–9 and 16–18 are evaluated (`.to_json`), at `config/environment.rb:5`.
- **What breaks:** Faraday 2.12.2 adds a runtime dependency on `json`, so Bundler resolves `json (3.1.0)`. ActiveSupport 7.0.8.7 (`active_support/json/encoding.rb:110`) passes `quirks_mode:` to it. The result is `ArgumentError: unknown keyword: quirks_mode` at boot, and the test runner exits with status 1. Today the app uses Ruby's built-in `json` 2.7.2.
- **Applicability:** Takes effect as soon as the Gemfile is bumped. The repair is safe on 1.10.4 because it pins the version already in use. No stored data is affected.
- **Recommended repair:** Add `gem "json", "~> 2.7"` to the Gemfile. In the workspace it resolved to `json (2.7.2)`. Don't leave `json` unpinned: Rails 7.0 can't run with 3.x.
- **Validation:** Done. Without the pin, boot failed with the error above. With it: boot OK, eager load OK, 67 routes, tests green. Control check in a probe: `ActiveSupport::JSON.encode({a: 1})` returns `"{\"a\":1}"` on both versions, and `JSON::VERSION` is `"2.7.2"` on both.

### R2. `:basic_auth` middleware no longer exists

- **Affected code:** `app/models/citation/provider.rb:38`, `Citation::Provider#connection`, the line `faraday.request :basic_auth, @user, @password`.
- **What breaks:** Every lookup raises `Faraday::Error: :basic_auth is not registered on Faraday::Request`. This comes from `provider.rb:38`, called through `Citation#enrich` (`app/models/citation.rb:29`) and `CitationEnrichmentJob#perform` (`app/jobs/citation_enrichment_job.rb:12`). `Faraday::Error` is not in the `rescue` on line 29, so it is not turned into `Unavailable`. Two tests in `test/controllers/citation_enrichments_controller_test.rb` fail with it: the 503-retry test (line 12) and the visible-failure test (line 65).
- **Applicability:** Removed in Faraday 2.0 (PR #1308). Takes effect immediately on the bump. The obvious 2.x replacement, `request :authorization, :basic, @user, @password`, fails on 1.10.4 with `ArgumentError: wrong number of arguments (given 4, expected 3)`. The repair below works on both versions, so it can ship first.
- **Recommended repair:**
  ```ruby
  faraday.request :authorization, "Basic", Base64.strict_encode64("#{@user}:#{@password}")
  ```
  `Base64` is already loaded by Rails 7.0 and is already used by the test.
- **Validation:** Done in a probe against a loopback server. Both versions sent the same `Authorization` headers:
  - `["u","p"]` gives `Basic dTpw`
  - `[nil,nil]` (production with the environment variables unset) gives `Basic Og==`
  - `["00123","sample: value # keep"]` gives `Basic [REDACTED]`

  With a 70-character password, the old `:basic_auth` and the new `:authorization, :basic` also gave identical headers with no line breaks. The suite passed with the repair. Control checks in the existing tests: the 401 path (line 73) and the credentials test (line 57), which passes a fresh-boot `bin/rails runner` with leading-zero and special-character credentials.

### R3. Retry middleware moved to the `faraday-retry` gem

- **Affected code:** `app/models/citation/provider.rb:37`, `faraday.request :retry, max: 1, retry_statuses: [503]`, and the Gemfile.
- **What breaks:** In 1.10.4, `faraday-retry` 1.0.4 is only a transitive dependency of Faraday. In 2.x it is no longer a dependency, so `:retry` would not be registered and the citation provider would fail just as in R2. The workspace's automatic re-lock dropped it. I didn't run a test with it missing. This conclusion comes from the changelog and the 2.x registry behavior.
- **Applicability:** Faraday 2.0. Adding the gem explicitly on 1.10.4 is a no-op (it is already locked at 1.0.4), so it can ship first.
- **Recommended repair:** Add `gem "faraday-retry"` to the Gemfile. It locked to 1.0.4, which works with Faraday 2.12.2: the existing tests assert 2 requests for one 503 and 6 requests for three job attempts, and both passed. Moving to `faraday-retry ~> 2.x` later is the long-term option, but it wasn't installed locally, so it is untested.
- **Validation:** Without the gem: not executed, see above. With it, the suite passes, and the line-68 assertion (`assert_equal 6, requests.size`) discriminates retry behaviour. Probe: `Faraday::Request::Retry` is a `NameError` on 2.12.2, but `:retry` still resolves through faraday-retry.

### Checked, no impact

- **Other dependencies dropped:** Faraday no longer brings in `faraday-rack`, `faraday-multipart`, `multipart-post`, `ruby2_keywords`, the em/excon/httpclient/patron/persistent adapters, or `faraday-net_http` 1.0.2. The new ones are `faraday-net_http` 3.4.4, `net-http` 0.10.0 and `uri` 1.1.2.
  - The app references none of the dropped gems. The `Rack::Request` and `Rack::Test` matches in the tests come from Rack itself.
  - The default adapter is still `:net_http` (probe).
- **Errors are still rescued:** A refused connection is still `Faraday::ConnectionFailed` and is rescued into `Citation::Provider::Unavailable`. A read timeout is still `Faraday::TimeoutError < Faraday::ServerError`. Same results on both versions in the probe.
- **Other removed APIs:** `Request#method`, `UploadIO`, `Response::Middleware`, the logger formatter rename, and the removed `require`s for `base64`, `logger`, `uri` and `timeout` are all unused here, or Rails loads those libraries itself. The other `gem-changes` matches (`ApplicationCable::Connection`, `Note.statuses.key?`, `CSV#encode`, `execute` in a migration, production logger config) are false positives.

## 2. New configuration defaults across intermediate releases

None. Faraday has no `load_defaults` or Rails-style configuration defaults, and `gem-changes` found none for 2.0.1 through 2.12.2. Two behavior changes per release are relevant:

- **2.0:** `Faraday.default_connection_options` is now deep-merged. The app doesn't set it.
- **2.0:** There is no longer a default adapter fallback. `faraday-net_http` is still the default in 2.12.2, which the probe confirmed.

## 3. Rollout, rollback, and mixed-version risks

- **Database, `db/schema.rb`, cookies and tokens:** Faraday doesn't touch them. Schema loaded and dumped the same in both copies.
- **Redis cache:** No change.
- **Queued Active Job payloads:** `CitationEnrichmentJob` arguments are app records, not Faraday objects, so 1.10.4 and 2.12.2 workers can process each other's jobs.
- **Mixed-version risk if R2 isn't shipped first:** 2.x workers raise `Faraday::Error`, which is not rescued as `Unavailable`, so citations are marked failed or retried. Shipping R2 first removes this.
- **Rollback:** Safe once R1–R3 are on 1.10.4. The Base64 form and the explicit `json` and `faraday-retry` entries all work on 1.10.4.
- **Suggested order:**
  1. On 1.10.4, deploy R2 (portable auth line), R1 (`gem "json", "~> 2.7"`) and R3 (`gem "faraday-retry"`).
  2. Bump `gem "faraday", "2.12.2"` and run `bundle update faraday`.
  3. Update the Faraday notes in `/home/user/workspace/repo/ARCHITECTURE.md:81` and `/home/user/workspace/repo/TESTING.md:164` if the gem list is described there.

## 4. Verification log and open questions

**Executed in `/tmp/upgrade-faraday-2.12.2`** (now cleaned up; the logs were removed with it):

- **`gem-changes faraday 1.10.4 2.12.2`:** The cached `.gem` files couldn't be read, so release notes, `UPGRADING.md` and git history were used instead.
- **`upgrade-workspace setup`:** Logs were under `logs/` (`bundle-update.log`, `diag-*.log`, `schema-load-*.log`, `tests-baseline.log`, `tests-upgraded.log`).
  - Baseline: 46 runs, 0 failures.
  - Upgraded: boot failed with `unknown keyword: quirks_mode`.
- **`upgrade-workspace test`, round 1 (R1 and R3 applied):** 2 errors, `:basic_auth is not registered on Faraday::Request`.
- **`upgrade-workspace test`, round 2 (R2 as `:authorization, :basic`):** all green.
- **`upgrade-workspace test`, round 3 (portable R2):** 46 runs, 325 assertions, 0 failures, 0 errors.
- **Resolved upgraded lock:** faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 1.0.4, json 2.7.2, net-http 0.10.0, uri 1.1.2, logger.
- **Two `upgrade-workspace probe` runs:**
  - Auth headers, nil and long credentials, error classes, default adapter and JSON encoding. Results are quoted above.
  - The portable auth form gives identical headers on both versions.
- **Deprecation warning:** `Enumerable.sum` at `app/models/export.rb:42` also appears on baseline, so it is unrelated to this upgrade.

**Based on reading code, not executed:**

- That the portable auth line passes the full suite on baseline. The probe showed identical headers, but I didn't run the baseline suite with it.
- That `:retry` fails with `faraday-retry` missing.

**Open questions:**

- Should `faraday-retry` be moved to 2.x? It's untested here because only 1.0.4 is installed locally.
- Should a raw `Faraday::Error` also be rescued in `Citation::Provider#lookup`, so that future middleware misconfiguration shows up as a readable failure?

---

Faraday is currently locked at 1.10.4. This is a plan only; I haven't changed anything in your repo. Two parts weren't actually run: the full test suite on 1.10.4 with the new auth line, and a test with `faraday-retry` missing. Tell me if you want me to make the changes, starting with the three that are safe to ship on 1.10.4 (R1–R3).