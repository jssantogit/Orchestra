import test from "node:test";
import assert from "node:assert/strict";

import { assessOperationLiveness } from "../../v2/liveness/assess.mjs";

const operation = {
  schema: "orchestra.operation.v2",
  operationId: "op-observation-freshness",
  projectId: "prj-observation-freshness",
  workId: "work-observation-freshness",
  generation: 1,
  kind: "DIRECT_MUTATION",
  actorRef: "actor:freshness",
  capabilities: ["WORKSPACE_EDIT"],
  workflowState: "RUNNING",
  liveness: "LIVE",
  startedAt: "2026-10-17T02:59:00.000Z",
  heartbeatAt: "2026-10-17T02:59:55.000Z",
  deadlineAt: "2026-10-17T03:10:00.000Z",
  runtimeOwnerRef: "owner:observation-freshness",
  workspaceRef: "workspace:canonical",
  resultRef: null,
};

const runtimeOwner = {
  schema: "orchestra.runtime-owner.v2",
  runtimeOwnerId: "owner:observation-freshness",
  operationId: "op-observation-freshness",
  kind: "LOCAL_PROCESS",
  process: { pid: 4040, startIdentity: "host-start:freshness" },
  proof: { tokenHash: `sha256:${"f".repeat(64)}` },
  registeredAt: "2026-10-17T02:59:00.000Z",
};

function assess(observedAt) {
  return assessOperationLiveness({
    operation,
    runtimeOwner,
    ownerObservation: {
      schema: "orchestra.owner-observation.v2",
      runtimeOwnerId: runtimeOwner.runtimeOwnerId,
      observedAt,
      status: "MATCH",
      observedProcessIdentity: runtimeOwner.process.startIdentity,
    },
    now: "2026-10-17T03:00:00.000Z",
    heartbeatMaxAgeMs: 30_000,
    ownerObservationMaxAgeMs: 15_000,
    futureSkewToleranceMs: 5_000,
  });
}

test("an old factual MATCH observation expires and cannot keep an Operation LIVE", () => {
  const result = assess("2026-10-17T02:59:40.000Z");
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_OBSERVATION_STALE");
});

test("a future-skewed owner observation is UNKNOWN rather than proof of life", () => {
  const result = assess("2026-10-17T03:00:06.000Z");
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_OBSERVATION_FUTURE_SKEW");
});
