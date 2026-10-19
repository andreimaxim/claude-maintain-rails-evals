**Rails 8.1.0 needs application changes—not just a dependency update.** The full [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md) covers required fixes, optional defaults, validation cases, and rollout/rollback.

Key findings:
- **Compatibility blockers:** Action Text initialization, enum and serialization APIs, secrets access, retry scheduling, routes, and the search form.
- **Behavior risks:** partial CSV imports committing, missing receipt DOIs/preview annotations, Markdown export failure, and changed reminder representation across DST.
- **Queue risks:** digest timezone and BigDecimal serialization change across versions. Older workers may not understand newly emitted payloads.
- **Optional defaults:** readonly slug assignment, YAML preferences, PostgreSQL date decoding, and expired-export caching require separate attention.

**Recommended sequence:** compatible preparations on 7.0 → validate each intermediate minor → reach 8.1.0 retaining 7.0 defaults → adopt new defaults separately. Ruby 3.3.6 meets the target requirement; replacing Sidekiq or Sprockets is not automatically required.

This was a **source-based assessment**, not an executed upgrade. No application files were changed, no services were exercised, and no dependency-resolution or test success is claimed.