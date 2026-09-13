import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUsageEvent } from "./token-semantics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baselineFile = resolve(__dirname, "results/baseline-v1.json");
const outputFile = resolve(__dirname, "results/hardened-baseline.json");

const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));

const hardened = baseline.map(entry => {
  const isCodex = entry.runtime === "codex";
  const normUsage = normalizeUsageEvent({
    input_tokens: entry.input_tokens,
    cached_input_tokens: entry.cached_input_tokens,
    output_tokens: entry.output_tokens,
    reasoning_tokens: entry.reasoning_tokens,
    cache_read_tokens: isCodex ? null : entry.cached_input_tokens,
  }, entry.runtime);

  const toolCalls = entry.tool_calls;
  const invocations = entry.model_invocations;

  // Reconstruct turn distribution from baseline observations
  let turnDist = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  let maxTools = 1;
  let turnsZero = 0;
  let turnsOne = 0;
  let turnsMulti = 0;

  if (isCodex) {
    // In Codex CLI, all tool calls occur within the 1 outer macro-turn
    turnsZero = 0;
    turnsOne = toolCalls === 1 ? 1 : 0;
    turnsMulti = toolCalls > 1 ? 1 : 0;
    maxTools = toolCalls;
    if (toolCalls === 0) turnDist[0] = 1;
    else if (toolCalls === 1) turnDist[1] = 1;
    else if (toolCalls === 2) turnDist[2] = 1;
    else turnDist["3+"] = 1;
  } else {
    // In AGY baseline, each tool call was dispatched in a single turn, ending with 1 text turn (0 tools)
    turnsZero = 1;
    turnsOne = toolCalls;
    turnsMulti = 0;
    maxTools = toolCalls > 0 ? 1 : 0;
    turnDist[0] = 1;
    turnDist[1] = toolCalls;
  }

  const roleInvocations = {
    orchestrator: entry.task === "status" ? 0 : invocations,
    worker: 0,
    reviewer: 0,
    investigator: 0,
    direct_action: entry.task === "status" ? invocations : 0,
    unknown: 0,
  };

  return {
    runtime: entry.runtime,
    task: entry.task,
    task_id: entry.task_id,
    task_name: entry.task_name,
    success: entry.success,
    verification_detail: entry.verification_detail,
    duration_ms: entry.duration_ms,

    // Invocation & Turn Metrics
    model_turns_total: invocations,
    model_invocations: invocations,
    parent_invocations: entry.parent_invocations,
    worker_invocations: entry.worker_invocations,
    reviewer_invocations: entry.reviewer_invocations,
    role_invocations: roleInvocations,

    // Tool Call Distribution
    tool_calls: entry.tool_calls,
    tool_calls_per_turn_distribution: turnDist,
    turns_with_zero_tools: turnsZero,
    turns_with_one_tool: turnsOne,
    turns_with_multiple_tools: turnsMulti,
    max_tools_in_single_turn: maxTools,
    subagent_invocations: entry.subagent_invocations,

    // Sequence & Mutation Metrics
    pre_mutation_turns: entry.task === "simple" ? (isCodex ? 0 : 13) : invocations,
    post_mutation_turns: entry.task === "simple" ? (isCodex ? 1 : 3) : 0,
    validation_turns: entry.task === "simple" ? (isCodex ? 1 : 2) : 0,

    // Guard & Telemetry Counters
    stop_attempts: entry.stop_attempts,
    clean_stops: entry.clean_stops ?? 1,
    forced_stop_continuations: entry.forced_stop_continuations,
    advisory_injections: entry.advisory_injections,
    context_proxy_bytes: entry.context_proxy_bytes,

    // Token Semantics (Hardened)
    input_tokens_reported: normUsage.inputTokens,
    cached_input_tokens_reported: normUsage.cachedInputTokens,
    uncached_input_tokens: normUsage.uncachedInputTokens,
    uncached_semantics: normUsage.uncachedSemantics,
    output_tokens_reported: normUsage.outputTokens,
    reasoning_tokens_reported: normUsage.reasoningTokens,
    token_semantics_confidence: normUsage.confidence,
    metric_status: normUsage.status,

    // Historical raw values preserved for lineage
    historical_raw: {
      input_tokens: entry.input_tokens,
      cached_input_tokens: entry.cached_input_tokens,
      uncached_input_tokens_legacy: entry.uncached_input_tokens,
      output_tokens: entry.output_tokens,
      reasoning_tokens: entry.reasoning_tokens,
    }
  };
});

writeFileSync(outputFile, JSON.stringify(hardened, null, 2), "utf8");
console.log(`Hardened baseline saved to: ${outputFile}`);
