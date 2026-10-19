**This is a high-risk upgrade for this application**, even with `config.load_defaults 7.0` retained.

The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) includes application facts, before/after behavior, file-and-line citations, upstream sources, mechanical fixes, and exclusions.

The most consequential findings:
- Failed imports can **commit earlier rows** instead of rolling back.
- Import receipts can lose DOI values, while previews omit annotations.
- Digests can select a different calendar day; new BigDecimal job payloads cannot be read by old workers.
- Signing-key selection, attachment metadata updates, and export/cache behavior change.
- `Rails.application.secrets` is removed, requiring a provider-configuration migration.

Temporary dependency resolution succeeded and **kept Rack 2 and Sidekiq 6**, but introduced JSON 3.1.0 and BigDecimal 4.1.3. See the [lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

This was a source-only assessment: no upgraded gems were installed, and the application was neither changed nor run. The report and resolution evidence remain local artifacts.