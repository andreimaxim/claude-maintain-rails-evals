# faraday 1.10.4 → 2.12.2 upgrade plan

**Summary:** This can't go in as a plain bump. It needs **3 repairs**: two Gemfile lines and one line in `app/models/citation/provider.rb`. There are no default-related repairs, because faraday has no "New framework defaults" section. With the repairs, the final check of `upgraded` (check 4) passed every step: **46 runs, 325 assertions, 0 failures, 0 errors, 0 skips**. `base` gave the same result: 46 runs, 325 assertions, 0 failures, 0 errors, 0 skips. Without the repairs, the application doesn't boot.

## Setup and evidence
- **Lab directory:** `/tmp/upgrade-lab-faraday`. The lab services have been stopped.
- **Copies:**
  - `copies/base` is faraday 1.10.4.
  - `copies/upgraded` is faraday 2.12.2 plus the repairs.
- **Changes summary:** `/tmp/upgrade-lab-faraday/changes.md`
- **Notes:** `/tmp/upgrade-lab-faraday/notes.md`
- **Lock diff:** `/tmp/upgrade-lab-faraday/lock-diff.md`
- **Check logs:** `checks/base/01`, `checks/upgraded/01`–`04`, `checks/backport/01`, `checks/backport-1/01`
- **Probe logs:** `probe-1-{base,upgraded}.log`, `probe-2-{base,upgraded}.log`
- **Backport logs:** `backport.log`, `backport-each.log`
- **Gem diff:** `gem-diff.log`, `gem-source.diff`
- **Patch:** `/tmp/upgrade-lab-faraday/repairs.patch`

## Required changes

**R1. Keep the json gem below 3** (Gemfile, after line 39)
- **Observed error** (boot, `checks/upgraded/01/boot.log`): `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)` from `activesupport-7.0.8.7/lib/active_support/json/encoding.rb:110`. The application frame is `config/environment.rb:5`.
- **Cause:**
  - faraday 2.12.0 added "json as an explicit dependency". The bundle resolved json 3.1.0, which replaces Ruby's default json 2.7.2.
  - json 3.0 removed options that ActiveSupport 7.0's encoder still passes.
  - This error is in a gem that moved with the bump, so the repair is a version constraint.
- **Consequence if nothing is done:** the application doesn't boot in any environment.
- **Repair:**
  ```diff
   gem "faraday", "2.12.2"
  +gem "json", "< 3"
  ```
  It resolves to json 2.21.2.
- **Works on the current version:** not tested on its own. The `--each-file` backport only covers `provider.rb`, and the whole-patch backport failed on R2. The base lock has no json gem today, so `< 3` would probably resolve to a compatible 2.x on faraday 1.10.4 as well.
- **Validation:**
  - Fails without the repair: check 1, boot FAIL.
  - Passes with it: check 2, where boot, eager-load, production boot, routes and assets are all ok.
  - Control: the `to_json` / `JSON.generate` output in probe 1 is identical on both copies (`{"a":"é"}`, `{"t":"x"}`).

**R2. Add the faraday-retry gem** (Gemfile; the middleware is used at `app/models/citation/provider.rb:37`)
- **Observed error** (`checks/upgraded/02`): `Faraday::Error: :retry is not registered on Faraday::Request`. Two tests fail with it:
  - `fetches a manually entered DOI's title and source URL, retrying one unavailable response`
  - `a provider that stays unavailable or refuses the request leaves a visible failure`
- **Cause:** the upgrade guide, section "2.0: Bundled middleware moved out". The retry middleware is now in the separate `faraday-retry` gem.
- **Consequence if nothing is done:** every citation lookup raises when the connection is built. DOI enrichment breaks completely.
- **Repair:**
  ```diff
  +gem "faraday-retry", "~> 2.2"
  ```
  It resolves to 2.4.0. Bundler requires it automatically, so no explicit `require` was needed.
- **Works on the current version:** no. faraday 1.10.4 depends on `faraday-retry ~> 1.0` (`backport.log`). This **requires the upgrade** and ships in the same commit as the faraday bump.
- **Validation:**
  - Fails without the repair: check 2.
  - Passes with it: check 3, where the error moves on to line 38 (R3).
  - Control: the retry-on-503 test passes in check 4, so `max: 1, retry_statuses: [503]` is still honoured.

**R3. Replace the basic_auth middleware** (`app/models/citation/provider.rb:38`)
- **Observed error** (`checks/upgraded/03`): `Faraday::Error: :basic_auth is not registered on Faraday::Request`. The same 2 tests fail, along with the failure in `provider credentials from the environment reach the server unchanged`.
- **Cause:** the upgrade guide, section "2.0: Authentication helper methods in Connection have been removed" (PR #1306/#1308). Use the `:authorization` middleware instead.
- **Consequence if nothing is done:** every citation lookup fails.
- **Repair:**
  ```diff
  -        faraday.request :basic_auth, @user, @password
  +        faraday.request :authorization, :basic, @user, @password
  ```
- **Works on the current version:** no. On 1.10.4 it fails with `ArgumentError: wrong number of arguments (given 4, expected 3)` (`backport-each.log`). This **requires the upgrade** and ships in the same commit.
- **Validation:**
  - Fails without the repair: check 3.
  - Passes with it: check 4. All 3 CitationEnrichmentsControllerTest tests went from failing to passing.
  - The credentials test asserts that the server receives the `basic_auth(user, password)` header unchanged.
  - Control: in probe 1, a long user/password with non-ASCII characters produces a well-formed `Basic …` header with no line breaks.

## Default-related changes
None. `changes.md` has no "New framework defaults" section, so step 7 was skipped.

## Other gems that move
- **faraday-net_http 1.0.2 → 3.4.4 (MAJOR):** this is the default adapter, which every lookup uses. No finding involved it. Probes 1 and 2 behaved the same on both copies: a refused connection and a read timeout both raise `Faraday::ConnectionFailed` / `Faraday::TimeoutError`, which the rescue at provider.rb:29 maps to `Citation::Provider::Unavailable` (`Net::ReadTimeout`).
- **json (new; replaces Ruby's default gem 2.7.2):** this is R1. Probe 1 showed one difference: `JSON.parse` no longer re-tags a BINARY input string as UTF-8 (base prints `UTF-8`, upgraded prints `ASCII-8BIT`; json 2.7.3 entry). It has no effect here, because `metadata_from` only uses the parsed hash and never reuses `body`.
- **net-http 0.10.0 and uri 1.1.2 (new; both replace Ruby's default gems):** the HTTP path (probes 1 and 2, controller tests) and `URI.parse` in `web_url?` (controller tests) behaved the same. Neither was involved in a finding.
- **Removed gems:** the faraday-* adapter gems (em_http, em_synchrony, excon, httpclient, multipart, net_http_persistent, patron, rack), multipart-post and ruby2_keywords. The application doesn't use any of them directly. faraday-retry was also removed and is re-added at version 2.x by R2.

## Rollout and rollback
- **Matrix:** not run (step 8). No entry in the notes concerns serialization, cookies, sessions, cache, signed messages or job arguments. Faraday is only used for synchronous HTTP calls.
- **Deploy:** ship R2 and R3 in the same commit as the faraday bump, because neither works on 1.10.4. R1 belongs in that commit too.
- **Rollback:** revert the whole commit. No stored data or queued work depends on the faraday version.

## Not verified
- **R1 on its own on 1.10.4:** not checked separately, because the per-file backport only covers application files.
- **Faraday 2.0 removals:** `default_adapter`, `Request#method`, `Response::Middleware`, `UploadIO`, and the deep-merge of `default_connection_options`. A `grep` shows the application doesn't use any of them, and nothing failed.
- **Responses from other gem-diff files:**
  - `raise_error.rb` (`RequestTimeoutError` for 408) only applies when the `:raise_error` middleware is used, and the application doesn't use it.
  - `connection.rb` and the options files: the connection-building path the application uses is covered by the tests and probes.
- **Other json 3.x removals** (`JSON.load` additions, `fast_generate`, and others) don't apply here, because R1 keeps json on 2.x. Moving to json 3 needs Rails ≥ 7.1 first.

---

I only planned this upgrade. I haven't changed anything in your repository, which is still on faraday 1.10.4. The plan was tested on separate copies in `/tmp/upgrade-lab-faraday`, and the three repairs together are in `/tmp/upgrade-lab-faraday/repairs.patch`. Should I apply them with the faraday bump in one commit?