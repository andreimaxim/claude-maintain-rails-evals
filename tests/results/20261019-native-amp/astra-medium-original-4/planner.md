**Rails 8.1.0 is dependency-resolvable, but this app needs compatibility changes before deployment.** The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-plan/plan.md) includes affected code, versioned upstream sources, preparation compatibility, validation cases, and rollout/rollback requirements.

Key findings:
- Removed APIs affect Action Text initialization, Note declarations, provider secrets, routing, scheduling, and retries.
- Import failures can leave **partially committed batches**; receipt DOI and annotation handling also need changes.
- Digest jobs change **time-zone semantics and decimal serialization**, creating mixed-version worker risks.
- New defaults separately affect YAML preferences, read-only slugs, PostgreSQL dates, cache expiry, and conditional downloads.
- Stored attachment signatures and queued reminders require explicit rollback testing; ordinary passing tests would not establish compatibility.

**Recommended sequence:** prepare compatible fixes on 7.0, upgrade through minor-version checkpoints while retaining 7.0 defaults, verify persisted data and cross-version jobs, then adopt defaults individually.

**Executed:** dependency resolution in a disposable checkout succeeded with the existing Sidekiq, Redis, and Puma pins. [Resolution evidence](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-plan/resolution.log) and exact lockfiles are retained beside the plan.

**Not executed:** Rails boot, application tests, migrations, workers, or browser checks. The working application is unchanged; nothing was committed or deployed.