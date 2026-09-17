import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * ALL-GEMINI Deterministic Routing Policy & State Machine Governance
 * AutoEQ Workbench — Antigravity CLI Local Workflow
 *
 * Models:
 * - Gemini 3.8 Flash Medium: Global Orchestrator & Standard Implementation
 * - Gemini 3.8 Flash Low: Documentation, mechanical fixes, trivial tasks
 * - Gemini 3.8 Flash High: Difficult implementation, investigation, Two-Key review
 *
 * Strictly NO Claude, Sonnet, Opus, GPT, or Gemini 3.1 Pro fallback.
 */

export const GEMINI_MODELS = Object.freeze({
  ORCHESTRATOR: "gemini-3.8-flash-medium",
  WORKER_HIGH: "gemini-3.8-flash-high",
  WORKER_MEDIUM: "gemini-3.8-flash-medium",
  WORKER_LOW: "gemini-3.8-flash-low",
  INVESTIGATOR: "gemini-3.8-flash-high",
  REVIEWER_A: "gemini-3.8-flash-high",
  REVIEWER_B: "gemini-3.8-flash-high",
});

export const ANTIGRAVITY_MODELS = Object.freeze({
  ORCHESTRATOR: "gemini-3.8-flash-medium",
  WORKER_HIGH: "gemini-3.8-flash-high",
  WORKER_MEDIUM: "gemini-3.8-flash-medium",
  WORKER_LOW: "gemini-3.8-flash-low",
  CRITICAL_REVIEWER: "gemini-3.8-flash-high",
  SUBAGENT_TIER: "flash",
});

export const FORBIDDEN_MODELS = Object.freeze([
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-6-astra",
  "gpt-oss-120b-medium",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
]);

export const STATE_NAMES = Object.freeze([
  "INTAKE",
  "CLASSIFIED",
  "DIRECT_ACTION",
  "PLANNED",
  "DELEGATED",
  "EXECUTING",
  "EVIDENCE_READY",
  "ACCEPTANCE",
  "INTEGRATING",
  "DONE",
  "BLOCKED",
  "HUMAN_GATE",
]);

export const VALID_TRANSITIONS = Object.freeze({
  INTAKE: ["CLASSIFIED", "DIRECT_ACTION", "BLOCKED", "HUMAN_GATE"],
  CLASSIFIED: ["PLANNED", "DIRECT_ACTION", "BLOCKED", "HUMAN_GATE"],
  DIRECT_ACTION: ["EXECUTING", "DONE", "BLOCKED", "HUMAN_GATE"],
  PLANNED: ["DELEGATED", "CLASSIFIED", "BLOCKED", "HUMAN_GATE"],
  DELEGATED: ["EXECUTING", "PLANNED", "BLOCKED", "HUMAN_GATE"],
  EXECUTING: [
    "EVIDENCE_READY",
    "EXECUTING",
    "DELEGATED",
    "PLANNED",
    "CLASSIFIED",
    "BLOCKED",
    "HUMAN_GATE",
  ],
  EVIDENCE_READY: ["ACCEPTANCE", "EXECUTING", "BLOCKED", "HUMAN_GATE"],
  ACCEPTANCE: [
    "DONE",
    "PLANNED",
    "DELEGATED",
    "CLASSIFIED",
    "INTEGRATING",
    "CRITICAL_REVIEW",
    "BLOCKED",
    "HUMAN_GATE",
  ],
  INTEGRATING: ["EVIDENCE_READY", "ACCEPTANCE", "BLOCKED", "HUMAN_GATE"],
  CRITICAL_REVIEW: ["DONE", "PLANNED", "DELEGATED", "BLOCKED", "HUMAN_GATE"],
  DONE: [],
  BLOCKED: ["INTAKE", "CLASSIFIED", "PLANNED", "DIRECT_ACTION", "HUMAN_GATE"],
  HUMAN_GATE: ["INTAKE", "CLASSIFIED", "PLANNED", "DELEGATED", "DIRECT_ACTION", "DONE"],
});

export const PROGRESSIVE_TEST_STAGES = Object.freeze({
  STAGE_1_AFFECTED: "STAGE_1_AFFECTED",
  STAGE_2_DOMAIN_PACKAGE: "STAGE_2_DOMAIN_PACKAGE",
  STAGE_3_INTEGRATION: "STAGE_3_INTEGRATION",
  STAGE_4_FULL_SUITE: "STAGE_4_FULL_SUITE",
});

export const RETRY_REASONS = Object.freeze([
  "MISINTERPRETED_REQUIREMENT",
  "INCOMPLETE_IMPLEMENTATION",
  "FAILED_TEST",
  "SCOPE_GAP",
  "MISSING_CONTEXT",
  "INTEGRATION_FAILURE",
]);

export const CORE_TASK_DOMAINS = Object.freeze([
  "CODE",
  "UI",
  "DATA",
  "INFRA",
  "TESTING",
  "DOCS",
  "RESEARCH",
  "ORCHESTRA",
  "GENERAL",
]);

const customDomainsSet = new Set();
export function registerCustomDomains(domains = []) {
  for (const d of domains) {
    if (typeof d === "string" && d.trim()) {
      customDomainsSet.add(d.trim().toUpperCase().replace(/[\s-]+/g, "_"));
    }
  }
}

export const TASK_DOMAINS = Object.freeze([
  "CODE",
  "AUTOEQ_ALGORITHM",
  "DSP_CORE",
  "UI",
  "DATA",
  "INFRA",
  "TESTING",
  "DOCS",
  "RESEARCH",
  "ORCHESTRA",
  "GENERAL",
]);

const TASK_DOMAIN_SET = new Set(TASK_DOMAINS);
export const CRITICALITIES = Object.freeze(["NORMAL", "MAJOR", "CRITICAL"]);
const CRITICALITY_SET = new Set(CRITICALITIES);
export const CROSS_DOMAIN_REQUEST = "CROSS_DOMAIN_REQUEST";

export const ACTIONS = Object.freeze([
  "ORCHESTRATE",
  "INVESTIGATE",
  "IMPLEMENT",
  "TEST",
  "REVIEW",
  "MECHANICAL_FIX",
  "INTEGRATE",
  "ESCALATE",
  "HEAVY_EXECUTION",
  "DIRECT_ACTION",
]);
const ACTION_SET = new Set(ACTIONS);

const ACTION_ALIASES = Object.freeze({
  ORCHESTRATE: "ORCHESTRATE",
  ORCHESTRATION: "ORCHESTRATE",
  CLASSIFY: "ORCHESTRATE",
  INVESTIGATE: "INVESTIGATE",
  INVESTIGATION: "INVESTIGATE",
  IMPLEMENT: "IMPLEMENT",
  IMPLEMENTATION: "IMPLEMENT",
  INTEGRATE: "IMPLEMENT",
  INTEGRATION: "IMPLEMENT",
  DOCUMENTATION: "IMPLEMENT",
  TEST: "TEST",
  TESTING: "TEST",
  REVIEW: "REVIEW",
  MECHANICAL: "MECHANICAL_FIX",
  MECHANICAL_FIX: "MECHANICAL_FIX",
  FIX_MECHANICAL: "MECHANICAL_FIX",
  ESCALATE: "ESCALATE",
  ESCALATION: "ESCALATE",
  HEAVY_EXECUTION: "HEAVY_EXECUTION",
  HEAVY: "HEAVY_EXECUTION",
  CAMPAIGN: "HEAVY_EXECUTION",
  BENCHMARK_RUN: "HEAVY_EXECUTION",
  DIRECT_ACTION: "DIRECT_ACTION",
  DIRECT: "DIRECT_ACTION",
  FAST_PATH: "DIRECT_ACTION",
});

export const DIRECT_ACTION_TYPES = Object.freeze([
  "GIT_STATUS",
  "GIT_DIFF",
  "GIT_COMMIT",
  "GIT_PUSH",
  "GIT_COMMIT_PUSH",
  "RUN_TEST",
  "RUN_TYPECHECK",
  "RUN_BUILD",
  "RUN_PROJECT_SCRIPT",
]);

export const DIRECT_ACTION_TYPE_SET = new Set(DIRECT_ACTION_TYPES);

export const DIRECT_ACTION_ALIASES = Object.freeze({
  STATUS: "GIT_STATUS",
  GIT_STATUS: "GIT_STATUS",
  DIFF: "GIT_DIFF",
  GIT_DIFF: "GIT_DIFF",
  COMMIT: "GIT_COMMIT",
  GIT_COMMIT: "GIT_COMMIT",
  PUSH: "GIT_PUSH",
  GIT_PUSH: "GIT_PUSH",
  COMMIT_PUSH: "GIT_COMMIT_PUSH",
  GIT_COMMIT_PUSH: "GIT_COMMIT_PUSH",
  COMMIT_AND_PUSH: "GIT_COMMIT_PUSH",
  COMMITA_E_PUSHA: "GIT_COMMIT_PUSH",
  TEST: "RUN_TEST",
  RUN_TEST: "RUN_TEST",
  RUN_TESTS: "RUN_TEST",
  TESTS: "RUN_TEST",
  TYPECHECK: "RUN_TYPECHECK",
  RUN_TYPECHECK: "RUN_TYPECHECK",
  BUILD: "RUN_BUILD",
  RUN_BUILD: "RUN_BUILD",
  SCRIPT: "RUN_PROJECT_SCRIPT",
  RUN_SCRIPT: "RUN_PROJECT_SCRIPT",
  RUN_PROJECT_SCRIPT: "RUN_PROJECT_SCRIPT",
  PROJECT_SCRIPT: "RUN_PROJECT_SCRIPT",
});

export function normalizeDirectActionType(value) {
  const token = normalizeToken(value);
  return DIRECT_ACTION_ALIASES[token] ?? (DIRECT_ACTION_TYPE_SET.has(token) ? token : "UNKNOWN");
}

export function classifyDirectActionIntent(textOrPrompt) {
  if (typeof textOrPrompt !== "string") {
    return { isDirectAction: false, type: null, reason: "non_string_input" };
  }
  const raw = textOrPrompt.trim().toLowerCase();
  if (!raw) {
    return { isDirectAction: false, type: null, reason: "empty_intent" };
  }

  // 1. Check for compound / multi-stage technical work indicators that violate Direct Action fast-path
  // e.g. "corrija os erros e depois commita", "analise se está tudo certo e se estiver commita"
  const compoundOrConditionalWords = [
    /\b(?:corrija|corrigir|conserta|consertar|fix|fixe)\b/,
    /\b(?:bug|erro|erros|error|errors|falha|falhas)\b/,
    /\b(?:analise|analisar|analyze|investigue|investigar|investigate)\b/,
    /\b(?:se\s+estiver|se\s+passar|if\s+ok|if\s+clean|if\s+ready)\b/,
    /\b(?:depois|em\s+seguida|após|after|then)\b/,
    /\b(?:implemente|implementar|implement|adicione|adicionar|add|crie|criar|create|remova|remover|remove)\b/,
    /\b(?:refatore|refatorar|refactor)\b/,
    /\b(?:ajuste|ajustar|altere|alterar|modifique|modificar)\b/,
  ];

  for (const pattern of compoundOrConditionalWords) {
    if (pattern.test(raw)) {
      return {
        isDirectAction: false,
        type: null,
        reason: "compound_intent_requires_technical_work",
        matchedDisqualifier: pattern.source,
      };
    }
  }

  // 2. Exact or low-ambiguity operational intent matching
  // GIT_COMMIT_PUSH
  if (
    /\b(?:commita\s+e\s+pusha|commit\s+(?:and|&)\s+push|commitar\s+e\s+pushar|commita\s+e\s+envia|commit\s+e\s+push)\b/.test(raw)
    || (/\b(?:commit|commita|commitar)\b/.test(raw) && /\b(?:push|pusha|pushar)\b/.test(raw))
  ) {
    return { isDirectAction: true, type: "GIT_COMMIT_PUSH", reason: "explicit_commit_push" };
  }

  // GIT_STATUS
  if (
    /\b(?:mostra|mostre|veja|ver)?\s*(?:o\s+)?git\s+status\b/.test(raw)
    || /^git\s+status$/i.test(raw)
    || /^status$/i.test(raw)
    || /\b(?:mostra|mostre|ver)\s+o\s+status\b/.test(raw)
  ) {
    return { isDirectAction: true, type: "GIT_STATUS", reason: "explicit_git_status" };
  }

  // GIT_DIFF
  if (
    /\b(?:mostra|mostre|veja|ver)?\s*(?:o\s+)?git\s+diff\b/.test(raw)
    || /^git\s+diff$/i.test(raw)
    || /^diff$/i.test(raw)
    || /\b(?:mostra|mostre|ver)\s+o\s+diff\b/.test(raw)
  ) {
    return { isDirectAction: true, type: "GIT_DIFF", reason: "explicit_git_diff" };
  }

  // GIT_COMMIT (without push)
  if (
    /\b(?:commita|commitar|faça\s+o\s+commit|fazer\s+o\s+commit|commit)\b/.test(raw)
    && !/\b(?:push|pusha|pushar)\b/.test(raw)
  ) {
    return { isDirectAction: true, type: "GIT_COMMIT", reason: "explicit_git_commit" };
  }

  // GIT_PUSH (without commit)
  if (
    /\b(?:pusha|pushar|faça\s+o\s+push|fazer\s+o\s+push|push)\b/.test(raw)
    && !/\b(?:commit|commita|commitar)\b/.test(raw)
  ) {
    return { isDirectAction: true, type: "GIT_PUSH", reason: "explicit_git_push" };
  }

  // RUN_TYPECHECK
  if (
    /\b(?:roda|rode|rodar|run|executa|executar)?\s*(?:o\s+)?typecheck\b/.test(raw)
    || /^typecheck$/i.test(raw)
  ) {
    return { isDirectAction: true, type: "RUN_TYPECHECK", reason: "explicit_typecheck" };
  }

  // RUN_BUILD
  if (
    /\b(?:roda|rode|rodar|run|executa|executar|faça\s+o|fazer\s+o)?\s*(?:o\s+)?build\b/.test(raw)
    || /^build$/i.test(raw)
  ) {
    return { isDirectAction: true, type: "RUN_BUILD", reason: "explicit_build" };
  }

  // RUN_TEST
  if (
    /\b(?:roda|rode|rodar|run|executa|executar)\s*(?:os\s+|o\s+)?(?:testes?|tests?)\b/.test(raw)
    || /^testes?$/i.test(raw)
    || /^run\s+tests?$/i.test(raw)
  ) {
    return { isDirectAction: true, type: "RUN_TEST", reason: "explicit_test" };
  }

  // RUN_PROJECT_SCRIPT
  if (
    /\b(?:executa|executar|roda|rode|rodar|run)\s+(?:esse\s+|o\s+)?script\b/.test(raw)
    || /\b(?:execute|run)\s+script\b/.test(raw)
  ) {
    return { isDirectAction: true, type: "RUN_PROJECT_SCRIPT", reason: "explicit_project_script" };
  }

  return { isDirectAction: false, type: null, reason: "unmapped_or_ambiguous_intent" };
}

const LEGACY_TASK_CLASS_ACTIONS = Object.freeze({
  TRIVIAL_CHANGE: "IMPLEMENT",
  MECHANICAL_CHANGE: "MECHANICAL_FIX",
  DOCUMENTATION: "IMPLEMENT",
  CONVENTIONAL_IMPLEMENTATION: "IMPLEMENT",
  HARD_SPECIFIED_IMPLEMENTATION: "IMPLEMENT",
  DEEP_TECHNICAL_INVESTIGATION: "INVESTIGATE",
  HEAVY_EXECUTION: "HEAVY_EXECUTION",
});

export const TOOL_OUTPUT_LIMITS = Object.freeze({
  maxInlineBytes: 65536, // 64 KB
  maxInlineLines: 300,
  previewLines: 30,
  maxFailureExcerpt: 50,
  largeFileThresholdBytes: 200000, // 200 KB threshold for Large File Guard
});

export const POLLING_POLICY = Object.freeze({
  minBackoffSeconds: 15,
  backoffIntervals: Object.freeze([15, 30, 60, 120]),
  maxPollBudget: 3,
});

export const CIRCUIT_BREAKER_THRESHOLDS = Object.freeze({
  maxFileReadsWithoutStateChange: 4,
  maxConsecutiveSameToolCalls: 3,
  maxRepeatedRetryReasons: 2,
  maxOrchestratorCalls: 6,
  maxContextChars: 12000,
  maxContextLines: 350,
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function normalizeToken(value) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

const TASK_DOMAIN_ALIASES = Object.freeze({
  AUTOEQ: "AUTOEQ_ALGORITHM",
  AUTOEQ_ALGO: "AUTOEQ_ALGORITHM",
  AUTO_EQ_ALGORITHM: "AUTOEQ_ALGORITHM",
  AUTOEQ_ALGORITHM: "AUTOEQ_ALGORITHM",
  ALGORITHM: "AUTOEQ_ALGORITHM",
  DSP: "DSP_CORE",
  CORE: "DSP_CORE",
  DSP_CORE: "DSP_CORE",
  CODE: "CODE",
  UI: "UI",
  UX: "UI",
  DATA: "DATA",
  INFRA: "INFRA",
  INFRASTRUCTURE: "INFRA",
  TEST: "TESTING",
  TESTING: "TESTING",
  DOC: "DOCS",
  DOCS: "DOCS",
  DOCUMENTATION: "DOCS",
  RESEARCH: "RESEARCH",
  ORCHESTRA: "ORCHESTRA",
  ORCHESTRATION: "ORCHESTRA",
  GENERAL: "GENERAL",
});

export function canonicalTaskDomain(value) {
  const token = normalizeToken(value);
  const domain = TASK_DOMAIN_ALIASES[token] ?? (TASK_DOMAIN_SET.has(token) ? token : "GENERAL");
  return domain;
}

function taskDomainValue(facts = {}) {
  if (typeof facts === "string") return facts;
  return firstPresent(facts, ["taskDomain", "task_domain", "domain"]);
}

export function normalizeTaskDomain(facts = {}) {
  return canonicalTaskDomain(taskDomainValue(facts));
}

export const normalizeDomain = normalizeTaskDomain;
export const TASK_DOMAIN_VALUES = TASK_DOMAINS;

function hasExplicitTaskDomain(facts = {}) {
  return ["taskDomain", "task_domain", "domain"].some((key) => (
    hasOwn(facts, key) && facts[key] !== undefined && facts[key] !== null && facts[key] !== ""
  ));
}

function normalizeCriticalityValue(value) {
  const token = normalizeToken(value);
  if (CRITICALITY_SET.has(token)) return token;
  if (["HIGH", "IMPORTANT", "SIGNIFICANT", "MAJOR"].includes(token)) return "MAJOR";
  if (["CRITICAL", "SEVERE", "DESTRUCTIVE", "RELEASE_CRITICAL"].includes(token)) return "CRITICAL";
  return "NORMAL";
}

export function normalizeCriticality(facts = {}) {
  if (typeof facts === "string") return normalizeCriticalityValue(facts);
  return normalizeCriticalityValue(firstPresent(facts, ["criticality", "criticalityLevel", "riskLevel"]));
}

function canonicalAction(value) {
  const token = normalizeToken(value);
  return ACTION_ALIASES[token] ?? (ACTION_SET.has(token) ? token : "UNKNOWN");
}

function firstPresent(facts, keys) {
  if (!facts || typeof facts !== "object") return undefined;
  for (const key of keys) {
    if (hasOwn(facts, key) && facts[key] !== undefined && facts[key] !== null) {
      return facts[key];
    }
  }
  return undefined;
}

function taskActionInfo(facts = {}) {
  const explicitKey = ["taskAction", "nextTaskAction", "action"].find((key) => hasOwn(facts, key));
  if (explicitKey) {
    return {
      action: canonicalAction(facts[explicitKey]),
      explicit: true,
      source: explicitKey,
    };
  }

  if (hasOwn(facts, "taskClass")) {
    const classToken = normalizeToken(facts.taskClass);
    return {
      action: LEGACY_TASK_CLASS_ACTIONS[classToken] ?? "UNKNOWN",
      explicit: true,
      source: "taskClass",
      taskClass: classToken,
    };
  }

  return { action: null, explicit: false, source: null };
}

export function normalizeTaskAction(facts = {}) {
  return taskActionInfo(facts).action ?? "UNKNOWN";
}

export function normalizeComplexity(value) {
  const token = normalizeToken(value);
  if (["SIMPLE", "TRIVIAL", "SMALL", "LOW"].includes(token)) return "simple";
  if (["EXPERIMENTAL", "RESEARCH", "INVESTIGATIVE", "EXPERIMENT"].includes(token)) return "experimental";
  if (["DIFFICULT", "HARD", "COMPLEX", "LARGE", "MAX", "VERY_HARD"].includes(token)) return "difficult";
  return "normal";
}

function implementationComplexity(facts = {}) {
  const explicit = firstPresent(facts, [
    "implementationComplexity",
    "implementationDifficulty",
    "difficulty",
    "complexity",
  ]);
  if (explicit === undefined && normalizeTaskDomain(facts) === "DOCS") return "simple";
  return normalizeComplexity(explicit);
}

function investigationEffort(facts = {}) {
  const token = normalizeToken(firstPresent(facts, [
    "investigationEffort",
    "investigationDifficulty",
    "investigationDepth",
    "difficulty",
    "complexity",
  ]));
  if (["MAX", "VERY_HARD", "DEEP_MAX", "XHIGH", "X_HIGH", "DEEP", "VERY_DEEP", "HARD_DEEP", "DIFFICULT", "HARD", "COMPLEX"].includes(token)) return "high";
  return "high";
}

function integerOrUndefined(value) {
  return Number.isInteger(value) ? value : undefined;
}

function retryBudgetInput(facts = {}) {
  if (facts && typeof facts === "object" && hasOwn(facts, "retryBudget")) return facts.retryBudget;
  if (facts && typeof facts.scopeContract === "object" && hasOwn(facts.scopeContract, "retryBudget")) return facts.scopeContract.retryBudget;
  return undefined;
}

function retryBudgetIsExplicit(facts = {}) {
  const nestedBudget = facts && typeof facts.scopeContract === "object"
    ? facts.scopeContract.retryBudget
    : undefined;
  return Boolean(
    (facts && typeof facts === "object" && hasOwn(facts, "retryBudget"))
    || nestedBudget !== undefined
    || hasOwn(facts, "maxAttempts")
    || hasOwn(facts, "remainingAttempts")
    || hasOwn(facts, "attempt")
    || hasOwn(facts, "attemptNumber")
    || hasOwn(facts, "attempt_number"),
  );
}

function defaultRetryAttempts(facts = {}) {
  const complexity = implementationComplexity(facts);
  if (facts.experimental === true || facts.investigative === true || taskActionInfo(facts).action === "INVESTIGATE" || complexity === "experimental") return 3;
  return 2;
}

export function createRetryBudget(facts = {}) {
  const raw = retryBudgetInput(facts);
  const rawObject = raw && typeof raw === "object" ? raw : {};
  const maxCandidate = typeof raw === "number"
    ? raw
    : firstPresent(rawObject, ["maxAttempts", "max_attempts", "retryBudget"])
      ?? firstPresent(facts, ["maxAttempts", "max_attempts"]);
  const maxAttempts = Number.isInteger(maxCandidate) && maxCandidate > 0
    ? maxCandidate
    : defaultRetryAttempts(facts);
  const attemptCandidate = firstPresent(rawObject, ["attempt", "attemptNumber", "attempt_number"])
    ?? firstPresent(facts, ["attempt", "attemptNumber", "attempt_number"]);
  const attempt = Math.max(0, Math.min(maxAttempts, integerOrUndefined(attemptCandidate) ?? 0));
  const remainingCandidate = firstPresent(rawObject, ["remainingAttempts", "remaining_attempts"])
    ?? firstPresent(facts, ["remainingAttempts", "remaining_attempts"]);
  const remainingAttempts = Math.max(
    0,
    Math.min(maxAttempts - attempt, integerOrUndefined(remainingCandidate) ?? (maxAttempts - attempt)),
  );
  return { maxAttempts, attempt, remainingAttempts };
}

export function consumeRetryBudget(facts = {}) {
  const budget = facts && typeof facts === "object" && hasOwn(facts, "maxAttempts")
    ? createRetryBudget({ retryBudget: facts })
    : createRetryBudget(facts);
  if (budget.remainingAttempts <= 0 || budget.attempt >= budget.maxAttempts) {
    return { ...budget, attempt: Math.min(budget.attempt, budget.maxAttempts), remainingAttempts: 0 };
  }
  return {
    maxAttempts: budget.maxAttempts,
    attempt: budget.attempt + 1,
    remainingAttempts: Math.max(0, budget.remainingAttempts - 1),
  };
}

export const createRetryState = createRetryBudget;
export const nextRetryBudget = consumeRetryBudget;
export const normalizeRetryBudget = createRetryBudget;

/* =========================================================================
   State Machine Engine
   ========================================================================= */

export function validateStateTransition(fromState, toState, facts = {}) {
  const normFrom = normalizeToken(fromState);
  const normTo = normalizeToken(toState);

  // Fast-path: EXECUTING -> DONE is allowed for DIRECT_ACTION operations
  if (
    normFrom === "EXECUTING" &&
    normTo === "DONE" &&
    facts &&
    (facts.taskAction === "DIRECT_ACTION" || facts.isDirectAction === true || facts.directAction === true)
  ) {
    return {
      valid: true,
      error: null,
      from: normFrom,
      to: normTo,
    };
  }

  if (!VALID_TRANSITIONS[normFrom]) {
    return {
      valid: false,
      error: "INVALID_TRANSITION",
      reason: `Current state "${fromState}" is not a recognized state machine state.`,
      from: normFrom,
      to: normTo,
    };
  }

  const allowedTargets = VALID_TRANSITIONS[normFrom];
  if (!allowedTargets.includes(normTo)) {
    return {
      valid: false,
      error: "INVALID_TRANSITION",
      reason: `Transition from "${normFrom}" to "${normTo}" is prohibited. Allowed: [${allowedTargets.join(", ")}].`,
      from: normFrom,
      to: normTo,
    };
  }

  return {
    valid: true,
    error: null,
    from: normFrom,
    to: normTo,
  };
}

/* =========================================================================
   Model Routing Constructors (ALL-GEMINI)
   ========================================================================= */

const flashWorker = (effort, reason, extras = {}) => {
  const model = effort === "low" ? GEMINI_MODELS.WORKER_LOW : (effort === "high" ? GEMINI_MODELS.WORKER_HIGH : GEMINI_MODELS.WORKER_MEDIUM);
  const tier = effort === "low" ? "flash_lite" : (effort === "high" ? "pro" : "flash");
  return {
    kind: "worker",
    model,
    tier,
    effort,
    reason,
    executor: "flash",
    ...extras,
  };
};

const flashOrchestrator = (effort, reason, extras = {}) => ({
  kind: "orchestration",
  model: GEMINI_MODELS.ORCHESTRATOR,
  tier: "flash",
  effort: effort ?? "medium",
  reason,
  executor: "flash-orchestrator",
  ...extras,
});

const flashInvestigator = (effort, reason, extras = {}) => ({
  kind: "orchestration",
  model: GEMINI_MODELS.INVESTIGATOR,
  tier: "pro",
  effort: "high",
  reason,
  executor: "flash-specialist",
  ...extras,
});

const deterministic = (action, reason, extras = {}) => ({
  kind: "deterministic",
  action,
  reason,
  ...extras,
});

const objectiveGateRoutes = {
  "lint-failure": () => deterministic("bounded-fix-retry", "lint-failure"),
  "formatter-failure": () => deterministic("bounded-fix-retry", "formatter-failure"),
  "known-direct-test-failure": () => deterministic("bounded-fix-retry", "known-direct-test-failure"),
  "simple-integration-retry": () => deterministic("bounded-integration-retry", "simple-integration-retry"),
  "worker-objective-limit": () => deterministic("stop-and-review", "worker-objective-limit"),
};

function implementationRoute(facts = {}, reasonPrefix = "implement", extras = {}) {
  const complexity = implementationComplexity(facts);
  const domain = normalizeTaskDomain(facts);

  if (facts.postInvestigation === true || complexity === "difficult" || complexity === "experimental") {
    return flashWorker("high", extras.retry === true ? reasonPrefix : `${reasonPrefix}-standard`, extras);
  }
  if (extras.retry === true) {
    return flashWorker(complexity === "simple" ? "low" : "medium", reasonPrefix, extras);
  }
  if (complexity === "simple" || domain === "DOCS") {
    return flashWorker("low", `${reasonPrefix}-simple`, extras);
  }
  return flashWorker("medium", `${reasonPrefix}-standard`, extras);
}

function legacyRoute(taskClass) {
  switch (taskClass) {
    case "TRIVIAL_CHANGE":
      return flashWorker("low", "explicit-trivial");
    case "MECHANICAL_CHANGE":
      return flashWorker("low", "mechanical-change");
    case "DOCUMENTATION":
      return flashWorker("low", "documentation");
    case "CONVENTIONAL_IMPLEMENTATION":
      return flashWorker("medium", "explicit-conventional");
    case "HARD_SPECIFIED_IMPLEMENTATION":
      return flashWorker("high", "explicit-hard-specified");
    case "DEEP_TECHNICAL_INVESTIGATION":
      return flashInvestigator("high", "deep-investigation");
    default:
      return null;
  }
}

function routeAction(action, facts = {}) {
  switch (action) {
    case "ORCHESTRATE":
      return flashOrchestrator("medium", "explicit-orchestration");
    case "INVESTIGATE": {
      const effort = investigationEffort(facts);
      return flashInvestigator(effort, `investigation-${effort}`);
    }
    case "IMPLEMENT":
      return implementationRoute(facts);
    case "TEST": {
      const complexity = implementationComplexity(facts);
      return flashWorker(complexity === "simple" ? "low" : "medium", "test-execution");
    }
    case "REVIEW":
      return flashOrchestrator("medium", "review-control-plane");
    case "MECHANICAL_FIX":
      return flashWorker("low", "mechanical-fix");
    case "ESCALATE":
      return flashOrchestrator("medium", "escalation-review-required");
    case "HEAVY_EXECUTION":
      return flashWorker("high", "heavy-execution-isolated", {
        disposable: true,
        heavyExecution: true,
        contextFirewall: true,
      });
    case "DIRECT_ACTION": {
      const subType = facts.directActionType || facts.subType || facts.actionType || "UNKNOWN";
      const normalizedType = normalizeDirectActionType(subType);
      return {
        kind: "direct_action",
        action: "DIRECT_ACTION",
        directActionType: normalizedType,
        model: GEMINI_MODELS.ORCHESTRATOR,
        tier: "flash",
        effort: "medium",
        executor: "flash-orchestrator",
        reason: `direct-action-${normalizedType.toLowerCase().replace(/_/g, "-")}`,
        subagentsAllowed: false,
      };
    }
    default:
      return flashOrchestrator("medium", "unknown-action-classification");
  }
}

export function decideRoute(facts = {}) {
  const info = taskActionInfo(facts);

  const crossDomainRequest = crossDomainFacts(facts);
  if (crossDomainRequest) {
    return decorateRoute(
      flashOrchestrator("medium", "cross-domain-request", { crossDomainRequest }),
      facts,
    );
  }

  if (info.action === "UNKNOWN") {
    const userText = firstPresent(facts, ["intent", "prompt", "userIntent", "request"]);
    if (userText) {
      const directIntent = classifyDirectActionIntent(userText);
      if (directIntent.isDirectAction) {
        return decorateRoute(routeAction("DIRECT_ACTION", { ...facts, directActionType: directIntent.type }), facts);
      }
    }
    return decorateRoute(flashOrchestrator("medium", "unknown-action-classification"), facts);
  }

  if (info.action) {
    if (info.source === "taskClass") {
      const legacy = legacyRoute(info.taskClass);
      if (legacy) return decorateRoute(legacy, facts);
    }
    if (info.action === "IMPLEMENT" && normalizeToken(facts.taskAction) === "DOCUMENTATION" && !firstPresent(facts, ["implementationComplexity", "implementationDifficulty", "difficulty", "complexity"])) {
      return decorateRoute(flashWorker("low", "documentation"), facts);
    }
    if (info.action === "IMPLEMENT" && (
      facts.integration === true
      || normalizeToken(facts.operation) === "INTEGRATE"
      || normalizeToken(facts.taskAction) === "INTEGRATE"
    )) {
      return decorateRoute(
        flashWorker("high", "integration-required", { integrationRequired: true }),
        facts,
        { includeTaskDomain: !hasExplicitTaskDomain(facts) },
      );
    }
    return decorateRoute(routeAction(info.action, facts), facts);
  }

  const userText = firstPresent(facts, ["intent", "prompt", "userIntent", "request"]);
  if (userText) {
    const directIntent = classifyDirectActionIntent(userText);
    if (directIntent.isDirectAction) {
      return decorateRoute(routeAction("DIRECT_ACTION", { ...facts, directActionType: directIntent.type }), facts);
    }
  }

  if (facts.objectiveGate && objectiveGateRoutes[facts.objectiveGate]) {
    return decorateRoute(objectiveGateRoutes[facts.objectiveGate](), facts);
  }

  return decorateRoute(flashOrchestrator("medium", "default-orchestration"), facts);
}

function isIncompleteWorkerResult(facts = {}) {
  const status = normalizeToken(firstPresent(facts, [
    "workerResult",
    "implementationStatus",
    "workerStatus",
    "resultStatus",
    "result",
  ]));
  return ["INCOMPLETE", "PARTIAL", "NEEDS_REWORK", "BLOCKED"].includes(status)
    || facts.workerCompleted === false
    || facts.implementationComplete === false
    || facts.implementationIncomplete === true
    || facts.workerIncomplete === true;
}

function nextActionFacts(facts, nextAction, nextTaskClass) {
  const next = { ...facts };
  delete next.action;
  delete next.taskAction;
  delete next.nextTaskAction;
  delete next.taskClass;
  if (nextAction !== undefined) next.taskAction = nextAction;
  if (nextTaskClass !== undefined) next.taskClass = nextTaskClass;
  return next;
}

function listValue(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

function normalizedPath(value) {
  return String(value).trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizePathList(value) {
  return listValue(value).map(normalizedPath);
}

function globToRegExp(pattern) {
  const normalized = normalizedPath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function pathMatchesPattern(path, pattern) {
  const normalizedPattern = normalizedPath(pattern);
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return globToRegExp(normalizedPattern).test(path);
}

function contractValue(details, names, fallback) {
  const value = firstPresent(details, names);
  return value === undefined || value === null ? fallback : value;
}

export function createScopeContract(details = {}) {
  const nested = details.scopeContract && typeof details.scopeContract === "object"
    ? details.scopeContract
    : {};
  const merged = { ...details, ...nested };
  const action = normalizeTaskAction(merged);
  const taskAction = action === "UNKNOWN" ? "IMPLEMENT" : action;
  const domain = normalizeTaskDomain(merged);
  const budget = createRetryBudget(merged);
  const inferredAllowedPaths = listValue(merged.filesAreas ?? merged.files)
    .filter((value) => typeof value === "string" && (value.includes("/") || value.includes("\\") || value.includes("**")));
  const inferredForbiddenPaths = listValue(merged.doNotChange ?? merged.do_not_change)
    .filter((value) => typeof value === "string" && (value.includes("/") || value.includes("\\") || value.includes("**")));
  const contract = {
    taskAction,
    taskDomain: domain,
    allowedPaths: normalizePathList(contractValue(merged, ["allowedPaths", "allowedScope", "allowed_paths"], inferredAllowedPaths)),
    forbiddenPaths: normalizePathList(contractValue(merged, ["forbiddenPaths", "forbiddenScope", "forbidden_paths"], inferredForbiddenPaths)),
    dependencies: listValue(contractValue(merged, ["dependencies"], [])),
    currentState: contractValue(merged, ["currentState", "current_state"], null),
    rootCauseDecision: contractValue(merged, ["rootCauseDecision", "rootCause", "root_cause_decision"], null),
    implementationPlan: listValue(contractValue(merged, ["implementationPlan", "plan", "implementation_plan"], [])),
    acceptanceCriteria: listValue(contractValue(merged, ["acceptanceCriteria", "acceptance_criteria"], [])),
    testsRequired: listValue(contractValue(merged, ["testsRequired", "tests", "tests_required"], [])),
    retryBudget: budget,
    stopConditions: listValue(contractValue(merged, ["stopConditions", "stop_conditions"], [])),
    doNotChange: listValue(contractValue(merged, ["doNotChange", "do_not_change"], [])),
    criticality: normalizeCriticality(merged),
  };
  return contract;
}

export function validateScopeContract(contractOrFacts = {}, changedPaths = []) {
  const contract = contractOrFacts.scopeContract && typeof contractOrFacts.scopeContract === "object"
    ? contractOrFacts.scopeContract
    : contractOrFacts;
  const suppliedPaths = listValue(changedPaths);
  const paths = normalizePathList(
    suppliedPaths.length > 0
      ? suppliedPaths
      : firstPresent(contractOrFacts, ["changedPaths", "changed_paths", "pathsChanged"]) ?? [],
  );
  const allowedPaths = normalizePathList(firstPresent(contract, ["allowedPaths", "allowedScope", "allowed_paths"]) ?? []);
  const forbiddenPaths = normalizePathList(firstPresent(contract, ["forbiddenPaths", "forbiddenScope", "forbidden_paths"]) ?? []);
  const violations = [];
  for (const path of paths) {
    if (forbiddenPaths.some((pattern) => pathMatchesPattern(path, pattern))) {
      violations.push({ path, reason: "forbidden-path" });
    } else if (allowedPaths.length > 0 && !allowedPaths.some((pattern) => pathMatchesPattern(path, pattern))) {
      violations.push({ path, reason: "outside-allowed-path" });
    }
  }
  return {
    valid: violations.length === 0,
    scopeViolation: violations.length > 0,
    scopeExpansion: violations.length > 0,
    violations,
    changedPaths: paths,
  };
}

export const checkScopeCompliance = validateScopeContract;
export const detectScopeViolations = validateScopeContract;
export const buildScopeContract = createScopeContract;

function crossDomainFacts(facts = {}) {
  const workerResult = firstPresent(facts, ["workerResult", "worker_result", "result"]);
  const raw = firstPresent(facts, ["crossDomainRequest", "cross_domain_request"])
    ?? (workerResult && typeof workerResult === "object" && (
      workerResult.type === CROSS_DOMAIN_REQUEST || workerResult.kind === "cross-domain-request"
    ) ? workerResult : null)
    ?? (normalizeToken(workerResult) === CROSS_DOMAIN_REQUEST ? { type: CROSS_DOMAIN_REQUEST } : null);
  if (!raw || raw === false) return null;
  if (raw === true) return { type: CROSS_DOMAIN_REQUEST };
  return raw;
}

function hasBlockingCrossDomainRequest(facts = {}) {
  const direct = crossDomainFacts(facts);
  if (direct) return direct.blocking !== false;
  const requests = firstPresent(facts, ["crossDomainRequests", "cross_domain_requests"]);
  return Array.isArray(requests) && requests.some((request) => request && request.resolved !== true && request.blocking !== false);
}

export function createCrossDomainRequest(details = {}) {
  const currentDomain = normalizeTaskDomain({ taskDomain: firstPresent(details, ["currentDomain", "current_domain", "taskDomain"]) });
  const requiredDomain = normalizeTaskDomain({ taskDomain: firstPresent(details, ["requiredDomain", "required_domain", "domain"]) });
  if (currentDomain === requiredDomain) {
    throw new Error("CROSS_DOMAIN_REQUEST requires distinct currentDomain and requiredDomain");
  }
  const reason = firstPresent(details, ["reason"]);
  const requestedCapability = firstPresent(details, ["requestedCapability", "requestedChange", "requestedCapabilityChange", "requested_capability"]);
  const evidence = listValue(firstPresent(details, ["evidence"]));
  if (!reason) throw new Error("CROSS_DOMAIN_REQUEST requires reason");
  if (!requestedCapability) throw new Error("CROSS_DOMAIN_REQUEST requires requestedCapability");
  if (evidence.length === 0) throw new Error("CROSS_DOMAIN_REQUEST requires evidence");
  return {
    type: CROSS_DOMAIN_REQUEST,
    kind: "cross-domain-request",
    currentDomain,
    requiredDomain,
    reason,
    requestedCapability,
    requestedCapabilityChange: requestedCapability,
    evidence,
    blocking: details.blocking !== false,
  };
}

function decorateRoute(decision, facts = {}, extras = {}) {
  const result = { ...decision, ...extras };
  if (hasExplicitTaskDomain(facts) || extras.includeTaskDomain === true) {
    result.taskDomain = normalizeTaskDomain(facts);
  }
  const action = taskActionInfo(facts).action;
  const hasScopeFacts = facts.scopeContract !== undefined
    || firstPresent(facts, ["allowedPaths", "allowedScope", "allowed_paths", "forbiddenPaths", "forbiddenScope", "forbidden_paths"]) !== undefined
    || firstPresent(facts, ["acceptanceCriteria", "acceptance_criteria", "stopConditions", "stop_conditions"]) !== undefined;
  if (result.kind === "worker" && action === "IMPLEMENT" && hasScopeFacts && result.scopeContract === undefined) {
    result.scopeContract = createScopeContract(facts);
  }
  if (action === "IMPLEMENT" && retryBudgetIsExplicit(facts) && result.retryBudget === undefined) {
    const budget = createRetryBudget(facts);
    result.retryBudget = budget;
    result.attempt = budget.attempt;
    result.remainingAttempts = budget.remainingAttempts;
  }
  if (hasOwn(facts, "criticality") || hasOwn(facts, "criticalityLevel") || hasOwn(facts, "riskLevel")) {
    result.criticality ??= normalizeCriticality(facts);
  }

  delete result.includeTaskDomain;
  return result;
}

function normalizeStatus(value) {
  const token = normalizeToken(value);
  if (["PASSED", "PASS", "ACCEPTED", "ACCEPT", "DONE", "COMPLETE", "COMPLETED", "IMPLEMENTATION_COMPLETE"].includes(token)) return "PASSED";
  if (["FAILED", "FAIL", "ERROR", "REJECTED", "CHANGES_REQUIRED", "BLOCK", "BLOCKED"].includes(token)) return "FAILED";
  if (["PENDING", "IN_PROGRESS", "INCOMPLETE", "PARTIAL", "NEEDS_REWORK", "REVIEW_REQUIRED"].includes(token)) return "PENDING";
  if (["NOT_REQUIRED", "NONE", "SKIPPED"].includes(token)) return "NOT_REQUIRED";
  return token;
}

function workerResultComplete(facts = {}) {
  const status = normalizeStatus(firstPresent(facts, [
    "workerResult",
    "implementationStatus",
    "workerStatus",
    "resultStatus",
    "result",
  ]));
  return facts.workerCompleted === true
    || facts.implementationComplete === true
    || status === "PASSED";
}

function scopeValidationForFacts(facts = {}) {
  const contract = facts.scopeContract && typeof facts.scopeContract === "object"
    ? facts.scopeContract
    : null;
  const changedPaths = firstPresent(facts, ["changedPaths", "changed_paths", "pathsChanged"]);
  const hasInlineContract = firstPresent(facts, ["allowedPaths", "allowedScope", "allowed_paths", "forbiddenPaths", "forbiddenScope", "forbidden_paths"]) !== undefined;
  const validation = contract || hasInlineContract
    ? validateScopeContract(contract ?? facts, listValue(changedPaths))
    : { valid: true, scopeViolation: false, violations: [], changedPaths: [] };
  if (facts.scopeViolation === true || facts.scopeViolation?.violations
    || facts.scope_violation === true || facts.scope_violation?.violations
    || facts.scopeViolations?.length > 0 || facts.scope_violations?.length > 0
    || facts.scopeCompliant === false || facts.scope_compliant === false
    || facts.scopeValidation?.scopeViolation === true || facts.scopeValidation?.valid === false) {
    return { ...validation, valid: false, scopeViolation: true };
  }
  return validation;
}

function integrationStateValue(facts = {}) {
  return normalizeStatus(firstPresent(facts, [
    "integrationResult",
    "integration_result",
    "integrationState",
    "integration_state",
  ]));
}

export function requiresIntegration(facts = {}) {
  if (facts.integrationRequired === true || facts.integration_required === true) return true;
  const state = integrationStateValue(facts);
  if (["PENDING", "FAILED", "REQUIRED"].includes(state)) return true;
  if (facts.integrationRequired === false || facts.integration_required === false || state === "NOT_REQUIRED") return false;
  const deliverableCount = Math.max(
    listValue(facts.deliverables).length,
    listValue(facts.deliverableSet).length,
  );
  const subtaskCount = Math.max(
    listValue(facts.subtasks).length,
    listValue(facts.pendingTasks).length,
    listValue(facts.pending_tasks).length,
    listValue(facts.completedTasks).length,
    listValue(facts.completed_tasks).length,
  );
  const domainCount = Math.max(
    listValue(facts.domains).length,
    listValue(facts.taskDomains).length,
    listValue(facts.task_domains).length,
  );
  return deliverableCount > 1 || subtaskCount > 1 || domainCount > 1;
}

function integrationComplete(facts = {}) {
  return facts.integrationComplete === true
    || ["PASSED", "COMPLETE"].includes(integrationStateValue(facts));
}

export const isIntegrationComplete = integrationComplete;

function individualAcceptancePassed(facts = {}) {
  const direct = normalizeStatus(firstPresent(facts, [
    "individualAcceptance",
    "individualAcceptanceStatus",
    "subtaskAcceptanceStatus",
    "deliverableAcceptanceStatus",
  ]));
  if (direct === "PASSED") return true;
  if (facts.allSubtasksAccepted === true || facts.allDeliverablesAccepted === true) return true;
  const entries = firstPresent(facts, ["subtasks", "deliverables", "completedTasks", "completed_tasks"]);
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((entry) => {
    if (entry === true) return true;
    if (!entry || typeof entry !== "object") return false;
    return entry.accepted === true
      || ["PASSED", "ACCEPTED", "COMPLETE"].includes(normalizeStatus(entry.acceptanceStatus ?? entry.acceptanceResult ?? entry.status ?? entry.result));
  });
}

export function createAcceptanceGate(details = {}) {
  const workerComplete = workerResultComplete(details)
    || details.acceptanceCriteriaStatus === "passed"
    || normalizeStatus(firstPresent(details, ["acceptanceState", "acceptance_state", "acceptanceResult", "acceptance_result"])) === "PASSED";
  const scopeValidation = scopeValidationForFacts(details);
  const criteriaStatus = normalizeStatus(firstPresent(details, ["acceptanceCriteriaStatus", "acceptanceStatus", "criteriaStatus", "acceptanceState", "acceptance_state", "acceptanceResult", "acceptance_result"]));
  const directTestsStatus = normalizeStatus(firstPresent(details, ["requiredTestsStatus", "testsStatus", "testStatus"]));
  const ledgerEntries = listValue(details.evidenceLedger || details.evidence_ledger);
  const ledgerTestRuns = ledgerEntries.filter(e => e && e.type === "TEST_RUN");
  const testsStatus = directTestsStatus || (ledgerTestRuns.length > 0 && ledgerTestRuns.every(t => t.exitCode === 0 && (!t.failed || t.failed === 0)) ? "PASSED" : null);
  const requiredTests = listValue(firstPresent(details, ["testsRequired", "tests_required"]));
  const nestedRequiredTests = details.scopeContract && typeof details.scopeContract === "object"
    ? listValue(firstPresent(details.scopeContract, ["testsRequired", "tests_required"]))
    : [];
  const integrationRequired = requiresIntegration(details);
  let result = "REVIEW_REQUIRED";
  if (!workerComplete) {
    result = "REVIEW_REQUIRED";
  } else if (!scopeValidation.valid) {
    result = "REPLAN_REQUIRED";
  } else if (hasBlockingCrossDomainRequest(details)) {
    result = "REPLAN_REQUIRED";
  } else if (listValue(firstPresent(details, ["blockers", "unresolvedBlockers", "unresolved_blockers"])).length > 0 && details.blockersResolved !== true) {
    result = "REPLAN_REQUIRED";
  } else if (integrationRequired && !integrationComplete(details)) {
    result = "INTEGRATION_REQUIRED";
  } else if (criteriaStatus !== "PASSED") {
    result = "REVIEW_REQUIRED";
  } else if (testsStatus === "FAILED" || details.regressionsFound === true || details.regression === true) {
    result = "RETRY_REQUIRED";
  } else if ((requiredTests.length > 0 || nestedRequiredTests.length > 0) && testsStatus !== "PASSED") {
    result = "REVIEW_REQUIRED";
  } else {
    result = "ACCEPTED";
  }
  return { result, owner: "flash-orchestrator", workerComplete };
}

export const evaluateAcceptance = createAcceptanceGate;
export const acceptanceGate = createAcceptanceGate;

export function createIntegrationContract(details = {}) {
  const taskDomain = normalizeTaskDomain(details);
  const scopeContract = createScopeContract({
    ...details,
    taskAction: "IMPLEMENT",
    taskDomain,
    implementationComplexity: "difficult",
  });
  return {
    kind: "integration-contract",
    taskAction: "IMPLEMENT",
    operation: "INTEGRATE",
    taskDomain,
    executor: "flash",
    worker: "flash-worker",
    model: GEMINI_MODELS.WORKER_HIGH,
    tier: "pro",
    effort: "high",
    scopeContract,
    acceptanceCriteria: scopeContract.acceptanceCriteria,
    testsRequired: scopeContract.testsRequired,
    stopConditions: scopeContract.stopConditions,
  };
}

export const createIntegrationHandoff = createIntegrationContract;
export const integrationGate = requiresIntegration;
export const isIntegrationRequired = requiresIntegration;

/* =========================================================================
   Two-Key Critical Review Logic (ALL-GEMINI)
   ========================================================================= */

export function createTwoKeyReviewPacket(details = {}) {
  const required = ["goal", "acceptanceCriteria", "technicalDecision", "diff", "tests", "risks"];
  for (const field of required) {
    if (details[field] === undefined || details[field] === null || details[field] === "") {
      throw new Error(`TWO-KEY REVIEW requires ${field}`);
    }
  }
  return {
    type: "TWO_KEY_CRITICAL_REVIEW",
    modelReviewerA: GEMINI_MODELS.REVIEWER_A,
    modelReviewerB: GEMINI_MODELS.REVIEWER_B,
    criticality: "CRITICAL",
    goal: details.goal,
    acceptanceCriteria: details.acceptanceCriteria,
    technicalDecision: details.technicalDecision,
    diff: details.diff,
    tests: details.tests,
    risks: details.risks,
    allowedVerdicts: ["ACCEPT", "ACCEPT_WITH_NOTES", "CHANGES_REQUIRED", "BLOCK"],
  };
}

export function evaluateTwoKeyReview(packet = {}, reviewerAVerdict, reviewerBVerdict) {
  const normA = normalizeIndependentReviewResult(reviewerAVerdict);
  const normB = normalizeIndependentReviewResult(reviewerBVerdict);

  const isAcceptA = normA === "ACCEPT" || normA === "ACCEPT_WITH_NOTES";
  const isAcceptB = normB === "ACCEPT" || normB === "ACCEPT_WITH_NOTES";

  if (isAcceptA && isAcceptB) {
    return {
      acceptable: true,
      decision: normA === "ACCEPT_WITH_NOTES" || normB === "ACCEPT_WITH_NOTES" ? "ACCEPT_WITH_NOTES" : "ACCEPT",
      nextState: "DONE",
      reviewerA: normA,
      reviewerB: normB,
    };
  }

  const isRejectA = normA === "CHANGES_REQUIRED" || normA === "BLOCK";
  const isRejectB = normB === "CHANGES_REQUIRED" || normB === "BLOCK";

  if (isRejectA && isRejectB) {
    return {
      acceptable: false,
      decision: normA === "BLOCK" || normB === "BLOCK" ? "REPLAN_REQUIRED" : "RETRY_REQUIRED",
      nextState: "PLANNED",
      reviewerA: normA,
      reviewerB: normB,
      retryReason: "TWO_KEY_REJECTION",
    };
  }

  // Disagreement -> immediately halts to HUMAN_GATE
  return {
    acceptable: false,
    decision: "DISAGREEMENT",
    nextState: "HUMAN_GATE",
    humanGateRequired: true,
    reason: `Two-Key review disagreement: Reviewer A reported ${normA}, while Reviewer B reported ${normB}. Halting to Human Gate.`,
    reviewerA: normA,
    reviewerB: normB,
  };
}

export const createIndependentReviewPacket = (details = {}) => {
  const decision = details.technicalDecision || details.decision;
  return createTwoKeyReviewPacket({ ...details, technicalDecision: decision });
};

function normalizeIndependentReviewResult(value) {
  const token = normalizeToken(value);
  if (["ACCEPT", "ACCEPTED", "PASS", "PASSED"].includes(token)) return "ACCEPT";
  if (["ACCEPT_WITH_NOTES", "ACCEPT_NOTES", "PASS_WITH_NOTES"].includes(token)) return "ACCEPT_WITH_NOTES";
  if (["CHANGES_REQUIRED", "CHANGE_REQUIRED", "REWORK", "RETRY"].includes(token)) return "CHANGES_REQUIRED";
  if (["BLOCK", "BLOCKED", "REJECT", "REJECTED"].includes(token)) return "BLOCK";
  return token || null;
}

function independentReviewNeeded(facts = {}) {
  return normalizeCriticality(facts) === "CRITICAL"
    || facts.independentReviewRequired === true
    || facts.independent_review_required === true;
}

function shouldExposeAcceptanceMetadata(facts = {}) {
  return hasExplicitTaskDomain(facts)
    || retryBudgetIsExplicit(facts)
    || facts.scopeContract !== undefined
    || facts.integrationRequired !== undefined
    || facts.integration_required !== undefined
    || facts.criticality !== undefined
    || facts.independentReviewRequired === true
    || facts.independent_review_required === true;
}

/* =========================================================================
   Evidence Ledger & Acceptance Eligibility Checks
   ========================================================================= */

export function validateAcceptanceEligibility(facts = {}, evidenceLedger) {
  const ledger = Array.isArray(evidenceLedger) && evidenceLedger.length > 0
    ? evidenceLedger
    : listValue(facts.evidenceLedger || facts.evidence_ledger);

  const reasons = [];

  // Check 1: Required criteria
  if (facts.acceptanceCriteriaStatus !== "passed" && facts.criteriaStatus !== "passed") {
    reasons.push("Acceptance criteria not verified as passed");
  }

  // Check 2: Scope violation
  const scope = scopeValidationForFacts(facts);
  if (!scope.valid || scope.scopeViolation) {
    reasons.push("Scope contract violation detected");
  }

  // Check 3: Cross-domain requests
  if (hasBlockingCrossDomainRequest(facts)) {
    reasons.push("Unresolved blocking cross-domain request");
  }

  // Check 4: Unresolved blockers
  const blockers = listValue(facts.blockers || facts.unresolvedBlockers);
  if (blockers.length > 0 && facts.blockersResolved !== true) {
    reasons.push("Unresolved task blockers present");
  }

  // Check 5: Evidence in Ledger
  const testRuns = ledger.filter((entry) => entry && entry.type === "TEST_RUN");
  const requiredTests = listValue(facts.testsRequired || facts.tests_required);

  if (requiredTests.length > 0 && testRuns.length === 0) {
    reasons.push("Required tests have no objective TEST_RUN recorded in Evidence Ledger");
  } else if (requiredTests.length > 0) {
    for (const req of requiredTests) {
      const reqCmd = String(req || "").trim();
      const reqFilterMatch = reqCmd.match(/--filter\s+([^\s]+)/);
      const reqFilter = reqFilterMatch ? reqFilterMatch[1].replace(/["']/g, "") : null;

      const matchingRun = testRuns.find((tr) => {
        const evCmd = String(tr.command || "").trim();
        const evFilterMatch = evCmd.match(/--filter\s+([^\s]+)/);
        const evFilter = evFilterMatch ? evFilterMatch[1].replace(/["']/g, "") : (tr.scope !== "GLOBAL" ? tr.scope : null);

        if (reqFilter && evFilter && reqFilter !== evFilter) return false;
        if (reqFilter && !evFilter && !evCmd.includes(reqFilter)) return false;

        return evCmd.includes(reqCmd) || reqCmd.includes(evCmd) || (reqFilter && evFilter === reqFilter);
      });

      if (!matchingRun) {
        reasons.push(`Required test "${reqCmd}" has no matching TEST_RUN recorded in Evidence Ledger`);
      } else if (matchingRun.exitCode !== 0 || (matchingRun.failed && matchingRun.failed > 0)) {
        reasons.push(`TEST_RUN for "${reqCmd}" failed with exitCode ${matchingRun.exitCode} (${matchingRun.failed} failed assertions)`);
      }
    }
  } else {
    for (const tr of testRuns) {
      if (tr.exitCode !== 0 || (tr.failed && tr.failed > 0)) {
        reasons.push(`TEST_RUN failed with exitCode ${tr.exitCode} (${tr.failed} failed assertions)`);
      }
    }
  }

  const eligible = reasons.length === 0;
  return {
    eligible,
    status: eligible ? "ACCEPTANCE_ELIGIBLE" : "EVIDENCE_INCOMPLETE",
    reasons,
  };
}

/* =========================================================================
   Review Route (ALL-GEMINI)
   ========================================================================= */

export function reviewRoute(facts = {}) {
  const currentAction = taskActionInfo(facts).action;

  const crossDomainRequest = crossDomainFacts(facts);
  if (crossDomainRequest) {
    return decorateRoute(
      flashOrchestrator("medium", "cross-domain-request", { crossDomainRequest }),
      facts,
    );
  }

  // Two-Key Critical Review evaluation
  if (facts.reviewerAVerdict || facts.reviewerBVerdict) {
    const evaluation = evaluateTwoKeyReview(facts, facts.reviewerAVerdict, facts.reviewerBVerdict);
    if (evaluation.humanGateRequired) {
      return decorateRoute(
        flashOrchestrator("medium", "two-key-review-disagreement", {
          state: "HUMAN_GATE",
          humanGate: true,
          reason: evaluation.reason,
          reviewerA: evaluation.reviewerA,
          reviewerB: evaluation.reviewerB,
        }),
        facts,
      );
    }
    if (evaluation.acceptable) {
      return decorateRoute(
        {
          kind: "done",
          reason: "two-key-review-accepted",
          independentReviewResult: evaluation.decision,
          ...(shouldExposeAcceptanceMetadata(facts) ? { acceptanceResult: "ACCEPTED" } : {}),
        },
        facts,
      );
    }
    return decorateRoute(
      flashOrchestrator("medium", "two-key-review-rejected", {
        acceptanceResult: evaluation.decision,
        nextState: evaluation.nextState,
        reviewerA: evaluation.reviewerA,
        reviewerB: evaluation.reviewerB,
      }),
      facts,
    );
  }

  const independentReviewResult = normalizeIndependentReviewResult(firstPresent(facts, [
    "independentReviewResult",
    "independent_review_result",
  ]));
  if (independentReviewResult === "CHANGES_REQUIRED" || independentReviewResult === "BLOCK") {
    return decorateRoute(
      flashOrchestrator("medium", "independent-review-changes-required", {
        acceptanceResult: independentReviewResult === "BLOCK" ? "REPLAN_REQUIRED" : "RETRY_REQUIRED",
        independentReviewResult,
      }),
      facts,
    );
  }

  const scopeValidation = scopeValidationForFacts(facts);
  if (!scopeValidation.valid) {
    const reportedViolations = scopeValidation.violations.length > 0
      ? scopeValidation.violations
      : (listValue(facts.scopeViolations ?? facts.scope_violations));
    return decorateRoute(
      flashOrchestrator("medium", "scope-violation", {
        scopeViolation: true,
        scopeExpansion: true,
        scopeViolations: reportedViolations,
        acceptanceResult: "REPLAN_REQUIRED",
      }),
      facts,
    );
  }

  if (isIncompleteWorkerResult(facts) && (currentAction === "IMPLEMENT" || facts.workerResult || facts.workerCompleted === false)) {
    const budget = createRetryBudget(facts);
    const exhausted = budget.remainingAttempts <= 0 || budget.attempt >= budget.maxAttempts;
    if (exhausted) {
      const extras = { attemptsExhausted: true, state: "HUMAN_GATE", humanGate: true };
      if (retryBudgetIsExplicit(facts)) {
        extras.retryBudget = budget;
        extras.attempt = budget.attempt;
        extras.remainingAttempts = 0;
      }
      return decorateRoute(flashOrchestrator("medium", "retry-budget-exhausted", extras), facts);
    }
    const retryReason = firstPresent(facts, ["retryReason", "retry_reason"]) ?? "incomplete-worker-result";
    const nextBudget = consumeRetryBudget(budget);
    const extras = { retry: true };
    if (retryBudgetIsExplicit(facts)) {
      extras.retryBudget = nextBudget;
      extras.attempt = nextBudget.attempt;
      extras.remainingAttempts = nextBudget.remainingAttempts;
      if (retryReason) extras.retryReason = retryReason;
    }
    return decorateRoute(
      implementationRoute({ ...facts, taskAction: "IMPLEMENT" }, "incomplete-worker-result", extras),
      facts,
    );
  }

  if (requiresIntegration(facts) && !integrationComplete(facts)) {
    if (individualAcceptancePassed(facts)) {
      return decorateRoute(
        flashWorker("high", "integration-required", { integrationRequired: true }),
        facts,
        { includeTaskDomain: !hasExplicitTaskDomain(facts) },
      );
    }
    return decorateRoute(
      flashOrchestrator("medium", "integration-gate-pending", { integrationRequired: true, acceptanceResult: "INTEGRATION_REQUIRED" }),
      facts,
    );
  }

  const acceptance = createAcceptanceGate(facts);
  if (acceptance.result === "ACCEPTED") {
    if (independentReviewResult === "ACCEPT" || independentReviewResult === "ACCEPT_WITH_NOTES") {
      return decorateRoute(
        {
          kind: "done",
          reason: "independent-review-accepted",
          independentReviewResult,
          ...(shouldExposeAcceptanceMetadata(facts) ? { acceptanceResult: "ACCEPTED" } : {}),
        },
        facts,
      );
    }
    if (independentReviewNeeded(facts)) {
      // For CRITICAL tasks, route to Two-Key Critical Review
      return decorateRoute(
        {
          kind: "two-key-review",
          modelReviewerA: GEMINI_MODELS.REVIEWER_A,
          modelReviewerB: GEMINI_MODELS.REVIEWER_B,
          criticality: normalizeCriticality(facts),
          independentReview: true,
          independentReviewModel: GEMINI_MODELS.WORKER_HIGH,
          reason: "critical-two-key-review",
        },
        facts,
      );
    }
    return decorateRoute({
      kind: "done",
      reason: "acceptance-passed",
      ...(shouldExposeAcceptanceMetadata(facts) ? { acceptanceResult: "ACCEPTED" } : {}),
    }, facts);
  }

  if (workerResultComplete(facts) || [
    "acceptanceCriteriaStatus",
    "acceptanceStatus",
    "criteriaStatus",
    "acceptanceState",
    "acceptance_state",
    "acceptanceResult",
    "acceptance_result",
  ].some((key) => facts[key] !== undefined)) {
    return decorateRoute(
      flashOrchestrator("medium", "acceptance-required", { acceptanceResult: acceptance.result }),
      facts,
    );
  }

  if (facts.objectiveGate && objectiveGateRoutes[facts.objectiveGate]) {
    return decorateRoute(objectiveGateRoutes[facts.objectiveGate](), facts);
  }

  if (facts.evidence === "conflicting" && facts.architecturalImpact) {
    return decorateRoute(flashInvestigator("high", "conflicting-architecture-evidence"), facts);
  }

  if (facts.deepInvestigationComplete && facts.decisionResolved === false) {
    return decorateRoute(flashOrchestrator("medium", "deep-investigation-unresolved", { state: "HUMAN_GATE", humanGate: true }), facts);
  }

  if (facts.decisionResolved && facts.nextTaskAction !== undefined) {
    const next = nextActionFacts(facts, facts.nextTaskAction);
    if (facts.investigationComplete === true || facts.deepInvestigationComplete === true) next.postInvestigation = true;
    return decideRoute(next);
  }

  if (facts.decisionResolved && facts.nextTaskClass) {
    const next = nextActionFacts(facts, undefined, facts.nextTaskClass);
    if (facts.investigationComplete === true || facts.deepInvestigationComplete === true) next.postInvestigation = true;
    return decideRoute(next);
  }

  return decorateRoute(flashOrchestrator("medium", "review-needs-orchestration"), facts);
}

/* =========================================================================
   Direct Write Boundary Policy
   ========================================================================= */

const normalizeOwnership = (facts = {}) => normalizeToken(firstPresent(facts, ["workOwnership", "ownership"]));
const productAction = new Set(["IMPLEMENT", "TEST"]);

function isProductWork(facts = {}, action = taskActionInfo(facts).action) {
  if (facts.productWork === true || facts.isProductWork === true || facts.productImplementation === true || facts.isProductImplementation === true) return true;
  if (productAction.has(action)) return true;
  return action === "MECHANICAL_FIX" && facts.productWork !== false && facts.productImplementation !== false;
}

export function directWriteDecision(facts = {}) {
  const info = taskActionInfo(facts);
  const action = info.action;
  const productWork = isProductWork(facts, action);
  const ownership = normalizeOwnership(facts);
  const explicitControlPlane = facts.controlPlaneWork === true || facts.controlPlane === true || ownership === "CONTROL_PLANE";

  if (explicitControlPlane && !productWork) {
    return { allowed: true, reason: "control-plane" };
  }

  if (action === "IMPLEMENT") {
    return { allowed: false, reason: "product-implementation-requires-worker" };
  }

  if (productWork) {
    return { allowed: false, reason: "product-work-requires-worker" };
  }

  if (!action || action === "UNKNOWN") {
    return { allowed: false, reason: "unclassified-action-requires-worker" };
  }

  const exception = normalizeToken(firstPresent(facts, ["directWriteException", "writeException"]));
  const mechanicalTrivial = facts.mechanicalTrivial === true;
  const filesChanged = firstPresent(facts, ["filesChanged", "changedFiles", "fileCount", "files"]);
  const changedLines = firstPresent(facts, ["changedLines", "linesChanged", "lineCount", "lines"]);
  const thresholdSatisfied = (exception === "MECHANICAL_TRIVIAL" || mechanicalTrivial)
    && action === "MECHANICAL_FIX"
    && facts.productWork === false
    && facts.productImplementation !== true
    && Number.isInteger(filesChanged)
    && filesChanged >= 0
    && filesChanged <= 1
    && Number.isInteger(changedLines)
    && changedLines >= 0
    && changedLines <= 3
    && facts.deterministic === true
    && facts.behavioralChange === false
    && facts.technicalDecision === false;

  if (thresholdSatisfied) {
    return { allowed: true, reason: "mechanical-trivial-threshold" };
  }

  if (exception === "MECHANICAL_TRIVIAL" || mechanicalTrivial) {
    return { allowed: false, reason: "direct-write-exception-threshold" };
  }

  return { allowed: false, reason: "direct-write-not-authorized" };
}

/* =========================================================================
   Handoff & Snapshot Builders
   ========================================================================= */

function requiredHandoffValue(details, field, aliases = []) {
  const value = firstPresent(details, [field, ...aliases]);
  if (value === undefined || value === null || value === "") {
    throw new Error(`IMPLEMENTATION HANDOFF requires ${field}`);
  }
  return value;
}

export function createImplementationHandoff(details = {}) {
  const task = requiredHandoffValue(details, "task", ["TASK"]);
  const goal = requiredHandoffValue(details, "goal", ["GOAL"]);
  const rootCauseDecision = requiredHandoffValue(details, "rootCauseDecision", ["rootCause", "ROOT_CAUSE_DECISION"]);
  const filesAreas = requiredHandoffValue(details, "filesAreas", ["files", "FILES_AREAS"]);
  const constraints = requiredHandoffValue(details, "constraints", ["CONSTRAINTS"]);
  const implementationPlan = requiredHandoffValue(details, "implementationPlan", ["plan", "IMPLEMENTATION_PLAN"]);
  const acceptanceCriteria = requiredHandoffValue(details, "acceptanceCriteria", ["ACCEPTANCE_CRITERIA"]);
  const testsBenchmarksRequired = requiredHandoffValue(details, "testsBenchmarksRequired", ["tests", "TESTS_BENCHMARKS_REQUIRED"]);
  const doNotChange = requiredHandoffValue(details, "doNotChange", ["DO_NOT_CHANGE"]);
  const complexity = implementationComplexity(details);
  const taskDomain = normalizeTaskDomain(details);

  const isSimple = complexity === "simple" || taskDomain === "DOCS";
  const isDifficult = complexity === "difficult" || complexity === "experimental";
  const workerModel = isSimple ? GEMINI_MODELS.WORKER_LOW : (isDifficult ? GEMINI_MODELS.WORKER_HIGH : GEMINI_MODELS.WORKER_MEDIUM);
  const workerName = isSimple ? "flash-low-worker" : (isDifficult ? "flash-worker" : "flash-medium-worker");

  const inferredAllowedPaths = listValue(filesAreas).filter((value) => (
    typeof value === "string" && (value.includes("/") || value.includes("\\") || value.includes("**"))
  ));
  const inferredForbiddenPaths = listValue(doNotChange).filter((value) => (
    typeof value === "string" && (value.includes("/") || value.includes("\\") || value.includes("**"))
  ));
  const scopeContract = createScopeContract({
    ...details,
    taskAction: "IMPLEMENT",
    taskDomain,
    allowedPaths: firstPresent(details, ["allowedPaths", "allowedScope", "allowed_paths"]) ?? inferredAllowedPaths,
    forbiddenPaths: firstPresent(details, ["forbiddenPaths", "forbiddenScope", "forbidden_paths"]) ?? inferredForbiddenPaths,
    acceptanceCriteria,
    testsRequired: testsBenchmarksRequired,
    doNotChange,
    implementationPlan,
  });
  const retryBudget = createRetryBudget({
    ...details,
    retryBudget: firstPresent(details, ["retryBudget"]) ?? scopeContract.retryBudget,
  });

  return {
    kind: "implementation-handoff",
    taskAction: "IMPLEMENT",
    taskDomain,
    executor: "flash",
    worker: workerName,
    model: workerModel,
    effort: isDifficult ? "high" : (isSimple ? "low" : "medium"),
    task,
    goal,
    rootCauseDecision,
    filesAreas,
    constraints,
    implementationPlan,
    acceptanceCriteria,
    testsBenchmarksRequired,
    doNotChange,
    scopeContract,
    allowedPaths: scopeContract.allowedPaths,
    forbiddenPaths: scopeContract.forbiddenPaths,
    retryBudget,
    attempt: retryBudget.attempt,
    remainingAttempts: retryBudget.remainingAttempts,
    criticality: normalizeCriticality(details),
    stopConditions: scopeContract.stopConditions,
  };
}

const SNAPSHOT_FIELDS = Object.freeze([
  "id",
  "objective",
  "class",
  "taskAction",
  "taskDomain",
  "state",
  "pendingTasks",
  "completedTasks",
  "decisions",
  "openHypotheses",
  "discardedHypotheses",
  "evidence",
  "evidenceLedger",
  "tests",
  "blockers",
  "relevantFiles",
  "acceptanceCriteria",
  "lastHandoff",
  "escalationState",
  "scopeContract",
  "retryBudget",
  "attempt",
  "criticality",
  "acceptanceState",
  "integrationState",
  "crossDomainRequests",
]);

const SNAPSHOT_ALIASES = Object.freeze({
  taskAction: "task_action",
  taskDomain: "task_domain",
  evidenceLedger: "evidence_ledger",
  pendingTasks: "pending_tasks",
  completedTasks: "completed_tasks",
  openHypotheses: "open_hypotheses",
  discardedHypotheses: "discarded_hypotheses",
  relevantFiles: "relevant_files",
  acceptanceCriteria: "acceptance_criteria",
  lastHandoff: "last_handoff",
  escalationState: "escalation_state",
  retryBudget: "retry_budget",
  acceptanceState: "acceptance_state",
  integrationState: "integration_state",
  crossDomainRequests: "cross_domain_requests",
});

export function createStateSnapshot(state = {}) {
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    const value = firstPresent(state, [field, SNAPSHOT_ALIASES[field]]);
    if (value === undefined) continue;
    if (field === "taskAction") snapshot[field] = normalizeTaskAction({ taskAction: value });
    else if (field === "taskDomain") snapshot[field] = normalizeTaskDomain({ taskDomain: value });
    else if (field === "criticality") snapshot[field] = normalizeCriticality({ criticality: value });
    else snapshot[field] = value;
  }
  return snapshot;
}

export const snapshotState = createStateSnapshot;

export function updateStateSnapshot(previous = {}, changes = {}) {
  return createStateSnapshot({ ...previous, ...changes });
}

/* =========================================================================
   Telemetry & Observability
   ========================================================================= */

function normalizeExecutor(value) {
  const token = normalizeToken(value);
  if (token.includes("FLASH") || token.includes("WORKER") || token.includes("LUNA")) return "flash";
  if (token.includes("ORCHESTRATOR") || token.includes("TERRA")) return "flash-orchestrator";
  return null;
}

function telemetryValue(facts, snake, camel) {
  return firstPresent(facts, [snake, camel]);
}

function canonicalAcceptanceResult(value) {
  const token = normalizeToken(value);
  if (["ACCEPTED", "ACCEPT", "PASSED", "PASS", "DONE"].includes(token)) return "ACCEPTED";
  if (["RETRY_REQUIRED", "RETRY", "REWORK", "CHANGES_REQUIRED"].includes(token)) return "RETRY_REQUIRED";
  if (["REPLAN_REQUIRED", "REPLAN"].includes(token)) return "REPLAN_REQUIRED";
  if (["INTEGRATION_REQUIRED", "INTEGRATE"].includes(token)) return "INTEGRATION_REQUIRED";
  if (["HUMAN_GATE", "HUMAN_GATE_REQUIRED"].includes(token)) return "HUMAN_GATE";
  if (["REVIEW_REQUIRED", "REVIEW", "PENDING"].includes(token)) return "REVIEW_REQUIRED";
  return value ?? null;
}

function canonicalIntegrationResult(value) {
  const token = normalizeToken(value);
  if (["ACCEPTED", "ACCEPT", "PASSED", "PASS", "COMPLETE", "COMPLETED"].includes(token)) return "ACCEPTED";
  if (["FAILED", "FAIL", "BLOCKED", "CHANGES_REQUIRED"].includes(token)) return "CHANGES_REQUIRED";
  if (["REQUIRED", "PENDING", "IN_PROGRESS"].includes(token)) return "REQUIRED";
  if (["NOT_REQUIRED", "NONE", "SKIPPED"].includes(token)) return "NOT_REQUIRED";
  return value ?? null;
}

export function createTelemetryEvent(input = {}, maybeDecision) {
  const facts = input.facts && typeof input.facts === "object" ? input.facts : input;
  const decision = input.facts ? (input.decision ?? maybeDecision ?? decideRoute(facts)) : (maybeDecision ?? decideRoute(facts));
  const action = taskActionInfo(facts).action ?? "UNKNOWN";
  const explicitExecutor = normalizeExecutor(telemetryValue(facts, "implementation_executor", "implementationExecutor"));
  const routeExecutor = action === "IMPLEMENT" ? "flash" : null;
  const implementationExecutor = explicitExecutor ?? routeExecutor;
  const directAttempt = facts.orchestratorDirectWrite === true
    || facts.orchestrator_direct_write === true
    || facts.directWriteAttempted === true
    || facts.direct_write === true
    || (action === "IMPLEMENT" && implementationExecutor === "flash-orchestrator");
  const directDecision = directWriteDecision(facts);
  const directWriteReason = directAttempt
    ? (telemetryValue(facts, "direct_write_reason", "directWriteReason") ?? directDecision.reason)
    : null;
  const model = decision.model ?? telemetryValue(facts, "model", "model");
  const effort = decision.effort ?? telemetryValue(facts, "reasoning_effort", "reasoningEffort");
  const retryBudget = createRetryBudget(facts);
  const rawRetryBudget = telemetryValue(facts, "retry_budget", "retryBudget");
  const retryBudgetTelemetry = rawRetryBudget && typeof rawRetryBudget === "object"
    ? {
      max_attempts: retryBudget.maxAttempts,
      attempt: retryBudget.attempt,
      remaining_attempts: retryBudget.remainingAttempts,
    }
    : (rawRetryBudget ?? retryBudget.maxAttempts);
  const scopeValidation = scopeValidationForFacts(facts);
  const crossDomainRequest = crossDomainFacts(facts)
    ?? (Array.isArray(facts.crossDomainRequests) && facts.crossDomainRequests.length > 0
      ? { type: CROSS_DOMAIN_REQUEST }
      : null);
  const acceptanceResult = canonicalAcceptanceResult(
    telemetryValue(facts, "acceptance_result", "acceptanceResult")
      ?? telemetryValue(facts, "acceptance_state", "acceptanceState")
      ?? (facts.acceptanceCriteriaStatus === "passed" ? "ACCEPTED" : null),
  );
  const integrationRequired = requiresIntegration(facts);
  const integrationResult = canonicalIntegrationResult(
    telemetryValue(facts, "integration_result", "integrationResult")
      ?? telemetryValue(facts, "integration_state", "integrationState"),
  );
  const independentReviewModel = telemetryValue(facts, "independent_review_model", "independentReviewModel")
    ?? (decision.independentReview === true ? decision.model : null)
    ?? (normalizeCriticality(facts) === "CRITICAL" ? GEMINI_MODELS.REVIEWER_A : null);
  const independentReviewResult = normalizeIndependentReviewResult(telemetryValue(facts, "independent_review_result", "independentReviewResult"));

  const requestedAgent = telemetryValue(facts, "requested_agent", "requestedAgent")
    ?? (decision.executor === "flash" ? (decision.effort === "low" ? "flash-low-worker" : (decision.effort === "high" ? "flash-worker" : "flash-medium-worker"))
      : (decision.executor === "flash-orchestrator" ? "flash-orchestrator"
      : (decision.executor === "flash-specialist" ? "flash-worker" : "flash-reviewer")));

  const requestedTier = telemetryValue(facts, "requested_tier", "requestedTier")
    ?? (decision.tier ?? "flash");

  const configuredModel = telemetryValue(facts, "configured_model", "configuredModel")
    ?? decision.model
    ?? model
    ?? null;

  const rawActualRuntimeModel = telemetryValue(facts, "actual_runtime_model", "actualRuntimeModel")
    ?? telemetryValue(facts, "model_name", "modelName");
  const hasExplicitObservable = telemetryValue(facts, "runtime_model_observable", "runtimeModelObservable");
  const isRuntimeModelObservable = hasExplicitObservable !== undefined
    ? Boolean(hasExplicitObservable)
    : Boolean(rawActualRuntimeModel && rawActualRuntimeModel !== "auto");
  const actualRuntimeModel = isRuntimeModelObservable && rawActualRuntimeModel && rawActualRuntimeModel !== "auto"
    ? rawActualRuntimeModel
    : null;

  return {
    task_id: telemetryValue(facts, "task_id", "taskId") ?? null,
    task_class: telemetryValue(facts, "task_class", "taskClass") ?? null,
    task_action: action,
    model: model ?? null,
    reasoning_effort: effort ?? null,
    routing_decision: decision.kind ?? null,
    routing_reason: decision.reason ?? null,
    previous_model: telemetryValue(facts, "previous_model", "previousModel") ?? null,
    retries: telemetryValue(facts, "retries", "retryCount") ?? null,
    escalation: telemetryValue(facts, "escalation", "isEscalation") ?? null,
    escalation_reason: telemetryValue(facts, "escalation_reason", "escalationReason") ?? null,
    fallback: telemetryValue(facts, "fallback", "isFallback") ?? null,
    fallback_reason: telemetryValue(facts, "fallback_reason", "fallbackReason") ?? null,
    duration: telemetryValue(facts, "duration", "durationMs") ?? null,
    input_tokens: telemetryValue(facts, "input_tokens", "inputTokens") ?? null,
    cached_tokens: telemetryValue(facts, "cached_tokens", "cachedTokens") ?? null,
    output_tokens: telemetryValue(facts, "output_tokens", "outputTokens") ?? null,
    reasoning_tokens: telemetryValue(facts, "reasoning_tokens", "reasoningTokens") ?? null,
    result: telemetryValue(facts, "result", "result") ?? null,
    success: telemetryValue(facts, "success", "success") ?? null,
    acceptance_criteria_status: telemetryValue(facts, "acceptance_criteria_status", "acceptanceCriteriaStatus") ?? null,
    estimated_cost: telemetryValue(facts, "estimated_cost", "estimatedCost") ?? null,
    actual_cost: telemetryValue(facts, "actual_cost", "actualCost") ?? null,
    implementation_executor: implementationExecutor,
    orchestrator_direct_write: directAttempt,
    direct_write_reason: directWriteReason,
    worker_model: model ?? null,
    worker_effort: effort ?? null,
    task_domain: normalizeTaskDomain(facts),
    scope_violation: scopeValidation.scopeViolation,
    cross_domain_request: Boolean(crossDomainRequest),
    retry_budget: retryBudgetTelemetry,
    retry_budget_state: {
      max_attempts: retryBudget.maxAttempts,
      attempt: retryBudget.attempt,
      remaining_attempts: retryBudget.remainingAttempts,
    },
    attempt_number: retryBudget.attempt,
    attempts_exhausted: facts.attemptsExhausted === true
      || facts.attempts_exhausted === true
      || retryBudget.remainingAttempts === 0,
    acceptance_result: acceptanceResult,
    integration_required: integrationRequired,
    integration_result: integrationResult,
    criticality: normalizeCriticality(facts),
    independent_review_model: independentReviewModel,
    independent_review_result: independentReviewResult,
    requested_agent: requestedAgent,
    requested_tier: requestedTier,
    configured_model: configuredModel,
    actual_runtime_model: actualRuntimeModel,
    runtime_model_observable: isRuntimeModelObservable,
  };
}

export function summarizePolicyDrift(events = []) {
  let totalImplementations = 0;
  let flashImplementations = 0;
  let orchestratorDirectImplementations = 0;
  let unknownImplementations = 0;
  let retryEvents = 0;
  let crossDomainEvents = 0;
  let integrationEvents = 0;
  const criticalityCounts = { NORMAL: 0, MAJOR: 0, CRITICAL: 0 };
  const retriesByDomain = {};
  const crossDomainByDomain = {};
  const implementationsByDomain = {};
  const actionDomainRoutes = {};
  const acceptanceResults = {};
  const integrationResults = {};
  const independentReviewResults = {};
  let acceptedAttemptTotal = 0;
  let acceptedAttemptCount = 0;

  for (const event of events) {
    const rawAction = event.task_action ?? event.taskAction ?? event.action;
    const action = rawAction !== undefined
      ? canonicalAction(rawAction)
      : LEGACY_TASK_CLASS_ACTIONS[normalizeToken(event.task_class ?? event.taskClass)] ?? "UNKNOWN";
    const domain = canonicalTaskDomain(event.task_domain ?? event.taskDomain ?? event.domain);
    const actionDomainKey = `${action}+${domain}`;
    actionDomainRoutes[actionDomainKey] = (actionDomainRoutes[actionDomainKey] ?? 0) + 1;
    if (Boolean(event.cross_domain_request || event.crossDomainRequest)) {
      crossDomainEvents += 1;
      crossDomainByDomain[domain] = (crossDomainByDomain[domain] ?? 0) + 1;
    }
    if (event.integration_required === true || event.integrationRequired === true) integrationEvents += 1;
    const acceptanceResult = canonicalAcceptanceResult(event.acceptance_result ?? event.acceptanceResult);
    if (acceptanceResult) acceptanceResults[acceptanceResult] = (acceptanceResults[acceptanceResult] ?? 0) + 1;
    const integrationResult = canonicalIntegrationResult(event.integration_result ?? event.integrationResult);
    if (integrationResult) integrationResults[integrationResult] = (integrationResults[integrationResult] ?? 0) + 1;
    const independentReviewResult = normalizeIndependentReviewResult(event.independent_review_result ?? event.independentReviewResult);
    if (independentReviewResult) independentReviewResults[independentReviewResult] = (independentReviewResults[independentReviewResult] ?? 0) + 1;
    if (acceptanceResult === "ACCEPTED") {
      const acceptedAttempt = event.attempt_number ?? event.attemptNumber;
      if (Number.isInteger(acceptedAttempt)) {
        acceptedAttemptTotal += acceptedAttempt;
        acceptedAttemptCount += 1;
      }
    }
    const criticality = normalizeCriticality(event);
    criticalityCounts[criticality] += 1;
    const retries = event.retries ?? event.retryCount ?? event.attempt_number ?? event.attemptNumber;
    if ((Number.isInteger(retries) && retries > 0) || event.retry === true) {
      retryEvents += 1;
      retriesByDomain[domain] = (retriesByDomain[domain] ?? 0) + 1;
    }
    if (action !== "IMPLEMENT") continue;
    totalImplementations += 1;
    implementationsByDomain[domain] = (implementationsByDomain[domain] ?? 0) + 1;
    const executor = normalizeExecutor(event.implementation_executor ?? event.implementationExecutor);
    if (executor === "flash") flashImplementations += 1;
    else if (executor === "flash-orchestrator") orchestratorDirectImplementations += 1;
    else unknownImplementations += 1;
  }

  const flashRate = totalImplementations === 0 ? 0 : flashImplementations / totalImplementations;
  const orchestratorRate = totalImplementations === 0 ? 0 : orchestratorDirectImplementations / totalImplementations;
  const drift = totalImplementations > 0 && (flashRate <= 0.85 || orchestratorRate >= 0.10);
  const summary = {
    total_implementations: totalImplementations,
    flash_implementations: flashImplementations,
    luna_implementations: flashImplementations,
    orchestrator_direct_implementations: orchestratorRate,
    terra_direct_implementations: orchestratorRate,
    unknown_implementations: unknownImplementations,
    flash_implementation_rate: flashRate,
    luna_implementation_rate: flashRate,
    orchestrator_direct_implementation_rate: orchestratorRate,
    health_targets: {
      flash_implementation_rate: ">0.85",
      orchestrator_direct_implementation_rate: "<0.10",
    },
    policy_drift: drift,
    status: drift ? "ORCHESTRATION_POLICY_DRIFT" : (totalImplementations === 0 ? "NO_DATA" : "HEALTHY"),
    retries_total: retryEvents,
    retries_by_domain: retriesByDomain,
    cross_domain_requests: crossDomainEvents,
    cross_domain_requests_by_domain: crossDomainByDomain,
    integration_required_count: integrationEvents,
    criticality_counts: criticalityCounts,
    implementations_by_domain: implementationsByDomain,
    action_domain_routes: actionDomainRoutes,
    acceptance_results: acceptanceResults,
    integration_results: integrationResults,
    independent_review_results: independentReviewResults,
    average_attempts_before_acceptance: acceptedAttemptCount === 0 ? null : acceptedAttemptTotal / acceptedAttemptCount,
  };

  if (drift) {
    summary.diagnostic = "ORCHESTRATION_POLICY_DRIFT";
  }
  return summary;
}

export function createUnresolvedDecisionPacket(details = {}) {
  const required = [
    "problem",
    "options",
    "evidence",
    "attempts",
    "risks",
    "unresolvedQuestion",
    "recommendedNextExperiment",
  ];

  for (const field of required) {
    if (details[field] === undefined || details[field] === "") {
      throw new Error(`UNRESOLVED DECISION PACKET requires ${field}`);
    }
  }

  return {
    type: "UNRESOLVED_DECISION_PACKET",
    action: "human-gate-required",
    state: "HUMAN_GATE",
    ...details,
  };
}

export const createAstraEscalationPacket = (details = {}) => {
  return createUnresolvedDecisionPacket({
    problem: details.problem || "unresolved decision",
    options: details.hypotheses || ["option A", "option B"],
    evidence: details.evidence || [],
    attempts: details.attempts || [],
    risks: details.risk || details.risks || "unresolved regression",
    unresolvedQuestion: details.question || details.unresolvedQuestion || "How to resolve?",
    recommendedNextExperiment: details.expectedResult || details.recommendedNextExperiment || "Verify invariant",
    ...details,
  });
};

export function decideAntigravityRoute(facts = {}) {
  return decideRoute(facts);
}

export function reviewAntigravityRoute(facts = {}) {
  return reviewRoute(facts);
}

export function getProgressiveTestStage(facts = {}) {
  const criticality = normalizeCriticality(facts);
  if (
    criticality === "CRITICAL" ||
    criticality === "MAJOR" ||
    facts.fullSuite === true ||
    facts.release === true ||
    facts.stage === 4 ||
    facts.testStage === "STAGE_4"
  ) {
    return PROGRESSIVE_TEST_STAGES.STAGE_4_FULL_SUITE;
  }
  if (
    facts.integration === true ||
    facts.isIntegration === true ||
    requiresIntegration(facts) ||
    facts.stage === 3 ||
    facts.testStage === "STAGE_3"
  ) {
    return PROGRESSIVE_TEST_STAGES.STAGE_3_INTEGRATION;
  }
  if (
    facts.domainTest === true ||
    facts.packageTest === true ||
    facts.stage === 2 ||
    facts.testStage === "STAGE_2"
  ) {
    return PROGRESSIVE_TEST_STAGES.STAGE_2_DOMAIN_PACKAGE;
  }
  return PROGRESSIVE_TEST_STAGES.STAGE_1_AFFECTED;
}

export function createDeltaRetryPacket(details = {}) {
  const required = ["failedOrMissing", "requiredCorrection", "retryReason"];
  for (const field of required) {
    if (!details[field]) {
      throw new Error(`DELTA RETRY PACKET requires ${field}`);
    }
  }
  const budget = details.retryBudget ? consumeRetryBudget(details.retryBudget) : undefined;
  return {
    type: "DELTA_RETRY",
    basePlan: "unchanged",
    failedOrMissing: details.failedOrMissing,
    newEvidence: details.newEvidence || null,
    requiredCorrection: details.requiredCorrection,
    preserve: details.preserve || "all passed functionality and tests",
    remainingAcceptance: details.remainingAcceptance || [],
    retryReason: details.retryReason,
    retryBudget: budget,
    attempt: budget ? budget.attempt : details.attempt,
    remainingAttempts: budget ? budget.remainingAttempts : details.remainingAttempts,
  };
}

export const createOpusReviewPacket = (details = {}) => {
  return createTwoKeyReviewPacket({
    goal: details.goal,
    acceptanceCriteria: details.acceptanceCriteria,
    technicalDecision: details.technicalDecision || details.decision,
    diff: details.relevantDiff || details.diff,
    tests: details.testEvidence || details.tests,
    risks: details.knownRisks || details.risks,
  });
};

/* =========================================================================
   Circuit Breakers (Loop, Stalled, Overhead, Bloat)
   ========================================================================= */

export function detectCoordinationOverhead(facts = {}, thresholds = {}) {
  const maxRetries = thresholds.maxRetries ?? CIRCUIT_BREAKER_THRESHOLDS.maxRepeatedRetryReasons;
  const maxCalls = thresholds.maxCalls ?? CIRCUIT_BREAKER_THRESHOLDS.maxOrchestratorCalls;
  const retries = Number.isInteger(facts.retries) ? facts.retries : (facts.attempt ?? 0);
  const calls = Number.isInteger(facts.totalCalls) ? facts.totalCalls : (facts.modelCalls ?? 0);
  const repeatedReason = facts.repeatedRetryReason === true || facts.consecutiveSameFailure === true;

  const reasons = [];
  if (retries > maxRetries) {
    reasons.push(`Retry count (${retries}) exceeds threshold (${maxRetries})`);
  }
  if (calls > maxCalls) {
    reasons.push(`Coordination model calls (${calls}) exceed threshold (${maxCalls})`);
  }
  if (repeatedReason) {
    reasons.push("Repeated retry with identical root cause detected");
  }

  const detected = reasons.length > 0;
  return {
    detected,
    diagnostic: detected ? "COORDINATION_OVERHEAD" : null,
    reasons,
  };
}

export function detectContextBloat(payload = {}, thresholds = {}) {
  const maxChars = thresholds.maxChars ?? CIRCUIT_BREAKER_THRESHOLDS.maxContextChars;
  const maxLines = thresholds.maxLines ?? CIRCUIT_BREAKER_THRESHOLDS.maxContextLines;
  const str = typeof payload === "string" ? payload : JSON.stringify(payload);
  const lineCount = str.split("\n").length;
  const charCount = str.length;

  const reasons = [];
  if (charCount > maxChars) {
    reasons.push(`Context size (${charCount} chars) exceeds threshold (${maxChars})`);
  }
  if (lineCount > maxLines) {
    reasons.push(`Context lines (${lineCount}) exceed threshold (${maxLines})`);
  }
  if (typeof payload === "object" && (payload.fullTranscript || payload.rawLogs || payload.historyDump)) {
    reasons.push("Unsummarized raw conversation history or logs included in handoff");
  }

  const detected = reasons.length > 0;
  return {
    detected,
    diagnostic: detected ? "CONTEXT_BLOAT" : null,
    charCount,
    lineCount,
    reasons,
  };
}

export function checkLoopCircuitBreakers(history = [], currentState, thresholds = {}) {
  const maxFileReads = thresholds.maxFileReads ?? CIRCUIT_BREAKER_THRESHOLDS.maxFileReadsWithoutStateChange;
  const maxSameTools = thresholds.maxSameTools ?? CIRCUIT_BREAKER_THRESHOLDS.maxConsecutiveSameToolCalls;

  if (!Array.isArray(history) || history.length === 0) {
    return { tripped: false, reason: null, type: null };
  }

  // Check 1: Same file read repeatedly without state change
  let fileReadCount = 0;
  let lastReadFile = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.tool === "view_file") {
      if (!lastReadFile) lastReadFile = item.path;
      if (item.path === lastReadFile && item.state === currentState) {
        fileReadCount++;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  if (fileReadCount >= maxFileReads) {
    return {
      tripped: true,
      type: "LOOP_SUSPECTED",
      reason: `File "${lastReadFile}" read ${fileReadCount} times consecutively without state transition.`,
    };
  }

  // Check 2: Same tool + target repeated (STALLED)
  let sameToolCount = 0;
  let lastToolKey = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const key = `${item.tool}:${item.target || ""}`;
    if (!lastToolKey) lastToolKey = key;
    if (key === lastToolKey) {
      sameToolCount++;
    } else {
      break;
    }
  }
  if (sameToolCount >= maxSameTools) {
    return {
      tripped: true,
      type: "STALLED",
      reason: `Tool execution "${lastToolKey}" repeated ${sameToolCount} times without behavioral progress.`,
    };
  }

  return { tripped: false, reason: null, type: null };
}

export function calculateEfficiencyMetrics(events = []) {
  let orchestratorCalls = 0;
  let workerCalls = 0;
  let reviewCalls = 0;
  let retryCalls = 0;
  let acceptedTasks = 0;
  let acceptedOnFirstPass = 0;
  let humanGateCalls = 0;
  let loopBreakerCalls = 0;
  let totalTokens = { input: 0, cached: 0, output: 0, reasoning: 0 };

  for (const ev of events) {
    const action = ev.task_action || ev.taskAction || "";
    const kind = ev.routing_decision || ev.kind || "";
    if (kind === "orchestration" || action === "ORCHESTRATE" || action === "INVESTIGATE") {
      orchestratorCalls += 1;
    } else if (kind === "worker" || action === "IMPLEMENT" || action === "TEST") {
      workerCalls += 1;
    }
    if (action === "REVIEW" || ev.independent_review_result || ev.two_key_review) {
      reviewCalls += 1;
    }
    if (ev.retry === true || (ev.retries && ev.retries > 0) || (ev.attempt_number && ev.attempt_number > 1)) {
      retryCalls += 1;
    }
    if (ev.acceptance_result === "ACCEPTED" || ev.result === "PASSED") {
      acceptedTasks += 1;
      if (!ev.retries && (!ev.attempt_number || ev.attempt_number <= 1)) {
        acceptedOnFirstPass += 1;
      }
    }
    if (ev.human_gate || ev.state === "HUMAN_GATE") humanGateCalls += 1;
    if (ev.loop_breaker) loopBreakerCalls += 1;
    if (ev.input_tokens) totalTokens.input += ev.input_tokens;
    if (ev.cached_tokens) totalTokens.cached += ev.cached_tokens;
    if (ev.output_tokens) totalTokens.output += ev.output_tokens;
    if (ev.reasoning_tokens) totalTokens.reasoning += ev.reasoning_tokens;
  }

  const totalCalls = events.length;
  const callsPerAccepted = acceptedTasks > 0 ? totalCalls / acceptedTasks : totalCalls;
  const retriesPerAccepted = acceptedTasks > 0 ? retryCalls / acceptedTasks : retryCalls;
  const firstPassRate = acceptedTasks > 0 ? acceptedOnFirstPass / acceptedTasks : 0;
  const usefulWorkRatio = totalCalls > 0 ? acceptedTasks / totalCalls : 0;
  const humanGateRate = totalCalls > 0 ? humanGateCalls / totalCalls : 0;
  const loopBreakerRate = totalCalls > 0 ? loopBreakerCalls / totalCalls : 0;

  return {
    total_model_calls: totalCalls,
    orchestrator_calls: orchestratorCalls,
    worker_calls: workerCalls,
    review_calls: reviewCalls,
    retry_calls: retryCalls,
    accepted_tasks: acceptedTasks,
    accepted_on_first_pass: acceptedOnFirstPass,
    calls_per_accepted_task: Number(callsPerAccepted.toFixed(2)),
    retries_per_accepted_task: Number(retriesPerAccepted.toFixed(2)),
    first_pass_acceptance_rate: Number(firstPassRate.toFixed(2)),
    useful_work_ratio: Number(usefulWorkRatio.toFixed(2)),
    human_gate_rate: Number(humanGateRate.toFixed(2)),
    loop_breaker_rate: Number(loopBreakerRate.toFixed(2)),
    tokens: totalTokens,
  };
}

export function formatTestResultSummary(output) {
  if (!output) return "0 passed / 0 failed";
  if (typeof output === "object") {
    const passed = output.passed ?? output.pass ?? 0;
    const failed = output.failed ?? output.fail ?? 0;
    if (failed === 0) {
      return `${passed} passed / 0 failed`;
    }
    const failureSnippet = output.errors ? output.errors.slice(0, 3).join("\n") : "Test suite encountered failures";
    return `FAIL: ${passed} passed / ${failed} failed\n${failureSnippet}`;
  }
  const text = String(output);
  const passMatch = text.match(/(?:pass(?:ed)?\s*(\d+)|(\d+)\s*pass(?:ed)?)/i);
  const failMatch = text.match(/(?:fail(?:ed)?\s*(\d+)|(\d+)\s*fail(?:ed)?)/i);
  const passedCount = passMatch ? parseInt(passMatch[1] || passMatch[2], 10) : 0;
  const failedCount = failMatch ? parseInt(failMatch[1] || failMatch[2], 10) : 0;
  if (failedCount === 0 && passedCount > 0) {
    return `${passedCount} passed / 0 failed`;
  }
  if (failedCount > 0) {
    const lines = text.split("\n").filter((l) => l.includes("FAIL") || l.includes("Error:") || l.includes("AssertionError"));
    return `FAIL: ${passedCount} passed / ${failedCount} failed\n${lines.slice(0, 3).join("\n")}`;
  }
  return text.slice(0, 200);
}

/* =========================================================================
   Shell Parser & Redirection Scanner
   ========================================================================= */

export function extractRealShellRedirections(commandLine) {
  if (!commandLine || typeof commandLine !== "string") {
    return { hasRedirection: false, targets: [], rawRedirections: [] };
  }

  const targets = [];
  const rawRedirections = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let isEscaped = false;
  let arithmeticDepth = 0;

  const len = commandLine.length;
  let i = 0;

  while (i < len) {
    const ch = commandLine[i];

    if (isEscaped) {
      isEscaped = false;
      i++;
      continue;
    }

    if (ch === "\\" && !inSingleQuote) {
      isEscaped = true;
      i++;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && arithmeticDepth === 0) {
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }

    if (ch === '"' && !inSingleQuote && arithmeticDepth === 0) {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    if (!inSingleQuote) {
      if (commandLine.slice(i, i + 3) === "$((") {
        arithmeticDepth++;
        i += 3;
        continue;
      }
      if (commandLine.slice(i, i + 2) === "$[") {
        arithmeticDepth++;
        i += 2;
        continue;
      }

      if (arithmeticDepth > 0) {
        if (commandLine.slice(i, i + 2) === "))") {
          arithmeticDepth--;
          i += 2;
          continue;
        }
        if (ch === "]") {
          arithmeticDepth--;
          i++;
          continue;
        }
        if (ch === "(") {
          arithmeticDepth++;
          i++;
          continue;
        }
        if (ch === ")") {
          arithmeticDepth--;
          i++;
          continue;
        }
        i++;
        continue;
      }
    }

    if (!inSingleQuote && !inDoubleQuote && arithmeticDepth === 0) {
      if (ch === "<") {
        if (commandLine.slice(i, i + 3) === "<<<") {
          i += 3;
          continue;
        }
        if (commandLine.slice(i, i + 3) === "<<-") {
          i += 3;
          continue;
        }
        if (commandLine.slice(i, i + 2) === "<<") {
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (ch === ">") {
        const prevChar = i > 0 ? commandLine[i - 1] : "";
        if (prevChar === "=" || prevChar === "<") {
          i++;
          continue;
        }

        const nextChar = i + 1 < len ? commandLine[i + 1] : "";
        if (nextChar === "=") {
          i += 2;
          continue;
        }

        let fd = "";
        if (i > 0) {
          const p = commandLine[i - 1];
          if (p === "&" || (p >= "0" && p <= "9")) {
            const pp = i > 1 ? commandLine[i - 2] : " ";
            if (/\s|[;&|<>]/.test(pp) || i === 1) {
              fd = p;
            }
          }
        }

        let isAppend = false;
        if (nextChar === ">") {
          const thirdChar = i + 2 < len ? commandLine[i + 2] : "";
          if (thirdChar === ">") {
            i += 3;
            continue;
          }
          isAppend = true;
        }

        let isAnd = false;
        if (!isAppend && nextChar === "&") {
          isAnd = true;
        }

        const op = (fd || "") + (isAppend ? ">>" : (isAnd ? ">&" : ">"));
        let targetStart = i + (isAppend ? 2 : (isAnd ? 2 : 1));

        while (targetStart < len && /\s/.test(commandLine[targetStart])) {
          targetStart++;
        }

        if (targetStart < len) {
          let target = "";
          let targetEnd = targetStart;
          const quote = commandLine[targetStart];

          if (quote === '"' || quote === "'") {
            targetStart++;
            targetEnd = targetStart;
            let innerEscaped = false;
            while (targetEnd < len) {
              const c = commandLine[targetEnd];
              if (innerEscaped) {
                innerEscaped = false;
                targetEnd++;
                continue;
              }
              if (c === "\\" && quote === '"') {
                innerEscaped = true;
                targetEnd++;
                continue;
              }
              if (c === quote) {
                break;
              }
              targetEnd++;
            }
            target = commandLine.slice(targetStart, targetEnd);
            i = targetEnd + 1;
          } else {
            while (targetEnd < len && !/[\s;&|<>()]/.test(commandLine[targetEnd])) {
              targetEnd++;
            }
            target = commandLine.slice(targetStart, targetEnd);
            i = targetEnd;
          }

          if (target) {
            rawRedirections.push({ op, target });
            const ignorable = ["/dev/null", "&1", "&2", "/dev/stdout", "/dev/stderr"];
            const isFdDup = (op.endsWith(">&") && (/^[0-9]+$/.test(target) || target === "-")) || target.startsWith("&");
            if (!ignorable.includes(target) && !isFdDup) {
              targets.push(target);
            }
          }
          continue;
        }
      }
    }

    i++;
  }

  return {
    hasRedirection: rawRedirections.length > 0,
    targets,
    rawRedirections,
  };
}

/* =========================================================================
   Automatic Evidence Classification
   ========================================================================= */

export function classifyExecutionEvidence(commandLine, exitCode = 0, output = "", durationMs = 0, artifactPath = null, executionId = null, mutationSeq = 0) {
  const cmd = String(commandLine || "").trim();
  let type = "GENERIC_COMMAND_RESULT";

  if (/\b(?:pnpm(?:\s+run)?\s+typecheck|tsc\b)/.test(cmd)) {
    type = "TYPECHECK";
  } else if (/\b(?:pnpm(?:\s+run)?\s+test|node\s+--test|vitest|jest)\b/.test(cmd)) {
    type = "TEST_RUN";
  } else if (/\b(?:pnpm(?:\s+run)?\s+build)\b/.test(cmd)) {
    type = "BUILD";
  } else if (/\b(?:pnpm(?:\s+run)?\s+lint|eslint)\b/.test(cmd)) {
    type = "LINT";
  } else if (/\b(?:benchmark|bench)\b/i.test(cmd)) {
    type = "BENCHMARK";
  } else if (/\bgit\s+diff\s+--check\b/.test(cmd)) {
    type = "SCOPE_CHECK";
  } else if (/(\bgit\s+(?:status|diff|commit|push|add|checkout|branch|log)\b|git-operation\.mjs)/.test(cmd)) {
    type = "GIT_OPERATION";
  }

  let scope = "GLOBAL";
  const filterMatch = cmd.match(/--filter\s+([^\s]+)/);
  if (filterMatch) {
    scope = filterMatch[1].replace(/["']/g, "");
  } else if (cmd.includes("packages/core") || cmd.includes("@autoeq-workbench/core")) {
    scope = "@autoeq-workbench/core";
  } else if (cmd.includes("packages/") || cmd.includes("apps/")) {
    const pkgMatch = cmd.match(/(packages\/[^\s/]+|apps\/[^\s/]+)/);
    if (pkgMatch) scope = pkgMatch[1];
  }

  const text = typeof output === "string" ? output : JSON.stringify(output || "");
  const passMatch = text.match(/(?:pass(?:ed)?\s*(\d+)|(\d+)\s*pass(?:ed)?)/i);
  const failMatch = text.match(/(?:fail(?:ed)?\s*(\d+)|(\d+)\s*fail(?:ed)?)/i);
  const passedCount = passMatch ? parseInt(passMatch[1] || passMatch[2], 10) : null;
  const failedCount = failMatch ? parseInt(failMatch[1] || failMatch[2], 10) : null;

  let passed = passedCount;
  let failed = failedCount;

  if (type === "TEST_RUN") {
    if (exitCode === 0) {
      passed = passedCount !== null ? passedCount : 1;
      failed = failedCount !== null ? failedCount : 0;
    } else {
      passed = passedCount !== null ? passedCount : 0;
      failed = failedCount !== null ? failedCount : 1;
    }
  } else if (type === "TYPECHECK" || type === "BUILD" || type === "LINT" || type === "SCOPE_CHECK" || type === "GIT_OPERATION") {
    passed = exitCode === 0 ? 1 : 0;
    failed = exitCode === 0 ? 0 : 1;
  }

  return {
    id: executionId || `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    executionId: executionId || null,
    type,
    scope,
    command: cmd,
    exitCode: Number(exitCode),
    passed,
    failed,
    durationMs: Number(durationMs) || 0,
    artifactPath: artifactPath || null,
    mutationSeq: typeof mutationSeq === "number" ? mutationSeq : 0,
    timestamp: new Date().toISOString(),
  };
}

/* =========================================================================
   Heavy-Work Disposable Worker Handoff & Contract
   ========================================================================= */

export function isHeavyExecution(facts = {}) {
  const action = normalizeTaskAction(facts);
  if (action === "HEAVY_EXECUTION") return true;
  return facts.isHeavyExecution === true
    || facts.heavyExecution === true
    || facts.campaign === true
    || facts.benchmarkSuite === true
    || facts.expectedLargeOutput === true;
}

export function createHeavyExecutionHandoff(details = {}) {
  const taskDomain = normalizeTaskDomain(details);
  const scopeContract = createScopeContract({
    ...details,
    taskAction: "HEAVY_EXECUTION",
    taskDomain,
  });

  return {
    kind: "heavy-execution-handoff",
    taskAction: "HEAVY_EXECUTION",
    taskDomain,
    executor: "flash",
    worker: "flash-worker",
    model: GEMINI_MODELS.WORKER_HIGH,
    tier: "pro",
    effort: "high",
    disposable: true,
    contextFirewall: true,
    instruction: "Execute heavy task in isolated disposable context. Save raw logs and outputs to artifacts on disk. Return ONLY compact summary packet to parent.",
    outputContract: Object.freeze([
      "STATUS",
      "COMMANDS_RUN",
      "KEY_METRICS",
      "TOP_FINDINGS",
      "REGRESSIONS",
      "ARTIFACT_PATHS",
      "EVIDENCE_IDS",
      "RECOMMENDED_NEXT_STEP"
    ]),
    scopeContract,
  };
}

export function createDisposableWorkerPacket(details = {}) {
  return {
    status: details.status || "COMPLETED",
    commandsRun: listValue(details.commandsRun || details.commands),
    keyMetrics: details.keyMetrics || {},
    topFindings: listValue(details.topFindings || details.findings),
    regressions: listValue(details.regressions),
    artifactPaths: listValue(details.artifactPaths || details.artifacts),
    evidenceIds: listValue(details.evidenceIds),
    blockers: listValue(details.blockers),
    recommendedNextStep: details.recommendedNextStep || "Review compact summary and proceed.",
  };
}

export function validateDisposableWorkerResult(result = {}) {
  const issues = [];
  if (!result.status) issues.push("Missing status");
  if (!result.artifactPaths || (Array.isArray(result.artifactPaths) && result.artifactPaths.length === 0)) {
    issues.push("Heavy execution should persist raw outputs to disk and report artifactPaths");
  }
  const serialized = JSON.stringify(result);
  if (serialized.length > TOOL_OUTPUT_LIMITS.maxInlineBytes) {
    issues.push(`Disposable worker packet size (${serialized.length} bytes) exceeds context firewall budget (${TOOL_OUTPUT_LIMITS.maxInlineBytes} bytes)`);
  }
  return {
    valid: issues.length === 0,
    issues,
  };
}

/* =========================================================================
   Background Task & Polling Control
   ========================================================================= */

export function checkPollingBudget(tracker = {}, now = Date.now()) {
  const lastPoll = tracker.lastPollTimestamp || 0;
  const elapsedSeconds = Math.round((now - lastPoll) / 1000);
  const pollCount = tracker.pollCount || 0;

  if (lastPoll > 0 && elapsedSeconds < POLLING_POLICY.minBackoffSeconds) {
    return {
      allowed: false,
      reason: "POLLING_TOO_FAST",
      elapsedSeconds,
      minBackoffSeconds: POLLING_POLICY.minBackoffSeconds,
      message: `Polling status too quickly (${elapsedSeconds}s since last poll, minimum backoff is ${POLLING_POLICY.minBackoffSeconds}s). Do not loop on manage_task. Stop calling tools; Antigravity will automatically resume when the task completes.`
    };
  }

  if (pollCount >= POLLING_POLICY.maxPollBudget) {
    return {
      allowed: false,
      reason: "POLLING_BUDGET_EXCEEDED",
      pollCount,
      maxPollBudget: POLLING_POLICY.maxPollBudget,
      message: `Task exceeded polling budget (${POLLING_POLICY.maxPollBudget} polls). Stop calling tools and yield execution; Antigravity will automatically resume when the task completes.`
    };
  }

  return {
    allowed: true,
    pollCount: pollCount + 1,
    lastPollTimestamp: now,
  };
}

/* =========================================================================
   Context Metrics, Amplification & Tool Friction
   ========================================================================= */

export function calculateContextAmplification(events = []) {
  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalToolOutputBytes = 0;
  let inlineToolOutputBytes = 0;
  let truncatedToolOutputBytes = 0;
  let artifactOutputBytes = 0;
  let acceptedTasks = 0;

  for (const ev of events) {
    if (ev.input_tokens) totalInputTokens += ev.input_tokens;
    if (ev.cached_tokens) totalCachedTokens += ev.cached_tokens;
    if (ev.output_tokens) totalOutputTokens += ev.output_tokens;
    if (ev.reasoning_tokens) totalReasoningTokens += ev.reasoning_tokens;
    if (ev.tool_output_bytes) totalToolOutputBytes += ev.tool_output_bytes;
    if (ev.inline_tool_output_bytes) inlineToolOutputBytes += ev.inline_tool_output_bytes;
    if (ev.truncated_tool_output_bytes) truncatedToolOutputBytes += ev.truncated_tool_output_bytes;
    if (ev.artifact_output_bytes) artifactOutputBytes += ev.artifact_output_bytes;
    if (ev.acceptance_result === "ACCEPTED" || ev.result === "PASSED") acceptedTasks += 1;
  }

  const turns = events.length;
  const avgInputPerTurn = turns > 0 ? totalInputTokens / turns : 0;
  const contextReuseAmplification = acceptedTasks > 0
    ? Number((totalInputTokens / acceptedTasks).toFixed(2))
    : Number(avgInputPerTurn.toFixed(2));

  return {
    total_input_tokens: totalInputTokens,
    total_cached_tokens: totalCachedTokens,
    total_output_tokens: totalOutputTokens,
    total_reasoning_tokens: totalReasoningTokens,
    total_tool_output_bytes: totalToolOutputBytes,
    inline_tool_output_bytes: inlineToolOutputBytes,
    truncated_tool_output_bytes: truncatedToolOutputBytes,
    artifact_output_bytes: artifactOutputBytes,
    turns,
    accepted_tasks: acceptedTasks,
    avg_input_tokens_per_turn: Number(avgInputPerTurn.toFixed(2)),
    context_reuse_amplification: contextReuseAmplification,
  };
}

export function detectHookFriction(events = []) {
  let deniedCount = 0;
  let consecutiveDenies = 0;
  let maxConsecutiveDenies = 0;
  let falsePositiveCandidates = 0;
  const denyReasons = {};

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.tool_denied === true || ev.decision === "deny") {
      deniedCount += 1;
      consecutiveDenies += 1;
      if (consecutiveDenies > maxConsecutiveDenies) maxConsecutiveDenies = consecutiveDenies;
      const reason = ev.deny_reason || ev.reason || "unknown";
      denyReasons[reason] = (denyReasons[reason] || 0) + 1;

      if (i + 1 < events.length) {
        const nextEv = events[i + 1];
        if (nextEv.decision === "allow" && nextEv.toolName === ev.toolName) {
          falsePositiveCandidates += 1;
        }
      }
    } else {
      consecutiveDenies = 0;
    }
  }

  const frictionDetected = maxConsecutiveDenies >= 3 || falsePositiveCandidates >= 2;

  return {
    denied_count: deniedCount,
    max_consecutive_denies: maxConsecutiveDenies,
    false_positive_candidates: falsePositiveCandidates,
    deny_reasons: denyReasons,
    hook_friction_detected: frictionDetected,
    status: frictionDetected ? "HOOK_FRICTION" : "HEALTHY",
  };
}

/* =========================================================================
   Efficiency Pass v3: Native Tools First & Shell Governance
   ========================================================================= */

export const SHELL_INTENTS = Object.freeze({
  SHELL_READ: "SHELL_READ",
  SHELL_SEARCH: "SHELL_SEARCH",
  SHELL_DISCOVERY: "SHELL_DISCOVERY",
  SHELL_EDIT: "SHELL_EDIT",
  SHELL_VALIDATION: "SHELL_VALIDATION",
  SHELL_BUILD: "SHELL_BUILD",
  SHELL_TEST: "SHELL_TEST",
  SHELL_SCRIPT: "SHELL_SCRIPT",
  SHELL_HEAVY_EXECUTION: "SHELL_HEAVY_EXECUTION",
  SHELL_GIT_INSPECTION: "SHELL_GIT_INSPECTION",
  SHELL_OTHER: "SHELL_OTHER",
});

export const TOOL_POLICY_THRESHOLDS = Object.freeze({
  minShellInspectionForOveruse: 5,
  minOveruseRatio: 1.0,
  maxReadsBeforeFirstMutation: 10,
});

export function classifyShellIntent(commandLine) {
  let cmd = String(commandLine || "").trim();
  if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
    cmd = cmd.slice(1, -1).trim();
  }
  // Strip working directory jumps
  cmd = cmd.replace(/^cd\s+[^\s;&|]+\s*(&&|;)\s*/, "").trim();

  // 1. Heavy Execution / Benchmarks / Campaigns
  if (/\b(?:benchmark|bench|campaign|replay)\b/i.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_HEAVY_EXECUTION, avoidable: false, reason: "heavy_execution" };
  }

  // 2. Tests (pnpm test, node --test, vitest, jest)
  if (/\b(?:pnpm(?:\s+run)?\s+test|node\s+--test|vitest|jest)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_TEST, avoidable: false, reason: "test_execution" };
  }

  // 3. Validation (typecheck, lint, git diff --check)
  if (/\b(?:pnpm(?:\s+run)?\s+typecheck|tsc\b|pnpm(?:\s+run)?\s+lint|eslint|git\s+diff\s+--check)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_VALIDATION, avoidable: false, reason: "validation_execution" };
  }

  // 4. Builds
  if (/\b(?:pnpm(?:\s+run)?\s+build|npm\s+run\s+build)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_BUILD, avoidable: false, reason: "build_execution" };
  }

  // 5. Git Inspection
  if (/^git\s+(?:-[^\s]+\s+)*(?:status|diff|log|show|branch|rev-parse|worktree\s+list)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_GIT_INSPECTION, avoidable: false, reason: "git_inspection" };
  }

  // 6. Shell Edit (manual editing via sed -i, perl -pi, cat >, tee, writeFileSync, open in write mode)
  if (
    /\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/.test(cmd) ||
    /\bperl\s+(?:-[a-zA-Z]*i[a-zA-Z]*)\b/.test(cmd) ||
    /writeFileSync\s*\(/.test(cmd) ||
    /open\s*\([^)]*['"][wa]/.test(cmd) ||
    />\s*[^\s;&|]+\.(?:ts|tsx|js|mjs|json|css|html|md|py)\b/.test(cmd) ||
    /\btee\s+(?:-[a-zA-Z]+\s+)*[^\s;&|]+\.(?:ts|tsx|js|mjs|json|css|html|md|py)\b/.test(cmd)
  ) {
    return { category: SHELL_INTENTS.SHELL_EDIT, avoidable: true, reason: "prefer_native_edit_tool" };
  }

  // 7. Search (grep, rg, git grep)
  if (/\b(?:rg|grep|git\s+grep)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_SEARCH, avoidable: true, reason: "prefer_grep_search" };
  }

  // 8. Discovery (find, ls, tree, pwd)
  if (/^(?:find|ls|tree|pwd)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_DISCOVERY, avoidable: true, reason: "prefer_find_by_name" };
  }

  // 9. Read (cat, head, tail, sed -n)
  if (
    /^(?:cat|head|tail)\b/.test(cmd) ||
    /\bsed\s+(?:-[a-zA-Z]*n[a-zA-Z]*)\b/.test(cmd)
  ) {
    return { category: SHELL_INTENTS.SHELL_READ, avoidable: true, reason: "prefer_view_file" };
  }

  // 10. Project Scripts (node, python, sh scripts)
  if (/^(?:node|python3?|bash|sh)\s+[^\s;&|]+\.(?:m?js|py|sh)\b/.test(cmd)) {
    return { category: SHELL_INTENTS.SHELL_SCRIPT, avoidable: false, reason: "project_script" };
  }

  return { category: SHELL_INTENTS.SHELL_OTHER, avoidable: false, reason: "other_execution" };
}

export function createInitialToolMix() {
  return {
    native_read_calls: 0,
    native_search_calls: 0,
    native_find_calls: 0,
    native_edit_calls: 0,
    shell_calls: 0,
    shell_read_calls: 0,
    shell_search_calls: 0,
    shell_discovery_calls: 0,
    shell_edit_calls: 0,
    shell_validation_calls: 0,
    shell_test_calls: 0,
    shell_build_calls: 0,
    shell_heavy_calls: 0,
    avoidable_shell_calls: 0,
    native_tool_fallbacks: 0,
    targeted_view_calls: 0,
    full_file_view_calls: 0,
    view_file_lines: 0,
    worker_packet_bytes: 0,
    worker_packet_chars: 0,
    verification_batches: 0,
    verification_batch_steps: 0,
    git_inspection_calls: 0,
    redundant_git_inspections: 0,
    advisories_created: 0,
    advisories_delivered: 0,
    advisories_consumed: 0,
    shell_mutations: 0,
    shell_unknown_mutations: 0,
    direct_actions: 0,
    direct_action_tool_calls: 0,
    direct_action_model_turns: 0,
    direct_action_duration: 0,
    direct_action_blocked: 0,
    direct_action_side_quests_prevented: 0,
    git_transactions: 0,
    git_transaction_success: 0,
    git_transaction_partial_failure: 0,
    git_commit_push_tool_calls: 0,
    git_commit_push_count: 0,
  };
}

export function calculateToolMixMetrics(toolMix = {}, acceptedTasks = 1) {
  const t = { ...createInitialToolMix(), ...toolMix };
  const safeAcceptedTasks = Math.max(1, acceptedTasks || 1);

  const totalShell = t.shell_calls || 0;
  const avoidableShell = t.avoidable_shell_calls || 0;
  const totalNative = (t.native_read_calls || 0) + (t.native_search_calls || 0) + (t.native_find_calls || 0) + (t.native_edit_calls || 0);

  const shellInspection = (t.shell_read_calls || 0) + (t.shell_search_calls || 0) + (t.shell_discovery_calls || 0);
  const nativeInspection = (t.native_read_calls || 0) + (t.native_search_calls || 0) + (t.native_find_calls || 0);
  const totalInspection = shellInspection + nativeInspection;

  const shellValidationAndExecution = (t.shell_validation_calls || 0) + (t.shell_test_calls || 0) + (t.shell_build_calls || 0);

  const totalViews = (t.targeted_view_calls || 0) + (t.full_file_view_calls || 0);
  const totalGitInspections = t.git_inspection_calls || 0;
  const totalShellMutations = t.shell_mutations || 0;

  const directActions = t.direct_actions || 0;
  const directActionToolCalls = t.direct_action_tool_calls || 0;
  const directActionModelTurns = t.direct_action_model_turns || 0;
  const commitPushCount = t.git_commit_push_count || 0;
  const commitPushToolCalls = t.git_commit_push_tool_calls || 0;
  const directActionBlocked = t.direct_action_blocked || 0;
  const directActionSideQuests = t.direct_action_side_quests_prevented || 0;

  return {
    ...t,
    total_native_calls: totalNative,
    total_shell_calls: totalShell,
    shell_calls_per_accepted_task: Number((totalShell / safeAcceptedTasks).toFixed(2)),
    native_calls_per_accepted_task: Number((totalNative / safeAcceptedTasks).toFixed(2)),
    avoidable_shell_calls_per_task: Number((avoidableShell / safeAcceptedTasks).toFixed(2)),
    avoidable_shell_ratio: totalShell > 0 ? Number((avoidableShell / totalShell).toFixed(3)) : 0,
    shell_validation_ratio: totalShell > 0 ? Number((shellValidationAndExecution / totalShell).toFixed(3)) : 0,
    native_inspection_ratio: totalInspection > 0 ? Number((nativeInspection / totalInspection).toFixed(3)) : 1.0,
    shell_inspection_calls: shellInspection,
    native_inspection_calls: nativeInspection,
    targeted_view_ratio: totalViews > 0 ? Number(((t.targeted_view_calls || 0) / totalViews).toFixed(3)) : 1.0,
    average_view_lines: totalViews > 0 ? Number(((t.view_file_lines || 0) / totalViews).toFixed(1)) : 0,
    redundant_git_inspection_ratio: totalGitInspections > 0 ? Number(((t.redundant_git_inspections || 0) / totalGitInspections).toFixed(3)) : 0,
    shell_unknown_mutation_ratio: totalShellMutations > 0 ? Number(((t.shell_unknown_mutations || 0) / totalShellMutations).toFixed(3)) : 0,
    avg_tool_calls_per_direct_action: directActions > 0 ? Number((directActionToolCalls / directActions).toFixed(2)) : 0,
    avg_model_turns_per_direct_action: directActions > 0 ? Number((directActionModelTurns / directActions).toFixed(2)) : 0,
    commit_push_avg_tool_calls: commitPushCount > 0 ? Number((commitPushToolCalls / commitPushCount).toFixed(2)) : 0,
    direct_action_block_rate: directActions > 0 ? Number((directActionBlocked / directActions).toFixed(3)) : 0,
    direct_action_side_quest_rate: directActions > 0 ? Number((directActionSideQuests / directActions).toFixed(3)) : 0,
  };
}

export function detectDirectActionOverhead(stateOrTelemetry = {}) {
  const toolCalls = stateOrTelemetry.direct_action_tool_calls
    ?? stateOrTelemetry.toolMix?.direct_action_tool_calls
    ?? 0;
  const maxHealthy = 3;
  const overheadDetected = toolCalls > maxHealthy;
  return {
    overheadDetected,
    toolCalls,
    reason: overheadDetected
      ? `DIRECT_ACTION_OVERHEAD: ${toolCalls} tool calls executed for direct action (target is 1-3 tool calls). Consider executing operation via unified transaction.`
      : null,
  };
}

export function detectDirectActionOverthinking(stateOrTelemetry = {}) {
  const turns = stateOrTelemetry.direct_action_model_turns
    ?? stateOrTelemetry.modelTurns
    ?? 0;
  const maxTurns = 2;
  const overthinkingDetected = turns > maxTurns;
  return {
    overthinkingDetected,
    turns,
    reason: overthinkingDetected
      ? `DIRECT_ACTION_OVERTHINKING: ${turns} model turns elapsed without concluding direct action. Avoid multi-turn contemplation or investigation during direct operations.`
      : null,
  };
}

export function detectShellOveruse(toolMixOrMetrics = {}) {
  const metrics = calculateToolMixMetrics(toolMixOrMetrics);
  const shellInspection = metrics.shell_inspection_calls;
  const nativeInspection = metrics.native_inspection_calls;
  const minThreshold = TOOL_POLICY_THRESHOLDS.minShellInspectionForOveruse;

  const isOveruse = shellInspection >= minThreshold && shellInspection > nativeInspection;

  return {
    overuseDetected: isOveruse,
    shell_inspection_calls: shellInspection,
    native_inspection_calls: nativeInspection,
    reason: isOveruse
      ? `SHELL_OVERUSE: ${shellInspection} shell inspection/search calls detected vs ${nativeInspection} native calls. Prefer native tools (view_file, grep_search, find_by_name) for repository inspection.`
      : null,
  };
}

export function detectExplorationOverhead(stateOrHistory = {}) {
  const readsCount = (stateOrHistory.consecutiveFileReads || 0);
  const maxReads = TOOL_POLICY_THRESHOLDS.maxReadsBeforeFirstMutation;
  const hasMutated = (stateOrHistory.mutationSeq || 0) > 0;

  const overheadDetected = !hasMutated && readsCount > maxReads;
  return {
    overheadDetected,
    consecutiveReads: readsCount,
    hasMutated,
    reason: overheadDetected
      ? `EXPLORATION_OVERHEAD: High read volume (${readsCount} reads) before first mutation. Synthesize findings and proceed to targeted action.`
      : null,
  };
}

export function createMutationRecord(mutationSeq, paths = [], type = "EDIT", domain = null) {
  return {
    mutationSeq: Number(mutationSeq),
    timestamp: new Date().toISOString(),
    paths: Array.isArray(paths) ? paths : [paths],
    type,
    domain: domain || null,
  };
}

export function isControlPlanePath(path) {
  const norm = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!norm) return false;
  if (norm.startsWith(".agents/") || norm === ".agents") return true;
  if (norm.startsWith("scratch/") || norm === "scratch") return true;
  if (norm.startsWith(".scratch/") || norm === ".scratch") return true;
  return false;
}

export function recordMutation(activeState = {}, mutation = {}) {
  const currentSeq = typeof activeState.mutationSeq === "number" ? activeState.mutationSeq : 0;
  const nextSeq = currentSeq + 1;
  const paths = Array.isArray(mutation.paths) ? mutation.paths : (mutation.paths ? [mutation.paths] : []);

  const authorRole = mutation.actorRole || activeState.activeRole || null;
  const record = {
    mutationSeq: nextSeq,
    timestamp: new Date().toISOString(),
    paths,
    type: mutation.type || "EDIT",
    domain: mutation.domain || null,
    authorRole,
    actorId: mutation.actorId || activeState.conversationId || null,
    confidence: mutation.confidence || "LOW",
    evidenceSource: mutation.evidenceSource || "STATE_DERIVED",
  };

  activeState.mutationSeq = nextSeq;
  if (!Array.isArray(activeState.mutations)) {
    activeState.mutations = [];
  }
  activeState.mutations.push(record);

  if (activeState.mutations.length > 50) {
    activeState.mutations = activeState.mutations.slice(-50);
  }

  if (!Array.isArray(activeState.mutationEvents)) {
    activeState.mutationEvents = [];
  }
  for (const p of paths) {
    const isCP = typeof mutation.isControlPlane === "boolean" ? mutation.isControlPlane : isControlPlanePath(p);
    activeState.mutationEvents.push({
      path: p,
      tool: mutation.tool || (mutation.type === "CREATE" ? "write_to_file" : (mutation.type === "SHELL_MUTATION" ? "run_command" : "replace_file_content")),
      actorRole: authorRole || "UNKNOWN",
      actorId: mutation.actorId || activeState.conversationId || null,
      conversationId: mutation.conversationId || mutation.actorId || activeState.conversationId || null,
      agentProfile: mutation.agentProfile || activeState.requested_agent || null,
      model: mutation.model || activeState.actual_runtime_model || activeState.configured_model || null,
      confidence: mutation.confidence || (authorRole ? "MEDIUM" : "LOW"),
      evidenceSource: mutation.evidenceSource || "STATE_DERIVED",
      isControlPlane: isCP,
      timestamp: new Date().toISOString(),
    });
  }

  return record;
}

export function isPathDocsOrSpec(path) {
  const p = String(path || "").toLowerCase();
  return p.startsWith("docs/") || p.endsWith(".md") || p.includes("license") ||
         p.startsWith(".agents/") || p.startsWith(".gemini/") || p.startsWith("scratch/");
}

export function isPathCore(path) {
  const p = String(path || "");
  return p.startsWith("packages/core") || p.includes("@autoeq-workbench/core");
}

export function isPathApp(path) {
  const p = String(path || "");
  return p.startsWith("apps/") || p.includes("apps/web");
}

export function checkEvidenceFreshness(evidence, currentMutationSeq = 0, mutations = []) {
  if (!evidence) {
    return { fresh: false, staleReason: "NO_EVIDENCE" };
  }
  if (evidence.evidenceSource === "CHILD_TRANSCRIPT") {
    if (evidence.mutationAfterValidation === true) {
      return { fresh: false, staleReason: "CHILD_MUTATION_AFTER_VALIDATION" };
    }
    if (evidence.fresh === false) {
      return { fresh: false, staleReason: evidence.staleReason || "CHILD_TRANSCRIPT_STALE" };
    }
    return { fresh: true, staleReason: null };
  }
  const evSeq = typeof evidence.mutationSeq === "number" ? evidence.mutationSeq : 0;
  const currentSeq = typeof currentMutationSeq === "number" ? currentMutationSeq : evSeq;

  if (evSeq >= currentSeq) {
    return { fresh: true, staleReason: null };
  }

  const laterMutations = mutations.filter((m) => {
    const s = typeof m?.mutationSeq === "number" ? m.mutationSeq : (typeof m?.seq === "number" ? m.seq : null);
    return s !== null && s > evSeq;
  });
  if (laterMutations.length === 0) {
    return { fresh: true, staleReason: null };
  }

  const mutatedPaths = laterMutations.flatMap((m) => m.paths || (m.path ? [m.path] : []));

  // 1. Docs-only or control-plane only mutations do NOT invalidate code validation evidence
  if (mutatedPaths.length > 0 && mutatedPaths.every(isPathDocsOrSpec)) {
    return { fresh: true, staleReason: null };
  }

  // 1b. Unknown-scope mutations (e.g. from ambiguous shell scripts/codegen) invalidate conservatively
  const hasUnknownScope = laterMutations.some((m) => m && (m.unknownScope === true || m.scope === "GLOBAL"));
  if (hasUnknownScope) {
    return { fresh: false, staleReason: "UNKNOWN_SCOPE_MUTATION_INVALIDATION" };
  }

  const evScope = String(evidence.scope || "GLOBAL");

  // 2. Core evidence: stays fresh if core was not mutated
  if (evScope === "@autoeq-workbench/core" || evScope.startsWith("packages/core")) {
    const touchesCore = mutatedPaths.some(isPathCore);
    if (!touchesCore) {
      return { fresh: true, staleReason: null };
    }
    return { fresh: false, staleReason: "CORE_MUTATION_INVALIDATION" };
  }

  // 3. App evidence: app depends on core and itself
  if (evScope.startsWith("apps/") || evScope === "apps/web") {
    const touchesAppOrCore = mutatedPaths.some((p) => isPathApp(p) || isPathCore(p));
    if (!touchesAppOrCore) {
      return { fresh: true, staleReason: null };
    }
    return { fresh: false, staleReason: "APP_DEPENDENCY_MUTATION_INVALIDATION" };
  }

  // 4. Global evidence: stale if any code mutated
  if (evScope === "GLOBAL") {
    const touchesCode = mutatedPaths.some((p) => !isPathDocsOrSpec(p));
    if (!touchesCode) {
      return { fresh: true, staleReason: null };
    }
    return { fresh: false, staleReason: "GLOBAL_CODE_MUTATION_INVALIDATION" };
  }

  // 5. Dependency relation unknown: conservative STALE
  return { fresh: false, staleReason: "CONSERVATIVE_UNKNOWN_DEPENDENCY_STALE" };
}

export function findReusableEvidence(evidenceLedger = [], requiredCheck = "", currentMutationSeq = 0, mutations = []) {
  const req = String(requiredCheck || "").trim();
  const filterMatch = req.match(/--filter\s+([^\s]+)/);
  const reqFilter = filterMatch ? filterMatch[1].replace(/["']/g, "") : null;

  for (const ev of evidenceLedger.slice().reverse()) {
    if (!ev || ev.exitCode !== 0 || (ev.failed && ev.failed > 0)) continue;

    const evCmd = String(ev.command || "").trim();
    const evFilterMatch = evCmd.match(/--filter\s+([^\s]+)/);
    const evFilter = evFilterMatch ? evFilterMatch[1].replace(/["']/g, "") : (ev.scope !== "GLOBAL" ? ev.scope : null);

    let matches = false;
    if (reqFilter && evFilter) {
      const sameFilter = (reqFilter === evFilter);
      const sameAction = (req.includes("test") && (evCmd.includes("test") || ev.type === "TEST_RUN"))
        || (req.includes("typecheck") && (evCmd.includes("typecheck") || ev.type === "TYPECHECK"))
        || (req.includes("lint") && (evCmd.includes("lint") || ev.type === "LINT"))
        || (req.includes("build") && (evCmd.includes("build") || ev.type === "BUILD"))
        || (req === evCmd);
      matches = sameFilter && sameAction;
    } else if (req) {
      matches = evCmd.includes(req) || req.includes(evCmd);
    }

    if (matches) {
      const freshness = checkEvidenceFreshness(ev, currentMutationSeq, mutations);
      if (freshness.fresh) {
        return {
          found: true,
          reusable: true,
          evidence: ev,
          fresh: true,
          staleReason: null,
        };
      } else {
        return {
          found: true,
          reusable: false,
          evidence: ev,
          fresh: false,
          staleReason: freshness.staleReason,
        };
      }
    }
  }

  return {
    found: false,
    reusable: false,
    evidence: null,
    fresh: false,
    staleReason: "NOT_FOUND",
  };
}

export function recordNativeToolFallback(activeState = {}, details = {}) {
  if (!activeState.toolMix) {
    activeState.toolMix = createInitialToolMix();
  }
  activeState.toolMix.native_tool_fallbacks = (activeState.toolMix.native_tool_fallbacks || 0) + 1;

  const event = {
    type: "NATIVE_TOOL_FALLBACK",
    reason: details.reason || "native_tool_failed",
    nativeTool: details.nativeTool || null,
    shellCommand: details.shellCommand || null,
    timestamp: new Date().toISOString(),
  };

  if (!Array.isArray(activeState.toolFallbacks)) {
    activeState.toolFallbacks = [];
  }
  activeState.toolFallbacks.push(event);

  return event;
}

export const WORKER_PACKET_LIMITS = Object.freeze({
  MAX_CHARS: 4000,
  MAX_LINES: 100,
  TARGET_CHARS: 2500,
  TARGET_LINES: 60,
});

export function validateWorkerPacket(packetContent = "") {
  const content = typeof packetContent === "string" ? packetContent : String(packetContent || "");
  const charCount = content.length;
  const lineCount = content ? content.split("\n").length : 0;
  const violations = [];

  const exceedsLimits = charCount > WORKER_PACKET_LIMITS.MAX_CHARS || lineCount > WORKER_PACKET_LIMITS.MAX_LINES;
  const exceedsTargets = charCount > WORKER_PACKET_LIMITS.TARGET_CHARS || lineCount > WORKER_PACKET_LIMITS.TARGET_LINES;

  if (charCount > WORKER_PACKET_LIMITS.MAX_CHARS) {
    violations.push(`WORKER_PACKET_EXCEEDS_MAX_CHARS: ${charCount} chars exceeds limit of ${WORKER_PACKET_LIMITS.MAX_CHARS}`);
  }
  if (lineCount > WORKER_PACKET_LIMITS.MAX_LINES) {
    violations.push(`WORKER_PACKET_EXCEEDS_MAX_LINES: ${lineCount} lines exceeds limit of ${WORKER_PACKET_LIMITS.MAX_LINES}`);
  }

  // Check for full file dump antipattern
  if (/^```[a-z]*\n[\s\S]{3000,}\n```$/m.test(content)) {
    violations.push("WORKER_PACKET_RAW_CODE_DUMP: large code dump detected. Prefer artifact reference and concise summary.");
  }

  return {
    valid: violations.length === 0,
    charCount,
    lineCount,
    exceedsLimits,
    exceedsTargets,
    violations,
  };
}

export function calculateViewTargetWindow(matchLineNumber, options = {}) {
  const line = Number.isInteger(matchLineNumber) ? matchLineNumber : parseInt(matchLineNumber, 10);
  if (!Number.isFinite(line) || line < 1) {
    throw new Error(`calculateViewTargetWindow requires a positive integer matchLineNumber, got ${matchLineNumber}`);
  }
  const before = Number.isInteger(options.before) ? options.before : 35;
  const after = Number.isInteger(options.after) ? options.after : 45;
  const totalLines = Number.isInteger(options.totalLines) && options.totalLines > 0 ? options.totalLines : null;

  const startLine = Math.max(1, line - before);
  let endLine = line + after;
  if (totalLines !== null && endLine > totalLines) {
    endLine = totalLines;
  }
  if (endLine < startLine) {
    endLine = startLine;
  }

  return {
    StartLine: startLine,
    EndLine: endLine,
    lineCount: endLine - startLine + 1,
    matchLineNumber: line,
  };
}

export const GIT_EFFECT_TAXONOMY = Object.freeze({
  GIT_READONLY: "GIT_READONLY",
  GIT_INDEX_ONLY: "GIT_INDEX_ONLY",
  GIT_METADATA_ONLY: "GIT_METADATA_ONLY",
  GIT_REMOTE_ONLY: "GIT_REMOTE_ONLY",
  GIT_WORKTREE_MUTATING: "GIT_WORKTREE_MUTATING",
});

export function classifyGitEffect(commandLine = "") {
  const cmd = String(commandLine || "").trim();
  if (!cmd) {
    return { isGit: false, effect: null, subCommand: null };
  }

  // Handle git-operation.mjs runner as non-worktree mutating tool
  if (/git-operation\.mjs\b/.test(cmd)) {
    const actionMatch = cmd.match(/--action\s+([^\s]+)/);
    const action = actionMatch ? actionMatch[1].toLowerCase() : "commit_push";
    if (action === "status" || action === "diff_summary") {
      return { isGit: true, isRunner: true, effect: "GIT_READONLY", subCommand: action };
    }
    if (action === "commit") {
      return { isGit: true, isRunner: true, effect: "GIT_METADATA_ONLY", subCommand: action };
    }
    if (action === "push") {
      return { isGit: true, isRunner: true, effect: "GIT_REMOTE_ONLY", subCommand: action };
    }
    return { isGit: true, isRunner: true, effect: "GIT_METADATA_ONLY", subCommand: "commit_push" };
  }

  const gitMatch = cmd.match(/^git\s+([^\s;&|]+)(.*)$/);
  if (!gitMatch) {
    return { isGit: false, effect: null, subCommand: null };
  }

  const subCommand = gitMatch[1].toLowerCase();
  const rest = gitMatch[2] || "";

  // 1. GIT_READONLY: status, diff, log, show, branch --show-current, rev-parse, describe, grep
  if (["status", "diff", "log", "show", "rev-parse", "describe", "grep", "ls-files", "var"].includes(subCommand)) {
    return { isGit: true, effect: "GIT_READONLY", subCommand };
  }
  if (subCommand === "branch") {
    if (rest.includes("-d") || rest.includes("-D") || rest.includes("-m")) {
      return { isGit: true, effect: "GIT_METADATA_ONLY", subCommand };
    }
    return { isGit: true, effect: "GIT_READONLY", subCommand };
  }

  // 2. GIT_INDEX_ONLY: add, restore --staged, rm --cached, reset (without --hard)
  if (subCommand === "add") {
    return { isGit: true, effect: "GIT_INDEX_ONLY", subCommand };
  }
  if (subCommand === "restore" && rest.includes("--staged")) {
    return { isGit: true, effect: "GIT_INDEX_ONLY", subCommand };
  }
  if (subCommand === "rm" && rest.includes("--cached")) {
    return { isGit: true, effect: "GIT_INDEX_ONLY", subCommand };
  }
  if (subCommand === "reset" && !rest.includes("--hard") && !rest.includes("--merge")) {
    return { isGit: true, effect: "GIT_INDEX_ONLY", subCommand };
  }

  // 3. GIT_METADATA_ONLY: commit, tag, notes
  if (["commit", "tag", "notes"].includes(subCommand)) {
    return { isGit: true, effect: "GIT_METADATA_ONLY", subCommand };
  }

  // 4. GIT_REMOTE_ONLY: push, fetch, remote
  if (["push", "fetch", "remote"].includes(subCommand)) {
    return { isGit: true, effect: "GIT_REMOTE_ONLY", subCommand };
  }

  // 5. GIT_WORKTREE_MUTATING: checkout, switch, restore <file>, reset --hard, merge, rebase, cherry-pick, pull
  if (["checkout", "switch", "merge", "rebase", "cherry-pick", "pull", "clean", "revert"].includes(subCommand)) {
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    const target = tokens.find((t) => !t.startsWith("-")) || null;
    const scope = target ? (isPathCore(target) ? "@autoeq-workbench/core" : (isPathApp(target) ? "apps/web" : (isPathDocsOrSpec(target) ? "DOCS" : "GLOBAL"))) : "GLOBAL";
    return { isGit: true, effect: "GIT_WORKTREE_MUTATING", subCommand, targetPath: target, scope, unknownScope: scope === "GLOBAL" };
  }
  if (subCommand === "restore" && !rest.includes("--staged")) {
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    const target = tokens.find((t) => !t.startsWith("-")) || null;
    const scope = target ? (isPathCore(target) ? "@autoeq-workbench/core" : (isPathApp(target) ? "apps/web" : (isPathDocsOrSpec(target) ? "DOCS" : "GLOBAL"))) : "GLOBAL";
    return { isGit: true, effect: "GIT_WORKTREE_MUTATING", subCommand, targetPath: target, scope, unknownScope: scope === "GLOBAL" };
  }
  if (subCommand === "reset" && rest.includes("--hard")) {
    return { isGit: true, effect: "GIT_WORKTREE_MUTATING", subCommand, targetPath: null, scope: "GLOBAL", unknownScope: true };
  }
  if (subCommand === "stash" && (rest.includes("pop") || rest.includes("apply"))) {
    return { isGit: true, effect: "GIT_WORKTREE_MUTATING", subCommand, targetPath: null, scope: "GLOBAL", unknownScope: true };
  }

  return { isGit: true, effect: "GIT_WORKTREE_MUTATING", subCommand, targetPath: null, scope: "GLOBAL", unknownScope: true };
}

export function classifyShellMutation(commandLine = "") {
  const cmd = String(commandLine || "").trim();
  if (!cmd) {
    return { isMutation: false, scope: null, unknownScope: false, reason: "empty_command" };
  }

  // Check Git commands with Git Effect Taxonomy first
  const gitInfo = classifyGitEffect(cmd);
  if (gitInfo.isGit) {
    if (gitInfo.effect === "GIT_WORKTREE_MUTATING") {
      return {
        isMutation: true,
        scope: gitInfo.scope || "GLOBAL",
        unknownScope: gitInfo.unknownScope !== false,
        reason: "git_working_tree_mutation",
        gitEffect: gitInfo.effect,
        targetPath: gitInfo.targetPath || null,
      };
    }
    return {
      isMutation: false,
      scope: null,
      unknownScope: false,
      reason: gitInfo.effect.toLowerCase(),
      gitEffect: gitInfo.effect,
    };
  }

  // Redirection: check for > or >> that does not point to /dev/null
  const redirMatch = cmd.match(/>>\s*([^\s;&|]+)|>\s*([^\s;&|]+)/);
  if (redirMatch) {
    const target = redirMatch[1] || redirMatch[2];
    if (target && !target.includes("/dev/null")) {
      const scope = isPathCore(target) ? "@autoeq-workbench/core" : (isPathApp(target) ? "apps/web" : (isPathDocsOrSpec(target) ? "DOCS" : "GLOBAL"));
      return {
        isMutation: true,
        scope,
        unknownScope: scope === "GLOBAL",
        reason: "file_redirection",
        targetPath: target,
      };
    }
  }

  // Explicit mutating commands
  const tokens = cmd.split(/\s+/);
  const first = tokens[0] || "";

  if (first === "touch" || first === "mkdir" || first === "rm" || first === "cp" || first === "mv") {
    const target = tokens.slice(1).find((t) => !t.startsWith("-")) || "";
    const scope = isPathCore(target) ? "@autoeq-workbench/core" : (isPathApp(target) ? "apps/web" : (isPathDocsOrSpec(target) ? "DOCS" : "GLOBAL"));
    return {
      isMutation: true,
      scope,
      unknownScope: scope === "GLOBAL",
      reason: `file_operation_${first}`,
      targetPath: target || null,
    };
  }

  if (cmd.includes("sed -i") || cmd.includes("perl -pi")) {
    return { isMutation: true, scope: "GLOBAL", unknownScope: true, reason: "inplace_stream_editor" };
  }

  if (/^(pnpm|npm|yarn|npx)\s+(run\s+)?(generate|codegen|format|build|prebuild|postbuild)\b/.test(cmd)) {
    const isCore = cmd.includes("@autoeq-workbench/core") || cmd.includes("packages/core");
    const isApp = cmd.includes("apps/web") || cmd.includes("apps/");
    const scope = isCore ? "@autoeq-workbench/core" : (isApp ? "apps/web" : "GLOBAL");
    return {
      isMutation: true,
      scope,
      unknownScope: scope === "GLOBAL",
      reason: "build_or_codegen_script",
    };
  }

  return { isMutation: false, scope: null, unknownScope: false, reason: "read_or_inspection_command" };
}

export function trackGitInspection(activeState = {}, commandLine = "") {
  const cmd = String(commandLine || "").trim();
  const isGitInspection = /^git\s+(diff|status|log|show)\b/.test(cmd);
  if (!isGitInspection) {
    return { isGitInspection: false, isRedundant: false, message: null };
  }

  if (!activeState.toolMix) {
    activeState.toolMix = createInitialToolMix();
  }
  activeState.toolMix.git_inspection_calls = (activeState.toolMix.git_inspection_calls || 0) + 1;

  const currentSeq = typeof activeState.mutationSeq === "number" ? activeState.mutationSeq : 0;
  const lastInspection = activeState.lastGitInspection;

  let isRedundant = false;
  if (lastInspection && lastInspection.mutationSeq === currentSeq) {
    isRedundant = true;
    activeState.toolMix.redundant_git_inspections = (activeState.toolMix.redundant_git_inspections || 0) + 1;
  }

  activeState.lastGitInspection = {
    command: cmd,
    mutationSeq: currentSeq,
    timestamp: new Date().toISOString(),
  };

  return {
    isGitInspection: true,
    isRedundant,
    lastInspection: activeState.lastGitInspection,
    message: isRedundant ? `REDUNDANT_GIT_INSPECTION: Git inspection '${cmd}' repeated with no mutations since mutationSeq ${currentSeq}. Reuse previous inspection output or evidence.` : null,
  };
}

export function createAdvisory(activeState = {}, advisory = {}) {
  if (!activeState.advisories) {
    activeState.advisories = [];
  }
  if (!activeState.toolMix) {
    activeState.toolMix = createInitialToolMix();
  }

  const newAdvisory = {
    id: advisory.id || `adv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: advisory.type || "INFO",
    message: String(advisory.message || "").trim(),
    status: "PENDING",
    createdAt: new Date().toISOString(),
  };

  activeState.advisories.push(newAdvisory);
  activeState.toolMix.advisories_created = (activeState.toolMix.advisories_created || 0) + 1;
  return newAdvisory;
}

export function deliverPendingAdvisories(activeState = {}) {
  if (!Array.isArray(activeState.advisories) || activeState.advisories.length === 0) {
    return [];
  }
  if (!activeState.toolMix) {
    activeState.toolMix = createInitialToolMix();
  }

  const delivered = [];
  for (const adv of activeState.advisories) {
    if (adv && adv.status === "PENDING") {
      adv.status = "DELIVERED";
      adv.deliveredAt = new Date().toISOString();
      delivered.push(adv);
    }
  }

  if (delivered.length > 0) {
    activeState.toolMix.advisories_delivered = (activeState.toolMix.advisories_delivered || 0) + delivered.length;
  }

  return delivered;
}

export function consumeDeliveredAdvisories(activeState = {}) {
  if (!Array.isArray(activeState.advisories) || activeState.advisories.length === 0) {
    return 0;
  }
  if (!activeState.toolMix) {
    activeState.toolMix = createInitialToolMix();
  }

  let consumedCount = 0;
  const remaining = [];

  for (const adv of activeState.advisories) {
    if (adv && adv.status === "DELIVERED") {
      adv.status = "CONSUMED";
      adv.consumedAt = new Date().toISOString();
      consumedCount += 1;
    } else if (adv && adv.status === "PENDING") {
      remaining.push(adv);
    }
  }

  activeState.advisories = remaining;
  if (consumedCount > 0) {
    activeState.toolMix.advisories_consumed = (activeState.toolMix.advisories_consumed || 0) + consumedCount;
  }

  return consumedCount;
}

export function planVerificationBatch(activeState = {}, requestedChecks = []) {
  const ledger = Array.isArray(activeState.evidenceLedger) ? activeState.evidenceLedger : [];
  const currentSeq = typeof activeState.mutationSeq === "number" ? activeState.mutationSeq : 0;
  const mutations = Array.isArray(activeState.mutations) ? activeState.mutations : [];

  const plannedSteps = [];
  const skippedSteps = [];

  for (const check of requestedChecks) {
    const cmd = typeof check === "string" ? check : check.command;
    const checkId = check.id || cmd;
    const dependsOn = check.dependsOn || null;
    const scope = check.scope || "GLOBAL";

    const reusable = findReusableEvidence(ledger, cmd, currentSeq, mutations);
    if (reusable.found && reusable.reusable) {
      skippedSteps.push({
        id: checkId,
        command: cmd,
        scope,
        dependsOn,
        skipReason: "FRESH_EVIDENCE_REUSE",
        reusableEvidenceId: reusable.evidence.id,
      });
    } else {
      plannedSteps.push({
        id: checkId,
        command: cmd,
        scope,
        dependsOn,
        skip: false,
        staleReason: reusable.found ? reusable.staleReason : null,
      });
    }
  }

  return {
    plannedSteps,
    skippedSteps,
    batchExecutable: plannedSteps.length > 0,
    totalRequested: requestedChecks.length,
    reusedCount: skippedSteps.length,
  };
}

export function isWorkerRole(role) {
  const r = String(role || "").toUpperCase();
  return r === "WORKER" || r === "FLASH" || r === "FLASH_WORKER" || r === "FLASH_LOW_WORKER" || r === "FLASH_MEDIUM_WORKER";
}

export function isExecutableCommand(cmd) {
  const s = String(cmd || "").trim();
  if (!s) return false;
  const unquoted = s.replace(/^[`'"]|[`'"]$/g, "").trim();
  return /^(?:node|npm|pnpm|yarn|bun|deno|pytest|cargo|go|vitest|jest|make|bash|sh|\.\/|bundle|mvn|gradle|python[0-9.]*|ruby|perl|bin\/)\b/i.test(unquoted);
}

export function extractExecutableCommand(cmd) {
  const s = String(cmd || "").trim();
  if (!s) return null;
  const backtickMatch = s.match(/`([^`]+)`/);
  if (backtickMatch && isExecutableCommand(backtickMatch[1])) {
    return backtickMatch[1].trim();
  }
  if (isExecutableCommand(s)) {
    return s.replace(/^[`'"]|[`'"]$/g, "").trim();
  }
  return null;
}

export function verifyWorkerValidation(activeState = {}) {
  const ledger = Array.isArray(activeState.evidenceLedger) ? activeState.evidenceLedger : [];
  const currentSeq = typeof activeState.mutationSeq === "number" ? activeState.mutationSeq : 0;
  const mutations = Array.isArray(activeState.mutations) ? activeState.mutations : [];
  const contract = activeState.scopeContract || {};
  const requiredTests = contract.testsRequired || activeState.testsRequired || [];

  if (requiredTests.length > 0) {
    let lastEvidence = null;
    for (const rawTestCmd of requiredTests) {
      const execCmd = extractExecutableCommand(rawTestCmd);

      if (execCmd) {
        const executed = ledger.slice().reverse().find((ev) => {
          if (!ev) return false;
          const evCmd = String(ev.command || "").trim();
          return evCmd.includes(execCmd) || execCmd.includes(evCmd);
        });

        if (executed && executed.exitCode !== 0) {
          return {
            verified: false,
            fresh: false,
            reason: `FAILED: validation command ${execCmd} exited with code ${executed.exitCode}`,
            evidence: executed,
          };
        }

        const res = findReusableEvidence(ledger, execCmd, currentSeq, mutations);
        if (!res.found) {
          return {
            verified: false,
            fresh: false,
            reason: `MISSING: required test not executed: ${execCmd}`,
            evidence: null,
          };
        }
        if (!res.reusable) {
          return {
            verified: false,
            fresh: false,
            reason: `STALE: evidence for ${execCmd} is stale (${res.staleReason || "mutation after test"})`,
            evidence: res.evidence,
          };
        }
        const ev = res.evidence;
        if (ev.exitCode !== 0) {
          return {
            verified: false,
            fresh: false,
            reason: `FAILED: validation command ${execCmd} exited with code ${ev.exitCode}`,
            evidence: ev,
          };
        }
        const evActor = ev.actorRole || (activeState.workerValidationObserved && activeState.workerValidationCommand === ev.command ? "WORKER" : "UNKNOWN");
        if (!isWorkerRole(evActor)) {
          return {
            verified: false,
            fresh: false,
            reason: `INVALID_ACTOR: validation evidence produced by ${evActor}, expected WORKER`,
            evidence: ev,
          };
        }
        if (ev.confidence === "LOW") {
          return {
            verified: false,
            fresh: false,
            reason: "LOW_CONFIDENCE: validation evidence has LOW actor attribution confidence",
            evidence: ev,
          };
        }
        lastEvidence = ev;
      } else {
        // Descriptive requirement (e.g. "Run the focused formatter test suite to verify the fix with exitCode 0.")
        // Satisfied by any fresh, passing worker test execution in ledger
        let foundTest = null;
        for (const ev of ledger.slice().reverse()) {
          if (!ev) continue;
          const isTest = ev.type === "TEST_RUN" || /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest|go\s+test)\b/.test(String(ev.command || "").trim());
          if (!isTest) continue;

          if (ev.exitCode !== 0) {
            return {
              verified: false,
              fresh: false,
              reason: `FAILED: validation command ${ev.command} exited with code ${ev.exitCode}`,
              evidence: ev,
            };
          }

          const freshness = checkEvidenceFreshness(ev, currentSeq, mutations);
          if (!freshness.fresh) {
            return {
              verified: false,
              fresh: false,
              reason: `STALE: validation evidence is stale (${freshness.staleReason || "mutation after test"})`,
              evidence: ev,
            };
          }

          const evActor = ev.actorRole || (activeState.workerValidationObserved && activeState.workerValidationCommand === ev.command ? "WORKER" : "UNKNOWN");
          if (!isWorkerRole(evActor)) {
            return {
              verified: false,
              fresh: false,
              reason: `INVALID_ACTOR: validation evidence produced by ${evActor}, expected WORKER`,
              evidence: ev,
            };
          }

          if (ev.confidence === "LOW") {
            return {
              verified: false,
              fresh: false,
              reason: "LOW_CONFIDENCE: validation evidence has LOW actor attribution confidence",
              evidence: ev,
            };
          }

          foundTest = ev;
          break;
        }

        if (!foundTest) {
          return {
            verified: false,
            fresh: false,
            reason: `MISSING: required test not executed: ${rawTestCmd}`,
            evidence: null,
          };
        }
        lastEvidence = foundTest;
      }
    }

    return {
      verified: true,
      fresh: true,
      reason: null,
      evidence: lastEvidence,
    };
  }

  // If no specific tests required by contract, look for ANY valid test run in ledger
  for (const ev of ledger.slice().reverse()) {
    if (!ev) continue;
    const isTest = ev.type === "TEST_RUN" || /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(String(ev.command || "").trim());
    if (!isTest) continue;

    if (ev.exitCode !== 0) {
      return {
        verified: false,
        fresh: false,
        reason: `FAILED: validation command exited with code ${ev.exitCode}`,
        evidence: ev,
      };
    }

    const evActor = ev.actorRole || (activeState.workerValidationObserved && activeState.workerValidationCommand === ev.command ? "WORKER" : "UNKNOWN");
    if (!isWorkerRole(evActor)) {
      return {
        verified: false,
        fresh: false,
        reason: `INVALID_ACTOR: validation evidence produced by ${evActor}, expected WORKER`,
        evidence: ev,
      };
    }

    if (ev.confidence === "LOW") {
      return {
        verified: false,
        fresh: false,
        reason: "LOW_CONFIDENCE: validation evidence has LOW actor attribution confidence",
        evidence: ev,
      };
    }

    const res = findReusableEvidence([ev], ev.command, currentSeq, mutations);
    if (!res.reusable) {
      return {
        verified: false,
        fresh: false,
        reason: `STALE: validation evidence is stale (${res.staleReason || "mutation after test"})`,
        evidence: ev,
      };
    }

    return {
      verified: true,
      fresh: true,
      reason: null,
      evidence: ev,
    };
  }

  return {
    verified: false,
    fresh: false,
    reason: "NO_VERIFIED_WORKER_VALIDATION",
    evidence: null,
  };
}

/**
 * Determines whether a file path is concrete (specific relative file path without wildcards).
 */
export function isConcretePath(p) {
  if (!p || typeof p !== "string") return false;
  const clean = p.trim().replace(/^["']|["']$/g, "").replace(/\\+/g, "/");
  if (!clean) return false;
  if (/[\*\?\[\]\{\}]/.test(clean)) return false;
  if (clean.endsWith("/")) return false;
  return /\.[a-zA-Z0-9_-]+$/.test(clean);
}

/**
 * General Fast-Path Scope Specificity Classifier.
 * Classifies a Scope Contract as CONCRETE, GLOB, or INCOMPLETE without domain-specific knowledge.
 */
export function classifyScopeSpecificity(contract = {}) {
  const allowed = Array.isArray(contract?.allowedPaths) ? contract.allowedPaths.filter(Boolean) : [];
  if (allowed.length === 0) {
    return "INCOMPLETE";
  }
  const hasGlob = allowed.some((p) => /[\*\?\[\]\{\}]/.test(p) || p.endsWith("/"));
  const allConcrete = allowed.every((p) => isConcretePath(p));
  if (allConcrete) {
    return "CONCRETE";
  }
  if (hasGlob) {
    return "GLOB";
  }
  return "INCOMPLETE";
}

/**
 * Checks whether a given role is the Orchestrator.
 */
export function isOrchestratorRole(role) {
  const r = String(role || "").toUpperCase();
  return r === "ORCHESTRATOR" || r === "FLASH_ORCHESTRATOR" || r === "SONNET";
}

/**
 * Evaluates whether runtime state represents healthy delegated execution.
 * When true, Orchestrator must yield and await Reactive Wakeup without polling or side quests.
 */
export function isHealthyDelegatedExecution(activeState = {}, activeRole = "") {
  const currentState = String(activeState?.state || "").toUpperCase();
  const isDelegated = currentState === "DELEGATED";
  const roleToCheck = activeRole || activeState?.activeRole || "";
  const isOrchestrator = isOrchestratorRole(roleToCheck);

  if (!isDelegated || !isOrchestrator) {
    return false;
  }

  // Exceptional coordination conditions (recovery, stall, user status)
  const isDiagnosedStalled = Boolean(activeState?.stalled || activeState?.circuitBreakerType === "STALLED");
  const isCircuitBreakerRecovery = Boolean(activeState?.circuitBreakerTripped || activeState?.circuitBreaker);
  const isRecoveryWithoutReactive = Boolean(activeState?.reactiveWakeupDisabled);
  const isExplicitUserStatus = Boolean(activeState?.userRequestedStatus);

  if (isDiagnosedStalled || isCircuitBreakerRecovery || isRecoveryWithoutReactive || isExplicitUserStatus) {
    return false;
  }

  return true;
}

/**
 * Generic Validation Command Detector.
 */
export function isValidationCommand(cmd) {
  const trimmed = String(cmd || "").trim();
  const redir = extractRealShellRedirections(cmd);
  if (redir.targets.length > 0) return false;

  return (
    /\b(?:pnpm(?:\s+run)?\s+(?:test|typecheck|lint|build)|npm(?:\s+run)?\s+(?:test|typecheck|lint|build)|yarn(?:\s+run)?\s+(?:test|typecheck|lint|build)|node\s+--test|vitest|jest|npx\s+(?:vitest|jest|tsc)|tsc(?:\s+--noEmit)?|pytest|cargo\s+test|go\s+test|git\s+diff\s+--check)\b/.test(trimmed)
  );
}

/**
 * Generic Validation Completion Lock guard.
 * Once a worker has produced fresh passing evidence that satisfies the complete Scope Contract
 * for the current mutation state, VALIDATION IS COMPLETE.
 * Further routine validation commands before another mutation are denied.
 */
export function checkValidationCompletionLock({ activeState = {}, activeContract = null, activeRole = "", commandLine = "" } = {}) {
  // 1. Only applies to worker roles
  if (!isWorkerRole(activeRole)) {
    return { locked: false, reason: null };
  }

  // 2. Only applies to validation commands
  if (!isValidationCommand(commandLine)) {
    return { locked: false, reason: null };
  }

  // 3. Post-mutation check (pre-mutation reproduction is investigation evidence, not acceptance validation)
  const currentSeq = typeof activeState.mutationSeq === "number" ? activeState.mutationSeq : 0;
  const mutations = Array.isArray(activeState.mutations) ? activeState.mutations : [];
  if (currentSeq === 0 && mutations.length === 0 && (!activeState.write_tool_calls || activeState.write_tool_calls === 0)) {
    return { locked: false, reason: null };
  }

  // 4. Stalled or explicit recovery state bypasses the lock
  if (activeState.stalled || activeState.recoveryRequired || activeState.invalidatedEvidence) {
    return { locked: false, reason: null };
  }

  const ledger = Array.isArray(activeState.evidenceLedger) ? activeState.evidenceLedger : [];
  const contract = activeContract || activeState.scopeContract || {};
  const requiredTests = Array.isArray(contract.testsRequired)
    ? contract.testsRequired
    : (Array.isArray(activeState.testsRequired) ? activeState.testsRequired : []);

  // Helper to check if a specific required test command is satisfied with fresh, passing WORKER evidence
  function checkRequiredTestSatisfaction(rawTestCmd) {
    const execCmd = extractExecutableCommand(rawTestCmd) || String(rawTestCmd).trim();
    if (!execCmd) return { satisfied: false, evidence: null };

    // Search ledger in reverse for the latest execution
    for (const ev of ledger.slice().reverse()) {
      if (!ev) continue;
      const evCmd = String(ev.command || "").trim();
      const matches = evCmd.includes(execCmd) || execCmd.includes(evCmd);
      if (!matches) continue;

      // Found a matching execution. Check exit code
      if (ev.exitCode !== 0 || (ev.failed && ev.failed > 0)) {
        return { satisfied: false, failed: true, evidence: ev };
      }

      // Check actor role (must be WORKER, not UNKNOWN or REVIEWER)
      const evActor = ev.actorRole || (activeState.workerValidationObserved && activeState.workerValidationCommand === ev.command ? "WORKER" : "UNKNOWN");
      if (!isWorkerRole(evActor) || ev.confidence === "LOW") {
        return { satisfied: false, invalidActor: true, evidence: ev };
      }

      // Check freshness against current mutationSeq and mutations
      const freshness = checkEvidenceFreshness(ev, currentSeq, mutations);
      if (freshness.fresh) {
        return { satisfied: true, evidence: ev };
      } else {
        return { satisfied: false, stale: true, evidence: ev };
      }
    }

    return { satisfied: false, missing: true, evidence: null };
  }

  if (requiredTests.length > 0) {
    const results = requiredTests.map((req) => ({
      command: req,
      ...checkRequiredTestSatisfaction(req),
    }));

    const allSatisfied = results.every((r) => r.satisfied);
    if (allSatisfied) {
      return {
        locked: true,
        reason: "VALIDATION_ALREADY_SATISFIED: Fresh worker evidence already satisfies the complete Scope Contract for the current mutation state. Stop testing and hand off immediately.",
      };
    }

    // If some required tests are unsatisfied, allow executing any unsatisfied command
    const cmdTrimmed = String(commandLine || "").trim();
    const matchesSatisfied = results.find((r) => {
      if (!r.satisfied) return false;
      const exec = extractExecutableCommand(r.command) || r.command.trim();
      return cmdTrimmed.includes(exec) || exec.includes(cmdTrimmed);
    });

    if (matchesSatisfied) {
      const remaining = results.filter((r) => !r.satisfied).map((r) => r.command);
      return {
        locked: true,
        reason: `VALIDATION_ALREADY_SATISFIED: Test "${matchesSatisfied.command}" already passed with fresh evidence. Remaining required tests: [${remaining.join(", ")}].`,
      };
    }

    return { locked: false, reason: null };
  }

  // If no specific tests required in contract, check if ANY valid test run in ledger has fresh passing worker evidence
  for (const ev of ledger.slice().reverse()) {
    if (!ev) continue;
    if (ev.exitCode !== 0 || (ev.failed && ev.failed > 0)) continue;
    const isTest = ev.type === "TEST_RUN" || /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(String(ev.command || "").trim());
    if (!isTest) continue;

    const evActor = ev.actorRole || (activeState.workerValidationObserved && activeState.workerValidationCommand === ev.command ? "WORKER" : "UNKNOWN");
    if (!isWorkerRole(evActor) || ev.confidence === "LOW") continue;

    const freshness = checkEvidenceFreshness(ev, currentSeq, mutations);
    if (freshness.fresh) {
      return {
        locked: true,
        reason: "VALIDATION_ALREADY_SATISFIED: Fresh worker evidence already satisfies the complete Scope Contract for the current mutation state. Stop testing and hand off immediately.",
      };
    }
  }

  return { locked: false, reason: null };
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--json") {
    throw new Error("Usage: node routing-policy.mjs --json < facts.json");
  }
  const facts = JSON.parse(readFileSync(0, "utf8"));
  console.log(JSON.stringify(decideRoute(facts)));
}
