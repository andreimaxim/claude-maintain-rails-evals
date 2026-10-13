#!/usr/bin/env python3
"""Retain usage-only native transcript evidence inside a scored time boundary.

Run after evaluation. This does not launch Claude, resume agents or expose content.
Native final usage differs from the Agent SDK's message-start placeholders.
"""

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re


COUNTERS = {
    "input_tokens", "output_tokens", "cache_read_input_tokens",
    "cache_creation_input_tokens",
}
NESTED_COUNTERS = {
    "cache_creation": {"ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"},
    "output_tokens_details": {"thinking_tokens"},
    "server_tool_use": {"web_search_requests", "web_fetch_requests", "code_execution_requests"},
}
MODIFIERS = {
    "service_tier": {"standard", "batch", "priority"},
    "speed": {"standard", "fast"},
    "inference_geo": {"global", "us"},
}


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def usage_only(value):
    if not isinstance(value, dict):
        return {}
    clean = {k: v for k, v in value.items() if k in COUNTERS and type(v) is int and v >= 0}
    for key, allowed in NESTED_COUNTERS.items():
        if isinstance(value.get(key), dict):
            clean[key] = {k: v for k, v in value[key].items()
                          if k in allowed and type(v) is int and v >= 0}
    for key, allowed in MODIFIERS.items():
        if isinstance(value.get(key), str) and value[key] in allowed:
            clean[key] = value[key]
    return clean


def collect_source(path, start, end):
    raw_lines = path.read_bytes().splitlines(keepends=True)
    original_lines = []
    messages = {}
    issues = []
    inventory = {}
    excluded = 0
    past_boundary = False
    versions = set()
    for line_number, raw in enumerate(raw_lines, 1):
        record = json.loads(raw)
        time = record.get("timestamp")
        if time and timestamp(time) > end:
            past_boundary = True
        if past_boundary:
            excluded += 1
            continue
        original_lines.append(raw)
        kind = record.get("type", "unknown")
        inventory[kind] = inventory.get(kind, 0) + 1
        if kind != "assistant":
            continue
        if not time:
            issues.append({"line": line_number, "reason": "Assistant timestamp missing"})
            continue
        if timestamp(time) < start:
            continue
        message = record.get("message", {})
        identifier = message.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"msg_[A-Za-z0-9_-]+", identifier):
            issues.append({"line": line_number, "reason": "Native message ID missing or unsupported"})
            continue
        model = message.get("model")
        if not isinstance(model, str) or not re.fullmatch(r"claude-[a-z0-9.-]+", model):
            model = None
        version = record.get("version")
        if isinstance(version, str) and re.fullmatch(r"[0-9.]+", version):
            versions.add(version)
        usage = usage_only(message.get("usage"))
        # Final native records add stop_reason and output details after streaming.
        # Earlier records can carry only the initial output-token placeholder.
        final_usage = (message.get("stop_reason") in {
            "end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal",
        } and "output_tokens_details" in usage and COUNTERS <= usage.keys())
        if identifier not in messages:
            messages[identifier] = {
                "message_id": identifier, "model": model,
                "first_timestamp": time, "source_lines": [], "usage_variants": [],
            }
        entry = messages[identifier]
        requested_model = record.get("requestedModel")
        if isinstance(requested_model, str) and re.fullmatch(r"claude-[a-z0-9.-]+", requested_model):
            entry["requested_model"] = requested_model
        if record.get("perTurnEffort") in {"low", "medium", "high", "xhigh", "max"}:
            entry["per_turn_effort"] = record["perTurnEffort"]
        entry["last_timestamp"] = time
        entry["source_lines"].append(line_number)
        if not entry["usage_variants"] or entry["usage_variants"][-1] != usage:
            entry["usage_variants"].append(usage)
        entry["usage"] = usage
        entry["final_usage_record"] = final_usage
        if final_usage:
            entry["stop_reason"] = message["stop_reason"]
    return {
        "source_path": str(path),
        "original_prefix_sha256": hashlib.sha256(b"".join(original_lines)).hexdigest(),
        "original_prefix_lines": len(original_lines), "excluded_later_records": excluded,
        "original_record_types": inventory, "cli_versions": sorted(versions),
        "requests": list(messages.values()), "issues": issues,
    }


def collect(session_file, start, end, extra_subagents=()):
    start_time, end_time = timestamp(start), timestamp(end)
    if start_time > end_time:
        raise ValueError("The scored time boundary is reversed")
    subagents = session_file.with_suffix("") / "subagents"
    paths = sorted(set(subagents.rglob("*.jsonl")) | set(extra_subagents))
    scopes = [collect_source(session_file, start_time, end_time)]
    for path in paths:
        scope = collect_source(path, start_time, end_time)
        if scope["requests"] or scope["issues"]:
            scopes.append(scope)
    return {
        "schema": "planner-native-usage/v1", "request_start": start, "evaluated_end": end,
        "session_id": session_file.stem, "scopes": scopes,
        "scope_note": "Recorded main and subagent requests only; unlogged helper calls and billing adjustments are not included.",
        "output_note": "Use the last native record per message ID. A missing final-usage record cannot supply a reliable output total.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_file", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--subagent-file", type=Path, action="append", default=[])
    args = parser.parse_args()
    result = collect(args.session_file, args.start, args.end, args.subagent_file)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    requests = [request for scope in result["scopes"] for request in scope["requests"]]
    print(f"Saved {len(requests)} unique native requests in {len(result['scopes'])} scopes; "
          f"{sum(not r['final_usage_record'] for r in requests)} lack final usage.")
