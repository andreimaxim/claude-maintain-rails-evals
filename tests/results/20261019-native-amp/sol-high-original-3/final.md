**Rails 8.1.0 is feasible, but this app needs compatibility changes—not just a version bump.**

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/PLAN.md) covers affected code, versioned upstream sources, current-version-compatible preparations, validation, rollout, and rollback.

Key findings:
- Imports can **partially commit invalid CSVs** after transaction semantics change.
- Digest serialization changes the selected day near midnight; new BigDecimal job payloads **cannot be read by Rails 7.0 workers**.
- The resolved JSON 3 dependency breaks Rails 8.1.0 cookie decoding; an explicit compatible constraint is needed.
- New defaults introduce separate failures involving notebook preferences, readonly slugs, activity-report dates, and cache expiration. New attachment signatures also create rollback risk.

**Isolated checks:** baseline passed 46 tests; a compatibility-repaired 8.1 copy passed 46 tests with one documented DST expectation adjustment. Enabling 8.1 defaults still produced three errors after fixing its initial serialization blocker. Browser and separate-worker rollout checks remain proposed.

[Experiment commands, dependencies, configurations, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/EXPERIMENTS.md) are retained. Disposable services/checkouts were removed. **The working application remains unchanged; no upgrade was committed or deployed.**