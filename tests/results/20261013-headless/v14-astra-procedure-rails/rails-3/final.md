Here's the planner's report, unchanged:

---

This is a plan only; nothing was changed in `/home/user/workspace/repo` (the lab's hash check confirms the source is unchanged). The upgrade from Rails 7.0.8.7 to 8.1.0 is not safe as the code stands. Ruby 3.3.6 already meets the requirement (8.x needs 3.2 or later).

Unchanged code fails to boot on every version from 7.1 up. The target lockfile also picks up json 3.1.0, which breaks all JSON decoding in Rails 8.1.0. With the 19 required code changes and a json pin below, my repaired copy on 8.1.0 boots, loads, draws routes and passes all 46 non-browser tests. I also wrote probe scripts that call the app directly, because passing tests is not enough: several regressions are silent and the existing tests catch only some of them. System tests were not run.

The full rendered plan is at `/tmp/gem-upgrade-20261014-71570-dpe4f6/plan-rendered.txt`, with the data in `/tmp/gem-upgrade-20261014-71570-dpe4f6/plan.json`. The report checker passed its structure and file checks; it does not judge whether the content is right.

## Required changes (each observed failing, then passing after the fix)
1. **Action Text allowlist (F1):** `config/initializers/action_text.rb` stops boot with `undefined method '+' for nil`. Fix: build the list in `config.after_initialize` from `allowed_tags || (sanitizer.class.allowed_tags + attachment tags)`, then add details and summary. Works on 7.0.
2. **json 3.1.0 (F2):** every JSON decode raises `wrong number of arguments (given 2, expected 1)`. Fix: add `gem "json", "~> 2.7"`; it resolved to 2.21.2.
3. **`Rails.application.secrets` removed (F3):** `Citation::Provider` raises NoMethodError. Fix: move the file to `config/citation_provider.yml` (keep the `.to_json` quoting), load it with `config_for`, and read `Rails.configuration.x.citation_provider`. Values like "00123" and "sample: value # keep" stayed strings. Works on 7.0.
4. **Note model loading (F4–F6):**
   - Change `enum status: ..., _prefix:` to `enum :status, {...}, prefix: true`.
   - Change `serialize :tags, JSON` to `coder: JSON` (only valid from 7.1).
   - Change `alias_attribute :highlight_color, :color` to two `alias_method` lines.
5. **Routes (F7):** `get "/notes", "/journal"` must become two separate routes.
6. **Test environment (F8):** change `show_exceptions = false` to `:none`. Otherwise five tests that expect "record not found" stop seeing the error.
7. **Exports never complete (F9):** `fragments.sum` raises TypeError; use `fragments.join`.
8. **Notes list returns 500 (F10):** remove `model: nil` from `form_with`.
9. **Notebook filter crashes (F11):** `where(notebooks:)` becomes `where(notebook:)`.
10. **Silent: import receipt loses DOIs (F12):** `citation[:id]` becomes `citation&.doi`.
11. **Silent: a failed import saves partial data (F13):** `return` inside a transaction now commits. Observed counts went from [0,3,0] to [1,4,1] while the page says nothing was saved. Fix: `saved = rows.all?(&:save)`, then `raise ActiveRecord::Rollback unless saved`.
12. **Silent: import preview drops annotations (F14):** remove `.stringify_keys` in `imports/preview`.
13. **Retry crashes when the provider is down (F15):** change `wait: :exponentially_longer` to `:polynomially_longer` (only valid from 7.1).
14. **Reminders cannot be scheduled (F16):** use `wait_until: Time.at(reminder_epoch)`.
15. **Digest covers the wrong day (F17):** the digest is dated by the reader's local day instead of the UTC day ("October 04" instead of "October 05"). This already happens on 7.0.10, a patch release. Fix: convert with `requested_at.utc` in `DigestMailer`.
16. **Next-day reminder wrong across a clock change (F19):** it shows 08:00 -05:00 instead of 09:00 -04:00. Fix: `Time.at(epoch + 86_400, in: reminder_at.formatted_offset)`.

Everything except `coder: JSON`, `:polynomially_longer`, `:none` and the json pin also passes the suite and probes on 7.0.8.7, so it can ship before the bump. Those four must ship in the same deploy as the bump.

## Rollout risks
- **Digest jobs during a rolling deploy or rollback (F18):** 7.0 workers cannot read 8.1-queued digest jobs: `Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. Fix: pass `reading_completion.to_s("F")`. I tested the old and new job formats in both directions; with this fix, every version read every job correctly.
- **Sidekiq (F24):** Sidekiq 6.5.12 and redis 4.8.1 did not move. Rails 8.1 deprecates its built-in Sidekiq adapter. A later Sidekiq 7 upgrade would hit the symbol-key arguments to `ExportJob` and the `sadd` return value in the digest guard.
- **Rich-text editor (F25):** the vendored Trix 1.3.5 versus the new Trix gem in Action Text 8.1 is untested. Run the system tests before deploying.

## Optional framework defaults (adopt after the code change)
- **F20:** `postgresql_adapter_decode_dates` breaks the activity report. Use `day.to_date`.
- **F21:** `raise_on_assign_to_attr_readonly` breaks notebook settings. Use `notebook_params.except(:slug)` on update.
- **F22:** `raise_on_invalid_cache_expiration_time` makes the exports page fail for expired exports. Clamp `expires_in` to at least one minute.
- **F23:** `default_column_serializer = nil` breaks Notebook loading. Use `serialize :preferences, coder: YAML`.
- Wait until there is no rollback before switching `message_serializer`, `use_message_serializer_for_metadata`, `cache_format_version` or `marshalling_format_version`.

Each of the 36 defaults has a recorded decision in the plan.

## Not covered or not run
- **Not run:** system tests, the production Sidekiq/Redis worker envelope, cookie and session reads across versions, and `strict_freshness` (my conditional-GET probe never got a 304).
- **Rails source not fully reviewed:** commit history was keyword-searched only, not read in full, and there was no 8.1 framework-defaults template. The release-ancestry gaps for rails and uri remain. The 7.0.10 job change was found by comparing installed gems, not from the changelog.
- **One probe flaw:** the retry assertion in the combined probe errors on 8.1 for a reason specific to the probe. I used a standalone retry probe for that evidence instead.

The lab's databases were dropped. The copies, logs and probes remain under `/tmp/gem-upgrade-20261014-71570-dpe4f6/`:
- `variants/v8_1_0_fix/app` — the repaired 8.1 copy
- `variants/baseline_repaired/app` — the same repairs on 7.0
- `runs/` — every command record and log
- `probes/` — the probe scripts
- `payloads/` — saved job payloads used for the cross-version test

---

**My notes:** You asked for the upgrade, but this produced a plan only. Your repo on `main` is unchanged. The plan says bumping the gem alone isn't safe. On the planner's test copy, the app didn't boot on Rails 8.1.0 until the code changes were made and json was pinned below 3.x. Even then, system tests were not run.

If you want me to go ahead, I'd do it on a branch in two steps:
1. Ship the changes that also work on 7.0 first.
2. Then bump Rails along with the four changes that need 7.1 or later, and run both `bin/rails test` and `bin/rails test:system`.

Should I start?