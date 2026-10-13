# Evaluation-owned planner inputs

This directory owns the skill, subagent prompt and plugin discovery manifest used
by the frozen benchmark. The four runtime files match plugin commit
[`11b074b`](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94)
byte for byte. That link records provenance; running the bundle does not fetch or
clone the plugin repository. Keep `maintain-rails:gem-upgrade-planner` unchanged so
the existing trace collector recognizes native invocations.

## Load the bundle per session

`maintain-rails/` is a complete plugin directory. Claude Code 2.1.296 loads it for
one headless session without installing it:

```sh
claude -p "<upgrade request>" --plugin-dir <path>/maintain-rails \
  --model <model> --effort <effort> --output-format stream-json --verbose
```

A probe in the coordinator orb registered `maintain-rails:upgrade-gem` and
`maintain-rails:gem-upgrade-planner` under their benchmark names. Its final result
reported `total_cost_usd` and per-model `modelUsage`. Skill variants for hill
climbing use the same layout and namespace.

The October 13 supplement passed the bundle through a project pre-setup script in
a separate worker project. That project is deleted; its threads remain readable.
The [cycle record](../planner-suite-20261012.md) retains the route's history.

## Costs need a separate source

The original retained evidence had first-handback token totals for 59 of 70 runs and
input/cache counters embedded in native-log excerpts for seven Haiku runs:
Rails5, Sidekiq1/2, Pagy5 and Faraday3/4/5. Neither source covers complete workflows.
The native excerpts distinguish uncached input (`input_tokens`), cache writes
(`cache_creation_input_tokens`) and cache reads (`cache_read_input_tokens`).
Do not price first-handback totals or partial excerpts as whole-run usage.

No original whole-session API cost or `modelUsage` breakdown was found in the
retained evidence. Native usage was subsequently recovered from authorized
worker orbs. Amp's usage display for the
checked external-Claude thread reports orb charges and zero model tokens; that
does not establish zero external-provider usage or cost.

Before new runs, arrange capture of the original turn's Agent SDK result with
`total_cost_usd`, `modelUsage`, its session boundary and SDK/CLI version. The SDK
total and per-model breakdown include subagents; result `usage` does not. Retain
failed-run spend too. Do not sum cumulative resumed-session results or add child
costs again to the parent's whole-tree total. Collection-only turns are excluded.

If recovering per-message usage, deduplicate native message IDs: several blocks
can repeat the same usage. The SDK documents per-message `output_tokens` as a
placeholder, so prefer result-level or final-streaming output counts. Keep cache
write TTLs and request fees when available; they also affect estimated cost.

The approved recovery now retains original native usage with
`scripts/collect-usage.ts`. It excludes everything after each scored boundary,
includes nested native transcripts, deduplicates `message.id`, and retains only
usage and allowlisted metadata. Final native records have a stop reason and output
details; a request with only a streaming placeholder has unknown output. Prefix
hashes remain stable when collection turns append to the main transcript.

Of 80 benchmark slots, 73 have recovered usage: 68 recorded-request estimates and
five lower bounds. Seven Haiku workers refused collection, leaving unavailable
costs. Seven quota-interrupted Opus-high attempts retain separate usage and spend
bounds. No collection turn is counted as an evaluation or added to scored costs.

`scripts/price-usage.ts` applies the retained October 13 API list prices,
including cache-write TTLs and Haiku's per-request long-context threshold. It prices
output once, including thinking already counted there. Missing final output,
unknown prices or missing TTLs produce a null estimate and a stated lower bound.
These estimates cover recorded requests, not a claimed whole-tree bill: unlogged
helpers and billing adjustments remain outside the evidence. A later cumulative
cost-state record must not be used as the original run's cost.

SDK dollar values are **client-side estimates**, not invoices. Label a graph as
estimated API cost unless provider billing records establish actual charges.
Unavailable cost is null, not zero. See the
[SDK cost-tracking contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
