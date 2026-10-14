Here's the planner's upgrade plan. Nothing in the repo was changed.

---

I recommend going ahead with the upgrade, but two lines of `app/models/citation/provider.rb` must change in the same deploy. Faraday 2 dropped both middlewares the provider uses, so without those changes every citation lookup fails. No other app code uses Faraday, there are no framework defaults to adopt, and nothing stored or queued changes format.

**What I ran:** the change summary (saved to `/tmp/fc.txt`) and a standalone Ruby 3.3.6 script, `/tmp/fx_t.rb`. The script copies the provider's connection setup and runs it against a local WEBrick server that answers 503 once and then 200. It ran against three dependency sets, built from the Gemfile in `/tmp/fx/` with logs in `/tmp/fx/out_*.log`:

| Variant | Resolved gems | `:basic_auth` setup | `:authorization, :basic` setup |
|---|---|---|---|
| Current | faraday 1.10.4 | status 200, 2 requests, `Basic dTpw` sent both times | `ArgumentError: wrong number of arguments (given 4, expected 3)` |
| 2.12.2 alone | faraday 2.12.2, faraday-net_http 3.4.4 | `Faraday::Error: :retry is not registered on Faraday::Request` | same error |
| 2.12.2 plus faraday-retry | faraday 2.12.2, faraday-net_http 3.4.4, faraday-retry 2.4.0 | `Faraday::Error: :basic_auth is not registered on Faraday::Request` | status 200, 2 requests, `Basic dTpw` sent both times |

In every variant, a refused connection still raised `Faraday::ConnectionFailed`. I did not boot the app or run its test suite, so I never needed an isolated database, queue, cache or storage. I did not change the working repo.

## Required changes

**1. The retry middleware is no longer part of Faraday** (2.0.0, PR #1356)
- **Affected code:** `provider.rb:37`, `faraday.request :retry, max: 1, retry_statuses: [503]`.
- **If nothing is done:** building the connection raises `Faraday::Error: :retry is not registered on Faraday::Request`. `lookup` only rescues `ConnectionFailed` and `TimeoutError`, and this error is neither a `Provider::Error` nor `Unavailable`. So `CitationEnrichmentJob`'s `retry_on` never catches it, `fail_enrichment` is never called, and citations stay unenriched with the job failing. This is source-based; I didn't run the job.
- **Fix:** add `gem "faraday-retry", "~> 2.0"` (2.4.0 resolved) and `require "faraday/retry"`. Keep the options as they are.
- **Check:** with a stub that answers 503 then 200, assert 2 requests and status 200. The existing test at `test/controllers/citation_enrichments_controller_test.rb:12` does exactly this. As a control, a 404 must still be a single request that ends as `Provider::Error`.
- **Not verified:** what happens when both attempts get 503 (the response should come back as 503 and become `Unavailable`). Test that before release.

**2. `:basic_auth` was removed** (2.0.0, PRs #1306 and #1308)
- **Affected code:** `provider.rb:38`.
- **If nothing is done:** `Faraday::Error: :basic_auth is not registered on Faraday::Request`, with the same job effect as in finding 1.
- **Fix:** replace it with `faraday.request :authorization, :basic, @user, @password`. The table shows this sends an identical header on both the first request and the retry.
- **Check:** the existing credentials test at line 40 asserts the header the server receives. Add a check with a password containing `:` or non-ASCII characters to make sure the encoding matches 1.x. As a control, a 401 must still end as `Provider::Error`, not as `Unavailable`.
- **Not verified:** what header is sent when no user or password is configured.

**3. Default adapter and gem plumbing**
- net-http now comes from the separate `faraday-net_http` gem (3.4.4), and `default_adapter` stays at `:net_http`. No change is needed, but run `bundle update faraday`. That removes the ten 1.x sub-gems from `Gemfile.lock`, including `faraday-multipart` and `ruby2_keywords`.
- Check that nothing else in the bundle depends on faraday 1.x. Running `bundle lock` in the copy showed no conflict, but that was a minimal Gemfile, not the app's.

## Not applicable to this app

- Removed `Faraday::UploadIO`, multipart middleware and `Request#method`: the app doesn't use them.
- Faraday 2 needs Ruby 3.0 or later; the app runs 3.3.6.
- The 2.1 through 2.12 changelogs were not available (GitHub returned HTTP 403). As far as I know, those releases add features and fixes but no defaults this app relies on. That is unverified; read them before merging.

## Preparatory changes, rollout and rollback

- **Prepare on the current version?** Neither fix can ship ahead of the upgrade. On 1.10.4 the `:authorization, :basic` form fails with the `ArgumentError` shown above, and faraday-retry 2.x requires faraday 2. Make the code change, the Gemfile change and the lock change in one commit.
- **Stored data and queued jobs:** jobs carry only a GlobalID for the citation, and nothing Faraday-specific is serialized. Mixed-version workers and rollback are therefore safe, as long as each process runs a matching code and lock pair.

## Still to do before merging

Upgrade a disposable copy with its own database (the app uses PostgreSQL, so point `DATABASE_URL` at a fresh database), then run `bin/rails test test/controllers/citation_enrichments_controller_test.rb`, the full suite and `bin/rails zeitwerk:check`. Also run one enrichment end to end, from job enqueue through a provider that returns 503 twice.

---

This is a major-version jump: the lockfile has faraday 1.10.4. Only the planner ran the tests above, in a separate copy; the app's own test suite hasn't been run. If you want me to make the change, I'll do it in one commit:
- add `faraday-retry` to the Gemfile
- update the two lines in `provider.rb`
- run `bundle update faraday`
- run the test suite