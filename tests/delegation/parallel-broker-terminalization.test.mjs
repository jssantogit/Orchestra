import test from "node:test";
import assert from "node:assert/strict";

import { executeParallelImplementationGroup } from '../helpers/resource-governor.mjs';

function packet(area) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "terminalization-task",
    candidateGeneration: 6,
    goal: `implement ${area}`,
    direction: { change: `change ${area}`, preserve: ["other shard"] },
    anchors: [{ file: area.replace(/\/\*\*$/, "/entry.mjs") }],
    scope: { allowedAreas: [area], forbidden: [] },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
    },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function group() {
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "terminalization-group",
    taskId: "terminalization-task",
    generation: 6,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:product",
    canonicalGitFingerprint: "sha256:git",
    members: [
      {
        memberId: "local",
        targetProvider: "codex",
        packet: packet("src/a/**"),
        mutationScope: { allowedPaths: ["src/a/**"], forbiddenPaths: [] },
      },
      {
        memberId: "external",
        targetProvider: "antigravity",
        packet: packet("src/b/**"),
        mutationScope: { allowedPaths: ["src/b/**"], forbiddenPaths: [] },
      },
    ],
  };
}

function executor(provider) {
  return {
    provider,
    discover: async () => ({ available: true, provider, capabilities: { implementation: true } }),
    execute: async () => ({
      ok: true,
      provider,
      report: { summary: "done", findings: [], evidenceRefs: [] },
      execution: { exitCode: 0, durationMs: 1 },
    }),
  };
}

test("sealed members are discarded and RUNNING group is closed when MEMBERS_READY transition fails", async () => {
  const value = group();
  let prepared = 0;
  const cleaned = [];
  const discarded = [];
  const transitions = [];

  const result = await executeParallelImplementationGroup({
    repoRoot: "/repo",
    group: value,
    actor: { provider: "codex", actorIdHash: "sha256:root", actorKind: "ROOT", isRoot: true },
    executors: [executor("codex"), executor("antigravity")],
  }, {
    readLease: () => ({
      exists: true,
      valid: true,
      lease: {
        taskId: value.taskId,
        generation: value.generation,
        actor: { provider: "codex", sessionIdHash: "sha256:root" },
        capabilities: ["CONTROL"],
      },
    }),
    source: {
      readProduct: () => ({
        available: true,
        head: value.sourceRevision,
        fingerprint: value.sourceFingerprint,
      }),
      readGitBoundary: async () => ({ available: true, fingerprint: value.canonicalGitFingerprint }),
    },
    workspace: {
      prepare: async ({ request }) => {
        prepared += 1;
        return {
          repoRoot: "/repo",
          path: `/tmp/orchestra-implementation-terminal-${prepared}/workspace`,
          sourceRevision: request.workspace.sourceRevision,
          sourceFingerprint: request.workspace.sourceFingerprint,
          syntheticBaselineSha: `synthetic-${prepared}`,
          syntheticBaselineTree: "tree:shared",
          canonicalGitFingerprint: value.canonicalGitFingerprint,
          cloneGitFingerprint: `sha256:clone-${prepared}`,
          workerGitEnv: {},
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
      cleanup: async (workspace) => {
        cleaned.push(workspace.path);
        return { cleaned: true, reason: null };
      },
    },
    artifacts: {
      seal: async ({ parallelBinding }) => ({
        artifactId: `artifact-${parallelBinding.memberId}`,
        changedPaths: [],
        patchSha256: `sha256:${parallelBinding.memberId}`,
        mutationDigest: `sha256:${parallelBinding.memberId}`,
        state: "READY_FOR_REVIEW",
      }),
      discardBound: async ({ artifactId }) => {
        discarded.push(artifactId);
        return { discarded: true, reason: null };
      },
      recordCleanup: () => ({ updated: true, reason: null }),
    },
    groups: {
      create: () => ({ state: "CREATED" }),
      transition: (_repoRoot, _groupId, transition) => {
        transitions.push(transition.nextState);
        if (transition.nextState === "MEMBERS_READY") {
          return { transitioned: false, reason: "PARALLEL_GROUP_STATE_MISMATCH" };
        }
        return { transitioned: true, reason: null, record: { state: transition.nextState } };
      },
      cleanup: () => ({ updated: true, reason: null }),
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "PARALLEL_GROUP_STATE_INVALID");
  assert.deepEqual(discarded.sort(), ["artifact-external", "artifact-local"]);
  assert.equal(cleaned.length, 2);
  assert.deepEqual(transitions, ["RUNNING", "MEMBERS_READY", "FAILED"]);
});
