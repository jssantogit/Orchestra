import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeParallelImplementationGroup } from '../helpers/resource-governor.mjs';

function packet({ taskId = "parallel-task", generation = 4, area = "src/a/**" } = {}) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: "implement one bounded shard",
    direction: { change: "modify the assigned shard", preserve: ["public API"] },
    anchors: [{ file: area.replace(/\/\*\*$/, "/entry.mjs") }],
    scope: { allowedAreas: [area], forbidden: ["secrets/**"] },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
    },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function group({ sourceProvider = "codex" } = {}) {
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: `parallel-${sourceProvider}`,
    taskId: "parallel-task",
    generation: 4,
    source: { provider: sourceProvider, actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:product",
    canonicalGitFingerprint: "sha256:git",
    members: sourceProvider === "codex"
      ? [
        {
          memberId: "local",
          targetProvider: "codex",
          packet: packet({ area: "src/a/**" }),
          mutationScope: { allowedPaths: ["src/a/**"], forbiddenPaths: [] },
        },
        {
          memberId: "external",
          targetProvider: "antigravity",
          packet: packet({ area: "src/b/**" }),
          mutationScope: { allowedPaths: ["src/b/**"], forbiddenPaths: [] },
        },
      ]
      : [
        {
          memberId: "local",
          targetProvider: "antigravity",
          packet: packet({ area: "src/a/**" }),
          mutationScope: { allowedPaths: ["src/a/**"], forbiddenPaths: [] },
        },
        {
          memberId: "external",
          targetProvider: "codex",
          packet: packet({ area: "src/b/**" }),
          mutationScope: { allowedPaths: ["src/b/**"], forbiddenPaths: [] },
        },
      ],
  };
}

function actor(provider = "codex") {
  return { provider, actorIdHash: "sha256:root", actorKind: "ROOT", isRoot: true };
}

test('parallel resource pressure defers the entire group before clone or group mutation', async () => {
  const value = group();
  let calls = 0;
  const result = await executeParallelImplementationGroup({ repoRoot: '/repo', group: value, actor: actor(),
    resourceGovernor: { reserve: () => ({ ok: false, reason: 'RESOURCE_BUDGET_UNAVAILABLE' }) },
    executors: [successfulExecutor('codex', () => { calls++; }), successfulExecutor('antigravity', () => { calls++; })],
  }, { readLease: () => leaseFor(value), source: sourceServices(value), workspace: { ...fakeWorkspace(), prepare: async () => { calls++; } }, groups: { ...fakeGroups(), create: () => { calls++; } } });
  assert.equal(result.reason, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(calls, 0);
});

function leaseFor(value) {
  return {
    exists: true,
    valid: true,
    lease: {
      schema: "orchestra.work-lease.v1",
      projectLineage: "workspace-test",
      workspaceId: "primary",
      taskId: value.taskId,
      generation: value.generation,
      state: "CONTROL",
      actor: { provider: value.source.provider, sessionIdHash: value.source.actorIdHash },
      capabilities: ["CONTROL"],
      candidate: null,
    },
  };
}

function sourceServices(value) {
  return {
    readProduct: () => ({
      available: true,
      head: value.sourceRevision,
      fingerprint: value.sourceFingerprint,
      dirtyFileCount: 0,
    }),
    readGitBoundary: async () => ({ available: true, fingerprint: value.canonicalGitFingerprint }),
  };
}

function successfulExecutor(provider, onExecute = null) {
  return {
    provider,
    discover: async () => ({
      available: true,
      provider,
      capabilities: { implementation: true },
    }),
    execute: async (input) => {
      if (onExecute) await onExecute(input);
      return {
        ok: true,
        provider,
        report: { summary: `${provider} done`, findings: [], evidenceRefs: [] },
        execution: { exitCode: 0, durationMs: 10 },
      };
    },
  };
}

function fakeWorkspace() {
  let prepared = 0;
  const cleaned = [];
  return {
    cleaned,
    prepare: async ({ request }) => {
      prepared += 1;
      return {
        repoRoot: "/repo",
        path: `/tmp/orchestra-implementation-test-${prepared}/workspace`,
        sourceRevision: request.workspace.sourceRevision,
        sourceFingerprint: request.workspace.sourceFingerprint,
        syntheticBaselineSha: `synthetic-${prepared}`,
        syntheticBaselineTree: "tree:shared-source-snapshot",
        canonicalGitFingerprint: "sha256:git",
        cloneGitFingerprint: `sha256:clone-${prepared}`,
        workerGitEnv: {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: `/tmp/config-${prepared}`,
          GIT_TERMINAL_PROMPT: "0",
          GIT_PROTOCOL_FROM_USER: "0",
          GIT_ALLOW_PROTOCOL: "",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: `/tmp/hooks-${prepared}`,
          GIT_CONFIG_KEY_1: "protocol.allow",
          GIT_CONFIG_VALUE_1: "never",
        },
        cleanupToken: `cleanup-${prepared}`,
      };
    },
    inspect: async () => ({
      changedPaths: [],
      dirtyFileCount: 0,
      canonicalWorkspaceChanged: false,
      canonicalGitChanged: false,
      cloneGitChanged: false,
      stagedByWorker: false,
    }),
    cleanup: async (context) => {
      cleaned.push(context.path);
      return { cleaned: true, reason: null };
    },
  };
}

function fakeArtifacts({ failProvider = null } = {}) {
  const sealed = [];
  const discarded = [];
  return {
    sealed,
    discarded,
    seal: async ({ request, parallelBinding }) => {
      if (request.target.provider === failProvider) {
        const error = new Error("ARTIFACT_SEAL_FAILED");
        error.code = "ARTIFACT_SEAL_FAILED";
        throw error;
      }
      const artifact = {
        artifactId: `artifact-${parallelBinding.memberId}`,
        changedPaths: [],
        patchSha256: `sha256:${parallelBinding.memberId}`,
        mutationDigest: `sha256:${parallelBinding.memberId}`,
        state: "READY_FOR_REVIEW",
      };
      sealed.push({ request, parallelBinding, artifact });
      return artifact;
    },
    discardBound: async ({ artifactId, workspace }) => {
      discarded.push({ artifactId, path: workspace.path });
      return { discarded: true, cleanup: { cleaned: true, reason: null } };
    },
  };
}

function fakeGroups() {
  const transitions = [];
  return {
    transitions,
    create: (_repoRoot, value) => ({ group: value, state: "CREATED" }),
    transition: (_repoRoot, groupId, transition) => {
      transitions.push({ groupId, ...transition });
      return { transitioned: true, reason: null, record: { state: transition.nextState } };
    },
    cleanup: () => ({ updated: true, reason: null }),
  };
}

test("parallel broker starts both implementation executors before awaiting either", async () => {
  const value = group();
  const workspace = fakeWorkspace();
  const artifacts = fakeArtifacts();
  const groups = fakeGroups();
  const started = [];
  let releaseA;
  let releaseB;
  const barrierA = new Promise((resolve) => { releaseA = resolve; });
  const barrierB = new Promise((resolve) => { releaseB = resolve; });

  const executors = [
    successfulExecutor("codex", async ({ workspace: context }) => {
      started.push({ provider: "codex", context });
      await barrierA;
    }),
    successfulExecutor("antigravity", async ({ workspace: context }) => {
      started.push({ provider: "antigravity", context });
      await barrierB;
    }),
  ];

  const run = executeParallelImplementationGroup({
    repoRoot: "/repo",
    group: value,
    actor: actor(),
    executors,
  }, {
    readLease: () => leaseFor(value),
    source: sourceServices(value),
    workspace,
    artifacts,
    groups,
  });

  for (let i = 0; i < 50 && started.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(started.length, 2, "both workers must start before either result is awaited");
  assert.notEqual(started[0].context.path, started[1].context.path);
  assert.equal(started[0].context.sourceRevision, started[1].context.sourceRevision);
  assert.equal(started[0].context.sourceFingerprint, started[1].context.sourceFingerprint);
  assert.equal(started[0].context.syntheticBaselineTree, started[1].context.syntheticBaselineTree);

  releaseA();
  releaseB();
  const result = await run;
  assert.equal(result.status, "MEMBERS_READY");
  assert.deepEqual(result.members.map((member) => member.provider).sort(), ["antigravity", "codex"]);
  assert.deepEqual(result.members.map((member) => member.artifactId).sort(), ["artifact-external", "artifact-local"]);
  assert.equal(workspace.cleaned.length, 0, "successful member review clones remain retained");
  assert.deepEqual(groups.transitions.map((entry) => entry.nextState), ["RUNNING", "MEMBERS_READY"]);
});

test("parallel member authorization is provider-symmetric but remains group-bound", async () => {
  for (const sourceProvider of ["codex", "antigravity"]) {
    const value = group({ sourceProvider });
    const result = await executeParallelImplementationGroup({
      repoRoot: "/repo",
      group: value,
      actor: actor(sourceProvider),
      executors: [successfulExecutor("codex"), successfulExecutor("antigravity")],
    }, {
      readLease: () => leaseFor(value),
      source: sourceServices(value),
      workspace: fakeWorkspace(),
      artifacts: fakeArtifacts(),
      groups: fakeGroups(),
    });
    assert.equal(result.status, "MEMBERS_READY", sourceProvider);
    assert.deepEqual(new Set(result.members.map((member) => member.provider)), new Set(["codex", "antigravity"]));
  }
});

test("parallel broker rejects authority, baseline, or scope drift before worker execution", async () => {
  const value = group();
  let executions = 0;
  const executors = [
    successfulExecutor("codex", async () => { executions += 1; }),
    successfulExecutor("antigravity", async () => { executions += 1; }),
  ];

  const badLease = await executeParallelImplementationGroup({
    repoRoot: "/repo",
    group: value,
    actor: actor(),
    executors,
  }, {
    readLease: () => ({ ...leaseFor(value), lease: { ...leaseFor(value).lease, generation: 5 } }),
    source: sourceServices(value),
    workspace: fakeWorkspace(),
    artifacts: fakeArtifacts(),
    groups: fakeGroups(),
  });
  assert.equal(badLease.status, "FAILED");
  assert.equal(badLease.reason, "CAPABILITY_DENIED");

  const overlap = structuredClone(value);
  overlap.members[1].mutationScope.allowedPaths = ["src/a/sub/**"];
  overlap.members[1].packet.scope.allowedAreas = ["src/a/sub/**"];
  overlap.members[1].packet.anchors = [{ file: "src/a/sub/entry.mjs" }];
  const badScope = await executeParallelImplementationGroup({
    repoRoot: "/repo",
    group: overlap,
    actor: actor(),
    executors,
  }, {
    readLease: () => leaseFor(overlap),
    source: sourceServices(overlap),
    workspace: fakeWorkspace(),
    artifacts: fakeArtifacts(),
    groups: fakeGroups(),
  });
  assert.equal(badScope.status, "FAILED");
  assert.equal(badScope.reason, "SCOPE_VIOLATION");
  assert.equal(executions, 0);
});

test("one member failure fails the group, discards a sealed sibling, and cleans all clones", async () => {
  const value = group();
  const workspace = fakeWorkspace();
  const artifacts = fakeArtifacts({ failProvider: "antigravity" });
  const groups = fakeGroups();

  const result = await executeParallelImplementationGroup({
    repoRoot: "/repo",
    group: value,
    actor: actor(),
    executors: [successfulExecutor("codex"), successfulExecutor("antigravity")],
  }, {
    readLease: () => leaseFor(value),
    source: sourceServices(value),
    workspace,
    artifacts,
    groups,
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "ARTIFACT_SEAL_FAILED");
  assert.equal(result.compositeArtifact, undefined);
  assert.deepEqual(artifacts.discarded.map((entry) => entry.artifactId), ["artifact-local"]);
  assert.equal(workspace.cleaned.length, 2);
  assert.equal(groups.transitions.at(-1).nextState, "FAILED");
  assert.deepEqual(groups.transitions.at(-1).memberArtifactIds, ["artifact-local"]);
});

test("provider unavailability fails atomically before any clone is prepared", async () => {
  const value = group();
  const workspace = fakeWorkspace();
  let executions = 0;
  const unavailable = {
    provider: "antigravity",
    discover: async () => ({ available: false, provider: "antigravity", reason: "PROVIDER_UNAVAILABLE" }),
    execute: async () => { executions += 1; throw new Error("must not run"); },
  };
  const result = await executeParallelImplementationGroup({
    repoRoot: "/repo",
    group: value,
    actor: actor(),
    executors: [successfulExecutor("codex", async () => { executions += 1; }), unavailable],
  }, {
    readLease: () => leaseFor(value),
    source: sourceServices(value),
    workspace,
    artifacts: fakeArtifacts(),
    groups: fakeGroups(),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
  assert.equal(executions, 0);
  assert.equal(workspace.cleaned.length, 0);
});
