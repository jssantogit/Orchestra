import test from "node:test";
import assert from "node:assert/strict";

import * as parallelBroker from "../../runtime/delegation/parallel-broker.mjs";

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

test("parallel composition is an explicit broker operation", () => {
  assert.equal(typeof parallelBroker.composeParallelArtifacts, "function");
});

test("parallel composition rejects factual changed-path overlap before applying patches", async () => {
  assert.equal(typeof parallelBroker.composeParallelArtifacts, "function");

  let prepared = false;
  const result = await parallelBroker.composeParallelArtifacts({
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
      transition: () => ({ transitioned: true }),
    },
    artifacts: {
      read: (_repoRoot, artifactId) => ({
        exists: true,
        valid: true,
        manifest: {
          artifactId,
          parallelGroupId: "group-compose-1",
          parallelMemberId: artifactId.endsWith("a") ? "a" : "b",
          taskId: "task-compose",
          generation: 7,
          source: { provider: "codex", actorIdHash: "sha256:root" },
          sourceRevision: "abcdef1234567890",
          sourceFingerprint: "sha256:source",
          canonicalGitFingerprint: "sha256:git",
          changedPaths: ["shared.txt"],
          state: "READY_FOR_REVIEW",
        },
        patch: Buffer.from("patch"),
      }),
      inspect: async ({ artifactId }) => ({
        manifest: {
          artifactId,
          parallelGroupId: "group-compose-1",
          parallelMemberId: artifactId.endsWith("a") ? "a" : "b",
          taskId: "task-compose",
          generation: 7,
          source: { provider: "codex", actorIdHash: "sha256:root" },
          sourceRevision: "abcdef1234567890",
          sourceFingerprint: "sha256:source",
          canonicalGitFingerprint: "sha256:git",
          changedPaths: ["shared.txt"],
          state: "READY_FOR_REVIEW",
        },
        integrity: { valid: true, reason: null },
      }),
    },
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
