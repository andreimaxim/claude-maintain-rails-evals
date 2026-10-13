import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class PricePlannerUsageTest(unittest.TestCase):
    def setUp(self):
        self.request = {
            "message_id": "msg_main", "model": "claude-opus-5-5",
            "final_usage_record": True,
            "usage": {
                "input_tokens": 1000, "output_tokens": 500,
                "cache_read_input_tokens": 2000, "cache_creation_input_tokens": 7000,
                "cache_creation": {"ephemeral_5m_input_tokens": 3000,
                                   "ephemeral_1h_input_tokens": 4000},
                "output_tokens_details": {"thinking_tokens": 200},
            },
        }

    def price(self, requests, other_requests=(), issues=()):
        evidence = {
            "schema": "planner-native-usage/v1",
            "request_start": "2026-10-12T10:00:00Z",
            "evaluated_end": "2026-10-12T10:02:00Z",
            "scopes": [{"requests": requests, "issues": list(issues)},
                       {"requests": list(other_requests), "issues": []}],
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "usage.json"
            output = Path(directory) / "cost.json"
            source.write_text(json.dumps(evidence))
            script = Path(__file__).with_name("price-planner-usage.py")
            result = subprocess.run(
                [sys.executable, "-B", str(script), str(source), str(output)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            cost = json.loads(output.read_text())
            self.assertEqual(cost["usage_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(cost["pricing_sha256"], hashlib.sha256(
                script.with_name("api-pricing-20261013.json").read_bytes()).hexdigest())
            self.assertEqual(cost["request_start"], evidence["request_start"])
            self.assertEqual(cost["evaluated_end"], evidence["evaluated_end"])
            return cost

    def test_mixed_ttls_reasoning_and_duplicate_ids(self):
        cost = self.price([self.request], [self.request, self.request])
        self.assertEqual(cost["unique_requests"], 1)
        self.assertEqual(cost["recorded_tokens"]["known_output_tokens"], 500)
        self.assertAlmostEqual(cost["components_usd"]["cache_write_5m"], 0.015)
        self.assertAlmostEqual(cost["components_usd"]["cache_write_1h"], 0.032)
        self.assertAlmostEqual(cost["components_usd"]["output"], 0.01)
        self.assertAlmostEqual(cost["estimate_usd"], 0.0614)
        self.assertAlmostEqual(cost["lower_bound_usd"], 0.0614)
        self.assertEqual(cost["gaps"], [])

    def test_final_duplicate_supersedes_placeholder_in_either_scope_order(self):
        placeholder = copy.deepcopy(self.request)
        placeholder["final_usage_record"] = False
        placeholder["usage"]["output_tokens"] = 3
        for first, second in [(placeholder, self.request), (self.request, placeholder)]:
            with self.subTest(first_final=first["final_usage_record"]):
                cost = self.price([first], [second])
                self.assertEqual(cost["unique_requests"], 1)
                self.assertAlmostEqual(cost["estimate_usd"], 0.0614)

    def test_haiku_threshold_includes_both_cache_categories_per_request(self):
        for prompt_length, expected in [(99999, 0.00278999), (100000, 0.00279),
                                        (100001, 0.01395005)]:
            request = copy.deepcopy(self.request)
            request["model"] = "claude-haiku-5-5"
            request["usage"].update({
                "input_tokens": 1000, "output_tokens": 200,
                "cache_read_input_tokens": prompt_length - 11000,
                "cache_creation_input_tokens": 10000,
                "cache_creation": {"ephemeral_5m_input_tokens": 4000,
                                   "ephemeral_1h_input_tokens": 6000},
            })
            with self.subTest(prompt_length=prompt_length):
                self.assertAlmostEqual(self.price([request])["estimate_usd"], expected)
        requests = []
        for identifier in ["msg_main", "msg_child"]:
            request = copy.deepcopy(self.request)
            request.update(message_id=identifier, model="claude-haiku-5-5")
            request["usage"].update(input_tokens=60000, output_tokens=200,
                                    cache_read_input_tokens=0, cache_creation_input_tokens=0,
                                    cache_creation={})
            requests.append(request)
        self.assertAlmostEqual(self.price(requests[:1], requests[1:])["estimate_usd"], 0.0122)

    def test_modifiers_stack_on_tokens_not_web_search(self):
        for modifiers, expected in [({"speed": "fast", "inference_geo": "us"}, 0.15508),
                                    ({"service_tier": "batch", "inference_geo": "us"}, 0.05377)]:
            request = copy.deepcopy(self.request)
            request["usage"].update(modifiers)
            request["usage"]["server_tool_use"] = {"web_search_requests": 2, "web_fetch_requests": 1}
            with self.subTest(modifiers=modifiers):
                cost = self.price([request])
                self.assertAlmostEqual(cost["estimate_usd"], expected)
                self.assertEqual(cost["components_usd"]["web_search"], 0.02)

    def test_missing_output_never_bills_placeholder_or_thinking(self):
        for final, output in [(False, 3), (True, None)]:
            request = copy.deepcopy(self.request)
            request["final_usage_record"] = final
            if output is None:
                request["usage"].pop("output_tokens")
            else:
                request["usage"]["output_tokens"] = output
            with self.subTest(final=final):
                cost = self.price([request])
                self.assertIsNone(cost["estimate_usd"])
                self.assertAlmostEqual(cost["lower_bound_usd"], 0.0514)
                self.assertEqual(cost["recorded_tokens"]["known_output_tokens"], 0)
                self.assertTrue(cost["gaps"])

    def test_missing_or_inconsistent_ttl_is_only_a_cheapest_write_bound(self):
        for ttl in [None, {"ephemeral_5m_input_tokens": 3000, "ephemeral_1h_input_tokens": 3999}]:
            request = copy.deepcopy(self.request)
            if ttl is None:
                request["usage"].pop("cache_creation")
            else:
                request["usage"]["cache_creation"] = ttl
            with self.subTest(ttl=ttl):
                cost = self.price([request])
                self.assertIsNone(cost["estimate_usd"])
                self.assertAlmostEqual(cost["lower_bound_usd"], 0.0494)
                self.assertTrue(cost["gaps"])

    def test_missing_input_counter_and_scope_issues_leave_partial_bounds(self):
        request = copy.deepcopy(self.request)
        request["usage"].pop("cache_read_input_tokens")
        cost = self.price([request])
        self.assertIsNone(cost["estimate_usd"])
        self.assertAlmostEqual(cost["lower_bound_usd"], 0.061)
        cost = self.price([self.request], issues=[{"reason": "Native message ID missing"}])
        self.assertIsNone(cost["estimate_usd"])
        self.assertAlmostEqual(cost["lower_bound_usd"], 0.0614)

    def test_unknown_model_retains_known_tool_costs_and_token_evidence(self):
        request = copy.deepcopy(self.request)
        request["model"] = "claude-unpriced"
        request["usage"]["server_tool_use"] = {"web_search_requests": 2}
        cost = self.price([request])
        self.assertIsNone(cost["estimate_usd"])
        self.assertEqual(cost["lower_bound_usd"], 0.02)
        self.assertEqual(cost["recorded_tokens"]["known_output_tokens"], 500)

    def test_no_requests_has_no_estimate_or_bound(self):
        cost = self.price([])
        self.assertIsNone(cost["estimate_usd"])
        self.assertIsNone(cost["lower_bound_usd"])
        self.assertTrue(cost["gaps"])


if __name__ == "__main__":
    unittest.main()
