# faraday 1.10.4 → 2.12.2 upgrade plan

**Summary:** This can't go in as a plain bump. It needs **3 repairs**: two Gemfile lines and one changed line in `app/models/citation/provider.rb`. None of the repairs are tied to new defaults, because `changes.md` has no "New framework defaults" section.
- With the repairs, the final check of `upgraded` (check 4) passes every step: **46 runs, 325 assertions, 0 failures, 0 errors, 0 skips**.
- `base` (check 1) gives the same numbers: 46 runs, 325 assertions, 0 failures, 0 errors.
- The repairs only work after the upgrade, so they go in the same commit as the Gemfile bump.

## Setup and evidence
- **Lab:** `/tmp/upgrade-lab-faraday`. The services are stopped and the files are kept.
  - `copies/base` is the application on faraday 1.10.4.
  - `copies/upgraded` is the application on faraday 2.12.2 with R1–R3 applied.
- **Changes summary:** `/tmp/upgrade-lab-faraday/changes.md`
- **Lock diff:** `/tmp/upgrade-lab-faraday/lock-diff.md`. 16 gems change:
  - faraday 1.10.4 → 2.12.2 and faraday-net_http 1.0.2 → 3.4.4 (both MAJOR).
  - json 3.1.0, net-http 0.10.0 and uri 1.1.2 are new, and each replaces a Ruby default gem.
  - faraday-retry, faraday-multipart, multipart-post, ruby2_keywords and the other faraday-* adapter gems are removed.
- **Checks:** `/tmp/upgrade-lab-faraday/checks/{base/01,upgraded/01..04,backport/01,backport-1/01}/`
- **Probes:** `/tmp/upgrade-lab-faraday/probe-{1,2,3}-{base,upgraded}.log`
- **Matrix:** `/tmp/upgrade-lab-faraday/matrix.log` (scripts are `writer.rb` and `reader.rb` in the lab)
- **Backport:** `/tmp/upgrade-lab-faraday/backport.log` and `backport-each.log`
- **Gem diff:** `/tmp/upgrade-lab-faraday/gem-diff.log`
- **Patch:** `/tmp/upgrade-lab-faraday/repairs.patch`
- **Notes:** `/tmp/upgrade-lab-faraday/notes.md`

## Required changes

**R1. Constrain json below 3** (Gemfile, after the faraday line)
- **Observed error:** boot failed in `checks/upgraded/01/boot.log`:
  `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`
  The call comes from `activesupport-7.0.8.7/lib/active_support/json/encoding.rb:110`, and the application frame is `config/environment.rb:5`.
- **Cause:** faraday 2.12.0 added json as an explicit dependency, so json 3.1.0 now replaces Ruby's default json 2.7.2.
  - json 3.0.0.rc1 removed legacy options, and the `quirks_mode:` keyword is now rejected.
  - Active Support 7.0 still passes `quirks_mode: true` in `JSON.generate` (encoding.rb:110) and `JSON.parse` (decoding.rb:23).
  - The error is inside a gem that moved with the bump, so the repair is a version constraint.
- **Repair:**
  ```diff
  +gem "json", "< 3" # json 3 rejects quirks_mode passed by Active Support 7.0
  ```
  This resolves to json 2.21.2.
- **Consequence if nothing is done:** the application doesn't boot at all.
- **Works on the current version:** yes. The backport bundle resolved json; its failure came from the faraday-retry line (R2).
- **Validation:** boot fails in check 1 and passes in check 2.
  - Control: boot, eager load, production boot, routes and assets stay `ok` in checks 2–4.
  - The serialization matrix is identical (see Rollout).

**R2. Add faraday-retry** (Gemfile; the call site is `app/models/citation/provider.rb:37`)
- **Observed error:** in `checks/upgraded/02/summary.md`:
  `Faraday::Error: :retry is not registered on Faraday::Request`
  The frames are provider.rb:37 → provider.rb:20 → citation.rb:29.
- **Cause:** upgrade guide 2.0, "Bundled middleware moved out". The retry middleware moved to the separate faraday-retry gem.
- **Repair:**
  ```diff
  +gem "faraday-retry", "~> 2.2" # retry middleware moved out of faraday 2.0
  ```
  This resolves to faraday-retry 2.4.0.
  - Bundler's autorequire registers the middleware.
  - The alternative is to drop the retry. That would break the tested behaviour "retrying one unavailable response".
- **Consequence if nothing is done:** every citation lookup raises, both in the citation-enrichment request and in `CitationEnrichmentJob`.
- **Works on the current version:** no. faraday 1.10.4 requires `faraday-retry ~> 1.0` (`checks/backport/01`).
- **Validation:** in check 3 the error moves from line 37 to line 38, which shows `:retry` is now registered. The test outcome itself only changes with R3.

**R3. Replace the `:basic_auth` middleware with `:authorization, :basic`** (`app/models/citation/provider.rb:38`)
- **Observed error:** in `checks/upgraded/03/summary.md`:
  `Faraday::Error: :basic_auth is not registered on Faraday::Request`
  The frames are provider.rb:38, :36 and :20.
- **Cause:** upgrade guide 2.0, "Authentication helper methods in Connection have been removed" (#1306/#1308). Basic auth is now the `authorization` middleware.
- **Repair:**
  ```diff
  -        faraday.request :basic_auth, @user, @password
  +        faraday.request :authorization, :basic, @user, @password
  ```
- **Consequence if nothing is done:** every citation lookup fails.
- **Works on the current version:** no. On 1.10.4 it fails with `ArgumentError: wrong number of arguments (given 4, expected 3)` (`backport-each.log`, `checks/backport-1/01`).
- **Validation:** check 3 → check 4 shows 3 tests newly passing in `CitationEnrichmentsControllerTest`:
  - "fetches a manually entered DOI's title and source URL, retrying one unavailable response"
  - "a provider that stays unavailable or refuses the request leaves a visible failure"
  - "provider credentials from the environment reach the server unchanged", which asserts the exact Basic header the server receives.
  - Control: the other 43 tests pass in every check.

## Default-related changes
There are none. `changes.md` has no "New framework defaults" section, so step 7 did not run.

## Other gems that move
- **faraday-net_http 3.4.4 (MAJOR):** the default adapter. No finding involves it. The happy path is covered by tests, and these probes gave identical results on both copies:
  - Probe 1, refused connection: `Citation::Provider::Unavailable: The provider could not be reached (...)` on both.
  - Probe 3, read timeout: `Net::ReadTimeout` turns into `Unavailable` on both, so the `Faraday::ConnectionFailed` and `Faraday::TimeoutError` rescue at provider.rb:29 still works.
- **json (new; replaces the default gem):** involved in R1. Probe 2 (`probe-2-*.log`) shows two other changes:
  - **Malformed escapes now fail.** `JSON.parse('{"a":"\q"}')` returned `{"a"=>"q"}` on base and raises `JSON::ParserError` on upgraded (json 2.17.0, "no longer ignore invalid escapes"). For this application, a provider response with a malformed escape becomes "The provider's response was not valid JSON" (handled at provider.rb:51) instead of being accepted. No repair is proposed; it is a stricter reading of invalid input.
  - **The input string's encoding is no longer changed.** On base, `JSON.parse` changed the string it was given from binary to UTF-8; on upgraded it leaves it binary (json 2.7.3). The parsed output is the same: `["Café", "https://x.test/"]`.
- **net-http 0.10.0 and uri 1.1.2 (new; replace default gems):** no finding. They are exercised by the passing test suite and by probes 1 and 3. `URI.parse` in `web_url?` gave the same result in probe 2.
- **faraday-retry 1.0.4:** removed from the lock by the bump, then re-added as 2.4.0 by R2.
- **faraday-multipart, the other adapter gems, multipart-post and ruby2_keywords:** removed. The application doesn't reference any of them.

## Rollout and rollback
- **Stored data (matrix, base/upgraded in every direction):** all cells are identical. Covered:
  - `Note#tags` (`serialize :tags, JSON`)
  - a JSON `MessageVerifier` message
  - Active Job arguments, including a Time

  So no stored data or queued work breaks in either direction.
- **Deploy order:** R2 and R3 only work after the upgrade, so all three repairs must ship in the same commit as `gem "faraday", "2.12.2"`. Rolling back means reverting that whole commit. Rolling back only the Gemfile would leave `:authorization, :basic`, which fails on 1.10.4.

## Not verified
- **json `to_json` entries (2.7.3, 2.7.5, 2.17.0) in `config/secrets.yml`:** covered only indirectly, because boot and the credentials test passed. No dedicated probe.
- **json 2.19.0 `allow_blank`:** the match at `note.rb:17` is an Active Model validation option, not a JSON option, so it doesn't apply.
- **json 3.x removals:** not reachable, because R1 keeps json below 3. Lifting R1 needs Rails ≥ 7.1, which no longer passes `quirks_mode`.
- **Ruby 3.4 default-gem warnings:** the test logs show warnings about bigdecimal and mutex_m. They appear on both copies and are unrelated to this upgrade.

---

This is a plan only. Your repository hasn't been changed; the planner tested everything in copies under `/tmp/upgrade-lab-faraday`. The three repairs are ready to apply as `/tmp/upgrade-lab-faraday/repairs.patch`, and they need to go in the same commit as the faraday bump. Want me to apply them and run the test suite here?