import test from "node:test";
import assert from "node:assert/strict";

import { validateOperationRecoveryV2 } from "../../v2/reconciliation/contracts.mjs";

function record(overrides = {}) {
  return {
    schema: "orchestra.operation-recovery.v2",
    projectId: "prj-resolution-contract",
    operationId: "op-resolution-contract",
    workId: "work-resolution-contract",
    generation: 1,
    commandId: "resolution-command",
    assessment: {
      liveness: "TERMINAL",
      reason: "RECOVERY_TERMINAL_PENDING_DIRTY_RESOLUTION",
      observedAt: "2026-10-17T08:00:00.000Z",
    },
    workspace: { ref: "workspace:resolution-contract", status: "DIRTY" },
    terminal: {
      workflowState: "ABORTED",
      resultRef: "recovery:op-resolution-contract:OWNER_TERMINATED_WITHOUT_TERMINALIZATION",
    },
    cleanup: { status: "PRESERVED" },
    outcome: "STALE_DIRTY",
    resolutionAction: "DISCARD",
    recordedAt: "2026-10-17T08:01:00.000Z",
    ...overrides,
  };
}

test("failed DISCARD remains a valid preserved stale-dirty recovery fact", () => {
  assert.equal(validateOperationRecoveryV2(record()).valid, true);
});

test("successful DISCARD requires factual workspace absence rather than generic clean recovery", () => {
  const impossible = record({
    workspace: { ref: "workspace:resolution-contract", status: "CLEAN" },
    cleanup: { status: "CLEANED" },
    outcome: "RECOVERED",
  });
  assert.equal(validateOperationRecoveryV2(impossible).valid, false);

  const discarded = record({
    assessment: {
      liveness: "TERMINAL",
      reason: "STALE_DIRTY_EXPLICIT_DISCARD",
      observedAt: "2026-10-17T08:00:00.000Z",
    },
    workspace: { ref: "workspace:resolution-contract", status: "ABSENT" },
    cleanup: { status: "NOT_REQUIRED" },
    outcome: "RECOVERED",
  });
  assert.equal(validateOperationRecoveryV2(discarded).valid, true);
});

test("PRESERVE resolution cannot masquerade as recovered or non-dirty", () => {
  const invalid = record({
    resolutionAction: "PRESERVE",
    workspace: { ref: "workspace:resolution-contract", status: "ABSENT" },
    cleanup: { status: "NOT_REQUIRED" },
    outcome: "RECOVERED",
  });
  assert.equal(validateOperationRecoveryV2(invalid).valid, false);
});
