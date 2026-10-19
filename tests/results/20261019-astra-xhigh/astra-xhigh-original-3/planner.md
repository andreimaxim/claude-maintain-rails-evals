**Recommend a staged upgrade: 7.1 → 7.2 → 8.0 → 8.1.0**, keeping Rails 7.0 defaults initially. This application is not ready for a direct version bump.

The **[full application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/plan.md)** includes affected code, versioned upstream sources, preparatory-change compatibility, validation cases, and rollout/rollback steps.

Key verified risks:
- **Partial imports:** an invalid second CSV row leaves the first row committed on 8.1.
- **Digest behavior and rollback:** dates shift from UTC to the reader’s zone; new BigDecimal job payloads cannot be consumed by Rails 7.0.
- **Unsafe preparation:** adopting `serialize :tags, coder: JSON` on Rails 7.0 silently writes YAML.
- **Removed APIs:** Action Text initialization, model declarations, forms, routes, secrets, reminder scheduling, and export generation need changes.
- **Dependency resolution:** Rails 8.1.0 resolved JSON 3.1.0, which breaks its JSON decoder; the tested diagnostic variant constrained JSON below 3.

The isolated baseline passed **46 tests / 325 assertions**. After limited diagnostic fixes, the 8.1 variant still had **3 failures and 15 errors**—not a validated upgrade. [Commands, configurations, lockfiles, and logs are retained](file:///home/user/workspace/repo/.amp/in/artifacts/rails-upgrade/evidence/README.md).

The working application was unchanged. Disposable services and copies were removed; the report is local and uncommitted.