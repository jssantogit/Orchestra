import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { deriveNativeRouteCandidate } from "../../v2/rsi/native-learning.mjs";

const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
function observation(lineageId, operationId, route = "DIRECT_WORK") {
  return {
    schema: "orchestra.rsi-decision-outcome.v1",
    version: 1,
    phase: "TRAIN",
    source: { lineageId, operationId },
    domainCohort: "software-engineering",
    decision: {
      immutableRoutes: ["DIRECT_WORK", "DELEGATED"],
      legalRoutes: ["DIRECT_WORK", "DELEGATED"],
      selectedRoute: route,
    },
    outcome: { success: true, retryCount: 0, durationMs: 250 },
    privacy: { containsRawProjectContent: false },
    evidence: {
      choiceRef: sha(`${lineageId}:${operationId}:choice`),
      outcomeRef: sha(`${lineageId}:${operationId}:outcome`),
    },
  };
}
const metadata = Object.freeze({
  policyId: "native-trained-route",
  revision: 1,
  createdAt: "2026-10-20T09:00:00.000Z",
  domainCohort: "software-engineering",
  trainLineageIds: ["lineage-a", "lineage-b"],
});
const facts = () => [observation("lineage-a", "op-a"), observation("lineage-b", "op-b")];

test("native TRAIN-only derivation chooses exclusively a route observed on both independent lineages", () => {
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: facts() });
  assert.equal(derived.ok, true);
  assert.equal(derived.candidate.lifecycle, "CANDIDATE");
  assert.equal(derived.candidate.scope, "DOMAIN");
  assert.deepEqual(derived.candidate.selectors, { routePreference: "DIRECT_WORK" });
  assert.equal(derived.evidence.trainLineageIds.length, 2);
  assert.equal(derived.evidence.sourceDigest.startsWith("sha256:"), true);
});

test("unobserved candidate choice cannot be supplied through the derivation contract", () => {
  const derived = deriveNativeRouteCandidate({
    ...metadata, observations: facts(), selectors: { routePreference: "UNOBSERVED_ROUTE" },
  });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_INPUT_INVALID");
});

test("conflicting observed routes do not manufacture a winning policy", () => {
  const records = facts();
  records[1].decision.selectedRoute = "DELEGATED";
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: records });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_NO_CONSENSUS");
});

test("two rows from one lineage cannot substitute for two independent Project lineages", () => {
  const derived = deriveNativeRouteCandidate({
    ...metadata, observations: [observation("lineage-a", "op-a"), observation("lineage-a", "op-b")],
  });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_LINEAGES_INVALID");
});

test("a selection not present in immutable and legal choices must never become a policy", () => {
  const records = facts();
  records[1].decision.legalRoutes = ["DELEGATED"];
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: records });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_OBSERVATION_INVALID");
});

test("old Experience lacking bound choices/outcome is not usable as TRAIN provenance", () => {
  const records = facts();
  delete records[0].evidence.choiceRef;
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: records });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_OBSERVATION_INVALID");
});

test("holdout and evaluate records cannot contaminate TRAIN", () => {
  const records = facts();
  records[1].phase = "HOLDOUT";
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: records });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_OBSERVATION_INVALID");
});

test("raw payload or out-of-scope metadata fails closed", () => {
  const records = facts();
  records[0].secret = "private transcript";
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: records });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_OBSERVATION_INVALID");
});

test("TRAIN-only derivation is deterministic and does not persist or activate a policy", () => {
  const forward = deriveNativeRouteCandidate({ ...metadata, observations: facts() });
  const reverse = deriveNativeRouteCandidate({ ...metadata, observations: facts().reverse() });
  assert.deepEqual(forward, reverse);
  assert.equal(Object.hasOwn(forward, "activated"), false);
});

test("the same native receipt cannot attest two independent Project lineages", () => {
  const records = facts();
  records[1].evidence.choiceRef = records[0].evidence.choiceRef;
  const derived = deriveNativeRouteCandidate({ ...metadata, observations: records });
  assert.equal(derived.ok, false);
  assert.equal(derived.code, "RSI_TRAIN_RECEIPT_REUSED");
});
