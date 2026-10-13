/**
 * Extracts a completed visible planner trace from `amp threads export` JSON.
 *
 * This collects evidence; it does not launch agents or grade their plans. Review
 * tool output for secrets before sharing the result. Thinking blocks and
 * account/environment metadata are excluded; tool inputs and results are kept.
 *
 *   node scripts/collect-trace.ts <export.json> <trace.json> [--background-transcript <path>]
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pick, readJson, sha256, writeJson } from "./files.ts";

const PLANNER = "maintain-rails:gem-upgrade-planner";

interface TextBlock { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface ToolRun { status?: string; result?: string }
interface ToolResultBlock { type: "tool_result"; toolUseID: string; run: ToolRun }
interface OtherBlock { type: "thinking" | "redacted_thinking" | "image" }
type Block = TextBlock | ToolUseBlock | ToolResultBlock | OtherBlock;

interface Message {
  role: "user" | "assistant";
  createdAt?: string;
  content: Block[];
}

export interface ThreadExport {
  id: string;
  agentMode: string;
  meta?: {
    lastKnownAgentState?: { state?: string; updatedAt?: string };
    features?: string[];
  };
  env?: { initial?: { trees?: { repository?: Record<string, unknown> }[] } };
  messages: Message[];
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: ToolRun | null;
}

interface TranscriptEntry {
  type?: string;
  agentId?: string;
  attributionAgent?: string;
  timestamp?: string;
  requestedModel?: string;
  perTurnEffort?: string;
  version?: string;
  message?: { stop_reason?: string; content?: Block[] };
}

interface PrivacyOmission { location: string; source_sha256: string; reason: string }

interface BackgroundReport {
  tool_use_id: string;
  text: string;
  completed_at: string;
  source_sha256: string;
  model: string | null;
  effort: string | null;
  cli_version: string | null;
}

export interface Trace {
  thread: string;
  state: "idle";
  request_sent_at: string | null;
  completed_at: string | null;
  wall_time_ms: number | null;
  agent_mode: string;
  features: string[];
  initial_repositories: Record<string, unknown>[];
  user_messages: string[];
  main_tool_trace: ToolCall[];
  background_planner_report: BackgroundReport | null;
  assistant_responses: string[];
  final_response: string;
  evidence_limits: string[];
  privacy_omissions?: PrivacyOmission[];
}

const BASIC_AUTH = /\bBasic[ \t]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi;

// Replaces literal Basic credentials (base64 containing a colon) but keeps prose such
// as "Basic auth" or "Basic #{encoded}". Records each changed string's original hash.
function redactBasicAuth<T>(value: T, omissions: PrivacyOmission[], location = ""): T {
  if (typeof value === "string") {
    const clean = value.replace(BASIC_AUTH, (match, encoded: string) => {
      if (encoded.length % 4 !== 0) return match;
      return Buffer.from(encoded, "base64").includes(":") ? "Basic [REDACTED]" : match;
    });
    if (clean !== value) {
      omissions.push({
        location,
        source_sha256: sha256(value),
        reason: "Literal Basic-auth value redacted; symbolic descriptions retained.",
      });
    }
    return clean as T;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactBasicAuth(item, omissions, `${location}/${index}`)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, redactBasicAuth(item, omissions, `${location}/${key}`)])) as T;
  }
  return value;
}

function texts(blocks: Block[] = []): string[] {
  return blocks.filter((block): block is TextBlock => block.type === "text").map((block) => block.text);
}

function backgroundReport(planner: ToolCall, transcript: Buffer): BackgroundReport {
  const entries = transcript.toString("utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
  const completed = entries.filter((entry) => entry.type === "assistant").at(-1);
  const agentId = /agentId: (\S+)/.exec(planner.result?.result ?? "")?.[1];
  const report = texts(completed?.message?.content);
  if (!completed || !agentId || completed.agentId !== agentId
      || completed.attributionAgent !== planner.input.subagent_type
      || completed.message?.stop_reason !== "end_turn" || report.length === 0) {
    throw new Error("No matching completed background planner report");
  }
  return {
    tool_use_id: planner.id,
    text: report.join("\n\n"),
    completed_at: completed.timestamp!,
    source_sha256: sha256(transcript),
    model: completed.requestedModel ?? null,
    effort: completed.perTurnEffort ?? null,
    cli_version: completed.version ?? null,
  };
}

export function collectTrace(thread: ThreadExport, backgroundTranscript?: Buffer): Trace {
  const state = thread.meta?.lastKnownAgentState?.state;
  if (state !== "idle") throw new Error(`Thread is not idle: ${state}`);

  const tools: ToolCall[] = [];
  const runs = new Map<string, ToolRun>();
  const responses: string[] = [];
  const userMessages: string[] = [];
  for (const message of thread.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        tools.push({ id: block.id, name: block.name, input: block.input, result: null });
      } else if (block.type === "tool_result") {
        runs.set(block.toolUseID, pick(block.run, ["status", "result"]));
      }
    }
    const text = texts(message.content);
    if (text.length > 0) (message.role === "assistant" ? responses : userMessages).push(text.join("\n\n"));
  }
  for (const tool of tools) tool.result = runs.get(tool.id) ?? null;

  const planners = tools.filter((tool) => tool.name === "Agent" && tool.input.subagent_type === PLANNER);
  const reports = planners.map((tool) => tool.result?.result ?? "");
  if (planners.length === 0 || planners.some((tool) => tool.result?.status !== "done")) {
    throw new Error("No completed gem-upgrade-planner invocation");
  }
  if (reports.some((report) => report.trimStart().startsWith("Agent terminated early"))) {
    throw new Error("Planner terminated early; recovered output is incomplete");
  }
  const launched = planners.filter((_, index) => reports[index]!.startsWith("Async agent launched successfully."));
  let background: BackgroundReport | null = null;
  if (launched.length > 0) {
    if (launched.length !== 1 || !backgroundTranscript) {
      throw new Error("Planner launch acknowledgment is not a completed report");
    }
    background = backgroundReport(launched[0]!, backgroundTranscript);
  }

  const last = thread.messages.at(-1);
  if (last?.role !== "assistant" || texts(last.content).length === 0) {
    throw new Error("No final assistant text");
  }
  const finalResponse = responses.at(-1)!;
  if (finalResponse.trimStart().startsWith("Claude Code reported an error")) {
    throw new Error("Parent error response is not a delivered plan");
  }
  if (background && Date.parse(last.createdAt!) < Date.parse(background.completed_at)) {
    throw new Error("No final assistant response after background planner completion");
  }

  const startedAt = thread.messages[0]?.createdAt ?? null;
  const completedAt = thread.meta?.lastKnownAgentState?.updatedAt ?? null;
  const trace: Trace = {
    thread: `https://ampcode.com/threads/${thread.id}`,
    state,
    request_sent_at: startedAt,
    completed_at: completedAt,
    wall_time_ms: startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null,
    agent_mode: thread.agentMode,
    features: thread.meta?.features ?? [],
    initial_repositories: (thread.env?.initial?.trees ?? []).flatMap((tree) =>
      tree.repository ? [pick(tree.repository, ["ref", "sha", "url", "type"])] : []),
    user_messages: userMessages,
    main_tool_trace: tools,
    background_planner_report: background,
    assistant_responses: responses,
    final_response: finalResponse,
    evidence_limits: [
      "Visible main-agent trace and planner hand-back, not nested experiment logs.",
      "Idle state and completed planner do not establish file or service-state preservation.",
    ],
  };
  const omissions: PrivacyOmission[] = [];
  const redacted = redactBasicAuth(trace, omissions);
  return omissions.length > 0 ? { ...redacted, privacy_omissions: omissions } : redacted;
}

if (import.meta.main) {
  const { positionals: [exportPath, output], values } = parseArgs({
    allowPositionals: true,
    options: { "background-transcript": { type: "string" } },
  });
  if (!exportPath || !output) throw new Error("Usage: collect-trace.ts <export.json> <trace.json>");
  const transcript = values["background-transcript"];
  const trace = collectTrace(readJson<ThreadExport>(exportPath),
    transcript ? readFileSync(transcript) : undefined);
  writeJson(output, trace);
  console.log(`Collected ${trace.main_tool_trace.length} tool calls: ${output}`);
}
