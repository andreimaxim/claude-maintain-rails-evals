**Upgrade in stages, retaining Rails 7.0 defaults initially.** This is not a safe Gemfile-only bump.

The [full application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/PLAN.md) covers affected code, versioned upstream sources, current-version-compatible preparation, rollout/rollback, and discriminating validation.

Most consequential findings:
- **Import data integrity:** Rails 7.2+ can commit earlier rows when `Import#apply` returns after a later row fails.
- **Digest semantics:** newer job serialization preserves the reader’s time zone, changing this app’s promised UTC-day selection.
- **Rollback compatibility:** new BigDecimal job payloads cannot be read by Rails 7.0 workers. Enqueuing decimal strings works on both versions.
- **Exact-target dependency failure:** Rails 8.1.0 needs **JSON <3** with the currently resolved dependencies.
- Required API changes affect Action Text initialization, tags/highlights, routing, forms, citations, exports, and reminder scheduling.

**Executed in isolated disposable copies:** the baseline passed 46 tests; the adjusted target passed all 46 with 7.0 defaults retained. Enabling 8.1 defaults exposed three additional errors involving readonly slugs, PostgreSQL dates, and cache expiration. Real Redis JSON probes verified the proposed digest preparation on both versions.

[Commands, configurations, lockfiles, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/COMMANDS.md) are retained. Production, browser/editor, and stored-attachment rollout checks remain proposed.

The working application is unchanged. Temporary services and copies were removed; no upgrade was committed or deployed.