**The upgrade is feasible, but not safe as a direct version bump.** Ruby 3.3.6 already meets the requirement.

[Read the application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-plan/plan.md), including affected code, versioned upstream references, preparatory compatibility, validation, and rollback constraints.

The highest-risk findings are:
- Failed CSV imports can commit earlier rows instead of rolling back.
- Digest jobs can change calendar day; new BigDecimal payloads cannot be read by Rails 7.0 workers.
- Removed APIs break initialization, routes, serialization, reminders, exports, and citation settings.
- Newly resolved JSON 3 breaks Rails 8.1.0’s parser calls.
- Adopting newer defaults introduces separate date-parsing, read-only slug, cache-expiry, and signed-message compatibility issues.

**Recommended sequence:** prepare portable fixes on 7.0, progress through 7.1 → 7.2 → 8.0 → 8.1 with old defaults retained, then adopt defaults separately.

**Executed:** the isolated baseline passed 46 tests and 325 assertions. Raw 8.1 fails to boot; focused experiments confirmed the data and rollout hazards. Commands, lockfiles, configuration, and logs are retained with the plan.

The application remains unchanged. This delivers the assessment—not an implemented or deployment-ready upgrade.