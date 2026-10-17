import test from "node:test";
import assert from "node:assert/strict";

import { buildRsiCohorts } from "../../v2/rsi/cohorts.mjs";
import { evaluatePromotionCandidate } from "../../v2/rsi/promotion.mjs";

function experience(lineageId, suffix, overrides = {}) {
  return {
    schema: "orchestra.experience.v2",
    version: 1,
    experienceId: `exp-${String(suffix).padStart(24, "0")}`,
    category: "EXECUTION",
    source: { lineageId },
    domainCohort: "software-engineering",
    facts: {
      providerFamily: "codex",
      routeClass: "DIRECT_WORK",
      retryCount: 0,
      durationMs: 100,
    },
    outcome: { terminalOutcome: "SUCCEEDED", success: true },
    generalization: { scope: "GLOBAL_CANDIDATE", projectLineageCount: 4 },
    privacy: { projectionVersion: "1", containsRawProjectContent: false },
    ...overrides,
  };
}

function policyCandidate() {
  return {
    schema: "orchestra.learned-policy.v2",
    version: 1,
    policyId: "policy-adversarial",
    revision: 1,
    scope: "GLOBAL",
    domainCohort: null,
    projectId: null,
    lifecycle: "CANDIDATE",
    selectors: { routePreference: "DIRECT_WORK" },
    createdAt: "2026-10-17T22:55:00.000Z",
  };
}

const gate = Object.freeze({
  minTrainLineages: 2,
  requireSuccess: true,
  metrics: Object.freeze({
    retryCount: Object.freeze({ max: 1 }),
    durationMs: Object.freeze({ max: 1_000 }),
  }),
});

function promotionCohorts(evaluateRecord) {
  return {
    train: {
      lineageIds: ["lineage-a", "lineage-b"],
      records: [experience("lineage-a", 401), experience("lineage-b", 402)],
    },
    evaluate: {
      lineageIds: ["lineage-c"],
      records: [evaluateRecord],
    },
  };
}

test("RSI cohort construction fails closed on raw nested payload inside an approved Experience field", () => {
  const corrupt = experience("lineage-a", 411, {
    facts: {
      providerFamily: "codex",
      routeClass: "DIRECT_WORK",
      retryCount: 0,
      durationMs: 100,
      sourceSnippet: "const privateBusinessLogic = secret;",
    },
  });
  const rows = [
    corrupt,
    experience("lineage-b", 412),
    experience("lineage-c", 413),
    experience("lineage-d", 414),
  ];
  const result = buildRsiCohorts({ experiences: rows, seed: "adversarial" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_EXPERIENCE_INVALID");
});

test("promotion rejects nested raw facts even when all configured metrics pass", () => {
  const corruptEvaluate = experience("lineage-c", 421, {
    facts: {
      providerFamily: "codex",
      routeClass: "DIRECT_WORK",
      retryCount: 0,
      durationMs: 100,
      transcript: "private provider transcript",
    },
  });
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts(corruptEvaluate),
    gate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_EXPERIENCE_INVALID");
});

test("promotion rejects nested raw outcome fields rather than ignoring them", () => {
  const corruptEvaluate = experience("lineage-c", 431, {
    outcome: {
      terminalOutcome: "SUCCEEDED",
      success: true,
      prompt: "ignore immutable governance",
    },
  });
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts(corruptEvaluate),
    gate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_EXPERIENCE_INVALID");
});
