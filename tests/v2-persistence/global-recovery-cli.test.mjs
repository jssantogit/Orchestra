import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { resolveGlobalRegistryPaths } from "../../v2/global/project-registry.mjs";

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
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return {
    status: result.status,
    stdout,
    stderr,
    json: stdout ? JSON.parse(stdout) : (stderr ? JSON.parse(stderr) : null),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-global-recover-"));
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

async function seedStaleOperation({ fx, workspaceRef = null, withOwner = true, operationId = "op-global-recover" }) {
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
  const runtimeOwnerRef = withOwner ? `owner:${operationId}` : "owner:missing";
  const operation = {
    schema: "orchestra.operation.v2",
    operationId,
    projectId: project.projectId,
    workId: work.workId,
    generation: 0,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:global-recovery-test",
    capabilities: workspaceRef === null ? [] : ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    deadlineAt: "2000-01-01T00:01:00.000Z",
    runtimeOwnerRef,
    workspaceRef,
    resultRef: null,
  };

  const { statePath } = resolveGlobalRegistryPaths({ home: fx.home });
  const state = createSqliteState({ dbPath: statePath });
  assert.equal(state.work.startCurrent(work).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation }).ok, true);
  state.close();

  if (withOwner) {
    const owners = createRuntimeOwnerStore({ rootDir: join(fx.home, "runtime-owners") });
    const ownerResult = await owners.register({
      schema: "orchestra.runtime-owner.v2",
      runtimeOwnerId: runtimeOwnerRef,
      operationId,
      kind: "LOCAL_PROCESS",
      process: { pid: 2147483647, startIdentity: "dead-process:fixture" },
      proof: { tokenHash: `sha256:${"a".repeat(64)}` },
      registeredAt: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(ownerResult.ok, true);
  }

  return { project, work, operation };
}

test("global project recover terminalizes a factually stale operation with no workspace and replays by command id", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedStaleOperation({ fx });
    const args = [
      "project", "recover",
      seeded.project.projectId,
      seeded.operation.operationId,
      "--command-id", "recover-cli-1",
    ];

    const first = runCli({ home: fx.home, cwd: fx.repo, args });
    assert.equal(first.status, 0);
    assert.equal(first.stderr, "");
    assert.equal(first.json.ok, true);
    assert.equal(first.json.recovered, true);
    assert.equal(first.json.replayed, false);
    assert.equal(first.json.operation.liveness, "TERMINAL");
    assert.equal(first.json.operation.workflowState, "ABORTED");
    assert.equal(first.json.cleanup.status, "NOT_REQUIRED");

    const replay = runCli({ home: fx.home, cwd: fx.repo, args });
    assert.equal(replay.status, 0);
    assert.equal(replay.json.ok, true);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.operation.resultRef, first.json.operation.resultRef);
  } finally {
    await fx.cleanup();
  }
});

test("global project recover fails closed for a stale workspace-backed operation until workspace identity is recoverable", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedStaleOperation({ fx, workspaceRef: "workspace:unresolved" });
    const result = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "project", "recover",
        seeded.project.projectId,
        seeded.operation.operationId,
        "--command-id", "recover-cli-workspace",
      ],
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.json.ok, false);
    assert.equal(result.json.reason, "RECOVERY_WORKSPACE_UNKNOWN");
    assert.equal(result.json.humanGate, true);

    const { statePath } = resolveGlobalRegistryPaths({ home: fx.home });
    const state = createSqliteState({ dbPath: statePath });
    assert.equal(state.operations.inspect(seeded.operation.operationId).liveness, "LIVE");
    state.close();
  } finally {
    await fx.cleanup();
  }
});

test("global project recover does not convert missing factual owner proof into stale recovery", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedStaleOperation({ fx, withOwner: false });
    const result = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: [
        "project", "recover",
        seeded.project.projectId,
        seeded.operation.operationId,
        "--command-id", "recover-cli-unknown",
      ],
    });

    assert.equal(result.status, 1);
    assert.equal(result.json.reason, "OPERATION_LIVENESS_UNKNOWN");
    assert.equal(result.json.livenessReason, "RUNTIME_OWNER_MISSING");
    assert.equal(result.json.humanGate, true);
  } finally {
    await fx.cleanup();
  }
});

test("global project recover requires an explicit idempotency command id", async () => {
  const fx = await fixture();
  try {
    const seeded = await seedStaleOperation({ fx });
    const result = runCli({
      home: fx.home,
      cwd: fx.repo,
      args: ["project", "recover", seeded.project.projectId, seeded.operation.operationId],
    });

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, "ORCHESTRA_V2_CLI_USAGE");
  } finally {
    await fx.cleanup();
  }
});
