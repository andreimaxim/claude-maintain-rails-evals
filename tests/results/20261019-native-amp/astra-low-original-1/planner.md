**This needs a staged migration, not a Gemfile-only upgrade.** The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md) includes affected code, exact-version upstream evidence, preparatory compatibility, validation scenarios, and rollout/rollback handling.

Key findings:
- **Data integrity:** failed CSV imports can partially commit because transaction exit behavior changed.
- **Background jobs:** reminder scheduling needs time objects; digest serialization changes timezone behavior and introduces payloads Rails 7.0 workers cannot deserialize.
- **Required API repairs:** Action Text allowlist initialization, enum/serialization declarations, highlight aliases, citation secrets/retries, route declarations, and string aggregation for exports.
- **Optional defaults:** separately evaluate YAML preferences, readonly slug assignment, PostgreSQL date decoding, cache/message formats, and HTTP freshness.
- **Frontend:** vendored Trix 1.3.5 requires explicit compatibility checks with the newer Action Text assets.

Ruby 3.3.6 meets the target requirement. A Sidekiq major upgrade is **not automatically required**: Rails 8.1.0 still permits Rack 2.

This is a **source-based assessment**; no dependency resolution or runtime tests were executed. Application files remain unchanged. Only the local review artifact and its ignore rule were written; nothing was committed or deployed.