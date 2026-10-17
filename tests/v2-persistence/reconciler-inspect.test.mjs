import test from "node:test";
import assert from "node:assert/strict";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

function makeProject() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-inspect",
    lineageId: "lineage-inspect",
    workspace: { canonicalRoot: "C:/Projects/Inspect", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 2 },
    trust: { mode: "trusted" },
  };
}

function makeWork() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-inspect",
    projectId: "prj-inspect",
    taskId: "task-inspect",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 2,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function makeOperation(operationId, workspaceRef) {
  return {
    schema: "orchestra.operation.v2",
    operationId,
    projectId: "prj-inspect",
    workId: "work-inspect",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: `actor:${operationId}`,
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T06:00:00.000Z",
    heartbeatAt: "2026-10-17T06:00:00.000Z",
    deadlineAt: "2026-10-17T06:05:00.000Z",
    runtimeOwnerRef: `owner:${operationId}`,
    workspaceRef,
    resultRef: null,
  };
}

function seed() {
  const state = createReferenceState();
  assert.equal(state.projects.register(makeProject()).ok, true);
  assert.equal(state.work.startCurrent(makeWork()).ok, true);
  for (const [id, workspace] of [
    ["op-live", "workspace:live"],
    ["op-stale", "workspace:stale"],
    ["op-unknown", "workspace:unknown"],
  ]) {
    assert.equal(state.operations.begin({
      expectedGeneration: 0,
      operation: makeOperation(id, workspace),
    }).ok, true);
  }
  return state;
}

function livenessService() {
  return {
    async assess(operation) {
      const table = {
        "op-live": ["LIVE", "OWNER_MATCH_HEARTBEAT_FRESH"],
        "op-stale": ["STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE"],
        "op-unknown": ["UNKNOWN", "OWNER_OBSERVATION_UNAVAILABLE"],
      };
      const [liveness, reason] = table[operation.operationId];
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: operation.operationId,
        observedAt: "2026-10-17T07:00:00.000Z",
        liveness,
        reason,
        evidence: { ownerStatus: null, heartbeatFresh: null, deadlineExpired: null },
      };
    },
  };
}

function inspectionWorkspacePort(staleStatus = "CLEAN") {
  return {
    async inspect(workspaceRef, operation) {
      assert.equal(operation.operationId, "op-stale", "only factual stale candidates need workspace recovery inspection");
      return { workspaceRef, status: staleStatus };
    },
    async cleanup() { throw new Error("status inspection must never cleanup workspace state"); },
  };
}

test("Reconciler.inspect replaces persisted LIVE enums with factual liveness without mutation", async () => {
  const state = seed();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: livenessService(),
    workspaceRecovery: inspectionWorkspacePort("CLEAN"),
  });

  const before = ["op-live", "op-stale", "op-unknown"].map((id) => state.operations.inspect(id));
  const result = await reconciler.inspect({ projectId: "prj-inspect" });
  const after = ["op-live", "op-stale", "op-unknown"].map((id) => state.operations.inspect(id));

  assert.equal(result.ok, true);
  assert.equal(result.project.projectId, "prj-inspect");
  assert.equal(result.work.workId, "work-inspect");
  assert.deepEqual(after, before, "status inspection must never rewrite Operation state");
  assert.equal(result.operations.length, 3);

  const byId = new Map(result.operations.map((item) => [item.operation.operationId, item]));
  assert.equal(byId.get("op-live").assessment.liveness, "LIVE");
  assert.equal(byId.get("op-live").blocksMutation, true);
  assert.equal(byId.get("op-live").recoveryAvailable, false);
  assert.equal(byId.get("op-live").workspace, null);
  assert.equal(byId.get("op-live").humanGateRequired, false);
  assert.equal(byId.get("op-live").actionRequired, "WAIT_FOR_LIVE_OPERATION");

  assert.equal(byId.get("op-stale").assessment.liveness, "STALE_RECOVERABLE");
  assert.equal(byId.get("op-stale").blocksMutation, false);
  assert.equal(byId.get("op-stale").recoveryAvailable, true);
  assert.deepEqual(byId.get("op-stale").workspace, { workspaceRef: "workspace:stale", status: "CLEAN" });
  assert.equal(byId.get("op-stale").humanGateRequired, false);
  assert.equal(byId.get("op-stale").actionRequired, "RUN_RECOVERY");

  assert.equal(byId.get("op-unknown").assessment.liveness, "UNKNOWN");
  assert.equal(byId.get("op-unknown").blocksMutation, true);
  assert.equal(byId.get("op-unknown").recoveryAvailable, false);
  assert.equal(byId.get("op-unknown").workspace, null);
  assert.equal(byId.get("op-unknown").humanGateRequired, true);
  assert.equal(byId.get("op-unknown").actionRequired, "RESOLVE_LIVENESS");
});

test("Reconciler.inspect does not promise automatic recovery for dirty or unknown stale workspaces", async () => {
  for (const [workspaceStatus, expected] of [
    ["DIRTY", { humanGateRequired: false, actionRequired: "RESOLVE_DIRTY_WORKSPACE" }],
    ["UNKNOWN", { humanGateRequired: true, actionRequired: "PROVE_WORKSPACE_IDENTITY" }],
  ]) {
    const state = seed();
    const reconciler = createOperationReconciler({
      state,
      operationLiveness: livenessService(),
      workspaceRecovery: inspectionWorkspacePort(workspaceStatus),
    });
    const result = await reconciler.inspect({ projectId: "prj-inspect" });
    const stale = result.operations.find((item) => item.operation.operationId === "op-stale");

    assert.deepEqual(stale.workspace, { workspaceRef: "workspace:stale", status: workspaceStatus });
    assert.equal(stale.recoveryAvailable, false);
    assert.equal(stale.humanGateRequired, expected.humanGateRequired);
    assert.equal(stale.actionRequired, expected.actionRequired);
  }
});

test("Reconciler.inspect includes the latest durable recovery fact for a blocking candidate", async () => {
  const state = seed();
  const op = state.operations.inspect("op-stale");
  assert.equal(state.recoveries.record({
    schema: "orchestra.operation-recovery.v2",
    projectId: op.projectId,
    operationId: op.operationId,
    workId: op.workId,
    generation: op.generation,
    commandId: "previous-dirty-check",
    assessment: {
      liveness: "STALE_RECOVERABLE",
      reason: "OWNER_ABSENT_BOUNDED_STALE",
      observedAt: "2026-10-17T06:55:00.000Z",
    },
    workspace: { ref: op.workspaceRef, status: "DIRTY" },
    terminal: null,
    cleanup: { status: "PRESERVED" },
    outcome: "STALE_DIRTY",
    recordedAt: "2026-10-17T06:55:01.000Z",
  }).ok, true);

  const reconciler = createOperationReconciler({
    state,
    operationLiveness: livenessService(),
    workspaceRecovery: inspectionWorkspacePort("DIRTY"),
  });
  const result = await reconciler.inspect({ projectId: "prj-inspect" });
  const stale = result.operations.find((item) => item.operation.operationId === "op-stale");

  assert.equal(stale.recovery.outcome, "STALE_DIRTY");
  assert.equal(stale.recovery.cleanup.status, "PRESERVED");
  assert.equal(stale.recovery.commandId, "previous-dirty-check");
  assert.equal(stale.recoveryAvailable, false);
  assert.equal(stale.actionRequired, "RESOLVE_DIRTY_WORKSPACE");
});

test("Reconciler.inspect converts assessment failure into explicit UNKNOWN instead of omitting a candidate", async () => {
  const state = seed();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: {
      async assess(operation) {
        if (operation.operationId === "op-stale") throw new Error("probe unavailable");
        return livenessService().assess(operation);
      },
    },
    workspaceRecovery: inspectionWorkspacePort("CLEAN"),
  });

  const result = await reconciler.inspect({ projectId: "prj-inspect" });
  const stale = result.operations.find((item) => item.operation.operationId === "op-stale");
  assert.equal(stale.assessment.liveness, "UNKNOWN");
  assert.equal(stale.assessment.reason, "ASSESSMENT_INVALID");
  assert.equal(stale.blocksMutation, true);
  assert.equal(stale.recoveryAvailable, false);
  assert.equal(stale.workspace, null);
  assert.equal(stale.humanGateRequired, true);
  assert.equal(stale.actionRequired, "RESOLVE_LIVENESS");
});

test("Reconciler.inspect is project-scoped and explains an empty project without side effects", async () => {
  const state = createReferenceState();
  assert.equal(state.projects.register(makeProject()).ok, true);
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: {
      async assess() { throw new Error("no candidates means no probe"); },
    },
    workspaceRecovery: {
      async inspect() { throw new Error("no candidates means no workspace inspection"); },
      async cleanup() { throw new Error("status must never cleanup"); },
    },
  });

  assert.deepEqual(await reconciler.inspect({ projectId: "prj-missing" }), {
    ok: false,
    reason: "PROJECT_NOT_FOUND",
  });

  const result = await reconciler.inspect({ projectId: "prj-inspect" });
  assert.equal(result.ok, true);
  assert.equal(result.work, null);
  assert.deepEqual(result.operations, []);
});
