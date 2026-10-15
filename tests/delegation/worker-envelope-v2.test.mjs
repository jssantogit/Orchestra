import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "task-envelope-v2",
    candidateGeneration: 8,
    goal: "implement the bounded candidate change",
    direction: {
      cause: "bounded implementation request",
      change: "modify authorized product files",
      preserve: ["CONTROL authority", "public API"],
    },
    anchors: [{ file: "src/example.mjs", testHint: "node --test" }],
    scope: {
      allowedAreas: ["src/**", "tests/**", ".orchestra/state/**"],
      forbidden: ["secrets/**"],
    },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
    },
    validation: ["node --test"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function v1Request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "envelope-v1",
    taskId: "task-envelope-v2",
    source: { provider: "provider-a", actorIdHash: "sha256:secret-actor" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: packet(),
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: "sha256:secret-source",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function v2Request() {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "envelope-v2",
    taskId: "task-envelope-v2",
    source: { provider: "provider-a", actorIdHash: "sha256:secret-actor" },
    target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: packet(),
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: "sha256:secret-source",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_CLONE",
      mutationScope: {
        allowedPaths: ["./src/**", "tests/**"],
        forbiddenPaths: ["secrets/**"],
      },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

test("v1 Worker Envelope remains logically read-only", () => {
  const envelope = buildWorkerEnvelope(v1Request());
  assert.deepEqual(envelope.capabilities, ["LOCAL_READ", "PROCESS_EXEC"]);
  assert.deepEqual(envelope.prohibitions, {
    mutation: "FORBIDDEN",
    network: "FORBIDDEN",
    delegation: "FORBIDDEN",
  });
  assert.equal("mutationScope" in envelope.scope, false);
});

test("v2 Worker Envelope exposes only scoped implementation authority", () => {
  const envelope = buildWorkerEnvelope(v2Request());
  assert.deepEqual(envelope.capabilities, ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"]);
  assert.deepEqual(envelope.prohibitions, {
    mutation: "WORKSPACE_ONLY",
    network: "FORBIDDEN",
    delegation: "FORBIDDEN",
  });
  assert.deepEqual(envelope.scope.mutationScope, {
    allowedPaths: ["src/**", "tests/**"],
    forbiddenPaths: [".git/**", ".orchestra/state/**", "secrets/**"],
  });
  assert.equal(envelope.scope.allowedAreas.includes(".orchestra/state/**"), false);

  const serialized = JSON.stringify(envelope);
  for (const forbidden of [
    "sha256:secret-actor",
    "sha256:secret-source",
    "abcdef1234567890",
    "candidateGeneration",
    "delegationId",
    "artifactId",
    "workLease",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
