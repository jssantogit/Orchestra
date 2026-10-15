import test from "node:test";
import assert from "node:assert/strict";

import { authorizeDelegationRequest } from "../../core/delegation/policy.mjs";

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "implementation-task",
    candidateGeneration: 7,
    goal: "implement the bounded change",
    direction: { change: "edit authorized files", preserve: ["public API"] },
    anchors: [{ file: "src/example.mjs" }],
    scope: { allowedAreas: ["src/**", "tests/**"], forbidden: ["secrets/**"] },
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

function validV2Request() {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "delegation-policy-v2",
    taskId: "implementation-task",
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

test("authority permits the exact cross-provider implementation v2 envelope", () => {
  assert.deepEqual(
    authorizeDelegationRequest(validV2Request(), {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:fingerprint",
    }),
    { allowed: true, reason: null },
  );
});

test("implementation v2 authority fails closed on any privilege drift", () => {
  const cases = [
    (request) => request.authority.capabilities.pop(),
    (request) => request.authority.capabilities.push("NETWORK_WRITE"),
    (request) => { request.authority.mutation = "FORBIDDEN"; },
    (request) => { request.authority.network = "ALLOWED"; },
    (request) => { request.authority.mayDelegate = true; },
    (request) => { request.limits.delegationDepth = 2; },
    (request) => { request.target.logicalRole = "CRITICAL_REVIEWER"; },
    (request) => { request.purpose = "SECOND_OPINION"; },
    (request) => { request.workspace.isolation = "EPHEMERAL_WORKTREE"; },
  ];

  for (const mutate of cases) {
    const request = validV2Request();
    mutate(request);
    assert.deepEqual(
      authorizeDelegationRequest(request, {
        sourceProvider: "provider-a",
        sourceFingerprint: "sha256:fingerprint",
      }),
      { allowed: false, reason: "CAPABILITY_DENIED" },
    );
  }
});

test("implementation v2 still binds source provider and canonical source fingerprint", () => {
  assert.deepEqual(
    authorizeDelegationRequest(validV2Request(), {
      sourceProvider: "provider-other",
      sourceFingerprint: "sha256:fingerprint",
    }),
    { allowed: false, reason: "CAPABILITY_DENIED" },
  );

  assert.deepEqual(
    authorizeDelegationRequest(validV2Request(), {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:stale",
    }),
    { allowed: false, reason: "WORKSPACE_PREP_FAILED" },
  );
});
