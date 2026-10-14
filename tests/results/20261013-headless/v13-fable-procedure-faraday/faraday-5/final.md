# faraday 1.10.4 → 2.12.2 upgrade plan

Summary: a plain bump does not work. Without changes the app does not boot, and once it boots, citation lookups fail. Three repairs are needed (R1 to R3). There are no default-related repairs, because faraday is not a framework and `changes.md` has no "New framework defaults" section. After the repairs the final check of `upgraded` (check 4) is all `ok`: 46 runs, 325 assertions, 0 failures, 0 errors. `base` gives the same result (46 runs, 325 assertions, 0 failures, 0 errors).

## Setup and evidence
- Lab: `/tmp/upgrade-lab-faraday`. The copies are under `copies/`:
  - `base` is the application on faraday 1.10.4.
  - `upgraded` is on faraday 2.12.2 with R1 to R3 applied.
  - `backport` is the current version with the repairs applied.
- Inputs and notes: `changes.md`, `notes.md`, start log `/tmp/upgrade-lab-faraday-start.log`.
- Lock diff: `/tmp/upgrade-lab-faraday/lock-diff.md`.
- Checks: `checks/upgraded/01` to `04`, `checks/base/01`, `checks/backport/01`.
- Probes: `probe-1-{base,upgraded}.log` (JSON), `probe-2-{base,upgraded}.log` (connection errors), `matrix.log` (stored data).
- Backport logs: `backport.log`, `backport-each.log`. Gem source diff: `gem-diff.log`, `gem-source.diff`.
- Patch: `/tmp/upgrade-lab-faraday/repairs.patch`.

## Required changes

**R1. Keep the json gem below 3** (Gemfile; the error is raised from `config/secrets.yml:7`, `config/environment.rb:5`)
- Observed error (`checks/upgraded/01/boot.log`): `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`. It comes from `activesupport-7.0.8.7/lib/active_support/json/encoding.rb:110` while Rails evaluates `ENV.fetch(...).to_json` in `config/secrets.yml`.
- Cause: faraday 2.12.0 adds json as an explicit dependency ("Add json as an explicit dependency"). The resolver therefore picks json 3.1.0, which replaces Ruby's default json 2.7.2. json 3.0 drops legacy generator options, and ActiveSupport 7.0 still passes `quirks_mode`. I did not find a changelog line naming `quirks_mode`; that part comes from reading the error.
- If nothing is done, the app does not boot in any environment.
- Repair (the bundle then resolves json to 2.21.2):
  ```diff
  +# activesupport 7.0 passes quirks_mode to JSON.generate; json 3 rejects it
  +gem "json", "< 3"
  ```
- Works on the current version: yes. Base already runs json 2.x, and the backport check booted fine.
- Validation: boot failed in check 1 and passed in check 2. Control: the JSON probe (`probe-1-*.log`) gives the same output on both copies, and the matrix cells are identical.

**R2. Add faraday-retry and require it** (`app/models/citation/provider.rb:37`)
- Observed error (`checks/upgraded/02`): `Faraday::Error: :retry is not registered on Faraday::Request`.
- Cause: upgrade guide 2.0, "Bundled middleware moved out": the `retry` middleware moved to the `faraday-retry` gem, which must be required explicitly.
- If nothing is done, every citation enrichment (`CitationEnrichmentJob` → `Citation#enrich` → `Provider#lookup`) raises, and the citation never gets metadata.
- Repair:
  ```diff
   gem "faraday", "2.12.2"
  +gem "faraday-retry"
  ```
  ```diff
  +require "faraday/retry"
  +
   class Citation::Provider
  ```
  The lab only had faraday-retry 1.0.4 installed and could not download anything, so the lock uses 1.0.4. It has no gem dependencies and passed the retry-on-503 test with faraday 2.12.2. For production, pin `gem "faraday-retry", "~> 2.2"` (the 2.x line written for faraday 2). That pin was not checked here; see Not verified.
- Works on the current version: yes. Base already bundles faraday-retry 1.0.4 as a faraday 1.x dependency, and the backport failure is explained by R3 only.
- Validation: the `:retry` error appeared in checks 2 and 3 and was gone from check 3 onward. In check 3 the same three tests were still failing, now on the R3 error ("0 newly passing").

**R3. Replace the `basic_auth` middleware with `authorization :basic`** (`app/models/citation/provider.rb:38`)
- Observed error (`checks/upgraded/03`): `Faraday::Error: :basic_auth is not registered on Faraday::Request`.
- Cause: upgrade guide 2.0, "Authentication helper methods in Connection have been removed" (PR #1306/#1308). The auth middleware was refactored and only `:authorization` is registered.
- If nothing is done, every DOI lookup fails, as in R2.
- Repair:
  ```diff
  -        faraday.request :basic_auth, @user, @password
  +        faraday.request :authorization, :basic, @user, @password
  ```
- Works on the current version: no. On 1.10.4 it fails with `ArgumentError: wrong number of arguments (given 4, expected 3)` at `faraday-1.10.4/lib/faraday/request/authorization.rb:48` (`checks/backport/01`, `backport-each.log`: "app/models/citation/provider.rb: FAILS on the current version"). It requires the upgrade and must ship in the same commit as the Gemfile change.
- Validation: check 4 shows "3 newly passing":
  - `CitationEnrichmentsControllerTest#test_fetches_a_manually_entered_DOI's_title_and_source_URL,_retrying_one_unavailable_response` (also covers R2's retry-on-503)
  - `#test_provider_credentials_from_the_environment_reach_the_server_unchanged` (asserts that the server receives the credentials)
  - `#test_a_provider_that_stays_unavailable_or_refuses_the_request_leaves_a_visible_failure`

  Control: the other 43 tests pass on both copies.

## Default-related changes
None. faraday has no framework defaults, and `changes.md` has no "New framework defaults" section, so step 7 did not run.

## Other gems that move
- **json** (new, 3.1.0, replaces default 2.7.2): used by `JSON.parse` in `provider.rb:43`, ActiveSupport encoding, and Sidekiq payloads. It caused R1 and is held at 2.21.2.
  - Probe 1 (`probe-1-*.log`): parse results are identical on both copies. The only difference is that `JSON.parse` no longer re-tags a BINARY argument as UTF-8 (json 2.7.3 entry). The provider never reuses `body` after parsing, so this has no effect here.
- **faraday-net_http** (1.0.2 → 3.4.4, MAJOR): the default adapter. No finding involved it.
  - Probe 2 (`probe-2-*.log`): connection refused and read timeout both still become `Citation::Provider::Unavailable` with identical messages, so the `rescue Faraday::ConnectionFailed, Faraday::TimeoutError` at line 29 still works.
- **net-http** (new, 0.10.0, replaces default 0.4.1) and **uri** (new, 1.1.2, replaces default 0.13.1): used by the adapter and by `URI.parse` in `provider.rb:56`. They are covered by probe 2 and by the test that rejects `javascript:` URLs. No finding involved them.
- Removed: faraday-retry (handled in R2), faraday-multipart, the adapter gems em_http, em_synchrony, excon, httpclient, net_http_persistent, patron and rack, plus multipart-post and ruby2_keywords. The application does not reference any of them except retry.

## Rollout and rollback
- Matrix (`matrix.log`): a Sidekiq `ExportJob` payload containing non-ASCII and U+2028 text, and a JSON `MessageVerifier` message, were written and read across base and upgraded. All four cells are identical. Queued jobs and signed data stay readable in both directions.
- R3 requires the upgrade, so ship R1, R2, R3 and the faraday bump as one commit and one deploy. Rolling back means reverting all of them together. No stored data or queued work is affected.

## Not verified
- **faraday-retry 2.x:** only 1.0.4 was available offline. Pinning `~> 2.2` and confirming the retry test still passes is still to do; run `bundle update faraday-retry` with network access.
- **json 3 together with Rails 7.0:** I did not look for the exact json 3.0 changelog line that removes `quirks_mode`. The pin rests on the observed error. Upgrading Rails (7.1 or later no longer passes this option) would be the other way to lift the pin, but that is out of scope.
- **json `to_json` entries for `config/secrets.yml` (2.7.3, 2.17.0):** only covered indirectly, by boot succeeding and the credentials test passing with ASCII values.
- **json 2.19 `allow_blank` (`note.rb:17`):** not applicable. It is a validation option there, not a JSON call.

---

This is a plan only. Nothing in your repo has changed; the planner did its trial runs in throwaway copies under `/tmp/upgrade-lab-faraday`. A ready-made patch for all three fixes is at `/tmp/upgrade-lab-faraday/repairs.patch`. One gap remains before applying it: the plan was tested with faraday-retry 1.0.4, which is the only version that was available offline. For production, pin `~> 2.2` and run the citation tests again with network access. Tell me if you want me to apply it.