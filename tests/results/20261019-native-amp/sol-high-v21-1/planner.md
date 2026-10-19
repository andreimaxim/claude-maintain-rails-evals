**This is not a lockfile-only upgrade.** The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) includes application assumptions, before/after behavior, risk ratings, code citations, upstream evidence, and excluded features.

The most important findings are:

- **Partial imports:** returning false from inside a transaction can now commit earlier rows.
- **Mixed-version jobs:** new BigDecimal digest payloads cannot be deserialized by Rails 7.0 workers.
- **Digest contents:** preserved argument time zones change the selected day from UTC to the reader’s local day.
- **Silent CSV/UI changes:** receipt DOIs can become blank, and import preview annotations can disappear.

Keeping `load_defaults 7.0` does **not** prevent those changes.

Dependency resolution succeeded with the existing Rack, Sidekiq, Redis, and Puma versions. The [lockfile comparison](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff) records all dependency movements, including newly locked JSON 3 and BigDecimal 4.

The application and its lockfile remain unchanged. No upgrade was installed, no application or tests were run, and nothing was committed or deployed.