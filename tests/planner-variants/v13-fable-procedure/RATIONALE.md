# Rationale for the mechanical gem-upgrade planner

The v12 prompt is a list of principles ("upgrade a disposable copy", "quote the error", "one repair per finding with a check that fails without it"). The traces show Opus following them well but spending most of its 60–80 tool calls on the same mechanical work in every run: standing up private services, cloning and renaming databases, bumping the gem, running the same checks after each repair, and debugging its own setup. The redesign writes that work down as two scripts and an eleven-step procedure, so the model's job becomes: read a summary, pick the first error, make a one-line repair, rerun a command, record what changed.

Evidence below cites `runs/<case>-<variant>-<low|high>/trace.md` step numbers (S) and `meta.json` numbers from the bundle.

## Cost and quality baseline

| run | score | cost | minutes | tool calls |
|---|---|---|---|---|
| rails-v12-high | 22/23 | $2.55 | 13.4 | 61 |
| rails-v12-low | 20/23 | $4.45 | 17.9 | 82 |
| rails-v3-low (no copy, summary only) | 7/23 | $0.77 | 3.3 | 8 |
| pagy-v12-high / low | 2/2, 1/2 | $0.45 / $0.47 | 2.2 / 2.6 | 12 / 17 |
| faraday-v12-high / low | 2/2, 1/2 | $0.44 / $0.59 | 2.7 / 3.9 | 11 / 20 |
| concurrent-ruby-v12-only | 1/2 | $0.27 | 1.4 | 6 |

In every pair the higher-scoring run is also the cheaper one. The expensive runs are not more thorough; they lose steps to setup accidents (rails-v12-low: 82 calls, 20/23). So the cost target is "remove the accidents", not "do less".

## The procedure (agents/gem-upgrade-planner.md)

**Step 1–2: inputs, `gem-changes`, `upgrade-lab start`.** Every v4+ run starts the same way: run gem-changes, create a copy, start services, bump. The copy setup alone costs 6–12 calls per run (rails-v12-high S3–S12; rails-v12-low S3–S15), and it goes wrong in a different way each time: `mise trust` prompts (2–5 calls in every Rails run), a shared dev/test database causing foreign-key collisions (rails-v8-low S44), `database.yml` `username:` merging into `DATABASE_URL` so the production boot failed for an unrelated reason (rails-v10-high and rails-v12-high S58), forgetting `--conservative` so unrelated gems moved (rails-v9-high, rails-v10-low), `git clone` of an uncommitted copy that silently dropped the repairs (rails-v12-high S39–41). concurrent-ruby-v12-only never ran the tests at all because it "needs isolated Postgres and Redis" and scored 1/2. `upgrade-lab start` does all of this in one call (15.7 s for pagy, 33.5 s for Rails on this application) and checks both copies, so the first upgraded error is on screen before the model has made a decision. Expected effect: −10 to −15 calls per Rails run, and the small-gem cases get a real test run instead of a guess.

**Step 3: read `changes.md` into a numbered list.** v12 told the model the summary is "an index, not the findings" and the model then searched the summary ad hoc. Writing a numbered list up front makes step 6 ("entries no finding covers") mechanical: the model compares two lists instead of remembering. The "Removals with no textual match" section is capped at 15 greps because for Rails it has ~250 entries; rails-v3-high spent its budget reading such sections (and truncated gem-changes with `head -c 60000`, losing the end of the file).

**Step 4: read the start log; bundle conflicts are R1.** rails-v9-high and rails-v10-low discovered a Gemfile conflict only after several calls because `bundle update` was run without `--conservative`; the lock diff now shows exactly which gems moved and why.

**Step 5: repair loop with a fixed command and a cap.** The high-scoring runs all converge the same way: first error → call site → changelog entry → smallest repair → rerun (rails-v12-high S13–S33). The low-scoring runs differ in that they rerun the whole suite 8–9 times and re-derive the "which tests changed" diff by hand (rails-v10-low S40–S60). `check` prints the first error with application and gem frames, groups failing tests by distinct error, lists "newly passing/newly failing" against the previous check, notes when the same error occurs on `base` (pre-existing failures are not findings), and now also lists the exceptions the server logged during the tests, because a controller test reports only "was a <500>" and in the traces the model opened `log/test.log` by hand to find the cause (rails-v9-low S21–23, rails-v12-high S21–25, faraday-v12-high S7: all the moved-`json` default-gem failure). The 12-check cap and the "two repairs then Not verified" rule bound cost; a loop that never converges is the single biggest cost risk with a small model.

**Step 6: probes for unreached entries.** Several answer-key findings never appear in a test: the BigDecimal job payload on rollback (every run that scored it ran a `bin/rails runner` probe), the signed-global-id crash on rollback (rails-v9-low S54, rails-v12-low S68, rails-v12-high S59–60). The step tells the model where the candidates are (the list from step 3 minus the R-findings) and gives the exact command. `run` sets `RAILS_ENV=test` because that is the database `check` prepared; in the traces the first probe on a copy usually failed on a missing development database.

**Step 7: a `defaults` copy.** Default-related findings appear only in runs that made a second copy with `load_defaults` raised (rails-base-low S69–70, rails-v8-low S43–45, rails-v8-high S52–56, rails-v9-low S38, rails-v12-high S41) and never in runs without one. `copy --load-defaults` edits `config/application.rb` in the copy and gives the copy its own baseline commit, so `patch defaults` shows only the D-repairs. The step is skipped when `changes.md` has no "New framework defaults" section, so it costs nothing for ordinary gems.

**Step 8: writer/reader matrix.** Cross-version compatibility of stored data (cookies, cache, signed messages, job arguments) was checked in the high runs with hand-written matrices that needed a shared `SECRET_KEY_BASE` and 4–8 debugging calls each (rails-v10-low S64–71, rails-v12-high S44–47, rails-v9-low S51–54). `matrix` runs the two scripts across all copy pairs with the lab's shared secret and prints one table. The model still writes the two scripts; the prompt gives their contract (write to `ARGV[0]`, print one line or `ERROR class: message`).

**Step 9: backport.** Whether a repair works on the current version decides the rollout order, and it was found only by making another copy and applying the patch by hand (rails-v9-low S46, rails-v10-low S74, rails-v12-low S46, rails-v12-high S33). Two repairs that look portable are not (`coder:` keyword, `show_exceptions :none`), and the grader counts the rollout consequence. `backport` makes a fresh copy at the current version, applies the patch minus the Gemfile bump, restores the original `load_defaults`, checks it and prints a verdict; `--each-file` isolates which file needs the upgrade. On this application `backport` correctly reports that the `coder:` form of `serialize` does not run on the old version (about 11 s).

**Step 10: gem source diff for single gems.** The author's manual procedure reads the commits for small gems. Commit subjects are in `changes.md`; `gem-diff` gives the actual source diff between the two installed versions (no network) so the model can read the part that implements what the application calls. Cheap, only for non-framework gems.

**Step 11 and the plan template.** The template is the structure of the best plan (rails-v12-high plan.md): Summary, Setup and evidence, Required changes, Default-related changes, Other gems that move, Rollout and rollback, Not verified. The "Rules for findings" keep the three prompt lines that raised scores most in the variant history (v6 consequence, v8 quoted error, v10 fails-without check with control) and add the two failure modes of the low runs: promoting untested claims (rails-v12-low stated two changelog entries as findings without a probe) and relabeling a failing test as a "product decision" (rails-v8-low).

## The scripts (bin/)

All three use only the Ruby standard library (`json`, `fileutils`, `open3`, `net/http`, `socket`, `securerandom`, `tmpdir`, `rubygems/package`).

### bin/gem-changes (extended)

Kept from v12: packaged changelogs of every intermediate release, lockstep component gems, release notes from gem metadata or GitHub releases, new framework defaults, textual matching to application code. Added:

- **Where this application uses GEM**: the Gemfile line, requires, initializers and (for single gems) which of the gem's top-level constants the application references. This was the model's first grep in every small-gem run (pagy-v12-high S2–S4, faraday-v12-high S2–S3).
- **Other gems that move with this bump**: a dry `bundle lock --update GEM --conservative` in a shadow directory, reporting each gem as MAJOR / new / removed, and naming gems that replace a Ruby default gem (json, bigdecimal, …). The moved `json` was the costliest single finding in the traces and the old script never mentioned it. Changelogs of up to 8 MAJOR/new gems are summarized in the same run.
- **Upgrade guide sections**: files named like `upgrading`, `migration`, `breaking` in the gem's repository, split by heading, versioned by the nearest heading, matched to application identifiers. faraday-v12-high found `UPGRADING.md` by hand at S5–S6; the old script ignored it.
- **Commits between tags**: the compare API with v-, plain and gem-prefixed tag guesses; the full list for ≤80 commits (the author's "commit by commit" for small gems), filtered subjects up to 250, count and link beyond that.
- **Matcher**: a single leading `:` is allowed (`:retry`, `:basic_auth` were missed before), plain words also match as a macro call at the start of a line or ERB tag (`enum ...`, `serialize ...`, `get "/path"`; `enum` with keyword arguments was missed before), plain-text entries without backticks are tokenized by symbols and snake_case words ("Remove dependency on logger" now lands in the dependency section), HTML comments are stripped, and the plain-word file limit is one tenth of the source files (was 2 files) so a macro used in three models still matches.

Measured on this application: pagy 8.6.3→9.3.5 4.8 s; faraday 1.10.4→2.12.2 10.8 s (flags json/net-http/uri as moved gems, matches `:retry` and `:basic_auth`, 3 UPGRADING sections); concurrent-ruby 1.3.4→1.3.8 lists 46 commits; rails 7.0.8.7→8.1.0 ~10–19 s, 143 KB, 145 strong and 92 weak matches, 20 upgrade-guide sections, 23 dependency changes. GitHub responses are cached under `~/.cache/gem-changes`, and `GITHUB_TOKEN` is honored.

### bin/upgrade-lab (new)

`start`, `check`, `copy`, `run`, `patch`, `backport`, `matrix`, `gem-diff`, `status`, `stop`. The design decisions, each traceable to a trace accident: private PostgreSQL via `initdb`/`pg_ctl` on a free port and a private Redis daemon (concurrent-ruby never tested; rails-v12-high S6); database names rewritten per copy with host/port, roles created for `username:` entries, dotenv service variables disabled (rails-v10-high/v12-high S58); copies made with `git clone` plus the uncommitted patch and untracked files, then a baseline commit so `patch` is a plain `git diff` (rails-v12-high S39–41); `mise trust` run for every copy; `bundle update GEM --conservative`; `check` always writes `summary.md`, `results.json`, `failures.json` and one log per step, caps the listed tests per error at 5, and runs the tests with `BACKTRACE=1` so gem frames are visible (rails-v9-low S21). Services restart automatically on any later command, so a paused orb does not break the lab.

Measured on this application: `start rails 8.1.0` 33.5 s including both first checks; `check` 6–12 s; `copy defaults` + check ~15 s; `backport` ~12 s; `matrix` 4.5 s. A full walk of the repair loop against the Rails bump (initializer, enum form, route with two paths, `serialize` coder, moved json) converged check by check, with each summary naming the next call site and the "newly passing" count moving.

### bin/lib/gem_upgrade.rb

Shared by both scripts: Gemfile bump, lock parsing and lock diff with the same wording in `gem-changes` and in `lock-diff.md`, default-gem version lookup, and a command wrapper.

## Expected effect

- Cost: the setup and re-check work is 30–45 of the 61–82 calls in the Rails runs. With the scripts, a Rails run should need roughly 25–35 model calls (two script runs, six reads of `changes.md`, about 10 repair iterations of two calls each, a handful of probes, backport, plan). The reads are of pre-digested summaries rather than raw test output, so the tokens per call also fall. Small gems should finish in under ten calls.
- Quality: the findings that only the best runs reached (moved default gems, defaults copy, backport portability, rollback matrix) are now steps with commands, not optional ideas, so the low end of the score range should rise toward the high end. Scores above the current best depend on the model's reading of `changes.md`, which the numbered list in step 3 is meant to make dependable.
- Smaller models: every step says which file to read and which command to run next, every loop has a cap, and the plan is assembled from `notes.md` rather than from memory.

## Risks

- `upgrade-lab` assumes PostgreSQL and (optionally) Redis, `config/database.yml` with per-environment names, and `bin/rails`. Applications configured only through `DATABASE_URL`, with several databases, or with other services (Elasticsearch, Sidekiq Pro) need the model to fall back to manual setup; the prompt sends such failures to "Not verified" rather than stopping.
- `assets:precompile` needs the application's JavaScript toolchain; the step is skipped when there is no `app/assets`, but a Node-based pipeline can fail for environment reasons and the model may chase it. The `base` check shows the same failure, and `check` marks errors that also occur on `base`.
- `gem-changes` makes GitHub API calls without a token (60/hour). Rails needs about 20 on a cold cache. Responses are cached, and a rate-limit error degrades to "Comparison unavailable" with a link.
- Textual matching still produces noise (92 weak matches for Rails) and still misses changes described without identifiers; the probes in step 6 and the "Removals with no textual match" greps are the mitigation, and both are capped.
- The commit list is capped at 250 subjects; for large gems the model only sees the filtered subset.
- `backport --each-file` runs one check per changed file; for a bump with many repaired files this is minutes, which is why it runs only when the plain backport fails.
- `matrix` still needs the model to write a correct writer and reader; a wrong script produces a table of errors that could be misread as a finding. The prompt's contract (last line is the result or `ERROR class: message`) and the base/base control cell are the defence.
- A small model may treat each distinct test error as a separate finding when they share one cause (the eager-load failure makes every test error in the same way). The prompt orders the steps (eager load before tests) and the summary groups tests by error to counter this, but the cap of 12 checks is the real protection.
