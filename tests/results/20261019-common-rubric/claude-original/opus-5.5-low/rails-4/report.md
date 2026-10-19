# Rails upgrade plan for Margin Notes: 7.0.8.7 to 8.1.0

**Result:** The app won't boot on Rails 8.1.0 until several changes are made. With the required changes in section A, and still on `load_defaults 7.0`, all 46 tests pass and production-mode eager loading succeeds. Several of those changes alter what users see, or what gets stored, without failing any test. Three Active Job behaviours affect queued work when old and new versions run side by side, or after a rollback.

The working repository was not modified, and `git status` is clean. The planner left a `rails-8.1.0.gem` file in the repo root and then deleted it; no `.gem` file remains.

## Evidence labels
- **[EXEC]**: run in the disposable copy. Results belong to the variant named.
- **[SRC]**: read from the installed 8.1.0 or 7.0.8.7 gem source, or from the app source.
- **[PROPOSED]**: not run.

## Experiment setup (all under `/tmp/railsupg`)
- **Copies:**
  - `/tmp/railsupg/app` is a clone of the repo at commit 9938031. It has two branches:
    - `variant-a-required`: Rails 8.1.0 plus the required fixes, still on `load_defaults 7.0`.
    - `variant-b-defaults81`: variant A plus `load_defaults 8.1`.
  - `/tmp/railsupg/base` is the 7.0.8.7 baseline. Its branch `portable-prep` holds the fixes that also run on 7.0.
- **Isolated services:**
  - A separate PostgreSQL 15 cluster: data in `/tmp/railsupg/pg`, socket in `/tmp/railsupg`, port 55432 (`PGHOST=/tmp/railsupg PGPORT=55432`).
  - A separate redis-server on port 56379 with no persistence (`REDIS_URL=redis://127.0.0.1:56379/N`).
  - The test environment uses the Disk storage service in the copy's own `tmp/storage`, and `:null_store` caching.
  - Gems installed to `BUNDLE_PATH=/tmp/railsupg/bundle`.
  - Both services are stopped now.
- **Resolved dependencies** (`bundle lock --update rails concurrent-ruby`, then `json` pinned):
  - rails 8.1.0, concurrent-ruby 1.3.8, json 2.21.2 (with `gem "json", "< 3"`)
  - rack 2.2.24, held below 3 by sidekiq 6.5.12
  - puma 5.6.9, bigdecimal 4.1.3, action_text-trix 2.1.19 (new), rackup 1.0.1
- **Logs** are in `/tmp/railsupg/logs/`:

| Log | What it shows |
|---|---|
| `70-test.log` | 7.0.8.7 baseline: 46 runs, 0 failures |
| `81-dbprepare.log` | 8.1.0 does not boot (Action Text initializer) |
| `81a-test2.log`, `81a-test3.log` | Intermediate failures while fixing |
| `81a-test4.log` | Variant A: 46 runs, 340 assertions, 0 failures |
| `81a-prod-eager.log` | Production eager-load check passes (`SECRET_KEY_BASE_DUMMY=1 bin/rails zeitwerk:check`) |
| `81a-enqueue.log` | Sidekiq adapter deprecation warning |
| `81b-test.log` | Variant B: 3 errors |
| `70-prep-test.log` | Portable fixes on 7.0.8.7: 46 runs, 0 failures |

- **Payload round-trip checks** used `/tmp/railsupg/payload.rb`, with output in `/tmp/railsupg/p70.json` and `p81.json`. The `wait_until` check used `/tmp/railsupg/waituntil.rb`.

## A. Required changes (in the order they surface)

The "Works on 7.0.8.7?" column says whether a change can ship before the version bump. Every "Yes" was confirmed by the `70-prep-test.log` run.

| # | Affected code | Problem on 8.1 | Fix | Works on 7.0.8.7? | How to check it |
|---|---|---|---|---|---|
| 1 | `config/initializers/action_text.rb` (`allowed_tags +=`) | Boot fails. `ActionText::ContentHelper.allowed_tags` now defaults to nil, so `+=` raises `NoMethodError` [EXEC, 81-dbprepare.log] | Move the code into `after_initialize`. Start from `allowed_tags \|\| sanitizer.class.allowed_tags + [attachment tag, "figure", "figcaption"]`, then add `details` and `summary` | Yes | Render a note body containing `<details>` on both versions. No test covers this. |
| 2 | `Gemfile` (`json` is not pinned) | Without a pin, json 3.0.2 resolves. It breaks `ActiveSupport::JSON.decode`, which calls `JSON.parse(src, opts)`, so the JSON coder and Active Storage blob metadata raise `ArgumentError` [EXEC, 81a-test.log] | Add `gem "json", "< 3"`, or use a later 8.1.x that supports json 3 [unverified] | Yes | `bundle exec ruby -e 'p JSON::VERSION'` |
| 3 | `Citation::Provider#initialize` and `test/controllers/citation_enrichments_controller_test.rb` | `Rails.application.secrets` was removed in 7.2 | Add `config/citation_provider.yml` and `config.x.citation_provider = config_for(:citation_provider)`. Then retire `config/secrets.yml` | Yes | In production, with the env vars set: `bin/rails runner 'p Rails.configuration.x.citation_provider.keys'` |
| 4 | `config/routes.rb`: `get "/notes", "/journal", to:` | Listing several paths in one route raises `ArgumentError` [EXEC] | Split it into two `get` lines. The route names `notes` and `journal` stay the same [EXEC, `bin/rails routes`] | Yes | Diff the route list |
| 5 | `Note`: `alias_attribute :highlight_color, :color` (`color` is a `store_accessor`, not a column) | Raises `ArgumentError` when the class loads [EXEC] | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` | Yes | Save and reload a highlight colour through the note form |
| 6 | `Note`: `enum status: {...}, _prefix: true` | The keyword-style `enum` was removed in 8.0 [SRC] | `enum :status, {...}, prefix: true` | Yes | Check `Note.statuses` and the `status_ready` scope |
| 7 | `Note`: `serialize :tags, JSON`. `Notebook`: `serialize :preferences` | The positional coder was removed in 7.2. Without `coder:`, `:preferences` raises once `default_column_serializer=nil` (a 7.1 default) | Use `coder: JSON` and `coder: YAML`. Existing YAML and JSON data reads unchanged | **No.** 7.0 has no `coder:` keyword, so ship this with the version bump | Load existing rows (YAML preferences, JSON tags) from a copy of production data |
| 8 | `CitationEnrichmentJob`: `wait: :exponentially_longer` | Removed. Only `:polynomially_longer` exists [SRC exceptions.rb] | Use `:polynomially_longer` (same formula). A lambda also works on both versions | Symbol: no. Lambda: yes | Test retry scheduling in a job test |
| 9 | `Note#schedule_reminder`: `set(wait_until: reminder_epoch)`, where `reminder_epoch` is an Integer | Serializing the job raises `NoMethodError: undefined method 'utc' for Integer`, so **reminders cannot be scheduled**. The existing suite would not show this as a reminder bug [EXEC waituntil.rb] | `wait_until: Time.at(reminder_epoch)` | Yes. 7.0 gives `scheduled_at` 1767225600.0 either way [EXEC] | Reminder request test |
| 10 | `config/environments/test.rb`: `show_exceptions = false` | The `false` value was removed in 7.2 | Use `:none` | **No.** 7.0 treats the symbol as truthy | Test suite |
| 11 | `notes/index.html.erb`: `form_with(model: nil, ...)` | Raises "Passed nil to the :model argument" [EXEC] | Drop `model: nil` | Yes | Notes index request test |
| 12 | `NotesController#index`: `where(notebooks: @notebook)` | Generates `notes.notebooks` and fails with `PG::UndefinedColumn` [EXEC] | `where(notebook: @notebook)` | Yes | Notebook filter test |
| 13 | `Export#generate`: `fragments.sum` over Strings | Active Support no longer lets `Array#sum` join strings, so **every export fails** with `TypeError` [EXEC] | `fragments.join` | Yes | Run the export job end to end |
| 14 | `Import#apply`: `return false` inside `transaction` | 7.0 rolls back. 7.2 and later **commit** on an early return, so a CSV with invalid rows is partly saved. Row counts went to `[1, 4, 1, 2]` [EXEC] | `raise ActiveRecord::Rollback` and return a flag | Yes | Importing a file with invalid rows saves nothing |
| 15 | `Import#receipt`: `citation[:id]` (the citations primary key is `doi`) | Now returns nil, so the **downloaded receipt CSV has an empty DOI column** [EXEC] | `citation&.doi` | Yes | Check the receipt CSV contents |
| 16 | `imports/preview.html.erb`: `annotations.stringify_keys` | On a HashWithIndifferentAccess, `stringify_keys` now actually converts the Integer line keys to strings, so annotations disappear from the preview [EXEC; in 7.0 source it is `def stringify_keys; dup end`] | Drop `stringify_keys` | Yes | The preview shows the annotation |
| 17 | `DigestMailer`: `requested_at` passed from the job | The TimeWithZone serializer now keeps the time zone, so the digest covers the **reader's local day** instead of the UTC day. Both the subject and the note window change (Oct 05 became Oct 04) [EXEC] | `requested_at = requested_at.in_time_zone("UTC")`, unless the product decision is to switch to local days | Yes | Digest test near midnight |
| 18 | `Note#next_day_reminder_at`: `reminder_at.to_time + 86_400` | `to_time` now always keeps the time zone, so across a DST change the displayed offset changes (−04:00 became −05:00). The instant is the same [EXEC] | `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`, or accept the change and update the comment | Yes | Reminder test across Nov 1, 2026 |

**Recommended order:** first ship rows 1, 3–6, 9 and 11–18, plus the json pin, on 7.0. Those portable fixes are on branch `portable-prep` in `/tmp/railsupg/base`. Then ship the version bump together with rows 7, 8 and 10.

## B. Optional new-default adoption (keep `load_defaults 7.0` at first)

Moving to the new defaults one step at a time (7.1, 7.2, 8.0, 8.1) is optional. Variant B, which sets `load_defaults 8.1` on top of the required fixes, found three breakages [EXEC, 81b-test.log]:
- **7.1 `raise_on_assign_to_attr_readonly`:** the hidden `slug` field in `notebooks/_form` plus `permit(:slug)` raises `ReadonlyAttributeError` on every notebook update. Fix: remove `:slug` from `notebook_params` and drop the hidden field. This works on 7.0.
- **7.1 `raise_on_invalid_cache_expiration_time`:** in `exports/_export.html.erb`, `expires_in: export.expires_at - Time.current` is negative for expired exports, so the export list returns 500 even with `:null_store`. Fix: skip caching when the export is not downloadable, or clamp the value to at least 1 second.
- **7.2 `postgresql_adapter_decode_dates`:** `select_rows` in `Notebook#daily_note_counts` now returns `Date` objects, so `Date.iso8601(Date)` raises `TypeError`. Fix: accept both, with `day.is_a?(Date) ? day : Date.iso8601(day)`.

Some defaults change data formats in one direction only, so plan for rollback before adopting them [SRC configuration.rb]:
- **`active_support.cache_format_version = 7.1`:** 7.0 cannot read the new format. Production sets no `cache_store`, so the default file store in `tmp/cache` applies. Clear it on rollback.
- **`message_serializer = :json_allow_marshal` and `use_message_serializer_for_metadata`:** signed and encrypted cookies (including the session) and Active Storage signed URLs or blob IDs written by 7.1 or later may be unreadable on 7.0. Adopt these only once rollback is no longer needed. **[PROPOSED]** Issue a session cookie under each setting and read it on the other version.
- **`active_record.marshalling_format_version 7.1`** only matters if records are cached with Marshal.
- **`sanitizer_vendor` HTML5:** stored Action Text bodies are sanitized again at render time, now under HTML5 rules. **[PROPOSED]** Render a sample of production notes under each setting and diff the output.
- **`active_record.encryption` settings:** the app uses no `encrypts`, so these don't apply.
- **8.1 settings:** all low risk for this app, but they are adoption steps, not requirements.
  - `action_on_path_relative_redirect = :raise`: all redirects use path helpers [SRC].
  - `raise_on_missing_required_finder_order_columns`
  - `escape_json_responses` and `escape_js_separators_in_json`: JSON output changes slightly.
  - `remove_hidden_field_autocomplete`
  - `yjit`
- **Schema dump [EXEC]:** on 8.1, `db:schema:dump` rewrites `db/schema.rb` with `Schema[8.1]`, `pg_catalog.plpgsql`, and **columns sorted alphabetically**. It is a 36-line diff with no DDL change. Commit it as its own separate change.

## C. Mixed-version rollout and rollback risks

1. **BigDecimal job argument (`DigestJob` completion) [EXEC]:**
   - 7.0 enqueues the plain string `"0.5"`. 8.1 always enqueues `{"_aj_serialized":"...BigDecimalSerializer"}`, and no setting turns that off.
   - A 7.0 worker given an 8.1 payload raises `DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The other direction works: 8.1 reads `"0.5"`, and the mailer's `BigDecimal(...)` accepts it.
   - So upgrade all workers before the web nodes or at the same time, and drain digest jobs before any rollback. A failed digest also keeps that day's Redis reservation.
   - Preparation that works on 7.0: pass `completion.to_s` from `User#request_digest`. That removes the mismatch on both versions.
2. **TimeWithZone argument [EXEC]:**
   - 8.1 adds a `time_zone` key. 7.0 ignores it and deserializes in UTC.
   - 8.1 reading a 7.0 payload gets UTC. With fix 17 in place, behaviour is the same in both directions.
3. **Scheduled `NoteReminderJob`s already in Sidekiq's scheduled set:**
   - 8.1 reads 7.0 payloads, which have no `scheduled_at` key; GlobalID is unchanged [SRC core.rb:171].
   - 8.1 payloads add `scheduled_at` in ISO8601, which 7.0 ignores. Low risk.
   - **[PROPOSED]** Enqueue on 7.0 against the isolated Redis and perform on 8.1 with a real Sidekiq process.
4. **Sidekiq:**
   - The built-in `:sidekiq` adapter is deprecated in 8.1 and removed in 8.2 [EXEC: the warning appears at boot].
   - Sidekiq 6.5.12 pins rack below 3. Moving to sidekiq 7.3.3 or later means redis-client replaces `redis` 4.8. That changes the return types of `Sidekiq.redis { sadd/expire/srem }` and breaks `rescue Redis::BaseError` in `Notebook#request_export`.
   - Treat the Sidekiq move as a separate follow-up upgrade. The native `ExportJob` is not affected by the Rails upgrade.
5. **`enqueue_after_transaction_commit`:** defaults to false in 8.1 [SRC enqueuing.rb:53], so `Citation#request_enrichment` and `Note#schedule_reminder` still roll back when an enqueue fails. Do not turn it on: both methods depend on enqueueing inside the lock.
6. **Rollback in general:** while `load_defaults 7.0` stays, cookies, cache, messages and Active Storage keys are unchanged. A code rollback is therefore safe apart from item C1 and the defaults in section B. Stored schema data is unchanged, since the upgrade involves no migrations.

## Unverified claims and open questions
- **System tests and Trix were not run.** The editor uses `rich_text_area`, `application.js` imports only `@rails/actiontext`, and 8.1 moves Trix into the separate `action_text-trix` gem. **[PROPOSED]** Run `bin/rails test:system` and check that the editor loads under importmap and sprockets.
- **puma 5.6.9 was not run as a server on 8.1.** **[PROPOSED]** Run `bin/rails server` and make a smoke request.
- **json 3 support in later 8.1.x patch releases** is unverified.
- **Real production data was not checked:** the YAML `preferences`, the JSON `tags`, and what is in the cache directory.
- **Product decisions needed:** should digests switch to the reader's local day (fix 17)? Should reminder times keep their original offset (fix 18)?
- **`.connection` deprecation:** `Note.connection.select_rows` produced no deprecation warning in the logs. Whether `with_connection` is now preferred was not examined.
- **Cookies, sessions and Active Storage signed URLs were not tested across versions** (proposed in section B).

---

**Notes:**
- Five changes alter behaviour without failing any test: reminders that can't be scheduled (9), partial imports (14), empty receipt DOIs (15), missing preview annotations (16), and the digest day shift (17).
- The planner wrote this plan itself because it had no agent tool to delegate with. I didn't re-run any of its experiments; all its artifacts are under `/tmp/railsupg`.
