/**
 * Builds one worker payload and the worker prompt for a headless planner run.
 *
 * The payload holds the worker runner, the run configuration and one plugin
 * variant, never answer keys or results. Upload it to the printed `upload_to`
 * path with upload_thread_file; the prompt makes the worker agent check its hash,
 * start the session and wait for the result archive at `result_path`.
 *
 *   node scripts/prepare-run.ts <payload.tar.gz> --request <text> --model <id>
 *     --effort <level> --run-id <id> [--plugin-dir <dir>] [--app <path>]
 *     [--application-commit <sha>] [--skip-service-checks]
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256, writeJson } from "./files.ts";
import type { RunConfig } from "./run-worker.ts";

const RUNNER = fileURLToPath(new URL("run-worker.ts", import.meta.url));
const FROZEN_PLUGIN = fileURLToPath(new URL("../tests/planner-inputs/maintain-rails", import.meta.url));
const APP = "/home/user/workspace/repo";
const APPLICATION_COMMIT = "ab732f534dce525ae70f1d31aac6908a1ab3d8f7";
// Inside .git so neither file appears in the session's `git status`.
const PAYLOAD_NAME = ".git/planner-run-payload.tar.gz";
const RESULT_NAME = ".git/planner-run-result.tar.gz";

export interface RunOptions {
  request: string;
  model: string;
  effort: string;
  runId: string;
  pluginDir?: string;
  app?: string;
  applicationCommit?: string;
  skipServiceChecks?: boolean;
}

function workerPrompt(payloadPath: string, payloadSha256: string): string {
  return `This orb runs one scripted evaluation session. Do not read, run or change \
anything in the application yourself, and do not interpret the session's output.

1. Run this command. If it reports that the payload has not arrived, run it again.

\`\`\`sh
bash -c 'p=${payloadPath}; for i in $(seq 20); do [ -f "$p" ] && break; sleep 5; done; \
[ -f "$p" ] || { echo "payload has not arrived"; exit 1; }; \
echo "${payloadSha256}  $p" | sha256sum -c - && mkdir -p ~/planner-run && \
tar -xzf "$p" -C ~/planner-run && rm "$p" && node ~/planner-run/runner.ts start'
\`\`\`

2. Run \`node ~/planner-run/runner.ts wait\` repeatedly. Each call returns within \
two minutes. Stop when it prints a line starting with \`STATUS done\` or \`STATUS failed\`.

3. Reply with the final output of that command, verbatim.`;
}

/** Lists a plugin's files, refusing symlinks so the payload holds exactly what was hashed. */
function pluginFiles(pluginDir: string): string[] {
  if (!existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) {
    throw new Error("Plugin directory has no .claude-plugin/plugin.json.");
  }
  const entries = readdirSync(pluginDir, { recursive: true, withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("Refusing a plugin directory that contains symlinks.");
  }
  return entries.filter((entry) => entry.isFile())
    .map((entry) => relative(pluginDir, join(entry.parentPath, entry.name)))
    .sort();
}

export function prepareRun(output: string, options: RunOptions) {
  const pluginDir = options.pluginDir ?? FROZEN_PLUGIN;
  const app = options.app ?? APP;
  const files = pluginFiles(pluginDir);
  const config: RunConfig = {
    run_id: options.runId,
    request: options.request,
    model: options.model,
    effort: options.effort,
    app,
    application_commit: options.applicationCommit ?? APPLICATION_COMMIT,
    result_path: join(app, RESULT_NAME),
    skip_service_checks: options.skipServiceChecks ?? false,
    plugin_files: Object.fromEntries(files.map((name) => [name, sha256(readFileSync(join(pluginDir, name)))])),
  };

  const staging = mkdtempSync(join(tmpdir(), "planner-payload-"));
  try {
    copyFileSync(RUNNER, join(staging, "runner.ts"));
    writeJson(join(staging, "config.json"), config);
    for (const name of files) {
      const target = join(staging, "maintain-rails", name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(pluginDir, name), target);
    }
    const tar = spawnSync("tar", ["-czf", output, "-C", staging, "runner.ts", "config.json", "maintain-rails"]);
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const payloadSha256 = sha256(readFileSync(output));
  const uploadTo = join(app, PAYLOAD_NAME);
  return {
    payload: output,
    payload_sha256: payloadSha256,
    upload_to: uploadTo,
    result_path: config.result_path,
    plugin_files: config.plugin_files,
    prompt: workerPrompt(uploadTo, payloadSha256),
  };
}

if (import.meta.main) {
  const { positionals: [output], values } = parseArgs({
    allowPositionals: true,
    options: {
      request: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "run-id": { type: "string" },
      "plugin-dir": { type: "string" },
      app: { type: "string" },
      "application-commit": { type: "string" },
      // Plumbing trials only: start without PostgreSQL, Redis or installed gems.
      "skip-service-checks": { type: "boolean", default: false },
    },
  });
  const { request, model, effort } = values;
  const runId = values["run-id"];
  if (!output || !request || !model || !effort || !runId) {
    throw new Error("Usage: prepare-run.ts <payload> --request <text> --model <id> --effort <level> --run-id <id>");
  }
  console.log(JSON.stringify(prepareRun(output, {
    request, model, effort, runId,
    pluginDir: values["plugin-dir"],
    app: values.app,
    applicationCommit: values["application-commit"],
    skipServiceChecks: values["skip-service-checks"],
  }), null, 2));
}
