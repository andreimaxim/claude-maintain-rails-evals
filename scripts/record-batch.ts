/**
 * Extracts, grades and records a batch of headless planner runs.
 *
 * The batch directory holds `runs.json` (variant, case, request, model, effort and
 * run number → worker thread ID) and each downloaded `<case>-<n>.result.tar.gz`.
 * Pass the SHA-256 each worker reported so a corrupted download fails loudly.
 * `--grader risk` grades risk reports against tests/risk-labels.md instead of
 * grading upgrade plans against the answer key.
 *
 *   node scripts/record-batch.ts <batch-dir> <results-dir> --sha <n>=<sha256>...
 *     [--grader plan|risk]
 *
 * Writes each run's final plan, receipt, grade and trace to the results directory,
 * plus a summary.json. Archives stay out of the results because they contain
 * thinking blocks; the trace is exported without them (see export-trace.ts).
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exportTrace } from "./export-trace.ts";
import { readJson, sha256, writeJson } from "./files.ts";
import { type Case, gradePlan, type PlanGrade } from "./grade-plan.ts";
import { gradeRiskReport, type RiskGrade } from "./grade-risk-report.ts";

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

const tests = (name: string) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url));

/** How each grader grades a final response and which grade fields the summary keeps. */
const GRADERS = {
  plan: {
    script: "scripts/grade-plan.ts",
    inputs: ["grader-instructions.md"],
    grade: gradePlan,
    fields: (grade: PlanGrade) => ({
      grader_actionable: grade.actionable,
      grader_supported_validation: Object.values(grade.families).filter((family) => family.validation === "supported").length,
    }),
    headline: "grader_actionable",
  },
  risk: {
    script: "scripts/grade-risk-report.ts",
    inputs: ["risk-grader-instructions.md", "risk-labels.md"],
    grade: gradeRiskReport,
    fields: (grade: RiskGrade) => ({
      grader_located: grade.located,
      grader_level_matches: grade.levelMatches,
      grader_inaccurate: grade.inaccurate,
    }),
    headline: "grader_level_matches",
  },
} as const;

if (import.meta.main) {
  const { positionals: [batchDir, resultsDir], values } = parseArgs({
    allowPositionals: true,
    options: { sha: { type: "string", multiple: true, default: [] }, grader: { type: "string", default: "plan" } },
  });
  if (!batchDir || !resultsDir || !(values.grader in GRADERS)) {
    throw new Error("Usage: record-batch.ts <batch-dir> <results-dir> --sha <n>=<sha256> [--grader plan|risk]");
  }
  const grader = GRADERS[values.grader as keyof typeof GRADERS];
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
    if (!existsSync(gradePath)) writeJson(gradePath, await grader.grade(batch.case, plan));
    const grade = readJson<PlanGrade & RiskGrade>(gradePath);
    const receipt = readJson<Receipt>(join(extracted, "out", "receipt.json"));

    const target = join(resultsDir, name);
    mkdirSync(target, { recursive: true });
    for (const file of ["final.md", "grade.json"]) copyFileSync(join(extracted, file), join(target, file));
    copyFileSync(join(extracted, "out", "receipt.json"), join(target, "receipt.json"));
    exportTrace(extracted, join(target, "trace"));
    return {
      run: Number(run),
      thread: `https://ampcode.com/threads/${thread}`,
      archive_sha256: archiveSha,
      wall_time_ms: receipt.state.wall_time_ms,
      cost_usd: receipt.summary.result?.total_cost_usd ?? null,
      ...grader.fields(grade),
      grading_cost_usd: grade.cost_usd,
      checkout_unchanged: !receipt.state.app_after.status,
    };
  }));

  runs.sort((a, b) => a.run - b.run);
  writeJson(join(resultsDir, "summary.json"), {
    configuration: `${batch.model.replace("claude-", "").replace(/-(\d)-(\d)$/, "-$1.$2")}-${batch.effort}`,
    case: batch.case,
    request: batch.request,
    variant: batch.description ? `${batch.variant} (${batch.description})` : batch.variant,
    harness: "claude -p --plugin-dir via scripts/run-worker.ts",
    grader: {
      script: grader.script, model: "claude-opus-5-5", effort: "high",
      inputs_sha256: Object.fromEntries(grader.inputs.map((name) => [`tests/${name}`, sha256(readFileSync(tests(name)))])),
    },
    runs,
  });
  console.log(`${grader.headline} ${runs.map((run) => (run as Record<string, unknown>)[grader.headline]).join(", ")}; `
    + `median ${(median(runs.map((run) => run.wall_time_ms)) / 60000).toFixed(1)} min, `
    + `$${median(runs.map((run) => run.cost_usd ?? 0)).toFixed(2)}; `
    + `total $${runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0).toFixed(2)}`);
}
