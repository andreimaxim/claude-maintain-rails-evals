**Rails 8.1.0 is feasible, but not as a gem-only upgrade.** Ruby 3.3.6 is compatible, and dependency resolution succeeded with the existing Sidekiq, Redis, Rack, and Puma versions.

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-upgrade-plan.md) covers affected code, versioned upstream sources, preparatory compatibility, discriminating checks, and rollout/rollback risks.

Key findings:
- Model declarations, the Action Text initializer, citation configuration/retries, reminder scheduling, and Markdown exports need compatibility changes.
- Failed CSV imports risk committing earlier rows; receipts and preview annotations also have changed behavior.
- Digest serialization changes both the content day near midnight and decimal payload compatibility with old workers.
- PostgreSQL date decoding, cache validation, and other new defaults should be adopted separately.

**Verified:** isolated dependency resolution and contrasting framework probes on both exact Rails versions. **Still proposed:** application tests, PostgreSQL transaction checks, browser checks, and cross-version queue/token validation.

No application files were changed or upgrade implemented. Commands, lockfiles, configuration, and logs are retained with the plan.