import test from "node:test";
import assert from "node:assert/strict";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

const PROJECT_ID = "prj-pending-recovery";
const WORK_ID = "work-pending-recovery";
const OPERATION_ID = "op-pending-recovery";
const WORKSPACE_REF = "workspace:pending-recovery";
const RECOVERY_RESULT_REF = `recovery:${OPERATION_ID}:OWNER_TERMINATED_WITHOUT_TERMINALIZATION`;

function seed() {
  const state = createReferenceState();
  assert.equal(state.projects.register({
    schema: "orchestra.project.v2",
    projectId: PROJECT_ID,
    lineageId: "lineage-pending-recovery",
    workspace: { canonicalRoot: "C:/Projects/PendingRecovery", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  }).ok, true);
  assert.equal(state.work.startCurrent({
    schema: "orchestra.work-unit.v2",
    workId: WORK_ID,
    projectId: PROJECT_ID,
    taskId: "task-pending-recovery",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  }).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 0,
    operation: {
      schema: "orchestra.operation.v2",
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      workId: WORK_ID,
      generation: 0,
      kind: "IMPLEMENTATION_MEMBER",
      actorRef: "actor:pending-recovery",
      capabilities: ["WORKSPACE_EDIT"],
      workflowState: "RUNNING",
      liveness: "LIVE",
      startedAt: "2026-10-17T06:00:00.000Z",
      heartbeatAt: "2026-10-17T06:00:00.000Z",
      deadlineAt: "2026-10-17T06:05:00.000Z",
      runtimeOwnerRef: "owner:pending-recovery",
      workspaceRef: WORKSPACE_REF,
      resultRef: null,
    },
  }).ok, true);
  return state;
}

function staleService() {
  return {
    async assess(operation) {
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: operation.operationId,
        observedAt: "2026-10-17T07:00:00.000Z",
        liveness: "STALE_RECOVERABLE",
        reason: "OWNER_ABSENT_BOUNDED_STALE",
        evidence: { ownerStatus: "ABSENT", heartbeatFresh: false, deadlineExpired: true },
      };
    },
  };
}

function workspacePort({ failCleanup = false } = {}) {
  return {
    async inspect(workspaceRef) {
      return { workspaceRef, status: "CLEAN" };
    },
    async cleanup() {
      if (failCleanup) throw new Error("cleanup failed");
    },
  };
}

test("status keeps a terminal Operation visible while cleanup recovery is still pending", async () => {
  const state = seed();
  const recovery = createOperationReconciler({
    state,
    operationLiveness: staleService(),
    workspaceRecovery: workspacePort({ failCleanup: true }),
  });

  const failed = await recovery.recover({
    projectId: PROJECT_ID,
    operationId: OPERATION_ID,
    commandId: "cleanup-failed",
  });
  assert.equal(failed.reason, "RECOVERY_CLEANUP_FAILED");
  assert.equal(state.operations.inspect(OPERATION_ID).liveness, "TERMINAL");

  const statusReconciler = createOperationReconciler({
    state,
    operationLiveness: {
      async assess() { throw new Error("terminal recovery status must not probe liveness"); },
    },
    workspaceRecovery: workspacePort(),
  });
  const status = await statusReconciler.inspect({ projectId: PROJECT_ID });

  assert.equal(status.ok, true);
  assert.equal(status.operations.length, 1, "pending terminal recovery must not disappear from status");
  const [pending] = status.operations;
  assert.equal(pending.operation.operationId, OPERATION_ID);
  assert.equal(pending.operation.liveness, "TERMINAL");
  assert.equal(pending.assessment.liveness, "TERMINAL");
  assert.equal(pending.recovery.outcome, "CLEANUP_FAILED");
  assert.equal(pending.blocksMutation, false);
  assert.equal(pending.recoveryAvailable, true);
  assert.equal(pending.humanGateRequired, false);
  assert.equal(pending.actionRequired, "RETRY_RECOVERY");
});

test("status exposes crash window after recovery terminalization but before journaling", async () => {
  const state = seed();
  assert.equal(state.operations.terminalize({
    operationId: OPERATION_ID,
    workflowState: "ABORTED",
    resultRef: RECOVERY_RESULT_REF,
  }).ok, true);
  assert.equal(state.recoveries.latest({ projectId: PROJECT_ID, operationId: OPERATION_ID }), null);

  const reconciler = createOperationReconciler({
    state,
    operationLiveness: {
      async assess() { throw new Error("terminal recovery status must not probe liveness"); },
    },
    workspaceRecovery: workspacePort(),
  });
  const status = await reconciler.inspect({ projectId: PROJECT_ID });

  assert.equal(status.ok, true);
  assert.equal(status.operations.length, 1, "crash-resumable terminal recovery must remain discoverable");
  const [pending] = status.operations;
  assert.equal(pending.operation.liveness, "TERMINAL");
  assert.equal(pending.assessment.liveness, "TERMINAL");
  assert.equal(pending.recovery, null);
  assert.equal(pending.blocksMutation, false);
  assert.equal(pending.recoveryAvailable, true);
  assert.equal(pending.humanGateRequired, false);
  assert.equal(pending.actionRequired, "RUN_RECOVERY");
});
