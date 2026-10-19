import type { PluginAPI, ThreadID } from "@ampcode/plugin";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const description = "Runs frozen gem-upgrade planners in native Amp sessions for isolated application evaluations.";

const base = dirname(fileURLToPath(import.meta.url));
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => readFileSync(path, "utf8");
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const body = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Evaluation deadline exceeded")), ms); });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer!); }
}

export default async function (amp: PluginAPI) {
  const config = JSON.parse(read(join(base, "config.json")));
  const app = amp.helpers.filePathFromURI(amp.system.workspaceRoot!);
  const results = join(app, ".git/amp-evals");
  mkdirSync(results, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();
  const snapshot = () => ({
    commit: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).amp/plugins/maintain-rails/**"),
    tracked_sha256: hash(Buffer.concat(git("ls-files", "-z").split("\0").filter(Boolean)
      .map((path) => Buffer.concat([Buffer.from(path + "\0"), existsSync(join(app, path))
        ? Buffer.concat([Buffer.from("present\0"), readFileSync(join(app, path))]) : Buffer.from("missing\0")])))),
  });
  const checkInputs = () => {
    const variant = config.variant;
    if (hash(read(join(base, variant, "planner.md"))) !== config.hashes[`${variant}/planner`]
      || hash(read(join(base, variant, "upgrade-gem/SKILL.md"))) !== config.hashes[`${variant}/skill`]) {
      throw new Error("Frozen input hash mismatch");
    }
  };
  checkInputs();
  const statePath = join(results, "state.json");
  const state = existsSync(statePath) ? JSON.parse(read(statePath)) : { runs: [] };
  const save = () => { json(`${statePath}.tmp`, state); renameSync(`${statePath}.tmp`, statePath); };
  const timeoutMs = 90 * 60 * 1000;
  let busy = false;
  await amp.registerSkill({ path: `${config.variant}/upgrade-gem` });

  async function trace(threadID: ThreadID, path: string) {
    // The plugin message API returned empty arrays for local child threads in the smoke.
    // Native exports retain the executed calls and usage, not just requested definitions.
    const raw = execFileSync("amp", ["threads", "export", threadID], { cwd: app, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    const exported = JSON.parse(raw);
    const privateDir = join(results, "private");
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(privateDir, `${threadID}.json`), raw);
    if (!exported.messages?.length) throw new Error(`Empty native transcript for ${threadID}`);
    json(path, { threadID, source_sha256: hash(raw),
      agent: exported.meta?.threadAgent?.definition ?? (await amp.threads.get(threadID).agent()).definition,
      messages: exported.messages.map((message: any) => ({
        role: message.role, id: message.messageId, createdAt: message.createdAt, usage: message.usage,
        content: message.content.filter((block: any) => ["text", "tool_use", "tool_result"].includes(block.type)),
      })),
    });
  }

  amp.registerTool({
    name: "gem_upgrade_planner",
    description: "Reviews upgrading one gem in the current application. Supply the gem, exact currentVersion, and requestedVersion. Returns the full planner report without implementing the upgrade.",
    inputSchema: { type: "object", properties: {
      gem: { type: "string" }, currentVersion: { type: "string" }, requestedVersion: { type: "string" },
    }, required: ["gem", "currentVersion", "requestedVersion"] },
    async execute(input, ctx) {
      const run = state.runs.find((run: any) => run.main_thread === ctx.thread.id);
      if (!run || run.status !== "running") throw new Error("Planner is only available in an active evaluation session");
      if (run.planner_started) throw new Error("This run already invoked its planner; inspect the recorded thread instead of duplicating it");
      run.planner_started = true;
      run.handoff = input;
      save();
      const planner = amp.createAgent({
        extends: "medium", model: config.model, reasoningEffort: config.effort, features: [],
        instructions: body(read(join(base, run.variant, "planner.md"))),
        tools: { include: ["Read", "shell_command", "shell_command_status", "shell_command_kill", "web_search", "read_web_page"],
          exclude: ["tool_search", "code_exec"] },
      });
      try {
        const child = await planner.createThread({ parentThreadID: ctx.thread.id, executor: "local", features: [] });
        run.planner_thread = child.id;
        save();
        if (run.status !== "running" || run.planner_status === "failed") {
          await child.cancel();
          throw new Error("Run ended before planner creation completed; late child cancelled without dispatch");
        }
        const response = child.waitForResponse({ timeoutMs });
        // Handle an append failure without leaving a rejected wait unobserved.
        void response.catch(() => {});
        const answer = await deadline((async () => {
          await child.appendUserMessage({ type: "user-message", content: JSON.stringify(input) });
          return await response;
        })(), timeoutMs);
        const text = answer.content.filter((block) => block.type === "text").map((block: any) => block.text).join("\n");
        writeFileSync(join(results, run.id, "planner.md"), text);
        run.planner_status = "done";
        save();
        return text;
      } catch (error) {
        run.planner_status = "failed";
        run.planner_error = String(error);
        if (run.planner_thread) await amp.threads.get(run.planner_thread).cancel().catch((error) => {
          run.collection_errors.push(`planner cancellation: ${error}`);
        });
        save();
        throw error;
      }
    },
  });

  amp.registerTool({
    name: "run_eval",
    description: "Runs this orb's single configured evaluation session and saves its report, trace, and receipt. Call once. A failure must be inspected, not retried.",
    inputSchema: { type: "object", properties: {} },
    async execute(_input, ctx) {
      if (busy || state.runs.length) throw new Error("This orb already started its session; inspect state.json instead of launching another");
      const slot = { variant: config.variant, request: config.request };
      checkInputs();
      const before = snapshot();
      if (before.commit !== config.application_commit || before.status) throw new Error("Application is moved or dirty");
      execFileSync("pg_isready", [], { cwd: app });
      if (execFileSync("redis-cli", ["ping"], { cwd: app, encoding: "utf8" }).trim() !== "PONG") throw new Error("Redis is not ready");
      busy = true;
      const run: any = { ...slot, id: `run-${state.runs.length + 1}`, model: config.model, effort: config.effort,
        status: "running", started_at: new Date().toISOString(), before, hashes: config.hashes, collection_errors: [],
        cost_usd: null, cost_note: "Plugin message API does not expose usage or billed cost; collect native exports separately." };
      mkdirSync(join(results, run.id));
      state.runs.push(run);
      save();
      try {
        const main = amp.createAgent({
          extends: "medium", model: config.model, reasoningEffort: config.effort, features: [],
          instructions: "", tools: {
            include: ["Read", "shell_command", "shell_command_status", "shell_command_kill", "skill", "plugin__maintain-rails__gem_upgrade_planner"],
            exclude: ["tool_search", "code_exec"],
          },
        });
        const child = await main.createThread({ parentThreadID: ctx.thread.id, executor: "local", features: [] });
        run.main_thread = child.id;
        save();
        const response = child.waitForResponse({ timeoutMs });
        void response.catch(() => {});
        const answer = await deadline((async () => {
          await child.appendUserMessage({ type: "user-message", content: slot.request });
          return await response;
        })(), timeoutMs);
        const text = answer.content.filter((block) => block.type === "text").map((block: any) => block.text).join("\n");
        writeFileSync(join(results, run.id, "final.md"), text);
        const reportPath = join(results, run.id, "planner.md");
        const report = existsSync(reportPath) ? read(reportPath) : "";
        run.planner_response_returned_verbatim = report.length > 0 && text.startsWith(report);
        run.status = "done";
      } catch (error) {
        run.status = "failed";
        run.error = String(error);
        for (const id of [run.main_thread, run.planner_thread].filter(Boolean)) {
          await amp.threads.get(id).cancel().catch((error) => run.collection_errors.push(`cancellation ${id}: ${error}`));
        }
      } finally {
        run.completed_at = new Date().toISOString();
        run.wall_time_ms = Date.parse(run.completed_at) - Date.parse(run.started_at);
        try {
          run.after = snapshot();
          run.application_unchanged = JSON.stringify(run.before) === JSON.stringify(run.after);
          checkInputs();
          if (!run.application_unchanged) throw new Error("Evaluation changed the application");
        } catch (error) {
          run.collection_errors.push(String(error));
          run.status = "failed";
        }
        for (const [role, id] of [["main", run.main_thread], ["planner", run.planner_thread]]) {
          if (id) await trace(id, join(results, run.id, `${role}-trace.json`))
            .catch((error) => { run.status = "failed"; run.collection_errors.push(`${role} trace: ${error}`); });
        }
        // Native Amp may write its substantive plan to an artifact and return a summary.
        // Retain both for separate raw-plan and final-delivery assessment.
        const artifacts = join(app, ".amp/in/artifacts");
        try {
          if (existsSync(artifacts)) {
            run.artifacts = readdirSync(artifacts, { recursive: true });
            cpSync(artifacts, join(results, run.id, "artifacts"), { recursive: true, dereference: false });
          }
        } catch (error) {
          run.status = "failed";
          run.collection_errors.push(`artifacts: ${error}`);
        }
        if (run.planner_started && !run.planner_thread) run.collection_errors.push("Planner creation outcome unknown; inspect before any recovery");
        if (run.collection_errors.length) run.status = "failed";
        json(join(results, run.id, "receipt.json"), run);
        save();
        busy = false;
      }
      return JSON.stringify({ status: run.status, id: run.id, variant: run.variant, request: run.request,
        main_thread: run.main_thread, planner_thread: run.planner_thread ?? null,
        application_unchanged: run.application_unchanged, planner_response_returned_verbatim: run.planner_response_returned_verbatim,
        wall_time_ms: run.wall_time_ms, error: run.error, collection_errors: run.collection_errors, results });
    },
  });
}
