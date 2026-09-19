import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { createContinuationCapsule } from "./trust-boundary.mjs";

export const ORCHESTRATOR_HANDOFF_SCHEMA = "orchestra.orchestrator-session-handoff.v1";
export const ORCHESTRATOR_HANDOFF_STATUSES = Object.freeze({
  ARMED: "ARMED",
  CLAIMED: "CLAIMED",
  CANCELLED: "CANCELLED",
});
export const ORCHESTRATOR_HANDOFF_MODES = Object.freeze({
  MILESTONE_BOUNDARY: "MILESTONE_BOUNDARY",
  LIVE_CONTINUATION: "LIVE_CONTINUATION",
});

const QUIESCENT_STATES = new Set(["DONE", "BLOCKED", "HUMAN_GATE"]);
const FORBIDDEN_CAPSULE_KEYS = new Set([
  "transcript", "transcripts", "messages", "prompt", "prompts",
  "reasoning", "thinking", "chainOfThought", "chain_of_thought",
  "stdout", "stderr", "raw", "rawContent", "raw_content",
  "credentials", "secret", "secrets", "environment", "env",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(stable(value)),
  ).digest("hex");
}

function clean(value, max = 240) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function sanitizeCapsule(value, path = "capsule") {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeCapsule(item, path + "[" + index + "]"));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.length > 4000 ? value.slice(0, 4000) : value;
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CAPSULE_KEYS.has(key)) {
      throw new Error("ORCHESTRATOR_HANDOFF_FORBIDDEN_CAPSULE_FIELD:" + path + "." + key);
    }
    out[key] = sanitizeCapsule(child, path + "." + key);
  }
  return out;
}

function runtimePaths(repoRoot) {
  const root = resolve(repoRoot);
  return {
    root,
    statePath: join(root, ".agents", "state", "active-state.json"),
    contractPath: join(root, ".agents", "state", "active-contract.json"),
    roleBindingsPath: join(root, ".agents", "state", "role-bindings.json"),
    handoffPath: join(root, ".agents", "state", "orchestrator-handoff.json"),
    telemetryPath: join(root, ".agents", "telemetry", "events.jsonl"),
  };
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function appendTelemetry(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  }) + "\n", "utf8");
}

function unconsumedPending(roleBindings = {}) {
  const pending = Array.isArray(roleBindings.pendingSubagents) ? roleBindings.pendingSubagents : [];
  return pending.filter((item) => !item?.consumed);
}

function inFlightDescriptors(activeState = {}) {
  const descriptors = [];
  const candidates = [
    ["investigationInFlight", activeState.investigationInFlight],
    ["directInvestigationDecisionInFlight", activeState.directInvestigationDecisionInFlight],
    ["delegatedDecisionInFlight", activeState.delegatedDecisionInFlight],
    ["criticalReviewInFlight", activeState.criticalReviewInFlight],
  ];
  for (const [kind, value] of candidates) {
    if (value && typeof value === "object") {
      descriptors.push({
        kind,
        childConversationId: value.childConversationId || value.child_conversation_id || null,
        executionId: value.executionId || value.execution_id || null,
        toolCallId: value.toolCallId || value.tool_call_id || null,
      });
    }
  }
  if (activeState.ciWait && typeof activeState.ciWait === "object") {
    const status = String(activeState.ciWait.status || activeState.ciWait.state || "").toUpperCase();
    if (!["DONE", "SUCCESS", "FAILED", "CANCELLED", "COMPLETE", "COMPLETED"].includes(status)) {
      descriptors.push({ kind: "ciWait", status: status || "PENDING" });
    }
  }
  return descriptors;
}

export function authorityStateSnapshot(activeState = {}, roleBindings = {}) {
  const pending = unconsumedPending(roleBindings).map((item) => ({
    seq: item?.seq ?? null,
    role: item?.role || item?.Role || null,
    profile: item?.profile || item?.typeName || item?.TypeName || null,
    parentConversationId: item?.parentConversationId || null,
    taskId: item?.taskId || item?.taskIdentifier || null,
    consumed: item?.consumed === true,
  })).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));

  return {
    mainConversationId: roleBindings.mainConversationId || activeState.conversationId || null,
    taskId: activeState.taskId || activeState.taskKey || null,
    taskAction: activeState.taskAction || activeState.task_action || null,
    taskDomain: activeState.taskDomain || activeState.task_domain || null,
    state: activeState.state || null,
    acceptanceState: activeState.acceptanceState || null,
    attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
    mutationSeq: Number.isInteger(activeState.mutationSeq)
      ? activeState.mutationSeq
      : (Number.isInteger(activeState.mutation_seq) ? activeState.mutation_seq : 0),
    candidateHead: activeState.evidenceCandidateHead
      || activeState.candidateHead
      || activeState.currentHead
      || null,
    pendingSubagents: pending,
    inFlight: inFlightDescriptors(activeState),
  };
}

export function authorityStateFingerprint(activeState = {}, roleBindings = {}) {
  return hash(authorityStateSnapshot(activeState, roleBindings));
}

function isBoundaryState(activeState = {}) {
  const state = String(activeState.state || "").toUpperCase();
  const acceptance = String(activeState.acceptanceState || "").toUpperCase();
  return QUIESCENT_STATES.has(state) || acceptance === "ACCEPTED";
}

function makeBoundaryCapsule(activeState = {}, {
  lineageId,
  currentGeneration,
  targetGeneration,
  reason = null,
  label = null,
} = {}) {
  return {
    schema: "orchestra.orchestrator-boundary-capsule.v1",
    mode: ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY,
    lineage_id: lineageId,
    previous_generation: currentGeneration,
    target_generation: targetGeneration,
    previous_task: {
      task_id: activeState.taskId || activeState.taskKey || null,
      state: activeState.state || null,
      acceptance_state: activeState.acceptanceState || null,
      attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
      mutation_seq: Number.isInteger(activeState.mutationSeq)
        ? activeState.mutationSeq
        : (Number.isInteger(activeState.mutation_seq) ? activeState.mutation_seq : 0),
      candidate_head: activeState.evidenceCandidateHead || activeState.candidateHead || null,
    },
    reason: clean(reason, 500) || null,
    label: clean(label, 160) || null,
    context_policy: "FRESH_MILESTONE_NO_PREVIOUS_SCOPE_OR_TRANSCRIPT",
  };
}

function recordBody(input) {
  const body = { ...input };
  delete body.record_hash;
  return body;
}

function finalizeRecord(input) {
  const body = stable(recordBody(input));
  return { ...body, record_hash: hash(body) };
}

export function validateOrchestratorHandoffRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, reason: "HANDOFF_MISSING_OR_INVALID" };
  }
  if (record.schema !== ORCHESTRATOR_HANDOFF_SCHEMA) {
    return { valid: false, reason: "HANDOFF_SCHEMA_MISMATCH" };
  }
  if (!Object.values(ORCHESTRATOR_HANDOFF_STATUSES).includes(record.status)) {
    return { valid: false, reason: "HANDOFF_STATUS_INVALID" };
  }
  if (!Object.values(ORCHESTRATOR_HANDOFF_MODES).includes(record.mode)) {
    return { valid: false, reason: "HANDOFF_MODE_INVALID" };
  }
  if (!record.handoff_id || !record.from_conversation_id || !record.lineage_id) {
    return { valid: false, reason: "HANDOFF_IDENTITY_MISSING" };
  }
  const expected = hash(stable(recordBody(record)));
  if (record.record_hash !== expected) {
    return { valid: false, reason: "HANDOFF_HASH_MISMATCH" };
  }
  try {
    sanitizeCapsule(record.capsule || {});
  } catch (error) {
    return { valid: false, reason: String(error.message || error) };
  }
  return { valid: true, reason: null };
}

export function readProjectOrchestratorHandoff(repoRoot) {
  const { handoffPath } = runtimePaths(repoRoot);
  if (!existsSync(handoffPath)) {
    return { exists: false, valid: true, record: null, path: handoffPath };
  }
  const record = readJson(handoffPath, null);
  const validation = validateOrchestratorHandoffRecord(record);
  return { exists: true, valid: validation.valid, reason: validation.reason, record, path: handoffPath };
}

function activeMainBinding(roleBindings = {}, mainConversationId = null) {
  if (!mainConversationId) return null;
  return roleBindings.bindings?.[mainConversationId]
    || roleBindings.conversations?.[mainConversationId]
    || null;
}

export function prepareOrchestratorHandoffRecord({
  activeState = {},
  activeContract = {},
  roleBindings = {},
  mode = ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY,
  reason = null,
  label = null,
} = {}) {
  const normalizedMode = String(mode || "").toUpperCase();
  if (!Object.values(ORCHESTRATOR_HANDOFF_MODES).includes(normalizedMode)) {
    throw new Error("ORCHESTRATOR_HANDOFF_MODE_INVALID");
  }

  const mainConversationId = roleBindings.mainConversationId || activeState.conversationId || null;
  if (!mainConversationId) throw new Error("ORCHESTRATOR_HANDOFF_MAIN_CONVERSATION_REQUIRED");

  const binding = activeMainBinding(roleBindings, mainConversationId);
  const bindingRole = String(binding?.role || activeState.activeRole || "ORCHESTRATOR").toUpperCase();
  if (!["ORCHESTRATOR", "FLASH_ORCHESTRATOR"].includes(bindingRole)) {
    throw new Error("ORCHESTRATOR_HANDOFF_MAIN_ROLE_INVALID");
  }

  const pending = unconsumedPending(roleBindings);
  if (pending.length > 0) throw new Error("ORCHESTRATOR_HANDOFF_PENDING_SUBAGENTS");

  const inFlight = inFlightDescriptors(activeState);
  if (inFlight.length > 0) throw new Error("ORCHESTRATOR_HANDOFF_IN_FLIGHT_WORK");

  if (
    normalizedMode === ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY
    && !isBoundaryState(activeState)
  ) {
    throw new Error("ORCHESTRATOR_HANDOFF_BOUNDARY_NOT_QUIESCENT");
  }

  const lineageId = roleBindings.orchestratorLineageId
    || activeState.orchestratorLineageId
    || ("orch-lineage-" + hash({
      firstConversationId: mainConversationId,
      firstTaskId: activeState.taskId || activeState.taskKey || null,
    }).slice(0, 24));
  const currentGeneration = Number.isInteger(roleBindings.orchestratorGeneration)
    ? roleBindings.orchestratorGeneration
    : (Number.isInteger(activeState.orchestratorGeneration) ? activeState.orchestratorGeneration : 0);
  const targetGeneration = currentGeneration + 1;

  const capsule = normalizedMode === ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY
    ? makeBoundaryCapsule(activeState, {
        lineageId,
        currentGeneration,
        targetGeneration,
        reason,
        label,
      })
    : sanitizeCapsule(createContinuationCapsule({
        activeState,
        activeContract: activeContract || activeState.scopeContract || {},
        roleBindings,
      }));

  const snapshot = authorityStateSnapshot(activeState, roleBindings);
  const preparedAt = new Date().toISOString();
  const record = finalizeRecord({
    schema: ORCHESTRATOR_HANDOFF_SCHEMA,
    handoff_id: "orch-handoff-" + hash({
      lineageId,
      targetGeneration,
      from: mainConversationId,
      preparedAt,
      state: snapshot,
    }).slice(0, 24),
    status: ORCHESTRATOR_HANDOFF_STATUSES.ARMED,
    mode: normalizedMode,
    lineage_id: lineageId,
    current_generation: currentGeneration,
    target_generation: targetGeneration,
    from_conversation_id: mainConversationId,
    from_profile: binding?.profile || activeState.agentProfile || "flash-orchestrator",
    from_model: binding?.model || activeState.orchestratorModel || null,
    state_fingerprint: hash(snapshot),
    prepared_at: preparedAt,
    reason: clean(reason, 500) || null,
    label: clean(label, 160) || null,
    capsule,
    claimed_at: null,
    claimed_by: null,
    cancelled_at: null,
    cancel_reason: null,
  });

  return record;
}

export function prepareProjectOrchestratorHandoff(repoRoot, options = {}) {
  const paths = runtimePaths(repoRoot);
  const activeState = readJson(paths.statePath, {});
  const activeContract = readJson(paths.contractPath, activeState.scopeContract || {});
  const roleBindings = readJson(paths.roleBindingsPath, {
    mainConversationId: activeState.conversationId || null,
    bindings: {},
    conversations: {},
    pendingSubagents: [],
  });

  const existing = readProjectOrchestratorHandoff(paths.root);
  const currentFingerprint = authorityStateFingerprint(activeState, roleBindings);
  const requestedMode = String(options.mode || ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY).toUpperCase();

  if (
    existing.exists
    && existing.valid
    && existing.record?.status === ORCHESTRATOR_HANDOFF_STATUSES.ARMED
    && existing.record.from_conversation_id === (roleBindings.mainConversationId || activeState.conversationId || null)
    && existing.record.state_fingerprint === currentFingerprint
    && existing.record.mode === requestedMode
  ) {
    return {
      operation: "prepare",
      changed: false,
      idempotent: true,
      record: existing.record,
      path: paths.handoffPath,
    };
  }

  const record = prepareOrchestratorHandoffRecord({
    activeState,
    activeContract,
    roleBindings,
    ...options,
    mode: requestedMode,
  });
  writeJson(paths.handoffPath, record);
  appendTelemetry(paths.telemetryPath, {
    type: "ORCHESTRATOR_HANDOFF_ARMED",
    handoffId: record.handoff_id,
    mode: record.mode,
    lineageId: record.lineage_id,
    currentGeneration: record.current_generation,
    targetGeneration: record.target_generation,
    fromConversationId: record.from_conversation_id,
    taskId: activeState.taskId || activeState.taskKey || null,
    state: activeState.state || null,
  });
  return {
    operation: "prepare",
    changed: true,
    idempotent: false,
    record,
    path: paths.handoffPath,
  };
}

function candidateIsKnownChild(candidateConversationId, roleBindings = {}) {
  const binding = roleBindings.bindings?.[candidateConversationId]
    || roleBindings.conversations?.[candidateConversationId]
    || null;
  if (!binding) return false;
  const role = String(binding.role || "").toUpperCase();
  return ["WORKER", "REVIEWER", "INVESTIGATOR", "FLASH_WORKER", "FLASH_REVIEWER"].includes(role)
    || Boolean(binding.parentConversationId)
    || Boolean(binding.delegationKind);
}

export function evaluateOrchestratorHandoffClaim({
  record,
  activeState = {},
  roleBindings = {},
  candidateConversationId,
  parentConversationId = null,
} = {}) {
  const validation = validateOrchestratorHandoffRecord(record);
  if (!validation.valid) return { allowed: false, reason: validation.reason };
  if (record.status !== ORCHESTRATOR_HANDOFF_STATUSES.ARMED) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_NOT_ARMED" };
  }
  const candidate = clean(candidateConversationId, 300);
  if (!candidate) return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_CANDIDATE_REQUIRED" };
  if (candidate === record.from_conversation_id) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_SAME_CONVERSATION" };
  }
  if (parentConversationId) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_ROOT_REQUIRED" };
  }
  if (candidateIsKnownChild(candidate, roleBindings)) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_CHILD_IDENTITY" };
  }

  const currentMain = roleBindings.mainConversationId || activeState.conversationId || null;
  if (currentMain !== record.from_conversation_id) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_MAIN_CHANGED" };
  }
  if (unconsumedPending(roleBindings).length > 0) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_PENDING_SUBAGENTS" };
  }
  if (inFlightDescriptors(activeState).length > 0) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_IN_FLIGHT_WORK" };
  }

  const fingerprint = authorityStateFingerprint(activeState, roleBindings);
  if (fingerprint !== record.state_fingerprint) {
    return { allowed: false, reason: "ORCHESTRATOR_HANDOFF_STALE_STATE_CHANGED" };
  }

  return {
    allowed: true,
    reason: null,
    candidateConversationId: candidate,
    lineageId: record.lineage_id,
    targetGeneration: record.target_generation,
  };
}

function resetMilestoneBoundaryActiveState(activeState = {}, record = {}) {
  const next = structuredClone(activeState || {});
  const preservedBoundary = structuredClone(record.capsule?.previous_task || {});

  const taskScopedKeys = [
    "taskId", "taskKey", "taskAction", "task_action", "taskDomain", "task_domain",
    "criticality", "complexity", "scopeContract", "requiredEvidence", "testsRequired",
    "evidenceLedger", "evidenceSummary", "evidence", "evidenceCandidateHead",
    "pendingPolicyRequirement", "investigationInFlight", "directInvestigationDecisionInFlight",
    "delegatedDecisionInFlight", "criticalReviewInFlight", "ciWait", "twoKeyReview",
    "workerCompletionClaimed", "workerCompletionClaimFactual", "workerCompletionClaimTimestamp",
    "workerCompletionClaimIdentity", "implementationComplete", "workerConversationId",
    "workerValidationObserved", "workerValidationCommand", "workerValidationActor",
    "workerValidationActorConfidence", "workerValidationExecutionId", "workerValidationExitCode",
    "workerValidationMutationSeq", "orchestratorValidationObserved",
    "orchestratorValidationCommand", "orchestratorValidationExitCode",
    "acceptanceResult", "acceptanceActor", "claimCompleted", "blockers",
    "humanGateReason", "retryReason", "retry_reason", "retry_remaining", "remainingAttempts",
    "mutations", "modifiedPaths", "mechanicalFastPath", "pollingTracker",
    "stalled", "circuitBreakerType", "circuitBreakerTripped", "circuitBreaker",
    "userRequestedStatus", "reactiveWakeupDisabled",
  ];
  for (const key of taskScopedKeys) delete next[key];

  next.state = "INTAKE";
  next.acceptanceState = null;
  next.attempt = 0;
  next.mutationSeq = 0;
  next.previousMilestoneBoundary = preservedBoundary;
  next.milestoneBoundaryFreshContext = true;
  return next;
}

export function applyOrchestratorHandoffClaim({
  record,
  activeState = {},
  roleBindings = {},
  candidateConversationId,
  parentConversationId = null,
  modelName = null,
  profile = "flash-orchestrator",
} = {}) {
  const evaluation = evaluateOrchestratorHandoffClaim({
    record,
    activeState,
    roleBindings,
    candidateConversationId,
    parentConversationId,
  });
  if (!evaluation.allowed) return { claimed: false, ...evaluation };

  const now = new Date().toISOString();
  const previousConversationId = record.from_conversation_id;
  const nextConversationId = evaluation.candidateConversationId;
  const nextRoleBindings = structuredClone(roleBindings || {});
  nextRoleBindings.bindings = nextRoleBindings.bindings || {};
  nextRoleBindings.conversations = nextRoleBindings.conversations || {};

  const previous = nextRoleBindings.bindings[previousConversationId]
    || nextRoleBindings.conversations[previousConversationId]
    || {};
  const formerRecord = {
    ...previous,
    conversationId: previousConversationId,
    role: "FORMER_ORCHESTRATOR",
    source: "ORCHESTRATOR_HANDOFF_SUPERSEDED",
    confidence: "HIGH",
    authorityStatus: "TRANSFERRED",
    lineageId: record.lineage_id,
    generation: record.current_generation,
    supersededBy: nextConversationId,
    transferredAt: now,
  };
  nextRoleBindings.bindings[previousConversationId] = formerRecord;
  nextRoleBindings.conversations[previousConversationId] = formerRecord;

  const nextRecord = {
    conversationId: nextConversationId,
    role: "ORCHESTRATOR",
    profile: clean(profile, 120) || "flash-orchestrator",
    model: clean(modelName, 160) || "gemini-3.8-flash-medium",
    source: "ORCHESTRATOR_HANDOFF",
    confidence: "HIGH",
    authorityStatus: "ACTIVE",
    lineageId: record.lineage_id,
    generation: record.target_generation,
    predecessorConversationId: previousConversationId,
    handoffId: record.handoff_id,
    claimedAt: now,
  };
  nextRoleBindings.bindings[nextConversationId] = nextRecord;
  nextRoleBindings.conversations[nextConversationId] = nextRecord;
  nextRoleBindings.mainConversationId = nextConversationId;
  nextRoleBindings.orchestratorLineageId = record.lineage_id;
  nextRoleBindings.orchestratorGeneration = record.target_generation;

  const nextState = record.mode === ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY
    ? resetMilestoneBoundaryActiveState(activeState, record)
    : structuredClone(activeState || {});
  nextState.conversationId = nextConversationId;
  nextState.activeRole = "ORCHESTRATOR";
  nextState.agentProfile = nextRecord.profile;
  nextState.orchestratorModel = nextRecord.model;
  nextState.orchestratorLineageId = record.lineage_id;
  nextState.orchestratorGeneration = record.target_generation;
  nextState.lastOrchestratorHandoff = {
    handoffId: record.handoff_id,
    mode: record.mode,
    fromConversationId: previousConversationId,
    toConversationId: nextConversationId,
    lineageId: record.lineage_id,
    generation: record.target_generation,
    claimedAt: now,
  };
  delete nextState.identityBootstrapRejected;

  const claimedRecord = finalizeRecord({
    ...recordBody(record),
    status: ORCHESTRATOR_HANDOFF_STATUSES.CLAIMED,
    claimed_at: now,
    claimed_by: nextConversationId,
  });

  return {
    claimed: true,
    reason: null,
    activeState: nextState,
    roleBindings: nextRoleBindings,
    record: claimedRecord,
    capsule: sanitizeCapsule(record.capsule || {}),
    previousConversationId,
    nextConversationId,
    lineageId: record.lineage_id,
    generation: record.target_generation,
    telemetry: {
      type: "ORCHESTRATOR_HANDOFF_CLAIMED",
      handoffId: record.handoff_id,
      mode: record.mode,
      lineageId: record.lineage_id,
      generation: record.target_generation,
      fromConversationId: previousConversationId,
      toConversationId: nextConversationId,
      taskId: nextState.taskId || nextState.taskKey || null,
    },
  };
}

export function claimProjectOrchestratorHandoff(repoRoot, {
  candidateConversationId,
  parentConversationId = null,
  modelName = null,
  profile = "flash-orchestrator",
} = {}) {
  const paths = runtimePaths(repoRoot);
  const loaded = readProjectOrchestratorHandoff(paths.root);
  if (!loaded.exists) return { claimed: false, reason: "ORCHESTRATOR_HANDOFF_NOT_FOUND" };
  if (!loaded.valid) return { claimed: false, reason: loaded.reason };

  const activeState = readJson(paths.statePath, {});
  const roleBindings = readJson(paths.roleBindingsPath, {
    mainConversationId: activeState.conversationId || null,
    bindings: {},
    conversations: {},
    pendingSubagents: [],
  });

  const result = applyOrchestratorHandoffClaim({
    record: loaded.record,
    activeState,
    roleBindings,
    candidateConversationId,
    parentConversationId,
    modelName,
    profile,
  });
  if (!result.claimed) return result;

  writeJson(paths.statePath, result.activeState);
  writeJson(paths.roleBindingsPath, result.roleBindings);
  if (result.record.mode === ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY) {
    rmSync(paths.contractPath, { force: true });
  }
  writeJson(paths.handoffPath, result.record);
  appendTelemetry(paths.telemetryPath, result.telemetry);
  return result;
}

export function cancelProjectOrchestratorHandoff(repoRoot, reason = null) {
  const paths = runtimePaths(repoRoot);
  const loaded = readProjectOrchestratorHandoff(paths.root);
  if (!loaded.exists) return { changed: false, reason: "ORCHESTRATOR_HANDOFF_NOT_FOUND", record: null };
  if (!loaded.valid) return { changed: false, reason: loaded.reason, record: loaded.record };
  if (loaded.record.status !== ORCHESTRATOR_HANDOFF_STATUSES.ARMED) {
    return { changed: false, reason: "ORCHESTRATOR_HANDOFF_NOT_ARMED", record: loaded.record };
  }

  const now = new Date().toISOString();
  const record = finalizeRecord({
    ...recordBody(loaded.record),
    status: ORCHESTRATOR_HANDOFF_STATUSES.CANCELLED,
    cancelled_at: now,
    cancel_reason: clean(reason, 500) || null,
  });
  writeJson(paths.handoffPath, record);
  appendTelemetry(paths.telemetryPath, {
    type: "ORCHESTRATOR_HANDOFF_CANCELLED",
    handoffId: record.handoff_id,
    lineageId: record.lineage_id,
    fromConversationId: record.from_conversation_id,
    reason: record.cancel_reason,
  });
  return { changed: true, reason: null, record };
}

export function formatOrchestratorHandoffStatus(result) {
  const record = result?.record || null;
  if (!record) return "Orchestrator handoff: none";
  return [
    "Orchestrator handoff: " + record.status,
    "Mode: " + record.mode,
    "Handoff: " + record.handoff_id,
    "Lineage: " + record.lineage_id,
    "Generation: " + record.current_generation + " -> " + record.target_generation,
    "Prepared: " + record.prepared_at,
    "Claimed: " + (record.claimed_at || "-"),
    "Label: " + (record.label || "-"),
  ].join("\n");
}
