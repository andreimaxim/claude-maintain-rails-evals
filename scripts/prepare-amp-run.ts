/** Packages native Amp runtime inputs, never grading material, for one app orb. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256, writeJson } from "./files.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const APPLICATION_COMMIT = "ab732f534dce525ae70f1d31aac6908a1ab3d8f7";
const VARIANTS = {
  original: "tests/planner-inputs/maintain-rails",
  v21: "tests/planner-variants/v21-resolve-deps/maintain-rails",
};

export function prepareAmpRun(output: string, model: string, effort: string, variant: string, request = "Upgrade the rails gem to 8.1.0") {
  if (!["openai/gpt-6.1-sol", "openai/gpt-6-astra"].includes(model)) throw new Error("Unsupported model");
  if (!["low", "medium", "high"].includes(effort)) throw new Error("Unsupported effort");
  if (variant !== "original" && variant !== "v21") throw new Error("Unsupported variant");
  const staging = mkdtempSync(join(tmpdir(), "amp-eval-"));
  const hashes: Record<string, string> = {};
  try {
    const plugin = join(staging, "maintain-rails");
    mkdirSync(plugin);
    copyFileSync(join(ROOT, "tests/amp-runtime/index.ts"), join(plugin, "index.ts"));
    const source = VARIANTS[variant];
    const target = join(plugin, variant);
    mkdirSync(join(target, "upgrade-gem"), { recursive: true });
    const planner = readFileSync(join(ROOT, source, "agents/gem-upgrade-planner.md"), "utf8");
    const originalSkill = readFileSync(join(ROOT, source, "skills/upgrade-gem/SKILL.md"), "utf8");
    // Only the delegation syntax changes; the planner body stays byte-for-byte identical.
    const skill = originalSkill.replaceAll("`maintain-rails:gem-upgrade-planner`", "the `gem_upgrade_planner` tool");
    writeFileSync(join(target, "planner.md"), planner);
    writeFileSync(join(target, "upgrade-gem/SKILL.md"), skill);
    hashes[`${variant}/source-skill`] = sha256(originalSkill);
    hashes[`${variant}/skill`] = sha256(skill);
    hashes[`${variant}/planner`] = sha256(planner);
    const config = {
      model, effort, application_commit: APPLICATION_COMMIT,
      variant, request, hashes,
    };
    writeJson(join(plugin, "config.json"), config);
    execFileSync("tar", ["-czf", resolve(output), "-C", staging, "maintain-rails"]);
    return { payload: resolve(output), sha256: sha256(readFileSync(output)), config };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { positionals: [output], values } = parseArgs({ allowPositionals: true, options: {
    model: { type: "string" }, effort: { type: "string" }, variant: { type: "string" }, request: { type: "string" },
  } });
  if (!output || !values.model || !values.effort || !values.variant) throw new Error("Usage: prepare-amp-run.ts <payload.tar.gz> --model <id> --effort <level> --variant original|v21 [--request <text>]");
  mkdirSync(dirname(resolve(output)), { recursive: true });
  console.log(JSON.stringify(prepareAmpRun(output, values.model, values.effort, values.variant, values.request), null, 2));
}
