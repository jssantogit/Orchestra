import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { resolveGlobalRegistryPaths } from "../../v2/global/project-registry.mjs";
import { createManagedWorkspaceStore, resolveManagedWorkspacePaths } from "../../v2/workspaces/managed-workspace-store.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "v2", "global", "orchestra.mjs");

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

function runCli({ home, cwd, args }) {
  const result = spawnSync(process.execPath, [cli, ...args, "--home", home], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return {
    status: result.status,
    json: stdout ? JSON.parse(stdout) : (stderr ? JSON.parse(stderr) : null),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-global-dirty-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  git("init", repo);
  return { root, repo, home, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

async function seedDirty({ fx, operationId }) {
  const registered = runCli({
    home: fx.home,
    cwd: fx.repo,
    args: ["register", "--runtime-image", "2.0.0", "--instruction-epoch", "3", "--trust", "trusted"],
  });
  assert.equal(registered.status, 0);
  const project = registered.json.project;
  const workspaceRef = `workspace:${operationId}`;
  const work = {
    schema: "orchestra.work-unit.v2",
    workId: `work-${operationId}`,
    projectId: project.projectId,
    taskId: `task-${operationId}`,
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 3,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
  const operation = {
    schema: "orchestra.operation.v2",
    operationId,
    projectId: project.projectId,
    workId: work.workId,
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:dirty-cli",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    deadlineAt: "2000-01-01T00:01:00.000Z",
    runtimeOwnerRef: `owner:${operationId}`,
    workspaceRef,
    resultRef: null,
  };

  const { statePath } = resolveGlobalRegistryPaths({ home: fx.home });
  const state = createSqliteState({ dbPath: statePath });
  assert.equal(state.work.startCurrent(work).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation }).ok, true);
  state.close();

  const owners = createRuntimeOwnerStore({ rootDir: join(fx.home, "runtime-owners") });
  assert.equal((await owners.register({
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: operation.runtimeOwnerRef,
    operationId,
    kind: "LOCAL_PROCESS",
    process: { pid: 2147483647, startIdentity: "dead-process:dirty-cli" },
    proof: { tokenHash: `sha256:${"b".repeat(64)}` },
    registeredAt: "2000-01-01T00:00:00.000Z",
  })).ok, true);

  const paths = resolveManagedWorkspacePaths({ home: fx.home });
  const managedRoot = join(paths.instancesRoot, operationId);
  await mkdir(managedRoot, { recursive: true });
  git("init", managedRoot);
  await writeFile(join(managedRoot, "keep.txt"), "preserve me\n", "utf8");
  const canonicalManagedRoot = await realpath(managedRoot);
  const workspaces = createManagedWorkspaceStore({ home: fx.home });
  assert.equal((await workspaces.register({
    schema: "orchestra.managed-workspace.v2",
    workspaceRef,
    operationId,
    projectId: project.projectId,
    workId: work.workId,
    generation: 0,
    kind: "TRANSIENT_GIT_CLONE",
    root: canonicalManagedRoot,
    registeredAt: "2026-10-17T10:00:00.000Z",
  })).ok, true);

  return { project, operation, managedRoot: canonicalManagedRoot };
}

test("global project resolve-dirty PRESERVE releases stale ownership without deleting dirty bytes", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedDirty({ fx, operationId: "op-dirty-preserve" });
    const args = [
      "project", "resolve-dirty", seeded.project.projectId, seeded.operation.operationId,
      "--action", "preserve", "--command-id", "dirty-preserve-1",
    ];
    const result = runCli({ home: fx.home, cwd: fx.repo, args });

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.action, "PRESERVE");
    assert.equal(result.json.operation.liveness, "TERMINAL");
    assert.equal(result.json.preserved, true);
    assert.equal(await exists(seeded.managedRoot), true);

    const replay = runCli({ home: fx.home, cwd: fx.repo, args });
    assert.equal(replay.status, 0);
    assert.equal(replay.json.replayed, true);

    const status = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: ["project", "status", seeded.project.projectId],
    });
    assert.equal(status.status, 0);
    assert.equal(status.json.reconciliation.operations.some((entry) => entry.operation.operationId === seeded.operation.operationId), false);
  } finally {
    await fx.cleanup();
  }
});

test("global project resolve-dirty DISCARD removes only the explicitly managed dirty clone", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedDirty({ fx, operationId: "op-dirty-discard" });
    const result = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "project", "resolve-dirty", seeded.project.projectId, seeded.operation.operationId,
        "--action", "discard", "--command-id", "dirty-discard-1",
      ],
    });

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.action, "DISCARD");
    assert.equal(result.json.operation.liveness, "TERMINAL");
    assert.equal(result.json.discarded, true);
    assert.equal(await exists(seeded.managedRoot), false);
    assert.equal(await exists(fx.repo), true);
  } finally {
    await fx.cleanup();
  }
});

test("global project resolve-dirty requires explicit action and command id", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedDirty({ fx, operationId: "op-dirty-usage" });
    const missingAction = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "project", "resolve-dirty", seeded.project.projectId, seeded.operation.operationId,
        "--command-id", "dirty-usage-1",
      ],
    });
    assert.equal(missingAction.status, 2);
    assert.equal(missingAction.json.code, "ORCHESTRA_V2_CLI_USAGE");

    const missingCommand = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "project", "resolve-dirty", seeded.project.projectId, seeded.operation.operationId,
        "--action", "preserve",
      ],
    });
    assert.equal(missingCommand.status, 2);
    assert.equal(missingCommand.json.code, "ORCHESTRA_V2_CLI_USAGE");
  } finally {
    await fx.cleanup();
  }
});
