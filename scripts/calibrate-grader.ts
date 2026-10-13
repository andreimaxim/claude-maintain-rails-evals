/**
 * Grades the published final plans with grade-plan.ts and measures agreement with
 * the hand grades. Grades are cached per run, so an interrupted calibration resumes.
 *
 *   node scripts/calibrate-grader.ts <output-dir> [--concurrency 6] [--model ...] [--effort ...]
 *     [--results tests/results/20261012] [--configuration opus-5.5-low]...
 *
 * Grader tuning uses the Opus-low and Sonnet runs; Opus-high and Haiku runs are
 * held back to test the tuned instructions.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson, writeJson } from "./files.ts";
import { type Case, gradePlan, type PlanGrade } from "./grade-plan.ts";
import { DIMENSIONS, type HandGradedRun, isActionable, readHandGrades } from "./hand-grades.ts";

interface Trace { final_response: string }

interface Pair {
  id: string;
  hand: HandGradedRun;
  grade: PlanGrade;
}

/** Runs async tasks with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  }));
}

function kappa(pairs: [boolean, boolean][]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const handYes = pairs.filter(([a]) => a).length / n;
  const graderYes = pairs.filter(([, b]) => b).length / n;
  const expected = handYes * graderYes + (1 - handYes) * (1 - graderYes);
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

const round = (value: number | null, digits = 3) => (value === null ? null : Number(value.toFixed(digits)));

export function agreement(pairs: Pair[]) {
  const families = pairs.flatMap(({ hand, grade }) => Object.entries(hand.families)
    .map(([id, handGrade]) => ({ hand: handGrade, grade: grade.families[id]! })));
  const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension,
    round(families.filter((family) => family.hand[dimension] === family.grade[dimension]).length / families.length)]));
  const actionable = families.map((family) => [isActionable(family.hand), family.grade.actionable] as [boolean, boolean]);
  const differences = pairs.map(({ hand, grade }) =>
    grade.actionable - Object.values(hand.families).filter(isActionable).length);
  return {
    runs: pairs.length,
    families: families.length,
    exact_judgment_agreement: dimensions,
    actionable_agreement: round(actionable.filter(([a, b]) => a === b).length / actionable.length),
    actionable_kappa: round(kappa(actionable)),
    hand_only_actionable: actionable.filter(([a, b]) => a && !b).length,
    grader_only_actionable: actionable.filter(([a, b]) => !a && b).length,
    run_count_mean_difference: round(differences.reduce((sum, d) => sum + d, 0) / differences.length, 2),
    run_count_mean_absolute_difference: round(differences.reduce((sum, d) => sum + Math.abs(d), 0) / differences.length, 2),
    run_count_max_absolute_difference: Math.max(...differences.map(Math.abs)),
  };
}

if (import.meta.main) {
  const { positionals: [output], values } = parseArgs({
    allowPositionals: true,
    options: {
      concurrency: { type: "string", default: "6" },
      model: { type: "string", default: "claude-opus-5-5" },
      effort: { type: "string", default: "high" },
      results: { type: "string", default: "tests/results/20261012" },
      configuration: { type: "string", multiple: true },
    },
  });
  if (!output) throw new Error("Usage: calibrate-grader.ts <output-dir>");
  mkdirSync(join(output, "grades"), { recursive: true });

  const runs = readHandGrades(join(values.results, "assessments"))
    .filter((run) => Object.keys(run.families).length > 0)
    .filter((run) => !values.configuration || values.configuration.includes(run.configuration));
  const pairs: Pair[] = [];
  const failures: string[] = [];
  await pool(runs, Number(values.concurrency), async (hand) => {
    const id = `${hand.configuration}-${hand.case}-${hand.run}`;
    const path = join(output, "grades", `${id}.json`);
    try {
      if (!existsSync(path)) {
        const trace = readJson<Trace>(join(values.results, hand.configuration, "traces", `${hand.case}-${hand.run}.json`));
        writeJson(path, await gradePlan(hand.case as Case, trace.final_response,
          { model: values.model, effort: values.effort }));
        console.log(`graded ${id}`);
      }
      pairs.push({ id, hand, grade: readJson<PlanGrade>(path) });
    } catch (error) {
      failures.push(`${id}: ${(error as Error).message}`);
    }
  });

  pairs.sort((a, b) => a.id.localeCompare(b.id));
  const groupBy = (key: (pair: Pair) => string) => Object.fromEntries(
    [...new Set(pairs.map(key))].sort().map((group) => [group, agreement(pairs.filter((pair) => key(pair) === group))]));
  const report = {
    grader: { model: values.model, effort: values.effort },
    overall: agreement(pairs),
    by_case: groupBy((pair) => pair.hand.case),
    by_configuration: groupBy((pair) => pair.hand.configuration),
    runs: pairs.map(({ id, hand, grade }) => ({
      id, hand_actionable: Object.values(hand.families).filter(isActionable).length,
      grader_actionable: grade.actionable, cost_usd: grade.cost_usd,
    })),
    grading_cost_usd: round(pairs.reduce((sum, pair) => sum + (pair.grade.cost_usd ?? 0), 0), 2),
    failures,
  };
  writeJson(join(output, "report.json"), report);
  console.log(JSON.stringify({ overall: report.overall, cost: report.grading_cost_usd, failures }, null, 2));
}
