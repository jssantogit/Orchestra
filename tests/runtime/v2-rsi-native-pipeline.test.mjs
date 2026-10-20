import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { trainNativeRsiCandidate, verifyNativeRsiReplay } from "../../v2/rsi/native-pipeline.mjs";

const sha = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");
function row(lineage, { route = "DIRECT_WORK", success = true, ms = 100 } = {}) {
  return {
    schema: "orchestra.rsi-decision-outcome.v1", version: 1, phase: "TRAIN",
    source: { lineageId: lineage, operationId: "op-" + lineage },
    domainCohort: "software-engineering",
    decision: { immutableRoutes: ["DIRECT_WORK", "DELEGATED"], legalRoutes: ["DIRECT_WORK", "DELEGATED"], selectedRoute: route },
    outcome: { success, retryCount: 0, durationMs: ms },
    privacy: { containsRawProjectContent: false },
    evidence: { choiceRef: sha(lineage+"choice"), outcomeRef: sha(lineage+"terminal") },
  };
}
function backing(data) {
  const candidates = new Map(), receipts = new Map();
  return {
    state: {
      nativeRsi: {
        listObserved: () => structuredClone(data),
        putTrainingReceipt(receipt) {
          receipts.set(receipt.policyId + ":" + receipt.revision, structuredClone(receipt));
          return { ok: true };
        },
        inspectTrainingReceipt: (id, revision) => receipts.get(id + ":" + revision) ?? null,
      },
      learnedPolicies: {},
    },
    policyStore: {
      putCandidate(candidate) { candidates.set(candidate.policyId + ":" + candidate.revision, structuredClone(candidate)); return { ok: true }; },
      inspect(id, revision) { return candidates.get(id + ":" + revision) ?? null; },
    },
    candidates, receipts,
  };
}
const opts = {
  policyId: "native-rsi-v2-route", revision: 1,
  createdAt: "2026-10-20T12:00:00.000Z",
};

test("native trainer derives and persists only from TRAIN and replays on disjoint EVALUATE/HOLDOUT", () => {
  const x = backing(["a","b","c","d"].map(lineage => row(lineage)));
  const trained = trainNativeRsiCandidate({ ...opts, nativeStore: x.state.nativeRsi, policyStore: x.policyStore });
  assert.equal(trained.ok, true, JSON.stringify(trained));
  assert.equal(trained.candidate.selectors.routePreference, "DIRECT_WORK");
  assert.equal(x.candidates.size, 1);
  const verified = verifyNativeRsiReplay({ policyId: opts.policyId, revision: opts.revision,
    nativeStore: x.state.nativeRsi, policyStore: x.policyStore });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.trainVerified, true);
  assert.equal(verified.evaluateVerified, true);
  assert.equal(verified.holdoutVerified, true);
  assert.equal(verified.lineageCount, 4);
});

test("manual candidate without a native TRAIN receipt never passes the replay gate", () => {
  const x = backing(["a","b","c","d"].map(lineage => row(lineage)));
  x.policyStore.putCandidate({
    schema: "orchestra.learned-policy.v2", version: 1,
    policyId: opts.policyId, revision: 1, scope: "DOMAIN",
    domainCohort: "software-engineering", projectId: null,
    lifecycle: "CANDIDATE", selectors: { routePreference: "DIRECT_WORK" },
    createdAt: opts.createdAt,
  });
  const result = verifyNativeRsiReplay({ policyId: opts.policyId, revision: opts.revision,
    nativeStore: x.state.nativeRsi, policyStore: x.policyStore });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_NATIVE_TRAINING_RECEIPT_MISSING");
});

test("unobserved route cannot pass via manually modified persisted policy", () => {
  const x = backing(["a","b","c","d"].map(lineage => row(lineage)));
  assert.equal(trainNativeRsiCandidate({ ...opts, nativeStore: x.state.nativeRsi, policyStore: x.policyStore }).ok, true);
  x.candidates.get(opts.policyId+":1").selectors.routePreference = "UNOBSERVED_ROUTE";
  const result = verifyNativeRsiReplay({ policyId: opts.policyId, revision: 1,
    nativeStore: x.state.nativeRsi, policyStore: x.policyStore });
  assert.equal(result.ok, false);
});

test("changing factual source after TRAIN invalidates its durable source digest", () => {
  const entries = ["a","b","c","d"].map(lineage => row(lineage));
  const x = backing(entries);
  assert.equal(trainNativeRsiCandidate({ ...opts, nativeStore: x.state.nativeRsi, policyStore: x.policyStore }).ok, true);
  for (const record of entries) record.outcome.durationMs += 1;
  assert.equal(verifyNativeRsiReplay({ policyId: opts.policyId, revision: 1,
    nativeStore: x.state.nativeRsi, policyStore: x.policyStore }).ok, false);
});

test("failed EVALUATE or HOLDOUT cannot be omitted to declare replay verified", () => {
  const entries = ["a","b","c","d"].map(lineage => row(lineage));
  const x = backing(entries);
  assert.equal(trainNativeRsiCandidate({ ...opts, nativeStore: x.state.nativeRsi, policyStore: x.policyStore }).ok, true);
  entries[2].outcome.success = false;
  entries[3].outcome.success = false;
  const result = verifyNativeRsiReplay({ policyId: opts.policyId, revision: 1,
    nativeStore: x.state.nativeRsi, policyStore: x.policyStore });
  assert.equal(result.ok, false);
});

test("legacy one-lineage or PROJECT-only Experience cannot fake native observations", () => {
  const x = backing([row("a")]);
  const result = trainNativeRsiCandidate({ ...opts, nativeStore: x.state.nativeRsi, policyStore: x.policyStore });
  assert.equal(result.ok, false);
  assert.equal(x.candidates.size, 0);
});
