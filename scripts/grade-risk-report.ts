/**
 * Grades one risk report against the expected risk labels with a headless Claude
 * session.
 *
 * The grader sees the grading instructions, the case's risk labels, the case's
 * answer key (for facts) and the report, with no tools. It records whether the
 * report found each labeled change, the level the report gave it, and whether the
 * report's account is accurate. Comparing levels with the labels happens here.
 *
 *   node scripts/grade-risk-report.ts <case> <report.md> <grade.json>
 *     [--model claude-opus-5-5] [--effort high]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeJson } from "./files.ts";
import { answerKey, type Case, CASES, run } from "./grade-plan.ts";

const tests = (name: string) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url));

/** Heading prefixes of each case's section in risk-labels.md. */
const LABEL_SECTIONS: Record<Case, string> = {
  rails: "## Rails ",
  sidekiq: "## Sidekiq ",
  pagy: "## Pagy ",
  faraday: "## Faraday ",
  "concurrent-ruby": "## Concurrent-ruby ",
  noop: "## No-op",
};

const FOUND = ["located", "named", "missing"] as const;
const LEVELS = ["high", "medium", "low", "not_relevant", "unrated", "missing"] as const;
const ACCURACY = ["accurate", "inaccurate", "missing"] as const;

type Level = "high" | "medium" | "low";

export interface Label {
  level: Level;
  default: boolean;
  judgmentCall: boolean;
}

export interface GradedItem {
  found: (typeof FOUND)[number];
  level: (typeof LEVELS)[number];
  accuracy: (typeof ACCURACY)[number];
  quote: string;
  reason: string;
  label: Label;
  levelMatches: boolean;
}

export interface RiskGrade {
  case: Case;
  model: string;
  effort: string;
  items: Record<string, GradedItem>;
  otherGems: { gem: string; quote: string }[];
  otherFindings: { level: "high" | "medium"; summary: string }[];
  located: number;
  levelMatches: number;
  inaccurate: number;
  cost_usd: number | null;
  duration_ms: number | null;
}

export function riskLabels(caseName: Case): { text: string; labels: Record<string, Label> } {
  const prefix = LABEL_SECTIONS[caseName];
  const text = readFileSync(tests("risk-labels.md"), "utf8").split(/^(?=## )/m)
    .find((section) => section.startsWith(prefix))?.trim();
  if (!text) throw new Error(`risk-labels.md has no section starting with "${prefix}"`);
  const labels = Object.fromEntries([...text.matchAll(/^\| (R\d\d|SK\d|PG\d|FD\d|CR\d) \| ([^|]+) \|/gm)]
    .map(([, id, risk]) => [id!, {
      level: risk!.trim().split(/[ ,]/)[0]!.toLowerCase() as Level,
      default: /\bdefault\b/.test(risk!),
      judgmentCall: /judgment call/.test(risk!),
    }]));
  return { text, labels };
}

function schema(ids: string[]) {
  const item = {
    type: "object",
    properties: {
      found: { type: "string", enum: FOUND },
      level: { type: "string", enum: LEVELS },
      accuracy: { type: "string", enum: ACCURACY },
      quote: { type: "string" },
      reason: { type: "string" },
    },
    required: ["found", "level", "accuracy", "quote", "reason"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      items: {
        type: "object",
        properties: Object.fromEntries(ids.map((id) => [id, item])),
        required: ids,
        additionalProperties: false,
      },
      other_gems: { type: "array", items: {
        type: "object",
        properties: { gem: { type: "string" }, quote: { type: "string" } },
        required: ["gem", "quote"],
        additionalProperties: false,
      } },
      other_findings: { type: "array", items: {
        type: "object",
        properties: { level: { type: "string", enum: ["high", "medium"] }, summary: { type: "string" } },
        required: ["level", "summary"],
        additionalProperties: false,
      } },
    },
    required: ["items", "other_gems", "other_findings"],
    additionalProperties: false,
  };
}

/** Grades a report, retrying once when the model fails to produce schema-valid output. */
export async function gradeRiskReport(caseName: Case, report: string,
  options: { model?: string; effort?: string } = {}): Promise<RiskGrade> {
  try {
    return await gradeOnce(caseName, report, options);
  } catch (error) {
    if (!/structured output/i.test((error as Error).message)) throw error;
    return gradeOnce(caseName, report, options);
  }
}

async function gradeOnce(caseName: Case, report: string,
  { model = "claude-opus-5-5", effort = "high" }: { model?: string; effort?: string }): Promise<RiskGrade> {
  const { text: labelText, labels } = riskLabels(caseName);
  const ids = Object.keys(labels);
  const system = `${readFileSync(tests("risk-grader-instructions.md"), "utf8")}\n\n`
    + `# Labels\n\n${labelText}\n\n# Answer key\n\n${answerKey(caseName).text}\n`;
  const prompt = `Grade this report against changes ${ids.join(", ") || "(none)"}.\n\n<report>\n${report}\n</report>`;
  const result = await run("claude", [
    "-p", "--model", model, "--effort", effort,
    "--system-prompt", system, "--tools", "",
    "--output-format", "json", "--json-schema", JSON.stringify(schema(ids)),
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
  const graded = output.structured_output;
  const items = Object.fromEntries(ids.map((id) => {
    const item = graded.items[id] as Omit<GradedItem, "label" | "levelMatches">;
    return [id, { ...item, label: labels[id]!, levelMatches: item.level === labels[id]!.level }];
  }));
  return {
    case: caseName, model, effort, items,
    otherGems: graded.other_gems,
    otherFindings: graded.other_findings,
    located: Object.values(items).filter((item) => item.found === "located").length,
    levelMatches: Object.values(items).filter((item) => item.levelMatches).length,
    inaccurate: Object.values(items).filter((item) => item.accuracy === "inaccurate").length,
    cost_usd: output.total_cost_usd ?? null,
    duration_ms: output.duration_ms ?? null,
  };
}

if (import.meta.main) {
  const { positionals: [caseName, reportPath, output], values } = parseArgs({
    allowPositionals: true,
    options: { model: { type: "string" }, effort: { type: "string" } },
  });
  if (!CASES.includes(caseName as Case) || !reportPath || !output) {
    throw new Error("Usage: grade-risk-report.ts <case> <report.md> <grade.json>");
  }
  const grade = await gradeRiskReport(caseName as Case, readFileSync(reportPath, "utf8"), {
    model: values.model, effort: values.effort,
  });
  writeJson(output, grade);
  const total = Object.keys(grade.items).length;
  console.log(`located ${grade.located}/${total}; level matches ${grade.levelMatches}/${total}; `
    + `inaccurate ${grade.inaccurate}; other gems: ${grade.otherGems.map((gem) => gem.gem).join(", ") || "none"}; `
    + `cost_usd=${grade.cost_usd}`);
}
