import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project(projectId = "prj-a", root = "C:/Projects/A") {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot: root, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work({ workId = "work-a", projectId = "prj-a", taskId = "task-a" } = {}) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId,
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
  };
}

async function createSqliteFixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-work-head-"));
  const dbPath = join(root, "state.db");
  const state = createSqliteState({ dbPath });
  return {
    state,
    dbPath,
    async cleanup() {
      state.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runStartWorker({ dbPath, signal, workUnit }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./helpers/sqlite-start-current-worker.mjs", import.meta.url), {
      workerData: { dbPath, signal, workUnit },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`start-current worker exited ${code}`));
    });
  });
}

const stores = [
  {
    name: "reference",
    async create() {
      return { state: createReferenceState(), cleanup: async () => {} };
    },
  },
  { name: "sqlite", create: createSqliteFixture },
];

for (const store of stores) {
  test(`${store.name}: startCurrent creates one explicit Project work head`, async () => {
    const fixture = await store.create();
    const { state } = fixture;
    try {
      state.projects.register(project());
      assert.equal(state.work.current("prj-a"), null);

      const started = state.work.startCurrent(work());
      assert.equal(started.ok, true);
      assert.equal(started.replayed, false);
      assert.equal(started.work.workId, "work-a");
      assert.equal(state.work.current("prj-a").workId, "work-a");

      const replay = state.work.startCurrent(work());
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.work.workId, "work-a");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: a competing start fails without leaving an orphan Work Unit`, async () => {
    const fixture = await store.create();
    const { state } = fixture;
    try {
      state.projects.register(project());
      state.work.startCurrent(work());

      const loser = work({ workId: "work-b", taskId: "task-b" });
      const result = state.work.startCurrent(loser);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "ACTIVE_WORK_EXISTS");
      assert.equal(result.currentWorkId, "work-a");
      assert.equal(state.work.read("prj-a", "work-b"), null);
      assert.equal(state.work.current("prj-a").workId, "work-a");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: low-level open does not implicitly become current`, async () => {
    const fixture = await store.create();
    const { state } = fixture;
    try {
      state.projects.register(project());
      assert.equal(state.work.open(work()).ok, true);
      assert.equal(state.work.current("prj-a"), null);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: active work heads are strictly Project-scoped`, async () => {
    const fixture = await store.create();
    const { state } = fixture;
    try {
      state.projects.register(project("prj-a", "C:/Projects/A"));
      state.projects.register(project("prj-b", "C:/Projects/B"));
      assert.equal(state.work.startCurrent(work()).ok, true);
      assert.equal(state.work.startCurrent(work({ workId: "work-b", projectId: "prj-b", taskId: "task-b" })).ok, true);

      assert.equal(state.work.current("prj-a").workId, "work-a");
      assert.equal(state.work.current("prj-b").workId, "work-b");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("sqlite: active work head survives close and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-work-head-restart-"));
  const dbPath = join(root, "state.db");
  try {
    const first = createSqliteState({ dbPath });
    first.projects.register(project());
    assert.equal(first.work.startCurrent(work()).ok, true);
    first.close();

    const reopened = createSqliteState({ dbPath });
    try {
      assert.equal(reopened.work.current("prj-a").workId, "work-a");
      assert.equal(reopened.work.startCurrent(work()).replayed, true);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite: two concurrent starts produce one head and no orphan loser", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-work-head-race-"));
  const dbPath = join(root, "state.db");
  try {
    const initial = createSqliteState({ dbPath });
    initial.projects.register(project());
    initial.close();

    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(shared);
    const a = runStartWorker({ dbPath, signal: shared, workUnit: work({ workId: "work-a", taskId: "task-a" }) });
    const b = runStartWorker({ dbPath, signal: shared, workUnit: work({ workId: "work-b", taskId: "task-b" }) });

    while (Atomics.load(signal, 0) < 2) Atomics.wait(signal, 0, Atomics.load(signal, 0), 100);
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1, 2);

    const results = await Promise.all([a, b]);
    assert.equal(results.filter((entry) => entry.ok).length, 1);
    assert.equal(results.filter((entry) => entry.reason === "ACTIVE_WORK_EXISTS").length, 1);

    const state = createSqliteState({ dbPath });
    try {
      const current = state.work.current("prj-a");
      assert.ok(current);
      const loserId = current.workId === "work-a" ? "work-b" : "work-a";
      assert.equal(state.work.read("prj-a", loserId), null);
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
