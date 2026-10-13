import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectUsage } from "./collect-usage.ts";
import { readJson, sha256 } from "./files.ts";
import { DEFAULT_PRICING, estimate } from "./price-usage.ts";

const START = "2026-10-12T10:00:00Z";
const END = "2026-10-12T10:02:00Z";

function nativeRecord(): any {
  return {
    type: "assistant", timestamp: "2026-10-12T10:01:00Z",
    version: "2.1.296", requestedModel: "claude-opus-5-5", perTurnEffort: "high",
    message: {
      id: "msg_original", model: "claude-opus-5-5", stop_reason: "tool_use",
      content: [{ type: "thinking", thinking: "DO NOT RETAIN" }],
      usage: {
        input_tokens: 2, output_tokens: 44, cache_read_input_tokens: 101, cache_creation_input_tokens: 17,
        cache_creation: { ephemeral_5m_input_tokens: 17, ephemeral_1h_input_tokens: 0 },
        output_tokens_details: { thinking_tokens: 11 },
        speed: "standard", inference_geo: "global", service_tier: "standard",
        private: "DO NOT RETAIN",
      },
    },
    environment: "DO NOT RETAIN", signature: "DO NOT RETAIN",
  };
}

const jsonl = (records: unknown[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

describe("collectUsage", () => {
  let directory: string;
  let session: string;
  let subagents: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "usage-"));
    session = join(directory, "session.jsonl");
    subagents = join(directory, "session", "subagents");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const collect = (records: unknown[]) => {
    writeFileSync(session, jsonl(records));
    return collectUsage(session, START, END);
  };
  const writeSubagent = (name: string, record: unknown) => {
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, name), jsonl([record]));
  };

  it("retains final native usage once and excludes follow-ups and content", () => {
    const placeholder = nativeRecord();
    placeholder.message.stop_reason = null;
    placeholder.message.usage.output_tokens = 3;
    delete placeholder.message.usage.output_tokens_details;
    const followup = nativeRecord();
    followup.timestamp = "2026-10-12T10:02:01Z";
    followup.message.id = "msg_followup";
    followup.message.usage.output_tokens = 999;
    const records = [placeholder, nativeRecord(), nativeRecord(), followup, { type: "cost-state", totalCostUSD: 42 }];

    const evidence = collect(records);
    const [scope] = evidence.scopes;
    assert.equal(scope!.excluded_later_records, 2);
    assert.equal(scope!.original_prefix_lines, 3);
    assert.equal(scope!.original_prefix_sha256, sha256(jsonl(records.slice(0, 3))));
    assert.equal(scope!.requests.length, 1);
    const [request] = scope!.requests;
    assert.equal(request!.usage.output_tokens, 44);
    assert.equal(request!.usage.cache_read_input_tokens, 101);
    assert.equal(request!.usage.cache_creation?.ephemeral_5m_input_tokens, 17);
    assert.equal(request!.usage_variants.length, 2);
    assert.equal(request!.final_usage_record, true);
    const text = JSON.stringify(evidence);
    assert.doesNotMatch(text, /DO NOT RETAIN|msg_followup|totalCostUSD/);
  });

  it("collects nested requests but marks missing final output", () => {
    const child = nativeRecord();
    child.message.id = "msg_child";
    child.message.model = "claude-haiku-5-5";
    child.message.stop_reason = null;
    delete child.message.usage.output_tokens_details;
    writeSubagent("agent-child.jsonl", child);
    writeSubagent("agent-followup.jsonl", { ...child, timestamp: "2026-10-12T10:03:00Z" });

    const evidence = collect([nativeRecord()]);
    assert.equal(evidence.scopes.length, 2);
    const [request] = evidence.scopes[1]!.requests;
    assert.equal(request!.message_id, "msg_child");
    assert.equal(request!.model, "claude-haiku-5-5");
    assert.equal(request!.final_usage_record, false);
  });

  it("keeps an unidentified child as a gap, so pricing gives only a lower bound", () => {
    const child = nativeRecord();
    delete child.message.id;
    writeSubagent("agent-child.jsonl", child);

    const evidence = collect([nativeRecord()]);
    assert.equal(evidence.scopes.length, 2);
    assert.deepEqual(evidence.scopes[1]!.requests, []);
    assert.equal(evidence.scopes[1]!.issues.length, 1);
    const cost = estimate(evidence, readJson(DEFAULT_PRICING));
    assert.equal(cost.unique_requests, 1);
    assert.equal(cost.estimate_usd, null);
    assert.ok(Math.abs(cost.lower_bound_usd! - 0.0009932) < 1e-9);
  });

  it("rejects a reversed scored boundary", () => {
    writeFileSync(session, jsonl([nativeRecord()]));
    assert.throws(() => collectUsage(session, END, START), /reversed/);
  });
});
