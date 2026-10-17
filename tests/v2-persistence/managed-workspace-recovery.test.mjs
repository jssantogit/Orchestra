import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import {
  createManagedWorkspaceStore,
  resolveManagedWorkspacePaths,
} from "../../v2/workspaces/managed-workspace-store.mjs";
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
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-managed-workspace-"));
  const home = join(root, "home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  git("init", projectRoot);
  const paths = resolveManagedWorkspacePaths({ home });
  await mkdir(paths.instancesRoot, { recursive: true });
  return {
    root,
    home,
    projectRoot: await realpath(projectRoot),
    paths,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function project(canonicalRoot) {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-managed-workspace",
    lineageId: "lineage-managed-workspace",
    workspace: { canonicalRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-managed-workspace",
    projectId: "prj-managed-workspace",
    taskId: "task-managed-workspace",
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

function operation(workspaceRef = "workspace:managed-a") {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-managed-workspace",
    projectId: "prj-managed-workspace",
    workId: "work-managed-workspace",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:managed-workspace",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    deadlineAt: "2000-01-01T00:01:00.000Z",
    runtimeOwnerRef: "owner:managed-workspace",
    workspaceRef,
    resultRef: null,
  };
}

function record(root, overrides = {}) {
  return {
    schema: "orchestra.managed-workspace.v2",
    workspaceRef: "workspace:managed-a",
    operationId: "op-managed-workspace",
    projectId: "prj-managed-workspace",
    workId: "work-managed-workspace",
    generation: 0,
    kind: "TRANSIENT_GIT_CLONE",
    root,
    registeredAt: "2026-10-17T10:00:00.000Z",
    ...overrides,
  };
}

function seededState(projectRoot) {
  const state = createReferenceState();
  assert.equal(state.projects.register(project(projectRoot)).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  return state;
}

async function makeManagedRepo(fx, name = "managed-a") {
  const root = join(fx.paths.instancesRoot, name);
  await mkdir(root, { recursive: true });
  git("init", root);
  return realpath(root);
}

test("Managed Workspace Store durably binds an immutable workspace ref to one operation", async () => {
  const fx = await fixture();
  try {
    const managedRoot = await makeManagedRepo(fx);
    const store = createManagedWorkspaceStore({ home: fx.home });
    const workspace = record(managedRoot);

    const first = await store.register(workspace);
    const replay = await store.register(workspace);

    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(await store.read(workspace.workspaceRef), workspace);

    const conflict = await store.register({ ...workspace, operationId: "op-other" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "MANAGED_WORKSPACE_ID_CONFLICT");
  } finally {
    await fx.cleanup();
  }
});

test("Managed Workspace Store rejects roots outside Orchestra-managed instances", async () => {
  const fx = await fixture();
  try {
    const outside = join(fx.root, "outside");
    await mkdir(outside, { recursive: true });
    git("init", outside);
    const store = createManagedWorkspaceStore({ home: fx.home });
    const result = await store.register(record(await realpath(outside)));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "MANAGED_WORKSPACE_ROOT_OUTSIDE_HOME");
    assert.equal(await store.read("workspace:managed-a"), null);
  } finally {
    await fx.cleanup();
  }
});

test("Managed Workspace Recovery classifies clean and dirty Git clones without trusting workspaceRef as a path", async () => {
  const fx = await fixture();
  try {
    const managedRoot = await makeManagedRepo(fx);
    const state = seededState(fx.projectRoot);
    const store = createManagedWorkspaceStore({ home: fx.home });
    assert.equal((await store.register(record(managedRoot))).ok, true);
    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state, store });

    assert.deepEqual(await recovery.inspect("workspace:managed-a", operation()), {
      workspaceRef: "workspace:managed-a",
      status: "CLEAN",
    });

    await writeFile(join(managedRoot, "dirty.txt"), "dirty\n", "utf8");
    assert.deepEqual(await recovery.inspect("workspace:managed-a", operation()), {
      workspaceRef: "workspace:managed-a",
      status: "DIRTY",
    });
  } finally {
    await fx.cleanup();
  }
});

test("Managed Workspace Recovery deletes only a clean, correctly bound managed clone", async () => {
  const fx = await fixture();
  try {
    const managedRoot = await makeManagedRepo(fx);
    const state = seededState(fx.projectRoot);
    const store = createManagedWorkspaceStore({ home: fx.home });
    assert.equal((await store.register(record(managedRoot))).ok, true);
    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state, store });

    const cleaned = await recovery.cleanup("workspace:managed-a", operation());
    assert.deepEqual(cleaned, { workspaceRef: "workspace:managed-a", cleaned: true });
    assert.equal(await exists(managedRoot), false);
    assert.deepEqual(await recovery.inspect("workspace:managed-a", operation()), {
      workspaceRef: "workspace:managed-a",
      status: "ABSENT",
    });
    assert.equal((await store.read("workspace:managed-a")).root, managedRoot, "record remains durable audit evidence");
  } finally {
    await fx.cleanup();
  }
});

test("Managed Workspace Recovery preserves dirty clone and rejects mismatched operation binding", async () => {
  const fx = await fixture();
  try {
    const managedRoot = await makeManagedRepo(fx);
    const state = seededState(fx.projectRoot);
    const store = createManagedWorkspaceStore({ home: fx.home });
    assert.equal((await store.register(record(managedRoot))).ok, true);
    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state, store });

    await writeFile(join(managedRoot, "keep.txt"), "preserve\n", "utf8");
    await assert.rejects(
      () => recovery.cleanup("workspace:managed-a", operation()),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_DIRTY",
    );
    assert.equal(await exists(managedRoot), true);

    const wrong = { ...operation(), operationId: "op-other" };
    assert.deepEqual(await recovery.inspect("workspace:managed-a", wrong), {
      workspaceRef: "workspace:managed-a",
      status: "UNKNOWN",
    });
  } finally {
    await fx.cleanup();
  }
});

test("Managed Workspace Recovery never treats the canonical project root as disposable", async () => {
  const fx = await fixture();
  try {
    const managedRoot = await makeManagedRepo(fx, "canonical-project");
    const state = seededState(managedRoot);
    const store = createManagedWorkspaceStore({ home: fx.home });
    assert.equal((await store.register(record(managedRoot))).ok, true);
    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state, store });

    assert.deepEqual(await recovery.inspect("workspace:managed-a", operation()), {
      workspaceRef: "workspace:managed-a",
      status: "UNKNOWN",
    });
    await assert.rejects(
      () => recovery.cleanup("workspace:managed-a", operation()),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_UNSAFE",
    );
    assert.equal(await exists(managedRoot), true);
  } finally {
    await fx.cleanup();
  }
});
