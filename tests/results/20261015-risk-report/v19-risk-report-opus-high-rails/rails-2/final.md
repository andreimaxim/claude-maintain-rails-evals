# Risk report: upgrading Rails 7.0.8.7 to 8.1.0 in Margin Notes

The biggest risks are changes that don't raise errors. Four of them change saved data or what readers see, and one breaks running jobs while old and new versions run side by side during a deploy. The existing tests would catch most of these, but the report shows where to look. Most of the remaining changes raise an error that booting the app or running the test suite would catch.

I worked only from the two released gem versions (downloaded to `/tmp/railsdiff/src/`), the 7.1, 7.2 and 8.0 stable-branch changelogs (in `/tmp/railsdiff/changelogs/`), and the app's code. I didn't install, run, or change anything. Changelog line anchors are for the stable branches as of today and may drift.

Each claim is labelled: **[changelog]**, **[code]** (I read it in the gem source), or **[inference]**.

## Facts about the app that the ratings depend on (please correct any that are wrong)

1. **Database:** PostgreSQL only, through pg 1.6.0 (`config/database.yml`). There is no MySQL or SQLite.
2. **Background jobs:** Active Job uses Rails' built-in `:sidekiq` adapter with Sidekiq 6.5.12 and redis 4.8.1 (`config/application.rb:24`). Tests use the `:test` adapter. `ExportJob` is a native Sidekiq job.
3. **Job arguments that matter:**
   - `DigestJob` receives a time in the reader's own time zone and a `BigDecimal` (`app/models/user.rb:35,41`).
   - `NoteReminderJob` is scheduled with an Integer epoch (`app/models/note.rb:61`).
   - `CitationEnrichmentJob` uses `retry_on wait: :exponentially_longer`.
4. **I assumed the deploy is rolling,** so web servers and Sidekiq workers will briefly run different Rails versions. Please confirm.
5. **Output:** the app renders HTML only (ERB, Sprockets, importmap, Turbo). Jbuilder is installed but there are no JSON endpoints.
6. **Rich text:** Action Text, with a vendored Trix 1.3.5 loaded as a classic script (`app/views/layouts/application.html.erb:13`). The sanitizer allowlist is customised in `config/initializers/action_text.rb:3`.
7. **Files:** Active Storage on the local Disk service.
8. **Caching:** production doesn't set `cache_store`, so Rails' default file store applies [inference]. The only cache use is the fragment cache in `app/views/exports/_export.html.erb:26`.
9. **Framework defaults:** I assumed `config.load_defaults 7.0` stays in place. Several 7.1–8.1 defaults would break this app if adopted; they're listed at the end.
10. **Settings:** the citation provider's settings come from `Rails.application.secrets` / `config/secrets.yml`.
11. **Time zones:** each reader has a stored zone name, and the app's own zone is UTC.
12. **Tests:** the test environment sets `config.action_dispatch.show_exceptions = false` (`config/environments/test.rb:31`).

## High risk

### H1. `return` inside a transaction now commits instead of rolling back
- **Before:** in 7.0, leaving a `transaction` block early with `return` rolled the transaction back [code].
- **Now:** 7.1 added a setting to commit instead, and 7.2 removed the old behavior, so 8.1 always commits [code, changelog].
- **Where:** `Import#apply` (`app/models/import.rb:53-58`) does `return false unless row.note.save` inside `transaction`.
- **What could go wrong:** when a later row fails, the `Import` and every earlier note stay saved. The controller still renders "Nothing has been saved", and `ARCHITECTURE.md` promises all-or-nothing imports.
- **Tests:** `test/controllers/imports_controller_test.rb:65` should catch it.
- **Links:** [AR 7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md?plain=1#L864), [AR 7.2 changelog](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md?plain=1#L932), [PR #48600](https://github.com/rails/rails/pull/48600).

### H2. `record[:id]` no longer returns a custom primary key
- **Before:** `read_attribute(:id)` mapped `"id"` to the primary key [code].
- **Now:** 8.1 reads a literal `id` attribute. `citations` has no `id` column, so the call returns `nil` without raising [code: `AttributeSet#[]` falls back to `Attribute::Null`].
- **Where:** `Import#receipt` uses `citation && citation[:id]` (`app/models/import.rb:68`).
- **What could go wrong:** the DOI column of every downloaded receipt CSV becomes blank. The fix is `citation.id` or `citation.doi`.
- **Tests:** `imports_controller_test.rb:45` should catch it.
- **Links:** [AR 7.1 deprecation](https://github.com/rails/rails/blob/7-1-stable/activerecord/CHANGELOG.md?plain=1#L779), [AR 7.2 removal](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md?plain=1#L986), [PR #49019](https://github.com/rails/rails/pull/49019).

### H3. `HashWithIndifferentAccess#stringify_keys` now converts Integer keys
- **Before:** in 7.0, `stringify_keys` was just `dup`, so Integer keys stayed Integers [code].
- **Now:** in 8.0+, every key becomes a String [changelog, code].
- **Where:** `Import#annotations` builds a hash keyed by Integer line numbers (`app/models/import.rb:38-42`). `app/views/imports/preview.html.erb:22` calls `.stringify_keys`, then line 42 looks up `annotations[row.line]` with an Integer.
- **What could go wrong:** every annotation silently disappears from the import preview.
- **Tests:** `imports_controller_test.rb:22` should catch it.
- **Links:** [AS 8.0 changelog](https://github.com/rails/rails/blob/8-0-stable/activesupport/CHANGELOG.md?plain=1#L366), [PR #53125](https://github.com/rails/rails/pull/53125).

### H4. Time arguments to jobs now keep their time zone
- **Before:** in 7.0, the worker rebuilt the time in `Time.zone`, which is UTC [code].
- **Now:** 8.1 stores the zone name with the time and restores it, so the time arrives in the reader's zone [code].
- **Where:**
  - `User#request_digest` passes `Time.current.in_time_zone(time_zone)` (`app/models/user.rb:35,41`).
  - `DigestMailer#daily_digest` uses `requested_at.to_date` and `requested_at.all_day` (`app/mailers/digest_mailer.rb:8-9`).
- **What could go wrong:**
  - Digests switch from the UTC day to the reader's local day: a different subject date and a different set of notes. The Redis reservation still uses the UTC day.
  - The code comments and `ARCHITECTURE.md` describe the old behavior.
  - A 7.0-queued job run by an 8.1 worker keeps the old UTC behavior [code: falls back to `Time.zone`].
- **Tests:** `test/controllers/digests_controller_test.rb:33-35` should catch it.
- **Links:** [AJ 7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md?plain=1#L64), [PR #50240](https://github.com/rails/rails/pull/50240).

### H5. `BigDecimal` job arguments now use a serializer that 7.0 workers can't read
- **Before:** in 7.0, a `BigDecimal` went into Sidekiq's JSON as a plain string.
- **Now:** 8.1 always wraps it as `{"_aj_serialized" => "ActiveJob::Serializers::BigDecimalSerializer", ...}`. 7.1 kept this behind a setting for safe rollouts, and 8.0 removed the setting [code, changelog].
- **Where:** `DigestJob.perform_later(self, requested_at, reading_completion)` (`app/models/user.rb:41`).
- **What could go wrong:**
  - While both versions run, a 7.0 worker can't find that serializer class. The job fails to deserialize and Sidekiq retries it until an 8.1 worker picks it up.
  - The reader's Redis reservation is already taken, so they can't ask again that day.
  - Upgrade workers before web servers, or drain the queue first. The mailer's `BigDecimal(params[:completion])` works with either form.
- **Links:** [AJ 7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/activejob/CHANGELOG.md?plain=1#L226), [AJ 8.0 removal](https://github.com/rails/rails/blob/8-0-stable/activejob/CHANGELOG.md?plain=1#L69), [PR #45618](https://github.com/rails/rails/pull/45618).

### H6. `TimeWithZone#to_time` now keeps the zone, not the UTC offset
- **Before:** with 7.0 defaults, `to_time` kept only the UTC offset [code].
- **Now:** 8.1 always returns `getlocal(time_zone)`, and the setting is deprecated and ignored [code, changelog].
- **Where:** `Note#next_day_reminder_at` is `reminder_at.to_time + 86_400` (`app/models/note.rb:43-45`). It is shown in `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:**
  - Across a daylight-saving change, the "24 hours later" preview now shows the new offset, e.g. 08:00 −05:00 instead of 09:00 −04:00.
  - The stored epoch is unchanged. Only what readers see changes, and the code comment and `ARCHITECTURE.md` become wrong.
- **Tests:** `test/controllers/reminders_controller_test.rb:21` asserts the old output.
- **Links:** [AS 8.0 changelog](https://github.com/rails/rails/blob/8-0-stable/activesupport/CHANGELOG.md?plain=1#L460), [AS 8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activesupport/CHANGELOG.md?plain=1#L20).

### H7. The "Astana" time zone now points at a different TZInfo zone
- **Before:** the 7.0 `TimeZone::MAPPING` mapped "Astana" to Asia/Dhaka [code].
- **Now:** in 8.1 it maps to Asia/Almaty. "Asuncion" was added, "Greenland" maps to America/Nuuk, and "Canberra" maps to Australia/Canberra [code]. The last two are aliases of the old zones [inference].
- **Where:** stored `users.time_zone`, validated at `app/models/user.rb:13` and used at `app/models/user.rb:22` and `app/models/note.rb:37`.
- **What could go wrong:** current tzdata has Almaty at UTC+5, while Dhaka is UTC+6 [inference]. Readers who picked "Astana" would see reminder times, and parse the times they enter, an hour differently. Check how many users have that zone.
- **Links:** [AS 7.2 changelog](https://github.com/rails/rails/blob/7-2-stable/activesupport/CHANGELOG.md?plain=1#L348), [PR #51317](https://github.com/rails/rails/pull/51317).

## Medium risk

### M1. `Rails.application.secrets` was removed in 7.2
- **Where:** `Citation::Provider#initialize` (`app/models/citation/provider.rb:13`), `config/secrets.yml`, and `test/controllers/citation_enrichments_controller_test.rb:45,117-122`, which also assigns to `secrets` at runtime.
- **What breaks:** a `NoMethodError` on the first lookup. Booting doesn't catch it, because the call is only made when a provider is built.
- **Decision needed:** where the settings live: credentials, `config_for`, or `ENV`. Whatever replaces `secrets.yml` must keep the `.to_json` quoting so values like `"00123"` stay strings. The test at line 40 covers this.
- **Links:** [Railties 7.1](https://github.com/rails/rails/blob/7-1-stable/railties/CHANGELOG.md?plain=1#L298), [Railties 7.2](https://github.com/rails/rails/blob/7-2-stable/railties/CHANGELOG.md?plain=1#L148). [changelog, code]

### M2. Rails' built-in Sidekiq adapter is deprecated in 8.1 and goes away in 8.2
- **Where:** `config/application.rb:24`. The adapter still works in 8.1 and logs a deprecation warning when it is configured at boot [code].
- **Decision needed:** the replacement is Sidekiq 7.3.3 or later, which ships its own adapter. Sidekiq 7 uses `redis-client` instead of the `redis` gem [inference], which affects two places:
  - `Sidekiq.redis { |r| r.sadd(key, id) }` would return an Integer, and `0` is truthy in Ruby, which would break the once-a-day digest check (`app/models/user.rb:38`).
  - `rescue Redis::BaseError` (`app/models/notebook.rb:28`) and the tests that raise `Redis::CannotConnectError` would no longer match.
- **Link:** [AJ 8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/activejob/CHANGELOG.md?plain=1#L19). [changelog, code]

### M3. Trix now comes from the `action_text-trix` gem (Trix 2.1.15 or later)
- **Where:**
  - The layout loads the vendored `trix-1.3.5.js` (`app/views/layouts/application.html.erb:10-13`).
  - `app/assets/stylesheets/actiontext.css:6` does `require trix`, which would now pull in Trix 2's CSS next to Trix 1's JavaScript.
  - `@rails/actiontext` is pinned to `actiontext.js` (`config/importmap.rb:8`). In 8.1 that file is a UMD bundle, where 7.0's was an ES module; 8.1 also ships `actiontext.esm.js` [code].
- **Decision needed:** keep Trix 1.3.5 or adopt Trix 2, which is an ES module. Trix 2 changes the editor's paste sanitising and the stored HTML [inference]. The details/summary flattening described in `ARCHITECTURE.md` needs re-checking either way.
- **Links:** [AT 8.1 changelog](https://github.com/rails/rails/blob/v8.1.0/actiontext/CHANGELOG.md?plain=1#L53), [AT 7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/actiontext/CHANGELOG.md?plain=1#L78). [changelog, code]

### M4. `ActionText::ContentHelper.allowed_tags` now defaults to nil
- **Where:** `config/initializers/action_text.rb:3` does `allowed_tags += %w[details summary]`. That becomes `nil + [...]`, a `NoMethodError` at boot [code].
- **Why medium:** the defaults are now computed in `sanitizer_allowed_tags`, an instance method you can't call on the module. The fix has to rebuild the list as `sanitizer.class.allowed_tags + [action-text-attachment, figure, figcaption]` plus your additions. A naive `allowed_tags = %w[details summary]` would silently remove most formatting and all attachments.
- **Link:** [AT 7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/actiontext/CHANGELOG.md?plain=1#L117). [changelog, code]

### M5. `show_exceptions = false` now means "show all exceptions"
- **Where:** `config/environments/test.rb:31`. In 8.1, any value other than `:none` or `:rescuable` is treated as `:all` [code].
- **What breaks:** every `assert_raises(ActiveRecord::RecordNotFound)` around a request fails, because a 404 page is rendered instead. Tests that don't check status would also hide unexpected 500s.
- **Decision needed:** `:none` keeps today's behavior; `:rescuable` is the 7.1+ generator default.
- **Link:** [AP 7.2 changelog](https://github.com/rails/rails/blob/7-2-stable/actionpack/CHANGELOG.md?plain=1#L210). [changelog, code]

### M6. A negative cache `expires_in` is now handled differently
- **Where:** `app/views/exports/_export.html.erb:26` passes `expires_in: export.expires_at - Time.current`, which is negative once an export has expired.
- **Before:** 7.0 wrote an entry that was already expired [code].
- **Now:** with `load_defaults 7.0`, 8.1 drops the option, logs an `ArgumentError` at error level, reports it to `Rails.error`, and stores the fragment with no expiry [code]. The rendered "Expired" text stays correct, but every render of an expired export logs an error.
- **New default:** if you adopt `raise_on_invalid_cache_expiration_time` (a 7.1 default), the exports page raises instead.
- **Link:** [AS 7.1 changelog](https://github.com/rails/rails/blob/7-1-stable/activesupport/CHANGELOG.md?plain=1#L1129). [code, changelog]

## Low risk (booting the app or running the tests would catch these)

- **`serialize :tags, JSON`** (`app/models/note.rb:12`) raises `ArgumentError` when the class loads. Use `coder: JSON`. The JSON written to the column is unchanged [code]. [AR 7.2](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md?plain=1#L982)
- **`enum status: {...}, _prefix: true`** (`app/models/note.rb:10`) raises. Use `enum :status, {...}, prefix: true`. [AR 8.0](https://github.com/rails/rails/blob/8-0-stable/activerecord/CHANGELOG.md?plain=1#L713)
- **`alias_attribute :highlight_color, :color`** (`app/models/note.rb:14`) raises `ArgumentError` when Note's attribute methods are first generated, because `color` is a store accessor, not an attribute. Use `alias_method` for both the reader and the writer. [AR 7.2](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md?plain=1#L1051)
- **`where(notebooks: @notebook)`** (`app/controllers/notes_controller.rb:12`): a plural name for a singular association no longer resolves, so the query hits a nonexistent `notes.notebooks` column and PostgreSQL raises. Use `where(notebook: @notebook)`. [AR 7.2](https://github.com/rails/rails/blob/7-2-stable/activerecord/CHANGELOG.md?plain=1#L994)
- **`fragments.sum`** on Strings (`app/models/export.rb:42`) raises `TypeError` in the worker. Use `join`. [AS 7.1](https://github.com/rails/rails/blob/7-1-stable/activesupport/CHANGELOG.md?plain=1#L688)
- **`retry_on ..., wait: :exponentially_longer`** (`app/jobs/citation_enrichment_job.rb:7`) only raises when a retry happens, so booting won't catch it. The failure-recording block would then never run. Use `:polynomially_longer`; the delays are the same. `citation_enrichments_controller_test.rb:60` catches it. [AJ 7.2](https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md?plain=1#L110)
- **`set(wait_until: reminder_epoch)` with an Integer** (`app/models/note.rb:61`) raises `NoMethodError` (`utc` on an Integer) when the job is serialized [code]. Use `Time.at(epoch)`. [AJ 7.2](https://github.com/rails/rails/blob/7-2-stable/activejob/CHANGELOG.md?plain=1#L114)
- **`get "/notes", "/journal", to: ...`** (`config/routes.rb:18`) raises `ArgumentError` when routes load. Split it into two `get` lines and keep `journal_path`. [AP 8.1](https://github.com/rails/rails/blob/v8.1.0/actionpack/CHANGELOG.md?plain=1#L107)
- **`form_with(model: nil, ...)`** (`app/views/notes/index.html.erb:12`) raises. Drop `model: nil`. [AV 8.0](https://github.com/rails/rails/blob/8-0-stable/actionview/CHANGELOG.md?plain=1#L193)
- **Action Text `to_plain_text`** now drops script and style contents and numbers ordered lists by element, which can slightly change export Markdown (`app/models/export.rb:78`) [code].
- **The development secret file** moves from `tmp/development_secret.txt` to `tmp/local_secret.txt`, so local sessions reset once [code].
- **`schema.rb` columns are now sorted alphabetically** (diff noise on the next dump), and parallel test databases use a `_N` suffix. [AR 8.1](https://github.com/rails/rails/blob/v8.1.0/activerecord/CHANGELOG.md?plain=1#L689)
- **Dependencies the upgrade moves or adds** are compatible with the current lockfile [code: gemspec metadata]:
  - New gems: `action_text-trix`, `rackup`, `rack-session`, `useragent`.
  - Ruby 3.3.6 and rack 2.2 are accepted, which Sidekiq 6.5 needs.
  - The concurrent-ruby 1.3.4 and minitest 5 pins still fit.
  - Sidekiq 6.5.12 already supports the Rails 7.1+ logger API.

## Defaults that stay off while `load_defaults 7.0` is kept, but would break this app if adopted [code]

- **`raise_on_assign_to_attr_readonly`:** the notebook settings form resubmits the read-only `slug` (`app/controllers/notebooks_controller.rb:40`, `app/models/notebook.rb:8`).
- **`default_column_serializer = nil`:** `serialize :preferences` has no coder (`app/models/notebook.rb:7`).
- **`postgresql_adapter_decode_dates`:** `Date.iso8601` would be handed a `Date` and raise `TypeError` (`app/models/notebook.rb:40`).
- **`raise_on_invalid_cache_expiration_time`:** see M6.
- **`strict_freshness`:** changes `stale?` in `app/controllers/export_downloads_controller.rb:11`.
- **HTML5 `sanitizer_vendor`:** changes Action Text rendering.
- **`message_serializer` and `cache_format_version` 7.1:** these change cookie and cache formats, which is a problem while old and new versions run side by side.

## Parts of Rails I judged not relevant

- MySQL, SQLite and Trilogy adapter changes: the app uses PostgreSQL.
- Solid Queue, Solid Cache and Solid Cable: not used.
- Propshaft, Kamal and the new generator or authentication templates: they only affect new apps.
- Action Mailbox: not used.
- Active Storage variants, previews, S3, GCS and Azure: only the Disk service is used, with no image processor.
- Action Cable: only the empty base classes exist, and the production Redis adapter accepts redis 4.8.
- Composite primary keys, encryption, multiple databases and sharding: not used.
- `params.expect`: optional; `require.permit` still works.
- JSON-response changes such as `escape_json_responses`: the app has no JSON endpoints.
- `has_secure_password`'s 72-byte limit: the app has no password-setting form.
- `enqueue_after_transaction_commit`: it defaults to false in 8.1, so `with_lock` plus `perform_later` behaves as it does today [code].

One suggestion: upgrade in steps (7.1, then 7.2, 8.0 and 8.1) with the test suite running at each step. Many of the items above are deprecation warnings in an intermediate version, and jumping straight to 8.1 skips those warnings. `ARCHITECTURE.md` describes H1, H4 and H6 in their current form and will need updating.

---

I haven't changed anything yet. `Gemfile` and `Gemfile.lock` still pin Rails to 7.0.8.7. This report is meant to be read before deciding how to do the upgrade.

Before I start, I need answers on a few points:

- **Behavior changes (H4, H6, H7):** should digests use the reader's local day, and should the reminder preview show the new offset? Or should I keep today's behavior and add code to preserve it?
- **Deploys (H5):** does production use a rolling deploy? That decides whether workers must be upgraded first.
- **Settings and Sidekiq (M1, M2):** where should the citation provider settings go once `secrets` is gone? And should Sidekiq stay at 6.5 for now? Its adapter still works in 8.1 but logs a deprecation warning.
- **Trix (M3):** keep the vendored Trix 1.3.5, or move to Trix 2?
- **Approach:** step through each version, as the report suggests, or go straight to 8.1?

Tell me how you'd like to proceed and I'll start.