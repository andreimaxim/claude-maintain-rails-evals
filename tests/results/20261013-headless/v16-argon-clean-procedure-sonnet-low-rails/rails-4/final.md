# Upgrade plan: rails 7.0.8.7 to 8.1.0 (Margin Notes)

I haven't implemented anything. The planner worked in a disposable copy, and the working repo is still clean.

The planner found about 15 code and config changes. With all of them applied in the copy, the suite passes under both `load_defaults 7.0` and `load_defaults 8.1` (46 runs, 340 assertions, 0 failures). Without them the app can't boot.

## Required changes (needed as soon as the gem is bumped)

| # | Location | Problem on 8.1.0 | Fix |
|---|---|---|---|
| 1 | `config/initializers/action_text.rb:3` | Boot fails: `ContentHelper.allowed_tags` is nil. | See snippet below. |
| 2 | `app/models/note.rb:10` | The `enum status: {...}, _prefix: true` syntax is rejected. | `enum :status, { draft: 0, ready: 1 }, prefix: true` |
| 3 | `app/models/note.rb:12` | `serialize :tags, JSON` is rejected. | `serialize :tags, coder: JSON` |
| 4 | `app/models/notebook.rb:7` | Bare `serialize :preferences` raises under 8.1 defaults. | `serialize :preferences, coder: YAML` |
| 5 | `app/models/note.rb:14` | `alias_attribute` on a `store_accessor` is rejected. | `alias_method :highlight_color, :color` and `alias_method :highlight_color=, :color=` |
| 6 | `config/routes.rb:18` | `get "/notes", "/journal", ...` is rejected. | Two separate `get` lines. Route names stay the same. |
| 7 | `citation/provider.rb:13`, `config/secrets.yml`, citation enrichments test | `Rails.application.secrets` is gone, which would break citation enrichment in production. | Move to `config/citation_provider.yml`, add `config.x.citation_provider = config_for(:citation_provider)`, and read that in `Provider`. |
| 8 | `app/models/export.rb:42` | `fragments.sum` no longer concatenates strings. | `fragments.join` |
| 9 | Gemfile | The bump resolves json 3.1.0, which breaks `ActiveSupport::JSON.decode`. | Add `gem "json", "~> 2.7"`. |
| 10 | `notes_controller.rb:11` | `where(notebooks: @notebook)` fails. | `where(notebook: @notebook)` |
| 11 | `notes/index.html.erb:12` | `form_with(model: nil)` returns a 500. | `model: false` |
| 12 | `note.rb:62` | `wait_until:` rejects an Integer epoch. | `Time.at(reminder_epoch)` |
| 13 | `citation_enrichment_job.rb:7` | `:exponentially_longer` raises. | `:polynomially_longer` |
| 14 | `import.rb:53-58` | `return false` inside `transaction` now commits, so a partial import is saved. | Use `ActiveRecord::Rollback` (snippet below). |
| 15 | `import.rb:69` | `citation[:id]` is blank because Citation's primary key is `doi`. | `citation&.doi` |
| 16 | `imports/preview.html.erb:22` | `stringify_keys` now converts Integer keys, so annotation text is dropped. | `annotations = @import.annotations` |
| 17 | `digest_mailer.rb:7` | The sender's time zone is now kept, so the digest day shifts. | Add `requested_at = requested_at.utc`. |
| 18 | `note.rb:44` | `to_time + 86_400` shifts across the DST change. | `(reminder_at.utc + 86_400).getlocal(reminder_at.utc_offset)` |
| 19 | `exports/_export.html.erb:26` | A negative `expires_in` raises on 8.1 defaults, and on 7.0 defaults the entry never expires. | `[export.expires_at - Time.current, 0].max` |
| 20 | `config/environments/test.rb:31` | Test only: `show_exceptions = false` no longer lets exceptions raise. | `:none` |

Snippets for #1 and #14:

```ruby
# config/initializers/action_text.rb
helper = ActionText::ContentHelper
base = helper.allowed_tags ||
  (helper.sanitizer.class.allowed_tags + [ ActionText::Attachment.tag_name, "figure", "figcaption" ])
helper.allowed_tags = base | %w[ details summary ]
```

```ruby
# app/models/import.rb, Import#apply
applied = transaction do
  save!
  rows.each { |row| raise ActiveRecord::Rollback unless row.note.save }
  true
end
applied == true
```

## Rollout order

- **Ship before the bump:** #5, #7, #8, #10, #11, #14, #15, #16, #17, #18, #19, and the `notebooks_controller` permit change below. Per the planner, these also work on 7.0.8.7, though most were checked by reading the 7.0 source rather than by running them. Ship #14 first, because it stops partial imports from committing.
- **After the bump only:** #1, #2, #3, #4, #6, #9, #13, #20.

## Changes only needed if you adopt newer `load_defaults`

CLAUDE.md says to keep the existing defaults, so I wouldn't adopt these as part of this upgrade. The planner kept `load_defaults 7.0` and ran the suite under 8.1 defaults separately.

- `notebooks_controller.rb:40`: drop `:slug` from `permit`. Under 7.1 defaults, assigning the readonly `slug` raises. This also works on 7.0.8.7.
- `notebook.rb:40`: change `Date.iso8601(day)` to `Date.iso8601(day.to_s)`, because PostgreSQL dates now arrive as `Date`.
- `ExportDownloadsController#stale?` has no test, and 8.0's `strict_freshness` changes how it behaves. Add one.
- `yjit` is on by default from 7.2, so check that your deploy image supports it.

## Risks

- **No schema change is needed.** `db/schema.rb` will be re-dumped with columns sorted alphabetically, which is a diff-only change.
- **Rolling back:** drain or tolerate Active Job payloads enqueued under 8.1. This comes from source reading, not a run.
- **Rack stays at 2.2.24.** Moving to Rack 3 would be a separate piece of work.

## Not verified

- `bin/rails test:system` was not run.
- Mixed-version job payloads, cache-format interchange, `message_serializer` rollback and `strict_freshness` were not run.
- #12 has no test where the reminder's epoch differs from its created-at time. Add one.

## Open questions

- **json pin:** is the `json ~> 2.7` pin acceptable until Rails supports json 3.x?
- **Development `show_exceptions`:** should `show_exceptions = :none` also apply to `development.rb`? No failure appeared there.

Do you want me to implement the plan? I'd start with the changes that can ship before the bump.