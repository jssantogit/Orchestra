import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

const OLD_HEARTBEAT = "2026-10-17T10:00:00.000Z";
const NEW_HEARTBEAT = "2026-10-17T10:06:30.000Z";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-heartbeat-race",
    lineageId: "lineage-heartbeat-race",
    workspace: { canonicalRoot: "C:/Projects/HeartbeatRace", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-heartbeat-race",
    projectId: "prj-heartbeat-race",
    taskId: "task-heartbeat-race",
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
    operationId: "op-heartbeat-race",
    projectId: "prj-heartbeat-race",
    workId: "work-heartbeat-race",
    generation: 0,
    kind: "BACKGROUND_WATCH",
    actorRef: "actor:heartbeat-race",
    capabilities: [],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T09:59:00.000Z",
    heartbeatAt: OLD_HEARTBEAT,
    deadlineAt: "2026-10-17T10:10:00.000Z",
    runtimeOwnerRef: "owner:heartbeat-race",
    workspaceRef: null,
    resultRef: null,
  };
}

function seed(state) {
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  return state;
}

async function withStores(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-heartbeat-race-"));
  const cases = [
    ["reference", seed(createReferenceState()), null],
    ["sqlite", seed(createSqliteState({ dbPath: join(root, "state.db") })), true],
  ];
  try {
    for (const [name, state, close] of cases) {
      await fn(name, state);
      if (close) state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Operation terminalization heartbeat fence rejects a heartbeat that advanced after the observed snapshot", async () => {
  await withStores(async (name, state) => {
    const heartbeat = state.operations.heartbeat({
      operationId: "op-heartbeat-race",
      runtimeOwnerRef: "owner:heartbeat-race",
      heartbeatAt: NEW_HEARTBEAT,
    });
    assert.equal(heartbeat.ok, true, name);

    const terminal = state.operations.terminalize({
      operationId: "op-heartbeat-race",
      workflowState: "ABORTED",
      resultRef: "recovery:op-heartbeat-race:OWNER_TERMINATED_WITHOUT_TERMINALIZATION",
      expectedHeartbeatAt: OLD_HEARTBEAT,
    });
    assert.deepEqual(terminal, {
      ok: false,
      reason: "OPERATION_CHANGED",
      currentHeartbeatAt: NEW_HEARTBEAT,
    }, name);

    const current = state.operations.inspect("op-heartbeat-race");
    assert.equal(current.liveness, "LIVE", name);
    assert.equal(current.heartbeatAt, NEW_HEARTBEAT, name);
  });
});

test("Reconciler recovery loses the race instead of stealing an Operation whose heartbeat renewed during stale assessment", async () => {
  await withStores(async (name, state) => {
    let assessed = 0;
    const reconciler = createOperationReconciler({
      state,
      operationLiveness: {
        async assess(op) {
          assessed += 1;
          const stale = {
            schema: "orchestra.liveness-assessment.v2",
            operationId: op.operationId,
            observedAt: "2026-10-17T10:06:00.000Z",
            liveness: "STALE_RECOVERABLE",
            reason: "OWNER_ABSENT_BOUNDED_STALE",
            evidence: { ownerStatus: "ABSENT", heartbeatFresh: false, deadlineExpired: true },
          };
          const refreshed = state.operations.heartbeat({
            operationId: op.operationId,
            runtimeOwnerRef: op.runtimeOwnerRef,
            heartbeatAt: NEW_HEARTBEAT,
          });
          assert.equal(refreshed.ok, true, name);
          return stale;
        },
      },
      workspaceRecovery: {
        async inspect(ref) { return { workspaceRef: ref, status: "ABSENT" }; },
        async cleanup() { throw new Error("absent workspace must not be cleaned"); },
      },
    });

    const result = await reconciler.recover({
      projectId: "prj-heartbeat-race",
      operationId: "op-heartbeat-race",
      commandId: `recover-heartbeat-race-${name}`,
    });

    assert.equal(assessed, 1, name);
    assert.deepEqual(result, {
      ok: false,
      reason: "RECOVERY_RACE_LOST",
      operationId: "op-heartbeat-race",
      terminalized: false,
      retryable: true,
    }, name);
    const current = state.operations.inspect("op-heartbeat-race");
    assert.equal(current.liveness, "LIVE", name);
    assert.equal(current.heartbeatAt, NEW_HEARTBEAT, name);
    assert.equal(state.recoveries.byCommand({
      projectId: "prj-heartbeat-race",
      commandId: `recover-heartbeat-race-${name}`,
    }), null, name);
  });
});
