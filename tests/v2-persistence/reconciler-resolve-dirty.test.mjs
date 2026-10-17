import test from "node:test";
import assert from "node:assert/strict";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

const RESULT_REF = "recovery:op-dirty:OWNER_TERMINATED_WITHOUT_TERMINALIZATION";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-dirty",
    lineageId: "lineage-dirty",
    workspace: { canonicalRoot: "C:/Projects/Dirty", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-dirty",
    projectId: "prj-dirty",
    taskId: "task-dirty",
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
  };
}

function operation() {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-dirty",
    projectId: "prj-dirty",
    workId: "work-dirty",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:dirty",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T10:00:00.000Z",
    heartbeatAt: "2026-10-17T10:00:00.000Z",
    deadlineAt: "2026-10-17T10:05:00.000Z",
    runtimeOwnerRef: "owner:dirty",
    workspaceRef: "workspace:dirty",
    resultRef: null,
  };
}

function seed() {
  const state = createReferenceState();
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  return state;
}

function staleLiveness() {
  return {
    async assess(op) {
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: op.operationId,
        observedAt: "2026-10-17T10:06:00.000Z",
        liveness: "STALE_RECOVERABLE",
        reason: "OWNER_ABSENT_BOUNDED_STALE",
        evidence: { ownerStatus: "ABSENT", heartbeatFresh: false, deadlineExpired: true },
      };
    },
  };
}

function dirtyWorkspace({ discardResult = { workspaceRef: "workspace:dirty", discarded: true } } = {}) {
  let discardCalls = 0;
  return {
    port: {
      async inspect(workspaceRef, op) {
        assert.equal(workspaceRef, "workspace:dirty");
        assert.equal(op.operationId, "op-dirty");
        return { workspaceRef, status: discardCalls > 0 ? "ABSENT" : "DIRTY" };
      },
      async cleanup() { throw new Error("automatic cleanup must never handle dirty workspace"); },
      async discard(workspaceRef, op) {
        assert.equal(workspaceRef, "workspace:dirty");
        assert.equal(op.operationId, "op-dirty");
        discardCalls += 1;
        return discardResult;
      },
    },
    discardCalls: () => discardCalls,
  };
}

test("resolveDirty PRESERVE terminalizes stale ownership while preserving dirty workspace", async () => {
  const state = seed();
  const workspace = dirtyWorkspace();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleLiveness(),
    workspaceRecovery: workspace.port,
  });

  const first = await reconciler.resolveDirty({
    projectId: "prj-dirty",
    operationId: "op-dirty",
    action: "PRESERVE",
    commandId: "resolve-preserve-1",
  });

  assert.equal(first.ok, true);
  assert.equal(first.resolved, true);
  assert.equal(first.action, "PRESERVE");
  assert.equal(first.replayed, false);
  assert.equal(first.operation.liveness, "TERMINAL");
  assert.equal(first.operation.workflowState, "ABORTED");
  assert.equal(first.operation.resultRef, RESULT_REF);
  assert.equal(first.workspace.status, "DIRTY");
  assert.equal(first.preserved, true);
  assert.equal(workspace.discardCalls(), 0);

  const journal = state.recoveries.byCommand({ projectId: "prj-dirty", commandId: "resolve-preserve-1" });
  assert.equal(journal.outcome, "STALE_DIRTY");
  assert.equal(journal.terminal.resultRef, RESULT_REF);
  assert.equal(journal.cleanup.status, "PRESERVED");

  const replay = await reconciler.resolveDirty({
    projectId: "prj-dirty",
    operationId: "op-dirty",
    action: "PRESERVE",
    commandId: "resolve-preserve-1",
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.action, "PRESERVE");
  assert.equal(workspace.discardCalls(), 0);
});

test("resolveDirty DISCARD terminalizes then deletes only through explicit workspace discard port", async () => {
  const state = seed();
  const workspace = dirtyWorkspace();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleLiveness(),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.resolveDirty({
    projectId: "prj-dirty",
    operationId: "op-dirty",
    action: "DISCARD",
    commandId: "resolve-discard-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolved, true);
  assert.equal(result.action, "DISCARD");
  assert.equal(result.operation.liveness, "TERMINAL");
  assert.equal(result.workspace.status, "ABSENT");
  assert.equal(result.discarded, true);
  assert.equal(workspace.discardCalls(), 1);

  const journal = state.recoveries.byCommand({ projectId: "prj-dirty", commandId: "resolve-discard-1" });
  assert.equal(journal.outcome, "RECOVERED");
  assert.equal(journal.workspace.status, "ABSENT");
  assert.equal(journal.cleanup.status, "NOT_REQUIRED");
});

test("resolveDirty refuses LIVE, UNKNOWN, non-dirty and unsupported discard cases", async () => {
  for (const [assessment, expected] of [
    ["LIVE", "OPERATION_LIVE"],
    ["UNKNOWN", "OPERATION_LIVENESS_UNKNOWN"],
  ]) {
    const state = seed();
    const workspace = dirtyWorkspace();
    const reconciler = createOperationReconciler({
      state,
      operationLiveness: {
        async assess(op) {
          return {
            schema: "orchestra.liveness-assessment.v2",
            operationId: op.operationId,
            observedAt: "2026-10-17T10:06:00.000Z",
            liveness: assessment,
            reason: assessment === "LIVE" ? "OWNER_MATCH_HEARTBEAT_FRESH" : "OWNER_OBSERVATION_UNAVAILABLE",
            evidence: { ownerStatus: null, heartbeatFresh: null, deadlineExpired: null },
          };
        },
      },
      workspaceRecovery: workspace.port,
    });
    const result = await reconciler.resolveDirty({
      projectId: "prj-dirty",
      operationId: "op-dirty",
      action: "PRESERVE",
      commandId: `resolve-${assessment.toLowerCase()}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, expected);
    assert.equal(state.operations.inspect("op-dirty").liveness, "LIVE");
  }

  const cleanState = seed();
  const cleanReconciler = createOperationReconciler({
    state: cleanState,
    operationLiveness: staleLiveness(),
    workspaceRecovery: {
      async inspect(ref) { return { workspaceRef: ref, status: "CLEAN" }; },
      async cleanup() {},
      async discard() {},
    },
  });
  assert.deepEqual(await cleanReconciler.resolveDirty({
    projectId: "prj-dirty",
    operationId: "op-dirty",
    action: "PRESERVE",
    commandId: "resolve-not-dirty",
  }), {
    ok: false,
    reason: "WORKSPACE_NOT_DIRTY",
    workspace: { workspaceRef: "workspace:dirty", status: "CLEAN" },
  });

  const unsupportedState = seed();
  const unsupported = createOperationReconciler({
    state: unsupportedState,
    operationLiveness: staleLiveness(),
    workspaceRecovery: {
      async inspect(ref) { return { workspaceRef: ref, status: "DIRTY" }; },
      async cleanup() {},
    },
  });
  const noDiscard = await unsupported.resolveDirty({
    projectId: "prj-dirty",
    operationId: "op-dirty",
    action: "DISCARD",
    commandId: "resolve-no-discard",
  });
  assert.equal(noDiscard.ok, false);
  assert.equal(noDiscard.reason, "DIRTY_DISCARD_UNAVAILABLE");
  assert.equal(unsupportedState.operations.inspect("op-dirty").liveness, "LIVE");
});

test("resolveDirty validates explicit action, project scope and idempotency identity", async () => {
  const state = seed();
  const workspace = dirtyWorkspace();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleLiveness(),
    workspaceRecovery: workspace.port,
  });

  assert.equal((await reconciler.resolveDirty({
    projectId: "prj-dirty",
    operationId: "op-dirty",
    action: "DELETE",
    commandId: "bad-action",
  })).reason, "DIRTY_RESOLUTION_COMMAND_INVALID");
  assert.equal((await reconciler.resolveDirty({
    projectId: "prj-other",
    operationId: "op-dirty",
    action: "PRESERVE",
    commandId: "wrong-project",
  })).reason, "PROJECT_NOT_FOUND");
});
