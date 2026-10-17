import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

const actorA = `sha256:${"a".repeat(64)}`;
const actorB = `sha256:${"b".repeat(64)}`;
const correlationA = `sha256:${"c".repeat(64)}`;

function project(projectId = "prj-a", canonicalRoot = "C:/Projects/A") {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function work(workId, projectId) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId: `task-${workId}`,
    generation: 3,
    runtimeImage: "2.0.0",
    instructionEpoch: 7,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation(operationId, workId, projectId) {
  return {
    schema: "orchestra.operation.v2",
    operationId,
    projectId,
    workId,
    generation: 3,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:provider-test",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T10:00:00.000Z",
    heartbeatAt: "2026-10-17T10:00:00.000Z",
    deadlineAt: "2026-10-17T10:10:00.000Z",
    runtimeOwnerRef: "provider-owner:test",
    workspaceRef: `workspace:${projectId}`,
    resultRef: null,
  };
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-codex-adapter-"));
  const dbPath = join(root, "orchestra.db");
  const states = [];
  const openState = () => {
    const state = createSqliteState({ dbPath });
    states.push(state);
    return state;
  };
  try {
    await fn({ dbPath, openState });
  } finally {
    for (const state of states) state.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seed(state) {
  for (const item of [project(), project("prj-b", "C:/Projects/B")]) {
    assert.equal(state.projects.register(item).ok, true);
  }
  assert.equal(state.work.startCurrent(work("work-a", "prj-a")).ok, true);
  assert.equal(state.work.startCurrent(work("work-b", "prj-b")).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 3,
    operation: operation("op-a", "work-a", "prj-a"),
  }).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 3,
    operation: operation("op-b", "work-b", "prj-b"),
  }).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 3,
    operation: { ...operation("op-a-alt", "work-a", "prj-a"), workspaceRef: "workspace:clone-a" },
  }).ok, true);
}

test("Session Observations are provider/project/actor scoped, refreshable and project fenced", async () => {
  await withDb(async ({ openState }) => {
    const state = openState();
    seed(state);

    const observation = {
      provider: "codex",
      projectId: "prj-a",
      actorIdHash: actorA,
      observedInstructionEpoch: 7,
      observedWorkId: "work-a",
      observedGeneration: 3,
      observedAt: "2026-10-17T10:00:00.000Z",
    };
    const first = state.sessionObservations.put(observation);
    const replay = state.sessionObservations.put(observation);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(state.sessionObservations.get({
      provider: "codex", projectId: "prj-a", actorIdHash: actorA,
    }), observation);

    const otherActor = state.sessionObservations.put({ ...observation, actorIdHash: actorB });
    const otherProject = state.sessionObservations.put({ ...observation, projectId: "prj-b", observedWorkId: null, observedGeneration: null });
    const otherProvider = state.sessionObservations.put({ ...observation, provider: "antigravity" });
    assert.equal(otherActor.ok, true);
    assert.equal(otherProject.ok, true);
    assert.equal(otherProvider.ok, true);
    assert.equal(state.sessionObservations.get({ provider: "codex", projectId: "prj-a", actorIdHash: actorB }).observedWorkId, "work-a");
    assert.equal(state.sessionObservations.get({ provider: "codex", projectId: "prj-b", actorIdHash: actorA }).observedWorkId, null);
    assert.equal(state.sessionObservations.get({ provider: "antigravity", projectId: "prj-a", actorIdHash: actorA }).observedWorkId, "work-a");

    const crossProject = state.sessionObservations.put({
      ...observation,
      actorIdHash: `sha256:${"d".repeat(64)}`,
      observedWorkId: "work-b",
    });
    assert.equal(crossProject.ok, false);
    assert.equal(crossProject.reason, "SESSION_OBSERVATION_WORK_PROJECT_MISMATCH");

    const refreshed = state.sessionObservations.put({
      ...observation,
      observedInstructionEpoch: 8,
      observedAt: "2026-10-17T10:01:00.000Z",
    });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.replayed, false);
    assert.equal(state.sessionObservations.get({ provider: "codex", projectId: "prj-a", actorIdHash: actorA }).observedInstructionEpoch, 8);
    const stale = state.sessionObservations.put({
      ...observation,
      observedInstructionEpoch: 9,
      observedAt: "2026-10-17T10:00:30.000Z",
    });
    const sameTimestampConflict = state.sessionObservations.put({
      ...observation,
      observedInstructionEpoch: 9,
      observedAt: "2026-10-17T10:01:00.000Z",
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "SESSION_OBSERVATION_CONFLICT");
    assert.equal(sameTimestampConflict.ok, false);
    assert.equal(sameTimestampConflict.reason, "SESSION_OBSERVATION_CONFLICT");
    state.close();

    const reopened = openState();
    assert.equal(reopened.sessionObservations.get({ provider: "codex", projectId: "prj-a", actorIdHash: actorA }).observedInstructionEpoch, 8);
    assert.equal(reopened.sessionObservations.get({ provider: "antigravity", projectId: "prj-a", actorIdHash: actorA }).observedInstructionEpoch, 7);
    reopened.close();
  });
});

test("tool correlations bind one exact operation tuple and survive restart", async () => {
  await withDb(async ({ dbPath, openState }) => {
    const state = openState();
    seed(state);
    const correlation = {
      provider: "codex",
      projectId: "prj-a",
      correlationHash: correlationA,
      operationId: "op-a",
      workId: "work-a",
      generation: 3,
      actorIdHash: actorA,
    };

    const first = state.operationCorrelations.put(correlation);
    const replay = state.operationCorrelations.put(correlation);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(state.operationCorrelations.get({
      provider: "codex", projectId: "prj-a", correlationHash: correlationA,
    }), correlation);

    const conflict = state.operationCorrelations.put({ ...correlation, operationId: "op-a-alt" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "OPERATION_CORRELATION_CONFLICT");

    const differentWork = state.operationCorrelations.put({ ...correlation, workId: "work-b", projectId: "prj-b" });
    const differentGeneration = state.operationCorrelations.put({ ...correlation, generation: 4 });
    const differentActor = state.operationCorrelations.put({ ...correlation, actorIdHash: actorB });
    const crossProjectOperation = state.operationCorrelations.put({ ...correlation, operationId: "op-b" });
    assert.equal(differentWork.ok, false);
    assert.equal(differentWork.reason, "OPERATION_CORRELATION_OPERATION_MISMATCH");
    assert.equal(differentGeneration.ok, false);
    assert.equal(differentGeneration.reason, "OPERATION_CORRELATION_OPERATION_MISMATCH");
    assert.equal(differentActor.ok, false);
    assert.equal(differentActor.reason, "OPERATION_CORRELATION_CONFLICT");
    assert.equal(crossProjectOperation.ok, false);
    assert.equal(crossProjectOperation.reason, "OPERATION_CORRELATION_OPERATION_MISMATCH");

    const otherProject = state.operationCorrelations.put({
      ...correlation,
      projectId: "prj-b",
      operationId: "op-b",
      workId: "work-b",
    });
    const otherProvider = state.operationCorrelations.put({ ...correlation, provider: "antigravity" });
    assert.equal(otherProject.ok, true);
    assert.equal(otherProvider.ok, true);
    assert.equal(state.operationCorrelations.get({ provider: "codex", projectId: "prj-b", correlationHash: correlationA }).operationId, "op-b");
    assert.equal(state.operationCorrelations.get({ provider: "antigravity", projectId: "prj-a", correlationHash: correlationA }).operationId, "op-a");

    state.close();
    const reopened = openState();
    assert.deepEqual(reopened.operationCorrelations.get({
      provider: "codex", projectId: "prj-a", correlationHash: correlationA,
    }), correlation);
    reopened.close();
  });
});

test("concurrent identical provider correlations converge across SQLite connections", async () => {
  await withDb(async ({ dbPath, openState }) => {
    const state = openState();
    seed(state);
    state.close();

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { createSqliteState } = await import(workerData.moduleUrl);
        const state = createSqliteState({ dbPath: workerData.dbPath });
        parentPort.postMessage({ ready: true });
        const gate = new Int32Array(workerData.gate);
        while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0, 10000);
        const failures = [];
        for (let index = 0; index < workerData.count; index += 1) {
          const correlationHash = "sha256:" + String(index).padStart(64, "0");
          try {
            const result = state.operationCorrelations.put({ ...workerData.correlation, correlationHash });
            if (!result.ok) failures.push(result.reason);
          } catch (error) {
            failures.push(error.code ?? error.message);
          }
        }
        state.close();
        parentPort.postMessage({ done: true, failures });
      })().catch((error) => parentPort.postMessage({ fatal: error.message }));
    `;
    const workerCount = 8;
    const workers = [];
    try {
      const jobs = Array.from({ length: workerCount }, () => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: {
            dbPath,
            moduleUrl: new URL("../../v2/persistence/sqlite/sqlite-state.mjs", import.meta.url).href,
            gate,
            count: 64,
            correlation: {
              provider: "codex",
              projectId: "prj-a",
              operationId: "op-a",
              workId: "work-a",
              generation: 3,
              actorIdHash: actorA,
            },
          },
        });
        workers.push(worker);
        let resolveReady;
        let rejectReady;
        let resolveDone;
        let rejectDone;
        const ready = new Promise((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const done = new Promise((resolve, reject) => {
          resolveDone = resolve;
          rejectDone = reject;
        });
        let readySettled = false;
        let doneSettled = false;
        const rejectBoth = (error) => {
          if (!readySettled) {
            readySettled = true;
            rejectReady(error);
          }
          if (!doneSettled) {
            doneSettled = true;
            rejectDone(error);
          }
        };
        worker.on("message", (message) => {
          if (message.ready && !readySettled) {
            readySettled = true;
            resolveReady();
          }
          if (message.fatal) rejectBoth(new Error(message.fatal));
          if (message.done && !doneSettled) {
            doneSettled = true;
            resolveDone(message.failures);
          }
        });
        worker.on("error", rejectBoth);
        worker.on("exit", (code) => {
          if (code !== 0) rejectBoth(new Error(`worker exited with code ${code}`));
          else if (!doneSettled) rejectBoth(new Error("worker exited before reporting completion"));
        });
        return { ready, done };
      });

      let timeout;
      try {
        await Promise.race([
          Promise.all(jobs.map((job) => job.ready)),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("concurrent correlation workers timed out")), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, workerCount);

      let doneTimeout;
      let failures;
      try {
        failures = await Promise.race([
          Promise.all(jobs.map((job) => job.done)),
          new Promise((_, reject) => {
            doneTimeout = setTimeout(() => reject(new Error("concurrent correlation workers timed out")), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(doneTimeout);
      }
      assert.deepEqual(failures.flat(), []);
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, workerCount);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
});
