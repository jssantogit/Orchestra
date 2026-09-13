import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeUsageEvent,
  TOKEN_COUNTER_TYPES,
  CONFIDENCE_LEVELS,
} from "../../benchmarks/turn-economy/token-semantics.mjs";
import {
  analyzeAgyConversation,
  ROLES,
} from "../../benchmarks/turn-economy/turn-analysis.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");

test("token-semantics: normalizes valid Codex usage correctly", () => {
  const raw = {
    input_tokens: 25150,
    cached_input_tokens: 18944,
    cache_write_input_tokens: 0,
    output_tokens: 101,
    reasoning_output_tokens: 17,
  };

  const norm = normalizeUsageEvent(raw, "codex");
  assert.equal(norm.runtime, "codex");
  assert.equal(norm.status, "OK");
  assert.equal(norm.confidence, CONFIDENCE_LEVELS.HIGH);
  assert.equal(norm.inputTokens, 25150);
  assert.equal(norm.cachedInputTokens, 18944);
  assert.equal(norm.uncachedInputTokens, 6206);
  assert.equal(norm.uncachedSemantics, TOKEN_COUNTER_TYPES.DERIVED_COUNTER);
  assert.equal(norm.outputTokens, 101);
  assert.equal(norm.reasoningTokens, 17);
  assert.equal(norm.totalTokens, 25251);
  assert.equal(norm.classifications.inputTokens, TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER);
  assert.equal(norm.classifications.uncachedInputTokens, TOKEN_COUNTER_TYPES.DERIVED_COUNTER);
});

test("CRITICAL REGRESSION: rejects impossible token arithmetic and marks uncached as NOT_DERIVABLE (Task 3 values)", () => {
  // Task 3 real reported numbers
  const raw = {
    input_tokens: 166925,
    cache_read_tokens: 223111,
    output_tokens: 6311,
    thinking_tokens: 4001,
    total_tokens: 173236,
  };

  const norm = normalizeUsageEvent(raw, "antigravity");
  assert.equal(norm.runtime, "antigravity");
  assert.equal(norm.status, "OK");
  assert.equal(norm.confidence, CONFIDENCE_LEVELS.MEDIUM);
  assert.equal(norm.inputTokens, 166925);
  assert.equal(norm.cachedInputTokens, 223111);

  // Invariant check: uncached MUST NOT be negative and MUST NOT silently clamp to zero
  assert.notEqual(norm.uncachedInputTokens, 0, "uncachedInputTokens must not silently clamp to zero");
  assert.equal(norm.uncachedInputTokens, null, "uncachedInputTokens must be null when arithmetic is invalid");
  assert.equal(norm.uncachedSemantics, TOKEN_COUNTER_TYPES.NOT_DERIVABLE);
  assert.equal(norm.totalTokens, 173236);
});

test("token-semantics: handles null or empty usage gracefully", () => {
  const norm = normalizeUsageEvent(null, "antigravity");
  assert.equal(norm.status, TOKEN_COUNTER_TYPES.NOT_AVAILABLE);
  assert.equal(norm.inputTokens, null);
  assert.equal(norm.uncachedInputTokens, null);
  assert.equal(norm.uncachedSemantics, TOKEN_COUNTER_TYPES.NOT_AVAILABLE);
});

test("token-semantics: Codex impossible cached > input fails closed to NOT_DERIVABLE", () => {
  const raw = {
    input_tokens: 1000,
    cached_input_tokens: 2000,
    output_tokens: 50,
  };

  const norm = normalizeUsageEvent(raw, "codex");
  assert.equal(norm.uncachedInputTokens, null);
  assert.equal(norm.uncachedSemantics, TOKEN_COUNTER_TYPES.NOT_DERIVABLE);
  assert.equal(norm.confidence, CONFIDENCE_LEVELS.LOW);
});

test("turn-analysis: correctly attributes model turns, distributions, and roles", () => {
  const mockSteps = [
    { type: "USER_INPUT", source: "USER_EXPLICIT" },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 1,
      tool_calls: [
        { name: "view_file", args: { AbsolutePath: "/repo/src/parser.js", StartLine: 1, EndLine: 50 } },
        { name: "view_file", args: { AbsolutePath: "/repo/src/formatter.js", StartLine: 1, EndLine: 50 } },
      ],
    },
    { type: "GENERIC", source: "MODEL" },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 3,
      tool_calls: [
        { name: "replace_file_content", args: { TargetFile: "/repo/src/formatter.js" } },
      ],
    },
    { type: "GENERIC", source: "MODEL" },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 5,
      tool_calls: [
        { name: "run_command", args: { CommandLine: "npm test" } },
      ],
    },
    { type: "GENERIC", source: "MODEL" },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 7,
      tool_calls: [], // text completion turn
    },
  ];

  const analysis = analyzeAgyConversation(mockSteps, {});
  assert.equal(analysis.model_turns_total, 4);
  assert.equal(analysis.turns_with_zero_tools, 1);
  assert.equal(analysis.turns_with_one_tool, 2);
  assert.equal(analysis.turns_with_multiple_tools, 1);
  assert.equal(analysis.max_tools_in_single_turn, 2);
  assert.equal(analysis.multi_tool_same_turn_supported, true);
  assert.deepEqual(analysis.tool_calls_per_turn_distribution, {
    0: 1,
    1: 2,
    2: 1,
    "3+": 0,
  });

  // Pre vs post mutation
  assert.equal(analysis.pre_mutation_turns, 1); // 1 model turn before mutation turn (step 3)
  assert.equal(analysis.preMutationToolCalls, 2); // 2 view_file calls
  assert.equal(analysis.preMutationReadCalls, 2);
  assert.equal(analysis.preMutationSearchCalls, 0);
  assert.equal(analysis.preMutationValidationCalls, 0);
  assert.equal(analysis.post_mutation_turns, 2); // turn 3 (validation) and turn 4 (completion)
  assert.equal(analysis.validation_turns, 1);

  // Role attribution: no subagents -> all orchestrator
  assert.equal(analysis.role_invocations.orchestrator, 4);
  assert.equal(analysis.role_invocations.worker, 0);
});

test("turn-analysis: flags observational tool redundancies", () => {
  const mockSteps = [
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 1,
      tool_calls: [
        { name: "run_command", args: { CommandLine: "npm test" } }, // test before inspecting
      ],
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 3,
      tool_calls: [
        { name: "view_file", args: { AbsolutePath: "/repo/src/formatter.js", StartLine: 1, EndLine: 20 } },
      ],
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 5,
      tool_calls: [
        { name: "view_file", args: { AbsolutePath: "/repo/src/formatter.js" } }, // whole file read after targeted read
      ],
    },
  ];

  const analysis = analyzeAgyConversation(mockSteps, {});
  assert(analysis.potentiallyAvoidableToolCalls.length >= 2);
  const reasons = analysis.potentiallyAvoidableToolCalls.map(r => r.reason);
  assert(reasons.includes("test_run_before_inspecting_implementation"));
  assert(reasons.includes("whole_file_read_after_targeted_read"));
});

test("baseline: preserves backward compatibility with baseline-v1.json and summary.json", () => {
  const baselinePath = resolve(orchestraRoot, "benchmarks/turn-economy/results/baseline-v1.json");
  const hardenedPath = resolve(orchestraRoot, "benchmarks/turn-economy/results/hardened-baseline.json");

  assert(existsSync(baselinePath), "baseline-v1.json must exist");
  assert(existsSync(hardenedPath), "hardened-baseline.json must exist");

  const original = JSON.parse(readFileSync(baselinePath, "utf8"));
  const hardened = JSON.parse(readFileSync(hardenedPath, "utf8"));

  assert.equal(original.length, 6, "Must contain exactly 6 task runs");
  assert.equal(hardened.length, 6, "Must contain exactly 6 task runs");

  for (let i = 0; i < original.length; i++) {
    const orig = original[i];
    const hard = hardened[i];
    assert.equal(orig.task, hard.task);
    assert.equal(orig.runtime, hard.runtime);
    assert.equal(orig.model_invocations, hard.model_invocations);
    assert.equal(orig.tool_calls, hard.tool_calls);

    // Lineage preserved
    assert.equal(orig.input_tokens, hard.historical_raw.input_tokens);
    assert.equal(orig.output_tokens, hard.historical_raw.output_tokens);

    // If AGY Task 3, verify corrected derivation
    if (hard.runtime === "antigravity" && hard.task === "simple") {
      assert.equal(hard.uncached_input_tokens, null);
      assert.equal(hard.uncached_semantics, TOKEN_COUNTER_TYPES.NOT_DERIVABLE);
    }
  }
});

test("turn-analysis: enforces distribution invariant and tool count invariant", () => {
  const mockSteps = [
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 1,
      tool_calls: [{ name: "view_file" }, { name: "grep_search" }, { name: "find_by_name" }],
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 2,
      tool_calls: [{ name: "replace_file_content" }, { name: "run_command" }],
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 3,
      tool_calls: [{ name: "run_command" }],
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 4,
      tool_calls: [],
    },
  ];

  const analysis = analyzeAgyConversation(mockSteps, {});
  assert.equal(analysis.model_turns_total, 4);
  assert.equal(analysis.total_tool_calls, 6);

  // Distribution invariant: sum of bucket counts equals total model turns
  const dist = analysis.tool_calls_per_turn_distribution;
  const distSum = (dist[0] || 0) + (dist[1] || 0) + (dist[2] || 0) + (dist["3+"] || 0);
  assert.equal(distSum, analysis.model_turns_total, "Distribution sum must equal model_turns_total exactly");
  assert.equal(dist[0], 1);
  assert.equal(dist[1], 1);
  assert.equal(dist[2], 1);
  assert.equal(dist["3+"], 1);

  // Tool count invariant: sum of per-turn tool counts equals total tool calls
  assert.ok(Array.isArray(analysis.per_turn_tool_counts));
  const toolSum = analysis.per_turn_tool_counts.reduce((sum, c) => sum + c, 0);
  assert.equal(toolSum, analysis.total_tool_calls, "Per-turn tool count sum must equal total tool calls exactly");
  assert.deepEqual(analysis.per_turn_tool_counts, [3, 2, 1, 0]);
});
