import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project(overrides = {}) {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-work",
    lineageId: "lineage-work",
    workspace: { canonicalRoot: "C:/Projects/Work", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
    ...overrides,
  };
}

function work(overrides = {}) {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-a",
    projectId: "prj-work",
    taskId: "task-a",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
    ...overrides,
  };
}

function operation(overrides = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-a",
    projectId: "prj-work",
    workId: "work-a",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:one",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-16T22:00:00.000Z",
    heartbeatAt: "2026-10-16T22:00:00.000Z",
    deadlineAt: "2026-10-16T22:10:00.000Z",
    runtimeOwnerRef: "process:100:token-a",
    workspaceRef: "workspace:canonical",
    resultRef: null,
    ...overrides,
  };
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-work-sqlite-"));
  const dbPath = join(root, "orchestra.db");
  try {
    await fn({ root, dbPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function seed(state) {
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.open(work()).ok, true);
}

function runTransitionWorker({ dbPath, signal, command }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./helpers/sqlite-transition-worker.mjs", import.meta.url), {
      workerData: { dbPath, signal, command },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`transition worker exited ${code}`));
    });
  });
}

test("Work Unit survives close/reopen and open replay returns current durable state", async () => {
  await withDb(async ({ dbPath }) => {
    const first = createSqliteState({ dbPath });
    seed(first);
    assert.equal(first.work.transition({
      projectId: "prj-work",
      workId: "work-a",
      expectedGeneration: 0,
      transitionId: "tr-1",
      patch: { state: "PLANNED", scopeRef: "scope:a" },
    }).ok, true);
    first.close();

    const reopened = createSqliteState({ dbPath });
    const current = reopened.work.read("prj-work", "work-a");
    const replay = reopened.work.open(work());

    assert.equal(current.generation, 1);
    assert.equal(current.state, "PLANNED");
    assert.equal(current.scopeRef, "scope:a");
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.work.generation, 1);
    reopened.close();
  });
});

test("Work transition idempotency survives restart and conflicting reuse fails closed", async () => {
  await withDb(async ({ dbPath }) => {
    const command = {
      projectId: "prj-work",
      workId: "work-a",
      expectedGeneration: 0,
      transitionId: "tr-stable",
      patch: { state: "PLANNED" },
    };
    const first = createSqliteState({ dbPath });
    seed(first);
    assert.equal(first.work.transition(command).work.generation, 1);
    first.close();

    const reopened = createSqliteState({ dbPath });
    const replay = reopened.work.transition(command);
    const conflict = reopened.work.transition({ ...command, patch: { state: "BLOCKED" } });

    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.work.generation, 1);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "IDEMPOTENCY_CONFLICT");
    assert.equal(reopened.work.read("prj-work", "work-a").state, "PLANNED");
    reopened.close();
  });
});

test("two SQLite connections competing on one generation produce exactly one winner", async () => {
  await withDb(async ({ dbPath }) => {
    const initial = createSqliteState({ dbPath });
    seed(initial);
    initial.close();

    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(shared);
    const commandA = {
      projectId: "prj-work",
      workId: "work-a",
      expectedGeneration: 0,
      transitionId: "race-a",
      patch: { state: "PLANNED", directionRef: "direction:a" },
    };
    const commandB = {
      projectId: "prj-work",
      workId: "work-a",
      expectedGeneration: 0,
      transitionId: "race-b",
      patch: { state: "PLANNED", directionRef: "direction:b" },
    };

    const a = runTransitionWorker({ dbPath, signal: shared, command: commandA });
    const b = runTransitionWorker({ dbPath, signal: shared, command: commandB });

    while (Atomics.load(signal, 0) < 2) Atomics.wait(signal, 0, Atomics.load(signal, 0), 100);
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1, 2);

    const results = await Promise.all([a, b]);
    assert.equal(results.filter((entry) => entry.ok).length, 1);
    assert.equal(results.filter((entry) => entry.reason === "STALE_GENERATION").length, 1);

    const final = createSqliteState({ dbPath });
    assert.equal(final.work.read("prj-work", "work-a").generation, 1);
    final.close();
  });
});

test("Work Unit is project-scoped and cannot be mutated through another project namespace", async () => {
  await withDb(async ({ dbPath }) => {
    const state = createSqliteState({ dbPath });
    seed(state);
    state.projects.register(project({
      projectId: "prj-b",
      lineageId: "lineage-b",
      workspace: { canonicalRoot: "C:/Projects/B", vcs: "git" },
    }));

    assert.equal(state.work.read("prj-b", "work-a"), null);
    const result = state.work.transition({
      projectId: "prj-b",
      workId: "work-a",
      expectedGeneration: 0,
      transitionId: "cross-project",
      patch: { state: "PLANNED" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "WORK_PROJECT_MISMATCH");
    assert.equal(state.work.read("prj-work", "work-a").state, "INTAKE");
    state.close();
  });
});

test("Operation survives restart; begin replay after heartbeat returns current durable state", async () => {
  await withDb(async ({ dbPath }) => {
    const request = operation();
    const first = createSqliteState({ dbPath });
    seed(first);
    assert.equal(first.operations.begin({ expectedGeneration: 0, operation: request }).ok, true);
    assert.equal(first.operations.heartbeat({
      operationId: "op-a",
      runtimeOwnerRef: "process:100:token-a",
      heartbeatAt: "2026-10-16T22:01:00.000Z",
    }).ok, true);
    first.close();

    const reopened = createSqliteState({ dbPath });
    const replay = reopened.operations.begin({ expectedGeneration: 0, operation: request });

    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation.heartbeatAt, "2026-10-16T22:01:00.000Z");
    reopened.close();
  });
});

test("Operation begin enforces generation, LIVE start and factual mutation workspace", async () => {
  await withDb(async ({ dbPath }) => {
    const state = createSqliteState({ dbPath });
    seed(state);

    assert.equal(state.operations.begin({ expectedGeneration: 1, operation: operation() }).reason, "STALE_GENERATION");
    assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation({ liveness: "UNKNOWN" }) }).reason, "OPERATION_BEGIN_NOT_LIVE");
    assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation({ workspaceRef: null }) }).reason, "MUTATION_WORKSPACE_REQUIRED");
    assert.equal(state.operations.inspect("op-a"), null);
    state.close();
  });
});

test("live mutation exclusivity is durable per workspace while separate clones remain parallel", async () => {
  await withDb(async ({ dbPath }) => {
    const state = createSqliteState({ dbPath });
    seed(state);
    assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);

    const same = state.operations.begin({
      expectedGeneration: 0,
      operation: operation({ operationId: "op-b", actorRef: "actor:two" }),
    });
    const separate = state.operations.begin({
      expectedGeneration: 0,
      operation: operation({
        operationId: "op-c",
        actorRef: "actor:three",
        workspaceRef: "workspace:clone-c",
        runtimeOwnerRef: "process:300:token-c",
      }),
    });

    assert.equal(same.ok, false);
    assert.equal(same.reason, "INCOMPATIBLE_LIVE_OPERATION");
    assert.equal(separate.ok, true);
    state.close();

    const reopened = createSqliteState({ dbPath });
    assert.equal(reopened.operations.listLive({ projectId: "prj-work", workId: "work-a", generation: 0 }).length, 2);
    reopened.close();
  });
});

test("heartbeat owner proof and monotonicity survive restart", async () => {
  await withDb(async ({ dbPath }) => {
    const first = createSqliteState({ dbPath });
    seed(first);
    first.operations.begin({ expectedGeneration: 0, operation: operation() });
    assert.equal(first.operations.heartbeat({
      operationId: "op-a",
      runtimeOwnerRef: "process:100:token-a",
      heartbeatAt: "2026-10-16T22:02:00.000Z",
    }).ok, true);
    first.close();

    const reopened = createSqliteState({ dbPath });
    assert.equal(reopened.operations.heartbeat({
      operationId: "op-a",
      runtimeOwnerRef: "process:999:wrong",
      heartbeatAt: "2026-10-16T22:03:00.000Z",
    }).reason, "OWNER_PROOF_MISMATCH");
    assert.equal(reopened.operations.heartbeat({
      operationId: "op-a",
      runtimeOwnerRef: "process:100:token-a",
      heartbeatAt: "2026-10-16T22:01:00.000Z",
    }).reason, "STALE_HEARTBEAT");
    reopened.close();
  });
});

test("terminal Operation remains terminal after restart and conflicting rewrite fails closed", async () => {
  await withDb(async ({ dbPath }) => {
    const first = createSqliteState({ dbPath });
    seed(first);
    first.operations.begin({ expectedGeneration: 0, operation: operation() });
    assert.equal(first.operations.terminalize({
      operationId: "op-a",
      workflowState: "COMPLETED",
      resultRef: "result:one",
    }).ok, true);
    first.close();

    const reopened = createSqliteState({ dbPath });
    const current = reopened.operations.inspect("op-a");
    const replay = reopened.operations.terminalize({
      operationId: "op-a",
      workflowState: "COMPLETED",
      resultRef: "result:one",
    });
    const conflict = reopened.operations.terminalize({
      operationId: "op-a",
      workflowState: "FAILED",
      resultRef: "result:two",
    });

    assert.equal(current.liveness, "TERMINAL");
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "TERMINAL_RESULT_CONFLICT");
    assert.equal(reopened.operations.listLive({ projectId: "prj-work" }).length, 0);
    reopened.close();
  });
});
