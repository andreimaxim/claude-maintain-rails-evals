## Upgrade plan: rails 7.0.8.7 to 8.1.0 for `/home/user/workspace/repo`

**Bottom line**

- The upgrade is feasible, but a Gemfile-only bump fails. The unmodified app stops at boot on `config/initializers/action_text.rb:3`, and after the boot fixes it has about two dozen behavior breaks.
- With the repairs below, the upgraded suite passes at 46 runs, 340 assertions, 0 failures, 0 errors, both with the current `load_defaults 7.0` and with `load_defaults 8.1`.
- Most repairs also work on 7.0.8.7. With all of them applied, the baseline suite still passes (46 runs, 325 assertions, 0 failures), so they can ship before the bump.
- The `gem-changes` text matcher missed several silent problems: partial import commits, a blank receipt DOI column, missing import annotations, a digest that covers the wrong day, and a `:format` symbol key that Sidekiq 7 rejects.
- Dependency chain: `json 3.1.0` breaks ActiveSupport JSON decoding, and `sidekiq 6.5.12` pins `rack ~> 2.0`. Rack 3 therefore needs Sidekiq 7 and Puma 6. For the bump I recommend staying on Rack 2.2.24 with Sidekiq 6.5.12 and Puma 5.6.9.
- The application checkout is unmodified (`git status` clean). All experiments ran in the disposable workspace, which cleanup removed.

---

## 1. Required changes for the upgrade

### 1a. Gems and bundle (on bump)

**F1. `json 3.1.0` breaks every JSON attribute read.** Introduced by the bump's dependency resolution. The bundle resolves `json 3.1.0` because `activesupport 8.1.0` declares `json >= 0`.
- Affected: `/home/user/workspace/repo/Gemfile` (no json pin); every tag read through `/home/user/workspace/repo/app/models/note.rb:12`.
- What breaks: `ArgumentError: wrong number of arguments (given 2, expected 1)` at `json-3.1.0/lib/json/common.rb:291:in 'parse'`, called from `activesupport-8.1.0/lib/active_support/json/decoding.rb:25` through `activerecord-8.1.0/lib/active_record/coders/json.rb:20`. ActiveSupport 8.1 calls `::JSON.parse(json, options)` with a positional hash, and json 3.1.0 accepts only keywords. Probe: `Note.new(title: "t", tags: ["a"]).save` then reload raises this error under 8.1 and returns `["a"]` with json 2.7.2.
- Applicability: on the bump only. Baseline does not load json 3.1.0 (Ruby 3.3 default json 2.7.2).
- Recommended repair, in `/home/user/workspace/repo/Gemfile` directly after `gem "rails", ...`:
  ```ruby
  gem "json", "2.7.2"
  ```
- Validation: after the bump, `notes(:middlemarch).tags` must equal `["Victorian", "marriage"]` (fixture `test/fixtures/notes.yml`). It raises `ArgumentError` with json 3.1.0 and passes with 2.7.2. Control: `Note.new(tags: [])` round-trips to `[]`.

**F2. Sidekiq, Puma, and Rack constraints.** The Gemfile pins `sidekiq 6.5.12` (`rack ~> 2.0`) and `puma ~> 5.0`.
- Affected: `/home/user/workspace/repo/Gemfile`.
- What the bundle does: the resolved lock keeps `rack 2.2.24`, so the `gem-changes` prediction that rack moves to 3.2.7 does not happen. If you force Rack 3 with Puma 5, the app fails at `config/application.rb:7` with `StandardError: Puma 5 is not compatible with Rack 3, please upgrade to Puma 6 or higher.`
- Validated path A (recommended for the bump): keep `rack 2.2.24`, `puma 5.6.9`, `sidekiq 6.5.12`, and add the json pin from F1. This run passed 46 runs, 340 assertions, 0 failures under both `load_defaults 7.0` and `8.1`, before the last few preparatory repairs were added. Those last repairs are validated on the baseline and on path B, but not re-run on path A.
- Validated path B (later step): `sidekiq 7.3.9` (`rack >= 2.2.4`), `puma ~> 6.6` (resolved 6.6.1), and `rack 3.2.7` (resolved). This needs the Sidekiq 7 repairs F17, F20, and F24 and passed 46 runs, 340 assertions, 0 failures, both with and without `load_defaults 8.1`.
- Recommended repair for path B only:
  ```ruby
  gem "sidekiq", "7.3.9"
  gem "puma", "~> 6.6"
  ```
- Validation: with `rack 3.2.7` and `puma 5.6.9`, `bin/rails` boot fails with the Puma message above. With the path B gems, boot passes. Control: `GET /notes` returns 200 in both paths.

### 1b. Boot and load failures (fix at or before the bump)

Each of these is either verified on baseline or stated as "works on 7.0" in the table.

**F3. Action Text allowlist.** `/home/user/workspace/repo/config/initializers/action_text.rb:3`.
- What breaks: 8.1 defaults `ActionText::ContentHelper.allowed_tags` to nil, so `+=` fails with `NoMethodError: undefined method '+' for nil`. This is the boot failure in `setup`.
- Works on 7.0: yes (baseline suite passes).
- Repair:
  ```ruby
  ActionText::ContentHelper.allowed_tags ||= ActionText::ContentHelper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  ActionText::ContentHelper.allowed_tags += %w[ details summary ]
  ```
- Validation: `ActionText::ContentHelper.allowed_tags` includes `"details"` (48 entries). Test "rich text keeps collapsible excerpts and drops unsafe markup" in `test/controllers/notes_controller_test.rb` must keep `details` and `summary`, and drop `script`, `onclick`, and `javascript:`. Control: test "edits a note's rich body" keeps `figure` attachments.

**F4. Keyword-form `enum`.** `/home/user/workspace/repo/app/models/note.rb:10`.
- What breaks: `ArgumentError: wrong number of arguments (given 0, expected 1..2) (app/models/note.rb:10:in '<class:Note>')`. The old `_prefix:` keyword form was removed in 8.0.
- Works on 7.0: yes.
- Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`
- Validation: `Note.new(status: :ready).status_ready?` is true, and `Note.statuses` equals `{"draft"=>0, "ready"=>1}`. Control: the notes filter `?status=ready` in `test/controllers/notes_controller_test.rb` still returns only ready notes.

**F5. Positional `serialize` coder.** `/home/user/workspace/repo/app/models/note.rb:12`.
- What breaks: `ArgumentError: wrong number of arguments (given 2, expected 1) (app/models/note.rb:12:in '<class:Note>')`.
- Works on 7.0: `serialize :tags, coder: JSON` does NOT work on 7.0 (the keyword is ignored and the raw string is returned, which breaks 8 baseline tests). Use the attribute type instead.
- Repair: `attribute :tags, :json`
- Stored format change: 7.0 wrote `"[\"\\u003cb\\u003e\\u0026\",\"a\"]"`; with `attribute :tags, :json` on 8.1 it writes `"[\"<b>&\",\"a\"]"`. Both decode to the same array.
- Validation: `Note.new(tags: ["<b>&", "a"])` then reload returns `["<b>&", "a"]`. Control: test "edits a note's rich body, tags, highlight, and status" asserts `["provincial life", "Victorian", "reform"]`.

**F6. `alias_attribute` on a store accessor.** `/home/user/workspace/repo/app/models/note.rb:14`.
- What breaks: `ArgumentError: AliasProbeNote model aliases 'color', but 'color' is not an attribute. Use alias_method :highlight_color, :color or define the method manually.` `color` is a `store_accessor` key inside `settings`, not a column.
- Works on 7.0: yes (probe returns `[{"color"=>"green"}, "green"]`).
- Repair:
  ```ruby
  alias_method :highlight_color, :color
  alias_method :highlight_color=, :color=
  ```
- Validation: `Note.new(title: "t", highlight_color: "green")` gives `settings == {"color"=>"green"}` and `highlight_color == "green"` on both versions. Test "edits a note's rich body, tags, highlight, and status" asserts `{ "color" => "green" }`.

**F7. Multi-path route.** `/home/user/workspace/repo/config/routes.rb:18`.
- What breaks: `ArgumentError: Wrong number of arguments (expect 1, got 2)` at `routes.rb:18`, which stops route drawing. Every test using `notes_path` then errors with `NameError`.
- Works on 7.0: yes. Splitting the line keeps route names `notes` and `journal`.
- Repair:
  ```ruby
  get "/notes", to: "notes#index"
  get "/journal", to: "notes#index"
  ```
- Validation: `journal_path == "/journal"`, `notes_path == "/notes"`. Test "lists the reader's notes newest first at both list paths" must pass. The route count drops from 67 to 63. The four missing routes are Action Mailbox conductor routes from the framework engine, not application routes.

**F8. `Rails.application.secrets` removed in 7.2.** `/home/user/workspace/repo/app/models/citation/provider.rb:13`, and in the test helper `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb` (lines 45, 117, 118, 122).
- What breaks: `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application ...>`. This breaks the production provider default and every citation enrichment test.
- Works on 7.0: yes, with a new file that reads `config_for(:secrets)`.
- Repair, new file `/home/user/workspace/repo/config/initializers/citation_provider.rb`:
  ```ruby
  Rails.application.config.x.citation_provider = Rails.application.config_for(:secrets).fetch(:citation_provider)
  ```
  Provider default becomes `Rails.application.config.x.citation_provider.to_h`. The test helper uses `Rails.application.config.x.citation_provider` in place of `Rails.application.secrets.citation_provider`.
- Validation: `Citation::Provider.new` reads the configured URL `http://127.0.0.1:9393` on both versions. Test "fetches a manually entered DOI's title and source URL, retrying one unavailable response" must keep the two-request retry, and "a provider that stays unavailable" must keep six requests.

**F9. `form_with(model: nil)`.** `/home/user/workspace/repo/app/views/notes/index.html.erb:12`.
- What breaks: `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. Probe: `ArgumentError` from `form_with(model: nil, ...)` on 8.1.
- Works on 7.0: yes. Baseline HTML is `<form action="/notes" accept-charset="UTF-8" method="get">`.
- Repair: `<%= form_with(url: notes_path, method: :get, class: "search", html: { role: "search" }) do |form| %>`
- Validation: test "renders an unbound search form" asserts `form[role=search][action="/notes"][method=get]` and `input[type=search][name=query]`. Control: the other form fields are still named `notebook_id`, `status`, and `per_page`.

**F10. Plural association name in `where`.** `/home/user/workspace/repo/app/controllers/notes_controller.rb:12`.
- What breaks: `ActiveRecord::StatementInvalid: PG::UndefinedColumn: ERROR:  column notes.notebooks does not exist` for `?notebook_id=...`. Tests "filters by notebook, status, and title" and "pages through filtered notes" fail.
- Works on 7.0: yes. Plural-name support was deprecated in 7.1 and removed in 7.2.
- Repair: `@notes = @notes.where(notebook: @notebook)`
- Validation: `?notebook_id=novels` returns "Middlemarch chapter notes" and excludes "Montaigne on friendship". Control: no notebook parameter returns all of the reader's notes but not another reader's notes.

**F11. `Enumerable#sum` on strings.** `/home/user/workspace/repo/app/models/export.rb:42`.
- What breaks on 8.1: `TypeError: String can't be coerced into Integer` (`app/models/export.rb:42:in '+'`). Export generation fails. The worker records no file and the export stays `working`.
- Baseline: `DEPRECATION WARNING: Rails 7.0 has deprecated Enumerable.sum ... (called from generate at .../export.rb:42)` in `tests-baseline.log`.
- Repair: `finish(fragments.join)`
- Validation: test "a reader exports a notebook as Markdown and downloads it" asserts the exact body `"# Victorian reading\n\n## Middlemarch chapter notes\n\nDorothea and Casaubon.\n\n## Daniel Deronda\n\nGwendolen at the roulette table.\n"`. Control: test "cancelling a queued export means the worker writes no file".

**F12. Partial import commit (silent data bug).** `/home/user/workspace/repo/app/models/import.rb:50-60`.
- What breaks on 8.1: the `return false` inside `transaction do` now commits the transaction. Rails 7.2 removed the rollback-on-`return`, and it was the only `return` inside a transaction in the app. An invalid row therefore leaves the import, the valid rows, their citations, and their rich text saved. The controller then responds 422 claiming "Nothing has been saved."
- Observed: `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]` (`[Import, Note, Citation, RichText]`) in `test/controllers/imports_controller_test.rb`, test "invalid rows are shown with their errors, and applying them saves nothing" (line 65).
- Baseline: rollback, so the test passes.
- Repair, works on both:
  ```ruby
  def apply
    return false if invalid?

    applied = false
    transaction do
      save!
      applied = rows.all? { |row| row.note.save }
      raise ActiveRecord::Rollback unless applied
    end
    applied
  end
  ```
- Validation: the failing-row test must keep `record_counts` at `[0, 3, 0, 1]`. Control: test "previews a CSV without saving, then imports every row" still creates 2 notes, 1 citation, and 1 import from the three-row file with the shared DOI `10.1000/Essays.1`.

**F13. Receipt DOI column blank (silent).** `/home/user/workspace/repo/app/models/import.rb:68`.
- What breaks on 8.1: `citation[:id]` reads an `id` attribute that `citations` does not have, so it returns nil. Probe: `Citation.new(doi: "10.1000/x")[:id]` is `"10.1000/x"` on baseline and `nil` on 8.1. The CSV receipt has a blank DOI column. Test "previews a CSV ... offers a receipt" expects `"title,doi\nOn idleness,10.1000/Essays.1\n..."` and gets `"On idleness,\nOf experience,\n"`.
- Repair: `csv << [ note.title, citation&.doi ]`
- Validation: receipt body equals the expected CSV above. Control: a note with no citation produces an empty DOI cell (not covered by a test; add one).

**F14. Import preview annotations missing (silent).** `/home/user/workspace/repo/app/views/imports/preview.html.erb:22`.
- What breaks on 8.1: `HashWithIndifferentAccess#stringify_keys` now converts integer keys to strings. The preview looks up `annotations[row.line]` with an integer, so the annotation `<dd>` disappears. Probe: `h[2]="Read twice"`, `h.stringify_keys[2]` is `"Read twice"` on baseline and `nil` on 8.1.
- Observed failures: "Expected 'Read <b>twice</b> & reflect', Actual '10.1000/Essays.1'" (test "previews a CSV ..." line 22) and "Expected 'Second reading'" (test "invalid rows ..." line 62).
- Repair: `<% annotations = @import.annotations %>`
- Validation: `#line_2 dd` contains "Read <b>twice</b> & reflect" and `#line_3 dd` contains "Second reading". Control: the DOI `<dd>` for line 2 is still rendered.

**F15. Digest covers the wrong day (silent).** `/home/user/workspace/repo/app/mailers/digest_mailer.rb:7-8`.
- What breaks on 8.1: a `TimeWithZone` argument is restored in its serialized zone. For a reader in `America/New_York` the job restores `2026-10-04T23:30:00-04:00` in `America/New_York`, so `to_date` is October 4 instead of October 5 UTC. Probe: deserialized zone is `UTC` on baseline and `America/New_York` on 8.1 for a payload with a `"time_zone"` key.
- Observed: subject "Your reading digest for October 04, 2026" where the test expects "October 05, 2026" (`test/controllers/digests_controller_test.rb:33`). The UI text says the digest covers the UTC day.
- Repair: add one line after `requested_at` is assigned: `requested_at = requested_at.utc`
- Validation: the Eastern reader requesting at 2026-10-05 03:30 UTC gets subject "October 05, 2026" and the 2026-10-04 16:00 UTC ready note. Control: the second request on the same UTC day is refused.

**F16. Queued digest payload 7.0 cannot read (rollback hazard).** `/home/user/workspace/repo/app/models/user.rb:41`.
- What breaks: 8.1 serializes the `BigDecimal` argument as `{"_aj_serialized"=>"ActiveJob::Serializers::BigDecimalSerializer","value"=>"0.5"}`. 7.0 writes `"0.5"`. A 7.0 worker raises `ActiveJob::DeserializationError: Error while trying to deserialize arguments: Serializer ActiveJob::Serializers::BigDecimal...`.
- Repair, works on both (`["0.5"]` on both, and the mailer's `BigDecimal(params[:completion])` is unchanged):
  ```ruby
  DigestJob.perform_later(self, requested_at, reading_completion.to_s("F"))
  ```
- Validation: `ActiveJob::Arguments.serialize([BigDecimal("0.5").to_s("F")])` equals `["0.5"]` on both versions. Control: test "a reader can request one digest per UTC day" still checks the job's time argument `"2026-10-04T23:30:00.000000000-04:00"`.

**F17. Reservation check on Sidekiq 7 (only with path B).** `/home/user/workspace/repo/app/models/user.rb:38`.
- What breaks: `Sidekiq.redis { |r| r.sadd(...) }` returns `true`/`false` on Sidekiq 6.5 and `1`/`0` on Sidekiq 7.3.9. `0` is truthy in Ruby, so a repeated request is accepted. Observed: the second `POST /digest` on the same day says "Today's reading digest is on its way." instead of "You have already requested today's reading digest." (`digests_controller_test.rb:21`). `sadd?` does not exist on Sidekiq 7 (`ERR unknown command 'sadd?'`).
- Repair, works on both:
  ```ruby
  added = Sidekiq.redis { |redis| redis.sadd(key, id) }

  if added.is_a?(Integer) ? added.positive? : added
  ```
- Validation: after the change, the second request in the same UTC day gets the "already requested" notice. Control: the first request of a new UTC day still queues `DigestJob`.

**F18. Reminder scheduling with an integer epoch.** `/home/user/workspace/repo/app/models/note.rb:61`.
- What breaks on 8.1: `NoMethodError: undefined method 'utc' for an instance of Integer` (`schedule_reminder`). `POST /notes/:id/reminder` returns 500.
- Works on 7.0: `Time.at(...)` is accepted on both.
- Repair: `job = NoteReminderJob.set(wait_until: Time.at(reminder_epoch)).perform_later(self)`
- Validation: `enqueued_jobs.sole[:at]` equals 1793451617 for the imported reminder (test "an imported reminder is scheduled at its exact time"). Control: "a reminder needs a time" creates no job.

**F19. Postponed reminder display changes (silent).** `/home/user/workspace/repo/app/models/note.rb:44`.
- What breaks on 8.1: `to_time` returns the reader's local wall clock. For the Eastern reminder on 2026-10-31 09:00 EDT, "24 hours later" renders as `2026-11-01T08:00:00-05:00` instead of `2026-11-01T09:00:00-04:00`. The epoch 1793538000 is the same, so scheduling does not change.
- Observed: test "a reader schedules a reminder..." fails at `reminders_controller_test.rb:21`.
- Repair, which keeps the documented offset semantics on both versions:
  ```ruby
  def next_day_reminder_at
    Time.at(reminder_epoch + 86_400).getlocal(reminder_at.utc_offset)
  end
  ```
- Decision required: keep the offset (this repair) or adopt 8.1's local wall clock and update the comment and the test. This is a product decision, not a bug.

**F20. Export job argument keys (only with path B).** `/home/user/workspace/repo/app/models/notebook.rb:26`.
- What breaks on Sidekiq 7: `ArgumentError: Job arguments to ExportJob must be native JSON types, but :format is a Symbol.`
- Repair (works on both; Sidekiq 6 already JSON-round-trips the key, and `ExportJob` already reads `options.fetch("format")`):
  ```ruby
  export.update!(job_id: ExportJob.perform_async(export.id, { "format" => "markdown" }))
  ```
- Validation: `ExportJob.jobs.sole["args"]` equals `[export.id, {"format"=>"markdown"}]` (test "a reader exports a notebook..."). Control: the cancellation test still drains an empty queue.

**F21. Retry backoff name (upgrade time).** `/home/user/workspace/repo/app/jobs/citation_enrichment_job.rb:7`.
- What breaks: `RuntimeError: Couldn't determine a delay based on :exponentially_longer` on the first retry. Removed in 7.2; `:polynomially_longer` was introduced in 7.1 and is the same formula.
- Repair: `retry_on Citation::Provider::Unavailable, wait: :polynomially_longer, attempts: 3 do |job, error|`
- Works on 7.0: no. Keep `:exponentially_longer` until the bump.
- Validation: "a provider that stays unavailable ... leaves a visible failure" must see 6 requests for 3 attempts. Control: "fetches a manually entered DOI ..." still performs the single retry on 503.
- Mixed-version note: a 7.0 worker running this class fails only when a retry is needed. Deploy the bump to all workers together, or use a lambda with identical timing if a window is unavoidable (not verified).

**F22. `show_exceptions` values (upgrade time, test environment only).** `/home/user/workspace/repo/config/environments/test.rb:31`.
- What breaks on 8.1: `false` now means "show everything", so `ActiveRecord::RecordNotFound` is rendered as a 404 page instead of raised. Eight tests fail with "RecordNotFound expected but nothing was raised". Probe for another reader's note: `false` gives `status 404` on 8.1 and `raised ActiveRecord::RecordNotFound` on baseline.
- On 7.0, `:none` is truthy and renders a 404, so the change must go with the bump.
- Repair: `config.action_dispatch.show_exceptions = :none`
- Validation: test "another reader's notes and notebooks cannot be reached" passes. Control: normal pages still render.

**F23. Trix and Action Text JavaScript (unverified).** `/home/user/workspace/repo/app/views/layouts/application.html.erb:13`.
- Current state: the layout loads the vendored `trix-1.3.5.js` (`/home/user/workspace/repo/vendor/javascript/trix-1.3.5.js`). The bump adds `action_text-trix 2.1.19` to the lock. Action Text 8.1's JavaScript listens for `trix-attachment-add`.
- Unverified: no browser was run and `bin/rails test:system` was not run.
- Action: decide whether to keep Trix 1.3.5 or move to the gem's Trix 2 asset, then check editing and attachments in a browser.

**F24. Rack 3 header case in custom Rack stand-ins (path B only).** `/home/user/workspace/repo/test/controllers/citation_enrichments_controller_test.rb` (lambda) and `/home/user/workspace/repo/bin/citation-provider`.
- What breaks: `Rack::Lint::LintError: uppercase character in header name: Content-Type` under Rack 3.2.7.
- Repair (works on Rack 2 and 3): `{ "content-type" => "application/json" }`.
- Validation: `Rack::Lint.new(app)` passes for the lambda. Control: citation enrichment tests still pass. `bin/citation-provider` was not run end to end.
- Puma events constructor in the same test: use `Puma::Events.respond_to?(:strings) ? Puma::Events.strings : Puma::Events.new`. It works on Puma 5 and 6.

## 2. New configuration defaults across intermediate releases

The app uses `config.load_defaults 7.0` (`/home/user/workspace/repo/config/application.rb:12`), so every default below is still at its 7.0 value. The list comes from `railties-8.1.0/lib/rails/application/configuration.rb`, and each row says whether I exercised it.

| Default | Introduced | Status in app | Later change | Effect here | Configure |
|---|---|---|---|---|---|
| `active_record.default_column_serializer = nil` | 7.1 | 7.0 used YAML | none | `Notebook#preferences` raises `missing keyword: :coder` (verified) | `serialize :preferences, coder: YAML` (F-D1) |
| `active_record.raise_on_assign_to_attr_readonly = true` | 7.1 | silent ignore | none | slug assignment raises `ActiveRecord::ReadonlyAttributeError: slug` for same and changed values (verified) | drop `:slug` from `notebook_params` (F-D2) |
| `active_support.raise_on_invalid_cache_expiration_time = true` | 7.1 | `false` | none | negative `expires_in` raises (verified) | clamp `expires_in` (F-D3) |
| `active_support.cache_format_version = 7.1` | 7.1 | 7.0 format | 7.2 dropped 6.1 reads | 7.0 cannot read these entries (verified, section 3) | defer until rollout is complete |
| `active_support.message_serializer = :json_allow_marshal`, `use_message_serializer_for_metadata = true` | 7.1 | `:marshal` | none | 7.0 cannot verify these tokens (verified, section 3) | defer until rollout is complete |
| `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` = best supported | 7.1 | HTML4 | none | rich text suite passes; effective allowlist unchanged at 48 tags (probe) | accept, or pin explicitly |
| `dom_testing_default_html_version = :html5` | 7.1 | html4 | none | suite passes | accept |
| `belongs_to_required_validates_foreign_key = false` | 7.1 | `true` | none | fewer queries; suite passes | accept |
| `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`, `run_after_transaction_callbacks_in_order_defined` | 7.1 | old | none | app defines no commit or after-save callbacks (grep) | accept |
| `generate_secure_token_on`, `query_log_tags_format`, `marshalling_format_version`, `encryption.*` | 7.1 | old | none | not used (grep: no `has_secure_token`, `encrypts`, query log tags) | accept |
| `action_dispatch.default_headers` (drops `X-Download-Options`) | 7.1 | 7.0 headers | none | header diff not measured; no code depends on it | review |
| `add_autoload_paths_to_load_path = false` | 7.1 | true | none | no app code is required via `$LOAD_PATH` (grep) | accept |
| `active_record.postgresql_adapter_decode_dates = true` | 7.2 | `false` | none | `DATE()` returns `Date`, breaking `Date.iso8601` (verified, D4) | `Date.iso8601(day.to_s)` |
| `active_record.validate_migration_timestamps = true` | 7.2 | `false` | none | migrations dated 2026-10-11 are in the past | accept |
| `active_storage.web_image_content_types` | 7.2 | 7.0 list | none | not exercised | review |
| `yjit = true` | 7.2 (8.1 changes it to `!Rails.env.local?`) | off | none | performance only, not measured | decide |
| `action_dispatch.strict_freshness = true` | 8.0 | `false` | none | export download conditional GET tests pass | accept |
| `Regexp.timeout = 1` | 8.0 | none | none | suite passes; DOI and title regexes not load-tested | accept |
| `action_controller.escape_json_responses = false` | 8.1 | true | none | no `render json` in app (grep) | accept |
| `action_controller.action_on_path_relative_redirect = :raise` | 8.1 | none | none | no relative `redirect_to` strings (grep) | accept |
| `active_record.raise_on_missing_required_finder_order_columns = true` | 8.1 | none | none | all models have primary keys; suite passes | accept |
| `active_support.escape_js_separators_in_json = false` | 8.1 | true | none | no JSON embedded in JavaScript in app | accept |
| `action_view.render_tracker = :ruby` | 8.1 | none | none | fragment cache digests may change, so cache misses only (not measured) | accept |
| `action_view.remove_hidden_field_autocomplete = true` | 8.1 | none | none | markup change; suite passes | accept |
| `active_support.to_time_preserves_timezone` (set by 7.0 defaults) | deprecated in 8.1 | `true` | removed in 8.2 | deprecation warning observed at boot; `to_time` changed (F19) | remove the setting and use the explicit F19 repair |

## 3. Rollout, rollback, and mixed-version risks

**Artifacts (all verified in workspace unless noted):**

| Artifact | 7.0 to 8.1 with `load_defaults 7.0` | 8.1 with `load_defaults 8.1` | Verdict |
|---|---|---|---|
| Session cookie `_margin_notes_session` | Four combinations (7.0 to 8.1 and back, with either `load_defaults`) all return 200 on `GET /notes` | same | safe |
| Signed message tokens (`Rails.application.message_verifier`) | Marshal envelope; 7.0 and 8.1 read each other | JSON envelope; 7.0 raises `NoMethodError: undefined method 'unpack1' for nil` | breaks rollback after `load_defaults 7.1` |
| Fragment cache entries (FileStore) | 7.0 format; both read | 7.1 format; 7.0 raises `TypeError: incompatible marshal file format (can't be read)` | breaks rollback after `load_defaults 7.1` |
| ActiveJob `DigestJob` argument | 8.1 writes a `BigDecimal` wrapper; 7.0 raises `ActiveJob::DeserializationError` | same | repair F16 before the bump |
| ActiveJob `TimeWithZone` argument | 8.1 adds `"time_zone"`; 7.0 reads it as UTC | same | repair F15 |
| `notebooks.preferences` (YAML text) | byte-identical dump and read | same | safe |
| `notes.tags` (JSON text) | 7.0 writes `\u003c` escapes; 8.1 writes raw `<`, `>`, `&` | same | decodes equally; byte-level change |
| `db/schema.rb` | 8.1 dump sorts columns, writes `ActiveRecord::Schema[8.1]` and `enable_extension "pg_catalog.plpgsql"` | same | do not regenerate during rollout |
| Redis digest reservation sets | same keys and members | same, plus Sidekiq 7 integer return | repair F17 if on Sidekiq 7 |
| Native Sidekiq `ExportJob` payload | `[id, {"format"=>"markdown"}]` after JSON | same string keys after F20 | safe after F20 |
| Scheduled reminder job (`NoteReminderJob`, `reminder_job_id`) | GlobalID plus `job_id` | same | not executed across versions |

**Ordering I recommend:**
1. Ship the pre-bump repairs on 7.0.8.7: F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F18, F19 (with the offset decision), F17 and F20 (harmless on Sidekiq 6), and the `:slug` removal and export clamp (D2, D3), plus D1 and D4. All of these are verified on the baseline suite. Keep the upgrade-time items (F21, F22) out of this step.
2. Bump with `load_defaults 7.0` and the path A gems (json pin, Sidekiq 6.5.12, Puma 5.6.9, Rack 2.2.24). Apply F21 and F22 in the same deploy, since they cannot be in place on 7.0. Test-only F22 has no production effect.
3. Only after every process runs 8.1, adopt `load_defaults 7.1`. This flips message tokens and cache formats, so rolling back afterwards breaks 7.0 processes.
4. Then adopt 7.2, 8.0, and 8.1 defaults one at a time, and handle the 8.2 removal of `to_time_preserves_timezone`.
5. Move to path B (Sidekiq 7, Puma 6, Rack 3) as a separate change, with F17, F20, and F24.

**Rollback summary:** rolling back from path A with `load_defaults 7.0` is safe for cookies, tokens, cache, and jobs (verified pairs above). Rolling back after `load_defaults 7.1` is not safe for tokens and cache.

## 4. Verification log and open questions

### Commands and results (executed)
1. `ruby /home/user/planner-run/maintain-rails/bin/gem-changes rails 7.0.8.7 8.1.0` (run from the application root). Output saved to a file of about 2,100 lines. It included textual matches for every item listed above, plus false positives: `app/mailers/digest_mailer.rb:7` (`Hash#values_at`, not Rack); `app/controllers/reminders_controller.rb:7` and `app/models/note.rb:72` (Rack status, actually `to_i`); `app/models/citation/provider.rb:44-46` (JSON hash); `config/routes.rb:4` (a route name, not `Rack::Session`); and the `Rack::Request#params` call in the citation test, which still exists on Rack 3.2.7.
2. `ruby /home/user/planner-run/maintain-rails/bin/upgrade-workspace setup rails 7.0.8.7 8.1.0`. Baseline: 46 runs, 325 assertions, 0 failures. Upgraded: boot failed with `NoMethodError: undefined method '+' for nil (config/initializers/action_text.rb:3)`.
3. `upgrade-workspace probe` runs, about 25 snippets, each on baseline and upgraded. Confirmed behaviors: enum and serialize boot errors; `alias_attribute` `ArgumentError`; `form_with(model: nil)`; `Enumerable#sum`; `HashWithIndifferentAccess#stringify_keys`; `Citation[:id]`; `wait_until` integer; `show_exceptions` values; `postgresql_adapter_decode_dates`; `raise_on_assign_to_attr_readonly`; `to_time` and `TimeWithZone` round-trip; `BigDecimal` and `TimeWithZone` payloads; Redis `sadd` return values; transaction enqueue (`enqueue_after_transaction_commit = false`, job visible before rollback on both); YAML byte format; sanitizer allowlist; `Rack::Lint` header check.
4. Workspace repairs and runs, `upgrade-workspace test --target upgraded` and `--defaults 8.1`. Final state: 46 runs, 340 assertions, 0 failures, 0 errors, both with and without `load_defaults 8.1`. This run used `rails 8.1.0`, `json 2.7.2`, `sidekiq 7.3.9`, `puma 6.6.1`, and `rack 3.2.7`, so it covers path B.
5. Final baseline run, `upgrade-workspace test --target baseline`, with the pre-bump repairs applied (including `Puma::Events` and `content-type`) and the upgrade-only items reverted: 46 runs, 325 assertions, 0 failures, 0 errors.
6. Path A gems (`rack 2.2.24`, `puma 5.6.9`, `sidekiq 6.5.12`, `json 2.7.2`) with the repairs as of an earlier run: 46 runs, 340 assertions, 0 failures under both `load_defaults`. The later repairs (F15 digest `to_s("F")`, F17, F20, and the Puma and header test changes) were not re-run on path A.
7. Revert experiments: I restored a snapshot, put one original line back, ran the relevant test file, and then restored. Each produced the expected failure: F12 (`imports_controller_test.rb:65`), F14 (lines 22 and 62), F17 (`digests_controller_test.rb:21`), F22 (8 failures, RecordNotFound not raised), F20 (`ExportJob` symbol error), F11 (`TypeError`), F10 (`PG::UndefinedColumn`), F21 (`RuntimeError`), F9 (`Passed nil to the :model argument`), F18 (`undefined method 'utc' for an instance of Integer`), F13 (receipt, `digests`...), F15 (subject line 33), F19 (`reminders_controller_test.rb:21`), D2 (`ReadonlyAttributeError: slug`), and D3 (`Cache expiration time is invalid, cannot be negative: -60.0`).
8. Schema dump under 8.1 and mixed-version artifact writes and reads (about 6 probe runs).
9. `upgrade-workspace cleanup rails 8.1.0`. Output: `Cleaned up workspace /tmp/upgrade-rails-8.1.0 and dropped temporary PostgreSQL and Redis databases.` and `Working checkout git status: clean`. I also removed my scratch files under `/tmp`.

### Resolved versions
- Path A (recommended for the bump): `rails` and all `activesupport`/`actionpack`/etc. 8.1.0; `rack 2.2.24`; `rackup 1.0.1`; `rack-session 1.0.2`; `puma 5.6.9`; `sidekiq 6.5.12`; `redis 4.8.1`; `json 2.7.2` (pinned); `action_text-trix 2.1.19` (added); `net-smtp 0.5.2` still present through `mail 2.9.1`.
- Path B (validated later step): `rack 3.2.7`, `rackup 2.3.1`, `puma 6.6.1`, `sidekiq 7.3.9`, `redis-client 0.31.0`.

### Log paths
- `/tmp/upgrade-rails-8.1.0/logs/` held `bundle-update.log`, `diag-baseline.log`, `diag-upgraded.log`, `diag-upgraded-defaults-8.1.log`, `schema-load-baseline.log`, `schema-load-upgraded.log`, `tests-baseline.log`, `tests-upgraded.log`, and `tests-upgraded-defaults-8.1.log`. Cleanup deleted them as Step 4 requires, so the excerpts above come from those files and the probe output before deletion.

### Not verified or open
- Browser behavior of Trix and Action Text (F23) and `bin/rails test:system`. No browser was run.
- ActiveStorage signed blob IDs across versions. They use the same message-verifier family, which I verified for tokens, but I did not probe signed IDs directly.
- Fragment cache digest changes from `render_tracker = :ruby`, and default header differences from 7.1. Neither was measured.
- A Proc-based replacement for `:polynomially_longer` on 7.0 (to avoid a mixed-version window). Not tested.
- `bin/citation-provider` was not run end to end under Rack 3 and Puma 6. Only the `rack/handler/puma` require was checked.
- Production-only paths: eager load in production, asset precompile, Sidekiq server process, and SMTP delivery. The lock still includes `net-smtp` through `mail`, so I expect no load error, but I did not send mail.
- Decisions the owner must make: keep or change the reminder display (F19); keep the vendored Trix 1.3.5 or move to the gem (F23); accept the tags byte-format change (F5); whether to adopt path B now or later.
- The gems installed into the shared gem home during the experiment (Rack 3.2.7, Puma 6.6.1, Sidekiq 7.3.9, json 2.7.2, rackup 2.3.1, redis-client 0.31.0) were not removed by cleanup.

---

**Notes from me (after the plan):**

- Current locked version confirmed from `Gemfile.lock`: `rails`, `actionpack`, `activerecord`, `activesupport`, and `railties` are all at 7.0.8.7. I passed that to the planner as `currentVersion`.
- I did not implement anything. `git status` on the working tree is clean.
- The planner's own experiments ran in a disposable workspace, and its cleanup step removed that workspace. The gems it installed into the shared gem home remain there, which is harmless for this repo but worth knowing.
- The plan's ordering suggests the change is not a single-commit bump. I'd do it in two steps: first the pre-bump repairs on 7.0.8.7, then the bump itself with the json pin. Tell me if you want me to start on step one, or go straight to the bump, and whether you want path A (Rack 2 / Sidekiq 6, recommended) or path B (Rack 3 / Sidekiq 7).
- Decisions the plan flags for you: the reminder display behavior (F19), whether to keep the vendored Trix 1.3.5 (F23), and the tags byte-format change (F5).