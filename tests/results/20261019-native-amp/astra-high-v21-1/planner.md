[Read the full Rails 7.0.8.7 → 8.1.0 risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

**Dependency resolution succeeds, but this is not a safe dependency-only upgrade.** The assessment assumes `config.load_defaults 7.0` remains unchanged.

The highest-priority findings are:
- Failed CSV imports can **commit partial data** instead of rolling back.
- Receipt downloads can silently lose DOIs, and preview annotations can disappear.
- Digest jobs can select a different calendar day; new BigDecimal job payloads cannot be read by Rails 7.0 workers.
- Reminder previews, expired-fragment caching, and attachment filenames change behavior.

Medium risks include removed `Rails.application.secrets`, the Sidekiq adapter’s impending removal, and stricter JSON parsing. Mechanical incompatibilities also affect initialization, enums, serialization, routes, exports, and reminder scheduling.

The report includes before/after explanations, application file-and-line citations, upstream sources, transitive dependency changes, and exclusions. Unconfirmed risks are explicitly marked. Rack remains **2.2.24** and Sidekiq remains **6.5.12**.

No application files were changed, target gems installed, or application/tests run. Only static review and dependency resolution in a temporary copy were performed.