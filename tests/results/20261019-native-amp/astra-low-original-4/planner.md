**Rails 8.1.0 requires application changes—not just a dependency update.** The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0-to-8.1-plan.md) documents affected code, recommendations, current-version compatibility, discriminating validations, and rollout/rollback risks.

Highest-risk findings:
- CSV imports can partially commit after an invalid row.
- Digest serialization changes can select the wrong reporting day and introduce payloads unreadable by Rails 7.0 workers.
- Integer reminder scheduling and the old retry strategy need updates.
- Action Text initialization, model serialization, store-accessor aliases, exports, and route declarations need compatibility fixes.
- Adopting newer defaults adds separate risks for YAML preferences, readonly slugs, PostgreSQL dates, and cached export expiry.

**Recommended sequence:** compatible preparation on 7.0 → staged minor-version upgrades with old defaults retained → Rails 8.1.0 → deliberate defaults adoption.

This is a source-based assessment against versioned upstream code. No application changes or runtime experiments were performed; dependency resolution, isolated tests, and cross-version data/queue checks remain proposed.