---
name: upgrade-gem
description: Plans gem upgrades in Ruby or Rails applications. Use when the user asks to upgrade, update, or bump a gem.
argument-hint: <gem> to <version>
---

# Planning a gem upgrade

Identify the gem and requested version from the request or `$ARGUMENTS`. Ask if
either is missing or unclear. If the current version is not stated in the
request, read the exact locked version of the gem from `Gemfile.lock`.

Delegate to `maintain-rails:gem-upgrade-planner` with the gem and exact
`currentVersion` and `requestedVersion`. Return its full plan verbatim, and do
not replace the plan with a summary. Put any additional commentary after the
plan. Do not implement the upgrade or modify the working application.
