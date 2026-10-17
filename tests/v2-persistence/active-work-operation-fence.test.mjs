import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-operation-fence",
    lineageId: "lineage-operation-fence",
    workspace: { canonicalRoot: "C:/Projects/OperationFence", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work({ workId = "work-a", taskId = "task-a", generation = 0, state = "IMPLEMENTING" } = {}) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId: "prj-operation-fence",
    taskId,
    generation,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state,
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation({ operationId, workId, generation }) {
  return {
    schema: "orchestra.operation.v2",
    operationId,
    projectId: "prj-operation-fence",
    workId,
    generation,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:operation-fence",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T01:00:00.000Z",
    heartbeatAt: "2026-10-17T01:00:00.000Z",
    deadlineAt: "2026-10-17T01:10:00.000Z",
    runtimeOwnerRef: `process:${operationId}:token`,
    workspaceRef: `workspace:${operationId}`,
    resultRef: null,
  };
}

async function sqliteFixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-operation-head-fence-"));
  const dbPath = join(root, "state.db");
  const state = createSqliteState({ dbPath });
  return {
    state,
    async cleanup() {
      state.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const stores = [
  { name: "reference", create: async () => ({ state: createReferenceState(), cleanup: async () => {} }) },
  { name: "sqlite", create: sqliteFixture },
];

for (const store of stores) {
  test(`${store.name}: operation begin requires an active Work head`, async () => {
    const fixture = await store.create();
    try {
      fixture.state.projects.register(project());
      assert.equal(fixture.state.work.open(work()).ok, true);

      const result = fixture.state.operations.begin({
        expectedGeneration: 0,
        operation: operation({ operationId: "op-no-head", workId: "work-a", generation: 0 }),
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, "NO_ACTIVE_WORK");
      assert.equal(fixture.state.operations.inspect("op-no-head"), null);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: historical Work cannot spawn an Operation after another Work becomes active`, async () => {
    const fixture = await store.create();
    try {
      fixture.state.projects.register(project());
      assert.equal(fixture.state.work.startCurrent(work()).ok, true);
      assert.equal(fixture.state.work.abandonCurrent({
        projectId: "prj-operation-fence",
        expectedWorkId: "work-a",
        expectedGeneration: 0,
        commandId: "abandon-a",
        reason: "switch task",
      }).ok, true);
      assert.equal(fixture.state.work.startCurrent(work({ workId: "work-b", taskId: "task-b" })).ok, true);

      const result = fixture.state.operations.begin({
        expectedGeneration: 1,
        operation: operation({ operationId: "op-stale-work", workId: "work-a", generation: 1 }),
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, "STALE_ACTIVE_WORK");
      assert.equal(result.currentWorkId, "work-b");
      assert.equal(fixture.state.operations.inspect("op-stale-work"), null);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: Operation on the current Work head remains legal`, async () => {
    const fixture = await store.create();
    try {
      fixture.state.projects.register(project());
      assert.equal(fixture.state.work.startCurrent(work()).ok, true);

      const result = fixture.state.operations.begin({
        expectedGeneration: 0,
        operation: operation({ operationId: "op-current", workId: "work-a", generation: 0 }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.operation.workId, "work-a");
    } finally {
      await fixture.cleanup();
    }
  });
}
