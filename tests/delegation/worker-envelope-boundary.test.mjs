import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "worker-envelope-boundary-task",
    candidateGeneration: 7,
    goal: "implement the bounded change",
    direction: {
      change: "modify only authorized product files",
      preserve: ["public API"],
    },
    anchors: [{ file: "src/example.mjs" }],
    scope: {
      allowedAreas: ["src/**", "tests/**"],
      forbidden: ["secrets/**"],
    },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
    },
    validation: ["focused tests"],
    failurePolicy: {
      selfCaused: "REPAIR",
      unrelatedOrUncertain: "RETURN_TO_CONTROL",
    },
  };
}

function v1Request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "worker-envelope-review-v1",
    taskId: "worker-envelope-boundary-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
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
      sourceFingerprint: "sha256:fingerprint",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function v2Request() {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "worker-envelope-implementation-v2",
    taskId: "worker-envelope-boundary-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
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
      sourceFingerprint: "sha256:fingerprint",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_CLONE",
      mutationScope: {
        allowedPaths: ["src/**", "tests/**"],
        forbiddenPaths: ["secrets/**"],
      },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

test("v1 Worker Envelope remains read/process only and exposes no mutation scope", () => {
  const envelope = buildWorkerEnvelope(v1Request());

  assert.deepEqual(envelope.capabilities, ["LOCAL_READ", "PROCESS_EXEC"]);
  assert.deepEqual(envelope.prohibitions, {
    mutation: "FORBIDDEN",
    network: "FORBIDDEN",
    delegation: "FORBIDDEN",
  });
  assert.equal(Object.hasOwn(envelope.scope, "mutationScope"), false);
});

test("v2 Worker Envelope exposes only bounded workspace mutation facts while withholding CONTROL and artifact authority", () => {
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

  const serialized = JSON.stringify(envelope);
  for (const forbidden of [
    "actorIdHash",
    "sourceFingerprint",
    "sourceRevision",
    "candidateGeneration",
    "artifactId",
    "patchSha256",
    "mutationDigest",
    "READY_FOR_REVIEW",
    "mayDelegate",
    "delegationDepth",
    "workLease",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
