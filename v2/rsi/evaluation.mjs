import { validateLearnedPolicyCandidate } from "./policy-store.mjs";

const DIMENSIONS = Object.freeze([
  Object.freeze({ choices: "routes", allowed: "allowedRoutes", preference: "routePreference", output: "route" }),
  Object.freeze({ choices: "providerProfiles", allowed: "allowedProviderProfiles", preference: "providerProfilePreference", output: "providerProfile" }),
  Object.freeze({ choices: "retryClasses", allowed: "allowedRetryClasses", preference: "retryClass", output: "retryClass" }),
  Object.freeze({ choices: "timeoutClasses", allowed: "allowedTimeoutClasses", preference: "timeoutClass", output: "timeoutClass" }),
  Object.freeze({ choices: "turnEconomy", allowed: "allowedTurnEconomy", preference: "turnEconomy", output: "turnEconomy" }),
]);

function validChoices(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(item))
    && new Set(value).size === value.length;
}

function applies(policy, { domainCohort, projectId }) {
  if (!policy) return false;
  if (policy.scope === "GLOBAL") return true;
  if (policy.scope === "DOMAIN") return policy.domainCohort === domainCohort;
  if (policy.scope === "PROJECT") return policy.projectId === projectId;
  return false;
}

export function resolveLearnedPolicyHierarchy({
  immutableChoices,
  globalPolicy = null,
  domainPolicy = null,
  projectPolicy = null,
  domainCohort = null,
  projectId = null,
} = {}) {
  if (!immutableChoices || DIMENSIONS.some(({ choices }) => !validChoices(immutableChoices[choices]))) {
    return { ok: false, reason: "RSI_IMMUTABLE_CHOICES_INVALID" };
  }

  const legalChoices = Object.fromEntries(DIMENSIONS.map(({ choices }) => [choices, [...immutableChoices[choices]]]));
  const preferences = Object.fromEntries(DIMENSIONS.map(({ choices, output }) => [output, legalChoices[choices][0]]));
  const appliedPolicies = [];

  for (const policy of [globalPolicy, domainPolicy, projectPolicy]) {
    if (!policy || !applies(policy, { domainCohort, projectId })) continue;
    const validation = validateLearnedPolicyCandidate(policy);
    if (!validation.valid) return { ok: false, reason: "RSI_POLICY_INVALID", policyId: policy?.policyId ?? null };

    for (const { choices, allowed, preference, output } of DIMENSIONS) {
      const bounded = policy.selectors[allowed];
      if (bounded) {
        legalChoices[choices] = legalChoices[choices].filter((choice) => bounded.includes(choice));
        if (legalChoices[choices].length === 0) {
          return { ok: false, reason: "RSI_POLICY_NO_LEGAL_CHOICE", policyId: policy.policyId, dimension: choices };
        }
      }
      const preferred = policy.selectors[preference];
      if (preferred && legalChoices[choices].includes(preferred)) preferences[output] = preferred;
      if (!legalChoices[choices].includes(preferences[output])) preferences[output] = legalChoices[choices][0];
    }
    appliedPolicies.push(Object.freeze({ policyId: policy.policyId, revision: policy.revision, scope: policy.scope }));
  }

  return Object.freeze({
    ok: true,
    legalChoices: Object.freeze(Object.fromEntries(
      Object.entries(legalChoices).map(([key, value]) => [key, Object.freeze([...value])]),
    )),
    preferences: Object.freeze({ ...preferences }),
    appliedPolicies: Object.freeze(appliedPolicies),
  });
}
