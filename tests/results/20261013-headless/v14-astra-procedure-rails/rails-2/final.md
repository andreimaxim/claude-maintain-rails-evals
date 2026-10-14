I've planned the Rails upgrade but haven't changed your app yet. The upgrade skill only produces a plan, and the jump is big enough that it needs your go-ahead first. Here is the planner's report as written:

---

I've written the upgrade plan for Rails 7.0.8.7 to 8.1.0. I didn't change the application: the lab confirmed the source hashes are unchanged. Its databases have been cleaned up; the copies, logs and the lab's own Redis data are kept.

**Result.** Unchanged, the app stops booting from 7.1.6 onward. Even the 7.0.10 patch release breaks one test (the digest day). After 18 code changes, the repaired 8.1.0 copy passes boot, database setup, eager loading, routes and all 46 tests (340 assertions), keeping the current 7.0 framework defaults. Ruby 3.3.6 already meets the 8.x requirement (3.2 or later). Passing tests don't prove the upgrade is safe: two of the breakages below (F15 and F16) were missed or only partly caught by the suite and were found with targeted checks.

## Required changes
"Works on 7.0" means I applied the change to a copy of the current app and the suite and checks still passed there. Those can ship before the version bump.

| # | Where | What breaks on 8.1 | Fix | Works on 7.0? |
|---|---|---|---|---|
| F1 | `config/initializers/action_text.rb` | Boot fails with `undefined method '+' for nil` | Run it in `after_initialize`; start from `allowed_tags \|\|` the sanitizer's default tags plus `details summary` | yes |
| F2 | Gemfile | Resolution picks json 3.1.0; every JSON decode fails with `wrong number of arguments (given 2, expected 1)` | `gem "json", "< 3"` (resolved to 2.7.2) | ship with bump |
| F3 | `note.rb:10` | `enum` with keyword arguments was removed | `enum :status, {...}, prefix: true` | yes |
| F4 | `note.rb:12` | `serialize :tags, JSON` was removed | `serialize :tags, coder: JSON` | ship with bump |
| F5 | `routes.rb:18` | One route with two paths raises | Split into separate `/notes` and `/journal` lines (`/journal` gains the route name `journal`) | yes |
| F6 | `note.rb:14` | `alias_attribute` to a store accessor raises on any Note use | `alias_method` for the reader and the writer | yes |
| F7 | `config/secrets.yml`, `Citation::Provider`, the citation test | `Rails.application.secrets` was removed, so citation lookups fail | Move the file to `config/citation_provider.yml`, load it with `config_for` into `config.x.citation_provider` | yes |
| F8 | `config/environments/test.rb` | `show_exceptions = false` now means "show error pages", so tests expecting exceptions are silently weakened | `:none` | ship with bump |
| F9 | `CitationEnrichmentJob` | `:exponentially_longer` raises while retrying | `:polynomially_longer` | ship with bump |
| F10 | `Note#schedule_reminder` | An integer `wait_until` fails (`undefined method 'utc' for Integer`), so no reminders can be scheduled | `wait_until: Time.at(reminder_epoch)` | yes |
| F11 | `Export#generate` | Summing an array of strings raises `TypeError`, so every export fails | `fragments.join` | yes |
| F12 | `notes/index.html.erb:12` | `form_with(model: nil)` raises, breaking the notes list | `model: false` | yes |
| F13 | `NotesController#index` | `where(notebooks: ...)` causes a database error, so the notebook filter returns 500 | `where(notebook: ...)` | yes |
| F14 | `imports/preview.html.erb` | `stringify_keys` now converts the integer line keys, so annotations vanish from the preview | Drop `.stringify_keys` | yes |
| F15 | `DigestMailer` | Times passed to jobs now keep the reader's time zone, so the digest covers the local day, not the UTC day ("October 04" instead of "October 05"). Already broken on 7.0.10. | `requested_at = requested_at.utc` | yes |
| F16 | `Import#apply` | `return` inside a transaction now commits: a failed import leaves 1 import and 1 note saved. **The suite doesn't catch this.** | `raise ActiveRecord::Rollback unless rows.all? { ... }` | yes |
| F17 | `Import#receipt` | `citation[:id]` is now nil, so the DOI column of the receipt CSV is blank | `citation&.doi` | yes |
| F18 | `Note#next_day_reminder_at` | Across the end of daylight saving time, the shown postponement time becomes 08:00-05:00 instead of 09:00-04:00 (same moment, different display) | `Time.at(reminder_epoch + 86_400, in: reminder_at.formatted_offset)` | yes |

## Rollout risks
- **F19 – queued digest jobs.** On 8.1, decimal job arguments are written in a new format that 7.0 workers can't read (`Serializer ... BigDecimalSerializer is not known`). Fix: pass `reading_completion.to_s("F")` from `User#request_digest`. I checked both directions with the same saved payloads: 7.0 workers read 8.1 payloads after the fix, and 8.1 reads old ones. Deploy this before the bump.
- **F20 – Sidekiq.** Sidekiq 6.5.12 still works on 8.1 against the lab's Redis, but Rails now logs that its built-in Sidekiq adapter is deprecated and will be removed in 8.2. Plan a separate move to Sidekiq 7.3.3 or later. I did not check whether 7.0 workers can process the other 8.1 job payloads (reminders, citations), so drain or pause the queues during the switch.
- **F25 – don't stop at 7.2.** Rails 7.2 delays job enqueueing until the database transaction commits, which changes how `Citation#request_enrichment` behaves when an enqueue fails. 8.1 with the current defaults doesn't do this. This is from the changelogs only, not run.

**Deploy order:**
1. Ship all the "yes" changes plus F19 on 7.0 (all were run there except the F21–F23 default repairs).
2. In one deploy: the version bump with F2, F4, F8 and F9.
3. Adopt newer framework defaults later, separately.

Rolling back to 7.0 stays safe as long as you keep the 7.0 defaults: cache entries read both ways, and job payloads contain only strings.

## Optional defaults (switching to `load_defaults 8.1`)
I ran a separate copy with all 8.1 defaults on. It needs these fixes first:
- **F21:** the activity report raises a `TypeError` once PostgreSQL dates come back as `Date` objects.
- **F22:** notebook settings raise `ReadonlyAttributeError` on `slug`.
- **F23:** the exports page raises on a negative cache expiry once an export has expired.
- **F24:** `serialize :preferences` needs `coder: YAML`.

The F24 fix was run; the F21–F23 fixes are proposed only. Postpone the cookie, message and cache format defaults until you no longer need to roll back to 7.0. Every default has a recorded decision in `plan.json`.

## Gaps and what wasn't run
- I didn't read the full 13,954-commit Rails range; those coverage rows are marked unknown. The lab also flagged that the 7.0.8.7 tag isn't an ancestor of 8.1.0, so commits unique to the 7.0 branch weren't separated out.
- System tests (Selenium with Chrome) were not run.
- My encrypted session cookie check was faulty (even the same version couldn't read its own cookie), so cookie compatibility is unverified. The cookie serializer stays `:json`.
- The intermediate 7.1, 7.2 and 8.0 copies were checked only up to the boot failure.
- I didn't read the net-imap, securerandom or json commit pages, the older upgrade guides or the release notes.

Files are in /tmp/gem-upgrade-20261014-71561-wdf5e0:
- plan.json
- plan.rendered.txt — the full rendered plan, with every run record path
- variants/v8_1_0_r1/app — the repaired 8.1 copy
- variants/baseline_prep/app — the 7.0 copy with the early fixes applied
- variants/v8_1_0_defaults81/app — the copy with 8.1 defaults on
- probes/
- payloads/
- runs/
- sources/index.md
- dependencies-v8_1_0_r1/index.md
- dependencies-v8_1_0/index.md

---

**Next steps:**
- **Biggest risk:** F16, a failed import now leaves records saved, and your test suite doesn't catch it.
- **Not checked:** System tests and cookie compatibility.
- **To do the upgrade:** I'd split it into two commits, following the deploy order above. The first holds the changes that also work on 7.0, plus F19. The second holds the version bump with F2, F4, F8 and F9.

Should I start on the first commit?