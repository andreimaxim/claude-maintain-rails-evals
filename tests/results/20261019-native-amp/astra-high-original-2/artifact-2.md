# Rails upgrade assessment: reproducibility and evidence

See the [application-specific plan](../rails-8.1-upgrade-plan.md). This evidence was collected on 2026-10-19 from the original application revision recorded in `application-revision.txt`. The tested target is exactly Rails 8.1.0. No upgrade was applied to the working application.

## Isolation and runtime

- Checkouts were made using `git archive HEAD`, at `/home/user/workspace/repo/.amp/in/rails-8.1-review/{current,target}`. Private keys, original `tmp`, uploads, cache, and logs were not copied.
- Ruby 3.3.6 via `mise exec --`, Bundler 2.5.22, PostgreSQL 15.19. Dedicated Redis server 7.0.15 on loopback port 16381, persistence disabled, service `rails81-review-redis-d9b0`.
- Databases: `r81_review_current_d9b0` and `r81_review_target_d9b0`, local socket, role `user`. No production database or original application database was used.
- Rails environment `test`; old framework defaults (`load_defaults 7.0`) in both copies. Test mail delivery, copy-local Disk storage, null cache except explicitly process-local memory-cache tests/probes.
- `PARALLEL_WORKERS=1`. Test suite loads Sidekiq fake mode; Active Job uses the test adapter. Provider integration tests start their own local mock provider. The explicit Sidekiq smoke uses real isolated Redis but starts no worker.
- Overrides to date decoding, readonly attributes, cache expiration validation, and default YAML coder are made only in process by the named behavior probes. They do not imply all new defaults were enabled together.
- The original `configuration/{current,target}` snapshots retain Gemfiles, Ruby configuration, application/test configuration, Action Text initializer, and database/storage templates. The actual database and Redis overrides are listed below and in `isolation.txt`. No master key or environment secret dump is retained.

## Variant and output map

| Variant/check | Dependencies and application changes | Command/recipe | Primary output |
|---|---|---|---|
| Baseline | `current-Gemfile.lock`; original application; JSON 2.7.2 from Ruby default gems | `current-checks.sh` | `current-checks.log`: 46 runs, 325 assertions, green |
| Target dependency resolution | Rails version changed to 8.1.0 only, result `target-Gemfile.lock` including JSON 3.1.0 | `BUNDLE_PATH=../bundle mise exec -- bundle update rails` from target | `target-bundle-update.log` |
| Target unchanged boot | Above dependencies; no application compatibility edits | `target-checks.sh` | `target-unchanged-boot.log`: Action Text nil allowlist |
| Target boot/test-enabling variant | Above dependencies plus `target-boot-only.patch` | `target-suite.sh` | `target-boot-only-suite.log`: 46 runs, 11 assertions, 4 failures, 41 errors |
| JSON diagnostic | Same variant | One-off Rails runner probes; not a separate suite | `target-note-full-backtrace.log` locates JSON decoder; `target-find-by-backtrace.log` is an inconclusive nil lookup, not evidence of compatibility |
| Target JSON-compatible resolution | Add `gem "json", "< 3"`; `target-json-compatible-Gemfile.lock` resolves JSON 2.21.2; same boot patch | `BUNDLE_PATH=../bundle mise exec -- bundle update json` | `target-json-compatible-bundle.log` |
| Target JSON-compatible suite | Same JSON-compatible variant | `target-suite.sh` | `target-json-compatible-suite.log`: 46 runs, 174 assertions, 3 failures, 15 errors |
| Focused behavior probes | Original current vs JSON-compatible target | `behavior-probe.rb` in both, environment below | `current-behavior-probe-v2.log`, `target-behavior-probe-v2.log`; serialized `args-*.json` |
| Cross-version argument reads | Same two variants, no file changes | `cross-version-probe.rb`, target → current → target | `current-cross-version.log`, `target-cross-version-complete.log`; `portable-args-*.json` |
| Proposed compatible import body | Same variants, method replaced only within the probe process | `preparation-probe.rb` | `current-preparation.log`, `target-preparation.log` |
| Real adapter enqueue/readback | Same variants, adapter switched within probe only | `sidekiq-smoke.rb` | `current-sidekiq-smoke.log`, `target-sidekiq-smoke.log`, `sidekiq-envelope-*.json` |

`target-dependencies.patch` records the complete final Gemfile difference; the earlier target differs only by the Rails version change. `target-boot-only.patch` records all six scratch application/test changes. `current-resolved-gems.txt` and `target-json-compatible-resolved-gems.txt` capture resolved gem specifications; Ruby default gems not listed in those specifications are reported by the probe headers (notably baseline JSON 2.7.2).

The six target adjustments are nil-aware Action Text tags, separate list route declarations, positional enum declaration, keyword tag JSON coder, explicit highlight getter/setter, and symbolic exception configuration. This is **not** a completed upgrade patch. No assertion was removed to get a green result; the target never became green.

`behavior-probe-v1.rb`, `current-behavior-probe.log`, and `target-behavior-probe.log` preserve the first exploratory attempt. Its mock provider had a lexical constant/constructor mistake, and reconnecting an existing PostgreSQL adapter did not rebuild its date decoder map. Those mistakes were corrected in `behavior-probe.rb` (v2), which disconnects the pool for a fresh adapter. Use the **v2** logs for conclusions. `target-cross-version.log` is the first target pass before both portable payload files existed; `target-cross-version-complete.log` is the later full pass.

`current-application-test-cumulative.log` and `target-application-test-cumulative.log` are copies of each checkout's `log/test.log`, captured after all runs. **They span multiple invocations**, and the target log spans both JSON resolutions; they are supporting diagnostics, not isolated per-variant results. Prefer the primary stdout/stderr files above when attributing a result.

## Commands for reproducing the isolated checks

The original command notes are in `commands.txt`; `service-provenance.txt` retains the actual supervised Redis command and server versions. These are expanded recipes, not claims that a full shell transcript was captured. Run them only in newly created disposable checkouts with the isolated services below. Do not point them at ordinary development/test/production resources. For an exact rerun, replace `HEAD` below with the revision in `application-revision.txt`.

```sh
# From the source repository, into a disposable review directory (absolute $review):
mkdir -p "$review/current" "$review/target" "$review/evidence"
git archive HEAD | tar -x -C "$review/current"
git archive HEAD | tar -x -C "$review/target"
# Populate review/evidence with this evidence directory, or use absolute script paths.
# Change target Gemfile to rails 8.1.0; keep all other constraints initially.

createdb r81_review_current_d9b0
createdb r81_review_target_d9b0
# From $review, following the sandbox's supervised-service convention:
amp orb service start rails81-review-redis-d9b0 --command \
  "redis-server --bind 127.0.0.1 --port 16381 --save '' --appendonly no --dir $review"
```

From current:

```sh
export RAILS_ENV=test DATABASE_URL=postgresql:///r81_review_current_d9b0
export REDIS_URL=redis://127.0.0.1:16381/0 PARALLEL_WORKERS=1
export PROBE_OUTPUT="$review/evidence"
bash ../evidence/current-checks.sh
```

From target, with the Rails-only Gemfile change:

```sh
export RAILS_ENV=test DATABASE_URL=postgresql:///r81_review_target_d9b0
export REDIS_URL=redis://127.0.0.1:16381/1 PARALLEL_WORKERS=1
export PROBE_OUTPUT="$review/evidence" BUNDLE_PATH=../bundle
mise exec -- bundle update rails
bash ../evidence/target-checks.sh
# Apply target-boot-only.patch from the target root with patch -p1.
bash ../evidence/target-suite.sh
# Then add gem "json", "< 3" to scratch Gemfile, as in target-dependencies.patch:
mise exec -- bundle update json
bash ../evidence/target-suite.sh
```

To recreate exactly the historical resolution rather than resolve whatever gems are available later, restore the corresponding retained lockfile and use `bundle install` instead of `bundle update`. A different resolved dependency graph is a different experiment.

With each copy's isolated environment above:

```sh
mise exec -- bin/rails runner ../evidence/behavior-probe.rb
# After both behavior probes have emitted args-*.json, run this on target,
# then current, then target so all payloads are read in both directions:
mise exec -- bin/rails runner ../evidence/cross-version-probe.rb
mise exec -- bin/rails runner ../evidence/preparation-probe.rb
mise exec -- bin/rails runner ../evidence/sidekiq-smoke.rb
```

The probes print named JSON results or exceptions for comparison; they are exploratory checks, not a regression-test suite. Some counts depend on earlier synthetic records. The Sidekiq smoke checks and removes its exact synthetic job rather than clearing a queue. No mail or worker lifecycle is exercised by that smoke.

## Upstream source provenance

- Rails 8.1.0 archive: `https://codeload.github.com/rails/rails/tar.gz/refs/tags/v8.1.0`
- Downloaded archive SHA256: `e3f97438a5cc66a297effcf70bb05e7989f595ab975e9bc83535466d0abc3414` (also `upstream/archive-checksum.txt`). Selected exact files are retained in `upstream/rails-8.1.0`; the bulk archive/extraction was removed after review.
- Rails component changelogs in `upstream/{7.1.0,7.2.0,8.0.0}/<component>-CHANGELOG.md` came from `https://raw.githubusercontent.com/rails/rails/v<VERSION>/<component>/CHANGELOG.md`.
- Additional 7.2 source in `upstream/7.2.0/activejob` maps to `activejob/lib/active_job/` under that exact tag. `upstream/7.2.0/railties/configuration.rb` maps to `railties/lib/rails/application/configuration.rb`.
- `upstream/rails-7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb` is copied from the installed locked gem. Upstream equivalent: `https://github.com/rails/rails/blob/v7.0.8.7/activerecord/lib/active_record/attribute_methods/serialization.rb`.
- `upstream/json-3.1.0/lib/json/common.rb` is copied from the JSON 3.1.0 gem installed in the isolated target bundle. Its `parse` keyword signature is compared to Rails 8.1.0's retained decoder source, with an executed backtrace confirming applicability.
- `upstream-files.sha256` hashes every retained upstream source file. The report links versioned upstream sources at each finding rather than relying on unversioned current documentation.

## Boundaries and cleanup

Only the baseline suite is green. Full upgrade fixes, browser checks, production-style boot/assets, live worker replay, production data/backlog inspection, signatures/cookies interoperability and intermediate-version runtime checks remain unexecuted. The report separates source-based findings, executed checks and proposed validation.

See `cleanup.log` for disposal of the two review databases and dedicated Redis service. The scratch checkouts, bundle and bulk source downloads are removed after evidence preservation. The original application and its services are not upgraded or reconfigured. Artifacts are locally excluded by `/.amp/in/` in Git's repository-local exclude file; the pre-existing untracked `.amp/` plugin files are untouched.
