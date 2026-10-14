# Upgrade plan: rails 7.0.8.7 → 8.1.0

## Summary
Required changes: 20, made up of 19 code edits and 1 gem move (pin `json` below 3). Gems that must move with it: json 2.7.2 → 2.21.2 (pinned `< 3`). The other gem changes come in automatically: bigdecimal 4.1.3, uri 1.1.2, securerandom 0.4.1, drb, rackup, rack-session, webrick, useragent, action_text-trix and net-imap 0.6.8 are added or moved, and method_source is removed. Optional defaults: 29 settings in the 7.1, 7.2 and 8.0 sections, 3 of which only need a note. Biggest risk: some upgrade breakages give wrong data rather than errors, and the repairs fix them. Without the repairs, a failed CSV import commits some of its rows, receipts lose their DOIs, and digests cover the wrong day. Also, `serialize :tags, coder: JSON` writes YAML on 7.0, so that one change must not ship before the upgrade (observed).

With all 20 changes, the after copy boots, eager-loads and draws routes. All 46 tests pass with 0 failures and 0 errors, the 10 GET requests return the same responses as before, and no new exceptions are logged (observed). Every item below is observed unless marked "from source" or "proposed".

## Required changes

### 1. Action Text `allowed_tags` is nil at boot
- Affected code: `config/initializers/action_text.rb:3` (the only use).
- If nothing is done: the app fails at boot with `config/initializers/action_text.rb:3:in '<main>': undefined method '+' for nil (NoMethodError)` (check, boot step).
- Applies because: actiontext 8.1.0's `content_helper.rb:10` declares `mattr_accessor(:allowed_tags)` with no default and now works the default out lazily in `sanitizer_allowed_tags` (from source).
- Repair: inside `config.after_initialize`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags + [ActionText::Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. Works on 7.0: yes. check-1 passes on before+repairs. The `rich_text_keeps_collapsible_excerpts` test failed on before+repairs, but probably only because change 3 makes 7.0 store tags as YAML and the page then raises a 500 (not separately verified).
- Validation: `check-1.rb`: before PASS; without the change, boot error; after PASS. CONTROL (`<script>` stripped, `figure` allowed) is the same on both.
- Rollout: none.

### 2. `enum` with keyword arguments was removed
- Affected code: `app/models/note.rb:10`. `export.rb:10` and `citation.rb:7` already use the new form.
- If nothing is done: eager load fails with `enum.rb:217:in 'enum': wrong number of arguments (given 0, expected 1..2)`.
- Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on 7.0: yes.
- Validation: `check-2.rb`: PASS / ArgumentError / PASS. CONTROL (Export statuses) unchanged. Rollout: none.

### 3. `serialize` no longer takes the coder as a positional argument
- Affected code: `app/models/note.rb:12`. `notebook.rb:7` (`serialize :preferences`, YAML) is not affected.
- If nothing is done: eager load fails with `serialization.rb:193:in 'serialize': wrong number of arguments (given 2, expected 1)`.
- Repair: `serialize :tags, coder: JSON`. Works on 7.0: **no**. On 7.0 the `coder:` keyword is ignored and the column is written as YAML (`raw="---\n- a\n- é\n"`), and the notes views raise `undefined method 'any?' for String`. **Ship with the upgrade.**
- Validation: `check-3.rb`: PASS (`raw="[\"a\",\"é\"]"`) / ArgumentError / PASS. CONTROL `preferences raw="---\nexport_heading: H\n"` is the same on both.
- Rollout: the stored JSON is byte-identical between 7.0 (old line) and 8.1 (new line). Mixed versions and rollback are safe as long as this line never runs on 7.0.

### 4. A route can no longer have more than one path
- Affected code: `config/routes.rb:18`, `get "/notes", "/journal", to: "notes#index"`.
- If nothing is done: routes fail with `mapper.rb:1854:in 'match': Wrong number of arguments (expect 1, got 2)`, which breaks every test and request.
- Repair: two lines, `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. Works on 7.0: yes.
- Validation: `check-4.rb`: PASS / ArgumentError / PASS. Rollout: none.

### 5. `alias_attribute` pointing at a `store_accessor`
- Affected code: `app/models/note.rb:14`. Callers that keep working unchanged: `notes/index.html.erb:44`, `notes/_form.html.erb:31-37`, `notes/show.html.erb:3`, the permit list at `notes_controller.rb:68`, and the tests.
- If nothing is done: `ArgumentError: Note model aliases 'color', but 'color' is not an attribute. Use 'alias_method :highlight_color, :color'` (about 16 tests).
- Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on 7.0: yes.
- Validation: `check-5.rb`: PASS (`raw="{\"color\": \"green\"}"`) / ArgumentError / PASS. CONTROL `color=green`. Rollout: the stored value is unchanged.

### 6. Pin json below 3 (gem move)
- If nothing is done: `json-3.1.0/lib/json/common.rb:291:in 'parse': wrong number of arguments (given 2, expected 1)`, for example from `activestorage-8.1.0 .../blob.rb:183:in 'custom_metadata'`. About 30 tests failed and several requests returned 500.
- Repair: add `gem "json", "< 3", require: false` to the Gemfile, which resolves to 2.21.2. This also resolves and installs at 7.0.8.7, so it can ship first.
- Validation: `check-6.rb`: PASS / ArgumentError / PASS. CONTROL `JSON.parse` result is the same.
- Rollout: none. probe-4 showed that `Citation::Provider#metadata_from` and `URI.parse` give identical results on 9 inputs, including invalid JSON and `javascript:` URLs.

### 7. `Enumerable#sum` on strings
- Affected code: `app/models/export.rb:42`. This was already flagged at 7.0 by `DEPRECATION WARNING: Rails 7.0 has deprecated Enumerable.sum ...` ×3.
- If nothing is done: `TypeError: String can't be coerced into Integer`. The export stays in `working` and no file is written.
- Repair: `finish(fragments.join)`. Works on 7.0: yes.
- Validation: `check-7.rb`: PASS / FAIL (CONTROL `status=working`) / PASS (CONTROL `status=completed`).

### 8. `Rails.application.secrets` was removed
- Affected code: `app/models/citation/provider.rb:13`, `config/secrets.yml`, and `test/controllers/citation_enrichments_controller_test.rb:45, 117, 118, 122`.
- If nothing is done: `NoMethodError: undefined method 'secrets' for #<MarginNotes::Application>`. Citation lookups would fail in every environment (from source).
- Repair:
  - rename `config/secrets.yml` to `config/citation_provider.yml`;
  - add `config.citation_provider = config_for(:citation_provider)[:citation_provider]` to `config/application.rb`;
  - read `Rails.configuration.citation_provider` in the provider and the test.

  Works on 7.0: yes.
- Validation: `check-8.rb`: PASS (default URL) / NoMethodError / PASS. CONTROL `user=margin-notes`.
- Rollout: production reads the same `CITATION_PROVIDER_*` environment variables, so deploy configuration does not change (proposed, production not run).

### 9. `show_exceptions = false` is no longer accepted
- Affected code: `config/environments/test.rb:31`.
- If nothing is done: 8 authorization tests fail with `ActiveRecord::RecordNotFound expected but nothing was raised`, because the request now gets a 404 instead of raising.
- Repair: `config.action_dispatch.show_exceptions = :none`. Works on 7.0: **no**; on before+repairs it gives 404 instead of raising. Ship with the upgrade.
- Validation: `check-9.rb`: PASS / FAIL (`status 404`) / PASS. Rollout: test environment only.

### 10. `retry_on wait: :exponentially_longer` was removed
- Affected code: `app/jobs/citation_enrichment_job.rb:7`.
- If nothing is done: `RuntimeError: Couldn't determine a delay based on :exponentially_longer`. No retry is scheduled when the provider is unavailable.
- Repair: `wait: :polynomially_longer` (same formula). Works on 7.0: **no**; it raises `Couldn't determine a delay based on :polynomially_longer`. Ship with the upgrade.
- Validation: `check-10.rb`: PASS / FAIL / PASS.
- Rollout: retries already queued are unaffected; the setting is only read when a retry is scheduled.

### 11. `form_with(model: nil)` now raises
- Affected code: `app/views/notes/index.html.erb:12`.
- If nothing is done: `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`. The `/notes` list returns 500.
- Repair: remove `model: nil`. Works on 7.0: yes from source. The backport check could not show it, because the 500s from change 3 masked it.
- Validation: `check-11.rb`: PASS / error / PASS.

### 12. A plural association name in `where`
- Affected code: `app/controllers/notes_controller.rb:12`, `where(notebooks: @notebook)`.
- If nothing is done: `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist` when filtering by notebook.
- Repair: `where(notebook: @notebook)`. Works on 7.0: yes from source; the backport check was masked the same way as in change 11.
- Validation: `check-12.rb`: PASS / StatementInvalid / PASS.

### 13. `set(wait_until:)` given an Integer epoch
- Affected code: `app/models/note.rb:62`.
- If nothing is done: `NoMethodError: undefined method 'utc' for an instance of Integer (activejob-8.1.0/lib/active_job/core.rb:130)`. No reminder can be scheduled or postponed.
- Repair: `wait_until: Time.at(reminder_epoch)`. Works on 7.0: yes.
- Validation: `check-13.rb`: PASS (`at=1767225600.0`) / FAIL / PASS.
- Rollout: 8.1 adds a `scheduled_at` key to the job payload, which 7.0 workers ignore.

### 14. `to_time` now keeps the zone, not the UTC offset
- Affected code: `app/models/note.rb:45` (`next_day_reminder_at`), used by `_reminder.html.erb:19` and by postponing at `note.rb:72`.
- If nothing is done: the preview across the DST change shows `2026-11-01T08:00:00-05:00` instead of the documented `2026-11-01T09:00:00-04:00`. The postponed epoch is the same in both cases.
- Repair: `(reminder_at.to_time + 86_400).getlocal(reminder_at.utc_offset)`. Works on 7.0: yes.
- Validation: `check-14.rb`: PASS / FAIL / PASS. CONTROL (summer date and epoch) is the same.

### 15. Active Job now restores a TimeWithZone argument in its own zone
- Affected code: `app/mailers/digest_mailer.rb:8-9`.
- If nothing is done: the digest test failed with `-"Your reading digest for October 05, 2026" +"... October 04, 2026"`. The digest would cover the reader's local day instead of the UTC day.
- Repair: `requested_at = requested_at.in_time_zone(Time.zone)`. Works on 7.0: yes.
- Validation: `check-15.rb`: PASS / FAIL / PASS. CONTROL (midday request) is the same.
- Rollout: jobs queued by 7.0 are read on 8.1 as UTC, which the repair handles. The 8.1 payload adds a `"time_zone"` key, which 7.0 ignores (probe-6).

### 16. `HashWithIndifferentAccess#stringify_keys` now turns Integer keys into strings
- Affected code: `app/views/imports/preview.html.erb:22`. The lookup is `annotations[row.line]` at :41.
- If nothing is done: annotations disappear from the import preview, for example `Expected: "Read <b>twice</b> & reflect" Actual: "10.1000/Essays.1"`.
- Repair: use `@import.annotations` without `.stringify_keys`. Works on 7.0: yes.
- Validation: `check-16.rb`: PASS / FAIL / PASS.

### 17. `return` inside a transaction now commits
- Affected code: `app/models/import.rb:53-57`. The `break`s at :87 and :93 are outside any transaction.
- If nothing is done: an import with an invalid row saves the earlier rows. Observed: `record_counts changed. Expected: [0, 3, 0, 1] Actual: [1, 4, 1, 2]`.
- Repair: `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }` with an `applied` flag that becomes the return value. Works on 7.0: yes.
- Validation: `check-17.rb`: PASS (`[0,3,0] -> [0,3,0]`) / FAIL (`-> [1,4,1]`) / PASS. CONTROL (valid import adds 1 import and 1 note) is the same.

### 18. `record[:id]` no longer reads a custom primary key
- Affected code: `app/models/import.rb:68`. The citations primary key is `doi` (`schema.rb:55`).
- If nothing is done: the CSV receipt is `"title,doi\nA,\nB,\n"` with the DOIs missing.
- Repair: `citation&.doi`. Works on 7.0: yes.
- Validation: `check-18.rb`: PASS / FAIL / PASS.

### 19. A negative cache `expires_in` is now stored with no expiry
- Affected code: `app/views/exports/_export.html.erb:26`.
- If nothing is done: probe-2 showed that before, `expires_in=-5.0` was never stored (reread `nil`); after, it is stored (reread `"fresh"`) with no expiry, and an `ArgumentError` is reported and logged on every render. With the 7.1 default `raise_on_invalid_cache_expiration_time=true` it would raise and return 500 (from source).
- Repair: `expires_in: [export.expires_at - Time.current, 0].max`. I first tried `cache_if` instead; it was reset because it broke `exports_controller_test.rb:78`. Works on 7.0: yes.
- Validation: `check-19.rb`: PASS / FAIL (`stored=1`) / PASS. CONTROL (live export cached=1) is the same.
- Rollout: entries already cached stay valid. In production, the default file store would otherwise collect never-expiring entries for expired exports.

### 20. BigDecimal job argument format (DigestJob)
- Affected code: `app/models/user.rb:41`.
- If nothing is done: the payload changes from `"0.5"` to `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.5"}` (probe-5). A 7.0 worker that sees this during a rolling deploy or after a rollback cannot deserialize it (from source).
- Repair: `reading_completion.to_s`. The mailer already does `BigDecimal(params[:completion])`. Works on 7.0: yes.
- Validation: `check-20.rb`: PASS / FAIL (Hash) / PASS.
- Rollout: with the repair the payload is identical on both versions (probe-6 under `backport --hold`).

**Ship before the upgrade (backport check passes on 7.0):** 1, 2, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17, 18, 19, 20. Changes 11 and 12 should also work on 7.0 (from source) but the backport check could not prove it.
**Ship with the upgrade:** 3, 9, 10.

## Risks without a code change
- **Response header name case:** `Link` becomes `link` (Rack 3). Only clients that compare header names case-sensitively would notice.
- **Schema dump format:** `db/schema.rb` changes to `Schema[8.1]`, `enable_extension "pg_catalog.plpgsql"` and alphabetically sorted columns. This is 72 lines of diff with no schema change. Regenerate it once after upgrading.
- **Job payloads:** the DigestJob time argument gains a `"time_zone"` key, which 7.0 ignores. NoteReminderJob gains a Time `scheduled_at`. Mixed old and new workers are OK given changes 15 and 20.
- **Routes:** Action Mailbox conductor edit/update/destroy routes are gone. These are Rails' development tool, not the application's routes.

## Gems that move with this upgrade
- json: pinned `< 3`, 2.7.2 → 2.21.2. Required; json 3.1.0 breaks Active Storage.
- bigdecimal 4.1.3 (major): `BigDecimal()` gave the same results (probe-5, check-20).
- uri 1.1.2 (major): `URI.parse` behaved the same (probe-4).
- securerandom 0.4.1: its removed `Random::Formatter` is not what `production.rb:79` uses (that is `::Logger::Formatter`), so it does not apply.
- drb, net-imap, and the new rackup, rack-session, webrick, useragent and action_text-trix: no matching code. method_source is removed.

## Optional: framework defaults
`load_defaults` stays at 7.0. Values below are the after copy's values.
- `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `use_big_decimal_serializer`, `commit_transaction_on_non_local_return`: nothing to adopt (removed in 8.1).
- `active_record.encryption.hash_digest_class` and `support_sha1_for_non_deterministic_encryption` (nil): the app has no `encrypts`. Adopt now.
- `run_commit_callbacks_on_first_saved_instances_in_transaction` (true), `before_committed_on_all_records` (false), `run_after_transaction_callbacks_in_order_defined` (false): the app has no `after_commit`. Adopt now.
- `sqlite3_adapter_strict_strings_by_default`: PostgreSQL app, no effect. Adopt now.
- `raise_on_invalid_cache_expiration_time` (false): safe after change 19. Adopt after the upgrade.
- `query_log_tags_format` (:legacy): query log tags are not used. Adopt now.
- `message_serializer` (nil, Marshal) and `use_message_serializer_for_metadata`: these affect cookies and sessions. Adopt later, in two deploys after every server runs 8.1.
- `log_file_size`: dev and test only. Adopt now.
- `raise_on_assign_to_attr_readonly` (false): `notebook.rb:8 attr_readonly :slug`. Writing a slug would then raise instead of being silently ignored. Adopt later, after checking the slug edit paths.
- `belongs_to_required_validates_foreign_key` (true → false): saves one query per Note save. Adopt now.
- `precompile_filter_parameters`: performance only. Adopt now.
- `default_column_serializer` (→ nil): `notebook.rb:7 serialize :preferences` relies on YAML. Adopt only after adding `coder: YAML` there.
- `marshalling_format_version` (6.1 → 7.1): cache format. Adopt later, in a second deploy.
- `generate_secure_token_on`: the app has no `has_secure_token`. Adopt now.
- `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` (HTML4 → HTML5): change rich text sanitizing. Adopt later, re-running check-1 and the rich text tests.
- `debug_exception_log_level` (:fatal → :error): logging only. Adopt now.
- `dom_testing_default_html_version` (:html4 → :html5): may change `assert_select` results. Adopt later.
- `enqueue_after_transaction_commit` (false): jobs are enqueued under `with_lock` on purpose (`note.rb:62`, `citation.rb:20`, `user.rb:41`). Never adopt without redesigning that.
- `web_image_content_types` (add webp): no variant processor is installed. Adopt now.
- `validate_migration_timestamps`: adopt now.
- `postgresql_adapter_decode_dates`: `notebook.rb:40` calls `Date.iso8601(day)` on `select_rows`, which would then receive a Date and fail. Never adopt without changing that line.
- `yjit` (false): deployment choice. Adopt later.
- `to_time_preserves_timezone` (:zone): already forced by 8.1 and handled by change 14. Adopt now.
- `strict_freshness` (false): affects `export_downloads_controller.rb:11 stale?(etag:, last_modified:)`. When the etag differs but the date matches, the response is already 200 (probe-3), so adopting changes nothing observed. Adopt now.

## Checked, not applicable
- `Relation#transaction` default scope: `import.rb:53` calls the instance-level `transaction`.
- ActionCable callbacks, `helper_method` in CSP, `:report` deprecation, transaction payload/yield, `allow_browser`, `register_parser`, markdown renderer, deprecated associations, `autoload_lib`: additive, not used by the app.
- `raise_on_missing_translations`: the app does not set it.
- Renderer host / Action Text URLs in jobs: the app uses neither.
- `JSON::ParserError` cookie change: the app's rescue is for its own `JSON.parse`.
- Custom Active Model types, `Store` saved_change tracking, contradictory or grouped calculations: not used.
- Attachments `purge`: the app calls `Blob#purge`. `Current#host`: the app calls `URI#host`.
- Active Storage service setting: set in both environments. Preview/variant changes: `Import#preview` is the app's own method.
- `with_all_rich_text`: the app uses `with_rich_text_body`. `rich_text_area`: the old name is still an alias.
- Time + TimeWithZone addition: the app only uses `2.days`. CIDR JSON, `file_field` accept array, HWIA `transform_keys!`, Action Text embeds callback: not used.
- Generator, credentials and `routes --grep` entries: textual matches only.
- `resource only:` validation: routes ok.
- No change observed:
  - Sanitizer vendor and allowed tags, YAML/JSON stored values, `select_rows` dates (probe-1).
  - Download headers including `X-Download-Options`, conditional GETs, hidden `autocomplete="off"` inputs (probe-3).
  - `filter_attributes`, json and uri behavior (probe-4).
  - `discard_on DeserializationError` and the queue adapter in tests: tests pass on both.

## Not verified
- The citation provider at `127.0.0.1:9393` (secrets.yml:7) was not isolated. Only the tests' own stub server was used.
- Production-only paths were not run: the `BroadcastLogger` wrapping of `production.rb:86`, `config_for` with production environment values, and the file cache store.
- Sidekiq against a real 7.0/8.1 mixed fleet; behaviour there is inferred from payloads only.
- System tests (`bin/rails test:system`) were not run.
- Changes 11 and 12 on 7.0 alone, and change 1's rich-text test on 7.0 (both masked in the backport check).
- Separate from Rails: `Redis#sadd`/`srem` deprecation warnings from the redis gem (`user.rb:38,43`), and Ruby 3.4 warnings for `csv`, `mutex_m` and `drb`.

## Evidence
- Workspace: `/tmp/gem-upgrade/repo-rails-8.1.0`. Notes: `findings.md`, `candidates.md`. Checks: `check-1.rb` to `check-20.rb`. Probes: `probe-1.rb` to `probe-6.rb`. Patch: `backport.patch`. Logs: `logs/`, including `check-report.md`, the `*-validate-*.log` and `before-backport-*.log` files, and `routes-after.diff` / `schema-after.diff`. Changes summary: `changes/summary.md`.
- Versions: before rails 7.0.8.7, json 2.7.2. After rails 8.1.0, json 2.21.2.
- Commands run: `upgrade-copy setup / check / check --side after` (repeated), `keep` ×19, `bump json "< 3"`, `validate` ×20, `backport --file`, `backport --hold`, `runner`, `diff --all`, `cleanup` (copies and databases removed), plus `gem-changes`.
- Nothing in `/home/user/workspace/repo` was changed.

---

That's the plan only; I haven't changed anything in the repo. This is a big jump from 7.0.8.7 to 8.1.0, so I'd do it in two steps:

1. **Before the upgrade:** ship the 15 changes that the planner confirmed work on 7.0. Changes 11 and 12 should also work there, but that couldn't be proven.
2. **With the version bump:** ship changes 3, 9 and 10. Each one breaks on 7.0, and change 3 would make 7.0 save tags as YAML.

System tests were not run, so `bin/rails test:system` should be checked before release. I can start on either step if you'd like.