**Rails 7.0.8.7 → 8.1.0 is a high-risk upgrade for this application**, even while retaining `config.load_defaults 7.0`.

The most important predicted changes are:
- Failed CSV imports can **commit earlier rows** instead of rolling back.
- Digest jobs can select a **different calendar day**, while Redis reservations remain UTC-based.
- New BigDecimal job payloads **cannot be read by Rails 7.0 workers** during a mixed-version rollout.
- CSV receipts lose DOIs, and import previews lose annotations, without raising errors.

The [full risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-risk-report.md) contains application assumptions, **10 high-risk and 3 medium-risk findings**, mechanical fixes, and excluded changes—with application line references, upstream citations, and uncertainty labels.

Temporary dependency resolution succeeded: **Rack remains 2.2.24 and Sidekiq remains 6.5.12**, while JSON 3.1.0 introduces an additional parser-compatibility risk. See the [resolved lockfile diff](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1.0-lockfile.diff).

**No upgrade was performed:** application files and lockfile are unchanged; upgraded gems were not installed, and the application and tests were not run. These are local review artifacts only.