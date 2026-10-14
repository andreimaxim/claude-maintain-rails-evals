Upgrading faraday from 1.10.4 to 2.12.2 needs two required changes, both in `/home/user/workspace/repo/app/models/citation/provider.rb`. Without them, every citation lookup fails before any request goes out. Faraday has no framework-style configuration defaults, so there are no new defaults to adopt. I did not change the working repository.

## Scope and method
- **Change summary:** `/tmp/fx/changes.txt`. It covers releases 1.10.6 through 2.12.2. It found no textual match in application code and listed 8 removals in 2.0.0.
- **Where faraday is used:** only in `Citation::Provider#connection` and the `rescue` in `#lookup`. That code is called through `Citation#enrich` from `CitationEnrichmentJob` (which uses `retry_on Citation::Provider::Unavailable`) and from `CitationEnrichmentsController`. The Gemfile pins `gem "faraday", "1.10.4"`. The app is on Rails 7.0.8.7 and Ruby 3.3.6, which satisfies faraday 2.12's Ruby requirement (3.0 or later).
- **Experiments:** I copied `provider.rb` into isolated Bundler projects under `/tmp/fx/{v1,v2,v2b,v3}`. Each has its own Gemfile and Gemfile.lock and contains only faraday and activesupport.
  - I ran them with `MISE_RUBY_VERSION=3.3.6 bundle exec ruby /tmp/fx/scripts/run.rb <provider.rb> ok|503`, against a local TCP stub server that records the request line and the Authorization header.
  - `/tmp/fx/scripts/err.rb` checks connection failures.
  - Bundle logs are in `/tmp/fx/*.lock.log` and `/tmp/fx/*.bundle.log`.
  - No database, queue, cache or storage was involved, so I did not boot the full Rails app (it needs PostgreSQL). That remains a proposed check.

Resolved versions per variant:

| Variant | Resolved gems | Provider code |
|---|---|---|
| v1 | faraday 1.10.4, faraday-retry 1.0.4, faraday-net_http 1.0.2 | unchanged |
| v2 | faraday 2.12.2, faraday-net_http 3.4.4 | unchanged |
| v2b | v2 plus faraday-retry 2.4.0 | unchanged |
| v3 | same gems as v2b | uses `:authorization` |

## Required changes

**1. The retry middleware is no longer part of faraday (2.0.0, #1356).**
- **Affected code:** `faraday.request :retry, max: 1, retry_statuses: [503]`.
- **What happens if nothing is done (v2):** `Faraday::Error: :retry is not registered on Faraday::Request`, and no request is sent.
- **Why it is worse than a failed lookup:** `Faraday::Error` is neither `ConnectionFailed` nor `TimeoutError`, so `lookup` does not rescue it. It is therefore not turned into `Unavailable`, so the job's `retry_on` does not catch it and `fail_enrichment` never runs. The exception escapes to the controller (likely a 500) and to the queue backend.
- **Recommendation:** add `gem "faraday-retry", "~> 2.2"` (it resolved to 2.4.0).
- **Checked:** `Bundler.require` registers `:retry` without an explicit require. In v3, a 503 response still produced 2 requests and then `Citation::Provider::Unavailable: The provider is unavailable (HTTP 503)`, the same as v1.

**2. The `:basic_auth` request middleware was removed (2.0.0, #1308).**
- **What happens if nothing is done (v2b, retry fixed):** `Faraday::Error: :basic_auth is not registered on Faraday::Request`. The effect is the same unrescued failure as above.
- **Recommendation:** change the line to `faraday.request :authorization, :basic, @user, @password`.
- **Checked (v3):** the success path returns the metadata struct and sends exactly the same `Authorization: Basic dTpw` header as v1. The 503 path behaves as described under change 1.
- **Not a preparatory change:** the same line on 1.10.4 raises `ArgumentError: wrong number of arguments (given 4, expected 3)`. It must ship in the same commit as the Gemfile bump. The only alternative is setting the header by hand, which I don't recommend because it duplicates encoding the middleware already does.

## Checked and unaffected
- **Connection failures:** these still map to `Unavailable` on both versions. Errors start with "Failed to open TCP connection…". Whether a real timeout is classified the same way (`TimeoutError` versus `ConnectionFailed`) is unverified.
- **Query encoding:** `doi=10.1%2Fx` is the same on both versions.
- **Other 2.0.0 removals don't apply:** `UploadIO`, multipart, `Request#method`, the Connection auth helpers, and the default-adapter changes are not used. The app sets no adapter, and 2.x falls back to net_http through faraday-net_http 3.4.4.
- **Releases 2.1 through 2.12:** their changelog entries in the summary don't match application code, and the provider uses no JSON or other middleware that changed.

## Rollout and rollback
- **Stored data and queued work:** none is affected. Jobs serialize only the Citation GlobalID, and faraday state is never persisted.
- **Mixed versions:** each process uses its own bundle, so old and new hosts are safe to run side by side.
- **Rollback:** revert the Gemfile, the lockfile and the provider line together. Reverting only the gem brings back the `ArgumentError`.
- **Lockfile:** expect the ten 1.x adapter sub-gems (`faraday-em_http`, `faraday-excon` and the others) to drop out, and `ruby2_keywords` may drop out too.

## Proposed validation (not yet run)
1. In a copied checkout with its own PostgreSQL database and the `:test` queue adapter, run `bin/rails zeitwerk:check` and `bin/rails test`. That includes the subprocess test in `test/controllers/citation_enrichments_controller_test.rb:51`, which calls the real provider.
2. Add provider tests that pass on both versions and tell old from new behaviour. Stub HTTP for:
   - a 200 response, asserting the Basic header is sent;
   - a 503 response, asserting 2 requests and then `Unavailable`;
   - a refused connection, asserting `Unavailable`.

   Today nothing exercises the middleware stack, so the current tests would pass on 2.x until a lookup actually runs.
3. Run the job end to end against a 503 stub and confirm `fail_enrichment` runs after 3 attempts.

## Open questions
- The full app has not been booted on faraday 2.x.
- Real timeout classification on 2.x (see above).
- Whether anything else in the bundle pins faraday 1.x. Nothing does in the current lockfile.

---

I haven't made the upgrade yet; the skill only produces a plan, so the repository is unchanged. The upgrade means changing the Gemfile pin to `2.12.2`, adding `faraday-retry`, and replacing the `:basic_auth` line in `provider.rb`, all in one commit. Want me to make those changes and run the tests?