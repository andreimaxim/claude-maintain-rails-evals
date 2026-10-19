**Rails 8.1.0 needs a staged compatibility upgrade, not just a version bump.** The [application-specific plan and evidence](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/PLAN.md) cover required changes, optional defaults, validation, and rollback.

Key confirmed risks:
- **Partial imports:** a rejected batch commits its first valid row on 8.1, even with Rails 7.0 defaults retained.
- **Queued digests:** timezone preservation changes the selected day; new BigDecimal payloads cannot be deserialized by Rails 7.0.
- **Removed APIs:** affect boot, note filtering/forms, reminders, citation enrichment, and exports.
- **Dependency resolution:** Rails 8.1.0 currently resolves JSON 3.1.0, which breaks framework decoding. A JSON 2.x constraint is needed.

Recommended sequence: **7.0 → 7.1 → 7.2 → 8.0 → 8.1**, retaining old defaults initially. Some syntax changes are unsafe to deploy as preparation on 7.0; the plan identifies them.

**Checks:** baseline passed 46 tests. The unmodified target failed boot; a diagnostic copy still had 3 failures and 15 errors after removing initial blockers.

No application files were changed. Disposable resources were removed; commands, lockfiles, patches, and logs are retained with the report.