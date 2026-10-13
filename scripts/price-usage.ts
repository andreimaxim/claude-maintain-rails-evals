/**
 * Estimates the list-price cost of saved native requests, keeping missing usage explicit.
 *
 *   node scripts/price-usage.ts <usage.json> <cost.json> [--pricing <prices.json>]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Issue, NativeRequest, UsageEvidence } from "./collect-usage.ts";
import { sha256, writeJson } from "./files.ts";

export const DEFAULT_PRICING = fileURLToPath(new URL("../tests/api-pricing-20261013.json", import.meta.url));

interface ModelRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  fast_multiplier?: number;
  long_context_threshold?: number;
  long_context_multiplier?: number;
}

export interface Pricing {
  web_search_per_request: number;
  models: Record<string, ModelRates>;
}

const TOKEN_COMPONENTS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"] as const;
type Component = (typeof TOKEN_COMPONENTS)[number] | "web_search";

export interface CostEstimate {
  schema: "planner-list-price-cost/v1";
  unique_requests: number;
  request_start: string;
  evaluated_end: string;
  estimate_usd: number | null;
  lower_bound_usd: number | null;
  components_usd: Record<Component, number>;
  recorded_tokens: {
    input_tokens: number;
    known_output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  gaps: Issue[];
  scope: string;
}

const hasFinalOutput = (request: NativeRequest) =>
  request.final_usage_record && request.usage.output_tokens !== undefined;

/** A copied start record must not hide final usage; among equals, the latest wins. */
function supersedes(request: NativeRequest, previous: NativeRequest): boolean {
  if (hasFinalOutput(request) !== hasFinalOutput(previous)) return hasFinalOutput(request);
  return (request.last_timestamp ?? "") >= (previous.last_timestamp ?? "");
}

/** Keeps one record per message ID across the main and subagent scopes. */
function uniqueRequests(evidence: UsageEvidence): Map<string, NativeRequest> {
  const retained = new Map<string, NativeRequest>();
  for (const request of evidence.scopes.flatMap((scope) => scope.requests)) {
    const previous = retained.get(request.message_id);
    if (!previous || supersedes(request, previous)) retained.set(request.message_id, request);
  }
  return retained;
}

export function estimate(evidence: UsageEvidence, pricing: Pricing): CostEstimate {
  const components: Record<Component, number> = {
    input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, web_search: 0,
  };
  const tokens = {
    input_tokens: 0, known_output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  };
  const gaps: Issue[] = evidence.scopes.flatMap((scope) => scope.issues ?? []);
  const requests = uniqueRequests(evidence);

  for (const [id, request] of requests) {
    const gap = (reason: string) => gaps.push({ message_id: id, reason });
    const { usage } = request;
    if (usage.input_tokens === undefined || usage.cache_read_input_tokens === undefined
        || usage.cache_creation_input_tokens === undefined) {
      gap("Missing input/cache counters");
    }
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    // output_tokens already includes reasoning; never add thinking_tokens.
    let output = 0;
    if (hasFinalOutput(request)) output = usage.output_tokens!;
    else gap("Missing final output usage; placeholder excluded");
    tokens.input_tokens += input;
    tokens.known_output_tokens += output;
    tokens.cache_read_input_tokens += cacheRead;
    tokens.cache_creation_input_tokens += cacheWrite;

    const tools = usage.server_tool_use ?? {};
    components.web_search += (tools.web_search_requests ?? 0) * pricing.web_search_per_request;
    if (tools.code_execution_requests) gap("Code-execution duration/charges unavailable");

    const rates = request.model ? pricing.models[request.model] : undefined;
    if (!rates) {
      gap("Model has no retained price");
      continue;
    }
    // Haiku's threshold applies to each prompt, including both cache categories.
    // Missing counters can only establish a lower bound on prompt length.
    let multiplier = 1;
    if (input + cacheRead + cacheWrite > (rates.long_context_threshold ?? Infinity)) {
      multiplier *= rates.long_context_multiplier!;
    }
    if (usage.speed === "fast") {
      if (rates.fast_multiplier === undefined) gap("Unknown fast-mode rate");
      multiplier *= rates.fast_multiplier ?? 1;
    }
    if (usage.inference_geo === "us") multiplier *= 1.1;
    if (usage.service_tier === "batch") multiplier *= 0.5;
    else if (usage.service_tier === "priority") gap("Priority-tier rate not retained");

    let short = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    let long = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    if (short + long !== cacheWrite) {
      // The cheapest write rate supplies a bound, not an assumed TTL.
      [short, long] = [cacheWrite, 0];
      gap("Missing or inconsistent cache-write TTLs");
    }
    const counts = { input, output, cache_read: cacheRead, cache_write_5m: short, cache_write_1h: long };
    for (const component of TOKEN_COMPONENTS) {
      components[component] += counts[component] * rates[component] * multiplier / 1_000_000;
    }
  }

  if (requests.size === 0) gaps.push({ reason: "No native requests recovered" });
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return {
    schema: "planner-list-price-cost/v1",
    unique_requests: requests.size,
    request_start: evidence.request_start,
    evaluated_end: evidence.evaluated_end,
    estimate_usd: gaps.length === 0 ? total : null,
    lower_bound_usd: requests.size > 0 ? total : null,
    components_usd: components,
    recorded_tokens: tokens,
    gaps,
    scope: "Public list-price estimate of recorded main/subagent requests, excluding unlogged helpers, collection turns, orb charges and billing adjustments.",
  };
}

/** Prices a usage file and records the hashes of both inputs. */
export function estimateFile(usagePath: string, pricingPath = DEFAULT_PRICING) {
  const usage = readFileSync(usagePath);
  const pricing = readFileSync(pricingPath);
  return {
    ...estimate(JSON.parse(usage.toString("utf8")), JSON.parse(pricing.toString("utf8"))),
    usage_sha256: sha256(usage),
    pricing_sha256: sha256(pricing),
  };
}

if (import.meta.main) {
  const { positionals: [usagePath, output], values } = parseArgs({
    allowPositionals: true,
    options: { pricing: { type: "string", default: DEFAULT_PRICING } },
  });
  if (!usagePath || !output) throw new Error("Usage: price-usage.ts <usage.json> <cost.json>");
  const cost = estimateFile(usagePath, values.pricing);
  writeJson(output, cost);
  console.log(`${cost.unique_requests} unique requests; estimate_usd=${cost.estimate_usd}; `
    + `lower_bound_usd=${cost.lower_bound_usd}; ${cost.gaps.length} gaps.`);
}
