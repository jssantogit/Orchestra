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
import {
  EXPLORATION_BUDGET,
  prepareExploration,
  runExplorationCommand,
  collectExplorationResult,
  getExplorationBudgetState,
} from "./exploration-lab.mjs";

export const FULL_EXPLORATION_SCHEMA = "orchestra.full-exploration.v1";
export const FULL_EXPLORATION_LIMITS = Object.freeze({
  max_branches: 3,
  max_parallel: 2,
  max_total_model_calls: 6,
  timeout_ms: 900000,
});

const CONTROL_PATH = ".agents/dream-data/full-exploration/control.json";
const BRANCH_SESSION_PATH = ".agents/state/dream/exploration-session.json";
const ACTIVE_STATE_PATH = ".agents/state/active-state.json";

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function controlPath(repoRoot) {
  return resolve(repoRoot, CONTROL_PATH);
}

function safeRead(path, fallback = null) {
  try {
    return existsSync(path) ? readJson(path) : fallback;
  } catch {
    return fallback;
  }
}

function terminalBranchStatus(status) {
  return ["FINISHED", "COLLECTED", "PRUNED", "FAILED", "FAILED_TO_START", "TIMEOUT", "BLOCKED"].includes(String(status || "").toUpperCase());
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
  if (!branch?.branch_workspace) return { status: branch?.status || "UNKNOWN", model_calls: 0, feedback_summary: branch?.feedback_summary || null };
  const session = safeRead(resolve(branch.branch_workspace, BRANCH_SESSION_PATH), null);
  const state = safeRead(resolve(branch.branch_workspace, ACTIVE_STATE_PATH), null);
  const budget = getExplorationBudgetState(branch.branch_workspace);
  return {
    status: session?.status || branch.status || "UNKNOWN",
    model_calls: Number.isInteger(budget?.model_calls) ? budget.model_calls : (branch.model_calls || 0),
    feedback_summary: state?.feedbackSummary || branch.feedback_summary || null,
    invalid: Boolean(state?.scopeViolation || state?.forbiddenAccessDetected || session?.status === "FAILED_TO_START"),
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
  if (
    control.branches_remaining <= 0 ||
    totalCalls >= FULL_EXPLORATION_LIMITS.max_total_model_calls ||
    Date.now() >= Date.parse(control.deadline_at)
  ) {
    control.budget_exhausted = true;
  }
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
    return { started: false, reason: "FULL_EXPLORATION_ALREADY_ACTIVE", control: refreshControl(repoRoot, existing) };
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
  const baselineAction = deriveValidatedStaticBaseline({ decisionType, facts: seed?.task_descriptor || {}, state })
    || availableActions[0]
    || null;
  if (!baselineAction || availableActions.length === 0) {
    return { ok: false, action: null, source: "STATIC_GOVERNANCE", availableActions, state, baselineAction, diagnostic: "NO_LEGAL_ACTION" };
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

function recordControllerDecision({ repoRoot, seed, control, decisionType, evaluation, branch = null }) {
  control.decision_seq += 1;
  const correlationKey = dreamCorrelationKey({
    conversationId: control.session_id,
    stepIdx: control.decision_seq,
    toolCallId: "full-" + decisionType.toLowerCase(),
    branchOrdinal: branch?.ordinal || control.branches_started,
  });
  const recorded = recordDecision({
    repoRoot,
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
      actor_identity: "FULL_EXPLORATION_CONTROLLER",
      conversation_id: control.session_id,
      step_idx: control.decision_seq,
      tool_call_id: "full-" + decisionType.toLowerCase(),
      branch_ordinal: branch?.ordinal || control.branches_started,
    },
    correlationKey,
  });

  const record = {
    decision_type: decisionType,
    action: evaluation.action,
    source: evaluation.source,
    policy_id: evaluation.policy_id || null,
    baseline_action: evaluation.baseline_action || evaluation.baselineAction || null,
    recorded: recorded.recorded === true,
    decision_id: recorded.decision_id || null,
    observed_at: new Date().toISOString(),
  };
  control.decisions.push(record);
  if (control.decisions.length > 100) control.decisions = control.decisions.slice(-100);

  if (recorded.recorded) {
    recordDecisionOutcome({
      repoRoot,
      correlationKey,
      outcome: {
        result: { applied: true, action: evaluation.action, controller_session_id: control.session_id },
        evidence_summary: {
          tests: "UNKNOWN",
          typecheck: "UNKNOWN",
          build: "UNKNOWN",
          validation_fresh: false,
          scope_check: "UNKNOWN",
        },
        retry_state: {
          attempt: evaluation.state.attempt || 0,
          retry_remaining: evaluation.state.retry_remaining || 0,
        },
        cost_metrics: {
          model_calls: control.total_model_calls || 0,
          branches_started: control.branches_started || 0,
        },
        terminal_state: "ACCEPTED",
      },
    });
  }
  return record;
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
  if (control.branches_started >= FULL_EXPLORATION_LIMITS.max_branches) return { allowed: false, reason: "FULL_EXPLORATION_BRANCH_LIMIT" };
  if (control.total_model_calls >= FULL_EXPLORATION_LIMITS.max_total_model_calls) return { allowed: false, reason: "FULL_EXPLORATION_MODEL_CALL_LIMIT" };
  const allowedActive = parallelismAction === "PARALLEL_2" ? FULL_EXPLORATION_LIMITS.max_parallel : 1;
  if (control.branches_active >= allowedActive) {
    return { allowed: false, reason: parallelismAction === "PARALLEL_2" ? "FULL_EXPLORATION_PARALLEL_LIMIT" : "FULL_EXPLORATION_SERIAL_WAIT" };
  }
  return { allowed: true };
}

export function prepareFullExplorationBranch({
  repoRoot,
  seedPath,
  world,
  decisionId = null,
} = {}) {
  if (!repoRoot || !seedPath || !world) return { prepared: false, reason: "MISSING_PREPARE_INPUT" };
  let control = loadFullExploration(repoRoot);
  if (!control) return { prepared: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  control.repo_root = resolve(repoRoot);
  refreshControl(repoRoot, control);

  const seed = loadSeed(seedPath);
  if (!seed) return { prepared: false, reason: "BRANCH_SEED_INVALID" };

  const stop = evaluateDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.STOPPING });
  recordControllerDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.STOPPING, evaluation: stop });
  if (stop.action === "STOP_EXPLORATION") {
    control.status = "STOPPED";
    persist(repoRoot, control);
    return { prepared: false, reason: "FULL_EXPLORATION_POLICY_STOP", control };
  }

  const branching = evaluateDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.EXPLORATION_BRANCHING });
  recordControllerDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.EXPLORATION_BRANCHING, evaluation: branching });
  if (branching.action !== "OPEN_BRANCH") {
    persist(repoRoot, control);
    return { prepared: false, reason: "FULL_EXPLORATION_POLICY_NO_NEW_BRANCH", control };
  }

  const parallelism = evaluateDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.PARALLELISM });
  recordControllerDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.PARALLELISM, evaluation: parallelism });
  const budget = canStartAnother(control, parallelism.action);
  if (!budget.allowed) {
    persist(repoRoot, control);
    return { prepared: false, reason: budget.reason, parallelism: parallelism.action, control };
  }

  const prepared = prepareExploration({
    repoRoot,
    seedPath: resolve(seedPath),
    world,
    decisionId,
  });
  if (!prepared.prepared) {
    persist(repoRoot, control);
    return { ...prepared, full_exploration: true, control };
  }

  const branch = {
    branch_id: "full-branch-" + randomUUID(),
    ordinal: control.branches.length,
    seed_path: resolve(seedPath),
    source_world_id: world.world_id || null,
    source_decision_id: decisionId || null,
    exploration_session_id: prepared.session?.session_id || null,
    branch_workspace: prepared.branch_workspace,
    selected_action: prepared.selection?.selected || null,
    policy_parallelism: parallelism.action,
    status: "PREPARED",
    model_calls: 0,
    feedback_summary: null,
    feedback_status: "UNKNOWN",
    invalid: false,
    pruned: false,
    created_at: new Date().toISOString(),
  };
  control.branches.push(branch);
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
  const branch = control.branches.find((b) => b.branch_id === branchId);
  if (!branch) return { ran: false, reason: "FULL_EXPLORATION_BRANCH_NOT_FOUND" };
  if (branch.pruned) return { ran: false, reason: "FULL_EXPLORATION_BRANCH_PRUNED" };
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
  };
  persist(repoRoot, control);
  return { ...out, branch, control };
}

export function collectFullExplorationBranch({ repoRoot, branchId } = {}) {
  const control = loadFullExploration(repoRoot);
  if (!control) return { collected: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  refreshControl(repoRoot, control);
  const branch = control.branches.find((b) => b.branch_id === branchId);
  if (!branch) return { collected: false, reason: "FULL_EXPLORATION_BRANCH_NOT_FOUND" };
  const seed = loadSeed(branch.seed_path);
  if (!seed) return { collected: false, reason: "BRANCH_SEED_INVALID" };

  const collected = collectExplorationResult({
    primaryRepoRoot: repoRoot,
    branchWorkspace: branch.branch_workspace,
  });
  branch.collection = collected;
  branch.status = collected.collected ? "COLLECTED" : branch.status;
  refreshControl(repoRoot, control);

  const prune = evaluateDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.PRUNE_BRANCH, branch });
  recordControllerDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.PRUNE_BRANCH, evaluation: prune, branch });
  if (prune.action === "PRUNE_BRANCH") {
    branch.pruned = true;
    branch.status = "PRUNED";
    branch.pruned_at = new Date().toISOString();
  }

  const stop = evaluateDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.STOPPING, branch });
  recordControllerDecision({ repoRoot, seed, control, decisionType: DECISION_TYPES.STOPPING, evaluation: stop, branch });
  if (stop.action === "STOP_EXPLORATION") {
    control.status = "STOPPED";
    control.stopped_at = new Date().toISOString();
  }
  persist(repoRoot, control);
  return { ...collected, branch, prune_action: prune.action, stopping_action: stop.action, control };
}

export function stopFullExploration({ repoRoot, reason = "HUMAN_STOP" } = {}) {
  const control = loadFullExploration(repoRoot);
  if (!control) return { stopped: false, reason: "FULL_EXPLORATION_NOT_STARTED" };
  control.status = "STOPPED";
  control.stop_reason = String(reason || "HUMAN_STOP");
  control.stopped_at = new Date().toISOString();
  persist(repoRoot, control);
  return { stopped: true, control };
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
    branches: control.branches.map((b) => ({
      branch_id: b.branch_id,
      status: b.status,
      model_calls: b.model_calls,
      selected_action: b.selected_action,
      feedback_status: b.feedback_status,
      pruned: b.pruned === true,
    })),
  };
}
