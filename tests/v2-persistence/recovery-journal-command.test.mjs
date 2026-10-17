import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

const RECOVERY_RESULT_REF = "recovery:op-command-journal:OWNER_TERMINATED_WITHOUT_TERMINALIZATION";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-command-journal",
    lineageId: "lineage-command-journal",
    workspace: { canonicalRoot: "C:/Projects/CommandJournal", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-command-journal",
    projectId: "prj-command-journal",
    taskId: "task-command-journal",
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
    operationId: "op-command-journal",
    projectId: "prj-command-journal",
    workId: "work-command-journal",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:worker",
    capabilities: [],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T06:00:00.000Z",
    heartbeatAt: null,
    deadlineAt: "2026-10-17T06:05:00.000Z",
    runtimeOwnerRef: null,
    workspaceRef: null,
    resultRef: null,
  };
}

function recovery() {
  return {
    schema: "orchestra.operation-recovery.v2",
    projectId: "prj-command-journal",
    operationId: "op-command-journal",
    workId: "work-command-journal",
    generation: 0,
    commandId: "recover-command-1",
    assessment: {
      liveness: "STALE_RECOVERABLE",
      reason: "OWNER_ABSENT_BOUNDED_STALE",
      observedAt: "2026-10-17T07:00:00.000Z",
    },
    workspace: { ref: null, status: "ABSENT" },
    terminal: {
      workflowState: "ABORTED",
      resultRef: RECOVERY_RESULT_REF,
    },
    cleanup: { status: "NOT_REQUIRED" },
    outcome: "RECOVERED",
    recordedAt: "2026-10-17T07:00:01.000Z",
  };
}

function seed(state) {
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  const terminal = state.operations.terminalize({
    operationId: "op-command-journal",
    workflowState: "ABORTED",
    resultRef: RECOVERY_RESULT_REF,
  });
  assert.equal(terminal.ok, true);
  return state;
}

function exerciseCommandLookup(state) {
  assert.equal(typeof state.recoveries.byCommand, "function");
  assert.equal(state.recoveries.byCommand({
    projectId: "prj-command-journal",
    commandId: "missing",
  }), null);

  assert.equal(state.recoveries.record(recovery()).ok, true);
  assert.deepEqual(state.recoveries.byCommand({
    projectId: "prj-command-journal",
    commandId: "recover-command-1",
  }), recovery());
}

test("reference Recovery Journal can replay a recovery command by factual project namespace", () => {
  exerciseCommandLookup(seed(createReferenceState()));
});

test("SQLite Recovery Journal command lookup survives process-style restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-recovery-command-"));
  const dbPath = join(root, "orchestra.db");
  try {
    const first = seed(createSqliteState({ dbPath }));
    exerciseCommandLookup(first);
    first.close();

    const reopened = createSqliteState({ dbPath });
    assert.deepEqual(reopened.recoveries.byCommand({
      projectId: "prj-command-journal",
      commandId: "recover-command-1",
    }), recovery());
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
