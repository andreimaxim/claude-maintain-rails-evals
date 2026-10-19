**Overall risk: high.** The upgrade resolves, but several changes affect this application’s data and background-job behavior.

[Read the full upgrade-risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md), with application line references, upstream sources, before/after behavior, and risk ratings.

The most important findings:
- Failed CSV imports can **commit partial batches** instead of rolling back.
- Digest jobs retain the reader’s time zone, changing their content day while deduplication still uses UTC.
- New BigDecimal job payloads are incompatible with Rails 7.0 workers during rolling deployments or rollback.
- Import previews can silently lose annotations, and CSV receipts can lose DOI values.
- Removed APIs also block model loading, route drawing, reminder scheduling, and citation-provider configuration.

The report distinguishes immediate changes from those requiring newer framework defaults. Notably, **Rack stays at 2.2.24** under the current Sidekiq pin.

The [resolved lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-lockfile.diff) is included for review. No application files were changed, no new gems were installed, and the application was not run.