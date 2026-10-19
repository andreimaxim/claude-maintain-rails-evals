[Read the upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-risk-report.md).

**Assessment: high-risk upgrade, even retaining Rails 7.0 defaults.** The report includes application assumptions, before/after behavior, code citations, upstream sources, mechanical fixes, and exclusions.

The most consequential findings:
- Failed CSV imports can **commit partial batches**.
- CSV receipts can silently lose DOI values, and previews can omit annotations.
- Digests can switch from UTC to reader-local date windows.
- BigDecimal job serialization creates **mixed-version worker incompatibility**.
- Removed APIs affect boot, reminders, exports, routing, and citation enrichment.

Temporary dependency resolution succeeded, retaining Rack 2.2 and Sidekiq 6.5. However, it selected **JSON 3.1**, whose API conflicts with Rails 8.1.0’s decoder—a resolver-accepted runtime blocker.

[Dependency delta](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff)

The application and its lockfile remain unchanged. No gems were installed, and no application code or tests were run. Findings are explicitly labeled as source evidence or inference.