/**
 * Exports the session transcripts from an extracted headless run archive as
 * plain JSONL that is safe to commit.
 *
 * Keeps each message's text, tool calls and tool results, plus the model, stop
 * reason and token usage of assistant messages. Drops thinking blocks, API request
 * payloads, attachments and account/environment metadata. Review the output for
 * secrets before sharing it.
 *
 *   node scripts/export-trace.ts <extracted-run-dir> <trace-dir>
 *
 * Writes `main.jsonl` for the main session, `<agent-type>-<agent-id>.jsonl` for
 * each subagent, and copies the tool results that Claude Code saved to files.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { readJson } from "./files.ts";

interface Block { type: string; [key: string]: unknown }

interface TranscriptRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?: string | Block[];
    stop_reason?: string | null;
    usage?: unknown;
  };
}

const HIDDEN_BLOCKS = new Set(["thinking", "redacted_thinking"]);

/** Returns the committed form of one transcript record, or null to drop it. */
function exportRecord(record: TranscriptRecord): Record<string, unknown> | null {
  if ((record.type !== "user" && record.type !== "assistant") || !record.message) return null;
  const { content } = record.message;
  const kept = Array.isArray(content) ? content.filter((block) => !HIDDEN_BLOCKS.has(block.type)) : content;
  if (kept === undefined || (Array.isArray(kept) && kept.length === 0)) return null;
  const exported: Record<string, unknown> = {
    type: record.type,
    uuid: record.uuid,
    parentUuid: record.parentUuid ?? null,
    timestamp: record.timestamp,
    content: kept,
  };
  if (record.type === "assistant") {
    Object.assign(exported, {
      message_id: record.message.id,
      model: record.message.model,
      stop_reason: record.message.stop_reason ?? null,
      usage: record.message.usage,
    });
  }
  return exported;
}

/** Exports a transcript, pointing each kept record's parent past any dropped records. */
export function exportTranscript(lines: string[]): Record<string, unknown>[] {
  const droppedParents = new Map<string, string | null>();
  const resolve = (uuid: string | null | undefined): string | null =>
    uuid && droppedParents.has(uuid) ? droppedParents.get(uuid)! : uuid ?? null;
  const kept: Record<string, unknown>[] = [];
  for (const line of lines) {
    const record = JSON.parse(line) as TranscriptRecord;
    const exported = exportRecord(record);
    if (exported) {
      kept.push({ ...exported, parentUuid: resolve(record.parentUuid) });
    } else if (record.uuid) {
      droppedParents.set(record.uuid, resolve(record.parentUuid));
    }
  }
  return kept;
}

function writeTranscript(source: string, target: string): void {
  const records = exportTranscript(readFileSync(source, "utf8").split("\n").filter(Boolean));
  writeFileSync(target, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

/** Exports every session in the run's Claude config and returns the files written. */
export function exportTrace(runDir: string, traceDir: string): string[] {
  const projects = join(runDir, "claude-config", "projects");
  if (!existsSync(projects)) throw new Error(`${runDir} has no claude-config/projects`);
  mkdirSync(traceDir, { recursive: true });
  const written: string[] = [];
  for (const project of readdirSync(projects)) {
    const projectDir = join(projects, project);
    for (const file of readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"))) {
      const sessionDir = join(projectDir, basename(file, ".jsonl"));
      writeTranscript(join(projectDir, file), join(traceDir, "main.jsonl"));
      written.push("main.jsonl");

      const subagents = join(sessionDir, "subagents");
      for (const name of existsSync(subagents) ? readdirSync(subagents).filter((n) => n.endsWith(".jsonl")) : []) {
        const id = basename(name, ".jsonl").replace(/^agent-/, "");
        const meta = join(subagents, `agent-${id}.meta.json`);
        const type = existsSync(meta) ? readJson<{ agentType: string }>(meta).agentType.replace(/^.*:/, "") : "subagent";
        writeTranscript(join(subagents, name), join(traceDir, `${type}-${id}.jsonl`));
        written.push(`${type}-${id}.jsonl`);
      }

      const toolResults = join(sessionDir, "tool-results");
      for (const name of existsSync(toolResults) ? readdirSync(toolResults) : []) {
        mkdirSync(join(traceDir, "tool-results"), { recursive: true });
        copyFileSync(join(toolResults, name), join(traceDir, "tool-results", name));
        written.push(`tool-results/${name}`);
      }
    }
  }
  if (written.filter((name) => name === "main.jsonl").length !== 1) {
    throw new Error(`${runDir} should hold exactly one main session`);
  }
  return written;
}

if (import.meta.main) {
  const { positionals: [runDir, traceDir] } = parseArgs({ allowPositionals: true });
  if (!runDir || !traceDir) throw new Error("Usage: export-trace.ts <extracted-run-dir> <trace-dir>");
  console.log(exportTrace(runDir, traceDir).join("\n"));
}
