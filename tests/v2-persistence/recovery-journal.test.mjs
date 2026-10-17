import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

const RECOVERY_RESULT_REF = "recovery:op-recovery-journal:OWNER_TERMINATED_WITHOUT_TERMINALIZATION";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-recovery-journal",
    lineageId: "lineage-recovery-journal",
    workspace: { canonicalRoot: "C:/Projects/RecoveryJournal", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-recovery-journal",
    projectId: "prj-recovery-journal",
    taskId: "task-recovery-journal",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 7,
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
    operationId: "op-recovery-journal",
    projectId: "prj-recovery-journal",
    workId: "work-recovery-journal",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:worker",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T06:00:00.000Z",
    heartbeatAt: "2026-10-17T06:00:00.000Z",
    deadlineAt: "2026-10-17T06:05:00.000Z",
    runtimeOwnerRef: "owner:recovery-journal",
    workspaceRef: "workspace:recovery-journal",
    resultRef: null,
  };
}

function record({
  commandId = "recover-1",
  outcome = "RECOVERED",
  workspaceStatus = "CLEAN",
  cleanupStatus = "CLEANED",
  resultRef = RECOVERY_RESULT_REF,
  recordedAt = "2026-10-17T07:00:00.000Z",
} = {}) {
  return {
    schema: "orchestra.operation-recovery.v2",
    projectId: "prj-recovery-journal",
    operationId: "op-recovery-journal",
    workId: "work-recovery-journal",
    generation: 0,
    commandId,
    assessment: {
      liveness: "STALE_RECOVERABLE",
      reason: "OWNER_ABSENT_BOUNDED_STALE",
      observedAt: "2026-10-17T06:59:59.000Z",
    },
    workspace: {
      ref: "workspace:recovery-journal",
      status: workspaceStatus,
    },
    terminal: resultRef === null ? null : {
      workflowState: "ABORTED",
      resultRef,
    },
    cleanup: { status: cleanupStatus },
    outcome,
    recordedAt,
  };
}

function seed(state) {
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  return state;
}

function terminalizeForRecovery(state) {
  const terminal = state.operations.terminalize({
    operationId: "op-recovery-journal",
    workflowState: "ABORTED",
    resultRef: RECOVERY_RESULT_REF,
  });
  assert.equal(terminal.ok, true);
  return state;
}

function assertJournalContract(state) {
  assert.equal(typeof state.recoveries?.record, "function");
  assert.equal(typeof state.recoveries?.latest, "function");

  const firstRecord = record();
  const first = state.recoveries.record(firstRecord);
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.recovery, firstRecord);
  assert.deepEqual(state.recoveries.latest({
    projectId: firstRecord.projectId,
    operationId: firstRecord.operationId,
  }), firstRecord);

  const replay = state.recoveries.record(firstRecord);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.recovery, firstRecord);

  const conflict = state.recoveries.record(record({
    commandId: firstRecord.commandId,
    outcome: "CLEANUP_FAILED",
    cleanupStatus: "FAILED",
  }));
  assert.deepEqual(conflict, { ok: false, reason: "IDEMPOTENCY_CONFLICT" });

  const secondRecord = record({
    commandId: "recover-2",
    outcome: "CLEANUP_FAILED",
    cleanupStatus: "FAILED",
    recordedAt: "2026-10-17T07:01:00.000Z",
  });
  const second = state.recoveries.record(secondRecord);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, false);
  assert.deepEqual(state.recoveries.latest({
    projectId: secondRecord.projectId,
    operationId: secondRecord.operationId,
  }), secondRecord);
}

test("Recovery Journal rejects a terminal fact while the Operation is still live", () => {
  const state = seed(createReferenceState());
  assert.deepEqual(state.recoveries.record(record()), {
    ok: false,
    reason: "RECOVERY_TERMINAL_STATE_MISMATCH",
  });
});

test("reference Recovery Journal is durable-contract compatible and idempotent", () => {
  const state = terminalizeForRecovery(seed(createReferenceState()));
  assertJournalContract(state);
});

test("SQLite Recovery Journal survives close/reopen and preserves latest factual outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-recovery-journal-"));
  const dbPath = join(root, "orchestra.db");
  try {
    const first = terminalizeForRecovery(seed(createSqliteState({ dbPath })));
    assertJournalContract(first);
    first.close();

    const reopened = createSqliteState({ dbPath });
    const latest = reopened.recoveries.latest({
      projectId: "prj-recovery-journal",
      operationId: "op-recovery-journal",
    });
    assert.equal(latest.outcome, "CLEANUP_FAILED");
    assert.equal(latest.cleanup.status, "FAILED");
    assert.equal(latest.commandId, "recover-2");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recovery Journal rejects cross-project and mismatched operation identity", () => {
  const state = terminalizeForRecovery(seed(createReferenceState()));
  assert.equal(state.projects.register({
    ...project(),
    projectId: "prj-other",
    lineageId: "lineage-other",
    workspace: { canonicalRoot: "C:/Projects/Other", vcs: "git" },
  }).ok, true);

  const crossProject = state.recoveries.record({
    ...record(),
    projectId: "prj-other",
  });
  assert.deepEqual(crossProject, { ok: false, reason: "OPERATION_PROJECT_MISMATCH" });

  const wrongWork = state.recoveries.record({
    ...record({ commandId: "recover-wrong-work" }),
    workId: "work-other",
  });
  assert.deepEqual(wrongWork, { ok: false, reason: "RECOVERY_OPERATION_MISMATCH" });
});

test("Recovery Journal contract rejects undeclared/raw project content fields", async () => {
  const module = await import("../../v2/reconciliation/contracts.mjs").catch(() => null);
  assert.equal(typeof module?.validateOperationRecoveryV2, "function");

  const valid = record();
  assert.equal(module.validateOperationRecoveryV2(valid).valid, true);
  assert.equal(module.validateOperationRecoveryV2({ ...valid, sourceCode: "private bytes" }).valid, false);
  assert.equal(module.validateOperationRecoveryV2({
    ...valid,
    assessment: { ...valid.assessment, rawSessionId: "secret" },
  }).valid, false);
});
