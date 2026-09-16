import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findReusableEvidence, verifyWorkerValidation, classifyShellMutation, isWorkerRole } from "../skills/agy-orchestra/routing-policy.mjs";

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

function isStepMutation(step) {
  if (!step || !Array.isArray(step.tool_calls)) return false;
  for (const tc of step.tool_calls) {
    const toolName = tc.name;
    if (toolName === "write_to_file" || toolName === "replace_file_content" || toolName === "edit_file" || toolName === "create_file") {
      return true;
    }
    if (toolName === "run_command") {
      const args = tc.args || tc.parameters || {};
      const cmd = String(args.CommandLine || args.command || args.cmd || "").replace(/^["']|["']$/g, "").trim();
      if (cmd) {
        const mut = classifyShellMutation(cmd);
        if (mut.isMutation) return true;
      }
    }
  }
  return false;
}

export function syncChildEvidence(activeState, parentConvId, options = {}) {
  if (!parentConvId) return;
  try {
    const brainBaseDir = options.brainBaseDir || process.env.AGY_BRAIN_DIR || join(homedir(), ".gemini/antigravity-cli/brain");
    const brainDir = join(brainBaseDir, parentConvId);
    const subagentsDir = join(brainDir, ".system_generated/subagents");
    if (!existsSync(subagentsDir)) return;

    const repoRoot = options.repoRoot || getWorkspacePaths().repoRoot;
    const roleBindingsPath = options.roleBindingsPath || resolve(repoRoot, ".agents/state/role-bindings.json");

    let roleBindings = options.roleBindings || null;
    if (!roleBindings) {
      if (existsSync(roleBindingsPath)) {
        try { roleBindings = JSON.parse(readFileSync(roleBindingsPath, "utf-8")); } catch {}
      }
    }
    if (!roleBindings) {
      roleBindings = { mainConversationId: null, bindings: {}, conversations: {} };
    }

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
      const childConvId = sub.conversationId;

      let roleBindingsModified = false;

      // 1. Exact role binding for child conversation
      let binding = (roleBindings.bindings && roleBindings.bindings[childConvId])
        || (roleBindings.conversations && roleBindings.conversations[childConvId])
        || null;

      if (!binding && Array.isArray(roleBindings.pendingSubagents) && roleBindings.pendingSubagents.length > 0) {
        // Step 1: Filter candidates by available scope:
        // parentConversationId === current parent
        // taskIdentifier/taskId === current task
        // benchmarkRunId === current run
        let candidates = roleBindings.pendingSubagents.filter((p) => !p.consumed);
        if (parentConvId) {
          candidates = candidates.filter((p) => !p.parentConversationId || p.parentConversationId === parentConvId);
        }
        const activeTaskId = activeState.taskId || activeState.taskKey || options.taskId || null;
        if (activeTaskId) {
          candidates = candidates.filter((p) => !(p.taskIdentifier || p.taskId) || (p.taskIdentifier || p.taskId) === activeTaskId);
        }
        const activeRunId = activeState.benchmarkRunId || options.benchmarkRunId || null;
        if (activeRunId) {
          candidates = candidates.filter((p) => !p.benchmarkRunId || p.benchmarkRunId === activeRunId);
        }

        // Step 2: Use role/profile evidence from descriptor
        const descTypeName = sub.subagentDescriptor?.typeName || "";
        const descRole = String(sub.subagentDescriptor?.role || "").toLowerCase();

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

        // Deterministic rule: exactly 1 valid candidate -> bind; 0 or >1 ambiguous -> UNKNOWN (fail closed, never guess)
        if (matchedCandidates.length === 1) {
          const match = matchedCandidates[0];
          const consumedAt = new Date().toISOString();
          match.consumed = true;
          match.consumedBy = childConvId;
          match.consumedAt = consumedAt;

          const boundRecord = {
            conversationId: childConvId,
            role: match.role || "WORKER",
            profile: match.profile || match.typeName || descTypeName || "flash-low-worker",
            model: match.model || null,
            parentConversationId: match.parentConversationId || parentConvId,
            taskIdentifier: match.taskIdentifier || activeTaskId || null,
            benchmarkRunId: match.benchmarkRunId || activeRunId || null,
            confidence: "HIGH",
            source: "RUNTIME_IDENTITY",
            consumed: true,
            consumedBy: childConvId,
            consumedAt,
          };
          if (!roleBindings.bindings) roleBindings.bindings = {};
          if (!roleBindings.conversations) roleBindings.conversations = {};
          roleBindings.bindings[childConvId] = boundRecord;
          roleBindings.conversations[childConvId] = boundRecord;
          binding = boundRecord;
          roleBindingsModified = true;
        }
      }

      if (roleBindingsModified) {
        try {
          mkdirSync(dirname(roleBindingsPath), { recursive: true });
          writeFileSync(roleBindingsPath, JSON.stringify(roleBindings, null, 2), "utf-8");
        } catch {}
      }

      if (binding) {
        if (binding.parentConversationId && binding.parentConversationId !== parentConvId) {
          continue;
        }
        const activeTaskId = activeState.taskId || activeState.taskKey || options.taskId || null;
        if ((binding.taskIdentifier || binding.taskId) && activeTaskId) {
          const bTask = binding.taskIdentifier || binding.taskId;
          if (bTask !== activeTaskId) continue;
        }
        const activeRunId = activeState.benchmarkRunId || options.benchmarkRunId || null;
        if (binding.benchmarkRunId && activeRunId) {
          if (binding.benchmarkRunId !== activeRunId) continue;
        }
      }

      // Child Identity Resolution
      let childRole = "UNKNOWN";
      let childConfidence = "LOW";
      let childProfile = sub.subagentDescriptor?.typeName || sub.subagentDescriptor?.role || null;

      if (binding) {
        childRole = (binding.role || "UNKNOWN").toUpperCase();
        childConfidence = binding.confidence === "HIGH" ? "HIGH" : "MEDIUM";
        childProfile = binding.profile || childProfile;
      }

      const childTranscriptFile = join(
        brainBaseDir,
        childConvId,
        ".system_generated/logs/transcript.jsonl"
      );
      if (!existsSync(childTranscriptFile)) continue;

      let content = "";
      try {
        content = readFileSync(childTranscriptFile, "utf-8");
      } catch {
        continue;
      }
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

      // Collect mutation step indices
      const mutationStepIndices = [];
      for (let i = 0; i < steps.length; i++) {
        if (isStepMutation(steps[i])) {
          mutationStepIndices.push(i);
        }
      }

      let lastWorkerValidationEv = null;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || !Array.isArray(step.tool_calls)) continue;
        for (let tIdx = 0; tIdx < step.tool_calls.length; tIdx++) {
          const tc = step.tool_calls[tIdx];
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
            if (isTestCmd) {
              const stepIdx = typeof step.step_index === "number" ? step.step_index : i;
              const transcriptEvidenceId = `child:${childConvId}:step:${stepIdx}:tool:${tIdx}`;
              const latestMutationStepBeforeValidation = mutationStepIndices.filter((idx) => idx < i).pop() ?? null;
              const mutationAfterValidation = mutationStepIndices.some((idx) => idx > i);
              const fresh = !mutationAfterValidation && exitCode === 0;

              const ev = {
                executionId: null,
                transcriptEvidenceId,
                command: cmd,
                exitCode,
                mutationSeq: null,
                actorRole: childRole,
                actorId: childConvId,
                conversationId: childConvId,
                confidence: childConfidence,
                evidenceSource: "CHILD_TRANSCRIPT",
                transcriptStepIndex: stepIdx,
                latestMutationStepBeforeValidation,
                mutationAfterValidation,
                fresh,
                timestamp: step.created_at || new Date().toISOString(),
                type: "TEST_RUN",
              };

              // Deduplicate strictly by transcriptEvidenceId or non-null executionId
              const existingIdx = activeState.evidenceLedger.findIndex((e) => {
                if (!e) return false;
                if (e.transcriptEvidenceId && e.transcriptEvidenceId === transcriptEvidenceId) return true;
                if (e.executionId && ev.executionId && e.executionId === ev.executionId) return true;
                return false;
              });

              if (existingIdx >= 0) {
                activeState.evidenceLedger[existingIdx] = ev;
              } else {
                activeState.evidenceLedger.push(ev);
              }

              if (isWorkerRole(childRole)) {
                lastWorkerValidationEv = ev;
              } else if (childRole === "REVIEWER") {
                activeState.reviewerValidationObserved = true;
                activeState.reviewerValidationCommand = cmd;
                activeState.reviewerValidationExitCode = exitCode;
              } else {
                activeState.unknownValidationObserved = true;
                activeState.unknownValidationCommand = cmd;
                activeState.unknownValidationExitCode = exitCode;
              }
            }
          } else if (toolName === "send_message") {
            const msg = String(args.Message || "");
            if (msg.includes("IMPLEMENTATION_COMPLETE")) {
              if (isWorkerRole(childRole)) {
                activeState.workerCompletionClaimed = true;
                activeState.implementationComplete = true;
                activeState.handoffObserved = true;
                activeState.worker_packet_bytes = (activeState.worker_packet_bytes || 0) + Buffer.byteLength(msg, "utf-8");
              }
            }
          }
        }
      }

      if (lastWorkerValidationEv) {
        activeState.workerValidationObserved = true;
        activeState.workerValidationCommand = lastWorkerValidationEv.command;
        activeState.workerValidationExitCode = lastWorkerValidationEv.exitCode;
        activeState.workerValidationActor = "WORKER";
        // Observability
        activeState.child_evidence_source = "CHILD_TRANSCRIPT";
        activeState.child_identity_role = childRole;
        activeState.child_identity_confidence = childConfidence;
        activeState.child_validation_step = lastWorkerValidationEv.transcriptStepIndex;
        activeState.child_last_mutation_step = lastWorkerValidationEv.latestMutationStepBeforeValidation;
        activeState.child_mutation_after_validation = lastWorkerValidationEv.mutationAfterValidation;
        activeState.child_evidence_fresh = lastWorkerValidationEv.fresh;
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
  syncChildEvidence(activeState, convId, { repoRoot, roleBindings });

  // Re-evaluate worker validation verification against authoritative Evidence Ledger
  const valEval = verifyWorkerValidation(activeState);
  activeState.workerValidationVerified = valEval.verified;
  activeState.workerValidationFresh = valEval.fresh;
  if (valEval.verified && valEval.evidence) {
    activeState.workerValidationExecutionId = valEval.evidence.executionId || null;
    activeState.workerValidationTranscriptEvidenceId = valEval.evidence.transcriptEvidenceId || null;
    activeState.workerValidationCommand = valEval.evidence.command || activeState.workerValidationCommand;
    activeState.workerValidationExitCode = valEval.evidence.exitCode ?? activeState.workerValidationExitCode;
    activeState.workerValidationActor = valEval.evidence.actorRole || activeState.workerValidationActor;
  } else {
    activeState.workerValidationExecutionId = null;
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
