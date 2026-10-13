import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CollectPlannerUsageTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.source = root / "session.jsonl"
        self.output = root / "usage.json"
        self.start = "2026-10-12T10:00:00Z"
        self.end = "2026-10-12T10:02:00Z"
        self.record = {
            "type": "assistant", "timestamp": "2026-10-12T10:01:00Z",
            "version": "2.1.296", "requestedModel": "claude-opus-5-5", "perTurnEffort": "high",
            "message": {
                "id": "msg_original", "model": "claude-opus-5-5", "stop_reason": "tool_use",
                "content": [{"type": "thinking", "thinking": "DO NOT RETAIN"}],
                "usage": {
                    "input_tokens": 2, "output_tokens": 44, "cache_read_input_tokens": 101,
                    "cache_creation_input_tokens": 17,
                    "cache_creation": {"ephemeral_5m_input_tokens": 17, "ephemeral_1h_input_tokens": 0},
                    "output_tokens_details": {"thinking_tokens": 11},
                    "speed": "standard", "inference_geo": "global", "service_tier": "standard",
                    "private": "DO NOT RETAIN",
                },
            },
            "environment": "DO NOT RETAIN", "signature": "DO NOT RETAIN",
        }

    def run_collector(self, records):
        self.source.write_text("".join(json.dumps(r) + "\n" for r in records))
        result = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).with_name("collect-planner-usage.py")),
             str(self.source), str(self.output), "--start", self.start, "--end", self.end],
            capture_output=True, text=True,
        )
        return result, json.loads(self.output.read_text()) if self.output.exists() else None

    def test_retains_final_native_usage_once_and_excludes_followups_and_content(self):
        placeholder = copy.deepcopy(self.record)
        placeholder["message"]["stop_reason"] = None
        placeholder["message"]["usage"]["output_tokens"] = 3
        placeholder["message"]["usage"].pop("output_tokens_details")
        followup = copy.deepcopy(self.record)
        followup["timestamp"] = "2026-10-12T10:02:01Z"
        followup["message"]["id"] = "msg_followup"
        followup["message"]["usage"]["output_tokens"] = 999
        records = [placeholder, self.record, self.record, followup, {"type": "cost-state", "totalCostUSD": 42}]
        result, evidence = self.run_collector(records)
        self.assertEqual(result.returncode, 0, result.stderr)
        scope = evidence["scopes"][0]
        self.assertEqual(scope["excluded_later_records"], 2)
        self.assertEqual(scope["original_prefix_lines"], 3)
        original = "".join(json.dumps(r) + "\n" for r in records[:3]).encode()
        self.assertEqual(scope["original_prefix_sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(len(scope["requests"]), 1)
        request = scope["requests"][0]
        self.assertEqual(request["usage"]["output_tokens"], 44)
        self.assertEqual(request["usage"]["cache_read_input_tokens"], 101)
        self.assertEqual(request["usage"]["cache_creation"]["ephemeral_5m_input_tokens"], 17)
        self.assertEqual(len(request["usage_variants"]), 2)
        self.assertTrue(request["final_usage_record"])
        self.assertNotIn("DO NOT RETAIN", json.dumps(evidence))
        self.assertNotIn("msg_followup", json.dumps(evidence))
        self.assertNotIn("totalCostUSD", json.dumps(evidence))

    def test_collects_nested_requests_but_marks_missing_final_output(self):
        subagents = self.source.with_suffix("") / "subagents"
        subagents.mkdir(parents=True)
        child = copy.deepcopy(self.record)
        child["message"]["id"] = "msg_child"
        child["message"]["model"] = "claude-haiku-5-5"
        child["message"]["stop_reason"] = None
        child["message"]["usage"].pop("output_tokens_details")
        (subagents / "agent-child.jsonl").write_text(json.dumps(child) + "\n")
        late_child = copy.deepcopy(child)
        late_child["timestamp"] = "2026-10-12T10:03:00Z"
        (subagents / "agent-followup.jsonl").write_text(json.dumps(late_child) + "\n")
        result, evidence = self.run_collector([self.record])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(evidence["scopes"]), 2)
        request = evidence["scopes"][1]["requests"][0]
        self.assertEqual(request["message_id"], "msg_child")
        self.assertEqual(request["model"], "claude-haiku-5-5")
        self.assertFalse(request["final_usage_record"])

    def test_unidentified_child_retains_a_gap_not_a_complete_cost(self):
        subagents = self.source.with_suffix("") / "subagents"
        subagents.mkdir(parents=True)
        child = copy.deepcopy(self.record)
        child["message"].pop("id")
        (subagents / "agent-child.jsonl").write_text(json.dumps(child) + "\n")
        result, evidence = self.run_collector([self.record])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(evidence["scopes"]), 2)
        self.assertEqual(evidence["scopes"][1]["requests"], [])
        self.assertEqual(len(evidence["scopes"][1]["issues"]), 1)
        cost = self.output.with_name("cost.json")
        priced = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).with_name("price-planner-usage.py")),
             str(self.output), str(cost)], capture_output=True, text=True,
        )
        self.assertEqual(priced.returncode, 0, priced.stderr)
        result = json.loads(cost.read_text())
        self.assertEqual(result["unique_requests"], 1)
        self.assertIsNone(result["estimate_usd"])
        self.assertAlmostEqual(result["lower_bound_usd"], 0.0009932)

    def test_rejects_a_reversed_scored_boundary(self):
        self.start, self.end = self.end, self.start
        result, evidence = self.run_collector([self.record])
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(evidence)


if __name__ == "__main__":
    unittest.main()
