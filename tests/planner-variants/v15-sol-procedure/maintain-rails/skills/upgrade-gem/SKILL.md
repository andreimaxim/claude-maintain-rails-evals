---
name: upgrade-gem
description: Plans gem upgrades in Ruby or Rails applications. Use when the user asks to upgrade, update, or bump a gem.
argument-hint: <gem> to <version>
---

# Planning a gem upgrade

Identify the gem and requested version from the request or `$ARGUMENTS`. Ask if
either is missing or unclear.

Read the locked version without booting the application:

```sh
ruby "${CLAUDE_PLUGIN_ROOT}/bin/gem-upgrade-lab" inspect "$PWD" <gem>
```

Delegate once to `maintain-rails:gem-upgrade-planner` with the application root,
plugin root, gem, exact `currentVersion` and exact `requestedVersion`. If the lock
has conflicting versions or the gem is absent, ask rather than inventing a version.
The planner owns source collection and disposable experiments. Return its full
plan verbatim and put any additional commentary after it. Do not implement the
upgrade or modify the working application.
