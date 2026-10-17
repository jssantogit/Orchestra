import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkAuthority } from "../../v2/authority/work-authority.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-sessionless",
    lineageId: "lineage-sessionless",
    workspace: { canonicalRoot: "C:/Projects/Sessionless", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function work(overrides = {}) {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-sessionless",
    projectId: "prj-sessionless",
    taskId: "task-sessionless",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 7,
    state: "INTAKE",
    scopeRef: "scope:sessionless",
    directionRef: "direction:sessionless",
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: "continuation:sessionless",
    ...overrides,
  };
}

function actor(subjectHash) {
  return {
    schema: "orchestra.actor-provenance.v2",
    provider: "codex",
    subjectHash,
    source: "PROVIDER_FACT",
    observedAt: "2026-10-17T00:20:00.000Z",
  };
}

function operation() {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-sessionless",
    projectId: "prj-sessionless",
    workId: "work-sessionless",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:writer",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T00:20:00.000Z",
    heartbeatAt: "2026-10-17T00:20:00.000Z",
    deadlineAt: "2026-10-17T00:30:00.000Z",
    runtimeOwnerRef: "process:sessionless:token",
    workspaceRef: "workspace:canonical",
    resultRef: null,
  };
}

async function sqliteFixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-sessionless-"));
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
  { name: "reference", create: async () => ({ state: createReferenceState(), cleanup: async () => {} }) },
  { name: "sqlite", create: sqliteFixture },
];

function seed(state) {
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
}

for (const store of stores) {
  test(`${store.name}: fresh actors attach to the same current Work without ownership transfer`, async () => {
    const fixture = await store.create();
    try {
      seed(fixture.state);
      const authority = createWorkAuthority({ state: fixture.state });

      const first = authority.attach({
        projectId: "prj-sessionless",
        actor: actor("sha256:session-a"),
        observedInstructionEpoch: 7,
      });
      const second = authority.attach({
        projectId: "prj-sessionless",
        actor: actor("sha256:session-b"),
        observedInstructionEpoch: 7,
      });

      assert.deepEqual(first, {
        allowed: true,
        reason: null,
        projectId: "prj-sessionless",
        workId: "work-sessionless",
        taskId: "task-sessionless",
        generation: 0,
        continuationRef: "continuation:sessionless",
      });
      assert.deepEqual(second, first);
      assert.equal(fixture.state.work.current("prj-sessionless").generation, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: attach exposes stale runtime epoch and no-active-work factually`, async () => {
    const fixture = await store.create();
    try {
      fixture.state.projects.register(project());
      const authority = createWorkAuthority({ state: fixture.state });
      assert.deepEqual(authority.attach({
        projectId: "prj-sessionless",
        actor: actor("sha256:new"),
        observedInstructionEpoch: 7,
      }), { allowed: false, reason: "NO_ACTIVE_WORK" });

      fixture.state.work.startCurrent(work());
      const stale = authority.attach({
        projectId: "prj-sessionless",
        actor: actor("sha256:old"),
        observedInstructionEpoch: 6,
      });
      assert.equal(stale.allowed, false);
      assert.equal(stale.reason, "SESSION_RUNTIME_STALE");
      assert.equal(stale.currentInstructionEpoch, 7);
      assert.equal(stale.continuationAvailable, true);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: capability authorization is work-and-generation fenced without session binding`, async () => {
    const fixture = await store.create();
    try {
      seed(fixture.state);
      const authority = createWorkAuthority({ state: fixture.state });
      const transitioned = fixture.state.work.transition({
        projectId: "prj-sessionless",
        workId: "work-sessionless",
        expectedGeneration: 0,
        transitionId: "tr-advance",
        patch: { state: "IMPLEMENTING" },
      });
      assert.equal(transitioned.ok, true);

      const stale = authority.authorize({
        projectId: "prj-sessionless",
        expectedWorkId: "work-sessionless",
        actor: actor("sha256:any"),
        capability: "WORKSPACE_EDIT",
        workspaceRef: "workspace:canonical",
        expectedGeneration: 0,
      });
      assert.equal(stale.allowed, false);
      assert.equal(stale.reason, "STALE_GENERATION");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: an old task cannot authorize against a new task with the same numeric generation`, async () => {
    const fixture = await store.create();
    try {
      seed(fixture.state);
      const authority = createWorkAuthority({ state: fixture.state });
      assert.equal(authority.abandon({
        projectId: "prj-sessionless",
        expectedWorkId: "work-sessionless",
        expectedGeneration: 0,
        commandId: "abandon-for-new-task",
        reason: "switch tasks",
      }).ok, true);
      assert.equal(authority.start(work({
        workId: "work-next",
        taskId: "task-next",
        scopeRef: "scope:next",
        directionRef: "direction:next",
        continuationRef: "continuation:next",
      })).ok, true);

      const oldCommand = authority.authorize({
        projectId: "prj-sessionless",
        expectedWorkId: "work-sessionless",
        actor: actor("sha256:old-session"),
        capability: "WORKSPACE_EDIT",
        workspaceRef: "workspace:canonical",
        expectedGeneration: 0,
      });
      assert.equal(oldCommand.allowed, false);
      assert.equal(oldCommand.reason, "STALE_ACTIVE_WORK");
      assert.equal(oldCommand.currentWorkId, "work-next");

      const currentCommand = authority.authorize({
        projectId: "prj-sessionless",
        expectedWorkId: "work-next",
        actor: actor("sha256:fresh-session"),
        capability: "WORKSPACE_EDIT",
        workspaceRef: "workspace:canonical",
        expectedGeneration: 0,
      });
      assert.equal(currentCommand.allowed, true);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: abandon refuses a factual LIVE operation and preserves the head`, async () => {
    const fixture = await store.create();
    try {
      seed(fixture.state);
      assert.equal(fixture.state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
      const authority = createWorkAuthority({ state: fixture.state });

      const result = authority.abandon({
        projectId: "prj-sessionless",
        expectedWorkId: "work-sessionless",
        expectedGeneration: 0,
        commandId: "abandon-live",
        reason: "switch task",
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, "LIVE_OPERATION_EXISTS");
      assert.equal(result.operationId, "op-sessionless");
      assert.equal(fixture.state.work.current("prj-sessionless").workId, "work-sessionless");
      assert.equal(fixture.state.work.read("prj-sessionless", "work-sessionless").generation, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${store.name}: abandon atomically advances generation, preserves artifacts and clears the head`, async () => {
    const fixture = await store.create();
    try {
      seed(fixture.state);
      const authority = createWorkAuthority({ state: fixture.state });

      const result = authority.abandon({
        projectId: "prj-sessionless",
        expectedWorkId: "work-sessionless",
        expectedGeneration: 0,
        commandId: "abandon-ok",
        reason: "new task requested",
      });

      assert.equal(result.ok, true);
      assert.equal(result.replayed, false);
      assert.equal(result.work.state, "ABANDONED");
      assert.equal(result.work.generation, 1);
      assert.equal(result.work.scopeRef, "scope:sessionless");
      assert.equal(result.work.continuationRef, "continuation:sessionless");
      assert.equal(fixture.state.work.current("prj-sessionless"), null);
      assert.equal(fixture.state.work.read("prj-sessionless", "work-sessionless").generation, 1);

      const replay = authority.abandon({
        projectId: "prj-sessionless",
        expectedWorkId: "work-sessionless",
        expectedGeneration: 0,
        commandId: "abandon-ok",
        reason: "new task requested",
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.work.generation, 1);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("sqlite: abandon idempotency survives close and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-abandon-restart-"));
  const dbPath = join(root, "state.db");
  const command = {
    projectId: "prj-sessionless",
    expectedWorkId: "work-sessionless",
    expectedGeneration: 0,
    commandId: "abandon-restart",
    reason: "finish old task",
  };
  try {
    const first = createSqliteState({ dbPath });
    seed(first);
    const firstAuthority = createWorkAuthority({ state: first });
    assert.equal(firstAuthority.abandon(command).replayed, false);
    first.close();

    const reopened = createSqliteState({ dbPath });
    try {
      const replay = createWorkAuthority({ state: reopened }).abandon(command);
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.work.generation, 1);
      assert.equal(reopened.work.current("prj-sessionless"), null);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
