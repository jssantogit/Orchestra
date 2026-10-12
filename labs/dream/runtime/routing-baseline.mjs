// Dream is an observational Lab. This module intentionally contains only the
// dependency-free routing primitives needed to reconstruct its static baseline.
// It must not import a provider runtime or acquire provider/control-plane authority.

export const GEMINI_MODELS = Object.freeze({
  ORCHESTRATOR: "gemini-3.8-flash-medium",
  WORKER_HIGH: "gemini-3.8-flash-high",
  WORKER_MEDIUM: "gemini-3.8-flash-medium",
  WORKER_LOW: "gemini-3.8-flash-low",
  INVESTIGATOR: "gemini-3.8-flash-high",
});

const TASK_DOMAINS = new Set([
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

const LEGACY_TASK_CLASS_ACTIONS = Object.freeze({
  TRIVIAL_CHANGE: "IMPLEMENT",
  MECHANICAL_CHANGE: "MECHANICAL_FIX",
  DOCUMENTATION: "IMPLEMENT",
  CONVENTIONAL_IMPLEMENTATION: "IMPLEMENT",
  HARD_SPECIFIED_IMPLEMENTATION: "IMPLEMENT",
  DEEP_TECHNICAL_INVESTIGATION: "INVESTIGATE",
  HEAVY_EXECUTION: "HEAVY_EXECUTION",
});

const ACTIONS = new Set([
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

function normalizeToken(value) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstPresent(facts, keys) {
  if (!facts || typeof facts !== "object") return undefined;
  for (const key of keys) {
    if (hasOwn(facts, key) && facts[key] !== undefined && facts[key] !== null) return facts[key];
  }
  return undefined;
}

export function canonicalTaskDomain(value) {
  const token = normalizeToken(value);
  return TASK_DOMAIN_ALIASES[token] ?? (TASK_DOMAINS.has(token) ? token : "GENERAL");
}

export function normalizeTaskDomain(facts = {}) {
  if (typeof facts === "string") return canonicalTaskDomain(facts);
  return canonicalTaskDomain(firstPresent(facts, ["taskDomain", "task_domain", "domain"]));
}

export function normalizeCriticality(facts = {}) {
  const value = typeof facts === "string"
    ? facts
    : firstPresent(facts, ["criticality", "criticalityLevel", "riskLevel"]);
  const token = normalizeToken(value);
  if (["CRITICAL", "SEVERE", "DESTRUCTIVE", "RELEASE_CRITICAL"].includes(token)) return "CRITICAL";
  if (["HIGH", "IMPORTANT", "SIGNIFICANT", "MAJOR"].includes(token)) return "MAJOR";
  return "NORMAL";
}

function canonicalAction(value) {
  const token = normalizeToken(value);
  return ACTION_ALIASES[token] ?? (ACTIONS.has(token) ? token : "UNKNOWN");
}

function taskActionInfo(facts = {}) {
  const explicitKey = ["taskAction", "nextTaskAction", "action"].find((key) => hasOwn(facts, key));
  if (explicitKey) return { action: canonicalAction(facts[explicitKey]), source: explicitKey };
  if (hasOwn(facts, "taskClass")) {
    const taskClass = normalizeToken(facts.taskClass);
    return { action: LEGACY_TASK_CLASS_ACTIONS[taskClass] ?? "UNKNOWN", source: "taskClass", taskClass };
  }
  return { action: null, source: null };
}

export function normalizeTaskAction(facts = {}) {
  return taskActionInfo(facts).action ?? "UNKNOWN";
}

export function classifyDirectActionIntent(textOrPrompt) {
  if (typeof textOrPrompt !== "string") return { isDirectAction: false, type: null, reason: "non_string_input" };
  const raw = textOrPrompt.trim().toLowerCase();
  if (!raw) return { isDirectAction: false, type: null, reason: "empty_intent" };

  const disqualifiers = [
    /\b(?:corrija|corrigir|conserta|consertar|fix|fixe)\b/,
    /\b(?:bug|erro|erros|error|errors|falha|falhas)\b/,
    /\b(?:analise|analisar|analyze|investigue|investigar|investigate)\b/,
    /\b(?:se\s+estiver|se\s+passar|if\s+ok|if\s+clean|if\s+ready)\b/,
    /\b(?:depois|em\s+seguida|após|after|then)\b/,
    /\b(?:implemente|implementar|implement|adicione|adicionar|add|crie|criar|create|remova|remover|remove)\b/,
    /\b(?:refatore|refatorar|refactor)\b/,
    /\b(?:ajuste|ajustar|altere|alterar|modifique|modificar)\b/,
  ];
  for (const pattern of disqualifiers) {
    if (pattern.test(raw)) return { isDirectAction: false, type: null, reason: "compound_intent_requires_technical_work" };
  }

  if (/\b(?:commita\s+e\s+pusha|commit\s+(?:and|&)\s+push|commitar\s+e\s+pushar|commita\s+e\s+envia|commit\s+e\s+push)\b/.test(raw)
    || (/\b(?:commit|commita|commitar)\b/.test(raw) && /\b(?:push|pusha|pushar)\b/.test(raw))) {
    return { isDirectAction: true, type: "GIT_COMMIT_PUSH", reason: "explicit_commit_push" };
  }
  if (/\b(?:mostra|mostre|veja|ver)?\s*(?:o\s+)?git\s+status\b/.test(raw) || /^git\s+status$/i.test(raw) || /^status$/i.test(raw)) {
    return { isDirectAction: true, type: "GIT_STATUS", reason: "explicit_git_status" };
  }
  if (/\b(?:mostra|mostre|veja|ver)?\s*(?:o\s+)?git\s+diff\b/.test(raw) || /^git\s+diff$/i.test(raw) || /^diff$/i.test(raw)) {
    return { isDirectAction: true, type: "GIT_DIFF", reason: "explicit_git_diff" };
  }
  if (/\b(?:commita|commitar|faça\s+o\s+commit|fazer\s+o\s+commit|commit)\b/.test(raw) && !/\b(?:push|pusha|pushar)\b/.test(raw)) {
    return { isDirectAction: true, type: "GIT_COMMIT", reason: "explicit_git_commit" };
  }
  if (/\b(?:pusha|pushar|faça\s+o\s+push|fazer\s+o\s+push|push)\b/.test(raw) && !/\b(?:commit|commita|commitar)\b/.test(raw)) {
    return { isDirectAction: true, type: "GIT_PUSH", reason: "explicit_git_push" };
  }
  if (/\b(?:roda|rode|rodar|run|executa|executar)?\s*(?:o\s+)?typecheck\b/.test(raw) || /^typecheck$/i.test(raw)) {
    return { isDirectAction: true, type: "RUN_TYPECHECK", reason: "explicit_typecheck" };
  }
  if (/\b(?:roda|rode|rodar|run|executa|executar|faça\s+o|fazer\s+o)?\s*(?:o\s+)?build\b/.test(raw) || /^build$/i.test(raw)) {
    return { isDirectAction: true, type: "RUN_BUILD", reason: "explicit_build" };
  }
  if (/\b(?:roda|rode|rodar|run|executa|executar)\s*(?:os\s+|o\s+)?(?:testes?|tests?)\b/.test(raw) || /^testes?$/i.test(raw) || /^run\s+tests?$/i.test(raw)) {
    return { isDirectAction: true, type: "RUN_TEST", reason: "explicit_test" };
  }
  if (/\b(?:executa|executar|roda|rode|rodar|run)\s+(?:esse\s+|o\s+)?script\b/.test(raw) || /\b(?:execute|run)\s+script\b/.test(raw)) {
    return { isDirectAction: true, type: "RUN_PROJECT_SCRIPT", reason: "explicit_project_script" };
  }
  return { isDirectAction: false, type: null, reason: "unmapped_or_ambiguous_intent" };
}

function normalizeComplexity(value) {
  const token = normalizeToken(value);
  if (["SIMPLE", "TRIVIAL", "SMALL", "LOW"].includes(token)) return "simple";
  if (["EXPERIMENTAL", "RESEARCH", "INVESTIGATIVE", "EXPERIMENT"].includes(token)) return "experimental";
  if (["DIFFICULT", "HARD", "COMPLEX", "LARGE", "MAX", "VERY_HARD"].includes(token)) return "difficult";
  return "normal";
}

function implementationComplexity(facts = {}) {
  const explicit = firstPresent(facts, ["implementationComplexity", "implementationDifficulty", "difficulty", "complexity"]);
  if (explicit === undefined && normalizeTaskDomain(facts) === "DOCS") return "simple";
  return normalizeComplexity(explicit);
}

function defaultRetryAttempts(facts = {}) {
  const complexity = implementationComplexity(facts);
  if (facts.experimental === true || facts.investigative === true || normalizeTaskAction(facts) === "INVESTIGATE" || complexity === "experimental") return 3;
  return 2;
}

export function createRetryBudget(facts = {}) {
  const raw = facts?.retryBudget ?? facts?.scopeContract?.retryBudget;
  const rawObject = raw && typeof raw === "object" ? raw : {};
  const maxCandidate = typeof raw === "number"
    ? raw
    : firstPresent(rawObject, ["maxAttempts", "max_attempts", "retryBudget"])
      ?? firstPresent(facts, ["maxAttempts", "max_attempts"]);
  const maxAttempts = Number.isInteger(maxCandidate) && maxCandidate > 0 ? maxCandidate : defaultRetryAttempts(facts);
  const attemptCandidate = firstPresent(rawObject, ["attempt", "attemptNumber", "attempt_number"])
    ?? firstPresent(facts, ["attempt", "attemptNumber", "attempt_number"]);
  const attempt = Math.max(0, Math.min(maxAttempts, Number.isInteger(attemptCandidate) ? attemptCandidate : 0));
  const remainingCandidate = firstPresent(rawObject, ["remainingAttempts", "remaining_attempts"])
    ?? firstPresent(facts, ["remainingAttempts", "remaining_attempts"]);
  const remainingAttempts = Math.max(0, Math.min(maxAttempts - attempt, Number.isInteger(remainingCandidate) ? remainingCandidate : maxAttempts - attempt));
  return { maxAttempts, attempt, remainingAttempts };
}

function worker(effort, reason, extras = {}) {
  return {
    kind: "worker",
    model: effort === "low" ? GEMINI_MODELS.WORKER_LOW : effort === "high" ? GEMINI_MODELS.WORKER_HIGH : GEMINI_MODELS.WORKER_MEDIUM,
    tier: effort === "low" ? "flash_lite" : effort === "high" ? "pro" : "flash",
    effort,
    reason,
    executor: "flash",
    ...extras,
  };
}

export function decideRoute(facts = {}) {
  const action = normalizeTaskAction(facts);
  const complexity = implementationComplexity(facts);
  const domain = normalizeTaskDomain(facts);

  if (normalizeCriticality(facts) === "CRITICAL") {
    return { kind: "orchestration", model: GEMINI_MODELS.ORCHESTRATOR, tier: "flash", effort: "medium", reason: "critical-control-plane", executor: "flash-orchestrator", criticality: "CRITICAL" };
  }
  if (action === "DIRECT_ACTION") {
    return { kind: "direct_action", action: "DIRECT_ACTION", model: GEMINI_MODELS.ORCHESTRATOR, tier: "flash", effort: "medium", executor: "flash-orchestrator", reason: "direct-action" };
  }
  if (action === "TEST") return worker(complexity === "simple" ? "low" : "medium", "test-execution");
  if (action === "MECHANICAL_FIX") return worker("low", "mechanical-fix");
  if (action === "INVESTIGATE") {
    return { kind: "orchestration", model: GEMINI_MODELS.INVESTIGATOR, tier: "pro", effort: "high", reason: "investigation-high", executor: "flash-specialist" };
  }
  if (action === "IMPLEMENT") {
    if (facts.integration === true || normalizeToken(facts.operation) === "INTEGRATE" || normalizeToken(facts.taskAction) === "INTEGRATE") {
      return worker("high", "integration-required", { integrationRequired: true });
    }
    if (facts.postInvestigation === true || complexity === "difficult" || complexity === "experimental") return worker("high", "implement-standard");
    if (complexity === "simple" || domain === "DOCS") return worker("low", "implement-simple");
    return worker("medium", "implement-standard");
  }
  return { kind: "orchestration", model: GEMINI_MODELS.ORCHESTRATOR, tier: "flash", effort: "medium", reason: "default-orchestration", executor: "flash-orchestrator" };
}
