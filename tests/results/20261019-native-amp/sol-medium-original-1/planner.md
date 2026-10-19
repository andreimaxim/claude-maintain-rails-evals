**Rails 8.1.0 is achievable, but this app needs compatibility changes—not just a version bump.**

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0-to-8.1-plan.md) identifies affected code, required fixes, current-version compatibility, discriminating validation, and rollout/rollback risks.

Key findings:
- **Boot/API failures:** Action Text allowlist initialization, enum/serialization declarations, routes, and search forms.
- **Workflow failures:** exports, reminder scheduling, citation configuration/retries, and potentially partial CSV imports.
- **Silent behavior changes:** missing import annotations, custom-primary-key receipt values, digest dates, and DST previews.
- **Rollback incompatibility:** Rails 7.0 cannot read Rails 8.1’s typed `BigDecimal` job payloads. Preparing explicit decimal-string arguments avoids introducing that incompatibility.

**Recommendation:** upgrade through 7.1 → 7.2 → 8.0 → 8.1 while retaining Rails 7.0 defaults; adopt newer defaults separately. Ruby 3.3.6 already qualifies, and dependency resolution does **not** require upgrading Sidekiq or Rack.

Isolated framework probes confirmed several failures and payload differences; evidence and lockfiles accompany the plan. Full application, database, browser, and worker checks remain proposed—not claimed passing.

The working application is unchanged. No upgrade, commit, or deployment was performed.