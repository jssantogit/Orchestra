import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
