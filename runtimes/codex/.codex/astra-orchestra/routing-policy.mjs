import { classifyTask } from "./core/routing/task-classification.mjs";
import { escalateTask } from "./core/routing/escalation.mjs";
import { resolveModelProfile } from "./provider/codex/model-catalog.mjs";
import * as legacyRouting from "./routing-policy-legacy.mjs";

export {
  STOP_DECISIONS,
  evaluateStopDecision,
} from "./core/acceptance/stop-decision.mjs";
export { createRuntimeEvent } from "./core/events/runtime-event.mjs";
export {
  buildCodexDelegationRequest,
  decideCodexCrossProviderRoute,
  executeCodexCrossProviderDelegation,
} from "./cross-provider-delegation.mjs";

// Compatibility facade for the Codex runtime. Provider-neutral classification,
// escalation, acceptance and event ownership live in core; concrete
// model/profile mapping lives in the Codex catalog. Keep the historical public
// surface explicit so new legacy symbols cannot leak through this boundary.
export {
  ACTIONS,
  DIRECT_ACTIONS,
  COMMAND_SEMANTICS,
  CODEX_MODELS,
  CROSS_DOMAIN_REQUEST,
  SIDE_EFFECT_CAPABILITIES,
  STATE_NAMES,
  TASK_DOMAINS,
  CORE_TASK_DOMAINS,
  registerCustomDomains,
  canWorkerAccept,
  canWorkerSpawn,
  canonicalTaskDomain,
  normalizeTaskAction,
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
  return legacyRouting.decideRoute(facts);
}
