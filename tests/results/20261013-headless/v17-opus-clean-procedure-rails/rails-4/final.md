# Upgrade plan: rails 7.0.8.7 → 8.1.0

## Summary
- **Required changes: 19** (18 code edits and 1 gem pin). The application itself was not changed; all edits were made in the `after` copy and are recorded in `/tmp/gem-upgrade/repo-rails-8.1.0/final.diff`.
- **Gem that must move with it:** json, pinned `< 3` (resolves to 2.21.2).
- **Optional defaults:** 28 settings are not set explicitly (4 of them only get a "nothing to adopt" note).
- **Biggest risk:** the `serialize :tags, coder: JSON` edit must ship together with Rails 8.1. If it is deployed on 7.0 first, 7.0 ignores `coder:` and writes YAML into `notes.tags`, which breaks tag pages (observed when the repairs were applied to the current version).
- **Result (observed):** with every repair, after passes all checks: boot, eager load, routes, schema, 46 runs with 0 failures and 0 errors, and the same responses on all 10 GET routes.

## Required changes
Every repair below was validated with `ruby P/upgrade-copy validate "TITLE" --file /tmp/gem-upgrade/repo-rails-8.1.0/check-N.rb`. Each one gave PASS on before, FAIL (or a boot error) on after without that repair, and PASS on after, with matching CONTROL lines (observed). "Backport" is the result of `backport` (before plus all repairs, at 7.0.8.7).

### 1. Action Text `allowed_tags` is nil at 8.1
- **Affected code:** `config/initializers/action_text.rb:3`
- **If nothing is done:** the app does not boot: `undefined method '+' for nil (NoMethodError)`. Seen in the check boot and test steps (observed).
- **Applies because:** the initializer appends to `ActionText::ContentHelper.allowed_tags`. In actiontext 8.1.0 that accessor has no default; the default list is now built in `sanitizer_allowed_tags` (from source).
- **Repair:** in `after_initialize`, set `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags.to_a + [attachment tag, "figure", "figcaption"]) + %w[details summary]`.
- **Works on the current version:** yes.
- **Validation:** check-1: details/summary kept and script dropped. Without the repair the copy fails to boot. CONTROL: `strong` kept, `figure` allowed.
- **Rollout:** none.

### 2. `enum` with keyword arguments was removed
- **Affected code:** `app/models/note.rb:10`
- **If nothing is done:** eager load fails with `wrong number of arguments (given 0, expected 1..2)`, and all 46 tests error (observed).
- **Repair:** `enum :status, { draft: 0, ready: 1 }, prefix: true`
- **Works on the current version:** yes.
- **Validation:** check-2: PASS / boot error / PASS. CONTROL: `Export.statuses`.
- **Rollout:** none.

### 3. `serialize` with a positional coder was removed
- **Affected code:** `app/models/note.rb:12`
- **If nothing is done:** `serialization.rb:193: wrong number of arguments (given 2, expected 1)` (observed).
- **Repair:** `serialize :tags, coder: JSON`
- **Works on the current version:** **no**. Backport stored `tags raw: "---\n- a\n- é\n"` (YAML), and 15 tests errored with `undefined method 'any?' for String` (`notes/_tags.html.erb:1`) (observed). Ship it with the upgrade only.
- **Validation:** check-3: PASS, raw `["x","y"]` / boot error / PASS. CONTROL: preferences raw stays YAML.
- **Rollout:** on 8.1 the stored format is unchanged: before and after both write `["a","é"]`, and existing JSON rows read correctly (observed, probe-6). Rollback to 7.0 is safe.

### 4. A route to more than one path was removed
- **Affected code:** `config/routes.rb:18`
- **If nothing is done:** routes fail with `Wrong number of arguments (expect 1, got 2)` (observed).
- **Repair:** split it into `get "/notes", to: "notes#index", as: :notes` and `get "/journal", to: "notes#index", as: :journal`. These are the same route names as on before.
- **Works on the current version:** yes.
- **Validation:** check-4: PASS / boot error / PASS.

### 5. `alias_attribute` to a `store_accessor` key was removed
- **Affected code:** `app/models/note.rb:14`. Callers: `notes/show`, `notes/index`, `notes/_form` views, `notes_controller.rb:68` and the notes tests.
- **If nothing is done:** `Note model aliases 'color', but 'color' is not an attribute` (observed).
- **Repair:** `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`
- **Works on the current version:** yes.
- **Validation:** check-5: PASS, raw `{"color": "green"}` / boot error / PASS.

### 6. Pin json below 3
- **Affected code:** `Gemfile`. The failing JSON.parse call shows up in many 500 responses and in `activestorage blob.rb:183`.
- **If nothing is done:** `json-3.1.0/lib/json/common.rb:291:in 'parse': wrong number of arguments (given 2, expected 1)` (observed).
- **Repair:** `gem "json", "< 3", require: false` (resolves to 2.21.2).
- **Works on the current version:** yes, the pin "resolves and installs at 7.0.8.7" (observed). It can ship first.
- **Validation:** check-6: PASS / FAIL / PASS.

### 7. `Enumerable#sum` over strings
- **Affected code:** `app/models/export.rb:42`
- **If nothing is done:** `TypeError: String can't be coerced into Integer`. Before already warned: "Rails 7.0 has deprecated Enumerable.sum" (observed).
- **Repair:** `fragments.join`
- **Works on the current version:** yes.
- **Validation:** check-7: PASS / FAIL / PASS.

### 8. `show_exceptions = false` is no longer accepted
- **Affected code:** `config/environments/test.rb:31`
- **If nothing is done:** 8 tests fail with "RecordNotFound expected but nothing was raised". Responses are a 404 instead of an exception (observed).
- **Repair:** `Rails.gem_version >= Gem::Version.new("7.1") ? :none : false`
- **Works on the current version:** yes.
- **Validation:** check-8: PASS / FAIL / PASS.

### 9. `Rails.application.secrets` was removed
- **Affected code:** `app/models/citation/provider.rb:3,13`, `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`, `config/secrets.yml`
- **If nothing is done:** ``NoMethodError: undefined method `secrets'`` (observed in tests). In production every citation lookup would raise the same error (from source).
- **Repair:**
  - move `config/secrets.yml` to `config/citation_provider.yml`;
  - add `config.x.citation_provider = config_for(:citation_provider)` in `config/application.rb`;
  - read `Rails.configuration.x.citation_provider` instead.
- **Works on the current version:** yes.
- **Validation:** check-9: PASS / FAIL / PASS.
- **Rollout:** deploys must provide the same `CITATION_PROVIDER_*` environment variables (proposed).

### 10. `retry_on wait: :exponentially_longer` was removed
- **Affected code:** `app/jobs/citation_enrichment_job.rb:7`
- **If nothing is done:** `Couldn't determine a delay based on :exponentially_longer` (observed).
- **Repair:** `wait: :polynomially_longer` (same formula, from source).
- **Works on the current version:** **no**. Backport gave `Couldn't determine a delay based on :polynomially_longer` (observed). Ship it with the upgrade.
- **Validation:** check-10: PASS, delay 3 / FAIL / PASS, delay 3.

### 11. `form_with(model: nil)` now raises
- **Affected code:** `app/views/notes/index.html.erb:12`
- **If nothing is done:** `Passed nil to the :model argument, expect an object or false` (observed).
- **Repair:** remove `model: nil`.
- **Works on the current version:** yes. check-11 failed under backport only because of the YAML tags from #3.
- **Validation:** check-11: PASS / FAIL / PASS.

### 12. `where(notebooks: record)` on a `belongs_to :notebook`
- **Affected code:** `app/controllers/notes_controller.rb:12`
- **If nothing is done:** `PG::UndefinedColumn: column notes.notebooks does not exist` (observed).
- **Repair:** `where(notebook: @notebook)`
- **Works on the current version:** yes. Its backport failure also came from #3.
- **Validation:** check-12: PASS / FAIL / PASS.

### 13. `set(wait_until:)` with an Integer
- **Affected code:** `app/models/note.rb:62`
- **If nothing is done:** ``undefined method `utc' for an instance of Integer`` (observed).
- **Repair:** `wait_until: Time.at(reminder_epoch)`
- **Works on the current version:** yes.
- **Validation:** check-13: PASS / FAIL / PASS; the job is scheduled at the same epoch.

### 14. `to_time` now keeps the time zone
- **Affected code:** `app/models/note.rb:45`
- **If nothing is done:** across the DST change, `next_day_reminder_at` is `2026-11-01T08:00:00-05:00` instead of `09:00:00-04:00` (observed).
- **Repair:** `reminder_at.to_time.getlocal(reminder_at.utc_offset) + 86_400`
- **Works on the current version:** yes.
- **Validation:** check-14: PASS / FAIL / PASS. CONTROL: summer date unchanged.

### 15. TimeWithZone job arguments keep their zone
- **Affected code:** `app/mailers/digest_mailer.rb:7`. The argument is written at `app/models/user.rb:41`.
- **If nothing is done:** the digest subject says "October 04, 2026" instead of "October 05, 2026", so the UTC-day digest covers the wrong day (observed).
- **Repair:** `requested_at = requested_at.in_time_zone(Time.zone)`
- **Works on the current version:** yes.
- **Validation:** check-15: PASS / FAIL / PASS.
- **Rollout:** the after payload adds `"time_zone"=>"America/New_York"` (observed, probe-6). Old workers ignore that key, and new workers read old payloads in UTC; with this repair both give the UTC day (from source). Mixed versions and rollback are safe.

### 16. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys
- **Affected code:** `app/views/imports/preview.html.erb:22`. Lookups are at lines 42 and 44.
- **If nothing is done:** annotations disappear from the import preview: `dd=nil` (observed).
- **Repair:** remove `.stringify_keys`.
- **Works on the current version:** yes.
- **Validation:** check-16: PASS / FAIL / PASS.

### 17. `return` inside a transaction now commits
- **Affected code:** `app/models/import.rb:53-57`
- **If nothing is done:** an import with an invalid row saves partially: counts went from `[0, 3]` to `[1, 4]` (observed).
- **Repair:** `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }`
- **Works on the current version:** yes.
- **Validation:** check-17: PASS / FAIL / PASS.

### 18. `record[:id]` no longer returns a custom primary key
- **Affected code:** `app/models/import.rb:68`
- **If nothing is done:** the receipt shows `Cited,` with an empty DOI (observed).
- **Repair:** `citation&.doi`
- **Works on the current version:** yes.
- **Validation:** check-18: PASS / FAIL / PASS.

### 19. A negative `expires_in` is ignored, so the entry never expires
- **Affected code:** `app/views/exports/_export.html.erb:26`
- **If nothing is done:** probe-2 wrote with `expires_in -5`. Before read `nil`, after read `"v"`. The fragment for an expired export would be cached without an expiry (observed).
- **Repair:** `expires_in: [export.expires_at - Time.current, 0].max`
- **Works on the current version:** yes.
- **Validation:** check-19: PASS / FAIL (expires_at nil) / PASS.
- **Note:** a first attempt with `cache_if` broke the cached-indicator test and was reset (observed).

## Risks without a code change
- **Response header case (observed, probe-3):** the `Link` header is now sent as `link`. Only clients that match header names case-sensitively would notice.
- **`autocomplete="off"` removed from hidden inputs (from source):** this only changes markup. probe-3 found no hidden inputs on `/session/new`.
- **json now leaves `JSON.parse`'s argument encoding alone (observed, a fix):** the argument now stays ASCII-8BIT; parsed values are the same.
- **`saved_change_to_color?` now reports correctly (observed, a fix):** false before, true after. The application never calls it.

## Gems that move with this upgrade
- Rails components: 7.0.8.7 → 8.1.0.
- json: 2.7.2 → 2.21.2, pinned `< 3` (required change #6).
- bigdecimal: 3.1.5 → 4.1.3. probe-4 showed the same `0.4286` and `0.5e0` on both sides.
- uri: 0.13.1 → 1.1.2. probe-4 showed the same parse results.
- securerandom: 0.4.1. `Logger::Formatter` still works (probe-4).
- Minor moves: drb 2.2.3 and net-imap 0.6.8.
- Added: action_text-trix, rack-session, rackup, useragent, webrick. Removed: method_source.

## Optional: framework defaults
The application still calls `load_defaults 7.0`. Values are from the after probe; all items are proposed.

**Adopt now**
- `raise_on_invalid_cache_expiration_time` (nil): once repair #19 is in, adopting is safe.
- `precompile_filter_parameters` (nil): no risk.
- `belongs_to_required_validates_foreign_key` (true → false): saves a query.
- `debug_exception_log_level` (:fatal → :error): logging only.
- `validate_migration_timestamps` (nil → true).
- `strict_freshness` (false → true): only affects the `stale?` call in `export_downloads_controller.rb:11` when a client sends both validators.
- `sqlite3_adapter_strict_strings_by_default`: Postgres app, no effect.

**Adopt later**
- `message_serializer` (nil → `:json_allow_marshal`) and `use_message_serializer_for_metadata` (nil → true): affect cookies and sessions. Adopt in a second deploy after every server runs 8.1.
- `marshalling_format_version` (6.1 → 7.1): cache format. Adopt in a second deploy.
- `raise_on_assign_to_attr_readonly` (false → true): `notebooks_controller.rb:40` resubmits `:slug`, so updates would raise. Not before that param is dropped.
- `default_column_serializer` (YAML → nil): `notebook.rb:7` `serialize :preferences` would need `coder: YAML` first.
- `run_after_transaction_callbacks_in_order_defined`, `run_commit_callbacks_on_first_saved_instances_in_transaction`, `before_committed_on_all_records`: the app has no `after_commit` callbacks, so this is low risk.
- `generate_secure_token_on` (:create → :initialize): the app does not use `has_secure_token`.
- `action_view.sanitizer_vendor` and `action_text.sanitizer_vendor` (HTML4 → HTML5): retest the details/summary allowlist (repair #1).
- `dom_testing_default_html_version` (:html4 → :html5): tests only.
- `enqueue_after_transaction_commit` (false): jobs are enqueued inside `with_lock` in `note.rb:62` and `citation.rb:20`, and the comments rely on a failed enqueue rolling back. Adopt only with care.
- `active_storage.web_image_content_types` (adds webp).
- `postgresql_adapter_decode_dates`: this would break `notebook.rb:40` `Date.iso8601(day)`, because it would receive a Date. Change that code before adopting.
- `to_time_preserves_timezone`: already forced by 8.1 (repair #14).
- `query_log_tags_format` (:legacy → :sqlcommenter): affects development query logs only.
- `log_file_size`.
- `yjit` (false → true): a memory decision.

**Never or not applicable**
- `encryption.hash_digest_class` and `support_sha1_for_non_deterministic_encryption`: the app uses no `encrypts`.

**Nothing to adopt** (removed by 8.1.0)
- `allow_deprecated_parameters_hash_equality`
- `allow_deprecated_singular_associations_name`
- `use_big_decimal_serializer`
- `commit_transaction_on_non_local_return`

## Checked, not applicable
- **Removed Rails names:** `secrets` is covered by #9.
- **Changes probed with no difference observed:**
  - `serialize :preferences` default YAML: probe-1 raw `"---\nsort: newest..."` on both sides.
  - Queue adapter in tests: tests pass.
  - `rich_text_area` is still an alias.
  - resources `only:` validation: routes draw.
  - Default `X-Download-Options` header: still sent under the 7.0 defaults (probe-3).
  - `filter_attributes` and `inspect`: same output (probe-3).
- **Additive:** cable command callbacks, `helper_method` in CSP, deprecation `:report`, `register_parser`, `allow_browser`, markdown renderer, deprecated associations, transaction object and payloads, `enable_reloading`, `transform_keys!` fix, JSON CIDR, PG retryable error.
- **Different object or name than the change describes:**
  - `Relation#transaction` fix: the app calls `Import#transaction`.
  - Cookies `JSON::ParserError`: the app's rescue is in Citation::Provider.
  - `ActiveStorage::Current#host`: the app calls `URI#host`.
  - Purge on an association: the app calls `Blob#purge`.
  - `Preview#processed`: the app calls `Import#preview`.
  - Empty-variation preview: not used.
  - Grouped sum and contradictory-relation fixes: no such calls.
  - `with_all_rich_text`: the app uses `with_rich_text_body`.
  - `file_field` accept array: the app passes a string.
  - `RichText` embeds callback: the cited lines are other models.
  - `Time + Time`: `2.days` is a Duration.
  - AsyncAdapter: the app uses Sidekiq.
  - Renderer host and attachment URLs in jobs: the app renders no rich text in jobs.
  - `raise_on_missing_translations`: not set.
  - Deprecation singleton: the app only sets config.
- **Generator, command or internal changes:** migration size, `routes --grep`, `secrets` commands, credentials paths, system-test generator, `public_file_server` generator and headers, mailer `default_url_options` generator, ActiveModel serialize optimization, InternalMetadata, `ConnectionPool#connection` (the app calls `Model.connection`), MySQL invisible indexes, `TestCase` binary body.
- **Schema dump:** columns are sorted and `pg_catalog.plpgsql` appears; the schema itself is unchanged (observed).
- **Routes diff:** Action Mailbox conductor edit/update/destroy routes were removed (framework development tool, not used by the app).
- **Moved gems:** drb and net-imap have no matches. For securerandom, the matched `Formatter` is `::Logger::Formatter`.

## Not verified
- **Citation provider (`127.0.0.1:9393`):** not isolated, so it was never called. Provider calls in the probes were stubbed.
- **Production only, untested:**
  - `Rails.logger` BroadcastLogger with the `RAILS_LOG_TO_STDOUT` block at `production.rb:86`;
  - the production file cache store;
  - `config.public_file_server` settings;
  - the browser suite (`test:system`) was not run.
- **Sidekiq:** native `ExportJob.perform_async` warns that its arguments do not serialize to JSON safely. This is a Sidekiq warning seen on both sides, not part of this upgrade.
- **Redis warnings:** `sadd`/`srem` warnings come from the redis gem, not Rails.
- **Shipping repairs before the upgrade:** #11 and #12 failed under backport only because of #3. Their own checks were not rerun on 7.0 without #3. Every other repair except #3 and #10 printed PASS on before plus repairs (observed).
- **Unresolved problems:** none.

## Evidence
- **Workspace:** `/tmp/gem-upgrade/repo-rails-8.1.0`
- **Findings and diff:**
  - `findings.md` (F1–F19);
  - `candidates.md`;
  - `final.diff` (all changes);
  - `backport.out` and `backport.patch`.
- **Scripts:** `check-1.rb` … `check-19.rb`, `probe-1.rb` … `probe-6.rb`. Logs are in `logs/`.
- **Versions:** before was rails 7.0.8.7 with json 2.7.2. After is rails 8.1.0 with json 2.21.2, bigdecimal 4.1.3 and uri 1.1.2. Bundle changes are listed in `lock-changes.txt`.
- **Commands run:** `setup`, `gem-changes`, `check`, 19 rounds of repair with `check --side after` and `keep`, `bump json "< 3"`, `runner` probes, `validate` ×19, `backport`, `backport --hold` with `reset --side before`, the defaults probe, `diff --all` and `cleanup`. Cleanup dropped the copies, their databases and Redis databases 13–15.

---

**Next steps:** I haven't changed your repo yet. This is a jump across several major versions, from 7.0.8.7 to 8.1.0. In the planner's test copy, 19 changes made the full test suite pass, but the browser suite (`bin/rails test:system`) was never run.

Two of the changes only work on Rails 8.1 and must ship together with the version bump: #3 (`serialize … coder: JSON`) and #10 (`:polynomially_longer`). You can ship most of the others first on 7.0.

If you'd like, I can apply the changes from `final.diff` on a new branch and run both test suites.