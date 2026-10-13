/**
 * Retains usage-only native transcript evidence inside a scored time boundary.
 *
 * Run after evaluation. This does not launch Claude, resume agents or expose content.
 * Native final usage differs from the Agent SDK's message-start placeholders.
 *
 *   node scripts/collect-usage.ts <session.jsonl> <usage.json> --start <iso> --end <iso>
 *     [--subagent-file <path>]...
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { sha256, writeJson } from "./files.ts";

const COUNTERS = [
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
] as const;
const NESTED_COUNTERS = {
  cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
  output_tokens_details: ["thinking_tokens"],
  server_tool_use: ["web_search_requests", "web_fetch_requests", "code_execution_requests"],
} as const;
const MODIFIERS = {
  service_tier: ["standard", "batch", "priority"],
  speed: ["standard", "fast"],
  inference_geo: ["global", "us"],
} as const;
const FINAL_STOP_REASONS = new Set([
  "end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal",
]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]+$/;
const MODEL = /^claude-[a-z0-9.-]+$/;
const VERSION = /^[0-9.]+$/;

type Counter = (typeof COUNTERS)[number];
type Nested = { [K in keyof typeof NESTED_COUNTERS]?: Partial<Record<(typeof NESTED_COUNTERS)[K][number], number>> };
type Modifiers = { [K in keyof typeof MODIFIERS]?: (typeof MODIFIERS)[K][number] };
export type Usage = Partial<Record<Counter, number>> & Nested & Modifiers;

export interface NativeRequest {
  message_id: string;
  model: string | null;
  first_timestamp: string;
  source_lines: number[];
  usage_variants: Usage[];
  /** The latest native record for this message. */
  usage: Usage;
  final_usage_record: boolean;
  requested_model?: string;
  per_turn_effort?: string;
  last_timestamp?: string;
  stop_reason?: string;
}

export interface Issue { line?: number; message_id?: string; reason: string }

export interface UsageScope {
  source_path: string;
  original_prefix_sha256: string;
  original_prefix_lines: number;
  excluded_later_records: number;
  original_record_types: Record<string, number>;
  cli_versions: string[];
  requests: NativeRequest[];
  issues: Issue[];
}

export interface UsageEvidence {
  schema: "planner-native-usage/v1";
  request_start: string;
  evaluated_end: string;
  session_id: string;
  scopes: UsageScope[];
  scope_note: string;
  output_note: string;
}

interface NativeRecord {
  type?: string;
  timestamp?: string;
  version?: unknown;
  requestedModel?: unknown;
  perTurnEffort?: unknown;
  message?: { id?: unknown; model?: unknown; stop_reason?: string | null; usage?: unknown };
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.test(value);

/** Keeps only non-negative counters and known request modifiers. */
function usageOnly(value: unknown): Usage {
  if (!isObject(value)) return {};
  const clean: Record<string, unknown> = Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => (COUNTERS as readonly string[]).includes(key) && isCount(count)));
  for (const [key, allowed] of Object.entries(NESTED_COUNTERS)) {
    const nested = value[key];
    if (isObject(nested)) {
      clean[key] = Object.fromEntries(Object.entries(nested)
        .filter(([name, count]) => (allowed as readonly string[]).includes(name) && isCount(count)));
    }
  }
  for (const [key, allowed] of Object.entries(MODIFIERS)) {
    if ((allowed as readonly unknown[]).includes(value[key])) clean[key] = value[key];
  }
  return clean as Usage;
}

/** Splits JSONL bytes into lines that keep their terminators, so prefixes hash exactly. */
function rawLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  while (start < data.length) {
    const end = data.indexOf(0x0a, start);
    const next = end === -1 ? data.length : end + 1;
    lines.push(data.subarray(start, next));
    start = next;
  }
  return lines;
}

function collectSource(path: string, start: number, end: number): UsageScope {
  const prefix: Buffer[] = [];
  const requests = new Map<string, NativeRequest>();
  const issues: Issue[] = [];
  const recordTypes: Record<string, number> = {};
  const versions = new Set<string>();
  let excluded = 0;
  let pastBoundary = false;

  for (const [index, raw] of rawLines(readFileSync(path)).entries()) {
    const line = index + 1;
    const record = JSON.parse(raw.toString("utf8")) as NativeRecord;
    const time = record.timestamp;
    // Everything after the scored boundary is a later collection turn.
    if (time && Date.parse(time) > end) pastBoundary = true;
    if (pastBoundary) {
      excluded += 1;
      continue;
    }
    prefix.push(raw);
    const kind = record.type ?? "unknown";
    recordTypes[kind] = (recordTypes[kind] ?? 0) + 1;
    if (kind !== "assistant") continue;
    if (!time) {
      issues.push({ line, reason: "Assistant timestamp missing" });
      continue;
    }
    if (Date.parse(time) < start) continue;

    const message = record.message ?? {};
    if (!matches(MESSAGE_ID, message.id)) {
      issues.push({ line, reason: "Native message ID missing or unsupported" });
      continue;
    }
    if (matches(VERSION, record.version)) versions.add(record.version);
    const usage = usageOnly(message.usage);
    // Final native records add stop_reason and output details after streaming.
    // Earlier records can carry only the initial output-token placeholder.
    const final = FINAL_STOP_REASONS.has(message.stop_reason ?? "")
      && "output_tokens_details" in usage && COUNTERS.every((counter) => counter in usage);

    let request = requests.get(message.id);
    if (!request) {
      request = {
        message_id: message.id,
        model: matches(MODEL, message.model) ? message.model : null,
        first_timestamp: time,
        source_lines: [],
        usage_variants: [],
        usage,
        final_usage_record: final,
      };
      requests.set(message.id, request);
    }
    if (matches(MODEL, record.requestedModel)) request.requested_model = record.requestedModel;
    if (typeof record.perTurnEffort === "string" && EFFORTS.has(record.perTurnEffort)) {
      request.per_turn_effort = record.perTurnEffort;
    }
    request.last_timestamp = time;
    request.source_lines.push(line);
    if (!isDeepStrictEqual(request.usage_variants.at(-1), usage)) request.usage_variants.push(usage);
    request.usage = usage;
    request.final_usage_record = final;
    if (final) request.stop_reason = message.stop_reason!;
  }

  return {
    source_path: path,
    original_prefix_sha256: sha256(Buffer.concat(prefix)),
    original_prefix_lines: prefix.length,
    excluded_later_records: excluded,
    original_record_types: recordTypes,
    cli_versions: [...versions].sort(),
    requests: [...requests.values()],
    issues,
  };
}

/** Finds `<session>/subagents/**\/*.jsonl` next to `<session>.jsonl`. */
function subagentTranscripts(sessionFile: string): string[] {
  const directory = join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "subagents");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directory, name));
}

export function collectUsage(
  sessionFile: string, start: string, end: string, extraSubagents: string[] = [],
): UsageEvidence {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (startTime > endTime) throw new Error("The scored time boundary is reversed");
  const paths = [...new Set([...subagentTranscripts(sessionFile), ...extraSubagents])].sort();
  const nested = paths.map((path) => collectSource(path, startTime, endTime))
    .filter((scope) => scope.requests.length > 0 || scope.issues.length > 0);
  return {
    schema: "planner-native-usage/v1",
    request_start: start,
    evaluated_end: end,
    session_id: basename(sessionFile).replace(/\.[^.]*$/, ""),
    scopes: [collectSource(sessionFile, startTime, endTime), ...nested],
    scope_note: "Recorded main and subagent requests only; unlogged helper calls and billing adjustments are not included.",
    output_note: "Use the last native record per message ID. A missing final-usage record cannot supply a reliable output total.",
  };
}

if (import.meta.main) {
  const { positionals: [sessionFile, output], values } = parseArgs({
    allowPositionals: true,
    options: {
      start: { type: "string" },
      end: { type: "string" },
      "subagent-file": { type: "string", multiple: true, default: [] },
    },
  });
  if (!sessionFile || !output || !values.start || !values.end) {
    throw new Error("Usage: collect-usage.ts <session.jsonl> <usage.json> --start <iso> --end <iso>");
  }
  const evidence = collectUsage(sessionFile, values.start, values.end, values["subagent-file"]);
  mkdirSync(dirname(output), { recursive: true });
  writeJson(output, evidence);
  const requests = evidence.scopes.flatMap((scope) => scope.requests);
  console.log(`Saved ${requests.length} unique native requests in ${evidence.scopes.length} scopes; `
    + `${requests.filter((request) => !request.final_usage_record).length} lack final usage.`);
}
