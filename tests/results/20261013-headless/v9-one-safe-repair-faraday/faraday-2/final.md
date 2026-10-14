# Plan: upgrading faraday from 1.10.4 to 2.12.2 in Margin Notes

The upgrade works, but only with four changes shipped together in one deploy. Faraday is used in one place, `Citation::Provider#connection` in `/home/user/workspace/repo/app/models/citation/provider.rb`, which runs from `CitationEnrichmentJob` (Sidekiq). With the version bump alone, every citation lookup fails and the app may not boot.

**What I ran.** I tested in a disposable copy (`/tmp/fx/app`) using its own Postgres database (`margin_notes_fx_test`, dropped afterwards). The test environment uses the `:test` job adapter, so Redis and Sidekiq were not touched. The working repository is unchanged.

| Variant | Result | Log |
|---|---|---|
| Baseline, faraday 1.10.4 | 46 runs, 0 failures | `/tmp/fx/base.log` |
| Bump only (`bundle update faraday --conservative`) | The app does not boot (Finding 1) | `/tmp/fx/bundle.log`, `/tmp/fx/up1.log` |
| Plus `json < 3` | Boots; citation tests: 1 failure, 2 errors (`:retry`) | `/tmp/fx/up2.log` |
| Plus `faraday-retry ~> 2.2` | Same tests: 1 failure, 2 errors (`:basic_auth`) | `/tmp/fx/up3.log` |
| Plus the auth middleware change | Citation tests 4/4 pass; full suite 46 runs, 0 failures; `zeitwerk:check` "All is good!" | `/tmp/fx/up4.log`, `/tmp/fx/full.log` |

The final lockfile resolved faraday 2.12.2, faraday-net_http 3.4.4, net-http 0.10.0, uri 1.1.2, faraday-retry 2.4.0 and json 2.21.2. It dropped multipart-post, ruby2_keywords and the faraday-* 1.x adapter gems. The change summary is in `/tmp/fc.txt`; it found no textual matches, but the removals it listed (retry middleware, auth helpers) turned out to be exactly what breaks.

## Required changes

**1. New `json` dependency stops the app from booting (found by running it, not in the changelogs).**
- **Cause:** faraday 2.12.2 adds a `json` gem dependency. Bundler resolved json 3.1.0, which doesn't work with ActiveSupport 7.0.8.7. The failure comes from `to_json` in `config/secrets.yml`'s ERB, via `Rails.application.secrets`.
- **Error:** `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`.
- **Affects:** every boot path: server, Sidekiq, runner, tests.
- **Fix:** add `gem "json", "< 3"` to the Gemfile. I only tested json 2.21.2. A tighter pin near Ruby 3.3's bundled 2.7.2 would also be reasonable, but I didn't test it.
- **Check:** `bin/rails runner 'p Rails.application.secrets.citation_provider'` boots.

**2. The `:retry` middleware was removed in 2.0.**
- **Error:** `Faraday::Error: :retry is not registered on Faraday::Request` at provider.rb:37.
- **What happens if nothing is done:** this is a plain `Faraday::Error`. The rescue only catches `ConnectionFailed`/`TimeoutError`, so it isn't turned into `Unavailable`. The job's `retry_on` never runs and `fail_enrichment` never records the failure. Citations would stay "Pending" while Sidekiq retries the job until it gives up.
- **Fix:** add `gem "faraday-retry", "~> 2.2"`. Bundler's auto-require loaded it, so no explicit `require` was needed. Keep `max: 1, retry_statuses: [503]` as is.
- **Check:** the existing tests expecting 2 requests (503 then 200) and 6 requests (3 attempts x 2) both passed.

**3. `request :basic_auth` was removed in 2.0.**
- **Error:** `:basic_auth is not registered on Faraday::Request (Faraday::Error)`.
- **Fix:** replace provider.rb line 38 with:
  ```ruby
  faraday.request :authorization, :basic, @user, @password
  ```
- **Checks:**
  - The credentials test passes with user `"00123"` and password `"sample: value # keep"`.
  - With nil credentials (production with the env vars unset), both versions send the same `"Basic Og=="` header. I tested this with the `:test` adapter.
- **Not a preparatory change:** on 1.10.4 this line fails with `wrong number of arguments (given 4, expected 3) (ArgumentError)` (checked in the copy). The auth change, `faraday-retry` 2.x (which requires faraday 2) and the version bump must land in one commit and one deploy.

**4. The Gemfile pin itself:** change `gem "faraday", "1.10.4"` to `"2.12.2"`.

## Per-release review (1.10.6 to 2.12.2)

Faraday has no Rails-style framework-defaults mechanism, so there are no new configuration defaults to adopt or keep. These are the behavior changes that could matter here:

- **2.0:**
  - Adapters were moved to separate gems. `faraday-net_http` is still a dependency and is used implicitly, so it is unaffected.
  - `UploadIO`, multipart, `Request#method` and the auth helpers were removed. Only the auth helpers are used here (Finding 3).
  - The default adapter was briefly removed and then restored as `:net_http` in 2.0.1.
- **2.x error classes:** `ConnectionFailed` and `TimeoutError` still exist, so the rescue still works. The 401, 404 and 500 handling relies on `response.status` without the `raise_error` middleware, and that is unchanged (tests pass).
- **2.7 to 2.12:** I found nothing that affects one GET request with `open_timeout`/`timeout`. Proxy and env-var handling changes only matter if `HTTP_PROXY` is set in production; I didn't verify that.

## Rollout and rollback

- **Stored data and queued jobs:** no stored data format depends on faraday. Queued `CitationEnrichmentJob`s carry a GlobalID for the citation, so jobs enqueued by old processes run fine on new workers, and the reverse.
- **Mixed versions:** each process uses its own bundle, so there is no shared state to conflict.
- **Rollback:** revert the Gemfile, Gemfile.lock and provider.rb together. Reverting only the lockfile brings back Finding 3 in reverse.
- **Deploy:** check that the production bundle install has network access for the new gems (net-http, uri, json, faraday-retry).

## Still unverified (proposed checks)

- I did not boot the production environment or a real Sidekiq worker. Proposed: run `RAILS_ENV=production bin/rails runner 'Citation::Provider.new'` with the env vars set, and do one enrichment through Sidekiq against `bin/citation-provider` in a staging Redis namespace.
- I did not test a real timeout or connection refusal, though the error class names are unchanged in source. Proposed: point the URL at a closed port and confirm "The provider could not be reached" appears.
- I did not run the browser suite (`bin/rails test:system`); it doesn't exercise the HTTP client.

---

The upgrade-gem skill only produces a plan, so I haven't changed your repository. All of the testing above was done in a throwaway copy. If you want me to make the changes, I'll put all four in one commit: the faraday pin, `json < 3`, `faraday-retry ~> 2.2`, and the `:authorization` line in `app/models/citation/provider.rb`.