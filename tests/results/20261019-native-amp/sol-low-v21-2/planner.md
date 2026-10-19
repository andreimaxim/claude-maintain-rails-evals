[Read the Rails 8.1.0 upgrade-risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-upgrade-risk.md).

The dependency resolution succeeds, but this is **not a drop-in upgrade**, even retaining Rails 7.0 defaults.

The most important findings:
- Failed CSV imports can **partially commit** instead of rolling back.
- CSV receipts can lose citation DOIs.
- Digest jobs retain the reader’s time zone, changing which day’s notes are emailed.
- New BigDecimal job payloads are incompatible with old Rails workers.
- Expired fragment-cache entries and DST-crossing reminder previews change behavior.
- Several APIs used by the app are removed, including secrets access and legacy enum/serialization syntax.

The report includes application references, upstream links, risk ratings, mechanical fixes, excluded areas, and explicit evidence gaps. Rack remains 2.2 and Sidekiq remains 6.5 in the resolved upgrade.

No application code or dependencies were changed or installed, and the application was not run.