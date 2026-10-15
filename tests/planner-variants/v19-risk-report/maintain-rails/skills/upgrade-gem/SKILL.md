---
name: upgrade-gem
description: Reviews a gem upgrade in a Ruby or Rails application and reports the changes that affect it, rated by risk. Use when the user asks to upgrade, update, or bump a gem.
argument-hint: <gem> to <version>
---

# Reviewing a gem upgrade

Identify the gem and the requested version from the request or `$ARGUMENTS`, and ask if either is missing or unclear.

Delegate to `maintain-rails:gem-upgrade-planner` with the gem and the exact `currentVersion` and `requestedVersion`. Return its full report verbatim instead of a summary, and put any commentary of your own after it.

Stop after returning the report, even when the request says "upgrade". The user reads the report first and then decides whether to start the upgrade.
