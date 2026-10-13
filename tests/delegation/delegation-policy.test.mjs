import test from "node:test";
import assert from "node:assert/strict";

import { authorizeDelegationRequest } from "../../core/delegation/policy.mjs";
import { WORKER_REPORT_SCHEMA, buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";

function implementationPacket() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "delegation-policy",
    candidateGeneration: 3,
    goal: "independently review the bounded candidate",
    direction: {
      cause: "candidate touches a critical invariant",
      change: "review the candidate without modifying it",
      preserve: ["public API", "existing authority boundary"],
    },
    anchors: [{ file: "src/example.mjs" }, { testHint: "example.test.mjs" }],
    scope: { allowedAreas: ["src/**", "test/**"], forbidden: ["secrets/**"] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
    validation: ["focused test", "diff review"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "delegation-policy-1",
    taskId: "delegation-policy",
    source: { provider: "provider-a", actorIdHash: "sha256:source-actor-secret-provenance" },
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
      sourceFingerprint: "sha256:canonical-workspace-fingerprint",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

test("delegation authority accepts only a factual bounded request", () => {
  assert.deepEqual(
    authorizeDelegationRequest(request(), {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:canonical-workspace-fingerprint",
    }),
    { allowed: true, reason: "AUTHORIZED" },
  );

  assert.equal(
    authorizeDelegationRequest(request(), {
      sourceProvider: "provider-z",
      sourceFingerprint: "sha256:canonical-workspace-fingerprint",
    }).reason,
    "SOURCE_PROVIDER_MISMATCH",
  );
  assert.equal(
    authorizeDelegationRequest(request(), {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:other-workspace",
    }).reason,
    "SOURCE_FINGERPRINT_MISMATCH",
  );
});

test("logical role never upgrades capability or recursive authority", () => {
  for (const mutate of [
    (value) => value.authority.capabilities.push("WORKSPACE_EDIT"),
    (value) => { value.authority.mutation = "ALLOWED"; },
    (value) => { value.authority.network = "ALLOWED"; },
    (value) => { value.authority.mayDelegate = true; },
    (value) => { value.limits.delegationDepth = 2; },
  ]) {
    const value = request();
    value.target.logicalRole = "CRITICAL_REVIEWER";
    mutate(value);
    const decision = authorizeDelegationRequest(value, {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:canonical-workspace-fingerprint",
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "INVALID_DELEGATION_REQUEST");
  }
});

test("Worker Envelope carries task facts but omits control-plane authority internals", () => {
  const envelope = buildWorkerEnvelope(request());
  assert.deepEqual(Object.keys(envelope).sort(), [
    "capabilities",
    "context",
    "limits",
    "logicalRole",
    "objective",
    "outputContract",
    "prohibitions",
    "purpose",
    "scope",
    "validation",
  ]);
  assert.equal(envelope.objective, "independently review the bounded candidate");
  assert.equal(envelope.logicalRole, "CRITICAL_REVIEWER");
  assert.deepEqual(envelope.capabilities, ["LOCAL_READ", "PROCESS_EXEC"]);
  assert.deepEqual(envelope.prohibitions, {
    mutation: "FORBIDDEN",
    network: "FORBIDDEN",
    delegation: "FORBIDDEN",
  });
  assert.deepEqual(envelope.scope, implementationPacket().scope);
  assert.deepEqual(envelope.validation, implementationPacket().validation);

  const serialized = JSON.stringify(envelope);
  for (const forbidden of [
    "delegation-policy-1",
    "sha256:source-actor-secret-provenance",
    "sha256:canonical-workspace-fingerprint",
    "abcdef1234567890",
    "mayDelegate",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Worker Envelope leaked ${forbidden}`);
  }
  assert.equal(serialized.includes("NETWORK_READ"), false);
  assert.equal(serialized.includes("NETWORK_WRITE"), false);
});

test("worker report output contract is bounded, strict, and non-canonical", () => {
  assert.equal(WORKER_REPORT_SCHEMA.type, "object");
  assert.equal(WORKER_REPORT_SCHEMA.additionalProperties, false);
  assert.deepEqual(WORKER_REPORT_SCHEMA.required, ["summary", "findings", "evidenceRefs"]);
  assert.equal(WORKER_REPORT_SCHEMA.properties.summary.maxLength <= 8192, true);
  assert.equal(WORKER_REPORT_SCHEMA.properties.findings.maxItems <= 32, true);
  assert.equal(WORKER_REPORT_SCHEMA.properties.evidenceRefs.maxItems <= 64, true);
  assert.equal("schema" in WORKER_REPORT_SCHEMA.properties, false);
  assert.equal("accepted" in WORKER_REPORT_SCHEMA.properties, false);
  assert.equal("candidate" in WORKER_REPORT_SCHEMA.properties, false);
  assert.equal("transcript" in WORKER_REPORT_SCHEMA.properties, false);
});
