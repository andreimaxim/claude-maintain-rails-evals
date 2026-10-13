#!/usr/bin/env python3
"""Estimate list-price cost of saved native requests, keeping missing usage explicit."""

import argparse
import hashlib
import json
from pathlib import Path


def estimate(evidence, pricing):
    components = {key: 0.0 for key in ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h", "web_search"]}
    counters = {key: 0 for key in ["input_tokens", "known_output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]}
    retained = {}
    gaps = []
    for scope in evidence["scopes"]:
        gaps.extend(scope.get("issues", []))
        for request in scope["requests"]:
            identifier = request["message_id"]
            previous = retained.get(identifier)
            # A copied start record must not hide final usage in another scope.
            # Among equivalent records, retain the latest native observation.
            rank = lambda r: (r.get("final_usage_record", False) and "output_tokens" in r["usage"],
                              r.get("last_timestamp", ""))
            if previous is None or rank(request) >= rank(previous):
                retained[identifier] = request
    requests = len(retained)
    for identifier, request in retained.items():
        usage = request["usage"]
        missing = {"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"} - usage.keys()
        if missing:
            gaps.append({"message_id": identifier, "reason": "Missing input/cache counters"})
        input_count = usage.get("input_tokens", 0)
        read_count = usage.get("cache_read_input_tokens", 0)
        write_count = usage.get("cache_creation_input_tokens", 0)
        output = 0
        if request.get("final_usage_record") and "output_tokens" in usage:
            # output_tokens already includes reasoning; never add thinking_tokens.
            output = usage["output_tokens"]
        else:
            gaps.append({"message_id": identifier, "reason": "Missing final output usage; placeholder excluded"})
        counters["input_tokens"] += input_count
        counters["known_output_tokens"] += output
        counters["cache_read_input_tokens"] += read_count
        counters["cache_creation_input_tokens"] += write_count
        tools = usage.get("server_tool_use", {})
        components["web_search"] += tools.get("web_search_requests", 0) * pricing["web_search_per_request"]
        if tools.get("code_execution_requests", 0):
            gaps.append({"message_id": identifier, "reason": "Code-execution duration/charges unavailable"})
        rates = pricing["models"].get(request["model"])
        if rates is None:
            gaps.append({"message_id": identifier, "reason": "Model has no retained price"})
            continue
        # Haiku's threshold applies to each prompt, including both cache categories.
        # Missing counters can only establish a lower bound on prompt length.
        prompt_length = input_count + read_count + write_count
        multiplier = 1
        if prompt_length > rates.get("long_context_threshold", float("inf")):
            multiplier *= rates["long_context_multiplier"]
        if usage.get("speed") == "fast":
            multiplier *= rates.get("fast_multiplier", 1)
            if "fast_multiplier" not in rates:
                gaps.append({"message_id": identifier, "reason": "Unknown fast-mode rate"})
        if usage.get("inference_geo") == "us":
            multiplier *= 1.1
        if usage.get("service_tier") == "batch":
            multiplier *= 0.5
        elif usage.get("service_tier") == "priority":
            gaps.append({"message_id": identifier, "reason": "Priority-tier rate not retained"})
        ttl = usage.get("cache_creation", {})
        short = ttl.get("ephemeral_5m_input_tokens", 0)
        long = ttl.get("ephemeral_1h_input_tokens", 0)
        if short + long != write_count:
            # The cheapest write rate supplies a bound, not an assumed TTL.
            short, long = write_count, 0
            gaps.append({"message_id": identifier, "reason": "Missing or inconsistent cache-write TTLs"})
        token_counts = {"input": input_count, "output": output, "cache_read": read_count,
                        "cache_write_5m": short, "cache_write_1h": long}
        for key, count in token_counts.items():
            components[key] += count * rates[key] * multiplier / 1_000_000
    if not requests:
        gaps.append({"reason": "No native requests recovered"})
    return {
        "schema": "planner-list-price-cost/v1", "unique_requests": requests,
        "request_start": evidence["request_start"], "evaluated_end": evidence["evaluated_end"],
        "estimate_usd": sum(components.values()) if not gaps else None,
        "lower_bound_usd": sum(components.values()) if requests else None,
        "components_usd": components, "recorded_tokens": counters, "gaps": gaps,
        "scope": "Public list-price estimate of recorded main/subagent requests, excluding unlogged helpers, collection turns, orb charges and billing adjustments.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pricing", type=Path, default=Path(__file__).with_name("api-pricing-20261013.json"))
    args = parser.parse_args()
    result = estimate(json.loads(args.evidence.read_text()), json.loads(args.pricing.read_text()))
    result["usage_sha256"] = hashlib.sha256(args.evidence.read_bytes()).hexdigest()
    result["pricing_sha256"] = hashlib.sha256(args.pricing.read_bytes()).hexdigest()
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"{result['unique_requests']} unique requests; estimate_usd={result['estimate_usd']}; "
          f"lower_bound_usd={result['lower_bound_usd']}; {len(result['gaps'])} gaps.")
