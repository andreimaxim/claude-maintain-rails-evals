import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readJson, sha256 } from "./files.ts";
import { prepareRun } from "./prepare-run.ts";
import { summarize } from "./run-worker.ts";

const FROZEN_PLUGIN = fileURLToPath(new URL("../tests/planner-inputs/maintain-rails", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../tests/planner-inputs/manifest.json", import.meta.url));

describe("headless planner runs", () => {
  let root: string;
  let app: string;
  let commit: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", app, ...args], { encoding: "utf8" }).trim();
  const commitAll = (message: string) =>
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "planner-run-"));
    app = join(root, "app");
    mkdirSync(app);
    git("init", "-q");
    writeFileSync(join(app, "Gemfile"), "source 'https://rubygems.org'\n");
    git("add", ".");
    commitAll("app");
    commit = git("rev-parse", "HEAD");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const prepare = (pluginDir = FROZEN_PLUGIN) => prepareRun(join(root, "payload.tar.gz"), {
    request: "Upgrade the rack gem to 2.2.24", model: "claude-haiku-5-5", effort: "low", runId: "t1",
    pluginDir, app, applicationCommit: commit,
  });
  const extract = (payload: string) => {
    const worker = join(root, "worker");
    mkdirSync(worker);
    execFileSync("tar", ["-xzf", payload, "-C", worker]);
    return worker;
  };
  const start = (worker: string) =>
    spawnSync(process.execPath, [join(worker, "runner.ts"), "start"], { encoding: "utf8" });

  it("ships the runner, the config and exactly the plugin's files", () => {
    const prepared = prepare();
    assert.equal(prepared.payload_sha256, sha256(readFileSync(prepared.payload)));
    assert.ok(prepared.prompt.includes(prepared.payload_sha256));
    assert.ok(!prepared.prompt.includes("rack"), "the request must reach only the inner session");

    const expected = readJson<{ files: Record<string, string> }>(MANIFEST).files;
    const listed = execFileSync("tar", ["-tzf", prepared.payload], { encoding: "utf8" })
      .split("\n").filter((name) => name && !name.endsWith("/"));
    assert.deepEqual(listed.sort(), ["config.json", "runner.ts",
      ...Object.keys(expected).map((name) => `maintain-rails/${name}`)].sort());
    const config = readJson<Record<string, unknown>>(join(extract(prepared.payload), "config.json"));
    assert.deepEqual(config.plugin_files, expected);
    assert.equal(config.request, "Upgrade the rack gem to 2.2.24");
    assert.equal(config.result_path, join(app, ".git/planner-run-result.tar.gz"));
  });

  it("refuses a plugin directory with symlinks", () => {
    const plugin = join(root, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
    symlinkSync(join(FROZEN_PLUGIN, "agents"), join(plugin, "agents"));
    assert.throws(() => prepare(plugin), /symlinks/);
    assert.ok(!existsSync(join(root, "payload.tar.gz")));
  });

  it("refuses a dirty or moved checkout before launching anything", () => {
    const worker = extract(prepare().payload);

    writeFileSync(join(app, "notes.txt"), "untracked\n");
    const dirty = start(worker);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /not clean/);
    rmSync(join(app, "notes.txt"));

    commitAll("moved");
    const moved = start(worker);
    assert.notEqual(moved.status, 0);
    assert.match(moved.stderr, new RegExp(`is not ${commit}`));
    assert.ok(!existsSync(join(worker, "state.json")));
  });

  it("refuses a plugin changed after preparation", () => {
    const worker = extract(prepare().payload);
    writeFileSync(join(worker, "maintain-rails", "agents", "gem-upgrade-planner.md"), "Hint.\n", { flag: "a" });
    const result = start(worker);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
  });

  it("summarizes from the last result after a background planner", () => {
    const records = [
      { type: "system", subtype: "init", model: "claude-haiku-5-5" },
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "Skill", input: { skill: "maintain-rails:upgrade-gem" } }] } },
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "Agent", input: { subagent_type: "maintain-rails:gem-upgrade-planner" } }] } },
      { type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [
        { type: "tool_use", name: "Agent", input: { subagent_type: "Explore" } }] } },
      { type: "result", subtype: "success", num_turns: 5, total_cost_usd: 0.004 },
      { type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0.006 },
    ];
    const summary = summarize(`${records.map((record) => JSON.stringify(record)).join("\n")}\nnot json\n`);
    assert.equal(summary.skill_calls, 1);
    assert.equal(summary.planner_calls, 1);
    assert.equal(summary.subagent_messages, 1);
    assert.deepEqual(summary.results.map((result) => result.num_turns), [5, 1]);
    assert.equal(summary.result?.total_cost_usd, 0.006);
  });
});
