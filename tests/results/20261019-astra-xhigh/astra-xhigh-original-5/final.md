**Rails 8.1.0 is feasible, but this is not a safe Gemfile-only upgrade.**

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-assessment-c9e3/PLAN.md) separates required changes, optional defaults, and rollout/rollback risks.

Confirmed critical issues:
- Invalid CSV batches can **partially commit** instead of rolling back.
- Digests change calendar day, and new BigDecimal job payloads cannot be read by Rails 7.0 workers.
- Applying the new serializer syntax prematurely on 7.0 silently writes YAML instead of JSON.
- Several APIs require changes across initialization, forms, queries, exports, and reminder scheduling.

Recommended sequence: prepare compatible fixes on 7.0, progress through **7.1 → 7.2 → 8.0 → 8.1.0**, retain 7.0 defaults initially, then adopt defaults separately. Ruby 3.3.6 already qualifies; replacing Sidekiq or Rack is not inherently required.

**Evidence:** baseline passed 46 tests. The raw target failed boot; after limited diagnostic repairs, it still had 3 failures and 15 errors. [Commands, resolved dependencies, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-assessment-c9e3/COMMANDS.md) are retained.

The working application is unchanged. Disposable copies, databases, and Redis service were cleaned up; no upgrade was implemented or deployed.