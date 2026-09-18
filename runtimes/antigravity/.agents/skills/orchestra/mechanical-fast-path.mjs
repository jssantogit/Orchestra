export const MECHANICAL_FAST_PATH_SCHEMA = "orchestra.mechanical-fast-path.v1";

export const MECHANICAL_FAST_PATH_LOCAL_FACTS = Object.freeze([
  "FILE_EXISTS",
  "FILE_NOT_EXISTS",
  "EXPECTED_FILE_MODIFIED",
  "GIT_IGNORED",
  "HEAD_SHA",
  "BRANCH_REF",
]);

const OUTCOME_FACTS = new Set([
  "FILE_EXISTS",
  "FILE_NOT_EXISTS",
  "EXPECTED_FILE_MODIFIED",
  "GIT_IGNORED",
]);

const SAFE_FACTS = new Set(MECHANICAL_FAST_PATH_LOCAL_FACTS);

const SENSITIVE_PATH_PATTERNS = Object.freeze([
  /^AGENTS\.md$/i,
  /^\.agents(?:\/|$)/i,
  /^\.github\/workflows(?:\/|$)/i,
  /^\.github\/actions(?:\/|$)/i,
  /(?:^|\/)(?:auth|security|credentials?|secrets?)(?:\/|\.|$)/i,
  /(?:^|\/)(?:release|deploy|publish|production)(?:\/|\.|$)/i,
  /(?:^|\/)(?:migrations?|database|db)(?:\/|\.|$)/i,
  /(?:^|\/)(?:payment|billing)(?:\/|\.|$)/i,
  /(?:^|\/)(?:terraform|kubernetes|k8s|helm)(?:\/|\.|$)/i,
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|gradle\.lockfile)$/i,
]);

function normalizePath(path) {
  return String(path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function isConcretePath(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("../")) return false;
  if (/[*?[\]{}]/.test(normalized)) return false;
  if (normalized.endsWith("/")) return false;
  return true;
}

function isSensitivePath(path) {
  const normalized = normalizePath(path);
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function localFactRequirements(scopeContract = {}) {
  const required = Array.isArray(scopeContract.requiredEvidence)
    ? scopeContract.requiredEvidence
    : [];
  return required.map((raw, index) => ({
    ...raw,
    id: String(raw?.id || "evidence-" + (index + 1)),
    kind: String(raw?.kind || "").trim().toUpperCase(),
    class: String(raw?.class || "").trim().toUpperCase(),
  }));
}

function requirementPaths(requirement) {
  const paths = [];
  if (requirement?.path) paths.push(normalizePath(requirement.path));
  if (Array.isArray(requirement?.paths)) {
    for (const path of requirement.paths) paths.push(normalizePath(path));
  }
  return paths.filter(Boolean);
}

export function classifyMechanicalFastPath({
  taskAction,
  criticality,
  scopeContract = {},
  requestedProfile = null,
  attempt = 0,
  retry = false,
} = {}) {
  const reasons = [];
  const action = String(taskAction || "").trim().toUpperCase();
  const crit = String(criticality || scopeContract.criticality || "NORMAL").trim().toUpperCase();
  const allowedPaths = Array.isArray(scopeContract.allowedPaths)
    ? [...new Set(scopeContract.allowedPaths.map(normalizePath).filter(Boolean))]
    : [];
  const forbiddenPaths = Array.isArray(scopeContract.forbiddenPaths)
    ? [...new Set(scopeContract.forbiddenPaths.map(normalizePath).filter(Boolean))]
    : [];
  const testsRequired = Array.isArray(scopeContract.testsRequired)
    ? scopeContract.testsRequired.filter(Boolean)
    : [];
  const requirements = localFactRequirements(scopeContract);
  const profile = String(requestedProfile || "").trim().toLowerCase();

  if (action !== "MECHANICAL_FIX") reasons.push("TASK_ACTION_NOT_MECHANICAL_FIX");
  if (crit !== "NORMAL") reasons.push("CRITICALITY_NOT_NORMAL");
  if (retry || Number(attempt || 0) > 0) reasons.push("RETRY_NOT_FAST_PATH");
  if (profile && profile !== "flash-low-worker") reasons.push("WORKER_NOT_FLASH_LOW");

  if (allowedPaths.length === 0) reasons.push("ALLOWED_PATHS_REQUIRED");
  if (allowedPaths.length > 4) reasons.push("SCOPE_TOO_LARGE");
  if (allowedPaths.some((path) => !isConcretePath(path))) reasons.push("SCOPE_NOT_CONCRETE");
  if (allowedPaths.some(isSensitivePath)) reasons.push("SENSITIVE_PATH");

  if (testsRequired.length > 0) reasons.push("LOCAL_COMMAND_VALIDATION_REQUIRED");
  if (requirements.length === 0) reasons.push("STRUCTURED_LOCAL_FACT_REQUIRED");

  for (const requirement of requirements) {
    if (requirement.kind !== "LOCAL_FACT") {
      reasons.push("NON_LOCAL_FACT_EVIDENCE");
      break;
    }
    if (!SAFE_FACTS.has(requirement.class)) {
      reasons.push("UNSUPPORTED_LOCAL_FACT");
      break;
    }
    const paths = requirementPaths(requirement);
    if (paths.some((path) => path.startsWith("../") || path.startsWith("/"))) {
      reasons.push("EVIDENCE_PATH_OUTSIDE_WORKSPACE");
      break;
    }
  }

  if (
    requirements.length > 0
    && !requirements.some((requirement) => OUTCOME_FACTS.has(requirement.class))
  ) {
    reasons.push("OUTCOME_FACT_REQUIRED");
  }

  const eligible = reasons.length === 0;

  return {
    schema: MECHANICAL_FAST_PATH_SCHEMA,
    eligible,
    reasons,
    taskAction: action,
    criticality: crit,
    targetWorker: "flash-low-worker",
    allowedPaths,
    forbiddenPaths,
    requirementIds: requirements.map((item) => item.id),
    requirementClasses: requirements.map((item) => item.class),
    testsRequiredCount: testsRequired.length,
    maxMutationCalls: Math.max(2, allowedPaths.length * 2),
  };
}

export function isMechanicalFastPathActive(activeState = {}) {
  return Boolean(
    activeState.mechanicalFastPath
    && activeState.mechanicalFastPath.schema === MECHANICAL_FAST_PATH_SCHEMA
    && activeState.mechanicalFastPath.active === true
  );
}

export function mechanicalFastPathAllowsRead(activeState = {}, path) {
  if (!isMechanicalFastPathActive(activeState)) return true;
  const normalized = normalizePath(path);
  if (!normalized) return false;
  const allowed = activeState.mechanicalFastPath.allowedPaths || [];
  return allowed.includes(normalized);
}

export function mechanicalFastPathAllowsRunCommand(activeState = {}, commandLine = "") {
  if (!isMechanicalFastPathActive(activeState)) return true;
  const contract = activeState.scopeContract || {};
  const localCommands = Array.isArray(contract.requiredEvidence)
    ? contract.requiredEvidence.filter((requirement) =>
        String(requirement?.kind || "").toUpperCase() === "LOCAL_COMMAND"
      )
    : [];
  const testsRequired = Array.isArray(contract.testsRequired)
    ? contract.testsRequired.filter(Boolean)
    : [];

  const allowedCommands = [
    ...localCommands.map((requirement) => String(requirement.command || "").trim()),
    ...testsRequired.map((command) => String(command || "").trim()),
  ].filter(Boolean);

  return allowedCommands.includes(String(commandLine || "").trim());
}

export function mechanicalFastPathMutationBudget(activeState = {}) {
  if (!isMechanicalFastPathActive(activeState)) {
    return { allowed: true, used: 0, max: null };
  }
  const marker = activeState.mechanicalFastPath;
  const baseline = Number(marker.workerWritesAtStart || 0);
  const current = Number(activeState.workerWorkspaceWrites || 0);
  const used = Math.max(0, current - baseline);
  const max = Number(marker.maxMutationCalls || 2);
  return {
    allowed: used < max,
    used,
    max,
  };
}
