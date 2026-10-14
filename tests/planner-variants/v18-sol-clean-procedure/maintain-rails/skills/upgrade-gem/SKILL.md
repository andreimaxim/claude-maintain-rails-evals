---
name: upgrade-gem
description: Plans gem upgrades in Ruby or Rails applications. Use when the user asks to upgrade, update, or bump a gem.
argument-hint: <gem> to <version>
---

# Planning a gem upgrade

Identify the gem and requested version from the request or `$ARGUMENTS`. Ask if
either is missing or unclear.

Read the gem's current exact version from `Gemfile.lock`, not the Gemfile's
constraint. If the lockfile is absent or lists ambiguous platform versions, ask
for the intended current version. Do not run Bundler in the working application.

Delegate to `maintain-rails:gem-upgrade-planner` with the gem and exact
`currentVersion`, `requestedVersion`, application root, and plugin root
`${CLAUDE_PLUGIN_ROOT}`. Return its full plan verbatim; do not
substitute a summary. Put any additional commentary after the plan. Do not
implement the upgrade or modify the working application.
