[Read the upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

**This is a high-risk upgrade even with Rails 7.0 defaults retained.** The most consequential findings are:

- Failed CSV imports can commit earlier rows instead of rolling back.
- Digest jobs can select a reader-local day instead of UTC; new decimal payloads cannot be read by Rails 7.0 workers.
- CSV receipts can silently lose DOIs, and import previews can hide annotations.
- Rich-text parsing, DST previews, and negative cache-expiry behavior change.

The report includes application line references, upstream evidence, medium-risk decisions, mechanical fixes, and changes ruled out or gated behind newer defaults.

**Dependency resolution succeeded** in a temporary copy. Rack remains 2.2.24 and Sidekiq remains 6.5.12, but JSON 3.1.0 is newly selected. The [dependency diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lock.diff) is saved alongside the report.

No application files were changed, upgraded gems installed, or application/tests run. The report is a local review artifact; nothing was committed or pushed.