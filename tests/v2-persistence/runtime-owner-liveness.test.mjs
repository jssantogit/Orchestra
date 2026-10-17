import test from "node:test";
import assert from "node:assert/strict";

import {
  validateOwnerObservationV2,
  validateRuntimeOwnerV2,
} from "../../v2/liveness/contracts.mjs";
import { assessOperationLiveness } from "../../v2/liveness/assess.mjs";

const NOW = "2026-10-17T02:00:00.000Z";
const TOKEN_HASH = `sha256:${"a".repeat(64)}`;

function operation(overrides = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-live",
    projectId: "prj-live",
    workId: "work-live",
    generation: 3,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:live",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T01:55:00.000Z",
    heartbeatAt: "2026-10-17T01:59:50.000Z",
    deadlineAt: "2026-10-17T02:05:00.000Z",
    runtimeOwnerRef: "owner:op-live",
    workspaceRef: "workspace:canonical",
    resultRef: null,
    ...overrides,
  };
}

function owner(overrides = {}) {
  return {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner:op-live",
    operationId: "op-live",
    kind: "LOCAL_PROCESS",
    process: {
      pid: 4242,
      startIdentity: "host-start:123456",
    },
    proof: {
      tokenHash: TOKEN_HASH,
    },
    registeredAt: "2026-10-17T01:55:00.000Z",
    ...overrides,
  };
}

function observation(status, overrides = {}) {
  return {
    schema: "orchestra.owner-observation.v2",
    runtimeOwnerId: "owner:op-live",
    observedAt: NOW,
    status,
    observedProcessIdentity: status === "MATCH" ? "host-start:123456" : null,
    ...overrides,
  };
}

function assess({ op = operation(), runtimeOwner = owner(), observed = observation("MATCH"), now = NOW } = {}) {
  return assessOperationLiveness({
    operation: op,
    runtimeOwner,
    ownerObservation: observed,
    now,
    heartbeatMaxAgeMs: 30_000,
    futureSkewToleranceMs: 5_000,
  });
}

test("Runtime Owner requires process birth identity and hashed proof, never PID alone", () => {
  assert.equal(validateRuntimeOwnerV2(owner()).valid, true);
  assert.equal(validateRuntimeOwnerV2(owner({ process: { pid: 4242 } })).valid, false);
  assert.equal(validateRuntimeOwnerV2(owner({ proof: { tokenHash: "raw-secret" } })).valid, false);
});

test("Runtime Owner belongs to exactly one Operation and observation belongs to that owner", () => {
  const result = assess({ runtimeOwner: owner({ operationId: "op-other" }) });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_OPERATION_MISMATCH");

  const wrongObservation = assess({
    observed: observation("MATCH", { runtimeOwnerId: "owner:other" }),
  });
  assert.equal(wrongObservation.liveness, "UNKNOWN");
  assert.equal(wrongObservation.reason, "OWNER_OBSERVATION_MISMATCH");
});

test("Owner Observation is a closed factual contract", () => {
  assert.equal(validateOwnerObservationV2(observation("MATCH")).valid, true);
  assert.equal(validateOwnerObservationV2(observation("ABSENT")).valid, true);
  assert.equal(validateOwnerObservationV2(observation("MISMATCH", { observedProcessIdentity: "host-start:999" })).valid, true);
  assert.equal(validateOwnerObservationV2(observation("UNAVAILABLE")).valid, true);
  assert.equal(validateOwnerObservationV2(observation("DEAD")).valid, false);
});

test("persisted RUNNING and LIVE without factual owner observation is UNKNOWN", () => {
  const result = assess({ observed: null });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_OBSERVATION_MISSING");
});

test("matching owner plus fresh heartbeat and live deadline is factual LIVE", () => {
  const result = assess();
  assert.equal(result.liveness, "LIVE");
  assert.equal(result.reason, "OWNER_MATCH_HEARTBEAT_FRESH");
  assert.equal(result.evidence.ownerStatus, "MATCH");
  assert.equal(result.evidence.heartbeatFresh, true);
  assert.equal(result.evidence.deadlineExpired, false);
});

test("matching owner with stale heartbeat is UNKNOWN rather than stealable", () => {
  const result = assess({
    op: operation({ heartbeatAt: "2026-10-17T01:58:00.000Z" }),
  });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_MATCH_HEARTBEAT_STALE");
});

test("matching owner past deadline is UNKNOWN even with a fresh heartbeat", () => {
  const result = assess({
    op: operation({ deadlineAt: "2026-10-17T01:59:59.000Z" }),
  });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_MATCH_DEADLINE_EXPIRED");
});

test("absent owner conflicting with fresh heartbeat is UNKNOWN", () => {
  const result = assess({ observed: observation("ABSENT") });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_ABSENT_HEARTBEAT_FRESH");
});

test("absent owner plus stale heartbeat and expired deadline is STALE_RECOVERABLE", () => {
  const result = assess({
    op: operation({
      heartbeatAt: "2026-10-17T01:58:00.000Z",
      deadlineAt: "2026-10-17T01:59:00.000Z",
    }),
    observed: observation("ABSENT"),
  });
  assert.equal(result.liveness, "STALE_RECOVERABLE");
  assert.equal(result.reason, "OWNER_ABSENT_BOUNDED_STALE");
});

test("PID reuse / owner identity mismatch can never classify LIVE", () => {
  const freshConflict = assess({
    observed: observation("MISMATCH", { observedProcessIdentity: "host-start:999999" }),
  });
  assert.equal(freshConflict.liveness, "UNKNOWN");
  assert.equal(freshConflict.reason, "OWNER_MISMATCH_HEARTBEAT_FRESH");

  const boundedStale = assess({
    op: operation({
      heartbeatAt: "2026-10-17T01:58:00.000Z",
      deadlineAt: "2026-10-17T01:59:00.000Z",
    }),
    observed: observation("MISMATCH", { observedProcessIdentity: "host-start:999999" }),
  });
  assert.equal(boundedStale.liveness, "STALE_RECOVERABLE");
  assert.equal(boundedStale.reason, "OWNER_MISMATCH_BOUNDED_STALE");
});

test("unavailable owner facts always fail closed UNKNOWN", () => {
  const result = assess({
    op: operation({
      heartbeatAt: "2026-10-17T01:00:00.000Z",
      deadlineAt: "2026-10-17T01:01:00.000Z",
    }),
    observed: observation("UNAVAILABLE"),
  });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_OBSERVATION_UNAVAILABLE");
});

test("future-skewed heartbeat is UNKNOWN instead of proof of life", () => {
  const result = assess({
    op: operation({ heartbeatAt: "2026-10-17T02:01:00.000Z" }),
  });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "HEARTBEAT_FUTURE_SKEW");
});

test("terminal Operation remains TERMINAL without owner probing", () => {
  const result = assess({
    op: operation({
      workflowState: "COMPLETED",
      liveness: "TERMINAL",
      resultRef: "result:done",
    }),
    runtimeOwner: null,
    observed: null,
  });
  assert.equal(result.liveness, "TERMINAL");
  assert.equal(result.reason, "PERSISTED_TERMINAL");
});

test("Tsuzuki-style orphan RUNNING record cannot block as LIVE without owner proof", () => {
  const result = assess({
    op: operation({
      operationId: "tsuzuki-f7-g2-parallel-2",
      runtimeOwnerRef: null,
      heartbeatAt: null,
      deadlineAt: null,
      startedAt: "2026-10-16T15:27:58.440Z",
    }),
    runtimeOwner: null,
    observed: null,
  });
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "RUNTIME_OWNER_MISSING");
});
