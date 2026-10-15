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
  const taskId = "task-lifecycle";
  const generation = 9;
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "group-lifecycle",
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
    schema: "orchestra.delegation-artifact.v1",
    artifactId,
    delegationId: artifactId,
    taskId: g.taskId,
    generation: g.generation,
    source: { ...g.source },
    target: { provider, logicalRole: "IMPLEMENTER" },
    sourceRevision: g.sourceRevision,
    sourceFingerprint: g.sourceFingerprint,
    canonicalGitFingerprint: g.canonicalGitFingerprint,
    delegatedPath: `/tmp/${artifactId}/workspace`,
    syntheticBaselineSha: "synthetic",
    mutationScope: { allowedPaths: [path], forbiddenPaths: [".git/**", ".orchestra/state/**"] },
    changedPaths: [path],
    patchSha256: `sha256:${artifactId}`,
    mutationDigest: `sha256:${memberId}`,
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T14:30:00.000Z",
    parallelGroupId: g.groupId,
    parallelMemberId: memberId,
  };
}

function services({ consumeFailure = null } = {}) {
  const g = group();
  const artifacts = new Map([
    ["artifact-a", manifest(g, "artifact-a", "a", "codex", "home.txt")],
    ["artifact-b", manifest(g, "artifact-b", "b", "antigravity", "library.txt")],
  ]);
  const transitions = [];
  const consumed = [];
  return {
    g,
    transitions,
    consumed,
    overrides: {
      groups: {
        read() {
          return {
            exists: true,
            valid: true,
            record: {
              group: g,
              state: "MEMBERS_READY",
              memberArtifactIds: ["artifact-a", "artifact-b"],
            },
          };
        },
        transition(_repoRoot, _groupId, transition) {
          transitions.push({ ...transition });
          return { transitioned: true, reason: null };
        },
        cleanup() { return { updated: true, reason: null }; },
      },
      artifacts: {
        read(_repoRoot, artifactId) {
          const value = artifacts.get(artifactId);
          return { exists: true, valid: true, manifest: value, patch: Buffer.from("patch"), path: `/state/${artifactId}` };
        },
        async inspect({ artifactId }) {
          return { manifest: artifacts.get(artifactId), integrity: { valid: true, reason: null } };
        },
        async consume({ artifactId }) {
          consumed.push(artifactId);
          if (artifactId === consumeFailure) return { consumed: false, reason: "ARTIFACT_STATE_MISMATCH", cleanup: null };
          return { consumed: true, reason: null, cleanup: { cleaned: true, reason: null } };
        },
      },
      composition: {
        async compose() {
          return {
            artifactId: "composite-lifecycle",
            changedPaths: ["home.txt", "library.txt"],
            patchSha256: "sha256:composite",
            mutationDigest: "sha256:combined",
            state: "READY_FOR_REVIEW",
            reviewPath: "/tmp/composite/workspace",
          };
        },
      },
    },
  };
}

test("successful composition advances group state and consumes both member artifacts only after composite seal", async () => {
  const fixture = services();
  const result = await composeParallelArtifacts({
    repoRoot: "/tmp/repo",
    group: fixture.g,
    memberArtifactIds: ["artifact-a", "artifact-b"],
  }, fixture.overrides);

  assert.equal(result.composed, true);
  assert.equal(result.reason, null);
  assert.equal(result.artifactId, "composite-lifecycle");
  assert.deepEqual(fixture.consumed, ["artifact-a", "artifact-b"]);
  assert.deepEqual(fixture.transitions, [
    {
      expectedState: "MEMBERS_READY",
      nextState: "COMPOSING",
      memberArtifactIds: ["artifact-a", "artifact-b"],
    },
    {
      expectedState: "COMPOSING",
      nextState: "READY_FOR_REVIEW",
      memberArtifactIds: ["artifact-a", "artifact-b"],
      compositeArtifactId: "composite-lifecycle",
    },
  ]);
});

test("member consumption failure closes the composing group instead of exposing partial review state", async () => {
  const fixture = services({ consumeFailure: "artifact-b" });
  const result = await composeParallelArtifacts({
    repoRoot: "/tmp/repo",
    group: fixture.g,
    memberArtifactIds: ["artifact-a", "artifact-b"],
  }, fixture.overrides);

  assert.deepEqual(result, { composed: false, reason: "COMPOSITION_FAILED", artifactId: null });
  assert.deepEqual(fixture.transitions, [
    {
      expectedState: "MEMBERS_READY",
      nextState: "COMPOSING",
      memberArtifactIds: ["artifact-a", "artifact-b"],
    },
    {
      expectedState: "COMPOSING",
      nextState: "FAILED",
      memberArtifactIds: ["artifact-a", "artifact-b"],
      failureReason: "COMPOSITION_FAILED",
    },
  ]);
});
