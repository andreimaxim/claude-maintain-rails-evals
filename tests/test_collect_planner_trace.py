import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CollectPlannerTraceTest(unittest.TestCase):
    def setUp(self):
        self.thread = {
            "id": "T-example",
            "agentMode": "external-agent:claude-code",
            "meta": {"lastKnownAgentState": {
                "state": "idle", "updatedAt": "2026-10-12T10:02:03.750Z",
            }, "private": "excluded metadata"},
            "messages": [
                {"role": "user", "createdAt": "2026-10-12T10:00:00.250Z", "content": [
                    {"type": "text", "text": "Upgrade rails to 8.1.0"},
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Investigating"},
                    {"type": "thinking", "thinking": "excluded thinking"},
                    {"type": "tool_use", "id": "lookup", "name": "Bash", "input": {"command": "version lookup"}},
                    {"type": "tool_use", "id": "planner", "name": "Agent", "input": {
                        "subagent_type": "maintain-rails:gem-upgrade-planner", "prompt": "Exact handoff",
                    }},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "toolUseID": "planner", "run": {"status": "done", "result": "Raw plan"}},
                    {"type": "tool_result", "toolUseID": "lookup", "run": {"status": "done", "result": "7.0.8.7"}},
                ]},
                {"role": "assistant", "createdAt": "2026-10-12T10:02:00Z", "content": [
                    {"type": "text", "text": "Final plan"},
                ]},
            ],
        }

    def collect(self, thread, background=None):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "thread.json"
            output = Path(directory) / "trace.json"
            source.write_text(json.dumps(thread))
            command = [sys.executable, "-B", str(Path(__file__).with_name("collect-planner-trace.py")), str(source), str(output)]
            if background is not None:
                transcript = Path(directory) / "background.jsonl"
                transcript.write_text("\n".join(json.dumps(entry) for entry in background) + "\n")
                command.extend(["--background-transcript", str(transcript)])
            result = subprocess.run(
                command,
                capture_output=True, text=True,
            )
            return result, json.loads(output.read_text()) if output.exists() else None

    def test_preserves_visible_calls_results_and_final_response(self):
        result, trace = self.collect(self.thread)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["user_messages"], ["Upgrade rails to 8.1.0"])
        self.assertEqual(trace["main_tool_trace"][0]["result"]["result"], "7.0.8.7")
        self.assertEqual(trace["main_tool_trace"][1]["input"]["prompt"], "Exact handoff")
        self.assertEqual(trace["main_tool_trace"][1]["result"]["result"], "Raw plan")
        self.assertEqual(trace["final_response"], "Final plan")
        self.assertEqual(trace["request_sent_at"], "2026-10-12T10:00:00.250Z")
        self.assertEqual(trace["completed_at"], "2026-10-12T10:02:03.750Z")
        self.assertEqual(trace["wall_time_ms"], 123500)
        self.assertNotIn("excluded", json.dumps(trace))

    def test_rejects_incomplete_runs_without_writing_a_trace(self):
        working = copy.deepcopy(self.thread)
        working["meta"]["lastKnownAgentState"]["state"] = "running_tools"
        failed = copy.deepcopy(self.thread)
        failed["messages"][2]["content"][0]["run"]["status"] = "error"
        missing_result = copy.deepcopy(self.thread)
        missing_result["messages"][2]["content"].pop(0)
        no_final_response = copy.deepcopy(self.thread)
        no_final_response["messages"].pop()
        background_launch = copy.deepcopy(self.thread)
        background_launch["messages"][2]["content"][0]["run"]["result"] = (
            "Async agent launched successfully. The agent is working in the background."
        )
        terminated = copy.deepcopy(self.thread)
        terminated["messages"][2]["content"][0]["run"]["result"] = (
            "  Agent terminated early due to an API error: session limit (HTTP 429)\n"
            "Everything below is PARTIAL output. The agent did NOT finish its task.\n"
            "Preparing isolated databases."
        )
        parent_error = copy.deepcopy(self.thread)
        parent_error["messages"][-1]["content"][0]["text"] = (
            "Claude Code reported an error (success): You've hit your session limit"
        )
        for name, thread in [
            ("working", working), ("failed planner", failed),
            ("missing planner result", missing_result), ("progress only", no_final_response),
            ("background launch only", background_launch),
            ("terminated planner marked done", terminated), ("parent API error", parent_error),
        ]:
            with self.subTest(name=name):
                result, trace = self.collect(thread)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(trace)

    def test_collects_only_a_matching_completed_background_report_before_final_response(self):
        thread = copy.deepcopy(self.thread)
        thread["messages"][2]["content"][0]["run"]["result"] = (
            "Async agent launched successfully.\nagentId: planner-42"
        )
        thread["messages"][-1]["createdAt"] = "2026-10-12T10:02:02Z"
        background = [
            {"type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": "excluded background thinking"},
            ]}},
            {"type": "assistant", "agentId": "planner-42",
             "attributionAgent": "maintain-rails:gem-upgrade-planner",
             "timestamp": "2026-10-12T10:02:01Z", "private": "excluded background metadata",
             "message": {"stop_reason": "end_turn", "content": [
                 {"type": "text", "text": "Completed background plan"},
             ]}},
        ]
        result, trace = self.collect(thread, background)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["background_planner_report"]["text"], "Completed background plan")
        self.assertEqual(trace["background_planner_report"]["tool_use_id"], "planner")
        self.assertEqual(trace["wall_time_ms"], 123500)
        self.assertNotIn("excluded", json.dumps(trace))

        wrong_agent = copy.deepcopy(background)
        wrong_agent[-1]["agentId"] = "unrelated-agent"
        still_running = copy.deepcopy(background)
        still_running[-1]["message"]["stop_reason"] = "tool_use"
        premature_response = copy.deepcopy(thread)
        premature_response["messages"][-1]["createdAt"] = "2026-10-12T10:02:00Z"
        for name, source, transcript in [
            ("wrong agent", thread, wrong_agent), ("still running", thread, still_running),
            ("progress before completion", premature_response, background),
        ]:
            with self.subTest(name=name):
                result, trace = self.collect(source, transcript)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(trace)


if __name__ == "__main__":
    unittest.main()
