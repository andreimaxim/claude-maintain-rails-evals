# maintain-rails

The `upgrade-gem` skill delegates planning to `gem-upgrade-planner`. The agent
inherits its caller's model. No model change is required to install the plugin.
The planner never applies the upgrade to the real checkout.

## Script commands

All scripts use Ruby's standard library, including RubyGems. Invoke them with the
application's Ruby, outside `bundle exec`. Git, Bundler, `psql` and a local Redis
server are external programs or services. Application commands use the application's
bundle, not additional dependencies of these scripts.

```sh
P=/absolute/path/to/maintain-rails
APP=/absolute/path/to/application
ruby "$P/bin/gem-upgrade-lab" inspect "$APP" GEM
E=$(mktemp -d)
ruby "$P/bin/gem-changes" GEM FROM TO "$APP" --output "$E"
B=$(ruby "$P/bin/gem-upgrade-lab" create "$APP")
# Read "$B/isolation.md", review the original configs, and isolate extra services.
ruby "$P/bin/gem-upgrade-lab" seal "$B"
ruby "$P/bin/gem-upgrade-lab" run "$B" install -- bundle install
ruby "$P/bin/gem-upgrade-lab" check "$B" baseline
U=$(ruby "$P/bin/gem-upgrade-lab" fork "$B")
# Review the fork's isolation too. Forks are unsealed.
ruby "$P/bin/gem-upgrade-lab" seal "$U"
ruby "$P/bin/gem-upgrade-lab" bump "$U" GEM TO
ruby "$P/bin/gem-upgrade-lab" check "$U" unmodified
ruby "$P/bin/gem-changes" GEM FROM TO "$APP" --output "$E" \
  --before-lock "$B/baseline.lock" --after-lock "$U/app/Gemfile.lock"
ruby "$P/bin/gem-upgrade-review" init "$E"
```

`GEM`, `FROM` and `TO` stand for a gem name and exact versions, not shell variables
in this example. Read failure logs even when `check` exits nonzero. Failures are
expected in upgrade experiments, not a reason to discard the run.

## gem-changes keeps full sources behind small indexes

Without `--output`, the original changelog-summary interface still works. With
`--output`, the script prints only the evidence directory and writes:

| File | Contents |
| --- | --- |
| `entries.tsv`, `entries.json` | Every parsed changelog entry, priority hints and all textual references. |
| `change-*.md` | Full entry text, including entries without textual matches. |
| `defaults.json`, `summary.md` | New default candidates, explicit settings, template paths and the original summary. |
| `coverage.json` | Sampled package versions, recursive lockstep components, missing changelogs and upstream collection status. |
| `upstream/sources.json` | Exact tags and tag hashes, versioned documentation paths and URLs, and source gaps. |
| `upstream/guides/` | Versioned changelogs, upgrade/migration guides, release notes and README files. Identical content is stored once. |
| `upstream/commits.tsv`, `commit-files.txt`, `changed-files.txt` | Complete commit interval and endpoint file changes. |
| `upstream/commit-groups/` | Commit indexes grouped by the repository's top-level directories. |
| `upstream/commits.patch` | Every commit's patch when the interval contains at most 80 commits. |
| `dependencies.json`, `dependencies.tsv`, `dependencies/` | Lock identity changes, reverse dependencies and separate source evidence for other upgraded registry gems. |

The package samples are the latest patch of each intervening minor series and
the exact target. Their cumulative changelogs contain earlier patch entries.
The Git interval includes commits omitted by those samples. Pre-release targets
are accepted, but intermediate pre-release packages are not sampled separately.
No entry or commit is discarded because it looks like a bug fix. Priority and
text matching guide reading; neither proves applicability or safety.

Upstream Git collection supports GitHub repositories identified by gem metadata,
with exact `vVERSION`, `VERSION`, `GEM-VERSION` or `GEM/vVERSION` tags. Missing tags
or unsupported hosts produce explicit gaps. Do not substitute the default branch.
For a large interval, read a component's index and use the recorded `git_dir`:

```sh
git --git-dir=GIT_DIR show COMMIT
git --git-dir=GIT_DIR diff FROM_TAG TO_TAG -- UPSTREAM_PATH
```

`complete` means collection completed, not that a person assessed every change.
Documentation detection uses filenames and can miss a guide with an unusual name.
Check the repository tree when a needed guide is absent. Compare full endpoint
diffs as well as commits when release branches diverge. An added lock entry may
replace a Ruby default gem. The dependency report includes candidate versions
from the invoking Ruby and reads their changes when possible. Confirm which
default gem the baseline actually loaded before claiming an impact.

Cached packages, metadata and bare Git repositories live under
`$XDG_CACHE_HOME/gem-changes` or `~/.cache/gem-changes`. Release-tag changes are
reported rather than forcibly replacing cached tags. Mutable release notes can
be stale in the cache; inspect their version coverage and remove only the relevant
cache file when a fresh fetch is needed. Network failures remain source gaps.

## gem-upgrade-lab isolates standard resources and records each command

`create` copies tracked files with their current contents and unignored untracked
files. It does not clone HEAD or reuse the original `.git`. It rejects symlinks
and submodules, and excludes local secrets, bundle config, caches, logs and stored
uploads. Copy a needed ignored development file by hand only after reviewing it.

The automatic harness supports PostgreSQL apps with local `psql` access and local
Redis without authentication. Pass `--pg-url postgresql:///postgres` or another
local admin URL to change the PostgreSQL connection. Pass `--redis-url` to select
a local server. A URL without a database path atomically claims one empty Redis
database from 1 to 15. A URL with a nonzero database path claims only that database.
Database 0 and occupied databases are never used. The lab stores its ownership
token and creates a randomly named PostgreSQL database.

The copied Rails database configuration points every environment at the lab's
database. Storage is local to the copy, and cable uses its Redis database. Originals
are retained for source comparison. The harness starts no servers and passes no
parent application secrets to child commands. PostgreSQL and Redis already need
to be running. `seal` acknowledges a review, not a security guarantee.

Read `isolation.md` before execution. For extra databases, nonstandard Redis
variables, external cache/storage services, hard-coded file paths or network
clients, configure the copy and add only local fake values to `lab.json`'s `env`.
Do not copy production credentials. Record the overrides and the behavior they
prevent you from testing. The harness is not an OS or network sandbox and cannot
discover every application-specific service. If safe isolation is not possible,
do not seal. Other database adapters need a manually isolated harness; report that
limitation rather than testing on the original services.

`fork` copies the current lab variant, including uncommitted repairs, added probes
and deleted files. It creates fresh database, Redis and storage resources, shares
only the lab's installed gems and fake signing secret, and requires a new isolation
review. Reapply custom isolation overrides if they depend on paths or service names.
Do not install gems concurrently into the shared lab bundle.

`bump` changes a static, single-line Gemfile declaration or adds an exact constraint
for a transitive gem. It preserves declaration options and runs a conservative
Bundler update. Dynamic declarations and git/path sources need a manual edit in
the copy. A failed resolution is not a tested upgrade. The script verifies the
locked version and retains the actual dependency delta.

`check LAB LABEL` executes bundle check, boot, eager loading, route drawing, database
preparation and Rails tests as separate commands. Every command runs even after
another fails. System tests and development/production mode need separate checks.
Use the same harness for focused probes:

```sh
ruby "$P/bin/gem-upgrade-lab" run "$U" failing-probe -- ruby bin/rails runner /absolute/path/to/probe.rb
ruby "$P/bin/gem-upgrade-lab" run "$U" focused-tests --timeout 600 -- ruby bin/rails test TEST_PATH
```

Each run keeps its command, duration, exit code, timeout, environment without the
fake secret, before/after lockfiles, Gemfile, source hashes, configuration snapshot
and complete output log. It uses the selected Ruby's bin directory before mise
shims, so moving a copy does not cause repeated toolchain trust failures. Timeouts
terminate only that command's process group and return failure.

`cleanup LAB` drops only the recorded random database and flushes only Redis whose
ownership token still matches. It retains the copy, bundle and logs for evidence.
Never remove an ownership token by hand to bypass a failed check. After all labs
are cleaned and evidence is saved, delete their temporary directories if desired.

## gem-upgrade-review checks investigation closure

`init EVIDENCE_DIR` creates review.json and one entry-title index per component and
minor series. Every parsed entry stays in an index, but recording a disposition for
a group avoids copying hundreds of low-value rows back to the model. Review all
titles in a group and record why relevant entries apply or do not apply.

Set each candidate's `status` to `reviewed` or `unverified`, fill `reason`, and link
findings through `finding_ids`. Add discoveries from commits, guides and experiments.
Populate `findings` with nonempty string fields:

```json
{
  "id": "F1",
  "category": "required",
  "locations": "Application paths and lines",
  "applicability": "The actual usage and configuration that triggers the change",
  "impact": "What the caller observes if nothing is changed",
  "evidence": "Exact observed output with a log path, or a versioned source citation",
  "repair": "One recommended repair and why other affected paths still work",
  "validation": "Setup, command and assertions; label executed versus proposed",
  "control": "The contrasting input or path and its expected unchanged result",
  "current_version": "Tested compatibility or the version gate for this repair",
  "stored_data_and_rollback": "Format, queued work, rollout and rollback handling, or an explicit non-applicability reason"
}
```

Other categories are `default` and `rollout`. Also fill `source_review` with component
coverage and gaps, `check_runs` with result.json paths, and `limits` with unresolved
checks. Run `ruby "$P/bin/gem-upgrade-review" check "$E"` before returning the plan.
Initialization refuses to overwrite decisions. Closure checks required fields and
links, not whether the application impact or repair is correct. Never manufacture
evidence to satisfy it.

## Verification

Run `ruby test/tools_test.rb` from this plugin directory for the retained contract
tests. Application experiments and their results are described in the accompanying
`RATIONALE.md`. Those checks do not measure model cost or plan quality.
