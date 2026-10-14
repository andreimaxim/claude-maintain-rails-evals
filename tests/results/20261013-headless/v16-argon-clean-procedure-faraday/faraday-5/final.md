# Faraday upgrade plan for Margin Notes: 1.10.4 to 2.12.2

Bumping only faraday breaks the app in three ways, and each was reproduced. With three small repairs, all 46 tests pass on both versions and the HTTP requests faraday sends are byte-for-byte the same as today. Two of the repairs can ship on 1.10.4 first. The third, adding `faraday-retry` 2.x, has to ship together with the bump. The workspace has been cleaned up and `git status` in `/home/user/workspace/repo` is clean.

## 1. Required changes for the upgrade

### F1. App fails to boot: the new `json` 3.1.0 is incompatible with Rails 7.0
- **Affected code:** `/home/user/workspace/repo/Gemfile` and `Gemfile.lock`. The failure happens while Rails reads `config/secrets.yml` lines 7–9 and 16–18 (the `<%= ... .to_json %>` calls), triggered from `config/environment.rb:5`.
- **What breaks:** faraday 2.12.2 adds a runtime dependency on `json`. Bundler then resolves `json (3.1.0)`, where before the app used the copy built into Ruby 3.3.6. Active Support 7.0.8.7 passes `quirks_mode:` to `JSON.generate`, which json 3.1 rejects. As a result boot, eager loading and the whole test suite fail with `ArgumentError: unknown keyword: quirks_mode`, and no routes are drawn (0 instead of 67).
- **Applicability:** Takes effect as soon as faraday moves to 2.12.2. The fix also works on 1.10.4: there the pin resolves `json 2.21.2`, and all 46 baseline tests pass with it. No stored data is involved.
- **Recommended repair:** Add `gem "json", "< 3"` to the `Gemfile`; it resolves to json 2.21.2. Remove the pin when Rails is upgraded to a version that no longer passes `quirks_mode`.
- **Validation:**
  - Failing check: without the pin, `upgraded` failed to boot with the exception above.
  - With the pin: boot OK, eager load OK, 67 routes, 46 runs / 325 assertions / 0 failures.
  - Control: `{a: 1}.to_json` returns `"{\"a\":1}"`.

### F2. `:retry` middleware is no longer built in
- **Affected code:** `app/models/citation/provider.rb:37`, in `Citation::Provider#connection` (`faraday.request :retry, max: 1, retry_statuses: [503]`). The `Gemfile` currently gets `faraday-retry` 1.0.4 only indirectly, through faraday 1.x.
- **What breaks:** Every citation lookup raises `Faraday::Error: :retry is not registered on Faraday::Request`. Because this is not one of the errors `Citation::Provider#lookup` rescues, `CitationEnrichmentJob` errors out instead of marking the citation Unavailable or Failed.
  - Seen in the tests at `citation_enrichments_controller_test.rb` lines 12/20, 53 and 65.
  - It also breaks running `bin/rails runner` against the provider.
- **Applicability:** faraday 2.0 moved retry into a separate gem; this takes effect immediately on the bump. `faraday-retry ~> 2.2` itself requires faraday 2, so this repair must ship in the same deploy as the bump. Queued jobs carry only DOI strings, so they are unaffected.
- **Recommended repair:** Add `gem "faraday-retry", "~> 2.2"` to the `Gemfile` (resolved to 2.4.0). Bundler loads it automatically and it registers `:retry`. The options in `provider.rb` stay unchanged.
- **Validation:**
  - Failing check: the existing test at `citation_enrichments_controller_test.rb:12` expects responses `[503, 200]` to produce exactly 2 requests and a completed citation titled "Middlemarch"; the test at line 59 expects a provider that keeps returning 503 to produce 6 requests and the message "Failed: The provider is unavailable (HTTP 503)". Both fail without the repair and pass with it.
  - Probe on both versions (output identical):
    - A DOI answered with 503 gave 2 requests and then `Citation::Provider::Unavailable: The provider is unavailable (HTTP 503)`.
    - A 7-second response against `timeout: 5` raised `Faraday::TimeoutError` (`Net::ReadTimeout`), was retried once, and then raised Unavailable.
    - Control: a refused connection on port 1 raised `Faraday::ConnectionFailed`, mapped to Unavailable, and was not retried.

### F3. `:basic_auth` middleware was removed
- **Affected code:** `app/models/citation/provider.rb:38` (`faraday.request :basic_auth, @user, @password`).
- **What breaks:** Once F2 is fixed, every lookup raises `Faraday::Error: :basic_auth is not registered on Faraday::Request`.
- **Applicability:** Removed in faraday 2.0 (the old auth helpers, PR #1308); takes effect immediately on the bump.
  - The form the upgrade guide suggests, `request :authorization, :basic, user, pw`, works on 2.12.2 but fails on 1.10.4 with `ArgumentError: wrong number of arguments (given 4, expected 3)`.
  - The repair below works on both versions, so it can ship before the bump.
- **Recommended repair:** In `provider.rb`, add `require "base64"` at the top and replace line 38 with:
  ```ruby
  faraday.request :authorization, "Basic", Base64.strict_encode64("#{@user}:#{@password}")
  ```
  `Base64` is currently loaded indirectly through Rails; the explicit `require` keeps it from depending on that.
- **Validation:**
  - Probe with uneven credentials (user `"usér"`, password `"p:w # ü"` repeated 8 times, a header longer than 60 characters) and with `nil`/`nil` credentials.
    - The `Authorization` header received by a loopback server was identical on both versions.
    - Example: `"Basic [REDACTED]"` for the single-repeat pair; `"Basic Og=="` for nil credentials, which is the same as today.
  - Control: the query string `doi=10.1000%2Fa+b%2Bc%26d%3D%3C%3E%C3%A9` and the parsed UTF-8 title `"Café — 1"` were identical on both versions.
  - Existing tests: the tests at `citation_enrichments_controller_test.rb` lines 23 and 57 (expected header values) pass on `upgraded` (46/46 tests) and on `baseline` with the repair (46/46 tests).

### Dependencies removed or changed, with no effect on this app
- Removed: `faraday-em_http`, `faraday-em_synchrony`, `faraday-excon`, `faraday-httpclient`, `faraday-multipart` and `multipart-post`, `faraday-net_http_persistent`, `faraday-patron`, `faraday-rack`, `ruby2_keywords`.
  - `gem-changes` linked `faraday-rack` to the tests, but those lines use `Rack::Request` and `Rack::Test`, which come from Rack itself, not from faraday.
  - `faraday-retry` is also removed indirectly; it is handled by F2.
- Changed: `faraday-net_http` moves from 1.0.2 to 3.4.4, and `net-http 0.10.0` and `uri 1.1.2` are added. The probe showed no behavior change in errors, timeouts or response encoding.
- Not used by the app, so not applicable:
  - `Connection#basic_auth`, `Connection#token_auth` and `Connection#authorization`.
  - `Request#method`, `UploadIO` and `Response::Middleware`.
  - The renamed logger formatter method (`#error` to `#exception`); the `config.log_formatter` match is the Ruby/Rails logger, not Faraday's.
  - `Options#key?`; the `Note.statuses.key?` match is a plain Hash.
  - The new `request/json.rb` middleware; the `encode` match in `import.rb` is a String method.
- Removed `require`s (`timeout`, `base64`, `uri`, `logger`, `pp`, `securerandom`): the app boots and eager loads cleanly; `base64` is covered by F3.

## 2. New configuration defaults across intermediate releases
None apply. Faraday has no `load_defaults` mechanism, and this is not a Rails upgrade, so `config.load_defaults 7.0` stays unchanged.

Faraday-level changes from releases in the range:
- **2.0: `Faraday.default_connection_options` is now deep-merged.** Not used by the app.
- **2.0: the default adapter is `net_http`, now provided by a separate gem.** It is installed automatically and verified in the probe.
- **Later 2.x releases:** `RaiseError` gained 408 handling and allowed-status options, and the logger gained error logging. The app uses neither the `raise_error` nor the `logger` middleware.

## 3. Rollout, rollback and mixed-version risks
- Faraday stores nothing:
  - Database records, `db/schema.rb`, cache entries and cookies do not involve faraday.
  - `CitationEnrichmentJob` arguments do not change.
  - The requests sent are byte-for-byte the same on both versions: query string and `Authorization` header (the `User-Agent` changes from `Faraday v1.10.4` to `Faraday v2.12.2`). Old and new processes running side by side are therefore safe.
- **Ship first, on 1.10.4:** the F1 `json < 3` pin and the F3 authorization change. Both were verified on `baseline` (46/46 tests).
- **Ship in the bump commit:** faraday 2.12.2 together with `faraday-retry ~> 2.2`.
- **Rollback:** revert only the bump commit. The F1 and F3 changes keep working on 1.10.4.

## 4. Verification log and open questions

**Executed in the workspace.** Ruby 3.3.6, Rails 7.0.8.7, `load_defaults 7.0`.
- `gem-changes faraday 1.10.4 2.12.2`. It could not read any downloaded gem file (tar parse errors such as "is not an octal string"), so its analysis relied on GitHub changelogs, release notes, the upgrade guide and commits.
- `upgrade-workspace setup faraday 1.10.4 2.12.2`:
  - `baseline`: 46 runs, 0 failures.
  - `upgraded`: boot failed with the `quirks_mode` error.
- `upgrade-workspace test` after each repair, in order:
  - after F1: `:retry` errors;
  - after F2: `:basic_auth` errors;
  - after F3: 46 runs, 325 assertions, 0 failures.
- Final resolved versions: faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 2.4.0, json 2.21.2.
- Three `upgrade-workspace probe` runs: the loopback-server probe for retry, timeouts, connection errors, encoding and auth; the probe of the 4-argument authorization form; and the probe of the version-neutral authorization form.
- Repairs applied to `baseline` and the full suite run there: 46/46 passed.
- Logs: they were written to `/tmp/upgrade-faraday-2.12.2/logs` (`bundle-update.log`, `diag-*.log`, `tests-*.log`, `schema-load-*.log`), but `cleanup` deleted that directory, so they no longer exist.
- `cleanup` completed and the working checkout is clean.

**Based on reading the code only:** the dependencies listed above as unused or not applicable.

**Open questions:**
- An unrelated warning appears on both versions: `Enumerable.sum` deprecation at `app/models/export.rb:42` (`fragments.sum`). It is not caused by faraday.
- Not verified against the real production citation provider; only loopback servers were used.

---

This is a plan only. I haven't changed anything in the repo, and `main` is still clean. If you want me to go ahead, I'd do it in two commits:
1. On the current 1.10.4: add the `json < 3` pin and switch to the new authorization line.
2. The upgrade itself: faraday 2.12.2 plus `faraday-retry ~> 2.2`.