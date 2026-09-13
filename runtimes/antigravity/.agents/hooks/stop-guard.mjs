import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { findReusableEvidence } from "../skills/agy-orchestra/routing-policy.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function getWorkspacePaths(payload = {}) {
  const cwd = process.cwd();
  let repoRoot;
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) {
    repoRoot = resolve(payload.workspacePaths[0]);
  } else if (basename(cwd) === ".agents") {
    repoRoot = resolve(cwd, "..");
  } else if (existsSync(resolve(cwd, "packages"))) {
    repoRoot = cwd;
  } else if (existsSync(resolve(cwd, "../packages"))) {
    repoRoot = resolve(cwd, "..");
  } else {
    repoRoot = cwd;
  }
  return {
    repoRoot,
    statePath: resolve(repoRoot, ".agents/state/active-state.json"),
    telemetryPath: resolve(repoRoot, ".agents/telemetry/events.jsonl"),
  };
}

function recordStopTelemetry(telemetryPath, activeState, payload, decision, continuationReason = null) {
  try {
    mkdirSync(dirname(telemetryPath), { recursive: true });
    const stopEvent = {
      timestamp: new Date().toISOString(),
      type: "STOP_HOOK",
      decision,
      terminationReason: payload.terminationReason || null,
      error: payload.error || null,
      fullyIdle: payload.fullyIdle ?? true,
      state: activeState.state || null,
      acceptanceState: activeState.acceptanceState || null,
      conversationId: payload.conversationId || activeState.conversationId || null,
      benchmarkRunId: activeState.benchmarkRunId || null,
      taskId: activeState.taskId || null,
      stop_attempts: activeState.stop_attempts || 0,
      clean_stops: activeState.clean_stops || 0,
      forced_stop_continuations: activeState.forced_stop_continuations || 0,
      forced_continuation_reason: continuationReason,
      forced_continuations_by_reason: activeState.forced_continuations_by_reason || {},
    };
    appendFileSync(telemetryPath, JSON.stringify(stopEvent) + "\n", "utf-8");
  } catch {}
}

function main() {
  const rawInput = readStdin();
  let payload = {};
  if (rawInput.trim()) {
    try {
      payload = JSON.parse(rawInput);
    } catch {}
  }

  const { statePath, telemetryPath } = getWorkspacePaths(payload);

  let activeState = {};
  if (existsSync(statePath)) {
    try {
      activeState = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {}
  }

  const benchmarkRunId = process.env.BENCHMARK_RUN_ID || payload.benchmarkRunId || activeState.benchmarkRunId || null;
  const taskId = process.env.BENCHMARK_TASK_ID || payload.taskId || activeState.taskId || null;
  if (benchmarkRunId) activeState.benchmarkRunId = benchmarkRunId;
  if (taskId) activeState.taskId = taskId;

  // Turn economy observational counters
  activeState.stop_attempts = (activeState.stop_attempts || 0) + 1;
  activeState.stop_hook_calls = activeState.stop_attempts;
  activeState.forced_continuations_by_reason = activeState.forced_continuations_by_reason || {};

  // 1. If background tasks are running (fullyIdle: false), allow stop cleanly
  // so the runtime can yield and wait for Reactive Wakeup upon task completion.
  if (payload.fullyIdle === false) {
    activeState.clean_stops = (activeState.clean_stops || 0) + 1;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
    } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "stop");
    console.log(JSON.stringify({ decision: "stop" }));
    return;
  }

  // 2. Terminal states are always safe to stop
  const safeTerminalStates = ["DONE", "HUMAN_GATE", "BLOCKED"];
  const currentState = String(activeState.state || "").toUpperCase();
  const isTerminalState = safeTerminalStates.includes(currentState);

  const claimedComplete = activeState.claimCompleted === true
    || activeState.status === "COMPLETED"
    || activeState.implementationComplete === true;

  const formalAccepted = activeState.acceptanceState === "ACCEPTED"
    || activeState.acceptanceResult === "ACCEPTED"
    || activeState.state === "DONE";

  const isDirectAction = activeState.taskAction === "DIRECT_ACTION" || activeState.isDirectAction === true;

  const contract = activeState.scopeContract || {};
  const requiredTests = contract.testsRequired || activeState.testsRequired || [];
  const evidenceLedger = activeState.evidenceLedger || [];

  // 3. Check for claimed completion without formal acceptance (product implementations only)
  if (claimedComplete && !formalAccepted && !isTerminalState && !isDirectAction) {
    activeState.forced_stop_continuations = (activeState.forced_stop_continuations || 0) + 1;
    activeState.forced_continuations_by_reason["CLAIMED_WITHOUT_ACCEPTANCE"] =
      (activeState.forced_continuations_by_reason["CLAIMED_WITHOUT_ACCEPTANCE"] || 0) + 1;

    if (activeState.lastStopBlockedReason === "CLAIMED_WITHOUT_ACCEPTANCE") {
      const count = (activeState.stopBlockedCount || 1) + 1;
      if (count >= 2) {
        activeState.state = "HUMAN_GATE";
        activeState.circuitBreakerType = "STOP_GUARD_STALLED";
        activeState.stopGuardStalled = true;
        try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
        recordStopTelemetry(telemetryPath, activeState, payload, "continue", "CLAIMED_WITHOUT_ACCEPTANCE");
        console.log(JSON.stringify({
          decision: "continue",
          reason: "STOP_GUARD_STALLED: Completion claimed without acceptance repeated without forward progress. Halting to HUMAN_GATE."
        }));
        return;
      }
      activeState.stopBlockedCount = count;
    } else {
      activeState.lastStopBlockedReason = "CLAIMED_WITHOUT_ACCEPTANCE";
      activeState.stopBlockedCount = 1;
    }
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}

    recordStopTelemetry(telemetryPath, activeState, payload, "continue", "CLAIMED_WITHOUT_ACCEPTANCE");
    console.log(JSON.stringify({
      decision: "continue",
      reason: "STOP_BLOCKED: Completion claimed but acceptance state is not ACCEPTED. Orchestrator must formally verify evidence and accept task."
    }));
    return;
  }

  // 4. Check for required tests in Evidence Ledger (must be fresh, product tasks only)
  if (!isDirectAction && activeState.requireEvidenceBeforeStop === true && requiredTests.length > 0 && !isTerminalState) {
    const missingTests = requiredTests.filter((testCmd) => {
      const result = findReusableEvidence(
        evidenceLedger,
        testCmd,
        activeState.mutationSeq || 0,
        activeState.mutations || []
      );
      return !result.reusable;
    });

    if (missingTests.length > 0) {
      activeState.forced_stop_continuations = (activeState.forced_stop_continuations || 0) + 1;
      activeState.forced_continuations_by_reason["EVIDENCE_MISSING"] =
        (activeState.forced_continuations_by_reason["EVIDENCE_MISSING"] || 0) + 1;

      const missingKey = missingTests.slice().sort().join("|");
      if (activeState.lastStopBlockedReason === missingKey) {
        const count = (activeState.stopBlockedCount || 1) + 1;
        if (count >= 2) {
          activeState.state = "HUMAN_GATE";
          activeState.circuitBreakerType = "STOP_GUARD_STALLED";
          activeState.stopGuardStalled = true;
          try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
          recordStopTelemetry(telemetryPath, activeState, payload, "continue", "EVIDENCE_MISSING");
          console.log(JSON.stringify({
            decision: "continue",
            reason: "STOP_GUARD_STALLED: Identical missing evidence repeated without new runtime evidence. Halting to HUMAN_GATE."
          }));
          return;
        }
        activeState.stopBlockedCount = count;
      } else {
        activeState.lastStopBlockedReason = missingKey;
        activeState.stopBlockedCount = 1;
      }
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}

      const missingList = missingTests.map(t => `- ${t}`).join("\n");
      recordStopTelemetry(telemetryPath, activeState, payload, "continue", "EVIDENCE_MISSING");
      console.log(JSON.stringify({
        decision: "continue",
        reason: `EVIDENCE_MISSING:\n${missingList}`
      }));
      return;
    }
  }

  // Clear stall tracking on clean stop
  if (activeState.stopBlockedCount || activeState.lastStopBlockedReason) {
    delete activeState.stopBlockedCount;
    delete activeState.lastStopBlockedReason;
  }

  activeState.clean_stops = (activeState.clean_stops || 0) + 1;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
  } catch {}

  // 5. Record telemetry
  recordStopTelemetry(telemetryPath, activeState, payload, "stop");

  console.log(JSON.stringify({ decision: "stop" }));
}

main();
