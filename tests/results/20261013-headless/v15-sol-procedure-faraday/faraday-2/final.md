## Faraday 1.10.4 → 2.12.2 upgrade plan for Margin Notes

**Verdict:** The upgrade is feasible, but faraday can't be bumped on its own. Three repairs are required, all in the Gemfile and `app/models/citation/provider.rb`, and a fourth is recommended. Without them the app doesn't boot, and once it boots every citation lookup fails. With all four in place, in a disposable copy, boot, eager load, routes, database and the full test suite pass (46 runs, 0 failures), and the probes match the current version. The real checkout is unchanged: `git status` is clean and HEAD is still `ab732f5`.

The lock confirms faraday 1.10.4. The app's only faraday code is in `Citation::Provider`. It uses the `:retry` and `:basic_auth` middleware and the default net_http adapter.

### Required repairs
1. **Pin json below 3 (F1).** Add `gem "json", "~> 2.7.2"`, with a comment saying why. Faraday 2.12.2 depends on `json` with no upper limit, so Bundler picks json 3.1.0. json 3.0 rejects unknown options, and Active Support 7.0.8.7 passes one. The observed failure, from `/tmp/gem-upgrade-20261014-8224-my0oi7/runs/20261014T154030-b1e605-unmodified-boot/output.log`:
   `json-3.1.0/lib/json/common.rb:377:in 'generate': unknown keyword: quirks_mode (ArgumentError)`
   It happens while `config/secrets.yml` is read at boot, so every check failed. This pin also works with faraday 1.10.4, so it can ship first.
2. **Add the separate retry gem (F2).** Add `gem "faraday-retry", "~> 2.2"` (it resolves to 2.4.0) and put `require "faraday/retry"` at the top of `provider.rb`. Without it every lookup raises `Faraday::Error: :retry is not registered on Faraday::Request` at provider.rb:37. That error isn't one the lookup rescues, so the enrichment job crashes instead of recording "unavailable". This only works with faraday 2.x.
3. **Switch to the new basic-auth middleware (F3).** Replace `faraday.request :basic_auth, @user, @password` with `faraday.request :authorization, :basic, @user, @password`. The old form raises `:basic_auth is not registered on Faraday::Request` (log: `.../runs/20261014T154231-05fd45-retry-gem-tests/output.log`). The new form doesn't work on 1.10.4, where that middleware accepts only one value (based on reading the 1.10.4 source), so it must ship with the bump.

### Recommended repair: response character set (F4)
- **The change:** the new net_http adapter (faraday-net_http 2.0) now honours the `charset` in the response's `Content-Type`.
- **Observed:** a UTF-8 response labelled `charset=iso-8859-1` gave "Œuvres complètes — Montaigne" on the current version. After the upgrade it gave a garbled title (`Å\u0092uvres complÃ¨tes â\u0080\u0094 Montaigne`), and that title would be saved to the citation record.
- **Repair:** in `metadata_from`, parse with `JSON.parse(body.to_s.dup.force_encoding(Encoding::UTF_8))`. This restores 1.x behaviour, and it also works on 1.10.4.
- **Who is affected:** only users of a provider that labels its responses with a non-UTF-8 charset. I don't know what the real provider sends.
- **If garbled titles get saved:** those citations need fetching again.

### Optional defaults
None. `defaults.json` was empty, and the app doesn't use the settings that changed (default connection options, adapter options, error-raising middleware options).

### Rollout order
1. Ship the json pin on its own; it works with 1.10.4.
2. In one deploy, ship the faraday 2.12.2 bump, faraday-retry with its require, the `:authorization` change and the UTF-8 parse.
3. To roll back, revert that deploy's Gemfile, lock and `provider.rb` together.

Queued jobs and stored data formats are unchanged. The JSON probe produced identical output on both versions.

### Validation
**Executed.** Each probe ran on the baseline copy, on the upgraded copy without the repair, and on the upgraded copy with it. Probe files are in `/home/user/planner-run/probes-faraday/`.

- **Provider probe (`provider_probe.rb`)**, 8 cases with fixed expected results:
  - Cases: a normal 200 (the control), 503 then 200, always 503, 500, 401, missing credentials, connection refused, and a read timeout.
  - The credentials are long, unequal strings, so the Authorization header has to come out byte-for-byte the same.
  - Results: all 8 pass on the current version (B). On the upgraded copy without the auth repair, all 8 fail with `:basic_auth is not registered` (`/tmp/gem-upgrade-20261014-11110-vptua2`). Without the retry repair, all 8 fail with `:retry is not registered` (`/tmp/gem-upgrade-20261014-11203-b78ejj`). With all repairs, all 8 pass, with the same request counts (retries behave the same) and the same headers.
  - With json 3.1.0 forced back in, the upgraded copy (`/tmp/gem-upgrade-20261014-11313-hkvxd7`) fails with the `quirks_mode` ArgumentError.
- **JSON probe (`json_probe.rb`):** encode, decode and job-payload output is identical on both versions.
- **Charset and URL probe (`encoding_uri_probe.rb`):** the only difference without the repair is the iso-8859-1 case. With the repair, output matches the current version. URL checks on 11 URLs are identical even though the `uri` library moved to 1.1.2.
- **Final check of the upgraded copy:** everything passes (`/tmp/gem-upgrade-20261014-8224-my0oi7/runs/*final-*`).

**Based on reading source, not executed:** the two "won't work on 1.10.4" statements in repairs 2 and 3.

**Proposed, not run:** the test helper in `test/controllers/citation_enrichments_controller_test.rb` uses `Base64` without requiring it, and faraday 2.9 stopped loading it. It passes today only because Rails loads it. A check would remove that indirect load, run the credential test, and expect a NameError unless `require "base64"` is added.

### Limits
- I don't know the real provider's charset label or production credentials, so F4 is conditional.
- System tests and production-mode boot were not run.
- No changelog was collected for faraday-retry (1.0.4 → 2.4.0), so its behaviour is confirmed only for the probed cases.
- I didn't read all 251 faraday commits individually. The review used the changelogs, the upgrade guide, and targeted comparisons of the versioned source.

### Files
- Evidence and the closed review (63 changelog groups reviewed, 4 findings, 5 limits): `/home/user/planner-run/evidence-faraday/`, with `review.json` there.
- Lab copies (services cleaned up, logs kept): `/tmp/gem-upgrade-20261014-7001-28ctmh` (current version) and `/tmp/gem-upgrade-20261014-8224-my0oi7` (upgraded, with all repairs).

---

**Note:** The upgrade skill only produces a plan, so I haven't changed your repository yet. The plan above came from the planning agent, which ran its checks in throwaway copies. Faraday can't be bumped by itself: it also needs the json pin, faraday-retry, and the `:authorization` middleware change, and the UTF-8 parse fix is recommended. Want me to apply those changes and run the tests here?