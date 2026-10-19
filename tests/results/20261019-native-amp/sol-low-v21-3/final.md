[Read the upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

**The dependency update resolves, but the upgrade has significant behavioral risks—even while retaining Rails 7.0 defaults.**

The most important findings:
- **High:** failed CSV imports can commit earlier rows instead of rolling back the entire batch.
- **High:** digest jobs preserve readers’ time zones, changing the selected day while deduplication remains UTC-based.
- **High:** new BigDecimal job payloads cannot safely be consumed by old Rails workers.
- **High:** DST reminder displays and expired-export cache retention change silently.
- **Medium:** citation enrichment uses the removed `Rails.application.secrets` API.
- **Medium:** Rails’ built-in Sidekiq adapter is deprecated for removal in 8.2.

The report also covers mechanical API fixes, rich-text attachment/editor risks, resolved dependency changes, and changes **not enabled** by this application’s retained defaults. Each finding distinguishes upstream history, inspected code, and inferred consequences.

No application files were changed, no gems were installed, and the application was not booted or tested. The report is a local review artifact, not a committed upgrade.