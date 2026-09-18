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
import { createHash } from "node:crypto";
import { isControlPlanePath, evaluateTwoKeyReview } from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

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
      // 2. Verify options.precision and reject positional precision overload
      try {
        const testCode = `
          import assert from "node:assert/strict";
          import { formatNumber } from "./src/formatter.js";
          import { calculateAndFormat } from "./src/calculator.js";

          // options.precision supported
          assert.equal(formatNumber(3.14159, { precision: 2 }), "3.14");
          assert.equal(formatNumber(10, { precision: 3 }), "10.000");

          // default compatibility: empty options retains full number string
          assert.equal(formatNumber(3.14159, {}), "3.14159");

          // positional precision rejected: 3rd argument must NOT be treated as precision
          assert.equal(formatNumber(3.14159, {}, 2), "3.14159");

          // calculator pass-through works via existing options without calculator changes
          assert.equal(calculateAndFormat("divide", 1, 8, { precision: 2 }), "0.13");
        `;
        execFileSync("node", ["--input-type=module", "-e", testCode], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: `Precision argument verification failed: ${err.message}` };
      }

      // 3. Exported function signature audit
      const sigAudit = auditApiSignatures(fixtureSource, dir, ["src/formatter.js", "src/calculator.js"]);
      if (sigAudit.changed) {
        const details = Object.entries(sigAudit.details)
          .map(([fn, d]) => `${fn}: before="${d.before}" after="${d.after}"`)
          .join(", ");
        return { success: false, reason: `Exported function signature changed unexpectedly: ${details}` };
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
      // 1. Run parser test suite
      try {
        execFileSync("node", ["--test", "test/parser.test.js"], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        return { success: false, reason: "test/parser.test.js still failing" };
      }

      // 2. Direct functional verification of required and preserved behavior
      let functionalPassed = false;
      let grammarPreservationPassed = false;
      let precisionPreservationPassed = false;

      try {
        const testCode = `
          import assert from "node:assert/strict";
          import { parsePercentage } from "./src/parser.js";

          // Required decimal percentage support
          assert.equal(parsePercentage("12.5%"), 0.125);
          assert.equal(parsePercentage("99.9%"), 0.999);

          // Preserved existing behavior
          assert.equal(parsePercentage("50%"), 0.5);
          assert.equal(parsePercentage("100%"), 1);
          assert.equal(parsePercentage("0%"), 0);

          // Strict malformed-input rejection preserved
          const invalidInputs = ["abc%", "%", "12.5.5%", "12x5%", "12.5"];
          for (const invalid of invalidInputs) {
            assert.throws(
              () => parsePercentage(invalid),
              (err) => err instanceof RangeError || err instanceof TypeError,
              \`Expected parsePercentage(\${JSON.stringify(invalid)}) to throw RangeError/TypeError\`
            );
          }
        `;
        execFileSync("node", ["--input-type=module", "-e", testCode], { cwd: dir, stdio: "pipe" });
        functionalPassed = true;
      } catch (err) {
        return { success: false, reason: `Functional acceptance failed: ${err.message}` };
      }

      // 2b. Grammar preservation: unrelated syntax must NOT be newly accepted
      try {
        const grammarTestCode = `
          import assert from "node:assert/strict";
          import { parsePercentage } from "./src/parser.js";

          const unrelatedGrammar = [
            "+50%",
            "-50%",
            ".5%",
            "5.%",
            "+12.5%",
            "-12.5%",
            ".99%",
            "12.%",
            "1e2%",
          ];
          for (const invalid of unrelatedGrammar) {
            assert.throws(
              () => parsePercentage(invalid),
              (err) => err instanceof RangeError || err instanceof TypeError,
              \`Grammar preservation failed: parsePercentage(\${JSON.stringify(invalid)}) should remain rejected\`
            );
          }
        `;
        execFileSync("node", ["--input-type=module", "-e", grammarTestCode], { cwd: dir, stdio: "pipe" });
        grammarPreservationPassed = true;
      } catch (err) {
        return { success: false, reason: `Input grammar preservation failed: ${err.message}` };
      }

      // 2c. Precision preservation: high-precision decimal percentage must not suffer arbitrary precision truncation
      try {
        const precisionTestCode = `
          import assert from "node:assert/strict";
          import { parsePercentage } from "./src/parser.js";

          const highPrecisionCases = [
            "12.3456789012345%",
            "99.1234567890123%",
            "0.123456789012345%",
          ];
          for (const input of highPrecisionCases) {
            const numStr = input.slice(0, -1);
            const expected = Number(numStr + "e-2");
            const actual = parsePercentage(input);
            assert.equal(
              actual,
              expected,
              \`Precision preservation failed for \${input}: expected \${expected}, got \${actual} (arbitrary precision truncation detected)\`
            );
          }
        `;
        execFileSync("node", ["--input-type=module", "-e", precisionTestCode], { cwd: dir, stdio: "pipe" });
        precisionPreservationPassed = true;
      } catch (err) {
        return { success: false, reason: `Precision preservation failed: ${err.message}` };
      }

      // 3. Test integrity: seeded decimal-percentage assertions must remain present and active
      const parserTestPath = join(dir, "test/parser.test.js");
      const testContent = readFileSync(parserTestPath, "utf8");
      const hasSeeded125 = testContent.includes('parsePercentage("12.5%")') && testContent.includes("0.125");
      const hasSeeded999 = testContent.includes('parsePercentage("99.9%")') && testContent.includes("0.999");
      if (!hasSeeded125 || !hasSeeded999) {
        return { success: false, reason: "Test integrity failed: seeded decimal percentage assertions were removed or modified" };
      }
      if (/test\.skip\s*\(\s*["']parser:\s*parses decimal percentage values["']/i.test(testContent) ||
          /\/\*[\s\S]*parsePercentage\("12\.5%"\)[\s\S]*\*\//.test(testContent) ||
          /\/\/.*parsePercentage\("12\.5%"\)/.test(testContent)) {
        return { success: false, reason: "Test integrity failed: seeded test was skipped or commented out" };
      }

      return {
        success: true,
        functional_passed: functionalPassed,
        grammar_preservation_passed: grammarPreservationPassed,
        precision_preservation_passed: precisionPreservationPassed,
        test_integrity_passed: true,
      };
    },
  },
  critical: {
    id: "task-6-critical",
    name: "TASK 6 — CRITICAL REVIEW",
    prompt: "CRITICAL: Perform an independent Two-Key critical review of the input validation boundary in src/parser.js. Ensure strict containment against unexpected prototype keys, non-finite values, and malformed inputs.",
    setup(dir) {},
    verify(dir, stdout, metrics) {
      if (metrics && metrics.two_key_fidelity_gate !== undefined) {
        const passed =
          metrics.two_key_fidelity_gate === "PASS" &&
          metrics.independence_gate === "PASS" &&
          metrics.read_only_gate === "PASS" &&
          metrics.consensus_gate === "PASS";
        return {
          success: passed,
          detail: passed ? "TWO_KEY_FIDELITY_PASS" : (metrics.two_key_gate_failure || "TWO_KEY_FIDELITY_FAIL"),
        };
      }
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
    ...emptyJevMetrics(),
    parent_delegated_sidequest_attempts: 0,
    parent_delegated_sidequest_attempts_by_tool: {},
    parent_delegated_sidequest_denied: 0,
    parent_delegated_sidequest_succeeded: 0,
    schedule_attempts_during_delegation: 0,
    manage_task_poll_attempts: 0,
    manage_subagent_poll_attempts: 0,
    parent_workspace_read_attempts: 0,
    parent_repository_search_attempts: 0,
    parent_validation_attempts: 0,
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
 * Extracts exported function signatures from a JavaScript source file.
 */
export function extractExportedFunctionSignatures(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf8");
  const signatures = {};
  const fnRegex = /export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = fnRegex.exec(content)) !== null) {
    const fnName = match[1];
    const params = match[2].replace(/\s+/g, " ").trim();
    signatures[fnName] = `${fnName}(${params})`;
  }
  const arrowRegex = /export\s+const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  while ((match = arrowRegex.exec(content)) !== null) {
    const fnName = match[1];
    const params = match[2].replace(/\s+/g, " ").trim();
    signatures[fnName] = `${fnName}(${params})`;
  }
  return signatures;
}

/**
 * Audits exported API function signatures before and after benchmark execution.
 */
export function auditApiSignatures(pristineDir, liveDir, targetFiles = ["src/formatter.js", "src/calculator.js"]) {
  const audit = {
    before: {},
    after: {},
    changed: false,
    details: {},
  };
  for (const relFile of targetFiles) {
    const pristineFile = join(pristineDir, relFile);
    const liveFile = join(liveDir, relFile);
    const beforeSigs = extractExportedFunctionSignatures(pristineFile);
    const afterSigs = extractExportedFunctionSignatures(liveFile);
    audit.before[relFile] = beforeSigs;
    audit.after[relFile] = afterSigs;

    for (const [fnName, sigBefore] of Object.entries(beforeSigs)) {
      const sigAfter = afterSigs[fnName];
      if (!sigAfter || sigAfter !== sigBefore) {
        audit.changed = true;
        audit.details[fnName] = { before: sigBefore, after: sigAfter || "REMOVED" };
      }
    }
  }
  return audit;
}

/**
 * Audits mutated files for scope minimality.
 */
export function auditScopeMinimality(mutatedFiles = [], taskKey = "multi") {
  if (taskKey === "multi") {
    const classification = {};
    let pass = true;
    for (const f of mutatedFiles) {
      const norm = canonicalizePath(f);
      if (norm === "src/formatter.js" || norm === "test/formatter.test.js") {
        classification[norm] = "REQUIRED";
      } else {
        classification[norm] = "UNNECESSARY_SCOPE_EXPANSION";
        pass = false;
      }
    }
    return { pass, classification };
  }
  if (taskKey === "investigation") {
    const classification = {};
    let pass = true;
    for (const f of mutatedFiles) {
      const norm = canonicalizePath(f);
      if (norm === "src/parser.js") {
        classification[norm] = "REQUIRED";
      } else if (norm === "test/parser.test.js") {
        classification[norm] = "REQUIRED";
      } else {
        classification[norm] = "UNNECESSARY_SCOPE_EXPANSION";
        pass = false;
      }
    }
    return { pass, classification };
  }
  return { pass: true, classification: {} };
}

/**
 * Investigation Policy B Economy Evaluation.
 * Evaluates Hard and Stretch economy targets for investigation tasks.
 */
export function evaluateInvestigationEconomy(metrics = {}) {
  const hardViolations = [];
  const stretchViolations = [];

  const parentTurns = metrics.parent_model_turns ?? 0;
  const workerTurns = metrics.worker_model_turns ?? 0;
  const totalTurns = metrics.total_model_turns ?? (parentTurns + workerTurns);
  const preMutationTurns = metrics.worker_pre_mutation_turns ?? 0;
  const discoveryTurns = metrics.worker_search_turns ?? metrics.worker_discovery_turns ?? 0;
  const sidequests = metrics.parent_delegated_sidequest_attempts ?? 0;
  const duplicateReads = metrics.duplicate_reads ?? 0;
  const postMutationRereads = metrics.post_mutation_rereads ?? 0;
  const repeatedValidations = metrics.repeated_validation_without_mutation ?? 0;
  const correctionCycles = metrics.correction_cycles ?? 0;
  const firstMutationComplete = Boolean(metrics.first_mutation_complete);

  // HARD targets:
  // parent_model_turns <= 3
  // worker_model_turns <= 9
  // total_model_turns <= 12
  // worker_pre_mutation_turns <= 3
  // worker_discovery_turns <= 1
  // parent_delegated_sidequest_attempts = 0
  // duplicate_reads = 0
  // post_mutation_rereads = 0
  // repeated_validation_without_mutation = 0
  // correction_cycles <= 1
  if (parentTurns > 3) hardViolations.push(`parent_model_turns: ${parentTurns} > 3`);
  if (workerTurns > 9) hardViolations.push(`worker_model_turns: ${workerTurns} > 9`);
  if (totalTurns > 12) hardViolations.push(`total_model_turns: ${totalTurns} > 12`);
  if (preMutationTurns > 3) hardViolations.push(`worker_pre_mutation_turns: ${preMutationTurns} > 3`);
  if (discoveryTurns > 1) hardViolations.push(`worker_discovery_turns: ${discoveryTurns} > 1`);
  if (sidequests > 0) hardViolations.push(`parent_delegated_sidequest_attempts: ${sidequests} > 0`);
  if (duplicateReads > 0) hardViolations.push(`duplicate_reads: ${duplicateReads} > 0`);
  if (postMutationRereads > 0) hardViolations.push(`post_mutation_rereads: ${postMutationRereads} > 0`);
  if (repeatedValidations > 0) hardViolations.push(`repeated_validation_without_mutation: ${repeatedValidations} > 0`);
  if (correctionCycles > 1) hardViolations.push(`correction_cycles: ${correctionCycles} > 1`);

  // STRETCH targets:
  // worker_model_turns <= 8
  // total_model_turns <= 11
  // first_mutation_complete = true
  // correction_cycles = 0
  if (workerTurns > 8) stretchViolations.push(`worker_model_turns: ${workerTurns} > 8`);
  if (totalTurns > 11) stretchViolations.push(`total_model_turns: ${totalTurns} > 11`);
  if (!firstMutationComplete) stretchViolations.push("first_mutation_complete: false");
  if (correctionCycles > 0) stretchViolations.push(`correction_cycles: ${correctionCycles} > 0`);

  const hardPass = hardViolations.length === 0;
  const stretchPass = hardPass && stretchViolations.length === 0;

  return {
    hard_pass: hardPass,
    hard_gate: hardPass ? "PASS" : "FAIL",
    hard_violations: hardViolations,
    stretch_pass: stretchPass,
    stretch_gate: stretchPass ? "PASS" : "MISS",
    stretch_violations: stretchViolations,
  };
}

/**
 * Bounded Factual Correction Gate Evaluation (Policy B).
 * Validates the strict 14-rule discipline for investigation correction cycles.
 */
export function evaluateBoundedFactualCorrection({
  correctionCycles = 0,
  reproductionObserved = true,
  reproductionActor = "WORKER",
  reproductionExitCode = 1,
  firstMutationTargeted = true,
  firstValidationExitCode = 0,
  validationExposedMechanism = true,
  searchesBetweenFailedValidationAndCorrection = 0,
  readsBetweenFailedValidationAndCorrection = 0,
  duplicateReadsBetweenFailedValidationAndCorrection = 0,
  correctiveMutationAddressedFailure = true,
  nextValidationExitCode = 0,
  repeatedValidationWithoutMutation = 0,
  passingValidationsAfter = 0,
  apiShapePreserved = true,
  scopeMinimal = true,
  mutationAttribution = "WORKER",
  acceptanceReusedEvidence = true,
  workerValidationVerified = true,
} = {}) {
  const violations = [];

  if (correctionCycles === 0) {
    if (!reproductionObserved || reproductionExitCode === 0) {
      violations.push("REPRODUCTION_NOT_OBSERVED");
    }
    if (!scopeMinimal) {
      violations.push("SCOPE_EXPANSION");
    }
    if (!apiShapePreserved) {
      violations.push("API_SHAPE_VIOLATION");
    }
    if (repeatedValidationWithoutMutation > 0 || passingValidationsAfter > 0) {
      violations.push("REPEATED_VALIDATION_WITHOUT_MUTATION");
    }
    if (!workerValidationVerified) {
      violations.push("WORKER_VALIDATION_UNVERIFIED");
    }
    const pass = violations.length === 0;
    return {
      pass,
      gate: pass ? "PASS" : "FAIL",
      correction_cycle_gate: pass ? "PASS" : "FAIL",
      bounded_factual_correction_gate: pass ? "PASS" : "FAIL",
      correction_cycles: 0,
      violations,
      details: pass ? "IDEAL_FIRST_PASS" : violations.join(", "),
    };
  }

  // 8. exactly one corrective mutation cycle was required
  if (correctionCycles > 1) {
    violations.push(`EXCESSIVE_CORRECTION_CYCLES: ${correctionCycles} > 1`);
  }

  // 1. factual reproduction occurred before mutation
  if (!reproductionObserved || reproductionExitCode === 0 || (reproductionActor && reproductionActor !== "WORKER")) {
    violations.push("FACTUAL_REPRODUCTION_MISSING");
  }

  // 2. first mutation was based on the observed failure and inspected code
  if (!firstMutationTargeted) {
    violations.push("FIRST_MUTATION_UNFOCUSED");
  }

  // 3. first post-mutation validation produced a factual non-zero exit
  if (firstValidationExitCode === 0) {
    violations.push("FIRST_VALIDATION_DID_NOT_FAIL");
  }

  // 4. the validation exposed a concrete additional mechanism
  if (!validationExposedMechanism) {
    violations.push("NO_CONCRETE_MECHANISM_EXPOSED");
  }

  // 5. no new repository search occurred between failed validation and correction
  if (searchesBetweenFailedValidationAndCorrection > 0) {
    violations.push(`NEW_SEARCH_DURING_CORRECTION: ${searchesBetweenFailedValidationAndCorrection}`);
  }

  // 6. no duplicate file read occurred between failed validation and correction
  if (readsBetweenFailedValidationAndCorrection > 0 || duplicateReadsBetweenFailedValidationAndCorrection > 0) {
    violations.push(`REREAD_DURING_CORRECTION: ${readsBetweenFailedValidationAndCorrection + duplicateReadsBetweenFailedValidationAndCorrection}`);
  }

  // 7. the corrective mutation directly addressed the newly observed failure
  if (!correctiveMutationAddressedFailure) {
    violations.push("CORRECTIVE_MUTATION_UNRELATED");
  }

  // 9. the next required validation passed
  if (nextValidationExitCode !== 0) {
    violations.push(`NEXT_VALIDATION_FAILED: exit code ${nextValidationExitCode}`);
  }

  // 10. no additional passing validations occurred afterward
  if (passingValidationsAfter > 0 || repeatedValidationWithoutMutation > 0) {
    violations.push("REDUNDANT_VALIDATION_AFTER_PASS");
  }

  // 11. API shape remained preserved
  if (!apiShapePreserved) {
    violations.push("API_SHAPE_CHANGED");
  }

  // 12. mutation scope remained minimal
  if (!scopeMinimal) {
    violations.push("SCOPE_EXPANDED");
  }

  // 13. mutation attribution remained FACTUAL / WORKER
  if (mutationAttribution !== "WORKER" && mutationAttribution !== "FACTUAL") {
    violations.push(`INVALID_MUTATION_ATTRIBUTION: ${mutationAttribution}`);
  }

  // 14. fresh evidence was reused for Orchestrator acceptance
  if (!acceptanceReusedEvidence || !workerValidationVerified) {
    violations.push("FRESH_EVIDENCE_NOT_REUSED");
  }

  const pass = violations.length === 0;
  return {
    pass,
    gate: pass ? "PASS" : "FAIL",
    correction_cycle_gate: pass ? "PASS" : "FAIL",
    bounded_factual_correction_gate: pass ? "PASS" : "FAIL",
    correction_cycles: correctionCycles,
    violations,
    details: pass ? "BOUNDED_FACTUAL_CORRECTION_SATISFIED" : violations.join(", "),
  };
}

/**
 * Extracts prohibited parent tool ATTEMPTS during healthy delegated execution.
 */
export function extractParentDelegatedSidequestAttempts(parentTranscriptFile, activeState = {}) {
  const attemptsByTool = {};
  let totalAttempts = 0;
  let deniedCount = 0;
  let succeededCount = 0;
  const attempts = [];

  const PROHIBITED_ROUTINE_TOOLS = new Set([
    "schedule",
    "manage_task",
    "manage_subagents",
    "view_file",
    "grep_search",
    "find_by_name",
    "run_command",
  ]);

  if (parentTranscriptFile && existsSync(parentTranscriptFile)) {
    try {
      const raw = readFileSync(parentTranscriptFile, "utf8").trim();
      const lines = raw ? raw.split("\n") : [];
      const steps = [];
      for (const line of lines) {
        try {
          steps.push(JSON.parse(line));
        } catch {}
      }

      let delegationStepIndex = -1;
      let wakeupStepIndex = Infinity;

      // Identify delegation step (first invoke_subagent)
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)) {
          if (step.tool_calls.some((tc) => tc.name === "invoke_subagent")) {
            delegationStepIndex = i;
            break;
          }
        }
      }

      // Identify reactive wakeup step (system message with worker completion / completion content)
      if (delegationStepIndex !== -1) {
        for (let i = delegationStepIndex + 1; i < steps.length; i++) {
          const step = steps[i];
          const content = String(step.content || "");
          const isCompletionMsg =
            step.type === "SYSTEM_MESSAGE" &&
            (content.includes("STATUS: IMPLEMENTATION_COMPLETE") ||
              content.includes("IMPLEMENTATION_COMPLETE") ||
              content.includes("PRIORITY_HIGH"));
          if (isCompletionMsg) {
            wakeupStepIndex = i;
            break;
          }
        }

        // Analyze parent turns strictly between delegation and wakeup (healthy delegation window)
        for (let i = delegationStepIndex + 1; i < Math.min(wakeupStepIndex, steps.length); i++) {
          const step = steps[i];
          if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)) {
            for (let tcIdx = 0; tcIdx < step.tool_calls.length; tcIdx++) {
              const tc = step.tool_calls[tcIdx];
              const toolName = tc.name || "";
              const toolArgs = tc.args || tc.parameters || {};

              if (PROHIBITED_ROUTINE_TOOLS.has(toolName)) {
                // Check recovery / cancellation exceptions
                const isCancellation =
                  (toolName === "manage_subagents" && (toolArgs.Action === "kill" || toolArgs.Action === "kill_all")) ||
                  (toolName === "manage_task" && toolArgs.Action === "kill");
                const isDiagnosedStalled = Boolean(activeState?.stalled || activeState?.circuitBreakerType === "STALLED");

                if (isCancellation || (toolName === "manage_subagents" && isDiagnosedStalled)) {
                  // Legitimate recovery exception: do NOT count
                  continue;
                }

                // Check if this tool call was denied by pre-tool hook
                let wasDenied = false;
                for (let j = i + 1; j < Math.min(i + 4, steps.length); j++) {
                  const nextStep = steps[j];
                  if (nextStep.type === "PLANNER_RESPONSE") break;
                  const errText = String(nextStep.error || nextStep.content || "");
                  if (
                    nextStep.status === "ERROR" &&
                    (errText.includes("denied by pre-tool hook") || errText.includes("tool call denied"))
                  ) {
                    wasDenied = true;
                    break;
                  }
                }

                totalAttempts++;
                attemptsByTool[toolName] = (attemptsByTool[toolName] || 0) + 1;
                if (wasDenied) {
                  deniedCount++;
                } else {
                  succeededCount++;
                }
                attempts.push({
                  tool: toolName,
                  stepIndex: i,
                  denied: wasDenied,
                  args: toolArgs,
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  // Reconcile with activeState.deniedAttempts
  if (Array.isArray(activeState?.deniedAttempts)) {
    for (const d of activeState.deniedAttempts) {
      if (!attempts.some((a) => a.tool === d.tool && a.denied)) {
        totalAttempts++;
        attemptsByTool[d.tool] = (attemptsByTool[d.tool] || 0) + 1;
        deniedCount++;
        attempts.push({
          tool: d.tool,
          denied: true,
          args: d.args,
        });
      }
    }
  }

  return {
    total_attempts: totalAttempts,
    attempts_by_tool: attemptsByTool,
    denied_count: deniedCount,
    succeeded_count: succeededCount,
    attempts,
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

    let match = null;
    if (matchedCandidates.length === 1) {
      match = matchedCandidates[0];
    } else if (matchedCandidates.length > 1) {
      const firstRole = matchedCandidates[0].role;
      const firstProfile = matchedCandidates[0].profile;
      const allSame = matchedCandidates.every((c) => c.role === firstRole && c.profile === firstProfile);
      if (allSame && firstRole === "REVIEWER") {
        match = matchedCandidates[0];
      }
    }

    if (match) {
      match.consumed = true;
      match.consumedBy = sub?.conversationId || null;
      match.consumedAt = new Date().toISOString();
      resolvedRole = (match.role || "UNKNOWN").toUpperCase();
      resolvedConfidence = (match.role && match.profile) ? "HIGH" : "LOW";
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
            let outputSummary = "";
            for (let j = i + 1; j < Math.min(i + 3, steps.length); j++) {
              const next = steps[j];
              if (next && next.content) {
                const text = String(next.content);
                const m = text.match(/The command exited with code (\d+)/i);
                if (m) {
                  exitCode = parseInt(m[1], 10);
                }
                if (!outputSummary && text.length > 0) {
                  outputSummary = text.slice(0, 1000);
                }
                if (exitCode !== null) break;
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
                outputSummary: outputSummary || null,
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

export function extractReviewerVerdict(text = "") {
  const norm = String(text || "");
  const explicit = norm.match(/(?:^|\n)\s*(?:VERDICT|DECISION|RECOMMENDATION)\s*[:=\-]\s*([^\r\n]+)/im);
  if (!explicit) return null;

  const raw = explicit[1]
    .replace(/[`*_]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (/^(?:ACCEPT_WITH_NOTES|ACCEPT_NOTES|PASS_WITH_NOTES)(?:_|$)/.test(raw)) return "ACCEPT_WITH_NOTES";
  if (/^(?:CHANGES_REQUIRED|CHANGE_REQUIRED|REWORK|RETRY)(?:_|$)/.test(raw)) return "CHANGES_REQUIRED";
  if (/^(?:BLOCK|BLOCKED|REJECT|REJECTED)(?:_|$)/.test(raw)) return "BLOCK";
  if (/^(?:NOT_ACCEPT|DO_NOT_ACCEPT|NO_ACCEPT|NOT_APPROVED|DO_NOT_APPROVE)(?:_|$)/.test(raw)) return null;
  if (/^(?:ACCEPT|ACCEPTED|PASS|PASSED)(?:_|$)/.test(raw)) return "ACCEPT";
  return null;
}

export function computePacketFingerprint(promptText = "") {
  if (!promptText) return "EMPTY";
  const stripped = String(promptText)
    .replace(/Reviewer\s+[AB]\s*[:(][^)]*\)?/gi, "")
    .replace(/Correctness\s+Review/gi, "")
    .replace(/Adversarial\s+Review/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(stripped).digest("hex").slice(0, 16);
}

export function emptyJevMetrics() {
  return {
    jev_calls: 0,
    jev_latency_ms: 0,
    jev_input_tokens: 0,
    jev_candidates: 0,
    jev_ranked_items: 0,
    jev_candidate_bytes: 0,
    jev_selected_bytes: 0,
    potential_context_reduction: 0,
    redundant_tool_candidates: 0,
    rehydration_count: 0,
    false_prune_risk: 0,
    future_use_recall_at_k: 0,
    future_use_precision_at_k: 0,
    critical_reference_recall: 0,
    false_low_relevance: 0,
    tool_reexecution_delta: 0,
    acceptance_delta: 0,
    fallback_identity_failures: 0,
  };
}

export function parseJevShadowTelemetry(targetDir) {
  const path = join(targetDir, ".agents/telemetry/jev-shadow.jsonl");
  if (!existsSync(path)) return emptyJevMetrics();

  let events = [];
  try {
    events = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return emptyJevMetrics();
  }

  const reports = new Map();
  const labels = new Map();
  for (const event of events) {
    if (event?.schema === "orchestra.jev-shadow-report.v1" && event.shadow_id) {
      reports.set(event.shadow_id, event);
    }
    if (event?.schema === "orchestra.jev-shadow-label.v1" && event.shadow_id) {
      labels.set(event.shadow_id, event);
    }
  }
  if (reports.size === 0) return emptyJevMetrics();

  const reportList = [...reports.values()];
  const labeled = reportList.flatMap((report) => {
    const label = labels.get(report.shadow_id);
    return label ? [{ ...report, ...label }] : [];
  });

  const sum = (items, field) => items.reduce((total, event) => (
    total + (typeof event[field] === "number" && Number.isFinite(event[field]) ? event[field] : 0)
  ), 0);
  const avg = (items, field) => items.length > 0
    ? Number((sum(items, field) / items.length).toFixed(6))
    : 0;

  return {
    jev_calls: sum(reportList, "jev_calls"),
    jev_latency_ms: sum(reportList, "jev_latency_ms"),
    jev_input_tokens: sum(reportList, "jev_input_tokens"),
    jev_candidates: sum(reportList, "jev_candidates"),
    jev_ranked_items: sum(reportList, "jev_ranked_items"),
    jev_candidate_bytes: sum(reportList, "jev_candidate_bytes"),
    jev_selected_bytes: sum(reportList, "jev_selected_bytes"),
    potential_context_reduction: avg(reportList, "potential_context_reduction"),
    redundant_tool_candidates: sum(reportList, "redundant_tool_candidates"),
    rehydration_count: sum(reportList, "rehydration_count"),
    false_prune_risk: avg(labeled, "false_prune_risk"),
    future_use_recall_at_k: avg(labeled, "future_use_recall_at_k"),
    future_use_precision_at_k: avg(labeled, "future_use_precision_at_k"),
    critical_reference_recall: avg(labeled, "critical_reference_recall"),
    false_low_relevance: avg(labeled, "false_low_relevance"),
    tool_reexecution_delta: avg(labeled, "tool_reexecution_delta"),
    acceptance_delta: avg(labeled, "acceptance_delta"),
    fallback_identity_failures: sum(reportList, "fallback_identity_failures"),
  };
}

/**
 * Parses AGY telemetry from .agents/state/active-state.json, events.jsonl, and agy JSON output.
 */
export function parseAgyTelemetry(targetDir, rawOutput) {
  const stateFile = join(targetDir, ".agents/state/active-state.json");
  const telemetryFile = join(targetDir, ".agents/telemetry/events.jsonl");
  const jevMetrics = parseJevShadowTelemetry(targetDir);

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
  let parentTranscriptFile = null;
  const workerTurns = [];
  const reviewerTurns = [];
  const reviewers = [];
  const childMutations = [];
  const childValidations = [];
  let childCompletionClaimed = false;

  if (convId) {
    const brainDir = join(homedir(), ".gemini/antigravity-cli/brain", convId);
    parentTranscriptFile = join(brainDir, ".system_generated/logs/transcript.jsonl");
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
                  reviewers.push({
                    conversationId: sub.conversationId,
                    role: childRole,
                    profile: childEv.profile || "flash-reviewer",
                    model: (roleBindings?.bindings?.[sub.conversationId]?.model) || "gemini-3.8-flash-high",
                    confidence: childEv.confidence || "HIGH",
                    source: childEv.source || "RUNTIME_IDENTITY",
                    turns: childTurns,
                    mutations: childEv.mutations || [],
                    validations: childEv.validations || [],
                    transcriptFile: childTranscriptFile,
                  });
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

  const sidequestAttempts = extractParentDelegatedSidequestAttempts(parentTranscriptFile, state);

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
        if (workerSeenMutation && mutationsSinceLastValidation === 0) {
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

  const firstChildMutationStep = childMutations.length > 0
    ? Math.min(...childMutations.map((m) => (typeof m.stepIndex === "number" ? m.stepIndex : 999999)))
    : 999999;
  const reproductionVal = childValidations.find(
    (v) => typeof v.stepIndex === "number" && v.stepIndex < firstChildMutationStep
  );
  const reproductionObserved = Boolean(reproductionVal && reproductionVal.exitCode !== 0);
  const reproductionActor = reproductionVal ? reproductionVal.actorRole : null;
  const reproductionExitCode = reproductionVal ? reproductionVal.exitCode : null;
  const reproductionCommand = reproductionVal ? reproductionVal.command : null;
  const reproductionOutputSummary = reproductionVal ? reproductionVal.outputSummary : null;

  const postMutationValidations = childValidations.filter(
    (v) => typeof v.stepIndex === "number" && v.stepIndex > firstChildMutationStep
  );
  const firstPostMutationVal = postMutationValidations.length > 0 ? postMutationValidations[0] : null;
  const firstPostMutationValidationExitCode = firstPostMutationVal ? firstPostMutationVal.exitCode : null;

  let searchesBetweenValidationAndCorrection = 0;
  let readsBetweenValidationAndCorrection = 0;
  let correctionCycles = 0;

  if (firstPostMutationVal && firstPostMutationVal.exitCode !== 0) {
    const secondMutation = childMutations.find(
      (m) => typeof m.stepIndex === "number" && m.stepIndex > firstPostMutationVal.stepIndex
    );
    if (secondMutation) {
      correctionCycles = 1;
      if (workerTurns && workerTurns.length > 0) {
        workerTurns.forEach((t) => {
          const tStep = typeof t.lineIndex === "number" ? t.lineIndex : -1;
          if (tStep > firstPostMutationVal.stepIndex && tStep < secondMutation.stepIndex) {
            (t.tools || []).forEach((tc) => {
              if (["grep_search", "find_by_name", "list_dir"].includes(tc.name)) searchesBetweenValidationAndCorrection++;
              if (["view_file", "read_url_content"].includes(tc.name)) readsBetweenValidationAndCorrection++;
            });
          }
        });
      }
      const subsequentFailedVals = postMutationValidations.filter(
        (v) => typeof v.stepIndex === "number" && v.stepIndex > secondMutation.stepIndex && v.exitCode !== 0
      );
      if (subsequentFailedVals.length > 0) {
        correctionCycles += subsequentFailedVals.length;
      }
    }
  } else if (workerMutationTurns > 1) {
    correctionCycles = Math.max(0, workerMutationTurns - 1);
  }

  const reviewerInvocations = reviewers.length > 0 ? reviewers.length : (state.reviewer_invocations || 0);
  const reviewerConversationIds = reviewers.map((r) => r.conversationId);
  const distinctReviewerConversations = reviewerConversationIds.length >= 2 && new Set(reviewerConversationIds).size === reviewerConversationIds.length;
  const reviewerProfiles = reviewers.map((r) => r.profile);
  const reviewerModels = reviewers.map((r) => r.model);
  const reviewerRoles = reviewers.map((r) => r.role);
  const reviewerIdentityConfidences = reviewers.map((r) => r.confidence);
  const reviewerIdentitySources = reviewers.map((r) => r.source);

  let reviewerAPrompt = "";
  let reviewerBPrompt = "";
  let reviewerAResponse = "";
  let reviewerBResponse = "";
  let reviewerATranscriptText = "";
  let reviewerBTranscriptText = "";
  let reviewerAVerdict = null;
  let reviewerBVerdict = null;

  if (reviewers.length >= 1) {
    try {
      const rawA = readFileSync(reviewers[0].transcriptFile, "utf8");
      reviewerATranscriptText = rawA;
      for (const line of rawA.trim().split("\n")) {
        try {
          const step = JSON.parse(line);
          if (step.type === "USER_INPUT" && !reviewerAPrompt) reviewerAPrompt = step.content || "";
          if (step.type === "PLANNER_RESPONSE" && step.content) reviewerAResponse = step.content;
        } catch {}
      }
      reviewerAVerdict = extractReviewerVerdict(reviewerAResponse);
    } catch {}
  }

  if (reviewers.length >= 2) {
    try {
      const rawB = readFileSync(reviewers[1].transcriptFile, "utf8");
      reviewerBTranscriptText = rawB;
      for (const line of rawB.trim().split("\n")) {
        try {
          const step = JSON.parse(line);
          if (step.type === "USER_INPUT" && !reviewerBPrompt) reviewerBPrompt = step.content || "";
          if (step.type === "PLANNER_RESPONSE" && step.content) reviewerBResponse = step.content;
        } catch {}
      }
      reviewerBVerdict = extractReviewerVerdict(reviewerBResponse);
    } catch {}
  }

  const reviewPacketFingerprintA = computePacketFingerprint(reviewerAPrompt);
  const reviewPacketFingerprintB = computePacketFingerprint(reviewerBPrompt);
  const sharedFactualPacketMatch = Boolean(
    reviewerAPrompt &&
    reviewerBPrompt &&
    reviewerAPrompt.includes("src/parser.js") &&
    reviewerBPrompt.includes("src/parser.js")
  );

  const reviewerACrossTalk = Boolean(
    reviewers.length >= 2 &&
    (reviewerATranscriptText.includes(reviewers[1].conversationId) ||
      (reviewerBVerdict && reviewerATranscriptText.includes(`verdict: ${reviewerBVerdict}`)))
  );
  const reviewerBCrossTalk = Boolean(
    reviewers.length >= 2 &&
    (reviewerBTranscriptText.includes(reviewers[0].conversationId) ||
      (reviewerAVerdict && reviewerBTranscriptText.includes(`verdict: ${reviewerAVerdict}`)))
  );

  const thirdReviewerCount = Math.max(0, reviewerInvocations - 2);

  let consensusResolution = null;
  let consensusNextState = null;
  if (reviewerAVerdict && reviewerBVerdict) {
    try {
      const evalRes = evaluateTwoKeyReview({}, reviewerAVerdict, reviewerBVerdict);
      consensusResolution = evalRes.decision;
      consensusNextState = evalRes.nextState;
    } catch {}
  }

  const reviewerAWrites = (reviewers[0]?.mutations || []).length;
  const reviewerBWrites = (reviewers[1]?.mutations || []).length;
  const reviewerShellMutations = 0;

  const twoReviewersGate = reviewerInvocations === 2 ? "PASS" : "FAIL";
  const distinctIdentityGate = distinctReviewerConversations ? "PASS" : "FAIL";
  const reviewerRouteGate = (
    reviewerProfiles.length === 2 &&
    reviewerProfiles.every((p) => p === "flash-reviewer") &&
    reviewerModels.every((m) => m === "gemini-3.8-flash-high")
  ) ? "PASS" : "FAIL";
  const factualIdentityGate = (
    reviewerRoles.length === 2 &&
    reviewerRoles.every((r) => r === "REVIEWER") &&
    reviewerIdentityConfidences.every((c) => c === "HIGH")
  ) ? "PASS" : "FAIL";
  const independenceGate = (!reviewerACrossTalk && !reviewerBCrossTalk && reviewerInvocations === 2) ? "PASS" : "FAIL";
  const readOnlyGate = (
    reviewerAWrites === 0 &&
    reviewerBWrites === 0 &&
    (state.orchestratorWorkspaceWrites || 0) === 0 &&
    (state.unknownWorkspaceWrites || 0) === 0
  ) ? "PASS" : "FAIL";
  const consensusGate = (consensusResolution !== null && thirdReviewerCount === 0) ? "PASS" : "FAIL";
  const twoKeyFidelityGate = (
    twoReviewersGate === "PASS" &&
    distinctIdentityGate === "PASS" &&
    reviewerRouteGate === "PASS" &&
    factualIdentityGate === "PASS" &&
    independenceGate === "PASS" &&
    readOnlyGate === "PASS" &&
    consensusGate === "PASS"
  ) ? "PASS" : "FAIL";

  return {
    model_turns_total: totalModelTurns,
    model_invocations: totalModelTurns,
    parent_model_turns: parentModelTurns,
    parent_invocations: parentModelTurns,
    worker_model_turns: workerModelTurns,
    worker_invocations: workerModelTurns,
    reviewer_model_turns: reviewerModelTurns,
    reviewer_invocations: reviewerInvocations,
    reviewer_conversation_ids: reviewerConversationIds,
    distinct_reviewer_conversations: distinctReviewerConversations,
    reviewer_profiles: reviewerProfiles,
    reviewer_models: reviewerModels,
    reviewer_roles: reviewerRoles,
    reviewer_identity_confidences: reviewerIdentityConfidences,
    reviewer_identity_sources: reviewerIdentitySources,
    review_packet_fingerprints: [reviewPacketFingerprintA, reviewPacketFingerprintB],
    review_packet_fingerprint_a: reviewPacketFingerprintA,
    review_packet_fingerprint_b: reviewPacketFingerprintB,
    shared_factual_packet_match: sharedFactualPacketMatch,
    reviewer_a_verdict: reviewerAVerdict,
    reviewer_b_verdict: reviewerBVerdict,
    reviewer_a_cross_talk: reviewerACrossTalk,
    reviewer_b_cross_talk: reviewerBCrossTalk,
    reviewer_a_workspace_writes: reviewerAWrites,
    reviewer_b_workspace_writes: reviewerBWrites,
    reviewer_shell_mutations: reviewerShellMutations,
    consensus_resolution: consensusResolution,
    final_state: consensusNextState,
    third_reviewer_count: thirdReviewerCount,
    two_key_fidelity_gate: twoKeyFidelityGate,
    independence_gate: independenceGate,
    read_only_gate: readOnlyGate,
    consensus_gate: consensusGate,
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
    ...jevMetrics,
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
    parent_delegated_sidequest_attempts: sidequestAttempts.total_attempts,
    parent_delegated_sidequest_attempts_by_tool: sidequestAttempts.attempts_by_tool,
    parent_delegated_sidequest_denied: sidequestAttempts.denied_count,
    parent_delegated_sidequest_succeeded: sidequestAttempts.succeeded_count,
    schedule_attempts_during_delegation: sidequestAttempts.attempts_by_tool["schedule"] || 0,
    manage_task_poll_attempts: sidequestAttempts.attempts_by_tool["manage_task"] || 0,
    manage_subagent_poll_attempts: sidequestAttempts.attempts_by_tool["manage_subagents"] || 0,
    parent_workspace_read_attempts: sidequestAttempts.attempts_by_tool["view_file"] || 0,
    parent_repository_search_attempts: (sidequestAttempts.attempts_by_tool["grep_search"] || 0) + (sidequestAttempts.attempts_by_tool["find_by_name"] || 0),
    parent_validation_attempts: sidequestAttempts.attempts_by_tool["run_command"] || 0,
    parent_per_turn_tool_counts: parentMetrics?.per_turn_tool_counts || (parentToolCalls > 0 ? [parentToolCalls] : [0]),
    worker_per_turn_tool_counts: workerMetrics?.per_turn_tool_counts || (workerToolCalls > 0 ? [workerToolCalls] : []),
    reproduction_observed: reproductionObserved,
    reproduction_actor: reproductionActor,
    reproduction_exit_code: reproductionExitCode,
    reproduction_command: reproductionCommand,
    reproduction_output_summary: reproductionOutputSummary,
    correction_cycles: correctionCycles,
    first_post_mutation_validation_exit_code: firstPostMutationValidationExitCode,
    searches_between_validation_and_correction: searchesBetweenValidationAndCorrection,
    reads_between_validation_and_correction: readsBetweenValidationAndCorrection,
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
        parent_delegated_sidequest_attempts: 0,
        parent_delegated_sidequest_attempts_by_tool: {},
        parent_delegated_sidequest_denied: 0,
        parent_delegated_sidequest_succeeded: 0,
        schedule_attempts_during_delegation: 0,
        manage_task_poll_attempts: 0,
        manage_subagent_poll_attempts: 0,
        parent_workspace_read_attempts: 0,
        parent_repository_search_attempts: 0,
        parent_validation_attempts: 0,
        zero_parent_sidequests_gate: "PASS",
        parent_zero_attempt_gate: "PASS",
        api_signature_before: {},
        api_signature_after: {},
        api_signature_changed: false,
        scope_minimality_audit: {},
        api_shape_preservation_gate: "PASS",
        scope_minimality_gate: "PASS",
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
    const verification = taskDef.verify(tempDir, stdout, metrics);

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

    const targetAuditFiles = taskKey === "investigation"
      ? ["src/parser.js"]
      : ["src/formatter.js", "src/calculator.js"];
    const sigAudit = auditApiSignatures(fixtureSource, tempDir, targetAuditFiles);
    const mutatedPaths = (metrics.mutation_events || []).map((m) => m.path).filter(Boolean);
    const uniqueMutatedFiles = [...new Set(mutatedPaths)];
    const scopeAudit = auditScopeMinimality(uniqueMutatedFiles, taskKey);

    const zeroParentSidequestsGate = (metrics.parent_delegated_sidequest_attempts || 0) === 0 ? "PASS" : "FAIL";
    const parentZeroAttemptGate = ((metrics.parent_delegated_sidequest_attempts || 0) === 0 && (metrics.parent_model_turns || 0) <= 3) ? "PASS" : "FAIL";
    const apiShapePreservationGate = (!sigAudit.changed && verification.success) ? "PASS" : "FAIL";
    const scopeMinimalityGate = scopeAudit.pass ? "PASS" : "FAIL";
    const reproductionGate = (taskKey !== "investigation")
      ? "PASS"
      : ((metrics.reproduction_observed && metrics.reproduction_actor === "WORKER" && metrics.reproduction_exit_code !== 0) ? "PASS" : "FAIL");
    const inputGrammarPreservationGate = (taskKey !== "investigation")
      ? "PASS"
      : (verification.grammar_preservation_passed ? "PASS" : "FAIL");
    const precisionPreservationGate = (taskKey !== "investigation")
      ? "PASS"
      : (verification.precision_preservation_passed ? "PASS" : "FAIL");
    const testIntegrityGate = (taskKey !== "investigation")
      ? "PASS"
      : (verification.test_integrity_passed ? "PASS" : "FAIL");
    const functionalGate = (taskKey !== "investigation")
      ? (verification.success ? "PASS" : "FAIL")
      : (verification.functional_passed ? "PASS" : "FAIL");
    const routingGate = (fidelity.expectedRoute?.worker === fidelity.observed?.worker && (fidelity.fidelityStatus === "PASS" || fidelity.status === "PASS")) ? "PASS" : "FAIL";
    const rootCauseGate = (metrics.worker_completion_claimed && verification.success) ? "PASS" : "FAIL";
    const fidelityGate = (fidelity.fidelityStatus === "PASS" && fidelity.confidence === "HIGH") ? "PASS" : "FAIL";

    const correctionCycles = metrics.correction_cycles ?? Math.max(0, (metrics.worker_mutation_turns || 0) - 1);
    const firstMutationComplete = taskKey !== "investigation"
      ? true
      : ((metrics.worker_mutation_turns || 0) === 1 && verification.success && correctionCycles === 0);
    const firstMutationCompleteness = firstMutationComplete ? "PASS" : "MISS";

    const investigationEconomy = evaluateInvestigationEconomy({
      ...metrics,
      correction_cycles: correctionCycles,
      first_mutation_complete: firstMutationComplete,
    });

    const boundedCorrection = evaluateBoundedFactualCorrection({
      correctionCycles,
      reproductionObserved: metrics.reproduction_observed ?? true,
      reproductionActor: metrics.reproduction_actor ?? "WORKER",
      reproductionExitCode: metrics.reproduction_exit_code ?? 1,
      firstMutationTargeted: scopeAudit.pass,
      firstValidationExitCode: correctionCycles > 0 ? (metrics.first_post_mutation_validation_exit_code ?? 1) : 0,
      validationExposedMechanism: true,
      searchesBetweenFailedValidationAndCorrection: metrics.searches_between_validation_and_correction ?? 0,
      readsBetweenFailedValidationAndCorrection: metrics.reads_between_validation_and_correction ?? 0,
      duplicateReadsBetweenFailedValidationAndCorrection: metrics.duplicate_reads ?? 0,
      correctiveMutationAddressedFailure: true,
      nextValidationExitCode: metrics.worker_validation_exit_code ?? (verification.success ? 0 : 1),
      repeatedValidationWithoutMutation: metrics.repeated_validation_without_mutation ?? 0,
      passingValidationsAfter: 0,
      apiShapePreserved: !sigAudit.changed,
      scopeMinimal: scopeAudit.pass,
      mutationAttribution: fidelity.mutationAttributionMode === "FACTUAL" ? "FACTUAL" : (fidelity.observed?.mutationActor || "WORKER"),
      acceptanceReusedEvidence: metrics.worker_validation_fresh ?? true,
      workerValidationVerified: metrics.worker_validation_verified ?? true,
    });

    const investigationHardEconomyGate = (taskKey !== "investigation") ? "PASS" : investigationEconomy.hard_gate;
    const investigationStretchEconomy = (taskKey !== "investigation") ? "PASS" : investigationEconomy.stretch_gate;
    const boundedFactualCorrectionGate = (taskKey !== "investigation") ? "PASS" : boundedCorrection.gate;
    const workerEconomyGate = investigationHardEconomyGate;
    const firstMutationCompletenessGate = firstMutationCompleteness;
    const validationCompletionGate = ((metrics.repeated_validation_without_mutation || 0) === 0 && (metrics.worker_validation_verified || false)) ? "PASS" : "FAIL";
    const parentSameTurnDelegationGate = ((metrics.parent_pre_delegation_turns || 0) <= 1 && (metrics.parent_model_turns || 0) <= 3) ? "PASS" : "FAIL";

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
      first_mutation_complete: firstMutationComplete,
      api_signature_before: sigAudit.before,
      api_signature_after: sigAudit.after,
      api_signature_changed: sigAudit.changed,
      scope_minimality_audit: scopeAudit.classification,
      zero_parent_sidequests_gate: zeroParentSidequestsGate,
      parent_zero_attempt_gate: parentZeroAttemptGate,
      parent_same_turn_delegation_gate: parentSameTurnDelegationGate,
      api_shape_preservation_gate: apiShapePreservationGate,
      api_shape_gate: apiShapePreservationGate,
      scope_minimality_gate: scopeMinimalityGate,
      reproduction_gate: reproductionGate,
      input_grammar_preservation_gate: inputGrammarPreservationGate,
      precision_preservation_gate: precisionPreservationGate,
      test_integrity_gate: testIntegrityGate,
      functional_gate: functionalGate,
      routing_gate: routingGate,
      root_cause_gate: rootCauseGate,
      worker_economy_gate: workerEconomyGate,
      investigation_hard_economy_gate: investigationHardEconomyGate,
      investigation_stretch_economy: investigationStretchEconomy,
      bounded_factual_correction_gate: boundedFactualCorrectionGate,
      first_mutation_completeness: firstMutationCompleteness,
      first_mutation_completeness_gate: firstMutationCompletenessGate,
      correction_cycles: correctionCycles,
      validation_completion_gate: validationCompletionGate,
      fidelity_gate: fidelityGate,
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
          if ((res.parent_delegated_sidequest_attempts || 0) > 0) {
            console.error(`PARENT_SIDEQUEST_ATTEMPT_FAILED: ${runtime} on ${taskKey} had prohibited parent sidequest attempts after delegation: ${res.parent_delegated_sidequest_attempts} attempts (${JSON.stringify(res.parent_delegated_sidequest_attempts_by_tool)})`);
            hasFidelityFailure = true;
          }
          if ((taskKey === "multi" || taskKey === "investigation") && res.api_signature_changed) {
            console.error(`API_SIGNATURE_FAILED: ${runtime} on ${taskKey} changed exported API signatures: ${JSON.stringify(res.api_signature_after)}`);
            hasFidelityFailure = true;
          }
          if ((taskKey === "multi" || taskKey === "investigation") && res.scope_minimality_gate === "FAIL") {
            console.error(`SCOPE_MINIMALITY_FAILED: ${runtime} on ${taskKey} mutated files outside required scope: ${JSON.stringify(res.scope_minimality_audit)}`);
            hasFidelityFailure = true;
          }
          if (taskKey === "investigation") {
            if (res.input_grammar_preservation_gate === "FAIL") {
              console.error(`INPUT_GRAMMAR_PRESERVATION_FAILED: ${runtime} on ${taskKey} newly accepted unrelated syntax`);
              hasFidelityFailure = true;
            }
            if (res.precision_preservation_gate === "FAIL") {
              console.error(`PRECISION_PRESERVATION_FAILED: ${runtime} on ${taskKey} suffered arbitrary precision truncation`);
              hasFidelityFailure = true;
            }
            if (res.investigation_hard_economy_gate === "FAIL" || res.worker_economy_gate === "FAIL") {
              console.error(`WORKER_ECONOMY_FAILED: ${runtime} on ${taskKey} exceeded worker turn economy targets`);
              hasFidelityFailure = true;
            }
            if (res.bounded_factual_correction_gate === "FAIL") {
              console.error(`BOUNDED_FACTUAL_CORRECTION_FAILED: ${runtime} on ${taskKey} failed bounded factual correction gate`);
              hasFidelityFailure = true;
            }
            if (res.parent_zero_attempt_gate === "FAIL") {
              console.error(`PARENT_ZERO_ATTEMPT_FAILED: ${runtime} on ${taskKey} failed parent zero attempt gate`);
              hasFidelityFailure = true;
            }
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
