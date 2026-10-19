**The upgrade resolves, but it is not safe as a gem-only rolling deployment.**

The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) contains application assumptions, **9 high-risk findings**, **3 medium-risk findings**, mechanical fixes, and exclusions—with application line references and upstream sources.

The most consequential changes are:

- Failed CSV imports can **commit earlier rows** instead of rolling back.
- Import previews can silently omit annotations, and CSV receipts can lose DOIs.
- Digest jobs can switch from UTC-day to reader-local-day content.
- New BigDecimal job payloads cannot be deserialized by Rails 7.0 workers.
- Export generation fails because string `sum` no longer works without an initial value.

The report distinguishes changes that apply immediately from those disabled by the retained `load_defaults 7.0`. Resolution keeps **Rack 2.2.24 and Sidekiq 6.5.12**; it does not force Rack 3.

Supporting artifacts: [dependency diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-lockfile.diff) · [resolved lockfile](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-resolved.Gemfile.lock).

This was static analysis only. No gems were installed, the application was not run, and no application files were changed.