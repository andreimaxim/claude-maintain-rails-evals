**Rails 8.1.0 needs application changes before rollout—not just a dependency update.** Ruby 3.3.6 already meets its requirement.

[Read the application-specific upgrade plan](file:///home/user/workspace/repo/.amp/in/artifacts/rails-7.0.8.7-to-8.1.0-plan.md).

Key findings:
- Removed APIs affect Action Text initialization, enums, serialization, highlight accessors, citation configuration, retries, reminder scheduling and routes.
- CSV imports risk **partial commits** because transaction behavior changed.
- Digest jobs change both serialized arguments and time-zone behavior, creating mixed-version compatibility and UTC-day selection risks.
- New framework defaults separately affect notebook settings, date decoding, cache expiration and conditional downloads.

The plan distinguishes required changes from optional defaults, identifies preparations compatible with Rails 7.0, and specifies validation plus queue/data rollback precautions.

**Evidence is source-based:** application code and versioned upstream sources were inspected. No dependency resolution, application tests or service experiments were run. Application files remain unchanged.