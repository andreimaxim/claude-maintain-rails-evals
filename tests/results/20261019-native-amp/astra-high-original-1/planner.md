**Rails 8.1.0 is feasible, but this application needs compatibility changes before deployment.**

The [full application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0-to-8.1-plan.md) includes affected code, versioned upstream evidence, current-version-compatible preparation, discriminating validations, and rollout/rollback controls.

Key findings:
- Required fixes include Action Text initialization, model declarations, provider secrets, routes, import rollback, exports, and reminder scheduling.
- New job serialization changes digest-day behavior and produces BigDecimal payloads that Rails 7.0 workers cannot read.
- Default adoption needs separate checks for YAML preferences, readonly slugs, PostgreSQL dates, cache expiry, HTTP validators, and signed attachment formats.
- Dependency resolution accepts the existing Ruby, Sidekiq, Redis, Puma, and Rack pins. However, it selects **JSON 3.1.0, which breaks Rails 8.1.0’s decoder**. A separate `json < 3` variant resolved to 2.21.2 and passed the decoder/message probes.

Recommended sequence: ship compatible preparation on 7.0, progress through intermediate Rails versions with existing defaults, then adopt new defaults individually.

[Reproducible experiment evidence](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade-evidence/README.md) is retained. Dependency resolution and isolated framework probes ran; application boot, database tests, browser workflows, and live workers remain proposed checks.

**No working application files were changed, committed, or deployed.**