import { createHash } from "node:crypto";

import { validateExperienceV2 } from "../domain/contracts.mjs";

const PRIVATE_KEYS = new Set([
  "sourceCode",
  "sourceBytes",
  "fileContents",
  "prompt",
  "prompts",
  "transcript",
  "hiddenReasoning",
  "requirements",
  "secrets",
]);

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key)) continue;
    output[key] = sanitize(item);
  }
  return output;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function projectExperience({
  category,
  facts = {},
  outcome = {},
  projectLineageIds = [],
  requestedScope = "PROJECT",
  projectionVersion = "1",
} = {}) {
  const distinctLineages = [...new Set(projectLineageIds.filter((entry) => typeof entry === "string" && entry.trim()))];
  const sanitizedFacts = sanitize(facts);
  const sanitizedOutcome = sanitize(outcome);
  const scope = requestedScope === "GLOBAL_CANDIDATE" && distinctLineages.length < 2
    ? "PROJECT"
    : requestedScope;

  const content = {
    category,
    facts: sanitizedFacts,
    outcome: sanitizedOutcome,
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
    schema: "orchestra.experience.v2",
    experienceId: `exp-${digest(content).slice(0, 24)}`,
    ...content,
  };
  const validation = validateExperienceV2(experience);
  return { ...validation, experience };
}
