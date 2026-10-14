The upgrade skill only produces a plan, so I haven't changed anything in the repository. Here is the planner's report, unedited:

---

The upgrade from faraday 1.10.4 to 2.12.2 needs three changes, all in one deploy. Without them the app either won't boot or every citation lookup fails, so there is no "upgrade and change nothing" option. With all three applied, a disposable copy behaved exactly like the current version in every check I ran, and the full test suite passed (46 runs, 0 failures). The working repository was not modified.

**Where the app uses Faraday.** Only `app/models/citation/provider.rb` uses it. Its `connection` method sets up a retry on 503 (`request :retry`) and basic authentication (`request :basic_auth`), and `lookup` rescues `Faraday::ConnectionFailed` and `Faraday::TimeoutError`. Callers are `CitationEnrichmentJob` (which retries 3 times on `Citation::Provider::Unavailable`), `Citation#enrich`, and `CitationEnrichmentsController`. `config/secrets.yml` and Active Storage's `config/storage.yml` both call `.to_json` inside ERB while the app boots, which matters for finding 1.

## Required changes

**1. Bundler pulls in json 3.1.0, and the app no longer boots**
- **Cause:** faraday 2.12 adds `json` as a runtime dependency. Nothing in the lockfile pinned json before, so `bundle update faraday --conservative` resolved json 3.1.0. That version breaks Rails 7.0.8.7's JSON encoding.
- **What I saw:** `bin/rails runner 'puts 1'` fails during boot with `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`. It is raised from `activestorage-7.0.8.7/lib/active_storage/engine.rb:137`, which evaluates the ERB in `storage.yml`. `secrets.yml` would hit the same error.
- **Fix:** add `gem "json", "< 3"` to the Gemfile. Bundler then resolves json 2.7.2, the version that ships with Ruby 3.3.6, and the app boots.
- **Check:** boot fails without the pin and succeeds with it. As a control, the credentials test ("provider credentials from the environment reach the server unchanged") still passes, which shows `secrets.yml` still produces the same values, including `"sample: value # keep"`.
- **Later:** remove the pin when Rails is upgraded to a version that supports json 3. I did not check which version that is.

**2. The `:retry` middleware was removed in Faraday 2.0**
- **What I saw:** `Faraday::Error: :retry is not registered on Faraday::Request`. It is raised on every lookup, and the rescue in `lookup` doesn't catch it. The job therefore fails with a generic error instead of recording "unavailable", and no enrichment ever completes.
- **Fix:** add `gem "faraday-retry", "~> 2.2"` (it resolved to 2.4.0). Bundler loads it automatically, so `provider.rb` keeps its existing `request :retry, max: 1, retry_statuses: [503]` line unchanged.
- **Check:** with a local server that always returns 503, the 1.10.4 baseline and the fixed copy behave the same. Both send 2 GET requests, then raise `Citation::Provider::Unavailable: The provider is unavailable (HTTP 503)`. The test "a provider that stays unavailable or refuses the request leaves a visible failure" expects 6 requests (3 job attempts × 2), and expects a single request for a 401.
- **Controls:** a refused connection still produces `Unavailable: The provider could not be reached (Failed to open TCP connection ...)` on both versions. A 200 response still returns the trimmed title.

**3. The `:basic_auth` middleware was removed in Faraday 2.0**
- **What I saw:** `Faraday::Error: :basic_auth is not registered on Faraday::Request`.
- **Fix:** replace that line with `faraday.request :authorization, :basic, @user, @password`.
- **Check:** the test server recorded `Authorization: Basic dTpw` for user `u` and password `p`, identical to 1.10.4. The credentials test above also passes.
- **Ship it with the upgrade, not before.** I applied this line on 1.10.4 to see whether it could go out first. It fails there with `ArgumentError: wrong number of arguments (given 4, expected 3)`. A hand-built `Authorization` header would work on both versions, but it duplicates what the middleware does, so I don't recommend it.

## No configuration defaults to adopt
Faraday doesn't introduce Rails framework defaults. Of the 2.x changes that could affect this app:
- **Default adapter:** removing the bundled net_http adapter doesn't matter, because faraday 2.x pulls in `faraday-net_http` 3.4.4 itself.
- **Removed features the app doesn't use:** multipart, `UploadIO`, `Request#method`, and the connection auth helpers. I grepped the app and found none of them.
- **Logger rename:** the `Faraday::Logger::Formatter#error` to `#exception` rename (2.7.2) doesn't apply, because the app has no logger middleware.
- **Rate-limit headers:** faraday-retry 2.x also reads a rate-limit reset header when deciding how long to wait before retrying, and `max_interval` still defaults to `Float::MAX`. A provider that sends a long `Retry-After` or reset value on a 503 could therefore stall a job worker. This was already true for `Retry-After` in 1.x. I did not confirm the default reset header name. Setting `max_interval: 5` would cap the wait, but that's optional.

## Rollout and rollback
- **Queued jobs:** they carry only the citation's GlobalID, and no Faraday objects are stored, so old and new workers can process each other's jobs.
- **Mixed versions during rollout:** the risk is only that each version must run its own matching `provider.rb`. Gemfile, lockfile and code have to deploy together.
- **Rollback:** revert all three changes together. No database or stored data changes.

## Experiments
Everything ran under `/tmp/fx`, with gems in `/tmp/fx/gems` and separate databases `fx_orig_test` and `fx_app3_test` on the local Postgres, dropped afterwards. The test environment uses the test queue adapter and a null cache. Variants:
- **`orig`:** 1.10.4 baseline.
- **`app`:** faraday 2.12.2 only (json 3.1.0); doesn't boot. Log: `/tmp/fx/boot-error.log`.
- **`app2`:** plus the json pin; fails on `:retry`. Log: `/tmp/fx/probe-app2.log`.
- **`app3`:** all three fixes; resolves faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 2.4.0, json 2.7.2, net-http 0.10.0.
- **`prep`:** the new auth line on 1.10.4. Log: `/tmp/fx/probe-prep.log`.

The probe script is `/tmp/fx/scripts/probe.rb`: a local socket server returning either 200 or always 503, run with `MODE=ok` or `MODE=503`. Other logs: `/tmp/fx/probe.log`, `/tmp/fx/probe-app3.log`, `/tmp/fx/test-orig.log`, `/tmp/fx/test-app3.log`, and `/tmp/fx/bundle*.log`.

## Not verified
- I didn't run `bin/rails test:system`. The browser suite is separate from `bin/rails test`.
- I didn't check whether production has any other Faraday users, such as gems that load Faraday as a dependency. The lockfile shows none.
- I didn't test timeouts (`open_timeout` 2s, `timeout` 5s) against a slow server. Based on the source only, `Faraday::TimeoutError` still exists in 2.x.

The gem-changes summary (`/tmp/fc.txt`) found no textual matches to the app's code. All three findings came from running the upgraded copy.

---

**What this means for you:** the upgrade has to go out as one change with three parts:
- the Faraday version bump;
- two new Gemfile lines (`json` held below 3, and `faraday-retry`);
- one line changed in `app/models/citation/provider.rb` for the new authentication setup.

The Gemfile currently pins faraday at exactly `"1.10.4"`, so that line needs to become `"2.12.2"`. The browser tests weren't run, so run `bin/rails test:system` after applying the changes. Should I make these changes on a new branch?