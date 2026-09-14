import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { findReusableEvidence, verifyWorkerValidation } from "../skills/agy-orchestra/routing-policy.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function parseWorkspacePath(p) {
  if (!p || typeof p !== "string") return "";
  if (p.startsWith("file://")) {
    try {
      return fileURLToPath(p);
    } catch {
      return p.replace(/^file:\/\/\/?/, "");
    }
  }
  return p;
}

function getWorkspacePaths(payload = {}) {
  const cwd = process.cwd();
  let repoRoot;
  const rawWs = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (Array.isArray(payload.workspaceUris) && payload.workspaceUris[0])
    || null;
  if (rawWs) {
    repoRoot = resolve(parseWorkspacePath(rawWs));
  } else if (basename(cwd) === ".agents") {
    repoRoot = resolve(cwd, "..");
  } else if (existsSync(resolve(cwd, ".agents"))) {
    repoRoot = cwd;
  } else if (existsSync(resolve(cwd, "../.agents"))) {
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

function syncChildEvidence(activeState, parentConvId) {
  if (!parentConvId) return;
  try {
    const brainDir = join(homedir(), ".gemini/antigravity-cli/brain", parentConvId);
    const subagentsDir = join(brainDir, ".system_generated/subagents");
    if (!existsSync(subagentsDir)) return;

    const files = readdirSync(subagentsDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let sub;
      try {
        sub = JSON.parse(readFileSync(join(subagentsDir, f), "utf-8"));
      } catch {
        continue;
      }
      if (!sub?.conversationId) continue;

      const childTranscriptFile = join(
        homedir(),
        ".gemini/antigravity-cli/brain",
        sub.conversationId,
        ".system_generated/logs/transcript.jsonl"
      );
      if (!existsSync(childTranscriptFile)) continue;

      const content = readFileSync(childTranscriptFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const steps = [];
      for (const line of lines) {
        try {
          steps.push(JSON.parse(line));
        } catch {}
      }

      if (!Array.isArray(activeState.evidenceLedger)) {
        activeState.evidenceLedger = [];
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || !Array.isArray(step.tool_calls)) continue;
        for (const tc of step.tool_calls) {
          const toolName = tc.name;
          const args = tc.args || tc.parameters || {};

          if (toolName === "run_command") {
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

            const isTestCmd = /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(cmd) || cmd.includes("node --test");
            if (isTestCmd && typeof exitCode === "number") {
              const syntheticEv = {
                executionId: `exec-${sub.conversationId}-${i}`,
                command: cmd,
                exitCode,
                mutationSeq: activeState.mutationSeq || 0,
                actorRole: "WORKER",
                actorId: sub.conversationId,
                conversationId: sub.conversationId,
                confidence: "HIGH",
                evidenceSource: "CHILD_TRANSCRIPT",
                timestamp: step.created_at || new Date().toISOString(),
                type: "TEST_RUN",
              };

              const existingIdx = activeState.evidenceLedger.findIndex(
                (e) => e && e.command === cmd && e.actorRole === "WORKER"
              );
              if (existingIdx >= 0) {
                activeState.evidenceLedger[existingIdx] = syntheticEv;
              } else {
                activeState.evidenceLedger.push(syntheticEv);
              }

              activeState.workerValidationObserved = true;
              activeState.workerValidationCommand = cmd;
              activeState.workerValidationExitCode = exitCode;
              activeState.workerValidationActor = "WORKER";
            }
          } else if (toolName === "send_message") {
            const msg = String(args.Message || "");
            if (msg.includes("IMPLEMENTATION_COMPLETE")) {
              activeState.workerCompletionClaimed = true;
              activeState.implementationComplete = true;
              activeState.handoffObserved = true;
              activeState.worker_packet_bytes = (activeState.worker_packet_bytes || 0) + Buffer.byteLength(msg, "utf-8");
            }
          }
        }
      }
    }
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

  const { repoRoot, statePath, telemetryPath } = getWorkspacePaths(payload);

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

  // Turn Diet: If worker completed and validation was observed,
  // Orchestrator concluding turn automatically accepts work deterministically
  const roleBindingsPath = resolve(repoRoot, ".agents/state/role-bindings.json");
  let roleBindings = { mainConversationId: null, bindings: {} };
  if (existsSync(roleBindingsPath)) {
    try { roleBindings = JSON.parse(readFileSync(roleBindingsPath, "utf-8")); } catch {}
  }
  const convId = payload.conversationId || activeState.conversationId || roleBindings.mainConversationId || null;
  const bound = (convId && roleBindings.bindings && roleBindings.bindings[convId]) || null;
  const activeRole = (bound && bound.role) || activeState.activeRole || "ORCHESTRATOR";

  const isOrchestrator = (activeRole === "ORCHESTRATOR" || activeRole === "FLASH_ORCHESTRATOR");

  // Sync child execution evidence from brain transcripts if available
  syncChildEvidence(activeState, convId);

  // Re-evaluate worker validation verification against authoritative Evidence Ledger
  const valEval = verifyWorkerValidation(activeState);
  activeState.workerValidationVerified = valEval.verified;
  activeState.workerValidationFresh = valEval.fresh;
  if (valEval.verified && valEval.evidence) {
    activeState.workerValidationExecutionId = valEval.evidence.executionId || activeState.workerValidationExecutionId;
    activeState.workerValidationCommand = valEval.evidence.command || activeState.workerValidationCommand;
    activeState.workerValidationExitCode = valEval.evidence.exitCode ?? activeState.workerValidationExitCode;
    activeState.workerValidationActor = valEval.evidence.actorRole || activeState.workerValidationActor;
  }

  const completionClaimed = activeState.workerCompletionClaimed === true
    || (activeState.implementationComplete === true && activeState.handoffObserved === true);

  const noScopeViolation = !activeState.scopeViolation && !activeState.forbiddenAccessDetected;
  const noUnresolvedWrites = (activeState.orchestratorWorkspaceWrites || 0) === 0
    && (activeState.unknownWorkspaceWrites || 0) === 0;

  // Hardened Turn Diet acceptance: Orchestrator automatically accepts if and only if
  // 1. Worker claimed completion
  // 2. Required fresh validation evidence from WORKER (exitCode 0) is verified in ledger
  // 3. No scope violation
  // 4. No unresolved workspace writes
  // 5. Orchestrator concluding turn
  const canAccept = isOrchestrator
    && completionClaimed
    && valEval.verified
    && noScopeViolation
    && noUnresolvedWrites;

  if (canAccept) {
    if (!activeState.acceptanceState || activeState.acceptanceState !== "ACCEPTED") {
      activeState.acceptanceState = "ACCEPTED";
      activeState.acceptanceActor = "ORCHESTRATOR";
      activeState.acceptanceObserved = true;
      activeState.state = "DONE";
      try {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
      } catch {}
    }
  }

  // 2. Terminal states are always safe to stop
  const safeTerminalStates = ["DONE", "HUMAN_GATE", "BLOCKED"];
  const currentState = String(activeState.state || "").toUpperCase();
  const isTerminalState = safeTerminalStates.includes(currentState);

  const claimedComplete = activeState.claimCompleted === true
    || activeState.status === "COMPLETED"
    || activeState.implementationComplete === true
    || activeState.workerCompletionClaimed === true;

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
    let reasonKey = "CLAIMED_WITHOUT_ACCEPTANCE";
    let reasonMsg = "STOP_BLOCKED: Completion claimed but acceptance state is not ACCEPTED. Orchestrator must formally verify evidence and accept task.";

    if (!valEval.verified) {
      reasonKey = "EVIDENCE_MISSING";
      reasonMsg = `STOP_BLOCKED: Completion claimed by worker, but required fresh validation evidence is not satisfied (${valEval.reason || "EVIDENCE_MISSING"}). MODEL CLAIM IS NOT EVIDENCE.`;
    } else if (!noUnresolvedWrites) {
      reasonKey = "UNRESOLVED_WRITES";
      reasonMsg = "STOP_BLOCKED: Workspace writes by orchestrator or unknown actors detected. Separation of duties violated.";
    } else if (!noScopeViolation) {
      reasonKey = "SCOPE_VIOLATION";
      reasonMsg = "STOP_BLOCKED: Scope violation detected during implementation.";
    }

    activeState.forced_continuations_by_reason[reasonKey] =
      (activeState.forced_continuations_by_reason[reasonKey] || 0) + 1;

    if (activeState.lastStopBlockedReason === reasonKey) {
      const count = (activeState.stopBlockedCount || 1) + 1;
      if (count >= 2) {
        activeState.state = "HUMAN_GATE";
        activeState.circuitBreakerType = "STOP_GUARD_STALLED";
        activeState.stopGuardStalled = true;
        try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
        recordStopTelemetry(telemetryPath, activeState, payload, "continue", reasonKey);
        console.log(JSON.stringify({
          decision: "continue",
          reason: `STOP_GUARD_STALLED: ${reasonKey} repeated without forward progress. Halting to HUMAN_GATE.`
        }));
        return;
      }
      activeState.stopBlockedCount = count;
    } else {
      activeState.lastStopBlockedReason = reasonKey;
      activeState.stopBlockedCount = 1;
    }
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}

    recordStopTelemetry(telemetryPath, activeState, payload, "continue", reasonKey);
    console.log(JSON.stringify({
      decision: "continue",
      reason: reasonMsg
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
