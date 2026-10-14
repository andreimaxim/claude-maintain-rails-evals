---
name: upgrade-gem
description: Plans gem upgrades in Ruby or Rails applications. Use when the user asks to upgrade, update, or bump a gem.
argument-hint: <gem> to <version>
---

# Planning a gem upgrade

Identify the gem and requested version from the request or `$ARGUMENTS`. Ask if
either is missing or unclear. Read the current version from the gem's line in
`Gemfile.lock` (`grep -n "^    <gem> (" Gemfile.lock`); if the gem is not
locked, say so and stop.

Delegate to `maintain-rails:gem-upgrade-planner` with the gem, the exact
`currentVersion` and `requestedVersion`, and the application root. Return its
full plan verbatim; do not substitute a summary. Put any additional commentary
after the plan. Do not implement the upgrade or modify the working application.
