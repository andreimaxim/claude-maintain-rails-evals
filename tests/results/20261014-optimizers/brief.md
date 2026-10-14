Redesign a gem-upgrade planner so a fast, inexpensive model can run it well by following steps instead of reasoning its way through.

The planner is the `gem-upgrade-planner` subagent of a Claude Code plugin, `maintain-rails`. Given a gem and a target version, it writes an application-specific upgrade plan: what breaks or changes in this application, the repair, and how to validate it. It plans only; it never changes the real checkout. Today it runs on Claude Opus 5.5 at low effort and costs about $3 and 13 minutes for a Rails 7.0 → 8.1 upgrade. The goal is the same or better plans for less, and eventually on smaller models. Its prompt is still a list of principles that rely on the model's judgment. Principles suit a large model that we are happy to spend on; here we want the mechanical work written down as concrete steps and, where possible, done by scripts.

The evidence is in `/home/user/workspace/repo/.git/optimizer-bundle.tar.gz` (SHA-256 `100ca49b3be6504261f743a6d6a9f034379176c4d2cb4b7956665d0932cd32d2`). It may take a minute to arrive; wait for it, then extract it outside the repository, for example to `~/bundle`. Start with its `README.md`. It holds planner traces, final plans and scores from earlier runs, the history of planner prompts, and the current plugin, including `bin/gem-changes`, a script that summarizes changelogs between two versions. Scores come from a grader with a hidden answer key that you will not get. Do not try to reconstruct the specific findings of this application; the procedure must work for any gem upgrade in any Rails application.

The repository at `/home/user/workspace/repo` is the Rails application the evaluations use, with Ruby, PostgreSQL and Redis set up. Use it to test your scripts and steps, but only in disposable copies with their own database and Redis database; never change its tracked files.

This is how the plugin's author upgrades a gem by hand, and the procedure should follow it:

1. Read the changelog, if there is one, and identify the changes. Breaking changes matter most; bug fixes matter much less.
2. Look at the commits between the current and the requested version to see what actually changed. For small gems, go commit by commit.
3. For gems split into several gems, such as Rails, see how they are split and go through each part's changelog or release notes.

`bin/gem-changes` already does steps 1 and 3 (packaged changelogs of every intermediate release, lockstep component gems, changelogs linked from gem metadata or GitHub releases, new framework defaults, and matches between changelog entries and application code). It does not look at commits between release tags, at upgrade guides kept in the repository, or at other gems whose versions move with the bump.

Deliver:

1. A complete replacement plugin directory with a new `agents/gem-upgrade-planner.md` that gives the planner a numbered, mechanical procedure, and the `skills/upgrade-gem/SKILL.md` if it needs changes. Keep the plan-only behavior, the plugin's name and the agent's name. Keep the prompt short enough for a small model to follow every step.
2. Scripts under `bin/` for the mechanical work, using only Ruby's standard library. Extend `gem-changes` with what it lacks, and add whatever else saves the planner work it now repeats in every run. For example, the traces show planners repeatedly writing their own setup for a disposable copy with isolated services, bumping the gem, and booting, eager-loading, drawing routes and running tests at each version. Test every script against this application in a disposable copy.
3. A `RATIONALE.md`: for each step and script, the evidence in the bundle that supports it, the expected effect on cost and on plan quality, and the risks.

Nothing in the prompt or scripts may name this application's classes, files, settings or specific issues.

Put the plugin directory and `RATIONALE.md` together in `/home/user/workspace/repo/.git/optimizer-result/`, then archive that directory as `/home/user/workspace/repo/.git/optimizer-result.tar.gz`. When finished, use `send_thread_message` to send thread T-01a13653-18ea-71fa-9cf0-a47aede44daa a short summary: the procedure in brief, the scripts, what you tested and with what result, and the archive's SHA-256. Do the work yourself; do not create other threads.
