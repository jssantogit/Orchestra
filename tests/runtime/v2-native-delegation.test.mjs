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
const now = "2026-10-20T12:00:00.000Z";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
async function setup(t) {
  const { createSqliteState } = await import("../../v2/persistence/sqlite/sqlite-state.mjs");
  const home = mkdtempSync(join(tmpdir(), "orchestra-v2-delegation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repoRoot = join(home, "repository");
  mkdirSync(repoRoot);
  git(repoRoot, "init");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Orchestra Test");
  writeFileSync(join(repoRoot, "tracked.txt"), "canonical\n");
  git(repoRoot, "add", "tracked.txt");
  git(repoRoot, "commit", "-m", "init");
  const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
  t.after(() => state.close());
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
    observedAt: now,
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
    async discover() { return { provider: "antigravity", available, capabilities: { implementation: true } }; },
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
    now: () => now, ...overrides,
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
            observedAt: "2026-10-20T12:00:01.000Z",
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
