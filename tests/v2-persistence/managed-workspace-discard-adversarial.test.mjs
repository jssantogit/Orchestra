import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createManagedWorkspaceStore, resolveManagedWorkspacePaths } from "../../v2/workspaces/managed-workspace-store.mjs";
import { createManagedWorkspaceRecovery } from "../../v2/workspaces/managed-workspace-recovery.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-discard-adversarial-"));
  const home = join(root, "home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  git("init", projectRoot);
  const paths = resolveManagedWorkspacePaths({ home });
  await mkdir(paths.instancesRoot, { recursive: true });
  return {
    root,
    home,
    paths,
    projectRoot: await realpath(projectRoot),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function operation() {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-discard-adversarial",
    projectId: "prj-discard-adversarial",
    workId: "work-discard-adversarial",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:discard-adversarial",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T10:00:00.000Z",
    heartbeatAt: "2026-10-17T10:00:00.000Z",
    deadlineAt: "2026-10-17T10:05:00.000Z",
    runtimeOwnerRef: "owner:discard-adversarial",
    workspaceRef: "workspace:discard-adversarial",
    resultRef: null,
  };
}

function stateFor(projectRoot, op = operation()) {
  const state = createReferenceState();
  assert.equal(state.projects.register({
    schema: "orchestra.project.v2",
    projectId: op.projectId,
    lineageId: "lineage-discard-adversarial",
    workspace: { canonicalRoot: projectRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  }).ok, true);
  assert.equal(state.work.startCurrent({
    schema: "orchestra.work-unit.v2",
    workId: op.workId,
    projectId: op.projectId,
    taskId: "task-discard-adversarial",
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
  }).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: op }).ok, true);
  return state;
}

async function registerManaged({ fx, dirty }) {
  const root = join(fx.paths.instancesRoot, "managed-discard");
  await mkdir(root, { recursive: true });
  git("init", root);
  if (dirty) await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");
  const canonicalRoot = await realpath(root);
  const op = operation();
  const store = createManagedWorkspaceStore({ home: fx.home });
  assert.equal((await store.register({
    schema: "orchestra.managed-workspace.v2",
    workspaceRef: op.workspaceRef,
    operationId: op.operationId,
    projectId: op.projectId,
    workId: op.workId,
    generation: op.generation,
    kind: "TRANSIENT_GIT_CLONE",
    root: canonicalRoot,
    registeredAt: "2026-10-17T10:00:00.000Z",
  })).ok, true);
  return { root: canonicalRoot, op, store };
}

test("explicit discard deletes a dirty managed clone but never the canonical project root", async () => {
  const fx = await fixture();
  try {
    const { root, op, store } = await registerManaged({ fx, dirty: true });
    const recovery = createManagedWorkspaceRecovery({
      home: fx.home,
      state: stateFor(fx.projectRoot, op),
      store,
    });

    assert.deepEqual(await recovery.discard(op.workspaceRef, op), {
      workspaceRef: op.workspaceRef,
      discarded: true,
    });
    assert.equal(await exists(root), false);
    assert.equal(await exists(fx.projectRoot), true);
  } finally {
    await fx.cleanup();
  }
});

test("explicit discard refuses a clean workspace so normal recovery remains the only clean cleanup path", async () => {
  const fx = await fixture();
  try {
    const { root, op, store } = await registerManaged({ fx, dirty: false });
    const recovery = createManagedWorkspaceRecovery({
      home: fx.home,
      state: stateFor(fx.projectRoot, op),
      store,
    });

    await assert.rejects(
      () => recovery.discard(op.workspaceRef, op),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_DISCARD_UNSAFE",
    );
    assert.equal(await exists(root), true);
  } finally {
    await fx.cleanup();
  }
});

test("explicit discard never follows a symlink or junction substituted after registration", async () => {
  const fx = await fixture();
  try {
    const { root, op, store } = await registerManaged({ fx, dirty: true });
    const outside = join(fx.root, "outside-discard-target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "sentinel.txt"), "keep\n", "utf8");

    await rm(root, { recursive: true, force: true });
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");

    const recovery = createManagedWorkspaceRecovery({
      home: fx.home,
      state: stateFor(fx.projectRoot, op),
      store,
    });
    assert.deepEqual(await recovery.inspect(op.workspaceRef, op), {
      workspaceRef: op.workspaceRef,
      status: "UNKNOWN",
    });
    await assert.rejects(
      () => recovery.discard(op.workspaceRef, op),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_DISCARD_UNSAFE",
    );
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    await fx.cleanup();
  }
});
