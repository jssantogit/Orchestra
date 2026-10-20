import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { createBlobStore } from "../../v2/persistence/blob-store.mjs";
import { executeNativeDelegatedWork } from "../../runtime/delegation/v2-native-execution.mjs";

const supported = Number(process.versions.node.split(".")[0]) >= 22;
const ACTOR = "sha256:" + "a".repeat(64);
// Real journal elapsed time must remain non-negative regardless of CI clock.
const now = () => new Date(Date.now() - 1_000).toISOString();
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
async function setup(t) {
  const { createSqliteState } = await import("../../v2/persistence/sqlite/sqlite-state.mjs");
  const home = mkdtempSync(join(tmpdir(), "orchestra-v2-delegation-"));
  const repoRoot = join(home, "repository");
  mkdirSync(repoRoot);
  git(repoRoot, "init");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Orchestra Test");
  writeFileSync(join(repoRoot, ".gitignore"), ".orchestra/state/\n");
  writeFileSync(join(repoRoot, "tracked.txt"), "canonical\n");
  git(repoRoot, "add", "tracked.txt");
  git(repoRoot, "commit", "-m", "init");
  const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
  t.after(() => {
    // Windows holds an open SQLite file lock until state.close().
    state.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  });
  const projectId = "project-native", workId = "work-native", generation = 1;
  const project = {
    schema: "orchestra.project.v2", projectId, lineageId: "lineage-native",
    workspace: { canonicalRoot: repoRoot, vcs: "git" },
    runtime: { pinnedImage: "sha256:exact-image", instructionEpoch: 0 },
    trust: { mode: "trusted" },
  };
  assert.equal(state.projects.register(project).ok, true);
  assert.equal(state.work.startCurrent({
    schema: "orchestra.work-unit.v2", workId, projectId, taskId: "task-native",
    generation, runtimeImage: project.runtime.pinnedImage, instructionEpoch: 0,
    state: "INTAKE", scopeRef: null, directionRef: null, candidateRef: null,
    evidenceRefs: [], blockers: [], continuationRef: null,
  }).ok, true);
  assert.equal(state.sessionObservations.put({
    provider: "codex", projectId, actorIdHash: ACTOR,
    observedInstructionEpoch: 0, observedWorkId: workId, observedGeneration: generation,
    observedAt: now(),
  }).ok, true);
  const source = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  const request = {
    schema: "orchestra.delegation-request.v2", delegationId: "v2-delegation-native",
    taskId: "task-native",
    source: { provider: "codex", actorIdHash: ACTOR },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1", taskId: "task-native",
      candidateGeneration: generation,
      goal: "edit tracked.txt within an isolated delegated workspace",
      direction: { change: "edit tracked.txt", preserve: ["canonical checkout"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS",
        sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"] },
      validation: ["tracked.txt updated"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: { capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY", network: "FORBIDDEN", mayDelegate: false },
    workspace: {
      sourceFingerprint: source.fingerprint, sourceRevision: source.head,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: { allowedPaths: ["tracked.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 30_000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
  return { state, registry: { state, paths: { home }, blobs: createBlobStore({ root: join(home, "blobs") }) },
    repoRoot, request, projectId, workId, generation };
}
function executor(handler, { available = true } = {}) {
  return {
    provider: "antigravity",
    async discover() { return { provider: "antigravity", available, version: "agy-test", capabilities: { implementation: true } }; },
    async execute({ workspace }) {
      await handler?.(workspace.path);
      return { ok: true, provider: "antigravity",
        report: { summary: "Changed target", findings: [], evidenceRefs: [] },
        execution: { exitCode: 0, durationMs: 30 } };
    },
  };
}
function command(ctx, worker, overrides = {}) {
  return executeNativeDelegatedWork({
    registry: ctx.registry, projectId: ctx.projectId, workId: ctx.workId,
    generation: ctx.generation, actor: { provider: "codex", actorIdHash: ACTOR },
    request: ctx.request, executor: worker,
    now, ...overrides,
  });
}

test("delegated V2 executes in isolated clone and binds sealed mutation bytes to Home/global Operation", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  const result = await command(ctx, executor(async path => {
    assert.notEqual(path, ctx.repoRoot);
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
    assert.equal(readFileSync(join(ctx.repoRoot, "tracked.txt"), "utf8"), "canonical\n");
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.route, "DELEGATED");
  assert.equal(result.state, "SUCCEEDED");
  assert.equal(result.artifactRef.startsWith("sha256:"), true);
  const payload = JSON.parse((await ctx.registry.blobs.read(result.artifactRef)).toString("utf8"));
  assert.equal(payload.schema, "orchestra.v2-delegation-candidate.v1");
  assert.equal(payload.projectId, ctx.projectId);
  assert.equal(payload.workId, ctx.workId);
  assert.equal(payload.files[0].bytesBase64, Buffer.from("delegated\n").toString("base64"));
  assert.equal(ctx.state.operations.inspect(result.operationId).workflowState, "SUCCEEDED");
  assert.equal(ctx.state.operations.inspect(result.operationId).resultRef, "delegation-artifact:" + result.artifactRef);
  assert.equal(readFileSync(join(ctx.repoRoot, "tracked.txt"), "utf8"), "canonical\n");
  assert.equal(existsSync(join(ctx.repoRoot, ".orchestra", "state", "delegations")), false);
});

test("stale global session and forbidden mutation both fail closed", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  let calls = 0;
  const worker = executor(async path => { calls++; writeFileSync(join(path, "tracked.txt"), "changed\n"); });
  const stale = await command(ctx, worker, { generation: 2 });
  assert.equal(stale.ok, false);
  assert.equal(calls, 0);
  const forbidden = await command(ctx, worker, {
    request: { ...ctx.request, workspace: {
      ...ctx.request.workspace, mutationScope: { allowedPaths: ["other.txt"], forbiddenPaths: [] },
    } },
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "NATIVE_DELEGATION_SCOPE_VIOLATION");
  assert.equal(readFileSync(join(ctx.repoRoot, "tracked.txt"), "utf8"), "canonical\n");
  assert.equal(ctx.state.operations.listLive({ projectId: ctx.projectId }).length, 0);
});

test("revoked provider session after the Operation begins cannot execute the worker", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  let ran = false;
  const original = ctx.state.operations;
  const state = {
    ...ctx.state,
    operations: {
      ...original,
      begin(input) {
        const begun = original.begin(input);
        if (begun.ok) {
          const denied = ctx.state.sessionObservations.put({
            provider: "codex", projectId: ctx.projectId, actorIdHash: ACTOR,
            observedInstructionEpoch: 0, observedWorkId: null, observedGeneration: null,
            observedAt: new Date(Date.now() + 60_000).toISOString(),
          });
          assert.equal(denied.ok, true);
        }
        return begun;
      },
    },
  };
  const denied = await command(ctx, executor(async () => { ran = true; }), {
    registry: { ...ctx.registry, state },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "NATIVE_DELEGATION_OPERATION_STALE");
  assert.equal(ran, false);
  assert.equal(ctx.state.operations.listLive({ projectId: ctx.projectId }).length, 0);
});

test("ignored forbidden worker files cannot disappear from mutation inspection", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  const result = await command(ctx, executor(async path => {
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
    mkdirSync(join(path, ".orchestra", "state"), { recursive: true });
    writeFileSync(join(path, ".orchestra", "state", "shadow.json"), "forbidden\n");
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "NATIVE_DELEGATION_BOUNDARY_VIOLATION");
  assert.equal(readFileSync(join(ctx.repoRoot, "tracked.txt"), "utf8"), "canonical\n");
  assert.equal(ctx.state.operations.listLive({ projectId: ctx.projectId }).length, 0);
});

test("delegated success is re-derived from Home journal, terminal Operation and exact blob after reopen", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  const result = await command(ctx, executor(async path => {
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const original = ctx.state.nativeRsi.listObserved({ runtimeImageId: "sha256:exact-image" });
  assert.equal(original.length, 1);
  assert.equal(original[0].source.operationId, result.operationId);
  assert.deepEqual(original[0].decision, {
    immutableRoutes: ["DIRECT_WORK", "DELEGATED"],
    legalRoutes: ["DIRECT_WORK", "DELEGATED"],
    selectedRoute: "DELEGATED",
  });
  assert.equal(original[0].outcome.success, true);
  assert.match(original[0].evidence.choiceRef, /^sha256:[a-f0-9]{64}$/);
  assert.match(original[0].evidence.outcomeRef, /^sha256:[a-f0-9]{64}$/);
  ctx.state.close();
  const { createSqliteState } = await import("../../v2/persistence/sqlite/sqlite-state.mjs");
  const reopened = createSqliteState({ dbPath: join(ctx.registry.paths.home, "state", "orchestra.db") });
  try {
    assert.deepEqual(reopened.nativeRsi.listObserved({ runtimeImageId: "sha256:exact-image" }), original);
  } finally {
    reopened.close();
  }
});

test("tampered delegated artifact bytes invalidate its native outcome receipt", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  const result = await command(ctx, executor(async path => {
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
  }));
  assert.equal(result.ok, true);
  assert.equal(ctx.state.nativeRsi.listObserved().length, 1);
  writeFileSync(ctx.registry.blobs.pathFor(result.artifactRef), "tampered");
  assert.equal(ctx.state.nativeRsi.listObserved().length, 0);
});

test("delegated RSI journal rejects caller-authored decisions without native Operation", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  const attempt = ctx.state.nativeRsi.recordDelegatedDecision({
    operationId: "op-unregistered", sourceProvider: "codex",
    targetProvider: "antigravity", providerVersion: "untrusted",
  });
  assert.equal(attempt.ok, false);
  assert.deepEqual(ctx.state.nativeRsi.listObserved(), []);
});

test("corrupt native terminal journal reports an unverified receipt instead of leaking an exception or claiming readiness", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  const wrapped = {
    ...ctx.state,
    nativeRsi: {
      ...ctx.state.nativeRsi,
      recordDelegatedTerminal() { throw new Error("corrupt journal"); },
    },
  };
  const result = await command(ctx, executor(async path => {
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
  }), { registry: { ...ctx.registry, state: wrapped } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NATIVE_DELEGATION_TERMINAL_RECEIPT_UNVERIFIED");
  assert.deepEqual(ctx.state.nativeRsi.listObserved(), []);
});


test("retry after successful delegated Work is at-most-once even after state reopen", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  let executions = 0;
  const worker = executor(async path => {
    executions++;
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
  });
  const first = await command(ctx, worker);
  assert.equal(first.ok, true, JSON.stringify(first));
  const { createSqliteState } = await import("../../v2/persistence/sqlite/sqlite-state.mjs");
  const reopened = createSqliteState({ dbPath: join(ctx.registry.paths.home, "state", "orchestra.db") });
  let second;
  try {
    second = await command(ctx, worker, {
      registry: { ...ctx.registry, state: reopened },
      now: () => new Date(Date.now()).toISOString(),
    });
  } finally {
    reopened.close();
  }
  assert.equal(second.ok, false);
  assert.equal(second.code, "NATIVE_DELEGATION_ALREADY_RECORDED");
  assert.equal(executions, 1);
  assert.equal(ctx.state.nativeRsi.listObserved().length, 1);
  assert.equal(ctx.state.operations.inspect(first.operationId).workflowState, "SUCCEEDED");
});

test("retry of a failed delegated Work is blocked until explicit reconciled new generation", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  let executions = 0;
  const worker = executor(async () => { executions++; throw new Error("worker failure"); });
  const first = await command(ctx, worker);
  assert.equal(first.ok, false);
  assert.equal(first.code, "NATIVE_DELEGATION_WORKER_FAILED");
  const repeated = await command(ctx, worker);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.code, "NATIVE_DELEGATION_ALREADY_RECORDED");
  assert.equal(executions, 1);
  assert.equal(ctx.state.operations.listLive({ projectId: ctx.projectId }).length, 0);
  assert.deepEqual(ctx.state.nativeRsi.listObserved(), []);
});

test("same delegation ID with modified payload cannot bypass at-most-once fence", { skip: !supported }, async (t) => {
  const ctx = await setup(t);
  let executions = 0;
  const worker = executor(async path => {
    executions++;
    writeFileSync(join(path, "tracked.txt"), "delegated\n");
  });
  assert.equal((await command(ctx, worker)).ok, true);
  const tampered = {
    ...ctx.request,
    packet: { ...ctx.request.packet, goal: "a different instruction" },
  };
  const second = await command(ctx, worker, { request: tampered });
  assert.equal(second.ok, false);
  assert.equal(second.code, "NATIVE_DELEGATION_ALREADY_RECORDED");
  assert.equal(executions, 1);
});


test("delegated LIVE Operation persists an OS birth-bound owner and accepts matching birth proof", { skip: !supported || process.platform === "darwin" }, async (t) => {
  const ctx = await setup(t);
  let owner;
  const result = await command(ctx, executor(async path => {
    const op = ctx.state.operations.listLive({ projectId: ctx.projectId })[0];
    assert.equal(op?.kind, "DELEGATED_MUTATION");
    assert.equal(typeof op.runtimeOwnerRef, "string");
    assert.ok(op.runtimeOwnerRef);
    const { createRuntimeOwnerStore } = await import("../../v2/liveness/runtime-owner-store.mjs");
    const store = createRuntimeOwnerStore({ rootDir: join(ctx.registry.paths.home, "runtime-owners") });
    owner = await store.read(op.runtimeOwnerRef);
    assert.equal(owner.operationId, op.operationId);
    assert.equal(owner.kind, "LOCAL_PROCESS");
    assert.equal(owner.process.pid, process.pid);
    assert.match(owner.proof.tokenHash, /^sha256:[a-f0-9]{64}$/);
    const { createLocalProcessOwnerProbe } =
      await import("../../v2/liveness/local-process-probe.mjs");
    const { createOperationLivenessService } =
      await import("../../v2/liveness/operation-liveness-service.mjs");
    // The owner was registered from a real OS process identity. Re-probe
    // semantics use a deterministic matching observation; on Windows a
    // separate PowerShell probe can legitimately be temporarily UNAVAILABLE.
    const service = createOperationLivenessService({
      runtimeOwnerStore: store,
      ownerProbe: createLocalProcessOwnerProbe({
        readProcessIdentity: async (pid) => {
          assert.equal(pid, process.pid);
          return { status: "PRESENT", processIdentity: owner.process.startIdentity };
        },
      }),
    });
    const assessment = await service.assess(op);
    assert.equal(assessment.liveness, "LIVE", JSON.stringify(assessment));
    assert.equal(assessment.reason, "OWNER_MATCH_HEARTBEAT_FRESH");
    writeFileSync(join(path, "tracked.txt"), "delegated\\n");
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(typeof owner.process.startIdentity, "string");
  assert.ok(owner.process.startIdentity.length > 0);
});
