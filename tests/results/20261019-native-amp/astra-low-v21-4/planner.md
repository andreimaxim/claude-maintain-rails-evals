[Read the upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

**This is not a safe version-only deployment.** The most consequential findings are:

- Failed imports can commit earlier rows instead of rolling back.
- Digest jobs change from UTC-day selection to the reader’s local day.
- New BigDecimal job payloads cannot be read by Rails 7.0 workers.
- Import-preview annotations and receipt DOIs can silently disappear.
- Several removed APIs require mechanical fixes before normal operation.

The report includes application citations, upstream sources, risk ratings, conditional defaults, and remaining uncertainties.

Dependency resolution succeeded in a temporary copy: **Sidekiq 6.5, Redis 4, and Rack 2 remain unchanged**, while JSON moves to 3.1.0. The [resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolved.Gemfile.lock) is included for review.

No application files were changed, no upgraded gems were installed, and the application was not run.