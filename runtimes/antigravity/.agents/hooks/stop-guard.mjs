import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findReusableEvidence, verifyWorkerValidation, verifyTaskEvidence, classifyExecutionEvidence, classifyShellMutation, isWorkerRole, createRetryBudget, consumeRetryBudget } from "../skills/agy-orchestra/routing-policy.mjs";
import { childOwnedMissingRequirements } from "../skills/agy-orchestra/evidence-contract.mjs";
import { collectRuntimeEvidenceSync } from "../skills/agy-orchestra/evidence-collectors.mjs";
import {
  bindLocalEvidence,
  mergeFederatedEvidence,
  federateDelegatedEvidence,
  finalizeActiveTaskEvidenceBindings,
} from "../skills/orchestra/evidence-federation.mjs";
import { evaluateTwoKeyReview } from "../skills/orchestra/routing-policy.mjs";
import { recordDecisionOutcome } from "../dream/outcome-recorder.mjs";
import { getExplorationBudgetState } from "../dream/exploration-lab.mjs";
import { rollbackSelectedCanaryTask } from "../dream/canary-mode.mjs";
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

function readGovernanceObject(path, label) {
  if (!existsSync(path)) return { ok: true, exists: false, value: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { ok: false, exists: true, value: null, reason: `${label}_MALFORMED_JSON` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, exists: true, value: null, reason: `${label}_INVALID_SHAPE` };
  }
  return { ok: true, exists: true, value: parsed };
}

function validRoleBindingsShape(roleBindings) {
  if (!roleBindings || typeof roleBindings !== "object" || Array.isArray(roleBindings)) return false;
  if (
    roleBindings.mainConversationId !== undefined &&
    roleBindings.mainConversationId !== null &&
    typeof roleBindings.mainConversationId !== "string"
  ) return false;
  if (
    roleBindings.bindings !== undefined &&
    (!roleBindings.bindings || typeof roleBindings.bindings !== "object" || Array.isArray(roleBindings.bindings))
  ) return false;
  if (
    roleBindings.conversations !== undefined &&
    (!roleBindings.conversations || typeof roleBindings.conversations !== "object" || Array.isArray(roleBindings.conversations))
  ) return false;
  if (roleBindings.pendingSubagents !== undefined && !Array.isArray(roleBindings.pendingSubagents)) return false;
  return true;
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

function readGitHead(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

export function parseReviewerVerdictText(text = "") {
  const norm = String(text || "");
  const explicit = norm.match(/(?:^|\n)\s*(?:VERDICT|DECISION|RECOMMENDATION)\s*[:=\-]\s*([^\r\n]+)/im);
  if (!explicit) return { present: false, verdict: null };

  const raw = explicit[1]
    .replace(/[\`*_]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (/^(?:ACCEPT_WITH_NOTES|ACCEPT_NOTES|PASS_WITH_NOTES)(?:_|$)/.test(raw)) {
    return { present: true, verdict: "ACCEPT_WITH_NOTES" };
  }
  if (/^(?:CHANGES_REQUIRED|CHANGE_REQUIRED|REWORK|RETRY)(?:_|$)/.test(raw)) {
    return { present: true, verdict: "CHANGES_REQUIRED" };
  }
  if (/^(?:BLOCK|BLOCKED|REJECT|REJECTED)(?:_|$)/.test(raw)) {
    return { present: true, verdict: "BLOCK" };
  }
  if (/^(?:NOT_ACCEPT|DO_NOT_ACCEPT|NO_ACCEPT|NOT_APPROVED|DO_NOT_APPROVE)(?:_|$)/.test(raw)) {
    return { present: true, verdict: null };
  }
  if (/^(?:ACCEPT|ACCEPTED|PASS|PASSED)(?:_|$)/.test(raw)) {
    return { present: true, verdict: "ACCEPT" };
  }

  return { present: true, verdict: null };
}

export function extractReviewerVerdict(steps = []) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const text = String(steps[i]?.content || "");
    if (!text) continue;
    const parsed = parseReviewerVerdictText(text);
    if (parsed.present) return parsed.verdict;
  }
  return null;
}

function evaluateTwoKeyRuntimeGate(activeState, roleBindings, repoRoot) {
  const criticality = String(
    activeState.criticality || activeState.scopeContract?.criticality || ""
  ).toUpperCase();
  const required = criticality === "CRITICAL" || activeState.independentReviewRequired === true;
  if (!required) return { required: false, satisfied: true, reason: null };

  const review = activeState.twoKeyReview;
  if (!review || review.expectedReviewerCount !== 2) {
    return { required: true, satisfied: false, reason: "TWO_KEY_REVIEW_MISSING" };
  }

  const currentHead = readGitHead(repoRoot);
  const currentMutationSeq = activeState.mutationSeq || activeState.mutation_seq || 0;
  const currentAttempt = Number.isInteger(activeState.attempt) ? activeState.attempt : 0;
  const candidateAttempt = Number.isInteger(review.candidateAttempt) ? review.candidateAttempt : 0;
  if (
    !review.candidateHead ||
    !currentHead ||
    review.candidateHead !== currentHead ||
    review.candidateMutationSeq !== currentMutationSeq ||
    candidateAttempt !== currentAttempt
  ) {
    return {
      required: true,
      satisfied: false,
      reason: "TWO_KEY_REVIEW_STALE",
      candidateHead: review.candidateHead || null,
      currentHead,
      candidateMutationSeq: review.candidateMutationSeq ?? null,
      currentMutationSeq,
      candidateAttempt,
      currentAttempt,
    };
  }

  const entries = Object.entries(review.reviews || {});
  if (entries.length !== 2) {
    return {
      required: true,
      satisfied: false,
      reason: "TWO_KEY_REVIEW_INCOMPLETE",
      observedReviewerCount: entries.length,
    };
  }

  const seen = new Set();
  const verdicts = [];
  for (const [conversationId, result] of entries) {
    if (seen.has(conversationId)) {
      return { required: true, satisfied: false, reason: "TWO_KEY_REVIEWER_IDENTITY_REUSED" };
    }
    seen.add(conversationId);

    const binding = roleBindings.bindings?.[conversationId]
      || roleBindings.conversations?.[conversationId]
      || null;
    if (
      !binding ||
      binding.role !== "REVIEWER" ||
      binding.profile !== "flash-reviewer" ||
      binding.source !== "RUNTIME_IDENTITY" ||
      binding.confidence !== "HIGH" ||
      binding.delegationKind !== "REVIEW"
    ) {
      return { required: true, satisfied: false, reason: "TWO_KEY_REVIEWER_IDENTITY_NOT_FACTUAL" };
    }

    const resultCandidateAttempt = Number.isInteger(result.candidateAttempt) ? result.candidateAttempt : 0;
    const resultCompletionAttempt = Number.isInteger(result.completionAttempt) ? result.completionAttempt : 0;
    if (
      result.reviewBatchId !== review.reviewBatchId ||
      result.candidateHead !== review.candidateHead ||
      result.candidateMutationSeq !== review.candidateMutationSeq ||
      resultCandidateAttempt !== candidateAttempt ||
      result.completionHead !== review.candidateHead ||
      result.completionMutationSeq !== review.candidateMutationSeq ||
      resultCompletionAttempt !== candidateAttempt
    ) {
      return { required: true, satisfied: false, reason: "TWO_KEY_REVIEW_RESULT_STALE" };
    }
    if (result.readOnlyViolation === true) {
      return { required: true, satisfied: false, reason: "TWO_KEY_REVIEWER_WRITE_DETECTED" };
    }
    if (!result.verdict) {
      return { required: true, satisfied: false, reason: "TWO_KEY_REVIEW_VERDICT_MISSING" };
    }
    verdicts.push(result.verdict);
  }

  const consensus = evaluateTwoKeyReview(review, verdicts[0], verdicts[1]);
  return {
    required: true,
    satisfied: consensus.acceptable === true,
    reason: consensus.acceptable ? null : "TWO_KEY_CONSENSUS_NOT_ACCEPTED",
    consensus,
  };
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
          attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
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
            attempt: Number.isInteger(match.attempt) ? match.attempt : 0,
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
        const activeAttempt = Number.isInteger(activeState.attempt) ? activeState.attempt : 0;
        const bindingAttempt = Number.isInteger(binding.attempt) ? binding.attempt : 0;
        if (bindingAttempt !== activeAttempt) continue;
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

            if (exitCode !== null) {
              const stepIdx = typeof step.step_index === "number" ? step.step_index : i;
              const transcriptEvidenceId = "child:" + childConvId + ":step:" + stepIdx + ":tool:" + tIdx;
              const latestMutationStepBeforeValidation = mutationStepIndices.filter((idx) => idx < i).pop() ?? null;
              const mutationAfterValidation = mutationStepIndices.some((idx) => idx > i);
              const fresh = !mutationAfterValidation && exitCode === 0;

              const classified = classifyExecutionEvidence(
                cmd,
                exitCode,
                "",
                0,
                null,
                null,
                activeState.mutationSeq || 0,
              );
              const ev = bindLocalEvidence({
                evidence: {
                  ...classified,
                  evidenceId: "transcript:" + transcriptEvidenceId,
                  executionId: null,
                  transcriptEvidenceId,
                  command: cmd,
                  exitCode,
                  mutationSeq: activeState.mutationSeq || 0,
                  transcriptStepIndex: stepIdx,
                  latestMutationStepBeforeValidation,
                  mutationAfterValidation,
                  fresh,
                  timestamp: step.created_at || new Date().toISOString(),
                },
                activeState,
                actor: {
                  role: childRole,
                  actorId: childConvId,
                  confidence: childConfidence,
                  source: childConfidence === "HIGH" && binding?.source === "RUNTIME_IDENTITY"
                    ? "RUNTIME_IDENTITY"
                    : "CHILD_TRANSCRIPT",
                  delegationKind: binding?.delegationKind || null,
                  attempt: Number.isInteger(binding?.attempt) ? binding.attempt : 0,
                },
                repoRoot,
                conversationId: childConvId,
                parentConversationId: binding?.parentConversationId || parentConvId || null,
              });

              mergeFederatedEvidence(activeState, ev);

              if (isWorkerRole(childRole) && (
                ev.type !== "GENERIC_COMMAND_RESULT"
                || activeState.scopeContract?.requiredEvidence
              )) {
                lastWorkerValidationEv = ev;
              } else if (childRole === "REVIEWER") {
                activeState.reviewerValidationObserved = true;
                activeState.reviewerValidationCommand = cmd;
                activeState.reviewerValidationExitCode = exitCode;
              } else if (!isWorkerRole(childRole)) {
                activeState.unknownValidationObserved = true;
                activeState.unknownValidationCommand = cmd;
                activeState.unknownValidationExitCode = exitCode;
              }
            }
          } else if (toolName === "send_message") {
            const msg = String(args.Message || "");
            if (msg.includes("IMPLEMENTATION_COMPLETE")) {
              const factualImplementationWorker =
                isWorkerRole(childRole) &&
                childConfidence === "HIGH" &&
                binding?.source === "RUNTIME_IDENTITY" &&
                binding?.delegationKind === "WORK";
              if (factualImplementationWorker) {
                activeState.workerCompletionClaimed = true;
                activeState.workerCompletionClaimFactual = true;
                activeState.workerCompletionClaimTimestamp = new Date().toISOString();
                activeState.workerCompletionClaimIdentity = {
                  actorId: childConvId,
                  source: binding.source,
                  confidence: childConfidence,
                  delegationKind: binding.delegationKind,
                  attempt: Number.isInteger(binding.attempt) ? binding.attempt : 0,
                };
                activeState.implementationComplete = true;
                activeState.handoffObserved = true;
                activeState.worker_packet_bytes = (activeState.worker_packet_bytes || 0) + Buffer.byteLength(msg, "utf-8");
              } else {
                activeState.nonFactualCompletionClaims = (activeState.nonFactualCompletionClaims || 0) + 1;
              }
            }
          }
        }
      }

      const isTerminalReviewerStop = Boolean(
        childRole === "REVIEWER" &&
        childConfidence === "HIGH" &&
        binding?.source === "RUNTIME_IDENTITY" &&
        binding?.delegationKind === "REVIEW" &&
        options.terminalFullyIdle === true &&
        options.terminalSucceeded === true &&
        options.terminalChildConversationId === childConvId
      );

      if (isTerminalReviewerStop) {
        const pending = Array.isArray(roleBindings.pendingSubagents)
          ? roleBindings.pendingSubagents.find((p) => p.seq === binding.pendingSeq)
          : null;
        const review = activeState.twoKeyReview;
        const verdict = extractReviewerVerdict(steps);
        const candidateHead = pending?.reviewCandidateHead || review?.candidateHead || null;
        const candidateMutationSeq = pending?.reviewCandidateMutationSeq ?? review?.candidateMutationSeq ?? null;
        const candidateAttempt = Number.isInteger(pending?.reviewCandidateAttempt)
          ? pending.reviewCandidateAttempt
          : (Number.isInteger(review?.candidateAttempt) ? review.candidateAttempt : 0);
        const reviewBatchId = pending?.reviewBatchId || review?.reviewBatchId || binding.originToolCallId || null;
        const completionHead = readGitHead(repoRoot);
        const completionMutationSeq = activeState.mutationSeq || activeState.mutation_seq || 0;
        const completionAttempt = Number.isInteger(activeState.attempt) ? activeState.attempt : 0;

        if (
          review &&
          reviewBatchId &&
          review.reviewBatchId === reviewBatchId &&
          candidateHead === review.candidateHead &&
          candidateMutationSeq === review.candidateMutationSeq &&
          candidateAttempt === (Number.isInteger(review.candidateAttempt) ? review.candidateAttempt : 0) &&
          completionAttempt === candidateAttempt
        ) {
          if (!review.reviews || typeof review.reviews !== "object") review.reviews = {};
          review.reviews[childConvId] = {
            conversationId: childConvId,
            verdict,
            reviewBatchId,
            candidateHead,
            candidateMutationSeq,
            candidateAttempt,
            completionHead,
            completionMutationSeq,
            completionAttempt,
            readOnlyViolation: mutationStepIndices.length > 0,
            completedAt: new Date().toISOString(),
          };
          review.reviewerConversationIds = Object.keys(review.reviews);
          review.status = review.reviewerConversationIds.length === 2 ? "EVIDENCE_READY" : "IN_FLIGHT";
        } else {
          activeState.twoKeyReviewViolation = {
            reason: "TWO_KEY_REVIEW_CANDIDATE_CORRELATION_MISMATCH",
            conversationId: childConvId,
            reviewBatchId,
            candidateHead,
            candidateMutationSeq,
            candidateAttempt,
            completionAttempt,
            timestamp: new Date().toISOString(),
          };
        }
      }

      if (lastWorkerValidationEv) {        activeState.workerValidationObserved = true;
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
  if (!rawInput.trim()) {
    console.log(JSON.stringify({
      decision: "continue",
      reason: "INVALID_STOP_PAYLOAD: Stop hook received no runtime payload."
    }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({
      decision: "continue",
      reason: "MALFORMED_STOP_PAYLOAD: Stop hook payload is not valid JSON."
    }));
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.log(JSON.stringify({
      decision: "continue",
      reason: "INVALID_STOP_PAYLOAD: Stop hook payload must be a JSON object."
    }));
    return;
  }

  const { repoRoot, statePath, telemetryPath } = getWorkspacePaths(payload);

  // Milestone E budget is a hard upper bound. If PostInvocation exhausted the
  // exploration allowance, Stop must not reopen the execution loop even when
  // normal acceptance/evidence gates would otherwise request continuation.
  const explorationBudget = getExplorationBudgetState(repoRoot);
  if (explorationBudget.active && explorationBudget.exhausted) {
    recordStopTelemetry(
      telemetryPath,
      {},
      payload,
      "stop",
      explorationBudget.timed_out
        ? "EXPLORATION_TIMEOUT"
        : "EXPLORATION_MODEL_CALL_BUDGET_EXHAUSTED",
    );
    console.log(JSON.stringify({
      decision: "stop",
      reason: explorationBudget.timed_out
        ? "EXPLORATION_TIMEOUT: hard Milestone E deadline reached."
        : `EXPLORATION_MODEL_CALL_BUDGET_EXHAUSTED: ${explorationBudget.model_calls} model calls observed; Stop cannot continue the exploration loop.`,
    }));
    return;
  }

  let activeState = {};
  const stateLoad = readGovernanceObject(statePath, "ACTIVE_STATE");
  if (!stateLoad.ok) {
    console.log(JSON.stringify({
      decision: "continue",
      reason: `GOVERNANCE_STATE_INVALID: ${stateLoad.reason}. Stop cannot be accepted while authority state is corrupted.`
    }));
    return;
  }
  if (stateLoad.exists) activeState = stateLoad.value;

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
  let roleBindings = { mainConversationId: null, bindings: {}, pendingSubagents: [] };
  const roleBindingsLoad = readGovernanceObject(roleBindingsPath, "ROLE_BINDINGS");
  if (!roleBindingsLoad.ok || (roleBindingsLoad.exists && !validRoleBindingsShape(roleBindingsLoad.value))) {
    const reason = roleBindingsLoad.ok ? "ROLE_BINDINGS_INVALID_SHAPE" : roleBindingsLoad.reason;
    recordStopTelemetry(telemetryPath, activeState, payload, "continue", reason);
    console.log(JSON.stringify({
      decision: "continue",
      reason: `GOVERNANCE_STATE_INVALID: ${reason}. Stop cannot be accepted while role identity state is corrupted.`
    }));
    return;
  }
  if (roleBindingsLoad.exists) roleBindings = roleBindingsLoad.value;
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
  const terminalTerminationReason = String(payload.terminationReason || "");
  const terminalFailed = Boolean(
    payload.error ||
    payload.cancelled ||
    /(?:error|fail|cancel|kill|abort|max[_ -]?step|timeout)/i.test(terminalTerminationReason)
  );
  const terminalSucceeded = payload.fullyIdle === true && !terminalFailed;

  syncChildEvidence(activeState, factualParentConvId, {
    repoRoot,
    roleBindings,
    terminalChildConversationId:
      payload.fullyIdle === true && convId && convId !== factualParentConvId ? convId : null,
    terminalFullyIdle: payload.fullyIdle === true,
    terminalSucceeded,
    terminalTerminationReason: terminalTerminationReason || null,
  });

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

  if (payload.conversationId && !isMainConversation && bound) {
    const federation = federateDelegatedEvidence({
      activeState,
      factualBinding: bound,
      childConversationId: convId,
      parentConversationId: authoritativeMainConversationId,
      repoRoot,
    });
    activeState.lastEvidenceFederation = {
      childConversationId: convId,
      promoted: federation.promoted || 0,
      reason: federation.reason || null,
      commitSha: federation.commitSha || null,
      observedAt: new Date().toISOString(),
    };
  }

  // Acceptance authority belongs to the factual/main orchestrator conversation,
  // never merely to a stale global activeRole inherited by a child Stop.
  const isOrchestrator = Boolean(
    isMainConversation &&
    (activeRole === "ORCHESTRATOR" || activeRole === "FLASH_ORCHESTRATOR")
  );

  // A successful factual WORK child cannot terminate while it still owns an
  // actionable local evidence requirement. Runtime-owned LOCAL_FACT/REMOTE_CI
  // requirements never keep the child alive; the parent/runtime collects them.
  const factualWorkChild = Boolean(
    payload.fullyIdle === true
    && terminalSucceeded
    && !isMainConversation
    && bound
    && bound.role === "WORKER"
    && bound.confidence === "HIGH"
    && bound.source === "RUNTIME_IDENTITY"
    && ["WORK", "VALIDATION"].includes(bound.delegationKind)
  );
  if (factualWorkChild) {
    const explicitEvidenceContract = Array.isArray(activeState.scopeContract?.requiredEvidence);
    if (explicitEvidenceContract) {
      const childEvidence = verifyTaskEvidence(activeState);
      const missingOwned = childOwnedMissingRequirements(childEvidence);
      if (missingOwned.length > 0) {
        const commands = missingOwned
          .map((req) => req.command)
          .filter(Boolean);
        activeState.childEvidenceContinuation = {
          conversationId: convId,
          requirementIds: missingOwned.map((req) => req.id),
          commands,
          observedAt: new Date().toISOString(),
        };
        try {
          mkdirSync(dirname(statePath), { recursive: true });
          writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
        } catch {}
        recordStopTelemetry(telemetryPath, activeState, payload, "continue", "CHILD_EVIDENCE_REQUIRED");
        console.log(JSON.stringify({
          decision: "continue",
          reason: "CHILD_EVIDENCE_REQUIRED: Before completing this WORK delegation, execute the missing factual local validation requirement(s): " + commands.join(" ; ") + ". MODEL CLAIM IS NOT EVIDENCE.",
        }));
        return;
      }
    } else {
      const requiredLegacyTests = Array.isArray(activeState.scopeContract?.testsRequired)
        ? activeState.scopeContract.testsRequired
        : [];
      if (requiredLegacyTests.length > 0) {
        const legacyValidation = verifyWorkerValidation(activeState);
        const missingLegacy = !legacyValidation.verified
          && /^(?:MISSING:|NO_VERIFIED_WORKER_VALIDATION)/.test(String(legacyValidation.reason || ""));
        if (missingLegacy) {
          activeState.childEvidenceContinuation = {
            conversationId: convId,
            requirementIds: ["legacy-tests-required"],
            commands: requiredLegacyTests,
            observedAt: new Date().toISOString(),
          };
          try {
            mkdirSync(dirname(statePath), { recursive: true });
            writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
          } catch {}
          recordStopTelemetry(telemetryPath, activeState, payload, "continue", "CHILD_EVIDENCE_REQUIRED");
          console.log(JSON.stringify({
            decision: "continue",
            reason: "CHILD_EVIDENCE_REQUIRED: Required local validation is still missing: " + requiredLegacyTests.join(" ; ") + ". Execute it before completing the worker.",
          }));
          return;
        }
      }
    }
  }

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

  // Terminal child Stop closes the child only. Parent acceptance is evaluated
  // exclusively when the factual main conversation reaches Stop.
  if (payload.conversationId && !isMainConversation) {
    activeState.clean_stops = (activeState.clean_stops || 0) + 1;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
    } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "stop");
    console.log(JSON.stringify({ decision: "stop" }));
    return;
  }

  // Finalize factual local evidence against the current candidate commit before
  // parent acceptance. Already-bound old commits are never rewritten.
  const finalizedEvidence = finalizeActiveTaskEvidenceBindings({
    activeState,
    repoRoot,
  });
  activeState.lastEvidenceBindingFinalization = {
    promoted: finalizedEvidence.promoted || 0,
    headSha: finalizedEvidence.headSha || null,
    observedAt: new Date().toISOString(),
  };

  // Collect runtime-owned facts (LOCAL_FACT and REMOTE_CI) before acceptance.
  // Model text never enters this path as evidence.
  if (Array.isArray(activeState.scopeContract?.requiredEvidence)) {
    const collection = collectRuntimeEvidenceSync({
      repoRoot,
      activeState,
      contract: activeState.scopeContract,
    });
    activeState.lastEvidenceCollection = {
      collected: collection.collected === true,
      reason: collection.reason || null,
      records: Array.isArray(collection.records)
        ? collection.records.map((record) => ({
            evidenceId: record.evidenceId,
            requirementId: record.requirementId,
            class: record.class,
            kind: record.kind,
            result: record.result,
            reason: record.reason || null,
          }))
        : [],
      observedAt: new Date().toISOString(),
    };
  }

  const valEval = verifyTaskEvidence(activeState);
  activeState.evidenceContractStatus = valEval.status || (valEval.verified ? "SATISFIED" : "MISSING_ACTIONABLE");
  activeState.workerValidationVerified = valEval.verified;
  activeState.workerValidationFresh = valEval.fresh;
  if (valEval.verified && valEval.evidence) {
    activeState.acceptanceEvidenceId = valEval.evidence.evidenceId || valEval.evidence.executionId || valEval.evidence.transcriptEvidenceId || null;
    if (valEval.evidence.command) {
      activeState.workerValidationExecutionId = valEval.evidence.executionId || null;
      activeState.workerValidationTranscriptEvidenceId = valEval.evidence.transcriptEvidenceId || null;
      activeState.workerValidationCommand = valEval.evidence.command || activeState.workerValidationCommand;
      activeState.workerValidationExitCode = valEval.evidence.exitCode ?? activeState.workerValidationExitCode;
      activeState.workerValidationActor = valEval.evidence.actorRole || activeState.workerValidationActor;
    }
  } else {
    activeState.workerValidationExecutionId = null;
  }

  // Asynchronous verified providers are a factual wait state, not missing evidence.
  if (valEval.status === "PENDING") {
    activeState.state = "CI_WAIT";
    activeState.acceptanceState = "PENDING";
    activeState.ciWait = {
      requirementIds: (valEval.results || []).filter((r) => r.status === "PENDING").map((r) => r.id),
      pollCount: (activeState.ciWait?.pollCount || 0) + 1,
      observedAt: new Date().toISOString(),
    };
    activeState.lastStopBlockedReason = null;
    activeState.stopBlockedCount = 0;
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "continue", "CI_WAIT");
    console.log(JSON.stringify({
      decision: "continue",
      reason: "CI_WAIT: Authoritative remote validation is still pending. Do not treat this as EVIDENCE_MISSING; wait and re-check the declared provider evidence.",
    }));
    return;
  }

  if (valEval.status === "FAILED") {
    const remoteFailure = (valEval.results || []).some((r) => r.status === "FAILED" && r.kind === "REMOTE_CI");
    const currentBudget = createRetryBudget(activeState);
    const nextBudget = consumeRetryBudget(currentBudget);
    activeState.evidenceFailure = {
      reason: valEval.reason || "EVIDENCE_FAILED",
      requirementIds: (valEval.results || []).filter((r) => r.status === "FAILED").map((r) => r.id),
      observedAt: new Date().toISOString(),
    };
    activeState.acceptanceState = "PENDING";
    activeState.retryReason = remoteFailure ? "REMOTE_VALIDATION_FAILURE" : "INCOMPLETE_IMPLEMENTATION";
    activeState.retry_reason = activeState.retryReason;
    activeState.retry = nextBudget.remainingAttempts > 0;
    activeState.prevRemainingAttempts = currentBudget.remainingAttempts;
    activeState.maxAttempts = nextBudget.maxAttempts;
    activeState.attempt = nextBudget.attempt;
    activeState.remainingAttempts = nextBudget.remainingAttempts;
    activeState.retry_remaining = nextBudget.remainingAttempts;
    activeState.retriesUsed = nextBudget.attempt;
    activeState.workerCompletionClaimed = false;
    activeState.workerCompletionClaimFactual = false;
    activeState.implementationComplete = false;
    activeState.state = nextBudget.remainingAttempts > 0 ? "PLANNED" : "BLOCKED";
    if (activeState.mechanicalFastPath?.active) {
      activeState.mechanicalFastPath = {
        ...activeState.mechanicalFastPath,
        active: false,
        status: nextBudget.remainingAttempts > 0 ? "FAILED_EVIDENCE_RETRY" : "FAILED_EVIDENCE_BLOCKED",
        endedAt: new Date().toISOString(),
      };
    }
    activeState.lastStopBlockedReason = null;
    activeState.stopBlockedCount = 0;
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "continue", activeState.retryReason);
    console.log(JSON.stringify({
      decision: "continue",
      reason: nextBudget.remainingAttempts > 0
        ? "EVIDENCE_FAILED: Verified acceptance evidence failed. Delta Retry prepared with attempt " + nextBudget.attempt + ", remaining " + nextBudget.remainingAttempts + ", reason " + activeState.retryReason + "."
        : "EVIDENCE_FAILED: Verified acceptance evidence failed and retry budget is exhausted. Task is BLOCKED.",
    }));
    return;
  }

  if (valEval.status === "STALE") {
    activeState.state = "PLANNED";
    activeState.acceptanceState = "PENDING";
    delete activeState.retryReason;
    delete activeState.retry_reason;
    delete activeState.retry;
    activeState.evidenceStale = {
      reason: valEval.reason || "EVIDENCE_STALE",
      requirementIds: (valEval.results || []).filter((r) => r.status === "STALE").map((r) => r.id),
      observedAt: new Date().toISOString(),
    };
    activeState.workerCompletionClaimed = false;
    activeState.workerCompletionClaimFactual = false;
    activeState.implementationComplete = false;
    if (activeState.mechanicalFastPath?.active) {
      activeState.mechanicalFastPath = {
        ...activeState.mechanicalFastPath,
        active: false,
        status: "STALE_EVIDENCE_REPLAN",
        endedAt: new Date().toISOString(),
      };
    }
    activeState.lastStopBlockedReason = null;
    activeState.stopBlockedCount = 0;
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "continue", "EVIDENCE_STALE");
    console.log(JSON.stringify({
      decision: "continue",
      reason: "EVIDENCE_STALE: Acceptance evidence is not bound to the current candidate state. Re-establish the declared evidence for the current HEAD/mutation state.",
    }));
    return;
  }

  if (valEval.status === "SOURCE_UNAVAILABLE") {
    const count = (activeState.evidenceSourceUnavailableCount || 0) + 1;
    activeState.evidenceSourceUnavailableCount = count;
    activeState.acceptanceState = "PENDING";
    activeState.state = count >= 3 ? "HUMAN_GATE" : "CI_WAIT";
    if (activeState.mechanicalFastPath?.active) {
      activeState.mechanicalFastPath = {
        ...activeState.mechanicalFastPath,
        active: false,
        status: count >= 3 ? "SOURCE_UNAVAILABLE_HUMAN_GATE" : "SOURCE_UNAVAILABLE",
        endedAt: new Date().toISOString(),
      };
    }
    activeState.lastStopBlockedReason = null;
    activeState.stopBlockedCount = 0;
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "continue", "EVIDENCE_SOURCE_UNAVAILABLE");
    console.log(JSON.stringify({
      decision: "continue",
      reason: count >= 3
        ? "EVIDENCE_SOURCE_UNAVAILABLE: Authoritative evidence source remained unavailable after bounded retries. Halting to HUMAN_GATE."
        : "EVIDENCE_SOURCE_UNAVAILABLE: Authoritative evidence source is temporarily unavailable. Fail-closed and retry collection without accepting.",
    }));
    return;
  }

  if (valEval.status === "INVALID_CONTRACT") {
    activeState.state = "HUMAN_GATE";
    activeState.acceptanceState = "PENDING";
    activeState.humanGateReason = "INVALID_EVIDENCE_CONTRACT";
    if (activeState.mechanicalFastPath?.active) {
      activeState.mechanicalFastPath = {
        ...activeState.mechanicalFastPath,
        active: false,
        status: "INVALID_CONTRACT",
        endedAt: new Date().toISOString(),
      };
    }
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    recordStopTelemetry(telemetryPath, activeState, payload, "continue", "INVALID_EVIDENCE_CONTRACT");
    console.log(JSON.stringify({
      decision: "continue",
      reason: "INVALID_EVIDENCE_CONTRACT: Acceptance requirements are malformed or ambiguous. Fail-closed to HUMAN_GATE.",
    }));
    return;
  }

  const currentAttempt = Number.isInteger(activeState.attempt) && activeState.attempt >= 0
    ? activeState.attempt
    : 0;
  const completionIdentity = activeState.workerCompletionClaimIdentity || null;
  const completionAttempt = Number.isInteger(completionIdentity?.attempt)
    ? completionIdentity.attempt
    : 0;
  const completionIdentityFactual = Boolean(
    completionIdentity &&
    completionIdentity.source === "RUNTIME_IDENTITY" &&
    completionIdentity.confidence === "HIGH" &&
    completionIdentity.delegationKind === "WORK" &&
    completionAttempt === currentAttempt
  );
  const completionClaimed = activeState.workerCompletionClaimed === true
    && activeState.workerCompletionClaimFactual === true
    && completionIdentityFactual;

  if (
    activeState.workerCompletionClaimed === true &&
    activeState.workerCompletionClaimFactual === true &&
    !completionIdentityFactual
  ) {
    activeState.completionClaimRejectedReason = completionAttempt !== currentAttempt
      ? "ATTEMPT_MISMATCH"
      : "COMPLETION_IDENTITY_NOT_FACTUAL";
  } else {
    delete activeState.completionClaimRejectedReason;
  }

  const noScopeViolation = !activeState.scopeViolation && !activeState.forbiddenAccessDetected;
  const noUnresolvedWrites = (activeState.orchestratorWorkspaceWrites || 0) === 0
    && (activeState.unknownWorkspaceWrites || 0) === 0;

  const twoKeyGate = evaluateTwoKeyRuntimeGate(activeState, roleBindings, repoRoot);
  activeState.twoKeyReviewGate = {
    required: twoKeyGate.required,
    satisfied: twoKeyGate.satisfied,
    reason: twoKeyGate.reason || null,
    checkedAt: new Date().toISOString(),
  };

  if (twoKeyGate.required && !twoKeyGate.satisfied) {
    if (twoKeyGate.consensus?.humanGateRequired === true) {
      activeState.state = "HUMAN_GATE";
      activeState.humanGateReason = twoKeyGate.consensus.reason || "TWO_KEY_DISAGREEMENT";
    } else if (twoKeyGate.consensus?.nextState === "PLANNED") {
      activeState.state = "PLANNED";
      activeState.retryReason = twoKeyGate.consensus.retryReason || "TWO_KEY_REJECTION";
    } else if (activeState.state === "DONE" || activeState.acceptanceState === "ACCEPTED") {
      activeState.state = "ACCEPTANCE";
    }

    if (activeState.acceptanceState === "ACCEPTED") {
      activeState.acceptanceState = "PENDING";
      delete activeState.acceptanceActor;
      activeState.acceptanceRevokedReason = twoKeyGate.reason || "TWO_KEY_REVIEW_REQUIRED";
    }
  } else if (twoKeyGate.required && twoKeyGate.satisfied) {
    activeState.twoKeyReview.status = "ACCEPTED";
    activeState.twoKeyReviewConsensus = twoKeyGate.consensus?.decision || "ACCEPT";
  }

  // Hardened acceptance: Orchestrator automatically accepts if and only if
  // 1. Worker claimed completion
  // 2. The typed Evidence Contract is satisfied by factual fresh evidence
  // 3. No scope violation
  // 4. No unresolved workspace writes
  // 5. Orchestrator concluding turn
  const canAccept = isOrchestrator
    && completionClaimed
    && valEval.verified
    && noScopeViolation
    && noUnresolvedWrites
    && twoKeyGate.satisfied;

  if (canAccept) {
    if (!activeState.acceptanceState || activeState.acceptanceState !== "ACCEPTED") {
      activeState.acceptanceState = "ACCEPTED";
      activeState.acceptanceActor = "ORCHESTRATOR";
      activeState.acceptanceObserved = true;
      activeState.state = "DONE";
      if (activeState.mechanicalFastPath?.active) {
        activeState.mechanicalFastPath = {
          ...activeState.mechanicalFastPath,
          active: false,
          status: "DONE",
          acceptedEvidenceId: activeState.acceptanceEvidenceId || null,
          endedAt: new Date().toISOString(),
        };
      }
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
      rollbackSelectedCanaryTask({
        repoRoot,
        taskId: payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null,
        trigger: "REQUIRED_EVIDENCE_BYPASS_ATTEMPT",
        details: { reason: valEval.reason || "EVIDENCE_MISSING" },
      });
    } else if (twoKeyGate.required && !twoKeyGate.satisfied) {
      reasonKey = twoKeyGate.reason || "TWO_KEY_REVIEW_REQUIRED";
      reasonMsg = `STOP_BLOCKED: CRITICAL acceptance requires two factual independent reviewer approvals bound to the current candidate (${reasonKey}).`;
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
      rollbackSelectedCanaryTask({
        repoRoot,
        taskId: payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null,
        trigger: "REQUIRED_EVIDENCE_BYPASS_ATTEMPT",
        details: { missing_tests: missingTests.slice().sort() },
      });
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
