import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKER_REPORT_SCHEMA,
  authorizeDelegationRequest,
} from "../../core/delegation/policy.mjs";
import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";

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
    anchors: [{ file: "src/example.mjs" }, { testHint: "focused reviewer test" }],
    scope: {
      allowedAreas: ["src/**", "test/**"],
      forbidden: ["secrets/**", ".orchestra/state/**"],
    },
    permissions: {
      discovery: "DIRECTED",
      tests: "READ_ONLY",
      sideEffects: ["LOCAL_TEST"],
    },
    validation: ["focused tests", "review evidence"],
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

test("authority permits only the factual read/process-exec cross-provider request", () => {
  assert.deepEqual(
    authorizeDelegationRequest(validRequest(), {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:fingerprint",
    }),
    { allowed: true, reason: null },
  );
});

test("authority fails closed on capability, mutation, network, recursion, and depth expansion regardless of role", () => {
  const cases = [
    (request) => request.authority.capabilities.push("WORKSPACE_EDIT"),
    (request) => { request.authority.mutation = "ALLOWED"; },
    (request) => { request.authority.network = "ALLOWED"; },
    (request) => { request.authority.mayDelegate = true; },
    (request) => { request.limits.delegationDepth = 2; },
  ];

  for (const logicalRole of ["IMPLEMENTER", "INVESTIGATOR", "QUICK_AUDITOR", "CRITICAL_REVIEWER", "MANUAL_ESCALATION"]) {
    for (const mutate of cases) {
      const request = validRequest();
      request.target.logicalRole = logicalRole;
      mutate(request);
      assert.deepEqual(
        authorizeDelegationRequest(request, {
          sourceProvider: "provider-a",
          sourceFingerprint: "sha256:fingerprint",
        }),
        { allowed: false, reason: "CAPABILITY_DENIED" },
        logicalRole,
      );
    }
  }
});

test("authority binds source provider and workspace fingerprint without transferring authority", () => {
  assert.deepEqual(
    authorizeDelegationRequest(validRequest(), {
      sourceProvider: "provider-other",
      sourceFingerprint: "sha256:fingerprint",
    }),
    { allowed: false, reason: "CAPABILITY_DENIED" },
  );

  assert.deepEqual(
    authorizeDelegationRequest(validRequest(), {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:other-fingerprint",
    }),
    { allowed: false, reason: "WORKSPACE_PREP_FAILED" },
  );

  const sameProvider = validRequest();
  sameProvider.target.provider = "provider-a";
  assert.deepEqual(
    authorizeDelegationRequest(sameProvider, {
      sourceProvider: "provider-a",
      sourceFingerprint: "sha256:fingerprint",
    }),
    { allowed: false, reason: "CAPABILITY_DENIED" },
  );
});

test("Worker Envelope exposes bounded work facts but omits CONTROL, lease, source identity, and canonical workspace internals", () => {
  const envelope = buildWorkerEnvelope(validRequest());

  assert.deepEqual(Object.keys(envelope), [
    "objective",
    "logicalRole",
    "purpose",
    "context",
    "scope",
    "validation",
    "capabilities",
    "prohibitions",
    "outputContract",
    "limits",
  ]);
  assert.equal(envelope.objective, "review the bounded candidate");
  assert.equal(envelope.logicalRole, "CRITICAL_REVIEWER");
  assert.equal(envelope.purpose, "INDEPENDENT_REVIEW");
  assert.deepEqual(envelope.capabilities, ["LOCAL_READ", "PROCESS_EXEC"]);
  assert.deepEqual(envelope.prohibitions, {
    mutation: "FORBIDDEN",
    network: "FORBIDDEN",
    delegation: "FORBIDDEN",
  });
  assert.deepEqual(envelope.limits, {
    timeoutMs: 120000,
    maxOutputBytes: 65536,
  });
  assert.equal(envelope.outputContract.schema, WORKER_REPORT_SCHEMA.$id);

  const serialized = JSON.stringify(envelope);
  for (const forbidden of [
    "actorIdHash",
    "sourceFingerprint",
    "sourceRevision",
    "candidateGeneration",
    "mayDelegate",
    "delegationDepth",
    "Work Lease",
    ".orchestra/state",
    "transcript",
    "conversationHistory",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("provider inference transport is not represented as worker network capability", () => {
  const envelope = buildWorkerEnvelope(validRequest());
  assert.equal(envelope.capabilities.includes("NETWORK_READ"), false);
  assert.equal(envelope.capabilities.includes("NETWORK_WRITE"), false);
  assert.equal(envelope.capabilities.includes("REMOTE_REPO_WRITE"), false);
  assert.equal(envelope.prohibitions.network, "FORBIDDEN");
});

test("worker report schema is bounded, provider-neutral, and cannot carry raw narrative channels", () => {
  assert.equal(WORKER_REPORT_SCHEMA.$id, "orchestra.delegation-worker-report.v1");
  assert.equal(WORKER_REPORT_SCHEMA.type, "object");
  assert.equal(WORKER_REPORT_SCHEMA.additionalProperties, false);
  assert.deepEqual(WORKER_REPORT_SCHEMA.required, ["summary", "findings", "evidenceRefs"]);
  assert.equal(WORKER_REPORT_SCHEMA.properties.summary.maxLength <= 8192, true);
  assert.equal(WORKER_REPORT_SCHEMA.properties.findings.maxItems <= 64, true);
  assert.equal(WORKER_REPORT_SCHEMA.properties.evidenceRefs.maxItems <= 64, true);
  for (const forbidden of ["provider", "transcript", "reasoning", "stdout", "stderr", "prompt", "status", "accepted"]) {
    assert.equal(Object.hasOwn(WORKER_REPORT_SCHEMA.properties, forbidden), false, forbidden);
  }
});
