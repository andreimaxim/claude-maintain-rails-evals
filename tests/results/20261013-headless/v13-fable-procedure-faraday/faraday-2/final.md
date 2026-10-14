# faraday 1.10.4 → 2.12.2 upgrade plan

Summary: a plain version bump does not work. The application does not even boot after it. Three repairs are needed. Default-related repairs: 0, because `changes.md` has no "New framework defaults" section. After the repairs, `upgraded` passes every step (check 04): 46 runs, 325 assertions, 0 failures, 0 errors, 0 skips. `base` (check 01) has the same result: 46 runs, 325 assertions, 0 failures, 0 errors. The repairs must ship in the same commit as the Gemfile change, because R2 and R3 fail on 1.10.4.

## Setup and evidence
- Lab: `/tmp/upgrade-lab-faraday`. The services are stopped and the files are kept.
- Copies:
  - `copies/base` is the application at faraday 1.10.4.
  - `copies/upgraded` is faraday 2.12.2 plus R1–R3.
- Lock diff: `/tmp/upgrade-lab-faraday/lock-diff.md`. 16 gems change.
- Changes summary: `/tmp/upgrade-lab-faraday/changes.md`. Notes: `/tmp/upgrade-lab-faraday/notes.md`.
- Check logs: `checks/base/01`, `checks/upgraded/01`–`04`, `checks/backport/01`, `checks/backport-1/01`.
- Probe logs: `probe-{1,2,3}-{base,upgraded}.log`.
- Matrix log: `matrix.log` (logs in `matrix/120851/`).
- Backport logs: `backport.log` and `backport-each.log`. Gem source diff: `gem-diff.log` and `gem-source.diff`.
- Patch: `/tmp/upgrade-lab-faraday/repairs.patch`.

## Required changes

**R1. The new `json` 3.1.0 breaks booting with ActiveSupport 7.0** (Gemfile; the error surfaces at config/environment.rb:5)
- **Observed** (`checks/upgraded/01/boot.log`):
  `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`, called from `activesupport-7.0.8.7/lib/active_support/json/encoding.rb:110`.
- **Cause:** faraday 2.12.0 added `json` as an explicit dependency ("Add json as an explicit dependency", #1589). The resolver chose json 3.1.0, which replaces Ruby's default json 2.7.2. json 3.x no longer accepts the `quirks_mode` option that ActiveSupport 7.0's encoder passes.
- **If nothing is done:** the application fails to boot in every environment.
- **Repair:**
  ```diff
   gem "faraday", "2.12.2"
  +gem "json", "~> 2.7"
  ```
  This resolved to json 2.21.2.
- **Works on the current version:** yes in principle; it is only a constraint. It ships with the bump anyway.
- **Validation:**
  - Fails without the repair: boot fails in check 01.
  - Passes with it: boot, eager load, production boot, routes and assets are ok in check 02.
  - Control: probe 1 (`probe-1-*.log`). `Citation::Provider#web_url?` gave identical results for 10 URLs on both copies.

**R2. The retry middleware is no longer part of faraday** (app/models/citation/provider.rb:37)
- **Observed** (`checks/upgraded/02/`): `Faraday::Error: :retry is not registered on Faraday::Request`
- **Cause:** upgrade guide for 2.0, "Bundled middleware moved out". The `retry` middleware is now in the separate `faraday-retry` gem.
- **If nothing is done:** every citation lookup raises (DOI enrichment in `CitationEnrichmentJob` and the controller). The one retry on a 503 response is also lost.
- **Repair:**
  ```diff
  +gem "faraday-retry", "~> 2.2"
  ```
  This resolved to faraday-retry 2.4.0. Bundler requires it automatically, so the call site is unchanged.
- **Works on the current version:** no. On base, `backport.log` reports "faraday >= 1.9.0, < 2.0.0.alpha.pre.1 depends on faraday-retry ~> 1.0 … version solving has failed".
- **Validation:** after this repair, check 03 shows the error moved to line 38, so `:retry` now resolves. The tests turned green in check 04 (see R3).

**R3. The `:basic_auth` middleware was removed** (app/models/citation/provider.rb:38)
- **Observed** (`checks/upgraded/03/`): `Faraday::Error: :basic_auth is not registered on Faraday::Request`
- **Cause:** upgrade guide for 2.0, "Authentication helper methods in Connection have been removed" (#1306/#1308). Use the `authorization` middleware instead.
- **If nothing is done:** every citation lookup raises.
- **Repair:**
  ```diff
  -        faraday.request :basic_auth, @user, @password
  +        faraday.request :authorization, :basic, @user, @password
  ```
- **Works on the current version:** no. In `backport-each.log`, the line "app/models/citation/provider.rb: FAILS on the current version" is followed by `ArgumentError: wrong number of arguments (given 4, expected 3)` at `faraday-1.10.4/lib/faraday/request/authorization.rb:48`.
- **Validation:**
  - Check 04 compared with 03: 3 tests went from failing to passing:
    - `CitationEnrichmentsControllerTest#test_fetches_a_manually_entered_DOI's_title_and_source_URL,_retrying_one_unavailable_response`, which also covers R2's retry;
    - `#test_a_provider_that_stays_unavailable_or_refuses_the_request_leaves_a_visible_failure`;
    - `#test_provider_credentials_from_the_environment_reach_the_server_unchanged`, which asserts that the Basic header the server receives is unchanged.
  - Control: probe 2 (`probe-2-*.log`). It gives identical `Unavailable` messages on both copies for a refused connection and a read timeout, and the same timeouts (5/2). The handlers changed only from `BasicAuthentication` to `Authorization`.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 was not run.

## Other gems that move
- **faraday-net_http 1.0.2 → 3.4.4 (MAJOR).** This is the default adapter that sends every citation request. The controller tests and probe 2 (connection refused and timeout both rescued) exercised it. It needed no finding.
- **json (new, replaces default 2.7.2).** It is used by ActiveSupport JSON, `JSON.parse` in the provider, and Sidekiq payloads. It caused R1 and is held below 3.
  - Probe 1 shows one changed behaviour (json 2.7.3): `JSON.parse` no longer re-tags a BINARY argument as UTF-8. The output was `UTF-8` on base and `ASCII-8BIT` on upgraded. The application does not reuse `body` after parsing, so this has no effect.
- **net-http (new 0.10.0, replaces default 0.4.1).** It is used through faraday-net_http. Probe 2 is the control and found no difference.
- **uri (new 1.1.2, replaces default 0.13.1).** The default parser changes from `URI::RFC2396_Parser` to `URI::RFC3986_Parser` (probe 1). `web_url?` gave identical results for 10 inputs, including a space, IPv6, an underscore host, IDN, userinfo and a bad `%`-escape. The encoded DOI query strings are also identical (probe 3).
- **Removed gems:** faraday-em_http, em_synchrony, excon, httpclient, multipart, net_http_persistent, patron, rack, retry 1.x, multipart-post and ruby2_keywords. The application uses none of them except retry (R2).

## Rollout and rollback
- The matrix (`matrix.log`) wrote a Sidekiq `ExportJob` payload with `Sidekiq.dump_json` and read it with `Sidekiq.load_json` across base and upgraded. All four cells are identical, so queued jobs survive both deploy and rollback.
- No cookie, cache or session data depends on this gem.
- R2 and R3 require the upgrade. Ship the Gemfile, Gemfile.lock (json ~> 2.7, faraday-retry ~> 2.2) and provider.rb changes in one commit. Rolling back means reverting that whole commit.

## Not verified
- Behaviour on json 3.x is not tested, because R1 holds json below 3. Lifting that constraint likely depends on a newer ActiveSupport that no longer passes `quirks_mode`.
- Faraday 2.0 "Others" changes: `default_connection_options` is now deep-merged, and `Faraday::Response::Middleware` and `Request#method` were removed. The application does not use any of them (grep found no hits), so there was nothing to probe.
- json removals (`JSON.load`/`dump` options, `fast_generate`, `create_additions` and others): grep found no hits in app, lib or config.
- The `to_json` changes in `config/secrets.yml` were covered only indirectly: boot succeeds and the credentials test passes.

Repairs patch: `/tmp/upgrade-lab-faraday/repairs.patch`. Notes: `/tmp/upgrade-lab-faraday/notes.md`.

---

This is only a plan so far. I haven't changed your repository, which is still clean on `main`. The planner tested everything in throwaway copies under `/tmp/upgrade-lab-faraday`. It reports that the upgraded copy passes the full 46-test suite, and the repairs are ready in `repairs.patch`. Should I apply the upgrade (bump faraday, add the `json` and `faraday-retry` constraints, update `provider.rb`) and run the tests here?