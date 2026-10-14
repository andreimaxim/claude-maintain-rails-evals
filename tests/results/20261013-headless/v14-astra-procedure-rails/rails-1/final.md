I haven't upgraded Rails yet. The upgrade workflow only produces a plan, so the repository is unchanged. Here is the planner's plan as it reported it:

---

I've written the upgrade plan; nothing was changed in `/home/user/workspace/repo` (the lab's final check confirmed its source hashes are unchanged). The app can reach Rails 8.1.0 on its current Ruby 3.3.6. A copy with the changes below boots, prepares its database, loads all code, draws routes and passes all 46 tests at 8.1.0, and also at 7.1.6, 7.2.4 and 8.0.5.1. The browser tests and production behaviour were not run.

**Approach:** upgrade one minor version at a time (7.0.10, 7.1.6, 7.2.4, 8.0.5.1, 8.1.0) and keep `config.load_defaults 7.0` until everything is deployed.

Unchanged, the app breaks at each step: it won't boot from 7.1 (the Action Text initializer), and even 7.0.10 fails the digest test.

## Required changes (each failure reproduced in a copy, each fix checked)

| # | Where | What breaks | Fix | Can it ship on 7.0? |
|---|---|---|---|---|
| F01 | `config/initializers/action_text.rb:3` | 7.1+: app won't boot (`undefined method '+' for nil`) | Build the allowed-tags list inside `after_initialize`, starting from Rails' default | Yes |
| F02 | `config/secrets.yml`, `Citation::Provider`, citation test | 7.2+: `Rails.application.secrets` is gone, so citation lookups fail | Move the settings to `config/citation_provider.yml` and read them with `config_for` | Yes |
| F03 | Gemfile | 8.1 installs json 3.1.0, which breaks session cookies (`wrong number of arguments (given 2, expected 1)`); 42 of 46 tests errored | Add `gem "json", "~> 2.7"` (resolved to 2.21.2) | With the 8.1 step |
| F04 | `note.rb` enum | 8.0+: the Note model won't load | `enum :status, {…}, prefix: true` | Yes |
| F05 | `note.rb` `serialize :tags, JSON` | 7.2+: the Note model won't load | `serialize :tags, coder: JSON` | No, ship with the 7.1 step |
| F06 | `note.rb` `alias_attribute :highlight_color, :color` | 7.2+: error because `color` is a stored setting, not a column | Two `alias_method` lines | Yes |
| F07 | `export.rb:42` `fragments.sum` | 7.1+: every Markdown export fails with `TypeError` | `fragments.join` | Yes |
| F08 | `CitationEnrichmentJob` `retry_on wait: :exponentially_longer` | 7.2+: retries crash ("Couldn't determine a delay") | `:polynomially_longer` (same formula) | No, ship with the 7.1 step |
| F09 | `Import#receipt` `citation[:id]` | 7.2+: the receipt CSV loses every DOI | `citation&.doi` | Yes |
| F10 | `Import#apply` returns inside a transaction | 7.2+: a failed import still saves earlier rows (records went from `[0,3,0,1]` to `[1,4,1,2]`) | Explicit `raise ActiveRecord::Rollback` | Yes |
| F11 | `NoteReminderJob.set(wait_until: Integer)` | 7.2+: scheduling a reminder raises an error | `Time.at(reminder_epoch)` | Yes |
| F12 | `NotesController` `where(notebooks: @notebook)` | 7.2+: notebook filter gives a database error | `where(notebook: @notebook)` | Yes |
| F13 | `imports/preview.html.erb` `.stringify_keys` | 8.0+: annotations vanish from the import preview | Drop `.stringify_keys` | Yes |
| F14 | `Note#next_day_reminder_at` | 8.1: reminders near a daylight-saving change show 08:00-05:00 instead of 09:00-04:00 | `Time.at(epoch + 86_400, in: reminder_at.formatted_offset)` | Yes |
| F15 | `notes/index.html.erb` `form_with(model: nil` | 8.0+: the notes list (root page) errors | Remove `model: nil` | Yes |
| F16 | `routes.rb` `get "/notes", "/journal"` | 8.1: no routes load at all | Two separate `get` lines | Yes |
| F17 | `test.rb` `show_exceptions = false` | 7.1+: 8 tests that expect raised errors fail | `:none` | No, ship with the 7.1 step |
| F18 | `DigestMailer` | Already at 7.0.10: the digest covers the reader's local day ("October 04") instead of the UTC day ("October 05") | `requested_at.in_time_zone("UTC")` | Yes; ship before any bump |

## Deployment risks

- **F19 (queued digest jobs):** a 7.2+ server writes the digest's completion value in a format 7.0 workers can't read ("BigDecimalSerializer is not known"). I reproduced this with real Sidekiq 6.5.12 payloads.
  - **Fix:** queue `reading_completion.to_s` instead.
  - **Check:** with that change, old and new payloads were read correctly in both directions.
  - **Order:** ship this on 7.0 and let the queues drain before any server goes to 7.2, and don't upgrade workers ahead of web servers.
- **F20 (rich-text editor) — not tested:** Rails 8.1 ships its own Trix through a new gem, but the app loads its own `trix-1.3.5.js`. I couldn't run a browser, so whether the editor and attachments still work is unknown. Make `bin/rails test:system` plus a manual attachment upload a condition for releasing 8.1.
- **F21 (Sidekiq):** Rails' built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2. Keep Sidekiq 6.5.12 for this upgrade. Moving to Sidekiq 7.3.3+ later is a separate task, and its strict argument checking would reject `ExportJob`'s symbol-keyed options.
- **F22 (session cookies):** with the old defaults kept, cookies written by 7.0 read on 8.1 and the reverse. Don't adopt the 7.1 message-serializer defaults until no 7.0 servers remain. Local dev/test sessions reset once because Rails renames the secret file.

## Optional: adopting newer framework defaults (do after the upgrade)

I tried `load_defaults 8.1` in a separate copy:
- **F23:** `Notebook` `serialize :preferences` needs `coder: YAML`, otherwise the app fails to load.
- **F24:** three more failures. Updating a notebook raises because the form still sends the read-only `slug`. The exports page raises on a negative cache expiry for expired exports. The activity report breaks because PostgreSQL dates now come back as `Date`. The fixes are proposed but not run.
- `enqueue_after_transaction_commit` defaults to off in 8.1, so job enqueueing stays immediate, as it is today.

Every one of the 36 defaults has a recorded decision in the plan file.

## Rollout order
1. On 7.0: ship F01–F04, F06, F07, F09–F16, F18 and F19 together; this set is the `baseline_prep` copy, which passes all 46 tests on 7.0.8.7. Let the queues drain.
2. Move to 7.0.10, then 7.1.6 together with F05, F08 and F17.
3. Then 7.2.4, then 8.0.5.1 (setting `to_time_preserves_timezone = :zone` there removes a boot deprecation).
4. Then 8.1.0 together with the json pin (F03), gated on the browser check (F20).

## Gaps
- Browser tests, real Sidekiq worker processes, production configuration and asset precompilation were not run.
- Of the 235 source pages, 124 were reviewed, 85 are not applicable and 26 are unknown. The unknowns are mainly the Rails commit range (13,954 commits), which I searched for the app's identifiers rather than reading patch by patch.
- Job and cookie compatibility were checked with synthetic payloads and a throwaway secret, not production data.
- The 7.1–8.0 copies were checked before the final `.to_s` change in F19; only the 7.0 and 8.1 copies were re-run after it.
- One lab copy (`v8_1_0_fixed`) was abandoned after I mistakenly reset its Git index; it has no run records and isn't used as evidence.

Files are in /tmp/gem-upgrade-20261014-71510-yfl4az:
- `plan-final.rendered.txt` — the full plan, including the list of 160 runs
- `plan-final.json` — the plan with per-source review notes
- `target-repair.patch` — the full set of changes for 8.1
- `prep-on-7.0.patch` — the subset that ships on 7.0
- `probes/` — test scripts and their JSON results
- `runs/` — logs from every run
- `variants/` — the app copies used for testing

---

**My notes:**
- The current version is 7.0.8.7, so this is a jump of four minor versions. Changing the version number alone would leave the app unable to boot.
- To go ahead, I'd start with rollout step 1: apply `prep-on-7.0.patch` on a branch while staying on Rails 7.0.8.7, then do the version bumps one at a time. Should I start that, or apply the full `target-repair.patch` and go straight to 8.1.0?