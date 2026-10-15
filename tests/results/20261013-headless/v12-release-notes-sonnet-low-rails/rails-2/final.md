Here is the plan from `maintain-rails:gem-upgrade-planner` for upgrading Rails from 7.0.8.7 to 8.1.0. The subagent ran its experiments in `/tmp/exp` copies, so nothing in the repo changed.

# Upgrade plan: Rails 7.0.8.7 to 8.1.0 for Margin Notes

The upgrade is feasible, but it needs eleven required code or config changes before it runs correctly. Without them the app does not boot. With all of them applied to a disposable copy, the 46-test suite went from 46 errors to 46 green. A real Sidekiq worker also processed jobs queued by 7.0.

**Resolved dependencies**
- `bundle update rails` gave rails 8.1.0, actiontext 8.1.0 with `action_text-trix` 2.1.19, `rackup` 1.0.1 and `drb` 2.2.3.
- It also gave `bigdecimal` 4.1.3 and `json` 3.1.0. Finding 1 replaces `json` with the 2.x series.
- Unchanged: rack 2.2.24, puma 5.6.9, sidekiq 6.5.12, redis 4.8.1, sprockets 4.4.1, faraday 1.10.4, pagy 8.6.3, minitest 5.27.
- Ruby is 3.3.6, which Rails 8.1 accepts.

## A. Required changes

1. **`json` 3.1.0 breaks cookie decryption.**
   - Without a fix, any request with a session fails with `ArgumentError: wrong number of arguments`, from `ActiveSupport::JSON` calling `::JSON.parse`.
   - Fix: add `gem "json", "~> 2.7"`, which resolved to 2.21.2.
   - Test: sign in, fetch `/notes`, and assert 200.
2. **`config/initializers/action_text.rb` fails to boot.**
   - `allowed_tags` is nil in 7.1+, so line 3 raises `undefined method '+' for nil`.
   - Fix: assign the full list explicitly, as in `/tmp/out/up_repairs.diff`. That is the sanitizer's `allowed_tags` plus the attachment tag name, `figure`, `figcaption`, `details` and `summary`.
   - Test: the existing "rich text keeps collapsible excerpts and drops unsafe markup" test. Sanitized output was identical on 7.0 and 8.1.
   - Caveat: the list is captured while the sanitizer class is still HTML4. It is not re-verified if `sanitizer_vendor` is adopted later.
3. **Keyword enum and positional `serialize` were removed** in `app/models/note.rb`, lines 10 and 12.
   - Fix: `enum :status, { draft: 0, ready: 1 }, prefix: true` and `serialize :tags, coder: JSON`.
   - These forms don't work on 7.0, so this must ship with the upgrade.
   - Rows written by 7.0 read back identically.
   - Test: create a Note with `tags: ["a","é"]` and `status: :ready`, then check `status_ready?`, the `Note.status_ready` scope and the raw `tags` column.
4. **`serialize :preferences` (YAML, no coder)** only breaks once `load_defaults` reaches 7.1 or later.
   - Fix when adopting those defaults: `serialize :preferences, coder: YAML`.
   - It can wait until then.
   - Existing rows read and write back unchanged.
5. **`alias_attribute :highlight_color, :color`** on a `store_accessor` key now raises.
   - Fix: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Both are needed because `NotesController` permits `:highlight_color`.
   - This also works on 7.0.
   - Test: create and update with `highlight_color: "green"` and assert `settings == {"color"=>"green"}`. Check that an invalid color is rejected.
6. **`get "/notes", "/journal", to: "notes#index"` raises** at `config/routes.rb:18`.
   - Fix: two separate `get` lines. The named routes are unchanged.
   - The existing notes test covers it.
7. **`Rails.application.secrets` was removed in 7.2.**
   - It is used in `Citation::Provider#initialize` and `config/secrets.yml`. Every enrichment request fails without a fix.
   - Fix: move the file to `config/citation_provider.yml`. Set `config.x.citation_provider = config_for(:citation_provider)` and read `Rails.configuration.x.citation_provider.to_h`.
   - Environment variable names are unchanged, so deploys need no change.
   - Update the test helper that mutates `Rails.application.secrets.citation_provider`.
   - This can be done ahead of time on 7.0, since `config_for` exists there.
   - Unverified: the production master key and credentials, which the subagent could not decrypt.
8. **`where(notebooks: @notebook)` in `NotesController#index` generates bad SQL.**
   - Fix: `where(notebook_id: @notebook.id)`, which also works on 7.0.
   - Test: GET `/notes?notebook_id=<id>` for a user with two notebooks and assert only that notebook's notes appear.
9. **`form_with(model: nil, …)` in `notes/index.html.erb` raises.**
   - Fix: remove `model: nil`. Field names stay the same.
   - Test: GET `/notes` and assert 200.
10. **Test env: `show_exceptions = false` is no longer honoured.**
    - Not-found isolation tests silently stop testing real behaviour.
    - Fix: `config.action_dispatch.show_exceptions = :none` in `config/environments/test.rb`. Production is unaffected.
11. **Behavioural breaks in app code** that the existing tests only partly catch:

| # | Where | Problem | Repair |
|---|---|---|---|
| a | `Import#apply` | `return false` inside `transaction do` now commits. A partial import saved the first row, the Import and its Citation. | `saved = rows.all? { \|r\| r.note.save }; raise ActiveRecord::Rollback unless saved`, then return `saved` |
| b | `Export#generate` | `fragments.sum` on strings raises `TypeError`, so every export job fails. | `fragments.join` |
| c | `Import#receipt` | `citation[:id]` is nil for a table keyed by `doi`, so the receipt CSV loses every DOI. | `citation&.doi` |
| d | `imports/preview.html.erb` | `.stringify_keys` turns integer keys into strings, so the preview shows no annotations. | Remove `.stringify_keys` |
| e | `CitationEnrichmentJob` | `wait: :exponentially_longer` raises `RuntimeError` inside the row lock. | `:polynomially_longer` |
| f | `Note#schedule_reminder` | `set(wait_until: reminder_epoch)` raises `NoMethodError` on an Integer. | `wait_until: Time.at(reminder_epoch)` |
| g | `Note#next_day_reminder_at` | `to_time` now keeps the zone, so the displayed offset changes (the instant is the same). | `Time.at(at.to_i + 86_400, in: at.utc_offset)` |
| h | `DigestMailer` | The deserialized time lands in the reader's zone, so the digest subject date is off by a day. | `requested_at = requested_at.utc` at the top of `daily_digest` |

Two test additions are needed:
- For 11a, assert that `Import`, `Note`, `Citation` and `ActionText::RichText` counts are unchanged after a failed apply, and that a valid import still saves everything.
- For 11c, add a note with no DOI and assert its row is `Title,` with no DOI.

## B. Rollout and rollback

Checked with a real Sidekiq 6.5.12 worker.

- **Old to new:** jobs queued by 7.0 (`DigestJob`, `NoteReminderJob`, `CitationEnrichmentJob`, `ExportJob`) were processed correctly by 8.1. There is a deprecation warning that the built-in `sidekiq` adapter goes away in Rails 8.2 and needs Sidekiq 7.3.3 or later.
- **New to old (a real risk):**
  - 8.1 serializes the BigDecimal job argument with `BigDecimalSerializer`, even at `load_defaults 7.0`. A 7.0 worker fails with `DeserializationError`.
  - Fix: in `User#request_digest`, pass `reading_completion.to_s("F")`. `DigestMailer` already calls `BigDecimal(params[:completion])`, and the change is safe on both versions.
  - Ship this before or with the upgrade.
- **Cookies and sessions:** with the same `SECRET_KEY_BASE`, cookies work in both directions. Production credentials were not used.
- **Stored data:** `preferences`, `tags`, `settings`, rich text and blobs read back unchanged.
- **`db:migrate`** rewrites `db/schema.rb` (`Schema[8.1]`, `enable_extension "pg_catalog.plpgsql"`, reordered columns). Commit that deliberately or discard it.
- **Rolling back the code** is safe once the BigDecimal fix is deployed. No migrations are needed.
- **Sidekiq 7:** upgrading is a separate follow-up. Sidekiq 7 rejects `ExportJob.perform_async(id, { format: "markdown" })` because it uses symbol keys.

## C. Optional default adoption

`load_defaults 7.0` stays valid on 8.1. The suite passed at 7.0 and at 8.1 defaults after the repairs below. 7.1, 7.2 and 8.0 were not rerun after them.

**7.1**
- `raise_on_assign_to_attr_readonly`: adopting it makes `Notebook#update` raise on `slug`. Fix: drop `:slug` from `notebook_params`.
- `raise_on_invalid_cache_expiration_time`: adopting it makes the exports index 500 for any expired export, from `exports/_export.html.erb:26`. Fix: `expires_in: [export.expires_at - Time.current, 0].max`, which is safe on 7.0 too.
- `default_column_serializer`: see finding 4.
- `sanitizer_vendor` and `dom_testing_default_html_version = :html5`: the suite passes, but rich text with unusual markup under the HTML5 parser is not reviewed. Check it manually.
- `message_serializer` and `marshalling_format_version`: need the usual two-deploy sequence.
- The remaining 7.1 defaults have no effect on this app.

**7.2**
- `postgresql_adapter_decode_dates`: adopting it raises `TypeError` in `Notebook#daily_note_counts`. Fix: `day.to_date`, and update the `Date.iso8601` comment.
- `enqueue_after_transaction_commit`: Sidekiq 6.5.12 resolves this to false. Upgrading Sidekiq to 7.3.3 or later may turn it on. That would break the "enqueue under the row lock, roll back on failure" design in `Citation#request_enrichment` and `Note#schedule_reminder`. Decide this explicitly then, or set `self.enqueue_after_transaction_commit = false` on those jobs.
- `yjit = true` affects production memory, so it is a deployment decision.

**8.0**
- `strict_freshness` affects `ExportDownloadsController`. No impact is expected, but it is based on source and untested with conditional headers.

**8.1:** no new defaults.

Recommended order: ship the required and preparatory changes under `load_defaults 7.0`. Then step `load_defaults` through 7.1, 7.2, 8.0 and 8.1 in separate commits, applying the repairs above first.

## D. Other observations

- Rack 2.2.24 and Puma 5.6.9 stayed in place, and the main pages returned 200 on the dev server. A `/accounts` request returned 404, which is probably the singular `/account` route and was not investigated.
- The layout loads a vendored Trix 1.3.5, while Rails 8.1 bundles Trix 2.1.19. Decide which to keep and test the editor in a browser, covering links, attachments, save and reload. The layout comment about Trix 1.3.4 is stale.
- `config.cache_classes` still works, and `zeitwerk:check` passes in production.
- Not verified:
  - Trix 1.3.5 with Rails 8.1's `actiontext.js` in a real browser.
  - HTML5 sanitizer behaviour on real rich text.
  - Production credentials.
  - `strict_freshness` with conditional headers.
  - A rolled-back `TimeWithZone` payload on 7.0, other than the digest.
  - The `/accounts` 404.
- `TESTING.md` and `CLAUDE.md` mention Rails 7.0 and the Minitest 5 pin, so they need updating. The Minitest 5.x pin is still required.

## E. Open questions

- Should the next-day preview keep the original UTC offset (the 11g repair), or show the reader's local zone on 8.1?
- Is a mixed-version deployment planned? If so, the BigDecimal fix goes first.
- Should Sidekiq go to 7.3.3 or later in the same release? Without it, the deprecation warning appears on every boot and the adapter is removed in Rails 8.2.

Evidence files are in `/tmp/out`, starting with `changes.txt` and `up_repairs.diff`.

I have not changed the repo, as the skill only plans the upgrade. I can start implementing the required changes if you want.