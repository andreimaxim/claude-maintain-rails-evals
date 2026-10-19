[Read the upgrade-risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

**This is not a drop-in upgrade.** The main risks are:
- Failed CSV imports can commit partial data.
- Digest jobs change date selection and introduce payloads old workers cannot deserialize.
- CSV receipts can silently lose DOI values.
- Cache expiry, exported text, filenames, and DST previews change.
- Removed APIs require fixes before boot and affected features will work.

Temporary dependency resolution succeeded. Rack, Sidekiq, Redis, and Puma remain at their current versions, but newly resolved JSON 3.1 introduces additional compatibility concerns.

The report includes application assumptions, file-and-line citations, upstream sources, risk ratings, and exclusions for changes not activated under retained Rails 7.0 defaults.

No application files were changed, no new gems installed, and no application or tests run.