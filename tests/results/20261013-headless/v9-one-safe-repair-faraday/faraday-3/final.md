# Faraday 1.10.4 to 2.12.2: upgrade plan for Margin Notes

The upgrade needs three required changes, and all three must ship in the same deploy. Without them the app does not boot. I tried it in disposable copies: with the bare version bump, Rails crashes while loading `config/secrets.yml`. Once that is fixed, every citation lookup fails before any HTTP request is sent. With the three changes, all 46 tests pass and `bin/rails zeitwerk:check` reports "All is good!". The working repository was not modified.

Faraday is used in one place, `app/models/citation/provider.rb`. `CitationEnrichmentJob` calls it through `citation.enrich`, and the job's `retry_on Citation::Provider::Unavailable` depends on how the provider maps errors. The only tests that exercise it are in `test/controllers/citation_enrichments_controller_test.rb`. They run against a real local HTTP server, which makes them a good check here.

## Required changes

### R1. The retry middleware is no longer part of Faraday
- **Affected code:** `faraday.request :retry, max: 1, retry_statuses: [503]` (provider.rb:37). Faraday 2.0 removed it (changelog #1356).
- **If nothing is done:** a direct probe printed `Faraday::Error: :retry is not registered on Faraday::Request` with 0 requests sent. That error is not one of the exceptions the provider rescues, so `CitationEnrichmentJob` would fail on every lookup instead of recording the failure.
- **Fix:** add `gem "faraday-retry", "~> 2.2"` (it resolved to 2.4.0). No `require` is needed: Bundler.require loaded it, and the "retrying one unavailable response" and "stays unavailable" tests passed.
- **Current version:** this is not a preparatory change. faraday-retry 2.x depends on `faraday ~> 2.0`.

### R2. The `:basic_auth` middleware was removed
- **Affected code:** `faraday.request :basic_auth, @user, @password` (provider.rb:38). Faraday 2.0 dropped it (#1308).
- **If nothing is done:** `Faraday::Error: :basic_auth is not registered on Faraday::Request`. Lookups fail the same way as in R1.
- **Recommended fix:** `faraday.request :authorization, "Basic", ["#{@user}:#{@password}"].pack("m0")`.
  - Tested on both 1.10.4 and 2.12.2: the 4 citation-enrichment tests passed on each.
  - That includes the test that checks the exact `Authorization` header for the credentials `"00123"` / `"sample: value # keep"`.
  - Because it works on the current version, it can ship ahead of the upgrade, separately.
- **Alternative (not recommended):** `request :authorization, :basic, @user, @password` is the Faraday 2 style. It worked on 2.12.2, sending `Authorization: Basic dTpw`, but on 1.10.4 it raises `ArgumentError: wrong number of arguments (given 4, expected 3)`. It could only ship together with the upgrade.

### R3. Faraday 2.12 pulls in json 3.x, which crashes Rails 7.0 at boot
This one has no changelog entry, and the change summary did not flag it.
- **Cause:** Faraday 2.10 and later depend on `json`. `bundle lock --update faraday` added `json (3.1.0)`; the app currently uses Ruby's built-in json 2.7.2.
- **Where it breaks:** `config/secrets.yml` calls `.to_json` inside ERB. ActiveSupport 7.0.8.7 passes `quirks_mode`, which json 3 rejects.
- **Observed error:** `json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`, raised from `railties-7.0.8.7/lib/rails/secrets.rb:29`.
- **Effect:** every boot fails, including `bin/rails test`, `db:prepare`, the server and Sidekiq.
- **Fix:** add `gem "json", "< 3"` (it resolved to 2.21.2). It is safe on the current version too, but untested there.
- **Revisit:** this pin can come off once Rails is on a version that supports json 3.

### Other dependency changes (checked, no action needed)
The new lockfile also adds `net-http 0.10.0`, `uri 1.1.2` and `logger 1.7.0`, and removes `multipart-post`, `ruby2_keywords` and the faraday adapter gems.

`uri` replaces the bundled 0.13.1 and is used by `web_url?`. I compared 7 edge-case URLs (spaces, `|`, `^`, `[]`, an underscore in the host, `%zz`, `http:/x`) and got identical results on both versions.

## Other changes from 2.0.1 through 2.12.2 (checked from source)
- **Default adapter (#1354):** 2.x still falls back to net_http through `faraday-net_http` 3.4.4, and the tests confirm the provider works.
- **Not used by this app:** `Faraday::UploadIO`, the multipart middleware, `Request#method`, and the Connection auth helpers.
- **Error handling:** the `ConnectionFailed`/`TimeoutError` rescue still works. A connection-refused probe on 2.12.2 returned `Unavailable`. With no `raise_error` middleware, status codes still reach the `case` statement.
- **Configuration defaults:** Faraday has no framework-style configuration defaults, so there is nothing to adopt or keep across 1.10.6 through 2.12.2.
- **Retry behaviour:** faraday-retry 2.x keeps the same default retried exceptions and only retries idempotent methods (this is a GET). This comes from reading the source; I didn't measure retry timing or `Retry-After` handling.

## Rollout and rollback
- **Stored data:** none. Faraday objects are never stored or queued; Sidekiq jobs only carry the citation argument.
- **Mixed versions:** old and new workers both send the same Basic header and map errors the same way, so there is no risk while versions are mixed.
- **Rollback:** restore `Gemfile` and `Gemfile.lock`. The R2 fix and the json pin can stay in place.
- **Order:** ship R2 (the version-neutral form) on its own first, then ship the version bump with R1 and R3 together.

## Validation
- **Already run:** the full suite passed on 1.10.4 (baseline) and on the fixed 2.12.2 variant.
- **Still to run:**
  - `bin/rails test:system`
  - booting `bin/rails server` and Sidekiq in production mode, to confirm R3 holds outside tests
  - one real lookup against the production provider, checking the header and the one 503 retry

## Evidence
Each variant ran in a disposable copy under `/tmp/fexp/` with its own test database `fexp_<variant>_test` (dropped afterwards). The test environment uses `:null_store`, the `:test` queue adapter and `tmp/storage`.

| Variant | Setup | Result |
|---|---|---|
| A | baseline, Faraday 1.10.4 | 46 runs, 0 failures (`A-test.log`) |
| B | Faraday 2.12.2 + faraday-retry 2.4.0, auth code unchanged | json boot crash (`B-test.log`) |
| C | B + `:authorization, :basic` | json boot crash (`C-test.log`) |
| D | C + `json < 3` | 46 runs, 0 failures (`D-test.log`) |
| E | D with the version-neutral auth line | 4/4 citation tests pass (`E-test.log`); same line on A also passes (`A-E-test.log`) |

Supporting files in `/tmp/fexp/`: `lock.diff` (resolved dependencies) and `lock.log`, `install*.log` (bundle output).

Files in `/tmp/fprobe/`:
- `probe.rb`: the direct HTTP probe
- `baseline.log`: the R1 error
- `v2_retry.log`: the R2 error
- `v2_fixed.log`, `v1_fixed.log`: the `:basic` repair on each version
- `uri.log`: the URI comparison

The change-summary output is in `/tmp/fchanges.txt`.

## Open questions
- Is a Rails upgrade planned that would let the json pin be dropped?
- Would `Retry-After` handling in faraday-retry 2.x lengthen job runtime if the provider sends long `Retry-After` values? This is untested.

---

The plan above is the whole planning output. I haven't changed anything in the repository. A simple version bump would break this app in two ways. First, it wouldn't boot, because the newer json gem that Faraday 2.12 pulls in breaks Rails 7.0. Second, citation lookups would fail because two middlewares Faraday 1.x provided (`:retry` and `:basic_auth`) were removed in 2.0. If you want, I can make the change in the order the plan suggests: ship the auth-line change on its own first, then the version bump with `faraday-retry` and the `json < 3` pin.