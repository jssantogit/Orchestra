import test from "node:test";
import assert from "node:assert/strict";

import { composeParallelArtifacts } from "../../runtime/delegation/composite-artifact-lifecycle.mjs";

function packet(taskId, generation, file) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: `edit ${file}`,
    direction: { change: `change ${file}`, preserve: ["other shard"] },
    anchors: [{ file }],
    scope: { allowedAreas: [file], forbidden: [] },
    permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: [] },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function group() {
  const taskId = "task-orphan";
  const generation = 11;
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "group-orphan",
    taskId,
    generation,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    members: [
      {
        memberId: "a",
        targetProvider: "codex",
        packet: packet(taskId, generation, "home.txt"),
        mutationScope: { allowedPaths: ["home.txt"], forbiddenPaths: [] },
      },
      {
        memberId: "b",
        targetProvider: "antigravity",
        packet: packet(taskId, generation, "library.txt"),
        mutationScope: { allowedPaths: ["library.txt"], forbiddenPaths: [] },
      },
    ],
  };
}

function manifest(g, artifactId, memberId, provider, path) {
  return {
    artifactId,
    parallelGroupId: g.groupId,
    parallelMemberId: memberId,
    taskId: g.taskId,
    generation: g.generation,
    source: { ...g.source },
    target: { provider, logicalRole: "IMPLEMENTER" },
    sourceRevision: g.sourceRevision,
    sourceFingerprint: g.sourceFingerprint,
    canonicalGitFingerprint: g.canonicalGitFingerprint,
    delegatedPath: `/tmp/${artifactId}/workspace`,
    changedPaths: [path],
    state: "READY_FOR_REVIEW",
  };
}

test("a failed post-seal member consumption aborts the composite so no orphan READY artifact remains", async () => {
  const g = group();
  const manifests = new Map([
    ["artifact-a", manifest(g, "artifact-a", "a", "codex", "home.txt")],
    ["artifact-b", manifest(g, "artifact-b", "b", "antigravity", "library.txt")],
  ]);
  const aborts = [];
  const transitions = [];

  const result = await composeParallelArtifacts({
    repoRoot: "/repo",
    group: g,
    memberArtifactIds: ["artifact-a", "artifact-b"],
  }, {
    groups: {
      read: () => ({
        exists: true,
        valid: true,
        record: {
          group: g,
          state: "MEMBERS_READY",
          memberArtifactIds: ["artifact-a", "artifact-b"],
          compositeArtifactId: null,
        },
      }),
      transition: (_root, _groupId, transition) => {
        transitions.push(transition);
        return { transitioned: true, reason: null };
      },
      cleanup: () => ({ updated: true, reason: null }),
    },
    artifacts: {
      read: (_root, artifactId) => ({
        exists: true,
        valid: true,
        manifest: manifests.get(artifactId),
        patch: Buffer.from("patch"),
      }),
      inspect: async ({ artifactId }) => ({
        manifest: manifests.get(artifactId),
        integrity: { valid: true, reason: null },
      }),
      consume: async ({ artifactId }) => artifactId === "artifact-b"
        ? { consumed: false, reason: "ARTIFACT_STATE_MISMATCH", cleanup: null }
        : { consumed: true, reason: null, cleanup: { cleaned: true, reason: null } },
    },
    composition: {
      compose: async () => ({
        artifactId: "composite-orphan",
        patchSha256: "sha256:patch",
        mutationDigest: "sha256:mutation",
        changedPaths: ["home.txt", "library.txt"],
        state: "READY_FOR_REVIEW",
        reviewPath: "/tmp/composite-orphan/workspace",
      }),
      abort: async ({ artifactId, reviewPath }) => {
        aborts.push({ artifactId, reviewPath });
        return { discarded: true, cleanup: { cleaned: true, reason: null } };
      },
    },
  });

  assert.deepEqual(result, { composed: false, reason: "COMPOSITION_FAILED", artifactId: null });
  assert.deepEqual(aborts, [{
    artifactId: "composite-orphan",
    reviewPath: "/tmp/composite-orphan/workspace",
  }]);
  assert.equal(transitions.at(-1).nextState, "FAILED");
});
