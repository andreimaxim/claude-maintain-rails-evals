**Rails 8.1.0 is feasible, but this app is not ready for a Gemfile-only upgrade.**

The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-plan.md) covers affected code, preparatory changes, version-specific fixes, validation, and rollout/rollback handling.

Highest-priority findings:
- **Partial CSV imports:** Rails 8.1 can return failure while committing the first valid row. Explicit rollback is required.
- **Digest behavior and queued payloads:** new serialization changes the digest’s UTC-day semantics; Rails 7.0 cannot deserialize new BigDecimal arguments.
- **Boot and API failures:** Action Text initialization, serialization declarations, enum syntax, provider secrets, scheduling, routes, and other usages need adaptation.
- **Dependency resolution:** existing Sidekiq/Puma pins can remain initially, but the resolved JSON 3.1.0 is incompatible with exact Rails 8.1.0.

Recommended sequence: make current-version-compatible preparations, upgrade through **7.1 → 7.2 → 8.0 → 8.1**, initially retain 7.0 defaults, then adopt newer defaults separately.

**Executed checks:** the isolated baseline passed **46 tests / 325 assertions**. The unchanged target failed boot; a partially adapted probe still had **19 failures and 6 errors**. Standalone probes confirmed the import and queue-compatibility risks.

[Commands, dependency locks, configuration, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/README.md) are retained. The working application was not changed; no upgrade was committed or deployed.