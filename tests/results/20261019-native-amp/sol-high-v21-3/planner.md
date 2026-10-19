[Read the Rails 7.0.8.7 → 8.1.0 risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0.md).

**This is not a drop-in upgrade.** The report identifies 9 high-risk and 3 medium-risk changes, with application line references, upstream evidence, mechanical fixes and exclusions.

The main concerns are:
- Imports can commit partial data while reporting failure.
- Digests change from UTC-day to reader-local-day contents.
- New BigDecimal job payloads are incompatible with Rails 7.0 workers.
- Today’s resolution selects JSON 3.1.0, which conflicts with Rails 8.1.0’s decoder.
- Removed `secrets` access requires a configuration-source decision.

Dependency resolution succeeded without forcing Rack 3 or Sidekiq 7. The [lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0.lockfile.diff) is retained.

This was a source-only assessment: no upgraded gems were installed, no application or tests were run, and application files remain unchanged.