# Routine-maintenance training cases

This is the coordinator's answer key for the training cases that complement Pagy
and Faraday. Never copy it into an application worker orb. The same four
judgments apply as in the [development rubric](planner-development.md).

| Case | Exact natural prompt | Lane |
| --- | --- | --- |
| Patch bump | `Upgrade the concurrent-ruby gem to 1.3.8` | 1.3.4 → 1.3.8; Rails 7.0.8.7 retained |
| No-op | `Upgrade the pagy gem to 8.6.3` | Already locked at 8.6.3 |

## Concurrent-ruby: an exact pin and a Rails 7.0 boot failure

| ID | Affected code and impact | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| CR1 | `Gemfile` pins `gem "concurrent-ruby", "1.3.4"` exactly, so 1.3.8 cannot resolve without changing the requirement. The release exists; the pin excludes it. | Change the requirement to `"1.3.8"` (or a range that admits it) and update only concurrent-ruby, for example `bundle lock --update concurrent-ruby --conservative`. Do not stop to ask for permission to edit the Gemfile instead of returning the plan. | The lockfile diff changes only concurrent-ruby to 1.3.8; `bundle check` passes. |
| CR2 | concurrent-ruby 1.3.5 and later no longer load `logger`. Rails 7.0's `ActiveSupport::LoggerThreadSafeLevel` references `Logger` while loading, so the application fails to boot (`uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger`). | `require "logger"` in `config/boot.rb` before Rails loads, shipped with the bump. It also works on 1.3.4. Upgrading Rails is not required for this lane. | Boot or eager-load the application with 1.3.8 without the fix (fails) and with it (passes), then run the suite in normal and eager-loading CI modes. |

## No-op: the requested version is already installed

| ID | Affected code and impact | Valid recommendation | Discriminating validation |
| --- | --- | --- | --- |
| NO1 | `Gemfile.lock` already resolves pagy 8.6.3, the requested version, so nothing in the application changes. Reporting breaking changes or migrations for this request is incorrect. | Make no Gemfile, lockfile or code change; say the upgrade is already done. | Cite the locked version (`Gemfile.lock` shows `pagy (8.6.3)`) or `bundle info pagy`. |
