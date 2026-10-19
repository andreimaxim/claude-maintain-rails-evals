[Read the Rails 7.0.8.7 → 8.1.0 risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md).

**This is not a drop-in upgrade**, even with `load_defaults 7.0`. The most consequential findings are:

- Invalid CSV imports can commit earlier rows instead of rolling back.
- Digests can silently switch from UTC-day to reader-local-day selection.
- New BigDecimal job payloads cannot be decoded by Rails 7.0 workers.
- CSV receipts can lose DOI values, and previews can lose annotations.
- Provider configuration uses the removed `Rails.application.secrets` API.

The report includes before/after behavior, application line references, upstream evidence, mechanical fixes, and exclusions. Conditional risks are explicitly marked.

Temporary dependency resolution succeeded and retained **Rack 2.2.24, Puma 5.6.9, and Sidekiq 6.5.12**. It also introduced newer JSON and BigDecimal gems, whose changes are assessed.

**No application files or lockfiles were changed, no gems installed, and no application or tests run.** The report and resolution evidence are local review artifacts.