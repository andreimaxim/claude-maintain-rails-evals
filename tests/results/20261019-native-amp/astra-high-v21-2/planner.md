**Overall risk: high.** The [full upgrade-risk report](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0/report.md) contains application assumptions, source citations, **8 high-risk findings, 3 medium-risk findings, 9 mechanical fixes**, and exclusions.

The most consequential changes:
- **Invalid imports can commit partial data** while reporting that nothing was saved.
- **Digests switch from UTC days to reader-local days**, changing which notes appear.
- **New digest payloads cannot be read by Rails 7.0 workers**, creating rollout and rollback risks.
- **CSV receipts lose DOI values**, and import previews silently omit annotations.

Keeping `load_defaults 7.0` does **not** prevent these changes.

The copied bundle resolved successfully. Rack and Sidekiq remain unchanged, but newly locked **JSON 3.1.0** introduces stricter parsing. The report includes the complete dependency diff.

No application files were changed, no upgraded gems were installed, and neither the application nor its tests were run. Findings are source-based; conditional risks and remaining uncertainties are explicitly marked.