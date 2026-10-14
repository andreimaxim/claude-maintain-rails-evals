I recommend upgrading to 2.12.2 only together with a two-line change in `Citation::Provider`. Without that change, every citation lookup fails as soon as the connection is built. The app uses Faraday in one place, `app/models/citation/provider.rb`, which `Citation#enrich` calls through `CitationEnrichmentJob`. No other gem in `Gemfile.lock` depends on Faraday, and Ruby 3.3.6 is supported.

## Experiments (disposable, no app services touched)
I could not boot the full app, because that needs Postgres and Redis. Instead I loaded the real, unmodified `provider.rb` file outside Rails (activesupport 7.0.8.7 only) and ran it against a local WEBrick stub server. The stub checks a normal 200 response, one 503 followed by 200, a 503 every time, a refused connection, and the `Authorization` header sent.
- Script: `/tmp/fx/scripts/run.rb`. Faraday 2 setup: `/tmp/fx/Gemfile.lock` (faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 2.4.0). Faraday 1 setup: `/tmp/fx1/Gemfile.lock` (faraday 1.10.4, faraday-retry 1.0.4).
- Logs: `/tmp/fx/run.log`, `/tmp/fx/run2.log`, `/tmp/fx1/run.log`, `/tmp/fx1/run-fixed.log`.

Results:
1. **Current code on 2.12.2**: every lookup fails with `Faraday::Error: :retry is not registered on Faraday::Request`.
2. **Retry gem required but auth line unchanged**: every lookup fails with `Faraday::Error: :basic_auth is not registered on Faraday::Request`.
3. **Both fixes applied on 2.12.2**: same behaviour as the 1.10.4 baseline in every case:
   - A normal response gives the metadata (`title="T"`) after one request.
   - One 503 then 200 succeeds after 2 requests.
   - A 503 every time raises `Unavailable (HTTP 503)` after 2 requests.
   - A refused connection raises `Unavailable` ("could not be reached").
   - The header is `Basic dTpwIHc=` on both versions.
4. **The new auth line on 1.10.4**: `ArgumentError: wrong number of arguments (given 4, expected 3)`. So that part cannot be prepared ahead on the current version.

## Required changes (ship as one change with the gem bump)
1. **Retry middleware moved out of Faraday (2.0, #1356).** `faraday.request :retry, max: 1, retry_statuses: [503]` raises the error above at connection build. Faraday's `ConnectionFailed` and `TimeoutError` rescue doesn't catch it, so it escapes `lookup`. It is not `Citation::Provider::Unavailable`, so the job's `retry_on` doesn't record a failure. It goes to the queue's own retries instead, and `fail_enrichment` is never called.
   - Fix: add `gem "faraday-retry", "~> 2.4"` to the Gemfile and `require "faraday/retry"` (e.g. at the top of `provider.rb`, or Bundler require).
   - Validated: retry count and the final 503 handling are unchanged.
2. **Auth helpers removed (2.0, #1308).** Replace `faraday.request :basic_auth, @user, @password` with `faraday.request :authorization, :basic, @user, @password`.
   - Validated: the header is identical, including a password with a space.
   - This line only works on 2.x (result 4), so it goes in the same commit as the bump.
   - Alternative: set `faraday.headers["Authorization"]` yourself with Base64, which would work on both versions. I don't recommend it because it repeats what the middleware does, and it is unverified.
3. **Lockfile.** `bundle update faraday` with the pin changed to `"2.12.2"`. This should drop the ten 1.x `faraday-*` adapter gems in `Gemfile.lock` (lines 96–117) and bring in `faraday-net_http` 3.x.
   - Default adapter (#1354, #1336): no `default_adapter` setting is needed. `faraday-net_http` is a runtime dependency of faraday 2, and the experiment ran on it with no adapter configured.

## Removals with no effect on this app
`Faraday::Request#method`, `UploadIO` and the multipart middleware (#1303, #1307, #1357) are not used anywhere (I searched `app`, `config`, `lib` and `test`).

## Configuration defaults
Faraday has no framework-style defaults to opt into. The summary tool listed none for 1.10.6 or any 2.x release, and the app passes its options explicitly (`open_timeout: 2, timeout: 5`). Nothing changes in this area.

## Rollout and rollback
- Queued `CitationEnrichmentJob`s only carry a reference to the `Citation` record, and nothing Faraday-related is stored. Old and new workers can run side by side, and a rollback (reverting gem and code together) is safe.
- The one risk is deploying the gem bump without the code change (or the reverse). Jobs would then escape `retry_on`, as described in item 1.

## Validation still to do
- **No test covers the provider.** Only `test/controllers/citation_enrichments_controller_test.rb` mentions enrichment, and I found no Faraday stubs in tests. A passing `bin/rails test` therefore proves nothing here. Add a model test with a Faraday test adapter (or a local server) covering: 200, 503 then 200 (2 requests), 503 every time (`Unavailable`), 401 (`Error`), the `Authorization` header value, and a connection failure.
- **Not yet run in the app.** In an isolated copy with its own Postgres database and Redis, run `bin/rails zeitwerk:check`, both test suites, and one real enrichment through Sidekiq against a stub provider.
- **Not checked:** behaviour against the real provider, such as redirects or response encoding.

---

This is a plan only. I haven't changed anything in the repo, and the planner's experiments ran in throwaway directories under `/tmp`. The upgrade is small: bump the gem, add `faraday-retry`, and change the auth line, all in one commit. The real gap is that no test covers `Citation::Provider`, so I'd add that test first. Tell me if you want me to make the change.