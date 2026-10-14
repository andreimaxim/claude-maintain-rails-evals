# Upgrade plan: faraday 1.10.4 to 2.12.2 (Margin Notes)

Bumping only the Gemfile pin breaks the app in three ways: it won't boot, the retry middleware is gone, and the basic-auth middleware is gone. With three changes, all 46 tests pass on 2.12.2 (46 runs, 325 assertions, 0 failures, 0 errors), the same result as on 1.10.4. Faraday is used in only one place, `Citation::Provider` (`/home/user/workspace/repo/app/models/citation/provider.rb`). Nothing in the working checkout was changed; cleanup reported `git status` clean.

## 1. Required changes for the upgrade

### R1. Boot fails because the bump pulls in json 3.1.0
- **Affected code:** `/home/user/workspace/repo/Gemfile` line 39. The failure surfaces at `config/secrets.yml` lines 7–9 and 16–18 (`<%= ENV.fetch(...).to_json %>`), which ActiveSupport 7.0.8.7 evaluates at boot.
- **What breaks:** faraday 2.12.2 adds a runtime dependency on `json` with no version limit. The resolver picked json 3.1.0, where 1.10.4 was using Ruby's built-in 2.7.2. Boot, eager loading and the test runner all fail with `ArgumentError: unknown keyword: quirks_mode` (from `json-3.1.0/lib/json/common.rb:377`, called by `active_support/json/encoding.rb:110`).
- **Applicability:** Happens as soon as the gem is bumped. The pin can ship before the bump: baseline already resolves json 2.7.2, so pinning it changes nothing on 1.10.4. No stored-data effects.
- **Recommended repair:** In the Gemfile, add `gem "json", "~> 2.7", "< 3"` next to the faraday line.
- **Validation:** Without the pin, upgraded failed boot with the error above. With it, boot, eager load and 67 routes were OK on upgraded. Control: the rendered `secrets.yml` values still arrive intact. The test "provider credentials from the environment reach the server unchanged" (`/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb` lines 40–58, user `"00123"`, password `"sample: value # keep"`) passed.

### R2. The `:retry` middleware is no longer bundled
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb` line 37, `Citation::Provider#connection` (`faraday.request :retry, max: 1, retry_statuses: [503]`).
- **What breaks:** Every lookup raises `Faraday::Error: :retry is not registered on Faraday::Request` (provider.rb:37). That is a plain `Faraday::Error`, so the `rescue` at line 29 doesn't catch it, it is never turned into `Unavailable`, and `CitationEnrichmentJob`'s `retry_on` (`app/jobs/citation_enrichment_job.rb:7`) never fires. Every enrichment fails outright, and the rails-runner path fails too.
- **Applicability:** Introduced in 2.0 (PR #1356). On 1.10.4, faraday-retry 1.0.4 is already loaded as a faraday dependency, so listing it explicitly in the Gemfile is harmless there. No data effects.
- **Recommended repair:** Add `gem "faraday-retry", "~> 2.2"` to the Gemfile. Bundler auto-requires `faraday/retry`. The retry options at line 37 stay as they are.
  - Only faraday-retry 1.0.4 is installed in this environment, and installing 2.x failed with a mise trust error. So I verified with `gem "faraday-retry", "1.0.4"`, which registers `retry: Faraday::Retry::Middleware` and works under faraday 2.12.2.
  - Recommend 2.x before shipping, but its behaviour has not been run here.
- **Validation:** The first test (503 then 200) must record 2 requests, the citation must end up `completed` / "Middlemarch", and the persistent-503 test must record exactly 6 requests (3 job attempts × 2). Before the repair these errored with the message above; after it they passed. Control: a single 401 makes exactly 1 request and stores "The provider rejected the configured credentials (HTTP 401)". The probe showed `status=200 calls=2` on both versions.

### R3. The `:basic_auth` middleware was removed
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb` line 38 (`faraday.request :basic_auth, @user, @password`).
- **What breaks:** On 2.12.2 it raises `Faraday::Error: :basic_auth is not registered on Faraday::Request`, which is uncaught, same as R2. The tests didn't show this because R2 fails first; the probe showed it.
- **Applicability:** Introduced in 2.0 (PRs #1306 and #1308). This repair **cannot ship before the bump**: on 1.10.4 the new form raises `ArgumentError: wrong number of arguments (given 4, expected 3)`. It must land in the same commit as the version change.
- **Recommended repair:** Change line 38 to `faraday.request :authorization, :basic, @user, @password`.
- **Validation:** I probed with the test adapter, user `"a"*40` (long enough that old-style Base64 output would wrap) and password `"sample: value # keep"`.
  - On 2.12.2 the header was `Basic YWFh...a2VlcA==`, equal to `"Basic " + Base64.strict_encode64("#{u}:#{pw}")`. That is byte-identical to what `:basic_auth` sends on 1.10.4.
  - Control: the retry still runs (calls=2). The test suite's `basic_auth(user, password)` assertions (lines 23 and 57) passed.

### Checked, no action needed
- **Removed adapter and middleware gems** (em_http, em_synchrony, excon, httpclient, multipart, net_http_persistent, patron, rack, plus multipart-post and ruby2_keywords): the app doesn't use any of them. The `Rack::Request` and `Rack::Test` lines that gem-changes matched come from rack and rack-test, not faraday-rack.
- **faraday-net_http moves 1.0.2 to 3.4.4, and net-http 0.10.0 and uri 1.1.2 are added:** default adapter. Probe: a connection to 127.0.0.1:1 still raises `Faraday::ConnectionFailed`, so the line 29 rescue still works.
- **Removed `require`s for base64 and logger:** Rails 7.0.8.7 locks base64 0.3.0 and logger 1.7.0, and the test helper's `Base64` still works.
- **Other gem-changes matches were false positives:** `Statuses.key?`, `errors.include?`, `Logger::Formatter`, `ApplicationCable::Connection`, migration `execute`, and `CSV#encode`.
- **Not used by the app:** `Request#method`, `UploadIO`, `Response::Middleware`, `Logging::Formatter#error`, and `default_connection_options`.
- **Unrelated, pre-existing:** a deprecation from `export.rb:42` (`fragments.sum`) shows up on both versions.

## 2. New configuration defaults across releases
faraday has no `load_defaults`-style configuration. The one default-related change is that 2.0 removed the built-in default adapter; it comes back through the faraday-net_http dependency (#1366), and the app never sets an adapter, so it uses net_http on both versions. Nothing to configure.

## 3. Rollout, rollback and mixed-version risks
- **No persisted Faraday data:** nothing is stored in database records, `db/schema.rb` (no schema diff), the Redis cache, cookies or tokens. `CitationEnrichmentJob` takes a `Citation` (GlobalID), so job payloads don't change shape. The only cross-version contract is the HTTP request to the provider, and it is identical: same `doi` query and same Authorization header.
- **Ship before the bump on 1.10.4:** R1 (json pin) and the Gemfile line from R2 (faraday-retry, with a version constraint that 1.10.4 also accepts, e.g. `">= 1.0.4"`, until the bump).
- **Ship together with the bump:** R3. It is incompatible in both directions, so a rollback must revert provider.rb line 38 along with the Gemfile.
- **Mixed fleet:** works as long as each process runs matching code. Jobs that fail mid-rollout on an unregistered middleware would land in `Failed` with a visible "Fetch again" button rather than retrying, so deploy the code and the gem atomically.

## 4. Verification log and open questions
**Executed in the workspace (`/tmp/upgrade-faraday-2.12.2`, now deleted):**
- **`gem-changes faraday 1.10.4 2.12.2`:** all release gems failed to unpack ("not an octal string"). Its analysis relied on the GitHub changelog, release notes, UPGRADING.md and the commit diff.
- **`upgrade-workspace setup`:**
  - Lock diff as in section 1: faraday 2.12.2, faraday-net_http 3.4.4, json 3.1.0, net-http 0.10.0, uri 1.1.2, ten gems removed.
  - Baseline: boot OK, 67 routes, 46 runs, 325 assertions, 0 failures.
  - Upgraded: boot failed with the `quirks_mode` error.
- **`upgrade-workspace test` after R1 (json resolved to 2.7.2):** 46 runs, 309 assertions, 1 failure, 2 errors, all `:retry is not registered`.
- **`upgrade-workspace test` after R1, R2 (faraday-retry 1.0.4) and R3:** 46 runs, 325 assertions, 0 failures, 0 errors.
- **`upgrade-workspace probe`:** the retry/auth/ConnectionFailed snippet; output is quoted in R2 and R3.
- **Logs:** `/tmp/upgrade-faraday-2.12.2/logs/{bundle-update,diag-*,schema-load-*,tests-*}.log`, deleted by cleanup.
- **`cleanup`:** working checkout clean.

**Not verified:**
- faraday-retry 2.x. Run the citation tests once it is installed; in particular check that the 6-request count holds and that default retry exceptions still include `Faraday::TimeoutError`.
- That `json` 2.7.x satisfies every other gem at deploy time.
- That the real provider accepts the same header. It should, since it is byte-identical by probe.

---

I haven't made the upgrade yet; this is only the plan, and your repo is unchanged. The full set of fixes passed every test on 2.12.2, but one gem in it hasn't been tested. The recommended `faraday-retry` 2.x wouldn't install here, so that test run used version 1.0.4 instead. Do you want me to go ahead and make the three changes plus the faraday version bump?