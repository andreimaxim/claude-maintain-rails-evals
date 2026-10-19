import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("matrix ledger retains all 60 independent sessions and refuses a second launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-matrix-test-"));
  const pluginURL = new URL("../.amp/plugins/eval-matrix.ts", import.meta.url).href;
  const { default: install } = await import(pluginURL);
  let tool: any;
  let id = 0;
  install({
    system: { workspaceRoot: root }, helpers: { filePathFromURI: (path: string) => path },
    registerTool: (registered: unknown) => { tool = registered; },
    getBuiltinAgent: () => ({ createThread: async () => {
      const number = ++id;
      return { id: `T-session-${number}`, appendUserMessage: async () => {
        if (number === 7) throw new Error("Lost dispatch acknowledgment");
      } };
    } }),
  });
  try {
    const result = JSON.parse(await tool.execute({ revision: "a".repeat(40) }, { thread: { id: "T-parent" } }));
    assert.equal(result.started, 59);
    const manifest = JSON.parse(readFileSync(join(root, "tests/results/20261019-native-amp/threads.json"), "utf8"));
    assert.equal(manifest.runs.length, 60);
    assert.equal(new Set(manifest.runs.map((run: any) => run.thread)).size, 60);
    for (const family of ["sol", "astra"]) for (const effort of ["low", "medium", "high"]) {
      assert.equal(manifest.runs.filter((run: any) => run.family === family && run.effort === effort).length, 10);
    }
    assert.equal(manifest.runs[6].status, "dispatch-outcome-unknown");
    await assert.rejects(tool.execute({ revision: "a".repeat(40) }, { thread: { id: "T-parent" } }), /EEXIST/);
    assert.deepEqual(JSON.parse(readFileSync(result.manifest, "utf8")), manifest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
