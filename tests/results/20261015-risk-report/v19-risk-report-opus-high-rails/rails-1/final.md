I haven't changed anything yet. Before any upgrade, I had the gem-upgrade planner check what moving from your current Rails 7.0.8.7 to 8.1.0 would affect in this app. Here is its full report:

---

# Rails upgrade risk report for Margin Notes: 7.0.8.7 to 8.1.0

This upgrade crosses four release series (7.1, 7.2, 8.0, 8.1). Most of what changes for this app is deprecated behavior that 7.1 warned about and 7.2 or 8.0 removed. Skipping straight to 8.1 means you never see those warnings.

I compared the released gems (all 12 Rails components for 7.0.8.7 and 8.1.0, plus `action_text-trix` 2.1.19 and `sidekiq` 6.5.12), the CHANGELOGs for 7.1 through 8.1, and Rails commit history. I didn't install, run or change anything in the app. The unpacked sources are in `/tmp/railsdiff/src/`.

Each claim is tagged with where it comes from:
- **[CL]** a CHANGELOG entry
- **[code]** gem or app source I read
- **[inf]** my own inference

I rated 8 changes high, 4 medium and 15 low. Your test suite would catch most of the high-risk ones, but two can't be caught by tests at all: the BigDecimal job-argument change during a rolling deploy, and the Astana time zone.

## Facts about the app the ratings depend on (please correct any that are wrong)

- **Ruby and Rails:** Ruby 3.3.6. Rails 8.1 needs at least 3.2 [code].
- **Framework defaults:** `config.load_defaults 7.0` (`config/application.rb:12`). Nothing opts into later defaults. All ratings assume you keep 7.0 defaults.
- **Database:** PostgreSQL only, through pg 1.6.0. MySQL, SQLite and Trilogy changes don't apply.
- **Rendering:** the app renders HTML with ERB, Turbo, importmap and Sprockets. There are no JSON endpoints and no Jbuilder views.
- **Background jobs:** Active Job runs on Sidekiq 6.5.12 with redis 4.8.1 (`config/application.rb:24`). Tests use the `:test` adapter.
  - Active Job classes: `CitationEnrichmentJob`, `DigestJob`, `NoteReminderJob`.
  - `ExportJob` is a native Sidekiq job.
  - Reminder jobs can sit in Sidekiq's schedule for weeks.
  - I assumed web servers and workers on different Rails versions can run side by side during a deploy.
- **Rich text and files:** Action Text with a custom tag allowlist and a vendored Trix 1.3.5. Active Storage uses the local Disk service, with no image processor.
- **Caching:** production uses the default cache store with `perform_caching = true`. `app/views/exports/_export.html.erb:26` uses fragment caching. Dev and test use `null_store`.
- **Time zones:** the app zone is UTC, and each reader has a zone in `users.time_zone`.
- **Mail:** sent with `deliver_now` from inside jobs.
- **Configuration:** provider settings come from `config/secrets.yml` via `Rails.application.secrets`.
- **Unused frameworks:** no Action Cable channels or client, and no Action Mailbox.

**Version recommendation:** target 8.1.4 rather than 8.1.0 [CL]. 8.1.0 is missing later security fixes for code this app uses:
- Active Storage Disk service path traversal (CVE-2026-33195) and glob injection (CVE-2026-33202)
- direct-upload metadata filtering (CVE-2026-33173), which Trix uploads go through
- NumberHelper (CVE-2026-33176, CVE-2026-33169) and `SafeBuffer#%` (CVE-2026-33170)

The 7.0 series no longer gets fixes [inf]. I only reviewed up to 8.1.0, not 8.1.1–8.1.4.

## High risk: behavior changes without an error

**1. `return` inside a transaction now commits instead of rolling back**
- **Before:** in 7.0, leaving a transaction block with `return` rolled back any writes [code].
- **Now:** it commits. 7.1 restored committing on early return behind a config setting, and 7.2 made committing the only behavior [CL] ([#48600](https://github.com/rails/rails/pull/48600), [eccc606](https://github.com/rails/rails/commit/eccc6061f4f3abdfdeb9a363987a898418d9498f)).
- **Where:** `app/models/import.rb:53-58`, which runs `save!` and then `return false unless row.note.save`.
- **What could go wrong:** a CSV with one invalid row would save the `Import` and every note before that row. This breaks the "saves nothing" promise in `ARCHITECTURE.md`.
- **Tests:** `test/controllers/imports_controller_test.rb:65-72` would catch it [inf].

**2. Job time arguments now keep the reader's time zone**
- **Before:** a `TimeWithZone` job argument was rebuilt in `Time.zone`, which is UTC here [code].
- **Now:** it is rebuilt in the zone it was serialized with [CL] ([#50240](https://github.com/rails/rails/pull/50240)).
- **Where:**
  - `app/models/user.rb:35,41` passes the request time in the reader's zone.
  - `app/mailers/digest_mailer.rb:8-9` uses `.to_date` and `.all_day` on it.
- **What could go wrong:** digests would cover the reader's local day instead of the UTC day. The Redis reservation key is still the UTC date (`user.rb:36`). Comments in `digest_job.rb:4-5` and `digest_mailer.rb:3-5` become wrong.
- **Tests:** `test/controllers/digests_controller_test.rb:33-35` would fail [inf].

**3. BigDecimal job arguments use a format Rails 7.0 workers can't read**
- **Before:** in 7.0, a BigDecimal was passed through raw and arrived in the worker as a string [code].
- **Now:** it uses `BigDecimalSerializer`, which 7.0 doesn't have. 7.1 added it behind a flag "to avoid deploy races", and 7.2/8.0 removed the flag [CL] ([#45618](https://github.com/rails/rails/pull/45618), [2a761d2](https://github.com/rails/rails/commit/2a761d23d2322f3cf406aba0426ea356673da508)).
- **Where:** `app/models/user.rb:41` passes `reading_completion`.
- **What could go wrong:** during a rolling deploy, a digest queued by an 8.1 web process and picked up by a 7.0 worker fails to deserialize. Sidekiq would retry it, so delivery is late and noisy rather than lost [inf].
- **Tests:** can't catch this. `BigDecimal(params[:completion])` handles both formats.

**4. `HashWithIndifferentAccess#stringify_keys` now converts integer keys**
- **Before:** integer keys were left as integers.
- **Now:** every key becomes a string [CL] ([#53125](https://github.com/rails/rails/pull/53125)). 8.1 has no override, so the generic `stringify_keys` applies [code].
- **Where:**
  - `app/models/import.rb:38-42` keys annotations by integer line number.
  - `app/views/imports/preview.html.erb:22` calls `.stringify_keys`, then lines 42-44 look up `annotations[row.line]` with an integer.
- **What could go wrong:** every annotation silently disappears from the import preview.
- **Tests:** `imports_controller_test.rb:22,24` would fail [inf].

**5. `citation[:id]` no longer returns the `doi` primary key**
- **Before:** `read_attribute(:id)` mapped to the custom primary key [code].
- **Now:** `citations` has no `id` column, and 8.1 quietly returns `nil` instead of raising [code] (`activemodel` `AttributeSet::Builder#default_attribute` → `Attribute.null`). This was deprecated in 7.1 and removed in 7.2 [CL] ([#49019](https://github.com/rails/rails/pull/49019), [39997a0](https://github.com/rails/rails/commit/39997a0f049dfb3d94b28d1cb131b9136a1b7b0a)).
- **Where:** `app/models/import.rb:68`.
- **What could go wrong:** the receipt CSV's `doi` column comes out empty.
- **Tests:** `imports_controller_test.rb:45` would fail.

**6. `TimeWithZone#to_time` now keeps the zone instead of the fixed offset**
- **Before:** `to_time` kept the fixed UTC offset [code].
- **Now:** it always keeps the zone [CL, 8.1] ([c79dc28](https://github.com/rails/rails/commit/c79dc282d687cff1c5dc81e19d27257dca5e6a80)).
- **Where:** `app/models/note.rb:43-45` (`reminder_at.to_time + 86_400`), shown in `app/views/notes/_reminder.html.erb:19`.
- **What could go wrong:** across a daylight saving change, the "24 hours later" preview becomes 08:00 -05:00 instead of 09:00 -04:00. I confirmed this with a plain-Ruby stub zone [inf]. The epoch that actually gets scheduled is unchanged [inf].
- **Tests:** `reminders_controller_test.rb:21` would fail.

**7. The "Astana" time zone now maps to UTC+5 instead of UTC+6**
- **Change:** "Astana" changed from `Asia/Dhaka` to `Asia/Almaty` [code, CL] ([#51317](https://github.com/rails/rails/pull/51317)). Asia/Almaty is UTC+5 in current tzdata [inf].
- **Where:** readers with that zone, through `app/models/user.rb:13,22`, `note.rb:37` and `accounts/edit.html.erb:15`.
- **What could go wrong:** new local-time reminders shift by an hour, and displayed times change.
- **Tests:** can't catch this. Query production for users with this zone.
- Other mapping changes ("Canberra" and "Greenland" moved to new zone IDs, and "Asuncion" was added) don't change the offset. Only "Astana" matters.

**8. Action Text plain-text conversion changed**
- **Before:** `<script>` and `<style>` text was included, and ordered-list numbers counted whitespace text nodes. For example `<ol>\n<li>` gave "2.", "4." [code].
- **Now:** script and style text is dropped, and numbering is 1, 2 [code] ([#54226](https://github.com/rails/rails/pull/54226), [0a5faea](https://github.com/rails/rails/commit/0a5faeaf71745b05d937b579a4da5bd90e0b6b58)).
- **Where:** Markdown exports (`app/models/export.rb:78`), and previews in `notes/index.html.erb:53` and `imports/preview.html.erb:58`.
- **What could go wrong:** only bodies imported from CSV are likely to contain such HTML [inf]. These are fixes, but they silently change what export files contain.

## Medium risk: raises an error, and the fix needs a decision

**9. `Rails.application.secrets` was removed**
- **Change:** deprecated in 7.1, removed in 7.2 [CL] ([0c76f17](https://github.com/rails/rails/commit/0c76f17f2dbf0d7ad90c890e6f334743cacce41f)).
- **Where:**
  - `app/models/citation/provider.rb:13` and `config/secrets.yml`
  - tests in `test/controllers/citation_enrichments_controller_test.rb:45,117-122`
- **What could go wrong:** the error doesn't appear at boot. It's a `NoMethodError` inside `CitationEnrichmentJob` [inf]. That isn't a `Provider::Error`, so Sidekiq retries it and the citation stays "pending". `ARCHITECTURE.md` also documents this setup.
- **Decision:** move to credentials, `config_for`, or plain ENV. `config_for` also returns symbol keys [inf].

**10. Action Text's `allowed_tags` now defaults to `nil`**
- **Change:** `ActionText::ContentHelper.allowed_tags` defaults to `nil`, and the built-in defaults are computed in `sanitizer_allowed_tags` [code] ([#48746](https://github.com/rails/rails/pull/48746)).
- **Where:** `config/initializers/action_text.rb:3` does `allowed_tags += ...`.
- **What could go wrong:** boot fails with `NoMethodError` on `nil`. The obvious fix, setting it to just `%w[details summary]`, would silently strip all other formatting and attachments.
- **Decision:** rebuild the list from the sanitizer defaults plus `action-text-attachment`, `figure`, `figcaption`, `details` and `summary`. If you later adopt the HTML5 sanitizer, recheck the list.

**11. Rails' built-in Sidekiq adapter is deprecated and will be removed in 8.2**
- **Change:** `check_adapter` warns when you set `queue_adapter = :sidekiq` [CL, code] ([#53058](https://github.com/rails/rails/pull/53058)). Sidekiq 6.5.12 still works with 8.1's adapter; I checked its `configure_client` and `on` APIs [code].
- **Where:** `config/application.rb:24`.
- **Decision:** the replacement is Sidekiq 7.3.3 or later, which switches to the `redis-client` gem. These Sidekiq-side changes are from memory, not verified in this review [inf]:
  - `redis.sadd` returns an Integer, and `0` is truthy in Ruby, so the digest de-duplication in `user.rb:38` silently breaks.
  - `rescue Redis::BaseError` in `notebook.rb:28` and `Redis::CannotConnectError` in the digest test stop matching.
  - Strict arguments reject the symbol-keyed `{ format: "markdown" }` in `notebook.rb:26`.

**12. Trix now comes from the `action_text-trix` gem (Trix 2.1.x)**
- **Change:** Action Text no longer vendors Trix [CL] ([d0d2d31](https://github.com/rails/rails/commit/d0d2d31f62cae9bdc9360b9f179b4311377e9957)).
- **Where:**
  - `*= require trix` in `app/assets/stylesheets/actiontext.css:6` would load the Trix 2.1.19 stylesheet [code].
  - `app/views/layouts/application.html.erb:13` still loads the vendored Trix 1.3.5 script.
- **What could go wrong:** nothing raises. The risk is a styling mismatch between the editor and its stylesheet [inf].
- **Decision:** keep the vendored editor, or adopt the gem's Trix 2 and drop the vendored file. Check the editor visually either way.

## Low risk: mechanical changes that booting or running tests would catch

- `note.rb:12`: `serialize :tags, JSON` raises `ArgumentError` at class load. Use `coder: JSON` [code, CL] ([8069cc8](https://github.com/rails/rails/commit/8069cc83e8a508e3f578c49be9007b08e3c5516e)).
- `note.rb:10`: `enum status: ..., _prefix: true` raises `ArgumentError`. Use `enum :status, {...}, prefix: true` [code] ([b9226a6](https://github.com/rails/rails/commit/b9226a68bb18283f9f80e73c4bfa77f2a5309740)).
- `note.rb:14`: `alias_attribute :highlight_color, :color` raises when the first `Note` is created, because `color` is a store accessor and not an attribute. Replace it with a reader and writer `alias_method` pair [code] ([94d24f4](https://github.com/rails/rails/commit/94d24f45047c3f557828e54986e106120e8ca2d6)).
- `notes_controller.rb:12`: `where(notebooks: @notebook)` used to be singularized to the `notebook` association. It now produces SQL against a `notes.notebooks` column that doesn't exist. Use `where(notebook:)` [code] ([4bf2c4c](https://github.com/rails/rails/commit/4bf2c4cea19c422bb3358d4c2ddad6db7247604f)).
- `citation_enrichment_job.rb:7`: `wait: :exponentially_longer` raises "Couldn't determine a delay" only when the provider is unavailable, not at boot. `:polynomially_longer` uses the same formula. The test at `citation_enrichments_controller_test.rb:60-71` covers it [code] ([03dae98](https://github.com/rails/rails/commit/03dae98092e21260eb588f432af4bc2bd92d096b)).
- `note.rb:61`: `set(wait_until: <Integer>)` raises `NoMethodError` (`Integer#utc`) when the job is serialized. Use `Time.at(epoch)` [code] ([7982896](https://github.com/rails/rails/commit/798289699d49c7443ce11b495444cb900d72c59e)).
- `export.rb:42`: `fragments.sum` over strings raises `TypeError`, because Rails' `Enumerable#sum` override was removed. Use `join`. It already prints a deprecation warning under 7.0 [code] ([3ec6297](https://github.com/rails/rails/commit/3ec629784cac7a8b518feb402475153465cd8e96)).
- `notes/index.html.erb:12`: `form_with(model: nil, ...)` raises `ArgumentError`. Drop `model: nil` [code] ([0c150ba](https://github.com/rails/rails/commit/0c150bacaaca7772121300ca124e3ed5392f6ab9)).
- `config/routes.rb:18`: `get "/notes", "/journal", to:` raises "Wrong number of arguments". Split it into two routes. Routes are drawn lazily since 8.0, so the error may only appear on the first request [code, CL] ([d1f523d](https://github.com/rails/rails/commit/d1f523dbfb8b1c1d8ebf79f3ddc6bf809f4e8c32)).
- `config/environments/test.rb:31`: `show_exceptions = false` is now treated as "show all", so the `assert_raises(RecordNotFound)` tests fail. Use `:none` [code] ([ec2c266](https://github.com/rails/rails/commit/ec2c2666c255029593dda2f78e89b457cf8509fc)).
- `exports/_export.html.erb:26`: a negative `expires_in` is now dropped and logged, so an "Expired" fragment is cached with no expiry. The content is still correct [code].
- Active Storage now touches the owning records after blob analysis. Exports and notes with attachments get a later `updated_at`, which can matter for the digest's "updated today" filter near midnight [CL, inf].
- 8.1.0 sorts `db/schema.rb` columns alphabetically, so the next dump produces a noisy diff. A later 8.1.x reverted this [CL].
- In development, `secret_key_base` moves to `tmp/local_secret.txt`, which resets development sessions once [CL].
- The `concurrent-ruby` 1.3.4 pin worked around a 7.0-specific problem and can be reconsidered after upgrading [inf].

## Not relevant to this app, with reasons

- **Defaults that only change if you raise `load_defaults`.** Each of these would break app code if you opt in [code]:
  - `postgresql_adapter_decode_dates`: `Date.iso8601(Date)` in `notebook.rb:40` would raise.
  - `raise_on_assign_to_attr_readonly`: the notebook form resubmits the read-only slug.
  - `default_column_serializer = nil`: `serialize :preferences` would raise.
  - Others with no breakage found: the HTML5 sanitizer, `strict_freshness` (affects ETag handling on the export download), and `remove_hidden_field_autocomplete`.
- **Enqueueing jobs after the transaction commits.** The 8.1 default is `false`, so jobs still enqueue inside `with_lock` as the code expects [code].
- **YAML column serializer:** still the default, and `preferences` stays readable [code].
- **MySQL, SQLite and Trilogy adapter changes:** the app uses PostgreSQL.
- **Action Cable:** no channels. The Redis adapter still accepts redis 4 [code].
- **Action Mailbox, Solid Queue/Cache/Cable, authentication generator, Kamal, `bin/ci`:** not used.
- **JSON rendering and escaping changes:** the app has no JSON endpoints.
- **Active Storage variants and image analyzers, and S3/GCS/Azure services:** no image processor, and only the Disk service is used.
- **Changes to the cache format, MemCache or Redis cache stores:** cache format 7.0 is still supported, and no Redis or MemCache store is used [code].
- **`ActiveRecord::Base.connection`** in `notebook.rb:40`: only soft-deprecated, with no warning by default [code].
- **`rich_text_area`:** still available as an alias [code].

---

The Gemfile and `Gemfile.lock` haven't been touched. This is a jump across four release series, and several of the decisions above need your call before I start:

- **Which version:** the planner recommends 8.1.4 instead of 8.1.0, because 8.1.0 lacks later security fixes for Active Storage and Action Text. It only reviewed changes up to 8.1.0, though.
- **Secrets (#9):** move the provider settings from `Rails.application.secrets` to credentials, `config_for`, or plain environment variables.
- **Sidekiq (#11):** stay on 6.5.12 for now (it works with 8.1 but shows a deprecation warning), or move to Sidekiq 7.3.3 or later as a separate change.
- **Trix (#12):** keep the vendored Trix 1.3.5 editor, or switch to the Trix 2 that now comes with Action Text.
- **How to upgrade:** go straight to 8.1, or step through 7.1 and 7.2 first. Stepping makes the removed features show up as deprecation warnings before they break.
- **Before deploying:** two risks can't be caught by tests. Check production for readers using the "Astana" time zone (#7). Also plan for the rolling deploy, when digest jobs queued by an 8.1 web server can fail on a 7.0 worker until all workers are upgraded (#3).

Tell me which version to target and what you want for each choice, and I'll start the upgrade.