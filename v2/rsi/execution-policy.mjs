import { resolveLearnedPolicyHierarchy } from "./evaluation.mjs";
import { resolveActiveLearnedPolicies } from "./policy-resolver.mjs";

const DIMENSIONS = Object.freeze([
  Object.freeze({ choices: "routes", output: "route" }),
  Object.freeze({ choices: "providerProfiles", output: "providerProfile" }),
  Object.freeze({ choices: "retryClasses", output: "retryClass" }),
  Object.freeze({ choices: "timeoutClasses", output: "timeoutClass" }),
  Object.freeze({ choices: "turnEconomy", output: "turnEconomy" }),
]);
const REQUEST_KEYS = new Set([
  "immutableChoices",
  "candidateChoices",
  "policyStore",
  "domainCohort",
  "projectId",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(item))
    && new Set(value).size === value.length;
}

function exactChoiceShape(value) {
  if (!isRecord(value)) return false;
  const expected = DIMENSIONS.map(({ choices }) => choices).sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
    && DIMENSIONS.every(({ choices }) => tokenList(value[choices]));
}

function candidateWithinImmutable(immutableChoices, candidateChoices) {
  return DIMENSIONS.every(({ choices }) => {
    const immutable = new Set(immutableChoices[choices]);
    return candidateChoices[choices].every((choice) => immutable.has(choice));
  });
}

function freezeChoices(choices) {
  return Object.freeze(Object.fromEntries(
    DIMENSIONS.map(({ choices: key }) => [key, Object.freeze([...choices[key]])]),
  ));
}

function baseline(candidateChoices) {
  return Object.freeze(Object.fromEntries(
    DIMENSIONS.map(({ choices, output }) => [output, candidateChoices[choices][0]]),
  ));
}

function fallback(candidateChoices, alert) {
  return Object.freeze({
    ok: true,
    degraded: true,
    code: "RSI_POLICY_FALLBACK_BASELINE",
    selection: baseline(candidateChoices),
    legalChoices: freezeChoices(candidateChoices),
    appliedPolicies: Object.freeze([]),
    alert: Object.freeze({
      code: "RSI_POLICY_STATE_INVALID",
      ...(alert ?? {}),
      code: "RSI_POLICY_STATE_INVALID",
    }),
  });
}

export function selectExecutionPolicy(input = {}) {
  if (!isRecord(input) || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    return Object.freeze({ ok: false, code: "RSI_EXECUTION_POLICY_REQUEST_INVALID" });
  }

  const {
    immutableChoices,
    candidateChoices,
    policyStore = null,
    domainCohort = null,
    projectId = null,
  } = input;

  if (!exactChoiceShape(immutableChoices)
    || !exactChoiceShape(candidateChoices)
    || !candidateWithinImmutable(immutableChoices, candidateChoices)) {
    return Object.freeze({ ok: false, code: "RSI_EXECUTION_POLICY_CHOICES_INVALID" });
  }

  const resolved = resolveActiveLearnedPolicies({ policyStore, domainCohort, projectId });
  if (!resolved.ok) return fallback(candidateChoices, resolved.alert);

  const hierarchy = resolveLearnedPolicyHierarchy({
    immutableChoices: candidateChoices,
    ...resolved.policies,
    domainCohort,
    projectId,
  });
  if (!hierarchy.ok) {
    return fallback(candidateChoices, {
      sourceCode: hierarchy.reason ?? null,
      policyId: hierarchy.policyId ?? null,
      dimension: hierarchy.dimension ?? null,
    });
  }

  const appliedPolicies = Object.freeze([...hierarchy.appliedPolicies]);
  return Object.freeze({
    ok: true,
    degraded: false,
    code: appliedPolicies.length === 0 ? "RSI_POLICY_BASELINE" : "RSI_POLICY_APPLIED",
    selection: hierarchy.preferences,
    legalChoices: hierarchy.legalChoices,
    appliedPolicies,
  });
}
