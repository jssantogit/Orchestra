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
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { normalizeUsageEvent, TOKEN_COUNTER_TYPES, CONFIDENCE_LEVELS } from "./token-semantics.mjs";
import { evaluateTaskFidelity, TASK_FIDELITY_REQUIREMENTS } from "./fidelity.mjs";

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
  try {
    const trimmed = rawOutput.trim();
    // In case there are log prefixes, find the JSON block
    const jsonMatch = trimmed.match(/\{[\s\S]*"usage"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.usage) agyUsage = parsed.usage;
    }
  } catch {}

  const modelInvocations = state.model_invocations || state.preinvocation_count || 1;
  const workerInvocations = state.worker_invocations || 0;
  const reviewerInvocations = state.reviewer_invocations || 0;
  const parentInvocations = Math.max(0, modelInvocations - workerInvocations - reviewerInvocations);
  const totalToolCalls = state.tool_calls_total || state.tool_calls || 0;

  const normUsage = normalizeUsageEvent(agyUsage ? {
    input_tokens: agyUsage.input_tokens,
    cached_input_tokens: agyUsage.cache_read_tokens,
    cache_read_tokens: agyUsage.cache_read_tokens,
    output_tokens: agyUsage.output_tokens,
    thinking_tokens: agyUsage.thinking_tokens,
    total_tokens: agyUsage.total_tokens,
  } : null, "antigravity");

  return {
    model_turns_total: modelInvocations,
    model_invocations: modelInvocations,
    parent_invocations: parentInvocations,
    worker_invocations: workerInvocations,
    reviewer_invocations: reviewerInvocations,
    tool_calls: totalToolCalls,
    tool_calls_per_turn_distribution: {
      0: 1,
      1: totalToolCalls,
      2: 0,
      "3+": 0,
    },
    turns_with_zero_tools: 1,
    turns_with_one_tool: totalToolCalls,
    turns_with_multiple_tools: 0,
    max_tools_in_single_turn: totalToolCalls > 0 ? 1 : 0,
    subagent_invocations: state.subagent_invocations || 0,
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
        "--add-dir",
        tempDir,
        "-p",
        taskDef.prompt,
        "--output-format",
        "json",
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
      });

      stdout = (res.stdout || "") + "\n" + (res.stderr || "");
      writeFileSync(rawRunFile, stdout, "utf8");
      metrics = parseAgyTelemetry(tempDir, res.stdout || "");
    }

    const durationMs = Date.now() - startTime;
    const verification = taskDef.verify(tempDir, stdout);

    const fidelity = evaluateTaskFidelity({
      taskKey,
      runtime,
      subagentInvocations: metrics.subagent_invocations || 0,
      mutationActor: (metrics.subagent_invocations || 0) > 0 ? "WORKER" : (metrics.tool_calls > 0 && TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected ? "ORCHESTRATOR" : "NONE"),
      runtimeLoaded: true,
      orchestratorIdentity: runtime === "codex" ? "terra-medium" : "flash-orchestrator",
      workerObserved: (metrics.subagent_invocations || 0) > 0,
      confidenceEvidence: {
        hasExplicitThreadId: runtime === "codex" && (metrics.subagent_invocations || 0) > 0,
        hasExplicitAgentRole: true,
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

        if (options.requireFidelity && res.fidelity && res.fidelity.status !== "PASS" && TASK_FIDELITY_REQUIREMENTS[taskKey]?.delegationExpected) {
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
