import test from "node:test";
import assert from "node:assert/strict";

import { classifyLegacyInventoryEntry } from "../../v2/migration/transient-classifier.mjs";

const tsuzukiF7Entry = Object.freeze({
  path: ".orchestra/state/delegation/parallel-groups/tsuzuki-f7-g2-parallel-2/group.json",
  category: "TRANSIENT_PARALLEL_GROUP",
  schema: "orchestra.parallel-group-state.v1",
  version: 1,
  digest: `sha256:${"f".repeat(64)}`,
  integrity: "PARSED",
  dispositionBasis: "TRANSIENT_STATE",
  private: false,
});

const tsuzukiF7Facts = Object.freeze({
  groupId: "tsuzuki-f7-g2-parallel-2",
  persistedState: "RUNNING",
  createdAt: "2026-10-16T15:27:58.440Z",
  updatedAt: "2026-10-16T15:27:58.446Z",
  memberArtifactIds: Object.freeze([]),
  compositeArtifactId: null,
  survivingWorkspaces: 2,
  ownerProcessProof: "ABSENT",
  canonicalPromotion: false,
  runtimeVersion: "v1.4.2",
});

test("Tsuzuki F7 persisted RUNNING is recoverable evidence, never factual LIVE or success", () => {
  const result = classifyLegacyInventoryEntry({
    entry: tsuzukiF7Entry,
    facts: tsuzukiF7Facts,
  });

  assert.equal(result.ok, true);
  assert.equal(result.disposition, "RECOVERABLE_IMPORT");
  assert.equal(result.blocksActivation, false);
  assert.equal(result.authorityClaim, false);
  assert.deepEqual(result.legacyEvidence, {
    persistedState: "RUNNING",
    runtimeVersion: "v1.4.2",
    ownerProcessProof: "ABSENT",
    survivingWorkspaces: 2,
    canonicalPromotion: false,
  });
  assert.equal(result.reconciliation.eligible, true);
  assert.equal(result.reconciliation.liveness, "UNKNOWN");
  assert.notEqual(result.reconciliation.liveness, "LIVE");
  assert.equal(result.reconciliation.successClaim, false);
  assert.equal(result.reconciliation.workspaceIdentity, "AMBIGUOUS");
  assert.equal(result.reconciliation.cleanupAuthorized, false);
  assert.equal(result.reconciliation.actionRequired, "RECONCILE_LEGACY_TRANSIENT_STATE");
});

test("F7 ambiguity remains explicit even though no canonical promotion was recorded", () => {
  const result = classifyLegacyInventoryEntry({
    entry: tsuzukiF7Entry,
    facts: tsuzukiF7Facts,
  });
  assert.equal(result.disposition, "RECOVERABLE_IMPORT");
  assert.equal(result.reconciliation.workspaceIdentity, "AMBIGUOUS");
  assert.equal(result.reconciliation.cleanupAuthorized, false);
  assert.equal(result.reconciliation.canonicalPromotionClaim, false);
});

test("same orphan shape on unsupported legacy runtime is blocked with actionable diagnostic", () => {
  const result = classifyLegacyInventoryEntry({
    entry: tsuzukiF7Entry,
    facts: { ...tsuzukiF7Facts, runtimeVersion: "v1.0.0" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "UNSUPPORTED_BLOCKED");
  assert.equal(result.blocksActivation, true);
  assert.equal(result.authorityClaim, false);
  assert.equal(result.diagnostic.code, "LEGACY_RUNTIME_UNSUPPORTED");
  assert.equal(result.reconciliation.eligible, false);
});
