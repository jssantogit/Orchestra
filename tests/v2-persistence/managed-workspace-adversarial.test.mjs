import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-managed-adversarial-"));
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

function operation(workspaceRef = "workspace:adversarial") {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-adversarial",
    projectId: "prj-adversarial",
    workId: "work-adversarial",
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:adversarial",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    deadlineAt: "2000-01-01T00:01:00.000Z",
    runtimeOwnerRef: "owner:adversarial",
    workspaceRef,
    resultRef: null,
  };
}

function workspace(root, workspaceRef = "workspace:adversarial") {
  return {
    schema: "orchestra.managed-workspace.v2",
    workspaceRef,
    operationId: "op-adversarial",
    projectId: "prj-adversarial",
    workId: "work-adversarial",
    generation: 0,
    kind: "TRANSIENT_GIT_CLONE",
    root,
    registeredAt: "2026-10-17T10:00:00.000Z",
  };
}

function stateFor(projectRoot, op = operation()) {
  const state = createReferenceState();
  assert.equal(state.projects.register({
    schema: "orchestra.project.v2",
    projectId: op.projectId,
    lineageId: "lineage-adversarial",
    workspace: { canonicalRoot: projectRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  }).ok, true);
  assert.equal(state.work.startCurrent({
    schema: "orchestra.work-unit.v2",
    workId: op.workId,
    projectId: op.projectId,
    taskId: "task-adversarial",
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

async function makeManagedRepo(fx, name = "managed") {
  const root = join(fx.paths.instancesRoot, name);
  await mkdir(root, { recursive: true });
  git("init", root);
  return realpath(root);
}

function recordPath(paths, workspaceRef) {
  const key = createHash("sha256").update(workspaceRef, "utf8").digest("hex");
  return join(paths.recordsRoot, key.slice(0, 2), `${key}.json`);
}

test("hostile workspaceRef is hashed into storage and is never interpreted as a filesystem path", async () => {
  const fx = await fixture();
  try {
    const root = await makeManagedRepo(fx);
    const hostileRef = "../../outside/owned";
    const store = createManagedWorkspaceStore({ home: fx.home });
    const record = workspace(root, hostileRef);

    assert.equal((await store.register(record)).ok, true);
    assert.deepEqual(await store.read(hostileRef), record);
    assert.equal((await readFile(recordPath(fx.paths, hostileRef), "utf8")).includes(hostileRef), true);
  } finally {
    await fx.cleanup();
  }
});

test("concurrent identical managed workspace registration converges on one immutable record", async () => {
  const fx = await fixture();
  try {
    const root = await makeManagedRepo(fx);
    const left = createManagedWorkspaceStore({ home: fx.home });
    const right = createManagedWorkspaceStore({ home: fx.home });
    const record = workspace(root);

    const results = await Promise.all([left.register(record), right.register(record)]);
    assert.equal(results.every((entry) => entry.ok), true);
    assert.equal(results.filter((entry) => entry.replayed === false).length, 1);
    assert.equal(results.filter((entry) => entry.replayed === true).length, 1);
    assert.deepEqual(await left.read(record.workspaceRef), record);
  } finally {
    await fx.cleanup();
  }
});

test("managed workspace root must be a direct child of the Orchestra instances directory", async () => {
  const fx = await fixture();
  try {
    const nestedRoot = join(fx.paths.instancesRoot, "nested-parent", "managed");
    await mkdir(nestedRoot, { recursive: true });
    git("init", nestedRoot);
    const store = createManagedWorkspaceStore({ home: fx.home });

    const result = await store.register(workspace(await realpath(nestedRoot)));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MANAGED_WORKSPACE_ROOT_NOT_DIRECT_CHILD");
    assert.equal(await store.read("workspace:adversarial"), null);
  } finally {
    await fx.cleanup();
  }
});

test("tampered managed workspace record fails closed and is never silently replaced", async () => {
  const fx = await fixture();
  try {
    const root = await makeManagedRepo(fx);
    const store = createManagedWorkspaceStore({ home: fx.home });
    const record = workspace(root);
    assert.equal((await store.register(record)).ok, true);

    const path = recordPath(fx.paths, record.workspaceRef);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.workspace.operationId = "op-tampered";
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");

    await assert.rejects(
      () => store.read(record.workspaceRef),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_CORRUPT",
    );
    await assert.rejects(
      () => store.register(record),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_CORRUPT",
    );
  } finally {
    await fx.cleanup();
  }
});

test("workspace replaced by an egress symlink after registration becomes UNKNOWN and is never followed by cleanup", async () => {
  const fx = await fixture();
  try {
    const managedRoot = await makeManagedRepo(fx);
    const outside = join(fx.root, "outside-target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "sentinel.txt"), "keep\n", "utf8");

    const op = operation();
    const state = stateFor(fx.projectRoot, op);
    const store = createManagedWorkspaceStore({ home: fx.home });
    assert.equal((await store.register(workspace(managedRoot))).ok, true);

    await rm(managedRoot, { recursive: true, force: true });
    await symlink(outside, managedRoot, process.platform === "win32" ? "junction" : "dir");

    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state, store });
    assert.deepEqual(await recovery.inspect(op.workspaceRef, op), {
      workspaceRef: op.workspaceRef,
      status: "UNKNOWN",
    });
    await assert.rejects(
      () => recovery.cleanup(op.workspaceRef, op),
      (error) => error?.code === "ORCHESTRA_MANAGED_WORKSPACE_UNSAFE",
    );
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    await fx.cleanup();
  }
});
