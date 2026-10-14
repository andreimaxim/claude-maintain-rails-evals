# Rails 7.0.8.7 → 8.1.0 upgrade plan for Margin Notes

Rails 8.1.0 does not boot with the app as it is today. After a set of repairs in a copy, the full test suite passes (46 runs, 0 failures). No application file was changed: `git status` in `/home/user/workspace/repo` is clean, and the tool confirmed the source hashes are unchanged. Ruby 3.3.6 already meets Rails 8.1's requirement (3.2 or newer).

**What the version checks showed:**
- **7.1.6, 7.2.4, 8.0.5.1 and 8.1.0:** every one fails at boot in `config/initializers/action_text.rb`.
- **7.0.10 (a patch release):** the digest test fails. The email subject says "October 04" instead of "October 05" (F16).
- **Repaired copy (`target_fix`):** boot, database setup, eager loading, routes and all 46 tests pass. 16 of 17 probe checks pass; the one failure is a deliberate check of the old query form (see F9).
- **Current version with the early fixes (`baseline_prep`):** all 46 tests pass on 7.0.8.7. The probe passes except the expected case of reading a job enqueued by unrepaired 8.1 code.

Keep `config.load_defaults 7.0` for the bump.

## Required changes

**Ship these on 7.0.8.7 first. Each one runs and passes on the current version.**
- **F1 – Rich text tags initializer:** in Rails 7.1+ `allowed_tags` starts as `nil`, so `+=` crashes boot (`undefined method '+' for nil`). Build the list from the effective default inside `ActiveSupport.on_load(:action_view)`, then add `details summary`.
- **F2 – `Rails.application.secrets` removed (7.2):** the citation lookup job would raise `NoMethodError`, which the job's retry handling doesn't catch, so citations stay pending. Move the settings to `config/citation_provider.yml`, load them with `config_for`, and read `Rails.configuration.x.citation_provider` in the provider and the test harness.
- **F3 – Enum syntax:** in `note.rb:10`, write `enum :status, {…}, prefix: true` instead of the keyword form.
- **F5 – Highlight color alias:** `alias_attribute :highlight_color, :color` now raises because `color` is a store accessor. Use a pair of `alias_method` lines.
- **F6 – Routes:** the line drawing both `/notes` and `/journal` must become two `get` lines. Route names stay `notes` and `journal`.
- **F9 – Notebook filter:** `where(notebooks: …)` becomes `where(notebook: …)`. Otherwise filtering the notes list gives `PG::UndefinedColumn`.
- **F10 – Search form:** `form_with(model: nil, …)` raises. Drop `model: nil`.
- **F11 – Reminders:** `set(wait_until: reminder_epoch)` becomes `set(wait_until: Time.at(reminder_epoch))`. Otherwise scheduling raises `undefined method 'utc' for an instance of Integer`.
- **F12 – Exports:** `fragments.sum` becomes `fragments.join`. Otherwise every export job fails with `TypeError`.
- **F13 – Import preview:** remove `.stringify_keys` in `imports/preview.html.erb`. Without this, annotations silently disappear from the preview.
- **F14 – Imports that should save nothing:** a `return` inside a transaction now commits. An invalid import saved some rows (counts went from [1,5,1] to [2,6,2]). Use `raise ActiveRecord::Rollback` instead.
- **F15 – Import receipt CSV:** `citation[:id]` now returns empty because citations are keyed by DOI. Use `citation&.doi`.
- **F16 – Digest day:** jobs now keep the reader's time zone, so the digest covers the reader's local day instead of the documented UTC day. Use `params[:requested_at].utc` in `DigestMailer`. This also fixes the 7.0.10 failure, so ship it before any patch bump.
- **F17 – Reminder display across daylight saving:** the "24 hours later" time showed `08:00-05:00` instead of the documented `09:00-04:00`. Use `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)`.

**Ship these together with the version bump. They need the new Rails, or were not tested on 7.0.**
- **F4 – Tags column:** `serialize :tags, coder: JSON`. The old positional form raises `ArgumentError` on 8.1. Also add `coder: YAML` to `preferences`. Stored bytes read back the same in both directions.
- **F7 – json gem:** upgrading resolves json 3.1.0, which Rails 8.1.0 can't use (`ArgumentError` when reading JSON data), so note pages, uploads and exports fail. Add `gem "json", "~> 2.7"`; it resolved to 2.21.2.
- **F8 – Test config:** `show_exceptions = :none` in `config/environments/test.rb`. With the old `false`, six "not found" tests stop raising.
- **F18 – Citation retry:** `retry_on wait: :polynomially_longer` instead of `:exponentially_longer`. The failure without this change comes from reading the Rails source, not from a separate run.

## Rollout risks
- **F19 – Digest jobs during a mixed deploy:** a job enqueued by 8.1 with a BigDecimal argument cannot be read by a 7.0 worker. It fails with "BigDecimalSerializer is not known" and the digest is never sent. The fix is to pass `reading_completion.to_s` from `User#request_digest`; with that, both versions read each other's jobs.
  - Deploy order: ship this on 7.0 first, then drain the queues, then deploy 8.1.
  - Rollback order: roll back the code before the workers, and drain the default queue before rolling workers back.
- **F20 – Sidekiq adapter:** the built-in Sidekiq adapter still works on 8.1.0 with Sidekiq 6.5.12, but prints a deprecation warning (it is removed in 8.2). Upgrade Sidekiq to 7.3.3 or later separately, before Rails 8.2.

## Optional defaults (keep them off for the bump)
Three newer defaults broke current code when I turned them on in a separate copy:
- **F21 – `postgresql_adapter_decode_dates`:** the activity report raises `TypeError`.
- **F22 – `raise_on_assign_to_attr_readonly`:** saving notebook settings raises `ReadonlyAttributeError: slug`.
- **F23 – `raise_on_invalid_cache_expiration_time`:** expired exports raise "cannot be negative".

The other 33 defaults each have a recorded decision in `plan.json`. Values observed on 8.1:
- **Kept on both versions:** cache format 7.0, cookies serialized as `:json`, YAML as the column default.
- **Changed in 8.1:** jobs enqueue inside the transaction (`enqueue_after_transaction_commit` is false), and the time-zone setting is ignored. The message serializer and cache format 7.1 changes need to be adopted in a later, separate deploy.

## Not checked, and gaps in the sources
- System tests (they need Chrome and a display), a production-mode boot, a live Sidekiq worker, and exchanging cookies or cache entries between 7.0 and 8.1.
- The F4 `coder:` form and the F7 json pin were not run on 7.0.8.7.
- The upgrade was not stepped through 7.1, 7.2 and 8.0 in sequence; each version was checked in its own copy.
- The Rails commit lists were only searched by keyword, so they are marked unknown. The json 3.x changelog was not collected.
- The tool noted that the 7.0.8.7 release tag is not an ancestor of the 8.1.0 tag, and likewise for uri. The endpoint diff was not read in full.
- Passing the existing tests alone does not prove the upgrade is safe; the findings above rest on the specific checks listed.

## Files
- Full rendered plan (all fields, run records and default decisions): `/tmp/gem-upgrade-20261014-71563-xsefts/plan.md`
- Plan data with source dispositions: `/tmp/gem-upgrade-20261014-71563-xsefts/plan.json`
- Repaired 8.1.0 copy: `/tmp/gem-upgrade-20261014-71563-xsefts/variants/target_fix/app`
- Early fixes on 7.0.8.7: `/tmp/gem-upgrade-20261014-71563-xsefts/variants/baseline_prep/app`
- Load-only 8.1 copy used for comparison: `/tmp/gem-upgrade-20261014-71563-xsefts/variants/target_min/app`
- Defaults experiment: `/tmp/gem-upgrade-20261014-71563-xsefts/variants/target_defaults/app`
- Probes: `/tmp/gem-upgrade-20261014-71563-xsefts/probe.rb`, `/tmp/gem-upgrade-20261014-71563-xsefts/probe_serialize.rb`, with job payloads exchanged between versions in `/tmp/gem-upgrade-20261014-71563-xsefts/probe-data/`
- Run logs and records: `/tmp/gem-upgrade-20261014-71563-xsefts/runs/`
- Sources: `/tmp/gem-upgrade-20261014-71563-xsefts/sources/index.md`, `/tmp/gem-upgrade-20261014-71563-xsefts/dependencies-target/index.md`

The lab's databases have been removed; the copies and logs are kept.

---

I haven't changed the app yet. The upgrade skill I ran only produces a plan, so `git status` in your repo is still clean. Upgrading straight to 8.1.0 would break the app, because it fails at startup. My recommendation is to do it in two steps:

1. Ship F1–F3, F5, F6, F9–F17 and F19 on Rails 7.0.8.7. They all pass the tests on the current version.
2. Then bump to 8.1.0 together with F4, F7, F8 and F18, keeping `load_defaults 7.0`. Deploy only after the job queues have drained.

Should I start on step 1 in a branch?