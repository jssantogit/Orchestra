import {
  normalizeComplexity,
  normalizeTaskDomain,
  canonicalTaskDomain,
  normalizeCriticality,
  normalizeTaskAction,
  classifyDirectActionIntent,
  createRetryBudget,
  GEMINI_MODELS,
  RETRY_REASONS,
} from "../skills/orchestra/routing-policy.mjs";

export const DECISION_TYPES = Object.freeze({
  WORKER_TIER: "WORKER_TIER",
  INVESTIGATION_STRATEGY: "INVESTIGATION_STRATEGY",
  RETRY_ACTION: "RETRY_ACTION",
});

export const WORKER_TIER_ACTIONS = Object.freeze([
  "FLASH_LOW",
  "FLASH_MEDIUM",
  "FLASH_HIGH",
]);

export const INVESTIGATION_STRATEGY_ACTIONS = Object.freeze([
  "IMPLEMENT_DIRECT",
  "INVESTIGATE_FIRST",
]);

export const RETRY_ACTIONS = Object.freeze([
  "RETRY_SAME",
  "ESCALATE_WORKER",
  "INVESTIGATE_FIRST",
  "REPLAN",
]);

/**
 * Derives the governance-constrained legal action space for a given decision type and state.
 *
 * @param {string} decisionType
 * @param {Record<string, unknown>} [state]
 * @returns {string[]}
 */
export function deriveAvailableActions(decisionType, state = {}) {
  const normState = state && typeof state === "object" ? state : {};
  const criticality = typeof normState.criticality === "string" ? normState.criticality.trim().toUpperCase() : "";
  const taskAction = typeof normState.task_action === "string" ? normState.task_action.trim().toUpperCase() : "";
  const taskDomain = typeof normState.task_domain === "string" ? normState.task_domain.trim().toUpperCase() : "";
  const complexity = typeof normState.complexity === "string" ? normState.complexity.trim().toUpperCase() : "";
  const postInvestigation = Boolean(normState.post_investigation);

  if (decisionType === DECISION_TYPES.WORKER_TIER) {
    // If state.criticality === "CRITICAL" -> [] (fixed governance route outside Dream)
    if (criticality === "CRITICAL") return [];

    // If state.task_action === "DIRECT_ACTION" -> [] (outside Dream)
    if (taskAction === "DIRECT_ACTION") return [];

    // If state.task_action === "TEST" -> ["FLASH_LOW", "FLASH_MEDIUM"]
    if (taskAction === "TEST") {
      return ["FLASH_LOW", "FLASH_MEDIUM"];
    }

    // If state.complexity === "DIFFICULT" or "EXPERIMENTAL" or "INTEGRATION" or post_investigation === true -> ["FLASH_HIGH"]
    if (
      complexity === "DIFFICULT" ||
      complexity === "EXPERIMENTAL" ||
      complexity === "INTEGRATION" ||
      postInvestigation
    ) {
      return ["FLASH_HIGH"];
    }

    // If state.complexity === "MECHANICAL" or "SIMPLE" or state.task_domain === "DOCS" -> ["FLASH_LOW", "FLASH_MEDIUM"]
    if (
      complexity === "MECHANICAL" ||
      complexity === "SIMPLE" ||
      taskDomain === "DOCS"
    ) {
      return ["FLASH_LOW", "FLASH_MEDIUM"];
    }

    // If state.complexity === "NORMAL" -> ["FLASH_MEDIUM", "FLASH_HIGH"]
    if (complexity === "NORMAL") {
      return ["FLASH_MEDIUM", "FLASH_HIGH"];
    }

    // Default fallback -> ["FLASH_MEDIUM", "FLASH_HIGH"]
    return ["FLASH_MEDIUM", "FLASH_HIGH"];
  }

  if (decisionType === DECISION_TYPES.INVESTIGATION_STRATEGY) {
    // Eligible only when:
    // - mutation_seq === 0 (or mutation_seq === undefined or null)
    // - criticality !== "CRITICAL"
    // - task_action === "IMPLEMENT"
    // - not direct action / mechanical-only / critical-review / already INVESTIGATE / post_investigation
    const mutationSeq = normState.mutation_seq;
    const isMutationClean = mutationSeq === 0 || mutationSeq === undefined || mutationSeq === null;
    const isNotCritical = criticality !== "CRITICAL";
    const isImplement = taskAction === "IMPLEMENT";
    const isNotMechanical = complexity !== "MECHANICAL" && taskAction !== "MECHANICAL_FIX";
    const isNotInvestigate = taskAction !== "INVESTIGATE";
    const isNotDirect = taskAction !== "DIRECT_ACTION";
    const isNotPostInvest = !postInvestigation;

    if (
      isMutationClean &&
      isNotCritical &&
      isImplement &&
      isNotMechanical &&
      isNotInvestigate &&
      isNotDirect &&
      isNotPostInvest
    ) {
      return ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"];
    }
    return [];
  }

  if (decisionType === DECISION_TYPES.RETRY_ACTION) {
    const rawReason = normState.retry_reason ?? normState.retryReason ?? "";
    const retryReason = typeof rawReason === "string" ? rawReason.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";

    switch (retryReason) {
      case "FAILED_TEST":
        return ["RETRY_SAME", "ESCALATE_WORKER", "INVESTIGATE_FIRST"];
      case "INCOMPLETE_IMPLEMENTATION":
        return ["RETRY_SAME", "ESCALATE_WORKER"];
      case "MISSING_CONTEXT":
        return ["INVESTIGATE_FIRST", "REPLAN"];
      case "MISINTERPRETED_REQUIREMENT":
        return ["REPLAN"];
      case "SCOPE_GAP":
        return ["REPLAN"];
      case "INTEGRATION_FAILURE":
        return ["ESCALATE_WORKER", "REPLAN"];
      default:
        return [];
    }
  }

  return [];
}

function normalizeComplexityToken(val) {
  const token = String(val).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["MECHANICAL", "MECHANICAL_FIX", "FIX_MECHANICAL"].includes(token)) return "MECHANICAL";
  if (["INTEGRATION", "INTEGRATE"].includes(token)) return "INTEGRATION";
  if (["SIMPLE", "TRIVIAL", "SMALL", "LOW"].includes(token)) return "SIMPLE";
  if (["EXPERIMENTAL", "RESEARCH", "INVESTIGATIVE", "EXPERIMENT"].includes(token)) return "EXPERIMENTAL";
  if (["DIFFICULT", "HARD", "COMPLEX", "LARGE", "MAX", "VERY_HARD"].includes(token)) return "DIFFICULT";
  if (["NORMAL", "STANDARD", "MEDIUM"].includes(token)) return "NORMAL";
  return "NORMAL";
}

function deriveComplexityToken(facts = {}, activeState = {}) {
  if (activeState && typeof activeState.complexity === "string" && activeState.complexity.trim()) {
    return normalizeComplexityToken(activeState.complexity);
  }
  if (facts && typeof facts.complexity === "string" && facts.complexity.trim()) {
    return normalizeComplexityToken(facts.complexity);
  }
  if (facts && typeof facts.difficulty === "string" && facts.difficulty.trim()) {
    return normalizeComplexityToken(facts.difficulty);
  }
  if (facts && typeof facts.implementationComplexity === "string" && facts.implementationComplexity.trim()) {
    return normalizeComplexityToken(facts.implementationComplexity);
  }
  if (facts && typeof facts.implementationDifficulty === "string" && facts.implementationDifficulty.trim()) {
    return normalizeComplexityToken(facts.implementationDifficulty);
  }

  const rawAction = typeof facts?.taskAction === "string" ? facts.taskAction.trim().toUpperCase() : "";
  const rawClass = typeof facts?.taskClass === "string" ? facts.taskClass.trim().toUpperCase() : "";
  const rawOp = typeof facts?.operation === "string" ? facts.operation.trim().toUpperCase() : "";

  if (rawAction === "MECHANICAL_FIX" || rawClass === "MECHANICAL_CHANGE") {
    return "MECHANICAL";
  }
  if (facts?.integration === true || rawOp === "INTEGRATE" || rawAction === "INTEGRATE") {
    return "INTEGRATION";
  }
  if (rawClass === "TRIVIAL_CHANGE" || rawClass === "DOCUMENTATION") {
    return "SIMPLE";
  }
  if (rawClass === "HARD_SPECIFIED_IMPLEMENTATION") {
    return "DIFFICULT";
  }
  if (facts?.experimental === true || facts?.investigative === true) {
    return "EXPERIMENTAL";
  }
  if (normalizeTaskDomain(facts) === "DOCS") {
    return "SIMPLE";
  }
  return "NORMAL";
}

function deriveTaskAction(facts = {}, activeState = {}) {
  if (activeState && typeof activeState.task_action === "string" && activeState.task_action.trim()) {
    return activeState.task_action.trim().toUpperCase().replace(/[\s-]+/g, "_");
  }
  if (facts?.taskAction === "DIRECT_ACTION" || facts?.directAction === true || facts?.isDirectAction === true) {
    return "DIRECT_ACTION";
  }
  const userText = facts?.intent ?? facts?.prompt ?? facts?.userIntent ?? facts?.request;
  if (userText && typeof userText === "string" && !facts?.taskAction && !facts?.action && !facts?.taskClass) {
    const directIntent = classifyDirectActionIntent(userText);
    if (directIntent.isDirectAction) {
      return "DIRECT_ACTION";
    }
  }
  return normalizeTaskAction(facts);
}

/**
 * Builds structured, compact policy-visible state.
 * Raw prompts, source code, stack traces, and chat history are strictly excluded.
 *
 * @param {Record<string, unknown>} [facts]
 * @param {Record<string, unknown>} [activeState]
 * @param {Record<string, unknown>} [evidenceSummary]
 * @returns {Record<string, unknown>}
 */
export function deriveDecisionState(facts = {}, activeState = {}, evidenceSummary = {}) {
  const safeFacts = facts && typeof facts === "object" ? facts : {};
  const safeActiveState = activeState && typeof activeState === "object" ? activeState : {};

  const taskAction = deriveTaskAction(safeFacts, safeActiveState);
  const taskDomain = safeActiveState.task_domain
    ? canonicalTaskDomain(safeActiveState.task_domain)
    : normalizeTaskDomain(safeFacts);
  const criticality = safeActiveState.criticality
    ? normalizeCriticality(safeActiveState.criticality)
    : normalizeCriticality(safeFacts);
  const complexity = deriveComplexityToken(safeFacts, safeActiveState);

  const rawState = safeActiveState.state ?? safeFacts.state ?? "INTAKE";
  const stateName = typeof rawState === "string" && rawState.trim()
    ? rawState.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "INTAKE";

  let attempt = 0;
  if (Number.isInteger(safeActiveState.attempt)) {
    attempt = safeActiveState.attempt;
  } else if (Number.isInteger(safeFacts.attempt)) {
    attempt = safeFacts.attempt;
  }

  let retryRemaining = 0;
  if (Number.isInteger(safeActiveState.retry_remaining)) {
    retryRemaining = safeActiveState.retry_remaining;
  } else if (Number.isInteger(safeActiveState.remainingAttempts)) {
    retryRemaining = safeActiveState.remainingAttempts;
  } else if (Number.isInteger(safeFacts.remainingAttempts)) {
    retryRemaining = safeFacts.remainingAttempts;
  } else if (Number.isInteger(safeFacts.retry_remaining)) {
    retryRemaining = safeFacts.retry_remaining;
  } else {
    retryRemaining = createRetryBudget(safeFacts).remainingAttempts;
  }

  let retryReason = null;
  const rawReason = safeActiveState.retry_reason ?? safeActiveState.retryReason ?? safeFacts.retry_reason ?? safeFacts.retryReason;
  if (typeof rawReason === "string" && rawReason.trim()) {
    retryReason = rawReason.trim().toUpperCase().replace(/[\s-]+/g, "_");
  }

  let mutationSeq = 0;
  if (Number.isInteger(safeActiveState.mutation_seq)) {
    mutationSeq = safeActiveState.mutation_seq;
  } else if (Number.isInteger(safeActiveState.mutationSeq)) {
    mutationSeq = safeActiveState.mutationSeq;
  } else if (Number.isInteger(safeFacts.mutation_seq)) {
    mutationSeq = safeFacts.mutation_seq;
  } else if (Number.isInteger(safeFacts.mutationSeq)) {
    mutationSeq = safeFacts.mutationSeq;
  }

  const postInvestigation = Boolean(
    safeActiveState.post_investigation ??
    safeActiveState.postInvestigation ??
    safeFacts.post_investigation ??
    safeFacts.postInvestigation ??
    false,
  );

  const rawEv = evidenceSummary && typeof evidenceSummary === "object" && Object.keys(evidenceSummary).length > 0
    ? evidenceSummary
    : (safeActiveState.evidence ?? safeActiveState.evidenceSummary ?? safeFacts.evidenceSummary ?? safeFacts.evidence ?? {});

  function normStatus(val, allowed) {
    if (typeof val !== "string") return "UNKNOWN";
    const upper = val.trim().toUpperCase();
    return allowed.includes(upper) ? upper : "UNKNOWN";
  }

  const tests = normStatus(rawEv.tests, ["PASS", "FAIL", "UNKNOWN"]);
  const typecheck = normStatus(rawEv.typecheck, ["PASS", "FAIL", "UNKNOWN", "NOT_REQUIRED"]);
  const build = normStatus(rawEv.build, ["PASS", "FAIL", "UNKNOWN", "NOT_REQUIRED"]);
  const scopeCheck = normStatus(rawEv.scope_check ?? rawEv.scopeCheck, ["PASS", "FAIL", "UNKNOWN"]);
  const validationFresh = Boolean(rawEv.validation_fresh ?? rawEv.validationFresh ?? false);

  const evidence = Object.freeze({
    tests,
    typecheck,
    build,
    scope_check: scopeCheck,
    validation_fresh: validationFresh,
  });

  return Object.freeze({
    task_action: taskAction,
    task_domain: taskDomain,
    criticality,
    complexity,
    state: stateName,
    attempt,
    retry_remaining: retryRemaining,
    retry_reason: retryReason,
    mutation_seq: mutationSeq,
    post_investigation: postInvestigation,
    evidence,
  });
}

/**
 * Maps existing decideRoute outcome to Phase-1 decision:
 * - Returns null for Direct Action, CRITICAL review, or two-key reviewer pair.
 * - Maps worker delegations to WORKER_TIER ("FLASH_LOW" | "FLASH_MEDIUM" | "FLASH_HIGH").
 * - Maps active retries to RETRY_ACTION ("RETRY_SAME" | "ESCALATE_WORKER" | ...).
 *
 * @param {Record<string, unknown>} [facts]
 * @param {Record<string, unknown> | null} [route]
 * @returns {{ decisionType: string, chosenAction: string } | null}
 */
export function classifyBaselineDecision(facts = {}, route = null) {
  if (!route || typeof route !== "object") return null;

  // 1. Direct Action -> returns null
  if (
    route.kind === "direct_action" ||
    route.action === "DIRECT_ACTION" ||
    route.directActionType !== undefined ||
    facts.taskAction === "DIRECT_ACTION" ||
    facts.isDirectAction === true ||
    facts.directAction === true
  ) {
    return null;
  }

  // 2. CRITICAL review or two-key reviewer pair -> returns null
  if (
    route.kind === "two-key-review" ||
    route.reason === "critical-two-key-review" ||
    (route.modelReviewerA && route.modelReviewerB) ||
    route.twoKeyReview === true ||
    route.criticality === "CRITICAL" ||
    normalizeCriticality(facts) === "CRITICAL"
  ) {
    return null;
  }

  // 3. Retry active
  const isRetryActive = Boolean(
    facts.retry === true ||
    route.retry === true ||
    facts.retryReason ||
    facts.retry_reason ||
    route.retryReason ||
    (Number.isInteger(facts.attempt) && facts.attempt > 0) ||
    (Number.isInteger(route.attempt) && route.attempt > 0)
  );

  if (isRetryActive) {
    // If budget exhausted or halts to human gate -> null
    if (
      route.reason === "retry-budget-exhausted" ||
      route.attemptsExhausted === true ||
      route.state === "HUMAN_GATE" ||
      route.humanGate === true
    ) {
      return null;
    }

    const explicitAction = route.retryAction ?? facts.retryAction ?? facts.retry_action;
    if (explicitAction && typeof explicitAction === "string") {
      const token = explicitAction.trim().toUpperCase().replace(/[\s-]+/g, "_");
      if (["RETRY_SAME", "ESCALATE_WORKER", "INVESTIGATE_FIRST", "REPLAN"].includes(token)) {
        return { decisionType: DECISION_TYPES.RETRY_ACTION, chosenAction: token };
      }
    }

    if (route.action === "INVESTIGATE" || (route.kind === "orchestration" && route.executor === "flash-specialist")) {
      return { decisionType: DECISION_TYPES.RETRY_ACTION, chosenAction: "INVESTIGATE_FIRST" };
    }

    if (route.action === "REPLAN" || route.reason?.includes("replan")) {
      return { decisionType: DECISION_TYPES.RETRY_ACTION, chosenAction: "REPLAN" };
    }

    if (route.kind === "worker" || route.action === "bounded-fix-retry") {
      if (facts.escalate === true || facts.escalateWorker === true || route.escalate === true) {
        return { decisionType: DECISION_TYPES.RETRY_ACTION, chosenAction: "ESCALATE_WORKER" };
      }
      return { decisionType: DECISION_TYPES.RETRY_ACTION, chosenAction: "RETRY_SAME" };
    }

    return null;
  }

  // 4. Worker delegation
  if (route.kind === "worker") {
    const profile = route.profile ?? route.agent ?? route.executorProfile ?? "";
    const tier = route.tier ?? "";
    const model = route.model ?? "";
    const effort = route.effort ?? "";

    if (
      profile === "flash-low-worker" ||
      tier === "WORKER_LOW" ||
      tier === "flash_lite" ||
      effort === "low" ||
      model === GEMINI_MODELS.WORKER_LOW
    ) {
      return { decisionType: DECISION_TYPES.WORKER_TIER, chosenAction: "FLASH_LOW" };
    }

    if (
      profile === "flash-medium-worker" ||
      tier === "WORKER_MEDIUM" ||
      (tier === "flash" && effort === "medium") ||
      effort === "medium" ||
      model === GEMINI_MODELS.WORKER_MEDIUM
    ) {
      return { decisionType: DECISION_TYPES.WORKER_TIER, chosenAction: "FLASH_MEDIUM" };
    }

    if (
      profile === "flash-worker" ||
      tier === "WORKER_HIGH" ||
      tier === "pro" ||
      effort === "high" ||
      model === GEMINI_MODELS.WORKER_HIGH
    ) {
      return { decisionType: DECISION_TYPES.WORKER_TIER, chosenAction: "FLASH_HIGH" };
    }
  }

  return null;
}
