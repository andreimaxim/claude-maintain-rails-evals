# Evaluation-owned planner inputs

This directory owns the skill, subagent prompt and plugin discovery manifest used
by the frozen benchmark. The four runtime files match plugin commit
[`11b074b`](https://github.com/andreimaxim/claude-plugins/commit/11b074b79a35be55d5768ba3799b1dff768dfb94)
byte for byte. That link records provenance; running the bundle does not fetch or
clone the plugin repository. Keep `maintain-rails:gem-upgrade-planner` unchanged so
the existing trace collector recognizes native invocations.

## Pass the bundle before Claude Code starts

Generate a self-contained project pre-setup script from this checkout:

```sh
python3 tests/prepare-planner-orb.py > /tmp/planner-eval-pre-setup.sh
bash -n /tmp/planner-eval-pre-setup.sh
```

The coordinator embeds only the four files in `manifest.json`, not this README,
answer keys, prior results or grading instructions. The script verifies hashes,
pins the application and writes `.amp/planner-source.json` in each worker.
It refuses tracked application changes, an existing plugin Git checkout,
unexpected input files, symlinks and modified installed inputs. Repeating it with
the same inputs preserves the application and installs identical bytes.

The frozen application's `.agents/setup` expects
`../repos/claude-plugins/plugins/maintain-rails`. The bundle uses that path solely
as a filesystem bridge for unchanged setup and plugin discovery; it is not a Git
repository. Future worker projects must have **no additional repositories** and
receive the generated pre-setup script before startup. This requires an approved
project-settings change. Generating the script alone does not activate it.

Keep the normal Claude Code external-agent mode, exact model/effort and natural
upgrade request. Run each repetition in a separate app orb. Record the bundle
hashes, application commit, launch/idle timestamps, thread link and delivery
status here. Collect the original scored turn before any recovery messages.
Do not tune these prompts based on the held-out cases.

## Costs need a separate source

The retained evidence has first-handback token totals for 59 of 70 runs and
input/cache counters embedded in native-log excerpts for seven Haiku runs:
Rails5, Sidekiq1/2, Pagy5 and Faraday3/4/5. Neither source covers complete workflows.
The native excerpts distinguish uncached input (`input_tokens`), cache writes
(`cache_creation_input_tokens`) and cache reads (`cache_read_input_tokens`).
Do not price first-handback totals or partial excerpts as whole-run usage.

No whole-session API cost or `modelUsage` breakdown was found in the retained
evidence. Original native transcripts may contain more usage, but recovering
them requires access to the archived worker orbs. Amp's usage display for the
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

SDK dollar values are **client-side estimates**, not invoices. Label a graph as
estimated API cost unless provider billing records establish actual charges.
Unavailable cost is null, not zero. See the
[SDK cost-tracking contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
