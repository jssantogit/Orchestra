export const LEARNED_POLICY_SCOPES = Object.freeze(["GLOBAL", "DOMAIN", "PROJECT"]);

const SCOPE_SET = new Set(LEARNED_POLICY_SCOPES);
const RECORD_KEYS = new Set([
  "schema", "version", "policyId", "revision", "scope", "domainCohort", "projectId",
  "lifecycle", "selectors", "createdAt",
]);
const SELECTOR_KEYS = new Set([
  "allowedRoutes", "routePreference",
  "allowedProviderProfiles", "providerProfilePreference",
  "allowedRetryClasses", "retryClass",
  "allowedTimeoutClasses", "timeoutClass",
  "allowedTurnEconomy", "turnEconomy",
]);
const ARRAY_SELECTORS = new Map([
  ["allowedRoutes", "routePreference"],
  ["allowedProviderProfiles", "providerProfilePreference"],
  ["allowedRetryClasses", "retryClass"],
  ["allowedTimeoutClasses", "timeoutClass"],
  ["allowedTurnEconomy", "turnEconomy"],
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function token(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}

function identity(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
}

function nullableIdentity(value) {
  return value === null || identity(value);
}

function isoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validTokenList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(token)
    && new Set(value).size === value.length;
}

function fail(message, path = "/") {
  return { valid: false, errors: [{ path, message }] };
}

function ok() {
  return { valid: true, errors: [] };
}

function storeInvalid(message, details = {}) {
  const error = new Error(`ORCHESTRA_RSI_POLICY_STORE_INVALID:${message}`);
  error.code = "ORCHESTRA_RSI_POLICY_STORE_INVALID";
  Object.assign(error, details);
  return error;
}

function scopeForCandidate(candidate) {
  if (candidate.scope === "GLOBAL") return Object.freeze({ scope: "GLOBAL" });
  if (candidate.scope === "DOMAIN") {
    return Object.freeze({ scope: "DOMAIN", domainCohort: candidate.domainCohort });
  }
  return Object.freeze({ scope: "PROJECT", projectId: candidate.projectId });
}

function samePolicy(active, policyId, revision) {
  return active?.policy?.policyId === policyId && active?.policy?.revision === revision;
}

export function validateLearnedPolicyCandidate(value) {
  if (!isRecord(value) || !onlyKeys(value, RECORD_KEYS)) return fail("invalid policy record");
  if (value.schema !== "orchestra.learned-policy.v2" || value.version !== 1) {
    return fail("invalid policy schema/version");
  }
  if (!identity(value.policyId) || !Number.isInteger(value.revision) || value.revision < 1) {
    return fail("invalid policy identity", "/policyId");
  }
  if (!SCOPE_SET.has(value.scope)) return fail("invalid policy scope", "/scope");
  if (!nullableIdentity(value.domainCohort) || !nullableIdentity(value.projectId)) {
    return fail("invalid policy scope identity", "/scope");
  }
  if (value.scope === "GLOBAL" && (value.domainCohort !== null || value.projectId !== null)) {
    return fail("GLOBAL policy cannot bind project/domain", "/scope");
  }
  if (value.scope === "DOMAIN" && (!identity(value.domainCohort) || value.projectId !== null)) {
    return fail("DOMAIN policy requires only domain cohort", "/scope");
  }
  if (value.scope === "PROJECT" && (!identity(value.projectId) || value.domainCohort !== null)) {
    return fail("PROJECT policy requires only project identity", "/scope");
  }
  if (value.lifecycle !== "CANDIDATE") return fail("persisted policy record must be a candidate", "/lifecycle");
  if (!isoTimestamp(value.createdAt)) return fail("invalid candidate timestamp", "/createdAt");
  if (!isRecord(value.selectors) || !onlyKeys(value.selectors, SELECTOR_KEYS) || Object.keys(value.selectors).length === 0) {
    return fail("policy selectors must use the bounded allowlist", "/selectors");
  }

  for (const [allowedKey, preferenceKey] of ARRAY_SELECTORS) {
    if (allowedKey in value.selectors && !validTokenList(value.selectors[allowedKey])) {
      return fail(`invalid ${allowedKey}`, `/selectors/${allowedKey}`);
    }
    if (preferenceKey in value.selectors) {
      if (!token(value.selectors[preferenceKey])) {
        return fail(`invalid ${preferenceKey}`, `/selectors/${preferenceKey}`);
      }
      if (allowedKey in value.selectors && !value.selectors[allowedKey].includes(value.selectors[preferenceKey])) {
        return fail(`${preferenceKey} must be within ${allowedKey}`, `/selectors/${preferenceKey}`);
      }
    }
  }
  return ok();
}

export function learnedPolicyScopeKey({ scope, domainCohort = null, projectId = null } = {}) {
  if (scope === "GLOBAL" && domainCohort === null && projectId === null) return "GLOBAL";
  if (scope === "DOMAIN" && identity(domainCohort) && projectId === null) return `DOMAIN:${domainCohort}`;
  if (scope === "PROJECT" && identity(projectId) && domainCohort === null) return `PROJECT:${projectId}`;
  throw new TypeError("invalid learned policy scope");
}

function validateActivation(active) {
  if (!isRecord(active) || !isRecord(active.policy) || !isRecord(active.activation)) {
    throw storeInvalid("invalid active policy envelope");
  }
  const validation = validateLearnedPolicyCandidate(active.policy);
  if (!validation.valid) throw storeInvalid("invalid active policy record", { policyId: active.policy?.policyId });
  const activation = active.activation;
  if (activation.lifecycle !== "ACTIVE"
    || !identity(activation.scopeKey)
    || !identity(activation.policyId)
    || !Number.isInteger(activation.revision)
    || activation.revision < 1
    || !isoTimestamp(activation.activatedAt)) {
    throw storeInvalid("invalid activation record", { policyId: activation?.policyId });
  }
  return active;
}

export function createLearnedPolicyStore({ persistence } = {}) {
  if (!persistence || typeof persistence.putCandidate !== "function"
    || typeof persistence.inspect !== "function"
    || typeof persistence.activate !== "function"
    || typeof persistence.active !== "function"
    || typeof persistence.history !== "function") {
    throw new TypeError("learned policy persistence is required");
  }

  return Object.freeze({
    putCandidate(candidate) {
      const validation = validateLearnedPolicyCandidate(candidate);
      if (!validation.valid) return { ok: false, reason: "RSI_POLICY_INVALID", errors: validation.errors };
      return persistence.putCandidate(structuredClone(candidate));
    },

    inspect(policyId, revision) {
      const candidate = persistence.inspect(policyId, revision);
      if (candidate === null) return null;
      const validation = validateLearnedPolicyCandidate(candidate);
      if (!validation.valid) throw storeInvalid("invalid candidate record", { policyId, revision });
      return candidate;
    },

    activate({ policyId, revision } = {}) {
      const candidate = this.inspect(policyId, revision);
      if (!candidate) return { ok: false, reason: "RSI_POLICY_NOT_FOUND" };
      const result = persistence.activate({ policyId, revision });
      if (!result?.ok) return result;
      return { ...result, active: validateActivation(result.active) };
    },

    active(scope) {
      const scopeKey = learnedPolicyScopeKey(scope);
      const active = persistence.active({ ...scope, scopeKey });
      return active === null ? null : validateActivation(active);
    },

    history(scope) {
      const scopeKey = learnedPolicyScopeKey(scope);
      const entries = persistence.history({ ...scope, scopeKey });
      if (!Array.isArray(entries)) throw storeInvalid("invalid activation history");
      return entries.map((entry) => validateActivation(entry));
    },

    rollback({ policyId, revision } = {}) {
      const candidate = this.inspect(policyId, revision);
      if (!candidate) return { ok: false, reason: "RSI_POLICY_NOT_FOUND" };
      const scope = scopeForCandidate(candidate);
      const history = this.history(scope);
      const targetActivation = [...history].reverse().find((entry) => samePolicy(entry, policyId, revision));
      if (!targetActivation) return { ok: false, reason: "RSI_POLICY_NOT_ACTIVATED" };

      const predecessorPolicyId = targetActivation.activation.predecessorPolicyId;
      const predecessorRevision = targetActivation.activation.predecessorRevision;
      if (!identity(predecessorPolicyId) || !Number.isInteger(predecessorRevision) || predecessorRevision < 1) {
        return { ok: false, reason: "RSI_POLICY_PREDECESSOR_NOT_FOUND" };
      }

      const current = this.active(scope);
      const rolledBack = Object.freeze({ policyId, revision });
      if (samePolicy(current, predecessorPolicyId, predecessorRevision)) {
        return { ok: true, replayed: true, active: current, rolledBack };
      }
      if (!samePolicy(current, policyId, revision)) {
        return {
          ok: false,
          reason: "RSI_POLICY_ROLLBACK_STALE",
          active: current,
          rolledBack,
        };
      }

      const result = this.activate({ policyId: predecessorPolicyId, revision: predecessorRevision });
      if (!result?.ok) return result;
      return {
        ok: true,
        replayed: false,
        active: result.active,
        rolledBack,
        rollbackActivation: result.active.activation,
      };
    },
  });
}
