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
  const local = artifactId.endsWith("a");
  return {
    artifactId,
    parallelGroupId: "group-compose-1",
    parallelMemberId: local ? "a" : "b",
    taskId: "task-compose",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    target: { provider: local ? "codex" : "antigravity", logicalRole: "IMPLEMENTER" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    changedPaths: [changedPath],
    state: "READY_FOR_REVIEW",
  };
}

function artifactServices(paths) {
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

test("parallel composition rejects factual changed-path overlap before composition starts", async () => {
  let compositionStarted = false;
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
      compose: async () => {
        compositionStarted = true;
        throw new Error("must not run");
      },
    },
  });

  assert.deepEqual(result, {
    composed: false,
    reason: "SCOPE_VIOLATION",
    artifactId: null,
  });
  assert.equal(compositionStarted, false);
});
