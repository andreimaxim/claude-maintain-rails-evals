Here is the plan from the upgrade planner, unchanged:

---

I recommend going ahead with the upgrade, but it needs one code change and two Gemfile additions, all shipped in one deploy. Without them, every citation lookup fails on 2.12.2 before a request is sent. With them, upgraded Faraday behaves the same as 1.10.4 against a fake provider. All of this was done in a disposable copy (`/tmp/fplan/copy`, its own bundle config and test database); the working application was not touched.

**Where Faraday is used.** Only in `app/models/citation/provider.rb`. It builds one connection with the `:retry` and `:basic_auth` middleware and rescues `Faraday::ConnectionFailed` and `Faraday::TimeoutError`. `CitationEnrichmentJob` turns `Citation::Provider::Unavailable` into its own `retry_on` handling. The rest of the code does not touch Faraday.

## Required changes

**1. The retry middleware is no longer part of Faraday (removed in 2.0, #1356).**
- **What breaks (seen in the copy):** `Faraday::Error: :retry is not registered on Faraday::Request`, raised on every lookup with zero requests sent (`/tmp/fplan/exp/v2.log`).
- **Knock-on effect (from reading the code):** `Faraday::Error` is not one of the rescued errors, so it is not turned into `Unavailable`. `CitationEnrichmentJob`'s `retry_on` and its `fail_enrichment` step never run. The job just fails and goes to Sidekiq's own retries, so the citation never records a visible failure.
- **Fix:** add `gem "faraday-retry", "~> 2.2"`. It resolved to 2.4.0, and `Bundler.require` loads it as `faraday/retry`. Leave the `request :retry, max: 1, retry_statuses: [503]` line as it is.

**2. The basic-auth middleware is gone (removed in 2.0, #1308).**
- **What breaks:** once `faraday-retry` is added: `Faraday::Error: :basic_auth is not registered on Faraday::Request`.
- **Fix:** change it to `faraday.request :authorization, :basic, @user, @password`.
- **This is not a preparatory change.** On 1.10.4 that line raises `ArgumentError: wrong number of arguments (given 4, expected 3)` (`/tmp/fplan/exp/v1_fixed.log`), so it must ship in the same deploy as the gem bump. A hand-built `Authorization` header would work on both versions, but it adds code for no benefit, so I don't recommend it.

**3. The upgrade pulls in json 3.1.0, which breaks Rails 7.0's JSON encoding.**
- **Cause:** Faraday 2.12.2 newly depends on `json`, `logger` and `net-http`. The lock then also picked `net-http` 0.10.0 and `uri` 1.1.2.
- **What breaks (seen in the copy):** with json 3.1.0, ActiveSupport 7.0.8.7's `to_json` raises `ArgumentError: unknown keyword: quirks_mode` (`active_support/json/encoding.rb:110`). That would break `to_json`, `render json:` and Jbuilder across the whole app, not just citations.
- **Fix:** add `gem "json", "< 3"`. It resolved to 2.21.2 and the error went away.
- **Still to check:** `uri` 1.x uses a different (RFC 3986) parser by default. That could change what `web_url?` accepts for unusual source URLs; I did not test this.

## What I ran (all in `/tmp/fplan/copy`)

| Variant | Command / setup | Result | Log |
|---|---|---|---|
| Change index | `gem-changes faraday 1.10.4 2.12.2` | 25 removal/deprecation entries, none matched by name; the two that apply are retry (#1356) and auth (#1308) | `/tmp/fplan/changes.txt` |
| Lock and install | `bundle lock --update faraday`, then `bundle install` with `BUNDLE_APP_CONFIG=/tmp/fplan/bcfg` | faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 2.4.0, json 2.21.2 once pinned | `/tmp/fplan/lock.log`, `install*.log` |
| Fake-provider probe | `/tmp/fplan/scripts/probe.rb`: a local TCP server returning 200, 503-then-200, always 503, plus a refused port | see the comparison below | `/tmp/fplan/exp/*.log` |
| Full test suite | isolated database `fplan_faraday2_test` (dropped afterwards), `REDIS_URL` db 14 | without the code change: 1 failure, 2 errors (`:basic_auth is not registered`); with all three fixes: 46 runs, 0 failures; `zeitwerk:check` passes | `/tmp/fplan/test_unfixed.log`, `/tmp/fplan/test.log` |

The probe compares the original 1.10.4 code (`v1.log`) with the upgraded, repaired code (`v2_final.log`):
- **200:** one request, same `Basic [REDACTED]` header, and the colon in the password survives.
- **503 then 200:** two requests, then metadata is returned.
- **Always 503:** two requests, then `Unavailable (HTTP 503)`.
- **Refused port:** `Unavailable` "could not be reached".

All four match on both versions.

The browser suite (`bin/rails test:system`) was not run. I also did not boot a server or a Sidekiq worker.

## Validation for the real change

- **Retry and auth check:** run the existing `test/controllers/citation_enrichments_controller_test.rb`, or the probe above, against a provider stub. It must show exactly two requests for a 503 followed by success, and an Authorization header of `Basic base64("00123:sample: value # keep")`. It fails without fixes 1 and 2 and passes with them.
- **Unavailable path:** a provider that always returns 503 must still end with `fail_enrichment` after 3 job attempts, not a raw `Faraday::Error`.
- **JSON check:** `bin/rails runner 'puts({a: 1}.to_json)'` must print `{"a":1}`, and one Jbuilder or JSON endpoint should respond 200. Without the json pin this raises the `quirks_mode` error.
- **Control:** 401, 404 and malformed-JSON responses still raise `Error` with the same messages, and a refused port still raises `Unavailable`.

## New configuration defaults, release by release

Faraday has no Rails-style framework defaults. I checked the releases 1.10.6, 2.0.1 and 2.1 through 2.12.2:
- **2.0** removes the implicit adapter "default" handling, but the default adapter is still `net_http`, supplied by `faraday-net_http`. This app sets no adapter, so nothing changes.
- **2.0** dropped `multipart`, `UploadIO`, `Request#method` and the auth helpers. Only the auth middleware is used here.
- **2.7.2** renamed the logger formatter's `#error` to `#exception`; the app doesn't use it.
- **2.9** removed the `base64` runtime dependency; the app doesn't rely on it.
- **2.12.2** changed argument forwarding internally; it doesn't affect the app.

There is nothing optional to adopt.

## Rollout and rollback

- **Stored data:** none. Faraday holds no state.
- **Queued work:** `CitationEnrichmentJob` arguments are GlobalIDs, so jobs queued under either version run under the other.
- **Mixed versions:** during a rolling deploy, old and new workers each use their own consistent code. There is no format risk.
- **Rollback:** revert the Gemfile, the lockfile and `provider.rb` together. The new auth line raises `ArgumentError` on 1.10.4.

## Still unverified

- Whether the production provider behaves like the stub, for example by sending `Retry-After` on 503. faraday-retry 2.x respects `Retry-After`, which could delay retries.
- Whether `uri` 1.x changes any `web_url?` results.
- Browser suite and a real Sidekiq run.

---

I haven't changed the repo; this is only a plan, and the current version is still `faraday 1.10.4`. The `json < 3` pin (fix 3) is needed to keep `to_json` and Jbuilder working across the whole app, not just for citations. If you want, I can make the three changes in one commit and then run `bin/rails test` and `bin/rails test:system`.