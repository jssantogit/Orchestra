import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyExecutionEvidence,
  planVerificationBatch,
  createInitialToolMix,
} from "../skills/agy-orchestra/routing-policy.mjs";

function getWorkspacePaths(customStatePath = null) {
  const cwd = process.cwd();
  const repoRoot = existsSync(resolve(cwd, "packages"))
    ? cwd
    : (existsSync(resolve(cwd, "../packages")) ? resolve(cwd, "..") : cwd);
  return {
    repoRoot,
    statePath: customStatePath ? resolve(cwd, customStatePath) : resolve(repoRoot, ".agents/state/active-state.json"),
  };
}

export function executeVerificationBatch(steps = [], options = {}) {
  const { repoRoot, statePath } = getWorkspacePaths(options.statePath);

  let activeState = options.activeState || null;
  if (!activeState && existsSync(statePath)) {
    try {
      activeState = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      activeState = {};
    }
  }
  if (!activeState) {
    activeState = {};
  }
  if (!activeState.toolMix) {
    activeState.toolMix = createInitialToolMix();
  }
  if (!Array.isArray(activeState.evidenceLedger)) {
    activeState.evidenceLedger = [];
  }

  const batchPlan = planVerificationBatch(activeState, steps);
  const results = [];
  const stepStatusMap = new Map();

  // Mark initially skipped steps (reused evidence)
  for (const skipped of batchPlan.skippedSteps) {
    stepStatusMap.set(skipped.id, {
      id: skipped.id,
      status: "REUSED",
      passed: true,
      skipReason: skipped.skipReason,
      reusableEvidenceId: skipped.reusableEvidenceId,
    });
    results.push({
      id: skipped.id,
      command: skipped.command,
      status: "REUSED",
      passed: true,
      durationMs: 0,
      skipReason: skipped.skipReason,
    });
  }

  activeState.toolMix.verification_batches = (activeState.toolMix.verification_batches || 0) + 1;

  let overallSuccess = true;

  for (const step of batchPlan.plannedSteps) {
    // Check dependency
    if (step.dependsOn) {
      const depStatus = stepStatusMap.get(step.dependsOn);
      if (!depStatus || !depStatus.passed) {
        stepStatusMap.set(step.id, { id: step.id, status: "SKIPPED_PREREQUISITE_FAILED", passed: false });
        results.push({
          id: step.id,
          command: step.command,
          status: "SKIPPED_PREREQUISITE_FAILED",
          passed: false,
          durationMs: 0,
          reason: `Prerequisite step '${step.dependsOn}' failed or was skipped`,
        });
        continue;
      }
    }

    activeState.toolMix.verification_batch_steps = (activeState.toolMix.verification_batch_steps || 0) + 1;
    const startTime = Date.now();
    let exitCode = 0;
    let output = "";
    let passed = true;

    const defaultShell = process.platform === "win32"
      ? (existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash")
      : "/bin/bash";

    try {
      output = execSync(step.command, {
        cwd: options.cwd || repoRoot,
        shell: options.shell || process.env.SHELL || defaultShell,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 5 * 1024 * 1024,
      });
    } catch (err) {
      exitCode = typeof err.status === "number" ? err.status : 1;
      output = `${err.stdout || ""}\n${err.stderr || ""}\n${err.message || ""}`.trim();
      passed = false;
      overallSuccess = false;
    }

    const durationMs = Date.now() - startTime;
    stepStatusMap.set(step.id, { id: step.id, status: passed ? "PASSED" : "FAILED", passed });

    // Output snippet: compact summary
    const snippet = passed
      ? (output.slice(-300).trim() || "OK")
      : (output.slice(-1500).trim() || "FAILED");

    const execId = `batch-${Date.now()}-${step.id}`;
    const evidence = classifyExecutionEvidence(
      step.command,
      exitCode,
      snippet,
      durationMs,
      null,
      execId,
      activeState.mutationSeq || 0
    );

    if (step.scope) {
      evidence.scope = step.scope;
    }

    // Record into evidence ledger
    const existingIdx = activeState.evidenceLedger.findIndex(
      (e) => e && e.command === evidence.command && e.type === evidence.type && e.scope === evidence.scope
    );
    if (existingIdx >= 0) {
      activeState.evidenceLedger[existingIdx] = evidence;
    } else {
      activeState.evidenceLedger.push(evidence);
    }

    results.push({
      id: step.id,
      command: step.command,
      status: passed ? "PASSED" : "FAILED",
      passed,
      exitCode,
      durationMs,
      evidenceId: evidence.id,
      snippet,
    });
  }

  // Persist state if requested or if not in-memory only
  if (options.persist !== false && statePath) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
    } catch {}
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => r.status === "FAILED").length;
  const skippedCount = results.filter((r) => r.status.startsWith("SKIPPED") || r.status === "REUSED").length;
  const totalDuration = results.reduce((acc, r) => acc + (r.durationMs || 0), 0);

  return {
    success: overallSuccess && failedCount === 0,
    results,
    summary: {
      total: steps.length,
      passed: passedCount,
      failed: failedCount,
      skipped: skippedCount,
      totalDurationMs: totalDuration,
      evidenceCount: results.filter((r) => r.evidenceId).length,
    },
    activeState,
  };
}

export function formatBatchSummary(batchResult) {
  const lines = ["=== VERIFICATION BATCH RESULTS ==="];
  for (const r of batchResult.results) {
    if (r.status === "PASSED") {
      lines.push(`[PASS] ${r.id} (${r.durationMs}ms)`);
    } else if (r.status === "REUSED") {
      lines.push(`[REUSE] ${r.id} (fresh evidence reused)`);
    } else if (r.status === "FAILED") {
      lines.push(`[FAIL] ${r.id} (exitCode: ${r.exitCode}, ${r.durationMs}ms)`);
      if (r.snippet) {
        lines.push(`       ${r.snippet.split("\n")[0]}`);
      }
    } else {
      lines.push(`[SKIP] ${r.id} (${r.reason || r.status})`);
    }
  }
  const s = batchResult.summary;
  lines.push(`Summary: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped. Total: ${s.totalDurationMs}ms.`);
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  let steps = [];
  let jsonOutput = false;
  let customState = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--steps" && args[i + 1]) {
      try {
        steps = JSON.parse(args[i + 1]);
        i++;
      } catch (err) {
        console.error("Invalid JSON for --steps:", err.message);
        process.exit(1);
      }
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--state" && args[i + 1]) {
      customState = args[i + 1];
      i++;
    } else if (args[i] === "--file" && args[i + 1]) {
      try {
        steps = JSON.parse(readFileSync(args[i + 1], "utf-8"));
        i++;
      } catch (err) {
        console.error("Error reading steps file:", err.message);
        process.exit(1);
      }
    }
  }

  if (steps.length === 0) {
    console.error("No verification steps specified. Use --steps '<json>' or --file <path>");
    process.exit(1);
  }

  const result = executeVerificationBatch(steps, { statePath: customState });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatBatchSummary(result));
  }

  if (!result.success) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
