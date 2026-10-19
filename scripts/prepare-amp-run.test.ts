import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareAmpRun } from "./prepare-amp-run.ts";

test("Amp payload contains one session's frozen inputs without the answer key", () => {
  const root = mkdtempSync(join(tmpdir(), "amp-payload-test-"));
  try {
    for (const [variant, source] of [
      ["original", "tests/planner-inputs/maintain-rails"],
      ["v21", "tests/planner-variants/v21-resolve-deps/maintain-rails"],
    ] as const) {
      const result = prepareAmpRun(join(root, `${variant}.tar.gz`), "openai/gpt-6.1-sol", "medium", variant);
      const files = execFileSync("tar", ["-tzf", result.payload], { encoding: "utf8" })
        .split("\n").filter((name) => name && !name.endsWith("/"));
      assert.deepEqual(files.sort(), ["maintain-rails/index.ts", "maintain-rails/config.json",
        `maintain-rails/${variant}/planner.md`, `maintain-rails/${variant}/upgrade-gem/SKILL.md`].sort());
      const planner = execFileSync("tar", ["-xOzf", result.payload, `maintain-rails/${variant}/planner.md`], { encoding: "utf8" });
      assert.equal(planner, readFileSync(`${source}/agents/gem-upgrade-planner.md`, "utf8"));
      const skill = execFileSync("tar", ["-xOzf", result.payload, `maintain-rails/${variant}/upgrade-gem/SKILL.md`], { encoding: "utf8" });
      assert.equal(skill, readFileSync(`${source}/skills/upgrade-gem/SKILL.md`, "utf8")
        .replaceAll("`maintain-rails:gem-upgrade-planner`", "the `gem_upgrade_planner` tool"));
      const config = JSON.parse(execFileSync("tar", ["-xOzf", result.payload, "maintain-rails/config.json"], { encoding: "utf8" }));
      assert.deepEqual(config, result.config);
      assert.equal(result.config.variant, variant);
      assert.equal(result.config.request, "Upgrade the rails gem to 8.1.0");
      assert.equal(result.config.model, "openai/gpt-6.1-sol");
      assert.equal(result.config.effort, "medium");
    }
    assert.throws(() => prepareAmpRun(join(root, "bad.tar.gz"), "unknown", "medium", "original"), /model/);
    assert.throws(() => prepareAmpRun(join(root, "bad.tar.gz"), "openai/gpt-6-astra", "max", "original"), /effort/);
    assert.throws(() => prepareAmpRun(join(root, "bad.tar.gz"), "openai/gpt-6-astra", "high", "v20"), /variant/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
