**Overall risk: high.** Dependency resolution succeeds, but this is not a safe version-only upgrade.

[Read the full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md), including application assumptions, before/after behavior, risk ratings, code citations, and upstream sources.

The most consequential findings:
- **Imports can partially commit** while reporting validation failure.
- **Receipt DOIs and preview annotations can silently disappear.**
- **Digest jobs change their calendar-day interpretation**, and new decimal payloads cannot be consumed by Rails 7.0 workers.
- **Rich-text parsing, plaintext exports, reminder previews, and cache-expiry behavior change.**
- Several mechanical failures require fixes, including the rich-text initializer, enum declarations, serialization arguments, and reminder scheduling.

Keeping Rails 7.0 defaults avoids several other apparent regressions; the report distinguishes those from unavoidable changes.

The [resolved dependency diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-lockfile.diff) keeps Sidekiq, Redis, Puma, and Rack unchanged, but adds dependencies including **JSON 3.1.0**, with stricter parsing.

**Assessment only:** nothing was installed or upgraded, the application was not run, and application files remain unchanged. Findings are source-based predictions, not executed test results.