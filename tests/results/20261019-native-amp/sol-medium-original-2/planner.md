**Rails 8.1.0 is feasible, but not as a Gemfile-only upgrade.** The application-specific [upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-evaluation/PLAN.md) recommends staged upgrades while initially retaining Rails 7.0 defaults.

The highest-risk findings are:
- **Partial CSV imports:** a rejected batch can commit earlier rows under the newer transaction behavior.
- **Digest semantics:** preserved time zones can change which day’s notes are emailed.
- **Rollback incompatibility:** newly serialized BigDecimal job arguments cannot be read by Rails 7.0 workers.
- **Boot/API failures:** Action Text initialization, note declarations, routes, scheduling, provider configuration, and other application usages require changes.

Optional defaults—including YAML serialization, readonly attributes, PostgreSQL date decoding, sanitizers, and HTTP freshness—are assessed separately, with concrete validation and rollout recommendations.

**Executed evidence:** the isolated baseline passed 46 tests with 325 assertions. Rails 8.1 dependencies resolved with the existing Sidekiq, but the unchanged app failed to boot. An experimentally unblocked variant still had 3 failures and 15 errors; no passing upgrade is claimed.

[Commands, lockfiles, probes, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-evaluation/COMMANDS.md) are retained. Application files remain unchanged, and the disposable databases and Redis service have been removed. No upgrade was implemented or deployed.