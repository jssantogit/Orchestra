import test from "node:test";
import assert from "node:assert/strict";

import {
  DELEGATION_FAILURE_REASONS,
  DELEGATION_PURPOSES,
  assertDelegationRequest,
  assertDelegationResult,
  validateDelegationRequest,
  validateDelegationResult,
} from "../../core/domain/delegation.mjs";

function implementationPacket() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "implementation-task",
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

function validV1Request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "delegation-review-v1",
    taskId: "implementation-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: implementationPacket(),
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

function validV1Result() {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: "delegation-review-v1",
    provider: "provider-b",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    status: "COMPLETED",
    summary: "review complete",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 10 },
    workspace: {
      initialFingerprint: "sha256:initial",
      finalFingerprint: "sha256:final",
      dirty: false,
    },
  };
}

function validV2Request() {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "delegation-implementation-v2",
    taskId: "implementation-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: implementationPacket(),
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

function validV2Result() {
  return {
    schema: "orchestra.delegation-result.v2",
    delegationId: "delegation-implementation-v2",
    provider: "provider-b",
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    status: "COMPLETED",
    summary: "implementation complete",
    findings: [],
    evidenceRefs: ["test:focused"],
    execution: { exitCode: 0, durationMs: 321 },
    workspace: {
      sourceRevision: "abcdef1234567890",
      sourceFingerprint: "sha256:fingerprint",
      delegatedPath: "/tmp/orchestra-delegation-v2",
      changedPaths: ["src/example.mjs"],
      dirty: true,
    },
    artifact: {
      artifactId: "artifact-implementation-v2",
      patchSha256: "sha256:patch",
      mutationDigest: "sha256:mutation",
      changedPaths: ["src/example.mjs"],
      state: "READY_FOR_REVIEW",
    },
  };
}

test("delegation vocabulary exposes additive implementation purpose and failure families", () => {
  assert.equal(DELEGATION_PURPOSES.IMPLEMENTATION, "IMPLEMENTATION");
  for (const reason of [
    "SCOPE_VIOLATION",
    "ARTIFACT_SEAL_FAILED",
    "ARTIFACT_TAMPERED",
    "PROMOTION_STALE",
    "PROMOTION_FAILED",
  ]) {
    assert.equal(DELEGATION_FAILURE_REASONS[reason], reason);
  }
});

test("v1 remains read-only and rejects every v2 privilege surface", () => {
  const cases = [
    (request) => request.authority.capabilities.push("WORKSPACE_EDIT"),
    (request) => { request.authority.mutation = "WORKSPACE_ONLY"; },
    (request) => { request.purpose = "IMPLEMENTATION"; },
    (request) => { request.workspace.isolation = "EPHEMERAL_CLONE"; },
  ];

  for (const mutate of cases) {
    const request = validV1Request();
    mutate(request);
    assert.equal(validateDelegationRequest(request).valid, false);
  }

  for (const reason of ["SCOPE_VIOLATION", "ARTIFACT_SEAL_FAILED", "ARTIFACT_TAMPERED", "PROMOTION_STALE", "PROMOTION_FAILED"]) {
    const result = validV1Result();
    result.status = "FAILED";
    result.reason = reason;
    assert.equal(validateDelegationResult(result).valid, false, reason);
  }
});

test("valid implementation v2 request and result pass canonical validation", () => {
  assert.deepEqual(validateDelegationRequest(validV2Request()), { valid: true, errors: [] });
  assert.deepEqual(validateDelegationResult(validV2Result()), { valid: true, errors: [] });
  assert.equal(assertDelegationRequest(validV2Request()).schema, "orchestra.delegation-request.v2");
  assert.equal(assertDelegationResult(validV2Result()).artifact.state, "READY_FOR_REVIEW");
});

test("v2 request accepts only the exact implementation authority tuple", () => {
  const cases = [
    (request) => request.authority.capabilities.pop(),
    (request) => request.authority.capabilities.push("NETWORK_WRITE"),
    (request) => { request.authority.mutation = "FORBIDDEN"; },
    (request) => { request.authority.network = "ALLOWED"; },
    (request) => { request.authority.mayDelegate = true; },
    (request) => { request.target.logicalRole = "CRITICAL_REVIEWER"; },
    (request) => { request.purpose = "SECOND_OPINION"; },
    (request) => { request.workspace.isolation = "EPHEMERAL_WORKTREE"; },
    (request) => { request.limits.delegationDepth = 2; },
  ];

  for (const mutate of cases) {
    const request = validV2Request();
    mutate(request);
    assert.equal(validateDelegationRequest(request).valid, false);
  }
});

test("v2 result accepts implementation failure taxonomy without becoming acceptance state", () => {
  for (const reason of ["SCOPE_VIOLATION", "ARTIFACT_SEAL_FAILED", "ARTIFACT_TAMPERED", "PROMOTION_STALE", "PROMOTION_FAILED"]) {
    const result = validV2Result();
    result.status = "FAILED";
    result.reason = reason;
    delete result.artifact;
    assert.equal(validateDelegationResult(result).valid, true, reason);
    assert.equal("accepted" in result, false);
  }
});
