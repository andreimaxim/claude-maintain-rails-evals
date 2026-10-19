**Do not deploy this as a gem-only bump.** Use a staged 7.1 → 7.2 → 8.0 → 8.1.0 upgrade, retaining Rails 7.0 defaults initially.

The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-audit/PLAN.md) separates required fixes, optional defaults, current-version-safe preparation, validation, and rollback risks.

Key findings:
- **Boot/API blockers:** Action Text allowlist initialization, model declarations, secrets access, routing, reminder scheduling, and retry configuration.
- **Behavior/data risks:** partial imports, missing receipt DOIs and preview annotations, failed exports, changed digest dates, and DST preview differences.
- **Rollback hazard:** Rails 7.0 cannot deserialize new BigDecimal job payloads. UTC timestamps plus decimal strings worked in both directions.
- **Dependency issue:** the resolver selected JSON 3.1, which breaks Rails 8.1.0 decoding. A separate JSON `< 3` experiment confirmed the workaround.

**Executed:** the isolated baseline passed **46 tests / 325 assertions**. Target dependency resolution succeeded, but unchanged target boot failed; no upgraded-app test pass is claimed.

[Commands, lockfiles, logs, and probe evidence](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-audit/COMMANDS.md) are retained. Disposable databases, Redis, and checkouts were cleaned up. **The working application remains unchanged; the upgrade is not implemented.**