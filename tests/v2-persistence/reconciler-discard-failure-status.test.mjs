import test from "node:test";
import assert from "node:assert/strict";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createRecoveryAwareStatusReconciler } from "../../v2/reconciliation/recovery-aware-status.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

const PROJECT_ID = "prj-discard-failure-status";
const WORK_ID = "work-discard-failure-status";
const OPERATION_ID = "op-discard-failure-status";
const WORKSPACE_REF = "workspace:discard-failure-status";

function seed() {
  const state = createReferenceState();
  assert.equal(state.projects.register({
    schema: "orchestra.project.v2",
    projectId: PROJECT_ID,
    lineageId: "lineage-discard-failure-status",
    workspace: { canonicalRoot: "C:/Projects/DiscardFailure", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  }).ok, true);
  assert.equal(state.work.startCurrent({
    schema: "orchestra.work-unit.v2",
    workId: WORK_ID,
    projectId: PROJECT_ID,
    taskId: "task-discard-failure-status",
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
      actorRef: "actor:discard-failure-status",
      capabilities: ["WORKSPACE_EDIT"],
      workflowState: "RUNNING",
      liveness: "LIVE",
      startedAt: "2026-10-17T06:00:00.000Z",
      heartbeatAt: "2026-10-17T06:00:00.000Z",
      deadlineAt: "2026-10-17T06:05:00.000Z",
      runtimeOwnerRef: "owner:discard-failure-status",
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

function dirtyWorkspace({ discardFails = false } = {}) {
  return {
    async inspect(workspaceRef) { return { workspaceRef, status: "DIRTY" }; },
    async cleanup() { throw new Error("dirty workspace must not use clean cleanup"); },
    async discard() {
      if (discardFails) throw new Error("discard failed");
    },
  };
}

test("failed explicit dirty discard remains visible and retryable in project status", async () => {
  const state = seed();
  const recoveryPort = dirtyWorkspace({ discardFails: true });
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleService(),
    workspaceRecovery: recoveryPort,
  });

  const failed = await reconciler.resolveDirty({
    projectId: PROJECT_ID,
    operationId: OPERATION_ID,
    action: "DISCARD",
    commandId: "discard-failed-1",
  });
  assert.equal(failed.reason, "DIRTY_DISCARD_FAILED");
  assert.equal(state.operations.inspect(OPERATION_ID).liveness, "TERMINAL");

  const recovery = state.recoveries.latest({ projectId: PROJECT_ID, operationId: OPERATION_ID });
  assert.equal(recovery.outcome, "STALE_DIRTY");
  assert.equal(recovery.resolutionAction, "DISCARD", "journal must preserve the operator action that failed");

  const statusPort = dirtyWorkspace();
  const base = createOperationReconciler({
    state,
    operationLiveness: {
      async assess() { throw new Error("terminal status must not probe liveness"); },
    },
    workspaceRecovery: statusPort,
  });
  const status = await createRecoveryAwareStatusReconciler({
    state,
    reconciler: base,
    workspaceRecovery: statusPort,
  }).inspect({ projectId: PROJECT_ID });

  assert.equal(status.operations.length, 1);
  const [pending] = status.operations;
  assert.equal(pending.operation.operationId, OPERATION_ID);
  assert.equal(pending.recovery.resolutionAction, "DISCARD");
  assert.equal(pending.recoveryAvailable, false);
  assert.equal(pending.humanGateRequired, false);
  assert.equal(pending.actionRequired, "RETRY_DIRTY_DISCARD");
});
