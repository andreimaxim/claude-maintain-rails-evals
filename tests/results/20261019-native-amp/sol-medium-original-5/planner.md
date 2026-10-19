**Rails 8.1.0 is feasible, but not as a Gemfile-only upgrade.** The application remains unchanged.

The [application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md) details required changes, optional defaults, rollout/rollback risks, upstream sources and validation.

Key findings:
- **Data integrity:** an invalid CSV import can partially commit on the target.
- **Queued work:** new BigDecimal payloads cannot be read by Rails 7.0 workers; digest dates also shift from UTC to local days without an explicit correction.
- **Compatibility:** initialization, declarations, routes, forms, exports, secrets and reminders need changes. Exact Rails 8.1.0 also required **JSON < 3** in the tested resolution.
- **Defaults:** adopt them separately; several break notebook settings, activity reports or export caching.

Isolated baseline tests passed **46 tests / 325 assertions**. Experimental compatibility candidates passed on both versions, but browser, real-worker and production checks remain outstanding. Commands, lockfiles, patches and logs are retained in the [experiment ledger](file:///home/user/workspace/repo/.amp/in/rails-upgrade/README.md); disposable databases and Redis were cleaned up.