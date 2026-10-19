# Rails upgrade experiment evidence

Application revision: https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7

Evaluated on 2026-10-19 with Ruby 3.3.6, Bundler 2.5.22, Linux x86_64.
No application boot, database query, real queue operation, mail delivery, or application test suite was run.

## Variants

- `baseline/`: unchanged application Gemfile/lock, Rails 7.0.8.7. Ruby's default JSON/BigDecimal were available (not direct dependencies in this lock).
- `target/`: copied Gemfile/lock; only Rails changed to 8.1.0; `bundle lock --update rails`. Resolved JSON 3.1.0. Resolver output in `target/bundle-lock.log`; exit 0.
- `target-json2/`: target plus `gem "json", "< 3"`, resolved with `bundle update json` to JSON 2.21.2. Output `probes/json2-bundle-update.log`; exit 0.
- `probes/`: full script, driver, commands/context, JSON argument fixtures, synthetic signed messages, and output logs. Log lines list the activated gem versions. These framework probes print observed values/errors; exit 0 does NOT mean a test suite passed.

## Isolation and original commands

Original work directory for probes was `/home/user/workspace/repo/.amp/in/rails-upgrade-lab/app-copy`, created with `git archive HEAD | tar -x` into that disposable directory. The copied app was **not booted**. `probes.rb` loads framework libraries, not `config/environment.rb`; its only application code execution loads the copied Action Text initializer. No service connection was attempted. In-process MemoryStore instances are private to the probe. No Active Storage service or mailer is initialized. Database and Redis URLs in the driver point to loopback port 1 to fail closed; copied disk storage/cache/log locations are under the disposable root. Downloads/gem installation used a private GEM_HOME; the existing gem directory was only read through GEM_PATH.

Original resolution command (repository cwd):

```sh
BUNDLE_GEMFILE="$PWD/.amp/in/rails-upgrade-resolution/Gemfile" mise exec -- bundle lock --update rails
```

Installation and probe commands, with complete GEM_HOME/GEM_PATH and service guards, are in `probes/context.txt` and `probes/run-probes.sh`. The JSON decode failure was isolated with:

```sh
bundle exec ruby -ractive_support/all -e 'puts "AS=#{ActiveSupport::VERSION::STRING}, JSON=#{JSON::VERSION}"; p ActiveSupport::JSON.decode(%q({"value":1}), symbolize_names: true)'
```

That command used the target Gemfile/GEM_HOME/GEM_PATH from the context, exited 1, and wrote `probes/json-decode.log`. The target JSON 3.1.0 run failed `ActiveSupport::JSON.decode` on its positional options argument. The JSON 2.21.2 variant successfully read old and new message envelopes.

The first target probe stopped at a missing explicit `active_support/message_verifier` require in the probe harness; retained as `probes/probes-8.1-initial-missing-require.log`. That is a harness issue, not an application failure. The require was added before subsequent runs.

The driver was then rerun with `BUNDLE_GEMFILE=<lab>/Gemfile-json2` for the constrained variant, followed by the unchanged baseline reader. The final script additionally writes a target legacy-profile message (`serializer: :marshal`, metadata flag false). Outputs: `probes-8.1-json2.log` and `probes-7.0-cross-read.log`. Earlier JSON-3 logs predate that final supplemental legacy-profile probe; all other probes are unchanged.

## Reproduction

Reconstruct a fresh disposable checkout of the revision above and the lab directory layout in the driver. Use the preserved Gemfiles/lockfiles; do not re-resolve them if reproducing these results. Install to a disposable GEM_HOME. Copy `probes/` to the driver's evidence path, adjust only the root paths in the driver, and run from `app-copy`. Keep `config.load_defaults 7.0` in the copied app; the probes themselves do not initialize Rails defaults. They explicitly set Time.zone=UTC and the 7.0 `to_time` flag, and test the negative-TTL raising flag and new message settings separately.

No real credentials are present in these artifacts. The verifier key and message data are deliberately synthetic.

Supplemental `probes/runtime-and-scheduling.log` records default-library versions omitted from the baseline lock: JSON 2.7.2 / BigDecimal 3.1.5. Target uses BigDecimal 4.1.3 in both JSON variants. It also confirms that `Time.at(epoch).utc` yields scheduling epoch 1793451617 in all three variants (7.0 does not include `scheduled_at` inside its serialized Active Job envelope; the adapter carries scheduling separately).

Disposable source downloads, extracted upstream tree, application copy, and private gem installation were removed after collecting evidence. Preserve these artifacts; reconstruct the lab as above to rerun.
