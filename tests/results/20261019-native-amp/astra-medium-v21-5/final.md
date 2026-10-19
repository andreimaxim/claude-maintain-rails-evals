**Overall risk: high. This is not safe as a version-only upgrade.**

The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) includes application assumptions, before/after behavior, risk ratings, affected file/line references, upstream evidence, and exclusions.

The most consequential findings are:

- Failed CSV imports can **commit partial batches**.
- Import previews can omit annotations, and CSV receipts can lose DOI values.
- Digests can silently switch from UTC-day to reader-local-day selection.
- New BigDecimal job payloads cannot be consumed by Rails 7.0 workers.
- Several used APIs are removed, including secrets access and older enum/serialization syntax.
- Dependency resolution succeeds but selects **JSON 3.1.0, whose parser signature conflicts with Rails 8.1.0’s decoder**.

The report distinguishes unconditional changes from newer defaults that this app does **not** enable. The [resolved lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff) is also available.

This was a source-only review. Nothing was installed or run, and the application and original lockfile remain unchanged.