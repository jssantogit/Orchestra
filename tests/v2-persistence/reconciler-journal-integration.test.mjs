import test from "node:test";
import assert from "node:assert/strict";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-reconciler-journal",
    lineageId: "lineage-reconciler-journal",
    workspace: { canonicalRoot: "C:/Projects/ReconcilerJournal", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-reconciler-journal",
    projectId: "prj-reconciler-journal",
    taskId: "task-reconciler-journal",
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

function operation({ workspaceRef = "workspace:journal" } = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-reconciler-journal",
    projectId: "prj-reconciler-journal",
    workId: "work-reconciler-journal",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:worker",
    capabilities: workspaceRef === null ? [] : ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T06:00:00.000Z",
    heartbeatAt: "2026-10-17T06:00:00.000Z",
    deadlineAt: "2026-10-17T06:05:00.000Z",
    runtimeOwnerRef: "owner:journal",
    workspaceRef,
    resultRef: null,
  };
}

function seed(options = {}) {
  const state = createReferenceState();
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 0,
    operation: operation(options),
  }).ok, true);
  return state;
}

function staleAssessment(counter) {
  return {
    async assess(op) {
      counter.count += 1;
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: op.operationId,
        observedAt: "2026-10-17T07:00:00.000Z",
        liveness: "STALE_RECOVERABLE",
        reason: "OWNER_ABSENT_BOUNDED_STALE",
        evidence: { ownerStatus: "ABSENT", heartbeatFresh: false, deadlineExpired: true },
      };
    },
  };
}

function workspaceRecovery({ status = "CLEAN", failCleanupTimes = 0 } = {}) {
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
        if (calls.cleanup <= failCleanupTimes) throw new Error("cleanup failed");
        return { workspaceRef, cleaned: true };
      },
    },
  };
}

function recover(reconciler, commandId) {
  return reconciler.recover({
    projectId: "prj-reconciler-journal",
    operationId: "op-reconciler-journal",
    commandId,
  });
}

test("successful recovery is journaled and the same command replays without reassessment or repeated cleanup", async () => {
  const state = seed();
  const assessments = { count: 0 };
  const workspace = workspaceRecovery();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleAssessment(assessments),
    workspaceRecovery: workspace.port,
  });

  const first = await recover(reconciler, "recover-success");
  assert.equal(first.ok, true);
  assert.equal(first.cleanup.status, "CLEANED");

  const journal = state.recoveries.byCommand({
    projectId: "prj-reconciler-journal",
    commandId: "recover-success",
  });
  assert.equal(journal.outcome, "RECOVERED");
  assert.equal(journal.cleanup.status, "CLEANED");
  assert.equal(journal.assessment.liveness, "STALE_RECOVERABLE");

  const second = await recover(reconciler, "recover-success");
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.cleanup.status, "CLEANED");
  assert.equal(assessments.count, 1);
  assert.equal(workspace.calls.cleanup, 1);
});

test("dirty stale workspace is journaled as preserved and command replay does not reassess", async () => {
  const state = seed();
  const assessments = { count: 0 };
  const workspace = workspaceRecovery({ status: "DIRTY" });
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleAssessment(assessments),
    workspaceRecovery: workspace.port,
  });

  const first = await recover(reconciler, "recover-dirty");
  assert.equal(first.ok, false);
  assert.equal(first.reason, "STALE_DIRTY");

  const journal = state.recoveries.byCommand({
    projectId: "prj-reconciler-journal",
    commandId: "recover-dirty",
  });
  assert.equal(journal.outcome, "STALE_DIRTY");
  assert.equal(journal.cleanup.status, "PRESERVED");
  assert.equal(journal.terminal, null);

  const second = await recover(reconciler, "recover-dirty");
  assert.equal(second.reason, "STALE_DIRTY");
  assert.equal(second.replayed, true);
  assert.equal(assessments.count, 1);
  assert.equal(workspace.calls.inspect, 1);
});

test("cleanup failure is durable and a fresh recovery command retries cleanup without liveness reassessment", async () => {
  const state = seed();
  const assessments = { count: 0 };
  const workspace = workspaceRecovery({ failCleanupTimes: 1 });
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: staleAssessment(assessments),
    workspaceRecovery: workspace.port,
  });

  const failed = await recover(reconciler, "recover-cleanup-1");
  assert.equal(failed.reason, "RECOVERY_CLEANUP_FAILED");
  assert.equal(state.operations.inspect("op-reconciler-journal").liveness, "TERMINAL");
  assert.equal(state.recoveries.byCommand({
    projectId: "prj-reconciler-journal",
    commandId: "recover-cleanup-1",
  }).outcome, "CLEANUP_FAILED");

  const resumed = await recover(reconciler, "recover-cleanup-2");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.cleanup.status, "CLEANED");
  assert.equal(assessments.count, 1);
  assert.equal(workspace.calls.cleanup, 2);
  const resumedRecord = state.recoveries.byCommand({
    projectId: "prj-reconciler-journal",
    commandId: "recover-cleanup-2",
  });
  assert.equal(resumedRecord.outcome, "RECOVERED");
  assert.equal(resumedRecord.assessment.liveness, "TERMINAL");

  const replay = await recover(reconciler, "recover-cleanup-2");
  assert.equal(replay.replayed, true);
  assert.equal(workspace.calls.cleanup, 2);
});

test("recovery can finish cleanup after a crash that terminalized the Operation before journaling", async () => {
  const state = seed();
  const resultRef = "recovery:op-reconciler-journal:OWNER_TERMINATED_WITHOUT_TERMINALIZATION";
  assert.equal(state.operations.terminalize({
    operationId: "op-reconciler-journal",
    workflowState: "ABORTED",
    resultRef,
  }).ok, true);
  assert.equal(state.recoveries.latest({
    projectId: "prj-reconciler-journal",
    operationId: "op-reconciler-journal",
  }), null);

  const workspace = workspaceRecovery();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: {
      async assess() {
        throw new Error("terminal recovery resume must not probe liveness");
      },
    },
    workspaceRecovery: workspace.port,
  });

  const resumed = await recover(reconciler, "recover-after-crash");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.cleanup.status, "CLEANED");
  assert.equal(workspace.calls.cleanup, 1);
  const journal = state.recoveries.byCommand({
    projectId: "prj-reconciler-journal",
    commandId: "recover-after-crash",
  });
  assert.equal(journal.outcome, "RECOVERED");
  assert.equal(journal.assessment.liveness, "TERMINAL");
  assert.equal(journal.terminal.resultRef, resultRef);
});
