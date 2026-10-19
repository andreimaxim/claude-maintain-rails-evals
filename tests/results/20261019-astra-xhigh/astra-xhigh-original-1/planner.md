**Recommend a staged upgrade, retaining Rails 7.0 defaults initially—not a direct version bump.**

The [application-specific plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-assessment/plan.md) includes affected code, versioned sources, required fixes, optional defaults, validation cases, and rollout/rollback precautions.

Key confirmed risks:
- **Partial imports:** Rails 8.1 can commit the first CSV row even when the import returns failure.
- **Queued jobs:** Rails 7.0 cannot deserialize the new BigDecimal payloads. Prepare decimal-string arguments and explicit UTC digest handling first.
- **Stored attachments:** newer defaults produce signed identifiers that Rails 7.0 cannot read during rollback.
- **Unsafe preparation:** changing tags to `serialize :tags, coder: JSON` on Rails 7.0 silently writes YAML. That syntax change must wait until 7.1.
- **Dependency resolution:** Rails 8.1.0 resolved incompatible JSON 3.1.0; a compatible JSON 2.x constraint is needed.

Ruby, Rack, Puma, and Sidekiq upgrades were **not prerequisites** in the tested resolution.

**Executed:** baseline passed 46 tests. After limited diagnostic fixes, the target still had 3 failures and 15 errors. [Commands, lockfiles, and logs are retained](file:///home/user/workspace/repo/.amp/in/artifacts/rails-assessment/evidence/REPRODUCE.md).

The working application remains unchanged. Disposable services and copies were removed; implementation, browser checks, and live-worker deployment rehearsal remain.