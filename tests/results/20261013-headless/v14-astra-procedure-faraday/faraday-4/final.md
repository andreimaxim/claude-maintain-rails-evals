# faraday 1.10.4 to 2.12.2 upgrade plan

Margin Notes uses Faraday only in app/models/citation/provider.rb (Citation::Provider#connection, called by Citation#enrich via CitationEnrichmentJob). Faraday 2.12.2 cannot be adopted by changing the version pin alone: (1) the 2.12.2 resolution adds json 3.1.0, which stops boot under ActiveSupport 7.0.8.7 while secrets.yml is rendered; (2) the :retry middleware is no longer bundled (Faraday::Error ':retry is not registered'); (3) the :basic_auth middleware was removed (Faraday::Error ':basic_auth is not registered'). Required repair, verified in fork v2_12_2_jsonpin: Gemfile `gem "faraday", "2.12.2"`, `gem "faraday-retry", "~> 2.2"` (resolved 2.4.0), `gem "json", "~> 2.7.2"` (resolved 2.7.6), and in provider.rb replace `faraday.request :basic_auth, @user, @password` with `faraday.request :authorization, "Basic", ["#{@user}:#{@password}"].pack("m0")`. The provider.rb line also works on 1.10.4 (fork baseline_compat: 46 runs, 0 failures), so it can ship before the gem bump. With json allowed to 2.21.2, a provider body with an invalid JSON escape changes from accepted ('Tq') to 'not valid JSON'; the json pin keeps the old result. faraday-retry 2.x now waits for a RateLimit-Reset header on a 503 (0.0s on baseline, 3.0s on target); this is a rollout risk.

## Required

### F1. Target resolution adds json 3.1.0, and the app fails to boot under Rails 7.0

Affected code: Gemfile:39; config/secrets.yml:7-9 (ERB .to_json); Gemfile.lock.

Applies when: Always applies. faraday 2.12.2 declares `json >= 0`, so Bundler locks the newest json (3.1.0) instead of using Ruby 3.3's default json 2.7.2.

The v2_12_2 boot stage fails before any request: "json-3.1.0/lib/json/common.rb:377:in `generate': unknown keyword: quirks_mode (ArgumentError)" from activesupport-7.0.8.7 json/encoding.rb while rendering secrets.yml. Boot, db:prepare, eager loading, routes and tests did not run.

Recommendation: Add `gem "json", "~> 2.7.2"` to the Gemfile next to faraday (resolved 2.7.6 in v2_12_2_jsonpin). This keeps the json series that the baseline loads from Ruby's default gem. Move json separately with the Rails upgrade.

Other paths: Every to_json/JSON.parse caller in the app (Jbuilder views, Sidekiq job serialization, provider JSON.parse) uses the pinned json. The full test suite passed in v2_12_2_jsonpin (46 runs, 325 assertions, 0 failures).

Current-version preparation: json ~> 2.7.2 is compatible with faraday 1.10.4. Adding the pin before the bump was not executed (proposed). It would change json from the default gem 2.7.2 to a bundled 2.7.x.

Rollout and rollback: Deploy in the same release as the faraday bump (or earlier). To roll back, revert the Gemfile and Gemfile.lock together. No persisted data depends on the json version.

Evidence (executed): Lock in v2_12_2: faraday 2.12.2, faraday-net_http 3.4.4, json 3.1.0. With `~> 2.7` json resolved 2.21.2 and booted, but changed parsing (F4).
- Source: sources/pages/requirements-433b7afffa4e.md (faraday 2.12.2: json >= 0)
- Source: dependencies-v2_12_2/manifest.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2/003-boot.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/001-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/002-bundle.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/003-boot.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/004-database.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/005-eager.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/006-routes.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/007-tests.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/008-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/009-probe.json

Validation data: Unchanged app with faraday 2.12.2 and no json pin (variant v2_12_2); same app with json ~> 2.7.2 (v2_12_2_jsonpin).
- Without repair: check boot stage exits 1 with ArgumentError 'unknown keyword: quirks_mode' (runs/v2_12_2/003-boot.log).
- With repair: check v2_12_2_jsonpin: bundle, boot, database, eager, routes, tests all succeed; 46 runs, 325 assertions, 0 failures.
- Unchanged control: Baseline sweep check passes all stages with json 2.7.2 (runs/baseline).

### F2. Retry middleware moved out of faraday into faraday-retry

Affected code: app/models/citation/provider.rb:37 (faraday.request :retry, max: 1, retry_statuses: [503]); Gemfile.

Applies when: Always applies. Every Citation::Provider#lookup builds this connection.

Without faraday-retry, every lookup raises Faraday::Error ':retry is not registered on Faraday::Request'. This is not one of the rescued Faraday::ConnectionFailed or Faraday::TimeoutError classes, so CitationEnrichmentJob fails outside the Unavailable retry_on path. Observed in sweep variants v2_0_1 through v2_11_0 (tests: 1 failure, 2 errors).

Recommendation: Add `gem "faraday-retry", "~> 2.2"` (resolved 2.4.0). Bundler.require loads faraday/retry. Optionally add `require "faraday/retry"` at the top of provider.rb for non-Bundler.require contexts.

Other paths: Probes in v2_12_2_jsonpin: 503 then 200 -> 2 requests; persistent 503 -> 2 requests then Citation::Provider::Unavailable; 500 -> 1 request (not retried). These match the baseline. Controller test asserting 6 requests over 3 job attempts passed.

Current-version preparation: faraday-retry 2.x requires faraday 2, so it must be added in the same change as the bump. On 1.10.4 the bundled faraday-retry 1.0.4 is already used.

Rollout and rollback: Ship the Gemfile change with the faraday bump. Rollback reverts Gemfile and lock together. No stored state.

Evidence (executed): In v2_12_2_fixed (faraday-retry added, basic_auth unchanged), the error moved to :basic_auth (F3).
- Source: sources/pages/guide-989ca054dcae.md 'Bundled middleware moved out'
- Source: changelog 2.0 30cc388f4ee5 (#1356)
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_0_1/007-tests.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/008-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/007-probe.json

Validation data: Loopback Puma provider serving [503, 200], [503] forever and [500]; user '00123', password 'sample: value # keep'.
- Without repair: v2_0_1 tests: Faraday::Error ':retry is not registered on Faraday::Request' (runs/v2_0_1 tests log).
- With repair: probe.rb retry_503_then_200_requests == 2, retry_503_exhausted == ['Citation::Provider::Unavailable', 2], no_retry_on_500 == 1 in v2_12_2_jsonpin.
- Unchanged control: The same probe assertions pass on baseline (runs/baseline/007-probe.*).

### F3. :basic_auth request middleware removed; provider credentials are never sent

Affected code: app/models/citation/provider.rb:38 (faraday.request :basic_auth, @user, @password).

Applies when: Always applies. Every lookup on faraday >= 2.0.

Each lookup raises Faraday::Error ':basic_auth is not registered on Faraday::Request' before any request is sent. Citation enrichment cannot complete, and the error is not mapped to Unavailable or Error. Observed in v2_12_2_fixed (2 errors and 1 failure in citation_enrichments_controller_test, and 11 of 13 probe assertions failing).

Recommendation: Replace line 38 with `faraday.request :authorization, "Basic", ["#{@user}:#{@password}"].pack("m0")`. This form passes one value, so faraday 1.10.4 Authorization.header and faraday 2.x header_from both produce 'Basic <base64>'. It does not depend on the base64 gem.

Other paths: Unchanged paths: 200 metadata, 401 message, connection refused, read timeout and the URL matrix still match baseline. The Authorization header bytes are identical for unequal credentials and for nil/nil ('Basic Og==', production with unset env).

Current-version preparation: Executed: fork baseline_compat (faraday 1.10.4 + new line) passes the full suite (46 runs, 325 assertions, 0 failures) and every probe value equals baseline.

Rollout and rollback: The code change can deploy first, on 1.10.4. Then deploy the Gemfile bump. Rolling back the bump alone is safe because the code works on both versions.

Evidence (executed): The controller test 'provider credentials from the environment reach the server unchanged' also passes in v2_12_2_repaired and v2_12_2_jsonpin.
- Source: changelog 2.0 0febd73769d0 (#1308)
- Source: sources/repositories/3133a56050b1/range.patch lib/faraday/request.rb (basic_auth registration removed), request/basic_authentication.rb deleted
- Source: guide-989ca054dcae 'Authentication helper methods ... removed'
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/001-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/002-bundle.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/003-boot.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/004-database.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/005-eager.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/006-routes.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/007-tests.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/008-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/001-bundle.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/002-boot.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/003-database.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/004-eager.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/005-routes.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/006-tests.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/007-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/008-probe.json

Validation data: user '00123', password 'sample: value # keep' (contains ':' and '#'); nil/nil credentials.
- Without repair: v2_12_2_fixed probe auth_header_exact -> "Faraday::Error: :basic_auth is not registered on Faraday::Request".
- With repair: auth_header_exact == [['10.1/a', 'Basic [REDACTED]']] and auth_header_nil_credentials == 'Basic Og==' on v2_12_2_jsonpin and baseline_compat.
- Unchanged control: baseline probe returns the same header values (runs/baseline/007-probe.*).

### F4. Newer json (>= 2.17) rejects invalid escapes in provider responses

Affected code: app/models/citation/provider.rb metadata_from (JSON.parse(body)).

Applies when: Applies only if json resolves to 2.17 or later (for example, with a pin looser than ~> 2.7.2) and the provider returns a body with an invalid escape such as \q.

For body {"title":"T\q",...}, baseline returns title 'Tq'. With json 2.21.2 the same lookup raises Citation::Provider::Error "The provider's response was not valid JSON", and the citation is marked failed.

Recommendation: Use the json ~> 2.7.2 pin from F1. Adopt strict parsing later as a separate, deliberate json upgrade.

Other paths: Valid bodies and duplicate keys ('Second', last wins) parse the same on all variants.

Current-version preparation: The pin keeps 2.7.x behavior. Probe on v2_12_2_jsonpin returned 'Tq', the same as baseline.

Rollout and rollback: Same as F1.

Evidence (executed): Observed values: baseline Tq; v2_12_2_repaired raised Citation::Provider::Error; v2_12_2_jsonpin Tq.
- Source: dependencies-v2_12_2_repaired json 2.17 changelog ce44119b7ec9
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/007-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/008-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/007-probe.json

Validation data: Provider body '{"title":"T\\q","url":"https://example.org/t"}'.
- Without repair: v2_12_2_repaired (json 2.21.2) json_invalid_escape_title -> "Citation::Provider::Error: The provider's response was not valid JSON".
- With repair: v2_12_2_jsonpin (json 2.7.6) json_invalid_escape_title -> 'Tq'. The probe's expected literal was 'T\q', so it is labeled FAIL on both baseline and pinned variants; compare values, not the label.
- Unchanged control: baseline -> 'Tq'; json_duplicate_key_title 'Second' everywhere.

## Rollout

### F5. faraday-retry 2.x waits for RateLimit-Reset on a retried 503

Affected code: app/models/citation/provider.rb:37; app/jobs/citation_enrichment_job.rb.

Applies when: Applies only if the production citation provider sends a RateLimit-Reset header with a 503. Whether it does is unknown.

On 503 with 'RateLimit-Reset: 3', baseline retries immediately (elapsed 0.0s), and 2.x sleeps 3.0s before retrying. faraday-retry's default max_interval is effectively unbounded, so a large reset value blocks a Sidekiq thread for that long. Retry-After was already honored on both (3.0s).

Recommendation: No change needed if the provider does not send the header. Otherwise add `max_interval: 5` to the retry options. With that bound, a longer header value skips the in-request retry, so the 503 becomes Unavailable and the job's retry_on handles it.

Other paths: Retry-After behavior is unchanged (3.0s on both).

Current-version preparation: max_interval is accepted by faraday-retry 1.0.4 and 2.x. This was not executed (proposed).

Rollout and rollback: Check production provider response headers for 503s before the deploy.

Evidence (executed): probe_ratelimit.rb
- Source: faraday-retry 2.0 changelog 9cb59833a88a (RateLimit-Reset support)
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/008-probe.json
- Run: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/009-probe.json

Validation data: Loopback server: 503 with header 'RateLimit-Reset: 3' or 'Retry-After: 3', then 200.
- Without repair: v2_12_2_jsonpin: RateLimit-Reset elapsed=3.0 HONORED_HEADER_DELAY.
- With repair: Proposed: with max_interval: 5 and RateLimit-Reset: 60, lookup raises Unavailable after 1 request with no 60s wait. Not executed.
- Unchanged control: baseline: RateLimit-Reset elapsed=0.0; Retry-After elapsed=3.0 on both.

## Experiments

- baseline / bundle: passed, exit 0, 0.29s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/001-bundle.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/001-bundle.log.
- baseline / boot: passed, exit 0, 3.56s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/002-boot.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/002-boot.log.
- baseline / database: passed, exit 0, 1.3s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/003-database.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/003-database.log.
- baseline / eager: passed, exit 0, 1.46s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/004-eager.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/004-eager.log.
- baseline / routes: passed, exit 0, 0.73s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/005-routes.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/005-routes.log.
- baseline / tests: passed, exit 0, 5.75s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/006-tests.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline/006-tests.log.
- v2_12_2 / boot: failed or timed out, exit 1, 1.72s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2/003-boot.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2/003-boot.log.
- v2_12_2_fixed / probe: passed, exit 0, 12.4s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/001-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/001-probe.log.
- v2_12_2_fixed / bundle: passed, exit 0, 0.22s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/002-bundle.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/002-bundle.log.
- v2_12_2_fixed / boot: passed, exit 0, 2.12s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/003-boot.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/003-boot.log.
- v2_12_2_fixed / database: passed, exit 0, 1.25s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/004-database.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/004-database.log.
- v2_12_2_fixed / eager: passed, exit 0, 1.31s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/005-eager.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/005-eager.log.
- v2_12_2_fixed / routes: passed, exit 0, 0.74s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/006-routes.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/006-routes.log.
- v2_12_2_fixed / tests: failed or timed out, exit 1, 5.59s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/007-tests.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/007-tests.log.
- v2_12_2_fixed / probe: passed, exit 0, 1.15s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/008-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_fixed/008-probe.log.
- v2_12_2_repaired / bundle: passed, exit 0, 0.22s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/001-bundle.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/001-bundle.log.
- v2_12_2_repaired / boot: passed, exit 0, 2.08s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/002-boot.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/002-boot.log.
- v2_12_2_repaired / database: passed, exit 0, 1.17s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/003-database.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/003-database.log.
- v2_12_2_repaired / eager: passed, exit 0, 1.23s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/004-eager.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/004-eager.log.
- v2_12_2_repaired / routes: passed, exit 0, 0.71s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/005-routes.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/005-routes.log.
- v2_12_2_repaired / tests: passed, exit 0, 5.59s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/006-tests.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/006-tests.log.
- v2_12_2_repaired / probe: passed, exit 0, 12.24s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/007-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_repaired/007-probe.log.
- v2_12_2_jsonpin / probe: passed, exit 0, 6.0s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/001-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/001-probe.log.
- v2_12_2_jsonpin / bundle: passed, exit 0, 0.24s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/002-bundle.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/002-bundle.log.
- v2_12_2_jsonpin / boot: passed, exit 0, 2.21s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/003-boot.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/003-boot.log.
- v2_12_2_jsonpin / database: passed, exit 0, 1.34s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/004-database.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/004-database.log.
- v2_12_2_jsonpin / eager: passed, exit 0, 1.36s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/005-eager.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/005-eager.log.
- v2_12_2_jsonpin / routes: passed, exit 0, 0.76s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/006-routes.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/006-routes.log.
- v2_12_2_jsonpin / tests: passed, exit 0, 6.38s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/007-tests.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/007-tests.log.
- v2_12_2_jsonpin / probe: passed, exit 0, 12.21s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/008-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/008-probe.log.
- v2_12_2_jsonpin / probe: passed, exit 0, 6.89s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/009-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/v2_12_2_jsonpin/009-probe.log.
- baseline_compat / bundle: passed, exit 0, 0.21s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/001-bundle.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/001-bundle.log.
- baseline_compat / boot: passed, exit 0, 2.04s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/002-boot.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/002-boot.log.
- baseline_compat / database: passed, exit 0, 1.28s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/003-database.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/003-database.log.
- baseline_compat / eager: passed, exit 0, 1.3s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/004-eager.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/004-eager.log.
- baseline_compat / routes: passed, exit 0, 0.77s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/005-routes.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/005-routes.log.
- baseline_compat / tests: passed, exit 0, 5.72s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/006-tests.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/006-tests.log.
- baseline_compat / probe: passed, exit 0, 12.23s. Record: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/007-probe.json. Log: /tmp/gem-upgrade-20261014-71515-bvy478/runs/baseline_compat/007-probe.log.

## Source coverage

- not_applicable: 27 source pages.
- reviewed: 146 source pages.
- unknown: 67 source pages.

Full source dispositions and finding references: /tmp/gem-upgrade-20261014-71515-bvy478/plan.json.

## Limits and unresolved checks

- faraday release ancestry: Current tag is not an ancestor of target; review endpoint diff as well as target-only commits
- faraday-net_http release ancestry: Current tag is not an ancestor of target; review endpoint diff as well as target-only commits
- faraday-retry release ancestry: Current tag is not an ancestor of target; review endpoint diff as well as target-only commits
- uri release ancestry: Current tag is not an ancestor of target; review endpoint diff as well as target-only commits
- faraday-net_http 1.0.2 to 3.4.4: all commits: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- faraday-retry 1.0.4 to 2.4.0: all commits: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: CHANGES.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: .github: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: root: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: Rakefile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: lib: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: ext: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: Gemfile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: tests: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: benchmark: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: BSDL: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: COPYING: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: json-java.gemspec: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: test: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: .gitignore: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: README.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: json.gemspec: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: .gitattributes: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: java: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: LEGAL: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: README-json-jruby.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 2.21.2: .all_images.yml: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: README.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: lib: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: root: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: test: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: BSDL: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: .github: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: net-http.gemspec: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: .document: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: Gemfile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: sig: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- net-http 0.4.1 to 0.10.0: test_sig: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: .github: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: root: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: lib: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: BSDL: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: test: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: uri.gemspec: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: Rakefile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: README.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: .document: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: Gemfile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- uri 0.13.1 to 1.1.2: .rdoc_options: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: CHANGES.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: .github: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: root: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: Rakefile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: lib: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: ext: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: Gemfile: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: tests: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: benchmark: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: BSDL: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: COPYING: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: json-java.gemspec: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: test: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: .gitignore: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: README.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: json.gemspec: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: .gitattributes: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: java: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: LEGAL: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: README-json-jruby.md: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: .all_images.yml: Dependency commit patches were not read individually. Only changelogs and probes cover this range.
- json 2.7.2 to 3.1.0: tools: Dependency commit patches were not read individually. Only changelogs and probes cover this range.

---

**My notes:** I only made the plan above. I didn't change the Gemfile or any code, and the repo is still clean. Changing just the faraday version would break the app. It needs four changes together:

- **Gemfile:** set faraday to 2.12.2, and add `faraday-retry ~> 2.2` and `json ~> 2.7.2`.
- **`app/models/citation/provider.rb:38`:** replace the `:basic_auth` line with the `:authorization` line shown in F3.

With those four changes, all 46 tests passed in a copy of the app. System tests didn't run because they need Chrome.

Before deploying, check whether the production citation provider sends a `RateLimit-Reset` header with 503 responses (F5). If it does, retries will now wait for the time in that header.

If you'd like, I can apply these changes to the repo next.