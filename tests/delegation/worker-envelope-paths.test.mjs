import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "worker-envelope-paths",
    taskId: "worker-envelope-paths-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "worker-envelope-paths-task",
      candidateGeneration: 1,
      goal: "review candidate",
      direction: { change: "inspect candidate", preserve: [] },
      anchors: [{ file: "src/example.mjs" }],
      scope: {
        allowedAreas: ["src/**", "./.orchestra/state/**", ".orchestra\\state\\delegations\\**"],
        forbidden: ["secrets/**", "./.orchestra/state/private/**"],
      },
      permissions: {
        discovery: "DIRECTED",
        tests: "READ_ONLY",
        sideEffects: ["LOCAL_TEST"],
      },
      validation: ["focused tests"],
      failurePolicy: {
        selfCaused: "REPAIR",
        unrelatedOrUncertain: "RETURN_TO_CONTROL",
      },
    },
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: "sha256:fingerprint",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: {
      timeoutMs: 120000,
      maxOutputBytes: 65536,
      delegationDepth: 1,
    },
  };
}

test("Worker Envelope normalizes canonical state paths out of allowed scope and keeps explicit internal prohibitions", () => {
  const envelope = buildWorkerEnvelope(request());

  assert.deepEqual(envelope.scope.allowedAreas, ["src/**"]);
  assert.ok(envelope.scope.forbidden.includes("secrets/**"));
  assert.ok(envelope.scope.forbidden.includes(".orchestra/state/**"));
  assert.ok(envelope.scope.forbidden.includes(".git/**"));
  assert.equal(envelope.scope.forbidden.some((entry) => entry.includes("\\")), false);
  assert.equal(envelope.scope.forbidden.some((entry) => entry.startsWith("./")), false);
});
