**This is a high-risk upgrade, not a version-only bump.** The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) includes application assumptions, before/after behavior, file-and-line citations, upstream evidence, mechanical fixes, and excluded changes.

The most important findings are:

- **CSV atomicity:** an invalid later row can leave the import and earlier rows committed despite reporting failure.
- **Digest compatibility:** new BigDecimal job payloads cannot be read by old workers; preserved time zones also change which day’s notes digests select.
- **Silent output changes:** preview annotations disappear, receipt DOIs become blank, and rich-text parsing/plaintext exports change.
- **Dependency blocker:** today’s resolution selects JSON 3.1.0, whose API conflicts with Rails 8.1.0’s decoder and column coder.

The report also covers removed `Rails.application.secrets` and the Sidekiq adapter’s next-release removal.

Dependency resolution succeeded in a temporary copy; the [lockfile delta](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lock.diff) is retained as evidence. These are source-based findings, not runtime reproductions.

**No application files were changed, no target gems were installed, and neither the application nor its tests were run.**