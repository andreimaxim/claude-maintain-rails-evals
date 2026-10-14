Here is the planner's full plan for upgrading faraday from 1.10.4 to 2.12.2, unchanged:

---

I recommend the upgrade, but two code and dependency changes have to ship with it. Without them the app either won't boot or citation lookups fail. Nothing in `/home/user/workspace/repo` was modified.

The only Faraday code in the app is `Citation::Provider#connection` in `app/models/citation/provider.rb` (lines 36–39), plus its `rescue Faraday::ConnectionFailed, Faraday::TimeoutError`. `CitationEnrichmentJob` reaches it through `Citation#enrich`. Faraday has no framework-style configuration defaults, so no release in 1.10.6 through 2.12.2 introduces a default for the app to adopt or keep.

## Required changes

**1. With the lockfile as resolved, the app doesn't boot at all.** Faraday 2.12.2 declares `json` as a runtime dependency. Run normally, `bundle update faraday --conservative` resolved `json 3.1.0`, replacing the 2.7.2 that Ruby 3.3 ships with. Rails 7.0.8.7 passes `quirks_mode` to `JSON.generate`, which json 3 rejects. The failure happens while `config/secrets.yml` is being loaded (its ERB calls `.to_json`), so `db:prepare`, the tests, the server and the runner all fail with:
`ArgumentError: unknown keyword: quirks_mode` (at `json-3.1.0/lib/json/common.rb:377` ← `activesupport-7.0.8.7/lib/active_support/json/encoding.rb:110`)
- **Fix:** add `gem "json", "2.7.2"` to the Gemfile. That is the version the app already loads today, so JSON behaviour doesn't change. `"< 3"` would also boot (I tested it; it resolved 2.21.2), but it moves the JSON library forward with no reason to.
- **Current version:** this is safe to merge now, before the upgrade, because it pins what already resolves.

**2. The retry middleware was removed from Faraday 2.0.** Line 37 (`faraday.request :retry, max: 1, retry_statuses: [503]`) raises `Faraday::Error: :retry is not registered on Faraday::Request`. Because `Faraday::Error` is not one of the rescued exceptions, every lookup fails.
- **Fix:** add `gem "faraday-retry", "~> 2.2"` (resolved 2.4.0). `Bundler.require` loads it, so no explicit `require` is needed. The tested variant had none.
- **Current version:** faraday-retry 2.x needs Faraday 2, so this ships together with the upgrade.

**3. The `:basic_auth` middleware was removed in 2.0.** Line 38 raises `Faraday::Error: :basic_auth is not registered on Faraday::Request`.
- **Fix:** change line 38 to `faraday.request :authorization, :basic, @user, @password`.
- **Current version:** this doesn't work on 1.10.4. I ran that exact call against 1.10.4 and got `ArgumentError: wrong number of arguments (given 4, expected 3)` from `faraday-1.10.4/lib/faraday/request/authorization.rb:48`. So it has to deploy in the same release as the gem bump, not before it.

The full experiment diff is in `/tmp/fx/upgrade.diff`.

## Experiments run

All of them used disposable copies at `/tmp/fx/app` (upgraded) and `/tmp/fx/base/app` (unchanged). Both ran with `RAILS_ENV=test DATABASE_URL=postgresql:///fx_faraday_test`, a separate database I have since dropped. The test environment uses the `:test` job queue and the async/test cable adapters, so no shared queue, cache or storage was touched.

- **Resolved versions:** faraday 2.12.2, faraday-net_http 3.4.4, net-http 0.10.0, uri 1.1.2, faraday-retry 2.4.0, json 2.7.2. The 1.x adapter gems, multipart-post and ruby2_keywords dropped out of the lockfile.
- **Fixes applied one at a time:**
  - Gem bump only: the boot error from finding 1 (`/tmp/fx/db.log`).
  - json pinned: 2 errors and 1 failure from `:retry` (`/tmp/fx/test2.log`).
  - faraday-retry added: the `:basic_auth` errors (`/tmp/fx/test3.log`).
  - Auth line changed: `test/controllers/citation_enrichments_controller_test.rb` gives 4 runs, 0 failures (`/tmp/fx/test4.log`).
- **Full suite with the fixes:** 46 runs, 0 failures, and `zeitwerk:check` passes (`/tmp/fx/full.log`). I didn't check whether the `Enumerable.sum` deprecation warnings from `export.rb:42` also appear on the current version.
- **Old versus new behaviour, compared side by side** (`/tmp/fx/probe.rb`):
  - A refused connection and a connection timeout both still surface as `Citation::Provider::Unavailable`, with the same message.
  - Credentials that are `nil` still send `Basic Og==` in both versions.
  - The middleware stack is equivalent: `Retry::Middleware` followed by `Authorization` instead of `BasicAuthentication`.
- **Credential encoding** is checked by the existing test with user `00123` and password `sample: value # keep`. It goes through a fresh `bin/rails runner` and a real loopback server, and passes.

## How to validate each fix

Each check fails on the upgraded app without the fix and passes with it.

1. **json pin:** run `bin/rails runner 'puts 1'` against the upgraded lockfile. Without the pin it fails with the `quirks_mode` error; with it, it prints. As a control, `JSON::VERSION` should be `2.7.2` both before and after.
2. **Retry:** the existing "stays unavailable" test asserts exactly 6 provider requests (3 job attempts, each retrying one 503) and the visible text `Failed: The provider is unavailable (HTTP 503)`. The first test asserts that a 503 followed by a 200 makes 2 requests and leaves the citation completed. As a control, a 401 response must still produce exactly 1 request and no retry.
3. **Authorization:** the credentials test asserts that the server receives `Authorization` equal to `Basic strict_encode64("00123:sample: value # keep")`. As a control, the first test asserts `margin-notes:local-only` for both the retried request and the successful one.

These tests already exist and fail in exactly these ways on the upgrade without the fixes, so no new test is required.

## Rollout and rollback

- Nothing stored changes: no database columns, cache entries or job arguments involve Faraday objects. A queued `CitationEnrichmentJob` only carries the `Citation`, so jobs queued before or after the deploy run correctly on either version.
- During a mixed-version deploy, each process uses its own consistent Gemfile, code and Faraday version. The risk is a partial deploy where the new provider code runs on Faraday 1, or the reverse. Every lookup on such a process would fail, and its jobs would end up recorded as failed enrichments. That failure path either rescues `Unavailable` or, for `Faraday::Error`/`ArgumentError`, passes the error to the queue. So the gem bump and the `provider.rb` change must go out as one release.
- Rollback means reverting both the code and the lockfile together. No data needs migrating either way.

## Other changelog items checked and not applicable

- **2.0** removed `UploadIO`, multipart, the bundled adapters and the default `default_adapter`, and `Request#method`. The app uses none of these, and the default adapter is still `net_http` through faraday-net_http.
- **2.7.2** renamed `Logger::Formatter#error`; no logger middleware is used.
- **2.9** dropped the `base64` dependency. The test helper's use of `Base64` still works on Ruby 3.3, as the passing suite shows.

## Still open

- I haven't verified behaviour against the real production provider, for example whether it sends redirects or non-JSON error bodies. HTTP behaviour was only checked against the loopback stand-in.
- I didn't time the `open_timeout: 2` and `timeout: 5` settings under net-http 0.10 beyond the black-hole connect test.
- json 3 only becomes usable after the planned Rails upgrade beyond 7.0, so the json pin should be revisited then.

---

This is a plan only. Your repo hasn't been changed, and the planner did all its testing in throwaway copies under `/tmp/fx`. In short, the bump has three parts: pin `json` to 2.7.2 so the app still boots, add `faraday-retry`, and change one auth line in `app/models/citation/provider.rb`. The auth change and the Faraday bump have to ship in the same release. I can make the changes if you want.