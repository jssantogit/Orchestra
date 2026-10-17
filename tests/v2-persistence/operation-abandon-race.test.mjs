import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-race",
    lineageId: "lineage-race",
    workspace: { canonicalRoot: "C:/Projects/Race", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-race",
    projectId: "prj-race",
    taskId: "task-race",
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
    operationId: "op-race",
    projectId: "prj-race",
    workId: "work-race",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:race",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T00:30:00.000Z",
    heartbeatAt: "2026-10-17T00:30:00.000Z",
    deadlineAt: "2026-10-17T00:40:00.000Z",
    runtimeOwnerRef: "process:race:token",
    workspaceRef: "workspace:canonical",
    resultRef: null,
  };
}

function runWorker({ dbPath, signal, action, command }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./helpers/sqlite-operation-abandon-worker.mjs", import.meta.url), {
      workerData: { dbPath, signal, action, command },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`${action} worker exited ${code}`));
    });
  });
}

test("sqlite: operation begin racing abandon cannot create a live writer on abandoned generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-operation-abandon-race-"));
  const dbPath = join(root, "state.db");
  try {
    const initial = createSqliteState({ dbPath });
    assert.equal(initial.projects.register(project()).ok, true);
    assert.equal(initial.work.startCurrent(work()).ok, true);
    initial.close();

    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(shared);
    const begin = runWorker({
      dbPath,
      signal: shared,
      action: "begin",
      command: { expectedGeneration: 0, operation: operation() },
    });
    const abandon = runWorker({
      dbPath,
      signal: shared,
      action: "abandon",
      command: {
        projectId: "prj-race",
        expectedWorkId: "work-race",
        expectedGeneration: 0,
        commandId: "abandon-race",
        reason: "switch task",
      },
    });

    while (Atomics.load(signal, 0) < 2) Atomics.wait(signal, 0, Atomics.load(signal, 0), 100);
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1, 2);

    const messages = await Promise.all([begin, abandon]);
    const beginResult = messages.find((entry) => entry.action === "begin").result;
    const abandonResult = messages.find((entry) => entry.action === "abandon").result;

    const state = createSqliteState({ dbPath });
    try {
      if (beginResult.ok) {
        assert.equal(abandonResult.ok, false);
        assert.equal(abandonResult.reason, "LIVE_OPERATION_EXISTS");
        assert.equal(state.work.current("prj-race").workId, "work-race");
        assert.equal(state.work.read("prj-race", "work-race").generation, 0);
        assert.equal(state.operations.listLive({ projectId: "prj-race", workId: "work-race", generation: 0 }).length, 1);
      } else {
        assert.ok(
          ["NO_ACTIVE_WORK", "STALE_GENERATION"].includes(beginResult.reason),
          `unexpected begin race result: ${beginResult.reason}`,
        );
        assert.equal(abandonResult.ok, true);
        assert.equal(state.work.current("prj-race"), null);
        assert.equal(state.work.read("prj-race", "work-race").generation, 1);
        assert.equal(state.operations.listLive({ projectId: "prj-race" }).length, 0);
      }
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
