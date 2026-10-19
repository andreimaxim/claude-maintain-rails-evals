**Rails 8.1.0 is feasible, but this app needs a staged compatibility upgrade—not just a version bump.** Ruby 3.3.6 already meets the requirement.

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7-to-8.1-plan.md) covers affected code, current-version-compatible preparations, discriminating validation, and rollout/rollback handling.

Key findings:
- Removed APIs affect enums, serialized tags, highlight aliases, provider secrets, and citation retries.
- Changed transaction behavior could leave a failed CSV import partially saved.
- Digest serialization changes can shift the content day and produce payloads old workers cannot read.
- Action Text allowlist initialization, CSV annotations, and DOI receipts need compatibility changes.
- New defaults introduce separate risks around decoded PostgreSQL dates, read-only slugs, expired cache fragments, and HTTP validators.

**Recommendation:** upgrade through 7.1 → 7.2 → 8.0 → 8.1, retaining Rails 7.0 defaults initially. Keep Sidekiq and other infrastructure stable unless isolated dependency resolution proves a change necessary.

This assessment compares application code with versioned upstream guidance and exact-tag sources. **No application files were changed, and no runtime experiments or tests were run.** Dependency resolution and isolated rehearsal remain required before deployment.