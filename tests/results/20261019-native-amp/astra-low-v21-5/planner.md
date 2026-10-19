[Read the full Rails upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-risk-report.md).

**Overall: high risk—not a drop-in upgrade.** Key findings:
- Failed imports can silently commit partial batches.
- Digest emails change from UTC-day selection to the reader’s local day.
- New BigDecimal job payloads cannot be read by Rails 7.0 workers.
- Import previews lose annotations, and CSV receipts lose DOI values.
- Routing, model declarations, reminder scheduling, and Action Text initialization need mechanical fixes.

Dependency resolution succeeded. **Rack stays at 2.2.24**, but the resolved bundle introduces **JSON 3.1**, with stricter parsing behavior. [Dependency diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

The report distinguishes confirmed source changes from inferred consequences and flags changes that remain inactive with `load_defaults 7.0`.

No application files were changed, gems installed, or application/tests run. Only the local review artifacts were created.