import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { resolveGlobalRegistryPaths } from "../../v2/global/project-registry.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "v2", "global", "orchestra.mjs");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runCli({ home, cwd, args }) {
  const result = spawnSync(process.execPath, [cli, ...args, "--home", home], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-global-reconcile-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  git("init", repo);
  return {
    root,
    repo,
    home,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test("project status reports factual Work and liveness instead of trusting persisted LIVE", async () => {
  const fx = await fixture();
  try {
    const registered = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "register",
        "--runtime-image", "2.0.0",
        "--instruction-epoch", "3",
        "--trust", "trusted",
      ],
    });
    assert.equal(registered.status, 0);
    const project = registered.json.project;

    const { statePath } = resolveGlobalRegistryPaths({ home: fx.home });
    const state = createSqliteState({ dbPath: statePath });
    const work = {
      schema: "orchestra.work-unit.v2",
      workId: "work-global-status",
      projectId: project.projectId,
      taskId: "task-global-status",
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
    assert.equal(state.work.startCurrent(work).ok, true);
    assert.equal(state.operations.begin({
      expectedGeneration: 0,
      operation: {
        schema: "orchestra.operation.v2",
        operationId: "op-global-status",
        projectId: project.projectId,
        workId: work.workId,
        generation: 0,
        kind: "IMPLEMENTATION_MEMBER",
        actorRef: "actor:status",
        capabilities: ["WORKSPACE_EDIT"],
        workflowState: "RUNNING",
        liveness: "LIVE",
        startedAt: "2026-10-17T06:00:00.000Z",
        heartbeatAt: "2026-10-17T06:00:00.000Z",
        deadlineAt: "2026-10-17T06:05:00.000Z",
        runtimeOwnerRef: "owner:missing-from-global-store",
        workspaceRef: "workspace:status",
        resultRef: null,
      },
    }).ok, true);
    state.close();

    const status = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: ["project", "status", project.projectId],
    });

    assert.equal(status.status, 0);
    assert.equal(status.stderr, "");
    assert.equal(status.json.ok, true);
    assert.equal(status.json.registered, true);
    assert.equal(status.json.project.projectId, project.projectId);
    assert.equal(status.json.reconciliation.work.workId, work.workId);
    assert.equal(status.json.reconciliation.operations.length, 1);
    const [operation] = status.json.reconciliation.operations;
    assert.equal(operation.operation.operationId, "op-global-status");
    assert.equal(operation.operation.liveness, "LIVE", "persisted workflow fact remains untouched");
    assert.equal(operation.assessment.liveness, "UNKNOWN");
    assert.equal(operation.assessment.reason, "RUNTIME_OWNER_MISSING");
    assert.equal(operation.blocksMutation, true);
    assert.equal(operation.recoveryAvailable, false);
  } finally {
    await fx.cleanup();
  }
});

test("project status with no active Work exposes an empty reconciliation view", async () => {
  const fx = await fixture();
  try {
    const registered = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "register",
        "--runtime-image", "2.0.0",
        "--instruction-epoch", "3",
        "--trust", "trusted",
      ],
    });
    const status = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: ["project", "status", registered.json.project.projectId],
    });

    assert.equal(status.status, 0);
    assert.equal(status.json.reconciliation.work, null);
    assert.deepEqual(status.json.reconciliation.operations, []);
  } finally {
    await fx.cleanup();
  }
});

test("global status recovers provider-event Operations after the neutral deadline without success", async () => {
  const fx = await fixture();
  try {
    const registered = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "register",
        "--runtime-image", "2.0.0",
        "--instruction-epoch", "3",
        "--trust", "trusted",
      ],
    });
    assert.equal(registered.status, 0);
    const project = registered.json.project;
    const startedMs = Date.now() - 2 * 60_000;
    const startedAt = new Date(startedMs).toISOString();
    const deadlineAt = new Date(startedMs + 60_000).toISOString();
    const operationId = "op-provider-event-expired";
    const runtimeOwnerRef = "provider-owner:op-provider-event-expired";
    const statePath = resolveGlobalRegistryPaths({ home: fx.home }).statePath;
    const state = createSqliteState({ dbPath: statePath });
    try {
      const work = {
        schema: "orchestra.work-unit.v2",
        workId: "work-provider-event-expired",
        projectId: project.projectId,
        taskId: "task-provider-event-expired",
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
      assert.equal(state.work.startCurrent(work).ok, true);
      assert.equal(state.operations.begin({
        expectedGeneration: 0,
        operation: {
          schema: "orchestra.operation.v2",
          operationId,
          projectId: project.projectId,
          workId: work.workId,
          generation: 0,
          kind: "DIRECT_MUTATION",
          actorRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          capabilities: ["WORKSPACE_EDIT"],
          workflowState: "RUNNING",
          liveness: "LIVE",
          startedAt,
          heartbeatAt: startedAt,
          deadlineAt,
          runtimeOwnerRef,
          workspaceRef: "workspace:provider-event-expired",
          resultRef: null,
        },
      }).ok, true);
    } finally {
      state.close();
    }

    const ownerStore = createRuntimeOwnerStore({ rootDir: join(fx.home, "runtime-owners") });
    assert.equal((await ownerStore.register({
      schema: "orchestra.runtime-owner.v2",
      runtimeOwnerId: runtimeOwnerRef,
      operationId,
      kind: "PROVIDER_EVENT",
      registeredAt: startedAt,
      correlationRef: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      startedAt,
      lastProviderEventAt: startedAt,
      deadlineAt,
    })).ok, true);

    const status = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: ["project", "status", project.projectId],
    });
    assert.equal(status.status, 0);
    const entry = status.json.reconciliation.operations.find((item) => item.operation.operationId === operationId);
    assert.equal(entry.assessment.liveness, "STALE_RECOVERABLE");
    assert.equal(entry.actionRequired, "PROVE_WORKSPACE_IDENTITY");
    assert.equal(entry.humanGateRequired, true);
    assert.equal(entry.operation.workflowState, "RUNNING");
    assert.equal(entry.operation.liveness, "LIVE");
    assert.notEqual(entry.operation.workflowState, "SUCCEEDED", "deadline expiry never terminalizes as success");
  } finally {
    await fx.cleanup();
  }
});
