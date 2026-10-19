**Rails 8.1.0 needs a staged compatibility migration, not just a Gemfile change.** The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md) covers affected code, current-version preparation, validation, and rollback.

Key findings:
- **Removed APIs:** Action Text’s allowlist initializer, model serialization/enum declarations, `Rails.application.secrets`, retry settings, and numeric reminder scheduling need changes.
- **Data integrity:** imports can partially commit after transaction-return behavior changes.
- **Queue compatibility:** new digest serialization changes UTC-day selection; tagged BigDecimal payloads cannot be read by Rails 7.0 workers.
- **Optional defaults:** readonly slug assignment, YAML preferences, PostgreSQL date decoding, cache expiry, and conditional downloads require separate preparation.

Recommended path: prepare compatible changes on 7.0, validate through 7.1 → 7.2 → 8.0 → 8.1.0 while retaining **7.0 defaults**, then adopt newer defaults individually.

This is a **source-based assessment** against tagged upstream code. No dependency resolution or runtime tests were run, and the working application and its services were left unchanged. The report identifies the isolated rehearsal checks still required before deployment.