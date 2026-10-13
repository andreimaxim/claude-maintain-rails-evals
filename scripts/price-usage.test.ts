import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Issue, NativeRequest, UsageEvidence } from "./collect-usage.ts";
import { readJson, sha256 } from "./files.ts";
import { DEFAULT_PRICING, estimate, estimateFile, type Pricing } from "./price-usage.ts";

const pricing = readJson<Pricing>(DEFAULT_PRICING);

function request(edit: (request: any) => void = () => {}): NativeRequest {
  const base: NativeRequest = {
    message_id: "msg_main", model: "claude-opus-5-5", first_timestamp: "2026-10-12T10:01:00Z",
    source_lines: [1], usage_variants: [], final_usage_record: true,
    usage: {
      input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 7000,
      cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 4000 },
      output_tokens_details: { thinking_tokens: 200 },
    },
  };
  edit(base);
  return base;
}

function evidence(requests: NativeRequest[], otherScope: NativeRequest[] = [], issues: Issue[] = []): UsageEvidence {
  const scope = (scopeRequests: NativeRequest[], scopeIssues: Issue[]) => ({
    source_path: "session.jsonl", original_prefix_sha256: "", original_prefix_lines: 0,
    excluded_later_records: 0, original_record_types: {}, cli_versions: [],
    requests: scopeRequests, issues: scopeIssues,
  });
  return {
    schema: "planner-native-usage/v1", request_start: "2026-10-12T10:00:00Z", evaluated_end: "2026-10-12T10:02:00Z",
    session_id: "session", scope_note: "", output_note: "",
    scopes: [scope(requests, issues), scope(otherScope, [])],
  };
}

const price = (...args: Parameters<typeof evidence>) => estimate(evidence(...args), pricing);

function assertClose(actual: number | null | undefined, expected: number) {
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${actual} is not close to ${expected}`);
}

describe("estimate", () => {
  it("prices mixed cache TTLs once per message ID without adding thinking", () => {
    const cost = price([request()], [request(), request()]);
    assert.equal(cost.unique_requests, 1);
    assert.equal(cost.recorded_tokens.known_output_tokens, 500);
    assertClose(cost.components_usd.cache_write_5m, 0.015);
    assertClose(cost.components_usd.cache_write_1h, 0.032);
    assertClose(cost.components_usd.output, 0.01);
    assertClose(cost.estimate_usd, 0.0614);
    assertClose(cost.lower_bound_usd, 0.0614);
    assert.deepEqual(cost.gaps, []);
  });

  it("lets a final record supersede a placeholder in either scope order", () => {
    const placeholder = request((r) => { r.final_usage_record = false; r.usage.output_tokens = 3; });
    for (const [first, second] of [[placeholder, request()], [request(), placeholder]] as const) {
      const cost = price([first], [second]);
      assert.equal(cost.unique_requests, 1);
      assertClose(cost.estimate_usd, 0.0614);
    }
  });

  it("applies Haiku's long-context threshold per prompt, including both cache categories", () => {
    for (const [promptLength, expected] of [[99_999, 0.00278999], [100_000, 0.00279], [100_001, 0.01395005]]) {
      const haiku = request((r) => {
        r.model = "claude-haiku-5-5";
        Object.assign(r.usage, {
          input_tokens: 1000, output_tokens: 200,
          cache_read_input_tokens: promptLength! - 11_000, cache_creation_input_tokens: 10_000,
          cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 6000 },
        });
      });
      assertClose(price([haiku]).estimate_usd, expected!);
    }
    // Two 60k prompts stay below the threshold even though they sum above it.
    const [main, child] = ["msg_main", "msg_child"].map((id) => request((r) => {
      Object.assign(r, { message_id: id, model: "claude-haiku-5-5" });
      Object.assign(r.usage, {
        input_tokens: 60_000, output_tokens: 200, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, cache_creation: {},
      });
    }));
    assertClose(price([main!], [child!]).estimate_usd, 0.0122);
  });

  it("stacks modifiers on token prices but not on web search", () => {
    for (const [modifiers, expected] of [
      [{ speed: "fast", inference_geo: "us" }, 0.15508],
      [{ service_tier: "batch", inference_geo: "us" }, 0.05377],
    ] as const) {
      const cost = price([request((r) => {
        Object.assign(r.usage, modifiers, { server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } });
      })]);
      assertClose(cost.estimate_usd, expected);
      assert.equal(cost.components_usd.web_search, 0.02);
    }
  });

  it("never bills a placeholder or thinking when final output is missing", () => {
    const placeholder = request((r) => { r.final_usage_record = false; r.usage.output_tokens = 3; });
    const missing = request((r) => { delete r.usage.output_tokens; });
    for (const incomplete of [placeholder, missing]) {
      const cost = price([incomplete]);
      assert.equal(cost.estimate_usd, null);
      assertClose(cost.lower_bound_usd, 0.0514);
      assert.equal(cost.recorded_tokens.known_output_tokens, 0);
      assert.ok(cost.gaps.length > 0);
    }
  });

  it("uses the cheapest write rate as a bound when TTLs are missing or inconsistent", () => {
    const missing = request((r) => { delete r.usage.cache_creation; });
    const inconsistent = request((r) => {
      r.usage.cache_creation = { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 3999 };
    });
    for (const incomplete of [missing, inconsistent]) {
      const cost = price([incomplete]);
      assert.equal(cost.estimate_usd, null);
      assertClose(cost.lower_bound_usd, 0.0494);
      assert.ok(cost.gaps.length > 0);
    }
  });

  it("leaves partial bounds for missing input counters and scope issues", () => {
    const cost = price([request((r) => { delete r.usage.cache_read_input_tokens; })]);
    assert.equal(cost.estimate_usd, null);
    assertClose(cost.lower_bound_usd, 0.061);

    const withIssue = price([request()], [], [{ reason: "Native message ID missing" }]);
    assert.equal(withIssue.estimate_usd, null);
    assertClose(withIssue.lower_bound_usd, 0.0614);
  });

  it("keeps known tool costs and token evidence for an unpriced model", () => {
    const cost = price([request((r) => {
      r.model = "claude-unpriced";
      r.usage.server_tool_use = { web_search_requests: 2 };
    })]);
    assert.equal(cost.estimate_usd, null);
    assert.equal(cost.lower_bound_usd, 0.02);
    assert.equal(cost.recorded_tokens.known_output_tokens, 500);
  });

  it("has no estimate or bound without requests", () => {
    const cost = price([]);
    assert.equal(cost.estimate_usd, null);
    assert.equal(cost.lower_bound_usd, null);
    assert.ok(cost.gaps.length > 0);
  });
});

describe("estimateFile", () => {
  it("records the hashes of the usage and price files it read", () => {
    const directory = mkdtempSync(join(tmpdir(), "price-"));
    try {
      const usagePath = join(directory, "usage.json");
      writeFileSync(usagePath, JSON.stringify(evidence([request()])));
      const cost = estimateFile(usagePath);
      assert.equal(cost.usage_sha256, sha256(readFileSync(usagePath)));
      assert.equal(cost.pricing_sha256, sha256(readFileSync(DEFAULT_PRICING)));
      assert.equal(cost.request_start, "2026-10-12T10:00:00Z");
      assertClose(cost.estimate_usd, 0.0614);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
