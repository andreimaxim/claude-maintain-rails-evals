I planned the upgrade but haven't applied it. The planning step leaves your repository unchanged. faraday is currently at 1.10.4. Here is the planner's full report:

# faraday 1.10.4 to 2.12.2: upgrade plan for Margin Notes

The upgrade needs three changes, all in `app/models/citation/provider.rb` and the Gemfile. Without them, faraday 2.12.2 won't boot, and every 2.x release before it boots but breaks citation lookups. With all three applied in a lab copy, boot, database preparation, eager loading, routes and the 46-test suite all pass. A probe of the citation provider also gave the same output as today. I didn't run the browser tests or contact a real provider. I changed nothing in `/home/user/workspace/repo`; all work was in the lab copies, and the source hash check confirmed the original is unchanged.

## Required changes

**F1. Add faraday-retry.** faraday 2.0 moved the retry middleware out of the main gem.
- **Without the fix:** every lookup fails with `Faraday::Error: :retry is not registered on Faraday::Request` before any request is sent. `Citation::Provider` doesn't catch this error, so the enrichment job fails outright instead of recording a failed status. The app still boots, so a deploy would look healthy until enrichment runs.
- This happened in the test runs for every sampled 2.x release from 2.0.1 to 2.11.0.
- **Fix:**
  - Add `gem "faraday-retry", "~> 2.2"`, which resolved to 2.4.0.
  - Add `require "faraday/retry"` at the top of `provider.rb`.
  - Keep `request :retry, max: 1, retry_statuses: [503]` unchanged.
- **Probe after the fix, identical to today:**
  - 503 then 200: succeeds after 2 requests.
  - 503 every time: reports "unavailable (HTTP 503)" after 2 requests.
  - 500: no retry, 1 request.
  - Slow server: times out after about 10 seconds (two 5-second attempts), as now.

**F2. Replace `request :basic_auth`.** faraday 2.0 removed that middleware.
- **Without the fix:** every lookup fails with `:basic_auth is not registered on Faraday::Request`. F1 hides this error until retry is fixed.
- **Fix:** `faraday.request :authorization, :basic, @user, @password`.
- **Probe:** the Authorization header is byte-identical to today for:
  - user `00123` with password `sample: value # keep` (`Basic [REDACTED]`);
  - long 40+40-character credentials;
  - a missing password (`Basic YTo=`).

**F3. Pin json to 2.7.2.** faraday 2.12 adds a json dependency, and Bundler then installs json 3.1.0.
- **Without the fix:** nothing boots — web, Sidekiq, console or tests. The error is `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`, raised from Rails 7.0's JSON encoding while it reads the `.to_json` calls in `config/secrets.yml`.
- **Fix:** add `gem "json", "2.7.2"`. That's the version the app loads today, so JSON behaviour doesn't change.
- **Result:** with this pin, all checks and the probe match today.
- **The looser `~> 2.7` alternative:** it resolves to 2.21.2 and also passed. It brings later json behaviour changes (stricter handling of invalid escapes, warnings on duplicate keys), so treat it as a separate upgrade.

## Rollout risk

**R1. Several networking libraries move up for the whole app.** These become bundled gems at much newer versions:
- faraday-net_http goes from 1.0.2 to 3.4.4.
- net-http goes from 0.4.1 to 0.10.0.
- uri goes from 0.13.1 to 1.1.2, and its default URL parser changes.

What was checked:
- The app's URL check (`web_url?`) gave identical results to today on 11 test URLs.
- Read timeouts behave the same.

What wasn't checked:
- Connection-open timeouts.
- Outgoing mail delivery.
- The browser tests.

Plan to watch citation enrichment failures and outgoing mail after deploy.

## Rollout order

1. Deploy the json 2.7.2 pin first. It's the version already loaded, so it changes nothing. I tested `~> 2.7` (2.21.2) on the current faraday, but not the exact 2.7.2 pin.
2. Then deploy the faraday bump with F1 and F2 together, including `Gemfile.lock`.
3. To roll back, revert step 2 as a whole; the json pin can stay. Don't remove the pin while on faraday 2.12 or later with Rails 7.0.

No cookies, cache entries, database values or queued jobs depend on faraday, and no framework defaults were collected, so there are no default decisions to make.

## Gaps and checks not run

- For faraday, faraday-net_http, faraday-retry and uri, the installed version's release tag isn't an ancestor of the target tag.
- I didn't read the code diff between the installed and target releases for faraday-net_http and faraday-retry. For faraday I opened only the authentication commit, and confirmed the retry-removal commit from the commit list.
- The library code changes in net-http, uri and json were checked through changelogs and the probes, not patch by patch.
- Not run:
  - the browser test suite (`bin/rails test:system`);
  - a real citation provider (only local test servers);
  - connection-open timeout behaviour;
  - mail delivery.
- Passing the existing tests doesn't prove the upgrade is safe on its own. These are the remaining checks.

## Files

- Lab: `/tmp/gem-upgrade-20261014-71514-tu5kh5`
- Plan data: `/tmp/gem-upgrade-20261014-71514-tu5kh5/plan.json`. Render it with `ruby /home/user/planner-run/maintain-rails/bin/gem-upgrade-report render` to get the full report with every run record.
- Copy with all three fixes: `/tmp/gem-upgrade-20261014-71514-tu5kh5/variants/v2_12_2_json272/app`
- Other copies:
  - `v2_12_2` (unfixed);
  - `v2_12_2_repaired` (json `~> 2.7`);
  - `v2_12_2_retry_only` (basic_auth left unchanged);
  - `baseline_json_pin` (json pin on the current faraday).
- Probes: `/tmp/gem-upgrade-20261014-71514-tu5kh5/probes/` (`provider_probe.rb`, `uri_probe.rb`, `timeout_probe.rb`)
- Run records and logs: `/tmp/gem-upgrade-20261014-71514-tu5kh5/runs/`. The key ones are `v2_12_2/003-boot.log`, `v2_11_0/007-tests.log`, `v2_12_2_json272/007-tests.log`, and `baseline/007-probe.log` vs `v2_12_2_json272/008-probe.log`.
- Sources: `/tmp/gem-upgrade-20261014-71514-tu5kh5/sources/index.md` and `/tmp/gem-upgrade-20261014-71514-tu5kh5/dependencies-target/index.md`

---

Simply changing the version number would break the app: the app would fail to boot (json), and citation lookups would fail (`:retry` and `:basic_auth`). Do you want me to apply the json pin, faraday-retry and the `:authorization` change in the repository, then run `bin/rails test` and `bin/rails test:system`?