import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { verifyEvidenceContract } from "./evidence-contract.mjs";

/**
 * Deterministic routing policy for the project-local OpenAI/Codex Orchestra.
 *
 * This module is intentionally independent from `.agents/`: it contains no
 * Antigravity hooks, state, telemetry, skills, or provider-specific runtime
 * semantics. It is a pure decision boundary plus small contract/evidence
 * helpers that can be exercised without a model call.
 */

export const CODEX_MODELS = Object.freeze({
  TERRA_MEDIUM: Object.freeze({
    profile: "terra-medium",
    owner: "terra",
    executor: "terra",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  }),
  LUNA_HIGH: Object.freeze({
    profile: "luna-high",
    owner: "luna",
    executor: "luna",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  }),
  LUNA_MEDIUM: Object.freeze({
    profile: "luna-medium",
    owner: "luna",
    executor: "luna",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  }),
  LUNA_MAX: Object.freeze({
    profile: "luna-max",
    owner: "luna",
    executor: "luna",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
  }),
  TERRA_HIGH: Object.freeze({
    profile: "terra-high",
    owner: "terra",
    executor: "terra",
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
  }),
  TERRA_XHIGH: Object.freeze({
    profile: "terra-xhigh",
    owner: "terra",
    executor: "terra",
    model: "gpt-5.6-terra",
    reasoningEffort: "xhigh",
  }),
  TERRA_MAX: Object.freeze({
    profile: "terra-max",
    owner: "terra",
    executor: "terra",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
  }),
  SOL_LOW: Object.freeze({
    profile: "sol-low",
    owner: "sol",
    executor: "sol",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  }),
  SOL_MEDIUM: Object.freeze({
    profile: "sol-medium",
    owner: "sol",
    executor: "sol",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  }),
  ASTRA_MANUAL: Object.freeze({
    profile: "astra-manual",
    owner: "astra",
    executor: "astra-manual",
    model: "gpt-6-astra",
    reasoningEffort: "medium",
  }),
});

/**
 * Skills that are operationally owned by the Antigravity runtime.  Codex
 * disables these by name in the project-scoped config; keeping the inventory
 * here makes that firewall testable without importing any AGY implementation.
 */
export const AGY_ONLY_SKILL_NAMES = Object.freeze([
  "orchestra",
  "critical-review",
  "evidence-validation",
  "implementation-contract",
  "integration",
  "progressive-testing",
]);

export const STATE_NAMES = Object.freeze([
  "INTAKE",
  "CLASSIFIED",
  "PLANNED",
  "DELEGATED",
  "EXECUTING",
  "EVIDENCE_READY",
  "ACCEPTANCE",
  "INTEGRATING",
  "CRITICAL_REVIEW",
  "DONE",
  "BLOCKED",
  "HUMAN_GATE",
]);

export const VALID_TRANSITIONS = Object.freeze({
  INTAKE: Object.freeze(["CLASSIFIED", "BLOCKED", "HUMAN_GATE"]),
  CLASSIFIED: Object.freeze(["PLANNED", "BLOCKED", "HUMAN_GATE"]),
  PLANNED: Object.freeze(["DELEGATED", "CLASSIFIED", "BLOCKED", "HUMAN_GATE"]),
  DELEGATED: Object.freeze(["EXECUTING", "PLANNED", "BLOCKED", "HUMAN_GATE"]),
  EXECUTING: Object.freeze([
    "EVIDENCE_READY",
    "EXECUTING",
    "DELEGATED",
    "PLANNED",
    "BLOCKED",
    "HUMAN_GATE",
  ]),
  EVIDENCE_READY: Object.freeze(["ACCEPTANCE", "EXECUTING", "BLOCKED", "HUMAN_GATE"]),
  ACCEPTANCE: Object.freeze([
    "DONE",
    "PLANNED",
    "DELEGATED",
    "INTEGRATING",
    "CRITICAL_REVIEW",
    "BLOCKED",
    "HUMAN_GATE",
  ]),
  INTEGRATING: Object.freeze(["EVIDENCE_READY", "ACCEPTANCE", "BLOCKED", "HUMAN_GATE"]),
  CRITICAL_REVIEW: Object.freeze(["DONE", "PLANNED", "DELEGATED", "BLOCKED", "HUMAN_GATE"]),
  DONE: Object.freeze([]),
  BLOCKED: Object.freeze(["INTAKE", "CLASSIFIED", "PLANNED", "HUMAN_GATE"]),
  HUMAN_GATE: Object.freeze(["INTAKE", "CLASSIFIED", "PLANNED", "DELEGATED", "DONE"]),
});

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

const registeredCustomDomains = new Set();

export function registerCustomDomains(domains = []) {
  for (const d of domains) {
    if (typeof d === "string" && d.trim()) {
      registeredCustomDomains.add(d.trim().toUpperCase().replace(/[\s-]+/g, "_"));
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

export const ACTIONS = Object.freeze([
  "ORCHESTRATE",
  "INVESTIGATE",
  "IMPLEMENT",
  "TEST",
  "REVIEW",
  "MECHANICAL_FIX",
  "INTEGRATE",
  "ESCALATE",
  "ASTRA",
  "DIRECT_ACTION",
]);

export const CRITICALITIES = Object.freeze(["NORMAL", "MAJOR", "CRITICAL"]);
export const DIRECT_ACTIONS = Object.freeze([
  "SHOW_STATUS", "SHOW_DIFF", "RUN_TEST", "RUN_TYPECHECK", "RUN_BUILD",
  "RUN_SCRIPT", "COMMIT", "PUSH", "COMMIT_PUSH",
]);
export const COMMAND_SEMANTICS = Object.freeze([
  "CLEAN", "DIRTY", "NO_CHANGES", "CHANGES_PRESENT", "PASS", "SUCCESS",
  "COMMITTED", "PUSH_SUCCEEDED", "COMMIT_PUSH_SUCCEEDED", "PARTIAL_SUCCESS",
  "TEST_FAILED", "TYPECHECK_FAILURE", "BUILD_FAILURE", "COMMAND_FAILED",
  "COMMIT_FAILED", "PUSH_FAILED", "COMMIT_UNVERIFIED", "COMMIT_PUSH_FAILED",
  "TOOL_FAILURE", "UNKNOWN",
]);
const DIRECT_ACTION_SET = new Set(DIRECT_ACTIONS);
export const CROSS_DOMAIN_REQUEST = "CROSS_DOMAIN_REQUEST";
export const RETRY_REASONS = Object.freeze([
  "MISINTERPRETED_REQUIREMENT",
  "INCOMPLETE_IMPLEMENTATION",
  "FAILED_TEST",
  "SCOPE_GAP",
  "MISSING_CONTEXT",
  "INTEGRATION_FAILURE",
]);

const DOMAIN_ALIASES = Object.freeze({
  AUTOEQ: "AUTOEQ_ALGORITHM",
  AUTOEQ_ALGO: "AUTOEQ_ALGORITHM",
  AUTO_EQ_ALGORITHM: "AUTOEQ_ALGORITHM",
  ALGORITHM: "AUTOEQ_ALGORITHM",
  DSP: "DSP_CORE",
  CORE: "DSP_CORE",
  UX: "UI",
  INFRASTRUCTURE: "INFRA",
  TEST: "TESTING",
  DOC: "DOCS",
  DOCUMENTATION: "DOCS",
  ORCHESTRATION: "ORCHESTRA",
});
const ACTION_ALIASES = Object.freeze({
  ORCHESTRATION: "ORCHESTRATE",
  CLASSIFY: "ORCHESTRATE",
  INVESTIGATION: "INVESTIGATE",
  IMPLEMENTATION: "IMPLEMENT",
  INTEGRATION: "INTEGRATE",
  DOCUMENTATION: "IMPLEMENT",
  MECHANICAL: "MECHANICAL_FIX",
  FIX_MECHANICAL: "MECHANICAL_FIX",
  ESCALATION: "ESCALATE",
  CONSULT: "ASTRA",
  DIRECT: "DIRECT_ACTION",
  OPERATIONAL: "DIRECT_ACTION",
});
const ACTION_SET = new Set(ACTIONS);
const DOMAIN_SET = new Set(TASK_DOMAINS);
const CRITICALITY_SET = new Set(CRITICALITIES);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function normalizeToken(value) {
  return typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
}

function firstPresent(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (hasOwn(value, key) && value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function actionInfo(facts = {}) {
  if (!facts || typeof facts !== "object") return { action: "UNKNOWN", explicit: true };
  const key = ["taskAction", "nextTaskAction", "action"].find((candidate) => hasOwn(facts, candidate));
  if (key) {
    const token = normalizeToken(facts[key]);
    return { action: ACTION_ALIASES[token] ?? (ACTION_SET.has(token) ? token : "UNKNOWN"), explicit: true, source: key };
  }
  if (hasOwn(facts, "taskClass")) {
    const taskClass = normalizeToken(facts.taskClass);
    const mapped = {
      TRIVIAL_CHANGE: "IMPLEMENT",
      MECHANICAL_CHANGE: "MECHANICAL_FIX",
      CONVENTIONAL_IMPLEMENTATION: "IMPLEMENT",
      HARD_SPECIFIED_IMPLEMENTATION: "IMPLEMENT",
      DEEP_TECHNICAL_INVESTIGATION: "INVESTIGATE",
    }[taskClass];
    return { action: mapped ?? "UNKNOWN", explicit: true, source: "taskClass" };
  }
  return { action: null, explicit: false, source: null };
}

export function normalizeTaskAction(facts = {}) {
  return actionInfo(facts).action ?? "UNKNOWN";
}

export function canonicalTaskDomain(value) {
  const token = normalizeToken(value);
  if (DOMAIN_ALIASES[token]) return DOMAIN_ALIASES[token];
  if (DOMAIN_SET.has(token) || registeredCustomDomains.has(token)) return token;
  return "GENERAL";
}

export function normalizeTaskDomain(facts = {}) {
  if (typeof facts === "string") return canonicalTaskDomain(facts);
  return canonicalTaskDomain(firstPresent(facts, ["taskDomain", "task_domain", "domain"]));
}

export const normalizeDomain = normalizeTaskDomain;

function normalizeCriticalityValue(value) {
  const token = normalizeToken(value);
  if (CRITICALITY_SET.has(token)) return token;
  if (["HIGH", "IMPORTANT", "SIGNIFICANT"].includes(token)) return "MAJOR";
  if (["SEVERE", "DESTRUCTIVE", "RELEASE_CRITICAL"].includes(token)) return "CRITICAL";
  return "NORMAL";
}

export function normalizeCriticality(facts = {}) {
  return normalizeCriticalityValue(typeof facts === "string" ? facts : firstPresent(facts, ["criticality", "riskLevel", "criticalityLevel"]));
}

function normalizeComplexity(value) {
  const token = normalizeToken(value);
  if (["SIMPLE", "TRIVIAL", "SMALL", "LOW"].includes(token)) return "simple";
  if (["EXPERIMENTAL", "INVESTIGATIVE", "EXPERIMENT", "RESEARCH"].includes(token)) return "experimental";
  if (["DIFFICULT", "HARD", "COMPLEX", "LARGE", "MAX", "VERY_HARD"].includes(token)) return "difficult";
  return "normal";
}

function implementationComplexity(facts = {}) {
  const explicit = firstPresent(facts, ["implementationComplexity", "implementationDifficulty", "difficulty", "complexity"]);
  if (explicit === undefined && normalizeTaskDomain(facts) === "DOCS") return "simple";
  return normalizeComplexity(explicit);
}

function normalizeInvestigationEffort(value) {
  const token = normalizeToken(value);
  if (["XHIGH", "X_HIGH", "VERY_DEEP", "DEEP_XHIGH"].includes(token)) return "xhigh";
  if (["MAX", "VERY_HARD", "DEEP_MAX", "EXCEPTIONAL"].includes(token)) return "max";
  return "high";
}

function escalationEvidencePresent(facts = {}) {
  const evidence = firstPresent(facts, ["evidence", "justificationEvidence", "experiments"]);
  const justification = firstPresent(facts, ["justification", "escalationReason"])
    ?? (facts.escalationJustified === true ? "explicit justification" : undefined);
  return Boolean(justification && ((Array.isArray(evidence) && evidence.length > 0) || typeof evidence === "string"));
}

function routeFor(profile, details = {}) {
  const model = CODEX_MODELS[profile];
  return {
    valid: true,
    status: "ROUTED",
    runtime: "CODEX",
    route: "CODEX",
    profile: model.profile,
    owner: model.owner,
    executor: model.executor,
    model: model.model,
    reasoningEffort: model.reasoningEffort,
    effort: model.reasoningEffort,
    model_reasoning_effort: model.reasoningEffort,
    automatic: profile !== "ASTRA_MANUAL",
    ...details,
  };
}

function invalidRoute(error, details = {}) {
  return {
    valid: false,
    status: "BLOCKED",
    runtime: "CODEX",
    route: null,
    profile: null,
    owner: null,
    executor: null,
    model: null,
    error,
    ...details,
  };
}

function astraPacketValid(packet) {
  if (!packet || typeof packet !== "object") return false;
  const problem = packet.problem ?? packet.currentState;
  const question = packet.question ?? packet.specificQuestion;
  const criterion = packet.successCriterion ?? packet.expectedResult;
  const evidence = packet.evidence;
  return Boolean(problem && question && criterion && ((Array.isArray(evidence) && evidence.length > 0) || typeof evidence === "string"));
}

/**
 * Build the explicit human-approved consultation packet required before the
 * manual Astra profile can ever be selected.  This packet is data only; it
 * does not invoke a model or change the routing decision.
 */
export function createAstraEscalationPacket(details = {}) {
  return {
    type: "ASTRA_ESCALATION_PACKET",
    problem: details.problem ?? null,
    currentState: details.currentState ?? null,
    previousAttempts: Array.isArray(details.previousAttempts)
      ? [...details.previousAttempts]
      : (Array.isArray(details.attempts) ? [...details.attempts] : []),
    evidence: Array.isArray(details.evidence) ? [...details.evidence] : (details.evidence ?? []),
    openHypotheses: Array.isArray(details.openHypotheses)
      ? [...details.openHypotheses]
      : (Array.isArray(details.hypotheses) ? [...details.hypotheses] : []),
    question: details.question ?? details.specificQuestion ?? null,
    minimumContext: details.minimumContext ?? details.context ?? null,
    risk: details.risk ?? details.risks ?? null,
    successCriterion: details.successCriterion ?? details.expectedResult ?? null,
  };
}

export function validateAstraEscalationPacket(packet) {
  return {
    valid: astraPacketValid(packet),
    type: packet?.type ?? null,
    reason: astraPacketValid(packet) ? null : "ASTRA_PACKET_INCOMPLETE",
  };
}

export function decideRoute(facts = {}) {
  if (!facts || typeof facts !== "object") return invalidRoute("INVALID_FACTS");

  const fallbackRequested = facts.fallback === true
    || facts.automaticFallback === true
    || normalizeToken(facts.fallbackTarget) === "ASTRA";
  if (fallbackRequested && !facts.astraApproved) {
    return routeFor("TERRA_MEDIUM", {
      reason: "ASTRA_MANUAL_ONLY",
      astraBlocked: true,
      classificationOnly: true,
    });
  }

  const info = actionInfo(facts);
  if (!info.explicit) return routeFor("TERRA_MEDIUM", { reason: "default-control-plane", classificationOnly: true });
  if (info.action === "UNKNOWN") return invalidRoute("INVALID_ROUTE", { reason: "unknown-task-action" });

  switch (info.action) {
    case "ORCHESTRATE":
      return routeFor("TERRA_MEDIUM", { reason: "orchestration-control-plane" });
    case "DIRECT_ACTION": {
      const operation = normalizeToken(firstPresent(facts, ["operation", "directAction", "direct_action"]));
      if (!DIRECT_ACTION_SET.has(operation)) {
        return invalidRoute("INVALID_DIRECT_ACTION", { reason: "unknown-direct-action" });
      }
      return routeFor("TERRA_MEDIUM", {
        reason: "direct-operational-action",
        operation,
        directAction: true,
        bypassesImplementationAcceptance: true,
      });
    }
    case "IMPLEMENT": {
      const complexity = implementationComplexity(facts);
      const profile = complexity === "simple" ? "LUNA_HIGH" : "LUNA_MAX";
      return routeFor(profile, { reason: complexity === "simple" ? "simple-implementation" : "normal-implementation", taskDomain: normalizeTaskDomain(facts) });
    }
    case "TEST":
      return routeFor("LUNA_HIGH", { reason: "focused-test-execution", taskDomain: normalizeTaskDomain(facts) });
    case "MECHANICAL_FIX": {
      const domain = normalizeTaskDomain(facts);
      const supportOnly = facts.deterministicSupport === true
        && facts.productWork !== true
        && ["DOCS", "INFRA", "TESTING"].includes(domain);
      return routeFor(supportOnly ? "LUNA_MEDIUM" : "LUNA_HIGH", {
        reason: supportOnly ? "deterministic-support" : "mechanical-fix",
        taskDomain: domain,
      });
    }
    case "INTEGRATE":
      return routeFor("LUNA_MAX", { reason: "integration-deliverable", operation: "INTEGRATE", taskDomain: normalizeTaskDomain(facts) });
    case "INVESTIGATE": {
      const effort = normalizeInvestigationEffort(firstPresent(facts, ["investigationEffort", "investigationDepth", "difficulty", "complexity"]));
      if (effort === "max") {
        if (!escalationEvidencePresent(facts) || !(Number(facts.priorAttempts) > 0)) {
          return routeFor("TERRA_XHIGH", { reason: "terra-max-evidence-required", escalationBlocked: true, requestedEffort: "max" });
        }
        return routeFor("TERRA_MAX", { reason: "exceptional-investigation", escalationJustified: true });
      }
      if (effort === "xhigh") {
        if (!escalationEvidencePresent(facts)) {
          return routeFor("TERRA_HIGH", { reason: "terra-xhigh-evidence-required", escalationBlocked: true, requestedEffort: "xhigh" });
        }
        return routeFor("TERRA_XHIGH", { reason: "justified-deeper-investigation", escalationJustified: true });
      }
      return routeFor("TERRA_HIGH", { reason: "deep-investigation" });
    }
    case "REVIEW": {
      const criticality = normalizeCriticality(facts);
      if (criticality === "CRITICAL" || facts.rareSpecialistReview === true) {
        return routeFor("SOL_LOW", { reason: "critical-independent-review", independent: true, criticality });
      }
      return routeFor("TERRA_MEDIUM", { reason: "acceptance-review", criticality });
    }
    case "ESCALATE": {
      const target = normalizeToken(firstPresent(facts, ["specialistLevel", "escalationLevel", "target"]));
      if (target === "ASTRA" || target === "MANUAL") {
        return invalidRoute("ASTRA_APPROVAL_REQUIRED", { astraBlocked: true });
      }
      if (target === "MEDIUM" || target === "SOL_MEDIUM") {
        if (!facts.escalationJustified || !escalationEvidencePresent(facts)) {
          return routeFor("TERRA_MEDIUM", { reason: "specialist-escalation-evidence-required", escalationBlocked: true });
        }
        return routeFor("SOL_MEDIUM", { reason: "justified-specialist-escalation", escalationJustified: true });
      }
      return routeFor("SOL_LOW", { reason: "rare-specialist-review", independent: true, criticality: normalizeCriticality(facts) });
    }
    case "ASTRA":
      if (!facts.astraApproved || !astraPacketValid(facts.astraEscalationPacket)) {
        return invalidRoute("ASTRA_APPROVAL_REQUIRED", { astraBlocked: true, manualOnly: true });
      }
      return routeFor("ASTRA_MANUAL", { reason: "explicit-approved-astra-packet", manualOnly: true, automatic: false });
    default:
      return invalidRoute("INVALID_ROUTE");
  }
}

export function validateCodexRoute(route) {
  if (!route || route.valid === false) return { valid: false, reason: "route-is-not-active" };
  const model = typeof route.model === "string" ? route.model : "";
  const executor = typeof route.executor === "string" ? route.executor : "";
  const profile = typeof route.profile === "string" ? route.profile : "";
  if (!/^gpt-/.test(model)) return { valid: false, reason: "non-codex-model" };
  if (/gemini|flash|all-gemini/i.test(`${model} ${executor} ${profile}`)) {
    return { valid: false, reason: "foreign-runtime-marker" };
  }
  if ((profile === "astra-manual" || model === "gpt-6-astra" || executor === "astra-manual") && route.automatic === true) {
    return { valid: false, reason: "astra-automatic" };
  }
  return { valid: true, reason: null };
}

function globToRegExp(pattern) {
  const source = String(pattern ?? "");
  let expression = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function matchesPath(patterns, path) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export function createRetryBudget(facts = {}) {
  const raw = facts && typeof facts === "object" ? (facts.retryBudget ?? facts) : {};
  const complexity = implementationComplexity(facts);
  const maxCandidate = typeof raw === "number" ? raw : firstPresent(raw, ["maxAttempts", "max_attempts"]);
  const maxAttempts = Number.isInteger(maxCandidate) && maxCandidate > 0
    ? maxCandidate
    : (complexity === "experimental" || normalizeTaskAction(facts) === "INVESTIGATE" ? 3 : 2);
  const attemptCandidate = firstPresent(raw, ["attempt", "attemptNumber", "attempt_number"]);
  const attempt = Math.max(0, Math.min(maxAttempts, Number.isInteger(attemptCandidate) ? attemptCandidate : 0));
  const remainingCandidate = firstPresent(raw, ["remainingAttempts", "remaining_attempts"]);
  const remainingAttempts = Math.max(0, Math.min(maxAttempts - attempt, Number.isInteger(remainingCandidate) ? remainingCandidate : maxAttempts - attempt));
  return { maxAttempts, attempt, remainingAttempts };
}

export function consumeRetryBudget(facts = {}) {
  const budget = createRetryBudget(facts);
  if (budget.remainingAttempts <= 0 || budget.attempt >= budget.maxAttempts) return { ...budget, remainingAttempts: 0 };
  return { maxAttempts: budget.maxAttempts, attempt: budget.attempt + 1, remainingAttempts: budget.remainingAttempts - 1 };
}

export const createRetryState = createRetryBudget;
export const nextRetryBudget = consumeRetryBudget;

export const SIDE_EFFECT_CAPABILITIES = Object.freeze([
  "LOCAL_READ",
  "LOCAL_WRITE",
  "PROCESS_EXEC",
  "NETWORK_READ",
  "NETWORK_WRITE",
  "REMOTE_REPO_WRITE",
  "VCS_REMOTE_WRITE",
  "CROSS_AGENT_MESSAGE",
  "PUBLICATION",
]);
const SIDE_EFFECT_CAPABILITY_SET = new Set(SIDE_EFFECT_CAPABILITIES);

function normalizeSideEffectCapabilities(value) {
  const items = Array.isArray(value) ? value : (typeof value === "string" && value.trim() ? [value] : []);
  return [...new Set(items.map((item) => normalizeToken(item)).filter(Boolean))];
}

export function createScopeContract(details = {}) {
  const nested = details.scopeContract && typeof details.scopeContract === "object"
    ? details.scopeContract
    : {};
  const merged = { ...details, ...nested };
  const taskAction = normalizeTaskAction(merged) === "UNKNOWN" ? "IMPLEMENT" : normalizeTaskAction(merged);
  const allowedPaths = Array.isArray(merged.allowedPaths) ? [...merged.allowedPaths] : [];
  const forbiddenPaths = Array.isArray(merged.forbiddenPaths) ? [...merged.forbiddenPaths] : [];
  return {
    taskAction,
    taskDomain: normalizeTaskDomain(merged),
    allowedPaths,
    forbiddenPaths,
    dependencies: Array.isArray(merged.dependencies) ? [...merged.dependencies] : [],
    acceptanceCriteria: Array.isArray(merged.acceptanceCriteria) ? [...merged.acceptanceCriteria] : [],
    testsRequired: Array.isArray(merged.testsRequired) ? [...merged.testsRequired] : [],
    requiredEvidence: Array.isArray(merged.requiredEvidence) ? structuredClone(merged.requiredEvidence) : [],
    retryBudget: createRetryBudget(merged),
    stopConditions: Array.isArray(merged.stopConditions) ? [...merged.stopConditions] : [],
    doNotChange: Array.isArray(merged.doNotChange) ? [...merged.doNotChange] : [],
    sideEffectCapabilities: normalizeSideEffectCapabilities(
      merged.sideEffectCapabilities ?? merged.side_effect_capabilities ?? merged.capabilities ?? [],
    ),
    criticality: normalizeCriticality(merged),
  };
}

export function validateScopeContract(contractOrFacts = {}, changedPaths = []) {
  const contract = contractOrFacts?.scopeContract && !Array.isArray(contractOrFacts.changedPaths)
    ? contractOrFacts.scopeContract
    : contractOrFacts;
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const allowed = Array.isArray(contract?.allowedPaths) ? contract.allowedPaths : [];
  const forbidden = Array.isArray(contract?.forbiddenPaths) ? contract.forbiddenPaths : [];
  const sideEffectCapabilities = normalizeSideEffectCapabilities(
    contract?.sideEffectCapabilities ?? contract?.side_effect_capabilities ?? contract?.capabilities ?? [],
  );
  const invalidSideEffectCapabilities = sideEffectCapabilities.filter((capability) => !SIDE_EFFECT_CAPABILITY_SET.has(capability));
  const forbiddenViolations = paths.filter((path) => matchesPath(forbidden, path));
  const outsideAllowed = allowed.length === 0 ? [] : paths.filter((path) => !matchesPath(allowed, path));
  const violations = [...new Set([...forbiddenViolations, ...outsideAllowed])];
  return {
    valid: violations.length === 0 && invalidSideEffectCapabilities.length === 0,
    scopeViolation: violations.length > 0,
    violations,
    invalidSideEffectCapabilities,
    forbiddenViolations,
    outsideAllowed,
    checkedPaths: paths,
  };
}

export const checkScopeCompliance = validateScopeContract;

export function createCrossDomainRequest(details = {}) {
  return {
    type: CROSS_DOMAIN_REQUEST,
    currentDomain: canonicalTaskDomain(details.currentDomain),
    requiredDomain: canonicalTaskDomain(details.requiredDomain),
    reason: details.reason ?? "cross-domain capability required",
    requestedCapability: details.requestedCapability ?? null,
    evidence: details.evidence ?? [],
    blocking: details.blocking !== false,
  };
}

export function requiresIntegration(facts = {}) {
  if (facts.integrationRequired === true) return true;
  const deliverables = Array.isArray(facts.deliverables) ? facts.deliverables : [];
  const domains = Array.isArray(facts.taskDomains) ? facts.taskDomains : [];
  return deliverables.length > 1 || new Set(domains.map(canonicalTaskDomain)).size > 1;
}

export function createIntegrationContract(details = {}) {
  const domains = Array.isArray(details.taskDomains) ? details.taskDomains.map(canonicalTaskDomain) : [];
  return {
    taskAction: "INTEGRATE",
    operation: "INTEGRATE",
    taskDomain: domains.length === 1 ? domains[0] : "GENERAL",
    taskDomains: domains,
    deliverables: Array.isArray(details.deliverables) ? [...details.deliverables] : [],
    allowedPaths: Array.isArray(details.allowedPaths) ? [...details.allowedPaths] : [],
    testsRequired: Array.isArray(details.testsRequired) ? [...details.testsRequired] : [],
    ...routeFor("LUNA_MAX", { reason: "multi-deliverable-integration" }),
  };
}

export const createIntegrationHandoff = createIntegrationContract;

export function createAcceptanceGate(details = {}) {
  const workerResult = details.workerResult ?? {};
  const workerComplete = workerResult.status === "IMPLEMENTATION_COMPLETE" && workerResult.complete !== false;
  return {
    owner: "terra",
    workerComplete,
    result: workerComplete ? "EVIDENCE_REQUIRED" : "WORKER_INCOMPLETE",
    accepted: false,
  };
}

function evidenceForCommand(evidence, command) {
  return evidence.some((entry) => entry && entry.command === command && Number(entry.exitCode) === 0 && Number(entry.failed ?? 0) === 0);
}

export function evaluateAcceptance(details = {}) {
  const workerResult = details.workerResult ?? {};
  const workerComplete = workerResult.status === "IMPLEMENTATION_COMPLETE" && workerResult.complete !== false;
  if (!workerComplete) return { accepted: false, result: "WORKER_INCOMPLETE", owner: "terra", workerComplete };
  const scopeContract = details.scopeContract ?? {};
  const requiredTests = Array.isArray(details.requiredTests)
    ? details.requiredTests
    : (Array.isArray(scopeContract.testsRequired) ? scopeContract.testsRequired : []);
  const evidence = Array.isArray(details.evidence) ? details.evidence : [];
  let evidenceComplete;
  let evidenceContract = null;
  if (Array.isArray(scopeContract.requiredEvidence) && scopeContract.requiredEvidence.length > 0) {
    const activeState = {
      ...(details.activeState || {}),
      taskId: details.activeState?.taskId || details.taskId || null,
      attempt: Number.isInteger(details.activeState?.attempt) ? details.activeState.attempt : (Number.isInteger(details.attempt) ? details.attempt : 0),
      mutationSeq: Number.isInteger(details.activeState?.mutationSeq) ? details.activeState.mutationSeq : (Number.isInteger(details.mutationSeq) ? details.mutationSeq : 0),
      evidenceLedger: Array.isArray(details.evidenceLedger) ? details.evidenceLedger : evidence,
    };
    evidenceContract = verifyEvidenceContract({
      activeState,
      contract: scopeContract,
      evidenceLedger: activeState.evidenceLedger,
    });
    evidenceComplete = evidenceContract.verified === true;
  } else {
    evidenceComplete = requiredTests.every((command) => evidenceForCommand(evidence, command));
  }
  if (!evidenceComplete) return { accepted: false, result: "EVIDENCE_INCOMPLETE", owner: "terra", workerComplete, evidenceComplete, evidenceContract };
  const scope = validateScopeContract(scopeContract, details.changedPaths ?? []);
  if (!scope.valid) return { accepted: false, result: "SCOPE_VIOLATION", owner: "terra", workerComplete, evidenceComplete, scope };
  if (requiresIntegration(details) && details.integrated !== true) {
    return { accepted: false, result: "INTEGRATION_REQUIRED", owner: "terra", workerComplete, evidenceComplete, scope };
  }
  return { accepted: true, result: "ACCEPTED", owner: "terra", workerComplete, evidenceComplete, scope };
}

export const acceptanceGate = createAcceptanceGate;

export function createCriticalReviewPacket(details = {}) {
  return {
    criticality: "CRITICAL",
    independent: true,
    owner: "sol",
    profile: "sol-low",
    model: CODEX_MODELS.SOL_LOW.model,
    goal: details.goal ?? null,
    acceptanceCriteria: details.acceptanceCriteria ?? [],
    decision: details.decision ?? null,
    relevantDiff: details.relevantDiff ?? [],
    evidence: details.evidence ?? [],
    risks: details.risks ?? [],
  };
}

export const createIndependentReviewPacket = createCriticalReviewPacket;

export function evaluateCriticalReview(packet = {}, verdict) {
  const normalized = normalizeToken(verdict);
  if (["ACCEPT", "ACCEPT_WITH_NOTES"].includes(normalized)) return { accepted: true, result: normalized, owner: "terra" };
  if (["CHANGES_REQUIRED", "BLOCK"].includes(normalized)) return { accepted: false, result: normalized, owner: "terra", findingsReturned: true };
  return { accepted: false, result: "INVALID_REVIEW", owner: "terra", packet };
}

export function reviewRoute(facts = {}) {
  const request = facts.crossDomainRequest;
  if (request?.type === CROSS_DOMAIN_REQUEST) {
    return routeFor("TERRA_MEDIUM", { reason: "cross-domain-request", controlReturned: true, crossDomainRequest: request });
  }
  if (facts.scopeViolation === true || facts.scope?.valid === false) {
    return routeFor("TERRA_MEDIUM", { reason: "scope-violation", scopeViolation: true, replanRequired: true });
  }
  const verdict = normalizeToken(facts.reviewerVerdict ?? facts.reviewVerdict);
  if (["CHANGES_REQUIRED", "BLOCK"].includes(verdict)) {
    return routeFor("TERRA_MEDIUM", { reason: "review-findings-returned", findingsReturned: true, implementationExecutor: "luna-max" });
  }
  const workerResult = facts.workerResult ?? {};
  const incomplete = workerResult.complete === false || workerResult.status === "PARTIAL" || workerResult.status === "INCOMPLETE";
  if (incomplete) {
    const budget = createRetryBudget(facts);
    if (budget.remainingAttempts <= 0) {
      return routeFor("TERRA_MEDIUM", { reason: "retry-budget-exhausted", retryAllowed: false, replanRequired: true, remainingAttempts: 0 });
    }
    const route = decideRoute({ taskAction: facts.taskAction ?? "IMPLEMENT", implementationComplexity: facts.implementationComplexity, taskDomain: facts.taskDomain });
    if (!route.valid || !["luna-high", "luna-max"].includes(route.profile)) return routeFor("TERRA_MEDIUM", { reason: "retry-needs-reclassification", replanRequired: true });
    const nextBudget = consumeRetryBudget(facts);
    return { ...route, reason: "bounded-delta-retry", retry: true, retryReason: facts.retryReason ?? "INCOMPLETE_IMPLEMENTATION", remainingAttempts: nextBudget.remainingAttempts, attempt: nextBudget.attempt };
  }
  if (normalizeCriticality(facts) === "CRITICAL" && !verdict) return decideRoute({ ...facts, taskAction: "REVIEW" });
  return routeFor("TERRA_MEDIUM", { reason: "acceptance-review" });
}

export function validateStateTransition(fromState, toState) {
  const from = normalizeToken(fromState);
  const to = normalizeToken(toState);
  if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, from) || !STATE_NAMES.includes(to)) {
    return { valid: false, error: "INVALID_TRANSITION", from, to };
  }
  const valid = VALID_TRANSITIONS[from].includes(to);
  return { valid, error: valid ? null : "INVALID_TRANSITION", from, to };
}

/* =========================================================================
   Command Result Truthfulness
   ========================================================================= */

/**
 * A deliberately small provider-native result boundary.  A command's exit
 * status is never inferred from its output (and a missing status is never
 * treated as success).  Consumers should pass this object to
 * evaluateCommandResult before making a factual claim about the repository.
 */
export function createCommandResult(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const commandValue = firstPresent(source, ["command", "cmd"]);
  const command = typeof commandValue === "string" ? commandValue.trim() : "";
  const rawExitCode = firstPresent(source, ["exit_code", "exitCode"]);
  const parsedExitCode = rawExitCode === null || rawExitCode === undefined || rawExitCode === ""
    ? null
    : Number(rawExitCode);
  const hasExitCode = Number.isInteger(parsedExitCode);
  const toolError = firstPresent(source, [
    "tool_error", "toolError", "execution_error", "executionError", "spawn_error", "spawnError", "error",
  ]);
  const hasToolError = toolError !== undefined && toolError !== null && String(toolError).trim() !== "";
  const executionStatus = normalizeToken(firstPresent(source, ["status", "executionStatus", "execution_status"]));
  const statusFailure = ["FAILED", "ERROR", "TOOL_FAILURE", "BLOCKED"].includes(executionStatus);
  const explicitSuccess = firstPresent(source, ["success"]);
  const successExpected = hasExitCode && parsedExitCode === 0;
  const contradictorySuccess = typeof explicitSuccess === "boolean" && explicitSuccess !== successExpected;
  const toolFailure = source.toolFailure === true
    || source.tool_failure === true
    || hasToolError
    || statusFailure
    || contradictorySuccess
    || !hasExitCode;
  const explicitToolFailure = source.toolFailure === true
    || source.tool_failure === true
    || hasToolError
    || statusFailure
    || contradictorySuccess;

  const stdoutKey = hasOwn(source, "stdout") ? "stdout" : (hasOwn(source, "output") ? "output" : null);
  const explicitStdoutAvailability = firstPresent(source, ["stdout_available", "stdoutAvailable"]);
  const stdoutAvailable = typeof explicitStdoutAvailability === "boolean"
    ? explicitStdoutAvailability
    : (stdoutKey !== null && typeof source[stdoutKey] === "string");
  const stdout = stdoutKey !== null && typeof source[stdoutKey] === "string" ? source[stdoutKey] : "";
  const stderrValue = firstPresent(source, ["stderr_excerpt", "stderrExcerpt", "stderr"]);
  const stderrExcerpt = typeof stderrValue === "string" ? stderrValue.slice(0, 1000) : "";
  const success = !toolFailure && parsedExitCode === 0;

  return {
    command,
    exit_code: hasExitCode ? parsedExitCode : null,
    exitCode: hasExitCode ? parsedExitCode : null,
    success,
    stdout_available: stdoutAvailable,
    stdoutAvailable,
    stdout,
    stderr_excerpt: stderrExcerpt,
    stderrExcerpt,
    tool_failure: toolFailure,
    toolFailure,
    explicit_tool_failure: explicitToolFailure,
    explicitToolFailure,
    semantic_result: "UNKNOWN",
    semanticResult: "UNKNOWN",
    blocked: true,
  };
}

export const normalizeCommandResult = createCommandResult;

function commandOperation(operation, command = "") {
  const token = normalizeToken(operation);
  const aliases = {
    STATUS: "SHOW_STATUS",
    GIT_STATUS: "SHOW_STATUS",
    SHOW_STATUS: "SHOW_STATUS",
    DIFF: "SHOW_DIFF",
    GIT_DIFF: "SHOW_DIFF",
    SHOW_DIFF: "SHOW_DIFF",
    TEST: "RUN_TEST",
    RUN_TEST: "RUN_TEST",
    TESTS: "RUN_TEST",
    TYPECHECK: "RUN_TYPECHECK",
    RUN_TYPECHECK: "RUN_TYPECHECK",
    BUILD: "RUN_BUILD",
    RUN_BUILD: "RUN_BUILD",
    SCRIPT: "RUN_SCRIPT",
    RUN_SCRIPT: "RUN_SCRIPT",
    RUN_PROJECT_SCRIPT: "RUN_SCRIPT",
    COMMIT: "COMMIT",
    PUSH: "PUSH",
    COMMIT_PUSH: "COMMIT_PUSH",
  };
  if (aliases[token]) return aliases[token];
  const text = String(command || "").trim();
  if (/\bgit\s+status\b/.test(text)) return "SHOW_STATUS";
  if (/\bgit\s+diff\b/.test(text)) return "SHOW_DIFF";
  if (/\bgit\s+commit\b/.test(text)) return "COMMIT";
  if (/\bgit\s+push\b/.test(text)) return "PUSH";
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest)\b/.test(text)) return "RUN_TEST";
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?typecheck\b|\btsc\b/.test(text)) return "RUN_TYPECHECK";
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/.test(text)) return "RUN_BUILD";
  return null;
}

function commandFailureSemantic(operation, commandResult) {
  if (!commandResult.command && !commandResult.explicitToolFailure) return "UNKNOWN";
  if (commandResult.toolFailure || !Number.isInteger(commandResult.exit_code)) {
    if (["SHOW_STATUS", "SHOW_DIFF"].includes(operation)) return "UNKNOWN";
    return "TOOL_FAILURE";
  }
  if (commandResult.exit_code === 0) return null;
  switch (operation) {
    case "RUN_TEST": return "TEST_FAILED";
    case "RUN_TYPECHECK": return "TYPECHECK_FAILURE";
    case "RUN_BUILD": return "BUILD_FAILURE";
    case "RUN_SCRIPT": return "COMMAND_FAILED";
    case "COMMIT": return "COMMIT_FAILED";
    case "PUSH": return "PUSH_FAILED";
    default: return "UNKNOWN";
  }
}

function withCommandSemantic(commandResult, semanticResult, extras = {}) {
  const blocked = semanticResult === "UNKNOWN" || semanticResult === "TOOL_FAILURE";
  return {
    ...commandResult,
    ...extras,
    semantic_result: semanticResult,
    semanticResult: semanticResult,
    blocked,
  };
}

function verifiedCommitHash(source, stdout) {
  const explicit = firstPresent(source, ["commit_hash", "commitHash", "verified_commit_hash", "verifiedCommitHash"]);
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  // Parsing a hash printed by a successful git command is observation, not
  // synthesis.  Never run this path for a failed or unavailable command.
  const match = String(stdout || "").match(/\[[^\]\s]+\s+([0-9a-f]{7,40})\]/i);
  return match ? match[1] : null;
}

/**
 * Turn a raw provider result into a semantic fact only when both execution
 * succeeded and the operation's expected output semantics are available.
 * Unknown, malformed, or sandbox/tool failures fail closed.
 */
export function evaluateCommandResult(input = {}, operation = undefined) {
  const source = input && typeof input === "object" ? input : {};
  const requestedOperation = commandOperation(
    operation ?? firstPresent(source, ["operation", "directAction", "direct_action"]),
    firstPresent(source, ["command", "cmd"]),
  );

  if (requestedOperation === "COMMIT_PUSH") {
    const commitSource = firstPresent(source, ["commitResult", "commit_result"]);
    const pushSource = firstPresent(source, ["pushResult", "push_result"]);
    if (!commitSource || !pushSource) {
      return withCommandSemantic(createCommandResult(source), "UNKNOWN", {
        commitCreated: false,
        commitHash: null,
        pushSucceeded: false,
      });
    }
    const commit = evaluateCommandResult(commitSource, "COMMIT");
    const push = evaluateCommandResult(pushSource, "PUSH");
    const commitCreated = commit.semantic_result === "COMMITTED";
    const commitHash = commitCreated ? commit.commitHash : null;
    const pushSucceeded = push.semantic_result === "PUSH_SUCCEEDED";
    let semantic = "UNKNOWN";
    if (commitCreated && pushSucceeded) semantic = "COMMIT_PUSH_SUCCEEDED";
    else if (commitCreated && !pushSucceeded) semantic = "PARTIAL_SUCCESS";
    else if (commit.semantic_result === "COMMIT_FAILED" && push.semantic_result === "PUSH_FAILED") semantic = "COMMIT_PUSH_FAILED";
    else if (commit.semantic_result === "TOOL_FAILURE" || push.semantic_result === "TOOL_FAILURE") semantic = "TOOL_FAILURE";
    return {
      ...createCommandResult({ command: "git commit && git push", exit_code: semantic === "COMMIT_PUSH_SUCCEEDED" ? 0 : 1, stdout: "", stdout_available: true }),
      semantic_result: semantic,
      semanticResult: semantic,
      blocked: semantic === "UNKNOWN" || semantic === "TOOL_FAILURE",
      commitCreated,
      commitHash,
      pushSucceeded,
      commitResult: commit,
      pushResult: push,
    };
  }

  const result = createCommandResult(source);
  const inferredOperation = commandOperation(undefined, result.command);
  const operationName = requestedOperation ?? inferredOperation;
  if (!operationName || (requestedOperation && inferredOperation && requestedOperation !== inferredOperation)) {
    return withCommandSemantic(result, "UNKNOWN", { commitCreated: false, commitHash: null, pushSucceeded: false });
  }

  const failure = commandFailureSemantic(operationName, result);
  if (failure) {
    return withCommandSemantic(result, failure, {
      commitCreated: false,
      commitHash: null,
      pushSucceeded: false,
    });
  }

  if (operationName === "SHOW_STATUS") {
    if (!result.stdout_available) return withCommandSemantic(result, "UNKNOWN");
    return withCommandSemantic(result, result.stdout.length === 0 ? "CLEAN" : "DIRTY", {
      clean: result.stdout.length === 0,
    });
  }
  if (operationName === "SHOW_DIFF") {
    if (!result.stdout_available) return withCommandSemantic(result, "UNKNOWN");
    return withCommandSemantic(result, result.stdout.length === 0 ? "NO_CHANGES" : "CHANGES_PRESENT", {
      changesPresent: result.stdout.length > 0,
    });
  }
  if (operationName === "RUN_TEST") return withCommandSemantic(result, "PASS");
  if (operationName === "RUN_TYPECHECK") return withCommandSemantic(result, "PASS");
  if (operationName === "RUN_BUILD") return withCommandSemantic(result, "PASS");
  if (operationName === "RUN_SCRIPT") return withCommandSemantic(result, "SUCCESS");
  if (operationName === "COMMIT") {
    const hash = verifiedCommitHash(source, result.stdout);
    if (!hash) return withCommandSemantic(result, "COMMIT_UNVERIFIED", { commitCreated: false, commitHash: null });
    return withCommandSemantic(result, "COMMITTED", { commitCreated: true, commitHash: hash });
  }
  if (operationName === "PUSH") {
    if (source.pushSucceeded === false || source.push_succeeded === false) {
      return withCommandSemantic(result, "PUSH_FAILED", { pushSucceeded: false });
    }
    return withCommandSemantic(result, "PUSH_SUCCEEDED", { pushSucceeded: true });
  }
  return withCommandSemantic(result, "UNKNOWN");
}

export const assessCommandResult = evaluateCommandResult;

function parseCodexExecEvents(eventsInput) {
  if (Array.isArray(eventsInput)) return eventsInput;
  if (typeof eventsInput === "string") {
    const events = [];
    for (const line of eventsInput.split(/\r?\n/).filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        return null;
      }
    }
    return events;
  }
  if (eventsInput && typeof eventsInput === "object") return [eventsInput];
  return null;
}

function modelConclusionMatches(operation, semantic, message) {
  if (!message) return true;
  const text = String(message);
  switch (operation) {
    case "SHOW_STATUS":
      return semantic === "CLEAN"
        ? /\bclean\b/i.test(text)
        : semantic === "DIRTY" && /\b(?:dirty|change|modified|untracked|staged)\b/i.test(text);
    case "SHOW_DIFF":
      return semantic === "NO_CHANGES"
        ? /\b(?:no changes|no diff|clean)\b/i.test(text)
        : semantic === "CHANGES_PRESENT" && /\b(?:change|diff|modified|staged|untracked)\b/i.test(text);
    case "RUN_TEST": return semantic === "PASS" ? /\bpass(?:ed)?\b/i.test(text) : /\b(?:fail|error|blocked|unable)\b/i.test(text);
    case "RUN_TYPECHECK": return semantic === "PASS" ? /\bpass|no errors|success/i.test(text) : /\b(?:fail|error|blocked|unable)\b/i.test(text);
    case "RUN_BUILD": return semantic === "PASS" ? /\bpass|success|built|complete/i.test(text) : /\b(?:fail|error|blocked|unable)\b/i.test(text);
    default: return true;
  }
}

/**
 * Validate the command and final message emitted by `codex exec --json`.
 * The message is advisory only: a failed command always wins and produces a
 * deterministic blocker report, so an optimistic model sentence cannot turn
 * an exit-182 event into a repository fact.
 */
export function evaluateCodexExecEvents(eventsInput, operation = undefined) {
  const events = parseCodexExecEvents(eventsInput);
  const commandItems = Array.isArray(events)
    ? events.map((event) => event?.item ?? event).filter((item) => item?.type === "command_execution")
    : [];
  const messageItems = Array.isArray(events)
    ? events.map((event) => event?.item ?? event).filter((item) => item?.type === "agent_message")
    : [];
  const lastCommand = commandItems.at(-1);
  const modelConclusion = messageItems.at(-1)?.text ?? "";
  if (!lastCommand) {
    const unknown = evaluateCommandResult({}, operation);
    return {
      ...unknown,
      modelConclusion,
      modelConclusionTrusted: false,
      report: "Unable to determine repository status because the command failed.",
    };
  }
  const raw = {
    command: lastCommand.command,
    exit_code: lastCommand.exit_code,
    stdout: typeof lastCommand.aggregated_output === "string"
      ? lastCommand.aggregated_output
      : (typeof lastCommand.stdout === "string" ? lastCommand.stdout : ""),
    stdout_available: hasOwn(lastCommand, "aggregated_output") || hasOwn(lastCommand, "stdout"),
    stderr_excerpt: lastCommand.stderr_excerpt ?? lastCommand.stderr ?? "",
    tool_error: lastCommand.error ?? lastCommand.tool_error,
    status: lastCommand.status,
  };
  const evaluated = evaluateCommandResult(raw, operation);
  const operationName = commandOperation(operation, raw.command);
  const modelConclusionTrusted = !modelConclusion
    ? !evaluated.blocked
    : !evaluated.blocked && modelConclusionMatches(operationName, evaluated.semantic_result, modelConclusion);
  let report = modelConclusion;
  if (evaluated.semantic_result === "UNKNOWN" || evaluated.semantic_result === "TOOL_FAILURE") {
    report = operationName === "SHOW_STATUS"
      ? "Unable to determine repository status because the command failed."
      : "Unable to determine the requested result because the command failed.";
  } else if (operationName === "SHOW_STATUS") {
    report = evaluated.semantic_result === "CLEAN" ? "Working tree clean." : "Working tree has changes.";
  } else if (operationName === "SHOW_DIFF") {
    report = evaluated.semantic_result === "NO_CHANGES" ? "No changes." : "Changes present.";
  }
  return { ...evaluated, modelConclusion, modelConclusionTrusted, report };
}

export const evaluateCodexExecJson = evaluateCodexExecEvents;

export function evaluateDirectAction(details = {}) {
  if (!isDirectAction(details)) return { complete: false, result: "NOT_DIRECT_ACTION" };
  const operation = commandOperation(firstPresent(details, ["operation", "directAction", "direct_action"]));
  const rawResult = firstPresent(details, ["commandResult", "command_result"])
    ?? (hasOwn(details, "command") ? details : null);
  const evaluated = evaluateCommandResult(rawResult ?? {}, operation);
  const successfulSemantics = {
    SHOW_STATUS: new Set(["CLEAN", "DIRTY"]),
    SHOW_DIFF: new Set(["NO_CHANGES", "CHANGES_PRESENT"]),
    RUN_TEST: new Set(["PASS"]),
    RUN_TYPECHECK: new Set(["PASS"]),
    RUN_BUILD: new Set(["PASS"]),
    RUN_SCRIPT: new Set(["SUCCESS"]),
    COMMIT: new Set(["COMMITTED"]),
    PUSH: new Set(["PUSH_SUCCEEDED"]),
    COMMIT_PUSH: new Set(["COMMIT_PUSH_SUCCEEDED"]),
  };
  if (!successfulSemantics[operation]?.has(evaluated.semantic_result)) {
    return {
      complete: false,
      result: "DIRECT_ACTION_BLOCKED",
      status: "UNKNOWN",
      report: "blocker",
      commandResult: evaluated,
    };
  }
  return {
    complete: true,
    result: "DIRECT_ACTION_COMPLETE",
    status: "KNOWN",
    report: "compact",
    commandResult: evaluated,
  };
}

export const evaluateDirectActionResult = evaluateDirectAction;

export function isDirectAction(facts = {}) {
  return normalizeTaskAction(facts) === "DIRECT_ACTION"
    && DIRECT_ACTION_SET.has(normalizeToken(firstPresent(facts, ["operation", "directAction", "direct_action"])));
}

export function validateWorkerCompletion(result = {}) {
  const required = ["status", "changedFiles", "changeSummary", "validation", "risks", "blockers", "scopeResult"];
  const missing = required.filter((field) => !(field in result));
  return {
    valid: result.status === "IMPLEMENTATION_COMPLETE" && missing.length === 0,
    missing,
  };
}

export function canWorkerSpawn(profile) {
  return false;
}

export function canWorkerAccept(profile) {
  return normalizeToken(profile).startsWith("TERRA");
}

export function directWriteDecision(facts = {}) {
  const action = normalizeTaskAction(facts);
  if (facts.controlPlaneWork === true && facts.productWork !== true && ["ORCHESTRATE", "REVIEW", "ESCALATE"].includes(action)) {
    return { allowed: true, reason: "control-plane" };
  }
  const mechanical = action === "MECHANICAL_FIX"
    && facts.productWork !== true
    && facts.changedFiles === 1
    && facts.changedLines <= 3
    && facts.deterministic === true
    && facts.behavioralChange !== true
    && facts.technicalDecision !== true;
  if (mechanical) return { allowed: true, reason: "mechanical-trivial-threshold" };
  return { allowed: false, reason: action === "UNKNOWN" ? "unknown-action" : "product-work-requires-luna" };
}

export function createImplementationHandoff(details = {}) {
  const scopeContract = createScopeContract({
    ...details,
    taskAction: "IMPLEMENT",
    taskDomain: details.taskDomain,
  });
  return {
    taskAction: "IMPLEMENT",
    taskDomain: scopeContract.taskDomain,
    executor: "luna",
    owner: "luna",
    profile: "luna-max",
    model: CODEX_MODELS.LUNA_MAX.model,
    reasoningEffort: CODEX_MODELS.LUNA_MAX.reasoningEffort,
    task: details.task ?? null,
    goal: details.goal ?? null,
    packetFormat: ["goal", "taskDomain", "allowedPaths", "forbiddenPaths", "decision", "acceptanceCriteria", "testsRequired", "requiredEvidence", "sideEffectCapabilities", "stopConditions", "knownRisks"],
    knownRisks: details.knownRisks ?? details.risks ?? [],
    rootCauseDecision: details.rootCauseDecision ?? details.decision ?? null,
    files: details.files ?? details.areas ?? [],
    constraints: details.constraints ?? [],
    implementationPlan: details.implementationPlan ?? [],
    acceptanceCriteria: details.acceptanceCriteria ?? [],
    testsRequired: details.testsRequired ?? [],
    requiredEvidence: details.requiredEvidence ?? [],
    sideEffectCapabilities: details.sideEffectCapabilities ?? details.side_effect_capabilities ?? [],
    doNotChange: details.doNotChange ?? [],
    scopeContract,
  };
}

export function createTelemetryEvent(input = {}, decision = null) {
  const route = decision ?? input.decision ?? null;
  const action = normalizeTaskAction(input);
  const implementationExecutor = action === "IMPLEMENT" ? (route?.owner ?? null) : null;
  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    runtime: "CODEX",
    task_action: action,
    task_domain: normalizeTaskDomain(input),
    worker_model: route?.model ?? null,
    worker_effort: route?.reasoningEffort ?? null,
    implementation_executor: implementationExecutor,
    orchestrator_direct_write: input.orchestratorDirectWrite === true,
    direct_write_reason: input.directWriteReason ?? null,
    retry_budget: input.retryBudget ?? null,
    attempt_number: input.attemptNumber ?? null,
    attempts_exhausted: input.attemptsExhausted === true,
    acceptance_result: input.acceptanceResult ?? null,
    integration_required: requiresIntegration(input),
    criticality: normalizeCriticality(input),
    independent_review_model: input.independentReviewModel ?? (normalizeCriticality(input) === "CRITICAL" ? CODEX_MODELS.SOL_LOW.model : null),
    independent_review_result: input.independentReviewResult ?? null,
  };
}

export function summarizePolicyDrift(events = []) {
  const implementations = events.filter((event) => event?.task_action === "IMPLEMENT");
  const luna = implementations.filter((event) => ["luna", "luna-high", "luna-max"].includes(event.implementation_executor));
  const terra = implementations.filter((event) => ["terra", "terra-medium"].includes(event.implementation_executor));
  const total = implementations.length;
  const lunaRate = total === 0 ? 0 : luna.length / total;
  const terraRate = total === 0 ? 0 : terra.length / total;
  return {
    totalImplementations: total,
    lunaImplementations: luna.length,
    terraDirectImplementations: terra.length,
    lunaImplementationRate: lunaRate,
    terraDirectImplementationRate: terraRate,
    drift: total > 0 && (lunaRate <= 0.85 || terraRate >= 0.1),
    diagnostic: total > 0 && (lunaRate <= 0.85 || terraRate >= 0.1) ? "ORCHESTRATION_POLICY_DRIFT" : null,
  };
}

/**
 * Scan only Codex operational files. The scanner deliberately does not scan
 * tests or the AGY tree, where negative fixtures and provider-specific code
 * are expected. It catches active foreign imports/routes while allowing the
 * explicit skill-disablement entries in config.toml.
 */
export function scanCodexOperationalFiles(cwd = process.cwd()) {
  const root = resolve(cwd);
  const codexDir = existsSync(join(root, ".codex"))
    ? join(root, ".codex")
    : (existsSync(join(root, "runtimes", "codex", ".codex")) ? join(root, "runtimes", "codex", ".codex") : join(root, ".codex"));
  const files = [
    join(codexDir, "config.toml"),
    join(codexDir, "astra-orchestra", "INSTRUCTIONS.md"),
  ];
  const orchestraDir = join(codexDir, "astra-orchestra");
  if (existsSync(orchestraDir)) {
    for (const name of readdirSync(orchestraDir).filter((entry) => entry.endsWith(".mjs") && !entry.endsWith(".test.mjs"))) {
      files.push(join(orchestraDir, name));
    }
  }
  const agentsDir = join(codexDir, "agents");
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).filter((entry) => entry.endsWith(".toml"))) files.push(join(agentsDir, name));
  }
  const violations = [];
  const activeForeignPatterns = [
    /(?:from|import)\s+["'][^"']*\.agents[\\/]skills[\\/]agy-orchestra/i,
    /(?:model|executor)\s*[:=]\s*["']gemini-/i,
    /(?:executor|worker|profile)\s*[:=]\s*["']flash-(?:worker|orchestrator)/i,
    /ALL-GEMINI\s+Architecture/i,
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of activeForeignPatterns) {
      if (pattern.test(text)) violations.push({ file: relative(root, file), pattern: pattern.source });
    }
  }
  return { valid: violations.length === 0, checked: files.filter(existsSync).length, violations };
}

/**
 * Verify the project layer disables every AGY-only skill discovered under
 * `.agents/skills`.  This is deliberately a static check of the official
 * `[[skills.config]]` name selectors; it does not load or execute the skill.
 */
export function scanCodexSkillIsolation(cwd = process.cwd()) {
  const root = resolve(cwd);
  const configPath = existsSync(join(root, ".codex", "config.toml"))
    ? join(root, ".codex", "config.toml")
    : (existsSync(join(root, "runtimes", "codex", ".codex", "config.toml"))
        ? join(root, "runtimes", "codex", ".codex", "config.toml")
        : join(root, ".codex", "config.toml"));
  if (!existsSync(configPath)) {
    return { valid: false, configPath: relative(root, configPath), disabled: [], missing: [...AGY_ONLY_SKILL_NAMES] };
  }
  const config = readFileSync(configPath, "utf8");
  const skillBlocks = config.split("[[skills.config]]").slice(1);
  const disabled = AGY_ONLY_SKILL_NAMES.filter((name) => {
    return skillBlocks.some((block) => block.includes(`name = "${name}"`)
      && /\benabled\s*=\s*false\b/m.test(block));
  });
  const missing = AGY_ONLY_SKILL_NAMES.filter((name) => !disabled.includes(name));
  return { valid: missing.length === 0, configPath: relative(root, configPath), disabled, missing };
}

export const isCodexRoute = (route) => validateCodexRoute(route).valid;

if (process.argv.includes("--json")) {
  let payload = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { payload += chunk; });
  process.stdin.on("end", () => {
    try {
      process.stdout.write(`${JSON.stringify(decideRoute(JSON.parse(payload)))}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(invalidRoute("INVALID_JSON", { message: error.message }))}\n`);
      process.exitCode = 1;
    }
  });
}
