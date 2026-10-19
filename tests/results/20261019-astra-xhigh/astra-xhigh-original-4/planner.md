**Use a staged upgrade, not a version-only bump.** The [full application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7-to-8.1/PLAN.md) includes affected code, versioned upstream sources, current-version compatibility, validation cases, and rollout/rollback gates.

Recommended sequence:
1. Deploy preparations that work on Rails 7.0.
2. Progress through **7.1 → 7.2 → 8.0 → 8.1.0**, initially retaining 7.0 defaults.
3. Adopt newer defaults separately after testing stored data, signing tokens, queues, caching, and editor behavior.

Important findings include:
- Removed APIs affecting models, imports, routes, forms, provider settings, retries, and scheduling.
- Import transactions that can partially commit after an early return.
- Digest serialization that changes the selected day and breaks old-worker compatibility.
- A serializer “preparation” that silently writes YAML instead of JSON on 7.0.
- JSON 3 incompatibility with exact Rails 8.1.0; the tested workaround is `json < 3`.

The isolated baseline passed **46 tests / 325 assertions**. The version-only target failed during Action Text initialization. Rack 3 and a Sidekiq upgrade were **not required by dependency resolution**.

[Commands, lockfiles, configuration, probes, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7-to-8.1/evidence/COMMANDS.md) are retained. The working application is unchanged; disposable resources were removed.