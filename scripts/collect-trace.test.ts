import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectTrace, type ThreadExport } from "./collect-trace.ts";
import { sha256 } from "./files.ts";

function thread(): ThreadExport {
  return {
    id: "T-example",
    agentMode: "external-agent:claude-code",
    meta: { lastKnownAgentState: { state: "idle", updatedAt: "2026-10-12T10:02:03.750Z" } },
    messages: [
      { role: "user", createdAt: "2026-10-12T10:00:00.250Z", content: [
        { type: "text", text: "Upgrade rails to 8.1.0" },
      ] },
      { role: "assistant", content: [
        { type: "text", text: "Investigating" },
        { type: "thinking", thinking: "excluded thinking" },
        { type: "tool_use", id: "lookup", name: "Bash", input: { command: "version lookup" } },
        { type: "tool_use", id: "planner", name: "Agent", input: {
          subagent_type: "maintain-rails:gem-upgrade-planner", prompt: "Exact handoff",
        } },
      ] },
      { role: "user", content: [
        { type: "tool_result", toolUseID: "planner", run: { status: "done", result: "Raw plan" } },
        { type: "tool_result", toolUseID: "lookup", run: { status: "done", result: "7.0.8.7" } },
      ] },
      { role: "assistant", createdAt: "2026-10-12T10:02:00Z", content: [
        { type: "text", text: "Final plan" },
      ] },
    ],
    // Account metadata must not reach the trace.
    private: "excluded metadata",
  } as ThreadExport;
}

/** Edits a copy of the example thread; the planner result is messages[2].content[0]. */
function variant(edit: (copy: any) => void): ThreadExport {
  const copy = structuredClone(thread());
  edit(copy);
  return copy;
}

const backgroundTranscript = (entries: unknown[]) =>
  Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

describe("collectTrace", () => {
  it("preserves visible calls, results and the final response", () => {
    const trace = collectTrace(thread());
    assert.deepEqual(trace.user_messages, ["Upgrade rails to 8.1.0"]);
    assert.equal(trace.main_tool_trace[0]!.result!.result, "7.0.8.7");
    assert.equal(trace.main_tool_trace[1]!.input.prompt, "Exact handoff");
    assert.equal(trace.main_tool_trace[1]!.result!.result, "Raw plan");
    assert.equal(trace.final_response, "Final plan");
    assert.equal(trace.request_sent_at, "2026-10-12T10:00:00.250Z");
    assert.equal(trace.completed_at, "2026-10-12T10:02:03.750Z");
    assert.equal(trace.wall_time_ms, 123500);
    assert.doesNotMatch(JSON.stringify(trace), /excluded/);
  });

  it("redacts literal Basic credentials but keeps symbolic descriptions", () => {
    const report = "Basic dTpw, Basic Og==, Basic dXNlcjpwYXNz, basic dTpw, BASIC Og==, "
      + "Basic\tdTpw, bAsIc  Og==. Basic auth and Basic #{encoded} remain symbolic.";
    const trace = collectTrace(variant((copy) => {
      copy.messages[2].content[0].run.result = report;
      copy.messages.at(-1).content[0].text = report;
    }));
    const expected = "Basic [REDACTED], Basic [REDACTED], Basic [REDACTED], Basic [REDACTED], "
      + "Basic [REDACTED], Basic [REDACTED], Basic [REDACTED]. "
      + "Basic auth and Basic #{encoded} remain symbolic.";
    assert.equal(trace.main_tool_trace[1]!.result!.result, expected);
    assert.equal(trace.final_response, expected);
    assert.equal(trace.assistant_responses.at(-1), expected);
    assert.equal(trace.privacy_omissions?.length, 3);
    for (const omission of trace.privacy_omissions!) assert.equal(omission.source_sha256, sha256(report));
  });

  it("rejects incomplete runs", () => {
    const cases: Record<string, ThreadExport> = {
      "working": variant((copy) => { copy.meta.lastKnownAgentState.state = "running_tools"; }),
      "failed planner": variant((copy) => { copy.messages[2].content[0].run.status = "error"; }),
      "missing planner result": variant((copy) => { copy.messages[2].content.shift(); }),
      "progress only": variant((copy) => { copy.messages.pop(); }),
      "background launch only": variant((copy) => {
        copy.messages[2].content[0].run.result = "Async agent launched successfully. The agent is working in the background.";
      }),
      "terminated planner marked done": variant((copy) => {
        copy.messages[2].content[0].run.result = "  Agent terminated early due to an API error: session limit (HTTP 429)\n"
          + "Everything below is PARTIAL output. The agent did NOT finish its task.\nPreparing isolated databases.";
      }),
      "parent API error": variant((copy) => {
        copy.messages.at(-1).content[0].text = "Claude Code reported an error (success): You've hit your session limit";
      }),
    };
    for (const [name, source] of Object.entries(cases)) {
      assert.throws(() => collectTrace(source), Error, name);
    }
  });

  it("collects only a matching completed background report that precedes the final response", () => {
    const launched = variant((copy) => {
      copy.messages[2].content[0].run.result = "Async agent launched successfully.\nagentId: planner-42";
      copy.messages.at(-1).createdAt = "2026-10-12T10:02:02Z";
    });
    const background = [
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "excluded background thinking" }] } },
      { type: "assistant", agentId: "planner-42", attributionAgent: "maintain-rails:gem-upgrade-planner",
        timestamp: "2026-10-12T10:02:01Z", private: "excluded background metadata",
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "Completed background plan" }] } },
    ];
    const trace = collectTrace(launched, backgroundTranscript(background));
    assert.equal(trace.background_planner_report?.text, "Completed background plan");
    assert.equal(trace.background_planner_report?.tool_use_id, "planner");
    assert.equal(trace.wall_time_ms, 123500);
    assert.doesNotMatch(JSON.stringify(trace), /excluded/);

    const lastEntry = (edit: (entry: any) => void) => {
      const copy = structuredClone(background);
      edit(copy.at(-1));
      return backgroundTranscript(copy);
    };
    const premature = structuredClone(launched);
    premature.messages.at(-1)!.createdAt = "2026-10-12T10:02:00Z";
    assert.throws(() => collectTrace(launched, lastEntry((entry) => { entry.agentId = "unrelated-agent"; })));
    assert.throws(() => collectTrace(launched, lastEntry((entry) => { entry.message.stop_reason = "tool_use"; })));
    assert.throws(() => collectTrace(premature, backgroundTranscript(background)));
  });
});
