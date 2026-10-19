**Rails 8.1.0 is feasible, but this application needs compatibility changes before deployment.** Ruby 3.3.6 already meets the requirement.

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md) covers affected code, versioned upstream evidence, current-version compatibility, discriminating validation, and rollout/rollback precautions.

Highest-priority findings:
- **Import integrity:** newer Rails can commit partially imported CSV batches when `Import#apply` returns early.
- **Queued digests:** changed BigDecimal serialization threatens old-worker compatibility; preserved time zones change the digest’s calendar day.
- **Removed APIs:** Action Text initialization, serializers, highlight aliases, routes, provider secrets, retry configuration, and numeric reminder scheduling need changes.
- **Optional defaults:** YAML preferences, readonly slugs, expired cache fragments, and PostgreSQL date decoding need preparation before changing `load_defaults`.

Recommended sequence: **7.0-compatible preparation → minor-version checkpoints → Rails 8.1.0 retaining 7.0 defaults → separately validated default adoption.** Sidekiq 6.5 is not a proven dependency blocker; its Rails adapter remains available but deprecated.

This was a source-based assessment, not an executed upgrade. Application files remain unchanged; dependency resolution, runtime tests, and mixed-version experiments remain proposed.