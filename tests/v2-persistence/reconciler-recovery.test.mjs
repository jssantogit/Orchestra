import test from "node:test";
import assert from "node:assert/strict";

import { createReferenceState } from "../../v2/state/reference-state.mjs";

const reconcilerModule = await import("../../v2/reconciliation/reconciler.mjs").catch(() => null);

function project(projectId = "prj-recovery") {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot: `C:/Projects/${projectId}`, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 4 },
    trust: { mode: "trusted" },
  };
}

function work(projectId = "prj-recovery", workId = "work-recovery") {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId: "task-recovery",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 4,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation({
  projectId = "prj-recovery",
  workId = "work-recovery",
  operationId = "op-recovery",
  workspaceRef = "workspace:ephemeral",
} = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId,
    projectId,
    workId,
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:worker",
    capabilities: workspaceRef === null ? [] : ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T05:00:00.000Z",
    heartbeatAt: "2026-10-17T05:00:00.000Z",
    deadlineAt: "2026-10-17T05:05:00.000Z",
    runtimeOwnerRef: `owner:${operationId}`,
    workspaceRef,
    resultRef: null,
  };
}

function seeded(options = {}) {
  const state = createReferenceState();
  const p = project(options.projectId);
  const w = work(p.projectId, options.workId);
  const op = operation({ projectId: p.projectId, workId: w.workId, ...options });
  assert.equal(state.projects.register(p).ok, true);
  assert.equal(state.work.startCurrent(w).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: op }).ok, true);
  return { state, project: p, work: w, operation: op };
}

function assessment(liveness, reason = "fixture") {
  return {
    async assess(op) {
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: op.operationId,
        observedAt: "2026-10-17T06:00:00.000Z",
        liveness,
        reason,
        evidence: { ownerStatus: null, heartbeatFresh: null, deadlineExpired: null },
      };
    },
  };
}

function workspacePort(status, { cleanupError = null } = {}) {
  const calls = { inspect: 0, cleanup: 0 };
  return {
    calls,
    port: {
      async inspect(workspaceRef) {
        calls.inspect += 1;
        return { workspaceRef, status };
      },
      async cleanup(workspaceRef) {
        calls.cleanup += 1;
        if (cleanupError) throw cleanupError;
        return { workspaceRef, cleaned: true };
      },
    },
  };
}

function createReconciler(args) {
  assert.equal(typeof reconcilerModule?.createOperationReconciler, "function", "V2-4 reconciler factory must exist");
  return reconcilerModule.createOperationReconciler(args);
}

test("V2-4 exposes a neutral Operation Reconciler", () => {
  assert.equal(typeof reconcilerModule?.createOperationReconciler, "function");
});

test("factual LIVE operation cannot be recovered or cleaned", async () => {
  const fixture = seeded();
  const workspace = workspacePort("CLEAN");
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("LIVE", "OWNER_MATCH_HEARTBEAT_FRESH"),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-live",
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "OPERATION_LIVE",
    operationId: fixture.operation.operationId,
    livenessReason: "OWNER_MATCH_HEARTBEAT_FRESH",
  });
  assert.equal(fixture.state.operations.inspect(fixture.operation.operationId).liveness, "LIVE");
  assert.equal(workspace.calls.cleanup, 0);
});

test("UNKNOWN liveness returns a Human Gate without terminalization or cleanup", async () => {
  const fixture = seeded();
  const workspace = workspacePort("CLEAN");
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("UNKNOWN", "OWNER_OBSERVATION_UNAVAILABLE"),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-unknown",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "OPERATION_LIVENESS_UNKNOWN");
  assert.equal(result.humanGate, true);
  assert.equal(result.livenessReason, "OWNER_OBSERVATION_UNAVAILABLE");
  assert.equal(fixture.state.operations.inspect(fixture.operation.operationId).liveness, "LIVE");
  assert.equal(workspace.calls.cleanup, 0);
});

test("bounded stale operation with absent workspace is terminalized deterministically without cleanup", async () => {
  const fixture = seeded({ workspaceRef: null });
  const workspace = workspacePort("ABSENT");
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE"),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-stale-absent",
  });

  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.replayed, false);
  assert.equal(result.cleanup.status, "NOT_REQUIRED");
  const stored = fixture.state.operations.inspect(fixture.operation.operationId);
  assert.equal(stored.liveness, "TERMINAL");
  assert.equal(stored.workflowState, "ABORTED");
  assert.equal(stored.resultRef, `recovery:${fixture.operation.operationId}:OWNER_TERMINATED_WITHOUT_TERMINALIZATION`);
  assert.equal(workspace.calls.cleanup, 0);
});

test("bounded stale operation with clean transient workspace terminalizes before cleanup", async () => {
  const fixture = seeded();
  const workspace = workspacePort("CLEAN");
  let terminalSeenByCleanup = false;
  const originalCleanup = workspace.port.cleanup;
  workspace.port.cleanup = async (workspaceRef) => {
    terminalSeenByCleanup = fixture.state.operations.inspect(fixture.operation.operationId).liveness === "TERMINAL";
    return originalCleanup(workspaceRef);
  };
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("STALE_RECOVERABLE", "OWNER_MISMATCH_BOUNDED_STALE"),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-stale-clean",
  });

  assert.equal(result.ok, true);
  assert.equal(result.cleanup.status, "CLEANED");
  assert.equal(terminalSeenByCleanup, true);
  assert.equal(workspace.calls.cleanup, 1);
});

test("dirty stale workspace becomes STALE_DIRTY and is preserved", async () => {
  const fixture = seeded();
  const workspace = workspacePort("DIRTY");
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE"),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-stale-dirty",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "STALE_DIRTY");
  assert.equal(result.preserved, true);
  assert.equal(result.actionRequired, "RESOLVE_DIRTY_WORKSPACE");
  assert.equal(fixture.state.operations.inspect(fixture.operation.operationId).liveness, "LIVE");
  assert.equal(workspace.calls.cleanup, 0);
});

test("cross-project recovery fails closed before liveness or workspace mutation", async () => {
  const fixture = seeded();
  assert.equal(fixture.state.projects.register(project("prj-other")).ok, true);
  const workspace = workspacePort("CLEAN");
  let assessments = 0;
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: {
      async assess() {
        assessments += 1;
        throw new Error("must not assess cross-project operation");
      },
    },
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: "prj-other",
    operationId: fixture.operation.operationId,
    commandId: "recover-cross-project",
  });

  assert.deepEqual(result, { ok: false, reason: "OPERATION_PROJECT_MISMATCH" });
  assert.equal(assessments, 0);
  assert.equal(workspace.calls.inspect, 0);
  assert.equal(workspace.calls.cleanup, 0);
});

test("repeating recovery converges on the same terminal Operation", async () => {
  const fixture = seeded({ workspaceRef: null });
  const workspace = workspacePort("ABSENT");
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE"),
    workspaceRecovery: workspace.port,
  });

  const first = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-replay",
  });
  const second = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-replay",
  });

  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.operation.resultRef, first.operation.resultRef);
});

test("cleanup failure does not erase successful stale terminalization", async () => {
  const fixture = seeded();
  const workspace = workspacePort("CLEAN", { cleanupError: new Error("locked") });
  const reconciler = createReconciler({
    state: fixture.state,
    operationLiveness: assessment("STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE"),
    workspaceRecovery: workspace.port,
  });

  const result = await reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-cleanup-failure",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "RECOVERY_CLEANUP_FAILED");
  assert.equal(result.terminalized, true);
  assert.equal(fixture.state.operations.inspect(fixture.operation.operationId).liveness, "TERMINAL");
});
