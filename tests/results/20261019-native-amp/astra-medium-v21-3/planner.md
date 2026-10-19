[Read the full Rails upgrade risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-risk-report.md).

**Rails 8.1.0 is not a safe version-only bump for this application**, even retaining `config.load_defaults 7.0`.

The most consequential source-derived findings are:
- **High:** Failed CSV imports can commit partial batches.
- **High:** CSV receipts lose DOIs, and import previews lose annotations.
- **High:** Digests switch day boundaries; new decimal job payloads cannot be read by Rails 7.0 workers.
- **High:** Reminder timezone displays and negative cache-expiration behavior change.
- **Medium:** `Rails.application.secrets` is removed, and the built-in Sidekiq adapter is scheduled for removal in 8.2.

Dependency resolution succeeded **without upgrading Rack or Sidekiq**, but selected **JSON 3.1.0**, whose argument interface conflicts with Rails 8.1.0’s decoder.

The report includes application file/line citations, upstream evidence, mechanical fixes, conditional framework-default changes, and excluded areas. It distinguishes inspected code from predicted consequences.

**Application files and dependencies remain unchanged.** No new gems were installed, and no application, migrations, or tests were run.