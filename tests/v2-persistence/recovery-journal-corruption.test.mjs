import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { canonicalRecoveryJson, recoveryDigest } from "../../v2/reconciliation/recovery-journal.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-recovery-corrupt",
    lineageId: "lineage-recovery-corrupt",
    workspace: { canonicalRoot: "C:/Projects/RecoveryCorrupt", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-recovery-corrupt",
    projectId: "prj-recovery-corrupt",
    taskId: "task-recovery-corrupt",
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
    operationId: "op-recovery-corrupt",
    projectId: "prj-recovery-corrupt",
    workId: "work-recovery-corrupt",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:recovery-corrupt",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T10:00:00.000Z",
    heartbeatAt: "2026-10-17T10:00:00.000Z",
    deadlineAt: "2026-10-17T10:05:00.000Z",
    runtimeOwnerRef: "owner:recovery-corrupt",
    workspaceRef: null,
    resultRef: null,
  };
}

function recovery() {
  return {
    schema: "orchestra.operation-recovery.v2",
    projectId: "prj-recovery-corrupt",
    operationId: "op-recovery-corrupt",
    workId: "work-recovery-corrupt",
    generation: 0,
    commandId: "recover-corrupt-1",
    assessment: {
      liveness: "STALE_RECOVERABLE",
      reason: "OWNER_ABSENT_BOUNDED_STALE",
      observedAt: "2026-10-17T10:06:00.000Z",
    },
    workspace: { ref: null, status: "ABSENT" },
    terminal: {
      workflowState: "ABORTED",
      resultRef: "recovery:op-recovery-corrupt:OWNER_TERMINATED_WITHOUT_TERMINALIZATION",
    },
    cleanup: { status: "NOT_REQUIRED" },
    outcome: "RECOVERED",
    recordedAt: "2026-10-17T10:06:01.000Z",
  };
}

function seed(dbPath) {
  const state = createSqliteState({ dbPath });
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  assert.equal(state.recoveries.record(recovery()).ok, true);
  state.close();
}

function assertCorruption(fn) {
  assert.throws(fn, (error) => error?.code === "ORCHESTRA_V2_RECOVERY_CORRUPT");
}

test("SQLite Recovery Journal detects digest corruption on replay and latest reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-recovery-corruption-"));
  const dbPath = join(root, "orchestra.db");
  try {
    seed(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE operation_recovery_records SET record_json = ? WHERE command_id = ?")
      .run("{}", "recover-corrupt-1");
    db.close();

    const reopened = createSqliteState({ dbPath });
    assertCorruption(() => reopened.recoveries.byCommand({
      projectId: "prj-recovery-corrupt",
      commandId: "recover-corrupt-1",
    }));
    assertCorruption(() => reopened.recoveries.latest({
      projectId: "prj-recovery-corrupt",
      operationId: "op-recovery-corrupt",
    }));
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite Recovery Journal rejects internally rehashed records that contradict their indexed command identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-recovery-identity-corruption-"));
  const dbPath = join(root, "orchestra.db");
  try {
    seed(dbPath);
    const tampered = { ...recovery(), commandId: "different-command" };
    const encoded = canonicalRecoveryJson(tampered);
    const digest = recoveryDigest(tampered);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE operation_recovery_records SET record_json = ?, record_digest = ? WHERE command_id = ?")
      .run(encoded, digest, "recover-corrupt-1");
    db.close();

    const reopened = createSqliteState({ dbPath });
    assertCorruption(() => reopened.recoveries.byCommand({
      projectId: "prj-recovery-corrupt",
      commandId: "recover-corrupt-1",
    }));
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
