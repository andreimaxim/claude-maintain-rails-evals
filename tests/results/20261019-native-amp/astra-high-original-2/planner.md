**Recommendation: upgrade in stages, retaining `config.load_defaults 7.0` initially. A Rails-version-only change is not deployable.**

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-upgrade-plan.md) identifies affected code, versioned upstream changes, safe preparatory edits, validation gates, and rollout/rollback requirements.

Highest-risk findings:
- **Partial CSV imports:** Rails 8.1 can commit earlier rows while the import reports failure.
- **Queue incompatibility:** new BigDecimal job payloads cannot be read by Rails 7.0 workers.
- **Wrong digest date:** preserved time zones change the intended UTC reporting day.
- **Unsafe early preparation:** switching to `serialize :tags, coder: JSON` on Rails 7.0 silently writes YAML.
- Additional blockers affect Action Text initialization, reminders, exports, provider configuration, routes, and forms.

**Executed checks:** baseline passed all 46 tests and 325 assertions. Rails 8.1 failed boot unchanged; after narrow boot/test adjustments and a JSON compatibility constraint, it still had **3 failures and 15 errors**. Focused probes confirmed the data and queue hazards above.

[Commands, dependency locks, configuration, probes, and logs](file:///home/user/workspace/repo/.amp/in/artifacts/rails-8.1-review/README.md) are retained. Browser behavior, full worker replay, production-data compatibility, and intermediate-version checks remain validation gates.

The working application is unchanged. Disposable databases, Redis, and scratch checkouts were cleaned up; no upgrade was committed or deployed.