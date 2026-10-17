import test from "node:test";
import assert from "node:assert/strict";

import { validateOperationRecoveryV2 } from "../../v2/reconciliation/contracts.mjs";

function recovery(overrides = {}) {
  const operationId = overrides.operationId ?? "op-semantics";
  const base = {
    schema: "orchestra.operation-recovery.v2",
    projectId: "prj-semantics",
    operationId,
    workId: "work-semantics",
    generation: 0,
    commandId: "recover-semantics",
    assessment: {
      liveness: "STALE_RECOVERABLE",
      reason: "OWNER_ABSENT_BOUNDED_STALE",
      observedAt: "2026-10-17T10:00:00.000Z",
    },
    workspace: { ref: "workspace:semantics", status: "CLEAN" },
    terminal: {
      workflowState: "ABORTED",
      resultRef: `recovery:${operationId}:OWNER_TERMINATED_WITHOUT_TERMINALIZATION`,
    },
    cleanup: { status: "CLEANED" },
    outcome: "RECOVERED",
    recordedAt: "2026-10-17T10:00:01.000Z",
  };
  return {
    ...base,
    ...overrides,
    assessment: { ...base.assessment, ...(overrides.assessment ?? {}) },
    workspace: { ...base.workspace, ...(overrides.workspace ?? {}) },
    cleanup: { ...base.cleanup, ...(overrides.cleanup ?? {}) },
  };
}

test("Recovery contract accepts only semantically coherent durable outcomes", () => {
  const recoveredClean = recovery();
  const recoveredAbsent = recovery({
    workspace: { ref: null, status: "ABSENT" },
    cleanup: { status: "NOT_REQUIRED" },
  });
  const staleDirty = recovery({
    workspace: { status: "DIRTY" },
    terminal: null,
    cleanup: { status: "PRESERVED" },
    outcome: "STALE_DIRTY",
  });
  const terminalDirty = recovery({
    assessment: { liveness: "TERMINAL", reason: "RECOVERY_TERMINAL_PENDING_CLEANUP" },
    workspace: { status: "DIRTY" },
    cleanup: { status: "PRESERVED" },
    outcome: "STALE_DIRTY",
  });
  const cleanupFailed = recovery({
    cleanup: { status: "FAILED" },
    outcome: "CLEANUP_FAILED",
  });

  for (const record of [recoveredClean, recoveredAbsent, staleDirty, terminalDirty, cleanupFailed]) {
    assert.equal(validateOperationRecoveryV2(record).valid, true);
  }
});

test("Recovery contract rejects success records without factual terminalization", () => {
  assert.equal(validateOperationRecoveryV2(recovery({ terminal: null })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({ cleanup: { status: "FAILED" } })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({ workspace: { status: "DIRTY" } })).valid, false);
});

test("Recovery contract rejects contradictory dirty and cleanup-failed outcomes", () => {
  assert.equal(validateOperationRecoveryV2(recovery({
    outcome: "STALE_DIRTY",
    workspace: { status: "CLEAN" },
    cleanup: { status: "PRESERVED" },
    terminal: null,
  })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({
    outcome: "STALE_DIRTY",
    workspace: { status: "DIRTY" },
    cleanup: { status: "CLEANED" },
    terminal: null,
  })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({
    outcome: "CLEANUP_FAILED",
    cleanup: { status: "FAILED" },
    terminal: null,
  })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({
    outcome: "CLEANUP_FAILED",
    workspace: { status: "UNKNOWN" },
    cleanup: { status: "FAILED" },
  })).valid, false);
});

test("Recovery contract rejects records that claim recovery from LIVE or UNKNOWN liveness", () => {
  assert.equal(validateOperationRecoveryV2(recovery({
    assessment: { liveness: "LIVE", reason: "OWNER_MATCH_HEARTBEAT_FRESH" },
  })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({
    assessment: { liveness: "UNKNOWN", reason: "OWNER_OBSERVATION_UNAVAILABLE" },
  })).valid, false);
});

test("Recovery contract binds terminal result provenance to the recovered Operation", () => {
  assert.equal(validateOperationRecoveryV2(recovery({
    terminal: { workflowState: "FAILED", resultRef: "result:other" },
  })).valid, false);
  assert.equal(validateOperationRecoveryV2(recovery({
    terminal: {
      workflowState: "ABORTED",
      resultRef: "recovery:op-other:OWNER_TERMINATED_WITHOUT_TERMINALIZATION",
    },
  })).valid, false);
});

test("workspace without a factual ref can only be ABSENT", () => {
  assert.equal(validateOperationRecoveryV2(recovery({
    workspace: { ref: null, status: "CLEAN" },
  })).valid, false);
});
