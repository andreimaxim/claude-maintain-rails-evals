I upgraded a throwaway copy to faraday 2.12.2. As-is, it breaks every citation lookup and also stops the app from running at all. Three small changes, all shipped in one deploy, bring it back to the same behaviour as today. The live app was not modified.

**Where faraday is used:** only `Citation::Provider#connection` in `/home/user/workspace/repo/app/models/citation/provider.rb` (lines 36–39). Callers are `Citation#enrich`, `CitationEnrichmentJob`, and the import/note citation flows. The change-summary tool found no code matches. All three problems below only showed up when the app was booted and the provider actually called.

## How I tested
- **Copy:** `/tmp/fx/app` (and `/tmp/fx/prep` for the compatibility check), with `DATABASE_URL=postgres://invalid.invalid/none`, so no real database or queue was touched.
- **Probe script** (`/tmp/fx/probe.rb`, run with `bin/rails runner -e test`): a local fake provider server that returns 200 with JSON, or 503 when the DOI contains "503". It records each request line and `Authorization` header. It calls `lookup` for a good DOI and a 503 DOI, then calls an unreachable port.
- **Baseline on 1.10.4** (`/tmp/fx/before.log`):
  - Good DOI returns `Metadata title="T"`.
  - 503 DOI raises `Citation::Provider::Unavailable (HTTP 503)` after **2 GETs**, so the single retry works.
  - Every request carries `Authorization: Basic dTpw`.
  - Unreachable host raises `Unavailable "could not be reached (...)"`.
- **Upgrade:** `bundle update faraday --conservative` resolved faraday 2.12.2, faraday-net_http 3.4.4, net-http 0.10.0, uri 1.1.2, and json 3.1.0. It dropped the ten faraday 1.x adapter gems plus `multipart-post` and `ruby2_keywords` (`/tmp/fx/bundle1.log`).

## Required changes (one deploy)

**1. The `json` gem jumps to 3.1.0, which crashes Rails 7.0.8.7.**
- **Why:** faraday 2.12 lists `json` as a dependency, so Bundler locked the newest installed version (3.1.0). Today the app uses the json 2.7.2 that ships with Ruby.
- **Observed** (`/tmp/fx/after1.log`), raised from `active_support/json/encoding.rb:110` (`stringify`): `json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`. This hits any JSON encoding through ActiveSupport (`to_json`, API responses, and similar), not just citations.
- **Fix:** add `gem "json", "~> 2.7"` to the Gemfile. In the copy this locked json 2.21.2 and the error went away (`/tmp/fx/bundle2.log`, `/tmp/fx/after2.log`). Pinning json is the right fix; leaving it unpinned keeps the app broken. I did not test upgrading Rails as an alternative, and it is out of scope.
- **Check:** in the upgraded copy, `bin/rails runner -e test 'puts({a: 1}.to_json)'` fails without the pin and prints `{"a":1}` with it. Control: run the same command on the current app; it should print the same output.

**2. The retry middleware was removed in 2.0.**
- **Observed** (`/tmp/fx/after2.log`): every lookup raises `Faraday::Error: :retry is not registered on Faraday::Request`, before any request is sent (the fake server recorded `requests: []`).
- **Impact:** that error is not a `Faraday::ConnectionFailed` or `TimeoutError`, so the provider's `rescue` does not catch it. The job's `retry_on Citation::Provider::Unavailable` also doesn't apply, so `fail_enrichment` never runs. Enrichment jobs just fail with a raw error and citations get no error message recorded.
- **Fix:** add `gem "faraday-retry", "~> 2.2"` (locked 2.4.0). It loads automatically through Bundler and the `retry_statuses` option stays the same. The other option is to drop retries, which would change the documented behaviour of "three job attempts, each retrying once on 503".

**3. The basic-auth middleware was renamed in 2.0.**
- **Observed** (`/tmp/fx/after3.log`, after fix 2): `Faraday::Error: :basic_auth is not registered on Faraday::Request`, with the same consequences as above.
- **Fix:** change the line to `faraday.request :authorization, :basic, @user, @password`.
- **Result** (`/tmp/fx/after4.log`): output matches the baseline exactly. That means the same metadata, the same `Unavailable (HTTP 503)` after 2 GETs, the same `Authorization: Basic dTpw` header, and the same message for an unreachable host.
- **This cannot be shipped ahead of the upgrade.** On 1.10.4 that same line raises `ArgumentError: wrong number of arguments (given 4, expected 3)` (`/tmp/fx/prep.log`). The gem change and this code change must go out together.
  - If you need something that works on both versions, setting the header directly should do it: `faraday.request :authorization, "Basic", Base64.strict_encode64("#{@user}:#{@password}")`. I did not test it.

**Validation for 2 and 3:**
- Turn the probe into a test using a local server or WebMock. It should assert three things:
  - (a) a 200 response returns `Metadata`;
  - (b) a 503 response raises `Citation::Provider::Unavailable` after exactly 2 requests;
  - (c) the `Authorization` header equals `Basic base64(user:pass)`.
- Without fixes 2 and 3 it fails with the "not registered" errors; with them it passes.
- Controls: a connection-refused case should still raise `Unavailable "could not be reached"`, and the 404 and 401 cases should still raise `Error`.
- Also run `CitationEnrichmentJob` (`perform_now` against a stubbed 503) and check that after the last attempt `fail_enrichment` stores the "unavailable" message.

## Optional settings and smaller changes
- **New configuration defaults:** none apply. Faraday has no framework-defaults mechanism. From 2.0 the default adapter is `net_http` via the faraday-net_http gem, which is what 1.x already used, so the app keeps the same adapter without any setting.
- **Other removals:** the removed multipart and `UploadIO` code, the `Request#method` and `Connection#basic_auth`/`token_auth` helpers, and the renamed `Logger::Formatter#error` are all unused here (checked with grep).
- **Timeouts:** the connection's `open_timeout: 2` and `timeout: 5` behaved the same in the probe. I did not run an actual timeout case.
- **Response body:** without JSON middleware it is still a String in 2.x, so `JSON.parse(body)` is unaffected.

## Rollout and rollback
- **Stored data and queued jobs:** no format changes. Jobs are enqueued with a `Citation` GlobalID only, and nothing is cached or stored from faraday objects.
- **During a mixed-version rollout:** old and new processes both send the same request, so jobs can be picked up by either.
- **Rollback:** revert the Gemfile, the lockfile and `provider.rb` together. If only the code is reverted, new-gem servers break with `basic_auth not registered`. If only the gem is reverted, old-gem servers break with `ArgumentError`.
- **Lockfile:** the new one also adds net-http 0.10.0 and uri 1.1.2 as gems, replacing the versions bundled with Ruby. Upgrading `uri` can change how other code that uses `URI` (including `web_url?` and Rails routing) behaves. Run the whole app to check this, not just the provider.

## Not verified
- I did not run `bin/rails test` or `test:system`, because the copy has no database. The suite should be run against a separate, throwaway Postgres.
- `test/controllers/citation_enrichments_controller_test.rb:51` runs the real provider in a subprocess and needs re-checking after the upgrade.
- I did not check what happens when the user or password is nil with `:authorization, :basic` compared with the old `basic_auth`.
- I did not test a real HTTP timeout.

Logs are in `/tmp/fx/`: `changes.txt`, `before.log`, `bundle1-3.log`, `after1-4.log`, `prep.log`. Upgraded copy: `/tmp/fx/app`.

---

This is only a plan; your repo is unchanged. The project is on faraday 1.10.4, so this is a major-version upgrade. Faraday itself only touches `app/models/citation/provider.rb`, but the upgrade also pulls in json 3.x, which would break JSON encoding across the whole Rails 7.0 app. That is why the json pin matters most. Say the word and I'll make the changes and run the full test suite against a database.