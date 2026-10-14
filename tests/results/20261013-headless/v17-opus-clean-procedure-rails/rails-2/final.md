# Upgrade plan: rails 7.0.8.7 → 8.1.0

## Summary
Required changes: 20 (19 code edits, 1 gem move). Gems that must move with it: the Rails components (8.1.0) and json, which must be pinned below 3 (it resolves to 2.21.2). Optional defaults: 31 settings are listed, and none needs to be adopted for the upgrade. Biggest risk: `serialize :tags, coder: JSON` must ship with the upgrade and not before it. On 7.0 the `coder:` keyword is ignored, so tags would be stored as YAML (observed: `"---\n- a\n- b\n"`), and notes pages then return 500.

After all repairs (observed, `check --side after`): boot, eager load, routes and schema are ok. Tests: 46 runs, 340 assertions, 0 failures, 0 errors. All 10 GET routes give the same responses as before. No new exceptions in the log and no new deprecation warnings.

## Required changes
Every repair below passed `check --side after` (observed). Each one has a validation script at `/tmp/gem-upgrade/repo-rails-8.1.0/check-N.rb`. Unless stated otherwise, the validation result was PASS on before, FAIL or a boot error with only that change undone, and PASS on after, with matching CONTROL lines (observed).

### 1. Action Text `allowed_tags` is nil at boot
- Affected code: `config/initializers/action_text.rb:3`.
- If nothing is done (observed, boot): ``undefined method `+' for nil (NoMethodError)`` at `ActionText::ContentHelper.allowed_tags += %w[ details summary ]`.
- Applies because (from source): in actiontext 8.1, `mattr_accessor(:allowed_tags)` has no default. The default list is computed on demand in `sanitizer_allowed_tags`.
- Repair: `allowed_tags = (allowed_tags || sanitizer.class.allowed_tags.to_a + [Attachment.tag_name, "figure", "figcaption"]) + %w[details summary]`. Works on the current version: yes in principle. On before+repairs check-1 failed with a 500, which comes from the tags change (#3), not from this one.
- Validation: check-1.rb. The without-repair run hit the boot error. Control: another note's body renders (200).
- Rollout: none.

### 2. Enum declared with keyword arguments
- Affected code: `app/models/note.rb:10`. The other enums (`export.rb:10`, `citation.rb:7`) already use the positional form.
- If nothing is done (observed, eager load): `` `enum': wrong number of arguments (given 0, expected 1..2) ``.
- Applies because (from source): activerecord 8.0 "Remove deprecated support for defining `enum` with keyword arguments".
- Repair: `enum :status, { draft: 0, ready: 1 }, prefix: true`. Works on the current version: yes. check-2 printed PASS on before+repairs.
- Validation: check-2.rb. Control: the default status is stored as raw `0`.
- Rollout: none.

### 3. `serialize` coder as a positional argument
- Affected code: `app/models/note.rb:12`.
- If nothing is done (observed, eager load): `` `serialize': wrong number of arguments (given 2, expected 1) ``.
- Applies because (from source): activerecord 7.2 removed passing the coder as the second argument.
- Repair: `serialize :tags, coder: JSON`. Works on the current version: **no**. On 7.0 the keyword is silently ignored and YAML is written (observed: check-3 on before+repairs printed `raw tags: --- - reform - é` and FAIL). That leads to 23 test failures, including ``undefined method `any?' for String`` in views. This must ship with the upgrade.
- Validation: check-3.rb. Raw stored value on before and after: `["reform","é"]`. Control: the other note's raw tags are `[]`.
- Rollout: the stored format is unchanged, JSON on both versions (observed, probe-3 after: `"[\"a\",\"b\"]"`).

### 4. One `get` with two paths
- Affected code: `config/routes.rb:18`.
- If nothing is done (observed, routes): `Wrong number of arguments (expect 1, got 2)` at `mapper.rb:1854`.
- Repair: split it into `get "/notes", to: "notes#index"` and `get "/journal", to: "notes#index"`. Route names stay `notes` and `journal`. Works on the current version: yes (proposed; the check-4 FAIL on before+repairs was a 500 caused by #3).
- Validation: check-4.rb (/journal returns 200, `journal_path`). Control: /notes returns 200.
- Rollout: none.

### 5. `alias_attribute` on a `store_accessor`
- Affected code: `app/models/note.rb:14`. Users of it: `notes/show.html.erb:3`, `notes/index.html.erb:44`, `notes/_form.html.erb:31-37`, `notes_controller.rb:68`.
- If nothing is done (observed, tests): ``Note model aliases `color`, but `color` is not an attribute. Use `alias_method :highlight_color, :color` ...``.
- Repair: `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=`. Works on the current version: yes (check-5 PASS on before+repairs).
- Validation: check-5.rb. Raw settings value: `{"color": "green"}`. Control: the value written on create.
- Rollout: none.

### 6. json 3.1.0 breaks `JSON.parse` calls from Active Support
- Affected code: the Gemfile (`gem "json", "< 3", require: false`).
- If nothing is done (observed, tests): ``ArgumentError: wrong number of arguments (given 2, expected 1) (json-3.1.0/lib/json/common.rb:291:in `parse', called from activesupport-8.1.0/.../json/decoding.rb:25)``.
- Repair: `bump json "< 3"`, which resolves to 2.21.2. Works on the current version: yes, it "resolves and installs at rails 7.0.8.7". It can ship first.
- Validation: check-6.rb. Without the pin, boot failed in `json-3.1.0 parse`. Control: `JSON.parse` works.
- Rollout: none.

### 7. `Enumerable#sum` of strings
- Affected code: `app/models/export.rb:42`.
- If nothing is done (observed, tests): `TypeError: String can't be coerced into Integer`. The current version already warns about this: "DEPRECATION WARNING: Rails 7.0 has deprecated Enumerable.sum ...".
- Repair: `fragments.join`. Works on the current version: yes (check-7 PASS on before+repairs). It can ship first.
- Validation: check-7.rb. The without-repair run printed FAIL TypeError, and its control showed the export left in `working`.
- Rollout: none.

### 8. `show_exceptions = false` in the test environment
- Affected code: `config/environments/test.rb:31`.
- If nothing is done (observed, tests): `ActiveRecord::RecordNotFound expected but nothing was raised` in 8 tests.
- Repair: `show_exceptions = :none`. Works on the current version: **no**. On 7.0, `:none` is truthy (check-8 on before+repairs: FAIL, status 404). It must ship with the upgrade.
- Validation: check-8.rb. Control: own note returns 200.
- Rollout: test only.

### 9. `Rails.application.secrets` removed
- Affected code: `app/models/citation/provider.rb:13`, `test/controllers/citation_enrichments_controller_test.rb:45,117,118,122`, and the comments in `config/secrets.yml`.
- If nothing is done (observed): ``NoMethodError: undefined method `secrets' for #<MarginNotes::Application>``.
- Repair: add `config.x.citation_provider = config_for(:secrets).fetch(:citation_provider, {})` in `config/application.rb` and read it through `Rails.configuration.x.citation_provider`. Works on the current version: yes (check-9 PASS on before+repairs).
- Validation: check-9.rb (url `http://127.0.0.1:9393`, user `margin-notes`). Control: explicit settings still work.
- Rollout: production still reads the same `CITATION_PROVIDER_*` environment variables (from source; production was not run).

### 10. `retry_on wait: :exponentially_longer` removed
- Affected code: `app/jobs/citation_enrichment_job.rb:7`.
- If nothing is done (observed): `RuntimeError: Couldn't determine a delay based on :exponentially_longer`.
- Repair: `:polynomially_longer`. Works on the current version: **no** (observed on before+repairs: the same RuntimeError for `:polynomially_longer`). It ships with the upgrade.
- Validation: check-10.rb (retry enqueued with a 3 s delay). Control: the handler is registered.
- Rollout: retries already queued in Sidekiq carry no wait algorithm, so they are unaffected (proposed).

### 11. `form_with(model: nil)`
- Affected code: `app/views/notes/index.html.erb:12`.
- If nothing is done (observed): `ActionView::Template::Error: Passed nil to the :model argument, expect an object or false`.
- Repair: drop `model: nil`. Works on the current version: yes (proposed; the 500 on before+repairs came from #3).
- Validation: check-11.rb. Control: the edit form keeps its scoped `note[title]` field.

### 12. `where(notebooks: record)` on Note
- Affected code: `app/controllers/notes_controller.rb:12`.
- If nothing is done (observed): `PG::UndefinedColumn: ERROR: column notes.notebooks does not exist`.
- Repair: `where(notebook: @notebook)`. Works on the current version: yes (proposed; the before+repairs 500 came from #3).
- Validation: check-12.rb. Control: the unfiltered list shows both notebooks.

### 13. `set(wait_until:)` given an Integer
- Affected code: `app/models/note.rb:62`.
- If nothing is done (observed): ``undefined method `utc' for an instance of Integer (activejob-8.1.0/lib/active_job/core.rb:130)``.
- Repair: `wait_until: Time.at(reminder_epoch)`. Works on the current version: yes (check-13 PASS on before+repairs).
- Validation: check-13.rb (scheduled at 1800000000.0). Without the repair, the control call raised "Locking a record with unpersisted changes is not supported".
- Rollout: the scheduled time is the same on both versions (observed, probe-3).

### 14. `TimeWithZone#to_time` now keeps the zone
- Affected code: `app/models/note.rb:45`.
- If nothing is done (observed): the next-day reminder across the DST change shows `2026-11-01T08:00:00-05:00`; the test expects `09:00:00-04:00`.
- Repair: `Time.at(reminder_at.to_i + 86_400, in: reminder_at.formatted_offset)`. Works on the current version: yes (check-14 PASS on before+repairs).
- Validation: check-14.rb. Control: the summer time `2026-07-02T09:00:00-04:00` is the same on all three runs.

### 15. TimeWithZone job argument now keeps its zone
- Affected code: `app/mailers/digest_mailer.rb:8`.
- If nothing is done (observed): `"Your reading digest for October 04, 2026"` instead of `October 05`.
- Repair: `requested_at = requested_at.in_time_zone`. Works on the current version: yes (check-15 PASS on before+repairs).
- Validation: check-15.rb. Control: the midday subject stays October 05.
- Rollout: from 8.1 the payload adds `"time_zone":"America/New_York"` (observed, probe-3). 7.0 workers ignore it, and with this repair both versions compute the UTC day (proposed).

### 16. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys
- Affected code: `app/views/imports/preview.html.erb:22`.
- If nothing is done (observed): `Expected: "Read <b>twice</b> & reflect" Actual: "10.1000/Essays.1"`.
- Repair: drop `.stringify_keys`. Works on the current version: yes (check-16 PASS on before+repairs).
- Validation: check-16.rb.

### 17. `return` inside a transaction now commits
- Affected code: `app/models/import.rb:53-59`.
- If nothing is done (observed): `` `record_counts` changed ``. Without the repair, check-17 counted `[1, 5]` against `[0, 4]`, so an invalid import is half-saved.
- Repair: `raise ActiveRecord::Rollback unless rows.all? { |row| row.note.save }` and return `applied == true`. Works on the current version: yes (check-17 PASS on before+repairs).
- Validation: check-17.rb. It runs inside a non-joinable transaction, as test fixtures do. The control differs only in the without-repair run, because of the stray committed note.

### 18. `record[:id]` no longer returns a custom primary key
- Affected code: `app/models/import.rb:68` (Citation's primary key is `doi`).
- If nothing is done (observed): the receipt reads `"title,doi\nCited,\nUncited,\n"`.
- Repair: `citation&.doi`. Works on the current version: yes (check-18 PASS on before+repairs).
- Validation: check-18.rb.

### 19. A negative cache `expires_in` now stores the entry with no expiry
- Affected code: `app/views/exports/_export.html.erb:26`.
- If nothing is done (observed, probe-2): before printed `read nil`, after printed `read "fresh"`. check-19 without the repair kept the expired export's fragment.
- Repair: `expires_in: [export.expires_at - Time.current, 1.second].max`. My first attempt, `cache_if export.downloadable?`, broke `test_the_cached_availability_indicator_does_not_authorize_a_download`, so I replaced it. Works on the current version: yes (check-19 PASS on before+repairs).
- Validation: check-19.rb. Control: the valid export's fragment is cached.

### 20. BigDecimal job argument has a new payload
- Affected code: `app/models/user.rb:41`.
- If nothing is done (observed): the payload becomes `{"_aj_serialized":"ActiveJob::Serializers::BigDecimalSerializer","value":"0.0"}`. Rails 7.0 workers cannot read that, which matters during a mixed deploy or a rollback.
- Repair: `reading_completion.to_s` (the mailer already calls `BigDecimal(params[:completion])`). Works on the current version: yes (check-20 PASS on before+repairs).
- Validation: check-20.rb. The completion argument is the plain string `"0.0"` on before and after.
- Rollout: with this repair, a job enqueued on either version can be read by either version (observed, probe-3).

**Ship before the upgrade:** #5, #6, #7, #9, #13 to #20. #1, #4, #11 and #12 can also ship first if they go without #3 (proposed). **Ship with the upgrade:** #3, #8, #10.

## Risks without a code change
- Schema dump format (observed): `Schema[8.1]`, `pg_catalog.plpgsql`, and columns sorted alphabetically. This is a one-time diff in `db/schema.rb` that reviewers will see.
- Action Mailbox conductor routes edit/update/destroy were removed (observed). The application does not use them.
- The response header name changes from `Link` to `link` (observed). It only matters to clients that compare header names case-sensitively.
- `saved_change_to_color?` now returns `true [nil, "green"]` where it returned `false [nil, nil]` (observed, probe-1). The changelog calls this a fix, and the application does not call it.
- 8.1 refuses `lock!` on a record with unsaved changes (observed in the check-13 without-repair run). `schedule_reminder` sets values inside the lock, so the application is safe today. Callers that modify a note before calling it would now get an error.

## Gems that move with this upgrade
- All Rails components move to 8.1.0.
- json is pinned `< 3` and resolves to 2.21.2.
- Other moves: bigdecimal 4.1.3 (major), uri 1.1.2 (major), securerandom 0.4.1 (major), drb 2.2.3, net-imap 0.6.8.
- Added: action_text-trix, rack-session, rackup, useragent, webrick. Removed: method_source.
- No code matches for bigdecimal, uri or securerandom. securerandom's `Formatter` match is the `Logger::Formatter` class, a different object. The digest test exercises BigDecimal and the provider test exercises URI, and both pass.

## Optional: framework defaults
The application calls `load_defaults 7.0`. Values below are the after copy's (observed).
- **Adopt now** (proposed):
  - `raise_on_invalid_cache_expiration_time`: nil. Adopting it raises instead of logging; safe after #19.
  - `precompile_filter_parameters`: nil.
  - `debug_exception_log_level :error`: currently `:fatal`.
- **Adopt later** (proposed):
  - `query_log_tags_format`: `:legacy`. Query log tags are not used.
  - `message_serializer :json_allow_marshal` and `use_message_serializer_for_metadata`: nil. These affect cookies and sessions; enable them in a second deploy, after rollback is no longer needed.
  - `marshalling_format_version 7.1`: 6.1 now. Changes the cache format; second deploy.
  - `run_after_transaction_callbacks_in_order_defined`, `before_committed_on_all_records`, `run_commit_callbacks_on_first_saved_instances_in_transaction`: no `after_commit` callbacks in the application.
  - `raise_on_assign_to_attr_readonly`: false. It would raise on `notebook.rb:8 attr_readonly :slug` if code assigns the slug.
  - `belongs_to_required_validates_foreign_key false`: true now. Saves a query; there are 6 `belongs_to`.
  - `default_column_serializer nil`: YAMLColumn now. Only after giving `notebook.rb:7 serialize :preferences` an explicit `coder: YAML`, because its rows are stored as YAML (observed, probe-1).
  - `generate_secure_token_on`: no `has_secure_token`.
  - `action_view` / `action_text sanitizer_vendor` HTML5: HTML4 now. Re-run `test_rich_text_keeps_collapsible_excerpts` before adopting.
  - `dom_testing_default_html_version`: html4 now.
  - `enqueue_after_transaction_commit`: false now. Note #13 and #20: enqueues happen under row locks.
  - `web_image_content_types` webp, `validate_migration_timestamps`, `postgresql_adapter_decode_dates`.
  - `to_time_preserves_timezone :zone`: nothing to adopt; #14 already makes it irrelevant.
  - `strict_freshness`: false now. `export_downloads_controller.rb:11` uses `stale?`.
  - `yjit`, `log_file_size`.
- **Never needed:** the encryption `hash_digest_class` settings, `support_sha1`, and `sqlite3 strict strings` (no `encrypts`, PostgreSQL).
- **Nothing to adopt** (removed by 8.1.0): `allow_deprecated_parameters_hash_equality`, `allow_deprecated_singular_associations_name`, `use_big_decimal_serializer`, `commit_transaction_on_non_local_return`.

## Checked, not applicable
- Relation#transaction default scope: `import.rb:53` is an instance `transaction`.
- Additive, not used by the application: ActionCable command callbacks, `helper_method` in CSP, `:report` deprecation behavior, `register_parser`, `allow_browser`, transaction payload and yielded object, markdown renderer, deprecated associations, generator, routes and credentials command changes, `enable_reloading`.
- Not used or a different object:
  - `raise_on_missing_translations` (not set).
  - Cookie `JSON::ParserError`: the provider has its own rescue.
  - Attachments `purge`: `export.rb:74` calls `Blob#purge`.
  - `ActiveStorage::Current#host`: the application uses `URI#host`.
  - Preview, variant and `with_all_rich_text`: the application uses its own `preview` and `with_rich_text_body`.
  - Renderer host and Action Text URLs in jobs: no `ApplicationController.render` in the application; export uses plain text.
  - `discard_on` test helper, custom Active Model types, MySQL invisible indexes, JSON CIDR, `file_field` accept array (the application passes a string).
  - Time + Time: `user.rb:3` is a Duration.
  - Grouped `sum`, contradiction queries, `transform_keys!`.
- Same output on both sides:
  - `Note.connection.select_rows`: probe-2, `daily_note_counts` `[[2026-09-02, 1]]`.
  - Sanitizer output, default headers (X-Download-Options still present), hidden inputs keep `autocomplete="off"`, `rich_text_area` markup: probe-2.
  - Notebook preferences YAML raw value: probe-1.
  - `filter_attributes`: probe-1, `User#inspect` identical.
  - Cache entry format: probe-3.
  - `queue_adapter` in tests, `only`/`except` validation, RichText embeds `before_validation`: covered by the passing suite.

## Not verified
- `config/secrets.yml:7`: the local citation provider URL was not isolated. The citation tests start their own Puma server; no external service was called.
- The production environment was not run: `ActiveSupport::Logger`/BroadcastLogger at `production.rb:86`, the production cache store, and Sidekiq with real Redis payloads during a mixed deploy (the payloads were only inspected in probe-3).
- The browser suite (`test:system`) was not run.
- Ship-first claims for #1, #4, #11 and #12 are inferred: their before+repairs check failures were caused by #3.
- No changelog for the moved gems was needed beyond the generated summaries.

## Evidence
- Workspace `/tmp/gem-upgrade/repo-rails-8.1.0` (the copies were removed by `cleanup`):
  - Findings F1 to F20: `findings.md`
  - `candidates.md` (C1 to C40)
  - Probes: `probe-1.rb` to `probe-3.rb`
  - Validation scripts: `check-1.rb` to `check-20.rb` plus `checks-setup.rb`
  - Results: `validate-all.txt`, `backport.txt`, `backport.patch`
  - Full change set: `final.diff`
  - Logs: `logs/`
  - Changes index: `changes/summary.md`
- Versions: before rails 7.0.8.7 with json 2.7.2; after rails 8.1.0 with json 2.21.2; Ruby 3.3.6.
- Commands, all run from the application root: `upgrade-copy setup/check/keep/bump/validate/backport/runner/diff --all/cleanup` and `gem-changes`.
- One deviation: I ran `bin/rails routes` once directly in the application root to compare route names. It was a read-only command, but it was outside `upgrade-copy`. `git status` is clean afterwards.

---

**My notes:**
- This is a plan only. Your repository hasn't been changed: the upgrade skill limits this step to planning. The planner said `git status` was still clean after its one read-only command in the app root, though I didn't check that myself.
- The full change set it tested is in `/tmp/gem-upgrade/repo-rails-8.1.0/final.diff`.
- It's a big jump: 7.0 → 8.1 crosses 7.1, 7.2 and 8.0. A suggested order: ship the changes marked "ship before the upgrade" first. Then ship the gem bump together with #3, #8 and #10. Leave the optional framework defaults for later deploys.
- The browser suite and production behaviour weren't tested. Run `bin/rails test:system` and do a staged deploy before relying on this.

Should I go ahead and apply it?