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

/**
 * Normalizes file paths to clean forward-slash relative workspace paths without double slashes.
 */
export function canonicalizePath(p) {
  return String(p || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
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
  const perTurnToolCounts = [];
  let sum3Plus = 0;

  for (const t of turns) {
    const count = typeof t.toolCount === "number" ? t.toolCount : (t.tools ? t.tools.length : 0);
    perTurnToolCounts.push(count);
    totalTools += count;
    if (count > maxTools) maxTools = count;
    if (count === 0) dist[0]++;
    else if (count === 1) dist[1]++;
    else if (count === 2) dist[2]++;
    else {
      dist["3+"]++;
      sum3Plus += count;
    }
  }

  // Enforce Distribution Invariant: sum of distribution buckets == total model turns
  const distSum = dist[0] + dist[1] + dist[2] + dist["3+"];
  if (distSum !== turns.length) {
    throw new Error(`Distribution invariant failed: ${distSum} !== ${turns.length}`);
  }

  // Enforce Tool Count Invariant: total tool calls == sum of per-turn counts
  const derivedToolSum = (1 * dist[1]) + (2 * dist[2]) + sum3Plus;
  if (derivedToolSum !== totalTools) {
    throw new Error(`Tool count invariant failed: ${derivedToolSum} !== ${totalTools}`);
  }

  return {
    distribution: dist,
    max_tools_in_single_turn: maxTools,
    total_tool_calls: totalTools,
    turns_with_zero_tools: dist[0],
    turns_with_one_tool: dist[1],
    turns_with_multiple_tools: dist[2] + dist["3+"],
    per_turn_tool_counts: perTurnToolCounts,
  };
}

export function extractChildTranscriptEvidence(childTranscriptFile, sub, targetDir, roleBindings = null, options = {}) {
  if (!existsSync(childTranscriptFile)) return { mutations: [], validations: [], completionClaimed: false, role: "UNKNOWN", profile: null, confidence: "LOW" };
  const mutations = [];
  const validations = [];
  let completionClaimed = false;

  let resolvedRole = "UNKNOWN";
  let resolvedConfidence = "LOW";
  let resolvedProfile = sub?.subagentDescriptor?.typeName || sub?.subagentDescriptor?.role || null;

  if (!roleBindings && targetDir) {
    const roleBindingsPath = join(targetDir, ".agents/state/role-bindings.json");
    if (existsSync(roleBindingsPath)) {
      try { roleBindings = JSON.parse(readFileSync(roleBindingsPath, "utf8")); } catch {}
    }
  }

  // 1. Exact role binding for child conversation
  const binding = (roleBindings?.bindings && roleBindings.bindings[sub?.conversationId])
    || (roleBindings?.conversations && roleBindings.conversations[sub?.conversationId])
    || null;

  if (binding) {
    const parentMatches = !options?.parentConvId || !binding.parentConversationId || binding.parentConversationId === options.parentConvId;
    const taskMatches = !options?.taskId || !(binding.taskIdentifier || binding.taskId) || (binding.taskIdentifier || binding.taskId) === options.taskId;
    const runMatches = !options?.benchmarkRunId || !binding.benchmarkRunId || binding.benchmarkRunId === options.benchmarkRunId;

    if (parentMatches && taskMatches && runMatches) {
      resolvedRole = (binding.role || "UNKNOWN").toUpperCase();
      resolvedConfidence = binding.confidence === "HIGH" ? "HIGH" : "MEDIUM";
      resolvedProfile = binding.profile || resolvedProfile;
    }
  } else if (Array.isArray(roleBindings?.pendingSubagents) && roleBindings.pendingSubagents.length > 0) {
    // 2. Unambiguous pending binding correlated to current parent/task/run
    let candidates = roleBindings.pendingSubagents.filter((p) => !p.consumed);
    if (options?.parentConvId) {
      candidates = candidates.filter((p) => !p.parentConversationId || p.parentConversationId === options.parentConvId);
    }
    if (options?.taskId) {
      candidates = candidates.filter((p) => !(p.taskIdentifier || p.taskId) || (p.taskIdentifier || p.taskId) === options.taskId);
    }
    if (options?.benchmarkRunId) {
      candidates = candidates.filter((p) => !p.benchmarkRunId || p.benchmarkRunId === options.benchmarkRunId);
    }

    const descTypeName = sub?.subagentDescriptor?.typeName || "";
    const descRole = String(sub?.subagentDescriptor?.role || "").toLowerCase();

    let matchedCandidates = [];
    if (descTypeName || descRole) {
      matchedCandidates = candidates.filter((p) => {
        if (descTypeName && (p.profile === descTypeName || p.typeName === descTypeName)) return true;
        if (descRole && p.role && descRole.includes(p.role.toLowerCase())) return true;
        return false;
      });
    } else {
      matchedCandidates = candidates;
    }

    // Deterministic rule: exactly 1 candidate -> bind; 0 or >1 ambiguous -> UNKNOWN (fail closed)
    if (matchedCandidates.length === 1) {
      const match = matchedCandidates[0];
      resolvedRole = (match.role || "UNKNOWN").toUpperCase();
      resolvedConfidence = "HIGH";
      resolvedProfile = match.profile || match.typeName || resolvedProfile;
    } else {
      resolvedRole = "UNKNOWN";
      resolvedConfidence = "LOW";
    }
  }

  // 3. Otherwise UNKNOWN / LOW — strictly no descriptor-based promotion

  try {
    const lines = readFileSync(childTranscriptFile, "utf8").trim().split("\n");
    const steps = [];
    for (const l of lines) {
      try { steps.push(JSON.parse(l)); } catch {}
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)) {
        for (let tcIdx = 0; tcIdx < step.tool_calls.length; tcIdx++) {
          const tc = step.tool_calls[tcIdx];
          const toolName = tc.name || "";
          const args = tc.args || tc.parameters || {};

          if (toolName === "replace_file_content" || toolName === "write_to_file") {
            const rawTarget = String(args.TargetFile || args.targetFile || args.path || "").replace(/^["']|["']$/g, "");
            let relPath = rawTarget;
            const normRaw = rawTarget.replace(/\\+/g, "/").replace(/\/+/g, "/");
            const normTargetDir = targetDir ? targetDir.replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "") : "";
            if (normTargetDir && normRaw.toLowerCase().startsWith(normTargetDir.toLowerCase())) {
              relPath = normRaw.slice(normTargetDir.length);
            }
            relPath = canonicalizePath(relPath);

            if (!isControlPlanePath(relPath)) {
              mutations.push({
                path: relPath,
                actorRole: resolvedRole,
                agentProfile: resolvedProfile,
                conversationId: sub.conversationId,
                tool: toolName,
                confidence: resolvedConfidence,
                evidenceSource: "CHILD_TRANSCRIPT",
                stepIndex: i,
              });
            }
          } else if (toolName === "run_command") {
            const cmd = String(args.CommandLine || args.command || args.cmd || "").replace(/^["']|["']$/g, "").trim();
            let exitCode = null;
            for (let j = i + 1; j < Math.min(i + 3, steps.length); j++) {
              const next = steps[j];
              if (next && next.content) {
                const m = String(next.content).match(/The command exited with code (\d+)/i);
                if (m) {
                  exitCode = parseInt(m[1], 10);
                  break;
                }
              }
            }
            const isTestCmd = /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(cmd);
            if (isTestCmd || cmd.includes("node --test")) {
              const transcriptEvidenceId = `child:${sub.conversationId}:step:${i}:tool:${tcIdx}`;
              validations.push({
                executionId: null,
                transcriptEvidenceId,
                command: cmd,
                exitCode: exitCode,
                actorRole: resolvedRole,
                agentProfile: resolvedProfile,
                conversationId: sub.conversationId,
                tool: "run_command",
                confidence: resolvedConfidence,
                evidenceSource: "CHILD_TRANSCRIPT",
                stepIndex: i,
              });
            }
          } else if (toolName === "send_message") {
            const msg = String(args.Message || "");
            if (msg.includes("IMPLEMENTATION_COMPLETE")) {
              completionClaimed = true;
            }
          }
        }
      }
    }
  } catch {}

  return { mutations, validations, completionClaimed, role: resolvedRole, profile: resolvedProfile, confidence: resolvedConfidence };
}

/**
 * Parses AGY telemetry from .agents/state/active-state.json, events.jsonl, and agy JSON output.
 */
export function parseAgyTelemetry(targetDir, rawOutput) {
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
  const childMutations = [];
  const childValidations = [];
  let childCompletionClaimed = false;

  if (convId) {
    const brainDir = join(homedir(), ".gemini/antigravity-cli/brain", convId);
    const parentTranscriptFile = join(brainDir, ".system_generated/logs/transcript.jsonl");
    if (existsSync(parentTranscriptFile)) {
      parentTurns = parseTranscriptTurns(parentTranscriptFile);
    }
    const roleBindingsPath = join(targetDir, ".agents/state/role-bindings.json");
    let roleBindings = null;
    if (existsSync(roleBindingsPath)) {
      try { roleBindings = JSON.parse(readFileSync(roleBindingsPath, "utf8")); } catch {}
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
              const childEv = extractChildTranscriptEvidence(childTranscriptFile, sub, targetDir, roleBindings, {
                parentConvId: convId,
                taskId: state.taskId || null,
                benchmarkRunId: state.benchmarkRunId || null,
              });
              childMutations.push(...childEv.mutations);
              childValidations.push(...childEv.validations);
              if (childEv.completionClaimed) {
                childCompletionClaimed = true;
              }

              const childTurns = parseTranscriptTurns(childTranscriptFile);
              if (childTurns) {
                const childRole = (childEv.role || childEv.validations[0]?.actorRole || childEv.mutations[0]?.actorRole || "UNKNOWN").toUpperCase();
                if (childRole === "REVIEWER") {
                  reviewerTurns.push(...childTurns);
                } else if (childRole === "WORKER") {
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
  let postMutationRereads = 0;
  const readHistory = new Set();
  let repeatedValidationWithoutMutation = 0;
  let workerSearchTurns = 0;
  let workerReadTurns = 0;
  let workerMutationTurns = 0;
  let workerValidationTurns = 0;
  let workerHandoffTurns = 0;
  let workerMultiToolTurns = 0;
  let mutationsSinceLastValidation = 0;

  const isTestCmd = (cmd) => {
    const c = String(cmd || "").replace(/^["']|["']$/g, "").trim();
    return /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(c) || c.includes("node --test");
  };

  if (workerTurns.length > 0) {
    workerTurns.forEach((t) => {
      const toolCount = typeof t.toolCount === "number" ? t.toolCount : (t.tools ? t.tools.length : 0);
      if (toolCount > 1) {
        workerMultiToolTurns++;
      }

      const hasSearch = t.tools.some((tc) => ["find_by_name", "grep_search", "list_dir"].includes(tc.name));
      const hasMutation = t.tools.some((tc) => ["replace_file_content", "write_to_file"].includes(tc.name));
      const hasRead = t.tools.some((tc) => ["view_file", "read_url_content"].includes(tc.name));
      const hasValidation = t.tools.some((tc) => tc.name === "run_command" && isTestCmd(tc.args?.CommandLine || tc.args?.command || tc.args?.cmd));
      const hasHandoff = t.tools.some((tc) => tc.name === "send_message") || (toolCount === 0 && workerSeenMutation);

      if (hasSearch) workerSearchTurns++;
      if (hasMutation) {
        workerMutationTurns++;
        mutationsSinceLastValidation++;
      } else if (hasRead) {
        workerReadTurns++;
      }
      if (hasValidation) {
        workerValidationTurns++;
        if (mutationsSinceLastValidation === 0) {
          repeatedValidationWithoutMutation++;
        }
        mutationsSinceLastValidation = 0;
      }
      if (hasHandoff) workerHandoffTurns++;

      if (!workerSeenMutation) {
        if (hasMutation) workerSeenMutation = true;
        else workerPreMutationTurns++;
      } else {
        workerPostMutationTurns++;
      }

      t.tools.forEach((tc) => {
        if (tc.name === "view_file") {
          const p = tc.args?.AbsolutePath || tc.args?.path || "";
          if (workerSeenMutation) {
            postMutationRereads++;
          } else {
            if (readHistory.has(p)) duplicateReads++;
          }
          readHistory.add(p);
        }
      });
    });
  }

  const workerSerialIndependentToolOpportunities = Math.max(0, workerReadTurns - 1) + Math.max(0, workerMutationTurns - 1);
  const workerValidationCommands = childValidations.map((v) => v.command);
  const workerValidationRuns = childValidations.length;

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

  const lastChildVal = childValidations.length > 0 ? childValidations[childValidations.length - 1] : null;
  const lastChildMutationStep = childMutations.length > 0
    ? Math.max(...childMutations.map((m) => (typeof m.stepIndex === "number" ? m.stepIndex : -1)))
    : -1;
  const childValFresh = Boolean(
    lastChildVal &&
    lastChildVal.exitCode === 0 &&
    (lastChildMutationStep === -1 || (typeof lastChildVal.stepIndex === "number" && lastChildVal.stepIndex > lastChildMutationStep))
  );
  const childValVerified = Boolean(
    lastChildVal &&
    lastChildVal.exitCode === 0 &&
    childValFresh &&
    lastChildVal.actorRole === "WORKER"
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
    worker_model_turns: workerModelTurns,
    worker_tool_calls: workerToolCalls,
    worker_search_turns: workerSearchTurns,
    worker_read_turns: workerReadTurns,
    worker_mutation_turns: workerMutationTurns,
    worker_validation_turns: workerValidationTurns,
    worker_handoff_turns: workerHandoffTurns,
    worker_multi_tool_turns: workerMultiToolTurns,
    worker_serial_independent_tool_opportunities: workerSerialIndependentToolOpportunities,
    tools_per_turn_by_role: {
      ORCHESTRATOR: parentModelTurns > 0 ? Number((parentToolCalls / parentModelTurns).toFixed(2)) : 0,
      WORKER: workerModelTurns > 0 ? Number((workerToolCalls / workerModelTurns).toFixed(2)) : 0,
    },
    duplicate_reads: duplicateReads,
    post_mutation_rereads: postMutationRereads,
    worker_validation_commands: workerValidationCommands,
    worker_validation_runs: workerValidationRuns,
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
    mutation_events: [
      ...(state.mutationEvents || []).filter((e) => !e.isControlPlane && !isControlPlanePath(e.path)),
      ...childMutations,
    ],
    orchestrator_workspace_writes: state.orchestratorWorkspaceWrites || 0,
    control_plane_writes: state.controlPlaneWrites || 0,
    unknown_workspace_writes: state.unknownWorkspaceWrites || 0,
    worker_completion_claimed: Boolean(state.workerCompletionClaimed || childCompletionClaimed || state.implementationComplete),
    worker_validation_observed: Boolean(state.workerValidationObserved || childValidations.length > 0),
    worker_validation_command: state.workerValidationCommand || (lastChildVal ? lastChildVal.command : null),
    worker_validation_exit_code: state.workerValidationExitCode ?? (lastChildVal ? lastChildVal.exitCode : null),
    worker_validation_actor: state.workerValidationActor || (lastChildVal ? lastChildVal.actorRole : (state.workerValidationObserved ? "WORKER" : null)),
    worker_validation_execution_id: state.workerValidationExecutionId || null,
    worker_validation_conversation_id: state.workerConversationId || (lastChildVal ? lastChildVal.conversationId : null),
    worker_validation_verified: Boolean(
      state.workerValidationVerified || childValVerified
    ),
    worker_validation_fresh: Boolean(
      state.workerValidationFresh || childValFresh
    ),
    handoff_observed: state.handoffObserved || childCompletionClaimed,
    handoff_bytes: state.handoffBytes || state.worker_packet_bytes || 0,
    handoff_status: state.handoffStatus || (state.worker_packet_bytes ? "MESSAGE_DELIVERED" : null),
    worker_conversation_id: state.workerConversationId || (childValidations[0]?.conversationId || null),
    acceptance_actor: state.acceptanceActor || null,
    acceptance_observed: Boolean(state.acceptanceObserved),
    acceptance_state: state.acceptanceState || null,
    parent_per_turn_tool_counts: parentMetrics?.per_turn_tool_counts || (parentToolCalls > 0 ? [parentToolCalls] : [0]),
    worker_per_turn_tool_counts: workerMetrics?.per_turn_tool_counts || (workerToolCalls > 0 ? [workerToolCalls] : []),
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
          expectedRoute: fidelity.expectedRoute,
          observed: fidelity.observed,
          worker_completion_claimed: fidelity.worker_completion_claimed,
          worker_validation_observed: fidelity.worker_validation_observed,
          worker_validation_verified: fidelity.worker_validation_verified,
          worker_validation_execution_id: fidelity.worker_validation_execution_id,
          worker_validation_conversation_id: fidelity.worker_validation_conversation_id,
          worker_validation_actor: fidelity.worker_validation_actor,
          worker_validation_exit_code: fidelity.worker_validation_exit_code,
          worker_validation_fresh: fidelity.worker_validation_fresh,
          mutation_attribution_mode: fidelity.mutation_attribution_mode,
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
      workerCompletionClaimed: metrics.worker_completion_claimed || false,
      workerValidationObserved: metrics.worker_validation_observed || false,
      workerValidationVerified: metrics.worker_validation_verified || false,
      workerValidationExecutionId: metrics.worker_validation_execution_id || null,
      workerValidationConversationId: metrics.worker_validation_conversation_id || null,
      workerValidationActor: metrics.worker_validation_actor || null,
      workerValidationExitCode: metrics.worker_validation_exit_code ?? null,
      workerValidationFresh: metrics.worker_validation_fresh || false,
      acceptanceObserved: metrics.acceptance_observed || false,
      acceptanceActor: metrics.acceptance_actor || null,
      acceptanceState: metrics.acceptance_state || null,
      mutationAttributionMode: mutationEvents.length > 0 ? (mutationEvents.some((m) => m.evidenceSource === "CHILD_TRANSCRIPT") ? "FACTUAL" : null) : null,
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
        expectedRoute: fidelity.expectedRoute,
        observed: fidelity.observed,
        worker_completion_claimed: fidelity.worker_completion_claimed,
        worker_validation_observed: fidelity.worker_validation_observed,
        worker_validation_verified: fidelity.worker_validation_verified,
        worker_validation_execution_id: fidelity.worker_validation_execution_id,
        worker_validation_conversation_id: fidelity.worker_validation_conversation_id,
        worker_validation_actor: fidelity.worker_validation_actor,
        worker_validation_exit_code: fidelity.worker_validation_exit_code,
        worker_validation_fresh: fidelity.worker_validation_fresh,
        acceptance_observed: fidelity.acceptance_observed,
        acceptance_actor: fidelity.acceptance_actor,
        acceptance_state: fidelity.acceptance_state,
        mutation_attribution_mode: fidelity.mutation_attribution_mode,
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
        const workerInfo = typeof res.worker_model_turns === "number" ? ` WorkerTurns=${res.worker_model_turns} (pre=${res.worker_pre_mutation_turns}, post=${res.worker_post_mutation_turns}) Tools/Turn=${JSON.stringify(res.worker_per_turn_tool_counts)}` : "";
        console.log(`RESULT [${runtime} / ${taskKey}]: Success=${res.success}${fidelityStr} Duration=${res.duration_ms}ms Invocations=${res.model_invocations} Tools=${res.tool_calls}${workerInfo}`);

        const reqFidelity = TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected;
        if (options.requireFidelity && !options.dryRun && reqFidelity) {
          if (res.success !== true) {
            console.error(`BENCHMARK_FAILED: ${runtime} on ${taskKey} failed functional verification: ${res.verification_detail || "functional test failed"}`);
            hasFidelityFailure = true;
          }
          if (res.fidelity && res.fidelity.status !== "PASS") {
            console.error(`FIDELITY_FAILED: ${runtime} on ${taskKey} failed runtime fidelity check: ${res.fidelity.violations.join(", ")}`);
            hasFidelityFailure = true;
          }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
