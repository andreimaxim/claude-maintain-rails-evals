# Expected risk for each planted item (draft)

This file labels every planted item in the answer keys with the risk a good
report should give it. It is for the coordinator and the judge only. Never copy
it into an application worker orb.

The labels use the risk levels in the v19 planner prompt:

- High: the behavior changes without an error in an area the application uses,
  or the change affects stored data or queued jobs during a mixed-version rollout.
- Medium: the application fails loudly, but fixing it needs a decision. New
  framework defaults are medium unless adopting them would change behavior
  without an error.
- Low: a mechanical change with a direct replacement that booting or the tests
  would catch.

Items marked "default" apply only if the application adopts the new framework
default. Items marked "judgment call" are ones where the definitions could
support another level; the user should confirm them.

## Rails 7.0.8.7 to 8.1.0

| ID | Risk | Upstream change | Why this level |
| --- | --- | --- | --- |
| R01 | Low | Keyword-style `enum status: {...}` is removed. | Raises when the model loads; `enum :status, {...}, prefix: true` replaces it. |
| R02 | Low, judgment call | Passing the coder as the second argument to `serialize` is removed. | Raises when the model loads; `coder: JSON` replaces it. The fix must ship with the bump, because Rails 7.0 ignores `coder:` and would write YAML into the JSON column. |
| R03 | Low | `alias_attribute` to something that is not an attribute raises. | The error names the fix (`alias_method`). |
| R04 | Low | `where(notebooks: record)` with the table name is no longer read as the association. | Raises `PG::UndefinedColumn` on the notes list; `where(notebook:)` replaces it. No changelog entry names it, so a report has to find it in the diff. |
| R05 | High | `record[:id]` reads the `id` column, not the primary key. | Import receipts lose their DOIs without an error. |
| R06 | High | `return` inside a `transaction` block now commits instead of rolling back. | A failed import saves the earlier rows without an error. |
| R07 | Low | Active Support no longer lets `sum` concatenate strings. | Raises `TypeError` in the export job; `join` replaces it. |
| R08 | High | `HashWithIndifferentAccess#stringify_keys` now turns integer keys into strings. | The import preview drops annotations without an error. |
| R09 | High | A negative cache `expires_in` is dropped with a logged error; `raise_on_invalid_cache_expiration_time` (7.1) makes it raise. | With the current defaults, the expired-export fragment is cached with no expiry and an error is logged on every render, without raising. If the default is adopted, the exports page raises, even on a cache hit. |
| R10 | High, judgment call | `to_time` keeps the named zone instead of the offset. | The displayed time shifts across a DST change without an error. The instant doesn't change, so the harm is small. |
| R11 | High | Active Job keeps a `TimeWithZone` argument's zone. | The digest covers the reader's local day instead of the UTC day, without an error. |
| R12 | High | Active Job serializes `BigDecimal` arguments with a new serializer. | A job enqueued by 8.1 fails on a 7.0 worker, so only a mixed-version rollout or a rollback breaks. |
| R13 | Low | `wait_until:` no longer accepts an Integer. | Raises when a reminder is scheduled; `Time.at` replaces it. |
| R14 | Low | The `:exponentially_longer` retry delay is removed. | The error appears only on the first retry, but this app's test at `citation_enrichments_controller_test.rb:60` exercises a retry and catches it; `:polynomially_longer` replaces it. |
| R15 | Low | `form_with(model: nil)` raises. | The notes list returns 500; dropping `model: nil` fixes it. |
| R16 | Low | One route declaration with two paths raises. | Routes fail to load; two declarations replace it. |
| R17 | Medium | `show_exceptions = false` no longer means "raise"; any value other than `:none` or `:rescuable` acts as `:all`. | Tests that expect exceptions fail, and other exceptions become rendered error pages, so tests that don't check the status hide failures. The developer chooses `:none` or `:rescuable`. |
| R18 | Medium | Action Text's `allowed_tags` is nil by default. | Boot fails, and the fix needs a complete, safe allowlist, which is a security decision. |
| R19 | Medium | `Rails.application.secrets` is removed. | Raises when the provider is used, and the developer must choose where the settings move. |
| R20 | Medium, default | `default_column_serializer = nil` (7.1). | If adopted, `serialize` without a coder raises. |
| R21 | Medium, default | `raise_on_assign_to_attr_readonly` (7.1). | If adopted, a notebook update raises because the form resubmits the read-only slug. |
| R23 | Medium, default | `postgresql_adapter_decode_dates` (7.2). | If adopted, raw SQL dates become `Date` objects and `Date.iso8601` raises. |
| R25 | Low, default | `strict_freshness` (8.0). | If adopted, some conditional GET requests get 304 instead of 200 without an error. A 304 happens only when the client's ETag matches the blob checksum, so the client already has the same bytes, and the ownership and expiry checks still run first. |

Rails totals: 7 high, 6 medium, 10 low.

Not planted, but seen in every Rails and Faraday run: the upgrade can resolve
json 3, which breaks existing `.to_json` calls in ERB config and Active Support's
JSON decoding. A report that names it gets extra credit as a medium or low item.

## Sidekiq 6.5.12 to 7.3.9

| ID | Risk | Upstream change | Why this level |
| --- | --- | --- | --- |
| SK1 | Low | Sidekiq 7 rejects job arguments that are not JSON types, such as Symbol keys. | Raises at enqueue; string keys replace them. |
| SK2 | High | `sadd` returns an Integer instead of a Boolean, and 0 is truthy in Ruby. | Duplicate digests are enqueued without an error. |

Extra credit: Sidekiq 7 also rejects the digest's `BigDecimal` argument (low),
and the Redis-down cleanup no longer catches `RedisClient::CannotConnectError`
(high, because the cleanup is skipped without a clear error).

## Pagy 8.6.3 to 9.3.5

| ID | Risk | Upstream change | Why this level |
| --- | --- | --- | --- |
| PG1 | Low, judgment call | The `items` extra and settings are renamed to `limit`. | Boot fails, and each setting has a direct replacement. A partial rename changes page size and the cap without an error, so the report should list all the renamed settings together. |
| PG2 | Medium, judgment call | Pagy 9 no longer turns invalid page numbers into page one. | Blank, zero, negative, and non-numeric pages return 500. The error is loud, but the tests don't cover it, and the developer must decide how to handle bad input. |

## Faraday 1.10.4 to 2.12.2

| ID | Risk | Upstream change | Why this level |
| --- | --- | --- | --- |
| FD1 | Low | The retry middleware moved to the `faraday-retry` gem. | Registration raises before any request; adding the gem fixes it. |
| FD2 | Low | The `basic_auth` request middleware is removed. | Registration raises; `request :authorization, :basic, ...` replaces it. |

## Concurrent-ruby 1.3.4 to 1.3.8

| ID | Risk | Upstream change | Why this level |
| --- | --- | --- | --- |
| CR1 | Low | None. The Gemfile pins 1.3.4 exactly. | The requirement must change before Bundler can resolve 1.3.8. |
| CR2 | Low | Version 1.3.5 stops loading `logger`, which Rails 7.0 needs while it loads. | Boot fails; `require "logger"` in `config/boot.rb` fixes it. A report can only find it by connecting two gems, not from the application's code. |

## No-op: pagy 8.6.3 to 8.6.3

NO1: the report should say the requested version is already locked and list no
changes. Any rated change is an error.
