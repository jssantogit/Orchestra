import test from "node:test";
import assert from "node:assert/strict";

import { buildRsiCohorts } from "../../v2/rsi/cohorts.mjs";

function experience(lineageId, suffix, { domainCohort = "software-engineering", extra = {} } = {}) {
  return {
    schema: "orchestra.experience.v2",
    version: 1,
    experienceId: `exp-${String(suffix).padStart(24, "0")}`,
    category: "EXECUTION",
    source: { lineageId },
    domainCohort,
    facts: { providerFamily: "codex", routeClass: "DIRECT_WORK", retryCount: 0 },
    outcome: { terminalOutcome: "SUCCEEDED", success: true },
    generalization: { scope: "GLOBAL_CANDIDATE", projectLineageCount: 4 },
    privacy: { projectionVersion: "1", containsRawProjectContent: false },
    ...extra,
  };
}

function lineages(cohort) {
  return cohort.lineageIds;
}

test("one lineage with many Experience rows is insufficient for cross-project RSI", () => {
  const rows = Array.from({ length: 100 }, (_, index) => experience("lineage-a", index + 1));
  const result = buildRsiCohorts({ experiences: rows, seed: "seed-a" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_INSUFFICIENT_LINEAGE_DIVERSITY");
  assert.equal(result.distinctLineageCount, 1);
  assert.equal(result.cohorts, null);
});

test("duplicate clones sharing one lineage count once and four independent lineages satisfy the minimum", () => {
  const rows = [
    experience("lineage-a", 1),
    experience("lineage-a", 2, { extra: { privateProjectPayload: { workspace: "clone-two" } } }),
    experience("lineage-b", 3),
    experience("lineage-c", 4),
    experience("lineage-d", 5),
  ];
  const result = buildRsiCohorts({ experiences: rows, seed: "seed-a" });
  assert.equal(result.ok, true);
  assert.equal(result.distinctLineageCount, 4);
  assert.equal(result.cohorts.train.lineageIds.length, 2);
  assert.equal(result.cohorts.evaluate.lineageIds.length, 1);
  assert.equal(result.cohorts.holdout.lineageIds.length, 1);
});

test("TRAIN, EVALUATE and HOLDOUT are disjoint by lineage ID", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id, index) => experience(`lineage-${id}`, index + 1));
  const { cohorts } = buildRsiCohorts({ experiences: rows, seed: "fixed" });
  const train = new Set(lineages(cohorts.train));
  const evaluate = new Set(lineages(cohorts.evaluate));
  const holdout = new Set(lineages(cohorts.holdout));
  for (const id of evaluate) assert.equal(train.has(id), false);
  for (const id of holdout) {
    assert.equal(train.has(id), false);
    assert.equal(evaluate.has(id), false);
  }
});

test("domain cohort construction uses only the requested compatible sanitized domain cohort", () => {
  const rows = [
    experience("lineage-a", 1), experience("lineage-b", 2),
    experience("lineage-c", 3), experience("lineage-d", 4),
    experience("lineage-ops", 5, { domainCohort: "operations" }),
  ];
  const result = buildRsiCohorts({
    experiences: rows,
    seed: "fixed",
    domainCohort: "software-engineering",
  });
  assert.equal(result.ok, true);
  for (const cohort of Object.values(result.cohorts)) {
    assert.equal(cohort.records.every((record) => record.domainCohort === "software-engineering"), true);
    assert.equal(cohort.lineageIds.includes("lineage-ops"), false);
  }
});

test("global candidate cannot be built below the hard four-lineage minimum", () => {
  const rows = ["a", "b", "c"].map((id, index) => experience(`lineage-${id}`, index + 1));
  const result = buildRsiCohorts({ experiences: rows, seed: "fixed" });
  assert.equal(result.ok, false);
  assert.equal(result.candidateEligible, false);
});

test("cohort assignment is deterministic for reordered inputs under the same seed", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id, index) => experience(`lineage-${id}`, index + 1));
  const forward = buildRsiCohorts({ experiences: rows, seed: "stable-seed" });
  const reversed = buildRsiCohorts({ experiences: [...rows].reverse(), seed: "stable-seed" });
  assert.deepEqual(forward.cohorts, reversed.cohorts);
});

test("cohort objects omit private Project payloads and project identity", () => {
  const rows = ["a", "b", "c", "d"].map((id, index) => experience(`lineage-${id}`, index + 1, {
    extra: {
      privateProjectPayload: { canonicalRoot: `/home/private/project-${id}` },
      source: { lineageId: `lineage-${id}`, projectId: `project-${id}` },
    },
  }));
  const result = buildRsiCohorts({ experiences: rows, seed: "privacy" });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.cohorts);
  assert.equal(serialized.includes("privateProjectPayload"), false);
  assert.equal(serialized.includes("projectId"), false);
  assert.equal(serialized.includes("/home/private"), false);
});
