import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  DECISION_TYPES,
  deriveAvailableActions,
  deriveDecisionState,
  deriveValidatedStaticBaseline,
} from "./action-space.mjs";
import { evaluatePolicy } from "./policy-engine.mjs";
import { loadRuntimePolicy } from "./policy-store.mjs";
import { evaluateCanaryPolicyOverlay } from "./canary-mode.mjs";
import { dreamCorrelationKey, recordDecision } from "./decision-recorder.mjs";
import { recordDecisionOutcome } from "./outcome-recorder.mjs";
import { sealWorld, validateWorld, writeSealedWorld } from "./world-sealer.mjs";
import { FULL_EXPLORATION_LIMITS } from "./exploration-governance.mjs";
import {
  prepareExploration,
  runExplorationCommand,
  collectExplorationResult,
  getExplorationBudgetState,
} from "./exploration-lab.mjs";

export const FULL_EXPLORATION_SCHEMA = "orchestra.full-exploration.v1";
export { FULL_EXPLORATION_LIMITS } from "./exploration-governance.mjs";

const FULL_EXPLORATION_ROOT = ".agents/dream-data/full-exploration";
const CONTROL_PATH = FULL_EXPLORATION_ROOT + "/control.json";
const BRANCH_SESSION_PATH = ".agents/state/dream/exploration-session.json";
const ACTIVE_STATE_PATH = ".agents/state/active-state.json";
const VALID_TERMINAL_STATES = new Set([
  "ACCEPTED",
  "RETRY_REQUIRED",
  "HUMAN_GATE",
  "BLOCKED",
  "FAILED",
  "UNKNOWN",
  "ABORTED",
]);

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeRead(path, fallback = null) {
  try {
    return existsSync(path) ? readJson(path) : fallback;
  } catch {
    return fallback;
  }
}

function controlPath(repoRoot) {
  return resolve(repoRoot, CONTROL_PATH);
}

function controllerPaths(repoRoot, control) {
  const root = resolve(repoRoot, FULL_EXPLORATION_ROOT, "sessions", control.session_id);
  return {
    root,
    telemetryPath: resolve(root, "events.jsonl"),
    pendingDir: resolve(root, "pending-decisions"),
  };
}

function terminalBranchStatus(status) {
  return [
    "FINISHED",
    "COLLECTED",
    "PRUNED",
    "FAILED",
    "FAILED_TO_START",
    "TIMEOUT",
    "BLOCKED",
  ].includes(String(status || "").toUpperCase());
}

function highestFeedbackStatus(summary = {}) {
  const counts = summary?.status_counts || {};
  if ((counts.CAUSALLY_VERIFIED || 0) > 0) return "CAUSALLY_VERIFIED";
  if ((counts.FALSIFIED || 0) > 0) return "FALSIFIED";
  if ((counts.SUPPORTED || 0) > 0) return "SUPPORTED";
  if ((counts.OBSERVED || 0) > 0) return "OBSERVED";
  return "UNKNOWN";
}

function branchRuntimeStatus(branch) {
  const explicitTerminal = String(branch?.status || "").toUpperCase();
  if (["FAILED", "FAILED_TO_START", "TIMEOUT", "BLOCKED", "PRUNED"].includes(explicitTerminal)) {
    return {
      status: explicitTerminal,
      model_calls: Number.isInteger(branch?.model_calls) ? branch.model_calls : 0,
      feedback_summary: branch?.feedback_summary || null,
      invalid: true,
    };
  }
  if (!branch?.branch_workspace) {
    const status = branch?.status || "UNKNOWN";
    return {
      status,
      model_calls: Number.isInteger(branch?.model_calls) ? branch.model_calls : 0,
      feedback_summary: branch?.feedback_summary || null,
      invalid: branch?.invalid === true || ["FAILED", "FAILED_TO_START", "TIMEOUT", "BLOCKED"].includes(String(status).toUpperCase()),
    };
  }
  const session = safeRead(resolve(branch.branch_workspace, BRANCH_SESSION_PATH), null);
  const state = safeRead(resolve(branch.branch_workspace, ACTIVE_STATE_PATH), null);
  const budget = getExplorationBudgetState(branch.branch_workspace);
  return {
    status: session?.status || branch.status || "UNKNOWN",
    model_calls: Number.isInteger(budget?.model_calls) ? budget.model_calls : (branch.model_calls || 0),
    feedback_summary: state?.feedbackSummary || branch.feedback_summary || null,
    invalid: Boolean(
      branch.invalid === true
      || state?.scopeViolation
      || state?.forbiddenAccessDetected
      || session?.status === "FAILED_TO_START"
    ),
  };
}

export function loadFullExploration(repoRoot) {
  const path = controlPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const value = readJson(path);
    return value?.schema === FULL_EXPLORATION_SCHEMA ? value : null;
  } catch {
    return null;
  }
}

function refreshControl(repoRoot, control) {
  let totalCalls = 0;
  let active = 0;
  for (const branch of control.branches || []) {
    const runtime = branchRuntimeStatus(branch);
    branch.status = branch.pruned ? "PRUNED" : runtime.status;
    branch.model_calls = runtime.model_calls;
    branch.feedback_summary = runtime.feedback_summary;
    branch.feedback_status = highestFeedbackStatus(runtime.feedback_summary || {});
    branch.invalid = runtime.invalid;
    if (!terminalBranchStatus(branch.status)) active += 1;
    totalCalls += runtime.model_calls || 0;
  }
  control.branches_started = (control.branches || []).length;
  control.branches_active = active;
  control.branches_remaining = Math.max(0, FULL_EXPLORATION_LIMITS.max_branches - control.branches_started);
  control.total_model_calls = totalCalls;
  control.budget_exhausted = Boolean(
    control.branches_remaining <= 0
    || totalCalls >= FULL_EXPLORATION_LIMITS.max_total_model_calls
    || Date.now() >= Date.parse(control.deadline_at)
  );
  control.updated_at = new Date().toISOString();
  return control;
}

function persist(repoRoot, control) {
  refreshControl(repoRoot, control);
  atomicJson(controlPath(repoRoot), control);
  return control;
}

export function startFullExploration({ repoRoot } = {}) {
  if (!repoRoot) return { started: false, reason: "MISSING_REPO_ROOT" };
  const existing = loadFullExploration(repoRoot);
  if (existing && existing.status === "ACTIVE" && !existing.budget_exhausted) {
    return {
      started: false,
      reason: "FULL_EXPLORATION_ALREADY_ACTIVE",
      control: refreshControl(repoRoot, existing),
    };
  }

  const now = Date.now();
  const control = {
    schema: FULL_EXPLORATION_SCHEMA,
    session_id: "full-explore-" + randomUUID(),
    status: "ACTIVE",
    limits: { ...FULL_EXPLORATION_LIMITS },
    branches: [],
    decisions: [],
    decision_seq: 0,
    branches_started: 0,
    branches_active: 0,
    branches_remaining: FULL_EXPLORATION_LIMITS.max_branches,
    total_model_calls: 0,
    budget_exhausted: false,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    deadline_at: new Date(now + FULL_EXPLORATION_LIMITS.timeout_ms).toISOString(),
  };
  persist(repoRoot, control);
  return { started: true, control };
}

function stateForDecision(seed, control, branch = null) {
  const seedState = seed?.decision?.state || {};
  const primary = safeRead(resolve(control.repo_root || ".", ACTIVE_STATE_PATH), {}) || {};
  const feedbackSummary = branch?.feedback_summary || primary.feedbackSummary || {};
  const activeState = {
    ...primary,
    state: seedState.state || primary.state || "EXECUTING",
    taskAction: seedState.task_action || primary.taskAction || seed?.task_descriptor?.task_action || "INVESTIGATE",
    taskDomain: seedState.task_domain || primary.taskDomain || seed?.task_descriptor?.task_domain || "RESEARCH",
    criticality: seedState.criticality || primary.criticality || "NORMAL",
    complexity: seedState.complexity || primary.complexity || "EXPERIMENTAL",
    attempt: seedState.attempt ?? primary.attempt ?? 0,
    retry_remaining: seedState.retry_remaining ?? primary.retry_remaining ?? 0,
    mutationSeq: seedState.mutation_seq ?? primary.mutationSeq ?? 0,
    post_investigation: seedState.post_investigation ?? primary.post_investigation ?? false,
    feedbackSummary,
    explorationControl: {
      max_branches: FULL_EXPLORATION_LIMITS.max_branches,
      branches_started: control.branches_started,
      branches_active: control.branches_active,
      branches_remaining: control.branches_remaining,
      branch_feedback_status: branch?.feedback_status || "UNKNOWN",
      branch_invalid: branch?.invalid === true,
    },
  };
  return deriveDecisionState(seed?.task_descriptor || {}, activeState, seed?.evidence_summary || {});
}

function evaluateDecision({ repoRoot, seed, control, decisionType, branch = null }) {
  const state = stateForDecision(seed, control, branch);
  const availableActions = deriveAvailableActions(decisionType, state);
  const baselineAction = deriveValidatedStaticBaseline({
    decisionType,
    facts: seed?.task_descriptor || {},
    state,
  }) || availableActions[0] || null;

  if (!baselineAction || availableActions.length === 0) {
    return {
      ok: false,
      action: null,
      source: "STATIC_GOVERNANCE",
      availableActions,
      state,
      baselineAction,
      diagnostic: "NO_LEGAL_ACTION",
    };
  }

  const loaded = loadRuntimePolicy(repoRoot);
  let result = {
    ok: true,
    action: baselineAction,
    source: "STATIC_ROUTING_FALLBACK",
    policy_id: loaded?.policy?.policy_id || null,
    baseline_action: baselineAction,
    policy_diagnostic: loaded?.reason || null,
  };

  if (loaded?.ok && loaded.policy) {
    const evaluated = evaluatePolicy({
      policy: loaded.policy,
      decisionType,
      state,
      availableActions,
      baselineAction,
    });
    if (evaluated.ok) {
      result = {
        ok: true,
        action: evaluated.action,
        source: loaded.source === "ACTIVE_POLICY" ? "ACTIVE_POLICY" : "STATIC_POLICY_V1",
        policy_id: evaluated.policy_id,
        baseline_action: baselineAction,
        policy_diagnostic: null,
      };
      const canary = evaluateCanaryPolicyOverlay({
        repoRoot,
        taskId: seed?.task_descriptor?.task_id || seed?.snapshot?.task_fingerprint || control.session_id,
        decisionType,
        state,
        availableActions,
        baselineAction: result.action,
        baselinePolicyId: loaded.policy.policy_id,
        activeState: {
          taskSpec: seed?.task_descriptor?.spec || "Full isolated exploration",
          criticality: state.criticality,
          state: state.state,
        },
        activeContract: seed?.scope_contract || {},
      });
      if (canary?.active && !canary.blocked) {
        result = {
          ok: true,
          action: canary.action,
          source: canary.source,
          policy_id: canary.policy_id,
          baseline_action: result.action,
          policy_diagnostic: canary.policy_diagnostic || null,
        };
      }
    } else {
      result.policy_diagnostic = evaluated.diagnostic;
    }
  }

  if (!availableActions.includes(result.action)) {
    result = {
      ok: false,
      action: baselineAction,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: loaded?.policy?.policy_id || null,
      baseline_action: baselineAction,
      policy_diagnostic: "POLICY_ACTION_OUTSIDE_STATIC_LEGAL_SET",
    };
  }

  return { ...result, availableActions, state, baselineAction };
}

function recordControllerDecision({
  repoRoot,
  seed,
  control,
  decisionType,
  evaluation,
  branchOrdinal,
}) {
  control.decision_seq += 1;
  const correlationKey = dreamCorrelationKey({
    conversationId: control.session_id,
    stepIdx: control.decision_seq,
    toolCallId: "full-" + decisionType.toLowerCase(),
    branchOrdinal,
  });
  const paths = controllerPaths(repoRoot, control);
  const recorded = recordDecision({
    repoRoot,
    telemetryPath: paths.telemetryPath,
    pendingDir: paths.pendingDir,
    snapshot: seed.snapshot,
    decision: {
      decision_type: decisionType,
      state: evaluation.state,
      available_actions: evaluation.availableActions,
      chosen_action: evaluation.action,
      policy_source: evaluation.source || "STATIC_POLICY_V1",
      policy_id: evaluation.policy_id || null,
      baseline_action: evaluation.baseline_action || evaluation.baselineAction || null,
      policy_diagnostic: evaluation.policy_diagnostic || null,
      actor_identity: {
        role: "FULL_EXPLORATION_CONTROLLER",
        confidence: "HIGH",
        source: "RUNTIME_AUTHORITY",
        resolved: true,
      },
      conversation_id: control.session_id,
      step_idx: control.decision_seq,
      tool_call_id: "full-" + decisionType.toLowerCase(),
      branch_ordinal: branchOrdinal,
    },
    correlationKey,
  });

  const record = {
    local_id: "full-decision-" + randomUUID(),
    decision_type: decisionType,
    action: evaluation.action,
    source: evaluation.source,
    policy_id: evaluation.policy_id || null,
    baseline_action: evaluation.baseline_action || evaluation.baselineAction || null,
    recorded: recorded.recorded === true,
    decision_id: recorded.decision_id || null,
    correlation_key: recorded.correlationKey || correlationKey,
    branch_ordinal: branchOrdinal,
    runtime_fingerprint: seed?.snapshot?.runtime_fingerprint || seed?.runtime_fingerprint || null,
    outcome_status: recorded.recorded === true ? "PENDING" : "UNRECORDED",
    record_reason: recorded.reason || null,
    observed_at: new Date().toISOString(),
  };
  control.decisions.push(record);
  if (control.decisions.length > 150) control.decisions = control.decisions.slice(-150);
  return record;
}

function controllerEvents(repoRoot, control) {
  const { telemetryPath } = controllerPaths(repoRoot, control);
  if (!existsSync(telemetryPath)) return [];
  try {
    return readFileSync(telemetryPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function sealControllerDecisionWorld(repoRoot, control, decisionRecord) {
  const events = controllerEvents(repoRoot, control);
  const decision = events.find((event) => (
    (event?.type === "DECISION" || event?.schema === "orchestra.decision.v1")
    && event?.decision_id === decisionRecord.decision_id
  ));
  const outcome = events.find((event) => (
    (event?.type === "DECISION_OUTCOME" || event?.schema === "orchestra.outcome.v1")
    && event?.decision_id === decisionRecord.decision_id
  ));
  if (!decision || !outcome) {
    return { sealed: false, reason: "CONTROLLER_DECISION_PAIR_INCOMPLETE" };
  }

  const sealed = sealWorld({
    events: [decision, outcome],
    rootSnapshotId: decision.snapshot_id,
    expectedRuntimeFingerprint: decisionRecord.runtime_fingerprint,
  });
  if (sealed.status !== "SEALED" || !sealed.world) {
    return {
      sealed: false,
      reason: sealed.status || "CONTROLLER_WORLD_SEAL_FAILED",
      errors: sealed.errors || [],
    };
  }
  const written = writeSealedWorld(repoRoot, sealed.world);
  if (!written.written) {
    return {
      sealed: false,
      reason: written.reason || "CONTROLLER_WORLD_WRITE_FAILED",
      errors: written.errors || [],
    };
  }
  return {
    sealed: true,
    world_id: sealed.world.world_id,
    path: written.path,
  };
}

function completeControllerDecision({
  repoRoot,
  control,
  decisionRecord,
  outcome,
}) {
  if (!decisionRecord?.recorded) {
    return { completed: false, reason: "CONTROLLER_DECISION_NOT_RECORDED" };
  }
  if (decisionRecord.outcome_status === "COMPLETE" && decisionRecord.outcome_world_id) {
    return {
      completed: true,
      reused: true,
      world_id: decisionRecord.outcome_world_id,
    };
  }

  const paths = controllerPaths(repoRoot, control);
  const recorded = recordDecisionOutcome({
    repoRoot,
    telemetryPath: paths.telemetryPath,
    pendingDir: paths.pendingDir,
    correlationKey: decisionRecord.correlation_key,
    outcome,
  });
  const outcomeAvailable = recorded.recorded === true || recorded.reason === "OUTCOME_ALREADY_RECORDED";
  if (!outcomeAvailable) {
    decisionRecord.outcome_status = "OUTCOME_RECORD_FAILED";
    decisionRecord.outcome_reason = recorded.reason || null;
    return {
      completed: false,
      reason: recorded.reason || "CONTROLLER_OUTCOME_RECORD_FAILED",
    };
  }

  decisionRecord.outcome_status = "RECORDED_UNSEALED";
  decisionRecord.outcome_terminal_state = outcome.terminal_state || null;
  const sealed = sealControllerDecisionWorld(repoRoot, control, decisionRecord);
  if (!sealed.sealed) {
    decisionRecord.outcome_reason = sealed.reason;
    return { completed: false, reason: sealed.reason, errors: sealed.errors || [] };
  }

  decisionRecord.outcome_status = "COMPLETE";
  decisionRecord.outcome_world_id = sealed.world_id;
  decisionRecord.outcome_world_path = sealed.path;
  decisionRecord.outcome_reason = null;
  decisionRecord.completed_at = new Date().toISOString();
  return { completed: true, world_id: sealed.world_id, path: sealed.path };
}

function aggregateWorldCost(world) {
  const totals = {};
  for (const outcome of world?.outcomes || []) {
    const cost = outcome?.cost_metrics;
    if (!cost || typeof cost !== "object") continue;
    for (const [key, value] of Object.entries(cost)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = (totals[key] || 0) + value;
      }
    }
  }
  return totals;
}

function normalizeTerminalState(outcome) {
  const direct = String(outcome?.terminal_state || "").toUpperCase();
  if (VALID_TERMINAL_STATES.has(direct)) return direct;
  const result = typeof outcome?.result === "string"
    ? outcome.result
    : outcome?.result?.status || outcome?.result?.result || "";
  const token = String(result || "").toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "PASS", "PASSED", "ACCEPTED"].includes(token)) return "ACCEPTED";
  if (["FAIL", "FAILED", "FAILURE", "ERROR"].includes(token)) return "FAILED";
  if (token === "BLOCKED") return "BLOCKED";
  return "UNKNOWN";
}

function factualOutcomeFromWorld(world, details = {}) {
  const validation = validateWorld(world);
  if (!validation.valid) {
    return {
      result: {
        factual: false,
        reason: "SOURCE_WORLD_INVALID",
        errors: validation.errors,
        ...details,
      },
      evidence_summary: {
        tests: "UNKNOWN",
        typecheck: "UNKNOWN",
        build: "UNKNOWN",
        validation_fresh: false,
        scope_check: "UNKNOWN",
      },
      retry_state: { attempt: 0, retry_remaining: 0 },
      cost_metrics: {},
      terminal_state: "FAILED",
      resulting_snapshot_id: null,
    };
  }

  const outcomes = Array.isArray(world.outcomes) ? world.outcomes : [];
  const last = outcomes.length > 0 ? outcomes[outcomes.length - 1] : null;
  const cost = aggregateWorldCost(world);
  if (Number.isInteger(details.exploration_model_calls)) {
    cost.model_calls = Math.max(cost.model_calls || 0, details.exploration_model_calls);
  }

  return {
    result: {
      factual: true,
      attributable: true,
      source_world_id: world.world_id || null,
      source_observation_id: last?.observation_id || null,
      source_terminal_state: normalizeTerminalState(last),
      ...details,
    },
    evidence_summary: last?.evidence_summary && typeof last.evidence_summary === "object"
      ? last.evidence_summary
      : {
          tests: "UNKNOWN",
          typecheck: "UNKNOWN",
          build: "UNKNOWN",
          validation_fresh: false,
          scope_check: "UNKNOWN",
        },
    retry_state: last?.retry_state && typeof last.retry_state === "object"
      ? last.retry_state
      : { attempt: 0, retry_remaining: 0 },
    cost_metrics: cost,
    terminal_state: normalizeTerminalState(last),
    resulting_snapshot_id: null,
  };
}

function unattributableOutcome(reason, details = {}) {
  return {
    result: {
      factual: true,
      attributable: false,
      support_status: "INSUFFICIENT_SUPPORT",
      status: "UNKNOWN",
      reason: String(reason || "FULL_EXPLORATION_UNATTRIBUTABLE"),
      ...details,
    },
    evidence_summary: {
      tests: "UNKNOWN",
      typecheck: "UNKNOWN",
      build: "UNKNOWN",
      validation_fresh: false,
      scope_check: "UNKNOWN",
    },
    retry_state: { attempt: 0, retry_remaining: 0 },
    cost_metrics: {
      model_calls: Number.isInteger(details.exploration_model_calls) ? details.exploration_model_calls : 0,
    },
    terminal_state: "UNKNOWN",
    resulting_snapshot_id: null,
  };
}

function factualPruneOutcome(branch, action) {
  const shouldPrune = branch.invalid === true || branch.feedback_status === "FALSIFIED";
  const actionConsistent = (
    (shouldPrune && action === "PRUNE_BRANCH")
    || (!shouldPrune && action === "KEEP_BRANCH")
  );
  return {
    result: {
      factual: true,
      attributable: true,
      action,
      branch_id: branch.branch_id,
      branch_feedback_status: branch.feedback_status || "UNKNOWN",
      branch_invalid: branch.invalid === true,
      action_consistent_with_facts: actionConsistent,
    },
    evidence_summary: {
      tests: "NOT_REQUIRED",
      typecheck: "NOT_REQUIRED",
      build: "NOT_REQUIRED",
      validation_fresh: true,
      scope_check: branch.invalid === true ? "FAIL" : "PASS",
    },
    retry_state: { attempt: 0, retry_remaining: 0 },
    cost_metrics: { model_calls: 0 },
    terminal_state: actionConsistent ? "ACCEPTED" : "FAILED",
    resulting_snapshot_id: null,
  };
}

function latestObservedWorld(control, fallbackWorld) {
  for (let index = (control.branches || []).length - 1; index >= 0; index -= 1) {
    const branch = control.branches[index];
    const path = branch?.collection?.path;
    if (!branch?.collection?.collected || !path || !existsSync(path)) continue;
    const world = safeRead(path, null);
    if (world && validateWorld(world).valid) return world;
  }
  return fallbackWorld;
}

function completeBranchDecisionSet(repoRoot, control, branch, outcome) {
  const results = [];
  for (const localId of branch.deferred_decision_ids || []) {
    const decisionRecord = (control.decisions || []).find((item) => item.local_id === localId);
    if (!decisionRecord) {
      results.push({ completed: false, reason: "CONTROLLER_DECISION_REFERENCE_MISSING", local_id: localId });
      continue;
    }
    const branchOutcome = {
      ...outcome,
      result: {
        ...(outcome.result || {}),
        controller_session_id: control.session_id,
        branch_id: branch.branch_id,
        decision_type: decisionRecord.decision_type,
        action: decisionRecord.action,
      },
    };
    results.push(completeControllerDecision({
      repoRoot,
      control,
      decisionRecord,
      outcome: branchOutcome,
    }));
  }
  branch.decision_outcomes_finalized = results.length > 0 && results.every((item) => item.completed === true);
  branch.decision_outcome_results = results;
  return results;
}

function loadSeed(seedPath) {
  if (!seedPath || !existsSync(resolve(seedPath))) return null;
  try {
    const seed = readJson(resolve(seedPath));
    return seed?.schema === "orchestra.branch-seed.v1" ? seed : null;
  } catch {
    return null;
  }
}

function canStartAnother(control, parallelismAction) {
  if (control.status !== "ACTIVE") return { allowed: false, reason: "FULL_EXPLORATION_NOT_ACTIVE" };
  if (control.budget_exhausted) return { allowed: false, reason: "FULL_EXPLORATION_BUDGET_EXHAUSTED" };
  if (control.branches_started >= FULL_EXPLORATION_LIMITS.max_branches) {
    return { allowed: false, reason: "FULL_EXPLORATION_BRANCH_LIMIT" };
  }
  if (control.total_model_calls >= FULL_EXPLORATION_LIMITS.max_total_model_calls) {
    return { allowed: false, reason: "FULL_EXPLORATION_MODEL_CALL_LIMIT" };
  }
  const allowedActive = parallelismAction === "PARALLEL_2"
    ? FULL_EXPLORATION_LIMITS.max_parallel
    : 1;
  if (control.branches_active >= allowedActive) {
    return {
      allowed: false,
      reason: parallelismAction === "PARALLEL_2"
        ? "FULL_EXPLORATION_PARALLEL_LIMIT"
        : "FULL_EXPLORATION_SERIAL_WAIT",
    };
  }
  return { allowed: true };
}

function recordImmediateWorldBoundDecision({
  repoRoot,
  seed,
  control,
  decisionType,
  evaluation,
  branchOrdinal,
  world,
  details,
}) {
  const decisionRecord = recordControllerDecision({
    repoRoot,
    seed,
    control,
    decisionType,
    evaluation,
    branchOrdinal,
  });
  if (!decisionRecord.recorded) {
    return { decisionRecord, completion: { completed: false, reason: decisionRecord.record_reason } };
  }
  const completion = completeControllerDecision({
    repoRoot,
    control,
    decisionRecord,
    outcome: factualOutcomeFromWorld(world, {
      controller_session_id: control.session_id,
      decision_type: decisionType,
      action: evaluation.action,
      ...details,
    }),
  });
  return { decisionRecord, completion };
}

export function prepareFullExplorationBranch({
  repoRoot,
  seedPath,
  world,
  decisionId = null,
} = {}) {
  if (!repoRoot || !seedPath || !world) {
    return { prepared: false, reason: "MISSING_PREPARE_INPUT" };
  }
  const worldValidation = validateWorld(world);
  if (!worldValidation.valid) {
    return { prepared: false, reason: "WORLD_INVALID", errors: worldValidation.errors };
  }

  const control = loadFullExploration(repoRoot);
  if (!control) return { prepared: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  control.repo_root = resolve(repoRoot);
  refreshControl(repoRoot, control);

  const seed = loadSeed(seedPath);
  if (!seed) return { prepared: false, reason: "BRANCH_SEED_INVALID" };

  const contextBranch = [...(control.branches || [])].reverse().find((branch) => terminalBranchStatus(branch.status)) || null;
  const observedWorld = latestObservedWorld(control, world);
  const branchOrdinal = control.branches.length;

  const stop = evaluateDecision({
    repoRoot,
    seed,
    control,
    decisionType: DECISION_TYPES.STOPPING,
    branch: contextBranch,
  });
  if (stop.action === "STOP_EXPLORATION") {
    const immediate = recordImmediateWorldBoundDecision({
      repoRoot,
      seed,
      control,
      decisionType: DECISION_TYPES.STOPPING,
      evaluation: stop,
      branchOrdinal,
      world: observedWorld,
      details: { reason: "POLICY_STOP_BEFORE_NEW_BRANCH" },
    });
    control.status = "STOPPED";
    control.stop_reason = "FULL_EXPLORATION_POLICY_STOP";
    control.stopped_at = new Date().toISOString();
    persist(repoRoot, control);
    return {
      prepared: false,
      reason: "FULL_EXPLORATION_POLICY_STOP",
      decision: immediate.decisionRecord,
      control,
    };
  }

  const branching = evaluateDecision({
    repoRoot,
    seed,
    control,
    decisionType: DECISION_TYPES.EXPLORATION_BRANCHING,
    branch: contextBranch,
  });
  if (branching.action !== "OPEN_BRANCH") {
    const immediate = recordImmediateWorldBoundDecision({
      repoRoot,
      seed,
      control,
      decisionType: DECISION_TYPES.EXPLORATION_BRANCHING,
      evaluation: branching,
      branchOrdinal,
      world: observedWorld,
      details: { reason: "POLICY_NO_NEW_BRANCH" },
    });
    control.status = "STOPPED";
    control.stop_reason = "FULL_EXPLORATION_POLICY_NO_NEW_BRANCH";
    control.stopped_at = new Date().toISOString();
    persist(repoRoot, control);
    return {
      prepared: false,
      reason: "FULL_EXPLORATION_POLICY_NO_NEW_BRANCH",
      decision: immediate.decisionRecord,
      control,
    };
  }

  const parallelism = evaluateDecision({
    repoRoot,
    seed,
    control,
    decisionType: DECISION_TYPES.PARALLELISM,
    branch: contextBranch,
  });
  const budget = canStartAnother(control, parallelism.action);
  if (!budget.allowed) {
    persist(repoRoot, control);
    return {
      prepared: false,
      reason: budget.reason,
      parallelism: parallelism.action,
      control,
    };
  }

  // These decisions become factual only because the runtime is about to apply
  // them. Their OUTCOMEs remain pending until the branch reaches a factual
  // terminal result (sealed world or factual runner/collection failure).
  const deferredRecords = [
    recordControllerDecision({
      repoRoot,
      seed,
      control,
      decisionType: DECISION_TYPES.STOPPING,
      evaluation: stop,
      branchOrdinal,
    }),
    recordControllerDecision({
      repoRoot,
      seed,
      control,
      decisionType: DECISION_TYPES.EXPLORATION_BRANCHING,
      evaluation: branching,
      branchOrdinal,
    }),
    recordControllerDecision({
      repoRoot,
      seed,
      control,
      decisionType: DECISION_TYPES.PARALLELISM,
      evaluation: parallelism,
      branchOrdinal,
    }),
  ];

  const unrecorded = deferredRecords.filter((record) => !record.recorded);
  if (unrecorded.length > 0) {
    const abortOutcome = {
      result: {
        factual: true,
        status: "ABORTED",
        reason: "CONTROLLER_DECISION_RECORDING_INCOMPLETE",
        controller_session_id: control.session_id,
      },
      evidence_summary: {
        tests: "UNKNOWN",
        typecheck: "UNKNOWN",
        build: "UNKNOWN",
        validation_fresh: false,
        scope_check: "UNKNOWN",
      },
      retry_state: { attempt: 0, retry_remaining: 0 },
      cost_metrics: { model_calls: 0 },
      terminal_state: "ABORTED",
      resulting_snapshot_id: null,
    };
    for (const record of deferredRecords.filter((item) => item.recorded)) {
      completeControllerDecision({ repoRoot, control, decisionRecord: record, outcome: abortOutcome });
    }
    control.status = "BLOCKED";
    control.stop_reason = "CONTROLLER_DECISION_RECORDING_INCOMPLETE";
    control.stopped_at = new Date().toISOString();
    persist(repoRoot, control);
    return {
      prepared: false,
      reason: "CONTROLLER_DECISION_RECORDING_INCOMPLETE",
      decisions: deferredRecords,
      control,
    };
  }

  const prepared = prepareExploration({
    repoRoot,
    seedPath: resolve(seedPath),
    world,
    decisionId,
    fullExplorationContext: {
      session_id: control.session_id,
      branch_ordinal: branchOrdinal,
    },
  });

  const branch = {
    branch_id: "full-branch-" + randomUUID(),
    ordinal: branchOrdinal,
    seed_path: resolve(seedPath),
    source_world_id: world.world_id || null,
    source_decision_id: prepared.session?.source?.decision_id || decisionId || null,
    exploration_session_id: prepared.session?.session_id || null,
    branch_workspace: prepared.branch_workspace || null,
    selected_action: prepared.selection?.selected || null,
    policy_parallelism: parallelism.action,
    deferred_decision_ids: deferredRecords.map((record) => record.local_id),
    decision_outcomes_finalized: false,
    status: prepared.prepared ? "PREPARED" : "FAILED_TO_START",
    model_calls: 0,
    feedback_summary: null,
    feedback_status: "UNKNOWN",
    invalid: !prepared.prepared,
    pruned: false,
    created_at: new Date().toISOString(),
  };
  if (!prepared.prepared) {
    branch.prepare_failure = {
      reason: prepared.reason || "EXPLORATION_PREPARE_FAILED",
      error: prepared.error || null,
    };
  }
  control.branches.push(branch);

  if (!prepared.prepared) {
    completeBranchDecisionSet(
      repoRoot,
      control,
      branch,
      unattributableOutcome(prepared.reason || "EXPLORATION_PREPARE_FAILED", {
        branch_id: branch.branch_id,
        controller_session_id: control.session_id,
        source_world_id: world.world_id || null,
      }),
    );
    persist(repoRoot, control);
    return {
      ...prepared,
      full_exploration: true,
      branch,
      control,
    };
  }

  persist(repoRoot, control);
  return { prepared: true, branch, exploration: prepared, control };
}

export function runFullExplorationBranch({
  repoRoot,
  branchId,
  command,
  args = [],
} = {}) {
  const control = loadFullExploration(repoRoot);
  if (!control) return { ran: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  refreshControl(repoRoot, control);
  const branch = control.branches.find((item) => item.branch_id === branchId);
  if (!branch) return { ran: false, reason: "FULL_EXPLORATION_BRANCH_NOT_FOUND" };
  if (branch.pruned) return { ran: false, reason: "FULL_EXPLORATION_BRANCH_PRUNED" };
  if (!branch.branch_workspace) return { ran: false, reason: "FULL_EXPLORATION_BRANCH_NOT_RUNNABLE" };
  if (control.total_model_calls >= FULL_EXPLORATION_LIMITS.max_total_model_calls) {
    control.budget_exhausted = true;
    persist(repoRoot, control);
    return { ran: false, reason: "FULL_EXPLORATION_MODEL_CALL_LIMIT" };
  }

  const out = runExplorationCommand({
    branchWorkspace: branch.branch_workspace,
    command,
    args,
  });
  branch.status = out.timed_out ? "TIMEOUT" : out.ran ? "FINISHED" : "FAILED_TO_START";
  branch.run_result = {
    ran: out.ran === true,
    exit_code: out.exit_code ?? null,
    signal: out.signal || null,
    timed_out: out.timed_out === true,
    sandbox_forced: out.sandbox_forced === true,
    reason: out.reason || null,
  };
  refreshControl(repoRoot, control);

  if (["TIMEOUT", "FAILED_TO_START"].includes(branch.status)) {
    branch.invalid = true;
    completeBranchDecisionSet(
      repoRoot,
      control,
      branch,
      unattributableOutcome(out.reason || branch.status, {
        branch_id: branch.branch_id,
        controller_session_id: control.session_id,
        exploration_model_calls: branch.model_calls || 0,
        runner_status: branch.status,
      }),
    );
  }

  persist(repoRoot, control);
  return { ...out, branch, control };
}

export function collectFullExplorationBranch({ repoRoot, branchId } = {}) {
  const control = loadFullExploration(repoRoot);
  if (!control) return { collected: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  refreshControl(repoRoot, control);
  const branch = control.branches.find((item) => item.branch_id === branchId);
  if (!branch) return { collected: false, reason: "FULL_EXPLORATION_BRANCH_NOT_FOUND" };

  if (!branch.branch_workspace) {
    persist(repoRoot, control);
    return {
      collected: false,
      reason: branch.prepare_failure?.reason || "FULL_EXPLORATION_BRANCH_NOT_COLLECTABLE",
      branch,
      control,
    };
  }

  const seed = loadSeed(branch.seed_path);
  if (!seed) return { collected: false, reason: "BRANCH_SEED_INVALID" };

  const collected = collectExplorationResult({
    primaryRepoRoot: repoRoot,
    branchWorkspace: branch.branch_workspace,
  });
  branch.collection = collected;
  branch.status = collected.collected ? "COLLECTED" : branch.status;
  refreshControl(repoRoot, control);

  if (!collected.collected) {
    if (terminalBranchStatus(branch.status) || branch.status === "FINISHED") {
      branch.invalid = true;
      branch.status = branch.status === "FINISHED" ? "FAILED" : branch.status;
      completeBranchDecisionSet(
        repoRoot,
        control,
        branch,
        unattributableOutcome(collected.reason || "EXPLORATION_COLLECTION_FAILED", {
          branch_id: branch.branch_id,
          controller_session_id: control.session_id,
          exploration_model_calls: branch.model_calls || 0,
          collection_reason: collected.reason || null,
        }),
      );
    }
    persist(repoRoot, control);
    return { ...collected, branch, control };
  }

  const branchWorld = safeRead(collected.path, null);
  if (!branchWorld || !validateWorld(branchWorld).valid) {
    branch.invalid = true;
    branch.status = "FAILED";
    completeBranchDecisionSet(
      repoRoot,
      control,
      branch,
      unattributableOutcome("COLLECTED_WORLD_INVALID", {
        branch_id: branch.branch_id,
        controller_session_id: control.session_id,
        exploration_model_calls: branch.model_calls || 0,
      }),
    );
    persist(repoRoot, control);
    return {
      collected: false,
      reason: "COLLECTED_WORLD_INVALID",
      branch,
      control,
    };
  }

  completeBranchDecisionSet(
    repoRoot,
    control,
    branch,
    factualOutcomeFromWorld(branchWorld, {
      branch_world_id: branchWorld.world_id || collected.world_id || null,
      branch_id: branch.branch_id,
      controller_session_id: control.session_id,
      exploration_model_calls: branch.model_calls || collected.model_calls || 0,
      selected_action: branch.selected_action || null,
    }),
  );

  const prune = evaluateDecision({
    repoRoot,
    seed,
    control,
    decisionType: DECISION_TYPES.PRUNE_BRANCH,
    branch,
  });
  const pruneRecord = recordControllerDecision({
    repoRoot,
    seed,
    control,
    decisionType: DECISION_TYPES.PRUNE_BRANCH,
    evaluation: prune,
    branchOrdinal: branch.ordinal,
  });
  if (pruneRecord.recorded) {
    completeControllerDecision({
      repoRoot,
      control,
      decisionRecord: pruneRecord,
      outcome: factualPruneOutcome(branch, prune.action),
    });
  }

  if (prune.action === "PRUNE_BRANCH") {
    branch.pruned = true;
    branch.status = "PRUNED";
    branch.pruned_at = new Date().toISOString();
  }

  persist(repoRoot, control);
  return {
    ...collected,
    branch,
    prune_action: prune.action,
    stopping_action: null,
    control,
  };
}

export function stopFullExploration({ repoRoot, reason = "HUMAN_STOP" } = {}) {
  const control = loadFullExploration(repoRoot);
  if (!control) return { stopped: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  control.status = "STOPPED";
  control.stop_reason = String(reason || "HUMAN_STOP");
  control.stopped_at = new Date().toISOString();
  persist(repoRoot, control);
  return {
    stopped: true,
    pending_decision_outcomes: (control.decisions || []).filter((item) => item.outcome_status === "PENDING").length,
    control,
  };
}

export function fullExplorationStatus({ repoRoot } = {}) {
  const control = loadFullExploration(repoRoot);
  if (!control) return { active: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  persist(repoRoot, control);
  return {
    active: control.status === "ACTIVE" && !control.budget_exhausted,
    status: control.status,
    limits: control.limits,
    branches_started: control.branches_started,
    branches_active: control.branches_active,
    branches_remaining: control.branches_remaining,
    total_model_calls: control.total_model_calls,
    budget_exhausted: control.budget_exhausted,
    pending_decision_outcomes: (control.decisions || []).filter((item) => (
      item.outcome_status === "PENDING"
      || item.outcome_status === "RECORDED_UNSEALED"
    )).length,
    decision_worlds: (control.decisions || [])
      .filter((item) => item.outcome_world_id)
      .map((item) => item.outcome_world_id),
    branches: control.branches.map((branch) => ({
      branch_id: branch.branch_id,
      status: branch.status,
      model_calls: branch.model_calls,
      selected_action: branch.selected_action,
      feedback_status: branch.feedback_status,
      pruned: branch.pruned === true,
      decision_outcomes_finalized: branch.decision_outcomes_finalized === true,
    })),
  };
}
