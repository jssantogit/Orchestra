export const EXPERIENCE_CATEGORIES = Object.freeze([
  "DIAGNOSTIC",
  "EXECUTION",
  "PROVIDER_TOOL_FACT",
  "PERFORMANCE",
  "COUNTEREXAMPLE",
]);

const CATEGORY_SET = new Set(EXPERIENCE_CATEGORIES);
const SCOPES = new Set(["PROJECT", "DOMAIN", "GLOBAL_CANDIDATE"]);
const LATENCY_BUCKETS = new Set(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]);
const OS_FAMILIES = new Set(["windows", "linux", "macos", "other"]);
const PROVIDER_FAMILIES = new Set(["codex", "antigravity", "other"]);

const RECORD_KEYS = new Set([
  "schema",
  "version",
  "experienceId",
  "category",
  "source",
  "domainCohort",
  "facts",
  "outcome",
  "generalization",
  "privacy",
]);
const SOURCE_KEYS = new Set(["projectId", "lineageId", "workId", "operationId"]);
const GENERALIZATION_KEYS = new Set(["scope", "projectLineageCount"]);
const PRIVACY_KEYS = new Set(["projectionVersion", "containsRawProjectContent"]);
const FACT_KEYS = new Set([
  "failureClass",
  "recoveryClass",
  "providerFamily",
  "osFamily",
  "runtimeVersion",
  "providerAdapterVersion",
  "operationClass",
  "routeClass",
  "capabilityClass",
  "toolClass",
  "resultClass",
  "evidenceClass",
  "confidenceClass",
  "latencyBucket",
  "turnCount",
  "retryCount",
  "durationMs",
  "changedPathClass",
  "changedPathCount",
]);
const OUTCOME_KEYS = new Set([
  "terminalOutcome",
  "success",
  "failureClass",
  "recoveryClass",
  "resultClass",
]);

function ok() {
  return { valid: true, errors: [] };
}

function fail(message, path = "/") {
  return { valid: false, errors: [{ path, message }] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNormalizedToken(value) {
  return isNonEmptyString(value) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isDomainCohort(value) {
  return isNonEmptyString(value) && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function isClass(value) {
  return isNonEmptyString(value) && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}

function isSemver(value) {
  return isNonEmptyString(value)
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function validateFacts(facts) {
  if (!isRecord(facts) || !hasOnlyKeys(facts, FACT_KEYS)) {
    return fail("experience facts must use only approved dimensions", "/facts");
  }
  for (const [key, value] of Object.entries(facts)) {
    if (["turnCount", "retryCount", "durationMs", "changedPathCount"].includes(key)) {
      if (!isNonNegativeInteger(value)) return fail(`invalid ${key}`, `/facts/${key}`);
      continue;
    }
    if (key === "providerFamily") {
      if (!PROVIDER_FAMILIES.has(value)) return fail("invalid provider family", "/facts/providerFamily");
      continue;
    }
    if (key === "osFamily") {
      if (!OS_FAMILIES.has(value)) return fail("invalid OS family", "/facts/osFamily");
      continue;
    }
    if (key === "runtimeVersion" || key === "providerAdapterVersion") {
      if (!isSemver(value)) return fail(`invalid ${key}`, `/facts/${key}`);
      continue;
    }
    if (key === "latencyBucket") {
      if (!LATENCY_BUCKETS.has(value)) return fail("invalid latency bucket", "/facts/latencyBucket");
      continue;
    }
    if (!isClass(value)) return fail(`invalid normalized class ${key}`, `/facts/${key}`);
  }
  return ok();
}

function validateOutcome(outcome) {
  if (!isRecord(outcome) || !hasOnlyKeys(outcome, OUTCOME_KEYS)) {
    return fail("experience outcome must use only approved dimensions", "/outcome");
  }
  for (const [key, value] of Object.entries(outcome)) {
    if (key === "success") {
      if (typeof value !== "boolean") return fail("invalid success outcome", "/outcome/success");
      continue;
    }
    if (!isClass(value)) return fail(`invalid normalized outcome ${key}`, `/outcome/${key}`);
  }
  return ok();
}

export function validateExperienceRecord(value) {
  if (!isRecord(value) || value.schema !== "orchestra.experience.v2" || value.version !== 1) {
    return fail("invalid Experience schema/version");
  }
  if (!hasOnlyKeys(value, RECORD_KEYS)) return fail("unknown Experience field is not allowed");
  if (!isNonEmptyString(value.experienceId) || !/^exp-[0-9a-f]{24}$/.test(value.experienceId)) {
    return fail("invalid Experience identity", "/experienceId");
  }
  if (!CATEGORY_SET.has(value.category)) return fail("unsupported Experience category", "/category");
  if (!isRecord(value.source) || !hasOnlyKeys(value.source, SOURCE_KEYS)) {
    return fail("invalid Experience source provenance", "/source");
  }
  if (!isNonEmptyString(value.source.projectId) || !isNonEmptyString(value.source.lineageId)
    || !isNullableString(value.source.workId) || !isNullableString(value.source.operationId)) {
    return fail("Experience source project/lineage and optional audit refs are required", "/source");
  }
  if (!isDomainCohort(value.domainCohort)) return fail("invalid sanitized domain cohort", "/domainCohort");

  const facts = validateFacts(value.facts);
  if (!facts.valid) return facts;
  const outcome = validateOutcome(value.outcome);
  if (!outcome.valid) return outcome;

  if (!isRecord(value.generalization) || !hasOnlyKeys(value.generalization, GENERALIZATION_KEYS)
    || !SCOPES.has(value.generalization.scope)
    || !Number.isInteger(value.generalization.projectLineageCount)
    || value.generalization.projectLineageCount < 1) {
    return fail("invalid Experience generalization metadata", "/generalization");
  }
  if (!isRecord(value.privacy) || !hasOnlyKeys(value.privacy, PRIVACY_KEYS)
    || !isNormalizedToken(value.privacy.projectionVersion)
    || value.privacy.containsRawProjectContent !== false) {
    return fail("invalid Experience privacy projection", "/privacy");
  }
  return ok();
}

export function toCrossProjectExperience(experience) {
  const validation = validateExperienceRecord(experience);
  if (!validation.valid) {
    throw new TypeError(`invalid Experience record: ${validation.errors[0]?.message ?? "unknown error"}`);
  }
  return {
    schema: experience.schema,
    version: experience.version,
    experienceId: experience.experienceId,
    category: experience.category,
    source: {
      lineageId: experience.source.lineageId,
    },
    domainCohort: experience.domainCohort,
    facts: structuredClone(experience.facts),
    outcome: structuredClone(experience.outcome),
    generalization: structuredClone(experience.generalization),
    privacy: structuredClone(experience.privacy),
  };
}
