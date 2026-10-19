**Rails 8.1.0 is feasible, but this app needs a staged compatibility upgrade—not just a version bump.** Ruby 3.3.6 already meets its requirement.

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7-to-8.1-upgrade-plan.md) covers required fixes, optional defaults, rollout/rollback, and discriminating validation.

Key findings:
- **Boot/API failures:** Action Text allowlist initialization, Note declarations, provider secrets access, and citation retry configuration.
- **Data integrity:** CSV imports can partially commit because transaction behavior on `return` changed.
- **Silent regressions:** DOI receipts, preview annotations, digest calendar days, and DST reminder previews.
- **Rollout risks:** BigDecimal job payloads, signed attachment references, cache/message formats, and long-scheduled reminders.

Keep `load_defaults 7.0` initially, but note that it does **not** prevent all these changes. The plan identifies which preparations work on Rails 7.0 and which must wait for 7.1.

**Delivery state:** assessment only; no application changes or runtime experiments were performed. Findings are based on application code and tagged upstream source. Dependency resolution and isolated execution remain proposed checks—not verified results.