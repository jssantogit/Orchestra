import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createRecoveryAwareStatusReconciler } from "../../v2/reconciliation/recovery-aware-status.mjs";

const PROJECT_ID = "prj-sqlite-pending-recovery";
const WORK_ID = "work-sqlite-pending-recovery";
const OPERATION_ID = "op-sqlite-pending-recovery";
const WORKSPACE_REF = "workspace:sqlite-pending-recovery";
const RECOVERY_RESULT_REF = `recovery:${OPERATION_ID}:OWNER_TERMINATED_WITHOUT_TERMINALIZATION`;

function seed(state) {
  assert.equal(state.projects.register({
    schema: "orchestra.project.v2",
    projectId: PROJECT_ID,
    lineageId: "lineage-sqlite-pending-recovery",
    workspace: { canonicalRoot: "C:/Projects/SqlitePendingRecovery", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  }).ok, true);
  assert.equal(state.work.startCurrent({
    schema: "orchestra.work-unit.v2",
    workId: WORK_ID,
    projectId: PROJECT_ID,
    taskId: "task-sqlite-pending-recovery",
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
      actorRef: "actor:sqlite-pending-recovery",
      capabilities: ["WORKSPACE_EDIT"],
      workflowState: "RUNNING",
      liveness: "LIVE",
      startedAt: "2026-10-17T06:00:00.000Z",
      heartbeatAt: "2026-10-17T06:00:00.000Z",
      deadlineAt: "2026-10-17T06:05:00.000Z",
      runtimeOwnerRef: "owner:sqlite-pending-recovery",
      workspaceRef: WORKSPACE_REF,
      resultRef: null,
    },
  }).ok, true);
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
    async inspect(workspaceRef) { return { workspaceRef, status: "CLEAN" }; },
    async cleanup() {
      if (failCleanup) throw new Error("cleanup failed");
    },
  };
}

function statusReconciler(state) {
  const workspaceRecovery = workspacePort();
  const reconciler = createOperationReconciler({
    state,
    operationLiveness: {
      async assess() { throw new Error("terminal recovery status must not probe liveness"); },
    },
    workspaceRecovery,
  });
  return createRecoveryAwareStatusReconciler({
    state,
    reconciler,
    workspaceRecovery,
    now: () => "2026-10-17T07:30:00.000Z",
  });
}

async function withDatabase(run) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-pending-recovery-status-"));
  const dbPath = join(root, "state.db");
  try {
    await run(dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SQLite status preserves cleanup-failed recovery obligation across restart", async () => {
  await withDatabase(async (dbPath) => {
    let state = createSqliteState({ dbPath });
    seed(state);
    const recovery = createOperationReconciler({
      state,
      operationLiveness: staleService(),
      workspaceRecovery: workspacePort({ failCleanup: true }),
    });
    const failed = await recovery.recover({
      projectId: PROJECT_ID,
      operationId: OPERATION_ID,
      commandId: "sqlite-cleanup-failed",
    });
    assert.equal(failed.reason, "RECOVERY_CLEANUP_FAILED");
    state.close();

    state = createSqliteState({ dbPath });
    const status = await statusReconciler(state).inspect({ projectId: PROJECT_ID });
    assert.equal(status.operations.length, 1);
    const [pending] = status.operations;
    assert.equal(pending.operation.operationId, OPERATION_ID);
    assert.equal(pending.recovery.outcome, "CLEANUP_FAILED");
    assert.equal(pending.recoveryAvailable, true);
    assert.equal(pending.actionRequired, "RETRY_RECOVERY");
    state.close();
  });
});

test("SQLite status preserves terminalized-before-journal crash window across restart", async () => {
  await withDatabase(async (dbPath) => {
    let state = createSqliteState({ dbPath });
    seed(state);
    assert.equal(state.operations.terminalize({
      operationId: OPERATION_ID,
      workflowState: "ABORTED",
      resultRef: RECOVERY_RESULT_REF,
    }).ok, true);
    state.close();

    state = createSqliteState({ dbPath });
    const status = await statusReconciler(state).inspect({ projectId: PROJECT_ID });
    assert.equal(status.operations.length, 1);
    const [pending] = status.operations;
    assert.equal(pending.operation.operationId, OPERATION_ID);
    assert.equal(pending.recovery, null);
    assert.equal(pending.recoveryAvailable, true);
    assert.equal(pending.actionRequired, "RUN_RECOVERY");
    state.close();
  });
});
