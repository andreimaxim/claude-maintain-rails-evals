Here is the planner's full plan for upgrading faraday from 1.10.4 (the version in `Gemfile.lock`) to 2.12.2:

---

Upgrading faraday from 1.10.4 to 2.12.2 needs two code changes in one file, plus an explicit `faraday-retry` dependency. Without them, every citation lookup fails as soon as it builds its connection. I didn't change the repository.

**How this app uses Faraday.** The only code that touches Faraday is `Citation::Provider#connection` and `#lookup` in `/home/user/workspace/repo/app/models/citation/provider.rb`. `CitationEnrichmentJob` and `CitationEnrichmentsController` reach it through `citation.enrich`.

## Required changes

**1. The `:retry` middleware was removed from Faraday 2.0 (#1356)**
- **Affected code:** `faraday.request :retry, max: 1, retry_statuses: [503]`
- **What breaks:** tested on 2.12.2, building the connection raises `Faraday::Error: :retry is not registered on Faraday::Request`.
- **Why it matters:** that error is not `ConnectionFailed`, `TimeoutError` or `Unavailable`, so `lookup` does not rescue it and the job's `retry_on` does not catch it. Every enrichment job would fail outright instead of retrying, and `fail_enrichment` would never run, so citations would not record the failure.
- **Fix:** add `gem "faraday-retry", "~> 2.2"` to the Gemfile next to faraday. Today it only arrives indirectly, as a dependency of faraday 1.x (1.0.4 in the lock file). In my test an unpinned `faraday-retry` resolved to 1.0.4 and still worked on 2.12.2, but the 2.x line is the one maintained for Faraday 2. No `require` is needed, since Bundler loads the gem and it registers `:retry`.
- **Works on the current version?** Not as written: faraday 1.10.4 requires `faraday-retry ~> 1.0`, so a `~> 2.2` pin cannot be added before the faraday bump. Change both in the same commit.

**2. The `:basic_auth` request middleware was removed from Faraday 2.0 (#1308)**
- **Affected code:** `faraday.request :basic_auth, @user, @password`
- **What breaks:** with retry fixed, building the connection then raises `Faraday::Error: :basic_auth is not registered on Faraday::Request`. Same consequence as above.
- **Fix:** use `faraday.request :authorization, :basic, @user, @password`. On 2.12.2 this sent `Authorization: Basic dTpw`, byte-for-byte what 1.10.4 sends today.
- **Works on the current version?** No. On 1.10.4 the new form raised `ArgumentError: wrong number of arguments (given 4, expected 3)`. This change must also ship in the same commit as the bump; you can't prepare it ahead.

## Checked and unchanged
In the same isolated experiment, comparing 1.10.4 with 2.12.2 plus both fixes:
- **Retry on 503:** two requests reach the server, and the final 503 response is returned. The `500..599` branch still raises `Unavailable`, so the job's three attempts with one inner retry behave the same.
- **Default adapter:** still `:net_http`, because faraday 2.12.2 depends on `faraday-net_http` (3.4.4 resolved). The removed "default `default_adapter`" (#1354) and the move of the net-http adapter into its own gem (#1336) do not affect this app.
- **Error classes:** a refused connection still raises `Faraday::ConnectionFailed`, so the existing `rescue` holds. I did not provoke a real timeout; `Faraday::TimeoutError` exists in 2.x, but I only know that from the source.
- **Response body:** still the raw string passed to `JSON.parse`, since no response middleware is configured.
- **Other removals in the change summary:** `UploadIO`, multipart, `Request#method` and the `Connection` auth helpers are not used here.

## Configuration defaults
Faraday has no framework-defaults mechanism, and none of the 2.x releases from 2.0.1 to 2.12.2 adds an opt-in default this app would have to adopt. The connection sets its timeouts (open 2s, read 5s) explicitly, so they are unchanged.

## Dependencies
The lock file will drop the unused 1.x adapter gems (`em_http`, `excon`, `patron` and others), plus `multipart-post` and `ruby2_keywords`. It will pull in `faraday-net_http` 3.x, `json` and `logger`. Run `bundle why` on each removed gem to confirm nothing else needs it. Ruby 3.3.6 and Rails 7.0.8.7 meet faraday 2.12.2's requirements.

## Rollout and rollback
- **Stored data:** none affected. Faraday stores nothing, and the job arguments are a GlobalID to `citation`.
- **Queued jobs:** safe across deploy and rollback in both directions, because jobs rebuild the connection on every run.
- **Mixed versions:** an old-code worker paired with a new lock file, or the reverse, fails with the errors above. Deploy the code and the lock file together and roll them back together.

## Validation still to do
Once the change is applied, check these in a disposable copy:
- `bin/rails test`, which includes `test/controllers/citation_enrichments_controller_test.rb`, plus `bin/rails zeitwerk:check`.
- There are no tests for `Citation::Provider` itself (no WebMock, no stubs), so a passing suite says little. Add or run a provider test against a local HTTP server covering:
  - 200 with valid JSON, checking the `Authorization` header;
  - 401;
  - 503 twice, which should make 2 requests and raise `Unavailable`;
  - connection refused, which should raise `Unavailable`.
- Run `CitationEnrichmentJob` with `perform_now` to confirm `fail_enrichment` runs after the final attempt.

What I tested without the app: the HTTP behaviour in a standalone script with Ruby 3.3.6 and WEBrick, outside the app. I did not boot the app on 2.12.2, run its test suite, or use its database, Redis or storage.

## Experiment record
- **Script:** `/tmp/fx/exp/probe.rb`
- **Output:** `/tmp/fx/exp/run.log`
- **Change summary:** `/tmp/fx/summary.txt`
- **Command:** `env FV=<version> [RETRY=1] [NEWAUTH=1] mise exec ruby@3.3.6 -- ruby probe.rb`
- **Resolved for 2.12.2:** faraday 2.12.2, faraday-net_http 3.4.4, net-http 0.10.0, faraday-retry 1.0.4 (unpinned), json 3.1.0, logger 1.7.0.

## Open questions
- I did not run `faraday-retry` 2.x itself. Re-run the 503 case with it pinned to `~> 2.2` before relying on it.
- Running 1.10.4 printed a `base64` warning, which is unrelated to this upgrade.

---

This is a plan only. I haven't changed the Gemfile, the lock file or any code. The change is small, but the faraday bump, the `faraday-retry` pin and the two edits to `app/models/citation/provider.rb` have to ship together in one commit. If you want me to apply it, I'd also add the missing `Citation::Provider` tests first, since the current suite wouldn't catch a broken connection.