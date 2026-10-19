**Rails 8.1.0 resolves successfully, but this is not a safe version-only upgrade.**

The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) includes application assumptions, before/after behavior, file-and-line citations, upstream evidence, and risk ratings.

The highest-priority findings are:
- **Partial imports:** returning from a transaction can commit earlier rows instead of rolling them back.
- **Digest semantics:** queued timestamps retain the reader’s zone, changing which day’s notes are emailed.
- **Rolling deployments:** new BigDecimal job payloads cannot be deserialized by Rails 7.0 workers.
- **JSON compatibility:** the resolved JSON 3.1.0 rejects an option passed by Rails 8.1.0’s persisted-tags coder.

Other findings cover missing preview annotations, blank DOI receipts, DST displays, cache expiration, and rich-text output changes.

Importantly, **Rack remains 2.2.24**; this resolution does not force a Sidekiq or Rack 3 migration. See the [dependency diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

The report is saved locally. No application files were changed, no upgraded gems were installed, and the application/tests were not run.