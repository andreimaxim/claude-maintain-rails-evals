I haven't made the upgrade yet. faraday is pinned at 1.10.4, and the upgrade guidance I'm following says to plan before changing anything. The planner tested 2.12.2 in a separate copy of the app under `/tmp/upgrade-lab-faraday`. Here is its plan in full:

# faraday 1.10.4 → 2.12.2 upgrade plan

Summary: This can't go in as a plain bump. It needs three repairs. Without them, the application fails to boot. With them, the upgraded copy passes the citation tests again. There are no default-related repairs, because faraday has no framework defaults. After the repairs, `upgraded` check 4 has every step `ok`: 46 runs, 325 assertions, 0 failures, 0 errors. `base` check 1 had the same result: 46 runs, 325 assertions, 0 failures, 0 errors. The Gemfile pins faraday exactly (`gem "faraday", "1.10.4"`, Gemfile:39), so the bump changes that line to `"2.12.2"`. There was no resolver conflict.

## Setup and evidence
- Lab directory: `/tmp/upgrade-lab-faraday`. All services are stopped and the files are kept.
- Copies: `copies/base` is the current version (faraday 1.10.4). `copies/upgraded` has faraday 2.12.2 plus R1 to R3.
- Inputs: `changes.md`, `notes.md` and the start log `/tmp/upgrade-lab-faraday-start.log`.
- Lock diff: `/tmp/upgrade-lab-faraday/lock-diff.md`.
- Check logs: `checks/base/01/` and `checks/upgraded/01..04/`.
- Probe logs: `probe-1-{base,upgraded}.log` and `probe-2-{base,upgraded}.log`.
- Rollout matrix: `matrix/120735/` (summary in `matrix.log`).
- Backport logs: `backport.log` and `backport-each.log`.
- Gem source diff: `gem-diff.log` and `gem-source.diff`.
- Patch: `/tmp/upgrade-lab-faraday/repairs.patch`.

## Required changes

**R1. Keep `json` below 3 (Gemfile:39, new line)**
- **Observed error:** in `checks/upgraded/01/boot.log`, the application frame is `config/environment.rb:5`:
  `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)` from `activesupport-7.0.8.7/lib/active_support/json/encoding.rb:110`
- **Cause:** faraday 2.12.0 adds json as an explicit dependency ("Add json as an explicit dependency", #1589). The conservative update therefore pulled in json 3.1.0, which replaces Ruby's default json 2.7.2. json 3.0.0.rc1 removes old generator options, and ActiveSupport 7.0 still passes `quirks_mode`.
- **Consequence if nothing is done:** the application doesn't boot in any environment.
- **Repair:**
  ```diff
  +gem "json", "< 3" # json 3.x removes quirks_mode used by ActiveSupport 7.0
  ```
  This resolves to json 2.21.2.
- **Works on the current version:** not tested on its own. The backport tool only tests application files. It is harmless on 1.10.4, where json isn't in the lock, but ship it in the same commit as the faraday bump.
- **Validation:** boot fails in check 1 and is `ok` in check 2. Control: all other steps and tests unchanged. A rollout matrix of job payloads written and read across both copies was identical in every cell.

**R2. Add the `faraday-retry` gem and require it (app/models/citation/provider.rb:37)**
- **Observed error:** in `checks/upgraded/02/summary.md`:
  `Faraday::Error: :retry is not registered on Faraday::Request` at `app/models/citation/provider.rb:37`, `:36`, `:20` and `app/models/citation.rb:29`
- **Cause:** upgrade guide 2.0, "Bundled middleware moved out": the `retry` middleware moved to the separate `faraday-retry` gem, which you add and require. The guide's other option is to drop retries, which would change the "retry one 503" behavior.
- **Consequence if nothing is done:** every DOI lookup raises, so citation enrichment fails for every note.
- **Repair:**
  ```diff
  +gem "faraday-retry", "~> 2.2" # retry middleware moved out of faraday 2.0
  ```
  ```diff
  +require "faraday/retry"
  +
   # The configured citation metadata service. ...
  ```
  This resolves to faraday-retry 2.4.0.
- **Works on the current version:** no. It requires the upgrade, because faraday 1.10.4 needs `faraday-retry ~> 1.0` (bundle failure in `backport.log`).
- **Validation:** the same three tests still failed in check 3, now on the next error (R3). Check 3 reported "0 newly passing; 0 newly failing", so R2 is only proven together with R3.

**R3. Replace `:basic_auth` with the authorization middleware (app/models/citation/provider.rb:38, line 40 after R2)**
- **Observed error:** in `checks/upgraded/03/summary.md`:
  `Faraday::Error: :basic_auth is not registered on Faraday::Request`
- **Cause:** upgrade guide 2.0, "Authentication helper methods in Connection have been removed" (#1306 and #1308). Use the `authorization` middleware instead.
- **Consequence if nothing is done:** DOI lookups fail, the same as R2.
- **Repair:**
  ```diff
  -        faraday.request :basic_auth, @user, @password
  +        faraday.request :authorization, :basic, @user, @password
  ```
- **Works on the current version:** no. It requires the upgrade. On 1.10.4 it fails with `ArgumentError: wrong number of arguments (given 4, expected 3)` (`backport-each.log`, which reports provider.rb as "FAILS on the current version").
- **Validation:** check 4 reports 3 newly passing tests, all three in `CitationEnrichmentsControllerTest`:
  - `test_fetches_a_manually_entered_DOI's_title_and_source_URL,_retrying_one_unavailable_response` (checks retry on 503)
  - `test_provider_credentials_from_the_environment_reach_the_server_unchanged` (checks the basic-auth credentials)
  - `test_a_provider_that_stays_unavailable_or_refuses_the_request_leaves_a_visible_failure`

  Control: the other 43 tests passed throughout.

## Controls (probes in step 6 and step 10)
Each probe gave the same result on both copies, with one difference noted below.
- **Connection-refused lookup:** both copies return `Citation::Provider::Unavailable: The provider could not be reached (..)`, so `Faraday::ConnectionFailed` is still caught (`probe-1-*.log`).
- **Secrets and adapter:** the secrets keys `[:url, :user, :password]` and the default adapter `Faraday::Adapter::NetHttp` are the same on both copies.
- **`JSON.parse` of a binary body:** the result is the same, `["Café", UTF-8]`. The only difference is that the argument now stays ASCII-8BIT, as documented in json 2.7.3. `metadata_from` doesn't reuse the body, so this has no effect.
- **DOI query encoding:** `build_url("works", doi: "10.1000/x y+z&é")` gives the same URL on both copies, `...works?doi=10.1000%2Fx+y%2Bz%26%C3%A9` (`probe-2-*.log`).

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 was skipped.

## Other gems that move
- **faraday-net_http 1.0.2 → 3.4.4 (MAJOR):** the default adapter. The probes and the citation tests ran through it. No finding.
- **json 2.7.2 (default gem) → 3.1.0 (new):** this is R1. With the pin it becomes 2.21.2, which replaces Ruby's default json for every caller. The full suite and the job-payload matrix showed no other change.
- **net-http 0.10.0 and uri 1.1.2 (new, replacing default gems):** used through faraday and `URI.parse` in `web_url?`. The suite passes. No finding.
- **Removed:** faraday-retry 1.x (replaced by 2.x in R2), multipart-post, ruby2_keywords and the 1.x adapter gems (em_http, excon, patron and others). The application uses none of these.

## Rollout and rollback
- **Job payloads:** the matrix of `CitationEnrichmentJob` payloads with non-ASCII strings is identical in all four cells, so queued jobs survive both deploy and rollback.
- **Deploy:** R2 and R3 require the upgrade. Ship them in one commit with the Gemfile and Gemfile.lock changes. Ruby 3.3.6 meets faraday's Ruby >= 3.0 requirement.
- **Rollback:** revert the whole commit, including the Gemfile, lock and provider.rb, so that 1.10.4 never runs with the new middleware call.

## Not verified
- **The R1 json pin on the current version:** it wasn't tested on its own.
- **json 2.7.3 / 2.7.5 / 2.17.0 `to_json` entries:** the only hits are the ERB in `config/secrets.yml:7-8`. Boot and the secrets probe passed, but edge cases with invalid encoding weren't probed.
- **json 2.19.0 `allow_blank`:** the hit at `app/models/note.rb:17` is a Rails validation option, not the JSON option, so it doesn't apply.
- **Real network behavior of faraday-net_http 3.x:** timeouts and TLS against the production provider are only covered by local test servers.
- **Deprecation warnings:** the 3x `Enumerable.sum` warning and the bigdecimal/mutex_m stdlib warnings are present on both copies and are unrelated to this bump.

---

**Next steps:** your repo is unchanged. A plain version bump would stop the app from booting, and citation lookups would fail. With the three changes above, the full test suite passed in the test copy, the same as on the current version. The browser tests (`bin/rails test:system`) weren't part of that comparison.

The `json < 3` pin is a workaround for Rails 7.0 rather than part of faraday itself. It should come out when Rails is upgraded.

If you want me to go ahead, I'll apply `/tmp/upgrade-lab-faraday/repairs.patch` to the repo as one commit, then run `bin/rails test` and the browser tests.