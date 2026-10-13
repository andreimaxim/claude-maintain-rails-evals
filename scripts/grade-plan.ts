/**
 * Grades one upgrade plan against the answer key with a headless Claude session.
 *
 * The grader sees the grading instructions, the case's answer-key section and the
 * plan text, with no tools. It returns four judgments per selected finding;
 * actionability (first three supported) is computed here, not by the model.
 *
 *   node scripts/grade-plan.ts <rails|sidekiq|pagy|faraday> <plan.md> <grade.json>
 *     [--model claude-opus-5-5] [--effort high]
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeJson } from "./files.ts";
import { DIMENSIONS, type FamilyGrade, isActionable, JUDGMENTS } from "./hand-grades.ts";

const tests = (name: string) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url));

export const CASES = ["rails", "sidekiq", "pagy", "faraday"] as const;
export type Case = (typeof CASES)[number];

/** Answer-key sections per case, by heading prefix. */
const KEY_SECTIONS: Record<Case, { file: string; headings: string[] }> = {
  rails: { file: "planner-development.md", headings: ["## Rails:"] },
  sidekiq: { file: "planner-development.md", headings: ["## Sidekiq:"] },
  pagy: { file: "planner-held-out.md", headings: ["## Pagy"] },
  faraday: { file: "planner-held-out.md", headings: ["## Faraday"] },
};
const REQUESTS: Record<Case, string> = {
  rails: "Upgrade the rails gem to 8.1.0 (from 7.0.8.7)",
  sidekiq: "Upgrade the sidekiq gem to 7.3.9 (from 6.5.12)",
  pagy: "Upgrade the pagy gem to 9.3.5 (from 8.6.3)",
  faraday: "Upgrade the faraday gem to 2.12.2 (from 1.10.4)",
};

export interface GradedFamily extends FamilyGrade {
  quote: string;
  reasons: string;
  actionable: boolean;
}

export interface PlanGrade {
  case: Case;
  model: string;
  effort: string;
  families: Record<string, GradedFamily>;
  actionable: number;
  cost_usd: number | null;
  duration_ms: number | null;
}

/** Returns the `##` sections of a Markdown file whose headings start with any prefix. */
function sections(markdown: string, prefixes: string[]): string {
  return markdown.split(/^(?=## )/m)
    .filter((section) => prefixes.some((prefix) => section.startsWith(prefix)))
    .join("\n").trim();
}

export function answerKey(caseName: Case): { text: string; families: string[] } {
  const { file, headings } = KEY_SECTIONS[caseName];
  const text = sections(readFileSync(tests(file), "utf8"), headings);
  const families = [...text.matchAll(/^\| (R\d\d|SK\d|PG\d|FD\d) \|/gm)].map((match) => match[1]!);
  return { text, families };
}

function schema(families: string[]) {
  const judgment = { type: "string", enum: JUDGMENTS };
  const family = {
    type: "object",
    properties: {
      ...Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, judgment])),
      quote: { type: "string" },
      reasons: { type: "string" },
    },
    required: [...DIMENSIONS, "quote", "reasons"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: { families: {
      type: "object",
      properties: Object.fromEntries(families.map((id) => [id, family])),
      required: families,
      additionalProperties: false,
    } },
    required: ["families"],
    additionalProperties: false,
  };
}

function run(command: string, args: string[], input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Drop variables that tie a nested claude to the calling session; keep its auth token.
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith("CLAUDE") || key === "CLAUDE_CODE_OAUTH_TOKEN"));
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Grades a plan, retrying once when the model fails to produce schema-valid output. */
export async function gradePlan(caseName: Case, plan: string,
  options: { model?: string; effort?: string } = {}): Promise<PlanGrade> {
  try {
    return await gradeOnce(caseName, plan, options);
  } catch (error) {
    if (!/structured output/i.test((error as Error).message)) throw error;
    return gradeOnce(caseName, plan, options);
  }
}

async function gradeOnce(caseName: Case, plan: string,
  { model = "claude-opus-5-5", effort = "high" }: { model?: string; effort?: string }): Promise<PlanGrade> {
  const key = answerKey(caseName);
  const system = `${readFileSync(tests("grader-instructions.md"), "utf8")}\n\n`
    + `# Answer key: ${REQUESTS[caseName]}\n\n${key.text}\n`;
  const prompt = `Grade this plan against findings ${key.families.join(", ")}.\n\n<plan>\n${plan}\n</plan>`;
  const result = await run("claude", [
    "-p", "--model", model, "--effort", effort,
    "--system-prompt", system, "--tools", "",
    "--output-format", "json", "--json-schema", JSON.stringify(schema(key.families)),
    "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config",
  ], prompt);
  const output = JSON.parse(result.stdout || "{}");
  if (output.subtype === "error_max_structured_output_retries") {
    throw new Error("Grader failed to produce schema-valid structured output");
  }
  if (result.status !== 0) throw new Error(`claude exited ${result.status}: ${result.stderr || result.stdout}`.slice(0, 2000));
  if (output.is_error || !output.structured_output) {
    throw new Error(`Grader returned no structured output: ${String(output.result).slice(0, 500)}`);
  }
  const families = Object.fromEntries(Object.entries(
    output.structured_output.families as Record<string, Omit<GradedFamily, "actionable">>,
  ).map(([id, grade]) => [id, { ...grade, actionable: isActionable(grade) }]));
  return {
    case: caseName, model, effort, families,
    actionable: Object.values(families).filter((family) => family.actionable).length,
    cost_usd: output.total_cost_usd ?? null,
    duration_ms: output.duration_ms ?? null,
  };
}

if (import.meta.main) {
  const { positionals: [caseName, planPath, output], values } = parseArgs({
    allowPositionals: true,
    options: { model: { type: "string" }, effort: { type: "string" } },
  });
  if (!CASES.includes(caseName as Case) || !planPath || !output) {
    throw new Error("Usage: grade-plan.ts <rails|sidekiq|pagy|faraday> <plan.md> <grade.json>");
  }
  const grade = await gradePlan(caseName as Case, readFileSync(planPath, "utf8"), {
    model: values.model, effort: values.effort,
  });
  writeJson(output, grade);
  console.log(`${grade.actionable}/${Object.keys(grade.families).length} actionable; cost_usd=${grade.cost_usd}`);
}
