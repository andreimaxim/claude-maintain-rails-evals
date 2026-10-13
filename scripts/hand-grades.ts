/**
 * Reads the hand-graded final-layer judgments from the October 12 assessments.
 *
 * The assessments were written by several graders in five JSON shapes; this
 * normalizes each family's four judgments to one tuple per run.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./files.ts";

export const DIMENSIONS = ["impact", "applicability", "recommendation", "validation"] as const;
export const JUDGMENTS = ["supported", "partial", "missing", "incorrect"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Judgment = (typeof JUDGMENTS)[number];
export type FamilyGrade = Record<Dimension, Judgment>;

export interface HandGradedRun {
  configuration: string;
  case: string;
  run: number;
  source: string;
  families: Record<string, FamilyGrade>;
}

/** Assessment file prefix → benchmark configuration. retry-* is the Opus-high development batch. */
const CONFIGURATIONS: Record<string, string> = {
  "opus-high": "opus-5.5-high",
  "retry": "opus-5.5-high",
  "opus-low": "opus-5.5-low",
  "sonnet-medium": "sonnet-5.5-medium",
  "haiku-medium": "haiku-5.5-medium",
};
const ALIASES: Record<string, Dimension> = {
  application_impact: "impact",
  correct_applicability: "applicability",
  valid_recommendation: "recommendation",
  discriminating_validation: "validation",
};
const FAMILY = /^(R\d\d|SK\d|PG\d|FD\d)$/;

const isJudgment = (value: unknown): value is Judgment => JUDGMENTS.includes(value as Judgment);

function judgment(value: unknown): Judgment | undefined {
  if (isJudgment(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isJudgment(record.judgment)) return record.judgment;
    if (isJudgment(record.status)) return record.status;
  }
  return undefined;
}

/** Accepts every shape the assessments use for one family's four judgments. */
export function familyGrade(entry: unknown): FamilyGrade | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const source = (Array.isArray(entry) ? entry : (entry as Record<string, unknown>).judgments ?? entry) as unknown;
  const grade: Partial<FamilyGrade> = {};
  if (Array.isArray(source)) {
    source.forEach((item, index) => {
      const dimension = (item as { dimension?: Dimension })?.dimension ?? DIMENSIONS[index];
      const value = judgment(item);
      if (dimension && value) grade[dimension] = value;
    });
  } else if (source && typeof source === "object") {
    for (const [key, value] of Object.entries(source)) {
      const dimension = ALIASES[key] ?? (DIMENSIONS.includes(key as Dimension) ? key as Dimension : undefined);
      const parsed = judgment(value);
      if (dimension && parsed) grade[dimension] = parsed;
    }
  }
  return DIMENSIONS.every((dimension) => grade[dimension]) ? grade as FamilyGrade : undefined;
}

function finalLayer(run: Record<string, unknown>): Record<string, unknown> | undefined {
  if (run.final && typeof run.final === "object") return run.final as Record<string, unknown>;
  // opus-low-rails and retry-rails keep families[F].final.
  if (run.families && typeof run.families === "object") {
    return Object.fromEntries(Object.entries(run.families as Record<string, { final?: unknown }>)
      .map(([family, layers]) => [family, layers.final]));
  }
  return undefined;
}

export function readHandGrades(assessmentsDir: string): HandGradedRun[] {
  const runs: HandGradedRun[] = [];
  for (const name of readdirSync(assessmentsDir).filter((file) => file.endsWith("-assessment.json")).sort()) {
    const match = /^(opus-high|opus-low|sonnet-medium|haiku-medium|retry)-(rails|sidekiq|pagy|faraday)/.exec(name);
    if (!match) continue;
    const assessment = readJson<{ runs: Record<string, unknown>[] | Record<string, Record<string, unknown>> }>(
      join(assessmentsDir, name));
    for (const run of Object.values(assessment.runs)) {
      const layer = finalLayer(run);
      const families: Record<string, FamilyGrade> = {};
      for (const [family, entry] of Object.entries(layer ?? {})) {
        const grade = FAMILY.test(family) ? familyGrade(entry) : undefined;
        if (grade) families[family] = grade;
      }
      runs.push({
        configuration: CONFIGURATIONS[match[1]!]!, case: match[2]!, run: Number(run.run), source: name, families,
      });
    }
  }
  return runs;
}

export const isActionable = (grade: FamilyGrade) =>
  grade.impact === "supported" && grade.applicability === "supported" && grade.recommendation === "supported";
