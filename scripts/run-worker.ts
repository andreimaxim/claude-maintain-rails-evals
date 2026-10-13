/**
 * Runs one headless planner session inside a worker orb and packages its evidence.
 *
 * prepare-run.ts ships this file as runner.ts, with config.json and the plugin
 * variant. It must only import Node built-ins.
 *
 *   node runner.ts start   check the app and services, then start the session detached
 *   node runner.ts wait    block up to --seconds, then print one STATUS line
 *
 * The session runs `claude -p` in the application checkout with only the shipped
 * plugin loaded and a private CLAUDE_CONFIG_DIR, so its native transcripts are
 * separate from the worker agent's own session.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const ROOT = dirname(import.meta.filename);
const PLUGIN = join(ROOT, "maintain-rails");
const OUT = join(ROOT, "out");
const CONFIG_DIR = join(ROOT, "claude-config");
const STATE = join(ROOT, "state.json");
const DONE = join(ROOT, "done.json");
const SUPERVISOR_PID = join(ROOT, "supervisor.pid");
const SUPERVISOR_LOG = join(ROOT, "supervisor.log");
const SKILL = "maintain-rails:upgrade-gem";
const PLANNER = "maintain-rails:gem-upgrade-planner";
// Keep the token Amp supplies; drop variables that tie a child to the worker's session.
const KEPT_CLAUDE_ENV = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

export interface RunConfig {
  run_id: string;
  request: string;
  model: string;
  effort: string;
  app: string;
  application_commit: string;
  result_path: string;
  skip_service_checks: boolean;
  plugin_files: Record<string, string>;
}

interface Check { exit: number; output: string }
interface AppState { head: string; status: string }

interface RunState {
  run_id: string;
  session_id: string;
  prepared_at: string;
  app_before: AppState;
  services: Record<string, Check>;
  claude_version: string;
  command?: string[];
  removed_env?: string[];
  started_at?: string;
  ended_at?: string;
  wall_time_ms?: number;
  exit_code?: number | null;
  app_after?: AppState;
}

interface Done {
  ok: boolean;
  archive: string;
  sha256: string;
  cost_usd: number | null;
  wall_time_ms: number;
  planner_calls: number;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const now = () => new Date().toISOString();

function check(command: string, args: string[], cwd?: string): Check {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) return { exit: 127, output: result.error.message };
  return { exit: result.status ?? 1, output: `${result.stdout}${result.stderr}`.trim().slice(-2000) };
}

function appState(app: string): AppState {
  return {
    head: check("git", ["rev-parse", "HEAD"], app).output,
    status: check("git", ["status", "--porcelain", "--untracked-files=all"], app).output,
  };
}

function shippedFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

function start(config: RunConfig): void {
  if (existsSync(STATE)) throw new Error("A session already started in this worker.");
  for (const [name, expected] of Object.entries(config.plugin_files)) {
    if (sha256(join(PLUGIN, name)) !== expected) throw new Error(`Plugin file hash mismatch: ${name}`);
  }
  const shipped = shippedFiles(PLUGIN);
  if (shipped.length !== Object.keys(config.plugin_files).length
      || shipped.some((name) => !(name in config.plugin_files))) {
    throw new Error("Plugin directory does not match the shipped file list.");
  }

  const before = appState(config.app);
  if (before.head !== config.application_commit) {
    throw new Error(`Application HEAD ${before.head} is not ${config.application_commit}.`);
  }
  if (before.status) throw new Error(`Application checkout is not clean:\n${before.status}`);
  const services = {
    postgres: check("psql", ["-d", "postgres", "-tAc", "select 1"]),
    redis: check("redis-cli", ["ping"]),
    // Interactive bash sources ~/.bashrc, where the app's setup activates mise.
    bundle: check("bash", ["-ic", "bundle check"], config.app),
  };
  const failed = Object.entries(services).filter(([, result]) => result.exit !== 0).map(([name]) => name);
  if (failed.length > 0 && !config.skip_service_checks) {
    throw new Error(`Services are not ready: ${failed.join(", ")}`);
  }

  mkdirSync(OUT);
  mkdirSync(CONFIG_DIR, { recursive: true });
  const state: RunState = {
    run_id: config.run_id,
    session_id: randomUUID(),
    prepared_at: now(),
    app_before: before,
    services,
    claude_version: check("claude", ["--version"]).output,
  };
  writeJson(STATE, state);
  const log = openSync(SUPERVISOR_LOG, "w");
  const supervisor = spawn(process.execPath, [import.meta.filename, "supervise"], {
    detached: true, stdio: ["ignore", log, log],
  });
  supervisor.unref();
  writeFileSync(SUPERVISOR_PID, String(supervisor.pid));
  console.log(`STATUS started run=${config.run_id}`);
}

function supervise(config: RunConfig): void {
  const state = readJson<RunState>(STATE);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("CLAUDE") || KEPT_CLAUDE_ENV.has(key)));
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  const args = (request: string) => [
    "-p", request,
    "--plugin-dir", PLUGIN,
    "--model", config.model, "--effort", config.effort,
    "--permission-mode", "bypassPermissions",
    "--session-id", state.session_id,
    "--output-format", "stream-json", "--verbose",
  ];
  state.command = ["claude", ...args("<request>")];
  state.removed_env = Object.keys(process.env).filter((key) => !(key in env)).sort();
  state.started_at = now();
  writeJson(STATE, state);

  const started = performance.now();
  const result = spawnSync("claude", args(config.request), {
    cwd: config.app, env,
    stdio: ["ignore", openSync(join(OUT, "stream.jsonl"), "w"), openSync(join(OUT, "stderr.txt"), "w")],
  });
  state.ended_at = now();
  state.wall_time_ms = Math.round(performance.now() - started);
  state.exit_code = result.error ? 127 : result.status;
  state.app_after = appState(config.app);
  writeJson(STATE, state);
  pack(config, state);
}

interface StreamRecord {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  [key: string]: unknown;
}

const RESULT_FIELDS = [
  "subtype", "is_error", "duration_ms", "num_turns", "session_id", "total_cost_usd", "usage", "modelUsage",
];
const INIT_FIELDS = ["session_id", "model", "claude_code_version", "plugins", "agents", "skills"];
type Fields = Record<string, unknown>;
const fields = (record: StreamRecord, keys: string[]): Fields =>
  Object.fromEntries(keys.map((key) => [key, record[key] ?? null]));

export interface StreamSummary {
  init: Fields | null;
  results: Fields[];
  /** The last result record: the delivered plan and the session's cost so far. */
  result: Fields | null;
  skill_calls: number;
  planner_calls: number;
  subagent_messages: number;
}

/**
 * Summarizes a `claude -p --output-format stream-json` stream. A background planner
 * makes the stream end with two results: one for the launch turn and one for the
 * delivered plan. total_cost_usd is the session total so far, so the last one counts.
 */
export function summarize(stream: string): StreamSummary {
  const summary: StreamSummary = {
    init: null, results: [], result: null, skill_calls: 0, planner_calls: 0, subagent_messages: 0,
  };
  for (const line of stream.split("\n")) {
    let record: StreamRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "system" && record.subtype === "init") summary.init = fields(record, INIT_FIELDS);
    if (record.type === "result") {
      summary.result = fields(record, RESULT_FIELDS);
      summary.results.push(summary.result);
    }
    if (record.parent_tool_use_id) summary.subagent_messages += 1;
    const content = record.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "Skill" && block.input?.skill === SKILL) summary.skill_calls += 1;
      if ((block.name === "Agent" || block.name === "Task") && block.input?.subagent_type === PLANNER) {
        summary.planner_calls += 1;
      }
    }
  }
  return summary;
}

function pack(config: RunConfig, state: RunState): void {
  const summary = summarize(readFileSync(join(OUT, "stream.jsonl"), "utf8"));
  const { request, ...rest } = config;
  writeJson(join(OUT, "receipt.json"), { config: rest, request, state, summary });
  const contents = existsSync(join(CONFIG_DIR, "projects")) ? ["out", "claude-config/projects"] : ["out"];
  const tar = spawnSync("tar", ["-czf", config.result_path, "-C", ROOT, ...contents]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const result = summary.result ?? {};
  const done: Done = {
    ok: state.exit_code === 0 && result.subtype === "success" && !result.is_error,
    archive: config.result_path,
    sha256: sha256(config.result_path),
    cost_usd: (result.total_cost_usd as number | undefined) ?? null,
    wall_time_ms: state.wall_time_ms!,
    planner_calls: summary.planner_calls,
  };
  writeJson(DONE, done);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait(seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (existsSync(DONE)) {
      const done = readJson<Done>(DONE);
      console.log(`STATUS ${done.ok ? "done" : "failed"} archive=${done.archive} sha256=${done.sha256} `
        + `cost_usd=${done.cost_usd} wall_time_ms=${done.wall_time_ms} planner_calls=${done.planner_calls}`);
      return;
    }
    if (!existsSync(SUPERVISOR_PID)) {
      console.log("STATUS failed: no session was started");
      return;
    }
    if (!isRunning(Number(readFileSync(SUPERVISOR_PID, "utf8")))) {
      // The supervisor may have written done.json just before exiting.
      if (existsSync(DONE)) continue;
      console.log(`STATUS failed: supervisor exited without a result\n${readFileSync(SUPERVISOR_LOG, "utf8").slice(-1500)}`);
      return;
    }
    await sleep(5000);
  }
  const elapsed = Math.round((Date.now() - Date.parse(readJson<RunState>(STATE).prepared_at)) / 1000);
  console.log(`STATUS running elapsed_s=${elapsed}`);
}

if (import.meta.main) {
  const { positionals: [command], values } = parseArgs({
    allowPositionals: true,
    options: { seconds: { type: "string", default: "100" } },
  });
  const config = readJson<RunConfig>(join(ROOT, "config.json"));
  try {
    switch (command) {
      case "start": start(config); break;
      case "supervise": supervise(config); break;
      case "wait": await wait(Number(values.seconds)); break;
      default: throw new Error("Usage: runner.ts start | wait [--seconds N]");
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
