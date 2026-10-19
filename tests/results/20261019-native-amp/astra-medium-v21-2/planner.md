**Overall risk: high. This is not a drop-in upgrade.**

[Read the full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md). It includes application assumptions, before/after behavior, application-line citations, upstream sources, mechanical fixes, and excluded changes.

The most consequential findings are:

- **Partial CSV imports:** an early return now commits earlier rows instead of rolling back.
- **Digest behavior:** restored time zones change which day’s notes are emailed; new BigDecimal payloads are incompatible with Rails 7.0 workers.
- **Silent output changes:** CSV receipts lose DOIs, and import previews hide annotations.
- **Additional blocker:** today’s dependency resolution selects **JSON 3.1.0**, whose parsing API conflicts with Rails 8.1.0’s decoder.
- Several mechanical blockers affect initialization, enums, serialization, routing, reminder scheduling, and exports.

Resolution succeeded while retaining **Sidekiq 6.5.12 and Rack 2.2.24**. PostgreSQL date decoding and several other new defaults do **not** activate while `load_defaults 7.0` remains.

[Resolved lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff)

The assessment and evidence artifacts are complete. **No application files were changed, no upgrade was installed, and no application or tests were run.** Runtime consequences are explicitly marked as source-based predictions.