/**
 * Extracts, grades and records a batch of headless planner runs.
 *
 * The batch directory holds `runs.json` (variant, case, request, model, effort and
 * run number → worker thread ID) and each downloaded `<case>-<n>.result.tar.gz`.
 * Pass the SHA-256 each worker reported so a corrupted download fails loudly.
 *
 *   node scripts/record-batch.ts <batch-dir> <results-dir> --sha <n>=<sha256>...
 *
 * Writes each run's final plan, receipt and grade to the results directory, plus a
 * summary.json. Archives stay out of the results: they contain thinking blocks.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readJson, sha256, writeJson } from "./files.ts";
import { type Case, gradePlan, type PlanGrade } from "./grade-plan.ts";

interface Batch {
  variant: string;
  description?: string;
  case: Case;
  request: string;
  model: string;
  effort: string;
  runs: Record<string, string>;
}

interface Receipt {
  state: { wall_time_ms: number; exit_code: number; app_after: { status: string } };
  summary: { result: { subtype: string; is_error: boolean; total_cost_usd: number; result?: string } | null };
}

function finalResponse(stream: string): string {
  const results = stream.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((record) => record.type === "result");
  const last = results.at(-1);
  if (!last || last.is_error || last.subtype !== "success") throw new Error("Session has no successful result");
  return last.result;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

if (import.meta.main) {
  const { positionals: [batchDir, resultsDir], values } = parseArgs({
    allowPositionals: true,
    options: { sha: { type: "string", multiple: true, default: [] } },
  });
  if (!batchDir || !resultsDir) throw new Error("Usage: record-batch.ts <batch-dir> <results-dir> --sha <n>=<sha256>");
  const batch = readJson<Batch>(join(batchDir, "runs.json"));
  const reported = Object.fromEntries(values.sha.map((pair) => pair.split("=")));

  const runs = await Promise.all(Object.entries(batch.runs).map(async ([run, thread]) => {
    const name = `${batch.case}-${run}`;
    const archive = join(batchDir, `${name}.result.tar.gz`);
    const archiveSha = sha256(readFileSync(archive));
    if (reported[run] && reported[run] !== archiveSha) throw new Error(`${name}: archive hash ${archiveSha} differs from the worker's`);
    const extracted = join(batchDir, name);
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);

    const plan = finalResponse(readFileSync(join(extracted, "out", "stream.jsonl"), "utf8"));
    writeFileSync(join(extracted, "final.md"), plan);
    const gradePath = join(extracted, "grade.json");
    if (!existsSync(gradePath)) writeJson(gradePath, await gradePlan(batch.case, plan));
    const grade = readJson<PlanGrade>(gradePath);
    const receipt = readJson<Receipt>(join(extracted, "out", "receipt.json"));

    const target = join(resultsDir, name);
    mkdirSync(target, { recursive: true });
    for (const file of ["final.md", "grade.json"]) copyFileSync(join(extracted, file), join(target, file));
    copyFileSync(join(extracted, "out", "receipt.json"), join(target, "receipt.json"));
    return {
      run: Number(run),
      thread: `https://ampcode.com/threads/${thread}`,
      archive_sha256: archiveSha,
      wall_time_ms: receipt.state.wall_time_ms,
      cost_usd: receipt.summary.result?.total_cost_usd ?? null,
      grader_actionable: grade.actionable,
      grader_supported_validation: Object.values(grade.families).filter((family) => family.validation === "supported").length,
      grading_cost_usd: grade.cost_usd,
      checkout_unchanged: !receipt.state.app_after.status,
    };
  }));

  runs.sort((a, b) => a.run - b.run);
  const instructions = fileURLToPath(new URL("../tests/grader-instructions.md", import.meta.url));
  writeJson(join(resultsDir, "summary.json"), {
    configuration: `${batch.model.replace("claude-", "").replace(/-(\d)-(\d)$/, "-$1.$2")}-${batch.effort}`,
    case: batch.case,
    request: batch.request,
    variant: batch.description ? `${batch.variant} (${batch.description})` : batch.variant,
    harness: "claude -p --plugin-dir via scripts/run-worker.ts",
    grader: {
      script: "scripts/grade-plan.ts", model: "claude-opus-5-5", effort: "high",
      instructions_sha256: sha256(readFileSync(instructions)),
    },
    runs,
  });
  console.log(`actionable ${runs.map((run) => run.grader_actionable).join(", ")}; `
    + `median ${(median(runs.map((run) => run.wall_time_ms)) / 60000).toFixed(1)} min, `
    + `$${median(runs.map((run) => run.cost_usd ?? 0)).toFixed(2)}; `
    + `total $${runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0).toFixed(2)}`);
}
