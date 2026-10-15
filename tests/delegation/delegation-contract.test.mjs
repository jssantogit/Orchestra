import test from "node:test";
import assert from "node:assert/strict";

import {
  DELEGATION_FAILURE_REASONS,
  DELEGATION_PURPOSES,
  DELEGATION_STATUSES,
  assertDelegationRequest,
  assertDelegationResult,
  validateDelegationRequest,
  validateDelegationResult,
} from "../../core/domain/delegation.mjs";

function implementationPacket() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "delegation-task",
    candidateGeneration: 3,
    goal: "review the bounded candidate",
    direction: {
      change: "inspect the candidate against acceptance criteria",
      preserve: ["public API"],
    },
    anchors: [{ file: "src/example.mjs" }],
    scope: {
      allowedAreas: ["src/**", "test/**"],
      forbidden: ["secrets/**"],
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
  };
}

function validRequest() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "delegation-123",
    taskId: "delegation-task",
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
    limits: {
      timeoutMs: 120000,
      maxOutputBytes: 65536,
      delegationDepth: 1,
    },
  };
}

function validResult() {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: "delegation-123",
    provider: "provider-b",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    status: "COMPLETED",
    summary: "No blocking issue found.",
    findings: [],
    evidenceRefs: ["test:focused"],
    execution: { exitCode: 0, durationMs: 321 },
    workspace: {
      initialFingerprint: "sha256:initial",
      finalFingerprint: "sha256:final",
      dirty: false,
    },
  };
}

test("delegation vocabularies expose the additive contract while v1 stays schema-bounded", () => {
  assert.deepEqual(Object.values(DELEGATION_PURPOSES), [
    "INDEPENDENT_REVIEW",
    "SECOND_OPINION",
    "SPECIALIST_EXECUTION",
    "MANUAL",
    "IMPLEMENTATION",
  ]);
  assert.deepEqual(Object.values(DELEGATION_STATUSES), ["COMPLETED", "FAILED", "TIMED_OUT", "DENIED"]);
  assert.equal(DELEGATION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, "PROVIDER_UNAVAILABLE");
  assert.equal(DELEGATION_FAILURE_REASONS.INVALID_RESULT, "INVALID_RESULT");
});

test("valid delegation request and result pass canonical validation", () => {
  assert.deepEqual(validateDelegationRequest(validRequest()), { valid: true, errors: [] });
  assert.deepEqual(validateDelegationResult(validResult()), { valid: true, errors: [] });
  assert.equal(assertDelegationRequest(validRequest()).delegationId, "delegation-123");
  assert.equal(assertDelegationResult(validResult()).status, "COMPLETED");
});

test("delegation request fails closed on authority expansion and recursive delegation", () => {
  const cases = [
    (request) => request.authority.capabilities.push("WORKSPACE_EDIT"),
    (request) => { request.authority.mutation = "ALLOWED"; },
    (request) => { request.authority.mutation = "WORKSPACE_ONLY"; },
    (request) => { request.authority.network = "ALLOWED"; },
    (request) => { request.authority.mayDelegate = true; },
    (request) => { request.limits.delegationDepth = 2; },
    (request) => { request.workspace.isolation = "CANONICAL_WORKTREE"; },
    (request) => { request.workspace.isolation = "EPHEMERAL_CLONE"; },
  ];

  for (const mutate of cases) {
    const request = validRequest();
    mutate(request);
    assert.equal(validateDelegationRequest(request).valid, false);
  }
});

test("delegation contracts reject raw narrative/provider-state leakage and unknown fields", () => {
  for (const field of ["transcript", "reasoning", "stdout", "stderr", "conversationHistory", "session_id", "unknown"]) {
    const request = validRequest();
    request[field] = "forbidden";
    assert.equal(validateDelegationRequest(request).valid, false, `request.${field}`);

    const result = validResult();
    result[field] = "forbidden";
    assert.equal(validateDelegationResult(result).valid, false, `result.${field}`);
  }
});

test("delegation result uses bounded status and failure taxonomy", () => {
  const invalidStatus = validResult();
  invalidStatus.status = "ACCEPTED";
  assert.equal(validateDelegationResult(invalidStatus).valid, false);

  const failed = validResult();
  failed.status = "FAILED";
  failed.reason = "EXECUTION_FAILED";
  assert.equal(validateDelegationResult(failed).valid, true);

  const unknownReason = validResult();
  unknownReason.status = "FAILED";
  unknownReason.reason = "SOMETHING_PROVIDER_SPECIFIC";
  assert.equal(validateDelegationResult(unknownReason).valid, false);
});

test("delegation request embeds the canonical ImplementationPacket contract", () => {
  const request = validRequest();
  request.packet.permissions.discovery = "BROAD";
  assert.equal(validateDelegationRequest(request).valid, false);
});
