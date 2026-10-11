import { classifyTask } from "./core/routing/task-classification.mjs";
import { escalateTask } from "./core/routing/escalation.mjs";
import { resolveModelProfile } from "./provider/codex/model-catalog.mjs";
import * as legacyRouting from "./routing-policy-legacy.mjs";

// Compatibility facade for the Codex runtime. Provider-neutral classification
// and escalation live in core; concrete model/profile mapping lives in the
// Codex catalog. Keep the historical public surface explicit so new legacy
// symbols cannot leak through this boundary accidentally.
export {
  ACTIONS,
  DIRECT_ACTIONS,
  COMMAND_SEMANTICS,
  CODEX_MODELS,
  CROSS_DOMAIN_REQUEST,
  STATE_NAMES,
  TASK_DOMAINS,
  CORE_TASK_DOMAINS,
  registerCustomDomains,
  canWorkerAccept,
  canWorkerSpawn,
  canonicalTaskDomain,
  consumeRetryBudget,
  createAcceptanceGate,
  createAstraEscalationPacket,
  createCrossDomainRequest,
  createImplementationHandoff,
  createIntegrationContract,
  createRetryBudget,
  createScopeContract,
  directWriteDecision,
  evaluateAcceptance,
  evaluateCriticalReview,
  evaluateDirectAction,
  createCommandResult,
  evaluateCommandResult,
  evaluateCodexExecEvents,
  requiresIntegration,
  reviewRoute,
  scanCodexSkillIsolation,
  scanCodexOperationalFiles,
  validateCodexRoute,
  validateAstraEscalationPacket,
  validateScopeContract,
  validateStateTransition,
  isDirectAction,
  validateWorkerCompletion,
} from "./routing-policy-legacy.mjs";

function neutralRole(facts = {}) {
  const action = String(facts?.taskAction ?? facts?.nextTaskAction ?? facts?.action ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (["ORCHESTRATE", "ORCHESTRATION", "CLASSIFY", "DIRECT_ACTION"].includes(action)) return "CONTROL";
  if (["INVESTIGATE", "INVESTIGATION"].includes(action)) return "INVESTIGATION";
  if (action === "REVIEW") return "REVIEW";
  if (["ASTRA", "ESCALATE", "ESCALATION"].includes(action)) return "CONTROL";
  return "IMPLEMENTATION";
}

function neutralFacts(facts = {}) {
  const source = facts && typeof facts === "object" ? facts : {};
  return {
    ...source,
    role: source.role ?? source.taskRole ?? neutralRole(source),
    diagnosisState: source.diagnosisState ?? "RESOLVED",
  };
}

export function classifyRoutingFacts(facts = {}) {
  return classifyTask(neutralFacts(facts));
}

export function evaluateRoutingEscalation({ task = {}, currentRole, result = {} } = {}) {
  return escalateTask({ task: neutralFacts(task), currentRole, result });
}

export function resolveRoutingProfile(facts = {}) {
  const classification = classifyRoutingFacts(facts);
  return resolveModelProfile(classification.logicalRole, {
    intensity: classification.intensity,
    criticality: facts?.criticality ?? "NORMAL",
  });
}

export function decideRoute(facts = {}) {
  // Keep the public route byte-for-byte compatible while extraction is staged.
  // Neutral helpers above are the new ownership surface; later tasks migrate
  // legacy responsibilities behind them one bounded concern at a time.
  return legacyRouting.decideRoute(facts);
}