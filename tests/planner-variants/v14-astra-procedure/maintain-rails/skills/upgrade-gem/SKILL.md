---
name: upgrade-gem
description: Plans gem upgrades in Ruby or Rails applications. Use when the user asks to upgrade, update, or bump a gem.
argument-hint: <gem> to <version>
---

# Planning a gem upgrade

Identify the gem and requested version from the request or `$ARGUMENTS`. Ask if
either is missing or unclear. Require an exact target version.

Read the resolved current version from `Gemfile.lock`, without evaluating the
Gemfile or booting the application. Ask if the gem is absent or has several
resolved versions. Identify the absolute application directory.

Delegate once to `maintain-rails:gem-upgrade-planner` with the application path,
gem, `currentVersion` and `requestedVersion`. The planner owns source research
and disposable experiments; do not repeat those in the parent session.

Return its full plan verbatim, including limits and evidence paths. Put any
additional commentary after the plan. Do not implement the upgrade or modify
the working application. No model or effort level is pinned in this plugin.
