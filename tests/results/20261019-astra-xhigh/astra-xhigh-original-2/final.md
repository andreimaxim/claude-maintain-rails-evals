**Rails 8.1.0 is feasible, but not safe as a version-pin-only upgrade.** The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-810-evaluation/PLAN.md) includes affected code, versioned upstream evidence, preparations compatible with Rails 7.0, validation cases, and rollout/rollback sequencing.

Critical findings:
- Invalid CSV imports can **partially commit** on the target.
- Digest serialization changes both the UTC-day behavior and compatibility with Rails 7.0 workers.
- The Action Text initializer prevents boot; additional removed APIs affect models, forms, routing, exports, and jobs.
- Today’s resolution selects JSON 3.1, incompatible with this exact Rails patch. The comparison required JSON 2.x.
- Adopting newer defaults introduces separate YAML, readonly-slug, date-decoding, and cache-expiry concerns.

**Executed checks:** the isolated baseline passed 46 tests. The diagnostic Rails 8.1 variant, after limited compatibility patches and the JSON constraint, still had **3 failures and 10 errors**. Cross-version probes confirmed the partial-write and queue-format risks.

Recommended sequence: compatible preparations on 7.0, then **7.1 → 7.2 → 8.0 → 8.1**, initially retaining 7.0 defaults.

The working application remains unchanged. Disposable services and copies were removed; commands, configurations, lockfiles, probes, and logs are retained alongside the plan.