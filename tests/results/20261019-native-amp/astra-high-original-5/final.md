**Rails 8.1.0 is feasible, but this is not a safe Gemfile-only upgrade.**

The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0-to-8.1/PLAN.md) covers required changes, safe Rails 7.0 preparation, optional defaults, validation, and rollout/rollback risks.

Key findings:
- The unchanged app fails target boot in its **Action Text allowlist initializer**. Routes, serializers, enums, imports, exports, and job APIs also need changes.
- **CSV imports can partially commit** after an invalid row under newer transaction behavior.
- **Digest jobs change date semantics**, and new BigDecimal payloads cannot be consumed by Rails 7.0 workers.
- Changing tags to keyword serializer syntax **before leaving Rails 7.0 silently writes YAML instead of JSON**.
- Existing Sidekiq/Puma/Rack pins resolve. However, the fresh target resolution selected incompatible **JSON 3.1.0**; a controlled `json < 3` variant fixed the observed decoding failures.

Recommended sequence: safe 7.0 preparation → 7.1 → 7.2 → 8.0 → 8.1.0, retaining **7.0 defaults initially**.

[Commands, lockfiles, probe results, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0-to-8.1/evidence/commands.md) are retained. Full application/browser/real-worker validation remains outstanding.

**The working application is unchanged.** Disposable databases and experiment resources were removed; no upgrade was implemented or deployed.