#!/usr/bin/env python3
"""Extract a completed visible planner trace from `amp threads export` JSON.

This collects evidence; it does not launch agents or grade their plans. Review
tool output for secrets before sharing the resulting file. Thinking blocks and
account/environment metadata are excluded, but tool inputs/results are retained.
"""

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re


def collect(thread, background_transcript=None):
    state = thread.get("meta", {}).get("lastKnownAgentState", {}).get("state")
    if state != "idle":
        raise ValueError(f"Thread is not idle: {state}")

    tools = []
    results = {}
    responses = []
    user_messages = []
    for message in thread["messages"]:
        texts = []
        for block in message["content"]:
            if block["type"] == "tool_use":
                tools.append({key: block[key] for key in ("id", "name", "input")})
            elif block["type"] == "tool_result":
                run = block["run"]
                results[block["toolUseID"]] = {
                    key: run[key] for key in ("status", "result") if key in run
                }
            elif block["type"] == "text":
                texts.append(block["text"])
        if texts and message["role"] == "assistant":
            responses.append("\n\n".join(texts))
        elif texts and message["role"] == "user":
            user_messages.append("\n\n".join(texts))

    for tool in tools:
        tool["result"] = results.get(tool["id"])
    planners = [
        tool for tool in tools
        if tool["name"] == "Agent"
        and tool["input"].get("subagent_type") == "maintain-rails:gem-upgrade-planner"
    ]
    if not planners or any(
        (tool["result"] or {}).get("status") != "done" for tool in planners
    ):
        raise ValueError("No completed gem-upgrade-planner invocation")
    if any(
        tool["result"].get("result", "").lstrip().startswith("Agent terminated early")
        for tool in planners
    ):
        raise ValueError("Planner terminated early; recovered output is incomplete")
    asynchronous = [tool for tool in planners if
        tool["result"].get("result", "").startswith("Async agent launched successfully.")
    ]
    background_report = None
    if asynchronous:
        if len(asynchronous) != 1 or background_transcript is None:
            raise ValueError("Planner launch acknowledgment is not a completed report")
        data = background_transcript.read_bytes()
        entries = [json.loads(line) for line in data.decode().splitlines() if line]
        assistant = [entry for entry in entries if entry.get("type") == "assistant"]
        completed = assistant[-1] if assistant else {}
        message = completed.get("message", {})
        agent_id = re.search(r"agentId: (\S+)", asynchronous[0]["result"]["result"])
        if (
            agent_id is None or completed.get("agentId") != agent_id.group(1)
            or completed.get("attributionAgent") != asynchronous[0]["input"]["subagent_type"]
            or message.get("stop_reason") != "end_turn"
            or not any(block["type"] == "text" for block in message.get("content", []))
        ):
            raise ValueError("No matching completed background planner report")
        background_report = {
            "tool_use_id": asynchronous[0]["id"],
            "text": "\n\n".join(block["text"] for block in message["content"] if block["type"] == "text"),
            "completed_at": completed["timestamp"],
            "source_sha256": hashlib.sha256(data).hexdigest(),
            "model": completed.get("requestedModel"),
            "effort": completed.get("perTurnEffort"),
            "cli_version": completed.get("version"),
        }
    last_message = thread["messages"][-1]
    if last_message["role"] != "assistant" or not any(
        block["type"] == "text" for block in last_message["content"]
    ):
        raise ValueError("No final assistant text")
    if responses[-1].lstrip().startswith("Claude Code reported an error"):
        raise ValueError("Parent error response is not a delivered plan")
    if background_report and (
        datetime.fromisoformat(last_message["createdAt"].replace("Z", "+00:00"))
        < datetime.fromisoformat(background_report["completed_at"].replace("Z", "+00:00"))
    ):
        raise ValueError("No final assistant response after background planner completion")

    started_at = thread["messages"][0].get("createdAt")
    completed_at = thread["meta"]["lastKnownAgentState"].get("updatedAt")
    wall_time_ms = None
    if started_at and completed_at:
        wall_time_ms = round((
            datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
            - datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        ).total_seconds() * 1000)

    return {
        "thread": f'https://ampcode.com/threads/{thread["id"]}',
        "state": state,
        "request_sent_at": started_at,
        "completed_at": completed_at,
        "wall_time_ms": wall_time_ms,
        "agent_mode": thread["agentMode"],
        "features": thread.get("meta", {}).get("features", []),
        "initial_repositories": [
            {key: tree["repository"][key] for key in ("ref", "sha", "url", "type")
             if key in tree["repository"]}
            for tree in thread.get("env", {}).get("initial", {}).get("trees", [])
            if "repository" in tree
        ],
        "user_messages": user_messages,
        "main_tool_trace": tools,
        "background_planner_report": background_report,
        "assistant_responses": responses,
        "final_response": responses[-1],
        "evidence_limits": [
            "Visible main-agent trace and planner hand-back, not nested experiment logs.",
            "Idle state and completed planner do not establish file or service-state preservation.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--background-transcript", type=Path)
    args = parser.parse_args()
    record = collect(json.loads(args.export.read_text()), args.background_transcript)
    args.output.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    print(f"Collected {len(record['main_tool_trace'])} tool calls: {args.output}")
