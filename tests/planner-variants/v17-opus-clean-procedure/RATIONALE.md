# Rationale: a mechanical gem-upgrade planner

This document explains the new `gem-upgrade-planner` procedure and its scripts. For each step and script it gives the evidence in the bundle that supports it, the expected effect on cost and on plan quality, and the risks. It ends with what was tested and what was not.

## What changed, in short

The old prompt was a list of principles that relied on the model's judgment. Each run rebuilt the same machinery by hand: a disposable copy, isolated database and Redis, a bumped Gemfile, a booted app, and test runs on both versions. The new prompt is a numbered procedure of ten steps. Every mechanical task in it is one script call:

| Step | What the planner does | Script |
|---|---|---|
| 1 | Create isolated before/after copies, bump the gem | `upgrade-copy setup` |
| 2 | Read the change index | `gem-changes --lock --out` |
| 3 | Compare both versions | `upgrade-copy check` |
| 4 | Repair the after copy until it passes | `check --side after`, `bump`, `keep`, `reset`, `drop`, `gem-diff`, `step` |
| 5 | List candidates from the index and the check | (reads files) |
| 6 | Decide each candidate, probing on both sides | `upgrade-copy runner` |
| 7 | Prove each repair: before PASS, after-without FAIL, after PASS | `upgrade-copy validate` |
| 8 | Rollout: which repairs work on the current version; stored formats | `upgrade-copy backport [--hold]` |
| 9 | Framework defaults with their current values | `defaults-probe.rb` via `runner` |
| 10 | Plan in a fixed format; clean up | `upgrade-copy diff --all`, `cleanup` |

The plugin keeps its name (`maintain-rails`), the agent keeps its name (`gem-upgrade-planner`), and the agent still never changes the real checkout. The scripts use only Ruby's standard library and shell out to `git` and `bundle`.

## Evidence from the bundle

Averages per run, computed from `runs/*/meta.json` and the "Totals" in `runs/*/process.md`. "Setup and test calls" adds the step kinds database or Redis setup, create disposable copy, bundle resolve or install, boot or eager load, routes, and test suite.

| Case, variant | Score | Cost | Minutes | Tool calls | Setup and test calls | Boot or eager load | Test suite | Git history |
|---|---|---|---|---|---|---|---|---|
| rails base | 16.6/23 | $3.19 | 15.3 | 57.6 | 29.8 (52%) | 0.8 | 9.2 | 0.8 |
| rails v3 | 11.2/23 | $1.87 | 7.1 | 36.0 | 11.2 (31%) | 0.2 | 2.8 | 0.2 |
| rails v10 | 21.4/23 | $3.09 | 13.9 | 66.4 | 33.6 (51%) | 3.0 | 9.6 | 1.2 |
| rails v12 | 21.0/23 | $3.03 | 14.3 | 64.0 | 35.6 (56%) | 3.8 | 11.2 | 0.4 |
| concurrent-ruby v12 | 1.0/2 | $0.25 | 1.6 | 6.8 | 5.4 (79%) | 0 | 0 | 0.2 |
| faraday v12 | 1.8/2 | $0.46 | 3.1 | 14.6 | 11.0 (75%) | 0 | 0.4 | 0 |
| pagy v12 | 1.8/2 | $0.46 | 2.5 | 14.4 | 9.2 (64%) | 0 | 2.2 | 0 |

Readings that drive the design:

1. **Half or more of every run is plumbing.** Rails v12 spends about 36 of 64 calls on database and Redis setup (10.0), copying (2.6), bundling (5.6), booting (3.8), routes (2.4) and tests (11.2). Small gems spend 64–79% of their calls on the same work. These calls are repeated in every run and are the same in every application.
2. **Skipping the upgraded copy is the most expensive mistake.** v3 used the summary "as a checklist" and mostly did not run the upgraded app; it scored 11.2. All five concurrent-ruby runs created a copy and bundled it, but never booted it or ran its tests (0 boot, 0 test calls), and all five scored 1/2. The README's own lesson says the same: "plans without experiments on an upgraded copy miss findings".
3. **Quoting what was observed raised scores most.** v6 (state what breaks: 19.2) and v8 (quote the exact error: 20.0) were the largest single gains after v4.
4. **Validation with controls helps but is rarely complete.** v10 asked for a check that fails without the repair and a control (21.4, best mean). The README notes that plans "seldom give a check with unequal data and controls for each finding".
5. **Cutting visibility hurt.** v5 and v7 (keep long output in files) and v11 (run each experiment step as one script) lowered scores. The new scripts therefore print short, structured results that keep the decisive lines (errors with frames, failing tests, changed responses, raw values). They never print only "done", and the full logs stay available.
6. **Commits are almost never read.** "git history or diff" averages 0.2–1.2 calls per run. The bundle README says `gem-changes` does not look at commits, at upgrade guides kept in repositories, or at other gems that move. Release notes from outside the gem (v12) were already a modest gain.

## The procedure, step by step

### Rules (top of the prompt)

- **Content.** Write only under the workspace. Change code only under `W/after`. Run code only through `upgrade-copy`. Give long commands a 600000 ms timeout. Read long files in parts. Keep `findings.md`. Define "components" and "another gem".
- **Evidence.** The plan-only rule comes from every earlier prompt ("Do not implement the upgrade or modify the working application"). The definitions answer ambiguities that test runs reported: a Rails error inside `activerecord-8.1.0/…` looked like "another gem" to a literal reader.
- **Cost.** Neutral.
- **Quality.** Prevents the two worst failures: touching the real app, and acting on a misread rule.
- **Risk.** The rules add length. A small model may forget a rule by step 8. The scripts enforce the important ones anyway: isolation, and keeping real values out of diffs.

### Step 1: set up the copies (`upgrade-copy setup`)

- **Content.** One call creates `before` and `after`, gives each its own test databases and Redis database, and verifies that no database name matches the application's. It bumps the gem in the Gemfile, resolves and installs the bundle, loads the schema and fixtures, and prints every gem that moved. On a resolution conflict it prints the conflict and asks for `--also`.
- **Evidence.** Rails v12 spends about 10 database or Redis setup calls, 2.6 copy calls and 5.6 bundle calls per run. Faraday runs spend 5.4 bundle calls and pagy runs 4.4 database calls. The old prompt warned that "a copied checkout alone does not isolate its services" but left the work to the model.
- **Cost.** About 18 calls become 1 for Rails, and 6–10 become 1 for small gems. Setup took 10–25 s on the test app.
- **Quality.** Isolation becomes reliable and checked, not improvised. The moved-gem list feeds step 2. Gem incompatibilities surface at once. In testing, setup itself exposed "Puma 5 is not compatible with Rack 3".
- **Risks.**
  - The rewrite handles `database:` values (plain, quoted, ERB), `*DATABASE_URL` variables, Redis URL literals in `config/`, `app/` and `lib/`, and `REDIS*` variables.
  - It does not handle every layout: Redis configured by host and port keys, memcached, other local services. Setup prints such lines under "Not isolated automatically", and the prompt tells the planner to list them as not verified.
  - It assumes `bin/rails`, a test environment, and a reachable Redis to rewrite.
  - Copying `node_modules` in large apps is slow.

### Step 2: summarize the changes (`gem-changes --lock --out`)

- **Content.** Read the index from top to bottom. Use the long last section only as a search target.
- **Evidence.** v3 ("use as a checklist", 11.2) against v4 ("an index, not the findings", 18.4) shows that the wording matters. The planner must not treat matches as findings, and it must still run the app. The new prompt keeps v4's framing.
- **Cost.**
  - One call plus a few reads.
  - The summary is shorter than before for the same Rails range: 629 lines with 42 matched entries, against 897 lines with 94 matched entries.
  - The cut comes from three noise reductions: generated schema files and old migrations are no longer matched, code examples inside entries are skipped, and the most common call names are ignored.
- **Quality.** The summary now also covers the three sources the README says were missing, and more (see the `gem-changes` section).
- **Risks.**
  - Matching is still textual, and the test runs reported remaining noise (for example a guide section matched through a common word). The prompt's "decide each candidate" step absorbs it, at the cost of a few reads.

### Step 3: check both versions (`upgrade-copy check`)

- **Content.** One call runs the same checks on both sides at once: boot, eager load, routes, schema dump, tests with full backtraces, and GET requests to every route without parameters. It then lists only what differs.
- **Evidence.** Rails v12 runs spend about 18 calls on boot, routes and tests (3.8 + 2.4 + 11.2), plus probes to separate pre-existing failures from new ones. concurrent-ruby runs never did any of this and always scored 1/2. v8's gain came from quoting exact errors, and `check` prints them with the library frame and the application frame.
- **Cost.** About 18 calls become 1 to 3. On the test app both sides take about 3–7 s.
- **Quality.** The comparison catches things the planner would otherwise need judgment to find:
  - Code that no test covers but a page uses: the GET requests found a `/health` page that failed only after the upgrade.
  - Exceptions that requests rescued and logged, with their location.
  - Response header name changes.
  - Schema dump changes.
  - Deprecation warnings at the current version that the target removes, marked "still in after" or "gone in after".
- **Risks.**
  - Each side's tests stop at 480 s so the call fits a 10-minute tool limit; the prompt then switches to per-directory runs.
  - The GET requests run against the copy's test database with fixtures and could reach external services if a page calls them.
  - Test output parsing covers Minitest and RSpec formats only.

### Step 4: repair the after copy until every check passes

- **Content.** A fixed loop:
  1. Take the first problem in a fixed order.
  2. Copy its error.
  3. Search the index, the moved-gem files and the commit list for the name in the error; then `gem-diff` or the clone's log; then an intermediate `step`.
  4. Pick the repair by rule: move a gem the message names, pin a new or major-bumped gem that raised in its own code, or else make the smallest edit.
  5. Repair every other use of the name.
  6. Recheck with `check --side after`, then `keep`, or `reset` or `drop`.
- **Evidence.**
  - Repairs on a disposable copy are what raised scores from v3 to v4.
  - "One repair per finding that keeps other code paths working" (v9, 20.8) became the "repair every other use" item.
  - The rule for gem moves comes from testing. Three of the eight boot and load blockers in the Rails test came from other gems that moved with Rails: Puma, connection_pool and json.
- **Cost.** Each repair cycle is about 3 calls (edit, check, keep). Without `keep` and `reset`, a model must manage copies or reverts itself.
- **Quality.** The loop does not stop at the first green state. It continues until boot, eager load, routes, schema, tests, requests and logged exceptions all pass. Each finding records the exact error that showed before the repair.
- **Risks.**
  - "Smallest change" still needs judgment, as does choosing the replacement API when no source names one.
  - A literal reader could choose a repair that works only on the target. The prompt asks to prefer a change that also works on the current version, and step 8 tests this.

### Step 5: list every candidate

- **Content.** Mechanical sources: removed names; matched changelog entries; guide sections marked with application lines; moved gems with matches or major bumps; deprecations; schema, route and header differences; and, for small gems, every commit that changes `lib/`. Duplicates are merged.
- **Evidence.** The author's procedure: the changelog first, then commits ("for small gems, go commit by commit"), then each part of a split gem. v2 (trace every intermediate release) helped a little: 17.0 against 16.6.
- **Cost.** One write.
- **Quality.** Gives a small model a closed list, so coverage does not depend on its judgment.
- **Risks.** For a large framework the list can reach about 40–50 lines; the Rails test runs had 37–54 candidates.

### Step 6: decide each candidate

- **Content.** Read the cited line and mark it "not applicable" or "additive", or probe both sides with `upgrade-copy runner`. The probe gets the application's values and the edge cases the change names. A difference becomes a finding, or a risk when no code can restore the old behavior or the old output was wrong.
- **Evidence.** v8's gain (quote the observed behavior). The README notes that removals were stated "without consequences".
- **Cost.** One call per probe runs both sides and prints both outputs, so the planner writes no setup of its own.
- **Quality.** In testing this step found findings and risks that no check could see:
  - A test-environment setting whose old value now means the opposite.
  - A Redis client call that silently stopped pipelining while every test passed.
  - A host-normalization change in a small URL library, found by feeding it the edge case its commit named.
- **Risks.** Probing many candidates is the largest remaining cost for Rails-sized upgrades. Grouped probes are allowed to limit it.

### Step 7: validate each finding (`upgrade-copy validate`)

- **Content.** For each kept change, one call runs a check script on three copies:
  - before: it should print PASS;
  - a copy of after with only that change undone: FAIL or an error;
  - after: PASS.

  A CONTROL line must match across them.
- **Evidence.**
  - v10's instruction ("a check per finding that fails without the repair, with a control") gave the best mean, 21.4.
  - The README notes that validation is "rarely complete".
  - Doing this by hand needs a third isolated copy with one change reverted, which earlier runs did not attempt.
- **Cost.** One call per finding, about 5–6 s each on the test app.
- **Quality.** Every finding gets executed evidence that the repair is needed and works, with a control. In the final Rails test run, 8 of 9 findings were validated three ways; the ninth could not be undone alone, and the planner reported that limitation.
- **Risks.** The script undoes a change with zero-context patches. Two kept changes that edit the same lines still cannot be separated, and validate then runs only before and after and says so.

### Step 8: check rollout (`upgrade-copy backport`)

- **Content.**
  1. Apply all kept code changes and gem moves to the before copy, check it, and run every check script there.
  2. For repairs touching stored formats, hold the backport and print raw stored values on both sides.
- **Evidence.** Every prompt since the baseline asks to "state whether a proposed preparatory change also works on the current version, and account for stored data and queued work during rollout and rollback". The bundle has no way to answer this mechanically.
- **Cost.** One or two calls, plus one probe per stored-format repair.
- **Quality.** In testing this step caught a repair that passes every test on both versions but must not ship early. On the old framework version, the new `serialize … coder:` keyword is silently ignored and the column is written as YAML. Rows written that way break after the upgrade. The check script's raw-value line printed `FAIL raw "---\ntags:…"` on before.
- **Risks.**
  - The backport applies all repairs together. One repair that cannot work on the current version can make before's tests fail. The prompt then attributes failures by the files each repair touched, which is a rule, not a proof.
  - Only the test environment is exercised.

### Step 9: framework defaults

- **Content.** Run the generated `defaults-probe.rb` on both sides. For each default not set explicitly, write one line: value now, new value, effect in this app, and when to adopt. Settings the target no longer has are marked "nothing to adopt".
- **Evidence.** Since v2, prompts ask to list every new default with the app's current value and the effect of adopting it.
- **Cost.** One call instead of reading each setting by hand.
- **Quality.** Current values come from the running copy, not from memory. In testing, 4 of the 5 settings that Rails 8.1 removed were marked.
- **Risk.** Many settings have no public reader, so the probe shows only the configured value.

### Step 10: plan and clean up

- **Content.** A fixed template:
  - required changes, each with affected code, the observed failure, applicability, the repair diff, whether it works on the current version, validation and rollout;
  - risks without a code change;
  - gems that move;
  - optional defaults;
  - checked but not applicable;
  - not verified;
  - evidence.

  `diff --all` prints the repairs with the application's own database names and URLs. `cleanup` drops the copies' databases and Redis databases and deletes the copies, but keeps notes, check scripts and logs.
- **Evidence.**
  - The grader scores application impact, applicability and repair per finding; the template puts each in its own field.
  - "Separate required changes from optional default adoption and mixed-version rollout risks" is in every earlier prompt.
  - The rule "observed / from source / proposed" comes from "Distinguish source-based conclusions, executed checks, and checks still proposed".
- **Quality.** A small model fills fields instead of composing structure.
- **Risks.** It may fill fields mechanically with weak content, for example a control line that controls nothing.

## The scripts

All scripts use only Ruby's standard library and shell out to `git` and `bundle`. They print short, structured output and write full logs to files.

### `bin/gem-changes` (extended)

New since the bundle's version:

- **Upgrade guides kept in the gem's repository.**
  - **How.** A depth-1, blob-less clone of the release tag, a search for files named `*upgrad*`/`*migrat*`/`*breaking*`, and extraction of the sections whose headings name a version in range. Both markdown and underlined headings are handled, and code fences are ignored. Each subsection is listed with its matching application lines, and the full text is written to `guides/`.
  - **Evidence.** The README lists this as missing.
  - **Effect.** For Rails this brings in `upgrading_ruby_on_rails.md` sections 7.0→7.1 through 8.0→8.1. Faraday's `UPGRADING.md` and Pagy's `docs/guides/upgrade-guide.md` exist in their repositories and would now be read.
  - **Risk.** Unusual file names are missed.
- **Commits between release tags.**
  - **How.** A commit-only, shallow-excluded clone (`--filter=tree:0 --shallow-exclude=FROM`) counts the commits. For up to 300 commits, a blob-less clone lists each one with its files. Commits that change `lib/` are marked, as are version bumps; commits whose message mentions removals, renames or defaults are flagged. The output says plainly whether every commit is listed. For large ranges such as Rails (13,954 commits), the subjects go to a file, and the summary gives the local clone for `git log --grep`.
  - **Evidence.** The author's step 2. Planners averaged 0.2–1.2 git calls per run.
  - **Cost.** About 1–2 s. Rails' range clones in 1.4 s at 9 MB.
- **Methods and constants removed from the gem that the application still uses.**
  - **How.** The full `lib/` of both versions is unpacked. The script collects `def` names, accessor-style declarations and constants. It reports names defined at FROM and nowhere at TO that appear in application code. For single gems it counts only files that mention the gem's namespace, which keeps out common method names.
  - **Effect.** In testing it found the removed `Redis.current`/`current=` and `ActiveRecord.legacy_connection_handling` at their call sites, and `Rack::Utils::HeaderHash` in the moved Rack gem. These are textual matches that do not depend on changelog wording.
- **Other gems that move with the bump.**
  - **How.** With `--lock`, every gem whose version differs in the upgraded lockfile is summarized the same way into `moved/<gem>.md`. A gem new to the lockfile that replaces a copy bundled with Ruby (json, bigdecimal, uri and others) counts as moved from the bundled version.
  - **Evidence.** The README lists this as missing.
  - **Effect.** In testing, three of the Rails blockers came from such gems. One of them, json 3.1, came in through Ruby's bundled copy.
- **Noise reduction.**
  - Generated schema files and old migrations are no longer matched.
  - Identifiers are not taken from code examples.
  - Very common call names are ignored.
  - Each gem's own namespace (such as `Redis`) is ignored, since it appears on every line that uses the gem.
  - Qualified calls (`Const.method`) are matched whole.
  - Class-body macros (`serialize :x`) match without a dot, but assignments do not.
- **Framework defaults.** Settings the target's code no longer mentions are marked "nothing to adopt", and a `defaults-probe.rb` is generated.
- **"Where this application uses the gem"** lists, for single gems, the application lines that name the gem's namespaces. Commit candidates can then point at code.
- **`--out DIR`** writes `summary.md` and the detail files. Without it, the old behavior (print the summary) is kept.

Risks: the script needs network access to rubygems.org and the code hosts (as before, plus `git clone`). Repository detection uses GitHub, GitLab or Codeberg URLs from the gem metadata. Tag matching handles `vX`, `X` and `gem-X` forms.

### `bin/upgrade-copy` (new)

It replaces the plumbing that runs rebuilt by hand. Commands:

| Command | What it does |
|---|---|
| `setup` | Two isolated copies, a git snapshot of each, the bump, resolve and install, schema and fixtures |
| `check` | Both sides in parallel; prints only differences; writes `logs/check-report.md` |
| `bump` | Moves another gem in a side; accepts an exact version, a requirement such as `"< 3"`, or latest; keeps the change |
| `keep` | Keeps the current edits as part of the side's baseline |
| `reset` | Discards edits not yet kept |
| `drop` | Undoes one kept change |
| `diff [--all]` | Shows edits or all repairs, with isolated values mapped back to the application's own |
| `runner` | Runs Ruby with `rails runner` on both sides |
| `run` | Runs any command in a side |
| `validate` | Three-way run of a check script |
| `backport [--file] [--hold]` | Repairs applied to before, checked, check scripts run |
| `step VERSION` | A copy of after with its kept changes, moved to an intermediate version and checked |
| `cleanup` | Drops databases, empties Redis databases, deletes the copies, keeps notes |

Safety design:
- Each workspace claims empty Redis databases (never database 0) and records them. Cleanup refuses to flush anything else.
- Database names get a unique suffix, and setup refuses to proceed if any test database of a copy equals one of the application's.
- Commands find the workspace of the application in the current directory, so two planners in one machine do not cross.
- Every rewrite made for isolation is recorded, so diffs and backport patches carry the application's own values.

Testing found and fixed one serious bug before delivery. The first version of the Redis client ignored the database number in the URL, so `cleanup` emptied Redis database 0. Now every command selects the URL's database explicitly, and flushing refuses database 0 and any database the workspace did not allocate.

### `bin/gem-diff` (new)

- **Content.** Compares the packaged code of two versions of any gem. With no argument it lists changed files; with a file path it shows that file's diff; with a name it shows only the hunks that mention it. Output over 150 lines goes to a file. It works without a repository or tags.
- **Evidence.** "read gem source" is 2–8 calls per Rails run and 2.4 per pagy run.
- **Effect.** It answers "what replaced this removed name?" in one call. In testing, it showed that Rack's own code moved from `HeaderHash` to `Rack::Headers`, and that json 3 changed `JSON.parse`'s arguments.
- **Risk.** The diffs can be large; only matching hunks are printed.

### `skills/upgrade-gem/SKILL.md`

One change: read `currentVersion` from `Gemfile.lock`, so the planner always gets an exact version.

## Expected effect on cost and quality

- **Mechanical calls.** About 36 per Rails run, and 5–11 per small-gem run, become a handful of script calls. Their output is short and structured, which also cuts tokens per call.
- **Freed budget goes to probes and validation.** In the Rails test runs the planner made 58–73 tool calls in 10–12 minutes; the bundle's v12 Rails runs averaged 64 calls in 14.3 minutes. The calls went to probes, three-way validation, backport and stored-format checks, which earlier runs mostly skipped. So call counts for Rails are similar, but each call does more. The bigger cost lever is the model: the steps no longer need a large model to decide what to do next.
- **Small gems.** The planner now always runs the upgraded app and its checks, plus commit review, which concurrent-ruby runs never did. The test runs took 2.4 min and 15 calls (a small URL library) and 3.8–4.8 min and 28–31 calls (a Redis client with two real findings).
- **Expected plan-quality gains**, where earlier plans were weakest:
  - each finding has an observed error or output;
  - each repair has three-way validation with a control;
  - each repair has an executed answer to "works on the current version";
  - stored formats are compared raw;
  - co-moving gems and repository upgrade guides are covered.

These are expectations, not measurements against the grader.

## Testing done

**Test application.** I built a Rails 7.0.8.7 application on PostgreSQL 15 and Redis 7, on Ruby 3.3.6 via mise as in the evaluation orb. I designed it myself: two models, a Redis-backed service, a Rack middleware, a JSON-serialized column, a Redis cache store, two controllers (one page untested) and seven tests. It contains hazards for a 7.0→8.x upgrade, for a Redis client major upgrade, and for a minor bump of a small library. It ran only in disposable copies; the application itself stayed unchanged. Nothing in the prompt or scripts names its classes, files, settings or issues.

**Script tests on disposable copies.**
- Every command was exercised on three upgrades: Rails 7.0.8.7→8.1.0, redis 4.8.1→5.4.1 and addressable 2.8.1→2.8.7. The commands were setup, check, bump (exact, requirement, latest), keep, reset, drop, diff, runner, run, validate, backport (with and without held repairs, with gem moves), step, and cleanup.
- Isolation was also tested with an ERB database name and with `DATABASE_URL` in the environment.
- After each cleanup I verified two things. Only the application's own databases remained. The application's Redis databases (0 and the one its test cache uses) kept their keys, while the copies' databases were empty.
- The complete Rails command sequence runs in 79 s with four copies.

**End-to-end runs of the prompt.** Six runs, in three rounds: a subagent followed the agent file literally, without reading the scripts, and reported every unclear step. The issues reported in rounds 1 and 2 were fixed before the next round. Those from round 3 were fixed before delivery and checked with the script regression above, but not with another end-to-end round.

| Round | Upgrade | Tool calls | Minutes | Result |
|---|---|---|---|---|
| 1 | Rails | 66 | 12 | 9 findings; 2 not validated (tool limits, since fixed) |
| 1 | Redis | 31 | 5 | 2 findings; 1 not validated and backport failed (both since fixed) |
| 2 | Rails | 58 | 10 | 9 findings, all validated three ways |
| 2 | Redis | 28 | 4 | 2 findings, validated, backport ok |
| 3 | Rails | 73 | 12 | 9 findings, 8 validated three ways |
| 3 | Addressable | 15 | 2.4 | No required changes; 1 risk found by a probe |

The Rails runs found all six application hazards I had planted:
- the removed connection-handling setting;
- the old `enum` and `serialize` syntax;
- `to_s(:format)` in a tested model and an untested controller;
- the removed Rack header class.

They also found four required changes I had not planted: Puma 5 against Rack 3, connection_pool 3, json 3, and a test-environment setting whose old value now behaves the other way. The serialize repair was correctly marked as unsafe to ship before the upgrade. Round 3's Addressable run found a host-normalization change in 2.8.2 by probing the edge case named in the commit.

## What was not tested, and the main risks

- **No small model was tested.** The end-to-end runs used a large model told to follow the steps literally. Whether a fast, inexpensive model follows all ten steps is the open question. The prompt is about 2,300 words: longer than the old one, but in numbered steps with fixed outputs.
- **No grader.** The answer key and the evaluation application were not available by design, so there are no scores. Cost was measured in tool calls and minutes, not dollars.
- **Application variety.** One test application was used: PostgreSQL, Minitest, standard `database.yml`, `bin/rails`. Not tested:
  - MySQL or SQLite;
  - RSpec output;
  - multi-database configurations;
  - apps that need secrets or external services to boot;
  - JavaScript builds in `test:prepare`;
  - very large test suites, beyond the 480 s cap logic.
- **Network.** Changelogs, release notes, code diffs, repository guides and commits all need rubygems.org and the code host. Without them `gem-changes` degrades to what it can read, and says so.
- **The remaining judgment points:** the smallest repair, the probe inputs, "not applicable" decisions, and attributing backport failures. These are where a small model is most likely to err.
