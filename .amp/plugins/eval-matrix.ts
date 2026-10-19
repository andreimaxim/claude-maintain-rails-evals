import type { PluginAPI } from "@ampcode/plugin";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "Launches the approved 60-session Sol/Astra Rails comparison, with one fresh application orb per session.";

export default function (amp: PluginAPI) {
  amp.registerTool({
    name: "launch_amp_eval_matrix",
    description: "Launches the approved Rails matrix in 60 independent app orbs. Supply the published, smoke-tested evals commit. Each orb runs exactly one session. Saves every created thread ID before sending its bootstrap instructions; never retries launches.",
    inputSchema: { type: "object", properties: { revision: { type: "string", description: "Full published evals Git commit SHA." } }, required: ["revision"] },
    async execute(input, ctx) {
      const revision = String(input.revision);
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Expected a full commit SHA");
      const root = amp.helpers.filePathFromURI(amp.system.workspaceRoot!);
      const directory = join(root, "tests/results/20261019-native-amp");
      const manifest = join(directory, "threads.json");
      mkdirSync(directory, { recursive: true });
      // Reserve before any remote work. An existing reservation requires reconciliation.
      writeFileSync(manifest, JSON.stringify({ revision, status: "reserved" }) + "\n", { flag: "wx" });
      const runs = ["sol", "astra"].flatMap((family) => ["low", "medium", "high"].flatMap((effort) =>
        ["original", "v21"].flatMap((variant) => Array.from({ length: 5 }, (_, i) => ({
          id: `${family}-${effort}-${variant}-${i + 1}`, family, effort, variant, repetition: i + 1,
          model: family === "sol" ? "openai/gpt-6.1-sol" : "openai/gpt-6-astra",
          thread: null as string | null, status: "pending", error: null as string | null,
        })))));
      const save = () => {
        writeFileSync(`${manifest}.tmp`, JSON.stringify({ revision, case: "rails", runs }, null, 2) + "\n");
        renameSync(`${manifest}.tmp`, manifest);
      };
      save();
      const operator = amp.createAgent({ extends: "medium", model: "openai/gpt-6.1-sol", reasoningEffort: "medium", features: [] });
      await Promise.all(runs.map(async (run) => {
        try {
          run.status = "creating";
          save();
          const child = await operator.createThread({ parentThreadID: ctx.thread.id,
            executor: "orb", project: "andrei/claude-maintain-rails-sample", features: [] });
          run.thread = child.id;
          run.status = "created";
          save();
          const source = run.variant === "original" ? "tests/planner-inputs/maintain-rails"
            : "tests/planner-variants/v21-resolve-deps/maintain-rails";
          const paths = ["scripts/prepare-amp-run.ts", "scripts/files.ts", "tests/amp-runtime/index.ts",
            `${source}/agents/gem-upgrade-planner.md`, `${source}/skills/upgrade-gem/SKILL.md`];
          const command = `set -euo pipefail
stage="$PWD/.git/amp-inputs"
mkdir -p "$stage" .amp/plugins
for path in ${paths.map((path) => `'${path}'`).join(" ")}; do
  mkdir -p "$stage/$(dirname "$path")"
  curl --fail --silent --show-error --retry 3 'https://raw.githubusercontent.com/andreimaxim/claude-maintain-rails-evals/${revision}/'"$path" -o "$stage/$path"
done
node "$stage/scripts/prepare-amp-run.ts" .git/amp-payload.tar.gz --model '${run.model}' --effort '${run.effort}' --variant '${run.variant}'
tar -xzf .git/amp-payload.tar.gz -C .amp/plugins`;
          await child.appendUserMessage({ type: "user-message", content: `Run identifier: ${run.id}.

Run this one native Amp evaluation in its own app orb. You are the harness operator, not the tested agent. Do the work yourself. Do not read or change the application, clone the evals repository, or read grading material. Only the frozen plugin may create the configured main and planner threads. Do not create any other threads or run additional sessions.

Prepare only the published runtime inputs with this command in the app workspace:
\`\`\`bash
${command}
\`\`\`

Load .amp/plugins/maintain-rails/index.ts with load_plugin, then call the registered run_eval tool once, directly. Tool search does not list these local plugin tools. Wait for its result without restarting it. Treat a failure as an outcome to record, not permission to change the prompt, application, payload, or rerun the session.

After the call settles, archive .git/amp-evals with tar -czf .git/amp-results.tar.gz -C .git amp-evals. Full exports under amp-evals/private contain thinking and metadata; keep them private and do not print them. Report the tool result and archive path to the parent thread ${ctx.thread.id} using send_thread_message, and include the same findings in your final response. Do not push code or archive this thread.` });
          run.status = "started";
        } catch (error) {
          run.error = String(error);
          run.status = run.thread ? "dispatch-outcome-unknown" : "creation-outcome-unknown";
        }
        save();
      }));
      return JSON.stringify({ manifest, started: runs.filter((run) => run.status === "started").length,
        failures: runs.filter((run) => run.error) });
    },
  });
}
