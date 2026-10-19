**Rails 8.1.0 is feasible, but this is not a Gemfile-only upgrade.** The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0-to-8.1-upgrade-plan.md) covers required changes, optional defaults, validation, and rollout/rollback sequencing.

Key confirmed risks:
- Failed CSV imports can **partially commit**.
- Citation receipts lose DOIs; preview annotations disappear.
- Reminder scheduling fails, and digest dates change near midnight.
- Rails 7.0 workers **cannot deserialize newer BigDecimal job payloads**.
- Changing tags to `serialize :tags, coder: JSON` prematurely on Rails 7.0 silently writes YAML.

Recommended sequence: deploy current-compatible preparations, advance through Rails 7.1 → 7.2 → 8.0 → 8.1 while retaining 7.0 defaults, then adopt defaults separately. Sidekiq/Rack upgrades are **not mandatory** for resolving this target.

**Executed evidence:** the isolated baseline passed 46 tests. The target fails unchanged boot; a minimally adjusted diagnostic copy exposed further failures. Commands, dependency locks, configuration, and logs are retained in the [evidence directory](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/README.md).

The working application remains unchanged. Disposable services/databases were cleaned up; nothing was committed, pushed, or deployed.