**This needs a staged migration, not just a Rails version bump.** The application-specific plan is in the [upgrade assessment](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/plan.md), with versioned upstream source snapshots alongside it.

Key findings:
- **Boot/API blockers:** Action Text allowlist initialization, enum and serialization declarations, store-accessor aliasing, citation secrets, retry configuration, and test exception settings.
- **Behavior/data regressions:** Partial CSV imports could commit; receipt DOIs and preview annotations could disappear; Markdown exports could fail.
- **Queue compatibility:** New digest serialization can change the selected day and make new decimal payloads unreadable by old workers.
- **Separate defaults rollout:** Notebook YAML preferences, readonly slugs, PostgreSQL dates, sanitization, cache formats, and conditional downloads need targeted validation.

Ruby 3.3.6 meets Rails 8.1’s requirement. Sidekiq 6.5’s Rack pin is a resolution constraint—not a confirmed incompatibility.

The report gives affected code, current-version-compatible preparations, discriminating checks, and rollout/rollback sequencing. **No application files were changed or runtime tests run**; dependency resolution and all proposed checks remain outstanding.