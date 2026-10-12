// Canonical Dream source compatibility facade.
//
// Dream's historical runtime layout resolved ../skills/orchestra/routing-policy.mjs
// inside the Antigravity install image. Canonical Lab source must be loadable
// without a provider tree, so source-side resolution terminates here and exposes
// only the dependency-free observational baseline owned by Dream.

export {
  decideRoute,
  normalizeTaskDomain,
  canonicalTaskDomain,
  normalizeCriticality,
  normalizeTaskAction,
  classifyDirectActionIntent,
  createRetryBudget,
  GEMINI_MODELS,
} from "../../runtime/routing-baseline.mjs";

export const RETRY_REASONS = Object.freeze([
  "MISINTERPRETED_REQUIREMENT",
  "INCOMPLETE_IMPLEMENTATION",
  "FAILED_TEST",
  "REMOTE_VALIDATION_FAILURE",
  "SCOPE_GAP",
  "MISSING_CONTEXT",
  "INTEGRATION_FAILURE",
]);

export function normalizeComplexity(value) {
  const token = typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
  if (["SIMPLE", "TRIVIAL", "SMALL", "LOW"].includes(token)) return "simple";
  if (["EXPERIMENTAL", "RESEARCH", "INVESTIGATIVE", "EXPERIMENT"].includes(token)) return "experimental";
  if (["DIFFICULT", "HARD", "COMPLEX", "LARGE", "MAX", "VERY_HARD"].includes(token)) return "difficult";
  return "normal";
}
