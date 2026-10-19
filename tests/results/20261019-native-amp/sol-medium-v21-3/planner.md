[Read the upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-upgrade-risk.md).

**This is not a safe version-pin-only upgrade**, even retaining Rails 7.0 defaults. Principal risks include:

- Partial imports committing after validation failures.
- CSV receipts silently losing DOIs and preview annotations disappearing.
- Digests switching from UTC-day to reader-local-day contents.
- New BigDecimal job payloads being unreadable by old workers.
- Changed rich-text conversion, DST previews, and cache-expiration behavior.

The report separates confirmed source-level changes from conditional concerns, covers mechanical API fixes, and explains which newer defaults do **not** apply automatically.

The temporary bundle resolved successfully: **Sidekiq and Rack retain their existing versions**. [Dependency-resolution diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

Application files and the original lockfile are unchanged. No upgrade was installed, and no application or tests were run.