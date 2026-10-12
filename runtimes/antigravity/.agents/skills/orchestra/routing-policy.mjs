import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { classifyTask } from "./core/routing/task-classification.mjs";
import { escalateTask } from "./core/routing/escalation.mjs";
import { resolveModelProfile } from "./provider/antigravity/model-catalog.mjs";
import * as legacyRouting from "./routing-policy-legacy.mjs";

export {
  STOP_DECISIONS,
  evaluateStopDecision,
} from "./core/acceptance/stop-decision.mjs";
export { createRuntimeEvent } from "./core/events/runtime-event.mjs";

// Compatibility facade for the Antigravity runtime. Provider-neutral
// classification, escalation, acceptance and event ownership live in core and
// concrete Gemini mapping lives in the provider catalog. Keep the historical
// API explicit so legacy additions cannot cross the facade boundary without an
// intentional compatibility edit.
export {
  TASK_DOMAINS,
  GEMINI_MODELS,
  ANTIGRAVITY_MODELS,
  FORBIDDEN_MODELS,
  SIDE_EFFECT_CAPABILITIES,
  STATE_NAMES,
  VALID_TRANSITIONS,
  validateStateTransition,
  createAstraEscalationPacket,
  createUnresolvedDecisionPacket,
  createAcceptanceGate,
  createCrossDomainRequest,
  createIntegrationContract,
  createImplementationHandoff,
  createIndependentReviewPacket,
  createTwoKeyReviewPacket,
  evaluateTwoKeyReview,
  validateAcceptanceEligibility,
  createRetryBudget,
  createScopeContract,
  createStateSnapshot,
  createTelemetryEvent,
  directWriteDecision,
  consumeRetryBudget,
  normalizeComplexity,
  normalizeCriticality,
  normalizeTaskDomain,
  canonicalTaskDomain,
  normalizeTaskAction,
  reviewRoute,
  requiresIntegration,
  summarizePolicyDrift,
  validateScopeContract,
  isControlPlanePath,
  classifyScopeSpecificity,
  isConcretePath,
  isHealthyDelegatedExecution,
  isOrchestratorRole,
  isWorkerRole,
  checkValidationCompletionLock,
  isValidationCommand,
  PROGRESSIVE_TEST_STAGES,
  RETRY_REASONS,
  decideAntigravityRoute,
  reviewAntigravityRoute,
  getProgressiveTestStage,
  createDeltaRetryPacket,
  createOpusReviewPacket,
  detectCoordinationOverhead,
  detectContextBloat,
  checkLoopCircuitBreakers,
  calculateEfficiencyMetrics,
  formatTestResultSummary,
  CIRCUIT_BREAKER_THRESHOLDS,
  extractRealShellRedirections,
  classifyExecutionEvidence,
  isHeavyExecution,
  createHeavyExecutionHandoff,
  createDisposableWorkerPacket,
  validateDisposableWorkerResult,
  checkPollingBudget,
  calculateContextAmplification,
  detectHookFriction,
  TOOL_OUTPUT_LIMITS,
  POLLING_POLICY,
  SHELL_INTENTS,
  TOOL_POLICY_THRESHOLDS,
  classifyShellIntent,
  createInitialToolMix,
  calculateToolMixMetrics,
  detectShellOveruse,
  detectExplorationOverhead,
  createMutationRecord,
  recordMutation,
  isPathDocsOrSpec,
  isPathCore,
  isPathApp,
  checkEvidenceFreshness,
  findReusableEvidence,
  verifyWorkerValidation,
  verifyTaskEvidence,
  recordNativeToolFallback,
  WORKER_PACKET_LIMITS,
  validateWorkerPacket,
  calculateViewTargetWindow,
  classifyShellMutation,
  trackGitInspection,
  createAdvisory,
  deliverPendingAdvisories,
  consumeDeliveredAdvisories,
  planVerificationBatch,
  DIRECT_ACTION_TYPES,
  normalizeDirectActionType,
  classifyDirectActionIntent,
  GIT_EFFECT_TAXONOMY,
  classifyGitEffect,
  detectDirectActionOverhead,
  detectDirectActionOverthinking,
} from "./routing-policy-legacy.mjs";

function neutralRole(facts = {}) {
  const action = String(facts?.taskAction ?? facts?.nextTaskAction ?? facts?.action ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (["ORCHESTRATE", "ORCHESTRATION", "CLASSIFY", "DIRECT_ACTION"].includes(action)) return "CONTROL";
  if (["INVESTIGATE", "INVESTIGATION"].includes(action)) return "INVESTIGATION";
  if (action === "REVIEW") return "REVIEW";
  if (["ESCALATE", "ESCALATION"].includes(action)) return "CONTROL";
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

function runJsonCli() {
  if (process.argv[2] !== "--json") {
    throw new Error("Usage: node routing-policy.mjs --json < facts.json");
  }
  const facts = JSON.parse(readFileSync(0, "utf8"));
  console.log(JSON.stringify(decideRoute(facts)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runJsonCli();
}
