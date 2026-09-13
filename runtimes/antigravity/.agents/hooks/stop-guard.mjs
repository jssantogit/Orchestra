import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { findReusableEvidence } from "../skills/agy-orchestra/routing-policy.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function getWorkspacePaths() {
  const cwd = process.cwd();
  const repoRoot = existsSync(resolve(cwd, "packages"))
    ? cwd
    : (existsSync(resolve(cwd, "../packages")) ? resolve(cwd, "..") : cwd);
  return {
    repoRoot,
    statePath: resolve(repoRoot, ".agents/state/active-state.json"),
    telemetryPath: resolve(repoRoot, ".agents/telemetry/events.jsonl"),
  };
}

function main() {
  const rawInput = readStdin();
  let payload = {};
  if (rawInput.trim()) {
    try {
      payload = JSON.parse(rawInput);
    } catch {}
  }

  const { statePath, telemetryPath } = getWorkspacePaths();

  let activeState = {};
  if (existsSync(statePath)) {
    try {
      activeState = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {}
  }

  // 1. If background tasks are running (fullyIdle: false), allow stop cleanly
  // so the runtime can yield and wait for Reactive Wakeup upon task completion.
  if (payload.fullyIdle === false) {
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
    if (activeState.lastStopBlockedReason === "CLAIMED_WITHOUT_ACCEPTANCE") {
      const count = (activeState.stopBlockedCount || 1) + 1;
      if (count >= 2) {
        activeState.state = "HUMAN_GATE";
        activeState.circuitBreakerType = "STOP_GUARD_STALLED";
        activeState.stopGuardStalled = true;
        try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
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
      const missingKey = missingTests.slice().sort().join("|");
      if (activeState.lastStopBlockedReason === missingKey) {
        const count = (activeState.stopBlockedCount || 1) + 1;
        if (count >= 2) {
          activeState.state = "HUMAN_GATE";
          activeState.circuitBreakerType = "STOP_GUARD_STALLED";
          activeState.stopGuardStalled = true;
          try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
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
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
  }

  // 5. Record telemetry
  try {
    mkdirSync(dirname(telemetryPath), { recursive: true });
    const stopEvent = {
      timestamp: new Date().toISOString(),
      type: "STOP_HOOK",
      terminationReason: payload.terminationReason || null,
      error: payload.error || null,
      fullyIdle: payload.fullyIdle ?? true,
      state: activeState.state || null,
      acceptanceState: activeState.acceptanceState || null,
      conversationId: payload.conversationId || activeState.conversationId || null,
    };
    appendFileSync(telemetryPath, JSON.stringify(stopEvent) + "\n", "utf-8");
  } catch {}

  console.log(JSON.stringify({ decision: "stop" }));
}

main();
