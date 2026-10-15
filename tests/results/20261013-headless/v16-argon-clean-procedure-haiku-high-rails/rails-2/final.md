## Rails 7.0.8.7 to 8.1.0 upgrade plan for Margin Notes

**Verdict:** The bump is not ready as-is. With `Gemfile` changed to `rails 8.1.0`, boot fails immediately. I reproduced the failure and fixed the blocking issues in a disposable copy, then ran the suite to completion. The application checkout was not modified, and the workspace was cleaned up.

**Ordering:**
1. Ship the pre-bump repairs on Rails 7.0 first (R1–R6, R8–R22 below, plus the `json` pin in R18). The full baseline suite passes with them (325 assertions, 0 failures).
2. Bump to 8.1.0 with `load_defaults 7.0` and include the two bump-time changes, R3 and R7. Both break 7.0 if applied early.
3. Adopt newer `load_defaults` only after the rollback window closes, because several defaults change cache and message formats.

Findings are cited against the current checkout (original line numbers). Each fix below was validated in the workspace copy. All paths are absolute under `/home/user/workspace/repo/`.

---

## 1. Required changes for the upgrade

### R1. ActionText allowlist raises during boot
- **Affected code:** `/home/user/workspace/repo/config/initializers/action_text.rb:3`.
- **What breaks:** `NoMethodError: undefined method '+' for nil (config/initializers/action_text.rb:3:in '<main>')`. Boot fails, so every test errors (`46 errors`). In 8.1, `ActionText::ContentHelper.allowed_tags` defaults to `nil`; in 7.0 it was computed lazily.
- **Applicability:** Immediately on the gem bump. The repair works on 7.0 too.
- **Recommended repair:**
  ```ruby
  ActionText::ContentHelper.allowed_tags = ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ] + %w[ details summary ]
  ```
- **Validation:** Before the repair, `upgrade-workspace test` reports `boot=FAILED`. After it, boot and eager load pass. Control: the allowlist contents are unchanged. The added tags are only `action-text-attachment`, `details`, `figcaption`, `figure`, and `summary`, and the HTML4 and HTML5 tag lists match (`vendor_tags_not_in_allowlist=[]`). The test "rich text keeps collapsible excerpts and drops unsafe markup" passes on both.

### R2. Keyword-argument `enum` removed in 8.0
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:10`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 0, expected 1..2) (app/models/note.rb:10)`. Eager load fails.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:**
  ```ruby
  enum :status, { draft: 0, ready: 1 }, prefix: true
  ```
- **Validation:** Before the repair, eager load fails. After it, `Note.instance_methods` lists the same `status_draft?`, `status_ready?`, and `status_*!` methods on both copies. The full suite passes.

### R3. Positional `serialize :tags, JSON` removed (bump-time only)
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:12`.
- **What breaks:** `ArgumentError: wrong number of arguments (given 2, expected 1)` at class load.
- **Applicability:** The `coder:` form works on 8.1 but breaks 7.0. On 7.0, `serialize :tags, coder: JSON` ignores the keyword, so `tags` becomes a plain String. The baseline then fails with `undefined method 'any?' for an instance of String` (`_tags.html.erb:1`) and `undefined method 'join' for an instance of String` (`note.rb:88`). Ship this in the bump commit only.
- **Recommended repair (bump commit):** `serialize :tags, coder: JSON`.
- **Validation:** On the 8.1 copy the class fails to load with the positional form and succeeds with `coder:`. On the 7.0 copy the `coder:` form fails the notes tests. The positional form passes the full baseline suite.

### R4. Multi-path route removed
- **Affected code:** `/home/user/workspace/repo/config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`.
- **What breaks:** `ArgumentError: Wrong number of arguments (expect 1, got 2) (config/routes.rb:18)`. Routes do not load.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:**
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- **Validation:** Before the repair, the route diagnostic fails. After it, the route tables match except for ActionMailbox conductor routes, which 8.1 changed and the app does not define. The `journal` and `notes` route names are unchanged. The test "lists the reader's notes newest first at both list paths" passes.

### R5. `alias_attribute` on a store accessor
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:13-14`. `color` is a `store_accessor :settings, :color`, not a column. Used by `app/views/notes/_form.html.erb:31-37`, `app/views/notes/index.html.erb:44`, `app/views/notes/show.html.erb:3`, and `app/controllers/notes_controller.rb:68`.
- **What breaks:** Lazily, on first `Note` use: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use alias_method :highlight_color, :color`. In the first full run this failed 22 tests.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:**
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- **Validation:** Before the repair, 22 tests error with that message. After it, the highlight radio tests pass (`input[type=radio][name='note[highlight_color]'][value=yellow][checked]`). Control: the stored `settings` JSON is unchanged (`{"color" => "green"}`).

### R6. `Rails.application.secrets` removed
- **Affected code:** `/home/user/workspace/repo/app/models/citation/provider.rb:13` reads `Rails.application.secrets.citation_provider.to_h`. Tests override it at `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`.
- **What breaks:** `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>` in the test helper. In production (inferred from code, not executed), `Citation::Provider.new` raises `NoMethodError`. The job only rescues `Provider::Error` and `Unavailable`, so the citation stays `pending`.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:**
  ```ruby
  # app/models/citation/provider.rb
  class << self
    attr_writer :settings

    def settings
      @settings ||= Rails.application.config_for(:secrets).citation_provider.to_h
    end
  end

  def initialize(settings = self.class.settings)
  ```
  In the test, replace `Rails.application.secrets.citation_provider` with `Citation::Provider.settings`. This test seam is needed to keep the existing override.
- **Validation:** Before the repair, 4 citation tests error with `undefined method 'secrets'`. After it they pass. Control: the test "provider credentials from the environment reach the server unchanged" (fresh process reading ENV) still passes.

### R7. `show_exceptions = false` no longer raises (bump-time only)
- **Affected code:** `/home/user/workspace/repo/config/environments/test.rb:31`.
- **What breaks:** In 8.1, `false` is not a recognized value and falls through to "show exceptions". Missing records render 404 instead of raising. I ran the request on both copies: baseline raises `ActiveRecord::RecordNotFound: Couldn't find Note with 'id'=999999`, while 8.1 with `false` returns `status=404`. The test "another reader's notebook settings cannot be reached" fails with `ActiveRecord::RecordNotFound expected but nothing was raised`.
- **Applicability:** The 8.1 behavior applies immediately on the bump. The fix is a bump-time change, because `:none` on 7.0 is truthy and produces 23 failing tests.
- **Recommended repair (bump commit):** `config.action_dispatch.show_exceptions = :none`.
- **Validation:** On 8.1 with `:none`, the RecordNotFound tests pass. On the 7.0 baseline with `:none`, 23 tests fail (500 pages). Keep `false` on 7.0.

### R8. `form_with(model: nil)` removed in 8.0
- **Affected code:** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`.
- **What breaks:** `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. The note list fails.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:**
  ```erb
  <%= form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>
  ```
- **Validation:** Before the repair, the list fails. After it, the form test passes (`form[role=search][action="/notes"][method=get]`).

### R9. Plural association name in `where` removed
- **Affected code:** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12`, `@notes = @notes.where(notebooks: @notebook)`.
- **What breaks:** `ActiveRecord::StatementInvalid: PG::UndefinedColumn: column notes.notebooks does not exist`. Filtering by notebook fails. This is 7.2's removal of the plural-name fallback. It was missed by `gem-changes` (it appears only in the "no textual match" list).
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:** `@notes = @notes.where(notebook: @notebook)`.
- **Validation:** Before the repair, the notebook-filter tests error. After it, "filters by notebook, status, and title" and "pages through filtered notes" pass.

### R10. `Enumerable#sum` on strings
- **Affected code:** `/home/user/workspace/repo/app/models/export.rb:42`, `finish(fragments.sum)`.
- **What breaks:** `TypeError: String can't be coerced into Integer` in `ExportJob#perform`. Exports never reach `completed`. On 7.0 the same call emits a deprecation and returns `"ab"` for `%w[a b].sum`.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:** `finish(fragments.join)`.
- **Validation:** Before the repair, 3 export tests error with `TypeError`. After it, the Markdown download test passes. Control: the probe `%w[a b].sum` gives `"ab"` on 7.0.

### R11. `Import#apply` commits partial imports (data integrity)
- **Affected code:** `/home/user/workspace/repo/app/models/import.rb:50-61`. `return false` inside `transaction do ... end` at line 56.
- **What breaks:** A non-local `return` from a transaction block now commits. Probe (second row has a blank title):
  - Baseline 7.0: `apply=false before=[0, 3, 0, 1] after=[0, 3, 0, 1]`
  - 8.1: `apply=false before=[0, 3, 0, 1] after=[1, 4, 0, 2]`. One import, one note, and one rich-text body were committed even though `apply` returned false.

  The test "invalid rows are shown with their errors, and applying them saves nothing" fails with `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]`.
- **Applicability:** Immediately on the bump. This is a data-integrity change.
- **Recommended repair:**
  ```ruby
  def apply
    return false if invalid?

    applied = false
    transaction(requires_new: true) do
      save!
      applied = rows.all? { |row| row.note.save }
      raise ActiveRecord::Rollback unless applied
    end

    applied
  end
  ```
  `requires_new: true` makes the block a savepoint when nested, so tests with transactional fixtures still roll back.
- **Validation:** Before the repair, the test fails and the probe shows partial commits. After it, `record_counts` is unchanged and the probe returns `after=[0, 3, 0, 1]`. Control: "previews a CSV without saving, then imports every row" passes with all rows created.

### R12. `citation[:id]` no longer returns the custom primary key
- **Affected code:** `/home/user/workspace/repo/app/models/import.rb:68`, `csv << [ note.title, citation && citation[:id] ]`.
- **What breaks:** The receipt's DOI column is empty. Probe: `citation[:id]` is `"10.1000/Essays.1"` on 7.0 and `nil` on 8.1 (`citation_pk="doi"`). The receipt test diff shows `On idleness,` instead of `On idleness,10.1000/Essays.1`.
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:** `csv << [ note.title, citation&.doi ]`.
- **Validation:** Before the repair, the receipt assertion fails. After it, the receipt test passes. Control: a note without a citation still gets an empty DOI cell.

### R13. `wait: :exponentially_longer` removed
- **Affected code:** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`.
- **What breaks:** When the provider is unavailable, the retry raises `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. The `fail_enrichment` block never runs, so the citation stays pending.
- **Applicability:** Immediately on the bump. `:polynomially_longer` exists only from 7.1, so it is not usable on 7.0.
- **Recommended repair (pre-bump, works on both):**
  ```ruby
  retry_on Citation::Provider::Unavailable, wait: ->(executions) { executions**4 + 2 }, attempts: 3 do |job, error|
  ```
  Equivalent to `:exponentially_longer` on 7.0 and to `:polynomially_longer` on 8.1. The jitter is applied to the Proc's result, which I did not measure against the symbol path. After the bump, `wait: :polynomially_longer` is the idiomatic form.
- **Validation:** Before the repair, the citation retry test errors. After it, both copies pass (`325 assertions, 0 failures` on baseline; `340 assertions, 0 failures` on upgraded). Control: "fetches a manually entered DOI's title and source URL, retrying one unavailable response" passes.

### R14. Digest job timezone changes the covered day
- **Affected code:** `/home/user/workspace/repo/app/jobs/digest_job.rb:7` and `/home/user/workspace/repo/app/mailers/digest_mailer.rb:9-10`. The mailer's `requested_at.to_date` and `requested_at.all_day` depend on the zone.
- **What breaks:** 8.1's `TimeWithZoneSerializer` adds `"time_zone": "America/New_York"` to the payload. The deserialized `requested_at` keeps the reader's zone. Probe:
  - Baseline: `zone=UTC utc_offset=0 to_date=2026-10-05`
  - 8.1: `zone=America/New_York utc_offset=-14400 to_date=2026-10-04`

  The test `digests_controller_test.rb:33` fails with `expected "Your reading digest for October 05, 2026"` but got `"October 04, 2026"`. The comment in `digest_mailer.rb` and `digest_job.rb` says the day is UTC.
- **Applicability:** Immediately on the bump.
- **Recommended repair:**
  ```ruby
  DigestMailer.with(reader: reader, requested_at: requested_at.in_time_zone("UTC"), completion: completion).daily_digest.deliver_now
  ```
- **Validation:** Before the repair, the digest test fails. After it, the test passes and the decoded payload reports `zone=UTC to_date=2026-10-05` on both copies. Control: the "digest job cannot be queued" test passes.

### R15. `to_time` now preserves the zone rather than the offset
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:44`, `reminder_at.to_time + 86_400`. The comment at lines 40-42 documents the 7.0 offset-preserving behavior. The view is `app/views/notes/_reminder.html.erb:18-19`.
- **What breaks:** Probe, same instant (13:00 UTC), different representation:
  - Baseline: `2026-11-01 09:00:00 -0400`
  - 8.1: `2026-11-01 08:00:00 -0500` with zone `America/New_York`

  The test `reminders_controller_test.rb:21` fails with `Expected at least 1 element matching "#next_day_reminder time[datetime=\"2026-11-01T09:00:00-04:00\"]"`. The scheduled epoch is unchanged, so the job runs at the same moment; only the displayed time changes.
- **Applicability:** Immediately on the bump.
- **Recommended repair:**
  ```ruby
  Time.at(reminder_at.to_i + 86_400).getlocal(reminder_at.utc_offset)
  ```
  This reproduces the 7.0 value (`09:00 -0400`).
- **Validation:** Before the repair, the reminder test fails. After it, the `datetime` assertion passes. Control: the job `at` equals `Time.utc(2026, 10, 31, 13).to_i` and the postponement test passes.

### R16. BigDecimal job argument changes the queued payload format
- **Affected code:** `/home/user/workspace/repo/app/models/user.rb:41`, `DigestJob.perform_later(self, requested_at, reading_completion)`. `reading_completion` is a BigDecimal (lines 53-57).
- **What breaks:** 8.1 serializes the argument as `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}`. Baseline 7.0 writes the bare string `"0.5"`. A 7.0 worker reading an 8.1-enqueued job fails with `ActiveJob::DeserializationError: Serializer ActiveJob::Serializers::BigDecimalSerializer is not known`. The reverse direction works: a 7.0 payload decodes on 8.1 with `completion="0.5"` (String), which `BigDecimal(params[:completion])` accepts.
- **Applicability:** Immediately on the bump. Affects queued jobs during rollout.
- **Recommended repair:**
  ```ruby
  DigestJob.perform_later(self, requested_at, reading_completion.to_s)
  ```
  ActiveSupport's `BigDecimal#to_s` gives the same string as 7.0's `as_json`.
- **Validation:** The serialized argument is `"0.0"` on both copies. The repaired 8.1 payload decodes on the 7.0 baseline as `completion="0.5"` (String). Before the repair, a 7.0 worker raises `DeserializationError` on the 8.1 payload.

### R17. Annotations silently dropped in the import preview
- **Affected code:** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22`, `@import.annotations.stringify_keys`. Lines 42-45 look up `annotations[row.line]` with an Integer.
- **What breaks:** In 8.0, `stringify_keys` turns the Integer keys into strings, so the lookup returns nil and the annotation `<dd>` disappears without an error. Test `imports_controller_test.rb:22` fails with `Expected: "Read <b>twice</b> & reflect" Actual: "10.1000/Essays.1"`.
- **Applicability:** Immediately on the bump.
- **Recommended repair:** `<% annotations = @import.annotations %>`. On 7.0 the HWIA keeps Integer keys, so this is the same value.
- **Validation:** Before the repair, the annotation assertions fail. After it, `#line_2 dd` and `#line_4 dd` pass.

### R18. `json` dependency conflict breaks every JSON-backed cookie read
- **Affected code:** `/home/user/workspace/repo/Gemfile` (add near line 4). Affected flow: `app/controllers/application_controller.rb:8` (`session[:user_id]`) and any `ActiveSupport::JSON.decode`.
- **What breaks:** ActiveSupport 8.1.0 calls `::JSON.parse(json, options)` with a positional hash, and it declares an unconstrained `json` dependency. Bundler resolves `json 3.1.0`, whose `parse` accepts keywords only. Probe: `ActiveSupport::JSON.decode(%q({"a":1}))` raises `ArgumentError: wrong number of arguments (given 2, expected 1)` on 8.1 (`json-3.1.0/lib/json/common.rb:291`). Signed-in requests return 500.
- **Applicability:** Immediately on the bump. Pre-bump safe.
- **Recommended repair:**
  ```ruby
  gem "json", "~> 2.7"
  ```
- **Validation:** On the upgraded copy with the pin, `ActiveSupport::JSON.decode` returns `{"a"=>1}` and sign-in followed by `/notes` returns 200. The baseline lock already resolves `json 2.7.2`. The pin adds only a DEPENDENCIES line plus one `json (2.7.2)` entry, and the baseline suite passes (325 assertions, 0 failures).

### R19. Numeric `wait_until` removed
- **Affected code:** `/home/user/workspace/repo/app/models/note.rb:61`, `NoteReminderJob.set(wait_until: reminder_epoch).perform_later(self)`.
- **What breaks:** `NoMethodError: undefined method 'utc' for an instance of Integer`. Reminder scheduling fails (2 reminder tests).
- **Applicability:** Immediately on the bump. Works on 7.0.
- **Recommended repair:** `NoteReminderJob.set(wait_until: Time.at(reminder_epoch)).perform_later(self)`.
- **Validation:** Before the repair, both reminder tests error. After it, they pass. Control: the scheduled `at` equals `nine_eastern`.

### R20. Negative cache expiry raises under 8.1 defaults
- **Affected code:** `/home/user/workspace/repo/app/views/exports/_export.html.erb:26`, `cache [export, "availability"], expires_in: export.expires_at - Time.current`.
- **What breaks:** With `load_defaults 7.1+` (`raise_on_invalid_cache_expiration_time`), an expired export raises `ActionView::Template::Error: Cache expiration time is invalid, cannot be negative: -60.0`. Without the defaults, it is only reported.
- **Applicability:** When adopting `load_defaults 7.1` or later. The test exercises it under 8.1 defaults.
- **Recommended repair:** `cache [export, "availability"], expires_in: [export.expires_at - Time.current, 0].max do`. Only negative values raise, and zero is accepted.
- **Validation:** Before the repair, the cached-availability test errors under 8.1 defaults. After it, the test passes. Control: the "Download" link still appears for unexpired exports.

### R21. Read-only `slug` is assigned on update
- **Affected code:** `/home/user/workspace/repo/app/controllers/notebooks_controller.rb:40` permits `:slug`. `/home/user/workspace/repo/app/models/notebook.rb:8` declares `attr_readonly :slug`. The form resubmits it at `app/views/notebooks/_form.html.erb:13`.
- **What breaks:** With `load_defaults 7.1+` (`raise_on_assign_to_attr_readonly`), updating a notebook raises `ActiveRecord::ReadonlyAttributeError: slug`. Without the defaults, the value is silently ignored.
- **Applicability:** When adopting `load_defaults 7.1` or later.
- **Recommended repair:** `params.require(:notebook).permit(:name, :export_heading)`. Slug is still assigned on create by `before_validation :assign_slug, on: :create`, so create behavior is unchanged.
- **Validation:** Before the repair, the settings test errors under 8.1 defaults. After it, the test passes and the slug stays `novels`. Control: "creates a notebook owned by the reader with a slug from its name" passes.

### R22. `select_rows` returns `Date` objects under 7.2+ defaults
- **Affected code:** `/home/user/workspace/repo/app/models/notebook.rb:40`, `Date.iso8601(day)`.
- **What breaks:** With `postgresql_adapter_decode_dates = true` (7.2 defaults), `TypeError: no implicit conversion of Date into String`. The activity-report test errors under 8.1 defaults.
- **Applicability:** When adopting `load_defaults 7.2` or later.
- **Recommended repair:** `Note.connection.select_rows(days).map { |day, count| [Date.iso8601(day.to_s), count] }`.
- **Validation:** Before the repair, the test errors under defaults. After it, "a notebook's notes are counted by UTC creation date" passes on both.

### R23. `serialize :preferences` with no coder raises under 7.1+ defaults
- **Affected code:** `/home/user/workspace/repo/app/models/notebook.rb:7`.
- **What breaks:** With `default_column_serializer = nil` (7.1 defaults), the class fails to load with `ArgumentError: missing keyword: :coder If no default coder is configured, a coder must be provided to serialize`.
- **Applicability:** When adopting `load_defaults 7.1` or later.
- **Recommended repair:** `serialize :preferences, coder: YAML`. This keeps the stored format identical. Stored raw value on both copies: `"---\nexport_heading: Reading notes\n"`. On 7.0 the keyword is ignored, but 7.0's default is YAML, so this is safe before the bump too.
- **Validation:** Before the repair, the class fails under defaults. After it, the notebook tests pass under defaults.

### R24. Reminder-related and other behavior checks
- **Affected code:** `config/application.rb:24` (`queue_adapter = :sidekiq`) and `Gemfile:35` (`sidekiq 6.5.12`).
- **What breaks / what changes:** The built-in Sidekiq adapter is deprecated in 8.1, with the warning "will be removed in Rails 8.2." It still enqueues on `sidekiq 6.5.12`: the payload lands in `queue:default` as a `JobWrapper` with a `scheduled_at` key, and the deprecation is printed. Not an immediate break, but a 8.2 blocker.
- **Applicability:** Schedule after the bump.
- **Recommended repair (not part of this bump):** Upgrade the `sidekiq` gem to 7.3.3 or later so the gem's adapter is used. Note that `sidekiq 6.5.12` pins `rack ~> 2.0` and is the reason `rack` did not move. Upgrading Sidekiq would then bring in Rack 3 requirements (see section 4).
- **Validation:** Probe enqueued a `DigestJob` into the isolated Redis database on both copies. The deprecation text is printed on 8.1 only.

### Dependency and other notes
- **`rack` does not move.** The `gem-changes` claim that `rack` goes to 3.2.7 does not hold for this app. `sidekiq 6.5.12` requires `rack ~> 2.0`, so the locked version stays 2.2.24. `rack-session` 1.0.2 and `rackup` 1.0.1 are added. The Rack 3 items (`Rack::Session` moved, header arrays, Integer status, `values_at` removed) are therefore not in effect now.
- **Removed:** `method_source` (not referenced by the app). **Added:** `action_text-trix` 2.1.19, `bigdecimal` 4.1.3, `json`, `drb`, `uri`, `useragent`, `webrick`, `securerandom`. `net-imap` moves to 0.6.8.
- **Trix:** `app/views/layouts/application.html.erb:13` loads the vendored `trix-1.3.5.js` as a classic script (the comment documents why 1.3.5 is pinned). 8.1's `actiontext.esm.js` has no Trix import, so the pin still applies. The `action_text-trix` gem is not loaded by the layout. Browser behavior is not verified (system tests need Chrome).
- **Schema dump churn:** The 8.1 dumper reorders columns alphabetically and changes two lines (`enable_extension "pg_catalog.plpgsql"` and `ActiveRecord::Schema[8.1]`). Sorted line-by-line the dumps are identical otherwise.

---

## 2. New configuration defaults across intermediate releases

The app is on `config.load_defaults 7.0` (`/home/user/workspace/repo/config/application.rb:12`). None of the defaults below are active until `load_defaults` is raised. Values come from the `load_defaults` blocks in railties 8.1.0.

| Release | Default | Status in app | Later change in range | If adopted | What to configure |
|---|---|---|---|---|---|
| 7.1 | `active_record.raise_on_assign_to_attr_readonly = true` | Old value (silent ignore) | — | Raises on slug update (R21, verified) | Apply R21 first |
| 7.1 | `active_record.default_column_serializer = nil` | Old (YAML default) | — | Raises on `serialize :preferences` (R23, verified) | `coder: YAML` (R23) |
| 7.1 | `active_support.cache_format_version = 7.1` | Old (7.0) | — | 7.0 processes cannot read entries (verified: `TypeError: incompatible marshal file format`) | Keep 7.0 until rollback window closes |
| 7.1 | `active_support.message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | Old (`:marshal`) | — | 7.0 cannot read JSON-serialized messages (verified: `NoMethodError: undefined method 'unpack1' for nil`). Session cookies still readable (see section 3) | Keep until rollback window closes |
| 7.1 | `active_support.raise_on_invalid_cache_expiration_time = true` | Old | — | Raises on negative expiry (R20, verified) | Apply R20 |
| 7.1 | `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor = best_supported_vendor` (HTML5) | Old (HTML4) | — | Sanitizer becomes HTML5 once ActionView loads. Allowlist unchanged for this app (verified) | Set explicitly to the chosen vendor when adopting |
| 7.1 | `action_dispatch.default_headers` (X-XSS-Protection "0", Referrer-Policy, etc.) | Old | — | Changes response headers (not verified) | Review headers before adopting |
| 7.1 | `add_autoload_paths_to_load_path = false` | Old | — | Autoloaded paths leave `$LOAD_PATH` (not verified; tests pass) | Check any `require` of app files |
| 7.1 | `precompile_filter_parameters`, `dom_testing_default_html_version = :html5`, `log_file_size`, `debug_exception_log_level = :error` | Old | — | Test parsing and logs change; suite passes under 8.1 defaults | None required |
| 7.1 | `active_record.marshalling_format_version = 7.1` | Old | — | Marshal format of AR objects changes (not exercised) | Test any Marshal-cached records before adopting |
| 7.1 | `belongs_to_required_validates_foreign_key = false`, `before_committed_on_all_records = true`, `run_commit_callbacks_on_first_saved_instances_in_transaction = false`, `run_after_transaction_callbacks_in_order_defined = true`, `query_log_tags_format = :sqlcommenter`, `generate_secure_token_on = :initialize`, encryption digest/SHA-1 flags | Old | — | No app use found (no `encrypts`, `has_secure_token`, or `after_commit`); not individually exercised | None required |
| 7.2 | `active_record.postgresql_adapter_decode_dates = true` | Old | — | `select_rows` returns Date (R22, verified) | Apply R22 |
| 7.2 | `active_record.validate_migration_timestamps = true` | Old | — | Affects new migrations only | None required |
| 7.2 | `active_storage.web_image_content_types` (png, jpeg, gif, webp) | Old | — | Affects image preview handling (not exercised) | Review if image uploads are used |
| 7.2 | `yjit = true` | Old | — | Performance only | Measure memory before adopting |
| 8.0 | `Regexp.timeout = 1` | Old | — | Regex longer than 1 second raises `Regexp::TimeoutError`. Not exercised; DOI validation regex is `citation.rb:9` | Confirm no slow regexes on user input |
| 8.0 | `action_dispatch.strict_freshness = true` | Old | — | Changes freshness with `ETag`/`Last-Modified` (not exercised) | Review `fresh_when`/`stale?` use |
| 8.1 | `action_controller.escape_json_responses = false` | Old | — | No `render json` or `to_json` in app (grep) | None required |
| 8.1 | `action_controller.action_on_path_relative_redirect = :raise` | Old | — | No relative string redirects found (grep) | None required |
| 8.1 | `active_record.raise_on_missing_required_finder_order_columns = true` | Old | — | All models have `id`, so `first`/`last` do not raise (not exercised) | None required |
| 8.1 | `action_view.remove_hidden_field_autocomplete = true` | Old | — | Hidden inputs drop `autocomplete="off"`. Not asserted by tests | None required |
| 8.1 | `active_support.escape_js_separators_in_json = false`, `action_view.render_tracker = :ruby`, `yjit = !Rails.env.local?` | Old | — | No script-embedded JSON found; dev-only tooling | None required |

Notes:
- The 7.1 `:polynomially_longer` symbol and the `coder:` keyword for `serialize` are available only from 7.1. R3 and R13 are version-sensitive for this reason.
- Under `--defaults 8.1` with R1–R23 applied, the suite passes (46 runs, 340 assertions, 0 failures).
- The following configuration in `config/` is deprecated or removed in the range: `show_exceptions = false` (R7), `Rails.application.secrets` (R6), `config/secrets.yml` (now read only through `config_for`), and `active_job.queue_adapter = :sidekiq` (R24).

---

## 3. Rollout, rollback, and mixed-version risks

**Database and schema.** No migrations are added. Stored data is unchanged for the repairs in this plan:
- `notebooks.preferences` stays YAML when `coder: YAML` is used (raw value identical on both copies).
- `notes.tags` stays JSON.
- Enum integers are unchanged (`Note.statuses` `{"draft"=>0, "ready"=>1}`).
- R11 matters for data. If 8.1 runs without R11 in production, partial imports (an `imports` row, notes, and rich-text bodies) can be committed. Those rows need cleanup.
- Do not regenerate `db/schema.rb` with the 8.1 dumper during the bump. It reorders columns and writes `Schema[8.1]` and `pg_catalog.plpgsql`. I did not verify that 7.0 can load these lines.

**Redis and Sidekiq queues.**
- Native `ExportJob` (`app/jobs/export_job.rb`, `Sidekiq::Job`) is unaffected by ActiveJob serialization. Its options are passed as JSON with string keys.
- ActiveJob payloads: 8.1 adds `time_zone` to time arguments and `scheduled_at` to the job hash. A 7.0 worker decodes the `time_zone`-tagged payload and `scheduled_at` (verified on a `NoteReminderJob` payload).
- BigDecimal (R16) is the one incompatible payload. Apply R16 before the bump, or 7.0 workers fail with `DeserializationError` on 8.1-enqueued digest jobs.
- The digest reservation set (`digest_requests:<date>` in `app/models/user.rb:34-51`) is unchanged.

**Cache entries.** The app uses default fragment caching for the export availability partial (`exports/_export.html.erb:26`). No cache store is set in production (`config/environments/production.rb` has it commented out).
- Under `load_defaults 8.1`, entries are written in the 7.1 format. A 7.0 process reading them raises `TypeError: incompatible marshal file format` (verified, `FileStore#read`). Rolling back to 7.0 after adopting these defaults therefore needs the cache cleared.
- With `load_defaults 7.0`, 8.1 reads and writes 7.0-format entries in both directions (verified).
- Redis-backed caches were not tested.

**Signed and encrypted cookies and tokens.**
- Session cookies are compatible in both directions. With a shared secret (`tmp/local_secret.txt` on upgraded and `tmp/development_secret.txt` on baseline), a cookie from either copy returns 200 on `/notes` on the other, both with `load_defaults 7.0` and with 8.1 defaults.
- Generic signed messages written with 8.1 defaults (JSON serializer) are unreadable by 7.0 (`NoMethodError: undefined method 'unpack1' for nil`). 7.0 messages are readable by 8.1 with or without defaults. This matters only after adopting `load_defaults 7.1`.
- Signed IDs for Active Storage were not exercised.

**Recommended rollout.**
1. Ship R1–R6, R8–R19, R20–R23 (as applicable), and the `json` pin (R18) on 7.0. Each was validated on the 7.0 baseline.
2. Bump to 8.1.0 with `load_defaults 7.0`. Include R3 (`coder: JSON` on tags), R7 (`show_exceptions = :none`), and R24 scheduling. Keep `show_exceptions = false` on 7.0.
3. Roll back safely to 7.0 at any point in step 2 (no format changes with `load_defaults 7.0`).
4. Adopt `load_defaults` in increments only after all processes run 8.1, and clear the cache when rolling back a defaults change.

---

## 4. Verification log and open questions

### Checks executed in `upgrade-workspace`

All commands ran from the application directory (`/home/user/workspace/repo`), with the workspace at `/tmp/upgrade-rails-8.1.0`.

**Setup and change summary.**
- `ruby /home/user/planner-run/maintain-rails/bin/gem-changes rails 7.0.8.7 8.1.0` (full output at `/home/user/planner-run/claude-config/projects/-home-user-workspace-repo/b70d47d4-38b9-4117-b28a-c89d464cc2ef/tool-results/b9gi0d83p.txt`).
- `ruby /home/user/planner-run/maintain-rails/bin/upgrade-workspace setup rails 7.0.8.7 8.1.0`. Output saved to `/tmp/upgrade-rails-setup-stdout.log`. Bundle resolved, 25 gems changed. Baseline: boot OK, eager load OK, 67 routes, 46 runs, 325 assertions, 0 failures. Upgraded: boot FAILED at `config/initializers/action_text.rb:3`.

**Resolved versions (from `Gemfile.lock`).**
- Baseline: rails 7.0.8.7, rack 2.2.24, sidekiq 6.5.12, redis 4.8.1, faraday 1.10.4, pagy 8.6.3, puma 5.6.9, rails-html-sanitizer 1.7.1, json 2.7.2 (default gem).
- Upgraded: rails and all rails components 8.1.0, action_text-trix 2.1.19, json 3.1.0 (unpinned; 2.7.2 with R18), bigdecimal 4.1.3, rack 2.2.24, rack-session 1.0.2, rackup 1.0.1, nokogiri 1.19.4, turbo-rails 2.0.12, stimulus-rails 1.3.4, importmap-rails 2.2.3, sprockets-rails 3.5.2, minitest 5.27.0.

**Test runs (upgraded, cumulative edits; `reset` was not used).**

| Run | Change applied in this run | Result |
|---|---|---|
| `test --target upgraded` (1) | R1 | boot OK, eager load FAILED (`note.rb:10`), routes 0, 46 errors |
| (2) | R2, R3-positional, R4 | eager load OK, routes 63, 35 assertions, 20 failures, 25 errors |
| (3) | R5, R7 (`:none`), R6 | 11 assertions, 4 failures, 41 errors (JSON decode) |
| (4) | R18 pin, R8 | 209 assertions, 3 failures, 10 errors |
| (5) | R9, R10, R19, preview | 305 assertions, 4 failures, 1 error |
| (6) | R11–R15, R17 | 340 assertions, 0 failures, 0 errors |
| `--defaults 8.1` (1) | — | 46 errors (`serialize` requires coder) |
| `--defaults 8.1` (2) | R23 | 325 assertions, 3 errors (cache expiry, slug readonly, `Date.iso8601`) |
| `--defaults 8.1` (3) | R20–R22 | 340 assertions, 0 failures, 0 errors |
| `--target baseline` with patch (1) | R1–R23 patch applied to 7.0 copy | 23 failures (`show_exceptions = :none`) |
| (2) | `show_exceptions = false` restored | 204 assertions, 1 failure, 15 errors (`serialize :tags, coder:`) |
| (3) | positional `serialize :tags, JSON` restored | 317 assertions, 0 failures, 1 error (`:polynomially_longer`) |
| `--target both` with lambda retry (R13) | lambda on both copies | baseline 325 assertions, 0 failures; upgraded 340, 0 failures |
| `--target baseline` with `json` pin (R18) | Gemfile pin on 7.0 | 325 assertions, 0 failures |

Logs: the per-run `logs/` directory under `/tmp/upgrade-rails-8.1.0` was deleted by `cleanup`. Surviving outputs are `/tmp/upgrade-rails-8.1.0-test*.out`, `/tmp/upgrade-rails-8.1.0-baseline-with-repairs*.out`, `/tmp/upgrade-rails-8.1.0-both-lambda.out`, `/tmp/upgrade-rails-8.1.0-test-defaults*.out`, and `/tmp/probe-*.out`.

**Probes (`upgrade-workspace probe`).**
- Boot/defaults: `to_time`, job-argument time, `citation[:id]`, and `sum` (`/tmp/probe-time.out`); `Import#apply` (`/tmp/probe-import-apply.out`); `show_exceptions` on a missing note (`/tmp/probe-showexc2.out`).
- Defaults inventory: `/tmp/probe-defaults.out`, `/tmp/probe-sanit.out`, `/tmp/probe-vendor.out`. Under 8.1 defaults the ActionView-loaded sanitizer is HTML5 and the allowlist is unchanged. `ActiveJob::Base.enqueue_after_transaction_commit` is `false` with and without defaults, so the enqueue-inside-`with_lock` logic in `Citation#request_enrichment` and `Note#schedule_reminder` is unchanged.
- Cache and messages: `/tmp/probe-cache-write.out`, `/tmp/probe-cache-read.out`, `/tmp/probe-msg-gen.out`, `/tmp/probe-msg-read.out`.
- Cookies: `/tmp/probe-cookie-gen.out`, `/tmp/probe-cookie-70.out`, `/tmp/probe-cookie-81.out`, `/tmp/probe-cookie-d81.out`, `/tmp/probe-cookie-70-d81.out`.
- Jobs: `/tmp/probe-payload-gen.out`, `/tmp/probe-deser-*.out`, `/tmp/probe-args-*.out`, `/tmp/probe-repaired-payload.out`, `/tmp/probe-bigdec.out`, `/tmp/probe-sidekiq.out`.
- Schema and routes: `/tmp/probe-schema.out` and the route diff (`/tmp/routes-b.txt` versus `/tmp/routes-u.txt`).
- Enum parity: `/tmp/probe-routes-full.out` and the enum probe output in this log.

**Other checks.** `bundle lock --local` on the upgraded and baseline copies (both with the `json` pin); `cleanup rails 8.1.0` (`/tmp/upgrade-rails-cleanup.out`). Working checkout `git status` is clean.

The repair patch is at `/tmp/rails-8.1-repairs-upgraded.patch` (Gemfile, app, config, test).

### Corrections to `gem-changes`
- The `rack` version claim is wrong for this app (see section 1).
- Some matches are false positives. `app/models/export.rb:34` and `:39` (`return`) are not inside a transaction, because `start` and `record_progress` return before the `with_lock` block exits. `app/models/citation/provider.rb:44` matched the Rack header text, not a Rack API. `app/models/citation.rb:7` and `export.rb:10` already use the new `enum` syntax.
- Some real breaks were missing from the textual matches: `notes_controller.rb:12` (only in the "no textual match" list), `user.rb:41` (BigDecimal argument), `notebook.rb:7` (7.1 default serializer), and `import.rb:68` (`read_attribute(:id)`).
- The `gem-changes` run skipped 65 gem archive reads (13 components across 5 releases) with `"... is not an octal string"`. The cached `.gem` files in `/home/user/.cache/gem-changes/` do not parse. As a result, the rails `lib/` changes and the commit-level analysis are absent for this upgrade.

### Unverified claims and open questions
- Production boot and production-only settings (`production.rb` logger assignments, `report_deprecations`, asset compilation). Eager load was checked in the test environment only.
- Browser and system tests (Trix behavior, Turbo, importmap, autocomplete). `bin/rails test:system` was not run.
- `Regexp.timeout = 1` (8.0 defaults) and the DOI validation regex under load.
- Active Storage: signed blob IDs, preview changes, `web_image_content_types`.
- Marshal format under `marshalling_format_version = 7.1` for cached AR objects.
- Default response headers under 7.1 defaults.
- Sidekiq 7.3.3+ upgrade. It would lift the `rack ~> 2.0` pin and bring in Rack 3 changes (Rack::Session, header arrays, Integer status, lowercase headers), which were not evaluated.
- Redis cache store (only file store was tested).
- Assertion counts differ (325 on baseline vs 340 on upgraded) for the same tests. I did not determine the cause.
- Whether a newer `activesupport` 8.1.x patch or `json` release fixes the R18 incompatibility upstream.

---

Notes from me, after the plan:

- **Scope:** This run planned the upgrade only, as the upgrade-gem skill requires. I did not change `Gemfile`, `Gemfile.lock`, or any app code. `git status` is clean and `Gemfile.lock` still reads `rails (7.0.8.7)`.
- **Next step:** You asked for the upgrade itself. Applying it means the pre-bump repairs (R1–R6, R8–R22, R18 pin) first, then the 8.1.0 bump with the bump-time changes (R3, R7), and running `bin/rails test` after each stage. Say the word and I'll start that, on a branch.
- **Not verified:** Browser/system tests (`bin/rails test:system`) and production boot were not run.