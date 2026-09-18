import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findReusableEvidence, verifyWorkerValidation, classifyShellMutation, isWorkerRole } from "../skills/agy-orchestra/routing-policy.mjs";
import { recordDecisionOutcome } from "../dream/outcome-recorder.mjs";
import {
  factualSubagentMatchesPending,
  filterFactualPendingCandidates,
  isSymmetricReviewerSet,
} from "./child-identity.mjs";

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

      const activeTaskId = activeState.taskId || activeState.taskKey || options.taskId || process.env.BENCHMARK_TASK_ID || null;
      const activeRunId = activeState.benchmarkRunId || options.benchmarkRunId || process.env.BENCHMARK_RUN_ID || null;

      // A provisional hook-payload correlation is authorization context, not factual
      // runtime identity. Upgrade it only when this exact child exists in the parent
      // brain and the factual descriptor/spawn metadata matches the originating pending slot.
      if (binding && binding.source !== "RUNTIME_IDENTITY") {
        const pending = Array.isArray(roleBindings.pendingSubagents)
          ? roleBindings.pendingSubagents.find((p) => p.seq === binding.pendingSeq)
          : null;
        if (pending && factualSubagentMatchesPending(sub, pending)) {
          binding.confidence = "HIGH";
          binding.source = "RUNTIME_IDENTITY";
          binding.factualIdentityAt = new Date().toISOString();
          if (!roleBindings.bindings) roleBindings.bindings = {};
          if (!roleBindings.conversations) roleBindings.conversations = {};
          roleBindings.bindings[childConvId] = binding;
          roleBindings.conversations[childConvId] = binding;
          roleBindingsModified = true;
        }
      }

      if (!binding && Array.isArray(roleBindings.pendingSubagents) && roleBindings.pendingSubagents.length > 0) {
        const matchedCandidates = filterFactualPendingCandidates({
          pendingSubagents: roleBindings.pendingSubagents,
          record: sub,
          parentConversationId: parentConvId,
          taskId: activeTaskId,
          benchmarkRunId: activeRunId,
        });

        let match = null;
        let slotAssignment = null;
        if (matchedCandidates.length === 1) {
          match = matchedCandidates[0];
        } else if (isSymmetricReviewerSet(matchedCandidates)) {
          // Reviewer slots are permission- and policy-equivalent. The exact child
          // identity is factual; only the A/B slot label is symmetric.
          match = matchedCandidates.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
          slotAssignment = "SYMMETRIC_REVIEW_SLOT";
        }

        if (match) {
          const consumedAt = new Date().toISOString();
          match.consumed = true;
          match.consumedBy = childConvId;
          match.consumedAt = consumedAt;

          const childRole = match.role || null;
          const childProfile = match.profile || match.typeName || sub.subagentDescriptor?.typeName || null;

          const boundRecord = {
            conversationId: childConvId,
            role: childRole || "UNKNOWN",
            profile: childProfile || null,
            model: match.model || null,
            parentConversationId: match.parentConversationId || parentConvId,
            taskIdentifier: match.taskIdentifier || activeTaskId || null,
            benchmarkRunId: match.benchmarkRunId || activeRunId || null,
            originToolCallId: match.originToolCallId || match.toolCallId || null,
            originStepIdx: match.originStepIdx ?? null,
            pendingSeq: match.seq ?? null,
            delegationKind: match.delegationKind || null,
            decisionCorrelationKey: match.decisionCorrelationKey || null,
            decisionType: match.decisionType || null,
            decisionBranchOrdinal: match.decisionBranchOrdinal ?? null,
            confidence: "HIGH",
            source: "RUNTIME_IDENTITY",
            slotAssignment,
            factualIdentityAt: new Date().toISOString(),
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

function finalizeInvestigationFromStop(activeState, payload, repoRoot, roleBindings) {
  const inFlight = activeState.investigationInFlight;
  if (!inFlight || payload.fullyIdle !== true) {
    return { matched: false, reason: "NOT_TERMINAL_INVESTIGATION_STOP" };
  }

  const childConversationId = payload.conversationId || null;
  const parentConversationId = inFlight.parentConversationId
    || inFlight.parent_conversation_id
    || inFlight.conversationId
    || inFlight.conversation_id
    || null;

  // Parent yield/finalization can never masquerade as child completion.
  if (!childConversationId || childConversationId === parentConversationId) {
    return { matched: false, reason: "PARENT_OR_MISSING_CHILD_IDENTITY" };
  }

  const binding = (roleBindings.bindings && roleBindings.bindings[childConversationId])
    || (roleBindings.conversations && roleBindings.conversations[childConversationId])
    || null;
  if (!binding) {
    return { matched: false, reason: "CHILD_BINDING_NOT_FOUND" };
  }
  if (binding.confidence !== "HIGH" || binding.source !== "RUNTIME_IDENTITY") {
    return { matched: false, reason: "CHILD_IDENTITY_NOT_FACTUAL" };
  }

  if (binding.parentConversationId && parentConversationId && binding.parentConversationId !== parentConversationId) {
    return { matched: false, reason: "PARENT_IDENTITY_MISMATCH" };
  }
  if (binding.delegationKind !== "INVESTIGATION") {
    return { matched: false, reason: "NOT_INVESTIGATION_DELEGATION" };
  }

  const inFlightToolCallId = inFlight.toolCallId || inFlight.tool_call_id || null;
  const originToolCallId = binding.originToolCallId || binding.toolCallId || null;
  if (!inFlightToolCallId || !originToolCallId || inFlightToolCallId !== originToolCallId) {
    return { matched: false, reason: "ORIGIN_TOOL_CALL_MISMATCH" };
  }

  const expectedChildId = inFlight.childConversationId
    || inFlight.child_conversation_id
    || inFlight.subagentId
    || inFlight.subagent_id
    || null;
  if (expectedChildId && expectedChildId !== childConversationId) {
    return { matched: false, reason: "CHILD_IDENTITY_MISMATCH" };
  }

  const activeTaskId = activeState.taskId || activeState.taskKey || null;
  if ((binding.taskIdentifier || binding.taskId) && activeTaskId) {
    const boundTaskId = binding.taskIdentifier || binding.taskId;
    if (boundTaskId !== activeTaskId) {
      return { matched: false, reason: "TASK_IDENTITY_MISMATCH" };
    }
  }
  if (binding.benchmarkRunId && activeState.benchmarkRunId && binding.benchmarkRunId !== activeState.benchmarkRunId) {
    return { matched: false, reason: "RUN_IDENTITY_MISMATCH" };
  }

  const terminationReason = String(payload.terminationReason || "");
  const failed = Boolean(
    payload.error ||
    payload.cancelled ||
    /(?:error|fail|cancel|kill|abort|max[_ -]?step|timeout)/i.test(terminationReason)
  );

  const correlationKey = inFlight.correlationKey || inFlight.correlation_key || null;
  let dreamOutcome = null;
  if (correlationKey) {
    dreamOutcome = recordDecisionOutcome({
      repoRoot,
      correlationKey,
      outcome: {
        result: failed
          ? { status: "FAILED", termination_reason: terminationReason || null, error: payload.error || null }
          : { status: "COMPLETED", child_conversation_id: childConversationId },
        evidence_summary: activeState.evidenceSummary || activeState.evidence || {},
        retry_state: {
          attempt: activeState.attempt || 0,
          retry_remaining: activeState.retry_remaining ?? activeState.remainingAttempts ?? 0,
          retry_reason: activeState.retryReason || activeState.retry_reason || null,
        },
        cost_metrics: {
          tool_calls: activeState.tool_calls || 0,
          context_proxy_bytes: activeState.context_proxy_bytes || 0,
        },
        terminal_state: failed ? "FAILED" : "UNKNOWN",
      },
    });
  }

  activeState.post_investigation = !failed;
  activeState.postInvestigation = !failed;
  activeState.investigationCompletion = {
    childConversationId,
    parentConversationId,
    originToolCallId,
    terminationReason: terminationReason || null,
    success: !failed,
    completedAt: new Date().toISOString(),
    dreamOutcomeRecorded: Boolean(dreamOutcome?.recorded),
    dreamOutcomeReason: dreamOutcome?.reason || null,
  };
  delete activeState.investigationInFlight;

  return { matched: true, success: !failed, dreamOutcome };
}

function finalizeDirectInvestigationDecisionFromStop(activeState, payload, repoRoot, roleBindings) {
  const inFlight = activeState.directInvestigationDecisionInFlight;
  if (!inFlight || payload.fullyIdle !== true) {
    return { matched: false, reason: "NO_TERMINAL_DIRECT_INVESTIGATION_DECISION" };
  }

  const childConversationId = payload.conversationId || null;
  if (!childConversationId || inFlight.childConversationId !== childConversationId) {
    return { matched: false, reason: "DIRECT_INVESTIGATION_CHILD_MISMATCH" };
  }

  const binding = (roleBindings.bindings && roleBindings.bindings[childConversationId])
    || (roleBindings.conversations && roleBindings.conversations[childConversationId])
    || null;
  if (!binding || binding.confidence !== "HIGH" || binding.source !== "RUNTIME_IDENTITY" || binding.delegationKind !== "WORK") {
    return { matched: false, reason: "DIRECT_INVESTIGATION_CHILD_NOT_FACTUAL" };
  }

  const terminationReason = String(payload.terminationReason || "");
  const failed = Boolean(
    payload.error ||
    payload.cancelled ||
    /(?:error|fail|cancel|kill|abort|max[_ -]?step|timeout)/i.test(terminationReason)
  );

  const outcome = recordDecisionOutcome({
    repoRoot,
    correlationKey: inFlight.correlationKey,
    outcome: {
      result: failed
        ? {
            status: "FAILED",
            chosen_action: "IMPLEMENT_DIRECT",
            child_conversation_id: childConversationId,
            termination_reason: terminationReason || null,
            error: payload.error || null,
          }
        : {
            status: "COMPLETED",
            chosen_action: "IMPLEMENT_DIRECT",
            child_conversation_id: childConversationId,
            termination_reason: terminationReason || null,
          },
      evidence_summary: activeState.evidenceSummary || activeState.evidence || {
        tests: activeState.workerValidationVerified ? "PASS" : "UNKNOWN",
        typecheck: "UNKNOWN",
        build: "UNKNOWN",
        validation_fresh: Boolean(activeState.workerValidationFresh),
        scope_check: "UNKNOWN",
      },
      retry_state: {
        attempt: activeState.attempt || 0,
        retry_remaining: activeState.retry_remaining ?? activeState.remainingAttempts ?? 0,
        retry_reason: activeState.retryReason || activeState.retry_reason || null,
      },
      cost_metrics: {
        tool_calls: activeState.tool_calls || 0,
        context_proxy_bytes: activeState.context_proxy_bytes || 0,
      },
      terminal_state: failed ? "FAILED" : "UNKNOWN",
    },
  });

  activeState.directInvestigationDecisionCompletion = {
    childConversationId,
    correlationKey: inFlight.correlationKey,
    success: !failed,
    outcomeRecorded: Boolean(outcome?.recorded),
    outcomeReason: outcome?.reason || null,
    completedAt: new Date().toISOString(),
  };
  delete activeState.directInvestigationDecisionInFlight;

  return { matched: true, success: !failed, outcome };
}

function finalizeDelegatedDecisionFromStop(activeState, payload, repoRoot, roleBindings) {
  if (payload.fullyIdle !== true) {
    return { matched: false, reason: "NOT_TERMINAL_DELEGATION_STOP" };
  }

  const childConversationId = payload.conversationId || null;
  if (!childConversationId) {
    return { matched: false, reason: "MISSING_CHILD_IDENTITY" };
  }

  const binding = (roleBindings.bindings && roleBindings.bindings[childConversationId])
    || (roleBindings.conversations && roleBindings.conversations[childConversationId])
    || null;
  if (!binding) {
    return { matched: false, reason: "CHILD_BINDING_NOT_FOUND" };
  }
  if (binding.confidence !== "HIGH" || binding.source !== "RUNTIME_IDENTITY") {
    return { matched: false, reason: "CHILD_IDENTITY_NOT_FACTUAL" };
  }
  if (binding.delegationKind !== "WORK" || !binding.decisionCorrelationKey) {
    return { matched: false, reason: "NO_FACTUAL_WORK_DECISION" };
  }

  const mainConversationId = roleBindings.mainConversationId || activeState.conversationId || null;
  if (binding.parentConversationId && mainConversationId && binding.parentConversationId !== mainConversationId) {
    return { matched: false, reason: "PARENT_IDENTITY_MISMATCH" };
  }

  const activeTaskId = activeState.taskId || activeState.taskKey || null;
  if ((binding.taskIdentifier || binding.taskId) && activeTaskId) {
    const boundTaskId = binding.taskIdentifier || binding.taskId;
    if (boundTaskId !== activeTaskId) {
      return { matched: false, reason: "TASK_IDENTITY_MISMATCH" };
    }
  }
  if (binding.benchmarkRunId && activeState.benchmarkRunId && binding.benchmarkRunId !== activeState.benchmarkRunId) {
    return { matched: false, reason: "RUN_IDENTITY_MISMATCH" };
  }

  const terminationReason = String(payload.terminationReason || "");
  const failed = Boolean(
    payload.error ||
    payload.cancelled ||
    /(?:error|fail|cancel|kill|abort|max[_ -]?step|timeout)/i.test(terminationReason)
  );

  const outcome = recordDecisionOutcome({
    repoRoot,
    correlationKey: binding.decisionCorrelationKey,
    outcome: {
      result: failed
        ? {
            status: "FAILED",
            child_conversation_id: childConversationId,
            termination_reason: terminationReason || null,
            error: payload.error || null,
          }
        : {
            status: "COMPLETED",
            child_conversation_id: childConversationId,
            termination_reason: terminationReason || null,
          },
      evidence_summary: activeState.evidenceSummary || activeState.evidence || {
        tests: activeState.workerValidationVerified ? "PASS" : "UNKNOWN",
        typecheck: "UNKNOWN",
        build: "UNKNOWN",
        validation_fresh: Boolean(activeState.workerValidationFresh),
        scope_check: "UNKNOWN",
      },
      retry_state: {
        attempt: activeState.attempt || 0,
        retry_remaining: activeState.retry_remaining ?? activeState.remainingAttempts ?? 0,
        retry_reason: activeState.retryReason || activeState.retry_reason || null,
      },
      cost_metrics: {
        tool_calls: activeState.tool_calls || 0,
        context_proxy_bytes: activeState.context_proxy_bytes || 0,
        worker_packet_bytes: activeState.toolMix?.worker_packet_bytes || activeState.worker_packet_bytes || 0,
      },
      terminal_state: failed ? "FAILED" : "UNKNOWN",
    },
  });

  activeState.lastDelegatedDecisionCompletion = {
    childConversationId,
    parentConversationId: binding.parentConversationId || null,
    originToolCallId: binding.originToolCallId || null,
    decisionCorrelationKey: binding.decisionCorrelationKey,
    decisionType: binding.decisionType || null,
    success: !failed,
    outcomeRecorded: Boolean(outcome?.recorded),
    outcomeReason: outcome?.reason || null,
    completedAt: new Date().toISOString(),
  };

  return { matched: true, success: !failed, outcome };
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

  // Sync factual child identity/evidence before resolving the Stop actor. A child
  // may be unbound when Stop fires and become bound by this synchronization.
  const investigationParentConvId = activeState.investigationInFlight?.parentConversationId
    || activeState.investigationInFlight?.parent_conversation_id
    || activeState.investigationInFlight?.conversationId
    || activeState.investigationInFlight?.conversation_id
    || null;
  const factualParentConvId = investigationParentConvId
    || payload.parentConversationId
    || (
      convId &&
      roleBindings.mainConversationId &&
      convId !== roleBindings.mainConversationId
        ? roleBindings.mainConversationId
        : null
    )
    || convId
    || roleBindings.mainConversationId
    || null;
  syncChildEvidence(activeState, factualParentConvId, { repoRoot, roleBindings });

  const bound = (convId && roleBindings.bindings && roleBindings.bindings[convId]) || null;
  const authoritativeMainConversationId = roleBindings.mainConversationId || activeState.conversationId || null;
  const isMainConversation = Boolean(
    convId &&
    authoritativeMainConversationId &&
    convId === authoritativeMainConversationId
  );
  const activeRole = bound?.role
    || (isMainConversation ? "ORCHESTRATOR" : (!payload.conversationId ? activeState.activeRole : "UNKNOWN"))
    || "UNKNOWN";

  // Acceptance authority belongs to the factual/main orchestrator conversation,
  // never merely to a stale global activeRole inherited by a child Stop.
  const isOrchestrator = Boolean(
    isMainConversation &&
    (activeRole === "ORCHESTRATOR" || activeRole === "FLASH_ORCHESTRATOR")
  );

  // Factual investigation completion boundary: terminal Stop of the exact bound
  // investigator child. Dispatch ACKs and manage_subagents observations cannot reach here.
  const investigationStop = finalizeInvestigationFromStop(activeState, payload, repoRoot, roleBindings);
  const directInvestigationStop = investigationStop.matched
    ? { matched: false, reason: "INVESTIGATION_HANDLED_SEPARATELY" }
    : finalizeDirectInvestigationDecisionFromStop(activeState, payload, repoRoot, roleBindings);
  const delegatedDecisionStop = investigationStop.matched
    ? { matched: false, reason: "INVESTIGATION_HANDLED_SEPARATELY" }
    : finalizeDelegatedDecisionFromStop(activeState, payload, repoRoot, roleBindings);
  if (investigationStop.matched || directInvestigationStop.matched || delegatedDecisionStop.matched) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
    } catch {}
  }

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
