#!/usr/bin/env python3
"""Price retained usage and generate per-run graph views from published results."""

import argparse
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics


def summary(values):
    values = [v for v in values if v is not None]
    if not values:
        return {"n": 0, "median": None, "min": None, "max": None,
                "mean": None, "sample_sd": None}
    return {"n": len(values), "median": statistics.median(values),
            "min": min(values), "max": max(values), "mean": statistics.mean(values),
            "sample_sd": statistics.stdev(values) if len(values) > 1 else None}


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def generate(root, views):
    spec = importlib.util.spec_from_file_location("pricing", Path(__file__).with_name("price-planner-usage.py"))
    pricing = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pricing)
    snapshot = Path(__file__).with_name("api-pricing-20261013.json")
    rates = json.loads(snapshot.read_text())
    rows = json.loads((root / "benchmark-outcomes.json").read_text())

    def cost_for(row, path):
        identity = {key: row[key] for key in ["configuration", "case", "run", "thread"]}
        if path.exists():
            result = pricing.estimate(json.loads(path.read_text()), rates)
            result.update(usage_file=str(path.relative_to(root)),
                          usage_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                          pricing_sha256=hashlib.sha256(snapshot.read_bytes()).hexdigest())
        else:
            result = {"estimate_usd": None, "lower_bound_usd": None,
                      "unique_requests": None, "recorded_tokens": {},
                      "components_usd": {}, "gaps": [{"reason": "Native usage unavailable"}]}
        return identity | result

    costs = [cost_for(row, root / row["configuration"] / "usage" / f"{row['case']}-{row['run']}.json")
             for row in rows]
    save(root / "benchmark-costs.json", costs)
    flat = []
    for row in costs:
        flat.append({key: row[key] for key in ["configuration", "case", "run", "thread",
                                             "estimate_usd", "lower_bound_usd", "unique_requests"]}
                    | row["recorded_tokens"] | {"gap_count": len(row["gaps"])})
    fields = list(dict.fromkeys(key for row in flat for key in row))
    with (root / "benchmark-costs.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    groups = []
    for configuration, case in dict.fromkeys((r["configuration"], r["case"]) for r in rows):
        selected = [r for r in rows if (r["configuration"], r["case"]) == (configuration, case)]
        selected_costs = [r for r in costs if (r["configuration"], r["case"]) == (configuration, case)]
        groups.append({"configuration": configuration, "case": case, "attempts": len(selected),
                       **{key: summary([r[key] for r in selected]) for key in
                          ["raw_actionable", "final_actionable", "response_wall_time_ms",
                           "successful_plan_wall_time_ms"]},
                       "reported_first_handback_tokens": summary([r["reported_planner_tokens"] for r in selected]),
                       "recorded_request_cost_usd": summary([r["estimate_usd"] for r in selected_costs]),
                       "cost_lower_bound_only_runs": sum(r["estimate_usd"] is None and r["lower_bound_usd"] is not None
                                                         for r in selected_costs),
                       "cost_unavailable_runs": sum(r["lower_bound_usd"] is None for r in selected_costs)})
    save(root / "benchmark-statistics.json", {
        "definition": "Descriptive statistics by case/configuration. Nulls excluded by n; sample_sd uses n-1. Response time includes workflow failures; finding accuracy is not overall correctness. Cost statistics include complete recorded-request list-price estimates only, excluding lower-bound-only runs, unlogged helpers and billing adjustments. Token footers are not workflow totals.",
        "groups": groups,
    })
    excluded = root / "quota-interrupted" / "opus-high-heldout"
    excluded_costs = []
    for trace in sorted([*excluded.glob("pagy-*.json"), *excluded.glob("faraday-*.json")]):
        case, run = trace.stem.split("-")
        row = {"configuration": "opus-5.5-high", "case": case, "run": int(run),
               "thread": json.loads(trace.read_text())["thread"]}
        excluded_costs.append(cost_for(row, excluded / "usage" / trace.name))
    if excluded_costs:
        save(excluded / "costs.json", excluded_costs)
    cases = ["rails", "sidekiq", "pagy", "faraday"]
    models = ["opus-5.5-high", "opus-5.5-low", "sonnet-5.5-medium", "haiku-5.5-medium"]
    data = []
    for row, cost in zip(rows, costs):
        flag = "F" if row["successful_plan_wall_time_ms"] is not None else (
            "U" if row["actual_model_verification"] != "native_metadata_verified" else "X")
        data.append([cases.index(row["case"]), models.index(row["configuration"]), row["run"],
                     row["final_actionable"], row["response_wall_time_ms"], flag,
                     cost["estimate_usd"], cost["lower_bound_usd"], cost["recorded_tokens"], row["thread"]])
    views.mkdir(parents=True, exist_ok=True)
    template = Path(__file__).with_name("planner-graphs.html").read_text()
    for metric in ["accuracy-time", "api-cost"]:
        (views / f"{metric}.html").write_text(template.replace("__DATA__", json.dumps(data))
                                           .replace("__METRIC__", json.dumps(metric)))
    print(f"{len(rows)} runs; {sum(r['estimate_usd'] is not None for r in costs)} recorded-request estimates; "
          f"{sum(r['estimate_usd'] is None and r['lower_bound_usd'] is not None for r in costs)} bounds; "
          f"{sum(r['lower_bound_usd'] is None for r in costs)} unavailable.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--views", type=Path, required=True)
    args = parser.parse_args()
    generate(args.results, args.views)
