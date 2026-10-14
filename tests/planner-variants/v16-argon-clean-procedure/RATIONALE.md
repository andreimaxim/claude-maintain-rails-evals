# Rationale for the redesigned gem upgrade planner

## Summary of the redesign

The redesigned `maintain-rails` plugin shifts mechanical discovery and experiment setup from ad-hoc model tool calls into two Ruby standard-library scripts (`bin/gem-changes` and `bin/upgrade-workspace`), paired with a five-step procedure in `agents/gem-upgrade-planner.md`. Across the five `rails-v12` runs in the bundle, the planner averaged 64.0 tool calls, 14.3 minutes, and a median cost of $2.97 to reach a mean score of 21.0 out of 23. Over half of those tool calls repeated the same setup work in every run, including 10.0 step groups for database or Redis setup, 2.6 for copying the checkout, 5.6 for resolving the bundle, 3.8 for booting or eager loading, 2.4 for drawing routes, and 11.2 for running the test suite. Moving the mechanical work into scripts and giving the planner a fixed sequence of steps allows a smaller, less expensive model to execute the same checks in roughly 6 to 15 tool calls while improving recall on missed findings.

## Scripts under `bin/`

### Extended `bin/gem-changes`

The extended `bin/gem-changes` script adds the three upstream sources that the v12 script lacked, and it fixes four matching and parsing defects observed in the v12 code.

- **Evidence in the bundle**
  - In `concurrent-ruby-v12-1` through `concurrent-ruby-v12-5`, every run scored 1 out of 2 (mean 1.0 out of 2, 6.8 tool calls). In `current-plugin/bin/gem-changes`, `covers_target` skipped remote release notes whenever the packaged `CHANGELOG.md` contained any entry in the target minor series (`1.3`). In `concurrent-ruby`, the packaged `CHANGELOG.md` includes `1.3.5` and replaces the entire `1.2.3` section with a link to the GitHub release page, and `gem-changes` did not inspect commits or `lib/` diffs between release tags. As a result, `gem-changes` reported only the removed `logger` and `win32ole` dependencies and hid all `1.2.3` and commit-level changes (such as `Promises#then_on` executor propagation and `TimerTask` changes).
  - In `pagy-v12-1` through `pagy-v12-5`, the planner had to read gem source code an average of 2.4 times per run and scored 1 out of 2 in `pagy-v12-4`. The `pagy` gem packages no changelog file, and its RubyGems `changelog_uri` points to `blob/master/CHANGELOG.md`. On `master`, that file is now a one-line redirect link, so `gem-changes` fell back to GitHub release bodies that say only "See the CHANGELOG for possible breaking changes." Meanwhile, the repository tag `9.0.0` contains both `CHANGELOG.md` (with the `:items` to `:limit` rename table) and `CHANGELOG_LEGACY.md` (covering versions 7.0 and 8.0).
  - In `faraday-v12-1` through `faraday-v12-5`, the planner averaged 14.6 tool calls and 5.4 bundle resolution steps, and `faraday-v12-1` scored 1 out of 2 without ever running the test suite. The v12 `gem-changes` script did not read `UPGRADING.md` from the repository and did not inspect `Gemfile.lock` for runtime dependencies removed in Faraday 2.0 (`faraday-retry`, `faraday-multipart`, and externalized adapters) or conflicting gems.
  - In `rails-v10` and `rails-v12`, scores peaked at 21 to 22 out of 23 and never reached 23 out of 23. Inspection of `current-plugin/bin/gem-changes` revealed four defects on Rails 7.0.8.7 to 8.1.0:
    1. Line 206 matched only `/\A#\s*Rails\.application\.config\.\S+\s*=/`, which missed all six Rails 8.1 framework defaults in `new_framework_defaults_8_1.rb.tt` because Rails 8.1 switched the template prefix to `# Rails.configuration.`. The regex also missed `# config.add_autoload_paths_to_load_path = false` and `# config.active_support.cache_format_version = 7.1` in 7.1, `# Regexp.timeout = 1` in 8.0, and multi-line `default_headers`.
    2. Line 212 reset the comment buffer on any empty `#` comment line (`comment = [] if text.empty?`), which discarded the primary description paragraph whenever a template comment had multiple paragraphs separated by `#`.
    3. Line 171 rejected any file whose full path contained `"/tmp/"` (`file.include?("/tmp/")`), causing `AppIndex` to index zero files whenever `gem-changes` was given a disposable copy located under `/tmp/`.
    4. Line 100 stripped leading colons from symbols, and line 185 matched single-word lowercase tokens only as dot-prefixed method calls (`/\.#{escaped}/`). Consequently, single-word symbols and keyword arguments (`:items`, `:size`, `:retry`, `:multipart`, `:rewhere`, `:deferrable`), class macros without a receiver (`enum`, `serialize`), helper calls (`pagy(`), and constants preceded by `::` (`/?<![\w:]/`) failed to match application code.

- **Changes made to `bin/gem-changes`**
  - Parses `Gemfile.lock` and RubyGems dependency metadata for `<currentVersion>` and `<requestedVersion>` to report conflicting locked gems, removed runtime dependencies (with application code matches), and dependencies whose versions move or whose upper bounds relax (such as `rack` moving from 2.x to 3.x during a Rails 7.0 to 8.1 upgrade, including matching sections from `rack`'s `UPGRADE-GUIDE.md`).
  - Reads repository upgrade guides (`UPGRADING.md`, `UPGRADE-GUIDE.md`, `guides/source/upgrading_ruby_on_rails.md`) and versioned Rails release notes (`guides/source/*_release_notes.md`) at the target version tag, matching each section against application code.
  - Fetches remote changelogs at the target release tag (`v<to>` or `<to>`) before falling back to `master` or `main`, follows links to companion files such as `CHANGELOG_LEGACY.md`, parses Markdown tables under breaking-change headings, and supplements packaged changelogs with GitHub release notes when a changelog entry links to GitHub releases.
  - Fetches the GitHub compare diff between release tags (`/compare/<from>...<to>`) for non-monorepo gems, reporting removed `require` statements in `lib/`, modified methods and constants in `lib/` that match application code, matching commits, and a commit-by-commit list for gems with up to 80 code commits.
  - Fixes `framework_defaults` to capture `# Rails.configuration.*`, `# config.*`, `# Regexp.timeout`, and multi-line settings, preserves full comment descriptions across blank `#` lines, annotates settings that are deprecated or removed in later releases in the range, and lists application lines that use the feature controlled by each setting.
  - Fixes `AppIndex` to check relative paths instead of rejecting `/tmp/`, indexes `test/` and `spec/` as a fallback, and matches symbols, keyword arguments, class-level macros, `.to_s(` with arguments, and `::`-prefixed constants.

- **Expected effect on cost and plan quality**
  - Plan quality increases because the planner receives all 6 Rails 8.1 framework defaults, the 16 relevant sections of `upgrading_ruby_on_rails.md`, moving companion gem changes (`rack` 3, `concurrent-ruby`), Pagy's tag changelog and rename table, Faraday's `UPGRADING.md` and removed middleware gems, and `concurrent-ruby`'s tag-to-tag commits and `lib/` diffs in the very first step.
  - Cost and tool calls decrease because the planner no longer needs to run 8 to 15 manual `Grep` and `read gem source` calls to rediscover undocumented changes or missing changelogs.

- **Risks and mitigations**
  - Expanding `gem-changes` could increase stdout length or hit GitHub API rate limits. To prevent context bloat, noise tokens (scaffold class names and common Rails config boilerplate) are filtered out in `STOPWORDS` and `GENERIC_CONSTANTS`, duplicate changelog/release entries are deduplicated, and unmatched upgrade guide sections are summarized to one line each. To avoid GitHub REST API rate limits, upgrade guides, release notes, and tag changelogs are fetched via `raw.githubusercontent.com` (which does not count against the 60-request unauthenticated REST quota), and all responses (including 404 misses) are cached in `~/.cache/gem-changes`.

### New `bin/upgrade-workspace`

The new `bin/upgrade-workspace` script automates creating isolated `baseline` and `upgraded` application copies, resolving the bundle, running initial diagnostics on both versions, executing side-by-side runner probes, running tests, resetting edits, and cleaning up all resources.

- **Evidence in the bundle**
  - Every `process.md` file in `runs/` shows the planner manually repeating the same infrastructure steps. In `rails-v12-1` through `rails-v12-5`, the planner averaged 10.0 `database or Redis setup` step groups, 2.6 `create disposable copy` step groups, 5.6 `bundle resolve or install` step groups, 3.8 `boot or eager load` step groups, 2.4 `routes` step groups, 11.2 `test suite` step groups, and 11.0 `runner probe` step groups.
  - In `pagy-v12-1` through `pagy-v12-5`, the planner averaged 4.4 `database or Redis setup` step groups and 2.0 `create disposable copy` step groups out of 14.4 total tool calls.
  - In `concurrent-ruby-v12-1` through `concurrent-ruby-v12-5`, the planner spent 5 to 9 tool calls on copy and database setup and never reached `test suite` or `runner probe` because Rails 7.0 failed to boot once `concurrent-ruby 1.3.5` removed `require "logger"`.
  - In `README.md`, variants `v5` (score 15.4 vs 18.4 in `v4`) and `v7` (score 17.8 vs 19.2 in `v6`) showed that instructing the planner to redirect all output to files and read slices with `grep` or `tail` hurt plan quality by 1.4 to 3.0 points, while `v11` (score 18.8 vs 21.4 in `v10`) showed that asking the model to write its own monolithic experiment bash scripts also reduced plan quality.

- **What `bin/upgrade-workspace` does**
  - `setup <gem> <from> <to>`: Creates `/tmp/upgrade-<gem>-<to>` with `baseline` and `upgraded` copies, creates four isolated PostgreSQL databases (`up_<id>_b_dev`, `up_<id>_b_test`, `up_<id>_u_dev`, `up_<id>_u_test`), selects and flushes two empty Redis database numbers, rewrites `config/database.yml` and Redis URLs in the copies, commits the isolated configuration as a clean git baseline, updates `Gemfile` in `upgraded`, resolves the bundle (automatically relaxing conflicting companion constraints in `upgraded/Gemfile` while logging the exact conflict), loads the database schema, and runs diagnostics and tests on `baseline` and `upgraded` in parallel threads.
  - Automatic boot recovery and per-file error scanning: If `upgraded` fails to boot due to `ActiveSupport::LoggerThreadSafeLevel::Logger` (when `concurrent-ruby >= 1.3.5` removes `require "logger"` on Rails < 7.1), `upgrade-workspace` records the exact boot failure and automatically preloads `logger` so that eager loading, routes, schema dump, and the test suite still execute. When `eager_load!` fails on a file, the diagnostic script loads every file in `app/` and `lib/` individually and retries up to 3 failing lines per file in memory, catching multiple broken class macros (such as both `enum` and `serialize` in the same model) in one pass.
  - Target `load_defaults` pass: When upgrading Rails, `setup` also runs diagnostics and the test suite on `upgraded` with `load_defaults` overridden to the target version via a `TracePoint` hook in `preload_probe.rb`, revealing failures that only appear when new framework defaults are adopted.
  - `probe '<ruby_code>' [--defaults VERSION]`: Executes a Ruby snippet via `rails runner` in `baseline` and `upgraded` (and optionally `upgraded` with target `load_defaults`) in parallel threads and prints the exact outputs and exceptions side by side.
  - `test`, `reset`, and `cleanup`: `test` runs boot, eager-load, routes, and the test suite on `upgraded` after repairs; `reset` restores `upgraded` and flushes its Redis database; `cleanup` drops the temporary PostgreSQL databases, flushes the temporary Redis databases, removes the workspace directory, and verifies that `git status` in the real checkout is clean.

- **Expected effect on cost and plan quality**
  - Reduces the 35 to 40 tool calls spent on copy creation, database/Redis isolation, bundle conflict retries, boot checks, route diffs, and test runs to 1 `setup` call, 1 to 3 `test` or `probe` calls, and 1 `cleanup` call. Wall-clock time drops because `bundle update` tries `--local` first and `baseline` and `upgraded` checks run concurrently in threads.
  - Improves plan quality by keeping noisy `bundle install`, `db:schema:load`, and passing test logs in `/tmp/upgrade-<gem>-<to>/logs` while printing all failures, load errors, route/schema diffs, and full multi-line deprecation warnings directly to stdout, avoiding the score drop seen in `v5` and `v7`.

- **Risks and mitigations**
  - A broken initializer or class macro in `upgraded` can prevent the test suite from running during `setup`. The per-file error scanner in `setup` surfaces all file load errors at once, and Step 3 instructs the planner to fix those load blockers in `upgraded` and run `upgrade-workspace test` so the full test suite and runtime probes can execute.

## Numbered procedure in `agents/gem-upgrade-planner.md` and `skills/upgrade-gem/SKILL.md`

### Step 1: Collect the change summary and set up the isolated workspace

- **Evidence in the bundle**: Variants `v3` (11.2) versus `v4` (18.4) proved that running `gem-changes` alone without upgrading and booting a disposable copy misses runtime findings and reports upstream removals without application consequences. Variants `v5` (15.4) and `v7` (17.8) showed that telling the planner to `grep` or `tail` the `gem-changes` summary from a file caused it to miss findings.
- **Expected effect**: Running `bin/gem-changes` (read in full) and `bin/upgrade-workspace setup` as the mandatory first step gives the model the complete static index and the initial runtime comparison in 2 tool calls instead of 25 to 35 ad-hoc commands.
- **Risks**: For a major Rails upgrade, `gem-changes` output is roughly 600 to 900 lines. That size fits comfortably in context (~8k tokens) and is much smaller than the raw test and bundle logs that `upgrade-workspace` keeps on disk.

### Step 2: Inspect the application code for every candidate change

- **Evidence in the bundle**: Variant `v2` (17.0 vs 15.4 in `v1`) showed the gain from tracing every intermediate release and its new configuration defaults rather than jumping straight to the target version. The `pagy` and `concurrent-ruby` runs showed that textual matching misses changes phrased without exact application identifiers unless the planner reads the cited application files and, for small gems, checks the commit list and `lib/` changes.
- **Expected effect**: Directs a smaller model to read the exact application files flagged by Step 1 and check specific categories of silent behavior changes (serializers, callbacks, `alias_attribute`, `enum`, `attr_readonly`, `has_secure_token`, finder ordering, `ActionController::Parameters` equality, redirects, JSON escaping, and Rack 3 middleware rules) in 2 to 5 targeted `Read` or `Grep` calls.
- **Risks**: A small model might treat every textual match in `gem-changes` as a true finding. Step 2 explicitly warns that textual matches can flag unrelated code and requires confirming each candidate in Step 3.

### Step 3: Probe behavior and verify repairs in the disposable workspace

- **Evidence in the bundle**: The largest score gains in the bundle came from stating what breaks in this application (`v6`, +0.8 to 19.2), quoting the exact error or observed behavior from an experiment (`v8`, +2.2 over `v7` to 20.0), recommending one repair per finding that keeps other code paths working (`v9`, +0.8 to 20.8), and giving a check that fails without the repair plus a control (`v10`, +0.6 to 21.4).
- **Expected effect**: Gives the model a concrete loop using `upgrade-workspace test`, `upgrade-workspace probe` (batching runtime checks across `baseline`, `upgraded`, and `--defaults`), and `upgrade-workspace reset`. Batching probes through `upgrade-workspace probe` replaces 10 to 26 separate `rails runner` tool calls with 1 to 3 side-by-side comparisons while producing exact, quotable outputs and exceptions for every finding.
- **Risks**: Edits made in `upgraded` to test one repair could affect another probe. Step 3 instructs the planner to verify controls on other code paths and provides `upgrade-workspace reset` to restore the clean post-setup state.

### Step 4: Clean up the disposable workspace

- **Evidence in the bundle**: Across `rails-v12`, planners spent multiple tool calls at the end of each run dropping databases, flushing Redis, and deleting temporary directories.
- **Expected effect**: Replaces manual teardown commands with a single `upgrade-workspace cleanup` call that drops all temporary PostgreSQL databases, flushes the temporary Redis databases, removes the workspace directory, and verifies that `git status` in the working checkout is clean.
- **Risks**: If the planner crashes mid-run before Step 4, temporary databases could remain; `upgrade-workspace setup` also cleans up any prior workspace at the same path before starting.

### Step 5: Write the upgrade plan

- **Evidence in the bundle**: `README.md` notes that the grader scores each finding on application impact, applicability, and repair, and that validation is rarely complete because plans seldom give a check with unequal data and controls for each finding.
- **Expected effect**: Specifies the exact four-section plan layout and the five required fields per finding (`Affected code`, `What breaks or changes in this application`, `Applicability`, `Recommended repair`, and `Discriminating validation`), explicitly requiring unequal, asymmetric test data and a control check for every finding.
- **Risks**: A smaller model might omit rollout risks or intermediate framework defaults if they are buried in prose. Placing them as numbered top-level sections and bulleted per-finding fields makes omission immediately visible during generation.

### Update to `skills/upgrade-gem/SKILL.md`

- **Evidence in the bundle**: `SKILL.md` delegates to `maintain-rails:gem-upgrade-planner` with `currentVersion` and `requestedVersion`. When a user prompt names only the gem and target version, a small model needs to know where to find `currentVersion` without running extra commands.
- **Expected effect**: Adds one sentence instructing the skill to read the exact locked version from `Gemfile.lock` when `currentVersion` is not stated in the request, saving tool calls before delegation.
- **Risks**: None; the plan-only behavior, delegation contract, plugin name, and agent name are unchanged.
