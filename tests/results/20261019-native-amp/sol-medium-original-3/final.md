[Read the application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/PLAN.md), including required changes, optional defaults, rollout/rollback steps, and validation evidence.

**Recommendation:** upgrade through Rails 7.1 → 7.2 → 8.0 → 8.1.0, initially retaining Rails 7.0 defaults.

Key findings:
- Required fixes affect Action Text initialization, routing, serialization, forms, filtering, exports, provider configuration, and job scheduling.
- Failed CSV imports can partially commit under the new transaction behavior.
- Digests silently change from UTC-day to reader-local-day content.
- Rails 7.0 workers cannot deserialize the new BigDecimal job payload—a mixed-version and rollback risk.
- The resolved JSON 3.1 dependency breaks Rails 8.1.0 session decoding; the tested candidate constrains JSON below 3.

**Executed checks:** the isolated baseline passed 46 tests. A disposable compatibility candidate passed all 46 tests, eager loading, and asset compilation. Browser compatibility, production-like execution, and rollout rehearsal remain unverified.

The working application is unchanged. Evidence and configuration snapshots are retained with the plan; disposable databases, Redis, and checkouts were cleaned up.