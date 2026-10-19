**This needs a staged upgrade, not just a Rails version bump.** The application-specific [upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/plan.md) includes affected code, versioned upstream evidence, current-version compatibility, validation cases, and rollout/rollback guidance.

The most consequential findings are:

- Failed imports can **commit earlier rows** because transaction exits change behavior.
- Digest emails can switch from UTC days to local days; newer BigDecimal payloads are **unreadable by Rails 7.0 workers**.
- The Action Text initializer, multi-path routes, enum/serializer declarations, and several other APIs need changes.
- New defaults affect notebook settings, activity reports, cache expiration, and conditional downloads.
- Signing keys, attachment SGIDs, and queued reminders require explicit cross-version compatibility checks.

**Recommended sequence:** compatible preparation on 7.0 → 7.1 → 7.2 → 8.0 → 8.1.0, retaining 7.0 defaults initially. Adopt newer defaults separately.

This assessment is **source-based**. No target bundle resolution, application tests, or runtime experiments were run. The application and its services remain unchanged; [review evidence](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/evidence.txt) is retained alongside the plan.