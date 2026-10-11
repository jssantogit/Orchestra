import { classifyTask } from "./core/routing/task-classification.mjs";
import { escalateTask } from "./core/routing/escalation.mjs";
import { resolveModelProfile } from "./provider/antigravity/model-catalog.mjs";
import * as legacyRouting from "./routing-policy-legacy.mjs";

// Compatibility facade for the Antigravity runtime. Provider-neutral
// classification/escalation live in core and concrete Gemini mapping lives in
// the Antigravity catalog. The legacy engine remains the behavior oracle while
// later plan tasks extract enforcement/state responsibilities behind owners.
export * from "./routing-policy-legacy.mjs";

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
