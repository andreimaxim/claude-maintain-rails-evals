[Read the Rails 7.0.8.7 → 8.1.0 risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

The report identifies **9 high-risk changes, 3 medium-risk changes**, mechanical fixes, and changes ruled out by this application’s configuration. Each finding includes application citations, upstream evidence, and explicit uncertainty.

Prioritize:
- Failed CSV imports can commit partial data.
- Receipts can silently lose DOIs, and previews can lose annotations.
- Digest dates and queued argument formats change, creating mixed-version deployment risks.
- Today’s resolver selects JSON 3.1.0, whose strict options conflict with Rails 8.1.0’s serialized-column reader.

Dependency resolution succeeded; the [lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lock.diff) records what moves. **No upgrade was installed, application files changed, or application/tests run.** This is a source-based assessment, not runtime verification.