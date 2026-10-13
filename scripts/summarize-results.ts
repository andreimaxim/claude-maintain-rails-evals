/**
 * Prices retained usage and regenerates costs, statistics and graph views for a
 * published results directory.
 *
 *   node scripts/summarize-results.ts <results-dir> --views <output-dir>
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readJson, sha256, writeJson } from "./files.ts";
import type { Issue } from "./collect-usage.ts";
import { type CostEstimate, DEFAULT_PRICING, estimate } from "./price-usage.ts";

const GRAPH_TEMPLATE = fileURLToPath(new URL("../tests/planner-graphs.html", import.meta.url));
const CASES = ["rails", "sidekiq", "pagy", "faraday"];
const CONFIGURATIONS = ["opus-5.5-high", "opus-5.5-low", "sonnet-5.5-medium", "haiku-5.5-medium"];

interface Outcome {
  configuration: string;
  case: string;
  run: number;
  thread: string;
  raw_actionable: number | null;
  final_actionable: number | null;
  reported_planner_tokens: number | null;
  response_wall_time_ms: number | null;
  successful_plan_wall_time_ms: number | null;
  actual_model_verification: string;
}

type RunIdentity = Pick<Outcome, "configuration" | "case" | "run" | "thread">;

interface RunCost extends RunIdentity {
  estimate_usd: number | null;
  lower_bound_usd: number | null;
  unique_requests: number | null;
  recorded_tokens: Partial<CostEstimate["recorded_tokens"]>;
  components_usd: Partial<CostEstimate["components_usd"]>;
  gaps: Issue[];
  usage_file?: string;
  usage_sha256?: string;
  pricing_sha256?: string;
}

/** Descriptive statistics over non-null values; sample_sd uses n - 1. */
function describe(values: (number | null)[]) {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const n = present.length;
  if (n === 0) return { n, median: null, min: null, max: null, mean: null, sample_sd: null };
  const mean = present.reduce((sum, value) => sum + value, 0) / n;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 1 ? present[middle]! : (present[middle - 1]! + present[middle]!) / 2;
  const variance = present.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  return { n, median, min: present[0]!, max: present.at(-1)!, mean, sample_sd: n > 1 ? Math.sqrt(variance) : null };
}

function toCsv(rows: Record<string, unknown>[]): string {
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [fields, ...rows.map((row) => fields.map((field) => row[field]))]
    .map((values) => values.map(cell).join(",")).join("\n") + "\n";
}

const countWhere = <T>(items: T[], predicate: (item: T) => boolean) => items.filter(predicate).length;
const isBoundOnly = (cost: RunCost) => cost.estimate_usd === null && cost.lower_bound_usd !== null;

export function summarizeResults(root: string, views: string): void {
  const pricing = readFileSync(DEFAULT_PRICING);
  const rates = JSON.parse(pricing.toString("utf8"));
  const outcomes = readJson<Outcome[]>(join(root, "benchmark-outcomes.json"));

  const costFor = ({ configuration, case: caseName, run, thread }: RunIdentity, usagePath: string): RunCost => {
    const identity = { configuration, case: caseName, run, thread };
    if (!existsSync(usagePath)) {
      return {
        ...identity, estimate_usd: null, lower_bound_usd: null, unique_requests: null,
        recorded_tokens: {}, components_usd: {}, gaps: [{ reason: "Native usage unavailable" }],
      };
    }
    const usage = readFileSync(usagePath);
    return {
      ...identity,
      ...estimate(JSON.parse(usage.toString("utf8")), rates),
      usage_file: relative(root, usagePath),
      usage_sha256: sha256(usage),
      pricing_sha256: sha256(pricing),
    };
  };

  const costs = outcomes.map((outcome) =>
    costFor(outcome, join(root, outcome.configuration, "usage", `${outcome.case}-${outcome.run}.json`)));
  writeJson(join(root, "benchmark-costs.json"), costs);
  writeFileSync(join(root, "benchmark-costs.csv"), toCsv(costs.map((cost) => ({
    configuration: cost.configuration, case: cost.case, run: cost.run, thread: cost.thread,
    estimate_usd: cost.estimate_usd, lower_bound_usd: cost.lower_bound_usd,
    unique_requests: cost.unique_requests, ...cost.recorded_tokens, gap_count: cost.gaps.length,
  }))));

  const groupKeys = [...new Set(outcomes.map((outcome) => `${outcome.configuration}\t${outcome.case}`))];
  const groups = groupKeys.map((key) => {
    const [configuration, caseName] = key.split("\t");
    const inGroup = (run: RunIdentity) => run.configuration === configuration && run.case === caseName;
    const runs = outcomes.filter(inGroup);
    const runCosts = costs.filter(inGroup);
    return {
      configuration, case: caseName, attempts: runs.length,
      raw_actionable: describe(runs.map((run) => run.raw_actionable)),
      final_actionable: describe(runs.map((run) => run.final_actionable)),
      response_wall_time_ms: describe(runs.map((run) => run.response_wall_time_ms)),
      successful_plan_wall_time_ms: describe(runs.map((run) => run.successful_plan_wall_time_ms)),
      reported_first_handback_tokens: describe(runs.map((run) => run.reported_planner_tokens)),
      recorded_request_cost_usd: describe(runCosts.map((cost) => cost.estimate_usd)),
      cost_lower_bound_only_runs: countWhere(runCosts, isBoundOnly),
      cost_unavailable_runs: countWhere(runCosts, (cost) => cost.lower_bound_usd === null),
    };
  });
  writeJson(join(root, "benchmark-statistics.json"), {
    definition: "Descriptive statistics by case/configuration. Nulls excluded by n; sample_sd uses n-1. Response time includes workflow failures; finding accuracy is not overall correctness. Cost statistics include complete recorded-request list-price estimates only, excluding lower-bound-only runs, unlogged helpers and billing adjustments. Token footers are not workflow totals.",
    groups,
  });

  // Quota-interrupted attempts keep their own spend, outside the benchmark table.
  const interrupted = join(root, "quota-interrupted", "opus-high-heldout");
  const interruptedTraces = existsSync(interrupted)
    ? readdirSync(interrupted).filter((name) => /^(pagy|faraday)-.*\.json$/.test(name)).sort()
    : [];
  if (interruptedTraces.length > 0) {
    writeJson(join(interrupted, "costs.json"), interruptedTraces.map((name) => {
      const [caseName, run] = basename(name, ".json").split("-");
      const { thread } = readJson<{ thread: string }>(join(interrupted, name));
      return costFor({ configuration: "opus-5.5-high", case: caseName!, run: Number(run), thread },
        join(interrupted, "usage", name));
    }));
  }

  const points = outcomes.map((outcome, index) => {
    const cost = costs[index]!;
    const delivery = outcome.successful_plan_wall_time_ms !== null ? "F"
      : outcome.actual_model_verification !== "native_metadata_verified" ? "U" : "X";
    return [CASES.indexOf(outcome.case), CONFIGURATIONS.indexOf(outcome.configuration), outcome.run,
      outcome.final_actionable, outcome.response_wall_time_ms, delivery,
      cost.estimate_usd, cost.lower_bound_usd, cost.recorded_tokens, outcome.thread];
  });
  mkdirSync(views, { recursive: true });
  const template = readFileSync(GRAPH_TEMPLATE, "utf8");
  for (const metric of ["accuracy-time", "api-cost"]) {
    writeFileSync(join(views, `${metric}.html`), template
      .replace("__DATA__", JSON.stringify(points))
      .replace("__METRIC__", JSON.stringify(metric)));
  }

  console.log(`${outcomes.length} runs; ${countWhere(costs, (cost) => cost.estimate_usd !== null)} `
    + `recorded-request estimates; ${countWhere(costs, isBoundOnly)} bounds; `
    + `${countWhere(costs, (cost) => cost.lower_bound_usd === null)} unavailable.`);
}

if (import.meta.main) {
  const { positionals: [root], values } = parseArgs({
    allowPositionals: true,
    options: { views: { type: "string" } },
  });
  if (!root || !values.views) throw new Error("Usage: summarize-results.ts <results-dir> --views <dir>");
  summarizeResults(root, values.views);
}
