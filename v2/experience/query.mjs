import {
  EXPERIENCE_CATEGORIES,
  EXPERIENCE_DOMAIN_COHORTS,
  toCrossProjectExperience,
  validateExperienceRecord,
} from "./contracts.mjs";

const FILTER_KEYS = new Set([
  "category",
  "providerFamily",
  "domainCohort",
  "failureClass",
  "recoveryClass",
  "terminalOutcome",
  "eligibilityScope",
  "minProjectLineageCount",
]);
const CATEGORY_SET = new Set(EXPERIENCE_CATEGORIES);
const DOMAIN_COHORT_SET = new Set(EXPERIENCE_DOMAIN_COHORTS);
const SCOPES = new Set(["PROJECT", "DOMAIN", "GLOBAL_CANDIDATE"]);
const PROVIDER_FAMILIES = new Set(["codex", "antigravity", "other"]);

function queryError(message) {
  const error = new TypeError(message);
  error.code = "ORCHESTRA_EXPERIENCE_QUERY_INVALID";
  return error;
}

function isClass(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}

function validateFilters(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw queryError("Experience query filters must be an object");
  }
  for (const key of Object.keys(filters)) {
    if (!FILTER_KEYS.has(key)) throw queryError(`unknown Experience query filter: ${key}`);
  }
  if (filters.category !== undefined && !CATEGORY_SET.has(filters.category)) {
    throw queryError("invalid Experience category filter");
  }
  if (filters.providerFamily !== undefined && !PROVIDER_FAMILIES.has(filters.providerFamily)) {
    throw queryError("invalid provider family filter");
  }
  if (filters.domainCohort !== undefined && !DOMAIN_COHORT_SET.has(filters.domainCohort)) {
    throw queryError("invalid domain cohort filter");
  }
  for (const key of ["failureClass", "recoveryClass", "terminalOutcome"]) {
    if (filters[key] !== undefined && !isClass(filters[key])) {
      throw queryError(`invalid ${key} filter`);
    }
  }
  if (filters.eligibilityScope !== undefined && !SCOPES.has(filters.eligibilityScope)) {
    throw queryError("invalid eligibility scope filter");
  }
  if (filters.minProjectLineageCount !== undefined
    && (!Number.isInteger(filters.minProjectLineageCount) || filters.minProjectLineageCount < 1)) {
    throw queryError("invalid lineage diversity filter");
  }
  return Object.freeze({ ...filters });
}

function validatePage({ limit = 50, cursor = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw queryError("Experience query limit must be an integer from 1 to 100");
  }
  if (cursor !== null && (typeof cursor !== "string" || !/^exp-[0-9a-f]{24}$/.test(cursor))) {
    throw queryError("invalid Experience query cursor");
  }
  return { limit, cursor };
}

function requirePersistence(persistence) {
  if (!persistence || typeof persistence.query !== "function") {
    throw new TypeError("Experience query persistence with query() is required");
  }
  return persistence;
}

function page(records, limit, transform) {
  if (!Array.isArray(records)) throw queryError("Experience persistence query must return an array");
  const overflow = records.length > limit;
  const visible = records.slice(0, limit);
  const items = visible.map((record) => {
    const validation = validateExperienceRecord(record);
    if (!validation.valid) throw queryError("Experience persistence returned an invalid record");
    return transform(record);
  });
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: overflow && visible.length > 0 ? visible.at(-1).experienceId : null,
  });
}

export function createExperienceQuery({ persistence } = {}) {
  const backing = requirePersistence(persistence);

  return Object.freeze({
    crossProject({ filters = {}, limit = 50, cursor = null } = {}) {
      const safeFilters = validateFilters(filters);
      const safePage = validatePage({ limit, cursor });
      const records = backing.query({
        filters: safeFilters,
        projectId: null,
        afterId: safePage.cursor,
        limit: safePage.limit,
      });
      return page(records, safePage.limit, toCrossProjectExperience);
    },

    projectPrivate({ projectId, filters = {}, limit = 50, cursor = null } = {}) {
      if (typeof projectId !== "string" || projectId.trim().length === 0) {
        throw queryError("project-private Experience query requires projectId");
      }
      const safeFilters = validateFilters(filters);
      const safePage = validatePage({ limit, cursor });
      const records = backing.query({
        filters: safeFilters,
        projectId,
        afterId: safePage.cursor,
        limit: safePage.limit,
      });
      return page(records, safePage.limit, (record) => structuredClone(record));
    },
  });
}
