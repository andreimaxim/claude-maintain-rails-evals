**Rails 8.1.0 is feasible, but this is not a Gemfile-only upgrade.** The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/PLAN.md) separates required fixes, optional defaults, rollout risks, and discriminating validation.

Key findings:
- The unchanged app **fails to boot** at its Action Text allowlist initializer.
- Required repairs include model declarations, routes, citation configuration/retries, exports, CSV receipts, and reminder scheduling.
- Import transaction changes can cause **partial commits**.
- New job serialization changes digest-day behavior and produces decimal payloads that **Rails 7.0 workers cannot deserialize**.

Recommended sequence: deploy compatible preparations on 7.0, upgrade through each Rails minor while retaining 7.0 defaults, then adopt new defaults separately. Ruby, Sidekiq, Puma, and Rack replacements are not prerequisites—the target dependencies resolved with their current versions.

[Commands, resolved dependencies, probe results, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/EXPERIMENTS.md) are retained. Isolated probes confirmed the failures above; application suites, real-service checks, and browser workflows remain acceptance gates.

**The working application and service data are unchanged.** No upgrade was implemented, committed, or deployed.