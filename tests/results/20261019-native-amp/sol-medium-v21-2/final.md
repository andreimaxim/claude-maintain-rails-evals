**Overall risk: high.** The [full upgrade-risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) includes application assumptions, before/after behavior, code references, upstream sources, mechanical fixes, and exclusions.

The strongest findings are:

- Failed CSV imports can **commit partial batches** instead of rolling back.
- CSV receipts can silently lose DOI values, and import previews can lose annotations.
- Digest serialization changes can select a **different day’s notes** and break compatibility with old workers.
- Expired export fragments can be cached without an expiry.
- Removed APIs affect model loading, routing, citation configuration, and reminder scheduling.

The temporary dependency resolution **succeeds and retains Rack 2.2**, but selects JSON 3.1.0. Source inspection identifies decoding incompatibilities with Rails 8.1.0; these are documented as static findings, not runtime-tested results.

The report distinguishes unconditional changes from newer defaults that remain disabled by `load_defaults 7.0`.

[Dependency diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff) · [Resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolved.lock)

No application files were changed, no new gems were installed, and the application was not run. This delivers the assessment—not an upgrade.