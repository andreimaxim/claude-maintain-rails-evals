# Audit execution record

Audit date: 2026-10-19 UTC. Repository snapshot: [ab732f5](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7).

## Resource isolation and variants

All execution below occurred in `/tmp/margin-notes-rails-audit-Opyjfm` or its `baseline` child, created with `mktemp -d /tmp/margin-notes-rails-audit-XXXXXX` and populated with `git archive HEAD | tar -x -C "$copy"`. No untracked secrets, runtime DB files, uploaded files, or cached application state were copied. The disposable tree was removed after retaining this evidence.

No experiment had access to the application's DB or Redis:

```sh
export DATABASE_URL=postgresql://127.0.0.1:1/rails_audit_no_access
export REDIS_URL=redis://127.0.0.1:1/15
```

These URLs deliberately select an unavailable loopback port, not the app's localhost service. No database or Redis instance was provisioned; no test schema, queue or reservation was created. No network-bound job/provider behavior was executed. Framework probes load gems, not application configuration. The single application boot used `RAILS_ENV=test`, a null cache and Disk root under the disposable copy's `tmp/storage`; copied checkout `tmp`, logs, file-store, mail output and uploads were not shared with the working checkout. The target bundle was installed only under the disposable tree. Baseline probe used the already-installed gems selected by the unchanged baseline lock, without installing into that bundle.

### Target variant

Only change to copied application: `gem "rails", "8.1.0"` replaces `7.0.8.7`; dependency lock resolved accordingly. All app code/config/defaults unchanged (`load_defaults 7.0`). `Gemfile.target`, `Gemfile.target.lock`, `application.baseline.rb` and `test.baseline.rb` retain input. Ruby 3.3.6, Bundler 2.5.22; resolved Rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, Sidekiq 6.5.12, redis 4.8.1, Puma 5.6.9, pg 1.6.0, concurrent-ruby 1.3.4, bigdecimal 4.1.3, json 3.1.0, action_text-trix 2.1.19. Full dependency versions are in the lock and probe output.

### Legacy-reader variant

Unmodified tracked application/Gemfile/lock in disposable `baseline` child; no Rails application boot. `Gemfile.baseline`, `Gemfile.baseline.lock`; Ruby 3.3.6, Bundler 2.5.22, Active Job/Support 7.0.8.7, Ruby default BigDecimal 3.1.5. Full activated gem set recorded in `legacy-reader-probe.log`. Simulated serialized arguments are visible in retained source and output, use only synthetic times/decimals, and contain no record IDs or secrets.

## Commands and outputs

The following commands ran from their indicated disposable working directory, with the fail-closed URL exports above. `mise exec --` selected the repository-pinned Ruby.

### Dependency resolve — target directory

```sh
BUNDLE_APP_CONFIG="$copy/.bundle" mise exec -- bundle lock --update rails
```

Exit 0. `bundle-lock-target.log`, `bundle-lock-target.exit`, `Gemfile.target.lock`. No application boot/service access. Do not infer Rack 3 or a Sidekiq upgrade is forced by Rails 8.1.

### Dependency installation — target directory

```sh
BUNDLE_APP_CONFIG="$copy/.bundle" BUNDLE_PATH="$copy/bundle" \
  mise exec -- bundle install --jobs 4
```

Exit 0. `bundle-install-target.log`, `bundle-install-target.exit`. Installed target bundle outside the working application. Retained lock is the final installed resolution.

### Framework API probe — target directory

```sh
BUNDLE_APP_CONFIG="$copy/.bundle" BUNDLE_PATH="$copy/bundle" \
  mise exec -- bundle exec ruby framework-probe.rb
```

Script retained as `framework-probe.rb`; stdout/stderr `framework-probe-target.log`, exit file `framework-probe-target.exit` (0). Each probe catches/prints errors so a zero script exit does NOT mean the probed behavior all succeeded. Exact observed outcomes:

- String fragments `.sum`: TypeError; `.join`: expected two-heading Markdown.
- Exact app multi-path route declaration: ArgumentError.
- Old time payload: UTC date October 5; new zone-carrying payload: Eastern date October 4, same instant.
- Old decimal-string payload/new BigDecimal envelope: both load in target and convert through `BigDecimal(...)`.
- Fall-back DST `to_time + 86400`: November 1 08:00 −05:00; fixed-offset conversion: November 1 09:00 −04:00.
- Active Job class-level enqueue-after-commit default: false (framework default, not a full production config inspection).
- Integer wait_until serialize: NoMethodError (`utc` on Integer); Time wait_until serialize: exact ISO8601 timestamp `2026-10-31T13:00:17.000000000Z`.

This probe was extended once to add the two reminder-scheduling cases and rerun; retained script/log are the final matching pair, same target dependencies/config, no application changes.

### Unchanged application boot — target directory

```sh
RAILS_ENV=test BUNDLE_APP_CONFIG="$copy/.bundle" BUNDLE_PATH="$copy/bundle" \
  mise exec -- bin/rails runner 'puts "BOOT_OK"'
```

Exit 1. `boot-target.log`, `boot-target.exit`; copy-local Rails log files retained under `target-rails-log/`. Failed at `config/initializers/action_text.rb:3`, nil `allowed_tags +` (NoMethodError). No `BOOT_OK`. No attempt to patch past this first boot blocker or start the application's services was made.

### Legacy reader — disposable baseline directory

```sh
BUNDLE_APP_CONFIG="$copy/baseline/.bundle" \
  mise exec -- bundle exec ruby legacy-reader-probe.rb
```

Exit 0 with caught behavioral failure. Final `legacy-reader-probe.rb`, `legacy-reader-probe.log`, `legacy-reader-probe.exit`. 7.0.8.7 rejects the new BigDecimal serializer with `ActiveJob::DeserializationError`; replacing only decimal envelope with a string lets it decode successfully and yields UTC October 5. This proves both mixed-version serialization incompatibility and backward compatibility of the proposed string argument at this boundary, not job execution/mail delivery.

Initial attempt omitted `require "active_job/arguments"`, which Rails 7.0 does not eagerly load through `require "active_job"`. It therefore only reported NameError for ActiveJob::Arguments and was not behavioral evidence. Retained initial source/log: `legacy-reader-probe-initial.rb`, `legacy-reader-probe-initial-load-error.log`. Diagnosed and added that explicit require, then reran the final probe above.

## Source provenance / reproduction

Full Rails 8.1.0 source was fetched without executing it:

```sh
curl -fsSL https://codeload.github.com/rails/rails/tar.gz/refs/tags/v8.1.0 \
  -o /tmp/rails-v8.1.0-audit.tar.gz
tar -xzf /tmp/rails-v8.1.0-audit.tar.gz -C "$artifacts/sources"
```

Older files under `sources/rails-VERSION/` were fetched from:

```text
https://raw.githubusercontent.com/rails/rails/vVERSION/PATH
```

Versioned configuration files at each older source directory's root (`configuration.rb`) come from `railties/lib/rails/application/configuration.rb`. Other retained files retain their upstream paths. Their version directories are 7.0.8.7, 7.1.0, 7.2.0, 8.0.0, 8.1.0. `sources.sha256` identifies all retained source bytes. Public web upgrade/release guides were read at the v8.1.0 URLs cited in PLAN.md. Artifact source includes tagged documentation and tests as reference, not tests run against Margin Notes.

To reproduce, recreate the archived copy, copy the retained target Gemfile/lock and probe scripts, apply the exports above, then run the commands. For baseline, restore baseline Gemfile/lock and an independent bundle selection; do not point baseline BUNDLE_PATH at the target-only bundle. No full-test resources are configured by these commands: provision uniquely named DB/private Redis and copy-local storage/cache before expanding the tests.

## Not executed

No application test suite, browser workflow, asset build, DB migration/schema load, Redis/Sidekiq consumer, concurrency experiment, live token-rotation experiment, mail delivery or deployment. Those are proposals in PLAN.md, not passed checks. Working-tree app/dependency diff is empty in `application-diff-after-audit.txt`.
