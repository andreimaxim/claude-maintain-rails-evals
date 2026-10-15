import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportTranscript } from "./export-trace.ts";

const transcript = [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", cwd: "/home/user", sessionId: "s",
    message: { role: "user", content: "Report on rails 8.1.0" } },
  { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: { type: "environment" } },
  { type: "assistant", uuid: "r1", parentUuid: "a1", requestId: "req",
    message: { id: "m1", model: "claude-opus-5-5", role: "assistant", stop_reason: null, usage: { output_tokens: 5 },
      content: [{ type: "thinking", thinking: "excluded thinking", signature: "sig" }] } },
  { type: "assistant", uuid: "r2", parentUuid: "r1",
    message: { id: "m1", model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use", usage: { output_tokens: 5 },
      content: [
        { type: "redacted_thinking", data: "excluded" },
        { type: "tool_use", id: "bash", name: "Bash", input: { command: "cat Gemfile" } },
      ] } },
  { type: "api-request-blob", uuid: "b1", parentUuid: "r2", params: { system: "excluded payload" } },
  { type: "user", uuid: "u2", parentUuid: "b1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash", content: "gem \"rails\"" }] } },
].map((record) => JSON.stringify(record));

describe("exportTranscript", () => {
  it("keeps messages and tool calls without thinking, payloads or metadata", () => {
    const exported = exportTranscript(transcript);
    assert.deepEqual(exported, [
      { type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", content: "Report on rails 8.1.0" },
      { type: "assistant", uuid: "r2", parentUuid: "u1", timestamp: undefined,
        content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "cat Gemfile" } }],
        message_id: "m1", model: "claude-opus-5-5", stop_reason: "tool_use", usage: { output_tokens: 5 } },
      { type: "user", uuid: "u2", parentUuid: "r2", timestamp: undefined,
        content: [{ type: "tool_result", tool_use_id: "bash", content: "gem \"rails\"" }] },
    ]);
    assert.doesNotMatch(JSON.stringify(exported), /excluded|sig|\/home\/user|req/);
  });
});
