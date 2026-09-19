import { createHash } from "node:crypto";

export const CODEX_DREAM_SCHEMA = "orchestra.codex-dream.v1";
export const CODEX_DREAM_AUTHORITY = "NONE";
export const CODEX_DREAM_LIMITS = Object.freeze({
  max_branches: 3,
  max_parallel: 1,
  max_total_model_calls: 6,
  timeout_ms: 15 * 60 * 1000,
});

export const CODEX_DREAM_DECISION_CLASSES = Object.freeze([
  "CONTEXT_SELECTION",
  "EXPLORATION_BRANCHING",
  "VALIDATION_DEPTH",
  "REVIEW_TRIGGER",
]);

const FORBIDDEN_POLICY_FIELDS = new Set([
  "model", "provider", "executor", "apiKey", "api_key", "credentials",
  "transcript", "messages", "prompt", "reasoning", "thinking",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function scanForbidden(value, path = "candidate", findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, path + "[" + index + "]", findings));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_POLICY_FIELDS.has(key)) findings.push(path + "." + key);
    scanForbidden(child, path + "." + key, findings);
  }
  return findings;
}

export function createCodexDreamWorld({
  activeState = {},
  scopeContract = {},
  evidenceRefs = [],
  decisionContext = {},
} = {}) {
  const body = {
    schema: CODEX_DREAM_SCHEMA,
    kind: "SEALED_WORLD",
    authority: CODEX_DREAM_AUTHORITY,
    task: {
      task_id: activeState.taskId || activeState.taskKey || null,
      action: activeState.taskAction || scopeContract.taskAction || null,
      domain: activeState.taskDomain || scopeContract.taskDomain || null,
      criticality: activeState.criticality || scopeContract.criticality || "NORMAL",
      state: activeState.state || null,
      attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
      mutation_seq: activeState.mutationSeq ?? activeState.mutation_seq ?? 0,
    },
    scope: {
      allowed_paths: Array.isArray(scopeContract.allowedPaths) ? [...scopeContract.allowedPaths].sort() : [],
      forbidden_paths: Array.isArray(scopeContract.forbiddenPaths) ? [...scopeContract.forbiddenPaths].sort() : [],
      tests_required: Array.isArray(scopeContract.testsRequired) ? [...scopeContract.testsRequired] : [],
      required_evidence: Array.isArray(scopeContract.requiredEvidence) ? stable(scopeContract.requiredEvidence) : [],
    },
    evidence_refs: evidenceRefs.map((ref) => ({
      id: ref.id || ref.evidenceId || null,
      kind: ref.kind || ref.type || null,
      result: ref.result || ref.status || null,
      mutation_seq: ref.mutationSeq ?? ref.mutation_seq ?? ref.binding?.mutationSeq ?? null,
    })).filter((ref) => ref.id),
    decision_context: stable(decisionContext),
  };
  const world_hash = hash(body);
  return Object.freeze({ ...body, world_id: "codex-world-" + world_hash.slice(0, 24), world_hash });
}

export function validateCodexPolicyCandidate(candidate = {}) {
  const decisionClass = String(candidate.decision_class || candidate.decisionClass || "").toUpperCase();
  const violations = scanForbidden(candidate);
  if (!CODEX_DREAM_DECISION_CLASSES.includes(decisionClass)) violations.push("UNSUPPORTED_DECISION_CLASS");
  if (!candidate.policy_key && !candidate.key) violations.push("POLICY_KEY_REQUIRED");
  return { valid: violations.length === 0, decision_class: decisionClass, violations };
}

export function createCodexPolicyCandidate(input = {}) {
  const validation = validateCodexPolicyCandidate(input);
  if (!validation.valid) {
    const error = new Error("CODEX_DREAM_POLICY_INVALID:" + validation.violations.join(","));
    error.violations = validation.violations;
    throw error;
  }
  const body = {
    schema: CODEX_DREAM_SCHEMA,
    kind: "POLICY_CANDIDATE",
    authority: CODEX_DREAM_AUTHORITY,
    policy_key: String(input.policy_key || input.key),
    decision_class: validation.decision_class,
    parameters: stable(input.parameters || {}),
    hypothesis: typeof input.hypothesis === "string" ? input.hypothesis.slice(0, 1000) : null,
    falsifier: typeof input.falsifier === "string" ? input.falsifier.slice(0, 1000) : null,
  };
  return Object.freeze({
    ...body,
    candidate_id: "codex-policy-" + hash(body).slice(0, 24),
  });
}

export function createCodexExplorationBudget(overrides = {}) {
  const requestedBranches = Number(overrides.max_branches ?? CODEX_DREAM_LIMITS.max_branches);
  const requestedCalls = Number(overrides.max_total_model_calls ?? CODEX_DREAM_LIMITS.max_total_model_calls);
  return {
    schema: CODEX_DREAM_SCHEMA,
    max_branches: Math.min(CODEX_DREAM_LIMITS.max_branches, Math.max(0, requestedBranches)),
    max_parallel: 1,
    max_total_model_calls: Math.min(CODEX_DREAM_LIMITS.max_total_model_calls, Math.max(0, requestedCalls)),
    timeout_ms: Math.min(CODEX_DREAM_LIMITS.timeout_ms, Math.max(1000, Number(overrides.timeout_ms ?? CODEX_DREAM_LIMITS.timeout_ms))),
    branches_used: 0,
    model_calls_used: 0,
  };
}

export function consumeCodexExplorationBudget(budget, { branches = 1, modelCalls = 1 } = {}) {
  const current = { ...budget };
  const nextBranches = Number(current.branches_used || 0) + Number(branches || 0);
  const nextCalls = Number(current.model_calls_used || 0) + Number(modelCalls || 0);
  if (nextBranches > current.max_branches) return { allowed: false, reason: "BRANCH_BUDGET_EXHAUSTED", budget: current };
  if (nextCalls > current.max_total_model_calls) return { allowed: false, reason: "MODEL_CALL_BUDGET_EXHAUSTED", budget: current };
  return {
    allowed: true,
    reason: null,
    budget: { ...current, branches_used: nextBranches, model_calls_used: nextCalls },
  };
}

export function replayCodexPolicyCandidate({ world, candidate, evaluation = {} } = {}) {
  if (!world || world.kind !== "SEALED_WORLD") throw new Error("CODEX_DREAM_WORLD_REQUIRED");
  const valid = validateCodexPolicyCandidate(candidate);
  if (!valid.valid) throw new Error("CODEX_DREAM_POLICY_INVALID");
  if (world.authority !== CODEX_DREAM_AUTHORITY || candidate.authority !== CODEX_DREAM_AUTHORITY) {
    throw new Error("CODEX_DREAM_AUTHORITY_VIOLATION");
  }
  const body = {
    schema: CODEX_DREAM_SCHEMA,
    kind: "REPLAY_RESULT",
    authority: CODEX_DREAM_AUTHORITY,
    world_id: world.world_id,
    world_hash: world.world_hash,
    candidate_id: candidate.candidate_id,
    metrics: stable(evaluation.metrics || {}),
    accepted_behavior_preserved: evaluation.accepted_behavior_preserved === true,
    side_effects: 0,
    source_mutations: 0,
  };
  return { ...body, replay_id: "codex-replay-" + hash(body).slice(0, 24) };
}

export function createCodexShadowDecision({ replay, baseline = {} } = {}) {
  if (!replay || replay.kind !== "REPLAY_RESULT") throw new Error("CODEX_DREAM_REPLAY_REQUIRED");
  const body = {
    schema: CODEX_DREAM_SCHEMA,
    kind: "SHADOW_DECISION",
    authority: CODEX_DREAM_AUTHORITY,
    replay_id: replay.replay_id,
    baseline: stable(baseline),
    candidate_metrics: stable(replay.metrics || {}),
    runtime_effect: "NONE",
    source_rewrite: false,
    automatic_activation: false,
  };
  return { ...body, shadow_id: "codex-shadow-" + hash(body).slice(0, 24) };
}

export function createCodexCanaryApproval({
  shadow,
  approved = false,
  approvedBy = null,
  scope = "MANUAL_CANARY_ONLY",
} = {}) {
  if (!shadow || shadow.kind !== "SHADOW_DECISION") throw new Error("CODEX_DREAM_SHADOW_REQUIRED");
  if (approved !== true || !String(approvedBy || "").trim()) {
    return {
      approved: false,
      authority: "HUMAN_GATE",
      reason: "EXPLICIT_HUMAN_APPROVAL_REQUIRED",
      automatic_activation: false,
      source_rewrite: false,
    };
  }
  const body = {
    schema: CODEX_DREAM_SCHEMA,
    kind: "CANARY_APPROVAL",
    authority: "HUMAN_GATE",
    shadow_id: shadow.shadow_id,
    approved_by: String(approvedBy),
    scope,
    automatic_activation: false,
    source_rewrite: false,
  };
  return { ...body, approval_id: "codex-canary-" + hash(body).slice(0, 24), approved: true };
}

export function canUseCodexCanary(approval = {}) {
  return Boolean(
    approval
    && approval.kind === "CANARY_APPROVAL"
    && approval.authority === "HUMAN_GATE"
    && approval.approved === true
    && approval.automatic_activation === false
    && approval.source_rewrite === false
  );
}
