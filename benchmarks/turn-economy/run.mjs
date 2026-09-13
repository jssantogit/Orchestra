#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { normalizeUsageEvent, TOKEN_COUNTER_TYPES, CONFIDENCE_LEVELS } from "./token-semantics.mjs";
import { evaluateTaskFidelity, TASK_FIDELITY_REQUIREMENTS } from "./fidelity.mjs";
import { isControlPlanePath } from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");
const fixtureSource = resolve(orchestraRoot, "benchmarks/turn-economy/fixture");
const rawDataDir = resolve(orchestraRoot, "benchmarks/turn-economy/raw");
const resultsDir = resolve(orchestraRoot, "benchmarks/turn-economy/results");
const summaryFile = resolve(resultsDir, "summary.json");

const TASKS = {
  status: {
    id: "task-1-status",
    name: "TASK 1 — DIRECT STATUS",
    prompt: "Show the current git status concisely. Do not modify anything.",
    setup(dir) {},
    verify(dir, stdout) {
      // 1. Working tree must remain strictly clean
      const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
      if (gitStatus.length > 0) {
        return { success: false, reason: `Working directory not clean: ${gitStatus}` };
      }
      return { success: true };
    },
  },
  lookup: {
    id: "task-2-lookup",
    name: "TASK 2 — TARGETED LOOKUP",
    prompt: "Find where numeric input validation is implemented and tell me what values are rejected. Do not modify anything.",
    setup(dir) {},
    verify(dir, stdout) {
      // Working tree must remain clean
      const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
      if (gitStatus.length > 0) {
        return { success: false, reason: `Working directory not clean: ${gitStatus}` };
      }
      const lower = String(stdout || "").toLowerCase();
      const mentionsParser = lower.includes("parser") || lower.includes("validatenumericinput");
      const mentionsRejected = lower.includes("nan") || lower.includes("infinity") || lower.includes("empty") || lower.includes("string");
      if (!mentionsParser) {
        return { success: false, reason: "Response does not identify parser.js or validateNumericInput" };
      }
      return { success: true, detail: mentionsRejected ? "Complete lookup" : "Partial lookup" };
    },
  },
  simple: {
    id: "task-3-simple",
    name: "TASK 3 — SIMPLE IMPLEMENTATION",
    prompt: "Fix the formatter bug where negative values lose their sign. Add or update the focused test and validate the change.",
    setup(dir) {},
    verify(dir) {
      // 1. Tests must pass
      try {
        execFileSync("node", ["--test", "test/formatter.test.js"], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: "test/formatter.test.js failed" };
      }
      // 2. Direct verification of behavior
      try {
        const testCode = `
          import assert from "node:assert/strict";
          import { formatNumber } from "./src/formatter.js";
          assert.equal(formatNumber(-42), "-42");
          assert.equal(formatNumber(-12.5), "-12.5");
        `;
        execFileSync("node", ["--input-type=module", "-e", testCode], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: "Negative numbers still do not format with negative sign" };
      }
      return { success: true };
    },
  },
  multi: {
    id: "task-4-multi",
    name: "TASK 4 — NORMAL MULTI-FILE IMPLEMENTATION",
    prompt: "Add support for an optional precision argument to number formatting. Keep the existing default behavior unchanged, update the parser/formatter boundary as needed, and add focused tests.",
    setup(dir) {},
    verify(dir) {
      // 1. Run all tests
      try {
        execFileSync("node", ["--test", "test/calculator.test.js", "test/parser.test.js", "test/formatter.test.js"], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: "Fixture test suite failed" };
      }
      // 2. Verify precision argument
      try {
        const testCode = `
          import assert from "node:assert/strict";
          import { formatNumber } from "./src/formatter.js";
          assert.equal(formatNumber(3.14159, { precision: 2 }), "3.14");
          assert.equal(formatNumber(10, { precision: 3 }), "10.000");
        `;
        execFileSync("node", ["--input-type=module", "-e", testCode], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: "Precision argument verification failed" };
      }
      return { success: true };
    },
  },
  investigation: {
    id: "task-5-investigation",
    name: "TASK 5 — INVESTIGATION",
    prompt: "A test around parsed percentage values is failing intermittently. Investigate the root cause, identify the smallest correct fix, implement it, and validate the affected behavior.",
    setup(dir) {
      // Seed the failing test into test/parser.test.js
      const parserTestPath = join(dir, "test/parser.test.js");
      const current = readFileSync(parserTestPath, "utf8");
      const addition = `
test("parser: parses decimal percentage values", () => {
  assert.equal(parsePercentage("12.5%"), 0.125);
  assert.equal(parsePercentage("99.9%"), 0.999);
});
`;
      writeFileSync(parserTestPath, current + addition, "utf8");
      // Commit the seeded test so it's part of the repo state
      execFileSync("git", ["add", "test/parser.test.js"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "test: add failing decimal percentage test"], { cwd: dir, stdio: "ignore" });
    },
    verify(dir) {
      try {
        execFileSync("node", ["--test", "test/parser.test.js"], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: "test/parser.test.js still failing" };
      }
      return { success: true };
    },
  },
  critical: {
    id: "task-6-critical",
    name: "TASK 6 — CRITICAL REVIEW",
    prompt: "CRITICAL: Perform an independent Two-Key critical review of the input validation boundary in src/parser.js. Ensure strict containment against unexpected prototype keys, non-finite values, and malformed inputs.",
    setup(dir) {},
    verify(dir, stdout) {
      const lower = String(stdout || "").toLowerCase();
      const hasReview = lower.includes("review") || lower.includes("verdict") || lower.includes("accept");
      return { success: hasReview };
    },
  },
};

/**
 * Creates an isolated temp repository with initialized Git and clean commit.
 */
function createFreshEnvironment(taskKey) {
  const tempProject = mkdtempSync(join(tmpdir(), `orch-turn-econ-${taskKey}-`));
  cpSync(fixtureSource, tempProject, { recursive: true });

  // Initialize git repository
  execFileSync("git", ["init", "-b", "main"], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Benchmark Runner"], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "benchmark@orchestra.local"], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial benchmark fixture commit"], { cwd: tempProject, stdio: "ignore" });

  const taskDef = TASKS[taskKey];
  if (taskDef && typeof taskDef.setup === "function") {
    taskDef.setup(tempProject);
  }

  return tempProject;
}

/**
 * Installs specified runtime into temp directory.
 */
function installRuntime(targetDir, runtime) {
  if (runtime === "codex") {
    const installScript = join(orchestraRoot, "scripts/install-codex.mjs");
    execFileSync(process.execPath, [installScript, targetDir], { stdio: "ignore" });
  } else if (runtime === "antigravity") {
    const installScript = join(orchestraRoot, "scripts/install-antigravity.mjs");
    execFileSync(process.execPath, [installScript, targetDir], { stdio: "ignore" });
  } else {
    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  // Commit runtime configuration so working tree is clean before task starts
  execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "ignore" });
  try {
    execFileSync("git", ["commit", "--allow-empty", "-m", `chore: install ${runtime} runtime`], { cwd: targetDir, stdio: "ignore" });
  } catch {}
}

/**
 * Parses Codex JSONL stream for token counts, tool calls, and duration.
 */
function parseCodexJsonl(rawOutput) {
  const lines = rawOutput.split("\n").filter(l => l.trim().length > 0);
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let toolCalls = 0;
  let subagentCalls = 0;
  let modelInvocations = 0;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // Turn / Invocation counts
      if (ev.type === "turn.started" || ev.type === "turn_start" || ev.type === "model_call") {
        modelInvocations++;
      }
      if (ev.type === "item.started" && (ev.item?.type === "command_execution" || ev.item?.type === "tool_call" || ev.item?.type === "dynamic_tool_call")) {
        toolCalls++;
      }
      if (ev.type === "item.started" && ev.item?.type === "spawn_agent") {
        subagentCalls++;
      }

      // Check for usage object
      const usage = ev.usage || ev.token_usage || (ev.type === "usage" ? ev : null);
      if (usage) {
        if (typeof usage.input_tokens === "number") inputTokens = Math.max(inputTokens, usage.input_tokens);
        if (typeof usage.cached_input_tokens === "number") cachedInputTokens = Math.max(cachedInputTokens, usage.cached_input_tokens);
        if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
        if (typeof usage.reasoning_output_tokens === "number") reasoningTokens += usage.reasoning_output_tokens;
      }
    } catch {}
  }

  // If top-level invocations weren't counted from explicit events, default to minimum 1
  if (modelInvocations === 0 && lines.length > 0) {
    modelInvocations = 1;
  }

  const normUsage = normalizeUsageEvent({
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningTokens,
  }, "codex");

  return {
    model_turns_total: modelInvocations,
    model_invocations: modelInvocations,
    parent_invocations: modelInvocations - subagentCalls,
    worker_invocations: subagentCalls,
    reviewer_invocations: 0,
    tool_calls: toolCalls,
    tool_calls_per_turn_distribution: {
      0: toolCalls === 0 ? 1 : 0,
      1: toolCalls === 1 ? 1 : 0,
      2: toolCalls === 2 ? 1 : 0,
      "3+": toolCalls >= 3 ? 1 : 0,
    },
    turns_with_zero_tools: toolCalls === 0 ? 1 : 0,
    turns_with_one_tool: toolCalls === 1 ? 1 : 0,
    turns_with_multiple_tools: toolCalls > 1 ? 1 : 0,
    max_tools_in_single_turn: toolCalls,
    subagent_invocations: subagentCalls,
    manage_subagent_calls: 0,
    stop_attempts: 1,
    forced_stop_continuations: 0,
    advisory_injections: 0,
    worker_packet_bytes: 0,
    context_proxy_bytes: 0,
    input_tokens: normUsage.inputTokens,
    cached_input_tokens: normUsage.cachedInputTokens,
    uncached_input_tokens: normUsage.uncachedInputTokens,
    uncached_semantics: normUsage.uncachedSemantics,
    output_tokens: normUsage.outputTokens,
    reasoning_tokens: normUsage.reasoningTokens,
    token_semantics_confidence: normUsage.confidence,
    metric_status: normUsage.status,
  };
}

function parseTranscriptTurns(transcriptPath) {
  if (!existsSync(transcriptPath)) return null;
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    const turns = [];
    lines.forEach((l, idx) => {
      try {
        const ev = JSON.parse(l);
        if (ev.type === "PLANNER_RESPONSE") {
          const tools = (ev.tool_calls || []).map((tc) => ({
            name: tc.name || "",
            args: tc.args || tc.parameters || {},
          }));
          turns.push({
            turnIndex: turns.length + 1,
            lineIndex: idx,
            toolCount: tools.length,
            tools,
          });
        }
      } catch {}
    });
    return turns;
  } catch {
    return null;
  }
}

function calculateDistribution(turns = []) {
  const dist = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  let maxTools = 0;
  let totalTools = 0;
  for (const t of turns) {
    totalTools += t.toolCount;
    if (t.toolCount > maxTools) maxTools = t.toolCount;
    if (t.toolCount === 0) dist[0]++;
    else if (t.toolCount === 1) dist[1]++;
    else if (t.toolCount === 2) dist[2]++;
    else dist["3+"]++;
  }
  return {
    distribution: dist,
    max_tools_in_single_turn: maxTools,
    total_tool_calls: totalTools,
    turns_with_zero_tools: dist[0],
    turns_with_one_tool: dist[1],
    turns_with_multiple_tools: dist[2] + dist["3+"],
  };
}

/**
 * Parses AGY telemetry from .agents/state/active-state.json, events.jsonl, and agy JSON output.
 */
function parseAgyTelemetry(targetDir, rawOutput) {
  const stateFile = join(targetDir, ".agents/state/active-state.json");
  const telemetryFile = join(targetDir, ".agents/telemetry/events.jsonl");

  let state = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {}
  }

  // Check if agy exposed live usage in JSON output
  let agyUsage = null;
  let convId = null;
  try {
    const trimmed = rawOutput.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*"usage"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.usage) agyUsage = parsed.usage;
      if (parsed.conversation_id) convId = parsed.conversation_id;
    }
  } catch {}

  if (!convId && state.conversationId) convId = state.conversationId;

  // Inspect transcripts from brain directory if available
  let parentTurns = null;
  const workerTurns = [];
  const reviewerTurns = [];

  if (convId) {
    const brainDir = join(homedir(), ".gemini/antigravity-cli/brain", convId);
    const parentTranscriptFile = join(brainDir, ".system_generated/logs/transcript.jsonl");
    if (existsSync(parentTranscriptFile)) {
      parentTurns = parseTranscriptTurns(parentTranscriptFile);
    }
    const subagentsDir = join(brainDir, ".system_generated/subagents");
    if (existsSync(subagentsDir)) {
      try {
        const files = readdirSync(subagentsDir);
        for (const f of files) {
          if (f.endsWith(".json")) {
            const sub = JSON.parse(readFileSync(join(subagentsDir, f), "utf8"));
            if (sub.conversationId) {
              const childTranscriptFile = join(
                homedir(),
                ".gemini/antigravity-cli/brain",
                sub.conversationId,
                ".system_generated/logs/transcript.jsonl"
              );
              const childTurns = parseTranscriptTurns(childTranscriptFile);
              if (childTurns) {
                const role = String(
                  sub.subagentDescriptor?.role || sub.subagentDescriptor?.typeName || ""
                ).toLowerCase();
                if (role.includes("reviewer")) {
                  reviewerTurns.push(...childTurns);
                } else {
                  workerTurns.push(...childTurns);
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  const parentMetrics = parentTurns ? calculateDistribution(parentTurns) : null;
  const workerMetrics = workerTurns.length > 0 ? calculateDistribution(workerTurns) : null;
  const reviewerMetrics = reviewerTurns.length > 0 ? calculateDistribution(reviewerTurns) : null;

  const parentModelTurns = parentTurns
    ? parentTurns.length
    : Math.max(
        0,
        (state.model_invocations || state.preinvocation_count || 1) -
          (state.worker_invocations || 0) -
          (state.reviewer_invocations || 0)
      );
  const workerModelTurns = workerTurns.length > 0 ? workerTurns.length : (state.worker_invocations || 0);
  const reviewerModelTurns = reviewerTurns.length > 0 ? reviewerTurns.length : (state.reviewer_invocations || 0);
  const totalModelTurns = parentModelTurns + workerModelTurns + reviewerModelTurns;

  const parentToolCalls = parentMetrics
    ? parentMetrics.total_tool_calls
    : (state.tool_calls_total || state.tool_calls || 0);
  const workerToolCalls = workerMetrics ? workerMetrics.total_tool_calls : 0;
  const reviewerToolCalls = reviewerMetrics ? reviewerMetrics.total_tool_calls : 0;
  const totalToolCalls = parentToolCalls + workerToolCalls + reviewerToolCalls;

  // Breakdown stages
  let parentPreDelegationTurns = 0;
  let parentPostHandoffTurns = 0;
  let seenDelegation = false;
  let bookkeepingModelTurns = 0;
  const turnClassifications = [];

  if (parentTurns) {
    parentTurns.forEach((t) => {
      const hasDelegation = t.tools.some((tc) => tc.name === "invoke_subagent");
      if (!seenDelegation) {
        parentPreDelegationTurns++;
        if (hasDelegation) seenDelegation = true;
      } else {
        parentPostHandoffTurns++;
      }

      let classification = "FINAL";
      if (t.tools.length > 0) {
        if (hasDelegation) classification = "DELEGATION";
        else if (t.tools.some((tc) => tc.name === "define_subagent")) classification = "SCOPE";
        else if (t.tools.some((tc) => tc.name === "manage_subagents" || tc.name === "manage_task"))
          classification = "WAIT/POLL";
        else if (t.tools.some((tc) => tc.name === "replace_file_content" || tc.name === "write_to_file")) {
          const isCP = t.tools.every((tc) => {
            const p = tc.args?.TargetFile || tc.args?.targetFile || "";
            return p.includes(".agents");
          });
          classification = isCP ? "BOOKKEEPING" : "MUTATION";
          if (isCP) bookkeepingModelTurns++;
        } else if (t.tools.some((tc) => tc.name === "run_command")) {
          classification = seenDelegation ? "ACCEPTANCE_VALIDATION" : "VALIDATION";
        } else if (seenDelegation) {
          classification = "ACCEPTANCE";
        } else if (t.turnIndex === 1) {
          classification = "CLASSIFICATION";
        } else {
          classification = "EXPLORATION";
        }
      }
      turnClassifications.push({
        turnIndex: t.turnIndex,
        classification,
        tools: t.tools.map((tc) => tc.name),
      });
    });
  }

  let workerPreMutationTurns = 0;
  let workerPostMutationTurns = 0;
  let workerSeenMutation = false;
  let duplicateReads = 0;
  const readHistory = new Set();
  let repeatedValidationWithoutMutation = 0;

  if (workerTurns.length > 0) {
    workerTurns.forEach((t) => {
      const hasMutation = t.tools.some(
        (tc) => tc.name === "replace_file_content" || tc.name === "write_to_file"
      );
      if (!workerSeenMutation) {
        if (hasMutation) workerSeenMutation = true;
        else workerPreMutationTurns++;
      } else {
        workerPostMutationTurns++;
      }

      t.tools.forEach((tc) => {
        if (tc.name === "view_file") {
          const p = tc.args?.AbsolutePath || tc.args?.path || "";
          if (readHistory.has(p) && !workerSeenMutation) duplicateReads++;
          readHistory.add(p);
        }
      });
    });
  }

  const parentDist = parentMetrics ? parentMetrics.distribution : { 0: 1, 1: parentToolCalls, 2: 0, "3+": 0 };
  const workerDist = workerMetrics ? workerMetrics.distribution : { 0: 0, 1: workerToolCalls, 2: 0, "3+": 0 };
  const combinedDist = {
    0: (parentDist[0] || 0) + (workerDist[0] || 0),
    1: (parentDist[1] || 0) + (workerDist[1] || 0),
    2: (parentDist[2] || 0) + (workerDist[2] || 0),
    "3+": (parentDist["3+"] || 0) + (workerDist["3+"] || 0),
  };
  const maxToolsSingleTurn = Math.max(
    parentMetrics?.max_tools_in_single_turn || 0,
    workerMetrics?.max_tools_in_single_turn || 0,
    totalToolCalls > 0 ? 1 : 0
  );

  const normUsage = normalizeUsageEvent(
    agyUsage
      ? {
          input_tokens: agyUsage.input_tokens,
          cached_input_tokens: agyUsage.cache_read_tokens,
          cache_read_tokens: agyUsage.cache_read_tokens,
          output_tokens: agyUsage.output_tokens,
          thinking_tokens: agyUsage.thinking_tokens,
          total_tokens: agyUsage.total_tokens,
        }
      : null,
    "antigravity"
  );

  return {
    model_turns_total: totalModelTurns,
    model_invocations: totalModelTurns,
    parent_model_turns: parentModelTurns,
    parent_invocations: parentModelTurns,
    worker_model_turns: workerModelTurns,
    worker_invocations: workerModelTurns,
    reviewer_model_turns: reviewerModelTurns,
    reviewer_invocations: reviewerModelTurns,
    total_model_turns: totalModelTurns,
    parent_tool_calls: parentToolCalls,
    worker_tool_calls: workerToolCalls,
    total_tool_calls: totalToolCalls,
    tool_calls: totalToolCalls,
    tool_calls_per_turn_distribution: combinedDist,
    parent_tool_distribution: parentDist,
    worker_tool_distribution: workerDist,
    tool_distribution_by_role: {
      ORCHESTRATOR: {
        distribution: parentDist,
        max_tools_single_turn: parentMetrics?.max_tools_in_single_turn || (parentToolCalls > 0 ? 1 : 0),
        turns_with_0_tools: parentDist[0] || 0,
        turns_with_1_tool: parentDist[1] || 0,
        turns_with_2_tools: parentDist[2] || 0,
        turns_with_3_plus_tools: parentDist["3+"] || 0,
      },
      WORKER: {
        distribution: workerDist,
        max_tools_single_turn: workerMetrics?.max_tools_in_single_turn || (workerToolCalls > 0 ? 1 : 0),
        turns_with_0_tools: workerDist[0] || 0,
        turns_with_1_tool: workerDist[1] || 0,
        turns_with_2_tools: workerDist[2] || 0,
        turns_with_3_plus_tools: workerDist["3+"] || 0,
      },
    },
    turns_with_zero_tools: combinedDist[0] || 0,
    turns_with_one_tool: combinedDist[1] || 0,
    turns_with_multiple_tools: (combinedDist[2] || 0) + (combinedDist["3+"] || 0),
    max_tools_in_single_turn: maxToolsSingleTurn,
    parent_pre_delegation_turns: parentPreDelegationTurns,
    parent_post_handoff_turns: parentPostHandoffTurns,
    worker_pre_mutation_turns: workerPreMutationTurns,
    worker_post_mutation_turns: workerPostMutationTurns,
    tools_per_turn_by_role: {
      ORCHESTRATOR: parentModelTurns > 0 ? Number((parentToolCalls / parentModelTurns).toFixed(2)) : 0,
      WORKER: workerModelTurns > 0 ? Number((workerToolCalls / workerModelTurns).toFixed(2)) : 0,
    },
    duplicate_reads: duplicateReads,
    repeated_validation_without_mutation: repeatedValidationWithoutMutation,
    bookkeeping_model_turns: bookkeepingModelTurns,
    turn_classifications: turnClassifications,
    subagent_invocations: state.subagent_invocations || (workerTurns.length > 0 ? 1 : 0),
    manage_subagent_calls: state.manage_subagents_calls || 0,
    stop_attempts: state.stop_attempts || 0,
    clean_stops: state.clean_stops || 0,
    forced_stop_continuations: state.forced_stop_continuations || 0,
    advisory_injections: state.advisory_injections_total || 0,
    worker_packet_bytes: state.worker_packet_bytes || 0,
    context_proxy_bytes: state.context_proxy_bytes || 0,
    input_tokens: normUsage.inputTokens,
    cached_input_tokens: normUsage.cachedInputTokens,
    uncached_input_tokens: normUsage.uncachedInputTokens,
    uncached_semantics: normUsage.uncachedSemantics,
    output_tokens: normUsage.outputTokens,
    reasoning_tokens: normUsage.reasoningTokens,
    token_semantics_confidence: normUsage.confidence,
    metric_status: normUsage.status,
    mutation_events: (state.mutationEvents || []).filter((e) => !e.isControlPlane && !isControlPlanePath(e.path)),
    orchestrator_workspace_writes: state.orchestratorWorkspaceWrites || 0,
    control_plane_writes: state.controlPlaneWrites || 0,
    unknown_workspace_writes: state.unknownWorkspaceWrites || 0,
    worker_validation_observed: state.workerValidationObserved || false,
    worker_validation_command: state.workerValidationCommand || null,
    worker_validation_exit_code: state.workerValidationExitCode ?? null,
    handoff_observed: state.handoffObserved || false,
    handoff_bytes: state.handoffBytes || state.worker_packet_bytes || 0,
    handoff_status: state.handoffStatus || (state.worker_packet_bytes ? "MESSAGE_DELIVERED" : null),
    worker_conversation_id: state.workerConversationId || null,
    acceptance_actor: state.acceptanceActor || "ORCHESTRATOR",
    acceptance_observed: state.acceptanceObserved || (state.state === "DONE" || state.acceptanceState === "ACCEPTED"),
    acceptance_state: state.acceptanceState || (state.state === "DONE" ? "ACCEPTED" : null),
  };
}

/**
 * Runs a single benchmark task.
 */
function runTask({ runtime, taskKey, dryRun, runId }) {
  const taskDef = TASKS[taskKey];
  if (!taskDef) throw new Error(`Unknown task: ${taskKey}`);

  console.log(`\n==================================================`);
  console.log(`RUNNING: [${runtime.toUpperCase()}] ${taskDef.name}`);
  console.log(`Prompt: "${taskDef.prompt}"`);
  console.log(`Dry run: ${dryRun ? "YES (simulation)" : "NO (live execution)"}`);
  console.log(`==================================================`);

  const tempDir = createFreshEnvironment(taskKey);
  const startTime = Date.now();

  try {
    installRuntime(tempDir, runtime);

    if (dryRun) {
      // Validate installation and dry run semantics
      const hasCodex = existsSync(join(tempDir, ".codex/config.toml"));
      const hasAgy = existsSync(join(tempDir, ".agents/hooks.json"));
      if (runtime === "codex" && !hasCodex) throw new Error("Codex installation failed in dry-run");
      if (runtime === "antigravity" && !hasAgy) throw new Error("Antigravity installation failed in dry-run");

      // Verify that fixture tests run in clean environment
      execFileSync("node", ["--test", "test/calculator.test.js"], { cwd: tempDir, stdio: "ignore" });

      const fidelity = evaluateTaskFidelity({
        taskKey,
        runtime,
        subagentInvocations: TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected ? 1 : 0,
        mutationActor: TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected ? "WORKER" : "NONE",
        dryRun: true,
        runtimeLoaded: true,
        orchestratorIdentity: runtime === "codex" ? "terra-medium" : "flash-orchestrator",
        workerObserved: !!TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected,
        confidenceEvidence: {
          hasExplicitThreadId: true,
          hasExplicitAgentRole: true,
        },
      });

      const durationMs = Date.now() - startTime;
      return {
        runtime,
        task: taskKey,
        task_id: taskDef.id,
        task_name: taskDef.name,
        success: true,
        dry_run: true,
        duration_ms: durationMs,
        model_turns_total: 1,
        model_invocations: 1,
        parent_invocations: 1,
        worker_invocations: 0,
        reviewer_invocations: 0,
        tool_calls: 1,
        tool_calls_per_turn_distribution: { 0: 0, 1: 1, 2: 0, "3+": 0 },
        turns_with_zero_tools: 0,
        turns_with_one_tool: 1,
        turns_with_multiple_tools: 0,
        max_tools_in_single_turn: 1,
        subagent_invocations: TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected ? 1 : 0,
        manage_subagent_calls: 0,
        stop_attempts: 1,
        forced_stop_continuations: 0,
        advisory_injections: 0,
        worker_packet_bytes: 0,
        context_proxy_bytes: 512,
        input_tokens: runtime === "codex" ? 1200 : null,
        cached_input_tokens: runtime === "codex" ? 400 : null,
        uncached_input_tokens: runtime === "codex" ? 800 : null,
        uncached_semantics: runtime === "codex" ? "DERIVED_COUNTER" : "NOT_AVAILABLE",
        output_tokens: runtime === "codex" ? 80 : null,
        reasoning_tokens: runtime === "codex" ? 20 : null,
        token_semantics_confidence: runtime === "codex" ? "HIGH" : "LOW",
        metric_status: runtime === "codex" ? "OK" : "NOT_AVAILABLE",
        fidelity: {
          status: fidelity.fidelityStatus,
          confidence: fidelity.confidence,
          writeActorValid: fidelity.writeActorValid,
          violations: fidelity.violations,
        },
      };
    }

    // LIVE RUN
    let stdout = "";
    let metrics = {};

    mkdirSync(rawDataDir, { recursive: true });
    const rawRunFile = join(rawDataDir, `${runId}_${runtime}_${taskKey}.log`);

    if (runtime === "codex") {
      const codexExe = process.platform === "win32" ? "codex.exe" : "codex";
      const args = [
        "exec",
        "--json",
        "--disable",
        "plugins",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        tempDir,
        taskDef.prompt,
      ];

      const res = spawnSync(codexExe, args, {
        cwd: tempDir,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });

      stdout = (res.stdout || "") + "\n" + (res.stderr || "");
      writeFileSync(rawRunFile, stdout, "utf8");
      metrics = parseCodexJsonl(res.stdout || "");
    } else if (runtime === "antigravity") {
      const agyExe = process.platform === "win32" ? "agy.exe" : "agy";
      const args = [
        "--model",
        "gemini-3.8-flash-medium",
        "--add-dir",
        tempDir,
        "-p",
        taskDef.prompt,
        "--output-format",
        "json",
        "--print-timeout",
        "15m",
        "--dangerously-skip-permissions",
      ];

      const env = {
        ...process.env,
        BENCHMARK_RUN_ID: runId,
        BENCHMARK_TASK_ID: taskDef.id,
      };

      const res = spawnSync(agyExe, args, {
        cwd: tempDir,
        env,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 20 * 60 * 1000, // 20 minutes hard wall-clock limit
      });

      stdout = (res.stdout || "") + "\n" + (res.stderr || "");
      writeFileSync(rawRunFile, stdout, "utf8");
      metrics = parseAgyTelemetry(tempDir, res.stdout || "");
    }

    const durationMs = Date.now() - startTime;
    const verification = taskDef.verify(tempDir, stdout);

    const mutationEvents = metrics.mutation_events || [];
    const orchestratorWrites = metrics.orchestrator_workspace_writes || 0;
    const unknownWrites = metrics.unknown_workspace_writes || 0;
    const controlPlaneWrites = metrics.control_plane_writes || 0;
    const workerMutations = mutationEvents.filter(
      (m) => m.actorRole === "WORKER" || m.actorRole === "WORKER_SUBAGENT"
    );
    const orchestratorMutations = mutationEvents.filter(
      (m) => m.actorRole === "ORCHESTRATOR"
    );
    const unknownMutations = mutationEvents.filter(
      (m) => m.actorRole === "UNKNOWN"
    );

    let liveMutationActor = "NONE";
    if (orchestratorWrites > 0 || orchestratorMutations.length > 0) {
      liveMutationActor = "ORCHESTRATOR";
    } else if (unknownWrites > 0 || unknownMutations.length > 0) {
      liveMutationActor = "UNKNOWN";
    } else if (workerMutations.length > 0) {
      liveMutationActor = "WORKER";
    } else if (runtime === "codex" && (metrics.subagent_invocations || 0) > 0) {
      liveMutationActor = TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected ? "WORKER" : "NONE";
    }
    // NOTE: Do NOT fall back to ORCHESTRATOR merely because tool_calls > 0.
    // If no mutations were observed (mutation_events empty, orchestratorWrites=0, unknownWrites=0),
    // actor stays NONE. This is the correct signal for EXPECTED_WORKER_ABSENT without
    // a false ORCHESTRATOR_PRODUCT_WRITE_ALLOWED violation.

    const fidelity = evaluateTaskFidelity({
      taskKey,
      runtime,
      subagentInvocations: metrics.subagent_invocations || 0,
      mutationActor: liveMutationActor,
      mutationEvents,
      orchestratorWorkspaceWrites: orchestratorWrites,
      unknownWorkspaceWrites: unknownWrites,
      controlPlaneWrites,
      dryRun: false,
      runtimeLoaded: true,
      orchestratorIdentity: runtime === "codex" ? "terra-medium" : "flash-orchestrator",
      workerObserved: workerMutations.length > 0 || (metrics.subagent_invocations || 0) > 0,
      confidenceEvidence: {
        hasExplicitThreadId: runtime === "codex" && (metrics.subagent_invocations || 0) > 0,
        hasExplicitAgentRole: mutationEvents.some(
          (m) => m.evidenceSource === "hook_payload" || m.evidenceSource === "role_bindings" || m.evidenceSource === "RUNTIME_IDENTITY"
        ),
        hasSubagentTrace: (metrics.subagent_invocations || 0) > 0,
      },
    });

    return {
      runtime,
      task: taskKey,
      task_id: taskDef.id,
      task_name: taskDef.name,
      success: verification.success,
      verification_detail: verification.detail || verification.reason || "OK",
      dry_run: false,
      duration_ms: durationMs,
      ...metrics,
      fidelity: {
        status: fidelity.fidelityStatus,
        confidence: fidelity.confidence,
        writeActorValid: fidelity.writeActorValid,
        violations: fidelity.violations,
      },
    };
  } finally {
    // Fresh environment cleanup
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    runtimes: [],
    tasks: [],
    dryRun: false,
    requireFidelity: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--require-fidelity") {
      options.requireFidelity = true;
    } else if (arg === "--runtime") {
      options.runtimes.push(args[++i]);
    } else if (arg === "--task") {
      options.tasks.push(args[++i]);
    } else if (arg === "--all") {
      options.all = true;
    }
  }

  if (options.runtimes.length === 0) {
    options.runtimes = ["codex", "antigravity"];
  }
  if (options.tasks.length === 0 && options.all) {
    options.tasks = ["status", "lookup", "simple", "multi", "investigation"];
  } else if (options.tasks.length === 0) {
    options.tasks = ["status"];
  }

  return options;
}

function main() {
  const options = parseArgs();
  const runId = `run-${Date.now()}`;
  mkdirSync(resultsDir, { recursive: true });

  console.log(`=== ORCHESTRA TURN ECONOMY BENCHMARK v1 ===`);
  console.log(`Run ID: ${runId}`);
  console.log(`Runtimes: ${options.runtimes.join(", ")}`);
  console.log(`Tasks: ${options.tasks.join(", ")}`);
  console.log(`Dry Run: ${options.dryRun}`);
  console.log(`Require Fidelity: ${options.requireFidelity}`);

  const results = [];
  let hasFidelityFailure = false;

  // Alternating task execution to minimize temporal bias
  for (const taskKey of options.tasks) {
    for (const runtime of options.runtimes) {
      try {
        const res = runTask({ runtime, taskKey, dryRun: options.dryRun, runId });
        results.push(res);
        const fidelityStr = res.fidelity ? ` Fidelity=${res.fidelity.status}` : "";
        console.log(`RESULT [${runtime} / ${taskKey}]: Success=${res.success}${fidelityStr} Duration=${res.duration_ms}ms Invocations=${res.model_invocations} Tools=${res.tool_calls}`);

        if (options.requireFidelity && !options.dryRun && res.fidelity && res.fidelity.status !== "PASS" && TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected) {
          console.error(`FIDELITY_FAILED: ${runtime} on ${taskKey} failed runtime fidelity check: ${res.fidelity.violations.join(", ")}`);
          hasFidelityFailure = true;
        }
      } catch (err) {
        console.error(`ERROR running [${runtime} / ${taskKey}]:`, err.message);
        results.push({
          runtime,
          task: taskKey,
          success: false,
          error: err.message,
        });
      }
    }
  }

  // Write summary.json
  writeFileSync(summaryFile, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nBenchmark summary saved to: ${summaryFile}`);

  if (hasFidelityFailure) {
    console.error(`\nBenchmark execution terminated: one or more tasks failed closed under --require-fidelity.`);
    process.exit(1);
  }
}

main();
