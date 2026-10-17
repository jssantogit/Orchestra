import test from "node:test";
import assert from "node:assert/strict";

import {
  validateLivenessAssessmentV2,
  validateOwnerObservationV2,
  validateRuntimeOwnerV2,
} from "../../v2/liveness/contracts.mjs";

test("Runtime Owner and Owner Observation reject undeclared authority fields", () => {
  const owner = {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner:closed",
    operationId: "op-closed",
    kind: "LOCAL_PROCESS",
    process: { pid: 100, startIdentity: "host-start:100" },
    proof: { tokenHash: `sha256:${"b".repeat(64)}` },
    registeredAt: "2026-10-17T02:00:00.000Z",
  };
  const observation = {
    schema: "orchestra.owner-observation.v2",
    runtimeOwnerId: "owner:closed",
    observedAt: "2026-10-17T02:00:01.000Z",
    status: "MATCH",
    observedProcessIdentity: "host-start:100",
  };

  assert.equal(validateRuntimeOwnerV2({ ...owner, sessionId: "chat-owner" }).valid, false);
  assert.equal(validateOwnerObservationV2({ ...observation, trustedByModel: true }).valid, false);
});

test("Liveness Assessment is a closed factual contract", () => {
  const assessment = {
    schema: "orchestra.liveness-assessment.v2",
    operationId: "op-closed",
    observedAt: "2026-10-17T02:00:02.000Z",
    liveness: "UNKNOWN",
    reason: "OWNER_OBSERVATION_UNAVAILABLE",
    evidence: {
      ownerStatus: "UNAVAILABLE",
      heartbeatFresh: null,
      deadlineExpired: null,
    },
  };

  assert.equal(validateLivenessAssessmentV2(assessment).valid, true);
  assert.equal(validateLivenessAssessmentV2({ ...assessment, trustedByModel: true }).valid, false);
  assert.equal(validateLivenessAssessmentV2({ ...assessment, liveness: "RUNNING" }).valid, false);
  assert.equal(validateLivenessAssessmentV2({
    ...assessment,
    evidence: { ...assessment.evidence, ownerStatus: "DEAD" },
  }).valid, false);
});
