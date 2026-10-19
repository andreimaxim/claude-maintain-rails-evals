# Executed commands and isolation

Source: git archive HEAD from /home/user/workspace/repo at [the inspected revision](https://github.com/andreimaxim/claude-maintain-rails-sample/commit/ab732f534dce525ae70f1d31aac6908a1ab3d8f7).
Disposable workspace: /tmp/rails-810-review. All Ruby commands use `mise exec ruby@3.3.6 --` (Bundler 2.5.22).
No Rails test suite or browser tests executed. No full upgraded app was made runnable.

## Isolation

- PostgreSQL: created only `rails810_review_850f_baseline` and `rails810_review_850f_target` using `createdb`. Probes connect through DATABASE_URL, assert this prefix, and create only `probes` and `probe_citations` inside those disposable databases. SQL is logged in `sql-*.log`.
- Queue: Active Job test adapter and Sidekiq fake mode, process-local. REDIS_URL always points at `redis://127.0.0.1:16389/0`, not the working application's Redis. No real Redis operations or workers were exercised; no Redis service was started.
- Cache: FileStore under `/tmp/rails-810-review/cache/{baseline,target,target-json2}` or process-local MemoryStore.
- Storage: disposable checkout Disk roots; framework probes never create blobs. No shared files or credentials were copied. Boot uses a synthetic SECRET_KEY_BASE. No app databases/queues/storage touched.
- Framework probes require rails/all but do NOT initialize MarginNotes. They reproduce the actual application expressions against isolated test tables. Defaults are explicitly shown in probe.rb; they are NOT a substitute for running the application with every initializer.

## Dependency resolution and boot

In app-copy, change ONLY Gemfile rails pin 7.0.8.7 -> 8.1.0, retaining every other constraint and starting from the original lockfile:

```
mise exec ruby@3.3.6 -- bundle lock --update rails
BUNDLE_PATH=/tmp/rails-810-review/bundle mise exec ruby@3.3.6 -- bundle install
RAILS_ENV=test SECRET_KEY_BASE=rails810-disposable-not-a-real-secret \
 DATABASE_URL=postgresql:///rails810_review_850f_target REDIS_URL=redis://127.0.0.1:16389/0 \
 BUNDLE_PATH=/tmp/rails-810-review/bundle mise exec ruby@3.3.6 -- bundle exec rails runner 'puts Rails.version'
```

Logs: resolution-original-pins.log, install-original-pins.log, target-unmodified-boot.log.
Boot exited 1 at config/initializers/action_text.rb:3. Resolution/install succeeded.
Gemfile.target-original-pins and Gemfile.lock.target-original-pins describe the exact resolved target, including json 3.1.0.
Gemfile and Gemfile.lock are the original baseline.

## Probes

`bash evidence/run-probes.sh` executed the baseline, target, and baseline consuming the target payload.
Output: probe-7.0.8.7.log, probe-8.1.0.log, probe-7.0.8.7-with-new-payload.log. Every check rescues and reports its exception; process exit 0 does NOT mean all checks passed.
`PROBE_TRACE=1` on the target isolated the unexpected JSON parser failure; see probe-8.1.0-diagnostic.log. The initial script/output are preserved separately.

A second target Gemfile adds `gem "json", "< 3"`. Initially its named lockfile was misplaced, so the first install re-resolved unrelated gems; that exploratory result is retained as Gemfile.target-json2.initial.lock and install-json2-initial.log and is NOT the final comparison. The target lockfile was then seeded correctly:

```
cp evidence/Gemfile.lock.target-original-pins evidence/Gemfile.target-json2.lock
BUNDLE_PATH=/tmp/rails-810-review/bundle BUNDLE_GEMFILE=/tmp/rails-810-review/evidence/Gemfile.target-json2 \
 mise exec ruby@3.3.6 -- bundle update json
RAILS_ENV=test DATABASE_URL=postgresql:///rails810_review_850f_target \
 REDIS_URL=redis://127.0.0.1:16389/0 CACHE_ROOT=/tmp/rails-810-review/cache/target-json2 \
 BUNDLE_GEMFILE=/tmp/rails-810-review/evidence/Gemfile.target-json2 BUNDLE_PATH=/tmp/rails-810-review/bundle \
 mise exec ruby@3.3.6 -- bundle exec ruby evidence/probe.rb
```

The final json2 lock differs only by json 3.1.0 -> 2.21.2 and the new Gemfile constraint. Final output: probe-8.1.0-json2.log. This final run includes the readonly-slug probe appended last.
Re-ran baseline with new/normalized payloads using the same baseline environment in run-probes.sh; log probe-7.0.8.7-with-new-payload.log.

`defaults-probe.rb` was run using both baseline and target Gemfiles with RAILS_ENV=test, same mise/Bundler prefixes. It does not connect to services. Logs defaults-7.0.8.7.log and defaults-8.1.0.log. It inspects Configuration#load_defaults and exception mode APIs without Rails initialization (so the :rescuable result is not an application-level 404 check).

Source downloads used `curl -fsSL https://raw.githubusercontent.com/rails/rails/vVERSION/PATH` for version-tagged changelogs and relevant implementations. Their directory tree is retained under upstream. The human-readable upstream upgrade guide was also read at https://guides.rubyonrails.org/v8.1.0/upgrading_ruby_on_rails.html.

No private data or production configuration was sampled. Only synthetic rows, payloads, and test credentials appear in evidence.

Cleanup: both disposable databases dropped after final probes; no service was started. Disposable checkout, bundle, caches and scripts were removed after preserving evidence.
