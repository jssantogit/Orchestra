import { createHash } from "node:crypto";

import { validateExperienceRecord } from "./contracts.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function nonEmptyLineages(sourceLineageId, projectLineageIds) {
  const entries = [sourceLineageId, ...(Array.isArray(projectLineageIds) ? projectLineageIds : [])];
  return [...new Set(entries.filter((entry) => typeof entry === "string" && entry.trim()))];
}

export function projectExperience({
  category,
  sourceProjectId,
  sourceLineageId,
  workId = null,
  operationId = null,
  domainCohort,
  facts = {},
  outcome = {},
  projectLineageIds = [],
  requestedScope = "PROJECT",
  projectionVersion = "1",
} = {}) {
  const distinctLineages = nonEmptyLineages(sourceLineageId, projectLineageIds);
  const scope = requestedScope === "GLOBAL_CANDIDATE" && distinctLineages.length < 2
    ? "PROJECT"
    : requestedScope;

  const content = {
    schema: "orchestra.experience.v2",
    version: 1,
    category,
    source: {
      projectId: sourceProjectId,
      lineageId: sourceLineageId,
      workId,
      operationId,
    },
    domainCohort,
    facts: structuredClone(facts),
    outcome: structuredClone(outcome),
    generalization: {
      scope,
      projectLineageCount: distinctLineages.length,
    },
    privacy: {
      projectionVersion,
      containsRawProjectContent: false,
    },
  };

  const experience = {
    ...content,
    experienceId: `exp-${digest(content).slice(0, 24)}`,
  };
  const validation = validateExperienceRecord(experience);
  return { ...validation, experience };
}
