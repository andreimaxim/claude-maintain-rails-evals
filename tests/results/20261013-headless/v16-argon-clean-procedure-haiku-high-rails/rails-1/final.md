The app now runs on Rails 8.1.0. The test suite passes (46 runs, 340 assertions, 0 failures, 0 errors), up from 46 runs and 325 assertions on 7.0.8.7 before. I haven't committed anything.

I pinned exactly `8.1.0` as you asked, though the registry's latest 8.1 is 8.1.4. I kept `load_defaults 7.0` because the upgrade doesn't authorize changing framework defaults. Moving to 8.1 defaults is a separate step.

**Dependency changes**
- `Gemfile`: `rails` is now `8.1.0`. Rails 8.1 pulled in newer versions of the Rails family, `bigdecimal`, `drb`, `rackup`, `uri`, and related gems.
- `json` is pinned to `2.7.2`. ActiveSupport 8.1.0 calls `JSON.parse` with a positional options hash, which `json` 3.x rejects, so every cookie-backed request failed. I didn't check whether a later 8.1.x removes the need for this pin.
- The Minitest 5.x pin stays, with its comment corrected. Minitest 6 is unverified with 8.1, not blocked by it.

**Code changes needed for 8.1**
- `config/routes.rb`: `/notes` and `/journal` are now two `get` lines, since 8.1 rejects multiple paths in one call.
- `app/models/note.rb`: `enum` and `serialize` use the 8.1 signatures. `alias_attribute` on a `store_accessor` became `alias_method`, which 8.1 requires.
- `app/models/note.rb`: reminders pass `Time.at(epoch)` to `set(wait_until:)`, since 8.1 requires a Time there.
- `app/models/export.rb`: `fragments.sum` on strings became `join`.
- `config/initializers/action_text.rb`: the allowlist is set explicitly, since 8.1 no longer has a default to extend.
- `config/environments/test.rb`: `show_exceptions = :none`. In 8.1, `false` no longer means "raise".
- `Rails.application.secrets` is replaced by `config_for(:secrets)` in a new initializer, which exposes `config.x.citation_provider`.
- `app/controllers/notes_controller.rb`: `where(notebook:)` replaces a table-name key that 8.1 no longer resolves.
- `app/models/import.rb`: `apply` uses `raise ActiveRecord::Rollback`, not `return`. The old form committed the partial batch on 8.1. The receipt uses `citation&.doi`.
- `app/views/imports/preview.html.erb`: `stringify_keys` turned the integer line keys into strings, so annotations stopped matching.
- `app/views/notes/index.html.erb`: `form_with(model: nil)` became `form_with(url:)`.
- `app/jobs/citation_enrichment_job.rb`: `:exponentially_longer` is now `:polynomially_longer`. It's the same formula, which Rails renamed.

**Decisions to check**
- **Trix:** Action Text 8.1 bundles Trix 2.1.19. I replaced the vendored Trix 1.3.5 with the gem's `trix.js` in the layout and deleted the vendored copy. The fix it existed for is in 2.x. There's no browser or Chrome here and no system tests, so editor behavior is unverified. The `details`/`summary` note in `ARCHITECTURE.md` now says so.
- **Digest:** 8.1 restores the request time in the reader's offset instead of UTC. `DigestMailer` now converts to UTC explicitly, which keeps the documented UTC-day behavior.
- **Reminder preview:** `next_day_reminder_at` now builds a fixed-offset time explicitly. Without that, the preview's offset shifts across the DST change, which the docs say it shouldn't.
- **Highlight radios:** `alias_method` doesn't remap error keys the way `alias_attribute` did. An invalid color submitted through the form no longer wraps the radio buttons in `field_with_errors`. The error messages themselves are unchanged.

**Docs updated:** `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `config/secrets.yml`, `docs/references/fizzy.md`, `docs/guides/controllers.md`.

**Checked:** `bin/rails zeitwerk:check` passes, the test log has no deprecation warnings, the layout serves Trix 2.1.19, and development eager-loads. I didn't boot production, since it needs credentials this environment doesn't have.