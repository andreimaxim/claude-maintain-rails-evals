**Rails 8.1.0 needs staged preparation, not just a Gemfile change.** The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/plan.md) includes required fixes, optional defaults, rollout/rollback steps, versioned upstream references, and retained experiment evidence.

Highest-risk findings:
- **Failed CSV imports partially commit on 8.1.** Fix transaction rollback before upgrading.
- **Rails 7.0 workers cannot deserialize new BigDecimal job payloads.** Prepare compatible digest arguments before mixing versions.
- **Digest dates change near local midnight.** Explicit UTC normalization preserves the app’s documented behavior.
- Removed APIs affect boot, note declarations, provider settings, forms, routes, reminders, retries, and exports.
- Fresh resolution selected **JSON 3.1.0**, incompatible with this exact Rails patch; a separately tested JSON 2.x constraint is documented.

**Executed:** all 46 baseline non-browser tests passed in isolation. The unchanged target failed boot; diagnostic patches exposed the additional failures above. A fully repaired target and production rollout remain unverified.

No tracked application files changed. Disposable databases, Redis, copies, and gem installations were removed; the report and evidence remain as local review artifacts.