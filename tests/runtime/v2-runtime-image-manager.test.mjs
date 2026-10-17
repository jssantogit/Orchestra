import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeImageManager } from "../../v2/runtime-images/manager.mjs";

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;

function image(imageId, overrides = {}) {
  return {
    schema: "orchestra.runtime-image.v2",
    imageId,
    version: "2.8.0",
    manifestDigest: imageId,
    manifestRef: `blob:${imageId}`,
    engineCompatibility: { min: "2.7.0", max: "2.x" },
    providerAdapterCompatibility: {
      codex: { min: "2.7.0", max: "2.x" },
      antigravity: { min: "2.7.0", max: "2.x" },
    },
    createdAt: "2026-10-17T12:00:00.000Z",
    ...overrides,
  };
}

function fixture({ status = null, target = image(IMAGE_B), projectId = "prj-a" } = {}) {
  let project = {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot: `/tmp/${projectId}`, vcs: "git" },
    runtime: { pinnedImage: IMAGE_A, instructionEpoch: 4 },
    trust: { mode: "trusted" },
  };
  const projects = new Map([[projectId, project]]);
  const updateCalls = [];
  const state = {
    projects: {
      inspect(id) { return projects.get(id) ?? null; },
      updateRuntime(command) {
        updateCalls.push(command);
        const current = projects.get(command.projectId);
        if (!current) return { ok: false, reason: "PROJECT_NOT_FOUND" };
        if (current.runtime.pinnedImage === command.targetImage) {
          return { ok: true, project: current, replayed: true };
        }
        if (current.runtime.pinnedImage !== command.expectedPinnedImage
          || current.runtime.instructionEpoch !== command.expectedInstructionEpoch) {
          return {
            ok: false,
            reason: "STALE_PROJECT_RUNTIME",
            currentPinnedImage: current.runtime.pinnedImage,
            currentInstructionEpoch: current.runtime.instructionEpoch,
          };
        }
        project = {
          ...current,
          runtime: {
            pinnedImage: command.targetImage,
            instructionEpoch: current.runtime.instructionEpoch + 1,
          },
        };
        projects.set(command.projectId, project);
        return { ok: true, project, replayed: false };
      },
    },
  };
  const imageStore = {
    async list() { return [image(IMAGE_A), target]; },
    async verify(imageId) { return { valid: imageId === target.imageId || imageId === IMAGE_A, imageId }; },
  };
  const statusReconciler = {
    async inspect() {
      return status ?? { ok: true, project, work: null, operations: [] };
    },
  };
  const manager = createRuntimeImageManager({
    state,
    imageStore,
    statusReconciler,
    engineVersion: "2.9.0",
    providerAdapterVersions: { codex: "2.9.0", antigravity: "2.9.0" },
  });
  return { manager, updateCalls, state };
}

test("clean project upgrade changes pin and advances epoch exactly once", async () => {
  const { manager } = fixture();
  const result = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "UPGRADE");
  assert.equal(result.previousImageId, IMAGE_A);
  assert.equal(result.project.runtime.pinnedImage, IMAGE_B);
  assert.equal(result.project.runtime.instructionEpoch, 5);

  const replay = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.project.runtime.instructionEpoch, 5);
});

test("rollback uses the same safe activation boundary and advances epoch once", async () => {
  const { manager } = fixture();
  const upgraded = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
  assert.equal(upgraded.ok, true);
  const rolledBack = await manager.rollbackProject({ projectId: "prj-a", targetImageId: IMAGE_A, provider: "codex" });
  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.action, "ROLLBACK");
  assert.equal(rolledBack.project.runtime.pinnedImage, IMAGE_A);
  assert.equal(rolledBack.project.runtime.instructionEpoch, 6);
});

test("LIVE operation blocks runtime activation without mutating the project", async () => {
  const status = {
    ok: true,
    project: { projectId: "prj-a" },
    work: null,
    operations: [{
      operation: { operationId: "op-live" },
      assessment: { liveness: "LIVE", reason: "OWNER_MATCH" },
      blocksMutation: true,
      recoveryAvailable: false,
      humanGateRequired: false,
      actionRequired: "WAIT_FOR_LIVE_OPERATION",
    }],
  };
  const { manager, updateCalls } = fixture({ status });
  const result = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROJECT_RUNTIME_CHANGE_BLOCKED");
  assert.deepEqual(result.status, status);
  assert.equal(updateCalls.length, 0);
});

test("stale dirty and unknown operation states return existing reconciler actions unchanged", async () => {
  for (const operation of [
    {
      operation: { operationId: "op-dirty" },
      assessment: { liveness: "STALE_RECOVERABLE", reason: "OWNER_GONE" },
      workspace: { workspaceRef: "ws-dirty", status: "DIRTY" },
      blocksMutation: false,
      recoveryAvailable: false,
      humanGateRequired: false,
      actionRequired: "RESOLVE_DIRTY_WORKSPACE",
    },
    {
      operation: { operationId: "op-unknown" },
      assessment: { liveness: "UNKNOWN", reason: "OWNER_PROOF_UNAVAILABLE" },
      workspace: null,
      blocksMutation: true,
      recoveryAvailable: false,
      humanGateRequired: true,
      actionRequired: "RESOLVE_LIVENESS",
    },
  ]) {
    const status = { ok: true, project: { projectId: "prj-a" }, work: null, operations: [operation] };
    const { manager, updateCalls } = fixture({ status });
    const result = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "PROJECT_RUNTIME_CHANGE_BLOCKED");
    assert.deepEqual(result.status.operations[0], operation);
    assert.equal(updateCalls.length, 0);
  }
});

test("active work blocks runtime activation even without a LIVE operation", async () => {
  const status = {
    ok: true,
    project: { projectId: "prj-a" },
    work: { workId: "work-active", generation: 2 },
    operations: [],
  };
  const { manager, updateCalls } = fixture({ status });
  const result = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROJECT_RUNTIME_CHANGE_BLOCKED");
  assert.deepEqual(result.status, status);
  assert.equal(updateCalls.length, 0);
});

test("incompatible image is denied before project pin mutation", async () => {
  const incompatible = image(IMAGE_B, { engineCompatibility: { min: "3.0.0", max: "3.x" } });
  const { manager, updateCalls } = fixture({ target: incompatible });
  const result = await manager.upgradeProject({ projectId: "prj-a", targetImageId: IMAGE_B, provider: "codex" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "RUNTIME_IMAGE_INCOMPATIBLE");
  assert.equal(result.compatibility.code, "ENGINE_VERSION_INCOMPATIBLE");
  assert.equal(updateCalls.length, 0);
});

test("missing or corrupt target image fails closed before activation", async () => {
  const { manager, updateCalls } = fixture();
  const missing = await manager.upgradeProject({ projectId: "prj-a", targetImageId: `sha256:${"c".repeat(64)}`, provider: "codex" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "RUNTIME_IMAGE_NOT_INSTALLED");
  assert.equal(updateCalls.length, 0);
});
