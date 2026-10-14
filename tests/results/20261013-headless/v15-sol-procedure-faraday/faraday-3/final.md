## Upgrade plan: faraday 1.10.4 → 2.12.2 (Margin Notes)

**Verdict:** The upgrade works, but it needs three changes. Simply bumping the version breaks the app before it can start. With the three repairs below, all lab checks pass: bundle, boot, eager load, routes, database, the 46 tests (0 failures) and a production-mode boot. I used Ruby 3.3.6 and only ever read the real checkout, which is still clean at `ab732f5`.

### Required repairs (in the order they appeared)

1. **F1: limit json to below version 3** (`Gemfile`: `gem "json", "< 3"`, with a comment saying why).
   - **Cause:** faraday 2.12.2 newly depends on `json`, so Bundler locked json 3.1.0 instead of Ruby's built-in json 2.7.2. json 3.0 rejects options it doesn't recognise, and ActiveSupport 7.0.8.7 passes one (`quirks_mode: true`, at `active_support/json/encoding.rb:110`).
   - **Observed failure:** `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`, raised while `config/secrets.yml` is read at boot. Every step after bundle failed. Log: `/tmp/gem-upgrade-20261014-8160-widpd3/runs/20261014T154020-146d03-unmodified-boot/output.log`.
   - **Current version:** works with 1.10.4 too, so it can land first. Remove the limit once Rails is upgraded past 7.0.

2. **F2: add the separate retry gem** (`Gemfile`: `gem "faraday-retry", "~> 2.2"`, which locks 2.4.0). No code change is needed because Bundler loads it.
   - **Cause:** Faraday 2.0 moved the retry middleware out of the core gem.
   - **Observed failure:** `Faraday::Error: :retry is not registered on Faraday::Request`, raised from `faraday-2.12.2/lib/faraday/middleware_registry.rb:57` when `app/models/citation/provider.rb:37` runs. Log: `.../runs/20261014T154216-dd2c75-repair1-tests/output.log`.
   - **Current version:** faraday-retry 2.4.0 requires faraday 2.x, so this must ship together with the bump.

3. **F3: switch the basic-auth line in `provider.rb:38`** to `faraday.request :authorization, :basic, @user, @password`.
   - **Cause:** Faraday 2.0 removed the `:basic_auth` middleware.
   - **Observed failure:** `Faraday::Error: :basic_auth is not registered on Faraday::Request`. Log: `.../runs/20261014T154239-d0270d-repair2-tests/output.log`.
   - **Current version:** this also must ship with the bump. On 1.10.4 the new line fails with `wrong number of arguments (given 4, expected 3)` at `faraday-1.10.4/lib/faraday/request/authorization.rb:48`.

**Rollout order:**
1. Optionally land F1 on its own first.
2. Ship the faraday bump, F2 and F3 as one atomic change.
3. Rollback means reverting the Gemfile, Gemfile.lock and `provider.rb` together.

Nothing stored changes:
- **Error messages:** the `enrichment_error` messages written to citations are identical before and after.
- **Queued jobs:** the job payload written under one json version reads correctly under the other, and is written back byte-identically.

So web servers and Sidekiq workers running different versions during a deploy are safe.

**Optional defaults:** none. `defaults.json` was empty and Faraday has no framework-default settings, so I tested no optional adoption.

### How each finding was checked

The main probe is `/home/user/planner-run/probes-faraday/provider_probe.rb`. It sends unequal data (user `00123` and a non-ASCII password) to a local test server. Each repair was checked three ways: on the baseline (B), on a fork with the bump but that repair missing (W), and on the fully repaired fork (U).

- **F1:** Without it, W fails at boot with the same `quirks_mode` error. With it, the probe's JSON checks pass on B, W and U, and ActiveSupport produces the same JSON output in both versions.
- **F2:**
  - **Without it:** W reports `:retry is not registered`.
  - **With it, on both B and U:**
    - A 503 followed by a 200 returns the metadata after 2 requests.
    - A 503 every time gives `Unavailable (HTTP 503)` after exactly 2 requests.
    - A read timeout is retried once (11.0s in both versions).
  - **Control:** 500 and 401 responses make only 1 request.
- **F3:**
  - **Without it:** W reports `:basic_auth is not registered`.
  - **With it:** on B and U the header is exactly `Basic [REDACTED]` on both attempts, and missing credentials send `Basic Og==` in both versions.
  - **Control:** a 401 still produces "The provider rejected the configured credentials (HTTP 401)".
  - **Production mode:** the boot lists the expected middleware (retry, then authorization).
- **F4 (deploy note, no change needed):** the bump adds three new transitive gems: uri 1.1.2, net-http 0.10.0 and faraday-net_http 3.4.4. uri 1.x switches to a different default URL parser. I compared the app's check on stored `source_url` values across 10 tricky inputs (`uri_probe.rb`) and the results were identical. The test suite shows no new warnings.
- **Queued jobs:** `payload_probe.rb` checked old-version-writes/new-version-reads and the reverse. Both passed.

**Sources:** I read the 2.0 upgrade guide, all 246 changelog entries from 1.10.6 to 2.12.2, and the relevant versioned faraday code. I also scanned every group for json, uri, net-http and faraday-net_http. All 63 review groups are marked reviewed with reasons, and `gem-upgrade-review check` passed.

### Limits
- I did not run the browser tests (`bin/rails test:system`).
- No real citation provider, TLS or proxy was contacted; all HTTP went to local test servers.
- The open-timeout path (a host that can't be reached at all) was not exercised; only refused connections and read timeouts were.
- I did not test Ruby 3.4. The test helper uses Base64, which faraday 2.9 no longer pulls in.
- I did not read individual commits beyond the code listed above, nor the faraday-retry changelog. I did compare its default settings between 1.0.4 and 2.4.0, and they match.
- No step-by-step bisection through intermediate versions was needed, because each error pointed to a specific upstream source location.

### Files
- Evidence and review: `/home/user/planner-run/evidence-faraday/` (`review.json`, `repaired.diff`, `coverage.json`, `dependencies.tsv`, `dependencies/`)
- Probes: `/home/user/planner-run/probes-faraday/` (`provider_probe.rb`, `uri_probe.rb`, `payload_probe.rb`, `fill_review.py`)
- Labs (services cleaned up, run logs kept):
  - Baseline: `/tmp/gem-upgrade-20261014-6947-hvox8d`
  - Repaired fork: `/tmp/gem-upgrade-20261014-8160-widpd3`
  - Fork for checking each repair's absence: `/tmp/gem-upgrade-20261014-11127-7cx3hw`

---

**My notes:** This is a plan only. Your working tree hasn't changed and is still clean at `ab732f5`. The upgrade needs three changes: limit json to below 3, add `faraday-retry`, and change the auth line in `app/models/citation/provider.rb:38`. The json limit can land on its own first. The other two must ship together with the bump. The tested patch is in `/home/user/planner-run/evidence-faraday/repaired.diff`. Want me to apply it?