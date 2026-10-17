import test from "node:test";
import assert from "node:assert/strict";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

function seed() {
  const state = createReferenceState();
  const project = {
    schema: "orchestra.project.v2",
    projectId: "prj-recovery-race",
    lineageId: "lineage-recovery-race",
    workspace: { canonicalRoot: "C:/Projects/RecoveryRace", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
  const work = {
    schema: "orchestra.work-unit.v2",
    workId: "work-recovery-race",
    projectId: project.projectId,
    taskId: "task-recovery-race",
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
  const operation = {
    schema: "orchestra.operation.v2",
    operationId: "op-recovery-race",
    projectId: project.projectId,
    workId: work.workId,
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:worker",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T06:00:00.000Z",
    heartbeatAt: "2026-10-17T06:00:00.000Z",
    deadlineAt: "2026-10-17T06:05:00.000Z",
    runtimeOwnerRef: "owner:recovery-race",
    workspaceRef: "workspace:recovery-race",
    resultRef: null,
  };
  assert.equal(state.projects.register(project).ok, true);
  assert.equal(state.work.startCurrent(work).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation }).ok, true);
  return { state, project, operation };
}

function twoPartyBarrier() {
  let arrivals = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  return async function arrive() {
    arrivals += 1;
    if (arrivals === 2) release();
    await released;
  };
}

test("simultaneous stale recoveries use atomic terminalization as the cleanup fence", async () => {
  const fixture = seed();
  const livenessBarrier = twoPartyBarrier();
  const workspaceBarrier = twoPartyBarrier();
  let cleanupCalls = 0;
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });

  const reconciler = createOperationReconciler({
    state: fixture.state,
    operationLiveness: {
      async assess(operation) {
        await livenessBarrier();
        return {
          schema: "orchestra.liveness-assessment.v2",
          operationId: operation.operationId,
          observedAt: "2026-10-17T07:00:00.000Z",
          liveness: "STALE_RECOVERABLE",
          reason: "OWNER_ABSENT_BOUNDED_STALE",
          evidence: { ownerStatus: "ABSENT", heartbeatFresh: false, deadlineExpired: true },
        };
      },
    },
    workspaceRecovery: {
      async inspect(workspaceRef) {
        await workspaceBarrier();
        return { workspaceRef, status: "CLEAN" };
      },
      async cleanup(workspaceRef) {
        cleanupCalls += 1;
        await cleanupGate;
        return { workspaceRef, cleaned: true };
      },
    },
  });

  const firstPromise = reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-race-a",
  });
  const secondPromise = reconciler.recover({
    projectId: fixture.project.projectId,
    operationId: fixture.operation.operationId,
    commandId: "recover-race-b",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1, "only the terminalization winner may start cleanup");
  releaseCleanup();

  const results = await Promise.all([firstPromise, secondPromise]);
  const winner = results.find((result) => result.ok);
  const loser = results.find((result) => !result.ok);

  assert.equal(winner?.cleanup.status, "CLEANED");
  assert.equal(loser?.reason, "RECOVERY_RACE_LOST");
  assert.equal(loser?.retryable, true);
  assert.equal(loser?.terminalized, true);
  assert.equal(cleanupCalls, 1);

  const stored = fixture.state.operations.inspect(fixture.operation.operationId);
  assert.equal(stored.liveness, "TERMINAL");
  assert.equal(stored.workflowState, "ABORTED");

  const journals = ["recover-race-a", "recover-race-b"]
    .map((commandId) => fixture.state.recoveries.byCommand({
      projectId: fixture.project.projectId,
      commandId,
    }))
    .filter(Boolean);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].outcome, "RECOVERED");
});
