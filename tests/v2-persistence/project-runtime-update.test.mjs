import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project({ projectId = "prj-runtime-update", imageId = "image-a", epoch = 7 } = {}) {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot: `/tmp/${projectId}`, vcs: "git" },
    runtime: { pinnedImage: imageId, instructionEpoch: epoch },
    trust: { mode: "trusted" },
  };
}

async function withState(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-runtime-update-"));
  const dbPath = join(root, "orchestra.db");
  try {
    const state = createSqliteState({ dbPath });
    await fn(state, dbPath);
    state.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("project runtime pin update advances instruction epoch exactly once", async () => {
  await withState(async (state) => {
    assert.equal(state.projects.register(project()).ok, true);

    const changed = state.projects.updateRuntime({
      projectId: "prj-runtime-update",
      expectedPinnedImage: "image-a",
      expectedInstructionEpoch: 7,
      targetImage: "image-b",
      commandId: "runtime-change-1",
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.replayed, false);
    assert.equal(changed.project.runtime.pinnedImage, "image-b");
    assert.equal(changed.project.runtime.instructionEpoch, 8);

    const replay = state.projects.updateRuntime({
      projectId: "prj-runtime-update",
      expectedPinnedImage: "image-a",
      expectedInstructionEpoch: 7,
      targetImage: "image-b",
      commandId: "runtime-change-1",
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.project.runtime.instructionEpoch, 8);
  });
});

test("stale runtime pin update fails closed without changing project state", async () => {
  await withState(async (state) => {
    assert.equal(state.projects.register(project()).ok, true);

    const stale = state.projects.updateRuntime({
      projectId: "prj-runtime-update",
      expectedPinnedImage: "wrong-image",
      expectedInstructionEpoch: 7,
      targetImage: "image-b",
      commandId: "runtime-stale-1",
    });
    assert.deepEqual(stale, {
      ok: false,
      reason: "STALE_PROJECT_RUNTIME",
      currentPinnedImage: "image-a",
      currentInstructionEpoch: 7,
    });
    assert.equal(state.projects.inspect("prj-runtime-update").runtime.pinnedImage, "image-a");
    assert.equal(state.projects.inspect("prj-runtime-update").runtime.instructionEpoch, 7);
  });
});

test("same runtime target is an idempotent no-op with no epoch advance", async () => {
  await withState(async (state) => {
    assert.equal(state.projects.register(project()).ok, true);
    const result = state.projects.updateRuntime({
      projectId: "prj-runtime-update",
      expectedPinnedImage: "image-a",
      expectedInstructionEpoch: 7,
      targetImage: "image-a",
      commandId: "runtime-noop-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.replayed, true);
    assert.equal(result.project.runtime.instructionEpoch, 7);
  });
});

test("runtime pin update preserves unrelated project state", async () => {
  await withState(async (state) => {
    assert.equal(state.projects.register(project({ projectId: "prj-a", imageId: "image-a" })).ok, true);
    assert.equal(state.projects.register(project({ projectId: "prj-b", imageId: "image-b" })).ok, true);

    assert.equal(state.projects.updateRuntime({
      projectId: "prj-a",
      expectedPinnedImage: "image-a",
      expectedInstructionEpoch: 7,
      targetImage: "image-c",
      commandId: "runtime-project-a-1",
    }).ok, true);

    assert.equal(state.projects.inspect("prj-b").runtime.pinnedImage, "image-b");
    assert.equal(state.projects.inspect("prj-b").runtime.instructionEpoch, 7);
  });
});

test("runtime command replay survives close and reopen without a second epoch advance", async () => {
  await withState(async (state, dbPath) => {
    assert.equal(state.projects.register(project()).ok, true);
    const command = {
      projectId: "prj-runtime-update",
      expectedPinnedImage: "image-a",
      expectedInstructionEpoch: 7,
      targetImage: "image-b",
      commandId: "runtime-restart-1",
    };
    const changed = state.projects.updateRuntime(command);
    assert.equal(changed.ok, true);
    assert.equal(changed.replayed, false);
    state.close();

    const reopened = createSqliteState({ dbPath });
    try {
      const replay = reopened.projects.updateRuntime(command);
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.project.runtime.pinnedImage, "image-b");
      assert.equal(replay.project.runtime.instructionEpoch, 8);
    } finally {
      reopened.close();
    }
  });
});

test("runtime command id cannot be rebound to a different activation after restart", async () => {
  await withState(async (state, dbPath) => {
    assert.equal(state.projects.register(project()).ok, true);
    const changed = state.projects.updateRuntime({
      projectId: "prj-runtime-update",
      expectedPinnedImage: "image-a",
      expectedInstructionEpoch: 7,
      targetImage: "image-b",
      commandId: "runtime-command-conflict",
    });
    assert.equal(changed.ok, true);
    state.close();

    const reopened = createSqliteState({ dbPath });
    try {
      const conflict = reopened.projects.updateRuntime({
        projectId: "prj-runtime-update",
        expectedPinnedImage: "image-b",
        expectedInstructionEpoch: 8,
        targetImage: "image-c",
        commandId: "runtime-command-conflict",
      });
      assert.deepEqual(conflict, { ok: false, reason: "IDEMPOTENCY_CONFLICT" });
      const current = reopened.projects.inspect("prj-runtime-update");
      assert.equal(current.runtime.pinnedImage, "image-b");
      assert.equal(current.runtime.instructionEpoch, 8);
    } finally {
      reopened.close();
    }
  });
});
