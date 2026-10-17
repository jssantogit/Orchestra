import { createHash } from "node:crypto";

const MIN_DISTINCT_LINEAGES = 4;
const TRAIN_LINEAGES = 2;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clone(value) {
  return structuredClone(value);
}

function projectSanitizedExperience(record) {
  if (!isRecord(record)
    || record.schema !== "orchestra.experience.v2"
    || record.version !== 1
    || !nonEmptyString(record.experienceId)
    || !nonEmptyString(record.category)
    || !isRecord(record.source)
    || !nonEmptyString(record.source.lineageId)
    || !nonEmptyString(record.domainCohort)
    || !isRecord(record.facts)
    || !isRecord(record.outcome)
    || !isRecord(record.generalization)
    || !isRecord(record.privacy)
    || record.privacy.containsRawProjectContent !== false) {
    return null;
  }

  return Object.freeze({
    schema: record.schema,
    version: record.version,
    experienceId: record.experienceId,
    category: record.category,
    source: Object.freeze({ lineageId: record.source.lineageId }),
    domainCohort: record.domainCohort,
    facts: Object.freeze(clone(record.facts)),
    outcome: Object.freeze(clone(record.outcome)),
    generalization: Object.freeze(clone(record.generalization)),
    privacy: Object.freeze(clone(record.privacy)),
  });
}

function lineageOrderKey(seed, lineageId) {
  return createHash("sha256")
    .update(String(seed), "utf8")
    .update("\0", "utf8")
    .update(lineageId, "utf8")
    .digest("hex");
}

function compareLineages(seed, left, right) {
  const leftKey = lineageOrderKey(seed, left);
  const rightKey = lineageOrderKey(seed, right);
  const keyOrder = leftKey.localeCompare(rightKey);
  return keyOrder === 0 ? left.localeCompare(right) : keyOrder;
}

function makeCohort(lineageIds, byLineage) {
  const records = lineageIds
    .flatMap((lineageId) => byLineage.get(lineageId))
    .sort((left, right) => left.experienceId.localeCompare(right.experienceId));

  return Object.freeze({
    lineageIds: Object.freeze([...lineageIds]),
    records: Object.freeze(records),
  });
}

function failure(code, distinctLineageCount) {
  return Object.freeze({
    ok: false,
    code,
    candidateEligible: false,
    distinctLineageCount,
    cohorts: null,
  });
}

export function buildRsiCohorts({ experiences, seed = "orchestra-rsi-v1", domainCohort = null } = {}) {
  if (!Array.isArray(experiences) || !nonEmptyString(seed)
    || (domainCohort !== null && !nonEmptyString(domainCohort))) {
    return failure("RSI_COHORT_INPUT_INVALID", 0);
  }

  const projected = [];
  for (const experience of experiences) {
    const record = projectSanitizedExperience(experience);
    if (record === null) return failure("RSI_EXPERIENCE_INVALID", 0);
    if (domainCohort !== null && record.domainCohort !== domainCohort) continue;
    projected.push(record);
  }

  const byLineage = new Map();
  for (const record of projected) {
    const lineageId = record.source.lineageId;
    const lineageRecords = byLineage.get(lineageId) ?? [];
    lineageRecords.push(record);
    byLineage.set(lineageId, lineageRecords);
  }

  for (const records of byLineage.values()) {
    records.sort((left, right) => left.experienceId.localeCompare(right.experienceId));
  }

  const lineageIds = [...byLineage.keys()].sort((left, right) => compareLineages(seed, left, right));
  const distinctLineageCount = lineageIds.length;
  if (distinctLineageCount < MIN_DISTINCT_LINEAGES) {
    return failure("RSI_INSUFFICIENT_LINEAGE_DIVERSITY", distinctLineageCount);
  }

  const trainLineages = lineageIds.slice(0, TRAIN_LINEAGES);
  const evaluateLineages = lineageIds.slice(TRAIN_LINEAGES, TRAIN_LINEAGES + 1);
  const holdoutLineages = lineageIds.slice(TRAIN_LINEAGES + 1);

  return Object.freeze({
    ok: true,
    code: "RSI_COHORTS_READY",
    candidateEligible: true,
    distinctLineageCount,
    seed,
    domainCohort,
    cohorts: Object.freeze({
      train: makeCohort(trainLineages, byLineage),
      evaluate: makeCohort(evaluateLineages, byLineage),
      holdout: makeCohort(holdoutLineages, byLineage),
    }),
  });
}
