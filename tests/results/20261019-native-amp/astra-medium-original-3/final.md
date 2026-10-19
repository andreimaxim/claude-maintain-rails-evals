**This needs a staged upgrade, not just a Rails version bump.** The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md) includes affected code, versioned upstream evidence, current-version compatibility, and discriminating validations.

Key findings:
- **17 compatibility issues**, including Action Text initialization, routes, model serialization, imports, exports, and reminder scheduling.
- **Queued-work risks:** digest timezone preservation changes the selected day; new BigDecimal payloads cannot be consumed by Rails 7.0 workers.
- **Defaults to adopt separately:** readonly slug enforcement, PostgreSQL date decoding, cache expiration handling, sanitization, and HTTP freshness.
- **Rollback safeguards:** preserve signing keys, stored JSON/YAML and attachment references, and compatible queue/cache formats.

Recommended sequence: deploy Rails-7.0-safe preparation, then stage through **7.1 → 7.2 → 8.0 → 8.1.0**, initially retaining `config.load_defaults 7.0`. Ruby 3.3.6 already meets the target requirement.

**Delivery state:** assessment complete; application unchanged. Conclusions are source-based. Dependency resolution, runtime tests, browser checks, and cross-version payload experiments remain explicitly proposed—not executed.