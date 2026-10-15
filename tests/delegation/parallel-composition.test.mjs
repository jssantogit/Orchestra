import test from "node:test";
import assert from "node:assert/strict";

import { composeParallelArtifacts } from "../../runtime/delegation/composite-artifact-lifecycle.mjs";

function group() {
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "group-compose-1",
    taskId: "task-compose",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    members: [
      {
        memberId: "a",
        targetProvider: "codex",
        packet: {
          schema: "orchestra.implementation-packet.v1",
          taskId: "task-compose",
          candidateGeneration: 7,
          goal: "edit home",
          direction: { change: "change home", preserve: ["library"] },
          anchors: [{ file: "app/home.txt" }],
          scope: { allowedAreas: ["app/home/**"], forbidden: [] },
          permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: [] },
          validation: ["focused tests"],
          failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
        },
        mutationScope: { allowedPaths: ["app/home/**"], forbiddenPaths: [] },
      },
      {
        memberId: "b",
        targetProvider: "antigravity",
        packet: {
          schema: "orchestra.implementation-packet.v1",
          taskId: "task-compose",
          candidateGeneration: 7,
          goal: "edit library",
          direction: { change: "change library", preserve: ["home"] },
          anchors: [{ file: "app/library.txt" }],
          scope: { allowedAreas: ["app/library/**"], forbidden: [] },
          permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: [] },
          validation: ["focused tests"],
          failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
        },
        mutationScope: { allowedPaths: ["app/library/**"], forbiddenPaths: [] },
      },
    ],
  };
}

function manifest(artifactId, changedPath) {
  return {
    artifactId,
    parallelGroupId: "group-compose-1",
    parallelMemberId: artifactId.endsWith("a") ? "a" : "b",
    taskId: "task-compose",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    delegatedPath: `/tmp/${artifactId}/workspace`,
    changedPaths: [changedPath],
    state: "READY_FOR_REVIEW",
  };
}

function artifactServices(paths = ["app/home/a.txt", "app/library/b.txt"]) {
  return {
    read: (_repoRoot, artifactId) => ({
      exists: true,
      valid: true,
      manifest: manifest(artifactId, artifactId.endsWith("a") ? paths[0] : paths[1]),
      patch: Buffer.from("patch"),
    }),
    inspect: async ({ artifactId }) => ({
      manifest: manifest(artifactId, artifactId.endsWith("a") ? paths[0] : paths[1]),
      integrity: { valid: true, reason: null },
    }),
  };
}

test("parallel composition is an explicit lifecycle operation", () => {
  assert.equal(typeof composeParallelArtifacts, "function");
});

test("parallel composition rejects factual changed-path overlap before applying patches", async () => {
  let prepared = false;
  const result = await composeParallelArtifacts({
    repoRoot: "/repo",
    group: group(),
    memberArtifactIds: ["artifact-a", "artifact-b"],
  }, {
    groups: {
      read: () => ({
        exists: true,
        valid: true,
        record: {
          group: group(),
          state: "MEMBERS_READY",
          memberArtifactIds: ["artifact-a", "artifact-b"],
          compositeArtifactId: null,
        },
      }),
    },
    artifacts: artifactServices(["shared.txt", "shared.txt"]),
    composition: {
      prepare: async () => { prepared = true; return {}; },
    },
  });

  assert.deepEqual(result, {
    composed: false,
    reason: "SCOPE_VIOLATION",
    artifactId: null,
  });
  assert.equal(prepared, false);
});

test("successful parallel composition atomically advances group, consumes members, and cleans member workspaces", async () => {
  const groupTransitions = [];
  const artifactTransitions = [];
  const cleaned = [];
  const baseArtifacts = artifactServices();

  const result = await composeParallelArtifacts({
    repoRoot: "/repo",
    group: group(),
    memberArtifactIds: ["artifact-a", "artifact-b"],
  }, {
    groups: {
      read: () => ({
        exists: true,
        valid: true,
        record: {
          group: group(),
          state: "MEMBERS_READY",
          memberArtifactIds: ["artifact-a", "artifact-b"],
          compositeArtifactId: null,
        },
      }),
      transition: (_repoRoot, groupId, transition) => {
        groupTransitions.push({ groupId, ...transition });
        return { transitioned: true, reason: null, record: { state: transition.nextState } };
      },
      recordCleanup: () => ({ updated: true, reason: null }),
    },
    artifacts: {
      ...baseArtifacts,
      transition: (_repoRoot, artifactId, transition) => {
        artifactTransitions.push({ artifactId, ...transition });
        return { transitioned: true, reason: null, manifest: { state: transition.nextState } };
      },
      recordCleanup: () => ({ updated: true, reason: null }),
      cleanup: async (_repoRoot, delegatedPath) => {
        cleaned.push(delegatedPath);
        return { cleaned: true, reason: null };
      },
    },
    composition: {
      compose: async () => ({
        artifactId: "composite-ready",
        patchSha256: "sha256:patch",
        mutationDigest: "sha256:mutation",
        changedPaths: ["app/home/a.txt", "app/library/b.txt"],
        state: "READY_FOR_REVIEW",
        reviewPath: "/tmp/composite/workspace",
      }),
    },
  });

  assert.equal(result.composed, true);
  assert.equal(result.artifactId, "composite-ready");
  assert.deepEqual(groupTransitions, [
    {
      groupId: "group-compose-1",
      expectedState: "MEMBERS_READY",
      nextState: "COMPOSING",
      memberArtifactIds: ["artifact-a", "artifact-b"],
    },
    {
      groupId: "group-compose-1",
      expectedState: "COMPOSING",
      nextState: "READY_FOR_REVIEW",
      memberArtifactIds: ["artifact-a", "artifact-b"],
      compositeArtifactId: "composite-ready",
    },
  ]);
  assert.deepEqual(artifactTransitions, [
    { artifactId: "artifact-a", expectedState: "READY_FOR_REVIEW", nextState: "CONSUMED" },
    { artifactId: "artifact-b", expectedState: "READY_FOR_REVIEW", nextState: "CONSUMED" },
  ]);
  assert.deepEqual(cleaned, ["/tmp/artifact-a/workspace", "/tmp/artifact-b/workspace"]);
});
